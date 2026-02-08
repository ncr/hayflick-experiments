# Agent Learnings

## 2026-02-07 - Camera looked off-center despite "centered" math
Root cause:
- Canvas CSS size and drawing-buffer size diverged on high-DPI/mobile paths.
- `three.js` renderer sizing used `setSize(..., false)`, which updated buffer size but did not reliably keep CSS size aligned in this setup.
- Result: user-visible viewport behaved like a cropped/scaled subsection, so world-to-NDC checks were misleading for perceived composition.

Detection signal:
- User repeatedly reported "object is in bottom-right" while debug text showed NDC near `(0, 0)`.
- Visual screenshots contradicted math-based confidence.
- Composition changed unexpectedly between local/hosted/mobile views.

Preventive checklist:
- Renderer sizing:
  - Use `renderer.setSize(width, height, true)` in init and resize paths where canvas CSS dimensions must track viewport dimensions.
  - Ensure `renderer.domElement.style.display = "block"` to avoid inline-canvas layout artifacts.
- Verification:
  - Validate on local preview first (do not depend on deploys for iteration).
  - Confirm both with numeric checks and with actual screenshots from the rendered viewport.
  - If user feedback conflicts with metrics, treat it as a real bug signal and re-check assumptions.
- Communication:
  - State exactly what was verified (local/production, desktop/mobile, and method).

## 2026-02-07 - Workspace package imports failed after adding new dependency
Root cause:
- Added a new workspace dependency in `packages/experiments/package.json` (`@common/gameplay`) but did not refresh workspace linking immediately.
- TypeScript in `@experiments/catalog` and `@apps/hub` could not resolve the newly added package until workspace install state was refreshed.

Detection signal:
- `TS2307` module resolution errors for `@common/gameplay` imports, even though package exports and source files existed.
- Errors appeared in dependent workspaces right after editing package manifests.

Preventive checklist:
- After changing workspace package dependencies, run `pnpm install` before typecheck/build validation.
- Re-run package-level typecheck after install to confirm import resolution before deeper debugging.

## 2026-02-07 - Player movement direction felt inverted and broke after camera rotation
Root cause:
- Gameplay input used a world-axis player input mapping that ignored camera orientation.
- In an isometric view with rotatable camera (`Q`/`E`), screen-relative intent (WASD/arrow keys) diverged from world-relative velocity, including default up/down feeling reversed.

Detection signal:
- User reported up/down felt reversed in default rotation and controls did not stay consistent after rotating the level view.

Preventive checklist:
- For any camera-rotatable gameplay view, map movement input through camera ground-plane forward/right vectors, not fixed world axes.
- Validate directional controls at all 4 quarter-turn rotations before shipping.
- Include at least one manual check that "W/Up moves toward top of screen" in default and rotated views.

## 2026-02-08 - Editor core drifted between experiments
Root cause:
- Tile-level model/bake logic existed only inside `editor-game-ecs`, while `level-builder` maintained a separate resource-construction path.
- Shared behavior changes required touching both experiments manually, increasing divergence risk.

Detection signal:
- User requested explicit reuse so both experiments evolve from the same editor core.

Preventive checklist:
- Keep shared editor model + bake/resource helpers in a common package (`@common/level-editor`).
- Import shared helpers from experiments instead of duplicating local model/bake files.
- When adding editor features, update shared package first, then wire experiment-specific UI.

## 2026-02-08 - Autotile orientation mismatched expected corner/T direction
Root cause:
- Rotation direction was applied ad-hoc in experiment rendering code, separate from autotile mask mapping logic.
- A clockwise/counterclockwise sign mismatch on ground-plane overlays caused some corner/T tiles to face the wrong way.

Detection signal:
- Visual report: corner/T/angle road and sidewalk tiles appeared rotated incorrectly while mask mapping looked correct.

Preventive checklist:
- Keep autotile mask decoding and rotation conversion in shared `@common/level-editor` helpers.
- Unit-test all 16 cardinal masks and quarter-turn to radians conversion.
- Use shared helpers from experiments instead of hand-rolled rotation math in rendering code.

## 2026-02-08 - Browser E2E clicks were blocked by HUD overlay
Root cause:
- Playwright test clicks targeted top-left canvas positions where HUD panels intentionally consumed pointer events.

Detection signal:
- Repeated click retries with “subtree intercepts pointer events” while canvas was visible.

Preventive checklist:
- In canvas-based E2E tests, focus with `canvas.focus()` and interact in unobstructed stage regions.
- Add stable `data-testid` hooks for HUD status/stats assertions instead of relying on fragile text traversal.

## 2026-02-08 - Editor UI drifted between standalone and ECS-integrated experiments
Root cause:
- HUD/panel/button UI was duplicated in each experiment and evolved independently.

Detection signal:
- User observed large UX/style mismatch between `level-builder` and `editor-game-ecs`.

Preventive checklist:
- Keep editor HUD construction in shared `@common/level-editor` and consume it from all editor experiments.
- Limit experiments to mode/feature-specific controls and state logic; avoid re-implementing shared UI scaffolding.

## 2026-02-08 - Terrain-capable editor state was not fully persisted in ECS-integrated save/load
Root cause:
- `editor-game-ecs` added terrain/default-ground/seed state, but save/load paths still primarily serialized `LevelModel`.
- `loadGameNow()` restored tiles/placements but did not always restore terrain overrides before rebuilding runtime meshes.

Detection signal:
- User reported save appeared to work but load behavior was inconsistent and status copy suggested only model-level saving.
- Gameplay/editor visual state diverged after reload.

Preventive checklist:
- When adding editor state fields, update both persistence layers together:
  - editor-state save/load (`Ctrl+S`)
  - runtime game save/load (`K`/`L`)
- Add a browser smoke test that saves in GAME, reloads, and asserts restored terrain + door/player state.
- Keep save status messages explicit about what payload was written.

## 2026-02-08 - Wall/door mesh style drifted across editor-driven experiments
Root cause:
- Structure mesh builders/materials were duplicated in experiment files.
- Visual tweaks landed in one experiment without propagating to the other.

Detection signal:
- User reported wall meshes did not match between editor/game flows.

Preventive checklist:
- Keep structure mesh factories in `@common/level-editor` and consume them from all editor-style experiments.
- Avoid local mesh/material definitions for walls/windows/doors when a shared kit exists.
- Add promoted-module tests when shared mesh APIs change.

## 2026-02-08 - Runtime wall tiles still looked different after mesh promotion
Root cause:
- Even after promotion, the ECS-integrated experiment rendered tile walls via a separate "block" shape path, while editor walls were segment-based.
- Shared API existed, but represented two visual grammars.

Detection signal:
- User explicitly observed that wall mesh in editor and game still differed.

Preventive checklist:
- Treat the editor asset module as the single source of truth for style:
  - one wall language, one door language
  - runtime should compose from editor primitives, not alternate fallback forms
- When exposing helper constructors (e.g. `createWallBlock`), build them from the same base primitives/materials.
- Add mesh-kit tests that assert higher-level constructors are composite (not standalone alternate geometry).

## 2026-02-08 - Tile-wall rendering should use boundary extraction, not per-cell wall blocks
Root cause:
- Rendering one full wall object per blocked tile produced dense "4-sided" visuals and duplicated internal walls.
- This conflicted with intended segment-style room boundaries.

Detection signal:
- User reported runtime walls looked like multiple walls per tile instead of single boundary segments.

Preventive checklist:
- For tile occupancy walls, generate segments only on transitions from blocked -> non-blocked (N/E/S/W boundary extraction).
- Treat door cells as openings in the wall boundary pass.
- Add node-based join posts from segment adjacency so corners/T/crosses remain consistent.

## 2026-02-08 - Default mockup changes can be hidden by persisted localStorage state
Root cause:
- Experiment startup restored prior editor/game saves, so new default layouts were not visible.

Detection signal:
- User reported default scene still not matching requested structure after code changes.

Preventive checklist:
- When intentionally redefining startup mockups, bump localStorage keys (or add migration/override logic).
- Keep README save-key docs aligned with code constants.

## 2026-02-08 - ECS-integrated editor diverged from standalone wall editing semantics
Root cause:
- `editor-game-ecs` still authored walls as blocked cells (`LevelModel.tiles`) while `level-builder` authored edge segments.
- Rendering and interaction paths looked similar but produced different outcomes (one painted cell implied four wall edges).

Detection signal:
- User repeatedly reported that painting one wall in `editor-game-ecs` created four walls and did not match `level-builder`.

Preventive checklist:
- Keep structure authoring data model shared across editor experiments (edge segments, not mixed tile/edge approaches).
- Derive runtime doors from stable edge placement IDs, not cell positions.
- Cover mode-switch/save-load behavior with browser smoke tests after changing editor model internals.

## 2026-02-08 - Stringly discriminants and unsafe schema casts weakened parser/runtime guarantees
Root cause:
- Structure/placement kinds were checked with scattered string literals across modules.
- Legacy bake migration (`schemaVersion:1`) used unchecked `as unknown as` casting instead of explicit validation.

Detection signal:
- Review feedback flagged repeated `segment.kind === "..."` patterns and weakly typed branching.
- Parser accepted structure via broad casting paths that bypassed compile-time and runtime checks.

Preventive checklist:
- Export shared discriminant constants + type guards from promoted modules and reuse them everywhere.
- Prefer exhaustive/switch or guard-based branching over ad-hoc string comparisons for union types.
- Do not use `as unknown as` for persisted schema migration; parse and validate legacy payload fields explicitly.

## 2026-02-08 - Shared editor controls still leaked into GAME mode
Root cause:
- `editor-game-ecs` initially mixed editor and gameplay controls in one always-visible HUD.
- Mode switches updated systems/rendering but did not strictly separate UI ownership by mode.

Detection signal:
- User reported editor-mode parity goals were unmet and game mode still showed editor-oriented controls.

Preventive checklist:
- Use promoted editor control builders (`@common/level-editor`) for editor mode only.
- Enforce explicit HUD visibility boundaries on mode switch (hide editor panel in GAME, show game-only controls).
- Keep mode-specific hint/status copy in sync with visible controls to avoid mixed affordances.

## 2026-02-08 - Diagonal movement could slip through wall segment endpoints
Root cause:
- Edge collision checks used only a single fixed row/column per axis pass.
- During diagonal movement, crossing a boundary near a node could evaluate the wrong adjacent segment index and miss a block.

Detection signal:
- User reported wall collisions still failing despite edge-based blocking.

Preventive checklist:
- When checking boundary crossings, evaluate candidate adjacent indices around the interpolated crossing point (`±eps`) instead of one floored index.
- Keep collision checks diagonal-aware for both X and Y boundary tests.

## 2026-02-08 - Promoted module coverage gate failed after adding new shared file
Root cause:
- Added `packages/common-level-editor/src/editor-controls.ts` without corresponding unit tests.
- `test:promoted` enforces global coverage thresholds, so one uncovered promoted file dropped the whole package below required levels.

Detection signal:
- CI failed at `pnpm test:promoted` with coverage threshold errors for `@common/level-editor`.

Preventive checklist:
- Any new file in promoted packages must ship with tests in the same commit.
- Run `pnpm test:promoted` locally before pushing promoted-module changes.
