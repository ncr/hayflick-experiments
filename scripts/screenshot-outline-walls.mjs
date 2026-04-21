#!/usr/bin/env node
// Quick capture: loads the outline-walls experiment, waits for the wall GLB
// to render, and saves a screenshot. Usage:
//   node scripts/screenshot-outline-walls.mjs [--port 5174] [--debug N] [--zoom N] [--out path.png] [--wait ms]
import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return process.argv[i + 1];
}

const port = Number(arg("port", 5174));
const debugMode = Number(arg("debug", 0));
const zoom = Number(arg("zoom", 3));
const waitMs = Number(arg("wait", 1500));
const tileset = arg("tileset", "greek_island_white");
const scene = arg("scene", "strip");
const mask = arg("mask", "1");
const out = arg("out", resolve(repoRoot, "e2e/screenshots/outline-walls.png"));

// Querystring must live on the path (not after the hash) because the experiment
// reads `window.location.search` while the hub routes via `window.location.hash`.
const url =
  `http://localhost:${port}/?outlineDebug=${debugMode}&outlineZoom=${zoom}` +
  `&outlineTileset=${encodeURIComponent(tileset)}` +
  `&outlineScene=${encodeURIComponent(scene)}` +
  `&outlineMask=${encodeURIComponent(mask)}#/exp/outline-walls`;

const useSwiftshader = process.argv.indexOf("--swiftshader") !== -1;
const browser = await chromium.launch({
  args: useSwiftshader
    ? ["--use-angle=swiftshader", "--ignore-gpu-blocklist"]
    : ["--ignore-gpu-blocklist", "--enable-unsafe-webgpu"]
});
const vpw = Number(arg("vpw", 1280));
const vph = Number(arg("vph", 800));
const context = await browser.newContext({ viewport: { width: vpw, height: vph } });
const page = await context.newPage();
page.on("console", (msg) => {
  if (msg.type() === "error" || msg.type() === "warning") {
    // Surface any runtime errors so we don't silently screenshot a blank page.
    console.error(`[browser ${msg.type()}]`, msg.text());
  }
});
page.on("pageerror", (err) => console.error("[pageerror]", err.message));

console.log("Opening", url);
try {
  await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
} catch (err) {
  console.error("goto failed:", err.message);
}
try {
  await page.waitForSelector(".stage-host canvas", { timeout: 20_000 });
} catch (err) {
  console.error("canvas never appeared:", err.message);
  const html = await page.content();
  console.error("---- page HTML (head) ----");
  console.error(html.slice(0, 2000));
}
await page.waitForTimeout(waitMs);

// Optional quarter-turn rotations (Q rotates left, E rotates right).
const rotQ = Number(arg("rotQ", 0));
const rotE = Number(arg("rotE", 0));
for (let i = 0; i < rotQ; i++) {
  await page.keyboard.press("KeyQ");
  await page.waitForTimeout(400);
}
for (let i = 0; i < rotE; i++) {
  await page.keyboard.press("KeyE");
  await page.waitForTimeout(400);
}
if (rotQ > 0 || rotE > 0) {
  await page.waitForTimeout(600);
}

await page.screenshot({ path: out, type: "png" });
console.log("Saved", out);

await browser.close();
