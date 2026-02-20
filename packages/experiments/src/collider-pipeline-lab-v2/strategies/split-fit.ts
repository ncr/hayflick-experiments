import type { BoundingBox, StrategyGenerator, Vec3Tuple } from "../types";
import { bboxFromPoints } from "../pipeline/math";
import { axisAlignedPartFromBounds, compactPartCount, sanitizeParts } from "./common";

type SplitNode = {
  points: Vec3Tuple[];
  bounds: BoundingBox;
  depth: number;
};

type SplitCandidate = {
  gain: number;
  left: SplitNode;
  right: SplitNode;
};

function evaluateBestSplit(
  node: SplitNode,
  minPointsPerChild: number
): SplitCandidate | null {
  if (node.points.length < minPointsPerChild * 2) {
    return null;
  }
  const parentVolume = Math.max(1e-9, node.bounds.volume);
  const quantiles = [0.35, 0.5, 0.65];
  let best: SplitCandidate | null = null;

  for (let axis = 0; axis < 3; axis += 1) {
    const sorted = [...node.points].sort((a, b) => a[axis] - b[axis]);
    for (const quantile of quantiles) {
      const index = Math.max(
        minPointsPerChild,
        Math.min(
          sorted.length - minPointsPerChild,
          Math.floor(sorted.length * quantile)
        )
      );
      const cut = sorted[index][axis];
      const leftPoints: Vec3Tuple[] = [];
      const rightPoints: Vec3Tuple[] = [];
      for (const point of node.points) {
        if (point[axis] <= cut) {
          leftPoints.push(point);
        } else {
          rightPoints.push(point);
        }
      }
      if (
        leftPoints.length < minPointsPerChild ||
        rightPoints.length < minPointsPerChild
      ) {
        continue;
      }

      const leftBounds = bboxFromPoints(leftPoints);
      const rightBounds = bboxFromPoints(rightPoints);
      const childVolume = leftBounds.volume + rightBounds.volume;
      let gain = (parentVolume - childVolume) / parentVolume;

      const balancePenalty =
        Math.abs(leftPoints.length - rightPoints.length) / node.points.length;
      gain -= balancePenalty * 0.08;

      if (!best || gain > best.gain) {
        best = {
          gain,
          left: {
            points: leftPoints,
            bounds: leftBounds,
            depth: node.depth + 1
          },
          right: {
            points: rightPoints,
            bounds: rightBounds,
            depth: node.depth + 1
          }
        };
      }
    }
  }

  return best;
}

export const generateSplitFitCollider: StrategyGenerator<"split-fit"> = (
  prop,
  params
) => {
  if (prop.points.length <= 0) {
    return [];
  }

  const maxDepth = Math.max(1, Math.floor(params.maxDepth));
  const maxParts = Math.max(1, Math.floor(params.maxParts));
  const minGain = Math.max(0, params.minGain);
  const minPointsPerChild = Math.max(20, Math.floor(prop.points.length / 80));

  const leaves: SplitNode[] = [
    {
      points: prop.points,
      bounds: prop.bbox,
      depth: 0
    }
  ];

  while (leaves.length < maxParts) {
    let bestLeafIndex = -1;
    let bestCandidate: SplitCandidate | null = null;

    for (let i = 0; i < leaves.length; i += 1) {
      const leaf = leaves[i];
      if (leaf.depth >= maxDepth) {
        continue;
      }
      const candidate = evaluateBestSplit(leaf, minPointsPerChild);
      if (!candidate) {
        continue;
      }
      if (candidate.gain < minGain) {
        continue;
      }
      if (!bestCandidate || candidate.gain > bestCandidate.gain) {
        bestCandidate = candidate;
        bestLeafIndex = i;
      }
    }

    if (!bestCandidate || bestLeafIndex < 0) {
      break;
    }

    leaves.splice(bestLeafIndex, 1, bestCandidate.left, bestCandidate.right);
  }

  const parts = leaves.map((leaf) =>
    axisAlignedPartFromBounds(leaf.bounds.min, leaf.bounds.max, params.inflate)
  );
  return compactPartCount(
    sanitizeParts(parts),
    Math.max(1, Math.floor(params.maxParts))
  );
};

