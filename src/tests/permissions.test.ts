import { vi, describe, it, expect, beforeEach } from "vitest";
import { ClaudeAcpAgent } from "../acp-agent.js";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { EDIT_TOOL_NAMES, acpToolNames } from "../tools.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockClient() {
  return {
    sessionUpdate: vi.fn().mockResolvedValue(undefined),
    requestPermission: vi.fn(),
    readTextFile: vi.fn(),
    writeTextFile: vi.fn(),
  } as unknown as AgentSideConnection & {
    sessionUpdate: ReturnType<typeof vi.fn>;
    requestPermission: ReturnType<typeof vi.fn>;
  };
}

function makeAbortSignal(): { signal: AbortSignal; abort: () => void } {
  const controller = new AbortController();
  return { signal: controller.signal, abort: () => controller.abort() };
}

/**
 * Inject a fake session into the agent so canUseTool() can find it.
 */
function injectSession(
  agent: ClaudeAcpAgent,
  sessionId: string,
  permissionMode: string,
) {
  (agent.sessions as any)[sessionId] = {
    query: {} as any,
    router: {} as any,
    input: {} as any,
    cancelled: false,
    permissionMode,
    settingsManager: {} as any,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("canUseTool()", () => {
  let mockClient: ReturnType<typeof makeMockClient>;
  let agent: ClaudeAcpAgent;
  const SESSION_ID = "test-session";
  const TOOL_USE_ID = "toolu_test123";

  beforeEach(() => {
    mockClient = makeMockClient();
    agent = new ClaudeAcpAgent(mockClient as unknown as AgentSideConnection);
  });

  // =========================================================================
  // Session-not-found edge case
  // =========================================================================
  describe("session not found", () => {
    it("returns deny with 'Session not found' when session does not exist", async () => {
      const canUse = agent.canUseTool("nonexistent-session");
      const { signal } = makeAbortSignal();

      const result = await canUse("Bash", { command: "ls" }, { signal, toolUseID: TOOL_USE_ID });

      expect(result).toEqual({
        behavior: "deny",
        message: "Session not found",
        interrupt: true,
      });
    });
  });

  // =========================================================================
  // ExitPlanMode flow
  // =========================================================================
  describe("ExitPlanMode", () => {
    beforeEach(() => {
      injectSession(agent, SESSION_ID, "plan");
    });

    it("allows with mode change to acceptEdits and sends current_mode_update", async () => {
      mockClient.requestPermission.mockResolvedValue({
        outcome: { outcome: "selected", optionId: "acceptEdits" },
      });

      const canUse = agent.canUseTool(SESSION_ID);
      const { signal } = makeAbortSignal();
      const toolInput = { plan: "do something" };

      const result = await canUse("ExitPlanMode", toolInput, {
        signal,
        toolUseID: TOOL_USE_ID,
      });

      expect(result).toEqual({
        behavior: "allow",
        updatedInput: toolInput,
        updatedPermissions: [
          { type: "setMode", mode: "acceptEdits", destination: "session" },
        ],
      });

      // Session permissionMode was updated
      expect(agent.sessions[SESSION_ID].permissionMode).toBe("acceptEdits");

      // sessionUpdate was called with current_mode_update
      expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
        sessionId: SESSION_ID,
        update: {
          sessionUpdate: "current_mode_update",
          currentModeId: "acceptEdits",
        },
      });
    });

    it("allows with mode change to default", async () => {
      mockClient.requestPermission.mockResolvedValue({
        outcome: { outcome: "selected", optionId: "default" },
      });

      const canUse = agent.canUseTool(SESSION_ID);
      const { signal } = makeAbortSignal();
      const toolInput = { plan: "my plan" };

      const result = await canUse("ExitPlanMode", toolInput, {
        signal,
        toolUseID: TOOL_USE_ID,
      });

      expect(result).toEqual({
        behavior: "allow",
        updatedInput: toolInput,
        updatedPermissions: [
          { type: "setMode", mode: "default", destination: "session" },
        ],
      });

      expect(agent.sessions[SESSION_ID].permissionMode).toBe("default");
      expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
        sessionId: SESSION_ID,
        update: {
          sessionUpdate: "current_mode_update",
          currentModeId: "default",
        },
      });
    });

    it("uses provided suggestions when available instead of generating defaults", async () => {
      mockClient.requestPermission.mockResolvedValue({
        outcome: { outcome: "selected", optionId: "acceptEdits" },
      });

      const canUse = agent.canUseTool(SESSION_ID);
      const { signal } = makeAbortSignal();
      const customSuggestions = [
        { type: "addRules" as const, rules: [{ toolName: "Bash" }], behavior: "allow" as const, destination: "session" as const },
      ];
      const toolInput = { plan: "plan" };

      const result = await canUse("ExitPlanMode", toolInput, {
        signal,
        suggestions: customSuggestions,
        toolUseID: TOOL_USE_ID,
      });

      expect(result).toEqual({
        behavior: "allow",
        updatedInput: toolInput,
        updatedPermissions: customSuggestions,
      });
    });

    it("denies when user selects plan (reject)", async () => {
      mockClient.requestPermission.mockResolvedValue({
        outcome: { outcome: "selected", optionId: "plan" },
      });

      const canUse = agent.canUseTool(SESSION_ID);
      const { signal } = makeAbortSignal();

      const result = await canUse("ExitPlanMode", { plan: "plan" }, {
        signal,
        toolUseID: TOOL_USE_ID,
      });

      expect(result).toEqual({
        behavior: "deny",
        message: "User rejected request to exit plan mode.",
        interrupt: true,
      });
    });

    it("throws when signal is aborted", async () => {
      const { signal, abort } = makeAbortSignal();

      // Abort before requestPermission resolves
      mockClient.requestPermission.mockImplementation(async () => {
        abort();
        return { outcome: { outcome: "selected", optionId: "acceptEdits" } };
      });

      const canUse = agent.canUseTool(SESSION_ID);

      await expect(
        canUse("ExitPlanMode", { plan: "plan" }, { signal, toolUseID: TOOL_USE_ID }),
      ).rejects.toThrow("Tool use aborted");
    });

    it("throws when response outcome is cancelled", async () => {
      mockClient.requestPermission.mockResolvedValue({
        outcome: { outcome: "cancelled" },
      });

      const canUse = agent.canUseTool(SESSION_ID);
      const { signal } = makeAbortSignal();

      await expect(
        canUse("ExitPlanMode", { plan: "plan" }, { signal, toolUseID: TOOL_USE_ID }),
      ).rejects.toThrow("Tool use aborted");
    });

    it("sends correct requestPermission options", async () => {
      mockClient.requestPermission.mockResolvedValue({
        outcome: { outcome: "selected", optionId: "acceptEdits" },
      });

      const canUse = agent.canUseTool(SESSION_ID);
      const { signal } = makeAbortSignal();
      const toolInput = { plan: "test plan" };

      await canUse("ExitPlanMode", toolInput, { signal, toolUseID: TOOL_USE_ID });

      expect(mockClient.requestPermission).toHaveBeenCalledWith({
        options: [
          {
            kind: "allow_always",
            name: "Yes, and auto-accept edits",
            optionId: "acceptEdits",
          },
          {
            kind: "allow_once",
            name: "Yes, and manually approve edits",
            optionId: "default",
          },
          {
            kind: "reject_once",
            name: "No, keep planning",
            optionId: "plan",
          },
        ],
        sessionId: SESSION_ID,
        toolCall: {
          toolCallId: TOOL_USE_ID,
          rawInput: toolInput,
          title: "Ready to code?",
        },
      });
    });
  });

  // =========================================================================
  // bypassPermissions mode
  // =========================================================================
  describe("bypassPermissions mode", () => {
    beforeEach(() => {
      injectSession(agent, SESSION_ID, "bypassPermissions");
    });

    it("allows any tool immediately with updatedPermissions", async () => {
      const canUse = agent.canUseTool(SESSION_ID);
      const { signal } = makeAbortSignal();
      const toolInput = { command: "rm -rf /" };

      const result = await canUse("Bash", toolInput, { signal, toolUseID: TOOL_USE_ID });

      expect(result).toEqual({
        behavior: "allow",
        updatedInput: toolInput,
        updatedPermissions: [
          { type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow", destination: "session" },
        ],
      });

      // requestPermission should NOT have been called
      expect(mockClient.requestPermission).not.toHaveBeenCalled();
    });

    it("uses provided suggestions when available", async () => {
      const canUse = agent.canUseTool(SESSION_ID);
      const { signal } = makeAbortSignal();
      const customSuggestions = [
        { type: "setMode" as const, mode: "bypassPermissions" as const, destination: "session" as const },
      ];

      const result = await canUse("Bash", { command: "echo hi" }, {
        signal,
        suggestions: customSuggestions,
        toolUseID: TOOL_USE_ID,
      });

      expect(result).toEqual({
        behavior: "allow",
        updatedInput: { command: "echo hi" },
        updatedPermissions: customSuggestions,
      });
    });

    it("bypasses for edit tools too", async () => {
      const canUse = agent.canUseTool(SESSION_ID);
      const { signal } = makeAbortSignal();

      for (const editTool of EDIT_TOOL_NAMES) {
        const toolInput = { file_path: "/test.txt", content: "hi" };
        const result = await canUse(editTool, toolInput, { signal, toolUseID: TOOL_USE_ID });

        expect(result).toMatchObject({ behavior: "allow" });
      }

      expect(mockClient.requestPermission).not.toHaveBeenCalled();
    });

    it("bypasses for non-edit tools", async () => {
      const canUse = agent.canUseTool(SESSION_ID);
      const { signal } = makeAbortSignal();
      const toolInput = { file_path: "/test.txt" };

      const result = await canUse("Read", toolInput, { signal, toolUseID: TOOL_USE_ID });

      expect(result).toMatchObject({ behavior: "allow" });
      expect(mockClient.requestPermission).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // acceptEdits mode
  // =========================================================================
  describe("acceptEdits mode", () => {
    beforeEach(() => {
      injectSession(agent, SESSION_ID, "acceptEdits");
    });

    it("allows edit tools immediately without requestPermission", async () => {
      const canUse = agent.canUseTool(SESSION_ID);
      const { signal } = makeAbortSignal();

      for (const editTool of EDIT_TOOL_NAMES) {
        const toolInput = { file_path: "/file.txt", content: "data" };
        const result = await canUse(editTool, toolInput, { signal, toolUseID: TOOL_USE_ID });

        expect(result).toEqual({
          behavior: "allow",
          updatedInput: toolInput,
          updatedPermissions: [
            { type: "addRules", rules: [{ toolName: editTool }], behavior: "allow", destination: "session" },
          ],
        });
      }

      expect(mockClient.requestPermission).not.toHaveBeenCalled();
    });

    it("specifically auto-allows mcp__acp__Edit", async () => {
      const canUse = agent.canUseTool(SESSION_ID);
      const { signal } = makeAbortSignal();
      const toolInput = { file_path: "/file.txt", old_string: "a", new_string: "b" };

      const result = await canUse(acpToolNames.edit, toolInput, { signal, toolUseID: TOOL_USE_ID });

      expect(result).toMatchObject({ behavior: "allow" });
      expect(mockClient.requestPermission).not.toHaveBeenCalled();
    });

    it("specifically auto-allows mcp__acp__Write", async () => {
      const canUse = agent.canUseTool(SESSION_ID);
      const { signal } = makeAbortSignal();
      const toolInput = { file_path: "/file.txt", content: "hello" };

      const result = await canUse(acpToolNames.write, toolInput, { signal, toolUseID: TOOL_USE_ID });

      expect(result).toMatchObject({ behavior: "allow" });
      expect(mockClient.requestPermission).not.toHaveBeenCalled();
    });

    it("falls through to normal flow for non-edit tools (e.g. Bash)", async () => {
      mockClient.requestPermission.mockResolvedValue({
        outcome: { outcome: "selected", optionId: "allow" },
      });

      const canUse = agent.canUseTool(SESSION_ID);
      const { signal } = makeAbortSignal();

      const result = await canUse("Bash", { command: "ls" }, { signal, toolUseID: TOOL_USE_ID });

      // Falls through to normal flow: requestPermission was called
      expect(mockClient.requestPermission).toHaveBeenCalled();
      expect(result).toMatchObject({ behavior: "allow" });
    });

    it("falls through to normal flow for Read tool", async () => {
      mockClient.requestPermission.mockResolvedValue({
        outcome: { outcome: "selected", optionId: "allow" },
      });

      const canUse = agent.canUseTool(SESSION_ID);
      const { signal } = makeAbortSignal();

      await canUse("Read", { file_path: "/test.txt" }, { signal, toolUseID: TOOL_USE_ID });

      expect(mockClient.requestPermission).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Normal permission flow
  // =========================================================================
  describe("normal permission flow (default mode)", () => {
    beforeEach(() => {
      injectSession(agent, SESSION_ID, "default");
    });

    it("allows without updatedPermissions when user selects 'allow'", async () => {
      mockClient.requestPermission.mockResolvedValue({
        outcome: { outcome: "selected", optionId: "allow" },
      });

      const canUse = agent.canUseTool(SESSION_ID);
      const { signal } = makeAbortSignal();
      const toolInput = { command: "ls" };

      const result = await canUse("Bash", toolInput, { signal, toolUseID: TOOL_USE_ID });

      expect(result).toEqual({
        behavior: "allow",
        updatedInput: toolInput,
      });
    });

    it("allows with addRules updatedPermissions when user selects 'allow_always'", async () => {
      mockClient.requestPermission.mockResolvedValue({
        outcome: { outcome: "selected", optionId: "allow_always" },
      });

      const canUse = agent.canUseTool(SESSION_ID);
      const { signal } = makeAbortSignal();
      const toolInput = { command: "echo hello" };

      const result = await canUse("Bash", toolInput, { signal, toolUseID: TOOL_USE_ID });

      expect(result).toEqual({
        behavior: "allow",
        updatedInput: toolInput,
        updatedPermissions: [
          {
            type: "addRules",
            rules: [{ toolName: "Bash" }],
            behavior: "allow",
            destination: "session",
          },
        ],
      });
    });

    it("uses provided suggestions for allow_always instead of generating defaults", async () => {
      mockClient.requestPermission.mockResolvedValue({
        outcome: { outcome: "selected", optionId: "allow_always" },
      });

      const canUse = agent.canUseTool(SESSION_ID);
      const { signal } = makeAbortSignal();
      const customSuggestions = [
        { type: "addRules" as const, rules: [{ toolName: "Bash" }], behavior: "allow" as const, destination: "session" as const },
      ];

      const result = await canUse("Bash", { command: "ls" }, {
        signal,
        suggestions: customSuggestions,
        toolUseID: TOOL_USE_ID,
      });

      expect(result).toEqual({
        behavior: "allow",
        updatedInput: { command: "ls" },
        updatedPermissions: customSuggestions,
      });
    });

    it("denies when user selects 'reject'", async () => {
      mockClient.requestPermission.mockResolvedValue({
        outcome: { outcome: "selected", optionId: "reject" },
      });

      const canUse = agent.canUseTool(SESSION_ID);
      const { signal } = makeAbortSignal();

      const result = await canUse("Bash", { command: "rm -rf /" }, {
        signal,
        toolUseID: TOOL_USE_ID,
      });

      expect(result).toEqual({
        behavior: "deny",
        message: "User refused permission to run tool",
        interrupt: true,
      });
    });

    it("throws when signal is aborted", async () => {
      const { signal, abort } = makeAbortSignal();

      mockClient.requestPermission.mockImplementation(async () => {
        abort();
        return { outcome: { outcome: "selected", optionId: "allow" } };
      });

      const canUse = agent.canUseTool(SESSION_ID);

      await expect(
        canUse("Bash", { command: "ls" }, { signal, toolUseID: TOOL_USE_ID }),
      ).rejects.toThrow("Tool use aborted");
    });

    it("throws when response outcome is cancelled", async () => {
      mockClient.requestPermission.mockResolvedValue({
        outcome: { outcome: "cancelled" },
      });

      const canUse = agent.canUseTool(SESSION_ID);
      const { signal } = makeAbortSignal();

      await expect(
        canUse("Bash", { command: "ls" }, { signal, toolUseID: TOOL_USE_ID }),
      ).rejects.toThrow("Tool use aborted");
    });

    it("sends correct requestPermission options with title from toolInfoFromToolUse", async () => {
      mockClient.requestPermission.mockResolvedValue({
        outcome: { outcome: "selected", optionId: "allow" },
      });

      const canUse = agent.canUseTool(SESSION_ID);
      const { signal } = makeAbortSignal();
      const toolInput = { command: "git status", description: "Check git status" };

      await canUse("Bash", toolInput, { signal, toolUseID: TOOL_USE_ID });

      expect(mockClient.requestPermission).toHaveBeenCalledWith({
        options: [
          { kind: "allow_always", name: "Always Allow", optionId: "allow_always" },
          { kind: "allow_once", name: "Allow", optionId: "allow" },
          { kind: "reject_once", name: "Reject", optionId: "reject" },
        ],
        sessionId: SESSION_ID,
        toolCall: {
          toolCallId: TOOL_USE_ID,
          rawInput: toolInput,
          title: "`git status`",
        },
      });
    });

    it("includes title from toolInfoFromToolUse for Write tool", async () => {
      mockClient.requestPermission.mockResolvedValue({
        outcome: { outcome: "selected", optionId: "allow" },
      });

      const canUse = agent.canUseTool(SESSION_ID);
      const { signal } = makeAbortSignal();
      const toolInput = { file_path: "/test/output.txt", content: "hello world" };

      await canUse("Write", toolInput, { signal, toolUseID: TOOL_USE_ID });

      const callArgs = mockClient.requestPermission.mock.calls[0][0];
      expect(callArgs.toolCall.title).toBe("Write /test/output.txt");
    });

    it("includes title from toolInfoFromToolUse for Read tool", async () => {
      mockClient.requestPermission.mockResolvedValue({
        outcome: { outcome: "selected", optionId: "allow" },
      });

      const canUse = agent.canUseTool(SESSION_ID);
      const { signal } = makeAbortSignal();
      const toolInput = { file_path: "/test/data.json" };

      await canUse("Read", toolInput, { signal, toolUseID: TOOL_USE_ID });

      const callArgs = mockClient.requestPermission.mock.calls[0][0];
      expect(callArgs.toolCall.title).toBe("Read File");
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================
  describe("edge cases", () => {
    it("EDIT_TOOL_NAMES contains exactly mcp__acp__Edit and mcp__acp__Write", () => {
      expect(EDIT_TOOL_NAMES).toEqual([acpToolNames.edit, acpToolNames.write]);
      expect(EDIT_TOOL_NAMES).toContain("mcp__acp__Edit");
      expect(EDIT_TOOL_NAMES).toContain("mcp__acp__Write");
    });

    it("handles ExitPlanMode even when session is not in plan mode", async () => {
      injectSession(agent, SESSION_ID, "default");
      mockClient.requestPermission.mockResolvedValue({
        outcome: { outcome: "selected", optionId: "acceptEdits" },
      });

      const canUse = agent.canUseTool(SESSION_ID);
      const { signal } = makeAbortSignal();

      // ExitPlanMode is handled by the toolName check regardless of current mode
      const result = await canUse("ExitPlanMode", { plan: "plan" }, {
        signal,
        toolUseID: TOOL_USE_ID,
      });

      expect(result).toMatchObject({ behavior: "allow" });
      expect(agent.sessions[SESSION_ID].permissionMode).toBe("acceptEdits");
    });

    it("returns a function from canUseTool that can be called multiple times", async () => {
      injectSession(agent, SESSION_ID, "default");
      mockClient.requestPermission.mockResolvedValue({
        outcome: { outcome: "selected", optionId: "allow" },
      });

      const canUse = agent.canUseTool(SESSION_ID);

      // First call
      const { signal: signal1 } = makeAbortSignal();
      const result1 = await canUse("Bash", { command: "ls" }, { signal: signal1, toolUseID: "id1" });
      expect(result1).toMatchObject({ behavior: "allow" });

      // Second call
      const { signal: signal2 } = makeAbortSignal();
      const result2 = await canUse("Read", { file_path: "/test" }, { signal: signal2, toolUseID: "id2" });
      expect(result2).toMatchObject({ behavior: "allow" });

      expect(mockClient.requestPermission).toHaveBeenCalledTimes(2);
    });

    it("ExitPlanMode title is 'Ready to code?' from toolInfoFromToolUse", async () => {
      injectSession(agent, SESSION_ID, "plan");
      mockClient.requestPermission.mockResolvedValue({
        outcome: { outcome: "selected", optionId: "default" },
      });

      const canUse = agent.canUseTool(SESSION_ID);
      const { signal } = makeAbortSignal();

      await canUse("ExitPlanMode", { plan: "plan" }, { signal, toolUseID: TOOL_USE_ID });

      const callArgs = mockClient.requestPermission.mock.calls[0][0];
      expect(callArgs.toolCall.title).toBe("Ready to code?");
    });

    it("does not call sessionUpdate when ExitPlanMode is rejected", async () => {
      injectSession(agent, SESSION_ID, "plan");
      mockClient.requestPermission.mockResolvedValue({
        outcome: { outcome: "selected", optionId: "plan" },
      });

      const canUse = agent.canUseTool(SESSION_ID);
      const { signal } = makeAbortSignal();

      await canUse("ExitPlanMode", { plan: "plan" }, { signal, toolUseID: TOOL_USE_ID });

      expect(mockClient.sessionUpdate).not.toHaveBeenCalled();
    });

    it("allow_once in normal flow does NOT include updatedPermissions", async () => {
      injectSession(agent, SESSION_ID, "default");
      mockClient.requestPermission.mockResolvedValue({
        outcome: { outcome: "selected", optionId: "allow" },
      });

      const canUse = agent.canUseTool(SESSION_ID);
      const { signal } = makeAbortSignal();

      const result = await canUse("Bash", { command: "ls" }, { signal, toolUseID: TOOL_USE_ID });

      expect(result).not.toHaveProperty("updatedPermissions");
    });

    it("bypassPermissions mode generates addRules with the tool name", async () => {
      injectSession(agent, SESSION_ID, "bypassPermissions");
      const canUse = agent.canUseTool(SESSION_ID);
      const { signal } = makeAbortSignal();

      const result = await canUse("Grep", { pattern: "test" }, { signal, toolUseID: TOOL_USE_ID });

      expect(result).toEqual({
        behavior: "allow",
        updatedInput: { pattern: "test" },
        updatedPermissions: [
          { type: "addRules", rules: [{ toolName: "Grep" }], behavior: "allow", destination: "session" },
        ],
      });
    });
  });
});
