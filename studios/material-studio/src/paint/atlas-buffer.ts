/**
 * Pure pixel-edit helpers for the paint editor. Operate directly on the
 * `Uint8ClampedArray` rgba buffer + `Uint8Array` paint mask of an Atlas.
 *
 * Each call mutates the supplied buffers in place — the caller owns the
 * lifecycle (clone-before-stroke, dispatch-on-commit). Pure data, no DOM.
 */

export function cloneRgba(src: Uint8ClampedArray<ArrayBuffer>): Uint8ClampedArray<ArrayBuffer> {
  return new Uint8ClampedArray(src);
}

export function cloneMask(src: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  return new Uint8Array(src);
}

export function setPixel(
  rgba: Uint8ClampedArray<ArrayBuffer>,
  mask: Uint8Array<ArrayBuffer>,
  width: number,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
  maskValue: number
): void {
  const i = (y * width + x) * 4;
  rgba[i] = r;
  rgba[i + 1] = g;
  rgba[i + 2] = b;
  rgba[i + 3] = 255;
  mask[y * width + x] = maskValue;
}

/**
 * Bresenham line — paints contiguous pixels from (x0,y0) to (x1,y1).
 * Out-of-bounds pixels are silently skipped.
 */
export function drawLine(
  rgba: Uint8ClampedArray<ArrayBuffer>,
  mask: Uint8Array<ArrayBuffer>,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: number,
  g: number,
  b: number,
  maskValue: number
): void {
  let x = x0;
  let y = y0;
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    if (x >= 0 && x < width && y >= 0 && y < height) {
      setPixel(rgba, mask, width, x, y, r, g, b, maskValue);
    }
    if (x === x1 && y === y1) return;
    const e2 = err * 2;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const v = hex.startsWith("#") ? hex.slice(1) : hex;
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return { r, g, b };
}
