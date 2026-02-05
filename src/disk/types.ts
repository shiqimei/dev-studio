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
