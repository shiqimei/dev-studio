import { useEffect, useRef, useState, useCallback } from "react";
import { useTheme, THEMES } from "../context/ThemeContext";
import { useWsActions } from "../context/WebSocketContext";
import type { HaikuMetricEntry } from "../../server/haiku-pool";

const isElectron = navigator.userAgent.includes("Electron");
const isMac = navigator.platform.startsWith("Mac");
const MOD = isMac ? "\u2318" : "Ctrl";

const KEYBINDINGS: { keys: string; description: string }[] = [
  { keys: "Enter", description: "Send message" },
  { keys: "Shift+Enter", description: "New line" },
  { keys: "Escape", description: "Interrupt agent" },
  { keys: `${MOD}+Z`, description: "Undo" },
  { keys: `${MOD}+Shift+Z`, description: "Redo" },
  { keys: `${MOD}+Shift+P`, description: "Toggle protocol debug" },
  { keys: `${MOD}+P`, description: "Search cards" },
  { keys: "/", description: "Slash commands" },
  { keys: "@", description: "Mention file" },
];

declare global {
  interface Window {
    electronAPI?: {
      onOpenSettings: (callback: () => void) => () => void;
    };
  }
}

type SettingsTab = "general" | "metrics";

// ── Percentile helpers ──

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function computePercentiles(values: number[]): { p50: number; p95: number; p99: number } {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatSize(chars: number): string {
  if (chars < 1000) return `${chars}`;
  return `${(chars / 1000).toFixed(1)}k`;
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m ago`;
  return `${Math.round(diff / 3600_000)}h ago`;
}

// ── Bar chart component ──

function BarChart({ label, values, maxValue, colorVar }: {
  label: string;
  values: { name: string; value: number; formatted: string }[];
  maxValue: number;
  colorVar: string;
}) {
  return (
    <div className="metrics-chart">
      <div className="metrics-chart-label">{label}</div>
      {values.map((v) => (
        <div key={v.name} className="metrics-bar-row">
          <span className="metrics-bar-name">{v.name}</span>
          <div className="metrics-bar-track">
            <div
              className="metrics-bar-fill"
              style={{
                width: maxValue > 0 ? `${Math.min(100, (v.value / maxValue) * 100)}%` : "0%",
                backgroundColor: `var(${colorVar})`,
              }}
            />
          </div>
          <span className="metrics-bar-value">{v.formatted}</span>
        </div>
      ))}
    </div>
  );
}

// ── Metrics tab content ──

function MetricsTab() {
  const { requestHaikuMetrics } = useWsActions();
  const [metrics, setMetrics] = useState<HaikuMetricEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    requestHaikuMetrics();
  }, [requestHaikuMetrics]);

  useEffect(() => {
    refresh();
    function onMetrics(e: Event) {
      const detail = (e as CustomEvent).detail as HaikuMetricEntry[];
      setMetrics(detail ?? []);
      setLoading(false);
    }
    window.addEventListener("haiku-metrics", onMetrics);
    return () => window.removeEventListener("haiku-metrics", onMetrics);
  }, [refresh]);

  // Split by operation
  const routeMetrics = metrics.filter((m) => m.operation === "route" && m.success);
  const titleMetrics = metrics.filter((m) => m.operation === "title" && m.success);

  const routeLatencies = computePercentiles(routeMetrics.map((m) => m.durationMs));
  const titleLatencies = computePercentiles(titleMetrics.map((m) => m.durationMs));

  const routeInputs = computePercentiles(routeMetrics.map((m) => m.inputLength));
  const titleInputs = computePercentiles(titleMetrics.map((m) => m.inputLength));
  const routeOutputs = computePercentiles(routeMetrics.map((m) => m.outputLength));
  const titleOutputs = computePercentiles(titleMetrics.map((m) => m.outputLength));

  // Max values for bar scaling
  const maxLatency = Math.max(routeLatencies.p99, titleLatencies.p99, 1);
  const maxInput = Math.max(routeInputs.p99, titleInputs.p99, 1);
  const maxOutput = Math.max(routeOutputs.p99, titleOutputs.p99, 1);

  const totalCalls = metrics.length;
  const failedCalls = metrics.filter((m) => !m.success).length;

  // Overall latency across all successful calls
  const allSuccessful = metrics.filter((m) => m.success);
  const overallLatencies = computePercentiles(allSuccessful.map((m) => m.durationMs));

  return (
    <div className="metrics-tab">
      {/* Header */}
      <div className="metrics-header">
        <span className="metrics-header-title">Haiku Pool Metrics</span>
        <span className="metrics-header-stats">
          {totalCalls} calls{failedCalls > 0 && <>, <span style={{ color: "var(--color-red)" }}>{failedCalls} failed</span></>}
        </span>
        <button className="metrics-refresh-btn" onClick={refresh} disabled={loading}>
          {loading ? "..." : "Refresh"}
        </button>
      </div>

      {/* P95 / P99 headline stats */}
      {allSuccessful.length > 0 && (
        <div className="metrics-stats-row">
          <div className="metrics-stat-card">
            <span className="metrics-stat-label">P95</span>
            <span className="metrics-stat-value">{formatMs(overallLatencies.p95)}</span>
          </div>
          <div className="metrics-stat-card">
            <span className="metrics-stat-label">P99</span>
            <span className="metrics-stat-value">{formatMs(overallLatencies.p99)}</span>
          </div>
          <div className="metrics-stat-card">
            <span className="metrics-stat-label">Route P95</span>
            <span className="metrics-stat-value accent-blue">{formatMs(routeLatencies.p95)}</span>
          </div>
          <div className="metrics-stat-card">
            <span className="metrics-stat-label">Title P95</span>
            <span className="metrics-stat-value accent-purple">{formatMs(titleLatencies.p95)}</span>
          </div>
        </div>
      )}

      {metrics.length === 0 && !loading && (
        <div className="metrics-empty">No Haiku calls recorded yet. Send a message to generate routing calls.</div>
      )}

      {metrics.length > 0 && (
        <>
          {/* Latency charts */}
          <div className="metrics-section">
            <div className="metrics-section-label">Latency</div>
            <div className="metrics-charts-row">
              <BarChart
                label="Route"
                colorVar="--color-blue"
                maxValue={maxLatency}
                values={[
                  { name: "p50", value: routeLatencies.p50, formatted: formatMs(routeLatencies.p50) },
                  { name: "p95", value: routeLatencies.p95, formatted: formatMs(routeLatencies.p95) },
                  { name: "p99", value: routeLatencies.p99, formatted: formatMs(routeLatencies.p99) },
                ]}
              />
              <BarChart
                label="Title"
                colorVar="--color-purple"
                maxValue={maxLatency}
                values={[
                  { name: "p50", value: titleLatencies.p50, formatted: formatMs(titleLatencies.p50) },
                  { name: "p95", value: titleLatencies.p95, formatted: formatMs(titleLatencies.p95) },
                  { name: "p99", value: titleLatencies.p99, formatted: formatMs(titleLatencies.p99) },
                ]}
              />
            </div>
          </div>

          {/* Input/Output size charts */}
          <div className="metrics-section">
            <div className="metrics-section-label">Input Size (chars)</div>
            <div className="metrics-charts-row">
              <BarChart
                label="Route"
                colorVar="--color-blue"
                maxValue={maxInput}
                values={[
                  { name: "p50", value: routeInputs.p50, formatted: formatSize(routeInputs.p50) },
                  { name: "p95", value: routeInputs.p95, formatted: formatSize(routeInputs.p95) },
                  { name: "p99", value: routeInputs.p99, formatted: formatSize(routeInputs.p99) },
                ]}
              />
              <BarChart
                label="Title"
                colorVar="--color-purple"
                maxValue={maxInput}
                values={[
                  { name: "p50", value: titleInputs.p50, formatted: formatSize(titleInputs.p50) },
                  { name: "p95", value: titleInputs.p95, formatted: formatSize(titleInputs.p95) },
                  { name: "p99", value: titleInputs.p99, formatted: formatSize(titleInputs.p99) },
                ]}
              />
            </div>
          </div>

          <div className="metrics-section">
            <div className="metrics-section-label">Output Size (chars)</div>
            <div className="metrics-charts-row">
              <BarChart
                label="Route"
                colorVar="--color-blue"
                maxValue={maxOutput}
                values={[
                  { name: "p50", value: routeOutputs.p50, formatted: formatSize(routeOutputs.p50) },
                  { name: "p95", value: routeOutputs.p95, formatted: formatSize(routeOutputs.p95) },
                  { name: "p99", value: routeOutputs.p99, formatted: formatSize(routeOutputs.p99) },
                ]}
              />
              <BarChart
                label="Title"
                colorVar="--color-purple"
                maxValue={maxOutput}
                values={[
                  { name: "p50", value: titleOutputs.p50, formatted: formatSize(titleOutputs.p50) },
                  { name: "p95", value: titleOutputs.p95, formatted: formatSize(titleOutputs.p95) },
                  { name: "p99", value: titleOutputs.p99, formatted: formatSize(titleOutputs.p99) },
                ]}
              />
            </div>
          </div>

          {/* Trace logs */}
          <div className="metrics-section">
            <div className="metrics-section-label">Trace Log</div>
            <div className="metrics-trace-list">
              {[...metrics].reverse().map((m, i) => (
                <div key={i} className={`metrics-trace-card${m.success ? "" : " failed"}`}>
                  <div className="metrics-trace-header">
                    <span className={`metrics-trace-badge ${m.operation}`}>
                      {m.operation.toUpperCase()}
                    </span>
                    <span className="metrics-trace-duration">{formatMs(m.durationMs)}</span>
                    {!m.success && <span className="metrics-trace-fail">FAIL</span>}
                    <span className="metrics-trace-time">{timeAgo(m.timestamp)}</span>
                  </div>
                  <div className="metrics-trace-details">
                    <span>in: {formatSize(m.inputLength)}</span>
                    <span>out: {formatSize(m.outputLength)}</span>
                  </div>
                  {m.output && (
                    <div className="metrics-trace-output">{m.output}</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Main settings modal ──

export function SettingsModal() {
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const panelRef = useRef<HTMLDivElement>(null);

  // Listen for Electron IPC "open-settings" (from menu bar click)
  useEffect(() => {
    if (!window.electronAPI) return;
    return window.electronAPI.onOpenSettings(() => setOpen((prev) => !prev));
  }, []);

  // Fallback: Cmd+, / Ctrl+, keyboard shortcut when NOT in Electron
  useEffect(() => {
    if (isElectron) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "," && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Escape to close
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open]);

  if (!open) return null;

  return (
    <div className="settings-overlay" onClick={() => setOpen(false)}>
      <div
        ref={panelRef}
        className="settings-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="settings-modal-header">
          <span className="settings-modal-title">Settings</span>
          <button
            className="settings-modal-close"
            onClick={() => setOpen(false)}
            title="Close"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M3 3l8 8M11 3l-8 8" />
            </svg>
          </button>
        </div>

        {/* Content: nav + body */}
        <div className="settings-layout">
          {/* Sidebar nav */}
          <nav className="settings-nav">
            <button
              className={`settings-nav-item${activeTab === "general" ? " active" : ""}`}
              onClick={() => setActiveTab("general")}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="8" cy="8" r="2.5" />
                <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.05 3.05l1.06 1.06M11.89 11.89l1.06 1.06M3.05 12.95l1.06-1.06M11.89 4.11l1.06-1.06" />
              </svg>
              General
            </button>
            <button
              className={`settings-nav-item${activeTab === "metrics" ? " active" : ""}`}
              onClick={() => setActiveTab("metrics")}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                <rect x="1" y="10" width="3" height="5" rx="0.5" />
                <rect x="6.5" y="6" width="3" height="9" rx="0.5" />
                <rect x="12" y="1" width="3" height="14" rx="0.5" />
              </svg>
              Metrics
            </button>
          </nav>

          {/* Body */}
          <div className="settings-content">
            {activeTab === "general" && (
              <div className="settings-modal-body">
                {/* Theme section */}
                <div className="settings-section">
                  <div className="settings-section-label">Theme</div>
                  <div className="settings-theme-grid">
                    {THEMES.map((t) => (
                      <button
                        key={t.id}
                        className={`settings-theme-card${theme === t.id ? " active" : ""}`}
                        onClick={() => setTheme(t.id)}
                      >
                        <span className="settings-theme-swatch" style={{ background: t.swatch }} />
                        <span className="settings-theme-name">{t.label}</span>
                        {theme === t.id && (
                          <span className="settings-theme-check">{"\u2713"}</span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Keybindings section */}
                <div className="settings-section">
                  <div className="settings-section-label">Keybindings</div>
                  <div className="settings-keybindings">
                    {KEYBINDINGS.map((kb) => (
                      <div key={kb.keys} className="settings-kb-row">
                        <span className="settings-kb-desc">{kb.description}</span>
                        <kbd className="settings-kb-keys">{kb.keys}</kbd>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {activeTab === "metrics" && <MetricsTab />}
          </div>
        </div>
      </div>
    </div>
  );
}
