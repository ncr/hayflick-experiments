import { expect, test } from "@playwright/test";

async function focusStageCanvas(page: import("@playwright/test").Page) {
  const canvas = page.locator(".stage-host canvas");
  await expect(canvas).toBeVisible();
  await canvas.evaluate((node) => (node as HTMLCanvasElement).focus());
  return canvas;
}

function parsePlayerFromStats(text: string | null): { x: number; y: number } | null {
  if (!text) {
    return null;
  }
  const match = text.match(/Player=\(([-\d.]+),\s*([-\d.]+)\)/);
  if (!match) {
    return null;
  }
  return { x: Number(match[1]), y: Number(match[2]) };
}

test.describe("promoted editor/game browser smoke", () => {
  test("level-builder: rect grass fill and camera hotkey update HUD", async ({
    page
  }) => {
    await page.goto("/#/exp/level-builder");
    const canvas = await focusStageCanvas(page);
    const stats = page.locator('[data-testid="level-builder-stats"]');
    await expect(stats).toContainText("Overrides:");

    await page.keyboard.press("KeyE");
    await expect(stats).toContainText("View: 1/4");

    await page.keyboard.press("KeyG");
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    await page.mouse.move(box.x + box.width * 0.68, box.y + box.height * 0.55);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.84, box.y + box.height * 0.72);
    await page.mouse.up();

    await expect
      .poll(async () => await stats.textContent())
      .toMatch(/Overrides:\s*[1-9]\d*/);
  });

  test("editor-game-ecs: mode switch and game save/load keys", async ({
    page
  }) => {
    await page.goto("/#/exp/editor-game-ecs");
    await focusStageCanvas(page);

    const stats = page.locator('[data-testid="editor-game-ecs-stats"]');
    const status = page.locator('[data-testid="editor-game-ecs-status"]');

    await expect(stats).toContainText("Mode: GAME");
    await page.keyboard.press("Escape");
    await expect(stats).toContainText("Mode: EDITOR");
    await page.keyboard.press("F5");
    await expect(stats).toContainText("Mode: GAME");

    await page.keyboard.press("KeyK");
    await expect(status).toContainText(
      "Saved game to localStorage key: editor_game_ecs_game_save_v4"
    );

    await page.keyboard.press("KeyL");
    await expect(status).toContainText(
      "Loaded game save and restored player + door states by placementId."
    );
  });

  test("editor-game-ecs: uses pixelated canvas sized to viewport device pixels", async ({
    page
  }) => {
    await page.goto("/#/exp/editor-game-ecs");
    const canvas = await focusStageCanvas(page);

    const metrics = await canvas.evaluate((node) => {
      const canvasEl = node as HTMLCanvasElement;
      const rect = canvasEl.getBoundingClientRect();
      return {
        width: canvasEl.width,
        height: canvasEl.height,
        styleWidth: canvasEl.style.width,
        styleHeight: canvasEl.style.height,
        imageRendering: canvasEl.style.imageRendering,
        cssWidth: rect.width,
        cssHeight: rect.height,
        dpr: window.devicePixelRatio
      };
    });

    expect(metrics.width).toBeGreaterThan(0);
    expect(metrics.height).toBeGreaterThan(0);
    expect(Math.abs(metrics.width - metrics.cssWidth * metrics.dpr)).toBeLessThanOrEqual(2);
    expect(Math.abs(metrics.height - metrics.cssHeight * metrics.dpr)).toBeLessThanOrEqual(2);
    expect(Number.parseFloat(metrics.styleWidth)).toBeGreaterThan(0);
    expect(Number.parseFloat(metrics.styleHeight)).toBeGreaterThan(0);
    expect(metrics.imageRendering).toBe("pixelated");
  });

  test("editor-game-ecs: preserves player position when returning from editor", async ({
    page
  }) => {
    await page.goto("/#/exp/editor-game-ecs");
    await focusStageCanvas(page);

    const stats = page.locator('[data-testid="editor-game-ecs-stats"]');
    await expect(stats).toContainText("Mode: GAME");

    await page.keyboard.down("ArrowRight");
    await page.waitForTimeout(250);
    await page.keyboard.up("ArrowRight");

    const moved = parsePlayerFromStats(await stats.textContent());
    expect(moved).not.toBeNull();
    if (!moved) return;

    await page.keyboard.press("Escape");
    await expect(stats).toContainText("Mode: EDITOR");
    await page.keyboard.press("F5");
    await expect(stats).toContainText("Mode: GAME");

    const after = parsePlayerFromStats(await stats.textContent());
    expect(after).not.toBeNull();
    if (!after) return;

    expect(Math.abs(after.x - moved.x)).toBeLessThanOrEqual(0.2);
    expect(Math.abs(after.y - moved.y)).toBeLessThanOrEqual(0.2);
  });
});
