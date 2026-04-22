#!/usr/bin/env node
// Print an ASCII grid with column + row headers so V-gap locations are easy
// to read. Usage: node scripts/outline-testbed/annotate.mjs <grid.txt>
import fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: annotate.mjs <grid.txt> [yStart] [yEnd]");
  process.exit(1);
}
const yStart = Number(process.argv[3] ?? 0);
const yEnd = Number(process.argv[4] ?? 9999);
const lines = fs.readFileSync(file, "utf8").split("\n");
const w = Math.max(...lines.map((l) => l.length));
// Two header rows of tens and ones digits.
const tens = Array.from({ length: w }, (_, x) => (x % 10 === 0 ? String(Math.floor(x / 10) % 10) : " "));
const ones = Array.from({ length: w }, (_, x) => String(x % 10));
console.log("   " + tens.join(""));
console.log("   " + ones.join(""));
for (let y = 0; y < lines.length; y++) {
  if (y < yStart || y > yEnd) continue;
  const label = String(y).padStart(3, " ");
  console.log(`${label}${lines[y]}`);
}
