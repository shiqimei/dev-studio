import { useState, useRef, useEffect } from "react";
import { useWsState, useWsActions } from "../context/WebSocketContext";
import { stripCliXml } from "../strip-xml";
import { MessageList } from "./MessageList";
import { ChatInput } from "./ChatInput";

export function ChatPanel() {
  const state = useWsState();
  const { renameSession } = useWsActions();
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

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

  const isEmpty = state.messages.length === 0;

  return (
    <div className="flex-1 flex flex-col min-w-0">
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
        <div className="welcome-screen">
          <div className="welcome-centered">
            <div className="welcome-greeting">What do you want to build next?</div>
            <div className="welcome-hint">
              Send a message to get started, or type{" "}
              <span className="welcome-kbd">/</span> for commands
            </div>
            <ChatInput />
          </div>
        </div>
      ) : (
        <>
          <MessageList />
          <ChatInput />
        </>
      )}
    </div>
  );
}
