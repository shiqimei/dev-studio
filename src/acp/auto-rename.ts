/**
 * Auto-rename: generates a concise session title using a lightweight Haiku query.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import * as path from "node:path";
import type { Logger } from "./types.js";

const AUTO_RENAME_MODEL = "claude-haiku-4-5-20251001";

const MAX_TITLE_LENGTH = 32;

const SYSTEM_PROMPT =
  `Generate a session title in ≤${MAX_TITLE_LENGTH} characters. ` +
  "Use imperative verb phrases (e.g. Fix login bug, Add dark mode, Refactor auth). " +
  "No quotes, no trailing punctuation. Output ONLY the title, nothing else.";

export interface AutoRenameInput {
  /** The project working directory (used to derive project name). */
  cwd: string;
  /** The user's first message (truncated to ~500 chars by caller). */
  userMessage: string;
  /** The assistant's first response text (truncated to ~500 chars by caller). */
  assistantText: string;
  /** Logger for error reporting. */
  logger: Logger;
}

/**
 * Calls Haiku to generate a concise session title.
 * Returns the generated title string, or null on failure.
 */
export async function generateSessionTitle(input: AutoRenameInput): Promise<string | null> {
  const { cwd, userMessage, assistantText, logger } = input;

  const projectName = path.basename(cwd);

  let userPrompt = `Project: ${projectName}\n\nUser message:\n${userMessage.slice(0, 500)}`;
  if (assistantText.length > 0) {
    userPrompt += `\n\nAssistant response:\n${assistantText.slice(0, 500)}`;
  }

  try {
    const q = query({
      prompt: userPrompt,
      options: {
        systemPrompt: SYSTEM_PROMPT,
        model: AUTO_RENAME_MODEL,
        maxThinkingTokens: 0,
        maxTurns: 1,
        maxBudgetUsd: 0.01,
        tools: [],
        settingSources: [],
        mcpServers: {},
        hooks: {},
        persistSession: false,
        cwd,
      },
    });

    // Drain the iterator to get the result message
    let resultText: string | null = null;
    for await (const message of q) {
      if (message.type === "result" && message.subtype === "success") {
        resultText = message.result;
      }
    }

    if (!resultText) return null;

    // Clean up: trim whitespace, remove surrounding quotes, truncate
    let title = resultText.trim();
    if (
      (title.startsWith('"') && title.endsWith('"')) ||
      (title.startsWith("'") && title.endsWith("'"))
    ) {
      title = title.slice(1, -1);
    }
    if (title.endsWith(".")) {
      title = title.slice(0, -1);
    }
    title = title.slice(0, MAX_TITLE_LENGTH).trim();

    return title || null;
  } catch (err) {
    logger.error("[auto-rename] Failed to generate title:", err);
    return null;
  }
}
