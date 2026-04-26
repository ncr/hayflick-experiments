import { describe, expect, it } from "vitest";
import { detectIslands } from "./island-detect";
import { repackIslands } from "./repack";

function makeMesh(uvBoxes: Array<{ u0: number; v0: number; u1: number; v1: number }>) {
  // Build one disconnected triangle per bbox, with two vertices at the
  // bbox corners so detectIslands sees the full UV extent.
  const indices: number[] = [];
  const uvs: number[] = [];
  let v = 0;
  for (const b of uvBoxes) {
    indices.push(v, v + 1, v + 2);
    uvs.push(b.u0, b.v0, b.u1, b.v0, b.u1, b.v1);
    v += 3;
  }
  return { indices: new Uint32Array(indices), uv: new Float32Array(uvs) };
}

describe("repackIslands", () => {
  it("places a single island at the outline-padding offset", () => {
    const m = makeMesh([{ u0: 0, v0: 0, u1: 1, v1: 1 }]);
    const det = detectIslands(m.indices, m.uv);
    const r = repackIslands(det, {
      templateWidth: 1024,
      templateHeight: 1024,
      cellPx: 16,
      cellPxTarget: 16,
      outlinePaddingPx: 8
    });
    expect(r.islands).toHaveLength(1);
    const isl = r.islands[0];
    expect(isl.x).toBe(16);
    expect(isl.y).toBe(16);
    expect(isl.cellsX).toBe(16);
    expect(isl.cellsY).toBe(16);
  });

  it("places multiple islands without overlap and within template bounds", () => {
    const m = makeMesh([
      { u0: 0, v0: 0, u1: 1, v1: 1 },
      { u0: 0, v0: 0, u1: 1, v1: 0.5 },
      { u0: 0, v0: 0, u1: 0.5, v1: 1 },
      { u0: 0, v0: 0, u1: 2, v1: 1 }
    ]);
    const det = detectIslands(m.indices, m.uv);
    const r = repackIslands(det, {
      templateWidth: 1024,
      templateHeight: 1024,
      cellPx: 16,
      cellPxTarget: 16,
      outlinePaddingPx: 8
    });
    expect(r.islands).toHaveLength(4);
    for (const i of r.islands) {
      expect(i.x).toBeGreaterThanOrEqual(0);
      expect(i.y).toBeGreaterThanOrEqual(0);
      expect(i.x + i.cellsX * i.cellPx).toBeLessThanOrEqual(1024);
      expect(i.y + i.cellsY * i.cellPx).toBeLessThanOrEqual(1024);
    }
    for (let i = 0; i < r.islands.length; i++) {
      for (let j = i + 1; j < r.islands.length; j++) {
        expect(rectOverlaps(r.islands[i], r.islands[j])).toBe(false);
      }
    }
  });

  it("scales aspect-ratio'd islands so longest side equals cellPxTarget", () => {
    const m = makeMesh([
      { u0: 0, v0: 0, u1: 1, v1: 0.25 } // 4:1 aspect
    ]);
    const det = detectIslands(m.indices, m.uv);
    const r = repackIslands(det, {
      templateWidth: 1024,
      templateHeight: 1024,
      cellPx: 16,
      cellPxTarget: 16,
      outlinePaddingPx: 8
    });
    expect(r.islands[0].cellsX).toBe(16);
    expect(r.islands[0].cellsY).toBe(4);
  });

  it("clamps very thin islands to MIN_CELLS=2", () => {
    const m = makeMesh([{ u0: 0, v0: 0, u1: 1, v1: 0.001 }]);
    const det = detectIslands(m.indices, m.uv);
    const r = repackIslands(det, {
      templateWidth: 1024,
      templateHeight: 1024,
      cellPx: 16,
      cellPxTarget: 16,
      outlinePaddingPx: 8
    });
    expect(r.islands[0].cellsY).toBe(2);
    expect(r.islands[0].cellsX).toBe(16);
  });

  it("provides uvRemap that maps bbox corners to island pixel rect", () => {
    const m = makeMesh([{ u0: 2, v0: -1, u1: 3, v1: 0 }]);
    const det = detectIslands(m.indices, m.uv);
    const r = repackIslands(det, {
      templateWidth: 1024,
      templateHeight: 1024,
      cellPx: 16,
      cellPxTarget: 16,
      outlinePaddingPx: 8
    });
    const remap = r.uvRemap[0];
    // u_px = scaleU * (u_uv - bboxU0) + offsetX
    const px0 = remap.scaleU * (2 - remap.bboxU0) + remap.offsetX;
    const px1 = remap.scaleU * (3 - remap.bboxU0) + remap.offsetX;
    const isl = r.islands[0];
    expect(px0).toBeCloseTo(isl.x, 5);
    expect(px1).toBeCloseTo(isl.x + isl.cellsX * isl.cellPx, 5);
  });
});

function rectOverlaps(
  a: { x: number; y: number; cellsX: number; cellsY: number; cellPx: number },
  b: { x: number; y: number; cellsX: number; cellsY: number; cellPx: number }
): boolean {
  const ax1 = a.x + a.cellsX * a.cellPx;
  const ay1 = a.y + a.cellsY * a.cellPx;
  const bx1 = b.x + b.cellsX * b.cellPx;
  const by1 = b.y + b.cellsY * b.cellPx;
  return !(ax1 <= b.x || bx1 <= a.x || ay1 <= b.y || by1 <= a.y);
}
