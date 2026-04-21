#!/usr/bin/env node
// Read back the low-res iso-pixel buffer and report iso-col white runs.
import { chromium } from "@playwright/test";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return process.argv[i + 1];
}

const port = arg("port", "5174");
const axis = arg("axis", "diag");
const size = arg("size", "3");
const rotE = Number(arg("rotE", "1"));
const rotQ = Number(arg("rotQ", "0"));
const debug = arg("debug", "5");

const zoomStr = arg("zoom", "3");
const url =
  `http://localhost:${port}/?outlineDebug=${debug}&outlineZoom=${zoomStr}&outlineTileset=greek_island_white` +
  `&outlineScene=grid&outlineMask=1&outlineGridAxis=${axis}&outlineGridSize=${size}&outlineGridStride=1` +
  `&outlineReadback=1` +
  `#/exp/outline-walls`;

const browser = await chromium.launch({
  args: ["--ignore-gpu-blocklist", "--enable-unsafe-webgpu"]
});
const vpw = Number(arg("vpw", "1280"));
const vph = Number(arg("vph", "800"));
const context = await browser.newContext({ viewport: { width: vpw, height: vph } });
const page = await context.newPage();
page.on("pageerror", (e) => console.error("[perr]", e.message));
console.log("URL:", url);
await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
await page.waitForSelector(".stage-host canvas", { timeout: 20_000 });
await page.waitForTimeout(1500);
for (let i = 0; i < rotQ; i++) { await page.keyboard.press("KeyQ"); await page.waitForTimeout(400); }
for (let i = 0; i < rotE; i++) { await page.keyboard.press("KeyE"); await page.waitForTimeout(400); }
if (rotQ || rotE) await page.waitForTimeout(600);

const data = await page.evaluate(() => {
  return window.__outlineLow__;
});
console.log("Low res:", data.width, "x", data.height);

// Find vertical line runs per row
const { width, height, pixels } = data;
const isWhite = (x, y) => {
  const i = (y * width + x) * 4;
  return pixels[i] > 200 && pixels[i+1] > 200 && pixels[i+2] > 200;
};

// Framebuffer is Y-flipped (GL convention). Let's account for that.
// Actually, readRenderTargetPixels returns pixels with origin at bottom-left.
// So to get "top row", we need y=height-1.

// Scan the middle row (where the mesh body is)
const midY = Math.floor(height / 2);
for (let y = midY - 2; y <= midY + 2; y++) {
  let runs = [];
  let runStart = -1;
  for (let x = 0; x < width; x++) {
    if (isWhite(x, y)) {
      if (runStart === -1) runStart = x;
    } else {
      if (runStart !== -1) {
        runs.push(`x=${runStart}(w=${x - runStart})`);
        runStart = -1;
      }
    }
  }
  console.log(`iso_y=${y}: ${runs.join(", ")}`);
}

// Diagnostic: sample a row and dump depth/normal/id values via extra debug modes.
// Already the edge is shown. Dump the raw center pixel values for positions near
// the LEFT silhouette to diagnose what fires.
console.log("(for detailed per-pixel, rerun with debug=2 for depth, 3 for normal, 4 for id)");

await browser.close();
