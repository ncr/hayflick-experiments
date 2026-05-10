import { describe, expect, it } from "vitest";

import {
  computeCompoundHullDimensions,
  parseCompoundConvexHullParts
} from "./compound-hull-collider";

describe("physics-prop-drop compound hull collider", () => {
  it("parses compound hull parts into rapier-ready vertices", () => {
    const parts = parseCompoundConvexHullParts({
      type: "compound-convex-hulls",
      params: {
        parts: [
          {
            position: [1, 2, 3],
            points: [
              [-1, 0, 0],
              [1, 0, 0],
              [0, 1, 0],
              [0, 0, 1]
            ]
          }
        ]
      }
    });

    expect(parts).toHaveLength(1);
    expect(parts[0]?.translation).toEqual({ x: 1, y: 2, z: 3 });
    expect(Array.from(parts[0]?.vertices ?? [])).toEqual([
      -1, 0, 0,
      1, 0, 0,
      0, 1, 0,
      0, 0, 1
    ]);
  });

  it("computes world-space hull bounds", () => {
    const dimensions = computeCompoundHullDimensions([
      {
        translation: { x: 2, y: 3, z: 4 },
        vertices: new Float32Array([
          -1, 0, 0,
          1, 0, 0,
          0, 2, 0,
          0, 0, 3
        ])
      }
    ]);

    expect(dimensions).toEqual({
      width: 2,
      height: 2,
      depth: 3
    });
  });
});
