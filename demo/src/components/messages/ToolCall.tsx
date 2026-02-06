import { useState, useEffect } from "react";
import { codeToTokens, type ThemedToken } from "shiki";

interface Props {
  kind: string;
  title: string;
  content: string;
  status: "pending" | "completed" | "failed";
  input?: unknown;
}

export function ToolCall({ kind, title, content, status, input }: Props) {
  // Show short result text inline when there's no input-derived title
  const displayTitle = title || (content && content.length <= 100 ? content : "");
  const isEdit = kind === "Edit";
  const hasDiff = isEdit && input && typeof input === "object" && "old_string" in (input as any);
  const expandable = hasDiff || (content && (title || content.length > 100));
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
      {open && hasDiff && (
        <DiffView input={input as Record<string, unknown>} filePath={title} />
      )}
      {open && !hasDiff && content && <div className="tool-content">{content}</div>}
    </div>
  );
}

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

interface HighlightedLine {
  tokens: ThemedToken[];
  type: "removed" | "added";
}

function DiffView({ input, filePath }: { input: Record<string, unknown>; filePath: string }) {
  const oldStr = String(input.old_string ?? "");
  const newStr = String(input.new_string ?? "");
  const [lines, setLines] = useState<HighlightedLine[] | null>(null);
  const lang = detectLang(filePath);

  useEffect(() => {
    let cancelled = false;
    // Combine both strings for highlighting so Shiki sees full context
    const combined = oldStr + "\n" + newStr;
    codeToTokens(combined, { lang, theme: "monokai" })
      .then((result) => {
        if (cancelled) return;
        const oldLineCount = oldStr.split("\n").length;
        const highlighted: HighlightedLine[] = [];
        for (let i = 0; i < result.tokens.length; i++) {
          if (i < oldLineCount) {
            highlighted.push({ tokens: result.tokens[i], type: "removed" });
          } else {
            highlighted.push({ tokens: result.tokens[i], type: "added" });
          }
        }
        setLines(highlighted);
      })
      .catch(() => {
        // Fallback: plain text
        if (cancelled) return;
        const fallback: HighlightedLine[] = [
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
    // Plain-text fallback while loading
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
