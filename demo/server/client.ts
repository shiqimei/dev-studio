import type {
  Agent,
  Client,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import type { BroadcastFn } from "./types.js";
import { log } from "./log.js";

/** Short session ID for logs. */
function sid(sessionId: string | null | undefined): string {
  if (!sessionId) return "(none)";
  return sessionId.slice(0, 8);
}

interface PendingPermission {
  resolve: (response: RequestPermissionResponse) => void;
  sessionId: string;
  timer: ReturnType<typeof setTimeout>;
}

export class WebClient implements Client {
  agent: Agent;
  broadcast: BroadcastFn;
  private pendingPermissions = new Map<string, PendingPermission>();
  private nextPermId = 0;

  constructor(agent: Agent, broadcast: BroadcastFn) {
    this.agent = agent;
    this.broadcast = broadcast;
  }

  /** Resolve a pending permission request (called when user clicks a button in the UI). */
  resolvePermission(requestId: string, optionId: string, optionName: string) {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingPermissions.delete(requestId);
    log.info({ requestId, optionId }, "permission: resolved");
    this.broadcast({
      type: "permission_resolved",
      sessionId: pending.sessionId,
      requestId,
      optionId,
      optionName,
    });
    pending.resolve({ outcome: { outcome: "selected", optionId } });
  }

  /** Cancel all pending permissions for a session (e.g. on interrupt). */
  cancelPermissions(sessionId: string) {
    for (const [requestId, pending] of this.pendingPermissions) {
      if (pending.sessionId === sessionId) {
        clearTimeout(pending.timer);
        this.pendingPermissions.delete(requestId);
        log.info({ requestId, sessionId: sid(sessionId) }, "permission: cancelled");
        this.broadcast({
          type: "permission_resolved",
          sessionId,
          requestId,
          optionId: "cancelled",
          optionName: "Cancelled",
        });
        pending.resolve({ outcome: { outcome: "cancelled" } });
      }
    }
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    const { update } = params;
    const session = sid(params.sessionId);

    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text") {
          const eventType = (update._meta as any)?.claudeCode?.eventType;
          if (eventType) {
            log.debug({ session, eventType, textLen: update.content.text.length }, "notify: agent_message_chunk (system)");
            this.broadcast({ type: "system", sessionId: params.sessionId, text: update.content.text });
          } else if (update.content.text === "[Compacting conversation context...]") {
            // Show as turn activity instead of chat text
            this.broadcast({ type: "set_activity", sessionId: params.sessionId, activity: "compacting" });
          } else {
            this.broadcast({ type: "text", sessionId: params.sessionId, text: update.content.text });
          }
        }
        break;

      case "agent_thought_chunk":
        if (update.content.type === "text") {
          this.broadcast({ type: "thought", sessionId: params.sessionId, text: update.content.text });
        }
        break;

      case "tool_call": {
        const toolName = (update._meta as any)?.claudeCode?.toolName ?? update.kind;
        log.debug({ session, toolCallId: update.toolCallId, tool: toolName, kind: update.kind, title: update.title }, "notify: tool_call");
        this.broadcast({
          type: "tool_call",
          sessionId: params.sessionId,
          toolCallId: update.toolCallId,
          title: update.title,
          kind: update.kind,
          status: "pending",
          content: update.content,
          rawInput: (update as any).rawInput,
          locations: (update as any).locations,
          _meta: update._meta,
        });
        break;
      }

      case "tool_call_update": {
        const toolName = (update._meta as any)?.claudeCode?.toolName ?? (update as any).kind;
        log.debug({ session, toolCallId: update.toolCallId, status: update.status, tool: toolName, title: update.title }, "notify: tool_call_update");
        this.broadcast({
          type: "tool_call_update",
          sessionId: params.sessionId,
          toolCallId: update.toolCallId,
          status: update.status,
          content: update.content,
          rawInput: (update as any).rawInput,
          kind: (update as any).kind,
          locations: (update as any).locations,
          _meta: update._meta,
          title: update.title,
        });
        break;
      }

      case "plan":
        log.debug({ session, entries: (update as any).entries?.length ?? 0 }, "notify: plan");
        this.broadcast({ type: "plan", sessionId: params.sessionId, entries: update.entries });
        break;

      case "available_commands_update": {
        const cmdCount = update.availableCommands?.length ?? 0;
        log.info({ session, commands: cmdCount }, "notify: available_commands_update");
        this.broadcast({
          type: "commands",
          sessionId: params.sessionId,
          commands: update.availableCommands.map((c) => ({
            name: c.name,
            description: (c as any).description ?? "",
            inputHint: (c as any).inputHint,
          })),
        });
        break;
      }

      case "current_mode_update":
        log.info({ session, mode: update.currentModeId }, "notify: current_mode_update");
        this.broadcast({ type: "mode", sessionId: params.sessionId, modeId: update.currentModeId });
        break;

      case "session_info_update": {
        const meta = (update as any)._meta?.claudeCode;
        if (meta?.eventType === "task_state" && Array.isArray(meta.tasks)) {
          log.info({ session, taskCount: meta.tasks.length }, "notify: session_info_update (task_state)");
          this.broadcast({
            type: "tasks",
            sessionId: params.sessionId,
            tasks: meta.tasks,
          });
        } else {
          log.info({ session, title: (update as any).title }, "notify: session_info_update");
          this.broadcast({
            type: "session_title_update",
            sessionId: params.sessionId,
            title: (update as any).title,
          });
        }
        break;
      }

      default:
        log.debug({ session, update: (update as any).sessionUpdate ?? "unknown" }, "notify: unhandled sessionUpdate");
        break;
    }
  }

  async requestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const requestId = `perm-${++this.nextPermId}`;

    // ExitPlanMode: auto-approve with acceptEdits (no user interaction needed)
    const isExitPlanMode = params.options.some((o) => o.optionId === "acceptEdits");
    if (isExitPlanMode) {
      log.info({ requestId, tool: params.toolCall.title }, "permission: auto-approved ExitPlanMode (acceptEdits)");
      return { outcome: { outcome: "selected", optionId: "acceptEdits" } };
    }

    // AskUserQuestion: options have q{N}_opt{M} IDs — show interactive UI
    const isInteractive = params.options.some((o) => o.optionId.startsWith("q"));

    if (!isInteractive) {
      // Auto-approve standard tool permissions (allow_once)
      const allowOption = params.options.find((o) => o.kind === "allow_once") ?? params.options[0];
      log.info({ requestId, tool: params.toolCall.title, optionId: allowOption.optionId }, "permission: auto-approved");
      return { outcome: { outcome: "selected", optionId: allowOption.optionId } };
    }

    log.info({ requestId, tool: params.toolCall.title, options: params.options.length }, "permission: interactive request");

    return new Promise<RequestPermissionResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPermissions.delete(requestId);
        log.warn({ requestId }, "permission: timed out (5min)");
        this.broadcast({
          type: "permission_resolved",
          sessionId: params.sessionId,
          requestId,
          optionId: "cancelled",
          optionName: "Timed out",
        });
        resolve({ outcome: { outcome: "cancelled" } });
      }, 5 * 60 * 1000);

      this.pendingPermissions.set(requestId, {
        resolve,
        sessionId: params.sessionId,
        timer,
      });

      this.broadcast({
        type: "permission_request",
        sessionId: params.sessionId,
        requestId,
        title: params.toolCall.title,
        toolCallId: params.toolCall.toolCallId,
        options: params.options,
      });
    });
  }

  async readTextFile(
    params: ReadTextFileRequest,
  ): Promise<ReadTextFileResponse> {
    const t0 = performance.now();
    try {
      const content = await Bun.file(params.path).text();
      log.debug({ path: params.path, durationMs: Math.round(performance.now() - t0), size: content.length }, "notify: readTextFile");
      return { content };
    } catch {
      log.warn({ path: params.path, durationMs: Math.round(performance.now() - t0) }, "notify: readTextFile FAILED");
      return { content: "" };
    }
  }

  async writeTextFile(
    params: WriteTextFileRequest,
  ): Promise<WriteTextFileResponse> {
    const t0 = performance.now();
    await Bun.write(params.path, params.content);
    log.debug({ path: params.path, durationMs: Math.round(performance.now() - t0), size: params.content.length }, "notify: writeTextFile");
    return {};
  }
}
