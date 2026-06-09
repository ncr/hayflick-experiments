/**
 * One-off: open a textured-mesh entry in Material Studio, hit Regenerate
 * for every PBR surface, approve, and Save (which bakes and overwrites
 * assets/textured-meshes/<name>/{artifact.glb,manifest.json}).
 *
 * Requires `pnpm dev` running on the URL passed via MAT_STUDIO_BASE_URL
 * (default http://localhost:5173). Headless. Drives the same UI a human
 * would, so the active prompt is the manifest's stored prompt + whatever
 * STYLE_PREAMBLE / STYLE_NEGATIVES the dev server has loaded.
 *
 * Usage:
 *   node scripts/material-studio/regen-textured-mesh.mjs <entry-name>
 *
 * Example:
 *   node scripts/material-studio/regen-textured-mesh.mjs cebrownczek-1
 */
import { chromium } from "@playwright/test";

const BASE_URL = process.env.MAT_STUDIO_BASE_URL || "http://localhost:5173";
const ENTRY = process.argv[2];
if (!ENTRY) {
  console.error("usage: node scripts/material-studio/regen-textured-mesh.mjs <entry-name>");
  process.exit(2);
}

const GEN_TIMEOUT_MS = 120_000;
const BAKE_TIMEOUT_MS = 60_000;

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

page.on("console", (msg) => {
  const t = msg.type();
  if (t === "error" || t === "warning") {
    console.log(`[browser ${t}] ${msg.text()}`);
  } else if (msg.text().includes("[material-studio]")) {
    console.log(`[browser ${t}] ${msg.text()}`);
  }
});

try {
  console.log(`> opening ${BASE_URL}/#/exp/material-studio`);
  await page.goto(`${BASE_URL}/#/exp/material-studio`, { waitUntil: "domcontentloaded" });

  await page.locator(".matstudio-app").waitFor({ timeout: 15_000 });

  // Library cards are rendered after the manifest list loads.
  const card = page.locator(".ms-card", { hasText: ENTRY });
  await card.first().waitFor({ timeout: 15_000 });
  console.log(`> found card for ${ENTRY}, opening edit view`);

  // Open in edit mode (thumb-btn click on the card triggers onEdit).
  await card.first().locator(".ms-card-thumb-btn").click();
  await page.locator(".ms-authoring").waitFor({ timeout: 10_000 });

  // Wait until the authoring scene is fully mounted with PBR surface(s).
  await page.waitForFunction(
    () => !!(window).__materialStudio,
    null,
    { timeout: 15_000 }
  );

  // Iterate over all surfaces (the surface list is in the right pane).
  // For each, switch to it, hit Regenerate, wait for completion, Approve.
  const surfaceRows = page.locator(".ms-surface-list .ms-surface-row");
  const surfaceCount = await surfaceRows.count();
  console.log(`> ${surfaceCount} surface(s) detected`);

  for (let i = 0; i < surfaceCount; i++) {
    const row = surfaceRows.nth(i);
    const roleName = (await row.locator(".ms-surface-row-name").textContent())?.trim() ?? `#${i}`;
    const tag = (await row.locator(".ms-surface-row-tag").textContent())?.trim();

    // Skip synthetic surfaces (e.g. Glass) — they have no Generate flow.
    if (tag === "Glass") {
      console.log(`> [${roleName}] synthetic (Glass) — skipping generate`);
      continue;
    }

    console.log(`> [${roleName}] activating surface`);
    await row.click();

    // Wait for the prompt panel for THIS surface to mount. Three panels
    // share the class (PBR / Lighting / Prompt) — scope to the Prompt one.
    await page.locator(".ms-prompt-panel", { hasText: "Prompt ·" }).waitFor({ timeout: 5_000 });

    const genBtn = page.getByRole("button", { name: /^(Generate|Regenerate)$/ });
    await genBtn.waitFor({ timeout: 5_000 });

    console.log(`> [${roleName}] clicking Regenerate (timeout ${GEN_TIMEOUT_MS / 1000}s)`);
    await genBtn.click();

    // Mid-generate the button text changes (Generating… or disabled).
    // Wait for it to settle back to "Regenerate" — that's our completion
    // signal. The 90s API timeout is internal; we add a safety margin.
    await page.getByRole("button", { name: "Regenerate" }).waitFor({ timeout: GEN_TIMEOUT_MS });
    console.log(`> [${roleName}] generation complete`);

    // Approve. The Approve button toggles to "Approved ✓".
    const approveBtn = page.getByRole("button", { name: /^(Approve|Approved ✓)$/ });
    await approveBtn.waitFor({ timeout: 5_000 });
    const approveLabel = (await approveBtn.textContent())?.trim();
    if (approveLabel === "Approve") {
      await approveBtn.click();
      await page.getByRole("button", { name: "Approved ✓" }).waitFor({ timeout: 5_000 });
    }
    console.log(`> [${roleName}] approved`);
  }

  // Save bakes the artifact + writes manifest.json. On success the view
  // dispatches ENTER_LIBRARY so .ms-authoring unmounts and .ms-library
  // is visible again — that's our completion signal.
  console.log(`> clicking Save (bake)`);
  const saveBtn = page.getByRole("button", { name: /^(Save|Create)$/ });
  await saveBtn.waitFor({ timeout: 5_000 });
  await saveBtn.click();

  await page.locator(".ms-library").waitFor({ state: "visible", timeout: BAKE_TIMEOUT_MS });
  console.log(`> bake complete (returned to library)`);

  const successToast = page.locator(".ms-toast-success");
  if (await successToast.count()) {
    const txt = (await successToast.first().textContent())?.trim();
    console.log(`> toast: ${txt}`);
  }

  console.log(`✔ ${ENTRY} regenerated and baked`);
} catch (err) {
  console.error(`✖ failed:`, err?.message || err);
  await page.screenshot({ path: `scripts/material-studio/regen-${ENTRY}-failure.png` }).catch(() => {});
  process.exitCode = 1;
} finally {
  await ctx.close();
  await browser.close();
}
