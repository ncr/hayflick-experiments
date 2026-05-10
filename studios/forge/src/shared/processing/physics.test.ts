import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  buildPhysicsHintFromForgeSettings,
  DEFAULT_FORGE_PHYSICS_SETTINGS,
  normalizeForgePhysicsSettings,
  parseForgePhysicsSettingsFromMeta,
  resolveForgeMass,
  withMaterialPresetDefaults
} from "./physics";

function makeBBox(width: number, height: number, depth: number) {
  return {
    width,
    height,
    depth,
    center: new THREE.Vector3(),
    min: new THREE.Vector3(),
    max: new THREE.Vector3()
  };
}

describe("forge physics settings", () => {
  it("computes auto mass from bbox volume/material density", () => {
    const settings = normalizeForgePhysicsSettings(
      {
        ...DEFAULT_FORGE_PHYSICS_SETTINGS,
        material: "metal",
        massMode: "auto",
        massScale: 1
      },
      makeBBox(1, 1, 1)
    );
    const mass = resolveForgeMass(settings, makeBBox(1, 1, 1));
    expect(mass).toBeCloseTo(7.8, 4);
  });

  it("uses manual mass when manual mode is selected", () => {
    const settings = normalizeForgePhysicsSettings(
      {
        ...DEFAULT_FORGE_PHYSICS_SETTINGS,
        massMode: "manual",
        manualMass: 2.5
      },
      makeBBox(2, 2, 2)
    );
    expect(resolveForgeMass(settings, makeBBox(2, 2, 2))).toBeCloseTo(2.5, 8);
  });

  it("applies material preset defaults for friction/restitution/damping", () => {
    const settings = withMaterialPresetDefaults(DEFAULT_FORGE_PHYSICS_SETTINGS, "glass");
    expect(settings.material).toBe("glass");
    expect(settings.friction).toBeCloseTo(0.52, 8);
    expect(settings.restitution).toBeCloseTo(0.05, 8);
    expect(settings.linearDamping).toBeCloseTo(0.18, 8);
    expect(settings.angularDamping).toBeCloseTo(0.24, 8);
  });

  it("parses legacy meta with mass and emits runtime physics hint", () => {
    const parsed = parseForgePhysicsSettingsFromMeta(
      {
        mobility: "dynamic",
        material: "wood",
        mass: 1.75,
        friction: 0.66,
        restitution: 0.08,
        linearDamping: 0.31,
        angularDamping: 0.41,
        activationDelayMs: 250
      },
      makeBBox(0.7, 1.0, 0.7)
    );
    const hint = buildPhysicsHintFromForgeSettings(parsed, makeBBox(0.7, 1.0, 0.7));

    expect(hint.mobility).toBe("dynamic");
    expect(hint.material).toBe("wood");
    expect(hint.mass).toBeCloseTo(1.75, 8);
    expect(hint.friction).toBeCloseTo(0.66, 8);
    expect(hint.activationDelayMs).toBe(250);
  });
});
