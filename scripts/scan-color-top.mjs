#!/usr/bin/env node
// For a given color and x-range, find the MIN y (topmost pixel) at every x.
// Prints the topmost row as a 1D array so we can see the exact silhouette.
import { PNG } from "pngjs";
import { readFileSync } from "node:fs";

const path = process.argv[2];
const rT = Number(process.argv[3]);
const gT = Number(process.argv[4]);
const bT = Number(process.argv[5]);
const x0 = Number(process.argv[6]);
const x1 = Number(process.argv[7]);
const tol = Number(process.argv[8] ?? 30);

const png = PNG.sync.read(readFileSync(path));
const { width, height, data } = png;

const near = (x, y) => {
  if (x < 0 || y < 0 || x >= width || y >= height) return false;
  const i = (y * width + x) * 4;
  return Math.abs(data[i] - rT) < tol &&
         Math.abs(data[i+1] - gT) < tol &&
         Math.abs(data[i+2] - bT) < tol;
};

const tops = [];
for (let x = x0; x <= x1; x++) {
  let y = -1;
  for (let yy = 0; yy < height; yy++) {
    if (near(x, yy)) { y = yy; break; }
  }
  tops.push({ x, y });
}

// Find runs of same y
const runs = [];
let cur = null;
for (const t of tops) {
  if (t.y === -1) continue;
  if (!cur || cur.y !== t.y || cur.x1 + 1 !== t.x) {
    if (cur) runs.push(cur);
    cur = { x0: t.x, x1: t.x, y: t.y };
  } else {
    cur.x1 = t.x;
  }
}
if (cur) runs.push(cur);

for (const r of runs) {
  const w = r.x1 - r.x0 + 1;
  console.log(`  y=${r.y}  x=${r.x0}..${r.x1}  width=${w}`);
}
