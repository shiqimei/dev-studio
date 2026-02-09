import { useCallback } from "react";
import { useWs } from "../context/WebSocketContext";

const isElectron = navigator.userAgent.includes("Electron");
const isMac = navigator.platform.startsWith("Mac");

export function Header() {
  const { state, dispatch } = useWs();
  const toggleDebug = useCallback(() => dispatch({ type: "TOGGLE_DEBUG_COLLAPSE" }), [dispatch]);
  const toggleTasks = useCallback(() => dispatch({ type: "TOGGLE_TASKS_SIDECAR" }), [dispatch]);

  const plan = state.latestPlan;
  const tasks = state.latestTasks;
  const planCompleted = plan?.filter((e) => e.status === "completed").length ?? 0;
  const planTotal = plan?.length ?? 0;
  const tasksCompleted = tasks?.filter((e) => e.status === "completed").length ?? 0;
  const tasksTotal = tasks?.length ?? 0;
  const completedCount = planCompleted + tasksCompleted;
  const totalCount = planTotal + tasksTotal;

  return (
    <header
      className={`px-5 py-2.5 border-b border-border flex items-center justify-end gap-3 shrink-0 min-w-0 overflow-hidden${isElectron ? " app-region-drag" : ""}${isElectron && isMac ? " pl-[78px]" : ""}`}
    >
      {totalCount > 0 && (
        <button
          className={`debug-ctrl-btn text-[11px] px-2 py-0.5 shrink-0 app-region-no-drag${state.tasksSidecarOpen ? " active" : ""}`}
          onClick={toggleTasks}
          title={state.tasksSidecarOpen ? "Hide tasks panel" : "Show tasks panel"}
        >
          Tasks {completedCount}/{totalCount} {state.tasksSidecarOpen ? "\u25B6" : "\u25C0"}
        </button>
      )}
      <button
        className="debug-ctrl-btn text-[11px] px-2 py-0.5 shrink-0 app-region-no-drag"
        onClick={toggleDebug}
        title={state.debugCollapsed ? "Show protocol debug panel" : "Hide protocol debug panel"}
      >
        {state.debugCollapsed ? "Protocol \u25C0" : "Protocol \u25B6"}
      </button>
    </header>
  );
}
