import { describe, expect, it } from "vitest";
import { generateAabbCollider } from "./aabb";
import { makeSimpleBoxProp } from "../test-utils";

describe("collider-pipeline-lab-v2 strategy aabb", () => {
  it("returns exactly one valid box", () => {
    const prop = makeSimpleBoxProp("box");
    const parts = generateAabbCollider(prop, { inflate: 0 });
    expect(parts).toHaveLength(1);
    expect(parts[0].halfExtents[0]).toBeGreaterThan(0);
    expect(parts[0].halfExtents[1]).toBeGreaterThan(0);
    expect(parts[0].halfExtents[2]).toBeGreaterThan(0);
  });
});

