import { memo } from "react";
import { useWsState } from "../context/WebSocketContext";
import type { PlanEntryItem, TaskItemEntry } from "../types";

function CheckIcon({ status }: { status: "pending" | "in_progress" | "completed" }) {
  if (status === "completed") {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 10.656V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12.344" />
        <path d="m9 11 3 3L22 4" />
      </svg>
    );
  }
  if (status === "in_progress") {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect width="18" height="18" x="3" y="3" rx="2" />
        <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="18" height="18" x="3" y="3" rx="2" />
    </svg>
  );
}

function TodosSection({ entries, fullHeight }: { entries: PlanEntryItem[]; fullHeight: boolean }) {
  const completed = entries.filter((e) => e.status === "completed").length;
  return (
    <div className={`tasks-sidecar-section${fullHeight ? " full" : ""}`}>
      <div className="tasks-sidecar-header">
        <span className="tasks-sidecar-title">Todos</span>
        <span className="tasks-sidecar-stats">{completed}/{entries.length}</span>
      </div>
      <div className="tasks-sidecar-list">
        {entries.map((entry, i) => (
          <div key={i} className={`tasks-sidecar-item ${entry.status}`}>
            <span className={`tasks-sidecar-icon ${entry.status}`}>
              <CheckIcon status={entry.status} />
            </span>
            <span className="tasks-sidecar-text">{entry.content}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TasksSection({ entries, fullHeight }: { entries: TaskItemEntry[]; fullHeight: boolean }) {
  const completed = entries.filter((e) => e.status === "completed").length;
  return (
    <div className={`tasks-sidecar-section${fullHeight ? " full" : ""}`}>
      <div className="tasks-sidecar-header">
        <span className="tasks-sidecar-title">Tasks</span>
        <span className="tasks-sidecar-stats">{completed}/{entries.length}</span>
      </div>
      <div className="tasks-sidecar-list">
        {entries.map((entry) => (
          <div key={entry.id} className={`tasks-sidecar-item ${entry.status}`}>
            <span className={`tasks-sidecar-icon ${entry.status}`}>
              <CheckIcon status={entry.status} />
            </span>
            <span className="tasks-sidecar-text">
              {entry.status === "in_progress" && entry.activeForm
                ? entry.activeForm
                : entry.subject}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export const TasksSidecar = memo(function TasksSidecar() {
  const { latestPlan, latestTasks } = useWsState();

  const hasTodos = latestPlan && latestPlan.length > 0;
  const hasTasks = latestTasks && latestTasks.length > 0;

  if (!hasTodos && !hasTasks) return null;

  return (
    <div className={`tasks-sidecar${hasTodos && hasTasks ? " split" : ""}`}>
      {hasTodos && <TodosSection entries={latestPlan} fullHeight={!hasTasks} />}
      {hasTodos && hasTasks && <div className="tasks-sidecar-divider" />}
      {hasTasks && <TasksSection entries={latestTasks} fullHeight={!hasTodos} />}
    </div>
  );
});
