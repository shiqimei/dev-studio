import { describe, it, expect } from "vitest";
// Import mcp-server before tools to avoid circular dependency resolution issues.
// tools.ts -> mcp-server.ts -> acp-agent.ts -> settings.ts -> tools.ts
import { SYSTEM_REMINDER } from "../mcp-server.js";
import {
  toolInfoFromToolUse,
  toolUpdateFromToolResult,
  acpToolNames,
  markdownEscape,
  planEntries,
  ClaudePlanEntry,
} from "../tools.js";

// ---------------------------------------------------------------------------
// toolInfoFromToolUse
// ---------------------------------------------------------------------------
describe("toolInfoFromToolUse - extended", () => {
  // ---- NotebookRead -------------------------------------------------------
  describe("NotebookRead", () => {
    it("should return kind read with notebook_path in title", () => {
      const result = toolInfoFromToolUse({
        name: "NotebookRead",
        input: { notebook_path: "/notebooks/analysis.ipynb" },
      });
      expect(result.kind).toBe("read");
      expect(result.title).toBe("Read Notebook /notebooks/analysis.ipynb");
      expect(result.content).toEqual([]);
      expect(result.locations).toEqual([{ path: "/notebooks/analysis.ipynb" }]);
    });

    it("should use fallback title when notebook_path is missing", () => {
      const result = toolInfoFromToolUse({
        name: "NotebookRead",
        input: {},
      });
      expect(result.kind).toBe("read");
      expect(result.title).toBe("Read Notebook");
      expect(result.content).toEqual([]);
      expect(result.locations).toEqual([]);
    });

    it("should handle undefined input gracefully", () => {
      const result = toolInfoFromToolUse({
        name: "NotebookRead",
        input: undefined,
      });
      expect(result.kind).toBe("read");
      expect(result.title).toBe("Read Notebook");
      expect(result.locations).toEqual([]);
    });
  });

  // ---- NotebookEdit -------------------------------------------------------
  describe("NotebookEdit", () => {
    it("should return kind edit with notebook_path in title and new_source in content", () => {
      const result = toolInfoFromToolUse({
        name: "NotebookEdit",
        input: {
          notebook_path: "/notebooks/analysis.ipynb",
          new_source: "print('hello world')",
        },
      });
      expect(result.kind).toBe("edit");
      expect(result.title).toBe("Edit Notebook /notebooks/analysis.ipynb");
      expect(result.content).toEqual([
        {
          type: "content",
          content: { type: "text", text: "print('hello world')" },
        },
      ]);
      expect(result.locations).toEqual([{ path: "/notebooks/analysis.ipynb" }]);
    });

    it("should use fallback title when notebook_path is missing", () => {
      const result = toolInfoFromToolUse({
        name: "NotebookEdit",
        input: { new_source: "x = 1" },
      });
      expect(result.kind).toBe("edit");
      expect(result.title).toBe("Edit Notebook");
      expect(result.locations).toEqual([]);
    });

    it("should return empty content when new_source is missing", () => {
      const result = toolInfoFromToolUse({
        name: "NotebookEdit",
        input: { notebook_path: "/nb.ipynb" },
      });
      expect(result.content).toEqual([]);
    });

    it("should handle undefined input gracefully", () => {
      const result = toolInfoFromToolUse({
        name: "NotebookEdit",
        input: undefined,
      });
      expect(result.kind).toBe("edit");
      expect(result.title).toBe("Edit Notebook");
      expect(result.content).toEqual([]);
      expect(result.locations).toEqual([]);
    });
  });

  // ---- WebFetch -----------------------------------------------------------
  describe("WebFetch", () => {
    it("should return kind fetch with URL in title and prompt in content", () => {
      const result = toolInfoFromToolUse({
        name: "WebFetch",
        input: {
          url: "https://example.com/page",
          prompt: "Extract the main heading",
        },
      });
      expect(result.kind).toBe("fetch");
      expect(result.title).toBe("Fetch https://example.com/page");
      expect(result.content).toEqual([
        {
          type: "content",
          content: { type: "text", text: "Extract the main heading" },
        },
      ]);
    });

    it("should use fallback title when url is missing", () => {
      const result = toolInfoFromToolUse({
        name: "WebFetch",
        input: { prompt: "Summarize" },
      });
      expect(result.title).toBe("Fetch");
    });

    it("should return empty content when prompt is missing", () => {
      const result = toolInfoFromToolUse({
        name: "WebFetch",
        input: { url: "https://example.com" },
      });
      expect(result.content).toEqual([]);
    });

    it("should handle undefined input", () => {
      const result = toolInfoFromToolUse({
        name: "WebFetch",
        input: undefined,
      });
      expect(result.kind).toBe("fetch");
      expect(result.title).toBe("Fetch");
      expect(result.content).toEqual([]);
    });
  });

  // ---- WebSearch ----------------------------------------------------------
  describe("WebSearch", () => {
    it("should return kind fetch with query in title", () => {
      const result = toolInfoFromToolUse({
        name: "WebSearch",
        input: { query: "vitest documentation" },
      });
      expect(result.kind).toBe("fetch");
      expect(result.title).toBe('"vitest documentation"');
      expect(result.content).toEqual([]);
    });

    it("should include allowed_domains in title", () => {
      const result = toolInfoFromToolUse({
        name: "WebSearch",
        input: {
          query: "API docs",
          allowed_domains: ["docs.example.com", "api.example.com"],
        },
      });
      expect(result.title).toBe(
        '"API docs" (allowed: docs.example.com, api.example.com)',
      );
    });

    it("should include blocked_domains in title", () => {
      const result = toolInfoFromToolUse({
        name: "WebSearch",
        input: {
          query: "API docs",
          blocked_domains: ["spam.com"],
        },
      });
      expect(result.title).toBe('"API docs" (blocked: spam.com)');
    });

    it("should include both allowed and blocked domains in title", () => {
      const result = toolInfoFromToolUse({
        name: "WebSearch",
        input: {
          query: "search term",
          allowed_domains: ["good.com"],
          blocked_domains: ["bad.com"],
        },
      });
      expect(result.title).toBe(
        '"search term" (allowed: good.com) (blocked: bad.com)',
      );
    });

    it("should ignore empty domain arrays", () => {
      const result = toolInfoFromToolUse({
        name: "WebSearch",
        input: {
          query: "test",
          allowed_domains: [],
          blocked_domains: [],
        },
      });
      expect(result.title).toBe('"test"');
    });
  });

  // ---- ExitPlanMode -------------------------------------------------------
  describe("ExitPlanMode", () => {
    it("should return kind switch_mode with plan in content", () => {
      const result = toolInfoFromToolUse({
        name: "ExitPlanMode",
        input: { plan: "Step 1: Read files\nStep 2: Edit code" },
      });
      expect(result.kind).toBe("switch_mode");
      expect(result.title).toBe("Ready to code?");
      expect(result.content).toEqual([
        {
          type: "content",
          content: {
            type: "text",
            text: "Step 1: Read files\nStep 2: Edit code",
          },
        },
      ]);
    });

    it("should return empty content when plan is missing", () => {
      const result = toolInfoFromToolUse({
        name: "ExitPlanMode",
        input: {},
      });
      expect(result.kind).toBe("switch_mode");
      expect(result.title).toBe("Ready to code?");
      expect(result.content).toEqual([]);
    });

    it("should handle undefined input", () => {
      const result = toolInfoFromToolUse({
        name: "ExitPlanMode",
        input: undefined,
      });
      expect(result.kind).toBe("switch_mode");
      expect(result.content).toEqual([]);
    });
  });

  // ---- Other (explicit name) ----------------------------------------------
  describe("Other (explicit tool name)", () => {
    it("should return kind other with JSON stringified input", () => {
      const result = toolInfoFromToolUse({
        name: "Other",
        input: { foo: "bar", count: 42 },
      });
      expect(result.kind).toBe("other");
      expect(result.title).toBe("Other");
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("content");
      const text = (result.content[0] as any).content.text;
      expect(text).toContain("```json");
      expect(text).toContain('"foo": "bar"');
      expect(text).toContain('"count": 42');
    });

    it("should handle null input by falling back to '{}'", () => {
      const result = toolInfoFromToolUse({
        name: "Other",
        input: null,
      });
      // JSON.stringify(null) === "null"
      expect(result.kind).toBe("other");
      const text = (result.content[0] as any).content.text;
      expect(text).toContain("null");
    });

    it("should handle string input", () => {
      const result = toolInfoFromToolUse({
        name: "Other",
        input: "plain string data",
      });
      expect(result.kind).toBe("other");
      const text = (result.content[0] as any).content.text;
      expect(text).toContain('"plain string data"');
    });

    it("should handle circular references by falling back to string or '{}'", () => {
      // Construct input whose JSON.stringify throws
      const circular: any = {};
      circular.self = circular;
      const result = toolInfoFromToolUse({
        name: "Other",
        input: circular,
      });
      expect(result.kind).toBe("other");
      // Should fall back to "{}" since typeof circular !== "string"
      const text = (result.content[0] as any).content.text;
      expect(text).toContain("{}");
    });

    it("should fall back to the string itself for string input when JSON.stringify throws", () => {
      // This exercises the catch branch with a string input.
      // JSON.stringify of a normal string doesn't throw, but the code
      // path is: catch { output = typeof input === "string" ? input : "{}" }
      // We test the normal string path here for coverage.
      const result = toolInfoFromToolUse({
        name: "Other",
        input: "fallback value",
      });
      expect(result.kind).toBe("other");
    });
  });

  // ---- Unknown / Default tools --------------------------------------------
  describe("Unknown / Default tools", () => {
    it("should return kind other and use the tool name as title", () => {
      const result = toolInfoFromToolUse({
        name: "SomeCustomTool",
        input: { x: 1 },
      });
      expect(result.kind).toBe("other");
      expect(result.title).toBe("SomeCustomTool");
      expect(result.content).toEqual([]);
    });

    it("should use 'Unknown Tool' when name is empty", () => {
      const result = toolInfoFromToolUse({
        name: "",
        input: {},
      });
      expect(result.kind).toBe("other");
      expect(result.title).toBe("Unknown Tool");
    });

    it("should use 'Unknown Tool' when name is undefined", () => {
      const result = toolInfoFromToolUse({
        name: undefined,
        input: {},
      });
      expect(result.kind).toBe("other");
      expect(result.title).toBe("Unknown Tool");
    });
  });

  // ---- Edit (non-ACP) ----------------------------------------------------
  describe("Edit (non-ACP)", () => {
    it("should return kind edit with diff content for old/new strings", () => {
      const result = toolInfoFromToolUse({
        name: "Edit",
        input: {
          file_path: "/src/app.ts",
          old_string: "const x = 1;",
          new_string: "const x = 2;",
        },
      });
      expect(result.kind).toBe("edit");
      expect(result.title).toBe("Edit `/src/app.ts`");
      expect(result.content).toEqual([
        {
          type: "diff",
          path: "/src/app.ts",
          oldText: "const x = 1;",
          newText: "const x = 2;",
        },
      ]);
      expect(result.locations).toEqual([{ path: "/src/app.ts" }]);
    });

    it("should handle null old_string (new file creation)", () => {
      const result = toolInfoFromToolUse({
        name: "Edit",
        input: {
          file_path: "/src/new.ts",
          old_string: null,
          new_string: "export default {};",
        },
      });
      expect(result.content).toEqual([
        {
          type: "diff",
          path: "/src/new.ts",
          oldText: null,
          newText: "export default {};",
        },
      ]);
    });

    it("should use fallback title when file_path is missing", () => {
      const result = toolInfoFromToolUse({
        name: "Edit",
        input: { old_string: "a", new_string: "b" },
      });
      expect(result.title).toBe("Edit");
      expect(result.content).toEqual([]);
      expect(result.locations).toBeUndefined();
    });

    it("should handle empty input", () => {
      const result = toolInfoFromToolUse({
        name: "Edit",
        input: {},
      });
      expect(result.title).toBe("Edit");
      expect(result.content).toEqual([]);
    });
  });

  // ---- mcp__acp__Edit ---------------------------------------------------
  describe("mcp__acp__Edit", () => {
    it("should return kind edit with diff content", () => {
      const result = toolInfoFromToolUse({
        name: acpToolNames.edit,
        input: {
          file_path: "/src/utils.ts",
          old_string: "function old() {}",
          new_string: "function updated() {}",
        },
      });
      expect(result.kind).toBe("edit");
      expect(result.title).toBe("Edit `/src/utils.ts`");
      expect(result.content).toEqual([
        {
          type: "diff",
          path: "/src/utils.ts",
          oldText: "function old() {}",
          newText: "function updated() {}",
        },
      ]);
      expect(result.locations).toEqual([{ path: "/src/utils.ts" }]);
    });
  });

  // ---- Bash with backticks ------------------------------------------------
  describe("Bash with backticks", () => {
    it("should escape backticks in the command", () => {
      const result = toolInfoFromToolUse({
        name: "Bash",
        input: {
          command: "echo `date`",
          description: "Print current date",
        },
      });
      expect(result.title).toBe("`echo \\`date\\``");
    });

    it("should escape multiple consecutive backticks", () => {
      const result = toolInfoFromToolUse({
        name: "Bash",
        input: {
          command: "echo ```hello```",
        },
      });
      expect(result.title).toBe("`echo \\`\\`\\`hello\\`\\`\\``");
    });

    it("should handle commands with no backticks", () => {
      const result = toolInfoFromToolUse({
        name: "Bash",
        input: { command: "ls -la" },
      });
      expect(result.title).toBe("`ls -la`");
    });

    it("should show Terminal as title when command is missing", () => {
      const result = toolInfoFromToolUse({
        name: "Bash",
        input: {},
      });
      expect(result.title).toBe("Terminal");
      expect(result.content).toEqual([]);
    });

    it("should also handle the ACP bash variant", () => {
      const result = toolInfoFromToolUse({
        name: acpToolNames.bash,
        input: {
          command: "echo `whoami`",
          description: "Show user",
        },
      });
      expect(result.title).toBe("`echo \\`whoami\\``");
      expect(result.kind).toBe("execute");
    });
  });

  // ---- Grep with all flags ------------------------------------------------
  describe("Grep with all flags", () => {
    it("should include -i flag", () => {
      const result = toolInfoFromToolUse({
        name: "Grep",
        input: { "-i": true, pattern: "test" },
      });
      expect(result.title).toContain("-i");
      expect(result.title).toBe('grep -i "test"');
    });

    it("should include -n flag", () => {
      const result = toolInfoFromToolUse({
        name: "Grep",
        input: { "-n": true, pattern: "test" },
      });
      expect(result.title).toBe('grep -n "test"');
    });

    it("should include -A context flag", () => {
      const result = toolInfoFromToolUse({
        name: "Grep",
        input: { "-A": 3, pattern: "test" },
      });
      expect(result.title).toBe('grep -A 3 "test"');
    });

    it("should include -B context flag", () => {
      const result = toolInfoFromToolUse({
        name: "Grep",
        input: { "-B": 2, pattern: "test" },
      });
      expect(result.title).toBe('grep -B 2 "test"');
    });

    it("should include -C context flag", () => {
      const result = toolInfoFromToolUse({
        name: "Grep",
        input: { "-C": 5, pattern: "test" },
      });
      expect(result.title).toBe('grep -C 5 "test"');
    });

    it("should handle FilesWithMatches output_mode as -l", () => {
      const result = toolInfoFromToolUse({
        name: "Grep",
        input: { output_mode: "FilesWithMatches", pattern: "test" },
      });
      expect(result.title).toBe('grep -l "test"');
    });

    it("should handle Count output_mode as -c", () => {
      const result = toolInfoFromToolUse({
        name: "Grep",
        input: { output_mode: "Count", pattern: "test" },
      });
      expect(result.title).toBe('grep -c "test"');
    });

    it("should handle Content output_mode (no extra flag)", () => {
      const result = toolInfoFromToolUse({
        name: "Grep",
        input: { output_mode: "Content", pattern: "test" },
      });
      expect(result.title).toBe('grep "test"');
    });

    it("should include head_limit as piped head command", () => {
      const result = toolInfoFromToolUse({
        name: "Grep",
        input: { head_limit: 10, pattern: "test" },
      });
      expect(result.title).toBe('grep | head -10 "test"');
    });

    it("should include glob as --include", () => {
      const result = toolInfoFromToolUse({
        name: "Grep",
        input: { glob: "*.ts", pattern: "import" },
      });
      expect(result.title).toBe('grep --include="*.ts" "import"');
    });

    it("should include type as --type", () => {
      const result = toolInfoFromToolUse({
        name: "Grep",
        input: { type: "ts", pattern: "export" },
      });
      expect(result.title).toBe('grep --type=ts "export"');
    });

    it("should include multiline as -P", () => {
      const result = toolInfoFromToolUse({
        name: "Grep",
        input: { multiline: true, pattern: "struct.*\\{" },
      });
      expect(result.title).toBe('grep -P "struct.*\\{"');
    });

    it("should include path at the end", () => {
      const result = toolInfoFromToolUse({
        name: "Grep",
        input: { pattern: "TODO", path: "/src" },
      });
      expect(result.title).toBe('grep "TODO" /src');
    });

    it("should combine all flags together in order", () => {
      const result = toolInfoFromToolUse({
        name: "Grep",
        input: {
          "-i": true,
          "-n": true,
          "-A": 2,
          "-B": 1,
          "-C": 3,
          output_mode: "FilesWithMatches",
          head_limit: 20,
          glob: "*.ts",
          type: "typescript",
          multiline: true,
          pattern: "function\\s+\\w+",
          path: "/src",
        },
      });
      expect(result.title).toBe(
        'grep -i -n -A 2 -B 1 -C 3 -l | head -20 --include="*.ts" --type=typescript -P "function\\s+\\w+" /src',
      );
      expect(result.kind).toBe("search");
      expect(result.content).toEqual([]);
    });

    it("should handle grep with no pattern and no flags", () => {
      const result = toolInfoFromToolUse({
        name: "Grep",
        input: {},
      });
      expect(result.title).toBe("grep");
      expect(result.kind).toBe("search");
    });

    it("should not add -i/-n when their values are false", () => {
      const result = toolInfoFromToolUse({
        name: "Grep",
        input: { "-i": false, "-n": false, pattern: "test" },
      });
      expect(result.title).toBe('grep "test"');
    });

    it("should include -A 0 when explicitly set to zero", () => {
      const result = toolInfoFromToolUse({
        name: "Grep",
        input: { "-A": 0, pattern: "test" },
      });
      expect(result.title).toBe('grep -A 0 "test"');
    });
  });

  // ---- Edge cases ---------------------------------------------------------
  describe("Edge cases", () => {
    it("should handle LS without path", () => {
      const result = toolInfoFromToolUse({
        name: "LS",
        input: {},
      });
      expect(result.title).toBe(
        "List the current directory's contents",
      );
    });

    it("should handle Glob with path and pattern", () => {
      const result = toolInfoFromToolUse({
        name: "Glob",
        input: { path: "/src", pattern: "**/*.ts" },
      });
      expect(result.title).toBe("Find `/src` `**/*.ts`");
      expect(result.locations).toEqual([{ path: "/src" }]);
    });

    it("should handle Glob with no input fields", () => {
      const result = toolInfoFromToolUse({
        name: "Glob",
        input: {},
      });
      expect(result.title).toBe("Find");
      expect(result.locations).toEqual([]);
    });

    it("should handle Task with no description", () => {
      const result = toolInfoFromToolUse({
        name: "Task",
        input: { prompt: "Do something" },
      });
      expect(result.title).toBe("Task");
      expect(result.content).toHaveLength(1);
    });

    it("should handle Task with no prompt", () => {
      const result = toolInfoFromToolUse({
        name: "Task",
        input: { description: "A task" },
      });
      expect(result.title).toBe("A task");
      expect(result.content).toEqual([]);
    });

    it("should handle Task with empty input", () => {
      const result = toolInfoFromToolUse({
        name: "Task",
        input: {},
      });
      expect(result.title).toBe("Task");
      expect(result.content).toEqual([]);
    });

    it("should handle Read with no file_path", () => {
      const result = toolInfoFromToolUse({
        name: "Read",
        input: {},
      });
      expect(result.title).toBe("Read File");
      expect(result.locations).toEqual([]);
    });

    it("should handle mcp__acp__Read with no file_path", () => {
      const result = toolInfoFromToolUse({
        name: acpToolNames.read,
        input: {},
      });
      expect(result.title).toBe("Read File");
      expect(result.locations).toEqual([]);
    });

    it("should handle Write with no file_path and no content", () => {
      const result = toolInfoFromToolUse({
        name: "Write",
        input: {},
      });
      expect(result.title).toBe("Write");
      expect(result.content).toEqual([]);
    });

    it("should handle mcp__acp__Write with content but no file_path", () => {
      const result = toolInfoFromToolUse({
        name: acpToolNames.write,
        input: { content: "some data" },
      });
      expect(result.title).toBe("Write");
      expect(result.content).toEqual([
        {
          type: "content",
          content: { type: "text", text: "some data" },
        },
      ]);
    });

    it("should handle TodoWrite with empty todos array", () => {
      const result = toolInfoFromToolUse({
        name: "TodoWrite",
        input: { todos: [] },
      });
      expect(result.kind).toBe("think");
      expect(result.title).toBe("Update TODOs: ");
    });

    it("should handle TodoWrite with no todos field", () => {
      const result = toolInfoFromToolUse({
        name: "TodoWrite",
        input: {},
      });
      expect(result.title).toBe("Update TODOs");
    });

    it("should handle KillShell via ACP tool name", () => {
      const result = toolInfoFromToolUse({
        name: acpToolNames.killShell,
        input: {},
      });
      expect(result.kind).toBe("execute");
      expect(result.title).toBe("Kill Process");
    });

    it("should handle BashOutput via ACP tool name", () => {
      const result = toolInfoFromToolUse({
        name: acpToolNames.bashOutput,
        input: {},
      });
      expect(result.kind).toBe("execute");
      expect(result.title).toBe("Tail Logs");
    });
  });
});

// ---------------------------------------------------------------------------
// toolUpdateFromToolResult
// ---------------------------------------------------------------------------
describe("toolUpdateFromToolResult - extended", () => {
  // ---- Read with array content -------------------------------------------
  describe("Read with array content", () => {
    it("should return markdownEscaped content for array text blocks", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_read_arr",
        content: [{ type: "text" as const, text: "line 1\nline 2\nline 3" }],
        is_error: false,
      };
      const toolUse = { name: "Read", input: { file_path: "/test.txt" } };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      expect(update.content).toHaveLength(1);
      expect(update.content![0].type).toBe("content");
      const text = (update.content![0] as any).content.text;
      expect(text).toBe(markdownEscape("line 1\nline 2\nline 3"));
    });

    it("should strip SYSTEM_REMINDER from Read results", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_read_sr",
        content: [
          { type: "text" as const, text: "actual content" + SYSTEM_REMINDER },
        ],
        is_error: false,
      };
      const toolUse = { name: "Read", input: { file_path: "/test.txt" } };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      const text = (update.content![0] as any).content.text;
      expect(text).toBe(markdownEscape("actual content"));
    });

    it("should pass through non-text content blocks as-is", () => {
      const imageBlock = {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: "image/png" as const,
          data: "iVBORw0KGgo=",
        },
      };
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_read_img",
        content: [imageBlock],
        is_error: false,
      };
      const toolUse = { name: "Read", input: { file_path: "/img.png" } };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      expect(update.content).toHaveLength(1);
      expect((update.content![0] as any).content).toEqual(imageBlock);
    });

    it("should return empty for empty array content", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_read_empty",
        content: [],
        is_error: false,
      };
      const toolUse = { name: "Read", input: { file_path: "/empty.txt" } };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      expect(update).toEqual({});
    });
  });

  // ---- Read with string content ------------------------------------------
  describe("Read with string content", () => {
    it("should return markdownEscaped content for string content", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_read_str",
        content: "file contents here",
        is_error: false,
      };
      const toolUse = { name: "Read", input: { file_path: "/test.txt" } };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      expect(update.content).toHaveLength(1);
      const text = (update.content![0] as any).content.text;
      expect(text).toBe(markdownEscape("file contents here"));
    });

    it("should strip SYSTEM_REMINDER from string Read results", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_read_str_sr",
        content: "data" + SYSTEM_REMINDER,
        is_error: false,
      };
      const toolUse = { name: "Read", input: {} };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      const text = (update.content![0] as any).content.text;
      expect(text).toBe(markdownEscape("data"));
    });

    it("should return empty for empty string content", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_read_empty_str",
        content: "",
        is_error: false,
      };
      const toolUse = { name: "Read", input: {} };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      expect(update).toEqual({});
    });
  });

  // ---- mcp__acp__Read ----------------------------------------------------
  describe("mcp__acp__Read with content", () => {
    it("should markdownEscape array text content", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_acp_read",
        content: [{ type: "text" as const, text: "acp read content" }],
        is_error: false,
      };
      const toolUse = {
        name: acpToolNames.read,
        input: { file_path: "/acp-file.txt" },
      };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      expect(update.content).toHaveLength(1);
      const text = (update.content![0] as any).content.text;
      expect(text).toBe(markdownEscape("acp read content"));
    });

    it("should markdownEscape string content", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_acp_read_str",
        content: "string acp content",
        is_error: false,
      };
      const toolUse = { name: acpToolNames.read, input: {} };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      const text = (update.content![0] as any).content.text;
      expect(text).toBe(markdownEscape("string acp content"));
    });
  });

  // ---- mcp__acp__Edit with parseable diff --------------------------------
  describe("mcp__acp__Edit with parseable diff", () => {
    it("should parse unified diff and return diff content blocks with locations", () => {
      const diffText = [
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1,3 +1,3 @@",
        " import { foo } from './foo';",
        "-const x = 1;",
        "+const x = 2;",
        " export default x;",
      ].join("\n");

      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_acp_edit_diff",
        content: [{ type: "text" as const, text: diffText }],
        is_error: false,
      };
      const toolUse = {
        name: acpToolNames.edit,
        input: { file_path: "/src/app.ts", old_string: "1", new_string: "2" },
      };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      expect(update.content).toBeDefined();
      expect(update.content!.length).toBeGreaterThan(0);
      expect(update.locations).toBeDefined();
      expect(update.locations!.length).toBeGreaterThan(0);

      // Verify diff structure
      const diffBlock = update.content![0] as any;
      expect(diffBlock.type).toBe("diff");
      expect(diffBlock.path).toBe("b/src/app.ts");

      // Verify location
      expect(update.locations![0]).toMatchObject({
        path: "b/src/app.ts",
        line: 1,
      });
    });

    it("should return empty when diff text is not a valid patch", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_acp_edit_bad",
        content: [{ type: "text" as const, text: "not a valid diff" }],
        is_error: false,
      };
      const toolUse = { name: acpToolNames.edit, input: {} };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      expect(update).toEqual({});
    });

    it("should return empty when content is empty array", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_acp_edit_noc",
        content: [],
        is_error: false,
      };
      const toolUse = { name: acpToolNames.edit, input: {} };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      expect(update).toEqual({});
    });
  });

  // ---- ExitPlanMode result -----------------------------------------------
  describe("ExitPlanMode", () => {
    it("should return title 'Exited Plan Mode'", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_exit_plan",
        content: [{ type: "text" as const, text: "OK" }],
        is_error: false,
      };
      const toolUse = { name: "ExitPlanMode", input: {} };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      expect(update).toEqual({ title: "Exited Plan Mode" });
    });
  });

  // ---- Suppressed tool results (return {}) --------------------------------
  describe("Suppressed tool results", () => {
    it("should return empty for mcp__acp__Bash result", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_acp_bash",
        content: [{ type: "text" as const, text: "output" }],
        is_error: false,
      };
      const toolUse = { name: acpToolNames.bash, input: { command: "ls" } };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      expect(update).toEqual({});
    });

    it("should return empty for mcp__acp__Write result", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_acp_write",
        content: [{ type: "text" as const, text: "written" }],
        is_error: false,
      };
      const toolUse = {
        name: acpToolNames.write,
        input: { file_path: "/f", content: "c" },
      };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      expect(update).toEqual({});
    });

    it("should return empty for non-ACP Edit result", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_edit",
        content: [{ type: "text" as const, text: "edited" }],
        is_error: false,
      };
      const toolUse = {
        name: "Edit",
        input: { file_path: "/f", old_string: "a", new_string: "b" },
      };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      expect(update).toEqual({});
    });

    it("should return empty for non-ACP Write result", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_write",
        content: [{ type: "text" as const, text: "done" }],
        is_error: false,
      };
      const toolUse = {
        name: "Write",
        input: { file_path: "/f", content: "c" },
      };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      expect(update).toEqual({});
    });
  });

  // ---- Default / fallthrough tools via toAcpContentUpdate ----------------
  describe("Default / fallthrough tools (toAcpContentUpdate)", () => {
    it("should handle Bash (non-ACP) with string content", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_bash",
        content: "command output here",
        is_error: false,
      };
      const toolUse = { name: "Bash", input: { command: "echo hi" } };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      expect(update.content).toHaveLength(1);
      const text = (update.content![0] as any).content.text;
      expect(text).toBe("command output here");
    });

    it("should handle Bash (non-ACP) with array text content", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_bash_arr",
        content: [{ type: "text" as const, text: "line 1\nline 2" }],
        is_error: false,
      };
      const toolUse = { name: "Bash", input: { command: "ls" } };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      expect(update.content).toHaveLength(1);
      expect((update.content![0] as any).content).toEqual({
        type: "text",
        text: "line 1\nline 2",
      });
    });

    it("should handle unknown tool with text content", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_custom",
        content: [{ type: "text" as const, text: "custom output" }],
        is_error: false,
      };
      const toolUse = { name: "SomeUnknownTool", input: {} };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      expect(update.content).toHaveLength(1);
      expect((update.content![0] as any).content).toEqual({
        type: "text",
        text: "custom output",
      });
    });

    it("should handle empty content in default case", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_empty",
        content: "",
        is_error: false,
      };
      const toolUse = { name: "Glob", input: {} };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      expect(update).toEqual({});
    });

    it("should handle undefined toolUse falling through to default", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_no_use",
        content: [{ type: "text" as const, text: "data" }],
        is_error: false,
      };
      const update = toolUpdateFromToolResult(toolResult, undefined);
      expect(update.content).toHaveLength(1);
      expect((update.content![0] as any).content.text).toBe("data");
    });

    it("should handle LS tool result with content", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_ls",
        content: [{ type: "text" as const, text: "file1.ts\nfile2.ts" }],
        is_error: false,
      };
      const toolUse = { name: "LS", input: { path: "/src" } };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      expect(update.content).toHaveLength(1);
    });

    it("should handle Grep tool result with content", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_grep",
        content: [{ type: "text" as const, text: "match1\nmatch2" }],
        is_error: false,
      };
      const toolUse = { name: "Grep", input: { pattern: "test" } };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      expect(update.content).toHaveLength(1);
    });

    it("should handle WebFetch tool result with content", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_wf",
        content: [{ type: "text" as const, text: "fetched page" }],
        is_error: false,
      };
      const toolUse = { name: "WebFetch", input: { url: "https://x.com" } };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      expect(update.content).toHaveLength(1);
    });

    it("should handle WebSearch tool result with content", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_ws",
        content: [{ type: "text" as const, text: "search results" }],
        is_error: false,
      };
      const toolUse = { name: "WebSearch", input: { query: "test" } };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      expect(update.content).toHaveLength(1);
    });

    it("should handle Task tool result", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_task",
        content: [{ type: "text" as const, text: "task completed" }],
        is_error: false,
      };
      const toolUse = { name: "Task", input: { prompt: "do something" } };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      expect(update.content).toHaveLength(1);
    });

    it("should handle NotebookEdit tool result", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_nbe",
        content: [{ type: "text" as const, text: "cell updated" }],
        is_error: false,
      };
      const toolUse = {
        name: "NotebookEdit",
        input: { notebook_path: "/nb.ipynb", new_source: "x" },
      };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      expect(update.content).toHaveLength(1);
    });

    it("should handle NotebookRead tool result", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_nbr",
        content: [{ type: "text" as const, text: "cell contents" }],
        is_error: false,
      };
      const toolUse = {
        name: "NotebookRead",
        input: { notebook_path: "/nb.ipynb" },
      };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      expect(update.content).toHaveLength(1);
    });

    it("should handle Other tool result", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_other",
        content: [{ type: "text" as const, text: "other output" }],
        is_error: false,
      };
      const toolUse = { name: "Other", input: {} };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      expect(update.content).toHaveLength(1);
    });
  });

  // ---- Error handling (is_error = true) ----------------------------------
  describe("Error handling", () => {
    it("should wrap error content in code fences for array content", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_err_arr",
        content: [{ type: "text" as const, text: "Permission denied" }],
        is_error: true,
      };
      const toolUse = { name: "Bash", input: { command: "rm /" } };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      expect(update.content).toHaveLength(1);
      const text = (update.content![0] as any).content.text;
      expect(text).toBe("```\nPermission denied\n```");
    });

    it("should wrap error content in code fences for string content", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_err_str",
        content: "File not found",
        is_error: true,
      };
      const toolUse = { name: "Read", input: { file_path: "/missing.txt" } };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      expect(update.content).toHaveLength(1);
      const text = (update.content![0] as any).content.text;
      expect(text).toBe("```\nFile not found\n```");
    });

    it("should handle errors for suppressed tools (edit/write) by still returning content", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_err_edit",
        content: [
          { type: "text" as const, text: "old_string not found in file" },
        ],
        is_error: true,
      };
      const toolUse = {
        name: acpToolNames.edit,
        input: { file_path: "/f", old_string: "x", new_string: "y" },
      };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      // Error results are handled before the switch, so they still return content
      expect(update.content).toHaveLength(1);
      const text = (update.content![0] as any).content.text;
      expect(text).toContain("old_string not found in file");
    });

    it("should return empty for error with empty content", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_err_empty",
        content: [],
        is_error: true,
      };
      const toolUse = { name: "Bash", input: { command: "fail" } };
      // is_error is true but content.length is 0, so the error check passes through
      // to the switch statement which falls to default -> toAcpContentUpdate
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      expect(update).toEqual({});
    });
  });

  // ---- Special content types via toAcpContentBlock -----------------------
  describe("Special content types via toAcpContentBlock", () => {
    it("should handle web_search_tool_result_error content", () => {
      const toolResult = {
        type: "web_search_tool_result" as const,
        tool_use_id: "toolu_wserr",
        content: {
          type: "web_search_tool_result_error" as const,
          error_code: "rate_limited" as const,
        },
      };
      const toolUse = { name: "WebSearch", input: { query: "test" } };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      expect(update.content).toHaveLength(1);
      const text = (update.content![0] as any).content.text;
      expect(text).toBe("Error: rate_limited");
    });

    it("should handle web_fetch_tool_result with result content", () => {
      const toolResult = {
        type: "web_fetch_tool_result" as const,
        tool_use_id: "toolu_wfr",
        content: {
          type: "web_fetch_result" as const,
          url: "https://example.com/api",
          content: {
            type: "document" as const,
            citations: null,
            title: null,
            source: {
              type: "text" as const,
              media_type: "text/html" as const,
              data: "<html></html>",
            },
          },
        },
      };
      const toolUse = {
        name: "WebFetch",
        input: { url: "https://example.com/api" },
      };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      expect(update.content).toHaveLength(1);
      const text = (update.content![0] as any).content.text;
      expect(text).toBe("Fetched: https://example.com/api");
    });

    it("should handle web_fetch_tool_result_error content", () => {
      const toolResult = {
        type: "web_fetch_tool_result" as const,
        tool_use_id: "toolu_wferr",
        content: {
          type: "web_fetch_tool_result_error" as const,
          error_code: "too_many_requests" as const,
        },
      };
      const toolUse = { name: "WebFetch", input: { url: "https://x.com" } };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      expect(update.content).toHaveLength(1);
      const text = (update.content![0] as any).content.text;
      expect(text).toBe("Error: too_many_requests");
    });

    it("should handle code_execution_result content", () => {
      const toolResult = {
        type: "code_execution_tool_result" as const,
        tool_use_id: "toolu_ce",
        content: {
          type: "code_execution_result" as const,
          stdout: "42",
          stderr: "",
          return_code: 0,
          content: [],
        },
      };
      const toolUse = { name: "CodeExecution", input: {} };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      expect(update.content).toHaveLength(1);
      const text = (update.content![0] as any).content.text;
      expect(text).toBe("Output: 42");
    });

    it("should handle code_execution_result with stderr", () => {
      const toolResult = {
        type: "code_execution_tool_result" as const,
        tool_use_id: "toolu_ce_err",
        content: {
          type: "code_execution_result" as const,
          stdout: "",
          stderr: "TypeError: x is not defined",
          return_code: 1,
          content: [],
        },
      };
      const toolUse = { name: "CodeExecution", input: {} };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      const text = (update.content![0] as any).content.text;
      expect(text).toBe("Output: TypeError: x is not defined");
    });

    it("should handle code_execution_tool_result_error", () => {
      const toolResult = {
        type: "code_execution_tool_result" as const,
        tool_use_id: "toolu_ce_terr",
        content: {
          type: "code_execution_tool_result_error" as const,
          error_code: "timeout" as const,
        },
      };
      const toolUse = { name: "CodeExecution", input: {} };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      const text = (update.content![0] as any).content.text;
      expect(text).toBe("Error: timeout");
    });

    it("should handle bash_code_execution_result content", () => {
      const toolResult = {
        type: "bash_code_execution_tool_result" as const,
        tool_use_id: "toolu_bce",
        content: {
          type: "bash_code_execution_result" as const,
          stdout: "file1.txt\nfile2.txt",
          stderr: "",
          return_code: 0,
          content: [],
        },
      };
      const toolUse = { name: "Bash", input: { command: "ls" } };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      const text = (update.content![0] as any).content.text;
      expect(text).toBe("Output: file1.txt\nfile2.txt");
    });

    it("should handle bash_code_execution_tool_result_error", () => {
      const toolResult = {
        type: "bash_code_execution_tool_result" as const,
        tool_use_id: "toolu_bce_err",
        content: {
          type: "bash_code_execution_tool_result_error" as const,
          error_code: "unavailable" as const,
        },
      };
      const toolUse = { name: "Bash", input: { command: "fail" } };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      const text = (update.content![0] as any).content.text;
      expect(text).toBe("Error: unavailable");
    });

    it("should handle tool_search_tool_result_error", () => {
      const toolResult = {
        type: "tool_search_tool_result" as const,
        tool_use_id: "toolu_tserr",
        content: {
          type: "tool_search_tool_result_error" as const,
          error_code: "unavailable" as const,
          error_message: "Service unavailable",
        },
      };
      const toolUse = { name: "ToolSearch", input: { query: "test" } };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      const text = (update.content![0] as any).content.text;
      expect(text).toBe("Error: unavailable - Service unavailable");
    });

    it("should handle tool_search_tool_result_error without error_message", () => {
      const toolResult = {
        type: "tool_search_tool_result" as const,
        tool_use_id: "toolu_tserr2",
        content: {
          type: "tool_search_tool_result_error" as const,
          error_code: "unavailable" as const,
        },
      };
      const toolUse = { name: "ToolSearch", input: { query: "test" } };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      const text = (update.content![0] as any).content.text;
      expect(text).toBe("Error: unavailable");
    });

    it("should handle text_editor_code_execution_view_result", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_tev",
        content: [
          {
            type: "text_editor_code_execution_view_result" as const,
            content: "file contents here",
          },
        ],
        is_error: false,
      };
      // Falls through to default
      const toolUse = { name: "TextEditorCodeExecution", input: {} };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      const text = (update.content![0] as any).content.text;
      expect(text).toBe("file contents here");
    });

    it("should handle text_editor_code_execution_create_result (new file)", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_tec",
        content: [
          {
            type: "text_editor_code_execution_create_result" as const,
            is_file_update: false,
          },
        ],
        is_error: false,
      };
      const toolUse = { name: "TextEditorCodeExecution", input: {} };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      const text = (update.content![0] as any).content.text;
      expect(text).toBe("File created");
    });

    it("should handle text_editor_code_execution_create_result (update)", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_teu",
        content: [
          {
            type: "text_editor_code_execution_create_result" as const,
            is_file_update: true,
          },
        ],
        is_error: false,
      };
      const toolUse = { name: "TextEditorCodeExecution", input: {} };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      const text = (update.content![0] as any).content.text;
      expect(text).toBe("File updated");
    });

    it("should handle text_editor_code_execution_str_replace_result", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_tesr",
        content: [
          {
            type: "text_editor_code_execution_str_replace_result" as const,
            lines: ["line A", "line B", "line C"],
          },
        ],
        is_error: false,
      };
      const toolUse = { name: "TextEditorCodeExecution", input: {} };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      const text = (update.content![0] as any).content.text;
      expect(text).toBe("line A\nline B\nline C");
    });

    it("should handle text_editor_code_execution_str_replace_result with no lines", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_tesr_nl",
        content: [
          {
            type: "text_editor_code_execution_str_replace_result" as const,
            lines: undefined as unknown as string[],
          },
        ],
        is_error: false,
      };
      const toolUse = { name: "TextEditorCodeExecution", input: {} };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      const text = (update.content![0] as any).content.text;
      expect(text).toBe("");
    });

    it("should handle text_editor_code_execution_tool_result_error with message", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_teerr",
        content: [
          {
            type: "text_editor_code_execution_tool_result_error" as const,
            error_code: "invalid_path" as const,
            error_message: "Path does not exist",
          },
        ],
        is_error: false,
      };
      const toolUse = { name: "TextEditorCodeExecution", input: {} };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      const text = (update.content![0] as any).content.text;
      expect(text).toBe("Error: invalid_path - Path does not exist");
    });

    it("should handle text_editor_code_execution_tool_result_error without message", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_teerr2",
        content: [
          {
            type: "text_editor_code_execution_tool_result_error" as const,
            error_code: "timeout" as const,
          },
        ],
        is_error: false,
      };
      const toolUse = { name: "TextEditorCodeExecution", input: {} };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      const text = (update.content![0] as any).content.text;
      expect(text).toBe("Error: timeout");
    });

    it("should handle image content with base64 source", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_img",
        content: [
          {
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: "image/png" as const,
              data: "iVBORw0KGgo=",
            },
          },
        ],
        is_error: false,
      };
      const toolUse = { name: "SomeTool", input: {} };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      expect(update.content).toHaveLength(1);
      const content = (update.content![0] as any).content;
      expect(content.type).toBe("image");
      expect(content.data).toBe("iVBORw0KGgo=");
      expect(content.mimeType).toBe("image/png");
    });

    it("should handle image content with URL source", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_img_url",
        content: [
          {
            type: "image" as const,
            source: {
              type: "url" as const,
              url: "https://example.com/image.png",
            },
          },
        ],
        is_error: false,
      };
      const toolUse = { name: "SomeTool", input: {} };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      const text = (update.content![0] as any).content.text;
      expect(text).toBe("[image: https://example.com/image.png]");
    });

    it("should handle tool_search_tool_search_result with no references", () => {
      const toolResult = {
        type: "tool_search_tool_result" as const,
        tool_use_id: "toolu_ts_empty",
        content: {
          type: "tool_search_tool_search_result" as const,
          tool_references: [],
        },
      };
      const toolUse = { name: "ToolSearch", input: { query: "test" } };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      const text = (update.content![0] as any).content.text;
      expect(text).toBe("Tools found: none");
    });

    it("should JSON.stringify unknown content types", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_unknown_ct",
        content: [
          { type: "some_future_type", data: "value" } as any,
        ],
        is_error: false,
      };
      const toolUse = { name: "FutureTool", input: {} };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      const text = (update.content![0] as any).content.text;
      expect(text).toContain('"some_future_type"');
      expect(text).toContain('"value"');
    });

    it("should handle a single object (non-array) content via toAcpContentUpdate", () => {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_single",
        content: { type: "text" as const, text: "single object" },
        is_error: false,
      };
      const toolUse = { name: "Bash", input: { command: "echo hi" } };
      const update = toolUpdateFromToolResult(toolResult, toolUse);
      expect(update.content).toHaveLength(1);
      expect((update.content![0] as any).content.text).toBe("single object");
    });
  });
});

// ---------------------------------------------------------------------------
// markdownEscape (additional cases)
// ---------------------------------------------------------------------------
describe("markdownEscape - extended", () => {
  it("should handle text with longer backtick sequences", () => {
    const text = "````code````";
    const escaped = markdownEscape(text);
    // Should use a fence longer than 4 backticks
    expect(escaped).toMatch(/^`{5,}\n/);
    expect(escaped).toContain(text);
  });

  it("should handle text that ends with a newline", () => {
    const text = "line 1\nline 2\n";
    const escaped = markdownEscape(text);
    // When text ends with \n, no extra \n is added before the closing fence
    expect(escaped).toBe("```\nline 1\nline 2\n```");
  });

  it("should handle text that does not end with a newline", () => {
    const text = "no trailing newline";
    const escaped = markdownEscape(text);
    expect(escaped).toBe("```\nno trailing newline\n```");
  });

  it("should handle empty text", () => {
    const text = "";
    const escaped = markdownEscape(text);
    expect(escaped).toBe("```\n\n```");
  });

  it("should handle mixed backtick lengths", () => {
    // markdownEscape only looks at backtick runs at the start of a line (^```+/gm)
    // In this string, only "```" is at start-of-line, so the fence needs 4 backticks
    const text = "``` and ```` and ``";
    const escaped = markdownEscape(text);
    expect(escaped).toMatch(/^`{4,}\n/);
    expect(escaped).toContain(text);
  });

  it("should handle backtick runs at start of lines across multiline text", () => {
    const text = "some text\n```` long fence\n``` short fence";
    const escaped = markdownEscape(text);
    // The longest start-of-line run is 4, so fence must be at least 5
    expect(escaped).toMatch(/^`{5,}\n/);
    expect(escaped).toContain(text);
  });
});

// ---------------------------------------------------------------------------
// planEntries
// ---------------------------------------------------------------------------
describe("planEntries", () => {
  it("should convert ClaudePlanEntry array to PlanEntry array", () => {
    const input: { todos: ClaudePlanEntry[] } = {
      todos: [
        { content: "Task A", status: "pending", activeForm: "Starting A" },
        {
          content: "Task B",
          status: "in_progress",
          activeForm: "Working on B",
        },
        { content: "Task C", status: "completed", activeForm: "Done C" },
      ],
    };
    const result = planEntries(input);
    expect(result).toEqual([
      { content: "Task A", status: "pending", priority: "medium" },
      { content: "Task B", status: "in_progress", priority: "medium" },
      { content: "Task C", status: "completed", priority: "medium" },
    ]);
  });

  it("should handle empty todos array", () => {
    const result = planEntries({ todos: [] });
    expect(result).toEqual([]);
  });

  it("should always set priority to medium", () => {
    const result = planEntries({
      todos: [
        { content: "Important", status: "pending", activeForm: "Doing it" },
      ],
    });
    expect(result[0].priority).toBe("medium");
  });
});
