#!/usr/bin/env node
// Measure linear-depth / normal / id values at a set of low-res pixels in
// outline-walls so we can decide empirically whether there exists a depth
// threshold that separates V-gap silhouettes from flush tile-top seams at
// all yaws.
//
// Usage:
//   node scripts/outline-testbed/probe.mjs --port 5176
import { chromium } from "@playwright/test";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return process.argv[i + 1];
}

const PORT = Number(arg("port", 5176));
const ZOOM = 6;

// Probes sampled per scene. Coordinates are LOW-RES pixels (not ASCII grid
// cells — ASCII grids are cropped to bounding box, LR is raw). For scenes
// whose ASCII report lists a non-zero LR origin, add origin to ASCII coords.
const SCENES = [
  {
    label: "full-room",
    params: { outlineScene: "room" },
    rotQ: 0,
    probes: [
      { name: "vgap-r53-c72", lx: 72, ly: 53, desc: "V-gap convergence (missing edge)" },
      { name: "stripe-r34-c19", lx: 19, ly: 34, desc: "Regression stripe start" },
      { name: "stripe-r34-c20", lx: 20, ly: 34, desc: "Regression stripe +1" },
      { name: "stripe-r34-c22", lx: 22, ly: 34, desc: "Regression stripe +3" },
      { name: "stripe-r34-c25", lx: 25, ly: 34, desc: "Regression stripe centre" },
      { name: "stripe-r34-c30", lx: 30, ly: 34, desc: "Regression stripe far end" },
      { name: "stripe-above-c25", lx: 25, ly: 33, desc: "Pixel above regression" },
      { name: "stripe-below-c25", lx: 25, ly: 35, desc: "Pixel below regression" },
      { name: "stripe-r34-c120", lx: 120, ly: 34, desc: "Right-side regression stripe start" },
      { name: "stripe-r34-c122", lx: 122, ly: 34, desc: "Right-side stripe centre" }
    ]
  }
];

function buildUrl(params) {
  const qp = new URLSearchParams({
    outlineDebug: "5",
    outlineZoom: String(ZOOM),
    outlineFreezeOrbit: "1",
    outlineHideHud: "1",
    outlineProbe: "0,0",
    ...params
  });
  return `http://localhost:${PORT}/?${qp.toString()}#/exp/outline-walls`;
}

const browser = await chromium.launch({ args: ["--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on("pageerror", (err) => console.error("[pageerror]", err.message));
page.on("console", (msg) => {
  if (msg.type() === "error") console.error(`[browser error]`, msg.text());
});

const fmt = (s) =>
  s
    ? `d=${s.viewZ.toFixed(4).padStart(9)} n=[${s.normal.map((v) => v.toFixed(2)).join(",")}] id=[${s.id.map((v) => v.toFixed(2)).join(",")}]`
    : "(edge)";

for (const scene of SCENES) {
  await page.goto(buildUrl(scene.params), { waitUntil: "networkidle", timeout: 30_000 });
  await page.locator(".stage-host canvas").first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  for (let i = 0; i < scene.rotQ; i++) {
    await page.keyboard.press("KeyQ");
    await page.waitForTimeout(380);
  }
  if (scene.rotQ > 0) await page.waitForTimeout(500);
  const meta = await page.evaluate(() => {
    const fn = window.__outlineProbe__;
    if (!fn) return null;
    const s = fn(0, 0);
    return {
      bufferW: s.width,
      bufferH: s.height,
      renderedFraction: s.renderedFraction,
      depthRange: s.depthRange,
      dpr: window.devicePixelRatio
    };
  });
  console.log(`\n=== ${scene.label} (rotQ=${scene.rotQ}) ===`);
  console.log(`  buffer=${meta.bufferW}×${meta.bufferH} rendered=${(meta.renderedFraction*100).toFixed(1)}% depthRange=${JSON.stringify(meta.depthRange)} dpr=${meta.dpr}`);
  for (const probe of scene.probes) {
    // Map ASCII-grid coord to buffer-pixel coord: centre of the ZOOM×ZOOM
    // cell, flipped Y because readRenderTargetPixels returns bottom-left-
    // origin data while the ASCII grid is top-left-origin.
    const bufX = probe.lx * ZOOM + Math.floor(ZOOM / 2);
    const bufY = meta.bufferH - 1 - (probe.ly * ZOOM + Math.floor(ZOOM / 2));
    const data = await page.evaluate(
      ([x, y, s]) => {
        const fn = window.__outlineProbe__;
        return fn ? fn(x, y, s) : null;
      },
      [bufX, bufY, ZOOM]
    );
    if (!data) {
      console.log(`  ${probe.name}: NO DATA`);
      continue;
    }
    console.log(`  [${probe.name}] ${probe.desc}  @LR(${probe.lx},${probe.ly}) → buf(${bufX},${bufY})`);
    console.log(`     C : ${fmt(data.center)}`);
    console.log(
      `     L : ${fmt(data.left)}  |dCL|=${data.left ? Math.abs(data.center.viewZ - data.left.viewZ).toFixed(4) : "-"}`
    );
    console.log(
      `     R : ${fmt(data.right)}  |dCR|=${data.right ? Math.abs(data.center.viewZ - data.right.viewZ).toFixed(4) : "-"}`
    );
    console.log(
      `     U : ${fmt(data.up)}    |dCU|=${data.up ? Math.abs(data.center.viewZ - data.up.viewZ).toFixed(4) : "-"}`
    );
    console.log(
      `     D : ${fmt(data.down)}  |dCD|=${data.down ? Math.abs(data.center.viewZ - data.down.viewZ).toFixed(4) : "-"}`
    );
  }
}

await browser.close();
