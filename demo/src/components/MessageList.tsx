import { useWs } from "../context/WebSocketContext";
import { useAutoScroll } from "../hooks/useAutoScroll";
import { UserMessage } from "./messages/UserMessage";
import { AssistantTurn } from "./messages/AssistantTurn";
import { SystemMessage } from "./messages/SystemMessage";
import { Plan } from "./messages/Plan";
import { Permission } from "./messages/Permission";

export function MessageList() {
  const { state } = useWs();
  const { ref, onScroll } = useAutoScroll<HTMLDivElement>(state.messages);

  return (
    <div
      ref={ref}
      onScroll={onScroll}
      className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-1"
    >
      {state.messages.map((entry) => {
        switch (entry.type) {
          case "message":
            return entry.role === "user" ? (
              <UserMessage key={entry.id} entry={entry} />
            ) : (
              <AssistantTurn key={entry.id} entry={entry} />
            );
          case "system":
            return <SystemMessage key={entry.id} text={entry.text} />;
          case "plan":
            return <Plan key={entry.id} entries={entry.entries} />;
          case "permission":
            return <Permission key={entry.id} title={entry.title} />;
        }
      })}
    </div>
  );
}
