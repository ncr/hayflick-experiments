#!/usr/bin/env node
import { chromium } from "@playwright/test";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return process.argv[i + 1];
}

const port = arg("port", "5174");
const debug = arg("debug", "5");
const zoom = arg("zoom", "2");
const scene = arg("scene", "grid");
const axis = arg("axis", "x");
const size = arg("size", "3");
const stride = arg("stride", "1");
const rotE = Number(arg("rotE", "0"));
const rotQ = Number(arg("rotQ", "0"));
const out = arg("out", "/tmp/shot.png");

const url =
  `http://localhost:${port}/?outlineDebug=${debug}&outlineZoom=${zoom}&outlineTileset=greek_island_white` +
  `&outlineScene=${scene}&outlineMask=1&outlineGridAxis=${axis}&outlineGridSize=${size}&outlineGridStride=${stride}` +
  `#/exp/outline-walls`;

const browser = await chromium.launch({
  args: ["--ignore-gpu-blocklist", "--enable-unsafe-webgpu"]
});
const vpw = Number(arg("vpw", "1280"));
const vph = Number(arg("vph", "800"));
const context = await browser.newContext({ viewport: { width: vpw, height: vph } });
const page = await context.newPage();
page.on("console", (m) => { if (m.type() === "error") console.error("[b]", m.text()); });
page.on("pageerror", (e) => console.error("[perr]", e.message));
console.log("URL:", url);
await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
await page.waitForSelector(".stage-host canvas", { timeout: 20_000 });
await page.waitForTimeout(1500);
for (let i = 0; i < rotQ; i++) { await page.keyboard.press("KeyQ"); await page.waitForTimeout(400); }
for (let i = 0; i < rotE; i++) { await page.keyboard.press("KeyE"); await page.waitForTimeout(400); }
if (rotQ || rotE) await page.waitForTimeout(600);
await page.screenshot({ path: out, type: "png" });
console.log("Saved", out);
await browser.close();
