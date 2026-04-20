// Analyze the outline shader output for 2:1 staircase correctness.
// Walks through the screenshot at zoom=8 and reports: for each row,
// the x-coordinate of the leftmost red outline pixel. A perfect 2:1
// staircase has the x coord changing by exactly 2 (low-res pixels) for
// every 1 (low-res pixel) change in y.
import { PNG } from "pngjs";
import fs from "node:fs";

const PATH = process.argv[2] ?? "/tmp/outline-z8.png";
const ZOOM = Number(process.env.ZOOM ?? "8");
// Red-ish threshold: R>=200, G<=80, B<=80
const isRed = (r, g, b) => r >= 200 && g <= 100 && b <= 100;

const buf = fs.readFileSync(PATH);
const png = PNG.sync.read(buf);
const { width, height, data } = png;

function px(x, y) {
  const o = (y * width + x) << 2;
  return [data[o], data[o + 1], data[o + 2]];
}

// Find all red pixels
const redRows = new Map(); // y (output pixel) -> Set of x
for (let y = 0; y < height; y++) {
  const xs = [];
  for (let x = 0; x < width; x++) {
    const [r, g, b] = px(x, y);
    if (isRed(r, g, b)) xs.push(x);
  }
  if (xs.length > 0) redRows.set(y, xs);
}

const minY = Math.min(...redRows.keys());
const maxY = Math.max(...redRows.keys());
const firstXPerY = [];
for (let y = minY; y <= maxY; y++) {
  const xs = redRows.get(y);
  if (!xs) continue;
  firstXPerY.push({ y, xMin: xs[0], xMax: xs[xs.length - 1], count: xs.length });
}

console.log(`red pixels span y=${minY}..${maxY} (${firstXPerY.length} rows have red)`);
console.log(`output width=${width} height=${height} zoom=${ZOOM}`);

// Group consecutive rows of equal low-res row (i.e., divide y by zoom)
// to collapse the output pixel staircase down to low-res pixel steps.
const lowResSteps = []; // { yLow, xMinLow, xMaxLow }
let cur = null;
for (const row of firstXPerY) {
  const yLow = Math.floor(row.y / ZOOM);
  if (!cur || cur.yLow !== yLow) {
    if (cur) lowResSteps.push(cur);
    cur = { yLow, xMinLow: row.xMin / ZOOM, xMaxLow: row.xMax / ZOOM, outputYs: [] };
  }
  cur.outputYs.push(row.y);
  cur.xMinLow = Math.min(cur.xMinLow, row.xMin / ZOOM);
  cur.xMaxLow = Math.max(cur.xMaxLow, row.xMax / ZOOM);
}
if (cur) lowResSteps.push(cur);

console.log(`\nAfter collapsing to low-res rows: ${lowResSteps.length} rows`);
console.log(`First 20 rows (yLow, xMinLow, xMaxLow):`);
for (const s of lowResSteps.slice(0, 20)) {
  console.log(`  y=${s.yLow}  xMin=${s.xMinLow.toFixed(2)}  xMax=${s.xMaxLow.toFixed(2)}`);
}

// For the TOP-LEFT edge of the silhouette (first 30 or so rows), check whether
// xMinLow advances by ~2 per row (the expected iso 2:1 slope in low-res).
console.log(`\nSlope check (top-left silhouette):`);
const topSlopes = [];
for (let i = 1; i < Math.min(40, lowResSteps.length); i++) {
  const dx = lowResSteps[i].xMinLow - lowResSteps[i - 1].xMinLow;
  const dy = lowResSteps[i].yLow - lowResSteps[i - 1].yLow;
  if (dy !== 0) topSlopes.push(dx / dy);
  console.log(
    `  y=${lowResSteps[i - 1].yLow}->${lowResSteps[i].yLow}  xMin ${lowResSteps[i - 1].xMinLow.toFixed(1)}->${lowResSteps[i].xMinLow.toFixed(1)}  dx/dy=${dy ? (dx / dy).toFixed(2) : "∞"}`
  );
}

// Count the number of low-res rows that have an outline pixel at xMin = previous - 2
// versus other step sizes.
const stepCounts = new Map();
for (let i = 1; i < lowResSteps.length; i++) {
  const prev = lowResSteps[i - 1];
  const cur2 = lowResSteps[i];
  const dx = cur2.xMinLow - prev.xMinLow;
  const dy = cur2.yLow - prev.yLow;
  if (dy === 1) {
    const key = dx.toFixed(1);
    stepCounts.set(key, (stepCounts.get(key) ?? 0) + 1);
  }
}
console.log(`\nFor consecutive low-res rows (dy=1), dx histogram:`);
for (const [k, v] of [...stepCounts.entries()].sort()) {
  console.log(`  dx=${k}: ${v}`);
}

// Also width of outline: how many output pixels wide is a "run"?
// For each y-row, after grouping consecutive x, each run should be a
// contiguous stretch of exactly ZOOM output pixels (1 low-res pixel wide).
console.log(`\nOutline width (output pixels) histogram (at y=minY+ZOOM*5 as sample):`);
const sampleY = minY + ZOOM * 5;
const xs = redRows.get(sampleY) ?? [];
const runs = [];
if (xs.length > 0) {
  let runStart = xs[0];
  let prev = xs[0];
  for (let k = 1; k < xs.length; k++) {
    if (xs[k] === prev + 1) {
      prev = xs[k];
    } else {
      runs.push({ start: runStart, len: prev - runStart + 1 });
      runStart = xs[k];
      prev = xs[k];
    }
  }
  runs.push({ start: runStart, len: prev - runStart + 1 });
}
console.log(`  sample row y=${sampleY} has ${runs.length} runs: ${runs.map((r) => `${r.start}:${r.len}`).join(", ")}`);
console.log(`  => run lengths (output pixels): ${runs.map((r) => r.len).join(", ")}`);
console.log(`  => run lengths / zoom: ${runs.map((r) => (r.len / ZOOM).toFixed(2)).join(", ")}`);
