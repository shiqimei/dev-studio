/**
 * Shared types and constants for the ACP layer.
 */

/**
 * Logger interface for customizing logging output
 */
export interface Logger {
  log: (...args: any[]) => void;
  error: (...args: any[]) => void;
}

/**
 * Extra metadata that can be given to Claude Code when creating a new session.
 */
export type NewSessionMeta = {
  claudeCode?: {
    /**
     * Options forwarded to Claude Code when starting a new session.
     *
     * These parameters are **ignored** / overridden by ACP:
     *   - cwd, includePartialMessages, allowDangerouslySkipPermissions,
     *     permissionMode, canUseTool, tools
     *
     * These parameters are **merged** with ACP's own values:
     *   - hooks (user hooks run alongside ACP's PreToolUse/PostToolUse)
     *   - mcpServers (user servers merged with ACP's internal MCP server)
     *   - stderr (user callback invoked alongside ACP's logger)
     *   - extraArgs (merged with ACP's session-id arg)
     *
     * All other Options fields are passed through directly, including:
     *   - fallbackModel, maxBudgetUsd, maxTurns, maxThinkingTokens, model
     *   - additionalDirectories, executableArgs, spawnClaudeCodeProcess
     *   - strictMcpConfig, agent, agents, outputFormat
     *   - enableFileCheckpointing, betas, plugins, sandbox
     *   - permissionPromptToolName, settingSources, persistSession
     *   - resumeSessionAt, resume, forkSession
     *   - executable, pathToClaudeCodeExecutable
     */
    options?: import("@anthropic-ai/claude-agent-sdk").Options;
  };
};

/**
 * Extra metadata that the agent provides for each tool_call / tool_update update.
 */
export type ToolUpdateMeta = {
  claudeCode?: {
    /* The name of the tool that was used in Claude Code. */
    toolName: string;
    /* The structured output provided by Claude Code. */
    toolResponse?: unknown;
    /* True when this tool was launched as a background task (run_in_background). */
    isBackground?: boolean;
    /* True when a background task has actually finished (vs the initial "completed" which just means launched). */
    backgroundComplete?: boolean;
    /* The parent tool_use_id when this tool is called from a sub-agent (links to the parent Task's toolCallId). */
    parentToolUseId?: string;
  };
};

export type ToolUseCache = {
  [key: string]: {
    type: "tool_use" | "server_tool_use" | "mcp_tool_use";
    id: string;
    name: string;
    input: unknown;
  };
};

// ACP tool name constants

const acpUnqualifiedToolNames = {
  read: "Read",
  edit: "Edit",
  write: "Write",
  bash: "Bash",
  killShell: "KillShell",
  bashOutput: "BashOutput",
};

export const ACP_TOOL_NAME_PREFIX = "mcp__acp__";

export const acpToolNames = {
  read: ACP_TOOL_NAME_PREFIX + acpUnqualifiedToolNames.read,
  edit: ACP_TOOL_NAME_PREFIX + acpUnqualifiedToolNames.edit,
  write: ACP_TOOL_NAME_PREFIX + acpUnqualifiedToolNames.write,
  bash: ACP_TOOL_NAME_PREFIX + acpUnqualifiedToolNames.bash,
  killShell: ACP_TOOL_NAME_PREFIX + acpUnqualifiedToolNames.killShell,
  bashOutput: ACP_TOOL_NAME_PREFIX + acpUnqualifiedToolNames.bashOutput,
};

export const EDIT_TOOL_NAMES = [acpToolNames.edit, acpToolNames.write];
