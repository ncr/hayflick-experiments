import type {
  SavedPropColliderVariants,
  SavedPropCompoundCollider,
  SavedPropConvexHullCollider,
  SavedPropDefinition
} from "./prop-library";
import type { SettlementPropColliderMode } from "./schema";

type Vector3 = {
  x: number;
  y: number;
  z: number;
};

export type PropDimensions = {
  width: number;
  height: number;
  depth: number;
};

export type RapierCompoundPart = {
  translation: Vector3;
  halfExtents: Vector3;
};

export type PropColliderResolution =
  | {
      mode: "compound-boxes";
      shape: "compound-boxes";
      usesComplexCollider: true;
      localRootOffset: Vector3;
      parts: RapierCompoundPart[];
    }
  | {
      mode: "convex-hull";
      shape: "convex-hull";
      usesComplexCollider: true;
      localRootOffset: Vector3;
      vertices: Float32Array;
    }
  | {
      mode: "box";
      shape: "box";
      usesComplexCollider: false;
      localRootOffset: Vector3;
      halfExtents: Vector3;
    };

export type ConvexVerticesByPropId = Map<string, Float32Array>;

export function getPropColliderVariants(
  definition: SavedPropDefinition | null | undefined
): SavedPropColliderVariants | null {
  return definition?.colliderVariants ?? null;
}

export function getPropCompoundCollider(
  definition: SavedPropDefinition | null | undefined
): SavedPropCompoundCollider | null {
  const variants = getPropColliderVariants(definition);
  if (variants?.compoundBoxes && variants.compoundBoxes.parts.length > 0) {
    return variants.compoundBoxes;
  }
  return definition?.compoundCollider ?? null;
}

export function getPropConvexHullCollider(
  definition: SavedPropDefinition | null | undefined
): SavedPropConvexHullCollider | null {
  const variants = getPropColliderVariants(definition);
  if (variants?.convexHull && variants.convexHull.points.length >= 4) {
    return variants.convexHull;
  }
  return null;
}

export function getAvailablePropColliderModes(
  definition: SavedPropDefinition | null | undefined
): SettlementPropColliderMode[] {
  const modes: SettlementPropColliderMode[] = ["box"];
  if (getPropConvexHullCollider(definition)) {
    modes.push("convex-hull");
  }
  if (getPropCompoundCollider(definition)) {
    modes.push("compound-boxes");
  }
  return modes;
}

export function isPropColliderModeSupported(
  definition: SavedPropDefinition | null | undefined,
  mode: SettlementPropColliderMode
): boolean {
  return getAvailablePropColliderModes(definition).includes(mode);
}

export function resolveEffectivePropColliderMode(
  definition: SavedPropDefinition | null | undefined,
  explicitMode: SettlementPropColliderMode | null | undefined
): SettlementPropColliderMode {
  const fallback = getPropCompoundCollider(definition)
    ? "compound-boxes"
    : getPropConvexHullCollider(definition)
      ? "convex-hull"
      : "box";
  if (!explicitMode) {
    return fallback;
  }
  return isPropColliderModeSupported(definition, explicitMode)
    ? explicitMode
    : fallback;
}

function toRapierCompoundParts(
  compound: SavedPropCompoundCollider
): RapierCompoundPart[] {
  return compound.parts.map((part) => ({
    translation: {
      x: part.position[0],
      y: part.position[1],
      z: part.position[2]
    },
    halfExtents: {
      x: part.halfExtents[0],
      y: part.halfExtents[1],
      z: part.halfExtents[2]
    }
  }));
}

function flattenConvexHullVertices(hull: SavedPropConvexHullCollider): Float32Array {
  const flat = new Float32Array(hull.points.length * 3);
  let cursor = 0;
  for (const point of hull.points) {
    flat[cursor] = point[0];
    flat[cursor + 1] = point[1];
    flat[cursor + 2] = point[2];
    cursor += 3;
  }
  return flat;
}

export function resolvePropColliderResolution(options: {
  sourcePropId: string;
  definition: SavedPropDefinition | null | undefined;
  explicitMode: SettlementPropColliderMode | null | undefined;
  dimensions: PropDimensions;
  convexVerticesByPropId: ConvexVerticesByPropId;
}): PropColliderResolution {
  const mode = resolveEffectivePropColliderMode(options.definition, options.explicitMode);
  const dimensions = options.dimensions;

  if (mode === "compound-boxes") {
    const compound = getPropCompoundCollider(options.definition);
    if (compound && compound.parts.length > 0) {
      return {
        mode,
        shape: "compound-boxes",
        usesComplexCollider: true,
        localRootOffset: { x: 0, y: 0, z: 0 },
        parts: toRapierCompoundParts(compound)
      };
    }
  }

  if (mode === "convex-hull") {
    const convex = getPropConvexHullCollider(options.definition);
    if (convex) {
      const cached = options.convexVerticesByPropId.get(options.sourcePropId);
      const vertices = cached ?? flattenConvexHullVertices(convex);
      if (!cached) {
        options.convexVerticesByPropId.set(options.sourcePropId, vertices);
      }
      return {
        mode,
        shape: "convex-hull",
        usesComplexCollider: true,
        localRootOffset: {
          x: convex.rootOffset[0],
          y: convex.rootOffset[1],
          z: convex.rootOffset[2]
        },
        vertices
      };
    }
  }

  const halfHeight = dimensions.height * 0.5;
  return {
    mode: "box",
    shape: "box",
    usesComplexCollider: false,
    localRootOffset: { x: 0, y: -halfHeight, z: 0 },
    halfExtents: {
      x: dimensions.width * 0.5,
      y: halfHeight,
      z: dimensions.depth * 0.5
    }
  };
}
