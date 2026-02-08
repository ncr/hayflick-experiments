import { describe, expect, it } from "vitest";
import { autoTileRotationRadians, describeAutoTile } from "./autotile";

describe("describeAutoTile", () => {
  it("maps all cardinal masks to stable shape+rotation descriptors", () => {
    const expected: Record<number, { shape: string; rotation: number }> = {
      0: { shape: "isolated", rotation: 0 },
      1: { shape: "end", rotation: 0 },
      2: { shape: "end", rotation: 1 },
      3: { shape: "corner", rotation: 0 },
      4: { shape: "end", rotation: 2 },
      5: { shape: "straight", rotation: 0 },
      6: { shape: "corner", rotation: 1 },
      7: { shape: "tee", rotation: 1 },
      8: { shape: "end", rotation: 3 },
      9: { shape: "corner", rotation: 3 },
      10: { shape: "straight", rotation: 1 },
      11: { shape: "tee", rotation: 0 },
      12: { shape: "corner", rotation: 2 },
      13: { shape: "tee", rotation: 3 },
      14: { shape: "tee", rotation: 2 },
      15: { shape: "cross", rotation: 0 }
    };

    for (let mask = 0; mask <= 15; mask += 1) {
      expect(describeAutoTile(mask)).toEqual(expected[mask]);
    }
  });
});

describe("autoTileRotationRadians", () => {
  it("converts clockwise quarter turns to world-space radians on the ground plane", () => {
    expect(autoTileRotationRadians(0)).toBeCloseTo(0);
    expect(autoTileRotationRadians(1)).toBeCloseTo(-Math.PI * 0.5);
    expect(autoTileRotationRadians(2)).toBeCloseTo(-Math.PI);
    expect(autoTileRotationRadians(3)).toBeCloseTo(-Math.PI * 1.5);
    expect(autoTileRotationRadians(4)).toBeCloseTo(0);
    expect(autoTileRotationRadians(-1)).toBeCloseTo(-Math.PI * 1.5);
  });
});
