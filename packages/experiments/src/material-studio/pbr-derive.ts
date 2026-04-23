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

/** Derive both normal and ARM maps from a baseColor ImageData. */
export function derivePbrMaps(src: ImageData, params: PbrParams): GeneratedMaps {
  return {
    baseColor: src,
    normal: deriveNormalMap(src, params.strength),
    arm: deriveArmMap(src, params)
  };
}
