import type { LevelSnapshot } from "@common/gameplay";
import {
  LEVEL_BUILDER_DOOR_STATE,
  LEVEL_BUILDER_STRUCTURE_KIND,
  bakeLevelForEcs,
  type LevelBuilderBake,
  type LevelBuilderGroundBase,
  type LevelBuilderGroundOverride,
  type LevelBuilderStructureSegment
} from "./builder-bake";
import {
  findGreyboxDefinition,
  resolveGreyboxDefinitionState,
  type GreyboxDefinition,
  type GreyboxDoorState,
  type GreyboxTerrain
} from "./greybox";

export type GreyboxCellPlacement = {
  definitionId: string;
  placement: "cell";
  x: number;
  z: number;
};

export type GreyboxEdgePlacement = {
  definitionId: string;
  placement: "edge";
  ax: number;
  az: number;
  bx: number;
  bz: number;
  flipped?: boolean;
  doorState?: GreyboxDoorState;
};

export type GreyboxVertexPlacement = {
  definitionId: string;
  placement: "vertex";
  x: number;
  z: number;
  rotation?: number;
};

export type GreyboxLevelPlacement =
  | GreyboxCellPlacement
  | GreyboxEdgePlacement
  | GreyboxVertexPlacement;

export type GreyboxLevelBakeInput = {
  level: LevelSnapshot;
  grid: {
    tiles: number;
    tileSize: number;
    origin: number;
  };
  defaultGround?: LevelBuilderGroundBase;
  placements: GreyboxLevelPlacement[];
};

const TERRAIN_TO_GROUND_BASE: Record<GreyboxTerrain, LevelBuilderGroundBase> = {
  floor: "floor",
  grass: "grass",
  road: "road",
  sidewalk: "sidewalk",
  building: "building"
};

function terrainToGroundBase(terrain: GreyboxTerrain | undefined): LevelBuilderGroundBase | null {
  return terrain ? TERRAIN_TO_GROUND_BASE[terrain] ?? null : null;
}

function requireDefinition(placement: GreyboxLevelPlacement): GreyboxDefinition | null {
  const definition = findGreyboxDefinition(placement.definitionId);
  if (!definition || definition.placement !== placement.placement) {
    return null;
  }
  return definition;
}

function doorStateForPlacement(
  definition: GreyboxDefinition,
  placement: GreyboxEdgePlacement
): "open" | "closed" {
  return (
    placement.doorState ??
    resolveGreyboxDefinitionState(definition).semantic.doorState ??
    LEVEL_BUILDER_DOOR_STATE.CLOSED
  );
}

function edgePlacementToStructure(
  definition: GreyboxDefinition,
  placement: GreyboxEdgePlacement
): LevelBuilderStructureSegment | null {
  if (definition.semantic.kind === "wall") {
    return {
      kind: LEVEL_BUILDER_STRUCTURE_KIND.WALL,
      ax: placement.ax,
      az: placement.az,
      bx: placement.bx,
      bz: placement.bz
    };
  }

  if (definition.semantic.kind === "window") {
    return {
      kind: LEVEL_BUILDER_STRUCTURE_KIND.WINDOW,
      ax: placement.ax,
      az: placement.az,
      bx: placement.bx,
      bz: placement.bz
    };
  }

  if (definition.semantic.kind === "door") {
    return {
      kind: LEVEL_BUILDER_STRUCTURE_KIND.DOOR,
      doorState: doorStateForPlacement(definition, placement),
      ax: placement.ax,
      az: placement.az,
      bx: placement.bx,
      bz: placement.bz
    };
  }

  return null;
}

function rotateCornerArm(x: number, z: number, rotation: number): [number, number] {
  switch (rotation & 3) {
    case 1:
      return [-z, x];
    case 2:
      return [-x, -z];
    case 3:
      return [z, -x];
    default:
      return [x, z];
  }
}

function vertexPlacementToStructures(
  definition: GreyboxDefinition,
  placement: GreyboxVertexPlacement
): LevelBuilderStructureSegment[] {
  if (definition.semantic.kind !== "corner" || !definition.semantic.blocksMovement) {
    return [];
  }

  const rotation = placement.rotation ?? 0;
  const [armAx, armAz] = rotateCornerArm(1, 0, rotation);
  const [armBx, armBz] = rotateCornerArm(0, 1, rotation);

  return [
    {
      kind: LEVEL_BUILDER_STRUCTURE_KIND.WALL,
      ax: placement.x,
      az: placement.z,
      bx: placement.x + armAx,
      bz: placement.z + armAz
    },
    {
      kind: LEVEL_BUILDER_STRUCTURE_KIND.WALL,
      ax: placement.x,
      az: placement.z,
      bx: placement.x + armBx,
      bz: placement.z + armBz
    }
  ];
}

export function bakeGreyboxLevelForEcs(input: GreyboxLevelBakeInput): LevelBuilderBake {
  const overrides: LevelBuilderGroundOverride[] = [];
  const structures: LevelBuilderStructureSegment[] = [];

  for (const placement of input.placements) {
    const definition = requireDefinition(placement);
    if (!definition) {
      continue;
    }

    if (placement.placement === "cell") {
      const base = terrainToGroundBase(definition.semantic.terrain);
      if (base) {
        overrides.push({ x: placement.x, z: placement.z, base });
      }
      continue;
    }

    if (placement.placement === "edge") {
      const segment = edgePlacementToStructure(definition, placement);
      if (segment) {
        structures.push(segment);
      }
      continue;
    }

    structures.push(...vertexPlacementToStructures(definition, placement));
  }

  return bakeLevelForEcs({
    level: input.level,
    grid: input.grid,
    terrain: {
      defaultGround: input.defaultGround ?? "floor",
      overrides
    },
    structures
  });
}
