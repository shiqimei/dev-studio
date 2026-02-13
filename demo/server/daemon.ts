/**
 * Agents Daemon
 *
 * Long-lived singleton persisted on globalThis across Bun HMR reloads.
 * Owns the ACP connection, worker pools, turn state, and all async
 * operations (processPrompt, autoRename, etc.).
 *
 * The API server (server.ts) is fully ephemeral — on each HMR reload it
 * calls getOrCreateDaemon() and re-attaches a fresh EventSink callback
 * that captures the new `clients` Map. The daemon's internal code always
 * calls this.eventSink(...) which always points to the latest handler.
 */

import { createAcpConnection, createNewSession, resumeSession } from "./session.js";
import { createCodexConnection, isCodexAvailable } from "./codex-session.js";
import { readCodexSessionHistory } from "../../src/disk/codex-sessions.js";
import { createHaikuPool } from "./haiku-pool.js";
import { createOpusPool } from "./opus-pool.js";
import type { AcpConnection } from "./types.js";
import type { HaikuPool } from "./haiku-pool.js";
import type { OpusPool } from "./opus-pool.js";
import { log, bootMs } from "./log.js";
import type { KanbanOp } from "./kanban.js";
import { getProjectDir } from "./kanban.js";
import * as kanbanDb from "./kanban-db.js";
import type { ExecutorType } from "./kanban-db.js";
import type {
  AgentsDaemon,
  EventSink,
  TurnState,
  TurnActivity,
  SessionMeta,
  QueuedMessage,
  WsSendable,
} from "./daemon-types.js";

// ── Helpers ──

/** Short session ID for logs. */
function sid(sessionId: string | null | undefined): string {
  if (!sessionId) return "(none)";
  return sessionId.slice(0, 8);
}

/** Map tool kind/name to a turn activity. */
function toolActivity(kind: string | undefined, toolName: string | undefined): { activity: TurnActivity; detail?: string } {
  const k = kind?.toLowerCase() ?? "";
  const n = toolName ?? "";
  if (k === "thinking" || k === "thought") return { activity: "thinking" };
  if (n === "Task" || n === "task" || k === "task") return { activity: "delegating", detail: n };
  if (n === "TodoWrite" || k === "plan") return { activity: "planning" };
  if (n === "Bash" || k === "bash") return { activity: "running", detail: "Running command" };
  if (n === "Read" || n === "mcp__acp__Read") return { activity: "reading", detail: n };
  if (n === "Glob" || n === "Grep" || n === "WebSearch" || n === "WebFetch") return { activity: "searching", detail: n };
  if (n === "Write" || n === "Edit" || n === "mcp__acp__Write" || n === "mcp__acp__Edit" || n === "NotebookEdit") return { activity: "editing", detail: n };
  if (n) return { activity: "brewing", detail: n };
  return { activity: "brewing" };
}

function setActivity(ts: TurnState, activity: TurnActivity, detail?: string): boolean {
  if (ts.activity === activity && ts.activityDetail === detail) return false;
  ts.activity = activity;
  ts.activityDetail = detail;
  return true;
}

/** Detect "session gone" errors from the ACP SDK. */
function isSessionGoneError(err: any): boolean {
  const msg = err?.message ?? "";
  return /No conversation found|Session not found/i.test(msg) || err?.code === -32603;
}

// ── Route whitelist ──

const ROUTE_WHITELIST_PATTERNS: RegExp[] = [
  /^\/\S/,
  /^(yes|yeah|yep|yup|no|nope|nah|ok|okay|sure|go ahead|do it|looks good|lgtm|approved|sounds good|perfect|great|correct|right|exactly|agreed)\b/i,
  /^(continue|proceed|go on|try again|retry|undo|revert|cancel|stop|wait|hold on|never ?mind)\b/i,
  /^(thanks|thank you|thx|ty)\b/i,
];

// ── Server event map (for protocol debug panel) ──

const SERVER_EVENT_MAP: Record<string, string> = {
  session_switched:     "sessions/switched",
  session_title_update: "sessions/titleUpdate",
  turn_start:           "session/turnStart",
  turn_activity:        "session/turnActivity",
  turn_end:             "session/turnEnd",
  error:                "app/error",
  system:               "app/system",
  message_queued:       "queue/enqueue",
  queue_drain_start:    "queue/drainStart",
  queue_cancelled:      "queue/cancelled",
  route_result:         "route/result",
  preflight_route_result: "route/preflight",
};

const BUFFERABLE_TYPES = new Set(["text", "thought", "tool_call", "tool_call_update", "plan", "permission_request", "permission_resolved", "error"]);

// ── Daemon Implementation ──

class AgentsDaemonImpl implements AgentsDaemon {
  // ── Event sink (replaced by API server on each HMR reload) ──
  private eventSink: EventSink = () => {};

  // ── ACP connections (one per executor type) ──
  private connections: { claude: AcpConnection | null; codex: AcpConnection | null } = { claude: null, codex: null };
  private initPromise: Promise<void> | null = null;
  private _ready!: Promise<void>;
  private resolveReady!: () => void;

  // ── Session state ──
  readonly liveSessionIds = new Set<string>();
  defaultSessionId: string | null = null;
  private turnStates: Record<string, TurnState> = {};
  private turnContentBuffers = new Map<string, object[]>();
  private messageQueues = new Map<string, QueuedMessage[]>();
  private processingSessions = new Set<string>();
  private queueIdCounter = 0;

  // ── Session metadata ──
  private sessionMetas = new Map<string, SessionMeta>();
  private sessionTitleCache = new Map<string, string>();

  // ── Auto-rename ──
  readonly autoRenameEligible = new Set<string>();
  private autoRenameInFlight = new Set<string>();

  // ── Worker pools ──
  private haikuPool: HaikuPool;
  private opusPool: OpusPool;

  // ── broadcastSessions coalescing ──
  private broadcastSessionsPromise: Promise<void> | null = null;
  private broadcastSessionsStartedAt = 0;

  constructor() {
    this.haikuPool = createHaikuPool();
    this.opusPool = createOpusPool();
    this._ready = new Promise<void>((r) => { this.resolveReady = r; });
  }

  get ready(): Promise<void> {
    return this._ready;
  }

  // ── Connection helpers ──

  /** Get the ACP connection for a given session (looks up executor type in SQLite). */
  private getConnectionForSession(sessionId: string): AcpConnection | null {
    const executorType = kanbanDb.getSessionExecutorType(sessionId);
    const conn = this.connections[executorType];
    // Safety fallback for unknown/stale executor types in persisted DB rows.
    return conn ?? this.connections.claude;
  }

  /** Get the ACP connection for a given executor type. */
  private getConnectionForExecutor(executorType: ExecutorType): AcpConnection | null {
    return this.connections[executorType];
  }

  getAvailableExecutors(): ExecutorType[] {
    const executors: ExecutorType[] = ["claude"];
    if (this.connections.codex) executors.push("codex");
    return executors;
  }

  // ── Event sink ──

  setEventSink(sink: EventSink): void {
    this.eventSink = sink;
  }

  // ── Internal broadcast ──
  // Accumulates turn stats, buffers content, caches session meta,
  // then delegates to the replaceable event sink for client delivery.

  private broadcast(msg: object): void {
    const m = msg as any;

    // Suppress SDK-driven session_title_update while auto-rename is in flight.
    if (m.type === "session_title_update" && m.sessionId && this.autoRenameInFlight.has(m.sessionId)) {
      log.debug({ session: sid(m.sessionId), title: m.title }, "broadcast: suppressed session_title_update (auto-rename in flight)");
      return;
    }

    const msgSessionId = m.sessionId ?? null;

    // ── Accumulate turn stats + track activity from streaming messages ──
    let activityChanged = false;

    // Handle set_activity: update turn state only, don't forward to clients
    if (m.type === "set_activity" && msgSessionId && this.turnStates[msgSessionId]?.status === "in_progress") {
      activityChanged = setActivity(this.turnStates[msgSessionId], m.activity, m.detail);
      if (activityChanged) {
        const ts = this.turnStates[msgSessionId];
        this.eventSink({
          type: "turn_activity",
          sessionId: msgSessionId,
          activity: ts.activity,
          detail: ts.activityDetail,
          approxTokens: ts.approxTokens,
          thinkingDurationMs: ts.thinkingDurationMs,
        }, msgSessionId);
      }
      return;
    }

    if (msgSessionId && this.turnStates[msgSessionId]?.status === "in_progress") {
      const ts = this.turnStates[msgSessionId];
      if (m.type === "text" && m.text) {
        ts.approxTokens += Math.ceil(m.text.length / 4);
        activityChanged = setActivity(ts, "responding");
      } else if (m.type === "thought" && m.text) {
        ts.approxTokens += Math.ceil(m.text.length / 4);
        const now = Date.now();
        if (ts.thinkingLastChunkAt) {
          ts.thinkingDurationMs += now - ts.thinkingLastChunkAt;
        }
        ts.thinkingLastChunkAt = now;
        activityChanged = setActivity(ts, "thinking");
      } else if (m.type === "tool_call") {
        const toolName = m._meta?.claudeCode?.toolName ?? m.kind;
        const { activity, detail } = toolActivity(m.kind, toolName);
        activityChanged = setActivity(ts, activity, detail);
        if (ts.thinkingLastChunkAt) {
          ts.thinkingDurationMs += Date.now() - ts.thinkingLastChunkAt;
          ts.thinkingLastChunkAt = undefined;
        }
      } else if (m.type === "tool_call_update" && m.status === "completed") {
        activityChanged = setActivity(ts, "responding");
      } else if (m.type !== "thought" && ts.thinkingLastChunkAt) {
        ts.thinkingDurationMs += Date.now() - ts.thinkingLastChunkAt;
        ts.thinkingLastChunkAt = undefined;
      }
    }

    // Emit proto entry for server-originated events
    const method = m.type && SERVER_EVENT_MAP[m.type];
    if (method) {
      this.eventSink({ type: "protocol", dir: "recv", ts: Date.now(), msg: { method, params: m } }, null);
    }

    // ── Capture per-session state ──
    if (msgSessionId) {
      if (m.type === "session_info") {
        this.getSessionMeta(msgSessionId).sessionInfo = { type: "session_info", sessionId: msgSessionId, models: m.models, currentModel: m.currentModel, modes: m.modes } as any;
      } else if (m.type === "system" && m.text) {
        const meta = this.getSessionMeta(msgSessionId);
        if (!meta.systemMessages.includes(m.text)) meta.systemMessages.push(m.text);
      } else if (m.type === "commands") {
        this.getSessionMeta(msgSessionId).commands = m.commands;
      }
    }

    // Buffer content messages for late-joining clients (mid-turn replay)
    if (msgSessionId && this.turnStates[msgSessionId]?.status === "in_progress" && BUFFERABLE_TYPES.has(m.type)) {
      const buf = this.turnContentBuffers.get(msgSessionId);
      if (buf) buf.push(msg);
    }

    // Delegate to event sink for actual client delivery
    this.eventSink(msg, msgSessionId);

    // Send turn_activity update when activity changed
    if (activityChanged && msgSessionId) {
      const ts = this.turnStates[msgSessionId];
      this.eventSink({
        type: "turn_activity",
        sessionId: msgSessionId,
        activity: ts.activity,
        detail: ts.activityDetail,
        approxTokens: ts.approxTokens,
        thinkingDurationMs: ts.thinkingDurationMs,
      }, msgSessionId);
    }
  }

  // ── Lifecycle ──

  async init(): Promise<void> {
    if (this.connections.claude) return;
    if (this.initPromise) return this.initPromise;

    const t0 = performance.now();
    log.info({ boot: bootMs() }, "daemon: init starting");

    this.initPromise = (async () => {
      // Warm worker pools in parallel with ACP connections
      const haikuWarmup = this.haikuPool.warmup();
      const opusWarmup = this.opusPool.warmup();

      // Spawn Claude Code ACP connection (required)
      this.connections.claude = await createAcpConnection(this.broadcast.bind(this));
      log.info({ durationMs: Math.round(performance.now() - t0), boot: bootMs() }, "daemon: Claude ACP connection ready");

      // Spawn Codex ACP connection (optional — graceful fallback if unavailable)
      if (isCodexAvailable()) {
        try {
          this.connections.codex = await createCodexConnection(this.broadcast.bind(this));
          log.info({ boot: bootMs() }, "daemon: Codex ACP connection ready");
        } catch (err: any) {
          log.warn({ err: err.message, boot: bootMs() }, "daemon: Codex ACP connection failed, continuing without Codex");
          this.connections.codex = null;
        }
      } else {
        log.info({ boot: bootMs() }, "daemon: Codex ACP binary not found, skipping");
      }

      // Initialize kanban DB + recover interrupted sessions
      try {
        kanbanDb.migrateFromJson(this.getResolvedProjectDir());
        const snap = kanbanDb.getKanbanSnapshot();
        const interrupted: string[] = [];
        for (const [sessionId, col] of Object.entries(snap.columnOverrides)) {
          if (col === "in_progress") interrupted.push(sessionId);
        }
        if (interrupted.length > 0) {
          log.info({ count: interrupted.length, sessions: interrupted.map(sid) }, "daemon: attempting to reconnect interrupted sessions");
          const reconnected: string[] = [];
          const failed: string[] = [];
          const storedPaths = kanbanDb.getManagedSessionInfo();
          for (const sessionId of interrupted) {
            try {
              const conn = this.getConnectionForSession(sessionId);
              if (!conn) throw new Error("No connection for executor type");
              const storedCwd = storedPaths.get(sessionId)?.projectPath ?? undefined;
              await resumeSession(conn.connection, sessionId, storedCwd);
              this.liveSessionIds.add(sessionId);
              reconnected.push(sessionId);
              log.info({ session: sid(sessionId) }, "daemon: session reconnected");
            } catch (err: any) {
              log.warn({ session: sid(sessionId), err: err.message }, "daemon: failed to reconnect session");
              failed.push(sessionId);
            }
          }
          if (failed.length > 0) {
            const ops: KanbanOp[] = failed.map((sessionId) => ({
              op: "set_column" as const, sessionId, column: "in_review",
            }));
            kanbanDb.applyKanbanOps(ops);
            for (const sessionId of failed) {
              this.turnStates[sessionId] = {
                status: "error",
                startedAt: 0,
                approxTokens: 0,
                thinkingDurationMs: 0,
                stopReason: "server_restart",
              };
            }
          }
          log.info({ reconnected: reconnected.length, failed: failed.length }, "daemon: session reconnection complete");
        }
      } catch (err: any) {
        log.warn({ err: err.message }, "daemon: kanban-db init error");
      }

      await Promise.all([haikuWarmup, opusWarmup]);
      this.resolveReady();
      log.info({ totalMs: Math.round(performance.now() - t0), boot: bootMs() }, "daemon: init complete");
    })();

    return this.initPromise;
  }

  // ── Session lifecycle ──

  /** Get the active project's cwd from the projects DB (null if no project is open). */
  getActiveProjectCwd(): string | null {
    try {
      const { activeProject } = kanbanDb.getProjects();
      return activeProject;
    } catch {}
    return null;
  }

  async createSession(executorType: ExecutorType = "claude", projectPath?: string): Promise<{ sessionId: string }> {
    const conn = this.getConnectionForExecutor(executorType);
    if (!conn) throw new Error(`No connection for executor type: ${executorType}`);
    const cwd = projectPath ?? this.getActiveProjectCwd() ?? undefined;
    const result = await createNewSession(conn.connection, this.broadcast.bind(this), cwd);
    kanbanDb.setSessionExecutorType(result.sessionId, executorType);
    kanbanDb.registerManagedSession(result.sessionId, cwd);
    this.liveSessionIds.add(result.sessionId);
    this.autoRenameEligible.add(result.sessionId);
    return result;
  }

  async resumeSession(sessionId: string): Promise<void> {
    const conn = this.getConnectionForSession(sessionId);
    if (!conn) throw new Error("Daemon not initialized");
    // Prefer the session's own stored project path over the currently active project
    const storedCwd = kanbanDb.getManagedSessionInfo().get(sessionId)?.projectPath ?? undefined;
    const cwd = storedCwd ?? this.getActiveProjectCwd() ?? undefined;
    await resumeSession(conn.connection, sessionId, cwd);
    this.liveSessionIds.add(sessionId);
  }

  prompt(sessionId: string, text: string, images?: Array<{ data: string; mimeType: string }>, files?: Array<{ path: string; name: string }>): void {
    this.processPrompt(sessionId, text, images, files);
  }

  opusPrompt(sessionId: string, text: string): void {
    this.processOpusPrompt(sessionId, text);
  }

  async interrupt(sessionId: string): Promise<void> {
    const conn = this.getConnectionForSession(sessionId);
    if (!conn) return;
    if (!this.processingSessions.has(sessionId)) return;
    conn.webClient.cancelPermissions(sessionId);
    await conn.connection.cancel({ sessionId });
  }

  interruptAndPrompt(sessionId: string, text: string, images?: Array<{ data: string; mimeType: string }>, files?: Array<{ path: string; name: string }>): void {
    // Clear any existing queued messages — only the latest prompt matters
    this.clearSessionQueue(sessionId);
    // Store the new prompt as the pending message to process after interrupt
    const queueId = this.generateQueueId();
    this.getQueue(sessionId).push({ id: queueId, text, images, files, addedAt: Date.now() });
    log.info({ session: sid(sessionId), queueId }, "interrupt-and-prompt: queued new prompt, interrupting current turn");
    // Interrupt the current turn — processPrompt's finally block will drainQueue
    this.interrupt(sessionId).catch((err: any) => {
      log.error({ session: sid(sessionId), err: err.message }, "interrupt-and-prompt: interrupt failed");
    });
  }

  // ── processPrompt ──

  private async processPrompt(sessionId: string, text: string, images?: Array<{ data: string; mimeType: string }>, files?: Array<{ path: string; name: string }>) {
    const conn = this.getConnectionForSession(sessionId);
    if (!conn) return;
    this.processingSessions.add(sessionId);
    const promptT0 = performance.now();
    log.info({ session: sid(sessionId), textLen: text.length, images: images?.length ?? 0, files: files?.length ?? 0 }, "daemon: prompt started");
    try {
      // Lazily resume the ACP session if not already live
      if (!this.liveSessionIds.has(sessionId)) {
        const resumeT0 = performance.now();
        // Prefer the session's stored project path over the currently active project
        const storedCwd = kanbanDb.getManagedSessionInfo().get(sessionId)?.projectPath ?? undefined;
        const activeCwd = storedCwd ?? this.getActiveProjectCwd() ?? undefined;
        log.info({ session: sid(sessionId) }, "daemon: resumeSession started");
        try {
          await resumeSession(conn.connection, sessionId, activeCwd);
          log.info({ session: sid(sessionId), durationMs: Math.round(performance.now() - resumeT0) }, "daemon: resumeSession completed");
          this.liveSessionIds.add(sessionId);
        } catch (resumeErr: any) {
          if (!isSessionGoneError(resumeErr)) throw resumeErr;

          log.warn({ session: sid(sessionId), err: resumeErr.message }, "daemon: session gone, auto-creating replacement");
          const executorType = kanbanDb.getSessionExecutorType(sessionId);
          const { sessionId: newId } = await createNewSession(conn.connection, this.broadcast.bind(this), activeCwd);
          kanbanDb.setSessionExecutorType(newId, executorType);
          this.liveSessionIds.add(newId);
          this.autoRenameEligible.add(newId);

          // Emit session_replaced so the API server can update its clients Map
          this.eventSink({ type: "session_replaced", oldSessionId: sessionId, newSessionId: newId }, null);
          if (this.defaultSessionId === sessionId) this.defaultSessionId = newId;

          this.cleanupStaleSession(sessionId);
          await this.broadcastSessions();

          this.processingSessions.delete(sessionId);
          this.processPrompt(newId, text, images, files);
          return;
        }
        await this.broadcastSessions();
      }

      const prompt: Array<{ type: string; text?: string; data?: string; mimeType?: string; resource?: { uri: string; text: string; mimeType: string } }> = [];
      if (text) prompt.push({ type: "text", text });
      for (const img of images ?? []) {
        prompt.push({ type: "image", data: img.data, mimeType: img.mimeType });
      }
      for (const file of files ?? []) {
        try {
          const content = await Bun.file(file.path).text();
          const ext = file.name.split(".").pop() ?? "";
          const mimeMap: Record<string, string> = { ts: "text/typescript", tsx: "text/typescript", js: "text/javascript", json: "application/json", md: "text/markdown", css: "text/css", html: "text/html" };
          prompt.push({ type: "resource", resource: { uri: `file://${file.path}`, text: content, mimeType: mimeMap[ext] ?? "text/plain" } });
        } catch { /* skip unreadable files */ }
      }
      if (prompt.length === 0) { this.processingSessions.delete(sessionId); this.drainQueue(sessionId); return; }

      // Fire-and-forget auto-rename
      if (this.autoRenameEligible.has(sessionId)) {
        this.autoRenameEligible.delete(sessionId);
        this.autoRenameSession(sessionId, text);
      }

      // Initialize turn state and content buffer
      const turnStartedAt = Date.now();
      this.turnStates[sessionId] = {
        status: "in_progress",
        startedAt: turnStartedAt,
        approxTokens: 0,
        thinkingDurationMs: 0,
        activity: "brewing",
      };
      this.turnContentBuffers.set(sessionId, []);
      this.broadcast({ type: "turn_start", startedAt: turnStartedAt, sessionId });
      this.broadcastSessions().catch(() => {});

      const acpPromptT0 = performance.now();
      log.info({ session: sid(sessionId) }, "daemon: acp.prompt started");
      const result = await conn.connection.prompt({ sessionId, prompt });
      log.info({ session: sid(sessionId), durationMs: Math.round(performance.now() - acpPromptT0), stopReason: result.stopReason }, "daemon: acp.prompt completed");

      // Extract stats from result
      const meta = (result as any)._meta?.claudeCode;
      const turnState = this.turnStates[sessionId];
      if (turnState) {
        if (turnState.thinkingLastChunkAt) {
          turnState.thinkingDurationMs += Date.now() - turnState.thinkingLastChunkAt;
          turnState.thinkingLastChunkAt = undefined;
        }
        turnState.status = "completed";
        turnState.endedAt = Date.now();
        turnState.durationMs = meta?.duration_ms ?? (Date.now() - turnStartedAt);
        turnState.outputTokens = meta?.usage?.outputTokens;
        turnState.costUsd = meta?.total_cost_usd;
        turnState.stopReason = result.stopReason ?? "end_turn";
      }

      this.turnContentBuffers.delete(sessionId);
      this.broadcast({
        type: "turn_end",
        sessionId,
        stopReason: result.stopReason,
        durationMs: turnState?.durationMs,
        outputTokens: turnState?.outputTokens,
        thinkingDurationMs: turnState?.thinkingDurationMs,
        costUsd: turnState?.costUsd,
      });
      const sessionsT0 = performance.now();
      await this.broadcastSessions();
      log.info({ session: sid(sessionId), broadcastMs: Math.round(performance.now() - sessionsT0), totalMs: Math.round(performance.now() - promptT0) }, "daemon: prompt completed");
    } catch (err: any) {
      // Auto-recover stale sessions
      if (isSessionGoneError(err) && conn) {
        log.warn({ session: sid(sessionId), err: err.message }, "daemon: prompt hit stale session, auto-recovering");
        try {
          const executorType = kanbanDb.getSessionExecutorType(sessionId);
          const staleCwd = kanbanDb.getManagedSessionInfo().get(sessionId)?.projectPath ?? this.getActiveProjectCwd() ?? undefined;
          const { sessionId: newId } = await createNewSession(conn.connection, this.broadcast.bind(this), staleCwd);
          kanbanDb.setSessionExecutorType(newId, executorType);
          this.liveSessionIds.add(newId);
          this.autoRenameEligible.add(newId);

          this.eventSink({ type: "session_replaced", oldSessionId: sessionId, newSessionId: newId }, null);
          if (this.defaultSessionId === sessionId) this.defaultSessionId = newId;

          if (this.turnStates[sessionId]) delete this.turnStates[sessionId];
          this.turnContentBuffers.delete(sessionId);

          this.cleanupStaleSession(sessionId);
          await this.broadcastSessions();

          this.processingSessions.delete(sessionId);
          this.processPrompt(newId, text, images, files);
          return;
        } catch (recoverErr: any) {
          log.error({ session: sid(sessionId), err: recoverErr.message }, "daemon: prompt stale recovery failed");
        }

        if (this.turnStates[sessionId]) delete this.turnStates[sessionId];
        this.turnContentBuffers.delete(sessionId);
        this.liveSessionIds.delete(sessionId);
        this.broadcast({ type: "turn_end", stopReason: "error", sessionId });
        this.broadcastSessions().catch(() => {});
        return;
      }

      // Build detailed error string
      const details: string[] = [err.message ?? String(err)];
      if (err.status) details.push(`status=${err.status}`);
      if (err.code) details.push(`code=${err.code}`);
      if (err.type) details.push(`type=${err.type}`);
      if (err.error?.message && err.error.message !== err.message) details.push(err.error.message);
      if (err.cause) details.push(`cause=${err.cause.message ?? err.cause}`);
      const detailedText = details.length > 1 ? details.join(" — ") : details[0];

      log.error({ session: sid(sessionId), durationMs: Math.round(performance.now() - promptT0), err: detailedText, stack: err.stack }, "daemon: prompt error");
      if (this.turnStates[sessionId]) {
        const ts = this.turnStates[sessionId];
        ts.status = "error";
        ts.endedAt = Date.now();
        ts.durationMs = Date.now() - ts.startedAt;
        ts.stopReason = "error";
      }
      this.turnContentBuffers.delete(sessionId);
      this.broadcast({ type: "error", text: detailedText, sessionId });
      this.broadcast({ type: "turn_end", stopReason: "error", sessionId });
    } finally {
      this.processingSessions.delete(sessionId);
      // Persist kanban state (no epoch guard needed — daemon doesn't reload)
      try {
        const snap = kanbanDb.getKanbanSnapshot();
        const currentOverride = snap.columnOverrides[sessionId];
        if (!currentOverride || currentOverride === "in_progress") {
          kanbanDb.applyKanbanOps([{ op: "set_column", sessionId, column: "in_review" }]);
          this.eventSink({ type: "kanban_state_changed" }, null);
        }
      } catch (err: any) {
        log.warn({ session: sid(sessionId), err: err.message }, "daemon: failed to set in_review override");
      }
      this.drainQueue(sessionId);
    }
  }

  // ── processOpusPrompt ──
  // Streams a prompt through the pre-warmed opus pool instead of ACP.
  // Eliminates the ~3s cold start of resumeSession + ACP prompt, providing
  // immediate streaming feedback for kanban task starts.

  private async processOpusPrompt(sessionId: string, text: string) {
    this.processingSessions.add(sessionId);
    const promptT0 = performance.now();
    log.info({ session: sid(sessionId), textLen: text.length }, "daemon: opus prompt started");

    try {
      // Fire-and-forget auto-rename
      if (this.autoRenameEligible.has(sessionId)) {
        this.autoRenameEligible.delete(sessionId);
        this.autoRenameSession(sessionId, text);
      }

      // Initialize turn state and content buffer
      const turnStartedAt = Date.now();
      this.turnStates[sessionId] = {
        status: "in_progress",
        startedAt: turnStartedAt,
        approxTokens: 0,
        thinkingDurationMs: 0,
        activity: "brewing",
      };
      this.turnContentBuffers.set(sessionId, []);
      this.broadcast({ type: "turn_start", startedAt: turnStartedAt, sessionId });
      this.broadcastSessions().catch(() => {});

      // Stream from the pre-warmed opus pool — no ACP session resume needed
      const streamT0 = performance.now();
      log.info({ session: sid(sessionId) }, "daemon: opus pool stream started");
      let totalText = "";
      for await (const chunk of this.opusPool.stream(text)) {
        if (chunk.type === "text") {
          totalText += chunk.text;
          this.broadcast({ type: "text", text: chunk.text, sessionId });
        } else if (chunk.type === "thinking") {
          this.broadcast({ type: "thought", text: chunk.text, sessionId });
        }
      }

      const durationMs = Math.round(performance.now() - streamT0);
      log.info({ session: sid(sessionId), durationMs, outputLen: totalText.length }, "daemon: opus pool stream completed");

      // Record metrics
      this.opusPool.recordMetric({
        timestamp: Date.now(),
        operation: "kanban_task",
        durationMs,
        inputLength: text.length,
        outputLength: totalText.length,
        output: totalText.slice(0, 200),
        success: true,
      });

      // Finalize turn state
      const turnState = this.turnStates[sessionId];
      if (turnState) {
        if (turnState.thinkingLastChunkAt) {
          turnState.thinkingDurationMs += Date.now() - turnState.thinkingLastChunkAt;
          turnState.thinkingLastChunkAt = undefined;
        }
        turnState.status = "completed";
        turnState.endedAt = Date.now();
        turnState.durationMs = durationMs;
        turnState.stopReason = "end_turn";
      }

      this.turnContentBuffers.delete(sessionId);
      this.broadcast({
        type: "turn_end",
        sessionId,
        stopReason: "end_turn",
        durationMs: turnState?.durationMs,
        thinkingDurationMs: turnState?.thinkingDurationMs,
      });
      const sessionsT0 = performance.now();
      await this.broadcastSessions();
      log.info({ session: sid(sessionId), broadcastMs: Math.round(performance.now() - sessionsT0), totalMs: Math.round(performance.now() - promptT0) }, "daemon: opus prompt completed");
    } catch (err: any) {
      const details: string[] = [err.message ?? String(err)];
      if (err.status) details.push(`status=${err.status}`);
      if (err.code) details.push(`code=${err.code}`);
      const detailedText = details.length > 1 ? details.join(" — ") : details[0];

      log.error({ session: sid(sessionId), durationMs: Math.round(performance.now() - promptT0), err: detailedText }, "daemon: opus prompt error");

      // Record failure metric
      this.opusPool.recordMetric({
        timestamp: Date.now(),
        operation: "kanban_task",
        durationMs: Math.round(performance.now() - promptT0),
        inputLength: text.length,
        outputLength: 0,
        output: detailedText.slice(0, 200),
        success: false,
      });

      if (this.turnStates[sessionId]) {
        const ts = this.turnStates[sessionId];
        ts.status = "error";
        ts.endedAt = Date.now();
        ts.durationMs = Date.now() - ts.startedAt;
        ts.stopReason = "error";
      }
      this.turnContentBuffers.delete(sessionId);
      this.broadcast({ type: "error", text: detailedText, sessionId });
      this.broadcast({ type: "turn_end", stopReason: "error", sessionId });
    } finally {
      this.processingSessions.delete(sessionId);
      // Transition kanban column to in_review
      try {
        const snap = kanbanDb.getKanbanSnapshot();
        const currentOverride = snap.columnOverrides[sessionId];
        if (!currentOverride || currentOverride === "in_progress") {
          kanbanDb.applyKanbanOps([{ op: "set_column", sessionId, column: "in_review" }]);
          this.eventSink({ type: "kanban_state_changed" }, null);
        }
      } catch (err: any) {
        log.warn({ session: sid(sessionId), err: err.message }, "daemon: failed to set in_review override");
      }
      this.drainQueue(sessionId);
    }
  }

  // ── Queue management ──

  private getQueue(sessionId: string | null): QueuedMessage[] {
    if (!sessionId) return [];
    let q = this.messageQueues.get(sessionId);
    if (!q) { q = []; this.messageQueues.set(sessionId, q); }
    return q;
  }

  private drainQueue(sessionId: string): void {
    const q = this.getQueue(sessionId);
    if (q.length === 0) return;

    const items = q.splice(0, q.length);
    for (const item of items) {
      log.info({ session: sid(sessionId), queueId: item.id, batchSize: items.length }, "queue: draining");
      this.broadcast({ type: "queue_drain_start", queueId: item.id, sessionId });
    }

    const combinedText = items.map((m) => m.text).filter(Boolean).join("\n\n");
    const combinedImages = items.flatMap((m) => m.images ?? []);
    const combinedFiles = items.flatMap((m) => m.files ?? []);
    this.processPrompt(
      sessionId,
      combinedText,
      combinedImages.length > 0 ? combinedImages : undefined,
      combinedFiles.length > 0 ? combinedFiles : undefined,
    );
  }

  enqueueMessage(sessionId: string, msg: QueuedMessage): void {
    this.getQueue(sessionId).push(msg);
    log.info({ session: sid(sessionId), queueId: msg.id, queueLen: this.getQueue(sessionId).length }, "queue: enqueued");
    this.broadcast({ type: "message_queued", queueId: msg.id, sessionId });
  }

  cancelQueuedMessage(sessionId: string, queueId: string): boolean {
    const q = this.getQueue(sessionId);
    const idx = q.findIndex((m) => m.id === queueId);
    if (idx !== -1) {
      q.splice(idx, 1);
      log.info({ session: sid(sessionId), queueId }, "queue: cancelled");
      this.broadcast({ type: "queue_cancelled", queueId, sessionId });
      return true;
    }
    return false;
  }

  isProcessing(sessionId: string): boolean {
    return this.processingSessions.has(sessionId);
  }

  clearSessionQueue(sessionId: string | null): void {
    if (!sessionId) return;
    this.messageQueues.delete(sessionId);
  }

  generateQueueId(): string {
    return `sq-${++this.queueIdCounter}`;
  }

  // ── Session metadata ──

  private getSessionMeta(sessionId: string): SessionMeta {
    let meta = this.sessionMetas.get(sessionId);
    if (!meta) { meta = { systemMessages: [] }; this.sessionMetas.set(sessionId, meta); }
    return meta;
  }

  // ── State accessors ──

  getTurnStatusSnapshot(sessionId: string): object | null {
    const ts = this.turnStates[sessionId];
    if (!ts || ts.status !== "in_progress") return null;
    return {
      status: "in_progress",
      startedAt: ts.startedAt,
      activity: ts.activity,
      activityDetail: ts.activityDetail,
      approxTokens: ts.approxTokens,
      thinkingDurationMs: ts.thinkingDurationMs,
    };
  }

  sendTurnState(ws: WsSendable, sessionId: string): void {
    const ts = this.turnStates[sessionId];
    if (!ts || ts.status !== "in_progress") return;

    const buf = this.turnContentBuffers.get(sessionId);
    if (buf && buf.length > 0) {
      ws.send(JSON.stringify({ type: "turn_content_replay", sessionId, messages: buf }));
    }
    ws.send(JSON.stringify({ type: "turn_start", startedAt: ts.startedAt, sessionId }));
    ws.send(JSON.stringify({
      type: "turn_activity",
      sessionId,
      activity: ts.activity,
      detail: ts.activityDetail,
      approxTokens: ts.approxTokens,
      thinkingDurationMs: ts.thinkingDurationMs,
    }));
  }

  sendSessionMeta(ws: WsSendable, sessionId: string): void {
    const meta = this.sessionMetas.get(sessionId);
    if (!meta) return;
    if (meta.sessionInfo) ws.send(JSON.stringify(meta.sessionInfo));
    for (const text of meta.systemMessages) {
      ws.send(JSON.stringify({ type: "system", sessionId, text }));
    }
    if (meta.commands) ws.send(JSON.stringify({ type: "commands", sessionId, commands: meta.commands }));
  }

  sendQueueState(ws: WsSendable, sessionId: string): void {
    const q = this.messageQueues.get(sessionId);
    if (!q || q.length === 0) return;
    for (const item of q) {
      ws.send(JSON.stringify({ type: "message_queued", queueId: item.id, sessionId }));
    }
  }

  augmentHistoryWithTurnStats(sessionId: string, entries: unknown[]): unknown[] {
    if (entries.length === 0) return entries;

    const result: unknown[] = [];
    let turnStartTs: string | null = null;
    let turnTextChars = 0;

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i] as Record<string, unknown>;
      result.push(e);

      if (e.type === "user" && !e.isMeta) {
        turnStartTs = (e.timestamp as string) ?? null;
        turnTextChars = 0;
      }

      if (e.type === "assistant") {
        const msg = e.message as Record<string, unknown> | undefined;
        const content = msg?.content as Array<Record<string, unknown>> | undefined;
        if (content) {
          for (const block of content) {
            if ((block.type === "text" || block.type === "thinking") && typeof block.text === "string") {
              turnTextChars += block.text.length;
            }
          }
        }
      }

      if (e.type === "system" && e.subtype === "turn_duration") {
        turnStartTs = null;
        turnTextChars = 0;
        continue;
      }

      const next = entries[i + 1] as Record<string, unknown> | undefined;
      const isEndOfTurn = !next || (next.type === "user" && !next.isMeta);
      const nextIsDuration = next?.type === "system" && next?.subtype === "turn_duration";

      if (isEndOfTurn && !nextIsDuration && turnStartTs && e.type === "assistant") {
        const approxTokens = Math.ceil(turnTextChars / 4);
        const ts = this.turnStates[sessionId];

        if (!next && ts?.status === "in_progress") {
          turnStartTs = null;
        } else if (ts?.status === "completed" && ts.durationMs && !next) {
          result.push({
            type: "system",
            subtype: "turn_duration",
            durationMs: ts.durationMs,
            outputTokens: ts.outputTokens ?? approxTokens,
            thinkingDurationMs: ts.thinkingDurationMs,
            costUsd: ts.costUsd,
          });
        } else if (turnStartTs && e.timestamp) {
          const start = new Date(turnStartTs).getTime();
          const end = new Date(e.timestamp as string).getTime();
          const durationMs = end - start;
          if (durationMs > 0) {
            result.push({
              type: "system",
              subtype: "turn_duration",
              durationMs,
              ...(approxTokens > 0 && { outputTokens: approxTokens }),
            });
          }
        }
        turnStartTs = null;
      }
    }

    return result;
  }

  // ── Routing ──

  async routeWithHaiku(text: string, sessionTitle: string | null, lastTurnSummary: string | null): Promise<boolean> {
    return this.haikuPool.route(text, sessionTitle, lastTurnSummary);
  }

  isRouteWhitelisted(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) return true;
    return ROUTE_WHITELIST_PATTERNS.some((pat) => pat.test(trimmed));
  }

  async getLastTurnSummary(sessionId: string): Promise<string | null> {
    try {
      const result = await this.getHistory(sessionId);
      const entries = (result.entries as any[]) ?? [];
      if (entries.length === 0) return null;

      let lastUserText: string | null = null;
      let lastAssistantText: string | null = null;

      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (!lastAssistantText && e.type === "assistant") {
          const content = e.message?.content as any[] | undefined;
          if (content) {
            const texts = content.filter((b: any) => b.type === "text" && b.text).map((b: any) => b.text as string);
            if (texts.length > 0) lastAssistantText = texts.join(" ").slice(0, 300);
          }
        }
        if (!lastUserText && e.type === "user" && !e.isMeta) {
          const content = e.message?.content as any[] | undefined;
          if (content) {
            const texts = content.filter((b: any) => b.type === "text" && b.text).map((b: any) => b.text as string);
            if (texts.length > 0) lastUserText = texts.join(" ").slice(0, 300);
          }
        }
        if (lastUserText && lastAssistantText) break;
      }

      if (!lastUserText && !lastAssistantText) return null;
      const parts: string[] = [];
      if (lastUserText) parts.push(`Last user message: "${lastUserText}"`);
      if (lastAssistantText) parts.push(`Last assistant response: "${lastAssistantText}"`);
      return parts.join("\n");
    } catch (err: any) {
      log.warn({ err: err.message, sessionId: sessionId.slice(0, 8) }, "route: getLastTurnSummary failed");
      return null;
    }
  }

  getSessionTitle(sessionId: string): string | null {
    return this.sessionTitleCache.get(sessionId) ?? null;
  }

  // ── Queries ──

  async getHistory(sessionId: string): Promise<{ entries: unknown[] }> {
    // Codex sessions: read JSONL directly from disk (codex-acp doesn't support ext_methods)
    const executorType = kanbanDb.getSessionExecutorType(sessionId);
    if (executorType === "codex") {
      const entries = await readCodexSessionHistory(sessionId);
      return { entries };
    }

    const conn = this.getConnectionForSession(sessionId);
    if (!conn) throw new Error("Daemon not initialized");
    const result = await conn.connection.extMethod("sessions/getHistory", { sessionId });
    return { entries: result.entries as unknown[] };
  }

  async getSubagentHistory(parentSessionId: string, agentId: string): Promise<{ entries: unknown[] }> {
    const conn = this.getConnectionForSession(parentSessionId);
    if (!conn) throw new Error("Daemon not initialized");
    const result = await conn.connection.extMethod("sessions/getSubagentHistory", {
      sessionId: parentSessionId,
      agentId,
    });
    return { entries: result.entries as unknown[] };
  }

  async broadcastSessions(): Promise<void> {
    if (!this.connections.claude) return;
    if (this.broadcastSessionsPromise && Date.now() - this.broadcastSessionsStartedAt > 15_000) {
      log.warn("daemon: broadcastSessions stale promise (>15s), discarding");
      this.broadcastSessionsPromise = null;
    }
    if (this.broadcastSessionsPromise) {
      log.debug("daemon: broadcastSessions coalesced");
      return this.broadcastSessionsPromise;
    }

    this.broadcastSessionsStartedAt = Date.now();
    this.broadcastSessionsPromise = (async () => {
      const t0 = performance.now();
      log.info("daemon: sessions/list started");
      try {
        // Query both connections in parallel
        const claudePromise = this.connections.claude!.connection.extMethod("sessions/list", {});
        const codexPromise = this.connections.codex
          ? this.connections.codex.connection.extMethod("sessions/list", {}).catch((err: any) => {
              log.warn({ err: err.message }, "daemon: codex sessions/list failed");
              return { sessions: [] };
            })
          : Promise.resolve({ sessions: [] });

        const [claudeResult, codexResult] = await Promise.all([claudePromise, codexPromise]);
        const t1 = performance.now();

        // Get all executor types from DB for tagging
        const executorTypes = kanbanDb.getAllSessionExecutorTypes();

        // Query our stored project paths BEFORE mapSession so we can use them
        // as the authoritative source (ACP metadata may report the agent process's cwd).
        const managedInfo = kanbanDb.getManagedSessionInfo();

        const mapSession = (s: any) => ({
          sessionId: s.sessionId,
          title: s.title ?? null,
          updatedAt: s.updatedAt ?? null,
          created: s._meta?.created ?? null,
          messageCount: s._meta?.messageCount ?? 0,
          gitBranch: s._meta?.gitBranch ?? null,
          projectPath: managedInfo.get(s.sessionId)?.projectPath ?? s._meta?.projectPath ?? s.cwd ?? null,
          ...(s._meta?.children ? { children: s._meta.children } : {}),
          ...(s._meta?.teamName ? { teamName: s._meta.teamName } : {}),
          executorType: executorTypes[s.sessionId] ?? "claude",
          isLive: this.liveSessionIds.has(s.sessionId),
          ...(this.turnStates[s.sessionId] ? (() => {
            const ts = this.turnStates[s.sessionId];
            return {
              turnStatus: ts.status,
              ...(ts.status === "in_progress" ? {
                turnStartedAt: ts.startedAt,
                turnActivity: ts.activity,
                turnActivityDetail: ts.activityDetail,
              } : {
                ...(ts.startedAt && { turnStartedAt: ts.startedAt }),
                ...(ts.durationMs != null && { turnDurationMs: ts.durationMs }),
                ...(ts.outputTokens != null && { turnOutputTokens: ts.outputTokens }),
                ...(ts.costUsd != null && { turnCostUsd: ts.costUsd }),
                ...(ts.thinkingDurationMs != null && ts.thinkingDurationMs > 0 && { turnThinkingDurationMs: ts.thinkingDurationMs }),
                ...(ts.stopReason && { turnStopReason: ts.stopReason }),
              }),
            };
          })() : {}),
        });

        const claudeSessions = ((claudeResult as any).sessions ?? []).map(mapSession);
        const codexSessions = ((codexResult as any).sessions ?? []).map(mapSession);

        // Auto-persist executor type for codex sessions so getConnectionForSession
        // and getHistory route correctly (otherwise they default to "claude").
        for (const s of codexSessions) {
          if (!executorTypes[s.sessionId]) {
            kanbanDb.setSessionExecutorType(s.sessionId, "codex");
            s.executorType = "codex";
          }
        }

        const allSessions = [...claudeSessions, ...codexSessions];
        const listedIds = new Set(allSessions.map((s: any) => s.sessionId));

        // Include managed-but-unlisted sessions as stub entries so they always
        // appear on the kanban board. This handles cases where ACP sessions/list
        // doesn't return the session (e.g. codex-acp doesn't support the method,
        // race condition during creation, or connection failure).
        for (const [id, info] of managedInfo) {
          if (!listedIds.has(id)) {
            const et = executorTypes[id] ?? "claude";
            allSessions.push({
              sessionId: id,
              title: this.sessionTitleCache.get(id) ?? null,
              updatedAt: null,
              created: null,
              messageCount: 0,
              gitBranch: null,
              projectPath: info.projectPath,
              executorType: et,
              isLive: this.liveSessionIds.has(id),
              ...(this.turnStates[id] ? (() => {
                const ts = this.turnStates[id];
                return {
                  turnStatus: ts.status,
                  ...(ts.status === "in_progress" ? {
                    turnStartedAt: ts.startedAt,
                    turnActivity: ts.activity,
                    turnActivityDetail: ts.activityDetail,
                  } : {
                    ...(ts.startedAt && { turnStartedAt: ts.startedAt }),
                    ...(ts.durationMs != null && { turnDurationMs: ts.durationMs }),
                    ...(ts.stopReason && { turnStopReason: ts.stopReason }),
                  }),
                };
              })() : {}),
            });
          }
        }

        // Filter to only sessions managed by dev studio (registered in SQLite)
        const managedIds = new Set(managedInfo.keys());
        const sessions = allSessions.filter((s: any) => managedIds.has(s.sessionId));

        for (const s of allSessions) {
          if (s.title) this.sessionTitleCache.set(s.sessionId, s.title);
        }
        log.info({ durationMs: Math.round(t1 - t0), total: allSessions.length, managed: sessions.length, claude: claudeSessions.length, codex: codexSessions.length }, "daemon: sessions/list completed");
        this.broadcast({ type: "sessions", sessions });
        // Lazy cleanup: prune stale kanban entries (use all ACP sessions as valid set).
        // Include managed session IDs so their kanban state is never wiped by cleanup.
        {
          const validIds = new Set(allSessions.map((s: any) => s.sessionId));
          for (const id of managedIds) validIds.add(id);
          if (kanbanDb.cleanStaleSessions(validIds)) {
            this.eventSink({ type: "kanban_state_changed" }, null);
          }
        }
      } catch (err: any) {
        log.error({ durationMs: Math.round(performance.now() - t0), err: err.message }, "daemon: sessions/list error");
      }
    })();

    try {
      await this.broadcastSessionsPromise;
    } finally {
      this.broadcastSessionsPromise = null;
    }
  }

  async getSubagents(sessionId: string): Promise<any> {
    const conn = this.getConnectionForSession(sessionId);
    if (!conn) throw new Error("Daemon not initialized");
    return conn.connection.extMethod("sessions/getSubagents", { sessionId });
  }

  async getAvailableCommands(sessionIdHint?: string): Promise<any> {
    const conn = sessionIdHint ? this.getConnectionForSession(sessionIdHint) : this.connections.claude;
    if (!conn) throw new Error("Daemon not initialized");
    // Lazily resume the session if needed
    if (sessionIdHint && !this.liveSessionIds.has(sessionIdHint)) {
      try {
        const storedCwd = kanbanDb.getManagedSessionInfo().get(sessionIdHint)?.projectPath ?? undefined;
        await resumeSession(conn.connection, sessionIdHint, storedCwd);
        this.liveSessionIds.add(sessionIdHint);
        this.broadcastSessions().catch(() => {});
      } catch (resumeErr: any) {
        if (!isSessionGoneError(resumeErr)) {
          log.warn({ session: sid(sessionIdHint), err: resumeErr.message }, "daemon: getAvailableCommands resume failed");
        }
      }
    }
    return conn.connection.extMethod("sessions/getAvailableCommands", {});
  }

  async getTasksList(sessionId: string): Promise<any> {
    const conn = this.getConnectionForSession(sessionId);
    if (!conn) throw new Error("Daemon not initialized");
    return conn.connection.extMethod("tasks/list", { sessionId });
  }

  // ── Session management ──

  async renameSession(sessionId: string, title: string): Promise<boolean> {
    const conn = this.getConnectionForSession(sessionId);
    if (!conn) return false;
    this.autoRenameEligible.delete(sessionId);
    this.autoRenameInFlight.delete(sessionId);
    const result = await conn.connection.extMethod("sessions/rename", { sessionId, title });
    if (result.success) {
      this.sessionTitleCache.set(sessionId, title);
      // Emit session_title_update immediately so clients get the title even if
      // broadcastSessions() is coalesced with an in-flight request that was
      // fetched before the rename (e.g. during createBacklogSession).
      this.broadcast({ type: "session_title_update", sessionId, title });
      await this.broadcastSessions();
    }
    return !!result.success;
  }

  async deleteSession(sessionId: string): Promise<{ success: boolean; deletedIds: string[] }> {
    const conn = this.getConnectionForSession(sessionId);
    if (!conn) return { success: false, deletedIds: [] };
    const result = await conn.connection.extMethod("sessions/delete", { sessionId });
    const deletedIds = (result.deletedIds as string[]) ?? [sessionId];
    if (result.success) {
      for (const id of deletedIds) {
        this.liveSessionIds.delete(id);
        this.autoRenameEligible.delete(id);
        this.autoRenameInFlight.delete(id);
        this.clearSessionQueue(id);
        this.turnContentBuffers.delete(id);
        delete this.turnStates[id];
        this.sessionMetas.delete(id);
        this.sessionTitleCache.delete(id);
        kanbanDb.deleteSessionExecutorType(id);
        kanbanDb.deleteManagedSession(id);
      }
    }
    return { success: !!result.success, deletedIds };
  }

  cleanupStaleSession(sessionId: string): void {
    this.liveSessionIds.delete(sessionId);
    this.clearSessionQueue(sessionId);
    delete this.turnStates[sessionId];
    this.turnContentBuffers.delete(sessionId);
    this.sessionMetas.delete(sessionId);
    this.autoRenameEligible.delete(sessionId);
    this.autoRenameInFlight.delete(sessionId);
    this.sessionTitleCache.delete(sessionId);
    const conn = this.getConnectionForSession(sessionId);
    conn?.connection.extMethod("sessions/delete", { sessionId }).catch(() => {});
    kanbanDb.deleteSessionExecutorType(sessionId);
    kanbanDb.deleteManagedSession(sessionId);
  }

  async findDefaultSession(): Promise<string | null> {
    if (!this.connections.claude) return null;
    try {
      const result = await this.connections.claude.connection.extMethod("sessions/list", {});
      const sessions = ((result as any).sessions ?? []) as any[];
      const managedIds = kanbanDb.getManagedSessionIds();
      // Filter to managed sessions and sort by updatedAt descending
      const managed = sessions
        .filter((s: any) => managedIds.has(s.sessionId))
        .sort((a: any, b: any) => {
          const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
          const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
          return tb - ta;
        });
      return managed.length > 0 ? managed[0].sessionId : null;
    } catch (err: any) {
      log.warn({ err: err.message }, "daemon: findDefaultSession failed");
      return null;
    }
  }

  // ── Auto-rename ──

  private autoRenameSession(sessionId: string, userMessage: string): void {
    const cwd = this.getActiveProjectCwd();
    this.autoRenameInFlight.add(sessionId);
    this.haikuPool.generateTitle(cwd, userMessage, "").then(async (title) => {
      if (!title) {
        log.warn({ session: sid(sessionId) }, "auto-rename: generateTitle returned null, skipping");
        this.autoRenameInFlight.delete(sessionId);
        return;
      }
      const conn = this.getConnectionForSession(sessionId);
      if (!conn) return;
      if (!this.autoRenameInFlight.delete(sessionId)) {
        log.info({ session: sid(sessionId), title }, "auto-rename: cancelled (manual rename during generation)");
        return;
      }
      try {
        await conn.connection.extMethod("sessions/rename", { sessionId, title });
        this.sessionTitleCache.set(sessionId, title);
        log.info({ session: sid(sessionId), title }, "auto-rename: applied");
        await this.broadcastSessions();
        this.broadcast({ type: "session_title_update", sessionId, title });
      } catch (err: any) {
        log.error({ err: err.message, session: sid(sessionId) }, "auto-rename: apply failed");
      }
    }).catch((err) => {
      this.autoRenameInFlight.delete(sessionId);
      log.error({ err: err.message, session: sid(sessionId) }, "auto-rename: generate failed");
    });
  }

  // ── Metrics ──

  getHaikuMetrics() { return this.haikuPool.getMetrics(); }
  getOpusMetrics() { return this.opusPool.getMetrics(); }

  // ── Permission forwarding ──

  resolvePermission(requestId: string, optionId: string, optionName: string): void {
    // Permission requests can come from either connection — try both
    this.connections.claude?.webClient.resolvePermission(requestId, optionId, optionName);
    this.connections.codex?.webClient.resolvePermission(requestId, optionId, optionName);
  }

  cancelPermissions(sessionId: string): void {
    const conn = this.getConnectionForSession(sessionId);
    conn?.webClient.cancelPermissions(sessionId);
  }

  // ── Helpers ──

  private getResolvedProjectDir(): string {
    const cwd = process.env.ACP_CWD || process.cwd();
    return getProjectDir(cwd);
  }
}

// ── globalThis persistence ──

const DAEMON_KEY = "__devStudioDaemon";

export function getOrCreateDaemon(): AgentsDaemon {
  const g = globalThis as any;
  if (!g[DAEMON_KEY]) {
    log.info("daemon: creating new instance");
    g[DAEMON_KEY] = new AgentsDaemonImpl();
  } else {
    // Patch the existing instance's prototype so it picks up any
    // new or modified methods introduced by HMR-reloaded code.
    Object.setPrototypeOf(g[DAEMON_KEY], AgentsDaemonImpl.prototype);
    log.info("daemon: reusing existing instance (HMR reload, prototype patched)");
  }
  // HMR compatibility: older daemon instances (pre multi-executor support)
  // may only have `acpConnection` and no `connections` object.
  const daemon = g[DAEMON_KEY] as any;
  if (!daemon.connections || typeof daemon.connections !== "object") {
    daemon.connections = {
      claude: daemon.acpConnection ?? null,
      codex: null,
    };
    log.warn(
      { migratedLegacyAcpConnection: !!daemon.acpConnection },
      "daemon: hydrated missing connections field on reused instance",
    );
  } else {
    if (!("claude" in daemon.connections)) {
      daemon.connections.claude = daemon.acpConnection ?? null;
    }
    if (!("codex" in daemon.connections)) {
      daemon.connections.codex = null;
    }
    // Lazily connect Codex if binary became available since last init
    if (!daemon.connections.codex && isCodexAvailable()) {
      log.info("daemon: Codex binary now available, attempting late connection");
      createCodexConnection(daemon.broadcast.bind(daemon)).then((conn) => {
        daemon.connections.codex = conn;
        log.info("daemon: Codex ACP late connection ready");
        // Notify connected clients that Codex is now available
        daemon.broadcast({ type: "executors", available: daemon.getAvailableExecutors() });
      }).catch((err: any) => {
        log.warn({ err: err.message }, "daemon: Codex ACP late connection failed");
      });
    }
  }
  return daemon;
}
