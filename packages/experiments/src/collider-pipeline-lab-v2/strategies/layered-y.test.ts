import { describe, expect, it } from "vitest";
import { generateLayeredYCollider } from "./layered-y";
import { makeDeskLikeProp } from "../test-utils";

describe("collider-pipeline-lab-v2 strategy layered-y", () => {
  it("produces multiple bands for desk-like geometry", () => {
    const prop = makeDeskLikeProp("desk");
    const parts = generateLayeredYCollider(prop, {
      layerCount: 5,
      minPointsPerLayer: 10,
      mergeSimilarity: 0.15,
      inflate: 0
    });
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.halfExtents[1]).toBeGreaterThan(0);
    }
  });
});

