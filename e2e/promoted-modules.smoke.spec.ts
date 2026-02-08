import { expect, test } from "@playwright/test";

async function focusStageCanvas(page: import("@playwright/test").Page) {
  const canvas = page.locator(".stage-host canvas");
  await expect(canvas).toBeVisible();
  await canvas.evaluate((node) => (node as HTMLCanvasElement).focus());
  return canvas;
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
});
