import type { BoundingBox, ColliderPart, QuatTuple, Vec3Tuple } from "../types";

const EPSILON = 1e-9;

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

export function mean(values: number[]): number {
  if (values.length <= 0) {
    return 0;
  }
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total / values.length;
}

export function length3(value: Vec3Tuple): number {
  return Math.sqrt(value[0] * value[0] + value[1] * value[1] + value[2] * value[2]);
}

export function normalize3(value: Vec3Tuple): Vec3Tuple {
  const len = length3(value);
  if (len <= EPSILON) {
    return [0, 1, 0];
  }
  return [value[0] / len, value[1] / len, value[2] / len];
}

export function dot3(a: Vec3Tuple, b: Vec3Tuple): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross3(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}

export function add3(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub3(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale3(a: Vec3Tuple, scalar: number): Vec3Tuple {
  return [a[0] * scalar, a[1] * scalar, a[2] * scalar];
}

export function bboxFromPoints(points: Vec3Tuple[]): BoundingBox {
  if (points.length <= 0) {
    return {
      min: [0, 0, 0],
      max: [0, 0, 0],
      size: [0, 0, 0],
      center: [0, 0, 0],
      volume: 0
    };
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (const point of points) {
    minX = Math.min(minX, point[0]);
    minY = Math.min(minY, point[1]);
    minZ = Math.min(minZ, point[2]);
    maxX = Math.max(maxX, point[0]);
    maxY = Math.max(maxY, point[1]);
    maxZ = Math.max(maxZ, point[2]);
  }

  const width = Math.max(0, maxX - minX);
  const height = Math.max(0, maxY - minY);
  const depth = Math.max(0, maxZ - minZ);
  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    size: [width, height, depth],
    center: [minX + width * 0.5, minY + height * 0.5, minZ + depth * 0.5],
    volume: Math.max(0, width * height * depth)
  };
}

export function identityQuat(): QuatTuple {
  return [0, 0, 0, 1];
}

export function quatConjugate(quat: QuatTuple): QuatTuple {
  return [-quat[0], -quat[1], -quat[2], quat[3]];
}

export function rotateByQuat(value: Vec3Tuple, quat: QuatTuple): Vec3Tuple {
  const x = value[0];
  const y = value[1];
  const z = value[2];
  const qx = quat[0];
  const qy = quat[1];
  const qz = quat[2];
  const qw = quat[3];

  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;

  return [
    ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx
  ];
}

export function pointInsidePart(
  point: Vec3Tuple,
  part: ColliderPart,
  epsilon = 1e-6
): boolean {
  const relative = sub3(point, part.position);
  const local = rotateByQuat(relative, quatConjugate(part.rotation));
  return (
    Math.abs(local[0]) <= part.halfExtents[0] + epsilon &&
    Math.abs(local[1]) <= part.halfExtents[1] + epsilon &&
    Math.abs(local[2]) <= part.halfExtents[2] + epsilon
  );
}

export function cornersForPart(part: ColliderPart): Vec3Tuple[] {
  const corners: Vec3Tuple[] = [];
  const hx = part.halfExtents[0];
  const hy = part.halfExtents[1];
  const hz = part.halfExtents[2];
  const signs = [-1, 1];
  for (const sx of signs) {
    for (const sy of signs) {
      for (const sz of signs) {
        const local: Vec3Tuple = [sx * hx, sy * hy, sz * hz];
        const rotated = rotateByQuat(local, part.rotation);
        corners.push(add3(rotated, part.position));
      }
    }
  }
  return corners;
}

export function partAabb(part: ColliderPart): BoundingBox {
  return bboxFromPoints(cornersForPart(part));
}

export function makeAxisAlignedPart(
  center: Vec3Tuple,
  halfExtents: Vec3Tuple
): ColliderPart {
  const volume = Math.max(
    0,
    halfExtents[0] * 2 * halfExtents[1] * 2 * halfExtents[2] * 2
  );
  return {
    position: center,
    halfExtents,
    rotation: identityQuat(),
    volume
  };
}

export function inflateHalfExtents(
  halfExtents: Vec3Tuple,
  inflate: number
): Vec3Tuple {
  const value = Math.max(0, inflate);
  return [
    Math.max(1e-4, halfExtents[0] * (1 + value)),
    Math.max(1e-4, halfExtents[1] * (1 + value)),
    Math.max(1e-4, halfExtents[2] * (1 + value))
  ];
}

export function toFixedNumber(value: number, digits = 6): number {
  return Number.parseFloat(value.toFixed(digits));
}

