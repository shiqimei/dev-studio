import { useWs } from "../context/WebSocketContext";

function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function SessionSidebar() {
  const { state, newSession, resumeSession } = useWs();

  return (
    <div className="w-60 shrink-0 bg-surface border-r border-border flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2.5 border-b border-border flex items-center justify-between">
        <span className="text-xs font-semibold text-dim uppercase tracking-wider">
          Sessions
        </span>
        <button
          onClick={newSession}
          className="w-6 h-6 flex items-center justify-center rounded text-dim hover:text-text hover:bg-[var(--color-border)] transition-colors text-lg leading-none"
          title="New session"
        >
          +
        </button>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto">
        {state.sessions.length === 0 && (
          <div className="px-3 py-4 text-xs text-dim text-center">
            No sessions
          </div>
        )}
        {state.sessions.map((session) => {
          const isActive = session.sessionId === state.currentSessionId;
          return (
            <button
              key={session.sessionId}
              onClick={() => {
                if (!isActive) resumeSession(session.sessionId);
              }}
              className={`w-full text-left px-3 py-2 border-b border-border transition-colors ${
                isActive
                  ? "bg-[var(--color-accent-dim)] border-l-2 border-l-[var(--color-accent)]"
                  : "hover:bg-[var(--color-border)] border-l-2 border-l-transparent"
              }`}
            >
              <div
                className={`text-xs truncate ${
                  isActive ? "text-text font-medium" : "text-dim"
                }`}
              >
                {session.title || "New session"}
              </div>
              <div className="text-[10px] text-dim mt-0.5 flex items-center justify-between">
                <span className="truncate opacity-60">
                  {session.sessionId.slice(0, 8)}
                </span>
                <span className="shrink-0 ml-1">
                  {relativeTime(session.updatedAt)}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
