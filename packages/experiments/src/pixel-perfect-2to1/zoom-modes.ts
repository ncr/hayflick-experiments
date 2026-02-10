export type ZoomMode = "free" | "safe-ladder";
export type DprMode = "native" | "override";

const SAFE_EPSILON = 1e-6;

export function computeSafeZoomLevels(
  activeDpr: number,
  minZoom: number,
  maxZoom: number
): number[] {
  const safeDpr = Math.max(1e-6, activeDpr);
  const out: number[] = [];
  for (let zoom = Math.ceil(minZoom); zoom <= Math.floor(maxZoom); zoom += 1) {
    const devicePixels = zoom * safeDpr;
    if (Math.abs(devicePixels - Math.round(devicePixels)) <= SAFE_EPSILON) {
      out.push(zoom);
    }
  }
  return out;
}

export function nearestZoomLevel(levels: number[], target: number): number {
  if (levels.length === 0) {
    return Math.round(target);
  }
  let best = levels[0];
  let bestDist = Math.abs(best - target);
  for (let i = 1; i < levels.length; i += 1) {
    const candidate = levels[i];
    const dist = Math.abs(candidate - target);
    if (dist < bestDist) {
      best = candidate;
      bestDist = dist;
    }
  }
  return best;
}

export function stepZoomLevel(
  levels: number[],
  current: number,
  direction: -1 | 1
): number {
  if (levels.length === 0) {
    return current;
  }
  const nearest = nearestZoomLevel(levels, current);
  const index = levels.indexOf(nearest);
  const nextIndex = Math.max(0, Math.min(levels.length - 1, index + direction));
  return levels[nextIndex];
}

