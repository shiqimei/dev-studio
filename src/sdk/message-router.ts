/**
 * SessionMessageRouter: wraps a Query async generator to continuously read messages.
 * Intercepts system messages (e.g. task_notification) that need immediate handling
 * — even between turns — while buffering everything else for prompt().
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "../acp/types.js";
import type { MessageSource } from "./types.js";

export class SessionMessageRouter {
  private buffer: SDKMessage[] = [];
  private resolver: ((result: IteratorResult<SDKMessage, void>) => void) | null = null;
  private rejecter: ((err: unknown) => void) | null = null;
  private finished = false;
  private streamError: unknown = null;

  constructor(
    private query: MessageSource,
    private onSystemMessage: (msg: SDKMessage) => Promise<void>,
    private logger: Logger,
  ) {
    this.startReading();
  }

  private async startReading() {
    try {
      while (true) {
        const result = await this.query.next();
        if (result.done || !result.value) {
          this.finished = true;
          if (this.resolver) {
            this.resolver({ value: undefined as any, done: true });
            this.resolver = null;
            this.rejecter = null;
          }
          break;
        }

        const msg = result.value;

        // Intercept task_notification for immediate handling between turns
        if (msg.type === "system" && msg.subtype === "task_notification") {
          try {
            await this.onSystemMessage(msg);
          } catch (err) {
            this.logger.error("[SessionMessageRouter] onSystemMessage error:", err);
          }
          continue;
        }

        // Forward to prompt() consumer
        if (this.resolver) {
          this.resolver({ value: msg, done: false });
          this.resolver = null;
          this.rejecter = null;
        } else {
          this.buffer.push(msg);
        }
      }
    } catch (err) {
      this.logger.error("[SessionMessageRouter] stream error:", err);
      this.finished = true;
      this.streamError = err;
      if (this.rejecter) {
        this.rejecter(err);
        this.resolver = null;
        this.rejecter = null;
      }
    }
  }

  /** Current number of buffered messages waiting for consumption. */
  get bufferDepth(): number {
    return this.buffer.length;
  }

  /** Drop-in replacement for query.next() used by prompt(). */
  async next(): Promise<IteratorResult<SDKMessage, void>> {
    if (this.buffer.length > 0) {
      return { value: this.buffer.shift()!, done: false };
    }
    if (this.finished) {
      if (this.streamError) {
        throw this.streamError;
      }
      return { value: undefined, done: true };
    }
    return new Promise((resolve, reject) => {
      this.resolver = resolve;
      this.rejecter = reject;
    });
  }
}
