# Settlement Builder Physics/ECS Plan

## Objectives
- Keep one 3D physics stack for editor and game runtime.
- Make props first-class ECS entities with clear ownership of render, physics, and persisted state.
- Keep editor placement responsive while preserving believable stacking/drop behavior.
- Keep collider generation scalable by using lightweight generated collider assets.

## Target Module Boundaries
- `packages/experiments/src/settlement-builder-ecs/schema.ts`
  - Persistence contract and validation only.
- `packages/experiments/src/settlement-builder-ecs/prop-library.ts`
  - Asset metadata loading (bbox, collider metadata, physics hints).
- `packages/experiments/src/settlement-builder-ecs/physics-settings.ts`
  - Collision layers/masks, material presets, mass estimation.
- `packages/experiments/src/settlement-builder-ecs/prop-physics-profile.ts`
  - Physics profile inference and overrides.
- `packages/experiments/src/settlement-builder-ecs/game-physics-3d.ts`
  - ECS-facing Rapier adapter and rigid-body/collider lifecycle.
- `packages/experiments/src/settlement-builder-ecs/prop-physics-math.ts`
  - Shared pose/quaternion math for root/body transform conversion.
- `packages/experiments/src/settlement-builder-ecs/index.ts`
  - Orchestration only (UI flow, ECS world wiring, mode transitions).

## Implementation Phases

### Phase 1 (Implemented)
- Add save/load support for prop runtime state (rotation + velocities + sleep state).
- Add per-prop physics mobility/profile controls (support/fixed vs loose/dynamic).
- Add collision layer/mask policy and wire it to all runtime/editor colliders.
- Add `Clear All` action that resets authored and runtime editor state.
- Extend Forge export to generate simplified compound collider metadata.
- Extend settlement prop metadata parsing to ingest compound collider + physics hints.
- Extend `game-physics-3d` API for dynamic/fixed compound colliders and velocity/sleep controls.

### Phase 2 (In Progress)
- Extract shared prop pose/quaternion math from `index.ts` into `prop-physics-math.ts`.
- Add focused unit tests for pose conversion and quaternion invariants.
- Continue shrinking physics-specific logic in `index.ts` by moving reusable helpers into modules.

### Phase 3 (Next)
- Extract prop collider resolution into a dedicated module used by both editor and game runtime paths.
- Add ECS/system-level tests for prop activation delay, sleep/wake transitions, and reload consistency.
- Add a lightweight deterministic physics sandbox regression test scene (crate + bottle edge-drop).

## Acceptance Criteria
- Editor and game both run on the same 3D physics model and no 2D physics path remains.
- Prop placement in editor remains responsive at scale with proxy/compound colliders.
- Saved/reloaded scenes preserve physically settled orientations and velocity/sleep state.
- Runtime logic compiles and passes lint/typecheck/tests in `@experiments/catalog` and `@apps/hub`.
