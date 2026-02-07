/**
 * Incremental JSONL file watcher using Node.js fs.watch.
 * Watches a directory for .jsonl file changes and emits new entries.
 * Tracks byte offsets per file to only read new content.
 *
 * Follows the Confirmo AgentMonitor pattern (references/confirmo/agent-monitor.ts).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { EventEmitter } from "node:events";

export interface JsonlEntry {
  sessionId: string;
  data: unknown;
}

export interface JsonlWatcherOptions {
  /** Debounce interval in ms for file change events. Default: 100 */
  debounceMs?: number;
  /** Logger for errors */
  logger?: { error: (...args: any[]) => void };
}

/**
 * Watches a directory for JSONL file changes and emits parsed entries.
 *
 * Events:
 *   - "entry" (entry: JsonlEntry) — a new JSONL line was appended
 *   - "error" (err: Error) — a read/parse error occurred
 */
export class JsonlWatcher extends EventEmitter {
  private dir: string;
  private offsets: Map<string, number> = new Map();
  private watcher: fs.FSWatcher | null = null;
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private debounceMs: number;
  private logger: { error: (...args: any[]) => void };

  constructor(dir: string, options?: JsonlWatcherOptions) {
    super();
    this.dir = dir;
    this.debounceMs = options?.debounceMs ?? 100;
    this.logger = options?.logger ?? console;
  }

  /** Start watching the directory for .jsonl changes. */
  async start(): Promise<void> {
    if (this.watcher) return;

    try {
      await fs.promises.mkdir(this.dir, { recursive: true });

      this.watcher = fs.watch(this.dir, (eventType, filename) => {
        if (!filename || !filename.endsWith(".jsonl")) return;
        this.scheduleRead(filename);
      });

      this.watcher.on("error", (err) => {
        this.logger.error("[JsonlWatcher] watcher error:", err);
        this.emit("error", err);
      });
    } catch (err) {
      this.logger.error("[JsonlWatcher] failed to start:", err);
      this.emit("error", err);
    }
  }

  /** Stop watching and clean up. */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  /** Read new entries from a specific file (useful for initial catch-up). */
  readFile(filename: string): void {
    void this.readNewEntries(filename);
  }

  private scheduleRead(filename: string): void {
    const existing = this.debounceTimers.get(filename);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(
      filename,
      setTimeout(() => {
        this.debounceTimers.delete(filename);
        void this.readNewEntries(filename);
      }, this.debounceMs),
    );
  }

  private async readNewEntries(filename: string): Promise<void> {
    const filePath = path.join(this.dir, filename);
    const sessionId = path.basename(filename, ".jsonl");

    try {
      const stat = await fs.promises.stat(filePath);
      const currentOffset = this.offsets.get(filename) ?? 0;

      if (stat.size <= currentOffset) {
        // File was truncated or hasn't grown
        if (stat.size < currentOffset) {
          // File was truncated — reset offset
          this.offsets.set(filename, 0);
        }
        return;
      }

      // Read only the new bytes
      const fh = await fs.promises.open(filePath, "r");
      try {
        const bytesToRead = stat.size - currentOffset;
        const buffer = Buffer.alloc(bytesToRead);
        await fh.read(buffer, 0, bytesToRead, currentOffset);

        const newContent = buffer.toString("utf-8");
        const lines = newContent.split("\n");

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const data = JSON.parse(trimmed);
            this.emit("entry", { sessionId, data });
          } catch {
            // Partial line at the end — don't advance past it
            // We'll pick it up on the next read when the line is complete
            const partialBytes = Buffer.byteLength(line + "\n", "utf-8");
            this.offsets.set(filename, stat.size - partialBytes);
            return;
          }
        }

        this.offsets.set(filename, stat.size);
      } finally {
        await fh.close();
      }
    } catch (err) {
      // File may have been deleted — clean up debounce timer
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.debounceTimers.delete(filename);
      } else {
        this.logger.error(`[JsonlWatcher] error reading ${filename}:`, err);
        this.emit("error", err);
      }
    }
  }
}
