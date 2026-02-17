import { describe, expect, it } from "vitest";
import type { SavedPropDefinition } from "./prop-library";
import {
  estimateMassFromBounds,
  inferPhysicsMaterialFromDefinition,
  PHYSICS_MATERIAL_PRESETS
} from "./physics-settings";

function makeDefinition(
  partial: Partial<SavedPropDefinition>
): SavedPropDefinition {
  return {
    id: partial.id ?? "prop",
    description: partial.description ?? "prop",
    conceptImagePath: partial.conceptImagePath ?? "props/prop/raw/concept.png",
    bbox: partial.bbox ?? { width: 0.5, height: 0.5, depth: 0.5 },
    collider2d: partial.collider2d ?? { width: 0.5, depth: 0.5 },
    physicsHint: partial.physicsHint
  };
}

describe("physics-settings", () => {
  it("uses explicit material hints before token inference", () => {
    const material = inferPhysicsMaterialFromDefinition(
      makeDefinition({
        id: "terminal",
        description: "industrial terminal",
        physicsHint: { material: "wood" }
      })
    );

    expect(material).toBe("wood");
  });

  it("infers material from prop naming tokens", () => {
    expect(
      inferPhysicsMaterialFromDefinition(
        makeDefinition({
          id: "chemical-flask",
          description: "lab flask"
        })
      )
    ).toBe("glass");
    expect(
      inferPhysicsMaterialFromDefinition(
        makeDefinition({
          id: "mainframe",
          description: "industrial desk terminal"
        })
      )
    ).toBe("metal");
    expect(
      inferPhysicsMaterialFromDefinition(
        makeDefinition({
          id: "chair",
          description: "wood chair"
        })
      )
    ).toBe("wood");
  });

  it("keeps estimated mass within configured clamps", () => {
    const tiny = estimateMassFromBounds(0, 0, 0, PHYSICS_MATERIAL_PRESETS.default.density);
    const medium = estimateMassFromBounds(
      0.6,
      0.8,
      0.5,
      PHYSICS_MATERIAL_PRESETS.wood.density
    );
    const huge = estimateMassFromBounds(5, 5, 5, PHYSICS_MATERIAL_PRESETS.concrete.density);

    expect(tiny).toBeCloseTo(0.15);
    expect(medium).toBeGreaterThan(0.15);
    expect(huge).toBe(40);
  });
});
