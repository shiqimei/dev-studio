/**
 * AgentInst Interceptor
 *
 * Sits between the agent subprocess stdout and the ACP ndJsonStream.
 * Filters out `:::INST:` convention lines, parses them via the SDK,
 * and pushes completed runs to the embedded AgentInst store.
 *
 * Non-INST lines pass through unmodified to the ACP protocol parser.
 */

import { Readable } from "node:stream";
import { _parseLine, _buildPayload, _tasks } from "agentinst";
import { Store } from "@agentinst/server";
import { log } from "./log.js";

const INST_PREFIX = ":::INST:";

// ── Singleton embedded store ──
let _store: Store | null = null;

export function getInstStore(): Store {
  if (!_store) {
    _store = new Store();
    log.info("inst: embedded AgentInst store created");
  }
  return _store;
}

/**
 * Push a completed task's payload to the embedded store, then remove from SDK state.
 */
function pushToStore(taskUuid: string): void {
  if (!_tasks.has(taskUuid)) return;
  const store = getInstStore();
  const payload = _buildPayload(taskUuid);
  if (payload.entries.length === 0) return;

  // Remove from SDK state so it won't be pushed again on stream end
  _tasks.delete(taskUuid);

  try {
    const result = store.ingest(payload);
    log.info(
      { task: taskUuid.slice(0, 8), run: result.run, passed: result.passed, entries: result.received },
      "inst: run ingested",
    );
  } catch (err: any) {
    log.error({ task: taskUuid.slice(0, 8), err: err.message }, "inst: ingest failed");
  }
}

/**
 * Push all pending tasks (on process exit or agent disconnect).
 */
export function pushAllPendingTasks(): void {
  for (const [uuid] of _tasks) {
    pushToStore(uuid);
  }
}

/**
 * Wraps a Node Readable (agent stdout) and returns a new Readable that:
 * - Swallows `:::INST:` lines, feeding them to the SDK parser
 * - Passes all other data through for ACP protocol parsing
 * - On DONE events, pushes the run payload to the embedded store
 */
export function createInstFilteredReadable(agentStdout: Readable): Readable {
  let buffer = "";

  const filtered = new Readable({
    read() {},
  });

  agentStdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();

    // Process complete lines
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);

      if (line.startsWith(INST_PREFIX)) {
        // Parse the convention line; swallow it from the ACP stream
        const parsed = _parseLine(line, "stdout");
        if (!parsed) {
          log.warn({ line: line.slice(0, 80) }, "inst: unparseable INST line");
        }

        // Check if this was a DONE command — push immediately
        const rest = line.slice(INST_PREFIX.length);
        const colonIdx = rest.indexOf(":");
        const command = colonIdx === -1 ? rest : rest.slice(0, colonIdx);
        if (command === "DONE") {
          const payload = rest.slice(colonIdx + 1); // task_uuid
          pushToStore(payload);
        }
      } else {
        // Pass through to ACP protocol parser
        filtered.push(line + "\n");
      }
    }
  });

  agentStdout.on("end", () => {
    // Flush remaining buffer
    if (buffer.length > 0) {
      if (buffer.startsWith(INST_PREFIX)) {
        _parseLine(buffer, "stdout");
      } else {
        filtered.push(buffer);
      }
      buffer = "";
    }

    // Push any tasks that didn't get a DONE
    pushAllPendingTasks();
    filtered.push(null); // signal end
  });

  agentStdout.on("error", (err) => {
    filtered.destroy(err);
  });

  return filtered;
}
