/**
 * Confirmo v1.0.54 — Preload bridge (IPC channels exposed to renderer).
 * Decompiled from out/preload/index.js.
 *
 * Key agent-monitoring channels:
 *  - confirmo.getAgentStatus()    → invoke "get-agent-status"
 *  - confirmo.onAgentEvent(cb)    → listen "agent-event"
 *  - confirmo.onCelebrate(cb)     → listen "celebrate" (task-complete → pet animation)
 */

import { ipcRenderer, contextBridge } from "electron";

const confirmoAPI = {
  // Window controls
  closeWindow: () => ipcRenderer.send("window-close"),
  minimizeWindow: () => ipcRenderer.send("window-minimize"),
  openSettings: () => ipcRenderer.send("open-settings"),
  openArena: (roomId?: string) => ipcRenderer.send("open-arena", roomId),
  hidePet: () => ipcRenderer.send("hide-pet"),
  resizePetWindow: (w: number, h: number) => ipcRenderer.send("resize-pet-window", w, h),

  // Settings
  getSettings: () => ipcRenderer.invoke("get-settings"),
  setSetting: (key: string, value: unknown) => ipcRenderer.invoke("set-setting", key, value),

  // Agent monitoring — the key channels
  getAgentStatus: () => ipcRenderer.invoke("get-agent-status"),
  onAgentEvent: (callback: (event: AgentEvent) => void) => {
    const handler = (_: any, event: AgentEvent) => callback(event);
    ipcRenderer.on("agent-event", handler);
    return () => ipcRenderer.removeListener("agent-event", handler);
  },
  onCelebrate: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on("celebrate", handler);
    return () => ipcRenderer.removeListener("celebrate", handler);
  },

  // Pet controls
  setPetPosition: (x: number, y: number) => ipcRenderer.send("set-pet-position", x, y),
  savePetPosition: (x: number, y: number) => ipcRenderer.send("save-pet-position", x, y),
  setIgnoreMouseEvents: (ignore: boolean, options?: object) =>
    ipcRenderer.send("set-ignore-mouse-events", ignore, options),

  // Settings change listener
  onSettingsChanged: (callback: (data: { key: string; value: unknown }) => void) => {
    const handler = (_: any, data: { key: string; value: unknown }) => callback(data);
    ipcRenderer.on("settings-changed", handler);
    return () => ipcRenderer.removeListener("settings-changed", handler);
  },

  // App info
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  getUserDataPath: () => ipcRenderer.invoke("get-user-data-path"),

  // External links
  openExternal: (url: string) => ipcRenderer.send("open-external", url),
};

interface AgentEvent {
  type: "agent-start" | "agent-stop" | "agent-active" | "agent-idle" | "task-complete" | "task-error";
  agent: string;
  timestamp: number;
  details?: string;
  sessionId?: string;
  sessionTitle?: string;
  workingDirectory?: string;
}

// Expose to renderer via context bridge
contextBridge.exposeInMainWorld("confirmo", confirmoAPI);
