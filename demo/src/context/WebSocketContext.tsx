import {
  createContext,
  useContext,
  useReducer,
  useRef,
  useEffect,
  useCallback,
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
  ImageAttachment,
} from "../types";
import { classifyTool } from "../utils";
import { jsonlToEntries, prettyToolName, extractAgentId } from "../jsonl-convert";

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
  protoEntries: [],
  currentTurnId: null,
  turnToolCallIds: [],
};

const initialState: AppState = {
  connected: false,
  busy: false,
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
  debugCollapsed: false,
  startTime: Date.now(),
  // Session management
  sessions: [],
  diskSessions: [],
  currentSessionId: null,
  switchingToSessionId: null,
  sessionHistory: {},
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
      return { ...state, connected: true, busy: false, startTime: Date.now() };

    case "WS_DISCONNECTED":
      return { ...state, connected: false, busy: false };

    case "SET_BUSY":
      return { ...state, busy: action.busy };

    case "SEND_MESSAGE": {
      const content: ContentBlock[] = [];
      if (action.images?.length) {
        for (const img of action.images) {
          content.push({ type: "image", data: img.data, mimeType: img.mimeType });
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
      };
      return {
        ...state,
        busy: true,
        currentTurnId: null,
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
                : b,
            ),
          ),
        };
      }

      // Finalize any previous streaming block, then add new text block
      return {
        ...state,
        currentTurnId: turnId,
        messages: updateTurnContent(msgs, turnId, (content) => [
          ...content.map((b) =>
            (b.type === "text" || b.type === "thinking") && b._streaming
              ? { ...b, _streaming: false }
              : b,
          ),
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
                : b,
            ),
          ),
        };
      }

      // Finalize any previous streaming block, then add new thinking block
      return {
        ...state,
        currentTurnId: turnId,
        messages: updateTurnContent(msgs, turnId, (content) => [
          ...content.map((b) =>
            (b.type === "text" || b.type === "thinking") && b._streaming
              ? { ...b, _streaming: false }
              : b,
          ),
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
        input: {},
        title: action.title || action.toolCallId,
        kind: action.kind || "tool",
        status: "pending",
      };

      return {
        ...state,
        currentTurnId: turnId,
        taskPanelOpen,
        tasks: { ...state.tasks, [action.toolCallId]: newTask },
        peekStatus: newPeek,
        turnToolCallIds: [...state.turnToolCallIds, action.toolCallId],
        messages: updateTurnContent(msgs, turnId, (content) => [
          // Finalize any streaming blocks
          ...content.map((b) =>
            (b.type === "text" || b.type === "thinking") && b._streaming
              ? { ...b, _streaming: false }
              : b,
          ),
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
              const updated = {
                ...b,
                status: newStatus ?? b.status,
                title: action.title || b.title,
                result: action.content || b.result,
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

    case "SYSTEM":
      return {
        ...state,
        messages: [
          ...finalizeStreaming(state.messages, state.currentTurnId),
          { type: "system", id: uid(), text: action.text },
        ],
        currentTurnId: null,
      };

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

      return {
        ...state,
        busy: false,
        currentTurnId: null,
        turnToolCallIds: [],
        tasks: updatedTasks,
        taskPanelOpen,
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

    case "SESSION_LIST":
      return { ...state, sessions: action.sessions };

    case "DISK_SESSIONS":
      return { ...state, diskSessions: action.sessions };

    case "SESSION_HISTORY": {
      const historyMessages = jsonlToEntries(action.entries);
      return {
        ...state,
        sessionHistory: {
          ...state.sessionHistory,
          [action.sessionId]: {
            messages: historyMessages,
            tasks: {},
            protoEntries: [],
            currentTurnId: null,
            turnToolCallIds: [],
          },
        },
      };
    }

    case "SESSION_SWITCH_PENDING":
      return { ...state, switchingToSessionId: action.sessionId };

    case "SESSION_SWITCHED": {
      // Save current session state to history
      const history = { ...state.sessionHistory };
      if (state.currentSessionId) {
        history[state.currentSessionId] = {
          messages: state.messages,
          tasks: state.tasks,
          protoEntries: state.protoEntries,
          currentTurnId: state.currentTurnId,
          turnToolCallIds: state.turnToolCallIds,
        };
      }

      // Restore target session state from history or use empty defaults
      const restored = history[action.sessionId] ?? emptySnapshot;

      return {
        ...state,
        currentSessionId: action.sessionId,
        switchingToSessionId: null,
        sessionHistory: history,
        messages: restored.messages,
        tasks: restored.tasks,
        protoEntries: restored.protoEntries,
        currentTurnId: null,
        turnToolCallIds: restored.turnToolCallIds,
        busy: false,
        peekStatus: {},
      };
    }

    case "SESSION_TITLE_UPDATE":
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.sessionId === action.sessionId ? { ...s, title: action.title } : s,
        ),
      };

    default:
      return state;
  }
}

interface WsContextValue {
  state: AppState;
  dispatch: React.Dispatch<Action>;
  send: (text: string, images?: ImageAttachment[]) => void;
  newSession: () => void;
  resumeSession: (sessionId: string) => void;
  resumeSubagent: (parentSessionId: string, agentId: string) => void;
  deleteSession: (sessionId: string) => void;
  renameSession: (sessionId: string, title: string) => void;
}

const WsContext = createContext<WsContextValue | null>(null);

export function useWs(): WsContextValue {
  const ctx = useContext(WsContext);
  if (!ctx) throw new Error("useWs must be used within WebSocketProvider");
  return ctx;
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

  const send = useCallback((text: string, images?: ImageAttachment[]) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    dispatch({ type: "SEND_MESSAGE", text, images });
    wsRef.current.send(
      JSON.stringify({
        type: "prompt",
        text,
        ...(images?.length ? { images } : {}),
      }),
    );
  }, []);

  const newSession = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "new_session" }));
  }, []);

  const resumeSessionCb = useCallback((sessionId: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    dispatch({ type: "SESSION_SWITCH_PENDING", sessionId });
    wsRef.current.send(JSON.stringify({ type: "switch_session", sessionId }));
  }, []);

  const resumeSubagentCb = useCallback((parentSessionId: string, agentId: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    dispatch({ type: "SESSION_SWITCH_PENDING", sessionId: `${parentSessionId}:subagent:${agentId}` });
    wsRef.current.send(JSON.stringify({ type: "resume_subagent", parentSessionId, agentId }));
  }, []);

  const deleteSessionCb = useCallback((sessionId: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.warn("[deleteSession] WebSocket not connected");
      return;
    }
    console.log("[deleteSession] Sending delete_session for", sessionId);
    wsRef.current.send(JSON.stringify({ type: "delete_session", sessionId }));
  }, []);

  const renameSessionCb = useCallback((sessionId: string, title: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "rename_session", sessionId, title }));
  }, []);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    function connect() {
      if (disposed) return;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(proto + "//" + location.host + "/ws");
      wsRef.current = ws;

      ws.onopen = () => dispatch({ type: "WS_CONNECTED" });
      ws.onclose = () => {
        dispatch({ type: "WS_DISCONNECTED" });
        if (!disposed) {
          reconnectTimer = setTimeout(connect, 2000);
        }
      };

      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        console.log("[WS RAW]", msg.type, JSON.parse(JSON.stringify(msg)));
        handleMsg(msg, dispatch);
      };
    }

    connect();
    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, []);

  // Tick running tasks every second
  useEffect(() => {
    const id = setInterval(() => {
      const hasRunning = Object.values(state.tasks).some(
        (t) => t.isBackground && t.status === "running",
      );
      if (hasRunning) dispatch({ type: "SET_BUSY", busy: state.busy });
    }, 1000);
    return () => clearInterval(id);
  }, [state.tasks, state.busy]);

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

  return (
    <WsContext.Provider value={{ state, dispatch, send, newSession, resumeSession: resumeSessionCb, resumeSubagent: resumeSubagentCb, deleteSession: deleteSessionCb, renameSession: renameSessionCb }}>
      {children}
    </WsContext.Provider>
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
        content,
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
    case "turn_end":
      dispatch({ type: "TURN_END" });
      break;
    case "error":
      dispatch({ type: "ERROR", text: msg.text });
      break;
    // Session management messages
    case "session_list":
      dispatch({ type: "SESSION_LIST", sessions: msg.sessions });
      break;
    case "disk_sessions":
      dispatch({ type: "DISK_SESSIONS", sessions: msg.sessions });
      break;
    case "session_history":
      dispatch({ type: "SESSION_HISTORY", sessionId: msg.sessionId, entries: msg.entries ?? [] });
      break;
    case "session_switched":
      dispatch({ type: "SESSION_SWITCHED", sessionId: msg.sessionId });
      break;
    case "session_title_update":
      dispatch({ type: "SESSION_TITLE_UPDATE", sessionId: msg.sessionId, title: msg.title });
      break;
  }
}
