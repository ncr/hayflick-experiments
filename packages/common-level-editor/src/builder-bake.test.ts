import { describe, expect, it } from "vitest";
import {
  bakeLevelForEcs,
  createEcsLevelResourceFromBake,
  parseBakedLevel,
  type LevelBuilderBake,
  type LevelBuilderBakeInput
} from "./builder-bake";

function createInput(structures: LevelBuilderBakeInput["structures"]): LevelBuilderBakeInput {
  return {
    level: {
      id: "test-level",
      version: 1
    },
    grid: {
      tiles: 6,
      tileSize: 1,
      origin: -3
    },
    terrain: {
      defaultGround: "floor",
      overrides: []
    },
    structures
  };
}

describe("bakeLevelForEcs", () => {
  it("marks blocked cells from closed door segments and skips open doors", () => {
    const closed = bakeLevelForEcs(
      createInput([
        {
          kind: "door",
          doorState: "closed",
          ax: 2,
          az: 1,
          bx: 3,
          bz: 1
        }
      ])
    );

    const open = bakeLevelForEcs(
      createInput([
        {
          kind: "door",
          doorState: "open",
          ax: 2,
          az: 1,
          bx: 3,
          bz: 1
        }
      ])
    );

    expect(closed.blockedCells).toEqual([
      { x: 2, z: 0 },
      { x: 2, z: 1 }
    ]);
    expect(open.blockedCells).toEqual([]);
  });

  it("creates a mutable LevelResource aligned with bake grid origin/tile size", () => {
    const bake = bakeLevelForEcs(
      createInput([
        {
          kind: "wall",
          ax: 2,
          az: 1,
          bx: 3,
          bz: 1
        }
      ])
    );

    const resource = createEcsLevelResourceFromBake(bake);
    expect(resource.isBlocked(-0.1, -1.2)).toBe(true);
    expect(resource.isBlocked(-1.1, -1.2)).toBe(false);
  });
});

describe("parseBakedLevel", () => {
  it("migrates schemaVersion 1 terrain overrides into schemaVersion 2", () => {
    const v1: unknown = {
      schemaVersion: 1,
      level: { id: "legacy", version: 1 },
      grid: { tiles: 4, tileSize: 1, origin: -2 },
      terrain: {
        defaultGround: "grass",
        overrides: [{ x: 1, z: 1, type: "floor" }]
      },
      structures: [],
      blockedCells: [{ x: 1, z: 1 }]
    };

    const parsed = parseBakedLevel(v1);
    expect(parsed).not.toBeNull();
    expect((parsed as LevelBuilderBake).schemaVersion).toBe(2);
    expect((parsed as LevelBuilderBake).terrain.overrides).toEqual([{ x: 1, z: 1, base: "floor" }]);
  });
});
