// Read the raw post-processed low-res texture from window.__outlineLow__ and
// verify: (1) the outline is exactly 1 pixel wide, (2) diagonal edges form
// perfect 2:1 staircases, (3) no interior vertical seam between wall segments.
import { chromium } from "@playwright/test";
import fs from "node:fs";
import { PNG } from "pngjs";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:5173";
const ZOOM = process.env.ZOOM ?? "1";
const DEBUG = process.env.DEBUG ?? "0"; // 0=final, 5=edgeOnly
const MASK = process.env.MASK ?? "1";
const GROUPS = process.env.GROUPS ?? "shared"; // "shared" | "split"
const STAGGER = process.env.STAGGER ?? "0"; // "1" pushes middle wall +Z
const URL = `${BASE}/?outlineDebug=${DEBUG}&outlineZoom=${ZOOM}&outlineMask=${MASK}&outlineGroups=${GROUPS}&outlineStagger=${STAGGER}&outlineReadback=1#/exp/outline-walls`;
const SAVE_PNG = process.argv[2]; // optional: dump low-res as PNG

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--ignore-gpu-blocklist"]
});
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1
});
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(2500);

const numQ = Number(process.env.ROTATE_Q ?? "0") | 0;
const numE = Number(process.env.ROTATE_E ?? "0") | 0;
for (let i = 0; i < numQ; i++) {
  await page.keyboard.press("KeyQ");
  await page.waitForTimeout(400);
}
for (let i = 0; i < numE; i++) {
  await page.keyboard.press("KeyE");
  await page.waitForTimeout(400);
}
if (numQ + numE > 0) await page.waitForTimeout(400);

const low = await page.evaluate(() => (window).__outlineLow__);
if (!low) {
  console.error("No __outlineLow__ found — did render loop run?");
  process.exit(1);
}

const { width, height, pixels } = low;
const getRGBA = (x, y) => {
  const o = ((height - 1 - y) * width + x) << 2; // WebGL Y is flipped
  return [pixels[o], pixels[o + 1], pixels[o + 2], pixels[o + 3]];
};

const isRed = (r, g, b) => r >= 200 && g <= 100 && b <= 100;

if (SAVE_PNG) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = getRGBA(x, y);
      const o = (y * width + x) << 2;
      png.data[o] = r;
      png.data[o + 1] = g;
      png.data[o + 2] = b;
      png.data[o + 3] = a;
    }
  }
  fs.writeFileSync(SAVE_PNG, PNG.sync.write(png));
  console.log(`Saved low-res PNG ${width}x${height} -> ${SAVE_PNG}`);
}

// For each Y row, find the leftmost and rightmost red pixels.
console.log(`low-res ${width}x${height}`);
const leftmost = [];
const rightmost = [];
const allRedByY = new Map();
for (let y = 0; y < height; y++) {
  const redXs = [];
  for (let x = 0; x < width; x++) {
    const [r, g, b] = getRGBA(x, y);
    if (isRed(r, g, b)) redXs.push(x);
  }
  if (redXs.length > 0) {
    leftmost.push({ y, x: redXs[0] });
    rightmost.push({ y, x: redXs[redXs.length - 1] });
    allRedByY.set(y, redXs);
  }
}

if (leftmost.length === 0) {
  console.log("No red pixels found in low-res image!");
  await browser.close();
  process.exit(0);
}

const yMin = leftmost[0].y;
const yMax = leftmost[leftmost.length - 1].y;
console.log(`Red spans y=${yMin}..${yMax}, total rows with red = ${leftmost.length}`);

// Pixel-width check: for each Y row, split red into runs and report run lengths.
console.log("\nRun lengths per row (shows outline width in low-res px):");
const runLenHist = new Map();
for (const [y, xs] of allRedByY.entries()) {
  let runStart = xs[0];
  let prev = xs[0];
  const runs = [];
  for (let i = 1; i < xs.length; i++) {
    if (xs[i] === prev + 1) {
      prev = xs[i];
    } else {
      runs.push(prev - runStart + 1);
      runStart = xs[i];
      prev = xs[i];
    }
  }
  runs.push(prev - runStart + 1);
  for (const r of runs) {
    runLenHist.set(r, (runLenHist.get(r) ?? 0) + 1);
  }
}
console.log([...runLenHist.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `  len=${k}: ${v} runs`).join("\n"));

// Staircase check: for TOP-LEFT silhouette edge (upper half), how does
// leftmost x advance per row?
console.log("\nTop-left silhouette: dx per step (should be 0 or ±2 for perfect 2:1):");
const topHalf = leftmost.filter((p) => p.y <= yMin + Math.floor((yMax - yMin) / 2));
let stepCounts = new Map();
for (let i = 1; i < topHalf.length; i++) {
  const dx = topHalf[i].x - topHalf[i - 1].x;
  const dy = topHalf[i].y - topHalf[i - 1].y;
  const key = `${dx}/${dy}`;
  stepCounts.set(key, (stepCounts.get(key) ?? 0) + 1);
}
console.log([...stepCounts.entries()].sort().map(([k, v]) => `  dx/dy=${k}: ${v} times`).join("\n"));

// Look at the exact first 40 steps for visualization:
console.log("\nFirst 40 rows (y, xMin, xMax):");
for (let i = 0; i < Math.min(40, leftmost.length); i++) {
  const y = leftmost[i].y;
  const rxs = allRedByY.get(y);
  console.log(`  y=${y}  xMin=${rxs[0]}  xMax=${rxs[rxs.length - 1]}  runs=${(() => {
    let rs = "";
    let s = rxs[0], p = rxs[0];
    for (let k = 1; k < rxs.length; k++) {
      if (rxs[k] === p + 1) { p = rxs[k]; }
      else { rs += `[${s}..${p}] `; s = rxs[k]; p = rxs[k]; }
    }
    rs += `[${s}..${p}]`;
    return rs;
  })()}`);
}

// Horizontal slice check: check for vertical seams between walls.
// At a fixed Y in the middle of the front face, count red runs. If the id
// mask is working there should be very few red runs (just the silhouette
// boundaries and the right internal edge).
const midY = Math.floor((yMin + yMax) / 2);
const midXs = allRedByY.get(midY);
if (midXs) {
  console.log(`\nMid-height y=${midY} red runs: ${midXs.length} red pixels`);
  let runs = [];
  let s = midXs[0], p = midXs[0];
  for (let k = 1; k < midXs.length; k++) {
    if (midXs[k] === p + 1) p = midXs[k];
    else { runs.push([s, p]); s = midXs[k]; p = midXs[k]; }
  }
  runs.push([s, p]);
  console.log(`  ${runs.length} runs: ${runs.map(([a, b]) => `[${a}..${b}]`).join(" ")}`);
}

await browser.close();
