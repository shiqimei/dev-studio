import { useState, useRef, useLayoutEffect, type ReactNode } from "react";
import type { MessageEntry } from "../../types";

/** Collapsed height ≈ 5-6 lines of text at 1.5 line-height */
const COLLAPSED_HEIGHT = 130;

// ── XML tag parsing ─────────────────────────

/** Known XML tags in user messages from the CLI. */
const XML_TAG_RE =
  /<(local-command-caveat|command-name|command-message|command-args|local-command-stdout|system-reminder)>([\s\S]*?)<\/\1>/g;

/** Teammate message tags with attributes. */
const TEAMMATE_RE =
  /<teammate-message\s+([^>]*)>([\s\S]*?)<\/teammate-message>/g;

/** Extract attribute values from an opening tag's attribute string. */
function parseAttrs(attrStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of attrStr.matchAll(/(\w+)="([^"]*)"/g)) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

interface TextSegment { kind: "text"; text: string }
interface TagSegment { kind: "tag"; tag: string; content: string }
interface TeammateSegment {
  kind: "teammate";
  teammateId: string;
  color?: string;
  content: string;
}
type Segment = TextSegment | TagSegment | TeammateSegment;

function parseUserText(raw: string): Segment[] {
  // First pass: split on teammate-message tags
  TEAMMATE_RE.lastIndex = 0;
  const topSegments: Segment[] = [];
  let lastIndex = 0;
  for (const m of raw.matchAll(TEAMMATE_RE)) {
    const before = raw.slice(lastIndex, m.index);
    if (before) topSegments.push({ kind: "text", text: before });
    const attrs = parseAttrs(m[1]);
    topSegments.push({
      kind: "teammate",
      teammateId: attrs.teammate_id ?? "unknown",
      color: attrs.color,
      content: m[2],
    });
    lastIndex = m.index! + m[0].length;
  }
  const after = raw.slice(lastIndex);
  if (after) topSegments.push({ kind: "text", text: after });

  // Second pass: parse known CLI tags within text segments
  const segments: Segment[] = [];
  for (const seg of topSegments) {
    if (seg.kind !== "text") {
      segments.push(seg);
      continue;
    }
    XML_TAG_RE.lastIndex = 0;
    let idx = 0;
    for (const m of seg.text.matchAll(XML_TAG_RE)) {
      const before = seg.text.slice(idx, m.index);
      if (before) segments.push({ kind: "text", text: before });
      segments.push({ kind: "tag", tag: m[1], content: m[2] });
      idx = m.index! + m[0].length;
    }
    const rest = seg.text.slice(idx);
    if (rest) segments.push({ kind: "text", text: rest });
  }
  return segments;
}

function renderSegments(segments: Segment[]): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Collect command-* tags into a single command block
  let cmdName = "";
  let cmdArgs = "";

  function flushCommand() {
    if (!cmdName) return;
    nodes.push(
      <span key={`cmd-${nodes.length}`} className="user-command">
        {cmdName}{cmdArgs ? ` ${cmdArgs}` : ""}
      </span>,
    );
    cmdName = "";
    cmdArgs = "";
  }

  for (const seg of segments) {
    if (seg.kind === "text") {
      flushCommand();
      const trimmed = seg.text.trim();
      if (trimmed) nodes.push(<span key={nodes.length}>{trimmed}</span>);
    } else if (seg.kind === "teammate") {
      flushCommand();
      nodes.push(
        <TeammateBlock
          key={`tm-${nodes.length}`}
          teammateId={seg.teammateId}
          color={seg.color}
          content={seg.content}
        />,
      );
    } else {
      switch (seg.tag) {
        case "local-command-caveat":
        case "system-reminder":
          // Hide internal system boilerplate
          break;
        case "command-name":
          cmdName = seg.content.trim();
          break;
        case "command-message":
          // Redundant with command-name, skip
          break;
        case "command-args":
          cmdArgs = seg.content.trim();
          break;
        case "local-command-stdout": {
          flushCommand();
          const text = seg.content.trim();
          if (text) {
            nodes.push(
              <span key={nodes.length} className="user-stdout">{text}</span>,
            );
          }
          break;
        }
      }
    }
  }
  flushCommand();
  return nodes;
}

// ── Teammate message block ──────────────────

const TEAMMATE_COLORS: Record<string, string> = {
  green: "var(--color-green)",
  blue: "var(--color-blue)",
  purple: "var(--color-purple)",
  yellow: "var(--color-yellow)",
  red: "var(--color-red)",
};

/** Human-readable labels for known JSON message types. */
const TYPE_LABELS: Record<string, string> = {
  task_assignment: "Task Assignment",
  shutdown_request: "Shutdown Request",
  task_completed: "Task Completed",
  message: "Message",
  idle: "Idle",
};

/** Metadata keys to hide from the structured view. */
const META_KEYS = new Set(["type", "timestamp", "requestId", "assignedBy"]);

/** Try to parse a string as JSON. Returns null on failure. */
function tryParseJson(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s);
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  } catch { /* not JSON */ }
  return null;
}

/** Format a timestamp string to a short locale time. */
function fmtTime(ts: unknown): string {
  if (typeof ts !== "string") return "";
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch { return ts; }
}

function TeammateBlock({
  teammateId,
  color,
  content,
}: {
  teammateId: string;
  color?: string;
  content: string;
}) {
  const accent = TEAMMATE_COLORS[color ?? ""] ?? "var(--color-blue)";
  const trimmed = content.trim();
  const json = tryParseJson(trimmed);

  // Plain text content — render as-is
  if (!json || !json.type) {
    return (
      <div className="teammate-msg" style={{ borderColor: accent }}>
        <span className="teammate-badge" style={{ background: accent }}>
          {teammateId}
        </span>
        <span className="teammate-content">{trimmed}</span>
      </div>
    );
  }

  const typeStr = String(json.type);
  const label = TYPE_LABELS[typeStr] ?? typeStr.replace(/_/g, " ");
  const ts = json.timestamp ? fmtTime(json.timestamp) : "";

  // Collect display fields (non-meta)
  const fields = Object.entries(json).filter(([k]) => !META_KEYS.has(k));

  return (
    <div className="teammate-msg" style={{ borderColor: accent }}>
      <div className="teammate-header">
        <span className="teammate-badge" style={{ background: accent }}>
          {teammateId}
        </span>
        <span className="teammate-type">{label}</span>
        {ts && <span className="teammate-time">{ts}</span>}
      </div>
      <div className="teammate-fields">
        {fields.map(([k, v]) => (
          <div key={k} className="teammate-field">
            <span className="teammate-field-key">{k}</span>
            <span className="teammate-field-val">{String(v)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Returns true if text contains any known XML tags. */
function hasXmlTags(text: string): boolean {
  // Reset lastIndex since these are global regexes
  XML_TAG_RE.lastIndex = 0;
  TEAMMATE_RE.lastIndex = 0;
  return XML_TAG_RE.test(text) || TEAMMATE_RE.test(text);
}

// ── Component ───────────────────────────────

interface Props {
  entry: MessageEntry;
  isLatest: boolean;
}

export function UserMessage({ entry, isLatest }: Props) {
  const [preview, setPreview] = useState<string | null>(null);
  const [userExpanded, setUserExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const textRef = useRef<HTMLDivElement>(null);
  const expanded = userExpanded || isLatest;

  const images = entry.content.filter((b) => b.type === "image");
  const textParts = entry.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text);
  const text = textParts.join("\n");

  useLayoutEffect(() => {
    if (textRef.current) {
      setOverflows(textRef.current.scrollHeight > COLLAPSED_HEIGHT);
    }
  }, [text]);

  const collapsed = !expanded && overflows;

  // Parse XML tags if present
  const hadXml = hasXmlTags(text);
  const segments = hadXml ? parseUserText(text) : null;
  const rendered = segments ? renderSegments(segments) : null;
  const showParsed = rendered && rendered.length > 0;
  // If XML was detected but all tags were hidden/empty, suppress the text entirely
  const hideText = hadXml && !showParsed;

  // Hide the entire bubble if nothing to show (all-hidden XML, no images)
  if (hideText && images.length === 0) return null;

  return (
    <div className="msg user">
      {images.length > 0 && (
        <div className="flex gap-2 mb-2 flex-wrap">
          {images.map((img, i) => {
            const src = `data:${(img as any).mimeType};base64,${(img as any).data}`;
            return (
              <img
                key={i}
                src={src}
                alt={`Attached image ${i + 1}`}
                className="max-h-48 max-w-64 rounded-md border border-border object-contain cursor-pointer hover:opacity-80 transition-opacity"
                onClick={() => setPreview(src)}
              />
            );
          })}
        </div>
      )}
      {text && !hideText && (
        <div className="user-text-wrap">
          <div
            ref={textRef}
            className={collapsed ? "user-text-collapsed" : undefined}
          >
            {showParsed ? rendered : text}
          </div>
          {collapsed && (
            <div className="user-text-overlay" onClick={() => setUserExpanded(true)}>
              <span>Show more</span>
            </div>
          )}
          {overflows && expanded && !isLatest && (
            <button className="user-collapse-btn" onClick={() => setUserExpanded(false)}>
              Show less
            </button>
          )}
        </div>
      )}
      {preview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 cursor-pointer"
          onClick={() => setPreview(null)}
        >
          <img
            src={preview}
            alt="Preview"
            className="max-h-[90vh] max-w-[90vw] object-contain rounded-lg"
          />
        </div>
      )}
    </div>
  );
}
