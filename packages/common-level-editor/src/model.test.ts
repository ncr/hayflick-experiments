import { describe, expect, it } from "vitest";
import {
  LEVEL_MODEL_PLACEMENT_KIND,
  TILE_WALKABLE,
  TILE_WALL,
  addDoorPlacement,
  cloneLevelModel,
  createDefaultLevelModel,
  createLevelModel,
  findDoorPlacementAt,
  getTileAt,
  isDoorPlacementKind,
  nextPlacementId,
  parseLevelModel,
  removeDoorPlacementAt,
  serializeLevelModel,
  setTileAt
} from "./model";

describe("model", () => {
  it("exposes placement discriminant helpers", () => {
    expect(isDoorPlacementKind(LEVEL_MODEL_PLACEMENT_KIND.DOOR)).toBe(true);
    expect(isDoorPlacementKind("window")).toBe(false);
  });

  it("creates and mutates a level grid with bounds checks", () => {
    const level = createLevelModel(4, 3);
    expect(level.width).toBe(4);
    expect(level.height).toBe(3);
    expect(getTileAt(level, 1, 1)).toBe(TILE_WALKABLE);
    expect(getTileAt(level, -1, 0)).toBe(TILE_WALL);

    expect(setTileAt(level, 1, 1, TILE_WALL)).toBe(true);
    expect(setTileAt(level, 1, 1, TILE_WALL)).toBe(false);
    expect(setTileAt(level, 99, 99, TILE_WALL)).toBe(false);
    expect(getTileAt(level, 1, 1)).toBe(TILE_WALL);
  });

  it("adds, updates, and removes door placements by stable id and cell", () => {
    const level = createLevelModel(6, 6);
    addDoorPlacement(level, { id: "door-1", kind: "door", x: 2, y: 2, rot: 1, data: { open: false } });

    expect(findDoorPlacementAt(level, 2, 2)?.id).toBe("door-1");
    expect(nextPlacementId(level)).toBe("door-2");

    addDoorPlacement(level, { id: "door-1", kind: "door", x: 3, y: 2, rot: 2, data: { open: true } });
    expect(findDoorPlacementAt(level, 2, 2)).toBeUndefined();
    expect(findDoorPlacementAt(level, 3, 2)?.data?.open).toBe(true);

    expect(removeDoorPlacementAt(level, 3, 2)).toBe(true);
    expect(removeDoorPlacementAt(level, 3, 2)).toBe(false);
  });

  it("serializes/parses and clones without sharing nested mutable objects", () => {
    const level = createDefaultLevelModel();
    const raw = serializeLevelModel(level);
    const parsed = parseLevelModel(JSON.parse(raw));
    expect(parsed).not.toBeNull();

    const clone = cloneLevelModel(parsed!);
    const originalTile = parsed!.tiles[0];
    const originalDoorOpen = parsed!.placements[0]?.data?.open;
    clone.tiles[0] = TILE_WALL;
    if (clone.placements[0]?.data) {
      clone.placements[0].data.open = true;
    }

    expect(parsed?.tiles[0]).toBe(originalTile);
    expect(parsed?.placements[0]?.data?.open).toBe(originalDoorOpen);
  });

  it("rejects invalid parsed payloads", () => {
    expect(parseLevelModel(null)).toBeNull();
    expect(parseLevelModel({ width: 2, height: 2, tiles: [0], placements: [] })).toBeNull();
    expect(parseLevelModel({ width: 2, height: 2, tiles: [0, 0, 0, 0], placements: [{ id: 1 }] })).toBeNull();
  });

  it("ships a two-room default mockup with shared-wall and exterior doors", () => {
    const level = createDefaultLevelModel();

    expect(level.width).toBe(18);
    expect(level.height).toBe(18);

    // Shared wall and connecting door between the two rooms.
    expect(getTileAt(level, 9, 8)).toBe(TILE_WALL);
    expect(findDoorPlacementAt(level, 9, 8)?.id).toBe("door-1");

    // Exterior door from one room.
    expect(getTileAt(level, 6, 6)).toBe(TILE_WALL);
    expect(findDoorPlacementAt(level, 6, 6)?.id).toBe("door-2");
  });
});
