import * as THREE from "three";
import type { StrategyContext, StrategyResult } from "../types";
import { downsamplePoints, getBoundsCorners, tuple } from "./common";

function collectConvexCandidatePoints(context: StrategyContext): THREE.Vector3[] {
  const preferred =
    context.prepared.samples.length >= 8
      ? context.prepared.samples
      : context.prepared.points;

  const maxPoints = context.options.budget === "strict" ? 192 : 320;
  const sampled = downsamplePoints(preferred, maxPoints);
  if (sampled.length >= 4) {
    return sampled;
  }

  return getBoundsCorners(context.prepared.bounds);
}

export function generateSingleConvexStrategy(
  context: StrategyContext
): StrategyResult {
  const points = collectConvexCandidatePoints(context);
  const bounds = new THREE.Box3();
  for (const point of points) {
    bounds.expandByPoint(point);
  }
  const center = bounds.getCenter(new THREE.Vector3());

  const centered = points.map((point) =>
    tuple(point.x - center.x, point.y - center.y, point.z - center.z)
  );

  return {
    kind: "single-convex",
    rapier: {
      type: "convex",
      points: centered,
      rootOffset: tuple(-center.x, -center.y, -center.z)
    }
  };
}
