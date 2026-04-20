// Simple screenshot helper for the outline-walls experiment. Connects to the
// running Vite dev server on port 5173.
import { chromium } from "@playwright/test";
import path from "node:path";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:5173";
const OUT = process.argv[2] ?? "/tmp/outline-walls.png";
const DEBUG = process.env.DEBUG ?? "0";
const CLIP = process.env.CLIP; // "x,y,w,h" — optional crop (CSS px, post-scale)
const ZOOM = process.env.ZOOM ?? "1";
const URL = `${BASE}/?outlineDebug=${DEBUG}&outlineZoom=${ZOOM}#/exp/outline-walls`;

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--ignore-gpu-blocklist"]
});
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1
});
const page = await ctx.newPage();

page.on("console", (msg) => {
  const t = msg.type();
  if (t === "error" || t === "warning" || msg.text().includes("[outline-walls]")) {
    console.log(`[console ${t}]`, msg.text());
  }
});
page.on("pageerror", (err) => console.log("[pageerror]", err.message));

await page.goto(URL, { waitUntil: "networkidle" });
// Let the scene settle (textures/GLB finish loading)
await page.waitForTimeout(2500);

// Optional Q/E presses via env (e.g. ROTATE_Q=1 presses Q once)
const numQ = Number(process.env.ROTATE_Q ?? "0") | 0;
const numE = Number(process.env.ROTATE_E ?? "0") | 0;
// Wait AFTER each press (default 400ms = post-animation). Set MID_ROTATE to
// a smaller value like 30 to capture during the snap animation.
const midDelay = Number(process.env.MID_ROTATE ?? "0");
for (let i = 0; i < numQ; i++) {
  await page.keyboard.press("KeyQ");
  if (midDelay > 0 && i === numQ - 1) {
    await page.waitForTimeout(midDelay);
  } else {
    await page.waitForTimeout(400);
  }
}
for (let i = 0; i < numE; i++) {
  await page.keyboard.press("KeyE");
  if (midDelay > 0 && i === numE - 1) {
    await page.waitForTimeout(midDelay);
  } else {
    await page.waitForTimeout(400);
  }
}
if (numQ + numE > 0 && midDelay === 0) await page.waitForTimeout(400);
const opts = { path: OUT, type: "png" };
if (CLIP) {
  const [x, y, w, h] = CLIP.split(",").map(Number);
  opts.clip = { x, y, width: w, height: h };
}
await page.screenshot(opts);
console.log(`Saved ${OUT}`);
await browser.close();
