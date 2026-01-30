/**
 * Confirmo v1.0.54 — App bootstrap (initialization + event wiring).
 * Decompiled from out/main/index.js (setupIPC + app.whenReady).
 *
 * Shows how AgentMonitor is instantiated and how events flow to the pet window.
 */

import { app, BrowserWindow, ipcMain } from "electron";
import { AgentMonitor } from "./agent-monitor";

let petWindow: BrowserWindow | null = null;
let arenaWindow: BrowserWindow | null = null;
let agentMonitor: AgentMonitor | null = null;

function setupIPC() {
  // Agent status query from renderer
  ipcMain.handle("get-agent-status", () => {
    return agentMonitor?.getStatus() ?? [];
  });

  // ... other IPC handlers (settings, window controls, etc.)
}

app.whenReady().then(() => {
  setupIPC();
  createPetWindow();

  // ── Core: Create AgentMonitor and wire events to pet window ──
  agentMonitor = new AgentMonitor((event) => {
    // Forward every agent event to the pet renderer
    petWindow?.webContents.send("agent-event", event);
    arenaWindow?.webContents.send("agent-event", event);

    // Task completion triggers the celebration animation
    if (event.type === "task-complete") {
      petWindow?.webContents.send("celebrate");
    }
  });

  agentMonitor.start();
});

app.on("before-quit", () => {
  agentMonitor?.stop();
});

function createPetWindow() {
  // Creates a transparent, always-on-top, frameless window for the pet sprite
  // The pet reacts to agent events from AgentMonitor
}
