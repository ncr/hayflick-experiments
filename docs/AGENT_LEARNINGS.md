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

## 2026-02-10 - Canvas remainder translation can cause global ±1 px wobble at all zoom levels
Root cause:
- `editor-game-ecs` used CSS canvas translation to show sub-step pan remainder while also stepping camera on integer low-res pixels.
- The DOM transform remainder introduced screen-space phase shifts, perceived as whole big-pixel translation jitter.

Detection signal:
- User reported stable sizing but whole-image wobble by about one screen pixel across zoom levels, most visible at low scales.
- Artifact remained after yaw/target snapping fixes, isolating the issue to canvas transform phase.

Preventive checklist:
- For strict pixel-lock mode, keep canvas transform fixed at integer zero and use remainder only as an accumulator for next camera pixel step.
- Avoid mixing camera pixel stepping with non-zero DOM transform in the same render path.
- Validate by observing static geometry while panning slowly: no whole-frame ±1 px jumps should be visible.

## 2026-02-10 - Pixel-perfect-2to1 wobble came from fractional anchoring and unsnapped camera-phase accumulation
Root cause:
- Canvas centering via flex layout could place the upscaled canvas on fractional pixel anchors.
- Repeated world-space camera target updates accumulated tiny floating-point drift without explicit screen-space pixel snapping.

Detection signal:
- User observed persistent ±1 screen-pixel whole-image wobble across zoom levels.
- Wobble remained visible even when panning in single-screen-pixel increments.

Preventive checklist:
- Anchor upscaled canvas with integer `left/top` offsets instead of flex centering for pixel-lock renderers.
- Snap camera target to integer low-resolution screen-space coordinates each frame.
- Keep pan transform integer-rounded and preserve pan remainder normalization when scale changes.

## 2026-02-10 - Rounded CSS pan remainder caused early 1px phase jumps during subpixel pointer deltas
Root cause:
- `pixel-perfect-2to1` mixed floating pointer deltas with `Math.round` canvas translation.
- Rounding allowed the displayed offset to jump before a full screen pixel of drag had actually accumulated.
- The offset was applied as DOM transform, adding compositor-phase instability on top of raster content.

Detection signal:
- User reported persistent ±1 screen-pixel wobble while panning at all zoom levels.
- New pan-phase unit test reproduced legacy early jumps with repeated `0.25px` raw deltas.

Preventive checklist:
- Quantize pointer deltas through an explicit carry accumulator (`Math.trunc`), so movement advances only on whole screen pixels.
- Keep pan remainder integer-valued and bounded by `renderScale`.
- Apply remainder shift in final WebGL viewport, not via CSS canvas transforms.

## 2026-02-10 - Viewport Y-origin mismatch inverted vertical subpixel pan direction
Root cause:
- Pan remainder is in screen coordinates (Y increases downward), but `WebGLRenderer.setViewport` uses bottom-origin Y.
- Applying `pad + remainderY` made subpixel vertical remainder move opposite to camera-step pan, causing zigzag/jump behavior.

Detection signal:
- User reported vertical pan moved in the wrong direction until a whole big-pixel camera step occurred, then jumped back.

Preventive checklist:
- When mapping screen-space offsets into WebGL viewport offsets, invert Y (`viewportY = pad - remainderY`).
- Keep a code comment near viewport setup documenting the coordinate-system conversion.

## 2026-02-10 - Fractional DPR introduces unavoidable 1/2 physical-pixel cadence for 1 CSS-pixel drags
Root cause:
- Pointer events are in CSS pixels, while final raster stability is determined in physical device pixels.
- At fractional DPR (for example `1.25`, `1.5`), each 1 CSS-pixel drag corresponds to non-integer physical movement (`1.25`, `1.5` px).
- Any pixel-locked renderer must quantize to integer physical pixels, producing a cadence like `1,1,1,2` or `1,2,1,2`.

Detection signal:
- Browser frame-diff measurement showed exact pure translations each frame (score `0`) but mixed shift magnitudes at fractional DPR.
- Example measured counts for repeated 1 CSS-pixel drags: DPR `1.25` -> `{1px: 18, 2px: 6}`, DPR `1.5` -> `{1px: 12, 2px: 12}`.

Preventive checklist:
- For pixel-lock claims, define whether "screen pixel" means CSS pixel or physical device pixel and implement quantization in that space consistently.
- Validate with frame-diff tests at DPR `1`, `1.25`, `1.5`, and `2` before concluding wobble is fixed.
- If uniform per-frame pan speed is required, constrain runtime to integer DPR (or browser zoom levels yielding integer DPR).

## 2026-02-10 - Fractional-DPR tuning needs explicit mode controls to compare tradeoffs in one build
Root cause:
- Native-DPR pixel lock and integer-effective-DPR override optimize different goals (pointer-speed fidelity vs strict physical-pixel cadence).
- Without an in-scene switch, regressions were hard to compare and discuss because each commit changed multiple assumptions.

Detection signal:
- User requested trying both approaches side-by-side in the same experiment.

Preventive checklist:
- Add runtime toggles for DPR mode and zoom quantization mode when investigating pixel-phase issues.
- Surface active/native DPR, effective zoom, and ladder values in a HUD so behavior can be interpreted quickly.
- Keep mode helpers unit-tested (`safe ladder` computation and stepping).

## 2026-02-10 - Override DPR mode can accidentally change pan speed if input deltas use active DPR
Root cause:
- Pan input conversion multiplied pointer CSS deltas by active rendering DPR instead of native browser DPR.
- In override mode this scaled movement away from pointer distance (faster/slower pan).

Detection signal:
- User reported panning felt faster than mouse movement in override mode while native mode felt correct.

Preventive checklist:
- Convert pointer deltas to device space using native `window.devicePixelRatio`, not rendering override DPR.
- Keep render quantization DPR and input conversion DPR as separate variables with explicit names.
- Include mode-specific manual checks for pointer-distance parity after DPR mode changes.

## 2026-02-10 - \"Fluid zoom\" can be misread as continuous target levels instead of animated discrete levels
Root cause:
- Wheel zoom was switched to continuous exponential target updates, which introduced non-level intermediate targets.
- Product intent was to keep discrete zoom steps but animate transitions between those steps.

Detection signal:
- User explicitly reported that smooth zoom should not add unsafe/non-level zoom targets.

Preventive checklist:
- Confirm whether \"fluid\" means interpolation between fixed levels or truly continuous target values.
- Keep wheel target levels discrete unless the user explicitly requests continuous zoom levels.
- Preserve cursor-anchored interpolation while stepping targets by ladder/integer rules.

## 2026-02-10 - Headless Playwright canvas readback can be blank for WebGL in pixel-perfect experiment
Root cause:
- In Chromium headless runs for `pixel-perfect-2to1`, reading WebGL output via `drawImage(canvas, ...)` from the live canvas produced transparent/blank samples.
- Regression probes that depended on canvas readback silently measured empty frames and returned misleading perfect scores.

Detection signal:
- Probe stats showed impossible zero-error translations at search boundaries and grayscale signatures with a single value.
- Direct sampling returned `[0,0,0,0]` from canvas readback while `.stage-host` screenshots clearly contained rendered scene pixels.

Preventive checklist:
- For WebGL frame-analysis e2e checks in this repo, use Playwright screenshot bytes (`.stage-host`) as the image source, not live canvas readback.
- Validate probe input once per new test by checking grayscale min/max or unique count before trusting shift/error metrics.
- Keep analysis crop centered on scene content to reduce HUD/static-overlay interference.

## 2026-02-10 - Cursor-anchor zoom tests must use pixel-grid quantization bounds
Root cause:
- `pixel-perfect-2to1` intentionally snaps camera target to integer low-resolution pixels each frame.
- Cursor-anchored zoom cannot guarantee sub-pixel-perfect CSS alignment after snapping, especially at high zoom and fractional DPR.

Detection signal:
- Strict fixed threshold (`<= 1.25 CSS px`) failed in high zoom scenarios while measured drift matched half low-res pixel size (`renderScale / nativeDpr * 0.5`).

Preventive checklist:
- For cursor-anchor assertions in this experiment, derive tolerance from current quantization cell size:
  - `toleranceCss >= 0.5 * (renderScale / nativeDpr) + small_margin`
- Keep anchor checks across multiple zoom levels, including higher zoom where quantization is most visible.

## 2026-02-10 - High-zoom cursor-anchor drift came from using full-canvas coordinates instead of render viewport coordinates
Root cause:
- `pixel-perfect-2to1` maps pointer client coordinates through an oversized/clipped canvas.
- Zoom anchor and world projection used full canvas rect math, but the actual image is drawn into a sub-viewport (`pad + remainder`, `outputWidth/outputHeight`).
- At higher zoom this coordinate mismatch grows and breaks cursor-anchor zoom; it also makes pan feel inconsistent relative to pointer.

Detection signal:
- At higher zoom levels, measured cursor-anchor drift increased sharply while pan phase math remained internally consistent.
- Direct probe showed pan distance mismatch in projected world/client space despite expected device-pixel deltas.

Preventive checklist:
- For pointer/world transforms, convert via the active render viewport rectangle, not the full canvas rect.
- Include high-zoom interaction probes for both native and override DPR modes.
- Keep debug helpers/tests using the same viewport mapping path as runtime input handling.

## 2026-02-10 - Animated zoom anchor correction must stop after transition or it pollutes pan deltas
Root cause:
- Cursor-anchor correction was kept active after zoom animation settled.
- Ongoing correction continued to call pan updates every frame, which inflated measured drag distance and destabilized pan-cadence checks.

Detection signal:
- Pan-parity test reported large device-pixel drift (orders of magnitude above expected ±1) right after zooming.
- Cadence assertions became flaky under parallel Playwright workers.

Preventive checklist:
- Run anchor correction only while zoom animation is active (or for a bounded number of frames), then disable it.
- Disable anchor correction immediately when manual drag starts.
- In e2e, wait for animated zoom settle with a bounded tolerance that remains stable under worker scheduling jitter.

## 2026-02-10 - Wheel bursts must be gated while zoom animation is active
Root cause:
- Touchpad/wheel gestures emit multiple wheel events per gesture.
- Without gating, each event can advance zoom target, causing multi-level jumps and poor control.

Detection signal:
- User reported one scroll gesture jumped multiple zoom levels and animation felt wrong.

Preventive checklist:
- Ignore wheel zoom events while a zoom animation is already active.
- Treat one gesture burst as one level step, then require a new post-animation gesture for the next step.
- Use time-based zoom animation duration (fixed ms), not frame-factor lerp, for predictable feel.

## 2026-02-10 - DPR-only input conversion breaks pan parity when canvas CSS size diverges from backing-store size
Root cause:
- Pointer deltas and cursor/world projection used `window.devicePixelRatio` directly.
- In fractional DPR + responsive layout paths, actual input scale is `canvas.width / rect.width` (and height), not always exactly native DPR.
- This caused subtle over/under-travel and anchor drift from coordinate-space mismatch.

Detection signal:
- User reported drag distance felt faster/slower than cursor at some zooms, with persistent 1px wobble.
- A forced CSS/backing-store mismatch repro (`canvas.style.width/height` scaled) showed pan parity drift under DPR-only conversion.

Preventive checklist:
- Convert all pointer/client coordinates with per-axis canvas ratios from `getBoundingClientRect()` (`cssToDeviceX/Y`), not only `window.devicePixelRatio`.
- Keep pan input conversion and world/client projection on the same canvas-ratio math path.
- Maintain an e2e regression that intentionally desynchronizes CSS size vs backing-store size and checks pan-device parity.

## 2026-02-10 - Animated zoom correction kept causing secondary pan drift and clumsy zoom behavior
Root cause:
- Smooth zoom interpolation required repeated anchor correction while scale changed.
- That correction path interacted with pan quantization and made post-zoom drag feel inconsistent.

Detection signal:
- User reported zoom felt clumsy and pan mismatch persisted after prior fixes, especially after zooming.

Preventive checklist:
- For strict pixel-step zoom UX, keep zoom transitions discrete and immediate.
- Apply cursor-anchor correction once at the final zoom level instead of continuously over animation frames.
- Keep wheel handling deterministic: one safe zoom step per accepted wheel event.

## 2026-02-10 - Continuous camera re-snapping can reintroduce visible phase movement
Root cause:
- Re-snapping camera target every render frame adds a second quantization pass on top of integer pan stepping.
- Tiny floating variance around snap boundaries can look like extra movement/wobble.

Detection signal:
- User still perceived wobble/pan inconsistency even after input-space fixes.

Preventive checklist:
- Avoid per-frame camera target snapping when pan already advances in explicit integer screen-pixel steps.
- Keep camera basis updates separate from quantization logic.
- Validate both cursor-anchor and drag-parity at higher zoom levels after camera-phase changes.

## 2026-02-10 - Pan carry residue bled across gestures and inflated drag distance
Root cause:
- Fractional pan carry (`panPhase.carryX/Y`) persisted across pointer/wheel gesture boundaries.
- After zoom-anchor correction and prior drags, the next drag inherited residual carry and could quantize one device pixel ahead (`x + n` feel), especially at higher zoom.

Detection signal:
- User reported drag distance overshooting cursor movement after zooming.
- High-zoom probe showed world-projected drag mismatch patterns that disappeared when carry was reset per gesture.

Preventive checklist:
- Reset pan carry at drag start/end and before/after wheel zoom-anchor correction.
- Keep pan parity assertions strict in e2e (`expected pan-device parity` exact match) so carry bleed regressions fail fast.
- Re-check both drag parity and cursor-anchor behavior after any pan/zoom math change.

## 2026-02-10 - Viewport-fit baseline made zoom floor misleading and blocked true 1x small-pixel mode
Root cause:
- `renderScale` multiplied user zoom by a viewport-derived `fitScale`.
- On larger viewports, even `zoom=1` still produced large upscaled pixels because `fitScale` stayed above `1`.
- With safe-ladder enabled on fractional native DPR, lowest allowed user zoom could also start above `1` (for example `5` at DPR `1.2`).

Detection signal:
- User reported native mode could not go below `5` and override `zoom=1` still looked too large.

Preventive checklist:
- Keep viewport-fit scaling separate from zoom scaling when users expect `zoom=1` to mean minimal pixel size.
- Default to `free` zoom mode when low-zoom access is required; keep safe-ladder as an explicit opt-in.
- Validate zoom floor behavior on large desktop viewports and fractional DPR.

## 2026-02-10 - High zoom broke at level 17 due to WebGL backing-size limits
Root cause:
- The experiment enlarges the canvas backing store as `renderScale` increases (`width ~= 482 * renderScale`).
- On GPUs reporting `MAX_VIEWPORT_DIMS/MAX_TEXTURE_SIZE/MAX_RENDERBUFFER_SIZE = 8192`, scale `17` exceeds the safe backing budget.
- Once backing dimensions are over the GL limit, viewport/clipping behavior causes both cursor-anchor zoom jumps and pan distance mismatch.

Detection signal:
- User reported both pan and zoom-anchor regressions beginning exactly at free-mode zoom `17`.
- Runtime probe showed `maxViewport` `8192x8192`, matching the first failing scale boundary.

Preventive checklist:
- Compute max allowed user zoom from runtime GL caps and clamp wheel zoom to that value.
- Keep safe-ladder levels bounded by the same dynamic max.
- Expose max zoom/render-scale limits in HUD/debug state so cross-device boundaries are visible during QA.

## 2026-02-10 - Canvas-resize-on-zoom created UX mismatch despite correct camera math
Root cause:
- Zoom path resized the canvas element (CSS and backing dimensions) with each zoom step.
- Even with stable pan/anchor math, users perceived this as the viewport itself scaling instead of scene zoom.

Detection signal:
- User explicitly reported visible canvas size changes during zoom and requested a fixed-size canvas that always covers available area.

Preventive checklist:
- Keep canvas CSS size locked to mount/viewport dimensions during zoom interactions.
- Apply zoom by changing internal render viewport scale/placement, not canvas element size.
- Add an interaction regression check that canvas bounding box remains unchanged across zoom in/out.

## 2026-02-10 - Fixed-size canvas needs a cover baseline so zoom=1 does not letterbox
Root cause:
- After decoupling zoom from canvas size, render scale at `zoom=1` could be too small for taller/narrower mounts.
- This left visible bars around the rendered viewport even though canvas sizing was stable.

Detection signal:
- User reported `zoom=1` showed non-scene background areas and asked for viewport coverage of full canvas area.

Preventive checklist:
- Derive a `zoomBaseScale` from viewport coverage (`ceil(max(widthRatio, heightRatio))`) before applying user zoom.
- Keep canvas fixed, but center/crop an internal render viewport to satisfy cover behavior.
- Re-run zoom-anchor and pan-parity tests after changing baseline scale math.

## 2026-02-10 - Stage sizing should fit container bounds, not viewport heuristics
Root cause:
- `.stage-ratio` width used a viewport-height formula (`100vh - 11rem`) instead of the actual `.stage-shell` dimensions.
- This can underfill available space when shell/header/sidebar geometry differs from the heuristic.

Detection signal:
- User requested the stage canvas to occupy as much of the stage shell as possible while preserving stage ratio.

Preventive checklist:
- Use container-based sizing for ratio wrappers (e.g. `cqw/cqh` with `container-type: size`) when fitting inside dynamic layout regions.
- Keep a fallback for browsers without container query units.
- Verify fitted box uses either full shell height or full shell width (whichever is the active constraint) while preserving target aspect ratio.

## 2026-02-10 - Rendered-frame e2e sampling broke after switching to dynamic low-resolution targets
Root cause:
- `pixel-perfect-rendered-staircase` mapped low-res pixels to screenshots using hardcoded `480/270` + fixed pad/scale assumptions.
- Runtime now derives low-res target and viewport placement from current canvas/device size, so fixed mapping no longer matched actual samples.

Detection signal:
- `e2e/pixel-perfect-rendered-staircase.spec.ts` failed with "not enough matched rows" after dynamic-resolution refactor while interaction tests stayed green.

Preventive checklist:
- In WebGL screenshot probes, derive sample mapping from runtime render metrics (`lowRender*`, `renderScale`, `renderBase`, pan remainder), not fixed constants.
- Keep debug-state exposure aligned with runtime viewport math so tests can transform low-res coordinates reliably.
- Re-run rendered-frame probes whenever render target sizing or viewport placement logic changes.

## 2026-02-10 - Dynamic low-res sizing can accidentally turn zoom into "pixel size only"
Root cause:
- After switching to dynamic low-resolution targets, zoom updated render scale but orthographic frustum height stayed fixed.
- Result: scene composition remained constant while only big-pixel size changed.

Detection signal:
- User reported zoom in/out changed pixel size but did not move camera framing closer/farther.

Preventive checklist:
- When zoom semantics mean "get closer/farther", apply zoom to camera projection (orthographic frustum or perspective FOV), not only render target scale.
- Keep pan basis (`screenUnitRight/Down`) derived from actual camera frustum to stay in sync after zoom changes.
- Re-run cursor-anchor and pan-parity interaction tests after zoom pipeline refactors.

## 2026-02-10 - Pan-remainder viewport shifts can expose 1px edge bars on fixed-size canvas
Root cause:
- Remainder pan was applied by shifting final output viewport.
- Without guard-band coverage, small positive shifts could reveal clear-color strips at canvas edges.

Detection signal:
- User reported intermittent 1px black bars on canvas edges during zoom/pan.

Preventive checklist:
- Keep low-res scene projection unchanged; add overscan in the upscale/output pass instead.
- Use clamped UV remap so overscan area repeats edge texels instead of stretching geometry.
- Keep pointer/world mapping anchored to the scene-content sub-viewport (excluding overscan pad).

## 2026-02-10 - Dynamic resolution can break the 32:16 world-to-pixel scale contract at zoom 1
Root cause:
- Orthographic frustum height was tied only to zoom, not to dynamic low-res target height.
- When low-res dimensions changed with viewport/device scale, pixels-per-world-unit drifted from the baseline contract.

Detection signal:
- User reported the base mapping (`128cm -> 32px horizontal`, `128cm -> 16px vertical`) no longer held.

Preventive checklist:
- Keep a fixed reference low-res height for baseline scale calibration (here `270`), and scale frustum by `lowRenderHeight / referenceHeight`.
- Apply zoom on top of that calibration so zoom 1 preserves the base contract.
- Re-run rendered and interaction pixel-perfect tests after camera projection changes.

## 2026-02-10 - Tying low-res render grid to zoom causes cross-zoom re-quantization
Root cause:
- Low-resolution target dimensions were recomputed from `viewport / renderScale`, so each zoom level used a different low-res sampling grid.
- Even with pixel snapping, edges landed on different low-res pixels across zoom levels, changing staircase/contour quantization.

Detection signal:
- User reported that zooming changed which pixels were lit (different edge quantization), not just magnification/composition.

Preventive checklist:
- Keep low-res target dimensions derived from viewport + DPR baseline only (zoom-independent).
- Apply zoom by scaling/cropping the upscaled output viewport, not by rebuilding the low-res sampling grid.
- Preserve world-to-low-res contract via projection calibration against a fixed reference height.

## 2026-02-10 - Rendered staircase probes must normalize zoom when viewport-crop zoom is active
Root cause:
- With zoom implemented as output scaling/cropping, default startup zoom can place some probe sample points off-screen.
- Staircase e2e assumptions built around full-scene visibility failed when run at higher default zoom.

Detection signal:
- `pixel-perfect-rendered-staircase` reported missing sample colors or zero matched rows on one edge while interaction tests remained green.

Preventive checklist:
- Normalize test zoom to a known baseline (for example `zoom=1`) before pixel-sampling assertions.
- For edge probes, require at least one reliably detected boundary path rather than a single hardcoded visible edge.
- Keep probe camera/projection math synchronized with runtime projection calibration rules.

## 2026-02-10 - Checkerboard floor seams came from overlapping internal side faces
Root cause:
- Floor was built from many thin `BoxGeometry` tiles.
- Adjacent tiles created coplanar internal side faces that could z-fight and appear as dark seam/spot artifacts.

Detection signal:
- User reported dark floor seams/holes even after zoom/pixel stability was fixed.

Preventive checklist:
- For flat tile floors, render only top surfaces (plane tiles or merged top mesh), not stacked box sides.
- Keep floor slightly below gameplay object bottoms to avoid coplanar overlap (`y` offset epsilon).
- Recheck seam artifacts after any floor geometry/material changes.

## 2026-02-10 - Stable-grid zoom model required explicit superseded-learning tags
Root cause:
- `pixel-perfect-2to1` moved to a zoom-independent low-res sampling grid + output viewport scale/crop model.
- Override DPR mode was removed, but older learnings still described prior mode-dependent behavior.

Detection signal:
- Onboarding and review discussions referenced contradictory learnings for zoom behavior and mode controls.

Preventive checklist:
- Keep old learnings for audit trail, but mark outdated entries explicitly as superseded.
- Maintain a concise "current model" reference (`docs/PIXEL_PERFECT_FOUNDATION.md`) for active invariants.
- Superseded entries in this transition:
  - `2026-02-10 - Fractional-DPR tuning needs explicit mode controls to compare tradeoffs in one build` (historical investigation note; mode toggles removed).
  - `2026-02-10 - Override DPR mode can accidentally change pan speed if input deltas use active DPR` (historical; override mode removed).
  - `2026-02-10 - Fixed-size canvas needs a cover baseline so zoom=1 does not letterbox` (superseded by stable low-res grid + output overscan/crop model).
  - `2026-02-10 - Dynamic low-res sizing can accidentally turn zoom into "pixel size only"` (superseded by zoom semantics that preserve world-to-game-pixel mapping).

## 2026-02-10 - Wheel burst throttling can violate expected one-wheel-one-step zoom behavior
Root cause:
- A wheel burst lock ignored subsequent wheel events for a quiet-window interval.
- After pan/anchor correctness stabilized, this guard no longer provided value and instead hid valid user input.

Detection signal:
- User explicitly requested that each wheel action should apply immediately without burst suppression.

Preventive checklist:
- Default to direct one-event-one-step wheel handling for deterministic zoom controls.
- If throttling is reintroduced, gate it behind an explicit mode and test expected per-event zoom cadence.
- Keep cursor-anchor tests active when changing wheel handling to avoid pan/zoom regressions.

## 2026-02-10 - Pixel-stage host glue drifted when kept inside experiment files
Root cause:
- Renderer/canvas mount styling, resize observation, and WebGL cap querying were implemented inline in `pixel-perfect-2to1`.
- The same host concerns are needed by other experiments, so keeping them local increases copy/paste drift risk.

Detection signal:
- Refactor work required moving repeated host lifecycle code (mount styles, canvas metrics, cap detection) before controller extraction could stay clean.

Preventive checklist:
- Keep stage-host lifecycle in shared `@common/render` utilities (`PixelStage`) instead of per-experiment setup.
- Let experiments own only scene/camera behavior and controller wiring, not mount/canvas boilerplate.
- Preserve cleanup symmetry (style restoration + observer disconnect + renderer disposal) in one shared place.

## 2026-02-10 - Rotated pixel-stable camera needs grid re-snap and bounded zoom-anchor correction
Root cause:
- With animated quarter-turn rotations, camera orientation changed continuously but camera target was not re-snapped to the active screen-pixel grid.
- During rapid zoom-out, cursor-anchor correction could apply very large pan deltas in a single frame, briefly pushing the viewport into empty/black composition.

Detection signal:
- User reported post-rotation panning no longer matched viewport movement, non-default orientations lost pixel stability, and fast zoom-out occasionally flashed black frames.

Preventive checklist:
- After screen-basis updates (especially during/after rotation), snap camera target to the current screen-pixel lattice.
- Keep panning basis refreshed before applying drag/key pan deltas when rotation is animated.
- Bound per-frame cursor-anchor correction and disable anchor correction when error magnitude becomes implausibly large.

## 2026-02-10 - Do not snap camera target to pixel grid while rotation is still animating
Root cause:
- Camera-target snapping was applied every frame in a continuously rotating basis (`animatedYawTurns`), which re-quantized target coordinates as the basis changed.
- This caused accumulated drift, extreme pan behavior in non-default orientations, and occasional scene loss (black viewport) after rotate/pan sequences.

Detection signal:
- User reported that panning in non-default rotations made the scene "fly away", and rotating after panning could immediately show a black screen.

Preventive checklist:
- Only apply target snap-to-grid when rotation has settled to a stable quarter-turn target (within epsilon).
- During active rotation, update pan basis but skip positional re-quantization.
- Disable zoom-anchor correction when starting a rotation input to avoid competing camera corrections.

## 2026-02-10 - Rotated pan must use ground-plane basis, not camera up/right basis
Root cause:
- Pan world-step vectors were derived from camera right/up axes and frustum units.
- Camera up includes a vertical component at isometric pitch, so drag deltas could move `cameraTarget.y` away from the ground plane.
- In rotated views this produced runaway composition shifts ("scene flies away") and occasional black framing after rotate+pan sequences.

Detection signal:
- User reported non-default rotation panning sent the scene off-screen and rotating after a prior pan could immediately lose scene framing.
- Rotated-pan parity tests passed in device-pixel accounting, but projected scene motion was inconsistent with expected bounded viewport translation.

Preventive checklist:
- Derive `screenRightWorld`/`screenDownWorld` from ray intersections on the gameplay plane (center/right/down one-low-res-pixel probes), not camera up/right vectors.
- Keep camera target constrained to ground-plane motion (`y = 0`) in top-down/isometric pan models.
- Snap to pixel grid in that same ground-plane basis only after rotation settles.
- Keep a rotated-pan e2e regression (quarter-turn + drag) to validate both pan parity and bounded projected motion.

## 2026-02-10 - Conditional basis refresh can freeze pan/zoom mapping after rotation
Root cause:
- Screen-to-world pan basis refresh was gated by an incremental yaw-change check.
- In practice the cached-basis path could remain active while camera orientation kept updating, leaving pan/zoom math locked to an old orientation.
- That produced "axes swapped" panning and cursor-anchor zoom jumps in non-default quarter-turn views.

Detection signal:
- User reported horizontal drag became vertical-ish after rotation and zoom around cursor jumped in rotated views.
- Probe showed camera orientation vectors changed, but pan basis vectors stayed identical to default orientation.

Preventive checklist:
- Recompute screen basis from current camera pose each frame in interaction-heavy modes (ray-based basis is cheap and deterministic).
- Avoid relying on NaN-sensitive or threshold-only cache invalidation for camera-basis updates.
- Keep rotated-view zoom-anchor and pan-axis e2e checks active (all quarter-turn orientations).

## 2026-02-10 - Rapid wheel bursts can destabilize anchor if zoom targets update mid-animation
Root cause:
- Every wheel event updated zoom target immediately while an earlier zoom animation and anchor-correction pass were still in flight.
- In rapid zoom-out bursts, anchor state could be re-based between partially settled frames, producing visible jumpy motion.

Detection signal:
- User reported zoom-out jumps only when scrolling quickly.
- Stress probe (dense wheel events) showed transient anchor drift spikes, while single-step zoom remained stable.

Preventive checklist:
- Queue wheel zoom requests and apply one zoom step only when the current zoom animation has settled.
- Keep anchor correction active through settle and only deactivate after residual cursor error is small.
- Use separate epsilons for rotation settle vs zoom settle (zoom can tolerate a looser threshold for responsiveness).

## 2026-02-10 - Queueing wheel steps fixes jump but regresses responsiveness
Root cause:
- Serializing wheel input into a per-step queue removed anchor jumps, but forced users to wait through animations for all intermediate zoom levels during fast scroll gestures.
- This conflicted with expected zoom UX where rapid wheel input should reach the latest target quickly.

Detection signal:
- User reported that fast zoom-out required waiting for every intermediate animation ("queuing is bad").
- Interaction remained stable but felt laggy compared to direct wheel control.

Preventive checklist:
- Do not hard-queue all wheel steps for zoom UX; accept immediate target updates during bursts.
- Keep anchor stable across a short wheel burst window, and use a faster zoom animation rate while burst input is active.
- Maintain burst-stability checks and responsiveness checks together, so fixes do not trade one failure mode for the other.
- Supersedes part of prior entry `2026-02-10 - Rapid wheel bursts can destabilize anchor if zoom targets update mid-animation`:
  - The strict "queue wheel zoom requests" recommendation is historical and should not be used as the default UX policy.

## 2026-02-10 - Camera-frustum zoom broke fixed world-to-game-pixel contract
Root cause:
- In `pixel-perfect-camera-zoom`, zoom changed orthographic height (`orthoHeight / cameraZoom`), which changed how many low-res game pixels represented one world unit.
- This violated the invariant that a 128cm world segment projects to 32x16 game pixels.

Detection signal:
- User reported world units looked too large in game-pixel terms as zoom changed.
- Camera-zoom probe confirmed contract drift across zoom levels when frustum height was animated.

Preventive checklist:
- Keep contract-sensitive projection (`orthoHeight`) fixed when zoom semantics should preserve world-to-game-pixel mapping.
- Apply experiment zoom through output display scaling/cropping instead of frustum scaling when contract invariance is required.
- Keep an automated contract assertion in e2e that verifies 1 world-unit projects to 32x16 game pixels across zoom scenarios.

## 2026-02-10 - Fixed viewport zoom requires projection zoom, not output-viewport scaling
Root cause:
- In `pixel-perfect-camera-zoom`, applying zoom by increasing output display scale made the render viewport visibly grow during zoom.
- This conflicted with the expected UX where viewport/canvas size stays fixed and only scene composition zooms.

Detection signal:
- User reported zoom-in made the render viewport larger on screen.

Preventive checklist:
- For fixed viewport/canvas UX, keep output viewport scale constant and apply zoom via camera projection/frustum.
- Keep world-to-game-pixel contract assertions scoped to the calibrated baseline zoom in camera-zoom experiments.
- Validate both interaction semantics together after zoom changes: viewport-size stability and cursor-anchor behavior.

## 2026-02-10 - Projection-only zoom keeps viewport fixed but can make pixel size feel static
Root cause:
- `pixel-perfect-camera-zoom` used orthographic-frustum zoom with a fixed output scale.
- That zoomed scene composition, but big-pixel size did not increase, which looked like contract breakage from UX perspective.

Detection signal:
- User reported that zoom changed scene size while pixel size stayed too small at the same zoom level.

Preventive checklist:
- For fixed-viewport zoom that should also enlarge visible big pixels, apply zoom in the output sample mapping (crop/stretch) instead of only camera projection.
- Keep world-to-low-res projection contract fixed and include zoom factor in screen mapping helpers (`worldAtClient`/`projectWorldToClient`).
- Validate with interaction checks that viewport size is stable while pixel size increases as zoom increases.

## 2026-02-10 - Camera-zoom prototype needed explicit minimum zoom floor at baseline
Root cause:
- Camera-zoom experiment allowed `cameraZoomTarget < 1`, which conflicted with expected baseline contract behavior and UX.

Detection signal:
- User requested to prevent zooming out below `1x`.

Preventive checklist:
- Clamp prototype camera zoom floor to explicit baseline minimum (`1x`) when contract assumes baseline as lower bound.
- Keep wheel zoom clamping co-located with zoom target updates so behavior is deterministic.

## 2026-02-10 - Output-zoom prototypes need pan-step compensation to keep drag parity
Root cause:
- In `pixel-perfect-camera-zoom`, output-sample zoom magnified screen movement from each camera pan step.
- Pan step conversion remained calibrated for unzoomed output, so high zoom caused drag overshoot (`x + n`).

Detection signal:
- User reported panning moved farther than cursor at larger zoom levels.

Preventive checklist:
- Scale camera pan-step world displacement by inverse zoom (`1 / cameraZoom`) when output zoom is active.
- Keep pointer/world mapping functions aligned with the same zoom transform used in the output shader.
- Add high-zoom pan parity e2e checks (drag shift error bound) to catch regressions.

## 2026-02-10 - Fractional output zoom causes pixel-phase drift during zoom animation
Root cause:
- `pixel-perfect-camera-zoom` sampled the fixed low-res target with a continuous (`float`) zoom factor.
- Non-lattice zoom factors made big-pixel boundaries land on different device-pixel phases during zoom, causing visible instability.

Detection signal:
- User reported phase changes/flicker while zooming in despite correct pan distance and base contract.

Preventive checklist:
- Quantize output zoom to a render-scale lattice where effective big-pixel size in device pixels stays integral.
- Use the same quantized zoom value in shader sampling, pointer-to-world mapping, world projection, and pan compensation.
- Keep high-zoom interaction probes active while changing zoom animation behavior.

## 2026-02-10 - Even quantized zoom can show phase transitions if animation traverses intermediate levels
Root cause:
- `pixel-perfect-camera-zoom` used a quantized stable zoom for sampling, but animated `cameraZoomCurrent` still walked through intermediate levels frame-by-frame.
- This produced visible per-frame phase changes during wheel zoom.

Detection signal:
- User reported phase transitions remained, but reduced, after first quantization pass.

Preventive checklist:
- For strict pixel-phase stability, apply zoom as immediate step changes on the quantized lattice (no tween across intermediate zoom levels).
- Keep zoom animation disabled or separately gated in modes that require hard pixel-grid invariants.
- Verify visually at higher zoom while scrolling continuously, not only single-step zoom tests.

## 2026-02-10 - Nearest filter alone is insufficient for stable output-zoom sampling
Root cause:
- Output zoom used continuous UV transforms and relied on `NearestFilter` only.
- Without explicit texel-center snapping, UV boundary drift still produced visible phase transitions while zooming.

Detection signal:
- User still observed phase transitions after quantized zoom steps were introduced.

Preventive checklist:
- In shader-based output zoom, snap sample UVs to source texel centers (`floor(uv * size) + 0.5`).
- Keep source texture dimensions available as uniforms and clamp UV to valid texel domain before snapping.
- Validate zoom visual stability manually in addition to interaction math tests.

## 2026-02-10 - Repeated anchor correction around wheel zoom can cause 1-pixel pan toggling
Root cause:
- Anchor correction was applied both immediately on wheel event and again in render frames while zoom state was settling.
- With quantized zoom steps, this produced alternating one-pixel corrections between two nearby pan states.

Detection signal:
- User reported zooming remained stable but viewport jumped between two pan positions about one big pixel apart.

Preventive checklist:
- Do not run pre-zoom anchor correction on wheel events; apply correction after zoom state is updated.
- Limit anchor correction to a single post-zoom pass when zoom interpolation is disabled.
- Keep settle criteria independent from wheel burst flags for no-animation zoom modes.

## 2026-02-10 - Pre-wheel anchor correction also destabilizes `pixel-perfect-2to1`
Root cause:
- `pixel-perfect-2to1` applied immediate `applyZoomAnchorCorrection(2)` inside `handleWheel` before render-loop correction.
- This duplicated correction timing and can introduce one-pixel anchor/pan toggling around zoom steps.

Detection signal:
- After fixing the camera-zoom experiment, user asked to remove equivalent pre-correction from `pixel-perfect-2to1`.

Preventive checklist:
- Keep zoom-anchor correction only in render/update loop where camera + projection state is final for the frame.
- Avoid wheel-handler correction passes that run before frame state is fully updated.
- Validate with rapid wheel anchor tests and visual spot-check for single-pixel flip-flop.

## 2026-02-10 - Re-anchoring cursor each wheel event in a burst creates unintended zoom+pan coupling
Root cause:
- `pixel-perfect-2to1` updated `zoomAnchorClient` on every wheel event, including during an active burst.
- If pointer moved while scrolling, anchor target shifted mid-burst and correction behaved like extra pan.

Detection signal:
- User reported moving mouse while zooming caused viewport panning instead of pure zoom.

Preventive checklist:
- Lock zoom anchor client position at burst start and keep it fixed until burst ends.
- Update anchor world/client only when starting a new wheel burst.
- Validate with manual interaction: scroll continuously while moving mouse; viewport should only zoom.

## 2026-02-10 - Cursor-anchor zoom requires shared pivot math between shader sampling and world mapping
Root cause:
- `pixel-perfect-camera-zoom` moved output zoom pivot into shader space, but `worldAtClient`/`projectWorldToClient` still assumed center-pivot zoom.
- Anchor correction and debug projection then solved against a different transform than the actual rendered image.

Detection signal:
- User reported point under cursor moved while zooming.
- New e2e anchor test in camera-zoom route failed with large cursor drift.

Preventive checklist:
- Keep one canonical zoom pivot (`scene UV`) and use it in shader sampling, client->world mapping, and world->client projection.
- For wheel bursts, lock cursor anchor once per burst and derive pivot from that fixed client point.
- Maintain a camera-zoom e2e that checks fixed-cursor anchor drift during repeated zoom-in steps.

## 2026-02-10 - Center-pivot correction is lossy for cursor-pivot output zoom
Root cause:
- `pixel-perfect-camera-zoom` tried to preserve cursor anchor via pan correction while output zoom/pivot lived in shader space.
- Mapping and correction worked in different transform spaces, so zoom still appeared to pan away from cursor.

Detection signal:
- User repeatedly reported under-cursor point drifting during zoom even after pan/correction tweaks.
- A dedicated fixed-cursor zoom e2e failed with large x/y drift.

Preventive checklist:
- In shader-pivot zoom models, solve pivot directly from locked anchor world+scene points per zoom step.
- Keep one transform chain for shader sampling and debug/client mapping; avoid mixing with corrective pan loops.
- Maintain a fixed-cursor multi-step zoom e2e assertion for anchor drift.

## 2026-02-10 - Cursor-anchored output zoom is most stable with per-event pivot sampling
Root cause:
- Mixed strategies (center-pivot plus pan correction / world-anchor solve) introduced residual drift and visible zoom-pan coupling.
- Quantized pan/correction paths cannot perfectly recover anchor in all zoom steps.

Detection signal:
- User still observed screen panning away during zoom even after multiple correction passes.

Preventive checklist:
- For shader-based output zoom, derive pivot directly from current cursor scene UV on each wheel event.
- Use that same pivot in shader sampling and in client/world mapping helpers.
- Prefer pivot-driven zoom over correction-by-pan when strict cursor lock is required.

## 2026-02-10 - Integer wheel steps and smooth zoom animation should be decoupled
Root cause:
- Switching to integer wheel steps initially forced immediate zoom updates, which removed transition animation.
- Re-quantizing animated zoom each frame also makes transitions feel stepped.

Detection signal:
- User requested integer zoom increments and animated transitions at the same time.

Preventive checklist:
- Keep integer zoom targets (`+/-1` per wheel event), but animate current zoom toward target with `easeToward`.
- Reuse established rates/epsilon from the stable experiment (`14`, `42`, `0.02`) for consistent interaction feel.
- Avoid per-frame target quantization on the animated zoom value when smooth visual interpolation is required.

## 2026-02-10 - Mixed zoom anchor systems caused double-vision jitter
Root cause:
- `pixel-perfect-camera-zoom` applied shader pivot zoom and a separate world-anchor pan correction loop at the same time.
- The two correction paths fought each other during animated zoom steps and produced visible jitter/ghosting.

Detection signal:
- User reported "double vision" and jumpy zoom/pan behavior returning after anchor-correction changes.

Preventive checklist:
- Keep one zoom anchor mechanism per experiment path (pivot-only or pan-correction-only), never both.
- If shader pivot zoom is active, use the same pivot in client<->world mapping helpers and shader uniforms.
- Run the camera-zoom Playwright anchor + pan tests after any zoom-anchor refactor.

## 2026-02-10 - Stale wheel pivot fallback caused zoom-out pan drift after mouse reposition
Root cause:
- Wheel anchor logic could keep previous zoom pivot when cursor sample was outside the scene-output rect.
- Next zoom step then used stale pivot, which appeared as unintended pan after moving the mouse.

Detection signal:
- User reported: move mouse, then zoom out, and viewport pans away.

Preventive checklist:
- Derive zoom anchor from current wheel event coordinates, not cached pointer fallback.
- Clamp sampled scene pivot to output bounds so wheel events never reuse stale pivot state.
- Keep anchor regression checks that include cursor reposition before opposite-direction zoom.

## 2026-02-10 - Changing zoom pivot mid-zoom introduces apparent pan jump
Root cause:
- In shader-pivot zoom, switching pivot while `zoom != 1` changes the current image offset immediately, even before applying the next zoom step.
- Moving mouse before zoom-out changed pivot and produced visible pan drift/jump.

Detection signal:
- User reported: moving mouse before zooming out causes viewport pan during zoom.

Preventive checklist:
- On wheel, if pivot changes, compute world point under cursor first and apply one-shot pan compensation after pivot update.
- Keep this compensation single-pass in wheel handler (no continuous correction loop).
- Re-test both baseline contract and cursor-anchor interactions after pivot-change math updates.

## 2026-02-10 - Pivot rebase compensation must use zoom-aware pan conversion
Root cause:
- Wheel pivot-rebase correction applied `applyPanRawCss`, but normal interaction pan is zoom-aware (`1 / zoom`).
- At higher zoom this over-corrected by roughly the zoom factor, causing large apparent pan jumps when changing cursor then zooming out.

Detection signal:
- User reported moving mouse before zoom caused pan drift; probe showed >1000px anchor error after one zoom-out step.

Preventive checklist:
- Any wheel-anchor correction must use the same pan conversion path as drag pan (`applyPan`), not raw CSS pan.
- Keep a repro check that zooms in, moves cursor, then zooms out and asserts low pixel anchor drift.
- Validate both with e2e and a direct debug probe after wheel-anchor edits.

## 2026-02-10 - Clamped wheel input must be a strict no-op to avoid boundary pan jitter
Root cause:
- At zoom bounds, wheel events still updated pivot/rebase logic before discovering target zoom could not change.
- That produced small viewport pans while attempting to zoom past min/max.

Detection signal:
- User reported slight panning at max zoom when scrolling further while moving the mouse.

Preventive checklist:
- Compute clamped next zoom target first in wheel handler.
- If target is unchanged, return immediately after `preventDefault()` and skip pivot/anchor/pan correction work.
- Keep a boundary interaction check (scroll at max/min while moving cursor) after zoom-handler changes.

## 2026-02-10 - Quarter-turn rotation should preserve screen-center anchor across zoom states
Root cause:
- Rotation input changed yaw target without explicitly anchoring the world point currently at screen center.
- With output-zoom pivot not fixed at center, rotation could feel like orbiting around an offset point.

Detection signal:
- User requested rotation to stay relative to the point at the center of the screen at any zoom.

Preventive checklist:
- On rotate input, capture world point at screen center before changing yaw target.
- During rotation animation, apply per-frame pan correction to keep that anchor projected at screen center.
- Disable anchor once residual is subpixel and rotation settles.

## 2026-02-10 - Rotation anchor correction must not run outside active rotation
Root cause:
- Center-anchor correction for rotation continued beyond the actual rotation animation window.
- Persistent correction loop fought normal pan/zoom input and reintroduced jitter/double-vision symptoms.

Detection signal:
- User reported panning broke and visual ghosting returned immediately after adding rotation-center anchoring.

Preventive checklist:
- Apply rotation anchor correction only while rotation interpolation is active.
- Cancel rotation anchor state on direct pointer/wheel interaction.
- Clamp per-frame correction magnitude to avoid runaway feedback.

## 2026-02-10 - Rotation center-lock correction should be screen-space, not zoom-scaled
Root cause:
- Rotation anchor correction reused zoom-aware pan conversion (`applyPan`), which divides by current zoom.
- At zoom > 1 this under-corrected each frame and made rotation animation trajectory look unstable, even if final pose converged.

Detection signal:
- User reported rotation animation was wrong only at zoom levels above 1, while final transform ended correct.

Preventive checklist:
- Use raw CSS/device pan conversion (`applyPanRawCss`) for rotation center-lock correction.
- Reserve zoom-scaled pan (`applyPan`) for user drag/wheel-rebase flows where behavior is intentionally tied to zoom.
- Manually test Q/E rotation animation at multiple zoom levels after anchor/pan math changes.

## 2026-02-10 - Continuous rotation anchor correction can cause ghosting; prefer one-shot recenter
Root cause:
- Per-frame rotation anchor correction loop introduced feedback against quantized pan/output sampling, producing visible double-vision during rotation animation.
- Although final orientation converged, intermediate frames jittered.

Detection signal:
- User reported rotation pivot looked correct but animation showed ghosting/double vision, especially at higher zoom.

Preventive checklist:
- For quarter-turn orbit around screen center, recenter `cameraTarget` once from screen-center world point before rotation starts.
- Avoid persistent per-frame pan correction loops during rotation unless strictly necessary.
- Manually verify rotation animation quality at zoom > 1 after anchor-related changes.

## 2026-02-10 - Rotation around screen center requires centered output zoom pivot at rotate start
Root cause:
- Rotation recenter used world-at-screen-center, but retained prior cursor-derived `zoomPivotScene` from wheel zoom.
- Non-centered output pivot offsets visual rotation center, so rotation looked to pivot around a wrong point.

Detection signal:
- User reported rotation animation became smooth but pivots were still wrong.

Preventive checklist:
- When entering Q/E rotation mode, set `zoomPivotScene` to `(0.5, 0.5)` before/with target recenter.
- Recenter `cameraTarget` from current screen-center world point in the same step.
- Validate rotation pivot at zoom > 1 after any zoom-pivot behavior changes.

## 2026-02-10 - Safe promotion path for camera controls is: split legacy package first, then integrate via shared module
Root cause:
- Directly copying camera-control logic into `editor-game-ecs` caused divergence and made rollbacks/rework expensive.

Detection signal:
- User requested explicit rollback of copy-based integration and asked to extract shared library before integration.

Preventive checklist:
- First move existing render helpers to a `_legacy` package and repoint old experiment imports.
- Introduce a dedicated shared camera-control module in the new package and integrate experiments through that API.
- Validate both legacy experiments and new integration with targeted Playwright smoke tests after the split.

## 2026-02-10 - Camera zoom parity failed when only controls were promoted without the render/output pipeline
Root cause:
- Shared extraction initially promoted camera input/control state (`PixelCameraController`) but left the pixel-perfect two-pass render pipeline, output zoom shader sampling, and screen/world mapping logic inside one experiment.
- Integrations reimplemented those pieces differently, causing shimmer/phase drift and contract mismatches.

Detection signal:
- `pixel-perfect-camera-zoom` looked stable while integrations using only the control module showed phase transitions and world-to-pixel contract drift.
- Large code duplication remained in experiment files for low-target/output pass, zoom pivot math, and interaction handlers.

Preventive checklist:
- Promote the full pixel view stack as one module (stage/layout + low-res target + output pass + mapping + interaction handlers), not only controller state.
- Validate extracted module by swapping the original experiment to consume it before integrating elsewhere.
- Gate promotion with targeted camera-zoom Playwright checks for contract, anchor stability, pan parity, and fixed render resolution.

## 2026-02-10 - Editor-game smoke test assumptions broke after promoting dynamic pixel view
Root cause:
- E2E smoke test still asserted legacy fixed canvas buffer size (`480x360`) from pre-library setup.
- Promoted `PixelPerfectIsoView` sizes canvas buffer to viewport device pixels while keeping pixelated presentation.

Detection signal:
- `e2e/promoted-modules.smoke.spec.ts` failed with unexpected canvas dimensions (`width/height` no longer fixed constants).

Preventive checklist:
- Keep smoke tests aligned with promoted view invariants (pixelated output + viewport/device sizing), not old experiment-specific constants.
- After rendering pipeline promotion, rerun and update route-specific smoke expectations before concluding integration.

## 2026-02-10 - Entering editor discarded runtime-only player transform
Root cause:
- `enterEditor()` disposed `gameRuntime`, and later `enterGame()` rebuilt runtime using default spawn unless explicit player override was provided.
- The GAME->EDITOR->GAME flow from the UI did not pass a player override, so position reset.

Detection signal:
- User reported player position changed after entering EDITOR, editing, and exiting back to GAME.

Preventive checklist:
- Preserve player transform when transitioning GAME -> EDITOR and consume it on next EDITOR -> GAME unless an explicit load/save player override is present.
- Add an e2e smoke check that moves player, enters EDITOR, returns to GAME, and asserts position continuity.

## 2026-02-10 - Zoom-scaled input quantization made high-zoom pan feel locked to big-pixel steps
Root cause:
- Pan input was divided by zoom before entering pan-phase quantization.
- At high zoom, sub-1px deltas were accumulated behind truncation, so visible movement only happened in coarse jumps.

Detection signal:
- User reported at higher zoom that panning felt like the smallest movement unit was a big pixel instead of a screen pixel.

Preventive checklist:
- Keep drag input in screen-pixel units through pan-phase accumulation.
- If zoom compensation is needed, apply it to world camera-step displacement (post-quantization), not to raw input deltas.
- Re-run high-zoom pan parity tests after any pan/zoom coupling change.

## 2026-02-10 - High-zoom smooth pan requires split between screen offset and source-phase camera stepping
Root cause:
- A direct zoom-scaled camera-step approach either caused coarse pan (big-pixel increments) or phase instability.
- The same accumulator cannot satisfy both invariants: 1px screen movement and stable low-res sampling phase.

Detection signal:
- User reported either coarse high-zoom pan or phase jumping depending on which pan path was active.

Preventive checklist:
- Keep a screen-space pan remainder (device-pixel translation) for per-pixel drag responsiveness.
- Promote remainder into camera target movement only in source-phase quanta (`renderScale * zoom`).
- Ensure client/world mapping and render viewport offsets include both controller pan remainder and the screen-space remainder.
