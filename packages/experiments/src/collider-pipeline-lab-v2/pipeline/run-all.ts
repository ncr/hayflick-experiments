import {
  generateCapsuleFitCollider,
  generateCylinderFitCollider,
  generateHacdCollider,
  generateKdopCollider,
  generateKmeansSegCollider,
  generateQemDecimateCollider,
  generateSpectralSegCollider
} from "../strategies/extended";
import {
  generateBoxyFurnitureLegacyCollider,
  generateConcaveFurnitureLegacyCollider
} from "../strategies/legacy-ported";
import { generateLayeredYCollider } from "../strategies/layered-y";
import { generateConcavitySplitCollider } from "../strategies/concavity-split";
import { classifyProp } from "./classify";
import { predictStrategySuitability } from "./predict";
import { scoreColliderQuality } from "./score";
import type {
  NormalizedProp,
  PipelineOutput,
  QualityWeights,
  StrategyId,
  StrategyParamsById,
  StrategyResult
} from "../types";
import { ACTIVE_STRATEGY_IDS } from "../types";

const now = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

function sortedByActualQuality(results: StrategyResult[]): StrategyResult[] {
  return [...results].sort((a, b) => {
    // Rank by overlap agreement first (higher is better), then prefer tighter/fewer colliders.
    if (a.quality.overlapAgreement !== b.quality.overlapAgreement) {
      return b.quality.overlapAgreement - a.quality.overlapAgreement;
    }
    if (a.quality.colliderSelfOverlap !== b.quality.colliderSelfOverlap) {
      return a.quality.colliderSelfOverlap - b.quality.colliderSelfOverlap;
    }
    if (a.quality.overfill !== b.quality.overfill) {
      return a.quality.overfill - b.quality.overfill;
    }
    if (a.parts.length !== b.parts.length) {
      return a.parts.length - b.parts.length;
    }
    if (a.quality.finalScore !== b.quality.finalScore) {
      return a.quality.finalScore - b.quality.finalScore;
    }
    return a.strategyId.localeCompare(b.strategyId);
  });
}

function sortedByPredicted(results: StrategyResult[]): StrategyResult[] {
  return [...results].sort((a, b) => {
    if (a.predicted.suitability !== b.predicted.suitability) {
      return b.predicted.suitability - a.predicted.suitability;
    }
    return a.strategyId.localeCompare(b.strategyId);
  });
}

function applyRanks(results: StrategyResult[]): StrategyResult[] {
  const actualOrder = sortedByActualQuality(results);
  const predictedOrder = sortedByPredicted(results);

  const actualRankById = new Map<StrategyId, number>();
  const predictedRankById = new Map<StrategyId, number>();

  actualOrder.forEach((entry, index) => {
    actualRankById.set(entry.strategyId, index + 1);
  });
  predictedOrder.forEach((entry, index) => {
    predictedRankById.set(entry.strategyId, index + 1);
  });

  return results.map((entry) => ({
    ...entry,
    actualRank: actualRankById.get(entry.strategyId) ?? results.length,
    predictedRank: predictedRankById.get(entry.strategyId) ?? results.length
  }));
}

function spearman(results: StrategyResult[]): number {
  const n = results.length;
  if (n <= 1) {
    return 1;
  }
  let sumSq = 0;
  for (const result of results) {
    const d = result.actualRank - result.predictedRank;
    sumSq += d * d;
  }
  const denominator = n * (n * n - 1);
  if (denominator <= 0) {
    return 1;
  }
  return 1 - (6 * sumSq) / denominator;
}

function top1Match(results: StrategyResult[]): boolean {
  const actualTop = sortedByActualQuality(results)[0];
  const predictedTop = sortedByPredicted(results)[0];
  if (!actualTop || !predictedTop) {
    return false;
  }
  return actualTop.strategyId === predictedTop.strategyId;
}

export function runPipelineForProp(
  prop: NormalizedProp,
  strategyParams: StrategyParamsById,
  qualityWeights: QualityWeights
): PipelineOutput {
  const classification = classifyProp(prop);
  const predicted = predictStrategySuitability(classification);

  const runStrategy = <K extends StrategyId>(
    strategyId: K,
    generator: (
      input: NormalizedProp,
      params: StrategyParamsById[K]
    ) => StrategyResult["parts"]
  ): StrategyResult => {
    const startedAt = now();
    const parts = generator(prop, strategyParams[strategyId]);
    const elapsedMs = now() - startedAt;
    return {
      strategyId,
      parts,
      quality: scoreColliderQuality(prop, parts, qualityWeights),
      predicted: predicted[strategyId],
      actualRank: ACTIVE_STRATEGY_IDS.length,
      predictedRank: ACTIVE_STRATEGY_IDS.length,
      elapsedMs
    };
  };

  const initialResults: StrategyResult[] = [
    runStrategy("concave-furniture", generateConcaveFurnitureLegacyCollider),
    runStrategy("concavity-split", generateConcavitySplitCollider),
    runStrategy("cylinder-fit", generateCylinderFitCollider),
    runStrategy("qem-decimate", generateQemDecimateCollider),
    runStrategy("kmeans-seg", generateKmeansSegCollider),
    runStrategy("capsule-fit", generateCapsuleFitCollider),
    runStrategy("hacd", generateHacdCollider),
    runStrategy("boxy-furniture", generateBoxyFurnitureLegacyCollider),
    runStrategy("spectral-seg", generateSpectralSegCollider),
    runStrategy("layered-y", generateLayeredYCollider),
    runStrategy("k-dop", generateKdopCollider),
  ];

  const strategyResults = applyRanks(initialResults);
  return {
    classification,
    strategyResults,
    rankAgreement: {
      spearman: spearman(strategyResults),
      top1Match: top1Match(strategyResults)
    }
  };
}
