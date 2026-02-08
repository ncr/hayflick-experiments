import type { LevelResource, LevelSnapshot } from "@common/gameplay";
import { createMutableGridLevelResource } from "./grid-level";

export type LevelBuilderGroundBase = "floor" | "grass" | "road" | "sidewalk" | "building";
export type LevelBuilderDoorState = "open" | "closed";
export type LevelBuilderStructureKind = "wall" | "window" | "door";

export type LevelBuilderStructureSegment =
  | {
      kind: Exclude<LevelBuilderStructureKind, "door">;
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

export type LevelBuilderDoorSegment = Extract<LevelBuilderStructureSegment, { kind: "door" }>;
export type LevelBuilderSolidSegment = Exclude<LevelBuilderStructureSegment, { kind: "door" }>;

export type LevelBuilderColliderDesc =
  | {
      kind: "rect";
      x: number;
      y: number;
      w: number;
      h: number;
      layer: "solid";
    }
  | {
      kind: "door";
      placementId: string;
      x: number;
      y: number;
      w: number;
      h: number;
      closed: true;
    };

export const LEVEL_BUILDER_GROUND_BASE = {
  FLOOR: "floor",
  GRASS: "grass",
  ROAD: "road",
  SIDEWALK: "sidewalk",
  BUILDING: "building"
} as const;

export const LEVEL_BUILDER_DOOR_STATE = {
  OPEN: "open",
  CLOSED: "closed"
} as const;

export const LEVEL_BUILDER_STRUCTURE_KIND = {
  WALL: "wall",
  WINDOW: "window",
  DOOR: "door"
} as const;

export const LEVEL_BUILDER_COLLIDER_KIND = {
  RECT: "rect",
  DOOR: "door"
} as const;

export type LevelBuilderGroundOverride = {
  x: number;
  z: number;
  base: LevelBuilderGroundBase;
  variant?: number;
};

export type LevelBuilderBake = {
  schemaVersion: 3;
  level: LevelSnapshot;
  grid: {
    tiles: number;
    tileSize: number;
    origin: number;
  };
  terrain: {
    defaultGround: LevelBuilderGroundBase;
    overrides: LevelBuilderGroundOverride[];
  };
  structures: LevelBuilderStructureSegment[];
  blockedCells: Array<{ x: number; z: number }>;
  colliderDescs: LevelBuilderColliderDesc[];
};

export type LevelBuilderBakeInput = {
  level: LevelSnapshot;
  grid: {
    tiles: number;
    tileSize: number;
    origin: number;
  };
  terrain: {
    defaultGround: LevelBuilderGroundBase;
    overrides: LevelBuilderGroundOverride[];
  };
  structures: LevelBuilderStructureSegment[];
};

const GROUND_BASES = new Set<LevelBuilderGroundBase>(Object.values(LEVEL_BUILDER_GROUND_BASE));
const DOOR_THICKNESS = 0.18;

function toCellKey(x: number, z: number): string {
  return `${x},${z}`;
}

export function levelBuilderEdgeKey(ax: number, az: number, bx: number, bz: number): string {
  if (ax < bx || (ax === bx && az <= bz)) {
    return `${ax},${az}|${bx},${bz}`;
  }
  return `${bx},${bz}|${ax},${az}`;
}

export function levelBuilderDoorPlacementIdFromNodes(ax: number, az: number, bx: number, bz: number): string {
  return `door:${levelBuilderEdgeKey(ax, az, bx, bz)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

export function isLevelBuilderGroundBase(value: unknown): value is LevelBuilderGroundBase {
  return typeof value === "string" && GROUND_BASES.has(value as LevelBuilderGroundBase);
}

export function isLevelBuilderDoorState(value: unknown): value is LevelBuilderDoorState {
  return value === LEVEL_BUILDER_DOOR_STATE.OPEN || value === LEVEL_BUILDER_DOOR_STATE.CLOSED;
}

export function isLevelBuilderStructureKind(value: unknown): value is LevelBuilderStructureKind {
  return (
    value === LEVEL_BUILDER_STRUCTURE_KIND.WALL ||
    value === LEVEL_BUILDER_STRUCTURE_KIND.WINDOW ||
    value === LEVEL_BUILDER_STRUCTURE_KIND.DOOR
  );
}

export function isLevelBuilderDoorSegment(
  value: LevelBuilderStructureSegment
): value is LevelBuilderDoorSegment {
  return value.kind === LEVEL_BUILDER_STRUCTURE_KIND.DOOR;
}

export function isLevelBuilderSolidSegment(
  value: LevelBuilderStructureSegment
): value is LevelBuilderSolidSegment {
  return (
    value.kind === LEVEL_BUILDER_STRUCTURE_KIND.WALL ||
    value.kind === LEVEL_BUILDER_STRUCTURE_KIND.WINDOW
  );
}

function asGroundBase(value: unknown): LevelBuilderGroundBase | null {
  if (!isLevelBuilderGroundBase(value)) {
    return null;
  }

  return value;
}

function asGroundOverride(value: unknown): LevelBuilderGroundOverride | null {
  if (!isRecord(value)) {
    return null;
  }

  const x = asFiniteNumber(value.x);
  const z = asFiniteNumber(value.z);
  const base = asGroundBase(value.base);

  if (x === null || z === null || base === null) {
    return null;
  }

  const variantRaw = value.variant;
  const variant = variantRaw === undefined ? undefined : asFiniteNumber(variantRaw);
  if (variantRaw !== undefined && variant === null) {
    return null;
  }

  return {
    x,
    z,
    base,
    variant: variant === null || variant === undefined ? undefined : Math.max(0, Math.floor(variant))
  };
}

function asColliderDesc(value: unknown): LevelBuilderColliderDesc | null {
  if (!isRecord(value)) {
    return null;
  }

  const kind = value.kind;
  if (kind === LEVEL_BUILDER_COLLIDER_KIND.RECT) {
    const x = asFiniteNumber(value.x);
    const y = asFiniteNumber(value.y);
    const w = asFiniteNumber(value.w);
    const h = asFiniteNumber(value.h);
    const layer = value.layer;

    if (x === null || y === null || w === null || h === null || layer !== "solid") {
      return null;
    }

    return {
      kind,
      x,
      y,
      w,
      h,
      layer
    };
  }

  if (kind === LEVEL_BUILDER_COLLIDER_KIND.DOOR) {
    const placementId = value.placementId;
    const x = asFiniteNumber(value.x);
    const y = asFiniteNumber(value.y);
    const w = asFiniteNumber(value.w);
    const h = asFiniteNumber(value.h);
    const closed = value.closed;

    if (
      typeof placementId !== "string" ||
      x === null ||
      y === null ||
      w === null ||
      h === null ||
      closed !== true
    ) {
      return null;
    }

    return {
      kind,
      placementId,
      x,
      y,
      w,
      h,
      closed
    };
  }

  return null;
}

function isStructureSegment(value: unknown): value is LevelBuilderStructureSegment {
  if (!isRecord(value)) {
    return false;
  }

  const ax = asFiniteNumber(value.ax);
  const az = asFiniteNumber(value.az);
  const bx = asFiniteNumber(value.bx);
  const bz = asFiniteNumber(value.bz);
  if (ax === null || az === null || bx === null || bz === null) {
    return false;
  }

  if (!isLevelBuilderStructureKind(value.kind)) {
    return false;
  }

  if (value.kind === LEVEL_BUILDER_STRUCTURE_KIND.DOOR) {
    return isLevelBuilderDoorState(value.doorState);
  }

  return true;
}

function deriveDoorColliderDesc(segment: LevelBuilderDoorSegment): LevelBuilderColliderDesc {
  const minX = Math.min(segment.ax, segment.bx);
  const maxX = Math.max(segment.ax, segment.bx);
  const minY = Math.min(segment.az, segment.bz);
  const maxY = Math.max(segment.az, segment.bz);

  const isVertical = segment.ax === segment.bx;
  const width = isVertical ? DOOR_THICKNESS : Math.max(0.1, maxX - minX);
  const height = isVertical ? Math.max(0.1, maxY - minY) : DOOR_THICKNESS;
  const x = isVertical ? segment.ax : minX + (maxX - minX) * 0.5;
  const y = isVertical ? minY + (maxY - minY) * 0.5 : segment.az;

  return {
    kind: LEVEL_BUILDER_COLLIDER_KIND.DOOR,
    placementId: levelBuilderDoorPlacementIdFromNodes(
      segment.ax,
      segment.az,
      segment.bx,
      segment.bz
    ),
    x,
    y,
    w: width,
    h: height,
    closed: true
  };
}

function linkedCellsForDoorSegment(segment: LevelBuilderDoorSegment): Array<{ x: number; z: number }> {
  const cells: Array<{ x: number; z: number }> = [];

  if (segment.ax === segment.bx) {
    const z = Math.min(segment.az, segment.bz);
    cells.push({ x: segment.ax - 1, z });
    cells.push({ x: segment.ax, z });
    return cells;
  }

  const x = Math.min(segment.ax, segment.bx);
  cells.push({ x, z: segment.az - 1 });
  cells.push({ x, z: segment.az });
  return cells;
}

function deriveColliderDescs(
  blockedCells: Array<{ x: number; z: number }>,
  structures: LevelBuilderStructureSegment[]
): LevelBuilderColliderDesc[] {
  const doorLinkedCells = new Set<string>();
  for (const segment of structures) {
    if (!isLevelBuilderDoorSegment(segment)) {
      continue;
    }
    for (const cell of linkedCellsForDoorSegment(segment)) {
      doorLinkedCells.add(toCellKey(cell.x, cell.z));
    }
  }

  const colliders: LevelBuilderColliderDesc[] = blockedCells
    .filter((cell) => !doorLinkedCells.has(toCellKey(cell.x, cell.z)))
    .map((cell) => ({
      kind: LEVEL_BUILDER_COLLIDER_KIND.RECT,
      x: cell.x + 0.5,
      y: cell.z + 0.5,
      w: 1,
      h: 1,
      layer: "solid"
    }));

  const seenDoors = new Set<string>();
  for (const segment of structures) {
    if (!isLevelBuilderDoorSegment(segment)) {
      continue;
    }

    const placementId = levelBuilderDoorPlacementIdFromNodes(
      segment.ax,
      segment.az,
      segment.bx,
      segment.bz
    );
    if (seenDoors.has(placementId)) {
      continue;
    }

    seenDoors.add(placementId);
    colliders.push(deriveDoorColliderDesc(segment));
  }

  return colliders;
}

export function parseBakedLevel(raw: unknown): LevelBuilderBake | null {
  if (!isRecord(raw)) {
    return null;
  }

  const schemaVersion = asFiniteNumber(raw.schemaVersion);
  if (schemaVersion !== 3) {
    return null;
  }

  const level = raw.level;
  const grid = raw.grid;
  const terrain = raw.terrain;
  const structures = raw.structures;
  const blockedCells = raw.blockedCells;
  const colliderDescsRaw = raw.colliderDescs;

  if (
    !isRecord(level) ||
    !isRecord(grid) ||
    !isRecord(terrain) ||
    !Array.isArray(structures) ||
    !Array.isArray(blockedCells) ||
    !Array.isArray(colliderDescsRaw)
  ) {
    return null;
  }

  const levelId = typeof level.id === "string" ? level.id : null;
  const levelVersion = asFiniteNumber(level.version);
  const tiles = asFiniteNumber(grid.tiles);
  const tileSize = asFiniteNumber(grid.tileSize);
  const origin = asFiniteNumber(grid.origin);

  if (levelId === null || levelVersion === null || tiles === null || tileSize === null || origin === null) {
    return null;
  }

  const defaultGround = asGroundBase(terrain.defaultGround);
  const overridesRaw = terrain.overrides;
  if (defaultGround === null || !Array.isArray(overridesRaw)) {
    return null;
  }

  const overrides: LevelBuilderGroundOverride[] = [];
  for (const entry of overridesRaw) {
    const override = asGroundOverride(entry);
    if (!override) {
      return null;
    }
    overrides.push(override);
  }

  const parsedStructures: LevelBuilderStructureSegment[] = [];
  for (const entry of structures) {
    if (!isStructureSegment(entry)) {
      return null;
    }
    parsedStructures.push(entry);
  }

  const parsedBlocked: Array<{ x: number; z: number }> = [];
  for (const cell of blockedCells) {
    if (!isRecord(cell)) {
      return null;
    }

    const x = asFiniteNumber(cell.x);
    const z = asFiniteNumber(cell.z);
    if (x === null || z === null) {
      return null;
    }

    parsedBlocked.push({ x, z });
  }

  const colliderDescs: LevelBuilderColliderDesc[] = [];
  for (const rawDesc of colliderDescsRaw) {
    const desc = asColliderDesc(rawDesc);
    if (!desc) {
      return null;
    }
    colliderDescs.push(desc);
  }

  return {
    schemaVersion: 3,
    level: {
      id: levelId,
      version: levelVersion
    },
    grid: {
      tiles,
      tileSize,
      origin
    },
    terrain: {
      defaultGround,
      overrides
    },
    structures: parsedStructures,
    blockedCells: parsedBlocked,
    colliderDescs
  };
}

export function deserializeBakedLevel(json: string): LevelBuilderBake | null {
  try {
    const parsed: unknown = JSON.parse(json);
    return parseBakedLevel(parsed);
  } catch {
    return null;
  }
}

function markBlocked(blocked: Set<string>, tiles: number, x: number, z: number): void {
  if (x < 0 || x >= tiles || z < 0 || z >= tiles) {
    return;
  }
  blocked.add(toCellKey(x, z));
}

function markSegmentAdjacency(blocked: Set<string>, tiles: number, segment: LevelBuilderStructureSegment): void {
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

export function bakeLevelForEcs(input: LevelBuilderBakeInput): LevelBuilderBake {
  const blocked = new Set<string>();

  for (const segment of input.structures) {
    if (
      isLevelBuilderDoorSegment(segment) &&
      segment.doorState === LEVEL_BUILDER_DOOR_STATE.OPEN
    ) {
      continue;
    }

    markSegmentAdjacency(blocked, input.grid.tiles, segment);
  }

  const blockedCells = [...blocked]
    .map((key) => {
      const [xStr, zStr] = key.split(",");
      return { x: Number(xStr), z: Number(zStr) };
    })
    .sort((a, b) => a.z - b.z || a.x - b.x);

  return {
    schemaVersion: 3,
    level: input.level,
    grid: input.grid,
    terrain: {
      defaultGround: input.terrain.defaultGround,
      overrides: input.terrain.overrides.slice()
    },
    structures: input.structures.slice(),
    blockedCells,
    colliderDescs: deriveColliderDescs(blockedCells, input.structures)
  };
}

export function createEcsLevelResourceFromBake(bake: LevelBuilderBake): LevelResource {
  return createMutableGridLevelResource({
    id: bake.level.id,
    version: bake.level.version,
    width: bake.grid.tiles,
    height: bake.grid.tiles,
    blockedCells: bake.blockedCells.map((cell) => ({ x: cell.x, y: cell.z })),
    toCell(x: number, y: number): { x: number; y: number } {
      return {
        x: Math.floor((x - bake.grid.origin) / bake.grid.tileSize),
        y: Math.floor((y - bake.grid.origin) / bake.grid.tileSize)
      };
    }
  });
}

export function serializeBakedLevel(bake: LevelBuilderBake): string {
  return JSON.stringify(bake, null, 2);
}
