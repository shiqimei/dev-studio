import path from "node:path";
import { createAcpConnection, createNewSession, listSessions } from "./session.js";
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
            broadcast({ type: "session_switched", sessionId: currentSessionId });
          } catch (err: any) {
            ws.send(JSON.stringify({ type: "error", text: err.message }));
          }
        } else {
          // Re-joining client: send current state
          await broadcastSessionList();
          if (currentSessionId) {
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
              broadcast({ type: "session_switched", sessionId: currentSessionId });
            } catch (err: any) {
              broadcast({ type: "error", text: err.message });
            }
            break;
          }

          case "resume_session": {
            if (msg.sessionId === currentSessionId) break;
            // Sessions are already alive on the agent — just switch routing.
            // No need to call unstable_resumeSession (which spawns a new subprocess).
            currentSessionId = msg.sessionId;
            broadcast({ type: "session_switched", sessionId: currentSessionId });
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
