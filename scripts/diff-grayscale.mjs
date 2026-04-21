#!/usr/bin/env node
// Compare two images pixel-by-pixel, show diff in output image.
import { PNG } from "pngjs";
import { readFileSync, writeFileSync } from "node:fs";

const pA = process.argv[2];
const pB = process.argv[3];
const out = process.argv[4] || "/tmp/diff.png";

const a = PNG.sync.read(readFileSync(pA));
const b = PNG.sync.read(readFileSync(pB));
if (a.width !== b.width || a.height !== b.height) {
  console.error("Size mismatch");
  process.exit(1);
}
const { width, height } = a;
const out_png = new PNG({ width, height });
let differ = 0;
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const dR = Math.abs(a.data[i] - b.data[i]);
    const dG = Math.abs(a.data[i+1] - b.data[i+1]);
    const dB = Math.abs(a.data[i+2] - b.data[i+2]);
    const d = Math.max(dR, dG, dB);
    if (d > 5) {
      out_png.data[i] = 255;
      out_png.data[i+1] = 0;
      out_png.data[i+2] = 0;
      differ++;
    } else {
      out_png.data[i] = a.data[i] >> 1;
      out_png.data[i+1] = a.data[i+1] >> 1;
      out_png.data[i+2] = a.data[i+2] >> 1;
    }
    out_png.data[i+3] = 255;
  }
}
console.log(`Differ: ${differ} pixels`);
writeFileSync(out, PNG.sync.write(out_png));
console.log(`Wrote ${out}`);
