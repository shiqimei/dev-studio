import { useRef, useState } from "react";
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  return (
    <div className="flex-1 flex min-h-0 overflow-hidden">
      <SessionSidebar
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed((prev) => !prev)}
      />
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <Header
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={() => setSidebarCollapsed((prev) => !prev)}
        />
        <TaskBar />
        <TaskPanel />
        <div className="flex-1 flex min-h-0 overflow-hidden">
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
      </div>
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
