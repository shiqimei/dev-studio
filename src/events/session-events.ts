/**
 * Typed event emitter on top of JsonlWatcher.
 * Classifies raw JSONL entries into typed SessionEvent values.
 */
import { EventEmitter } from "node:events";
import { JsonlWatcher, type JsonlEntry, type JsonlWatcherOptions } from "./jsonl-watcher.js";
import type { SessionEvent } from "./types.js";

export interface SessionEventEmitterOptions extends JsonlWatcherOptions {
  /** Set of message IDs already reported, for deduplication. */
  reportedMessageIds?: Set<string>;
}

/**
 * Wraps a JsonlWatcher and emits typed SessionEvent values.
 *
 * Events:
 *   - "event" (event: SessionEvent) — a classified session event
 */
export class SessionEventEmitter extends EventEmitter {
  private watcher: JsonlWatcher;
  private reportedIds: Set<string>;

  constructor(dir: string, options?: SessionEventEmitterOptions) {
    super();
    this.watcher = new JsonlWatcher(dir, options);
    this.reportedIds = options?.reportedMessageIds ?? new Set();

    this.watcher.on("entry", (entry: JsonlEntry) => {
      this.processEntry(entry);
    });

    this.watcher.on("error", (err) => {
      this.emit("error", err);
    });
  }

  start(): void {
    this.watcher.start();
  }

  stop(): void {
    this.watcher.stop();
  }

  private processEntry(entry: JsonlEntry): void {
    const { sessionId, data } = entry;
    const obj = data as Record<string, unknown>;

    // Dedup by uuid if present
    if (typeof obj.uuid === "string") {
      if (this.reportedIds.has(obj.uuid)) return;
      this.reportedIds.add(obj.uuid);
    }

    // Always emit raw entry
    this.emit("event", { type: "raw-entry", sessionId, entry: data } satisfies SessionEvent);

    // Classify into typed events
    switch (obj.type) {
      case "user":
        this.emit("event", {
          type: "message-added",
          sessionId,
          entry: data,
          role: "user",
        } satisfies SessionEvent);
        break;

      case "assistant":
        this.emit("event", {
          type: "message-added",
          sessionId,
          entry: data,
          role: "assistant",
        } satisfies SessionEvent);
        break;

      case "system":
        switch (obj.subtype) {
          case "task_notification":
            this.emit("event", {
              type: "task-notification",
              sessionId,
              entry: data,
              taskId: (obj as any).task_id ?? "",
              status: (obj as any).status ?? "",
            } satisfies SessionEvent);
            break;
          case "init":
            this.emit("event", {
              type: "system-init",
              sessionId,
              entry: data,
            } satisfies SessionEvent);
            break;
          case "hook_started":
          case "hook_progress":
          case "hook_response":
            this.emit("event", {
              type: "hook-lifecycle",
              sessionId,
              entry: data,
              hookEvent: (obj as any).hook_event ?? "",
              hookName: (obj as any).hook_name ?? "",
              subtype: obj.subtype as string,
            } satisfies SessionEvent);
            break;
          case "compact_boundary":
            this.emit("event", {
              type: "compact-boundary",
              sessionId,
              entry: data,
            } satisfies SessionEvent);
            break;
          case "files_persisted":
            this.emit("event", {
              type: "files-persisted",
              sessionId,
              entry: data,
            } satisfies SessionEvent);
            break;
          default:
            break;
        }
        break;

      case "auth_status":
        this.emit("event", {
          type: "auth-status",
          sessionId,
          entry: data,
        } satisfies SessionEvent);
        break;

      default:
        // Extract tool_use from assistant messages
        if (obj.type === "assistant" || obj.type === "user") {
          const message = obj.message as { content?: unknown[] } | undefined;
          if (message && Array.isArray(message.content)) {
            for (const block of message.content) {
              const b = block as Record<string, unknown>;
              if (
                b.type === "tool_use" ||
                b.type === "server_tool_use" ||
                b.type === "mcp_tool_use"
              ) {
                this.emit("event", {
                  type: "tool-started",
                  sessionId,
                  entry: data,
                  toolName: (b.name as string) ?? "",
                  toolUseId: (b.id as string) ?? "",
                } satisfies SessionEvent);
              } else if (
                b.type === "tool_result" ||
                b.type === "mcp_tool_result"
              ) {
                this.emit("event", {
                  type: "tool-completed",
                  sessionId,
                  entry: data,
                  toolUseId: (b.tool_use_id as string) ?? "",
                } satisfies SessionEvent);
              }
            }
          }
        }
        break;
    }
  }
}
