import { describe, expect, it } from "vitest";
import { runPipelineForProp } from "./run-all";
import { DEFAULT_QUALITY_WEIGHTS, DEFAULT_STRATEGY_PARAMS } from "../state/defaults";
import {
  makeDeskLikeProp,
  makeSimpleBoxProp,
  makeTallLampLikeProp
} from "../test-utils";
import { ACTIVE_STRATEGY_IDS } from "../types";

describe("collider-pipeline-lab-v2 report fixtures", () => {
  it("builds deterministic report-shape output for fixture props", () => {
    const fixtures = [
      makeSimpleBoxProp("fixture-box"),
      makeDeskLikeProp("fixture-desk"),
      makeTallLampLikeProp("fixture-lamp")
    ];

    for (const fixture of fixtures) {
      const result = runPipelineForProp(
        fixture,
        DEFAULT_STRATEGY_PARAMS,
        DEFAULT_QUALITY_WEIGHTS
      );
      expect(result.strategyResults.length).toBe(ACTIVE_STRATEGY_IDS.length);
      for (const entry of result.strategyResults) {
        expect(Number.isFinite(entry.quality.finalScore)).toBe(true);
        expect(Number.isFinite(entry.predicted.suitability)).toBe(true);
        expect(entry.parts.length).toBeGreaterThan(0);
      }
    }
  });
});
