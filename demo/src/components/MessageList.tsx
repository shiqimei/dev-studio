import { useLayoutEffect, useRef, useCallback } from "react";
import { useWsState, useWsActions } from "../context/WebSocketContext";
import { useAutoScroll } from "../hooks/useAutoScroll";
import { UserMessage } from "./messages/UserMessage";
import { AssistantTurn } from "./messages/AssistantTurn";
import { SystemMessage } from "./messages/SystemMessage";
import { Plan } from "./messages/Plan";
import { TurnStatusBar, CompletedBar } from "./TurnStatusBar";
import type { MessageEntry } from "../types";

export function MessageList() {
  const state = useWsState();
  const { resumeSubagent } = useWsActions();
  const { ref, onScroll, scrollToBottom, isAtBottom } = useAutoScroll<HTMLDivElement>(state.messages, state.turnStatus);

  // Force scroll to bottom when the user sends a message, even if they had scrolled up
  const lastMsg = state.messages[state.messages.length - 1];
  const lastUserMsgId = lastMsg?.type === "message" && lastMsg.role === "user" ? lastMsg.id : undefined;
  useLayoutEffect(() => {
    if (lastUserMsgId) scrollToBottom();
  }, [lastUserMsgId, scrollToBottom]);

  // Derive parent session ID once for all assistant turns
  const parentSessionId = state.currentSessionId?.split(":subagent:")[0] ?? null;

  // Custom overlay scrollbar
  const scrollThumbRef = useRef<HTMLDivElement>(null);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    onScroll();
    const el = e.currentTarget;
    const thumb = scrollThumbRef.current;
    if (!thumb) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    if (scrollHeight <= clientHeight) {
      thumb.style.opacity = "0";
      return;
    }
    thumb.style.opacity = "1";
    const ratio = clientHeight / scrollHeight;
    const thumbH = Math.max(ratio * clientHeight, 24);
    const maxScroll = scrollHeight - clientHeight;
    const thumbTop = (scrollTop / maxScroll) * (clientHeight - thumbH);
    thumb.style.height = `${thumbH}px`;
    thumb.style.top = `${thumbTop}px`;
    clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = setTimeout(() => {
      thumb.style.opacity = "0";
    }, 800);
  }, [onScroll]);

  return (
    <div className="chat-scroll-wrap">
    <div
      ref={ref}
      onScroll={handleScroll}
      className="chat-scroll-list px-5 py-4"
    >
      <div className="chat-content flex flex-col gap-1">
      {state.messages.map((entry, idx) => {
        const isLatest = idx === state.messages.length - 1;
        switch (entry.type) {
          case "message":
            return entry.role === "user" ? (
              <UserMessage
                key={entry.id}
                entry={entry}
                isLatest={isLatest}
              />
            ) : (
              <AssistantTurn
                key={entry.id}
                entry={entry}
                isLatest={isLatest}
                parentSessionId={parentSessionId}
                onResumeSubagent={resumeSubagent}
              />
            );
          case "system":
            return <SystemMessage key={entry.id} text={entry.text} isError={entry.isError} />;
          case "plan":
            return <Plan key={entry.id} entries={entry.entries} />;
          case "turn_completed":
            return <CompletedBar key={entry.id} status={{ status: "completed", startedAt: 0, durationMs: entry.durationMs, outputTokens: entry.outputTokens, thinkingDurationMs: entry.thinkingDurationMs, costUsd: entry.costUsd }} />;
          case "permission":
            return null;
        }
      })}
      <TurnStatusBar status={state.turnStatus} />
      </div>
    </div>
    <div ref={scrollThumbRef} className="sidebar-scroll-thumb" />
    <button
      className={`scroll-to-bottom ${isAtBottom ? "" : "visible"}`}
      onClick={scrollToBottom}
      aria-label="Scroll to bottom"
    >
      <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path d="M10 3C10.2761 3.00006 10.5 3.2239 10.5 3.5V15.293L14.6465 11.1465C14.8418 10.9514 15.1583 10.9513 15.3536 11.1465C15.5487 11.3417 15.5486 11.6583 15.3536 11.8535L10.3535 16.8535C10.2598 16.9473 10.1326 17 10 17C9.90062 17 9.8042 16.9703 9.72268 16.916L9.64651 16.8535L4.6465 11.8535C4.45138 11.6582 4.45128 11.3417 4.6465 11.1465C4.84172 10.9513 5.15827 10.9514 5.35353 11.1465L9.50003 15.293V3.5C9.50003 3.22386 9.72389 3 10 3Z" />
      </svg>
    </button>
    </div>
  );
}
