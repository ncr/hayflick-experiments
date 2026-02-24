import { expect, test } from "@playwright/test";

async function focusStageCanvas(page: import("@playwright/test").Page) {
  const canvas = page.locator(".stage-host canvas");
  await expect(canvas).toBeVisible();
  await canvas.evaluate((node) => (node as HTMLCanvasElement).focus());
  return canvas;
}

test.describe("promoted editor/game browser smoke", () => {
  test("pixel-perfect-camera-zoom: Q then E preserves center world point", async ({
    page
  }) => {
    await page.goto("/#/exp/pixel-perfect-camera-zoom");
    const canvas = await focusStageCanvas(page);
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    const centerClient = {
      x: box.x + box.width * 0.5,
      y: box.y + box.height * 0.5
    };

    const sampleCenterWorld = async () =>
      page.evaluate(({ x, y }) => {
        const api = (window as Window & {
          __pixelPerfectCameraZoomDebug?: {
            worldAtClient: (clientX: number, clientY: number) => {
              x: number;
              y: number;
              z: number;
            } | null;
          };
        }).__pixelPerfectCameraZoomDebug;
        return api?.worldAtClient(x, y) ?? null;
      }, centerClient);

    const before = await sampleCenterWorld();
    expect(before).not.toBeNull();
    if (!before) return;

    await page.keyboard.press("KeyQ");
    await page.waitForTimeout(320);
    await page.keyboard.press("KeyE");
    await page.waitForTimeout(320);

    const after = await sampleCenterWorld();
    expect(after).not.toBeNull();
    if (!after) return;

    expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(0.002);
    expect(Math.abs(after.z - before.z)).toBeLessThanOrEqual(0.002);
  });

  test("settlement-builder-ecs: editor/game flow and tool mode hotkeys", async ({
    page
  }) => {
    await page.goto("/#/exp/settlement-builder-ecs");
    await focusStageCanvas(page);

    const stats = page.locator('[data-testid="settlement-builder-ecs-stats"]');
    await expect(stats).toContainText("Mode: EDITOR");
    await expect(stats).toContainText("Tool: Build");

    await page.keyboard.press("KeyX");
    await expect(stats).toContainText("Tool: Scrap");
    await page.keyboard.press("KeyD");
    await expect(stats).toContainText("Tool: Build");

    await page.keyboard.press("F5");
    await expect(stats).toContainText("Mode: GAME");
    await page.keyboard.press("Escape");
    await expect(stats).toContainText("Mode: EDITOR");
  });
});
