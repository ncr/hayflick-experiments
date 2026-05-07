import { expect, test } from "@playwright/test";

const DEV_BASE_URL = process.env.ISO_SCALE_PROBE_BASE_URL || "http://localhost:5173";

test.use({
  viewport: { width: 1024, height: 768 },
  deviceScaleFactor: 1,
  baseURL: DEV_BASE_URL
});

test("iso-scale-probe loads, mounts canvas + lil-gui, survives preset switch", async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (e) => pageErrors.push(e));
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
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

  // Wipe any persisted probe config so the test starts at the default
  // (32x16 clean) preset regardless of prior dev-server interactions.
  await page.addInitScript(() => {
    try {
      window.localStorage.removeItem("iso-scale-probe-config-v1");
    } catch {
      /* localStorage may be disabled */
    }
  });

  await page.goto("/#/exp/iso-scale-probe");
  await page.waitForTimeout(1500);

  const canvas = page.locator("canvas").first();
  await expect(canvas).toBeVisible();

  // lil-gui mounts a `.lil-gui` root element. Confirm it's present.
  const gui = page.locator(".lil-gui").first();
  await expect(gui).toBeVisible();

  // Switch to the "Current 240 / 4.8 sqrt(2)" preset to exercise the
  // rebuild path (every scale change disposes + re-creates the
  // IsoGameView). Then back to the 32x16 default. If either rebuild
  // throws, pageErrors will catch it.
  const presetSelect = page.locator(".lil-gui select").first();
  await expect(presetSelect).toBeVisible();
  const options = await presetSelect.locator("option").allTextContents();
  expect(options.length).toBeGreaterThan(2);

  const oldIdx = options.findIndex((o) => o.includes("Old default") && o.includes("half-pixel"));
  expect(oldIdx, `old-default preset not found; options: ${options.join(" | ")}`).toBeGreaterThanOrEqual(0);
  await presetSelect.selectOption({ index: oldIdx });
  await page.waitForTimeout(400);

  const lockedIdx = options.findIndex((o) => o.includes("LOCKED") && o.includes("32 x 16"));
  expect(lockedIdx, `LOCKED preset not found; options: ${options.join(" | ")}`).toBeGreaterThanOrEqual(0);
  await presetSelect.selectOption({ index: lockedIdx });
  await page.waitForTimeout(400);

  // Equivalence sanity: switching to the alt-A 32x16 preset (different
  // FRH/BOH but same R) must not crash the rebuild path.
  const altIdx = options.findIndex((o) => o.includes("Equiv") && o.includes("alt-A"));
  expect(altIdx, `equiv alt-A not found; options: ${options.join(" | ")}`).toBeGreaterThanOrEqual(0);
  await presetSelect.selectOption({ index: altIdx });
  await page.waitForTimeout(400);

  // After the rebuild dance, the canvas is still expected to be there
  // (a new one — IsoGameView appends its own).
  await expect(page.locator("canvas").first()).toBeVisible();

  await page.screenshot({
    path: "e2e/screenshots/iso-scale-probe-initial.png",
    fullPage: false
  });

  if (pageErrors.length || consoleErrors.length || failedRequests.length) {
    console.log("=== pageErrors ===\n", pageErrors.map((e) => e.message).join("\n"));
    console.log("=== consoleErrors ===\n", consoleErrors.join("\n"));
    console.log("=== failedRequests ===\n", failedRequests.join("\n"));
  }
  expect(pageErrors, `pageerror: ${pageErrors.map((e) => e.message).join("\n")}`).toHaveLength(0);
  expect(consoleErrors, `console.error: ${consoleErrors.join("\n")}`).toHaveLength(0);
  expect(failedRequests, `failed requests: ${failedRequests.join("\n")}`).toHaveLength(0);
});
