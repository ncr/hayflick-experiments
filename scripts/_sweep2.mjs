#!/usr/bin/env node
// Smarter sweep: detect VERTICAL LINES (same x, consecutive rows) that are
// wider than 1 iso-px. Ignore diagonal staircases (where a single row of a
// sloped line reads as a fat horizontal run).
import { chromium } from "@playwright/test";
import { PNG } from "pngjs";
import { writeFileSync } from "node:fs";

const port = 5174;
const zoom = 3;
const ISO_WIDTH_PX = zoom;
const FAT_WIDTH_PX = 2 * zoom;
const VERTICAL_RUN_MIN = 3 * zoom; // a "vertical line" must be >= 3 iso-px tall

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
  { scene: "strip", params: "", rotE: 0 },
  { scene: "grid", params: "&outlineGridAxis=diag&outlineGridSize=3&outlineGridStride=1", rotE: 1 },
  { scene: "grid", params: "&outlineGridAxis=x&outlineGridSize=3&outlineGridStride=2", rotE: 0 },
  { scene: "room", params: "", rotE: 0 }
];

function findFatVerticals(img) {
  const { width, height, data } = data_from(img);
  // For each pixel, check if it's white. Build a 2D map.
  const white = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const w = img.data[i] > 150 || img.data[i+1] > 150 || img.data[i+2] > 150;
      white[y * width + x] = w ? 1 : 0;
    }
  }
  // For each x, find vertical runs of consecutive white rows.
  // Then check if the next column is also white for enough rows.
  const fatRuns = [];
  // Skip the UI header area (title + description text lives in the top ~150px)
  const TOP_SKIP = 200;
  for (let x = 100; x < width - 100; x++) {
    let y = TOP_SKIP;
    while (y < height - 100) {
      if (white[y * width + x]) {
        // Find end of vertical run in this column
        let yEnd = y;
        while (yEnd < height - 100 && white[yEnd * width + x]) yEnd++;
        const runLen = yEnd - y;
        if (runLen >= VERTICAL_RUN_MIN) {
          // Check if columns x+1, x+2, ... are also white for this range
          let fatWidth = 1;
          for (let xOff = 1; xOff < 10; xOff++) {
            let allWhite = true;
            for (let yy = y; yy < yEnd; yy++) {
              if (!white[yy * width + (x + xOff)]) { allWhite = false; break; }
            }
            if (allWhite) fatWidth++;
            else break;
          }
          if (fatWidth >= 2 * ISO_WIDTH_PX) {
            // It's a vertical line at least 2 iso-cols wide. Bad.
            fatRuns.push({ x, y, yEnd, fatWidth });
            y = yEnd;
            x += fatWidth - 1;
            continue;
          }
          y = yEnd;
          continue;
        }
        y = yEnd;
      } else {
        y++;
      }
    }
  }
  return fatRuns;
}

function data_from(img) {
  return { width: img.width, height: img.height, data: img.data };
}

const browser = await chromium.launch({
  args: ["--ignore-gpu-blocklist", "--enable-unsafe-webgpu"]
});

const issues = [];

for (const [vpw, vph] of viewports) {
  const context = await browser.newContext({ viewport: { width: vpw, height: vph } });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("[perr]", e.message));

  for (const { scene, params, rotE } of testCases) {
    const url =
      `http://localhost:${port}/?outlineDebug=7&outlineZoom=${zoom}` +
      `&outlineTileset=greek_island_white&outlineScene=${scene}&outlineMask=1${params}` +
      `#/exp/outline-walls`;
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    await page.waitForSelector(".stage-host canvas", { timeout: 20_000 });
    await page.waitForTimeout(1000);
    for (let i = 0; i < rotE; i++) { await page.keyboard.press("KeyE"); await page.waitForTimeout(300); }
    if (rotE) await page.waitForTimeout(500);
    const buf = await page.screenshot({ type: "png" });
    const img = PNG.sync.read(buf);

    const fatRuns = findFatVerticals(img);
    const tag = `${vpw}x${vph} ${scene} rotE=${rotE}`;
    if (fatRuns.length > 0) {
      issues.push({ tag, runs: fatRuns, buf });
      writeFileSync(`/tmp/fail2-${scene}-${vpw}x${vph}-rotE${rotE}.png`, buf);
      const summary = fatRuns.slice(0, 3).map(r => `x=${r.x} y=${r.y}..${r.yEnd} (h=${r.yEnd-r.y}) w=${r.fatWidth}`).join(", ");
      console.log(`❌ ${tag}: ${fatRuns.length} issue(s): ${summary}`);
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
  console.log(`- ${tag}: ${runs.length}`);
}
