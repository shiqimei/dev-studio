import { useState, useRef, useEffect } from "react";
import { useWsState, useWsActions } from "../context/WebSocketContext";
import { stripCliXml } from "../strip-xml";
import { MessageList } from "./MessageList";
import { ChatInput } from "./ChatInput";

/** Format a model ID like "claude-opus-4-6-20250219" into "Opus 4.6". */
function prettyModelName(modelId: string): string {
  const m = modelId.match(/^claude-(\w+)-(\d+)-(\d+)/);
  if (m) return m[1].charAt(0).toUpperCase() + m[1].slice(1) + " " + m[2] + "." + m[3];
  return modelId;
}

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
    (state.currentModel ? prettyModelName(state.currentModel) : null);

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
      <MessageList />
      <ChatInput />
    </div>
  );
}
