import path from "node:path";
import { execSync } from "node:child_process";
import { createAcpConnection, createNewSession, resumeSession } from "./session.js";
import type { AcpConnection } from "./types.js";

export function startServer(port: number) {
  interface ClientState { currentSessionId: string | null }
  const clients = new Map<{ send: (data: string) => void }, ClientState>();
  const liveSessionIds = new Set<string>();

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

  function broadcast(msg: object) {
    const m = msg as any;
    // Determine which session this message belongs to
    const msgSessionId = m.sessionId ?? null;

    // ── Accumulate turn stats + track activity from streaming messages ──
    // (do this before filtering so stats accumulate even for background sessions)
    let activityChanged = false;
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

    // Send to clients — filter session-specific messages per client
    const json = JSON.stringify(msg);
    if (msgSessionId) {
      sendToSession(msgSessionId, json);
      // Send turn_activity update only when activity actually changed
      if (activityChanged) {
        const ts = turnStates[msgSessionId];
        sendToSession(msgSessionId, JSON.stringify({ type: "turn_activity", activity: ts.activity, detail: ts.activityDetail }));
      }
    } else {
      // Global message: send to all
      sendToAll(json);
    }
  }

  let acpConnection: AcpConnection | null = null;
  let connectingPromise: Promise<void> | null = null;

  async function processPrompt(sessionId: string, text: string, images?: Array<{ data: string; mimeType: string }>, files?: Array<{ path: string; name: string }>) {
    if (!acpConnection) return;
    processingSessions.add(sessionId);
    const promptT0 = performance.now();
    try {
      // Lazily resume the ACP session if not already live
      if (!liveSessionIds.has(sessionId)) {
        const resumeT0 = performance.now();
        await resumeSession(acpConnection.connection, sessionId);
        console.log(`[perf] processPrompt.resume ${sessionId.slice(0, 8)} ${(performance.now() - resumeT0).toFixed(0)}ms`);
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

      // Initialize turn state and broadcast turn_start
      const turnStartedAt = Date.now();
      turnStates[sessionId] = {
        status: "in_progress",
        startedAt: turnStartedAt,
        approxTokens: 0,
        thinkingDurationMs: 0,
        activity: "brewing",
      };
      broadcast({ type: "turn_start", startedAt: turnStartedAt, sessionId });

      const acpPromptT0 = performance.now();
      const result = await acpConnection.connection.prompt({
        sessionId,
        prompt,
      });
      console.log(`[perf] processPrompt.acpPrompt ${sessionId.slice(0, 8)} ${(performance.now() - acpPromptT0).toFixed(0)}ms`);

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
      console.log(`[perf] processPrompt.total ${sessionId.slice(0, 8)} broadcastSessions=${(performance.now() - sessionsT0).toFixed(0)}ms total=${(performance.now() - promptT0).toFixed(0)}ms`);
    } catch (err: any) {
      // Update turn state to error
      if (turnStates[sessionId]) {
        const ts = turnStates[sessionId];
        ts.status = "error";
        ts.endedAt = Date.now();
        ts.durationMs = Date.now() - ts.startedAt;
      }
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
    const next = q.shift()!;
    broadcast({ type: "queue_drain_start", queueId: next.id, sessionId });
    processPrompt(sessionId, next.text, next.images, next.files);
  }

  function clearSessionQueue(sessionId: string | null) {
    if (!sessionId) return;
    messageQueues.delete(sessionId);
  }

  // Coalesce concurrent broadcastSessions calls — if one is already in flight,
  // callers share the same promise instead of issuing parallel requests.
  let broadcastSessionsPromise: Promise<void> | null = null;

  async function broadcastSessions() {
    if (!acpConnection) return;
    if (broadcastSessionsPromise) return broadcastSessionsPromise;

    broadcastSessionsPromise = (async () => {
      const t0 = performance.now();
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
        }));
        broadcast({ type: "sessions", sessions });
        console.log(`[perf] broadcastSessions extMethod=${(t1 - t0).toFixed(0)}ms total=${(performance.now() - t0).toFixed(0)}ms count=${sessions.length}`);
      } catch (err: any) {
        console.error("Failed to list sessions:", err.message);
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
        const clientState: ClientState = { currentSessionId: null };
        clients.set(ws, clientState);
        const t0 = performance.now();

        if (!acpConnection && !connectingPromise) {
          // First connection: spawn server. Use a promise mutex so concurrent
          // WebSocket opens don't each spawn their own server process.
          connectingPromise = (async () => {
            acpConnection = await createAcpConnection(broadcast);
            const t1 = performance.now();
            const { sessionId } = await createNewSession(acpConnection.connection, broadcast);
            const t2 = performance.now();
            clientState.currentSessionId = sessionId;
            liveSessionIds.add(sessionId);
            await broadcastSessions();
            const t3 = performance.now();
            ws.send(JSON.stringify({ type: "session_switched", sessionId }));
            console.log(`[perf] open(first) createConn=${(t1 - t0).toFixed(0)}ms newSession=${(t2 - t1).toFixed(0)}ms broadcastSessions=${(t3 - t2).toFixed(0)}ms total=${(performance.now() - t0).toFixed(0)}ms`);
          })();
          try {
            await connectingPromise;
          } catch (err: any) {
            ws.send(JSON.stringify({ type: "error", text: err.message }));
          } finally {
            connectingPromise = null;
          }
        } else if (connectingPromise) {
          // Another connection arrived while the first is still initializing — wait for it.
          try {
            await connectingPromise;
          } catch {}
          // After mutex resolves, send current state to this new client
          await broadcastSessions();
        } else {
          // Re-joining client: send current state
          await broadcastSessions();
          const t1 = performance.now();
          console.log(`[perf] open(rejoin) broadcastSessions=${(t1 - t0).toFixed(0)}ms total=${(performance.now() - t0).toFixed(0)}ms`);
        }
      },

      async message(ws, raw) {
        const msgT0 = performance.now();
        const msg = JSON.parse(
          typeof raw === "string" ? raw : new TextDecoder().decode(raw),
        );

        if (!acpConnection) return;

        const clientState = clients.get(ws);
        if (!clientState) return;

        switch (msg.type) {
          case "prompt": {
            if (!clientState.currentSessionId) return;
            const targetSession = clientState.currentSessionId;
            if (processingSessions.has(targetSession)) {
              // Enqueue the message for this specific session
              const queueId = msg.queueId || `sq-${++queueIdCounter}`;
              getQueue(targetSession).push({ id: queueId, text: msg.text, images: msg.images, files: msg.files, addedAt: Date.now() });
              broadcast({ type: "message_queued", queueId, sessionId: targetSession });
            } else {
              processPrompt(targetSession, msg.text, msg.images, msg.files);
            }
            break;
          }

          case "cancel_queued": {
            if (!clientState.currentSessionId) break;
            const q = getQueue(clientState.currentSessionId);
            const idx = q.findIndex((m) => m.id === msg.queueId);
            if (idx !== -1) {
              q.splice(idx, 1);
              broadcast({ type: "queue_cancelled", queueId: msg.queueId, sessionId: clientState.currentSessionId });
            }
            break;
          }

          case "new_session": {
            try {
              const t0 = performance.now();
              const { sessionId } = await createNewSession(acpConnection.connection, broadcast);
              const t1 = performance.now();
              clientState.currentSessionId = sessionId;
              liveSessionIds.add(sessionId);
              // Send switch only to the requesting client
              ws.send(JSON.stringify({ type: "session_switched", sessionId }));
              console.log(`[perf] new_session createNewSession=${(t1 - t0).toFixed(0)}ms`);
              // Refresh session lists in parallel (non-blocking)
              broadcastSessions().catch(() => {});
            } catch (err: any) {
              ws.send(JSON.stringify({ type: "error", text: err.message }));
            }
            break;
          }

          case "switch_session":
          case "resume_session": {
            const t0 = performance.now();
            emitProto("send", { method: "sessions/switch", params: { sessionId: msg.sessionId } });
            try {
              const result = await acpConnection.connection.extMethod("sessions/getHistory", { sessionId: msg.sessionId });
              const t1 = performance.now();
              const entryCount = (result.entries as unknown[])?.length ?? 0;
              clientState.currentSessionId = msg.sessionId;
              ws.send(JSON.stringify({ type: "session_history", sessionId: msg.sessionId, entries: result.entries }));
              const t2 = performance.now();
              ws.send(JSON.stringify({ type: "session_switched", sessionId: msg.sessionId }));
              console.log(`[switch_session] ${msg.sessionId.slice(0, 8)} getHistory=${(t1 - t0).toFixed(0)}ms broadcast=${(t2 - t1).toFixed(0)}ms entries=${entryCount}`);
            } catch (err: any) {
              ws.send(JSON.stringify({ type: "error", text: `Failed to load session: ${err.message}` }));
            }
            break;
          }

          case "resume_subagent": {
            const compositeId = `${msg.parentSessionId}:subagent:${msg.agentId}`;
            const t0 = performance.now();
            emitProto("send", { method: "sessions/switch", params: { sessionId: compositeId, subagent: true } });
            try {
              const result = await acpConnection.connection.extMethod("sessions/getSubagentHistory", {
                sessionId: msg.parentSessionId,
                agentId: msg.agentId,
              });
              const t1 = performance.now();
              const entryCount = (result.entries as unknown[])?.length ?? 0;
              clientState.currentSessionId = compositeId;
              ws.send(JSON.stringify({ type: "session_history", sessionId: compositeId, entries: result.entries }));
              const t2 = performance.now();
              ws.send(JSON.stringify({ type: "session_switched", sessionId: compositeId }));
              console.log(`[resume_subagent] ${compositeId.slice(0, 8)} getHistory=${(t1 - t0).toFixed(0)}ms broadcast=${(t2 - t1).toFixed(0)}ms entries=${entryCount}`);
            } catch (err: any) {
              ws.send(JSON.stringify({ type: "error", text: `Failed to load subagent: ${err.message}` }));
            }
            break;
          }

          case "rename_session": {
            const { sessionId, title } = msg;
            const t0 = performance.now();
            const renameResult = await acpConnection.connection.extMethod("sessions/rename", { sessionId, title });
            const t1 = performance.now();
            if (renameResult.success) {
              await broadcastSessions();
            }
            console.log(`[perf] rename_session extMethod=${(t1 - t0).toFixed(0)}ms total=${(performance.now() - t0).toFixed(0)}ms`);
            break;
          }

          case "delete_session": {
            const t0 = performance.now();
            const deleteResult = await acpConnection.connection.extMethod("sessions/delete", { sessionId: msg.sessionId });
            const t1 = performance.now();
            if (deleteResult.success) {
              // Clean up all deleted sessions (parent + any teammate children)
              const deletedIds = (deleteResult.deletedIds as string[]) ?? [msg.sessionId];
              for (const id of deletedIds) {
                liveSessionIds.delete(id);
                clearSessionQueue(id);
                // Clear currentSessionId for any client viewing a deleted session
                for (const [, cs] of clients) {
                  if (cs.currentSessionId === id) {
                    cs.currentSessionId = null;
                  }
                }
              }
              await broadcastSessions();
            } else {
              await broadcastSessions();
            }
            console.log(`[perf] delete_session extMethod=${(t1 - t0).toFixed(0)}ms total=${(performance.now() - t0).toFixed(0)}ms deletedIds=${(deleteResult.deletedIds as string[])?.length ?? 0}`);
            break;
          }

          case "get_commands": {
            try {
              const t0 = performance.now();
              const result = await acpConnection.connection.extMethod("sessions/getAvailableCommands", {});
              const t1 = performance.now();
              ws.send(JSON.stringify({ type: "commands", commands: result.commands }));
              console.log(`[perf] get_commands extMethod=${(t1 - t0).toFixed(0)}ms`);
            } catch (err: any) {
              console.error("Failed to get commands:", err.message);
            }
            break;
          }

          case "get_subagents": {
            try {
              const t0 = performance.now();
              const result = await acpConnection.connection.extMethod("sessions/getSubagents", {
                sessionId: msg.sessionId,
              });
              const t1 = performance.now();
              ws.send(JSON.stringify({
                type: "session_subagents",
                sessionId: msg.sessionId,
                children: result.children,
              }));
              console.log(`[perf] get_subagents ${msg.sessionId.slice(0, 8)} extMethod=${(t1 - t0).toFixed(0)}ms`);
            } catch (err: any) {
              console.error("Failed to get subagents:", err.message);
            }
            break;
          }

          case "list_files": {
            try {
              const t0 = performance.now();
              const raw = execSync("git ls-files", { encoding: "utf-8", cwd: process.cwd(), maxBuffer: 1024 * 1024 });
              const t1 = performance.now();
              const query = (msg.query ?? "").toLowerCase();
              let files = raw.split("\n").filter(Boolean);
              if (query) {
                files = files.filter((f) => f.toLowerCase().includes(query));
              }
              files = files.slice(0, 50);
              ws.send(JSON.stringify({ type: "file_list", files, query: msg.query ?? "" }));
              console.log(`[perf] list_files git=${(t1 - t0).toFixed(0)}ms total=${(performance.now() - t0).toFixed(0)}ms results=${files.length}`);
            } catch {
              ws.send(JSON.stringify({ type: "file_list", files: [], query: msg.query ?? "" }));
            }
            break;
          }

          case "list_sessions": {
            await broadcastSessions();
            break;
          }
        }
        const msgElapsed = performance.now() - msgT0;
        if (msgElapsed > 50) {
          console.log(`[perf] ws.message(${msg.type}) ${msgElapsed.toFixed(0)}ms`);
        }
      },

      close(ws) {
        clients.delete(ws);
        if (clients.size === 0) messageQueues.clear();
      },
    },
  });

  return server;
}
