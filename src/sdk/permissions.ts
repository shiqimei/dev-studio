/**
 * canUseTool callback factory.
 * Extracted from ClaudeAcpAgent.canUseTool().
 */
import type { AgentSideConnection, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { CanUseTool, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { EDIT_TOOL_NAMES } from "../acp/types.js";
import { toolInfoFromToolUse } from "../acp/tool-conversion.js";
import type { ManagedSession } from "./types.js";

/**
 * Race a requestPermission call against the abort signal so that canUseTool
 * returns quickly when the SDK cancels the control request (e.g. on interrupt).
 * Without this, the requestPermission promise would hang until the 5-minute
 * timeout in WebClient even after the signal is already aborted.
 */
function raceWithAbort(
  permissionPromise: Promise<RequestPermissionResponse>,
  signal: AbortSignal,
): Promise<RequestPermissionResponse> {
  if (signal.aborted) {
    return Promise.reject(new Error("Tool use aborted"));
  }
  return Promise.race([
    permissionPromise,
    new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("Tool use aborted")), { once: true });
    }),
  ]);
}

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

    if (toolName === "AskUserQuestion") {
      const input = toolInput as {
        questions: Array<{
          question: string;
          header: string;
          options: Array<{ label: string; description: string }>;
          multiSelect: boolean;
        }>;
      };

      // Ask each question sequentially via requestPermission
      const answers: string[] = [];
      for (let qi = 0; qi < (input.questions?.length ?? 0); qi++) {
        const q = input.questions[qi];
        const options = q.options.map((opt, i) => ({
          kind: "allow_once" as const,
          name: opt.label,
          optionId: `q${qi}_opt${i}`,
          description: opt.description,
        }));

        const response = await raceWithAbort(
          client.requestPermission({
            options,
            sessionId,
            toolCall: {
              toolCallId: toolUseID,
              rawInput: toolInput,
              title: q.question,
            },
          }),
          signal,
        );

        if (response.outcome?.outcome === "cancelled") {
          throw new Error("Tool use aborted");
        }

        if (response.outcome?.outcome === "selected") {
          const optIdx = parseInt(response.outcome.optionId.replace(`q${qi}_opt`, ""), 10);
          const selected = q.options[optIdx];
          answers.push(`${q.header}: ${selected?.label ?? response.outcome.optionId}`);
        }
      }

      // Return answers as a denial message — the model will see the user's choices
      // and continue working with them. No interrupt so the model keeps running.
      return {
        behavior: "deny",
        message: `User answered:\n${answers.join("\n")}`,
      };
    }

    if (toolName === "ExitPlanMode") {
      const response = await raceWithAbort(
        client.requestPermission({
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
        }),
        signal,
      );

      if (response.outcome?.outcome === "cancelled") {
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

    const response = await raceWithAbort(
      client.requestPermission({
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
      }),
      signal,
    );
    if (response.outcome?.outcome === "cancelled") {
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
