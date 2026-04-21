#!/usr/bin/env node
// Scan a row, find runs where ANY color channel > 100.
import { PNG } from "pngjs";
import { readFileSync } from "node:fs";

const path = process.argv[2];
const y = Number(process.argv[3]);

const png = PNG.sync.read(readFileSync(path));
const { width, data } = png;

const isBright = (x) => {
  const i = (y * width + x) * 4;
  return data[i] > 100 || data[i+1] > 100 || data[i+2] > 100;
};

let runs = [];
let runStart = -1;
for (let x = 0; x < width; x++) {
  if (isBright(x)) {
    if (runStart === -1) runStart = x;
  } else {
    if (runStart !== -1) {
      runs.push({ start: runStart, width: x - runStart });
      runStart = -1;
    }
  }
}
if (runStart !== -1) runs.push({ start: runStart, width: width - runStart });

console.log(`y=${y} runs: ${runs.map(r => `x=${r.start}(w=${r.width})`).join(", ")}`);
