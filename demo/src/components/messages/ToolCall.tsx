import { useState } from "react";

interface Props {
  kind: string;
  title: string;
  content: string;
  status: "pending" | "completed" | "failed";
}

export function ToolCall({ kind, title, content, status }: Props) {
  const [open, setOpen] = useState(false);
  const statusLabel =
    status === "completed" ? "completed" : status === "failed" ? "failed" : "running";

  return (
    <div className="tool-call">
      <div
        className="tool-header cursor-pointer"
        onClick={() => content && setOpen(!open)}
      >
        <span className="tool-kind">{kind}</span>
        <span className="tool-title">{title}</span>
        <span className={`tool-status ${status}`}>{statusLabel}</span>
      </div>
      {open && content && <div className="tool-content">{content}</div>}
    </div>
  );
}
