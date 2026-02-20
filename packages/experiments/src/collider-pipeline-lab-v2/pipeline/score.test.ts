import { describe, expect, it } from "vitest";
import { scoreColliderQuality } from "./score";
import { DEFAULT_QUALITY_WEIGHTS } from "../state/defaults";
import { makeSimpleBoxProp } from "../test-utils";
import { axisAlignedPartFromBounds } from "../strategies/common";

describe("collider-pipeline-lab-v2 score", () => {
  it("prefers a close-fitting collider over severe underfill", () => {
    const prop = makeSimpleBoxProp("box");
    const good = [axisAlignedPartFromBounds(prop.bbox.min, prop.bbox.max, 0)];
    const badUnderfill = [
      axisAlignedPartFromBounds(
        [-0.18, 0.2, -0.12],
        [0.18, 0.72, 0.12],
        0
      )
    ];

    const goodScore = scoreColliderQuality(prop, good, DEFAULT_QUALITY_WEIGHTS);
    const badScore = scoreColliderQuality(
      prop,
      badUnderfill,
      DEFAULT_QUALITY_WEIGHTS
    );

    expect(goodScore.finalScore).toBeLessThan(badScore.finalScore);
    expect(goodScore.voxelIoU).toBeGreaterThan(badScore.voxelIoU);
    expect(goodScore.overlapAgreement).toBeGreaterThan(
      badScore.overlapAgreement
    );
    expect(goodScore.underfill).toBeLessThan(badScore.underfill);
  });

  it("penalizes overfilled colliders", () => {
    const prop = makeSimpleBoxProp("box");
    const close = [axisAlignedPartFromBounds(prop.bbox.min, prop.bbox.max, 0)];
    const oversized = [axisAlignedPartFromBounds([-0.9, -0.2, -0.8], [0.9, 1.4, 0.8], 0)];

    const closeScore = scoreColliderQuality(prop, close, DEFAULT_QUALITY_WEIGHTS);
    const oversizedScore = scoreColliderQuality(
      prop,
      oversized,
      DEFAULT_QUALITY_WEIGHTS
    );

    expect(closeScore.overlapAgreement).toBeGreaterThan(0);
    expect(oversizedScore.overlapAgreement).toBeLessThan(1);
    expect(oversizedScore.overlapAgreement).toBeLessThan(
      closeScore.overlapAgreement
    );
    expect(oversizedScore.overfill).toBeGreaterThan(closeScore.overfill);
    expect(oversizedScore.finalScore).toBeGreaterThan(closeScore.finalScore);
  });

  it("adds part-count penalty for excessive part counts", () => {
    const prop = makeSimpleBoxProp("box");
    const basePart = axisAlignedPartFromBounds(prop.bbox.min, prop.bbox.max, 0);
    const fewParts = [basePart];
    const manyParts = Array.from({ length: 12 }, (_, index) => {
      const offset = (index - 6) * 0.01;
      return axisAlignedPartFromBounds(
        [prop.bbox.min[0] + offset, prop.bbox.min[1], prop.bbox.min[2]],
        [prop.bbox.max[0] + offset, prop.bbox.max[1], prop.bbox.max[2]],
        0
      );
    });

    const fewScore = scoreColliderQuality(prop, fewParts, DEFAULT_QUALITY_WEIGHTS);
    const manyScore = scoreColliderQuality(prop, manyParts, DEFAULT_QUALITY_WEIGHTS);
    expect(manyScore.partPenalty).toBeGreaterThan(fewScore.partPenalty);
  });

  it("reports collider self-overlap without double-counting intersecting parts", () => {
    const prop = makeSimpleBoxProp("box");
    const partA = axisAlignedPartFromBounds(prop.bbox.min, prop.bbox.max, 0);
    const partB = axisAlignedPartFromBounds(prop.bbox.min, prop.bbox.max, 0);

    const score = scoreColliderQuality(prop, [partA, partB], DEFAULT_QUALITY_WEIGHTS);

    expect(score.colliderPartVolume).toBeGreaterThan(score.colliderUnionVolume);
    expect(score.colliderSelfOverlap).toBeGreaterThan(0.45);
    expect(score.meshOverlap).toBeGreaterThan(0.99);
    expect(score.overlapVolume).toBeGreaterThan(0);
  });
});
