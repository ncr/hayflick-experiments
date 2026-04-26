import { describe, expect, it } from "vitest";
import { detectIslands } from "./island-detect";
import { repackIslands } from "./repack";
import { remapUvs } from "./remap-uvs";

describe("remapUvs", () => {
  it("maps an island's bbox corners to the island's pixel rect (normalised)", () => {
    // One triangle, UV bbox (0,0)..(1,1)
    const indices = new Uint32Array([0, 1, 2]);
    const uv = new Float32Array([0, 0, 1, 0, 0, 1]);
    const det = detectIslands(indices, uv);
    const opts = {
      templateWidth: 1024,
      templateHeight: 1024,
      cellPx: 16,
      cellPxTarget: 16,
      outlinePaddingPx: 8
    };
    const r = repackIslands(det, opts);
    const remapped = remapUvs(uv, det.vertexToIslandId, r.uvRemap, opts.templateWidth, opts.templateHeight);

    const isl = r.islands[0];
    const u0 = isl.x / opts.templateWidth;
    const v0 = isl.y / opts.templateHeight;
    const u1 = (isl.x + isl.cellsX * isl.cellPx) / opts.templateWidth;
    const v1 = (isl.y + isl.cellsY * isl.cellPx) / opts.templateHeight;

    expect(remapped[0]).toBeCloseTo(u0, 5);
    expect(remapped[1]).toBeCloseTo(v0, 5);
    expect(remapped[2]).toBeCloseTo(u1, 5);
    expect(remapped[3]).toBeCloseTo(v0, 5);
    expect(remapped[4]).toBeCloseTo(u0, 5);
    expect(remapped[5]).toBeCloseTo(v1, 5);
  });

  it("passes through unused vertices unchanged", () => {
    const indices = new Uint32Array([0, 1, 2]);
    const uv = new Float32Array([0, 0, 1, 0, 0, 1, 99, 99]); // vertex 3 unused
    const det = detectIslands(indices, uv);
    const opts = {
      templateWidth: 1024,
      templateHeight: 1024,
      cellPx: 16,
      cellPxTarget: 16
    };
    const r = repackIslands(det, opts);
    const remapped = remapUvs(uv, det.vertexToIslandId, r.uvRemap, opts.templateWidth, opts.templateHeight);
    expect(remapped[6]).toBe(99);
    expect(remapped[7]).toBe(99);
  });

  it("preserves output buffer length and is a fresh Float32Array", () => {
    const indices = new Uint32Array([0, 1, 2]);
    const uv = new Float32Array([0, 0, 1, 0, 0, 1]);
    const det = detectIslands(indices, uv);
    const opts = { templateWidth: 1024, templateHeight: 1024, cellPx: 16, cellPxTarget: 16 };
    const r = repackIslands(det, opts);
    const remapped = remapUvs(uv, det.vertexToIslandId, r.uvRemap, opts.templateWidth, opts.templateHeight);
    expect(remapped.length).toBe(uv.length);
    expect(remapped).toBeInstanceOf(Float32Array);
    expect(remapped).not.toBe(uv);
  });

  it("maps multi-island UV correctly into per-island rects", () => {
    // Two disjoint triangles in different bbox spaces
    const indices = new Uint32Array([0, 1, 2, 3, 4, 5]);
    const uv = new Float32Array([
      // Island A — UV in [0..1]
      0, 0, 1, 0, 0, 1,
      // Island B — UV in [-2..0] for u, [3..5] for v
      -2, 3, 0, 3, -2, 5
    ]);
    const det = detectIslands(indices, uv);
    const opts = {
      templateWidth: 1024,
      templateHeight: 1024,
      cellPx: 16,
      cellPxTarget: 16,
      outlinePaddingPx: 8
    };
    const r = repackIslands(det, opts);
    const remapped = remapUvs(uv, det.vertexToIslandId, r.uvRemap, opts.templateWidth, opts.templateHeight);

    // For each vertex, its remapped UV should fall inside its island's rect.
    for (let v = 0; v < 6; v++) {
      const id = det.vertexToIslandId[v];
      const isl = r.islands[id];
      const u = remapped[v * 2];
      const vCoord = remapped[v * 2 + 1];
      const u0 = isl.x / opts.templateWidth;
      const u1 = (isl.x + isl.cellsX * isl.cellPx) / opts.templateWidth;
      const vv0 = isl.y / opts.templateHeight;
      const vv1 = (isl.y + isl.cellsY * isl.cellPx) / opts.templateHeight;
      expect(u).toBeGreaterThanOrEqual(u0 - 1e-6);
      expect(u).toBeLessThanOrEqual(u1 + 1e-6);
      expect(vCoord).toBeGreaterThanOrEqual(vv0 - 1e-6);
      expect(vCoord).toBeLessThanOrEqual(vv1 + 1e-6);
    }
  });
});
