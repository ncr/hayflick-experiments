import { expect, test } from "@playwright/test";

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
    await expect(page.locator(".knob-key", { hasText: "player.speed" })).toBeVisible();
    await expect(page.locator(".knob-key", { hasText: "debug.showGrid" })).toBeVisible();

    // window.__gameStudio.world is wired by ViewportPane.
    await page.waitForFunction(() => Boolean(window.__gameStudio?.world), null, {
      timeout: 10_000
    });

    const initialPos = await page.evaluate(() => {
      const w = window.__gameStudio!.world!;
      const playerEid = Array.from(w.playerTags.entries())[0];
      const t = w.transforms.get(playerEid)!;
      return { x: t.x, y: t.y };
    });
    expect(initialPos).toEqual({ x: 0, y: 0 });

    // Focus the page so keyboard events go to window. Playwright's
    // page.keyboard targets the focused element; clicking the viewport
    // ensures the body has focus.
    await page.locator(".game-studio-viewport-mount").click();

    // Hold ArrowUp for ~250ms — at default speed 4 that's ~1 unit traveled.
    await page.keyboard.down("ArrowUp");
    await page.waitForTimeout(250);
    await page.keyboard.up("ArrowUp");
    await page.waitForTimeout(50);

    const movedPos = await page.evaluate(() => {
      const w = window.__gameStudio!.world!;
      const playerEid = Array.from(w.playerTags.entries())[0];
      const t = w.transforms.get(playerEid)!;
      return { x: t.x, y: t.y };
    });
    expect(movedPos.y).toBeGreaterThan(0.2);

    // Console pane received Moved events from the EventSystem's debug sink.
    const lineCount = await page.locator(".game-studio-console-line").count();
    expect(lineCount).toBeGreaterThan(0);
    await expect(
      page.locator(".game-studio-console-line").filter({ hasText: "Moved" }).first()
    ).toBeVisible();

    // Bump the speed knob via the registry, then move the same duration.
    // Distance covered should be larger.
    await page.evaluate(() => {
      const knobs = window.__gameStudio!.knobs;
      const speed = knobs.entries().find((e) => e.spec.key === "player.speed")!;
      speed.set(10);
    });
    await expect(page.locator(".knob-value").first()).toContainText("10");

    const beforeFastY = movedPos.y;
    await page.keyboard.down("ArrowUp");
    await page.waitForTimeout(150);
    await page.keyboard.up("ArrowUp");
    await page.waitForTimeout(50);

    const afterFastY = await page.evaluate(() => {
      const w = window.__gameStudio!.world!;
      const playerEid = Array.from(w.playerTags.entries())[0];
      return w.transforms.get(playerEid)!.y;
    });
    // 150ms at speed 10 ≈ 1.5 units; previous 250ms at speed 4 ≈ 1.0.
    // Either way the second segment travels noticeably more per ms.
    expect(afterFastY - beforeFastY).toBeGreaterThan(0.5);
  });
});
