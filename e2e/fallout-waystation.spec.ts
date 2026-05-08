import { expect, test } from "@playwright/test";

const DEV_BASE_URL = process.env.WAYSTATION_BASE_URL || "http://127.0.0.1:4173";

test.use({
  viewport: { width: 1024, height: 768 },
  deviceScaleFactor: 1,
  baseURL: DEV_BASE_URL
});

test("fallout-waystation loads without runtime errors", async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (e) => pageErrors.push(e));
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    // Favicon 404s are noise.
    if (text.includes("favicon")) return;
    if (text === "Failed to load resource: the server responded with a status of 404 (Not Found)") return;
    consoleErrors.push(text);
  });
  const failedRequests: string[] = [];
  page.on("response", (res) => {
    if (res.status() < 400) return;
    if (res.url().endsWith("favicon.ico")) return;
    failedRequests.push(`${res.status()} ${res.url()}`);
  });

  await page.goto("/#/exp/fallout-waystation");
  // Give the experiment a moment to mount + first frames to render.
  await page.waitForTimeout(2000);

  const canvas = page.locator("canvas").first();
  await expect(canvas).toBeVisible();

  await page.screenshot({
    path: "e2e/screenshots/fallout-waystation-initial.png",
    fullPage: false
  });

  // Capture a non-cropped, full-canvas-only snap as well, sized to the
  // canvas itself so iteration screenshots are comparable.
  const box = await canvas.boundingBox();
  if (box) {
    await page.screenshot({
      path: "e2e/screenshots/fallout-waystation-canvas.png",
      clip: box
    });
  }

  if (pageErrors.length || consoleErrors.length || failedRequests.length) {
    console.log("=== pageErrors ===\n", pageErrors.map((e) => e.message).join("\n"));
    console.log("=== consoleErrors ===\n", consoleErrors.join("\n"));
    console.log("=== failedRequests ===\n", failedRequests.join("\n"));
  }
  expect(pageErrors, `pageerror: ${pageErrors.map((e) => e.message).join("\n")}`).toHaveLength(0);
  expect(consoleErrors, `console.error: ${consoleErrors.join("\n")}`).toHaveLength(0);
  expect(failedRequests, `failed requests: ${failedRequests.join("\n")}`).toHaveLength(0);
});
