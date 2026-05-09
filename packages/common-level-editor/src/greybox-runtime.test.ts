import { describe, expect, it } from "vitest";
import { createGreyboxRuntimeScene } from "./greybox-runtime";

describe("createGreyboxRuntimeScene", () => {
  it("builds renderer objects and an ECS level resource from semantic greybox placements", () => {
    const scene = createGreyboxRuntimeScene({
      level: { id: "runtime-greybox", version: 1 },
      grid: { tiles: 6, tileSize: 1.28, origin: -3.84 },
      placements: [
        { placement: "cell", definitionId: "terrain_grass", x: 1, z: 1 },
        { placement: "edge", definitionId: "wall_solid", ax: 2, az: 2, bx: 3, bz: 2 },
        { placement: "vertex", definitionId: "corner_solid", x: 3, z: 3, rotation: 0 }
      ]
    });

    expect(scene.bake.level).toEqual({ id: "runtime-greybox", version: 1 });
    expect(scene.root.children).toHaveLength(3);
    expect([...scene.runtime.world.queryTransformSceneRef()]).toHaveLength(3);
    expect(scene.runtime.world.level.isBlocked(-0.7, -1.3)).toBe(true);
    expect(scene.bake.terrain.overrides).toEqual([{ x: 1, z: 1, base: "grass" }]);

    scene.dispose();
    expect(scene.root.children).toHaveLength(0);
    expect([...scene.runtime.world.entities()]).toHaveLength(0);
  });
});
