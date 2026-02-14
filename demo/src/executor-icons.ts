import type { ExecutorType } from "./types";
import CLAUDE_CODE_ICON_PNG from "./assets/claudecode.png";
import CODEX_ICON_PNG from "./assets/codex.png";

export const CLAUDE_CODE_ICON = CLAUDE_CODE_ICON_PNG;
export const CODEX_ICON = CODEX_ICON_PNG;

export const EXECUTOR_ICONS: Record<ExecutorType, string> = {
  claude: CLAUDE_CODE_ICON,
  codex: CODEX_ICON,
};
