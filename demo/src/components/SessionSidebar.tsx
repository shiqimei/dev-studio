import { useWs } from "../context/WebSocketContext";
import type { DiskSession, SessionMeta } from "../types";

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

function SessionItem({
  session,
  isActive,
  onClick,
}: {
  session: SessionMeta;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
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
}

function DiskSessionItem({
  session,
  isActive,
  isLive,
  onClick,
}: {
  session: DiskSession;
  isActive: boolean;
  isLive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
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
        <span className="truncate opacity-60 flex items-center gap-1">
          {isLive && (
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
          )}
          {session.sessionId.slice(0, 8)}
          {session.gitBranch && (
            <span className="opacity-60">({session.gitBranch})</span>
          )}
        </span>
        <span className="shrink-0 ml-1">
          {relativeTime(session.updatedAt)}
        </span>
      </div>
    </button>
  );
}

export function SessionSidebar() {
  const { state, newSession, resumeSession } = useWs();

  const instances = state.sessions.filter((s) => s.isLive);
  const liveSessionIds = new Set(instances.map((s) => s.sessionId));

  return (
    <div className="w-60 shrink-0 bg-surface border-r border-border flex flex-col overflow-hidden">
      {/* Instances header */}
      <div className="px-3 py-2.5 border-b border-border flex items-center justify-between">
        <span className="text-xs font-semibold text-dim uppercase tracking-wider">
          Instances
        </span>
        <button
          onClick={newSession}
          className="w-6 h-6 flex items-center justify-center rounded text-dim hover:text-text hover:bg-[var(--color-border)] transition-colors text-lg leading-none"
          title="New instance"
        >
          +
        </button>
      </div>

      {/* Instance list */}
      <div className="overflow-y-auto">
        {instances.length === 0 && (
          <div className="px-3 py-3 text-xs text-dim text-center">
            No live instances
          </div>
        )}
        {instances.map((session) => (
          <SessionItem
            key={session.sessionId}
            session={session}
            isActive={session.sessionId === state.currentSessionId}
            onClick={() => {
              if (session.sessionId !== state.currentSessionId)
                resumeSession(session.sessionId);
            }}
          />
        ))}
      </div>

      {/* All Sessions from disk */}
      <div className="px-3 py-2 border-b border-t border-border">
        <span className="text-xs font-semibold text-dim uppercase tracking-wider">
          All Sessions
        </span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {state.diskSessions.length === 0 && (
          <div className="px-3 py-3 text-xs text-dim text-center">
            No sessions found
          </div>
        )}
        {state.diskSessions.map((session) => (
          <DiskSessionItem
            key={session.sessionId}
            session={session}
            isActive={session.sessionId === state.currentSessionId}
            isLive={liveSessionIds.has(session.sessionId)}
            onClick={() => {
              if (session.sessionId !== state.currentSessionId)
                resumeSession(session.sessionId);
            }}
          />
        ))}
      </div>
    </div>
  );
}
