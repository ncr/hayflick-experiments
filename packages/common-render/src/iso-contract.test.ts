import { describe, expect, it } from "vitest";
import {
  ISO_VIEW_CONTRACT,
  TOPDOWN_VIEW_CONTRACT,
  SIDE_VIEW_CONTRACT
} from "./iso-contract";

// These tests guard the cornerstone of the game's view aesthetic.
// Changing any of them is a deliberate visual design decision that
// invalidates shipped textured-mesh atlases and all
// `e2e/render-invariants/*` golden images. Do not relax these without
// running the full render-invariant regen.

describe("ISO_VIEW_CONTRACT (locked iso-2:1)", () => {
  it("freezes to prevent accidental mutation", () => {
    expect(Object.isFrozen(ISO_VIEW_CONTRACT)).toBe(true);
  });

  it("locks pitch = π/6 (sin = 1/2 -> 2:1 staircase)", () => {
    expect(ISO_VIEW_CONTRACT.pitch).toBeCloseTo(Math.PI / 6, 12);
    expect(Math.sin(ISO_VIEW_CONTRACT.pitch)).toBeCloseTo(0.5, 12);
  });

  it("locks base yaw = π/4 (cardinal-isometric symmetry)", () => {
    expect(ISO_VIEW_CONTRACT.baseYaw).toBeCloseTo(Math.PI / 4, 12);
  });

  it("locks R = 32·√2 lowpixels per world unit", () => {
    expect(ISO_VIEW_CONTRACT.R).toBeCloseTo(32 * Math.SQRT2, 12);
  });

  it("locks 32 H × 16 V lowpixels per 1.28 m tile", () => {
    expect(ISO_VIEW_CONTRACT.pxPerTileH).toBe(32);
    expect(ISO_VIEW_CONTRACT.pxPerTileV).toBe(16);
    // Mathematical consistency: derived from R, must match.
    expect(ISO_VIEW_CONTRACT.R * (Math.SQRT2 / 2)).toBeCloseTo(32, 12);
    expect(ISO_VIEW_CONTRACT.R * (Math.SQRT2 / 2) / 2).toBeCloseTo(16, 12);
  });

  it("locks 4 cm per atlas texel along world-X / world-Z (exact)", () => {
    expect(ISO_VIEW_CONTRACT.cmPerTexelXZ).toBe(4);
    expect(128 / ISO_VIEW_CONTRACT.pxPerTileH).toBe(4);
    expect(ISO_VIEW_CONTRACT.worldUnitsPerTexelXZ).toBeCloseTo(1 / 32, 12);
  });

  it("Y-axis projection is irrational (cos π/6 = √3/2): 16·√6 ≈ 39.19 px per tile", () => {
    expect(ISO_VIEW_CONTRACT.pxPerTileY).toBeCloseTo(16 * Math.sqrt(6), 12);
    // cm/texel along Y: 128 / (R·√3/2) = 8/√6 ≈ 3.27. Irrational by design.
    expect(ISO_VIEW_CONTRACT.cmPerTexelY).toBeCloseTo(8 / Math.sqrt(6), 12);
  });

  it("reference (FRH, BOH) pair gives R = 32·√2", () => {
    const R = ISO_VIEW_CONTRACT.referenceLowHeight / ISO_VIEW_CONTRACT.baseOrthoHeight;
    expect(R).toBeCloseTo(ISO_VIEW_CONTRACT.R, 12);
    expect(ISO_VIEW_CONTRACT.referenceLowHeight).toBe(256);
    expect(ISO_VIEW_CONTRACT.baseOrthoHeight).toBeCloseTo(4 * Math.SQRT2, 12);
  });
});

describe("TOPDOWN_VIEW_CONTRACT", () => {
  it("freezes", () => {
    expect(Object.isFrozen(TOPDOWN_VIEW_CONTRACT)).toBe(true);
  });

  it("looks straight down (π/2 - epsilon to avoid lookAt singularity)", () => {
    expect(TOPDOWN_VIEW_CONTRACT.pitch).toBeCloseTo(Math.PI / 2 - 1e-3, 6);
  });

  it("R = 32 → 32 × 32 px per tile (square, no foreshorten)", () => {
    expect(TOPDOWN_VIEW_CONTRACT.R).toBe(32);
    expect(TOPDOWN_VIEW_CONTRACT.pxPerTileH).toBe(32);
    expect(TOPDOWN_VIEW_CONTRACT.pxPerTileV).toBe(32);
  });
});

describe("SIDE_VIEW_CONTRACT", () => {
  it("freezes", () => {
    expect(Object.isFrozen(SIDE_VIEW_CONTRACT)).toBe(true);
  });

  it("horizontal eye level (pitch = 0)", () => {
    expect(SIDE_VIEW_CONTRACT.pitch).toBe(0);
  });

  it("R = 32 → 32 × 32 px per tile in both axes (no foreshorten)", () => {
    expect(SIDE_VIEW_CONTRACT.R).toBe(32);
    expect(SIDE_VIEW_CONTRACT.pxPerTileH).toBe(32);
    expect(SIDE_VIEW_CONTRACT.pxPerTileV).toBe(32);
  });
});
