import { describe, expect, it } from "vitest";
import { classifyProp } from "./classify";
import { predictStrategySuitability } from "./predict";
import { makeDeskLikeProp, makeSimpleBoxProp } from "../test-utils";

describe("collider-pipeline-lab-v2 predict", () => {
  it("favors simpler single-box strategies for low-concavity boxes", () => {
    const classification = classifyProp(makeSimpleBoxProp("box"));
    const suitability = predictStrategySuitability(classification);

    expect(suitability["aabb"].suitability).toBeGreaterThan(
      suitability["voxel-greedy"].suitability
    );
    expect(suitability["obb-pca"].suitability).toBeGreaterThan(
      suitability["voxel-greedy"].suitability
    );
  });

  it("favors split/voxel strategies for concave desk-like props", () => {
    const deskSuitability = predictStrategySuitability(
      classifyProp(makeDeskLikeProp("desk"))
    );
    const boxSuitability = predictStrategySuitability(
      classifyProp(makeSimpleBoxProp("box"))
    );

    expect(deskSuitability["voxel-greedy"].suitability).toBeGreaterThan(
      boxSuitability["voxel-greedy"].suitability
    );
    expect(deskSuitability["split-fit"].suitability).toBeGreaterThan(
      boxSuitability["split-fit"].suitability
    );
  });
});
