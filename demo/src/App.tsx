import { useRef } from "react";
import { WebSocketProvider, useWs } from "./context/WebSocketContext";
import { Header } from "./components/Header";
import { TaskBar } from "./components/TaskBar";
import { TaskPanel } from "./components/TaskPanel";
import { ChatPanel } from "./components/ChatPanel";
import { TasksSidecar } from "./components/TasksSidecar";
import { ResizeHandle } from "./components/ResizeHandle";
import { DebugPanel } from "./components/DebugPanel";
import { SessionSidebar } from "./components/SessionSidebar";

function ReconnectBanner() {
  const { state } = useWs();
  if (state.connected) return null;

  return (
    <div className="bg-amber-900/80 text-amber-200 text-xs text-center py-1.5 px-4 shrink-0 flex items-center justify-center gap-2">
      <span className="inline-block w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
      {state.reconnectAttempt > 0
        ? `Connection lost. Reconnecting (attempt ${state.reconnectAttempt})...`
        : "Connecting to server..."}
    </div>
  );
}

function Layout() {
  const { state } = useWs();
  const debugPanelRef = useRef<HTMLDivElement>(null);

  return (
    <>
      <Header />
      <ReconnectBanner />
      <TaskBar />
      <TaskPanel />
      <div className="flex-1 flex min-h-0 overflow-hidden">
        <SessionSidebar />
        <ChatPanel />
        <TasksSidecar />
        {!state.debugCollapsed && (
          <>
            <ResizeHandle
              debugPanelRef={debugPanelRef}
              collapsed={false}
            />
            <DebugPanel ref={debugPanelRef} />
          </>
        )}
      </div>
    </>
  );
}

export function App() {
  return (
    <WebSocketProvider>
      <Layout />
    </WebSocketProvider>
  );
}
