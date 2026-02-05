// Export the main agent class and utilities for library usage

// --- ACP Layer ---
export { ClaudeAcpAgent, runAcp } from "./acp/agent.js";
export {
  toAcpNotifications,
  streamEventToAcpNotifications,
  promptToClaude,
} from "./acp/notifications.js";
export { createMcpServer } from "./acp/mcp-server.js";
export {
  toolInfoFromToolUse,
  planEntries,
  toolUpdateFromToolResult,
  acpToolNames as toolNames,
} from "./acp/tool-conversion.js";
export type {
  Logger,
  NewSessionMeta,
  ToolUpdateMeta,
  ToolUseCache,
} from "./acp/types.js";
export type { ClaudePlanEntry } from "./acp/tool-conversion.js";

// --- SDK Layer ---
export { createPreToolUseHook, createPostToolUseHook } from "./sdk/hooks.js";
export { createCanUseTool } from "./sdk/permissions.js";
export { SessionMessageRouter } from "./sdk/message-router.js";

// --- Disk Layer ---
export {
  SettingsManager,
  type ClaudeCodeSettings,
  type PermissionSettings,
  type PermissionDecision,
  type PermissionCheckResult,
  type SettingsManagerOptions,
} from "./disk/settings.js";
export {
  CLAUDE_CONFIG_DIR,
  getProjectDir,
  getSessionsIndexPath,
  getSessionJsonlPath,
  getUserSettingsPath,
  getProjectSettingsPath,
  getLocalSettingsPath,
  getManagedSettingsPath,
} from "./disk/paths.js";
export { readSessionsIndex } from "./disk/sessions-index.js";
export { readSessionHistory } from "./disk/session-history.js";
export type { SessionIndexEntry, SessionsIndex, HistoryMessage } from "./disk/types.js";

// --- Events Layer ---
export { JsonlWatcher } from "./events/jsonl-watcher.js";
export { SessionEventEmitter } from "./events/session-events.js";
export type { SessionEvent } from "./events/types.js";

// --- Utilities ---
export {
  loadManagedSettings,
  applyEnvironmentSettings,
  nodeToWebReadable,
  nodeToWebWritable,
  Pushable,
  unreachable,
} from "./utils.js";
