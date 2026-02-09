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

function Layout() {
  const { state } = useWs();
  const debugPanelRef = useRef<HTMLDivElement>(null);

  return (
    <>
      <Header />
      <TaskBar />
      <TaskPanel />
      <div className="flex-1 flex min-h-0 overflow-hidden">
        <SessionSidebar />
        <ChatPanel />
        {state.tasksSidecarOpen && <TasksSidecar />}
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
