import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 });

const SLUGS = ["default-game-view-outlined", "default-game-view-plain"];

for (const slug of SLUGS) {
  test(`${slug} renders pixel-exact baseline`, async ({ page }) => {
    await page.goto(`/#/diag/${slug}`);
    await page.waitForSelector("[data-render-ready='1']", { timeout: 5000 });
    await expect(page.locator("canvas")).toHaveScreenshot(`${slug}.png`, {
      maxDiffPixels: 0,
      animations: "disabled"
    });
  });
}
