#!/usr/bin/env node
// Print green-pixel structure within a rectangular region.
import { PNG } from "pngjs";
import { readFileSync } from "node:fs";

const path = process.argv[2];
const x0 = Number(process.argv[3]);
const y0 = Number(process.argv[4]);
const x1 = Number(process.argv[5]);
const y1 = Number(process.argv[6]);

const png = PNG.sync.read(readFileSync(path));
const { width, height, data } = png;

const isGreen = (x, y) => {
  if (x < 0 || y < 0 || x >= width || y >= height) return false;
  const i = (y * width + x) * 4;
  const r = data[i], g = data[i+1], b = data[i+2];
  return g > 80 && g > r + 30 && g > b + 30;
};

console.log(`Region x=${x0}..${x1} y=${y0}..${y1}`);
for (let y = y0; y <= y1; y++) {
  let row = `y=${y}: `;
  for (let x = x0; x <= x1; x++) {
    row += isGreen(x, y) ? "#" : ".";
  }
  console.log(row);
}
