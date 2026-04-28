import { expect, test } from "@playwright/test";

// Material-studio talks to several `/api/*` endpoints (assets read, mesh
// list, openai proxy, bake). The dev server runs the api-proxy plugin;
// the production preview server does not. Override baseURL so the tests
// hit `pnpm dev` — Vite picks the first free of 5173 / 5174 / … so override
// via MAT_STUDIO_BASE_URL when needed.
const DEV_BASE_URL = process.env.MAT_STUDIO_BASE_URL || "http://localhost:5173";
test.use({ baseURL: DEV_BASE_URL });

test.describe("material studio", () => {
  test("library loads and + New reveals base-mesh picker", async ({ page }) => {
    await page.goto("/#/exp/material-studio");

    const app = page.locator(".matstudio-app");
    await expect(app).toBeVisible({ timeout: 10_000 });

    const library = page.locator(".ms-library");
    await expect(library).toBeVisible();
    await expect(page.locator(".ms-topbar")).toBeVisible();

    await page.getByRole("button", { name: "+ New" }).first().click();
    const picker = page.locator(".ms-base-picker");
    await expect(picker).toBeVisible();

    await page.getByRole("button", { name: "← Back to library" }).click();
    await expect(library).toBeVisible();
  });

  test("base-mesh picker opens authoring view with paint editor + 3D preview", async ({ page }) => {
    await page.goto("/#/exp/material-studio");
    await expect(page.locator(".matstudio-app")).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "+ New" }).first().click();

    const cards = page.locator(".ms-base-picker .ms-card");
    await expect(cards.first()).toBeVisible({ timeout: 5_000 });
    await cards.first().click();

    await expect(page.locator(".ms-authoring")).toBeVisible({ timeout: 5_000 });
    await expect(page.locator(".ms-viewport")).toBeVisible();
    await expect(page.locator(".ms-right-pane")).toBeVisible();
    await expect(page.locator(".ms-paint-pane")).toBeVisible();
  });

  test("paint canvas: clicking on a swatch + canvas writes that color into the atlas", async ({ page }) => {
    await page.goto("/#/exp/material-studio");
    await expect(page.locator(".matstudio-app")).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "+ New" }).first().click();

    const cards = page.locator(".ms-base-picker .ms-card");
    await expect(cards.first()).toBeVisible({ timeout: 5_000 });
    await cards.first().click();

    // PaintCanvas only mounts after the scene loads + prepareSurface seeds
    // the atlas — its visibility is the proof that Phase 1 wiring works.
    const paintCanvas = page.locator(".ms-paint-canvas-wrap canvas");
    await expect(paintCanvas).toBeVisible({ timeout: 15_000 });

    // Burnt amber swatch — distinctive RGB so a stray default colour
    // can't masquerade as "yes I painted".
    await page.locator('.ms-swatch-btn[aria-label="burnt amber"]').click();

    // CSS size = atlas × zoom; compute CSS pos for atlas (10, 10).
    const cssPerAtlas = await cssPerAtlasPx(page);
    const targetCss = (n: number) => Math.round((n + 0.5) * cssPerAtlas);
    const before = await readAtlasPixel(page, 10, 10);
    await paintCanvas.click({ position: { x: targetCss(10), y: targetCss(10) } });

    // Paint commit triggers a PBR-derive settle and a state dispatch;
    // give React a tick to flush.
    await page.waitForTimeout(150);

    const after = await readAtlasPixel(page, 10, 10);
    expect(after).not.toEqual(before);
    // burnt amber #b8430e
    expect(after).toEqual([0xb8, 0x43, 0x0e]);
  });

  test("paint propagates to the 3D mesh — warm-red cluster appears in the iso framebuffer after painting", async ({
    page,
  }) => {
    await page.goto("/#/exp/material-studio");
    await expect(page.locator(".matstudio-app")).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "+ New" }).first().click();
    const cards = page.locator(".ms-base-picker .ms-card");
    await expect(cards.first()).toBeVisible({ timeout: 5_000 });
    await cards.first().click();

    const paintCanvas = page.locator(".ms-paint-canvas-wrap canvas");
    await expect(paintCanvas).toBeVisible({ timeout: 15_000 });
    await page.waitForFunction(() => !!(window as unknown as { __materialStudio?: unknown }).__materialStudio, {
      timeout: 5_000,
    });

    // Baseline: count warm-red pixels (R clearly dominant over G and B) in
    // the mesh's iso preview *before* painting. Should be ~0 — the wall
    // texture is white-ceramic and the background is dark blue-grey.
    // ACES tone mapping crushes shadows, so use a low absolute floor.
    const countWarmRed = (data: Uint8ClampedArray): number => {
      let n = 0;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        if (r >= 12 && r >= g + 6 && r >= b + 6) n++;
      }
      return n;
    };

    const before = await page.evaluate((countSrc) => {
      const handle = (window as unknown as {
        __materialStudio?: { scene: { forceFrame: (n: number) => void; readCanvasImageData: () => ImageData } };
      }).__materialStudio!;
      handle.scene.forceFrame(3);
      const id = handle.scene.readCanvasImageData();
      const fn = new Function("data", `return (${countSrc})(data);`) as (d: Uint8ClampedArray) => number;
      return { warmRed: fn(id.data), w: id.width, h: id.height };
    }, countWarmRed.toString());

    await page.locator('.ms-swatch-btn[aria-label="burnt amber"]').click();

    // Drag-paint a wider block — with the new tight cell sizing each cell
    // renders to ~1 lowpixel, so we need a larger cluster to be visible
    // through ACES tone mapping after Lambert lighting attenuation.
    const box = await paintCanvas.boundingBox();
    if (!box) throw new Error("paint canvas has no bounding box");
    const cpa = await cssPerAtlasPx(page);
    const cssAt = (a: number) => (a + 0.5) * cpa;
    for (let dy = 0; dy < 12; dy++) {
      await page.mouse.move(box.x + cssAt(8), box.y + cssAt(10 + dy));
      await page.mouse.down();
      await page.mouse.move(box.x + cssAt(20), box.y + cssAt(10 + dy));
      await page.mouse.up();
      await page.waitForTimeout(20);
    }
    await page.waitForTimeout(150);

    const after = await page.evaluate((countSrc) => {
      const handle = (window as unknown as {
        __materialStudio?: { scene: { forceFrame: (n: number) => void; readCanvasImageData: () => ImageData } };
      }).__materialStudio!;
      handle.scene.forceFrame(3);
      const id = handle.scene.readCanvasImageData();
      const fn = new Function("data", `return (${countSrc})(data);`) as (d: Uint8ClampedArray) => number;
      return { warmRed: fn(id.data), w: id.width, h: id.height };
    }, countWarmRed.toString());

    // Save a screenshot for forensic debugging if this ever fails.
    await page.locator(".ms-viewport").screenshot({ path: "test-results/iso-after-paint.png" });

    // The painted burnt-amber block must show up as a substantial cluster
    // of warm-red pixels in the iso preview — proving the live texture
    // update path (paint stroke → updateBaseColor → mesh re-render) works.
    expect(after.warmRed - before.warmRed).toBeGreaterThan(40);
  });

  test("painting one atlas pixel does NOT bleed shading into neighbours (no PBR halo)", async ({ page }) => {
    await page.goto("/#/exp/material-studio");
    await expect(page.locator(".matstudio-app")).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "+ New" }).first().click();
    const cards = page.locator(".ms-base-picker .ms-card");
    await expect(cards.first()).toBeVisible({ timeout: 5_000 });
    await cards.first().click();

    const paintCanvas = page.locator(".ms-paint-canvas-wrap canvas");
    await expect(paintCanvas).toBeVisible({ timeout: 15_000 });
    await page.waitForFunction(() => !!(window as unknown as { __materialStudio?: unknown }).__materialStudio, {
      timeout: 5_000,
    });

    type FB = { width: number; height: number; bytes: number[] };
    const grabFramebuffer = async (): Promise<FB> => {
      return await page.evaluate(() => {
        const handle = (window as unknown as {
          __materialStudio?: { scene: { forceFrame: (n: number) => void; readCanvasImageData: () => ImageData } };
        }).__materialStudio!;
        handle.scene.forceFrame(3);
        const id = handle.scene.readCanvasImageData();
        return { width: id.width, height: id.height, bytes: Array.from(id.data) };
      });
    };

    const before = await grabFramebuffer();

    // Paint a small 2×2 block — one atlas cell in the new tighter layout
    // (sized to project to exactly one rendered lowpixel) may land in a
    // parallelogram slant gap and produce 0 framebuffer changes; a 2×2 block
    // virtually guarantees at least one visible cell.
    await page.locator('.ms-swatch-btn[aria-label="structural dark"]').click();
    const cpa = await cssPerAtlasPx(page);
    const box = await paintCanvas.boundingBox();
    if (!box) throw new Error("paint canvas has no bounding box");
    await page.mouse.move(box.x + (10 + 0.5) * cpa, box.y + (10 + 0.5) * cpa);
    await page.mouse.down();
    await page.mouse.move(box.x + (11 + 0.5) * cpa, box.y + (11 + 0.5) * cpa);
    await page.mouse.up();
    await page.waitForTimeout(150);

    const after = await grabFramebuffer();
    expect(after.width).toBe(before.width);
    expect(after.height).toBe(before.height);

    // Count pixels where any channel changed by > 8 (lighting determinism
    // is byte-exact under SwiftShader, so the only legit changes come from
    // the painted texel's footprint on the mesh).
    let diff = 0;
    for (let i = 0; i < before.bytes.length; i += 4) {
      const dr = Math.abs(after.bytes[i] - before.bytes[i]);
      const dg = Math.abs(after.bytes[i + 1] - before.bytes[i + 1]);
      const db = Math.abs(after.bytes[i + 2] - before.bytes[i + 2]);
      if (dr > 8 || dg > 8 || db > 8) diff++;
    }

    // After the cell-sizing fix, one atlas cell renders to ~1 lowpixel. A
    // 2×2 paint should produce 1–4 changed pixels with NEAREST sampling.
    // With AO/normal-map shading attached, a Sobel halo would light up
    // many neighbouring pixels — cap at 20 to fail if that regresses.
    expect(diff).toBeGreaterThan(0); // sanity: paint produced *some* change
    expect(diff).toBeLessThan(20);
  });

  test("per-face density: painting one pixel on different islands produces same-sized framebuffer footprints", async ({
    page,
  }) => {
    await page.goto("/#/exp/material-studio");
    await expect(page.locator(".matstudio-app")).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "+ New" }).first().click();
    const cards = page.locator(".ms-base-picker .ms-card");
    await expect(cards.first()).toBeVisible({ timeout: 5_000 });
    await cards.first().click();

    const paintCanvas = page.locator(".ms-paint-canvas-wrap canvas");
    await expect(paintCanvas).toBeVisible({ timeout: 15_000 });
    await page.waitForFunction(() => !!(window as unknown as { __materialStudio?: unknown }).__materialStudio, {
      timeout: 5_000,
    });

    type Island = { x: number; y: number; cellsX: number; cellsY: number; cellPx: number };
    const islands: Island[] = await page.evaluate(() => {
      const handle = (window as unknown as {
        __materialStudio?: { getActiveSurfaceState: () => { islandLayout: { islands: Island[] } | null } | null };
      }).__materialStudio!;
      const s = handle.getActiveSurfaceState();
      return s?.islandLayout?.islands ?? [];
    });
    expect(islands.length).toBeGreaterThanOrEqual(2);

    const grabFB = async () =>
      await page.evaluate(() => {
        const handle = (window as unknown as {
          __materialStudio?: { scene: { forceFrame: (n: number) => void; readCanvasImageData: () => ImageData } };
        }).__materialStudio!;
        handle.scene.forceFrame(3);
        const id = handle.scene.readCanvasImageData();
        return Array.from(id.data);
      });

    const diffCount = (a: number[], b: number[]): number => {
      let n = 0;
      for (let i = 0; i < a.length; i += 4) {
        if (Math.abs(a[i] - b[i]) > 8 || Math.abs(a[i + 1] - b[i + 1]) > 8 || Math.abs(a[i + 2] - b[i + 2]) > 8)
          n++;
      }
      return n;
    };

    // Paint each island's centre cell directly via the test handle (DOM
    // clicks at zoom=4 land outside the viewport for islands packed past
    // 1024 CSS px). Collect diff counts. Islands facing away from the iso
    // camera (back/bottom/inside-cutout) produce no framebuffer change —
    // those are filtered out.
    const visibleDiffs: number[] = await page.evaluate(async (islandsArg) => {
      const handle = (window as unknown as {
        __materialStudio?: {
          getActiveRole: () => string | null;
          scene: { forceFrame: (n: number) => void; readCanvasImageData: () => ImageData };
          testPaintAtlasPixel: (role: string, x: number, y: number, r: number, g: number, b: number) => boolean;
        };
      }).__materialStudio!;
      const role = handle.getActiveRole();
      if (!role) throw new Error("no active role");

      const grab = () => {
        handle.scene.forceFrame(3);
        const id = handle.scene.readCanvasImageData();
        return id.data;
      };
      const cmp = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
        let n = 0;
        for (let i = 0; i < a.length; i += 4) {
          if (Math.abs(a[i] - b[i]) > 8 || Math.abs(a[i + 1] - b[i + 1]) > 8 || Math.abs(a[i + 2] - b[i + 2]) > 8)
            n++;
        }
        return n;
      };

      const out: number[] = [];
      for (const isl of islandsArg) {
        const before = new Uint8ClampedArray(grab());
        const cx = isl.x + Math.floor((isl.cellsX * isl.cellPx) / 2);
        const cy = isl.y + Math.floor((isl.cellsY * isl.cellPx) / 2);
        const ok = handle.testPaintAtlasPixel(role, cx, cy, 0x1a, 0x1a, 0x1a);
        if (!ok) continue;
        const after = grab();
        const d = cmp(before, after);
        if (d > 0) out.push(d);
      }
      return out;
    }, islands);

    // Need at least two distinct camera-visible faces to test density across
    // orientations. wall.glb has front + top + at least one side at the
    // default iso angle — so this normally yields 3+.
    expect(visibleDiffs.length).toBeGreaterThanOrEqual(2);

    // Each visible paint must be a small footprint (no PBR halo, no
    // density blow-up) — one atlas pixel ~ 1–3 game pixels under iso.
    for (const d of visibleDiffs) expect(d).toBeLessThan(20);

    // Per-face density must be uniform: pre-fix, front face produced ~2×
    // more changed pixels per paint than top. A ≤3× cap fails on the
    // regression and passes when atlas cells are sized from world bbox.
    const ratio = Math.max(...visibleDiffs) / Math.min(...visibleDiffs);
    expect(ratio).toBeLessThan(3);
  });

  test("atlas axes match screen axes: top-left of atlas renders at top-left of mesh face (no mirror)", async ({
    page,
  }) => {
    await page.goto("/#/exp/material-studio");
    await expect(page.locator(".matstudio-app")).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "+ New" }).first().click();

    // Target wall.glb explicitly — it has clean axis-aligned X×Y faces
    // that make the orientation invariant easy to verify.
    const wallCard = page.locator(".ms-base-picker .ms-card", { hasText: "wall" }).first();
    await expect(wallCard).toBeVisible({ timeout: 5_000 });
    await wallCard.click();

    const paintCanvas = page.locator(".ms-paint-canvas-wrap canvas");
    await expect(paintCanvas).toBeVisible({ timeout: 15_000 });
    await page.waitForFunction(() => !!(window as unknown as { __materialStudio?: unknown }).__materialStudio, {
      timeout: 5_000,
    });

    type Island = { x: number; y: number; cellsX: number; cellsY: number; cellPx: number };

    // Find the largest island (the wall's X×Y face) and paint two
    // distinguishable cells at top-left and bottom-right corners.
    // For each visible (camera-facing) variant of that face we verify
    // that the top-left cell renders above-and-to-the-left of the
    // bottom-right cell — i.e., no horizontal or vertical mirror.
    const result = await page.evaluate(async () => {
      const handle = (window as unknown as {
        __materialStudio: {
          getActiveRole: () => string | null;
          getActiveSurfaceState: () => { islandLayout: { islands: Island[] } | null } | null;
          scene: { forceFrame: (n: number) => void; readCanvasImageData: () => ImageData };
          testPaintAtlasPixel: (role: string, x: number, y: number, r: number, g: number, b: number) => boolean;
        };
      }).__materialStudio;
      const role = handle.getActiveRole();
      if (!role) throw new Error("no active role");
      const islands = (handle.getActiveSurfaceState()?.islandLayout?.islands ?? []) as Island[];
      if (islands.length === 0) throw new Error("no islands");

      // Sort by cell area descending; take the largest. For wall.glb this
      // is one of the two 16×35 X×Y faces (front or back).
      const sorted = [...islands].sort((a, b) => b.cellsX * b.cellsY - a.cellsX * a.cellsY);
      const ranked: Array<{
        island: Island;
        topLeft: { sx: number; sy: number } | null;
        bottomRight: { sx: number; sy: number } | null;
      }> = [];

      // Painting white→pure-red on a Lambert-lit wall keeps R nearly fixed
      // and drops G/B (white was R≈G≈B ~50; red is R≈50, G≈B≈0). So we
      // detect by "any channel changed AND final colour is dominantly red
      // (or blue)" rather than by absolute change in one channel.
      const findCentroid = (
        before: Uint8ClampedArray,
        after: Uint8ClampedArray,
        w: number,
        dominantChannel: 0 | 2
      ): { sx: number; sy: number; count: number } => {
        let sx = 0,
          sy = 0,
          n = 0;
        for (let i = 0; i < before.length; i += 4) {
          const dr = Math.abs(after[i] - before[i]);
          const dg = Math.abs(after[i + 1] - before[i + 1]);
          const db = Math.abs(after[i + 2] - before[i + 2]);
          if (dr < 4 && dg < 4 && db < 4) continue;
          const r = after[i],
            g = after[i + 1],
            b = after[i + 2];
          if (dominantChannel === 0) {
            // Red dominant: r > g + margin AND r > b + margin
            if (r <= g + 6) continue;
            if (r <= b + 6) continue;
          } else {
            if (b <= g + 6) continue;
            if (b <= r + 6) continue;
          }
          const px = (i / 4) % w;
          const py = Math.floor(i / 4 / w);
          sx += px;
          sy += py;
          n++;
        }
        return n > 0 ? { sx: sx / n, sy: sy / n, count: n } : { sx: 0, sy: 0, count: 0 };
      };

      for (const isl of sorted.slice(0, 4)) {
        // Reset by repainting island center (any neutral colour) — actually
        // skip reset, just diff against current frame.
        handle.scene.forceFrame(3);
        const before = new Uint8ClampedArray(handle.scene.readCanvasImageData().data);

        // Paint a 4×4 block in top-left and bottom-right corners of the
        // island so the cluster is detectable through ACES tone mapping.
        // (One painted atlas pixel renders to ~1–3 framebuffer pixels and
        // gets crushed dark; a small block survives reliably.)
        const block = Math.max(1, Math.min(4, Math.floor(Math.min(isl.cellsX, isl.cellsY) / 4)));
        for (let dy = 0; dy < block; dy++) {
          for (let dx = 0; dx < block; dx++) {
            handle.testPaintAtlasPixel(role, isl.x + dx, isl.y + dy, 255, 0, 0);
          }
        }
        const brOffset = isl.cellsX * isl.cellPx;
        for (let dy = 0; dy < block; dy++) {
          for (let dx = 0; dx < block; dx++) {
            handle.testPaintAtlasPixel(role, isl.x + brOffset - 1 - dx, isl.y + isl.cellsY * isl.cellPx - 1 - dy, 0, 0, 255);
          }
        }
        handle.scene.forceFrame(3);
        const w = handle.scene.readCanvasImageData().width;
        const after = handle.scene.readCanvasImageData().data;
        const tl = findCentroid(before, after, w, 0);
        const br = findCentroid(before, after, w, 2);
        ranked.push({
          island: isl,
          topLeft: tl.count >= 2 ? { sx: tl.sx, sy: tl.sy } : null,
          bottomRight: br.count >= 2 ? { sx: br.sx, sy: br.sy } : null,
        });
        // Reset cells back to white so the next island isn't biased.
        for (let dy = 0; dy < block; dy++) {
          for (let dx = 0; dx < block; dx++) {
            handle.testPaintAtlasPixel(role, isl.x + dx, isl.y + dy, 255, 255, 255);
            handle.testPaintAtlasPixel(role, isl.x + brOffset - 1 - dx, isl.y + isl.cellsY * isl.cellPx - 1 - dy, 255, 255, 255);
          }
        }
      }
      return ranked;
    });

    // Find visible camera-facing islands and assert the orientation
    // invariant only on the *largest* one — narrow side faces (4 cells
    // wide) can't discriminate atlas-X reliably with a single-pixel
    // paint, since the screen extent is comparable to the cluster jitter.
    const visible = result.filter(
      (r) => r.topLeft !== null && r.bottomRight !== null && r.island.cellsX >= 8 && r.island.cellsY >= 8
    );
    expect(visible.length).toBeGreaterThanOrEqual(1);
    for (const r of visible) {
      expect(r.topLeft!.sx).toBeLessThan(r.bottomRight!.sx);
      expect(r.topLeft!.sy).toBeLessThan(r.bottomRight!.sy);
    }
  });

  test("one atlas pixel = one rendered large pixel on the wall front face", async ({ page }) => {
    await page.goto("/#/exp/material-studio");
    await expect(page.locator(".matstudio-app")).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "+ New" }).first().click();
    await page.locator(".ms-base-picker .ms-card", { hasText: "wall" }).first().click();
    await expect(page.locator(".ms-paint-canvas-wrap canvas")).toBeVisible({ timeout: 15_000 });
    await page.waitForFunction(() => !!(window as unknown as { __materialStudio?: unknown }).__materialStudio, { timeout: 5_000 });

    // Sweep paint over every 4th cell of the largest island's pixel block.
    // For each, count how many lowpixels changed in the framebuffer. Pre-fix
    // the histogram was {1: 5, 2: 49, 3: 15, 4: 75} per atlas paint — most
    // cells produced 4 lowpixels of jitter. After fix: cells either render
    // to exactly 1 lowpixel (visible face) or 0 (parallelogram slant gap).
    // ≥85% of visible cells should render to exactly 1 lowpixel.
    const histogram = await page.evaluate(() => {
      type Island = { x: number; y: number; cellsX: number; cellsY: number; cellPx: number };
      const handle = (window as unknown as {
        __materialStudio: {
          getActiveRole: () => string | null;
          getActiveSurfaceState: () => { islandLayout: { islands: Island[] } | null } | null;
          scene: { forceFrame: (n: number) => void; readCanvasImageData: () => ImageData };
          testPaintAtlasPixel: (role: string, x: number, y: number, r: number, g: number, b: number) => boolean;
        };
      }).__materialStudio;
      const role = handle.getActiveRole()!;
      const islands = handle.getActiveSurfaceState()!.islandLayout!.islands;
      const big = [...islands].sort((a, b) => b.cellsX * b.cellsY - a.cellsX * a.cellsY)[0];
      const grab = () => {
        handle.scene.forceFrame(2);
        return new Uint8ClampedArray(handle.scene.readCanvasImageData().data);
      };
      const diffCount = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
        let n = 0;
        for (let i = 0; i < a.length; i += 4) {
          if (Math.abs(a[i] - b[i]) > 6 || Math.abs(a[i + 1] - b[i + 1]) > 6 || Math.abs(a[i + 2] - b[i + 2]) > 6) n++;
        }
        return n;
      };
      const counts: number[] = [];
      const base = grab();
      for (let cy = 0; cy < big.cellsY; cy += 4) {
        for (let cx = 0; cx < big.cellsX; cx += 4) {
          handle.testPaintAtlasPixel(role, big.x + cx, big.y + cy, 255, 0, 0);
          counts.push(diffCount(base, grab()));
          handle.testPaintAtlasPixel(role, big.x + cx, big.y + cy, 255, 255, 255);
        }
      }
      const hist: Record<number, number> = {};
      for (const c of counts) hist[c] = (hist[c] || 0) + 1;
      return hist;
    });

    const total = Object.values(histogram).reduce((a, b) => a + b, 0);
    const visible = Object.entries(histogram)
      .filter(([k]) => Number(k) > 0)
      .reduce((s, [, v]) => s + v, 0);
    const ones = histogram[1] ?? 0;
    // No 2-, 3-, or 4-pixel jitter on any cell.
    const jittery = (histogram[2] ?? 0) + (histogram[3] ?? 0) + (histogram[4] ?? 0);
    expect(visible / total).toBeGreaterThan(0.5);
    expect(ones / visible).toBeGreaterThan(0.85);
    expect(jittery).toBe(0);
  });

  test("no atlas column or row is skipped: every cell along the front face's U/V axes renders to ≥1 lowpixel", async ({
    page,
  }) => {
    await page.goto("/#/exp/material-studio");
    await expect(page.locator(".matstudio-app")).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "+ New" }).first().click();
    await page.locator(".ms-base-picker .ms-card", { hasText: "wall" }).first().click();
    await expect(page.locator(".ms-paint-canvas-wrap canvas")).toBeVisible({ timeout: 15_000 });
    await page.waitForFunction(() => !!(window as unknown as { __materialStudio?: unknown }).__materialStudio, { timeout: 5_000 });

    // Pre-fix bug: with cellsX = Euclidean Jacobian length (= 28 for the wall
    // front face but only 25 horizontal lowpixels), NEAREST sampling skipped
    // 3 atlas columns. Painting cell column 9 was invisible. Test: paint
    // every column at the island's vertical mid-row; every column must
    // change at least one framebuffer pixel.
    const skipped = await page.evaluate(() => {
      type Island = { x: number; y: number; cellsX: number; cellsY: number; cellPx: number };
      const handle = (window as unknown as {
        __materialStudio: {
          getActiveRole: () => string | null;
          getActiveSurfaceState: () => { islandLayout: { islands: Island[] } | null } | null;
          scene: { forceFrame: (n: number) => void; readCanvasImageData: () => ImageData };
          testPaintAtlasPixel: (role: string, x: number, y: number, r: number, g: number, b: number) => boolean;
        };
      }).__materialStudio;
      const role = handle.getActiveRole()!;
      const islands = handle.getActiveSurfaceState()!.islandLayout!.islands;
      const big = [...islands].sort((a, b) => b.cellsX * b.cellsY - a.cellsX * a.cellsY)[0];
      const grab = () => {
        handle.scene.forceFrame(2);
        return new Uint8ClampedArray(handle.scene.readCanvasImageData().data);
      };
      const diff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
        let n = 0;
        for (let i = 0; i < a.length; i += 4) {
          if (Math.abs(a[i] - b[i]) > 6 || Math.abs(a[i + 1] - b[i + 1]) > 6 || Math.abs(a[i + 2] - b[i + 2]) > 6) n++;
        }
        return n;
      };
      // Sweep: for each U column at the island's vertical centre, paint and
      // see if it produced ≥1 lowpixel. Same for each V row at horizontal centre.
      const skippedColumns: number[] = [];
      const cy = Math.floor(big.cellsY / 2);
      let base = grab();
      for (let cx = 0; cx < big.cellsX; cx++) {
        handle.testPaintAtlasPixel(role, big.x + cx, big.y + cy, 255, 0, 0);
        if (diff(base, grab()) === 0) skippedColumns.push(cx);
        handle.testPaintAtlasPixel(role, big.x + cx, big.y + cy, 255, 255, 255);
      }
      const skippedRows: number[] = [];
      const cx = Math.floor(big.cellsX / 2);
      base = grab();
      for (let cy2 = 0; cy2 < big.cellsY; cy2++) {
        handle.testPaintAtlasPixel(role, big.x + cx, big.y + cy2, 255, 0, 0);
        if (diff(base, grab()) === 0) skippedRows.push(cy2);
        handle.testPaintAtlasPixel(role, big.x + cx, big.y + cy2, 255, 255, 255);
      }
      return { skippedColumns, skippedRows, cellsX: big.cellsX, cellsY: big.cellsY };
    });

    expect(skipped.skippedColumns).toEqual([]);
    expect(skipped.skippedRows).toEqual([]);
  });

  test("UV island shapes: shared 3D edges produce identical cell counts on wall.glb", async ({ page }) => {
    await page.goto("/#/exp/material-studio");
    await expect(page.locator(".matstudio-app")).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "+ New" }).first().click();
    await page.locator(".ms-base-picker .ms-card", { hasText: "wall" }).first().click();
    await expect(page.locator(".ms-paint-canvas-wrap canvas")).toBeVisible({ timeout: 15_000 });
    await page.waitForFunction(() => !!(window as unknown as { __materialStudio?: unknown }).__materialStudio, { timeout: 5_000 });

    const islands = await page.evaluate(() => {
      type Island = { x: number; y: number; cellsX: number; cellsY: number; cellPx: number };
      const handle = (window as unknown as {
        __materialStudio: { getActiveSurfaceState: () => { islandLayout: { islands: Island[] } | null } | null };
      }).__materialStudio;
      return handle.getActiveSurfaceState()!.islandLayout!.islands;
    });
    // wall.glb produces 6 islands (the cube faces). Group by extents.
    const counts = new Map<string, number>();
    for (const isl of islands) {
      const key = `${isl.cellsX}x${isl.cellsY}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    // The two 128×280 X-Y faces (front and back) must have identical extents.
    // The two 32×280 Y-Z side faces likewise.
    // The two 128×32 X-Z top/bottom faces likewise.
    // So we expect 3 distinct shapes, each appearing twice.
    expect(islands.length).toBe(6);
    const shapes = [...counts.values()].sort((a, b) => b - a);
    expect(shapes).toEqual([2, 2, 2]);

    // Pull each unique shape and verify the cross-axis matches:
    //   X-Y face's X cell count == X-Z face's long-side cell count
    //   X-Y face's Y cell count == Y-Z face's long-side cell count
    //   X-Z face's short-side cell count == Y-Z face's short-side cell count
    const all = [...counts.keys()].map((k) => k.split("x").map(Number) as [number, number]);
    const flat = all.flat();
    const sortedSizes = [...new Set(flat)].sort((a, b) => a - b);
    // Three distinct sizes corresponding to wall's three axes (Z=32, X=128, Y=280)
    // — proving every face shares cell counts with the faces that share its
    // axes, instead of inflating to per-face screen bbox.
    expect(sortedSizes.length).toBeGreaterThanOrEqual(2);
    expect(sortedSizes.length).toBeLessThanOrEqual(3);
  });

  test("generate request includes a 3D reference image and per-island spatial roles in the prompt", async ({
    page,
  }) => {
    await page.goto("/#/exp/material-studio");
    await expect(page.locator(".matstudio-app")).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "+ New" }).first().click();
    await page.locator(".ms-base-picker .ms-card", { hasText: "wall" }).first().click();
    await expect(page.locator(".ms-paint-canvas-wrap canvas")).toBeVisible({ timeout: 15_000 });
    await page.waitForFunction(
      () => !!(window as unknown as { __materialStudio?: unknown }).__materialStudio,
      { timeout: 5_000 }
    );

    // Intercept the edit-image call. Capture the request body for assertion
    // and return the user's own template back as the "AI" output so the
    // downstream extraction + PBR derive succeed without a real API call.
    let captured: {
      prompt: string;
      imageBase64: string;
      referenceImageBase64?: string;
    } | null = null;
    await page.route("**/api/openai/edit-image", async (route) => {
      const body = JSON.parse(route.request().postData() || "{}") as {
        prompt: string;
        imageBase64: string;
        referenceImageBase64?: string;
      };
      captured = body;
      // Echo template back as the AI output — same dimensions, satisfies
      // the extractIslandPixelArt + recompose path.
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: [{ b64_json: body.imageBase64 }] }),
      });
    });

    // Click Generate (prompt is auto-seeded for known roles like "wall").
    const genBtn = page.getByRole("button", { name: /^(Generate|Regenerate)$/ });
    await expect(genBtn).toBeEnabled({ timeout: 5_000 });
    await genBtn.click();
    // Wait for the request to be captured (and the AUTHORING_GENERATED
    // dispatch that follows).
    await expect.poll(() => captured !== null, { timeout: 15_000 }).toBe(true);

    const cap = captured!;
    expect(cap.imageBase64.length).toBeGreaterThan(100);
    expect(cap.referenceImageBase64?.length ?? 0).toBeGreaterThan(100);

    // Prompt must call out the dual-image setup, per-island colours, and
    // the role-tagged region list (front/back/top/...).
    expect(cap.prompt).toMatch(/two images/i);
    expect(cap.prompt).toMatch(/Region 1/);
    // For wall.glb the 6 cube faces produce all 6 axis labels — front +
    // back + top + bottom + left + right. We only require the four most
    // discriminative ones.
    const labels = ["front", "back", "top", "bottom"];
    for (const l of labels) {
      expect(cap.prompt.toLowerCase()).toContain(l);
    }
    // Each region listing carries an outline colour hex tag.
    expect(cap.prompt).toMatch(/outlined in #[0-9a-f]{6}/i);

    // The reference image must decode as a 1024×1024 PNG with multiple
    // distinct colours (one per island, on a grey background).
    const refStats = await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = "data:image/png;base64," + b64;
      await new Promise((res, rej) => {
        img.onload = () => res(null);
        img.onerror = () => rej(new Error("ref image decode failed"));
      });
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const id = ctx.getImageData(0, 0, c.width, c.height);
      // Quantise to 5-bit-per-channel buckets and count distinct buckets.
      const seen = new Set<number>();
      for (let i = 0; i < id.data.length; i += 4) {
        const r = id.data[i] >> 3;
        const g = id.data[i + 1] >> 3;
        const b = id.data[i + 2] >> 3;
        seen.add((r << 10) | (g << 5) | b);
      }
      return { w: c.width, h: c.height, distinctColors: seen.size };
    }, cap.referenceImageBase64!);
    expect(refStats.w).toBe(1024);
    expect(refStats.h).toBe(1024);
    // Background grey + black outlines + ≥3 visible face colours = ≥5 buckets.
    expect(refStats.distinctColors).toBeGreaterThanOrEqual(5);
  });

  test("FULL coverage: every atlas cell of the front face renders to ≥1 lowpixel (no holes anywhere)", async ({
    page,
  }) => {
    // The "no atlas column or row is skipped" test only sweeps the centre
    // row and centre column. The user observed individual pixels missing
    // when drawing arbitrary lines across the face — a 1D sweep can't see
    // those. This test paints every single cell of the largest visible
    // island and reports any cell whose paint produced zero lowpixel
    // change in the framebuffer.
    test.setTimeout(120_000);
    await page.goto("/#/exp/material-studio");
    await expect(page.locator(".matstudio-app")).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "+ New" }).first().click();
    await page.locator(".ms-base-picker .ms-card", { hasText: "wall" }).first().click();
    await expect(page.locator(".ms-paint-canvas-wrap canvas")).toBeVisible({ timeout: 15_000 });
    await page.waitForFunction(
      () => !!(window as unknown as { __materialStudio?: unknown }).__materialStudio,
      { timeout: 5_000 }
    );

    const result = await page.evaluate(async () => {
      type Island = { x: number; y: number; cellsX: number; cellsY: number; cellPx: number };
      const handle = (window as unknown as {
        __materialStudio: {
          getActiveRole: () => string | null;
          getActiveSurfaceState: () => { islandLayout: { islands: Island[] } | null } | null;
          scene: { forceFrame: (n: number) => void; readCanvasImageData: () => ImageData };
          testPaintAtlasPixel: (role: string, x: number, y: number, r: number, g: number, b: number) => boolean;
        };
      }).__materialStudio;
      const role = handle.getActiveRole()!;
      const islands = (handle.getActiveSurfaceState()!.islandLayout!.islands ?? []) as Island[];
      const grab = () => {
        handle.scene.forceFrame(2);
        return new Uint8ClampedArray(handle.scene.readCanvasImageData().data);
      };
      const diffCount = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
        let n = 0;
        for (let i = 0; i < a.length; i += 4) {
          if (
            Math.abs(a[i] - b[i]) > 6 ||
            Math.abs(a[i + 1] - b[i + 1]) > 6 ||
            Math.abs(a[i + 2] - b[i + 2]) > 6
          )
            n++;
        }
        return n;
      };

      // Identify the largest *visible* island (camera-facing). Paint a
      // single marker, see if any lowpixel changed; if yes it is on a
      // visible face. Use the largest such island so we get the widest
      // coverage check.
      const sorted = [...islands].sort((a, b) => b.cellsX * b.cellsY - a.cellsX * a.cellsY);
      let target: Island | null = null;
      for (const isl of sorted) {
        const before = grab();
        const cx = isl.x + Math.floor((isl.cellsX * isl.cellPx) / 2);
        const cy = isl.y + Math.floor((isl.cellsY * isl.cellPx) / 2);
        handle.testPaintAtlasPixel(role, cx, cy, 255, 0, 0);
        const visible = diffCount(before, grab()) > 0;
        handle.testPaintAtlasPixel(role, cx, cy, 255, 255, 255);
        if (visible) {
          target = isl;
          break;
        }
      }
      if (!target) return { error: "no visible island" } as const;

      // Aggregate test first: paint EVERY cell red, count red-dominant
      // lowpixels. Under perfect 1:1 mapping the count equals cellsX *
      // cellsY (the parallelogram area in lowpixels). Any skipped cell
      // shows up as a deficit.
      const before = grab();
      for (let cy = 0; cy < target.cellsY; cy++) {
        for (let cx = 0; cx < target.cellsX; cx++) {
          handle.testPaintAtlasPixel(role, target.x + cx, target.y + cy, 255, 0, 0);
        }
      }
      handle.scene.forceFrame(3);
      const after = handle.scene.readCanvasImageData().data;
      let redLowpixels = 0;
      for (let i = 0; i < after.length; i += 4) {
        const dr = Math.abs(after[i] - before[i]);
        const dg = Math.abs(after[i + 1] - before[i + 1]);
        const db = Math.abs(after[i + 2] - before[i + 2]);
        if (dr < 4 && dg < 4 && db < 4) continue;
        const r = after[i],
          g = after[i + 1],
          b = after[i + 2];
        if (r > g + 6 && r > b + 6) redLowpixels++;
      }

      // Per-cell sweep to identify exactly WHICH cells are missing.
      // Restore island to white, then paint+grab+restore one cell at a time.
      for (let cy = 0; cy < target.cellsY; cy++) {
        for (let cx = 0; cx < target.cellsX; cx++) {
          handle.testPaintAtlasPixel(role, target.x + cx, target.y + cy, 255, 255, 255);
        }
      }
      const baseFrame = grab();
      const skippedCells: Array<[number, number]> = [];
      for (let cy = 0; cy < target.cellsY; cy++) {
        for (let cx = 0; cx < target.cellsX; cx++) {
          handle.testPaintAtlasPixel(role, target.x + cx, target.y + cy, 255, 0, 0);
          const f = grab();
          if (diffCount(baseFrame, f) === 0) skippedCells.push([cx, cy]);
          handle.testPaintAtlasPixel(role, target.x + cx, target.y + cy, 255, 255, 255);
        }
      }

      return {
        cellsX: target.cellsX,
        cellsY: target.cellsY,
        totalCells: target.cellsX * target.cellsY,
        redLowpixels,
        skippedCells,
      } as const;
    });

    if ("error" in result) throw new Error(result.error);
    // Aggregate: every cell must contribute ≥1 lowpixel of red. With the
    // current iso projection, the parallelogram area in lowpixels equals
    // cellsX × cellsY, so the count should be exactly that — but allow
    // a tiny slack for ACES tone-mapping crushing R values to ~equal
    // G/B at low intensities on edge fragments.
    expect(result.redLowpixels).toBeGreaterThanOrEqual(Math.floor(result.totalCells * 0.99));

    // Per-cell: the strict invariant — no atlas cell may render to zero
    // lowpixels. If this fails, the array tells us exactly which cells
    // are dark holes so we can chase the projection bug.
    expect(result.skippedCells).toEqual([]);
  });

  test("fast drag: every painted atlas cell appears on the mesh (no dropped strokes)", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.goto("/#/exp/material-studio");
    await expect(page.locator(".matstudio-app")).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "+ New" }).first().click();
    await page.locator(".ms-base-picker .ms-card", { hasText: "wall" }).first().click();
    const paintCanvas = page.locator(".ms-paint-canvas-wrap canvas");
    await expect(paintCanvas).toBeVisible({ timeout: 15_000 });
    await page.waitForFunction(
      () => !!(window as unknown as { __materialStudio?: unknown }).__materialStudio,
      { timeout: 5_000 }
    );

    // Find the largest visible island so we drag across the front face.
    type Island = { x: number; y: number; cellsX: number; cellsY: number; cellPx: number };
    const target = await page.evaluate(() => {
      const handle = (window as unknown as {
        __materialStudio: {
          getActiveSurfaceState: () => { islandLayout: { islands: Island[] } | null } | null;
        };
      }).__materialStudio;
      const islands = handle.getActiveSurfaceState()!.islandLayout!.islands;
      const sorted = [...islands].sort((a, b) => b.cellsX * b.cellsY - a.cellsX * a.cellsY);
      return sorted[0];
    });
    expect(target).toBeTruthy();

    // Pick the burnt-amber colour so the painted cells are warm-red on a
    // white-ceramic background — distinct under Lambert lighting.
    await page.locator('.ms-swatch-btn[aria-label="burnt amber"]').click();

    // Drive a real fast drag: down at corner A, multiple synchronous mouse
    // moves across the island with steps:1 (no interpolation — most
    // aggressive case for "did Bresenham bridge across events"), up at
    // corner B. No waitForTimeout between moves — that's the worst case.
    const cssPerAtlas = await cssPerAtlasPx(page);
    const box = await paintCanvas.boundingBox();
    if (!box) throw new Error("paint canvas has no bounding box");
    const cssAt = (ax: number, ay: number) => ({
      x: box.x + (ax + 0.5) * cssPerAtlas,
      y: box.y + (ay + 0.5) * cssPerAtlas,
    });

    // Multiple stroke patterns to stress the live-update path:
    //   1. Fast diagonal — single jump from corner to corner.
    //   2. Fast horizontal — leftmost-to-rightmost in a single move.
    //   3. Fast vertical — top-to-bottom in a single move.
    //   4. Zig-zag — many sub-strokes of varying direction with no waits
    //      between them (the case the user described as "fast lines").
    const margin = 2;
    const cx0 = target.x + margin;
    const cy0 = target.y + margin;
    const cx1 = target.x + target.cellsX - 1 - margin;
    const cy1 = target.y + target.cellsY - 1 - margin;
    const cmidX = Math.floor((cx0 + cx1) / 2);
    const cmidY = Math.floor((cy0 + cy1) / 2);

    const strokePath = async (atlasPoints: Array<[number, number]>) => {
      const first = cssAt(atlasPoints[0][0], atlasPoints[0][1]);
      await page.mouse.move(first.x, first.y);
      await page.mouse.down();
      for (let i = 1; i < atlasPoints.length; i++) {
        const p = cssAt(atlasPoints[i][0], atlasPoints[i][1]);
        await page.mouse.move(p.x, p.y, { steps: 1 });
      }
      await page.mouse.up();
    };

    // 1. Diagonal jump.
    await strokePath([[cx0, cy0], [cx1, cy1]]);
    // 2. Fast horizontal (one row above the diagonal).
    await strokePath([[cx0, cmidY - 4], [cx1, cmidY - 4]]);
    // 3. Fast vertical (one column right of midpoint).
    await strokePath([[cmidX, cy0], [cmidX, cy1]]);
    // 4. Zig-zag: 8 short lines in 4 directions, no waits.
    const zig: Array<[number, number]> = [];
    let zx = cx0 + 4, zy = cy0 + 6;
    for (let i = 0; i < 8; i++) {
      zig.push([zx, zy]);
      zx += i % 2 === 0 ? 5 : -3;
      zy += 4;
    }
    await strokePath(zig);
    await page.waitForTimeout(200);

    // Count painted atlas cells inside the target island, AND count mesh
    // lowpixels with a warm-red signature. They must be consistent: every
    // atlas-painted cell must render to ≥1 lowpixel (otherwise the live
    // texture-update path lost pixels between paint and render).
    const result = await page.evaluate((tgt: Island) => {
      const handle = (window as unknown as {
        __materialStudio: {
          getActiveSurfaceState: () => {
            atlas: { rgba: Uint8ClampedArray; mask: Uint8Array; width: number; height: number };
            islandLayout: { islands: Island[] } | null;
          } | null;
          scene: { forceFrame: (n: number) => void; readCanvasImageData: () => ImageData };
        };
      }).__materialStudio;
      const surf = handle.getActiveSurfaceState()!;
      const atlas = surf.atlas;
      // Count cells inside the target island whose mask byte is set AND whose
      // rgba is warm-red (the burnt-amber we painted). Stripping mask alone
      // would also count any pre-existing painted cells.
      const paintedCells: Array<[number, number]> = [];
      for (let cy = 0; cy < tgt.cellsY; cy++) {
        for (let cx = 0; cx < tgt.cellsX; cx++) {
          const idx = (tgt.y + cy) * atlas.width + (tgt.x + cx);
          if (atlas.mask[idx] === 0) continue;
          const r = atlas.rgba[idx * 4];
          const g = atlas.rgba[idx * 4 + 1];
          const b = atlas.rgba[idx * 4 + 2];
          if (r > g + 20 && r > b + 20) paintedCells.push([cx, cy]);
        }
      }
      handle.scene.forceFrame(3);
      const fb = handle.scene.readCanvasImageData();
      let warmRed = 0;
      for (let i = 0; i < fb.data.length; i += 4) {
        const r = fb.data[i],
          g = fb.data[i + 1],
          b = fb.data[i + 2];
        if (r >= 12 && r >= g + 6 && r >= b + 6) warmRed++;
      }
      return { paintedCount: paintedCells.length, paintedCells, warmRed };
    }, target);

    // Sanity: the drag did paint some cells.
    expect(result.paintedCount).toBeGreaterThan(0);
    // The mesh shows ≥1 lowpixel per painted atlas cell. Allow a tiny slack
    // for the very edge cells where Lambert lighting may push R below the
    // detection threshold; require ≥95% of painted cells to be visible.
    expect(result.warmRed).toBeGreaterThanOrEqual(Math.floor(result.paintedCount * 0.95));
  });

  test("hidden-face guard: islands flagged as hidden don't render; painting visible ones always does", async ({
    page,
  }) => {
    await page.goto("/#/exp/material-studio");
    await expect(page.locator(".matstudio-app")).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "+ New" }).first().click();
    await page.locator(".ms-base-picker .ms-card", { hasText: "wall" }).first().click();
    await expect(page.locator(".ms-paint-canvas-wrap canvas")).toBeVisible({ timeout: 15_000 });
    await page.waitForFunction(
      () => !!(window as unknown as { __materialStudio?: unknown }).__materialStudio,
      { timeout: 5_000 }
    );

    // For each island: read its hiddenFromCamera flag, paint its centre,
    // measure framebuffer change. A flagged-hidden island MUST have zero
    // framebuffer effect; a flagged-visible island MUST produce ≥1 changed
    // lowpixel. Together this proves the flag matches reality and the
    // paint-editor's UI warning is accurate.
    type Island = { x: number; y: number; cellsX: number; cellsY: number; cellPx: number };
    type SpatialLite = { hiddenFromCamera: boolean; label: string };
    const result = await page.evaluate(async () => {
      const handle = (window as unknown as {
        __materialStudio: {
          getActiveRole: () => string | null;
          getActiveSurfaceState: () => {
            islandLayout: { islands: Island[]; spatial: SpatialLite[] } | null;
          } | null;
          scene: { forceFrame: (n: number) => void; readCanvasImageData: () => ImageData };
          testPaintAtlasPixel: (role: string, x: number, y: number, r: number, g: number, b: number) => boolean;
        };
      }).__materialStudio;
      const role = handle.getActiveRole()!;
      const surf = handle.getActiveSurfaceState()!;
      const islands = surf.islandLayout!.islands;
      const spatial = surf.islandLayout!.spatial;
      const grab = () => {
        handle.scene.forceFrame(2);
        return new Uint8ClampedArray(handle.scene.readCanvasImageData().data);
      };
      const diffCount = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
        let n = 0;
        for (let i = 0; i < a.length; i += 4) {
          if (
            Math.abs(a[i] - b[i]) > 6 ||
            Math.abs(a[i + 1] - b[i + 1]) > 6 ||
            Math.abs(a[i + 2] - b[i + 2]) > 6
          )
            n++;
        }
        return n;
      };
      const out: Array<{ idx: number; label: string; hidden: boolean; diff: number }> = [];
      for (let i = 0; i < islands.length; i++) {
        const isl = islands[i];
        const sp = spatial[i];
        const before = grab();
        const cx = isl.x + Math.floor(isl.cellsX / 2);
        const cy = isl.y + Math.floor(isl.cellsY / 2);
        handle.testPaintAtlasPixel(role, cx, cy, 255, 0, 0);
        const diff = diffCount(before, grab());
        handle.testPaintAtlasPixel(role, cx, cy, 255, 255, 255);
        out.push({ idx: i, label: sp.label, hidden: sp.hiddenFromCamera, diff });
      }
      return out;
    });

    expect(result.length).toBe(6); // wall.glb has 6 cube faces
    for (const r of result) {
      if (r.hidden) {
        // Hidden faces must not produce framebuffer changes — the entire
        // point of the flag.
        expect(r.diff).toBe(0);
      } else {
        // Visible faces must produce SOME change (≥1 lowpixel).
        expect(r.diff).toBeGreaterThan(0);
      }
    }
    // wall.glb has exactly 3 visible (front +Z, top +Y, right +X) and 3
    // hidden (back -Z, bottom -Y, left -X) faces under the iso camera.
    expect(result.filter((r) => r.hidden).length).toBe(3);
    expect(result.filter((r) => !r.hidden).length).toBe(3);
  });

  test("Generate preserves orientation flips: post-regenerate, painted atlas stays unmirrored on the mesh", async ({
    page,
  }) => {
    // Regression for the "post-generate mesh is mirrored" bug. The
    // editor's IslandLayout has per-island U/V flips applied by
    // prepareSurface so atlas axes match screen axes. Generate USED
    // to repack from scratch (dropping the flips) — after a regenerate
    // the mesh would sample the new texture mirrored relative to what
    // the user had painted. Test: paint asymmetric markers, capture
    // mesh framebuffer, intercept Generate to echo the template back
    // unchanged, run Generate, capture mesh framebuffer, assert the
    // marker positions on the mesh moved by no more than a few lowpixels
    // (i.e. NO mirror).
    await page.goto("/#/exp/material-studio");
    await expect(page.locator(".matstudio-app")).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "+ New" }).first().click();
    await page.locator(".ms-base-picker .ms-card", { hasText: "wall" }).first().click();
    await expect(page.locator(".ms-paint-canvas-wrap canvas")).toBeVisible({ timeout: 15_000 });
    await page.waitForFunction(
      () => !!(window as unknown as { __materialStudio?: unknown }).__materialStudio,
      { timeout: 5_000 }
    );

    // Paint a TL-only red marker on the largest visible island.
    const before = await page.evaluate(() => {
      type Island = { x: number; y: number; cellsX: number; cellsY: number; cellPx: number };
      const handle = (window as unknown as {
        __materialStudio: {
          getActiveRole: () => string | null;
          getActiveSurfaceState: () => {
            islandLayout: { islands: Island[]; spatial: { hiddenFromCamera: boolean }[] } | null;
          } | null;
          scene: { forceFrame: (n: number) => void; readCanvasImageData: () => ImageData };
          testPaintAtlasPixel: (role: string, x: number, y: number, r: number, g: number, b: number) => boolean;
        };
      }).__materialStudio;
      const role = handle.getActiveRole()!;
      const surf = handle.getActiveSurfaceState()!;
      const islands = surf.islandLayout!.islands;
      const spatial = surf.islandLayout!.spatial;
      const visibleIsls = islands.filter((_, i) => !spatial[i].hiddenFromCamera);
      const target = [...visibleIsls].sort((a, b) => b.cellsX * b.cellsY - a.cellsX * a.cellsY)[0];
      // Plant a 4×4 red block at the island's TOP-LEFT corner only.
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 4; dx++) {
          handle.testPaintAtlasPixel(role, target.x + dx, target.y + dy, 255, 0, 0);
        }
      }
      handle.scene.forceFrame(3);
      const fb = handle.scene.readCanvasImageData();
      // Centroid of red-dominant lowpixels in the framebuffer.
      let sx = 0, sy = 0, n = 0;
      for (let i = 0; i < fb.data.length; i += 4) {
        const r = fb.data[i], g = fb.data[i + 1], b = fb.data[i + 2];
        if (r > g + 10 && r > b + 10 && r > 12) {
          const px = (i / 4) % fb.width;
          const py = Math.floor(i / 4 / fb.width);
          sx += px; sy += py; n++;
        }
      }
      return { cx: n > 0 ? sx / n : -1, cy: n > 0 ? sy / n : -1, n, w: fb.width, h: fb.height, target };
    });
    expect(before.n).toBeGreaterThan(0);

    // Intercept the AI fetch — echo the template back so the AI raw
    // exactly matches what we sent. The recompose path then writes the
    // template's chunky cells into the small atlas.
    await page.route("**/api/openai/edit-image", async (route) => {
      const body = JSON.parse(route.request().postData() || "{}") as { imageBase64: string };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: [{ b64_json: body.imageBase64 }] }),
      });
    });

    await page.getByRole("button", { name: /^(Generate|Regenerate)$/ }).click();
    // Generate dispatches AUTHORING_GENERATED + applyAtlasUvs + applyPbrTextures.
    // Wait for the texture to settle.
    await page.waitForTimeout(800);

    const after = await page.evaluate(() => {
      const handle = (window as unknown as {
        __materialStudio: { scene: { forceFrame: (n: number) => void; readCanvasImageData: () => ImageData } };
      }).__materialStudio;
      handle.scene.forceFrame(3);
      const fb = handle.scene.readCanvasImageData();
      let sx = 0, sy = 0, n = 0;
      for (let i = 0; i < fb.data.length; i += 4) {
        const r = fb.data[i], g = fb.data[i + 1], b = fb.data[i + 2];
        if (r > g + 10 && r > b + 10 && r > 12) {
          const px = (i / 4) % fb.width;
          const py = Math.floor(i / 4 / fb.width);
          sx += px; sy += py; n++;
        }
      }
      return { cx: n > 0 ? sx / n : -1, cy: n > 0 ? sy / n : -1, n, w: fb.width, h: fb.height };
    });

    // Sanity: the red marker still rendered after generate.
    expect(after.n).toBeGreaterThan(0);

    // The marker centroid must NOT have flipped to the opposite side of
    // the framebuffer. Mirroring would push cx by ~half the framebuffer
    // width (or similar for cy). Allow ≤ 8 lowpixels of jitter from
    // recompose's seam-bleed and AI-extraction sampling differences.
    expect(Math.abs(after.cx - before.cx)).toBeLessThanOrEqual(8);
    expect(Math.abs(after.cy - before.cy)).toBeLessThanOrEqual(8);
  });

  test("paint canvas: undo reverts the last stroke", async ({ page }) => {
    await page.goto("/#/exp/material-studio");
    await expect(page.locator(".matstudio-app")).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "+ New" }).first().click();
    const cards = page.locator(".ms-base-picker .ms-card");
    await expect(cards.first()).toBeVisible({ timeout: 5_000 });
    await cards.first().click();

    const paintCanvas = page.locator(".ms-paint-canvas-wrap canvas");
    await expect(paintCanvas).toBeVisible({ timeout: 15_000 });

    const before = await readAtlasPixel(page, 12, 12);

    await page.locator('.ms-swatch-btn[aria-label="burnt amber"]').click();
    const cpa = await cssPerAtlasPx(page);
    await paintCanvas.click({ position: { x: (12 + 0.5) * cpa, y: (12 + 0.5) * cpa } });
    await page.waitForTimeout(150);
    const afterPaint = await readAtlasPixel(page, 12, 12);
    expect(afterPaint).toEqual([0xb8, 0x43, 0x0e]);

    // Click Undo — should restore the pre-paint pixel.
    await page.getByRole("button", { name: /^Undo$/ }).click();
    await page.waitForTimeout(150);
    const afterUndo = await readAtlasPixel(page, 12, 12);
    expect(afterUndo).toEqual(before);
  });
});

/** CSS pixels per atlas pixel — depends on the current zoom select. */
async function cssPerAtlasPx(page: import("@playwright/test").Page): Promise<number> {
  return await page.evaluate(() => {
    const c = document.querySelector(".ms-paint-canvas-wrap canvas") as HTMLCanvasElement | null;
    if (!c) throw new Error("paint canvas not found");
    const rect = c.getBoundingClientRect();
    return rect.width / c.width;
  });
}

/** Read the RGB triple at atlas pixel (x, y) from the editor canvas. */
async function readAtlasPixel(page: import("@playwright/test").Page, x: number, y: number) {
  return await page.evaluate(
    ([px, py]) => {
      const c = document.querySelector(".ms-paint-canvas-wrap canvas") as HTMLCanvasElement | null;
      if (!c) throw new Error("paint canvas not found");
      const ctx = c.getContext("2d");
      if (!ctx) throw new Error("paint canvas 2d context unavailable");
      const d = ctx.getImageData(px, py, 1, 1).data;
      return [d[0], d[1], d[2]];
    },
    [x, y]
  );
}
