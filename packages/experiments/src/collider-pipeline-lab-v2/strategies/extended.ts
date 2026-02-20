import type {
  BoundingBox,
  ColliderPart,
  StrategyGenerator,
  Vec3Tuple
} from "../types";
import { bboxFromPoints, clamp, clamp01 } from "../pipeline/math";
import {
  buildVoxelGridFromPoints,
  voxelCenter,
  voxelIndex
} from "../pipeline/voxel";
import { generateAabbCollider } from "./aabb";
import { generateLayeredAxisCollider } from "./layered-axis";
import { generateObbPcaCollider } from "./obb-pca";
import { generateSplitFitCollider } from "./split-fit";
import { generateSupportColumnsCollider } from "./support-columns";
import { generateVoxelGreedyCollider } from "./voxel-greedy";
import { axisAlignedPartFromBounds, compactPartCount, sanitizeParts } from "./common";

type Sphere = {
  center: Vec3Tuple;
  radius: number;
};

function fallbackPart(bounds: BoundingBox, inflate: number): ColliderPart[] {
  return [axisAlignedPartFromBounds(bounds.min, bounds.max, inflate)];
}

function sampledPoints(points: Vec3Tuple[], maxPoints: number): Vec3Tuple[] {
  if (points.length <= maxPoints) {
    return points;
  }
  const step = Math.max(1, Math.floor(points.length / maxPoints));
  const sampled: Vec3Tuple[] = [];
  for (let i = 0; i < points.length; i += step) {
    sampled.push(points[i]);
  }
  return sampled;
}

function longestAxisIndex(size: Vec3Tuple): 0 | 1 | 2 {
  if (size[0] >= size[1] && size[0] >= size[2]) {
    return 0;
  }
  if (size[1] >= size[0] && size[1] >= size[2]) {
    return 1;
  }
  return 2;
}

function makePartsFromClusters(
  clusters: Vec3Tuple[][],
  inflate: number,
  maxParts: number,
  fallbackBounds: BoundingBox
): ColliderPart[] {
  const parts: ColliderPart[] = [];
  for (const cluster of clusters) {
    if (cluster.length <= 0) {
      continue;
    }
    const bounds = bboxFromPoints(cluster);
    if (bounds.volume <= 1e-9) {
      continue;
    }
    parts.push(axisAlignedPartFromBounds(bounds.min, bounds.max, inflate));
  }

  if (parts.length <= 0) {
    return fallbackPart(fallbackBounds, inflate);
  }
  return compactPartCount(sanitizeParts(parts), Math.max(1, Math.floor(maxParts)));
}

function splitByAxisQuantiles(
  points: Vec3Tuple[],
  axis: 0 | 1 | 2,
  buckets: number
): Vec3Tuple[][] {
  const count = Math.max(1, Math.floor(buckets));
  if (points.length <= 0 || count <= 1) {
    return [points];
  }
  const sorted = [...points].sort((a, b) => a[axis] - b[axis]);
  const clusters: Vec3Tuple[][] = Array.from({ length: count }, () => []);
  for (let i = 0; i < sorted.length; i += 1) {
    const t = i / Math.max(1, sorted.length - 1);
    const bucket = Math.min(count - 1, Math.floor(t * count));
    clusters[bucket].push(sorted[i]);
  }
  return clusters.filter((cluster) => cluster.length > 0);
}

function distanceSquared(a: Vec3Tuple, b: Vec3Tuple): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

function pointCentroid(points: Vec3Tuple[]): Vec3Tuple {
  if (points.length <= 0) {
    return [0, 0, 0];
  }
  let x = 0;
  let y = 0;
  let z = 0;
  for (const point of points) {
    x += point[0];
    y += point[1];
    z += point[2];
  }
  const inv = 1 / points.length;
  return [x * inv, y * inv, z * inv];
}

function kMeansClusters(points: Vec3Tuple[], k: number, iterations = 10): Vec3Tuple[][] {
  if (points.length <= 0) {
    return [];
  }
  const clusterCount = Math.max(1, Math.min(Math.floor(k), points.length));
  if (clusterCount <= 1) {
    return [points];
  }

  const sorted = [...points].sort(
    (a, b) => a[0] + a[1] * 0.7 + a[2] * 1.1 - (b[0] + b[1] * 0.7 + b[2] * 1.1)
  );
  let centers: Vec3Tuple[] = Array.from({ length: clusterCount }, (_, index) => {
    const idx = Math.min(sorted.length - 1, Math.floor((index / clusterCount) * sorted.length));
    return [...sorted[idx]] as Vec3Tuple;
  });

  let assignments = new Int32Array(points.length);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const buckets: Vec3Tuple[][] = Array.from({ length: clusterCount }, () => []);

    for (let i = 0; i < points.length; i += 1) {
      const point = points[i];
      let bestIndex = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let c = 0; c < centers.length; c += 1) {
        const d = distanceSquared(point, centers[c]);
        if (d < bestDistance) {
          bestDistance = d;
          bestIndex = c;
        }
      }
      assignments[i] = bestIndex;
      buckets[bestIndex].push(point);
    }

    centers = centers.map((center, index) => {
      if (buckets[index].length <= 0) {
        return center;
      }
      return pointCentroid(buckets[index]);
    });
  }

  const clusters: Vec3Tuple[][] = Array.from({ length: clusterCount }, () => []);
  for (let i = 0; i < points.length; i += 1) {
    clusters[assignments[i]].push(points[i]);
  }
  return clusters.filter((cluster) => cluster.length > 0);
}

function bspClusters(
  points: Vec3Tuple[],
  maxDepth: number,
  minPoints: number,
  depth = 0
): Vec3Tuple[][] {
  if (points.length <= 0) {
    return [];
  }
  if (depth >= maxDepth || points.length <= minPoints * 2) {
    return [points];
  }

  const bounds = bboxFromPoints(points);
  const axis = longestAxisIndex(bounds.size);
  const sorted = [...points].sort((a, b) => a[axis] - b[axis]);
  const mid = Math.floor(sorted.length * 0.5);
  const left = sorted.slice(0, mid);
  const right = sorted.slice(mid);
  if (left.length < minPoints || right.length < minPoints) {
    return [points];
  }
  return [
    ...bspClusters(left, maxDepth, minPoints, depth + 1),
    ...bspClusters(right, maxDepth, minPoints, depth + 1)
  ];
}

function voxelComponents(
  points: Vec3Tuple[],
  bounds: BoundingBox,
  resolution: number,
  dilatePasses: number
): Vec3Tuple[][] {
  if (points.length <= 0) {
    return [];
  }
  const grid = buildVoxelGridFromPoints(points, bounds, resolution, dilatePasses);
  const r = grid.resolution;
  const visited = new Uint8Array(r * r * r);
  const clusters: Vec3Tuple[][] = [];
  const neighbors = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1]
  ] as const;

  for (let z = 0; z < r; z += 1) {
    for (let y = 0; y < r; y += 1) {
      for (let x = 0; x < r; x += 1) {
        const startIndex = voxelIndex(r, x, y, z);
        if (grid.occupied[startIndex] === 0 || visited[startIndex] !== 0) {
          continue;
        }
        visited[startIndex] = 1;
        const queue: Array<[number, number, number]> = [[x, y, z]];
        const component: Vec3Tuple[] = [];

        while (queue.length > 0) {
          const [qx, qy, qz] = queue.shift() as [number, number, number];
          component.push(voxelCenter(grid, qx, qy, qz));
          for (const [dx, dy, dz] of neighbors) {
            const nx = qx + dx;
            const ny = qy + dy;
            const nz = qz + dz;
            if (nx < 0 || nx >= r || ny < 0 || ny >= r || nz < 0 || nz >= r) {
              continue;
            }
            const nextIndex = voxelIndex(r, nx, ny, nz);
            if (grid.occupied[nextIndex] === 0 || visited[nextIndex] !== 0) {
              continue;
            }
            visited[nextIndex] = 1;
            queue.push([nx, ny, nz]);
          }
        }

        if (component.length > 0) {
          clusters.push(component);
        }
      }
    }
  }

  return clusters;
}

function shrinkParts(parts: ColliderPart[], tighten: number): ColliderPart[] {
  const amount = clamp01(tighten);
  const scale = clamp(1 - amount * 0.35, 0.55, 1);
  return sanitizeParts(
    parts.map((part) => ({
      ...part,
      halfExtents: [
        Math.max(1e-4, part.halfExtents[0] * scale),
        Math.max(1e-4, part.halfExtents[1] * scale),
        Math.max(1e-4, part.halfExtents[2] * scale)
      ] as Vec3Tuple
    }))
  );
}

function spherePart(sphere: Sphere, inflate: number): ColliderPart {
  const radius = Math.max(1e-4, sphere.radius * (1 + Math.max(0, inflate)));
  return axisAlignedPartFromBounds(
    [sphere.center[0] - radius, sphere.center[1] - radius, sphere.center[2] - radius],
    [sphere.center[0] + radius, sphere.center[1] + radius, sphere.center[2] + radius],
    0
  );
}

function sphereFromRitter(points: Vec3Tuple[]): Sphere {
  if (points.length <= 0) {
    return { center: [0, 0, 0], radius: 1e-4 };
  }
  let start = points[0];
  let farthest = start;
  let best = -1;
  for (const point of points) {
    const d = distanceSquared(start, point);
    if (d > best) {
      best = d;
      farthest = point;
    }
  }

  let farthest2 = farthest;
  best = -1;
  for (const point of points) {
    const d = distanceSquared(farthest, point);
    if (d > best) {
      best = d;
      farthest2 = point;
    }
  }

  let center: Vec3Tuple = [
    (farthest[0] + farthest2[0]) * 0.5,
    (farthest[1] + farthest2[1]) * 0.5,
    (farthest[2] + farthest2[2]) * 0.5
  ];
  let radius = Math.sqrt(distanceSquared(farthest, farthest2)) * 0.5;

  for (const point of points) {
    const d = Math.sqrt(distanceSquared(center, point));
    if (d <= radius) {
      continue;
    }
    const nextRadius = (radius + d) * 0.5;
    const move = (nextRadius - radius) / Math.max(1e-6, d);
    center = [
      center[0] + (point[0] - center[0]) * move,
      center[1] + (point[1] - center[1]) * move,
      center[2] + (point[2] - center[2]) * move
    ];
    radius = nextRadius;
  }

  return {
    center,
    radius: Math.max(1e-4, radius)
  };
}

function sphereFromLeastSquares(points: Vec3Tuple[]): Sphere {
  if (points.length <= 0) {
    return { center: [0, 0, 0], radius: 1e-4 };
  }
  const center = pointCentroid(points);
  let radiusSqSum = 0;
  for (const point of points) {
    radiusSqSum += distanceSquared(center, point);
  }
  const radius = Math.sqrt(radiusSqSum / points.length);
  return {
    center,
    radius: Math.max(1e-4, radius)
  };
}

function clustersForSphereStyle(points: Vec3Tuple[], maxParts: number): Vec3Tuple[][] {
  const count = Math.max(1, Math.floor(maxParts));
  return kMeansClusters(points, count, 8);
}

function sectionedAxisClusters(
  points: Vec3Tuple[],
  axis: 0 | 1 | 2,
  sections: number
): Vec3Tuple[][] {
  return splitByAxisQuantiles(points, axis, Math.max(1, Math.floor(sections)));
}

export const generateCoacdCollider: StrategyGenerator<"coacd"> = (prop, params) => {
  const points = sampledPoints(prop.points, Math.max(240, params.resolution * params.resolution * 3));
  const depth = Math.max(2, Math.floor(2 + params.detail * 5));
  const minPoints = Math.max(12, Math.floor(points.length / Math.max(4, params.maxParts * 2)));
  const clusters = bspClusters(points, depth, minPoints);
  return makePartsFromClusters(clusters, params.inflate, params.maxParts, prop.bbox);
};

export const generateVhacdCollider: StrategyGenerator<"v-hacd"> = (prop, params) => {
  const clusters = voxelComponents(
    prop.points,
    prop.bbox,
    Math.max(8, Math.floor(params.resolution)),
    Math.max(1, Math.floor(params.detail * 3))
  );
  const fallback = generateVoxelGreedyCollider(prop, {
    resolution: params.resolution,
    maxParts: params.maxParts,
    inflate: params.inflate
  });
  if (clusters.length <= 0) {
    return fallback;
  }
  const fromComponents = makePartsFromClusters(clusters, params.inflate, params.maxParts, prop.bbox);
  return compactPartCount(sanitizeParts([...fromComponents, ...fallback]), params.maxParts);
};

export const generateHacdCollider: StrategyGenerator<"hacd"> = (prop, params) => {
  const sample = sampledPoints(prop.points, Math.max(220, params.resolution * params.resolution * 2));
  const axis = longestAxisIndex(prop.bbox.size);
  const axisClusters = splitByAxisQuantiles(
    sample,
    axis,
    Math.max(2, Math.floor(params.maxParts * (0.35 + params.detail * 0.55)))
  );
  return makePartsFromClusters(axisClusters, params.inflate, params.maxParts, prop.bbox);
};

export const generateAcdCollider: StrategyGenerator<"acd"> = (prop, params) => {
  const sample = sampledPoints(prop.points, Math.max(200, params.resolution * params.resolution * 2));
  const k = Math.max(2, Math.floor(params.maxParts * (0.45 + params.detail * 0.45)));
  const clusters = kMeansClusters(sample, k, 10);
  return makePartsFromClusters(clusters, params.inflate, params.maxParts, prop.bbox);
};

export const generateQuickhullCollider: StrategyGenerator<"quickhull"> = (prop, params) => {
  const base = generateObbPcaCollider(prop, { inflate: params.inflate });
  return shrinkParts(base, params.tighten);
};

export const generateIncrementalHullCollider: StrategyGenerator<"incremental-hull"> = (
  prop,
  params
) => {
  const base = generateAabbCollider(prop, { inflate: params.inflate });
  return shrinkParts(base, params.tighten * 0.8);
};

export const generateMvbbCollider: StrategyGenerator<"mvbb"> = (prop, params) => {
  const samples = sampledPoints(prop.points, Math.max(32, Math.floor(params.sampleCount) * 40));
  if (samples.length <= 0) {
    return fallbackPart(prop.bbox, params.inflate);
  }
  const pseudoProp = {
    ...prop,
    points: samples,
    pointCount: samples.length
  };
  return generateObbPcaCollider(pseudoProp, { inflate: params.inflate });
};

export const generateKdopCollider: StrategyGenerator<"k-dop"> = (prop, params) => {
  const axis = longestAxisIndex(prop.bbox.size);
  const bins = Math.max(2, Math.floor(params.directionCount / 4));
  const clusters = splitByAxisQuantiles(prop.points, axis, bins);
  return makePartsFromClusters(clusters, params.inflate, params.maxParts, prop.bbox);
};

export const generateSphereRitterCollider: StrategyGenerator<"sphere-ritter"> = (
  prop,
  params
) => {
  const clusters = clustersForSphereStyle(prop.points, params.maxParts);
  const parts = clusters.map((cluster) => spherePart(sphereFromRitter(cluster), params.inflate));
  return compactPartCount(sanitizeParts(parts), Math.max(1, Math.floor(params.maxParts)));
};

export const generateSphereLeastSquaresCollider: StrategyGenerator<"sphere-ls"> = (
  prop,
  params
) => {
  const clusters = clustersForSphereStyle(prop.points, params.maxParts);
  const parts = clusters.map((cluster) =>
    spherePart(sphereFromLeastSquares(cluster), params.inflate)
  );
  return compactPartCount(sanitizeParts(parts), Math.max(1, Math.floor(params.maxParts)));
};

export const generateCapsuleFitCollider: StrategyGenerator<"capsule-fit"> = (prop, params) => {
  const axis = longestAxisIndex(prop.bbox.size);
  const clusters = sectionedAxisClusters(prop.points, axis, params.segments);
  return makePartsFromClusters(clusters, params.inflate, params.segments, prop.bbox);
};

export const generateCylinderFitCollider: StrategyGenerator<"cylinder-fit"> = (
  prop,
  params
) => {
  const axis = longestAxisIndex(prop.bbox.size);
  const segmentClusters = sectionedAxisClusters(prop.points, axis, params.segments);
  const radialBins = Math.max(1, Math.floor(params.radialSamples / 6));
  const refined: Vec3Tuple[][] = [];
  for (const cluster of segmentClusters) {
    refined.push(...splitByAxisQuantiles(cluster, (axis + 1) % 3 as 0 | 1 | 2, radialBins));
  }
  return makePartsFromClusters(refined, params.inflate, params.segments * radialBins, prop.bbox);
};

export const generateMultiSphereCollider: StrategyGenerator<"multi-sphere"> = (
  prop,
  params
) => {
  const clusters = kMeansClusters(prop.points, Math.max(1, Math.floor(params.sphereCount)), 10);
  const parts = clusters.map((cluster) => spherePart(sphereFromRitter(cluster), params.inflate));
  return compactPartCount(sanitizeParts(parts), Math.max(1, Math.floor(params.sphereCount)));
};

export const generateKmeansSegCollider: StrategyGenerator<"kmeans-seg"> = (prop, params) => {
  const sample = sampledPoints(prop.points, 2800);
  const clusters = kMeansClusters(sample, params.clusterCount, 10);
  return makePartsFromClusters(clusters, params.inflate, params.maxParts, prop.bbox);
};

export const generateSpectralSegCollider: StrategyGenerator<"spectral-seg"> = (
  prop,
  params
) => {
  const sample = sampledPoints(prop.points, 2600);
  const axis = longestAxisIndex(prop.bbox.size);
  const coarse = splitByAxisQuantiles(sample, axis, Math.max(2, Math.floor(params.clusterCount * 0.5)));
  const clusters: Vec3Tuple[][] = [];
  for (const cluster of coarse) {
    clusters.push(...kMeansClusters(cluster, Math.max(1, Math.floor(params.clusterCount / coarse.length)), 8));
  }
  return makePartsFromClusters(clusters, params.inflate, params.maxParts, prop.bbox);
};

export const generateRegionGrowCollider: StrategyGenerator<"region-grow"> = (
  prop,
  params
) => {
  const resolution = Math.max(8, Math.floor(6 + params.clusterCount * 2));
  const components = voxelComponents(prop.points, prop.bbox, resolution, 1);
  if (components.length <= 0) {
    return fallbackPart(prop.bbox, params.inflate);
  }
  return makePartsFromClusters(components, params.inflate, params.maxParts, prop.bbox);
};

export const generateBspCollider: StrategyGenerator<"bsp"> = (prop, params) => {
  const points = sampledPoints(prop.points, 2800);
  const clusters = bspClusters(
    points,
    Math.max(1, Math.floor(params.maxDepth)),
    Math.max(8, Math.floor(params.minPoints))
  );
  return makePartsFromClusters(clusters, params.inflate, params.maxParts, prop.bbox);
};

export const generateSdfConvexCollider: StrategyGenerator<"sdf-convex"> = (
  prop,
  params
) => {
  const components = voxelComponents(
    prop.points,
    prop.bbox,
    Math.max(8, Math.floor(params.resolution)),
    Math.max(0, Math.floor(params.smoothPasses))
  );
  if (components.length <= 0) {
    return fallbackPart(prop.bbox, params.inflate);
  }
  return makePartsFromClusters(components, params.inflate, params.maxParts, prop.bbox);
};

function decimationClusters(
  points: Vec3Tuple[],
  targetRatio: number,
  maxParts: number
): Vec3Tuple[][] {
  const safeRatio = clamp(targetRatio, 0.05, 1);
  const sampled = sampledPoints(points, Math.max(120, Math.floor(points.length * safeRatio)));
  const clusterCount = Math.max(1, Math.floor(maxParts * clamp(0.5 + safeRatio, 0.5, 1.6)));
  return kMeansClusters(sampled, clusterCount, 8);
}

export const generateQemDecimateCollider: StrategyGenerator<"qem-decimate"> = (
  prop,
  params
) => {
  const clusters = decimationClusters(prop.points, params.targetRatio, params.maxParts);
  return makePartsFromClusters(clusters, params.inflate, params.maxParts, prop.bbox);
};

export const generateEdgeCollapseCollider: StrategyGenerator<"edge-collapse"> = (
  prop,
  params
) => {
  const clusters = decimationClusters(prop.points, params.targetRatio * 0.85, params.maxParts);
  return makePartsFromClusters(clusters, params.inflate, params.maxParts, prop.bbox);
};

// Export legacy generators to keep one-stop imports when wiring strategy registry.
export {
  generateLayeredAxisCollider,
  generateSplitFitCollider,
  generateSupportColumnsCollider,
  generateVoxelGreedyCollider
};
