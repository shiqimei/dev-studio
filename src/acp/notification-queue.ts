/**
 * Non-blocking notification queue for ACP sessionUpdate calls.
 *
 * Queues non-critical notifications (stream events, progress, message chunks)
 * and sends them without blocking the message processing loop.
 * Critical notifications (results, errors) can still be awaited directly.
 *
 * Uses a counter-based tracking pattern: instead of maintaining an array of
 * promises (which requires periodic compaction), we track the count of
 * in-flight sends and resolve a single drain promise when it reaches zero.
 */
import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import type { Logger } from "./types.js";
import { perfStart } from "../utils/perf.js";

export class NotificationQueue {
  /** Number of in-flight (not yet settled) enqueued sends. */
  private inflight = 0;
  /** Resolve callback for the current flush() waiter, if any. */
  private drainResolve: (() => void) | null = null;

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
    this.inflight++;
    this.client.sessionUpdate(notification).then(
      () => {
        span.end();
        this.settle();
      },
      (err) => {
        span.end();
        this.logger.error("[NotificationQueue] send failed:", err);
        this.settle();
      },
    );
  }

  /** Decrement inflight counter and resolve drain waiter if empty. */
  private settle(): void {
    this.inflight--;
    if (this.inflight === 0 && this.drainResolve) {
      const resolve = this.drainResolve;
      this.drainResolve = null;
      resolve();
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
    if (this.inflight === 0) return;
    return new Promise<void>((resolve) => {
      this.drainResolve = resolve;
    });
  }
}
