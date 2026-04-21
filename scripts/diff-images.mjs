#!/usr/bin/env node
// Compare green pixel patterns between two images in regions of interest.
import { PNG } from "pngjs";
import { readFileSync, writeFileSync } from "node:fs";

const pathA = process.argv[2];
const pathB = process.argv[3];
const a = PNG.sync.read(readFileSync(pathA));
const b = PNG.sync.read(readFileSync(pathB));

if (a.width !== b.width || a.height !== b.height) {
  console.log(`Size mismatch: ${pathA} is ${a.width}x${a.height}, ${pathB} is ${b.width}x${b.height}`);
  process.exit(1);
}

const { width, height } = a;
const isGreen = (data, x, y) => {
  if (x < 0 || y < 0 || x >= width || y >= height) return false;
  const i = (y * width + x) * 4;
  const r = data[i], g = data[i+1], b2 = data[i+2];
  return g > 80 && g > r + 30 && g > b2 + 30;
};

// Diff pixels
let aOnly = 0, bOnly = 0, both = 0;
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const ga = isGreen(a.data, x, y);
    const gb = isGreen(b.data, x, y);
    if (ga && gb) both++;
    else if (ga) aOnly++;
    else if (gb) bOnly++;
  }
}
console.log(`A: ${pathA}`);
console.log(`B: ${pathB}`);
console.log(`Only A: ${aOnly}, Only B: ${bOnly}, Both: ${both}`);

// Create diff image: red for A-only, cyan for B-only, white for both, black otherwise
const diff = new PNG({ width, height });
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const ga = isGreen(a.data, x, y);
    const gb = isGreen(b.data, x, y);
    const i = (y * width + x) * 4;
    if (ga && gb) { diff.data[i] = 255; diff.data[i+1] = 255; diff.data[i+2] = 255; }
    else if (ga) { diff.data[i] = 255; diff.data[i+1] = 0; diff.data[i+2] = 0; }
    else if (gb) { diff.data[i] = 0; diff.data[i+1] = 255; diff.data[i+2] = 255; }
    else { diff.data[i] = 20; diff.data[i+1] = 20; diff.data[i+2] = 20; }
    diff.data[i+3] = 255;
  }
}
const outPath = process.argv[4] || "/tmp/diff.png";
writeFileSync(outPath, PNG.sync.write(diff));
console.log(`Wrote diff to ${outPath}`);
