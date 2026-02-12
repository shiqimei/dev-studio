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
  PlanEntryItem,
  TaskItemEntry,
  SubagentChild,
  SubagentType,
  KanbanOp,
  ExecutorType,
} from "../types";
import { classifyTool } from "../utils";
import { isSystemPrompt } from "../kanban-prompts";
import { jsonlToEntries, prettyToolName, extractAgentId } from "../jsonl-convert";

/** Map raw subagent_type string to our SubagentType enum. */
function normalizeSubagentType(raw: string): SubagentType {
  switch (raw.toLowerCase()) {
    case "explore": return "explore";
    case "plan": return "plan";
    case "bash": return "bash";
    case "general-purpose": return "code";
    default: return "agent";
  }
}

/** Extract SubagentChild[] from parsed chat messages by scanning Task tool_use blocks. */
function extractSubagentChildrenFromMessages(messages: ChatEntry[]): SubagentChild[] {
  const children: SubagentChild[] = [];
  const seen = new Set<string>();
  for (const entry of messages) {
    if (entry.type !== "message" || entry.role !== "assistant") continue;
    for (const block of entry.content) {
      if (block.type !== "tool_use" || block.name !== "Task") continue;
      // Try agentId already linked by mergeToolResults, or extract from result text as fallback
      const agentId = block.agentId || (block.result ? extractAgentId(block.result) : undefined);
      if (!agentId) continue;
      if (seen.has(agentId)) continue;
      seen.add(agentId);
      const inp = block.input as Record<string, unknown> | null;
      children.push({
        agentId,
        taskPrompt: block.title || String(inp?.description ?? "Sub-agent"),
        timestamp: new Date().toISOString(),
        agentType: normalizeSubagentType(String(inp?.subagent_type ?? "")),
      });
    }
  }
  return children;
}

/** High-resolution timestamp since page navigation start (ms). */
function pageMs(): string {
  return performance.now().toFixed(0) + "ms";
}

// ── localStorage helpers for selected session persistence ──
const SELECTED_SESSION_KEY = "acp:selectedSession";

function saveSelectedSession(sessionId: string | null) {
  if (sessionId) {
    localStorage.setItem(SELECTED_SESSION_KEY, sessionId);
  } else {
    localStorage.removeItem(SELECTED_SESSION_KEY);
  }
}

function loadSelectedSession(): string | null {
  return localStorage.getItem(SELECTED_SESSION_KEY);
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

/**
 * Sessions whose titles should not be auto-updated by the SDK.
 * Used by the kanban board to prevent retry prompts from polluting card titles.
 * When a session is in this set, incoming `session_title_update` messages are dropped.
 */
export const titleLockedSessions = new Set<string>();

const emptySnapshot: SessionSnapshot = {
  messages: [],
  tasks: {},
  currentTurnId: null,
  turnToolCallIds: [],
  turnStatus: null,
  queuedMessages: [],
  pendingQueuedEntries: [],
  latestPlan: null,
  latestTasks: null,
};

const initialState: AppState = {
  connected: false,
  reconnectAttempt: 0,
  busy: false,
  queuedMessages: [],
  pendingQueuedEntries: [],
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
  // Session metadata
  models: [],
  currentModel: null,
  // Slash commands
  commands: [],
  _recentlyDeletedIds: [],

  latestPlan: null,
  latestTasks: null,
  unreadCompletedSessions: {},
  // Kanban persistence
  kanbanColumnOverrides: {},
  kanbanSortOrders: {},
  kanbanPendingPrompts: {},
  kanbanVersion: 0,
  kanbanPendingOps: [],
  kanbanStateLoaded: false,

  // Executor selection
  availableExecutors: ["claude"],
  selectedExecutor: "claude",

  // Project tabs
  projects: [],
  activeProject: null,
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

/** Extract the latest plan entries from a message list (last PlanEntry, if any). */
function extractLatestPlan(messages: ChatEntry[]): PlanEntryItem[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type === "plan") return (messages[i] as any).entries;
  }
  return null;
}

/** Find the index of the last non-meta user message (turn boundary). Returns -1 if none. */
function findLastUserMessageIndex(messages: ChatEntry[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.type === "message" && m.role === "user") return i;
  }
  return -1;
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

    case "WS_DISCONNECTED": {
      // Mark any in-progress sessions as interrupted so the kanban board
      // shows an explicit stop reason instead of silently dropping them.
      const disconnectedLts = { ...state.liveTurnStatus };
      for (const [sid, ts] of Object.entries(disconnectedLts)) {
        if (ts.status === "in_progress") {
          disconnectedLts[sid] = {
            ...ts,
            status: "error",
            endedAt: Date.now(),
            durationMs: Date.now() - ts.startedAt,
            stopReason: "disconnected",
          };
        }
      }
      return { ...state, connected: false, busy: false, queuedMessages: [], pendingQueuedEntries: [], kanbanStateLoaded: false, turnStatus: state.turnStatus?.status === "in_progress" ? { ...state.turnStatus, status: "error", endedAt: Date.now(), durationMs: Date.now() - state.turnStatus.startedAt, stopReason: "disconnected" } : state.turnStatus, liveTurnStatus: disconnectedLts };
    }

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

      // When the session is already busy, the message will be queued server-side.
      // Don't add it to messages[] yet — hold it in pendingQueuedEntries and
      // preserve the current turnStatus so the running bar stays visible.
      if (state.turnStatus?.status === "in_progress") {
        return {
          ...state,
          busy: true,
          queuedMessages: action.queueId
            ? [...state.queuedMessages, action.queueId]
            : state.queuedMessages,
          pendingQueuedEntries: [...state.pendingQueuedEntries, userTurn],
        };
      }

      // Not busy — optimistic: show the message immediately and start a new turn.
      // Set a preliminary turnStatus so the running bar appears instantly
      // (before TURN_START arrives from the server).
      const preliminaryTs: TurnStatus = {
        status: "in_progress",
        startedAt: Date.now(),
        activity: "brewing",
        approxTokens: 0,
        thinkingDurationMs: 0,
      };
      return {
        ...state,
        busy: true,
        currentTurnId: null,
        turnStatus: preliminaryTs,
        liveTurnStatus: !action.skipLiveTurnStatus && state.currentSessionId
          ? { ...state.liveTurnStatus, [state.currentSessionId]: preliminaryTs }
          : state.liveTurnStatus,
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

      // Detect Task tool getting its agentId — add to sidebar tree immediately
      let newSubagentChild: SubagentChild | null = null;
      if (state.currentSessionId && action.content && action.meta?.claudeCode?.toolName === "Task") {
        const agentId = extractAgentId(action.content);
        if (agentId) {
          const rawType = String(action.meta?.claudeCode?.subagentType ?? "");
          newSubagentChild = {
            agentId,
            taskPrompt: action.title || "Sub-agent",
            timestamp: new Date().toISOString(),
            agentType: normalizeSubagentType(rawType),
          };
        }
      }

      const updatedMessages = state.messages.map((m) => {
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
        });

      return {
        ...state,
        tasks: updatedTasks,
        peekStatus: newPeek,
        messages: updatedMessages,
        // Add optimistic subagent child to the current session's sidebar tree
        ...(newSubagentChild && state.currentSessionId ? {
          diskSessions: state.diskSessions.map((s) => {
            if (s.sessionId !== state.currentSessionId) return s;
            const exists = (s.children ?? []).some((c) => c.agentId === newSubagentChild!.agentId);
            if (exists) return s;
            return { ...s, children: [...(s.children ?? []), newSubagentChild!] };
          }),
        } : {}),
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
        latestPlan: action.entries,
      };

    case "TASKS":
      return {
        ...state,
        latestTasks: action.tasks,
      };

    case "PERMISSION_REQUEST":
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            type: "permission",
            id: uid(),
            title: action.title,
            requestId: action.requestId,
            toolCallId: action.toolCallId,
            options: action.options,
            status: "pending" as const,
          },
        ],
      };

    case "PERMISSION_RESOLVED":
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.type === "permission" && (m as any).requestId === action.requestId
            ? {
                ...m,
                status: "resolved" as const,
                selectedOptionId: action.optionId,
                selectedOptionName: action.optionName,
              }
            : m,
        ),
      };

    case "SESSION_INFO":
      return {
        ...state,
        models: action.models,
        currentModel: action.currentModel || action.models[0] || null,
      };

    case "SYSTEM": {
      // Hide hook, system init, and compacting metadata — not useful in the chat UI
      // (compacting status is already shown via the TurnStatusBar activity)
      if (/^\[Hook |^\[System initialized:|^\[Compacting conversation context|^\[Local command error\]/.test(action.text)) return state;
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
      const targetSession = action.sessionId || state.currentSessionId;
      const isCurrentSession = !action.sessionId || action.sessionId === state.currentSessionId;
      return {
        ...state,
        // Only set chat-level state for the currently-viewed session
        ...(isCurrentSession ? { busy: true, turnStatus: ts } : {}),
        liveTurnStatus: targetSession
          ? { ...state.liveTurnStatus, [targetSession]: ts }
          : state.liveTurnStatus,
      };
    }

    case "TURN_ACTIVITY": {
      const targetSession = action.sessionId || state.currentSessionId;
      const isCurrentSession = !action.sessionId || action.sessionId === state.currentSessionId;
      // Update liveTurnStatus for the target session
      const existingLts = targetSession ? state.liveTurnStatus[targetSession] : null;
      if (!existingLts || existingLts.status !== "in_progress") {
        // For non-current sessions with no live status, still track in liveTurnStatus
        if (targetSession && !isCurrentSession) {
          return {
            ...state,
            liveTurnStatus: {
              ...state.liveTurnStatus,
              [targetSession]: {
                status: "in_progress",
                startedAt: Date.now(),
                activity: action.activity,
                activityDetail: action.detail,
                ...(action.approxTokens != null && { approxTokens: action.approxTokens }),
                ...(action.thinkingDurationMs != null && { thinkingDurationMs: action.thinkingDurationMs }),
              },
            },
          };
        }
        if (!state.turnStatus || state.turnStatus.status !== "in_progress") return state;
      }
      const updatedTs: TurnStatus = {
        ...(isCurrentSession && state.turnStatus?.status === "in_progress" ? state.turnStatus : existingLts!),
        activity: action.activity,
        activityDetail: action.detail,
        ...(action.approxTokens != null && { approxTokens: action.approxTokens }),
        ...(action.thinkingDurationMs != null && { thinkingDurationMs: action.thinkingDurationMs }),
      };
      return {
        ...state,
        ...(isCurrentSession ? { turnStatus: updatedTs } : {}),
        liveTurnStatus: targetSession
          ? { ...state.liveTurnStatus, [targetSession]: updatedTs }
          : state.liveTurnStatus,
      };
    }

    case "TURN_END": {
      const targetSession = action.sessionId || state.currentSessionId;
      const isCurrentSession = !action.sessionId || action.sessionId === state.currentSessionId;

      // Build completed turn status for liveTurnStatus (sidebar/kanban display)
      const isError = action.stopReason === "error";
      const endStatus = isError ? "error" as const : "completed" as const;
      const ltsEntry = targetSession ? state.liveTurnStatus[targetSession] : null;
      const startedAt = (isCurrentSession ? state.turnStatus?.startedAt : null) ?? ltsEntry?.startedAt ?? Date.now();
      const completedStatus: TurnStatus | null = action.durationMs != null
        ? {
            status: endStatus,
            startedAt,
            endedAt: Date.now(),
            durationMs: action.durationMs,
            outputTokens: action.outputTokens,
            thinkingDurationMs: action.thinkingDurationMs,
            costUsd: action.costUsd,
            approxTokens: (isCurrentSession ? state.turnStatus?.approxTokens : null) ?? ltsEntry?.approxTokens,
            stopReason: action.stopReason,
          }
        : ltsEntry?.status === "in_progress"
          ? { ...ltsEntry, status: endStatus, endedAt: Date.now(), durationMs: Date.now() - ltsEntry.startedAt, stopReason: action.stopReason }
          : isCurrentSession && state.turnStatus
            ? { ...state.turnStatus, status: endStatus, endedAt: Date.now(), durationMs: Date.now() - state.turnStatus.startedAt, stopReason: action.stopReason }
            : null;

      // For non-current sessions, only update liveTurnStatus (no chat state changes)
      if (!isCurrentSession) {
        return {
          ...state,
          liveTurnStatus: targetSession && completedStatus
            ? { ...state.liveTurnStatus, [targetSession]: completedStatus }
            : state.liveTurnStatus,
          // Mark background session as unread so kanban shows it in "in review"
          unreadCompletedSessions: targetSession
            ? { ...state.unreadCompletedSessions, [targetSession]: true as const }
            : state.unreadCompletedSessions,
        };
      }

      // Current session: full turn-end processing
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

      // Add a turn_completed entry to messages (the single source of truth for
      // completed bars). Remove any existing turn_completed entries from the
      // current turn group to avoid duplicates from partial history loads during
      // mid-turn reconnects.
      const durationMs = completedStatus?.durationMs ?? (state.turnStatus ? Date.now() - state.turnStatus.startedAt : 0);
      let finalizedMessages = finalizeStreaming(state.messages, state.currentTurnId);
      // Strip stale turn_completed entries from the current turn group (after
      // the last user message) — these come from partial history on reconnect.
      const lastUserIdx = findLastUserMessageIndex(finalizedMessages);
      finalizedMessages = finalizedMessages.filter(
        (m, i) => !(m.type === "turn_completed" && i > lastUserIdx),
      );
      if (durationMs > 0) {
        finalizedMessages = [
          ...finalizedMessages,
          {
            type: "turn_completed" as const,
            id: uid(),
            durationMs,
            ...(completedStatus?.outputTokens != null && { outputTokens: completedStatus.outputTokens }),
            ...(completedStatus?.thinkingDurationMs != null && { thinkingDurationMs: completedStatus.thinkingDurationMs }),
            ...(completedStatus?.costUsd != null && { costUsd: completedStatus.costUsd }),
          },
        ];
      }

      return {
        ...state,
        // Stay busy if there are queued messages (server will auto-drain next)
        busy: state.queuedMessages.length > 0,
        currentTurnId: null,
        turnToolCallIds: [],
        tasks: updatedTasks,
        taskPanelOpen,
        // Clear turnStatus — CompletedBar now comes from the turn_completed entry
        // in messages. TurnStatusBar only shows during in_progress.
        turnStatus: null,
        liveTurnStatus: targetSession && completedStatus
          ? { ...state.liveTurnStatus, [targetSession]: completedStatus }
          : state.liveTurnStatus,
        // Don't mark the currently-viewed session as unread — the user is already
        // watching it complete, so it should go straight to "completed" in the kanban
        // board rather than getting stuck in "in review". Other sessions that complete
        // in the background are marked unread via the SESSIONS reducer instead.
        unreadCompletedSessions: state.unreadCompletedSessions,
        messages: finalizedMessages,
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
      // Merge incoming sessions with existing ones to prevent accidental loss
      // due to race conditions (e.g., sessions/list reads a partially-written
      // sessions-index.json during concurrent new session creation).
      const incomingIds = new Set(action.sessions.map((s) => s.sessionId));
      const recentlyDeleted = new Set(state._recentlyDeletedIds);
      // Build a lookup of existing sessions so we can preserve fields that
      // stale sessions/list responses might overwrite with null.
      const existingBySession = new Map<string, (typeof state.diskSessions)[number]>();
      for (const s of state.diskSessions) {
        existingBySession.set(s.sessionId, s);
      }
      const merged = action.sessions
        .filter((s) => !recentlyDeleted.has(s.sessionId))
        .map((s) => {
          const existing = existingBySession.get(s.sessionId);
          if (!existing) return s;
          let result = s;
          // Preserve existing title when the incoming session has null title.
          // This prevents a stale sessions/list (fetched before the ACP agent
          // or Haiku pool sets the title) from wiping a title that was already
          // delivered via session_title_update.
          if (!result.title && existing.title) {
            result = { ...result, title: existing.title };
          }
          // Preserve existing children if the incoming session doesn't include them
          if (!result.children?.length && existing.children?.length) {
            result = { ...result, children: existing.children };
          }
          return result;
        });
      // Preserve existing sessions that are missing from the incoming list
      // but were NOT recently deleted (they were probably missed due to a race condition)
      if (state.diskSessionsLoaded) {
        for (const existing of state.diskSessions) {
          if (!incomingIds.has(existing.sessionId) && !recentlyDeleted.has(existing.sessionId)) {
            merged.push(existing);
          }
        }
      }

      // Seed liveTurnStatus from server-provided turn data on each session
      const lts = { ...state.liveTurnStatus };
      const unread = { ...state.unreadCompletedSessions };
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
          // Back to in_progress — no longer unread-completed
          delete unread[s.sessionId];
        } else if (lts[s.sessionId]?.status === "in_progress" && (s.turnStatus === "completed" || s.turnStatus === "error" || s.turnDurationMs != null)) {
          // Transition: was in_progress, now completed/error — use server metrics when available.
          // Guard: if the server's turn data is from a PREVIOUS turn (its turnStartedAt
          // is older than our liveTurnStatus entry), this is stale data from an earlier
          // turn and shouldn't overwrite the current optimistic in_progress status.
          const existing = lts[s.sessionId];
          const serverTurnIsStale = s.turnStartedAt && existing.startedAt && s.turnStartedAt < existing.startedAt;
          if (!serverTurnIsStale) {
            const isError = s.turnStatus === "error" || s.turnStopReason === "error";
            lts[s.sessionId] = {
              status: isError ? "error" : "completed",
              startedAt: existing.startedAt,
              endedAt: Date.now(),
              durationMs: s.turnDurationMs ?? (Date.now() - existing.startedAt),
              outputTokens: s.turnOutputTokens,
              costUsd: s.turnCostUsd,
              thinkingDurationMs: s.turnThinkingDurationMs ?? existing.thinkingDurationMs,
              approxTokens: existing.approxTokens,
              stopReason: s.turnStopReason,
            };
            // Mark as needing review (moves to "in review" column)
            unread[s.sessionId] = true;
          }
        } else if (lts[s.sessionId]?.status === "completed" || lts[s.sessionId]?.status === "error") {
          // Already completed — keep stats for sidebar display. Only clean unread state.
          // Exception: if the existing status is a stale "disconnected" error and the
          // server provides actual completion data, replace with the real metrics.
          if (lts[s.sessionId].stopReason === "disconnected" && (s.turnStatus === "completed" || s.turnStatus === "error" || s.turnDurationMs != null)) {
            const isError = s.turnStatus === "error" || s.turnStopReason === "error";
            lts[s.sessionId] = {
              status: isError ? "error" : "completed",
              startedAt: s.turnStartedAt ?? lts[s.sessionId].startedAt,
              endedAt: Date.now(),
              durationMs: s.turnDurationMs ?? lts[s.sessionId].durationMs,
              outputTokens: s.turnOutputTokens,
              costUsd: s.turnCostUsd,
              thinkingDurationMs: s.turnThinkingDurationMs,
              stopReason: s.turnStopReason,
            };
          }
          if (!s.turnStatus) {
            delete unread[s.sessionId];
          }
        } else if ((s.turnStatus === "completed" || s.turnStatus === "error") && s.turnDurationMs != null) {
          // Seed from server-provided completion/error metrics
          lts[s.sessionId] = {
            status: s.turnStatus === "error" ? "error" : "completed",
            startedAt: s.turnStartedAt ?? 0,
            endedAt: Date.now(),
            durationMs: s.turnDurationMs,
            outputTokens: s.turnOutputTokens,
            costUsd: s.turnCostUsd,
            thinkingDurationMs: s.turnThinkingDurationMs,
            stopReason: s.turnStopReason,
          };
        } else {
          // No liveTurnStatus entry and no server completion data — nothing to track
        }
      }
      return { ...state, diskSessions: merged, diskSessionsLoaded: true, liveTurnStatus: lts, unreadCompletedSessions: unread, _recentlyDeletedIds: [] };
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
            pendingQueuedEntries: [],
            latestPlan: extractLatestPlan(historyMessages),
            latestTasks: null,
          },
        },
      };
    }

    case "SESSION_SWITCH_PENDING": {
      const { [action.sessionId]: _, ...pendingUnread } = state.unreadCompletedSessions;
      return { ...state, switchingToSessionId: action.sessionId, unreadCompletedSessions: pendingUnread };
    }

    case "SESSION_SWITCHED": {
      const reducerT0 = performance.now();
      // Use freshly received history (SESSION_HISTORY arrived just before this)
      // No save-on-switch: server is authoritative, stale client cache would cause issues
      const cleanHistory = { ...state.sessionHistory };
      console.log(`[${pageMs()}] reducer SESSION_SWITCHED from=${state.currentSessionId?.slice(0, 8) ?? "null"} to=${action.sessionId.slice(0, 8)} historyMsgs=${cleanHistory[action.sessionId]?.messages?.length ?? 0} currentMsgs=${state.messages.length}`);

      // Restore target session state from freshly received history or use empty defaults
      const restored = cleanHistory[action.sessionId] ?? emptySnapshot;

      // Clear consumed entry to prevent stale reuse on future switches
      delete cleanHistory[action.sessionId];

      // Mark the target session as read (no longer unread-completed)
      const { [action.sessionId]: _, ...readUnread } = state.unreadCompletedSessions;

      // Extract sub-agent children from the restored messages so the sidebar
      // shows them immediately on page reload without needing an extra API call.
      // Always extract and merge with existing children — previous extraction or
      // optimistic inserts may have captured only a subset of the sub-agents.
      const baseSessionId = action.sessionId.replace(/:subagent:.+$/, "");
      let updatedDiskSessions = state.diskSessions;
      if (restored.messages.length > 0) {
        const extracted = extractSubagentChildrenFromMessages(restored.messages);
        if (extracted.length > 0) {
          const existingSession = state.diskSessions.find((s) => s.sessionId === baseSessionId);
          const existingChildren = existingSession?.children ?? [];
          const existingIds = new Set(existingChildren.map((c) => c.agentId));
          const newChildren = extracted.filter((c) => !existingIds.has(c.agentId));
          if (newChildren.length > 0 || existingChildren.length === 0) {
            updatedDiskSessions = state.diskSessions.map((s) =>
              s.sessionId === baseSessionId
                ? { ...s, children: [...existingChildren, ...newChildren] }
                : s,
            );
          }
        }
      }

      // Use server-provided turnStatus (from session_switched message) if available,
      // so the UI immediately shows "in progress" without waiting for the separate
      // turn_start message that arrives after turn_content_replay.
      const effectiveTurnStatus = action.turnStatus ?? restored.turnStatus;

      const reducerMs = (performance.now() - reducerT0).toFixed(1);
      const isOptimisticPending = action.sessionId.startsWith("pending:");
      const newSessionElapsed = !isOptimisticPending && (window as any).__newSessionStart ? (performance.now() - (window as any).__newSessionStart).toFixed(0) : null;
      if (newSessionElapsed) {
        performance.mark("new-session:reducer-done");
        performance.measure("new-session:reducer", "new-session:switched", "new-session:reducer-done");
        console.log(`[${pageMs()}] reducer SESSION_SWITCHED done reducer=${reducerMs}ms totalSinceNewSession=${newSessionElapsed}ms`);
        // Schedule render completion measurement
        requestAnimationFrame(() => {
          const renderElapsed = (window as any).__newSessionStart ? (performance.now() - (window as any).__newSessionStart).toFixed(0) : "?";
          performance.mark("new-session:rendered");
          try { performance.measure("new-session:render", "new-session:reducer-done", "new-session:rendered"); } catch {}
          try { performance.measure("new-session:total", "new-session:start", "new-session:rendered"); } catch {}
          console.log(
            `[${pageMs()}] NEW SESSION READY totalE2E=${renderElapsed}ms` +
            `\n  Breakdown: check DevTools Performance tab for "new-session:*" measures` +
            `\n  or see console logs above for per-phase timings`,
          );
          // Print a structured summary
          const measures = performance.getEntriesByType("measure").filter((e) => e.name.startsWith("new-session:"));
          if (measures.length > 0) {
            console.groupCollapsed(`[perf] New session creation breakdown (${renderElapsed}ms total)`);
            for (const m of measures) {
              console.log(`  ${m.name.replace("new-session:", "").padEnd(20)} ${m.duration.toFixed(0)}ms`);
            }
            console.groupEnd();
          }
          // Cleanup marks/measures for next run
          for (const m of performance.getEntriesByName("new-session:start")) performance.clearMarks(m.name);
          for (const m of performance.getEntriesByName("new-session:switched")) performance.clearMarks(m.name);
          for (const m of performance.getEntriesByName("new-session:sessions-list")) performance.clearMarks(m.name);
          for (const m of performance.getEntriesByName("new-session:reducer-done")) performance.clearMarks(m.name);
          for (const m of performance.getEntriesByName("new-session:rendered")) performance.clearMarks(m.name);
          performance.clearMeasures("new-session:server-roundtrip");
          performance.clearMeasures("new-session:reducer");
          performance.clearMeasures("new-session:render");
          performance.clearMeasures("new-session:total");
          delete (window as any).__newSessionStart;
        });
      } else {
        console.log(`[${pageMs()}] reducer SESSION_SWITCHED done reducer=${reducerMs}ms`);
      }

      return {
        ...state,
        currentSessionId: action.sessionId,
        switchingToSessionId: null,
        sessionHistory: cleanHistory,
        diskSessions: updatedDiskSessions,
        messages: restored.messages,
        tasks: restored.tasks,
        // protoEntries are global debug traffic — keep them across session switches
        currentTurnId: null,
        turnToolCallIds: restored.turnToolCallIds,
        turnStatus: effectiveTurnStatus,
        busy: restored.queuedMessages.length > 0 || effectiveTurnStatus?.status === "in_progress",
        queuedMessages: restored.queuedMessages,
        pendingQueuedEntries: restored.pendingQueuedEntries,
        peekStatus: {},
        latestPlan: restored.latestPlan,
        latestTasks: restored.latestTasks,
        unreadCompletedSessions: readUnread,
      };
    }

    case "SESSION_ID_RESOLVED": {
      // Swap a pending (optimistic) session ID with the real one from the server.
      // Only swaps IDs — doesn't reset messages/tasks/turnStatus (empty session stays empty).
      const { pendingId, realId } = action;
      console.log(`[${pageMs()}] reducer SESSION_ID_RESOLVED pending=${pendingId.slice(0, 20)} real=${realId.slice(0, 8)}`);
      return {
        ...state,
        currentSessionId: state.currentSessionId === pendingId ? realId : state.currentSessionId,
        switchingToSessionId: state.switchingToSessionId === pendingId ? null : state.switchingToSessionId,
        diskSessions: state.diskSessions.map((s) =>
          s.sessionId === pendingId ? { ...s, sessionId: realId } : s,
        ),
      };
    }

    case "SESSION_TITLE_UPDATE": {
      const idx = state.diskSessions.findIndex((s) => s.sessionId === action.sessionId);
      if (idx >= 0) {
        // Session exists — update title in place
        return {
          ...state,
          diskSessions: state.diskSessions.map((s) =>
            s.sessionId === action.sessionId ? { ...s, title: action.title } : s,
          ),
        };
      }
      // Session not yet in diskSessions (broadcastSessions hasn't delivered it).
      // Insert a stub so the title isn't lost. The SESSIONS reducer will merge
      // this stub with the full session data when it arrives, preserving the title.
      return {
        ...state,
        diskSessions: [
          ...state.diskSessions,
          {
            sessionId: action.sessionId,
            title: action.title,
            updatedAt: null,
            created: null,
            messageCount: 0,
            gitBranch: null,
            projectPath: null,
            isLive: true,
          },
        ],
      };
    }

    // ── Queue management actions ────────────
    case "MESSAGE_QUEUED": {
      // Idempotent: SEND_MESSAGE already adds to queuedMessages when busy
      if (state.queuedMessages.includes(action.queueId)) return state;
      return {
        ...state,
        queuedMessages: [...state.queuedMessages, action.queueId],
      };
    }

    case "QUEUE_DRAIN_START": {
      // Move the queued message from pendingQueuedEntries into messages[]
      // now that the agent is about to process it.
      const drainEntry = state.pendingQueuedEntries.find(
        (m) => m._queueId === action.queueId,
      );
      return {
        ...state,
        busy: true,
        queuedMessages: state.queuedMessages.filter((id) => id !== action.queueId),
        pendingQueuedEntries: state.pendingQueuedEntries.filter(
          (m) => m._queueId !== action.queueId,
        ),
        messages: drainEntry
          ? [...finalizeStreaming(state.messages, state.currentTurnId), drainEntry]
          : state.messages,
        // Reset turn state for the new turn about to start
        currentTurnId: drainEntry ? null : state.currentTurnId,
      };
    }

    case "QUEUE_CANCELLED":
      return {
        ...state,
        queuedMessages: state.queuedMessages.filter((id) => id !== action.queueId),
        pendingQueuedEntries: state.pendingQueuedEntries.filter(
          (m) => m._queueId !== action.queueId,
        ),
        // Also clean from messages in case it was added there (non-busy send path)
        messages: state.messages.filter(
          (m) => !(m.type === "message" && m.role === "user" && (m as MessageEntry)._queueId === action.queueId),
        ),
      };

    case "COMMANDS": {
      const updates: Partial<AppState> = { commands: action.commands };
      if (action.models) updates.models = action.models;
      if (action.currentModel !== undefined) updates.currentModel = action.currentModel;
      return { ...state, ...updates };
    }

    case "SESSION_DELETED": {
      const deletedSet = new Set(action.sessionIds);
      return {
        ...state,
        diskSessions: state.diskSessions.filter((s) => !deletedSet.has(s.sessionId)),
        _recentlyDeletedIds: [...(state._recentlyDeletedIds ?? []), ...action.sessionIds],
      };
    }

    case "SESSION_SUBAGENTS": {
      return {
        ...state,
        diskSessions: state.diskSessions.map((s) => {
          if (s.sessionId !== action.sessionId) return s;
          // Merge loaded subagent children with existing teammate children.
          // Preserve specific types from optimistic/extracted children when the
          // server returns the generic "agent" fallback (e.g. after context compression).
          const existingTeammates = (s.children ?? []).filter((c: any) => !!c.sessionId);
          const existingSubagents = (s.children ?? []).filter((c: any) => !c.sessionId);
          const existingTypeByAgentId = new Map<string, SubagentType>();
          for (const c of existingSubagents) {
            if (c.agentType && c.agentType !== "agent") {
              existingTypeByAgentId.set(c.agentId, c.agentType);
            }
          }
          const mergedChildren = action.children.map((c) => {
            if (c.agentType === "agent" && existingTypeByAgentId.has(c.agentId)) {
              return { ...c, agentType: existingTypeByAgentId.get(c.agentId)! };
            }
            return c;
          });
          return { ...s, children: [...existingTeammates, ...mergedChildren] };
        }),
      };
    }

    case "SESSION_DESELECTED":
      return {
        ...state,
        currentSessionId: null,
        switchingToSessionId: null,
        messages: [],
        tasks: {},
        currentTurnId: null,
        turnToolCallIds: [],
        turnStatus: null,
        busy: false,
        queuedMessages: [],
        pendingQueuedEntries: [],
        peekStatus: {},
        latestPlan: null,
        latestTasks: null,
      };

    case "KANBAN_STATE_LOADED": {
      // Skip redundant broadcasts when we already applied this version from
      // a KANBAN_OP_ACK (which includes the snapshot). This prevents an extra
      // re-render that can cause card flicker after drag-and-drop.
      if (state.kanbanStateLoaded && action.version <= state.kanbanVersion) {
        return state;
      }
      // On reconnect, clear stale "disconnected" liveTurnStatus for sessions
      // that the server says are still in_progress (successfully reconnected).
      // Without this, the auto-cleanup effect sees error + in_progress override
      // and would drag reconnected cards to in_review.
      let lts = state.liveTurnStatus;
      if (!state.kanbanStateLoaded) {
        const freshLts = { ...lts };
        for (const [sessionId, col] of Object.entries(action.columnOverrides)) {
          if (col === "in_progress" && freshLts[sessionId]?.stopReason === "disconnected") {
            delete freshLts[sessionId];
          }
        }
        lts = freshLts;
      }
      return {
        ...state,
        kanbanColumnOverrides: action.columnOverrides,
        kanbanSortOrders: action.sortOrders,
        kanbanPendingPrompts: action.pendingPrompts,
        kanbanVersion: action.version,
        // Clear pending ops on reconnect (kanbanStateLoaded was reset by WS_DISCONNECTED).
        // During normal operation (already loaded), keep pending ops — they're drained by ack.
        kanbanPendingOps: state.kanbanStateLoaded ? state.kanbanPendingOps : [],
        kanbanStateLoaded: true,
        liveTurnStatus: lts,
      };
    }

    case "KANBAN_STATE_UPDATED":
      return {
        ...state,
        kanbanColumnOverrides: action.columnOverrides,
        kanbanSortOrders: action.sortOrders,
        kanbanPendingPrompts: action.pendingPrompts,
        kanbanVersion: action.version,
      };

    case "KANBAN_ENQUEUE_OPS":
      return {
        ...state,
        kanbanPendingOps: [...state.kanbanPendingOps, { seq: action.seq, ops: action.ops }],
      };

    case "KANBAN_OP_ACK":
      return {
        ...state,
        kanbanVersion: action.version,
        kanbanPendingOps: state.kanbanPendingOps.filter((p) => p.seq > action.ackSeq),
        // Atomically update server state with the snapshot included in the ack.
        // This prevents a flicker frame where pending ops are drained but the
        // server state hasn't been updated yet by the broadcast.
        ...(action.columnOverrides != null ? {
          kanbanColumnOverrides: action.columnOverrides,
          kanbanSortOrders: action.sortOrders ?? state.kanbanSortOrders,
          kanbanPendingPrompts: action.pendingPrompts ?? state.kanbanPendingPrompts,
        } : {}),
      };

    case "KANBAN_UPDATE_PENDING_PROMPT": {
      if (!action.text) {
        const next = { ...state.kanbanPendingPrompts };
        delete next[action.sessionId];
        return { ...state, kanbanPendingPrompts: next };
      }
      return {
        ...state,
        kanbanPendingPrompts: { ...state.kanbanPendingPrompts, [action.sessionId]: action.text },
      };
    }

    case "SET_OPTIMISTIC_TURN_STATUS":
      return {
        ...state,
        liveTurnStatus: {
          ...state.liveTurnStatus,
          [action.sessionId]: action.status,
        },
      };

    case "EXECUTORS":
      return { ...state, availableExecutors: action.available };

    case "SET_EXECUTOR":
      return { ...state, selectedExecutor: action.executor };

    case "SET_PROJECTS":
      return { ...state, projects: action.projects, activeProject: action.activeProject };

    case "SET_ACTIVE_PROJECT":
      return { ...state, activeProject: action.path };

    default:
      return state;
  }
}

// ── Split contexts: Actions (stable) + State (changes frequently) ──
// Components that only need actions won't re-render when state changes.

export interface WsActions {
  dispatch: React.Dispatch<Action>;
  send: (text: string, images?: ImageAttachment[], files?: FileAttachment[], options?: { skipRouting?: boolean }) => void;
  sendOpusPrompt: (text: string, images?: ImageAttachment[], sessionId?: string) => void;
  sendPromptToSession: (sessionId: string, text: string, images?: ImageAttachment[], files?: FileAttachment[]) => void;
  interrupt: () => void;
  newSession: () => void;
  createBacklogSession: (title: string) => Promise<string>;
  deselectSession: () => void;
  resumeSession: (sessionId: string) => void;
  resumeSubagent: (parentSessionId: string, agentId: string) => void;
  deleteSession: (sessionId: string) => void;
  renameSession: (sessionId: string, title: string) => void;
  cancelQueued: (queueId: string) => void;
  searchFiles: (query: string, callback: (files: string[]) => void) => void;
  requestCommands: () => void;
  requestSubagents: (sessionId: string) => void;
  respondToPermission: (requestId: string, optionId: string, optionName: string) => void;
  saveKanbanState: (columnOverrides: Record<string, string>, sortOrders: Partial<Record<string, string[]>>, pendingPrompts: Record<string, string>) => void;
  sendKanbanOp: (ops: KanbanOp[]) => void;
  updatePendingPrompt: (sessionId: string, text: string) => void;
  preflightRoute: (text: string) => void;
  requestHaikuMetrics: () => void;
}

interface WsContextValue {
  state: AppState;
  dispatch: React.Dispatch<Action>;
  send: (text: string, images?: ImageAttachment[], files?: FileAttachment[], options?: { skipRouting?: boolean }) => void;
  sendOpusPrompt: (text: string, images?: ImageAttachment[], sessionId?: string) => void;
  sendPromptToSession: (sessionId: string, text: string, images?: ImageAttachment[], files?: FileAttachment[]) => void;
  interrupt: () => void;
  newSession: () => void;
  createBacklogSession: (title: string) => Promise<string>;
  deselectSession: () => void;
  resumeSession: (sessionId: string) => void;
  resumeSubagent: (parentSessionId: string, agentId: string) => void;
  deleteSession: (sessionId: string) => void;
  renameSession: (sessionId: string, title: string) => void;
  cancelQueued: (queueId: string) => void;
  searchFiles: (query: string, callback: (files: string[]) => void) => void;
  requestCommands: () => void;
  requestSubagents: (sessionId: string) => void;
  respondToPermission: (requestId: string, optionId: string, optionName: string) => void;
  saveKanbanState: (columnOverrides: Record<string, string>, sortOrders: Partial<Record<string, string[]>>, pendingPrompts: Record<string, string>) => void;
  sendKanbanOp: (ops: KanbanOp[]) => void;
  updatePendingPrompt: (sessionId: string, text: string) => void;
  preflightRoute: (text: string) => void;
  requestHaikuMetrics: () => void;
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
  const stateRef = useRef(state);
  stateRef.current = state;
  const wsRef = useRef<WebSocket | null>(null);

  // ── Hash routing refs ──
  /** The hash captured at mount time, before any WS events.
   *  Falls back to localStorage if no URL hash is present. */
  const pendingHashRestore = useRef(
    parseSessionHash() ?? (() => {
      const saved = loadSelectedSession();
      return saved ? { sessionId: saved } : null;
    })(),
  );
  /** True once the initial hash restore logic has been handled. */
  const hashInitialized = useRef(false);
  /** When true, the next hash sync will use replaceState instead of pushState. */
  const skipNextPush = useRef(false);
  /** Tracks currentSessionId for the popstate handler without stale closures. */
  const currentSessionRef = useRef<string | null>(null);
  currentSessionRef.current = state.currentSessionId;
  /** Tracks sessions that we've already requested history for (to avoid duplicate requests). */
  const historyRequestedFor = useRef(new Set<string>());

  /** Tracks a pending new session creation for optimistic navigation. */
  const pendingNewSessionRef = useRef<{
    resolve: (sessionId: string) => void;
    promise: Promise<string>;
    tempId: string;
  } | null>(null);

  /** Tracks a pending backlog session creation (no UI switch). */
  const pendingBacklogRef = useRef<{
    resolve: (sessionId: string) => void;
    title: string;
  } | null>(null);

  const newSession = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const t0 = performance.now();
    (window as any).__newSessionStart = t0;
    performance.mark("new-session:start");

    // Optimistic: show empty session instantly while server creates it in background
    const tempId = `pending:${Date.now()}`;
    let resolve!: (sessionId: string) => void;
    const promise = new Promise<string>((r) => { resolve = r; });
    pendingNewSessionRef.current = { resolve, promise, tempId };

    console.log(`[${pageMs()}] newSession: optimistic switch to ${tempId}, sending request to server`);
    dispatch({ type: "SESSION_SWITCHED", sessionId: tempId, turnStatus: null });
    wsRef.current.send(JSON.stringify({ type: "new_session", executorType: stateRef.current.selectedExecutor }));
  }, []);

  /** Tracks a pending route_message so the client can show the user message
   *  after the server responds with a route_result. */
  const pendingRouteRef = useRef<{
    text: string;
    images?: ImageAttachment[];
    files?: FileAttachment[];
    queueId: string;
  } | null>(null);

  // ── Preflight routing state (as-you-type session routing prediction) ──
  /** Cached preflight routing result from the server. */
  const preflightCacheRef = useRef<{
    text: string;
    sessionId: string;
    isSameSession: boolean;
    seq: number;
    receivedAt: number;
  } | null>(null);
  /** Monotonically increasing sequence number for preflight requests. */
  const preflightSeqRef = useRef(0);
  /** Debounce timer for preflight routing. */
  const preflightTimerRef = useRef<ReturnType<typeof setTimeout>>();
  /** Text of the last preflight request that was actually sent (for similarity check). */
  const preflightLastSentTextRef = useRef<string>("");

  // ── Preflight routing constants ──
  const PREFLIGHT_DEBOUNCE_MS = 400;
  const PREFLIGHT_MIN_CHARS = 15;
  const PREFLIGHT_MIN_WORDS = 3;
  const PREFLIGHT_CACHE_TTL_MS = 30_000; // 30s — stale cache is worse than no cache
  /** If new text is just an extension of previously-routed text (prefix match + small delta), skip re-routing. */
  const PREFLIGHT_SIMILARITY_DELTA = 20; // chars

  /** Trigger a preflight routing request (debounced, called as user types). */
  const preflightRoute = useCallback((text: string) => {
    // Clear any pending debounce timer
    if (preflightTimerRef.current) clearTimeout(preflightTimerRef.current);

    // Guard: no session, no WS, or session is pending
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    if (!currentSessionRef.current || currentSessionRef.current.startsWith("pending:")) return;

    const trimmed = text.trim();

    // Skip for short text — likely continuation like "continue", "yes", "do it"
    const wordCount = trimmed.split(/\s+/).length;
    if (trimmed.length < PREFLIGHT_MIN_CHARS || wordCount < PREFLIGHT_MIN_WORDS) {
      // Short text → assume same session, clear any stale cache
      preflightCacheRef.current = null;
      return;
    }

    // Similarity check: if new text is just a small extension of the last-routed text,
    // the routing decision is unlikely to change — skip the API call.
    const lastSent = preflightLastSentTextRef.current;
    if (lastSent && trimmed.startsWith(lastSent) && (trimmed.length - lastSent.length) < PREFLIGHT_SIMILARITY_DELTA) {
      return;
    }
    // Also skip if the last-routed text starts with the new text (user deleted some chars at end)
    if (lastSent && lastSent.startsWith(trimmed) && (lastSent.length - trimmed.length) < PREFLIGHT_SIMILARITY_DELTA) {
      return;
    }

    // Debounce: fire after the user pauses typing
    preflightTimerRef.current = setTimeout(() => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      if (!currentSessionRef.current || currentSessionRef.current.startsWith("pending:")) return;

      const seq = ++preflightSeqRef.current;
      preflightLastSentTextRef.current = trimmed;

      console.log(`[${pageMs()}] preflight: sending seq=${seq} len=${trimmed.length} session=${currentSessionRef.current.slice(0, 8)}`);
      wsRef.current.send(JSON.stringify({
        type: "preflight_route",
        text: trimmed,
        seq,
      }));
    }, PREFLIGHT_DEBOUNCE_MS);
  }, []);

  const send = useCallback((text: string, images?: ImageAttachment[], files?: FileAttachment[], options?: { skipRouting?: boolean }) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    // Cancel any pending preflight debounce — we're sending now
    if (preflightTimerRef.current) clearTimeout(preflightTimerRef.current);

    const queueId = `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Cross-project guard: if the current session belongs to a different project
    // than the active one, treat it as "no session" so a new session is created
    // in the correct project instead of continuing in the old one.
    let sessionMatchesProject = true;
    if (currentSessionRef.current && stateRef.current.activeProject) {
      const currentSession = stateRef.current.diskSessions.find(
        (s) => s.sessionId === currentSessionRef.current,
      );
      if (currentSession?.projectPath && currentSession.projectPath !== stateRef.current.activeProject) {
        sessionMatchesProject = false;
      }
    }

    if (sessionMatchesProject && currentSessionRef.current && !currentSessionRef.current.startsWith("pending:")) {
      const trimmed = text.trim();
      const cache = preflightCacheRef.current;
      const wordCount = trimmed.split(/\s+/).length;

      // Fast path 0: Explicit skip-routing (e.g. kanban drag-to-run) → send directly, no Haiku routing
      if (options?.skipRouting) {
        console.log(`[${pageMs()}] send: skipRouting → direct prompt (no route)`);
        dispatch({ type: "SEND_MESSAGE", text, images, files, queueId });
        wsRef.current.send(JSON.stringify({
          type: "prompt",
          text,
          queueId,
          ...(images?.length ? { images } : {}),
          ...(files?.length ? { files } : {}),
        }));
        preflightCacheRef.current = null;
        return;
      }

      // Fast path 1: Short text (< threshold) → stay in current session, no routing needed
      if (trimmed.length < PREFLIGHT_MIN_CHARS || wordCount < PREFLIGHT_MIN_WORDS) {
        console.log(`[${pageMs()}] send: short text (${trimmed.length} chars, ${wordCount} words) → same session (no route)`);
        dispatch({ type: "SEND_MESSAGE", text, images, files, queueId });
        wsRef.current.send(JSON.stringify({
          type: "prompt",
          text,
          queueId,
          ...(images?.length ? { images } : {}),
          ...(files?.length ? { files } : {}),
        }));
        preflightCacheRef.current = null;
        return;
      }

      // Fast path 2: System prompts (kanban actions) → always same session, skip routing
      if (isSystemPrompt(trimmed)) {
        console.log(`[${pageMs()}] send: system prompt → same session (no route)`);
        dispatch({ type: "SEND_MESSAGE", text, images, files, queueId });
        wsRef.current.send(JSON.stringify({
          type: "prompt",
          text,
          queueId,
          ...(images?.length ? { images } : {}),
          ...(files?.length ? { files } : {}),
        }));
        preflightCacheRef.current = null;
        return;
      }

      // Fast path 3: Valid preflight cache hit → use cached routing decision (0ms latency!)
      if (
        cache &&
        cache.sessionId === currentSessionRef.current &&
        cache.isSameSession &&
        (Date.now() - cache.receivedAt) < PREFLIGHT_CACHE_TTL_MS
      ) {
        console.log(`[${pageMs()}] send: preflight cache HIT → same session (0ms routing)`);
        dispatch({ type: "SEND_MESSAGE", text, images, files, queueId });
        wsRef.current.send(JSON.stringify({
          type: "prompt",
          text,
          queueId,
          ...(images?.length ? { images } : {}),
          ...(files?.length ? { files } : {}),
        }));
        preflightCacheRef.current = null;
        return;
      }

      // Fast path 4: Preflight says "new session" — still need full route_message
      // because route_message handles new session creation + session switching.
      // But we log the preflight hint for debugging.
      if (cache && cache.sessionId === currentSessionRef.current && !cache.isSameSession) {
        console.log(`[${pageMs()}] send: preflight hint → new session (confirming via route_message)`);
      }

      // Default path: route through Haiku (existing behavior)
      pendingRouteRef.current = { text, images, files, queueId };
      // Show user message optimistically (same as non-routing path).
      // If Haiku routes to a new session, SESSION_SWITCHED clears messages[]
      // and route_result re-dispatches SEND_MESSAGE into the new session.
      // skipLiveTurnStatus: don't pollute the global liveTurnStatus (read by
      // the kanban board) with an optimistic in_progress for a session that
      // may not actually receive the prompt. The local turnStatus still shows
      // the brewing indicator in the chat UI. If routing confirms the same
      // session, the server's turn_start will set liveTurnStatus; if routing
      // creates a new session, the original card stays in its original column.
      dispatch({ type: "SEND_MESSAGE", text, images, files, queueId, skipLiveTurnStatus: true });
      console.log(`[${pageMs()}] send: routing via Haiku for session ${currentSessionRef.current.slice(0, 8)}`);
      wsRef.current.send(JSON.stringify({
        type: "route_message",
        text,
        queueId,
        ...(images?.length ? { images } : {}),
        ...(files?.length ? { files } : {}),
      }));
      preflightCacheRef.current = null;
    } else {
      // No session selected: create a new session and send prompt directly
      if (!currentSessionRef.current && !pendingNewSessionRef.current) {
        newSession();
      }
      // Show message in UI immediately (optimistic)
      dispatch({ type: "SEND_MESSAGE", text, images, files, queueId });

      const payload = JSON.stringify({
        type: "prompt",
        text,
        queueId,
        ...(images?.length ? { images } : {}),
        ...(files?.length ? { files } : {}),
      });

      // If a new session is still being created, defer the WS send until it's ready
      if (pendingNewSessionRef.current) {
        console.log(`[${pageMs()}] send: deferring prompt until session ready`);
        pendingNewSessionRef.current.promise.then(() => {
          console.log(`[${pageMs()}] send: session ready, sending deferred prompt`);
          wsRef.current?.send(payload);
        });
      } else {
        wsRef.current.send(payload);
      }
    }
  }, [newSession]);

  /** Send a prompt through the pre-warmed opus pool (bypasses ACP session lifecycle). */
  const sendOpusPrompt = useCallback((text: string, images?: ImageAttachment[], sessionId?: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const queueId = `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    console.log(`[${pageMs()}] sendOpusPrompt: → opus_prompt session=${sessionId?.slice(0, 8) ?? "implicit"}`);
    // Only dispatch SEND_MESSAGE for the current session (no explicit sessionId).
    // Cross-session kanban prompts already set optimistic status via SET_OPTIMISTIC_TURN_STATUS,
    // and SEND_MESSAGE would wrongly add a user turn to the current session's messages.
    if (!sessionId) {
      dispatch({ type: "SEND_MESSAGE", text, images, queueId });
    }
    wsRef.current.send(JSON.stringify({
      type: "opus_prompt",
      text,
      queueId,
      ...(sessionId ? { sessionId } : {}),
      ...(images?.length ? { images } : {}),
    }));
  }, []);

  /** Send a real ACP prompt to a specific session without switching the active chat view. */
  const sendPromptToSession = useCallback(
    (sessionId: string, text: string, images?: ImageAttachment[], files?: FileAttachment[]) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      const queueId = `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      console.log(`[${pageMs()}] sendPromptToSession: → prompt session=${sessionId.slice(0, 8)}`);
      wsRef.current.send(
        JSON.stringify({
          type: "prompt",
          sessionId,
          text,
          queueId,
          ...(images?.length ? { images } : {}),
          ...(files?.length ? { files } : {}),
        }),
      );
    },
    [],
  );

  const deselectSession = useCallback(() => {
    if (pendingNewSessionRef.current) pendingNewSessionRef.current = null;
    // Clear preflight routing state
    if (preflightTimerRef.current) clearTimeout(preflightTimerRef.current);
    preflightCacheRef.current = null;
    preflightLastSentTextRef.current = "";
    dispatch({ type: "SESSION_DESELECTED" });
  }, []);

  const interrupt = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "interrupt" }));
  }, []);

  const resumeSessionCb = useCallback((sessionId: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    // Cancel pending new session if user navigates away
    if (pendingNewSessionRef.current) pendingNewSessionRef.current = null;
    // Clear preflight routing state from previous session
    if (preflightTimerRef.current) clearTimeout(preflightTimerRef.current);
    preflightCacheRef.current = null;
    preflightLastSentTextRef.current = "";
    console.log(`[${pageMs()}] switch requesting ${sessionId.slice(0, 8)}`);
    (window as any).__switchStart = performance.now();
    dispatch({ type: "SESSION_SWITCH_PENDING", sessionId });
    wsRef.current.send(JSON.stringify({ type: "switch_session", sessionId }));
  }, []);

  const resumeSubagentCb = useCallback((parentSessionId: string, agentId: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    // Cancel pending new session if user navigates away
    if (pendingNewSessionRef.current) pendingNewSessionRef.current = null;
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

  /** Create a new session in the background for the backlog (no UI switch). */
  const createBacklogSession = useCallback((title: string): Promise<string> => {
    return new Promise((resolve, reject) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        reject(new Error("WebSocket not connected"));
        return;
      }
      pendingBacklogRef.current = { resolve, title };
      wsRef.current.send(JSON.stringify({ type: "new_session", executorType: stateRef.current.selectedExecutor }));
    });
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

  const respondToPermission = useCallback((requestId: string, optionId: string, optionName: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "permission_response", requestId, optionId, optionName }));
  }, []);

  const kanbanSeqRef = useRef(0);

  const sendKanbanOp = useCallback((ops: KanbanOp[]) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const seq = ++kanbanSeqRef.current;
    dispatch({ type: "KANBAN_ENQUEUE_OPS", seq, ops });
    wsRef.current.send(JSON.stringify({ type: "kanban_op", ops, clientSeq: seq }));
  }, [dispatch]);

  /** @deprecated Use sendKanbanOp instead. Kept for backward compat during transition. */
  const saveKanbanState = useCallback((
    columnOverrides: Record<string, string>,
    sortOrders: Partial<Record<string, string[]>>,
    pendingPrompts: Record<string, string>,
  ) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "save_kanban_state", columnOverrides, sortOrders, pendingPrompts }));
  }, []);

  const updatePendingPrompt = useCallback((sessionId: string, text: string) => {
    dispatch({ type: "KANBAN_UPDATE_PENDING_PROMPT", sessionId, text });
  }, []);

  const requestHaikuMetrics = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "request_haiku_metrics" }));
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
      pendingHashRestore.current = parseSessionHash() ?? (() => {
        const saved = loadSelectedSession();
        return saved ? { sessionId: saved } : null;
      })();
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
        // Optimistic new session: if creation fails, clear pending state
        // Backlog session creation: intercept session_switched without navigating
        if (msg.type === "session_switched" && pendingBacklogRef.current) {
          const { resolve, title } = pendingBacklogRef.current;
          pendingBacklogRef.current = null;
          console.log(`[${pageMs()}] handleMsg session_switched ${msg.sessionId.slice(0, 8)} (backlog session created)`);
          // Rename the session to the user's backlog title
          wsRef.current?.send(JSON.stringify({ type: "rename_session", sessionId: msg.sessionId, title }));
          resolve(msg.sessionId);
          // Don't dispatch SESSION_SWITCHED — the sessions list broadcast will pick it up
          return;
        }
        if (msg.type === "error" && pendingBacklogRef.current) {
          console.warn(`[${pageMs()}] backlog session creation failed`);
          pendingBacklogRef.current = null;
        }

        if (msg.type === "error" && pendingNewSessionRef.current) {
          console.warn(`[${pageMs()}] newSession failed, reverting optimistic switch`);
          pendingNewSessionRef.current = null;
          // handleMsg will dispatch ERROR which shows the error in the UI
        }

        // Optimistic new session: intercept session_switched to resolve pending promise
        // and swap temp ID instead of doing a full SESSION_SWITCHED reset.
        if (msg.type === "session_switched" && pendingNewSessionRef.current) {
          const pending = pendingNewSessionRef.current;
          pendingNewSessionRef.current = null;
          const now = performance.now();
          const elapsed = (window as any).__newSessionStart ? (now - (window as any).__newSessionStart).toFixed(0) : "?";
          performance.mark("new-session:switched");
          try { performance.measure("new-session:server-roundtrip", "new-session:start", "new-session:switched"); } catch {}
          console.log(`[${pageMs()}] handleMsg session_switched ${msg.sessionId.slice(0, 8)} (optimistic resolve) serverRoundtrip=${elapsed}ms`);
          pending.resolve(msg.sessionId);
          currentSessionRef.current = msg.sessionId;
          dispatch({ type: "SESSION_ID_RESOLVED", pendingId: pending.tempId, realId: msg.sessionId });
          return;
        }

        // Keep currentSessionRef in sync immediately when a session_switched is
        // processed (not intercepted by backlog/newSession). This ensures messages
        // arriving in the same event-loop tick (e.g. route_result right after a
        // routed session_switched) pass the session filter below.
        if (msg.type === "session_switched") {
          currentSessionRef.current = msg.sessionId;
        }

        // Defense-in-depth: drop session-scoped messages that don't belong to the
        // current session. The server already filters by session, but this guards
        // against bugs like a missing sessionId on a broadcast.
        if (msg.sessionId && currentSessionRef.current && msg.sessionId !== currentSessionRef.current) {
          const globalTypes = new Set(["sessions", "session_history", "session_switched", "session_title_update", "session_deleted", "session_subagents", "protocol", "permission_request", "permission_resolved", "turn_start", "turn_activity", "turn_end"]);
          if (!globalTypes.has(msg.type)) return;
        }

        // Handle preflight_route_result — update the cache ref silently (no dispatch).
        if (msg.type === "preflight_route_result") {
          // Only accept if seq matches the latest request (discard stale responses)
          if (msg.seq === preflightSeqRef.current) {
            preflightCacheRef.current = {
              text: msg.text,
              sessionId: msg.sessionId,
              isSameSession: msg.isSameSession,
              seq: msg.seq,
              receivedAt: Date.now(),
            };
            console.log(`[${pageMs()}] preflight: result seq=${msg.seq} same=${msg.isSameSession} session=${msg.sessionId.slice(0, 8)}`);
          } else {
            console.log(`[${pageMs()}] preflight: stale result seq=${msg.seq} (current=${preflightSeqRef.current}), discarding`);
          }
          return;
        }

        // Handle route_result here (not in handleMsg) because it needs access
        // to pendingRouteRef which is component-scoped.
        if (msg.type === "route_result") {
          const pending = pendingRouteRef.current;
          if (pending) {
            pendingRouteRef.current = null;
            console.log(`[${pageMs()}] handleMsg route_result session=${msg.sessionId.slice(0, 8)} isNew=${msg.isNew}`);
            if (msg.isNew) {
              dispatch({ type: "SEND_MESSAGE", text: pending.text, images: pending.images, files: pending.files, queueId: pending.queueId });
            }
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
      if (preflightTimerRef.current) clearTimeout(preflightTimerRef.current);
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
      sendOpusPrompt,
      sendPromptToSession,
      interrupt,
      newSession,
      createBacklogSession,
      deselectSession,
      resumeSession: resumeSessionCb,
      resumeSubagent: resumeSubagentCb,
      deleteSession: deleteSessionCb,
      renameSession: renameSessionCb,
      cancelQueued,
      searchFiles,
      requestCommands,
      requestSubagents,
      respondToPermission,
      saveKanbanState,
      sendKanbanOp,
      updatePendingPrompt,
      preflightRoute,
      requestHaikuMetrics,
    }),
    // All deps are useCallback([]) or useReducer dispatch — stable references
    [dispatch, send, sendOpusPrompt, sendPromptToSession, interrupt, newSession, createBacklogSession, resumeSessionCb, resumeSubagentCb, deleteSessionCb, renameSessionCb, cancelQueued, searchFiles, requestCommands, requestSubagents, respondToPermission, saveKanbanState, sendKanbanOp, updatePendingPrompt, preflightRoute, requestHaikuMetrics],
  );

  // ── Hash-based URL routing ──

  // Sync URL hash with current session, and handle initial restore from hash
  useEffect(() => {
    if (!state.currentSessionId) return;

    // Skip hash/localStorage sync for optimistic pending session IDs
    if (state.currentSessionId.startsWith("pending:")) return;

    // Phase 1: On first session switch after connect, check if we need to
    // restore from the URL hash instead of the auto-created session.
    if (!hashInitialized.current) {
      if (!state.connected) return;

      const restore = pendingHashRestore.current;
      pendingHashRestore.current = null;
      hashInitialized.current = true;

      if (restore) {
        // Always request the switch — even if currentSessionId already matches
        // (e.g. during HMR, React Fast Refresh preserves state so the old
        // sessionId survives, but the server created a new session on reconnect).
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

    // Persist selected session to localStorage
    saveSelectedSession(state.currentSessionId);

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
  // Skip for brand-new sessions (still tracked via __newSessionStart) — they
  // are expected to have 0 messages and don't need a redundant switch_session.
  useEffect(() => {
    if (!state.currentSessionId || !state.connected) return;
    if (state.messages.length > 0) return;
    if (historyRequestedFor.current.has(state.currentSessionId)) return;

    const sessionId = state.currentSessionId;
    const timer = setTimeout(() => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      // Skip if this is a freshly-created session (empty messages is expected)
      if ((window as any).__newSessionStart && performance.now() - (window as any).__newSessionStart < 5000) {
        console.log(`[${pageMs()}] fallback skipped for new session ${sessionId.slice(0, 8)} (empty is expected)`);
        return;
      }
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
    case "tasks":
      dispatch({ type: "TASKS", tasks: msg.tasks ?? [] });
      break;
    case "permission_request":
      dispatch({
        type: "PERMISSION_REQUEST",
        requestId: msg.requestId,
        title: msg.title,
        toolCallId: msg.toolCallId,
        options: msg.options ?? [],
      });
      break;
    case "permission_resolved":
      dispatch({
        type: "PERMISSION_RESOLVED",
        requestId: msg.requestId,
        optionId: msg.optionId,
        optionName: msg.optionName ?? msg.optionId,
      });
      break;
    case "session_info": {
      const newSessionElapsed = (window as any).__newSessionStart ? (performance.now() - (window as any).__newSessionStart).toFixed(0) : null;
      if (newSessionElapsed) {
        console.log(`[${pageMs()}] handleMsg session_info sinceNewSession=${newSessionElapsed}ms models=${msg.models?.length ?? 0}`);
      }
      dispatch({
        type: "SESSION_INFO",
        sessionId: msg.sessionId,
        models: msg.models,
        currentModel: msg.currentModel,
        modes: msg.modes,
      });
      break;
    }
    case "system":
      dispatch({ type: "SYSTEM", text: msg.text });
      break;
    case "turn_start":
      dispatch({ type: "TURN_START", startedAt: msg.startedAt ?? Date.now(), sessionId: msg.sessionId });
      break;
    case "turn_content_replay":
      // Replay buffered turn content for mid-turn joins (tmux-style attach)
      for (const m of msg.messages ?? []) {
        handleMsg(m, dispatch);
      }
      break;
    case "turn_activity":
      dispatch({ type: "TURN_ACTIVITY", activity: msg.activity, detail: msg.detail, approxTokens: msg.approxTokens, thinkingDurationMs: msg.thinkingDurationMs, sessionId: msg.sessionId });
      break;
    case "turn_end":
      dispatch({
        type: "TURN_END",
        durationMs: msg.durationMs,
        outputTokens: msg.outputTokens,
        thinkingDurationMs: msg.thinkingDurationMs,
        costUsd: msg.costUsd,
        stopReason: msg.stopReason,
        sessionId: msg.sessionId,
      });
      break;
    case "error":
      dispatch({ type: "ERROR", text: msg.text });
      break;
    // Session management messages
    case "sessions": {
      const newSessionElapsed = (window as any).__newSessionStart ? (performance.now() - (window as any).__newSessionStart).toFixed(0) : null;
      if (newSessionElapsed) {
        performance.mark("new-session:sessions-list");
        console.log(`[${pageMs()}] handleMsg sessions count=${msg.sessions?.length ?? 0} sinceNewSession=${newSessionElapsed}ms`);
      }
      dispatch({ type: "SESSIONS", sessions: msg.sessions });
      break;
    }
    case "session_history": {
      const entryCount = msg.entries?.length ?? 0;
      console.log(`[${pageMs()}] handleMsg session_history entries=${entryCount} session=${msg.sessionId?.slice(0, 8)}`);
      dispatch({ type: "SESSION_HISTORY", sessionId: msg.sessionId, entries: msg.entries ?? [] });
      break;
    }
    case "session_switched":
      {
        const now = performance.now();
        const switchElapsed = (window as any).__switchStart ? (now - (window as any).__switchStart).toFixed(0) : "?";
        const newSessionElapsed = (window as any).__newSessionStart ? (now - (window as any).__newSessionStart).toFixed(0) : null;
        if (newSessionElapsed) {
          performance.mark("new-session:switched");
          performance.measure("new-session:server-roundtrip", "new-session:start", "new-session:switched");
          console.log(`[${pageMs()}] handleMsg session_switched ${msg.sessionId.slice(0, 8)} newSessionE2E=${newSessionElapsed}ms (server roundtrip)`);
        } else {
          console.log(`[${pageMs()}] handleMsg session_switched ${msg.sessionId.slice(0, 8)} switchE2E=${switchElapsed}ms`);
        }
      }
      dispatch({ type: "SESSION_SWITCHED", sessionId: msg.sessionId, turnStatus: msg.turnStatus ?? null });
      break;
    case "session_title_update":
      if (titleLockedSessions.has(msg.sessionId)) break;
      if (!msg.title) break; // ignore null/empty — prevents stale SDK updates from wiping Haiku titles
      dispatch({ type: "SESSION_TITLE_UPDATE", sessionId: msg.sessionId, title: msg.title });
      break;
    // route_result is handled in the onmessage handler (needs pendingRouteRef)
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
      dispatch({ type: "COMMANDS", commands: msg.commands ?? [], models: msg.models, currentModel: msg.currentModel });
      break;
    case "executors":
      dispatch({ type: "EXECUTORS", available: msg.available ?? ["claude"] });
      break;
    case "session_deleted":
      dispatch({ type: "SESSION_DELETED", sessionIds: msg.sessionIds ?? [msg.sessionId] });
      break;
    case "session_subagents":
      dispatch({ type: "SESSION_SUBAGENTS", sessionId: msg.sessionId, children: msg.children ?? [] });
      break;
    case "kanban_state":
      dispatch({ type: "KANBAN_STATE_LOADED", columnOverrides: msg.columnOverrides ?? {}, sortOrders: msg.sortOrders ?? {}, pendingPrompts: msg.pendingPrompts ?? {}, version: msg.version ?? 0 });
      break;
    case "kanban_op_ack":
      dispatch({
        type: "KANBAN_OP_ACK",
        ackSeq: msg.clientSeq,
        version: msg.version,
        columnOverrides: msg.columnOverrides,
        sortOrders: msg.sortOrders,
        pendingPrompts: msg.pendingPrompts,
      });
      break;

    case "haiku_metrics":
      window.dispatchEvent(new CustomEvent("haiku-metrics", { detail: msg.metrics }));
      break;
  }
}
