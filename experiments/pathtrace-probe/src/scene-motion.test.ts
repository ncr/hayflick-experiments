import { describe, it, expect } from "vitest";
import { orbitPosition, spinRotation } from "./scene-motion";

describe("scene-motion", () => {
  it("moves every object between consecutive frames (no accidental static frame)", () => {
    const count = 32;
    for (let i = 0; i < count; i++) {
      const a = orbitPosition(i, count, 1.0);
      const b = orbitPosition(i, count, 1.0 + 1 / 60);
      const moved =
        Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z);
      expect(moved).toBeGreaterThan(0);
    }
  });

  it("spreads objects across distinct radii (fills the BVH, not one cell)", () => {
    const radii = new Set<number>();
    for (let i = 0; i < 7; i++) {
      const p = orbitPosition(i, 7, 0);
      radii.add(Math.round(Math.hypot(p.x, p.z) * 100));
    }
    expect(radii.size).toBeGreaterThan(1);
  });

  it("spin advances with time", () => {
    const r0 = spinRotation(3, 0);
    const r1 = spinRotation(3, 1);
    expect(r1.x).not.toBe(r0.x);
  });
});
