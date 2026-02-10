import path from "node:path";
import { execSync } from "node:child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createAcpConnection, createNewSession, resumeSession } from "./session.js";
import type { AcpConnection } from "./types.js";
import { log, bootMs } from "./log.js";

export function startServer(port: number) {
  // ── Client tracking ──
  let nextClientId = 1;
  interface ClientState { id: number; currentSessionId: string | null; connectedAt: number }
  const clients = new Map<{ send: (data: string) => void }, ClientState>();
  const liveSessionIds = new Set<string>();
  /** Default session for reconnecting clients (set when first session is created). */
  let defaultSessionId: string | null = null;

  /** Short session ID for logs. */
  function sid(sessionId: string | null | undefined): string {
    if (!sessionId) return "(none)";
    return sessionId.slice(0, 8);
  }

  // ── Turn state (server-side, survives client disconnect/reconnect) ──
  type TurnActivity = "brewing" | "thinking" | "responding" | "reading" | "editing" | "running" | "searching" | "delegating" | "planning" | "compacting";
  interface TurnState {
    status: "in_progress" | "completed" | "error";
    startedAt: number;
    endedAt?: number;
    durationMs?: number;
    approxTokens: number;
    thinkingDurationMs: number;
    thinkingLastChunkAt?: number;
    costUsd?: number;
    outputTokens?: number;
    activity: TurnActivity;
    activityDetail?: string;
  }
  const turnStates: Record<string, TurnState> = {};

  // ── Message queue (per-session) ──
  type QueuedMessage = { id: string; text: string; images?: Array<{ data: string; mimeType: string }>; files?: Array<{ path: string; name: string }>; addedAt: number };
  const messageQueues = new Map<string, QueuedMessage[]>();
  const processingSessions = new Set<string>();
  let queueIdCounter = 0;

  // ── Per-session state (survives client disconnect/reconnect) ──
  // Stores metadata that new clients need on connect but that only arrives once.
  interface SessionMeta {
    sessionInfo?: { sessionId: string; models: string[]; modes: { id: string; name?: string }[] };
    systemMessages: string[];  // System text messages (e.g. "Connected to...", init metadata)
    commands?: { name: string; description: string; inputHint?: string }[];
  }
  const sessionMetas = new Map<string, SessionMeta>();

  function getSessionMeta(sessionId: string): SessionMeta {
    let meta = sessionMetas.get(sessionId);
    if (!meta) { meta = { systemMessages: [] }; sessionMetas.set(sessionId, meta); }
    return meta;
  }

  // ── Turn content buffer (per-session) ──
  // Accumulates streaming messages for the in-progress turn so that clients
  // joining mid-turn can replay all content they missed (tmux-style attach).
  const turnContentBuffers = new Map<string, object[]>();
  const BUFFERABLE_TYPES = new Set(["text", "thought", "tool_call", "tool_call_update", "plan", "permission_request", "permission_resolved", "error"]);

  function getQueue(sessionId: string | null): QueuedMessage[] {
    if (!sessionId) return [];
    let q = messageQueues.get(sessionId);
    if (!q) { q = []; messageQueues.set(sessionId, q); }
    return q;
  }

  // Low-level: send raw string to all WS clients (no filtering, no instrumentation)
  function sendToAll(data: string) {
    for (const ws of clients.keys()) {
      try { ws.send(data); } catch {}
    }
  }

  // Emit a protocol entry to the debug panel (bypasses sessionId filter)
  function emitProto(dir: "send" | "recv", msg: unknown) {
    sendToAll(JSON.stringify({ type: "protocol", dir, ts: Date.now(), msg }));
  }

  // Server-originated events that have NO ACP equivalent.
  // Broadcasts that relay ACP responses (disk_sessions, session_list, session_history,
  // session_info) are NOT listed — the ACP instrumented stream already shows them.
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
  };

  // Map tool kind/name to a turn activity
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
    // Default for unknown tools
    if (n) return { activity: "brewing", detail: n };
    return { activity: "brewing" };
  }

  function setActivity(ts: TurnState, activity: TurnActivity, detail?: string) {
    if (ts.activity === activity && ts.activityDetail === detail) return false;
    ts.activity = activity;
    ts.activityDetail = detail;
    return true;
  }

  /** Send data to all clients viewing a specific session. */
  function sendToSession(sessionId: string, data: string) {
    for (const [ws, clientState] of clients) {
      if (clientState.currentSessionId === sessionId) {
        try { ws.send(data); } catch {}
      }
    }
  }

  /** Send per-session metadata state to a single client (session_info, system messages, commands). */
  function sendSessionMeta(ws: { send(data: string): void }, sessionId: string) {
    const meta = sessionMetas.get(sessionId);
    if (!meta) return;
    if (meta.sessionInfo) {
      ws.send(JSON.stringify(meta.sessionInfo));
    }
    for (const text of meta.systemMessages) {
      ws.send(JSON.stringify({ type: "system", sessionId, text }));
    }
    if (meta.commands) {
      ws.send(JSON.stringify({ type: "commands", sessionId, commands: meta.commands }));
    }
  }

  /** Build a TurnStatus snapshot for a session (included in session_switched). */
  function getTurnStatusSnapshot(sessionId: string): object | null {
    const ts = turnStates[sessionId];
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

  /** Send in-progress turn state + buffered content to a single client (tmux-style attach).
   *  Completed turns are handled via augmentHistoryWithTurnStats (inline in history). */
  function sendTurnState(ws: { send(data: string): void }, sessionId: string) {
    const ts = turnStates[sessionId];
    if (!ts || ts.status !== "in_progress") return;

    // Replay buffered streaming chunks FIRST (text, thoughts, tool calls)
    const buf = turnContentBuffers.get(sessionId);
    if (buf && buf.length > 0) {
      ws.send(JSON.stringify({ type: "turn_content_replay", sessionId, messages: buf }));
    }

    // Send turn state AFTER replay so TURN_START isn't reset by replayed SEND_MESSAGE
    ws.send(JSON.stringify({ type: "turn_start", startedAt: ts.startedAt, sessionId }));
    ws.send(JSON.stringify({
      type: "turn_activity",
      activity: ts.activity,
      detail: ts.activityDetail,
      approxTokens: ts.approxTokens,
      thinkingDurationMs: ts.thinkingDurationMs,
    }));
  }

  /** Send queued messages to a single client (tmux-style reconnect). */
  function sendQueueState(ws: { send(data: string): void }, sessionId: string) {
    const q = messageQueues.get(sessionId);
    if (!q || q.length === 0) return;
    for (const item of q) {
      ws.send(JSON.stringify({ type: "message_queued", queueId: item.id, sessionId }));
    }
  }

  /** Augment history entries: append turn_duration for every completed turn that lacks one. */
  function augmentHistoryWithTurnStats(sessionId: string, entries: unknown[]): unknown[] {
    if (entries.length === 0) return entries;

    const result: unknown[] = [];
    let turnStartTs: string | null = null; // timestamp of the user message starting current turn
    let turnTextChars = 0; // accumulated text chars in current turn (for approx token count)

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i] as Record<string, unknown>;
      result.push(e);

      // Track turn starts (non-meta user entries)
      if (e.type === "user" && !e.isMeta) {
        turnStartTs = (e.timestamp as string) ?? null;
        turnTextChars = 0;
      }

      // Accumulate text chars from assistant content blocks
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

      // Already has a turn_duration → reset turn tracking
      if (e.type === "system" && e.subtype === "turn_duration") {
        turnStartTs = null;
        turnTextChars = 0;
        continue;
      }

      // At end of entries or next entry starts a new turn → inject duration for current turn
      const next = entries[i + 1] as Record<string, unknown> | undefined;
      const isEndOfTurn = !next || (next.type === "user" && !next.isMeta);
      const nextIsDuration = next?.type === "system" && next?.subtype === "turn_duration";

      if (isEndOfTurn && !nextIsDuration && turnStartTs && e.type === "assistant") {
        const approxTokens = Math.ceil(turnTextChars / 4);
        // Check turnStates for server-known stats first
        const ts = turnStates[sessionId];

        // Skip injecting turn_duration for the last entry if the turn is still in_progress
        // (the live TurnStatusBar handles that case; injecting here causes a false completed bar)
        if (!next && ts?.status === "in_progress") {
          turnStartTs = null;
        } else if (ts?.status === "completed" && ts.durationMs && !next) {
          // Last turn — use server stats if available
          result.push({
            type: "system",
            subtype: "turn_duration",
            durationMs: ts.durationMs,
            outputTokens: ts.outputTokens ?? approxTokens,
            thinkingDurationMs: ts.thinkingDurationMs,
            costUsd: ts.costUsd,
          });
        } else if (turnStartTs && e.timestamp) {
          // Compute approximate duration and tokens from content
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

  function broadcast(msg: object) {
    const m = msg as any;
    // Determine which session this message belongs to
    const msgSessionId = m.sessionId ?? null;

    // ── Accumulate turn stats + track activity from streaming messages ──
    // (do this before filtering so stats accumulate even for background sessions)
    let activityChanged = false;

    // Handle set_activity: update turn state only, don't forward to clients
    if (m.type === "set_activity" && msgSessionId && turnStates[msgSessionId]?.status === "in_progress") {
      activityChanged = setActivity(turnStates[msgSessionId], m.activity, m.detail);
      if (activityChanged) {
        const ts = turnStates[msgSessionId];
        sendToSession(msgSessionId, JSON.stringify({
          type: "turn_activity",
          activity: ts.activity,
          detail: ts.activityDetail,
          approxTokens: ts.approxTokens,
          thinkingDurationMs: ts.thinkingDurationMs,
        }));
      }
      return;
    }

    if (msgSessionId && turnStates[msgSessionId]?.status === "in_progress") {
      const ts = turnStates[msgSessionId];
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

    // Emit proto entry for server-originated events (not ACP relays)
    const method = m.type && SERVER_EVENT_MAP[m.type];
    if (method) {
      emitProto("recv", { method, params: m });
    }

    // ── Capture per-session state (survives turn boundaries) ──
    if (msgSessionId) {
      if (m.type === "session_info") {
        getSessionMeta(msgSessionId).sessionInfo = { type: "session_info", sessionId: msgSessionId, models: m.models, currentModel: m.currentModel, modes: m.modes } as any;
      } else if (m.type === "system" && m.text) {
        const meta = getSessionMeta(msgSessionId);
        if (!meta.systemMessages.includes(m.text)) meta.systemMessages.push(m.text);
      } else if (m.type === "commands") {
        getSessionMeta(msgSessionId).commands = m.commands;
      }
    }

    // Buffer content messages for late-joining clients (mid-turn replay)
    if (msgSessionId && turnStates[msgSessionId]?.status === "in_progress" && BUFFERABLE_TYPES.has(m.type)) {
      const buf = turnContentBuffers.get(msgSessionId);
      if (buf) buf.push(msg);
    }

    // Send to clients — filter session-specific messages per client
    const json = JSON.stringify(msg);
    if (msgSessionId) {
      sendToSession(msgSessionId, json);
      // Send turn_activity update only when activity actually changed
      if (activityChanged) {
        const ts = turnStates[msgSessionId];
        sendToSession(msgSessionId, JSON.stringify({
          type: "turn_activity",
          activity: ts.activity,
          detail: ts.activityDetail,
          approxTokens: ts.approxTokens,
          thinkingDurationMs: ts.thinkingDurationMs,
        }));
      }
    } else {
      // Global message: send to all
      sendToAll(json);
    }
  }

  let acpConnection: AcpConnection | null = null;
  let connectingPromise: Promise<void> | null = null;

  // Promise that resolves when the first session is created (defaultSessionId is set).
  // All WebSocket clients wait on this before sending session_switched.
  let resolveFirstSession: (() => void) | null = null;
  const firstSessionReady = new Promise<void>((r) => { resolveFirstSession = r; });

  // Eagerly pre-warm the ACP connection at server startup so the first
  // WebSocket client doesn't have to wait for agent spawn + initialize.
  function prewarmAcpConnection(): Promise<void> {
    if (acpConnection || connectingPromise) return connectingPromise ?? Promise.resolve();
    const t0 = performance.now();
    log.info({ boot: bootMs() }, "prewarm: starting ACP connection");
    connectingPromise = (async () => {
      acpConnection = await createAcpConnection(broadcast);
      log.info({ durationMs: Math.round(performance.now() - t0), boot: bootMs() }, "prewarm: ACP connection ready");
    })();
    return connectingPromise;
  }

  async function processPrompt(sessionId: string, text: string, images?: Array<{ data: string; mimeType: string }>, files?: Array<{ path: string; name: string }>) {
    if (!acpConnection) return;
    processingSessions.add(sessionId);
    const promptT0 = performance.now();
    log.info({ session: sid(sessionId), textLen: text.length, images: images?.length ?? 0, files: files?.length ?? 0 }, "api: prompt started");
    try {
      // Lazily resume the ACP session if not already live
      if (!liveSessionIds.has(sessionId)) {
        const resumeT0 = performance.now();
        log.info({ session: sid(sessionId) }, "api: resumeSession started");
        await resumeSession(acpConnection.connection, sessionId);
        log.info({ session: sid(sessionId), durationMs: Math.round(performance.now() - resumeT0) }, "api: resumeSession completed");
        liveSessionIds.add(sessionId);
        await broadcastSessions();
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
      if (prompt.length === 0) { processingSessions.delete(sessionId); drainQueue(sessionId); return; }

      // Initialize turn state and content buffer; broadcast turn_start
      const turnStartedAt = Date.now();
      turnStates[sessionId] = {
        status: "in_progress",
        startedAt: turnStartedAt,
        approxTokens: 0,
        thinkingDurationMs: 0,
        activity: "brewing",
      };
      // Start an empty buffer — user message is already in session history (JSONL)
      turnContentBuffers.set(sessionId, []);
      broadcast({ type: "turn_start", startedAt: turnStartedAt, sessionId });
      // Refresh sidebar so it shows in_progress status
      broadcastSessions().catch(() => {});

      const acpPromptT0 = performance.now();
      log.info({ session: sid(sessionId) }, "api: acp.prompt started");
      const result = await acpConnection.connection.prompt({
        sessionId,
        prompt,
      });
      log.info({ session: sid(sessionId), durationMs: Math.round(performance.now() - acpPromptT0), stopReason: result.stopReason }, "api: acp.prompt completed");

      // Extract stats from result metadata
      const meta = (result as any)._meta?.claudeCode;
      const turnState = turnStates[sessionId];
      if (turnState) {
        // Finalize any ongoing thinking
        if (turnState.thinkingLastChunkAt) {
          turnState.thinkingDurationMs += Date.now() - turnState.thinkingLastChunkAt;
          turnState.thinkingLastChunkAt = undefined;
        }
        turnState.status = "completed";
        turnState.endedAt = Date.now();
        turnState.durationMs = meta?.duration_ms ?? (Date.now() - turnStartedAt);
        turnState.outputTokens = meta?.usage?.outputTokens;
        turnState.costUsd = meta?.total_cost_usd;
      }

      turnContentBuffers.delete(sessionId);
      broadcast({
        type: "turn_end",
        sessionId,
        stopReason: result.stopReason,
        durationMs: turnState?.durationMs,
        outputTokens: turnState?.outputTokens,
        thinkingDurationMs: turnState?.thinkingDurationMs,
        costUsd: turnState?.costUsd,
      });
      // Refresh session list to pick up title changes
      const sessionsT0 = performance.now();
      await broadcastSessions();
      log.info({ session: sid(sessionId), broadcastMs: Math.round(performance.now() - sessionsT0), totalMs: Math.round(performance.now() - promptT0) }, "api: prompt completed");
    } catch (err: any) {
      log.error({ session: sid(sessionId), durationMs: Math.round(performance.now() - promptT0), err: err.message }, "api: prompt error");
      // Update turn state to error
      if (turnStates[sessionId]) {
        const ts = turnStates[sessionId];
        ts.status = "error";
        ts.endedAt = Date.now();
        ts.durationMs = Date.now() - ts.startedAt;
      }
      turnContentBuffers.delete(sessionId);
      broadcast({ type: "error", text: err.message, sessionId });
      broadcast({ type: "turn_end", stopReason: "error", sessionId });
    } finally {
      processingSessions.delete(sessionId);
      drainQueue(sessionId);
    }
  }

  function drainQueue(sessionId: string) {
    const q = getQueue(sessionId);
    if (q.length === 0) return;

    // Drain ALL queued messages at once — combine into a single prompt
    const items = q.splice(0, q.length);
    for (const item of items) {
      log.info({ session: sid(sessionId), queueId: item.id, batchSize: items.length }, "queue: draining");
      broadcast({ type: "queue_drain_start", queueId: item.id, sessionId });
    }

    // Combine texts (newline-separated), merge images and files
    const combinedText = items.map((m) => m.text).filter(Boolean).join("\n\n");
    const combinedImages = items.flatMap((m) => m.images ?? []);
    const combinedFiles = items.flatMap((m) => m.files ?? []);
    processPrompt(
      sessionId,
      combinedText,
      combinedImages.length > 0 ? combinedImages : undefined,
      combinedFiles.length > 0 ? combinedFiles : undefined,
    );
  }

  function clearSessionQueue(sessionId: string | null) {
    if (!sessionId) return;
    messageQueues.delete(sessionId);
  }

  // ── Session title cache (for Haiku routing) ──
  const sessionTitleCache = new Map<string, string>();

  /** Use Haiku via the Claude Agent SDK to decide whether a message relates to the current session. */
  async function routeWithHaiku(messageText: string, sessionTitle: string | null): Promise<boolean> {
    if (!sessionTitle) return true; // untitled → stay in current session

    try {
      const t0 = performance.now();
      const q = query({
        prompt:
          `Session title: "${sessionTitle}"\nNew message: "${messageText.slice(0, 500)}"\n\n` +
          `Reply with ONLY "same" if the message relates to the current session topic, or "new" if it's a different topic that should start a fresh session.`,
        options: {
          systemPrompt:
            "You are a message router. Given a session title and a new user message, " +
            "determine if the message should continue in the same session or start a new one. " +
            'Reply with ONLY "same" or "new".',
          model: "claude-haiku-4-5-20251001",
          maxThinkingTokens: 0,
          maxTurns: 1,
          maxBudgetUsd: 0.01,
          tools: [],
          settingSources: [],
          mcpServers: {},
          hooks: {},
          persistSession: false,
          cwd: process.cwd(),
        },
      });

      let answer = "";
      for await (const message of q) {
        if (message.type === "result" && message.subtype === "success") {
          answer = message.result?.trim().toLowerCase() ?? "";
        }
      }

      const isSame = !answer.startsWith("new");
      log.info({ durationMs: Math.round(performance.now() - t0), answer, isSame }, "route: Haiku decision");
      return isSame;
    } catch (err: any) {
      log.warn({ err: err.message }, "route: Haiku SDK query failed, defaulting to same session");
      return true;
    }
  }

  // Coalesce concurrent broadcastSessions calls — if one is already in flight,
  // callers share the same promise instead of issuing parallel requests.
  let broadcastSessionsPromise: Promise<void> | null = null;
  let broadcastSessionsStartedAt = 0;

  async function broadcastSessions() {
    if (!acpConnection) return;
    // If a previous call is in-flight but has been running for >15s, it's stuck — discard it.
    if (broadcastSessionsPromise && Date.now() - broadcastSessionsStartedAt > 15_000) {
      log.warn("api: broadcastSessions stale promise (>15s), discarding");
      broadcastSessionsPromise = null;
    }
    if (broadcastSessionsPromise) {
      log.debug("api: broadcastSessions coalesced (reusing in-flight request)");
      return broadcastSessionsPromise;
    }

    broadcastSessionsStartedAt = Date.now();
    broadcastSessionsPromise = (async () => {
      const t0 = performance.now();
      log.info("api: sessions/list started");
      try {
        const result = await acpConnection!.connection.extMethod("sessions/list", {});
        const t1 = performance.now();
        const sessions = ((result as any).sessions ?? []).map((s: any) => ({
          sessionId: s.sessionId,
          title: s.title ?? null,
          updatedAt: s.updatedAt ?? null,
          created: s._meta?.created ?? null,
          messageCount: s._meta?.messageCount ?? 0,
          gitBranch: s._meta?.gitBranch ?? null,
          projectPath: s._meta?.projectPath ?? null,
          ...(s._meta?.children ? { children: s._meta.children } : {}),
          ...(s._meta?.teamName ? { teamName: s._meta.teamName } : {}),
          isLive: liveSessionIds.has(s.sessionId),
          ...(turnStates[s.sessionId] ? (() => {
            const ts = turnStates[s.sessionId];
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
              }),
            };
          })() : {}),
        }));
        // Update session title cache for Haiku routing
        for (const s of sessions) {
          if (s.title) sessionTitleCache.set(s.sessionId, s.title);
        }
        log.info({ durationMs: Math.round(t1 - t0), sessions: sessions.length, clients: clients.size }, "api: sessions/list completed");
        broadcast({ type: "sessions", sessions });
      } catch (err: any) {
        log.error({ durationMs: Math.round(performance.now() - t0), err: err.message }, "api: sessions/list error");
      }
    })();

    try {
      await broadcastSessionsPromise;
    } finally {
      broadcastSessionsPromise = null;
    }
  }

  const server = Bun.serve({
    port,

    async fetch(req, server) {
      const url = new URL(req.url);

      if (url.pathname === "/ws") {
        if (server.upgrade(req)) return undefined;
        log.error({ origin: req.headers.get("origin") ?? "unknown" }, "ws: WebSocket upgrade FAILED");
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // In production mode, serve built client assets
      const distDir = path.resolve(import.meta.dir, "../dist");
      const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
      const file = Bun.file(path.join(distDir, filePath));
      if (await file.exists()) {
        return new Response(file);
      }

      return new Response("Not found", { status: 404 });
    },

    websocket: {
      async open(ws) {
        const clientId = nextClientId++;
        const clientState: ClientState = { id: clientId, currentSessionId: null, connectedAt: performance.now() };
        clients.set(ws, clientState);
        const t0 = performance.now();

        const path = !acpConnection && !connectingPromise ? "first" : connectingPromise ? "waitMutex" : "rejoin";
        log.info({ client: clientId, total: clients.size, path, acpReady: !!acpConnection, defaultSession: sid(defaultSessionId), boot: bootMs() }, "ws: open");

        if (path === "first" || path === "waitMutex") {
          // Wait for the pre-warmed ACP connection (or trigger it if somehow not started).
          if (!connectingPromise && !acpConnection) prewarmAcpConnection();
          if (connectingPromise) {
            log.info({ client: clientId }, "ws: waiting for ACP connection");
            try {
              await connectingPromise;
              log.info({ client: clientId, durationMs: Math.round(performance.now() - t0) }, "ws: ACP connection ready");
            } catch (err: any) {
              log.error({ client: clientId, err: err.message }, "ws: ACP connection failed");
              try { ws.send(JSON.stringify({ type: "error", text: err.message })); } catch {}
              return;
            } finally {
              connectingPromise = null;
            }
          }

          // tmux-style: ask the ACP server for existing sessions — reuse an
          // empty one instead of creating a duplicate on every reconnect.
          if (!defaultSessionId) {
            try {
              const listT0 = performance.now();
              const result = await acpConnection!.connection.extMethod("sessions/list", {});
              const sessions = ((result as any).sessions ?? []) as any[];
              log.info({ client: clientId, durationMs: Math.round(performance.now() - listT0), count: sessions.length }, "ws: queried existing sessions");

              const emptySession = sessions.find((s: any) => (s._meta?.messageCount ?? 0) === 0);

              if (emptySession) {
                defaultSessionId = emptySession.sessionId;
                log.info({ client: clientId, session: sid(defaultSessionId) }, "ws: reusing empty session");
              } else {
                log.info({ client: clientId }, "ws: no empty session, creating new");
                const sessT0 = performance.now();
                const { sessionId } = await createNewSession(acpConnection!.connection, broadcast);
                log.info({ client: clientId, session: sid(sessionId), durationMs: Math.round(performance.now() - sessT0) }, "ws: new session created");
                defaultSessionId = sessionId;
                liveSessionIds.add(sessionId);
              }
              resolveFirstSession?.();
            } catch (err: any) {
              log.error({ client: clientId, err: err.message }, "ws: session setup failed");
              try { ws.send(JSON.stringify({ type: "error", text: err.message })); } catch {}
              return;
            }
          }

          const targetSession = defaultSessionId!;
          clientState.currentSessionId = targetSession;

          // tmux-style: send all state then activate the session
          try {
            const histResult = await acpConnection!.connection.extMethod("sessions/getHistory", { sessionId: targetSession });
            ws.send(JSON.stringify({ type: "session_history", sessionId: targetSession, entries: augmentHistoryWithTurnStats(targetSession, histResult.entries as unknown[]) }));
          } catch {}

          ws.send(JSON.stringify({ type: "session_switched", sessionId: targetSession, turnStatus: getTurnStatusSnapshot(targetSession) }));
          // Send state AFTER session_switched so messages land in the active session
          sendSessionMeta(ws, targetSession);
          sendTurnState(ws, targetSession);
          sendQueueState(ws, targetSession);
          log.info({ client: clientId, session: sid(targetSession), totalMs: Math.round(performance.now() - t0), boot: bootMs() }, "ws: ← session_switched");

          // Fire-and-forget: don't block the open handler waiting for session list
          broadcastSessions().catch(() => {});
        } else {
          // Re-joining client: wait for first session if needed, then send immediately
          try {
            if (!defaultSessionId) {
              log.info({ client: clientId }, "ws: waiting for first session");
              await firstSessionReady;
            }
            const targetSession = defaultSessionId!;
            clientState.currentSessionId = targetSession;

            // tmux-style: send all state then activate the session
            try {
              const histResult = await acpConnection!.connection.extMethod("sessions/getHistory", { sessionId: targetSession });
              ws.send(JSON.stringify({ type: "session_history", sessionId: targetSession, entries: augmentHistoryWithTurnStats(targetSession, histResult.entries as unknown[]) }));
            } catch {}

            ws.send(JSON.stringify({ type: "session_switched", sessionId: targetSession, turnStatus: getTurnStatusSnapshot(targetSession) }));
            // Send state AFTER session_switched so messages land in the active session
            sendSessionMeta(ws, targetSession);
            sendTurnState(ws, targetSession);
            sendQueueState(ws, targetSession);
            log.info({ client: clientId, session: sid(targetSession), totalMs: Math.round(performance.now() - t0), boot: bootMs() }, "ws: ← session_switched");
            broadcastSessions().catch((err) => log.error({ client: clientId, err: err.message }, "ws: broadcastSessions failed"));
          } catch (err: any) {
            log.error({ client: clientId, err: err.message }, "ws: open(rejoin) failed");
          }
        }
      },

      async message(ws, raw) {
        const msgT0 = performance.now();
        const msg = JSON.parse(
          typeof raw === "string" ? raw : new TextDecoder().decode(raw),
        );

        if (!acpConnection) {
          log.warn({ msgType: msg.type }, "ws: message received but no ACP connection");
          return;
        }

        const clientState = clients.get(ws);
        if (!clientState) {
          // Stale connection from before a hot reload — the clients Map was reset
          // but bun --hot preserved the WebSocket. Close it so the browser reconnects
          // and triggers the open handler on the fresh server instance.
          log.warn({ msgType: msg.type }, "ws: message from unknown client, closing stale connection");
          ws.close(4000, "Server reloaded");
          return;
        }
        const cid = clientState.id;

        switch (msg.type) {
          case "prompt": {
            if (!clientState.currentSessionId) {
              log.warn({ client: cid }, "ws: prompt but no currentSessionId");
              return;
            }
            const targetSession = clientState.currentSessionId;
            log.info({ client: cid, session: sid(targetSession), textLen: msg.text?.length ?? 0, images: msg.images?.length ?? 0, files: msg.files?.length ?? 0 }, "ws: → prompt");

            // Broadcast user message to all OTHER clients viewing this session
            // (the sender already has it locally via SEND_MESSAGE dispatch)
            const userMsgJson = JSON.stringify({
              type: "user_message",
              sessionId: targetSession,
              text: msg.text,
              images: msg.images,
              files: msg.files,
              queueId: msg.queueId,
            });
            for (const [otherWs, otherState] of clients) {
              if (otherWs !== ws && otherState.currentSessionId === targetSession) {
                try { otherWs.send(userMsgJson); } catch {}
              }
            }

            if (processingSessions.has(targetSession)) {
              // Enqueue the message for this specific session
              const queueId = msg.queueId || `sq-${++queueIdCounter}`;
              getQueue(targetSession).push({ id: queueId, text: msg.text, images: msg.images, files: msg.files, addedAt: Date.now() });
              log.info({ session: sid(targetSession), queueId, queueLen: getQueue(targetSession).length }, "queue: enqueued");
              broadcast({ type: "message_queued", queueId, sessionId: targetSession });
            } else {
              processPrompt(targetSession, msg.text, msg.images, msg.files);
            }
            break;
          }

          case "interrupt": {
            if (!clientState.currentSessionId) break;
            const intSession = clientState.currentSessionId;
            if (!processingSessions.has(intSession)) break;
            log.info({ client: cid, session: sid(intSession) }, "ws: → interrupt");
            try {
              acpConnection.webClient.cancelPermissions(intSession);
              await acpConnection.connection.cancel({ sessionId: intSession });
              log.info({ client: cid, session: sid(intSession) }, "ws: interrupt sent");
            } catch (err: any) {
              log.error({ client: cid, session: sid(intSession), err: err.message }, "ws: interrupt error");
            }
            break;
          }

          case "permission_response": {
            if (!acpConnection) break;
            log.info({ client: cid, requestId: msg.requestId, optionId: msg.optionId }, "ws: → permission_response");
            acpConnection.webClient.resolvePermission(msg.requestId, msg.optionId, msg.optionName || msg.optionId);
            break;
          }

          case "cancel_queued": {
            if (!clientState.currentSessionId) break;
            const q = getQueue(clientState.currentSessionId);
            const idx = q.findIndex((m) => m.id === msg.queueId);
            if (idx !== -1) {
              q.splice(idx, 1);
              log.info({ session: sid(clientState.currentSessionId), queueId: msg.queueId }, "queue: cancelled");
              broadcast({ type: "queue_cancelled", queueId: msg.queueId, sessionId: clientState.currentSessionId });
            }
            break;
          }

          case "new_session": {
            log.info({ client: cid }, "ws: → new_session");
            try {
              const t0 = performance.now();
              const { sessionId } = await createNewSession(acpConnection.connection, broadcast);
              log.info({ client: cid, session: sid(sessionId), durationMs: Math.round(performance.now() - t0) }, "api: newSession completed");
              defaultSessionId = sessionId;
              clientState.currentSessionId = sessionId;
              liveSessionIds.add(sessionId);
              // Send switch only to the requesting client
              ws.send(JSON.stringify({ type: "session_switched", sessionId, turnStatus: getTurnStatusSnapshot(sessionId) }));
              log.info({ client: cid, session: sid(sessionId) }, "ws: ← session_switched");
              // Refresh session lists in parallel (non-blocking)
              broadcastSessions().catch(() => {});
            } catch (err: any) {
              log.error({ client: cid, err: err.message }, "ws: new_session error");
              ws.send(JSON.stringify({ type: "error", text: err.message }));
            }
            break;
          }

          case "switch_session":
          case "resume_session": {
            log.info({ client: cid, msgType: msg.type, session: sid(msg.sessionId) }, "ws: → switch/resume_session");
            const t0 = performance.now();
            emitProto("send", { method: "sessions/switch", params: { sessionId: msg.sessionId } });
            try {
              log.info({ session: sid(msg.sessionId) }, "api: sessions/getHistory started");
              const result = await acpConnection.connection.extMethod("sessions/getHistory", { sessionId: msg.sessionId });
              const entryCount = (result.entries as unknown[])?.length ?? 0;
              log.info({ session: sid(msg.sessionId), durationMs: Math.round(performance.now() - t0), entries: entryCount }, "api: sessions/getHistory completed");
              clientState.currentSessionId = msg.sessionId;
              ws.send(JSON.stringify({ type: "session_history", sessionId: msg.sessionId, entries: augmentHistoryWithTurnStats(msg.sessionId, result.entries as unknown[]) }));
              ws.send(JSON.stringify({ type: "session_switched", sessionId: msg.sessionId, turnStatus: getTurnStatusSnapshot(msg.sessionId) }));
              sendSessionMeta(ws, msg.sessionId);
              sendTurnState(ws, msg.sessionId);
              sendQueueState(ws, msg.sessionId);
              // Fetch tasks for the switched session (fire-and-forget)
              acpConnection.connection.extMethod("tasks/list", { sessionId: msg.sessionId }).then((taskResult) => {
                const tasks = (taskResult.tasks as unknown[]) ?? [];
                if (tasks.length > 0) {
                  ws.send(JSON.stringify({ type: "tasks", sessionId: msg.sessionId, tasks }));
                }
              }).catch(() => {});
              log.info({ client: cid, session: sid(msg.sessionId), totalMs: Math.round(performance.now() - t0) }, "ws: ← session_switched");
            } catch (err: any) {
              log.error({ client: cid, msgType: msg.type, err: err.message, durationMs: Math.round(performance.now() - t0) }, "ws: switch/resume error");
              ws.send(JSON.stringify({ type: "error", text: `Failed to load session: ${err.message}` }));
            }
            break;
          }

          case "resume_subagent": {
            const compositeId = `${msg.parentSessionId}:subagent:${msg.agentId}`;
            log.info({ client: cid, parent: sid(msg.parentSessionId), agentId: msg.agentId }, "ws: → resume_subagent");
            const t0 = performance.now();
            emitProto("send", { method: "sessions/switch", params: { sessionId: compositeId, subagent: true } });
            try {
              log.info({ parent: sid(msg.parentSessionId), agentId: msg.agentId }, "api: sessions/getSubagentHistory started");
              const result = await acpConnection.connection.extMethod("sessions/getSubagentHistory", {
                sessionId: msg.parentSessionId,
                agentId: msg.agentId,
              });
              const entryCount = (result.entries as unknown[])?.length ?? 0;
              log.info({ durationMs: Math.round(performance.now() - t0), entries: entryCount }, "api: sessions/getSubagentHistory completed");
              clientState.currentSessionId = compositeId;
              ws.send(JSON.stringify({ type: "session_history", sessionId: compositeId, entries: augmentHistoryWithTurnStats(compositeId, result.entries as unknown[]) }));
              ws.send(JSON.stringify({ type: "session_switched", sessionId: compositeId, turnStatus: getTurnStatusSnapshot(compositeId) }));
              sendSessionMeta(ws, compositeId);
              sendTurnState(ws, compositeId);
              sendQueueState(ws, compositeId);
              log.info({ client: cid, session: sid(compositeId), totalMs: Math.round(performance.now() - t0) }, "ws: ← session_switched (subagent)");
            } catch (err: any) {
              log.error({ client: cid, err: err.message, durationMs: Math.round(performance.now() - t0) }, "ws: resume_subagent error");
              ws.send(JSON.stringify({ type: "error", text: `Failed to load subagent: ${err.message}` }));
            }
            break;
          }

          case "rename_session": {
            const { sessionId, title } = msg;
            log.info({ client: cid, session: sid(sessionId), title }, "ws: → rename_session");
            const t0 = performance.now();
            const renameResult = await acpConnection.connection.extMethod("sessions/rename", { sessionId, title });
            log.info({ session: sid(sessionId), durationMs: Math.round(performance.now() - t0), success: renameResult.success }, "api: sessions/rename completed");
            if (renameResult.success) {
              await broadcastSessions();
            }
            break;
          }

          case "delete_session": {
            log.info({ client: cid, session: sid(msg.sessionId) }, "ws: → delete_session");
            const t0 = performance.now();
            const deleteResult = await acpConnection.connection.extMethod("sessions/delete", { sessionId: msg.sessionId });
            const deletedIds = (deleteResult.deletedIds as string[]) ?? [msg.sessionId];
            log.info({ session: sid(msg.sessionId), durationMs: Math.round(performance.now() - t0), success: deleteResult.success, deletedCount: deletedIds.length }, "api: sessions/delete completed");
            if (deleteResult.success) {
              // Clean up all deleted sessions (parent + any teammate children)
              for (const id of deletedIds) {
                liveSessionIds.delete(id);
                clearSessionQueue(id);
                turnContentBuffers.delete(id);
                delete turnStates[id];
                sessionMetas.delete(id);
                // Clear currentSessionId for any client viewing a deleted session
                for (const [, cs] of clients) {
                  if (cs.currentSessionId === id) {
                    cs.currentSessionId = null;
                  }
                }
              }
              // Notify all clients about the deletion immediately so the merge-based
              // SESSIONS reducer won't re-add them from a stale broadcastSessions() result
              sendToAll(JSON.stringify({ type: "session_deleted", sessionIds: deletedIds }));
              await broadcastSessions();
            } else {
              await broadcastSessions();
            }
            log.info({ client: cid, totalMs: Math.round(performance.now() - t0) }, "ws: delete_session done");
            break;
          }

          case "get_commands": {
            log.info({ client: cid }, "ws: → get_commands");
            try {
              const t0 = performance.now();
              // Lazily resume the current session if not already live
              // (getAvailableCommands needs at least one active session with a query)
              const cmdSessionId = clientState.currentSessionId;
              if (cmdSessionId && !liveSessionIds.has(cmdSessionId)) {
                log.info({ client: cid, session: sid(cmdSessionId) }, "ws: resuming session for get_commands");
                await resumeSession(acpConnection.connection, cmdSessionId);
                liveSessionIds.add(cmdSessionId);
                broadcastSessions().catch(() => {});
              }
              const result = await acpConnection.connection.extMethod("sessions/getAvailableCommands", {});
              const cmdCount = (result.commands as unknown[])?.length ?? 0;
              log.info({ durationMs: Math.round(performance.now() - t0), commands: cmdCount }, "api: sessions/getAvailableCommands completed");
              // Extract model info from the result (getAvailableCommands fetches models lazily)
              const models = result.models as { availableModels?: { modelId: string; name?: string }[]; currentModelId?: string } | undefined;
              const currentModelId = models?.currentModelId;
              const currentModelName = models?.availableModels?.find((m) => m.modelId === currentModelId)?.name;
              ws.send(JSON.stringify({
                type: "commands",
                commands: result.commands,
                ...(models && {
                  models: models.availableModels?.map((m) => m.modelId) ?? [],
                  currentModel: currentModelName || currentModelId || null,
                }),
              }));
              // Update session meta so reconnecting clients get the model info
              if (models && clientState.currentSessionId) {
                const meta = getSessionMeta(clientState.currentSessionId);
                if (meta.sessionInfo) {
                  meta.sessionInfo.models = models.availableModels?.map((m) => m.modelId) ?? [];
                  (meta.sessionInfo as any).currentModel = currentModelName || currentModelId || null;
                }
              }
            } catch (err: any) {
              log.error({ client: cid, err: err.message }, "ws: get_commands error");
              ws.send(JSON.stringify({ type: "commands", commands: [] }));
            }
            break;
          }

          case "get_subagents": {
            log.info({ client: cid, session: sid(msg.sessionId) }, "ws: → get_subagents");
            try {
              const t0 = performance.now();
              const result = await acpConnection.connection.extMethod("sessions/getSubagents", {
                sessionId: msg.sessionId,
              });
              const childCount = (result.children as unknown[])?.length ?? 0;
              log.info({ session: sid(msg.sessionId), durationMs: Math.round(performance.now() - t0), children: childCount }, "api: sessions/getSubagents completed");
              ws.send(JSON.stringify({
                type: "session_subagents",
                sessionId: msg.sessionId,
                children: result.children,
              }));
            } catch (err: any) {
              log.error({ client: cid, session: sid(msg.sessionId), err: err.message }, "ws: get_subagents error");
            }
            break;
          }

          case "list_files": {
            log.info({ client: cid, query: msg.query ?? "" }, "ws: → list_files");
            try {
              const t0 = performance.now();
              const raw = execSync("git ls-files", { encoding: "utf-8", cwd: process.cwd(), maxBuffer: 1024 * 1024 });
              const gitMs = Math.round(performance.now() - t0);
              const query = (msg.query ?? "").toLowerCase();
              let files = raw.split("\n").filter(Boolean);
              if (query) {
                files = files.filter((f) => f.toLowerCase().includes(query));
              }
              files = files.slice(0, 50);
              ws.send(JSON.stringify({ type: "file_list", files, query: msg.query ?? "" }));
              log.info({ client: cid, gitMs, results: files.length, totalMs: Math.round(performance.now() - t0) }, "ws: ← file_list");
            } catch {
              ws.send(JSON.stringify({ type: "file_list", files: [], query: msg.query ?? "" }));
            }
            break;
          }

          case "list_sessions": {
            log.info({ client: cid }, "ws: → list_sessions");
            await broadcastSessions();
            break;
          }

          case "route_message": {
            if (!clientState.currentSessionId) {
              log.warn({ client: cid }, "ws: route_message but no currentSessionId");
              return;
            }
            const routeSession = clientState.currentSessionId;
            log.info({ client: cid, session: sid(routeSession), textLen: msg.text?.length ?? 0 }, "ws: → route_message");

            try {
              const sessionTitle = sessionTitleCache.get(routeSession) ?? null;
              const shouldContinue = await routeWithHaiku(msg.text, sessionTitle);

              if (shouldContinue) {
                // Route to current session
                log.info({ client: cid, session: sid(routeSession), route: "same" }, "ws: route_message → same session");
                ws.send(JSON.stringify({ type: "route_result", sessionId: routeSession, isNew: false }));

                // Broadcast user message to other clients viewing this session
                const userMsgJson = JSON.stringify({
                  type: "user_message",
                  sessionId: routeSession,
                  text: msg.text,
                  images: msg.images,
                  files: msg.files,
                  queueId: msg.queueId,
                });
                for (const [otherWs, otherState] of clients) {
                  if (otherWs !== ws && otherState.currentSessionId === routeSession) {
                    try { otherWs.send(userMsgJson); } catch {}
                  }
                }

                if (processingSessions.has(routeSession)) {
                  const queueId = msg.queueId || `sq-${++queueIdCounter}`;
                  getQueue(routeSession).push({ id: queueId, text: msg.text, images: msg.images, files: msg.files, addedAt: Date.now() });
                  log.info({ session: sid(routeSession), queueId, queueLen: getQueue(routeSession).length }, "queue: enqueued (routed)");
                  broadcast({ type: "message_queued", queueId, sessionId: routeSession });
                } else {
                  processPrompt(routeSession, msg.text, msg.images, msg.files);
                }
              } else {
                // Create a new session and route there
                log.info({ client: cid, session: sid(routeSession), route: "new" }, "ws: route_message → new session");
                const t0 = performance.now();
                const { sessionId: newSessionId } = await createNewSession(acpConnection.connection, broadcast);
                log.info({ client: cid, session: sid(newSessionId), durationMs: Math.round(performance.now() - t0) }, "api: newSession (routed) completed");
                clientState.currentSessionId = newSessionId;
                liveSessionIds.add(newSessionId);
                defaultSessionId = newSessionId;

                // Switch client to the new session
                ws.send(JSON.stringify({ type: "session_history", sessionId: newSessionId, entries: [] }));
                ws.send(JSON.stringify({ type: "session_switched", sessionId: newSessionId, turnStatus: null }));
                ws.send(JSON.stringify({ type: "route_result", sessionId: newSessionId, isNew: true }));

                broadcastSessions().catch(() => {});
                processPrompt(newSessionId, msg.text, msg.images, msg.files);
              }
            } catch (err: any) {
              log.error({ client: cid, err: err.message }, "ws: route_message error");
              // Fallback: route to current session
              ws.send(JSON.stringify({ type: "route_result", sessionId: routeSession, isNew: false }));
              processPrompt(routeSession, msg.text, msg.images, msg.files);
            }
            break;
          }

          default:
            log.warn({ client: cid, msgType: msg.type }, "ws: unknown message type");
        }
        const msgElapsed = performance.now() - msgT0;
        if (msgElapsed > 50) {
          log.warn({ client: cid, msgType: msg.type, durationMs: Math.round(msgElapsed) }, "ws: slow message handler");
        }
      },

      close(ws) {
        const clientState = clients.get(ws);
        const cid = clientState?.id ?? "?";
        const connDurationMs = clientState ? Math.round(performance.now() - clientState.connectedAt) : 0;
        clients.delete(ws);
        log.info({ client: cid, total: clients.size, session: sid(clientState?.currentSessionId), connDurationMs }, "ws: close");
        if (clients.size === 0) messageQueues.clear();
      },
    },
  });

  // Eagerly start the ACP connection so it's ready before the first client connects.
  prewarmAcpConnection().catch((err) => {
    log.error({ err: err.message }, "prewarm failed");
  });

  return server;
}
