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
  test("full forge workflow with mocked APIs", async ({ page }) => {
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

    // 2. Verify forge page renders
    const forgePage = page.locator('[data-testid="forge-page"]');
    await expect(forgePage).toBeVisible();

    const viewport = page.locator('[data-testid="forge-viewport"]');
    await expect(viewport).toBeVisible();

    // 3. Style guide: enter style prompt
    const styleGuidePanel = page.locator('[data-testid="forge-style-guide"]');
    await expect(styleGuidePanel).toBeVisible();

    const stylePrompt = page.locator('[data-testid="style-guide-prompt"]');
    await stylePrompt.fill("Stylized low-poly, warm palette");

    // 4. Move to image generation step
    const nextBtn = page.locator(".forge-nav .forge-btn-primary");
    await nextBtn.click();

    // Generate image
    const imagePanel = page.locator('[data-testid="forge-generate-image"]');
    await expect(imagePanel).toBeVisible();

    const propDesc = page.locator('[data-testid="prop-description"]');
    await propDesc.fill("wooden chair");

    const genImageBtn = page.locator('[data-testid="generate-image-btn"]');
    await genImageBtn.click();

    // Wait for concept image to appear
    const conceptImg = page.locator('[data-testid="concept-image"]');
    await expect(conceptImg).toBeVisible({ timeout: 10000 });

    // Accept the image
    const acceptBtn = page.locator('[data-testid="accept-image-btn"]');
    await acceptBtn.click();

    // 5. Generate 3D
    const gen3dPanel = page.locator('[data-testid="forge-generate-3d"]');
    await expect(gen3dPanel).toBeVisible();

    const gen3dBtn = page.locator('[data-testid="generate-3d-btn"]');
    await gen3dBtn.click();

    // Wait for simplify panel to appear (auto-advances after 3D gen)
    const simplifyPanel = page.locator('[data-testid="forge-simplify"]');
    await expect(simplifyPanel).toBeVisible({ timeout: 30000 });

    // 6. Verify face count
    const faceCount = page.locator('[data-testid="face-count"]');
    await expect(faceCount).toBeVisible();
    const faceText = await faceCount.textContent();
    expect(Number(faceText)).toBeGreaterThan(0);

    // Toggle wireframe
    const wireframeToggle = page.locator('[data-testid="wireframe-toggle"]');
    await wireframeToggle.check();
    await wireframeToggle.uncheck();

    // 7. Navigate to dimensions
    await nextBtn.click();
    const dimPanel = page.locator('[data-testid="forge-dimensions"]');
    await expect(dimPanel).toBeVisible();

    // Select fit height and enter target
    const targetDim = page.locator('[data-testid="target-dimension"]');
    await targetDim.fill("0.85");

    const applyScaleBtn = page.locator('[data-testid="apply-scale-btn"]');
    await applyScaleBtn.click();

    // Verify bbox info shows
    const bboxInfo = page.locator('[data-testid="bbox-info"]');
    await expect(bboxInfo).toBeVisible();

    // 8. Navigate to pivot
    await nextBtn.click();
    const pivotPanel = page.locator('[data-testid="forge-pivot"]');
    await expect(pivotPanel).toBeVisible();

    // Select bottom-center preset
    const pivotBtn = page.locator('[data-testid="pivot-bottom-center"]');
    await pivotBtn.click();

    // 9. Navigate to collider
    await nextBtn.click();
    const colliderPanel = page.locator('[data-testid="forge-collider"]');
    await expect(colliderPanel).toBeVisible();

    // Select capsule type
    const colliderType = page.locator('[data-testid="collider-type"]');
    await colliderType.selectOption("capsule");

    // 10. Navigate to export
    await nextBtn.click();
    const exportPanel = page.locator('[data-testid="forge-export"]');
    await expect(exportPanel).toBeVisible();

    // Save asset
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
