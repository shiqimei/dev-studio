#!/usr/bin/env node
/**
 * Rebrand the stock Electron.app bundle so macOS shows "Dev Studio"
 * in the dock, Activity Monitor, and everywhere else.
 *
 * Idempotent — safe to run repeatedly. Always re-applies plist patches
 * and icon copy so the bundle stays in sync with the current APP_NAME.
 *
 * Run before launching Electron: node app/rebrand.cjs
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const APP_NAME = "Dev Studio";
const BUNDLE_ID = "com.isoform.dev-studio";
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "node_modules/electron/dist");
const NEW_BUNDLE = path.join(DIST, `${APP_NAME}.app`);

function plutil(key, value, plist) {
  execFileSync("plutil", ["-replace", key, "-string", value, plist]);
}

function lsregister(appPath) {
  try {
    execFileSync(
      "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
      ["-f", appPath],
    );
  } catch { /* ignore on non-macOS */ }
}

/**
 * Find the .app bundle in the Electron dist directory.
 * Handles: stock "Electron.app", current "Dev Studio.app",
 * or any previously-rebranded name (e.g. "Claude Code ACP.app").
 */
function findBundle() {
  if (fs.existsSync(NEW_BUNDLE)) return NEW_BUNDLE;
  const stock = path.join(DIST, "Electron.app");
  if (fs.existsSync(stock)) return stock;
  // Scan for any .app bundle (previously rebranded with a different name)
  if (fs.existsSync(DIST)) {
    for (const entry of fs.readdirSync(DIST)) {
      if (entry.endsWith(".app") && fs.statSync(path.join(DIST, entry)).isDirectory()) {
        return path.join(DIST, entry);
      }
    }
  }
  return null;
}

function ensureSpotlightApp() {
  if (process.platform !== "darwin") return;
  const appsDir = path.join(require("os").homedir(), "Applications");
  const wrapper = path.join(appsDir, `${APP_NAME}.app`);
  fs.mkdirSync(appsDir, { recursive: true });

  const macosDir = path.join(wrapper, "Contents/MacOS");
  const resDir = path.join(wrapper, "Contents/Resources");
  const plistPath = path.join(wrapper, "Contents/Info.plist");
  const launcherPath = path.join(macosDir, "launcher");

  // Always recreate the wrapper to keep icon and plist in sync
  fs.rmSync(wrapper, { recursive: true, force: true });

  fs.mkdirSync(macosDir, { recursive: true });
  fs.mkdirSync(resDir, { recursive: true });

  // Launcher script — runs `npm run app` in the project
  fs.writeFileSync(
    launcherPath,
    `#!/bin/bash\ncd "${ROOT}" && exec npm run app\n`,
  );
  fs.chmodSync(launcherPath, 0o755);

  // Copy icon
  const srcIcon = path.join(ROOT, "app/icon.icns");
  const dstIcon = path.join(resDir, "AppIcon.icns");
  if (fs.existsSync(srcIcon)) fs.copyFileSync(srcIcon, dstIcon);

  // Info.plist
  fs.writeFileSync(
    plistPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key>
  <string>${BUNDLE_ID}.launcher</string>
  <key>CFBundleExecutable</key>
  <string>launcher</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleVersion</key>
  <string>1.0</string>
  <key>LSUIElement</key>
  <false/>
</dict>
</plist>\n`,
  );

  lsregister(wrapper);
}

// ── Find and rename bundle ──

const bundle = findBundle();
if (!bundle) {
  console.error("No .app bundle found in", DIST);
  process.exit(1);
}

// Rename bundle directory if needed (handles Electron.app or any old name)
if (bundle !== NEW_BUNDLE) {
  // Remove stale target if it somehow exists
  if (fs.existsSync(NEW_BUNDLE)) {
    fs.rmSync(NEW_BUNDLE, { recursive: true });
  }
  fs.renameSync(bundle, NEW_BUNDLE);
}
const b = NEW_BUNDLE;

// ── Rename main binary ──

const macosDir = path.join(b, "Contents/MacOS");
const newBin = path.join(macosDir, APP_NAME);
if (!fs.existsSync(newBin)) {
  // Find the existing binary (could be "Electron" or any previous name)
  for (const entry of fs.readdirSync(macosDir)) {
    const full = path.join(macosDir, entry);
    if (fs.statSync(full).isFile() && !entry.startsWith(".")) {
      fs.renameSync(full, newBin);
      break;
    }
  }
}

// ── Always re-apply plist patches (idempotent) ──

const plist = path.join(b, "Contents/Info.plist");
if (fs.existsSync(plist)) {
  plutil("CFBundleName", APP_NAME, plist);
  plutil("CFBundleDisplayName", APP_NAME, plist);
  plutil("CFBundleExecutable", APP_NAME, plist);
  plutil("CFBundleIdentifier", BUNDLE_ID, plist);
}

// ── Rename helper apps and their binaries ──

const fwDir = path.join(b, "Contents/Frameworks");
if (fs.existsSync(fwDir)) {
  const targetPrefix = `${APP_NAME} Helper`;
  for (const entry of fs.readdirSync(fwDir)) {
    if (!entry.endsWith(".app")) continue;
    // Skip already-rebranded helpers
    if (entry.startsWith(targetPrefix)) continue;
    // Match "Electron Helper*.app" or any previously-rebranded "*Helper*.app"
    if (!entry.includes("Helper")) continue;

    const helperDir = path.join(fwDir, entry);
    // Determine suffix (e.g. " (GPU)", " (Renderer)", " (Plugin)")
    const helperMatch = entry.match(/Helper(.*)\.app$/);
    const suffix = helperMatch ? helperMatch[1] : "";
    const newName = `${APP_NAME} Helper${suffix}`;

    // Rename binary
    const helperMacosDir = path.join(helperDir, "Contents/MacOS");
    if (fs.existsSync(helperMacosDir)) {
      for (const bin of fs.readdirSync(helperMacosDir)) {
        const oldHBin = path.join(helperMacosDir, bin);
        const newHBin = path.join(helperMacosDir, newName);
        if (oldHBin !== newHBin && fs.statSync(oldHBin).isFile()) {
          fs.renameSync(oldHBin, newHBin);
          break;
        }
      }
    }

    // Patch helper plist
    const hPlist = path.join(helperDir, "Contents/Info.plist");
    if (fs.existsSync(hPlist)) {
      plutil("CFBundleExecutable", newName, hPlist);
      plutil("CFBundleName", newName, hPlist);
    }

    // Rename helper .app directory
    const newHelperDir = path.join(fwDir, `${newName}.app`);
    if (!fs.existsSync(newHelperDir)) {
      fs.renameSync(helperDir, newHelperDir);
    }
  }
}

// ── Always re-copy icon ──

const srcIcon = path.join(ROOT, "app/icon.icns");
const dstIcon = path.join(b, "Contents/Resources/electron.icns");
if (fs.existsSync(srcIcon)) {
  fs.copyFileSync(srcIcon, dstIcon);
}

// ── Always re-write InfoPlist.strings ──

const enLproj = path.join(b, "Contents/Resources/en.lproj");
fs.mkdirSync(enLproj, { recursive: true });
fs.writeFileSync(
  path.join(enLproj, "InfoPlist.strings"),
  `"CFBundleName" = "${APP_NAME}";\n"CFBundleDisplayName" = "${APP_NAME}";\n`,
);

// ── Update path.txt so `npx electron` still works ──

fs.writeFileSync(
  path.join(ROOT, "node_modules/electron/path.txt"),
  `${APP_NAME}.app/Contents/MacOS/${APP_NAME}`,
);

// ── Force macOS to re-read bundle metadata ──

lsregister(b);

// ── Ensure Spotlight/Raycast launcher ──

ensureSpotlightApp();

console.log(`Rebranded Electron → ${APP_NAME}`);
