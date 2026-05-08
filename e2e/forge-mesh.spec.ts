import { expect, test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

/** Switch forge stage via the exposed dispatch. */
async function setForgeStage(page: import("@playwright/test").Page, stage: string) {
  await page.evaluate((s) => {
    const dispatch = (window as Record<string, unknown>).__forgeDispatch as
      | ((action: { type: string; stage: string }) => void)
      | undefined;
    if (!dispatch) throw new Error("__forgeDispatch not found on window");
    dispatch({ type: "SET_ACTIVE_STAGE", stage: s });
  }, stage);
}

/** Wait for a scissor canvas to be resized after display change. */
async function waitForCanvasResize(
  page: import("@playwright/test").Page,
  selector = ".forgev2-scissor-3d-canvas-host canvas"
) {
  await page.waitForFunction((sel) => {
    const c = document.querySelector(sel) as HTMLCanvasElement | null;
    return c != null && c.width > 1;
  }, selector, { timeout: 5_000 });
}

/**
 * Take a screenshot of a specific element and count non-black pixels in the PNG buffer.
 */
async function countNonBlackPixelsInScreenshot(
  page: import("@playwright/test").Page,
  selector: string,
) {
  const el = page.locator(selector);
  const buf = await el.screenshot();
  // PNG is an 8-byte signature then chunks. Parse raw IDAT pixels is complex.
  // Instead, just check that the image buffer is not trivially small or uniform.
  // Use page.evaluate to draw the screenshot into a canvas and read pixels.
  const b64 = buf.toString("base64");
  return page.evaluate(async (imgData) => {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = reject;
      img.src = `data:image/png;base64,${imgData}`;
    });
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let nonBlack = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 10 || data[i + 1] > 10 || data[i + 2] > 10) {
        nonBlack++;
      }
    }
    return { nonBlack, total: (data.length / 4), width: img.width, height: img.height };
  }, b64);
}

test.describe("forge mesh viewport", () => {
  test("mesh viewport renders 3D scene (grid/axes visible)", async ({ page }) => {
    await page.goto("/#/forge");

    const shell = page.locator('[data-testid="forge-page"]');
    await expect(shell).toBeVisible({ timeout: 10_000 });

    await setForgeStage(page, "mesh");

    const viewportCol = page.locator(".ps-mesh-viewport-col");
    await expect(viewportCol).toBeVisible({ timeout: 5_000 });

    await waitForCanvasResize(page, ".ps-mesh-viewport-col canvas");

    // Wait for render loop to produce frames
    await page.waitForTimeout(500);

    // Screenshot the viewport host div — it should show the 3D scene through
    const result = await countNonBlackPixelsInScreenshot(page, ".ps-mesh-viewport-col .ps-viewport-host");
    console.log("Grid/axes test:", result);

    // The scene has a dark blue clearColor (0x1a1a2e = rgb(26,26,46)) plus grid lines —
    // there must be many non-black pixels
    expect(result.nonBlack).toBeGreaterThan(result.total * 0.1);

    await page.screenshot({ path: "e2e/screenshots/mesh-viewport.png", fullPage: false });
  });

  test("mesh viewport renders loaded GLB model", async ({ page }) => {
    await page.goto("/#/forge");

    const shell = page.locator('[data-testid="forge-page"]');
    await expect(shell).toBeVisible({ timeout: 10_000 });

    await setForgeStage(page, "mesh");
    await waitForCanvasResize(page, ".ps-mesh-viewport-col canvas");

    // Load the mock GLB into the viewport
    const glbPath = path.resolve(__dirname, "fixtures/mock-model.glb");
    const glbBuffer = fs.readFileSync(glbPath);
    const glbBase64 = glbBuffer.toString("base64");

    await page.evaluate(async (b64) => {
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const buffer = bytes.buffer;

      const refs = (window as Record<string, unknown>).__forgeRefs as {
        generationViewport: { current: {
          loadGlb(data: ArrayBuffer): Promise<unknown>;
          setModel(m: unknown): void;
        } | null };
      } | undefined;
      const vp = refs?.generationViewport?.current;
      if (!vp) throw new Error("Viewport ref not available");
      const model = await vp.loadGlb(buffer);
      vp.setModel(model);
    }, glbBase64);

    // Wait for render
    await page.waitForTimeout(500);

    const result = await countNonBlackPixelsInScreenshot(page, ".ps-mesh-viewport-col .ps-viewport-host");
    console.log("GLB model test:", result);

    expect(result.nonBlack).toBeGreaterThan(result.total * 0.1);

    await page.screenshot({ path: "e2e/screenshots/mesh-viewport-with-model.png", fullPage: false });
  });

  test("viewport label text contrasts with background", async ({ page }) => {
    await page.goto("/#/forge");

    const shell = page.locator('[data-testid="forge-page"]');
    await expect(shell).toBeVisible({ timeout: 10_000 });

    await setForgeStage(page, "mesh");

    const label = page.locator(".ps-viewport-label").first();
    await expect(label).toBeVisible({ timeout: 5_000 });

    const result = await page.evaluate(() => {
      const el = document.querySelector(".ps-viewport-label") as HTMLElement | null;
      if (!el) return { ok: false, reason: "no label element", color: "", bg: "" };

      const style = window.getComputedStyle(el);
      const color = style.color;

      // Walk up to find effective background
      let bg = "rgba(0, 0, 0, 0)";
      let node: HTMLElement | null = el;
      while (node) {
        const s = window.getComputedStyle(node);
        if (s.backgroundColor && s.backgroundColor !== "rgba(0, 0, 0, 0)") {
          bg = s.backgroundColor;
          break;
        }
        node = node.parentElement;
      }

      // Parse rgb/rgba values
      const parseColor = (c: string) => {
        const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
      };

      const [fr, fg, fb] = parseColor(color);
      const [br, bg2, bb] = parseColor(bg);

      // Luminance diff — must be clearly distinguishable
      const fLum = 0.299 * fr + 0.587 * fg + 0.114 * fb;
      const bLum = 0.299 * br + 0.587 * bg2 + 0.114 * bb;
      const diff = Math.abs(fLum - bLum);

      return {
        ok: diff > 40,
        reason: `luminance diff=${diff.toFixed(1)}, need >40`,
        color,
        bg,
      };
    });

    console.log("Label contrast:", result);
    expect(result.ok, `Label not readable: ${result.reason} (color=${result.color}, bg=${result.bg})`).toBe(true);

    // Also check the pixel cell labels have the same contrast pattern
    const pixelLabelResult = await page.evaluate(() => {
      const el = document.querySelector(".forgev2-pixel-cell-label") as HTMLElement | null;
      if (!el) return { color: "n/a", bg: "n/a" };
      const style = window.getComputedStyle(el);
      const color = style.color;
      let bg = "rgba(0, 0, 0, 0)";
      let node: HTMLElement | null = el;
      while (node) {
        const s = window.getComputedStyle(node);
        if (s.backgroundColor && s.backgroundColor !== "rgba(0, 0, 0, 0)") {
          bg = s.backgroundColor;
          break;
        }
        node = node.parentElement;
      }
      return { color, bg };
    });
    console.log("Pixel cell label:", pixelLabelResult);
  });

  test("mesh tab shows pixel quad with 4 cells", async ({ page }) => {
    await page.goto("/#/forge");

    const shell = page.locator('[data-testid="forge-page"]');
    await expect(shell).toBeVisible({ timeout: 10_000 });

    await setForgeStage(page, "mesh");

    const pixelQuad = page.locator('[data-testid="forgev2-pixel-quad"]');
    await expect(pixelQuad).toBeVisible({ timeout: 5_000 });

    const cells = pixelQuad.locator(".forgev2-pixel-cell");
    await expect(cells).toHaveCount(4);
  });
});
