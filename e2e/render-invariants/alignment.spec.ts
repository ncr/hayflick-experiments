import { expect, test } from "@playwright/test";

/**
 * Pixel-exact baselines for the pixel-perfect alignment invariants. Rendered
 * under SwiftShader ANGLE (playwright.config.ts `--use-angle=swiftshader`), so
 * output is deterministic across machines. Viewport is pinned to 640x480 with
 * deviceScaleFactor=1 — the low-res render target then equals the viewport,
 * the render scale equals zoom, and every golden file is directly meaningful.
 *
 * These goldens were captured from the unrefactored `@common/render`. A pixel
 * shift after a refactor means a broken invariant — track it down, do not
 * auto-update the snapshot.
 */

test.use({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 });

const ZOOM_SLUGS = [
  "align-zoom-1",
  "align-zoom-2",
  "align-zoom-3",
  "align-zoom-4",
  "align-zoom-8",
  "align-zoom-fractional"
];

for (const slug of ZOOM_SLUGS) {
  test(`${slug} renders pixel-exact baseline`, async ({ page }) => {
    await page.goto(`/#/diag/${slug}`);
    await page.waitForSelector("[data-render-ready='1']", { timeout: 5000 });
    await expect(page.locator("canvas")).toHaveScreenshot(`${slug}.png`, {
      maxDiffPixels: 0,
      animations: "disabled"
    });
  });
}
