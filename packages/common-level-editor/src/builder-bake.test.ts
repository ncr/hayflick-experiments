import { describe, expect, it } from "vitest";
import {
  LEVEL_BUILDER_DOOR_STATE,
  LEVEL_BUILDER_STRUCTURE_KIND,
  bakeLevelForEcs,
  createEcsLevelResourceFromBake,
  deserializeBakedLevel,
  isLevelBuilderDoorSegment,
  isLevelBuilderDoorState,
  isLevelBuilderGroundBase,
  isLevelBuilderSolidSegment,
  isLevelBuilderStructureKind,
  levelBuilderDoorPlacementIdFromNodes,
  parseBakedLevel,
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

  it("emits collider descriptors for blocked cells and doors", () => {
    const bake = bakeLevelForEcs(
      createInput([
        {
          kind: "wall",
          ax: 1,
          az: 1,
          bx: 1,
          bz: 2
        },
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

    const rectColliders = bake.colliderDescs.filter((desc) => desc.kind === "rect");
    const doorColliders = bake.colliderDescs.filter((desc) => desc.kind === "door");

    expect(rectColliders.length).toBeLessThan(bake.blockedCells.length);
    expect(doorColliders).toHaveLength(1);
    expect(doorColliders[0]).toMatchObject({
      kind: "door",
      placementId: levelBuilderDoorPlacementIdFromNodes(2, 1, 3, 1),
      closed: true
    });
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

  it("handles vertical segments and ignores out-of-bounds adjacency cells", () => {
    const bake = bakeLevelForEcs(
      createInput([
        {
          kind: "wall",
          ax: 0,
          az: 0,
          bx: 0,
          bz: 2
        }
      ])
    );

    expect(bake.blockedCells).toEqual([
      { x: 0, z: 0 },
      { x: 0, z: 1 }
    ]);
  });
});

describe("parseBakedLevel", () => {
  it("parses valid schemaVersion 3 payloads", () => {
    const v3: unknown = {
      schemaVersion: 3,
      level: { id: "v3", version: 3 },
      grid: { tiles: 4, tileSize: 1, origin: -2 },
      terrain: {
        defaultGround: "road",
        overrides: [{ x: 1, z: 2, base: "grass", variant: 3 }]
      },
      structures: [
        { kind: "wall", ax: 1, az: 1, bx: 1, bz: 2 },
        { kind: "door", doorState: "closed", ax: 2, az: 1, bx: 3, bz: 1 }
      ],
      blockedCells: [{ x: 1, z: 1 }],
      colliderDescs: [
        { kind: "rect", x: 1.5, y: 1.5, w: 1, h: 1, layer: "solid" },
        {
          kind: "door",
          placementId: "door:2,1|3,1",
          x: 2.5,
          y: 1,
          w: 1,
          h: 0.18,
          closed: true
        }
      ]
    };

    const parsed = parseBakedLevel(v3);
    expect(parsed).not.toBeNull();
    expect(parsed?.schemaVersion).toBe(3);
    expect(parsed?.terrain.defaultGround).toBe("road");
    expect(parsed?.structures).toHaveLength(2);
    expect(parsed?.colliderDescs).toHaveLength(2);
  });

  it("rejects non-current schema payloads", () => {
    expect(
      parseBakedLevel({
        schemaVersion: 2,
        level: { id: "legacy-v2", version: 2 },
        grid: { tiles: 4, tileSize: 1, origin: -2 },
        terrain: {
          defaultGround: "grass",
          overrides: [{ x: 1, z: 1, base: "floor" }]
        },
        structures: [],
        blockedCells: []
      })
    ).toBeNull();

    expect(
      parseBakedLevel({
        schemaVersion: 1,
        level: { id: "legacy-v1", version: 1 },
        grid: { tiles: 4, tileSize: 1, origin: -2 },
        terrain: {
          defaultGround: "grass",
          overrides: [{ x: 1, z: 1, type: "floor" }]
        },
        structures: [],
        blockedCells: []
      })
    ).toBeNull();
  });

  it("rejects malformed payloads and invalid JSON during deserialize", () => {
    expect(
      parseBakedLevel({
        schemaVersion: 3,
        level: { id: "bad", version: 1 },
        grid: { tiles: 4, tileSize: 1, origin: -2 },
        terrain: { defaultGround: "invalid", overrides: [] },
        structures: [],
        blockedCells: [],
        colliderDescs: []
      })
    ).toBeNull();

    expect(
      parseBakedLevel({
        schemaVersion: 3,
        level: { id: "bad", version: 1 },
        grid: { tiles: 4, tileSize: 1, origin: -2 },
        terrain: { defaultGround: "grass", overrides: [{ x: 0, z: 0, base: "road", variant: "oops" }] },
        structures: [],
        blockedCells: [],
        colliderDescs: []
      })
    ).toBeNull();

    expect(
      parseBakedLevel({
        schemaVersion: 3,
        level: { id: "bad", version: 1 },
        grid: { tiles: 4, tileSize: 1, origin: -2 },
        terrain: { defaultGround: "grass", overrides: [] },
        structures: [{ kind: "door", doorState: "ajar", ax: 1, az: 1, bx: 2, bz: 1 }],
        blockedCells: [],
        colliderDescs: []
      })
    ).toBeNull();

    expect(
      parseBakedLevel({
        schemaVersion: 3,
        level: { id: "bad", version: 1 },
        grid: { tiles: 4, tileSize: 1, origin: -2 },
        terrain: { defaultGround: "grass", overrides: [] },
        structures: [],
        blockedCells: [{ x: "x", z: 1 }],
        colliderDescs: []
      })
    ).toBeNull();

    expect(deserializeBakedLevel("{not-json")).toBeNull();
  });
});

describe("builder-bake type guards", () => {
  it("validates discriminants and segment predicates", () => {
    expect(isLevelBuilderGroundBase("road")).toBe(true);
    expect(isLevelBuilderGroundBase("lava")).toBe(false);

    expect(isLevelBuilderDoorState(LEVEL_BUILDER_DOOR_STATE.OPEN)).toBe(true);
    expect(isLevelBuilderDoorState("ajar")).toBe(false);

    expect(isLevelBuilderStructureKind(LEVEL_BUILDER_STRUCTURE_KIND.WALL)).toBe(
      true
    );
    expect(isLevelBuilderStructureKind("column")).toBe(false);

    const doorSegment = {
      kind: LEVEL_BUILDER_STRUCTURE_KIND.DOOR,
      doorState: LEVEL_BUILDER_DOOR_STATE.CLOSED,
      ax: 1,
      az: 1,
      bx: 2,
      bz: 1
    } as const;

    const wallSegment = {
      kind: LEVEL_BUILDER_STRUCTURE_KIND.WALL,
      ax: 1,
      az: 1,
      bx: 1,
      bz: 2
    } as const;

    expect(isLevelBuilderDoorSegment(doorSegment)).toBe(true);
    expect(isLevelBuilderSolidSegment(doorSegment)).toBe(false);
    expect(isLevelBuilderDoorSegment(wallSegment)).toBe(false);
    expect(isLevelBuilderSolidSegment(wallSegment)).toBe(true);
  });
});
