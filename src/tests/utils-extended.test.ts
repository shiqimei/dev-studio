import { describe, it, expect, vi, afterEach } from "vitest";
import {
  Pushable,
  unreachable,
  sleep,
  applyEnvironmentSettings,
  nodeToWebWritable,
  nodeToWebReadable,
} from "../utils.js";
import { Readable, Writable } from "node:stream";

describe("Pushable", () => {
  describe("push then consume", () => {
    it("should return pushed items in FIFO order", async () => {
      const p = new Pushable<string>();
      p.push("a");
      p.push("b");
      const iter = p[Symbol.asyncIterator]();
      const r1 = await iter.next();
      expect(r1).toEqual({ value: "a", done: false });
      const r2 = await iter.next();
      expect(r2).toEqual({ value: "b", done: false });
    });

    it("should work with numeric values", async () => {
      const p = new Pushable<number>();
      p.push(1);
      p.push(2);
      p.push(3);
      const iter = p[Symbol.asyncIterator]();
      expect(await iter.next()).toEqual({ value: 1, done: false });
      expect(await iter.next()).toEqual({ value: 2, done: false });
      expect(await iter.next()).toEqual({ value: 3, done: false });
    });

    it("should work with object values", async () => {
      const p = new Pushable<{ id: number; name: string }>();
      const obj = { id: 1, name: "test" };
      p.push(obj);
      const iter = p[Symbol.asyncIterator]();
      const result = await iter.next();
      expect(result.value).toBe(obj);
      expect(result.done).toBe(false);
    });
  });

  describe("consume then push (async waiting)", () => {
    it("should resolve when item is pushed after consumer waits", async () => {
      const p = new Pushable<number>();
      const promise = p[Symbol.asyncIterator]().next();
      p.push(42);
      const result = await promise;
      expect(result).toEqual({ value: 42, done: false });
    });

    it("should resolve multiple waiting consumers in order", async () => {
      const p = new Pushable<string>();
      const iter = p[Symbol.asyncIterator]();
      const p1 = iter.next();
      const p2 = iter.next();
      p.push("first");
      p.push("second");
      expect(await p1).toEqual({ value: "first", done: false });
      expect(await p2).toEqual({ value: "second", done: false });
    });
  });

  describe("end behavior", () => {
    it("should return done:true after end() with no items", async () => {
      const p = new Pushable<string>();
      p.end();
      const r = await p[Symbol.asyncIterator]().next();
      expect(r.done).toBe(true);
    });

    it("should return queued items then done:true after end()", async () => {
      const p = new Pushable<string>();
      p.push("item");
      p.end();
      const iter = p[Symbol.asyncIterator]();
      const r1 = await iter.next();
      expect(r1).toEqual({ value: "item", done: false });
      const r2 = await iter.next();
      expect(r2.done).toBe(true);
    });

    it("should resolve pending consumers with done:true on end()", async () => {
      const p = new Pushable<string>();
      const iter = p[Symbol.asyncIterator]();
      const pending = iter.next();
      p.end();
      expect((await pending).done).toBe(true);
    });

    it("should resolve multiple pending consumers on end()", async () => {
      const p = new Pushable<string>();
      const iter = p[Symbol.asyncIterator]();
      const p1 = iter.next();
      const p2 = iter.next();
      const p3 = iter.next();
      p.end();
      expect((await p1).done).toBe(true);
      expect((await p2).done).toBe(true);
      expect((await p3).done).toBe(true);
    });

    it("should keep returning done:true after end() is called", async () => {
      const p = new Pushable<string>();
      p.end();
      const iter = p[Symbol.asyncIterator]();
      expect((await iter.next()).done).toBe(true);
      expect((await iter.next()).done).toBe(true);
      expect((await iter.next()).done).toBe(true);
    });
  });

  describe("for-await consumption", () => {
    it("should iterate over pushed items and stop at end()", async () => {
      const p = new Pushable<string>();
      p.push("x");
      p.push("y");
      p.end();
      const items: string[] = [];
      for await (const item of p) {
        items.push(item);
      }
      expect(items).toEqual(["x", "y"]);
    });

    it("should handle empty pushable with immediate end()", async () => {
      const p = new Pushable<string>();
      p.end();
      const items: string[] = [];
      for await (const item of p) {
        items.push(item);
      }
      expect(items).toEqual([]);
    });

    it("should handle a single item", async () => {
      const p = new Pushable<number>();
      p.push(99);
      p.end();
      const items: number[] = [];
      for await (const item of p) {
        items.push(item);
      }
      expect(items).toEqual([99]);
    });
  });

  describe("mixed push and consume patterns", () => {
    it("should handle alternating push and consume", async () => {
      const p = new Pushable<string>();
      const iter = p[Symbol.asyncIterator]();

      p.push("a");
      expect(await iter.next()).toEqual({ value: "a", done: false });

      p.push("b");
      expect(await iter.next()).toEqual({ value: "b", done: false });

      p.end();
      expect((await iter.next()).done).toBe(true);
    });

    it("should handle batch push then batch consume", async () => {
      const p = new Pushable<number>();
      for (let i = 0; i < 100; i++) {
        p.push(i);
      }
      p.end();

      const items: number[] = [];
      for await (const item of p) {
        items.push(item);
      }
      expect(items).toHaveLength(100);
      expect(items[0]).toBe(0);
      expect(items[99]).toBe(99);
    });
  });

  describe("Symbol.asyncIterator protocol", () => {
    it("should return an async iterator from Symbol.asyncIterator", () => {
      const p = new Pushable<string>();
      const iter = p[Symbol.asyncIterator]();
      expect(typeof iter.next).toBe("function");
    });

    it("should be usable as an AsyncIterable", async () => {
      const p = new Pushable<string>();
      p.push("hello");
      p.end();

      // Verify it implements AsyncIterable by using for-await
      const results: string[] = [];
      for await (const item of p) {
        results.push(item);
      }
      expect(results).toEqual(["hello"]);
    });
  });
});

describe("unreachable", () => {
  it("should call logger.error with stringified string value", () => {
    const mockLogger = { log: vi.fn(), error: vi.fn() };
    unreachable("test" as never, mockLogger);
    expect(mockLogger.error).toHaveBeenCalledWith('Unexpected case: "test"');
  });

  it("should call logger.error with stringified object value", () => {
    const mockLogger = { log: vi.fn(), error: vi.fn() };
    unreachable({ foo: "bar" } as never, mockLogger);
    expect(mockLogger.error).toHaveBeenCalledWith('Unexpected case: {"foo":"bar"}');
  });

  it("should call logger.error with stringified number value", () => {
    const mockLogger = { log: vi.fn(), error: vi.fn() };
    unreachable(42 as never, mockLogger);
    expect(mockLogger.error).toHaveBeenCalledWith("Unexpected case: 42");
  });

  it("should call logger.error with stringified boolean value", () => {
    const mockLogger = { log: vi.fn(), error: vi.fn() };
    unreachable(true as never, mockLogger);
    expect(mockLogger.error).toHaveBeenCalledWith("Unexpected case: true");
  });

  it("should call logger.error with stringified null value", () => {
    const mockLogger = { log: vi.fn(), error: vi.fn() };
    unreachable(null as never, mockLogger);
    expect(mockLogger.error).toHaveBeenCalledWith("Unexpected case: null");
  });

  it("should handle circular reference by falling back to the raw value", () => {
    const mockLogger = { log: vi.fn(), error: vi.fn() };
    const circular: any = {};
    circular.self = circular;
    unreachable(circular as never, mockLogger);
    // JSON.stringify fails on circular, so it uses the raw value
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    const call = mockLogger.error.mock.calls[0];
    // The template literal will call toString() on the raw object,
    // producing "Unexpected case: [object Object]"
    expect(call[0]).toBe("Unexpected case: [object Object]");
  });

  it("should default to console as logger", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    unreachable("default-logger" as never);
    expect(consoleSpy).toHaveBeenCalledWith('Unexpected case: "default-logger"');
    consoleSpy.mockRestore();
  });

  it("should handle undefined value", () => {
    const mockLogger = { log: vi.fn(), error: vi.fn() };
    unreachable(undefined as never, mockLogger);
    // JSON.stringify(undefined) returns undefined (not a string),
    // so the template literal produces "Unexpected case: undefined"
    expect(mockLogger.error).toHaveBeenCalledWith("Unexpected case: undefined");
  });
});

describe("sleep", () => {
  it("should resolve after approximately the specified time", async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40); // Allow some timing variance
  });

  it("should return a Promise", () => {
    const result = sleep(10);
    expect(result).toBeInstanceOf(Promise);
  });

  it("should resolve with undefined", async () => {
    const result = await sleep(10);
    expect(result).toBeUndefined();
  });

  it("should handle zero millisecond sleep", async () => {
    const start = Date.now();
    await sleep(0);
    const elapsed = Date.now() - start;
    // Should resolve nearly immediately
    expect(elapsed).toBeLessThan(50);
  });
});

describe("loadManagedSettings", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  it("should return null when settings file does not exist", async () => {
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        readFileSync: () => {
          throw new Error("ENOENT: no such file or directory");
        },
      };
    });

    const { loadManagedSettings: loadFresh } = await import("../utils.js");
    const result = loadFresh();
    expect(result).toBeNull();
  });

  it("should return null when file contains invalid JSON", async () => {
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        readFileSync: () => "not valid json {{{",
      };
    });

    const { loadManagedSettings: loadFresh } = await import("../utils.js");
    const result = loadFresh();
    expect(result).toBeNull();
  });

  it("should return parsed settings when file exists with valid JSON", async () => {
    const mockSettings = { permissions: { allow: ["Read"] }, env: { KEY: "val" } };

    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        readFileSync: () => JSON.stringify(mockSettings),
      };
    });

    const { loadManagedSettings: loadFresh } = await import("../utils.js");
    const result = loadFresh();
    expect(result).toEqual(mockSettings);
  });
});

describe("applyEnvironmentSettings", () => {
  const savedEnv: Record<string, string | undefined> = {};

  afterEach(() => {
    // Clean up any test environment variables
    for (const key of Object.keys(savedEnv)) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it("should set environment variables from settings.env", () => {
    savedEnv["TEST_AES_VAR_1"] = process.env["TEST_AES_VAR_1"];
    savedEnv["TEST_AES_VAR_2"] = process.env["TEST_AES_VAR_2"];

    applyEnvironmentSettings({
      env: { TEST_AES_VAR_1: "value1", TEST_AES_VAR_2: "value2" },
    });

    expect(process.env.TEST_AES_VAR_1).toBe("value1");
    expect(process.env.TEST_AES_VAR_2).toBe("value2");
  });

  it("should handle empty env object without errors", () => {
    expect(() => applyEnvironmentSettings({ env: {} })).not.toThrow();
  });

  it("should handle settings without env property without errors", () => {
    expect(() => applyEnvironmentSettings({} as any)).not.toThrow();
  });

  it("should handle settings with only permissions (no env)", () => {
    expect(() =>
      applyEnvironmentSettings({ permissions: { allow: ["Read"] } }),
    ).not.toThrow();
  });

  it("should overwrite existing environment variables", () => {
    savedEnv["TEST_AES_OVERWRITE"] = process.env["TEST_AES_OVERWRITE"];
    process.env.TEST_AES_OVERWRITE = "original";

    applyEnvironmentSettings({ env: { TEST_AES_OVERWRITE: "new_value" } });

    expect(process.env.TEST_AES_OVERWRITE).toBe("new_value");
  });

  it("should set multiple variables in a single call", () => {
    savedEnv["TEST_AES_A"] = process.env["TEST_AES_A"];
    savedEnv["TEST_AES_B"] = process.env["TEST_AES_B"];
    savedEnv["TEST_AES_C"] = process.env["TEST_AES_C"];

    applyEnvironmentSettings({
      env: {
        TEST_AES_A: "alpha",
        TEST_AES_B: "bravo",
        TEST_AES_C: "charlie",
      },
    });

    expect(process.env.TEST_AES_A).toBe("alpha");
    expect(process.env.TEST_AES_B).toBe("bravo");
    expect(process.env.TEST_AES_C).toBe("charlie");
  });
});

describe("nodeToWebWritable", () => {
  it("should return a WritableStream instance", () => {
    const nodeStream = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const webStream = nodeToWebWritable(nodeStream);
    expect(webStream).toBeInstanceOf(WritableStream);
  });

  it("should write data through to the underlying Node.js stream", async () => {
    const chunks: Buffer[] = [];
    const nodeStream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });

    const webStream = nodeToWebWritable(nodeStream);
    const writer = webStream.getWriter();
    await writer.write(new TextEncoder().encode("hello"));
    await writer.write(new TextEncoder().encode(" world"));
    await writer.close();

    const combined = Buffer.concat(chunks).toString();
    expect(combined).toBe("hello world");
  });

  it("should handle empty writes", async () => {
    const chunks: Buffer[] = [];
    const nodeStream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });

    const webStream = nodeToWebWritable(nodeStream);
    const writer = webStream.getWriter();
    await writer.write(new Uint8Array(0));
    await writer.close();

    expect(chunks).toHaveLength(1);
    expect(chunks[0].length).toBe(0);
  });
});

describe("nodeToWebReadable", () => {
  it("should return a ReadableStream instance", () => {
    const nodeStream = new Readable({ read() {} });
    const webStream = nodeToWebReadable(nodeStream);
    expect(webStream).toBeInstanceOf(ReadableStream);
  });

  it("should read data from the underlying Node.js stream", async () => {
    const nodeStream = new Readable({
      read() {
        this.push(Buffer.from("hello"));
        this.push(null); // signal end
      },
    });

    const webStream = nodeToWebReadable(nodeStream);
    const reader = webStream.getReader();

    const { value, done } = await reader.read();
    expect(done).toBe(false);
    expect(Buffer.from(value!).toString()).toBe("hello");

    const end = await reader.read();
    expect(end.done).toBe(true);
  });

  it("should handle multiple chunks from the Node.js stream", async () => {
    let pushCount = 0;
    const nodeStream = new Readable({
      read() {
        if (pushCount < 3) {
          this.push(Buffer.from(`chunk${pushCount}`));
          pushCount++;
        } else {
          this.push(null);
        }
      },
    });

    const webStream = nodeToWebReadable(nodeStream);
    const reader = webStream.getReader();

    const chunks: string[] = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value!).toString());
    }

    expect(chunks).toEqual(["chunk0", "chunk1", "chunk2"]);
  });

  it("should propagate errors from the Node.js stream", async () => {
    const nodeStream = new Readable({
      read() {
        process.nextTick(() => this.destroy(new Error("read failed")));
      },
    });

    const webStream = nodeToWebReadable(nodeStream);
    const reader = webStream.getReader();

    await expect(reader.read()).rejects.toThrow("read failed");
  });

  it("should handle an immediately closed stream", async () => {
    const nodeStream = new Readable({
      read() {
        this.push(null);
      },
    });

    const webStream = nodeToWebReadable(nodeStream);
    const reader = webStream.getReader();

    const { done } = await reader.read();
    expect(done).toBe(true);
  });
});
