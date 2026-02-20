import type { PropClassification } from "../types";
import { clamp01 } from "./math";
import { buildVoxelGridFromPoints, computeColumnGapRatio } from "./voxel";
import type { NormalizedProp } from "../types";

function pickSizeClass(longestAxis: number): PropClassification["labels"]["size"] {
  if (longestAxis < 0.4) {
    return "small";
  }
  if (longestAxis < 1.2) {
    return "medium";
  }
  return "large";
}

function pickComplexityClass(
  triangleCount: number
): PropClassification["labels"]["complexity"] {
  if (triangleCount < 1500) {
    return "low";
  }
  if (triangleCount < 8000) {
    return "medium";
  }
  return "high";
}

function pickSlendernessClass(
  slenderness: number
): PropClassification["labels"]["slenderness"] {
  if (slenderness >= 4) {
    return "very-slender";
  }
  if (slenderness >= 2) {
    return "slender";
  }
  return "chunky";
}

function pickConcavityClass(
  concavityHint: number
): PropClassification["labels"]["concavity"] {
  if (concavityHint >= 0.36) {
    return "high";
  }
  if (concavityHint >= 0.18) {
    return "medium";
  }
  return "low";
}

function pickFlatnessClass(
  flatnessScore: number
): PropClassification["labels"]["flatness"] {
  if (flatnessScore >= 0.55) {
    return "high";
  }
  if (flatnessScore >= 0.3) {
    return "medium";
  }
  return "low";
}

export function classifyProp(prop: NormalizedProp): PropClassification {
  const width = prop.bbox.size[0];
  const height = prop.bbox.size[1];
  const depth = prop.bbox.size[2];
  const longestAxis = Math.max(width, height, depth, 1e-6);
  const shortestAxis = Math.max(Math.min(width, height, depth), 1e-6);
  const slenderness = longestAxis / shortestAxis;
  const bboxVolume = prop.bbox.volume;
  const compactness =
    bboxVolume > 1e-9 ? clamp01(prop.meshVolume / bboxVolume) : 0;

  const baseBand = Math.max(0.01, height * 0.06);
  const pointCountSafe = Math.max(1, prop.points.length);
  const baseContactCount = prop.points.filter(
    (point) => point[1] <= prop.bbox.min[1] + baseBand
  ).length;
  const baseContactRatio = baseContactCount / pointCountSafe;

  let baseTriangleArea = 0;
  let baseUpArea = 0;
  for (const triangle of prop.triangles) {
    if (triangle.centroid[1] > prop.bbox.min[1] + baseBand * 1.4) {
      continue;
    }
    baseTriangleArea += triangle.area;
    if (triangle.normal[1] >= 0.65) {
      baseUpArea += triangle.area;
    }
  }
  const baseUpwardRatio =
    baseTriangleArea > 1e-6 ? baseUpArea / baseTriangleArea : 0;

  const footprint = Math.max(1e-6, Math.max(width, depth));
  const squatness = 1 - clamp01(height / footprint);
  const flatnessScore = clamp01(
    baseContactRatio * 0.45 + baseUpwardRatio * 0.35 + squatness * 0.2
  );

  const complexityNorm = clamp01((prop.triangleCount - 1500) / 14500);
  const axisAnisotropy = clamp01(Math.abs(width - depth) / Math.max(width, depth, 1e-6));

  const voxels = buildVoxelGridFromPoints(prop.points, prop.bbox, 24, 1);
  const columnGapRatio = computeColumnGapRatio(voxels);
  const volumeConcavity = clamp01(1 - compactness);
  const concavityHint = clamp01(volumeConcavity * 0.9 + columnGapRatio * 0.1);

  return {
    labels: {
      size: pickSizeClass(prop.sourceBounds.longestAxis),
      complexity: pickComplexityClass(prop.triangleCount),
      slenderness: pickSlendernessClass(slenderness),
      concavity: pickConcavityClass(concavityHint),
      flatness: pickFlatnessClass(flatnessScore)
    },
    metrics: {
      width,
      height,
      depth,
      longestAxis,
      shortestAxis,
      bboxVolume,
      meshVolume: prop.meshVolume,
      compactness,
      triangleCount: prop.triangleCount,
      pointCount: prop.pointCount,
      slenderness,
      complexityNorm,
      concavityHint,
      baseContactRatio,
      baseUpwardRatio,
      flatnessScore,
      axisAnisotropy
    }
  };
}
