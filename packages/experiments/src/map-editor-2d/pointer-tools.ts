import * as THREE from "three";
import type { LevelBuilderGroundBase } from "@common/level-editor";
import type { GridConfig, MapEditorState } from "./editor-state";
import {
  setTerrainCell,
  removeTerrainCell,
  setEdgeStructure,
  removeEdgeStructure,
  setCellStructure,
  removeCellStructure,
  setVertexStructure,
  removeVertexStructure
} from "./editor-state";
import type { HoverTarget } from "./grid-renderer";
import type { TilesetAssets } from "./tileset-loader";

/** Ground brush names (terrain cell painting) */
export const GROUND_BRUSHES = new Set<string>(["floor", "grass", "road", "sidewalk"]);

export type ToolMode = "draw" | "erase";

export type PointerToolState = {
  toolMode: ToolMode;
  /** Either a ground brush name or a tile name from the kit */
  brush: string;
  /** Rotation for vertex-placed tiles (quarter turns: 0-3) */
  vertexRotation: number;
};

type Edge = { ax: number; az: number; bx: number; bz: number };

export type PlacementMode = "ground" | "cell" | "edge" | "vertex";

/** Determine placement mode for a brush */
export function brushPlacement(brush: string, assets: TilesetAssets): PlacementMode {
  if (GROUND_BRUSHES.has(brush)) return "ground";
  const tile = assets.tiles.get(brush);
  if (!tile) return "edge";
  const ft = tile.entry.logicalFootprint.type;
  if (ft === "cell") return "cell";
  if (ft === "corner_vertex") return "vertex";
  return "edge";
}

const worldPoint = new THREE.Vector3();

export function worldToCell(
  worldX: number,
  worldZ: number,
  grid: GridConfig
): { x: number; z: number } | null {
  const x = Math.floor((worldX - grid.origin) / grid.tileSize);
  const z = Math.floor((worldZ - grid.origin) / grid.tileSize);
  if (x < 0 || z < 0 || x >= grid.tiles || z >= grid.tiles) return null;
  return { x, z };
}

export function pickNearestEdge(
  worldX: number,
  worldZ: number,
  grid: GridConfig
): Edge | null {
  const localX = (worldX - grid.origin) / grid.tileSize;
  const localZ = (worldZ - grid.origin) / grid.tileSize;

  const nearestVx = Math.round(localX);
  const nearestHz = Math.round(localZ);

  const distToVertical = Math.abs(localX - nearestVx);
  const distToHorizontal = Math.abs(localZ - nearestHz);

  if (distToVertical <= distToHorizontal) {
    const cellZ = Math.floor(localZ);
    if (nearestVx < 0 || nearestVx > grid.tiles) return null;
    if (cellZ < 0 || cellZ >= grid.tiles) return null;
    return { ax: nearestVx, az: cellZ, bx: nearestVx, bz: cellZ + 1 };
  } else {
    const cellX = Math.floor(localX);
    if (nearestHz < 0 || nearestHz > grid.tiles) return null;
    if (cellX < 0 || cellX >= grid.tiles) return null;
    return { ax: cellX, az: nearestHz, bx: cellX + 1, bz: nearestHz };
  }
}

/** Snap to nearest grid vertex (intersection point) */
export function pickNearestVertex(
  worldX: number,
  worldZ: number,
  grid: GridConfig
): { x: number; z: number } | null {
  const x = Math.round((worldX - grid.origin) / grid.tileSize);
  const z = Math.round((worldZ - grid.origin) / grid.tileSize);
  if (x < 0 || z < 0 || x > grid.tiles || z > grid.tiles) return null;
  return { x, z };
}

function applyBrush(
  state: MapEditorState,
  toolState: PointerToolState,
  assets: TilesetAssets,
  worldX: number,
  worldZ: number
): void {
  const { toolMode, brush } = toolState;
  const placement = brushPlacement(brush, assets);

  if (placement === "ground") {
    const cell = worldToCell(worldX, worldZ, state.grid);
    if (!cell) return;
    if (toolMode === "erase") {
      removeTerrainCell(state, cell.x, cell.z);
    } else {
      setTerrainCell(state, cell.x, cell.z, brush as LevelBuilderGroundBase);
    }
  } else if (placement === "cell") {
    const cell = worldToCell(worldX, worldZ, state.grid);
    if (!cell) return;
    if (toolMode === "erase") {
      removeCellStructure(state, cell.x, cell.z);
    } else {
      setCellStructure(state, cell.x, cell.z, brush);
    }
  } else if (placement === "vertex") {
    const vtx = pickNearestVertex(worldX, worldZ, state.grid);
    if (!vtx) return;
    if (toolMode === "erase") {
      removeVertexStructure(state, vtx.x, vtx.z);
    } else {
      setVertexStructure(state, vtx.x, vtx.z, brush, toolState.vertexRotation);
    }
  } else {
    const edge = pickNearestEdge(worldX, worldZ, state.grid);
    if (!edge) return;
    if (toolMode === "erase") {
      removeEdgeStructure(state, edge.ax, edge.az, edge.bx, edge.bz);
    } else {
      setEdgeStructure(state, edge.ax, edge.az, edge.bx, edge.bz, brush);
    }
  }
}

function getHoverTarget(
  toolState: PointerToolState,
  assets: TilesetAssets,
  worldX: number,
  worldZ: number,
  grid: GridConfig
): HoverTarget {
  const placement = brushPlacement(toolState.brush, assets);
  if (placement === "ground" || placement === "cell") {
    const cell = worldToCell(worldX, worldZ, grid);
    if (!cell) return null;
    return { kind: "cell", x: cell.x, z: cell.z };
  } else if (placement === "vertex") {
    const vtx = pickNearestVertex(worldX, worldZ, grid);
    if (!vtx) return null;
    return { kind: "vertex", x: vtx.x, z: vtx.z };
  } else {
    const edge = pickNearestEdge(worldX, worldZ, grid);
    if (!edge) return null;
    return { kind: "edge", ax: edge.ax, az: edge.az, bx: edge.bx, bz: edge.bz };
  }
}

export type WorldAtLocal = (localX: number, localY: number, out: THREE.Vector3) => boolean;

export type PointerToolsBinding = {
  unbind(): void;
  toolState: PointerToolState;
};

export function bindPointerTools(
  element: HTMLElement,
  worldAtLocal: WorldAtLocal,
  state: MapEditorState,
  assets: TilesetAssets,
  onHover: (target: HoverTarget) => void
): PointerToolsBinding {
  const toolState: PointerToolState = {
    toolMode: "draw",
    brush: "wall",
    vertexRotation: 0
  };
  let dragging = false;

  const toLocal = (event: PointerEvent): { lx: number; ly: number } => {
    const rect = element.getBoundingClientRect();
    return { lx: event.clientX - rect.left, ly: event.clientY - rect.top };
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const { lx, ly } = toLocal(event);
    if (!worldAtLocal(lx, ly, worldPoint)) return;
    applyBrush(state, toolState, assets, worldPoint.x, worldPoint.z);
    dragging = true;
    event.preventDefault();
  };

  const onPointerMove = (event: PointerEvent): void => {
    const { lx, ly } = toLocal(event);
    if (!worldAtLocal(lx, ly, worldPoint)) {
      onHover(null);
      return;
    }

    onHover(getHoverTarget(toolState, assets, worldPoint.x, worldPoint.z, state.grid));

    if (dragging && (event.buttons & 1)) {
      applyBrush(state, toolState, assets, worldPoint.x, worldPoint.z);
    }
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    dragging = false;
  };

  const onPointerLeave = (): void => {
    dragging = false;
    onHover(null);
  };

  element.addEventListener("pointerdown", onPointerDown);
  element.addEventListener("pointermove", onPointerMove);
  element.addEventListener("pointerup", onPointerUp);
  element.addEventListener("pointerleave", onPointerLeave);

  return {
    unbind() {
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerup", onPointerUp);
      element.removeEventListener("pointerleave", onPointerLeave);
    },
    toolState
  };
}
