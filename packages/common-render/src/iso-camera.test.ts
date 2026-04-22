import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { IsoCamera } from "./iso-camera";
import { pitchForPixelView } from "./pixel-perfect-types";

function makeIso(): IsoCamera {
  return new IsoCamera({ viewMode: "iso-2to1", cameraYaw: Math.PI / 4, cameraDistance: 40 });
}

function makeSide(): IsoCamera {
  return new IsoCamera({ viewMode: "side", cameraYaw: 0, cameraDistance: 10 });
}

function makeTopDown(): IsoCamera {
  return new IsoCamera({ viewMode: "top-down", cameraYaw: 0, cameraDistance: 20 });
}

describe("IsoCamera", () => {
  it("resolves pitch from the view mode", () => {
    const iso = makeIso();
    const side = makeSide();
    const top = makeTopDown();
    expect(iso.pitchRadians).toBeCloseTo(Math.PI / 6);
    expect(side.pitchRadians).toBe(0);
    expect(top.pitchRadians).toBeCloseTo(pitchForPixelView("top-down"));
  });

  it("applyPoseFromTarget positions the camera at cameraDistance along the yaw/pitch direction", () => {
    const iso = makeIso();
    iso.cameraTarget.set(0, 0, 0);
    iso.applyPoseFromTarget(0);
    const distance = iso.camera.position.length();
    expect(distance).toBeCloseTo(40);
  });

  it("applyPoseFromTarget clamps target.y to 0 outside side mode", () => {
    const iso = makeIso();
    iso.cameraTarget.set(1, 2.5, 3);
    iso.applyPoseFromTarget(0);
    expect(iso.cameraTarget.y).toBe(0);
  });

  it("applyPoseFromTarget preserves target.y in side mode", () => {
    const side = makeSide();
    side.cameraTarget.set(1, 2.5, 3);
    side.applyPoseFromTarget(0);
    expect(side.cameraTarget.y).toBeCloseTo(2.5);
  });

  it("applyProjection sets an ortho frustum with verticalBias splitting top/bottom", () => {
    const iso = makeIso();
    iso.applyProjection({ orthoHeight: 10, aspect: 2, zoomOutFactor: 1, verticalBias: 0.5 });
    expect(iso.camera.top).toBeCloseTo(5);
    expect(iso.camera.bottom).toBeCloseTo(-5);
    expect(iso.camera.left).toBeCloseTo(-10);
    expect(iso.camera.right).toBeCloseTo(10);
  });

  it("applyProjection biases the target upward when verticalBias > 0.5", () => {
    const iso = makeIso();
    iso.applyProjection({ orthoHeight: 10, aspect: 1, zoomOutFactor: 1, verticalBias: 1 / 3 });
    // When bias=1/3, the target sits 2/3 of the way up, so bottom extends further.
    expect(iso.camera.top).toBeCloseTo(10 * (1 - 1 / 3));
    expect(iso.camera.bottom).toBeCloseTo(-10 * (1 / 3));
  });

  it("applyProjection enlarges the frustum when zoomOutFactor < 1", () => {
    const iso = makeIso();
    iso.applyProjection({ orthoHeight: 10, aspect: 1, zoomOutFactor: 0.5, verticalBias: 0.5 });
    expect(iso.camera.top - iso.camera.bottom).toBeCloseTo(20);
  });

  it("applyPoseFromTarget rotates the camera around the target with yaw turns", () => {
    const iso = makeIso();
    iso.cameraTarget.set(0, 0, 0);
    iso.applyPoseFromTarget(0);
    const pos0 = iso.camera.position.clone();
    iso.applyPoseFromTarget(1);
    const pos1 = iso.camera.position.clone();
    // One quarter-turn = 90° rotation around the Y axis, so the horizontal
    // components should differ by roughly 90° relative to the target.
    const angle0 = Math.atan2(pos0.z, pos0.x);
    const angle1 = Math.atan2(pos1.z, pos1.x);
    const diff = Math.abs(((angle1 - angle0 + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    expect(Math.abs(Math.PI - diff)).toBeCloseTo(Math.PI / 2, 3);
  });

  it("updateScreenToWorld produces a finite basis in iso mode", () => {
    const iso = makeIso();
    iso.applyProjection({ orthoHeight: 10, aspect: 16 / 9, zoomOutFactor: 1, verticalBias: 0.5 });
    iso.applyPoseFromTarget(0);
    iso.updateScreenToWorld(160, 90);
    expect(iso.screenRightWorld.length()).toBeGreaterThan(0);
    expect(iso.screenDownWorld.length()).toBeGreaterThan(0);
  });

  it("updateScreenToWorld in side mode uses camera basis and sets centerGround to the target", () => {
    const side = makeSide();
    side.cameraTarget.set(1, 2, 3);
    side.applyProjection({ orthoHeight: 10, aspect: 1, zoomOutFactor: 1, verticalBias: 0.5 });
    side.applyPoseFromTarget(0);
    side.updateScreenToWorld(160, 90);
    expect(side.centerGround.x).toBeCloseTo(1);
    expect(side.centerGround.y).toBeCloseTo(2);
    expect(side.centerGround.z).toBeCloseTo(3);
  });

  it("worldAtNdc lands on Y=0 for iso center ray", () => {
    const iso = makeIso();
    iso.applyProjection({ orthoHeight: 10, aspect: 1, zoomOutFactor: 1, verticalBias: 0.5 });
    iso.applyPoseFromTarget(0);
    const out = new THREE.Vector3();
    expect(iso.worldAtNdc(0, 0, out)).toBe(true);
    expect(Math.abs(out.y)).toBeLessThan(1e-6);
  });

  it("snapWorldPointOnGround returns false in side mode", () => {
    const side = makeSide();
    side.applyProjection({ orthoHeight: 10, aspect: 1, zoomOutFactor: 1, verticalBias: 0.5 });
    side.applyPoseFromTarget(0);
    side.updateScreenToWorld(160, 90);
    const out = new THREE.Vector3();
    expect(side.snapWorldPointOnGround(new THREE.Vector3(1, 0, 1), out, "nearest")).toBe(false);
  });

  it("snapWorldPointOnGround rounds input to the nearest pixel cell by default", () => {
    const iso = makeIso();
    iso.applyProjection({ orthoHeight: 10, aspect: 1, zoomOutFactor: 1, verticalBias: 0.5 });
    iso.applyPoseFromTarget(0);
    iso.updateScreenToWorld(160, 90);
    const out = new THREE.Vector3();
    // Pick a small delta off a pixel cell — snap should pull toward a nearby grid node.
    iso.snapWorldPointOnGround(new THREE.Vector3(0.01, 0, 0.01), out, "nearest");
    expect(Math.abs(out.x) + Math.abs(out.z)).toBeLessThan(0.5);
  });

  it("snapWorldPointOnGround floor/ceil differ for non-zero offsets", () => {
    const iso = makeIso();
    iso.applyProjection({ orthoHeight: 10, aspect: 1, zoomOutFactor: 1, verticalBias: 0.5 });
    iso.applyPoseFromTarget(0);
    iso.updateScreenToWorld(160, 90);
    const floorOut = new THREE.Vector3();
    const ceilOut = new THREE.Vector3();
    iso.snapWorldPointOnGround(new THREE.Vector3(0.7, 0, 0.7), floorOut, "floor");
    iso.snapWorldPointOnGround(new THREE.Vector3(0.7, 0, 0.7), ceilOut, "ceil");
    expect(floorOut.equals(ceilOut)).toBe(false);
  });
});
