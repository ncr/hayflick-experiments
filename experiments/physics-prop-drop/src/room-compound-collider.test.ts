import { describe, expect, it } from "vitest";

import {
  deriveRoomSupportFloorPart,
  omitRoomSupportSurfaceParts,
  parseRoomCompoundColliderAsset,
  scaleCompoundConvexHullParts
} from "./room-compound-collider";

describe("physics-prop-drop room compound collider", () => {
  it("parses collider assets through the shared compound hull shape", () => {
    const parts = parseRoomCompoundColliderAsset({
      collider: {
        type: "compound-convex-hulls",
        params: {
          parts: [
            {
              position: [0, 1, 2],
              points: [
                [-1, 0, 0],
                [1, 0, 0],
                [0, 1, 0],
                [0, 0, 1]
              ]
            }
          ]
        }
      }
    });

    expect(parts).toHaveLength(1);
    expect(parts[0]?.translation).toEqual({ x: 0, y: 1, z: 2 });
  });

  it("scales translations and local vertices together", () => {
    const parts = scaleCompoundConvexHullParts(
      [
        {
          translation: { x: 1, y: 2, z: 3 },
          vertices: new Float32Array([
            -1, 0, 1,
            2, 3, 4
          ])
        }
      ],
      { x: 10, y: 20, z: 30 }
    );

    expect(parts[0]?.translation).toEqual({ x: 10, y: 40, z: 90 });
    expect(Array.from(parts[0]?.vertices ?? [])).toEqual([
      -10, 0, 30,
      20, 60, 120
    ]);
  });

  it("derives a flat support floor from the top walkable slab when the hull includes an underside slab", () => {
    const parts = [
      {
        translation: { x: 0, y: 0, z: 0 },
        vertices: new Float32Array([
          -4, 0, -3,
          4, 0, -3,
          4, 0.12, 3,
          -4, 0.12, 3
        ])
      },
      {
        translation: { x: -4.5, y: 0, z: 0 },
        vertices: new Float32Array([
          0, 0, -3,
          0.5, 0, -3,
          0.5, 3, 3,
          0, 3, 3
        ])
      },
      {
        translation: { x: 0, y: 0.35, z: 0 },
        vertices: new Float32Array([
          -4, 0, -3,
          4, 0, -3,
          4, 0.05, 3,
          -4, 0.05, 3
        ])
      }
    ];
    const supportFloor = deriveRoomSupportFloorPart(parts);

    expect(supportFloor?.translation.x).toBe(0);
    expect(supportFloor?.translation.y).toBeCloseTo(0.392, 6);
    expect(supportFloor?.translation.z).toBe(0);
    expect(supportFloor?.halfExtents).toEqual({
      x: 4,
      y: 0.01,
      z: 3
    });

    expect(omitRoomSupportSurfaceParts(parts)).toEqual([parts[1]]);
  });
});
