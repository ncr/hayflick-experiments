import * as THREE from "three";
import {
  generateColliderFromObject,
  type ColliderStrategyKind,
  type RapierColliderDescription
} from "@experiments/catalog/auto-collider";
import { countTotalFaces } from "./simplify";
import { fitCompoundBoxesObjective } from "./compound-objective";

export const DEFAULT_COLLIDER_FACE_TARGET = 96;
const MIN_COLLIDER_FACE_TARGET = 24;
const MIN_BOX_EDGE = 0.01;
const MAX_SAMPLE_POINTS = 6000;
const MAX_CONVEX_POINTS = 192;
const KMEANS_ITERATIONS = 8;
const VOXEL_MIN_RESOLUTION = 12;
const VOXEL_MAX_RESOLUTION = 28;
const VOXEL_MIN_AXIS_RESOLUTION = 6;
const VOXEL_X_HOLE_FILL_PASSES = 1;

type BoxPart = {
  position: [number, number, number];
  halfExtents: [number, number, number];
};

export type ColliderAxis = "x" | "y" | "z";

export type BoxColliderSpec = {
  type: "box";
  source: "aabb-v1";
  position: [number, number, number];
  halfExtents: [number, number, number];
};

export type PillColliderSpec = {
  type: "pill";
  source: "capsule-fit-v1";
  position: [number, number, number];
  axis: ColliderAxis;
  radius: number;
  halfHeight: number;
};

export type SphereColliderSpec = {
  type: "sphere";
  source: "sphere-fit-v1";
  position: [number, number, number];
  radius: number;
};

export type CylinderColliderSpec = {
  type: "cylinder";
  source: "cylinder-fit-v1";
  position: [number, number, number];
  axis: ColliderAxis;
  radius: number;
  halfHeight: number;
};

export type ConvexHullColliderSpec = {
  type: "convex-hull";
  source: "sampled-points-v1" | "auto-collider-v1";
  points: Array<[number, number, number]>;
  rootOffset: [number, number, number];
};

export type CompoundColliderPart = {
  kind: "box";
  position: [number, number, number];
  halfExtents: [number, number, number];
};

export type CompoundColliderSpec = {
  type: "compound-boxes";
  source: "objective-split-v1" | "auto-kmeans-v1" | "auto-collider-v1";
  parts: CompoundColliderPart[];
};

export type ColliderAutoRecommendation =
  | "box"
  | "pill"
  | "sphere"
  | "cylinder"
  | "convex-hull"
  | "compound-boxes";

export type ColliderVariantsSpec = {
  box: BoxColliderSpec;
  pill: PillColliderSpec;
  sphere: SphereColliderSpec;
  cylinder: CylinderColliderSpec;
  convexHull: ConvexHullColliderSpec;
  compoundBoxes: CompoundColliderSpec;
};

export type ColliderMeshBuildResult = {
  scene: THREE.Group;
  sourceFaces: number;
  targetFaces: number;
  colliderFaces: number;
  compoundCollider: CompoundColliderSpec;
  colliderVariants: ColliderVariantsSpec;
  autoRecommendation: ColliderAutoRecommendation;
  autoSummary: {
    strategy: ColliderStrategyKind;
    outsideRatio: number;
    signature: string;
  };
};

export type AutoColliderStrategy = ColliderStrategyKind;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function cloneToGroup(source: THREE.Object3D): THREE.Group {
  const clone = source.clone(true);
  if (clone instanceof THREE.Group) {
    return clone;
  }
  const group = new THREE.Group();
  group.add(clone);
  return group;
}

function pointTuple(x: number, y: number, z: number): [number, number, number] {
  return [x, y, z];
}

function collectSamplePoints(
  source: THREE.Group,
  maxSamples = MAX_SAMPLE_POINTS
): THREE.Vector3[] {
  source.updateMatrixWorld(true);

  const meshes: Array<{
    mesh: THREE.Mesh;
    position: THREE.BufferAttribute;
    index: THREE.BufferAttribute | null;
    triangleCount: number;
  }> = [];
  let totalTriangles = 0;

  source.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) {
      return;
    }
    if (!(node.geometry instanceof THREE.BufferGeometry)) {
      return;
    }
    const position = node.geometry.getAttribute("position");
    if (!(position instanceof THREE.BufferAttribute) || position.count <= 0) {
      return;
    }

    const index = node.geometry.getIndex();
    const triangleCount = Math.floor((index ? index.count : position.count) / 3);
    if (triangleCount <= 0) {
      return;
    }

    meshes.push({ mesh: node, position, index, triangleCount });
    totalTriangles += triangleCount;
  });

  if (meshes.length === 0 || totalTriangles === 0) {
    return [];
  }

  const points: THREE.Vector3[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const centroid = new THREE.Vector3();
  const maxTriangles = Math.max(1, Math.floor(maxSamples / 4));

  const pushPoint = (point: THREE.Vector3): boolean => {
    points.push(point.clone());
    return points.length >= maxSamples;
  };

  for (const entry of meshes) {
    const desiredTriangles = Math.max(
      8,
      Math.floor((entry.triangleCount / totalTriangles) * maxTriangles)
    );
    const triangleStep = Math.max(
      1,
      Math.floor(entry.triangleCount / desiredTriangles)
    );

    for (let tri = 0; tri < entry.triangleCount; tri += triangleStep) {
      const i0 = entry.index ? entry.index.getX(tri * 3) : tri * 3;
      const i1 = entry.index ? entry.index.getX(tri * 3 + 1) : tri * 3 + 1;
      const i2 = entry.index ? entry.index.getX(tri * 3 + 2) : tri * 3 + 2;

      a.fromBufferAttribute(entry.position, i0).applyMatrix4(entry.mesh.matrixWorld);
      b.fromBufferAttribute(entry.position, i1).applyMatrix4(entry.mesh.matrixWorld);
      c.fromBufferAttribute(entry.position, i2).applyMatrix4(entry.mesh.matrixWorld);

      centroid.copy(a).add(b).add(c).multiplyScalar(1 / 3);

      if (
        pushPoint(a) ||
        pushPoint(b) ||
        pushPoint(c) ||
        pushPoint(centroid)
      ) {
        return points;
      }
    }
  }

  return points;
}

function computeBoundsFromPoints(points: THREE.Vector3[]): THREE.Box3 {
  const bounds = new THREE.Box3();
  for (const point of points) {
    bounds.expandByPoint(point);
  }
  return bounds;
}

function buildBoundsCorners(bounds: THREE.Box3): THREE.Vector3[] {
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

function makeSafeBounds(bounds: THREE.Box3): THREE.Box3 {
  const center = bounds.getCenter(new THREE.Vector3());
  const half = bounds.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  const safeHalf = new THREE.Vector3(
    Math.max(half.x, MIN_BOX_EDGE * 0.5),
    Math.max(half.y, MIN_BOX_EDGE * 0.5),
    Math.max(half.z, MIN_BOX_EDGE * 0.5)
  );
  return new THREE.Box3(
    center.clone().sub(safeHalf),
    center.clone().add(safeHalf)
  );
}

function volumeForPart(part: BoxPart): number {
  return (
    part.halfExtents[0] * 2 *
    part.halfExtents[1] * 2 *
    part.halfExtents[2] * 2
  );
}

function isPartContainedIn(
  inner: BoxPart,
  outer: BoxPart,
  epsilon = 0.006
): boolean {
  const [ix, iy, iz] = inner.position;
  const [ihx, ihy, ihz] = inner.halfExtents;
  const [ox, oy, oz] = outer.position;
  const [ohx, ohy, ohz] = outer.halfExtents;

  return (
    ix - ihx >= ox - ohx - epsilon &&
    ix + ihx <= ox + ohx + epsilon &&
    iy - ihy >= oy - ohy - epsilon &&
    iy + ihy <= oy + ohy + epsilon &&
    iz - ihz >= oz - ohz - epsilon &&
    iz + ihz <= oz + ohz + epsilon
  );
}

function filterAndLimitBoxParts(parts: BoxPart[], maxParts: number): BoxPart[] {
  if (parts.length === 0) {
    return [];
  }

  const sorted = [...parts].sort((a, b) => volumeForPart(b) - volumeForPart(a));
  const filtered: BoxPart[] = [];

  for (const part of sorted) {
    if (filtered.some((existing) => isPartContainedIn(part, existing))) {
      continue;
    }
    filtered.push(part);
    if (filtered.length >= maxParts) {
      break;
    }
  }

  return filtered;
}

function chooseDesiredPartCount(
  sourceFaces: number,
  targetFaces: number,
  bounds: THREE.Box3,
  pointCount: number
): number {
  const maxPartsFromFaceBudget = Math.max(1, Math.floor(targetFaces / 12));
  const size = bounds.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const minDim = Math.max(1e-4, Math.min(size.x, size.y, size.z));
  const aspect = maxDim / minDim;

  const faceComplexity = sourceFaces <= 0 ? 0 : Math.min(1, sourceFaces / 2500);
  const sampleComplexity = Math.min(1, pointCount / 2500);
  const aspectComplexity = Math.min(1, Math.max(0, aspect - 1) / 3);

  const desired =
    1 +
    Math.round(faceComplexity * 2 + sampleComplexity * 2 + aspectComplexity * 2);
  return clamp(desired, 1, maxPartsFromFaceBudget);
}

function chooseVoxelResolution(
  bounds: THREE.Box3,
  desiredPartCount: number
): { xCount: number; yCount: number; zCount: number } {
  const size = bounds.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, MIN_BOX_EDGE);
  const base = Math.round(
    clamp(
      VOXEL_MIN_RESOLUTION + desiredPartCount * 2,
      VOXEL_MIN_RESOLUTION,
      VOXEL_MAX_RESOLUTION
    )
  );

  const xCount = Math.round(
    clamp(
      (size.x / maxDim) * base,
      VOXEL_MIN_AXIS_RESOLUTION,
      VOXEL_MAX_RESOLUTION
    )
  );
  const yCount = Math.round(
    clamp(
      (size.y / maxDim) * base,
      VOXEL_MIN_AXIS_RESOLUTION,
      VOXEL_MAX_RESOLUTION
    )
  );
  const zCount = Math.round(
    clamp(
      (size.z / maxDim) * base,
      VOXEL_MIN_AXIS_RESOLUTION,
      VOXEL_MAX_RESOLUTION
    )
  );

  return { xCount, yCount, zCount };
}

function voxelIndex(
  x: number,
  y: number,
  z: number,
  xCount: number,
  yCount: number
): number {
  return x + xCount * (y + yCount * z);
}

function decomposeToVoxelBoxParts(
  points: THREE.Vector3[],
  bounds: THREE.Box3,
  desiredPartCount: number,
  maxParts: number
): BoxPart[] {
  if (points.length === 0 || maxParts <= 0) {
    return [];
  }

  const size = bounds.getSize(new THREE.Vector3());
  if (size.x <= 0 || size.y <= 0 || size.z <= 0) {
    return [];
  }

  const { xCount, yCount, zCount } = chooseVoxelResolution(bounds, desiredPartCount);
  const occupancy = new Uint8Array(xCount * yCount * zCount);

  let occupied = 0;
  for (const point of points) {
    const xNorm = clamp((point.x - bounds.min.x) / size.x, 0, 0.999999);
    const yNorm = clamp((point.y - bounds.min.y) / size.y, 0, 0.999999);
    const zNorm = clamp((point.z - bounds.min.z) / size.z, 0, 0.999999);
    const x = Math.floor(xNorm * xCount);
    const y = Math.floor(yNorm * yCount);
    const z = Math.floor(zNorm * zCount);
    const index = voxelIndex(x, y, z, xCount, yCount);
    if (occupancy[index] === 0) {
      occupancy[index] = 1;
      occupied += 1;
    }
  }

  if (occupied === 0) {
    return [];
  }

  type LayerRect = {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
  };

  type VoxelBox = {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    minZ: number;
    maxZ: number;
  };

  const layerRectsByY: LayerRect[][] = new Array(yCount);

  for (let y = 0; y < yCount; y += 1) {
    const xAny = new Uint8Array(xCount);
    const minZByX = new Int32Array(xCount);
    const maxZByX = new Int32Array(xCount);
    minZByX.fill(zCount);
    maxZByX.fill(-1);

    for (let z = 0; z < zCount; z += 1) {
      for (let x = 0; x < xCount; x += 1) {
        if (occupancy[voxelIndex(x, y, z, xCount, yCount)] === 0) {
          continue;
        }
        xAny[x] = 1;
        if (z < minZByX[x]) {
          minZByX[x] = z;
        }
        if (z > maxZByX[x]) {
          maxZByX[x] = z;
        }
      }
    }

    for (let pass = 0; pass < VOXEL_X_HOLE_FILL_PASSES; pass += 1) {
      for (let x = 1; x < xCount - 1; x += 1) {
        if (xAny[x] !== 0 || xAny[x - 1] === 0 || xAny[x + 1] === 0) {
          continue;
        }
        xAny[x] = 1;
        minZByX[x] = Math.min(minZByX[x - 1], minZByX[x + 1]);
        maxZByX[x] = Math.max(maxZByX[x - 1], maxZByX[x + 1]);
      }
    }

    const rects: LayerRect[] = [];
    let x = 0;
    while (x < xCount) {
      if (xAny[x] === 0) {
        x += 1;
        continue;
      }

      const minX = x;
      let minZ = zCount;
      let maxZ = -1;
      while (x < xCount && xAny[x] !== 0) {
        minZ = Math.min(minZ, minZByX[x]);
        maxZ = Math.max(maxZ, maxZByX[x]);
        x += 1;
      }

      if (maxZ >= 0 && minZ < zCount) {
        rects.push({
          minX,
          maxX: x - 1,
          minZ,
          maxZ
        });
      }
    }

    layerRectsByY[y] = rects;
  }

  const active = new Map<string, VoxelBox>();
  const boxes: VoxelBox[] = [];

  const flushInactive = (seen: Set<string>): void => {
    for (const [key, box] of Array.from(active.entries())) {
      if (seen.has(key)) {
        continue;
      }
      boxes.push(box);
      active.delete(key);
    }
  };

  for (let y = 0; y < yCount; y += 1) {
    const rects = layerRectsByY[y];
    const seen = new Set<string>();

    for (const rect of rects) {
      const key = `${rect.minX}:${rect.maxX}:${rect.minZ}:${rect.maxZ}`;
      seen.add(key);
      const existing = active.get(key);
      if (existing) {
        existing.maxY = y;
      } else {
        active.set(key, {
          minX: rect.minX,
          maxX: rect.maxX,
          minY: y,
          maxY: y,
          minZ: rect.minZ,
          maxZ: rect.maxZ
        });
      }
    }

    flushInactive(seen);
  }

  for (const box of active.values()) {
    boxes.push(box);
  }

  if (boxes.length === 0) {
    return [];
  }

  const toWorldPart = (box: VoxelBox): BoxPart => {
    const min = new THREE.Vector3(
      bounds.min.x + (box.minX / xCount) * size.x,
      bounds.min.y + (box.minY / yCount) * size.y,
      bounds.min.z + (box.minZ / zCount) * size.z
    );
    const max = new THREE.Vector3(
      bounds.min.x + ((box.maxX + 1) / xCount) * size.x,
      bounds.min.y + ((box.maxY + 1) / yCount) * size.y,
      bounds.min.z + ((box.maxZ + 1) / zCount) * size.z
    );
    const center = min.clone().add(max).multiplyScalar(0.5);
    const half = max.clone().sub(min).multiplyScalar(0.5);

    return {
      position: [center.x, center.y, center.z],
      halfExtents: [
        Math.max(half.x, MIN_BOX_EDGE * 0.5),
        Math.max(half.y, MIN_BOX_EDGE * 0.5),
        Math.max(half.z, MIN_BOX_EDGE * 0.5)
      ]
    };
  };

  const parts = boxes.map(toWorldPart);
  return filterAndLimitBoxParts(parts, maxParts);
}

function initializeCentroids(points: THREE.Vector3[], count: number): THREE.Vector3[] {
  if (count <= 0 || points.length === 0) {
    return [];
  }

  const bounds = computeBoundsFromPoints(points);
  const center = bounds.getCenter(new THREE.Vector3());

  const centroids: THREE.Vector3[] = [];
  let farthestIndex = 0;
  let farthestDistanceSq = -1;
  for (let i = 0; i < points.length; i += 1) {
    const distanceSq = center.distanceToSquared(points[i]);
    if (distanceSq > farthestDistanceSq) {
      farthestDistanceSq = distanceSq;
      farthestIndex = i;
    }
  }
  centroids.push(points[farthestIndex].clone());

  while (centroids.length < count) {
    let nextIndex = 0;
    let nextScore = -1;

    for (let i = 0; i < points.length; i += 1) {
      let minDistanceSq = Number.POSITIVE_INFINITY;
      for (const centroid of centroids) {
        const distanceSq = centroid.distanceToSquared(points[i]);
        if (distanceSq < minDistanceSq) {
          minDistanceSq = distanceSq;
        }
      }
      if (minDistanceSq > nextScore) {
        nextScore = minDistanceSq;
        nextIndex = i;
      }
    }

    centroids.push(points[nextIndex].clone());
  }

  return centroids;
}

function assignPointsToCentroids(
  points: THREE.Vector3[],
  centroids: THREE.Vector3[]
): Int32Array {
  const assignments = new Int32Array(points.length);

  for (let i = 0; i < points.length; i += 1) {
    let bestIndex = 0;
    let bestDistanceSq = Number.POSITIVE_INFINITY;

    for (let c = 0; c < centroids.length; c += 1) {
      const distanceSq = centroids[c].distanceToSquared(points[i]);
      if (distanceSq < bestDistanceSq) {
        bestDistanceSq = distanceSq;
        bestIndex = c;
      }
    }

    assignments[i] = bestIndex;
  }

  return assignments;
}

function buildBoxesFromClusters(
  points: THREE.Vector3[],
  assignments: Int32Array,
  clusterCount: number
): BoxPart[] {
  const mins = new Array<THREE.Vector3>(clusterCount);
  const maxes = new Array<THREE.Vector3>(clusterCount);
  const counts = new Int32Array(clusterCount);

  for (let c = 0; c < clusterCount; c += 1) {
    mins[c] = new THREE.Vector3(
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY
    );
    maxes[c] = new THREE.Vector3(
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY
    );
  }

  for (let i = 0; i < points.length; i += 1) {
    const cluster = assignments[i];
    counts[cluster] += 1;
    mins[cluster].min(points[i]);
    maxes[cluster].max(points[i]);
  }

  const parts: BoxPart[] = [];
  for (let c = 0; c < clusterCount; c += 1) {
    if (counts[c] <= 0) {
      continue;
    }

    const min = mins[c];
    const max = maxes[c];
    const center = min.clone().add(max).multiplyScalar(0.5);
    const half = max.clone().sub(min).multiplyScalar(0.5);

    const halfExtents: [number, number, number] = [
      Math.max(half.x, MIN_BOX_EDGE * 0.5),
      Math.max(half.y, MIN_BOX_EDGE * 0.5),
      Math.max(half.z, MIN_BOX_EDGE * 0.5)
    ];

    parts.push({
      position: [center.x, center.y, center.z],
      halfExtents
    });
  }

  return filterAndLimitBoxParts(parts, Number.POSITIVE_INFINITY);
}

function decomposeToBoxParts(
  points: THREE.Vector3[],
  sourceFaces: number,
  targetFaces: number
): BoxPart[] {
  if (points.length === 0) {
    return [];
  }

  const bounds = computeBoundsFromPoints(points);
  if (bounds.isEmpty()) {
    return [];
  }

  const desiredPartCount = chooseDesiredPartCount(
    sourceFaces,
    targetFaces,
    bounds,
    points.length
  );
  const maxParts = Math.max(1, Math.floor(targetFaces / 12));

  const objectivePartsRaw = fitCompoundBoxesObjective(
    points.map((point) => ({
      x: point.x,
      y: point.y,
      z: point.z
    }))
  );
  if (objectivePartsRaw.length > 0) {
    const objectiveParts = filterAndLimitBoxParts(
      objectivePartsRaw.map((part) => ({
        position: part.position,
        halfExtents: [
          Math.max(part.halfExtents[0], MIN_BOX_EDGE * 0.5),
          Math.max(part.halfExtents[1], MIN_BOX_EDGE * 0.5),
          Math.max(part.halfExtents[2], MIN_BOX_EDGE * 0.5)
        ]
      })),
      maxParts
    );
    if (objectiveParts.length > 0) {
      return objectiveParts;
    }
  }

  const voxelParts = decomposeToVoxelBoxParts(
    points,
    bounds,
    desiredPartCount,
    maxParts
  );
  if (voxelParts.length > 0) {
    return voxelParts;
  }

  let centroids = initializeCentroids(points, desiredPartCount);
  if (centroids.length === 0) {
    centroids = [bounds.getCenter(new THREE.Vector3())];
  }

  let assignments = assignPointsToCentroids(points, centroids);

  for (let iteration = 0; iteration < KMEANS_ITERATIONS; iteration += 1) {
    const sums = centroids.map(() => new THREE.Vector3());
    const counts = new Int32Array(centroids.length);

    for (let i = 0; i < points.length; i += 1) {
      const cluster = assignments[i];
      sums[cluster].add(points[i]);
      counts[cluster] += 1;
    }

    for (let c = 0; c < centroids.length; c += 1) {
      if (counts[c] <= 0) {
        continue;
      }
      centroids[c] = sums[c].multiplyScalar(1 / counts[c]);
    }

    assignments = assignPointsToCentroids(points, centroids);
  }

  let parts = buildBoxesFromClusters(points, assignments, centroids.length);
  if (parts.length === 0) {
    const center = bounds.getCenter(new THREE.Vector3());
    const half = bounds.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    parts = [
      {
        position: [center.x, center.y, center.z],
        halfExtents: [
          Math.max(half.x, MIN_BOX_EDGE * 0.5),
          Math.max(half.y, MIN_BOX_EDGE * 0.5),
          Math.max(half.z, MIN_BOX_EDGE * 0.5)
        ]
      }
    ];
  }

  if (parts.length > maxParts) {
    parts = parts.slice(0, maxParts);
  }

  return parts;
}

function createCompoundColliderScene(parts: BoxPart[]): THREE.Group {
  const scene = new THREE.Group();
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff });

  for (const [index, part] of parts.entries()) {
    const [hx, hy, hz] = part.halfExtents;
    const geometry = new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(part.position[0], part.position[1], part.position[2]);
    mesh.name = `compound-collider-box-${index + 1}`;
    scene.add(mesh);
  }

  return scene;
}

function buildBoxColliderSpec(bounds: THREE.Box3): BoxColliderSpec {
  const safe = makeSafeBounds(bounds);
  const center = safe.getCenter(new THREE.Vector3());
  const half = safe.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  return {
    type: "box",
    source: "aabb-v1",
    position: pointTuple(center.x, center.y, center.z),
    halfExtents: pointTuple(half.x, half.y, half.z)
  };
}

function choosePrimaryAxis(half: THREE.Vector3): ColliderAxis {
  if (half.x >= half.y && half.x >= half.z) {
    return "x";
  }
  if (half.y >= half.z) {
    return "y";
  }
  return "z";
}

function axisDimensions(
  half: THREE.Vector3,
  axis: ColliderAxis
): { major: number; radialA: number; radialB: number } {
  if (axis === "x") {
    return {
      major: half.x,
      radialA: half.y,
      radialB: half.z
    };
  }
  if (axis === "z") {
    return {
      major: half.z,
      radialA: half.x,
      radialB: half.y
    };
  }
  return {
    major: half.y,
    radialA: half.x,
    radialB: half.z
  };
}

function buildPillColliderSpec(bounds: THREE.Box3): PillColliderSpec {
  const safe = makeSafeBounds(bounds);
  const center = safe.getCenter(new THREE.Vector3());
  const half = safe.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  const axis = choosePrimaryAxis(half);
  const dims = axisDimensions(half, axis);
  const radius = Math.max(
    Math.sqrt(dims.radialA * dims.radialA + dims.radialB * dims.radialB),
    MIN_BOX_EDGE * 0.5
  );
  const halfHeight = Math.max(0, dims.major - radius);
  return {
    type: "pill",
    source: "capsule-fit-v1",
    position: pointTuple(center.x, center.y, center.z),
    axis,
    radius,
    halfHeight
  };
}

function buildSphereColliderSpec(bounds: THREE.Box3): SphereColliderSpec {
  const safe = makeSafeBounds(bounds);
  const center = safe.getCenter(new THREE.Vector3());
  const size = safe.getSize(new THREE.Vector3());
  const radius = Math.max(size.length() * 0.5, MIN_BOX_EDGE * 0.5);
  return {
    type: "sphere",
    source: "sphere-fit-v1",
    position: pointTuple(center.x, center.y, center.z),
    radius
  };
}

function buildCylinderColliderSpec(bounds: THREE.Box3): CylinderColliderSpec {
  const safe = makeSafeBounds(bounds);
  const center = safe.getCenter(new THREE.Vector3());
  const half = safe.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  const axis = choosePrimaryAxis(half);
  const dims = axisDimensions(half, axis);
  const radius = Math.max(
    Math.sqrt(dims.radialA * dims.radialA + dims.radialB * dims.radialB),
    MIN_BOX_EDGE * 0.5
  );
  return {
    type: "cylinder",
    source: "cylinder-fit-v1",
    position: pointTuple(center.x, center.y, center.z),
    axis,
    radius,
    halfHeight: Math.max(dims.major, MIN_BOX_EDGE * 0.5)
  };
}

function limitHullPoints(points: THREE.Vector3[], maxPoints: number): THREE.Vector3[] {
  if (points.length <= maxPoints) {
    return points.map((point) => point.clone());
  }

  const result: THREE.Vector3[] = [];
  const step = Math.max(1, Math.ceil(points.length / maxPoints));
  for (let i = 0; i < points.length && result.length < maxPoints; i += step) {
    result.push(points[i].clone());
  }
  return result;
}

function buildConvexHullSpec(
  samplePoints: THREE.Vector3[],
  sourceBounds: THREE.Box3
): ConvexHullColliderSpec {
  const safeBounds = makeSafeBounds(sourceBounds);
  const safeSize = safeBounds.getSize(new THREE.Vector3());
  const degenerate =
    safeSize.x <= MIN_BOX_EDGE || safeSize.y <= MIN_BOX_EDGE || safeSize.z <= MIN_BOX_EDGE;

  const sourcePoints =
    samplePoints.length > 0 && !degenerate
      ? limitHullPoints(samplePoints, MAX_CONVEX_POINTS)
      : buildBoundsCorners(safeBounds);

  const hullBounds = computeBoundsFromPoints(sourcePoints);
  const hullCenter = hullBounds.getCenter(new THREE.Vector3());
  const centeredPoints = sourcePoints.map((point) =>
    pointTuple(point.x - hullCenter.x, point.y - hullCenter.y, point.z - hullCenter.z)
  );

  return {
    type: "convex-hull",
    source: "sampled-points-v1",
    points: centeredPoints,
    rootOffset: pointTuple(-hullCenter.x, -hullCenter.y, -hullCenter.z)
  };
}

function mapAutoCompoundFromRapier(
  rapier: RapierColliderDescription
): CompoundColliderSpec | null {
  if (rapier.parts.length <= 0) {
    return null;
  }

  return {
    type: "compound-boxes",
    source: "auto-collider-v1",
    parts: rapier.parts.map((part) => ({
      kind: "box",
      position: pointTuple(part.position[0], part.position[1], part.position[2]),
      halfExtents: pointTuple(
        Math.max(part.halfExtents[0], MIN_BOX_EDGE * 0.5),
        Math.max(part.halfExtents[1], MIN_BOX_EDGE * 0.5),
        Math.max(part.halfExtents[2], MIN_BOX_EDGE * 0.5)
      )
    }))
  };
}

export async function buildSimplifiedColliderScene(
  sourceModel: THREE.Object3D,
  faceTarget = DEFAULT_COLLIDER_FACE_TARGET,
  autoStrategy: AutoColliderStrategy = "concave-furniture"
): Promise<ColliderMeshBuildResult> {
  const sourceScene = cloneToGroup(sourceModel);
  const sourceFaces = Math.max(0, Math.round(countTotalFaces(sourceScene)));
  const targetFaces =
    sourceFaces <= 0
      ? 0
      : Math.min(
          sourceFaces,
          Math.max(MIN_COLLIDER_FACE_TARGET, Math.round(faceTarget))
        );

  const samplePoints = collectSamplePoints(sourceScene);
  let sourceBounds =
    samplePoints.length > 0
      ? computeBoundsFromPoints(samplePoints)
      : new THREE.Box3().setFromObject(sourceScene);
  if (sourceBounds.isEmpty()) {
    sourceBounds = new THREE.Box3(
      new THREE.Vector3(-0.1, 0, -0.1),
      new THREE.Vector3(0.1, 0.2, 0.1)
    );
  }
  sourceBounds = makeSafeBounds(sourceBounds);

  const autoResult = generateColliderFromObject(sourceScene, {
    mode: "dynamic",
    budget: "strict",
    strategy: autoStrategy
  });
  const autoCompound = mapAutoCompoundFromRapier(autoResult.rapier);

  const decompositionPoints =
    samplePoints.length > 0 ? samplePoints : buildBoundsCorners(sourceBounds);
  let fallbackParts = decomposeToBoxParts(
    decompositionPoints,
    sourceFaces,
    targetFaces
  );
  if (fallbackParts.length === 0) {
    const center = sourceBounds.getCenter(new THREE.Vector3());
    const half = sourceBounds.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    fallbackParts = [
      {
        position: pointTuple(center.x, center.y, center.z),
        halfExtents: pointTuple(half.x, half.y, half.z)
      }
    ];
  }

  const compoundCollider: CompoundColliderSpec = autoCompound ?? {
    type: "compound-boxes",
    source: "objective-split-v1",
    parts: fallbackParts.map((part) => ({
      kind: "box" as const,
      position: pointTuple(part.position[0], part.position[1], part.position[2]),
      halfExtents: pointTuple(
        part.halfExtents[0],
        part.halfExtents[1],
        part.halfExtents[2]
      )
    }))
  };

  const parts: BoxPart[] = compoundCollider.parts.map((part) => ({
    position: pointTuple(part.position[0], part.position[1], part.position[2]),
    halfExtents: pointTuple(
      Math.max(part.halfExtents[0], MIN_BOX_EDGE * 0.5),
      Math.max(part.halfExtents[1], MIN_BOX_EDGE * 0.5),
      Math.max(part.halfExtents[2], MIN_BOX_EDGE * 0.5)
    )
  }));

  const scene = createCompoundColliderScene(parts);
  const colliderVariants: ColliderVariantsSpec = {
    box: buildBoxColliderSpec(sourceBounds),
    pill: buildPillColliderSpec(sourceBounds),
    sphere: buildSphereColliderSpec(sourceBounds),
    cylinder: buildCylinderColliderSpec(sourceBounds),
    convexHull: buildConvexHullSpec(samplePoints, sourceBounds),
    compoundBoxes: compoundCollider
  };

  return {
    scene,
    sourceFaces,
    targetFaces,
    colliderFaces: parts.length * 12,
    compoundCollider,
    colliderVariants,
    autoRecommendation: "compound-boxes",
    autoSummary: {
      strategy: autoResult.quality.selectedStrategy,
      outsideRatio: autoResult.quality.error.outsideRatio,
      signature: autoResult.quality.signature
    }
  };
}
