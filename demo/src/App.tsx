import { useRef, useState, useCallback, useEffect } from "react";
import { DndProvider } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";
import { WebSocketProvider, useWsState } from "./context/WebSocketContext";
import { Header } from "./components/Header";
import { TaskBar } from "./components/TaskBar";
import { TaskPanel } from "./components/TaskPanel";
import { ChatPanel } from "./components/ChatPanel";
import { KanbanPanel } from "./components/KanbanPanel";

const STORAGE_KEY = "chat-panel-width-pct";
const DEFAULT_PCT = 35;
const MIN_PX = 420;

function Layout() {
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

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <Header />
      <TaskBar />
      <TaskPanel />
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
