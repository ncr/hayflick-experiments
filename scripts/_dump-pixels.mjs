#!/usr/bin/env node
// Dump pixel RGB values in a region with threshold info
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
  let row = `y=${y}: `;
  for (let x = x0; x <= x1; x++) {
    const i = (y * width + x) * 4;
    const r = data[i], g = data[i+1], b = data[i+2];
    const avg = (r + g + b) / 3;
    const mark = avg > 200 ? "W" : avg > 100 ? "g" : avg > 50 ? "-" : ".";
    row += mark;
  }
  console.log(row);
}
