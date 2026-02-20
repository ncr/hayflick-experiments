import { describe, expect, it } from "vitest";
import { makeDeskLikeProp } from "../test-utils";
import { generateConcavitySplitCollider } from "./concavity-split";

function expectAxisAlignedRotation(
  rotation: readonly [number, number, number, number]
): void {
  expect(Math.abs(rotation[0])).toBeLessThan(1e-6);
  expect(Math.abs(rotation[1])).toBeLessThan(1e-6);
  expect(Math.abs(rotation[2])).toBeLessThan(1e-6);
  expect(Math.abs(rotation[3] - 1)).toBeLessThan(1e-6);
}

describe("collider-pipeline-lab-v2 strategy concavity-split", () => {
  it("builds bounded axis-aligned parts", () => {
    const prop = makeDeskLikeProp("desk");
    const parts = generateConcavitySplitCollider(prop, {
      resolution: 24,
      maxParts: 8,
      maxDepth: 8,
      minLeafVoxels: 20,
      splitCandidates: 8,
      concavityThreshold: 0.3,
      minConcavityGain: 0.015,
      complexityPenalty: 0.012,
      inflate: 0
    });

    expect(parts.length).toBeGreaterThan(0);
    expect(parts.length).toBeLessThanOrEqual(8);

    for (const part of parts) {
      expect(part.halfExtents[0]).toBeGreaterThan(0);
      expect(part.halfExtents[1]).toBeGreaterThan(0);
      expect(part.halfExtents[2]).toBeGreaterThan(0);
      expectAxisAlignedRotation(part.rotation);
    }
  });

  it("splits concave desk-like geometry into multiple parts", () => {
    const prop = makeDeskLikeProp("concave-desk");
    const parts = generateConcavitySplitCollider(prop, {
      resolution: 24,
      maxParts: 10,
      maxDepth: 10,
      minLeafVoxels: 14,
      splitCandidates: 10,
      concavityThreshold: 0.32,
      minConcavityGain: 0.01,
      complexityPenalty: 0.01,
      inflate: 0
    });

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expectAxisAlignedRotation(part.rotation);
    }
  });
});
