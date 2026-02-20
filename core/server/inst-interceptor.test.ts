/**
 * Tests for the AgentInst interceptor integration.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Readable } from "node:stream";
import { createInstFilteredReadable, getInstStore } from "./inst-interceptor.js";
import { _reset } from "./agentinst/sdk.js";

function createMockStdout(lines: string[]): Readable {
  const readable = new Readable({ read() {} });
  // Push all lines as a single chunk (simulates buffered output)
  setTimeout(() => {
    for (const line of lines) {
      readable.push(line + "\n");
    }
    readable.push(null);
  }, 10);
  return readable;
}

function collectOutput(readable: Readable): Promise<string> {
  return new Promise((resolve) => {
    const chunks: string[] = [];
    readable.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
    readable.on("end", () => resolve(chunks.join("")));
  });
}

describe("inst-interceptor", () => {
  beforeEach(() => {
    _reset();
  });

  it("passes through non-INST lines", async () => {
    const mock = createMockStdout([
      '{"jsonrpc":"2.0","method":"test"}',
      '{"jsonrpc":"2.0","result":42}',
    ]);
    const filtered = createInstFilteredReadable(mock);
    const output = await collectOutput(filtered);
    expect(output).toBe('{"jsonrpc":"2.0","method":"test"}\n{"jsonrpc":"2.0","result":42}\n');
  });

  it("swallows INST lines and passes through others", async () => {
    const uuid = "aaaaaaaa-1111-4000-8000-000000000001";
    const mock = createMockStdout([
      `:::INST:TASK:${uuid}:test-task`,
      '{"jsonrpc":"2.0","method":"test"}',
      `:::INST:LOG:${uuid}:doing work`,
      `:::INST:CHECK:${uuid}:result:{"count":5}`,
      '{"jsonrpc":"2.0","result":"ok"}',
      `:::INST:DONE:${uuid}`,
    ]);
    const filtered = createInstFilteredReadable(mock);
    const output = await collectOutput(filtered);
    // Only non-INST lines should pass through
    expect(output).toBe('{"jsonrpc":"2.0","method":"test"}\n{"jsonrpc":"2.0","result":"ok"}\n');
  });

  it("pushes completed tasks to the embedded store on DONE", async () => {
    const store = getInstStore();
    const uuid = "bbbbbbbb-2222-4000-8000-000000000002";
    const mock = createMockStdout([
      `:::INST:TASK:${uuid}:store-test`,
      `:::INST:CHECK:${uuid}:my_check:{"status":"ok"}`,
      `:::INST:DONE:${uuid}`,
    ]);
    const filtered = createInstFilteredReadable(mock);
    await collectOutput(filtered);

    // Give microtask a moment
    await new Promise((r) => setTimeout(r, 50));

    const tasks = store.listTasks();
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    const task = tasks.find((t: any) => t.task_uuid === uuid);
    expect(task).toBeTruthy();
    expect(task!.task_name).toBe("store-test");
  });

  it("pushes pending tasks on stream end (no DONE)", async () => {
    const store = getInstStore();
    const uuid = "cccccccc-3333-4000-8000-000000000003";
    const mock = createMockStdout([
      `:::INST:TASK:${uuid}:no-done-task`,
      `:::INST:LOG:${uuid}:working...`,
    ]);
    const filtered = createInstFilteredReadable(mock);
    await collectOutput(filtered);

    await new Promise((r) => setTimeout(r, 50));

    const tasks = store.listTasks();
    const task = tasks.find((t: any) => t.task_uuid === uuid);
    expect(task).toBeTruthy();
  });
});
