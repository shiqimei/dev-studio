import { memo } from "react";
import { useWsState } from "../context/WebSocketContext";

export const TasksSidecar = memo(function TasksSidecar() {
  const { latestPlan } = useWsState();

  if (!latestPlan || latestPlan.length === 0) return null;

  return (
    <div className="tasks-sidecar">
      <div className="tasks-sidecar-title">Tasks</div>
      <div className="tasks-sidecar-list">
        {latestPlan.map((entry, i) => (
          <div key={i} className={`tasks-sidecar-item ${entry.status}`}>
            <span className={`tasks-sidecar-check ${entry.status}`}>
              {entry.status === "completed" ? "\u2713" : ""}
            </span>
            <span className="tasks-sidecar-text">{entry.content}</span>
          </div>
        ))}
      </div>
    </div>
  );
});
