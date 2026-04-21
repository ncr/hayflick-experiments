#!/usr/bin/env node
// Scan pixels around the glass top edges in the normal-edge view.
import { PNG } from "pngjs";
import { readFileSync } from "node:fs";

const path = process.argv[2] || "/home/ncr/dev/hayflick-experiments/e2e/screenshots/probe-normaledge-z4.png";
const buf = readFileSync(path);
const png = PNG.sync.read(buf);
const { width, height, data } = png;

console.log(`Image ${path}: ${width}x${height}`);

// Helper: is pixel green (normal-edge color)?
const isGreen = (x, y) => {
  if (x < 0 || y < 0 || x >= width || y >= height) return false;
  const i = (y * width + x) * 4;
  const r = data[i], g = data[i+1], b = data[i+2];
  return g > 80 && g > r + 30 && g > b + 30;
};

// Find green pixel columns in a band of y-rows (horizontal lines)
const findHLinesInRegion = (x0, x1, y0, y1) => {
  const hlineRows = new Map(); // y -> count
  for (let y = y0; y <= y1; y++) {
    let n = 0;
    for (let x = x0; x <= x1; x++) if (isGreen(x, y)) n++;
    if (n > 0) hlineRows.set(y, n);
  }
  return hlineRows;
};

// Rough regions guessed from z4 image. Left window ~ x=[300,560], y=[230,410]? Right window ~ x=[700,1000], y=[260,430]?
// Let me just dump green pixel distribution by row.
console.log("\n--- rows with green pixel counts (y: count) ---");
for (let y = 100; y < height - 100; y++) {
  let n = 0;
  for (let x = 0; x < width; x++) if (isGreen(x, y)) n++;
  if (n > 0) console.log(`y=${y}: ${n}`);
}
