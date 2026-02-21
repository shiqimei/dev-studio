/**
 * Hook factories for PreToolUse and PostToolUse.
 * Extracted from tools.ts.
 *
 * Context protocol hooks:
 *   - createContextExtractionHook: PostToolUse — auto-extracts learnings after tool calls
 *   - createSubagentContextHook:   SubagentStart — injects relevant memories into subagents
 *
 * Root agent (human-spawned) stays clean — no context injection.
 * Subagents (agent-spawned) get seeded with relevant memories from the context store.
 * This is the Rung 2→3 transition: agents spawning better-equipped agents.
 */
import * as fs from "node:fs";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "../acp/types.js";
import type { SettingsManager } from "../disk/settings.js";
import {
  appendMemory,
  createEntry,
  inferTags,
  queryRelevant,
  readMemorySync,
  formatMemoriesForPrompt,
} from "../context/store.js";
import { detectTestRunner, parseTestOutput } from "../governor/test-parser.js";

/* Callbacks executed when receiving PostToolUse hooks from Claude Code.
 * Entries are evicted after 5 minutes to prevent unbounded growth from
 * orphaned tool_use_ids (e.g. cancelled background tasks). */
const CALLBACK_TTL_MS = 5 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

interface ToolUseCallbackEntry {
  registeredAt: number;
  onPostToolUseHook?: (
    toolUseID: string,
    toolInput: unknown,
    toolResponse: unknown,
  ) => Promise<void>;
}

/** Map-based callback store — O(1) has/get/set/delete, avoids Object.keys() overhead in sweep. */
const toolUseCallbacks = new Map<string, ToolUseCallbackEntry>();

let sweepTimer: ReturnType<typeof setInterval> | null = null;

function ensureSweepTimer(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of toolUseCallbacks) {
      if (now - entry.registeredAt > CALLBACK_TTL_MS) {
        toolUseCallbacks.delete(id);
      }
    }
    // Stop the timer when the map is empty to allow clean GC
    if (toolUseCallbacks.size === 0 && sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }, SWEEP_INTERVAL_MS);
  // Don't block process exit
  if (sweepTimer && typeof sweepTimer === "object" && "unref" in sweepTimer) {
    sweepTimer.unref();
  }
}

/* Setup callbacks that will be called when receiving hooks from Claude Code */
export const registerHookCallback = (
  toolUseID: string,
  {
    onPostToolUseHook,
  }: {
    onPostToolUseHook?: (
      toolUseID: string,
      toolInput: unknown,
      toolResponse: unknown,
    ) => Promise<void>;
  },
) => {
  toolUseCallbacks.set(toolUseID, {
    registeredAt: Date.now(),
    onPostToolUseHook,
  });
  ensureSweepTimer();
};

/* A callback for Claude Code that is called when receiving a PostToolUse hook */
export const createPostToolUseHook =
  (logger: Logger = console): HookCallback =>
  async (input: any, toolUseID: string | undefined): Promise<{ continue: boolean }> => {
    if (input.hook_event_name === "PostToolUse" && toolUseID) {
      const entry = toolUseCallbacks.get(toolUseID);
      // Skip tool_use_ids that were never registered (e.g. from background sub-agents)
      if (!entry) {
        return { continue: true };
      }
      if (entry.onPostToolUseHook) {
        await entry.onPostToolUseHook(toolUseID, input.tool_input, input.tool_response);
      } else {
        logger.error(`No onPostToolUseHook found for tool use ID: ${toolUseID}`);
      }
      toolUseCallbacks.delete(toolUseID);
    }
    return { continue: true };
  };

/**
 * Creates a PreToolUse hook that checks permissions using the SettingsManager.
 * This runs before the SDK's built-in permission rules, allowing us to enforce
 * our own permission settings for ACP-prefixed tools.
 */
export const createPreToolUseHook =
  (settingsManager: SettingsManager, logger: Logger = console): HookCallback =>
  async (input: any, _toolUseID: string | undefined) => {
    if (input.hook_event_name !== "PreToolUse") {
      return { continue: true };
    }

    const toolName = input.tool_name;
    const toolInput = input.tool_input;

    const permissionCheck = settingsManager.checkPermission(toolName, toolInput);

    if (permissionCheck.decision !== "ask") {
      logger.log(
        `[PreToolUseHook] Tool: ${toolName}, Decision: ${permissionCheck.decision}, Rule: ${permissionCheck.rule}`,
      );
    }

    switch (permissionCheck.decision) {
      case "allow":
        return {
          continue: true,
          hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            permissionDecision: "allow" as const,
            permissionDecisionReason: `Allowed by settings rule: ${permissionCheck.rule}`,
          },
        };

      case "deny":
        return {
          continue: true,
          hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            permissionDecision: "deny" as const,
            permissionDecisionReason: `Denied by settings rule: ${permissionCheck.rule}`,
          },
        };

      case "ask":
      default:
        // Let the normal permission flow continue
        return { continue: true };
    }
  };

// ---------------------------------------------------------------------------
// Context Protocol Hooks (extraction + injection loops)
// ---------------------------------------------------------------------------

/** Check if a tool name matches (with or without MCP prefix). */
function matchesToolName(toolName: string, baseName: string): boolean {
  return toolName === baseName || toolName === `mcp__acp__${baseName}`;
}

/** Extract text content from a tool response (handles string, MCP CallToolResult, etc.) */
function extractResponseText(toolResponse: unknown): string {
  if (typeof toolResponse === "string") return toolResponse;
  if (toolResponse && typeof toolResponse === "object") {
    const res = toolResponse as Record<string, unknown>;
    // MCP CallToolResult format: { content: [{ type: "text", text: "..." }] }
    if (Array.isArray(res.content)) {
      return (res.content as any[])
        .filter((c) => c.type === "text")
        .map((c) => c.text as string)
        .join("\n");
    }
    if (typeof res.text === "string") return res.text;
    if (typeof res.output === "string") return res.output;
  }
  return "";
}

/** Detect if a Bash tool response indicates failure. */
function isBashFailure(toolResponse: unknown, responseText: string): boolean {
  if (toolResponse && typeof toolResponse === "object") {
    if ((toolResponse as Record<string, unknown>).isError === true) return true;
  }
  if (/exit code [1-9]/i.test(responseText) || /exited with code [1-9]/i.test(responseText)) {
    return true;
  }
  return false;
}

/** Files whose modifications are worth recording as context observations. */
const NOTABLE_FILES = new Set([
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  ".env",
  ".env.local",
  ".env.production",
  "Makefile",
  "CLAUDE.md",
]);

function isNotableFile(filePath: string): boolean {
  const lastSlash = filePath.lastIndexOf("/");
  const basename = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
  return NOTABLE_FILES.has(basename) || /\.(ya?ml|toml|ini|cfg)$/.test(basename);
}

/**
 * PostToolUse hook: automatically extracts learnings from tool results
 * and persists them to the context store (extraction loop).
 */
export const createContextExtractionHook =
  (cwd: string, logger: Logger = console): HookCallback =>
  async (input: any, _toolUseID: string | undefined): Promise<{ continue: boolean }> => {
    if (input.hook_event_name !== "PostToolUse") {
      return { continue: true };
    }

    const toolName = input.tool_name as string;
    const toolInput = input.tool_input as Record<string, unknown> | undefined;
    const toolResponse = input.tool_response;
    const sessionId = input.session_id as string;

    try {
      const tags = inferTags(toolName, toolInput);

      // --- Bash failures → outcome ---
      if (matchesToolName(toolName, "Bash")) {
        const command = (toolInput?.command as string) ?? "";
        const responseText = extractResponseText(toolResponse);
        if (isBashFailure(toolResponse, responseText)) {
          const errorSnippet = responseText.slice(0, 200).trim();
          const entry = createEntry({
            assertion: `Command failed: \`${command.slice(0, 100)}\` — ${errorSnippet}`,
            kind: "outcome",
            confidence: 0.6,
            tags,
            source: { sessionId, toolName, evidence: responseText.slice(0, 500) },
          });
          appendMemory(cwd, entry).catch((err) =>
            logger.error(`[context-extraction] persist failed: ${err}`),
          );
        }
      }

      // --- Notable file modifications → observation ---
      if (matchesToolName(toolName, "Edit") || matchesToolName(toolName, "Write")) {
        const filePath =
          (toolInput?.file_path as string) ?? (toolInput?.path as string) ?? "";
        if (filePath && isNotableFile(filePath)) {
          const entry = createEntry({
            assertion: `Modified config file: ${filePath}`,
            kind: "observation",
            confidence: 0.5,
            tags,
            source: { sessionId, toolName },
          });
          appendMemory(cwd, entry).catch((err) =>
            logger.error(`[context-extraction] persist failed: ${err}`),
          );
        }
      }
    } catch (err) {
      // Never let extraction errors block tool execution
      logger.error(`[context-extraction] Error: ${err}`);
    }

    return { continue: true };
  };

/**
 * SubagentStop hook: extracts learnings from a completed subagent's transcript
 * and publishes them to the context store. This is the Rung 4 foundation —
 * knowledge flows back from subagents to the shared substrate.
 *
 * Reads the agent's transcript JSONL, scans for extractable patterns
 * (Bash failures, key outcomes, file modifications), and persists them.
 */
export const createSubagentExtractionHook =
  (cwd: string, logger: Logger = console): HookCallback =>
  async (input: any, _toolUseID: string | undefined) => {
    if (input.hook_event_name !== "SubagentStop") {
      return { continue: true };
    }

    const agentId = input.agent_id as string;
    const transcriptPath = input.agent_transcript_path as string;

    if (!transcriptPath) {
      return { continue: true };
    }

    try {
      let raw: string;
      try {
        raw = fs.readFileSync(transcriptPath, "utf8");
      } catch {
        // Transcript may not exist (e.g. agent was cancelled before writing)
        return { continue: true };
      }

      const lines = raw.split("\n").filter((l) => l.trim());
      let extractedCount = 0;

      for (const line of lines) {
        let entry: any;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }

        // Look for tool_result entries with Bash failures
        if (entry.type === "user" && Array.isArray(entry.message?.content)) {
          for (const block of entry.message.content) {
            if (block.type === "tool_result" && block.is_error) {
              const errorText =
                typeof block.content === "string"
                  ? block.content
                  : Array.isArray(block.content)
                    ? block.content
                        .filter((c: any) => c.type === "text")
                        .map((c: any) => c.text)
                        .join("\n")
                    : "";
              if (errorText && errorText.length > 10) {
                const contextEntry = createEntry({
                  assertion: `Subagent error: ${errorText.slice(0, 200).trim()}`,
                  kind: "outcome",
                  confidence: 0.5,
                  tags: ["subagent"],
                  source: { sessionId: "subagent", agentId, evidence: errorText.slice(0, 500) },
                });
                appendMemory(cwd, contextEntry).catch((err) =>
                  logger.error(`[subagent-extraction] persist failed: ${err}`),
                );
                extractedCount++;
              }
            }
          }
        }

        // Look for assistant result messages with key outcomes
        if (
          entry.type === "result" &&
          entry.subtype === "success" &&
          typeof entry.result === "string" &&
          entry.result.length > 20
        ) {
          const contextEntry = createEntry({
            assertion: `Subagent outcome: ${entry.result.slice(0, 300).trim()}`,
            kind: "outcome",
            confidence: 0.6,
            tags: ["subagent"],
            source: { sessionId: "subagent", agentId },
          });
          appendMemory(cwd, contextEntry).catch((err) =>
            logger.error(`[subagent-extraction] persist failed: ${err}`),
          );
          extractedCount++;
        }
      }

      if (extractedCount > 0) {
        logger.log(
          `[subagent-extraction] Extracted ${extractedCount} entries from subagent ${agentId?.slice(0, 8)}`,
        );
      }
    } catch (err) {
      logger.error(`[subagent-extraction] SubagentStop error: ${err}`);
    }

    return { continue: true };
  };

/**
 * SubagentStart hook: injects relevant memories from the context store into
 * subagents before they begin execution. This is where context injection lives —
 * root agents stay clean, subagents inherit accumulated project knowledge.
 *
 * Fires once per subagent spawn (not per tool call), so context cost is bounded.
 */
export const createSubagentContextHook =
  (cwd: string, logger: Logger = console): HookCallback =>
  async (input: any, _toolUseID: string | undefined) => {
    if (input.hook_event_name !== "SubagentStart") {
      return { continue: true };
    }

    try {
      const memories = readMemorySync(cwd);

      if (memories.length === 0) {
        return { continue: true };
      }

      // Score by recency + confidence + kind priority (no tag filtering —
      // we don't have the task prompt in SubagentStartHookInput)
      const relevant = queryRelevant(memories, [], 15);

      if (relevant.length === 0) {
        return { continue: true };
      }

      const contextBlock = formatMemoriesForPrompt(relevant);

      if (!contextBlock) {
        return { continue: true };
      }

      logger.log(
        `[context-injection] Injecting ${relevant.length} memories into subagent ${input.agent_id?.slice(0, 8)}`,
      );

      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: "SubagentStart" as const,
          additionalContext: contextBlock,
        },
      };
    } catch (err) {
      logger.error(`[context-injection] SubagentStart error: ${err}`);
      return { continue: true };
    }
  };
