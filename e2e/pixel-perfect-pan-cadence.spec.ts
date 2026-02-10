import { expect, test, type Page } from "@playwright/test";

type Signature = {
  width: number;
  height: number;
  gray: Uint8Array;
};

type Shift = {
  dx: number;
  dy: number;
  score: number;
};

const ROUTE = "/#/exp/pixel-perfect-2to1";
const SAMPLE_STEP = 2;
const MAX_SHIFT = 12;
const DRAG_STEPS = 8;
const DRAG_PIXELS_PER_STEP = 5;

async function focusCanvas(page: Page): Promise<void> {
  await page.locator(".stage-host canvas").evaluate((el) => {
    if (el instanceof HTMLCanvasElement) {
      el.focus();
    }
  });
}

async function applyZoomTicks(page: Page, ticks: number): Promise<void> {
  if (ticks === 0) {
    return;
  }
  const stageBox = await page.locator(".stage-host").boundingBox();
  if (!stageBox) {
    throw new Error("stage bounding box unavailable");
  }
  await page.mouse.move(
    stageBox.x + stageBox.width * 0.5,
    stageBox.y + stageBox.height * 0.5
  );
  const wheelDeltaY = ticks > 0 ? -120 : 120;
  for (let i = 0; i < Math.abs(ticks); i += 1) {
    await page.mouse.wheel(0, wheelDeltaY);
    await page.waitForTimeout(40);
  }
}

async function waitForZoomSettle(page: Page) {
  await expect
    .poll(
      async () => {
        return await page.evaluate(() => {
          const debug = (
            window as Window & {
              __pixelPerfect2to1Debug?: {
                getState: () => {
                  userScale: number;
                  animatedUserScale: number;
                  zoomAnimationActive: boolean;
                };
              };
            }
          ).__pixelPerfect2to1Debug;
          if (!debug) {
            return false;
          }
          const state = debug.getState();
          return (
            !state.zoomAnimationActive &&
            Math.abs(state.userScale - state.animatedUserScale) < 0.05
          );
        });
      },
      { timeout: 3_500 }
    )
    .toBe(true);
}

async function captureSignature(page: Page): Promise<Signature> {
  const png = await page.locator(".stage-host").screenshot();
  const raw = await page.evaluate(
    async ({ bytes, sampleStep }) => {
      const blob = new Blob([Uint8Array.from(bytes)], { type: "image/png" });
      const bitmap = await createImageBitmap(blob);

      const sampleWidth = Math.max(32, Math.floor(bitmap.width / sampleStep));
      const sampleHeight = Math.max(32, Math.floor(bitmap.height / sampleStep));

      const canvas = document.createElement("canvas");
      canvas.width = sampleWidth;
      canvas.height = sampleHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new Error("2d context unavailable");
      }
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(bitmap, 0, 0, sampleWidth, sampleHeight);

      const cropWidth = Math.max(48, Math.floor(sampleWidth * 0.14));
      const cropHeight = Math.max(48, Math.floor(sampleHeight * 0.14));
      const cropStartX = Math.floor((sampleWidth - cropWidth) * 0.5);
      const cropStartY = Math.floor((sampleHeight - cropHeight) * 0.5);

      const rgba = ctx.getImageData(cropStartX, cropStartY, cropWidth, cropHeight).data;
      const gray = new Uint8Array(cropWidth * cropHeight);
      for (let i = 0, j = 0; i < rgba.length; i += 4, j += 1) {
        gray[j] = Math.round(
          rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114
        );
      }

      return {
        width: cropWidth,
        height: cropHeight,
        gray: Array.from(gray)
      };
    },
    { bytes: Array.from(png), sampleStep: SAMPLE_STEP }
  );

  return {
    width: raw.width,
    height: raw.height,
    gray: Uint8Array.from(raw.gray)
  };
}

function estimateShift(previous: Signature, next: Signature): Shift {
  const margin = 6;
  const maxX = previous.width - margin;
  const maxY = previous.height - margin;
  let best: Shift = {
    dx: 0,
    dy: 0,
    score: Number.POSITIVE_INFINITY
  };

  for (let dy = -MAX_SHIFT; dy <= MAX_SHIFT; dy += 1) {
    for (let dx = -MAX_SHIFT; dx <= MAX_SHIFT; dx += 1) {
      let diff = 0;
      let count = 0;
      for (let y = margin; y < maxY; y += 2) {
        const y2 = y + dy;
        if (y2 < margin || y2 >= maxY) {
          continue;
        }
        for (let x = margin; x < maxX; x += 2) {
          const x2 = x + dx;
          if (x2 < margin || x2 >= maxX) {
            continue;
          }
          const i1 = y * previous.width + x;
          const i2 = y2 * next.width + x2;
          diff += Math.abs(previous.gray[i1] - next.gray[i2]);
          count += 1;
        }
      }
      if (count === 0) {
        continue;
      }
      const score = diff / count;
      if (score < best.score) {
        best = { dx, dy, score };
      }
    }
  }

  return best;
}

async function measurePanMagnitudes(page: Page): Promise<number[]> {
  const stageBox = await page.locator(".stage-host").boundingBox();
  if (!stageBox) {
    throw new Error("stage bounding box unavailable");
  }

  const startX = Math.round(stageBox.x + stageBox.width * 0.5);
  const startY = Math.round(stageBox.y + stageBox.height * 0.5);
  await page.mouse.move(startX, startY);
  await page.mouse.down({ button: "middle" });

  const magnitudes: number[] = [];
  let previous = await captureSignature(page);

  for (let i = 0; i < DRAG_STEPS; i += 1) {
    await page.mouse.move(startX + (i + 1) * DRAG_PIXELS_PER_STEP, startY, {
      steps: 1
    });
    await page.waitForTimeout(20);
    const next = await captureSignature(page);
    const shift = estimateShift(previous, next);
    magnitudes.push(Math.abs(shift.dx));
    previous = next;
  }

  await page.mouse.up({ button: "middle" });
  return magnitudes;
}

test("pixel-perfect-2to1 keeps consistent native pan cadence across zoom levels", async ({
  browser
}) => {
  const context = await browser.newContext({
    viewport: { width: 920, height: 620 },
    deviceScaleFactor: 1.6
  });
  const page = await context.newPage();

  const zoomScenarios = [
    { name: "zoom2", ticks: -2 },
    { name: "zoom4", ticks: 0 },
    { name: "zoom6", ticks: 2 }
  ];

  for (const scenario of zoomScenarios) {
    await page.goto(ROUTE);
    await page.waitForTimeout(500);
    await focusCanvas(page);
    await applyZoomTicks(page, scenario.ticks);
    await waitForZoomSettle(page);
    const magnitudes = await measurePanMagnitudes(page);

    const steadyMagnitudes = magnitudes.slice(1);
    const sorted = [...steadyMagnitudes].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length * 0.5)];

    expect(
      median,
      `${scenario.name} median measured shift should stay at or above 3`
    ).toBeGreaterThanOrEqual(3);
  }

  await context.close();
});
