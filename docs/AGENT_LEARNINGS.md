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
