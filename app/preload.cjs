const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  onOpenSettings: (callback) => {
    ipcRenderer.on("open-settings", () => callback());
    return () => {
      ipcRenderer.removeAllListeners("open-settings");
    };
  },
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
});
