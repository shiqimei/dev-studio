import { useCallback, useEffect, useState } from "react";
import { useWs } from "../context/WebSocketContext";

const isElectron = navigator.userAgent.includes("Electron");
const isMac = navigator.platform.startsWith("Mac");

export function Header({
  sidebarCollapsed,
  onToggleSidebar,
}: {
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
}) {
  const { state, dispatch } = useWs();
  const toggleDebug = useCallback(() => dispatch({ type: "TOGGLE_DEBUG_COLLAPSE" }), [dispatch]);

  const [debugBtnVisible, setDebugBtnVisible] = useState(false);

  // Cmd+Shift+P (Mac) / Ctrl+Shift+P (other) toggles Protocol button visibility
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key.toLowerCase() === "p" && e.shiftKey && (e.metaKey || e.ctrlKey) && !e.altKey) {
        e.preventDefault();
        setDebugBtnVisible((v) => !v);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <header
      style={{ height: 41.28 }}
      className={`pr-5 border-b border-border flex items-center gap-3 shrink-0 min-w-0 overflow-hidden${isElectron ? " app-region-drag" : ""}${sidebarCollapsed ? (isElectron && isMac ? " pl-[78px]" : " pl-5") : " pl-1.5"}`}
    >
      {onToggleSidebar && !sidebarCollapsed && (
        <button
          onClick={onToggleSidebar}
          className="sidebar-toggle-btn app-region-no-drag"
          title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
            <line x1="6" y1="3.5" x2="6" y2="12.5" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
      )}

      <div className="flex-1" />

      {debugBtnVisible && (
        <button
          className="debug-ctrl-btn text-[11px] px-2 py-0.5 shrink-0 app-region-no-drag"
          onClick={toggleDebug}
          title={state.debugCollapsed ? "Show protocol debug panel" : "Hide protocol debug panel"}
        >
          {state.debugCollapsed ? "Protocol \u25C0" : "Protocol \u25B6"}
        </button>
      )}
    </header>
  );
}
