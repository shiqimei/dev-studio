/**
 * @deprecated Import from './acp/tool-conversion.js' and './sdk/hooks.js' instead.
 * This file re-exports for backward compatibility.
 */
export {
  ACP_TOOL_NAME_PREFIX,
  acpToolNames,
  EDIT_TOOL_NAMES,
  toolInfoFromToolUse,
  toolUpdateFromToolResult,
  planEntries,
  markdownEscape,
  type ClaudePlanEntry,
} from "./acp/tool-conversion.js";

export {
  registerHookCallback,
  createPostToolUseHook,
  createPreToolUseHook,
} from "./sdk/hooks.js";
