#!/usr/bin/env node
// Probe a buffer-pixel row inside the attempt1 regression stripe to see
// exactly what depth deltas the shader is picking up. We already know the
// stripe sits at PNG y=205-207 (buffer data y=426-428). Walk x across the
// stripe and dump depth/normal per pixel plus its 4 neighbours at stride=1.
import { chromium } from "@playwright/test";

const PORT = Number(process.argv.indexOf("--port") !== -1 ? process.argv[process.argv.indexOf("--port") + 1] : 5176);

function buildUrl(params, probe) {
  const qp = new URLSearchParams({
    outlineDebug: "5",
    outlineZoom: "6",
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
page.on("pageerror", (e) => console.error("pageerror:", e.message));

await page.goto(buildUrl({ outlineScene: "room" }), { waitUntil: "networkidle", timeout: 30_000 });
await page.locator(".stage-host canvas").first().waitFor({ timeout: 20_000 });
await page.waitForTimeout(2000);

// Scan data rows 420..432 (PNG rows 201..213 = stripe + neighbours).
// Scan data cols 90..180 in stride=3 (enough to characterise).
const samples = await page.evaluate(() => {
  const fn = window.__outlineProbe__;
  if (!fn) return null;
  const out = [];
  for (const y of [420, 424, 426, 428, 432]) {
    for (let x = 100; x <= 180; x += 2) {
      const s = fn(x, y, 1);
      out.push({ x, y, C: s.center, U: s.up, D: s.down });
    }
  }
  return out;
});

console.log("buffer_x\tbuffer_y\tPNG_y\td_C\td_U\td_D\tn_C\t|dCU|\t|dCD|");
for (const s of samples) {
  const pngY = 634 - 1 - s.y;
  const fmt = (n) => n.toFixed(2);
  const d = (v) => v?.viewZ?.toFixed(3) ?? "-";
  const n = (x) => x ? `[${x.normal.map(fmt).join(",")}]` : "-";
  const diff = (a, b) => a && b ? Math.abs(a.viewZ - b.viewZ).toFixed(3) : "-";
  console.log(
    `${s.x}\t${s.y}\t${pngY}\t${d(s.C)}\t${d(s.U)}\t${d(s.D)}\t${n(s.C)}\t${diff(s.C, s.U)}\t${diff(s.C, s.D)}`
  );
}

await browser.close();
