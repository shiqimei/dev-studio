import { useState, useRef, useEffect } from "react";
import { useWsState, useWsActions } from "../context/WebSocketContext";
import { stripCliXml } from "../strip-xml";
import { MessageList } from "./MessageList";
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
        <div className="kanban-chat-empty">
          <span className="text-xs text-dim">No messages yet</span>
        </div>
      ) : (
        <MessageList />
      )}
    </div>
  );
}
