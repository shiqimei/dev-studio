/**
 * ACP notification builders for system events that were previously silently skipped.
 * Each function returns a SessionNotification with structured _meta.claudeCode metadata.
 */
import type { SessionNotification } from "@agentclientprotocol/sdk";

// --- Metadata interfaces ---

export interface SystemInitMeta {
  eventType: "system_init";
  tools?: unknown[];
  mcpServers?: unknown[];
  model?: string;
  claudeCodeVersion?: string;
  agents?: unknown[];
  permissionMode?: string;
  slashCommands?: unknown[];
  skills?: unknown[];
  plugins?: unknown[];
  cwd?: string;
  apiKeySource?: string;
  betas?: string[];
  sessionId?: string;
  /** Disk-based stats summary */
  stats?: { lastComputedDate: string; recentActivity: unknown[] } | undefined;
  /** Slash commands from disk */
  diskCommands?: string[];
  /** Plugins from disk */
  diskPlugins?: string[];
  /** Skills from disk */
  diskSkills?: string[];
}

export interface HookStartedMeta {
  eventType: "hook_started";
  hookId: string;
  hookName: string;
  hookEvent: string;
}

export interface HookProgressMeta {
  eventType: "hook_progress";
  hookId: string;
  hookName: string;
  hookEvent: string;
  stdout?: string;
  stderr?: string;
  output?: string;
}

export interface HookResponseMeta {
  eventType: "hook_response";
  hookId: string;
  hookName: string;
  hookEvent: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  outcome?: string;
}

export interface CompactBoundaryMeta {
  eventType: "compact_boundary";
  trigger?: string;
  preTokens?: number;
}

export interface FilesPersistedMeta {
  eventType: "files_persisted";
  files?: { filename: string; fileId: string }[];
  failed?: { filename: string; error: string }[];
  processedAt?: string;
}

export interface AuthStatusMeta {
  eventType: "auth_status";
  isAuthenticating?: boolean;
  output?: string;
  error?: string;
}

export type SystemEventMeta =
  | SystemInitMeta
  | HookStartedMeta
  | HookProgressMeta
  | HookResponseMeta
  | CompactBoundaryMeta
  | FilesPersistedMeta
  | AuthStatusMeta;

// --- Notification builder functions ---

export function systemInitNotification(
  sessionId: string,
  message: Record<string, unknown>,
  diskData?: {
    stats?: SystemInitMeta["stats"];
    diskCommands?: string[];
    diskPlugins?: string[];
    diskSkills?: string[];
  },
): SessionNotification {
  const meta: SystemInitMeta = {
    eventType: "system_init",
    tools: message.tools as unknown[] | undefined,
    mcpServers: message.mcp_servers as unknown[] | undefined,
    model: message.model as string | undefined,
    claudeCodeVersion: message.claude_code_version as string | undefined,
    agents: message.agents as unknown[] | undefined,
    permissionMode: message.permission_mode as string | undefined,
    slashCommands: message.slash_commands as unknown[] | undefined,
    skills: message.skills as unknown[] | undefined,
    plugins: message.plugins as unknown[] | undefined,
    cwd: message.cwd as string | undefined,
    apiKeySource: message.api_key_source as string | undefined,
    betas: message.betas as string[] | undefined,
    sessionId: message.session_id as string | undefined,
  };
  if (diskData) {
    if (diskData.stats !== undefined) meta.stats = diskData.stats;
    if (diskData.diskCommands) meta.diskCommands = diskData.diskCommands;
    if (diskData.diskPlugins) meta.diskPlugins = diskData.diskPlugins;
    if (diskData.diskSkills) meta.diskSkills = diskData.diskSkills;
  }

  const parts: string[] = [];
  if (meta.model) parts.push(`model=${meta.model}`);
  if (meta.claudeCodeVersion) parts.push(`v${meta.claudeCodeVersion}`);
  if (meta.tools) parts.push(`${meta.tools.length} tools`);
  if (meta.mcpServers) parts.push(`${meta.mcpServers.length} MCP servers`);

  return {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: `[System initialized: ${parts.join(", ")}]`,
      },
      _meta: { claudeCode: meta },
    },
  };
}

export function hookStartedNotification(
  sessionId: string,
  message: Record<string, unknown>,
): SessionNotification {
  const meta: HookStartedMeta = {
    eventType: "hook_started",
    hookId: (message.hook_id as string) ?? "",
    hookName: (message.hook_name as string) ?? "",
    hookEvent: (message.hook_event as string) ?? "",
  };

  return {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: `[Hook started: ${meta.hookName} (${meta.hookEvent})]`,
      },
      _meta: { claudeCode: meta },
    },
  };
}

export function hookProgressNotification(
  sessionId: string,
  message: Record<string, unknown>,
): SessionNotification {
  const meta: HookProgressMeta = {
    eventType: "hook_progress",
    hookId: (message.hook_id as string) ?? "",
    hookName: (message.hook_name as string) ?? "",
    hookEvent: (message.hook_event as string) ?? "",
    stdout: message.stdout as string | undefined,
    stderr: message.stderr as string | undefined,
    output: message.output as string | undefined,
  };

  return {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: `[Hook progress: ${meta.hookName}]`,
      },
      _meta: { claudeCode: meta },
    },
  };
}

export function hookResponseNotification(
  sessionId: string,
  message: Record<string, unknown>,
): SessionNotification {
  const meta: HookResponseMeta = {
    eventType: "hook_response",
    hookId: (message.hook_id as string) ?? "",
    hookName: (message.hook_name as string) ?? "",
    hookEvent: (message.hook_event as string) ?? "",
    stdout: message.stdout as string | undefined,
    stderr: message.stderr as string | undefined,
    exitCode: message.exit_code as number | undefined,
    outcome: message.outcome as string | undefined,
  };

  const status = meta.exitCode === 0 ? "succeeded" : `exited ${meta.exitCode}`;

  return {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: `[Hook response: ${meta.hookName} ${status}]`,
      },
      _meta: { claudeCode: meta },
    },
  };
}

export function compactBoundaryNotification(
  sessionId: string,
  message: Record<string, unknown>,
): SessionNotification {
  const meta: CompactBoundaryMeta = {
    eventType: "compact_boundary",
    trigger: message.trigger as string | undefined,
    preTokens: message.pre_tokens as number | undefined,
  };

  return {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: `[Compact boundary: ${meta.trigger ?? "unknown"}${meta.preTokens ? `, ${meta.preTokens} tokens` : ""}]`,
      },
      _meta: { claudeCode: meta },
    },
  };
}

export function filesPersistedNotification(
  sessionId: string,
  message: Record<string, unknown>,
): SessionNotification {
  const files = (message.files as { filename: string; fileId: string }[]) ?? [];
  const failed = (message.failed as { filename: string; error: string }[]) ?? [];

  const meta: FilesPersistedMeta = {
    eventType: "files_persisted",
    files,
    failed,
    processedAt: message.processed_at as string | undefined,
  };

  return {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: `[Files persisted: ${files.length} saved${failed.length > 0 ? `, ${failed.length} failed` : ""}]`,
      },
      _meta: { claudeCode: meta },
    },
  };
}

export function authStatusNotification(
  sessionId: string,
  message: Record<string, unknown>,
): SessionNotification {
  const meta: AuthStatusMeta = {
    eventType: "auth_status",
    isAuthenticating: message.is_authenticating as boolean | undefined,
    output: message.output as string | undefined,
    error: message.error as string | undefined,
  };

  const status = meta.isAuthenticating
    ? "authenticating..."
    : meta.error
      ? `error: ${meta.error}`
      : "completed";

  return {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: `[Auth status: ${status}]`,
      },
      _meta: { claudeCode: meta },
    },
  };
}
