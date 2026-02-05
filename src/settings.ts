/**
 * @deprecated Import from './disk/settings.js' instead.
 * This file re-exports for backward compatibility.
 */
export {
  SettingsManager,
  type PermissionSettings,
  type ClaudeCodeSettings,
  type PermissionDecision,
  type PermissionCheckResult,
  type SettingsManagerOptions,
} from "./disk/settings.js";

// Re-export getManagedSettingsPath from its new location
export { getManagedSettingsPath } from "./disk/paths.js";
