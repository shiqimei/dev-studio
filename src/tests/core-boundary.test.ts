/**
 * Static analysis tests that enforce the core/ app's architectural boundaries.
 *
 * The core app is a pure ACP client: the frontend (core/client/) is browser-only UI,
 * and the backend (core/server/) communicates exclusively through ACP protocol.
 * Neither layer should ever import from the main ../../src/ codebase.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";

const CORE_ROOT = path.resolve(__dirname, "../../core");

/** Recursively collect all .ts/.tsx files under a directory. */
function collectFiles(dir: string, exts = [".ts", ".tsx"]): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      results.push(...collectFiles(full, exts));
    } else if (exts.some((e) => full.endsWith(e))) {
      results.push(full);
    }
  }
  return results;
}

/** Extract all import specifiers from a file's source text. */
function extractImports(source: string): string[] {
  const importRe = /(?:^|\n)\s*import\s+(?:[\s\S]*?)\s+from\s+["']([^"']+)["']/g;
  const results: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(source)) !== null) {
    results.push(m[1]);
  }
  return results;
}

function rel(filePath: string) {
  return path.relative(CORE_ROOT, filePath);
}

// ────────────────────────────────────────────────────────────
// Collect files once
// ────────────────────────────────────────────────────────────

const allCoreFiles = collectFiles(CORE_ROOT);
const frontendFiles = allCoreFiles.filter((f) => f.startsWith(path.join(CORE_ROOT, "client")));
const serverFiles = allCoreFiles.filter((f) => f.startsWith(path.join(CORE_ROOT, "server")));

// ────────────────────────────────────────────────────────────
// 1. No imports from ../../src/ (the main codebase)
// ────────────────────────────────────────────────────────────

describe("core/ has no imports from main src/", () => {
  it("no file in core/ imports from ../../src/", () => {
    const violations: string[] = [];
    for (const file of allCoreFiles) {
      const source = readFileSync(file, "utf-8");
      const imports = extractImports(source);
      for (const spec of imports) {
        if (spec.includes("../../src/") || spec.includes("../../src\\")) {
          violations.push(`${rel(file)}: import "${spec}"`);
        }
      }
    }
    expect(violations, `Found internal src/ imports in core:\n${violations.join("\n")}`).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────
// 2. Frontend (core/client/) is browser-pure
// ────────────────────────────────────────────────────────────

describe("core/client/ is browser-pure (no Node.js built-ins)", () => {
  const nodeBuiltinPattern = /^node:/;

  it("no file in core/client/ imports a node: built-in", () => {
    const violations: string[] = [];
    for (const file of frontendFiles) {
      const source = readFileSync(file, "utf-8");
      const imports = extractImports(source);
      for (const spec of imports) {
        if (nodeBuiltinPattern.test(spec)) {
          violations.push(`${rel(file)}: import "${spec}"`);
        }
      }
    }
    expect(violations, `Frontend files import Node.js built-ins:\n${violations.join("\n")}`).toEqual([]);
  });

  it("no file in core/client/ imports node:fs or node:child_process", () => {
    const forbidden = ["node:fs", "node:child_process", "node:os", "fs", "child_process", "os"];
    const violations: string[] = [];
    for (const file of frontendFiles) {
      const source = readFileSync(file, "utf-8");
      const imports = extractImports(source);
      for (const spec of imports) {
        if (forbidden.includes(spec)) {
          violations.push(`${rel(file)}: import "${spec}"`);
        }
      }
    }
    expect(violations, `Frontend files import forbidden system modules:\n${violations.join("\n")}`).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────
// 3. No direct Claude Agent SDK usage (must go through ACP)
// ────────────────────────────────────────────────────────────

describe("core/ uses ACP protocol, not raw Claude Agent SDK", () => {
  it("no file in core/ imports @anthropic-ai/claude-agent-sdk", () => {
    const violations: string[] = [];
    for (const file of allCoreFiles) {
      const source = readFileSync(file, "utf-8");
      const imports = extractImports(source);
      for (const spec of imports) {
        if (spec.startsWith("@anthropic-ai/claude-agent-sdk")) {
          violations.push(`${rel(file)}: import "${spec}"`);
        }
      }
    }
    expect(violations, `Core files import raw SDK instead of ACP:\n${violations.join("\n")}`).toEqual([]);
  });

  it("no file in core/ imports @anthropic-ai/sdk", () => {
    const violations: string[] = [];
    for (const file of allCoreFiles) {
      const source = readFileSync(file, "utf-8");
      const imports = extractImports(source);
      for (const spec of imports) {
        if (spec.startsWith("@anthropic-ai/sdk")) {
          violations.push(`${rel(file)}: import "${spec}"`);
        }
      }
    }
    expect(violations, `Core files import Anthropic SDK directly:\n${violations.join("\n")}`).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────
// 4. Server uses ACP for disk/session operations (no node:fs)
// ────────────────────────────────────────────────────────────

describe("core/server/ uses ACP for data access, not filesystem", () => {
  const forbiddenServerModules = ["node:fs", "node:fs/promises", "fs", "fs/promises"];

  it("no file in core/server/ imports node:fs or fs", () => {
    const violations: string[] = [];
    for (const file of serverFiles) {
      const source = readFileSync(file, "utf-8");
      const imports = extractImports(source);
      for (const spec of imports) {
        if (forbiddenServerModules.includes(spec)) {
          violations.push(`${rel(file)}: import "${spec}"`);
        }
      }
    }
    expect(violations, `Server files use filesystem directly instead of ACP:\n${violations.join("\n")}`).toEqual([]);
  });

  it("server.ts uses ACP methods for session operations", () => {
    const serverTs = serverFiles.find((f) => f.endsWith("server.ts"));
    expect(serverTs).toBeDefined();
    const source = readFileSync(serverTs!, "utf-8");

    // session/list uses extMethod
    expect(source).toContain('extMethod("sessions/list"');
    // Other session operations use extMethod
    expect(source).toContain('extMethod("sessions/getHistory"');
    expect(source).toContain('extMethod("sessions/rename"');
    expect(source).toContain('extMethod("sessions/delete"');
  });

  it("server.ts does not directly read session files from disk", () => {
    const serverTs = serverFiles.find((f) => f.endsWith("server.ts"));
    expect(serverTs).toBeDefined();
    const source = readFileSync(serverTs!, "utf-8");

    // Should not contain direct disk access patterns
    expect(source).not.toMatch(/readFileSync|readFile\(/);
    expect(source).not.toMatch(/writeFileSync|writeFile\(/);
    expect(source).not.toMatch(/readdirSync|readdir\(/);
    expect(source).not.toMatch(/\.claude\/projects/);
  });
});

// ────────────────────────────────────────────────────────────
// 5. Server only uses allowed Node.js built-ins
// ────────────────────────────────────────────────────────────

describe("core/server/ only uses allowed Node.js built-ins", () => {
  // These are the only node: modules the server legitimately needs:
  // - node:child_process — spawning the agent process
  // - node:path — resolving file paths
  // - node:stream / node:stream/web — bridging streams for ACP transport
  const allowedNodeModules = new Set([
    "node:child_process",
    "node:path",
    "node:stream",
    "node:stream/web",
  ]);

  it("server files only import allowed node: modules", () => {
    const violations: string[] = [];
    for (const file of serverFiles) {
      const source = readFileSync(file, "utf-8");
      const imports = extractImports(source);
      for (const spec of imports) {
        if (spec.startsWith("node:") && !allowedNodeModules.has(spec)) {
          violations.push(`${rel(file)}: import "${spec}" (not in allowlist)`);
        }
      }
    }
    expect(violations, `Server imports disallowed node: modules:\n${violations.join("\n")}`).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────
// 6. ACP SDK is used in server (positive check)
// ────────────────────────────────────────────────────────────

describe("core/server/ uses @agentclientprotocol/sdk", () => {
  it("at least one server file imports from @agentclientprotocol/sdk", () => {
    let found = false;
    for (const file of serverFiles) {
      const source = readFileSync(file, "utf-8");
      const imports = extractImports(source);
      if (imports.some((s) => s.startsWith("@agentclientprotocol/"))) {
        found = true;
        break;
      }
    }
    expect(found, "Server must import from @agentclientprotocol/sdk").toBe(true);
  });
});
