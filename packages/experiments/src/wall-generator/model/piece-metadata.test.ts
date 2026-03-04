import { describe, it, expect } from "vitest";
import { pieceSlug, computeConnectionPoints, generatePieceMetadata } from "./piece-metadata";
import { defaultPieceConfig } from "./piece-catalog";

describe("pieceSlug", () => {
  it("generates kind-material slug", () => {
    const config = defaultPieceConfig("wall-straight");
    expect(pieceSlug(config)).toBe("wall-straight-brick");
  });
});

describe("computeConnectionPoints", () => {
  it("returns two points for straight wall", () => {
    const config = defaultPieceConfig("wall-straight");
    const points = computeConnectionPoints(config);
    expect(points.length).toBe(2);
    expect(points[0].label).toBe("left");
    expect(points[1].label).toBe("right");
  });

  it("returns two points for corner", () => {
    const config = defaultPieceConfig("wall-corner-inner");
    const points = computeConnectionPoints(config);
    expect(points.length).toBe(2);
    expect(points[0].label).toBe("arm-x-end");
    expect(points[1].label).toBe("arm-z-end");
  });

  it("returns one point for end-cap", () => {
    const config = defaultPieceConfig("wall-end-cap");
    const points = computeConnectionPoints(config);
    expect(points.length).toBe(1);
    expect(points[0].label).toBe("open-end");
  });
});

describe("generatePieceMetadata", () => {
  it("produces complete metadata", () => {
    const config = defaultPieceConfig("wall-straight");
    const meta = generatePieceMetadata(config);
    expect(meta.id).toBe("wall-straight-brick");
    expect(meta.kind).toBe("wall-straight");
    expect(meta.materialKind).toBe("brick");
    expect(meta.gridSize).toBe(1.0);
    expect(meta.connections.length).toBe(2);
    expect(meta.boundingBox.min).toBeDefined();
    expect(meta.boundingBox.max).toBeDefined();
  });
});
