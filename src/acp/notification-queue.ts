/**
 * Non-blocking notification queue for ACP sessionUpdate calls.
 *
 * Queues non-critical notifications (stream events, progress, message chunks)
 * and sends them without blocking the message processing loop.
 * Critical notifications (results, errors) can still be awaited directly.
 *
 * Uses a simple drain pattern: enqueue() is non-blocking, flush() awaits
 * all pending sends before returning.
 */
import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import type { Logger } from "./types.js";
import { perfStart } from "../utils/perf.js";

export class NotificationQueue {
  private pending: Promise<void>[] = [];

  constructor(
    private client: AgentSideConnection,
    private logger: Logger,
  ) {}

  /**
   * Enqueue a notification to be sent without blocking the caller.
   * Errors are logged but do not propagate.
   */
  enqueue(notification: SessionNotification): void {
    const span = perfStart("notificationQueue.enqueue");
    const p = this.client.sessionUpdate(notification).then(
      () => { span.end(); },
      (err) => {
        span.end();
        this.logger.error("[NotificationQueue] send failed:", err);
      },
    ) as Promise<void>;
    this.pending.push(p);

    // Periodically compact settled promises to avoid unbounded growth
    if (this.pending.length > 100) {
      this.compact();
    }
  }

  /**
   * Send a notification and wait for it to complete.
   * Use this for critical notifications where ordering/completion matters.
   */
  async send(notification: SessionNotification): Promise<void> {
    // First drain any pending non-critical sends to preserve ordering
    await this.flush();
    await this.client.sessionUpdate(notification);
  }

  /**
   * Wait for all pending enqueued notifications to complete.
   * Call this before returning from prompt() to ensure all updates are delivered.
   */
  async flush(): Promise<void> {
    while (this.pending.length > 0) {
      const batch = this.pending;
      this.pending = [];
      await Promise.all(batch);
    }
  }

  /**
   * Replace the pending array with a single promise that resolves
   * when all current pending items settle. Keeps only 1 entry.
   */
  private compact(): void {
    const all = Promise.all(this.pending).then(() => {}, () => {});
    this.pending = [all];
  }
}
