#!/usr/bin/env node
// Scan horizontal rows for where depth != far-plane (rendered geometry).
import { chromium } from "@playwright/test";
const PORT = Number(process.argv.indexOf("--port") !== -1 ? process.argv[process.argv.indexOf("--port") + 1] : 5176);

const browser = await chromium.launch({ args: ["--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("pageerror:", e.message));

const url =
  "http://localhost:5176/?outlineDebug=5&outlineZoom=6&outlineFreezeOrbit=1&outlineHideHud=1&outlineProbe=0,0&outlineScene=room#/exp/outline-walls";
await page.goto(url, { waitUntil: "networkidle" });
await page.locator(".stage-host canvas").first().waitFor();
await page.waitForTimeout(2000);

const result = await page.evaluate(() => {
  const fn = window.__outlineProbe__;
  if (!fn) return null;
  const out = [];
  // Scan 20 horizontal rows equally spaced.
  const h = 634;
  const w = 882;
  for (let y = 40; y < h; y += 60) {
    let leftGeo = -1, rightGeo = -1;
    for (let x = 0; x < w; x += 2) {
      const s = fn(x, y, 1);
      if (s.center.viewZ < 199.9) {
        if (leftGeo === -1) leftGeo = x;
        rightGeo = x;
      }
    }
    out.push({ y, leftGeo, rightGeo });
  }
  // Also scan vertical strips at a few x coords.
  const xStats = [];
  for (const x of [150, 300, 450, 600, 750]) {
    let topGeo = -1, botGeo = -1;
    for (let y = 0; y < h; y += 2) {
      const s = fn(x, y, 1);
      if (s.center.viewZ < 199.9) {
        if (topGeo === -1) topGeo = y;
        botGeo = y;
      }
    }
    xStats.push({ x, topGeo, botGeo });
  }
  return { horiz: out, vert: xStats };
});

console.log("-- horizontal scan (data-y → [geometry x-range]) --");
for (const r of result.horiz) {
  const pngY = 634 - 1 - r.y;
  console.log(`  y=${r.y}  PNG_y=${pngY}  leftGeo=${r.leftGeo}  rightGeo=${r.rightGeo}`);
}
console.log("-- vertical scan (x → [geometry y-range]) --");
for (const r of result.vert) {
  console.log(`  x=${r.x}  topGeo=${r.topGeo}  botGeo=${r.botGeo}`);
}
await browser.close();
