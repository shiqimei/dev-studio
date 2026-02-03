import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpServer, SYSTEM_REMINDER } from "../mcp-server.js";
import { ClaudeAcpAgent } from "../acp-agent.js";
import { AgentSideConnection, ClientCapabilities } from "@agentclientprotocol/sdk";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockAgent(
  overrides: Partial<{
    clientCapabilities: ClientCapabilities;
  }> = {},
): ClaudeAcpAgent {
  const mockClient = {
    readTextFile: vi.fn(),
    writeTextFile: vi.fn(),
    createTerminal: vi.fn(),
    sessionUpdate: vi.fn(),
    requestPermission: vi.fn(),
  } as unknown as AgentSideConnection;

  const agent = {
    sessions: {},
    client: mockClient,
    toolUseCache: {},
    backgroundTerminals: {},
    backgroundTaskMap: {},
    clientCapabilities: overrides.clientCapabilities,
    logger: { log: vi.fn(), error: vi.fn() },
    readTextFile: vi.fn(),
    writeTextFile: vi.fn(),
  } as unknown as ClaudeAcpAgent;

  return agent;
}

/**
 * Returns the names of all tools registered on a McpServer instance by
 * accessing the private `_registeredTools` map.
 */
function getRegisteredToolNames(server: McpServer): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registered = (server as any)._registeredTools as Record<string, unknown>;
  return Object.keys(registered);
}

// ---------------------------------------------------------------------------
// Tests – SYSTEM_REMINDER constant
// ---------------------------------------------------------------------------

describe("SYSTEM_REMINDER", () => {
  it("should be a non-empty string", () => {
    expect(typeof SYSTEM_REMINDER).toBe("string");
    expect(SYSTEM_REMINDER.length).toBeGreaterThan(0);
  });

  it("should contain <system-reminder> opening tag", () => {
    expect(SYSTEM_REMINDER).toContain("<system-reminder>");
  });

  it("should contain </system-reminder> closing tag", () => {
    expect(SYSTEM_REMINDER).toContain("</system-reminder>");
  });

  it("should mention malicious file analysis", () => {
    expect(SYSTEM_REMINDER).toContain("malicious");
  });
});

// ---------------------------------------------------------------------------
// Tests – createMcpServer
// ---------------------------------------------------------------------------

describe("createMcpServer", () => {
  it("should return an McpServer instance", () => {
    const agent = createMockAgent();
    const server = createMcpServer(agent, "test-session", undefined);

    expect(server).toBeInstanceOf(McpServer);
  });

  // -----------------------------------------------------------------------
  // No capabilities
  // -----------------------------------------------------------------------

  it("should not register any tools when clientCapabilities is undefined", () => {
    const agent = createMockAgent();
    const server = createMcpServer(agent, "test-session", undefined);

    expect(getRegisteredToolNames(server)).toHaveLength(0);
  });

  it("should not register any tools when clientCapabilities is an empty object", () => {
    const agent = createMockAgent();
    const server = createMcpServer(agent, "test-session", {} as ClientCapabilities);

    expect(getRegisteredToolNames(server)).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // fs.readTextFile capability
  // -----------------------------------------------------------------------

  describe("when fs.readTextFile capability is true", () => {
    const capabilities: ClientCapabilities = {
      fs: { readTextFile: true },
    };

    it("should register the Read tool", () => {
      const agent = createMockAgent();
      const server = createMcpServer(agent, "test-session", capabilities);

      const toolNames = getRegisteredToolNames(server);
      expect(toolNames).toContain("Read");
    });

    it("should not register Write or Edit tools", () => {
      const agent = createMockAgent();
      const server = createMcpServer(agent, "test-session", capabilities);

      const toolNames = getRegisteredToolNames(server);
      expect(toolNames).not.toContain("Write");
      expect(toolNames).not.toContain("Edit");
    });

    it("should not register Bash, BashOutput, or KillShell tools", () => {
      const agent = createMockAgent();
      const server = createMcpServer(agent, "test-session", capabilities);

      const toolNames = getRegisteredToolNames(server);
      expect(toolNames).not.toContain("Bash");
      expect(toolNames).not.toContain("BashOutput");
      expect(toolNames).not.toContain("KillShell");
    });

    it("should register exactly 1 tool", () => {
      const agent = createMockAgent();
      const server = createMcpServer(agent, "test-session", capabilities);

      expect(getRegisteredToolNames(server)).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // fs.writeTextFile capability
  // -----------------------------------------------------------------------

  describe("when fs.writeTextFile capability is true", () => {
    const capabilities: ClientCapabilities = {
      fs: { writeTextFile: true },
    };

    it("should register the Write tool", () => {
      const agent = createMockAgent();
      const server = createMcpServer(agent, "test-session", capabilities);

      const toolNames = getRegisteredToolNames(server);
      expect(toolNames).toContain("Write");
    });

    it("should register the Edit tool", () => {
      const agent = createMockAgent();
      const server = createMcpServer(agent, "test-session", capabilities);

      const toolNames = getRegisteredToolNames(server);
      expect(toolNames).toContain("Edit");
    });

    it("should not register the Read tool", () => {
      const agent = createMockAgent();
      const server = createMcpServer(agent, "test-session", capabilities);

      const toolNames = getRegisteredToolNames(server);
      expect(toolNames).not.toContain("Read");
    });

    it("should register exactly 2 tools", () => {
      const agent = createMockAgent();
      const server = createMcpServer(agent, "test-session", capabilities);

      expect(getRegisteredToolNames(server)).toHaveLength(2);
    });
  });

  // -----------------------------------------------------------------------
  // Both fs capabilities
  // -----------------------------------------------------------------------

  describe("when both fs.readTextFile and fs.writeTextFile capabilities are true", () => {
    const capabilities: ClientCapabilities = {
      fs: { readTextFile: true, writeTextFile: true },
    };

    it("should register Read, Write, and Edit tools", () => {
      const agent = createMockAgent();
      const server = createMcpServer(agent, "test-session", capabilities);

      const toolNames = getRegisteredToolNames(server);
      expect(toolNames).toContain("Read");
      expect(toolNames).toContain("Write");
      expect(toolNames).toContain("Edit");
    });

    it("should register exactly 3 tools", () => {
      const agent = createMockAgent();
      const server = createMcpServer(agent, "test-session", capabilities);

      expect(getRegisteredToolNames(server)).toHaveLength(3);
    });
  });

  // -----------------------------------------------------------------------
  // terminal capability – note: createMcpServer reads agent.clientCapabilities
  // for the terminal check, not the clientCapabilities parameter.
  // -----------------------------------------------------------------------

  describe("when terminal capability is true", () => {
    it("should register Bash, BashOutput, and KillShell tools", () => {
      const capabilities: ClientCapabilities = {
        terminal: true,
      };
      // The terminal branch reads agent.clientCapabilities, not the parameter.
      const agent = createMockAgent({ clientCapabilities: capabilities });
      const server = createMcpServer(agent, "test-session", capabilities);

      const toolNames = getRegisteredToolNames(server);
      expect(toolNames).toContain("Bash");
      expect(toolNames).toContain("BashOutput");
      expect(toolNames).toContain("KillShell");
    });

    it("should register exactly 3 tools when only terminal is set", () => {
      const capabilities: ClientCapabilities = {
        terminal: true,
      };
      const agent = createMockAgent({ clientCapabilities: capabilities });
      const server = createMcpServer(agent, "test-session", capabilities);

      expect(getRegisteredToolNames(server)).toHaveLength(3);
    });

    it("should not register terminal tools when only the parameter has terminal but agent does not", () => {
      // Only pass terminal via the function parameter, but the agent itself
      // does not have clientCapabilities.terminal set.
      const agent = createMockAgent();
      const paramCapabilities: ClientCapabilities = { terminal: true };
      const server = createMcpServer(agent, "test-session", paramCapabilities);

      const toolNames = getRegisteredToolNames(server);
      expect(toolNames).not.toContain("Bash");
      expect(toolNames).not.toContain("BashOutput");
      expect(toolNames).not.toContain("KillShell");
    });
  });

  // -----------------------------------------------------------------------
  // All capabilities
  // -----------------------------------------------------------------------

  describe("when all capabilities are true", () => {
    it("should register all 6 tools", () => {
      const capabilities: ClientCapabilities = {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      };
      const agent = createMockAgent({ clientCapabilities: capabilities });
      const server = createMcpServer(agent, "test-session", capabilities);

      const toolNames = getRegisteredToolNames(server);
      expect(toolNames).toContain("Read");
      expect(toolNames).toContain("Write");
      expect(toolNames).toContain("Edit");
      expect(toolNames).toContain("Bash");
      expect(toolNames).toContain("BashOutput");
      expect(toolNames).toContain("KillShell");
      expect(toolNames).toHaveLength(6);
    });
  });

  // -----------------------------------------------------------------------
  // Partial capability combinations
  // -----------------------------------------------------------------------

  describe("partial capability combinations", () => {
    it("should register Read + terminal tools when readTextFile and terminal are true", () => {
      const capabilities: ClientCapabilities = {
        fs: { readTextFile: true },
        terminal: true,
      };
      const agent = createMockAgent({ clientCapabilities: capabilities });
      const server = createMcpServer(agent, "test-session", capabilities);

      const toolNames = getRegisteredToolNames(server);
      expect(toolNames).toContain("Read");
      expect(toolNames).toContain("Bash");
      expect(toolNames).toContain("BashOutput");
      expect(toolNames).toContain("KillShell");
      expect(toolNames).not.toContain("Write");
      expect(toolNames).not.toContain("Edit");
      expect(toolNames).toHaveLength(4);
    });

    it("should register Write + Edit + terminal tools when writeTextFile and terminal are true", () => {
      const capabilities: ClientCapabilities = {
        fs: { writeTextFile: true },
        terminal: true,
      };
      const agent = createMockAgent({ clientCapabilities: capabilities });
      const server = createMcpServer(agent, "test-session", capabilities);

      const toolNames = getRegisteredToolNames(server);
      expect(toolNames).toContain("Write");
      expect(toolNames).toContain("Edit");
      expect(toolNames).toContain("Bash");
      expect(toolNames).toContain("BashOutput");
      expect(toolNames).toContain("KillShell");
      expect(toolNames).not.toContain("Read");
      expect(toolNames).toHaveLength(5);
    });
  });

  // -----------------------------------------------------------------------
  // Explicit false values
  // -----------------------------------------------------------------------

  describe("explicit false capability values", () => {
    it("should not register Read when fs.readTextFile is false", () => {
      const capabilities: ClientCapabilities = {
        fs: { readTextFile: false },
      };
      const agent = createMockAgent();
      const server = createMcpServer(agent, "test-session", capabilities);

      const toolNames = getRegisteredToolNames(server);
      expect(toolNames).not.toContain("Read");
    });

    it("should not register Write/Edit when fs.writeTextFile is false", () => {
      const capabilities: ClientCapabilities = {
        fs: { writeTextFile: false },
      };
      const agent = createMockAgent();
      const server = createMcpServer(agent, "test-session", capabilities);

      const toolNames = getRegisteredToolNames(server);
      expect(toolNames).not.toContain("Write");
      expect(toolNames).not.toContain("Edit");
    });

    it("should not register terminal tools when terminal is false", () => {
      const capabilities: ClientCapabilities = {
        terminal: false,
      };
      const agent = createMockAgent({ clientCapabilities: { terminal: false } });
      const server = createMcpServer(agent, "test-session", capabilities);

      const toolNames = getRegisteredToolNames(server);
      expect(toolNames).not.toContain("Bash");
      expect(toolNames).not.toContain("BashOutput");
      expect(toolNames).not.toContain("KillShell");
    });
  });

  // -----------------------------------------------------------------------
  // sessionId is passed through
  // -----------------------------------------------------------------------

  it("should accept different sessionId values without error", () => {
    const agent = createMockAgent();
    expect(() => createMcpServer(agent, "", undefined)).not.toThrow();
    expect(() => createMcpServer(agent, "session-abc-123", undefined)).not.toThrow();
    expect(() =>
      createMcpServer(agent, "a-very-long-session-id-string-value", undefined),
    ).not.toThrow();
  });
});
