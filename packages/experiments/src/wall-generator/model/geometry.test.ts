import { describe, it, expect } from "vitest";
import { generateBox, computeSubtractions, generateTrimGeometry, generatePieceGeometryDescriptors, mergeMeshData } from "./geometry";
import { defaultPieceConfig } from "./piece-catalog";

describe("generateBox", () => {
  it("produces 24 vertices (6 faces × 4 verts)", () => {
    const box = generateBox(1, 2, 0.5);
    expect(box.positions.length).toBe(24 * 3);
    expect(box.normals.length).toBe(24 * 3);
    expect(box.uvs.length).toBe(24 * 2);
    expect(box.indices.length).toBe(36); // 6 faces × 2 tris × 3 indices
  });

  it("centers the box at the given position", () => {
    const box = generateBox(2, 2, 2, 5, 10, 15);
    // All X positions should be between 4 and 6
    for (let i = 0; i < box.positions.length; i += 3) {
      expect(box.positions[i]).toBeGreaterThanOrEqual(4);
      expect(box.positions[i]).toBeLessThanOrEqual(6);
    }
  });
});

describe("computeSubtractions", () => {
  it("returns empty for wall-straight", () => {
    const subs = computeSubtractions("wall-straight", { width: 1, height: 2.5, thickness: 0.2 }, {
      offsetX: 0, offsetY: 0.8, width: 0.6, height: 1.2, archRadius: 0,
    });
    expect(subs.length).toBe(0);
  });

  it("returns one subtraction for wall-window", () => {
    const subs = computeSubtractions("wall-window", { width: 1, height: 2.5, thickness: 0.2 }, {
      offsetX: 0, offsetY: 0.8, width: 0.6, height: 1.2, archRadius: 0,
    });
    expect(subs.length).toBe(1);
    expect(subs[0].type).toBe("box");
    expect(subs[0].size[2]).toBeGreaterThan(0.2); // oversized for clean CSG
  });
});

describe("generateTrimGeometry", () => {
  it("returns empty when trim disabled", () => {
    const config = defaultPieceConfig("wall-straight");
    config.trim.enabled = false;
    const trims = generateTrimGeometry(config.dimensions, config.trim, null, "wall-straight");
    expect(trims.length).toBe(0);
  });

  it("returns trim meshes when enabled", () => {
    const config = defaultPieceConfig("wall-straight");
    config.trim.enabled = true;
    const trims = generateTrimGeometry(config.dimensions, config.trim, null, "wall-straight");
    expect(trims.length).toBe(2); // top + bottom
  });
});

describe("generatePieceGeometryDescriptors", () => {
  it("produces single box for wall-straight", () => {
    const config = defaultPieceConfig("wall-straight");
    const desc = generatePieceGeometryDescriptors(config);
    expect(desc.baseBoxes.length).toBe(1);
    expect(desc.subtractions.length).toBe(0);
    expect(desc.openingFrame).toBeNull();
  });

  it("produces two boxes for corner", () => {
    const config = defaultPieceConfig("wall-corner-inner");
    const desc = generatePieceGeometryDescriptors(config);
    expect(desc.baseBoxes.length).toBe(2);
  });

  it("produces subtraction for window", () => {
    const config = defaultPieceConfig("wall-window");
    const desc = generatePieceGeometryDescriptors(config);
    expect(desc.subtractions.length).toBe(1);
    expect(desc.openingFrame).not.toBeNull();
  });
});

describe("mergeMeshData", () => {
  it("returns null for empty array", () => {
    expect(mergeMeshData([])).toBeNull();
  });

  it("merges two boxes correctly", () => {
    const a = generateBox(1, 1, 1);
    const b = generateBox(1, 1, 1, 2, 0, 0);
    const merged = mergeMeshData([a, b])!;
    expect(merged.positions.length).toBe(a.positions.length + b.positions.length);
    expect(merged.indices.length).toBe(a.indices.length + b.indices.length);
  });
});
