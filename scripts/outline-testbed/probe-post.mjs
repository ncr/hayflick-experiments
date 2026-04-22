#!/usr/bin/env node
// Read the post-target directly (the buffer the shader writes into) and
// compare to what the PNG screenshot shows. If they disagree the regression
// stripe is created somewhere downstream of the shader (output upscale).
import { chromium } from "@playwright/test";
const browser = await chromium.launch({ args: ["--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.goto("http://localhost:5176/?outlineDebug=5&outlineZoom=6&outlineFreezeOrbit=1&outlineHideHud=1&outlineReadback=1&outlineScene=room#/exp/outline-walls", { waitUntil: "networkidle" });
await page.locator(".stage-host canvas").first().waitFor();
await page.waitForTimeout(2500);
const low = await page.evaluate(() => {
  const low = window.__outlineLow__;
  if (!low) return null;
  const { width, height, pixels } = low;
  const samples = {};
  for (const pngY of [200, 203, 205, 207, 209, 213, 250, 310]) {
    const dataRow = height - 1 - pngY;
    samples[`pngY=${pngY}`] = {};
    for (const x of [100, 120, 150, 180, 220, 435]) {
      const i = (dataRow * width + x) * 4;
      samples[`pngY=${pngY}`][`x=${x}`] = [pixels[i], pixels[i + 1], pixels[i + 2]];
    }
  }
  return { width, height, samples };
});
console.log(JSON.stringify(low, null, 2));
await browser.close();
