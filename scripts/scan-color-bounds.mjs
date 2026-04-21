#!/usr/bin/env node
// Find the pixel-exact top edges (first-on rows) of ID regions matching the
// given color. Report the shape of the top boundary at many x columns.
import { PNG } from "pngjs";
import { readFileSync } from "node:fs";

const path = process.argv[2];
const rTarget = Number(process.argv[3]);
const gTarget = Number(process.argv[4]);
const bTarget = Number(process.argv[5]);
const tol = Number(process.argv[6] ?? 30);

const png = PNG.sync.read(readFileSync(path));
const { width, height, data } = png;

const near = (x, y) => {
  if (x < 0 || y < 0 || x >= width || y >= height) return false;
  const i = (y * width + x) * 4;
  return Math.abs(data[i] - rTarget) < tol &&
         Math.abs(data[i+1] - gTarget) < tol &&
         Math.abs(data[i+2] - bTarget) < tol;
};

// For each x, find the first y where color matches.
const firstY = new Array(width).fill(-1);
const lastY = new Array(width).fill(-1);
for (let x = 0; x < width; x++) {
  for (let y = 0; y < height; y++) {
    if (near(x, y)) {
      if (firstY[x] === -1) firstY[x] = y;
      lastY[x] = y;
    }
  }
}

// Find connected x-ranges with matching color
const regions = [];
let regionStart = -1;
for (let x = 0; x < width; x++) {
  const has = firstY[x] !== -1;
  if (has && regionStart === -1) regionStart = x;
  if (!has && regionStart !== -1) {
    regions.push({ x0: regionStart, x1: x - 1 });
    regionStart = -1;
  }
}
if (regionStart !== -1) regions.push({ x0: regionStart, x1: width - 1 });

console.log(`Target RGB=(${rTarget},${gTarget},${bTarget}) tol=${tol}, found ${regions.length} regions:`);
for (const r of regions) {
  const w = r.x1 - r.x0 + 1;
  if (w < 20) continue;
  console.log(`  region x=${r.x0}..${r.x1} (w=${w}):`);
  // Sample top-y every N pixels
  const step = Math.max(1, Math.floor(w / 40));
  for (let x = r.x0; x <= r.x1; x += step) {
    console.log(`    x=${x}  firstY=${firstY[x]}  lastY=${lastY[x]}`);
  }
}
