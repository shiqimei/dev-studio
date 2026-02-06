import { Streamdown } from "streamdown";
import { createCodePlugin, type CodeHighlighterPlugin } from "@streamdown/code";
import { detectLanguage } from "../../lang-detect";
import { stripCliXml } from "../../strip-xml";
import type { BundledLanguage } from "shiki";

/** Wrap the code plugin to auto-detect language for untagged code blocks. */
function withAutoDetect(plugin: CodeHighlighterPlugin): CodeHighlighterPlugin {
  return {
    ...plugin,
    highlight(options, callback) {
      const lang = options.language;
      // If language is missing or not supported, detect from content
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

const code = withAutoDetect(createCodePlugin({ themes: ["monokai", "monokai"] }));
const plugins = { code };

interface Props {
  text: string;
  done: boolean;
}

export function AssistantMessage({ text, done }: Props) {
  const clean = stripCliXml(text);
  if (!clean) return null;
  return (
    <div className="msg assistant">
      <Streamdown mode="streaming" isAnimating={!done} plugins={plugins}>
        {clean}
      </Streamdown>
    </div>
  );
}
