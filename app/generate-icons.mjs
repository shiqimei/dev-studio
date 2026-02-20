#!/usr/bin/env node
/**
 * generate-icons.mjs
 *
 * Generates macOS-spec app icons from assets/logo.svg.
 * Applies Apple's continuous-corner squircle mask and standard drop shadow.
 *
 * Apple macOS Icon Spec (1024×1024 canvas):
 *   - Icon body: 824×824, centered with 100px gutter
 *   - Corner radius: 185.4px (continuous-corner bezier, NOT a simple rounded rect)
 *   - Drop shadow: 28px blur radius, 12px Y offset, black 50%
 *
 * References:
 *   - https://developer.apple.com/forums/thread/670578
 *   - https://liamrosenfeld.com/posts/apple_icon_quest/
 *
 * Requires: rsvg-convert, iconutil (macOS)
 * Usage: node app/generate-icons.mjs
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const LOGO_SVG = join(ROOT, "assets/logo.svg");
const ICON_SVG = join(ROOT, "app/icon.svg");
const ICON_PNG = join(ROOT, "app/icon.png");
const ICON_ICNS = join(ROOT, "app/icon.icns");

// ─── Apple macOS Icon Spec ──────────────────────────────────────────────────────
const CANVAS = 1024;
const BODY = 824;
const GUTTER = (CANVAS - BODY) / 2; // 100
const CR = 185.4;

// Content is scaled down and centered within the squircle
const CONTENT_SCALE = 0.75;
const CONTENT_SIZE = CANVAS * CONTENT_SCALE; // 768
const CONTENT_OFFSET = (CANVAS - CONTENT_SIZE) / 2; // 128

// Background fill for squircle edges (matches logo's outer background edge color)
const BG_FILL = "#15120b";

// Drop shadow: Apple spec says 28px blur radius, 12px Y, black 50%.
// SVG feDropShadow stdDeviation ≈ blur_radius / 2.
const SHADOW_STD_DEV = 14;
const SHADOW_DY = 12;
const SHADOW_OPACITY = 0.5;

// ─── Apple continuous-corner bezier constants ───────────────────────────────────
// These define the "squircle" shape Apple uses for macOS/iOS icons.
// Unlike a simple rounded rect (rx/ry), the curvature is continuous —
// it smoothly accelerates into corners instead of abruptly transitioning.
//
// From https://liamrosenfeld.com/posts/apple_icon_quest/
// Achieves "zero pixel error" vs Apple's actual icon mask.
const K = {
  a: 1.528665, // distance from corner where curve begins (on straight edge)
  b: 1.08849296, // outer curve control point 1
  c: 0.86840694, // outer curve control point 2
  d: 0.63149379, // junction between outer and inner curve sections
  e: 0.07491139, // junction (perpendicular axis)
  f: 0.37282383, // inner curve control point
  g: 0.16905956, // inner curve control point
};

/**
 * Generate the SVG path data for Apple's continuous-corner rounded rectangle.
 *
 * Draws the path clockwise starting from the top-left straight edge:
 *   top-left → top-right → bottom-right → bottom-left → close
 *
 * Each corner has 3 cubic bezier segments:
 *   1. Outer curve (straight edge → junction point)
 *   2. Inner curve (junction → perpendicular junction)
 *   3. Exit curve (perpendicular junction → straight edge)
 */
function appleSquirclePath(ox, oy, w, h, cr) {
  // Helper: compute absolute coordinates for each corner quadrant.
  // (px, py) are relative constants scaled by corner radius.
  const tl = (px, py) => `${(ox + px * cr).toFixed(2)} ${(oy + py * cr).toFixed(2)}`;
  const tr = (px, py) => `${(ox + w - px * cr).toFixed(2)} ${(oy + py * cr).toFixed(2)}`;
  const br = (px, py) => `${(ox + w - px * cr).toFixed(2)} ${(oy + h - py * cr).toFixed(2)}`;
  const bl = (px, py) => `${(ox + px * cr).toFixed(2)} ${(oy + h - py * cr).toFixed(2)}`;

  return [
    // Start at top-left, right of corner
    `M ${tl(K.a, 0)}`,
    // ── Top edge ──
    `L ${tr(K.a, 0)}`,
    // ── Top-right corner (3 curves) ──
    `C ${tr(K.b, 0)} ${tr(K.c, 0)} ${tr(K.d, K.e)}`,
    `C ${tr(K.f, K.g)} ${tr(K.g, K.f)} ${tr(K.e, K.d)}`,
    `C ${tr(0, K.c)} ${tr(0, K.b)} ${tr(0, K.a)}`,
    // ── Right edge ──
    `L ${br(0, K.a)}`,
    // ── Bottom-right corner ──
    `C ${br(0, K.b)} ${br(0, K.c)} ${br(K.e, K.d)}`,
    `C ${br(K.g, K.f)} ${br(K.f, K.g)} ${br(K.d, K.e)}`,
    `C ${br(K.c, 0)} ${br(K.b, 0)} ${br(K.a, 0)}`,
    // ── Bottom edge ──
    `L ${bl(K.a, 0)}`,
    // ── Bottom-left corner ──
    `C ${bl(K.b, 0)} ${bl(K.c, 0)} ${bl(K.d, K.e)}`,
    `C ${bl(K.f, K.g)} ${bl(K.g, K.f)} ${bl(K.e, K.d)}`,
    `C ${bl(0, K.c)} ${bl(0, K.b)} ${bl(0, K.a)}`,
    // ── Left edge ──
    `L ${tl(0, K.a)}`,
    // ── Top-left corner ──
    `C ${tl(0, K.b)} ${tl(0, K.c)} ${tl(K.e, K.d)}`,
    `C ${tl(K.g, K.f)} ${tl(K.f, K.g)} ${tl(K.d, K.e)}`,
    `C ${tl(K.c, 0)} ${tl(K.b, 0)} ${tl(K.a, 0)}`,
    "Z",
  ].join(" ");
}

// ─── Generate ───────────────────────────────────────────────────────────────────

const squircle = appleSquirclePath(GUTTER, GUTTER, BODY, BODY, CR);

// Read logo SVG and extract inner content (everything between <svg> and </svg>)
const logoSvg = readFileSync(LOGO_SVG, "utf-8");

// Extract the viewBox from the source (default to 512x512)
const vbMatch = logoSvg.match(/viewBox="([^"]+)"/);
const logoViewBox = vbMatch ? vbMatch[1] : "0 0 512 512";

const innerContent = logoSvg.replace(/<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");

// Build icon SVG: Apple squircle clip + drop shadow + logo artwork
const iconSvg = `<svg viewBox="0 0 ${CANVAS} ${CANVAS}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <clipPath id="squircle-clip">
      <path d="${squircle}"/>
    </clipPath>
    <filter id="icon-shadow" x="-20%" y="-10%" width="140%" height="130%">
      <feDropShadow dx="0" dy="${SHADOW_DY}" stdDeviation="${SHADOW_STD_DEV}" flood-color="#000" flood-opacity="${SHADOW_OPACITY}"/>
    </filter>

  </defs>

  <!-- Icon body with Apple standard drop shadow -->
  <g filter="url(#icon-shadow)">
    <g clip-path="url(#squircle-clip)">
      <!-- Background fill for squircle area -->
      <path d="${squircle}" fill="${BG_FILL}"/>
      <!-- Logo artwork fills full canvas; its own viewBox padding aligns with the squircle -->
      <svg x="0" y="0" width="${CANVAS}" height="${CANVAS}" viewBox="${logoViewBox}">
        ${innerContent}
      </svg>
    </g>
  </g>


</svg>
`;

writeFileSync(ICON_SVG, iconSvg);
console.log(`wrote ${ICON_SVG}`);

// ─── Render PNG ─────────────────────────────────────────────────────────────────
execSync(`rsvg-convert -w ${CANVAS} -h ${CANVAS} "${ICON_SVG}" -o "${ICON_PNG}"`);
console.log(`wrote ${ICON_PNG}`);

// ─── Render ICNS ────────────────────────────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), "icon-"));
const iconset = join(tmp, "icon.iconset");
execSync(`mkdir -p "${iconset}"`);

for (const size of [16, 32, 64, 128, 256, 512]) {
  execSync(
    `rsvg-convert -w ${size} -h ${size} "${ICON_SVG}" -o "${join(iconset, `icon_${size}x${size}.png`)}"`,
  );
  execSync(
    `rsvg-convert -w ${size * 2} -h ${size * 2} "${ICON_SVG}" -o "${join(iconset, `icon_${size}x${size}@2x.png`)}"`,
  );
}

execSync(`iconutil -c icns "${iconset}" -o "${ICON_ICNS}"`);
rmSync(tmp, { recursive: true });
console.log(`wrote ${ICON_ICNS}`);

console.log("done");
