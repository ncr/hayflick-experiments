import { describe, expect, it } from "vitest";
import { generateObbPcaCollider } from "./obb-pca";
import { makeSimpleBoxProp } from "../test-utils";

describe("collider-pipeline-lab-v2 strategy obb-pca", () => {
  it("returns one valid oriented box", () => {
    const prop = makeSimpleBoxProp("box");
    const parts = generateObbPcaCollider(prop, { inflate: 0.01 });
    expect(parts).toHaveLength(1);
    expect(parts[0].halfExtents[0]).toBeGreaterThan(0);
    expect(parts[0].halfExtents[1]).toBeGreaterThan(0);
    expect(parts[0].halfExtents[2]).toBeGreaterThan(0);
    expect(parts[0].rotation[3]).toBeGreaterThan(0);
  });
});

