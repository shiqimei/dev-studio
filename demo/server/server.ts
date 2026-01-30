import path from "node:path";
import { createAcpSession } from "./session.js";
import type { AcpSession } from "./types.js";

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

  let acpSession: AcpSession | null = null;

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

        if (!acpSession) {
          try {
            acpSession = await createAcpSession(broadcast);
          } catch (err: any) {
            ws.send(JSON.stringify({ type: "error", text: err.message }));
          }
        }
      },

      async message(ws, raw) {
        const msg = JSON.parse(
          typeof raw === "string" ? raw : new TextDecoder().decode(raw),
        );

        if (msg.type === "prompt" && acpSession) {
          try {
            const result = await acpSession.connection.prompt({
              sessionId: acpSession.sessionId,
              prompt: [{ type: "text", text: msg.text }],
            });
            broadcast({ type: "turn_end", stopReason: result.stopReason });
          } catch (err: any) {
            broadcast({ type: "error", text: err.message });
            broadcast({ type: "turn_end", stopReason: "error" });
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
