import { describe, expect, it } from "vitest";
import { createRequire } from "module";
import {
  CAMERA_DISTANCE,
  CAMERA_PITCH,
  CAMERA_YAW,
  FIXED_RENDER_HEIGHT,
  FIXED_RENDER_WIDTH,
  ORTHO_HEIGHT
} from "./config";

const require = createRequire(import.meta.url);
const THREE = require("three");

function projectToPixels(camera: any, v: any) {
  const p = v.clone().project(camera);
  const x = (p.x * 0.5 + 0.5) * FIXED_RENDER_WIDTH;
  const y = (1 - (p.y * 0.5 + 0.5)) * FIXED_RENDER_HEIGHT;
  return new THREE.Vector2(x, y);
}

function collectStairSteps(camera: any, start: any, dir: any) {
  const EPS = 1e-4;
  const p0 = projectToPixels(camera, start);
  const p1 = projectToPixels(camera, start.clone().add(dir));
  const x0 = Math.floor(p0.x + EPS);
  const y0 = Math.floor(p0.y + EPS);
  const x1 = Math.floor(p1.x + EPS);
  const y1 = Math.floor(p1.y + EPS);

  const points: any[] = [];
  let dx = Math.abs(x1 - x0);
  let dy = Math.abs(y1 - y0);
  let sx = x0 < x1 ? 1 : -1;
  let sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0;
  let y = y0;
  while (true) {
    const last = points[points.length - 1];
    if (!last || last.x !== x || last.y !== y) {
      points.push({ x, y });
    }
    if (x === x1 && y === y1) {
      break;
    }
    const e2 = err * 2;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
  return points;
}

function stairSet(points: { x: number; y: number }[]) {
  const set = new Set<string>();
  points.forEach((p) => set.add(`${p.x},${p.y}`));
  return set;
}

function assertShiftedMatch(
  baseline: Set<string>,
  candidate: Set<string>,
  dx: number,
  dy: number
) {
  const shifted = new Set<string>();
  baseline.forEach((key) => {
    const [x, y] = key.split(",").map(Number);
    shifted.add(`${x + dx},${y + dy}`);
  });
  expect(candidate.size).toBe(shifted.size);
  shifted.forEach((key) => expect(candidate.has(key)).toBe(true));
}

function buildCamera() {
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
  return { camera, dir };
}

function alignTargetToPixelGrid(
  camera: any,
  baseTarget: any,
  screenRight: any,
  screenDown: any
) {
  const projected = baseTarget.clone().project(camera);
  const pixelX = (projected.x * 0.5 + 0.5) * FIXED_RENDER_WIDTH;
  const pixelY = (1 - (projected.y * 0.5 + 0.5)) * FIXED_RENDER_HEIGHT;
  const targetX = Math.round(pixelX - 0.5) + 0.5;
  const targetY = Math.round(pixelY - 0.5) + 0.5;
  const deltaX = targetX - pixelX;
  const deltaY = targetY - pixelY;
  const next = baseTarget.clone();
  if (deltaX !== 0) {
    next.addScaledVector(screenRight, deltaX);
  }
  if (deltaY !== 0) {
    next.addScaledVector(screenDown, deltaY);
  }
  return next;
}

describe("pixel-perfect-2to1", () => {
  it("projects unit steps to a 2:1 pixel ratio with integer steps", () => {
    const { camera, dir } = buildCamera();
    const target = new THREE.Vector3(0, 0, 0);
    camera.position.copy(target).addScaledVector(dir, CAMERA_DISTANCE);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();

    const origin = projectToPixels(camera, new THREE.Vector3(0, 0, 0));
    const stepX = projectToPixels(camera, new THREE.Vector3(1, 0, 0));
    const stepZ = projectToPixels(camera, new THREE.Vector3(0, 0, 1));

    const dx = stepX.clone().sub(origin);
    const dz = stepZ.clone().sub(origin);

    const ratioX = Math.abs(dx.x / dx.y);
    const ratioZ = Math.abs(dz.x / dz.y);

    expect(ratioX).toBeCloseTo(2, 6);
    expect(ratioZ).toBeCloseTo(2, 6);

    const absDx = Math.abs(dx.x);
    const absDy = Math.abs(dx.y);
    expect(absDx).toBeCloseTo(Math.round(absDx), 6);
    expect(absDy).toBeCloseTo(Math.round(absDy), 6);

    expect(absDx).toBeCloseTo(32, 6);
    expect(absDy).toBeCloseTo(16, 6);
  });

  it("keeps staircase pixelization stable under pixel-aligned pan", () => {
    const { camera, dir } = buildCamera();
    const base = new THREE.Vector3(0, 0, 0);
    const lineDir = new THREE.Vector3(6, 0, 0);

    camera.position.copy(base).addScaledVector(dir, CAMERA_DISTANCE);
    camera.lookAt(base);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();

    const cameraRight = new THREE.Vector3(
      camera.matrixWorld.elements[0],
      camera.matrixWorld.elements[1],
      camera.matrixWorld.elements[2]
    ).normalize();
    const cameraUp = new THREE.Vector3(
      camera.matrixWorld.elements[4],
      camera.matrixWorld.elements[5],
      camera.matrixWorld.elements[6]
    ).normalize();
    const anchor = base.clone();
    const projAnchor = anchor.clone().project(camera);
    const projRight = anchor.clone().add(cameraRight).project(camera);
    const projDown = anchor.clone().add(cameraUp).project(camera);

    const pixelAnchorX = (projAnchor.x * 0.5 + 0.5) * FIXED_RENDER_WIDTH;
    const pixelAnchorY = (1 - (projAnchor.y * 0.5 + 0.5)) * FIXED_RENDER_HEIGHT;
    const pixelRightX = (projRight.x * 0.5 + 0.5) * FIXED_RENDER_WIDTH;
    const pixelDownY = (1 - (projDown.y * 0.5 + 0.5)) * FIXED_RENDER_HEIGHT;

    const pixelsPerWorldX = pixelRightX - pixelAnchorX;
    const pixelsPerWorldY = pixelDownY - pixelAnchorY;

    const screenRight = cameraRight.multiplyScalar(1 / pixelsPerWorldX);
    const screenDown = cameraUp.multiplyScalar(1 / pixelsPerWorldY);

    const alignedBase = alignTargetToPixelGrid(
      camera,
      base,
      screenRight,
      screenDown
    );

    camera.position.copy(alignedBase).addScaledVector(dir, CAMERA_DISTANCE);
    camera.lookAt(alignedBase);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();

    const alignProjected = alignedBase.clone().project(camera);
    const alignPixelX = (alignProjected.x * 0.5 + 0.5) * FIXED_RENDER_WIDTH;
    const alignPixelY = (1 - (alignProjected.y * 0.5 + 0.5)) * FIXED_RENDER_HEIGHT;
    const alignTargetX = Math.round(alignPixelX - 0.5) + 0.5;
    const alignTargetY = Math.round(alignPixelY - 0.5) + 0.5;
    const baseOffsetX = alignTargetX - alignPixelX;
    const baseOffsetY = alignTargetY - alignPixelY;

    const baseShiftX = (2 * baseOffsetX) / FIXED_RENDER_WIDTH;
    const baseShiftY = (-2 * baseOffsetY) / FIXED_RENDER_HEIGHT;
    camera.projectionMatrix.elements[12] += baseShiftX;
    camera.projectionMatrix.elements[13] += baseShiftY;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    const baseline = stairSet(collectStairSteps(camera, alignedBase, lineDir));

    const offsets = [
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 2, y: 1 },
      { x: 3, y: 2 },
      { x: 4, y: 3 }
    ];

    offsets.forEach((offset) => {
      camera.position.copy(alignedBase).addScaledVector(dir, CAMERA_DISTANCE);
      camera.lookAt(alignedBase);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();
      const shiftX = (2 * (baseOffsetX + offset.x)) / FIXED_RENDER_WIDTH;
      const shiftY = (-2 * (baseOffsetY + offset.y)) / FIXED_RENDER_HEIGHT;
      camera.projectionMatrix.elements[12] += shiftX;
      camera.projectionMatrix.elements[13] += shiftY;
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      const points = stairSet(collectStairSteps(camera, alignedBase, lineDir));
      assertShiftedMatch(baseline, points, offset.x, offset.y);
    });
  });
});
