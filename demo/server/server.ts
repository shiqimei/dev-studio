import path from "node:path";
import { execSync } from "node:child_process";
import { getOrCreateDaemon } from "./daemon.js";
import type { AgentsDaemon } from "./daemon-types.js";
import { log, bootMs } from "./log.js";
import type { KanbanOp } from "./kanban.js";
import * as kanbanDb from "./kanban-db.js";

export function startServer(port: number) {
  // ── Initialize SQLite DB synchronously before serving requests ──
  try {
    kanbanDb.init();
    kanbanDb.migrateProjectsFromJson();
    kanbanDb.seedProjectsFromCwd();
  } catch (err: any) {
    log.warn({ err: err.message }, "db: early init error");
  }

  // ── Get or create the daemon (survives HMR via globalThis) ──
  const daemon = getOrCreateDaemon();

  // ── Client tracking (ephemeral, rebuilt on each HMR reload) ──
  let nextClientId = 1;

  interface PreflightRouteCache {
    text: string;
    sessionId: string;
    isSameSession: boolean;
    timestamp: number;
  }

  interface ClientState {
    id: number;
    currentSessionId: string | null;
    connectedAt: number;
    preflightCache?: PreflightRouteCache;
    preflightSeq?: number;
  }
  const clients = new Map<{ send: (data: string) => void }, ClientState>();

  /** Short session ID for logs. */
  function sid(sessionId: string | null | undefined): string {
    if (!sessionId) return "(none)";
    return sessionId.slice(0, 8);
  }

  // ── Client delivery helpers ──

  function sendToAll(data: string) {
    for (const ws of clients.keys()) {
      try { ws.send(data); } catch {}
    }
  }

  function sendToSession(sessionId: string, data: string) {
    for (const [ws, clientState] of clients) {
      if (clientState.currentSessionId === sessionId) {
        try { ws.send(data); } catch {}
      }
    }
  }

  /** Broadcast current kanban state to ALL connected clients. */
  function broadcastKanbanState() {
    try {
      const snap = kanbanDb.getKanbanSnapshot();
      sendToAll(JSON.stringify({ type: "kanban_state", ...snap }));
    } catch (err: any) {
      log.error({ err: err.message }, "kanban-db: getKanbanSnapshot failed");
    }
  }

  // ── Wire up the daemon's event sink ──
  // This closure captures the FRESH clients Map from this HMR reload.
  // The daemon's internal code (processPrompt, broadcast, etc.) always
  // calls this via this.eventSink(...) which points to the latest handler.

  daemon.setEventSink((msg: object, sessionId?: string | null) => {
    const m = msg as any;

    // Handle special daemon events
    if (m.type === "session_replaced") {
      // Update all clients viewing the old session to the new one
      for (const [ws, cs] of clients) {
        if (cs.currentSessionId === m.oldSessionId) {
          cs.currentSessionId = m.newSessionId;
          try { ws.send(JSON.stringify({ type: "session_switched", sessionId: m.newSessionId, turnStatus: null })); } catch {}
        }
      }
      return;
    }

    if (m.type === "kanban_state_changed") {
      broadcastKanbanState();
      return;
    }

    // Turn status events are broadcast to ALL clients so the kanban board
    // can track background sessions the client isn't currently viewing.
    const GLOBAL_TURN_TYPES = new Set(["turn_start", "turn_activity", "turn_end"]);

    // Normal event routing: session-specific or global
    const json = JSON.stringify(msg);
    if (GLOBAL_TURN_TYPES.has(m.type)) {
      sendToAll(json);
    } else if (sessionId) {
      sendToSession(sessionId, json);
    } else {
      sendToAll(json);
    }
  });

  // ── Eagerly start the daemon ──
  daemon.init().catch((err) => {
    log.error({ err: err.message }, "daemon init failed");
  });

  // ── Promise for first session readiness ──
  // If daemon already has a defaultSessionId (from a previous HMR cycle),
  // resolve immediately so clients don't hang on firstSessionReady.
  let resolveFirstSession: (() => void) | null = null;
  const firstSessionReady = new Promise<void>((r) => { resolveFirstSession = r; });
  if (daemon.defaultSessionId) resolveFirstSession?.();

  const server = Bun.serve({
    port,

    async fetch(req, server) {
      const url = new URL(req.url);

      if (url.pathname === "/ws") {
        if (server.upgrade(req)) return undefined;
        log.error({ origin: req.headers.get("origin") ?? "unknown" }, "ws: WebSocket upgrade FAILED");
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // ── Project tabs API ──
      const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });

      if (url.pathname === "/api/projects" && req.method === "GET") {
        return json(kanbanDb.getProjects());
      }
      if (url.pathname === "/api/projects" && req.method === "POST") {
        const body = await req.json() as { path: string };
        const p = body.path?.trim();
        if (!p) return json({ error: "path required" });
        return json(kanbanDb.addProject(p));
      }
      if (url.pathname === "/api/projects" && req.method === "DELETE") {
        const body = await req.json() as { path: string };
        const p = body.path?.trim();
        if (!p) return json({ error: "path required" });
        return json(kanbanDb.removeProject(p));
      }
      if (url.pathname === "/api/projects/active" && req.method === "PUT") {
        const body = await req.json() as { path: string };
        const p = body.path?.trim();
        if (!p) return json({ error: "path required" });
        return json(kanbanDb.setActiveProject(p));
      }
      if (url.pathname === "/api/pick-folder" && req.method === "POST") {
        try {
          const result = execSync(
            `osascript -e 'set f to POSIX path of (choose folder with prompt "Select project folder")'`,
            { encoding: "utf-8", timeout: 60_000 },
          ).trim().replace(/\/$/, "");
          return json({ path: result });
        } catch {
          return json({ path: null });
        }
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
        log.info({ client: clientId, total: clients.size, defaultSession: sid(daemon.defaultSessionId), boot: bootMs() }, "ws: open");

        // Wait for daemon to be ready
        try {
          await daemon.ready;
        } catch (err: any) {
          log.error({ client: clientId, err: err.message }, "ws: daemon not ready");
          try { ws.send(JSON.stringify({ type: "error", text: err.message })); } catch {}
          return;
        }

        // If no default session exists yet, create one
        if (!daemon.defaultSessionId) {
          try {
            const { sessionId } = await daemon.createSession();
            daemon.defaultSessionId = sessionId;
            resolveFirstSession?.();
            log.info({ client: clientId, session: sid(sessionId), durationMs: Math.round(performance.now() - t0) }, "ws: first session created");
          } catch (err: any) {
            log.error({ client: clientId, err: err.message }, "ws: session setup failed");
            try { ws.send(JSON.stringify({ type: "error", text: err.message })); } catch {}
            return;
          }
        }

        // Switch client to the default session
        await firstSessionReady;
        const sessionId = daemon.defaultSessionId!;
        clientState.currentSessionId = sessionId;

        try {
          const result = await daemon.getHistory(sessionId);
          ws.send(JSON.stringify({ type: "session_history", sessionId, entries: daemon.augmentHistoryWithTurnStats(sessionId, result.entries) }));
          ws.send(JSON.stringify({ type: "session_switched", sessionId, turnStatus: daemon.getTurnStatusSnapshot(sessionId) }));
          daemon.sendSessionMeta(ws, sessionId);
          daemon.sendTurnState(ws, sessionId);
          daemon.sendQueueState(ws, sessionId);
        } catch (err: any) {
          log.warn({ client: clientId, session: sid(sessionId), err: err.message }, "ws: initial history load failed");
          ws.send(JSON.stringify({ type: "session_switched", sessionId, turnStatus: daemon.getTurnStatusSnapshot(sessionId) }));
        }

        // Send available executors, session list + kanban state
        try { ws.send(JSON.stringify({ type: "executors", available: daemon.getAvailableExecutors() })); } catch {}
        daemon.broadcastSessions().catch(() => {});
        broadcastKanbanState();

        // Fetch tasks
        daemon.getTasksList(sessionId).then((taskResult) => {
          const tasks = (taskResult.tasks as unknown[]) ?? [];
          if (tasks.length > 0) {
            try { ws.send(JSON.stringify({ type: "tasks", sessionId, tasks })); } catch {}
          }
        }).catch(() => {});

        log.info({ client: clientId, session: sid(sessionId), durationMs: Math.round(performance.now() - t0), boot: bootMs() }, "ws: open complete");
      },

      async message(ws, raw) {
        const msgT0 = performance.now();
        const msg = JSON.parse(
          typeof raw === "string" ? raw : new TextDecoder().decode(raw),
        );

        const clientState = clients.get(ws);
        if (!clientState) {
          log.warn({ msgType: msg.type }, "ws: message from unknown client, closing stale connection");
          ws.close(4000, "Server reloaded");
          return;
        }
        const cid = clientState.id;

        switch (msg.type) {
          case "prompt": {
            const targetSession = msg.sessionId || clientState.currentSessionId;
            if (!targetSession) {
              log.warn({ client: cid }, "ws: prompt but no sessionId/currentSessionId");
              return;
            }
            log.info(
              {
                client: cid,
                session: sid(targetSession),
                textLen: msg.text?.length ?? 0,
                images: msg.images?.length ?? 0,
                files: msg.files?.length ?? 0,
                crossSession: !!msg.sessionId,
              },
              "ws: → prompt",
            );

            // Broadcast user message to other clients viewing this session
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

            if (daemon.isProcessing(targetSession)) {
              daemon.interruptAndPrompt(targetSession, msg.text, msg.images, msg.files);
            } else {
              daemon.prompt(targetSession, msg.text, msg.images, msg.files);
            }
            break;
          }

          case "opus_prompt": {
            const opusSession = msg.sessionId || clientState.currentSessionId;
            if (!opusSession) {
              log.warn({ client: cid }, "ws: opus_prompt but no sessionId");
              return;
            }
            // Don't update clientState.currentSessionId for cross-session prompts
            // (kanban background tasks). The client isn't navigating to this session;
            // changing currentSessionId would break event routing for the session
            // the user is actually viewing.
            log.info({ client: cid, session: sid(opusSession), textLen: msg.text?.length ?? 0, crossSession: !!msg.sessionId }, "ws: → opus_prompt");

            // Broadcast user message to other clients viewing this session
            const opusUserMsgJson = JSON.stringify({
              type: "user_message",
              sessionId: opusSession,
              text: msg.text,
            });
            for (const [otherWs, otherState] of clients) {
              if (otherWs !== ws && otherState.currentSessionId === opusSession) {
                try { otherWs.send(opusUserMsgJson); } catch {}
              }
            }

            const alreadyProcessing = daemon.isProcessing(opusSession);
            log.info({ client: cid, session: sid(opusSession), alreadyProcessing }, "ws: opus_prompt dispatching");
            if (alreadyProcessing) {
              daemon.interruptAndPrompt(opusSession, msg.text);
            } else if (typeof daemon.opusPrompt === "function") {
              daemon.opusPrompt(opusSession, msg.text);
            } else {
              // Fallback: daemon instance predates opusPrompt (stale HMR prototype).
              // Use regular prompt path so the task still runs.
              log.warn({ client: cid, session: sid(opusSession) }, "ws: opus_prompt fallback — daemon.opusPrompt missing, using prompt()");
              daemon.prompt(opusSession, msg.text);
            }
            break;
          }

          case "interrupt": {
            if (!clientState.currentSessionId) break;
            const intSession = clientState.currentSessionId;
            log.info({ client: cid, session: sid(intSession) }, "ws: → interrupt");
            try {
              await daemon.interrupt(intSession);
              log.info({ client: cid, session: sid(intSession) }, "ws: interrupt sent");
            } catch (err: any) {
              log.error({ client: cid, session: sid(intSession), err: err.message }, "ws: interrupt error");
            }
            break;
          }

          case "permission_response": {
            log.info({ client: cid, requestId: msg.requestId, optionId: msg.optionId }, "ws: → permission_response");
            daemon.resolvePermission(msg.requestId, msg.optionId, msg.optionName || msg.optionId);
            break;
          }

          case "new_session": {
            const executorType = msg.executorType ?? "claude";
            log.info({ client: cid, executorType }, "ws: → new_session");
            try {
              const t0 = performance.now();
              const { sessionId } = await daemon.createSession(executorType);
              log.info({ client: cid, session: sid(sessionId), executorType, durationMs: Math.round(performance.now() - t0) }, "api: newSession completed");
              daemon.defaultSessionId = sessionId;
              clientState.currentSessionId = sessionId;
              ws.send(JSON.stringify({ type: "session_switched", sessionId, turnStatus: daemon.getTurnStatusSnapshot(sessionId) }));
              daemon.broadcastSessions().catch(() => {});
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
            try {
              const result = await daemon.getHistory(msg.sessionId);
              const entryCount = result.entries?.length ?? 0;
              log.info({ session: sid(msg.sessionId), durationMs: Math.round(performance.now() - t0), entries: entryCount }, "api: getHistory completed");
              clientState.currentSessionId = msg.sessionId;
              ws.send(JSON.stringify({ type: "session_history", sessionId: msg.sessionId, entries: daemon.augmentHistoryWithTurnStats(msg.sessionId, result.entries) }));
              ws.send(JSON.stringify({ type: "session_switched", sessionId: msg.sessionId, turnStatus: daemon.getTurnStatusSnapshot(msg.sessionId) }));
              daemon.sendSessionMeta(ws, msg.sessionId);
              daemon.sendTurnState(ws, msg.sessionId);
              daemon.sendQueueState(ws, msg.sessionId);
              // Fetch tasks
              daemon.getTasksList(msg.sessionId).then((taskResult) => {
                const tasks = (taskResult.tasks as unknown[]) ?? [];
                if (tasks.length > 0) {
                  ws.send(JSON.stringify({ type: "tasks", sessionId: msg.sessionId, tasks }));
                }
              }).catch(() => {});
              log.info({ client: cid, session: sid(msg.sessionId), totalMs: Math.round(performance.now() - t0) }, "ws: ← session_switched");
            } catch (err: any) {
              // Session gone — auto-create replacement
              if (/No conversation found|Session not found/i.test(err?.message ?? "") || err?.code === -32603) {
                log.warn({ client: cid, session: sid(msg.sessionId), err: err.message }, "ws: session gone on switch, auto-creating replacement");
                try {
                  const { sessionId: newId } = await daemon.createSession();
                  if (daemon.defaultSessionId === msg.sessionId) daemon.defaultSessionId = newId;
                  daemon.cleanupStaleSession(msg.sessionId);
                  clientState.currentSessionId = newId;
                  ws.send(JSON.stringify({ type: "session_switched", sessionId: newId, turnStatus: null }));
                  daemon.sendSessionMeta(ws, newId);
                  await daemon.broadcastSessions();
                } catch (createErr: any) {
                  log.error({ client: cid, err: createErr.message }, "ws: failed to create replacement session");
                }
              } else {
                log.error({ client: cid, msgType: msg.type, err: err.message }, "ws: switch/resume error");
                ws.send(JSON.stringify({ type: "error", text: `Failed to load session: ${err.message}` }));
              }
            }
            break;
          }

          case "resume_subagent": {
            const compositeId = `${msg.parentSessionId}:subagent:${msg.agentId}`;
            log.info({ client: cid, parent: sid(msg.parentSessionId), agentId: msg.agentId }, "ws: → resume_subagent");
            const t0 = performance.now();
            try {
              const result = await daemon.getSubagentHistory(msg.parentSessionId, msg.agentId);
              const entryCount = result.entries?.length ?? 0;
              log.info({ durationMs: Math.round(performance.now() - t0), entries: entryCount }, "api: getSubagentHistory completed");
              clientState.currentSessionId = compositeId;
              ws.send(JSON.stringify({ type: "session_history", sessionId: compositeId, entries: daemon.augmentHistoryWithTurnStats(compositeId, result.entries) }));
              ws.send(JSON.stringify({ type: "session_switched", sessionId: compositeId, turnStatus: daemon.getTurnStatusSnapshot(compositeId) }));
              daemon.sendSessionMeta(ws, compositeId);
              daemon.sendTurnState(ws, compositeId);
              daemon.sendQueueState(ws, compositeId);
              log.info({ client: cid, session: sid(compositeId), totalMs: Math.round(performance.now() - t0) }, "ws: ← session_switched (subagent)");
            } catch (err: any) {
              log.error({ client: cid, err: err.message }, "ws: resume_subagent error");
              ws.send(JSON.stringify({ type: "error", text: `Failed to load subagent: ${err.message}` }));
            }
            break;
          }

          case "rename_session": {
            const { sessionId, title } = msg;
            log.info({ client: cid, session: sid(sessionId), title }, "ws: → rename_session");
            await daemon.renameSession(sessionId, title);
            break;
          }

          case "delete_session": {
            log.info({ client: cid, session: sid(msg.sessionId) }, "ws: → delete_session");
            const t0 = performance.now();
            const { success, deletedIds } = await daemon.deleteSession(msg.sessionId);
            log.info({ session: sid(msg.sessionId), durationMs: Math.round(performance.now() - t0), success, deletedCount: deletedIds.length }, "api: delete completed");
            if (success) {
              // Clear currentSessionId for any client viewing a deleted session
              for (const [, cs] of clients) {
                if (deletedIds.includes(cs.currentSessionId!)) {
                  cs.currentSessionId = null;
                }
              }
              // Clean up kanban state
              kanbanDb.applyKanbanOps([
                ...deletedIds.map((id): KanbanOp => ({ op: "remove_column", sessionId: id })),
                ...deletedIds.map((id): KanbanOp => ({ op: "remove_pending_prompt", sessionId: id })),
                { op: "bulk_remove_sort_entries", sessionIds: deletedIds },
              ]);
              broadcastKanbanState();
              sendToAll(JSON.stringify({ type: "session_deleted", sessionIds: deletedIds }));
            }
            await daemon.broadcastSessions();
            log.info({ client: cid, totalMs: Math.round(performance.now() - t0) }, "ws: delete_session done");
            break;
          }

          case "get_commands": {
            log.info({ client: cid }, "ws: → get_commands");
            try {
              const t0 = performance.now();
              const result = await daemon.getAvailableCommands(clientState.currentSessionId ?? undefined);
              const cmdCount = (result.commands as unknown[])?.length ?? 0;
              log.info({ durationMs: Math.round(performance.now() - t0), commands: cmdCount }, "api: getAvailableCommands completed");
              const models = result.models as { availableModels?: { modelId: string; name?: string }[]; currentModelId?: string } | undefined;
              const currentModelId = models?.currentModelId;
              const currentModelName = models?.availableModels?.find((m: any) => m.modelId === currentModelId)?.name;
              ws.send(JSON.stringify({
                type: "commands",
                commands: result.commands,
                ...(models && {
                  models: models.availableModels?.map((m: any) => m.modelId) ?? [],
                  currentModel: currentModelName || currentModelId || null,
                }),
              }));
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
              const result = await daemon.getSubagents(msg.sessionId);
              log.info({ session: sid(msg.sessionId), durationMs: Math.round(performance.now() - t0), children: (result.children as unknown[])?.length ?? 0 }, "api: getSubagents completed");
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
              const query = (msg.query ?? "").toLowerCase();
              let files = raw.split("\n").filter(Boolean);
              if (query) files = files.filter((f) => f.toLowerCase().includes(query));
              files = files.slice(0, 50);
              ws.send(JSON.stringify({ type: "file_list", files, query: msg.query ?? "" }));
              log.info({ client: cid, results: files.length, totalMs: Math.round(performance.now() - t0) }, "ws: ← file_list");
            } catch {
              ws.send(JSON.stringify({ type: "file_list", files: [], query: msg.query ?? "" }));
            }
            break;
          }

          case "list_sessions": {
            log.info({ client: cid }, "ws: → list_sessions");
            await daemon.broadcastSessions();
            break;
          }

          case "route_message": {
            if (!clientState.currentSessionId) {
              log.warn({ client: cid }, "ws: route_message but no currentSessionId");
              return;
            }
            const routeSession = clientState.currentSessionId;
            log.info({ client: cid, session: sid(routeSession), textLen: msg.text?.length ?? 0 }, "ws: → route_message");

            // Broadcast user message helper
            const broadcastUserMsg = () => {
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
            };

            // Send to current session (interrupt if busy)
            const sendToCurrentSession = () => {
              broadcastUserMsg();
              if (daemon.isProcessing(routeSession)) {
                daemon.interruptAndPrompt(routeSession, msg.text, msg.images, msg.files);
              } else {
                daemon.prompt(routeSession, msg.text, msg.images, msg.files);
              }
            };

            // Whitelist check
            if (daemon.isRouteWhitelisted(msg.text)) {
              log.info({ client: cid, session: sid(routeSession), route: "whitelisted" }, "ws: route_message → same session (whitelisted)");
              ws.send(JSON.stringify({ type: "route_result", sessionId: routeSession, isNew: false }));
              sendToCurrentSession();
              break;
            }

            try {
              const sessionTitle = daemon.getSessionTitle(routeSession);
              const lastTurnSummary = await daemon.getLastTurnSummary(routeSession);
              const shouldContinue = await daemon.routeWithHaiku(msg.text, sessionTitle, lastTurnSummary);

              if (shouldContinue) {
                log.info({ client: cid, session: sid(routeSession), route: "same" }, "ws: route_message → same session");
                ws.send(JSON.stringify({ type: "route_result", sessionId: routeSession, isNew: false }));
                sendToCurrentSession();
              } else {
                log.info({ client: cid, session: sid(routeSession), route: "new" }, "ws: route_message → new session");
                const t0 = performance.now();
                const routeExecutorType = msg.executorType ?? "claude";
                const { sessionId: newSessionId } = await daemon.createSession(routeExecutorType);
                log.info({ client: cid, session: sid(newSessionId), durationMs: Math.round(performance.now() - t0) }, "api: newSession (routed) completed");
                clientState.currentSessionId = newSessionId;
                daemon.defaultSessionId = newSessionId;

                ws.send(JSON.stringify({ type: "session_history", sessionId: newSessionId, entries: [] }));
                ws.send(JSON.stringify({ type: "session_switched", sessionId: newSessionId, turnStatus: null }));
                ws.send(JSON.stringify({ type: "route_result", sessionId: newSessionId, isNew: true }));

                daemon.broadcastSessions().catch(() => {});
                daemon.prompt(newSessionId, msg.text, msg.images, msg.files);
              }
            } catch (err: any) {
              log.error({ client: cid, err: err.message }, "ws: route_message error");
              ws.send(JSON.stringify({ type: "route_result", sessionId: routeSession, isNew: false }));
              daemon.prompt(routeSession, msg.text, msg.images, msg.files);
            }
            break;
          }

          case "preflight_route": {
            if (!clientState.currentSessionId) break;
            const pfSession = clientState.currentSessionId;
            const pfSeq = msg.seq ?? 0;

            if (clientState.preflightSeq != null && pfSeq < clientState.preflightSeq) break;
            clientState.preflightSeq = pfSeq;

            if (daemon.isRouteWhitelisted(msg.text)) {
              clientState.preflightCache = { text: msg.text, sessionId: pfSession, isSameSession: true, timestamp: Date.now() };
              ws.send(JSON.stringify({ type: "preflight_route_result", sessionId: pfSession, isSameSession: true, text: msg.text, seq: pfSeq }));
              break;
            }

            log.info({ client: cid, session: sid(pfSession), textLen: msg.text?.length ?? 0, seq: pfSeq }, "ws: → preflight_route");

            try {
              const sessionTitle = daemon.getSessionTitle(pfSession);
              const lastTurnSummary = await daemon.getLastTurnSummary(pfSession);

              if (clientState.preflightSeq !== pfSeq) break;

              const shouldContinue = await daemon.routeWithHaiku(msg.text, sessionTitle, lastTurnSummary);

              if (clientState.preflightSeq !== pfSeq) break;

              clientState.preflightCache = { text: msg.text, sessionId: pfSession, isSameSession: shouldContinue, timestamp: Date.now() };
              log.info({ client: cid, session: sid(pfSession), route: shouldContinue ? "same" : "new", seq: pfSeq }, "ws: ← preflight_route_result");
              ws.send(JSON.stringify({ type: "preflight_route_result", sessionId: pfSession, isSameSession: shouldContinue, text: msg.text, seq: pfSeq }));
            } catch (err: any) {
              log.warn({ client: cid, err: err.message, seq: pfSeq }, "preflight: error (non-fatal)");
            }
            break;
          }

          case "request_haiku_metrics": {
            try { ws.send(JSON.stringify({ type: "haiku_metrics", metrics: daemon.getHaikuMetrics() })); } catch {}
            break;
          }

          case "request_opus_metrics": {
            try { ws.send(JSON.stringify({ type: "opus_metrics", metrics: daemon.getOpusMetrics() })); } catch {}
            break;
          }

          case "kanban_op": {
            const ops = (msg.ops ?? []) as KanbanOp[];
            const clientSeq = msg.clientSeq as number | undefined;
            log.info({ client: cid, opCount: ops.length, ops: ops.map((o: KanbanOp) => o.op) }, "ws: → kanban_op");
            const version = kanbanDb.applyKanbanOps(ops);
            if (clientSeq != null) {
              // Include the full snapshot in the ack so the sender can atomically
              // update server state AND drain pending ops in one reducer action.
              // This prevents a flicker frame where ops are drained but state is stale.
              const snap = kanbanDb.getKanbanSnapshot();
              try { ws.send(JSON.stringify({ type: "kanban_op_ack", clientSeq, version, ...snap })); } catch {}
            }
            // Broadcast to all clients (sender will dedupe via version check)
            broadcastKanbanState();
            break;
          }

          case "save_kanban_state": {
            log.info({ client: cid }, "ws: → save_kanban_state (legacy)");
            kanbanDb.setKanbanState({
              columnOverrides: msg.columnOverrides ?? {},
              sortOrders: msg.sortOrders ?? {},
              pendingPrompts: msg.pendingPrompts ?? {},
            });
            broadcastKanbanState();
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
        if (clients.size === 0) {
          // No clients left — clear all queues (they'd be stale by the time someone reconnects)
        }
      },
    },
  });

  const shutdown = () => {
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return server;
}
