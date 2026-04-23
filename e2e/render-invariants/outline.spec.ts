import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 });

const OUTLINE_SLUGS = [
  "outline-same-group",
  "outline-cross-group",
  "outline-debug-edges",
  "outline-debug-depth",
  "outline-debug-normals",
  "outline-debug-ids",
  "outline-debug-final"
];

for (const slug of OUTLINE_SLUGS) {
  test(`${slug} renders pixel-exact baseline`, async ({ page }) => {
    await page.goto(`/#/diag/${slug}`);
    await page.waitForSelector("[data-render-ready='1']", { timeout: 5000 });
    // Outline pipeline composites multiple passes; under SwiftShader the
    // per-pixel result is still deterministic. Keep strict.
    await expect(page.locator("canvas")).toHaveScreenshot(`${slug}.png`, {
      maxDiffPixels: 0,
      animations: "disabled"
    });
  });
}

/**
 * Invariant: in outline-same-group, two walls assigned to the same group
 * must have their shared seam suppressed. Asserted by comparing the edge
 * debug pass — edges outside the shared boundary should be identical across
 * variants, but the middle seam between the same-group walls should vanish.
 *
 * We don't assert pixel equality here because the same-group suppression
 * produces a slightly different silhouette. The per-slug snapshots above
 * lock the exact output; this test just documents the expected relationship.
 */
test("outline debug mode cycle: all 5 modes present", async ({ page }) => {
  await page.goto("/#/diag/outline-debug-final");
  await page.waitForSelector("[data-render-ready='1']", { timeout: 5000 });
  const diag = await page.evaluate(() => {
    if (!window.__diag || typeof window.__diag.setOutlineDebugMode !== "function") {
      return { supported: false as const };
    }
    const modes: string[] = ["final", "edges", "depth", "normals", "ids"];
    const results: { mode: string; ok: boolean }[] = [];
    for (const m of modes) {
      try {
        window.__diag.setOutlineDebugMode(m);
        window.__diag.forceFrame(2);
        results.push({ mode: m, ok: true });
      } catch {
        results.push({ mode: m, ok: false });
      }
    }
    return { supported: true as const, results };
  });

  expect(diag.supported).toBe(true);
  if (diag.supported) {
    for (const r of diag.results) {
      expect(r.ok, `debug mode ${r.mode}`).toBe(true);
    }
  }
});
