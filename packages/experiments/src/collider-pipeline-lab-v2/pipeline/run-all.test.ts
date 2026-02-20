import { describe, expect, it } from "vitest";
import { runPipelineForProp } from "./run-all";
import { DEFAULT_QUALITY_WEIGHTS, DEFAULT_STRATEGY_PARAMS } from "../state/defaults";
import { makeDeskLikeProp } from "../test-utils";
import { ACTIVE_STRATEGY_IDS } from "../types";

describe("collider-pipeline-lab-v2 run-all", () => {
  it("runs all strategies and assigns both rank systems", () => {
    const prop = makeDeskLikeProp("desk");
    const result = runPipelineForProp(
      prop,
      DEFAULT_STRATEGY_PARAMS,
      DEFAULT_QUALITY_WEIGHTS
    );

    expect(result.strategyResults).toHaveLength(ACTIVE_STRATEGY_IDS.length);
    const actualRanks = new Set(result.strategyResults.map((entry) => entry.actualRank));
    const predictedRanks = new Set(
      result.strategyResults.map((entry) => entry.predictedRank)
    );
    expect(actualRanks.size).toBe(ACTIVE_STRATEGY_IDS.length);
    expect(predictedRanks.size).toBe(ACTIVE_STRATEGY_IDS.length);
    expect(result.rankAgreement.spearman).toBeLessThanOrEqual(1);
    expect(result.rankAgreement.spearman).toBeGreaterThanOrEqual(-1);
  });

  it("is deterministic for identical input and params", () => {
    const prop = makeDeskLikeProp("desk");
    const first = runPipelineForProp(
      prop,
      DEFAULT_STRATEGY_PARAMS,
      DEFAULT_QUALITY_WEIGHTS
    );
    const second = runPipelineForProp(
      prop,
      DEFAULT_STRATEGY_PARAMS,
      DEFAULT_QUALITY_WEIGHTS
    );

    const signature = (value: typeof first) =>
      JSON.stringify(
        value.strategyResults.map((entry) => ({
          id: entry.strategyId,
          actualRank: entry.actualRank,
          predictedRank: entry.predictedRank,
          score: Number(entry.quality.finalScore.toFixed(6)),
          suitability: Number(entry.predicted.suitability.toFixed(6)),
          partCount: entry.parts.length
        }))
      );

    expect(signature(first)).toBe(signature(second));
  });

  it("produces at least one valid collider part for every strategy", () => {
    const prop = makeDeskLikeProp("desk");
    const result = runPipelineForProp(
      prop,
      DEFAULT_STRATEGY_PARAMS,
      DEFAULT_QUALITY_WEIGHTS
    );

    for (const strategyResult of result.strategyResults) {
      expect(strategyResult.parts.length).toBeGreaterThan(0);
      for (const part of strategyResult.parts) {
        expect(Number.isFinite(part.position[0])).toBe(true);
        expect(Number.isFinite(part.position[1])).toBe(true);
        expect(Number.isFinite(part.position[2])).toBe(true);
        expect(part.halfExtents[0]).toBeGreaterThan(0);
        expect(part.halfExtents[1]).toBeGreaterThan(0);
        expect(part.halfExtents[2]).toBeGreaterThan(0);
        expect(part.volume).toBeGreaterThan(0);
        expect(Number.isFinite(part.volume)).toBe(true);
      }
    }
  });
});
