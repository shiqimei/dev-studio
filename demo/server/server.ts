import path from "node:path";
import { createAcpConnection, createNewSession, listSessions, resumeSession } from "./session.js";
import type { AcpConnection } from "./types.js";
import { getProjectDir } from "../../src/disk/paths.js";
import { readSessionsIndex } from "../../src/disk/sessions-index.js";
import { readSessionHistoryFull, readSubagentHistoryFull } from "../../src/disk/session-history.js";
import { readSubagents } from "../../src/disk/subagents.js";

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

  const projectDir = getProjectDir();

  function readDiskSessions() {
    const entries = readSessionsIndex(projectDir);
    return entries
      .map((e) => {
        const subagents = readSubagents(projectDir, e.sessionId);
        const children = subagents.map((s) => ({
          agentId: s.agentId,
          taskPrompt: s.taskPrompt,
          timestamp: s.timestamp,
          agentType: s.agentType,
        }));
        return {
          sessionId: e.sessionId,
          title: e.firstPrompt?.slice(0, 100) ?? null,
          updatedAt: e.modified ?? e.created ?? null,
          created: e.created ?? null,
          messageCount: e.messageCount ?? 0,
          gitBranch: e.gitBranch ?? null,
          ...(children.length > 0 ? { children } : {}),
        };
      })
      .sort((a, b) => {
        const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        return tb - ta;
      });
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
            // Load full conversation history from ~/.claude session JSONL file
            const entries = readSessionHistoryFull(projectDir, msg.sessionId);
            broadcast({ type: "session_history", sessionId: msg.sessionId, entries });
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

          case "resume_subagent": {
            const compositeId = `${msg.parentSessionId}:subagent:${msg.agentId}`;
            currentSessionId = compositeId;
            const entries = readSubagentHistoryFull(projectDir, msg.parentSessionId, msg.agentId);
            broadcast({ type: "session_history", sessionId: compositeId, entries });
            broadcast({ type: "session_switched", sessionId: compositeId });
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
