/**
 * Hook factories for PreToolUse and PostToolUse.
 * Extracted from tools.ts.
 *
 * Context protocol hooks (Phase 1 & 2):
 *   - createContextExtractionHook: PostToolUse — auto-extracts learnings after tool calls
 *   - createContextInjectionHook:  PreToolUse  — auto-injects relevant context before tool calls
 */
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "../acp/types.js";
import type { SettingsManager } from "../disk/settings.js";
import {
  appendMemory,
  createEntry,
  inferTags,
} from "../context/store.js";

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


