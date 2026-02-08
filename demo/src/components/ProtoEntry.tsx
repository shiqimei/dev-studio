import { useState, useMemo } from "react";
import { escapeHtml, syntaxHighlight } from "../utils";
import type { ProtoEntry as ProtoEntryType } from "../types";

interface Props {
  entry: ProtoEntryType;
  startTime: number;
  sendTimestamps?: Map<string, number>;
}

export function ProtoEntry({ entry, startTime, sendTimestamps }: Props) {
  const [open, setOpen] = useState(false);

  // For RCV entries with a matching SND, show the method round-trip duration.
  // For everything else, show cumulative time since session start.
  let elapsed: string;
  const sendTs = entry.dir === "recv" && entry.msgId ? sendTimestamps?.get(entry.msgId) : undefined;
  if (sendTs != null) {
    const durationMs = entry.ts - sendTs;
    elapsed = durationMs < 1000
      ? Math.round(durationMs) + "ms"
      : (durationMs / 1000).toFixed(2) + "s";
  } else {
    elapsed = ((entry.ts - startTime) / 1000).toFixed(2) + "s";
  }

  const highlighted = useMemo(() => {
    const json = JSON.stringify(entry.msg, null, 2);
    return syntaxHighlight(escapeHtml(json));
  }, [entry.msg]);

  return (
    <div className={`proto-entry${open ? " open" : ""}`}>
      <div className="proto-summary" onClick={() => setOpen(!open)}>
        <span className="proto-arrow">{"\u25B6"}</span>
        <span className={`proto-dir ${entry.dir}`}>
          {entry.dir === "send" ? "SND \u2192" : "RCV \u2190"}
        </span>
        <span className="proto-method">{entry.method}</span>
        <span className="proto-id">{entry.msgId}</span>
        <span className="proto-time">{elapsed}</span>
      </div>
      {open && (
        <div className="proto-body" style={{ display: "block" }}>
          <pre dangerouslySetInnerHTML={{ __html: highlighted }} />
        </div>
      )}
    </div>
  );
}
