/**
 * Multi-island UV-template prompting for AI pixel-art textures.
 *
 * Probe for "approach 3" — sending a UV-unwrap-style template to gpt-image-2
 * and letting the model paint inside the islands. The first probe uses
 * synthetic rectangular islands (not real mesh UVs) just to validate that
 * the model respects island boundaries and the background.
 *
 * Pure data manipulation — no DOM. Kept local to Material Studio because the
 * active UI is the only consumer of this UV-template pipeline.
 */

export type RgbaBuffer = {
  data: Uint8ClampedArray;
  width: number;
  height: number;
};

export type Island = {
  /** Top-left x in template-source pixels. */
  x: number;
  /** Top-left y in template-source pixels. */
  y: number;
  /** Pixel-art grid dimensions (number of cells across × down). */
  cellsX: number;
  cellsY: number;
  /** Cell size in template-source pixels. Island spans `cellsX*cellPx × cellsY*cellPx`. */
  cellPx: number;
  /** Optional human-readable name (used in prompt + UI). */
  name?: string;
};

export type IslandTemplateOptions = {
  /** Template canvas width — pick a gpt-image-2 supported size (1024, 1536). */
  width: number;
  /** Template canvas height. */
  height: number;
  islands: Island[];
  /** Outside-island colour as 0xRRGGBB. Default neutral mid-grey. */
  backgroundColor?: number;
  /** Cell-interior colour as 0xRRGGBB. Default white. */
  fillColor?: number;
  /** Grid-line colour inside islands as 0xRRGGBB. Default black. */
  lineColor?: number;
  /** Grid-line thickness in template-source pixels. Default 4. */
  lineThicknessPx?: number;
  /** Outline-around-island colour as 0xRRGGBB. Default magenta. */
  outlineColor?: number;
  /** Outline thickness in template-source pixels. Default 6. */
  outlineThicknessPx?: number;
  /** Optional per-island outline colour, 0xRRGGBB. Length must match
   *  `islands` if provided. Lets the spatial-context layer give every
   *  island a distinct colour that matches the 3D reference image. */
  outlineColors?: ReadonlyArray<number>;
};

/**
 * Build a template image: a background fill with N rectangular islands drawn
 * on top, each containing its own cell grid and surrounded by an outline.
 *
 * The outline colour is intentionally distinct from both background and
 * fill — it is the spatial signal we ask the model to honour ("paint
 * inside the outlined regions, leave outside untouched").
 */
export function buildIslandTemplate(opts: IslandTemplateOptions): RgbaBuffer {
  const {
    width,
    height,
    islands,
    backgroundColor = 0x808080,
    fillColor = 0xffffff,
    lineColor = 0x000000,
    lineThicknessPx = 4,
    outlineColor = 0xff00ff,
    outlineThicknessPx = 6
  } = opts;

  const data = new Uint8ClampedArray(width * height * 4);

  const bgR = (backgroundColor >> 16) & 0xff;
  const bgG = (backgroundColor >> 8) & 0xff;
  const bgB = backgroundColor & 0xff;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = bgR;
    data[i + 1] = bgG;
    data[i + 2] = bgB;
    data[i + 3] = 255;
  }

  const fillR = (fillColor >> 16) & 0xff;
  const fillG = (fillColor >> 8) & 0xff;
  const fillB = fillColor & 0xff;
  const lineR = (lineColor >> 16) & 0xff;
  const lineG = (lineColor >> 8) & 0xff;
  const lineB = lineColor & 0xff;
  const defaultOutR = (outlineColor >> 16) & 0xff;
  const defaultOutG = (outlineColor >> 8) & 0xff;
  const defaultOutB = outlineColor & 0xff;

  if (opts.outlineColors && opts.outlineColors.length !== islands.length) {
    throw new Error(
      `buildIslandTemplate: outlineColors length ${opts.outlineColors.length} != islands ${islands.length}`
    );
  }

  for (let islandIdx = 0; islandIdx < islands.length; islandIdx++) {
    const island = islands[islandIdx];
    const perIslandHex = opts.outlineColors?.[islandIdx];
    const outR = perIslandHex !== undefined ? (perIslandHex >> 16) & 0xff : defaultOutR;
    const outG = perIslandHex !== undefined ? (perIslandHex >> 8) & 0xff : defaultOutG;
    const outB = perIslandHex !== undefined ? perIslandHex & 0xff : defaultOutB;
    const islW = island.cellsX * island.cellPx;
    const islH = island.cellsY * island.cellPx;

    for (let ly = 0; ly < islH; ly++) {
      const y = island.y + ly;
      if (y < 0 || y >= height) continue;
      const yIntoCell = ly % island.cellPx;
      const onHLine =
        yIntoCell < lineThicknessPx ||
        yIntoCell >= island.cellPx - lineThicknessPx;
      for (let lx = 0; lx < islW; lx++) {
        const x = island.x + lx;
        if (x < 0 || x >= width) continue;
        const xIntoCell = lx % island.cellPx;
        const onVLine =
          xIntoCell < lineThicknessPx ||
          xIntoCell >= island.cellPx - lineThicknessPx;
        const i = (y * width + x) * 4;
        if (onHLine || onVLine) {
          data[i] = lineR;
          data[i + 1] = lineG;
          data[i + 2] = lineB;
        } else {
          data[i] = fillR;
          data[i + 1] = fillG;
          data[i + 2] = fillB;
        }
        data[i + 3] = 255;
      }
    }

    if (outlineThicknessPx > 0) {
      const ox0 = island.x - outlineThicknessPx;
      const oy0 = island.y - outlineThicknessPx;
      const ox1 = island.x + islW + outlineThicknessPx;
      const oy1 = island.y + islH + outlineThicknessPx;
      drawRectOutline(
        data,
        width,
        height,
        ox0,
        oy0,
        ox1,
        oy1,
        outlineThicknessPx,
        outR,
        outG,
        outB
      );
    }
  }

  return { data, width, height };
}

function drawRectOutline(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  thickness: number,
  r: number,
  g: number,
  b: number
): void {
  const paint = (x: number, y: number) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const i = (y * width + x) * 4;
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  };
  for (let t = 0; t < thickness; t++) {
    for (let x = x0; x < x1; x++) {
      paint(x, y0 + t);
      paint(x, y1 - 1 - t);
    }
    for (let y = y0; y < y1; y++) {
      paint(x0 + t, y);
      paint(x1 - 1 - t, y);
    }
  }
}

export type ExtractIslandsOptions = {
  /** Fraction of each cell sampled at the centre. 0.5 skips outer 25%. */
  samplingFraction?: number;
};

/**
 * Recover one pixel-art buffer per island from an AI-generated template image.
 *
 * Per-cell median sampling of the central region — same robustness story as
 * the original pixel-grid extraction path.
 */
export function extractIslandPixelArt(
  source: RgbaBuffer,
  islands: Island[],
  opts: ExtractIslandsOptions = {}
): RgbaBuffer[] {
  const samplingFraction = opts.samplingFraction ?? 0.5;
  return islands.map((island) =>
    extractOneIsland(source, island, samplingFraction)
  );
}

function extractOneIsland(
  source: RgbaBuffer,
  island: Island,
  samplingFraction: number
): RgbaBuffer {
  const half = island.cellPx / 2;
  const sampleHalf = Math.max(1, Math.floor((island.cellPx * samplingFraction) / 2));
  const out = new Uint8ClampedArray(island.cellsX * island.cellsY * 4);

  for (let cy = 0; cy < island.cellsY; cy++) {
    for (let cx = 0; cx < island.cellsX; cx++) {
      const centerX = Math.floor(island.x + cx * island.cellPx + half);
      const centerY = Math.floor(island.y + cy * island.cellPx + half);
      const x0 = Math.max(0, centerX - sampleHalf);
      const x1 = Math.min(source.width, centerX + sampleHalf);
      const y0 = Math.max(0, centerY - sampleHalf);
      const y1 = Math.min(source.height, centerY + sampleHalf);

      const reds: number[] = [];
      const greens: number[] = [];
      const blues: number[] = [];
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * source.width + x) * 4;
          reds.push(source.data[i]);
          greens.push(source.data[i + 1]);
          blues.push(source.data[i + 2]);
        }
      }

      const oi = (cy * island.cellsX + cx) * 4;
      out[oi] = median(reds);
      out[oi + 1] = median(greens);
      out[oi + 2] = median(blues);
      out[oi + 3] = 255;
    }
  }

  return { data: out, width: island.cellsX, height: island.cellsY };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  values.sort((a, b) => a - b);
  const mid = values.length >> 1;
  return values.length % 2 === 0
    ? Math.round((values[mid - 1] + values[mid]) / 2)
    : values[mid];
}

/**
 * Overlay user-painted cells onto an existing template buffer (mutated in
 * place). For each island, only cells whose mask byte is non-zero are
 * filled with their RGBA — empty cells stay as the template's `fillColor`
 * so the AI knows to paint them.
 *
 * This is the bridge between the in-app paint canvas (which works in
 * atlas-cell units) and the 1024² template the AI actually sees.
 */
export function paintCellsIntoTemplate(
  template: RgbaBuffer,
  islands: Island[],
  paintedCellsPerIsland: ReadonlyArray<{ rgba: Uint8ClampedArray; mask: Uint8Array }>,
  opts: { lineThicknessPx?: number } = {}
): void {
  if (paintedCellsPerIsland.length !== islands.length) {
    throw new Error(
      `paintCellsIntoTemplate: ${paintedCellsPerIsland.length} cell sets, ${islands.length} islands`
    );
  }
  const lineThicknessPx = opts.lineThicknessPx ?? 4;

  for (let idx = 0; idx < islands.length; idx++) {
    const island = islands[idx];
    const cells = paintedCellsPerIsland[idx];
    const expectedRgba = island.cellsX * island.cellsY * 4;
    const expectedMask = island.cellsX * island.cellsY;
    if (cells.rgba.length !== expectedRgba) {
      throw new Error(
        `paintCellsIntoTemplate: island ${idx} rgba length ${cells.rgba.length} != ${expectedRgba}`
      );
    }
    if (cells.mask.length !== expectedMask) {
      throw new Error(
        `paintCellsIntoTemplate: island ${idx} mask length ${cells.mask.length} != ${expectedMask}`
      );
    }

    const islW = island.cellsX * island.cellPx;
    const islH = island.cellsY * island.cellPx;
    for (let ly = 0; ly < islH; ly++) {
      const y = island.y + ly;
      if (y < 0 || y >= template.height) continue;
      const yIntoCell = ly % island.cellPx;
      const onHLine =
        yIntoCell < lineThicknessPx || yIntoCell >= island.cellPx - lineThicknessPx;
      if (onHLine) continue;
      const cy = Math.floor(ly / island.cellPx);

      for (let lx = 0; lx < islW; lx++) {
        const x = island.x + lx;
        if (x < 0 || x >= template.width) continue;
        const xIntoCell = lx % island.cellPx;
        const onVLine =
          xIntoCell < lineThicknessPx || xIntoCell >= island.cellPx - lineThicknessPx;
        if (onVLine) continue;
        const cx = Math.floor(lx / island.cellPx);

        const cellIdx = cy * island.cellsX + cx;
        if (cells.mask[cellIdx] === 0) continue; // unpainted — leave AI fill prompt intact

        const ci = cellIdx * 4;
        const ti = (y * template.width + x) * 4;
        template.data[ti] = cells.rgba[ci];
        template.data[ti + 1] = cells.rgba[ci + 1];
        template.data[ti + 2] = cells.rgba[ci + 2];
        template.data[ti + 3] = 255;
      }
    }
  }
}

/**
 * For unit tests: paint per-island patterns onto a template-shaped buffer
 * with islands' grid lines preserved, leaving the background untouched.
 * Lets us round-trip the extractor without a real AI call.
 */
export function renderPatternsThroughTemplate(
  patterns: RgbaBuffer[],
  opts: IslandTemplateOptions
): RgbaBuffer {
  if (patterns.length !== opts.islands.length) {
    throw new Error(
      `renderPatternsThroughTemplate: ${patterns.length} patterns, ${opts.islands.length} islands`
    );
  }
  const template = buildIslandTemplate(opts);
  const lineThicknessPx = opts.lineThicknessPx ?? 4;

  for (let idx = 0; idx < opts.islands.length; idx++) {
    const island = opts.islands[idx];
    const pattern = patterns[idx];
    if (pattern.width !== island.cellsX || pattern.height !== island.cellsY) {
      throw new Error(
        `Pattern ${idx} size ${pattern.width}×${pattern.height} ≠ island ${island.cellsX}×${island.cellsY}`
      );
    }
    const islW = island.cellsX * island.cellPx;
    const islH = island.cellsY * island.cellPx;
    for (let ly = 0; ly < islH; ly++) {
      const y = island.y + ly;
      if (y < 0 || y >= template.height) continue;
      const yIntoCell = ly % island.cellPx;
      const onHLine =
        yIntoCell < lineThicknessPx ||
        yIntoCell >= island.cellPx - lineThicknessPx;
      const cy = Math.floor(ly / island.cellPx);
      for (let lx = 0; lx < islW; lx++) {
        const x = island.x + lx;
        if (x < 0 || x >= template.width) continue;
        const xIntoCell = lx % island.cellPx;
        const onVLine =
          xIntoCell < lineThicknessPx ||
          xIntoCell >= island.cellPx - lineThicknessPx;
        if (onHLine || onVLine) continue;
        const cx = Math.floor(lx / island.cellPx);
        const pi = (cy * pattern.width + cx) * 4;
        const i = (y * template.width + x) * 4;
        template.data[i] = pattern.data[pi];
        template.data[i + 1] = pattern.data[pi + 1];
        template.data[i + 2] = pattern.data[pi + 2];
        template.data[i + 3] = 255;
      }
    }
  }
  return template;
}
