import { expect, test } from "@playwright/test";

// The probe is a pure-frontend experiment (no /api/*), but the preview server
// serves a stale build, so — like material-studio — point at the dev server.
const DEV_BASE_URL = process.env.PROBE_BASE_URL || "http://localhost:5173";
test.use({ baseURL: DEV_BASE_URL });

type ProbeStats = {
  ready: boolean;
  centerLuma: number;
  spp: number;
  internalPixels: number;
  bvhMs: number;
  frameMs: number;
};

declare global {
  interface Window {
    __pathtraceProbe?: {
      getStats(): ProbeStats;
      setResolution(i: number): void;
      setPaused(p: boolean): void;
    };
  }
}

test("path-trace probe renders non-blank dynamic output", async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  // Ignore favicon.ico — the dev server ships no favicon; its 404 is unrelated
  // environmental noise, not a probe failure.
  const isNoise = (s: string) => s.includes("favicon.ico");
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = `${m.text()} @ ${m.location().url}`;
    if (!isNoise(text)) errors.push(text);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${String(e)}`));

  await page.goto("/#/exp/pathtrace-probe");

  // Wait for the experiment module to install its handle and reach a ready frame.
  await page.waitForFunction(() => Boolean(window.__pathtraceProbe), null, {
    timeout: 20_000
  });

  // Smallest internal resolution keeps the (SwiftShader) headless trace cheap,
  // then pause so samples accumulate deterministically into a clean image.
  await page.evaluate(() => {
    window.__pathtraceProbe!.setResolution(0);
    window.__pathtraceProbe!.setPaused(true);
  });

  await page.waitForFunction(
    () => {
      const s = window.__pathtraceProbe?.getStats();
      return Boolean(s && s.ready && s.spp >= 2);
    },
    null,
    { timeout: 30_000 }
  );

  const stats = await page.evaluate(() => window.__pathtraceProbe!.getStats());

  // The actual proof: the path tracer produced lit, non-blank pixels.
  expect(stats.centerLuma).toBeGreaterThan(0);
  expect(stats.internalPixels).toBe(240 * 135);
  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});
