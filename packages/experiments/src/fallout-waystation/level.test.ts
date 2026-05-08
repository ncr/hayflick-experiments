import { describe, expect, it } from "vitest";
import { defineLevel } from "./authoring";
import type { RenderableAsset } from "./asset-contract";
import { DEFAULT_CONFIG } from "./gui";
import { createWaystationLevel } from "./level";
import type { RenderableObject, WaystationRenderer } from "./renderer";

function fakeRenderable(onDispose: () => void): RenderableObject {
  return {
    node: {} as never,
    dispose: onDispose
  };
}

function fakeRenderer(onAdd: () => void, onRemove: () => void): WaystationRenderer {
  return {
    addObject() {
      onAdd();
    },
    removeObject() {
      onRemove();
    }
  } as unknown as WaystationRenderer;
}

describe("createWaystationLevel", () => {
  it("compiles authored placements into renderer objects and ECS systems", () => {
    let adds = 0;
    let removes = 0;
    let disposes = 0;
    let configures = 0;
    let systemFrames = 0;

    const assets: RenderableAsset[] = [
      {
        metadata: {
          id: "test.asset",
          label: "Test asset",
          kind: "scenery",
          creates: "object3d"
        },
        create() {
          return {
            renderable: fakeRenderable(() => {
              disposes += 1;
            }),
            configure() {
              configures += 1;
            },
            systems: [
              () => {
                systemFrames += 1;
              }
            ]
          };
        }
      }
    ];

    const definition = defineLevel(
      { id: "test-level", title: "Test Level" },
      (level) => {
        level.place("thing", "test.asset");
      }
    );

    const level = createWaystationLevel({
      renderer: fakeRenderer(
        () => {
          adds += 1;
        },
        () => {
          removes += 1;
        }
      ),
      config: DEFAULT_CONFIG,
      definition,
      assets
    });

    expect(level.id).toBe("test-level");
    expect(adds).toBe(1);
    expect(configures).toBe(1);

    level.step(0.25);
    expect(systemFrames).toBe(1);

    level.applyConfig(DEFAULT_CONFIG);
    expect(configures).toBe(2);

    level.dispose();
    expect(removes).toBe(1);
    expect(disposes).toBe(1);
  });

  it("fails early when an asset requirement points at a missing handle", () => {
    const assets: RenderableAsset[] = [
      {
        metadata: {
          id: "needs.building",
          label: "Needs building",
          kind: "effect",
          creates: "object3d",
          defaults: { building: "building" },
          requires: ["building"]
        },
        create() {
          return {
            renderable: fakeRenderable(() => undefined)
          };
        }
      }
    ];

    const definition = defineLevel(
      { id: "bad-level", title: "Bad Level" },
      (level) => {
        level.place("shafts", "needs.building");
      }
    );

    expect(() =>
      createWaystationLevel({
        renderer: fakeRenderer(
          () => undefined,
          () => undefined
        ),
        config: DEFAULT_CONFIG,
        definition,
        assets
      })
    ).toThrow('Placement "shafts" requires placement "building" to be created first.');
  });
});
