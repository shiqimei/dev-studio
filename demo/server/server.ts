import path from "node:path";
import { execSync } from "node:child_process";
import { createAcpConnection, createNewSession, listSessions, resumeSession } from "./session.js";
import type { AcpConnection } from "./types.js";

export function startServer(port: number) {
  const clients = new Set<{ send: (data: string) => void }>();
  let currentSessionId: string | null = null;
  const liveSessionIds = new Set<string>();

  // ── Message queue ──
  let messageQueue: Array<{ id: string; text: string; images?: Array<{ data: string; mimeType: string }>; files?: Array<{ path: string; name: string }>; addedAt: number }> = [];
  let processingPrompt = false;
  let queueIdCounter = 0;

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

  // Map WS message types to functionality-scoped method names for the debug panel
  const WS_METHOD_MAP: Record<string, string> = {
    // Incoming (frontend → server)
    prompt:           "session/prompt",
    new_session:      "sessions/new",
    switch_session:   "sessions/switch",
    resume_session:   "sessions/resume",
    resume_subagent:  "sessions/resumeSubagent",
    rename_session:   "sessions/rename",
    delete_session:   "sessions/delete",
    list_sessions:    "sessions/list",
    cancel_queued:    "queue/cancel",
    list_files:       "files/search",
    // Outgoing (server → frontend)
    message_queued:   "queue/enqueue",
    queue_drain_start:"queue/drainStart",
    queue_cancelled:  "queue/cancelled",
    session_switched: "sessions/switched",
    session_list:     "sessions/list",
    disk_sessions:    "sessions/disk",
    session_info:     "sessions/info",
    session_history:  "sessions/history",
    turn_end:         "session/turnEnd",
    error:            "app/error",
    system:           "app/system",
  };
  function wsMethod(type: string): string {
    return WS_METHOD_MAP[type] ?? `app/${type.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())}`;
  }

  const WS_NOISY = new Set(["text", "thought", "protocol"]);

  function broadcast(msg: object) {
    // Filter out session-specific updates that don't match the current session
    const m = msg as any;
    if (m.sessionId && m.sessionId !== currentSessionId) return;

    // Instrument outgoing app messages (skip noisy streaming + protocol entries)
    if (m.type && !WS_NOISY.has(m.type)) {
      emitProto("recv", { method: wsMethod(m.type), params: m });
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
        await broadcastSessionList();
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
      const result = await acpConnection.connection.prompt({
        sessionId: currentSessionId,
        prompt,
      });
      broadcast({ type: "turn_end", stopReason: result.stopReason });
      // Refresh session list to pick up title changes
      await broadcastSessionList();
      await broadcastDiskSessions();
    } catch (err: any) {
      broadcast({ type: "error", text: err.message });
      broadcast({ type: "turn_end", stopReason: "error" });
    } finally {
      processingPrompt = false;
      drainQueue();
    }
  }

  function drainQueue() {
    if (messageQueue.length === 0) return;
    const next = messageQueue.shift()!;
    broadcast({ type: "queue_drain_start", queueId: next.id });
    processPrompt(next.text, next.images, next.files);
  }

  function clearQueue() {
    messageQueue = [];
    queueIdCounter = 0;
  }

  async function readDiskSessions() {
    if (!acpConnection) return [];
    try {
      const result = await acpConnection.connection.extMethod("sessions/listDisk", {});
      return result.sessions as any[];
    } catch (err: any) {
      console.error("Failed to read disk sessions via ACP:", err.message);
      return [];
    }
  }

  async function broadcastDiskSessions() {
    const sessions = await readDiskSessions();
    broadcast({ type: "disk_sessions", sessions });
  }

  async function broadcastSessionList() {
    if (!acpConnection) return;
    try {
      const { sessions } = await listSessions(acpConnection.connection);
      const enriched = sessions.map((s) => ({
        ...s,
        isLive: liveSessionIds.has(s.sessionId),
      }));
      broadcast({ type: "session_list", sessions: enriched });
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
            await broadcastSessionList();
            await broadcastDiskSessions();
            broadcast({ type: "session_switched", sessionId: currentSessionId });
          } catch (err: any) {
            ws.send(JSON.stringify({ type: "error", text: err.message }));
          }
        } else {
          // Re-joining client: send current state
          await broadcastSessionList();
          await broadcastDiskSessions();
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
          }
        }
      },

      async message(ws, raw) {
        const msg = JSON.parse(
          typeof raw === "string" ? raw : new TextDecoder().decode(raw),
        );

        if (!acpConnection) return;

        emitProto("send", { method: wsMethod(msg.type), params: msg });

        switch (msg.type) {
          case "prompt": {
            if (!currentSessionId) return;
            if (processingPrompt) {
              // Enqueue the message
              const queueId = msg.queueId || `sq-${++queueIdCounter}`;
              messageQueue.push({ id: queueId, text: msg.text, images: msg.images, files: msg.files, addedAt: Date.now() });
              broadcast({ type: "message_queued", queueId });
            } else {
              processPrompt(msg.text, msg.images, msg.files);
            }
            break;
          }

          case "cancel_queued": {
            const idx = messageQueue.findIndex((m) => m.id === msg.queueId);
            if (idx !== -1) {
              messageQueue.splice(idx, 1);
              broadcast({ type: "queue_cancelled", queueId: msg.queueId });
            }
            break;
          }

          case "new_session": {
            clearQueue();
            try {
              const { sessionId } = await createNewSession(acpConnection.connection, broadcast);
              currentSessionId = sessionId;
              liveSessionIds.add(sessionId);
              broadcast({ type: "session_switched", sessionId: currentSessionId });
              await broadcastSessionList();
              await broadcastDiskSessions();
            } catch (err: any) {
              broadcast({ type: "error", text: err.message });
            }
            break;
          }

          case "switch_session":
          case "resume_session": {
            clearQueue();
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
            clearQueue();
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
              await broadcastDiskSessions();
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
                if (currentSessionId === id) {
                  currentSessionId = null;
                }
              }
              await broadcastDiskSessions();
              await broadcastSessionList();
            } else {
              // Session not found in index — still refresh the list in case it was already gone
              await broadcastDiskSessions();
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
            await broadcastSessionList();
            break;
          }
        }
      },

      close(ws) {
        clients.delete(ws);
        if (clients.size === 0) clearQueue();
      },
    },
  });

  return server;
}
