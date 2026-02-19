import * as THREE from "three";
import { classifyMetrics } from "./classify";
import { evaluateColliderError } from "./error-metric";
import { computeMetrics } from "./metrics";
import { collectRootLocalGeometry, preprocessGeometry } from "./preprocess";
import { generateBoxyFurnitureStrategy } from "./strategies/boxy-furniture";
import { tuple } from "./strategies/common";
import { generateConcaveFurnitureStrategy } from "./strategies/concave-furniture";
import type {
  ColliderErrorMetrics,
  ColliderResult,
  ColliderStrategyKind,
  GenerateColliderOptions,
  RapierColliderDescription,
  StrategyContext,
  StrategyResult
} from "./types";

function withDefaults(options?: GenerateColliderOptions): Required<GenerateColliderOptions> {
  return {
    mode: options?.mode ?? "dynamic",
    budget: options?.budget ?? "strict",
    debug: options?.debug ?? false
  };
}

function partCountForCollider(collider: RapierColliderDescription): number {
  return collider.parts.length;
}

function maxAllowedOutsideRatio(options: Required<GenerateColliderOptions>): number {
  if (options.mode === "dynamic") {
    return options.budget === "strict" ? 0.08 : 0.11;
  }
  return options.budget === "strict" ? 0.11 : 0.15;
}

function strategyByKind(kind: ColliderStrategyKind, context: StrategyContext): StrategyResult {
  if (kind === "concave-furniture") {
    return generateConcaveFurnitureStrategy(context);
  }
  return generateBoxyFurnitureStrategy(context);
}

function scoreCandidate(
  collider: RapierColliderDescription,
  error: ColliderErrorMetrics
): number {
  const partPenalty = Math.max(0, collider.parts.length - 8) * 0.012;
  return (
    error.outsideRatio +
    error.meanOutsideDistance * 0.32 +
    error.overfillRatio * 0.38 +
    partPenalty
  );
}

function roundedTuple(tuple3: [number, number, number]): [number, number, number] {
  return [
    Number(tuple3[0].toFixed(4)),
    Number(tuple3[1].toFixed(4)),
    Number(tuple3[2].toFixed(4))
  ];
}

function colliderSignature(collider: RapierColliderDescription): string {
  return JSON.stringify({
    type: "compound",
    parts: collider.parts
      .map((part) => ({
        position: roundedTuple(part.position),
        halfExtents: roundedTuple(part.halfExtents)
      }))
      .sort((a, b) =>
        a.position[0] !== b.position[0]
          ? a.position[0] - b.position[0]
          : a.position[1] !== b.position[1]
            ? a.position[1] - b.position[1]
            : a.position[2] - b.position[2]
      )
  });
}

function buildDebugObject(collider: RapierColliderDescription): THREE.Object3D {
  const material = new THREE.MeshBasicMaterial({
    color: 0x6fd3ff,
    transparent: true,
    opacity: 0.42,
    wireframe: true
  });

  const group = new THREE.Group();
  for (const part of collider.parts) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(
        Math.max(0.0001, part.halfExtents[0] * 2),
        Math.max(0.0001, part.halfExtents[1] * 2),
        Math.max(0.0001, part.halfExtents[2] * 2)
      ),
      material
    );
    mesh.position.set(part.position[0], part.position[1], part.position[2]);
    group.add(mesh);
  }
  return group;
}

export function generateCollider(
  geometry: THREE.BufferGeometry,
  options?: GenerateColliderOptions
): ColliderResult {
  const resolvedOptions = withDefaults(options);
  const prepared = preprocessGeometry(geometry);
  if (!prepared) {
    const fallback: RapierColliderDescription = {
      type: "compound",
      parts: [
        {
          kind: "box",
          position: tuple(0, 0, 0),
          halfExtents: tuple(0.1, 0.1, 0.1)
        }
      ]
    };

    return {
      rapier: fallback,
      metrics: {
        diagonal: 0,
        dims: [0.2, 0.2, 0.2],
        slenderness: 1,
        flatness: 1,
        planarity: 0,
        concavityProxy: 0,
        layerScore: 0,
        cavityScore: 0,
        noiseScore: 0,
        occupiedRatio: 1
      },
      quality: {
        selectedStrategy: "boxy-furniture",
        attemptedStrategies: ["boxy-furniture"],
        classification: {
          selected: "BoxyFurniture",
          confidence: 1,
          scores: [{ kind: "BoxyFurniture", score: 1 }],
          lowConfidenceFallback: false,
          strategyOrder: ["boxy-furniture"]
        },
        error: {
          sampledPoints: 0,
          outsideRatio: 0,
          meanOutsideDistance: 0,
          overfillRatio: 0
        },
        passThreshold: 0,
        partCount: fallback.parts.length,
        signature: colliderSignature(fallback)
      },
      debug: resolvedOptions.debug ? { three: buildDebugObject(fallback) } : undefined
    };
  }

  const metrics = computeMetrics(prepared, resolvedOptions.budget);
  const classification = classifyMetrics(metrics);
  const context: StrategyContext = {
    prepared,
    metrics,
    options: resolvedOptions
  };
  const threshold = maxAllowedOutsideRatio(resolvedOptions);

  let best: {
    result: StrategyResult;
    error: ColliderErrorMetrics;
    score: number;
  } | null = null;
  const attemptedStrategies: ColliderStrategyKind[] = [];

  for (const kind of classification.strategyOrder) {
    const result = strategyByKind(kind, context);
    attemptedStrategies.push(kind);

    const error = evaluateColliderError(prepared, result.rapier, resolvedOptions.budget);
    const score = scoreCandidate(result.rapier, error);
    if (!best || score < best.score) {
      best = { result, error, score };
    }

    if (
      error.outsideRatio <= threshold &&
      error.meanOutsideDistance <= 0.035 &&
      error.overfillRatio <= 0.42
    ) {
      break;
    }
  }

  if (!best) {
    const fallback = generateBoxyFurnitureStrategy(context);
    const error = evaluateColliderError(prepared, fallback.rapier, resolvedOptions.budget);
    best = {
      result: fallback,
      error,
      score: scoreCandidate(fallback.rapier, error)
    };
    attemptedStrategies.push("boxy-furniture");
  }

  let rapier = best.result.rapier;
  let selectedStrategy = best.result.kind;
  let selectedError = best.error;

  if (
    resolvedOptions.mode === "dynamic" &&
    resolvedOptions.budget === "strict" &&
    metrics.planarity >= 0.82 &&
    metrics.layerScore >= 0.4 &&
    metrics.concavityProxy >= 0.3 &&
    selectedError.overfillRatio >= 0.2
  ) {
    const expandedContext: StrategyContext = {
      prepared,
      metrics,
      options: {
        ...resolvedOptions,
        budget: "balanced"
      }
    };
    const expandedConcave = generateConcaveFurnitureStrategy(expandedContext);
    const expandedError = evaluateColliderError(
      prepared,
      expandedConcave.rapier,
      resolvedOptions.budget
    );

    const currentScore = scoreCandidate(rapier, selectedError);
    const expandedScore = scoreCandidate(expandedConcave.rapier, expandedError);
    const overfillGain = selectedError.overfillRatio - expandedError.overfillRatio;
    const outsideNotWorse =
      expandedError.outsideRatio <= Math.max(selectedError.outsideRatio + 0.02, threshold * 1.25);

    if (
      expandedConcave.rapier.parts.length <= 12 &&
      outsideNotWorse &&
      (expandedScore + 0.012 < currentScore ||
        (overfillGain >= 0.03 && expandedError.overfillRatio <= 0.24))
    ) {
      rapier = expandedConcave.rapier;
      selectedStrategy = expandedConcave.kind;
      selectedError = expandedError;
      if (!attemptedStrategies.includes("concave-furniture")) {
        attemptedStrategies.push("concave-furniture");
      }
    }
  }

  const result: ColliderResult = {
    rapier,
    metrics,
    quality: {
      selectedStrategy,
      attemptedStrategies,
      classification,
      error: selectedError,
      passThreshold: threshold,
      partCount: partCountForCollider(rapier),
      signature: colliderSignature(rapier)
    }
  };

  if (resolvedOptions.debug) {
    result.debug = {
      three: buildDebugObject(rapier)
    };
  }

  return result;
}

export function generateColliderFromObject(
  root: THREE.Object3D,
  options?: GenerateColliderOptions
): ColliderResult {
  const geometry = collectRootLocalGeometry(root);
  if (!geometry) {
    return generateCollider(new THREE.BoxGeometry(0.2, 0.2, 0.2), options);
  }
  return generateCollider(geometry, options);
}
