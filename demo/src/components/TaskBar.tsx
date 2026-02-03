import { useWs } from "../context/WebSocketContext";

export function TaskBar() {
  const { state, dispatch } = useWs();
  const bgTasks = Object.values(state.tasks).filter((t) => t.isBackground);
  const activeCount = bgTasks.filter((t) => t.status === "running").length;
  const allDone = bgTasks.length > 0 && activeCount === 0;

  if (bgTasks.length === 0) return null;

  const text = allDone
    ? bgTasks.length +
      " background task" +
      (bgTasks.length === 1 ? "" : "s") +
      " \u2014 all done"
    : activeCount +
      " active background task" +
      (activeCount === 1 ? "" : "s");

  return (
    <div
      id="task-bar"
      className={`px-5 py-1.5 bg-surface border-b border-border flex items-center gap-2 cursor-pointer select-none shrink-0 text-xs hover:bg-border${state.taskPanelOpen ? " open" : ""}`}
      onClick={() => dispatch({ type: "TOGGLE_TASK_PANEL" })}
    >
      <span className={`text-sm text-yellow${allDone ? " all-done" : ""}`} id="task-icon">
        &#9881;
      </span>
      <span className="text-dim flex-1">{text}</span>
      <span
        id="task-arrow"
        className="text-[10px] text-dim transition-transform duration-150"
        style={state.taskPanelOpen ? { transform: "rotate(180deg)" } : undefined}
      >
        &#9660;
      </span>
    </div>
  );
}
