import { useState, useRef, useEffect, useMemo } from "react";
import { useWsState, useWsActions } from "../context/WebSocketContext";
import { stripCliXml } from "../strip-xml";
import { MessageList } from "./MessageList";
import { TurnStatusBar } from "./TurnStatusBar";
import { TodoProgressRing } from "./TodoProgressRing";
import { PlanIcon } from "./messages/Plan";
import type { SubagentChild, PlanEntryItem } from "../types";

function findSubagentChild(children: SubagentChild[], agentId: string): SubagentChild | null {
  for (const child of children) {
    if (child.agentId === agentId) return child;
    if (child.children?.length) {
      const found = findSubagentChild(child.children, agentId);
      if (found) return found;
    }
  }
  return null;
}

export function ChatPanel({ style }: { style?: React.CSSProperties }) {
  const state = useWsState();
  const { renameSession, interrupt } = useWsActions();
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const hasSession = !!state.currentSessionId;

  const subMatch = useMemo(
    () => state.currentSessionId?.match(/^(.+):subagent:(.+)$/),
    [state.currentSessionId],
  );
  const isSubagent = !!subMatch;

  const currentSession = state.diskSessions.find(
    (s) => s.sessionId === (subMatch ? subMatch[1] : state.currentSessionId),
  );

  const sessionTitle = useMemo(() => {
    if (isSubagent && currentSession?.children) {
      const child = findSubagentChild(currentSession.children, subMatch![2]);
      if (child?.taskPrompt) return child.taskPrompt;
    }
    const rawTitle = currentSession?.title;
    return (rawTitle ? stripCliXml(rawTitle) || rawTitle.replace(/<[^>]+>/g, "").trim() : null) ||
      "New session";
  }, [isSubagent, subMatch, currentSession]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const startEditing = () => {
    if (!state.currentSessionId || isSubagent) return;
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

  const planEntries = state.latestPlan;
  const planStats = useMemo(() => {
    if (!planEntries || planEntries.length === 0) return null;
    const total = planEntries.length;
    const completed = planEntries.filter((e: PlanEntryItem) => e.status === "completed").length;
    const inProgress = planEntries.find((e: PlanEntryItem) => e.status === "in_progress");
    // Show last completed item when all done, so the status line stays visible
    const displayEntry = inProgress ?? planEntries.findLast((e: PlanEntryItem) => e.status === "completed");
    return { total, completed, displayEntry };
  }, [planEntries]);

  // Welcome screen when no session is selected
  if (!hasSession) {
    return (
      <div className="kanban-chat-viewer" style={style}>
        <div className="chat-welcome-screen">
          <svg
            width="200"
            height="110"
            viewBox="0 0 240 130"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-dim"
            style={{ marginTop: 16, marginBottom: 16, opacity: 0.4 }}
          >
            {/* Code editor window */}
            <rect x="20" y="14" width="100" height="72" rx="8" strokeWidth="1.5" />
            {/* Title bar dots */}
            <circle cx="32" cy="24" r="2.5" strokeWidth="1" opacity="0.5" />
            <circle cx="40" cy="24" r="2.5" strokeWidth="1" opacity="0.5" />
            <circle cx="48" cy="24" r="2.5" strokeWidth="1" opacity="0.5" />
            <line x1="20" y1="32" x2="120" y2="32" strokeWidth="1" opacity="0.3" />
            {/* Code lines */}
            <line x1="30" y1="42" x2="70" y2="42" strokeWidth="1.2" opacity="0.4" />
            <line x1="36" y1="50" x2="86" y2="50" strokeWidth="1.2" opacity="0.3" />
            <line x1="36" y1="58" x2="76" y2="58" strokeWidth="1.2" opacity="0.25" />
            <line x1="30" y1="66" x2="56" y2="66" strokeWidth="1.2" opacity="0.2" />

            {/* Sparkle / magic wand — connecting editor to chat */}
            <path d="M130 44 L140 40 L136 50 L146 46" strokeWidth="1.3" opacity="0.5" />
            <circle cx="133" cy="36" r="1.2" fill="currentColor" stroke="none" opacity="0.4" />
            <circle cx="145" cy="52" r="1" fill="currentColor" stroke="none" opacity="0.35" />

            {/* Chat bubble (AI response) */}
            <rect x="150" y="28" width="72" height="44" rx="8" strokeWidth="1.5" />
            <path d="M168 72 L162 82 L176 72" strokeWidth="1.5" fill="none" />
            {/* Lines inside chat bubble */}
            <line x1="162" y1="42" x2="208" y2="42" strokeWidth="1.2" opacity="0.4" />
            <line x1="162" y1="50" x2="198" y2="50" strokeWidth="1.2" opacity="0.3" />
            <line x1="162" y1="58" x2="188" y2="58" strokeWidth="1.2" opacity="0.2" />

            {/* Plus icon at bottom — "start new" hint */}
            <circle cx="120" cy="108" r="12" strokeWidth="1.3" opacity="0.3" />
            <line x1="120" y1="102" x2="120" y2="114" strokeWidth="1.3" opacity="0.3" />
            <line x1="114" y1="108" x2="126" y2="108" strokeWidth="1.3" opacity="0.3" />
          </svg>
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

  // Check both turnStatus (real) and liveTurnStatus (optimistic from kanban drag)
  // to avoid flashing the "Drag to In Progress" placeholder during the gap between
  // session switch and the actual send() call.
  const liveStatus = state.currentSessionId
    ? state.liveTurnStatus[state.currentSessionId]
    : null;
  const isInProgress = state.turnStatus?.status === "in_progress"
    || liveStatus?.status === "in_progress";

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
          <div className="chat-title-col min-w-0 flex-1">
            <h1
              className={`text-sm font-medium text-text truncate chat-title-label${isSubagent ? "" : " cursor-pointer"}`}
              onClick={startEditing}
              title={isSubagent ? undefined : "Click to rename"}
            >
              {sessionTitle ?? "\u00a0"}
            </h1>
            {planStats && (
              <div className="todo-progress-wrap">
                <div className="todo-progress-header">
                  <TodoProgressRing completed={planStats.completed} total={planStats.total} size={14} />
                  <span className="todo-progress-count">{planStats.completed}/{planStats.total}</span>
                  {planStats.displayEntry && (
                    <span className="todo-progress-label">{planStats.displayEntry.content}</span>
                  )}
                </div>
                <div className="todo-popover plan">
                  <div className="plan-title">Plan</div>
                  {planEntries!.map((entry: PlanEntryItem, i: number) => (
                    <div key={i} className="plan-entry">
                      <span className={`marker ${entry.status}`}>
                        <PlanIcon status={entry.status} />
                      </span>
                      <span>{entry.content}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
        {state.busy && (
          <button
            type="button"
            className="chat-stop-btn"
            onClick={interrupt}
            title="Stop session"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="0">
              <g><path d="M18.437,20.937H5.563a2.5,2.5,0,0,1-2.5-2.5V5.563a2.5,2.5,0,0,1,2.5-2.5H18.437a2.5,2.5,0,0,1,2.5,2.5V18.437A2.5,2.5,0,0,1,18.437,20.937ZM5.563,4.063a1.5,1.5,0,0,0-1.5,1.5V18.437a1.5,1.5,0,0,0,1.5,1.5H18.437a1.5,1.5,0,0,0,1.5-1.5V5.563a1.5,1.5,0,0,0-1.5-1.5Z" /></g>
            </svg>
          </button>
        )}
      </div>
      {isEmpty ? (
        isInProgress ? (
          <div className="chat-scroll-wrap">
            <div className="chat-scroll-list px-5 py-4">
              <div className="chat-content flex flex-col gap-1">
                {(pendingPrompt || sessionTitle) && (
                  <div className="msg user">
                    <div className="user-text-wrap">
                      {pendingPrompt || sessionTitle}
                    </div>
                  </div>
                )}
                <TurnStatusBar status={state.turnStatus ?? liveStatus} />
              </div>
            </div>
          </div>
        ) : (
          <>
          {(pendingPrompt || sessionTitle) && (
            <div className="px-5 py-4" style={{ maxWidth: 808, margin: '0 auto', width: '100%', display: 'flex', flexDirection: 'column' }}>
              <div className="msg user">
                <div className="user-text-wrap">
                  {pendingPrompt || sessionTitle}
                </div>
              </div>
            </div>
          )}
          <div className="kanban-chat-empty">
            <svg
              width="180"
              height="100"
              viewBox="0 0 220 120"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-dim"
              style={{ marginBottom: 12, opacity: 0.45 }}
            >
              {/* Card being dragged — slightly tilted */}
              <g transform="rotate(-4, 48, 58)">
                <rect x="14" y="38" width="68" height="42" rx="5" strokeWidth="1.5" />
                <line x1="22" y1="52" x2="58" y2="52" strokeWidth="1.2" opacity="0.4" />
                <line x1="22" y1="60" x2="46" y2="60" strokeWidth="1.2" opacity="0.3" />
              </g>

              {/* Cursor pointer on card */}
              <path
                d="M62 28 v16 l4.5-4.5 3.5 7 3-1.5-3.5-7 5.5-.5Z"
                strokeWidth="1.2"
                fill="currentColor"
                fillOpacity="0.35"
              />

              {/* Dashed motion arrow */}
              <path d="M92 56 C112 50, 130 44, 148 38" strokeWidth="1.3" strokeDasharray="4 3" />
              <polyline points="143,34 149,38 144,43" strokeWidth="1.3" fill="none" />

              {/* "In Progress" column */}
              <rect x="152" y="6" width="62" height="108" rx="8" strokeWidth="1.5" />
              <text
                x="183"
                y="22"
                textAnchor="middle"
                fill="currentColor"
                stroke="none"
                fontSize="9"
                fontWeight="500"
                fontFamily="inherit"
              >
                In Progress
              </text>
              <line x1="158" y1="28" x2="208" y2="28" strokeWidth="1" opacity="0.4" />

              {/* Dashed drop-zone placeholder inside column */}
              <rect
                x="158"
                y="34"
                width="50"
                height="30"
                rx="4"
                strokeWidth="1.2"
                strokeDasharray="3 2"
                opacity="0.35"
              />
            </svg>
            <span className="text-xs text-dim">
              Drag to In Progress to start this task
            </span>
          </div>
          </>
        )
      ) : (
        <MessageList />
      )}
    </div>
  );
}
