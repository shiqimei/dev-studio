import { forwardRef, useMemo } from "react";
import { useWs } from "../context/WebSocketContext";
import { useAutoScroll } from "../hooks/useAutoScroll";
import { DebugHeader } from "./DebugHeader";
import { ProtoEntry } from "./ProtoEntry";

export const DebugPanel = forwardRef<HTMLDivElement>((_props, ref) => {
  const { state } = useWs();
  const { ref: scrollRef, onScroll } = useAutoScroll<HTMLDivElement>(
    state.protoEntries,
  );
  const { ref: miniRef } = useAutoScroll<HTMLDivElement>(state.protoEntries);

  const textFilterLower = state.textFilter.toLowerCase();

  const filteredEntries = useMemo(
    () =>
      state.protoEntries.filter((e) => {
        const dirOk =
          state.dirFilter === "all" || state.dirFilter === e.dir;
        const textOk =
          !textFilterLower || e.method.toLowerCase().includes(textFilterLower);
        return dirOk && textOk;
      }),
    [state.protoEntries, state.dirFilter, textFilterLower],
  );

  const width = state.debugCollapsed ? "160px" : undefined;

  return (
    <div
      ref={ref}
      className="w-[480px] shrink-0 border-l border-border flex flex-col bg-bg min-w-0"
      style={width ? { width } : undefined}
    >
      <DebugHeader />
      {state.debugCollapsed ? (
        <div
          ref={miniRef}
          className="flex-1 overflow-y-auto py-1 flex flex-col"
        >
          {state.protoEntries.map((e) => (
            <div key={e.id} className="mini-entry">
              <span className={`proto-dir ${e.dir}`}>
                {e.dir === "send" ? "SND" : "RCV"}
              </span>
              <span className="mini-method">{e.method}</span>
            </div>
          ))}
        </div>
      ) : (
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="flex-1 overflow-y-auto py-1.5"
        >
          {filteredEntries.map((e) => (
            <ProtoEntry key={e.id} entry={e} startTime={state.startTime} />
          ))}
        </div>
      )}
    </div>
  );
});

DebugPanel.displayName = "DebugPanel";
