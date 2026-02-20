import type {
  ColliderPart,
  NormalizedProp,
  QualityBreakdown,
  QualityWeights
} from "../types";
import { clamp01, partAabb, pointInsidePart } from "./math";
import { buildVoxelGridFromPoints, voxelCenter, voxelIndex } from "./voxel";

function underfillRatio(prop: NormalizedProp, parts: ColliderPart[]): number {
  if (prop.points.length <= 0) {
    return 1;
  }

  let outside = 0;
  for (const point of prop.points) {
    let contained = false;
    for (const part of parts) {
      if (pointInsidePart(point, part)) {
        contained = true;
        break;
      }
    }
    if (!contained) {
      outside += 1;
    }
  }

  return outside / prop.points.length;
}

function overfillRatio(prop: NormalizedProp, parts: ColliderPart[]): number {
  if (parts.length <= 0) {
    return 1;
  }

  const grid = buildVoxelGridFromPoints(prop.points, prop.bbox, 24, 1);
  const r = grid.resolution;

  let colliderCovered = 0;
  let colliderCoveredEmpty = 0;

  for (let z = 0; z < r; z += 1) {
    for (let y = 0; y < r; y += 1) {
      for (let x = 0; x < r; x += 1) {
        const center = voxelCenter(grid, x, y, z);
        let inside = false;
        for (const part of parts) {
          if (pointInsidePart(center, part, 1e-5)) {
            inside = true;
            break;
          }
        }
        if (!inside) {
          continue;
        }
        colliderCovered += 1;
        if (grid.occupied[voxelIndex(r, x, y, z)] === 0) {
          colliderCoveredEmpty += 1;
        }
      }
    }
  }

  if (colliderCovered <= 0) {
    return 1;
  }
  const voxelOverfill = colliderCoveredEmpty / colliderCovered;

  const colliderVolume = parts.reduce((total, part) => total + part.volume, 0);
  const propVolume = Math.max(1e-6, prop.bbox.volume);
  const ratioOverOne = Math.max(0, colliderVolume / propVolume - 1);
  const volumeOverfill = clamp01(ratioOverOne);
  return clamp01(voxelOverfill * 0.55 + volumeOverfill * 0.45);
}

function thinPartPenalty(parts: ColliderPart[]): number {
  if (parts.length <= 0) {
    return 1;
  }
  const totalVolume = Math.max(
    1e-6,
    parts.reduce((total, part) => total + part.volume, 0)
  );

  let penalty = 0;
  for (const part of parts) {
    const x = part.halfExtents[0] * 2;
    const y = part.halfExtents[1] * 2;
    const z = part.halfExtents[2] * 2;
    const maxEdge = Math.max(x, y, z, 1e-6);
    const minEdge = Math.max(1e-6, Math.min(x, y, z));
    const aspect = minEdge / maxEdge;
    const thinness = clamp01((0.16 - aspect) / 0.16);
    penalty += thinness * (part.volume / totalVolume);
  }
  return clamp01(penalty);
}

function primitiveCountPenalty(parts: ColliderPart[]): number {
  const preferredCount = 6;
  const overflow = Math.max(0, parts.length - preferredCount);
  if (overflow <= 0) {
    return 0;
  }
  return clamp01((overflow * overflow) / (preferredCount * preferredCount));
}

function flatBaseBonus(prop: NormalizedProp, parts: ColliderPart[]): number {
  if (parts.length <= 0) {
    return 0;
  }

  const propFootprint = Math.max(1e-6, prop.bbox.size[0] * prop.bbox.size[2]);
  let supportArea = 0;
  for (const part of parts) {
    const bounds = partAabb(part);
    if (bounds.min[1] > prop.bbox.min[1] + 0.02) {
      continue;
    }
    supportArea += Math.max(0, bounds.size[0] * bounds.size[2]);
  }
  return clamp01(supportArea / propFootprint);
}

export function scoreColliderQuality(
  prop: NormalizedProp,
  parts: ColliderPart[],
  weights: QualityWeights
): QualityBreakdown {
  if (parts.length <= 0) {
    return {
      underfill: 1,
      overfill: 1,
      thinPenalty: 1,
      partPenalty: 1,
      flatBaseBonus: 0,
      finalScore: 1
    };
  }

  const underfill = underfillRatio(prop, parts);
  const overfill = overfillRatio(prop, parts);
  const thinPenalty = thinPartPenalty(parts);
  const partPenalty = primitiveCountPenalty(parts);
  const baseBonus = flatBaseBonus(prop, parts);

  const rawScore =
    weights.underfill * underfill +
    weights.overfill * overfill +
    weights.thinPenalty * thinPenalty +
    weights.partPenalty * partPenalty -
    weights.flatBaseBonus * baseBonus;

  return {
    underfill,
    overfill,
    thinPenalty,
    partPenalty,
    flatBaseBonus: baseBonus,
    finalScore: Math.max(0, rawScore)
  };
}
