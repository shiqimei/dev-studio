/**
 * Shared system prompts used by kanban board and task panel actions.
 * These prompts are whitelisted to skip Haiku session routing
 * (they should always stay in the current session).
 *
 * To add a new system prompt:
 * 1. Export the constant (or builder function) from this file
 * 2. Add exact strings to SYSTEM_PROMPTS or prefixes to SYSTEM_PROMPT_PREFIXES
 * 3. Import and use the constant in your component
 */

// ── Static prompts (exact match) ──

export const RETRY_PROMPT =
  "Your previous attempt didn't fully meet expectations. Please re-examine the task with fresh eyes:\n\n" +
  "- Ultrathink about the problem — consider edge cases and alternative approaches you may have missed\n" +
  "- Try a fundamentally different strategy than what you used before\n" +
  "- Be more thorough and creative in your solution\n" +
  "- If you got stuck on something, take a step back and try a completely different angle\n\n" +
  "Please retry the task now.";

// ── Dynamic prompt builders (prefix match) ──

const KILL_BASH_PREFIX = "Kill the background bash process: ";
const KILL_AGENT_PREFIX = "Kill the background agent task: ";
const KILL_TASK_PREFIX = "Kill the background task: ";

export function killTaskPrompt(toolKind: string, title: string): string {
  if (toolKind === "bash") return KILL_BASH_PREFIX + title;
  if (toolKind === "agent") return KILL_AGENT_PREFIX + title;
  return KILL_TASK_PREFIX + title;
}

// ── Whitelist ──

/** Exact-match set for static system prompts. */
const SYSTEM_PROMPTS = new Set<string>([RETRY_PROMPT]);

/** Prefix list for dynamic system prompts (matched via startsWith). */
const SYSTEM_PROMPT_PREFIXES: string[] = [
  KILL_BASH_PREFIX,
  KILL_AGENT_PREFIX,
  KILL_TASK_PREFIX,
];

/** Returns true if the given text is a known system prompt that should skip routing. */
export function isSystemPrompt(text: string): boolean {
  const trimmed = text.trim();
  if (SYSTEM_PROMPTS.has(trimmed)) return true;
  return SYSTEM_PROMPT_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}
