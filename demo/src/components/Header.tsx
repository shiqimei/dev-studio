import { useCallback, useEffect, useState } from "react";
import { useWs } from "../context/WebSocketContext";

const isElectron = navigator.userAgent.includes("Electron");
const isMac = navigator.platform.startsWith("Mac");

export function Header() {
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
      style={{ minHeight: 41.28 }}
      className={`px-5 py-2.5 border-b border-border flex items-center justify-end gap-3 shrink-0 min-w-0 overflow-hidden${isElectron ? " app-region-drag" : ""}${isElectron && isMac ? " pl-[78px]" : ""}`}
    >

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
