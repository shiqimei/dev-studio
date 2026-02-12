import { useRef, useState, useCallback, useEffect } from "react";
import { DndProvider } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";
import { WebSocketProvider, useWs, useWsState } from "./context/WebSocketContext";
import { Header } from "./components/Header";
import { SettingsModal } from "./components/SettingsModal";
import { ChatPanel } from "./components/ChatPanel";
import { KanbanPanel } from "./components/KanbanPanel";

const STORAGE_KEY = "chat-panel-width-pct";
const DEFAULT_PCT = 35;
const MIN_PX = 420;

const isElectron = navigator.userAgent.includes("Electron");
const isMac = navigator.platform.startsWith("Mac");

function WelcomeScreen() {
  const { dispatch } = useWs();

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

  return (
    <>
      {/* Minimal title bar for Electron window drag and traffic lights */}
      {isElectron && (
        <div
          className="welcome-titlebar app-region-drag"
          style={isMac ? { paddingLeft: 78 } : undefined}
        />
      )}
      <div className="welcome-screen">
        <div className="welcome-content">
          <svg
            width="120"
            height="120"
            viewBox="0 0 120 120"
            fill="none"
            className="welcome-icon"
          >
            {/* Folder shape */}
            <path
              d="M16 32C16 28.6863 18.6863 26 22 26H44L52 34H98C101.314 34 104 36.6863 104 40V88C104 91.3137 101.314 94 98 94H22C18.6863 94 16 91.3137 16 88V32Z"
              stroke="currentColor"
              strokeWidth="2"
              opacity="0.35"
            />
            {/* Plus icon in folder */}
            <line x1="60" y1="54" x2="60" y2="78" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" opacity="0.5" />
            <line x1="48" y1="66" x2="72" y2="66" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" opacity="0.5" />
            {/* Small sparkle accents */}
            <circle cx="90" cy="22" r="2" fill="currentColor" opacity="0.2" />
            <circle cx="98" cy="28" r="1.2" fill="currentColor" opacity="0.15" />
            <circle cx="28" cy="18" r="1.5" fill="currentColor" opacity="0.15" />
          </svg>
          <h1 className="welcome-title">Welcome to Dev Studio</h1>
          <p className="welcome-subtitle">Add a project folder to start building</p>
          <button className="welcome-add-btn" onClick={addProject}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            Open Folder
          </button>
        </div>
      </div>
    </>
  );
}

function useLoadProjects() {
  const { dispatch } = useWs();
  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((data) => {
        dispatch({
          type: "SET_PROJECTS",
          projects: data.projects ?? [],
          activeProject: data.activeProject ?? null,
        });
      })
      .catch(() => {});
  }, [dispatch]);
}

function Layout() {
  useLoadProjects();
  const state = useWsState();
  const containerRef = useRef<HTMLDivElement>(null);
  const resizing = useRef(false);
  const handleRef = useRef<HTMLDivElement>(null);

  const [chatWidthPct, setChatWidthPct] = useState<number>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const n = parseFloat(stored);
        if (n >= 10 && n <= 80) return n;
      }
    } catch {}
    return DEFAULT_PCT;
  });

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    resizing.current = true;
    handleRef.current?.classList.add("active");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  }, []);

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!resizing.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const rightPx = rect.right - e.clientX;
      const clampedPx = Math.max(MIN_PX, Math.min(rightPx, rect.width * 0.8));
      const pct = (clampedPx / rect.width) * 100;
      setChatWidthPct(pct);
    }
    function onMouseUp() {
      if (!resizing.current) return;
      resizing.current = false;
      handleRef.current?.classList.remove("active");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  // Persist to localStorage on change (debounced via rAF)
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(chatWidthPct));
    } catch {}
  }, [chatWidthPct]);

  const hasProjects = state.projects.length > 0;

  if (!hasProjects) {
    return (
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        <SettingsModal />
        <WelcomeScreen />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <Header />
      <SettingsModal />
      <DndProvider backend={HTML5Backend}>
        <div ref={containerRef} className="flex-1 flex min-h-0 overflow-hidden">
          <KanbanPanel />
          <div
            ref={handleRef}
            className="panel-resize-handle"
            onMouseDown={onMouseDown}
          />
          <ChatPanel style={{ width: `${chatWidthPct}%`, minWidth: `${MIN_PX}px` }} />
        </div>
      </DndProvider>
    </div>
  );
}

export function App() {
  return (
    <WebSocketProvider>
      <Layout />
    </WebSocketProvider>
  );
}
