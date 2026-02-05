/**
 * Types for the SDK layer.
 */
import type { Query, SDKSession, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { SettingsManager } from "../disk/settings.js";
import type { Pushable } from "../utils.js";
import type { SDKUserMessage, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/** Minimal interface needed by SessionMessageRouter — satisfied by both v1 Query and v2 replay wrapper. */
export type MessageSource = { next(): Promise<IteratorResult<SDKMessage, void>> };

export type ManagedSession = {
  // v1 fields (optional when using v2)
  query?: Query;
  input?: Pushable<SDKUserMessage>;
  // v2 field
  sdkSession?: SDKSession;
  // Common
  router: import("./message-router.js").SessionMessageRouter;
  cancelled: boolean;
  permissionMode: PermissionMode;
  settingsManager: SettingsManager;
  // Metadata for listSessions
  title: string | null;
  cwd: string;
  updatedAt: string;
};
