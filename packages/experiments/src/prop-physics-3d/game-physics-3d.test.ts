import { describe, expect, it } from "vitest";

import {
  applyPhysics3dWorldTuning,
  configureDynamicBodyTuning,
  DEFAULT_PHYSICS3D_ANGULAR_DAMPING,
  DEFAULT_PHYSICS3D_COMPLEX_BODY_SOLVER_ITERATIONS,
  DEFAULT_PHYSICS3D_LINEAR_DAMPING
} from "./game-physics-3d";

describe("game-physics-3d tuning", () => {
  it("applies stable world tuning defaults", () => {
    const integrationParameters = {
      dt: 0,
      maxCcdSubsteps: 0,
      numSolverIterations: 0,
      numInternalPgsIterations: 0,
      normalizedAllowedLinearError: 0
    };

    applyPhysics3dWorldTuning(integrationParameters, 1 / 120);

    expect(integrationParameters).toEqual({
      dt: 1 / 120,
      maxCcdSubsteps: 4,
      numSolverIterations: 8,
      numInternalPgsIterations: 2,
      normalizedAllowedLinearError: 0.0005
    });
  });

  it("gives complex dynamic bodies extra solver iterations", () => {
    const calls = {
      linearDamping: 0,
      angularDamping: 0,
      ccd: false,
      additionalSolverIterations: 0
    };

    configureDynamicBodyTuning(
      {
        setLinearDamping(value) {
          calls.linearDamping = value;
        },
        setAngularDamping(value) {
          calls.angularDamping = value;
        },
        enableCcd(value) {
          calls.ccd = value;
        },
        setAdditionalSolverIterations(value) {
          calls.additionalSolverIterations = value;
        }
      },
      {
        usesComplexCollider: true
      }
    );

    expect(calls).toEqual({
      linearDamping: DEFAULT_PHYSICS3D_LINEAR_DAMPING,
      angularDamping: DEFAULT_PHYSICS3D_ANGULAR_DAMPING,
      ccd: true,
      additionalSolverIterations: DEFAULT_PHYSICS3D_COMPLEX_BODY_SOLVER_ITERATIONS
    });
  });

  it("respects explicit dynamic body tuning overrides", () => {
    const calls = {
      linearDamping: 0,
      angularDamping: 0,
      ccd: true,
      additionalSolverIterations: 0
    };

    configureDynamicBodyTuning(
      {
        setLinearDamping(value) {
          calls.linearDamping = value;
        },
        setAngularDamping(value) {
          calls.angularDamping = value;
        },
        enableCcd(value) {
          calls.ccd = value;
        },
        setAdditionalSolverIterations(value) {
          calls.additionalSolverIterations = value;
        }
      },
      {
        linearDamping: 0.5,
        angularDamping: 0.6,
        ccd: false,
        additionalSolverIterations: 5
      }
    );

    expect(calls).toEqual({
      linearDamping: 0.5,
      angularDamping: 0.6,
      ccd: false,
      additionalSolverIterations: 5
    });
  });
});
