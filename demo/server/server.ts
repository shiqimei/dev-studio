import path from "node:path";
import { execSync } from "node:child_process";
import { createAcpConnection, createNewSession, resumeSession } from "./session.js";
import type { AcpConnection } from "./types.js";

export function startServer(port: number) {
  const clients = new Set<{ send: (data: string) => void }>();
  let currentSessionId: string | null = null;
  const liveSessionIds = new Set<string>();

  // ── Turn state (server-side, survives client disconnect/reconnect) ──
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
  }
  const turnStates: Record<string, TurnState> = {};

  // ── Message queue (per-session) ──
  type QueuedMessage = { id: string; text: string; images?: Array<{ data: string; mimeType: string }>; files?: Array<{ path: string; name: string }>; addedAt: number };
  const messageQueues = new Map<string, QueuedMessage[]>();
  let processingPrompt = false;
  let queueIdCounter = 0;

  function getQueue(sessionId: string | null): QueuedMessage[] {
    if (!sessionId) return [];
    let q = messageQueues.get(sessionId);
    if (!q) { q = []; messageQueues.set(sessionId, q); }
    return q;
  }

  // Low-level: send raw string to all WS clients (no filtering, no instrumentation)
  function sendToAll(data: string) {
    for (const ws of clients) {
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
    turn_end:             "session/turnEnd",
    error:                "app/error",
    system:               "app/system",
    message_queued:       "queue/enqueue",
    queue_drain_start:    "queue/drainStart",
    queue_cancelled:      "queue/cancelled",
  };

  function broadcast(msg: object) {
    const m = msg as any;
    // Filter out session-specific updates that don't match the current session
    if (m.sessionId && m.sessionId !== currentSessionId) return;

    // ── Accumulate turn stats from streaming messages ──
    if (currentSessionId && turnStates[currentSessionId]?.status === "in_progress") {
      const ts = turnStates[currentSessionId];
      if (m.type === "text" && m.text) {
        ts.approxTokens += Math.ceil(m.text.length / 4);
      } else if (m.type === "thought" && m.text) {
        ts.approxTokens += Math.ceil(m.text.length / 4);
        const now = Date.now();
        if (ts.thinkingLastChunkAt) {
          ts.thinkingDurationMs += now - ts.thinkingLastChunkAt;
        }
        ts.thinkingLastChunkAt = now;
      } else if (m.type !== "thought" && ts.thinkingLastChunkAt) {
        // Thinking ended — finalize the last thinking interval
        ts.thinkingDurationMs += Date.now() - ts.thinkingLastChunkAt;
        ts.thinkingLastChunkAt = undefined;
      }
    }

    // Emit proto entry for server-originated events (not ACP relays)
    const method = m.type && SERVER_EVENT_MAP[m.type];
    if (method) {
      emitProto("recv", { method, params: m });
    }

    sendToAll(JSON.stringify(msg));
  }

  let acpConnection: AcpConnection | null = null;

  async function processPrompt(text: string, images?: Array<{ data: string; mimeType: string }>, files?: Array<{ path: string; name: string }>) {
    if (!acpConnection || !currentSessionId) return;
    processingPrompt = true;
    try {
      // Lazily resume the ACP session if not already live
      if (!liveSessionIds.has(currentSessionId)) {
        await resumeSession(acpConnection.connection, currentSessionId);
        liveSessionIds.add(currentSessionId);
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
      if (prompt.length === 0) { processingPrompt = false; drainQueue(); return; }

      // Initialize turn state and broadcast turn_start
      const turnStartedAt = Date.now();
      turnStates[currentSessionId] = {
        status: "in_progress",
        startedAt: turnStartedAt,
        approxTokens: 0,
        thinkingDurationMs: 0,
      };
      broadcast({ type: "turn_start", startedAt: turnStartedAt });

      const result = await acpConnection.connection.prompt({
        sessionId: currentSessionId,
        prompt,
      });

      // Extract stats from result metadata
      const meta = (result as any)._meta?.claudeCode;
      const turnState = turnStates[currentSessionId];
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
        stopReason: result.stopReason,
        durationMs: turnState?.durationMs,
        outputTokens: turnState?.outputTokens,
        thinkingDurationMs: turnState?.thinkingDurationMs,
        costUsd: turnState?.costUsd,
      });
      // Refresh session list to pick up title changes
      await broadcastSessions();
    } catch (err: any) {
      // Update turn state to error
      if (currentSessionId && turnStates[currentSessionId]) {
        const ts = turnStates[currentSessionId];
        ts.status = "error";
        ts.endedAt = Date.now();
        ts.durationMs = Date.now() - ts.startedAt;
      }
      broadcast({ type: "error", text: err.message });
      broadcast({ type: "turn_end", stopReason: "error" });
    } finally {
      processingPrompt = false;
      drainQueue();
    }
  }

  function drainQueue() {
    if (!currentSessionId) return;
    const q = getQueue(currentSessionId);
    if (q.length === 0) return;
    const next = q.shift()!;
    broadcast({ type: "queue_drain_start", queueId: next.id });
    processPrompt(next.text, next.images, next.files);
  }

  function clearSessionQueue(sessionId: string | null) {
    if (!sessionId) return;
    messageQueues.delete(sessionId);
  }

  async function broadcastSessions() {
    if (!acpConnection) return;
    try {
      const result = await acpConnection.connection.extMethod("sessions/list", {});
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
    } catch (err: any) {
      console.error("Failed to list sessions:", err.message);
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
        clients.add(ws);

        if (!acpConnection) {
          try {
            acpConnection = await createAcpConnection(broadcast);
            const { sessionId } = await createNewSession(acpConnection.connection, broadcast);
            currentSessionId = sessionId;
            liveSessionIds.add(sessionId);
            await broadcastSessions();
            broadcast({ type: "session_switched", sessionId: currentSessionId });
          } catch (err: any) {
            ws.send(JSON.stringify({ type: "error", text: err.message }));
          }
        } else {
          // Re-joining client: send current state
          await broadcastSessions();
          if (currentSessionId) {
            // Send session history so the reconnecting client can display content
            try {
              const subMatch = currentSessionId.match(/^(.+):subagent:(.+)$/);
              const result = subMatch
                ? await acpConnection.connection.extMethod("sessions/getSubagentHistory", { sessionId: subMatch[1], agentId: subMatch[2] })
                : await acpConnection.connection.extMethod("sessions/getHistory", { sessionId: currentSessionId });
              ws.send(JSON.stringify({ type: "session_history", sessionId: currentSessionId, entries: result.entries }));
            } catch (err: any) {
              console.error("Failed to load session history for reconnecting client:", err.message);
            }
            broadcast({ type: "session_switched", sessionId: currentSessionId });

            // Send current turn state so reconnecting client can restore status bar
            const ts = turnStates[currentSessionId];
            if (ts) {
              if (ts.status === "in_progress") {
                ws.send(JSON.stringify({ type: "turn_start", startedAt: ts.startedAt }));
              } else if (ts.status === "completed" || ts.status === "error") {
                ws.send(JSON.stringify({
                  type: "turn_end",
                  stopReason: ts.status === "error" ? "error" : "end_turn",
                  durationMs: ts.durationMs,
                  outputTokens: ts.outputTokens,
                  thinkingDurationMs: ts.thinkingDurationMs,
                  costUsd: ts.costUsd,
                }));
              }
            }
          }
        }
      },

      async message(ws, raw) {
        const msg = JSON.parse(
          typeof raw === "string" ? raw : new TextDecoder().decode(raw),
        );

        if (!acpConnection) return;

        switch (msg.type) {
          case "prompt": {
            if (!currentSessionId) return;
            if (processingPrompt) {
              // Enqueue the message for the current session
              const queueId = msg.queueId || `sq-${++queueIdCounter}`;
              getQueue(currentSessionId).push({ id: queueId, text: msg.text, images: msg.images, files: msg.files, addedAt: Date.now() });
              broadcast({ type: "message_queued", queueId });
            } else {
              processPrompt(msg.text, msg.images, msg.files);
            }
            break;
          }

          case "cancel_queued": {
            if (!currentSessionId) break;
            const q = getQueue(currentSessionId);
            const idx = q.findIndex((m) => m.id === msg.queueId);
            if (idx !== -1) {
              q.splice(idx, 1);
              broadcast({ type: "queue_cancelled", queueId: msg.queueId });
            }
            break;
          }

          case "new_session": {
            try {
              const { sessionId } = await createNewSession(acpConnection.connection, broadcast);
              currentSessionId = sessionId;
              liveSessionIds.add(sessionId);
              // Send switch immediately — client adds a placeholder sidebar entry
              broadcast({ type: "session_switched", sessionId: currentSessionId });
              // Refresh session lists in parallel (non-blocking)
              broadcastSessions().catch(() => {});
            } catch (err: any) {
              broadcast({ type: "error", text: err.message });
            }
            break;
          }

          case "switch_session":
          case "resume_session": {
            try {
              const result = await acpConnection.connection.extMethod("sessions/getHistory", { sessionId: msg.sessionId });
              currentSessionId = msg.sessionId;
              broadcast({ type: "session_history", sessionId: msg.sessionId, entries: result.entries });
              broadcast({ type: "session_switched", sessionId: currentSessionId });
            } catch (err: any) {
              broadcast({ type: "error", text: `Failed to load session: ${err.message}` });
            }
            break;
          }

          case "resume_subagent": {
            const compositeId = `${msg.parentSessionId}:subagent:${msg.agentId}`;
            try {
              const result = await acpConnection.connection.extMethod("sessions/getSubagentHistory", {
                sessionId: msg.parentSessionId,
                agentId: msg.agentId,
              });
              currentSessionId = compositeId;
              broadcast({ type: "session_history", sessionId: compositeId, entries: result.entries });
              broadcast({ type: "session_switched", sessionId: compositeId });
            } catch (err: any) {
              broadcast({ type: "error", text: `Failed to load subagent: ${err.message}` });
            }
            break;
          }

          case "rename_session": {
            const { sessionId, title } = msg;
            console.log(`[rename_session] Renaming session ${sessionId} to "${title}"`);
            const renameResult = await acpConnection.connection.extMethod("sessions/rename", { sessionId, title });
            if (renameResult.success) {
              await broadcastSessions();
            }
            break;
          }

          case "delete_session": {
            console.log(`[delete_session] Deleting session ${msg.sessionId}`);
            const deleteResult = await acpConnection.connection.extMethod("sessions/delete", { sessionId: msg.sessionId });
            console.log(`[delete_session] Result: ${deleteResult.success}, deletedIds: ${(deleteResult.deletedIds as string[])?.join(", ")}`);
            if (deleteResult.success) {
              // Clean up all deleted sessions (parent + any teammate children)
              const deletedIds = (deleteResult.deletedIds as string[]) ?? [msg.sessionId];
              for (const id of deletedIds) {
                liveSessionIds.delete(id);
                clearSessionQueue(id);
                if (currentSessionId === id) {
                  currentSessionId = null;
                }
              }
              await broadcastSessions();
            } else {
              // Session not found in index — still refresh the list in case it was already gone
              await broadcastSessions();
            }
            break;
          }

          case "list_files": {
            try {
              const raw = execSync("git ls-files", { encoding: "utf-8", cwd: process.cwd(), maxBuffer: 1024 * 1024 });
              const query = (msg.query ?? "").toLowerCase();
              let files = raw.split("\n").filter(Boolean);
              if (query) {
                files = files.filter((f) => f.toLowerCase().includes(query));
              }
              files = files.slice(0, 50);
              ws.send(JSON.stringify({ type: "file_list", files, query: msg.query ?? "" }));
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
      },

      close(ws) {
        clients.delete(ws);
        if (clients.size === 0) messageQueues.clear();
      },
    },
  });

  return server;
}
