import { expect, test } from "@playwright/test";
import * as THREE from "three";

const ORTHO_HEIGHT = 5.966213466261495;
const CAMERA_PITCH = THREE.MathUtils.degToRad(30);
const CAMERA_YAW = THREE.MathUtils.degToRad(45);
const CAMERA_DISTANCE = 30;
const REFERENCE_RENDER_HEIGHT = 270;

type PixelPoint = { x: number; y: number };

function createCamera(lowRenderWidth: number, lowRenderHeight: number) {
  const aspect = lowRenderWidth / lowRenderHeight;
  const halfHeight =
    ORTHO_HEIGHT * 0.5 * (lowRenderHeight / REFERENCE_RENDER_HEIGHT);
  const camera = new THREE.OrthographicCamera(
    -halfHeight * aspect,
    halfHeight * aspect,
    halfHeight,
    -halfHeight,
    0.1,
    200
  );

  const horizontal = Math.cos(CAMERA_PITCH);
  const dir = new THREE.Vector3(
    Math.sin(CAMERA_YAW) * horizontal,
    Math.sin(CAMERA_PITCH),
    Math.cos(CAMERA_YAW) * horizontal
  );
  const target = new THREE.Vector3(0, 0, 0);
  camera.position.copy(target).addScaledVector(dir, CAMERA_DISTANCE);
  camera.lookAt(target);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  return camera;
}

function projectToLowRes(
  camera: THREE.OrthographicCamera,
  v: THREE.Vector3,
  lowRenderWidth: number,
  lowRenderHeight: number
) {
  const p = v.clone().project(camera);
  const x = (p.x * 0.5 + 0.5) * lowRenderWidth;
  const y = (1 - (p.y * 0.5 + 0.5)) * lowRenderHeight;
  return { x, y };
}

function rasterizeLine(
  x0: number,
  y0: number,
  x1: number,
  y1: number
): PixelPoint[] {
  const points: PixelPoint[] = [];

  let px = x0;
  let py = y0;
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;

  while (true) {
    points.push({ x: px, y: py });
    if (px === x1 && py === y1) break;
    const e2 = err * 2;
    if (e2 > -dy) {
      err -= dy;
      px += sx;
    }
    if (e2 < dx) {
      err += dx;
      py += sy;
    }
  }

  return points;
}

function rowsFromLine(points: PixelPoint[]) {
  const byRow = new Map<number, number[]>();
  for (const p of points) {
    const xs = byRow.get(p.y);
    if (xs) {
      xs.push(p.x);
    } else {
      byRow.set(p.y, [p.x]);
    }
  }

  return [...byRow.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([y, xs]) => ({
      y,
      x: Math.round(xs.reduce((acc, v) => acc + v, 0) / xs.length)
    }));
}

test("pixel-perfect-2to1 rendered cube top edges are strict interior 2:1 staircases", async ({
  page
}) => {
  await page.goto("/#/exp/pixel-perfect-2to1");
  await page.waitForTimeout(500);

  const stage = page.locator(".stage-host");
  const canvas = stage.locator("canvas");
  await expect(canvas).toBeVisible();
  const stageBox = await stage.boundingBox();
  if (!stageBox) {
    throw new Error("stage bounding box unavailable");
  }
  const centerX = stageBox.x + stageBox.width * 0.5;
  const centerY = stageBox.y + stageBox.height * 0.5;
  await page.mouse.move(centerX, centerY);
  for (let i = 0; i < 8; i += 1) {
    const currentZoom = await page.evaluate(() => {
      const debug = (
        window as Window & {
          __pixelPerfect2to1Debug?: {
            getState: () => { userScale: number };
          };
        }
      ).__pixelPerfect2to1Debug;
      return debug?.getState().userScale ?? null;
    });
    if (currentZoom === 1) {
      break;
    }
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(220);
  }
  await expect
    .poll(async () => {
      return await page.evaluate(() => {
        const debug = (
          window as Window & {
            __pixelPerfect2to1Debug?: {
              getState: () => { userScale: number };
            };
          }
        ).__pixelPerfect2to1Debug;
        return debug?.getState().userScale ?? null;
      });
    })
    .toBe(1);

  const metrics = await page.evaluate(() => {
    const host = document.querySelector(".stage-host");
    const canvasEl = host?.querySelector("canvas");
    if (!(host instanceof HTMLElement) || !(canvasEl instanceof HTMLCanvasElement)) {
      return null;
    }
    const debug = (
      window as Window & {
        __pixelPerfect2to1Debug?: {
          getState: () => {
            lowRenderWidth: number;
            lowRenderHeight: number;
            renderScale: number;
            renderBaseX: number;
            renderBaseY: number;
            outputPadDeviceX: number;
            outputPadDeviceY: number;
            panRemainderX: number;
            panRemainderY: number;
          };
        };
      }
    ).__pixelPerfect2to1Debug;
    const renderState = debug?.getState();
    if (!renderState) {
      return null;
    }
    const hostRect = host.getBoundingClientRect();
    const canvasRect = canvasEl.getBoundingClientRect();
    return {
      hostRect: {
        x: hostRect.x,
        y: hostRect.y,
        width: hostRect.width,
        height: hostRect.height
      },
      canvasRect: {
        x: canvasRect.x,
        y: canvasRect.y,
        width: canvasRect.width,
        height: canvasRect.height
      },
      canvasBuffer: { width: canvasEl.width, height: canvasEl.height },
      renderState
    };
  });
  expect(metrics).not.toBeNull();
  if (!metrics) return;

  const screenshot = await stage.screenshot();
  const camera = createCamera(
    metrics.renderState.lowRenderWidth,
    metrics.renderState.lowRenderHeight
  );

  const topCenter = projectToLowRes(
    camera,
    new THREE.Vector3(-1, 1, 2),
    metrics.renderState.lowRenderWidth,
    metrics.renderState.lowRenderHeight
  );
  const xSideCenter = projectToLowRes(
    camera,
    new THREE.Vector3(-0.5, 0.5, 2),
    metrics.renderState.lowRenderWidth,
    metrics.renderState.lowRenderHeight
  );
  const zSideCenter = projectToLowRes(
    camera,
    new THREE.Vector3(-1, 0.5, 2.5),
    metrics.renderState.lowRenderWidth,
    metrics.renderState.lowRenderHeight
  );

  const edgeAStart = projectToLowRes(
    camera,
    new THREE.Vector3(-0.5, 1, 1.5),
    metrics.renderState.lowRenderWidth,
    metrics.renderState.lowRenderHeight
  );
  const edgeAEnd = projectToLowRes(
    camera,
    new THREE.Vector3(-0.5, 1, 2.5),
    metrics.renderState.lowRenderWidth,
    metrics.renderState.lowRenderHeight
  );
  const edgeBStart = projectToLowRes(
    camera,
    new THREE.Vector3(-1.5, 1, 2.5),
    metrics.renderState.lowRenderWidth,
    metrics.renderState.lowRenderHeight
  );
  const edgeBEnd = projectToLowRes(
    camera,
    new THREE.Vector3(-0.5, 1, 2.5),
    metrics.renderState.lowRenderWidth,
    metrics.renderState.lowRenderHeight
  );

  const edgeA = rowsFromLine(
    rasterizeLine(
      Math.round(edgeAStart.x),
      Math.round(edgeAStart.y),
      Math.round(edgeAEnd.x),
      Math.round(edgeAEnd.y)
    )
  );
  const edgeB = rowsFromLine(
    rasterizeLine(
      Math.round(edgeBStart.x),
      Math.round(edgeBStart.y),
      Math.round(edgeBEnd.x),
      Math.round(edgeBEnd.y)
    )
  );

  const analysis = await page.evaluate(
    async ({
      png,
      metricsData,
      topCenterPx,
      xSideCenterPx,
      zSideCenterPx,
      edgeRowsA,
      edgeRowsB
    }) => {
      const bytes = new Uint8Array(png as number[]);
      const blob = new Blob([bytes], { type: "image/png" });
      const bitmap = await createImageBitmap(blob);
      const canvasImage = document.createElement("canvas");
      canvasImage.width = bitmap.width;
      canvasImage.height = bitmap.height;
      const ctx = canvasImage.getContext("2d");
      if (!ctx) {
        return { error: "2d context unavailable" };
      }
      ctx.drawImage(bitmap, 0, 0);
      const image = ctx.getImageData(0, 0, canvasImage.width, canvasImage.height);
      const data = image.data;

      const hostRect = metricsData.hostRect as {
        x: number;
        y: number;
        width: number;
        height: number;
      };
      const canvasRect = metricsData.canvasRect as {
        x: number;
        y: number;
        width: number;
        height: number;
      };
      const canvasBuffer = metricsData.canvasBuffer as {
        width: number;
        height: number;
      };
      const renderState = metricsData.renderState as {
        renderScale: number;
        renderBaseX: number;
        renderBaseY: number;
        outputPadDeviceX: number;
        outputPadDeviceY: number;
        panRemainderX: number;
        panRemainderY: number;
      };
      const cssToDeviceX =
        canvasRect.width > 0 ? canvasBuffer.width / canvasRect.width : 1;
      const cssToDeviceY =
        canvasRect.height > 0 ? canvasBuffer.height / canvasRect.height : 1;
      const hostScreenshotScaleX =
        hostRect.width > 0 ? canvasImage.width / hostRect.width : 1;
      const hostScreenshotScaleY =
        hostRect.height > 0 ? canvasImage.height / hostRect.height : 1;
      const offsetX = canvasRect.x - hostRect.x;
      const offsetY = canvasRect.y - hostRect.y;

      const toHostSample = (lx: number, ly: number) => {
        const deviceX =
          renderState.renderBaseX +
          renderState.panRemainderX +
          renderState.outputPadDeviceX +
          (lx + 0.5) * renderState.renderScale;
        const deviceY =
          renderState.renderBaseY +
          renderState.panRemainderY +
          renderState.outputPadDeviceY +
          (ly + 0.5) * renderState.renderScale;
        const hostCssX = offsetX + deviceX / cssToDeviceX;
        const hostCssY = offsetY + deviceY / cssToDeviceY;
        return {
          x: Math.round(hostCssX * hostScreenshotScaleX),
          y: Math.round(hostCssY * hostScreenshotScaleY)
        };
      };

      const colorAtHost = (hx: number, hy: number) => {
        if (hx < 0 || hy < 0 || hx >= canvasImage.width || hy >= canvasImage.height) {
          return null;
        }
        const i = (hy * canvasImage.width + hx) * 4;
        return [data[i], data[i + 1], data[i + 2], data[i + 3]];
      };

      const colorAtLow = (lx: number, ly: number) => {
        const s = toHostSample(lx, ly);
        return colorAtHost(s.x, s.y);
      };

      const sameColor = (a: number[] | null, b: number[] | null) =>
        !!a &&
        !!b &&
        a[0] === b[0] &&
        a[1] === b[1] &&
        a[2] === b[2] &&
        a[3] === b[3];

      const topColor = colorAtLow(topCenterPx.x, topCenterPx.y);
      const sideColorA = colorAtLow(xSideCenterPx.x, xSideCenterPx.y);
      const sideColorB = colorAtLow(zSideCenterPx.x, zSideCenterPx.y);

      if (!topColor || !sideColorA || !sideColorB) {
        return { error: "sample colors unavailable" };
      }

      const isTopToSideBoundary = (
        lx: number,
        ly: number,
        sideColor: number[]
      ) => {
        const center = colorAtLow(lx, ly);
        if (!sameColor(center, topColor)) return false;
        const neighbors = [
          colorAtLow(lx + 1, ly),
          colorAtLow(lx - 1, ly),
          colorAtLow(lx, ly + 1),
          colorAtLow(lx, ly - 1)
        ];
        return neighbors.some((n) => sameColor(n, sideColor));
      };

      const analyzeEdge = (rows: Array<{ y: number; x: number }>, sideColor: number[]) => {
        const matches: Array<{ y: number; idealX: number; actualX: number }> = [];
        for (const row of rows) {
          let bestX = Number.NaN;
          let bestDist = Number.POSITIVE_INFINITY;
          for (let x = row.x - 3; x <= row.x + 3; x += 1) {
            if (!isTopToSideBoundary(x, row.y, sideColor)) continue;
            const d = Math.abs(x - row.x);
            if (d < bestDist) {
              bestDist = d;
              bestX = x;
            }
          }
          if (Number.isFinite(bestX)) {
            matches.push({ y: row.y, idealX: row.x, actualX: bestX });
          }
        }

        if (matches.length < 5) {
          return { error: "not enough matched rows", matches };
        }

        const interior = matches.slice(1, -1);
        const stepViolations: Array<{ y: number; dx: number }> = [];
        for (let i = 1; i < interior.length; i += 1) {
          const dx = interior[i].actualX - interior[i - 1].actualX;
          if (Math.abs(dx) !== 2) {
            stepViolations.push({ y: interior[i].y, dx });
          }
        }

        return { matches, stepViolations };
      };

      return {
        topColor,
        sideColorA,
        sideColorB,
        edgeA: analyzeEdge(edgeRowsA, sideColorA),
        edgeB: analyzeEdge(edgeRowsB, sideColorB)
      };
    },
    {
      png: Array.from(screenshot),
      metricsData: metrics,
      topCenterPx: { x: topCenter.x, y: topCenter.y },
      xSideCenterPx: { x: xSideCenter.x, y: xSideCenter.y },
      zSideCenterPx: { x: zSideCenter.x, y: zSideCenter.y },
      edgeRowsA: edgeA,
      edgeRowsB: edgeB
    }
  );

  if ("error" in analysis) {
    throw new Error(`analysis failed: ${JSON.stringify(analysis)}`);
  }

  const detectedEdges = [analysis.edgeA, analysis.edgeB].filter(
    (edge): edge is { matches: Array<{ y: number; idealX: number; actualX: number }>; stepViolations: Array<{ y: number; dx: number }> } =>
      !("error" in edge)
  );
  expect(detectedEdges.length).toBeGreaterThanOrEqual(1);
  for (const edge of detectedEdges) {
    expect(edge.stepViolations.length).toBe(0);
  }
});
