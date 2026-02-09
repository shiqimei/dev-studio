import { useWsState } from "../context/WebSocketContext";
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

  const currentSession = state.diskSessions.find(
    (s) => s.sessionId === state.currentSessionId,
  );
  const rawTitle = currentSession?.title;
  const sessionTitle =
    (rawTitle ? stripCliXml(rawTitle) || rawTitle.replace(/<[^>]+>/g, "").trim() : null) ||
    (state.currentModel ? prettyModelName(state.currentModel) : null);

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {sessionTitle && (
        <div className="px-5 py-3 border-b border-border shrink-0">
          <h1 className="text-sm font-medium text-text">{sessionTitle}</h1>
        </div>
      )}
      <MessageList />
      <ChatInput />
    </div>
  );
}
