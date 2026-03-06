import type { Physics3dConvexHullPart } from "../settlement-builder-ecs/game-physics-3d";
import {
  PHYSICS_MATERIAL_PRESETS,
  estimateMassFromBounds
} from "../settlement-builder-ecs/physics-settings";
import {
  computeCompoundHullDimensions,
  parseCompoundConvexHullParts
} from "./compound-hull-collider";

export type ForgeV2CompoundCollider = {
  parts: Physics3dConvexHullPart[];
  localRootOffset: {
    x: number;
    y: number;
    z: number;
  };
  dimensions: {
    width: number;
    height: number;
    depth: number;
  };
};

export type ForgeV2PropMeta = {
  id: string;
  collider: ForgeV2CompoundCollider | null;
  physics: {
    mass: number;
    friction: number;
    restitution: number;
    linearDamping: number;
    angularDamping: number;
  };
};

type RecordLike = Record<string, unknown>;

function asRecord(raw: unknown): RecordLike | null {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as RecordLike)
    : null;
}

function asFiniteNumber(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function asPhysicsMaterial(
  raw: unknown
): keyof typeof PHYSICS_MATERIAL_PRESETS | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  return raw in PHYSICS_MATERIAL_PRESETS
    ? (raw as keyof typeof PHYSICS_MATERIAL_PRESETS)
    : undefined;
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = asFiniteNumber(value);
    if (parsed !== null) {
      return parsed;
    }
  }
  return undefined;
}

function firstPhysicsMaterial(
  ...values: unknown[]
): keyof typeof PHYSICS_MATERIAL_PRESETS | undefined {
  for (const value of values) {
    const parsed = asPhysicsMaterial(value);
    if (parsed) {
      return parsed;
    }
  }
  return undefined;
}

function parseVector3Tuple(raw: unknown): [number, number, number] | null {
  if (!Array.isArray(raw) || raw.length !== 3) {
    return null;
  }
  const x = asFiniteNumber(raw[0]);
  const y = asFiniteNumber(raw[1]);
  const z = asFiniteNumber(raw[2]);
  if (x === null || y === null || z === null) {
    return null;
  }
  return [x, y, z];
}

function parseProcessedDimensions(raw: unknown): {
  width: number;
  height: number;
  depth: number;
} | null {
  const processing = asRecord(raw);
  const mesh = asRecord(processing?.mesh);
  const bbox = asRecord(mesh?.bboxProcessed);
  const width = asFiniteNumber(bbox?.width);
  const height = asFiniteNumber(bbox?.height);
  const depth = asFiniteNumber(bbox?.depth);
  if (
    width === null ||
    height === null ||
    depth === null ||
    width <= 0 ||
    height <= 0 ||
    depth <= 0
  ) {
    return null;
  }
  return { width, height, depth };
}

function parseLocalRootOffset(raw: unknown): { x: number; y: number; z: number } {
  const processing = asRecord(raw);
  const transform = asRecord(processing?.transform);
  const finalPivot = asRecord(transform?.finalPivot);
  const offset = parseVector3Tuple(finalPivot?.offset);
  if (!offset) {
    return { x: 0, y: 0, z: 0 };
  }
  return {
    x: -offset[0],
    y: -offset[1],
    z: -offset[2]
  };
}

function selectCompoundHullParts(raw: unknown): Physics3dConvexHullPart[] {
  const colliders = asRecord(raw);
  const presets = Array.isArray(colliders?.presets) ? colliders.presets : [];
  const selectedPresetId =
    typeof colliders?.selectedPresetId === "string" ? colliders.selectedPresetId : null;

  const candidates = presets
    .map((presetRaw) => {
      const preset = asRecord(presetRaw);
      const presetId = typeof preset?.presetId === "string" ? preset.presetId : null;
      const generation = asRecord(preset?.generation);
      const hullCount = asFiniteNumber(generation?.hullCount) ?? 0;
      const parts = parseCompoundConvexHullParts(preset?.collider);
      return {
        presetId,
        hullCount,
        parts
      };
    })
    .filter((candidate) => candidate.parts.length > 0);

  if (candidates.length <= 0) {
    return [];
  }

  if (selectedPresetId) {
    const selected = candidates.find((candidate) => candidate.presetId === selectedPresetId);
    if (selected) {
      return selected.parts;
    }
  }

  return candidates.reduce((best, candidate) =>
    candidate.hullCount > best.hullCount ? candidate : best
  ).parts;
}

export function parseForgeV2PropMeta(
  id: string,
  raw: Record<string, unknown>
): ForgeV2PropMeta {
  const parts = selectCompoundHullParts(raw.colliders);
  const processedDimensions = parseProcessedDimensions(raw.processing);
  const dimensions = processedDimensions ?? computeCompoundHullDimensions(parts);
  const localRootOffset = parseLocalRootOffset(raw.processing);

  const physicsSection = asRecord(raw.physics);
  const resolved = asRecord(physicsSection?.resolved);
  const overrides = asRecord(physicsSection?.overrides);
  const materialName = firstPhysicsMaterial(
    physicsSection?.material,
    resolved?.material,
    overrides?.material,
    physicsSection?.kind
  );
  const preset = materialName
    ? PHYSICS_MATERIAL_PRESETS[materialName]
    : PHYSICS_MATERIAL_PRESETS.default;
  const massOverride = firstFiniteNumber(
    physicsSection?.mass,
    resolved?.mass,
    resolved?.manualMass,
    overrides?.mass,
    overrides?.manualMass,
    physicsSection?.manualMass
  );

  return {
    id,
    collider:
      parts.length > 0
        ? {
            parts,
            localRootOffset,
            dimensions
          }
        : null,
    physics: {
      mass:
        massOverride ??
        estimateMassFromBounds(
          dimensions.width,
          dimensions.height,
          dimensions.depth,
          preset.density
        ),
      friction: firstFiniteNumber(
        physicsSection?.friction,
        resolved?.friction,
        overrides?.friction
      ) ?? preset.friction,
      restitution: firstFiniteNumber(
        physicsSection?.restitution,
        resolved?.restitution,
        overrides?.restitution
      ) ?? preset.restitution,
      linearDamping: firstFiniteNumber(
        physicsSection?.linearDamping,
        resolved?.linearDamping,
        overrides?.linearDamping
      ) ?? preset.linearDamping,
      angularDamping: firstFiniteNumber(
        physicsSection?.angularDamping,
        resolved?.angularDamping,
        overrides?.angularDamping
      ) ?? preset.angularDamping
    }
  };
}
