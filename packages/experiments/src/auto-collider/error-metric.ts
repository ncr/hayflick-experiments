import * as THREE from "three";
import type {
  ColliderErrorMetrics,
  PreparedGeometry,
  RapierColliderDescription,
  RapierCompoundPart
} from "./types";
import { downsamplePoints } from "./strategies/common";

type GridResolution = {
  xCount: number;
  yCount: number;
  zCount: number;
};

type SolidVolumeProxy = {
  bounds: THREE.Box3;
  resolution: GridResolution;
  solid: Uint8Array;
};

type CandidateEvaluator = {
  distance(point: THREE.Vector3): number;
  contains(point: THREE.Vector3): boolean;
};

const MIN_EDGE = 1e-5;
const volumeProxyCache = new WeakMap<
  PreparedGeometry,
  Map<"strict" | "balanced", SolidVolumeProxy>
>();

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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

function coordToIndex(
  coord: number,
  min: number,
  size: number,
  count: number
): number {
  const normalized = clamp((coord - min) / Math.max(MIN_EDGE, size), 0, 0.999999);
  return clamp(Math.floor(normalized * count), 0, count - 1);
}

function chooseProxyResolution(size: THREE.Vector3, budget: "strict" | "balanced"): GridResolution {
  const maxDim = Math.max(size.x, size.y, size.z, MIN_EDGE);
  const base = budget === "strict" ? 26 : 20;
  const maxAxis = budget === "strict" ? 40 : 30;

  return {
    xCount: Math.round(clamp((size.x / maxDim) * base, 10, maxAxis)),
    yCount: Math.round(clamp((size.y / maxDim) * base, 10, maxAxis)),
    zCount: Math.round(clamp((size.z / maxDim) * base, 10, maxAxis))
  };
}

function dilateOccupancy(
  occupancy: Uint8Array,
  resolution: GridResolution
): Uint8Array {
  const dilated = occupancy.slice();

  for (let z = 0; z < resolution.zCount; z += 1) {
    for (let y = 0; y < resolution.yCount; y += 1) {
      for (let x = 0; x < resolution.xCount; x += 1) {
        const idx = voxelIndex(x, y, z, resolution.xCount, resolution.yCount);
        if (occupancy[idx] !== 0) {
          continue;
        }

        let hasNeighbor = false;
        for (let dz = -1; dz <= 1 && !hasNeighbor; dz += 1) {
          for (let dy = -1; dy <= 1 && !hasNeighbor; dy += 1) {
            for (let dx = -1; dx <= 1; dx += 1) {
              const nx = x + dx;
              const ny = y + dy;
              const nz = z + dz;
              if (
                nx < 0 ||
                ny < 0 ||
                nz < 0 ||
                nx >= resolution.xCount ||
                ny >= resolution.yCount ||
                nz >= resolution.zCount
              ) {
                continue;
              }

              if (
                occupancy[
                  voxelIndex(nx, ny, nz, resolution.xCount, resolution.yCount)
                ] !== 0
              ) {
                hasNeighbor = true;
                break;
              }
            }
          }
        }

        if (hasNeighbor) {
          dilated[idx] = 1;
        }
      }
    }
  }

  return dilated;
}

function rasterizeSurfaceTriangles(
  prepared: PreparedGeometry,
  bounds: THREE.Box3,
  resolution: GridResolution
): Uint8Array {
  const occupancy = new Uint8Array(resolution.xCount * resolution.yCount * resolution.zCount);
  const size = bounds.getSize(new THREE.Vector3());
  const stepX = size.x / resolution.xCount;
  const stepY = size.y / resolution.yCount;
  const stepZ = size.z / resolution.zCount;

  const triangle = new THREE.Triangle();
  const cell = new THREE.Box3();
  const cellMin = new THREE.Vector3();
  const cellMax = new THREE.Vector3();

  for (const tri of prepared.triangles) {
    triangle.set(tri.a, tri.b, tri.c);

    const triMinX = Math.min(tri.a.x, tri.b.x, tri.c.x);
    const triMaxX = Math.max(tri.a.x, tri.b.x, tri.c.x);
    const triMinY = Math.min(tri.a.y, tri.b.y, tri.c.y);
    const triMaxY = Math.max(tri.a.y, tri.b.y, tri.c.y);
    const triMinZ = Math.min(tri.a.z, tri.b.z, tri.c.z);
    const triMaxZ = Math.max(tri.a.z, tri.b.z, tri.c.z);

    const minX = coordToIndex(triMinX, bounds.min.x, size.x, resolution.xCount);
    const maxX = coordToIndex(triMaxX, bounds.min.x, size.x, resolution.xCount);
    const minY = coordToIndex(triMinY, bounds.min.y, size.y, resolution.yCount);
    const maxY = coordToIndex(triMaxY, bounds.min.y, size.y, resolution.yCount);
    const minZ = coordToIndex(triMinZ, bounds.min.z, size.z, resolution.zCount);
    const maxZ = coordToIndex(triMaxZ, bounds.min.z, size.z, resolution.zCount);

    for (let z = minZ; z <= maxZ; z += 1) {
      const z0 = bounds.min.z + z * stepZ;
      const z1 = z0 + stepZ;
      for (let y = minY; y <= maxY; y += 1) {
        const y0 = bounds.min.y + y * stepY;
        const y1 = y0 + stepY;
        for (let x = minX; x <= maxX; x += 1) {
          const idx = voxelIndex(x, y, z, resolution.xCount, resolution.yCount);
          if (occupancy[idx] !== 0) {
            continue;
          }

          const x0 = bounds.min.x + x * stepX;
          const x1 = x0 + stepX;
          cellMin.set(x0, y0, z0);
          cellMax.set(x1, y1, z1);
          cell.set(cellMin, cellMax);
          if (cell.intersectsTriangle(triangle)) {
            occupancy[idx] = 1;
          }
        }
      }
    }
  }

  return occupancy;
}

function floodFillOutsideEmpty(
  occupancy: Uint8Array,
  resolution: GridResolution
): Uint8Array {
  const outside = new Uint8Array(occupancy.length);
  const queue: Array<[number, number, number]> = [];

  const enqueue = (x: number, y: number, z: number): void => {
    if (
      x < 0 ||
      y < 0 ||
      z < 0 ||
      x >= resolution.xCount ||
      y >= resolution.yCount ||
      z >= resolution.zCount
    ) {
      return;
    }

    const idx = voxelIndex(x, y, z, resolution.xCount, resolution.yCount);
    if (outside[idx] !== 0 || occupancy[idx] !== 0) {
      return;
    }

    outside[idx] = 1;
    queue.push([x, y, z]);
  };

  for (let x = 0; x < resolution.xCount; x += 1) {
    for (let z = 0; z < resolution.zCount; z += 1) {
      enqueue(x, 0, z);
      enqueue(x, resolution.yCount - 1, z);
    }
  }
  for (let y = 0; y < resolution.yCount; y += 1) {
    for (let z = 0; z < resolution.zCount; z += 1) {
      enqueue(0, y, z);
      enqueue(resolution.xCount - 1, y, z);
    }
  }
  for (let y = 0; y < resolution.yCount; y += 1) {
    for (let x = 0; x < resolution.xCount; x += 1) {
      enqueue(x, y, 0);
      enqueue(x, y, resolution.zCount - 1);
    }
  }

  let cursor = 0;
  while (cursor < queue.length) {
    const [x, y, z] = queue[cursor];
    cursor += 1;

    enqueue(x + 1, y, z);
    enqueue(x - 1, y, z);
    enqueue(x, y + 1, z);
    enqueue(x, y - 1, z);
    enqueue(x, y, z + 1);
    enqueue(x, y, z - 1);
  }

  return outside;
}

function buildSolidVolumeProxy(
  prepared: PreparedGeometry,
  budget: "strict" | "balanced"
): SolidVolumeProxy {
  const bounds = prepared.bounds.clone();
  const size = bounds.getSize(new THREE.Vector3());
  const resolution = chooseProxyResolution(size, budget);

  const surface = rasterizeSurfaceTriangles(prepared, bounds, resolution);
  const shell = dilateOccupancy(surface, resolution);
  const outsideEmpty = floodFillOutsideEmpty(surface, resolution);
  const solid = new Uint8Array(surface.length);

  for (let i = 0; i < solid.length; i += 1) {
    const enclosedInterior = surface[i] === 0 && outsideEmpty[i] === 0;
    if (shell[i] !== 0 || enclosedInterior) {
      solid[i] = 1;
    }
  }

  return {
    bounds,
    resolution,
    solid
  };
}

function getSolidVolumeProxy(
  prepared: PreparedGeometry,
  budget: "strict" | "balanced"
): SolidVolumeProxy {
  const perGeometry = volumeProxyCache.get(prepared);
  if (perGeometry?.has(budget)) {
    return perGeometry.get(budget)!;
  }

  const proxy = buildSolidVolumeProxy(prepared, budget);
  if (perGeometry) {
    perGeometry.set(budget, proxy);
  } else {
    volumeProxyCache.set(prepared, new Map([[budget, proxy]]));
  }
  return proxy;
}

function pointDistanceToBox(point: THREE.Vector3, part: RapierCompoundPart): number {
  const [cx, cy, cz] = part.position;
  const [hx, hy, hz] = part.halfExtents;

  const dx = Math.abs(point.x - cx) - hx;
  const dy = Math.abs(point.y - cy) - hy;
  const dz = Math.abs(point.z - cz) - hz;

  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  const oz = Math.max(dz, 0);

  return Math.sqrt(ox * ox + oy * oy + oz * oz);
}

function pointInsideBox(point: THREE.Vector3, part: RapierCompoundPart): boolean {
  const [cx, cy, cz] = part.position;
  const [hx, hy, hz] = part.halfExtents;
  const eps = 0.00075;
  return (
    Math.abs(point.x - cx) <= hx + eps &&
    Math.abs(point.y - cy) <= hy + eps &&
    Math.abs(point.z - cz) <= hz + eps
  );
}

function buildCandidateEvaluator(collider: RapierColliderDescription): CandidateEvaluator {
  return {
    distance: (point) => {
      if (collider.parts.length <= 0) {
        return Number.POSITIVE_INFINITY;
      }
      let minDistance = Number.POSITIVE_INFINITY;
      for (const part of collider.parts) {
        minDistance = Math.min(minDistance, pointDistanceToBox(point, part));
        if (minDistance <= 0) {
          return 0;
        }
      }
      return minDistance;
    },
    contains: (point) => collider.parts.some((part) => pointInsideBox(point, part))
  };
}

function chooseSampleSet(prepared: PreparedGeometry, budget: "strict" | "balanced"): THREE.Vector3[] {
  const source = prepared.samples.length > 0 ? prepared.samples : prepared.points;
  const cap = budget === "strict" ? 900 : 1400;
  return downsamplePoints(source, cap);
}

function overfillRatio(
  prepared: PreparedGeometry,
  evaluator: CandidateEvaluator,
  budget: "strict" | "balanced"
): number {
  const proxy = getSolidVolumeProxy(prepared, budget);
  const size = proxy.bounds.getSize(new THREE.Vector3());
  const stepX = size.x / proxy.resolution.xCount;
  const stepY = size.y / proxy.resolution.yCount;
  const stepZ = size.z / proxy.resolution.zCount;

  const point = new THREE.Vector3();
  let covered = 0;
  let coveredOutsideSolid = 0;

  for (let z = 0; z < proxy.resolution.zCount; z += 1) {
    const pz = proxy.bounds.min.z + (z + 0.5) * stepZ;
    for (let y = 0; y < proxy.resolution.yCount; y += 1) {
      const py = proxy.bounds.min.y + (y + 0.5) * stepY;
      for (let x = 0; x < proxy.resolution.xCount; x += 1) {
        const px = proxy.bounds.min.x + (x + 0.5) * stepX;
        point.set(px, py, pz);
        if (!evaluator.contains(point)) {
          continue;
        }

        covered += 1;
        const idx = voxelIndex(
          x,
          y,
          z,
          proxy.resolution.xCount,
          proxy.resolution.yCount
        );
        if (proxy.solid[idx] === 0) {
          coveredOutsideSolid += 1;
        }
      }
    }
  }

  if (covered <= 0) {
    return 1;
  }
  return clamp(coveredOutsideSolid / covered, 0, 1);
}

export function evaluateColliderError(
  prepared: PreparedGeometry,
  collider: RapierColliderDescription,
  budget: "strict" | "balanced"
): ColliderErrorMetrics {
  const samples = chooseSampleSet(prepared, budget);
  if (samples.length <= 0) {
    return {
      sampledPoints: 0,
      outsideRatio: 1,
      meanOutsideDistance: Number.POSITIVE_INFINITY,
      overfillRatio: 1
    };
  }

  const evaluator = buildCandidateEvaluator(collider);
  let outside = 0;
  let distanceAccum = 0;

  for (const point of samples) {
    const distance = evaluator.distance(point);
    const outsideDistance = Math.max(0, distance - 0.0015);
    if (outsideDistance > 0) {
      outside += 1;
      distanceAccum += outsideDistance;
    }
  }

  return {
    sampledPoints: samples.length,
    outsideRatio: clamp(outside / Math.max(1, samples.length), 0, 1),
    meanOutsideDistance: outside <= 0 ? 0 : distanceAccum / outside,
    overfillRatio: overfillRatio(prepared, evaluator, budget)
  };
}
