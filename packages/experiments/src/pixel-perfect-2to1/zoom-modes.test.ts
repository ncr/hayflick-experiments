import { describe, expect, it } from "vitest";
import {
  computeSafeZoomLevels,
  nearestZoomLevel,
  stepZoomLevel
} from "./zoom-modes";

describe("pixel-perfect-2to1 zoom modes", () => {
  it("computes safe integer CSS zoom levels for fractional DPR", () => {
    const levels = computeSafeZoomLevels(1.6, 1, 20);
    expect(levels).toEqual([5, 10, 15, 20]);
  });

  it("returns all integer levels when DPR is integer", () => {
    const levels = computeSafeZoomLevels(2, 1, 8);
    expect(levels).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("steps on the safe-ladder and clamps at ends", () => {
    const levels = [5, 10, 15];
    expect(nearestZoomLevel(levels, 11)).toBe(10);
    expect(stepZoomLevel(levels, 11, 1)).toBe(15);
    expect(stepZoomLevel(levels, 15, 1)).toBe(15);
    expect(stepZoomLevel(levels, 5, -1)).toBe(5);
  });
});

