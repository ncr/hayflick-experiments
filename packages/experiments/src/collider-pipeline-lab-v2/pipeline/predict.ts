import type {
  PredictionBreakdown,
  PropClassification,
  StrategyId
} from "../types";
import { clamp01 } from "./math";

function scoreAabb(classification: PropClassification): PredictionBreakdown {
  const concavity = classification.metrics.concavityHint;
  const complexity = classification.metrics.complexityNorm;
  const slender = clamp01((classification.metrics.slenderness - 1) / 5);
  const flatness = classification.metrics.flatnessScore;

  const cues = {
    lowConcavity: (1 - concavity) * 0.5,
    lowComplexity: (1 - complexity) * 0.35,
    lowSlenderness: (1 - slender) * 0.25,
    flatnessSupport: flatness * 0.1
  };

  return {
    suitability: clamp01(cues.lowConcavity + cues.lowComplexity + cues.lowSlenderness + cues.flatnessSupport),
    cues
  };
}

function scoreObb(classification: PropClassification): PredictionBreakdown {
  const concavity = classification.metrics.concavityHint;
  const complexity = classification.metrics.complexityNorm;
  const slender = clamp01((classification.metrics.slenderness - 1) / 5);
  const anisotropy = classification.metrics.axisAnisotropy;

  const cues = {
    lowConcavity: (1 - concavity) * 0.45,
    lowComplexity: (1 - complexity) * 0.25,
    slenderSupport: slender * 0.2,
    anisotropySupport: anisotropy * 0.2
  };

  return {
    suitability: clamp01(
      cues.lowConcavity + cues.lowComplexity + cues.slenderSupport + cues.anisotropySupport
    ),
    cues
  };
}

function scoreLayeredY(classification: PropClassification): PredictionBreakdown {
  const concavity = classification.metrics.concavityHint;
  const complexity = classification.metrics.complexityNorm;
  const flatness = classification.metrics.flatnessScore;
  const anisotropy = classification.metrics.axisAnisotropy;

  const cues = {
    flatnessSupport: flatness * 0.55,
    lowConcavity: (1 - concavity) * 0.25,
    anisotropySupport: anisotropy * 0.2,
    complexitySupport: complexity * 0.15
  };
  return {
    suitability: clamp01(
      cues.flatnessSupport +
        cues.lowConcavity +
        cues.anisotropySupport +
        cues.complexitySupport
    ),
    cues
  };
}

function scoreLayeredX(classification: PropClassification): PredictionBreakdown {
  const concavity = classification.metrics.concavityHint;
  const complexity = classification.metrics.complexityNorm;
  const flatness = classification.metrics.flatnessScore;
  const anisotropy = classification.metrics.axisAnisotropy;

  const cues = {
    anisotropySupport: anisotropy * 0.5,
    flatnessSupport: flatness * 0.28,
    lowConcavity: (1 - concavity) * 0.2,
    complexitySupport: complexity * 0.12
  };
  return {
    suitability: clamp01(
      cues.anisotropySupport +
        cues.flatnessSupport +
        cues.lowConcavity +
        cues.complexitySupport
    ),
    cues
  };
}

function scoreLayeredZ(classification: PropClassification): PredictionBreakdown {
  const concavity = classification.metrics.concavityHint;
  const complexity = classification.metrics.complexityNorm;
  const flatness = classification.metrics.flatnessScore;
  const anisotropy = classification.metrics.axisAnisotropy;

  const cues = {
    anisotropySupport: anisotropy * 0.5,
    flatnessSupport: flatness * 0.28,
    lowConcavity: (1 - concavity) * 0.2,
    complexitySupport: complexity * 0.12
  };
  return {
    suitability: clamp01(
      cues.anisotropySupport +
        cues.flatnessSupport +
        cues.lowConcavity +
        cues.complexitySupport
    ),
    cues
  };
}

function scoreVoxelGreedy(classification: PropClassification): PredictionBreakdown {
  const concavity = classification.metrics.concavityHint;
  const complexity = classification.metrics.complexityNorm;
  const flatness = classification.metrics.flatnessScore;
  const slender = clamp01((classification.metrics.slenderness - 1) / 5);

  const cues = {
    concavitySupport: concavity * 0.55,
    complexitySupport: complexity * 0.45,
    lowFlatnessSupport: (1 - flatness) * 0.15,
    slenderSupport: slender * 0.1
  };

  return {
    suitability: clamp01(
      cues.concavitySupport +
        cues.complexitySupport +
        cues.lowFlatnessSupport +
        cues.slenderSupport
    ),
    cues
  };
}

function scoreSplitFit(classification: PropClassification): PredictionBreakdown {
  const concavity = classification.metrics.concavityHint;
  const complexity = classification.metrics.complexityNorm;
  const slender = clamp01((classification.metrics.slenderness - 1) / 5);
  const anisotropy = classification.metrics.axisAnisotropy;

  const cues = {
    concavitySupport: concavity * 0.45,
    complexitySupport: complexity * 0.4,
    anisotropySupport: anisotropy * 0.25,
    slenderSupport: slender * 0.15
  };

  return {
    suitability: clamp01(
      cues.concavitySupport +
        cues.complexitySupport +
        cues.anisotropySupport +
        cues.slenderSupport
    ),
    cues
  };
}

function scoreSupportColumns(classification: PropClassification): PredictionBreakdown {
  const concavity = classification.metrics.concavityHint;
  const complexity = classification.metrics.complexityNorm;
  const flatness = classification.metrics.flatnessScore;
  const slender = clamp01((classification.metrics.slenderness - 1) / 5);

  const cues = {
    flatnessSupport: flatness * 0.38,
    concavitySupport: concavity * 0.34,
    complexitySupport: complexity * 0.22,
    nonSlenderSupport: (1 - slender) * 0.15
  };

  return {
    suitability: clamp01(
      cues.flatnessSupport +
        cues.concavitySupport +
        cues.complexitySupport +
        cues.nonSlenderSupport
    ),
    cues
  };
}

export function predictStrategySuitability(
  classification: PropClassification
): Record<StrategyId, PredictionBreakdown> {
  return {
    "aabb": scoreAabb(classification),
    "obb-pca": scoreObb(classification),
    "layered-y": scoreLayeredY(classification),
    "layered-x": scoreLayeredX(classification),
    "layered-z": scoreLayeredZ(classification),
    "voxel-greedy": scoreVoxelGreedy(classification),
    "split-fit": scoreSplitFit(classification),
    "support-columns": scoreSupportColumns(classification)
  };
}
