import { describe, expect, it } from "vitest";
import { generateSplitFitCollider } from "./split-fit";
import { makeDeskLikeProp } from "../test-utils";

describe("collider-pipeline-lab-v2 strategy split-fit", () => {
  it("splits concave desk-like geometry into more than one part", () => {
    const prop = makeDeskLikeProp("desk");
    const parts = generateSplitFitCollider(prop, {
      maxDepth: 4,
      maxParts: 6,
      minGain: 0.02,
      inflate: 0
    });

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.length).toBeLessThanOrEqual(6);
  });
});

