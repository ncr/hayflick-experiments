#!/usr/bin/env node
// For a color, find all distinct contiguous regions in the image.
// Print each region's normalized shape (bounding-box-relative pixel pattern).
import { PNG } from "pngjs";
import { readFileSync } from "node:fs";

const path = process.argv[2];
const rT = Number(process.argv[3]);
const gT = Number(process.argv[4]);
const bT = Number(process.argv[5]);
const tol = Number(process.argv[6] ?? 30);

const png = PNG.sync.read(readFileSync(path));
const { width, height, data } = png;

const near = (x, y) => {
  if (x < 0 || y < 0 || x >= width || y >= height) return false;
  const i = (y * width + x) * 4;
  return Math.abs(data[i] - rT) < tol &&
         Math.abs(data[i+1] - gT) < tol &&
         Math.abs(data[i+2] - bT) < tol;
};

// Flood-fill to find distinct regions
const seen = new Uint8Array(width * height);
const regions = [];
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    if (seen[y*width+x] || !near(x, y)) continue;
    // BFS
    const stack = [[x, y]];
    const pixels = [];
    let minx = x, miny = y, maxx = x, maxy = y;
    while (stack.length) {
      const [cx, cy] = stack.pop();
      if (cx < 0 || cy < 0 || cx >= width || cy >= height) continue;
      if (seen[cy*width+cx]) continue;
      if (!near(cx, cy)) continue;
      seen[cy*width+cx] = 1;
      pixels.push([cx, cy]);
      if (cx < minx) minx = cx;
      if (cy < miny) miny = cy;
      if (cx > maxx) maxx = cx;
      if (cy > maxy) maxy = cy;
      stack.push([cx+1, cy], [cx-1, cy], [cx, cy+1], [cx, cy-1]);
    }
    if (pixels.length >= 50) {
      regions.push({ minx, miny, maxx, maxy, pixels });
    }
  }
}

console.log(`Found ${regions.length} regions of size ≥ 50 px:`);
for (let r = 0; r < regions.length; r++) {
  const reg = regions[r];
  const w = reg.maxx - reg.minx + 1;
  const h = reg.maxy - reg.miny + 1;
  console.log(`Region ${r}: bbox (${reg.minx},${reg.miny})-(${reg.maxx},${reg.maxy}) ${w}x${h} count=${reg.pixels.length}`);
}

// If there are 2+ regions, print a shape fingerprint of each for comparison
if (regions.length >= 2) {
  console.log("\nNormalized pixel patterns (relative to each bbox):");
  for (let r = 0; r < regions.length; r++) {
    const reg = regions[r];
    const w = reg.maxx - reg.minx + 1;
    const h = reg.maxy - reg.miny + 1;
    const grid = Array.from({ length: h }, () => new Array(w).fill("."));
    for (const [x, y] of reg.pixels) {
      grid[y - reg.miny][x - reg.minx] = "#";
    }
    console.log(`\n--- Region ${r} (${w}x${h}) at (${reg.minx}, ${reg.miny}) ---`);
    for (let row = 0; row < h; row++) {
      console.log(grid[row].join(""));
    }
  }
}
