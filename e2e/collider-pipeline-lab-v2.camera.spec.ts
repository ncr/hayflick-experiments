import { expect, test } from "@playwright/test";

const COLLAPSE_STORAGE_KEY = "collider_pipeline_lab_v2_collapsed_strategies_v1";

type CardMetric = {
  name: string;
  cardWidth: number;
  viewportWidth: number;
  canvasWidth: number;
};

async function collectCardMetrics(
  page: import("@playwright/test").Page
): Promise<CardMetric[]> {
  return await page.evaluate(() => {
    const preNodes = Array.from(document.querySelectorAll("pre")).filter((pre) =>
      pre.textContent?.includes("actual rank:")
    );
    const cardRoots = Array.from(new Set(preNodes.map((pre) => pre.parentElement))).filter(
      (node): node is HTMLDivElement =>
        node instanceof HTMLDivElement && node.dataset.collapsed !== "true"
    );

    const metrics: CardMetric[] = [];
    for (const card of cardRoots) {
      const title = card.children.item(0) as HTMLElement | null;
      const viewport = card.children.item(1) as HTMLElement | null;
      const canvas = viewport?.querySelector("canvas") as HTMLCanvasElement | null;
      if (!title || !viewport || !canvas) {
        continue;
      }

      const cardRect = card.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      const canvasRect = canvas.getBoundingClientRect();

      metrics.push({
        name: title.textContent?.trim() || "unknown",
        cardWidth: Math.round(cardRect.width),
        viewportWidth: Math.round(viewportRect.width),
        canvasWidth: Math.round(canvasRect.width)
      });
    }
    return metrics;
  });
}

async function clearCollapseStorage(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  await page.evaluate((storageKey: string) => {
    window.localStorage.removeItem(storageKey);
  }, COLLAPSE_STORAGE_KEY);
}

function areCardMetricsValid(metrics: CardMetric[]): boolean {
  if (metrics.length < 8) {
    return false;
  }
  return metrics.every(
    (metric) =>
      Math.abs(metric.viewportWidth - metric.cardWidth) <= 4 &&
      Math.abs(metric.canvasWidth - metric.viewportWidth) <= 4
  );
}

test.describe("collider pipeline lab v2 camera framing", () => {
  test("fullscreen + reload keeps strategy canvases sized and visible", async ({
    page
  }) => {
    await clearCollapseStorage(page);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto("/#/exp/collider-pipeline-lab-v2");

    await expect(
      page.locator("pre:visible").filter({ hasText: "actual rank:" }).first()
    ).toBeVisible({
      timeout: 20_000
    });
    await expect
      .poll(async () => areCardMetricsValid(await collectCardMetrics(page)), {
        timeout: 10_000
      })
      .toBe(true);

    await page.reload();
    await expect(
      page.locator("pre:visible").filter({ hasText: "actual rank:" }).first()
    ).toBeVisible({
      timeout: 20_000
    });
    await expect
      .poll(async () => areCardMetricsValid(await collectCardMetrics(page)), {
        timeout: 10_000
      })
      .toBe(true);
  });

  test("rotate pan and zoom on one strategy view sync across the grid", async ({
    page
  }) => {
    await clearCollapseStorage(page);
    await page.setViewportSize({ width: 1600, height: 980 });
    await page.goto("/#/exp/collider-pipeline-lab-v2");
    await expect(
      page.locator("pre:visible").filter({ hasText: "actual rank:" }).first()
    ).toBeVisible({
      timeout: 20_000
    });

    const firstViewport = page.locator('[data-testid="collider-v2-viewport-aabb"]');
    const secondViewport = page.locator('[data-testid="collider-v2-viewport-obb-pca"]');
    const firstCanvas = firstViewport.locator("canvas");
    const secondCanvas = secondViewport.locator("canvas");
    await expect(firstCanvas).toBeVisible();
    await expect(secondCanvas).toBeVisible();

    const box = await firstCanvas.boundingBox();
    expect(box).not.toBeNull();
    if (!box) {
      return;
    }

    const panBeforeFirst = await firstCanvas.screenshot();
    const panBeforeSecond = await secondCanvas.screenshot();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.mouse.down({ button: "right" });
    await page.mouse.move(box.x + box.width * 0.68, box.y + box.height * 0.66);
    await page.mouse.up({ button: "right" });
    await page.waitForTimeout(260);

    const panAfterFirst = await firstCanvas.screenshot();
    const panAfterSecond = await secondCanvas.screenshot();
    expect(panAfterFirst.equals(panBeforeFirst)).toBe(false);
    expect(panAfterSecond.equals(panBeforeSecond)).toBe(false);

    const zoomBeforeFirst = panAfterFirst;
    const zoomBeforeSecond = panAfterSecond;
    await firstCanvas.hover();
    await page.mouse.wheel(0, 420);
    await page.waitForTimeout(220);

    const zoomAfterFirst = await firstCanvas.screenshot();
    const zoomAfterSecond = await secondCanvas.screenshot();
    expect(zoomAfterFirst.equals(zoomBeforeFirst)).toBe(false);
    expect(zoomAfterSecond.equals(zoomBeforeSecond)).toBe(false);
  });

  test("collapsed cards persist after reload", async ({ page }) => {
    await clearCollapseStorage(page);
    await page.setViewportSize({ width: 1600, height: 980 });
    await page.goto("/#/exp/collider-pipeline-lab-v2");
    await expect(
      page.locator("pre:visible").filter({ hasText: "actual rank:" }).first()
    ).toBeVisible({
      timeout: 20_000
    });

    const aabbCard = page.locator('[data-testid="collider-v2-card-aabb"]');
    const aabbToggle = page.locator('[data-testid="collider-v2-collapse-aabb"]');
    await expect(aabbToggle).toBeVisible();
    await aabbToggle.click();
    await expect(aabbCard).toHaveAttribute("data-collapsed", "true");
    await expect(aabbCard.locator("canvas")).toBeHidden();

    await page.reload();
    await expect(
      page.locator("pre:visible").filter({ hasText: "actual rank:" }).first()
    ).toBeVisible({
      timeout: 20_000
    });
    const aabbCardReloaded = page.locator('[data-testid="collider-v2-card-aabb"]');
    const aabbToggleReloaded = page.locator(
      '[data-testid="collider-v2-collapse-aabb"]'
    );
    await expect(aabbCardReloaded).toHaveAttribute("data-collapsed", "true");
    await expect(aabbCardReloaded.locator("canvas")).toBeHidden();

    await aabbToggleReloaded.click();
    await expect(aabbCardReloaded).toHaveAttribute("data-collapsed", "false");
    await expect(aabbCardReloaded.locator("canvas")).toBeVisible();
  });

  test("collapsing one card repacks the grid immediately", async ({ page }) => {
    await clearCollapseStorage(page);
    await page.setViewportSize({ width: 1600, height: 980 });
    await page.goto("/#/exp/collider-pipeline-lab-v2");
    await expect(
      page.locator("pre:visible").filter({ hasText: "actual rank:" }).first()
    ).toBeVisible({
      timeout: 20_000
    });

    const aabbToggle = page.locator('[data-testid="collider-v2-collapse-aabb"]');
    await expect(aabbToggle).toBeVisible();

    const candidate = await page.evaluate(() => {
      const ids = [
        "aabb",
        "obb-pca",
        "layered-y",
        "layered-x",
        "layered-z",
        "voxel-greedy",
        "split-fit",
        "support-columns"
      ] as const;
      const boxes = ids
        .map((id) => {
          const card = document.querySelector(
            `[data-testid=\"collider-v2-card-${id}\"]`
          ) as HTMLDivElement | null;
          if (!card) {
            return null;
          }
          const rect = card.getBoundingClientRect();
          return {
            id,
            x: rect.x,
            y: rect.y
          };
        })
        .filter((entry): entry is { id: string; x: number; y: number } => Boolean(entry));

      const aabb = boxes.find((entry) => entry.id === "aabb");
      if (!aabb) {
        return null;
      }
      const sameColumnBelow = boxes
        .filter((entry) => entry.id !== "aabb")
        .filter((entry) => Math.abs(entry.x - aabb.x) < 8 && entry.y > aabb.y + 8)
        .sort((a, b) => a.y - b.y)[0];
      if (!sameColumnBelow) {
        return null;
      }
      return {
        id: sameColumnBelow.id,
        y: sameColumnBelow.y
      };
    });
    expect(candidate).not.toBeNull();
    if (!candidate) {
      return;
    }

    const belowCard = page.locator(`[data-testid="collider-v2-card-${candidate.id}"]`);
    await expect(belowCard).toBeVisible();

    await aabbToggle.click();
    await expect(page.locator('[data-testid="collider-v2-card-aabb"]')).toHaveAttribute(
      "data-collapsed",
      "true"
    );

    await expect
      .poll(async () => {
        const box = await belowCard.boundingBox();
        return box ? box.y : Number.POSITIVE_INFINITY;
      })
      .toBeLessThan(candidate.y - 80);
  });
});
