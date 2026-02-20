import { describe, expect, it } from "vitest";
import { generateLayeredZCollider } from "./layered-z";
import { makeDeskLikeProp } from "../test-utils";

describe("collider-pipeline-lab-v2 strategy layered-z", () => {
  it("produces at least one valid part", () => {
    const prop = makeDeskLikeProp("desk");
    const parts = generateLayeredZCollider(prop, {
      layerCount: 5,
      minPointsPerLayer: 10,
      mergeSimilarity: 0.16,
      inflate: 0
    });
    expect(parts.length).toBeGreaterThan(0);
    for (const part of parts) {
      expect(part.halfExtents[0]).toBeGreaterThan(0);
      expect(part.halfExtents[1]).toBeGreaterThan(0);
      expect(part.halfExtents[2]).toBeGreaterThan(0);
    }
  });
});

