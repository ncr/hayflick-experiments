import { describe, expect, it } from "vitest";
import {
  computeLowResolutionSize,
  computeOrthoHeightForLowResolution,
  computeOutputViewportLayout,
  computeRenderScale,
  computeViewportDeviceSize
} from "./pixel-perfect";

describe("@common/render pixel-perfect helpers", () => {
  it("computes integer render scale from zoom and DPR", () => {
    expect(computeRenderScale(1, 1.6)).toBe(2);
    expect(computeRenderScale(5, 1.6)).toBe(8);
  });

  it("clamps viewport device size within GPU caps", () => {
    expect(computeViewportDeviceSize(1000.4, 500.4, 2, 1024, 1024)).toEqual({
      width: 1024,
      height: 1001
    });
  });

  it("keeps low-resolution size stable for the same viewport + base scale", () => {
    const a = computeLowResolutionSize(1592, 1192, 1);
    const b = computeLowResolutionSize(1592, 1192, 1);
    expect(a).toEqual(b);
  });

  it("derives output viewport + pad + UV window from low-res size", () => {
    const layout = computeOutputViewportLayout(796, 596, 4, 2);
    expect(layout.sceneWidth).toBe(3184);
    expect(layout.sceneHeight).toBe(2384);
    expect(layout.outputWidth).toBe(3192);
    expect(layout.outputHeight).toBe(2392);
    expect(layout.outputPadX).toBe(4);
    expect(layout.outputPadY).toBe(4);
    expect(layout.contentScaleX).toBeCloseTo(3184 / 3192, 9);
    expect(layout.contentScaleY).toBeCloseTo(2384 / 2392, 9);
  });

  it("scales orthographic world height by low-res reference height", () => {
    expect(computeOrthoHeightForLowResolution(6, 270, 270)).toBeCloseTo(6, 9);
    expect(computeOrthoHeightForLowResolution(6, 540, 270)).toBeCloseTo(12, 9);
  });
});
