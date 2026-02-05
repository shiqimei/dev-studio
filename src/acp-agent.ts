/**
 * @deprecated Import from './acp/agent.js', './acp/types.js', and './acp/notifications.js' instead.
 * This file re-exports for backward compatibility.
 */
export { CLAUDE_CONFIG_DIR } from "./disk/paths.js";

export {
  ClaudeAcpAgent,
  runAcp,
} from "./acp/agent.js";

export {
  toAcpNotifications,
  streamEventToAcpNotifications,
  promptToClaude,
} from "./acp/notifications.js";

export type {
  Logger,
  NewSessionMeta,
  ToolUpdateMeta,
  ToolUseCache,
} from "./acp/types.js";

export {
  systemInitNotification,
  hookStartedNotification,
  hookProgressNotification,
  hookResponseNotification,
  compactBoundaryNotification,
  filesPersistedNotification,
  authStatusNotification,
} from "./acp/system-notifications.js";
export type {
  SystemInitMeta,
  HookStartedMeta,
  HookProgressMeta,
  HookResponseMeta,
  CompactBoundaryMeta,
  FilesPersistedMeta,
  AuthStatusMeta,
  SystemEventMeta,
} from "./acp/system-notifications.js";
