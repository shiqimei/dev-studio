/**
 * Electron main process for Dev Studio.
 *
 * Starts the Bun backend server and Vite dev server,
 * then opens a BrowserWindow pointing at the Vite URL.
 */

import { app, BrowserWindow, Menu, nativeImage, dialog, ipcMain } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite";

// Works from both app/main.ts (bun) and app/dist/main.js (electron)
const ROOT = import.meta.dirname.endsWith(path.sep + "dist")
  ? path.resolve(import.meta.dirname, "../..")
  : path.resolve(import.meta.dirname, "..");

const BACKEND_PORT = 5689;
const VITE_PORT = 5688;

let backend: ChildProcess | null = null;
let vite: ViteDevServer | null = null;
let mainWindow: BrowserWindow | null = null;

async function waitForPort(port: number, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = createConnection({ port, host: "127.0.0.1" }, () => {
        sock.destroy();
        resolve(true);
      });
      sock.on("error", () => resolve(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Port ${port} not ready after ${timeoutMs}ms`);
}

function startBackend(): ChildProcess {
  const child = spawn("bun", ["--hot", path.join(ROOT, "core/server/main.ts")], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(BACKEND_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (data: Buffer) => {
    process.stdout.write(`[server] ${data.toString()}`);
  });
  child.stderr?.on("data", (data: Buffer) => {
    process.stderr.write(`[server] ${data.toString()}`);
  });
  child.on("exit", (code, signal) => {
    if (signal !== "SIGTERM" && signal !== "SIGINT") {
      console.error(`Backend exited unexpectedly (code=${code}, signal=${signal})`);
    }
  });

  return child;
}

async function startVite(): Promise<ViteDevServer> {
  const server = await createServer({
    configFile: path.join(ROOT, "core/vite.config.ts"),
    root: path.join(ROOT, "core"),
    server: { port: VITE_PORT },
  });
  await server.listen();
  return server;
}

function createWindow(): BrowserWindow {
  const isMac = process.platform === "darwin";

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "Dev Studio",
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    ...(isMac
      ? { trafficLightPosition: { x: 16, y: 12 } }
      : { titleBarOverlay: { color: "#0a0a0a", symbolColor: "#fafafa", height: 36 } }),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(ROOT, "app/preload.cjs"),
    },
  });

  win.loadURL(`http://localhost:${VITE_PORT}`);
  return win;
}

async function cleanup() {
  if (vite) {
    await vite.close();
    vite = null;
  }
  if (backend) {
    backend.kill("SIGTERM");
    backend = null;
  }
}

app.setName("Dev Studio");

app.whenReady().then(async () => {
  try {
    const isMac = process.platform === "darwin";
    const appName = "Dev Studio";

    // Set dock icon at runtime (works immediately for the current process)
    if (isMac && app.dock) {
      const iconPng = path.join(ROOT, "app/icon.png");
      if (existsSync(iconPng)) {
        app.dock.setIcon(nativeImage.createFromPath(iconPng));
      }
    }

    const sendOpenSettings = () => {
      const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
      win?.webContents.send("open-settings");
    };

    const template: Electron.MenuItemConstructorOptions[] = [
      ...(isMac
        ? [
            {
              label: appName,
              submenu: [
                { role: "about" as const, label: `About ${appName}` },
                { type: "separator" as const },
                {
                  label: "Settings...",
                  accelerator: "CmdOrCtrl+,",
                  click: sendOpenSettings,
                },
                { type: "separator" as const },
                { role: "services" as const },
                { type: "separator" as const },
                { role: "hide" as const, label: `Hide ${appName}` },
                { role: "hideOthers" as const },
                { role: "unhide" as const },
                { type: "separator" as const },
                { role: "quit" as const, label: `Quit ${appName}` },
              ],
            } satisfies Electron.MenuItemConstructorOptions,
          ]
        : []),
      {
        label: "File",
        submenu: [
          ...(!isMac
            ? [
                {
                  label: "Settings...",
                  accelerator: "CmdOrCtrl+,",
                  click: sendOpenSettings,
                },
                { type: "separator" as const },
              ]
            : []),
          isMac ? { role: "close" as const } : { role: "quit" as const },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" as const },
          { role: "redo" as const },
          { type: "separator" as const },
          { role: "cut" as const },
          { role: "copy" as const },
          { role: "paste" as const },
          { role: "selectAll" as const },
        ],
      },
      {
        label: "View",
        submenu: [
          { role: "reload" as const },
          { role: "forceReload" as const },
          { role: "toggleDevTools" as const },
          { type: "separator" as const },
          { role: "resetZoom" as const },
          { role: "zoomIn" as const },
          { role: "zoomOut" as const },
          { type: "separator" as const },
          { role: "togglefullscreen" as const },
        ],
      },
      {
        label: "Window",
        submenu: [
          { role: "minimize" as const },
          { role: "zoom" as const },
          ...(isMac
            ? [
                { type: "separator" as const },
                { role: "front" as const },
              ]
            : [{ role: "close" as const }]),
        ],
      },
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));

    // IPC: native folder picker (parented to the focused window)
    ipcMain.handle("pick-folder", async () => {
      const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
      const result = await dialog.showOpenDialog(win!, {
        properties: ["openDirectory"],
        title: "Select project folder",
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0];
    });

    // 1. Start backend
    backend = startBackend();
    await waitForPort(BACKEND_PORT);

    // 2. Start Vite
    vite = await startVite();

    // 3. Open window
    mainWindow = createWindow();
    mainWindow.on("closed", () => {
      mainWindow = null;
    });
  } catch (err) {
    console.error("Failed to start:", err);
    await cleanup();
    app.quit();
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  cleanup();
});
