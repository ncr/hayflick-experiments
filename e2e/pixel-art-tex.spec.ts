import { expect, test } from "@playwright/test";

/**
 * Pixel-exact verification of the pixel-art-tex POC.
 *
 * Loads the experiment in synthetic-pattern mode (no AI call), then for a
 * sweep of texel positions across the calibration quad asserts that the
 * actual framebuffer pixel matches the source texel colour exactly. The
 * pipeline knobs that make this hold are:
 *
 *   - DataTexture: NEAREST mag/min, no mipmaps, flipY=true
 *   - IsoGameView: lowTargetSamples=0 (no MSAA averaging)
 *   - IsoGameView: smoothPixelTransitions=false (hard nearest at the
 *     output upscale)
 *
 * If any of those drift, this test fails on the offending pixel — the
 * canonical "no fuzzy filtering" guarantee from the user spec.
 */

declare global {
  interface Window {
    __pixelArtTex?: {
      readPixel(x: number, y: number): { r: number; g: number; b: number };
      getCalibrationQuadBounds(): { left: number; right: number; top: number; bottom: number };
      getCurrentPixelArt(): { data: Uint8ClampedArray; width: number; height: number };
      forceFrame(n?: number): void;
      calibrationTexelCenterCanvas(tx: number, ty: number): { x: number; y: number };
      getTexelResolution(): { x: number; y: number };
      frameAndReadPixels(
        positions: Array<{ x: number; y: number }>
      ): Array<{ r: number; g: number; b: number }>;
    };
  }
}

// Override baseURL to the dev server (port 5174 by default). The api-proxy
// plugin that serves /api/assets/read?path=meshes/wall.glb is dev-only —
// the production `preview` server does not run Vite plugins, so wall.glb
// would 404 to index.html and GLTFLoader's JSON-parse would fail with
// "Unexpected token '<'". Use PIXEL_ART_BASE_URL to override the port.
const DEV_BASE_URL = process.env.PIXEL_ART_BASE_URL || "http://localhost:5174";

test.use({
  viewport: { width: 800, height: 600 },
  deviceScaleFactor: 1,
  baseURL: DEV_BASE_URL
});

test("synthetic-pattern texels render as exact framebuffer pixels", async ({ page }) => {
  await page.goto("/#/exp/pixel-art-tex");
  await page.waitForFunction(
    () => !!window.__pixelArtTex && document.querySelector("[data-render-ready='1']") !== null,
    { timeout: 15_000 }
  );

  // Force several frames so the render scale and pose stabilise.
  await page.evaluate(() => window.__pixelArtTex!.forceFrame(5));

  const result = await page.evaluate(() => {
    const handle = window.__pixelArtTex!;
    const pattern = handle.getCurrentPixelArt();
    const res = handle.getTexelResolution();
    // Sweep an inner grid of texel positions, skipping the outermost row/col
    // so we never sample on a partially-occluded pixel near the quad edge.
    const tcoords: Array<[number, number]> = [];
    for (let ty = 4; ty < res.y - 4; ty += 4) {
      for (let tx = 4; tx < res.x - 4; tx += 4) {
        tcoords.push([tx, ty]);
      }
    }
    tcoords.push([Math.floor(res.x / 2), Math.floor(res.y / 2)]);

    const positions = tcoords.map(([tx, ty]) => {
      const c = handle.calibrationTexelCenterCanvas(tx, ty);
      return { x: Math.round(c.x), y: Math.round(c.y) };
    });

    // Render and sample atomically — preserveDrawingBuffer is off, so a
    // detached read between frames returns black.
    const reads = handle.frameAndReadPixels(positions);

    return tcoords.map(([tx, ty], i) => {
      const pi = (ty * pattern.width + tx) * 4;
      return {
        tx,
        ty,
        canvas: positions[i],
        expected: {
          r: pattern.data[pi],
          g: pattern.data[pi + 1],
          b: pattern.data[pi + 2]
        },
        actual: reads[i]
      };
    });
  });

  // Build a clear failure message — show all mismatches, not just the first.
  const mismatches = result.filter(
    (c) =>
      c.actual.r !== c.expected.r ||
      c.actual.g !== c.expected.g ||
      c.actual.b !== c.expected.b
  );
  if (mismatches.length > 0) {
    const lines = mismatches
      .slice(0, 10)
      .map(
        (m) =>
          `  texel (${m.tx},${m.ty}) at canvas (${m.canvas.x},${m.canvas.y}): ` +
          `expected rgb(${m.expected.r},${m.expected.g},${m.expected.b}) ` +
          `actual rgb(${m.actual.r},${m.actual.g},${m.actual.b})`
      );
    throw new Error(
      `${mismatches.length}/${result.length} texel mismatches (showing first 10):\n` +
        lines.join("\n")
    );
  }
  expect(mismatches.length).toBe(0);
  // Sanity: also assert that the sweep did inspect a non-trivial set of texels.
  expect(result.length).toBeGreaterThan(20);
});

test("adjacent texels project to adjacent integer canvas rows", async ({ page }) => {
  // Two adjacent texels along the V (vertical world Y) axis must sit on
  // canvas rows that differ by exactly an integer number of pixels — no
  // fractional offset, which would mean the texel grid is not aligned to
  // the framebuffer pixel grid (and would smear under any AA).
  await page.goto("/#/exp/pixel-art-tex");
  await page.waitForFunction(
    () => !!window.__pixelArtTex && document.querySelector("[data-render-ready='1']") !== null,
    { timeout: 15_000 }
  );
  await page.evaluate(() => window.__pixelArtTex!.forceFrame(3));

  const dy = await page.evaluate(() => {
    const handle = window.__pixelArtTex!;
    const a = handle.calibrationTexelCenterCanvas(8, 8);
    const b = handle.calibrationTexelCenterCanvas(8, 9);
    return Math.abs(b.y - a.y);
  });
  // The exact pixel-per-texel ratio depends on the active render scale and
  // viewport (the engine scales orthoHeight with lowRenderHeight to keep
  // world-per-lowres-pixel constant). What we lock here is that the texel
  // step lands within 1/100 of a pixel of an integer — anything else means
  // the grid is mis-aligned to the framebuffer lattice.
  expect(Math.abs(dy - Math.round(dy))).toBeLessThan(0.01);
  expect(dy).toBeGreaterThanOrEqual(2);
});
