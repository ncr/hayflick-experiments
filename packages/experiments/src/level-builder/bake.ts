import type { LevelResource, LevelSnapshot } from "@common/gameplay";

export type LevelBuilderGroundType = "floor" | "grass";
export type LevelBuilderDoorState = "open" | "closed";

export type LevelBuilderStructureSegment =
  | {
      kind: "wall" | "window";
      ax: number;
      az: number;
      bx: number;
      bz: number;
    }
  | {
      kind: "door";
      doorState: LevelBuilderDoorState;
      ax: number;
      az: number;
      bx: number;
      bz: number;
    };

export type LevelBuilderGroundOverride = {
  x: number;
  z: number;
  type: LevelBuilderGroundType;
};

export type LevelBuilderBake = {
  schemaVersion: 1;
  level: LevelSnapshot;
  grid: {
    tiles: number;
    tileSize: number;
    origin: number;
  };
  terrain: {
    defaultGround: LevelBuilderGroundType;
    overrides: LevelBuilderGroundOverride[];
  };
  structures: LevelBuilderStructureSegment[];
  blockedCells: Array<{ x: number; z: number }>;
};

type BakeInput = {
  level: LevelSnapshot;
  grid: {
    tiles: number;
    tileSize: number;
    origin: number;
  };
  terrain: {
    defaultGround: LevelBuilderGroundType;
    overrides: LevelBuilderGroundOverride[];
  };
  structures: LevelBuilderStructureSegment[];
};

function toCellKey(x: number, z: number): string {
  return `${x},${z}`;
}

function markBlocked(
  blocked: Set<string>,
  tiles: number,
  x: number,
  z: number
): void {
  if (x < 0 || x >= tiles || z < 0 || z >= tiles) {
    return;
  }
  blocked.add(toCellKey(x, z));
}

function markSegmentAdjacency(
  blocked: Set<string>,
  tiles: number,
  segment: LevelBuilderStructureSegment
): void {
  const minX = Math.min(segment.ax, segment.bx);
  const maxX = Math.max(segment.ax, segment.bx);
  const minZ = Math.min(segment.az, segment.bz);
  const maxZ = Math.max(segment.az, segment.bz);

  if (segment.ax === segment.bx) {
    const lineX = segment.ax;
    for (let z = minZ; z < maxZ; z += 1) {
      markBlocked(blocked, tiles, lineX - 1, z);
      markBlocked(blocked, tiles, lineX, z);
    }
    return;
  }

  const lineZ = segment.az;
  for (let x = minX; x < maxX; x += 1) {
    markBlocked(blocked, tiles, x, lineZ - 1);
    markBlocked(blocked, tiles, x, lineZ);
  }
}

export function bakeLevelForEcs(input: BakeInput): LevelBuilderBake {
  const blocked = new Set<string>();

  for (const segment of input.structures) {
    if (segment.kind === "door" && segment.doorState === "open") {
      continue;
    }

    markSegmentAdjacency(blocked, input.grid.tiles, segment);
  }

  const blockedCells = [...blocked]
    .map((key) => {
      const [xStr, zStr] = key.split(",");
      return { x: Number(xStr), z: Number(zStr) };
    })
    .sort((a, b) => (a.z - b.z) || (a.x - b.x));

  return {
    schemaVersion: 1,
    level: input.level,
    grid: input.grid,
    terrain: {
      defaultGround: input.terrain.defaultGround,
      overrides: input.terrain.overrides.slice()
    },
    structures: input.structures.slice(),
    blockedCells
  };
}

export function createEcsLevelResourceFromBake(bake: LevelBuilderBake): LevelResource {
  const blocked = new Set<string>(bake.blockedCells.map((cell) => toCellKey(cell.x, cell.z)));

  return {
    id: bake.level.id,
    version: bake.level.version,
    isBlocked(x: number, y: number): boolean {
      const cellX = Math.floor((x - bake.grid.origin) / bake.grid.tileSize);
      const cellZ = Math.floor((y - bake.grid.origin) / bake.grid.tileSize);

      if (cellX < 0 || cellX >= bake.grid.tiles || cellZ < 0 || cellZ >= bake.grid.tiles) {
        return true;
      }

      return blocked.has(toCellKey(cellX, cellZ));
    }
  };
}

export function serializeBakedLevel(bake: LevelBuilderBake): string {
  return JSON.stringify(bake, null, 2);
}
