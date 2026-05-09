import * as THREE from "three";
import rawGreyboxCatalog from "./greybox-catalog.json";
import { LEVEL_EDITOR_WORLD_UNIT } from "./constants";

export const GREYBOX_SCHEMA = "hayflick/greybox-catalog@1";
export const GREYBOX_BASE_UNIT_CM = 128;
export const GREYBOX_GAME_PIXELS_PER_BASE_UNIT_X = 32;
export const GREYBOX_TEXTURE_PIXELS_PER_GAME_PIXEL = 2;
export const GREYBOX_MIN_DETAIL_TEXELS = 2;
export const GREYBOX_MIN_DETAIL_CM =
  (GREYBOX_BASE_UNIT_CM / GREYBOX_GAME_PIXELS_PER_BASE_UNIT_X / GREYBOX_TEXTURE_PIXELS_PER_GAME_PIXEL) *
  GREYBOX_MIN_DETAIL_TEXELS;

export type GreyboxPlacement = "cell" | "edge" | "vertex";
export type GreyboxSemanticKind =
  | "floor"
  | "terrain"
  | "wall"
  | "window"
  | "door"
  | "corner";
export type GreyboxTerrain = "floor" | "grass" | "road" | "sidewalk" | "building";
export type GreyboxDoorState = "open" | "closed";

export type GreyboxBox = {
  id: string;
  centerCm: [number, number, number];
  sizeCm: [number, number, number];
  material: string;
  collision?: boolean;
};

export type GreyboxDefinition = {
  id: string;
  label: string;
  placement: GreyboxPlacement;
  anchorClass: "cell_center" | "edge_midpoint" | "vertex";
  semantic: {
    kind: GreyboxSemanticKind;
    terrain?: GreyboxTerrain;
    doorState?: GreyboxDoorState;
    blocksMovement: boolean;
  };
  dimensionsCm: [number, number, number];
  color: number;
  boxes: GreyboxBox[];
  states?: {
    default: GreyboxDoorState;
    values: Partial<
      Record<
        GreyboxDoorState,
        {
          semantic?: Partial<GreyboxDefinition["semantic"]>;
          boxes: GreyboxBox[];
        }
      >
    >;
  };
};

export type GreyboxCatalog = {
  schema: typeof GREYBOX_SCHEMA;
  units: {
    baseUnitCm: typeof GREYBOX_BASE_UNIT_CM;
    worldUnitsPerBaseUnit: number;
    minDetailCm: number;
  };
  definitions: GreyboxDefinition[];
};

export const GREYBOX_CATALOG = rawGreyboxCatalog as GreyboxCatalog;

const MATERIAL_COLORS: Record<string, number> = {
  floor: 0x8d9aa3,
  grass: 0x6aa56a,
  asphalt: 0x3d454b,
  sidewalk: 0xb7b9b3,
  building: 0x9a8b7a,
  wall: 0xd8dde2,
  wallAccent: 0xf0f3f5,
  glass: 0x8fd4ff,
  door: 0xb7895a
};

export function greyboxCmToWorld(cm: number): number {
  return (cm / GREYBOX_BASE_UNIT_CM) * LEVEL_EDITOR_WORLD_UNIT;
}

export function listGreyboxDefinitions(): GreyboxDefinition[] {
  return GREYBOX_CATALOG.definitions.slice();
}

export function findGreyboxDefinition(id: string): GreyboxDefinition | undefined {
  return GREYBOX_CATALOG.definitions.find((definition) => definition.id === id);
}

export function assertGreyboxCatalogValid(catalog: GreyboxCatalog = GREYBOX_CATALOG): void {
  if (catalog.schema !== GREYBOX_SCHEMA) {
    throw new Error(`Unsupported greybox catalog schema: ${catalog.schema}`);
  }
  if (catalog.units.baseUnitCm !== GREYBOX_BASE_UNIT_CM) {
    throw new Error(`Greybox base unit must be ${GREYBOX_BASE_UNIT_CM}cm`);
  }
  if (catalog.units.worldUnitsPerBaseUnit !== LEVEL_EDITOR_WORLD_UNIT) {
    throw new Error(`Greybox world unit scale must be ${LEVEL_EDITOR_WORLD_UNIT}`);
  }
  if (catalog.units.minDetailCm !== GREYBOX_MIN_DETAIL_CM) {
    throw new Error(`Greybox minimum detail must be ${GREYBOX_MIN_DETAIL_CM}cm`);
  }

  const seen = new Set<string>();
  for (const definition of catalog.definitions) {
    if (seen.has(definition.id)) {
      throw new Error(`Duplicate greybox id: ${definition.id}`);
    }
    seen.add(definition.id);
    if (
      (definition.placement === "cell" && definition.anchorClass !== "cell_center") ||
      (definition.placement === "edge" && definition.anchorClass !== "edge_midpoint") ||
      (definition.placement === "vertex" && definition.anchorClass !== "vertex")
    ) {
      throw new Error(`Greybox ${definition.id} has mismatched placement and anchor`);
    }
    for (const box of definition.boxes) {
      for (const size of box.sizeCm) {
        if (size < catalog.units.minDetailCm) {
          throw new Error(`Greybox ${definition.id}/${box.id} has detail below ${catalog.units.minDetailCm}cm`);
        }
      }
    }
    if (definition.states) {
      if (definition.semantic.kind !== "door") {
        throw new Error(`Greybox ${definition.id} has states but is not a door`);
      }
      const defaultState = definition.states.values[definition.states.default];
      if (!defaultState) {
        throw new Error(`Greybox ${definition.id} has missing default state`);
      }
      for (const [state, stateDef] of Object.entries(definition.states.values)) {
        if (!stateDef) {
          continue;
        }
        if (stateDef.semantic?.doorState !== state) {
          throw new Error(`Greybox ${definition.id} state ${state} has mismatched doorState`);
        }
        for (const box of stateDef.boxes) {
          for (const size of box.sizeCm) {
            if (size < catalog.units.minDetailCm) {
              throw new Error(`Greybox ${definition.id}/${state}/${box.id} has detail below ${catalog.units.minDetailCm}cm`);
            }
          }
        }
      }
    }
  }
}

export function resolveGreyboxDefinitionState(
  definition: GreyboxDefinition,
  state?: GreyboxDoorState
): {
  semantic: GreyboxDefinition["semantic"];
  boxes: GreyboxBox[];
  state?: GreyboxDoorState;
} {
  if (!definition.states) {
    return {
      semantic: definition.semantic,
      boxes: definition.boxes
    };
  }

  const resolvedState = state ?? definition.states.default;
  const stateDefinition = definition.states.values[resolvedState] ?? definition.states.values[definition.states.default];
  return {
    semantic: {
      ...definition.semantic,
      ...stateDefinition?.semantic
    },
    boxes: stateDefinition?.boxes ?? definition.boxes,
    state: resolvedState
  };
}

export function createGreyboxMeshTemplate(
  definition: GreyboxDefinition,
  options: { state?: GreyboxDoorState } = {}
): THREE.Group {
  const resolved = resolveGreyboxDefinitionState(definition, options.state);
  const group = new THREE.Group();
  group.name = resolved.state ? `greybox:${definition.id}:${resolved.state}` : `greybox:${definition.id}`;

  for (const box of resolved.boxes) {
    const material = new THREE.MeshStandardMaterial({
      color: MATERIAL_COLORS[box.material] ?? definition.color,
      roughness: box.material === "glass" ? 0.08 : 0.72,
      metalness: 0,
      transparent: box.material === "glass",
      opacity: box.material === "glass" ? 0.45 : 1
    });
    material.name = `greybox_${box.material}`;
    const geometry = new THREE.BoxGeometry(
      greyboxCmToWorld(box.sizeCm[0]),
      greyboxCmToWorld(box.sizeCm[1]),
      greyboxCmToWorld(box.sizeCm[2])
    );
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `${definition.id}:${box.id}`;
    mesh.position.set(
      greyboxCmToWorld(box.centerCm[0]),
      greyboxCmToWorld(box.centerCm[1]),
      greyboxCmToWorld(box.centerCm[2])
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.greybox = {
      definitionId: definition.id,
      boxId: box.id,
      semantic: resolved.semantic,
      collision: box.collision === true
    };
    group.add(mesh);
  }

  group.userData.greybox = {
    definitionId: definition.id,
    placement: definition.placement,
    semantic: resolved.semantic,
    state: resolved.state
  };
  return group;
}

export function disposeGreyboxMeshTemplate(template: THREE.Group): void {
  template.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) {
      return;
    }
    object.geometry.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      material.dispose();
    }
  });
}
