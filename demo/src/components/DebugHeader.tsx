import { useCallback } from "react";
import { useWs } from "../context/WebSocketContext";
import type { DirFilter } from "../types";

export function DebugHeader() {
  const { state, dispatch } = useWs();

  const setDir = useCallback(
    (f: DirFilter) => dispatch({ type: "SET_DIR_FILTER", filter: f }),
    [dispatch],
  );

  const copyAll = useCallback(() => {
    const text = state.protoEntries.map((e) => JSON.stringify({ dir: e.dir, ts: e.ts, msg: e.msg })).join("\n");
    navigator.clipboard.writeText(text);
  }, [state.protoEntries]);

  if (state.debugCollapsed) {
    return null;
  }

  return (
    <div className="px-3.5 py-2 border-b border-border flex items-center gap-2.5 shrink-0 overflow-hidden">
      <span className="text-[11px] font-bold uppercase tracking-wide text-dim">
        Protocol
      </span>
      <span className="text-[10px] text-dim bg-surface px-1.5 rounded-full">
        {state.protoEntries.length}
      </span>
      <div className="flex gap-1">
        <button
          className={`debug-ctrl-btn${state.dirFilter === "all" ? " active" : ""}`}
          onClick={() => setDir("all")}
        >
          All
        </button>
        <button
          className={`debug-ctrl-btn${state.dirFilter === "send" ? " active" : ""}`}
          onClick={() => setDir("send")}
        >
          Sent
        </button>
        <button
          className={`debug-ctrl-btn${state.dirFilter === "recv" ? " active" : ""}`}
          onClick={() => setDir("recv")}
        >
          Recv
        </button>
      </div>
      <button className="debug-ctrl-btn whitespace-nowrap" onClick={copyAll}>
        Copy All
      </button>
      <input
        type="text"
        placeholder="Filter method..."
        value={state.textFilter}
        onChange={(e) =>
          dispatch({ type: "SET_TEXT_FILTER", filter: e.target.value })
        }
        className="bg-transparent border border-border rounded-md px-2 py-0.5 text-text font-mono text-[10px] outline-none w-[140px] focus:border-dim placeholder:text-dim ml-auto"
      />
    </div>
  );
}
