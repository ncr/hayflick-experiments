import { expect, test, type Page } from "@playwright/test";

const ROUTE = "/#/exp/pixel-perfect-2to1";

type DebugState = {
  nativeDpr: number;
  activeDpr: number;
  maxUserScale: number;
  inputScaleX: number;
  inputScaleY: number;
  renderScale: number;
  userScale: number;
  animatedUserScale: number;
  zoomAnimationActive: boolean;
  cumulativePanDeviceX: number;
  cumulativePanDeviceY: number;
};

type WorldPoint = { x: number; y: number; z: number };
type ClientPoint = { clientX: number; clientY: number };

async function readDebugState(page: Page): Promise<DebugState> {
  const state = await page.evaluate(() => {
    const debug = (
      window as Window & {
        __pixelPerfect2to1Debug?: {
          getState: () => DebugState;
        };
      }
    ).__pixelPerfect2to1Debug;
    return debug?.getState() ?? null;
  });
  if (!state) {
    throw new Error("pixel-perfect debug state unavailable");
  }
  return state;
}

async function worldAtClient(
  page: Page,
  clientX: number,
  clientY: number
): Promise<WorldPoint> {
  const world = await page.evaluate(
    ({ x, y }) => {
      const debug = (
        window as Window & {
          __pixelPerfect2to1Debug?: {
            worldAtClient: (clientX: number, clientY: number) => WorldPoint | null;
          };
        }
      ).__pixelPerfect2to1Debug;
      return debug?.worldAtClient(x, y) ?? null;
    },
    { x: clientX, y: clientY }
  );
  if (!world) {
    throw new Error("worldAtClient returned null");
  }
  return world;
}

async function projectWorldToClient(
  page: Page,
  world: WorldPoint
): Promise<ClientPoint> {
  const projected = await page.evaluate(
    ({ x, y, z }) => {
      const debug = (
        window as Window & {
          __pixelPerfect2to1Debug?: {
            projectWorldToClient: (
              wx: number,
              wy: number,
              wz: number
            ) => ClientPoint | null;
          };
        }
      ).__pixelPerfect2to1Debug;
      return debug?.projectWorldToClient(x, y, z) ?? null;
    },
    world
  );
  if (!projected) {
    throw new Error("projectWorldToClient returned null");
  }
  return projected;
}

async function applyZoomTicks(page: Page, ticks: number, x: number, y: number) {
  if (ticks === 0) {
    return;
  }
  await page.mouse.move(x, y);
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
        const state = await readDebugState(page);
        return (
          !state.zoomAnimationActive &&
          Math.abs(state.userScale - state.animatedUserScale) < 0.05
        );
      },
      { timeout: 3_500 }
    )
    .toBe(true);
}

async function rotateQuarterTurns(page: Page, turns: number): Promise<void> {
  if (turns === 0) {
    return;
  }
  const key = turns > 0 ? "KeyE" : "KeyQ";
  for (let i = 0; i < Math.abs(turns); i += 1) {
    await page.keyboard.press(key);
    await page.waitForTimeout(420);
  }
}

async function readCanvasCursor(page: Page): Promise<string> {
  return await page.locator(".stage-host canvas").evaluate((canvas) => {
    if (!(canvas instanceof HTMLCanvasElement)) {
      return "";
    }
    return getComputedStyle(canvas).cursor;
  });
}

function computeSafeZoomLevels(
  activeDpr: number,
  minZoom: number,
  maxZoom: number
): number[] {
  const epsilon = 1e-6;
  const safeDpr = Math.max(1e-6, activeDpr);
  const levels: number[] = [];
  for (let zoom = Math.ceil(minZoom); zoom <= Math.floor(maxZoom); zoom += 1) {
    const devicePixels = zoom * safeDpr;
    if (Math.abs(devicePixels - Math.round(devicePixels)) <= epsilon) {
      levels.push(zoom);
    }
  }
  return levels;
}

test("pixel-perfect-2to1 zoom stays anchored at mouse cursor", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 920, height: 620 },
    deviceScaleFactor: 1.6
  });
  const page = await context.newPage();

  const zoomScenarios = [-2, 0, 2];
  for (const ticks of zoomScenarios) {
    await page.goto(ROUTE);
    await page.waitForTimeout(500);

    const stage = page.locator(".stage-host");
    const stageBox = await stage.boundingBox();
    if (!stageBox) {
      throw new Error("stage bounding box unavailable");
    }

    const anchorClientX = stageBox.x + stageBox.width * 0.68;
    const anchorClientY = stageBox.y + stageBox.height * 0.34;

    await applyZoomTicks(page, ticks, anchorClientX, anchorClientY);
    await waitForZoomSettle(page);

    const beforeWorld = await worldAtClient(page, anchorClientX, anchorClientY);
    await page.mouse.move(anchorClientX, anchorClientY);
    await page.mouse.wheel(0, -120);
    await waitForZoomSettle(page);

    const afterState = await readDebugState(page);
    const halfLowResPixelCss =
      (afterState.renderScale / afterState.nativeDpr) * 0.5;
    const anchorToleranceCss = halfLowResPixelCss + 0.5;

    const afterClient = await projectWorldToClient(page, beforeWorld);
    expect(
      Math.abs(afterClient.clientX - anchorClientX),
      `cursor-anchor x drift at scenario ticks=${ticks}`
    ).toBeLessThanOrEqual(anchorToleranceCss);
    expect(
      Math.abs(afterClient.clientY - anchorClientY),
      `cursor-anchor y drift at scenario ticks=${ticks}`
    ).toBeLessThanOrEqual(anchorToleranceCss);
  }

  await context.close();
});

test("pixel-perfect-2to1 keeps cursor anchor bounded during rapid zoom-out animation", async ({
  browser
}) => {
  const context = await browser.newContext({
    viewport: { width: 920, height: 620 },
    deviceScaleFactor: 1.6
  });
  const page = await context.newPage();

  for (const turns of [0, 1, 2, 3]) {
    await page.goto(ROUTE);
    await page.waitForTimeout(500);
    await rotateQuarterTurns(page, turns);

    const stage = page.locator(".stage-host");
    const stageBox = await stage.boundingBox();
    if (!stageBox) {
      throw new Error("stage bounding box unavailable");
    }

    const anchorClientX = stageBox.x + stageBox.width * 0.68;
    const anchorClientY = stageBox.y + stageBox.height * 0.34;

    await applyZoomTicks(page, 8, anchorClientX, anchorClientY);
    await waitForZoomSettle(page);

    const anchorWorld = await worldAtClient(page, anchorClientX, anchorClientY);

    await page.mouse.move(anchorClientX, anchorClientY);
    for (let i = 0; i < 8; i += 1) {
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(20);
    }

    let maxDrift = 0;
    for (let frame = 0; frame < 70; frame += 1) {
      const projected = await projectWorldToClient(page, anchorWorld);
      const drift = Math.hypot(
        projected.clientX - anchorClientX,
        projected.clientY - anchorClientY
      );
      maxDrift = Math.max(maxDrift, drift);

      const state = await readDebugState(page);
      if (
        frame > 6 &&
        !state.zoomAnimationActive &&
        Math.abs(state.userScale - state.animatedUserScale) < 0.05
      ) {
        break;
      }
      await page.waitForTimeout(30);
    }

    expect(maxDrift, `turns=${turns} rapid zoom-out anchor drift`).toBeLessThanOrEqual(8);
  }
  await context.close();
});

test("pixel-perfect-2to1 pan distance matches mouse drag and shows grabbing cursor", async ({
  browser
}) => {
  const context = await browser.newContext({
    viewport: { width: 920, height: 620 },
    deviceScaleFactor: 1.6
  });
  const page = await context.newPage();

  const scenarios = [
    { ticks: -2 },
    { ticks: 0 },
    { ticks: 2 }
  ] as const;

  for (const scenario of scenarios) {
    await page.goto(ROUTE);
    await page.waitForTimeout(500);

    const canvas = page.locator(".stage-host canvas");
    await canvas.evaluate((el) => {
      if (el instanceof HTMLCanvasElement) {
        el.focus();
      }
    });

    const initialCursor = await readCanvasCursor(page);
    expect(initialCursor === "auto" || initialCursor === "default").toBe(true);

    const canvasBox = await canvas.boundingBox();
    if (!canvasBox) {
      throw new Error("canvas bounding box unavailable");
    }
    const startX = canvasBox.x + canvasBox.width * 0.5;
    const startY = canvasBox.y + canvasBox.height * 0.5;

    await applyZoomTicks(page, scenario.ticks, startX, startY);
    await waitForZoomSettle(page);

    const before = await readDebugState(page);
    const dragCssDeltaX = 96;

    await page.mouse.move(startX, startY);
    await page.mouse.down({ button: "middle" });
    expect(await readCanvasCursor(page)).toBe("grabbing");
    await page.mouse.move(startX + dragCssDeltaX, startY, { steps: 1 });
    await page.waitForTimeout(20);
    await page.mouse.up({ button: "middle" });
    const finalCursor = await readCanvasCursor(page);
    expect(finalCursor === "auto" || finalCursor === "default").toBe(true);

    const after = await readDebugState(page);
    const measuredDeviceShift = after.cumulativePanDeviceX - before.cumulativePanDeviceX;
    const expectedDeviceShift = Math.trunc(dragCssDeltaX * before.inputScaleX);

    expect(
      Math.abs(measuredDeviceShift - expectedDeviceShift),
      `ticks=${scenario.ticks} expected pan-device parity`
    ).toBe(0);
  }

  await context.close();
});

test("pixel-perfect-2to1 rotated views keep pan parity and bounded scene motion", async ({
  browser
}) => {
  const context = await browser.newContext({
    viewport: { width: 920, height: 620 },
    deviceScaleFactor: 1.6
  });
  const page = await context.newPage();
  const dragCssDeltaX = 96;

  for (const turns of [0, 1, 2, 3]) {
    await page.goto(ROUTE);
    await page.waitForTimeout(500);

    const canvas = page.locator(".stage-host canvas");
    await canvas.evaluate((el) => {
      if (el instanceof HTMLCanvasElement) {
        el.focus();
      }
    });

    await rotateQuarterTurns(page, turns);

    const canvasBox = await canvas.boundingBox();
    if (!canvasBox) {
      throw new Error("canvas bounding box unavailable");
    }
    const centerX = canvasBox.x + canvasBox.width * 0.5;
    const centerY = canvasBox.y + canvasBox.height * 0.5;

    const projectedBefore = await projectWorldToClient(page, { x: 0, y: 0, z: 0 });
    const before = await readDebugState(page);

    await page.mouse.move(centerX, centerY);
    await page.mouse.down({ button: "middle" });
    await page.mouse.move(centerX + dragCssDeltaX, centerY, { steps: 1 });
    await page.waitForTimeout(20);
    await page.mouse.up({ button: "middle" });

    const projectedAfter = await projectWorldToClient(page, { x: 0, y: 0, z: 0 });
    const after = await readDebugState(page);

    const measuredDeviceShift = after.cumulativePanDeviceX - before.cumulativePanDeviceX;
    const expectedDeviceShift = Math.trunc(dragCssDeltaX * before.inputScaleX);
    expect(
      Math.abs(measuredDeviceShift - expectedDeviceShift),
      `turns=${turns} pan-device parity`
    ).toBe(0);

    const projectedDelta = Math.hypot(
      projectedAfter.clientX - projectedBefore.clientX,
      projectedAfter.clientY - projectedBefore.clientY
    );
    const projectedDeltaX = projectedAfter.clientX - projectedBefore.clientX;
    const projectedDeltaY = projectedAfter.clientY - projectedBefore.clientY;
    expect(projectedDelta, `turns=${turns} projected scene shift should be visible`).toBeGreaterThan(20);
    expect(projectedDelta, `turns=${turns} projected scene shift should be bounded`).toBeLessThan(180);
    expect(
      Math.abs(projectedDeltaY),
      `turns=${turns} horizontal drag should not shift scene vertically`
    ).toBeLessThanOrEqual(2);
    expect(
      Math.abs(projectedDeltaX),
      `turns=${turns} horizontal drag should shift scene on x axis`
    ).toBeGreaterThan(20);
  }

  await context.close();
});

test("pixel-perfect-2to1 wheel advances one safe step per wheel event", async ({
  browser
}) => {
  const context = await browser.newContext({
    viewport: { width: 920, height: 620 },
    deviceScaleFactor: 1.6
  });
  const page = await context.newPage();
  await page.goto(ROUTE);
  await page.waitForTimeout(500);

  const stage = page.locator(".stage-host");
  const stageBox = await stage.boundingBox();
  if (!stageBox) {
    throw new Error("stage bounding box unavailable");
  }
  const x = stageBox.x + stageBox.width * 0.5;
  const y = stageBox.y + stageBox.height * 0.5;
  await page.mouse.move(x, y);
  // Explicitly enter safe-ladder mode for this assertion.
  await page.keyboard.press("KeyZ");
  await page.waitForTimeout(80);

  const before = await readDebugState(page);
  for (let i = 0; i < 5; i += 1) {
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(220);
  }
  await waitForZoomSettle(page);
  const after = await readDebugState(page);

  const safe = computeSafeZoomLevels(before.activeDpr, 1, before.maxUserScale);
  let expected = before.userScale;
  for (let i = 0; i < 5; i += 1) {
    expected = safe.find((level) => level > expected) ?? expected;
  }
  expect(after.userScale).toBe(expected);
  await context.close();
});

test("pixel-perfect-2to1 pan conversion follows canvas css-to-device ratio", async ({
  browser
}) => {
  const context = await browser.newContext({
    viewport: { width: 920, height: 620 },
    deviceScaleFactor: 1.6
  });
  const page = await context.newPage();
  await page.goto(ROUTE);
  await page.waitForTimeout(500);

  const canvas = page.locator(".stage-host canvas");
  await canvas.evaluate((el) => {
    if (!(el instanceof HTMLCanvasElement)) {
      return;
    }
    const rect = el.getBoundingClientRect();
    // Simulate responsive/layout scaling where CSS and backing-store ratios diverge.
    el.style.width = `${rect.width * 0.87}px`;
    el.style.height = `${rect.height * 0.87}px`;
  });
  await page.waitForTimeout(100);

  const before = await readDebugState(page);
  const canvasBox = await canvas.boundingBox();
  if (!canvasBox) {
    throw new Error("canvas bounding box unavailable");
  }
  const startX = canvasBox.x + canvasBox.width * 0.5;
  const startY = canvasBox.y + canvasBox.height * 0.5;
  const dragCssDeltaX = 80;

  await page.mouse.move(startX, startY);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(startX + dragCssDeltaX, startY, { steps: 1 });
  await page.waitForTimeout(20);
  await page.mouse.up({ button: "middle" });

  const after = await readDebugState(page);
  const measuredDeviceShift = after.cumulativePanDeviceX - before.cumulativePanDeviceX;
  const expectedFromCanvasRatio = Math.trunc(dragCssDeltaX * before.inputScaleX);

  expect(Math.abs(measuredDeviceShift - expectedFromCanvasRatio)).toBeLessThanOrEqual(1);
  expect(
    Math.abs(before.inputScaleX - before.nativeDpr),
    "ratio test requires css/device scale to differ from native DPR"
  ).toBeGreaterThan(0.05);

  await context.close();
});

test("pixel-perfect-2to1 keeps canvas size fixed while zooming", async ({
  browser
}) => {
  const context = await browser.newContext({
    viewport: { width: 920, height: 620 },
    deviceScaleFactor: 1.6
  });
  const page = await context.newPage();
  await page.goto(ROUTE);
  await page.waitForTimeout(500);

  const canvas = page.locator(".stage-host canvas");
  const boxBefore = await canvas.boundingBox();
  if (!boxBefore) {
    throw new Error("canvas bounding box unavailable");
  }

  const x = boxBefore.x + boxBefore.width * 0.5;
  const y = boxBefore.y + boxBefore.height * 0.5;

  for (let i = 0; i < 3; i += 1) {
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(220);
  }
  await waitForZoomSettle(page);

  for (let i = 0; i < 3; i += 1) {
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(220);
  }
  await waitForZoomSettle(page);

  const boxAfter = await canvas.boundingBox();
  if (!boxAfter) {
    throw new Error("canvas bounding box unavailable");
  }

  expect(Math.abs(boxAfter.width - boxBefore.width)).toBeLessThanOrEqual(0.01);
  expect(Math.abs(boxAfter.height - boxBefore.height)).toBeLessThanOrEqual(0.01);

  await context.close();
});
