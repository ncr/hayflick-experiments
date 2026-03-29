import {
  levelBuilderEdgeKey,
  levelBuilderDoorPlacementIdFromNodes,
  type LevelBuilderBakeInput,
  type LevelBuilderGroundBase,
  type LevelBuilderGroundOverride,
  type LevelBuilderStructureSegment,
  type LevelBuilderDoorState,
  LEVEL_BUILDER_GROUND_BASE,
  LEVEL_BUILDER_STRUCTURE_KIND,
  LEVEL_BUILDER_DOOR_STATE,
  LEVEL_EDITOR_WORLD_UNIT
} from "@common/level-editor";

export type GridConfig = {
  tiles: number;
  tileSize: number;
  origin: number;
};

export type MapEditorState = {
  grid: GridConfig;
  defaultGround: LevelBuilderGroundBase;
  terrainOverrides: Map<string, LevelBuilderGroundOverride>;
  structures: Map<string, LevelBuilderStructureSegment>;
  revision: number;
};

function cellKey(x: number, z: number): string {
  return `${x},${z}`;
}

export function createDefaultState(): MapEditorState {
  const tiles = 20;
  return {
    grid: {
      tiles,
      tileSize: LEVEL_EDITOR_WORLD_UNIT,
      origin: -(tiles * LEVEL_EDITOR_WORLD_UNIT) / 2
    },
    defaultGround: LEVEL_BUILDER_GROUND_BASE.GRASS,
    terrainOverrides: new Map(),
    structures: new Map(),
    revision: 0
  };
}

export function setTerrainCell(
  state: MapEditorState,
  x: number,
  z: number,
  base: LevelBuilderGroundBase
): void {
  const key = cellKey(x, z);
  const existing = state.terrainOverrides.get(key);
  if (existing && existing.base === base) return;
  state.terrainOverrides.set(key, { x, z, base });
  state.revision++;
}

export function removeTerrainCell(state: MapEditorState, x: number, z: number): void {
  const key = cellKey(x, z);
  if (!state.terrainOverrides.has(key)) return;
  state.terrainOverrides.delete(key);
  state.revision++;
}

export function setStructureEdge(
  state: MapEditorState,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  kind: "wall" | "window",
): void;
export function setStructureEdge(
  state: MapEditorState,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  kind: "door",
  doorState: LevelBuilderDoorState,
): void;
export function setStructureEdge(
  state: MapEditorState,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  kind: "wall" | "window" | "door",
  doorState?: LevelBuilderDoorState
): void {
  const key = levelBuilderEdgeKey(ax, az, bx, bz);
  let segment: LevelBuilderStructureSegment;
  if (kind === LEVEL_BUILDER_STRUCTURE_KIND.DOOR) {
    segment = {
      kind,
      doorState: doorState ?? LEVEL_BUILDER_DOOR_STATE.CLOSED,
      ax, az, bx, bz
    };
  } else {
    segment = { kind, ax, az, bx, bz };
  }
  state.structures.set(key, segment);
  state.revision++;
}

export function removeStructureEdge(
  state: MapEditorState,
  ax: number,
  az: number,
  bx: number,
  bz: number
): void {
  const key = levelBuilderEdgeKey(ax, az, bx, bz);
  if (!state.structures.has(key)) return;
  state.structures.delete(key);
  state.revision++;
}

export function clearStructures(state: MapEditorState): void {
  if (state.structures.size === 0) return;
  state.structures.clear();
  state.revision++;
}

export function clearGround(state: MapEditorState): void {
  if (state.terrainOverrides.size === 0) return;
  state.terrainOverrides.clear();
  state.revision++;
}

export function setDefaultGround(state: MapEditorState, base: LevelBuilderGroundBase): void {
  if (state.defaultGround === base) return;
  state.defaultGround = base;
  state.revision++;
}

export function toBakeInput(state: MapEditorState): LevelBuilderBakeInput {
  return {
    level: { id: "map-editor-2d", version: state.revision },
    grid: { ...state.grid },
    terrain: {
      defaultGround: state.defaultGround,
      overrides: [...state.terrainOverrides.values()]
    },
    structures: [...state.structures.values()]
  };
}

export function fromBakeInput(input: LevelBuilderBakeInput): MapEditorState {
  const terrainOverrides = new Map<string, LevelBuilderGroundOverride>();
  for (const override of input.terrain.overrides) {
    terrainOverrides.set(cellKey(override.x, override.z), override);
  }

  const structures = new Map<string, LevelBuilderStructureSegment>();
  for (const segment of input.structures) {
    const key = levelBuilderEdgeKey(segment.ax, segment.az, segment.bx, segment.bz);
    structures.set(key, segment);
  }

  return {
    grid: { ...input.grid },
    defaultGround: input.terrain.defaultGround,
    terrainOverrides,
    structures,
    revision: 0
  };
}
