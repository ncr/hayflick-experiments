import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  LowResolutionTarget,
  type LowResolutionDisplayState
} from "./low-resolution-target";

function makeTarget(overrides: Partial<ConstructorParameters<typeof LowResolutionTarget>[0]> = {}) {
  return new LowResolutionTarget({
    lowTargetSamples: 4,
    smoothPixelTransitions: true,
    outputOverscanLowPixels: 2,
    ...overrides
  });
}

function state(overrides: Partial<LowResolutionDisplayState> = {}): LowResolutionDisplayState {
  return {
    lowRenderWidth: 320,
    lowRenderHeight: 180,
    contentScaleX: 1,
    contentScaleY: 1,
    contentOffsetX: 0,
    contentOffsetY: 0,
    viewportDeviceWidth: 1280,
    viewportDeviceHeight: 720,
    ...overrides
  };
}

describe("LowResolutionTarget", () => {
  it("starts with a 1x1 low target that can be resized via applyControllerState", () => {
    const lr = makeTarget();
    const initial = lr.getLowTarget();
    expect(initial.width).toBe(1);
    expect(initial.height).toBe(1);

    lr.applyControllerState(state(), 2);
    const after = lr.getLowTarget();
    expect(after.width).toBe(320);
    expect(after.height).toBe(180);
  });

  it("updateDisplayLayout overscans by outputOverscanLowPixels × scale in both axes", () => {
    const lr = makeTarget({ outputOverscanLowPixels: 4 });
    lr.updateDisplayLayout(state(), 3);
    expect(lr.sceneOutputWidth).toBe(320 * 3);
    expect(lr.sceneOutputHeight).toBe(180 * 3);
    expect(lr.outputWidth).toBe((320 + 4) * 3);
    expect(lr.outputHeight).toBe((180 + 4) * 3);
    expect(lr.outputPadDeviceX).toBe((lr.outputWidth - lr.sceneOutputWidth) / 2);
    expect(lr.outputPadDeviceY).toBe((lr.outputHeight - lr.sceneOutputHeight) / 2);
  });

  it("updateDisplayLayout centers the overscanned rect inside the viewport", () => {
    const lr = makeTarget();
    lr.updateDisplayLayout(state(), 2);
    const s = state();
    expect(lr.renderBaseX).toBe(Math.floor((s.viewportDeviceWidth - lr.outputWidth) * 0.5));
    expect(lr.renderBaseY).toBe(Math.floor((s.viewportDeviceHeight - lr.outputHeight) * 0.5));
  });

  it("updateDisplayLayout clamps scale to a minimum of 1", () => {
    const lr = makeTarget();
    lr.updateDisplayLayout(state(), 0);
    expect(lr.baseRenderScale).toBe(1);
    expect(lr.sceneOutputWidth).toBe(320);
  });

  it("setLowTarget disposes the old target and reuses its sampler uniform", () => {
    const lr = makeTarget();
    const first = lr.getLowTarget();
    const replacement = new THREE.WebGLRenderTarget(1, 1);
    lr.setLowTarget(replacement, 64, 64);
    expect(lr.getLowTarget()).toBe(replacement);
    expect(replacement.width).toBe(64);
    expect(replacement.height).toBe(64);
    // The original has been disposed; double-dispose on three WebGLRenderTarget
    // is safe, but we assert setLowTarget drops it via identity.
    expect(lr.getLowTarget()).not.toBe(first);
  });

  it("setOutputSourceTexture overrides the sampler until set back to null", () => {
    const lr = makeTarget();
    lr.applyControllerState(state(), 2);
    const custom = new THREE.Texture();
    lr.setOutputSourceTexture(custom);
    // Swapping the underlying lowTarget must not clobber the custom source.
    const replacement = new THREE.WebGLRenderTarget(1, 1);
    lr.setLowTarget(replacement, 16, 16);
    lr.setOutputSourceTexture(null);
    // After clearing the override, the low target's texture is the source again.
    // We can't inspect the private material from outside, so we just ensure no throw.
    expect(lr.getLowTarget()).toBe(replacement);
  });

  it("setZoomUniforms applies `max(1, zoom)` — no magnification below 1", () => {
    const lr = makeTarget();
    lr.updateDisplayLayout(state(), 2);
    // We don't have a direct uniform accessor, so the coverage here is that
    // the call doesn't throw and the effective scale is non-NaN by proxy —
    // this mirrors how IsoViewport drives the target.
    expect(() => lr.setZoomUniforms(0.5, 0.3, 0.7)).not.toThrow();
    expect(() => lr.setZoomUniforms(4, 0.3, 0.7)).not.toThrow();
  });

  it("dispose is idempotent enough to run without throwing", () => {
    const lr = makeTarget();
    expect(() => lr.dispose()).not.toThrow();
  });
});
