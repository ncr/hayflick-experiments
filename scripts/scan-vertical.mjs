#!/usr/bin/env node
// Scan a vertical column at given x (or a small band) and list all
// y-positions where green pixels occur. Report the runs of green/nongreen
// and the gap sizes between them.
import { PNG } from "pngjs";
import { readFileSync } from "node:fs";

const path = process.argv[2];
const x = Number(process.argv[3]);
const y0 = Number(process.argv[4] ?? 0);
const y1 = Number(process.argv[5] ?? 9999);

const png = PNG.sync.read(readFileSync(path));
const { width, height, data } = png;

const isGreen = (x, y) => {
  if (x < 0 || y < 0 || x >= width || y >= height) return false;
  const i = (y * width + x) * 4;
  const r = data[i], g = data[i+1], b = data[i+2];
  return g > 80 && g > r + 30 && g > b + 30;
};

const ymax = Math.min(height - 1, y1);
const greenRuns = [];
let cur = null;
for (let y = y0; y <= ymax; y++) {
  if (isGreen(x, y)) {
    if (!cur) cur = { y0: y, y1: y };
    else cur.y1 = y;
  } else {
    if (cur) { greenRuns.push(cur); cur = null; }
  }
}
if (cur) greenRuns.push(cur);

console.log(`At column x=${x}:`);
for (let i = 0; i < greenRuns.length; i++) {
  const r = greenRuns[i];
  const h = r.y1 - r.y0 + 1;
  console.log(`  green run #${i+1}: y=${r.y0}..${r.y1} (${h} rows)`);
  if (i + 1 < greenRuns.length) {
    const next = greenRuns[i+1];
    const gap = next.y0 - r.y1 - 1;
    console.log(`    gap to next: ${gap} rows`);
  }
}
