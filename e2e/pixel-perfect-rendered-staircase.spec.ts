import { expect, test } from "@playwright/test";
import * as THREE from "three";

const FIXED_RENDER_WIDTH = 480;
const FIXED_RENDER_HEIGHT = 270;
const ORTHO_HEIGHT = 5.966213466261495;
const CAMERA_PITCH = THREE.MathUtils.degToRad(30);
const CAMERA_YAW = THREE.MathUtils.degToRad(45);
const CAMERA_DISTANCE = 30;

type PixelPoint = { x: number; y: number };

function createCamera() {
  const aspect = FIXED_RENDER_WIDTH / FIXED_RENDER_HEIGHT;
  const halfHeight = ORTHO_HEIGHT * 0.5;
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

function projectToLowRes(camera: THREE.OrthographicCamera, v: THREE.Vector3) {
  const p = v.clone().project(camera);
  const x = (p.x * 0.5 + 0.5) * FIXED_RENDER_WIDTH;
  const y = (1 - (p.y * 0.5 + 0.5)) * FIXED_RENDER_HEIGHT;
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

  const metrics = await page.evaluate(() => {
    const host = document.querySelector(".stage-host");
    const canvasEl = host?.querySelector("canvas");
    if (!(host instanceof HTMLElement) || !(canvasEl instanceof HTMLCanvasElement)) {
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
      canvasBuffer: { width: canvasEl.width, height: canvasEl.height }
    };
  });
  expect(metrics).not.toBeNull();
  if (!metrics) return;

  const screenshot = await stage.screenshot();
  const camera = createCamera();

  const cubeCenter = new THREE.Vector3(-1, 0.5, 2);
  const topCenter = projectToLowRes(camera, new THREE.Vector3(-1, 1, 2));
  const xSideCenter = projectToLowRes(camera, new THREE.Vector3(-0.5, 0.5, 2));
  const zSideCenter = projectToLowRes(camera, new THREE.Vector3(-1, 0.5, 2.5));

  const edgeAStart = projectToLowRes(camera, new THREE.Vector3(-0.5, 1, 1.5));
  const edgeAEnd = projectToLowRes(camera, new THREE.Vector3(-0.5, 1, 2.5));
  const edgeBStart = projectToLowRes(camera, new THREE.Vector3(-1.5, 1, 2.5));
  const edgeBEnd = projectToLowRes(camera, new THREE.Vector3(-0.5, 1, 2.5));

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
      fixedWidth,
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
      const scale = Math.max(
        1,
        Math.round(canvasBuffer.width / (fixedWidth + 2))
      );
      const pad = scale;
      const offsetX = canvasRect.x - hostRect.x;
      const offsetY = canvasRect.y - hostRect.y;

      const toHostSample = (lx: number, ly: number) => ({
        x: Math.round(offsetX + pad + lx * scale + scale * 0.5),
        y: Math.round(offsetY + pad + ly * scale + scale * 0.5)
      });

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
      fixedWidth: FIXED_RENDER_WIDTH,
      topCenterPx: { x: topCenter.x, y: topCenter.y },
      xSideCenterPx: { x: xSideCenter.x, y: xSideCenter.y },
      zSideCenterPx: { x: zSideCenter.x, y: zSideCenter.y },
      edgeRowsA: edgeA,
      edgeRowsB: edgeB
    }
  );

  expect("error" in analysis).toBe(false);
  if ("error" in analysis) {
    throw new Error(analysis.error);
  }

  expect("error" in analysis.edgeA).toBe(false);
  expect("error" in analysis.edgeB).toBe(false);
  if ("error" in analysis.edgeA || "error" in analysis.edgeB) {
    throw new Error(
      `edge analysis failed: ${JSON.stringify({
        edgeA: analysis.edgeA,
        edgeB: analysis.edgeB
      })}`
    );
  }

  expect(analysis.edgeA.stepViolations.length).toBe(0);
  expect(analysis.edgeB.stepViolations.length).toBe(0);
});
