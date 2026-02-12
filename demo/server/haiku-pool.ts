/**
 * Haiku Worker Pool
 *
 * Pre-warmed Haiku worker pool for lightweight tasks (routing, title generation).
 * Built on the shared WorkerPool abstraction from worker-pool.ts.
 */

import * as path from "node:path";
import { createWorkerPool, type WorkerPool, type MetricEntry } from "./worker-pool.js";
import { log } from "./log.js";

// ── Config ──

const HAIKU_CONFIG = {
  name: "haiku-pool",
  model: "claude-haiku-4-5-20251001",
  systemPrompt:
    "You are a fast, efficient assistant. Follow the instructions in each message exactly. " +
    "Be concise. Output ONLY what is requested, nothing else.",
  poolSize: 2,
  maxUses: 40,
  maxPoolSize: 4,
  maxBudgetUsd: 1.0,
} as const;

// ── Types ──

export type HaikuMetricEntry = MetricEntry;

export interface HaikuPool {
  /** Warm the pool — spawns workers and absorbs cold start. Returns when ready. */
  warmup(): Promise<void>;
  /** Send a prompt and get a response using a pre-warmed worker. */
  query(prompt: string): Promise<string>;
  /** Route a message: returns true if it belongs to the current session. */
  route(messageText: string, sessionTitle: string | null, lastTurnSummary: string | null): Promise<boolean>;
  /** Generate a concise session title from user message and assistant response. */
  generateTitle(cwd: string, userMessage: string, assistantText: string): Promise<string | null>;
  /** Get collected metrics for all Haiku calls. */
  getMetrics(): HaikuMetricEntry[];
  /** Gracefully shut down all workers. */
  shutdown(): void;
}

// ── Pool ──

export function createHaikuPool(): HaikuPool {
  const pool: WorkerPool = createWorkerPool(HAIKU_CONFIG);
  const { warmup, query: queryPool, recordMetric, getMetrics, shutdown } = pool;

  // ── Route ──

  function buildRoutePrompt(messageText: string, sessionTitle: string, lastTurnSummary: string | null): string {
    const contextBlock = lastTurnSummary ? `\n${lastTurnSummary}\n` : "";
    return (
      `You are routing a message. Determine if it should continue in the current session or start a new one.\n\n` +
      `Session title: "${sessionTitle}"${contextBlock}\nNew message: "${messageText.slice(0, 500)}"\n\n` +
      `Reply with ONLY "same" if the message relates to the current session topic, or "new" if it's a different topic that should start a fresh session.`
    );
  }

  async function route(
    messageText: string,
    sessionTitle: string | null,
    lastTurnSummary: string | null,
  ): Promise<boolean> {
    if (!sessionTitle) return true; // untitled → stay in current session

    try {
      const t0 = performance.now();
      const prompt = buildRoutePrompt(messageText, sessionTitle, lastTurnSummary);
      const answer = await queryPool(prompt);
      const durationMs = Math.round(performance.now() - t0);
      const isSame = !answer.toLowerCase().startsWith("new");
      log.info({ durationMs, answer, isSame }, "route: Haiku decision (pooled)");
      recordMetric({
        timestamp: Date.now(),
        operation: "route",
        durationMs,
        inputLength: prompt.length,
        outputLength: answer.length,
        output: answer.slice(0, 200),
        success: true,
      });
      return isSame;
    } catch (err: any) {
      log.warn({ err: err.message }, "route: Haiku pooled query failed, defaulting to same session");
      recordMetric({
        timestamp: Date.now(),
        operation: "route",
        durationMs: 0,
        inputLength: messageText.length,
        outputLength: 0,
        output: err.message?.slice(0, 200) ?? "error",
        success: false,
      });
      return true;
    }
  }

  // ── Title generation ──

  const MAX_TITLE_LENGTH = 50;

  function buildTitlePrompt(projectName: string, userMessage: string, assistantText: string): string {
    let prompt =
      `Generate a short session title (3-6 words, max ${MAX_TITLE_LENGTH} chars). ` +
      `Use imperative verb phrases (e.g. Fix login bug, Add dark mode, Refactor auth). ` +
      `Keep it short and self-contained — avoid dangling prepositions or articles at the end. ` +
      `No quotes, no trailing punctuation. Output ONLY the title, nothing else.\n\n` +
      `Project: ${projectName}\n\nUser message:\n${userMessage.slice(0, 500)}`;
    if (assistantText.length > 0) {
      prompt += `\n\nAssistant response:\n${assistantText.slice(0, 500)}`;
    }
    return prompt;
  }

  async function generateTitle(
    cwd: string,
    userMessage: string,
    assistantText: string,
  ): Promise<string | null> {
    try {
      const t0 = performance.now();
      const projectName = path.basename(cwd);
      const prompt = buildTitlePrompt(projectName, userMessage, assistantText);
      const raw = await queryPool(prompt);

      if (!raw) return null;

      // Clean up: trim whitespace, remove surrounding quotes, truncate
      let title = raw.trim();
      if (
        (title.startsWith('"') && title.endsWith('"')) ||
        (title.startsWith("'") && title.endsWith("'"))
      ) {
        title = title.slice(1, -1);
      }
      if (title.endsWith(".")) title = title.slice(0, -1);
      if (title.length > MAX_TITLE_LENGTH) {
        // Truncate at word boundary, then strip dangling prepositions/articles
        title = title.slice(0, MAX_TITLE_LENGTH);
        const lastSpace = title.lastIndexOf(" ");
        if (lastSpace > 0) title = title.slice(0, lastSpace);
        // Strip trailing filler words that look "cut" (e.g. "Add support for" → "Add support")
        title = title.replace(/\s+(?:for|to|in|on|at|of|the|a|an|with|and|or|from|by|as|into)$/i, "");
      }
      title = title.trim();

      const durationMs = Math.round(performance.now() - t0);
      log.info({ durationMs, title }, "haiku-pool: generated title");
      recordMetric({
        timestamp: Date.now(),
        operation: "title",
        durationMs,
        inputLength: prompt.length,
        outputLength: raw.length,
        output: (title || raw).slice(0, 200),
        success: true,
      });
      return title || null;
    } catch (err: any) {
      log.warn({ err: err.message }, "haiku-pool: generateTitle failed");
      recordMetric({
        timestamp: Date.now(),
        operation: "title",
        durationMs: 0,
        inputLength: userMessage.length,
        outputLength: 0,
        output: err.message?.slice(0, 200) ?? "error",
        success: false,
      });
      return null;
    }
  }

  return { warmup, query: queryPool, route, generateTitle, getMetrics, shutdown };
}
