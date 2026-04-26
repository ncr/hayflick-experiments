import { describe, expect, it } from "vitest";
import {
  buildGridPng,
  buildSyntheticTestPattern,
  extractPixelArt,
  renderPatternThroughGrid
} from "./pixel-grid";

describe("buildGridPng", () => {
  it("produces an image of cellsX*cellPx by cellsY*cellPx", () => {
    const grid = buildGridPng({ cellsX: 32, cellsY: 32, cellPx: 32 });
    expect(grid.width).toBe(1024);
    expect(grid.height).toBe(1024);
    expect(grid.data.length).toBe(1024 * 1024 * 4);
  });

  it("paints the requested fill colour at cell centres", () => {
    const fill = 0x808080;
    const grid = buildGridPng({
      cellsX: 4,
      cellsY: 4,
      cellPx: 16,
      fillColor: fill,
      lineThicknessPx: 1
    });
    // Centre of cell (1, 1) — well inside the cell, away from any line
    const centerX = 1 * 16 + 8;
    const centerY = 1 * 16 + 8;
    const i = (centerY * grid.width + centerX) * 4;
    expect(grid.data[i]).toBe(0x80);
    expect(grid.data[i + 1]).toBe(0x80);
    expect(grid.data[i + 2]).toBe(0x80);
  });

  it("paints the requested line colour on interior grid edges", () => {
    const grid = buildGridPng({
      cellsX: 2,
      cellsY: 2,
      cellPx: 16,
      lineColor: 0xff00ff,
      lineThicknessPx: 2
    });
    // Centre of the interior dividing line (between cell (0,0) and (1,0)).
    // With drawOuterFrame defaulting to false, the image corner is fill,
    // not line — but the inner divider at x=16,17 (cell boundary) is line.
    const x = 16;
    const y = 8; // mid-height of row 0
    const i = (y * grid.width + x) * 4;
    expect(grid.data[i]).toBe(0xff);
    expect(grid.data[i + 1]).toBe(0x00);
    expect(grid.data[i + 2]).toBe(0xff);
  });

  it("omits the outer frame by default", () => {
    const grid = buildGridPng({
      cellsX: 2,
      cellsY: 2,
      cellPx: 16,
      lineColor: 0xff00ff,
      fillColor: 0xffffff,
      lineThicknessPx: 2
    });
    // Top-left pixel: should be fill (white), not line (magenta).
    expect(grid.data[0]).toBe(0xff);
    expect(grid.data[1]).toBe(0xff);
    expect(grid.data[2]).toBe(0xff);
  });

  it("draws the outer frame when requested", () => {
    const grid = buildGridPng({
      cellsX: 2,
      cellsY: 2,
      cellPx: 16,
      lineColor: 0xff00ff,
      lineThicknessPx: 2,
      drawOuterFrame: true
    });
    expect(grid.data[0]).toBe(0xff);
    expect(grid.data[1]).toBe(0x00);
    expect(grid.data[2]).toBe(0xff);
  });
});

describe("extractPixelArt", () => {
  it("recovers a pattern that was rendered through the grid", () => {
    const cellsX = 16;
    const cellsY = 16;
    const cellPx = 16;
    const original = buildSyntheticTestPattern(cellsX, cellsY);
    const upscaled = renderPatternThroughGrid(original, { cellsX, cellsY, cellPx });
    const recovered = extractPixelArt(upscaled, { cellsX, cellsY, cellPx });

    expect(recovered.width).toBe(cellsX);
    expect(recovered.height).toBe(cellsY);
    expect(recovered.data.length).toBe(original.data.length);
    for (let i = 0; i < original.data.length; i++) {
      expect(recovered.data[i]).toBe(original.data[i]);
    }
  });

  it("rejects buffers of the wrong size", () => {
    const wrongSize = { data: new Uint8ClampedArray(4 * 4 * 4), width: 4, height: 4 };
    expect(() =>
      extractPixelArt(wrongSize, { cellsX: 4, cellsY: 4, cellPx: 16 })
    ).toThrow(/expected 64×64/);
  });

  it("ignores grid-line bleed by sampling cell interiors only", () => {
    // Build a pattern, paint a "noisy" border on every cell with random AI-like
    // speckle, then verify the centre median still recovers the pattern.
    const cellsX = 8;
    const cellsY = 8;
    const cellPx = 16;
    const pattern = buildSyntheticTestPattern(cellsX, cellsY);
    const upscaled = renderPatternThroughGrid(pattern, {
      cellsX,
      cellsY,
      cellPx,
      lineThicknessPx: 3
    });

    // Add per-cell speckle near the line (1px in from line) to simulate AA
    for (let cy = 0; cy < cellsY; cy++) {
      for (let cx = 0; cx < cellsX; cx++) {
        const x = cx * cellPx + 4;
        const y = cy * cellPx + 4;
        const i = (y * upscaled.width + x) * 4;
        // Bright orange — would corrupt a mean-based extractor
        upscaled.data[i] = 255;
        upscaled.data[i + 1] = 128;
        upscaled.data[i + 2] = 0;
      }
    }

    const recovered = extractPixelArt(upscaled, { cellsX, cellsY, cellPx });
    for (let i = 0; i < pattern.data.length; i++) {
      expect(recovered.data[i]).toBe(pattern.data[i]);
    }
  });
});

describe("buildSyntheticTestPattern", () => {
  it("uses the documented palette and tiles deterministically", () => {
    const p = buildSyntheticTestPattern(8, 1);
    // Index 0..7 maps to the 8-colour palette
    const expected = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [255, 255, 0],
      [255, 0, 255],
      [0, 255, 255],
      [255, 255, 255],
      [0, 0, 0]
    ];
    for (let x = 0; x < 8; x++) {
      const i = x * 4;
      expect(p.data[i]).toBe(expected[x][0]);
      expect(p.data[i + 1]).toBe(expected[x][1]);
      expect(p.data[i + 2]).toBe(expected[x][2]);
      expect(p.data[i + 3]).toBe(255);
    }
  });
});
