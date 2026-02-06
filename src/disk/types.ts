/**
 * Types for disk-based session and settings data.
 */

export interface SessionIndexEntry {
  sessionId: string;
  firstPrompt?: string;
  created?: string;
  modified?: string;
  projectPath?: string;
  isSidechain?: boolean;
  messageCount?: number;
  gitBranch?: string;
}

export interface SessionsIndex {
  entries: SessionIndexEntry[];
}

export interface HistoryMessage {
  role: "user" | "assistant";
  text: string;
}

/** A raw JSONL entry from a session conversation file. */
export interface JsonlEntry {
  type: string;
  message?: { role: string; content: unknown; model?: string };
  subtype?: string;
  isMeta?: boolean;
  parent_tool_use_id?: string | null;
  uuid?: string;
  session_id?: string;
  result?: string;
  is_error?: boolean;
  [key: string]: unknown;
}
