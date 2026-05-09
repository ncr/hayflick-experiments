import { describe, expect, it } from "vitest";
import {
  bakeGreyboxLevelForEcs,
  type GreyboxLevelBakeInput
} from "./greybox-bake";

function input(placements: GreyboxLevelBakeInput["placements"]): GreyboxLevelBakeInput {
  return {
    level: { id: "greybox-test", version: 1 },
    grid: { tiles: 5, tileSize: 1, origin: -2.5 },
    placements
  };
}

describe("bakeGreyboxLevelForEcs", () => {
  it("turns semantic greybox cells into terrain overrides", () => {
    const bake = bakeGreyboxLevelForEcs(
      input([
        { placement: "cell", definitionId: "terrain_grass", x: 1, z: 2 },
        { placement: "cell", definitionId: "terrain_asphalt", x: 2, z: 2 }
      ])
    );

    expect(bake.terrain.overrides).toEqual([
      { x: 1, z: 2, base: "grass" },
      { x: 2, z: 2, base: "road" }
    ]);
  });

  it("turns walls, windows, and doors into ECS structures and colliders", () => {
    const bake = bakeGreyboxLevelForEcs(
      input([
        { placement: "edge", definitionId: "wall_solid", ax: 1, az: 1, bx: 2, bz: 1 },
        { placement: "edge", definitionId: "window_wall", ax: 2, az: 1, bx: 3, bz: 1 },
        { placement: "edge", definitionId: "door_box", doorState: "open", ax: 3, az: 1, bx: 4, bz: 1 },
        { placement: "edge", definitionId: "door_box", doorState: "closed", ax: 1, az: 2, bx: 2, bz: 2 }
      ])
    );

    expect(bake.structures).toEqual([
      { kind: "wall", ax: 1, az: 1, bx: 2, bz: 1 },
      { kind: "window", ax: 2, az: 1, bx: 3, bz: 1 },
      { kind: "door", doorState: "open", ax: 3, az: 1, bx: 4, bz: 1 },
      { kind: "door", doorState: "closed", ax: 1, az: 2, bx: 2, bz: 2 }
    ]);
    expect(bake.colliderDescs.filter((desc) => desc.kind === "door")).toHaveLength(2);
    expect(bake.blockedCells).toEqual([
      { x: 1, z: 0 },
      { x: 2, z: 0 },
      { x: 1, z: 1 },
      { x: 2, z: 1 },
      { x: 1, z: 2 }
    ]);
  });

  it("expands a vertex corner into two semantic wall segments", () => {
    const bake = bakeGreyboxLevelForEcs(
      input([{ placement: "vertex", definitionId: "corner_solid", x: 2, z: 2, rotation: 1 }])
    );

    expect(bake.structures).toEqual([
      { kind: "wall", ax: 2, az: 2, bx: 2, bz: 3 },
      { kind: "wall", ax: 2, az: 2, bx: 1, bz: 2 }
    ]);
    expect(bake.colliderDescs.filter((desc) => desc.kind === "rect")).toHaveLength(2);
  });
});
