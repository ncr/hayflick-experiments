/**
 * Open a textured-mesh entry in Material Studio (read-only via Edit), wait
 * for the iso preview + paint canvas to settle, screenshot a few framings,
 * write PNGs to /tmp/.
 *
 * Usage:
 *   node scripts/material-studio/screenshot-textured-mesh.mjs <entry-name>
 */
import { chromium } from "@playwright/test";
import path from "path";

const BASE_URL = process.env.MAT_STUDIO_BASE_URL || "http://localhost:5173";
const ENTRY = process.argv[2];
if (!ENTRY) {
  console.error("usage: node scripts/material-studio/screenshot-textured-mesh.mjs <entry-name>");
  process.exit(2);
}

const OUT_DIR = "/tmp";
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

try {
  await page.goto(`${BASE_URL}/#/exp/material-studio`, { waitUntil: "domcontentloaded" });
  await page.locator(".matstudio-app").waitFor({ timeout: 15_000 });

  const card = page.locator(".ms-card", { hasText: ENTRY });
  await card.first().waitFor({ timeout: 15_000 });
  await card.first().locator(".ms-card-thumb-btn").click();
  await page.locator(".ms-authoring").waitFor({ timeout: 10_000 });

  // Wait for the iso scene to mount + paint canvas + a couple of frames.
  await page.waitForFunction(() => !!(window).__materialStudio, null, { timeout: 15_000 });
  await page.locator(".ms-paint-canvas-wrap canvas").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(800); // settle
  await page.evaluate(() => {
    const h = (window).__materialStudio;
    if (h?.scene?.forceFrame) h.scene.forceFrame(8);
  });
  await page.waitForTimeout(200);

  const shots = [];

  const fullPath = path.join(OUT_DIR, `${ENTRY}.${stamp}.full.png`);
  await page.locator(".ms-authoring").screenshot({ path: fullPath });
  shots.push(fullPath);

  const viewportPath = path.join(OUT_DIR, `${ENTRY}.${stamp}.iso.png`);
  await page.locator(".ms-viewport").screenshot({ path: viewportPath });
  shots.push(viewportPath);

  const paintPath = path.join(OUT_DIR, `${ENTRY}.${stamp}.atlas.png`);
  await page.locator(".ms-paint-canvas-wrap").screenshot({ path: paintPath });
  shots.push(paintPath);

  console.log(JSON.stringify(shots));
} catch (err) {
  console.error(`✖ failed:`, err?.message || err);
  await page.screenshot({ path: `/tmp/screenshot-failure-${stamp}.png` }).catch(() => {});
  process.exitCode = 1;
} finally {
  await ctx.close();
  await browser.close();
}
