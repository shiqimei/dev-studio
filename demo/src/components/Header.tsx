import { useCallback, useEffect, useState } from "react";
import { useWs } from "../context/WebSocketContext";
import { shortPath } from "../utils";

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

  const addProject = useCallback(async () => {
    try {
      const pickRes = await fetch("/api/pick-folder", { method: "POST" });
      const { path } = await pickRes.json();
      if (!path) return;
      const addRes = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const data = await addRes.json();
      dispatch({
        type: "SET_PROJECTS",
        projects: data.projects,
        activeProject: data.activeProject,
      });
    } catch {}
  }, [dispatch]);

  const switchProject = useCallback(
    (path: string) => {
      dispatch({ type: "SET_ACTIVE_PROJECT", path });
      fetch("/api/projects/active", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
    },
    [dispatch],
  );

  const removeProject = useCallback(
    async (path: string, e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        const res = await fetch("/api/projects", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path }),
        });
        const data = await res.json();
        dispatch({
          type: "SET_PROJECTS",
          projects: data.projects,
          activeProject: data.activeProject,
        });
      } catch {}
    },
    [dispatch],
  );

  return (
    <header
      style={{ height: 41.28 }}
      className={`px-5 border-b border-border flex items-center gap-3 shrink-0 min-w-0 overflow-visible relative${isElectron ? " app-region-drag" : ""}${isElectron && isMac ? " pl-[78px]" : ""}`}
    >
      {/* Project tabs */}
      <div className="project-tabs app-region-no-drag">
        {state.projects.map((p) => (
          <button
            key={p}
            className={`project-tab${p === state.activeProject ? " active" : ""}`}
            onClick={() => switchProject(p)}
            onAuxClick={(e) => {
              if (e.button === 1) removeProject(p, e);
            }}
            title={p}
          >
            <span className="project-tab-label">{shortPath(p)}</span>
            {state.projects.length > 1 && (
              <span
                className="project-tab-close"
                onClick={(e) => removeProject(p, e)}
              >
                &times;
              </span>
            )}
          </button>
        ))}
        <button className="project-tab-add" onClick={addProject} title="Add project folder">
          +
        </button>
      </div>

      <div className="flex-1" />

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
