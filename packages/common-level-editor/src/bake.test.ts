import { describe, expect, it } from "vitest";
import { bakeTileLevel } from "./bake";
import { TILE_WALKABLE, TILE_WALL, createLevelModel, setTileAt, type LevelModel } from "./model";

function makeLevel(): LevelModel {
  const level = createLevelModel(5, 5);
  setTileAt(level, 2, 2, TILE_WALL);
  setTileAt(level, 1, 2, TILE_WALL);
  return level;
}

describe("bakeTileLevel", () => {
  it("bakes wall tiles into blocked cells", () => {
    const level = makeLevel();
    const baked = bakeTileLevel(level, { id: "baked", version: 9 });

    expect(baked.levelResource.id).toBe("baked");
    expect(baked.levelResource.version).toBe(9);
    expect(baked.levelResource.isBlocked(2, 2)).toBe(true);
    expect(baked.levelResource.isBlocked(0, 0)).toBe(false);
  });

  it("applies door placement state as blocked override", () => {
    const level = makeLevel();
    level.placements.push({
      id: "door-1",
      kind: "door",
      x: 2,
      y: 2,
      data: { open: true }
    });

    const openDoor = bakeTileLevel(level);
    expect(openDoor.levelResource.isBlocked(2, 2)).toBe(false);

    level.placements[0].data = { open: false };
    const closedDoor = bakeTileLevel(level);
    expect(closedDoor.levelResource.isBlocked(2, 2)).toBe(true);
  });

  it("copies placement records and does not share nested data references", () => {
    const level = createLevelModel(2, 2);
    level.tiles[0] = TILE_WALKABLE;
    level.placements.push({
      id: "door-1",
      kind: "door",
      x: 1,
      y: 1,
      data: { open: false, locked: true }
    });

    const baked = bakeTileLevel(level);
    baked.placements[0].data!.open = true;
    expect(level.placements[0].data?.open).toBe(false);
  });
});
