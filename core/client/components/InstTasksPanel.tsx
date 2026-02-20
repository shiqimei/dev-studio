import { useState, useEffect, useCallback, useMemo } from "react";

// ── Types ──

interface InstCheckpoint {
  label: string;
  passed: boolean;
}

interface InstRunSummary {
  run: number;
  status: string;
  passed: boolean;
}

interface InstLatestRun {
  run: number;
  status: string;
  entry_count: number;
  checkpoints: InstCheckpoint[];
  passed: boolean;
}

interface InstTaskStatus {
  task_uuid: string;
  task_name: string;
  total_runs: number;
  latest_run: InstLatestRun | null;
  run_history: InstRunSummary[];
}

interface InstTaskListItem {
  task_uuid: string;
  task_name: string;
  total_runs: number;
  latest_status: string;
  latest_passed: boolean | null;
}

interface InstLogEntry {
  kind: string;
  label?: string;
  message?: string;
  data?: unknown;
  passed?: boolean;
  actual?: unknown;
  expected?: unknown;
  ts?: number;
}

interface InstRunLogs {
  task_uuid: string;
  task_name: string;
  run: number;
  total_runs: number;
  entries: InstLogEntry[];
}

// ── Dashboard Summary ──

function DashboardSummary({ tasks }: { tasks: InstTaskListItem[] }) {
  const total = tasks.length;
  const passed = tasks.filter((t) => t.latest_passed === true).length;
  const failed = tasks.filter((t) => t.latest_passed === false).length;
  const pending = total - passed - failed;
  const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;

  return (
    <div className="inst-dashboard">
      <div className="inst-dashboard-stat">
        <span className="inst-dashboard-num">{total}</span>
        <span className="inst-dashboard-label">Tasks</span>
      </div>
      <div className="inst-dashboard-stat">
        <span className="inst-dashboard-num inst-pass">{passed}</span>
        <span className="inst-dashboard-label">Passed</span>
      </div>
      <div className="inst-dashboard-stat">
        <span className="inst-dashboard-num inst-fail">{failed}</span>
        <span className="inst-dashboard-label">Failed</span>
      </div>
      {pending > 0 && (
        <div className="inst-dashboard-stat">
          <span className="inst-dashboard-num">{pending}</span>
          <span className="inst-dashboard-label">Pending</span>
        </div>
      )}
      <div className="inst-dashboard-bar">
        {total > 0 && (
          <>
            <div className="inst-bar-pass" style={{ width: `${passRate}%` }} />
            <div className="inst-bar-fail" style={{ width: `${total > 0 ? Math.round((failed / total) * 100) : 0}%` }} />
          </>
        )}
      </div>
    </div>
  );
}

// ── Run Detail (logs, checkpoints, assertions) ──

function RunDetail({ taskUuid, runNumber }: { taskUuid: string; runNumber: number }) {
  const [logs, setLogs] = useState<InstRunLogs | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/inst/tasks/${taskUuid}/logs?run=${runNumber}`)
      .then((r) => r.json())
      .then((data) => { setLogs(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [taskUuid, runNumber]);

  if (loading) return <div className="inst-run-loading">Loading...</div>;
  if (!logs || !logs.entries) return <div className="inst-run-loading">No data</div>;

  return (
    <div className="inst-run-entries">
      {logs.entries.map((entry, i) => (
        <div key={i} className={`inst-entry inst-entry-${entry.kind?.toLowerCase() ?? "log"}`}>
          <span className={`inst-entry-badge ${entry.kind?.toLowerCase() ?? "log"}`}>
            {entry.kind ?? "LOG"}
          </span>
          {entry.kind === "CHECK" && (
            <>
              <span className={`inst-check-icon ${entry.passed ? "pass" : "fail"}`}>
                {entry.passed ? "✓" : "✗"}
              </span>
              <span className="inst-entry-label">{entry.label}</span>
              {entry.data !== undefined && (
                <span className="inst-entry-data">{JSON.stringify(entry.data)}</span>
              )}
            </>
          )}
          {entry.kind === "EXPECT" && (
            <>
              <span className={`inst-check-icon ${entry.passed ? "pass" : "fail"}`}>
                {entry.passed ? "✓" : "✗"}
              </span>
              <span className="inst-entry-label">{entry.label}</span>
              {!entry.passed && (
                <span className="inst-entry-diff">
                  expected: {JSON.stringify(entry.expected)} → actual: {JSON.stringify(entry.actual)}
                </span>
              )}
            </>
          )}
          {entry.kind === "LOG" && (
            <span className="inst-entry-message">{entry.message ?? JSON.stringify(entry.data)}</span>
          )}
          {!["CHECK", "EXPECT", "LOG"].includes(entry.kind) && (
            <span className="inst-entry-message">{entry.label ?? entry.message ?? JSON.stringify(entry)}</span>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Task Row ──

function TaskRow({ task }: { task: InstTaskListItem }) {
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState<InstTaskStatus | null>(null);
  const [expandedRun, setExpandedRun] = useState<number | null>(null);

  useEffect(() => {
    if (!expanded) return;
    fetch(`/api/inst/tasks/${task.task_uuid}/status`)
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => {});
  }, [expanded, task.task_uuid]);

  const failCount = status?.run_history.filter((r) => !r.passed).length ?? 0;

  return (
    <div className={`inst-task${task.latest_passed === false ? " inst-task-failed" : ""}`}>
      <div className="inst-task-header" onClick={() => setExpanded(!expanded)}>
        <span className={`inst-task-chevron${expanded ? " expanded" : ""}`}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M4.5 2.5L7.5 6L4.5 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <span className={`inst-task-status-dot ${task.latest_passed === true ? "pass" : task.latest_passed === false ? "fail" : "pending"}`} />
        <span className="inst-task-name">{task.task_name}</span>
        <span className="inst-task-uuid">{task.task_uuid.slice(0, 8)}</span>
        <span className="inst-task-runs">{task.total_runs} run{task.total_runs !== 1 ? "s" : ""}</span>
        {failCount > 0 && (
          <span className="inst-fail-badge">{failCount} failed</span>
        )}
      </div>
      {expanded && status && (
        <div className="inst-task-body">
          {status.run_history.map((run) => (
            <div key={run.run} className="inst-run">
              <div
                className="inst-run-header"
                onClick={() => setExpandedRun(expandedRun === run.run ? null : run.run)}
              >
                <span className={`inst-run-indicator ${run.passed ? "pass" : "fail"}`} />
                <span className="inst-run-label">Run #{run.run}</span>
                <span className={`inst-run-status ${run.status}`}>{run.status}</span>
                <span className={`inst-run-verdict ${run.passed ? "pass" : "fail"}`}>
                  {run.passed ? "PASS" : "FAIL"}
                </span>
              </div>
              {expandedRun === run.run && (
                <RunDetail taskUuid={task.task_uuid} runNumber={run.run} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Panel ──

export function InstTasksPanel({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [tasks, setTasks] = useState<InstTaskListItem[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchTasks = useCallback(() => {
    fetch("/api/inst/tasks")
      .then((r) => r.json())
      .then((data) => {
        setTasks(data.tasks ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  // Initial fetch + poll every 3s when visible
  useEffect(() => {
    if (!visible) return;
    fetchTasks();
    const id = setInterval(fetchTasks, 3000);
    return () => clearInterval(id);
  }, [visible, fetchTasks]);

  if (!visible) return null;

  return (
    <div className="inst-panel">
      <div className="inst-panel-header">
        <span className="inst-panel-title">🧪 AgentInst Tasks</span>
        <button className="inst-panel-close" onClick={onClose}>✕</button>
      </div>
      {loading && tasks.length === 0 ? (
        <div className="inst-panel-empty">Loading tasks...</div>
      ) : tasks.length === 0 ? (
        <div className="inst-panel-empty">No instrumented tasks yet. Agent output with <code>:::INST:</code> lines will appear here.</div>
      ) : (
        <>
          <DashboardSummary tasks={tasks} />
          <div className="inst-task-list">
            {tasks.map((task) => (
              <TaskRow key={task.task_uuid} task={task} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
