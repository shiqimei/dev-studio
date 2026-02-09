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
  const { ref, onScroll, scrollToBottom } = useAutoScroll<HTMLDivElement>(state.messages, state.turnStatus);

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
      className="chat-scroll-list px-5 py-4 flex flex-col gap-1"
    >
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
    <div ref={scrollThumbRef} className="sidebar-scroll-thumb" />
    </div>
  );
}
