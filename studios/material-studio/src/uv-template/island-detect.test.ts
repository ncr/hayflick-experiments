import { describe, expect, it } from "vitest";
import { detectIslands } from "./island-detect";

describe("detectIslands", () => {
  it("groups two disconnected triangles into two islands", () => {
    // Triangle A: vertices 0, 1, 2. Triangle B: vertices 3, 4, 5.
    const indices = new Uint32Array([0, 1, 2, 3, 4, 5]);
    const uv = new Float32Array([
      0, 0, 1, 0, 0, 1, // A
      2, 2, 3, 2, 2, 3 // B
    ]);
    const r = detectIslands(indices, uv);
    expect(r.islands).toHaveLength(2);
    const ids = new Set(r.vertexToIslandId);
    expect(ids).toEqual(new Set([0, 1]));
  });

  it("groups two triangles sharing an edge into one island", () => {
    // Triangle A: 0,1,2. Triangle B: 1,2,3 (shares edge 1-2).
    const indices = new Uint32Array([0, 1, 2, 1, 2, 3]);
    const uv = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
    const r = detectIslands(indices, uv);
    expect(r.islands).toHaveLength(1);
    expect(r.islands[0].vertexIndices.sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });

  it("computes per-island UV bbox", () => {
    const indices = new Uint32Array([0, 1, 2, 3, 4, 5]);
    const uv = new Float32Array([
      // Island A — UV from (0.1, 0.2) to (0.5, 0.7)
      0.1, 0.2, 0.5, 0.2, 0.3, 0.7,
      // Island B — UV from (-1, -1) to (3, 4)
      -1, -1, 3, -1, 1, 4
    ]);
    const r = detectIslands(indices, uv);
    expect(r.islands).toHaveLength(2);
    const a = r.islands.find((isl) => isl.vertexIndices.includes(0))!;
    const b = r.islands.find((isl) => isl.vertexIndices.includes(3))!;
    expect(a.bboxUv.u0).toBeCloseTo(0.1, 5);
    expect(a.bboxUv.v0).toBeCloseTo(0.2, 5);
    expect(a.bboxUv.u1).toBeCloseTo(0.5, 5);
    expect(a.bboxUv.v1).toBeCloseTo(0.7, 5);
    expect(b.bboxUv).toEqual({ u0: -1, v0: -1, u1: 3, v1: 4 });
  });

  it("marks unused vertices with islandId -1", () => {
    const indices = new Uint32Array([0, 1, 2]);
    const uv = new Float32Array([0, 0, 1, 0, 0, 1, 5, 5]); // vertex 3 unused
    const r = detectIslands(indices, uv);
    expect(r.islands).toHaveLength(1);
    expect(r.vertexToIslandId).toEqual([0, 0, 0, -1]);
  });

  it("collects per-island triangle indices", () => {
    // 3 triangles: tris 0,1 in island A; tri 2 in island B
    const indices = new Uint32Array([
      0, 1, 2,
      1, 2, 3,
      4, 5, 6
    ]);
    const uv = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1, 5, 5, 6, 5, 5, 6]);
    const r = detectIslands(indices, uv);
    expect(r.islands).toHaveLength(2);
    const sortedTriIdxs = r.islands.map((isl) => [...isl.triangleIndices].sort((a, b) => a - b));
    expect(sortedTriIdxs).toContainEqual([0, 1]);
    expect(sortedTriIdxs).toContainEqual([2]);
  });
});
