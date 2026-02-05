/**
 * Typed event types for the JSONL watcher event bus.
 */

export type SessionEvent =
  | { type: "message-added"; sessionId: string; entry: unknown; role: "user" | "assistant" }
  | { type: "tool-started"; sessionId: string; entry: unknown; toolName: string; toolUseId: string }
  | { type: "tool-completed"; sessionId: string; entry: unknown; toolUseId: string }
  | { type: "agent-thinking"; sessionId: string }
  | { type: "agent-idle"; sessionId: string }
  | { type: "session-updated"; sessionId: string; projectDir: string }
  | { type: "task-notification"; sessionId: string; entry: unknown; taskId: string; status: string }
  | { type: "system-init"; sessionId: string; entry: unknown }
  | { type: "hook-lifecycle"; sessionId: string; entry: unknown; hookEvent: string; hookName: string; subtype: string }
  | { type: "compact-boundary"; sessionId: string; entry: unknown }
  | { type: "files-persisted"; sessionId: string; entry: unknown }
  | { type: "auth-status"; sessionId: string; entry: unknown }
  | { type: "raw-entry"; sessionId: string; entry: unknown };
