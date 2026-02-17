import { describe, expect, it } from "vitest";
import type { SavedPropDefinition } from "./prop-library";
import {
  getAvailablePropColliderModes,
  resolveEffectivePropColliderMode,
  resolvePropColliderResolution
} from "./prop-collider-resolver";

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
    compoundCollider: partial.compoundCollider,
    colliderVariants: partial.colliderVariants
  };
}

describe("prop-collider-resolver", () => {
  it("lists available collider modes from definition variants", () => {
    const definition = makeDefinition({
      colliderVariants: {
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
              halfExtents: [0.2, 0.25, 0.2]
            }
          ]
        }
      }
    });

    expect(getAvailablePropColliderModes(definition)).toEqual([
      "box",
      "convex-hull",
      "compound-boxes"
    ]);
  });

  it("falls back to strongest available mode when explicit mode is unsupported", () => {
    const definition = makeDefinition({
      colliderVariants: {
        box: {
          type: "box",
          source: "aabb-v1",
          position: [0, 0.5, 0],
          halfExtents: [0.5, 0.5, 0.5]
        },
        compoundBoxes: {
          type: "compound-boxes",
          source: "auto-kmeans-v1",
          parts: [
            {
              kind: "box",
              position: [0, 0.25, 0],
              halfExtents: [0.2, 0.25, 0.2]
            }
          ]
        }
      }
    });

    expect(resolveEffectivePropColliderMode(definition, "convex-hull")).toBe(
      "compound-boxes"
    );
  });

  it("resolves compound collider parts and zero root offset", () => {
    const definition = makeDefinition({
      colliderVariants: {
        box: {
          type: "box",
          source: "aabb-v1",
          position: [0, 0.5, 0],
          halfExtents: [0.5, 0.5, 0.5]
        },
        compoundBoxes: {
          type: "compound-boxes",
          source: "auto-kmeans-v1",
          parts: [
            {
              kind: "box",
              position: [0.1, 0.3, -0.2],
              halfExtents: [0.15, 0.2, 0.25]
            }
          ]
        }
      }
    });

    const resolved = resolvePropColliderResolution({
      sourcePropId: "crate",
      definition,
      explicitMode: "compound-boxes",
      dimensions: { width: 1, height: 1, depth: 1 },
      convexVerticesByPropId: new Map()
    });

    expect(resolved.shape).toBe("compound-boxes");
    if (resolved.shape !== "compound-boxes") {
      return;
    }
    expect(resolved.localRootOffset).toEqual({ x: 0, y: 0, z: 0 });
    expect(resolved.parts[0]).toEqual({
      translation: { x: 0.1, y: 0.3, z: -0.2 },
      halfExtents: { x: 0.15, y: 0.2, z: 0.25 }
    });
  });

  it("caches flattened convex vertices by prop id", () => {
    const definition = makeDefinition({
      colliderVariants: {
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
        }
      }
    });
    const cache = new Map<string, Float32Array>();
    const first = resolvePropColliderResolution({
      sourcePropId: "chair",
      definition,
      explicitMode: "convex-hull",
      dimensions: { width: 1, height: 1, depth: 1 },
      convexVerticesByPropId: cache
    });
    const second = resolvePropColliderResolution({
      sourcePropId: "chair",
      definition,
      explicitMode: "convex-hull",
      dimensions: { width: 1, height: 1, depth: 1 },
      convexVerticesByPropId: cache
    });

    expect(first.shape).toBe("convex-hull");
    expect(second.shape).toBe("convex-hull");
    if (first.shape !== "convex-hull" || second.shape !== "convex-hull") {
      return;
    }
    expect(second.vertices).toBe(first.vertices);
    expect(cache.get("chair")).toBe(first.vertices);
  });

  it("falls back to box resolution when requested mode data is unavailable", () => {
    const resolved = resolvePropColliderResolution({
      sourcePropId: "unknown",
      definition: makeDefinition({
        colliderVariants: {
          box: {
            type: "box",
            source: "aabb-v1",
            position: [0, 0.5, 0],
            halfExtents: [0.5, 0.5, 0.5]
          }
        }
      }),
      explicitMode: "convex-hull",
      dimensions: { width: 2, height: 1, depth: 3 },
      convexVerticesByPropId: new Map()
    });

    expect(resolved.shape).toBe("box");
    if (resolved.shape !== "box") {
      return;
    }
    expect(resolved.halfExtents).toEqual({ x: 1, y: 0.5, z: 1.5 });
    expect(resolved.localRootOffset).toEqual({ x: 0, y: -0.5, z: 0 });
  });
});
