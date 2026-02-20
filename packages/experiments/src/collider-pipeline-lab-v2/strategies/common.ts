import type { ColliderPart, Vec3Tuple } from "../types";
import {
  bboxFromPoints,
  inflateHalfExtents,
  makeAxisAlignedPart,
  partAabb,
  sub3
} from "../pipeline/math";

export function partVolume(halfExtents: Vec3Tuple): number {
  return Math.max(0, halfExtents[0] * 2 * halfExtents[1] * 2 * halfExtents[2] * 2);
}

export function axisAlignedPartFromBounds(
  min: Vec3Tuple,
  max: Vec3Tuple,
  inflate: number
): ColliderPart {
  const halfExtents: Vec3Tuple = [
    Math.max(1e-4, (max[0] - min[0]) * 0.5),
    Math.max(1e-4, (max[1] - min[1]) * 0.5),
    Math.max(1e-4, (max[2] - min[2]) * 0.5)
  ];
  const center: Vec3Tuple = [
    (min[0] + max[0]) * 0.5,
    (min[1] + max[1]) * 0.5,
    (min[2] + max[2]) * 0.5
  ];

  const inflatedHalf = inflateHalfExtents(halfExtents, inflate);
  const part = makeAxisAlignedPart(center, inflatedHalf);
  part.volume = partVolume(part.halfExtents);
  return part;
}

export function sanitizeParts(parts: ColliderPart[]): ColliderPart[] {
  const result: ColliderPart[] = [];
  for (const part of parts) {
    if (
      part.halfExtents[0] <= 0 ||
      part.halfExtents[1] <= 0 ||
      part.halfExtents[2] <= 0
    ) {
      continue;
    }
    result.push({
      ...part,
      volume: partVolume(part.halfExtents)
    });
  }
  return result;
}

function axisAlignedBoundsForPart(part: ColliderPart): {
  min: Vec3Tuple;
  max: Vec3Tuple;
} {
  const bounds = partAabb(part);
  return { min: bounds.min, max: bounds.max };
}

function distanceSquared(a: Vec3Tuple, b: Vec3Tuple): number {
  const d = sub3(a, b);
  return d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
}

function mergeBounds(
  a: { min: Vec3Tuple; max: Vec3Tuple },
  b: { min: Vec3Tuple; max: Vec3Tuple }
): { min: Vec3Tuple; max: Vec3Tuple } {
  return {
    min: [
      Math.min(a.min[0], b.min[0]),
      Math.min(a.min[1], b.min[1]),
      Math.min(a.min[2], b.min[2])
    ],
    max: [
      Math.max(a.max[0], b.max[0]),
      Math.max(a.max[1], b.max[1]),
      Math.max(a.max[2], b.max[2])
    ]
  };
}

export function compactPartCount(parts: ColliderPart[], maxParts: number): ColliderPart[] {
  if (parts.length <= maxParts) {
    return sanitizeParts(parts);
  }

  const safeMax = Math.max(1, Math.floor(maxParts));
  const sorted = [...parts].sort((a, b) => b.volume - a.volume);
  const kept = sorted.slice(0, safeMax).map((part) => ({ ...part }));
  const extras = sorted.slice(safeMax);

  for (const extra of extras) {
    const extraBounds = axisAlignedBoundsForPart(extra);
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < kept.length; i += 1) {
      const distance = distanceSquared(kept[i].position, extra.position);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }

    const targetBounds = axisAlignedBoundsForPart(kept[bestIndex]);
    const merged = mergeBounds(targetBounds, extraBounds);
    kept[bestIndex] = axisAlignedPartFromBounds(merged.min, merged.max, 0);
  }

  return sanitizeParts(kept);
}

export function boundsFromPartSet(parts: ColliderPart[]): {
  min: Vec3Tuple;
  max: Vec3Tuple;
} {
  if (parts.length <= 0) {
    return {
      min: [0, 0, 0],
      max: [0, 0, 0]
    };
  }
  const corners: Vec3Tuple[] = [];
  for (const part of parts) {
    const bounds = partAabb(part);
    corners.push(bounds.min, bounds.max);
  }
  const bounds = bboxFromPoints(corners);
  return { min: bounds.min, max: bounds.max };
}

