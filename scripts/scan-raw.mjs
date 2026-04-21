#!/usr/bin/env node
// Print exact RGB at pixel positions for a region
import { PNG } from "pngjs";
import { readFileSync } from "node:fs";

const path = process.argv[2];
const x0 = Number(process.argv[3]);
const y0 = Number(process.argv[4]);
const x1 = Number(process.argv[5]);
const y1 = Number(process.argv[6]);

const png = PNG.sync.read(readFileSync(path));
const { width, data } = png;

for (let y = y0; y <= y1; y++) {
  const row = [`y=${y}:`];
  for (let x = x0; x <= x1; x++) {
    const i = (y * width + x) * 4;
    row.push(`${x}:(${data[i]},${data[i+1]},${data[i+2]})`);
  }
  console.log(row.join(" "));
}
