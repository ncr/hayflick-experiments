import { describe, expect, it } from "vitest";
import { recomposeIslandsAsAtlas } from "./recompose";
import type { Island, RgbaBuffer } from "./template";

function pixelAt(buf: RgbaBuffer, x: number, y: number): [number, number, number] {
  const i = (y * buf.width + x) * 4;
  return [buf.data[i], buf.data[i + 1], buf.data[i + 2]];
}

function makeArt(cellsX: number, cellsY: number, fn: (cx: number, cy: number) => [number, number, number]): RgbaBuffer {
  const data = new Uint8ClampedArray(cellsX * cellsY * 4);
  for (let cy = 0; cy < cellsY; cy++) {
    for (let cx = 0; cx < cellsX; cx++) {
      const i = (cy * cellsX + cx) * 4;
      const [r, g, b] = fn(cx, cy);
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return { data, width: cellsX, height: cellsY };
}

describe("recomposeIslandsAsAtlas", () => {
  const island: Island = { x: 64, y: 64, cellsX: 4, cellsY: 4, cellPx: 16 };

  it("paints each cell as a solid block at the island position", () => {
    const art = makeArt(4, 4, (cx, cy) => [cx * 50, cy * 50, 100]);
    const atlas = recomposeIslandsAsAtlas(256, 256, [island], [art], { seamBleedPx: 0 });
    // Cell (1, 2) → top-left at (64+16, 64+32) = (80, 96)
    expect(pixelAt(atlas, 80, 96)).toEqual([50, 100, 100]);
    expect(pixelAt(atlas, 88, 104)).toEqual([50, 100, 100]); // centre of same cell
    // Cell (3, 0) → top-left at (64+48, 64) = (112, 64)
    expect(pixelAt(atlas, 112, 64)).toEqual([150, 0, 100]);
  });

  it("fills outside-island pixels with backgroundColor", () => {
    const art = makeArt(4, 4, () => [255, 255, 255]);
    const atlas = recomposeIslandsAsAtlas(256, 256, [island], [art], {
      backgroundColor: 0x336699,
      seamBleedPx: 0
    });
    expect(pixelAt(atlas, 5, 5)).toEqual([0x33, 0x66, 0x99]);
    expect(pixelAt(atlas, 200, 200)).toEqual([0x33, 0x66, 0x99]);
  });

  it("seam-bleeds island-edge colour into the surrounding margin", () => {
    const art = makeArt(4, 4, () => [200, 30, 30]); // solid red island
    const atlas = recomposeIslandsAsAtlas(256, 256, [island], [art], {
      backgroundColor: 0x808080,
      seamBleedPx: 3
    });
    // Just inside top edge of island → red
    expect(pixelAt(atlas, 80, 64)).toEqual([200, 30, 30]);
    // Just outside top edge (within bleed margin) → red (bleed)
    expect(pixelAt(atlas, 80, 63)).toEqual([200, 30, 30]);
    expect(pixelAt(atlas, 80, 62)).toEqual([200, 30, 30]);
    // Beyond the bleed margin → background
    const farY = 64 - 3 - 5;
    expect(pixelAt(atlas, 80, farY)).toEqual([0x80, 0x80, 0x80]);
  });

  it("rejects mismatched island/art array lengths", () => {
    expect(() =>
      recomposeIslandsAsAtlas(256, 256, [island], [], { seamBleedPx: 0 })
    ).toThrow();
  });

  it("rejects pixel art whose dimensions disagree with the island", () => {
    const wrong = makeArt(3, 3, () => [0, 0, 0]);
    expect(() =>
      recomposeIslandsAsAtlas(256, 256, [island], [wrong], { seamBleedPx: 0 })
    ).toThrow();
  });
});
