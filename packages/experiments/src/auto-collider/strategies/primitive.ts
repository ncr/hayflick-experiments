import * as THREE from "three";
import type { StrategyContext, StrategyResult } from "../types";
import {
  clamp,
  percentile,
  primaryAxisFromSize,
  radialDistanceToAxis,
  tuple
} from "./common";

const MIN_RADIUS = 0.005;

export function generatePrimitiveStrategy(context: StrategyContext): StrategyResult {
  const bounds = context.prepared.bounds;
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const axis = primaryAxisFromSize(size);

  const radialDistances: number[] = [];
  const centerDistances: number[] = [];

  for (const point of context.prepared.points) {
    radialDistances.push(radialDistanceToAxis(point, center, axis));
    centerDistances.push(point.distanceTo(center));
  }

  const sphereRadius = Math.max(
    MIN_RADIUS,
    percentile(centerDistances, 1.0) * 1.01
  );

  const capsuleRadius = Math.max(
    MIN_RADIUS,
    percentile(radialDistances, 0.85) * 1.03
  );

  const majorHalf =
    axis === "x" ? size.x * 0.5 : axis === "y" ? size.y * 0.5 : size.z * 0.5;
  const capsuleHalfHeight = Math.max(0, majorHalf - capsuleRadius);

  const chooseCapsule =
    context.metrics.slenderness > 1.3 && capsuleHalfHeight > capsuleRadius * 0.18;

  if (chooseCapsule) {
    return {
      kind: "primitive",
      rapier: {
        type: "capsule",
        center: tuple(center.x, center.y, center.z),
        axis,
        radius: clamp(capsuleRadius, MIN_RADIUS, 1000),
        halfHeight: clamp(capsuleHalfHeight, 0, 1000)
      }
    };
  }

  return {
    kind: "primitive",
    rapier: {
      type: "ball",
      center: tuple(center.x, center.y, center.z),
      radius: clamp(sphereRadius, MIN_RADIUS, 1000)
    }
  };
}
