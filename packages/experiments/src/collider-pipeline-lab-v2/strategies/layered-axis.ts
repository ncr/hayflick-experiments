import type { StrategyGenerator, Vec3Tuple } from "../types";
import { axisAlignedPartFromBounds, sanitizeParts } from "./common";

type LayerAxis = "x" | "y" | "z";

type LayerAccum = {
  count: number;
  min: Vec3Tuple;
  max: Vec3Tuple;
};

function axisIndex(axis: LayerAxis): number {
  switch (axis) {
    case "x":
      return 0;
    case "y":
      return 1;
    case "z":
      return 2;
  }
}

function emptyLayer(): LayerAccum {
  return {
    count: 0,
    min: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
    max: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]
  };
}

function includePoint(layer: LayerAccum, point: Vec3Tuple): void {
  layer.count += 1;
  layer.min[0] = Math.min(layer.min[0], point[0]);
  layer.min[1] = Math.min(layer.min[1], point[1]);
  layer.min[2] = Math.min(layer.min[2], point[2]);
  layer.max[0] = Math.max(layer.max[0], point[0]);
  layer.max[1] = Math.max(layer.max[1], point[1]);
  layer.max[2] = Math.max(layer.max[2], point[2]);
}

function mergeLayer(target: LayerAccum, source: LayerAccum): LayerAccum {
  if (source.count <= 0) {
    return target;
  }
  if (target.count <= 0) {
    return { ...source, min: [...source.min] as Vec3Tuple, max: [...source.max] as Vec3Tuple };
  }
  return {
    count: target.count + source.count,
    min: [
      Math.min(target.min[0], source.min[0]),
      Math.min(target.min[1], source.min[1]),
      Math.min(target.min[2], source.min[2])
    ],
    max: [
      Math.max(target.max[0], source.max[0]),
      Math.max(target.max[1], source.max[1]),
      Math.max(target.max[2], source.max[2])
    ]
  };
}

function mergeSmallLayers(layers: LayerAccum[], minPoints: number): LayerAccum[] {
  if (layers.length <= 1) {
    return layers;
  }
  const result = layers.map((layer) => ({
    ...layer,
    min: [...layer.min] as Vec3Tuple,
    max: [...layer.max] as Vec3Tuple
  }));

  for (let i = 0; i < result.length; i += 1) {
    const layer = result[i];
    if (layer.count <= 0 || layer.count >= minPoints) {
      continue;
    }

    let mergeIndex = -1;
    if (i > 0 && result[i - 1].count > 0) {
      mergeIndex = i - 1;
    } else if (i + 1 < result.length && result[i + 1].count > 0) {
      mergeIndex = i + 1;
    }

    if (mergeIndex >= 0) {
      result[mergeIndex] = mergeLayer(result[mergeIndex], layer);
      result[i] = emptyLayer();
    }
  }

  return result.filter((layer) => layer.count > 0);
}

function similarityScore(a: LayerAccum, b: LayerAccum, axis: LayerAxis): number {
  const index = axisIndex(axis);
  const otherIndices = [0, 1, 2].filter((value) => value !== index);

  const centerA0 = (a.min[otherIndices[0]] + a.max[otherIndices[0]]) * 0.5;
  const centerA1 = (a.min[otherIndices[1]] + a.max[otherIndices[1]]) * 0.5;
  const centerB0 = (b.min[otherIndices[0]] + b.max[otherIndices[0]]) * 0.5;
  const centerB1 = (b.min[otherIndices[1]] + b.max[otherIndices[1]]) * 0.5;

  const spanA0 = Math.max(1e-6, a.max[otherIndices[0]] - a.min[otherIndices[0]]);
  const spanA1 = Math.max(1e-6, a.max[otherIndices[1]] - a.min[otherIndices[1]]);
  const spanB0 = Math.max(1e-6, b.max[otherIndices[0]] - b.min[otherIndices[0]]);
  const spanB1 = Math.max(1e-6, b.max[otherIndices[1]] - b.min[otherIndices[1]]);

  const avg0 = (spanA0 + spanB0) * 0.5;
  const avg1 = (spanA1 + spanB1) * 0.5;
  const deltaCenter0 = Math.abs(centerA0 - centerB0) / avg0;
  const deltaCenter1 = Math.abs(centerA1 - centerB1) / avg1;
  const deltaSpan0 = Math.abs(spanA0 - spanB0) / avg0;
  const deltaSpan1 = Math.abs(spanA1 - spanB1) / avg1;
  return (deltaCenter0 + deltaCenter1 + deltaSpan0 + deltaSpan1) * 0.25;
}

function mergeSimilarAdjacentLayers(
  layers: LayerAccum[],
  threshold: number,
  axis: LayerAxis
): LayerAccum[] {
  if (layers.length <= 1) {
    return layers;
  }

  const result = [...layers];
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i + 1 < result.length; i += 1) {
      const score = similarityScore(result[i], result[i + 1], axis);
      if (score > threshold) {
        continue;
      }
      result.splice(i, 2, mergeLayer(result[i], result[i + 1]));
      merged = true;
      break;
    }
  }
  return result;
}

type LayeredParams = {
  layerCount: number;
  minPointsPerLayer: number;
  mergeSimilarity: number;
  inflate: number;
};

export function generateLayeredAxisCollider(
  axis: LayerAxis
): StrategyGenerator<"layered-y" | "layered-x" | "layered-z"> {
  return (prop, params: LayeredParams) => {
    if (prop.points.length <= 0) {
      return [];
    }

    const layerCount = Math.max(1, Math.floor(params.layerCount));
    const minPoints = Math.max(1, Math.floor(params.minPointsPerLayer));
    const index = axisIndex(axis);
    const span = Math.max(1e-6, prop.bbox.size[index]);

    const layers: LayerAccum[] = Array.from({ length: layerCount }, () => emptyLayer());
    for (const point of prop.points) {
      const t = (point[index] - prop.bbox.min[index]) / span;
      const bucket = Math.min(layerCount - 1, Math.max(0, Math.floor(t * layerCount)));
      includePoint(layers[bucket], point);
    }

    const mergedSmall = mergeSmallLayers(layers, minPoints);
    const mergedAdjacent = mergeSimilarAdjacentLayers(
      mergedSmall,
      Math.max(0, params.mergeSimilarity),
      axis
    );
    const selectedLayers =
      mergedAdjacent.length <= 1 && mergedSmall.length > 1 ? mergedSmall : mergedAdjacent;

    const parts = selectedLayers.map((layer) =>
      axisAlignedPartFromBounds(layer.min, layer.max, params.inflate)
    );
    return sanitizeParts(parts);
  };
}
