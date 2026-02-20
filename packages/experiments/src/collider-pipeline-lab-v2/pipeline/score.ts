import type {
  BoundingBox,
  ColliderPart,
  NormalizedProp,
  QualityBreakdown,
  QualityWeights,
  VoxelGrid
} from "../types";
import { clamp01, partAabb, pointInsidePart } from "./math";
import { buildVoxelGridFromPoints, voxelCenter, voxelIndex } from "./voxel";

const OCCUPANCY_RESOLUTION = 24;
const MAX_OCCUPANCY_RESOLUTION = 64;

type PropOccupancy = {
  grid: VoxelGrid;
  bits: Uint32Array<ArrayBufferLike>;
};

type OccupancyMetrics = {
  voxelIoU: number;
  overlapAgreement: number;
  underfill: number;
  overfill: number;
  meshOverlap: number;
  colliderOverlap: number;
  meshVolume: number;
  colliderUnionVolume: number;
  overlapVolume: number;
  colliderPartVolume: number;
  colliderSelfOverlap: number;
};

const propOccupancyCache = new Map<string, PropOccupancy>();

function popcount32(value: number): number {
  let v = value >>> 0;
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function createBitset(bitCount: number): Uint32Array<ArrayBufferLike> {
  return new Uint32Array(Math.ceil(bitCount / 32));
}

function setBit(bits: Uint32Array<ArrayBufferLike>, index: number): void {
  bits[index >>> 5] |= 1 << (index & 31);
}

function markVoxelForPoint(
  grid: VoxelGrid,
  bits: Uint32Array<ArrayBufferLike>,
  point: [number, number, number]
): void {
  const r = grid.resolution;
  const toCell = (axis: 0 | 1 | 2): number => {
    const axisSize = Math.max(1e-6, grid.size[axis]);
    const normalized = (point[axis] - grid.min[axis]) / axisSize;
    return Math.max(0, Math.min(r - 1, Math.floor(normalized * r)));
  };
  const x = toCell(0);
  const y = toCell(1);
  const z = toCell(2);
  setBit(bits, voxelIndex(r, x, y, z));
}

function markMaskVoxelForPoint(
  grid: VoxelGrid,
  mask: Uint8Array<ArrayBufferLike>,
  point: [number, number, number]
): void {
  const r = grid.resolution;
  const toCell = (axis: 0 | 1 | 2): number => {
    const axisSize = Math.max(1e-6, grid.size[axis]);
    const normalized = (point[axis] - grid.min[axis]) / axisSize;
    return Math.max(0, Math.min(r - 1, Math.floor(normalized * r)));
  };
  const x = toCell(0);
  const y = toCell(1);
  const z = toCell(2);
  mask[voxelIndex(r, x, y, z)] = 1;
}

function occupancyCacheKey(
  prop: NormalizedProp,
  resolution: number,
  bounds: BoundingBox
): string {
  return [
    prop.sampleSignature,
    resolution,
    bounds.min[0].toFixed(6),
    bounds.min[1].toFixed(6),
    bounds.min[2].toFixed(6),
    bounds.max[0].toFixed(6),
    bounds.max[1].toFixed(6),
    bounds.max[2].toFixed(6)
  ].join("|");
}

function fillPropVolumeBits(
  prop: NormalizedProp,
  grid: VoxelGrid,
  bits: Uint32Array<ArrayBufferLike>
): void {
  const r = grid.resolution;
  const total = r * r * r;
  const shellMask: Uint8Array<ArrayBufferLike> = new Uint8Array(total);
  if (prop.triangles.length > 0) {
    const maxAxisSize = Math.max(grid.size[0], grid.size[1], grid.size[2], 1e-6);
    const voxelSize = maxAxisSize / r;
    for (const triangle of prop.triangles) {
      const ab = Math.hypot(
        triangle.a[0] - triangle.b[0],
        triangle.a[1] - triangle.b[1],
        triangle.a[2] - triangle.b[2]
      );
      const bc = Math.hypot(
        triangle.b[0] - triangle.c[0],
        triangle.b[1] - triangle.c[1],
        triangle.b[2] - triangle.c[2]
      );
      const ca = Math.hypot(
        triangle.c[0] - triangle.a[0],
        triangle.c[1] - triangle.a[1],
        triangle.c[2] - triangle.a[2]
      );
      const maxEdge = Math.max(ab, bc, ca);
      const steps = Math.max(
        2,
        Math.min(10, Math.ceil(maxEdge / Math.max(1e-6, voxelSize)))
      );

      for (let i = 0; i <= steps; i += 1) {
        for (let j = 0; j <= steps - i; j += 1) {
          const u = i / steps;
          const v = j / steps;
          const w = 1 - u - v;
          markMaskVoxelForPoint(grid, shellMask, [
            triangle.a[0] * u + triangle.b[0] * v + triangle.c[0] * w,
            triangle.a[1] * u + triangle.b[1] * v + triangle.c[1] * w,
            triangle.a[2] * u + triangle.b[2] * v + triangle.c[2] * w
          ]);
        }
      }
      markMaskVoxelForPoint(grid, shellMask, triangle.centroid);
    }
  } else {
    for (let idx = 0; idx < grid.occupied.length; idx += 1) {
      if (grid.occupied[idx] !== 0) {
        shellMask[idx] = 1;
      }
    }
  }

  for (let idx = 0; idx < total; idx += 1) {
    if (shellMask[idx] !== 0) {
      setBit(bits, idx);
    }
  }

  const outside: Uint8Array<ArrayBufferLike> = new Uint8Array(total);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;
  const plane = r * r;
  const enqueueIfExterior = (idx: number): void => {
    if (idx < 0 || idx >= total) {
      return;
    }
    if (shellMask[idx] !== 0 || outside[idx] !== 0) {
      return;
    }
    outside[idx] = 1;
    queue[tail] = idx;
    tail += 1;
  };

  for (let z = 0; z < r; z += 1) {
    for (let y = 0; y < r; y += 1) {
      enqueueIfExterior(voxelIndex(r, 0, y, z));
      enqueueIfExterior(voxelIndex(r, r - 1, y, z));
    }
  }
  for (let z = 0; z < r; z += 1) {
    for (let x = 0; x < r; x += 1) {
      enqueueIfExterior(voxelIndex(r, x, 0, z));
      enqueueIfExterior(voxelIndex(r, x, r - 1, z));
    }
  }
  for (let y = 0; y < r; y += 1) {
    for (let x = 0; x < r; x += 1) {
      enqueueIfExterior(voxelIndex(r, x, y, 0));
      enqueueIfExterior(voxelIndex(r, x, y, r - 1));
    }
  }

  while (head < tail) {
    const idx = queue[head];
    head += 1;
    const z = Math.floor(idx / plane);
    const rem = idx - z * plane;
    const y = Math.floor(rem / r);
    const x = rem - y * r;

    if (x > 0) {
      enqueueIfExterior(voxelIndex(r, x - 1, y, z));
    }
    if (x < r - 1) {
      enqueueIfExterior(voxelIndex(r, x + 1, y, z));
    }
    if (y > 0) {
      enqueueIfExterior(voxelIndex(r, x, y - 1, z));
    }
    if (y < r - 1) {
      enqueueIfExterior(voxelIndex(r, x, y + 1, z));
    }
    if (z > 0) {
      enqueueIfExterior(voxelIndex(r, x, y, z - 1));
    }
    if (z < r - 1) {
      enqueueIfExterior(voxelIndex(r, x, y, z + 1));
    }
  }

  // Empty cells not reachable from outside are treated as enclosed mesh volume.
  for (let idx = 0; idx < total; idx += 1) {
    if (shellMask[idx] === 0 && outside[idx] === 0) {
      setBit(bits, idx);
    }
  }
}

function getPropOccupancy(
  prop: NormalizedProp,
  resolution: number,
  bounds: BoundingBox
): PropOccupancy {
  const key = occupancyCacheKey(prop, resolution, bounds);
  const cached = propOccupancyCache.get(key);
  if (cached) {
    return cached;
  }
  const grid = buildVoxelGridFromPoints(prop.points, bounds, resolution, 1);
  const bits = createBitset(grid.resolution * grid.resolution * grid.resolution);
  fillPropVolumeBits(prop, grid, bits);
  const occupancy = { grid, bits };
  propOccupancyCache.set(key, occupancy);
  return occupancy;
}

function makeBounds(min: [number, number, number], max: [number, number, number]): BoundingBox {
  const size: [number, number, number] = [
    Math.max(1e-6, max[0] - min[0]),
    Math.max(1e-6, max[1] - min[1]),
    Math.max(1e-6, max[2] - min[2])
  ];
  const center: [number, number, number] = [
    min[0] + size[0] * 0.5,
    min[1] + size[1] * 0.5,
    min[2] + size[2] * 0.5
  ];
  return {
    min,
    max,
    size,
    center,
    volume: size[0] * size[1] * size[2]
  };
}

function colliderBounds(parts: ColliderPart[]): BoundingBox | null {
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
    const bounds = partAabb(part);
    minX = Math.min(minX, bounds.min[0]);
    minY = Math.min(minY, bounds.min[1]);
    minZ = Math.min(minZ, bounds.min[2]);
    maxX = Math.max(maxX, bounds.max[0]);
    maxY = Math.max(maxY, bounds.max[1]);
    maxZ = Math.max(maxZ, bounds.max[2]);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) {
    return null;
  }
  return makeBounds([minX, minY, minZ], [maxX, maxY, maxZ]);
}

function mergedBounds(mesh: BoundingBox, collider: BoundingBox | null): BoundingBox {
  if (!collider) {
    return mesh;
  }
  const min: [number, number, number] = [
    Math.min(mesh.min[0], collider.min[0]),
    Math.min(mesh.min[1], collider.min[1]),
    Math.min(mesh.min[2], collider.min[2])
  ];
  const max: [number, number, number] = [
    Math.max(mesh.max[0], collider.max[0]),
    Math.max(mesh.max[1], collider.max[1]),
    Math.max(mesh.max[2], collider.max[2])
  ];
  return makeBounds(min, max);
}

function scaledResolution(mesh: BoundingBox, merged: BoundingBox): number {
  const meshAxis = Math.max(mesh.size[0], mesh.size[1], mesh.size[2], 1e-6);
  const mergedAxis = Math.max(
    merged.size[0],
    merged.size[1],
    merged.size[2],
    1e-6
  );
  const scale = Math.max(1, mergedAxis / meshAxis);
  return Math.max(
    OCCUPANCY_RESOLUTION,
    Math.min(
      MAX_OCCUPANCY_RESOLUTION,
      Math.ceil(OCCUPANCY_RESOLUTION * scale)
    )
  );
}

function axisRange(
  grid: VoxelGrid,
  axis: 0 | 1 | 2,
  minValue: number,
  maxValue: number
): [number, number] {
  const resolution = grid.resolution;
  const axisMin = grid.min[axis];
  const axisSize = Math.max(1e-6, grid.size[axis]);
  const toIndex = (value: number): number =>
    Math.floor(((value - axisMin) / axisSize) * resolution);

  const min = Math.max(0, Math.min(resolution - 1, toIndex(minValue) - 1));
  const max = Math.max(0, Math.min(resolution - 1, toIndex(maxValue) + 1));
  return [Math.min(min, max), Math.max(min, max)];
}

function buildColliderBits(
  grid: VoxelGrid,
  parts: ColliderPart[]
): Uint32Array<ArrayBufferLike> {
  const bits = createBitset(grid.resolution * grid.resolution * grid.resolution);
  for (const part of parts) {
    const bounds = partAabb(part);
    const [minX, maxX] = axisRange(grid, 0, bounds.min[0], bounds.max[0]);
    const [minY, maxY] = axisRange(grid, 1, bounds.min[1], bounds.max[1]);
    const [minZ, maxZ] = axisRange(grid, 2, bounds.min[2], bounds.max[2]);
    for (let z = minZ; z <= maxZ; z += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          const center = voxelCenter(grid, x, y, z);
          if (!pointInsidePart(center, part, 1e-5)) {
            continue;
          }
          setBit(bits, voxelIndex(grid.resolution, x, y, z));
        }
      }
    }
  }
  return bits;
}

function voxelizedOccupancyMetrics(
  prop: NormalizedProp,
  parts: ColliderPart[]
): OccupancyMetrics {
  const colliderPartVolume = parts.reduce((total, part) => total + part.volume, 0);
  if (parts.length <= 0) {
    return {
      voxelIoU: 0,
      overlapAgreement: 0,
      underfill: 1,
      overfill: 1,
      meshOverlap: 0,
      colliderOverlap: 0,
      meshVolume: 0,
      colliderUnionVolume: 0,
      overlapVolume: 0,
      colliderPartVolume,
      colliderSelfOverlap: 0
    };
  }

  const bounds = mergedBounds(prop.bbox, colliderBounds(parts));
  const resolution = scaledResolution(prop.bbox, bounds);
  const propOccupancy = getPropOccupancy(prop, resolution, bounds);
  const colliderBits = buildColliderBits(propOccupancy.grid, parts);
  const propBits = propOccupancy.bits;

  let propCount = 0;
  let colliderCount = 0;
  let intersection = 0;
  let union = 0;

  for (let i = 0; i < propBits.length; i += 1) {
    const propWord = propBits[i] ?? 0;
    const colliderWord = colliderBits[i] ?? 0;
    propCount += popcount32(propWord);
    colliderCount += popcount32(colliderWord);
    intersection += popcount32(propWord & colliderWord);
    union += popcount32(propWord | colliderWord);
  }

  if (propCount <= 0 || colliderCount <= 0 || union <= 0) {
    return {
      voxelIoU: 0,
      overlapAgreement: 0,
      underfill: 1,
      overfill: 1,
      meshOverlap: 0,
      colliderOverlap: 0,
      meshVolume: 0,
      colliderUnionVolume: 0,
      overlapVolume: 0,
      colliderPartVolume,
      colliderSelfOverlap: 0
    };
  }

  const cellVolume =
    (propOccupancy.grid.size[0] / propOccupancy.grid.resolution) *
    (propOccupancy.grid.size[1] / propOccupancy.grid.resolution) *
    (propOccupancy.grid.size[2] / propOccupancy.grid.resolution);
  const meshOverlap = clamp01(intersection / propCount);
  const colliderOverlap = clamp01(intersection / colliderCount);
  const overlapAgreement = clamp01(
    intersection / Math.max(propCount, colliderCount)
  );
  const meshVolume = Math.max(0, propCount * cellVolume);
  const colliderUnionVolume = Math.max(0, colliderCount * cellVolume);
  const overlapVolume = Math.max(0, intersection * cellVolume);
  const colliderSelfOverlap =
    colliderPartVolume <= 1e-6
      ? 0
      : clamp01(
          Math.max(0, colliderPartVolume - colliderUnionVolume) /
            colliderPartVolume
        );

  return {
    voxelIoU: clamp01(intersection / union),
    overlapAgreement,
    underfill: clamp01(1 - meshOverlap),
    overfill: clamp01(1 - colliderOverlap),
    meshOverlap,
    colliderOverlap,
    meshVolume,
    colliderUnionVolume,
    overlapVolume,
    colliderPartVolume,
    colliderSelfOverlap
  };
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
    // Only penalize truly needle-thin shapes; common furniture legs should not be heavily punished.
    const thinness = clamp01((0.08 - aspect) / 0.08);
    penalty += thinness * (part.volume / totalVolume);
  }
  return clamp01(penalty);
}

function volumeOverfillPenalty(
  prop: NormalizedProp,
  parts: ColliderPart[]
): number {
  if (parts.length <= 0) {
    return 1;
  }
  const colliderVolume = parts.reduce((total, part) => total + part.volume, 0);
  const propVolume = Math.max(1e-6, prop.bbox.volume);
  const overflowRatio = Math.max(0, colliderVolume / propVolume - 1);
  return clamp01(overflowRatio);
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

function baseOverreachPenalty(prop: NormalizedProp, parts: ColliderPart[]): number {
  if (parts.length <= 0 || prop.triangles.length <= 0) {
    return 1;
  }

  const width = Math.max(1e-6, prop.bbox.size[0]);
  const depth = Math.max(1e-6, prop.bbox.size[2]);
  const gridResolution = 40;
  const baseBandTop = prop.bbox.min[1] + Math.max(0.015, prop.bbox.size[1] * 0.22);

  const toCellX = (x: number): number => {
    const normalized = (x - prop.bbox.min[0]) / width;
    return Math.min(
      gridResolution - 1,
      Math.max(0, Math.floor(normalized * gridResolution))
    );
  };
  const toCellZ = (z: number): number => {
    const normalized = (z - prop.bbox.min[2]) / depth;
    return Math.min(
      gridResolution - 1,
      Math.max(0, Math.floor(normalized * gridResolution))
    );
  };
  const keyFor = (x: number, z: number): number => z * gridResolution + x;

  const propCells = new Set<number>();
  for (const triangle of prop.triangles) {
    const minY = Math.min(triangle.a[1], triangle.b[1], triangle.c[1]);
    if (minY > baseBandTop) {
      continue;
    }
    const ab: [number, number, number] = [
      (triangle.a[0] + triangle.b[0]) * 0.5,
      (triangle.a[1] + triangle.b[1]) * 0.5,
      (triangle.a[2] + triangle.b[2]) * 0.5
    ];
    const bc: [number, number, number] = [
      (triangle.b[0] + triangle.c[0]) * 0.5,
      (triangle.b[1] + triangle.c[1]) * 0.5,
      (triangle.b[2] + triangle.c[2]) * 0.5
    ];
    const ca: [number, number, number] = [
      (triangle.c[0] + triangle.a[0]) * 0.5,
      (triangle.c[1] + triangle.a[1]) * 0.5,
      (triangle.c[2] + triangle.a[2]) * 0.5
    ];
    const samples = [triangle.a, triangle.b, triangle.c, triangle.centroid, ab, bc, ca];
    for (const sample of samples) {
      propCells.add(keyFor(toCellX(sample[0]), toCellZ(sample[2])));
    }
  }

  if (propCells.size <= 0) {
    return 0;
  }

  const colliderCells = new Set<number>();
  for (const part of parts) {
    const bounds = partAabb(part);
    if (bounds.min[1] > baseBandTop || bounds.max[1] < prop.bbox.min[1] - 1e-6) {
      continue;
    }
    const minX = toCellX(bounds.min[0]);
    const maxX = toCellX(bounds.max[0]);
    const minZ = toCellZ(bounds.min[2]);
    const maxZ = toCellZ(bounds.max[2]);
    for (let z = minZ; z <= maxZ; z += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        colliderCells.add(keyFor(x, z));
      }
    }
  }

  if (colliderCells.size <= propCells.size) {
    return 0;
  }
  const totalCells = gridResolution * gridResolution;
  const excess = colliderCells.size - propCells.size;
  return clamp01(excess / Math.max(1, totalCells - propCells.size));
}

export function scoreColliderQuality(
  prop: NormalizedProp,
  parts: ColliderPart[],
  weights: QualityWeights
): QualityBreakdown {
  if (parts.length <= 0) {
    return {
      voxelIoU: 0,
      overlapAgreement: 0,
      underfill: 1,
      overfill: 1,
      meshOverlap: 0,
      colliderOverlap: 0,
      meshVolume: 0,
      colliderUnionVolume: 0,
      overlapVolume: 0,
      colliderPartVolume: 0,
      colliderSelfOverlap: 0,
      thinPenalty: 1,
      partPenalty: 1,
      baseOverreachPenalty: 1,
      flatBaseBonus: 0,
      finalScore: 1
    };
  }

  const occupancy = voxelizedOccupancyMetrics(prop, parts);
  const volumeOverfill = volumeOverfillPenalty(prop, parts);
  const overfill = clamp01(occupancy.overfill * 0.7 + volumeOverfill * 0.3);
  const coveragePenalty = clamp01(1 - occupancy.meshOverlap);
  const emptyCatchPenalty = overfill;
  const selfOverlapPenalty = occupancy.colliderSelfOverlap;
  const thinPenalty = thinPartPenalty(parts);
  const partPenalty = primitiveCountPenalty(parts);
  const baseOverreach = baseOverreachPenalty(prop, parts);
  const baseBonus = flatBaseBonus(prop, parts);

  const rawScore =
    weights.meshCoveragePenalty * coveragePenalty +
    weights.emptyVolumePenalty * emptyCatchPenalty +
    weights.selfOverlapPenalty * selfOverlapPenalty +
    weights.thinPenalty * thinPenalty +
    weights.partPenalty * partPenalty +
    weights.baseOverreachPenalty * baseOverreach -
    weights.flatBaseBonus * baseBonus;

  return {
    voxelIoU: occupancy.voxelIoU,
    overlapAgreement: occupancy.overlapAgreement,
    underfill: occupancy.underfill,
    overfill,
    meshOverlap: occupancy.meshOverlap,
    colliderOverlap: occupancy.colliderOverlap,
    meshVolume: occupancy.meshVolume,
    colliderUnionVolume: occupancy.colliderUnionVolume,
    overlapVolume: occupancy.overlapVolume,
    colliderPartVolume: occupancy.colliderPartVolume,
    colliderSelfOverlap: occupancy.colliderSelfOverlap,
    thinPenalty,
    partPenalty,
    baseOverreachPenalty: baseOverreach,
    flatBaseBonus: baseBonus,
    finalScore: Math.max(0, rawScore)
  };
}
