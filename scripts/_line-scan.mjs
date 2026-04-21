#!/usr/bin/env node
// Scan a horizontal row, report runs of white pixels with their start x and width.
import { PNG } from "pngjs";
import { readFileSync } from "node:fs";

const path = process.argv[2];
const y = Number(process.argv[3]);

const png = PNG.sync.read(readFileSync(path));
const { width, data } = png;

const isWhite = (x) => {
  const i = (y * width + x) * 4;
  return data[i] > 200 && data[i+1] > 200 && data[i+2] > 200;
};

let runs = [];
let runStart = -1;
for (let x = 0; x < width; x++) {
  if (isWhite(x)) {
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
