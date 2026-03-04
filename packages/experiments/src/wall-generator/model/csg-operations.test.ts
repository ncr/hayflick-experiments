import { describe, it, expect } from "vitest";
import { buildSubtractionList, validateOpening } from "./csg-operations";
import { defaultPieceConfig } from "./piece-catalog";

describe("buildSubtractionList", () => {
  it("returns empty for non-opening pieces", () => {
    expect(buildSubtractionList(defaultPieceConfig("wall-straight"))).toEqual([]);
    expect(buildSubtractionList(defaultPieceConfig("wall-corner-inner"))).toEqual([]);
  });

  it("returns subtractions for window", () => {
    const subs = buildSubtractionList(defaultPieceConfig("wall-window"));
    expect(subs.length).toBeGreaterThan(0);
    expect(subs[0].type).toBe("box");
  });

  it("returns subtractions for door", () => {
    const subs = buildSubtractionList(defaultPieceConfig("wall-door"));
    expect(subs.length).toBeGreaterThan(0);
  });
});

describe("validateOpening", () => {
  it("validates a fitting opening", () => {
    const result = validateOpening(
      { width: 2, height: 3, thickness: 0.2 },
      { offsetX: 0, offsetY: 0.5, width: 0.6, height: 1.2, archRadius: 0 },
    );
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  it("rejects opening extending past edges", () => {
    const result = validateOpening(
      { width: 1, height: 2, thickness: 0.2 },
      { offsetX: 0, offsetY: 0.5, width: 2, height: 3, archRadius: 0 },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
