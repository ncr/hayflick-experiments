import { describe, expect, it } from "vitest";
import { experiments } from "@experiments/catalog";

describe("hub data wiring", () => {
  it("has at least one experiment", () => {
    expect(experiments.length).toBeGreaterThan(0);
  });
});
