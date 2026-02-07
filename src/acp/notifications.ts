/**
 * ACP notification builders: toAcpNotifications, streamEventToAcpNotifications, promptToClaude.
 * Extracted from acp-agent.ts.
 */
import type { AgentSideConnection, SessionNotification, PromptRequest } from "@agentclientprotocol/sdk";
import type { SDKPartialAssistantMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import type { BetaContentBlock, BetaRawContentBlockDelta } from "@anthropic-ai/sdk/resources/beta.mjs";
import { unreachable } from "../utils.js";
import type { Logger, ToolUseCache, ToolUpdateMeta } from "./types.js";
import { toolInfoFromToolUse, planEntries, toolUpdateFromToolResult, type ClaudePlanEntry } from "./tool-conversion.js";
import { registerHookCallback } from "../sdk/hooks.js";
import { extractBackgroundTaskInfo } from "./background-tasks.js";
import { perfStart } from "../utils/perf.js";

/** Pre-compiled regex for MCP command rewriting in promptToClaude. */
const MCP_CMD_RE = /^\/mcp:([^:\s]+):(\S+)(\s+.*)?$/;

function formatUriAsLink(uri: string): string {
  try {
    if (uri.startsWith("file://") || uri.startsWith("zed://")) {
      // Extract last path component without split() — find last '/' directly
      const lastSlash = uri.lastIndexOf("/");
      const name = lastSlash >= 0 && lastSlash < uri.length - 1
        ? uri.substring(lastSlash + 1)
        : uri.startsWith("file://") ? uri.substring(7) : uri;
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

  const promptChunks = prompt.prompt;
  for (let pi = 0; pi < promptChunks.length; pi++) {
    const chunk = promptChunks[pi];
    switch (chunk.type) {
      case "text": {
        let text = chunk.text;
        // change /mcp:server:command args -> /server:command (MCP) args
        const mcpMatch = MCP_CMD_RE.exec(text);
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

  // Append context items without spread to avoid extra array copy when context is empty
  for (let ci = 0; ci < context.length; ci++) {
    content.push(context[ci]);
  }

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
  const span = perfStart("toAcpNotifications");
  if (typeof content === "string") {
    span.end({ chunks: 1, type: "string" });
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
  for (let _i = 0; _i < content.length; _i++) {
    const chunk = content[_i];
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

                const hookMeta: Record<string, unknown> = { toolResponse, toolName: toolUse.name };
                if (hookIsBackground) hookMeta.isBackground = true;
                if (parentToolUseId) hookMeta.parentToolUseId = parentToolUseId;
                const update: SessionNotification["update"] = {
                  _meta: { claudeCode: hookMeta } as ToolUpdateMeta,
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
          // Build meta without conditional spreads to avoid intermediate object allocations
          const toolCallMeta: Record<string, unknown> = { toolName: chunk.name };
          if (isBackground) toolCallMeta.isBackground = true;
          if (parentToolUseId) toolCallMeta.parentToolUseId = parentToolUseId;
          // Avoid spread operator — assign toolInfo properties directly to reduce allocations
          const toolInfo = toolInfoFromToolUse(chunk);
          update = {
            _meta: {
              claudeCode: toolCallMeta,
            } as ToolUpdateMeta,
            toolCallId: chunk.id,
            sessionUpdate: "tool_call",
            rawInput,
            status: "pending",
            title: toolInfo.title,
            kind: toolInfo.kind,
            content: toolInfo.content,
            locations: toolInfo.locations,
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

          const resultUpdate = toolUpdateFromToolResult(chunk, toolUseCache[chunk.tool_use_id]);
          // Re-derive title from the (now complete) toolUseCache input.
          // During streaming, content_block_start had input: {}, producing
          // generic titles like "Task".  The cache is updated with the full
          // assistant message before tool_result processing, so we can now
          // compute the correct title.
          const derivedTitle = resultUpdate.title || toolInfoFromToolUse(toolUse).title;

          // Build meta without conditional spreads to avoid intermediate object allocations
          const resultMeta: Record<string, unknown> = { toolName: toolUse.name };
          if (resultIsBackground) resultMeta.isBackground = true;
          if (parentToolUseId) resultMeta.parentToolUseId = parentToolUseId;
          update = {
            _meta: { claudeCode: resultMeta } as ToolUpdateMeta,
            toolCallId: chunk.tool_use_id,
            sessionUpdate: "tool_call_update",
            status: "is_error" in chunk && chunk.is_error ? "failed" : "completed",
            rawOutput: chunk.content,
            content: resultUpdate.content,
            locations: resultUpdate.locations,
            title: derivedTitle,
          };
        }

        // Evict completed tool entries from cache to prevent unbounded growth.
        // Background tasks need to stay until task_notification arrives.
        const evictInputObj = toolUse.input as Record<string, unknown> | undefined;
        if (!evictInputObj?.run_in_background) {
          delete toolUseCache[chunk.tool_use_id];
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

  span.end({ chunks: output.length });
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
  const span = perfStart("streamEventToAcpNotifications");
  const event = message.event;
  const parentToolUseId = message.parent_tool_use_id;
  switch (event.type) {
    case "content_block_start": {
      const result = toAcpNotifications(
        [event.content_block],
        "assistant",
        sessionId,
        toolUseCache,
        client,
        logger,
        backgroundTaskMap,
        parentToolUseId,
      );
      span.end({ eventType: event.type });
      return result;
    }
    case "content_block_delta": {
      const result = toAcpNotifications(
        [event.delta],
        "assistant",
        sessionId,
        toolUseCache,
        client,
        logger,
        backgroundTaskMap,
        parentToolUseId,
      );
      span.end({ eventType: event.type });
      return result;
    }
    // No content
    case "message_start":
    case "message_delta":
    case "message_stop":
    case "content_block_stop":
      span.end({ eventType: event.type });
      return [];

    default:
      unreachable(event, logger);
      span.end({ eventType: "unknown" });
      return [];
  }
}
