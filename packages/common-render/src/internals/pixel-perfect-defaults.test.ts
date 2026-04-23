import { describe, expect, it } from "vitest";
import {
  PixelPerfectDefaults,
  resolvePixelPerfectTuning,
  type IsoGameViewTuning
} from "../pixel-perfect-types";

describe("PixelPerfectDefaults", () => {
  it("freezes to prevent accidental mutation", () => {
    expect(Object.isFrozen(PixelPerfectDefaults)).toBe(true);
  });

  it("uses the iso-pixel-aligned ortho height (4.8·√2)", () => {
    expect(PixelPerfectDefaults.baseOrthoHeight).toBeCloseTo(4.8 * Math.SQRT2, 10);
  });

  it("uses canonical iso-2:1 pitch + π/4 yaw", () => {
    expect(PixelPerfectDefaults.cameraPitch).toBe("iso-2to1");
    expect(PixelPerfectDefaults.cameraYaw).toBeCloseTo(Math.PI / 4, 10);
  });

  it("uses 240 low-res scanlines", () => {
    expect(PixelPerfectDefaults.fixedRenderHeight).toBe(240);
  });

  it("enables 4x MSAA by default", () => {
    expect(PixelPerfectDefaults.lowTargetSamples).toBe(4);
  });

  it("enables smooth pixel transitions by default", () => {
    expect(PixelPerfectDefaults.smoothPixelTransitions).toBe(true);
  });
});

describe("resolvePixelPerfectTuning", () => {
  it("returns a complete tuning from an empty input", () => {
    const resolved = resolvePixelPerfectTuning({});
    const keys: Array<keyof IsoGameViewTuning> = [
      "fixedRenderHeight",
      "baseOrthoHeight",
      "cameraDistance",
      "cameraPitch",
      "cameraYaw",
      "basePixelZoom",
      "zoomMin",
      "zoomMax",
      "zoomStep",
      "zoomAnimationRate",
      "zoomAnimationBurstRate",
      "zoomAnimationEpsilon",
      "rotationAnimationRate",
      "rotationAnimationEpsilon",
      "zoomBurstIdleMs",
      "outputOverscanLowPixels",
      "lowTargetSamples",
      "smoothPixelTransitions",
      "verticalBias"
    ];
    for (const key of keys) {
      expect(resolved[key]).toBe(PixelPerfectDefaults[key]);
    }
  });

  it("overrides only the specified fields", () => {
    const resolved = resolvePixelPerfectTuning({
      baseOrthoHeight: 3.0,
      cameraDistance: 20,
      rotationAnimationEpsilon: 0.005
    });
    expect(resolved.baseOrthoHeight).toBe(3.0);
    expect(resolved.cameraDistance).toBe(20);
    expect(resolved.rotationAnimationEpsilon).toBe(0.005);
    expect(resolved.cameraPitch).toBe(PixelPerfectDefaults.cameraPitch);
    expect(resolved.fixedRenderHeight).toBe(PixelPerfectDefaults.fixedRenderHeight);
  });

  it("preserves extra fields passed through the input", () => {
    const resolved = resolvePixelPerfectTuning({
      baseOrthoHeight: 3.0,
      ...({ scene: "scene-marker" } as {})
    } as any);
    expect((resolved as any).scene).toBe("scene-marker");
    expect(resolved.baseOrthoHeight).toBe(3.0);
  });
});
