/**
 * Recompose extracted per-island pixel art into a clean atlas image.
 *
 * Input: the `Island` layout used to build the prompt template, plus one
 * `RgbaBuffer` (cellsX × cellsY pixel art) per island. Output: a single
 * RgbaBuffer the size of the template, with each cell painted as a flat
 * `cellPx × cellPx` block at the island's position. Outside-island pixels
 * are filled with the supplied background colour. A small seam-bleed
 * dilation prevents UV-edge sampling from grabbing background.
 *
 * Pure data manipulation — no DOM, no THREE.
 */

import type { Island, RgbaBuffer } from "./template";

export type RecomposeOptions = {
  /** RGB packed as 0xRRGGBB. Default neutral mid-grey. */
  backgroundColor?: number;
  /** RGB to dilate from each island's edge cells (in template pixels). Default 3. */
  seamBleedPx?: number;
};

const DEFAULT_BG = 0x808080;
const DEFAULT_BLEED = 3;

export function recomposeIslandsAsAtlas(
  templateWidth: number,
  templateHeight: number,
  islands: Island[],
  pixelArt: RgbaBuffer[],
  opts: RecomposeOptions = {}
): RgbaBuffer {
  if (islands.length !== pixelArt.length) {
    throw new Error(
      `recomposeIslandsAsAtlas: ${islands.length} islands but ${pixelArt.length} pixel-art buffers`
    );
  }
  const bg = opts.backgroundColor ?? DEFAULT_BG;
  const bleed = opts.seamBleedPx ?? DEFAULT_BLEED;

  const data = new Uint8ClampedArray(templateWidth * templateHeight * 4);
  const bgR = (bg >> 16) & 0xff;
  const bgG = (bg >> 8) & 0xff;
  const bgB = bg & 0xff;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = bgR;
    data[i + 1] = bgG;
    data[i + 2] = bgB;
    data[i + 3] = 255;
  }

  for (let idx = 0; idx < islands.length; idx++) {
    const isl = islands[idx];
    const art = pixelArt[idx];
    if (art.width !== isl.cellsX || art.height !== isl.cellsY) {
      throw new Error(
        `recomposeIslandsAsAtlas: pixel art ${idx} is ${art.width}×${art.height} but island is ${isl.cellsX}×${isl.cellsY}`
      );
    }
    paintIsland(data, templateWidth, templateHeight, isl, art);
  }

  if (bleed > 0) {
    for (let idx = 0; idx < islands.length; idx++) {
      dilateIslandBleed(data, templateWidth, templateHeight, islands[idx], bleed);
    }
  }

  return { data, width: templateWidth, height: templateHeight };
}

function paintIsland(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  isl: Island,
  art: RgbaBuffer
): void {
  for (let cy = 0; cy < isl.cellsY; cy++) {
    for (let cx = 0; cx < isl.cellsX; cx++) {
      const ai = (cy * art.width + cx) * 4;
      const r = art.data[ai];
      const g = art.data[ai + 1];
      const b = art.data[ai + 2];
      const xStart = isl.x + cx * isl.cellPx;
      const yStart = isl.y + cy * isl.cellPx;
      for (let ly = 0; ly < isl.cellPx; ly++) {
        const y = yStart + ly;
        if (y < 0 || y >= height) continue;
        for (let lx = 0; lx < isl.cellPx; lx++) {
          const x = xStart + lx;
          if (x < 0 || x >= width) continue;
          const di = (y * width + x) * 4;
          data[di] = r;
          data[di + 1] = g;
          data[di + 2] = b;
          data[di + 3] = 255;
        }
      }
    }
  }
}

/**
 * Dilate the island's painted region outward by `bleed` pixels using the
 * nearest island-edge colour. Only writes background pixels — won't
 * overwrite neighbouring islands or already-painted cells.
 *
 * Implementation: for each border pixel of the island rectangle, sample
 * the colour just inside the rect and copy it outward in a `bleed`-wide
 * frame. This is a coarse but cheap dilation; sufficient for hiding
 * NEAREST/LINEAR sampling at UV seams.
 */
function dilateIslandBleed(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  isl: Island,
  bleed: number
): void {
  const rectX0 = isl.x;
  const rectY0 = isl.y;
  const rectX1 = isl.x + isl.cellsX * isl.cellPx;
  const rectY1 = isl.y + isl.cellsY * isl.cellPx;

  // Top + bottom strips — sample row just inside the rect.
  for (let dx = -bleed; dx < isl.cellsX * isl.cellPx + bleed; dx++) {
    const x = rectX0 + dx;
    if (x < 0 || x >= width) continue;
    const sampleX = clamp(x, rectX0, rectX1 - 1);

    // Top
    const sampleTopY = rectY0;
    if (sampleTopY >= 0 && sampleTopY < height) {
      const si = (sampleTopY * width + sampleX) * 4;
      const r = data[si], g = data[si + 1], b = data[si + 2];
      for (let dy = 1; dy <= bleed; dy++) {
        const y = rectY0 - dy;
        if (y < 0 || y >= height) continue;
        const di = (y * width + x) * 4;
        data[di] = r; data[di + 1] = g; data[di + 2] = b; data[di + 3] = 255;
      }
    }

    // Bottom
    const sampleBotY = rectY1 - 1;
    if (sampleBotY >= 0 && sampleBotY < height) {
      const si = (sampleBotY * width + sampleX) * 4;
      const r = data[si], g = data[si + 1], b = data[si + 2];
      for (let dy = 1; dy <= bleed; dy++) {
        const y = rectY1 - 1 + dy;
        if (y < 0 || y >= height) continue;
        const di = (y * width + x) * 4;
        data[di] = r; data[di + 1] = g; data[di + 2] = b; data[di + 3] = 255;
      }
    }
  }

  // Left + right strips — sample column just inside the rect.
  for (let dy = 0; dy < isl.cellsY * isl.cellPx; dy++) {
    const y = rectY0 + dy;
    if (y < 0 || y >= height) continue;
    const sampleY = y;

    // Left
    const sampleLeftX = rectX0;
    if (sampleLeftX >= 0 && sampleLeftX < width) {
      const si = (sampleY * width + sampleLeftX) * 4;
      const r = data[si], g = data[si + 1], b = data[si + 2];
      for (let dx = 1; dx <= bleed; dx++) {
        const x = rectX0 - dx;
        if (x < 0 || x >= width) continue;
        const di = (sampleY * width + x) * 4;
        data[di] = r; data[di + 1] = g; data[di + 2] = b; data[di + 3] = 255;
      }
    }

    // Right
    const sampleRightX = rectX1 - 1;
    if (sampleRightX >= 0 && sampleRightX < width) {
      const si = (sampleY * width + sampleRightX) * 4;
      const r = data[si], g = data[si + 1], b = data[si + 2];
      for (let dx = 1; dx <= bleed; dx++) {
        const x = rectX1 - 1 + dx;
        if (x < 0 || x >= width) continue;
        const di = (sampleY * width + x) * 4;
        data[di] = r; data[di + 1] = g; data[di + 2] = b; data[di + 3] = 255;
      }
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
