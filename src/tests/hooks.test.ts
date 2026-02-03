import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the modules that cause circular dependency issues when importing tools.ts directly.
// tools.ts -> mcp-server.ts -> acp-agent.ts creates a circular chain.
// We mock mcp-server.ts to break the cycle.
vi.mock("../mcp-server.js", () => ({
  SYSTEM_REMINDER: "",
}));

vi.mock("../acp-agent.js", () => ({
  CLAUDE_CONFIG_DIR: "/tmp/.claude",
}));

import {
  registerHookCallback,
  createPostToolUseHook,
  createPreToolUseHook,
} from "../tools.js";
import { SettingsManager } from "../settings.js";

/**
 * Creates a mock Logger matching the Logger interface from acp-agent.ts.
 */
function createMockLogger() {
  return {
    log: vi.fn(),
    error: vi.fn(),
  };
}

/**
 * Creates a mock AbortSignal options object matching the HookCallback third parameter.
 */
function createHookOptions() {
  return { signal: new AbortController().signal };
}

describe("registerHookCallback", () => {
  it("should register a callback that can later be found by createPostToolUseHook", async () => {
    const toolUseID = `register-test-${Date.now()}`;
    const onPostToolUseHook = vi.fn().mockResolvedValue(undefined);

    registerHookCallback(toolUseID, { onPostToolUseHook });

    const hook = createPostToolUseHook(createMockLogger());
    const input = {
      hook_event_name: "PostToolUse",
      tool_input: { command: "ls" },
      tool_response: "output",
    };

    await hook(input, toolUseID, createHookOptions());

    expect(onPostToolUseHook).toHaveBeenCalledOnce();
    expect(onPostToolUseHook).toHaveBeenCalledWith(
      toolUseID,
      { command: "ls" },
      "output",
    );
  });

  it("should overwrite previous callback for the same toolUseID", async () => {
    const toolUseID = `overwrite-test-${Date.now()}`;
    const firstCallback = vi.fn().mockResolvedValue(undefined);
    const secondCallback = vi.fn().mockResolvedValue(undefined);

    registerHookCallback(toolUseID, { onPostToolUseHook: firstCallback });
    registerHookCallback(toolUseID, { onPostToolUseHook: secondCallback });

    const hook = createPostToolUseHook(createMockLogger());
    const input = {
      hook_event_name: "PostToolUse",
      tool_input: {},
      tool_response: {},
    };

    await hook(input, toolUseID, createHookOptions());

    expect(firstCallback).not.toHaveBeenCalled();
    expect(secondCallback).toHaveBeenCalledOnce();
  });
});

describe("createPostToolUseHook", () => {
  it("should call onPostToolUseHook when hook_event_name is PostToolUse", async () => {
    const toolUseID = `post-call-${Date.now()}`;
    const onPostToolUseHook = vi.fn().mockResolvedValue(undefined);
    registerHookCallback(toolUseID, { onPostToolUseHook });

    const hook = createPostToolUseHook(createMockLogger());
    const result = await hook(
      {
        hook_event_name: "PostToolUse",
        tool_input: { file: "a.txt" },
        tool_response: "ok",
      },
      toolUseID,
      createHookOptions(),
    );

    expect(onPostToolUseHook).toHaveBeenCalledOnce();
    expect(result).toEqual({ continue: true });
  });

  it("should pass toolUseID, tool_input, and tool_response to callback", async () => {
    const toolUseID = `post-args-${Date.now()}`;
    const onPostToolUseHook = vi.fn().mockResolvedValue(undefined);
    registerHookCallback(toolUseID, { onPostToolUseHook });

    const toolInput = { command: "echo hello" };
    const toolResponse = { stdout: "hello\n", exitCode: 0 };

    const hook = createPostToolUseHook(createMockLogger());
    await hook(
      {
        hook_event_name: "PostToolUse",
        tool_input: toolInput,
        tool_response: toolResponse,
      },
      toolUseID,
      createHookOptions(),
    );

    expect(onPostToolUseHook).toHaveBeenCalledWith(
      toolUseID,
      toolInput,
      toolResponse,
    );
  });

  it("should skip unregistered tool_use_ids and return { continue: true }", async () => {
    const unregisteredID = `unregistered-${Date.now()}`;

    const hook = createPostToolUseHook(createMockLogger());
    const result = await hook(
      {
        hook_event_name: "PostToolUse",
        tool_input: {},
        tool_response: {},
      },
      unregisteredID,
      createHookOptions(),
    );

    expect(result).toEqual({ continue: true });
  });

  it("should delete callback after calling it (second call should skip)", async () => {
    const toolUseID = `post-delete-${Date.now()}`;
    const onPostToolUseHook = vi.fn().mockResolvedValue(undefined);
    registerHookCallback(toolUseID, { onPostToolUseHook });

    const logger = createMockLogger();
    const hook = createPostToolUseHook(logger);
    const input = {
      hook_event_name: "PostToolUse",
      tool_input: {},
      tool_response: {},
    };

    // First call should invoke the callback
    await hook(input, toolUseID, createHookOptions());
    expect(onPostToolUseHook).toHaveBeenCalledOnce();

    // Second call: the callback was deleted from the map by the first call,
    // so the toolUseID is no longer registered and it should be skipped.
    const result = await hook(input, toolUseID, createHookOptions());
    expect(onPostToolUseHook).toHaveBeenCalledOnce(); // Still only once
    expect(result).toEqual({ continue: true });
  });

  it("should return { continue: true } for non-PostToolUse events", async () => {
    const toolUseID = `post-non-event-${Date.now()}`;
    const onPostToolUseHook = vi.fn().mockResolvedValue(undefined);
    registerHookCallback(toolUseID, { onPostToolUseHook });

    const hook = createPostToolUseHook(createMockLogger());

    const result = await hook(
      {
        hook_event_name: "PreToolUse",
        tool_input: {},
        tool_response: {},
      },
      toolUseID,
      createHookOptions(),
    );

    expect(onPostToolUseHook).not.toHaveBeenCalled();
    expect(result).toEqual({ continue: true });
  });

  it("should return { continue: true } when toolUseID is undefined", async () => {
    const hook = createPostToolUseHook(createMockLogger());

    const result = await hook(
      {
        hook_event_name: "PostToolUse",
        tool_input: {},
        tool_response: {},
      },
      undefined,
      createHookOptions(),
    );

    expect(result).toEqual({ continue: true });
  });

  it("should call logger.error when onPostToolUseHook is undefined for a registered ID", async () => {
    const toolUseID = `post-no-hook-${Date.now()}`;
    // Register without providing onPostToolUseHook
    registerHookCallback(toolUseID, {});

    const logger = createMockLogger();
    const hook = createPostToolUseHook(logger);

    const result = await hook(
      {
        hook_event_name: "PostToolUse",
        tool_input: {},
        tool_response: {},
      },
      toolUseID,
      createHookOptions(),
    );

    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      `No onPostToolUseHook found for tool use ID: ${toolUseID}`,
    );
    expect(result).toEqual({ continue: true });
  });

  it("should use console as default logger", async () => {
    const toolUseID = `post-default-logger-${Date.now()}`;
    // Register without providing onPostToolUseHook to trigger the error path
    registerHookCallback(toolUseID, {});

    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    try {
      const hook = createPostToolUseHook();

      await hook(
        {
          hook_event_name: "PostToolUse",
          tool_input: {},
          tool_response: {},
        },
        toolUseID,
        createHookOptions(),
      );

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        `No onPostToolUseHook found for tool use ID: ${toolUseID}`,
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});

describe("createPreToolUseHook", () => {
  let mockSettingsManager: SettingsManager;

  beforeEach(() => {
    mockSettingsManager = {
      checkPermission: vi.fn(),
    } as unknown as SettingsManager;
  });

  it("should return allow hookSpecificOutput for allowed tools", async () => {
    const rule = "Read";
    (mockSettingsManager.checkPermission as ReturnType<typeof vi.fn>).mockReturnValue({
      decision: "allow",
      rule,
      source: "allow",
    });

    const logger = createMockLogger();
    const hook = createPreToolUseHook(mockSettingsManager, logger);

    const result = await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "mcp__acp__Read",
        tool_input: { file_path: "/some/file.txt" },
      },
      "some-tool-use-id",
      createHookOptions(),
    );

    expect(result).toEqual({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: `Allowed by settings rule: ${rule}`,
      },
    });
    expect(mockSettingsManager.checkPermission).toHaveBeenCalledWith(
      "mcp__acp__Read",
      { file_path: "/some/file.txt" },
    );
  });

  it("should return deny hookSpecificOutput for denied tools", async () => {
    const rule = "Read(./.env)";
    (mockSettingsManager.checkPermission as ReturnType<typeof vi.fn>).mockReturnValue({
      decision: "deny",
      rule,
      source: "deny",
    });

    const logger = createMockLogger();
    const hook = createPreToolUseHook(mockSettingsManager, logger);

    const result = await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "mcp__acp__Read",
        tool_input: { file_path: ".env" },
      },
      "some-tool-use-id",
      createHookOptions(),
    );

    expect(result).toEqual({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Denied by settings rule: ${rule}`,
      },
    });
  });

  it("should return just { continue: true } for 'ask' decision", async () => {
    (mockSettingsManager.checkPermission as ReturnType<typeof vi.fn>).mockReturnValue({
      decision: "ask",
    });

    const logger = createMockLogger();
    const hook = createPreToolUseHook(mockSettingsManager, logger);

    const result = await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "mcp__acp__Bash",
        tool_input: { command: "rm -rf /" },
      },
      "some-tool-use-id",
      createHookOptions(),
    );

    expect(result).toEqual({ continue: true });
  });

  it("should return { continue: true } for non-PreToolUse events", async () => {
    const logger = createMockLogger();
    const hook = createPreToolUseHook(mockSettingsManager, logger);

    const result = await hook(
      {
        hook_event_name: "PostToolUse",
        tool_name: "mcp__acp__Read",
        tool_input: {},
      },
      "some-tool-use-id",
      createHookOptions(),
    );

    expect(result).toEqual({ continue: true });
    expect(mockSettingsManager.checkPermission).not.toHaveBeenCalled();
  });

  it("should log non-'ask' decisions", async () => {
    (mockSettingsManager.checkPermission as ReturnType<typeof vi.fn>).mockReturnValue({
      decision: "allow",
      rule: "Bash(npm run:*)",
      source: "allow",
    });

    const logger = createMockLogger();
    const hook = createPreToolUseHook(mockSettingsManager, logger);

    await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "mcp__acp__Bash",
        tool_input: { command: "npm run lint" },
      },
      "some-tool-use-id",
      createHookOptions(),
    );

    expect(logger.log).toHaveBeenCalledOnce();
    expect(logger.log).toHaveBeenCalledWith(
      "[PreToolUseHook] Tool: mcp__acp__Bash, Decision: allow, Rule: Bash(npm run:*)",
    );
  });

  it("should not log 'ask' decisions", async () => {
    (mockSettingsManager.checkPermission as ReturnType<typeof vi.fn>).mockReturnValue({
      decision: "ask",
    });

    const logger = createMockLogger();
    const hook = createPreToolUseHook(mockSettingsManager, logger);

    await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "mcp__acp__Write",
        tool_input: { file_path: "/tmp/test.txt", content: "hello" },
      },
      "some-tool-use-id",
      createHookOptions(),
    );

    expect(logger.log).not.toHaveBeenCalled();
  });
});
