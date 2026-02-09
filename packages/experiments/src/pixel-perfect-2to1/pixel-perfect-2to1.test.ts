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

describe("pixel-perfect-2to1", () => {
  it("projects unit steps to a 2:1 pixel ratio with integer steps", () => {
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

    expect(absDx).toBeCloseTo(16, 6);
    expect(absDy).toBeCloseTo(8, 6);
  });
});
