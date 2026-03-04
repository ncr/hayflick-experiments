import { describe, it, expect } from "vitest";
import { expandTileset, generateTilesetIndex } from "./tileset";
import { DEFAULT_DIMENSIONS, DEFAULT_MATERIAL, DEFAULT_OPENING, DEFAULT_TRIM } from "./piece-catalog";

describe("expandTileset", () => {
  it("creates one config per piece kind", () => {
    const configs = expandTileset({
      pieces: ["wall-straight", "wall-window"],
      dimensions: DEFAULT_DIMENSIONS,
      material: DEFAULT_MATERIAL,
      opening: DEFAULT_OPENING,
      trim: DEFAULT_TRIM,
      textureResolution: 512,
    });
    expect(configs.length).toBe(2);
    expect(configs[0].kind).toBe("wall-straight");
    expect(configs[1].kind).toBe("wall-window");
  });
});

describe("generateTilesetIndex", () => {
  it("produces index with piece slugs", () => {
    const configs = expandTileset({
      pieces: ["wall-straight", "wall-corner-inner"],
      dimensions: DEFAULT_DIMENSIONS,
      material: DEFAULT_MATERIAL,
      opening: DEFAULT_OPENING,
      trim: DEFAULT_TRIM,
      textureResolution: 512,
    });
    const index = generateTilesetIndex(configs);
    expect(index.gridSize).toBe(1.0);
    expect(index.pieces).toEqual(["wall-straight-brick", "wall-corner-inner-brick"]);
  });
});
