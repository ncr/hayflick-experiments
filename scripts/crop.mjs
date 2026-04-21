#!/usr/bin/env node
import { PNG } from "pngjs";
import { readFileSync, writeFileSync } from "node:fs";
const [path, x, y, w, h, out] = process.argv.slice(2);
const src = PNG.sync.read(readFileSync(path));
const X = Number(x), Y = Number(y), W = Number(w), H = Number(h);
const dst = new PNG({ width: W, height: H });
for (let j = 0; j < H; j++) {
  for (let i = 0; i < W; i++) {
    const si = ((Y+j) * src.width + (X+i)) * 4;
    const di = (j * W + i) * 4;
    dst.data[di] = src.data[si];
    dst.data[di+1] = src.data[si+1];
    dst.data[di+2] = src.data[si+2];
    dst.data[di+3] = 255;
  }
}
writeFileSync(out, PNG.sync.write(dst));
