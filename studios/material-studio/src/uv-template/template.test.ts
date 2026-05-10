import { describe, expect, it } from "vitest";
import {
  buildIslandTemplate,
  extractIslandPixelArt,
  renderPatternsThroughTemplate,
  type Island,
  type RgbaBuffer
} from "./template";

const sampleIslands: Island[] = [
  { x: 64, y: 64, cellsX: 8, cellsY: 8, cellPx: 16, name: "A" },
  { x: 320, y: 320, cellsX: 4, cellsY: 4, cellPx: 16, name: "B" }
];

function pixelAt(buf: RgbaBuffer, x: number, y: number) {
  const i = (y * buf.width + x) * 4;
  return [buf.data[i], buf.data[i + 1], buf.data[i + 2]];
}

describe("buildIslandTemplate", () => {
  const tpl = buildIslandTemplate({
    width: 512,
    height: 512,
    islands: sampleIslands,
    backgroundColor: 0x808080,
    fillColor: 0xffffff,
    lineColor: 0x000000,
    outlineColor: 0xff00ff,
    outlineThicknessPx: 4,
    lineThicknessPx: 2
  });

  it("paints background outside all islands", () => {
    expect(pixelAt(tpl, 5, 5)).toEqual([0x80, 0x80, 0x80]);
    expect(pixelAt(tpl, 250, 250)).toEqual([0x80, 0x80, 0x80]);
    expect(pixelAt(tpl, 500, 500)).toEqual([0x80, 0x80, 0x80]);
  });

  it("paints fill colour at the centre of an interior island cell", () => {
    // Centre of cell (1,1) of island A: x = 64 + 1*16 + 8 = 88
    expect(pixelAt(tpl, 88, 88)).toEqual([0xff, 0xff, 0xff]);
  });

  it("paints grid line colour on interior cell boundaries", () => {
    // First grid divider in island A is at lx=16,17 → x=80,81
    expect(pixelAt(tpl, 80, 80)).toEqual([0x00, 0x00, 0x00]);
  });

  it("paints outline colour just outside the island bounds", () => {
    // Island A spans x=[64..192), y=[64..192). One pixel into outline.
    expect(pixelAt(tpl, 62, 100)).toEqual([0xff, 0x00, 0xff]);
    expect(pixelAt(tpl, 100, 62)).toEqual([0xff, 0x00, 0xff]);
  });
});

describe("renderPatternsThroughTemplate + extractIslandPixelArt", () => {
  it("round-trips per-island patterns through template into recovered art", () => {
    const opts = {
      width: 512,
      height: 512,
      islands: sampleIslands
    };
    const patterns: RgbaBuffer[] = sampleIslands.map((isl) => {
      const data = new Uint8ClampedArray(isl.cellsX * isl.cellsY * 4);
      for (let y = 0; y < isl.cellsY; y++) {
        for (let x = 0; x < isl.cellsX; x++) {
          const i = (y * isl.cellsX + x) * 4;
          // Pattern with all channels distinct so any UV swap shows up.
          data[i] = (x * 16) & 0xff;
          data[i + 1] = (y * 16) & 0xff;
          data[i + 2] = ((x + y) * 8) & 0xff;
          data[i + 3] = 255;
        }
      }
      return { data, width: isl.cellsX, height: isl.cellsY };
    });

    const synthetic = renderPatternsThroughTemplate(patterns, opts);
    const recovered = extractIslandPixelArt(synthetic, sampleIslands);
    expect(recovered.length).toBe(2);
    for (let i = 0; i < patterns.length; i++) {
      expect(recovered[i].width).toBe(patterns[i].width);
      expect(recovered[i].height).toBe(patterns[i].height);
      for (let p = 0; p < patterns[i].data.length; p++) {
        expect(recovered[i].data[p]).toBe(patterns[i].data[p]);
      }
    }
  });

  it("ignores background pixels — extractor only reads cell interiors", () => {
    // Build a synthetic where the BACKGROUND is a wildly different colour,
    // but the islands hold a known pattern. Recovered art must match the
    // pattern, not the background.
    const opts = {
      width: 256,
      height: 256,
      islands: [{ x: 32, y: 32, cellsX: 4, cellsY: 4, cellPx: 16, name: "A" }],
      backgroundColor: 0xff0000 // bright red
    };
    const patterns: RgbaBuffer[] = [
      {
        data: new Uint8ClampedArray(4 * 4 * 4).fill(0).map((_, i) => (i % 4 === 3 ? 255 : 0)) as unknown as Uint8ClampedArray,
        width: 4,
        height: 4
      }
    ];
    // Manually re-create as Uint8ClampedArray of solid black with alpha=255
    const black = new Uint8ClampedArray(4 * 4 * 4);
    for (let p = 0; p < 16; p++) black[p * 4 + 3] = 255;
    patterns[0] = { data: black, width: 4, height: 4 };

    const synthetic = renderPatternsThroughTemplate(patterns, opts);
    const recovered = extractIslandPixelArt(synthetic, opts.islands);
    for (let p = 0; p < 16; p++) {
      expect(recovered[0].data[p * 4]).toBe(0);
      expect(recovered[0].data[p * 4 + 1]).toBe(0);
      expect(recovered[0].data[p * 4 + 2]).toBe(0);
    }
  });
});
