/**
 * Lightweight performance instrumentation for ACP server.
 * Enabled via ACP_PERF=1 environment variable. Zero-cost when disabled.
 *
 * Usage:
 *   const span = perfStart("sessionUpdate.stream_event");
 *   await doWork();
 *   span.end({ chunks: 5 });
 *
 *   const scope = perfScope("prompt");
 *   // ... inside loop:
 *   const s = scope.start("router.next");
 *   await router.next();
 *   s.end({ bufferDepth: 3 });
 *   // ... at end:
 *   scope.summary();
 */

const ENABLED = !!process.env.ACP_PERF;

export interface Span {
  end(meta?: Record<string, unknown>): number;
}

interface OpStats {
  count: number;
  totalMs: number;
  maxMs: number;
}

const NOOP_SPAN: Span = Object.freeze({ end: () => 0 });

function now(): number {
  return performance.now();
}

function log(data: object): void {
  process.stderr.write(JSON.stringify(data) + "\n");
}

/**
 * Start a standalone timing span. Returns a handle with `.end()`.
 * When disabled, returns a frozen noop — no allocation.
 */
export function perfStart(op: string): Span {
  if (!ENABLED) return NOOP_SPAN;
  const t0 = now();
  return {
    end(meta?: Record<string, unknown>): number {
      const ms = +(now() - t0).toFixed(2);
      log({ perf: { op, ms, ...meta } });
      return ms;
    },
  };
}

/**
 * A scope aggregates multiple spans and emits a summary at the end.
 * Useful for wrapping an entire prompt() call.
 */
export function perfScope(name: string) {
  if (!ENABLED) {
    return {
      start: (_op: string): Span => NOOP_SPAN,
      summary: () => {},
    };
  }

  const t0 = now();
  const ops = new Map<string, OpStats>();

  function track(op: string, ms: number) {
    let s = ops.get(op);
    if (!s) {
      s = { count: 0, totalMs: 0, maxMs: 0 };
      ops.set(op, s);
    }
    s.count++;
    s.totalMs += ms;
    if (ms > s.maxMs) s.maxMs = ms;
  }

  return {
    start(op: string): Span {
      const st = now();
      return {
        end(meta?: Record<string, unknown>): number {
          const ms = +(now() - st).toFixed(2);
          track(op, ms);
          if (ms > 50) {
            // Only log individual spans that are slow (>50ms)
            log({ perf: { op, ms, scope: name, ...meta } });
          }
          return ms;
        },
      };
    },

    summary() {
      const totalMs = +(now() - t0).toFixed(2);
      const byOp: Record<string, { n: number; total_ms: number; max_ms: number }> = {};
      for (const [op, s] of ops) {
        byOp[op] = {
          n: s.count,
          total_ms: +s.totalMs.toFixed(2),
          max_ms: +s.maxMs.toFixed(2),
        };
      }
      log({ perf_summary: { scope: name, total_ms: totalMs, ops: byOp } });
    },
  };
}

export type PerfScope = ReturnType<typeof perfScope>;

export { ENABLED as perfEnabled };
