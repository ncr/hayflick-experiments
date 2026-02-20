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

function scoreConvexLegacy(classification: PropClassification): PredictionBreakdown {
  const concavity = classification.metrics.concavityHint;
  const complexity = classification.metrics.complexityNorm;
  const anisotropy = classification.metrics.axisAnisotropy;
  const cues = {
    moderateConcavity: (1 - Math.abs(concavity - 0.45)) * 0.42,
    complexitySupport: complexity * 0.28,
    anisotropySupport: anisotropy * 0.18,
    lowFlatnessSupport: (1 - classification.metrics.flatnessScore) * 0.12
  };
  return {
    suitability: clamp01(
      cues.moderateConcavity +
        cues.complexitySupport +
        cues.anisotropySupport +
        cues.lowFlatnessSupport
    ),
    cues
  };
}

function scoreBoxyFurniture(classification: PropClassification): PredictionBreakdown {
  const concavity = classification.metrics.concavityHint;
  const complexity = classification.metrics.complexityNorm;
  const flatness = classification.metrics.flatnessScore;
  const cues = {
    lowConcavity: (1 - concavity) * 0.48,
    flatnessSupport: flatness * 0.24,
    lowComplexity: (1 - complexity) * 0.2,
    compactnessSupport: classification.metrics.compactness * 0.16
  };
  return {
    suitability: clamp01(
      cues.lowConcavity +
        cues.flatnessSupport +
        cues.lowComplexity +
        cues.compactnessSupport
    ),
    cues
  };
}

function scoreConcaveFurniture(classification: PropClassification): PredictionBreakdown {
  const concavity = classification.metrics.concavityHint;
  const complexity = classification.metrics.complexityNorm;
  const layerScore = clamp01(classification.metrics.baseContactRatio * 0.6 + classification.metrics.flatnessScore * 0.4);
  const cues = {
    concavitySupport: concavity * 0.46,
    complexitySupport: complexity * 0.28,
    layeringSupport: layerScore * 0.18,
    nonSlenderSupport: (1 - clamp01((classification.metrics.slenderness - 1) / 5)) * 0.1
  };
  return {
    suitability: clamp01(
      cues.concavitySupport +
        cues.complexitySupport +
        cues.layeringSupport +
        cues.nonSlenderSupport
    ),
    cues
  };
}

function scoreDecomposition(classification: PropClassification): PredictionBreakdown {
  const concavity = classification.metrics.concavityHint;
  const complexity = classification.metrics.complexityNorm;
  const slender = clamp01((classification.metrics.slenderness - 1) / 5);
  const flatness = classification.metrics.flatnessScore;
  const cues = {
    concavitySupport: concavity * 0.48,
    complexitySupport: complexity * 0.36,
    nonSlenderSupport: (1 - slender) * 0.12,
    flatnessSupport: flatness * 0.1
  };
  return {
    suitability: clamp01(
      cues.concavitySupport +
        cues.complexitySupport +
        cues.nonSlenderSupport +
        cues.flatnessSupport
    ),
    cues
  };
}

function scoreHull(classification: PropClassification): PredictionBreakdown {
  const concavity = classification.metrics.concavityHint;
  const complexity = classification.metrics.complexityNorm;
  const anisotropy = classification.metrics.axisAnisotropy;
  const cues = {
    lowConcavity: (1 - concavity) * 0.52,
    lowComplexity: (1 - complexity) * 0.28,
    anisotropySupport: anisotropy * 0.18
  };
  return {
    suitability: clamp01(
      cues.lowConcavity + cues.lowComplexity + cues.anisotropySupport
    ),
    cues
  };
}

function scoreMvbb(classification: PropClassification): PredictionBreakdown {
  const concavity = classification.metrics.concavityHint;
  const anisotropy = classification.metrics.axisAnisotropy;
  const slender = clamp01((classification.metrics.slenderness - 1) / 5);
  const cues = {
    lowConcavity: (1 - concavity) * 0.42,
    anisotropySupport: anisotropy * 0.34,
    slenderSupport: slender * 0.2
  };
  return {
    suitability: clamp01(
      cues.lowConcavity + cues.anisotropySupport + cues.slenderSupport
    ),
    cues
  };
}

function scoreKDop(classification: PropClassification): PredictionBreakdown {
  const concavity = classification.metrics.concavityHint;
  const complexity = classification.metrics.complexityNorm;
  const flatness = classification.metrics.flatnessScore;
  const cues = {
    moderateConcavity: (1 - Math.abs(concavity - 0.45)) * 0.38,
    complexitySupport: complexity * 0.24,
    flatnessSupport: flatness * 0.22,
    lowConcavity: (1 - concavity) * 0.2
  };
  return {
    suitability: clamp01(
      cues.moderateConcavity +
        cues.complexitySupport +
        cues.flatnessSupport +
        cues.lowConcavity
    ),
    cues
  };
}

function scoreSphere(classification: PropClassification): PredictionBreakdown {
  const compactness = classification.metrics.compactness;
  const concavity = classification.metrics.concavityHint;
  const anisotropy = classification.metrics.axisAnisotropy;
  const cues = {
    compactnessSupport: compactness * 0.5,
    lowConcavity: (1 - concavity) * 0.28,
    isotropySupport: (1 - anisotropy) * 0.24
  };
  return {
    suitability: clamp01(
      cues.compactnessSupport + cues.lowConcavity + cues.isotropySupport
    ),
    cues
  };
}

function scoreCapsule(classification: PropClassification): PredictionBreakdown {
  const slender = clamp01((classification.metrics.slenderness - 1) / 5);
  const complexity = classification.metrics.complexityNorm;
  const concavity = classification.metrics.concavityHint;
  const cues = {
    slenderSupport: slender * 0.48,
    lowConcavity: (1 - concavity) * 0.28,
    complexitySupport: complexity * 0.2
  };
  return {
    suitability: clamp01(
      cues.slenderSupport + cues.lowConcavity + cues.complexitySupport
    ),
    cues
  };
}

function scoreCylinder(classification: PropClassification): PredictionBreakdown {
  const slender = clamp01((classification.metrics.slenderness - 1) / 5);
  const anisotropy = classification.metrics.axisAnisotropy;
  const complexity = classification.metrics.complexityNorm;
  const cues = {
    slenderSupport: slender * 0.44,
    anisotropySupport: anisotropy * 0.32,
    complexitySupport: complexity * 0.18
  };
  return {
    suitability: clamp01(
      cues.slenderSupport + cues.anisotropySupport + cues.complexitySupport
    ),
    cues
  };
}

function scoreMultiSphere(classification: PropClassification): PredictionBreakdown {
  const concavity = classification.metrics.concavityHint;
  const complexity = classification.metrics.complexityNorm;
  const compactness = classification.metrics.compactness;
  const cues = {
    concavitySupport: concavity * 0.38,
    complexitySupport: complexity * 0.34,
    compactnessSupport: compactness * 0.26
  };
  return {
    suitability: clamp01(
      cues.concavitySupport + cues.complexitySupport + cues.compactnessSupport
    ),
    cues
  };
}

function scoreSegmentation(classification: PropClassification): PredictionBreakdown {
  const concavity = classification.metrics.concavityHint;
  const complexity = classification.metrics.complexityNorm;
  const anisotropy = classification.metrics.axisAnisotropy;
  const cues = {
    concavitySupport: concavity * 0.4,
    complexitySupport: complexity * 0.34,
    anisotropySupport: anisotropy * 0.18,
    flatnessSupport: classification.metrics.flatnessScore * 0.08
  };
  return {
    suitability: clamp01(
      cues.concavitySupport +
        cues.complexitySupport +
        cues.anisotropySupport +
        cues.flatnessSupport
    ),
    cues
  };
}

function scoreSdf(classification: PropClassification): PredictionBreakdown {
  const concavity = classification.metrics.concavityHint;
  const complexity = classification.metrics.complexityNorm;
  const cues = {
    concavitySupport: concavity * 0.44,
    complexitySupport: complexity * 0.4,
    lowFlatnessSupport: (1 - classification.metrics.flatnessScore) * 0.16
  };
  return {
    suitability: clamp01(
      cues.concavitySupport +
        cues.complexitySupport +
        cues.lowFlatnessSupport
    ),
    cues
  };
}

function scoreConcavitySplit(classification: PropClassification): PredictionBreakdown {
  const concavity = classification.metrics.concavityHint;
  const complexity = classification.metrics.complexityNorm;
  const anisotropy = classification.metrics.axisAnisotropy;
  const flatness = classification.metrics.flatnessScore;
  const cues = {
    concavitySupport: concavity * 0.36,
    complexitySupport: complexity * 0.34,
    anisotropySupport: anisotropy * 0.18,
    flatnessSupport: flatness * 0.12
  };
  return {
    suitability: clamp01(
      cues.concavitySupport +
        cues.complexitySupport +
        cues.anisotropySupport +
        cues.flatnessSupport
    ),
    cues
  };
}

function scoreDecimation(classification: PropClassification): PredictionBreakdown {
  const complexity = classification.metrics.complexityNorm;
  const triangleDensity = clamp01(classification.metrics.triangleCount / 30000);
  const concavity = classification.metrics.concavityHint;
  const cues = {
    complexitySupport: complexity * 0.44,
    triangleDensitySupport: triangleDensity * 0.34,
    lowConcavitySupport: (1 - concavity) * 0.22
  };
  return {
    suitability: clamp01(
      cues.complexitySupport +
        cues.triangleDensitySupport +
        cues.lowConcavitySupport
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
    "support-columns": scoreSupportColumns(classification),
    "convex": scoreConvexLegacy(classification),
    "boxy-furniture": scoreBoxyFurniture(classification),
    "concave-furniture": scoreConcaveFurniture(classification),
    "coacd": scoreDecomposition(classification),
    "v-hacd": scoreDecomposition(classification),
    "hacd": scoreDecomposition(classification),
    "acd": scoreDecomposition(classification),
    "quickhull": scoreHull(classification),
    "incremental-hull": scoreHull(classification),
    "mvbb": scoreMvbb(classification),
    "k-dop": scoreKDop(classification),
    "sphere-ritter": scoreSphere(classification),
    "sphere-ls": scoreSphere(classification),
    "capsule-fit": scoreCapsule(classification),
    "cylinder-fit": scoreCylinder(classification),
    "multi-sphere": scoreMultiSphere(classification),
    "kmeans-seg": scoreSegmentation(classification),
    "spectral-seg": scoreSegmentation(classification),
    "region-grow": scoreSegmentation(classification),
    "bsp": scoreSegmentation(classification),
    "concavity-split": scoreConcavitySplit(classification),
    "sdf-convex": scoreSdf(classification),
    "qem-decimate": scoreDecimation(classification),
    "edge-collapse": scoreDecimation(classification)
  };
}
