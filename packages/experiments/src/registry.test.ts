import { describe, expect, it } from "vitest";
import { experiments } from "./registry";

describe("experiments registry", () => {
  it("only exposes active experiments", () => {
    expect(experiments.map((entry) => entry.id)).toEqual([
      "material-studio",
      "physics-prop-drop",
      "map-editor-2d"
    ]);
  });

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
