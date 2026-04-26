/**
 * Pixel-art texture authoring via grid-overlay AI prompting.
 *
 * The technique:
 * 1. Build a high-resolution PNG that is an N×M grid of cells (each cell a
 *    blank tile bordered by a thin coloured grid line). The cell count is the
 *    target texel resolution of the final texture.
 * 2. Send this PNG to gpt-image-2 via /v1/images/edits with a prompt asking
 *    the model to paint *one colour per cell, no anti-aliasing*. The grid
 *    becomes a non-negotiable spatial structure for the model.
 * 3. Post-process: for each cell read the centre region (away from grid
 *    lines) and reduce to one colour (median). Write that colour to the
 *    corresponding texel of an N×M buffer.
 * 4. Upload the buffer as a Three.js DataTexture sampled with NEAREST filter,
 *    so every texel reads back as one rendered pixel at zoom 1 along the
 *    horizontal screen axis (and one large pixel at higher zoom).
 *
 * Pure data manipulation — no DOM. Use {@link toImageData} at the browser
 * boundary to hand off to canvas/Three.
 */

export type RgbaBuffer = {
  data: Uint8ClampedArray;
  width: number;
  height: number;
};

export type GridPngOptions = {
  /** Number of texel columns in the final texture. */
  cellsX: number;
  /** Number of texel rows in the final texture. */
  cellsY: number;
  /** Cell size in source pixels — each grid cell is `cellPx × cellPx` source pixels. */
  cellPx: number;
  /** Grid line thickness in source pixels. Should be ≥ 1 and ≤ cellPx/4. */
  lineThicknessPx?: number;
  /** Background fill (interior of cells) as 0xRRGGBB. */
  fillColor?: number;
  /** Grid line colour as 0xRRGGBB. */
  lineColor?: number;
  /**
   * Whether to draw the grid line on the four image edges. Default `false`
   * — without an outer frame the model can paint cells (0,*), (*,0),
   * (cellsX-1,*), (*,cellsY-1) right up to the image boundary, which fixes
   * the visible grid-line bleed in those edge texels after extraction.
   */
  drawOuterFrame?: boolean;
};

/**
 * Build the grid reference image. Returns a buffer of size
 * `cellsX*cellPx × cellsY*cellPx`.
 *
 * The grid acts as a structural frame for the model to paint inside. Line
 * colour is configurable — black reads as a natural cell separator (similar
 * to mortar / panel joints in many art styles); a saturated colour like
 * magenta signals "ignore me" but can confuse the model when the prompted
 * subject has its own bright pixels. Both work; the post-processor samples
 * cell interiors only, so it doesn't depend on line colour.
 */
export function buildGridPng(opts: GridPngOptions): RgbaBuffer {
  const lineThicknessPx = opts.lineThicknessPx ?? 2;
  const fillColor = opts.fillColor ?? 0xffffff;
  const lineColor = opts.lineColor ?? 0x000000;
  const drawOuterFrame = opts.drawOuterFrame ?? false;

  const widthPx = opts.cellsX * opts.cellPx;
  const heightPx = opts.cellsY * opts.cellPx;
  const data = new Uint8ClampedArray(widthPx * heightPx * 4);

  const fillR = (fillColor >> 16) & 0xff;
  const fillG = (fillColor >> 8) & 0xff;
  const fillB = fillColor & 0xff;
  const lineR = (lineColor >> 16) & 0xff;
  const lineG = (lineColor >> 8) & 0xff;
  const lineB = lineColor & 0xff;

  for (let y = 0; y < heightPx; y++) {
    const yIntoCell = y % opts.cellPx;
    const isTopOfCell = yIntoCell < lineThicknessPx;
    const isBotOfCell = yIntoCell >= opts.cellPx - lineThicknessPx;
    const onHorizontalLine =
      (isTopOfCell || isBotOfCell) &&
      (drawOuterFrame ||
        (y >= lineThicknessPx && y < heightPx - lineThicknessPx));
    for (let x = 0; x < widthPx; x++) {
      const xIntoCell = x % opts.cellPx;
      const isLeftOfCell = xIntoCell < lineThicknessPx;
      const isRightOfCell = xIntoCell >= opts.cellPx - lineThicknessPx;
      const onVerticalLine =
        (isLeftOfCell || isRightOfCell) &&
        (drawOuterFrame ||
          (x >= lineThicknessPx && x < widthPx - lineThicknessPx));
      const onLine = onHorizontalLine || onVerticalLine;
      const i = (y * widthPx + x) * 4;
      if (onLine) {
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

  return { data, width: widthPx, height: heightPx };
}

export type ExtractOptions = {
  cellsX: number;
  cellsY: number;
  cellPx: number;
  /** 0..1 fraction of the cell used for sampling. 0.5 = centre half, skipping outer 25% on every side. */
  samplingFraction?: number;
};

/**
 * Reduce an AI-generated `cellsX·cellPx × cellsY·cellPx` PNG back to a
 * `cellsX × cellsY` buffer.
 *
 * For each cell we sample only the central square (default 50% of the cell,
 * skipping outer 25% on every side to bypass the grid line and edge bleed)
 * and take the per-channel median. Median is robust to a single rogue pixel
 * from anti-aliasing or AI speckle while still giving one deterministic
 * colour per cell.
 */
export function extractPixelArt(source: RgbaBuffer, opts: ExtractOptions): RgbaBuffer {
  const samplingFraction = opts.samplingFraction ?? 0.5;
  const expectedW = opts.cellsX * opts.cellPx;
  const expectedH = opts.cellsY * opts.cellPx;
  if (source.width !== expectedW || source.height !== expectedH) {
    throw new Error(
      `extractPixelArt: expected ${expectedW}×${expectedH}, got ${source.width}×${source.height}`
    );
  }

  const half = opts.cellPx / 2;
  const sampleHalfSize = Math.max(1, Math.floor((opts.cellPx * samplingFraction) / 2));

  const out = new Uint8ClampedArray(opts.cellsX * opts.cellsY * 4);

  for (let cy = 0; cy < opts.cellsY; cy++) {
    for (let cx = 0; cx < opts.cellsX; cx++) {
      const cellCenterX = Math.floor(cx * opts.cellPx + half);
      const cellCenterY = Math.floor(cy * opts.cellPx + half);
      const x0 = Math.max(0, cellCenterX - sampleHalfSize);
      const x1 = Math.min(source.width, cellCenterX + sampleHalfSize);
      const y0 = Math.max(0, cellCenterY - sampleHalfSize);
      const y1 = Math.min(source.height, cellCenterY + sampleHalfSize);

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

      const r = median(reds);
      const g = median(greens);
      const b = median(blues);

      const oi = (cy * opts.cellsX + cx) * 4;
      out[oi] = r;
      out[oi + 1] = g;
      out[oi + 2] = b;
      out[oi + 3] = 255;
    }
  }

  return { data: out, width: opts.cellsX, height: opts.cellsY };
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
 * Deterministic test pattern at the target texel resolution. Used by the
 * synthetic verification path (grid-art-tex e2e test): when the experiment
 * renders this pattern with NEAREST filtering, framebuffer pixels under
 * known mesh points must match the colours below exactly. Any mismatch
 * indicates filtering, mipmapping, MSAA averaging, or UV drift.
 *
 * High-contrast saturated primaries with no two adjacent palette indices
 * the same colour, so a single-pixel shift is visually obvious.
 */
export function buildSyntheticTestPattern(cellsX: number, cellsY: number): RgbaBuffer {
  const data = new Uint8ClampedArray(cellsX * cellsY * 4);
  const palette: Array<[number, number, number]> = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 0],
    [255, 0, 255],
    [0, 255, 255],
    [255, 255, 255],
    [0, 0, 0]
  ];
  for (let y = 0; y < cellsY; y++) {
    for (let x = 0; x < cellsX; x++) {
      const idx = (x + y * cellsX) % palette.length;
      const [r, g, b] = palette[idx];
      const i = (y * cellsX + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { data, width: cellsX, height: cellsY };
}

/**
 * Synthetic AI output for unit tests: render a pixel-art pattern back up
 * onto an `cellsX*cellPx × cellsY*cellPx` canvas with the grid lines
 * preserved. Lets us round-trip the post-processor without needing a real
 * AI call.
 */
export function renderPatternThroughGrid(
  pattern: RgbaBuffer,
  opts: GridPngOptions
): RgbaBuffer {
  if (pattern.width !== opts.cellsX || pattern.height !== opts.cellsY) {
    throw new Error(
      `renderPatternThroughGrid: pattern ${pattern.width}×${pattern.height} ≠ grid ${opts.cellsX}×${opts.cellsY}`
    );
  }
  const lineThicknessPx = opts.lineThicknessPx ?? 2;
  const lineColor = opts.lineColor ?? 0xff00ff;
  const lineR = (lineColor >> 16) & 0xff;
  const lineG = (lineColor >> 8) & 0xff;
  const lineB = lineColor & 0xff;

  const widthPx = opts.cellsX * opts.cellPx;
  const heightPx = opts.cellsY * opts.cellPx;
  const data = new Uint8ClampedArray(widthPx * heightPx * 4);

  for (let y = 0; y < heightPx; y++) {
    const cy = Math.floor(y / opts.cellPx);
    const yIntoCell = y % opts.cellPx;
    const onHLine =
      yIntoCell < lineThicknessPx ||
      yIntoCell >= opts.cellPx - lineThicknessPx;
    for (let x = 0; x < widthPx; x++) {
      const cx = Math.floor(x / opts.cellPx);
      const xIntoCell = x % opts.cellPx;
      const onVLine =
        xIntoCell < lineThicknessPx ||
        xIntoCell >= opts.cellPx - lineThicknessPx;
      const i = (y * widthPx + x) * 4;
      if (onHLine || onVLine) {
        data[i] = lineR;
        data[i + 1] = lineG;
        data[i + 2] = lineB;
      } else {
        const pi = (cy * opts.cellsX + cx) * 4;
        data[i] = pattern.data[pi];
        data[i + 1] = pattern.data[pi + 1];
        data[i + 2] = pattern.data[pi + 2];
      }
      data[i + 3] = 255;
    }
  }
  return { data, width: widthPx, height: heightPx };
}
