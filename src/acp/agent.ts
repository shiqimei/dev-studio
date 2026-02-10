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
import {
  toAcpNotifications,
  streamEventToAcpNotifications,
  promptToClaude,
} from "./notifications.js";
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
import {
  readSessionsIndex,
  renameSessionOnDisk,
  deleteSessionFromDisk,
  upsertSessionInIndex,
} from "../disk/sessions-index.js";
import { readSessionHistoryFull, readSubagentHistoryFull } from "../disk/session-history.js";
import {
  readSubagents,
  buildSubagentTree,
  readSessionTeamInfo,
  findTeamCreateInSession,
} from "../disk/subagents.js";
import type { ManagedSession } from "../sdk/types.js";
import type { SessionIndexEntry } from "../disk/types.js";
import type { Logger, NewSessionMeta, ToolUpdateMeta, ToolUseCache } from "./types.js";
import type { BackgroundTerminal } from "./background-tasks.js";
import { extractBackgroundTaskInfo } from "./background-tasks.js";
import { NotificationQueue } from "./notification-queue.js";
import { generateSessionTitle } from "./auto-rename.js";
import { perfScope, type PerfScope } from "../utils/perf.js";
import packageJson from "../../package.json" with { type: "json" };
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

// Bypass Permissions doesn't work if we are a root/sudo user
const IS_ROOT = (process.geteuid?.() ?? process.getuid?.()) === 0;

// Pre-allocated Sets for hot-path type checks (avoid Array.includes per content block)
const TOOL_USE_TYPES = new Set(["tool_use", "server_tool_use", "mcp_tool_use"]);
const FILTERED_ASSISTANT_TYPES = new Set([
  "text",
  "thinking",
  "tool_use",
  "server_tool_use",
  "mcp_tool_use",
]);
const FILTERED_USER_RESULT_TYPES = new Set([
  "tool_search_tool_result",
  "web_fetch_tool_result",
  "web_search_tool_result",
  "code_execution_tool_result",
  "bash_code_execution_tool_result",
  "text_editor_code_execution_tool_result",
  "mcp_tool_result",
]);

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
  /** Cached slash commands (loaded on demand, shared across sessions) */
  private cachedCommands: Awaited<ReturnType<typeof getAvailableSlashCommands>> | null = null;
  /** Cached models (loaded on demand, shared across sessions) */
  private cachedModels: Awaited<ReturnType<typeof getAvailableModels>> | null = null;
  /** Cached team leader mappings: sessionId → teamName (from JSONL scan, expensive) */
  private teamLeaderCache: Map<string, string> | null = null;
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
      const taskUpdate: Record<string, unknown> = {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status,
        _meta: {
          claudeCode: {
            toolName: "Task",
            isBackground: true,
            backgroundComplete: true,
          },
        } satisfies ToolUpdateMeta,
      };
      if (taskNotif.summary) {
        taskUpdate.title = taskNotif.summary;
        taskUpdate.content = [
          { type: "content", content: { type: "text", text: taskNotif.summary } },
        ];
      }
      await this.client.sessionUpdate({
        sessionId,
        update: taskUpdate as any,
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
    console.error(
      `[perf] newSession ${result.sessionId.slice(0, 8)} ${(performance.now() - t0).toFixed(0)}ms`,
    );
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
    console.error(
      `[perf] unstable_resumeSession ${params.sessionId.slice(0, 8)} ${(performance.now() - t0).toFixed(0)}ms`,
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

    const perf = perfScope("prompt");

    // Non-blocking notification queue — enqueue() returns immediately,
    // flush() drains before we return the result.
    const queue = new NotificationQueue(this.client, this.logger);

    // Helper: fire-and-forget for non-critical notifications (streaming, progress, chunks)
    const enqueue = (
      label: string,
      notification: Parameters<typeof this.client.sessionUpdate>[0],
    ) => {
      perf.start(label).end();
      queue.enqueue(notification);
    };

    // Helper: awaited send for critical notifications (results, errors, tool cache updates)
    const timedUpdate = async (
      label: string,
      notification: Parameters<typeof this.client.sessionUpdate>[0],
    ) => {
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
        session.title = firstText.text;
        this.client
          .sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "session_info_update" as any,
              title: session.title,
            } as any,
          })
          .catch((err) => {
            this.logger.error("[claude-code-acp] session_info_update failed:", err);
          });
        // Persist title to disk index
        const projectDir = getProjectDir(session.cwd);
        upsertSessionInIndex(projectDir, {
          sessionId: params.sessionId,
          firstPrompt: session.title,
          modified: new Date().toISOString(),
        }).catch((err) => this.logger.error("[upsertSessionInIndex] title failed:", err));
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
              enqueue(
                "sessionUpdate.system.init",
                systemInitNotification(
                  params.sessionId,
                  message as unknown as Record<string, unknown>,
                  {
                    stats: stats
                      ? {
                          lastComputedDate: stats.lastComputedDate,
                          recentActivity: stats.dailyActivity.slice(-7),
                        }
                      : undefined,
                    diskCommands: commands.length > 0 ? commands : undefined,
                    diskPlugins: plugins.length > 0 ? plugins : undefined,
                    diskSkills: skills.length > 0 ? skills : undefined,
                  },
                ),
              );
              break;
            }
            case "task_notification":
              // Intercepted by SessionMessageRouter (handles between turns too)
              break;
            case "compact_boundary":
              enqueue(
                "sessionUpdate.compact_boundary",
                compactBoundaryNotification(
                  params.sessionId,
                  message as unknown as Record<string, unknown>,
                ),
              );
              break;
            case "hook_started":
              enqueue(
                "sessionUpdate.hook_started",
                hookStartedNotification(
                  params.sessionId,
                  message as unknown as Record<string, unknown>,
                ),
              );
              break;
            case "hook_progress":
              enqueue(
                "sessionUpdate.hook_progress",
                hookProgressNotification(
                  params.sessionId,
                  message as unknown as Record<string, unknown>,
                ),
              );
              break;
            case "hook_response":
              enqueue(
                "sessionUpdate.hook_response",
                hookResponseNotification(
                  params.sessionId,
                  message as unknown as Record<string, unknown>,
                ),
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
              enqueue(
                "sessionUpdate.files_persisted",
                filesPersistedNotification(
                  params.sessionId,
                  message as unknown as Record<string, unknown>,
                ),
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
          const claudeCodeResult: Record<string, unknown> = {
            duration_ms: message.duration_ms,
            duration_api_ms: message.duration_api_ms,
            num_turns: message.num_turns,
            total_cost_usd: message.total_cost_usd,
            usage: message.usage,
            modelUsage: message.modelUsage,
            session_id: message.session_id,
            uuid: message.uuid,
          };
          if ("permission_denials" in message && message.permission_denials.length > 0) {
            claudeCodeResult.permission_denials = message.permission_denials;
          }
          if ("structured_output" in message && message.structured_output !== undefined) {
            claudeCodeResult.structured_output = message.structured_output;
          }
          if (resultStats) {
            claudeCodeResult.stats = {
              lastComputedDate: resultStats.lastComputedDate,
              recentActivity: resultStats.dailyActivity.slice(-7),
            };
          }
          const resultMeta: Record<string, unknown> = { claudeCode: claudeCodeResult };

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
          for (let ni = 0; ni < notifications.length; ni++) {
            enqueue("sessionUpdate.stream_event", notifications[ni]);
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
              if (TOOL_USE_TYPES.has(t) && id) {
                this.toolUseCache[id] = item as any;

                // Send tool_call_update with complete input now that we have it
                const toolUse = item as any;
                if (toolUse.name !== "TodoWrite") {
                  let rawInput;
                  try {
                    rawInput = JSON.parse(JSON.stringify(toolUse.input));
                  } catch {
                    // ignore
                  }
                  const inputObj = toolUse.input as Record<string, unknown> | undefined;
                  const isBackground = inputObj?.run_in_background === true;
                  const info = toolInfoFromToolUse(toolUse);
                  const claudeCodeMeta: Record<string, unknown> = { toolName: toolUse.name };
                  if (isBackground) claudeCodeMeta.isBackground = true;
                  const parentId = (message as any).parent_tool_use_id;
                  if (parentId) claudeCodeMeta.parentToolUseId = parentId;
                  if (toolUse.name === "Task" && inputObj?.subagent_type) {
                    claudeCodeMeta.subagentType = inputObj.subagent_type;
                  }
                  await timedUpdate("sessionUpdate.tool_cache_update", {
                    sessionId: params.sessionId,
                    update: {
                      sessionUpdate: "tool_call_update",
                      toolCallId: id,
                      rawInput,
                      title: info.title,
                      kind: info.kind,
                      content: info.content,
                      locations: info.locations,
                      _meta: { claudeCode: claudeCodeMeta } as ToolUpdateMeta,
                    },
                  });
                }
              }
            }
          }

          const content =
            message.type === "assistant"
              ? message.message.content.filter((item) => !FILTERED_ASSISTANT_TYPES.has(item.type))
              : Array.isArray(message.message.content)
                ? message.message.content.filter(
                    // Keep "tool_result" — it generates tool_call_update with
                    // status + content for client-side tools (Read, Edit, etc.)
                    (item) => !FILTERED_USER_RESULT_TYPES.has(item.type),
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
          for (let ni = 0; ni < msgNotifications.length; ni++) {
            enqueue("sessionUpdate.message", msgNotifications[ni]);
          }
          break;
        }
        case "tool_progress": {
          // Forward tool progress as in_progress tool_call_update
          const toolUse = this.toolUseCache[message.tool_use_id];
          if (toolUse) {
            const progressMeta: Record<string, unknown> = {
              toolName: toolUse.name,
              elapsed_time_seconds: message.elapsed_time_seconds,
            };
            if (message.parent_tool_use_id)
              progressMeta.parentToolUseId = message.parent_tool_use_id;
            enqueue("sessionUpdate.tool_progress", {
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: message.tool_use_id,
                status: "in_progress",
                _meta: { claudeCode: progressMeta },
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
          enqueue(
            "sessionUpdate.auth_status",
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

  async extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const extT0 = performance.now();
    try {
      switch (method) {
        case "sessions/list": {
          const result = await this.unstable_listSessions({
            cwd: params.cwd as string | undefined,
          });
          return result as unknown as Record<string, unknown>;
        }

        case "sessions/getHistory": {
          const sessionId = params.sessionId as string;
          if (!sessionId) throw new Error("sessionId is required");
          const t0 = performance.now();
          const projectDir = getProjectDir(params.cwd as string | undefined);
          const entries = await readSessionHistoryFull(projectDir, sessionId);
          const t1 = performance.now();
          console.error(
            `[extMethod] sessions/getHistory ${sessionId.slice(0, 8)} read=${(t1 - t0).toFixed(0)}ms entries=${entries.length}`,
          );
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
          console.error(
            `[extMethod] sessions/getSubagentHistory ${sessionId.slice(0, 8)}:${agentId.slice(0, 8)} read=${(t1 - t0).toFixed(0)}ms entries=${entries.length}`,
          );
          return { entries };
        }

        case "sessions/rename": {
          const t0 = performance.now();
          const sessionId = params.sessionId as string;
          const title = params.title as string;
          if (!sessionId || !title) throw new Error("sessionId and title are required");
          const projectDir = getProjectDir(params.cwd as string | undefined);
          const diskSuccess = await renameSessionOnDisk(projectDir, sessionId, title);
          if (!diskSuccess) {
            // Entry not in index yet — upsert it so rename persists
            await upsertSessionInIndex(projectDir, {
              sessionId,
              firstPrompt: title,
              modified: new Date().toISOString(),
            });
          }
          // Also update in-memory session title (live sessions may not be on disk yet)
          const liveSession = this.sessions[sessionId];
          if (liveSession) {
            liveSession.title = title;
            liveSession.autoRenamed = true; // Prevent auto-rename from overwriting manual rename
          }
          // Notify client immediately so header updates without waiting for broadcastSessions
          this.client
            .sessionUpdate({
              sessionId,
              update: {
                sessionUpdate: "session_info_update" as any,
                title,
              } as any,
            })
            .catch((err) => {
              this.logger.error("[sessions/rename] session_info_update failed:", err);
            });
          console.error(
            `[extMethod] sessions/rename ${sessionId.slice(0, 8)} ${(performance.now() - t0).toFixed(0)}ms`,
          );
          return { success: true };
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
            // Read team info for all entries in parallel — tolerate individual failures
            const entryTeamsSettled = await Promise.allSettled(
              allEntries
                .filter((entry) => entry.sessionId !== sessionId)
                .map(async (entry) => ({
                  entry,
                  team: await readSessionTeamInfo(projectDir, entry.sessionId),
                })),
            );
            const entryTeams = entryTeamsSettled
              .filter(
                (
                  r,
                ): r is PromiseFulfilledResult<{
                  entry: SessionIndexEntry;
                  team: Awaited<ReturnType<typeof readSessionTeamInfo>>;
                }> => r.status === "fulfilled",
              )
              .map((r) => r.value);
            for (const { entry, team } of entryTeams) {
              if (team?.teamName === teamInfo.teamName && team.agentName) {
                if (await deleteSessionFromDisk(projectDir, entry.sessionId)) {
                  deletedIds.push(entry.sessionId);
                }
              }
            }
          }

          const diskSuccess = await deleteSessionFromDisk(projectDir, sessionId);

          // Also clean up live in-memory session (may exist even if not yet on disk)
          const liveSession = this.sessions[sessionId];
          if (liveSession) {
            try {
              this.close(sessionId);
            } catch {}
          }

          const success = diskSuccess || !!liveSession;
          if (success) deletedIds.push(sessionId);
          console.error(
            `[extMethod] sessions/delete ${sessionId.slice(0, 8)} ${(performance.now() - t0).toFixed(0)}ms deletedIds=${deletedIds.length} disk=${diskSuccess} live=${!!liveSession}`,
          );
          return { success, deletedIds };
        }

        case "sessions/getAvailableCommands": {
          if (!this.cachedCommands) {
            // Find any live session's query to ask for commands
            const session = Object.values(this.sessions).find((s) => s.query);
            if (!session?.query) throw new Error("No active session");
            const [cmds, models] = await Promise.all([
              getAvailableSlashCommands(session.query),
              getAvailableModels(session.query),
            ]);
            this.cachedCommands = cmds;
            this.cachedModels = models;
          }
          return { commands: this.cachedCommands, models: this.cachedModels };
        }

        case "tasks/list": {
          const sessionId = params.sessionId as string;
          if (!sessionId) throw new Error("sessionId is required");
          const tasks = await readSessionTasks(sessionId);
          return { tasks };
        }

        case "sessions/getSubagents": {
          const sessionId = params.sessionId as string;
          if (!sessionId) throw new Error("sessionId is required");
          const projectDir = getProjectDir(params.cwd as string | undefined);
          const subagents = await readSubagents(projectDir, sessionId);
          const tree = buildSubagentTree(subagents);
          return { sessionId, children: tree };
        }

        case "sessions/autoRename": {
          const sessionId = params.sessionId as string;
          if (!sessionId) throw new Error("sessionId is required");
          const session = this.sessions[sessionId];
          if (!session) throw new Error("Session not found");

          const userMessage = (params.userMessage as string) || session.title || "";
          const assistantText = (params.assistantText as string) || "";

          if (!userMessage && !assistantText) {
            throw new Error("At least userMessage or assistantText is required");
          }

          const title = await generateSessionTitle({
            cwd: session.cwd,
            userMessage,
            assistantText,
            logger: this.logger,
          });

          if (!title) {
            return { success: false, reason: "Failed to generate title" };
          }

          // Apply the generated title
          session.title = title;
          session.autoRenamed = true;

          const projectDir = getProjectDir(session.cwd);
          const diskSuccess = await renameSessionOnDisk(projectDir, sessionId, title);
          if (!diskSuccess) {
            await upsertSessionInIndex(projectDir, {
              sessionId,
              firstPrompt: title,
              modified: new Date().toISOString(),
            });
          }

          this.client
            .sessionUpdate({
              sessionId,
              update: {
                sessionUpdate: "session_info_update" as any,
                title,
              } as any,
            })
            .catch((err) => {
              this.logger.error("[auto-rename] session_info_update failed:", err);
            });

          return { success: true, title };
        }

        default:
          throw RequestError.methodNotFound(method);
      }
    } finally {
      console.error(
        `[perf] extMethod(${method}) total=${(performance.now() - extT0).toFixed(0)}ms`,
      );
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
    // Clean up background resources for this session.
    // Use Object.keys() snapshot to avoid modifying during iteration.
    const bgKeys = Object.keys(this.backgroundTaskMap);
    for (let i = 0; i < bgKeys.length; i++) {
      const key = bgKeys[i];
      if (this.toolUseCache[this.backgroundTaskMap[key]]) {
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
    const disallowedTools: string[] = [];

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

    const now = new Date().toISOString();
    this.sessions[sessionId] = {
      query: q,
      router,
      input: input,
      cancelled: false,
      permissionMode,
      settingsManager,
      title: null,
      cwd: params.cwd,
      updatedAt: now,
    };

    // For resumed/forked sessions, skip auto-rename (they already have meaningful context)
    if (creationOpts.resume) {
      this.sessions[sessionId].autoRenamed = true;
    }

    // Persist session to disk index so it survives process restarts.
    // The CLI creates JSONL files but doesn't update sessions-index.json
    // for long-running SDK sessions that never complete.
    const projectDir = getProjectDir(params.cwd);
    upsertSessionInIndex(projectDir, {
      sessionId,
      created: now,
      modified: now,
      projectPath: params.cwd,
    }).catch((err) => this.logger.error("[upsertSessionInIndex] create failed:", err));

    // Fetch available models from the query to include in the response.
    // supportedModels() may fail if the SDK hasn't initialized yet, so fall
    // back to the CLAUDE_MODEL env var which the demo server always sets.
    let models: SessionModelState | undefined;
    try {
      const supportedModels = await q.supportedModels();
      const currentModel = supportedModels[0];
      models = {
        availableModels: supportedModels.map((m) => ({
          modelId: m.value,
          name: m.displayName,
          description: m.description,
        })),
        currentModelId: currentModel?.value,
      };
    } catch {
      // supportedModels() not available yet — use env var as fallback
      const envModel = process.env.CLAUDE_MODEL || "sonnet";
      models = {
        availableModels: [{ modelId: envModel, name: envModel }],
        currentModelId: envModel,
      };
    }

    perf.summary();

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
    const disallowedTools: string[] = [];

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

    // For resumed sessions, skip auto-rename
    if (creationOpts.resume) {
      this.sessions[sessionId].autoRenamed = true;
    }

    const availableModes = [
      {
        id: "default",
        name: "Default",
        description: "Standard behavior, prompts for dangerous operations",
      },
      { id: "acceptEdits", name: "Accept Edits", description: "Auto-accept file edit operations" },
      { id: "plan", name: "Plan Mode", description: "Planning mode, no actual tool execution" },
      {
        id: "dontAsk",
        name: "Don't Ask",
        description: "Don't prompt for permissions, deny if not pre-approved",
      },
      { id: "delegate", name: "Delegate", description: "Delegation mode for sub-agents" },
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
      models: {
        availableModels: [{ modelId: model, name: model }],
        currentModelId: model,
      },
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

    // Read team metadata for ALL sessions in parallel — use allSettled to
    // tolerate individual session read failures without aborting the list.
    const teamSpan = perf.start("readTeamMetadata");
    const teamInfoMap = new Map<string, { teamName: string; agentName?: string }>();
    const teamResults = await Promise.allSettled(
      entries.map(async (e) => ({
        sessionId: e.sessionId,
        info: await readSessionTeamInfo(projectDir, e.sessionId),
      })),
    );
    for (const result of teamResults) {
      if (result.status === "fulfilled" && result.value.info) {
        teamInfoMap.set(result.value.sessionId, result.value.info);
      }
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
    // This is expensive (~300-400ms for 50+ sessions) so results are cached.
    const teamsNeedingLeader = [...teamGroups.entries()].filter(
      ([, g]) => !g.leaderSessionId && g.teammates.length > 0,
    );
    if (teamsNeedingLeader.length > 0) {
      const leaderSpan = perf.start("findTeamLeaders");
      if (!this.teamLeaderCache) {
        // First call: scan all candidate sessions and cache results
        const allTeammateIds = new Set(teamsNeedingLeader.flatMap(([, g]) => g.teammates));
        const candidateSessions = entries.filter(
          (e) => !allTeammateIds.has(e.sessionId) && !teamInfoMap.has(e.sessionId),
        );
        const scanSettled = await Promise.allSettled(
          candidateSessions.map(async (e) => ({
            sessionId: e.sessionId,
            teamName: await findTeamCreateInSession(projectDir, e.sessionId),
          })),
        );
        this.teamLeaderCache = new Map();
        for (const result of scanSettled) {
          if (result.status === "fulfilled" && result.value.teamName) {
            this.teamLeaderCache.set(result.value.sessionId, result.value.teamName);
          }
        }
      }
      // Apply cached leader mappings
      for (const [teamName, group] of teamsNeedingLeader) {
        for (const [sessionId, foundTeam] of this.teamLeaderCache) {
          if (foundTeam === teamName) {
            group.leaderSessionId = sessionId;
            teamInfoMap.set(sessionId, { teamName });
            break;
          }
        }
      }
      leaderSpan.end({ teams: teamsNeedingLeader.length, cached: this.teamLeaderCache.size > 0 });
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

    const sessions = filteredEntries
      .map((e) => {
        // Only include teammate children (not subagent trees — those are loaded on demand)
        const children: any[] = [];

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
          title: e.firstPrompt ?? null,
          updatedAt: e.modified ?? e.created ?? null,
          _meta: {
            created: e.created ?? null,
            messageCount: e.messageCount ?? 0,
            gitBranch: e.gitBranch ?? null,
            projectPath: e.projectPath ?? null,
            ...(children.length > 0 ? { children } : {}),
            ...(teamInfoMap.get(e.sessionId)?.teamName
              ? { teamName: teamInfoMap.get(e.sessionId)!.teamName }
              : {}),
          },
        };
      })
      .sort((a, b) => {
        // ISO-8601 strings sort lexicographically — avoids Date allocation in O(n log n) comparator
        const ta = a.updatedAt ?? "";
        const tb = b.updatedAt ?? "";
        return ta < tb ? 1 : ta > tb ? -1 : 0;
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
