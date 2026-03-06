import { describe, expect, it } from "vitest";
import { parseForgePropMeta } from "./forge-v2-props";

describe("physics-prop-drop forge props", () => {
  it("uses the selected compound hull preset and negates finalPivot into a root offset", () => {
    const meta = parseForgePropMeta("crate", {
      processing: {
        transform: {
          finalPivot: {
            offset: [0.25, 0.5, -0.75]
          }
        }
      },
      colliders: {
        selectedPresetId: "fast-preview",
        presets: [
          {
            presetId: "fast-preview",
            generation: { hullCount: 4 },
            collider: {
              type: "compound-convex-hulls",
              params: {
                parts: [
                  {
                    position: [0, 0.5, 0],
                    points: [
                      [-0.5, -0.5, -0.25],
                      [0.5, -0.5, -0.25],
                      [0.5, 0.5, -0.25],
                      [-0.5, 0.5, 0.25]
                    ]
                  }
                ]
              }
            }
          },
          {
            presetId: "high-detail",
            generation: { hullCount: 16 },
            collider: {
              type: "compound-convex-hulls",
              params: {
                parts: [
                  {
                    position: [99, 99, 99],
                    points: [
                      [0, 0, 0],
                      [1, 0, 0],
                      [0, 1, 0],
                      [0, 0, 1]
                    ]
                  }
                ]
              }
            }
          }
        ]
      }
    });

    expect(meta.collider).not.toBeNull();
    if (!meta.collider) {
      throw new Error("expected collider");
    }
    expect(meta.collider.parts).toHaveLength(1);
    expect(meta.collider.parts[0]?.translation).toEqual({ x: 0, y: 0.5, z: 0 });
    expect(meta.collider.localRootOffset).toEqual({ x: -0.25, y: -0.5, z: 0.75 });
    expect(meta.collider.dimensions).toEqual({ width: 1, height: 1, depth: 0.5 });
  });

  it("falls back to collider-derived dimensions when bboxProcessed is missing", () => {
    const meta = parseForgePropMeta("chair", {
      processing: {
        mesh: {},
        transform: {
          finalPivot: {
            offset: [0, 0.4, 0]
          }
        }
      },
      colliders: {
        presets: [
          {
            presetId: "balanced",
            generation: { hullCount: 8 },
            collider: {
              type: "compound-convex-hulls",
              params: {
                parts: [
                  {
                    position: [-0.5, 0, -0.25],
                    points: [
                      [0, 0, 0],
                      [1, 0, 0],
                      [1, 2, 0.5],
                      [0, 2, 0.5]
                    ]
                  },
                  {
                    position: [0.5, 0.5, 0.25],
                    points: [
                      [-0.25, -0.5, -0.25],
                      [0.25, -0.5, -0.25],
                      [0.25, 0.5, 0.25],
                      [-0.25, 0.5, 0.25]
                    ]
                  }
                ]
              }
            }
          }
        ]
      }
    });

    expect(meta.collider).not.toBeNull();
    if (!meta.collider) {
      throw new Error("expected collider");
    }
    expect(meta.collider.dimensions).toEqual({ width: 1.25, height: 2, depth: 0.75 });
    expect(meta.physics.mass).toBeGreaterThan(0.08);
  });

  it("returns null collider when no valid compound hull preset exists", () => {
    const meta = parseForgePropMeta("lamp", {
      processing: {},
      colliders: {
        presets: [
          {
            presetId: "box",
            collider: {
              type: "box"
            }
          }
        ]
      }
    });

    expect(meta.collider).toBeNull();
    expect(meta.physics.mass).toBeGreaterThan(0);
  });

  it("prefers resolved forge physics over empty overrides", () => {
    const meta = parseForgePropMeta("desk", {
      processing: {
        mesh: {
          bboxProcessed: {
            width: 2,
            height: 1,
            depth: 1
          }
        }
      },
      colliders: {
        presets: [
          {
            presetId: "balanced",
            generation: { hullCount: 8 },
            collider: {
              type: "compound-convex-hulls",
              params: {
                parts: [
                  {
                    position: [0, 0.5, 0],
                    points: [
                      [-1, -0.5, -0.5],
                      [1, -0.5, -0.5],
                      [1, 0.5, 0.5],
                      [-1, 0.5, 0.5]
                    ]
                  }
                ]
              }
            }
          }
        ]
      },
      physics: {
        kind: "wood",
        overrides: {},
        resolved: {
          material: "metal",
          manualMass: 12,
          friction: 0.61,
          restitution: 0.02,
          linearDamping: 0.44,
          angularDamping: 0.57
        }
      }
    });

    expect(meta.physics).toEqual({
      mass: 12,
      friction: 0.61,
      restitution: 0.02,
      linearDamping: 0.44,
      angularDamping: 0.57
    });
  });
});
