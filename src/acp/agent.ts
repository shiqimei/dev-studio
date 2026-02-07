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
import {
  systemInitNotification,
  hookStartedNotification,
  hookProgressNotification,
  hookResponseNotification,
  compactBoundaryNotification,
  filesPersistedNotification,
  authStatusNotification,
} from "./system-notifications.js";
import { SessionMessageRouter } from "../sdk/message-router.js";
import { createCanUseTool } from "../sdk/permissions.js";
import { SettingsManager } from "../disk/settings.js";
import { CLAUDE_CONFIG_DIR, getProjectDir } from "../disk/paths.js";
import { readStatsCache } from "../disk/stats.js";
import { readSessionTasks } from "../disk/tasks.js";
import { listCommandNames } from "../disk/commands.js";
import { listPluginNames } from "../disk/plugins.js";
import { listSkillNames } from "../disk/skills.js";
import { readSessionsIndex, renameSessionOnDisk, deleteSessionFromDisk } from "../disk/sessions-index.js";
import { readSessionHistoryFull, readSubagentHistoryFull } from "../disk/session-history.js";
import { readSubagents, buildSubagentTree, readSessionTeamInfo, findTeamCreateInSession } from "../disk/subagents.js";
import type { ManagedSession } from "../sdk/types.js";
import type { SessionIndexEntry } from "../disk/types.js";
import type { Logger, NewSessionMeta, ToolUpdateMeta, ToolUseCache } from "./types.js";
import type { BackgroundTerminal } from "./background-tasks.js";
import { extractBackgroundTaskInfo } from "./background-tasks.js";
import { NotificationQueue } from "./notification-queue.js";
import { perfScope, type PerfScope } from "../utils/perf.js";
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
  let saved: IteratorResult<SDKMessage, void> | null = firstResult;
  const iterator = {
    async next(): Promise<IteratorResult<SDKMessage, void>> {
      if (saved) {
        const result = saved;
        saved = null; // Release reference after replay
        if (result.done) {
          return { value: undefined as any, done: true };
        }
        return result;
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
  /** Shared SettingsManagers keyed by cwd — avoids duplicate file watchers */
  private settingsManagerCache = new Map<string, { manager: SettingsManager; refCount: number }>();

  constructor(client: AgentSideConnection, logger?: Logger) {
    this.sessions = {};
    this.client = client;
    this.toolUseCache = {};
    this.logger = logger ?? console;
  }

  /** Get or create a shared SettingsManager for the given cwd. */
  private async acquireSettingsManager(cwd: string): Promise<SettingsManager> {
    const existing = this.settingsManagerCache.get(cwd);
    if (existing) {
      existing.refCount++;
      return existing.manager;
    }
    const manager = new SettingsManager(cwd, { logger: this.logger });
    await manager.initialize();
    this.settingsManagerCache.set(cwd, { manager, refCount: 1 });
    return manager;
  }

  /** Release a shared SettingsManager reference. Disposes when refCount reaches 0. */
  private releaseSettingsManager(cwd: string): void {
    const entry = this.settingsManagerCache.get(cwd);
    if (!entry) return;
    entry.refCount--;
    if (entry.refCount <= 0) {
      entry.manager.dispose();
      this.settingsManagerCache.delete(cwd);
    }
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
      // Clean up maps — evict the tool use cache entry for this background task
      delete this.toolUseCache[toolCallId];
      delete this.backgroundTaskMap[taskNotif.task_id];
      delete this.backgroundTaskMap[`file:${taskNotif.output_file}`];
    } else {
      this.logger.log(
        `[claude-code-acp] task_notification for unmapped task: ${taskNotif.task_id}`,
      );
    }
  }

  async initialize(request: InitializeRequest): Promise<InitializeResponse> {
    const t0 = performance.now();
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

    const result = {
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
    console.error(`[perf] initialize ${(performance.now() - t0).toFixed(0)}ms`);
    return result;
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const t0 = performance.now();
    // Check auth status without blocking the event loop
    try {
      await fs.promises.access(path.resolve(os.homedir(), ".claude.json.backup"));
      try {
        await fs.promises.access(path.resolve(os.homedir(), ".claude.json"));
      } catch {
        // .claude.json.backup exists but .claude.json doesn't — auth required
        throw RequestError.authRequired();
      }
    } catch (e) {
      if (e instanceof RequestError) throw e;
      // .claude.json.backup doesn't exist — OK, continue
    }

    const result = await this.createSession(params, {
      resume: (params._meta as NewSessionMeta | undefined)?.claudeCode?.options?.resume,
    });
    console.error(`[perf] newSession ${result.sessionId.slice(0, 8)} ${(performance.now() - t0).toFixed(0)}ms`);
    return result;
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
    const t0 = performance.now();
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
    console.error(`[perf] unstable_resumeSession ${params.sessionId.slice(0, 8)} ${(performance.now() - t0).toFixed(0)}ms`);
    return response;
  }

  async authenticate(_params: AuthenticateRequest): Promise<void> {
    throw new Error("Method not implemented.");
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    if (!this.sessions[params.sessionId]) {
      throw new Error("Session not found");
    }

    const perf = perfScope("prompt");

    // Non-blocking notification queue — enqueue() returns immediately,
    // flush() drains before we return the result.
    const queue = new NotificationQueue(this.client, this.logger);

    // Helper: fire-and-forget for non-critical notifications (streaming, progress, chunks)
    const enqueue = (label: string, notification: Parameters<typeof this.client.sessionUpdate>[0]) => {
      perf.start(label).end();
      queue.enqueue(notification);
    };

    // Helper: awaited send for critical notifications (results, errors, tool cache updates)
    const timedUpdate = async (label: string, notification: Parameters<typeof this.client.sessionUpdate>[0]) => {
      const s = perf.start(label);
      await queue.send(notification);
      s.end();
    };

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
    // Cache stats from system.init to avoid re-reading at result
    let cachedStats: Awaited<ReturnType<typeof readStatsCache>> = null;
    while (true) {
      const waitSpan = perf.start("router.next");
      const { value: message, done } = await router.next();
      waitSpan.end({ bufferDepth: router.bufferDepth });
      if (done || !message) {
        if (session.cancelled) {
          await queue.flush();
          perf.summary();
          return { stopReason: "cancelled" };
        }
        break;
      }

      switch (message.type) {
        case "system":
          switch (message.subtype) {
            case "init": {
              // Read all disk metadata in parallel
              const [stats, commands, plugins, skills] = await Promise.all([
                readStatsCache(),
                listCommandNames(),
                listPluginNames(),
                listSkillNames(),
              ]);
              cachedStats = stats;
              enqueue("sessionUpdate.system.init",
                systemInitNotification(params.sessionId, message as unknown as Record<string, unknown>, {
                  stats: stats
                    ? { lastComputedDate: stats.lastComputedDate, recentActivity: stats.dailyActivity.slice(-7) }
                    : undefined,
                  diskCommands: commands.length > 0 ? commands : undefined,
                  diskPlugins: plugins.length > 0 ? plugins : undefined,
                  diskSkills: skills.length > 0 ? skills : undefined,
                }),
              );
              break;
            }
            case "task_notification":
              // Intercepted by SessionMessageRouter (handles between turns too)
              break;
            case "compact_boundary":
              enqueue("sessionUpdate.compact_boundary",
                compactBoundaryNotification(params.sessionId, message as unknown as Record<string, unknown>),
              );
              break;
            case "hook_started":
              enqueue("sessionUpdate.hook_started",
                hookStartedNotification(params.sessionId, message as unknown as Record<string, unknown>),
              );
              break;
            case "hook_progress":
              enqueue("sessionUpdate.hook_progress",
                hookProgressNotification(params.sessionId, message as unknown as Record<string, unknown>),
              );
              break;
            case "hook_response":
              enqueue("sessionUpdate.hook_response",
                hookResponseNotification(params.sessionId, message as unknown as Record<string, unknown>),
              );
              break;
            case "status":
              // Forward compaction status as an agent message
              if (message.status === "compacting") {
                enqueue("sessionUpdate.compacting", {
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
              enqueue("sessionUpdate.files_persisted",
                filesPersistedNotification(params.sessionId, message as unknown as Record<string, unknown>),
              );
              break;
            default:
              unreachable(message, this.logger);
              break;
          }
          break;
        case "result": {
          if (session.cancelled) {
            await queue.flush();
            perf.summary();
            return { stopReason: "cancelled" };
          }

          // Use cached stats from init (avoid duplicate disk read)
          const resultStats = cachedStats;

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
              ...(resultStats && {
                stats: {
                  lastComputedDate: resultStats.lastComputedDate,
                  recentActivity: resultStats.dailyActivity.slice(-7),
                },
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
              await queue.flush();
              perf.summary();
              return { stopReason: "end_turn", _meta: resultMeta };
            }
            case "error_during_execution":
              if (message.is_error) {
                throw RequestError.internalError(
                  undefined,
                  message.errors.join(", ") || message.subtype,
                );
              }
              await queue.flush();
              perf.summary();
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
              await queue.flush();
              perf.summary();
              return { stopReason: "max_turn_requests", _meta: resultMeta };
            default:
              unreachable(message, this.logger);
              break;
          }
          break;
        }
        case "stream_event": {
          const convSpan = perf.start("convert.stream_event");
          const notifications = streamEventToAcpNotifications(
            message,
            params.sessionId,
            this.toolUseCache,
            this.client,
            this.logger,
            this.backgroundTaskMap,
          );
          convSpan.end({ count: notifications.length });
          for (const notification of notifications) {
            enqueue("sessionUpdate.stream_event", notification);
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

          // Update toolUseCache with complete tool_use blocks from the final
          // assistant message.  During streaming, content_block_start only has
          // input: {} — the complete input arrives here.
          // After updating the cache, send tool_call_update with the now-complete
          // rawInput, title, content, and locations so live sessions match history.
          if (message.type === "assistant" && Array.isArray(message.message.content)) {
            for (const item of message.message.content) {
              const t = (item as any).type;
              const id = (item as any).id;
              if (["tool_use", "server_tool_use", "mcp_tool_use"].includes(t) && id) {
                this.toolUseCache[id] = item as any;

                // Send tool_call_update with complete input now that we have it
                const toolUse = item as any;
                if (toolUse.name !== "TodoWrite") {
                  let rawInput;
                  try {
                    rawInput = structuredClone(toolUse.input);
                  } catch {
                    // ignore
                  }
                  const inputObj = toolUse.input as Record<string, unknown> | undefined;
                  const isBackground = inputObj?.run_in_background === true;
                  const info = toolInfoFromToolUse(toolUse);
                  await timedUpdate("sessionUpdate.tool_cache_update", {
                    sessionId: params.sessionId,
                    update: {
                      sessionUpdate: "tool_call_update",
                      toolCallId: id,
                      rawInput,
                      ...info,
                      _meta: {
                        claudeCode: {
                          toolName: toolUse.name,
                          ...(isBackground && { isBackground: true }),
                          ...((message as any).parent_tool_use_id && {
                            parentToolUseId: (message as any).parent_tool_use_id,
                          }),
                        },
                      } satisfies ToolUpdateMeta,
                    },
                  });
                }
              }
            }
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
                        // Keep "tool_result" — it generates tool_call_update with
                        // status + content for client-side tools (Read, Edit, etc.)
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

          const msgConvSpan = perf.start("convert.message");
          const msgNotifications = toAcpNotifications(
            content,
            message.message.role,
            params.sessionId,
            this.toolUseCache,
            this.client,
            this.logger,
            this.backgroundTaskMap,
            (message as any).parent_tool_use_id,
          );
          msgConvSpan.end({ count: msgNotifications.length, role: message.message.role });
          for (const notification of msgNotifications) {
            enqueue("sessionUpdate.message", notification);
          }
          break;
        }
        case "tool_progress": {
          // Forward tool progress as in_progress tool_call_update
          const toolUse = this.toolUseCache[message.tool_use_id];
          if (toolUse) {
            enqueue("sessionUpdate.tool_progress", {
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
        case "tool_use_summary": {
          // Forward collapsed tool descriptions as agent message
          if (message.summary) {
            enqueue("sessionUpdate.tool_summary", {
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

          // Check for task state after tool summaries (e.g., TodoWrite results)
          const tasks = await readSessionTasks(params.sessionId);
          if (tasks.length > 0) {
            enqueue("sessionUpdate.task_state", {
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "session_info_update" as any,
                _meta: {
                  claudeCode: {
                    eventType: "task_state",
                    tasks,
                  },
                },
              } as any,
            });
          }
          break;
        }
        case "auth_status":
          enqueue("sessionUpdate.auth_status",
            authStatusNotification(params.sessionId, message as unknown as Record<string, unknown>),
          );
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

  async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const extT0 = performance.now();
    try {
    switch (method) {
      case "sessions/list": {
        const result = await this.unstable_listSessions({ cwd: params.cwd as string | undefined });
        return result as unknown as Record<string, unknown>;
      }

      case "sessions/getHistory": {
        const sessionId = params.sessionId as string;
        if (!sessionId) throw new Error("sessionId is required");
        const t0 = performance.now();
        const projectDir = getProjectDir(params.cwd as string | undefined);
        const entries = await readSessionHistoryFull(projectDir, sessionId);
        const t1 = performance.now();
        console.error(`[extMethod] sessions/getHistory ${sessionId.slice(0, 8)} read=${(t1 - t0).toFixed(0)}ms entries=${entries.length}`);
        return { entries };
      }

      case "sessions/getSubagentHistory": {
        const sessionId = params.sessionId as string;
        const agentId = params.agentId as string;
        if (!sessionId || !agentId) throw new Error("sessionId and agentId are required");
        const t0 = performance.now();
        const projectDir = getProjectDir(params.cwd as string | undefined);
        const entries = await readSubagentHistoryFull(projectDir, sessionId, agentId);
        const t1 = performance.now();
        console.error(`[extMethod] sessions/getSubagentHistory ${sessionId.slice(0, 8)}:${agentId.slice(0, 8)} read=${(t1 - t0).toFixed(0)}ms entries=${entries.length}`);
        return { entries };
      }

      case "sessions/rename": {
        const t0 = performance.now();
        const sessionId = params.sessionId as string;
        const title = params.title as string;
        if (!sessionId || !title) throw new Error("sessionId and title are required");
        const projectDir = getProjectDir(params.cwd as string | undefined);
        const diskSuccess = await renameSessionOnDisk(projectDir, sessionId, title);
        // Also update in-memory session title (live sessions may not be on disk yet)
        const liveSession = this.sessions[sessionId];
        if (liveSession) {
          liveSession.title = title;
        }
        console.error(`[extMethod] sessions/rename ${sessionId.slice(0, 8)} ${(performance.now() - t0).toFixed(0)}ms`);
        return { success: diskSuccess || !!liveSession };
      }

      case "sessions/delete": {
        const t0 = performance.now();
        const sessionId = params.sessionId as string;
        if (!sessionId) throw new Error("sessionId is required");
        const projectDir = getProjectDir(params.cwd as string | undefined);

        // Collect child session IDs (teammates) that should be deleted too
        const deletedIds: string[] = [];

        // Check if this session is a team leader with teammate sessions
        const teamInfo = await readSessionTeamInfo(projectDir, sessionId);
        if (teamInfo && !teamInfo.agentName) {
          // This is a team leader — find all teammates with the same teamName
          const allEntries = await readSessionsIndex(projectDir);
          // Read team info for all entries in parallel
          const entryTeams = await Promise.all(
            allEntries
              .filter((entry) => entry.sessionId !== sessionId)
              .map(async (entry) => ({
                entry,
                team: await readSessionTeamInfo(projectDir, entry.sessionId),
              })),
          );
          for (const { entry, team } of entryTeams) {
            if (team?.teamName === teamInfo.teamName && team.agentName) {
              if (await deleteSessionFromDisk(projectDir, entry.sessionId)) {
                deletedIds.push(entry.sessionId);
              }
            }
          }
        }

        const success = await deleteSessionFromDisk(projectDir, sessionId);
        if (success) deletedIds.push(sessionId);
        console.error(`[extMethod] sessions/delete ${sessionId.slice(0, 8)} ${(performance.now() - t0).toFixed(0)}ms deletedIds=${deletedIds.length}`);
        return { success, deletedIds };
      }

      default:
        throw RequestError.methodNotFound(method);
    }
    } finally {
      console.error(`[perf] extMethod(${method}) total=${(performance.now() - extT0).toFixed(0)}ms`);
    }
  }

  close(sessionId: string): void {
    const session = this.sessions[sessionId];
    if (!session) throw new Error("Session not found");
    if (session.sdkSession) {
      session.sdkSession.close();
    } else if (session.query) {
      session.query.close();
    }
    // Clear any pending timers
    if (session.pendingTimers) {
      for (const timer of session.pendingTimers) clearTimeout(timer);
    }
    // Release shared settings manager reference
    if (session.cwd) {
      this.releaseSettingsManager(session.cwd);
    }
    // Clean up background resources for this session
    for (const [key, toolCallId] of Object.entries(this.backgroundTaskMap)) {
      if (this.toolUseCache[toolCallId]) {
        delete this.backgroundTaskMap[key];
      }
    }
    delete this.sessions[sessionId];
  }

  private async createSession(
    params: NewSessionRequest,
    creationOpts: { resume?: string; forkSession?: boolean } = {},
  ): Promise<NewSessionResponse> {
    const perf = perfScope("createSession");

    let sessionId;
    if (creationOpts.forkSession) {
      sessionId = randomUUID();
    } else if (creationOpts.resume) {
      sessionId = creationOpts.resume;
    } else {
      sessionId = randomUUID();
    }

    const input = new Pushable<SDKUserMessage>();

    const settingsSpan = perf.start("settingsManager.acquire");
    const settingsManager = await this.acquireSettingsManager(params.cwd);
    settingsSpan.end();

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

    const querySpan = perf.start("sdk.query");
    const q = query({
      prompt: input,
      options,
    });
    querySpan.end();

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

    const cmdsSpan = perf.start("getAvailableCommands");
    const [availableCommands, models] = await Promise.all([
      getAvailableSlashCommands(q),
      getAvailableModels(q),
    ]);
    cmdsSpan.end();

    perf.summary();

    // Needs to happen after we return the session — track timer for cleanup on close
    const session = this.sessions[sessionId];
    if (!session.pendingTimers) session.pendingTimers = [];
    session.pendingTimers.push(
      setTimeout(() => {
        this.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands,
          },
        });
      }, 0),
    );

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
    const perf = perfScope("listSessions");

    const cwd = params.cwd ?? undefined;
    const projectDir = getProjectDir(cwd);
    const indexSpan = perf.start("readSessionsIndex");
    const entries = await readSessionsIndex(projectDir);
    indexSpan.end({ count: entries.length });

    // Merge live sessions that aren't on disk yet
    const diskSessionIds = new Set(entries.map((e) => e.sessionId));
    for (const [sessionId, session] of Object.entries(this.sessions)) {
      if (!diskSessionIds.has(sessionId)) {
        entries.push({
          sessionId,
          firstPrompt: session.title ?? undefined,
          created: session.updatedAt,
          modified: session.updatedAt,
        } as SessionIndexEntry);
      }
    }

    // Override disk titles with in-memory titles for live sessions (e.g. after rename)
    for (const entry of entries) {
      const liveSession = this.sessions[entry.sessionId];
      if (liveSession?.title) {
        entry.firstPrompt = liveSession.title;
      }
    }

    // Read team metadata for ALL sessions in parallel (was serial before)
    const teamSpan = perf.start("readTeamMetadata");
    const teamInfoMap = new Map<string, { teamName: string; agentName?: string }>();
    const teamResults = await Promise.all(
      entries.map(async (e) => ({
        sessionId: e.sessionId,
        info: await readSessionTeamInfo(projectDir, e.sessionId),
      })),
    );
    for (const { sessionId, info } of teamResults) {
      if (info) teamInfoMap.set(sessionId, info);
    }
    teamSpan.end({ sessions: entries.length, teamsFound: teamInfoMap.size });

    // Group teammates by teamName → { leader sessionId, teammate sessionIds[] }
    const teamGroups = new Map<string, { leaderSessionId: string | null; teammates: string[] }>();
    for (const [sessionId, info] of teamInfoMap) {
      if (!teamGroups.has(info.teamName)) {
        teamGroups.set(info.teamName, { leaderSessionId: null, teammates: [] });
      }
      const group = teamGroups.get(info.teamName)!;
      if (info.agentName) {
        group.teammates.push(sessionId);
      } else {
        group.leaderSessionId = sessionId;
      }
    }

    // Fallback: for teams with teammates but no leader detected via first-line metadata,
    // scan non-team sessions for TeamCreate tool calls to identify the leader.
    // Pre-scan all candidate sessions in parallel to avoid O(teams × sessions) sequential reads.
    const teamsNeedingLeader = [...teamGroups.entries()].filter(
      ([, g]) => !g.leaderSessionId && g.teammates.length > 0,
    );
    if (teamsNeedingLeader.length > 0) {
      const allTeammateIds = new Set(teamsNeedingLeader.flatMap(([, g]) => g.teammates));
      const candidateSessions = entries.filter(
        (e) => !allTeammateIds.has(e.sessionId) && !teamInfoMap.has(e.sessionId),
      );
      const scanResults = await Promise.all(
        candidateSessions.map(async (e) => ({
          sessionId: e.sessionId,
          teamName: await findTeamCreateInSession(projectDir, e.sessionId),
        })),
      );
      const sessionTeamMap = new Map(
        scanResults.filter((r) => r.teamName !== null).map((r) => [r.sessionId, r.teamName!]),
      );
      for (const [teamName, group] of teamsNeedingLeader) {
        for (const [sessionId, foundTeam] of sessionTeamMap) {
          if (foundTeam === teamName) {
            group.leaderSessionId = sessionId;
            teamInfoMap.set(sessionId, { teamName });
            break;
          }
        }
      }
    }

    // Collect teammate sessionIds that should be hidden from top-level
    const teammateSessionIds = new Set<string>();
    // Map: leader sessionId → teammate session entries to add as children
    const leaderTeammates = new Map<string, typeof entries>();
    for (const [, group] of teamGroups) {
      if (group.leaderSessionId && group.teammates.length > 0) {
        const teammateEntries = entries.filter((e) => group.teammates.includes(e.sessionId));
        leaderTeammates.set(group.leaderSessionId, teammateEntries);
        for (const id of group.teammates) teammateSessionIds.add(id);
      }
    }

    const filteredEntries = entries.filter((e) => !teammateSessionIds.has(e.sessionId));

    // Read subagents for all sessions in parallel (was synchronous per-session before)
    const subagentSpan = perf.start("readSubagents");
    const subagentMap = new Map<string, ReturnType<typeof buildSubagentTree>>();
    const subagentResults = await Promise.all(
      filteredEntries.map(async (e) => ({
        sessionId: e.sessionId,
        subagents: await readSubagents(projectDir, e.sessionId),
      })),
    );
    for (const { sessionId, subagents } of subagentResults) {
      subagentMap.set(sessionId, buildSubagentTree(subagents));
    }
    subagentSpan.end({ sessions: filteredEntries.length });

    const sessions = filteredEntries
      .map((e) => {
        const tree = subagentMap.get(e.sessionId) ?? [];
        const children: any[] = tree.map(function mapNode(s: any): any {
          return {
            agentId: s.agentId,
            taskPrompt: s.taskPrompt,
            timestamp: s.timestamp,
            agentType: s.agentType,
            ...(s.parentAgentId ? { parentAgentId: s.parentAgentId } : {}),
            ...(s.children && s.children.length > 0
              ? { children: s.children.map(mapNode) }
              : {}),
          };
        });

        // Append teammate sessions as children of the team leader
        const teammates = leaderTeammates.get(e.sessionId);
        if (teammates) {
          for (const tm of teammates) {
            const tmInfo = teamInfoMap.get(tm.sessionId);
            children.push({
              agentId: tm.sessionId,
              sessionId: tm.sessionId,
              taskPrompt: tmInfo?.agentName ?? tm.firstPrompt?.slice(0, 100) ?? "Teammate",
              timestamp: tm.created ?? tm.modified ?? "",
              agentType: "code" as const,
            });
          }
        }

        const sessionCwd = e.projectPath || cwd || process.cwd();
        return {
          sessionId: e.sessionId,
          cwd: sessionCwd,
          title: e.firstPrompt?.slice(0, 100) ?? null,
          updatedAt: e.modified ?? e.created ?? null,
          _meta: {
            created: e.created ?? null,
            messageCount: e.messageCount ?? 0,
            gitBranch: e.gitBranch ?? null,
            projectPath: e.projectPath ?? null,
            ...(children.length > 0 ? { children } : {}),
            ...(teamInfoMap.get(e.sessionId)?.teamName ? { teamName: teamInfoMap.get(e.sessionId)!.teamName } : {}),
          },
        };
      })
      .sort((a, b) => {
        const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        return tb - ta;
      });
    perf.summary();
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
