/**
 * Pure-CPU rasteriser that turns a UV-meshed submesh into a 3D iso reference
 * image where each UV island gets a flat solid colour.
 *
 * Used as a *second image* fed to the gpt-image-2 edit endpoint alongside
 * the UV template. The colour palette is shared between the template's
 * island outlines and the 3D faces, so the model can map "the cyan region
 * in the unwrap = the +Y face on the mesh" without any natural-language
 * description.
 *
 * Pure data — no DOM, no THREE. Same iso projection constants as
 * `prepare.ts` so this matches what the actual game renderer shows.
 */
import type { DetectedIsland } from "./island-detect";
import type { IslandSpatialContext } from "./spatial-context";
import { projectWorldToIsoScreen } from "./prepare";

export type ReferenceRenderInput = {
  positions: Float32Array;
  indexBuffer: Uint32Array | Uint16Array;
  islands: ReadonlyArray<DetectedIsland>;
  vertexToIslandId: ReadonlyArray<number>;
  spatial: ReadonlyArray<IslandSpatialContext>;
  /** Output canvas size. Square, gpt-image-2 supported. Default 1024². */
  size?: number;
  /** Background colour, 0xRRGGBB. Default same neutral grey as the template. */
  backgroundColor?: number;
  /** Triangle outline colour, 0xRRGGBB. Default near-black for face separation. */
  outlineColor?: number;
};

const DEFAULT_SIZE = 1024;
const DEFAULT_BG = 0x808080;
const DEFAULT_OUTLINE = 0x000000;

export type RgbaBuffer = {
  data: Uint8ClampedArray;
  width: number;
  height: number;
};

export function renderColorCodedReference(input: ReferenceRenderInput): RgbaBuffer {
  const size = input.size ?? DEFAULT_SIZE;
  const bg = input.backgroundColor ?? DEFAULT_BG;
  const outlineCol = input.outlineColor ?? DEFAULT_OUTLINE;

  const data = new Uint8ClampedArray(size * size * 4);
  const bgR = (bg >> 16) & 0xff, bgG = (bg >> 8) & 0xff, bgB = bg & 0xff;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = bgR; data[i + 1] = bgG; data[i + 2] = bgB; data[i + 3] = 255;
  }

  // Project all vertices through the renderer's iso basis (sx, sy in
  // canonical lowpixel space). Depth is "distance along forward" — used for
  // z-rejection so triangles facing away aren't drawn over visible ones.
  // Positions are mesh-local cm; the parent node's uniform 1/128 scale is
  // a constant factor on every coordinate, so depth ordering is preserved.
  const vertexCount = (input.positions.length / 3) | 0;
  const projected = new Float32Array(vertexCount * 3); // sx, sy, depth
  let minSx = Infinity, maxSx = -Infinity, minSy = Infinity, maxSy = -Infinity;
  // Camera-position unit vector for iso 2:1 (yaw=π/4, pitch=π/6). Depth =
  // -dot(P, u) so smaller = closer to camera.
  const ux = (Math.SQRT2 / 2) * (Math.sqrt(3) / 2); // sin(π/4)·cos(π/6)
  const uy = 0.5;                                    // sin(π/6)
  const uz = (Math.SQRT2 / 2) * (Math.sqrt(3) / 2); // cos(π/4)·cos(π/6)
  for (let v = 0; v < vertexCount; v++) {
    const x = input.positions[v * 3];
    const y = input.positions[v * 3 + 1];
    const z = input.positions[v * 3 + 2];
    const { sx, sy } = projectWorldToIsoScreen(x, y, z);
    const depth = -(x * ux + y * uy + z * uz);
    projected[v * 3] = sx;
    projected[v * 3 + 1] = sy;
    projected[v * 3 + 2] = depth;
    if (sx < minSx) minSx = sx;
    if (sx > maxSx) maxSx = sx;
    if (sy < minSy) minSy = sy;
    if (sy > maxSy) maxSy = sy;
  }

  // Fit-to-canvas with 8% padding.
  const pad = 0.08;
  const fitW = (maxSx - minSx) || 1;
  const fitH = (maxSy - minSy) || 1;
  const scale = ((1 - 2 * pad) * size) / Math.max(fitW, fitH);
  const offsX = (size - fitW * scale) / 2 - minSx * scale;
  const offsY = (size - fitH * scale) / 2 - minSy * scale;
  const toCx = (sx: number) => sx * scale + offsX;
  const toCy = (sy: number) => sy * scale + offsY;

  const zbuf = new Float32Array(size * size);
  for (let i = 0; i < zbuf.length; i++) zbuf[i] = Infinity;

  const triCount = Math.floor(input.indexBuffer.length / 3);
  for (let t = 0; t < triCount; t++) {
    const i0 = input.indexBuffer[t * 3];
    const i1 = input.indexBuffer[t * 3 + 1];
    const i2 = input.indexBuffer[t * 3 + 2];
    const islandId = input.vertexToIslandId[i0];
    if (islandId < 0) continue;
    const colorHex = input.spatial[islandId]?.color ?? 0xb8b8b8;
    const r = (colorHex >> 16) & 0xff;
    const g = (colorHex >> 8) & 0xff;
    const b = colorHex & 0xff;

    const x0 = toCx(projected[i0 * 3]);
    const y0 = toCy(projected[i0 * 3 + 1]);
    const z0 = projected[i0 * 3 + 2];
    const x1 = toCx(projected[i1 * 3]);
    const y1 = toCy(projected[i1 * 3 + 1]);
    const z1 = projected[i1 * 3 + 2];
    const x2 = toCx(projected[i2 * 3]);
    const y2 = toCy(projected[i2 * 3 + 1]);
    const z2 = projected[i2 * 3 + 2];

    rasterTriangle(data, zbuf, size, x0, y0, z0, x1, y1, z1, x2, y2, z2, r, g, b);
  }

  // Triangle outlines on top, so faces visually separate even when adjacent
  // islands share similar hues. Drawn from the same z-buffered triangle list
  // so back-facing edges don't bleed onto visible faces.
  const oR = (outlineCol >> 16) & 0xff;
  const oG = (outlineCol >> 8) & 0xff;
  const oB = outlineCol & 0xff;
  for (let t = 0; t < triCount; t++) {
    const i0 = input.indexBuffer[t * 3];
    const i1 = input.indexBuffer[t * 3 + 1];
    const i2 = input.indexBuffer[t * 3 + 2];
    const x0 = toCx(projected[i0 * 3]);
    const y0 = toCy(projected[i0 * 3 + 1]);
    const z0 = projected[i0 * 3 + 2];
    const x1 = toCx(projected[i1 * 3]);
    const y1 = toCy(projected[i1 * 3 + 1]);
    const z1 = projected[i1 * 3 + 2];
    const x2 = toCx(projected[i2 * 3]);
    const y2 = toCy(projected[i2 * 3 + 1]);
    const z2 = projected[i2 * 3 + 2];
    drawZLine(data, zbuf, size, x0, y0, z0, x1, y1, z1, oR, oG, oB);
    drawZLine(data, zbuf, size, x1, y1, z1, x2, y2, z2, oR, oG, oB);
    drawZLine(data, zbuf, size, x2, y2, z2, x0, y0, z0, oR, oG, oB);
  }

  return { data, width: size, height: size };
}

function rasterTriangle(
  data: Uint8ClampedArray,
  zbuf: Float32Array,
  size: number,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  x2: number, y2: number, z2: number,
  r: number, g: number, b: number
): void {
  const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
  const maxX = Math.min(size - 1, Math.ceil(Math.max(x0, x1, x2)));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
  const maxY = Math.min(size - 1, Math.ceil(Math.max(y0, y1, y2)));
  const denom = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
  if (Math.abs(denom) < 1e-9) return;
  const invDen = 1 / denom;
  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      const w0 = ((y1 - y2) * (px - x2) + (x2 - x1) * (py - y2)) * invDen;
      const w1 = ((y2 - y0) * (px - x2) + (x0 - x2) * (py - y2)) * invDen;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const z = w0 * z0 + w1 * z1 + w2 * z2;
      const zi = py * size + px;
      if (z >= zbuf[zi]) continue;
      zbuf[zi] = z;
      const di = zi * 4;
      data[di] = r; data[di + 1] = g; data[di + 2] = b; data[di + 3] = 255;
    }
  }
}

/** Bresenham-ish line that respects the same z-buffer (with a tiny bias so
 *  the line draws on top of its own face's interior pixels). */
function drawZLine(
  data: Uint8ClampedArray,
  zbuf: Float32Array,
  size: number,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  r: number, g: number, b: number
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))) || 1;
  const sx = dx / steps, sy = dy / steps, sz = (z1 - z0) / steps;
  let cx = x0, cy = y0, cz = z0;
  for (let i = 0; i <= steps; i++) {
    const px = Math.round(cx);
    const py = Math.round(cy);
    if (px >= 0 && px < size && py >= 0 && py < size) {
      const zi = py * size + px;
      // Bias so this edge wins ties with its own face.
      if (cz <= zbuf[zi] + 1e-3) {
        const di = zi * 4;
        data[di] = r; data[di + 1] = g; data[di + 2] = b; data[di + 3] = 255;
      }
    }
    cx += sx; cy += sy; cz += sz;
  }
}
