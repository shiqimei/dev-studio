import { describe, it, expect } from "vitest";
import {
  detectTestRunner,
  isTestCommand,
  parseTestOutput,
  type TestRunner,
} from "../governor/test-parser.js";

// ---------------------------------------------------------------------------
// detectTestRunner
// ---------------------------------------------------------------------------

describe("detectTestRunner", () => {
  it("detects vitest", () => {
    expect(detectTestRunner("npx vitest run")).toBe("vitest");
    expect(detectTestRunner("vitest run src/tests/foo.test.ts")).toBe("vitest");
    expect(detectTestRunner("npx vitest")).toBe("vitest");
  });

  it("detects jest", () => {
    expect(detectTestRunner("npx jest")).toBe("jest");
    expect(detectTestRunner("jest --coverage")).toBe("jest");
  });

  it("detects pytest", () => {
    expect(detectTestRunner("pytest tests/")).toBe("pytest");
    expect(detectTestRunner("python -m pytest -v")).toBe("pytest");
  });

  it("detects cargo test", () => {
    expect(detectTestRunner("cargo test")).toBe("cargo");
    expect(detectTestRunner("cargo test -- --nocapture")).toBe("cargo");
  });

  it("detects go test", () => {
    expect(detectTestRunner("go test ./...")).toBe("go");
    expect(detectTestRunner("go test -v -run TestFoo")).toBe("go");
  });

  it("detects mocha", () => {
    expect(detectTestRunner("mocha tests/")).toBe("mocha");
    expect(detectTestRunner("npx mocha --recursive")).toBe("mocha");
  });

  it("detects npm test as unknown runner", () => {
    expect(detectTestRunner("npm test")).toBe("unknown");
  });

  it("returns null for non-test commands", () => {
    expect(detectTestRunner("ls -la")).toBeNull();
    expect(detectTestRunner("git status")).toBeNull();
    expect(detectTestRunner("tsc")).toBeNull();
    expect(detectTestRunner("npm install")).toBeNull();
  });
});

describe("isTestCommand", () => {
  it("returns true for test commands", () => {
    expect(isTestCommand("npx vitest run")).toBe(true);
    expect(isTestCommand("pytest")).toBe(true);
  });

  it("returns false for non-test commands", () => {
    expect(isTestCommand("ls")).toBe(false);
    expect(isTestCommand("npm install")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseTestOutput — vitest
// ---------------------------------------------------------------------------

describe("parseTestOutput — vitest", () => {
  const VITEST_PASS = `
 ✓ src/tests/hooks.test.ts (5)
 ✓ src/tests/store.test.ts (3)

 Test Files  2 passed (2)
      Tests  8 passed (8)
   Start at  14:23:01
   Duration  1.23s (transform 342ms, setup 12ms, collect 89ms, tests 456ms)
`;

  const VITEST_FAIL = `
 ❯ src/tests/hooks.test.ts (5)
   ✓ createPostToolUseHook
   × createContextExtractionHook
     → expected 3 but got 2
   ✓ createSubagentContextHook

 FAIL  src/tests/hooks.test.ts > createContextExtractionHook
   AssertionError: expected 3 but got 2

 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 7 passed (8)
   Start at  14:23:01
   Duration  2.45s
`;

  it("parses passing vitest output", () => {
    const result = parseTestOutput("vitest", VITEST_PASS);
    expect(result.runner).toBe("vitest");
    expect(result.passed).toBe(8);
    expect(result.failed).toBe(0);
    expect(result.total).toBe(8);
    expect(result.duration).toBeCloseTo(1230, -1);
    expect(result.failures).toHaveLength(0);
  });

  it("parses failing vitest output", () => {
    const result = parseTestOutput("vitest", VITEST_FAIL);
    expect(result.runner).toBe("vitest");
    expect(result.passed).toBe(7);
    expect(result.failed).toBe(1);
    expect(result.total).toBe(8);
    expect(result.duration).toBeCloseTo(2450, -1);
  });

  it("captures raw output (truncated to 500 chars)", () => {
    const result = parseTestOutput("vitest", VITEST_PASS);
    expect(result.raw.length).toBeLessThanOrEqual(500);
  });
});

// ---------------------------------------------------------------------------
// parseTestOutput — jest
// ---------------------------------------------------------------------------

describe("parseTestOutput — jest", () => {
  const JEST_FAIL = `
FAIL src/tests/auth.test.ts
  ● login flow › should validate credentials

    expect(received).toBe(expected)

    Expected: 200
    Received: 401

Tests:       1 failed, 4 passed, 5 total
Time:        3.456 s
`;

  it("parses failing jest output", () => {
    const result = parseTestOutput("jest", JEST_FAIL);
    expect(result.runner).toBe("jest");
    expect(result.failed).toBe(1);
    expect(result.passed).toBe(4);
    expect(result.total).toBe(5);
    expect(result.duration).toBeCloseTo(3456, -1);
  });
});

// ---------------------------------------------------------------------------
// parseTestOutput — pytest
// ---------------------------------------------------------------------------

describe("parseTestOutput — pytest", () => {
  const PYTEST_PASS = `
============================= test session starts ==============================
collected 12 items

tests/test_auth.py ....                                                  [ 33%]
tests/test_api.py ........                                               [100%]

============================== 12 passed in 0.45s ==============================
`;

  const PYTEST_FAIL = `
============================= test session starts ==============================
collected 12 items

tests/test_auth.py ...F                                                  [ 33%]
tests/test_api.py .....F..                                               [100%]

FAILED tests/test_auth.py::test_login - AssertionError: wrong status code
FAILED tests/test_api.py::test_create - ValueError: invalid input

=========================== 2 failed, 10 passed in 1.23s ======================
`;

  it("parses passing pytest output", () => {
    const result = parseTestOutput("pytest", PYTEST_PASS);
    expect(result.runner).toBe("pytest");
    expect(result.passed).toBe(12);
    expect(result.failed).toBe(0);
    expect(result.total).toBe(12);
    expect(result.duration).toBeCloseTo(450, -1);
  });

  it("parses failing pytest output with FAILED lines", () => {
    const result = parseTestOutput("pytest", PYTEST_FAIL);
    expect(result.runner).toBe("pytest");
    expect(result.passed).toBe(10);
    expect(result.failed).toBe(2);
    expect(result.total).toBe(12);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0].name).toBe("test_login");
    expect(result.failures[0].file).toBe("tests/test_auth.py");
    expect(result.failures[0].message).toContain("AssertionError");
    expect(result.failures[1].name).toBe("test_create");
    expect(result.failures[1].file).toBe("tests/test_api.py");
  });
});

// ---------------------------------------------------------------------------
// parseTestOutput — cargo test
// ---------------------------------------------------------------------------

describe("parseTestOutput — cargo test", () => {
  const CARGO_PASS = `
running 5 tests
test tests::test_add ... ok
test tests::test_sub ... ok
test tests::test_mul ... ok
test tests::test_div ... ok
test tests::test_mod ... ok

test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.12s
`;

  const CARGO_FAIL = `
running 3 tests
test tests::test_add ... ok
test tests::test_sub ... FAILED
test tests::test_mul ... ok

failures:

---- tests::test_sub stdout ----
thread 'tests::test_sub' panicked at 'assertion failed: 5 - 3 == 1', src/lib.rs:15:9

failures:
    tests::test_sub

test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.08s
`;

  it("parses passing cargo test output", () => {
    const result = parseTestOutput("cargo", CARGO_PASS);
    expect(result.runner).toBe("cargo");
    expect(result.passed).toBe(5);
    expect(result.failed).toBe(0);
    expect(result.total).toBe(5);
    expect(result.duration).toBeCloseTo(120, -1);
  });

  it("parses failing cargo test output", () => {
    const result = parseTestOutput("cargo", CARGO_FAIL);
    expect(result.runner).toBe("cargo");
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.total).toBe(3);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].name).toBe("tests::test_sub");
    expect(result.failures[0].message).toContain("assertion failed");
  });
});

// ---------------------------------------------------------------------------
// parseTestOutput — go test
// ---------------------------------------------------------------------------

describe("parseTestOutput — go test", () => {
  const GO_PASS = `
=== RUN   TestAdd
--- PASS: TestAdd (0.00s)
=== RUN   TestSub
--- PASS: TestSub (0.00s)
PASS
ok  	example.com/math	0.003s
`;

  const GO_FAIL = `
=== RUN   TestAdd
--- PASS: TestAdd (0.00s)
=== RUN   TestSub
    math_test.go:15: expected 2, got 3
--- FAIL: TestSub (0.00s)
FAIL
FAIL	example.com/math	0.004s
`;

  it("parses passing go test output", () => {
    const result = parseTestOutput("go", GO_PASS);
    expect(result.runner).toBe("go");
    expect(result.passed).toBeGreaterThanOrEqual(2);
    expect(result.failed).toBe(0);
  });

  it("parses failing go test output", () => {
    const result = parseTestOutput("go", GO_FAIL);
    expect(result.runner).toBe("go");
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].name).toBe("TestSub");
    expect(result.failures[0].message).toContain("expected 2");
  });
});

// ---------------------------------------------------------------------------
// parseTestOutput — mocha
// ---------------------------------------------------------------------------

describe("parseTestOutput — mocha", () => {
  const MOCHA_PASS = `
  Array
    ✓ should return -1 when not present
    ✓ should return index when present

  2 passing (8ms)
`;

  const MOCHA_FAIL = `
  Array
    ✓ should return -1 when not present
    1) should handle edge case

  1 passing (12ms)
  1 failing

  1) Array
       should handle edge case:
     Error: expected 0 to equal -1
      at Context.<anonymous> (test/array.test.js:10:14)
`;

  it("parses passing mocha output", () => {
    const result = parseTestOutput("mocha", MOCHA_PASS);
    expect(result.runner).toBe("mocha");
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.duration).toBeCloseTo(8, -1);
  });

  it("parses failing mocha output", () => {
    const result = parseTestOutput("mocha", MOCHA_FAIL);
    expect(result.runner).toBe("mocha");
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].name).toContain("should handle edge case");
  });
});

// ---------------------------------------------------------------------------
// parseTestOutput — generic / unknown
// ---------------------------------------------------------------------------

describe("parseTestOutput — generic", () => {
  it("detects pass/fail counts from summary line", () => {
    const result = parseTestOutput("unknown", "Results: 10 passed, 2 failed\nexit code 1");
    expect(result.runner).toBe("unknown");
    expect(result.passed).toBe(10);
    expect(result.failed).toBe(2);
  });

  it("detects failure from exit code", () => {
    const result = parseTestOutput("unknown", "Some test output\nExited with code 1");
    expect(result.failed).toBeGreaterThanOrEqual(1);
  });

  it("handles empty output", () => {
    const result = parseTestOutput("unknown", "");
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.failures).toHaveLength(0);
  });
});
