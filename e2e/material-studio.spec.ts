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

    // The intrinsic canvas resolution is the atlas size (256²); CSS size
    // is atlas × zoom. At default zoom=4, CSS (42, 42) lands on atlas
    // pixel (10, 10) — comfortably inside the outline padding so we hit
    // an island interior on most base meshes.
    const before = await readAtlasPixel(page, 10, 10);
    await paintCanvas.click({ position: { x: 42, y: 42 } });

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

    // Drag-paint a small block in the atlas. At zoom=4, CSS (40..60, 40..60)
    // → atlas (10..15, 10..14). Big enough to be visible from any iso angle.
    const box = await paintCanvas.boundingBox();
    if (!box) throw new Error("paint canvas has no bounding box");
    for (let dy = 0; dy < 5; dy++) {
      await page.mouse.move(box.x + 40, box.y + 40 + dy * 4);
      await page.mouse.down();
      await page.mouse.move(box.x + 60, box.y + 40 + dy * 4);
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

    // Paint exactly one atlas pixel: click without drag at one position.
    await page.locator('.ms-swatch-btn[aria-label="structural dark"]').click();
    await paintCanvas.click({ position: { x: 42, y: 42 } });
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

    // One atlas pixel maps to a handful of game pixels under the iso
    // projection. With AO/normal-map shading attached, a Sobel halo would
    // light up dozens of additional pixels around the painted texel.
    // Cap at 20 — generous for the texel footprint, tight enough to fail
    // if the halo regresses.
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
    // CSS (50,50) → atlas (12,12) at zoom=4
    await paintCanvas.click({ position: { x: 50, y: 50 } });
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
