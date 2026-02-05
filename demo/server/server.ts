import path from "node:path";
import { createAcpConnection, createNewSession, listSessions } from "./session.js";
import type { AcpConnection } from "./types.js";

export function startServer(port: number) {
  const clients = new Set<{ send: (data: string) => void }>();

  function broadcast(msg: object) {
    const data = JSON.stringify(msg);
    for (const ws of clients) {
      try {
        ws.send(data);
      } catch {}
    }
  }

  let acpConnection: AcpConnection | null = null;
  let currentSessionId: string | null = null;

  async function broadcastSessionList() {
    if (!acpConnection) return;
    try {
      const { sessions } = await listSessions(acpConnection.connection);
      broadcast({ type: "session_list", sessions });
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
              const result = await acpConnection.connection.prompt({
                sessionId: currentSessionId,
                prompt: [{ type: "text", text: msg.text }],
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
