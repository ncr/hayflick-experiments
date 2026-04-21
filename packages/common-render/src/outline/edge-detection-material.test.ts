import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  EDGE_DETECTION_DEBUG_MODES,
  EdgeDetectionMaterial,
  edgeDetectionDebugModeIndex
} from "./edge-detection-material";

function stubTexture(): THREE.Texture {
  return new THREE.Texture();
}

function makeMaterial(): EdgeDetectionMaterial {
  return new EdgeDetectionMaterial({
    colorTexture: stubTexture(),
    depthTexture: stubTexture(),
    normalTexture: stubTexture(),
    idTexture: stubTexture(),
    resolution: { x: 320, y: 240 },
    near: 0.1,
    far: 200
  });
}

describe("edgeDetectionDebugModeIndex", () => {
  it("matches the GLSL numeric layout", () => {
    expect(edgeDetectionDebugModeIndex("final")).toBe(0);
    expect(edgeDetectionDebugModeIndex("color")).toBe(1);
    expect(edgeDetectionDebugModeIndex("depth")).toBe(2);
    expect(edgeDetectionDebugModeIndex("normals")).toBe(3);
    expect(edgeDetectionDebugModeIndex("ids")).toBe(4);
    expect(edgeDetectionDebugModeIndex("edges")).toBe(5);
    expect(edgeDetectionDebugModeIndex("depth-edges")).toBe(6);
    expect(edgeDetectionDebugModeIndex("normal-edges")).toBe(7);
  });

  it("exposes all eight modes via EDGE_DETECTION_DEBUG_MODES", () => {
    expect(EDGE_DETECTION_DEBUG_MODES).toHaveLength(8);
  });
});

describe("EdgeDetectionMaterial", () => {
  it("applies the canonical defaults from the outline-walls reference pipeline", () => {
    const m = makeMaterial();
    expect(m.uniforms.uDepthThreshold.value).toBe(0.05);
    expect(m.uniforms.uNormalThreshold.value).toBe(0.3);
    expect(m.uniforms.uIdSuppressNormalDot.value).toBe(0.5);
    expect(m.uniforms.uOutlineBrightness.value).toBeCloseTo(1.35);
    expect(m.uniforms.uOutlineMix.value).toBe(1.0);
    expect(m.uniforms.uDebugMode.value).toBe(0);
  });

  it("honours caller overrides for tuning", () => {
    const m = new EdgeDetectionMaterial({
      colorTexture: stubTexture(),
      depthTexture: stubTexture(),
      normalTexture: stubTexture(),
      idTexture: stubTexture(),
      resolution: { x: 1, y: 1 },
      near: 0,
      far: 1,
      depthThreshold: 0.1,
      normalThreshold: 0.5,
      idSuppressNormalDot: 0.8,
      outlineBrightness: 2.0,
      outlineMix: 0.5
    });
    expect(m.uniforms.uDepthThreshold.value).toBe(0.1);
    expect(m.uniforms.uNormalThreshold.value).toBe(0.5);
    expect(m.uniforms.uIdSuppressNormalDot.value).toBe(0.8);
    expect(m.uniforms.uOutlineBrightness.value).toBe(2.0);
    expect(m.uniforms.uOutlineMix.value).toBe(0.5);
  });

  it("setResolution rewrites the resolution vec2 in place", () => {
    const m = makeMaterial();
    m.setResolution(640, 480);
    const res = m.uniforms.uResolution.value as THREE.Vector2;
    expect(res.x).toBe(640);
    expect(res.y).toBe(480);
  });

  it("setRange updates near/far", () => {
    const m = makeMaterial();
    m.setRange(1.5, 75);
    expect(m.uniforms.uNear.value).toBe(1.5);
    expect(m.uniforms.uFar.value).toBe(75);
  });

  it("setDebugMode cycles through the named modes", () => {
    const m = makeMaterial();
    m.setDebugMode("edges");
    expect(m.uniforms.uDebugMode.value).toBe(5);
    m.setDebugMode("normal-edges");
    expect(m.uniforms.uDebugMode.value).toBe(7);
    m.setDebugMode("final");
    expect(m.uniforms.uDebugMode.value).toBe(0);
  });

  it("disables depth testing so the post-quad always blits", () => {
    const m = makeMaterial();
    expect(m.depthTest).toBe(false);
  });
});
