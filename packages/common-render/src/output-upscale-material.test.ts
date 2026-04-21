import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { OutputUpscaleMaterial } from "./output-upscale-material";

function makeMaterial(): OutputUpscaleMaterial {
  return new OutputUpscaleMaterial({
    source: new THREE.Texture(),
    smoothPixelTransitions: true
  });
}

describe("OutputUpscaleMaterial", () => {
  it("initialises with identity content transform and zoom=1", () => {
    const m = makeMaterial();
    const scale = m.uniforms.uContentScale.value as THREE.Vector2;
    const offset = m.uniforms.uContentOffset.value as THREE.Vector2;
    expect(scale.x).toBe(1);
    expect(scale.y).toBe(1);
    expect(offset.x).toBe(0);
    expect(offset.y).toBe(0);
    expect(m.uniforms.uZoom.value).toBe(1);
    expect(m.uniforms.uEffectiveScale.value).toBe(1);
  });

  it("honours smoothPixelTransitions: true → 1, false → 0", () => {
    expect(
      new OutputUpscaleMaterial({
        source: new THREE.Texture(),
        smoothPixelTransitions: true
      }).uniforms.uSmoothSampling.value
    ).toBe(1);
    expect(
      new OutputUpscaleMaterial({
        source: new THREE.Texture(),
        smoothPixelTransitions: false
      }).uniforms.uSmoothSampling.value
    ).toBe(0);
  });

  it("disables depthTest so it always blits", () => {
    expect(makeMaterial().depthTest).toBe(false);
  });

  it("setters rewrite existing vectors in place (no reallocation)", () => {
    const m = makeMaterial();
    const scaleBefore = m.uniforms.uContentScale.value;
    m.setContentScale(0.5, 0.75);
    const scaleAfter = m.uniforms.uContentScale.value;
    expect(scaleBefore).toBe(scaleAfter);
    const scale = scaleAfter as THREE.Vector2;
    expect(scale.x).toBe(0.5);
    expect(scale.y).toBe(0.75);

    m.setContentOffset(0.1, 0.2);
    const offset = m.uniforms.uContentOffset.value as THREE.Vector2;
    expect(offset.x).toBeCloseTo(0.1);
    expect(offset.y).toBeCloseTo(0.2);

    m.setSourceSize(640, 480);
    const sz = m.uniforms.uSourceSize.value as THREE.Vector2;
    expect(sz.x).toBe(640);
    expect(sz.y).toBe(480);

    m.setZoomPivot(0.25, 0.5);
    const pivot = m.uniforms.uZoomPivot.value as THREE.Vector2;
    expect(pivot.x).toBe(0.25);
    expect(pivot.y).toBe(0.5);
  });

  it("setZoom / setEffectiveScale propagate to uniforms", () => {
    const m = makeMaterial();
    m.setZoom(4);
    expect(m.uniforms.uZoom.value).toBe(4);
    m.setEffectiveScale(12);
    expect(m.uniforms.uEffectiveScale.value).toBe(12);
  });

  it("setSource swaps the texture uniform", () => {
    const m = makeMaterial();
    const nextTex = new THREE.Texture();
    m.setSource(nextTex);
    expect(m.uniforms.uSource.value).toBe(nextTex);
  });
});
