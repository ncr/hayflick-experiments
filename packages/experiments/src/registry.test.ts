import { describe, expect, it } from "vitest";
import { experiments } from "./registry";

describe("experiments registry", () => {
  it("contains unique ids", () => {
    const ids = experiments.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("loads module with matching id", async () => {
    const first = experiments[0];
    const module = await first.load();
    expect(module.default.id).toBe(first.id);
  });
});
