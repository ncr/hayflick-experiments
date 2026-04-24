import { expect, test } from "@playwright/test";

test.describe("material studio", () => {
  test("library loads and + New reveals base-mesh picker", async ({ page }) => {
    await page.goto("/#/exp/material-studio");

    const app = page.locator(".matstudio-app");
    await expect(app).toBeVisible({ timeout: 10_000 });

    // Library mounts
    const library = page.locator(".ms-library");
    await expect(library).toBeVisible();
    await expect(page.locator(".ms-topbar")).toBeVisible();

    // + New → base picker
    await page.getByRole("button", { name: "+ New" }).first().click();
    const picker = page.locator(".ms-base-picker");
    await expect(picker).toBeVisible();

    // Back → library
    await page.getByRole("button", { name: "← Back to library" }).click();
    await expect(library).toBeVisible();
  });

  test("base-mesh picker renders thumbnails and opens authoring on click", async ({ page }) => {
    await page.goto("/#/exp/material-studio");
    await expect(page.locator(".matstudio-app")).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "+ New" }).first().click();

    // At least one base mesh card
    const cards = page.locator(".ms-base-picker .ms-card");
    await expect(cards.first()).toBeVisible({ timeout: 5_000 });

    // Click first → authoring
    await cards.first().click();
    await expect(page.locator(".ms-authoring")).toBeVisible({ timeout: 5_000 });
    // Viewport is present (3D container)
    await expect(page.locator(".ms-viewport")).toBeVisible();
    // Side panel with surface list
    await expect(page.locator(".ms-side-panel")).toBeVisible();
  });
});
