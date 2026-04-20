// Count the normal-edge pixels row-by-row in the post-processed low-res buffer.
// Uses window.__outlineLow__ exposed by the experiment when ?outlineReadback=1.
import { chromium } from "@playwright/test";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:5173";
const DEBUG = process.env.DEBUG ?? "7"; // 7=normalEdge, 6=depthEdge, 5=edge
const ZOOM = process.env.ZOOM ?? "1";
const URL = `${BASE}/?outlineDebug=${DEBUG}&outlineZoom=${ZOOM}&outlineReadback=1#/exp/outline-walls`;

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--ignore-gpu-blocklist"]
});
const page = await (await browser.newContext({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1
})).newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(2500);

const numQ = Number(process.env.ROTATE_Q ?? "0") | 0;
for (let i = 0; i < numQ; i++) {
  await page.keyboard.press("KeyQ");
  await page.waitForTimeout(400);
}
if (numQ > 0) await page.waitForTimeout(400);

const low = await page.evaluate(() => (window).__outlineLow__);
if (!low) throw new Error("No readback");
const { width, height, pixels } = low;

// Mode 7: normalEdge is green (0, 255, 0). Mode 6: depthEdge is red (255, 0, 0).
const threshold = 128;
const isHit = DEBUG === "7" ? (r, g, b) => g >= threshold && r < 100 && b < 100
                            : (r, g, b) => r >= threshold && g < 100 && b < 100;

// Flip Y for WebGL (first row in buffer is bottom-left)
const getPx = (x, y) => {
  const o = ((height - 1 - y) * width + x) << 2;
  return [pixels[o], pixels[o + 1], pixels[o + 2]];
};

const rows = [];
let yMin = Infinity, yMax = -Infinity;
for (let y = 0; y < height; y++) {
  const hits = [];
  for (let x = 0; x < width; x++) {
    const [r, g, b] = getPx(x, y);
    if (isHit(r, g, b)) hits.push(x);
  }
  if (hits.length > 0) {
    rows.push({ y, hits });
    yMin = Math.min(yMin, y);
    yMax = Math.max(yMax, y);
  }
}

// For each column, count how many y-rows are hit. For a diagonal 2:1 staircase
// the dominant count should be 1 (staircase is 1 pixel tall per column). If we
// see many columns with 2+, the line is thicker than 1 pixel.
const colY = new Map(); // x -> Set of y
for (const r of rows) for (const x of r.hits) {
  if (!colY.has(x)) colY.set(x, new Set());
  colY.get(x).add(r.y);
}
// Histogram of column-height
const hist = new Map();
let vertRuns = 0;
let thickCols = 0;
for (const [x, ys] of colY.entries()) {
  const arr = [...ys].sort((a, b) => a - b);
  // Compute longest run of consecutive ys.
  let longest = 1, cur = 1;
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] === arr[i - 1] + 1) cur++;
    else { longest = Math.max(longest, cur); cur = 1; }
  }
  longest = Math.max(longest, cur);
  hist.set(longest, (hist.get(longest) ?? 0) + 1);
  if (longest >= 8) vertRuns++;
  else if (longest >= 2) thickCols++;
}
console.log(`mode=${DEBUG} rotate=${numQ} cols=${colY.size} thick(2..7)=${thickCols} vertical(>=8)=${vertRuns}`);
console.log(`  longestRunPerCol histogram: ${[...hist.entries()].sort((a,b)=>a[0]-b[0]).map(([k,v])=>`${k}:${v}`).join("  ")}`);

await browser.close();
