/**
 * Reduce a set of per-island pixel-art buffers to a small shared palette.
 *
 * gpt-image-2 emits per-pixel near-identical colour variation even when
 * the prompt asks for 2–3 flat tones. We k-means the AI output across all
 * islands together (one shared palette so neighbouring faces match) and
 * snap every pixel to its nearest centroid. Deterministic given a seed.
 */
import type { RgbaBuffer } from "./template";

export type QuantizeOptions = {
  /** Number of palette entries. Default 3. */
  k?: number;
  /** Max k-means iterations. Default 20 (converges fast for k≤4). */
  maxIters?: number;
  /** Seed for k-means++ init. Default 1 — deterministic across runs. */
  seed?: number;
};

const DEFAULT_K = 3;
const DEFAULT_ITERS = 20;

/**
 * Quantize all buffers in-place to a single shared palette of `k` colours.
 * Returns the palette (RGB triples) for inspection / debug.
 */
export function quantizeIslandsToSharedPalette(
  buffers: RgbaBuffer[],
  opts: QuantizeOptions = {}
): Array<[number, number, number]> {
  const k = opts.k ?? DEFAULT_K;
  const maxIters = opts.maxIters ?? DEFAULT_ITERS;
  const seed = opts.seed ?? 1;

  const samples: Array<[number, number, number]> = [];
  for (const buf of buffers) {
    const d = buf.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) continue;
      samples.push([d[i], d[i + 1], d[i + 2]]);
    }
  }
  if (samples.length === 0) return [];
  if (samples.length <= k) {
    // Trivial: every sample is its own palette entry.
    const palette = samples.slice();
    while (palette.length < k) palette.push(samples[0]);
    return palette;
  }

  const centroids = kmeansPlusPlusInit(samples, k, seed);
  const assignments = new Uint32Array(samples.length);

  for (let iter = 0; iter < maxIters; iter++) {
    let moved = 0;
    for (let i = 0; i < samples.length; i++) {
      const a = nearestCentroid(samples[i], centroids);
      if (a !== assignments[i]) {
        assignments[i] = a;
        moved++;
      }
    }
    if (moved === 0 && iter > 0) break;

    const sums = Array.from({ length: k }, () => [0, 0, 0, 0] as [number, number, number, number]);
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const a = assignments[i];
      sums[a][0] += s[0];
      sums[a][1] += s[1];
      sums[a][2] += s[2];
      sums[a][3] += 1;
    }
    for (let c = 0; c < k; c++) {
      const [r, g, b, n] = sums[c];
      if (n === 0) continue;
      centroids[c] = [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    }
  }

  for (const buf of buffers) {
    const d = buf.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) continue;
      const c = nearestCentroid([d[i], d[i + 1], d[i + 2]], centroids);
      d[i] = centroids[c][0];
      d[i + 1] = centroids[c][1];
      d[i + 2] = centroids[c][2];
    }
  }

  return centroids;
}

function nearestCentroid(s: [number, number, number], cs: Array<[number, number, number]>): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < cs.length; i++) {
    const dr = s[0] - cs[i][0];
    const dg = s[1] - cs[i][1];
    const db = s[2] - cs[i][2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function kmeansPlusPlusInit(
  samples: Array<[number, number, number]>,
  k: number,
  seed: number
): Array<[number, number, number]> {
  const rng = mulberry32(seed);
  const centroids: Array<[number, number, number]> = [];
  centroids.push(samples[Math.floor(rng() * samples.length)]);
  while (centroids.length < k) {
    const dists = new Float64Array(samples.length);
    let total = 0;
    for (let i = 0; i < samples.length; i++) {
      const c = nearestCentroid(samples[i], centroids);
      const dr = samples[i][0] - centroids[c][0];
      const dg = samples[i][1] - centroids[c][1];
      const db = samples[i][2] - centroids[c][2];
      const d2 = dr * dr + dg * dg + db * db;
      dists[i] = d2;
      total += d2;
    }
    if (total === 0) {
      centroids.push(samples[Math.floor(rng() * samples.length)]);
      continue;
    }
    let target = rng() * total;
    let pick = 0;
    for (let i = 0; i < samples.length; i++) {
      target -= dists[i];
      if (target <= 0) {
        pick = i;
        break;
      }
    }
    centroids.push(samples[pick]);
  }
  return centroids;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
