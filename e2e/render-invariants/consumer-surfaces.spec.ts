import { expect, test } from "@playwright/test";

/**
 * Consumer-shaped golden coverage for refactors of `@common/render`.
 *
 * The lower-level render invariant suite pins camera math, outlines, and
 * scissor clipping. These routes intentionally look like real consumers:
 * prop previews use `IsoGameView` + `PROP_PREVIEW_FRAMING`, while mixed-stage
 * editor previews use `SharedScissorStage` + layered `PixelPerfectPane`s with
 * different tone-mapping modes. Keep zero tolerance; refactors should preserve
 * these pixels unless the visual contract changes intentionally.
 */
test.use({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 });

const CONSUMER_SLUGS = ["consumer-prop-preview", "consumer-mixed-stage"];

for (const slug of CONSUMER_SLUGS) {
  test(`${slug} renders pixel-exact consumer baseline`, async ({ page }) => {
    await page.goto(`/#/diag/${slug}`);
    await page.waitForSelector("[data-render-ready='1']", { timeout: 5000 });
    await expect(page.locator("canvas")).toHaveScreenshot(`${slug}.png`, {
      maxDiffPixels: 0,
      animations: "disabled"
    });
  });
}
