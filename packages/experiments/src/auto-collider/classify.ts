import type {
  ColliderClassification,
  ColliderClassScore,
  ColliderMetrics
} from "./types";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function scoreBoxyFurniture(metrics: ColliderMetrics): number {
  return clamp(
    0.5 * metrics.planarity +
      0.2 * (1 - metrics.noiseScore) +
      0.18 * (1 - metrics.concavityProxy) +
      0.12 * (1 - metrics.cavityScore),
    0,
    1
  );
}

function scoreConcaveFurniture(metrics: ColliderMetrics): number {
  return clamp(
    0.42 * metrics.cavityScore +
      0.28 * metrics.concavityProxy +
      0.2 * metrics.planarity +
      0.1 * metrics.layerScore -
      0.12 * metrics.noiseScore,
    0,
    1
  );
}

export function classifyMetrics(metrics: ColliderMetrics): ColliderClassification {
  const scores: ColliderClassScore[] = [
    {
      kind: "BoxyFurniture" as const,
      score: scoreBoxyFurniture(metrics)
    },
    {
      kind: "ConcaveFurniture" as const,
      score: scoreConcaveFurniture(metrics)
    }
  ].sort((a, b) => b.score - a.score);

  const top = scores[0];
  const second = scores[1] ?? { score: 0 };
  const confidence = clamp(top.score * 0.7 + (top.score - second.score) * 0.9, 0, 1);
  const lowConfidenceFallback = confidence < 0.4;
  const strategyOrder: ColliderClassification["strategyOrder"] =
    top.kind === "ConcaveFurniture"
      ? ["concave-furniture", "boxy-furniture"]
      : ["boxy-furniture", "concave-furniture"];

  return {
    selected: top.kind,
    confidence,
    scores,
    lowConfidenceFallback,
    strategyOrder
  };
}
