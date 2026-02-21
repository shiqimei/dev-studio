/**
 * Test result parser — pure functions that parse test runner output
 * into structured results. No side effects, no I/O.
 *
 * Supports: vitest, jest, pytest, cargo test, go test, mocha.
 * Falls back to generic heuristics for unknown runners.
 */
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TestRunner = "vitest" | "jest" | "pytest" | "cargo" | "go" | "mocha" | "unknown";

export interface TestFailure {
  name: string;
  file?: string;
  message: string;
}

export interface TestResult {
  runner: TestRunner;
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  duration?: number;
  failures: TestFailure[];
  raw: string;
}

// ---------------------------------------------------------------------------
// Runner detection
// ---------------------------------------------------------------------------

const RUNNER_PATTERNS: Array<{ pattern: RegExp; runner: TestRunner }> = [
  { pattern: /\bvitest\b/, runner: "vitest" },
  { pattern: /\bjest\b/, runner: "jest" },
  { pattern: /\bpytest\b/, runner: "pytest" },
  { pattern: /\bpython\s+-m\s+pytest\b/, runner: "pytest" },
  { pattern: /\bcargo\s+test\b/, runner: "cargo" },
  { pattern: /\bgo\s+test\b/, runner: "go" },
  { pattern: /\bmocha\b/, runner: "mocha" },
  // npm test / npx vitest etc. — check for runner names in the full command
  { pattern: /\bnpm\s+test\b/, runner: "unknown" },
  { pattern: /\bnpx\s+vitest\b/, runner: "vitest" },
  { pattern: /\bnpx\s+jest\b/, runner: "jest" },
  { pattern: /\bnpx\s+mocha\b/, runner: "mocha" },
];

/** Detect the test runner from a Bash command string. Returns null if not a test command. */
export function detectTestRunner(command: string): TestRunner | null {
  for (const { pattern, runner } of RUNNER_PATTERNS) {
    if (pattern.test(command)) return runner;
  }
  return null;
}

/** Convenience: is this a test command? */
export function isTestCommand(command: string): boolean {
  return detectTestRunner(command) !== null;
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

/** Parse test runner output into a structured TestResult. */
export function parseTestOutput(runner: TestRunner, output: string): TestResult {
  const raw = output.slice(0, 500);

  switch (runner) {
    case "vitest":
      return parseVitest(output, raw);
    case "jest":
      return parseJest(output, raw);
    case "pytest":
      return parsePytest(output, raw);
    case "cargo":
      return parseCargo(output, raw);
    case "go":
      return parseGo(output, raw);
    case "mocha":
      return parseMocha(output, raw);
    case "unknown":
      return parseGeneric(output, raw);
    default:
      return parseGeneric(output, raw);
  }
}

// ---------------------------------------------------------------------------
// Vitest / Jest (share similar output format)
// ---------------------------------------------------------------------------

function parseVitest(output: string, raw: string): TestResult {
  const result = parseVitestJestShared(output, raw);
  result.runner = "vitest";

  // Vitest-specific: "Tests  2 failed | 3 passed (5)"
  const summaryMatch = output.match(
    /Tests\s+(?:(\d+)\s+failed\s*\|?\s*)?(?:(\d+)\s+passed\s*\|?\s*)?(?:(\d+)\s+skipped\s*\|?\s*)?\((\d+)\)/,
  );
  if (summaryMatch) {
    result.failed = parseInt(summaryMatch[1] || "0", 10);
    result.passed = parseInt(summaryMatch[2] || "0", 10);
    result.skipped = parseInt(summaryMatch[3] || "0", 10);
    result.total = parseInt(summaryMatch[4], 10);
  }

  // Duration: "Duration  1.23s" or "Duration  123ms"
  const durationMatch = output.match(/Duration\s+([\d.]+)(m?s)/);
  if (durationMatch) {
    const val = parseFloat(durationMatch[1]);
    result.duration = durationMatch[2] === "ms" ? val : val * 1000;
  }

  return result;
}

function parseJest(output: string, raw: string): TestResult {
  const result = parseVitestJestShared(output, raw);
  result.runner = "jest";

  // Jest summary: "Tests:       2 failed, 3 passed, 5 total"
  const summaryMatch = output.match(
    /Tests:\s+(?:(\d+)\s+failed,?\s*)?(?:(\d+)\s+skipped,?\s*)?(?:(\d+)\s+passed,?\s*)?(\d+)\s+total/,
  );
  if (summaryMatch) {
    result.failed = parseInt(summaryMatch[1] || "0", 10);
    result.skipped = parseInt(summaryMatch[2] || "0", 10);
    result.passed = parseInt(summaryMatch[3] || "0", 10);
    result.total = parseInt(summaryMatch[4], 10);
  }

  // Duration: "Time:        1.234 s"
  const durationMatch = output.match(/Time:\s+([\d.]+)\s*s/);
  if (durationMatch) {
    result.duration = parseFloat(durationMatch[1]) * 1000;
  }

  return result;
}

/** Shared failure extraction for vitest and jest. */
function parseVitestJestShared(output: string, raw: string): TestResult {
  const failures: TestFailure[] = [];

  // Pattern: "FAIL path/to/file.test.ts" followed by failure details
  // Or: "❯ test name" / "× test name" / "✕ test name"
  const failBlockRegex =
    /(?:FAIL|❌)\s+([^\n]+\.(?:test|spec)\.[jt]sx?)\s*\n([\s\S]*?)(?=(?:\n\s*(?:FAIL|PASS|❌|✅)|\nTest Suites:|\nTests:|\n\s*$))/g;
  let match;
  while ((match = failBlockRegex.exec(output)) !== null) {
    const file = match[1].trim();
    const block = match[2];

    // Extract individual test failures within the block
    const testFailRegex = /[×✕❯]\s+(.+?)(?:\n\s*\n|\n\s+(?:Error|expect|Received|AssertionError))/g;
    let testMatch;
    while ((testMatch = testFailRegex.exec(block)) !== null) {
      const name = testMatch[1].trim();
      // Try to get the error message following the test name
      const afterName = block.slice(testMatch.index + testMatch[0].length);
      const msgMatch = afterName.match(/^\s*([\s\S]{1,300}?)(?:\n\s*\n|\n\s+at\s)/);
      failures.push({
        name,
        file,
        message: (msgMatch?.[1] || "").trim().slice(0, 300),
      });
    }

    // If no individual tests matched, treat the whole block as one failure
    if (failures.length === 0 || failures[failures.length - 1]?.file !== file) {
      const msgLines = block
        .split("\n")
        .filter((l) => l.trim())
        .slice(0, 3)
        .join(" ")
        .trim();
      failures.push({
        name: path.basename(file),
        file,
        message: msgLines.slice(0, 300),
      });
    }
  }

  // Simpler pattern: "FAIL  src/tests/foo.test.ts > test name"
  if (failures.length === 0) {
    const simpleFailRegex = /FAIL\s+([^\n>]+)>\s*([^\n]+)/g;
    while ((match = simpleFailRegex.exec(output)) !== null) {
      failures.push({
        name: match[2].trim(),
        file: match[1].trim(),
        message: "",
      });
    }
  }

  // Look for AssertionError or expect() messages if we still have no message
  if (failures.length > 0 && !failures[0].message) {
    const errMatch = output.match(
      /(?:AssertionError|Error|expected|expect\(received\))[\s\S]{0,300}/,
    );
    if (errMatch && failures[0]) {
      failures[0].message = errMatch[0].trim().slice(0, 300);
    }
  }

  return {
    runner: "unknown",
    passed: 0,
    failed: failures.length,
    skipped: 0,
    total: 0,
    failures,
    raw,
  };
}

// ---------------------------------------------------------------------------
// Pytest
// ---------------------------------------------------------------------------

function parsePytest(output: string, raw: string): TestResult {
  const failures: TestFailure[] = [];

  // Summary line: "2 failed, 3 passed, 1 skipped in 1.23s"
  // or "=== 2 failed, 3 passed in 1.23s ==="
  const summaryMatch = output.match(
    /=*\s*(?:(\d+)\s+failed)?[,\s]*(?:(\d+)\s+passed)?[,\s]*(?:(\d+)\s+skipped)?[,\s]*(?:(\d+)\s+error)?[,\s]*in\s+([\d.]+)s?\s*=*/,
  );

  const failed = parseInt(summaryMatch?.[1] || "0", 10);
  const passed = parseInt(summaryMatch?.[2] || "0", 10);
  const skipped = parseInt(summaryMatch?.[3] || "0", 10);
  const errors = parseInt(summaryMatch?.[4] || "0", 10);
  const duration = summaryMatch?.[5] ? parseFloat(summaryMatch[5]) * 1000 : undefined;

  // Individual failures: "FAILED tests/test_foo.py::test_bar - AssertionError: ..."
  const failRegex = /FAILED\s+([^\s]+)::([^\s-]+)\s*(?:-\s*(.+))?/g;
  let match;
  while ((match = failRegex.exec(output)) !== null) {
    failures.push({
      name: match[2].trim(),
      file: match[1].trim(),
      message: (match[3] || "").trim().slice(0, 300),
    });
  }

  // Failure blocks: "_ test_name _" sections
  if (failures.length === 0 && failed > 0) {
    const blockRegex = /_{3,}\s+(\S+)\s+_{3,}\s*\n([\s\S]*?)(?=_{3,}|={3,}|FAILED|$)/g;
    while ((match = blockRegex.exec(output)) !== null) {
      const msgLines = match[2]
        .split("\n")
        .filter((l) => l.trim() && !l.startsWith(">"))
        .slice(-3)
        .join(" ")
        .trim();
      failures.push({
        name: match[1].trim(),
        message: msgLines.slice(0, 300),
      });
    }
  }

  return {
    runner: "pytest",
    passed,
    failed: failed + errors,
    skipped,
    total: passed + failed + skipped + errors,
    duration,
    failures,
    raw,
  };
}

// ---------------------------------------------------------------------------
// Cargo test
// ---------------------------------------------------------------------------

function parseCargo(output: string, raw: string): TestResult {
  const failures: TestFailure[] = [];

  // Summary: "test result: FAILED. 5 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out"
  // or: "test result: ok. 10 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out"
  const summaryMatch = output.match(
    /test result:\s+\w+\.\s+(\d+)\s+passed;\s+(\d+)\s+failed;\s+(\d+)\s+ignored/,
  );

  const passed = parseInt(summaryMatch?.[1] || "0", 10);
  const failed = parseInt(summaryMatch?.[2] || "0", 10);
  const skipped = parseInt(summaryMatch?.[3] || "0", 10);

  // Individual failures: "---- test_name stdout ----" followed by assertion output
  const failRegex =
    /----\s+(\S+)\s+stdout\s+----\s*\n([\s\S]*?)(?=----\s+\S+\s+stdout|failures::|test result:)/g;
  let match;
  while ((match = failRegex.exec(output)) !== null) {
    const name = match[1].trim();
    const msg = match[2].trim().split("\n").slice(0, 5).join(" ").trim();
    failures.push({
      name,
      message: msg.slice(0, 300),
    });
  }

  // Failure list: "failures:\n    test_name\n    test_name"
  if (failures.length === 0 && failed > 0) {
    const listMatch = output.match(/failures:\s*\n((?:\s+\S+\n?)+)/);
    if (listMatch) {
      const names = listMatch[1]
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      for (const name of names) {
        failures.push({ name, message: "" });
      }
    }
  }

  // Duration: "finished in 1.23s"
  const durationMatch = output.match(/finished in\s+([\d.]+)s/);
  const duration = durationMatch ? parseFloat(durationMatch[1]) * 1000 : undefined;

  return {
    runner: "cargo",
    passed,
    failed,
    skipped,
    total: passed + failed + skipped,
    duration,
    failures,
    raw,
  };
}

// ---------------------------------------------------------------------------
// Go test
// ---------------------------------------------------------------------------

function parseGo(output: string, raw: string): TestResult {
  const failures: TestFailure[] = [];
  let passed = 0;
  let failed = 0;

  // Individual failures: "--- FAIL: TestName (0.00s)"
  const failRegex = /---\s+FAIL:\s+(\S+)\s+\(([\d.]+)s\)\s*\n?([\s\S]*?)(?=---\s+(?:FAIL|PASS)|ok\s|FAIL\s|\n\n|$)/g;
  let match;
  while ((match = failRegex.exec(output)) !== null) {
    const msg = match[3]
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 3)
      .join(" ");
    failures.push({
      name: match[1].trim(),
      message: msg.slice(0, 300),
    });
  }

  // Package results: "ok  \tpkg\t0.123s" and "FAIL\tpkg\t0.123s"
  const okRegex = /^ok\s+\S+\s+([\d.]+)s/gm;
  const failPkgRegex = /^FAIL\s+(\S+)\s+([\d.]+)s/gm;
  while (okRegex.exec(output)) passed++;
  while ((match = failPkgRegex.exec(output)) !== null) failed++;

  // If we found individual FAIL tests, use those counts instead
  if (failures.length > 0) {
    failed = failures.length;
  }

  // Count passing tests: "--- PASS: TestName"
  const passRegex = /---\s+PASS:\s+\S+/g;
  let passCount = 0;
  while (passRegex.exec(output)) passCount++;
  if (passCount > 0) passed = passCount;

  // Duration from last "ok" or "FAIL" line
  const durationMatch = output.match(/(?:ok|FAIL)\s+\S+\s+([\d.]+)s\s*$/m);
  const duration = durationMatch ? parseFloat(durationMatch[1]) * 1000 : undefined;

  return {
    runner: "go",
    passed,
    failed,
    skipped: 0,
    total: passed + failed,
    duration,
    failures,
    raw,
  };
}

// ---------------------------------------------------------------------------
// Mocha
// ---------------------------------------------------------------------------

function parseMocha(output: string, raw: string): TestResult {
  const failures: TestFailure[] = [];

  // Summary: "  2 passing (1s)\n  1 failing"
  const passingMatch = output.match(/(\d+)\s+passing\s+\(([^)]+)\)/);
  const failingMatch = output.match(/(\d+)\s+failing/);
  const pendingMatch = output.match(/(\d+)\s+pending/);

  const passed = parseInt(passingMatch?.[1] || "0", 10);
  const failed = parseInt(failingMatch?.[1] || "0", 10);
  const skipped = parseInt(pendingMatch?.[1] || "0", 10);

  // Duration from passing line
  let duration: number | undefined;
  if (passingMatch?.[2]) {
    const durStr = passingMatch[2];
    const msMatch = durStr.match(/([\d.]+)ms/);
    const sMatch = durStr.match(/([\d.]+)s/);
    if (msMatch) duration = parseFloat(msMatch[1]);
    else if (sMatch) duration = parseFloat(sMatch[1]) * 1000;
  }

  // Individual failures: "  1) test name:\n     Error: message"
  const failBlockRegex = /\d+\)\s+(.+?):\s*\n\s+([\s\S]*?)(?=\n\s*\d+\)|\n\n|$)/g;
  let match;
  while ((match = failBlockRegex.exec(output)) !== null) {
    const msg = match[2]
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 3)
      .join(" ");
    failures.push({
      name: match[1].trim(),
      message: msg.slice(0, 300),
    });
  }

  return {
    runner: "mocha",
    passed,
    failed,
    skipped,
    total: passed + failed + skipped,
    duration,
    failures,
    raw,
  };
}

// ---------------------------------------------------------------------------
// Generic fallback
// ---------------------------------------------------------------------------

function parseGeneric(output: string, raw: string): TestResult {
  const failures: TestFailure[] = [];

  // Look for common patterns
  const failCount =
    (output.match(/\bfail(ed|ure|ing)?\b/gi) || []).length -
    (output.match(/\bno\s+fail/gi) || []).length;
  const passCount = (output.match(/\bpass(ed|ing)?\b/gi) || []).length;

  // Try to extract a summary line: "N passed, M failed"
  const summaryMatch = output.match(/(\d+)\s+passed[,\s]+(\d+)\s+failed/i);
  if (summaryMatch) {
    const passed = parseInt(summaryMatch[1], 10);
    const failed = parseInt(summaryMatch[2], 10);
    return {
      runner: "unknown",
      passed,
      failed,
      skipped: 0,
      total: passed + failed,
      failures,
      raw,
    };
  }

  // Detect failure from exit code pattern
  const exitCodeMatch = output.match(/exit(?:ed with)?\s+code\s+(\d+)/i);
  const hasExitFailure = exitCodeMatch && exitCodeMatch[1] !== "0";

  return {
    runner: "unknown",
    passed: passCount > 0 ? passCount : 0,
    failed: hasExitFailure ? Math.max(1, failCount) : failCount > 0 ? failCount : 0,
    skipped: 0,
    total: passCount + (hasExitFailure ? Math.max(1, failCount) : failCount),
    failures,
    raw,
  };
}
