import { generateAabbCollider } from "../strategies/aabb";
import { generateLayeredXCollider } from "../strategies/layered-x";
import { generateLayeredYCollider } from "../strategies/layered-y";
import { generateLayeredZCollider } from "../strategies/layered-z";
import { generateObbPcaCollider } from "../strategies/obb-pca";
import { generateSplitFitCollider } from "../strategies/split-fit";
import { generateSupportColumnsCollider } from "../strategies/support-columns";
import { generateVoxelGreedyCollider } from "../strategies/voxel-greedy";
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
import { STRATEGY_IDS } from "../types";

const now = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

function sortedByActualQuality(results: StrategyResult[]): StrategyResult[] {
  return [...results].sort((a, b) => {
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
      actualRank: STRATEGY_IDS.length,
      predictedRank: STRATEGY_IDS.length,
      elapsedMs
    };
  };

  const initialResults: StrategyResult[] = [
    runStrategy("aabb", generateAabbCollider),
    runStrategy("obb-pca", generateObbPcaCollider),
    runStrategy("layered-y", generateLayeredYCollider),
    runStrategy("layered-x", generateLayeredXCollider),
    runStrategy("layered-z", generateLayeredZCollider),
    runStrategy("voxel-greedy", generateVoxelGreedyCollider),
    runStrategy("split-fit", generateSplitFitCollider),
    runStrategy("support-columns", generateSupportColumnsCollider)
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
