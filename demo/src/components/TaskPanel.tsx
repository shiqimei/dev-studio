import { useState, useEffect } from "react";
import { useWs } from "../context/WebSocketContext";
import { formatElapsed } from "../utils";

export function TaskPanel() {
  const { state, send } = useWs();
  const bgTasks = Object.values(state.tasks).filter((t) => t.isBackground);
  const hasRunning = bgTasks.some((t) => t.status === "running");

  // Local timer to tick elapsed durations for running tasks (replaces global timer)
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!hasRunning || !state.taskPanelOpen) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [hasRunning, state.taskPanelOpen]);

  if (bgTasks.length === 0 || !state.taskPanelOpen) return null;

  function killTask(task: (typeof bgTasks)[0]) {
    if (task.status !== "running") return;
    const desc =
      task.toolKind === "bash"
        ? "Kill the background bash process: " + task.title
        : task.toolKind === "agent"
          ? "Kill the background agent task: " + task.title
          : "Kill the background task: " + task.title;
    send(desc);
  }

  return (
    <div className="max-h-60 overflow-y-auto border-b border-border bg-bg shrink-0">
      {bgTasks.map((task) => {
        const now = Date.now();
        const elapsed = (task.endTime || now) - task.startTime;
        const badgeClass = task.toolKind || "other";
        const badgeLabel =
          badgeClass === "agent"
            ? "AGENT"
            : badgeClass === "bash"
              ? "BASH"
              : "TOOL";
        const statusClass = task.status;
        const statusLabel =
          task.status === "running"
            ? "running"
            : task.status === "completed"
              ? "done"
              : "failed";
        const isDone = task.status !== "running";
        const peek = state.peekStatus[task.toolCallId];

        return (
          <div key={task.toolCallId}>
            <div className={`task-item${peek && !isDone ? " has-peek" : ""}`}>
              <span className={`task-badge ${badgeClass}`}>{badgeLabel}</span>
              <span className="task-title">{task.title}</span>
              <span className="task-elapsed">{formatElapsed(elapsed)}</span>
              <span className={`task-status ${statusClass}`}>{statusLabel}</span>
              <button
                className="task-kill"
                disabled={isDone}
                onClick={() => killTask(task)}
              >
                Kill
              </button>
            </div>
            {peek && !isDone && (
              <div className="task-peek">
                <span className="peek-dot" />
                {peek}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
