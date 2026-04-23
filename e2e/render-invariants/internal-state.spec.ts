import { expect, test } from "@playwright/test";

/**
 * Asserts on `window.__diag` internal state — not pixel diffs. These pin the
 * invariants that live behind the facade:
 *
 *   1. Low-res RT dims are always even (viewport → buffer rounding in
 *      `pixel-perfect.ts:computeLowResolutionSize`).
 *   2. Render scale is always a positive integer (never fractional — the final
 *      upscale must step in whole texel counts).
 */

test("low-res RT dims are even at even viewport", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 480 });
  await page.goto("/#/diag/invariants");
  await page.waitForSelector("[data-render-ready='1']", { timeout: 5000 });
  const size = await page.evaluate(() => window.__diag?.getLowResSize() ?? null);
  expect(size).not.toBeNull();
  expect(size!.width % 2).toBe(0);
  expect(size!.height % 2).toBe(0);
});

test("low-res RT dims are even at odd viewport", async ({ page }) => {
  await page.setViewportSize({ width: 301, height: 241 });
  await page.goto("/#/diag/invariants");
  await page.waitForSelector("[data-render-ready='1']", { timeout: 5000 });
  const size = await page.evaluate(() => window.__diag?.getLowResSize() ?? null);
  expect(size).not.toBeNull();
  expect(size!.width % 2).toBe(0);
  expect(size!.height % 2).toBe(0);
});

test.describe("render scale is always a positive integer", () => {
  test.use({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 });

  for (const zoom of [1, 1.5, 2, 2.4, 2.6, 3, 4]) {
    test(`at zoom=${zoom}`, async ({ page }) => {
      await page.goto("/#/diag/invariants");
      await page.waitForSelector("[data-render-ready='1']", { timeout: 5000 });
      await page.evaluate((z) => {
        window.__diag?.setPose?.({ zoom: z });
        window.__diag?.forceFrame(2);
      }, zoom);
      const scale = await page.evaluate(() => window.__diag?.getRenderScale() ?? null);
      expect(scale).not.toBeNull();
      expect(Number.isInteger(scale!)).toBe(true);
      expect(scale!).toBeGreaterThanOrEqual(1);
    });
  }
});
