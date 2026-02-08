import { useState, useEffect, memo } from "react";
import { codeToTokens, type ThemedToken } from "shiki";
import { Streamdown } from "streamdown";
import { createCodePlugin, type CodeHighlighterPlugin } from "@streamdown/code";
import { detectLanguage } from "../../lang-detect";
import { toolOverview } from "../../jsonl-convert";
import type { BundledLanguage } from "shiki";

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

/** Live-ticking duration display for in-progress background tasks. */
const LiveDuration = memo(function LiveDuration({ startTime }: { startTime: number }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  return <>{formatDuration(now - startTime)}</>;
});

/** Streamdown code plugin for rendering markdown in task results. */
function withAutoDetect(plugin: CodeHighlighterPlugin): CodeHighlighterPlugin {
  return {
    ...plugin,
    highlight(options, callback) {
      const lang = options.language;
      if (!lang || lang === "text" || lang === "plaintext" || !plugin.supportsLanguage(lang)) {
        const detected = detectLanguage(options.code) as BundledLanguage;
        if (detected !== "text" && plugin.supportsLanguage(detected)) {
          return plugin.highlight({ ...options, language: detected }, callback);
        }
      }
      return plugin.highlight(options, callback);
    },
  };
}
const sdCode = withAutoDetect(createCodePlugin({ themes: ["monokai", "monokai"] }));
const sdPlugins = { code: sdCode };

interface Props {
  kind: string;
  title: string;
  content: string;
  status: "pending" | "completed" | "failed";
  input?: unknown;
  agentId?: string;
  onNavigateToAgent?: () => void;
  startTime?: number;
  endTime?: number;
  isBackground?: boolean;
}

export function ToolCall({ kind, title, content, status, input, agentId, onNavigateToAgent, startTime, endTime, isBackground }: Props) {
  const overview = (!title && content) ? toolOverview(kind, content) : "";
  const rawDisplayTitle = title || overview || (content && content.length <= 100 ? content : "");
  const displayTitle = rawDisplayTitle ? stripKindPrefix(stripToolError(rawDisplayTitle).text, kind) : "";
  const isEdit = kind === "Edit";
  const isReadOrWrite = kind === "Read" || kind === "Write";
  const isSearch = kind === "Grep" || kind === "Glob";
  const hasDiff = isEdit && input && typeof input === "object" && "old_string" in (input as any);
  const hasCode = isReadOrWrite && content && content.length > 100;
  const hasSearchResults = isSearch && !!content;
  const taskResult = content ? parseTaskResult(content) : null;
  const expandable = hasDiff || hasCode || hasSearchResults || !!taskResult || (content && (title || content.length > 100));
  const [open, setOpen] = useState(false);

  // Background tasks: show live timer while running, final duration when done
  const isRunning = isBackground && status === "pending";
  const showDuration = isBackground && startTime != null;
  const statusLabel = isRunning
    ? undefined // replaced by live duration
    : status === "completed" ? "completed" : status === "failed" ? "failed" : "running";

  return (
    <div className="tool-call">
      <div
        className="tool-header cursor-pointer"
        onClick={() => expandable && setOpen(!open)}
      >
        <span className="tool-kind">{kind}</span>
        <span className="tool-title">{displayTitle}</span>
        {agentId && onNavigateToAgent && (
          <button
            className="agent-link"
            onClick={(e) => { e.stopPropagation(); onNavigateToAgent(); }}
            title={`View sub-agent ${agentId}`}
          >
            {agentId.slice(0, 7)} →
          </button>
        )}
        {isRunning && startTime != null ? (
          <span className="tool-status pending"><LiveDuration startTime={startTime} /></span>
        ) : (
          <span className={`tool-status ${status}`}>
            {statusLabel}
            {showDuration && endTime != null && startTime != null && (
              <span className="tool-duration"> {formatDuration(endTime - startTime)}</span>
            )}
          </span>
        )}
      </div>
      {open && hasDiff && (
        <DiffView input={input as Record<string, unknown>} filePath={title} />
      )}
      {open && hasCode && (
        <CodeView content={content} filePath={title} />
      )}
      {open && hasSearchResults && (
        <SearchResultsView content={content} />
      )}
      {open && taskResult && (
        <TaskResultView data={taskResult} />
      )}
      {open && !hasDiff && !hasCode && !hasSearchResults && !taskResult && content && (
        <PlainContent content={content} />
      )}
    </div>
  );
}

// ── System reminder handling ────────────────

const SYSTEM_REMINDER_RE = /<system-reminder>([\s\S]*?)<\/system-reminder>/g;

function splitSystemReminders(text: string): { clean: string; reminders: string[] } {
  const reminders: string[] = [];
  const clean = text.replace(SYSTEM_REMINDER_RE, (_, body) => {
    reminders.push(body.trim());
    return "";
  }).trim();
  return { clean, reminders };
}

function SystemReminder({ text }: { text: string }) {
  return (
    <div className="sys-reminder">
      <span className="sys-reminder-badge">system-reminder</span>
      <span className="sys-reminder-text">{text}</span>
    </div>
  );
}

// ── Persisted output handling ────────────────

const PERSISTED_OUTPUT_RE = /<persisted-output>([\s\S]*?)(?:<\/persisted-output>|$)/;

interface PersistedOutputData {
  size: string;
  path: string;
  preview: string;
}

function parsePersistedOutput(text: string): { data: PersistedOutputData; rest: string } | null {
  const m = text.match(PERSISTED_OUTPUT_RE);
  if (!m) return null;
  const inner = m[1].trim();
  const sizeMatch = inner.match(/Output too large \(([^)]+)\)/);
  const pathMatch = inner.match(/Full output saved to:\s*(\S+)/);
  const previewMatch = inner.match(/Preview \(first [^)]+\):\s*([\s\S]*)/);

  if (!sizeMatch) return null;

  const rest = text.replace(PERSISTED_OUTPUT_RE, "").trim();
  return {
    data: {
      size: sizeMatch[1],
      path: pathMatch ? pathMatch[1] : "",
      preview: previewMatch ? previewMatch[1].trim() : "",
    },
    rest,
  };
}

function PersistedOutput({ data }: { data: PersistedOutputData }) {
  const hasAnsi = /\x1b\[/.test(data.preview);
  return (
    <div className="persisted-output">
      <div className="persisted-output-header">
        <span className="persisted-output-badge">truncated</span>
        <span className="persisted-output-size">Output too large ({data.size})</span>
      </div>
      {data.path && <div className="persisted-output-path">{data.path}</div>}
      {data.preview && (
        <div className="persisted-output-preview">
          {hasAnsi ? <AnsiText text={data.preview} /> : data.preview}
        </div>
      )}
    </div>
  );
}

/** Strip redundant tool-name prefix from live-session titles (e.g. "Read /path" → "/path"). */
function stripKindPrefix(text: string, kind: string): string {
  if (!kind) return text;
  // Match "Read ", "Edit ", "Write ", "grep ", "Find " etc. at start (case-insensitive)
  const re = new RegExp(`^${kind}\\s+`, "i");
  return text.replace(re, "");
}

/** Strip <tool_use_error> tags, returning the inner text. */
function stripToolError(text: string): { text: string; isError: boolean } {
  const m = text.match(/<tool_use_error>([\s\S]*?)<\/tool_use_error>/);
  if (m) return { text: m[1].trim(), isError: true };
  return { text, isError: false };
}

function PlainContent({ content }: { content: string }) {
  const { clean: rawClean, reminders } = splitSystemReminders(content);
  const { text: clean, isError } = stripToolError(rawClean);
  const persisted = parsePersistedOutput(clean);

  if (persisted) {
    return (
      <div className="tool-content">
        <PersistedOutput data={persisted.data} />
        {persisted.rest && <div>{persisted.rest}</div>}
        {reminders.map((r, i) => <SystemReminder key={i} text={r} />)}
      </div>
    );
  }

  const hasAnsi = /\x1b\[/.test(clean);
  return (
    <div className={`tool-content${isError ? " tool-error" : ""}`}>
      {clean && (hasAnsi ? <AnsiText text={clean} /> : <pre className="ansi-text">{clean}</pre>)}
      {reminders.map((r, i) => <SystemReminder key={i} text={r} />)}
    </div>
  );
}

// ── ANSI escape code rendering ──────────────

/** Standard 8-color palette (SGR 30-37 / 40-47). */
const ANSI_COLORS = [
  "#000", "#c23621", "#25bc26", "#bbbb00",
  "#492ee1", "#d338d3", "#33bbc8", "#cbcccd",
];
/** Bright 8-color palette (SGR 90-97 / 100-107). */
const ANSI_BRIGHT = [
  "#666", "#ff6e67", "#5ff967", "#fefb67",
  "#6871ff", "#ff76ff", "#5ffdff", "#fefefe",
];

/** 256-color palette lookup. */
function color256(n: number): string | undefined {
  if (n < 8) return ANSI_COLORS[n];
  if (n < 16) return ANSI_BRIGHT[n - 8];
  if (n < 232) {
    // 6x6x6 color cube
    const idx = n - 16;
    const r = Math.floor(idx / 36), g = Math.floor((idx % 36) / 6), b = idx % 6;
    const ch = (v: number) => v === 0 ? 0 : 55 + v * 40;
    return `rgb(${ch(r)},${ch(g)},${ch(b)})`;
  }
  // Grayscale ramp 232-255
  const v = 8 + (n - 232) * 10;
  return `rgb(${v},${v},${v})`;
}

interface AnsiSpan {
  text: string;
  style: React.CSSProperties;
}

/** Parse ANSI SGR escape codes into styled spans. */
function parseAnsi(text: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  let fg: string | undefined;
  let bg: string | undefined;
  let bold = false;
  let dim = false;
  let italic = false;
  let underline = false;
  let strikethrough = false;

  // Split on ESC[ ... m sequences
  const parts = text.split(/\x1b\[([0-9;]*)m/);

  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      // Text segment
      if (parts[i]) {
        const style: React.CSSProperties = {};
        if (fg) style.color = fg;
        if (bg) style.backgroundColor = bg;
        if (bold) style.fontWeight = "bold";
        if (dim) style.opacity = 0.6;
        if (italic) style.fontStyle = "italic";
        if (underline) style.textDecoration = "underline";
        if (strikethrough) style.textDecoration = (style.textDecoration ? style.textDecoration + " line-through" : "line-through");
        spans.push({ text: parts[i], style });
      }
    } else {
      // SGR parameter segment
      const codes = parts[i] ? parts[i].split(";").map(Number) : [0];
      for (let j = 0; j < codes.length; j++) {
        const c = codes[j];
        if (c === 0) { fg = bg = undefined; bold = dim = italic = underline = strikethrough = false; }
        else if (c === 1) bold = true;
        else if (c === 2) dim = true;
        else if (c === 3) italic = true;
        else if (c === 4) underline = true;
        else if (c === 9) strikethrough = true;
        else if (c === 22) { bold = false; dim = false; }
        else if (c === 23) italic = false;
        else if (c === 24) underline = false;
        else if (c === 29) strikethrough = false;
        else if (c >= 30 && c <= 37) fg = ANSI_COLORS[c - 30];
        else if (c === 38) {
          // Extended foreground: 38;5;N or 38;2;R;G;B
          if (codes[j + 1] === 5) { fg = color256(codes[j + 2] ?? 0); j += 2; }
          else if (codes[j + 1] === 2) { fg = `rgb(${codes[j+2]??0},${codes[j+3]??0},${codes[j+4]??0})`; j += 4; }
        }
        else if (c === 39) fg = undefined;
        else if (c >= 40 && c <= 47) bg = ANSI_COLORS[c - 40];
        else if (c === 48) {
          if (codes[j + 1] === 5) { bg = color256(codes[j + 2] ?? 0); j += 2; }
          else if (codes[j + 1] === 2) { bg = `rgb(${codes[j+2]??0},${codes[j+3]??0},${codes[j+4]??0})`; j += 4; }
        }
        else if (c === 49) bg = undefined;
        else if (c >= 90 && c <= 97) fg = ANSI_BRIGHT[c - 90];
        else if (c >= 100 && c <= 107) bg = ANSI_BRIGHT[c - 100];
      }
    }
  }

  return spans;
}

function AnsiText({ text }: { text: string }) {
  const spans = parseAnsi(text);
  return (
    <pre className="ansi-text">
      {spans.map((s, i) =>
        Object.keys(s.style).length > 0
          ? <span key={i} style={s.style}>{s.text}</span>
          : <span key={i}>{s.text}</span>
      )}
    </pre>
  );
}

// ── Task result parsing & view ──────────────

interface TaskResultData {
  taskId?: string;
  status?: string;
  summary?: string;
  body?: string;       // The main text body (output or result)
  taskType?: string;
  outputPath?: string;  // Full output file path for truncated results
}

/** Extract a simple XML tag value: `<tag>value</tag>` */
function xmlTag(text: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
  const m = text.match(re);
  return m ? m[1].trim() : undefined;
}

/**
 * Try to parse TaskOutput XML format:
 *   <retrieval_status>success</retrieval_status> <task_id>...</task_id> ...
 */
function parseTaskOutput(text: string): TaskResultData | null {
  if (!text.includes("<retrieval_status>") && !text.includes("<task_id>")) return null;
  const status = xmlTag(text, "status") || xmlTag(text, "retrieval_status");
  const taskId = xmlTag(text, "task_id");
  const taskType = xmlTag(text, "task_type");

  // <output> may contain truncated content — match greedily to end or closing tag
  let body: string | undefined;
  const outputMatch = text.match(/<output>([\s\S]*?)(?:<\/output>|$)/);
  if (outputMatch) body = outputMatch[1].trim();

  // Extract full output path from truncation notice
  let outputPath: string | undefined;
  const pathMatch = text.match(/Full output:\s*(\S+)/);
  if (pathMatch) outputPath = pathMatch[1].replace(/\]$/, "");

  return { taskId, status, taskType, body, outputPath };
}

/**
 * Try to parse task-notification XML format:
 *   <task-notification>...<task-id>...</task-id><status>...</status>...
 */
function parseTaskNotification(text: string): TaskResultData | null {
  if (!text.includes("<task-notification>") && !text.includes("<task-notification ")) return null;
  const taskId = xmlTag(text, "task-id");
  const status = xmlTag(text, "status");
  const summary = xmlTag(text, "summary");
  const body = xmlTag(text, "result");
  return { taskId, status, summary, body };
}

/** Detect and parse task-related XML from content. */
export function parseTaskResult(content: string): TaskResultData | null {
  return parseTaskOutput(content) || parseTaskNotification(content);
}

function TaskResultView({ data }: { data: TaskResultData }) {
  const statusClass = data.status === "completed" || data.status === "success"
    ? "completed"
    : data.status === "failed" || data.status === "error"
      ? "failed"
      : "pending";

  return (
    <div className="tool-content task-result-view">
      <div className="task-result-header">
        <span className={`task-result-status ${statusClass}`}>
          {data.status || "unknown"}
        </span>
        {data.taskId && (
          <span className="task-result-id">{data.taskId}</span>
        )}
        {data.taskType && (
          <span className="task-result-type">{data.taskType}</span>
        )}
      </div>
      {data.summary && (
        <div className="task-result-summary">{data.summary}</div>
      )}
      {data.outputPath && (
        <div className="task-result-path">{data.outputPath}</div>
      )}
      {data.body && (
        <div className="task-result-body">
          <Streamdown mode="static" isAnimating={false} plugins={sdPlugins}>
            {data.body}
          </Streamdown>
        </div>
      )}
    </div>
  );
}

// ── Shared utilities ────────────────────────

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
  py: "python", rs: "rust", go: "go", rb: "ruby",
  java: "java", kt: "kotlin", swift: "swift", c: "c", cpp: "cpp",
  h: "c", hpp: "cpp", cs: "csharp", php: "php",
  html: "html", css: "css", scss: "scss", less: "less",
  json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
  md: "markdown", sql: "sql", sh: "bash", bash: "bash", zsh: "bash",
  xml: "xml", svg: "xml", vue: "vue", svelte: "svelte",
};

function detectLang(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TO_LANG[ext] || "text";
}

function useShikiHighlight(code: string, lang: string) {
  const [lines, setLines] = useState<ThemedToken[][] | null>(null);

  useEffect(() => {
    let cancelled = false;
    codeToTokens(code, { lang, theme: "monokai" })
      .then((result) => {
        if (!cancelled) setLines(result.tokens);
      })
      .catch(() => {
        if (!cancelled) {
          setLines(code.split("\n").map((t) => [{ content: t, color: "#d4d4d4" } as ThemedToken]));
        }
      });
    return () => { cancelled = true; };
  }, [code, lang]);

  return lines;
}

// ── CodeView (Read tool) ────────────────────

interface ParsedLine {
  lineNo: string;
  text: string;
}

/** Parse cat -n style output: "   123→content" or "   123\tcontent" */
function parseCatOutput(content: string): { lines: ParsedLine[]; rawCode: string } {
  const rawLines = content.split("\n");
  const parsed: ParsedLine[] = [];
  const codeLines: string[] = [];

  for (const line of rawLines) {
    const m = line.match(/^\s*(\d+)[→\t](.*)$/);
    if (m) {
      parsed.push({ lineNo: m[1], text: m[2] });
      codeLines.push(m[2]);
    } else {
      parsed.push({ lineNo: "", text: line });
      codeLines.push(line);
    }
  }

  return { lines: parsed, rawCode: codeLines.join("\n") };
}

function CodeView({ content, filePath }: { content: string; filePath: string }) {
  const { clean, reminders } = splitSystemReminders(content);
  const lang = detectLang(filePath);
  const { lines: parsed, rawCode } = parseCatOutput(clean);
  const highlighted = useShikiHighlight(rawCode, lang);

  return (
    <div className="tool-content code-view">
      {parsed.map((line, i) => (
        <div key={i} className="code-line">
          {line.lineNo && <span className="code-lineno">{line.lineNo}</span>}
          <span className="code-text">
            {highlighted && highlighted[i]
              ? highlighted[i].map((tok, j) => (
                  <span key={j} style={{ color: tok.color }}>{tok.content || " "}</span>
                ))
              : (line.text || " ")}
          </span>
        </div>
      ))}
      {reminders.map((r, i) => <SystemReminder key={i} text={r} />)}
    </div>
  );
}

// ── SearchResultsView (Grep/Glob tool) ──────

interface SearchEntry {
  file: string;
  lineNo?: string;
  text?: string;
}

function parseSearchResults(content: string): { entries: SearchEntry[]; grouped: Map<string, SearchEntry[]>; hasContent: boolean } {
  const lines = content.split("\n").filter((l) => l.trim());
  const entries: SearchEntry[] = [];
  let hasContent = false;

  for (const line of lines) {
    // Try content mode: file:line:content
    const m = line.match(/^(.+?):(\d+):(.*)$/);
    if (m) {
      entries.push({ file: m[1], lineNo: m[2], text: m[3] });
      hasContent = true;
    } else {
      // File path only (files_with_matches or glob output)
      entries.push({ file: line.trim() });
    }
  }

  // Group by file
  const grouped = new Map<string, SearchEntry[]>();
  for (const entry of entries) {
    const existing = grouped.get(entry.file) || [];
    existing.push(entry);
    grouped.set(entry.file, existing);
  }

  return { entries, grouped, hasContent };
}

function SearchResultsView({ content }: { content: string }) {
  const { clean, reminders } = splitSystemReminders(content);
  const { entries, grouped, hasContent } = parseSearchResults(clean);

  if (!hasContent) {
    // File-only mode: simple list of paths
    return (
      <div className="tool-content search-view">
        {entries.map((entry, i) => (
          <div key={i} className="search-file-entry">{entry.file}</div>
        ))}
        {reminders.map((r, i) => <SystemReminder key={i} text={r} />)}
      </div>
    );
  }

  // Content mode: grouped by file with line numbers
  return (
    <div className="tool-content search-view">
      {Array.from(grouped.entries()).map(([file, matches], gi) => (
        <div key={gi} className="search-file-group">
          <div className="search-file-header">{file}</div>
          {matches.map((match, j) => (
            <div key={j} className="search-match-line">
              {match.lineNo && <span className="search-lineno">{match.lineNo}</span>}
              <span className="search-text">{match.text ?? ""}</span>
            </div>
          ))}
        </div>
      ))}
      {reminders.map((r, i) => <SystemReminder key={i} text={r} />)}
    </div>
  );
}

// ── DiffView (Edit tool) ────────────────────

interface HighlightedDiffLine {
  tokens: ThemedToken[];
  type: "removed" | "added";
}

function DiffView({ input, filePath }: { input: Record<string, unknown>; filePath: string }) {
  const oldStr = String(input.old_string ?? "");
  const newStr = String(input.new_string ?? "");
  const [lines, setLines] = useState<HighlightedDiffLine[] | null>(null);
  const lang = detectLang(filePath);

  useEffect(() => {
    let cancelled = false;
    const combined = oldStr + "\n" + newStr;
    codeToTokens(combined, { lang, theme: "monokai" })
      .then((result) => {
        if (cancelled) return;
        const oldLineCount = oldStr.split("\n").length;
        const highlighted: HighlightedDiffLine[] = [];
        for (let i = 0; i < result.tokens.length; i++) {
          highlighted.push({
            tokens: result.tokens[i],
            type: i < oldLineCount ? "removed" : "added",
          });
        }
        setLines(highlighted);
      })
      .catch(() => {
        if (cancelled) return;
        const fallback: HighlightedDiffLine[] = [
          ...oldStr.split("\n").map((t) => ({
            tokens: [{ content: t, color: "#d4d4d4" }] as ThemedToken[],
            type: "removed" as const,
          })),
          ...newStr.split("\n").map((t) => ({
            tokens: [{ content: t, color: "#d4d4d4" }] as ThemedToken[],
            type: "added" as const,
          })),
        ];
        setLines(fallback);
      });
    return () => { cancelled = true; };
  }, [oldStr, newStr, lang]);

  if (!lines) {
    return (
      <div className="tool-content diff-view">
        {oldStr.split("\n").map((line, i) => (
          <div key={`r${i}`} className="diff-line removed">
            <span className="diff-marker">-</span>
            <span className="diff-text">{line || " "}</span>
          </div>
        ))}
        {newStr.split("\n").map((line, i) => (
          <div key={`a${i}`} className="diff-line added">
            <span className="diff-marker">+</span>
            <span className="diff-text">{line || " "}</span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="tool-content diff-view">
      {lines.map((line, i) => (
        <div key={i} className={`diff-line ${line.type}`}>
          <span className="diff-marker">{line.type === "removed" ? "-" : "+"}</span>
          <span className="diff-text">
            {line.tokens.map((tok, j) => (
              <span key={j} style={{ color: tok.color }}>{tok.content || " "}</span>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}
