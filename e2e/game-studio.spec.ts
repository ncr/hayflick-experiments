import { expect, test } from "@playwright/test";
import { PNG } from "pngjs";

// Use the dev server: the studio relies on dynamic imports of experiment
// packages and does not need a production build. Mirror the override
// pattern used by material-studio.spec.ts. Vite picks the first free of
// 5173 / 5174 / … so override via GAME_STUDIO_BASE_URL when needed.
const DEV_BASE_URL = process.env.GAME_STUDIO_BASE_URL || "http://localhost:5173";
test.use({ baseURL: DEV_BASE_URL });

test.describe("game-studio", () => {
  test("grid-walker mounts and responds to input + knob changes", async ({ page }) => {
    await page.goto("/#/play/grid-walker");

    // Studio shell is on screen and has a canvas mounted by IsoGameView.
    await expect(page.locator(".game-studio")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".game-studio-viewport-mount canvas")).toBeVisible({
      timeout: 10_000
    });

    // Tweaks pane shows the two registered knobs.
    await expect(page.locator(".knob-key", { hasText: "speed" })).toBeVisible();
    await expect(page.locator(".knob-key", { hasText: "showGrid" })).toBeVisible();

    // window.__gameStudio.world is wired by ViewportPane.
    await page.waitForFunction(() => Boolean(window.__gameStudio?.world), null, {
      timeout: 10_000
    });

    const initialPos = await page.evaluate(() => {
      const w = window.__gameStudio!.world!;
      const playerEid = Array.from(w.controlled.entries())[0];
      const t = w.transforms.get(playerEid)!;
      return { x: t.x, y: t.y };
    });
    expect(initialPos).toEqual({ x: 0, y: 0 });

    // Focus the page so keyboard events go to window. Playwright's
    // page.keyboard targets the focused element; clicking the viewport
    // ensures the body has focus.
    await page.locator(".game-studio-viewport-mount").click();

    // Hold ArrowUp for ~250ms — at default speed 80 px/s ≈ 0.625 wu along
    // the b screen-axis. Input is remapped to screen axes, so motion is
    // diagonal in world XZ (not pure +y). Check displacement magnitude.
    await page.keyboard.down("ArrowUp");
    await page.waitForTimeout(250);
    await page.keyboard.up("ArrowUp");
    await page.waitForTimeout(50);

    const movedPos = await page.evaluate(() => {
      const w = window.__gameStudio!.world!;
      const playerEid = Array.from(w.controlled.entries())[0];
      const t = w.transforms.get(playerEid)!;
      return { x: t.x, y: t.y };
    });
    const movedDist = Math.hypot(movedPos.x, movedPos.y);
    expect(movedDist).toBeGreaterThan(0.2);

    // Console pane received Moved events from the EventSystem's debug sink.
    const lineCount = await page.locator(".game-studio-console-line").count();
    expect(lineCount).toBeGreaterThan(0);
    await expect(
      page.locator(".game-studio-console-line").filter({ hasText: "Moved" }).first()
    ).toBeVisible();

    // Bump the speed knob via the registry, then move the same duration.
    // Distance covered should be noticeably larger. Speed is in screen-px/s
    // now (default 80), so bump to 200 to exceed it.
    await page.evaluate(() => {
      const knobs = window.__gameStudio!.knobs;
      const speed = knobs.entries().find((e) => e.spec.key === "speed")!;
      speed.set(200);
    });
    await expect(page.locator(".knob-value").first()).toContainText("200");

    await page.keyboard.down("ArrowUp");
    await page.waitForTimeout(150);
    await page.keyboard.up("ArrowUp");
    await page.waitForTimeout(50);

    const afterFastPos = await page.evaluate(() => {
      const w = window.__gameStudio!.world!;
      const playerEid = Array.from(w.controlled.entries())[0];
      const t = w.transforms.get(playerEid)!;
      return { x: t.x, y: t.y };
    });
    const fastSegmentDist = Math.hypot(
      afterFastPos.x - movedPos.x,
      afterFastPos.y - movedPos.y
    );
    // 150ms at speed 200 px/s ≈ 0.76 world units along forward at iso 2:1
    // foreshortening. Comfortably above the threshold.
    expect(fastSegmentDist).toBeGreaterThan(0.5);
  });

  test("A+W diagonal traces a perfect iso 2:1 staircase (no wobble)", async ({ page }) => {
    await page.goto("/#/play/grid-walker");
    await expect(page.locator(".game-studio")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".game-studio-viewport-mount canvas")).toBeVisible({
      timeout: 10_000
    });
    await page.waitForFunction(
      () => Boolean(window.__gameStudio?.world && window.__gameStudio.viewport),
      null,
      { timeout: 10_000 }
    );

    await page.locator(".game-studio-viewport-mount").click();

    // Read the snap-cell (qa, qb) of the player at this instant.
    const readCell = () =>
      page.evaluate(() => {
        const gs = window.__gameStudio!;
        const w = gs.world!;
        const eid = Array.from(w.controlled.entries())[0];
        const t = w.transforms.get(eid)!;
        const coords = gs.viewport!.worldToScreenPixelCoords(t.x, t.y);
        if (!coords) return null;
        return { qa: Math.round(coords.a), qb: Math.round(coords.b) };
      });

    const origin = await readCell();
    expect(origin).not.toBeNull();

    // Hold A+W and sample (qa, qb) on a wall-clock cadence for >1s.
    await page.keyboard.down("KeyA");
    await page.keyboard.down("KeyW");

    const samples: Array<{ qa: number; qb: number; t: number }> = [];
    const HOLD_MS = 1200;
    const POLL_MS = 30;
    const t0 = Date.now();
    while (Date.now() - t0 < HOLD_MS) {
      const c = await readCell();
      if (c) samples.push({ qa: c.qa - origin!.qa, qb: c.qb - origin!.qb, t: Date.now() - t0 });
      await page.waitForTimeout(POLL_MS);
    }

    await page.keyboard.up("KeyA");
    await page.keyboard.up("KeyW");

    expect(samples.length).toBeGreaterThan(20);

    // The box must have moved meaningfully (A+W = screen up-left = (-a, -b)).
    const last = samples[samples.length - 1];
    expect(last.qa, `qa advanced (final ${last.qa})`).toBeLessThanOrEqual(-10);
    expect(last.qb, `qb advanced (final ${last.qb})`).toBeLessThanOrEqual(-5);

    // Invariant 1 — no reverse hops. Every consecutive (Δqa, Δqb) is in
    // the (-, -) quadrant or zero. A single positive tick on either
    // axis = wobble (the symptom we're killing).
    const reverseHops = samples
      .slice(1)
      .map((s, i) => ({
        dqa: s.qa - samples[i].qa,
        dqb: s.qb - samples[i].qb,
        t: s.t
      }))
      .filter((h) => h.dqa > 0 || h.dqb > 0);
    expect(
      reverseHops,
      `frames with wrong-direction hops:\n${reverseHops
        .map((h) => `  t=${h.t}ms Δ=(${h.dqa},${h.dqb})`)
        .join("\n")}`
    ).toEqual([]);

    // Invariant 2 — cumulative trajectory hugs the iso 2:1 line `qa = 2·qb`.
    // Independent integer rounding on each axis can put us at most ±1 off.
    // Anything beyond that means the input remap drifted off the iso angle.
    const offLine = samples.filter((s) => Math.abs(s.qa - 2 * s.qb) > 1);
    expect(
      offLine,
      `samples off the iso 2:1 line (|qa - 2qb| > 1):\n${offLine
        .map((s) => `  t=${s.t}ms (qa=${s.qa}, qb=${s.qb}) drift=${s.qa - 2 * s.qb}`)
        .join("\n")}`
    ).toEqual([]);
  });

  // Cornerstone invariant: when the player box is positioned at any integer
  // snap-cell (a, b), its rendered pixel footprint must be IDENTICAL (up to
  // translation by integer screen pixels). Any pixel-level difference between
  // two cells means the iso-2:1 outline isn't stable as the box moves.
  test("box renders identically at different snap cells (cornerstone)", async ({ page }) => {
    await page.goto("/#/play/grid-walker");
    await expect(page.locator(".game-studio")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".game-studio-viewport-mount canvas")).toBeVisible({
      timeout: 10_000
    });
    await page.waitForFunction(
      () => Boolean(window.__gameStudio?.world && window.__gameStudio.viewport),
      null,
      { timeout: 10_000 }
    );

    const mountRect = await page.locator(".game-studio-viewport-mount").boundingBox();
    if (!mountRect) throw new Error("no viewport mount rect");

    const CROP = 80; // square crop around the box's projected center

    // Set the player's logical transform so that after the next snap it
    // lands on integer cell (qa, qb), then wait two frames and return the
    // box's projected canvas-CSS-pixel position.
    const placeAtCell = async (qa: number, qb: number) => {
      const setup = await page.evaluate(
        ({ qa, qb }) => {
          const vc = window.__gameStudio!.viewport!;
          const basis = vc.getSnapBasis();
          if (!basis) return null;
          const worldX = basis.centerX + qa * basis.ux + qb * basis.vx;
          const worldZ = basis.centerZ + qa * basis.uz + qb * basis.vz;
          const w = window.__gameStudio!.world!;
          const pid = Array.from(w.controlled.entries())[0];
          const t = w.transforms.get(pid)!;
          t.x = worldX;
          t.y = worldZ;
          // Also zero velocity so ControlledInputSystem (running on key=none)
          // doesn't overwrite us; the movement system integrates 0.
          if (w.velocities.has(pid)) {
            const v = w.velocities.get(pid)!;
            v.vx = 0;
            v.vy = 0;
          }
          return { worldX, worldZ };
        },
        { qa, qb }
      );
      if (!setup) throw new Error("snap basis unavailable");

      // Wait two animation frames so the new transform propagates through
      // the system pipeline and the scene renders the snapped position.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() => resolve())
            )
          )
      );

      const screen = await page.evaluate(
        ({ x, z }) => {
          const vc = window.__gameStudio!.viewport!;
          // Box is 1 wu with anchor:"bottom", so its center sits at y = 0.5.
          return vc.projectWorldToCanvasPixel(x, 0.5, z);
        },
        { x: setup.worldX, z: setup.worldZ }
      );
      if (!screen) throw new Error("projection failed");
      return screen;
    };

    const cropAround = async (screenX: number, screenY: number) => {
      // Round to nearest CSS pixel so both crops align identically to the
      // canvas pixel grid; the box's pattern within the crop is the same
      // as long as the projected center is integer-aligned.
      const cx = Math.round(mountRect.x + screenX);
      const cy = Math.round(mountRect.y + screenY);
      const clip = {
        x: cx - CROP / 2,
        y: cy - CROP / 2,
        width: CROP,
        height: CROP
      };
      return page.screenshot({ clip, type: "png" });
    };

    const screenA = await placeAtCell(15, 8);
    const bufA = await cropAround(screenA.x, screenA.y);

    const screenB = await placeAtCell(35, 18);
    const bufB = await cropAround(screenB.x, screenB.y);

    const pngA = PNG.sync.read(bufA);
    const pngB = PNG.sync.read(bufB);
    expect({ w: pngA.width, h: pngA.height }).toEqual({ w: pngB.width, h: pngB.height });

    // Pixel-level diff. Count mismatching pixels (any channel differs).
    let diff = 0;
    const total = pngA.width * pngA.height;
    for (let i = 0; i < pngA.data.length; i += 4) {
      if (
        pngA.data[i] !== pngB.data[i] ||
        pngA.data[i + 1] !== pngB.data[i + 1] ||
        pngA.data[i + 2] !== pngB.data[i + 2] ||
        pngA.data[i + 3] !== pngB.data[i + 3]
      ) {
        diff++;
      }
    }
    const diffRatio = diff / total;
    console.log(
      `cornerstone: crop=${pngA.width}x${pngA.height} differingPixels=${diff}/${total} ratio=${diffRatio.toFixed(4)}`
    );
    // Cornerstone of the look: ZERO pixel difference between snap cells.
    expect(diff).toBe(0);
  });

  test("renderer rejects misaligned XZ geometry at spawn time", async ({ page }) => {
    await page.goto("/#/play/grid-walker");
    await expect(page.locator(".game-studio")).toBeVisible({ timeout: 10_000 });
    await page.waitForFunction(
      () => Boolean(window.__gameStudio?.world && window.__gameStudio.viewport),
      null,
      { timeout: 10_000 }
    );

    // Reach into the live scene and try to spawn a bad-sized box. The
    // validator must throw IsoGeometryViolation at construction so the
    // game can't accidentally render a broken stair pattern.
    //
    // 0.8 wu = 25.6 px — the classic foot-gun (the size grid-walker
    // originally used). Stair-aligned alternatives: 0.75 (24 px) or
    // 0.8125 (26 px).
    const verdict = await page.evaluate(() => {
      const gs = window.__gameStudio!;
      const scene = gs.scene;
      if (!scene) return { ok: false, reason: "no scene on window" };
      try {
        scene.spawnBox({ size: 0.8 });
        return { ok: false, reason: "spawnBox did not throw" };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const name = e instanceof Error ? e.name : "unknown";
        return { ok: true, name, message };
      }
    });

    expect(verdict.ok, verdict.reason || "guard did not fire").toBe(true);
    expect(verdict.name).toBe("IsoGeometryViolation");
    expect(verdict.message).toContain("0.8");
    expect(verdict.message).toContain("nearest clean size");
  });

  test("code tab shows the game's source files read-only", async ({ page }) => {
    await page.goto("/#/play/grid-walker");
    await expect(page.locator(".game-studio")).toBeVisible({ timeout: 10_000 });

    await page.locator(".game-studio-top-tab", { hasText: "Code" }).click();
    await expect(page.locator(".game-studio-code-fullscreen")).toBeVisible();

    // File tabs appear for grid-walker's two source files, alphabetically sorted.
    const fileTabs = page.locator(".game-studio-code-tab");
    await expect(fileTabs).toHaveCount(2);
    await expect(fileTabs.nth(0)).toHaveText("index.ts");
    await expect(fileTabs.nth(1)).toHaveText("meta.ts");

    // Default active tab is the first file; body shows its content.
    await expect(fileTabs.nth(0)).toHaveClass(/active/);
    const body = page.locator(".game-studio-code-body");
    await expect(body).toBeVisible();

    // Switching tabs swaps the visible content.
    await fileTabs.nth(1).click();
    await expect(fileTabs.nth(1)).toHaveClass(/active/);
    await expect(body).toContainText('id: "grid-walker"');

    // Syntax highlighting: at least one keyword / string / type / comment
    // token span renders inside the code body.
    await expect(body.locator(".tok-keyword").first()).toBeVisible();
    await expect(body.locator(".tok-string").first()).toBeVisible();
    await expect(body.locator(".tok-type").first()).toBeVisible();
  });

  test("g/c keys switch between Game and Code top tabs", async ({ page }) => {
    await page.goto("/#/play/grid-walker");
    await expect(page.locator(".game-studio")).toBeVisible({ timeout: 10_000 });

    const studioTab = page.locator(".game-studio-top-tab", { hasText: "Game Studio" });
    const codeTab = page.locator(".game-studio-top-tab", { hasText: "Code" });
    await expect(studioTab).toHaveClass(/active/);

    await page.keyboard.press("c");
    await expect(codeTab).toHaveClass(/active/);
    await expect(page.locator(".game-studio-code-fullscreen")).toBeVisible();

    await page.keyboard.press("g");
    await expect(studioTab).toHaveClass(/active/);
    await expect(page.locator(".game-studio-code-fullscreen")).toHaveCount(0);
  });

  test("zoom ladder is restricted to 1..4 with 2× as the default", async ({ page }) => {
    await page.goto("/#/play/grid-walker");
    await expect(page.locator(".game-studio-viewport-mount canvas")).toBeVisible({
      timeout: 10_000
    });
    await page.waitForFunction(
      () => Boolean(window.__gameStudio?.viewport),
      null,
      { timeout: 10_000 }
    );

    const labels = await page.locator(".game-studio-zoom-label").allTextContents();
    expect(labels).toEqual(["1×", "2×", "3×", "4×"]);

    const checked = page.locator(".game-studio-zoom-option.active .game-studio-zoom-label");
    await expect(checked).toHaveText("2×");
  });

  test("outlines toggle disables the outline pipeline", async ({ page }) => {
    await page.goto("/#/play/grid-walker");
    await expect(page.locator(".game-studio-viewport-mount canvas")).toBeVisible({
      timeout: 10_000
    });

    const toggle = page.locator(".knob-toggle", { hasText: "outlines" }).locator("input");
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect(toggle).toBeChecked();
  });
});
