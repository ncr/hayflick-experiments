import { describe, expect, it } from "vitest";
import { generatePropPlacements, type PlacementFootprint } from "./placement-layout";

type Bounds2d = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};

function rotatedBounds(slot: { x: number; z: number; rotY: number }, footprint: PlacementFootprint): Bounds2d {
  const cos = Math.abs(Math.cos(slot.rotY));
  const sin = Math.abs(Math.sin(slot.rotY));
  const spanX = footprint.width * cos + footprint.depth * sin;
  const spanZ = footprint.width * sin + footprint.depth * cos;
  return {
    minX: slot.x - spanX * 0.5,
    maxX: slot.x + spanX * 0.5,
    minZ: slot.z - spanZ * 0.5,
    maxZ: slot.z + spanZ * 0.5
  };
}

function overlaps(a: Bounds2d, b: Bounds2d): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
}

describe("physics-prop-drop placement layout", () => {
  it("keeps rotated prop footprints from overlapping at spawn", () => {
    const footprints: PlacementFootprint[] = [
      { width: 1, depth: 1 },
      { width: 1, depth: 1 },
      { width: 1, depth: 1 },
      { width: 1, depth: 1 }
    ];

    const placements = generatePropPlacements(footprints, 2.0);
    const bounds = placements.map((slot, index) => rotatedBounds(slot, footprints[index]!));

    for (let i = 0; i < bounds.length; i++) {
      for (let j = i + 1; j < bounds.length; j++) {
        expect(overlaps(bounds[i]!, bounds[j]!)).toBe(false);
      }
    }
  });
});
