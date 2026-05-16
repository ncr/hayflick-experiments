import { describe, expect, it } from "vitest";
import {
  IsoGeometryViolation,
  isoCleanGeometryValidator,
  isIsoPixelAlignedWu,
  isIsoStairAlignedWu,
  nearestIsoStairAlignedWu
} from "./iso-geometry-validator";

describe("iso geometry alignment predicates", () => {
  describe("isIsoStairAlignedWu", () => {
    it("accepts multiples of 0.0625 wu (= 2 H px)", () => {
      for (const v of [0, 0.0625, 0.125, 0.25, 0.5, 0.75, 1, 1.5, 2, 16]) {
        expect(isIsoStairAlignedWu(v), `${v} should be stair-aligned`).toBe(true);
      }
    });

    it("rejects values that don't land on the stair grid", () => {
      for (const v of [0.03125, 0.05, 0.08, 0.1, 0.8, 1.23]) {
        expect(isIsoStairAlignedWu(v), `${v} should NOT be stair-aligned`).toBe(false);
      }
    });

    it("tolerates floating-point noise around a clean value", () => {
      expect(isIsoStairAlignedWu(0.5 + 1e-10)).toBe(true);
      expect(isIsoStairAlignedWu(0.5 - 1e-10)).toBe(true);
    });
  });

  describe("isIsoPixelAlignedWu", () => {
    it("accepts the half-stair (1 H px = 0.03125 wu) grid", () => {
      expect(isIsoPixelAlignedWu(0.03125)).toBe(true);
      expect(isIsoPixelAlignedWu(0.0625)).toBe(true);
      expect(isIsoPixelAlignedWu(0.09375)).toBe(true);
    });

    it("rejects sub-pixel sizes", () => {
      expect(isIsoPixelAlignedWu(0.01)).toBe(false);
      expect(isIsoPixelAlignedWu(0.8)).toBe(false);
    });
  });

  describe("nearestIsoStairAlignedWu", () => {
    it("rounds to the nearest stair-grid value", () => {
      expect(nearestIsoStairAlignedWu(0.8)).toBeCloseTo(0.8125, 6);
      expect(nearestIsoStairAlignedWu(0.75)).toBeCloseTo(0.75, 6);
      expect(nearestIsoStairAlignedWu(0.04)).toBeCloseTo(0.0625, 6);
      expect(nearestIsoStairAlignedWu(0)).toBe(0);
    });
  });
});

describe("isoCleanGeometryValidator", () => {
  it("passes through stair-aligned XZ", () => {
    expect(() =>
      isoCleanGeometryValidator({ role: "box", xz: { x: 1, z: 1 } })
    ).not.toThrow();
    expect(() =>
      isoCleanGeometryValidator({ role: "floor", xz: { x: 20, z: 20 } })
    ).not.toThrow();
    expect(() =>
      isoCleanGeometryValidator({ role: "grid", xz: { x: 0.0625, z: 0.5 } })
    ).not.toThrow();
  });

  it("throws IsoGeometryViolation on a misaligned x", () => {
    let caught: unknown;
    try {
      isoCleanGeometryValidator({ role: "box", xz: { x: 0.8, z: 1 } });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(IsoGeometryViolation);
    const message = (caught as Error).message;
    expect(message).toContain("box");
    expect(message).toContain("x=0.8");
    expect(message).toContain("25.60 px");
    // Suggested clean size — nearest stair grid value to 0.8.
    expect(message).toContain("0.8125");
  });

  it("throws on a misaligned z even when x is clean", () => {
    expect(() =>
      isoCleanGeometryValidator({ role: "floor", xz: { x: 1, z: 0.7 } })
    ).toThrow(IsoGeometryViolation);
  });

  it("includes both axes in the message when both are misaligned", () => {
    let message = "";
    try {
      isoCleanGeometryValidator({ role: "grid", xz: { x: 0.8, z: 1.23 } });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("x=0.8");
    expect(message).toContain("z=1.23");
  });

  it("includes the identifier when supplied", () => {
    let message = "";
    try {
      isoCleanGeometryValidator({
        role: "box",
        identifier: "player",
        xz: { x: 0.8, z: 1 }
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("(player)");
  });
});
