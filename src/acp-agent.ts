import {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  AvailableCommand,
  CancelNotification,
  ClientCapabilities,
  ForkSessionRequest,
  ForkSessionResponse,
  InitializeRequest,
  InitializeResponse,
  ndJsonStream,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestError,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionModelState,
  SessionNotification,
  SetSessionModelRequest,
  SetSessionModelResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  TerminalHandle,
  TerminalOutputResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import { SettingsManager } from "./settings.js";
import {
  CanUseTool,
  McpServerConfig,
  Options,
  PermissionMode,
  Query,
  query,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { nodeToWebReadable, nodeToWebWritable, Pushable, unreachable } from "./utils.js";
import { createMcpServer } from "./mcp-server.js";
import { EDIT_TOOL_NAMES, acpToolNames } from "./tools.js";
import {
  toolInfoFromToolUse,
  planEntries,
  toolUpdateFromToolResult,
  ClaudePlanEntry,
  registerHookCallback,
  createPostToolUseHook,
  createPreToolUseHook,
} from "./tools.js";
import { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import { BetaContentBlock, BetaRawContentBlockDelta } from "@anthropic-ai/sdk/resources/beta.mjs";
import packageJson from "../package.json" with { type: "json" };
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

export const CLAUDE_CONFIG_DIR = process.env.CLAUDE ?? path.join(os.homedir(), ".claude");

/**
 * Logger interface for customizing logging output
 */
export interface Logger {
  log: (...args: any[]) => void;
  error: (...args: any[]) => void;
}

type Session = {
  query: Query;
  router: SessionMessageRouter;
  input: Pushable<SDKUserMessage>;
  cancelled: boolean;
  permissionMode: PermissionMode;
  settingsManager: SettingsManager;
};

/**
 * Wraps a Query async generator to continuously read messages.
 * Intercepts system messages (e.g. task_notification) that need immediate
 * handling—even between turns—while buffering everything else for prompt().
 */
class SessionMessageRouter {
  private buffer: SDKMessage[] = [];
  private resolver: ((result: IteratorResult<SDKMessage, void>) => void) | null = null;
  private finished = false;

  constructor(
    private query: Query,
    private onSystemMessage: (msg: SDKMessage) => Promise<void>,
    private logger: Logger,
  ) {
    this.startReading();
  }

  private async startReading() {
    try {
      while (true) {
        const result = await this.query.next();
        if (result.done || !result.value) {
          this.finished = true;
          if (this.resolver) {
            this.resolver({ value: undefined as any, done: true });
            this.resolver = null;
          }
          break;
        }

        const msg = result.value;

        // Intercept task_notification for immediate handling between turns
        if (msg.type === "system" && msg.subtype === "task_notification") {
          try {
            await this.onSystemMessage(msg);
          } catch (err) {
            this.logger.error("[SessionMessageRouter] onSystemMessage error:", err);
          }
          continue;
        }

        // Forward to prompt() consumer
        if (this.resolver) {
          this.resolver({ value: msg, done: false });
          this.resolver = null;
        } else {
          this.buffer.push(msg);
        }
      }
    } catch (err) {
      this.finished = true;
      if (this.resolver) {
        this.resolver({ value: undefined as any, done: true });
        this.resolver = null;
      }
    }
  }

  /** Drop-in replacement for query.next() used by prompt(). */
  async next(): Promise<IteratorResult<SDKMessage, void>> {
    if (this.buffer.length > 0) {
      return { value: this.buffer.shift()!, done: false };
    }
    if (this.finished) {
      return { value: undefined, done: true };
    }
    return new Promise((resolve) => {
      this.resolver = resolve;
    });
  }
}

type BackgroundTerminal =
  | {
      handle: TerminalHandle;
      status: "started";
      lastOutput: TerminalOutputResponse | null;
    }
  | {
      status: "aborted" | "exited" | "killed" | "timedOut";
      pendingOutput: TerminalOutputResponse;
    };

/**
 * Extra metadata that can be given to Claude Code when creating a new session.
 */
export type NewSessionMeta = {
  claudeCode?: {
    /**
     * Options forwarded to Claude Code when starting a new session.
     *
     * These parameters are **ignored** / overridden by ACP:
     *   - cwd, includePartialMessages, allowDangerouslySkipPermissions,
     *     permissionMode, canUseTool, tools
     *
     * These parameters are **merged** with ACP's own values:
     *   - hooks (user hooks run alongside ACP's PreToolUse/PostToolUse)
     *   - mcpServers (user servers merged with ACP's internal MCP server)
     *   - stderr (user callback invoked alongside ACP's logger)
     *   - extraArgs (merged with ACP's session-id arg)
     *
     * All other Options fields are passed through directly, including:
     *   - fallbackModel, maxBudgetUsd, maxTurns, maxThinkingTokens, model
     *   - additionalDirectories, executableArgs, spawnClaudeCodeProcess
     *   - strictMcpConfig, agent, agents, outputFormat
     *   - enableFileCheckpointing, betas, plugins, sandbox
     *   - permissionPromptToolName, settingSources, persistSession
     *   - resumeSessionAt, resume, forkSession
     *   - executable, pathToClaudeCodeExecutable
     */
    options?: Options;
  };
};

/**
 * Extra metadata that the agent provides for each tool_call / tool_update update.
 */
export type ToolUpdateMeta = {
  claudeCode?: {
    /* The name of the tool that was used in Claude Code. */
    toolName: string;
    /* The structured output provided by Claude Code. */
    toolResponse?: unknown;
    /* True when this tool was launched as a background task (run_in_background). */
    isBackground?: boolean;
    /* True when a background task has actually finished (vs the initial "completed" which just means launched). */
    backgroundComplete?: boolean;
    /* The parent tool_use_id when this tool is called from a sub-agent (links to the parent Task's toolCallId). */
    parentToolUseId?: string;
  };
};

export type ToolUseCache = {
  [key: string]: {
    type: "tool_use" | "server_tool_use" | "mcp_tool_use";
    id: string;
    name: string;
    input: unknown;
  };
};

// Bypass Permissions doesn't work if we are a root/sudo user
const IS_ROOT = (process.geteuid?.() ?? process.getuid?.()) === 0;

// Implement the ACP Agent interface
export class ClaudeAcpAgent implements Agent {
  sessions: {
    [key: string]: Session;
  };
  client: AgentSideConnection;
  toolUseCache: ToolUseCache;
  backgroundTerminals: { [key: string]: BackgroundTerminal } = {};
  /** Maps task_id (or "file:<output_file>") from task_notification → toolCallId */
  backgroundTaskMap: Record<string, string> = {};
  clientCapabilities?: ClientCapabilities;
  logger: Logger;

  constructor(client: AgentSideConnection, logger?: Logger) {
    this.sessions = {};
    this.client = client;
    this.toolUseCache = {};
    this.logger = logger ?? console;
  }

  /**
   * Handle a task_notification system message (background agent completed).
   * Called by the SessionMessageRouter, even between turns.
   */
  private async handleTaskNotification(sessionId: string, message: any): Promise<void> {
    const taskNotif = message as {
      task_id: string;
      status: "completed" | "failed" | "stopped";
      output_file: string;
      summary: string;
    };
    const toolCallId =
      this.backgroundTaskMap[taskNotif.task_id] ||
      this.backgroundTaskMap[`file:${taskNotif.output_file}`];
    if (toolCallId) {
      const status: "completed" | "failed" =
        taskNotif.status === "completed" ? "completed" : "failed";
      await this.client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status,
          ...(taskNotif.summary && {
            title: taskNotif.summary,
            content: [
              {
                type: "content",
                content: { type: "text", text: taskNotif.summary },
              },
            ],
          }),
          _meta: {
            claudeCode: {
              toolName: "Task",
              isBackground: true,
              backgroundComplete: true,
            },
          } satisfies ToolUpdateMeta,
        },
      });
      delete this.backgroundTaskMap[taskNotif.task_id];
      delete this.backgroundTaskMap[`file:${taskNotif.output_file}`];
    } else {
      this.logger.log(
        `[claude-code-acp] task_notification for unmapped task: ${taskNotif.task_id}`,
      );
    }
  }

  async initialize(request: InitializeRequest): Promise<InitializeResponse> {
    this.clientCapabilities = request.clientCapabilities;

    // Default authMethod
    const authMethod: any = {
      description: "Run `claude /login` in the terminal",
      name: "Log in with Claude Code",
      id: "claude-login",
    };

    // If client supports terminal-auth capability, use that instead.
    if (request.clientCapabilities?._meta?.["terminal-auth"] === true) {
      const cliPath = fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk/cli.js"));

      authMethod._meta = {
        "terminal-auth": {
          command: "node",
          args: [cliPath, "/login"],
          label: "Claude Code Login",
        },
      };
    }

    return {
      protocolVersion: 1,
      agentCapabilities: {
        promptCapabilities: {
          image: true,
          embeddedContext: true,
        },
        mcpCapabilities: {
          http: true,
          sse: true,
        },
        sessionCapabilities: {
          fork: {},
          resume: {},
        },
      },
      agentInfo: {
        name: packageJson.name,
        title: "Claude Code",
        version: packageJson.version,
      },
      authMethods: [authMethod],
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    if (
      fs.existsSync(path.resolve(os.homedir(), ".claude.json.backup")) &&
      !fs.existsSync(path.resolve(os.homedir(), ".claude.json"))
    ) {
      throw RequestError.authRequired();
    }

    return await this.createSession(params, {
      // Revisit these meta values once we support resume
      resume: (params._meta as NewSessionMeta | undefined)?.claudeCode?.options?.resume,
    });
  }

  async unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
    return await this.createSession(
      {
        cwd: params.cwd,
        mcpServers: params.mcpServers ?? [],
        _meta: params._meta,
      },
      {
        resume: params.sessionId,
        forkSession: true,
      },
    );
  }

  async unstable_resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    const response = await this.createSession(
      {
        cwd: params.cwd,
        mcpServers: params.mcpServers ?? [],
        _meta: params._meta,
      },
      {
        resume: params.sessionId,
      },
    );

    return response;
  }

  async authenticate(_params: AuthenticateRequest): Promise<void> {
    throw new Error("Method not implemented.");
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    if (!this.sessions[params.sessionId]) {
      throw new Error("Session not found");
    }

    this.sessions[params.sessionId].cancelled = false;

    const { router, input } = this.sessions[params.sessionId];

    input.push(promptToClaude(params));
    while (true) {
      const { value: message, done } = await router.next();
      if (done || !message) {
        if (this.sessions[params.sessionId].cancelled) {
          return { stopReason: "cancelled" };
        }
        break;
      }

      switch (message.type) {
        case "system":
          switch (message.subtype) {
            case "init":
              break;
            case "task_notification":
              // Intercepted by SessionMessageRouter (handles between turns too)
              break;
            case "compact_boundary":
            case "hook_started":
            case "hook_progress":
            case "hook_response":
            case "status":
              // Todo: process via status api: https://docs.claude.com/en/docs/claude-code/hooks#hook-output
              break;
            case "files_persisted":
              break;
            default:
              unreachable(message, this.logger);
              break;
          }
          break;
        case "result": {
          if (this.sessions[params.sessionId].cancelled) {
            return { stopReason: "cancelled" };
          }

          // Build result metadata to surface cost/usage info to ACP client
          const resultMeta: Record<string, unknown> = {
            claudeCode: {
              duration_ms: message.duration_ms,
              duration_api_ms: message.duration_api_ms,
              num_turns: message.num_turns,
              total_cost_usd: message.total_cost_usd,
              usage: message.usage,
              modelUsage: message.modelUsage,
              session_id: message.session_id,
              uuid: message.uuid,
              ...("permission_denials" in message &&
                message.permission_denials.length > 0 && {
                  permission_denials: message.permission_denials,
                }),
              ...("structured_output" in message &&
                message.structured_output !== undefined && {
                  structured_output: message.structured_output,
                }),
            },
          };

          switch (message.subtype) {
            case "success": {
              if (message.result.includes("Please run /login")) {
                throw RequestError.authRequired();
              }
              if (message.is_error) {
                throw RequestError.internalError(undefined, message.result);
              }
              return { stopReason: "end_turn", _meta: resultMeta };
            }
            case "error_during_execution":
              if (message.is_error) {
                throw RequestError.internalError(
                  undefined,
                  message.errors.join(", ") || message.subtype,
                );
              }
              return { stopReason: "end_turn", _meta: resultMeta };
            case "error_max_budget_usd":
            case "error_max_turns":
            case "error_max_structured_output_retries":
              if (message.is_error) {
                throw RequestError.internalError(
                  undefined,
                  message.errors.join(", ") || message.subtype,
                );
              }
              return { stopReason: "max_turn_requests", _meta: resultMeta };
            default:
              unreachable(message, this.logger);
              break;
          }
          break;
        }
        case "stream_event": {
          for (const notification of streamEventToAcpNotifications(
            message,
            params.sessionId,
            this.toolUseCache,
            this.client,
            this.logger,
            this.backgroundTaskMap,
          )) {
            await this.client.sessionUpdate(notification);
          }
          break;
        }
        case "user":
        case "assistant": {
          if (this.sessions[params.sessionId].cancelled) {
            break;
          }

          // Slash commands like /compact can generate invalid output... doesn't match
          // their own docs: https://docs.anthropic.com/en/docs/claude-code/sdk/sdk-slash-commands#%2Fcompact-compact-conversation-history
          if (
            typeof message.message.content === "string" &&
            message.message.content.includes("<local-command-stdout>")
          ) {
            // Handle /context by sending its reply as regular agent message.
            if (message.message.content.includes("Context Usage")) {
              for (const notification of toAcpNotifications(
                message.message.content
                  .replace("<local-command-stdout>", "")
                  .replace("</local-command-stdout>", ""),
                "assistant",
                params.sessionId,
                this.toolUseCache,
                this.client,
                this.logger,
                this.backgroundTaskMap,
              )) {
                await this.client.sessionUpdate(notification);
              }
            }
            this.logger.log(message.message.content);
            break;
          }

          if (
            typeof message.message.content === "string" &&
            message.message.content.includes("<local-command-stderr>")
          ) {
            this.logger.error(message.message.content);
            break;
          }
          // Skip these user messages for now, since they seem to just be messages we don't want in the feed
          if (
            message.type === "user" &&
            (typeof message.message.content === "string" ||
              (Array.isArray(message.message.content) &&
                message.message.content.length === 1 &&
                message.message.content[0].type === "text"))
          ) {
            break;
          }

          if (
            message.type === "assistant" &&
            message.message.model === "<synthetic>" &&
            Array.isArray(message.message.content) &&
            message.message.content.length === 1 &&
            message.message.content[0].type === "text" &&
            message.message.content[0].text.includes("Please run /login")
          ) {
            throw RequestError.authRequired();
          }

          const content =
            message.type === "assistant"
              ? // Handled by stream events above
                message.message.content.filter((item) => !["text", "thinking"].includes(item.type))
              : message.message.content;

          for (const notification of toAcpNotifications(
            content,
            message.message.role,
            params.sessionId,
            this.toolUseCache,
            this.client,
            this.logger,
            this.backgroundTaskMap,
            (message as any).parent_tool_use_id,
          )) {
            await this.client.sessionUpdate(notification);
          }
          break;
        }
        case "tool_progress":
        case "tool_use_summary":
          break;
        case "auth_status":
          break;
        default:
          unreachable(message);
          break;
      }
    }
    throw new Error("Session did not end in result");
  }

  async cancel(params: CancelNotification): Promise<void> {
    if (!this.sessions[params.sessionId]) {
      throw new Error("Session not found");
    }
    this.sessions[params.sessionId].cancelled = true;
    await this.sessions[params.sessionId].query.interrupt();
  }

  async unstable_setSessionModel(
    params: SetSessionModelRequest,
  ): Promise<SetSessionModelResponse | void> {
    if (!this.sessions[params.sessionId]) {
      throw new Error("Session not found");
    }
    await this.sessions[params.sessionId].query.setModel(params.modelId);
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    if (!this.sessions[params.sessionId]) {
      throw new Error("Session not found");
    }

    switch (params.modeId) {
      case "default":
      case "acceptEdits":
      case "bypassPermissions":
      case "dontAsk":
      case "plan":
      case "delegate":
        this.sessions[params.sessionId].permissionMode = params.modeId as PermissionMode;
        try {
          await this.sessions[params.sessionId].query.setPermissionMode(
            params.modeId as PermissionMode,
          );
        } catch (error) {
          const errorMessage =
            error instanceof Error && error.message ? error.message : "Invalid Mode";

          throw new Error(errorMessage);
        }
        return {};
      default:
        throw new Error("Invalid Mode");
    }
  }

  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    const response = await this.client.readTextFile(params);
    return response;
  }

  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    const response = await this.client.writeTextFile(params);
    return response;
  }

  // --- Query API methods exposed for library consumers ---

  /**
   * Set the maximum thinking tokens for a session.
   * Maps to Query.setMaxThinkingTokens().
   */
  async setMaxThinkingTokens(sessionId: string, maxThinkingTokens: number | null): Promise<void> {
    const session = this.sessions[sessionId];
    if (!session) throw new Error("Session not found");
    await session.query.setMaxThinkingTokens(maxThinkingTokens);
  }

  /**
   * Get MCP server status for a session.
   * Maps to Query.mcpServerStatus().
   */
  async mcpServerStatus(sessionId: string) {
    const session = this.sessions[sessionId];
    if (!session) throw new Error("Session not found");
    return await session.query.mcpServerStatus();
  }

  /**
   * Reconnect an MCP server by name.
   * Maps to Query.reconnectMcpServer().
   */
  async reconnectMcpServer(sessionId: string, serverName: string): Promise<void> {
    const session = this.sessions[sessionId];
    if (!session) throw new Error("Session not found");
    await session.query.reconnectMcpServer(serverName);
  }

  /**
   * Toggle an MCP server enabled/disabled.
   * Maps to Query.toggleMcpServer().
   */
  async toggleMcpServer(sessionId: string, serverName: string, enabled: boolean): Promise<void> {
    const session = this.sessions[sessionId];
    if (!session) throw new Error("Session not found");
    await session.query.toggleMcpServer(serverName, enabled);
  }

  /**
   * Dynamically set MCP servers for a session.
   * Maps to Query.setMcpServers().
   */
  async setMcpServers(sessionId: string, servers: Record<string, McpServerConfig>) {
    const session = this.sessions[sessionId];
    if (!session) throw new Error("Session not found");
    return await session.query.setMcpServers(servers);
  }

  /**
   * Get account info for the authenticated user.
   * Maps to Query.accountInfo().
   */
  async accountInfo(sessionId: string) {
    const session = this.sessions[sessionId];
    if (!session) throw new Error("Session not found");
    return await session.query.accountInfo();
  }

  /**
   * Rewind files to their state at a specific user message.
   * Requires enableFileCheckpointing to be set in session options.
   * Maps to Query.rewindFiles().
   */
  async rewindFiles(sessionId: string, userMessageId: string, opts?: { dryRun?: boolean }) {
    const session = this.sessions[sessionId];
    if (!session) throw new Error("Session not found");
    return await session.query.rewindFiles(userMessageId, opts);
  }

  canUseTool(sessionId: string): CanUseTool {
    return async (toolName, toolInput, { signal, suggestions, toolUseID }) => {
      const session = this.sessions[sessionId];
      if (!session) {
        return {
          behavior: "deny",
          message: "Session not found",
          interrupt: true,
        };
      }

      if (toolName === "ExitPlanMode") {
        const response = await this.client.requestPermission({
          options: [
            {
              kind: "allow_always",
              name: "Yes, and auto-accept edits",
              optionId: "acceptEdits",
            },
            { kind: "allow_once", name: "Yes, and manually approve edits", optionId: "default" },
            { kind: "reject_once", name: "No, keep planning", optionId: "plan" },
          ],
          sessionId,
          toolCall: {
            toolCallId: toolUseID,
            rawInput: toolInput,
            title: toolInfoFromToolUse({ name: toolName, input: toolInput }).title,
          },
        });

        if (signal.aborted || response.outcome?.outcome === "cancelled") {
          throw new Error("Tool use aborted");
        }
        if (
          response.outcome?.outcome === "selected" &&
          (response.outcome.optionId === "default" || response.outcome.optionId === "acceptEdits")
        ) {
          session.permissionMode = response.outcome.optionId;
          await this.client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "current_mode_update",
              currentModeId: response.outcome.optionId,
            },
          });

          return {
            behavior: "allow",
            updatedInput: toolInput,
            updatedPermissions: suggestions ?? [
              { type: "setMode", mode: response.outcome.optionId, destination: "session" },
            ],
          };
        } else {
          return {
            behavior: "deny",
            message: "User rejected request to exit plan mode.",
            interrupt: true,
          };
        }
      }

      if (
        session.permissionMode === "bypassPermissions" ||
        (session.permissionMode === "acceptEdits" && EDIT_TOOL_NAMES.includes(toolName))
      ) {
        return {
          behavior: "allow",
          updatedInput: toolInput,
          updatedPermissions: suggestions ?? [
            { type: "addRules", rules: [{ toolName }], behavior: "allow", destination: "session" },
          ],
        };
      }

      const response = await this.client.requestPermission({
        options: [
          {
            kind: "allow_always",
            name: "Always Allow",
            optionId: "allow_always",
          },
          { kind: "allow_once", name: "Allow", optionId: "allow" },
          { kind: "reject_once", name: "Reject", optionId: "reject" },
        ],
        sessionId,
        toolCall: {
          toolCallId: toolUseID,
          rawInput: toolInput,
          title: toolInfoFromToolUse({ name: toolName, input: toolInput }).title,
        },
      });
      if (signal.aborted || response.outcome?.outcome === "cancelled") {
        throw new Error("Tool use aborted");
      }
      if (
        response.outcome?.outcome === "selected" &&
        (response.outcome.optionId === "allow" || response.outcome.optionId === "allow_always")
      ) {
        // If Claude Code has suggestions, it will update their settings already
        if (response.outcome.optionId === "allow_always") {
          return {
            behavior: "allow",
            updatedInput: toolInput,
            updatedPermissions: suggestions ?? [
              {
                type: "addRules",
                rules: [{ toolName }],
                behavior: "allow",
                destination: "session",
              },
            ],
          };
        }
        return {
          behavior: "allow",
          updatedInput: toolInput,
        };
      } else {
        return {
          behavior: "deny",
          message: "User refused permission to run tool",
          interrupt: true,
        };
      }
    };
  }

  private async createSession(
    params: NewSessionRequest,
    creationOpts: { resume?: string; forkSession?: boolean } = {},
  ): Promise<NewSessionResponse> {
    // We want to create a new session id unless it is resume,
    // but not resume + forkSession.
    let sessionId;
    if (creationOpts.forkSession) {
      sessionId = randomUUID();
    } else if (creationOpts.resume) {
      sessionId = creationOpts.resume;
    } else {
      sessionId = randomUUID();
    }

    const input = new Pushable<SDKUserMessage>();

    const settingsManager = new SettingsManager(params.cwd, {
      logger: this.logger,
    });
    await settingsManager.initialize();

    const mcpServers: Record<string, McpServerConfig> = {};
    if (Array.isArray(params.mcpServers)) {
      for (const server of params.mcpServers) {
        if ("type" in server) {
          mcpServers[server.name] = {
            type: server.type,
            url: server.url,
            headers: server.headers
              ? Object.fromEntries(server.headers.map((e) => [e.name, e.value]))
              : undefined,
          };
        } else {
          mcpServers[server.name] = {
            type: "stdio",
            command: server.command,
            args: server.args,
            env: server.env
              ? Object.fromEntries(server.env.map((e) => [e.name, e.value]))
              : undefined,
          };
        }
      }
    }

    // Only add the acp MCP server if built-in tools are not disabled
    if (!params._meta?.disableBuiltInTools) {
      const server = createMcpServer(this, sessionId, this.clientCapabilities);
      mcpServers["acp"] = {
        type: "sdk",
        name: "acp",
        instance: server,
      };
    }

    let systemPrompt: Options["systemPrompt"] = { type: "preset", preset: "claude_code" };
    if (params._meta?.systemPrompt) {
      const customPrompt = params._meta.systemPrompt;
      if (typeof customPrompt === "string") {
        systemPrompt = customPrompt;
      } else if (
        typeof customPrompt === "object" &&
        "append" in customPrompt &&
        typeof customPrompt.append === "string"
      ) {
        systemPrompt.append = customPrompt.append;
      }
    }

    const permissionMode = "default";

    // Extract options from _meta if provided
    const userProvidedOptions = (params._meta as NewSessionMeta | undefined)?.claudeCode?.options;
    const extraArgs = { ...userProvidedOptions?.extraArgs };
    if (creationOpts?.resume === undefined || creationOpts?.forkSession) {
      // Set our own session id if not resuming an existing session.
      extraArgs["session-id"] = sessionId;
    }

    // Configure thinking tokens from environment variable
    const maxThinkingTokens = process.env.MAX_THINKING_TOKENS
      ? parseInt(process.env.MAX_THINKING_TOKENS, 10)
      : undefined;

    // Build stderr handler that merges user callback with our logger
    const userStderr = userProvidedOptions?.stderr;
    const stderrHandler = userStderr
      ? (data: string) => {
          this.logger.error(data);
          userStderr(data);
        }
      : (data: string) => this.logger.error(data);

    // Determine executable: prefer user-provided, then env var, then process path
    const resolvedExecutable = (userProvidedOptions?.executable ?? process.execPath) as any;
    const resolvedPathToClaudeCodeExecutable =
      userProvidedOptions?.pathToClaudeCodeExecutable ??
      process.env.CLAUDE_CODE_EXECUTABLE ??
      undefined;

    const options: Options = {
      systemPrompt,
      settingSources: ["user", "project", "local"],
      ...(maxThinkingTokens !== undefined && { maxThinkingTokens }),
      // Spread user-provided options (fallbackModel, maxBudgetUsd,
      // additionalDirectories, executableArgs, spawnClaudeCodeProcess,
      // strictMcpConfig, agent, agents, outputFormat, enableFileCheckpointing,
      // betas, plugins, permissionPromptToolName, sandbox, persistSession,
      // resumeSessionAt, etc.)
      ...userProvidedOptions,
      // Override certain fields that must be controlled by ACP
      stderr: stderrHandler,
      cwd: params.cwd,
      includePartialMessages: true,
      mcpServers: { ...(userProvidedOptions?.mcpServers || {}), ...mcpServers },
      extraArgs,
      // If we want bypassPermissions to be an option, we have to allow it here.
      // But it doesn't work in root mode, so we only activate it if it will work.
      allowDangerouslySkipPermissions: !IS_ROOT,
      permissionMode,
      canUseTool: this.canUseTool(sessionId),
      executable: resolvedExecutable,
      ...(resolvedPathToClaudeCodeExecutable && {
        pathToClaudeCodeExecutable: resolvedPathToClaudeCodeExecutable,
      }),
      tools: { type: "preset", preset: "claude_code" },
      hooks: {
        // Spread all user-provided hooks first (supports all 13 hook events:
        // PreToolUse, PostToolUse, PostToolUseFailure, Notification,
        // UserPromptSubmit, SessionStart, SessionEnd, Stop,
        // SubagentStart, SubagentStop, PreCompact, PermissionRequest, Setup)
        ...userProvidedOptions?.hooks,
        PreToolUse: [
          ...(userProvidedOptions?.hooks?.PreToolUse || []),
          {
            hooks: [createPreToolUseHook(settingsManager, this.logger)],
          },
        ],
        PostToolUse: [
          ...(userProvidedOptions?.hooks?.PostToolUse || []),
          {
            hooks: [createPostToolUseHook(this.logger)],
          },
        ],
      },
      ...creationOpts,
    };

    const allowedTools = [];
    // Disable this for now, not a great way to expose this over ACP at the moment (in progress work so we can revisit)
    const disallowedTools = ["AskUserQuestion"];

    // Check if built-in tools should be disabled
    const disableBuiltInTools = params._meta?.disableBuiltInTools === true;

    if (!disableBuiltInTools) {
      if (this.clientCapabilities?.fs?.readTextFile) {
        allowedTools.push(acpToolNames.read);
        disallowedTools.push("Read");
      }
      if (this.clientCapabilities?.fs?.writeTextFile) {
        disallowedTools.push("Write", "Edit");
      }
      if (this.clientCapabilities?.terminal) {
        allowedTools.push(acpToolNames.bashOutput, acpToolNames.killShell);
        disallowedTools.push("Bash", "BashOutput", "KillShell");
      }
    } else {
      // When built-in tools are disabled, explicitly disallow all of them
      disallowedTools.push(
        acpToolNames.read,
        acpToolNames.write,
        acpToolNames.edit,
        acpToolNames.bash,
        acpToolNames.bashOutput,
        acpToolNames.killShell,
        "Read",
        "Write",
        "Edit",
        "Bash",
        "BashOutput",
        "KillShell",
        "Glob",
        "Grep",
        "Task",
        "TodoWrite",
        "ExitPlanMode",
        "WebSearch",
        "WebFetch",
        "AskUserQuestion",
        "SlashCommand",
        "Skill",
        "NotebookEdit",
      );
    }

    if (allowedTools.length > 0) {
      options.allowedTools = allowedTools;
    }
    if (disallowedTools.length > 0) {
      options.disallowedTools = disallowedTools;
    }

    // Handle abort controller from meta options
    const abortController = userProvidedOptions?.abortController;
    if (abortController?.signal.aborted) {
      throw new Error("Cancelled");
    }

    const q = query({
      prompt: input,
      options,
    });

    const router = new SessionMessageRouter(
      q,
      (msg) => this.handleTaskNotification(sessionId, msg),
      this.logger,
    );

    this.sessions[sessionId] = {
      query: q,
      router,
      input: input,
      cancelled: false,
      permissionMode,
      settingsManager,
    };

    const availableCommands = await getAvailableSlashCommands(q);
    const models = await getAvailableModels(q);

    // Needs to happen after we return the session
    setTimeout(() => {
      this.client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands,
        },
      });
    }, 0);

    const availableModes = [
      {
        id: "default",
        name: "Default",
        description: "Standard behavior, prompts for dangerous operations",
      },
      {
        id: "acceptEdits",
        name: "Accept Edits",
        description: "Auto-accept file edit operations",
      },
      {
        id: "plan",
        name: "Plan Mode",
        description: "Planning mode, no actual tool execution",
      },
      {
        id: "dontAsk",
        name: "Don't Ask",
        description: "Don't prompt for permissions, deny if not pre-approved",
      },
      {
        id: "delegate",
        name: "Delegate",
        description: "Delegation mode for sub-agents",
      },
    ];
    // Only works in non-root mode
    if (!IS_ROOT) {
      availableModes.push({
        id: "bypassPermissions",
        name: "Bypass Permissions",
        description: "Bypass all permission checks",
      });
    }

    return {
      sessionId,
      models,
      modes: {
        currentModeId: permissionMode,
        availableModes,
      },
    };
  }
}

async function getAvailableModels(query: Query): Promise<SessionModelState> {
  const models = await query.supportedModels();

  // Query doesn't give us access to the currently selected model, so we just choose the first model in the list.
  const currentModel = models[0];
  await query.setModel(currentModel.value);

  const availableModels = models.map((model) => ({
    modelId: model.value,
    name: model.displayName,
    description: model.description,
  }));

  return {
    availableModels,
    currentModelId: currentModel.value,
  };
}

async function getAvailableSlashCommands(query: Query): Promise<AvailableCommand[]> {
  const UNSUPPORTED_COMMANDS = [
    "cost",
    "login",
    "logout",
    "output-style:new",
    "release-notes",
    "todos",
  ];
  const commands = await query.supportedCommands();

  return commands
    .map((command) => {
      const input = command.argumentHint
        ? {
            hint: Array.isArray(command.argumentHint)
              ? command.argumentHint.join(" ")
              : command.argumentHint,
          }
        : null;
      let name = command.name;
      if (command.name.endsWith(" (MCP)")) {
        name = `mcp:${name.replace(" (MCP)", "")}`;
      }
      return {
        name,
        description: command.description || "",
        input,
      };
    })
    .filter((command: AvailableCommand) => !UNSUPPORTED_COMMANDS.includes(command.name));
}

function formatUriAsLink(uri: string): string {
  try {
    if (uri.startsWith("file://")) {
      const path = uri.slice(7); // Remove "file://"
      const name = path.split("/").pop() || path;
      return `[@${name}](${uri})`;
    } else if (uri.startsWith("zed://")) {
      const parts = uri.split("/");
      const name = parts[parts.length - 1] || uri;
      return `[@${name}](${uri})`;
    }
    return uri;
  } catch {
    return uri;
  }
}

export function promptToClaude(prompt: PromptRequest): SDKUserMessage {
  const content: any[] = [];
  const context: any[] = [];

  for (const chunk of prompt.prompt) {
    switch (chunk.type) {
      case "text": {
        let text = chunk.text;
        // change /mcp:server:command args -> /server:command (MCP) args
        const mcpMatch = text.match(/^\/mcp:([^:\s]+):(\S+)(\s+.*)?$/);
        if (mcpMatch) {
          const [, server, command, args] = mcpMatch;
          text = `/${server}:${command} (MCP)${args || ""}`;
        }
        content.push({ type: "text", text });
        break;
      }
      case "resource_link": {
        const formattedUri = formatUriAsLink(chunk.uri);
        content.push({
          type: "text",
          text: formattedUri,
        });
        break;
      }
      case "resource": {
        if ("text" in chunk.resource) {
          const formattedUri = formatUriAsLink(chunk.resource.uri);
          content.push({
            type: "text",
            text: formattedUri,
          });
          context.push({
            type: "text",
            text: `\n<context ref="${chunk.resource.uri}">\n${chunk.resource.text}\n</context>`,
          });
        }
        // Ignore blob resources (unsupported)
        break;
      }
      case "image":
        if (chunk.data) {
          content.push({
            type: "image",
            source: {
              type: "base64",
              data: chunk.data,
              media_type: chunk.mimeType,
            },
          });
        } else if (chunk.uri && chunk.uri.startsWith("http")) {
          content.push({
            type: "image",
            source: {
              type: "url",
              url: chunk.uri,
            },
          });
        }
        break;
      // Ignore audio and other unsupported types
      default:
        break;
    }
  }

  content.push(...context);

  return {
    type: "user",
    message: {
      role: "user",
      content: content,
    },
    session_id: prompt.sessionId,
    parent_tool_use_id: null,
  };
}

/**
 * Try to extract task_id and output_file from a background tool's response.
 * The response format varies: it can be an object with fields, a string, or
 * an array of content blocks containing the info as text.
 */
function extractBackgroundTaskInfo(response: unknown): {
  taskId?: string;
  outputFile?: string;
} {
  if (!response) return {};

  // Direct object with fields (e.g. { task_id: "abc", output_file: "/path" })
  if (typeof response === "object" && !Array.isArray(response)) {
    const obj = response as Record<string, unknown>;
    const taskId =
      (typeof obj.task_id === "string" ? obj.task_id : undefined) ||
      (typeof obj.agentId === "string" ? obj.agentId : undefined);
    const outputFile = typeof obj.output_file === "string" ? obj.output_file : undefined;
    if (taskId || outputFile) return { taskId, outputFile };
  }

  // Extract text to search for patterns
  let text: string;
  if (typeof response === "string") {
    text = response;
  } else if (Array.isArray(response)) {
    text = response
      .filter((c: any) => c?.type === "text" && typeof c?.text === "string")
      .map((c: any) => c.text)
      .join("\n");
  } else {
    try {
      text = JSON.stringify(response);
    } catch {
      return {};
    }
  }

  // Match task_id, agentId, or similar identifiers
  const taskIdMatch =
    text.match(/task[_\s-]?id[:\s]+["']?([^\s"',)]+)/i) ||
    text.match(/agentId[:\s]+["']?([^\s"',)]+)/i);
  const outputFileMatch = text.match(/output[_\s-]?file[:\s]+["']?([^\s"',)]+)/i);
  return {
    taskId: taskIdMatch?.[1],
    outputFile: outputFileMatch?.[1],
  };
}

/**
 * Convert an SDKAssistantMessage (Claude) to a SessionNotification (ACP).
 * Only handles text, image, and thinking chunks for now.
 */
export function toAcpNotifications(
  content: string | ContentBlockParam[] | BetaContentBlock[] | BetaRawContentBlockDelta[],
  role: "assistant" | "user",
  sessionId: string,
  toolUseCache: ToolUseCache,
  client: AgentSideConnection,
  logger: Logger,
  backgroundTaskMap?: Record<string, string>,
  parentToolUseId?: string | null,
): SessionNotification[] {
  if (typeof content === "string") {
    return [
      {
        sessionId,
        update: {
          sessionUpdate: role === "assistant" ? "agent_message_chunk" : "user_message_chunk",
          content: {
            type: "text",
            text: content,
          },
        },
      },
    ];
  }

  const output = [];
  // Only handle the first chunk for streaming; extend as needed for batching
  for (const chunk of content) {
    let update: SessionNotification["update"] | null = null;
    switch (chunk.type) {
      case "text":
      case "text_delta":
        update = {
          sessionUpdate: role === "assistant" ? "agent_message_chunk" : "user_message_chunk",
          content: {
            type: "text",
            text: chunk.text,
          },
        };
        break;
      case "image":
        update = {
          sessionUpdate: role === "assistant" ? "agent_message_chunk" : "user_message_chunk",
          content: {
            type: "image",
            data: chunk.source.type === "base64" ? chunk.source.data : "",
            mimeType: chunk.source.type === "base64" ? chunk.source.media_type : "",
            uri: chunk.source.type === "url" ? chunk.source.url : undefined,
          },
        };
        break;
      case "thinking":
      case "thinking_delta":
        update = {
          sessionUpdate: "agent_thought_chunk",
          content: {
            type: "text",
            text: chunk.thinking,
          },
        };
        break;
      case "tool_use":
      case "server_tool_use":
      case "mcp_tool_use": {
        toolUseCache[chunk.id] = chunk;
        if (chunk.name === "TodoWrite") {
          // @ts-expect-error - sometimes input is empty object
          if (Array.isArray(chunk.input.todos)) {
            update = {
              sessionUpdate: "plan",
              entries: planEntries(chunk.input as { todos: ClaudePlanEntry[] }),
            };
          }
        } else {
          // Register hook callback to receive the structured output from the hook
          registerHookCallback(chunk.id, {
            onPostToolUseHook: async (toolUseId, toolInput, toolResponse) => {
              const toolUse = toolUseCache[toolUseId];
              if (toolUse) {
                const hookInputObj = toolUse.input as
                  | Record<string, unknown>
                  | undefined;
                const hookIsBackground =
                  hookInputObj?.run_in_background === true;

                // Store mapping so we can match task_notification later
                if (hookIsBackground && backgroundTaskMap && toolResponse) {
                  const info = extractBackgroundTaskInfo(toolResponse);
                  if (info.taskId) backgroundTaskMap[info.taskId] = toolUseId;
                  if (info.outputFile)
                    backgroundTaskMap[`file:${info.outputFile}`] = toolUseId;
                }

                const update: SessionNotification["update"] = {
                  _meta: {
                    claudeCode: {
                      toolResponse,
                      toolName: toolUse.name,
                      ...(hookIsBackground && { isBackground: true }),
                      ...(parentToolUseId && { parentToolUseId }),
                    },
                  } satisfies ToolUpdateMeta,
                  toolCallId: toolUseId,
                  sessionUpdate: "tool_call_update",
                };
                await client.sessionUpdate({
                  sessionId,
                  update,
                });
              } else {
                logger.error(
                  `[claude-code-acp] Got a tool response for tool use that wasn't tracked: ${toolUseId}`,
                );
              }
            },
          });

          let rawInput;
          try {
            rawInput = JSON.parse(JSON.stringify(chunk.input));
          } catch {
            // ignore if we can't turn it to JSON
          }
          const inputObj = chunk.input as
            | Record<string, unknown>
            | undefined;
          const isBackground =
            inputObj?.run_in_background === true;
          update = {
            _meta: {
              claudeCode: {
                toolName: chunk.name,
                ...(isBackground && { isBackground: true }),
                ...(parentToolUseId && { parentToolUseId }),
              },
            } satisfies ToolUpdateMeta,
            toolCallId: chunk.id,
            sessionUpdate: "tool_call",
            rawInput,
            status: "pending",
            ...toolInfoFromToolUse(chunk),
          };
        }
        break;
      }

      case "tool_result":
      case "tool_search_tool_result":
      case "web_fetch_tool_result":
      case "web_search_tool_result":
      case "code_execution_tool_result":
      case "bash_code_execution_tool_result":
      case "text_editor_code_execution_tool_result":
      case "mcp_tool_result": {
        const toolUse = toolUseCache[chunk.tool_use_id];
        if (!toolUse) {
          logger.error(
            `[claude-code-acp] Got a tool result for tool use that wasn't tracked: ${chunk.tool_use_id}`,
          );
          break;
        }

        if (toolUse.name !== "TodoWrite") {
          const resultInputObj = toolUse.input as
            | Record<string, unknown>
            | undefined;
          const resultIsBackground =
            resultInputObj?.run_in_background === true;

          // Also try to establish task_id mapping from tool result content
          if (resultIsBackground && backgroundTaskMap) {
            const info = extractBackgroundTaskInfo(chunk.content);
            if (info.taskId)
              backgroundTaskMap[info.taskId] = chunk.tool_use_id;
            if (info.outputFile)
              backgroundTaskMap[`file:${info.outputFile}`] = chunk.tool_use_id;
          }

          update = {
            _meta: {
              claudeCode: {
                toolName: toolUse.name,
                ...(resultIsBackground && { isBackground: true }),
                ...(parentToolUseId && { parentToolUseId }),
              },
            } satisfies ToolUpdateMeta,
            toolCallId: chunk.tool_use_id,
            sessionUpdate: "tool_call_update",
            status: "is_error" in chunk && chunk.is_error ? "failed" : "completed",
            rawOutput: chunk.content,
            ...toolUpdateFromToolResult(chunk, toolUseCache[chunk.tool_use_id]),
          };
        }
        break;
      }

      case "document":
      case "search_result":
      case "redacted_thinking":
      case "input_json_delta":
      case "citations_delta":
      case "signature_delta":
      case "container_upload":
        break;

      default:
        unreachable(chunk, logger);
        break;
    }
    if (update) {
      output.push({ sessionId, update });
    }
  }

  return output;
}

export function streamEventToAcpNotifications(
  message: SDKPartialAssistantMessage,
  sessionId: string,
  toolUseCache: ToolUseCache,
  client: AgentSideConnection,
  logger: Logger,
  backgroundTaskMap?: Record<string, string>,
): SessionNotification[] {
  const event = message.event;
  const parentToolUseId = message.parent_tool_use_id;
  switch (event.type) {
    case "content_block_start":
      return toAcpNotifications(
        [event.content_block],
        "assistant",
        sessionId,
        toolUseCache,
        client,
        logger,
        backgroundTaskMap,
        parentToolUseId,
      );
    case "content_block_delta":
      return toAcpNotifications(
        [event.delta],
        "assistant",
        sessionId,
        toolUseCache,
        client,
        logger,
        backgroundTaskMap,
        parentToolUseId,
      );
    // No content
    case "message_start":
    case "message_delta":
    case "message_stop":
    case "content_block_stop":
      return [];

    default:
      unreachable(event, logger);
      return [];
  }
}

export function runAcp() {
  const input = nodeToWebWritable(process.stdout);
  const output = nodeToWebReadable(process.stdin);

  const stream = ndJsonStream(input, output);
  new AgentSideConnection((client) => new ClaudeAcpAgent(client), stream);
}
