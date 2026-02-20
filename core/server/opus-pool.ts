/**
 * Opus Worker Pool
 *
 * Pre-warmed Opus worker pool for kanban task work. Keeps streaming SDK
 * sessions alive so moving a card to "In Progress" avoids the ~4s cold
 * start of spawning a new Opus subprocess.
 *
 * Built on the shared WorkerPool abstraction from worker-pool.ts.
 * Exposes the streaming primitive so callers can push a prompt and
 * iterate over response chunks as they arrive.
 */

import { createWorkerPool, type WorkerPool, type MetricEntry, type StreamChunk } from "./worker-pool.js";

// ── Config ──

const OPUS_CONFIG = {
  name: "opus-pool",
  model: "claude-opus-4-6",
  systemPrompt:
    "You are a highly capable coding assistant. Follow the instructions in each message exactly. " +
    "Be thorough and precise. Output ONLY what is requested, nothing else.",
  poolSize: 1,       // Opus is expensive — keep 1 pre-warmed worker
  maxUses: 20,       // Recycle sooner than Haiku (larger context per turn)
  maxPoolSize: 3,    // Hard cap on total workers
  maxThinkingTokens: 10000,
  maxBudgetUsd: 5.0, // Higher budget for Opus tasks
} as const;

// ── Types ──

export type OpusMetricEntry = MetricEntry;
export type { StreamChunk };

export interface OpusPool {
  /** Warm the pool — spawns workers and absorbs cold start. Returns when ready. */
  warmup(): Promise<void>;
  /**
   * Stream response chunks from a pre-warmed Opus worker.
   * Push a prompt, get back an async iterator of text/thinking chunks.
   * The worker is automatically released when iteration completes or is aborted.
   */
  stream(prompt: string): AsyncGenerator<StreamChunk, void, undefined>;
  /** Send a prompt and get the full response (convenience over stream). */
  query(prompt: string): Promise<string>;
  /** Record a metric entry in the ring buffer. */
  recordMetric(entry: OpusMetricEntry): void;
  /** Get collected metrics for all Opus calls. */
  getMetrics(): OpusMetricEntry[];
  /** Gracefully shut down all workers. */
  shutdown(): void;
}

// ── Pool ──

export function createOpusPool(): OpusPool {
  const pool: WorkerPool = createWorkerPool(OPUS_CONFIG);
  return pool;
}
