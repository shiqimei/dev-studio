import { describe, it, expect, vi, beforeEach } from "vitest";
import { ClaudeAcpAgent } from "../acp-agent.js";
import { AgentSideConnection } from "@agentclientprotocol/sdk";
import { Pushable } from "../utils.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockQuery() {
  return {
    interrupt: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue(undefined),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
    mcpServerStatus: vi.fn().mockResolvedValue({ servers: [] }),
    reconnectMcpServer: vi.fn().mockResolvedValue(undefined),
    toggleMcpServer: vi.fn().mockResolvedValue(undefined),
    setMcpServers: vi.fn().mockResolvedValue({ servers: [] }),
    accountInfo: vi.fn().mockResolvedValue({ email: "test@example.com" }),
    rewindFiles: vi.fn().mockResolvedValue({ rewound: true }),
    supportedCommands: vi.fn().mockResolvedValue([]),
    supportedModels: vi.fn().mockResolvedValue([]),
    next: vi.fn().mockResolvedValue({ value: undefined, done: true }),
  } as any;
}

function createMockClient() {
  return {
    sessionUpdate: vi.fn().mockResolvedValue(undefined),
    requestPermission: vi.fn().mockResolvedValue({}),
    readTextFile: vi.fn().mockResolvedValue({ content: "file contents" }),
    writeTextFile: vi.fn().mockResolvedValue({}),
  } as unknown as AgentSideConnection;
}

function createMockLogger() {
  return { log: vi.fn(), error: vi.fn() };
}

function createAgentWithSession(
  sessionId: string = "test-session",
  overrides: {
    mockQuery?: ReturnType<typeof createMockQuery>;
    mockClient?: AgentSideConnection;
    mockLogger?: ReturnType<typeof createMockLogger>;
    permissionMode?: string;
  } = {},
) {
  const mockClient = overrides.mockClient ?? createMockClient();
  const mockLogger = overrides.mockLogger ?? createMockLogger();
  const mockQuery = overrides.mockQuery ?? createMockQuery();

  const agent = new ClaudeAcpAgent(mockClient, mockLogger);

  agent.sessions[sessionId] = {
    query: mockQuery,
    router: {} as any,
    input: new Pushable(),
    cancelled: false,
    permissionMode: (overrides.permissionMode ?? "default") as any,
    settingsManager: {} as any,
  };

  return { agent, mockClient, mockLogger, mockQuery };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ClaudeAcpAgent", () => {
  // -----------------------------------------------------------------------
  // initialize()
  // -----------------------------------------------------------------------

  describe("initialize()", () => {
    it("should return correct protocol version", async () => {
      const mockClient = createMockClient();
      const agent = new ClaudeAcpAgent(mockClient);

      const response = await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
      });

      expect(response.protocolVersion).toBe(1);
    });

    it("should return agent capabilities with prompt, mcp, and session support", async () => {
      const mockClient = createMockClient();
      const agent = new ClaudeAcpAgent(mockClient);

      const response = await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
      });

      expect(response.agentCapabilities).toEqual({
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
      });
    });

    it("should return agent info with name, title, and version", async () => {
      const mockClient = createMockClient();
      const agent = new ClaudeAcpAgent(mockClient);

      const response = await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
      });

      expect(response.agentInfo).toBeDefined();
      expect(response.agentInfo!.name).toBe("@zed-industries/claude-code-acp");
      expect(response.agentInfo!.title).toBe("Claude Code");
      expect(response.agentInfo!.version).toBeDefined();
    });

    it("should return auth methods with claude-login id", async () => {
      const mockClient = createMockClient();
      const agent = new ClaudeAcpAgent(mockClient);

      const response = await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
      });

      expect(response.authMethods).toBeDefined();
      expect(response.authMethods).toHaveLength(1);
      expect(response.authMethods![0]).toMatchObject({
        id: "claude-login",
        name: "Log in with Claude Code",
        description: "Run `claude /login` in the terminal",
      });
    });

    it("should not include terminal-auth metadata when client does not support it", async () => {
      const mockClient = createMockClient();
      const agent = new ClaudeAcpAgent(mockClient);

      const response = await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
      });

      const authMethod = response.authMethods![0] as any;
      expect(authMethod._meta).toBeUndefined();
    });

    it("should include terminal-auth metadata when client supports terminal-auth", async () => {
      const mockClient = createMockClient();
      const agent = new ClaudeAcpAgent(mockClient);

      const response = await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {
          _meta: {
            "terminal-auth": true,
          },
        },
      });

      const authMethod = response.authMethods![0] as any;
      expect(authMethod._meta).toBeDefined();
      expect(authMethod._meta["terminal-auth"]).toBeDefined();
      expect(authMethod._meta["terminal-auth"].command).toBe("node");
      expect(authMethod._meta["terminal-auth"].label).toBe("Claude Code Login");
      expect(Array.isArray(authMethod._meta["terminal-auth"].args)).toBe(true);
    });

    it("should store clientCapabilities from the request", async () => {
      const mockClient = createMockClient();
      const agent = new ClaudeAcpAgent(mockClient);

      const capabilities = {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      };

      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: capabilities,
      });

      expect(agent.clientCapabilities).toEqual(capabilities);
    });
  });

  // -----------------------------------------------------------------------
  // cancel()
  // -----------------------------------------------------------------------

  describe("cancel()", () => {
    it("should set cancelled flag to true for valid session", async () => {
      const { agent, mockQuery } = createAgentWithSession("session-1");

      expect(agent.sessions["session-1"].cancelled).toBe(false);

      await agent.cancel({ sessionId: "session-1" });

      expect(agent.sessions["session-1"].cancelled).toBe(true);
    });

    it("should call query.interrupt() on the session query", async () => {
      const { agent, mockQuery } = createAgentWithSession("session-1");

      await agent.cancel({ sessionId: "session-1" });

      expect(mockQuery.interrupt).toHaveBeenCalledTimes(1);
    });

    it("should throw an error for invalid session ID", async () => {
      const mockClient = createMockClient();
      const agent = new ClaudeAcpAgent(mockClient);

      await expect(agent.cancel({ sessionId: "nonexistent" })).rejects.toThrow(
        "Session not found",
      );
    });
  });

  // -----------------------------------------------------------------------
  // setSessionMode()
  // -----------------------------------------------------------------------

  describe("setSessionMode()", () => {
    it("should accept 'default' mode", async () => {
      const { agent, mockQuery } = createAgentWithSession("s1");

      const result = await agent.setSessionMode({ sessionId: "s1", modeId: "default" });

      expect(result).toEqual({});
      expect(agent.sessions["s1"].permissionMode).toBe("default");
      expect(mockQuery.setPermissionMode).toHaveBeenCalledWith("default");
    });

    it("should accept 'acceptEdits' mode", async () => {
      const { agent, mockQuery } = createAgentWithSession("s1");

      await agent.setSessionMode({ sessionId: "s1", modeId: "acceptEdits" });

      expect(agent.sessions["s1"].permissionMode).toBe("acceptEdits");
      expect(mockQuery.setPermissionMode).toHaveBeenCalledWith("acceptEdits");
    });

    it("should accept 'bypassPermissions' mode", async () => {
      const { agent, mockQuery } = createAgentWithSession("s1");

      await agent.setSessionMode({ sessionId: "s1", modeId: "bypassPermissions" });

      expect(agent.sessions["s1"].permissionMode).toBe("bypassPermissions");
      expect(mockQuery.setPermissionMode).toHaveBeenCalledWith("bypassPermissions");
    });

    it("should accept 'dontAsk' mode", async () => {
      const { agent, mockQuery } = createAgentWithSession("s1");

      await agent.setSessionMode({ sessionId: "s1", modeId: "dontAsk" });

      expect(agent.sessions["s1"].permissionMode).toBe("dontAsk");
      expect(mockQuery.setPermissionMode).toHaveBeenCalledWith("dontAsk");
    });

    it("should accept 'plan' mode", async () => {
      const { agent, mockQuery } = createAgentWithSession("s1");

      await agent.setSessionMode({ sessionId: "s1", modeId: "plan" });

      expect(agent.sessions["s1"].permissionMode).toBe("plan");
      expect(mockQuery.setPermissionMode).toHaveBeenCalledWith("plan");
    });

    it("should accept 'delegate' mode", async () => {
      const { agent, mockQuery } = createAgentWithSession("s1");

      await agent.setSessionMode({ sessionId: "s1", modeId: "delegate" });

      expect(agent.sessions["s1"].permissionMode).toBe("delegate");
      expect(mockQuery.setPermissionMode).toHaveBeenCalledWith("delegate");
    });

    it("should throw 'Invalid Mode' for an unknown mode", async () => {
      const { agent } = createAgentWithSession("s1");

      await expect(
        agent.setSessionMode({ sessionId: "s1", modeId: "unknownMode" }),
      ).rejects.toThrow("Invalid Mode");
    });

    it("should throw if query.setPermissionMode rejects", async () => {
      const mockQuery = createMockQuery();
      mockQuery.setPermissionMode.mockRejectedValue(new Error("permission error"));
      const { agent } = createAgentWithSession("s1", { mockQuery });

      await expect(
        agent.setSessionMode({ sessionId: "s1", modeId: "default" }),
      ).rejects.toThrow("permission error");
    });

    it("should throw 'Invalid Mode' if setPermissionMode throws with no message", async () => {
      const mockQuery = createMockQuery();
      mockQuery.setPermissionMode.mockRejectedValue(new Error(""));
      const { agent } = createAgentWithSession("s1", { mockQuery });

      await expect(
        agent.setSessionMode({ sessionId: "s1", modeId: "default" }),
      ).rejects.toThrow("Invalid Mode");
    });

    it("should throw for missing session", async () => {
      const mockClient = createMockClient();
      const agent = new ClaudeAcpAgent(mockClient);

      await expect(
        agent.setSessionMode({ sessionId: "nonexistent", modeId: "default" }),
      ).rejects.toThrow("Session not found");
    });
  });

  // -----------------------------------------------------------------------
  // unstable_setSessionModel()
  // -----------------------------------------------------------------------

  describe("unstable_setSessionModel()", () => {
    it("should call query.setModel with the given model ID", async () => {
      const { agent, mockQuery } = createAgentWithSession("s1");

      await agent.unstable_setSessionModel({ sessionId: "s1", modelId: "claude-sonnet-4" });

      expect(mockQuery.setModel).toHaveBeenCalledWith("claude-sonnet-4");
      expect(mockQuery.setModel).toHaveBeenCalledTimes(1);
    });

    it("should throw for missing session", async () => {
      const mockClient = createMockClient();
      const agent = new ClaudeAcpAgent(mockClient);

      await expect(
        agent.unstable_setSessionModel({ sessionId: "nonexistent", modelId: "claude-sonnet-4" }),
      ).rejects.toThrow("Session not found");
    });
  });

  // -----------------------------------------------------------------------
  // setMaxThinkingTokens()
  // -----------------------------------------------------------------------

  describe("setMaxThinkingTokens()", () => {
    it("should call query.setMaxThinkingTokens with a number", async () => {
      const { agent, mockQuery } = createAgentWithSession("s1");

      await agent.setMaxThinkingTokens("s1", 8192);

      expect(mockQuery.setMaxThinkingTokens).toHaveBeenCalledWith(8192);
      expect(mockQuery.setMaxThinkingTokens).toHaveBeenCalledTimes(1);
    });

    it("should call query.setMaxThinkingTokens with null", async () => {
      const { agent, mockQuery } = createAgentWithSession("s1");

      await agent.setMaxThinkingTokens("s1", null);

      expect(mockQuery.setMaxThinkingTokens).toHaveBeenCalledWith(null);
    });

    it("should throw for missing session", async () => {
      const mockClient = createMockClient();
      const agent = new ClaudeAcpAgent(mockClient);

      await expect(agent.setMaxThinkingTokens("nonexistent", 1024)).rejects.toThrow(
        "Session not found",
      );
    });
  });

  // -----------------------------------------------------------------------
  // mcpServerStatus()
  // -----------------------------------------------------------------------

  describe("mcpServerStatus()", () => {
    it("should call query.mcpServerStatus and return its result", async () => {
      const mockQuery = createMockQuery();
      const expectedStatus = { servers: [{ name: "test-server", status: "connected" }] };
      mockQuery.mcpServerStatus.mockResolvedValue(expectedStatus);
      const { agent } = createAgentWithSession("s1", { mockQuery });

      const result = await agent.mcpServerStatus("s1");

      expect(mockQuery.mcpServerStatus).toHaveBeenCalledTimes(1);
      expect(result).toEqual(expectedStatus);
    });

    it("should throw for missing session", async () => {
      const mockClient = createMockClient();
      const agent = new ClaudeAcpAgent(mockClient);

      await expect(agent.mcpServerStatus("nonexistent")).rejects.toThrow("Session not found");
    });
  });

  // -----------------------------------------------------------------------
  // reconnectMcpServer()
  // -----------------------------------------------------------------------

  describe("reconnectMcpServer()", () => {
    it("should call query.reconnectMcpServer with the server name", async () => {
      const { agent, mockQuery } = createAgentWithSession("s1");

      await agent.reconnectMcpServer("s1", "my-server");

      expect(mockQuery.reconnectMcpServer).toHaveBeenCalledWith("my-server");
      expect(mockQuery.reconnectMcpServer).toHaveBeenCalledTimes(1);
    });

    it("should throw for missing session", async () => {
      const mockClient = createMockClient();
      const agent = new ClaudeAcpAgent(mockClient);

      await expect(agent.reconnectMcpServer("nonexistent", "my-server")).rejects.toThrow(
        "Session not found",
      );
    });
  });

  // -----------------------------------------------------------------------
  // toggleMcpServer()
  // -----------------------------------------------------------------------

  describe("toggleMcpServer()", () => {
    it("should call query.toggleMcpServer with server name and enabled=true", async () => {
      const { agent, mockQuery } = createAgentWithSession("s1");

      await agent.toggleMcpServer("s1", "my-server", true);

      expect(mockQuery.toggleMcpServer).toHaveBeenCalledWith("my-server", true);
    });

    it("should call query.toggleMcpServer with server name and enabled=false", async () => {
      const { agent, mockQuery } = createAgentWithSession("s1");

      await agent.toggleMcpServer("s1", "my-server", false);

      expect(mockQuery.toggleMcpServer).toHaveBeenCalledWith("my-server", false);
    });

    it("should throw for missing session", async () => {
      const mockClient = createMockClient();
      const agent = new ClaudeAcpAgent(mockClient);

      await expect(agent.toggleMcpServer("nonexistent", "my-server", true)).rejects.toThrow(
        "Session not found",
      );
    });
  });

  // -----------------------------------------------------------------------
  // setMcpServers()
  // -----------------------------------------------------------------------

  describe("setMcpServers()", () => {
    it("should call query.setMcpServers with server configs and return result", async () => {
      const mockQuery = createMockQuery();
      const expectedResult = { servers: [{ name: "new-server" }] };
      mockQuery.setMcpServers.mockResolvedValue(expectedResult);
      const { agent } = createAgentWithSession("s1", { mockQuery });

      const servers = {
        "new-server": { type: "stdio" as const, command: "node", args: ["server.js"] },
      };
      const result = await agent.setMcpServers("s1", servers);

      expect(mockQuery.setMcpServers).toHaveBeenCalledWith(servers);
      expect(result).toEqual(expectedResult);
    });

    it("should throw for missing session", async () => {
      const mockClient = createMockClient();
      const agent = new ClaudeAcpAgent(mockClient);

      await expect(agent.setMcpServers("nonexistent", {})).rejects.toThrow("Session not found");
    });
  });

  // -----------------------------------------------------------------------
  // accountInfo()
  // -----------------------------------------------------------------------

  describe("accountInfo()", () => {
    it("should call query.accountInfo and return its result", async () => {
      const mockQuery = createMockQuery();
      const expectedInfo = { email: "user@example.com", plan: "pro" };
      mockQuery.accountInfo.mockResolvedValue(expectedInfo);
      const { agent } = createAgentWithSession("s1", { mockQuery });

      const result = await agent.accountInfo("s1");

      expect(mockQuery.accountInfo).toHaveBeenCalledTimes(1);
      expect(result).toEqual(expectedInfo);
    });

    it("should throw for missing session", async () => {
      const mockClient = createMockClient();
      const agent = new ClaudeAcpAgent(mockClient);

      await expect(agent.accountInfo("nonexistent")).rejects.toThrow("Session not found");
    });
  });

  // -----------------------------------------------------------------------
  // rewindFiles()
  // -----------------------------------------------------------------------

  describe("rewindFiles()", () => {
    it("should call query.rewindFiles with userMessageId", async () => {
      const { agent, mockQuery } = createAgentWithSession("s1");

      await agent.rewindFiles("s1", "msg-123");

      expect(mockQuery.rewindFiles).toHaveBeenCalledWith("msg-123", undefined);
    });

    it("should call query.rewindFiles with dryRun option", async () => {
      const { agent, mockQuery } = createAgentWithSession("s1");

      await agent.rewindFiles("s1", "msg-456", { dryRun: true });

      expect(mockQuery.rewindFiles).toHaveBeenCalledWith("msg-456", { dryRun: true });
    });

    it("should call query.rewindFiles with dryRun false", async () => {
      const { agent, mockQuery } = createAgentWithSession("s1");

      await agent.rewindFiles("s1", "msg-789", { dryRun: false });

      expect(mockQuery.rewindFiles).toHaveBeenCalledWith("msg-789", { dryRun: false });
    });

    it("should return the result from query.rewindFiles", async () => {
      const mockQuery = createMockQuery();
      const expectedResult = { rewound: true, files: ["a.ts", "b.ts"] };
      mockQuery.rewindFiles.mockResolvedValue(expectedResult);
      const { agent } = createAgentWithSession("s1", { mockQuery });

      const result = await agent.rewindFiles("s1", "msg-123");

      expect(result).toEqual(expectedResult);
    });

    it("should throw for missing session", async () => {
      const mockClient = createMockClient();
      const agent = new ClaudeAcpAgent(mockClient);

      await expect(agent.rewindFiles("nonexistent", "msg-123")).rejects.toThrow(
        "Session not found",
      );
    });
  });

  // -----------------------------------------------------------------------
  // readTextFile()
  // -----------------------------------------------------------------------

  describe("readTextFile()", () => {
    it("should delegate to client.readTextFile and return its response", async () => {
      const mockClient = createMockClient();
      const agent = new ClaudeAcpAgent(mockClient);

      const params = { path: "/some/file.txt" };
      const result = await agent.readTextFile(params);

      expect(mockClient.readTextFile).toHaveBeenCalledWith(params);
      expect(result).toEqual({ content: "file contents" });
    });

    it("should pass through any parameters to client.readTextFile", async () => {
      const mockClient = createMockClient();
      (mockClient.readTextFile as any).mockResolvedValue({ content: "custom content" });
      const agent = new ClaudeAcpAgent(mockClient);

      const params = { path: "/another/path.json" };
      const result = await agent.readTextFile(params);

      expect(mockClient.readTextFile).toHaveBeenCalledWith(params);
      expect(result).toEqual({ content: "custom content" });
    });
  });

  // -----------------------------------------------------------------------
  // writeTextFile()
  // -----------------------------------------------------------------------

  describe("writeTextFile()", () => {
    it("should delegate to client.writeTextFile and return its response", async () => {
      const mockClient = createMockClient();
      const agent = new ClaudeAcpAgent(mockClient);

      const params = { path: "/some/file.txt", content: "hello world" };
      const result = await agent.writeTextFile(params);

      expect(mockClient.writeTextFile).toHaveBeenCalledWith(params);
      expect(result).toEqual({});
    });

    it("should pass through all parameters to client.writeTextFile", async () => {
      const mockClient = createMockClient();
      (mockClient.writeTextFile as any).mockResolvedValue({ written: true });
      const agent = new ClaudeAcpAgent(mockClient);

      const params = { path: "/output.txt", content: "data" };
      const result = await agent.writeTextFile(params);

      expect(mockClient.writeTextFile).toHaveBeenCalledWith(params);
      expect(result).toEqual({ written: true });
    });
  });

  // -----------------------------------------------------------------------
  // handleTaskNotification() (private, tested via agent internals)
  // -----------------------------------------------------------------------

  describe("handleTaskNotification()", () => {
    it("should send a tool_call_update when task_id is mapped", async () => {
      const mockClient = createMockClient();
      const mockLogger = createMockLogger();
      const agent = new ClaudeAcpAgent(mockClient, mockLogger);

      // Set up a mapping from task_id to toolCallId
      agent.backgroundTaskMap["task-abc"] = "tool-use-xyz";

      // Invoke the private method
      const handleTaskNotification = (agent as any).handleTaskNotification.bind(agent);
      await handleTaskNotification("session-1", {
        task_id: "task-abc",
        status: "completed",
        output_file: "/tmp/output.txt",
        summary: "Task finished successfully",
      });

      expect(mockClient.sessionUpdate).toHaveBeenCalledTimes(1);
      const call = (mockClient.sessionUpdate as any).mock.calls[0][0];
      expect(call.sessionId).toBe("session-1");
      expect(call.update.sessionUpdate).toBe("tool_call_update");
      expect(call.update.toolCallId).toBe("tool-use-xyz");
      expect(call.update.status).toBe("completed");
      expect(call.update.title).toBe("Task finished successfully");
    });

    it("should send a tool_call_update when output_file is mapped", async () => {
      const mockClient = createMockClient();
      const mockLogger = createMockLogger();
      const agent = new ClaudeAcpAgent(mockClient, mockLogger);

      // Map by output_file instead of task_id
      agent.backgroundTaskMap["file:/tmp/output.txt"] = "tool-use-abc";

      const handleTaskNotification = (agent as any).handleTaskNotification.bind(agent);
      await handleTaskNotification("session-2", {
        task_id: "unknown-task",
        status: "completed",
        output_file: "/tmp/output.txt",
        summary: "Done via file mapping",
      });

      expect(mockClient.sessionUpdate).toHaveBeenCalledTimes(1);
      const call = (mockClient.sessionUpdate as any).mock.calls[0][0];
      expect(call.update.toolCallId).toBe("tool-use-abc");
      expect(call.update.status).toBe("completed");
    });

    it("should map failed status to 'failed'", async () => {
      const mockClient = createMockClient();
      const mockLogger = createMockLogger();
      const agent = new ClaudeAcpAgent(mockClient, mockLogger);

      agent.backgroundTaskMap["task-fail"] = "tool-use-fail";

      const handleTaskNotification = (agent as any).handleTaskNotification.bind(agent);
      await handleTaskNotification("session-1", {
        task_id: "task-fail",
        status: "failed",
        output_file: "",
        summary: "Task failed",
      });

      const call = (mockClient.sessionUpdate as any).mock.calls[0][0];
      expect(call.update.status).toBe("failed");
    });

    it("should map stopped status to 'failed'", async () => {
      const mockClient = createMockClient();
      const mockLogger = createMockLogger();
      const agent = new ClaudeAcpAgent(mockClient, mockLogger);

      agent.backgroundTaskMap["task-stop"] = "tool-use-stop";

      const handleTaskNotification = (agent as any).handleTaskNotification.bind(agent);
      await handleTaskNotification("session-1", {
        task_id: "task-stop",
        status: "stopped",
        output_file: "",
        summary: "",
      });

      const call = (mockClient.sessionUpdate as any).mock.calls[0][0];
      expect(call.update.status).toBe("failed");
    });

    it("should clean up backgroundTaskMap entries after notification", async () => {
      const mockClient = createMockClient();
      const mockLogger = createMockLogger();
      const agent = new ClaudeAcpAgent(mockClient, mockLogger);

      agent.backgroundTaskMap["task-cleanup"] = "tool-use-cleanup";
      agent.backgroundTaskMap["file:/tmp/cleanup.txt"] = "tool-use-cleanup";

      const handleTaskNotification = (agent as any).handleTaskNotification.bind(agent);
      await handleTaskNotification("session-1", {
        task_id: "task-cleanup",
        status: "completed",
        output_file: "/tmp/cleanup.txt",
        summary: "Cleaned up",
      });

      expect(agent.backgroundTaskMap["task-cleanup"]).toBeUndefined();
      expect(agent.backgroundTaskMap["file:/tmp/cleanup.txt"]).toBeUndefined();
    });

    it("should log a message for unmapped task IDs", async () => {
      const mockClient = createMockClient();
      const mockLogger = createMockLogger();
      const agent = new ClaudeAcpAgent(mockClient, mockLogger);

      const handleTaskNotification = (agent as any).handleTaskNotification.bind(agent);
      await handleTaskNotification("session-1", {
        task_id: "unmapped-task",
        status: "completed",
        output_file: "/tmp/unmapped.txt",
        summary: "This should be logged",
      });

      expect(mockClient.sessionUpdate).not.toHaveBeenCalled();
      expect(mockLogger.log).toHaveBeenCalledWith(
        expect.stringContaining("unmapped task: unmapped-task"),
      );
    });

    it("should not include title or content when summary is empty", async () => {
      const mockClient = createMockClient();
      const mockLogger = createMockLogger();
      const agent = new ClaudeAcpAgent(mockClient, mockLogger);

      agent.backgroundTaskMap["task-no-summary"] = "tool-use-no-summary";

      const handleTaskNotification = (agent as any).handleTaskNotification.bind(agent);
      await handleTaskNotification("session-1", {
        task_id: "task-no-summary",
        status: "completed",
        output_file: "",
        summary: "",
      });

      const call = (mockClient.sessionUpdate as any).mock.calls[0][0];
      expect(call.update.title).toBeUndefined();
      expect(call.update.content).toBeUndefined();
    });

    it("should include backgroundComplete in _meta", async () => {
      const mockClient = createMockClient();
      const mockLogger = createMockLogger();
      const agent = new ClaudeAcpAgent(mockClient, mockLogger);

      agent.backgroundTaskMap["task-meta"] = "tool-use-meta";

      const handleTaskNotification = (agent as any).handleTaskNotification.bind(agent);
      await handleTaskNotification("session-1", {
        task_id: "task-meta",
        status: "completed",
        output_file: "",
        summary: "Done",
      });

      const call = (mockClient.sessionUpdate as any).mock.calls[0][0];
      expect(call.update._meta.claudeCode.backgroundComplete).toBe(true);
      expect(call.update._meta.claudeCode.isBackground).toBe(true);
      expect(call.update._meta.claudeCode.toolName).toBe("Task");
    });
  });

  // -----------------------------------------------------------------------
  // Constructor defaults
  // -----------------------------------------------------------------------

  describe("constructor", () => {
    it("should initialize with empty sessions", () => {
      const mockClient = createMockClient();
      const agent = new ClaudeAcpAgent(mockClient);

      expect(agent.sessions).toEqual({});
    });

    it("should initialize with empty toolUseCache", () => {
      const mockClient = createMockClient();
      const agent = new ClaudeAcpAgent(mockClient);

      expect(agent.toolUseCache).toEqual({});
    });

    it("should initialize with empty backgroundTerminals", () => {
      const mockClient = createMockClient();
      const agent = new ClaudeAcpAgent(mockClient);

      expect(agent.backgroundTerminals).toEqual({});
    });

    it("should initialize with empty backgroundTaskMap", () => {
      const mockClient = createMockClient();
      const agent = new ClaudeAcpAgent(mockClient);

      expect(agent.backgroundTaskMap).toEqual({});
    });

    it("should store the client reference", () => {
      const mockClient = createMockClient();
      const agent = new ClaudeAcpAgent(mockClient);

      expect(agent.client).toBe(mockClient);
    });

    it("should use console as default logger when none provided", () => {
      const mockClient = createMockClient();
      const agent = new ClaudeAcpAgent(mockClient);

      expect(agent.logger).toBe(console);
    });

    it("should use custom logger when provided", () => {
      const mockClient = createMockClient();
      const mockLogger = createMockLogger();
      const agent = new ClaudeAcpAgent(mockClient, mockLogger);

      expect(agent.logger).toBe(mockLogger);
    });
  });

  // -----------------------------------------------------------------------
  // authenticate() (not implemented)
  // -----------------------------------------------------------------------

  describe("authenticate()", () => {
    it("should throw 'Method not implemented.'", async () => {
      const mockClient = createMockClient();
      const agent = new ClaudeAcpAgent(mockClient);

      await expect(
        agent.authenticate({ authMethodId: "test", credentials: {} }),
      ).rejects.toThrow("Method not implemented.");
    });
  });
});
