import type {
  SavedPropDefinition,
  SavedPropPhysicsHint
} from "./prop-library";
import {
  estimateMassFromBounds,
  inferPhysicsMaterialFromDefinition,
  PHYSICS_MATERIAL_PRESETS
} from "./physics-settings";
import type {
  SettlementPropPhysicsMobility,
  SettlementPropPhysicsProfile
} from "./schema";

const SUPPORT_KEYWORDS = [
  "desk",
  "table",
  "bench",
  "mainframe",
  "terminal",
  "computer",
  "crate",
  "cabinet",
  "workbench",
  "shelf",
  "rack",
  "machine"
];

const DEFAULT_DYNAMIC_PROFILE: SettlementPropPhysicsProfile = {
  mobility: "dynamic",
  mass: 0.65,
  friction: PHYSICS_MATERIAL_PRESETS.default.friction,
  restitution: PHYSICS_MATERIAL_PRESETS.default.restitution,
  linearDamping: PHYSICS_MATERIAL_PRESETS.default.linearDamping,
  angularDamping: PHYSICS_MATERIAL_PRESETS.default.angularDamping,
  activationDelayMs: 500
};

const DEFAULT_FIXED_PROFILE: SettlementPropPhysicsProfile = {
  mobility: "fixed",
  mass: 10,
  friction: 0.9,
  restitution: 0,
  linearDamping: 0,
  angularDamping: 0,
  activationDelayMs: 0
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.floor(clamp(value, min, max));
}

function normalizedToken(value: string): string {
  return value.trim().toLowerCase();
}

function isLikelySupportProp(definition: SavedPropDefinition | null | undefined): boolean {
  if (!definition) {
    return false;
  }

  const width = Math.max(0, definition.bbox.width);
  const height = Math.max(0, definition.bbox.height);
  const depth = Math.max(0, definition.bbox.depth);
  const footprint = width * depth;
  const volume = width * height * depth;
  if (
    width >= 1.0 ||
    depth >= 1.0 ||
    height >= 1.35 ||
    footprint >= 0.85 ||
    volume >= 1.0
  ) {
    return true;
  }

  const token = `${normalizedToken(definition.id)} ${normalizedToken(definition.description)}`;
  return SUPPORT_KEYWORDS.some((keyword) => token.includes(keyword));
}

function applySavedHint(
  base: SettlementPropPhysicsProfile,
  hint: SavedPropPhysicsHint | undefined
): SettlementPropPhysicsProfile {
  if (!hint) {
    return base;
  }

  return normalizePropPhysicsProfile({
    mobility: hint.mobility ?? base.mobility,
    mass: hint.mass ?? base.mass,
    friction: hint.friction ?? base.friction,
    restitution: hint.restitution ?? base.restitution,
    linearDamping: hint.linearDamping ?? base.linearDamping,
    angularDamping: hint.angularDamping ?? base.angularDamping,
    activationDelayMs: hint.activationDelayMs ?? base.activationDelayMs
  });
}

export function clonePropPhysicsProfile(
  profile: SettlementPropPhysicsProfile
): SettlementPropPhysicsProfile {
  return {
    mobility: profile.mobility,
    mass: profile.mass,
    friction: profile.friction,
    restitution: profile.restitution,
    linearDamping: profile.linearDamping,
    angularDamping: profile.angularDamping,
    activationDelayMs: profile.activationDelayMs
  };
}

export function normalizePropPhysicsProfile(
  profile: SettlementPropPhysicsProfile
): SettlementPropPhysicsProfile {
  return {
    mobility: profile.mobility === "fixed" ? "fixed" : "dynamic",
    mass: clamp(profile.mass, 0.01, 250),
    friction: clamp(profile.friction, 0, 2),
    restitution: clamp(profile.restitution, 0, 1),
    linearDamping: clamp(profile.linearDamping, 0, 20),
    angularDamping: clamp(profile.angularDamping, 0, 20),
    activationDelayMs: clampInteger(profile.activationDelayMs, 0, 120_000)
  };
}

export function withPropPhysicsMobility(
  profile: SettlementPropPhysicsProfile,
  mobility: SettlementPropPhysicsMobility
): SettlementPropPhysicsProfile {
  const normalizedBase = normalizePropPhysicsProfile(profile);
  if (mobility === "fixed") {
    return normalizePropPhysicsProfile({
      ...normalizedBase,
      mobility: "fixed",
      activationDelayMs: 0
    });
  }

  return normalizePropPhysicsProfile({
    ...normalizedBase,
    mobility: "dynamic",
    activationDelayMs: Math.max(1, normalizedBase.activationDelayMs || 500)
  });
}

export function inferPropPhysicsProfile(
  definition: SavedPropDefinition | null | undefined
): SettlementPropPhysicsProfile {
  const support = isLikelySupportProp(definition);
  const material = inferPhysicsMaterialFromDefinition(definition);
  const materialPreset = PHYSICS_MATERIAL_PRESETS[material];
  const estimatedMass = estimateMassFromBounds(
    definition?.bbox.width ?? 0,
    definition?.bbox.height ?? 0,
    definition?.bbox.depth ?? 0,
    materialPreset.density
  );

  const base = support
    ? clonePropPhysicsProfile(DEFAULT_FIXED_PROFILE)
    : {
        ...clonePropPhysicsProfile(DEFAULT_DYNAMIC_PROFILE),
        mass: estimatedMass,
        friction: materialPreset.friction,
        restitution: materialPreset.restitution,
        linearDamping: materialPreset.linearDamping,
        angularDamping: materialPreset.angularDamping
      };
  return applySavedHint(base, definition?.physicsHint);
}
