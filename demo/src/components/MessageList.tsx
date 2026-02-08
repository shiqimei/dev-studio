import { useWs } from "../context/WebSocketContext";
import { useAutoScroll } from "../hooks/useAutoScroll";
import { UserMessage } from "./messages/UserMessage";
import { AssistantTurn } from "./messages/AssistantTurn";
import { SystemMessage } from "./messages/SystemMessage";
import { Plan } from "./messages/Plan";
import { TurnStatusBar, CompletedBar } from "./TurnStatusBar";

export function MessageList() {
  const { state } = useWs();
  const { ref, onScroll } = useAutoScroll<HTMLDivElement>(state.messages, state.turnStatus);

  return (
    <div
      ref={ref}
      onScroll={onScroll}
      className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-1"
    >
      {state.messages.map((entry, idx) => {
        switch (entry.type) {
          case "message":
            return entry.role === "user" ? (
              <UserMessage key={entry.id} entry={entry} isLatest={idx === state.messages.length - 1} />
            ) : (
              <AssistantTurn
                key={entry.id}
                entry={entry}
                isLatest={idx === state.messages.length - 1}
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
      <TurnStatusBar />
    </div>
  );
}
