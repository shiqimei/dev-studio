// ── Chat messages ────────────────────────────

export interface UserMessage {
  type: "user";
  id: string;
  text: string;
}

export interface AssistantMessage {
  type: "assistant";
  id: string;
  text: string;
  done: boolean;
}

export interface ThoughtMessage {
  type: "thought";
  id: string;
  text: string;
}

export interface SystemMessage {
  type: "system";
  id: string;
  text: string;
}

export interface ToolCallMessage {
  type: "tool_call";
  id: string;
  toolCallId: string;
  kind: string;
  title: string;
  content: string;
  status: "pending" | "completed" | "failed";
}

export interface PlanEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface PlanMessage {
  type: "plan";
  id: string;
  entries: PlanEntry[];
}

export interface PermissionMessage {
  type: "permission";
  id: string;
  title: string;
}

export type ChatMessage =
  | UserMessage
  | AssistantMessage
  | ThoughtMessage
  | SystemMessage
  | ToolCallMessage
  | PlanMessage
  | PermissionMessage;

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
  messages: ChatMessage[];
  currentAssistantId: string | null;
  currentThoughtId: string | null;
  tasks: Record<string, TaskInfo>;
  peekStatus: Record<string, string>;
  turnToolCallIds: string[];
  taskPanelOpen: boolean;
  userClosedPanel: boolean;
  protoEntries: ProtoEntry[];
  dirFilter: DirFilter;
  textFilter: string;
  debugCollapsed: boolean;
  startTime: number;
}

// ── Actions ─────────────────────────────────

export type Action =
  | { type: "WS_CONNECTED" }
  | { type: "WS_DISCONNECTED" }
  | { type: "SET_BUSY"; busy: boolean }
  | { type: "SEND_MESSAGE"; text: string }
  | { type: "TEXT_CHUNK"; text: string }
  | { type: "THOUGHT_CHUNK"; text: string }
  | { type: "TOOL_CALL"; toolCallId: string; kind: string; title: string; content: string; meta: any }
  | { type: "TOOL_CALL_UPDATE"; toolCallId: string; status: string; title?: string; content?: string; meta: any }
  | { type: "PLAN"; entries: PlanEntry[] }
  | { type: "PERMISSION"; title: string }
  | { type: "SESSION_INFO"; sessionId: string; models: string[]; modes: { id: string }[] }
  | { type: "SYSTEM"; text: string }
  | { type: "TURN_END" }
  | { type: "ERROR"; text: string }
  | { type: "PROTOCOL"; dir: "send" | "recv"; ts: number; msg: unknown }
  | { type: "SET_DIR_FILTER"; filter: DirFilter }
  | { type: "SET_TEXT_FILTER"; filter: string }
  | { type: "TOGGLE_DEBUG_COLLAPSE" }
  | { type: "TOGGLE_TASK_PANEL" };
