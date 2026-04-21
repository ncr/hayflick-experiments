#!/usr/bin/env node
// Sweep many viewports × scenes × rotations and find any 2-iso-px wide edges.
// A "2-iso-px wide edge" at zoom=Z is a white/colored run of width 2*Z screen pixels.
import { chromium } from "@playwright/test";
import { PNG } from "pngjs";
import { readFileSync, writeFileSync } from "node:fs";

const port = 5174;
const zoom = 3;

const viewports = [
  [805, 603],
  [1280, 800],
  [1024, 768],
  [1600, 900],
  [1920, 1080],
  [1440, 900],
  [800, 600],
  [1366, 768],
  [1500, 900],
  [900, 700],
  [640, 480],
  [1000, 700]
];

const testCases = [
  // scene, axis, size, stride, rotE
  { scene: "strip", params: "" },
  { scene: "grid", params: "&outlineGridAxis=diag&outlineGridSize=3&outlineGridStride=1", rotE: 0 },
  { scene: "grid", params: "&outlineGridAxis=diag&outlineGridSize=3&outlineGridStride=1", rotE: 1 },
  { scene: "grid", params: "&outlineGridAxis=x&outlineGridSize=3&outlineGridStride=1", rotE: 0 },
  { scene: "grid", params: "&outlineGridAxis=x&outlineGridSize=3&outlineGridStride=2", rotE: 0 },
  { scene: "room", params: "", rotE: 0 }
];

const issues = [];
const BAD_WIDTH = 2 * zoom; // 2 iso-px = 6 screen px
const GOOD_WIDTH = zoom;    // 1 iso-px = 3 screen px
const MULTI_ISO_THRESHOLD = 1.5 * zoom; // widths >= 1.5 iso-px count as fat

const browser = await chromium.launch({
  args: ["--ignore-gpu-blocklist", "--enable-unsafe-webgpu"]
});

for (const [vpw, vph] of viewports) {
  const context = await browser.newContext({ viewport: { width: vpw, height: vph } });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("[perr]", e.message));

  for (const { scene, params, rotE = 0 } of testCases) {
    const url =
      `http://localhost:${port}/?outlineDebug=5&outlineZoom=${zoom}` +
      `&outlineTileset=greek_island_white&outlineScene=${scene}&outlineMask=1${params}` +
      `#/exp/outline-walls`;
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    await page.waitForSelector(".stage-host canvas", { timeout: 20_000 });
    await page.waitForTimeout(1000);
    for (let i = 0; i < rotE; i++) { await page.keyboard.press("KeyE"); await page.waitForTimeout(300); }
    if (rotE) await page.waitForTimeout(500);
    const buf = await page.screenshot({ type: "png" });
    const img = PNG.sync.read(buf);

    // Find fat edges (>= 1.5 iso-px) in several rows of the mesh body.
    const fatRuns = [];
    const rows = [];
    const top = Math.round(img.height * 0.4);
    const bottom = Math.round(img.height * 0.7);
    for (let y = top; y <= bottom; y += 10) rows.push(y);

    for (const y of rows) {
      let runStart = -1;
      for (let x = 0; x < img.width; x++) {
        const i = (y * img.width + x) * 4;
        const white = img.data[i] > 200 && img.data[i+1] > 200 && img.data[i+2] > 200;
        if (white) {
          if (runStart === -1) runStart = x;
        } else {
          if (runStart !== -1) {
            const w = x - runStart;
            if (w >= MULTI_ISO_THRESHOLD && runStart > 50 && x < img.width - 50) {
              fatRuns.push(`y=${y} x=${runStart} w=${w}`);
            }
            runStart = -1;
          }
        }
      }
    }

    const tag = `${vpw}x${vph} scene=${scene} rotE=${rotE} params=${params.slice(0, 30)}`;
    if (fatRuns.length > 0) {
      issues.push({ tag, runs: fatRuns.slice(0, 5), url });
      writeFileSync(`/tmp/fail-${scene}-${vpw}x${vph}-rotE${rotE}.png`, buf);
      console.log(`❌ ${tag}\n   ${fatRuns.slice(0, 3).join("\n   ")}`);
    } else {
      console.log(`✓ ${tag}`);
    }
  }

  await context.close();
}

await browser.close();

console.log(`\n=== SUMMARY ===`);
console.log(`Issues: ${issues.length}`);
for (const { tag, runs } of issues) {
  console.log(`- ${tag}: ${runs.length} fat run(s), first: ${runs[0]}`);
}
