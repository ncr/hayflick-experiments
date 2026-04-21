#!/usr/bin/env node
// Scan for paired horizontal lines at glass tops in normal-edge view.
// A glass-top pair looks like two short horizontal runs with N rows of black
// between them, both at similar x-ranges.
import { PNG } from "pngjs";
import { readFileSync } from "node:fs";

const path = process.argv[2];
const buf = readFileSync(path);
const png = PNG.sync.read(buf);
const { width, height, data } = png;

const isGreen = (x, y) => {
  if (x < 0 || y < 0 || x >= width || y >= height) return false;
  const i = (y * width + x) * 4;
  const r = data[i], g = data[i+1], b = data[i+2];
  return g > 80 && g > r + 30 && g > b + 30;
};

// For each column x, find y-rows with green that could be horizontal-line row.
// Report per-row: y, green-pixel count in a horizontal window centered on some x.

// Find "horizontal runs" of consecutive green pixels (length >= 6 to filter noise)
const runs = [];
for (let y = 0; y < height; y++) {
  let start = -1;
  for (let x = 0; x < width; x++) {
    const g = isGreen(x, y);
    if (g && start === -1) start = x;
    if (!g && start !== -1) {
      if (x - start >= 4 && x - start <= 60) runs.push({ y, x0: start, x1: x - 1, len: x - start });
      start = -1;
    }
  }
  if (start !== -1 && width - start >= 4 && width - start <= 60) runs.push({ y, x0: start, x1: width - 1, len: width - start });
}

// Group runs into pairs: same x-range (within 4 px tolerance), y within 5 rows.
const pairs = [];
for (let i = 0; i < runs.length; i++) {
  for (let j = i + 1; j < runs.length; j++) {
    const a = runs[i], b = runs[j];
    if (b.y - a.y > 6 || b.y - a.y < 1) continue;
    if (Math.abs(a.x0 - b.x0) > 4) continue;
    if (Math.abs(a.x1 - b.x1) > 4) continue;
    pairs.push({ a, b, gap: b.y - a.y - 1, midX: (a.x0 + a.x1) / 2, midY: (a.y + b.y) / 2 });
  }
}

console.log(`${pairs.length} paired short horizontal runs:`);
for (const p of pairs) {
  console.log(`  y1=${p.a.y}  y2=${p.b.y}  gap=${p.gap}  x=${p.a.x0}-${p.a.x1}  mid=(${p.midX.toFixed(0)},${p.midY.toFixed(0)})`);
}
