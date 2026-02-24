import * as THREE from "three";
import type { Point3 } from "../fit/compound-boxes";
import { fitCompoundBoxesHybrid } from "../fit/compound-boxes";
import type { RapierCompoundPart, StrategyContext, StrategyResult } from "../types";
import { choosePartBudget, downsamplePoints, limitCompoundParts, tuple } from "./common";

function toPoint3Array(context: StrategyContext): Point3[] {
  const source = context.prepared.points.length > 0 ? context.prepared.points : context.prepared.samples;
  const points = downsamplePoints(source, 7000);
  return points.map((point) => ({ x: point.x, y: point.y, z: point.z }));
}

function fallbackAabbPart(context: StrategyContext): RapierCompoundPart {
  const center = context.prepared.bounds.getCenter(new THREE.Vector3());
  const half = context.prepared.bounds
    .getSize(new THREE.Vector3())
    .multiplyScalar(0.5);
  return {
    kind: "box",
    position: tuple(center.x, center.y, center.z),
    halfExtents: tuple(
      Math.max(0.005, half.x),
      Math.max(0.005, half.y),
      Math.max(0.005, half.z)
    )
  };
}

export function generateBoxyFurnitureStrategy(
  context: StrategyContext
): StrategyResult {
  const points = toPoint3Array(context);
  const fit = fitCompoundBoxesHybrid(points);

  const rawParts: RapierCompoundPart[] = fit.parts.map((part) => ({
    kind: "box",
    position: tuple(part.position[0], part.position[1], part.position[2]),
    halfExtents: tuple(part.halfExtents[0], part.halfExtents[1], part.halfExtents[2])
  }));

  const maxParts = choosePartBudget(context.metrics.diagonal, context.options.budget);
  const limited = limitCompoundParts(rawParts, maxParts);

  return {
    kind: "boxy-furniture",
    rapier: {
      type: "compound",
      parts: limited.length > 0 ? limited : [fallbackAabbPart(context)]
    }
  };
}
