import * as THREE from "three";
import type {
  ColliderAxis,
  ColliderBudget,
  RapierCompoundPart,
  Vector3Tuple
} from "../types";

const MIN_EDGE = 0.01;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function tuple(x: number, y: number, z: number): Vector3Tuple {
  return [x, y, z];
}

export function choosePartBudget(diagonal: number, budget: ColliderBudget): number {
  if (budget === "strict") {
    if (diagonal < 0.8) return 4;
    if (diagonal < 2.2) return 6;
    return 8;
  }

  if (diagonal < 0.8) return 5;
  if (diagonal < 2.2) return 8;
  return 12;
}

function partVolume(part: RapierCompoundPart): number {
  return (
    part.halfExtents[0] * 2 * part.halfExtents[1] * 2 * part.halfExtents[2] * 2
  );
}

function mergePartBounds(parts: readonly RapierCompoundPart[]): RapierCompoundPart | null {
  if (parts.length <= 0) {
    return null;
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (const part of parts) {
    const [px, py, pz] = part.position;
    const [hx, hy, hz] = part.halfExtents;

    minX = Math.min(minX, px - hx);
    minY = Math.min(minY, py - hy);
    minZ = Math.min(minZ, pz - hz);
    maxX = Math.max(maxX, px + hx);
    maxY = Math.max(maxY, py + hy);
    maxZ = Math.max(maxZ, pz + hz);
  }

  return {
    kind: "box",
    position: tuple((minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5),
    halfExtents: tuple(
      Math.max(MIN_EDGE * 0.5, (maxX - minX) * 0.5),
      Math.max(MIN_EDGE * 0.5, (maxY - minY) * 0.5),
      Math.max(MIN_EDGE * 0.5, (maxZ - minZ) * 0.5)
    )
  };
}

export function sanitizePart(part: RapierCompoundPart): RapierCompoundPart {
  return {
    kind: "box",
    position: tuple(part.position[0], part.position[1], part.position[2]),
    halfExtents: tuple(
      Math.max(MIN_EDGE * 0.5, part.halfExtents[0]),
      Math.max(MIN_EDGE * 0.5, part.halfExtents[1]),
      Math.max(MIN_EDGE * 0.5, part.halfExtents[2])
    )
  };
}

function isContained(inner: RapierCompoundPart, outer: RapierCompoundPart): boolean {
  const [ix, iy, iz] = inner.position;
  const [ihx, ihy, ihz] = inner.halfExtents;
  const [ox, oy, oz] = outer.position;
  const [ohx, ohy, ohz] = outer.halfExtents;
  const epsilon = 0.002;

  return (
    ix - ihx >= ox - ohx - epsilon &&
    ix + ihx <= ox + ohx + epsilon &&
    iy - ihy >= oy - ohy - epsilon &&
    iy + ihy <= oy + ohy + epsilon &&
    iz - ihz >= oz - ohz - epsilon &&
    iz + ihz <= oz + ohz + epsilon
  );
}

export function limitCompoundParts(
  parts: readonly RapierCompoundPart[],
  maxParts: number
): RapierCompoundPart[] {
  if (parts.length <= 0) {
    return [];
  }

  const sorted = parts.map(sanitizePart).sort((a, b) => partVolume(b) - partVolume(a));
  const filtered: RapierCompoundPart[] = [];

  for (const part of sorted) {
    if (filtered.some((existing) => isContained(part, existing))) {
      continue;
    }
    filtered.push(part);
  }

  if (filtered.length <= maxParts) {
    return filtered;
  }

  const kept = filtered.slice(0, Math.max(1, maxParts - 1));
  const merged = mergePartBounds(filtered.slice(Math.max(1, maxParts - 1)));
  if (merged) {
    kept.push(merged);
  }
  return kept;
}

export function primaryAxisFromSize(size: THREE.Vector3): ColliderAxis {
  if (size.x >= size.y && size.x >= size.z) {
    return "x";
  }
  if (size.y >= size.z) {
    return "y";
  }
  return "z";
}

export function pointCoordByAxis(point: THREE.Vector3, axis: ColliderAxis): number {
  if (axis === "x") return point.x;
  if (axis === "y") return point.y;
  return point.z;
}

export function radialDistanceToAxis(
  point: THREE.Vector3,
  center: THREE.Vector3,
  axis: ColliderAxis
): number {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const dz = point.z - center.z;
  if (axis === "x") {
    return Math.sqrt(dy * dy + dz * dz);
  }
  if (axis === "y") {
    return Math.sqrt(dx * dx + dz * dz);
  }
  return Math.sqrt(dx * dx + dy * dy);
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length <= 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = clamp(Math.floor((sorted.length - 1) * p), 0, sorted.length - 1);
  return sorted[index];
}

export function downsamplePoints(
  points: readonly THREE.Vector3[],
  maxPoints: number
): THREE.Vector3[] {
  if (points.length <= maxPoints) {
    return points.map((point) => point.clone());
  }

  const result: THREE.Vector3[] = [];
  const stride = Math.max(1, Math.ceil(points.length / maxPoints));
  for (let i = 0; i < points.length && result.length < maxPoints; i += stride) {
    result.push(points[i].clone());
  }

  return result;
}

export function getBoundsCorners(bounds: THREE.Box3): THREE.Vector3[] {
  const min = bounds.min;
  const max = bounds.max;
  return [
    new THREE.Vector3(min.x, min.y, min.z),
    new THREE.Vector3(min.x, min.y, max.z),
    new THREE.Vector3(min.x, max.y, min.z),
    new THREE.Vector3(min.x, max.y, max.z),
    new THREE.Vector3(max.x, min.y, min.z),
    new THREE.Vector3(max.x, min.y, max.z),
    new THREE.Vector3(max.x, max.y, min.z),
    new THREE.Vector3(max.x, max.y, max.z)
  ];
}
