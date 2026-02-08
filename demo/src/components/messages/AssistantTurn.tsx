import type { MessageEntry } from "../../types";
import { useWs } from "../../context/WebSocketContext";
import { AssistantMessage } from "./AssistantMessage";
import { ThoughtMessage } from "./ThoughtMessage";
import { ToolCall, parseTaskResult } from "./ToolCall";
import { TaskNotification } from "./TaskNotification";

interface Props {
  entry: MessageEntry;
  isLatest: boolean;
}

export function AssistantTurn({ entry, isLatest }: Props) {
  const { state, resumeSubagent } = useWs();

  // Extract the parent session UUID (strip composite subagent suffix)
  const parentSessionId = state.currentSessionId?.split(":subagent:")[0] ?? null;

  return (
    <>
      {entry.content.map((block, i) => {
        switch (block.type) {
          case "text": {
            const taskData = block.text.includes("<task-notification") ? parseTaskResult(block.text) : null;
            if (taskData && taskData.status) {
              return <TaskNotification key={i} text={block.text} />;
            }
            return (
              <AssistantMessage
                key={i}
                text={block.text}
                done={!block._streaming}
              />
            );
          }
          case "thinking":
            return (
              <ThoughtMessage key={i} text={block.thinking} isLatest={isLatest} />
            );
          case "tool_use":
            return (
              <ToolCall
                key={i}
                kind={block.name}
                title={block.title || ""}
                content={block.result || ""}
                status={block.status || "completed"}
                input={block.input}
                agentId={block.agentId}
                onNavigateToAgent={
                  block.agentId && parentSessionId
                    ? () => resumeSubagent(parentSessionId!, block.agentId!)
                    : undefined
                }
                startTime={block.startTime}
                endTime={block.endTime}
                isBackground={block.isBackground}
              />
            );
          default:
            return null;
        }
      })}
    </>
  );
}
