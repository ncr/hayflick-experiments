#!/usr/bin/env node
// Read canvas pixels directly via 2D ImageBitmap and compare to post-target.
import { chromium } from "@playwright/test";
const browser = await chromium.launch({ args: ["--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.goto("http://localhost:5176/?outlineDebug=5&outlineZoom=6&outlineFreezeOrbit=1&outlineHideHud=1&outlineScene=room#/exp/outline-walls", { waitUntil: "networkidle" });
await page.locator(".stage-host canvas").first().waitFor();
await page.waitForTimeout(2500);
const canvasBuf = await page.locator(".stage-host canvas").first().screenshot({ type: "png" });
// Save for manual inspection + reuse pngjs decoding.
import("fs").then((fs) => fs.writeFileSync("/tmp/canvas-dump.png", canvasBuf));
import("pngjs").then(({ PNG }) => {
  const img = PNG.sync.read(canvasBuf);
  const samples = { width: img.width, height: img.height, samples: {} };
  for (const y of [200, 203, 205, 207, 209, 213, 300, 320]) {
    samples.samples[`y=${y}`] = {};
    for (const x of [100, 120, 150, 180, 220, 435]) {
      const i = (y * img.width + x) * 4;
      samples.samples[`y=${y}`][`x=${x}`] = [img.data[i], img.data[i + 1], img.data[i + 2]];
    }
  }
  console.log(JSON.stringify(samples, null, 2));
});
await browser.close();
