import { useState, useRef, useEffect } from "react";
import { useWsState, useWsActions } from "../context/WebSocketContext";
import { stripCliXml } from "../strip-xml";
import { MessageList } from "./MessageList";
import { TurnStatusBar } from "./TurnStatusBar";
export function ChatPanel({ style }: { style?: React.CSSProperties }) {
  const state = useWsState();
  const { renameSession } = useWsActions();
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const hasSession = !!state.currentSessionId;

  const currentSession = state.diskSessions.find(
    (s) => s.sessionId === state.currentSessionId,
  );
  const rawTitle = currentSession?.title;
  const sessionTitle =
    (rawTitle ? stripCliXml(rawTitle) || rawTitle.replace(/<[^>]+>/g, "").trim() : null) ||
    "New session";

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const startEditing = () => {
    if (!state.currentSessionId) return;
    setEditValue(sessionTitle ?? "");
    setEditing(true);
  };

  const submitRename = () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== sessionTitle && state.currentSessionId) {
      renameSession(state.currentSessionId, trimmed);
    }
    setEditing(false);
  };

  // Welcome screen when no session is selected
  if (!hasSession) {
    return (
      <div className="kanban-chat-viewer" style={style}>
        <div className="chat-welcome-screen">
          <h2 className="chat-welcome-title">What do you want to build?</h2>
          <p className="chat-welcome-subtitle">Select a session or send a message to start a new one</p>
        </div>
      </div>
    );
  }

  const isEmpty = state.messages.length === 0;
  const pendingPrompt = state.currentSessionId
    ? state.kanbanPendingPrompts?.[state.currentSessionId]
    : null;

  return (
    <div className="kanban-chat-viewer" style={style}>
      <div className="chat-title-header">
        {editing ? (
          <input
            ref={inputRef}
            className="chat-title-input"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitRename();
              if (e.key === "Escape") setEditing(false);
            }}
            onBlur={submitRename}
          />
        ) : (
          <h1
            className="text-sm font-medium text-text truncate cursor-pointer chat-title-label"
            onClick={startEditing}
            title="Click to rename"
          >
            {sessionTitle ?? "\u00a0"}
          </h1>
        )}
      </div>
      {isEmpty ? (
        state.turnStatus?.status === "in_progress" ? (
          <div className="chat-scroll-wrap">
            <div className="chat-scroll-list px-5 py-4">
              <div className="chat-content flex flex-col gap-1">
                <TurnStatusBar status={state.turnStatus} />
              </div>
            </div>
          </div>
        ) : (
          <div className="kanban-chat-empty">
            <span className="text-xs text-dim">
              {pendingPrompt
                ? "Drag to In Progress to start this task"
                : "No messages yet"}
            </span>
          </div>
        )
      ) : (
        <MessageList />
      )}
    </div>
  );
}
