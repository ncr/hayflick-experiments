import type {
  ColliderClass,
  ColliderClassification,
  ColliderClassScore,
  ColliderMetrics,
  ColliderStrategyKind
} from "./types";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function scorePrimitive(metrics: ColliderMetrics): number {
  const [dx, dy, dz] = metrics.dims;
  const maxDim = Math.max(dx, dy, dz);
  const minDim = Math.min(dx, dy, dz);
  const roundness = clamp(1 - (maxDim - minDim) / Math.max(1e-5, maxDim), 0, 1);

  const capsuleLike = clamp((metrics.slenderness - 1.25) / 1.8, 0, 1);
  const sphereLike = roundness;

  const base = Math.max(
    sphereLike * (1 - metrics.planarity * 0.35),
    capsuleLike * (1 - metrics.cavityScore * 0.65)
  );

  return clamp(base * (1 - metrics.concavityProxy * 0.7) * (1 - metrics.layerScore * 0.4), 0, 1);
}

function scoreSingleConvex(metrics: ColliderMetrics): number {
  return clamp(
    0.58 * (1 - metrics.concavityProxy) +
      0.22 * metrics.planarity +
      0.2 * (1 - metrics.cavityScore),
    0,
    1
  );
}

function scoreBoxyFurniture(metrics: ColliderMetrics): number {
  return clamp(
    0.52 * metrics.planarity +
      0.2 * (1 - metrics.noiseScore) +
      0.16 * (1 - metrics.concavityProxy) +
      0.12 * (1 - metrics.cavityScore),
    0,
    1
  );
}

function scoreLayered(metrics: ColliderMetrics): number {
  return clamp(
    0.46 * metrics.layerScore +
      0.28 * metrics.planarity +
      0.16 * (1 - metrics.noiseScore) +
      0.1 * metrics.concavityProxy,
    0,
    1
  );
}

function scoreConcaveFurniture(metrics: ColliderMetrics): number {
  return clamp(
    0.42 * metrics.cavityScore +
      0.26 * metrics.concavityProxy +
      0.2 * metrics.planarity +
      0.12 * metrics.layerScore -
      0.14 * metrics.noiseScore,
    0,
    1
  );
}

function scoreHardNoisy(metrics: ColliderMetrics): number {
  return clamp(
    0.55 * metrics.noiseScore +
      0.25 * (1 - metrics.planarity) +
      0.2 * metrics.concavityProxy,
    0,
    1
  );
}

function toStrategy(kind: ColliderClass): ColliderStrategyKind {
  switch (kind) {
    case "Primitive":
      return "primitive";
    case "SingleConvex":
      return "single-convex";
    case "BoxyFurniture":
      return "boxy-furniture";
    case "Layered":
      return "boxy-furniture";
    case "ConcaveFurniture":
      return "concave-furniture";
    case "HardNoisy":
      return "hard-noisy";
  }
}

function fallbackOrderForClass(kind: ColliderClass): ColliderStrategyKind[] {
  switch (kind) {
    case "Primitive":
      return [
        "primitive",
        "single-convex",
        "boxy-furniture",
        "concave-furniture",
        "hard-noisy"
      ];
    case "SingleConvex":
      return [
        "single-convex",
        "boxy-furniture",
        "concave-furniture",
        "hard-noisy",
        "primitive"
      ];
    case "BoxyFurniture":
      return [
        "boxy-furniture",
        "concave-furniture",
        "single-convex",
        "primitive",
        "hard-noisy"
      ];
    case "Layered":
      return [
        "boxy-furniture",
        "concave-furniture",
        "single-convex",
        "primitive",
        "hard-noisy"
      ];
    case "ConcaveFurniture":
      return [
        "concave-furniture",
        "boxy-furniture",
        "single-convex",
        "hard-noisy",
        "primitive"
      ];
    case "HardNoisy":
      return [
        "hard-noisy",
        "concave-furniture",
        "single-convex",
        "boxy-furniture",
        "primitive"
      ];
  }
}

function uniqueOrder(order: readonly ColliderStrategyKind[]): ColliderStrategyKind[] {
  const seen = new Set<ColliderStrategyKind>();
  const result: ColliderStrategyKind[] = [];
  for (const item of order) {
    if (seen.has(item)) {
      continue;
    }
    seen.add(item);
    result.push(item);
  }
  return result;
}

export function classifyMetrics(metrics: ColliderMetrics): ColliderClassification {
  const scores: ColliderClassScore[] = [
    { kind: "Primitive", score: scorePrimitive(metrics) },
    { kind: "SingleConvex", score: scoreSingleConvex(metrics) },
    { kind: "BoxyFurniture", score: scoreBoxyFurniture(metrics) },
    { kind: "Layered", score: scoreLayered(metrics) },
    { kind: "ConcaveFurniture", score: scoreConcaveFurniture(metrics) },
    { kind: "HardNoisy", score: scoreHardNoisy(metrics) }
  ];

  scores.sort((a, b) => b.score - a.score);

  const top = scores[0];
  const second = scores[1] ?? { score: 0 };
  const confidence = clamp(top.score * 0.65 + (top.score - second.score) * 0.85, 0, 1);
  const lowConfidenceFallback = confidence < 0.44;

  const fallbackDefault: ColliderStrategyKind[] = [
    "primitive",
    "single-convex",
    "boxy-furniture",
    "concave-furniture",
    "hard-noisy"
  ];

  const strategyOrder = lowConfidenceFallback
    ? fallbackDefault
    : uniqueOrder([toStrategy(top.kind), ...fallbackOrderForClass(top.kind)]);

  return {
    selected: top.kind,
    confidence,
    scores,
    lowConfidenceFallback,
    strategyOrder
  };
}
