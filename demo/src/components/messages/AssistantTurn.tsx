import type { MessageEntry } from "../../types";
import { AssistantMessage } from "./AssistantMessage";
import { ThoughtMessage } from "./ThoughtMessage";
import { ToolCall } from "./ToolCall";

interface Props {
  entry: MessageEntry;
}

export function AssistantTurn({ entry }: Props) {
  return (
    <>
      {entry.content.map((block, i) => {
        switch (block.type) {
          case "text":
            return (
              <AssistantMessage
                key={i}
                text={block.text}
                done={!block._streaming}
              />
            );
          case "thinking":
            return <ThoughtMessage key={i} text={block.thinking} />;
          case "tool_use":
            return (
              <ToolCall
                key={i}
                kind={block.name}
                title={block.title || ""}
                content={block.result || ""}
                status={block.status || "completed"}
              />
            );
          default:
            return null;
        }
      })}
    </>
  );
}
