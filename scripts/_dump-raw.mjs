#!/usr/bin/env node
// Dump raw RGB values at specific x, y range.
import { PNG } from "pngjs";
import { readFileSync } from "node:fs";

const path = process.argv[2];
const x0 = Number(process.argv[3]);
const y = Number(process.argv[4]);
const count = Number(process.argv[5] ?? 20);

const png = PNG.sync.read(readFileSync(path));
const { width, data } = png;

for (let dx = 0; dx < count; dx++) {
  const x = x0 + dx;
  const i = (y * width + x) * 4;
  const r = data[i], g = data[i+1], b = data[i+2];
  console.log(`x=${x} rgb=(${r}, ${g}, ${b})`);
}
