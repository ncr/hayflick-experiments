#!/usr/bin/env node
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
const debug = Number(arg("debug", 4));
const zoom = Number(arg("zoom", 2));
const axis = arg("axis", "x");
const size = Number(arg("size", 3));
const out = arg("out", resolve(repoRoot, `e2e/screenshots/grid-${axis}-z${zoom}-debug${debug}.png`));

const url =
  `http://localhost:${port}/?outlineScene=grid` +
  `&outlineDebug=${debug}&outlineZoom=${zoom}` +
  `&outlineGridAxis=${axis}&outlineGridSize=${size}` +
  `#/exp/outline-walls`;

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--ignore-gpu-blocklist"]
});
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
page.on("console", (msg) => {
  if (msg.type() === "error") console.error(`[browser ${msg.type()}]`, msg.text());
});
page.on("pageerror", (err) => console.error("[pageerror]", err.message));
await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
await page.waitForSelector(".stage-host canvas", { timeout: 20_000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: out, type: "png" });
console.log("Saved", out);
await browser.close();
