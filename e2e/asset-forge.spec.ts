import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

const MOCK_PNG = fs.readFileSync(
  path.resolve(__dirname, "fixtures/mock-concept.png")
);
const MOCK_GLB = fs.readFileSync(
  path.resolve(__dirname, "fixtures/mock-model.glb")
);

test.describe("asset forge workflow", () => {
  test("batch forge workflow with dual viewports", async ({ page }) => {
    // Mock OpenAI image generation
    await page.route("**/api/openai/generate-image", async (route) => {
      const pngBase64 = MOCK_PNG.toString("base64");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [{ b64_json: pngBase64 }],
        }),
      });
    });

    // Mock Tripo upload
    await page.route("**/api/tripo/upload", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { image_token: "mock-token-123" },
        }),
      });
    });

    // Mock Tripo task creation
    await page.route("**/api/tripo/task", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: { task_id: "mock-task-456" },
          }),
        });
      }
    });

    // Mock Tripo task polling — return success immediately
    await page.route("**/api/tripo/task/mock-task-456", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            task_id: "mock-task-456",
            status: "success",
            progress: 100,
            output: {
              model: "https://mock.tripo3d.ai/model.glb",
            },
          },
        }),
      });
    });

    // Mock Tripo download
    await page.route("**/api/tripo/download**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "model/gltf-binary",
        body: MOCK_GLB,
      });
    });

    // Mock FS writes (capture what's written)
    const fsWrites: { path: string; contentType: string }[] = [];
    await page.route("**/api/fs/write**", async (route) => {
      const url = new URL(route.request().url());
      fsWrites.push({
        path: url.searchParams.get("path") || "",
        contentType: route.request().headers()["content-type"] || "",
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    // Mock FS list (empty initially)
    await page.route("**/api/fs/list**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    });

    // 1. Navigate to #/forge
    await page.goto("/#/forge");

    // 2. Verify forge page renders with 3-column layout
    const forgePage = page.locator('[data-testid="forge-page"]');
    await expect(forgePage).toBeVisible();

    // 3. Verify dual viewports are visible
    const viewportPanes = page.locator(".forge-viewport-pane");
    await expect(viewportPanes).toHaveCount(2);

    // Verify right rail is visible
    const rightRail = page.locator('[data-testid="forge-right-rail"]');
    await expect(rightRail).toBeVisible();

    // 4. Style guide: enter style prompt
    const styleGuidePanel = page.locator('[data-testid="forge-style-guide"]');
    await expect(styleGuidePanel).toBeVisible();

    const stylePrompt = page.locator('[data-testid="style-guide-prompt"]');
    await stylePrompt.fill("Stylized low-poly, warm palette");

    // 5. Enter batch descriptions
    const batchPanel = page.locator('[data-testid="forge-batch-prompt"]');
    await expect(batchPanel).toBeVisible();

    const batchTextarea = page.locator('[data-testid="batch-prompt-textarea"]');
    await batchTextarea.fill("wooden chair\nstone well");

    // Add to queue
    const addToQueueBtn = page.locator('[data-testid="add-to-queue-btn"]');
    await addToQueueBtn.click();

    // Verify props appear in gallery
    const batchGallery = page.locator('[data-testid="forge-batch-gallery"]');
    await expect(batchGallery).toBeVisible();
    const propCells = page.locator(".forge-image-cell");
    await expect(propCells).toHaveCount(2);

    // 6. Generate all images
    const genAllImagesBtn = page.locator(
      '[data-testid="generate-all-images-btn"]'
    );
    await genAllImagesBtn.click();

    // Wait for images to appear (both props should get images)
    await expect(
      page.locator(".forge-image-cell img").first()
    ).toBeVisible({ timeout: 15000 });

    // 7. Generate all 3D models
    const genAll3DBtn = page.locator('[data-testid="generate-all-3d-btn"]');
    await genAll3DBtn.click();

    // Wait for 3D badge to appear
    await expect(
      page.locator(".forge-image-cell-badge-ready").first()
    ).toBeVisible({ timeout: 30000 });

    // 8. Select first prop — should load into viewport
    await propCells.first().click();

    // 9. Verify processing panels are visible in right rail
    const simplifyPanel = page.locator('[data-testid="forge-simplify"]');
    await expect(simplifyPanel).toBeVisible();

    const dimPanel = page.locator('[data-testid="forge-dimensions"]');
    await expect(dimPanel).toBeVisible();

    const pivotPanel = page.locator('[data-testid="forge-pivot"]');
    await expect(pivotPanel).toBeVisible();

    const colliderPanel = page.locator('[data-testid="forge-collider"]');
    await expect(colliderPanel).toBeVisible();

    const exportPanel = page.locator('[data-testid="forge-export"]');
    await expect(exportPanel).toBeVisible();

    // 10. Apply scale
    const targetDim = page.locator('[data-testid="target-dimension"]');
    await targetDim.fill("0.85");

    const applyScaleBtn = page.locator('[data-testid="apply-scale-btn"]');
    await applyScaleBtn.click();

    // 11. Set pivot
    const pivotBtn = page.locator('[data-testid="pivot-bottom-center"]');
    await pivotBtn.click();

    // 12. Recompute VHACD collider
    const recomputeColliderBtn = page.locator('[data-testid="vhacd-recompute-btn"]');
    await recomputeColliderBtn.click();
    await expect(recomputeColliderBtn).toHaveText("Recompute Collider", {
      timeout: 30000,
    });

    // 13. Save asset
    const saveBtn = page.locator('[data-testid="save-asset-btn"]');
    await saveBtn.click();

    // Wait for success message
    const saveSuccess = page.locator('[data-testid="save-success"]');
    await expect(saveSuccess).toBeVisible({ timeout: 10000 });

    // Verify FS writes contain expected paths
    const writePaths = fsWrites.map((w) => w.path);
    expect(writePaths.some((p) => p.includes("meta.json"))).toBe(true);
    expect(writePaths.some((p) => p.includes("concept.png"))).toBe(true);
    expect(writePaths.some((p) => p.includes("prompt.txt"))).toBe(true);
    expect(writePaths.some((p) => p.includes("processed/collider.glb"))).toBe(
      true
    );
  });

  test("forge page is accessible from sidebar", async ({ page }) => {
    await page.goto("/");

    // Find and click the Asset Forge link in sidebar
    const forgeBtn = page.locator("text=Asset Forge");
    await expect(forgeBtn).toBeVisible();
    await forgeBtn.click();

    // Verify forge page loaded
    await expect(page.locator('[data-testid="forge-page"]')).toBeVisible();
    expect(page.url()).toContain("#/forge");
  });
});
