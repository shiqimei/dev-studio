import { describe, it, expect } from "vitest";
import { promptToClaude } from "../acp-agent.js";

describe("promptToClaude", () => {
  // ---------------------------------------------------------------------------
  // Return structure
  // ---------------------------------------------------------------------------
  describe("return structure", () => {
    it("returns an SDKUserMessage with type 'user'", () => {
      const result = promptToClaude({
        sessionId: "sess-1",
        prompt: [{ type: "text", text: "hello" }],
      });
      expect(result.type).toBe("user");
    });

    it("has message.role set to 'user'", () => {
      const result = promptToClaude({
        sessionId: "sess-1",
        prompt: [{ type: "text", text: "hello" }],
      });
      expect(result.message.role).toBe("user");
    });

    it("sets session_id from prompt.sessionId", () => {
      const result = promptToClaude({
        sessionId: "my-session-42",
        prompt: [{ type: "text", text: "hello" }],
      });
      expect(result.session_id).toBe("my-session-42");
    });

    it("sets parent_tool_use_id to null", () => {
      const result = promptToClaude({
        sessionId: "sess-1",
        prompt: [{ type: "text", text: "hello" }],
      });
      expect(result.parent_tool_use_id).toBeNull();
    });

    it("returns empty content array for an empty prompt", () => {
      const result = promptToClaude({
        sessionId: "sess-1",
        prompt: [],
      });
      expect(result.message.content).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Text content handling
  // ---------------------------------------------------------------------------
  describe("text content", () => {
    it("passes plain text through unchanged", () => {
      const result = promptToClaude({
        sessionId: "sess-1",
        prompt: [{ type: "text", text: "Hello world" }],
      });
      expect(result.message.content).toEqual([{ type: "text", text: "Hello world" }]);
    });

    it("passes regular text that is not a slash command through unchanged", () => {
      const result = promptToClaude({
        sessionId: "sess-1",
        prompt: [{ type: "text", text: "just some regular text" }],
      });
      expect(result.message.content).toEqual([{ type: "text", text: "just some regular text" }]);
    });

    it("passes non-MCP slash commands through unchanged", () => {
      const result = promptToClaude({
        sessionId: "sess-1",
        prompt: [{ type: "text", text: "/compact args" }],
      });
      expect(result.message.content).toEqual([{ type: "text", text: "/compact args" }]);
    });

    it("transforms MCP slash command with args: /mcp:server:command args -> /server:command (MCP) args", () => {
      const result = promptToClaude({
        sessionId: "sess-1",
        prompt: [{ type: "text", text: "/mcp:myserver:mycommand some arguments here" }],
      });
      expect(result.message.content).toEqual([
        { type: "text", text: "/myserver:mycommand (MCP) some arguments here" },
      ]);
    });

    it("transforms MCP slash command without args", () => {
      const result = promptToClaude({
        sessionId: "sess-1",
        prompt: [{ type: "text", text: "/mcp:myserver:mycommand" }],
      });
      expect(result.message.content).toEqual([
        { type: "text", text: "/myserver:mycommand (MCP)" },
      ]);
    });

    it("does not transform text that merely contains /mcp: but is not at start", () => {
      const result = promptToClaude({
        sessionId: "sess-1",
        prompt: [{ type: "text", text: "run /mcp:server:cmd" }],
      });
      expect(result.message.content).toEqual([
        { type: "text", text: "run /mcp:server:cmd" },
      ]);
    });

    it("handles empty text string", () => {
      const result = promptToClaude({
        sessionId: "sess-1",
        prompt: [{ type: "text", text: "" }],
      });
      expect(result.message.content).toEqual([{ type: "text", text: "" }]);
    });
  });

  // ---------------------------------------------------------------------------
  // Resource link handling (formatUriAsLink tested indirectly)
  // ---------------------------------------------------------------------------
  describe("resource_link handling", () => {
    it("formats file:// URI as markdown link with filename", () => {
      const result = promptToClaude({
        sessionId: "sess-1",
        prompt: [{ type: "resource_link", uri: "file:///path/to/file.txt" }],
      });
      expect(result.message.content).toEqual([
        { type: "text", text: "[@file.txt](file:///path/to/file.txt)" },
      ]);
    });

    it("formats file:// URI with nested path correctly", () => {
      const result = promptToClaude({
        sessionId: "sess-1",
        prompt: [{ type: "resource_link", uri: "file:///Users/dev/project/src/index.ts" }],
      });
      expect(result.message.content).toEqual([
        { type: "text", text: "[@index.ts](file:///Users/dev/project/src/index.ts)" },
      ]);
    });

    it("formats zed:// URI as markdown link with last segment", () => {
      const result = promptToClaude({
        sessionId: "sess-1",
        prompt: [{ type: "resource_link", uri: "zed://path/to/thing" }],
      });
      expect(result.message.content).toEqual([
        { type: "text", text: "[@thing](zed://path/to/thing)" },
      ]);
    });

    it("returns http URI as-is (no markdown link)", () => {
      const result = promptToClaude({
        sessionId: "sess-1",
        prompt: [{ type: "resource_link", uri: "https://example.com/page" }],
      });
      expect(result.message.content).toEqual([
        { type: "text", text: "https://example.com/page" },
      ]);
    });

    it("returns other protocol URIs as-is", () => {
      const result = promptToClaude({
        sessionId: "sess-1",
        prompt: [{ type: "resource_link", uri: "custom://some/resource" }],
      });
      expect(result.message.content).toEqual([
        { type: "text", text: "custom://some/resource" },
      ]);
    });

    it("handles file:// URI with trailing slash (empty filename fallback)", () => {
      const result = promptToClaude({
        sessionId: "sess-1",
        prompt: [{ type: "resource_link", uri: "file:///some/dir/" }],
      });
      // path.split("/").pop() returns "" for trailing slash, so falls back to full path
      expect(result.message.content).toEqual([
        { type: "text", text: "[@/some/dir/](file:///some/dir/)" },
      ]);
    });

    it("handles file:// URI with root path only", () => {
      const result = promptToClaude({
        sessionId: "sess-1",
        prompt: [{ type: "resource_link", uri: "file:///" }],
      });
      // slice(7) gives "/", split("/").pop() gives "", fallback to "/"
      expect(result.message.content).toEqual([
        { type: "text", text: "[@/](file:///)" },
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // Resource handling
  // ---------------------------------------------------------------------------
  describe("resource handling", () => {
    it("adds text resource as link + context block", () => {
      const result = promptToClaude({
        sessionId: "sess-1",
        prompt: [
          {
            type: "resource",
            resource: {
              uri: "file:///path/to/file.txt",
              text: "file content here",
            },
          },
        ],
      });
      // Content should have both the link text and the context block
      expect(result.message.content).toEqual([
        { type: "text", text: "[@file.txt](file:///path/to/file.txt)" },
        {
          type: "text",
          text: '\n<context ref="file:///path/to/file.txt">\nfile content here\n</context>',
        },
      ]);
    });

    it("formats resource URI through formatUriAsLink (zed://)", () => {
      const result = promptToClaude({
        sessionId: "sess-1",
        prompt: [
          {
            type: "resource",
            resource: {
              uri: "zed://workspace/buffer",
              text: "buffer content",
            },
          },
        ],
      });
      expect(result.message.content[0]).toEqual({
        type: "text",
        text: "[@buffer](zed://workspace/buffer)",
      });
      expect(result.message.content[1]).toEqual({
        type: "text",
        text: '\n<context ref="zed://workspace/buffer">\nbuffer content\n</context>',
      });
    });

    it("ignores blob resource (no content added)", () => {
      const result = promptToClaude({
        sessionId: "sess-1",
        prompt: [
          {
            type: "resource",
            resource: {
              uri: "file:///path/to/image.png",
              blob: "iVBORw0KGgo=",
            },
          } as any,
        ],
      });
      expect(result.message.content).toEqual([]);
    });

    it("context blocks are appended after all content blocks", () => {
      const result = promptToClaude({
        sessionId: "sess-1",
        prompt: [
          { type: "text", text: "Look at this file" },
          {
            type: "resource",
            resource: {
              uri: "file:///a.txt",
              text: "content A",
            },
          },
        ],
      });
      // Order: text content, resource link, then context at end
      expect(result.message.content).toEqual([
        { type: "text", text: "Look at this file" },
        { type: "text", text: "[@a.txt](file:///a.txt)" },
        { type: "text", text: '\n<context ref="file:///a.txt">\ncontent A\n</context>' },
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // Image handling
  // ---------------------------------------------------------------------------
  describe("image handling", () => {
    it("handles base64 image with data", () => {
      const result = promptToClaude({
        sessionId: "sess-1",
        prompt: [
          {
            type: "image",
            data: "iVBORw0KGgoAAAANS",
            mimeType: "image/png",
          },
        ],
      });
      expect(result.message.content).toEqual([
        {
          type: "image",
          source: {
            type: "base64",
            data: "iVBORw0KGgoAAAANS",
            media_type: "image/png",
          },
        },
      ]);
    });

    it("handles URL image starting with http", () => {
      const result = promptToClaude({
        sessionId: "sess-1",
        prompt: [
          {
            type: "image",
            uri: "https://example.com/image.png",
          },
        ],
      });
      expect(result.message.content).toEqual([
        {
          type: "image",
          source: {
            type: "url",
            url: "https://example.com/image.png",
          },
        },
      ]);
    });

    it("handles URL image with http (not https)", () => {
      const result = promptToClaude({
        sessionId: "sess-1",
        prompt: [
          {
            type: "image",
            uri: "http://example.com/photo.jpg",
          },
        ],
      });
      expect(result.message.content).toEqual([
        {
          type: "image",
          source: {
            type: "url",
            url: "http://example.com/photo.jpg",
          },
        },
      ]);
    });

    it("ignores image without data or http URI", () => {
      const result = promptToClaude({
        sessionId: "sess-1",
        prompt: [
          {
            type: "image",
            uri: "file:///local/image.png",
          },
        ],
      });
      expect(result.message.content).toEqual([]);
    });

    it("ignores image with no data and no URI", () => {
      const result = promptToClaude({
        sessionId: "sess-1",
        prompt: [
          {
            type: "image",
          } as any,
        ],
      });
      expect(result.message.content).toEqual([]);
    });

    it("prefers base64 data over URI when both are present", () => {
      const result = promptToClaude({
        sessionId: "sess-1",
        prompt: [
          {
            type: "image",
            data: "base64data",
            mimeType: "image/jpeg",
            uri: "https://example.com/image.jpg",
          },
        ],
      });
      // data branch is checked first, so base64 wins
      expect(result.message.content).toEqual([
        {
          type: "image",
          source: {
            type: "base64",
            data: "base64data",
            media_type: "image/jpeg",
          },
        },
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // Default / unsupported types
  // ---------------------------------------------------------------------------
  describe("unsupported chunk types", () => {
    it("ignores unknown chunk types", () => {
      const result = promptToClaude({
        sessionId: "sess-1",
        prompt: [
          { type: "audio", data: "audiodata" } as any,
        ],
      });
      expect(result.message.content).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Multi-content prompts
  // ---------------------------------------------------------------------------
  describe("multi-content prompts", () => {
    it("handles mixed text + image", () => {
      const result = promptToClaude({
        sessionId: "sess-1",
        prompt: [
          { type: "text", text: "Describe this image" },
          { type: "image", data: "abc123", mimeType: "image/png" },
        ],
      });
      expect(result.message.content).toEqual([
        { type: "text", text: "Describe this image" },
        {
          type: "image",
          source: { type: "base64", data: "abc123", media_type: "image/png" },
        },
      ]);
    });

    it("handles mixed text + resource_link + resource with context at end", () => {
      const result = promptToClaude({
        sessionId: "sess-1",
        prompt: [
          { type: "text", text: "Check these files" },
          { type: "resource_link", uri: "file:///readme.md" },
          {
            type: "resource",
            resource: { uri: "file:///src/index.ts", text: "console.log('hi')" },
          },
        ],
      });
      expect(result.message.content).toEqual([
        { type: "text", text: "Check these files" },
        { type: "text", text: "[@readme.md](file:///readme.md)" },
        { type: "text", text: "[@index.ts](file:///src/index.ts)" },
        {
          type: "text",
          text: '\n<context ref="file:///src/index.ts">\nconsole.log(\'hi\')\n</context>',
        },
      ]);
    });

    it("handles text + image + resource with correct ordering", () => {
      const result = promptToClaude({
        sessionId: "sess-1",
        prompt: [
          { type: "text", text: "Analyze" },
          { type: "image", uri: "https://example.com/chart.png" },
          {
            type: "resource",
            resource: { uri: "file:///data.csv", text: "a,b,c\n1,2,3" },
          },
        ],
      });
      // content items in order, then context appended at end
      expect(result.message.content).toEqual([
        { type: "text", text: "Analyze" },
        { type: "image", source: { type: "url", url: "https://example.com/chart.png" } },
        { type: "text", text: "[@data.csv](file:///data.csv)" },
        {
          type: "text",
          text: '\n<context ref="file:///data.csv">\na,b,c\n1,2,3\n</context>',
        },
      ]);
    });

    it("handles multiple resources with all contexts appended at end", () => {
      const result = promptToClaude({
        sessionId: "sess-1",
        prompt: [
          {
            type: "resource",
            resource: { uri: "file:///a.ts", text: "content a" },
          },
          {
            type: "resource",
            resource: { uri: "file:///b.ts", text: "content b" },
          },
        ],
      });
      expect(result.message.content).toEqual([
        { type: "text", text: "[@a.ts](file:///a.ts)" },
        { type: "text", text: "[@b.ts](file:///b.ts)" },
        { type: "text", text: '\n<context ref="file:///a.ts">\ncontent a\n</context>' },
        { type: "text", text: '\n<context ref="file:///b.ts">\ncontent b\n</context>' },
      ]);
    });

    it("filters out unsupported types while keeping valid ones", () => {
      const result = promptToClaude({
        sessionId: "sess-1",
        prompt: [
          { type: "text", text: "hello" },
          { type: "audio", data: "xyz" } as any,
          { type: "image", data: "imgdata", mimeType: "image/gif" },
        ],
      });
      expect(result.message.content).toEqual([
        { type: "text", text: "hello" },
        {
          type: "image",
          source: { type: "base64", data: "imgdata", media_type: "image/gif" },
        },
      ]);
    });
  });
});
