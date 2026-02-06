import { useState } from "react";

interface Props {
  kind: string;
  title: string;
  content: string;
  status: "pending" | "completed" | "failed";
}

export function ToolCall({ kind, title, content, status }: Props) {
  // Show short result text inline when there's no input-derived title
  const displayTitle = title || (content && content.length <= 100 ? content : "");
  const expandable = content && (title || content.length > 100);
  const [open, setOpen] = useState(false);
  const statusLabel =
    status === "completed" ? "completed" : status === "failed" ? "failed" : "running";

  return (
    <div className="tool-call">
      <div
        className="tool-header cursor-pointer"
        onClick={() => expandable && setOpen(!open)}
      >
        <span className="tool-kind">{kind}</span>
        <span className="tool-title">{displayTitle}</span>
        <span className={`tool-status ${status}`}>{statusLabel}</span>
      </div>
      {open && content && <div className="tool-content">{content}</div>}
    </div>
  );
}
