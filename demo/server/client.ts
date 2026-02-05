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

export class WebClient implements Client {
  agent: Agent;
  broadcast: BroadcastFn;

  constructor(agent: Agent, broadcast: BroadcastFn) {
    this.agent = agent;
    this.broadcast = broadcast;
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    const { update } = params;

    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text") {
          const eventType = (update._meta as any)?.claudeCode?.eventType;
          if (eventType) {
            this.broadcast({ type: "system", sessionId: params.sessionId, text: update.content.text });
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

      case "tool_call":
        this.broadcast({
          type: "tool_call",
          sessionId: params.sessionId,
          toolCallId: update.toolCallId,
          title: update.title,
          kind: update.kind,
          status: "pending",
          content: update.content,
          _meta: update._meta,
        });
        break;

      case "tool_call_update":
        this.broadcast({
          type: "tool_call_update",
          sessionId: params.sessionId,
          toolCallId: update.toolCallId,
          status: update.status,
          content: update.content,
          _meta: update._meta,
          title: update.title,
        });
        break;

      case "plan":
        this.broadcast({ type: "plan", sessionId: params.sessionId, entries: update.entries });
        break;

      case "available_commands_update":
        this.broadcast({
          type: "commands",
          sessionId: params.sessionId,
          commands: update.availableCommands.map((c) => c.name),
        });
        break;

      case "current_mode_update":
        this.broadcast({ type: "mode", sessionId: params.sessionId, modeId: update.currentModeId });
        break;

      case "session_info_update":
        this.broadcast({
          type: "session_title_update",
          sessionId: params.sessionId,
          title: (update as any).title,
        });
        break;

      default:
        break;
    }
  }

  async requestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    this.broadcast({
      type: "permission",
      title: params.toolCall.title,
      decision: "auto-allow",
    });
    const option = params.options.find((o) => o.kind === "allow_once");
    return { outcome: { outcome: "selected", optionId: option!.optionId } };
  }

  async readTextFile(
    params: ReadTextFileRequest,
  ): Promise<ReadTextFileResponse> {
    try {
      return { content: await Bun.file(params.path).text() };
    } catch {
      return { content: "" };
    }
  }

  async writeTextFile(
    params: WriteTextFileRequest,
  ): Promise<WriteTextFileResponse> {
    await Bun.write(params.path, params.content);
    return {};
  }
}
