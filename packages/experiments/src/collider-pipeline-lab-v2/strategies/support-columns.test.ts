import { describe, expect, it } from "vitest";
import { generateSupportColumnsCollider } from "./support-columns";
import { makeDeskLikeProp } from "../test-utils";

describe("collider-pipeline-lab-v2 strategy support-columns", () => {
  it("extracts support-oriented parts for desk-like geometry", () => {
    const prop = makeDeskLikeProp("desk");
    const parts = generateSupportColumnsCollider(prop, {
      resolution: 20,
      baseLayers: 2,
      topCoverageThreshold: 0.18,
      maxParts: 8,
      inflate: 0
    });

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.length).toBeLessThanOrEqual(8);
  });
});

