import { describe, it, expect, vi } from "vitest";
import { AgentSideConnection } from "@agentclientprotocol/sdk";
import {
  toAcpNotifications,
  streamEventToAcpNotifications,
  ToolUseCache,
  Logger,
} from "../acp-agent.js";
import type { SDKPartialAssistantMessage } from "@anthropic-ai/claude-agent-sdk";

const mockClient = {} as AgentSideConnection;
const mockLogger: Logger = { log: vi.fn(), error: vi.fn() };

describe("toAcpNotifications", () => {
  describe("string content handling", () => {
    it("should convert string content to agent_message_chunk when role is assistant", () => {
      const notifications = toAcpNotifications(
        "Hello from assistant",
        "assistant",
        "session-1",
        {},
        mockClient,
        mockLogger,
      );

      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toEqual({
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Hello from assistant",
          },
        },
      });
    });

    it("should convert string content to user_message_chunk when role is user", () => {
      const notifications = toAcpNotifications(
        "Hello from user",
        "user",
        "session-1",
        {},
        mockClient,
        mockLogger,
      );

      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toEqual({
        sessionId: "session-1",
        update: {
          sessionUpdate: "user_message_chunk",
          content: {
            type: "text",
            text: "Hello from user",
          },
        },
      });
    });

    it("should handle empty string content", () => {
      const notifications = toAcpNotifications(
        "",
        "assistant",
        "session-1",
        {},
        mockClient,
        mockLogger,
      );

      expect(notifications).toHaveLength(1);
      expect(notifications[0].update).toMatchObject({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "" },
      });
    });
  });

  describe("text and text_delta blocks", () => {
    it("should convert text block to agent_message_chunk for assistant role", () => {
      const notifications = toAcpNotifications(
        [{ type: "text", text: "Some text content" }],
        "assistant",
        "session-1",
        {},
        mockClient,
        mockLogger,
      );

      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toEqual({
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Some text content",
          },
        },
      });
    });

    it("should convert text block to user_message_chunk for user role", () => {
      const notifications = toAcpNotifications(
        [{ type: "text", text: "User text" }],
        "user",
        "session-1",
        {},
        mockClient,
        mockLogger,
      );

      expect(notifications).toHaveLength(1);
      expect(notifications[0].update).toMatchObject({
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "User text" },
      });
    });

    it("should convert text_delta block to agent_message_chunk", () => {
      const notifications = toAcpNotifications(
        [{ type: "text_delta", text: "delta text" }],
        "assistant",
        "session-1",
        {},
        mockClient,
        mockLogger,
      );

      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toEqual({
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "delta text",
          },
        },
      });
    });

    it("should handle multiple text blocks", () => {
      const notifications = toAcpNotifications(
        [
          { type: "text", text: "First block" },
          { type: "text", text: "Second block" },
        ],
        "assistant",
        "session-1",
        {},
        mockClient,
        mockLogger,
      );

      expect(notifications).toHaveLength(2);
      expect(notifications[0].update).toMatchObject({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "First block" },
      });
      expect(notifications[1].update).toMatchObject({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Second block" },
      });
    });
  });

  describe("image blocks", () => {
    it("should convert image block with base64 source", () => {
      const notifications = toAcpNotifications(
        [
          {
            type: "image",
            source: {
              type: "base64",
              data: "iVBORw0KGgo=",
              media_type: "image/png",
            },
          },
        ],
        "assistant",
        "session-1",
        {},
        mockClient,
        mockLogger,
      );

      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toEqual({
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "image",
            data: "iVBORw0KGgo=",
            mimeType: "image/png",
            uri: undefined,
          },
        },
      });
    });

    it("should convert image block with URL source", () => {
      const notifications = toAcpNotifications(
        [
          {
            type: "image",
            source: {
              type: "url",
              url: "https://example.com/image.png",
            },
          },
        ],
        "assistant",
        "session-1",
        {},
        mockClient,
        mockLogger,
      );

      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toEqual({
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "image",
            data: "",
            mimeType: "",
            uri: "https://example.com/image.png",
          },
        },
      });
    });

    it("should convert image block with user role to user_message_chunk", () => {
      const notifications = toAcpNotifications(
        [
          {
            type: "image",
            source: {
              type: "base64",
              data: "abc123",
              media_type: "image/jpeg",
            },
          },
        ],
        "user",
        "session-1",
        {},
        mockClient,
        mockLogger,
      );

      expect(notifications).toHaveLength(1);
      expect(notifications[0].update).toMatchObject({
        sessionUpdate: "user_message_chunk",
        content: {
          type: "image",
          data: "abc123",
          mimeType: "image/jpeg",
        },
      });
    });
  });

  describe("thinking blocks", () => {
    it("should convert thinking block to agent_thought_chunk", () => {
      const notifications = toAcpNotifications(
        [{ type: "thinking", thinking: "Let me think about this..." }],
        "assistant",
        "session-1",
        {},
        mockClient,
        mockLogger,
      );

      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toEqual({
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: {
            type: "text",
            text: "Let me think about this...",
          },
        },
      });
    });

    it("should convert thinking_delta block to agent_thought_chunk", () => {
      const notifications = toAcpNotifications(
        [{ type: "thinking_delta", thinking: "...more thinking" }],
        "assistant",
        "session-1",
        {},
        mockClient,
        mockLogger,
      );

      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toEqual({
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: {
            type: "text",
            text: "...more thinking",
          },
        },
      });
    });
  });

  describe("tool use blocks", () => {
    it("should convert tool_use to tool_call notification", () => {
      const toolUseCache: ToolUseCache = {};
      const notifications = toAcpNotifications(
        [
          {
            type: "tool_use",
            id: "toolu_001",
            name: "Bash",
            input: { command: "ls -la", description: "List files" },
          },
        ],
        "assistant",
        "session-1",
        toolUseCache,
        mockClient,
        mockLogger,
      );

      expect(notifications).toHaveLength(1);
      expect(notifications[0].update).toMatchObject({
        sessionUpdate: "tool_call",
        toolCallId: "toolu_001",
        status: "pending",
      });
      expect((notifications[0].update as any)._meta).toMatchObject({
        claudeCode: {
          toolName: "Bash",
        },
      });
    });

    it("should populate toolUseCache for tool_use", () => {
      const toolUseCache: ToolUseCache = {};
      toAcpNotifications(
        [
          {
            type: "tool_use",
            id: "toolu_002",
            name: "Read",
            input: { file_path: "/test/file.txt" },
          },
        ],
        "assistant",
        "session-1",
        toolUseCache,
        mockClient,
        mockLogger,
      );

      expect(toolUseCache["toolu_002"]).toEqual({
        type: "tool_use",
        id: "toolu_002",
        name: "Read",
        input: { file_path: "/test/file.txt" },
      });
    });

    it("should convert server_tool_use to tool_call notification", () => {
      const toolUseCache: ToolUseCache = {};
      const notifications = toAcpNotifications(
        [
          {
            type: "server_tool_use",
            id: "toolu_003",
            name: "WebSearch",
            input: { query: "test" },
          },
        ],
        "assistant",
        "session-1",
        toolUseCache,
        mockClient,
        mockLogger,
      );

      expect(notifications).toHaveLength(1);
      expect(notifications[0].update).toMatchObject({
        sessionUpdate: "tool_call",
        toolCallId: "toolu_003",
        status: "pending",
      });
      expect(toolUseCache["toolu_003"]).toBeDefined();
      expect(toolUseCache["toolu_003"].type).toBe("server_tool_use");
    });

    it("should convert mcp_tool_use to tool_call notification", () => {
      const toolUseCache: ToolUseCache = {};
      const notifications = toAcpNotifications(
        [
          {
            type: "mcp_tool_use",
            id: "toolu_004",
            name: "mcp__server__tool",
            input: { query: "test" },
          },
        ],
        "assistant",
        "session-1",
        toolUseCache,
        mockClient,
        mockLogger,
      );

      expect(notifications).toHaveLength(1);
      expect(notifications[0].update).toMatchObject({
        sessionUpdate: "tool_call",
        toolCallId: "toolu_004",
        status: "pending",
      });
      expect(toolUseCache["toolu_004"]).toBeDefined();
      expect(toolUseCache["toolu_004"].type).toBe("mcp_tool_use");
    });

    it("should include isBackground metadata when run_in_background is true", () => {
      const toolUseCache: ToolUseCache = {};
      const notifications = toAcpNotifications(
        [
          {
            type: "tool_use",
            id: "toolu_bg",
            name: "Task",
            input: {
              description: "background task",
              prompt: "do work",
              run_in_background: true,
            },
          },
        ],
        "assistant",
        "session-1",
        toolUseCache,
        mockClient,
        mockLogger,
      );

      expect(notifications).toHaveLength(1);
      expect((notifications[0].update as any)._meta.claudeCode.isBackground).toBe(true);
    });

    it("should not include isBackground when run_in_background is false or absent", () => {
      const toolUseCache: ToolUseCache = {};
      const notifications = toAcpNotifications(
        [
          {
            type: "tool_use",
            id: "toolu_fg",
            name: "Bash",
            input: { command: "echo hi" },
          },
        ],
        "assistant",
        "session-1",
        toolUseCache,
        mockClient,
        mockLogger,
      );

      expect(notifications).toHaveLength(1);
      expect((notifications[0].update as any)._meta.claudeCode.isBackground).toBeUndefined();
    });

    it("should propagate parentToolUseId in tool_call metadata", () => {
      const toolUseCache: ToolUseCache = {};
      const notifications = toAcpNotifications(
        [
          {
            type: "tool_use",
            id: "toolu_child",
            name: "Bash",
            input: { command: "echo sub-agent" },
          },
        ],
        "assistant",
        "session-1",
        toolUseCache,
        mockClient,
        mockLogger,
        undefined,
        "toolu_parent",
      );

      expect(notifications).toHaveLength(1);
      expect((notifications[0].update as any)._meta.claudeCode.parentToolUseId).toBe(
        "toolu_parent",
      );
    });

    it("should not include parentToolUseId when it is null", () => {
      const toolUseCache: ToolUseCache = {};
      const notifications = toAcpNotifications(
        [
          {
            type: "tool_use",
            id: "toolu_root",
            name: "Bash",
            input: { command: "echo root" },
          },
        ],
        "assistant",
        "session-1",
        toolUseCache,
        mockClient,
        mockLogger,
        undefined,
        null,
      );

      expect(notifications).toHaveLength(1);
      expect(
        (notifications[0].update as any)._meta.claudeCode.parentToolUseId,
      ).toBeUndefined();
    });

    it("should include rawInput in tool_call notification", () => {
      const toolUseCache: ToolUseCache = {};
      const input = { command: "ls -la", description: "List files" };
      const notifications = toAcpNotifications(
        [
          {
            type: "tool_use",
            id: "toolu_raw",
            name: "Bash",
            input,
          },
        ],
        "assistant",
        "session-1",
        toolUseCache,
        mockClient,
        mockLogger,
      );

      expect(notifications).toHaveLength(1);
      expect((notifications[0].update as any).rawInput).toEqual(input);
    });
  });

  describe("TodoWrite tool use", () => {
    it("should emit plan notification for TodoWrite with valid todos", () => {
      const toolUseCache: ToolUseCache = {};
      const notifications = toAcpNotifications(
        [
          {
            type: "tool_use",
            id: "toolu_todo",
            name: "TodoWrite",
            input: {
              todos: [
                { content: "Task 1", status: "pending", activeForm: "Working on task 1" },
                { content: "Task 2", status: "in_progress", activeForm: "Working on task 2" },
                { content: "Task 3", status: "completed", activeForm: "Done with task 3" },
              ],
            },
          },
        ],
        "assistant",
        "session-1",
        toolUseCache,
        mockClient,
        mockLogger,
      );

      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toEqual({
        sessionId: "session-1",
        update: {
          sessionUpdate: "plan",
          entries: [
            { content: "Task 1", status: "pending", priority: "medium" },
            { content: "Task 2", status: "in_progress", priority: "medium" },
            { content: "Task 3", status: "completed", priority: "medium" },
          ],
        },
      });
    });

    it("should still populate toolUseCache for TodoWrite", () => {
      const toolUseCache: ToolUseCache = {};
      toAcpNotifications(
        [
          {
            type: "tool_use",
            id: "toolu_todo_cache",
            name: "TodoWrite",
            input: {
              todos: [{ content: "Task", status: "pending", activeForm: "Working" }],
            },
          },
        ],
        "assistant",
        "session-1",
        toolUseCache,
        mockClient,
        mockLogger,
      );

      expect(toolUseCache["toolu_todo_cache"]).toBeDefined();
    });

    it("should not emit plan when TodoWrite has empty input", () => {
      const toolUseCache: ToolUseCache = {};
      const notifications = toAcpNotifications(
        [
          {
            type: "tool_use",
            id: "toolu_todo_empty",
            name: "TodoWrite",
            input: {},
          },
        ],
        "assistant",
        "session-1",
        toolUseCache,
        mockClient,
        mockLogger,
      );

      // No plan notification since input.todos is not an array
      expect(notifications).toHaveLength(0);
    });
  });

  describe("tool result blocks", () => {
    it("should convert tool_result with is_error false to completed tool_call_update", () => {
      const toolUseCache: ToolUseCache = {
        toolu_res_1: {
          type: "tool_use",
          id: "toolu_res_1",
          name: "Bash",
          input: { command: "echo hello" },
        },
      };

      const notifications = toAcpNotifications(
        [
          {
            type: "tool_result",
            tool_use_id: "toolu_res_1",
            content: "hello\n",
            is_error: false,
          },
        ],
        "assistant",
        "session-1",
        toolUseCache,
        mockClient,
        mockLogger,
      );

      expect(notifications).toHaveLength(1);
      expect(notifications[0].update).toMatchObject({
        sessionUpdate: "tool_call_update",
        toolCallId: "toolu_res_1",
        status: "completed",
        rawOutput: "hello\n",
      });
    });

    it("should convert tool_result with is_error true to failed tool_call_update", () => {
      const toolUseCache: ToolUseCache = {
        toolu_err: {
          type: "tool_use",
          id: "toolu_err",
          name: "Bash",
          input: { command: "invalid_cmd" },
        },
      };

      const notifications = toAcpNotifications(
        [
          {
            type: "tool_result",
            tool_use_id: "toolu_err",
            content: "command not found",
            is_error: true,
          },
        ],
        "assistant",
        "session-1",
        toolUseCache,
        mockClient,
        mockLogger,
      );

      expect(notifications).toHaveLength(1);
      expect(notifications[0].update).toMatchObject({
        sessionUpdate: "tool_call_update",
        toolCallId: "toolu_err",
        status: "failed",
        rawOutput: "command not found",
      });
    });

    it("should convert mcp_tool_result to tool_call_update", () => {
      const toolUseCache: ToolUseCache = {
        toolu_mcp_res: {
          type: "mcp_tool_use",
          id: "toolu_mcp_res",
          name: "mcp__server__tool",
          input: { query: "test" },
        },
      };

      const notifications = toAcpNotifications(
        [
          {
            type: "mcp_tool_result",
            tool_use_id: "toolu_mcp_res",
            content: "MCP result",
            is_error: false,
          },
        ],
        "assistant",
        "session-1",
        toolUseCache,
        mockClient,
        mockLogger,
      );

      expect(notifications).toHaveLength(1);
      expect(notifications[0].update).toMatchObject({
        sessionUpdate: "tool_call_update",
        toolCallId: "toolu_mcp_res",
        status: "completed",
        rawOutput: "MCP result",
      });
    });

    it("should convert web_search_tool_result to tool_call_update", () => {
      const toolUseCache: ToolUseCache = {
        toolu_ws: {
          type: "server_tool_use",
          id: "toolu_ws",
          name: "WebSearch",
          input: { query: "test" },
        },
      };

      const notifications = toAcpNotifications(
        [
          {
            type: "web_search_tool_result",
            tool_use_id: "toolu_ws",
            content: [
              {
                type: "web_search_result",
                title: "Test Result",
                url: "https://example.com",
                encrypted_content: "...",
                page_age: null,
              },
            ],
          },
        ],
        "assistant",
        "session-1",
        toolUseCache,
        mockClient,
        mockLogger,
      );

      expect(notifications).toHaveLength(1);
      expect(notifications[0].update).toMatchObject({
        sessionUpdate: "tool_call_update",
        toolCallId: "toolu_ws",
        status: "completed",
      });
    });

    it("should convert bash_code_execution_tool_result to tool_call_update", () => {
      const toolUseCache: ToolUseCache = {
        toolu_bash_exec: {
          type: "tool_use",
          id: "toolu_bash_exec",
          name: "Bash",
          input: { command: "ls" },
        },
      };

      const notifications = toAcpNotifications(
        [
          {
            type: "bash_code_execution_tool_result",
            tool_use_id: "toolu_bash_exec",
            content: {
              type: "bash_code_execution_result",
              stdout: "file1.txt\nfile2.txt",
              stderr: "",
              return_code: 0,
              content: [],
            },
          },
        ],
        "assistant",
        "session-1",
        toolUseCache,
        mockClient,
        mockLogger,
      );

      expect(notifications).toHaveLength(1);
      expect(notifications[0].update).toMatchObject({
        sessionUpdate: "tool_call_update",
        toolCallId: "toolu_bash_exec",
        status: "completed",
      });
    });

    it("should not emit notification for untracked tool_result", () => {
      const toolUseCache: ToolUseCache = {};
      const logger: Logger = { log: vi.fn(), error: vi.fn() };

      const notifications = toAcpNotifications(
        [
          {
            type: "tool_result",
            tool_use_id: "untracked_id",
            content: "result",
            is_error: false,
          },
        ],
        "assistant",
        "session-1",
        toolUseCache,
        mockClient,
        logger,
      );

      expect(notifications).toHaveLength(0);
      expect(logger.error).toHaveBeenCalled();
    });

    it("should not emit tool_call_update for TodoWrite result", () => {
      const toolUseCache: ToolUseCache = {
        toolu_todo_res: {
          type: "tool_use",
          id: "toolu_todo_res",
          name: "TodoWrite",
          input: { todos: [{ content: "Task", status: "pending" }] },
        },
      };

      const notifications = toAcpNotifications(
        [
          {
            type: "tool_result",
            tool_use_id: "toolu_todo_res",
            content: "Todos updated",
            is_error: false,
          },
        ],
        "assistant",
        "session-1",
        toolUseCache,
        mockClient,
        mockLogger,
      );

      expect(notifications).toHaveLength(0);
    });

    it("should include toolName in metadata for tool result", () => {
      const toolUseCache: ToolUseCache = {
        toolu_meta: {
          type: "tool_use",
          id: "toolu_meta",
          name: "Grep",
          input: { pattern: "test" },
        },
      };

      const notifications = toAcpNotifications(
        [
          {
            type: "tool_result",
            tool_use_id: "toolu_meta",
            content: "found matches",
            is_error: false,
          },
        ],
        "assistant",
        "session-1",
        toolUseCache,
        mockClient,
        mockLogger,
      );

      expect(notifications).toHaveLength(1);
      expect((notifications[0].update as any)._meta.claudeCode.toolName).toBe("Grep");
    });

    it("should include isBackground in tool result metadata for background tasks", () => {
      const toolUseCache: ToolUseCache = {
        toolu_bg_res: {
          type: "tool_use",
          id: "toolu_bg_res",
          name: "Task",
          input: {
            description: "bg task",
            prompt: "work",
            run_in_background: true,
          },
        },
      };

      const notifications = toAcpNotifications(
        [
          {
            type: "tool_result",
            tool_use_id: "toolu_bg_res",
            content: "completed",
            is_error: false,
          },
        ],
        "assistant",
        "session-1",
        toolUseCache,
        mockClient,
        mockLogger,
      );

      expect(notifications).toHaveLength(1);
      expect((notifications[0].update as any)._meta.claudeCode.isBackground).toBe(true);
    });

    it("should propagate parentToolUseId in tool result metadata", () => {
      const toolUseCache: ToolUseCache = {
        toolu_child_res: {
          type: "tool_use",
          id: "toolu_child_res",
          name: "Bash",
          input: { command: "echo sub" },
        },
      };

      const notifications = toAcpNotifications(
        [
          {
            type: "tool_result",
            tool_use_id: "toolu_child_res",
            content: "sub\n",
            is_error: false,
          },
        ],
        "assistant",
        "session-1",
        toolUseCache,
        mockClient,
        mockLogger,
        undefined,
        "toolu_parent_task",
      );

      expect(notifications).toHaveLength(1);
      expect((notifications[0].update as any)._meta.claudeCode.parentToolUseId).toBe(
        "toolu_parent_task",
      );
    });

    it("should populate backgroundTaskMap from tool_result content for background tasks", () => {
      const toolUseCache: ToolUseCache = {
        toolu_bg_map: {
          type: "tool_use",
          id: "toolu_bg_map",
          name: "Task",
          input: {
            description: "bg task",
            prompt: "work",
            run_in_background: true,
          },
        },
      };
      const backgroundTaskMap: Record<string, string> = {};

      toAcpNotifications(
        [
          {
            type: "tool_result",
            tool_use_id: "toolu_bg_map",
            content: [
              {
                type: "text",
                text: 'task_id: "task-abc-123"\noutput_file: "/tmp/output.txt"',
              },
            ],
            is_error: false,
          },
        ],
        "assistant",
        "session-1",
        toolUseCache,
        mockClient,
        mockLogger,
        backgroundTaskMap,
      );

      expect(backgroundTaskMap["task-abc-123"]).toBe("toolu_bg_map");
      expect(backgroundTaskMap["file:/tmp/output.txt"]).toBe("toolu_bg_map");
    });
  });

  describe("ignored content types", () => {
    it("should return no notifications for document type", () => {
      const notifications = toAcpNotifications(
        [{ type: "document", source: { type: "text", media_type: "text/plain", data: "doc" } }],
        "assistant",
        "session-1",
        {},
        mockClient,
        mockLogger,
      );

      expect(notifications).toHaveLength(0);
    });

    it("should return no notifications for redacted_thinking type", () => {
      const notifications = toAcpNotifications(
        [{ type: "redacted_thinking", data: "redacted" }],
        "assistant",
        "session-1",
        {},
        mockClient,
        mockLogger,
      );

      expect(notifications).toHaveLength(0);
    });

    it("should return no notifications for input_json_delta type", () => {
      const notifications = toAcpNotifications(
        [{ type: "input_json_delta", partial_json: '{"key":' }],
        "assistant",
        "session-1",
        {},
        mockClient,
        mockLogger,
      );

      expect(notifications).toHaveLength(0);
    });

    it("should return no notifications for citations_delta type", () => {
      const notifications = toAcpNotifications(
        [{ type: "citations_delta", citation: {} as any }],
        "assistant",
        "session-1",
        {},
        mockClient,
        mockLogger,
      );

      expect(notifications).toHaveLength(0);
    });

    it("should return no notifications for signature_delta type", () => {
      const notifications = toAcpNotifications(
        [{ type: "signature_delta", signature: "sig" }],
        "assistant",
        "session-1",
        {},
        mockClient,
        mockLogger,
      );

      expect(notifications).toHaveLength(0);
    });

    it("should return no notifications for container_upload type", () => {
      const notifications = toAcpNotifications(
        [{ type: "container_upload", file_name: "upload.txt", file_id: "file-123" } as any],
        "assistant",
        "session-1",
        {},
        mockClient,
        mockLogger,
      );

      expect(notifications).toHaveLength(0);
    });
  });

  describe("mixed content blocks", () => {
    it("should handle a mix of text and thinking blocks", () => {
      const notifications = toAcpNotifications(
        [
          { type: "thinking", thinking: "Hmm let me think" },
          { type: "text", text: "Here is my response" },
        ],
        "assistant",
        "session-1",
        {},
        mockClient,
        mockLogger,
      );

      expect(notifications).toHaveLength(2);
      expect(notifications[0].update).toMatchObject({
        sessionUpdate: "agent_thought_chunk",
      });
      expect(notifications[1].update).toMatchObject({
        sessionUpdate: "agent_message_chunk",
      });
    });

    it("should handle content with ignored and valid blocks mixed", () => {
      const notifications = toAcpNotifications(
        [
          { type: "text", text: "Valid text" },
          { type: "redacted_thinking", data: "ignored" },
          { type: "input_json_delta", partial_json: '{"key":' },
        ],
        "assistant",
        "session-1",
        {},
        mockClient,
        mockLogger,
      );

      expect(notifications).toHaveLength(1);
      expect(notifications[0].update).toMatchObject({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Valid text" },
      });
    });

    it("should return empty array for empty content array", () => {
      const notifications = toAcpNotifications(
        [],
        "assistant",
        "session-1",
        {},
        mockClient,
        mockLogger,
      );

      expect(notifications).toHaveLength(0);
    });
  });
});

describe("streamEventToAcpNotifications", () => {
  it("should handle content_block_start with text block", () => {
    const toolUseCache: ToolUseCache = {};
    const message: SDKPartialAssistantMessage = {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "text",
          text: "Hello from stream",
          citations: null,
        },
      },
      parent_tool_use_id: null,
      uuid: "uuid-1",
      session_id: "session-1",
    };

    const notifications = streamEventToAcpNotifications(
      message,
      "session-1",
      toolUseCache,
      mockClient,
      mockLogger,
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Hello from stream",
        },
      },
    });
  });

  it("should handle content_block_start with tool_use block", () => {
    const toolUseCache: ToolUseCache = {};
    const message: SDKPartialAssistantMessage = {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_stream_1",
          name: "Bash",
          input: { command: "echo test" },
        } as any,
      },
      parent_tool_use_id: null,
      uuid: "uuid-2",
      session_id: "session-1",
    };

    const notifications = streamEventToAcpNotifications(
      message,
      "session-1",
      toolUseCache,
      mockClient,
      mockLogger,
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0].update).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "toolu_stream_1",
      status: "pending",
    });
    expect(toolUseCache["toolu_stream_1"]).toBeDefined();
  });

  it("should handle content_block_delta with text_delta", () => {
    const message: SDKPartialAssistantMessage = {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "text_delta",
          text: " more text",
        },
      },
      parent_tool_use_id: null,
      uuid: "uuid-3",
      session_id: "session-1",
    };

    const notifications = streamEventToAcpNotifications(
      message,
      "session-1",
      {},
      mockClient,
      mockLogger,
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: " more text",
        },
      },
    });
  });

  it("should handle content_block_delta with thinking_delta", () => {
    const message: SDKPartialAssistantMessage = {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "thinking_delta",
          thinking: "thinking more...",
        },
      },
      parent_tool_use_id: null,
      uuid: "uuid-4",
      session_id: "session-1",
    };

    const notifications = streamEventToAcpNotifications(
      message,
      "session-1",
      {},
      mockClient,
      mockLogger,
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: {
          type: "text",
          text: "thinking more...",
        },
      },
    });
  });

  it("should return empty array for message_start", () => {
    const message: SDKPartialAssistantMessage = {
      type: "stream_event",
      event: {
        type: "message_start",
        message: {} as any,
      },
      parent_tool_use_id: null,
      uuid: "uuid-5",
      session_id: "session-1",
    };

    const notifications = streamEventToAcpNotifications(
      message,
      "session-1",
      {},
      mockClient,
      mockLogger,
    );

    expect(notifications).toEqual([]);
  });

  it("should return empty array for message_delta", () => {
    const message: SDKPartialAssistantMessage = {
      type: "stream_event",
      event: {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null, container: null },
        usage: { output_tokens: 100 },
        context_management: null,
      },
      parent_tool_use_id: null,
      uuid: "uuid-6",
      session_id: "session-1",
    };

    const notifications = streamEventToAcpNotifications(
      message,
      "session-1",
      {},
      mockClient,
      mockLogger,
    );

    expect(notifications).toEqual([]);
  });

  it("should return empty array for message_stop", () => {
    const message: SDKPartialAssistantMessage = {
      type: "stream_event",
      event: {
        type: "message_stop",
      },
      parent_tool_use_id: null,
      uuid: "uuid-7",
      session_id: "session-1",
    };

    const notifications = streamEventToAcpNotifications(
      message,
      "session-1",
      {},
      mockClient,
      mockLogger,
    );

    expect(notifications).toEqual([]);
  });

  it("should return empty array for content_block_stop", () => {
    const message: SDKPartialAssistantMessage = {
      type: "stream_event",
      event: {
        type: "content_block_stop",
        index: 0,
      },
      parent_tool_use_id: null,
      uuid: "uuid-8",
      session_id: "session-1",
    };

    const notifications = streamEventToAcpNotifications(
      message,
      "session-1",
      {},
      mockClient,
      mockLogger,
    );

    expect(notifications).toEqual([]);
  });

  it("should propagate parentToolUseId from message.parent_tool_use_id", () => {
    const toolUseCache: ToolUseCache = {};
    const message: SDKPartialAssistantMessage = {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_sub",
          name: "Bash",
          input: { command: "echo sub-agent" },
        } as any,
      },
      parent_tool_use_id: "toolu_parent_task",
      uuid: "uuid-9",
      session_id: "session-1",
    };

    const notifications = streamEventToAcpNotifications(
      message,
      "session-1",
      toolUseCache,
      mockClient,
      mockLogger,
    );

    expect(notifications).toHaveLength(1);
    expect((notifications[0].update as any)._meta.claudeCode.parentToolUseId).toBe(
      "toolu_parent_task",
    );
  });

  it("should handle content_block_start with thinking block", () => {
    const message: SDKPartialAssistantMessage = {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "thinking",
          thinking: "Let me analyze this...",
        } as any,
      },
      parent_tool_use_id: null,
      uuid: "uuid-10",
      session_id: "session-1",
    };

    const notifications = streamEventToAcpNotifications(
      message,
      "session-1",
      {},
      mockClient,
      mockLogger,
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: {
          type: "text",
          text: "Let me analyze this...",
        },
      },
    });
  });

  it("should handle content_block_delta with input_json_delta (ignored)", () => {
    const message: SDKPartialAssistantMessage = {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: '{"key":',
        },
      },
      parent_tool_use_id: null,
      uuid: "uuid-11",
      session_id: "session-1",
    };

    const notifications = streamEventToAcpNotifications(
      message,
      "session-1",
      {},
      mockClient,
      mockLogger,
    );

    expect(notifications).toEqual([]);
  });

  it("should handle content_block_delta with signature_delta (ignored)", () => {
    const message: SDKPartialAssistantMessage = {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "signature_delta",
          signature: "sig-data",
        },
      },
      parent_tool_use_id: null,
      uuid: "uuid-12",
      session_id: "session-1",
    };

    const notifications = streamEventToAcpNotifications(
      message,
      "session-1",
      {},
      mockClient,
      mockLogger,
    );

    expect(notifications).toEqual([]);
  });

  it("should handle content_block_delta with citations_delta (ignored)", () => {
    const message: SDKPartialAssistantMessage = {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "citations_delta",
          citation: {} as any,
        },
      },
      parent_tool_use_id: null,
      uuid: "uuid-13",
      session_id: "session-1",
    };

    const notifications = streamEventToAcpNotifications(
      message,
      "session-1",
      {},
      mockClient,
      mockLogger,
    );

    expect(notifications).toEqual([]);
  });

  it("should pass backgroundTaskMap through to toAcpNotifications", () => {
    const toolUseCache: ToolUseCache = {};
    const backgroundTaskMap: Record<string, string> = {};
    const message: SDKPartialAssistantMessage = {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_bg_stream",
          name: "Task",
          input: {
            description: "background",
            prompt: "work",
            run_in_background: true,
          },
        } as any,
      },
      parent_tool_use_id: null,
      uuid: "uuid-14",
      session_id: "session-1",
    };

    const notifications = streamEventToAcpNotifications(
      message,
      "session-1",
      toolUseCache,
      mockClient,
      mockLogger,
      backgroundTaskMap,
    );

    expect(notifications).toHaveLength(1);
    expect((notifications[0].update as any)._meta.claudeCode.isBackground).toBe(true);
  });
});
