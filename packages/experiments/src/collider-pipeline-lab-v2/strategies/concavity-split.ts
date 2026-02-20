import { clamp, clamp01 } from "../pipeline/math";
import {
  buildVoxelGridFromPoints,
  voxelIndex
} from "../pipeline/voxel";
import type { BoundingBox, StrategyGenerator, Vec3Tuple, VoxelGrid } from "../types";
import { axisAlignedPartFromBounds, sanitizeParts } from "./common";

type Axis = 0 | 1 | 2;

type VoxelCell = {
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

type NodeEval = {
  occupied: number;
  volume: number;
  concavity: number;
};

type SplitNode = {
  voxels: VoxelCell[];
  bounds: VoxelBounds;
  eval: NodeEval;
  depth: number;
};

type SplitCandidate = {
  leafIndex: number;
  gain: number;
  left: SplitNode;
  right: SplitNode;
};

function axisValue(voxel: VoxelCell, axis: Axis): number {
  if (axis === 0) {
    return voxel.x;
  }
  if (axis === 1) {
    return voxel.y;
  }
  return voxel.z;
}

function voxelBoundsVolume(bounds: VoxelBounds): number {
  const sx = bounds.maxX - bounds.minX + 1;
  const sy = bounds.maxY - bounds.minY + 1;
  const sz = bounds.maxZ - bounds.minZ + 1;
  return Math.max(1, sx * sy * sz);
}

function boundsForVoxels(voxels: VoxelCell[]): VoxelBounds {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (const voxel of voxels) {
    minX = Math.min(minX, voxel.x);
    minY = Math.min(minY, voxel.y);
    minZ = Math.min(minZ, voxel.z);
    maxX = Math.max(maxX, voxel.x);
    maxY = Math.max(maxY, voxel.y);
    maxZ = Math.max(maxZ, voxel.z);
  }

  return {
    minX,
    minY,
    minZ,
    maxX,
    maxY,
    maxZ
  };
}

function evaluateNode(voxels: VoxelCell[], bounds: VoxelBounds): NodeEval {
  const occupied = voxels.length;
  const volume = voxelBoundsVolume(bounds);
  const fillRatio = occupied / Math.max(1, volume);
  // Concavity proxy: empty volume inside the node's tight axis-aligned envelope.
  const concavity = clamp01(1 - fillRatio);
  return {
    occupied,
    volume,
    concavity
  };
}

function makeNode(voxels: VoxelCell[], depth: number): SplitNode {
  const bounds = boundsForVoxels(voxels);
  return {
    voxels,
    bounds,
    eval: evaluateNode(voxels, bounds),
    depth
  };
}

function candidateSplitsForAxis(
  node: SplitNode,
  axis: Axis,
  maxCandidates: number
): number[] {
  const values = node.voxels.map((voxel) => axisValue(voxel, axis));
  if (values.length <= 4) {
    return [];
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max <= min) {
    return [];
  }

  const cuts = new Set<number>();
  const sorted = [...values].sort((a, b) => a - b);

  const quantileCount = Math.max(3, Math.floor(maxCandidates));
  for (let i = 1; i <= quantileCount; i += 1) {
    const t = i / (quantileCount + 1);
    const index = Math.floor(t * (sorted.length - 1));
    const cut = sorted[index] ?? min;
    if (cut >= min && cut < max) {
      cuts.add(cut);
    }
  }

  const span = max - min;
  const step = Math.max(1, Math.floor(span / Math.max(2, maxCandidates)));
  for (let cut = min; cut < max; cut += step) {
    cuts.add(cut);
  }

  const histogram = new Array(span + 1).fill(0);
  for (const value of values) {
    histogram[value - min] += 1;
  }
  const valleys: Array<{ cut: number; score: number }> = [];
  for (let i = 1; i < histogram.length - 1; i += 1) {
    const prev = histogram[i - 1] ?? 0;
    const curr = histogram[i] ?? 0;
    const next = histogram[i + 1] ?? 0;
    if (curr <= prev && curr <= next) {
      const cut = min + i;
      if (cut >= min && cut < max) {
        valleys.push({ cut, score: curr });
      }
    }
  }
  valleys.sort((a, b) => a.score - b.score);
  for (const valley of valleys.slice(0, Math.max(2, Math.floor(maxCandidates / 2)))) {
    cuts.add(valley.cut);
  }

  return [...cuts]
    .filter((cut) => cut >= min && cut < max)
    .sort((a, b) => a - b)
    .slice(0, Math.max(2, Math.floor(maxCandidates)));
}

function splitNodeByPlane(
  node: SplitNode,
  axis: Axis,
  split: number,
  minLeafVoxels: number
): { left: SplitNode; right: SplitNode } | null {
  const leftVoxels: VoxelCell[] = [];
  const rightVoxels: VoxelCell[] = [];

  for (const voxel of node.voxels) {
    if (axisValue(voxel, axis) <= split) {
      leftVoxels.push(voxel);
    } else {
      rightVoxels.push(voxel);
    }
  }

  if (leftVoxels.length < minLeafVoxels || rightVoxels.length < minLeafVoxels) {
    return null;
  }

  return {
    left: makeNode(leftVoxels, node.depth + 1),
    right: makeNode(rightVoxels, node.depth + 1)
  };
}

function splitGain(
  node: SplitNode,
  left: SplitNode,
  right: SplitNode,
  complexityPenalty: number
): number {
  const total = Math.max(1, left.eval.occupied + right.eval.occupied);
  const weightedChildConcavity =
    (left.eval.concavity * left.eval.occupied + right.eval.concavity * right.eval.occupied) /
    total;

  const concavityReduction = node.eval.concavity - weightedChildConcavity;

  const balancePenalty =
    (Math.abs(left.eval.occupied - right.eval.occupied) / total) * 0.05;
  const splitComplexityPenalty = complexityPenalty;

  return concavityReduction - balancePenalty - splitComplexityPenalty;
}

function worldBoundsFromVoxelBounds(
  bounds: VoxelBounds,
  grid: VoxelGrid
): { min: Vec3Tuple; max: Vec3Tuple } {
  const step: Vec3Tuple = [
    grid.size[0] / grid.resolution,
    grid.size[1] / grid.resolution,
    grid.size[2] / grid.resolution
  ];

  const min: Vec3Tuple = [
    grid.min[0] + bounds.minX * step[0],
    grid.min[1] + bounds.minY * step[1],
    grid.min[2] + bounds.minZ * step[2]
  ];

  const max: Vec3Tuple = [
    grid.min[0] + (bounds.maxX + 1) * step[0],
    grid.min[1] + (bounds.maxY + 1) * step[1],
    grid.min[2] + (bounds.maxZ + 1) * step[2]
  ];

  return { min, max };
}

function collectOccupiedVoxels(
  points: Vec3Tuple[],
  bbox: BoundingBox,
  resolution: number
): { voxels: VoxelCell[]; grid: VoxelGrid } {
  const grid = buildVoxelGridFromPoints(points, bbox, resolution, 1);
  const voxels: VoxelCell[] = [];

  for (let z = 0; z < grid.resolution; z += 1) {
    for (let y = 0; y < grid.resolution; y += 1) {
      for (let x = 0; x < grid.resolution; x += 1) {
        const index = voxelIndex(grid.resolution, x, y, z);
        if (grid.occupied[index] === 0) {
          continue;
        }
        voxels.push({
          x,
          y,
          z
        });
      }
    }
  }

  return { voxels, grid };
}

export const generateConcavitySplitCollider: StrategyGenerator<"concavity-split"> = (
  prop,
  params
) => {
  const resolution = Math.max(8, Math.floor(params.resolution));
  const { voxels, grid } = collectOccupiedVoxels(prop.points, prop.bbox, resolution);
  if (voxels.length <= 0) {
    return [axisAlignedPartFromBounds(prop.bbox.min, prop.bbox.max, params.inflate)];
  }

  const maxParts = Math.max(1, Math.floor(params.maxParts));
  const maxDepth = Math.max(1, Math.floor(params.maxDepth));
  const minLeafVoxels = Math.max(4, Math.floor(params.minLeafVoxels));
  const splitCandidates = Math.max(2, Math.floor(params.splitCandidates));
  const concavityThreshold = clamp(params.concavityThreshold, 0.01, 0.95);
  const minConcavityGain = clamp(params.minConcavityGain, 0, 0.5);
  const complexityPenalty = clamp(params.complexityPenalty, 0, 0.2);

  const leaves: SplitNode[] = [makeNode(voxels, 0)];

  while (leaves.length < maxParts) {
    let best: SplitCandidate | null = null;

    for (let leafIndex = 0; leafIndex < leaves.length; leafIndex += 1) {
      const leaf = leaves[leafIndex];
      if (leaf.depth >= maxDepth) {
        continue;
      }
      if (leaf.eval.concavity <= concavityThreshold) {
        continue;
      }
      if (leaf.voxels.length < minLeafVoxels * 2) {
        continue;
      }

      for (const axis of [0, 1, 2] as const) {
        const cuts = candidateSplitsForAxis(leaf, axis, splitCandidates);
        for (const cut of cuts) {
          const split = splitNodeByPlane(leaf, axis, cut, minLeafVoxels);
          if (!split) {
            continue;
          }

          const gain = splitGain(leaf, split.left, split.right, complexityPenalty);
          if (!best || gain > best.gain) {
            best = {
              leafIndex,
              gain,
              left: split.left,
              right: split.right
            };
          }
        }
      }
    }

    if (!best || best.gain < minConcavityGain) {
      break;
    }

    leaves.splice(best.leafIndex, 1, best.left, best.right);
  }

  const parts = leaves.map((leaf) => {
    const world = worldBoundsFromVoxelBounds(leaf.bounds, grid);
    return axisAlignedPartFromBounds(world.min, world.max, params.inflate);
  });

  if (parts.length <= 0) {
    return [axisAlignedPartFromBounds(prop.bbox.min, prop.bbox.max, params.inflate)];
  }

  return sanitizeParts(parts)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, maxParts);
};
