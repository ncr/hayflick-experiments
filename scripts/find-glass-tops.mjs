#!/usr/bin/env node
// Find horizontal green-pixel runs that might be glass top edges.
// A glass top edge is: a few consecutive rows where green pixels form a short horizontal stretch.
import { PNG } from "pngjs";
import { readFileSync } from "node:fs";

const path = process.argv[2] || "/home/ncr/dev/hayflick-experiments/e2e/screenshots/probe-normaledge-z4.png";
const buf = readFileSync(path);
const png = PNG.sync.read(buf);
const { width, height, data } = png;

const isGreen = (x, y) => {
  if (x < 0 || y < 0 || x >= width || y >= height) return false;
  const i = (y * width + x) * 4;
  const r = data[i], g = data[i+1], b = data[i+2];
  return g > 80 && g > r + 30 && g > b + 30;
};

// Find "runs" of consecutive horizontal green pixels in each row.
// Report runs >= 20 pixels long (likely glass top lines) with their y and x-range.
const runs = [];
for (let y = 100; y < height; y++) {
  let runStart = -1;
  for (let x = 0; x < width; x++) {
    const g = isGreen(x, y);
    if (g && runStart === -1) runStart = x;
    if (!g && runStart !== -1) {
      const len = x - runStart;
      if (len >= 10 && len <= 150) runs.push({ y, x0: runStart, x1: x - 1, len });
      runStart = -1;
    }
  }
  if (runStart !== -1) {
    const len = width - runStart;
    if (len >= 10 && len <= 150) runs.push({ y, x0: runStart, x1: width - 1, len });
  }
}

// Group runs by x-range similarity — clustered rows at same x are the "horizontal edge".
console.log(`Found ${runs.length} medium-length runs (10-150 px)`);
console.log("First 60 runs (y, x0-x1, len):");
for (const r of runs.slice(0, 60)) {
  console.log(`  y=${r.y}  x=${r.x0}-${r.x1}  len=${r.len}`);
}
