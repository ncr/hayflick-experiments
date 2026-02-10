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

## 2026-02-09 - 2:1 staircase drift appeared in rendered output despite projection tests passing
Root cause:
- `pixel-perfect-2to1` rendered scene geometry to a high-resolution target and then sampled down to low resolution.
- The downsample pick introduced boundary sampling artifacts on cube top-face edges, so rendered staircases deviated from strict interior 2:1 stepping.

Detection signal:
- Projection/math tests passed, but screenshot-based rendered-frame analysis found interior staircase step violations.
- User-visible artifacts were strongest on top surfaces of 1x1x1 cubes.

Preventive checklist:
- For strict pixel-perfect geometry validation, render scene directly at fixed low resolution and scale up with nearest filtering.
- Keep at least one rendered-frame Playwright test (not only projection-space tests) for staircase invariants.
- Validate cube top-edge staircases separately from axis-line tests because face boundaries are where sampling artifacts appear first.

## 2026-02-08 - Boundary-index collision checks can still miss wall crossings
Root cause:
- Movement collision relied on boundary-index stepping; rare paths still bypassed walls when index selection didn’t match the crossed segment.

Detection signal:
- User reported player could pass through walls consistently despite edge-based blocking.

Preventive checklist:
- Keep boundary stepping, but add a swept segment-vs-blocked-edge intersection safety check before applying movement.
- Treat any swept intersection as a hard bump and skip transform update for that frame.

## 2026-02-08 - Isometric movement felt wrong when intent was world-axis
Root cause:
- A new isometric experiment used `createPlayerInputSystem` directly, which maps intent to fixed world axes.
- Camera view was angled, so W/A/S/D did not match screen-relative expectations.

Detection signal:
- User reported movement direction on screen did not match pressed WASD direction.

Preventive checklist:
- In isometric/camera-angled modes, map player intent through camera forward/right projected to the ground plane.
- Reuse the same camera-relative input helper across experiments to avoid per-experiment drift.
- Manually verify W/Up means “screen up” before shipping movement changes.

## 2026-02-08 - Legacy compatibility paths added unnecessary churn during rapid prototyping
Root cause:
- Added schema migration/legacy parsing paths for evolving editor bake formats while product requirements favored fast iteration on a single current schema.

Detection signal:
- User explicitly requested removing migrations/legacy accommodation because the project is intentionally in rapid flux.

Preventive checklist:
- Default promoted editor/game modules to strict current-schema parsing unless migration is explicitly requested.
- Avoid carrying legacy schema branches in experiments during active prototyping.
- Keep save/bake contracts simple and version-gated to the current format only.

## 2026-02-08 - Wall physics felt tile-wide because colliders were derived from blocked cells
Root cause:
- Physics collider generation used baked `blockedCells` (tile adjacency) for wall collisions.
- This produced full-tile colliders instead of thin edge-aligned wall volumes.

Detection signal:
- User reported walls still behaved as occupied floor tiles and collisions did not match visible wall segments.

Preventive checklist:
- Derive wall/window physics colliders from structure edge segments, not blocked-cell adjacency.
- Keep door colliders independent and toggle-able so opening doors actually creates a passable aperture.
- Validate collider dimensions (`w` or `h` thin) in bake tests for wall segments.

## 2026-02-08 - Promoted physics package lacked coverage gates for branch-heavy edge cases
Root cause:
- `@common/physics-rapier` had only a small happy-path test set and no package-level coverage thresholds.
- Branches around fixed-step clamping, missing body/collider guards, and explicit body/collider controls were untested.

Detection signal:
- Coverage report showed low branch coverage (~40%) in `packages/common-physics-rapier/src/index.ts`.
- Repeated movement/collision regressions appeared while iterating on editor-game integration.

Preventive checklist:
- Keep `vitest.config.ts` coverage thresholds in every promoted package, including newly promoted modules.
- Add tests for guard/edge branches (dead entities, missing transforms/colliders, invalid handles, large `dt` clamping), not only movement happy paths.
- Add regression assertions for collider shape/orientation in `@common/level-editor` bake tests.

## 2026-02-09 - Unpushed changes after edits
Root cause:
- Changes were made without committing/pushing after completion.

Detection signal:
- User asked if changes were pushed and `git status` showed uncommitted edits.

Preventive checklist:
- After any code change, commit and push unless the user explicitly says not to.
- Check `git status -sb` to confirm a clean working tree before reporting completion.

## 2026-02-09 - Local Playwright `preview` runs can validate stale experiment bundles
Root cause:
- `playwright.config.ts` starts `pnpm --filter @apps/hub preview` without an automatic rebuild.
- Local e2e checks can target outdated artifacts unless a fresh build exists.

Detection signal:
- Newly added route/canvas assertions failed under local `preview` but passed immediately against live `dev` server using current source.

Preventive checklist:
- For local e2e verification after source edits, prefer running against a live `pnpm --filter @apps/hub dev --host 127.0.0.1 --port 4173 --strictPort` server.
- If using `preview`, run a fresh build first so tests consume current code.

## 2026-02-09 - Pixel-stable pan needs subpixel compensation, not only camera snapping
Root cause:
- `editor-game-ecs` applied pan directly to camera target and relied on world snapping.
- Without retaining subpixel drag remainder in screen space, panning produced visible jump/shimmer compared to `pixel-perfect-2to1`.

Detection signal:
- User reported that panning in `pixel-perfect-2to1` was stable but `editor-game-ecs` shimmered and jumped.

Preventive checklist:
- For pixel-perfect pan, convert drag/wheel deltas into whole low-res pixel camera steps and keep leftover as CSS canvas translation remainder.
- Preserve remainder across resize by normalizing with render scale.
- Reuse the same pan model across experiments that claim fixed-grid pixel stability.

## 2026-02-09 - Double-quantizing camera pan caused phase-dependent shimmer
Root cause:
- `editor-game-ecs` quantized pan once in `applyPanByPixels`, then snapped camera target again in `setCameraPose`.
- CSS pan transform also used fractional pixel translation, allowing subpixel sampling blur on the upscaled canvas.

Detection signal:
- User reported pixel stability still depended on pan position after initial compensation pass.
- `pixel-perfect-2to1` remained stable under the same interaction, indicating implementation mismatch.

Preventive checklist:
- Quantize pan exactly once: either input-step quantization or camera pose snap, not both.
- Keep CSS translation integer-valued for pixel-art canvases.
- When matching behavior across experiments, compare full pan pipeline (camera math + DOM transform), not only world coordinates.

## 2026-02-09 - Pixel-stable pan also requires exact screen-axis world vectors and integer centering
Root cause:
- `editor-game-ecs` pan used ground-plane forward/right approximation, not exact camera screen-axis world vectors.
- Canvas centering used `left:50%/top:50%` with `translate(-50%,-50%)`, which can introduce fractional anchor offsets.

Detection signal:
- User still saw shimmer after initial compensation and double-quantization fixes.
- Stability matched only after mirroring `pixel-perfect-2to1` axis math and integer CSS positioning.

Preventive checklist:
- Derive pan world vectors from camera right/up with orthographic frustum-per-pixel units (`screenRightWorld`, `screenDownWorld`).
- Keep canvas anchor integer in CSS (`left/top` from floored offsets), then apply integer pan translation.
- For parity bugs, copy the known-good math path verbatim before optimizing.

## 2026-02-09 - Decorative stripe meshes on walls produced depth fighting artifacts
Root cause:
- Wall/door/join stripes were separate thin box meshes positioned nearly coplanar with base surfaces.
- Small camera/pixel phase shifts caused z-fighting shimmer in the promoted wall kit.

Detection signal:
- User reported dark wall stripes looked unstable and suspected z-fighting.
- Visual artifacts were strongest during pan/zoom despite otherwise stable pixel rendering.

Preventive checklist:
- Render decorative bands procedurally in the same material shader as the base mesh when possible.
- Align stripe start/end to explicit pixel-grid boundaries (for this project: 16 px/m vertical).
- Avoid overlapping coplanar detail meshes for large repeated surfaces.

## 2026-02-09 - Toon shader hook mismatch caused procedural stripe to silently disappear
Root cause:
- Stripe injection patched `#include <output_fragment>`, but `MeshToonMaterial` in this Three.js version uses `#include <opaque_fragment>`.
- The replace no-op left walls fully unmodified (uniforms existed, stripe logic never executed).

Detection signal:
- User reported walls stayed plain gray after shader migration.
- Local test with `ShaderLib.toon.fragmentShader` confirmed missing `output_fragment` include.

Preventive checklist:
- Validate chunk hook names against `THREE.ShaderLib.toon` for the pinned Three.js version before patching.
- Add a unit test that executes `onBeforeCompile` with Toon-like shader strings and asserts the expected hook replacement.

## 2026-02-09 - PBR stripe shader compile failed when uniforms were injected inside `main`
Root cause:
- While porting stripes to `MeshStandardMaterial`, `uniform` and `varying` declarations were inserted at the `#include <opaque_fragment>` site.
- That chunk expands inside `main`, so declarations were invalid GLSL and structure meshes stopped rendering.

Detection signal:
- User reported walls disappeared entirely after PBR migration.
- Render behavior matched shader compile failure symptoms (missing only affected meshes).

Preventive checklist:
- Declare GLSL uniforms/varyings in fragment/vertex `#include <common>` blocks only.
- Restrict `#include <opaque_fragment>` patches to executable statements.
- Keep a unit test that runs `onBeforeCompile` with both `#include <common>` and `#include <opaque_fragment>` placeholders.

## 2026-02-09 - Wall junction z-fighting from overlapping perpendicular segment tops
Root cause:
- Horizontal and vertical wall segments both extended fully to shared nodes, so their top faces overlapped in corner/T/X junction centers.
- Join-post meshes were added on top, increasing overlap noise in those junctions.

Detection signal:
- User reported visible flicker/z-fighting at corners and T-junctions despite stable camera/pixel pipeline.

Preventive checklist:
- Trim segment endpoints at nodes that get non-straight join posts (corner/T/X), then fill the center with a single join-post mesh.
- Treat straight-through degree-2 nodes separately (no post, no trim) to avoid gaps.
- Keep shared trim behavior in promoted mesh kit and reuse it from all experiments.

## 2026-02-09 - Endpoint trimming removed z-fighting but introduced visible wall gaps
Root cause:
- Uniform endpoint trimming relied on a minimal center post to close seams.
- At some camera angles/material settings, those seams remained visible as gaps between segments.

Detection signal:
- User reported z-fighting unchanged and clearly visible segment gaps after trim rollout.

Preventive checklist:
- Prefer explicit junction-cap meshes (corner/T/X) selected from node neighbor masks over trim-only seam fixes.
- Keep straight degree-2 junctions uncapped to avoid unnecessary geometry.
- Implement junction logic in promoted mesh kit and consume it consistently in all editor experiments.

## 2026-02-09 - Multi-mesh junction arms still left coplanar overlap noise
Root cause:
- Building corner/T/X caps from multiple overlapping arm meshes kept coplanar top-face contact zones.
- Even when grouped logically as one cap object, it was still several meshes with shared planes.

Detection signal:
- User explicitly requested \"single mesh for corner/t/x\" after residual junction flicker persisted.

Preventive checklist:
- Generate true single-mesh cap geometries (one `BufferGeometry` per junction type) and rotate by mask, rather than assembling from multiple meshes.
- Keep segment endpoint trims aligned to cap arm reach so caps fill seams without overlap.

## 2026-02-09 - Junction cap reach math must account for center half-thickness
Root cause:
- Junction cap shapes were authored as `center block + arm extension`, but extension used full half-tile reach directly.
- Effective arm length became `halfThickness + reach`, overshooting intended tile-midpoint boundaries and causing visible seam mismatch.

Detection signal:
- User reported junction meshes did not terminate at tile boundaries and some corners looked incorrect.

Preventive checklist:
- When arms are modeled from a center square, compute extension as `targetReach - halfThickness`.
- Keep one explicit constant for target centerline reach (half tile) and derive polygon coordinates from it.

## 2026-02-09 - Junction mask rotation signs were inverted for ±90° cases
Root cause:
- Corner/T mask decoding used the wrong yaw sign for 90-degree rotations, mirroring some junction shapes into incorrect quadrants.
- This produced apparent corner gaps/overlaps even when mesh extents were otherwise correct.

Detection signal:
- User screenshot still showed incorrect corners after reach fix; affected nodes matched rotated mask cases.

Preventive checklist:
- Add explicit orientation tests for representative corner and tee masks (NE, ES, WN, etc.).
- Keep a documented base orientation and derive all rotated variants against that reference.

## 2026-02-09 - Junction seams persisted from cap styling and door-driven joins
Root cause:
- Junction caps were rendered with different material/height than wall segments, making node seams read as gaps/fighting.
- Door segments were included in wall junction adjacency, creating unnecessary wall join caps at door endpoints.

Detection signal:
- User screenshots showed repeated corner/T-junction seam artifacts even after mask rotation fixes.
- Artifacts clustered around join nodes and door-adjacent intersections.

Preventive checklist:
- Keep wall join caps flush to wall height and use wall material unless a deliberate style break is required.
- Build wall junction adjacency from solid wall/window segments only; exclude doors from wall join topology.
- Add/keep mesh-kit tests for join cap orientation plus flush-height invariants.

## 2026-02-09 - Exact edge-to-edge junction math can still show raster cracks
Root cause:
- Segment trims and junction arm reach matched exactly at half-tile boundaries with zero overlap.
- In low-resolution upscaled rendering, independent meshes with exact butt-joins can reveal subpixel cracks.

Detection signal:
- User reported systematic tiny gaps between junction meshes and neighboring wall segments after z-fighting fixes.

Preventive checklist:
- Use a tiny junction arm reach overlap epsilon (millimeter-scale) for seam closure.
- Pair overlap with a tiny cap height bias so overlap does not reintroduce coplanar z-fighting.
- Keep a mesh test that asserts corner cap reach is at least half-tile.

## 2026-02-09 - Pixel-art seam closure needs overlap sized to render pixel, not tiny metric epsilon
Root cause:
- Initial seam overlap was sub-centimeter, smaller than one rendered "big pixel" in the fixed low-res pipeline.
- Cracks remained visible because the overlap did not survive quantized rasterization.

Detection signal:
- User still saw L-corner/tee gaps after z-fighting was fixed and tiny overlap was added.

Preventive checklist:
- Derive seam overlap from pixel density constants (`worldUnit / pixelsPerUnitX`) instead of arbitrary tiny epsilons.
- Keep overlap explicit in comments/tests so it stays tied to pixel-scale rendering assumptions.

## 2026-02-10 - Vertical segment trim sides were inverted by +90° rotation
Root cause:
- Wall/window/door segment meshes are authored along local +X, then vertical edges were rotated by +90° around Y.
- That rotation maps local +X toward world -Z, so `trimStart`/`trimEnd` semantics flipped on vertical edges.
- Join logic trimmed the wrong half of many vertical segments, producing large visible gaps.

Detection signal:
- User reported gaps were large (not subpixel/raster-phase) and most apparent around L corners.

Preventive checklist:
- When rotating authored geometry, verify local axis direction after rotation before applying directional trims.
- For vertical edges in current setup, swap trimStart/trimEnd (and trim amounts) before creating the segment mesh.
- Add an orientation-focused mesh regression test when trim logic depends on edge direction.

## 2026-02-10 - Junction dimensions must match full segment replacement contract
Root cause:
- Junction meshes were built as midpoint caps (arm reach 0.5 tile), while product expectation was full replacement of incident wall segments.
- This mismatch made junction meshes appear short and produced large perceived gaps.

Detection signal:
- User requirement: X junction top footprint must be exactly 256x256 cm (2x2 tiles at 128 cm/tile).
- Visual reports consistently described "meshes too short" rather than micro seam artifacts.

Preventive checklist:
- Keep promoted junction mesh reach aligned to the authoring contract (full-tile arms for replacement meshes).
- Add explicit geometry tests for required junction footprint sizes (e.g. cross = 2.56m x 2.56m).
- Ensure experiment renderers do not draw overlapping legacy segments for edges owned by replacement junction meshes.

## 2026-02-10 - Low zoom levels shimmered in editor-game-ecs despite integer canvas scale
Root cause:
- Camera yaw still used per-frame interpolation, so camera basis drifted through subpixel phases even when zoom scale and pan steps were integer-snapped.
- `pixel-perfect-2to1` uses fixed quarter-turn yaw, so the mismatch caused extra phase instability in `editor-game-ecs`.

Detection signal:
- User reported visible shimmer specifically at low screen scales (`3x`, `2x`, `1x`) while high scales looked stable.
- Instability persisted after decoupling zoom from viewport size, pointing to camera phase rather than canvas resize math.

Preventive checklist:
- For experiments claiming pixel-stable rendering, keep quarter-turn yaw discrete (no smoothing interpolation).
- Snap camera target to integer low-resolution pixel coordinates in camera screen-space basis each frame.
- When comparing stability across experiments, audit the full camera phase path (yaw update + target snap), not only canvas scaling.
