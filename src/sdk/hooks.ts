/**
 * Hook factories for PreToolUse and PostToolUse.
 * Extracted from tools.ts.
 */
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "../acp/types.js";
import type { SettingsManager } from "../disk/settings.js";

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

const toolUseCallbacks: Record<string, ToolUseCallbackEntry> = {};

let sweepTimer: ReturnType<typeof setInterval> | null = null;

function ensureSweepTimer(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const id of Object.keys(toolUseCallbacks)) {
      if (now - toolUseCallbacks[id].registeredAt > CALLBACK_TTL_MS) {
        delete toolUseCallbacks[id];
      }
    }
    // Stop the timer when the map is empty to allow clean GC
    if (Object.keys(toolUseCallbacks).length === 0 && sweepTimer) {
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
  toolUseCallbacks[toolUseID] = {
    registeredAt: Date.now(),
    onPostToolUseHook,
  };
  ensureSweepTimer();
};

/* A callback for Claude Code that is called when receiving a PostToolUse hook */
export const createPostToolUseHook =
  (logger: Logger = console): HookCallback =>
  async (input: any, toolUseID: string | undefined): Promise<{ continue: boolean }> => {
    if (input.hook_event_name === "PostToolUse" && toolUseID) {
      // Skip tool_use_ids that were never registered (e.g. from background sub-agents)
      if (!(toolUseID in toolUseCallbacks)) {
        return { continue: true };
      }
      const onPostToolUseHook = toolUseCallbacks[toolUseID]?.onPostToolUseHook;
      if (onPostToolUseHook) {
        await onPostToolUseHook(toolUseID, input.tool_input, input.tool_response);
      } else {
        logger.error(`No onPostToolUseHook found for tool use ID: ${toolUseID}`);
      }
      delete toolUseCallbacks[toolUseID];
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
