import path from "node:path";
import { createAcpConnection, createNewSession, listSessions, resumeSession } from "./session.js";
import type { AcpConnection } from "./types.js";

export function startServer(port: number) {
  const clients = new Set<{ send: (data: string) => void }>();
  let currentSessionId: string | null = null;
  const liveSessionIds = new Set<string>();

  function broadcast(msg: object) {
    // Filter out session-specific updates that don't match the current session
    const m = msg as any;
    if (m.sessionId && m.sessionId !== currentSessionId) return;
    const data = JSON.stringify(msg);
    for (const ws of clients) {
      try {
        ws.send(data);
      } catch {}
    }
  }

  let acpConnection: AcpConnection | null = null;

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
    const data = JSON.stringify({ type: "disk_sessions", sessions });
    for (const ws of clients) {
      try {
        ws.send(data);
      } catch {}
    }
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

        switch (msg.type) {
          case "prompt": {
            if (!currentSessionId) return;
            try {
              // Lazily resume the ACP session if not already live
              if (!liveSessionIds.has(currentSessionId)) {
                await resumeSession(acpConnection.connection, currentSessionId);
                liveSessionIds.add(currentSessionId);
                await broadcastSessionList();
              }
              const prompt: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [];
              if (msg.text) prompt.push({ type: "text", text: msg.text });
              for (const img of msg.images ?? []) {
                prompt.push({ type: "image", data: img.data, mimeType: img.mimeType });
              }
              if (prompt.length === 0) return;
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
            }
            break;
          }

          case "new_session": {
            try {
              const { sessionId } = await createNewSession(acpConnection.connection, broadcast);
              currentSessionId = sessionId;
              liveSessionIds.add(sessionId);
              await broadcastSessionList();
              await broadcastDiskSessions();
              broadcast({ type: "session_switched", sessionId: currentSessionId });
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

          case "list_sessions": {
            await broadcastSessionList();
            break;
          }
        }
      },

      close(ws) {
        clients.delete(ws);
      },
    },
  });

  return server;
}
