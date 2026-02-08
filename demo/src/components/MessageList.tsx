import { useLayoutEffect } from "react";
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
  const { cancelQueued, resumeSubagent } = useWsActions();
  const { ref, onScroll, scrollToBottom } = useAutoScroll<HTMLDivElement>(state.messages, state.turnStatus);

  // Force scroll to bottom when the user sends a message, even if they had scrolled up
  const lastMsg = state.messages[state.messages.length - 1];
  const lastUserMsgId = lastMsg?.type === "message" && lastMsg.role === "user" ? lastMsg.id : undefined;
  useLayoutEffect(() => {
    if (lastUserMsgId) scrollToBottom();
  }, [lastUserMsgId, scrollToBottom]);

  // Derive parent session ID once for all assistant turns
  const parentSessionId = state.currentSessionId?.split(":subagent:")[0] ?? null;

  return (
    <div
      ref={ref}
      onScroll={onScroll}
      className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-1"
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
                isQueued={!!((entry as MessageEntry)._queueId && state.queuedMessages.includes((entry as MessageEntry)._queueId!))}
                onCancelQueued={cancelQueued}
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
  );
}
