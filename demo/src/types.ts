// ── Content blocks (match JSONL content block types) ──

export interface ImageAttachment {
  data: string;
  mimeType: string;
}

export interface FileAttachment {
  path: string;
  name: string;
}

export interface SlashCommand {
  name: string;
  description: string;
  inputHint?: string;
}

export interface TextBlock {
  type: "text";
  text: string;
  _streaming?: boolean;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  _streaming?: boolean;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
  // UI extensions (added during streaming or history post-processing)
  title?: string;
  kind?: string;
  status?: "pending" | "completed" | "failed";
  result?: string;
  agentId?: string;
  // Timing / background task tracking
  startTime?: number;
  endTime?: number;
  isBackground?: boolean;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: unknown;
  is_error?: boolean;
}

export interface ImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}

export interface FileBlock {
  type: "file";
  path: string;
  name: string;
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | ImageBlock
  | FileBlock;

// ── Turn entries (match JSONL user/assistant entries) ──

export interface MessageEntry {
  type: "message";
  id: string;
  role: "user" | "assistant";
  content: ContentBlock[];
  isMeta?: boolean;
  _streaming?: boolean;
  _queueId?: string;
}

// ── Non-turn entries ──

export interface SystemEntry {
  type: "system";
  id: string;
  text: string;
  isError?: boolean;
}

export interface PlanEntryItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface PlanEntry {
  type: "plan";
  id: string;
  entries: PlanEntryItem[];
}

export interface PermissionEntry {
  type: "permission";
  id: string;
  title: string;
}

export interface TurnCompletedEntry {
  type: "turn_completed";
  id: string;
  durationMs: number;
  outputTokens?: number;
  thinkingDurationMs?: number;
  costUsd?: number;
}

export type ChatEntry =
  | MessageEntry
  | SystemEntry
  | PlanEntry
  | PermissionEntry
  | TurnCompletedEntry;

// ── Sessions ────────────────────────────────

export type SubagentType = "code" | "explore" | "bash" | "plan" | "agent";

export interface SubagentChild {
  agentId: string;
  taskPrompt: string;
  timestamp: string;
  agentType: SubagentType;
  parentAgentId?: string;
  children?: SubagentChild[];
  /** Present for teammate sessions that have their own sessionId (loaded via resumeSession). */
  sessionId?: string;
}

export interface DiskSession {
  sessionId: string;
  title: string | null;
  updatedAt: string | null;
  created: string | null;
  messageCount: number;
  gitBranch: string | null;
  projectPath: string | null;
  children?: SubagentChild[];
  /** Present when this session is a team leader. */
  teamName?: string;
  /** True when this session is active in the ACP connection. */
  isLive?: boolean;
  /** Server-side turn status for this session (only present for live sessions). */
  turnStatus?: "in_progress" | "completed" | "error";
}

export interface SessionSnapshot {
  messages: ChatEntry[];
  tasks: Record<string, TaskInfo>;
  currentTurnId: string | null;
  turnToolCallIds: string[];
  turnStatus: TurnStatus | null;
  queuedMessages: string[];
}

// ── Turn status ──────────────────────────────

export type TurnActivity =
  | "brewing"
  | "thinking"
  | "responding"
  | "reading"
  | "editing"
  | "running"
  | "searching"
  | "delegating"
  | "planning"
  | "compacting";

export interface TurnStatus {
  status: "in_progress" | "completed" | "error";
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  approxTokens?: number;
  outputTokens?: number;
  thinkingDurationMs?: number;
  costUsd?: number;
  activity?: TurnActivity;
  /** Tool name or description for the current activity */
  activityDetail?: string;
}

// ── Tasks ────────────────────────────────────

export interface TaskInfo {
  toolCallId: string;
  title: string;
  kind: string;
  toolKind: string;
  toolName: string;
  status: "running" | "completed" | "failed";
  isBackground: boolean;
  startTime: number;
  endTime: number | null;
}

// ── Debug protocol ──────────────────────────

export interface ProtoEntry {
  id: string;
  dir: "send" | "recv";
  ts: number;
  msg: unknown;
  method: string;
  msgId: string;
}

// ── App state ───────────────────────────────

export type DirFilter = "all" | "send" | "recv";

export interface AppState {
  connected: boolean;
  busy: boolean;
  queuedMessages: string[];
  messages: ChatEntry[];
  currentTurnId: string | null;
  tasks: Record<string, TaskInfo>;
  peekStatus: Record<string, string>;
  turnToolCallIds: string[];
  taskPanelOpen: boolean;
  userClosedPanel: boolean;
  protoEntries: ProtoEntry[];
  dirFilter: DirFilter;
  textFilter: string;
  debugCollapsed: boolean;
  turnStatus: TurnStatus | null;
  startTime: number;
  // Session management
  diskSessions: DiskSession[];
  diskSessionsLoaded: boolean;
  currentSessionId: string | null;
  switchingToSessionId: string | null;
  sessionHistory: Record<string, SessionSnapshot>;
  // Slash commands
  commands: SlashCommand[];
}

// ── Actions ─────────────────────────────────

export type Action =
  | { type: "WS_CONNECTED" }
  | { type: "WS_DISCONNECTED" }
  | { type: "SET_BUSY"; busy: boolean }
  | { type: "SEND_MESSAGE"; text: string; images?: ImageAttachment[]; files?: FileAttachment[]; queueId?: string }
  | { type: "TEXT_CHUNK"; text: string }
  | { type: "THOUGHT_CHUNK"; text: string }
  | { type: "TOOL_CALL"; toolCallId: string; kind: string; title: string; content: string; rawInput?: unknown; meta: any }
  | { type: "TOOL_CALL_UPDATE"; toolCallId: string; status: string; title?: string; kind?: string; content?: string; rawInput?: unknown; meta: any }
  | { type: "PLAN"; entries: PlanEntryItem[] }
  | { type: "PERMISSION"; title: string }
  | { type: "SESSION_INFO"; sessionId: string; models: string[]; modes: { id: string }[] }
  | { type: "SYSTEM"; text: string }
  | { type: "TURN_START"; startedAt: number }
  | { type: "TURN_ACTIVITY"; activity: TurnActivity; detail?: string; approxTokens?: number; thinkingDurationMs?: number }
  | { type: "TURN_END"; durationMs?: number; outputTokens?: number; thinkingDurationMs?: number; costUsd?: number }
  | { type: "ERROR"; text: string }
  | { type: "PROTOCOL"; dir: "send" | "recv"; ts: number; msg: unknown }
  | { type: "SET_DIR_FILTER"; filter: DirFilter }
  | { type: "SET_TEXT_FILTER"; filter: string }
  | { type: "TOGGLE_DEBUG_COLLAPSE" }
  | { type: "TOGGLE_TASK_PANEL" }
  | { type: "SESSIONS"; sessions: DiskSession[] }
  | { type: "SESSION_HISTORY"; sessionId: string; entries: unknown[] }
  | { type: "SESSION_SWITCH_PENDING"; sessionId: string }
  | { type: "SESSION_SWITCHED"; sessionId: string }
  | { type: "SESSION_TITLE_UPDATE"; sessionId: string; title: string }
  | { type: "MESSAGE_QUEUED"; queueId: string }
  | { type: "QUEUE_DRAIN_START"; queueId: string }
  | { type: "QUEUE_CANCELLED"; queueId: string }
  | { type: "COMMANDS"; commands: SlashCommand[] }
  | { type: "SESSION_SUBAGENTS"; sessionId: string; children: SubagentChild[] };
