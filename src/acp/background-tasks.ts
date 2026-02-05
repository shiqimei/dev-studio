/**
 * Background task tracking and extraction.
 * Extracted from acp-agent.ts.
 */
import type { TerminalHandle, TerminalOutputResponse } from "@agentclientprotocol/sdk";

export type BackgroundTerminal =
  | {
      handle: TerminalHandle;
      status: "started";
      lastOutput: TerminalOutputResponse | null;
    }
  | {
      status: "aborted" | "exited" | "killed" | "timedOut";
      pendingOutput: TerminalOutputResponse;
    };

/**
 * Try to extract task_id and output_file from a background tool's response.
 * The response format varies: it can be an object with fields, a string, or
 * an array of content blocks containing the info as text.
 */
export function extractBackgroundTaskInfo(response: unknown): {
  taskId?: string;
  outputFile?: string;
} {
  if (!response) return {};

  // Direct object with fields (e.g. { task_id: "abc", output_file: "/path" })
  if (typeof response === "object" && !Array.isArray(response)) {
    const obj = response as Record<string, unknown>;
    const taskId =
      (typeof obj.task_id === "string" ? obj.task_id : undefined) ||
      (typeof obj.agentId === "string" ? obj.agentId : undefined);
    const outputFile = typeof obj.output_file === "string" ? obj.output_file : undefined;
    if (taskId || outputFile) return { taskId, outputFile };
  }

  // Extract text to search for patterns
  let text: string;
  if (typeof response === "string") {
    text = response;
  } else if (Array.isArray(response)) {
    text = response
      .filter((c: any) => c?.type === "text" && typeof c?.text === "string")
      .map((c: any) => c.text)
      .join("\n");
  } else {
    try {
      text = JSON.stringify(response);
    } catch {
      return {};
    }
  }

  // Match task_id, agentId, or similar identifiers
  const taskIdMatch =
    text.match(/task[_\s-]?id[:\s]+["']?([^\s"',)]+)/i) ||
    text.match(/agentId[:\s]+["']?([^\s"',)]+)/i);
  const outputFileMatch = text.match(/output[_\s-]?file[:\s]+["']?([^\s"',)]+)/i);
  return {
    taskId: taskIdMatch?.[1],
    outputFile: outputFileMatch?.[1],
  };
}
