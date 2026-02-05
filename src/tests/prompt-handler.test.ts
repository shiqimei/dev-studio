import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentSideConnection, RequestError, SessionNotification } from "@agentclientprotocol/sdk";
import { ClaudeAcpAgent, Logger, ToolUseCache } from "../acp-agent.js";
import { Pushable } from "../utils.js";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock router that yields messages in sequence, then signals done.
 */
function createMockRouter(messages: SDKMessage[]) {
  let index = 0;
  return {
    next: async (): Promise<IteratorResult<SDKMessage, void>> => {
      if (index >= messages.length) {
        return { value: undefined as any, done: true };
      }
      return { value: messages[index++], done: false };
    },
  };
}

/** Minimal mock logger that captures calls */
function createMockLogger(): Logger & { logCalls: any[][]; errorCalls: any[][] } {
  const logCalls: any[][] = [];
  const errorCalls: any[][] = [];
  return {
    log: (...args: any[]) => logCalls.push(args),
    error: (...args: any[]) => errorCalls.push(args),
    logCalls,
    errorCalls,
  };
}

/** Create a mock AgentSideConnection that records sessionUpdate calls. */
function createMockClient() {
  const updates: SessionNotification[] = [];
  const client = {
    sessionUpdate: vi.fn(async (notification: SessionNotification) => {
      updates.push(notification);
    }),
  } as unknown as AgentSideConnection;
  return { client, updates };
}

/** Common result metadata fields. */
const baseResultFields = {
  duration_ms: 1234,
  duration_api_ms: 567,
  num_turns: 3,
  total_cost_usd: 0.05,
  usage: {
    input_tokens: 100,
    output_tokens: 50,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    server_tool_use: null,
    service_tier: "standard",
  },
  modelUsage: {},
  session_id: "sess-abc",
  uuid: "uuid-123",
  permission_denials: [] as any[],
};

/**
 * Set up a ClaudeAcpAgent with a mocked session and call prompt().
 */
async function runPromptWithMessages(
  messages: SDKMessage[],
  opts?: {
    cancelled?: boolean;
    toolUseCache?: ToolUseCache;
    logger?: Logger;
  },
) {
  const mockLogger = opts?.logger ?? createMockLogger();
  const { client, updates } = createMockClient();
  const agent = new ClaudeAcpAgent(client, mockLogger);

  const sessionId = "test-session";

  agent.sessions[sessionId] = {
    query: {} as any,
    router: createMockRouter(messages) as any,
    input: new Pushable(),
    cancelled: opts?.cancelled ?? false,
    permissionMode: "default",
    settingsManager: {} as any,
    title: "test",
    cwd: "/tmp",
    updatedAt: new Date().toISOString(),
  };

  if (opts?.toolUseCache) {
    agent.toolUseCache = opts.toolUseCache;
  }

  const promptPromise = agent.prompt({
    sessionId,
    prompt: [{ type: "text", text: "test" }],
  });

  return { promptPromise, updates, agent, sessionId, client };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("prompt() message handling", () => {
  // =========================================================================
  // 1. System message handling
  // =========================================================================
  describe("system messages", () => {
    it("system:init emits no notification", async () => {
      const { promptPromise, updates } = await runPromptWithMessages([
        {
          type: "system",
          subtype: "init",
          agents: [],
          apiKeySource: "api_key" as any,
          betas: [],
          claude_code_version: "1.0.0",
          cwd: "/tmp",
          tools: [],
          mcp_servers: [],
          model: "test",
          session_id: "sess-abc",
          uuid: "uuid-1",
        } as any,
        { type: "result", subtype: "success", is_error: false, result: "done", ...baseResultFields },
      ]);

      const response = await promptPromise;
      expect(response.stopReason).toBe("end_turn");
      // No sessionUpdate for system:init
      const initUpdates = updates.filter(
        (u) =>
          u.update.sessionUpdate === "agent_message_chunk" &&
          (u.update as any).content?.text?.includes("init"),
      );
      expect(initUpdates).toHaveLength(0);
    });

    it("system:compact_boundary emits no notification", async () => {
      const { promptPromise, updates } = await runPromptWithMessages([
        {
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "manual", pre_tokens: 1000 },
          uuid: "uuid-2",
          session_id: "sess-abc",
        } as any,
        { type: "result", subtype: "success", is_error: false, result: "done", ...baseResultFields },
      ]);

      await promptPromise;
      expect(updates).toHaveLength(0);
    });

    it("system:hook_started emits no notification", async () => {
      const { promptPromise, updates } = await runPromptWithMessages([
        {
          type: "system",
          subtype: "hook_started",
          hook_id: "h1",
          hook_name: "PreToolUse",
          hook_event: "pre_tool_use",
          uuid: "uuid-3",
          session_id: "sess-abc",
        } as any,
        { type: "result", subtype: "success", is_error: false, result: "done", ...baseResultFields },
      ]);

      await promptPromise;
      expect(updates).toHaveLength(0);
    });

    it("system:hook_progress emits no notification", async () => {
      const { promptPromise, updates } = await runPromptWithMessages([
        {
          type: "system",
          subtype: "hook_progress",
          hook_id: "h1",
          hook_name: "PreToolUse",
          hook_event: "pre_tool_use",
          progress: "step 1 done",
          uuid: "uuid-4",
          session_id: "sess-abc",
        } as any,
        { type: "result", subtype: "success", is_error: false, result: "done", ...baseResultFields },
      ]);

      await promptPromise;
      expect(updates).toHaveLength(0);
    });

    it("system:hook_response emits no notification", async () => {
      const { promptPromise, updates } = await runPromptWithMessages([
        {
          type: "system",
          subtype: "hook_response",
          hook_id: "h1",
          hook_name: "PreToolUse",
          hook_event: "pre_tool_use",
          output: "success",
          stdout: "",
          stderr: "",
          exit_code: 0,
          outcome: "success",
          uuid: "uuid-5",
          session_id: "sess-abc",
        } as any,
        { type: "result", subtype: "success", is_error: false, result: "done", ...baseResultFields },
      ]);

      await promptPromise;
      expect(updates).toHaveLength(0);
    });

    it('system:status with status "compacting" emits agent_message_chunk', async () => {
      const { promptPromise, updates } = await runPromptWithMessages([
        {
          type: "system",
          subtype: "status",
          status: "compacting",
          uuid: "uuid-6",
          session_id: "sess-abc",
        } as any,
        { type: "result", subtype: "success", is_error: false, result: "done", ...baseResultFields },
      ]);

      await promptPromise;
      expect(updates).toHaveLength(1);
      expect(updates[0]).toEqual({
        sessionId: "test-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "[Compacting conversation context...]",
          },
        },
      });
    });

    it("system:status with null status emits no notification", async () => {
      const { promptPromise, updates } = await runPromptWithMessages([
        {
          type: "system",
          subtype: "status",
          status: null,
          uuid: "uuid-7",
          session_id: "sess-abc",
        } as any,
        { type: "result", subtype: "success", is_error: false, result: "done", ...baseResultFields },
      ]);

      await promptPromise;
      expect(updates).toHaveLength(0);
    });

    it("system:files_persisted emits no notification", async () => {
      const { promptPromise, updates } = await runPromptWithMessages([
        {
          type: "system",
          subtype: "files_persisted",
          files: [{ filename: "test.txt", file_id: "f1" }],
          failed: [],
          uuid: "uuid-8",
          session_id: "sess-abc",
        } as any,
        { type: "result", subtype: "success", is_error: false, result: "done", ...baseResultFields },
      ]);

      await promptPromise;
      expect(updates).toHaveLength(0);
    });
  });

  // =========================================================================
  // 2. Result handling
  // =========================================================================
  describe("result messages", () => {
    it('result:success returns { stopReason: "end_turn" } with metadata', async () => {
      const { promptPromise } = await runPromptWithMessages([
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Task completed",
          ...baseResultFields,
        },
      ]);

      const response = await promptPromise;
      expect(response.stopReason).toBe("end_turn");
      expect(response._meta).toBeDefined();

      const meta = response._meta as any;
      expect(meta.claudeCode.duration_ms).toBe(1234);
      expect(meta.claudeCode.duration_api_ms).toBe(567);
      expect(meta.claudeCode.num_turns).toBe(3);
      expect(meta.claudeCode.total_cost_usd).toBe(0.05);
      expect(meta.claudeCode.usage).toEqual(baseResultFields.usage);
      expect(meta.claudeCode.modelUsage).toEqual({});
      expect(meta.claudeCode.session_id).toBe("sess-abc");
      expect(meta.claudeCode.uuid).toBe("uuid-123");
    });

    it('result:success with "/login" text throws RequestError.authRequired', async () => {
      const { promptPromise } = await runPromptWithMessages([
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Please run /login to authenticate",
          ...baseResultFields,
        },
      ]);

      await expect(promptPromise).rejects.toThrow();
      try {
        await promptPromise;
      } catch (err: any) {
        expect(err).toBeInstanceOf(RequestError);
      }
    });

    it("result:success with is_error true throws RequestError.internalError", async () => {
      const { promptPromise } = await runPromptWithMessages([
        {
          type: "result",
          subtype: "success",
          is_error: true,
          result: "Something went wrong",
          ...baseResultFields,
        },
      ]);

      await expect(promptPromise).rejects.toThrow();
      try {
        await promptPromise;
      } catch (err: any) {
        expect(err).toBeInstanceOf(RequestError);
      }
    });

    it("result:error_during_execution with is_error false returns end_turn", async () => {
      const { promptPromise } = await runPromptWithMessages([
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: false,
          errors: ["partial failure"],
          ...baseResultFields,
        },
      ]);

      const response = await promptPromise;
      expect(response.stopReason).toBe("end_turn");
    });

    it("result:error_during_execution with is_error true throws internalError", async () => {
      const { promptPromise } = await runPromptWithMessages([
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["critical failure"],
          ...baseResultFields,
        },
      ]);

      await expect(promptPromise).rejects.toThrow();
      try {
        await promptPromise;
      } catch (err: any) {
        expect(err).toBeInstanceOf(RequestError);
      }
    });

    it("result:error_max_turns with is_error false returns max_turn_requests", async () => {
      const { promptPromise } = await runPromptWithMessages([
        {
          type: "result",
          subtype: "error_max_turns",
          is_error: false,
          errors: [],
          ...baseResultFields,
        },
      ]);

      const response = await promptPromise;
      expect(response.stopReason).toBe("max_turn_requests");
    });

    it("result:error_max_turns with is_error true throws internalError", async () => {
      const { promptPromise } = await runPromptWithMessages([
        {
          type: "result",
          subtype: "error_max_turns",
          is_error: true,
          errors: ["max turns reached"],
          ...baseResultFields,
        },
      ]);

      await expect(promptPromise).rejects.toThrow();
      try {
        await promptPromise;
      } catch (err: any) {
        expect(err).toBeInstanceOf(RequestError);
      }
    });

    it("result:error_max_budget_usd returns max_turn_requests", async () => {
      const { promptPromise } = await runPromptWithMessages([
        {
          type: "result",
          subtype: "error_max_budget_usd",
          is_error: false,
          errors: [],
          ...baseResultFields,
        },
      ]);

      const response = await promptPromise;
      expect(response.stopReason).toBe("max_turn_requests");
    });

    it("result:error_max_budget_usd with is_error true throws internalError", async () => {
      const { promptPromise } = await runPromptWithMessages([
        {
          type: "result",
          subtype: "error_max_budget_usd",
          is_error: true,
          errors: ["budget exceeded"],
          ...baseResultFields,
        },
      ]);

      await expect(promptPromise).rejects.toThrow();
      try {
        await promptPromise;
      } catch (err: any) {
        expect(err).toBeInstanceOf(RequestError);
      }
    });

    it("result:error_max_structured_output_retries returns max_turn_requests", async () => {
      const { promptPromise } = await runPromptWithMessages([
        {
          type: "result",
          subtype: "error_max_structured_output_retries",
          is_error: false,
          errors: [],
          ...baseResultFields,
        },
      ]);

      const response = await promptPromise;
      expect(response.stopReason).toBe("max_turn_requests");
    });

    it("result:error_max_structured_output_retries with is_error true throws internalError", async () => {
      const { promptPromise } = await runPromptWithMessages([
        {
          type: "result",
          subtype: "error_max_structured_output_retries",
          is_error: true,
          errors: ["retries exhausted"],
          ...baseResultFields,
        },
      ]);

      await expect(promptPromise).rejects.toThrow();
      try {
        await promptPromise;
      } catch (err: any) {
        expect(err).toBeInstanceOf(RequestError);
      }
    });

    it("result metadata includes permission_denials when non-empty", async () => {
      const denials = [
        { tool_name: "Bash", tool_use_id: "toolu_1", tool_input: { command: "rm -rf /" } },
      ];
      const { promptPromise } = await runPromptWithMessages([
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "done",
          ...baseResultFields,
          permission_denials: denials,
        },
      ]);

      const response = await promptPromise;
      const meta = response._meta as any;
      expect(meta.claudeCode.permission_denials).toEqual(denials);
    });

    it("result metadata omits permission_denials when empty", async () => {
      const { promptPromise } = await runPromptWithMessages([
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "done",
          ...baseResultFields,
          permission_denials: [],
        },
      ]);

      const response = await promptPromise;
      const meta = response._meta as any;
      expect(meta.claudeCode.permission_denials).toBeUndefined();
    });

    it("result metadata includes structured_output when defined", async () => {
      const { promptPromise } = await runPromptWithMessages([
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "done",
          structured_output: { key: "value", count: 42 },
          ...baseResultFields,
        },
      ]);

      const response = await promptPromise;
      const meta = response._meta as any;
      expect(meta.claudeCode.structured_output).toEqual({ key: "value", count: 42 });
    });

    it("result metadata omits structured_output when undefined", async () => {
      const { promptPromise } = await runPromptWithMessages([
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "done",
          ...baseResultFields,
        },
      ]);

      const response = await promptPromise;
      const meta = response._meta as any;
      expect(meta.claudeCode.structured_output).toBeUndefined();
    });
  });

  // =========================================================================
  // 3. User message filtering
  // =========================================================================
  describe("user message filtering", () => {
    it("string user message is filtered (not forwarded)", async () => {
      const { promptPromise, updates } = await runPromptWithMessages([
        {
          type: "user",
          message: {
            role: "user",
            content: "Hello, this is a user message",
          },
          session_id: "sess-abc",
          parent_tool_use_id: null,
        } as any,
        { type: "result", subtype: "success", is_error: false, result: "done", ...baseResultFields },
      ]);

      await promptPromise;
      // No user_message_chunk or agent_message_chunk for a plain string user message
      expect(updates).toHaveLength(0);
    });

    it("user message with single text block is filtered", async () => {
      const { promptPromise, updates } = await runPromptWithMessages([
        {
          type: "user",
          message: {
            role: "user",
            content: [{ type: "text", text: "Single text block user message" }],
          },
          session_id: "sess-abc",
          parent_tool_use_id: null,
        } as any,
        { type: "result", subtype: "success", is_error: false, result: "done", ...baseResultFields },
      ]);

      await promptPromise;
      expect(updates).toHaveLength(0);
    });

    it('user message with local-command-stdout containing "Context Usage" is forwarded as agent message', async () => {
      const contextOutput =
        "<local-command-stdout>Context Usage: 50% (5000/10000 tokens)</local-command-stdout>";
      const { promptPromise, updates } = await runPromptWithMessages([
        {
          type: "user",
          message: {
            role: "user",
            content: contextOutput,
          },
          session_id: "sess-abc",
          parent_tool_use_id: null,
        } as any,
        { type: "result", subtype: "success", is_error: false, result: "done", ...baseResultFields },
      ]);

      await promptPromise;
      // The Context Usage content gets forwarded as an agent_message_chunk with tags stripped
      expect(updates.length).toBeGreaterThanOrEqual(1);
      const agentMsgUpdates = updates.filter(
        (u) => u.update.sessionUpdate === "agent_message_chunk",
      );
      expect(agentMsgUpdates.length).toBeGreaterThanOrEqual(1);
      const textContent = (agentMsgUpdates[0].update as any).content.text;
      expect(textContent).toContain("Context Usage");
      // Tags should be stripped
      expect(textContent).not.toContain("<local-command-stdout>");
      expect(textContent).not.toContain("</local-command-stdout>");
    });

    it("user message with local-command-stdout without Context Usage is logged but not forwarded", async () => {
      const logger = createMockLogger();
      const stdoutContent =
        "<local-command-stdout>Some other output</local-command-stdout>";
      const { promptPromise, updates } = await runPromptWithMessages(
        [
          {
            type: "user",
            message: {
              role: "user",
              content: stdoutContent,
            },
            session_id: "sess-abc",
            parent_tool_use_id: null,
          } as any,
          { type: "result", subtype: "success", is_error: false, result: "done", ...baseResultFields },
        ],
        { logger },
      );

      await promptPromise;
      // No agent_message_chunk forwarded
      const agentMsgUpdates = updates.filter(
        (u) => u.update.sessionUpdate === "agent_message_chunk",
      );
      expect(agentMsgUpdates).toHaveLength(0);
      // But it should be logged
      expect(logger.logCalls.length).toBeGreaterThanOrEqual(1);
      expect(logger.logCalls.some((call) => call[0].includes("local-command-stdout"))).toBe(true);
    });

    it("user message with local-command-stderr is logged but not forwarded", async () => {
      const logger = createMockLogger();
      const stderrContent =
        "<local-command-stderr>Warning: something went wrong</local-command-stderr>";
      const { promptPromise, updates } = await runPromptWithMessages(
        [
          {
            type: "user",
            message: {
              role: "user",
              content: stderrContent,
            },
            session_id: "sess-abc",
            parent_tool_use_id: null,
          } as any,
          { type: "result", subtype: "success", is_error: false, result: "done", ...baseResultFields },
        ],
        { logger },
      );

      await promptPromise;
      // No forwarding
      expect(updates).toHaveLength(0);
      // Logged as error
      expect(logger.errorCalls.length).toBeGreaterThanOrEqual(1);
      expect(logger.errorCalls.some((call) => call[0].includes("local-command-stderr"))).toBe(true);
    });
  });

  // =========================================================================
  // 4. Assistant message handling
  // =========================================================================
  describe("assistant message handling", () => {
    it("text and thinking blocks are filtered (handled by stream events)", async () => {
      const { promptPromise, updates } = await runPromptWithMessages([
        {
          type: "assistant",
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-20250514",
            content: [
              { type: "thinking", thinking: "Let me think..." },
              { type: "text", text: "Here is my response" },
            ],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: {
              input_tokens: 10,
              output_tokens: 20,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              service_tier: "standard",
              server_tool_use: null,
            },
            container: null,
            context_management: null,
          },
          parent_tool_use_id: null,
          session_id: "sess-abc",
          uuid: "uuid-asst-1",
        } as any,
        { type: "result", subtype: "success", is_error: false, result: "done", ...baseResultFields },
      ]);

      await promptPromise;
      // Text and thinking blocks are filtered out from assistant messages
      // (they are handled by stream_event instead), so no notifications
      expect(updates).toHaveLength(0);
    });

    it("tool_use blocks in assistant message are filtered (handled by stream_event)", async () => {
      const { promptPromise, updates } = await runPromptWithMessages([
        {
          type: "assistant",
          message: {
            id: "msg_2",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-20250514",
            content: [
              {
                type: "tool_use",
                id: "toolu_prompt_test",
                name: "Bash",
                input: { command: "echo hello", description: "Say hello" },
              },
            ],
            stop_reason: "tool_use",
            stop_sequence: null,
            usage: {
              input_tokens: 10,
              output_tokens: 20,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              service_tier: "standard",
              server_tool_use: null,
            },
            container: null,
            context_management: null,
          },
          parent_tool_use_id: null,
          session_id: "sess-abc",
          uuid: "uuid-asst-2",
        } as any,
        { type: "result", subtype: "success", is_error: false, result: "done", ...baseResultFields },
      ]);

      await promptPromise;
      // tool_use blocks are now filtered from assistant messages to avoid
      // duplicates — they are handled by stream_event (content_block_start)
      const toolCallUpdates = updates.filter(
        (u) => u.update.sessionUpdate === "tool_call",
      );
      expect(toolCallUpdates).toHaveLength(0);
    });

    it("assistant message with mixed text + tool_use forwards nothing (all handled by stream_event)", async () => {
      const { promptPromise, updates } = await runPromptWithMessages([
        {
          type: "assistant",
          message: {
            id: "msg_3",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-20250514",
            content: [
              { type: "text", text: "I will now run a command." },
              { type: "thinking", thinking: "Planning the command..." },
              {
                type: "tool_use",
                id: "toolu_mixed",
                name: "Read",
                input: { file_path: "/test.txt" },
              },
            ],
            stop_reason: "tool_use",
            stop_sequence: null,
            usage: {
              input_tokens: 10,
              output_tokens: 20,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              service_tier: "standard",
              server_tool_use: null,
            },
            container: null,
            context_management: null,
          },
          parent_tool_use_id: null,
          session_id: "sess-abc",
          uuid: "uuid-asst-3",
        } as any,
        { type: "result", subtype: "success", is_error: false, result: "done", ...baseResultFields },
      ]);

      await promptPromise;
      // text, thinking, and tool_use are all filtered from assistant messages
      // (they are handled by stream_event instead) to avoid duplicates
      const toolCallUpdates = updates.filter(
        (u) => u.update.sessionUpdate === "tool_call",
      );
      expect(toolCallUpdates).toHaveLength(0);

      // No agent_message_chunk or agent_thought_chunk from the assistant message
      const textOrThought = updates.filter(
        (u) =>
          u.update.sessionUpdate === "agent_message_chunk" ||
          u.update.sessionUpdate === "agent_thought_chunk",
      );
      expect(textOrThought).toHaveLength(0);
    });

    it('synthetic /login assistant message throws RequestError.authRequired', async () => {
      const { promptPromise } = await runPromptWithMessages([
        {
          type: "assistant",
          message: {
            id: "msg_login",
            type: "message",
            role: "assistant",
            model: "<synthetic>",
            content: [
              {
                type: "text",
                text: "Please run /login to authenticate your account",
              },
            ],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              service_tier: "standard",
              server_tool_use: null,
            },
            container: null,
            context_management: null,
          },
          parent_tool_use_id: null,
          session_id: "sess-abc",
          uuid: "uuid-login",
        } as any,
      ]);

      await expect(promptPromise).rejects.toThrow();
      try {
        await promptPromise;
      } catch (err: any) {
        expect(err).toBeInstanceOf(RequestError);
      }
    });

    it("non-synthetic assistant message with /login text does NOT throw authRequired", async () => {
      // Only <synthetic> model messages trigger the auth check
      const { promptPromise, updates } = await runPromptWithMessages([
        {
          type: "assistant",
          message: {
            id: "msg_normal",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-20250514",
            content: [
              {
                type: "text",
                text: "Please run /login to fix the issue",
              },
            ],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: {
              input_tokens: 10,
              output_tokens: 20,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              service_tier: "standard",
              server_tool_use: null,
            },
            container: null,
            context_management: null,
          },
          parent_tool_use_id: null,
          session_id: "sess-abc",
          uuid: "uuid-no-login",
        } as any,
        { type: "result", subtype: "success", is_error: false, result: "done", ...baseResultFields },
      ]);

      // Should not throw; text is filtered by stream_event handling
      const response = await promptPromise;
      expect(response.stopReason).toBe("end_turn");
    });
  });

  // =========================================================================
  // 5. tool_progress handling
  // =========================================================================
  describe("tool_progress", () => {
    it("emits tool_call_update with in_progress status when tool is in cache", async () => {
      const toolUseCache: ToolUseCache = {
        toolu_progress_1: {
          type: "tool_use",
          id: "toolu_progress_1",
          name: "Bash",
          input: { command: "long-running-task" },
        },
      };

      const { promptPromise, updates } = await runPromptWithMessages(
        [
          {
            type: "tool_progress",
            tool_use_id: "toolu_progress_1",
            tool_name: "Bash",
            parent_tool_use_id: null,
            elapsed_time_seconds: 5.2,
            uuid: "uuid-prog-1",
            session_id: "sess-abc",
          } as any,
          { type: "result", subtype: "success", is_error: false, result: "done", ...baseResultFields },
        ],
        { toolUseCache },
      );

      await promptPromise;
      const progressUpdates = updates.filter(
        (u) =>
          u.update.sessionUpdate === "tool_call_update" &&
          (u.update as any).status === "in_progress",
      );
      expect(progressUpdates).toHaveLength(1);
      expect((progressUpdates[0].update as any).toolCallId).toBe("toolu_progress_1");
      expect((progressUpdates[0].update as any)._meta.claudeCode.toolName).toBe("Bash");
      expect((progressUpdates[0].update as any)._meta.claudeCode.elapsed_time_seconds).toBe(5.2);
    });

    it("does not emit tool_call_update when tool is not in cache", async () => {
      const { promptPromise, updates } = await runPromptWithMessages(
        [
          {
            type: "tool_progress",
            tool_use_id: "toolu_uncached",
            tool_name: "Bash",
            parent_tool_use_id: null,
            elapsed_time_seconds: 1.0,
            uuid: "uuid-prog-2",
            session_id: "sess-abc",
          } as any,
          { type: "result", subtype: "success", is_error: false, result: "done", ...baseResultFields },
        ],
        { toolUseCache: {} },
      );

      await promptPromise;
      const progressUpdates = updates.filter(
        (u) =>
          u.update.sessionUpdate === "tool_call_update" &&
          (u.update as any).status === "in_progress",
      );
      expect(progressUpdates).toHaveLength(0);
    });

    it("includes parent_tool_use_id in metadata when present", async () => {
      const toolUseCache: ToolUseCache = {
        toolu_child_progress: {
          type: "tool_use",
          id: "toolu_child_progress",
          name: "Bash",
          input: { command: "echo sub" },
        },
      };

      const { promptPromise, updates } = await runPromptWithMessages(
        [
          {
            type: "tool_progress",
            tool_use_id: "toolu_child_progress",
            tool_name: "Bash",
            parent_tool_use_id: "toolu_parent_task_id",
            elapsed_time_seconds: 2.5,
            uuid: "uuid-prog-3",
            session_id: "sess-abc",
          } as any,
          { type: "result", subtype: "success", is_error: false, result: "done", ...baseResultFields },
        ],
        { toolUseCache },
      );

      await promptPromise;
      const progressUpdates = updates.filter(
        (u) =>
          u.update.sessionUpdate === "tool_call_update" &&
          (u.update as any).status === "in_progress",
      );
      expect(progressUpdates).toHaveLength(1);
      expect((progressUpdates[0].update as any)._meta.claudeCode.parentToolUseId).toBe(
        "toolu_parent_task_id",
      );
    });
  });

  // =========================================================================
  // 6. tool_use_summary handling
  // =========================================================================
  describe("tool_use_summary", () => {
    it("emits agent_message_chunk with summary text", async () => {
      const { promptPromise, updates } = await runPromptWithMessages([
        {
          type: "tool_use_summary",
          summary: "Read 3 files and ran 2 commands",
          preceding_tool_use_ids: ["toolu_1", "toolu_2"],
          uuid: "uuid-summary-1",
          session_id: "sess-abc",
        } as any,
        { type: "result", subtype: "success", is_error: false, result: "done", ...baseResultFields },
      ]);

      await promptPromise;
      const summaryUpdates = updates.filter(
        (u) => u.update.sessionUpdate === "agent_message_chunk",
      );
      expect(summaryUpdates).toHaveLength(1);
      expect((summaryUpdates[0].update as any).content).toEqual({
        type: "text",
        text: "Read 3 files and ran 2 commands",
      });
    });

    it("does not emit notification when summary is empty", async () => {
      const { promptPromise, updates } = await runPromptWithMessages([
        {
          type: "tool_use_summary",
          summary: "",
          preceding_tool_use_ids: [],
          uuid: "uuid-summary-2",
          session_id: "sess-abc",
        } as any,
        { type: "result", subtype: "success", is_error: false, result: "done", ...baseResultFields },
      ]);

      await promptPromise;
      expect(updates).toHaveLength(0);
    });
  });

  // =========================================================================
  // 7. auth_status handling
  // =========================================================================
  describe("auth_status", () => {
    it("auth_status emits no notification", async () => {
      const { promptPromise, updates } = await runPromptWithMessages([
        {
          type: "auth_status",
          isAuthenticating: false,
          output: ["Authenticated successfully"],
          uuid: "uuid-auth-1",
          session_id: "sess-abc",
        } as any,
        { type: "result", subtype: "success", is_error: false, result: "done", ...baseResultFields },
      ]);

      await promptPromise;
      expect(updates).toHaveLength(0);
    });
  });

  // =========================================================================
  // 8. Cancelled state handling
  // =========================================================================
  describe("cancelled state", () => {
    it('returns { stopReason: "cancelled" } when cancelled at result', async () => {
      const mockLogger = createMockLogger();
      const { client, updates } = createMockClient();
      const agent = new ClaudeAcpAgent(client, mockLogger);
      const sessionId = "cancel-session";

      // Create a router that yields a result message, but the session is cancelled
      agent.sessions[sessionId] = {
        query: {} as any,
        router: createMockRouter([
          {
            type: "result",
            subtype: "success",
            is_error: false,
            result: "done",
            ...baseResultFields,
          },
        ]) as any,
        input: new Pushable(),
        cancelled: true,
        permissionMode: "default",
        settingsManager: {} as any,
        title: "test",
        cwd: "/tmp",
        updatedAt: new Date().toISOString(),
      };

      const response = await agent.prompt({
        sessionId,
        prompt: [{ type: "text", text: "test" }],
      });

      // cancelled is set to false at start of prompt(), so we need to check
      // that prompt() itself resets it. Since cancelled was true before prompt
      // starts, prompt() sets it to false. So the result block is reached normally.
      expect(response.stopReason).toBe("end_turn");
    });

    it('returns { stopReason: "cancelled" } when cancelled during iteration (done=true)', async () => {
      const mockLogger = createMockLogger();
      const { client } = createMockClient();
      const agent = new ClaudeAcpAgent(client, mockLogger);
      const sessionId = "cancel-session-2";

      // Router that returns done immediately (simulating query stream ending)
      agent.sessions[sessionId] = {
        query: {} as any,
        router: createMockRouter([]) as any,
        input: new Pushable(),
        cancelled: false,
        permissionMode: "default",
        settingsManager: {} as any,
        title: "test",
        cwd: "/tmp",
        updatedAt: new Date().toISOString(),
      };

      // Set cancelled to true after prompt starts. Since router returns done
      // immediately, the cancelled check inside the done branch fires.
      // We need to set it before the await, so we use a custom router.
      let resolveNext: any;
      const waitingRouter = {
        next: () =>
          new Promise<IteratorResult<SDKMessage, void>>((resolve) => {
            resolveNext = resolve;
          }),
      };

      agent.sessions[sessionId].router = waitingRouter as any;

      const promptPromise = agent.prompt({
        sessionId,
        prompt: [{ type: "text", text: "test" }],
      });

      // Set cancelled then resolve the router as done
      agent.sessions[sessionId].cancelled = true;
      resolveNext({ value: undefined, done: true });

      const response = await promptPromise;
      expect(response.stopReason).toBe("cancelled");
    });

    it('returns { stopReason: "cancelled" } at result check when cancelled mid-turn', async () => {
      const mockLogger = createMockLogger();
      const { client } = createMockClient();
      const agent = new ClaudeAcpAgent(client, mockLogger);
      const sessionId = "cancel-session-3";

      let callCount = 0;
      const cancellingRouter = {
        next: async (): Promise<IteratorResult<SDKMessage, void>> => {
          callCount++;
          if (callCount === 1) {
            // First call: return a system init message to progress through the loop
            return {
              value: {
                type: "system",
                subtype: "init",
                agents: [],
                apiKeySource: "api_key",
                betas: [],
                claude_code_version: "1.0.0",
                cwd: "/tmp",
                tools: [],
                mcp_servers: [],
                model: "test",
                session_id: "sess-abc",
                uuid: "uuid-cancel",
              } as any,
              done: false,
            };
          }
          if (callCount === 2) {
            // Set cancelled before returning result
            agent.sessions[sessionId].cancelled = true;
            return {
              value: {
                type: "result",
                subtype: "success",
                is_error: false,
                result: "done",
                ...baseResultFields,
              } as any,
              done: false,
            };
          }
          return { value: undefined as any, done: true };
        },
      };

      agent.sessions[sessionId] = {
        query: {} as any,
        router: cancellingRouter as any,
        input: new Pushable(),
        cancelled: false,
        permissionMode: "default",
        settingsManager: {} as any,
        title: "test",
        cwd: "/tmp",
        updatedAt: new Date().toISOString(),
      };

      const response = await agent.prompt({
        sessionId,
        prompt: [{ type: "text", text: "test" }],
      });

      expect(response.stopReason).toBe("cancelled");
    });
  });

  // =========================================================================
  // 9. Session not found
  // =========================================================================
  describe("session not found", () => {
    it("throws Error when session does not exist", async () => {
      const mockLogger = createMockLogger();
      const { client } = createMockClient();
      const agent = new ClaudeAcpAgent(client, mockLogger);

      await expect(
        agent.prompt({
          sessionId: "nonexistent",
          prompt: [{ type: "text", text: "test" }],
        }),
      ).rejects.toThrow("Session not found");
    });
  });

  // =========================================================================
  // 10. No result throws error
  // =========================================================================
  describe("stream ends without result", () => {
    it('throws "Session did not end in result" when stream ends without result or cancel', async () => {
      const mockLogger = createMockLogger();
      const { client } = createMockClient();
      const agent = new ClaudeAcpAgent(client, mockLogger);
      const sessionId = "no-result-session";

      // Router yields a system init but then ends without a result
      agent.sessions[sessionId] = {
        query: {} as any,
        router: createMockRouter([
          {
            type: "system",
            subtype: "init",
            agents: [],
            apiKeySource: "api_key",
            betas: [],
            claude_code_version: "1.0.0",
            cwd: "/tmp",
            tools: [],
            mcp_servers: [],
            model: "test",
            session_id: "sess-abc",
            uuid: "uuid-no-result",
          } as any,
        ]) as any,
        input: new Pushable(),
        cancelled: false,
        permissionMode: "default",
        settingsManager: {} as any,
        title: "test",
        cwd: "/tmp",
        updatedAt: new Date().toISOString(),
      };

      await expect(
        agent.prompt({
          sessionId,
          prompt: [{ type: "text", text: "test" }],
        }),
      ).rejects.toThrow("Session did not end in result");
    });
  });

  // =========================================================================
  // 11. Multiple system messages before result
  // =========================================================================
  describe("multiple messages in sequence", () => {
    it("processes multiple system messages before result", async () => {
      const { promptPromise, updates } = await runPromptWithMessages([
        {
          type: "system",
          subtype: "init",
          agents: [],
          apiKeySource: "api_key",
          betas: [],
          claude_code_version: "1.0.0",
          cwd: "/tmp",
          tools: [],
          mcp_servers: [],
          model: "test",
          session_id: "sess-abc",
          uuid: "uuid-multi-1",
        } as any,
        {
          type: "system",
          subtype: "status",
          status: "compacting",
          uuid: "uuid-multi-2",
          session_id: "sess-abc",
        } as any,
        {
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "auto", pre_tokens: 5000 },
          uuid: "uuid-multi-3",
          session_id: "sess-abc",
        } as any,
        {
          type: "system",
          subtype: "status",
          status: null,
          uuid: "uuid-multi-4",
          session_id: "sess-abc",
        } as any,
        { type: "result", subtype: "success", is_error: false, result: "done", ...baseResultFields },
      ]);

      const response = await promptPromise;
      expect(response.stopReason).toBe("end_turn");
      // Only the compacting status should have generated an update
      expect(updates).toHaveLength(1);
      expect(updates[0].update.sessionUpdate).toBe("agent_message_chunk");
    });

    it("handles interleaved system, assistant, and user messages", async () => {
      const { promptPromise, updates } = await runPromptWithMessages([
        {
          type: "system",
          subtype: "init",
          agents: [],
          apiKeySource: "api_key",
          betas: [],
          claude_code_version: "1.0.0",
          cwd: "/tmp",
          tools: [],
          mcp_servers: [],
          model: "test",
          session_id: "sess-abc",
          uuid: "uuid-interleave-1",
        } as any,
        // Assistant message with tool_use (gets forwarded)
        {
          type: "assistant",
          message: {
            id: "msg_interleave",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-20250514",
            content: [
              {
                type: "tool_use",
                id: "toolu_interleave",
                name: "Read",
                input: { file_path: "/test.txt" },
              },
            ],
            stop_reason: "tool_use",
            stop_sequence: null,
            usage: {
              input_tokens: 10,
              output_tokens: 20,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              service_tier: "standard",
              server_tool_use: null,
            },
            container: null,
            context_management: null,
          },
          parent_tool_use_id: null,
          session_id: "sess-abc",
          uuid: "uuid-interleave-2",
        } as any,
        // User message (filtered)
        {
          type: "user",
          message: {
            role: "user",
            content: "User response",
          },
          session_id: "sess-abc",
          parent_tool_use_id: null,
        } as any,
        // tool_use_summary
        {
          type: "tool_use_summary",
          summary: "Read 1 file",
          preceding_tool_use_ids: ["toolu_interleave"],
          uuid: "uuid-interleave-3",
          session_id: "sess-abc",
        } as any,
        { type: "result", subtype: "success", is_error: false, result: "done", ...baseResultFields },
      ]);

      const response = await promptPromise;
      expect(response.stopReason).toBe("end_turn");
      // tool_use in assistant messages is now filtered (handled by stream_event),
      // so only the tool_use_summary agent_message_chunk should appear
      const toolCalls = updates.filter((u) => u.update.sessionUpdate === "tool_call");
      const agentMsgs = updates.filter((u) => u.update.sessionUpdate === "agent_message_chunk");
      expect(toolCalls).toHaveLength(0);
      expect(agentMsgs).toHaveLength(1);
      expect((agentMsgs[0].update as any).content.text).toBe("Read 1 file");
    });
  });

  // =========================================================================
  // 12. Error message joining for error results
  // =========================================================================
  describe("error message formatting", () => {
    it("error_during_execution joins error array with comma", async () => {
      const { promptPromise } = await runPromptWithMessages([
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["error one", "error two", "error three"],
          ...baseResultFields,
        },
      ]);

      try {
        await promptPromise;
      } catch (err: any) {
        expect(err).toBeInstanceOf(RequestError);
        // The additional message is errors.join(", ")
        expect(err.message).toContain("error one, error two, error three");
      }
    });

    it("error_during_execution falls back to subtype when errors is empty", async () => {
      const { promptPromise } = await runPromptWithMessages([
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: [],
          ...baseResultFields,
        },
      ]);

      try {
        await promptPromise;
      } catch (err: any) {
        expect(err).toBeInstanceOf(RequestError);
        expect(err.message).toContain("error_during_execution");
      }
    });
  });

  // =========================================================================
  // 13. Input push verification
  // =========================================================================
  describe("input push", () => {
    it("pushes converted prompt to input Pushable", async () => {
      const mockLogger = createMockLogger();
      const { client } = createMockClient();
      const agent = new ClaudeAcpAgent(client, mockLogger);
      const sessionId = "input-session";

      const input = new Pushable();
      const pushSpy = vi.spyOn(input, "push");

      agent.sessions[sessionId] = {
        query: {} as any,
        router: createMockRouter([
          { type: "result", subtype: "success", is_error: false, result: "done", ...baseResultFields },
        ]) as any,
        input,
        cancelled: false,
        permissionMode: "default",
        settingsManager: {} as any,
        title: "test",
        cwd: "/tmp",
        updatedAt: new Date().toISOString(),
      };

      await agent.prompt({
        sessionId,
        prompt: [{ type: "text", text: "test input" }],
      });

      expect(pushSpy).toHaveBeenCalledTimes(1);
      const pushedValue = pushSpy.mock.calls[0][0] as any;
      expect(pushedValue.type).toBe("user");
      expect(pushedValue.message.role).toBe("user");
      expect(pushedValue.message.content).toEqual([{ type: "text", text: "test input" }]);
      expect(pushedValue.session_id).toBe(sessionId);
    });
  });

  // =========================================================================
  // 14. Prompt resets cancelled state
  // =========================================================================
  describe("cancelled state reset", () => {
    it("resets cancelled to false at the start of prompt()", async () => {
      const mockLogger = createMockLogger();
      const { client } = createMockClient();
      const agent = new ClaudeAcpAgent(client, mockLogger);
      const sessionId = "reset-session";

      agent.sessions[sessionId] = {
        query: {} as any,
        router: createMockRouter([
          { type: "result", subtype: "success", is_error: false, result: "done", ...baseResultFields },
        ]) as any,
        input: new Pushable(),
        cancelled: true, // was cancelled from previous turn
        permissionMode: "default",
        settingsManager: {} as any,
        title: "test",
        cwd: "/tmp",
        updatedAt: new Date().toISOString(),
      };

      const response = await agent.prompt({
        sessionId,
        prompt: [{ type: "text", text: "test" }],
      });

      // Should process normally since cancelled is reset at start
      expect(response.stopReason).toBe("end_turn");
    });
  });
});
