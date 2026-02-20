import { describe, expect, it } from "vitest";
import { generateVoxelGreedyCollider } from "./voxel-greedy";
import { makeDeskLikeProp } from "../test-utils";

describe("collider-pipeline-lab-v2 strategy voxel-greedy", () => {
  it("respects max part budget", () => {
    const prop = makeDeskLikeProp("desk");
    const parts = generateVoxelGreedyCollider(prop, {
      resolution: 16,
      maxParts: 4,
      inflate: 0
    });

    expect(parts.length).toBeLessThanOrEqual(4);
    expect(parts.length).toBeGreaterThan(0);
    for (const part of parts) {
      expect(part.halfExtents[0]).toBeGreaterThan(0);
      expect(part.halfExtents[1]).toBeGreaterThan(0);
      expect(part.halfExtents[2]).toBeGreaterThan(0);
    }
  });
});

