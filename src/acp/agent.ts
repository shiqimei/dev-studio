/**
 * Slimmed ClaudeAcpAgent — orchestrator that delegates to sdk/, disk/, and acp/ modules.
 */
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
  ListSessionsRequest,
  ListSessionsResponse,
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
  SetSessionModelRequest,
  SetSessionModelResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import {
  CanUseTool,
  McpServerConfig,
  Options,
  PermissionMode,
  Query,
  query,
  SDKMessage,
  SDKSession,
  SDKSessionOptions,
  unstable_v2_createSession,
  unstable_v2_resumeSession,
} from "@anthropic-ai/claude-agent-sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { nodeToWebReadable, nodeToWebWritable, Pushable, unreachable } from "../utils.js";
import { createMcpServer } from "./mcp-server.js";
import { acpToolNames, EDIT_TOOL_NAMES } from "./types.js";
import { toolInfoFromToolUse } from "./tool-conversion.js";
import { createPostToolUseHook, createPreToolUseHook } from "../sdk/hooks.js";
import { toAcpNotifications, streamEventToAcpNotifications, promptToClaude } from "./notifications.js";
import { SessionMessageRouter } from "../sdk/message-router.js";
import { createCanUseTool } from "../sdk/permissions.js";
import { SettingsManager } from "../disk/settings.js";
import { CLAUDE_CONFIG_DIR } from "../disk/paths.js";
import { readSessionsIndex } from "../disk/sessions-index.js";
import type { ManagedSession } from "../sdk/types.js";
import type { Logger, NewSessionMeta, ToolUpdateMeta, ToolUseCache } from "./types.js";
import type { BackgroundTerminal } from "./background-tasks.js";
import { extractBackgroundTaskInfo } from "./background-tasks.js";
import packageJson from "../../package.json" with { type: "json" };
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

// Bypass Permissions doesn't work if we are a root/sudo user
const IS_ROOT = (process.geteuid?.() ?? process.getuid?.()) === 0;

/**
 * Creates a Query-like async iterator that replays the first result
 * and then forwards messages from the v2 stream.
 */
function createReplayQuery(
  firstResult: IteratorResult<SDKMessage, void>,
  stream: AsyncGenerator<SDKMessage, void>,
): Query {
  let replayed = false;
  const iterator = {
    async next(): Promise<IteratorResult<SDKMessage, void>> {
      if (!replayed) {
        replayed = true;
        if (firstResult.done) {
          return { value: undefined as any, done: true };
        }
        return firstResult;
      }
      return stream.next();
    },
  };

  // Return a minimal Query-like object that satisfies SessionMessageRouter
  return iterator as unknown as Query;
}

// Implement the ACP Agent interface
export class ClaudeAcpAgent implements Agent {
  sessions: {
    [key: string]: ManagedSession;
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
          list: {},
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

    const session = this.sessions[params.sessionId];
    session.cancelled = false;

    const { router } = session;

    const promptMessage = promptToClaude(params);

    // Update session metadata
    if (!session.title) {
      // Set title from first user prompt text
      const firstText = params.prompt.find((c) => c.type === "text");
      if (firstText && "text" in firstText) {
        session.title = firstText.text.slice(0, 100);
        this.client.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "session_info_update" as any,
            title: session.title,
          } as any,
        }).catch((err) => {
          this.logger.error("[claude-code-acp] session_info_update failed:", err);
        });
      }
    }
    session.updatedAt = new Date().toISOString();

    if (session.sdkSession) {
      await session.sdkSession.send(promptMessage);
    } else {
      session.input!.push(promptMessage);
    }
    while (true) {
      const { value: message, done } = await router.next();
      if (done || !message) {
        if (session.cancelled) {
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
              break;
            case "hook_started":
            case "hook_progress":
            case "hook_response":
              // Hook lifecycle events - logged but not forwarded to ACP client
              break;
            case "status":
              // Forward compaction status as an agent message
              if (message.status === "compacting") {
                await this.client.sessionUpdate({
                  sessionId: params.sessionId,
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: {
                      type: "text",
                      text: "[Compacting conversation context...]",
                    },
                  },
                });
              }
              break;
            case "files_persisted":
              break;
            default:
              unreachable(message, this.logger);
              break;
          }
          break;
        case "result": {
          if (session.cancelled) {
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
          if (session.cancelled) {
            break;
          }

          // Slash commands like /compact can generate invalid output
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
          // Skip these user messages for now
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
              ? message.message.content.filter(
                  (item) =>
                    !["text", "thinking", "tool_use", "server_tool_use", "mcp_tool_use"].includes(
                      item.type,
                    ),
                )
              : Array.isArray(message.message.content)
                ? message.message.content.filter(
                    (item) =>
                      ![
                        "tool_result",
                        "tool_search_tool_result",
                        "web_fetch_tool_result",
                        "web_search_tool_result",
                        "code_execution_tool_result",
                        "bash_code_execution_tool_result",
                        "text_editor_code_execution_tool_result",
                        "mcp_tool_result",
                      ].includes(item.type),
                  )
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
        case "tool_progress": {
          // Forward tool progress as in_progress tool_call_update
          const toolUse = this.toolUseCache[message.tool_use_id];
          if (toolUse) {
            await this.client.sessionUpdate({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: message.tool_use_id,
                status: "in_progress",
                _meta: {
                  claudeCode: {
                    toolName: toolUse.name,
                    elapsed_time_seconds: message.elapsed_time_seconds,
                    ...(message.parent_tool_use_id && {
                      parentToolUseId: message.parent_tool_use_id,
                    }),
                  },
                },
              },
            });
          }
          break;
        }
        case "tool_use_summary":
          // Forward collapsed tool descriptions as agent message
          if (message.summary) {
            await this.client.sessionUpdate({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: {
                  type: "text",
                  text: message.summary,
                },
              },
            });
          }
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
    const session = this.sessions[params.sessionId];
    if (!session) {
      throw new Error("Session not found");
    }
    session.cancelled = true;
    if (session.sdkSession) {
      session.sdkSession.close();
    } else {
      await session.query!.interrupt();
    }
  }

  async unstable_setSessionModel(
    params: SetSessionModelRequest,
  ): Promise<SetSessionModelResponse | void> {
    const session = this.sessions[params.sessionId];
    if (!session) {
      throw new Error("Session not found");
    }
    if (!session.query) {
      throw new Error("setSessionModel not supported on v2 sessions");
    }
    await session.query.setModel(params.modelId);
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = this.sessions[params.sessionId];
    if (!session) {
      throw new Error("Session not found");
    }

    switch (params.modeId) {
      case "default":
      case "acceptEdits":
      case "bypassPermissions":
      case "dontAsk":
      case "plan":
      case "delegate":
        session.permissionMode = params.modeId as PermissionMode;
        try {
          if (session.query) {
            await session.query.setPermissionMode(params.modeId as PermissionMode);
          }
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

  async setMaxThinkingTokens(sessionId: string, maxThinkingTokens: number | null): Promise<void> {
    const session = this.sessions[sessionId];
    if (!session) throw new Error("Session not found");
    if (!session.query) throw new Error("setMaxThinkingTokens not supported on v2 sessions");
    await session.query.setMaxThinkingTokens(maxThinkingTokens);
  }

  async mcpServerStatus(sessionId: string) {
    const session = this.sessions[sessionId];
    if (!session) throw new Error("Session not found");
    if (!session.query) throw new Error("mcpServerStatus not supported on v2 sessions");
    return await session.query.mcpServerStatus();
  }

  async reconnectMcpServer(sessionId: string, serverName: string): Promise<void> {
    const session = this.sessions[sessionId];
    if (!session) throw new Error("Session not found");
    if (!session.query) throw new Error("reconnectMcpServer not supported on v2 sessions");
    await session.query.reconnectMcpServer(serverName);
  }

  async toggleMcpServer(sessionId: string, serverName: string, enabled: boolean): Promise<void> {
    const session = this.sessions[sessionId];
    if (!session) throw new Error("Session not found");
    if (!session.query) throw new Error("toggleMcpServer not supported on v2 sessions");
    await session.query.toggleMcpServer(serverName, enabled);
  }

  async setMcpServers(sessionId: string, servers: Record<string, McpServerConfig>) {
    const session = this.sessions[sessionId];
    if (!session) throw new Error("Session not found");
    if (!session.query) throw new Error("setMcpServers not supported on v2 sessions");
    return await session.query.setMcpServers(servers);
  }

  async accountInfo(sessionId: string) {
    const session = this.sessions[sessionId];
    if (!session) throw new Error("Session not found");
    if (!session.query) throw new Error("accountInfo not supported on v2 sessions");
    return await session.query.accountInfo();
  }

  async rewindFiles(sessionId: string, userMessageId: string, opts?: { dryRun?: boolean }) {
    const session = this.sessions[sessionId];
    if (!session) throw new Error("Session not found");
    if (!session.query) throw new Error("rewindFiles not supported on v2 sessions");
    return await session.query.rewindFiles(userMessageId, opts);
  }

  /** Creates a canUseTool callback bound to a specific session. */
  canUseTool(sessionId: string): CanUseTool {
    return createCanUseTool(sessionId, this.sessions, this.client);
  }

  close(sessionId: string): void {
    const session = this.sessions[sessionId];
    if (!session) throw new Error("Session not found");
    if (session.sdkSession) {
      session.sdkSession.close();
    } else if (session.query) {
      session.query.close();
    }
    delete this.sessions[sessionId];
  }

  private async createSession(
    params: NewSessionRequest,
    creationOpts: { resume?: string; forkSession?: boolean } = {},
  ): Promise<NewSessionResponse> {
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
      ...userProvidedOptions,
      stderr: stderrHandler,
      cwd: params.cwd,
      includePartialMessages: true,
      mcpServers: { ...(userProvidedOptions?.mcpServers || {}), ...mcpServers },
      extraArgs,
      allowDangerouslySkipPermissions: !IS_ROOT,
      permissionMode,
      canUseTool: createCanUseTool(sessionId, this.sessions, this.client),
      executable: resolvedExecutable,
      ...(resolvedPathToClaudeCodeExecutable && {
        pathToClaudeCodeExecutable: resolvedPathToClaudeCodeExecutable,
      }),
      tools: { type: "preset", preset: "claude_code" },
      hooks: {
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
    const disallowedTools = ["AskUserQuestion"];

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
      title: null,
      cwd: params.cwd,
      updatedAt: new Date().toISOString(),
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

  private async createSessionV2(
    params: NewSessionRequest,
    creationOpts: { resume?: string } = {},
  ): Promise<NewSessionResponse> {
    const settingsManager = new SettingsManager(params.cwd, {
      logger: this.logger,
    });
    await settingsManager.initialize();

    const permissionMode: PermissionMode = "default";

    const model = process.env.CLAUDE_MODEL || "sonnet";

    const userProvidedOptions = (params._meta as NewSessionMeta | undefined)?.claudeCode?.options;
    const resolvedPathToClaudeCodeExecutable =
      userProvidedOptions?.pathToClaudeCodeExecutable ??
      process.env.CLAUDE_CODE_EXECUTABLE ??
      undefined;

    const env: Record<string, string | undefined> = { ...process.env };
    if (process.env.MAX_THINKING_TOKENS) {
      env.MAX_THINKING_TOKENS = process.env.MAX_THINKING_TOKENS;
    }

    const allowedTools: string[] = [];
    const disallowedTools = ["AskUserQuestion"];

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
    }

    const sessionOpts: SDKSessionOptions = {
      model,
      ...(resolvedPathToClaudeCodeExecutable && {
        pathToClaudeCodeExecutable: resolvedPathToClaudeCodeExecutable,
      }),
      env,
      allowedTools: allowedTools.length > 0 ? allowedTools : undefined,
      disallowedTools: disallowedTools.length > 0 ? disallowedTools : undefined,
      canUseTool: createCanUseTool("__pending__", this.sessions, this.client),
      hooks: {
        ...userProvidedOptions?.hooks,
        PreToolUse: [
          ...(userProvidedOptions?.hooks?.PreToolUse || []),
          { hooks: [createPreToolUseHook(settingsManager, this.logger)] },
        ],
        PostToolUse: [
          ...(userProvidedOptions?.hooks?.PostToolUse || []),
          { hooks: [createPostToolUseHook(this.logger)] },
        ],
      },
      permissionMode,
    };

    let sdkSession: SDKSession;
    if (creationOpts.resume) {
      sdkSession = unstable_v2_resumeSession(creationOpts.resume, sessionOpts);
    } else {
      sdkSession = unstable_v2_createSession(sessionOpts);
    }

    const stream = sdkSession.stream();

    const firstResult = await stream.next();
    let sessionId: string;
    if (
      firstResult.value &&
      firstResult.value.type === "system" &&
      firstResult.value.subtype === "init"
    ) {
      sessionId = firstResult.value.session_id || sdkSession.sessionId;
    } else {
      try {
        sessionId = sdkSession.sessionId;
      } catch {
        sessionId = creationOpts.resume || randomUUID();
      }
    }

    sessionOpts.canUseTool = createCanUseTool(sessionId, this.sessions, this.client);

    const replayQuery = createReplayQuery(firstResult, stream);

    const router = new SessionMessageRouter(
      replayQuery,
      (msg) => this.handleTaskNotification(sessionId, msg),
      this.logger,
    );

    this.sessions[sessionId] = {
      sdkSession,
      router,
      cancelled: false,
      permissionMode,
      settingsManager,
      title: null,
      cwd: params.cwd,
      updatedAt: new Date().toISOString(),
    };

    const availableModes = [
      { id: "default", name: "Default", description: "Standard behavior, prompts for dangerous operations" },
      { id: "acceptEdits", name: "Accept Edits", description: "Auto-accept file edit operations" },
      { id: "plan", name: "Plan Mode", description: "Planning mode, no actual tool execution" },
      { id: "dontAsk", name: "Don't Ask", description: "Don't prompt for permissions, deny if not pre-approved" },
      { id: "delegate", name: "Delegate", description: "Delegation mode for sub-agents" },
    ];
    if (!IS_ROOT) {
      availableModes.push({ id: "bypassPermissions", name: "Bypass Permissions", description: "Bypass all permission checks" });
    }

    return {
      sessionId,
      modes: {
        currentModeId: permissionMode,
        availableModes,
      },
    };
  }

  async unstable_listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    const sessionsMap = new Map<string, { sessionId: string; cwd: string; title: string | null; updatedAt: string | null }>();

    // Read sessions from ~/.claude/projects on disk
    const projectsDir = path.join(CLAUDE_CONFIG_DIR, "projects");
    try {
      const projectDirs = params.cwd
        ? [path.join(projectsDir, params.cwd.replace(/\//g, "-"))]
        : fs.readdirSync(projectsDir, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => path.join(projectsDir, d.name));

      for (const dir of projectDirs) {
        const entries = readSessionsIndex(dir);
        for (const entry of entries) {
          const cwd = entry.projectPath || dir.replace(projectsDir + "/", "").replace(/-/g, "/");
          if (params.cwd && cwd !== params.cwd) continue;
          sessionsMap.set(entry.sessionId, {
            sessionId: entry.sessionId,
            cwd,
            title: entry.firstPrompt?.slice(0, 100) ?? null,
            updatedAt: entry.modified ?? entry.created ?? null,
          });
        }
      }
    } catch {
      // ~/.claude/projects may not exist
    }

    // Overlay in-memory sessions (they have more up-to-date metadata)
    for (const [id, s] of Object.entries(this.sessions)) {
      if (params.cwd && s.cwd !== params.cwd) continue;
      sessionsMap.set(id, {
        sessionId: id,
        cwd: s.cwd,
        title: s.title,
        updatedAt: s.updatedAt,
      });
    }

    const sessions = Array.from(sessionsMap.values()).sort((a, b) => {
      const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return tb - ta;
    });

    return { sessions };
  }
}

async function getAvailableModels(query: Query): Promise<SessionModelState> {
  const models = await query.supportedModels();

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

export function runAcp() {
  const input = nodeToWebWritable(process.stdout);
  const output = nodeToWebReadable(process.stdin);

  const stream = ndJsonStream(input, output);
  new AgentSideConnection((client) => new ClaudeAcpAgent(client), stream);
}
