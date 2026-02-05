import {
  createContext,
  useContext,
  useReducer,
  useRef,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import type { AppState, Action, ChatMessage, SessionSnapshot, ImageAttachment } from "../types";
import { classifyTool } from "../utils";

let nextId = 0;
function uid(): string {
  return "m" + nextId++;
}

const emptySnapshot: SessionSnapshot = {
  messages: [],
  tasks: {},
  protoEntries: [],
  currentAssistantId: null,
  currentThoughtId: null,
  turnToolCallIds: [],
};

const initialState: AppState = {
  connected: false,
  busy: false,
  messages: [],
  currentAssistantId: null,
  currentThoughtId: null,
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
  sessionHistory: {},
};

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "WS_CONNECTED":
      return { ...state, connected: true, busy: false, startTime: Date.now() };

    case "WS_DISCONNECTED":
      return { ...state, connected: false, busy: false };

    case "SET_BUSY":
      return { ...state, busy: action.busy };

    case "SEND_MESSAGE": {
      return {
        ...state,
        busy: true,
        currentAssistantId: null,
        currentThoughtId: null,
        messages: [
          ...state.messages,
          {
            type: "user",
            id: uid(),
            text: action.text,
            ...(action.images?.length ? { images: action.images } : {}),
          },
        ],
      };
    }

    case "TEXT_CHUNK": {
      if (state.currentAssistantId) {
        return {
          ...state,
          messages: state.messages.map((m) =>
            m.id === state.currentAssistantId && m.type === "assistant"
              ? { ...m, text: m.text + action.text }
              : m,
          ),
        };
      }
      const newId = uid();
      return {
        ...state,
        currentAssistantId: newId,
        messages: [
          ...state.messages,
          { type: "assistant", id: newId, text: action.text, done: false },
        ],
      };
    }

    case "THOUGHT_CHUNK": {
      if (state.currentThoughtId) {
        return {
          ...state,
          messages: state.messages.map((m) =>
            m.id === state.currentThoughtId && m.type === "thought"
              ? { ...m, text: m.text + action.text }
              : m,
          ),
        };
      }
      const newId = uid();
      return {
        ...state,
        currentThoughtId: newId,
        messages: [
          ...state.messages,
          { type: "thought", id: newId, text: action.text },
        ],
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

      return {
        ...state,
        currentThoughtId: null,
        taskPanelOpen,
        tasks: { ...state.tasks, [action.toolCallId]: newTask },
        peekStatus: newPeek,
        turnToolCallIds: [...state.turnToolCallIds, action.toolCallId],
        messages: [
          ...state.messages,
          {
            type: "tool_call",
            id: uid(),
            toolCallId: action.toolCallId,
            kind: action.kind || "tool",
            title: action.title || action.toolCallId,
            content: action.content,
            status: "pending",
          },
        ],
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

      return {
        ...state,
        tasks: updatedTasks,
        peekStatus: newPeek,
        messages: state.messages.map((m) =>
          m.type === "tool_call" && m.toolCallId === action.toolCallId
            ? {
                ...m,
                status:
                  action.status === "completed"
                    ? ("completed" as const)
                    : action.status === "failed"
                      ? ("failed" as const)
                      : m.status,
                title: action.title || m.title,
                content: action.content || m.content,
              }
            : m,
        ),
      };
    }

    case "PLAN":
      return {
        ...state,
        currentThoughtId: null,
        messages: [
          ...state.messages,
          { type: "plan", id: uid(), entries: action.entries },
        ],
      };

    case "PERMISSION":
      return {
        ...state,
        messages: [
          ...state.messages,
          { type: "permission", id: uid(), title: action.title },
        ],
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
          ...state.messages,
          { type: "system", id: uid(), text: action.text },
        ],
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
        currentAssistantId: null,
        currentThoughtId: null,
        turnToolCallIds: [],
        tasks: updatedTasks,
        taskPanelOpen,
        messages: state.messages.map((m) =>
          m.id === state.currentAssistantId && m.type === "assistant"
            ? { ...m, done: true }
            : m,
        ),
      };
    }

    case "ERROR":
      return {
        ...state,
        busy: false,
        messages: [
          ...state.messages,
          { type: "system", id: uid(), text: "Error: " + action.text },
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
      // Convert history messages into ChatMessage format and store in sessionHistory
      const historyMessages: ChatMessage[] = action.messages.map((m) => {
        if (m.role === "user") {
          return { type: "user" as const, id: uid(), text: m.text };
        }
        return { type: "assistant" as const, id: uid(), text: m.text, done: true };
      });
      return {
        ...state,
        sessionHistory: {
          ...state.sessionHistory,
          [action.sessionId]: {
            messages: historyMessages,
            tasks: {},
            protoEntries: [],
            currentAssistantId: null,
            currentThoughtId: null,
            turnToolCallIds: [],
          },
        },
      };
    }

    case "SESSION_SWITCHED": {
      // Save current session state to history
      const history = { ...state.sessionHistory };
      if (state.currentSessionId) {
        history[state.currentSessionId] = {
          messages: state.messages,
          tasks: state.tasks,
          protoEntries: state.protoEntries,
          currentAssistantId: state.currentAssistantId,
          currentThoughtId: state.currentThoughtId,
          turnToolCallIds: state.turnToolCallIds,
        };
      }

      // Restore target session state from history or use empty defaults
      const restored = history[action.sessionId] ?? emptySnapshot;

      return {
        ...state,
        currentSessionId: action.sessionId,
        sessionHistory: history,
        messages: restored.messages,
        tasks: restored.tasks,
        protoEntries: restored.protoEntries,
        currentAssistantId: null,
        currentThoughtId: null,
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

  const send = useCallback((text: string, images?: ImageAttachment[]) => {
    if (!wsRef.current) return;
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
    if (!wsRef.current) return;
    wsRef.current.send(JSON.stringify({ type: "new_session" }));
  }, []);

  const resumeSessionCb = useCallback((sessionId: string) => {
    if (!wsRef.current) return;
    wsRef.current.send(JSON.stringify({ type: "resume_session", sessionId }));
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

  return (
    <WsContext.Provider value={{ state, dispatch, send, newSession, resumeSession: resumeSessionCb }}>
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
      dispatch({ type: "SESSION_HISTORY", sessionId: msg.sessionId, messages: msg.messages });
      break;
    case "session_switched":
      dispatch({ type: "SESSION_SWITCHED", sessionId: msg.sessionId });
      break;
    case "session_title_update":
      dispatch({ type: "SESSION_TITLE_UPDATE", sessionId: msg.sessionId, title: msg.title });
      break;
  }
}
