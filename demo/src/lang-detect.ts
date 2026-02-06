/**
 * Infer programming language from code content using pattern matching.
 * Returns a Shiki-compatible language identifier.
 */

interface LangPattern {
  lang: string;
  /** Patterns that strongly indicate this language */
  strong: RegExp[];
  /** Patterns that weakly indicate (need multiple matches) */
  weak?: RegExp[];
}

const PATTERNS: LangPattern[] = [
  // ── HTML / XML ────────────────────────────
  {
    lang: "html",
    strong: [
      /^\s*<!DOCTYPE\s+html/im,
      /^\s*<html[\s>]/im,
      /<\/(div|span|body|head|html|section|article|nav|header|footer|form|table|ul|ol|li|p|h[1-6])>/i,
    ],
  },
  {
    lang: "xml",
    strong: [/^\s*<\?xml\s/m, /^\s*<[a-z][\w.-]*\s+xmlns[=:]/im],
  },
  // ── SVG ───────────────────────────────────
  {
    lang: "svg",
    strong: [/<svg[\s>]/i, /<\/svg>/i],
  },
  // ── JSON ──────────────────────────────────
  {
    lang: "json",
    strong: [/^\s*[\[{]\s*"[\w$-]+"\s*:/m],
  },
  // ── YAML ──────────────────────────────────
  {
    lang: "yaml",
    strong: [/^---\s*$/m],
    weak: [/^\w[\w.-]*:\s+\S/m, /^\s+-\s+\w/m],
  },
  // ── TOML ──────────────────────────────────
  {
    lang: "toml",
    strong: [/^\s*\[[\w.-]+\]\s*$/m],
    weak: [/^\w[\w.-]*\s*=\s*["'\d\[{]/m],
  },
  // ── SQL ───────────────────────────────────
  {
    lang: "sql",
    strong: [
      /\b(SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE)\b/i,
    ],
    weak: [/\bFROM\b/i, /\bWHERE\b/i, /\bJOIN\b/i, /\bGROUP\s+BY\b/i],
  },
  // ── GraphQL ───────────────────────────────
  {
    lang: "graphql",
    strong: [
      /^\s*(query|mutation|subscription|fragment)\s+\w+/m,
      /^\s*type\s+\w+\s*\{/m,
    ],
  },
  // ── CSS / SCSS / Less ─────────────────────
  {
    lang: "css",
    strong: [
      /^\s*@(media|keyframes|import|font-face|charset)\b/m,
      /^\s*[\w.#\[:*][^{]*\{\s*[\w-]+\s*:/m,
    ],
  },
  {
    lang: "scss",
    strong: [/^\s*\$[\w-]+\s*:/m, /^\s*@mixin\s+\w/m, /^\s*@include\s+\w/m],
  },
  // ── Shell / Bash ──────────────────────────
  {
    lang: "bash",
    strong: [
      /^#!\s*\/bin\/(ba)?sh/m,
      /^#!\s*\/usr\/bin\/env\s+(ba)?sh/m,
      /^\s*(if|then|fi|elif|else|for|do|done|while|case|esac)\b.*[;\s]*$/m,
    ],
    weak: [
      /^\s*\$\s+\w/m,
      /^\s*(export|alias|source|echo|printf|set\s+-[euxo])\b/m,
      /^\s*(git|npm|npx|yarn|pnpm|bun|pip|cargo|docker|kubectl|curl|wget|mkdir|cd|ls|rm|cp|mv|chmod|chown|grep|sed|awk|cat|head|tail)\b/m,
      /\|\s*(grep|awk|sed|sort|uniq|head|tail|wc|xargs|tee)\b/,
      /&&\s*(cd|echo|git|npm)\b/,
    ],
  },
  // ── Dockerfile ────────────────────────────
  {
    lang: "dockerfile",
    strong: [/^\s*FROM\s+[\w./-]+/m],
    weak: [/^\s*(RUN|CMD|ENTRYPOINT|COPY|ADD|EXPOSE|ENV|WORKDIR|ARG)\b/m],
  },
  // ── Python ────────────────────────────────
  {
    lang: "python",
    strong: [
      /^#!\s*\/usr\/bin\/env\s+python/m,
      /^\s*def\s+\w+\(.*\)\s*(->.*)?:\s*$/m,
      /^\s*class\s+\w+.*:\s*$/m,
      /^\s*from\s+[\w.]+\s+import\b/m,
      /^\s*import\s+[\w.]+\s*$/m,
    ],
    weak: [
      /^\s*(elif|except|finally|raise|yield|lambda|with\s+\w+\s+as|async\s+def|await)\b/m,
      /^\s*@\w+/m,
      /\bself\.\w+/,
      /\bprint\s*\(/,
      /\b(True|False|None)\b/,
      /\bdef\s+__\w+__/,
    ],
  },
  // ── Ruby ──────────────────────────────────
  {
    lang: "ruby",
    strong: [
      /^#!\s*\/usr\/bin\/env\s+ruby/m,
      /^\s*require\s+['"][\w/]+['"]/m,
      /^\s*class\s+\w+\s*(<\s*\w+)?\s*$/m,
      /^\s*module\s+\w+\s*$/m,
    ],
    weak: [
      /^\s*def\s+\w+/m,
      /^\s*end\s*$/m,
      /\bdo\s*\|/,
      /\b(puts|attr_accessor|attr_reader|require_relative)\b/,
    ],
  },
  // ── Rust ──────────────────────────────────
  {
    lang: "rust",
    strong: [
      /^\s*fn\s+\w+/m,
      /^\s*use\s+(std|crate|super|self)::/m,
      /^\s*impl\b/m,
      /^\s*#\[(derive|cfg|test|allow|warn|deny)\b/m,
      /^\s*pub\s+(fn|struct|enum|trait|mod|use|type|const|static)\b/m,
    ],
    weak: [
      /\blet\s+mut\b/,
      /\b(Vec|Option|Result|String|Box|Rc|Arc)<\w/,
      /\bmatch\s+\w+\s*\{/,
      /\.unwrap\(\)/,
      /\b(println!|format!|vec!)\b/,
    ],
  },
  // ── Go ────────────────────────────────────
  {
    lang: "go",
    strong: [
      /^\s*package\s+\w+\s*$/m,
      /^\s*func\s+(\(\w+\s+\*?\w+\)\s+)?\w+\(/m,
      /^\s*import\s+\(/m,
    ],
    weak: [
      /\b(fmt|log|os|io|net|http|context|sync|errors)\.\w+/,
      /\bif\s+err\s*!=\s*nil\b/,
      /:=\s/,
      /\bgo\s+func\b/,
      /\bchan\s+\w/,
      /\bdefer\s+\w/,
    ],
  },
  // ── Java ──────────────────────────────────
  {
    lang: "java",
    strong: [
      /^\s*package\s+[\w.]+;\s*$/m,
      /^\s*(public|private|protected)\s+(static\s+)?(class|interface|enum|abstract\s+class)\s+\w+/m,
    ],
    weak: [
      /^\s*import\s+[\w.]+\*?;\s*$/m,
      /\bSystem\.out\.print/,
      /\b@(Override|Autowired|Component|Service|Entity|Test)\b/,
      /\bnew\s+\w+\s*\(/,
    ],
  },
  // ── Kotlin ────────────────────────────────
  {
    lang: "kotlin",
    strong: [
      /^\s*fun\s+\w+/m,
      /^\s*val\s+\w+\s*[:=]/m,
      /^\s*var\s+\w+\s*[:=]/m,
      /^\s*data\s+class\b/m,
      /^\s*sealed\s+(class|interface)\b/m,
    ],
    weak: [/\b(println|listOf|mapOf|setOf)\b/, /\bwhen\s*\(/],
  },
  // ── Swift ─────────────────────────────────
  {
    lang: "swift",
    strong: [
      /^\s*import\s+(Foundation|UIKit|SwiftUI|Combine)\b/m,
      /^\s*func\s+\w+\(.*\)\s*(->\s*\w+)?\s*\{/m,
      /^\s*(struct|class|enum|protocol)\s+\w+\s*:\s*\w/m,
    ],
    weak: [
      /\bguard\s+let\b/,
      /\bif\s+let\b/,
      /\b@(State|Binding|Published|ObservedObject|EnvironmentObject)\b/,
      /\bvar\s+body\s*:\s*some\s+View\b/,
    ],
  },
  // ── C# ────────────────────────────────────
  {
    lang: "csharp",
    strong: [
      /^\s*using\s+System(\.\w+)*;\s*$/m,
      /^\s*namespace\s+[\w.]+/m,
      /^\s*(public|private|internal)\s+(static\s+)?(class|interface|struct|record)\s+\w+/m,
    ],
    weak: [
      /\bConsole\.Write/,
      /\bvar\s+\w+\s*=\s*new\b/,
      /\basync\s+Task\b/,
      /\b\[HttpGet\b/,
    ],
  },
  // ── PHP ───────────────────────────────────
  {
    lang: "php",
    strong: [/^\s*<\?php\b/m, /^\s*namespace\s+[\w\\]+;/m],
    weak: [/\$\w+\s*=/, /\b(echo|print_r|var_dump)\b/, /\bfunction\s+\w+\s*\(/m],
  },
  // ── Lua ───────────────────────────────────
  {
    lang: "lua",
    strong: [
      /^\s*local\s+function\s+\w+/m,
      /^\s*local\s+\w+\s*=\s*require\s*[\("]/m,
    ],
    weak: [/\bfunction\s*\(/, /\bend\s*$/m, /\bprint\s*\(/, /\bnil\b/],
  },
  // ── Perl ──────────────────────────────────
  {
    lang: "perl",
    strong: [/^#!\s*\/usr\/bin\/(env\s+)?perl/m, /^\s*use\s+strict\b/m],
    weak: [/\$_/, /\bmy\s+[\$@%]/, /\bsub\s+\w+\s*\{/m],
  },
  // ── R ─────────────────────────────────────
  {
    lang: "r",
    strong: [/^\s*library\s*\(\w+\)/m],
    weak: [/\b<-\s/, /\bc\s*\(/, /\bdata\.frame\b/, /\bggplot\b/],
  },
  // ── Haskell ───────────────────────────────
  {
    lang: "haskell",
    strong: [/^\s*module\s+[\w.]+\s+where\b/m, /^\s*import\s+(qualified\s+)?[\w.]+/m],
    weak: [/\b::\s/, /\bdo\s*$/m, /\b(IO|Maybe|Either|Int|String)\b/, /\bwhere\s*$/m],
  },
  // ── Elixir ────────────────────────────────
  {
    lang: "elixir",
    strong: [
      /^\s*defmodule\s+\w/m,
      /^\s*def\s+\w+.*do\s*$/m,
    ],
    weak: [/\|>\s/, /\bIO\.puts\b/, /\b@\w+\s+/m, /\bdo:\s/],
  },
  // ── Scala ─────────────────────────────────
  {
    lang: "scala",
    strong: [
      /^\s*object\s+\w+\s*(extends\b)?/m,
      /^\s*case\s+class\b/m,
      /^\s*trait\s+\w+/m,
    ],
    weak: [/\bval\s+\w+\s*:/, /\bdef\s+\w+\s*[(\[]/m, /\bprintln\s*\(/],
  },
  // ── Zig ───────────────────────────────────
  {
    lang: "zig",
    strong: [/^\s*const\s+std\s*=\s*@import\("std"\)/m, /\bpub\s+fn\s+\w+/m],
  },
  // ── C ─────────────────────────────────────
  {
    lang: "c",
    strong: [
      /^\s*#include\s*<(stdio|stdlib|string|math|unistd|fcntl|sys\/)\.h>/m,
      /^\s*int\s+main\s*\(\s*(void|int\s+argc)/m,
    ],
    weak: [/\bprintf\s*\(/, /\bmalloc\s*\(/, /\bfree\s*\(/, /\b(NULL|sizeof)\b/],
  },
  // ── C++ ───────────────────────────────────
  {
    lang: "cpp",
    strong: [
      /^\s*#include\s*<(iostream|vector|string|map|set|algorithm|memory|thread)>/m,
      /^\s*using\s+namespace\s+std\s*;/m,
      /\bstd::\w+/,
    ],
    weak: [
      /\bcout\s*<</,
      /\btemplate\s*</,
      /\b(unique_ptr|shared_ptr|make_unique|make_shared)\b/,
    ],
  },
  // ── TSX (before TypeScript — more specific) ──
  {
    lang: "tsx",
    strong: [
      /^\s*import\b.*from\s+['"]react['"]/m,
      /\b(useState|useEffect|useRef|useCallback|useMemo|useContext)\b/,
    ],
    weak: [
      /\breturn\s*\(\s*</m,
      /<\w+[\s/>]/,
      /\binterface\s+\w+Props\b/,
      /:\s*(React\.)?FC\b/,
      /\bJSX\.Element\b/,
    ],
  },
  // ── JSX ───────────────────────────────────
  {
    lang: "jsx",
    strong: [
      /^\s*import\b.*from\s+['"]react['"]/m,
    ],
    weak: [
      /\breturn\s*\(\s*</m,
      /<\w+[\s/>]/,
      /\bfunction\s+\w+\s*\(.*\)\s*\{/m,
      /\bconst\s+\w+\s*=\s*\(\s*\)\s*=>/m,
    ],
  },
  // ── TypeScript ────────────────────────────
  {
    lang: "typescript",
    strong: [
      /^\s*interface\s+\w+\s*\{/m,
      /^\s*type\s+\w+\s*=\s*/m,
      /^\s*enum\s+\w+\s*\{/m,
      /:\s*(string|number|boolean|void|never|unknown|any)(\s*[;,|&)\]}])/,
      /\bas\s+(string|number|boolean|any|unknown|\w+)\b/,
      /<\w+(\s*,\s*\w+)*>\s*\(/,
    ],
    weak: [
      /^\s*(export|import)\b/m,
      /^\s*const\s+\w+/m,
      /=>\s*\{/,
      /\basync\b/,
    ],
  },
  // ── JavaScript (last among JS family) ─────
  {
    lang: "javascript",
    strong: [
      /^\s*'use strict'\s*;?\s*$/m,
      /\bmodule\.exports\b/,
      /\brequire\s*\(['"][\w./-]+['"]\)/,
    ],
    weak: [
      /^\s*(export|import)\b/m,
      /^\s*const\s+\w+\s*=/m,
      /^\s*function\s+\w+\s*\(/m,
      /=>\s*[\{(]/,
      /\bconsole\.\w+/,
      /\basync\b/,
      /\bawait\b/,
      /\bdocument\.\w+/,
      /\bwindow\.\w+/,
    ],
  },
  // ── Markdown ──────────────────────────────
  {
    lang: "markdown",
    strong: [/^#{1,6}\s+\w/m],
    weak: [/^\s*[-*+]\s+\w/m, /^\s*\d+\.\s+\w/m, /\[[\w\s]+\]\(https?:/m],
  },
  // ── Diff / Patch ──────────────────────────
  {
    lang: "diff",
    strong: [/^---\s+a\//m, /^\+\+\+\s+b\//m, /^@@\s+-\d/m],
  },
  // ── INI / Conf ────────────────────────────
  {
    lang: "ini",
    strong: [/^\s*\[\w+\]\s*$/m],
    weak: [/^\w[\w.-]*\s*=\s*\S/m],
  },
];

/**
 * Detect the language of a code snippet.
 * Returns a Shiki-compatible language identifier, defaulting to "typescript".
 */
export function detectLanguage(code: string): string {
  if (!code.trim()) return "text";

  let bestLang = "";
  let bestScore = 0;

  for (const { lang, strong, weak } of PATTERNS) {
    let score = 0;
    for (const re of strong) {
      if (re.test(code)) score += 10;
    }
    if (weak) {
      for (const re of weak) {
        if (re.test(code)) score += 3;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestLang = lang;
    }
  }

  // Need at least one strong match (10) or several weak matches
  return bestScore >= 6 ? bestLang : "typescript";
}

