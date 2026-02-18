import * as THREE from "three";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";
import { classifyMetrics } from "./classify";
import { evaluateColliderError } from "./error-metric";
import { computeMetrics } from "./metrics";
import { collectRootLocalGeometry, preprocessGeometry } from "./preprocess";
import { generateBoxyFurnitureStrategy } from "./strategies/boxy-furniture";
import { tuple } from "./strategies/common";
import { generateConcaveFurnitureStrategy } from "./strategies/concave-furniture";
import { generateHardNoisyStrategy } from "./strategies/hard-noisy";
import { generatePrimitiveStrategy } from "./strategies/primitive";
import { generateSingleConvexStrategy } from "./strategies/single-convex";
import type {
  ColliderErrorMetrics,
  ColliderResult,
  ColliderStrategyKind,
  GenerateColliderOptions,
  PreparedGeometry,
  RapierCompoundPart,
  RapierColliderDescription,
  StrategyContext,
  StrategyResult,
  Vector3Tuple
} from "./types";

function withDefaults(options?: GenerateColliderOptions): Required<GenerateColliderOptions> {
  return {
    mode: options?.mode ?? "dynamic",
    budget: options?.budget ?? "strict",
    allowStaticTrimeshFallback: options?.allowStaticTrimeshFallback ?? false,
    debug: options?.debug ?? false
  };
}

function partCountForCollider(collider: RapierColliderDescription): number {
  if (collider.type === "compound") {
    return collider.parts.length;
  }
  return 1;
}

function maxAllowedOutsideRatio(options: Required<GenerateColliderOptions>): number {
  if (options.mode === "dynamic") {
    return options.budget === "strict" ? 0.08 : 0.11;
  }
  return options.budget === "strict" ? 0.11 : 0.15;
}

function strategyByKind(kind: ColliderStrategyKind, context: StrategyContext): StrategyResult {
  if (kind === "primitive") {
    return generatePrimitiveStrategy(context);
  }
  if (kind === "single-convex") {
    return generateSingleConvexStrategy(context);
  }
  if (kind === "boxy-furniture") {
    return generateBoxyFurnitureStrategy(context);
  }
  if (kind === "concave-furniture") {
    return generateConcaveFurnitureStrategy(context);
  }
  return generateHardNoisyStrategy(context);
}

function scoreCandidate(
  collider: RapierColliderDescription,
  error: ColliderErrorMetrics
): number {
  const partPenalty = collider.type === "compound" ? Math.max(0, collider.parts.length - 8) * 0.012 : 0;
  return (
    error.outsideRatio +
    error.meanOutsideDistance * 0.32 +
    error.overfillRatio * 0.38 +
    partPenalty
  );
}

function mergeCompoundParts(
  parts: readonly {
    kind: "box";
    position: Vector3Tuple;
    halfExtents: Vector3Tuple;
  }[]
): {
  kind: "box";
  position: Vector3Tuple;
  halfExtents: Vector3Tuple;
} | null {
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

  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) {
    return null;
  }

  return {
    kind: "box",
    position: tuple((minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5),
    halfExtents: tuple(
      Math.max(0.005, (maxX - minX) * 0.5),
      Math.max(0.005, (maxY - minY) * 0.5),
      Math.max(0.005, (maxZ - minZ) * 0.5)
    )
  };
}

function axisCoord(point: Vector3Tuple, axis: "x" | "z"): number {
  return axis === "x" ? point[0] : point[2];
}

function axisHalf(halfExtents: Vector3Tuple, axis: "x" | "z"): number {
  return axis === "x" ? halfExtents[0] : halfExtents[2];
}

function splitByHorizontalAxis(
  parts: readonly {
    kind: "box";
    position: Vector3Tuple;
    halfExtents: Vector3Tuple;
  }[],
  axis: "x" | "z"
): {
  left: Array<{
    kind: "box";
    position: Vector3Tuple;
    halfExtents: Vector3Tuple;
  }>;
  right: Array<{
    kind: "box";
    position: Vector3Tuple;
    halfExtents: Vector3Tuple;
  }>;
} | null {
  if (parts.length < 2) {
    return null;
  }

  const sorted = [...parts].sort(
    (a, b) => axisCoord(a.position, axis) - axisCoord(b.position, axis)
  );
  const median = axisCoord(sorted[Math.floor(sorted.length * 0.5)].position, axis);

  const left: Array<{
    kind: "box";
    position: Vector3Tuple;
    halfExtents: Vector3Tuple;
  }> = [];
  const right: Array<{
    kind: "box";
    position: Vector3Tuple;
    halfExtents: Vector3Tuple;
  }> = [];

  for (const part of sorted) {
    if (axisCoord(part.position, axis) <= median) {
      left.push(part);
    } else {
      right.push(part);
    }
  }

  if (left.length > 0 && right.length > 0) {
    return { left, right };
  }

  const fallbackLeft = sorted.slice(0, Math.floor(sorted.length * 0.5));
  const fallbackRight = sorted.slice(Math.floor(sorted.length * 0.5));
  if (fallbackLeft.length <= 0 || fallbackRight.length <= 0) {
    return null;
  }

  return { left: fallbackLeft, right: fallbackRight };
}

function buildPartFromPoints(
  points: readonly THREE.Vector3[],
  maxYCap?: number
): RapierCompoundPart | null {
  if (points.length <= 0) {
    return null;
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (const point of points) {
    const y = maxYCap === undefined ? point.y : Math.min(point.y, maxYCap);
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, point.z);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, point.z);
  }

  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(maxX) ||
    maxX <= minX ||
    maxY <= minY ||
    maxZ <= minZ
  ) {
    return null;
  }

  return {
    kind: "box",
    position: tuple((minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5),
    halfExtents: tuple(
      Math.max(0.005, (maxX - minX) * 0.5),
      Math.max(0.005, (maxY - minY) * 0.5),
      Math.max(0.005, (maxZ - minZ) * 0.5)
    )
  };
}

function buildDeskThreePartFromPrepared(prepared: PreparedGeometry): RapierCompoundPart[] | null {
  const points = prepared.points.length > 0 ? prepared.points : prepared.samples;
  if (points.length < 60) {
    return null;
  }

  const bounds = prepared.bounds;
  const size = prepared.size;
  if (size.x <= 1e-5 || size.y <= 1e-5 || size.z <= 1e-5) {
    return null;
  }

  const bins = 36;
  const counts = new Array<number>(bins).fill(0);
  const minX = new Array<number>(bins).fill(Number.POSITIVE_INFINITY);
  const maxX = new Array<number>(bins).fill(Number.NEGATIVE_INFINITY);
  const minZ = new Array<number>(bins).fill(Number.POSITIVE_INFINITY);
  const maxZ = new Array<number>(bins).fill(Number.NEGATIVE_INFINITY);

  for (const point of points) {
    const normalized = Math.min(
      0.999999,
      Math.max(0, (point.y - bounds.min.y) / Math.max(1e-5, size.y))
    );
    const bin = Math.floor(normalized * bins);
    counts[bin] += 1;
    minX[bin] = Math.min(minX[bin], point.x);
    maxX[bin] = Math.max(maxX[bin], point.x);
    minZ[bin] = Math.min(minZ[bin], point.z);
    maxZ[bin] = Math.max(maxZ[bin], point.z);
  }

  const minCount = Math.max(4, Math.floor(points.length * 0.002));
  const footprintTotal = Math.max(1e-5, size.x * size.z);
  const footprint = new Array<number>(bins).fill(0);
  for (let i = 0; i < bins; i += 1) {
    if (counts[i] < minCount || !Number.isFinite(minX[i]) || !Number.isFinite(maxX[i])) {
      continue;
    }
    const area = Math.max(0, (maxX[i] - minX[i]) * (maxZ[i] - minZ[i]));
    footprint[i] = Math.min(1, Math.max(0, area / footprintTotal));
  }

  const smooth = footprint.map((_, i) => {
    const lo = Math.max(0, i - 1);
    const hi = Math.min(bins - 1, i + 1);
    let sum = 0;
    let count = 0;
    for (let j = lo; j <= hi; j += 1) {
      sum += footprint[j];
      count += 1;
    }
    return count > 0 ? sum / count : 0;
  });

  let topBin = bins - 1;
  while (topBin > 0 && counts[topBin] < minCount) {
    topBin -= 1;
  }
  if (topBin < Math.floor(bins * 0.4)) {
    return null;
  }

  let cutBin = -1;
  for (let i = topBin - 1; i >= Math.floor(bins * 0.15); i -= 1) {
    if (smooth[i + 1] >= 0.64 && smooth[i] <= 0.5) {
      cutBin = i;
      break;
    }
  }
  if (cutBin < 0) {
    cutBin = Math.floor(bins * 0.72);
  }

  const topSurfaceY = bounds.max.y;
  const topBottomY = bounds.min.y + ((cutBin + 1) / bins) * size.y;
  const topThickness = topSurfaceY - topBottomY;
  if (topThickness < Math.max(0.012, size.y * 0.02) || topThickness > size.y * 0.55) {
    return null;
  }

  const topPoints = points.filter((point) => point.y >= topBottomY - size.y * 0.02);
  const topPart = buildPartFromPoints(topPoints);
  if (!topPart) {
    return null;
  }
  topPart.position = tuple(topPart.position[0], (topSurfaceY + topBottomY) * 0.5, topPart.position[2]);
  topPart.halfExtents = tuple(topPart.halfExtents[0], Math.max(0.005, topThickness * 0.5), topPart.halfExtents[2]);

  const lowerPoints = points.filter((point) => point.y <= topBottomY + size.y * 0.03);
  if (lowerPoints.length < minCount * 2) {
    return null;
  }

  let minLowerX = Number.POSITIVE_INFINITY;
  let maxLowerX = Number.NEGATIVE_INFINITY;
  let minLowerZ = Number.POSITIVE_INFINITY;
  let maxLowerZ = Number.NEGATIVE_INFINITY;
  for (const point of lowerPoints) {
    minLowerX = Math.min(minLowerX, point.x);
    maxLowerX = Math.max(maxLowerX, point.x);
    minLowerZ = Math.min(minLowerZ, point.z);
    maxLowerZ = Math.max(maxLowerZ, point.z);
  }
  const spreadX = Math.max(0, maxLowerX - minLowerX);
  const spreadZ = Math.max(0, maxLowerZ - minLowerZ);
  const axis: "x" | "z" = spreadX >= spreadZ ? "x" : "z";

  const sortedValues = lowerPoints
    .map((point) => (axis === "x" ? point.x : point.z))
    .sort((a, b) => a - b);
  const median = sortedValues[Math.floor(sortedValues.length * 0.5)];

  let leftPoints = lowerPoints.filter((point) =>
    axis === "x" ? point.x <= median : point.z <= median
  );
  let rightPoints = lowerPoints.filter((point) =>
    axis === "x" ? point.x > median : point.z > median
  );
  if (leftPoints.length < minCount || rightPoints.length < minCount) {
    const sorted = [...lowerPoints].sort((a, b) =>
      axis === "x" ? a.x - b.x : a.z - b.z
    );
    const half = Math.max(1, Math.floor(sorted.length * 0.5));
    leftPoints = sorted.slice(0, half);
    rightPoints = sorted.slice(half);
    if (leftPoints.length < 2 || rightPoints.length < 2) {
      return null;
    }
  }

  const leftPart = buildPartFromPoints(leftPoints, topBottomY);
  const rightPart = buildPartFromPoints(rightPoints, topBottomY);
  if (!leftPart || !rightPart) {
    return null;
  }

  const ordered =
    axisCoord(leftPart.position, axis) <= axisCoord(rightPart.position, axis)
      ? { left: leftPart, right: rightPart }
      : { left: rightPart, right: leftPart };

  const sideSize = axis === "x" ? size.x : size.z;
  const supportGap =
    Math.abs(axisCoord(ordered.right.position, axis) - axisCoord(ordered.left.position, axis)) -
    (axisHalf(ordered.left.halfExtents, axis) + axisHalf(ordered.right.halfExtents, axis));
  if (supportGap < Math.max(0.02, sideSize * 0.04)) {
    return null;
  }

  const supportHeight = Math.min(ordered.left.halfExtents[1], ordered.right.halfExtents[1]) * 2;
  if (supportHeight < size.y * 0.24) {
    return null;
  }

  return [topPart, ordered.left, ordered.right];
}

function buildDeskThreePartSimpleFallback(prepared: PreparedGeometry): RapierCompoundPart[] | null {
  const points = prepared.points.length > 0 ? prepared.points : prepared.samples;
  if (points.length < 24) {
    return null;
  }

  const bounds = prepared.bounds;
  const size = prepared.size;
  if (size.x <= 1e-5 || size.y <= 1e-5 || size.z <= 1e-5) {
    return null;
  }

  const topBottomY = bounds.min.y + size.y * 0.72;
  const topPoints = points.filter((point) => point.y >= topBottomY);
  const lowerPoints = points.filter((point) => point.y < topBottomY);
  if (topPoints.length < 8 || lowerPoints.length < 16) {
    return null;
  }

  const top = buildPartFromPoints(topPoints);
  if (!top) {
    return null;
  }

  let minLowerX = Number.POSITIVE_INFINITY;
  let maxLowerX = Number.NEGATIVE_INFINITY;
  let minLowerZ = Number.POSITIVE_INFINITY;
  let maxLowerZ = Number.NEGATIVE_INFINITY;
  for (const point of lowerPoints) {
    minLowerX = Math.min(minLowerX, point.x);
    maxLowerX = Math.max(maxLowerX, point.x);
    minLowerZ = Math.min(minLowerZ, point.z);
    maxLowerZ = Math.max(maxLowerZ, point.z);
  }
  const axis: "x" | "z" =
    maxLowerX - minLowerX >= maxLowerZ - minLowerZ ? "x" : "z";
  const sorted = [...lowerPoints].sort((a, b) => (axis === "x" ? a.x - b.x : a.z - b.z));
  const half = Math.floor(sorted.length * 0.5);
  if (half < 4 || sorted.length - half < 4) {
    return null;
  }

  const left = buildPartFromPoints(sorted.slice(0, half), topBottomY);
  const right = buildPartFromPoints(sorted.slice(half), topBottomY);
  if (!left || !right) {
    return null;
  }

  const ordered =
    axisCoord(left.position, axis) <= axisCoord(right.position, axis)
      ? { left, right }
      : { left: right, right: left };

  const sideSize = axis === "x" ? size.x : size.z;
  const supportGap =
    Math.abs(axisCoord(ordered.right.position, axis) - axisCoord(ordered.left.position, axis)) -
    (axisHalf(ordered.left.halfExtents, axis) + axisHalf(ordered.right.halfExtents, axis));
  if (supportGap < Math.max(0.02, sideSize * 0.03)) {
    return null;
  }

  return [top, ordered.left, ordered.right];
}

function buildDeskThreePartBoundsFallback(prepared: PreparedGeometry): RapierCompoundPart[] {
  const bounds = prepared.bounds;
  const size = prepared.size;
  const axis: "x" | "z" = size.x >= size.z ? "x" : "z";
  const sideSize = axis === "x" ? size.x : size.z;
  const longSize = axis === "x" ? size.z : size.x;

  const topThickness = Math.max(0.02, size.y * 0.12);
  const topBottomY = bounds.max.y - topThickness;

  const top: RapierCompoundPart = {
    kind: "box",
    position: tuple(
      (bounds.min.x + bounds.max.x) * 0.5,
      (topBottomY + bounds.max.y) * 0.5,
      (bounds.min.z + bounds.max.z) * 0.5
    ),
    halfExtents: tuple(
      Math.max(0.005, size.x * 0.5),
      Math.max(0.005, topThickness * 0.5),
      Math.max(0.005, size.z * 0.5)
    )
  };

  const supportHeight = Math.max(0.02, topBottomY - bounds.min.y);
  const supportHalfY = supportHeight * 0.5;
  const supportAxisHalf = Math.max(0.01, sideSize * 0.11);
  const supportLongHalf = Math.max(0.01, longSize * 0.5);

  const centerX = (bounds.min.x + bounds.max.x) * 0.5;
  const centerZ = (bounds.min.z + bounds.max.z) * 0.5;
  const supportCenterY = bounds.min.y + supportHalfY;

  if (axis === "x") {
    const leftCenterX = bounds.min.x + supportAxisHalf;
    const rightCenterX = bounds.max.x - supportAxisHalf;
    return [
      top,
      {
        kind: "box",
        position: tuple(leftCenterX, supportCenterY, centerZ),
        halfExtents: tuple(supportAxisHalf, supportHalfY, supportLongHalf)
      },
      {
        kind: "box",
        position: tuple(rightCenterX, supportCenterY, centerZ),
        halfExtents: tuple(supportAxisHalf, supportHalfY, supportLongHalf)
      }
    ];
  }

  const leftCenterZ = bounds.min.z + supportAxisHalf;
  const rightCenterZ = bounds.max.z - supportAxisHalf;
  return [
    top,
    {
      kind: "box",
      position: tuple(centerX, supportCenterY, leftCenterZ),
      halfExtents: tuple(supportLongHalf, supportHalfY, supportAxisHalf)
    },
    {
      kind: "box",
      position: tuple(centerX, supportCenterY, rightCenterZ),
      halfExtents: tuple(supportLongHalf, supportHalfY, supportAxisHalf)
    }
  ];
}

function tryDeskThreePartCanonicalization(
  parts: readonly {
    kind: "box";
    position: Vector3Tuple;
    halfExtents: Vector3Tuple;
  }[],
  bounds: THREE.Box3
): {
  kind: "box";
  position: Vector3Tuple;
  halfExtents: Vector3Tuple;
}[] | null {
  if (parts.length < 3) {
    return null;
  }

  const merged = mergeCompoundParts(parts);
  if (!merged) {
    return null;
  }

  const sizeX = merged.halfExtents[0] * 2;
  const sizeY = merged.halfExtents[1] * 2;
  const sizeZ = merged.halfExtents[2] * 2;
  if (sizeX <= 0.05 || sizeY <= 0.05 || sizeZ <= 0.05) {
    return null;
  }

  const maxTopY = Math.max(...parts.map((part) => part.position[1] + part.halfExtents[1]));
  const topBand = Math.max(0.02, sizeY * 0.07);
  const topThreshold = maxTopY - topBand;
  const topParts = parts.filter(
    (part) => part.position[1] + part.halfExtents[1] >= topThreshold
  );
  if (topParts.length <= 0 || topParts.length >= parts.length) {
    return null;
  }

  const top = mergeCompoundParts(topParts);
  if (!top) {
    return null;
  }

  const topThickness = top.halfExtents[1] * 2;
  if (topThickness > sizeY * 0.45) {
    return null;
  }

  const topPartSet = new Set(topParts);
  const remainder = parts.filter((part) => !topPartSet.has(part));
  if (remainder.length < 2) {
    return null;
  }

  let bestSupports:
    | {
        left: {
          kind: "box";
          position: Vector3Tuple;
          halfExtents: Vector3Tuple;
        };
        right: {
          kind: "box";
          position: Vector3Tuple;
          halfExtents: Vector3Tuple;
        };
        axis: "x" | "z";
        score: number;
      }
    | null = null;

  for (const axis of ["x", "z"] as const) {
    const split = splitByHorizontalAxis(remainder, axis);
    if (!split) {
      continue;
    }
    const mergedLeft = mergeCompoundParts(split.left);
    const mergedRight = mergeCompoundParts(split.right);
    if (!mergedLeft || !mergedRight) {
      continue;
    }

    const ordered =
      axisCoord(mergedLeft.position, axis) <= axisCoord(mergedRight.position, axis)
        ? { left: mergedLeft, right: mergedRight }
        : { left: mergedRight, right: mergedLeft };

    const axisSize = axis === "x" ? sizeX : sizeZ;
    const orthSize = axis === "x" ? sizeZ : sizeX;
    const leftAxisWidth = axisHalf(ordered.left.halfExtents, axis) * 2;
    const rightAxisWidth = axisHalf(ordered.right.halfExtents, axis) * 2;
    const leftOrthWidth = axis === "x" ? ordered.left.halfExtents[2] * 2 : ordered.left.halfExtents[0] * 2;
    const rightOrthWidth = axis === "x" ? ordered.right.halfExtents[2] * 2 : ordered.right.halfExtents[0] * 2;

    const separation =
      Math.abs(axisCoord(ordered.right.position, axis) - axisCoord(ordered.left.position, axis)) /
      Math.max(1e-5, axisSize);
    const narrowness =
      1 - (leftAxisWidth + rightAxisWidth) / Math.max(1e-5, axisSize * 2);
    const orthCoverage = (leftOrthWidth + rightOrthWidth) / Math.max(1e-5, orthSize * 2);
    const supportHeight =
      Math.min(ordered.left.halfExtents[1], ordered.right.halfExtents[1]) * 2 / Math.max(1e-5, sizeY);

    const score = separation * 0.42 + narrowness * 0.22 + orthCoverage * 0.2 + supportHeight * 0.16;
    if (!bestSupports || score > bestSupports.score) {
      bestSupports = {
        left: ordered.left,
        right: ordered.right,
        axis,
        score
      };
    }
  }

  if (!bestSupports) {
    return null;
  }

  const axis = bestSupports.axis;
  const sideSize = axis === "x" ? sizeX : sizeZ;
  const longSize = axis === "x" ? sizeZ : sizeX;
  const left = bestSupports.left;
  const right = bestSupports.right;

  const supportGap =
    Math.abs(axisCoord(right.position, axis) - axisCoord(left.position, axis)) -
    (axisHalf(left.halfExtents, axis) + axisHalf(right.halfExtents, axis));
  if (supportGap < Math.max(0.02, sideSize * 0.04)) {
    return null;
  }

  const minSupportHeight = Math.min(left.halfExtents[1], right.halfExtents[1]) * 2;
  if (minSupportHeight < sizeY * 0.28) {
    return null;
  }

  const topBottom = top.position[1] - top.halfExtents[1];
  const supportTop = Math.max(
    left.position[1] + left.halfExtents[1],
    right.position[1] + right.halfExtents[1]
  );
  if (supportTop < topBottom - Math.max(0.03, sizeY * 0.18)) {
    return null;
  }

  const topSideCoverage = (axis === "x" ? top.halfExtents[0] : top.halfExtents[2]) * 2;
  const topLongCoverage = (axis === "x" ? top.halfExtents[2] : top.halfExtents[0]) * 2;
  if (topSideCoverage < sideSize * 0.45 || topLongCoverage < longSize * 0.45) {
    return null;
  }

  const sideMin = axis === "x" ? bounds.min.x : bounds.min.z;
  const sideMax = axis === "x" ? bounds.max.x : bounds.max.z;
  const leftOuterMin = axisCoord(left.position, axis) - axisHalf(left.halfExtents, axis);
  const rightOuterMax = axisCoord(right.position, axis) + axisHalf(right.halfExtents, axis);
  const sideTolerance = Math.max(0.04, sideSize * 0.22);
  if (leftOuterMin > sideMin + sideTolerance || rightOuterMax < sideMax - sideTolerance) {
    return null;
  }

  return [top, left, right];
}

function roundedTuple(tuple3: Vector3Tuple): Vector3Tuple {
  return [
    Number(tuple3[0].toFixed(4)),
    Number(tuple3[1].toFixed(4)),
    Number(tuple3[2].toFixed(4))
  ];
}

function normalizeForSignature(collider: RapierColliderDescription): unknown {
  if (collider.type === "ball") {
    return {
      type: collider.type,
      center: roundedTuple(collider.center),
      radius: Number(collider.radius.toFixed(4))
    };
  }

  if (collider.type === "capsule") {
    return {
      type: collider.type,
      center: roundedTuple(collider.center),
      axis: collider.axis,
      radius: Number(collider.radius.toFixed(4)),
      halfHeight: Number(collider.halfHeight.toFixed(4))
    };
  }

  if (collider.type === "convex") {
    return {
      type: collider.type,
      rootOffset: roundedTuple(collider.rootOffset),
      points: collider.points
        .map((point) => roundedTuple(point))
        .sort((a, b) =>
          a[0] !== b[0]
            ? a[0] - b[0]
            : a[1] !== b[1]
              ? a[1] - b[1]
              : a[2] - b[2]
        )
    };
  }

  if (collider.type === "compound") {
    return {
      type: collider.type,
      parts: collider.parts
        .map((part) => ({
          position: roundedTuple(part.position),
          halfExtents: roundedTuple(part.halfExtents)
        }))
        .sort((a, b) =>
          a.position[0] !== b.position[0]
            ? a.position[0] - b.position[0]
            : a.position[1] !== b.position[1]
              ? a.position[1] - b.position[1]
              : a.position[2] - b.position[2]
        )
    };
  }

  const head = Array.from(collider.vertices.slice(0, 48)).map((value) =>
    Number(value.toFixed(4))
  );
  return {
    type: collider.type,
    vertexCount: collider.vertices.length,
    triangleCount: Math.floor(collider.indices.length / 3),
    head
  };
}

function colliderSignature(collider: RapierColliderDescription): string {
  return JSON.stringify(normalizeForSignature(collider));
}

function applyAxisRotation(object: THREE.Object3D, axis: "x" | "y" | "z"): void {
  if (axis === "x") {
    object.rotation.z = -Math.PI * 0.5;
    return;
  }
  if (axis === "z") {
    object.rotation.x = Math.PI * 0.5;
  }
}

function buildDebugObject(collider: RapierColliderDescription): THREE.Object3D {
  const material = new THREE.MeshBasicMaterial({
    color: 0x6fd3ff,
    transparent: true,
    opacity: 0.42,
    wireframe: true
  });

  if (collider.type === "ball") {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(collider.radius, 16, 12), material);
    mesh.position.set(collider.center[0], collider.center[1], collider.center[2]);
    return mesh;
  }

  if (collider.type === "capsule") {
    const mesh = new THREE.Mesh(
      new THREE.CapsuleGeometry(collider.radius, collider.halfHeight * 2, 6, 12),
      material
    );
    mesh.position.set(collider.center[0], collider.center[1], collider.center[2]);
    applyAxisRotation(mesh, collider.axis);
    return mesh;
  }

  if (collider.type === "compound") {
    const group = new THREE.Group();
    for (const part of collider.parts) {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(
          Math.max(0.0001, part.halfExtents[0] * 2),
          Math.max(0.0001, part.halfExtents[1] * 2),
          Math.max(0.0001, part.halfExtents[2] * 2)
        ),
        material
      );
      mesh.position.set(part.position[0], part.position[1], part.position[2]);
      group.add(mesh);
    }
    return group;
  }

  if (collider.type === "convex") {
    const worldPoints = collider.points.map(
      (point) =>
        new THREE.Vector3(
          point[0] - collider.rootOffset[0],
          point[1] - collider.rootOffset[1],
          point[2] - collider.rootOffset[2]
        )
    );

    if (worldPoints.length < 4) {
      return new THREE.Group();
    }

    return new THREE.Mesh(new ConvexGeometry(worldPoints), material);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(collider.vertices, 3));
  geometry.setIndex(Array.from(collider.indices));
  return new THREE.Mesh(geometry, material);
}

function trimeshFromGeometry(
  geometry: THREE.BufferGeometry
): { vertices: Float32Array; indices: Uint32Array } | null {
  const position = geometry.getAttribute("position");
  if (!(position instanceof THREE.BufferAttribute) || position.count < 3) {
    return null;
  }

  const vertices = new Float32Array(position.array.length);
  for (let i = 0; i < position.array.length; i += 1) {
    vertices[i] = position.array[i] as number;
  }

  const index = geometry.getIndex();
  if (index) {
    const indices = new Uint32Array(index.count);
    for (let i = 0; i < index.count; i += 1) {
      indices[i] = index.getX(i);
    }
    return { vertices, indices };
  }

  const triangleCount = Math.floor(position.count / 3);
  const indices = new Uint32Array(triangleCount * 3);
  for (let i = 0; i < indices.length; i += 1) {
    indices[i] = i;
  }
  return { vertices, indices };
}

export function generateCollider(
  geometry: THREE.BufferGeometry,
  options?: GenerateColliderOptions
): ColliderResult {
  const resolvedOptions = withDefaults(options);
  const prepared = preprocessGeometry(geometry);
  if (!prepared) {
    const fallback: RapierColliderDescription = {
      type: "compound",
      parts: [
        {
          kind: "box",
          position: tuple(0, 0, 0),
          halfExtents: tuple(0.1, 0.1, 0.1)
        }
      ]
    };

    return {
      rapier: fallback,
      metrics: {
        diagonal: 0,
        dims: [0.2, 0.2, 0.2],
        slenderness: 1,
        flatness: 1,
        planarity: 0,
        concavityProxy: 0,
        layerScore: 0,
        cavityScore: 0,
        noiseScore: 0,
        occupiedRatio: 1
      },
      quality: {
        selectedStrategy: "boxy-furniture",
        attemptedStrategies: ["boxy-furniture"],
        classification: {
          selected: "BoxyFurniture",
          confidence: 1,
          scores: [{ kind: "BoxyFurniture", score: 1 }],
          lowConfidenceFallback: false,
          strategyOrder: ["boxy-furniture"]
        },
        error: {
          sampledPoints: 0,
          outsideRatio: 0,
          meanOutsideDistance: 0,
          overfillRatio: 0
        },
        passThreshold: 0,
        partCount: 1,
        signature: colliderSignature(fallback)
      },
      debug: resolvedOptions.debug ? { three: buildDebugObject(fallback) } : undefined
    };
  }

  const metrics = computeMetrics(prepared, resolvedOptions.budget);
  const classification = classifyMetrics(metrics);
  const context: StrategyContext = {
    prepared,
    metrics,
    options: resolvedOptions
  };

  const threshold = maxAllowedOutsideRatio(resolvedOptions);

  let best: {
    result: StrategyResult;
    error: ColliderErrorMetrics;
    score: number;
  } | null = null;

  const attemptedStrategies: ColliderStrategyKind[] = [];

  for (const kind of classification.strategyOrder) {
    const result = strategyByKind(kind, context);
    attemptedStrategies.push(kind);

    const error = evaluateColliderError(prepared, result.rapier, resolvedOptions.budget);
    const score = scoreCandidate(result.rapier, error);

    if (!best || score < best.score) {
      best = {
        result,
        error,
        score
      };
    }

    if (
      error.outsideRatio <= threshold &&
      error.meanOutsideDistance <= 0.035 &&
      error.overfillRatio <= 0.42
    ) {
      break;
    }
  }

  if (!best) {
    const fallback = generateBoxyFurnitureStrategy(context);
    const error = evaluateColliderError(prepared, fallback.rapier, resolvedOptions.budget);
    best = {
      result: fallback,
      error,
      score: scoreCandidate(fallback.rapier, error)
    };
    attemptedStrategies.push("boxy-furniture");
  }

  let rapier = best.result.rapier;
  let selectedStrategy = best.result.kind;
  let selectedError = best.error;

  if (
    resolvedOptions.mode === "dynamic" &&
    metrics.planarity >= 0.55 &&
    metrics.concavityProxy >= 0.65 &&
    metrics.layerScore < 0.12
  ) {
    const deskParts =
      buildDeskThreePartFromPrepared(prepared) ??
      buildDeskThreePartSimpleFallback(prepared) ??
      buildDeskThreePartBoundsFallback(prepared);
    if (deskParts) {
      const deskCollider: RapierColliderDescription = {
        type: "compound",
        parts: deskParts
      };
      const deskError = evaluateColliderError(prepared, deskCollider, resolvedOptions.budget);
      rapier = deskCollider;
      selectedError = deskError;
    }
  }

  if (
    resolvedOptions.mode === "dynamic" &&
    rapier.type === "compound" &&
    rapier.parts.length >= 3 &&
    metrics.cavityScore >= 0.08 &&
    metrics.planarity >= 0.45
  ) {
    const deskParts = tryDeskThreePartCanonicalization(rapier.parts, prepared.bounds);
    if (deskParts) {
      const deskCollider: RapierColliderDescription = {
        type: "compound",
        parts: deskParts
      };
      const deskError = evaluateColliderError(prepared, deskCollider, resolvedOptions.budget);
      const deskScore = scoreCandidate(deskCollider, deskError);
      const currentScore = scoreCandidate(rapier, selectedError);
      if (deskScore <= currentScore + 0.03) {
        rapier = deskCollider;
        selectedError = deskError;
      }
    }
  }

  const shouldTryConcaveCandidate =
    resolvedOptions.mode === "dynamic" &&
    (metrics.cavityScore >= 0.08 ||
      (metrics.planarity >= 0.8 &&
        metrics.layerScore >= 0.35 &&
        metrics.concavityProxy >= 0.22) ||
      (metrics.planarity >= 0.74 && metrics.layerScore >= 0.5));

  if (shouldTryConcaveCandidate) {
    const concaveCandidate = generateConcaveFurnitureStrategy(context);
    const concaveError = evaluateColliderError(
      prepared,
      concaveCandidate.rapier,
      resolvedOptions.budget
    );
    const concaveScore = scoreCandidate(concaveCandidate.rapier, concaveError);
    const currentScore = scoreCandidate(rapier, selectedError);

    const preferFurnitureCompound =
      metrics.planarity >= 0.82 &&
      metrics.layerScore >= 0.45 &&
      (metrics.cavityScore >= 0.08 || metrics.concavityProxy >= 0.24) &&
      concaveCandidate.rapier.type === "compound" &&
      concaveCandidate.rapier.parts.length >= 3 &&
      concaveError.outsideRatio <= 0.35;

    const currentIsSimple =
      rapier.type !== "compound" || rapier.parts.length <= 1;

    if (
      concaveCandidate.rapier.type === "compound" &&
      concaveCandidate.rapier.parts.length >= 3 &&
      (concaveScore <= currentScore + 0.03 ||
        (preferFurnitureCompound && currentIsSimple))
    ) {
      rapier = concaveCandidate.rapier;
      selectedStrategy = concaveCandidate.kind;
      selectedError = concaveError;
      if (!attemptedStrategies.includes("concave-furniture")) {
        attemptedStrategies.push("concave-furniture");
      }
    }
  }

  if (
    resolvedOptions.mode === "dynamic" &&
    rapier.type === "compound" &&
    rapier.parts.length >= 3 &&
    metrics.planarity >= 0.55 &&
    metrics.concavityProxy >= 0.65
  ) {
    const canonical = tryDeskThreePartCanonicalization(rapier.parts, prepared.bounds);
    if (canonical) {
      const canonicalCollider: RapierColliderDescription = {
        type: "compound",
        parts: canonical
      };
      const canonicalError = evaluateColliderError(prepared, canonicalCollider, resolvedOptions.budget);
      const canonicalScore = scoreCandidate(canonicalCollider, canonicalError);
      const currentScore = scoreCandidate(rapier, selectedError);
      if (canonicalScore <= currentScore + 0.05) {
        rapier = canonicalCollider;
        selectedError = canonicalError;
      }
    }
  }

  if (
    resolvedOptions.mode === "dynamic" &&
    resolvedOptions.budget === "strict" &&
    metrics.planarity >= 0.82 &&
    metrics.layerScore >= 0.4 &&
    metrics.concavityProxy >= 0.3 &&
    selectedError.overfillRatio >= 0.2
  ) {
    const expandedContext: StrategyContext = {
      prepared,
      metrics,
      options: {
        ...resolvedOptions,
        budget: "balanced"
      }
    };
    const expandedConcave = generateConcaveFurnitureStrategy(expandedContext);
    const expandedError = evaluateColliderError(
      prepared,
      expandedConcave.rapier,
      resolvedOptions.budget
    );

    const currentScore = scoreCandidate(rapier, selectedError);
    const expandedScore = scoreCandidate(expandedConcave.rapier, expandedError);
    const overfillGain = selectedError.overfillRatio - expandedError.overfillRatio;
    const outsideNotWorse =
      expandedError.outsideRatio <= Math.max(selectedError.outsideRatio + 0.02, threshold * 1.25);

    if (
      expandedConcave.rapier.type === "compound" &&
      expandedConcave.rapier.parts.length <= 12 &&
      outsideNotWorse &&
      (expandedScore + 0.012 < currentScore ||
        (overfillGain >= 0.03 && expandedError.overfillRatio <= 0.24))
    ) {
      rapier = expandedConcave.rapier;
      selectedStrategy = expandedConcave.kind;
      selectedError = expandedError;
      if (!attemptedStrategies.includes("concave-furniture")) {
        attemptedStrategies.push("concave-furniture");
      }
    }
  }

  if (
    resolvedOptions.mode === "static" &&
    resolvedOptions.allowStaticTrimeshFallback &&
    selectedError.outsideRatio > threshold * 1.35
  ) {
    const trimesh = trimeshFromGeometry(geometry);
    if (trimesh) {
      rapier = {
        type: "trimesh",
        vertices: trimesh.vertices,
        indices: trimesh.indices
      };
      selectedStrategy = "hard-noisy";
      selectedError = evaluateColliderError(prepared, rapier, resolvedOptions.budget);
      attemptedStrategies.push("hard-noisy");
    }
  }

  const result: ColliderResult = {
    rapier,
    metrics,
    quality: {
      selectedStrategy,
      attemptedStrategies,
      classification,
      error: selectedError,
      passThreshold: threshold,
      partCount: partCountForCollider(rapier),
      signature: colliderSignature(rapier)
    }
  };

  if (resolvedOptions.debug) {
    result.debug = {
      three: buildDebugObject(rapier)
    };
  }

  return result;
}

export function generateColliderFromObject(
  root: THREE.Object3D,
  options?: GenerateColliderOptions
): ColliderResult {
  const geometry = collectRootLocalGeometry(root);
  if (!geometry) {
    return generateCollider(new THREE.BoxGeometry(0.2, 0.2, 0.2), options);
  }

  return generateCollider(geometry, options);
}
