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
        if (obj.subtype === "task_notification") {
          this.emit("event", {
            type: "task-notification",
            sessionId,
            entry: data,
            taskId: (obj as any).task_id ?? "",
            status: (obj as any).status ?? "",
          } satisfies SessionEvent);
        }
        break;

      default:
        break;
    }
  }
}
