import {
  LEVEL_BUILDER_STRUCTURE_KIND as STRUCTURE_KIND,
  isLevelBuilderDoorState,
  isLevelBuilderGroundBase,
  isLevelBuilderStructureKind,
  type LevelBuilderDoorState,
  type LevelBuilderGroundBase,
  type LevelBuilderStructureSegment
} from "@common/level-editor";

export const SETTLEMENT_EDITOR_SCHEMA_VERSION = 1;
export const SETTLEMENT_GAME_SCHEMA_VERSION = 1;

export const SETTLEMENT_EDITOR_STORAGE_KEY = "settlement_builder_editor_v1";
export const SETTLEMENT_GAME_STORAGE_KEY = "settlement_builder_game_v1";

export type GroundBase = LevelBuilderGroundBase;

export type GroundCellOverride = {
  base: GroundBase;
  variant?: number;
};

export type StructureSegmentData =
  | { kind: typeof STRUCTURE_KIND.WALL }
  | { kind: typeof STRUCTURE_KIND.WINDOW }
  | { kind: typeof STRUCTURE_KIND.DOOR; state: LevelBuilderDoorState };

export type SettlementPropCollider2D = {
  width: number;
  depth: number;
};

export type SettlementPropColliderMode = "defined" | "mesh";

export type SettlementPropPlacement = {
  placementId: string;
  sourcePropId: string;
  cellX: number;
  cellY: number;
  offsetX: number;
  offsetZ: number;
  rotQuarterTurns: 0 | 1 | 2 | 3;
  elevation: number;
  collider2d: SettlementPropCollider2D | null;
};

export type SettlementEditorSaveV1 = {
  schemaVersion: typeof SETTLEMENT_EDITOR_SCHEMA_VERSION;
  terrain: {
    defaultGround: GroundBase;
    seed: number;
    overrides: Array<{
      x: number;
      y: number;
      base: GroundBase;
      variant?: number;
    }>;
  };
  structures: LevelBuilderStructureSegment[];
  props: SettlementPropPlacement[];
  propColliderModes?: Array<{
    sourcePropId: string;
    mode: SettlementPropColliderMode;
  }>;
};

export type SettlementGameSaveDoorV1 = {
  placementId: string;
  open: boolean;
  locked?: boolean;
};

export type SettlementGameSaveV1 = {
  schemaVersion: typeof SETTLEMENT_GAME_SCHEMA_VERSION;
  editor: SettlementEditorSaveV1;
  player: {
    x: number;
    y: number;
  };
  doors: SettlementGameSaveDoorV1[];
};

export type ParsedEditorState = {
  defaultGround: GroundBase;
  seed: number;
  overrides: Map<string, GroundCellOverride>;
  structures: Map<string, StructureSegmentData>;
  props: Map<string, SettlementPropPlacement>;
  propColliderModes: Map<string, SettlementPropColliderMode>;
};

export function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

export function edgeKey(ax: number, ay: number, bx: number, by: number): string {
  if (ax < bx || (ax === bx && ay <= by)) {
    return `${ax},${ay}|${bx},${by}`;
  }
  return `${bx},${by}|${ax},${ay}`;
}

export function parseEdge(key: string): { ax: number; ay: number; bx: number; by: number } {
  const [a, b] = key.split("|");
  const [axStr, ayStr] = a.split(",");
  const [bxStr, byStr] = b.split(",");
  return {
    ax: Number(axStr),
    ay: Number(ayStr),
    bx: Number(bxStr),
    by: Number(byStr)
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readFiniteNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function asInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.floor(value);
}

function isInGrid(gridTiles: number, cellX: number, cellY: number): boolean {
  return cellX >= 0 && cellY >= 0 && cellX < gridTiles && cellY < gridTiles;
}

function normalizeGroundOverride(base: GroundBase, variant?: number): GroundCellOverride {
  if (base === "grass") {
    return {
      base,
      variant:
        variant === undefined ? undefined : Math.max(0, Math.floor(variant))
    };
  }
  return { base };
}

export function parseStructureState(
  raw: unknown,
  gridTiles: number
): Map<string, StructureSegmentData> | null {
  if (!Array.isArray(raw)) {
    return null;
  }

  const segments = new Map<string, StructureSegmentData>();

  for (const entryRaw of raw) {
    const entry = readRecord(entryRaw);
    if (!entry) {
      return null;
    }

    const kind = entry.kind;
    const ax = asInteger(entry.ax);
    const ay = asInteger(entry.az);
    const bx = asInteger(entry.bx);
    const by = asInteger(entry.bz);

    if (
      ax === null ||
      ay === null ||
      bx === null ||
      by === null ||
      !isInGrid(gridTiles, Math.min(ax, bx), Math.min(ay, by)) ||
      !isInGrid(gridTiles, Math.max(ax, bx) - 1, Math.max(ay, by) - 1)
    ) {
      return null;
    }

    const horizontal = ay === by && Math.abs(ax - bx) === 1;
    const vertical = ax === bx && Math.abs(ay - by) === 1;
    if (!horizontal && !vertical) {
      return null;
    }

    const key = edgeKey(ax, ay, bx, by);
    if (!isLevelBuilderStructureKind(kind)) {
      return null;
    }

    switch (kind) {
      case STRUCTURE_KIND.WALL:
      case STRUCTURE_KIND.WINDOW:
        segments.set(key, { kind });
        break;
      case STRUCTURE_KIND.DOOR: {
        const doorState = entry.doorState;
        if (!isLevelBuilderDoorState(doorState)) {
          return null;
        }
        segments.set(key, { kind: STRUCTURE_KIND.DOOR, state: doorState });
        break;
      }
      default:
        return null;
    }
  }

  return segments;
}

export function serializeStructureState(
  structureSegments: Map<string, StructureSegmentData>
): LevelBuilderStructureSegment[] {
  const result: LevelBuilderStructureSegment[] = [];

  for (const [key, value] of structureSegments.entries()) {
    const edge = parseEdge(key);
    if (value.kind === STRUCTURE_KIND.DOOR) {
      result.push({
        kind: STRUCTURE_KIND.DOOR,
        doorState: value.state,
        ax: edge.ax,
        az: edge.ay,
        bx: edge.bx,
        bz: edge.by
      });
      continue;
    }

    result.push({
      kind: value.kind,
      ax: edge.ax,
      az: edge.ay,
      bx: edge.bx,
      bz: edge.by
    });
  }

  return result;
}

export function serializeTerrainState(
  defaultGround: GroundBase,
  seed: number,
  overrides: Map<string, GroundCellOverride>
): SettlementEditorSaveV1["terrain"] {
  return {
    defaultGround,
    seed,
    overrides: [...overrides.entries()].map(([key, value]) => {
      const [xStr, yStr] = key.split(",");
      return {
        x: Number(xStr),
        y: Number(yStr),
        base: value.base,
        variant: value.variant
      };
    })
  };
}

export function parseTerrainState(raw: unknown): {
  defaultGround: GroundBase;
  seed: number;
  overrides: Map<string, GroundCellOverride>;
} | null {
  const record = readRecord(raw);
  if (!record) {
    return null;
  }

  const defaultGroundRaw = record.defaultGround;
  const seedRaw = record.seed;
  const overridesRaw = record.overrides;

  if (
    !isLevelBuilderGroundBase(defaultGroundRaw) ||
    typeof seedRaw !== "number" ||
    !Array.isArray(overridesRaw)
  ) {
    return null;
  }

  const overrides = new Map<string, GroundCellOverride>();
  for (const entryRaw of overridesRaw) {
    const entry = readRecord(entryRaw);
    if (!entry) {
      return null;
    }

    const x = readFiniteNumber(entry, "x");
    const y = readFiniteNumber(entry, "y");
    const base = entry.base;
    const variant = entry.variant;

    if (x === null || y === null || !isLevelBuilderGroundBase(base)) {
      return null;
    }

    if (
      variant !== undefined &&
      (typeof variant !== "number" || !Number.isFinite(variant))
    ) {
      return null;
    }

    overrides.set(
      cellKey(Math.floor(x), Math.floor(y)),
      normalizeGroundOverride(base, variant as number | undefined)
    );
  }

  return {
    defaultGround: defaultGroundRaw,
    seed: Math.floor(seedRaw),
    overrides
  };
}

export function serializePropPlacements(
  placements: Map<string, SettlementPropPlacement>
): SettlementPropPlacement[] {
  return [...placements.values()].map((placement) => ({
    placementId: placement.placementId,
    sourcePropId: placement.sourcePropId,
    cellX: placement.cellX,
    cellY: placement.cellY,
    offsetX: placement.offsetX,
    offsetZ: placement.offsetZ,
    rotQuarterTurns: placement.rotQuarterTurns,
    elevation: placement.elevation,
    collider2d: placement.collider2d
      ? {
          width: placement.collider2d.width,
          depth: placement.collider2d.depth
        }
      : null
  }));
}

export function serializePropColliderModes(
  modes: Map<string, SettlementPropColliderMode>
): SettlementEditorSaveV1["propColliderModes"] {
  return [...modes.entries()]
    .filter(
      ([sourcePropId, mode]) =>
        typeof sourcePropId === "string" &&
        sourcePropId.length > 0 &&
        (mode === "defined" || mode === "mesh")
    )
    .map(([sourcePropId, mode]) => ({ sourcePropId, mode }));
}

export function parsePropColliderModes(
  raw: unknown
): Map<string, SettlementPropColliderMode> | null {
  if (raw === undefined || raw === null) {
    return new Map();
  }
  if (!Array.isArray(raw)) {
    return null;
  }

  const modes = new Map<string, SettlementPropColliderMode>();
  for (const entryRaw of raw) {
    const entry = readRecord(entryRaw);
    if (!entry) {
      return null;
    }
    const sourcePropId = entry.sourcePropId;
    const mode = entry.mode;
    if (
      typeof sourcePropId !== "string" ||
      sourcePropId.length === 0 ||
      (mode !== "defined" && mode !== "mesh")
    ) {
      return null;
    }
    modes.set(sourcePropId, mode);
  }

  return modes;
}

export function parsePropPlacements(
  raw: unknown,
  gridTiles: number
): Map<string, SettlementPropPlacement> | null {
  if (!Array.isArray(raw)) {
    return null;
  }

  const placements = new Map<string, SettlementPropPlacement>();

  for (const entryRaw of raw) {
    const entry = readRecord(entryRaw);
    if (!entry) {
      return null;
    }

    const placementId = entry.placementId;
    const sourcePropId = entry.sourcePropId;
    const cellX = asInteger(entry.cellX);
    const cellY = asInteger(entry.cellY);
    const offsetXRaw = entry.offsetX;
    const offsetZRaw = entry.offsetZ;
    const offsetX =
      typeof offsetXRaw === "number" && Number.isFinite(offsetXRaw) ? offsetXRaw : 0;
    const offsetZ =
      typeof offsetZRaw === "number" && Number.isFinite(offsetZRaw) ? offsetZRaw : 0;
    const rotQuarterTurnsRaw = asInteger(entry.rotQuarterTurns);
    const elevationRaw = entry.elevation;
    const elevation =
      typeof elevationRaw === "number" && Number.isFinite(elevationRaw)
        ? Math.max(0, elevationRaw)
        : 0;

    if (
      typeof placementId !== "string" ||
      typeof sourcePropId !== "string" ||
      cellX === null ||
      cellY === null ||
      rotQuarterTurnsRaw === null ||
      !isInGrid(gridTiles, cellX, cellY)
    ) {
      return null;
    }

    const rotQuarterTurns = (((rotQuarterTurnsRaw % 4) + 4) % 4) as
      | 0
      | 1
      | 2
      | 3;

    const colliderRaw = entry.collider2d;
    let collider2d: SettlementPropCollider2D | null = null;
    if (colliderRaw !== undefined && colliderRaw !== null) {
      const colliderRecord = readRecord(colliderRaw);
      if (!colliderRecord) {
        return null;
      }
      const width = readFiniteNumber(colliderRecord, "width");
      const depth = readFiniteNumber(colliderRecord, "depth");
      if (width === null || depth === null || width <= 0 || depth <= 0) {
        return null;
      }
      collider2d = { width, depth };
    }

    placements.set(placementId, {
      placementId,
      sourcePropId,
      cellX,
      cellY,
      offsetX,
      offsetZ,
      rotQuarterTurns,
      elevation,
      collider2d
    });
  }

  return placements;
}

export function buildEditorSaveV1(options: {
  defaultGround: GroundBase;
  seed: number;
  overrides: Map<string, GroundCellOverride>;
  structures: Map<string, StructureSegmentData>;
  props: Map<string, SettlementPropPlacement>;
  propColliderModes: Map<string, SettlementPropColliderMode>;
}): SettlementEditorSaveV1 {
  return {
    schemaVersion: SETTLEMENT_EDITOR_SCHEMA_VERSION,
    terrain: serializeTerrainState(
      options.defaultGround,
      options.seed,
      options.overrides
    ),
    structures: serializeStructureState(options.structures),
    props: serializePropPlacements(options.props),
    propColliderModes: serializePropColliderModes(options.propColliderModes)
  };
}

export function parseEditorSaveV1(
  raw: unknown,
  gridTiles: number
): ParsedEditorState | null {
  const record = readRecord(raw);
  if (!record) {
    return null;
  }

  const schemaVersion = asInteger(record.schemaVersion);
  if (schemaVersion !== SETTLEMENT_EDITOR_SCHEMA_VERSION) {
    return null;
  }

  const terrain = parseTerrainState(record.terrain);
  const structures = parseStructureState(record.structures, gridTiles);
  const props = parsePropPlacements(record.props ?? [], gridTiles);
  const propColliderModes = parsePropColliderModes(record.propColliderModes);

  if (!terrain || !structures || !props || !propColliderModes) {
    return null;
  }

  return {
    defaultGround: terrain.defaultGround,
    seed: terrain.seed,
    overrides: terrain.overrides,
    structures,
    props,
    propColliderModes
  };
}

export function parseGameSaveV1(
  raw: unknown,
  gridTiles: number
): SettlementGameSaveV1 | null {
  const record = readRecord(raw);
  if (!record) {
    return null;
  }

  const schemaVersion = asInteger(record.schemaVersion);
  if (schemaVersion !== SETTLEMENT_GAME_SCHEMA_VERSION) {
    return null;
  }

  const editor = parseEditorSaveV1(record.editor, gridTiles);
  if (!editor) {
    return null;
  }

  const playerRecord = readRecord(record.player);
  if (!playerRecord) {
    return null;
  }

  const playerX = readFiniteNumber(playerRecord, "x");
  const playerY = readFiniteNumber(playerRecord, "y");
  if (playerX === null || playerY === null) {
    return null;
  }

  const doorsRaw = record.doors;
  if (!Array.isArray(doorsRaw)) {
    return null;
  }

  const doors: SettlementGameSaveDoorV1[] = [];
  for (const entryRaw of doorsRaw) {
    const entry = readRecord(entryRaw);
    if (!entry) {
      return null;
    }

    const placementId = entry.placementId;
    const open = entry.open;
    const locked = entry.locked;

    if (typeof placementId !== "string" || typeof open !== "boolean") {
      return null;
    }
    if (locked !== undefined && typeof locked !== "boolean") {
      return null;
    }

    doors.push({
      placementId,
      open,
      locked
    });
  }

  return {
    schemaVersion: SETTLEMENT_GAME_SCHEMA_VERSION,
    editor: buildEditorSaveV1(editor),
    player: {
      x: playerX,
      y: playerY
    },
    doors
  };
}
