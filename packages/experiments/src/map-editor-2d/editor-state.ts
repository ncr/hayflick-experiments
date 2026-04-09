import {
  levelBuilderEdgeKey,
  LEVEL_EDITOR_WORLD_UNIT,
} from "@common/level-editor";

export type GridConfig = {
  tiles: number;
  tileSize: number;
  origin: number;
};

/** A placed edge structure (wall, door, window segment) */
export type PlacedEdge = {
  tileName: string;
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** When true the tile is rotated 180° around Y (front faces the other side) */
  flipped: boolean;
};

/** A placed cell structure (floor tile, etc.) */
export type PlacedCell = {
  tileName: string;
  x: number;
  z: number;
};

/** A placed vertex structure (corner, etc.) with rotation */
export type PlacedVertex = {
  tileName: string;
  x: number;
  z: number;
  /** Rotation in quarter turns (0=default +X/+Z, 1=90°, 2=180°, 3=270°) */
  rotation: number;
};

export type MapEditorState = {
  grid: GridConfig;
  /** Edge-based structures (walls, doors, windows) keyed by edge key */
  edgeStructures: Map<string, PlacedEdge>;
  /** Cell-based structures (floor tiles, etc.) keyed by "x,z" */
  cellStructures: Map<string, PlacedCell>;
  /** Vertex-based structures (corners, etc.) keyed by "x,z" */
  vertexStructures: Map<string, PlacedVertex>;
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
    edgeStructures: new Map(),
    cellStructures: new Map(),
    vertexStructures: new Map(),
    revision: 0
  };
}

export function setCellStructure(
  state: MapEditorState,
  x: number,
  z: number,
  tileName: string
): void {
  const key = cellKey(x, z);
  state.cellStructures.set(key, { tileName, x, z });
  state.revision++;
}

export function removeCellStructure(state: MapEditorState, x: number, z: number): void {
  const key = cellKey(x, z);
  if (!state.cellStructures.has(key)) return;
  state.cellStructures.delete(key);
  state.revision++;
}

export function setVertexStructure(
  state: MapEditorState,
  x: number,
  z: number,
  tileName: string,
  rotation: number
): void {
  const key = cellKey(x, z);
  state.vertexStructures.set(key, { tileName, x, z, rotation: rotation & 3 });
  state.revision++;
}

export function removeVertexStructure(state: MapEditorState, x: number, z: number): void {
  const key = cellKey(x, z);
  if (!state.vertexStructures.has(key)) return;
  state.vertexStructures.delete(key);
  state.revision++;
}

export function setEdgeStructure(
  state: MapEditorState,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  tileName: string,
  flipped: boolean
): void {
  const key = levelBuilderEdgeKey(ax, az, bx, bz);
  state.edgeStructures.set(key, { tileName, ax, az, bx, bz, flipped });
  state.revision++;
}

export function removeEdgeStructure(
  state: MapEditorState,
  ax: number,
  az: number,
  bx: number,
  bz: number
): void {
  const key = levelBuilderEdgeKey(ax, az, bx, bz);
  if (!state.edgeStructures.has(key)) return;
  state.edgeStructures.delete(key);
  state.revision++;
}

export function clearAll(state: MapEditorState): void {
  const empty = state.edgeStructures.size === 0 && state.cellStructures.size === 0
    && state.vertexStructures.size === 0;
  if (empty) return;
  state.edgeStructures.clear();
  state.cellStructures.clear();
  state.vertexStructures.clear();
  state.revision++;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export type SerializedState = {
  grid: GridConfig;
  edgeStructures: Array<{ tileName: string; ax: number; az: number; bx: number; bz: number; flipped?: boolean }>;
  cellStructures: Array<{ tileName: string; x: number; z: number }>;
  vertexStructures: Array<{ tileName: string; x: number; z: number; rotation: number }>;
};

export function serializeState(state: MapEditorState): SerializedState {
  return {
    grid: { ...state.grid },
    edgeStructures: [...state.edgeStructures.values()].map((s) => ({
      tileName: s.tileName, ax: s.ax, az: s.az, bx: s.bx, bz: s.bz, flipped: s.flipped
    })),
    cellStructures: [...state.cellStructures.values()].map((s) => ({
      tileName: s.tileName, x: s.x, z: s.z
    })),
    vertexStructures: [...state.vertexStructures.values()].map((s) => ({
      tileName: s.tileName, x: s.x, z: s.z, rotation: s.rotation
    }))
  };
}

// ---------------------------------------------------------------------------
// Undo / Redo
// ---------------------------------------------------------------------------

export type UndoManager = {
  checkpoint(state: MapEditorState): void;
  undo(state: MapEditorState): boolean;
  redo(state: MapEditorState): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
};

export function createUndoManager(maxDepth = 50): UndoManager {
  const undoStack: SerializedState[] = [];
  const redoStack: SerializedState[] = [];

  function restoreInPlace(state: MapEditorState, snapshot: SerializedState): void {
    const restored = deserializeState(snapshot);
    state.grid = restored.grid;
    state.edgeStructures = restored.edgeStructures;
    state.cellStructures = restored.cellStructures;
    state.vertexStructures = restored.vertexStructures;
    state.revision++;
  }

  return {
    checkpoint(state) {
      undoStack.push(serializeState(state));
      if (undoStack.length > maxDepth) undoStack.shift();
      redoStack.length = 0;
    },
    undo(state) {
      const snapshot = undoStack.pop();
      if (!snapshot) return false;
      redoStack.push(serializeState(state));
      restoreInPlace(state, snapshot);
      return true;
    },
    redo(state) {
      const snapshot = redoStack.pop();
      if (!snapshot) return false;
      undoStack.push(serializeState(state));
      restoreInPlace(state, snapshot);
      return true;
    },
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
  };
}

export function deserializeState(raw: SerializedState): MapEditorState {
  const edgeStructures = new Map<string, PlacedEdge>();
  for (const s of raw.edgeStructures) {
    const key = levelBuilderEdgeKey(s.ax, s.az, s.bx, s.bz);
    edgeStructures.set(key, { ...s, flipped: s.flipped ?? false });
  }

  const cellStructures = new Map<string, PlacedCell>();
  for (const s of raw.cellStructures) {
    cellStructures.set(cellKey(s.x, s.z), s);
  }

  const vertexStructures = new Map<string, PlacedVertex>();
  for (const s of (raw.vertexStructures ?? [])) {
    vertexStructures.set(cellKey(s.x, s.z), s);
  }

  return {
    grid: { ...raw.grid },
    edgeStructures,
    cellStructures,
    vertexStructures,
    revision: 0
  };
}
