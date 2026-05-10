import type { BBox } from "./dimensions";
import type {
  PropPhysicsMaterial,
  PropPhysicsMobility,
  PropPhysicsSettings
} from "../types";

type PhysicsMaterialPreset = {
  density: number;
  friction: number;
  restitution: number;
  linearDamping: number;
  angularDamping: number;
  activationDelayMs: number;
};

export const FORGE_PHYSICS_MATERIALS: PropPhysicsMaterial[] = [
  "default",
  "metal",
  "rubber",
  "glass",
  "wood",
  "concrete"
];

export const FORGE_PHYSICS_MATERIAL_PRESETS: Record<
  PropPhysicsMaterial,
  PhysicsMaterialPreset
> = {
  default: {
    density: 320,
    friction: 0.78,
    restitution: 0.03,
    linearDamping: 0.24,
    angularDamping: 0.34,
    activationDelayMs: 500
  },
  metal: {
    density: 780,
    friction: 0.62,
    restitution: 0.04,
    linearDamping: 0.2,
    angularDamping: 0.28,
    activationDelayMs: 500
  },
  rubber: {
    density: 250,
    friction: 1.2,
    restitution: 0.18,
    linearDamping: 0.45,
    angularDamping: 0.55,
    activationDelayMs: 500
  },
  glass: {
    density: 260,
    friction: 0.52,
    restitution: 0.05,
    linearDamping: 0.18,
    angularDamping: 0.24,
    activationDelayMs: 500
  },
  wood: {
    density: 420,
    friction: 0.72,
    restitution: 0.04,
    linearDamping: 0.26,
    angularDamping: 0.36,
    activationDelayMs: 500
  },
  concrete: {
    density: 1200,
    friction: 0.92,
    restitution: 0.01,
    linearDamping: 0.18,
    angularDamping: 0.24,
    activationDelayMs: 500
  }
};

export const DEFAULT_FORGE_PHYSICS_SETTINGS: PropPhysicsSettings = {
  mobility: "auto",
  material: "default",
  massMode: "auto",
  massScale: 1,
  manualMass: 0.65,
  friction: FORGE_PHYSICS_MATERIAL_PRESETS.default.friction,
  restitution: FORGE_PHYSICS_MATERIAL_PRESETS.default.restitution,
  linearDamping: FORGE_PHYSICS_MATERIAL_PRESETS.default.linearDamping,
  angularDamping: FORGE_PHYSICS_MATERIAL_PRESETS.default.angularDamping,
  activationDelayMs: FORGE_PHYSICS_MATERIAL_PRESETS.default.activationDelayMs
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isMaterial(value: unknown): value is PropPhysicsMaterial {
  return (
    value === "default" ||
    value === "metal" ||
    value === "rubber" ||
    value === "glass" ||
    value === "wood" ||
    value === "concrete"
  );
}

function normalizeMobility(value: unknown): PropPhysicsMobility {
  if (value === "fixed" || value === "dynamic") {
    return value;
  }
  return "auto";
}

function normalizeMassMode(value: unknown): "auto" | "manual" {
  return value === "manual" ? "manual" : "auto";
}

function volumeFromBBox(bbox: BBox | null): number {
  if (!bbox) {
    return 0;
  }
  return (
    Math.max(0, bbox.width) * Math.max(0, bbox.height) * Math.max(0, bbox.depth)
  );
}

export function estimateAutoMassFromBBox(
  bbox: BBox | null,
  material: PropPhysicsMaterial,
  massScale: number
): number {
  const preset = FORGE_PHYSICS_MATERIAL_PRESETS[material];
  const volume = volumeFromBBox(bbox);
  if (volume <= 0) {
    return 0.15;
  }
  // Scene-space tuning mass (not strict SI), aligned with runtime estimator.
  return clamp(volume * preset.density * 0.01 * massScale, 0.08, 40);
}

export function resolveForgeMass(
  settings: PropPhysicsSettings,
  bbox: BBox | null
): number {
  if (settings.massMode === "manual") {
    return clamp(settings.manualMass, 0.01, 250);
  }
  return estimateAutoMassFromBBox(bbox, settings.material, settings.massScale);
}

export function withMaterialPresetDefaults(
  settings: PropPhysicsSettings,
  material: PropPhysicsMaterial
): PropPhysicsSettings {
  const preset = FORGE_PHYSICS_MATERIAL_PRESETS[material];
  return {
    ...settings,
    material,
    friction: preset.friction,
    restitution: preset.restitution,
    linearDamping: preset.linearDamping,
    angularDamping: preset.angularDamping,
    activationDelayMs: preset.activationDelayMs
  };
}

export function normalizeForgePhysicsSettings(
  settings: Partial<PropPhysicsSettings> | null | undefined,
  bbox: BBox | null
): PropPhysicsSettings {
  const base = DEFAULT_FORGE_PHYSICS_SETTINGS;
  const material = isMaterial(settings?.material) ? settings.material : base.material;
  const preset = FORGE_PHYSICS_MATERIAL_PRESETS[material];

  const mobility = normalizeMobility(settings?.mobility);
  const massMode = normalizeMassMode(settings?.massMode);
  const massScale = clamp(asFiniteNumber(settings?.massScale) ?? base.massScale, 0.1, 10);
  const manualMass = clamp(
    asFiniteNumber(settings?.manualMass) ?? resolveForgeMass(base, bbox),
    0.01,
    250
  );

  return {
    mobility,
    material,
    massMode,
    massScale,
    manualMass,
    friction: clamp(asFiniteNumber(settings?.friction) ?? preset.friction, 0, 2),
    restitution: clamp(
      asFiniteNumber(settings?.restitution) ?? preset.restitution,
      0,
      1
    ),
    linearDamping: clamp(
      asFiniteNumber(settings?.linearDamping) ?? preset.linearDamping,
      0,
      20
    ),
    angularDamping: clamp(
      asFiniteNumber(settings?.angularDamping) ?? preset.angularDamping,
      0,
      20
    ),
    activationDelayMs: Math.floor(
      clamp(
        asFiniteNumber(settings?.activationDelayMs) ?? preset.activationDelayMs,
        0,
        120_000
      )
    )
  };
}

export function parseForgePhysicsSettingsFromMeta(
  rawPhysics: unknown,
  bbox: BBox | null
): PropPhysicsSettings {
  const record =
    typeof rawPhysics === "object" && rawPhysics !== null
      ? (rawPhysics as Record<string, unknown>)
      : {};

  const explicitMassMode = normalizeMassMode(record.massMode);
  const hasLegacyMassValue =
    asFiniteNumber(record.manualMass) !== null || asFiniteNumber(record.mass) !== null;
  const parsedMassMode =
    record.massMode === "manual" || record.massMode === "auto"
      ? explicitMassMode
      : hasLegacyMassValue
        ? "manual"
        : "auto";
  const material = isMaterial(record.material) ? record.material : undefined;
  const partial: Partial<PropPhysicsSettings> = {
    mobility: normalizeMobility(record.mobility),
    material,
    massMode: parsedMassMode,
    massScale: asFiniteNumber(record.massScale) ?? undefined,
    manualMass:
      asFiniteNumber(record.manualMass) ??
      asFiniteNumber(record.mass) ??
      undefined,
    friction: asFiniteNumber(record.friction) ?? undefined,
    restitution: asFiniteNumber(record.restitution) ?? undefined,
    linearDamping: asFiniteNumber(record.linearDamping) ?? undefined,
    angularDamping: asFiniteNumber(record.angularDamping) ?? undefined,
    activationDelayMs: asFiniteNumber(record.activationDelayMs) ?? undefined
  };

  return normalizeForgePhysicsSettings(partial, bbox);
}

export function buildPhysicsHintFromForgeSettings(
  settings: PropPhysicsSettings,
  bbox: BBox | null
): {
  mobility?: "fixed" | "dynamic";
  material: PropPhysicsMaterial;
  mass: number;
  friction: number;
  restitution: number;
  linearDamping: number;
  angularDamping: number;
  activationDelayMs: number;
  massMode: "auto" | "manual";
  massScale: number;
  manualMass: number;
} {
  return {
    mobility:
      settings.mobility === "auto"
        ? undefined
        : (settings.mobility as "fixed" | "dynamic"),
    material: settings.material,
    mass: resolveForgeMass(settings, bbox),
    friction: settings.friction,
    restitution: settings.restitution,
    linearDamping: settings.linearDamping,
    angularDamping: settings.angularDamping,
    activationDelayMs:
      settings.mobility === "fixed" ? 0 : settings.activationDelayMs,
    massMode: settings.massMode,
    massScale: settings.massScale,
    manualMass: settings.manualMass
  };
}
