import type { SavedPropDefinition, SavedPropPhysicsMaterial } from "./prop-library";

export const PHYSICS_LAYER = {
  WORLD_STATIC: 1 << 0,
  STRUCTURE_DOOR: 1 << 1,
  PROP_SUPPORT: 1 << 2,
  PROP_LOOSE: 1 << 3,
  PLAYER: 1 << 4
} as const;

export const PHYSICS_MASK = {
  PLAYER:
    PHYSICS_LAYER.WORLD_STATIC |
    PHYSICS_LAYER.STRUCTURE_DOOR |
    PHYSICS_LAYER.PROP_SUPPORT |
    PHYSICS_LAYER.PROP_LOOSE,
  WORLD_STATIC: PHYSICS_LAYER.PLAYER | PHYSICS_LAYER.PROP_LOOSE,
  STRUCTURE_DOOR: PHYSICS_LAYER.PLAYER | PHYSICS_LAYER.PROP_LOOSE,
  PROP_SUPPORT: PHYSICS_LAYER.PLAYER | PHYSICS_LAYER.PROP_LOOSE,
  PROP_LOOSE:
    PHYSICS_LAYER.WORLD_STATIC |
    PHYSICS_LAYER.STRUCTURE_DOOR |
    PHYSICS_LAYER.PROP_SUPPORT |
    PHYSICS_LAYER.PROP_LOOSE |
    PHYSICS_LAYER.PLAYER
} as const;

export type PhysicsMaterialPreset = {
  friction: number;
  restitution: number;
  density: number;
  linearDamping: number;
  angularDamping: number;
};

export const PHYSICS_MATERIAL_PRESETS: Record<
  SavedPropPhysicsMaterial,
  PhysicsMaterialPreset
> = {
  default: {
    friction: 0.78,
    restitution: 0.03,
    density: 320,
    linearDamping: 0.24,
    angularDamping: 0.34
  },
  metal: {
    friction: 0.62,
    restitution: 0.04,
    density: 780,
    linearDamping: 0.2,
    angularDamping: 0.28
  },
  rubber: {
    friction: 1.2,
    restitution: 0.18,
    density: 250,
    linearDamping: 0.45,
    angularDamping: 0.55
  },
  glass: {
    friction: 0.52,
    restitution: 0.05,
    density: 260,
    linearDamping: 0.18,
    angularDamping: 0.24
  },
  wood: {
    friction: 0.72,
    restitution: 0.04,
    density: 420,
    linearDamping: 0.26,
    angularDamping: 0.36
  },
  concrete: {
    friction: 0.92,
    restitution: 0.01,
    density: 1200,
    linearDamping: 0.18,
    angularDamping: 0.24
  }
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function collisionGroups(membership: number, filter: number): number {
  const groups = membership & 0xffff;
  const mask = filter & 0xffff;
  return (groups << 16) | mask;
}

export function estimateMassFromBounds(
  width: number,
  height: number,
  depth: number,
  density: number
): number {
  const volume = Math.max(0, width) * Math.max(0, height) * Math.max(0, depth);
  if (volume <= 0) {
    return 0.15;
  }
  // Units are scene-meters and density-like tuning units, not strict SI.
  return clamp(volume * density * 0.01, 0.08, 40);
}

export function inferPhysicsMaterialFromDefinition(
  definition: SavedPropDefinition | null | undefined
): SavedPropPhysicsMaterial {
  const explicit = definition?.physicsHint?.material;
  if (explicit) {
    return explicit;
  }
  if (!definition) {
    return "default";
  }

  const token = `${definition.id.toLowerCase()} ${definition.description.toLowerCase()}`;
  if (token.includes("glass") || token.includes("flask")) {
    return "glass";
  }
  if (
    token.includes("desk") ||
    token.includes("crate") ||
    token.includes("mainframe") ||
    token.includes("terminal") ||
    token.includes("workbench")
  ) {
    return "metal";
  }
  if (token.includes("chair") || token.includes("wood")) {
    return "wood";
  }
  return "default";
}
