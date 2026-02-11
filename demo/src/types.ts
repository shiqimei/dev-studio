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

export interface PermissionOption {
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  name: string;
  optionId: string;
  description?: string;
}

export interface PermissionEntry {
  type: "permission";
  id: string;
  title: string;
  requestId: string;
  toolCallId?: string;
  options: PermissionOption[];
  status: "pending" | "resolved";
  selectedOptionId?: string;
  selectedOptionName?: string;
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
  /** Turn start timestamp (only present when turnStatus is "in_progress"). */
  turnStartedAt?: number;
  /** Current activity (only present when turnStatus is "in_progress"). */
  turnActivity?: TurnActivity;
  /** Activity detail (only present when turnStatus is "in_progress"). */
  turnActivityDetail?: string;
  /** Turn duration in ms (present when turnStatus is "completed"). */
  turnDurationMs?: number;
  /** Output tokens (present when turnStatus is "completed"). */
  turnOutputTokens?: number;
  /** Cost in USD (present when turnStatus is "completed"). */
  turnCostUsd?: number;
  /** Thinking duration in ms (present when turnStatus is "completed"). */
  turnThinkingDurationMs?: number;
  /** Why the last turn ended (e.g., "end_turn", "error", "max_tokens"). */
  turnStopReason?: string;
}

export interface TaskItemEntry {
  id: string;
  subject: string;
  description?: string;
  activeForm?: string;
  status: "pending" | "in_progress" | "completed";
  blocks: string[];
  blockedBy: string[];
}

export interface SessionSnapshot {
  messages: ChatEntry[];
  tasks: Record<string, TaskInfo>;
  currentTurnId: string | null;
  turnToolCallIds: string[];
  turnStatus: TurnStatus | null;
  queuedMessages: string[];
  /** Queued user messages not yet picked up by the agent (held out of messages[]). */
  pendingQueuedEntries: MessageEntry[];
  latestPlan: PlanEntryItem[] | null;
  latestTasks: TaskItemEntry[] | null;
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
  /** Why the turn ended (e.g., "end_turn", "error", "max_tokens", "tool_use"). */
  stopReason?: string;
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
  /** Current reconnection attempt (0 = not reconnecting or first connect). */
  reconnectAttempt: number;
  busy: boolean;
  queuedMessages: string[];
  /** Queued user messages not yet picked up by the agent (held out of messages[]). */
  pendingQueuedEntries: MessageEntry[];
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
  /** Per-session turn status cache (keyed by sessionId). */
  liveTurnStatus: Record<string, TurnStatus>;
  startTime: number;
  // Session management
  diskSessions: DiskSession[];
  diskSessionsLoaded: boolean;
  currentSessionId: string | null;
  switchingToSessionId: string | null;
  sessionHistory: Record<string, SessionSnapshot>;
  // Session metadata
  /** Available models from session_info (e.g. ["claude-opus-4-6-20250219"]). */
  models: string[];
  /** Currently selected model (e.g. "claude-opus-4-6-20250219"). */
  currentModel: string | null;
  // Slash commands
  commands: SlashCommand[];
  /** Tracks recently deleted session IDs to prevent stale SESSIONS broadcasts from re-adding them. */
  _recentlyDeletedIds: string[];

  /** Latest plan/todo entries from the most recent TodoWrite call. */
  latestPlan: PlanEntryItem[] | null;
  /** Latest task entries from the Tasks system (TaskCreate/TaskUpdate). */
  latestTasks: TaskItemEntry[] | null;
  /** Sessions whose turn completed while the user was viewing a different session. */
  unreadCompletedSessions: Record<string, true>;

  // Kanban persistence
  kanbanColumnOverrides: Record<string, string>;
  kanbanSortOrders: Partial<Record<string, string[]>>;
  kanbanPendingPrompts: Record<string, string>;
  kanbanStateLoaded: boolean;
}

// ── Actions ─────────────────────────────────

export type Action =
  | { type: "WS_CONNECTED" }
  | { type: "WS_DISCONNECTED" }
  | { type: "WS_RECONNECTING"; attempt: number }
  | { type: "SET_BUSY"; busy: boolean }
  | { type: "SEND_MESSAGE"; text: string; images?: ImageAttachment[]; files?: FileAttachment[]; queueId?: string }
  | { type: "TEXT_CHUNK"; text: string }
  | { type: "THOUGHT_CHUNK"; text: string }
  | { type: "TOOL_CALL"; toolCallId: string; kind: string; title: string; content: string; rawInput?: unknown; meta: any }
  | { type: "TOOL_CALL_UPDATE"; toolCallId: string; status: string; title?: string; kind?: string; content?: string; rawInput?: unknown; meta: any }
  | { type: "PLAN"; entries: PlanEntryItem[] }
  | { type: "TASKS"; tasks: TaskItemEntry[] }
  | { type: "PERMISSION_REQUEST"; requestId: string; title: string; toolCallId?: string; options: PermissionOption[] }
  | { type: "PERMISSION_RESOLVED"; requestId: string; optionId: string; optionName: string }
  | { type: "SESSION_INFO"; sessionId: string; models: string[]; currentModel?: string | null; modes: { id: string }[] }
  | { type: "SYSTEM"; text: string }
  | { type: "TURN_START"; startedAt: number }
  | { type: "TURN_ACTIVITY"; activity: TurnActivity; detail?: string; approxTokens?: number; thinkingDurationMs?: number }
  | { type: "TURN_END"; durationMs?: number; outputTokens?: number; thinkingDurationMs?: number; costUsd?: number; stopReason?: string }
  | { type: "ERROR"; text: string }
  | { type: "PROTOCOL"; dir: "send" | "recv"; ts: number; msg: unknown }
  | { type: "SET_DIR_FILTER"; filter: DirFilter }
  | { type: "SET_TEXT_FILTER"; filter: string }
  | { type: "TOGGLE_DEBUG_COLLAPSE" }
  | { type: "TOGGLE_TASK_PANEL" }

  | { type: "SESSIONS"; sessions: DiskSession[] }
  | { type: "SESSION_HISTORY"; sessionId: string; entries: unknown[] }
  | { type: "SESSION_SWITCH_PENDING"; sessionId: string }
  | { type: "SESSION_SWITCHED"; sessionId: string; turnStatus?: TurnStatus | null }
  | { type: "SESSION_TITLE_UPDATE"; sessionId: string; title: string }
  | { type: "MESSAGE_QUEUED"; queueId: string }
  | { type: "QUEUE_DRAIN_START"; queueId: string }
  | { type: "QUEUE_CANCELLED"; queueId: string }
  | { type: "COMMANDS"; commands: SlashCommand[]; models?: string[]; currentModel?: string | null }
  | { type: "SESSION_SUBAGENTS"; sessionId: string; children: SubagentChild[] }
  | { type: "SESSION_DELETED"; sessionIds: string[] }
  | { type: "SESSION_ID_RESOLVED"; pendingId: string; realId: string }
  | { type: "SESSION_DESELECTED" }
  | { type: "KANBAN_STATE_LOADED"; columnOverrides: Record<string, string>; sortOrders: Partial<Record<string, string[]>>; pendingPrompts: Record<string, string> }
  | { type: "KANBAN_UPDATE_PENDING_PROMPT"; sessionId: string; text: string }
  | { type: "SET_OPTIMISTIC_TURN_STATUS"; sessionId: string; status: TurnStatus };
