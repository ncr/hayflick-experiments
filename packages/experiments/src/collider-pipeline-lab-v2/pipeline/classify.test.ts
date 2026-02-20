import { describe, expect, it } from "vitest";
import { classifyProp } from "./classify";
import {
  makeDeskLikeProp,
  makeSimpleBoxProp,
  makeTallLampLikeProp
} from "../test-utils";

describe("collider-pipeline-lab-v2 classify", () => {
  it("classifies a simple box as low concavity with strong flatness", () => {
    const prop = makeSimpleBoxProp("box");
    const result = classifyProp(prop);

    expect(result.labels.concavity).toBe("low");
    expect(result.metrics.flatnessScore).toBeGreaterThan(0.25);
    expect(result.metrics.concavityHint).toBeLessThan(0.2);
  });

  it("captures slenderness for tall lamp-like shapes", () => {
    const prop = makeTallLampLikeProp("lamp");
    const result = classifyProp(prop);

    expect(result.metrics.slenderness).toBeGreaterThan(2.5);
    expect(result.labels.slenderness).toBe("slender");
  });

  it("reports higher concavity hints for desk-like open shapes than a single box", () => {
    const box = classifyProp(makeSimpleBoxProp("box"));
    const desk = classifyProp(makeDeskLikeProp("desk"));

    expect(desk.metrics.concavityHint).toBeGreaterThan(box.metrics.concavityHint);
  });
});
