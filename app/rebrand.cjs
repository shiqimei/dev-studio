#!/usr/bin/env node
/**
 * Rebrand the stock Electron.app bundle so macOS shows "Claude Code ACP"
 * in the dock, Activity Monitor, and everywhere else.
 *
 * Run before launching Electron: node app/rebrand.js
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const APP_NAME = "Claude Code ACP";
const BUNDLE_ID = "com.isoform.claude-code-acp";
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "node_modules/electron/dist");
const OLD_BUNDLE = path.join(DIST, "Electron.app");
const NEW_BUNDLE = path.join(DIST, `${APP_NAME}.app`);

function plutil(key, value, plist) {
  execFileSync("plutil", ["-replace", key, "-string", value, plist]);
}

// Already rebranded?
if (
  fs.existsSync(NEW_BUNDLE) &&
  fs.existsSync(path.join(NEW_BUNDLE, `Contents/MacOS/${APP_NAME}`))
) {
  process.exit(0);
}

const bundle = fs.existsSync(OLD_BUNDLE) ? OLD_BUNDLE : NEW_BUNDLE;
if (!fs.existsSync(bundle)) {
  console.error("Electron.app not found at", DIST);
  process.exit(1);
}

// 1. Rename bundle directory
if (bundle === OLD_BUNDLE && !fs.existsSync(NEW_BUNDLE)) {
  fs.renameSync(OLD_BUNDLE, NEW_BUNDLE);
}
const b = NEW_BUNDLE;

// 2. Rename main binary
const oldBin = path.join(b, "Contents/MacOS/Electron");
const newBin = path.join(b, `Contents/MacOS/${APP_NAME}`);
if (fs.existsSync(oldBin) && !fs.existsSync(newBin)) {
  fs.renameSync(oldBin, newBin);
}

// 3. Patch main Info.plist
const plist = path.join(b, "Contents/Info.plist");
if (fs.existsSync(plist)) {
  plutil("CFBundleName", APP_NAME, plist);
  plutil("CFBundleDisplayName", APP_NAME, plist);
  plutil("CFBundleExecutable", APP_NAME, plist);
  plutil("CFBundleIdentifier", BUNDLE_ID, plist);
}

// 4. Rename helper apps and their binaries
const fwDir = path.join(b, "Contents/Frameworks");
if (fs.existsSync(fwDir)) {
  for (const entry of fs.readdirSync(fwDir)) {
    if (!entry.startsWith("Electron Helper") || !entry.endsWith(".app")) continue;
    const suffix = entry.slice("Electron Helper".length, -".app".length);
    const newName = `${APP_NAME} Helper${suffix}`;
    const helperDir = path.join(fwDir, entry);

    // Rename binary
    const oldHBin = path.join(helperDir, `Contents/MacOS/Electron Helper${suffix}`);
    const newHBin = path.join(helperDir, `Contents/MacOS/${newName}`);
    if (fs.existsSync(oldHBin) && !fs.existsSync(newHBin)) {
      fs.renameSync(oldHBin, newHBin);
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

// 5. Copy icon
const srcIcon = path.join(ROOT, "app/icon.icns");
const dstIcon = path.join(b, "Contents/Resources/electron.icns");
if (fs.existsSync(srcIcon)) {
  fs.copyFileSync(srcIcon, dstIcon);
}

// 6. Write InfoPlist.strings
const enLproj = path.join(b, "Contents/Resources/en.lproj");
fs.mkdirSync(enLproj, { recursive: true });
fs.writeFileSync(
  path.join(enLproj, "InfoPlist.strings"),
  `"CFBundleName" = "${APP_NAME}";\n"CFBundleDisplayName" = "${APP_NAME}";\n`,
);

// 7. Update path.txt so `npx electron` still works
fs.writeFileSync(
  path.join(ROOT, "node_modules/electron/path.txt"),
  `${APP_NAME}.app/Contents/MacOS/${APP_NAME}`,
);

// 8. Force macOS to re-read bundle metadata
try {
  execFileSync(
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
    ["-f", b],
  );
} catch { /* ignore on non-macOS */ }

console.log(`Rebranded Electron → ${APP_NAME}`);
