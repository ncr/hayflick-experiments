import { describe, expect, it } from "vitest";
import {
  createDefaultState,
  setCellStructure,
  setEdgeStructure,
  setVertexStructure
} from "./editor-state";
import {
  bakeMapEditorStateForEcs,
  createGreyboxPlacementsFromEditorState
} from "./semantic-bake";

describe("map editor semantic greybox bake", () => {
  it("converts the editor's flat greybox placements into semantic ECS bake input", () => {
    const state = createDefaultState();
    setCellStructure(state, 1, 1, "terrain_grass");
    setEdgeStructure(state, 1, 1, 2, 1, "wall_solid", false);
    setVertexStructure(state, 2, 2, "corner_solid", 3);

    expect(createGreyboxPlacementsFromEditorState(state)).toEqual([
      { placement: "cell", definitionId: "terrain_grass", x: 1, z: 1 },
      {
        placement: "edge",
        definitionId: "wall_solid",
        ax: 1,
        az: 1,
        bx: 2,
        bz: 1,
        flipped: false
      },
      { placement: "vertex", definitionId: "corner_solid", x: 2, z: 2, rotation: 3 }
    ]);
  });

  it("bakes terrain, structures, blocked cells, and collider descriptors from editor state", () => {
    const state = createDefaultState();
    setCellStructure(state, 1, 1, "terrain_asphalt");
    setEdgeStructure(state, 1, 1, 2, 1, "door_box", false, "closed");

    const bake = bakeMapEditorStateForEcs(state, { id: "editor-test", version: 7 });

    expect(bake.level).toEqual({ id: "editor-test", version: 7 });
    expect(bake.terrain.overrides).toEqual([{ x: 1, z: 1, base: "road" }]);
    expect(bake.structures).toEqual([
      { kind: "door", doorState: "closed", ax: 1, az: 1, bx: 2, bz: 1 }
    ]);
    expect(bake.blockedCells).toEqual([
      { x: 1, z: 0 },
      { x: 1, z: 1 }
    ]);
    expect(bake.colliderDescs).toHaveLength(1);
  });
});
