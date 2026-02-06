import { useState, useEffect } from "react";
import { codeToTokens, type ThemedToken } from "shiki";
import { toolOverview } from "../../jsonl-convert";

interface Props {
  kind: string;
  title: string;
  content: string;
  status: "pending" | "completed" | "failed";
  input?: unknown;
  agentId?: string;
  onNavigateToAgent?: () => void;
}

export function ToolCall({ kind, title, content, status, input, agentId, onNavigateToAgent }: Props) {
  const overview = (!title && content) ? toolOverview(kind, content) : "";
  const displayTitle = title || overview || (content && content.length <= 100 ? content : "");
  const isEdit = kind === "Edit";
  const isReadOrWrite = kind === "Read" || kind === "Write";
  const isSearch = kind === "Grep" || kind === "Glob";
  const hasDiff = isEdit && input && typeof input === "object" && "old_string" in (input as any);
  const hasCode = isReadOrWrite && content && content.length > 100;
  const hasSearchResults = isSearch && !!content;
  const expandable = hasDiff || hasCode || hasSearchResults || (content && (title || content.length > 100));
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
        {agentId && onNavigateToAgent && (
          <button
            className="agent-link"
            onClick={(e) => { e.stopPropagation(); onNavigateToAgent(); }}
            title={`View sub-agent ${agentId}`}
          >
            {agentId.slice(0, 7)} →
          </button>
        )}
        <span className={`tool-status ${status}`}>{statusLabel}</span>
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
      {open && !hasDiff && !hasCode && !hasSearchResults && content && (
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

function PlainContent({ content }: { content: string }) {
  const { clean, reminders } = splitSystemReminders(content);
  return (
    <div className="tool-content">
      {clean && <div>{clean}</div>}
      {reminders.map((r, i) => <SystemReminder key={i} text={r} />)}
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
