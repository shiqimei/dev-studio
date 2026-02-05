import fs from "node:fs";
import os from "node:os";
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

  function readDiskSessions() {
    const indexPath = path.join(getProjectDir(), "sessions-index.json");
    try {
      const raw = fs.readFileSync(indexPath, "utf-8");
      const index = JSON.parse(raw) as {
        entries: Array<{
          sessionId: string;
          firstPrompt?: string;
          created?: string;
          modified?: string;
          messageCount?: number;
          gitBranch?: string;
          isSidechain?: boolean;
        }>;
      };
      return index.entries
        .filter((e) => !e.isSidechain)
        .map((e) => ({
          sessionId: e.sessionId,
          title: e.firstPrompt?.slice(0, 100) ?? null,
          updatedAt: e.modified ?? e.created ?? null,
          created: e.created ?? null,
          messageCount: e.messageCount ?? 0,
          gitBranch: e.gitBranch ?? null,
        }))
        .sort((a, b) => {
          const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
          const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
          return tb - ta;
        });
    } catch {
      return [];
    }
  }

  function getProjectDir() {
    const configDir = process.env.CLAUDE ?? path.join(os.homedir(), ".claude");
    const cwd = process.env.ACP_CWD || process.cwd();
    return path.join(configDir, "projects", cwd.replace(/\//g, "-"));
  }

  function readSessionHistory(sessionId: string) {
    const jsonlPath = path.join(getProjectDir(), `${sessionId}.jsonl`);
    try {
      const raw = fs.readFileSync(jsonlPath, "utf-8");
      const lines = raw.split("\n").filter(Boolean);
      const messages: Array<{ role: "user" | "assistant"; text: string }> = [];

      for (const line of lines) {
        const entry = JSON.parse(line);
        if (entry.type === "user" && entry.message?.content) {
          const content = entry.message.content;
          let text: string;
          if (typeof content === "string") {
            text = content;
          } else if (Array.isArray(content)) {
            text = content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join("\n");
          } else {
            continue;
          }
          if (text && !entry.isMeta) {
            messages.push({ role: "user", text });
          }
        } else if (entry.type === "assistant" && entry.message?.content) {
          const content = entry.message.content;
          if (!Array.isArray(content)) continue;
          const textParts = content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("\n");
          if (textParts) {
            messages.push({ role: "assistant", text: textParts });
          }
        }
      }

      return messages;
    } catch {
      return [];
    }
  }

  function broadcastDiskSessions() {
    const sessions = readDiskSessions();
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
            broadcastDiskSessions();
            broadcast({ type: "session_switched", sessionId: currentSessionId });
          } catch (err: any) {
            ws.send(JSON.stringify({ type: "error", text: err.message }));
          }
        } else {
          // Re-joining client: send current state
          await broadcastSessionList();
          broadcastDiskSessions();
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
              broadcastDiskSessions();
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
              broadcastDiskSessions();
              broadcast({ type: "session_switched", sessionId: currentSessionId });
            } catch (err: any) {
              broadcast({ type: "error", text: err.message });
            }
            break;
          }

          case "resume_session": {
            if (msg.sessionId === currentSessionId) break;
            currentSessionId = msg.sessionId;
            // Load conversation history from ~/.claude session file
            const history = readSessionHistory(msg.sessionId);
            broadcast({ type: "session_history", sessionId: msg.sessionId, messages: history });
            broadcast({ type: "session_switched", sessionId: currentSessionId });
            // Resume non-live sessions via ACP so the user can continue chatting
            if (!liveSessionIds.has(msg.sessionId)) {
              try {
                await resumeSession(acpConnection.connection, msg.sessionId);
                liveSessionIds.add(msg.sessionId);
                await broadcastSessionList();
              } catch (err: any) {
                broadcast({ type: "error", text: `Failed to resume session: ${err.message}` });
              }
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
