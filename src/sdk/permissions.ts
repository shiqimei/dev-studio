/**
 * canUseTool callback factory.
 * Extracted from ClaudeAcpAgent.canUseTool().
 */
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { CanUseTool, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { EDIT_TOOL_NAMES } from "../acp/types.js";
import { toolInfoFromToolUse } from "../acp/tool-conversion.js";
import type { ManagedSession } from "./types.js";

/**
 * Creates a canUseTool callback for a given session.
 *
 * @param sessionId - The session ID
 * @param sessions - Reference to the sessions map
 * @param client - ACP client connection
 * @returns CanUseTool callback
 */
export function createCanUseTool(
  sessionId: string,
  sessions: { [key: string]: ManagedSession },
  client: AgentSideConnection,
): CanUseTool {
  return async (toolName, toolInput, { signal, suggestions, toolUseID }) => {
    const session = sessions[sessionId];
    if (!session) {
      return {
        behavior: "deny",
        message: "Session not found",
        interrupt: true,
      };
    }

    if (toolName === "ExitPlanMode") {
      const response = await client.requestPermission({
        options: [
          {
            kind: "allow_always",
            name: "Yes, and auto-accept edits",
            optionId: "acceptEdits",
          },
          { kind: "allow_once", name: "Yes, and manually approve edits", optionId: "default" },
          { kind: "reject_once", name: "No, keep planning", optionId: "plan" },
        ],
        sessionId,
        toolCall: {
          toolCallId: toolUseID,
          rawInput: toolInput,
          title: toolInfoFromToolUse({ name: toolName, input: toolInput }).title,
        },
      });

      if (signal.aborted || response.outcome?.outcome === "cancelled") {
        throw new Error("Tool use aborted");
      }
      if (
        response.outcome?.outcome === "selected" &&
        (response.outcome.optionId === "default" || response.outcome.optionId === "acceptEdits")
      ) {
        session.permissionMode = response.outcome.optionId as PermissionMode;
        await client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "current_mode_update",
            currentModeId: response.outcome.optionId,
          },
        });

        return {
          behavior: "allow",
          updatedInput: toolInput,
          updatedPermissions: suggestions ?? [
            { type: "setMode", mode: response.outcome.optionId, destination: "session" },
          ],
        };
      } else {
        return {
          behavior: "deny",
          message: "User rejected request to exit plan mode.",
          interrupt: true,
        };
      }
    }

    if (
      session.permissionMode === "bypassPermissions" ||
      (session.permissionMode === "acceptEdits" && EDIT_TOOL_NAMES.includes(toolName))
    ) {
      return {
        behavior: "allow",
        updatedInput: toolInput,
        updatedPermissions: suggestions ?? [
          { type: "addRules", rules: [{ toolName }], behavior: "allow", destination: "session" },
        ],
      };
    }

    const response = await client.requestPermission({
      options: [
        {
          kind: "allow_always",
          name: "Always Allow",
          optionId: "allow_always",
        },
        { kind: "allow_once", name: "Allow", optionId: "allow" },
        { kind: "reject_once", name: "Reject", optionId: "reject" },
      ],
      sessionId,
      toolCall: {
        toolCallId: toolUseID,
        rawInput: toolInput,
        title: toolInfoFromToolUse({ name: toolName, input: toolInput }).title,
      },
    });
    if (signal.aborted || response.outcome?.outcome === "cancelled") {
      throw new Error("Tool use aborted");
    }
    if (
      response.outcome?.outcome === "selected" &&
      (response.outcome.optionId === "allow" || response.outcome.optionId === "allow_always")
    ) {
      // If Claude Code has suggestions, it will update their settings already
      if (response.outcome.optionId === "allow_always") {
        return {
          behavior: "allow",
          updatedInput: toolInput,
          updatedPermissions: suggestions ?? [
            {
              type: "addRules",
              rules: [{ toolName }],
              behavior: "allow",
              destination: "session",
            },
          ],
        };
      }
      return {
        behavior: "allow",
        updatedInput: toolInput,
      };
    } else {
      return {
        behavior: "deny",
        message: "User refused permission to run tool",
        interrupt: true,
      };
    }
  };
}
