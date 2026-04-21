import { chromium } from "@playwright/test";
const port = 5175;
const browser = await chromium.launch({
  args: ["--ignore-gpu-blocklist", "--enable-unsafe-webgpu"]
});
const results = [];
for (const exp of ["primitive-views", "texture-workshop", "tile-viewer"]) {
  const url = `http://localhost:${port}/#/exp/${exp}`;
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`${exp}: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${exp} console: ${m.text()}`); });
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    await page.waitForSelector(".stage-host canvas, canvas", { timeout: 20_000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `/tmp/smoke-${exp}.png`, type: "png" });
    results.push(`✓ ${exp} loaded${errors.length ? ` (${errors.length} errors)` : ""}`);
    if (errors.length) results.push(...errors.map(e => `  ${e}`));
  } catch (e) {
    results.push(`✗ ${exp}: ${e.message}`);
  } finally {
    await context.close();
  }
}
await browser.close();
for (const r of results) console.log(r);
