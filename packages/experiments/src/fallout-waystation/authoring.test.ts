import { describe, expect, it } from "vitest";
import { defineLevel } from "./authoring";

describe("defineLevel", () => {
  it("records human-readable placements in declaration order", () => {
    const level = defineLevel(
      { id: "example", title: "Example" },
      (scene) => {
        scene.place("ground", "waystation.ground");
        scene.place("building", "waystation.building", { variant: "cutaway" });
      }
    );

    expect(level).toEqual({
      id: "example",
      title: "Example",
      placements: [
        { id: "ground", asset: "waystation.ground", options: {} },
        {
          id: "building",
          asset: "waystation.building",
          options: { variant: "cutaway" }
        }
      ]
    });
  });

  it("rejects duplicate placement ids", () => {
    expect(() =>
      defineLevel({ id: "bad", title: "Bad" }, (scene) => {
        scene.place("ground", "waystation.ground");
        scene.place("ground", "waystation.ground");
      })
    ).toThrow('Level placement id is already used: ground');
  });
});
