import * as THREE from "three";
import type { PromotedEditorToolMode, PromotedEditorBrush } from "@common/level-editor";
import {
  LEVEL_BUILDER_STRUCTURE_KIND,
  LEVEL_BUILDER_DOOR_STATE
} from "@common/level-editor";
import type { GridConfig, MapEditorState } from "./editor-state";
import {
  setTerrainCell,
  removeTerrainCell,
  setStructureEdge,
  removeStructureEdge
} from "./editor-state";
import type { HoverTarget } from "./grid-renderer";

export type PointerToolState = {
  toolMode: PromotedEditorToolMode;
  brush: PromotedEditorBrush;
};

type Edge = { ax: number; az: number; bx: number; bz: number };

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

  // Nearest vertical grid line (x = integer) and horizontal grid line (z = integer)
  const nearestVx = Math.round(localX);
  const nearestHz = Math.round(localZ);

  const distToVertical = Math.abs(localX - nearestVx);
  const distToHorizontal = Math.abs(localZ - nearestHz);

  if (distToVertical <= distToHorizontal) {
    // Snap to vertical line: edge runs north-south at x=nearestVx
    const cellZ = Math.floor(localZ);
    if (nearestVx < 0 || nearestVx > grid.tiles) return null;
    if (cellZ < 0 || cellZ >= grid.tiles) return null;
    return { ax: nearestVx, az: cellZ, bx: nearestVx, bz: cellZ + 1 };
  } else {
    // Snap to horizontal line: edge runs east-west at z=nearestHz
    const cellX = Math.floor(localX);
    if (nearestHz < 0 || nearestHz > grid.tiles) return null;
    if (cellX < 0 || cellX >= grid.tiles) return null;
    return { ax: cellX, az: nearestHz, bx: cellX + 1, bz: nearestHz };
  }
}

function isGroundBrush(brush: PromotedEditorBrush): boolean {
  return brush === "floor" || brush === "grass" || brush === "road" || brush === "sidewalk";
}

function applyBrush(
  state: MapEditorState,
  toolState: PointerToolState,
  worldX: number,
  worldZ: number
): void {
  const { toolMode, brush } = toolState;

  if (isGroundBrush(brush)) {
    const cell = worldToCell(worldX, worldZ, state.grid);
    if (!cell) return;
    if (toolMode === "erase") {
      removeTerrainCell(state, cell.x, cell.z);
    } else {
      setTerrainCell(state, cell.x, cell.z, brush as "floor" | "grass" | "road" | "sidewalk");
    }
  } else {
    const edge = pickNearestEdge(worldX, worldZ, state.grid);
    if (!edge) return;
    if (toolMode === "erase") {
      removeStructureEdge(state, edge.ax, edge.az, edge.bx, edge.bz);
    } else {
      if (brush === "wall") {
        setStructureEdge(state, edge.ax, edge.az, edge.bx, edge.bz, LEVEL_BUILDER_STRUCTURE_KIND.WALL);
      } else if (brush === "window") {
        setStructureEdge(state, edge.ax, edge.az, edge.bx, edge.bz, LEVEL_BUILDER_STRUCTURE_KIND.WINDOW);
      } else if (brush === "door-closed") {
        setStructureEdge(state, edge.ax, edge.az, edge.bx, edge.bz, LEVEL_BUILDER_STRUCTURE_KIND.DOOR, LEVEL_BUILDER_DOOR_STATE.CLOSED);
      } else if (brush === "door-open") {
        setStructureEdge(state, edge.ax, edge.az, edge.bx, edge.bz, LEVEL_BUILDER_STRUCTURE_KIND.DOOR, LEVEL_BUILDER_DOOR_STATE.OPEN);
      }
    }
  }
}

function getHoverTarget(
  toolState: PointerToolState,
  worldX: number,
  worldZ: number,
  grid: GridConfig
): HoverTarget {
  if (isGroundBrush(toolState.brush)) {
    const cell = worldToCell(worldX, worldZ, grid);
    if (!cell) return null;
    return { kind: "cell", x: cell.x, z: cell.z };
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
  onHover: (target: HoverTarget) => void
): PointerToolsBinding {
  const toolState: PointerToolState = {
    toolMode: "draw",
    brush: "wall"
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
    applyBrush(state, toolState, worldPoint.x, worldPoint.z);
    dragging = true;
    event.preventDefault();
  };

  const onPointerMove = (event: PointerEvent): void => {
    const { lx, ly } = toLocal(event);
    if (!worldAtLocal(lx, ly, worldPoint)) {
      onHover(null);
      return;
    }

    onHover(getHoverTarget(toolState, worldPoint.x, worldPoint.z, state.grid));

    if (dragging && (event.buttons & 1)) {
      applyBrush(state, toolState, worldPoint.x, worldPoint.z);
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
