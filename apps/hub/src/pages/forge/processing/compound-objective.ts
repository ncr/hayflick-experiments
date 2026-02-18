export type ObjectivePoint3 = {
  x: number;
  y: number;
  z: number;
};

export type ObjectiveBoxPart = {
  position: [number, number, number];
  halfExtents: [number, number, number];
};

type Bounds = {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
};

type Voxel = {
  x: number;
  y: number;
  z: number;
};

type VoxelBounds = {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
};

type VoxelBox = {
  id: number;
  voxels: Voxel[];
  bounds: VoxelBounds;
  volume: number;
  occupied: number;
  empty: number;
};

type SplitCandidate = {
  score: number;
  immediateGain: number;
  left: VoxelBox;
  right: VoxelBox;
};

const MIN_EDGE = 0.01;
const MIN_SPLIT_PART_VOXELS = 12;
const MAX_SPLIT_CANDIDATES_PER_AXIS = 14;
const LOOKAHEAD_WEIGHT = 0.72;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function computeBounds(points: readonly ObjectivePoint3[]): Bounds | null {
  if (points.length === 0) {
    return null;
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.z < minZ) minZ = point.z;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
    if (point.z > maxZ) maxZ = point.z;
  }

  return { minX, minY, minZ, maxX, maxY, maxZ };
}

function chooseAutoResolution(bounds: Bounds, pointCount: number): {
  xSlices: number;
  ySlices: number;
  zSlices: number;
} {
  const sizeX = Math.max(MIN_EDGE, bounds.maxX - bounds.minX);
  const sizeY = Math.max(MIN_EDGE, bounds.maxY - bounds.minY);
  const sizeZ = Math.max(MIN_EDGE, bounds.maxZ - bounds.minZ);
  const maxDim = Math.max(sizeX, sizeY, sizeZ, MIN_EDGE);
  const density = clamp(Math.log10(Math.max(32, pointCount)) / 4.2, 0, 1);
  const base = Math.round(clamp(20 + density * 22, 20, 54));

  const xSlices = Math.round(clamp((sizeX / maxDim) * base, 12, 56));
  const ySlices = Math.round(clamp((sizeY / maxDim) * base, 12, 56));
  const zSlices = Math.round(clamp((sizeZ / maxDim) * base, 12, 56));
  return { xSlices, ySlices, zSlices };
}

function voxelKey(x: number, y: number, z: number): string {
  return `${x}|${y}|${z}`;
}

function voxelizePoints(
  points: readonly ObjectivePoint3[],
  bounds: Bounds,
  xSlices: number,
  ySlices: number,
  zSlices: number
): Voxel[] {
  const sizeX = Math.max(MIN_EDGE, bounds.maxX - bounds.minX);
  const sizeY = Math.max(MIN_EDGE, bounds.maxY - bounds.minY);
  const sizeZ = Math.max(MIN_EDGE, bounds.maxZ - bounds.minZ);
  const seen = new Set<string>();
  const voxels: Voxel[] = [];

  for (const point of points) {
    const xNorm = clamp((point.x - bounds.minX) / sizeX, 0, 0.999999);
    const yNorm = clamp((point.y - bounds.minY) / sizeY, 0, 0.999999);
    const zNorm = clamp((point.z - bounds.minZ) / sizeZ, 0, 0.999999);
    const x = Math.floor(xNorm * xSlices);
    const y = Math.floor(yNorm * ySlices);
    const z = Math.floor(zNorm * zSlices);
    const key = voxelKey(x, y, z);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    voxels.push({ x, y, z });
  }

  return voxels;
}

function computeVoxelBounds(voxels: readonly Voxel[]): VoxelBounds | null {
  if (voxels.length === 0) {
    return null;
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (const voxel of voxels) {
    if (voxel.x < minX) minX = voxel.x;
    if (voxel.y < minY) minY = voxel.y;
    if (voxel.z < minZ) minZ = voxel.z;
    if (voxel.x > maxX) maxX = voxel.x;
    if (voxel.y > maxY) maxY = voxel.y;
    if (voxel.z > maxZ) maxZ = voxel.z;
  }

  return { minX, minY, minZ, maxX, maxY, maxZ };
}

function voxelBoundsVolume(bounds: VoxelBounds): number {
  const dx = bounds.maxX - bounds.minX + 1;
  const dy = bounds.maxY - bounds.minY + 1;
  const dz = bounds.maxZ - bounds.minZ + 1;
  return dx * dy * dz;
}

function createVoxelBox(id: number, voxels: Voxel[]): VoxelBox {
  const bounds = computeVoxelBounds(voxels);
  if (!bounds) {
    throw new Error("Cannot create voxel box from empty voxel set.");
  }

  const volume = voxelBoundsVolume(bounds);
  const occupied = voxels.length;
  const empty = Math.max(0, volume - occupied);
  return { id, voxels, bounds, volume, occupied, empty };
}

function chooseBoxPenalty(occupiedVoxels: number): number {
  return Math.round(clamp(16 + Math.sqrt(occupiedVoxels) * 1.6, 22, 220));
}

function chooseMaxBoxes(occupiedVoxels: number): number {
  return Math.round(clamp(3 + Math.sqrt(occupiedVoxels) / 9, 3, 8));
}

function chooseSplitPositions(box: VoxelBox, axis: "x" | "y" | "z"): number[] {
  const values = new Set<number>();
  const max =
    axis === "x" ? box.bounds.maxX : axis === "y" ? box.bounds.maxY : box.bounds.maxZ;

  for (const voxel of box.voxels) {
    const value = axis === "x" ? voxel.x : axis === "y" ? voxel.y : voxel.z;
    if (value < max) {
      values.add(value);
    }
  }

  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length <= MAX_SPLIT_CANDIDATES_PER_AXIS) {
    return sorted;
  }

  const sampled = new Set<number>();
  const last = sorted.length - 1;
  for (let i = 1; i <= MAX_SPLIT_CANDIDATES_PER_AXIS; i += 1) {
    const index = Math.floor((i / (MAX_SPLIT_CANDIDATES_PER_AXIS + 1)) * last);
    sampled.add(sorted[index]);
  }
  return [...sampled].sort((a, b) => a - b);
}

function splitVoxels(
  voxels: readonly Voxel[],
  axis: "x" | "y" | "z",
  split: number
): { left: Voxel[]; right: Voxel[] } {
  const left: Voxel[] = [];
  const right: Voxel[] = [];

  for (const voxel of voxels) {
    const value = axis === "x" ? voxel.x : axis === "y" ? voxel.y : voxel.z;
    if (value <= split) {
      left.push(voxel);
    } else {
      right.push(voxel);
    }
  }

  return { left, right };
}

function boxSignature(box: VoxelBox): string {
  const b = box.bounds;
  return `${b.minX}:${b.minY}:${b.minZ}:${b.maxX}:${b.maxY}:${b.maxZ}:${box.occupied}`;
}

function computeImmediateGain(
  parent: VoxelBox,
  left: VoxelBox,
  right: VoxelBox,
  boxPenalty: number
): number | null {
  const leftFill = left.occupied / Math.max(1, left.volume);
  const rightFill = right.occupied / Math.max(1, right.volume);
  if (leftFill < 0.08 || rightFill < 0.08) {
    return null;
  }

  const emptyReduction = parent.empty - (left.empty + right.empty);
  const balance =
    Math.min(left.occupied, right.occupied) /
    Math.max(1, Math.max(left.occupied, right.occupied));
  const balancePenalty = (1 - balance) * boxPenalty * 0.25;
  return emptyReduction - boxPenalty - balancePenalty;
}

function estimateBestImmediateGain(
  box: VoxelBox,
  boxPenalty: number,
  cache: Map<string, number>
): number {
  const key = boxSignature(box);
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  let bestGain = Number.NEGATIVE_INFINITY;
  for (const axis of ["x", "y", "z"] as const) {
    const candidates = chooseSplitPositions(box, axis);
    for (const split of candidates) {
      const partition = splitVoxels(box.voxels, axis, split);
      if (
        partition.left.length < MIN_SPLIT_PART_VOXELS ||
        partition.right.length < MIN_SPLIT_PART_VOXELS
      ) {
        continue;
      }

      const left = createVoxelBox(-1, partition.left);
      const right = createVoxelBox(-1, partition.right);
      const gain = computeImmediateGain(box, left, right, boxPenalty);
      if (gain === null) {
        continue;
      }
      if (gain > bestGain) {
        bestGain = gain;
      }
    }
  }

  cache.set(key, bestGain);
  return bestGain;
}

function evaluateBestSplit(
  box: VoxelBox,
  boxPenalty: number,
  nextIdRef: { value: number },
  immediateGainCache: Map<string, number>
): SplitCandidate | null {
  let best: SplitCandidate | null = null;

  for (const axis of ["x", "y", "z"] as const) {
    const candidates = chooseSplitPositions(box, axis);
    for (const split of candidates) {
      const partition = splitVoxels(box.voxels, axis, split);
      if (
        partition.left.length < MIN_SPLIT_PART_VOXELS ||
        partition.right.length < MIN_SPLIT_PART_VOXELS
      ) {
        continue;
      }

      const left = createVoxelBox(-1, partition.left);
      const right = createVoxelBox(-1, partition.right);
      const immediateGain = computeImmediateGain(box, left, right, boxPenalty);
      if (immediateGain === null) {
        continue;
      }

      const leftBest = estimateBestImmediateGain(left, boxPenalty, immediateGainCache);
      const rightBest = estimateBestImmediateGain(right, boxPenalty, immediateGainCache);
      const futureGain =
        Math.max(0, Number.isFinite(leftBest) ? leftBest : Number.NEGATIVE_INFINITY) +
        Math.max(0, Number.isFinite(rightBest) ? rightBest : Number.NEGATIVE_INFINITY);
      const score = immediateGain + LOOKAHEAD_WEIGHT * futureGain;

      if (
        !best ||
        score > best.score ||
        (score === best.score && immediateGain > best.immediateGain)
      ) {
        best = { score, immediateGain, left, right };
      }
    }
  }

  if (!best || best.score <= 0) {
    return null;
  }

  best.left.id = nextIdRef.value;
  best.right.id = nextIdRef.value + 1;
  nextIdRef.value += 2;
  return best;
}

function worldMinMaxFromVoxelBounds(
  bounds: Bounds,
  voxelBounds: VoxelBounds,
  xSlices: number,
  ySlices: number,
  zSlices: number
): {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
} {
  const sizeX = Math.max(MIN_EDGE, bounds.maxX - bounds.minX);
  const sizeY = Math.max(MIN_EDGE, bounds.maxY - bounds.minY);
  const sizeZ = Math.max(MIN_EDGE, bounds.maxZ - bounds.minZ);

  const minX = bounds.minX + (voxelBounds.minX / xSlices) * sizeX;
  const minY = bounds.minY + (voxelBounds.minY / ySlices) * sizeY;
  const minZ = bounds.minZ + (voxelBounds.minZ / zSlices) * sizeZ;
  const maxX = bounds.minX + ((voxelBounds.maxX + 1) / xSlices) * sizeX;
  const maxY = bounds.minY + ((voxelBounds.maxY + 1) / ySlices) * sizeY;
  const maxZ = bounds.minZ + ((voxelBounds.maxZ + 1) / zSlices) * sizeZ;
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

function toWorldBoxPart(
  box: VoxelBox,
  bounds: Bounds,
  xSlices: number,
  ySlices: number,
  zSlices: number
): ObjectiveBoxPart {
  const world = worldMinMaxFromVoxelBounds(bounds, box.bounds, xSlices, ySlices, zSlices);
  const sizeX = Math.max(MIN_EDGE, world.maxX - world.minX);
  const sizeY = Math.max(MIN_EDGE, world.maxY - world.minY);
  const sizeZ = Math.max(MIN_EDGE, world.maxZ - world.minZ);

  return {
    position: [
      world.minX + sizeX * 0.5,
      world.minY + sizeY * 0.5,
      world.minZ + sizeZ * 0.5
    ],
    halfExtents: [sizeX * 0.5, sizeY * 0.5, sizeZ * 0.5]
  };
}

export function fitCompoundBoxesObjective(
  points: readonly ObjectivePoint3[]
): ObjectiveBoxPart[] {
  const bounds = computeBounds(points);
  if (!bounds) {
    return [];
  }

  const resolution = chooseAutoResolution(bounds, points.length);
  const voxels = voxelizePoints(
    points,
    bounds,
    resolution.xSlices,
    resolution.ySlices,
    resolution.zSlices
  );
  if (voxels.length === 0) {
    return [];
  }

  const boxPenalty = chooseBoxPenalty(voxels.length);
  const maxBoxes = chooseMaxBoxes(voxels.length);
  const nextIdRef = { value: 1 };
  const immediateGainCache = new Map<string, number>();
  const root = createVoxelBox(0, voxels);
  const boxes: VoxelBox[] = [root];

  while (boxes.length < maxBoxes) {
    let bestIndex = -1;
    let bestSplit: SplitCandidate | null = null;

    for (let i = 0; i < boxes.length; i += 1) {
      const split = evaluateBestSplit(
        boxes[i],
        boxPenalty,
        nextIdRef,
        immediateGainCache
      );
      if (!split) {
        continue;
      }
      if (
        !bestSplit ||
        split.score > bestSplit.score ||
        (split.score === bestSplit.score && split.immediateGain > bestSplit.immediateGain)
      ) {
        bestSplit = split;
        bestIndex = i;
      }
    }

    if (!bestSplit || bestIndex < 0) {
      break;
    }

    boxes.splice(bestIndex, 1, bestSplit.left, bestSplit.right);
  }

  boxes.sort((a, b) => b.volume - a.volume);
  return boxes.map((box) =>
    toWorldBoxPart(
      box,
      bounds,
      resolution.xSlices,
      resolution.ySlices,
      resolution.zSlices
    )
  );
}
