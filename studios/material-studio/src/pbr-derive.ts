/**
 * In-browser PBR map derivation from a pixel-art baseColor texture.
 *
 * Port of scripts/blockstudio/generate-pbr-from-diffuse.py — same Sobel
 * math, same per-channel RGB gradient averaging, same OpenGL normal
 * convention (R=+X right, G=+Y up, B=+Z out; flat = 128,128,255).
 */

import type { PbrParams, GeneratedMaps } from "./types";

// ---------------------------------------------------------------------------
// Sobel gradients — wrapping edges for seamless tiling
// ---------------------------------------------------------------------------

/**
 * Sobel X and Y gradients for a single channel.
 * Uses modular index arithmetic for tiling (matches numpy's np.roll).
 */
function sobel2d(
  ch: Float32Array, W: number, H: number
): { gx: Float32Array; gy: Float32Array } {
  const N = W * H;
  const gx = new Float32Array(N);
  const gy = new Float32Array(N);

  for (let y = 0; y < H; y++) {
    const yP = ((y - 1 + H) % H) * W; // row above (np.roll(ch, 1, axis=0))
    const y0 = y * W;                   // current row
    const yN = ((y + 1) % H) * W;       // row below (np.roll(ch, -1, axis=0))

    for (let x = 0; x < W; x++) {
      const xP = (x - 1 + W) % W; // col left
      const xN = (x + 1) % W;     // col right

      // Sobel X gradient
      gx[y0 + x] =
        -1.0 * ch[yP + xP] +  1.0 * ch[yP + xN] +
        -2.0 * ch[y0 + xP] +  2.0 * ch[y0 + xN] +
        -1.0 * ch[yN + xP] +  1.0 * ch[yN + xN];

      // Sobel Y gradient
      gy[y0 + x] =
        -1.0 * ch[yP + xP] + -2.0 * ch[yP + x] + -1.0 * ch[yP + xN] +
         1.0 * ch[yN + xP] +  2.0 * ch[yN + x] +  1.0 * ch[yN + xN];
    }
  }

  return { gx, gy };
}

/**
 * Per-channel RGB Sobel gradients, averaged across channels.
 * Catches colour edges even when luminance is similar.
 */
export function sobelGradientsRGB(
  pixels: Uint8ClampedArray, W: number, H: number
): { gx: Float32Array; gy: Float32Array } {
  const N = W * H;
  const gxSum = new Float32Array(N);
  const gySum = new Float32Array(N);

  // Extract each channel as float [0,1] and run Sobel
  const ch = new Float32Array(N);
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < N; i++) ch[i] = pixels[i * 4 + c] / 255;
    const { gx, gy } = sobel2d(ch, W, H);
    for (let i = 0; i < N; i++) {
      gxSum[i] += gx[i];
      gySum[i] += gy[i];
    }
  }

  // Average across 3 channels
  for (let i = 0; i < N; i++) {
    gxSum[i] /= 3;
    gySum[i] /= 3;
  }

  return { gx: gxSum, gy: gySum };
}

// ---------------------------------------------------------------------------
// Normal map
// ---------------------------------------------------------------------------

/**
 * Derive an OpenGL tangent-space normal map from an RGBA ImageData.
 * Uses per-channel Sobel so colour edges produce bumps.
 */
export function deriveNormalMap(src: ImageData, strength: number): ImageData {
  const W = src.width;
  const H = src.height;
  const N = W * H;
  const { gx, gy } = sobelGradientsRGB(src.data, W, H);

  const out = new ImageData(W, H);
  const d = out.data;

  for (let i = 0; i < N; i++) {
    // Scale by strength
    const sx = gx[i] * strength;
    const sy = gy[i] * strength;

    // Normal: (-dh/dx, +dh/dy flipped for OpenGL, 1), normalized
    let nx = -sx;
    let ny = sy; // flip: image Y down → normal Y up
    let nz = 1.0;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    nx /= len;
    ny /= len;
    nz /= len;

    // Encode [−1,1] → [0,255]
    const o = i * 4;
    d[o    ] = Math.round(Math.min(255, Math.max(0, (nx * 0.5 + 0.5) * 255)));
    d[o + 1] = Math.round(Math.min(255, Math.max(0, (ny * 0.5 + 0.5) * 255)));
    d[o + 2] = Math.round(Math.min(255, Math.max(0, (nz * 0.5 + 0.5) * 255)));
    d[o + 3] = 255;
  }

  return out;
}

// ---------------------------------------------------------------------------
// ARM map (AO, Roughness, Metalness)
// ---------------------------------------------------------------------------

/**
 * Derive an ARM map from an RGBA ImageData.
 * R = AO (edge-darken), G = Roughness (luminance-based), B = Metalness (0).
 */
export function deriveArmMap(
  src: ImageData,
  params: Pick<PbrParams, "baseRoughness" | "roughnessRange" | "aoFloor" | "aoMultiplier">
): ImageData {
  const W = src.width;
  const H = src.height;
  const N = W * H;
  const { gx, gy } = sobelGradientsRGB(src.data, W, H);
  const px = src.data;

  const out = new ImageData(W, H);
  const d = out.data;

  for (let i = 0; i < N; i++) {
    // AO: gentle darkening at edges
    const edgeMag = Math.sqrt(gx[i] * gx[i] + gy[i] * gy[i]);
    const ao = Math.min(1.0, Math.max(params.aoFloor, 1.0 - edgeMag * params.aoMultiplier));

    // Roughness: darker → rougher
    const r = px[i * 4] / 255;
    const g = px[i * 4 + 1] / 255;
    const b = px[i * 4 + 2] / 255;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const roughness = Math.min(1.0, Math.max(0.0,
      params.baseRoughness + (1.0 - lum) * params.roughnessRange));

    // Metalness: 0 for natural materials
    const o = i * 4;
    d[o    ] = Math.round(ao * 255);
    d[o + 1] = Math.round(roughness * 255);
    d[o + 2] = 0;
    d[o + 3] = 255;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Combined derivation
// ---------------------------------------------------------------------------

/**
 * Maximum side length used for normal/ARM derivation. UV-template atlases
 * arrive at 1024² (or larger), but the Sobel kernel cost scales with pixel
 * count — running it at full atlas resolution blocks the main thread for
 * hundreds of ms per generation. Pixel-art content has no detail beyond
 * what the atlas's cell grid can express, so a 256² nearest-neighbour
 * downsample preserves all real edges and lets the GPU's bilinear filter
 * upscale the maps back at sample time. baseColor itself stays full-res.
 */
const PBR_DERIVE_MAX_SIDE = 256;

/** Derive both normal and ARM maps from a baseColor ImageData. */
export function derivePbrMaps(src: ImageData, params: PbrParams): GeneratedMaps {
  const work = src.width > PBR_DERIVE_MAX_SIDE || src.height > PBR_DERIVE_MAX_SIDE
    ? downsampleImageDataNearest(src, PBR_DERIVE_MAX_SIDE)
    : src;
  const W = work.width;
  const H = work.height;
  const N = W * H;
  // Sobel is the dominant cost — compute once and reuse for both maps
  // (deriveNormalMap / deriveArmMap each independently recomputed it).
  const { gx, gy } = sobelGradientsRGB(work.data, W, H);

  const normal = new ImageData(W, H);
  const nd = normal.data;
  for (let i = 0; i < N; i++) {
    const sx = gx[i] * params.strength;
    const sy = gy[i] * params.strength;
    let nx = -sx;
    let ny = sy;
    let nz = 1.0;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    nx /= len; ny /= len; nz /= len;
    const o = i * 4;
    nd[o]     = Math.round(Math.min(255, Math.max(0, (nx * 0.5 + 0.5) * 255)));
    nd[o + 1] = Math.round(Math.min(255, Math.max(0, (ny * 0.5 + 0.5) * 255)));
    nd[o + 2] = Math.round(Math.min(255, Math.max(0, (nz * 0.5 + 0.5) * 255)));
    nd[o + 3] = 255;
  }

  const arm = new ImageData(W, H);
  const ad = arm.data;
  const wd = work.data;
  for (let i = 0; i < N; i++) {
    const edgeMag = Math.sqrt(gx[i] * gx[i] + gy[i] * gy[i]);
    const ao = Math.min(1.0, Math.max(params.aoFloor, 1.0 - edgeMag * params.aoMultiplier));
    const r = wd[i * 4] / 255;
    const g = wd[i * 4 + 1] / 255;
    const b = wd[i * 4 + 2] / 255;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const roughness = Math.min(
      1.0,
      Math.max(0.0, params.baseRoughness + (1.0 - lum) * params.roughnessRange)
    );
    const o = i * 4;
    ad[o]     = Math.round(ao * 255);
    ad[o + 1] = Math.round(roughness * 255);
    ad[o + 2] = 0;
    ad[o + 3] = 255;
  }

  return { baseColor: src, normal, arm };
}

/**
 * Nearest-neighbour ImageData downsample. Pixel art is blocky by construction,
 * so picking one sample per N×N block preserves edge contrast — exactly what
 * the Sobel pass cares about. Pure data, no DOM.
 */
function downsampleImageDataNearest(src: ImageData, maxSide: number): ImageData {
  const sw = src.width;
  const sh = src.height;
  const long = Math.max(sw, sh);
  if (long <= maxSide) return src;
  const scale = long / maxSide;
  const tW = Math.max(1, Math.round(sw / scale));
  const tH = Math.max(1, Math.round(sh / scale));
  const out = new ImageData(tW, tH);
  const od = out.data;
  const sd = src.data;
  const ratioX = sw / tW;
  const ratioY = sh / tH;
  for (let y = 0; y < tH; y++) {
    const sy = Math.min(sh - 1, Math.floor((y + 0.5) * ratioY));
    for (let x = 0; x < tW; x++) {
      const sx = Math.min(sw - 1, Math.floor((x + 0.5) * ratioX));
      const si = (sy * sw + sx) * 4;
      const oi = (y * tW + x) * 4;
      od[oi]     = sd[si];
      od[oi + 1] = sd[si + 1];
      od[oi + 2] = sd[si + 2];
      od[oi + 3] = sd[si + 3];
    }
  }
  return out;
}
