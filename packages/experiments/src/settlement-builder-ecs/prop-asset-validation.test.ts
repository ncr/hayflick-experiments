import { describe, expect, it } from "vitest";
import type { SavedPropDefinition } from "./prop-library";
import {
  summarizePropAssetValidation,
  validateSavedPropDefinition
} from "./prop-asset-validation";

function makeDefinition(
  partial: Partial<SavedPropDefinition>
): SavedPropDefinition {
  return {
    id: partial.id ?? "prop",
    description: partial.description ?? "prop",
    conceptImagePath: partial.conceptImagePath ?? "props/prop/raw/concept.png",
    bbox: partial.bbox ?? { width: 1, height: 1, depth: 1 },
    collider2d: partial.collider2d ?? { width: 1, depth: 1 },
    physicsHint: partial.physicsHint,
    colliderVariants:
      partial.colliderVariants ??
      ({
        box: {
          type: "box",
          source: "aabb-v1",
          position: [0, 0.5, 0],
          halfExtents: [0.5, 0.5, 0.5]
        },
        convexHull: {
          type: "convex-hull",
          source: "sampled-points-v1",
          points: [
            [0, 0, 0],
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1]
          ],
          rootOffset: [0, -0.5, 0]
        },
        compoundBoxes: {
          type: "compound-boxes",
          source: "auto-kmeans-v1",
          parts: [
            {
              kind: "box",
              position: [0, 0.25, 0],
              halfExtents: [0.25, 0.25, 0.25]
            }
          ]
        }
      } as SavedPropDefinition["colliderVariants"]),
    compoundCollider: partial.compoundCollider
  };
}

describe("prop-asset-validation", () => {
  it("reports no issues for a complete metadata payload", () => {
    const issues = validateSavedPropDefinition(
      makeDefinition({
        physicsHint: {
          material: "metal",
          mass: 2,
          friction: 0.8,
          restitution: 0.03,
          linearDamping: 0.25,
          angularDamping: 0.35,
          activationDelayMs: 500
        }
      })
    );

    expect(issues).toHaveLength(0);
  });

  it("reports fallback/missing metadata as warnings", () => {
    const issues = validateSavedPropDefinition(
      makeDefinition({
        colliderVariants: {
          box: {
            type: "box",
            source: "bbox-fallback",
            position: [0, 0.5, 0],
            halfExtents: [0.5, 0.5, 0.5]
          }
        },
        physicsHint: {}
      })
    );

    expect(issues.map((issue) => issue.code)).toContain("collider-box-fallback");
    expect(issues.map((issue) => issue.code)).toContain("collider-convex-missing");
    expect(issues.map((issue) => issue.code)).toContain("collider-compound-missing");
    expect(issues.map((issue) => issue.code)).toContain("physics-material-missing");
  });

  it("reports invalid hard constraints as errors", () => {
    const issues = validateSavedPropDefinition(
      makeDefinition({
        bbox: { width: 0, height: 1, depth: 1 },
        physicsHint: { material: "wood", mass: 0 }
      })
    );
    const errors = issues.filter((issue) => issue.severity === "error");

    expect(errors.map((issue) => issue.code)).toContain("bbox-invalid");
    expect(errors.map((issue) => issue.code)).toContain("physics-mass-invalid");
  });

  it("summarizes warning/error totals across props", () => {
    const map = new Map([
      [
        "a",
        [
          {
            severity: "warning" as const,
            code: "collider-convex-missing" as const,
            message: "x"
          }
        ]
      ],
      [
        "b",
        [
          {
            severity: "error" as const,
            code: "bbox-invalid" as const,
            message: "y"
          },
          {
            severity: "warning" as const,
            code: "physics-material-missing" as const,
            message: "z"
          }
        ]
      ]
    ]);

    const summary = summarizePropAssetValidation(map);
    expect(summary.propsWithIssues).toBe(2);
    expect(summary.warningCount).toBe(2);
    expect(summary.errorCount).toBe(1);
    expect(summary.totalIssues).toBe(3);
  });
});
