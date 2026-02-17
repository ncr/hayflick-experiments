# Settlement Builder Physics/ECS Integration Plan

## Vision
- One physics authority for editor and game runtime, with clean ECS ownership boundaries.
- Predictable, robust behavior under common integration stressors: spawn/despawn churn, save/load, mode switches, and collider/profile changes.
- Simple and explicit asset rules, including material-driven mass and damping defaults that behave like modern game pipelines.
- Scalable runtime with measurable performance budgets and regression gates.

## Success Criteria
- No direct physics orchestration in UI/controller flow beyond intent and mode transitions.
- Physics world and ECS state remain synchronized without dual-authority drift.
- Prop physics defaults are deterministic from metadata and produce stable behavior without per-prop hand tuning.
- Collider complexity is bounded by policy and does not regress editor responsiveness.
- All critical behavior is covered by automated unit/integration/perf tests.

## Core Integration Rules

### Rule 1: Single pose authority per mode
- In active simulation, physics pose is authoritative.
- ECS transform and render root are derived from physics every frame.
- Teleports are explicit operations that reset both pose and velocities.

### Rule 2: Fixed-step simulation contract
- Use fixed timestep stepping with bounded catch-up substeps.
- Clamp runaway frame debt and expose dropped-step counters for diagnostics.
- Keep deterministic step ordering around input, activation, physics, and sync.

### Rule 3: Stable rigid-body lifecycle
- Spawn and despawn via one lifecycle API only.
- Rebuild bodies only on explicit dirty flags: collider mode change, mobility change, source asset change, or placement identity change.
- Preserve runtime state on rebuild when semantically valid (rotation, velocities, sleeping).

### Rule 4: Material-first asset defaults
- Every prop resolves to one physics material (`default`, `metal`, `wood`, `glass`, `rubber`, `concrete`).
- Mass is computed from bounds volume x material density with bounded clamps.
- Optional per-prop overrides are allowed but normalized and validated.

### Rule 5: Collider tier policy
- Default editor and runtime collision uses `compound-boxes` when present.
- `convex-hull` is fallback when compound data is unavailable.
- `box` is final fallback from bounds.
- Full render-mesh collision is not part of normal editor/runtime paths.

## Target Architecture

### Physics-facing modules
- `packages/experiments/src/settlement-builder-ecs/game-physics-3d.ts`
  - Rapier resource creation, body/collider APIs, stepping, and handle safety.
- `packages/experiments/src/settlement-builder-ecs/physics-settings.ts`
  - Collision groups/masks, material presets, density and damping defaults, mass estimation.
- `packages/experiments/src/settlement-builder-ecs/prop-physics-profile.ts`
  - Profile inference, normalization, mobility transitions, override application.
- `packages/experiments/src/settlement-builder-ecs/prop-physics-math.ts`
  - Root/body transform conversion, quaternion helpers, pose delta checks.

### Asset and persistence modules
- `packages/experiments/src/settlement-builder-ecs/prop-library.ts`
  - Prop metadata parsing and fallback synthesis for collider variants and physics hints.
- `packages/experiments/src/settlement-builder-ecs/schema.ts`
  - Save/load contract, runtime state serialization, profile and collider-mode persistence.

### Orchestration module
- `packages/experiments/src/settlement-builder-ecs/index.ts`
  - Mode transitions, UI intent routing, ECS scene wiring.
  - No embedded physics math/business logic beyond orchestration.

## Asset Contract (Simple, Sensible Rules)

### Required metadata behavior
- Props should include:
  - `processing.bbox`
  - `colliderVariants` (`box`, optional `convexHull`, optional `compoundBoxes`)
  - optional `physics` hint
- Missing variants fall back in this order:
  - synthesize `box` from `bbox`
  - synthesize `convexHull` from box corners
  - use `box` runtime collider

### Material and mass policy
- Material determines default:
  - density
  - friction
  - restitution
  - linear damping
  - angular damping
- Mass formula:
  - `mass = clamp(volume_m3 * density * massScale, minMass, maxMass)`
  - default `massScale` remains tuned for gameplay feel, not strict SI.
- Large/support props default to `fixed`.
- Small/loose props default to `dynamic` with nonzero activation delay.

### Override policy
- Allowed override fields:
  - `mobility`, `mass`, `friction`, `restitution`, `linearDamping`, `angularDamping`, `activationDelayMs`, `material`
- All overrides are normalized and clamped in one place.
- Invalid values are rejected at parse time, never silently forwarded.

## Common Pitfalls and Required Guards
- Dual authority drift:
  - Never write transform from gameplay logic when physics is active.
- Handle invalidation:
  - Guard every body/collider lookup and clean maps on removal.
- Root offset mismatch:
  - Always convert with shared root/body helpers.
- Rebuild state loss:
  - Preserve quaternion and velocities when rebuilding equivalent bodies.
- Save/load flattening:
  - Persist and restore sleeping + linear/angular velocities with pose.
- Collision-layer leaks:
  - Enforce layer/mask mapping centrally and test combinations.
- Activation race bugs:
  - Dynamic activation delay uses monotonic timestamps and explicit pending maps.

## Performance Plan

### Budgets
- Editor target:
  - smooth interaction with hundreds of props using compound/box colliders.
- Runtime target:
  - stable fixed-step under typical settlement scenes without continuous catch-up overflow.

### Controls
- Keep collider complexity bounded (`compound-boxes` preferred).
- Enable CCD only where necessary (loose dynamics).
- Avoid per-frame body recreation; use dirty-flag sync.
- Batch autosave and hover refresh on movement thresholds.
- Track metrics:
  - active dynamic body count
  - sleeping ratio
  - fixed-step substeps per frame
  - rebuild counts by reason

## Test and Validation Plan

### Unit tests
- `prop-physics-profile.test.ts`
  - inference and clamp rules.
- `prop-physics-math.test.ts`
  - root/body conversion and quaternion invariants.
- `prop-library.test.ts`
  - collider/material metadata parsing and fallback precedence.
- `schema.test.ts`
  - persistence of runtime state + profile + collider mode.

### Integration tests
- Spawn/remove/rebuild lifecycle with preserved state.
- Activation delay transitions (`fixed -> dynamic`, pending -> active).
- Save/load round-trip preserving settled chaos states.
- Door/prop/player collision-layer interaction checks.

### Performance and regression tests
- Deterministic sandbox scene:
  - crate + bottle edge drop
  - support stack stability
  - reload consistency
- Automated thresholds:
  - max substep clamp behavior
  - no uncontrolled body count growth
  - no per-frame rebuild churn

## Execution Phases

### Phase A: Encapsulation hardening
- Move remaining physics-heavy logic from `index.ts` into dedicated helpers/modules.
- Introduce explicit dirty-reason enums for body rebuild decisions.
- Add diagnostic counters and debug HUD hooks for physics state.

### Phase B: Asset-rule enforcement
- Centralize material resolution and mass derivation in one API.
- Add metadata validation script and fail-fast warnings for missing/invalid collider variants.
- Enforce collider tier selection policy with explicit fallback logging.

### Phase C: Lifecycle and state robustness
- Formalize spawn/rebuild/despawn APIs used by both EDITOR and GAME paths.
- Guarantee runtime-state carry-forward across rebuilds and mode transitions.
- Tighten save/load restore ordering to eliminate transient desync windows.

### Phase D: Performance stabilization
- Profile dynamic-heavy scenarios and tune damping/CCD/activation defaults.
- Add rebuild-throttle protections and verify no per-frame collider churn.
- Set measurable perf baselines and document limits.

### Phase E: Verification gates
- Expand automated integration/perf tests to cover known regression classes.
- Require pass on typecheck/tests before merging physics changes.
- Add one end-to-end editor workflow smoke test for placement, delay activation, save, reload.

## Immediate Next Actions
- Extract prop collider resolution into one reusable resolver module for both EDITOR and GAME paths.
- Add integration tests for activation delay + runtime-state persistence across rebuild.
- Add physics diagnostics panel (dynamic count, sleeping count, substep count, rebuild reason totals).
