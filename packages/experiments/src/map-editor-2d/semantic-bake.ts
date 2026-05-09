import {
  bakeGreyboxLevelForEcs,
  type GreyboxLevelPlacement,
  type LevelBuilderBake
} from "@common/level-editor";
import type { LevelSnapshot } from "@common/gameplay";
import type { MapEditorState } from "./editor-state";

export function createGreyboxPlacementsFromEditorState(state: MapEditorState): GreyboxLevelPlacement[] {
  const placements: GreyboxLevelPlacement[] = [];

  for (const cell of state.cellStructures.values()) {
    placements.push({
      placement: "cell",
      definitionId: cell.tileName,
      x: cell.x,
      z: cell.z
    });
  }

  for (const edge of state.edgeStructures.values()) {
    placements.push({
      placement: "edge",
      definitionId: edge.tileName,
      ax: edge.ax,
      az: edge.az,
      bx: edge.bx,
      bz: edge.bz,
      flipped: edge.flipped,
      doorState: edge.doorState
    });
  }

  for (const vertex of state.vertexStructures.values()) {
    placements.push({
      placement: "vertex",
      definitionId: vertex.tileName,
      x: vertex.x,
      z: vertex.z,
      rotation: vertex.rotation
    });
  }

  return placements;
}

export function bakeMapEditorStateForEcs(
  state: MapEditorState,
  level: LevelSnapshot = { id: "map-editor-greybox", version: state.revision }
): LevelBuilderBake {
  return bakeGreyboxLevelForEcs({
    level,
    grid: {
      tiles: state.grid.tiles,
      tileSize: state.grid.tileSize,
      origin: state.grid.origin
    },
    placements: createGreyboxPlacementsFromEditorState(state)
  });
}
