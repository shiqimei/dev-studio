import {
  createContext,
  useContext,
  useReducer,
  useRef,
  useEffect,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import type {
  AppState,
  Action,
  ChatEntry,
  MessageEntry,
  ContentBlock,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  SessionSnapshot,
  TurnStatus,
  ImageAttachment,
  FileAttachment,
  SlashCommand,
  FileBlock,
} from "../types";
import { classifyTool } from "../utils";
import { jsonlToEntries, prettyToolName, extractAgentId } from "../jsonl-convert";

/** High-resolution timestamp since page navigation start (ms). */
function pageMs(): string {
  return performance.now().toFixed(0) + "ms";
}

// ── Hash-based routing helpers ──

/** Parse the URL hash into session/subagent references. */
function parseSessionHash(hash = window.location.hash): {
  sessionId: string;
  parentId?: string;
  agentId?: string;
} | null {
  if (!hash || hash === "#") return null;

  // #/session/{parentId}/agent/{agentId}
  const subMatch = hash.match(/^#\/session\/([^/]+)\/agent\/(.+)$/);
  if (subMatch) {
    return {
      sessionId: `${subMatch[1]}:subagent:${subMatch[2]}`,
      parentId: subMatch[1],
      agentId: subMatch[2],
    };
  }

  // #/session/{sessionId}
  const match = hash.match(/^#\/session\/(.+)$/);
  if (match) return { sessionId: match[1] };

  return null;
}

/** Convert a currentSessionId to a URL hash string. */
function sessionIdToHash(sessionId: string): string {
  const subMatch = sessionId.match(/^(.+):subagent:(.+)$/);
  if (subMatch) {
    return `#/session/${subMatch[1]}/agent/${subMatch[2]}`;
  }
  return `#/session/${sessionId}`;
}

let nextId = 0;
function uid(): string {
  return "m" + nextId++;
}

const emptySnapshot: SessionSnapshot = {
  messages: [],
  tasks: {},
  currentTurnId: null,
  turnToolCallIds: [],
  turnStatus: null,
  queuedMessages: [],
};

const initialState: AppState = {
  connected: false,
  reconnectAttempt: 0,
  busy: false,
  queuedMessages: [],
  messages: [],
  currentTurnId: null,
  tasks: {},
  peekStatus: {},
  turnToolCallIds: [],
  taskPanelOpen: false,
  userClosedPanel: false,
  protoEntries: [],
  dirFilter: "all",
  textFilter: "",
  debugCollapsed: true,
  turnStatus: null,
  liveTurnStatus: {},
  startTime: Date.now(),
  // Session management
  diskSessions: [],
  diskSessionsLoaded: false,
  currentSessionId: null,
  switchingToSessionId: null,
  sessionHistory: {},
  // Slash commands
  commands: [],
};

// ── Reducer helpers ──

/** Get the current assistant turn from messages, or null. */
function getCurrentTurn(messages: ChatEntry[], turnId: string | null): MessageEntry | null {
  if (!turnId) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.type === "message" && m.id === turnId) return m;
  }
  return null;
}

/** Update the current turn's content in-place (immutably). */
function updateTurnContent(
  messages: ChatEntry[],
  turnId: string,
  updater: (content: ContentBlock[]) => ContentBlock[],
): ChatEntry[] {
  return messages.map((m) =>
    m.type === "message" && m.id === turnId
      ? { ...m, content: updater(m.content) }
      : m,
  );
}

/** Finalize any streaming blocks in the current turn (set _streaming: false). */
function finalizeStreaming(messages: ChatEntry[], turnId: string | null): ChatEntry[] {
  if (!turnId) return messages;
  return messages.map((m) => {
    if (m.type !== "message" || m.id !== turnId) return m;
    return {
      ...m,
      _streaming: false,
      content: m.content.map((b) => {
        if ((b.type === "text" || b.type === "thinking") && b._streaming) {
          return { ...b, _streaming: false };
        }
        return b;
      }),
    };
  });
}

/**
 * Mark pending tool_use blocks as completed.
 * Called when new content (text/thinking/tool) arrives — the model only produces
 * new content after a tool result, so any "pending" tool_use blocks are done.
 */
function completePendingTools(block: ContentBlock): ContentBlock {
  if (block.type === "tool_use" && block.status === "pending" && !block.isBackground) {
    return { ...block, status: "completed" };
  }
  return block;
}

/** Ensure an assistant turn exists, creating one if needed. Returns [messages, turnId]. */
function ensureAssistantTurn(
  messages: ChatEntry[],
  currentTurnId: string | null,
): [ChatEntry[], string] {
  if (currentTurnId && getCurrentTurn(messages, currentTurnId)) {
    return [messages, currentTurnId];
  }
  const newId = uid();
  const turn: MessageEntry = {
    type: "message",
    id: newId,
    role: "assistant",
    content: [],
    _streaming: true,
  };
  return [[...messages, turn], newId];
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "WS_CONNECTED":
      return { ...state, connected: true, reconnectAttempt: 0, busy: false, startTime: Date.now() };

    case "WS_DISCONNECTED":
      return { ...state, connected: false, busy: false, queuedMessages: [] };

    case "WS_RECONNECTING":
      return { ...state, reconnectAttempt: action.attempt };

    case "SET_BUSY":
      return { ...state, busy: action.busy };

    case "SEND_MESSAGE": {
      const content: ContentBlock[] = [];
      if (action.images?.length) {
        for (const img of action.images) {
          content.push({ type: "image", data: img.data, mimeType: img.mimeType });
        }
      }
      if (action.files?.length) {
        for (const file of action.files) {
          content.push({ type: "file", path: file.path, name: file.name } as FileBlock);
        }
      }
      if (action.text) {
        content.push({ type: "text", text: action.text });
      }
      const userTurn: MessageEntry = {
        type: "message",
        id: uid(),
        role: "user",
        content,
        _queueId: action.queueId,
      };
      return {
        ...state,
        busy: true,
        currentTurnId: null,
        turnStatus: null,
        messages: [...finalizeStreaming(state.messages, state.currentTurnId), userTurn],
      };
    }

    case "TEXT_CHUNK": {
      const [msgs, turnId] = ensureAssistantTurn(state.messages, state.currentTurnId);
      const turn = getCurrentTurn(msgs, turnId)!;
      const lastBlock = turn.content[turn.content.length - 1];

      if (lastBlock?.type === "text" && lastBlock._streaming) {
        // Append to existing streaming text block
        return {
          ...state,
          currentTurnId: turnId,
          messages: updateTurnContent(msgs, turnId, (content) =>
            content.map((b, i) =>
              i === content.length - 1 && b.type === "text"
                ? { ...b, text: b.text + action.text }
                : completePendingTools(b),
            ),
          ),
        };
      }

      // Finalize any previous streaming block, then add new text block
      return {
        ...state,
        currentTurnId: turnId,
        messages: updateTurnContent(msgs, turnId, (content) => [
          ...content.map((b) => {
            const c = completePendingTools(b);
            return (c.type === "text" || c.type === "thinking") && c._streaming
              ? { ...c, _streaming: false }
              : c;
          }),
          { type: "text" as const, text: action.text, _streaming: true },
        ]),
      };
    }

    case "THOUGHT_CHUNK": {
      const [msgs, turnId] = ensureAssistantTurn(state.messages, state.currentTurnId);
      const turn = getCurrentTurn(msgs, turnId)!;
      const lastBlock = turn.content[turn.content.length - 1];

      if (lastBlock?.type === "thinking" && lastBlock._streaming) {
        // Append to existing streaming thinking block
        return {
          ...state,
          currentTurnId: turnId,
          messages: updateTurnContent(msgs, turnId, (content) =>
            content.map((b, i) =>
              i === content.length - 1 && b.type === "thinking"
                ? { ...b, thinking: b.thinking + action.text }
                : completePendingTools(b),
            ),
          ),
        };
      }

      // Finalize any previous streaming block, then add new thinking block
      return {
        ...state,
        currentTurnId: turnId,
        messages: updateTurnContent(msgs, turnId, (content) => [
          ...content.map((b) => {
            const c = completePendingTools(b);
            return (c.type === "text" || c.type === "thinking") && c._streaming
              ? { ...c, _streaming: false }
              : c;
          }),
          { type: "thinking" as const, thinking: action.text, _streaming: true },
        ]),
      };
    }

    case "TOOL_CALL": {
      const isBg = action.meta?.claudeCode?.isBackground === true;
      const toolKind = classifyTool(action.meta);
      const newTask = {
        toolCallId: action.toolCallId,
        title: action.title || action.toolCallId,
        kind: action.kind || "tool",
        toolKind,
        toolName: action.meta?.claudeCode?.toolName || "",
        status: "running" as const,
        isBackground: isBg,
        startTime: Date.now(),
        endTime: null,
      };

      const parentId = action.meta?.claudeCode?.parentToolUseId;
      const newPeek = { ...state.peekStatus };
      if (parentId && state.tasks[parentId]?.isBackground) {
        newPeek[parentId] =
          action.title || action.meta?.claudeCode?.toolName || "Working...";
      }

      // Auto-open task panel for background tasks
      let taskPanelOpen = state.taskPanelOpen;
      if (isBg && !state.taskPanelOpen && !state.userClosedPanel) {
        taskPanelOpen = true;
      }

      const [msgs, turnId] = ensureAssistantTurn(state.messages, state.currentTurnId);
      const rawToolName = action.meta?.claudeCode?.toolName || action.kind || "tool";
      const toolBlock: ToolUseBlock = {
        type: "tool_use",
        id: action.toolCallId,
        name: prettyToolName(rawToolName),
        input: action.rawInput ?? {},
        title: action.title || action.toolCallId,
        kind: action.kind || "tool",
        status: "pending",
        startTime: Date.now(),
        isBackground: isBg || undefined,
      };

      return {
        ...state,
        currentTurnId: turnId,
        taskPanelOpen,
        tasks: { ...state.tasks, [action.toolCallId]: newTask },
        peekStatus: newPeek,
        turnToolCallIds: [...state.turnToolCallIds, action.toolCallId],
        messages: updateTurnContent(msgs, turnId, (content) => [
          // Finalize any streaming blocks and complete pending tools
          ...content.map((b) => {
            const c = completePendingTools(b);
            return (c.type === "text" || c.type === "thinking") && c._streaming
              ? { ...c, _streaming: false }
              : c;
          }),
          toolBlock,
        ]),
      };
    }

    case "TOOL_CALL_UPDATE": {
      const task = state.tasks[action.toolCallId];
      const updatedTasks = { ...state.tasks };
      const newPeek = { ...state.peekStatus };

      if (task) {
        const updated = { ...task };
        if (action.status === "completed" || action.status === "failed") {
          const isBgComplete = action.meta?.claudeCode?.backgroundComplete;
          if (!task.isBackground || action.status === "failed" || isBgComplete) {
            updated.status = action.status === "failed" ? "failed" : "completed";
            updated.endTime = Date.now();
          }
        }
        if (action.title) updated.title = action.title;
        if (task.isBackground && updated.status !== "running") {
          delete newPeek[action.toolCallId];
        }
        updatedTasks[action.toolCallId] = updated;
      }

      // Parent peek
      const updateParentId = action.meta?.claudeCode?.parentToolUseId;
      if (
        updateParentId &&
        state.tasks[updateParentId]?.isBackground &&
        state.tasks[updateParentId].status === "running"
      ) {
        if (action.status === "completed") {
          newPeek[updateParentId] = "Processing results...";
        }
      }

      // Update the tool_use block in whichever turn contains it
      const isBgComplete = action.meta?.claudeCode?.backgroundComplete === true;
      const newStatus =
        action.status === "completed"
          ? ("completed" as const)
          : action.status === "failed"
            ? ("failed" as const)
            : undefined;

      return {
        ...state,
        tasks: updatedTasks,
        peekStatus: newPeek,
        messages: state.messages.map((m) => {
          if (m.type !== "message" || m.role !== "assistant") return m;
          const hasBlock = m.content.some(
            (b) => b.type === "tool_use" && b.id === action.toolCallId,
          );
          if (!hasBlock) return m;
          return {
            ...m,
            content: m.content.map((b) => {
              if (b.type !== "tool_use" || b.id !== action.toolCallId) return b;

              // For background tasks, don't mark completed until backgroundComplete arrives
              let effectiveStatus: typeof newStatus;
              if (b.isBackground && newStatus === "completed" && !isBgComplete) {
                effectiveStatus = undefined; // keep current status (pending = still running)
              } else {
                effectiveStatus = newStatus;
              }

              const updated = {
                ...b,
                status: effectiveStatus ?? b.status,
                title: action.title || b.title,
                result: action.content || b.result,
                // Merge rawInput and kind when the complete assistant message arrives
                ...(action.rawInput != null && { input: action.rawInput }),
                ...(action.kind && { kind: action.kind }),
                // Set endTime when actually completed/failed
                ...((effectiveStatus === "completed" || effectiveStatus === "failed") && {
                  endTime: Date.now(),
                }),
              };
              // Link Task tool calls to their sub-agent session
              if (b.name === "Task" && action.content) {
                updated.agentId = extractAgentId(action.content) ?? b.agentId;
              }
              return updated;
            }),
          };
        }),
      };
    }

    case "PLAN":
      return {
        ...state,
        messages: [
          ...finalizeStreaming(state.messages, state.currentTurnId),
          { type: "plan", id: uid(), entries: action.entries },
        ],
        currentTurnId: null,
      };

    case "PERMISSION":
      return {
        ...state,
        messages: [
          ...finalizeStreaming(state.messages, state.currentTurnId),
          { type: "permission", id: uid(), title: action.title },
        ],
        currentTurnId: null,
      };

    case "SESSION_INFO":
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            type: "system",
            id: uid(),
            text:
              "Session " +
              action.sessionId.slice(0, 8) +
              "... | Models: " +
              action.models.join(", ") +
              " | Modes: " +
              action.modes.map((m) => m.id).join(", "),
          },
        ],
      };

    case "SYSTEM": {
      // Hide hook and system init metadata — not useful in the chat UI
      if (/^\[Hook |^\[System initialized:/.test(action.text)) return state;
      // Deduplicate: skip if the same system text was already shown in this session
      const isDupe = state.messages.some(
        (m) => m.type === "system" && m.text === action.text,
      );
      if (isDupe) return state;
      return {
        ...state,
        messages: [
          ...finalizeStreaming(state.messages, state.currentTurnId),
          { type: "system", id: uid(), text: action.text },
        ],
        currentTurnId: null,
      };
    }

    case "TURN_START": {
      const ts: TurnStatus = {
        status: "in_progress",
        startedAt: action.startedAt,
        approxTokens: 0,
        thinkingDurationMs: 0,
        activity: "brewing",
      };
      return {
        ...state,
        turnStatus: ts,
        liveTurnStatus: state.currentSessionId
          ? { ...state.liveTurnStatus, [state.currentSessionId]: ts }
          : state.liveTurnStatus,
      };
    }

    case "TURN_ACTIVITY": {
      if (!state.turnStatus || state.turnStatus.status !== "in_progress") return state;
      const ts: TurnStatus = {
        ...state.turnStatus,
        activity: action.activity,
        activityDetail: action.detail,
        ...(action.approxTokens != null && { approxTokens: action.approxTokens }),
        ...(action.thinkingDurationMs != null && { thinkingDurationMs: action.thinkingDurationMs }),
      };
      return {
        ...state,
        turnStatus: ts,
        liveTurnStatus: state.currentSessionId
          ? { ...state.liveTurnStatus, [state.currentSessionId]: ts }
          : state.liveTurnStatus,
      };
    }

    case "TURN_END": {
      const updatedTasks = { ...state.tasks };
      for (const id of state.turnToolCallIds) {
        const task = updatedTasks[id];
        if (task && task.status === "running") {
          updatedTasks[id] = { ...task, isBackground: true };
        }
      }

      // Auto-open panel if there are new background tasks
      const bgRunning = Object.values(updatedTasks).some(
        (t) => t.isBackground && t.status === "running",
      );
      let taskPanelOpen = state.taskPanelOpen;
      if (bgRunning && !state.taskPanelOpen && !state.userClosedPanel) {
        taskPanelOpen = true;
      }

      // Build completed turn status from server-provided stats
      const completedStatus: TurnStatus | null = action.durationMs != null
        ? {
            status: "completed",
            startedAt: state.turnStatus?.startedAt ?? Date.now(),
            endedAt: Date.now(),
            durationMs: action.durationMs,
            outputTokens: action.outputTokens,
            thinkingDurationMs: action.thinkingDurationMs,
            costUsd: action.costUsd,
            approxTokens: state.turnStatus?.approxTokens,
          }
        : state.turnStatus
          ? { ...state.turnStatus, status: "completed", endedAt: Date.now(), durationMs: Date.now() - state.turnStatus.startedAt }
          : null;

      return {
        ...state,
        // Stay busy if there are queued messages (server will auto-drain next)
        busy: state.queuedMessages.length > 0,
        currentTurnId: null,
        turnToolCallIds: [],
        tasks: updatedTasks,
        taskPanelOpen,
        turnStatus: completedStatus,
        liveTurnStatus: state.currentSessionId
          ? (() => {
              const next = { ...state.liveTurnStatus };
              delete next[state.currentSessionId!];
              return next;
            })()
          : state.liveTurnStatus,
        messages: finalizeStreaming(state.messages, state.currentTurnId),
      };
    }

    case "ERROR":
      return {
        ...state,
        busy: false,
        messages: [
          ...state.messages,
          { type: "system", id: uid(), text: action.text, isError: true },
        ],
      };

    case "PROTOCOL": {
      const msg = action.msg as any;
      const method =
        msg.method ||
        (msg.result !== undefined ? "result" : msg.error ? "error" : "?");
      const msgId = msg.id !== undefined ? "#" + msg.id : "";
      return {
        ...state,
        protoEntries: [
          ...state.protoEntries,
          {
            id: uid(),
            dir: action.dir,
            ts: action.ts,
            msg: action.msg,
            method,
            msgId,
          },
        ],
      };
    }

    case "SET_DIR_FILTER":
      return { ...state, dirFilter: action.filter };

    case "SET_TEXT_FILTER":
      return { ...state, textFilter: action.filter };

    case "TOGGLE_DEBUG_COLLAPSE":
      return { ...state, debugCollapsed: !state.debugCollapsed };

    case "TOGGLE_TASK_PANEL": {
      const opening = !state.taskPanelOpen;
      return {
        ...state,
        taskPanelOpen: opening,
        userClosedPanel: !opening ? true : state.userClosedPanel,
      };
    }

    // ── Session management actions ────────────

    case "SESSIONS": {
      // Seed liveTurnStatus from server-provided turn data on each session
      const lts = { ...state.liveTurnStatus };
      for (const s of action.sessions) {
        if (s.turnStatus === "in_progress" && s.turnStartedAt) {
          // Don't overwrite real-time updates for the current session
          if (s.sessionId !== state.currentSessionId || !lts[s.sessionId]) {
            lts[s.sessionId] = {
              status: "in_progress",
              startedAt: s.turnStartedAt,
              activity: s.turnActivity ?? "brewing",
              activityDetail: s.turnActivityDetail,
            };
          }
        } else {
          // Session no longer in progress — clean up stale entry
          delete lts[s.sessionId];
        }
      }
      return { ...state, diskSessions: action.sessions, diskSessionsLoaded: true, liveTurnStatus: lts };
    }

    case "SESSION_HISTORY": {
      const t0 = performance.now();
      const historyMessages = jsonlToEntries(action.entries);
      console.log(`[${pageMs()}] reducer SESSION_HISTORY ${action.sessionId.slice(0, 8)} parse=${(performance.now() - t0).toFixed(0)}ms raw=${action.entries.length} parsed=${historyMessages.length}`);
      return {
        ...state,
        sessionHistory: {
          ...state.sessionHistory,
          [action.sessionId]: {
            messages: historyMessages,
            tasks: {},
            currentTurnId: null,
            turnToolCallIds: [],
            turnStatus: null,
            queuedMessages: [],
          },
        },
      };
    }

    case "SESSION_SWITCH_PENDING":
      return { ...state, switchingToSessionId: action.sessionId };

    case "SESSION_SWITCHED": {
      // Use freshly received history (SESSION_HISTORY arrived just before this)
      // No save-on-switch: server is authoritative, stale client cache would cause issues
      const cleanHistory = { ...state.sessionHistory };
      console.log(`[${pageMs()}] reducer SESSION_SWITCHED from=${state.currentSessionId?.slice(0, 8) ?? "null"} to=${action.sessionId.slice(0, 8)} historyMsgs=${cleanHistory[action.sessionId]?.messages?.length ?? 0} currentMsgs=${state.messages.length}`);

      // Restore target session state from freshly received history or use empty defaults
      const restored = cleanHistory[action.sessionId] ?? emptySnapshot;

      // Clear consumed entry to prevent stale reuse on future switches
      delete cleanHistory[action.sessionId];

      return {
        ...state,
        currentSessionId: action.sessionId,
        switchingToSessionId: null,
        sessionHistory: cleanHistory,
        messages: restored.messages,
        tasks: restored.tasks,
        // protoEntries are global debug traffic — keep them across session switches
        currentTurnId: null,
        turnToolCallIds: restored.turnToolCallIds,
        turnStatus: restored.turnStatus,
        busy: restored.queuedMessages.length > 0,
        queuedMessages: restored.queuedMessages,
        peekStatus: {},
      };
    }

    case "SESSION_TITLE_UPDATE":
      return {
        ...state,
        diskSessions: state.diskSessions.map((s) =>
          s.sessionId === action.sessionId ? { ...s, title: action.title } : s,
        ),
      };

    // ── Queue management actions ────────────
    case "MESSAGE_QUEUED":
      return {
        ...state,
        queuedMessages: [...state.queuedMessages, action.queueId],
      };

    case "QUEUE_DRAIN_START":
      return {
        ...state,
        busy: true,
        queuedMessages: state.queuedMessages.filter((id) => id !== action.queueId),
      };

    case "QUEUE_CANCELLED":
      return {
        ...state,
        queuedMessages: state.queuedMessages.filter((id) => id !== action.queueId),
        messages: state.messages.filter(
          (m) => !(m.type === "message" && m.role === "user" && (m as MessageEntry)._queueId === action.queueId),
        ),
      };

    case "COMMANDS":
      return { ...state, commands: action.commands };

    case "SESSION_SUBAGENTS": {
      return {
        ...state,
        diskSessions: state.diskSessions.map((s) => {
          if (s.sessionId !== action.sessionId) return s;
          // Merge loaded subagent children with existing teammate children
          const existingTeammates = (s.children ?? []).filter((c: any) => !!c.sessionId);
          return { ...s, children: [...existingTeammates, ...action.children] };
        }),
      };
    }

    default:
      return state;
  }
}

// ── Split contexts: Actions (stable) + State (changes frequently) ──
// Components that only need actions won't re-render when state changes.

export interface WsActions {
  dispatch: React.Dispatch<Action>;
  send: (text: string, images?: ImageAttachment[], files?: FileAttachment[]) => void;
  interrupt: () => void;
  newSession: () => void;
  resumeSession: (sessionId: string) => void;
  resumeSubagent: (parentSessionId: string, agentId: string) => void;
  deleteSession: (sessionId: string) => void;
  renameSession: (sessionId: string, title: string) => void;
  cancelQueued: (queueId: string) => void;
  searchFiles: (query: string, callback: (files: string[]) => void) => void;
  requestCommands: () => void;
  requestSubagents: (sessionId: string) => void;
}

interface WsContextValue {
  state: AppState;
  dispatch: React.Dispatch<Action>;
  send: (text: string, images?: ImageAttachment[], files?: FileAttachment[]) => void;
  interrupt: () => void;
  newSession: () => void;
  resumeSession: (sessionId: string) => void;
  resumeSubagent: (parentSessionId: string, agentId: string) => void;
  deleteSession: (sessionId: string) => void;
  renameSession: (sessionId: string, title: string) => void;
  cancelQueued: (queueId: string) => void;
  searchFiles: (query: string, callback: (files: string[]) => void) => void;
  requestCommands: () => void;
  requestSubagents: (sessionId: string) => void;
}

const WsActionsContext = createContext<WsActions | null>(null);
const WsStateContext = createContext<AppState>(initialState);

/** Access stable action callbacks — never re-renders from state changes. */
export function useWsActions(): WsActions {
  const ctx = useContext(WsActionsContext);
  if (!ctx) throw new Error("useWsActions must be used within WebSocketProvider");
  return ctx;
}

/** Access full app state — re-renders on every state change. */
export function useWsState(): AppState {
  return useContext(WsStateContext);
}

/** Combined hook (backward compat) — subscribes to both contexts. */
export function useWs(): WsContextValue {
  const actions = useWsActions();
  const state = useWsState();
  return { state, ...actions };
}

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const wsRef = useRef<WebSocket | null>(null);

  // ── Hash routing refs ──
  /** The hash captured at mount time, before any WS events. */
  const pendingHashRestore = useRef(parseSessionHash());
  /** True once the initial hash restore logic has been handled. */
  const hashInitialized = useRef(false);
  /** When true, the next hash sync will use replaceState instead of pushState. */
  const skipNextPush = useRef(false);
  /** Tracks currentSessionId for the popstate handler without stale closures. */
  const currentSessionRef = useRef<string | null>(null);
  currentSessionRef.current = state.currentSessionId;
  /** Tracks sessions that we've already requested history for (to avoid duplicate requests). */
  const historyRequestedFor = useRef(new Set<string>());

  const send = useCallback((text: string, images?: ImageAttachment[], files?: FileAttachment[]) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const queueId = `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dispatch({ type: "SEND_MESSAGE", text, images, files, queueId });
    wsRef.current.send(
      JSON.stringify({
        type: "prompt",
        text,
        queueId,
        ...(images?.length ? { images } : {}),
        ...(files?.length ? { files } : {}),
      }),
    );
  }, []);

  const interrupt = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "interrupt" }));
  }, []);

  const newSession = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "new_session" }));
  }, []);

  const resumeSessionCb = useCallback((sessionId: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    console.log(`[${pageMs()}] switch requesting ${sessionId.slice(0, 8)}`);
    (window as any).__switchStart = performance.now();
    dispatch({ type: "SESSION_SWITCH_PENDING", sessionId });
    wsRef.current.send(JSON.stringify({ type: "switch_session", sessionId }));
  }, []);

  const resumeSubagentCb = useCallback((parentSessionId: string, agentId: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    console.log(`[${pageMs()}] switch requesting subagent ${parentSessionId.slice(0, 8)}:${agentId}`);
    (window as any).__switchStart = performance.now();
    dispatch({ type: "SESSION_SWITCH_PENDING", sessionId: `${parentSessionId}:subagent:${agentId}` });
    wsRef.current.send(JSON.stringify({ type: "resume_subagent", parentSessionId, agentId }));
  }, []);

  const deleteSessionCb = useCallback((sessionId: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.warn(`[${pageMs()}] deleteSession: WS not connected`);
      return;
    }
    console.log(`[${pageMs()}] deleteSession ${sessionId.slice(0, 8)}`);
    wsRef.current.send(JSON.stringify({ type: "delete_session", sessionId }));
  }, []);

  const renameSessionCb = useCallback((sessionId: string, title: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "rename_session", sessionId, title }));
  }, []);

  const cancelQueued = useCallback((queueId: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "cancel_queued", queueId }));
  }, []);

  const requestCommands = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "get_commands" }));
  }, []);

  const requestSubagents = useCallback((sessionId: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "get_subagents", sessionId }));
  }, []);

  const fileSearchCallbacks = useRef<Map<string, (files: string[]) => void>>(new Map());

  const searchFiles = useCallback((query: string, callback: (files: string[]) => void) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    fileSearchCallbacks.current.set(query, callback);
    wsRef.current.send(JSON.stringify({ type: "list_files", query }));
  }, []);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let connectTimeout: ReturnType<typeof setTimeout>;
    let retryCount = 0;

    /**
     * Exponential backoff with jitter, capped at 15 seconds.
     * Formula: min(base * 2^attempt * (1 + random * 0.3), maxDelay)
     * Attempt 0: ~200ms, 1: ~400ms, 2: ~800ms, 3: ~1.6s, 4: ~3.2s, 5: ~6.4s, 6: ~12.8s, 7+: 15s
     */
    function backoffDelay(attempt: number): number {
      const base = 200;
      const max = 15_000;
      const exponential = base * Math.pow(2, attempt);
      const jitter = 1 + Math.random() * 0.3; // 1.0–1.3x multiplier
      return Math.min(exponential * jitter, max);
    }

    /** Schedule a reconnect with exponential backoff. */
    function scheduleReconnect() {
      if (disposed) return;
      const delay = backoffDelay(retryCount);
      console.log(
        `[${pageMs()}] ws scheduling reconnect #${retryCount} in ${delay.toFixed(0)}ms`,
      );
      dispatch({ type: "WS_RECONNECTING", attempt: retryCount });
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, delay);
    }

    function connect() {
      const connectT0 = performance.now();
      if (disposed) {
        console.log(`[${pageMs()}] ws connect() called but disposed, skipping`);
        return;
      }

      // If the browser reports offline, skip the attempt — the `online` event will retry.
      if (!navigator.onLine) {
        console.log(`[${pageMs()}] ws connect() skipped: browser offline`);
        dispatch({ type: "WS_RECONNECTING", attempt: retryCount });
        return;
      }

      // Close any previous WebSocket to free the browser connection slot.
      const prev = wsRef.current;
      if (prev) {
        const readyStates = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
        console.log(`[${pageMs()}] ws closing previous (readyState=${readyStates[prev.readyState]})`);
        prev.onopen = null;
        prev.onclose = null;
        prev.onmessage = null;
        prev.onerror = null;
        if (prev.readyState === WebSocket.CONNECTING || prev.readyState === WebSocket.OPEN) {
          prev.close();
        }
        wsRef.current = null;
      }

      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      // In dev mode, bypass Vite's proxy and connect directly to the backend.
      // Use 127.0.0.1 instead of localhost to skip IPv6 (::1) resolution fallback
      // which adds hundreds of ms on some systems.
      const wsHost = location.port === "5688" ? "127.0.0.1:5689" : location.host;
      const wsUrl = `${proto}//${wsHost}/ws`;
      console.log(`[${pageMs()}] ws new WebSocket(${wsUrl}) retry=${retryCount}`);
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      historyRequestedFor.current.clear();
      pendingHashRestore.current = parseSessionHash();
      hashInitialized.current = false;

      // Connection timeout: 5s safety net (increased from 1s to handle slow reconnects).
      clearTimeout(connectTimeout);
      connectTimeout = setTimeout(() => {
        if (ws.readyState === WebSocket.CONNECTING) {
          console.warn(`[${pageMs()}] ws timeout (5s), retry=${retryCount}`);
          ws.onopen = null;
          ws.onclose = null;
          ws.onmessage = null;
          ws.onerror = null;
          ws.close();
          wsRef.current = null;
          if (!disposed) {
            retryCount++;
            scheduleReconnect();
          }
        }
      }, 5000);

      ws.onopen = () => {
        clearTimeout(connectTimeout);
        retryCount = 0;
        console.log(`[${pageMs()}] ws OPEN (handshake=${(performance.now() - connectT0).toFixed(0)}ms)`);
        if (!disposed) dispatch({ type: "WS_CONNECTED" });
      };
      ws.onclose = (ev) => {
        clearTimeout(connectTimeout);
        console.log(`[${pageMs()}] ws CLOSED code=${ev.code} disposed=${disposed}`);
        if (!disposed) {
          dispatch({ type: "WS_DISCONNECTED" });
          retryCount++;
          scheduleReconnect();
        }
      };
      ws.onerror = () => {
        console.error(`[${pageMs()}] ws ERROR`);
      };

      let firstMsgLogged = false;
      ws.onmessage = (ev) => {
        if (!firstMsgLogged) {
          firstMsgLogged = true;
          console.log(`[${pageMs()}] ws first message (sinceConnect=${(performance.now() - connectT0).toFixed(0)}ms)`);
        }
        const msg = JSON.parse(ev.data);
        if (msg.type === "file_list") {
          const cb = fileSearchCallbacks.current.get(msg.query ?? "");
          if (cb) {
            fileSearchCallbacks.current.delete(msg.query ?? "");
            cb(msg.files ?? []);
          }
          return;
        }
        handleMsg(msg, dispatch);
      };
    }

    // ── Network state listeners ──
    // Immediately retry when the browser comes back online (resets backoff).
    function onOnline() {
      console.log(`[${pageMs()}] network: online`);
      if (disposed) return;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        clearTimeout(reconnectTimer);
        retryCount = 0; // Reset backoff — network just recovered
        connect();
      }
    }

    function onOffline() {
      console.log(`[${pageMs()}] network: offline`);
      // Don't proactively close — the WebSocket may still work on LAN.
      // The onclose handler will fire if the connection actually drops.
    }

    // ── Visibility change listener ──
    // When the tab becomes visible after being hidden, check if the WS is still
    // alive. Stale connections (laptop sleep, NAT timeout) may not fire onclose
    // until the next write, so this catches them early.
    function onVisibilityChange() {
      if (document.visibilityState !== "visible" || disposed) return;
      const ws = wsRef.current;
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        console.log(`[${pageMs()}] visibility: tab visible, ws not connected, reconnecting`);
        clearTimeout(reconnectTimer);
        retryCount = 0; // Fresh start after tab switch
        connect();
      }
    }

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisibilityChange);

    console.log(`[${pageMs()}] ws useEffect mount`);
    connect();
    return () => {
      console.log(`[${pageMs()}] ws useEffect cleanup`);
      disposed = true;
      clearTimeout(reconnectTimer);
      clearTimeout(connectTimeout);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      const ws = wsRef.current;
      if (ws) {
        ws.onopen = null;
        ws.onclose = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.close();
        wsRef.current = null;
      }
    };
  }, []);

  // ── Memoize actions context (stable — callbacks never change) ──
  const actions = useMemo<WsActions>(
    () => ({
      dispatch,
      send,
      interrupt,
      newSession,
      resumeSession: resumeSessionCb,
      resumeSubagent: resumeSubagentCb,
      deleteSession: deleteSessionCb,
      renameSession: renameSessionCb,
      cancelQueued,
      searchFiles,
      requestCommands,
      requestSubagents,
    }),
    // All deps are useCallback([]) or useReducer dispatch — stable references
    [dispatch, send, interrupt, newSession, resumeSessionCb, resumeSubagentCb, deleteSessionCb, renameSessionCb, cancelQueued, searchFiles, requestCommands, requestSubagents],
  );

  // ── Hash-based URL routing ──

  // Sync URL hash with current session, and handle initial restore from hash
  useEffect(() => {
    if (!state.currentSessionId) return;

    // Phase 1: On first session switch after connect, check if we need to
    // restore from the URL hash instead of the auto-created session.
    if (!hashInitialized.current) {
      if (!state.connected) return;

      const restore = pendingHashRestore.current;
      pendingHashRestore.current = null;
      hashInitialized.current = true;

      if (restore && restore.sessionId !== state.currentSessionId) {
        // Switch to the session from the URL hash
        skipNextPush.current = true;
        if (restore.agentId && restore.parentId) {
          resumeSubagentCb(restore.parentId, restore.agentId);
        } else {
          resumeSessionCb(restore.sessionId);
        }
        return;
      }

      // No restore needed — set hash for the auto-created session
      history.replaceState(null, "", sessionIdToHash(state.currentSessionId));
      return;
    }

    // Phase 2: Normal hash sync
    const hash = sessionIdToHash(state.currentSessionId);
    if (window.location.hash === hash) return;

    if (skipNextPush.current) {
      skipNextPush.current = false;
      history.replaceState(null, "", hash);
    } else {
      history.pushState(null, "", hash);
    }
  }, [state.currentSessionId, state.connected, resumeSessionCb, resumeSubagentCb]);

  // Handle browser back/forward navigation
  useEffect(() => {
    function onPopState() {
      const parsed = parseSessionHash();
      if (!parsed || parsed.sessionId === currentSessionRef.current) return;

      skipNextPush.current = true;
      if (parsed.agentId && parsed.parentId) {
        resumeSubagentCb(parsed.parentId, parsed.agentId);
      } else {
        resumeSessionCb(parsed.sessionId);
      }
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [resumeSessionCb, resumeSubagentCb]);

  // ── Fallback: ensure session content is loaded ──
  // If we have a current session and are connected but messages is empty,
  // explicitly request the session history after a short delay.
  // This handles all race conditions (StrictMode double-mount, server push
  // failing, etc.) by pulling data from the client side.
  useEffect(() => {
    if (!state.currentSessionId || !state.connected) return;
    if (state.messages.length > 0) return;
    if (historyRequestedFor.current.has(state.currentSessionId)) return;

    const sessionId = state.currentSessionId;
    const timer = setTimeout(() => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      historyRequestedFor.current.add(sessionId);
      console.log(`[${pageMs()}] fallback requesting history for ${sessionId.slice(0, 8)}`);
      const sub = sessionId.match(/^(.+):subagent:(.+)$/);
      if (sub) {
        ws.send(JSON.stringify({ type: "resume_subagent", parentSessionId: sub[1], agentId: sub[2] }));
      } else {
        ws.send(JSON.stringify({ type: "switch_session", sessionId }));
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [state.currentSessionId, state.connected, state.messages.length]);

  return (
    <WsActionsContext.Provider value={actions}>
      <WsStateContext.Provider value={state}>
        {children}
      </WsStateContext.Provider>
    </WsActionsContext.Provider>
  );
}

function handleMsg(msg: any, dispatch: React.Dispatch<Action>) {
  switch (msg.type) {
    case "protocol":
      dispatch({ type: "PROTOCOL", dir: msg.dir, ts: msg.ts, msg: msg.msg });
      break;
    case "text":
      if (msg.text) dispatch({ type: "TEXT_CHUNK", text: msg.text });
      break;
    case "thought":
      dispatch({ type: "THOUGHT_CHUNK", text: msg.text });
      break;
    case "tool_call": {
      const content = (msg.content || [])
        .filter((c: any) => c.content?.text)
        .map((c: any) => c.content.text)
        .join("\n");
      dispatch({
        type: "TOOL_CALL",
        toolCallId: msg.toolCallId,
        kind: msg.kind || "tool",
        title: msg.title || msg.toolCallId,
        content,
        rawInput: msg.rawInput,
        meta: msg._meta,
      });
      break;
    }
    case "tool_call_update": {
      const content = msg.content
        ? msg.content
            .filter((c: any) => c.content?.text)
            .map((c: any) => c.content.text)
            .join("\n")
        : undefined;
      dispatch({
        type: "TOOL_CALL_UPDATE",
        toolCallId: msg.toolCallId,
        status: msg.status,
        title: msg.title,
        kind: msg.kind,
        content,
        rawInput: msg.rawInput,
        meta: msg._meta,
      });
      break;
    }
    case "plan":
      dispatch({ type: "PLAN", entries: msg.entries });
      break;
    case "permission":
      dispatch({ type: "PERMISSION", title: msg.title });
      break;
    case "session_info":
      dispatch({
        type: "SESSION_INFO",
        sessionId: msg.sessionId,
        models: msg.models,
        modes: msg.modes,
      });
      break;
    case "system":
      dispatch({ type: "SYSTEM", text: msg.text });
      break;
    case "turn_start":
      dispatch({ type: "TURN_START", startedAt: msg.startedAt ?? Date.now() });
      break;
    case "turn_content_replay":
      // Replay buffered turn content for mid-turn joins (tmux-style attach)
      for (const m of msg.messages ?? []) {
        handleMsg(m, dispatch);
      }
      break;
    case "turn_activity":
      dispatch({ type: "TURN_ACTIVITY", activity: msg.activity, detail: msg.detail, approxTokens: msg.approxTokens, thinkingDurationMs: msg.thinkingDurationMs });
      break;
    case "turn_end":
      dispatch({
        type: "TURN_END",
        durationMs: msg.durationMs,
        outputTokens: msg.outputTokens,
        thinkingDurationMs: msg.thinkingDurationMs,
        costUsd: msg.costUsd,
      });
      break;
    case "error":
      dispatch({ type: "ERROR", text: msg.text });
      break;
    // Session management messages
    case "sessions":
      dispatch({ type: "SESSIONS", sessions: msg.sessions });
      break;
    case "session_history": {
      const entryCount = msg.entries?.length ?? 0;
      console.log(`[${pageMs()}] handleMsg session_history entries=${entryCount} session=${msg.sessionId?.slice(0, 8)}`);
      dispatch({ type: "SESSION_HISTORY", sessionId: msg.sessionId, entries: msg.entries ?? [] });
      break;
    }
    case "session_switched":
      {
        const elapsed = (window as any).__switchStart ? (performance.now() - (window as any).__switchStart).toFixed(0) : "?";
        console.log(`[${pageMs()}] handleMsg session_switched ${msg.sessionId.slice(0, 8)} switchE2E=${elapsed}ms`);
      }
      dispatch({ type: "SESSION_SWITCHED", sessionId: msg.sessionId });
      break;
    case "session_title_update":
      dispatch({ type: "SESSION_TITLE_UPDATE", sessionId: msg.sessionId, title: msg.title });
      break;
    // User message from another client viewing the same session
    case "user_message":
      dispatch({ type: "SEND_MESSAGE", text: msg.text, images: msg.images, files: msg.files, queueId: msg.queueId });
      break;
    // Queue messages
    case "message_queued":
      dispatch({ type: "MESSAGE_QUEUED", queueId: msg.queueId });
      break;
    case "queue_drain_start":
      dispatch({ type: "QUEUE_DRAIN_START", queueId: msg.queueId });
      break;
    case "queue_cancelled":
      dispatch({ type: "QUEUE_CANCELLED", queueId: msg.queueId });
      break;
    case "commands":
      dispatch({ type: "COMMANDS", commands: msg.commands ?? [] });
      break;
    case "session_subagents":
      dispatch({ type: "SESSION_SUBAGENTS", sessionId: msg.sessionId, children: msg.children ?? [] });
      break;
  }
}
