import { describe, expect, it } from "vitest";
import {
  inferPropPhysicsProfile,
  withPropPhysicsMobility
} from "./prop-physics-profile";
import type { SavedPropDefinition } from "./prop-library";

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

describe("prop physics profile", () => {
  it("infers fixed mobility for large support props", () => {
    const profile = inferPropPhysicsProfile(
      makeDefinition({
        id: "mainframe",
        description: "industrial mainframe",
        bbox: { width: 1.6, height: 2.0, depth: 1.2 }
      })
    );

    expect(profile.mobility).toBe("fixed");
  });

  it("infers dynamic mobility for small loose props", () => {
    const profile = inferPropPhysicsProfile(
      makeDefinition({
        id: "chemical-flask",
        description: "chemical flask",
        bbox: { width: 0.35, height: 0.4, depth: 0.35 }
      })
    );

    expect(profile.mobility).toBe("dynamic");
    expect(profile.activationDelayMs).toBeGreaterThan(0);
  });

  it("applies physics hint overrides from metadata", () => {
    const profile = inferPropPhysicsProfile(
      makeDefinition({
        id: "chair",
        description: "lab chair",
        physicsHint: {
          mobility: "dynamic",
          mass: 1.2,
          friction: 0.6,
          restitution: 0.1,
          linearDamping: 0.2,
          angularDamping: 0.5,
          activationDelayMs: 150
        }
      })
    );

    expect(profile.mass).toBeCloseTo(1.2);
    expect(profile.friction).toBeCloseTo(0.6);
    expect(profile.activationDelayMs).toBe(150);
  });

  it("forces fixed profile to zero activation delay", () => {
    const dynamic = inferPropPhysicsProfile(
      makeDefinition({
        id: "flask",
        description: "flask",
        bbox: { width: 0.3, height: 0.3, depth: 0.3 }
      })
    );
    const fixed = withPropPhysicsMobility(dynamic, "fixed");
    expect(fixed.mobility).toBe("fixed");
    expect(fixed.activationDelayMs).toBe(0);
  });
});
