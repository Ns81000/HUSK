/**
 * Regenerates the PWA PNG icons from the hexagon mark geometry using the
 * installed Playwright Chromium. Run from the repo root:
 * node tools/generate-icons.mjs
 *
 * The hexagon is drawn at explicit pixel sizes (never the SVG's intrinsic
 * width/height attributes, which previously overran the canvas).
 *
 *   husk-icon-<n>.png        transparent background, hexagon at 78% height
 *   husk-maskable-<n>.png    full-bleed #172112, hexagon inside the 80% mask
 *                            safe circle (corner distance ~0.34 * size)
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const outDir = resolve(root, "public/icons");
mkdirSync(outDir, { recursive: true });

const HEX = "#3ce767";
const BG = "#172112";
// Hexagon geometry: width 84, height 96 (width = height * 7/8).
const POLYGON = 'points="42,0 84,24 84,72 42,96 0,72 0,24"';

function hexSvg(width, height) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 84 96" ` +
    `width="${width}" height="${height}"><polygon ${POLYGON} fill="${HEX}"/></svg>`
  );
}

function pageFor(size, background, inner) {
  return `<!doctype html><html><head><style>
    html, body { margin: 0; padding: 0; background: ${background}; }
    .canvas { position: relative; width: ${size}px; height: ${size}px; background: ${background}; }
    .mark { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); }
  </style></head><body><div class="canvas"><div class="mark">${inner}</div></div></body></html>`;
}

/** Transparent icons: hexagon centered, 78% of the canvas height. */
async function transparentIcon(browser, size) {
  const height = Math.round(size * 0.78);
  const width = Math.round((height * 84) / 96);
  const page = await browser.newPage();
  await page.setContent(pageFor(size, "transparent", hexSvg(width, height)));
  await page.screenshot({
    path: resolve(outDir, `husk-icon-${size}.png`),
    omitBackground: true,
    clip: { x: 0, y: 0, width: size, height: size },
  });
  await page.close();
}

/** Maskable icons: full-bleed background, hexagon at 68% height (safe area). */
async function maskableIcon(browser, size) {
  const height = Math.round(size * 0.68);
  const width = Math.round((height * 84) / 96);
  const page = await browser.newPage();
  await page.setContent(pageFor(size, BG, hexSvg(width, height)));
  await page.screenshot({
    path: resolve(outDir, `husk-maskable-${size}.png`),
    clip: { x: 0, y: 0, width: size, height: size },
  });
  await page.close();
}

const browser = await chromium.launch();
await transparentIcon(browser, 192);
await transparentIcon(browser, 512);
await maskableIcon(browser, 192);
await maskableIcon(browser, 512);
await browser.close();
console.log("icons regenerated");
