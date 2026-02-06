import { Streamdown } from "streamdown";
import { createCodePlugin, type CodeHighlighterPlugin } from "@streamdown/code";
import { detectLanguage } from "../../lang-detect";
import { parseTaskResult } from "./ToolCall";
import type { BundledLanguage } from "shiki";

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

const STATUS_COLORS: Record<string, string> = {
  completed: "var(--color-green)",
  success: "var(--color-green)",
  failed: "var(--color-red)",
  error: "var(--color-red)",
};

interface Props {
  text: string;
}

export function TaskNotification({ text }: Props) {
  const data = parseTaskResult(text);
  if (!data) return null;

  const status = data.status || "pending";
  const accent = STATUS_COLORS[status] ?? "var(--color-yellow)";

  return (
    <div className="teammate-msg" style={{ borderColor: accent }}>
      <div className="teammate-header">
        {data.taskId && (
          <span className="teammate-badge" style={{ background: accent }}>
            {data.taskId}
          </span>
        )}
        <span className="teammate-type">
          {data.summary || `Task ${status}`}
        </span>
      </div>
      {data.body && (
        <div className="task-notification-body">
          <Streamdown mode="static" isAnimating={false} plugins={sdPlugins}>
            {data.body}
          </Streamdown>
        </div>
      )}
    </div>
  );
}
