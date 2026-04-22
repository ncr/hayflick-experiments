#!/usr/bin/env node
// Outline regression testbed.
//
// Captures edge-only + final screenshots of a fixed matrix of minimal
// outline-walls scenes at multiple yaws, classifies each into a low-res
// ASCII grid, and writes a consolidated report into
// scripts/outline-testbed/out/<label>/. Intended to be run before + after
// any change to edge-detection-material or the outline pipeline.
//
// Usage:
//   node scripts/outline-testbed/run.mjs --label before
//   node scripts/outline-testbed/run.mjs --label after --base 5176
//   node scripts/outline-testbed/run.mjs --label after --diff before
import { chromium } from "@playwright/test";
import { PNG } from "pngjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = path.resolve(__dirname, "out");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return process.argv[i + 1];
}

const LABEL = arg("label", `run-${Date.now()}`);
const PORT = Number(arg("port", 5176));
const ZOOM = Number(arg("zoom", 6));
const DIFF_LABEL = arg("diff", null);
const VPW = Number(arg("vpw", 900));
const VPH = Number(arg("vph", 700));

// Matrix of scenes. Each entry is one URL visit; `rotQ` quarter-turns are
// applied via keyboard before the screenshot.
const SCENES = [
  { name: "only-corner",    rotQ: 0, params: { outlineScene: "room", onlyCorner: "1" } },
  { name: "only-corner-q1", rotQ: 1, params: { outlineScene: "room", onlyCorner: "1" } },
  { name: "only-corner-q2", rotQ: 2, params: { outlineScene: "room", onlyCorner: "1" } },
  { name: "two-corners",    rotQ: 0, params: { outlineScene: "room", outlineVariant: "two-corners" } },
  { name: "two-corners-q1", rotQ: 1, params: { outlineScene: "room", outlineVariant: "two-corners" } },
  { name: "two-corners-q2", rotQ: 2, params: { outlineScene: "room", outlineVariant: "two-corners" } },
  { name: "two-corners-q3", rotQ: 3, params: { outlineScene: "room", outlineVariant: "two-corners" } },
  { name: "corner-floor",   rotQ: 0, params: { outlineScene: "room", outlineVariant: "corner-floor" } },
  { name: "corner-floor-q1",rotQ: 1, params: { outlineScene: "room", outlineVariant: "corner-floor" } },
  { name: "corner-wall",    rotQ: 0, params: { outlineScene: "room", outlineVariant: "corner-wall" } },
  { name: "corner-wall-q1", rotQ: 1, params: { outlineScene: "room", outlineVariant: "corner-wall" } },
  { name: "compare",        rotQ: 0, params: { outlineScene: "room", outlineVariant: "compare" } },
  { name: "full-room",      rotQ: 0, params: { outlineScene: "room" } },
  { name: "full-room-q1",   rotQ: 1, params: { outlineScene: "room" } }
];

const SUPPRESS = arg("suppress", "depth");

function buildUrl(params, debug) {
  const qp = new URLSearchParams({
    outlineDebug: String(debug),
    outlineZoom: String(ZOOM),
    outlineFreezeOrbit: "1",
    outlineHideHud: "1",
    outlineSuppress: SUPPRESS,
    ...params
  });
  return `http://localhost:${PORT}/?${qp.toString()}#/exp/outline-walls`;
}

function classify(r, g, b) {
  const bright = r >= 200 && g >= 200 && b >= 200;
  return bright ? "#" : ".";
}

// Render the edge-only PNG as a low-res ASCII grid, sampling one screen
// pixel near the centre of each LR block (blocks are ZOOM×ZOOM after the
// pixel-perfect upscale). Trims surrounding all-dot rows/cols to keep the
// grid compact.
function toAsciiGrid(pngBuffer) {
  const img = PNG.sync.read(pngBuffer);
  const W = img.width;
  const H = img.height;
  const lrW = Math.floor(W / ZOOM);
  const lrH = Math.floor(H / ZOOM);
  const rows = [];
  for (let ly = 0; ly < lrH; ly++) {
    const py = ly * ZOOM + Math.floor(ZOOM / 2);
    let row = "";
    for (let lx = 0; lx < lrW; lx++) {
      const px = lx * ZOOM + Math.floor(ZOOM / 2);
      const idx = (py * W + px) * 4;
      row += classify(img.data[idx], img.data[idx + 1], img.data[idx + 2]);
    }
    rows.push(row);
  }
  let top = 0, bot = rows.length - 1;
  while (top <= bot && !rows[top].includes("#")) top++;
  while (bot >= top && !rows[bot].includes("#")) bot--;
  if (top > bot) return { grid: "(no edges)", minX: 0, minY: 0, width: 0, height: 0 };
  let leftmost = Infinity, rightmost = -Infinity;
  for (let y = top; y <= bot; y++) {
    const r = rows[y];
    const li = r.indexOf("#");
    const ri = r.lastIndexOf("#");
    if (li !== -1) leftmost = Math.min(leftmost, li);
    if (ri !== -1) rightmost = Math.max(rightmost, ri);
  }
  const pad = 1;
  const x0 = Math.max(0, leftmost - pad);
  const x1 = Math.min(rows[0].length - 1, rightmost + pad);
  const y0 = Math.max(0, top - pad);
  const y1 = Math.min(rows.length - 1, bot + pad);
  const cropped = [];
  for (let y = y0; y <= y1; y++) cropped.push(rows[y].slice(x0, x1 + 1));
  return {
    grid: cropped.join("\n"),
    minX: x0,
    minY: y0,
    width: x1 - x0 + 1,
    height: y1 - y0 + 1
  };
}

async function captureCanvas(page, url, rotQ) {
  await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
  const canvas = page.locator(".stage-host canvas").first();
  await canvas.waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  for (let i = 0; i < rotQ; i++) {
    await page.keyboard.press("KeyQ");
    await page.waitForTimeout(380);
  }
  if (rotQ > 0) await page.waitForTimeout(500);
  return canvas.screenshot({ type: "png" });
}

async function captureScene(page, scene) {
  const edgeBuffer = await captureCanvas(page, buildUrl(scene.params, 5), scene.rotQ);
  const finalBuffer = await captureCanvas(page, buildUrl(scene.params, 0), scene.rotQ);
  return { edgeBuffer, finalBuffer };
}

async function main() {
  const outDir = path.join(OUT_ROOT, LABEL);
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ args: ["--ignore-gpu-blocklist"] });
  const ctx = await browser.newContext({ viewport: { width: VPW, height: VPH }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on("pageerror", (err) => console.error("[pageerror]", err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") console.error(`[browser error]`, msg.text());
  });
  const report = [];
  report.push(`# Outline testbed: ${LABEL}`);
  report.push(`viewport=${VPW}x${VPH} zoom=${ZOOM} port=${PORT} scenes=${SCENES.length}`);
  report.push("");
  for (const scene of SCENES) {
    process.stdout.write(`  ${scene.name}... `);
    try {
      const { edgeBuffer, finalBuffer } = await captureScene(page, scene);
      fs.writeFileSync(path.join(outDir, `${scene.name}-edges.png`), edgeBuffer);
      fs.writeFileSync(path.join(outDir, `${scene.name}-final.png`), finalBuffer);
      const { grid, minX, minY, width, height } = toAsciiGrid(edgeBuffer);
      fs.writeFileSync(path.join(outDir, `${scene.name}-edges.txt`), grid);
      report.push(`## ${scene.name}  (rotQ=${scene.rotQ})`);
      report.push(`LR box origin=(${minX},${minY}) size=${width}×${height}`);
      report.push("```");
      report.push(grid);
      report.push("```");
      report.push("");
      process.stdout.write(`${width}×${height}\n`);
    } catch (err) {
      report.push(`## ${scene.name} — FAILED: ${err.message}`);
      report.push("");
      process.stdout.write(`FAILED: ${err.message}\n`);
    }
  }
  await browser.close();
  fs.writeFileSync(path.join(outDir, "report.md"), report.join("\n"));
  console.log(`\nReport: ${path.relative(process.cwd(), path.join(outDir, "report.md"))}`);

  if (DIFF_LABEL) {
    diffLabels(DIFF_LABEL, LABEL);
  }
}

function diffLabels(a, b) {
  const da = path.join(OUT_ROOT, a);
  const db = path.join(OUT_ROOT, b);
  console.log(`\n-- diff ${a} → ${b} --`);
  const files = fs.readdirSync(db).filter((f) => f.endsWith("-edges.txt"));
  let total = 0, changed = 0;
  for (const f of files) {
    const pa = path.join(da, f);
    const pb = path.join(db, f);
    if (!fs.existsSync(pa)) { console.log(`  ${f}: (missing in ${a})`); continue; }
    const ta = fs.readFileSync(pa, "utf8");
    const tb = fs.readFileSync(pb, "utf8");
    total++;
    if (ta === tb) {
      console.log(`  ${f}: identical`);
    } else {
      changed++;
      const linesA = ta.split("\n");
      const linesB = tb.split("\n");
      const maxLen = Math.max(linesA.length, linesB.length);
      let diffCount = 0;
      for (let i = 0; i < maxLen; i++) {
        if ((linesA[i] ?? "") !== (linesB[i] ?? "")) diffCount++;
      }
      console.log(`  ${f}: CHANGED (${diffCount} rows differ)`);
    }
  }
  console.log(`\n${changed}/${total} scenes changed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
