import { expect, test } from "@playwright/test";

/** Switch forge stage via the exposed dispatch. */
async function setForgeStage(page: import("@playwright/test").Page, stage: string) {
  await page.evaluate((s) => {
    const dispatch = (window as Record<string, unknown>).__forgeDispatch as
      | ((action: Record<string, unknown>) => void)
      | undefined;
    if (!dispatch) throw new Error("__forgeDispatch not found on window");
    dispatch({ type: "SET_ACTIVE_STAGE", stage: s });
  }, stage);
}

/** Set up a minimal physics prop so the PhysicsWorkspace renders viewports. */
async function setupPhysicsProp(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    const dispatch = (window as Record<string, unknown>).__forgeDispatch as
      | ((action: Record<string, unknown>) => void)
      | undefined;
    if (!dispatch) throw new Error("__forgeDispatch not found on window");

    // Minimal meta that satisfies the physicsSelectedPropId && meta guard
    const meta = {
      id: "test-prop",
      description: "test prop",
      lifecycle: {
        status: "mesh-ready",
      },
      generation: {
        image: { revision: 1 },
        mesh: { faceLimit: 5000, pbr: true, revision: 1 },
      },
      processing: {
        mesh: {},
        transform: {
          unitScaleMetersPerUnit: 1.28,
          targetDimension: { method: "max", value: 1 },
          scale: [1, 1, 1],
          provisionalPivot: { preset: "bottom-center", offset: [0, 0, 0], basis: "mesh" },
        },
      },
      pixelPreview: {
        cameraSyncState: { target: [0, 0, 0], yawTurns: 0, zoomLevel: 1 },
      },
    };

    dispatch({ type: "SET_PHYSICS_PROP", propId: "test-prop", meta, conceptImage: null });
  });
}

/** Wait for a scissor canvas to be present and sized. */
async function waitForCanvasResize(
  page: import("@playwright/test").Page,
  selector = ".forgev2-scissor-3d-canvas-host canvas"
) {
  await page.waitForFunction((sel) => {
    const c = document.querySelector(sel) as HTMLCanvasElement | null;
    return c != null && c.width > 1;
  }, selector, { timeout: 5_000 });
}

test.describe("forge physics viewport", () => {
  test("physics source mesh viewport accepts pointer events for rotation", async ({ page }) => {
    await page.goto("/#/forge");

    const shell = page.locator('[data-testid="forge-page"]');
    await expect(shell).toBeVisible({ timeout: 10_000 });

    await setForgeStage(page, "phy");
    await setupPhysicsProp(page);

    // Wait for the physics workspace to mount
    const physicsWorkspace = page.locator('.ps-physics-workspace');
    await expect(physicsWorkspace).toBeVisible({ timeout: 5_000 });

    // Scope to the source mesh interactive viewport (in the scroll row, not sim rows)
    const physicsViewport = physicsWorkspace.locator('.ps-viewport-row-scroll .ps-viewport-host-interactive');
    await expect(physicsViewport).toBeVisible({ timeout: 5_000 });

    await waitForCanvasResize(page, ".ps-physics-workspace .forgev2-scissor-3d-canvas-host canvas");
    await page.waitForTimeout(300);

    // The interactive viewport host must receive pointer events.
    // Verify that no ancestor in the DOM blocks pointer-events.
    const pointerEventsOk = await page.evaluate(() => {
      const host = document.querySelector('.ps-physics-workspace .ps-viewport-row-scroll .ps-viewport-host-interactive') as HTMLElement | null;
      if (!host) return { ok: false, reason: "no host element" };

      // Walk up the DOM tree checking computed pointer-events
      let el: HTMLElement | null = host.parentElement;
      while (el) {
        const style = window.getComputedStyle(el);
        const pe = style.pointerEvents;
        if (pe === "none") {
          return {
            ok: false,
            reason: `ancestor ${el.tagName}.${el.className} has pointer-events: none`,
          };
        }
        el = el.parentElement;
      }
      return { ok: true, reason: "" };
    });

    expect(pointerEventsOk.ok, pointerEventsOk.reason).toBe(true);

    // Verify OrbitControls actually responds: dispatch pointer events
    // on the viewport host and check the camera yaw/pitch changes.
    const rotated = await page.evaluate(async () => {
      const host = document.querySelector('.ps-physics-workspace .ps-viewport-row-scroll .ps-viewport-host-interactive') as HTMLElement | null;
      if (!host) return { changed: false, reason: "no host" };

      const refs = (window as Record<string, unknown>).__forgeRefs as {
        physicsMeshViewport: { current: { getViewState(): { yaw: number; pitch: number } | null } | null };
      } | undefined;
      const vp = refs?.physicsMeshViewport?.current;
      if (!vp) return { changed: false, reason: "no viewport ref" };

      const before = vp.getViewState();
      if (!before) return { changed: false, reason: "no view state" };

      const rect = host.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;

      // Simulate drag: pointerdown, several pointermoves, pointerup
      host.dispatchEvent(new PointerEvent("pointerdown", {
        clientX: cx, clientY: cy, button: 0, pointerId: 1, bubbles: true
      }));
      for (let i = 1; i <= 10; i++) {
        host.dispatchEvent(new PointerEvent("pointermove", {
          clientX: cx + i * 8, clientY: cy + i * 4, pointerId: 1, bubbles: true
        }));
      }
      host.dispatchEvent(new PointerEvent("pointerup", {
        clientX: cx + 80, clientY: cy + 40, pointerId: 1, bubbles: true
      }));

      // Wait a frame for OrbitControls to process
      await new Promise((r) => requestAnimationFrame(r));

      const after = vp.getViewState();
      if (!after) return { changed: false, reason: "no view state after" };

      const yawDelta = Math.abs(after.yaw - before.yaw);
      const pitchDelta = Math.abs(after.pitch - before.pitch);
      return {
        changed: yawDelta > 0.01 || pitchDelta > 0.01,
        yawDelta,
        pitchDelta,
        reason: `yaw delta=${yawDelta.toFixed(4)}, pitch delta=${pitchDelta.toFixed(4)}`
      };
    });

    expect(rotated.changed, `OrbitControls did not respond: ${rotated.reason}`).toBe(true);
  });

  test("physics sim scenario viewports and pixel quads are mounted", async ({ page }) => {
    await page.goto("/#/forge");

    const shell = page.locator('[data-testid="forge-page"]');
    await expect(shell).toBeVisible({ timeout: 10_000 });

    await setForgeStage(page, "phy");
    await setupPhysicsProp(page);

    // Wait for the physics workspace to mount
    const physicsWorkspace = page.locator('.ps-physics-workspace');
    await expect(physicsWorkspace).toBeVisible({ timeout: 5_000 });

    await waitForCanvasResize(page, ".ps-physics-workspace .forgev2-scissor-3d-canvas-host canvas");

    // Sim rows should exist for each scenario
    const simRows = page.locator('.ps-physics-sim-rows .ps-viewport-card');
    await expect(simRows).toHaveCount(3, { timeout: 5_000 });

    // Each sim row should have a viewport host and a pixel strip with 4 cells
    for (let i = 0; i < 3; i++) {
      const row = simRows.nth(i);
      await expect(row.locator('.ps-viewport-host')).toBeVisible();
      await expect(row.locator('.ps-pixel-strip')).toBeVisible();

      const cells = row.locator('.forgev2-pixel-cell');
      await expect(cells).toHaveCount(4);
    }

    // All 3 sim viewport hosts should have non-zero dimensions
    const simViewportResults = await page.evaluate(() => {
      const viewports = document.querySelectorAll('.ps-physics-sim-rows .ps-viewport-host');
      return Array.from(viewports).map((vp) => {
        const rect = vp.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      });
    });
    expect(simViewportResults.length).toBe(3);
    for (const r of simViewportResults) {
      expect(r.width).toBeGreaterThan(50);
      expect(r.height).toBeGreaterThan(50);
    }

    // All pixel cells should have non-zero dimensions (needed for scissor rendering)
    const pixelCellDimensions = await page.evaluate(() => {
      const cells = document.querySelectorAll('.ps-physics-sim-rows .forgev2-pixel-cell');
      return Array.from(cells).map((cell) => {
        const rect = cell.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      });
    });
    expect(pixelCellDimensions.length).toBe(12); // 3 scenarios × 4 angles
    for (const c of pixelCellDimensions) {
      expect(c.width).toBeGreaterThan(10);
      expect(c.height).toBeGreaterThan(10);
    }
  });
});
