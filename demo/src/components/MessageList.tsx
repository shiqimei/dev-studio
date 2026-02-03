import { useWs } from "../context/WebSocketContext";
import { useAutoScroll } from "../hooks/useAutoScroll";
import { UserMessage } from "./messages/UserMessage";
import { AssistantMessage } from "./messages/AssistantMessage";
import { ThoughtMessage } from "./messages/ThoughtMessage";
import { SystemMessage } from "./messages/SystemMessage";
import { ToolCall } from "./messages/ToolCall";
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
      {state.messages.map((msg) => {
        switch (msg.type) {
          case "user":
            return <UserMessage key={msg.id} text={msg.text} />;
          case "assistant":
            return (
              <AssistantMessage
                key={msg.id}
                text={msg.text}
                done={msg.done}
              />
            );
          case "thought":
            return <ThoughtMessage key={msg.id} text={msg.text} />;
          case "system":
            return <SystemMessage key={msg.id} text={msg.text} />;
          case "tool_call":
            return (
              <ToolCall
                key={msg.id}
                kind={msg.kind}
                title={msg.title}
                content={msg.content}
                status={msg.status}
              />
            );
          case "plan":
            return <Plan key={msg.id} entries={msg.entries} />;
          case "permission":
            return <Permission key={msg.id} title={msg.title} />;
        }
      })}
    </div>
  );
}
