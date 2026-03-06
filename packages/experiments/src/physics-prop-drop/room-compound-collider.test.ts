import { describe, expect, it } from "vitest";

import {
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
});
