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
- Coverage gate scripts targeted a fixed set of promoted modules, so newly promoted/shared packages could be added without being included in the coverage run.
- Added `packages/common-level-editor/src/editor-controls.ts` without corresponding unit tests.
- `test:promoted` enforces global coverage thresholds, so one uncovered promoted file dropped the whole package below required levels.

Detection signal:
- CI/review reported promoted module coverage expectation mismatch after adding a new shared file/package.
- CI failed at `pnpm test:promoted` with coverage threshold errors for `@common/level-editor`.

Preventive checklist:
- When promoting a module or adding a new shared package with coverage expectations, update the promoted coverage script in the same change.
- Run the promoted coverage command locally once after changing promoted package boundaries.
- Any new file in promoted packages must ship with tests in the same commit.
- Run `pnpm test:promoted` locally before pushing promoted-module changes.

## 2026-02-22 - Scissor pane vertical trackpad pan lost subpixel motion at max zoom
Root cause:
- `PixelPerfectIsoViewportCore.renderToRenderer()` clamped the pane-local output viewport Y origin with `Math.max(0, ...)`.
- When the overscanned pixelated output was taller than the scissor pane, that clamp pinned vertical blit offset and discarded `panDeviceRemainderY` visual motion until a full camera-step quantum accumulated.

Detection signal:
- In `pixel-perfect-scissor-lab`, horizontal two-finger pan was smooth at max zoom, but vertical pan stayed still for multiple touchpad events and then jumped by one large pixel.
- The same gesture worked correctly in `pixel-stable-moving-mesh` (non-scissor path), isolating the regression to scissor rendering.

Preventive checklist:
- Keep scissor and non-scissor viewport placement math behaviorally aligned for negative/overscan offsets.
- Do not clamp scissor viewport origins if smooth subpixel pan remainders rely on temporary overscan overflow; rely on scissor rect clipping instead.
- When changing scissor viewport math, manually verify two-finger pan smoothness on both axes at max zoom.

## 2026-02-22 - Independent scissor-lab panes kept stale keyboard focus across views
Root cause:
- In independent mode, each pane owns its own `SharedScissorStage` and each stage listens to `window` key events.
- Clicking a new pane focused that pane locally but did not clear focus on previously interacted panes, so `Q`/`E` rotations were handled by multiple stages.

Detection signal:
- After clicking multiple views in `pixel-perfect-scissor-lab`, pressing `Q` or `E` rotated all previously clicked panes instead of only the active one.

Preventive checklist:
- When multiple independent stages share global keyboard listeners, maintain one experiment-level active pane and clear focus on all others on every pane interaction.
- Treat wheel/touchpad pan as focus-acquiring interaction too, not only pointer down.
- Add a visible active-pane indicator so focus state is easy to verify during manual testing.

## 2026-02-22 - Render library-owned DOM input listeners blocked scissor unification and caused focus regressions
Root cause:
- `@common/render` mixed rendering and low-level DOM input listener ownership (`window` key handlers, canvas pointer/wheel listeners) across both `PixelPerfectIsoView` and `SharedScissorStage`.
- In multi-stage scenarios, hidden listener ownership created conflicting keyboard routing and made focus policy implicit instead of app-controlled.

Detection signal:
- Scissor lab focus/rotation bugs required experiment-level workarounds because keyboard routing happened inside render stages.
- Refactor planning showed `PixelPerfectIsoView`, `SharedScissorStage`, and `touch-gestures` split input responsibilities across multiple render classes/files.

Preventive checklist:
- Keep `@common/render` command-driven and render-only; no constructor-owned DOM input listeners.
- Put pointer/wheel/keyboard/touch binding and gesture heuristics in a dedicated input package (`@common/input`).
- Make focus ownership explicit in the caller/app layer and pass targets/commands into render objects.

## 2026-02-22 - Duplicated ISO view/core implementations caused parity drift and slowed fixes
Root cause:
- `PixelPerfectIsoView` and `PixelPerfectIsoViewportCore` duplicated nearly all camera/pan/zoom/render math with only stage/backend differences.
- Behavioral fixes (e.g. scissor viewport offset handling) landed in one path and not the other.

Detection signal:
- Scissor-only vertical pan regression fix required patching `PixelPerfectIsoViewportCore`, while standalone `PixelPerfectIsoView` had matching but separate logic.
- File inspection showed near-line-for-line duplication of animation, display layout, pan quantization, and projection paths.

Preventive checklist:
- Maintain one ISO viewport core implementation for pan/zoom/rotate/render math.
- Keep wrappers/facades thin and backend-specific (single-pane vs multi-pane scissor) without duplicating camera logic.
- Add core-level contract tests before refactors so wrapper changes can be verified against shared behavior.

## 2026-02-09 - 2:1 staircase drift appeared in rendered output despite projection tests passing
Root cause:
- `pixel-perfect-2to1` rendered scene geometry to a high-resolution target and then sampled down to low resolution.
- The downsample pick introduced boundary sampling artifacts on cube top-face edges, so rendered staircases deviated from strict interior 2:1 stepping.

Detection signal:
- Projection/math tests passed, but screenshot-based rendered-frame analysis found interior staircase step violations.
- User-visible artifacts were strongest on top surfaces of 1x1x1 cubes.

Preventive checklist:

## 2026-02-22 - Forge V2 frontend persistence silently targeted the wrong asset root
Root cause:
- Hub `/api/fs/*` proxy was hard-wired to `assets/forge`, while the new Forge V2 UI was designed to persist under `assets/forge-v2`.
- Reusing the existing FS client shape without adding a new proxy root would have written V2 metadata/artifacts into the V1 tree.

Detection signal:
- Repo inspection showed `apps/hub/plugins/api-proxy.ts` defines a single `FORGE_ROOT` and all `/api/fs/*` requests resolve against it.
- Forge V2 plan required a separate storage root (`assets/forge-v2`), making the mismatch explicit before UI persistence wiring.

Preventive checklist:
- When adding a new asset workflow root, inspect the hub proxy middleware first and confirm the filesystem base path is configurable or duplicated intentionally.
- Add a dedicated FS route/client pair (e.g. `/api/fs-v2`) rather than overloading path traversal to reach sibling roots.
- Validate the first persisted file path end-to-end (UI request path and on-disk location) before building more workflow steps.
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

## 2026-02-12 - New experiment imported config from a removed module path
Root cause:
- New experiment referenced `../pixel-perfect-2to1/config`, but that module no longer exists on current `main`.
- Package-level checks during development missed the broader workspace context where CI validates from root.

Detection signal:
- GitHub Actions `pnpm typecheck` failed with `TS2307` for missing module in `packages/experiments/src/pixel-stable-moving-mesh/index.ts`.

Preventive checklist:
- Prefer importing shared camera config from the currently active source module (`pixel-perfect-camera-zoom/config`) rather than historical experiment paths.
- Run root `pnpm typecheck` before pushing when adding new cross-file imports in experiments.

## 2026-02-12 - glTF optimization CLI failed silently with latest package in this environment
Root cause:
- `pnpm dlx @gltf-transform/cli` (latest) failed during transient dependency setup (`sharp`) and produced non-actionable output for initial invocations.

Detection signal:
- Optimization commands exited non-zero with only deprecation/setup warnings and no transform report.

Preventive checklist:
- Pin a known-working CLI version for repo tooling tasks (`@gltf-transform/cli@3.10.1` here).
- Run a quick `--version`/`inspect` sanity check before running expensive optimize commands.

## 2026-02-12 - Trackpad two-finger drag was treated as wheel zoom in shared iso view
Root cause:
- `PixelPerfectIsoView` handled all `wheel` events as zoom steps and had no trackpad-pan intent detection.
- Middle-mouse/touch pan paths existed, but two-finger touchpad scroll had no pan mapping in the promoted shared view.

Detection signal:
- User reported keyboard/mobile touch/middle-mouse bindings worked, but touchpad two-finger drag could not pan.

Preventive checklist:
- In shared camera input handlers, classify wheel intent (`trackpad pan` vs `zoom`) instead of assuming all wheels mean zoom.
- Keep `Ctrl/Cmd + wheel` (or pinch-emulated wheel) on the zoom path.
- Include touchpad two-finger pan in camera-control acceptance checks when adding new bindings.

## 2026-02-12 - GLTF prop meshes with unlit/basic materials appeared to ignore received shadows
Root cause:
- Some imported prop meshes can use `MeshBasicMaterial` (unlit), which does not render lighting/shadow reception even when `mesh.receiveShadow = true`.

Detection signal:
- User reported props visibly casting shadows but not showing incoming shadowing on their own surfaces.

Preventive checklist:
- In model-load paths, enable cast/receive at mesh level and normalize unlit/basic materials to a light-reactive material when shadow reception is required.
- Keep shadow setup centralized via a shared helper for all loaded prop roots.

## 2026-02-12 - Shadows looked absent on props due high fill/ambient and aggressive normal-bias
Root cause:
- Even with `receiveShadow` enabled, high ambient/fill light flattened contrast.
- Directional light `normalBias` was high for small props, reducing visible contact/received shadow detail.

Detection signal:
- User still perceived props as not receiving shadows after enabling receive flags.

Preventive checklist:
- When tuning shadow readability, balance light angle plus ambient/fill intensity; avoid over-flattening indirect light.
- Keep directional `normalBias` conservative for small-scale scenes and re-check prop shadow reception visually.

## 2026-02-12 - Shadow tweaks can appear ineffective when orbit update overrides static light position
Root cause:
- Initial directional light position was changed, but render-loop orbit logic still wrote a different Y each frame.
- Player used a custom unlit-ish shader path that did not participate in Three.js shadow receiving, so `receiveShadow` had no visible effect.

Detection signal:
- User reported no visible change after light-height updates, and player mesh still looked unaffected by shadows.

Preventive checklist:
- When changing animated light placement, update both init-time and per-frame orbit values.
- For meshes that must receive scene shadows, use shadow-compatible lit materials (or explicitly integrate Three shadow chunks in custom shaders).

## 2026-02-12 - Prop receive-shadow flags were insufficient without material normalization
Root cause:
- Imported props came in with mixed material models; mesh-level `receiveShadow` alone did not produce reliable visible reception across all imported material types/settings.

Detection signal:
- User confirmed player mesh received shadows while prop meshes still appeared not to.

Preventive checklist:
- For imported props that must reliably receive shadows, normalize materials to a shadow-compatible lit path (`MeshStandardMaterial`) at load time.
- Preserve core texture channels during normalization and cap emissive contribution so received shadows remain visible.

## 2026-02-12 - Blanket conversion of imported prop materials can destroy intended PBR lighting response
Root cause:
- Converting all loaded prop materials to a generic `MeshStandardMaterial` removed model-specific PBR tuning (and could flatten reflections/lighting behavior).

Detection signal:
- User reported prop materials looked much worse and no longer reacted to light like the original PBR assets.

Preventive checklist:
- Preserve original lit/PBR materials by default; only convert explicitly unlit materials (`MeshBasicMaterial`) when shadow reception is required.
- Make shadow fixes additive (`receiveShadow`, `shadowSide`, `needsUpdate`) before replacing asset materials.

## 2026-02-12 - Optimized GLB props missing normal attributes prevented reliable PBR shadow response
Root cause:
- Optimized prop assets (`chair`, `lab device`, `planter`, `chest`) only contained `POSITION` and `TEXCOORD_0` attributes, with no `NORMAL` attribute.
- Without normals, PBR materials cannot react correctly to directional lighting/shadowing.

Detection signal:
- User observed player mesh receiving shadows while prop PBR assets did not.
- `gltf-transform inspect` for all four assets showed no `NORMAL` attribute.

Preventive checklist:
- Validate imported/optimized GLBs include `NORMAL` for lit rendering paths.
- In runtime loaders, generate normals (`computeVertexNormals`) when missing before enabling shadowed PBR rendering.

## 2026-02-12 - Daylight readability improved by simplifying to hemisphere + orbiting directional sun
Root cause:
- Layering several low-intensity fill/rim lights with dark background made the scene feel underlit and visually muddy.

Detection signal:
- User requested “normal noon in summer” lighting and reported the scene was too dark.

Preventive checklist:
- For simple daylight looks, start with a hemisphere sky/ground light and one directional sun (shadow caster), then tune exposure.
- Keep orbiting behavior on the sun only when shadow motion is needed, and avoid stacking extra lights unless required.

## 2026-02-13 - Q then E rotation could drift by 1px and showed a final-frame snap
Root cause:
- Rotation always re-centered camera target from a raycasted screen-center world point, even when zoom pivot was already centered, introducing avoidable floating-point drift.
- Render used a rounded viewport origin while client/world mapping paths could use a different unshared origin path, allowing 1px phase mismatch.
- Yaw snap epsilon (`1e-3` turns) allowed a visible last-frame jump when snapping to exact quarter-turn.

Detection signal:
- User observed checkerboard seams intermittently appearing/disappearing after `Q`/`E` with no pan/zoom, and a visible jump at rotation completion.

Preventive checklist:
- Only recenter target on rotate when zoom pivot is actually off-center.
- Use one shared quantized render-origin helper for render viewport and all coordinate mapping helpers.
- Keep rotation snap epsilon tight enough that terminal snapping is subpixel-invisible.

## 2026-02-13 - Rotation end could still feel harsh even after final snap smoothing
Root cause:
- A single fixed-rate yaw approach stayed too aggressive close to target, so velocity dropped too abruptly when entering the final settle window.

Detection signal:
- User reported end-of-rotation still looked harsh despite a short final snap animation.

Preventive checklist:
- Use a staged yaw rate profile: fast pickup, explicit pre-snap deceleration band, then short settle.
- Keep tuning constants (`decel start/end`, `fast/slow multipliers`, `settle duration`) centralized for quick feel iteration.

## 2026-02-16 - Tripo size hint controls were ineffective for model generation
Root cause:
- Forge exposed per-prop height/width hint inputs, but Tripo `image_to_model` does not provide explicit numeric size parameters for deterministic dimensions.
- The implementation relied on prompt guidance, which is non-deterministic and was not reliably honored.

Detection signal:
- User reported generated models did not follow configured height hints.

Preventive checklist:
- Before adding deterministic sizing controls, verify the provider API supports explicit numeric dimension fields.
- If sizing is prompt-only guidance, do not present it as a controllable setting in core workflows.
- Validate new generation controls with at least one end-to-end behavior check before exposing in UI.

## 2026-02-16 - Undo/redo dropped valid falsy snapshots
Root cause:
- History controller used `if (!next)` to detect empty stack entries.
- This treated valid falsy snapshots (e.g. `0`) as missing values and returned `null` on undo/redo.

Detection signal:
- `packages/experiments/src/settlement-builder-ecs/history.test.ts` failed with `expected null to be +0` during undo flow.

Preventive checklist:
- For stack pop checks, compare against `undefined` explicitly (`next === undefined`) instead of truthiness.
- Include at least one unit test with falsy but valid snapshot values when implementing generic history/state stacks.

## 2026-02-16 - Prop ghost preview disappeared after rotate hotkey until mouse moved
Root cause:
- Ghost visibility/elevation redraw was coupled to `pointermove` (`updateHover`), while `KeyR` rebuilt ghost visuals but did not force a hover recompute.

Detection signal:
- Pressing `R` in `settlement-builder-ecs` made the pending prop preview disappear until the next mouse movement event.

Preventive checklist:
- Any editor action that mutates ghost visuals (rotate, async template swap, selection change) must trigger a hover refresh from last known pointer position.
- Cache last pointer client coordinates so hotkey-driven updates can reproject hover state without requiring user movement.

## 2026-02-16 - Grid-only prop placement blocked precise stacking workflows
Root cause:
- Prop placement logic always snapped to cell centers (`worldToCell -> cell center`) for both ghost preview and committed placement.
- Save schema stored only `cellX/cellY`, so sub-cell placement could not be represented.

Detection signal:
- User reported inability to orient/place props precisely and asked to disable snapping for prop placement.

Preventive checklist:
- For editor props, persist sub-cell placement offsets alongside grid-cell ownership.
- Keep placement preview and final placement path sharing the same placement-target resolver (snap on/off aware).
- Expose snap mode clearly in UI and hotkeys so behavior is explicit.

## 2026-02-16 - Prop catalog mode could fall through to brush placement with no selection
Root cause:
- Editor action routing only executed prop placement when both `activeBuildCatalog === "prop"` and `selectedPropId` were truthy.
- In props mode with an empty selection, logic fell through to brush/terrain placement handlers.

Detection signal:
- During catalog-tab UI refactor review, the `activeBuildCatalog === "prop" && selectedPropId` condition revealed mode/selection coupling that allowed unintended fallback behavior.

Preventive checklist:
- Gate action handlers by active mode first, then handle missing selections explicitly with an early return.
- Add one editor test case for each catalog mode with an empty selection state.
- Keep catalog mode transitions and selection clearing synchronized in one function path.

## 2026-02-16 - Full render-mesh colliders made prop drop simulation too heavy
Root cause:
- Settlement drop physics used render mesh trimesh data directly for mesh collider mode and had no dedicated lightweight collider asset path.
- Forge exports did not produce a simplified collider GLB, so retrofitted props defaulted to heavy triangle counts.

Detection signal:
- User reported mesh-collider placement was too heavy and requested simplified collider meshes per prop.
- Drop/stacking workflows needed physics detail beyond box colliders without bogging Rapier.

Preventive checklist:
- Always export `processed/collider.glb` from Forge with an aggressive low-poly target (default 96 faces).
- In settlement drop simulation, default to proxy collider meshes and keep full render mesh as explicit override mode.
- Keep a retrofit script for existing `assets/forge/props/*` so older props get collider GLBs too.

## 2026-02-16 - Optional render-collider toggle still allowed pathological editor slowdown
Root cause:
- Even after introducing proxy collider assets, the editor still exposed a render-mesh collider mode that reran expensive trimesh drop simulation on hover.
- A single toggle could push placement preview back into high-cost Rapier workloads.

Detection signal:
- User switched to render collider mode and reported editor crawling to a near stop.

Preventive checklist:
- Keep editor placement/drop preview on proxy collider meshes only.
- Avoid exposing heavy debug/accuracy modes in primary editor UX paths unless heavily throttled.
- If a high-fidelity mode is needed, gate it behind explicit diagnostics tooling, not default build controls.

## 2026-02-16 - Proxy-collider drop simulation looked static due overly damped dynamics
Root cause:
- Drop settling used high linear/angular damping and quick settle thresholds.
- Cuboid fallback path locked rotations, preventing natural tipping off edges.

Detection signal:
- User reported editor became fast with proxy colliders but props no longer fell/rolled off supports (e.g. chair on crate edge).

Preventive checklist:
- Keep dropped-body damping low enough for visible gravity-driven tipping in preview simulations.
- Do not lock rotations in fallback dynamic paths when edge-fall behavior is required.
- Use stricter settle thresholds and enough simulation frames so unstable placements can actually collapse.

## 2026-02-16 - Edge-fall result looked wrong when drop solver ignored settled transform
Root cause:
- Drop simulation returned only elevation and discarded settled `x/z`.
- Elevation was computed as `translation.y + localMinY`, which is invalid once the body rotates during tipping/rolling.

Detection signal:
- User placed a bottle mostly off a desk edge and it still appeared to stay supported.

Preventive checklist:
- Use full settled transform from simulation (`x`, `z`, and bottom `y`) for both ghost preview and committed placement.
- For rotated trimesh bodies, compute world-space bottom from transformed vertices instead of a fixed local `minY`.
- Keep placement cell/offset derived from settled world position, not original cursor target.

## 2026-02-16 - Dynamic proxy collider body-frame offset caused erratic drop behavior
Root cause:
- The bottle dynamic collider was built from bottom-anchored mesh-space vertices, so rigid-body frame and effective collider mass distribution were offset.
- In the real-time edge-drop test this produced unstable-looking settle behavior (delayed slip, sudden fall transitions, runaway motion perception).

Detection signal:
- User reported bottle would sit on crate for several seconds, then abruptly fall, intermittently pause, and then shoot off-screen at high speed.

Preventive checklist:
- For dynamic mesh/convex colliders, recenter collider vertex clouds around bounds center before collider creation.
- Keep render root offset explicit from physics body frame (apply rotated local offset when syncing visuals).
- Increase per-body/global solver stability settings in edge-case drop tests (additional solver iterations + CCD substeps).

## 2026-02-16 - Editor drop simulation needed centered convex-hull dynamic colliders
Root cause:
- `settlement-builder-ecs` drop preview used dynamic trimesh colliders built from bottom-anchored proxy vertices.
- Dynamic body frame and collider mass distribution were offset, increasing instability and producing unreliable edge-drop behavior.

Detection signal:
- Edge-drop sandbox stabilized only after switching to centered convex-hull dynamics with root-offset compensation.
- User requested applying that fix path directly to the editor drop solver.

Preventive checklist:
- For dynamic prop drop previews, derive a centered dynamic collider dataset from proxy trimesh vertices.
- Use convex hull for the dynamic dropped body; keep trimesh colliders for static placed supports.
- Preserve editor/world placement alignment by compensating root offset when converting between body translation and stored prop root position.

## 2026-02-16 - Full settle horizon made edge placement feel unresponsive to cursor intent
Root cause:
- Drop preview simulated too long (420 steps with long stable-frame gate), letting small props continue rolling/drifting after initial landing.
- Placement result prioritized long-horizon settle over user target point, making edge placement difficult.

Detection signal:
- User reported bottle became very hard to place near an edge after stability fixes.

Preventive checklist:
- Keep editor drop preview horizon short enough to preserve placement intent.
- Clamp lateral drift from cursor target for preview/placement outputs.
- Balance physical plausibility against editability; editor tools should favor controllable intent over fully unconstrained long-run simulation.

## 2026-02-16 - Ghost drop preview physics conflicted with precise editor targeting
Root cause:
- Running full physics-based settle on every hover caused lateral drift/roll in preview, so ghost position diverged from cursor intent.
- Additional free-placement quantization in hover (`5cm`) further broke 1:1 pointer-to-pivot expectation.

Detection signal:
- User reported edge placement remained hard and explicitly requested non-physics ghost solve + proper mouse-ray pivot mapping.

Preventive checklist:
- Keep hover ghost solve deterministic and fast (height/support only) with no lateral physics drift.
- Use exact mouse raycast world X/Z for free prop placement in both preview and placement commit paths.
- If physics settle is retained for commit, preserve user-targeted pivot coordinates unless movement is explicitly desired UX.

## 2026-02-16 - Commit-time drop from very high spawn over-biased props toward floor
Root cause:
- Placement solver spawned dropped props at a fixed high Y (`~5.5m`) regardless of local support height.
- Extra potential energy amplified rolling/fall-off, causing edge placements to resolve to floor too aggressively.

Detection signal:
- User reported props placed at the edge instantly appearing on floor even when expected to remain supported.

Preventive checklist:
- For commit-time drop simulation, initialize dynamic bodies just above locally inferred support elevation.
- Tune dropped-body friction/damping for editor placement reliability, not only physical purity.
- Re-test edge-on-support and unsupported-overhang placements after any solver knob change.

## 2026-02-16 - Pre-solved commit placement removed expected post-click fall animation
Root cause:
- Prop placement committed to a physics-solved rest pose immediately at click time.
- This bypassed visible post-click motion and made edge placements appear to teleport to floor.

Detection signal:
- User reported edge placements instantly appearing on floor and requested delayed, visible physics after placement.

Preventive checklist:
- In editor UX, separate ghost/commit intent from heavy physics settle.
- Commit at cursor/ghost pose first, then run delayed physics playback for visible feedback when needed.
- Keep placement pivot anchored to direct mouse raycast coordinates at click time.

## 2026-02-16 - Editor placement needed delayed playback instead of immediate settle
Root cause:
- Placement commit used pre-solved physics rest pose, so unstable edge placements teleported to floor at click time.
- This removed expected temporal feedback of an object first being placed, then falling.

Detection signal:
- User reported edge placements still appeared instantly on ground and requested explicit 500ms delay before visible physics motion.

Preventive checklist:
- For editor UX, commit at ghost pose first and decouple post-click simulation into delayed playback.
- Keep a per-placement playback queue and update only prop transforms during playback for smooth visual feedback.
- Invalidate hover/drop caches after geometry-affecting edits so repeated clicks at the same cursor location use fresh support data.

## 2026-02-16 - Delayed drop playback lost prop rotation
Root cause:
- Drop playback samples stored only translation/elevation, and visual updates only set position.
- Physics body quaternion was never sampled/applied, so props appeared rotation-locked while falling.

Detection signal:
- User reported dropped props always kept the same orientation even when physics should rotate them.
- Playback looked like vertical translation only.

Preventive checklist:
- Any physics playback sample must include both translation and rotation (quaternion).
- Apply sampled quaternion to live scene roots each frame of playback.
- Include rotation delta in "skip playback" checks so pure-spin motion still animates.
- Keep or clear runtime rotation maps intentionally at snapshot/load boundaries to avoid stale state leaks.

## 2026-02-16 - Tilted prop playback must use root-pose Y, not collider min-Y
Root cause:
- Drop sampling wrote `placement.elevation` from collider world min-Y.
- For rolled/tilted props, collider min-Y and prop root Y diverge, so visual meshes appeared to sink below the floor.

Detection signal:
- User reported bottles looked correctly simulated but ended up slightly below floor after settling.

Preventive checklist:
- Treat editor placement elevation as prop-root world Y consistently.
- Convert between root pose and body pose via rotated local root offset for both spawn and sample paths.
- Avoid mixing collider min-Y semantics with render root transforms in delayed playback.

## 2026-02-16 - Reload should run a one-shot full-scene settle for legacy unstable props
Root cause:
- Old saved placements could retain pre-fix unsupported stacks because only newly placed props were simulated.

Detection signal:
- After reload, many existing props remained in physically implausible placements from previous experiments.

Preventive checklist:
- On startup with saved editor state, queue a one-shot world settle after relevant prop templates finish loading.
- Apply settled root poses + quaternions back into placement/runtime maps, then autosave.
- Guard the settle pass with in-flight/pending flags so it runs once and avoids re-entry.

## 2026-02-17 - Per-item playback breaks continuous multi-prop physics
Root cause:
- Editor prop drop used isolated precomputed playback per placement instead of one persistent world simulation.
- Placing a new prop introduced a new scripted track, so previously placed props were no longer governed by the same live solver step.

Detection signal:
- User reported that after placing a second prop, the first prop stopped simulating.
- Behavior looked like serialized animation clips instead of normal shared-world physics.

Preventive checklist:
- In editor mode, keep one persistent Rapier world for props and step it every frame.
- Treat each newly placed prop as a normal body with a delayed activation timestamp (e.g. 500ms), not a pre-baked trajectory.
- Sync ECS/editor placement state from live body poses each frame and autosave throttled changes from the shared simulation.

## 2026-02-17 - Uniform dynamic prop settings caused support-object drift and unstable reloads
Root cause:
- All prop kinds were simulated with the same dynamic-body tuning, so large support assets (desks/mainframes) were not anchored and accumulated solver jitter from stacked small items.
- Save payloads did not reliably persist runtime orientation/velocity state for props, so reloads reconstructed simplified poses and lost settled disorder.

Detection signal:
- User reported large support props shaking/drifting when loose props were piled on top.
- User reported reload reshaping previously chaotic piles into artificial placements.

Preventive checklist:
- Define per-prop physics profiles (at minimum `fixed` support vs `dynamic` loose) and persist profile overrides in editor save state.
- Persist prop runtime state (`rotation`, velocities, sleeping) and restore it before rebuilding editor physics bodies.
- Avoid snapping active dynamic bodies back to authored placement every frame; treat live solver pose as authoritative after activation.

## 2026-02-17 - Collider metadata precedence can silently override legacy compound data
Root cause:
- Prop parsing started reading `colliderVariants.compoundBoxes` before legacy `compoundCollider`.
- Tests and callers still assumed the legacy field was authoritative when both existed.

Detection signal:
- `prop-library.test.ts` failed after adding collider variants because parsed compound part counts changed from legacy values.

Preventive checklist:
- When introducing a new metadata contract, explicitly define precedence rules and update tests to assert that precedence.
- Keep legacy fields as fallback only and verify one mixed-payload fixture (new + legacy fields present) in parser tests.

## 2026-02-17 - Forge collider preview did not refresh after reload/model load
Root cause:
- `ProcessingRail` began depending on `modelVersion` for collider rebuild triggers, but `Forge` did not pass the prop.
- That made `refitTrigger` evaluate to `NaN`, so dependency tracking never observed subsequent model-load changes.

Detection signal:
- After browser reload, switching collider preview types showed no change until manually clicking "Rebuild Collider Variants".

Preventive checklist:
- When adding required props in intermediate panel components, update all call sites in the same change.
- Avoid trigger math that can yield `NaN`; prefer explicit defaults/guards for numeric trigger props.
- Add a UI smoke check for "reload -> select prop -> switch collider mode" without manual rebuild.

## 2026-02-17 - Vite import-analysis failed on newly added workspace dependency
Root cause:
- `@dimforge/rapier3d-compat` was declared in `packages/experiments/package.json` and present in `pnpm-lock.yaml`, but local workspace links were stale after pulling changes.
- Vite resolved `packages/experiments/src/...` directly and could not resolve the missing linked package from that workspace context.

Detection signal:
- Browser/dev-server error: `Failed to resolve import "@dimforge/rapier3d-compat"` from `packages/experiments/src/settlement-builder-ecs/index.ts` and `game-physics-3d.ts`.
- `packages/experiments/node_modules/@dimforge/rapier3d-compat` was absent before reinstall.

Preventive checklist:
- After pulling commits that modify workspace dependencies/lockfile, run `pnpm install` before starting Vite.
- Verify resolution from the importing workspace context (not only app root) when debugging unresolved imports.
- Restart Vite after dependency-link refresh to clear stale import-analysis state.

## 2026-02-17 - K-means-only compound boxes underfit non-convex furniture colliders
Root cause:
- Compound collider generation used centroid clustering + per-cluster AABBs only, which tends to produce broad overlapping boxes that fill intentional voids (e.g. desk knee space).

Detection signal:
- User reported desk-like props with two side panels were not represented by expected "top + 2 legs" box composition.

Preventive checklist:
- Use structure-aware decomposition (voxel slice/run decomposition + vertical merge) before generic k-means fallback.
- Sample triangle surfaces (not just sparse vertices) when deriving collider structure.
- Validate collider preview on at least one non-convex furniture prop after collider pipeline changes.

## 2026-02-17 - Synthesized collider/material fallbacks hid weak asset metadata quality
Root cause:
- Prop parsing intentionally synthesizes fallback collider variants and inferred material profiles.
- Without explicit validation reporting, assets with missing collider/material metadata still loaded "successfully", masking quality gaps until runtime tuning/perf issues appeared.

Detection signal:
- Physics integration work required stronger, explicit asset rules, but no immediate signal existed for props relying on fallback `bbox-fallback`/missing compound metadata/material hints.

Preventive checklist:
- Run prop-asset validation at load and report warning/error counts in editor status/HUD.
- Mark per-prop metadata warning counts in prop catalog/selection UI.
- Keep automated tests for asset validation rules (bbox validity, collider variant coverage, material/mass hint sanity).

## 2026-02-17 - Ghost preview drifted away from cursor over elevated supports
Root cause:
- Cursor world anchor came from ground-plane ray projection, while ghost was raised to support elevation without compensating X/Z for isometric parallax.
- Placement commit path used uncompensated anchor X/Z, so final spawn could diverge from user-perceived cursor intent on stacked props.

Detection signal:
- User reported ghost stayed under cursor only on empty floor, but shifted away when hovering over existing props/supports.

Preventive checklist:
- Resolve prop ghost and commit pose through one shared helper that applies camera-direction parallax compensation for nonzero elevation.
- Keep hover cache invalidation keyed by camera direction when ghost position depends on view orientation.
- Ensure click commit uses the exact same resolved pose used by ghost preview.

## 2026-02-17 - Legacy Forge physics `mass` needed explicit manual-mode migration
Root cause:
- New Forge physics settings introduced `massMode` (`auto`/`manual`), but older `meta.json` payloads only had `physics.mass`.
- Parser defaulted to `auto` when `massMode` was missing, causing saved explicit mass values to be ignored.

Detection signal:
- Unit test for legacy meta parsing expected `mass` round-trip but got auto-computed mass.

Preventive checklist:
- When adding mode fields to persisted settings, migrate legacy payloads by inferring mode from existing value presence.
- Add parser tests that include "old payload without new mode flag" fixtures.

## 2026-02-17 - Surface placement needs ray-aware pivot solve, not ground-anchor-only solve
Root cause:
- Prop ghost/placement target was anchored from ground-plane projection and then elevated/adjusted, which did not preserve cursor intent when hovering over existing prop surfaces.
- The solver lacked collision-aware fallback along the active pointer ray for occluded/overlapping placements.

Detection signal:
- User reported ghost aligned under cursor on empty floor but drifted and felt disorienting over stacked props.
- Placing over prop surfaces did not behave like "place pivot at pointed surface."

Preventive checklist:
- In prop placement mode, resolve target from nearest prop surface ray hit first (pivot-at-hit behavior).
- If initial surface target collides, slide candidate toward camera along inverse ray until clear.
- Keep hover and commit paths calling the same resolved-target helper to avoid preview/commit mismatch.

## 2026-02-17 - Prop placement preview needed explicit anchor and landing indicators
Root cause:
- Hover showed only one ghost pose, so when collision resolution shifted placement from the pointer anchor, users could not tell where they were aiming versus where placement would commit.
- Commit path still allowed unresolved colliding placements when slide-to-clear failed, creating confusing overlaps.

Detection signal:
- User reported disorienting ghost behavior around stacked props and asked for an explicit "where it will land" shadow below the ghost.

Preventive checklist:
- In prop placement mode, render both cues:
  - cursor anchor marker at ray-hit target point
  - landing footprint marker at final resolved placement contact pose
- Color-code landing footprint by state (clear / slid / blocked) to communicate solver adjustments.
- Reject commit when no clear placement exists after ray slide resolution; do not silently place intersecting props.

## 2026-02-17 - Snap-mode collision slide must still use raw pointer ray
Root cause:
- Overlap fallback direction used ray data derived from the snapped placement target (cell center), not the actual pointer world position.
- Slide step also allowed elevation drift, which made ghost relocation appear far and directionally wrong for floor placements.

Detection signal:
- User reported when placing near an existing floor prop, ghost jumped too far and not along the expected mouse ray direction.

Preventive checklist:
- Include raw pointer world position in prop placement target data even when snap-to-grid is enabled.
- Build slide ray direction from raw pointer world data, not snapped world anchors.
- Preserve elevation during overlap slide in editor placement UX to avoid vertical drift artifacts.

## 2026-02-17 - Hybrid support-height/parallax placement logic was too fragile for editor UX
Root cause:
- Placement mixed ground-projected pointer data, support-height stacking heuristics, and camera-direction compensation.
- The hybrid path created hard-to-predict hover/commit behavior under overlaps and stacked props.

Detection signal:
- Repeated user feedback that ghost placement still felt wrong across edge cases even after incremental fixes.

Preventive checklist:
- Use one deterministic placement pipeline:
  - screen ray from pointer
  - nearest support hit (prop surface or floor plane)
  - optional floor-only snap
  - local overlap resolve along inverse pointer ray
- Keep hover and commit on the exact same resolved target data model.
- Retain a landing shadow marker to communicate final resolved pose before click.

## 2026-02-17 - Side-face ray hits caused false blocked state for stack placement
Root cause:
- Prop support selection accepted the nearest prop ray hit regardless of surface normal.
- In isometric camera angles, side faces are often hit before top faces, producing mid-height support anchors and false overlap/blocking when stacking.

Detection signal:
- User reported trying to place a box on top of another showed red blocked hint, and click result diverged from ghost expectation.

Preventive checklist:
- For stackable prop placement, accept prop support hits only on sufficiently upward-facing surfaces (`normal.y` threshold).
- Fall back to floor support when no valid upward-facing prop hit is found.
- Keep support-hit filtering identical for hover and commit paths.

## 2026-02-17 - Top-surface-only filtering blocked valid stack placement
Root cause:
- Requiring strictly upward-facing ray hits for prop support caused many cursor rays to miss prop support entirely in isometric angles.
- The resolver fell back to floor support under the prop, so stacking attempts became blocked (red hint + no placement).

Detection signal:
- User reported they could no longer place a box on another box after support filtering changes.

Preventive checklist:
- Keep upward-normal preference, but add a nearest-prop fallback that derives support Y from the hit prop's top elevation.
- Never downgrade to floor support when the pointer is clearly intersecting a prop and a valid placement top can be inferred.

## 2026-02-17 - Stack placement overlap checks must ignore the chosen support prop
Root cause:
- Even with prop support detected, overlap rejection still tested against all existing props, including the support prop itself.
- Minor numerical/contact ambiguity at support surfaces could trigger blocked placement and show "no clear placement".

Detection signal:
- User reported box-on-box placement remained red/blocked despite clearly targeting a top support surface.

Preventive checklist:
- Carry support placement identity in placement targets (`supportPlacementId`, `supportTopY`).
- Resolve prop-support anchor on the support top plane, not arbitrary side-hit point.
- Exclude the chosen support placement from overlap rejection while still testing all other props.

## 2026-02-17 - Orthographic placement must be support-plane-first, not mesh-hit-first
Root cause:
- Orthographic camera depth ambiguity made mesh-hit/normal heuristics unstable for hover and commit targeting.
- The prior flow mixed multiple targeting assumptions (mesh nearest-hit, support offsets, fallbacks), causing non-deterministic ghost/hint behavior.

Detection signal:
- User requested full rewrite from first principles because ghost/hint remained disorienting and placement outcomes inconsistent.

Preventive checklist:
- Resolve placement target from screen ray against deterministic support planes (floor + prop top planes), ranked by ray distance.
- Keep support metadata explicit in placement target (`supportKind`, `supportY`, `supportPlacementId`) and use one shared resolver for hover + commit.
- In ortho, render two explicit cues:
  - projected landing shadow on support plane
  - depth/offset lines for vertical and along-plane displacement legibility.

## 2026-02-17 - Landing hint must be projected to support plane, not ghost root plane
Root cause:
- Landing indicator was rendered at ghost root elevation, visually sticking to the ghost in isometric perspective.
- This made the hint redundant and hard to read as a placement target cue.

Detection signal:
- User reported landing hint looked "stuck to the ghost" and did not help with iso placement judgment.

Preventive checklist:
- Render landing footprint at the support/contact plane (`supportTopY` or floor `y=0`), independent from ghost root elevation.
- Keep landing hint depth-tested so it reads like a surface projection rather than an overlay through geometry.

## 2026-02-18 - Concave desk collider fitting needs structure-aware decomposition
Root cause:
- Generic point-cluster box fitting produced small corner-aligned boxes and missed the intended semantic split (tabletop + side panels) for non-convex desk geometry.

Detection signal:
- `large-desk-without-drawers` generated weak compound boxes that did not represent the leg void and panel structure.

Preventive checklist:
- Keep a dedicated collider-fit experiment fixture for representative concave furniture.
- Derive top slab from per-height footprint coverage, then fit side supports separately.
- Validate new decomposition code with a synthetic desk point-cloud unit test before integrating into Forge export paths.

## 2026-02-18 - Collider decomposition tuning needs explicit numeric regression targets
Root cause:
- Manual slider tuning in the collider lab improved one fixture, but there was no durable numeric pass/fail signal to protect the behavior while iterating algorithm internals.

Detection signal:
- User provided a verified desk collider pose/size triplet and requested fast iteration with strict verification criteria.

Preventive checklist:
- Keep decomposition tests with concrete target box poses/sizes and tolerance-based assertions.
- Distinguish "auto algorithm" verification mode from manual tuning UIs to avoid hidden dependency on slider state.
- Include both structural tests (part labels/axis) and numeric near-match tests in collider-fit suites.

## 2026-02-18 - Auto desk decomposition can under-estimate tabletop thickness
Root cause:
- Top split selected strictly by high-coverage threshold produced a too-thin tabletop slab, leaving support boxes to absorb under-top volume and collapse leg clearance.

Detection signal:
- User observed leg/support boxes invading tabletop volume and removing convex leg space in collider preview.

Preventive checklist:
- Clamp automatic top split to a minimum/maximum top-thickness ratio band.
- Derive support footprints from points below a trimmed support cap (`topMinY - trim`) to avoid apron/top contamination.
- Surface top-thickness and support-sample diagnostics in the collider lab HUD for quick verification.

## 2026-02-18 - Greedy single-step split objective underfit concave shapes that need setup splits
Root cause:
- Compound decomposition accepted splits only when immediate empty-volume reduction beat box penalty.
- Some concave structures (desk-like top + two side supports) require an initial split with little or no immediate gain to unlock high-gain child splits.

Detection signal:
- Objective splitter produced either one box (no split accepted) or fragmented thin strips depending on fixture, while target near-3-box profile existed.

Preventive checklist:
- Score candidate splits with at least one-step lookahead, not immediate gain only.
- Keep explicit complexity pressure (box penalty + max box cap) so lookahead does not explode part count.
- Maintain numeric regression tests with known target collider poses/sizes to catch under/over-splitting.

## 2026-02-18 - `import.meta.glob` is not typed in `@experiments/catalog` tsconfig
Root cause:
- `packages/experiments` TypeScript config does not include Vite's `ImportMeta.glob` typing, so direct `import.meta.glob(...)` usage typechecks as missing API.

Detection signal:
- `TS2339: Property 'glob' does not exist on type 'ImportMeta'` in experiment modules.

Preventive checklist:
- In `@experiments/catalog`, prefer existing runtime loaders (`listSavedPropDefinitions` + `loadSavedPropBinary`) unless Vite glob typings are explicitly added to the package tsconfig.
- Run package typecheck immediately after introducing asset discovery changes.

## 2026-02-18 - Concave desks collapsed to convex because concave routing was too narrow
Root cause:
- Concave strategy routing only triggered for extreme concavity/cavity thresholds, so layered planar furniture (e.g. Braun desk) remained on `single-convex`.
- Existing concave voxelization was sample-driven and desk-specific, producing unstable splits on more complex desk geometry.

Detection signal:
- Braun desk collider result stayed `single-convex` despite visible leg-space concavity.
- Direct strategy probe showed concave/boxy could produce compound parts, but final selection never chose them.

Preventive checklist:
- For planar layered furniture, evaluate concave compound candidates even at moderate concavity (`planarity + layer + cavity` gating), not only extreme cavity scores.
- Use triangle-voxel occupancy + outside flood fill + greedy cuboid merge for concave furniture strategies instead of sparse sample rasterization.
- Keep fixture-specific regression tests (real GLB) asserting strategy + expected compound part count.

## 2026-02-18 - Collider-lab comparisons can silently regress when source-of-truth switches
Root cause:
- Gallery mode rendered persisted `meta.json` collider variants while prior single-prop lab view rendered live objective-fit colliders, causing visual mismatch for the same prop.

Detection signal:
- User observed desk colliders looked worse immediately after moving from single-prop view to all-props gallery.

Preventive checklist:
- In collider validation experiments, label collider source explicitly in HUD (`saved` vs `live objective`).
- Keep source selection consistent with experiment goal; for algorithm validation, default to live-fit from mesh samples.

## 2026-02-18 - Forge collider panel drifted into debug UX (separate preview mode + manual rebuild)
Root cause:
- Collider UI exposed independent "selected collider type" and "preview mode" controls plus a manual rebuild action, even though variant generation can be derived from model/processing state.
- This created a mismatch between what users thought they were choosing and what the viewport/export state showed.

Detection signal:
- User asked why collider type and preview mode both existed and why rebuilding variants was not automatic.

Preventive checklist:
- Keep collider selection as a single source of truth for both preview and exported collider type.
- Rebuild collider variants automatically on model/processing trigger changes; avoid manual rebuild actions in primary UX.
- Reserve multi-overlay/debug controls for dedicated lab/debug surfaces, not the main Forge workflow.

## 2026-02-18 - Forge collider preview drift: stale helper overlays and mode resync churn
Root cause:
- Collider helper replacement only removed the tracked helper reference; stale preview helpers could remain if state drifted, causing mismatched overlays.
- Collider panel re-synced local mode from `currentCollider` on object identity changes, creating unnecessary mode churn during rapid updates.

Detection signal:
- User observed pill preview looking wrong and a persistent large green compound overlay after scaling up/down.

Preventive checklist:
- In viewport helper swaps, clear all collider helper objects by name prefix, not only the tracked reference.
- Sync collider mode from parent on collider type changes, not every collider object mutation.
- Keep primitive collider metadata explicit (e.g. axis) so preview orientation matches generated collider intent.

## 2026-02-18 - Scene-child-only helper cleanup missed nested/stale collider previews
Root cause:
- Collider cleanup initially removed only tracked/top-level helper objects.
- Nested/legacy helper roots could survive if references drifted, leaving stale collider visuals after slider/mode updates.

Detection signal:
- User reported a large collider box remaining visible after scaling back down.

Preventive checklist:
- Tag helper roots when adding them to the scene.
- During cleanup, traverse scene nodes, resolve each helper node to its top-level scene root, and remove/dispose those roots.
- Avoid relying solely on one stored helper reference for cleanup.

## 2026-02-18 - Green "collider" after scale reset was actually stale bbox helper
Root cause:
- Dimensions reset path updated model scale and state but did not rebuild the bbox helper overlay.
- Because bbox helper color is bright green, it looked like a stale collider overlay to the user.

Detection signal:
- User reported a large green wireframe staying after reset-scale, despite collider updates.

Preventive checklist:
- Whenever transform-affecting operations run (apply/reset scale, pivot/normalize), refresh bbox helper if bbox overlay is enabled.
- Distinguish collider vs bbox visuals in troubleshooting by color/label.

## 2026-02-18 - Axis-only empty-volume objective over-splits mildly sloped props
Root cause:
- Compound decomposition scored boxes using axis-aligned empty volume only.
- Slightly sloped structures (e.g. chair backrests) looked expensive unless split into several axis boxes.

Detection signal:
- User requested corner-adjusted boxes in collider lab because sloped regions generated too many boxes.

Preventive checklist:
- Include slope-aware effective-empty estimation (top-envelope plane fit) in split/cost scoring, blended with axis-empty cost.
- Emit optional corner-adjusted part geometry for sloped boxes so overlays reflect the fitted slope.
- Keep regression tests for both concave desk decomposition and wedge-like sloped fixtures.

## 2026-02-18 - Collider-lab startup latency regressed when loading full prop catalog
Root cause:
- The lab loaded every saved Forge prop and ran live decomposition per prop during init.
- This made refresh time scale with library size and masked algorithm behavior on the target fixture.

Detection signal:
- User reported collider-lab refresh felt very slow and visually produced mostly axis boxes.

Preventive checklist:
- Keep collider algorithm experiments single-fixture by default (explicit target prop id).
- Limit surface sampling in lab mode to the minimum needed for stable iteration.
- Add multi-prop gallery mode only as an opt-in, separate from default startup path.

## 2026-02-18 - Top-only corner deformation underfits sloped appliance geometry
Root cause:
- Deformation model only adjusted top-face corner heights (vertical edges fixed), so assets with sloped front/side faces remained mostly axis boxes.
- Both greedy and global partitioners shared this shape model limitation, so solver choice alone could not produce sloped parts.

Detection signal:
- User observed global produced only normal boxes and hybrid produced only one sloped part on `commodore-pet-inspired-computer`.

Preventive checklist:
- Support multiple deformation families in per-part fitting (top slope + side slope in YZ/XY) and pick best effective-volume candidate.
- Keep deformed corners in voxel-boundary coordinates and convert to world-space at render/export time.
- Compare hybrid/global on the same fixture with sloped-part counts in HUD to verify shape-model, not just split strategy.

## 2026-02-18 - One-axis deformation candidates cannot express dual-axis taper on appliance-like props
Root cause:
- Per-part deformation selection only considered top-slope or single-axis side-slope candidates.
- Shapes that taper in both X and Z with height were approximated as one-axis deformations, leaving the orthogonal axis straight.

Detection signal:
- User reported both hybrid/global showed slope only in one axis in collider-lab output.

Preventive checklist:
- Include a bi-axis side-slope candidate that fits X and Z min/max as functions of Y.
- Allow split-bias heuristics to treat dominant slope axis as `both` so candidate splits are sampled across both horizontal axes.
- Keep HUD surfacing sloped-part counts per strategy to catch regressions quickly.

## 2026-02-18 - Global collider split search over-produced parts without explicit count-frontier selection
Root cause:
- Beam expansion optimized split-level candidates and tracked one running best state, but did not preserve the best partition per box count as a first-class search frontier.
- Without a frontier selection pass, intermediate depth bias could favor extra boxes on some meshes even when marginal fit gain was weak.

Detection signal:
- User observed global mode producing noticeably more boxes than expected after moving away from fixed-count assumptions.

Preventive checklist:
- Track best decomposition state per box count during global search.
- Select final result from the box-count frontier using fit+complexity scoring, with elbow preference when score delta is small.
- Keep a regression test that bounds global selected box count on a known desk profile.

## 2026-02-18 - Independent slope fits caused wedge gaps and non-continuous compound silhouettes
Root cause:
- Side/top deformation fits were unconstrained least-squares approximations, so fitted faces could move inward relative to sampled occupancy.
- Adjacent decomposed parts did not enforce shared boundary continuity, allowing visible wedge gaps between touching boxes.

Detection signal:
- User reported generated compound colliders looked worse, with discontinuities/wedges between neighboring parts instead of a coherent continuous shape.

Preventive checklist:
- Constrain min/max linear fits to envelope bounds so deformed faces do not cut inward through occupied samples.
- Apply adjacency anchoring on touching faces (X/Z) before preview/export to keep neighboring parts continuous.
- Keep low-box-count selection bias conservative so continuity-preserving detail is not dropped too aggressively.

## 2026-02-18 - Multi-solver lab UI should use a shared minimal result contract
Root cause:
- New collider solvers and existing hybrid/global outputs had slightly different `auto` typing details (`strategy` union/optional fields), causing integration type errors when wiring side-by-side overlays.

Detection signal:
- Typecheck failed when solver timing helper required one concrete solver result type for all strategies.

Preventive checklist:
- In comparison UIs, define one minimal shared result interface (parts + common metrics) instead of reusing a narrow strategy-specific type.
- Keep per-solver optional metrics (`beamWidth`, `statesEvaluated`, etc.) optional in the shared contract.

## 2026-02-18 - Re-labeled solver variants can hide that algorithm logic did not actually change
Root cause:
- Solver names/checkmarks were updated without sufficiently distinct internal fitting logic, so visual outputs stayed effectively the same and looked cached.

Detection signal:
- User reported newly added approaches looked identical to previous variants even after refresh.

Preventive checklist:
- When introducing a new algorithm label, verify at least one core optimization stage differs (candidate generation, objective, or fitting primitive).
- Compare per-solver debug metrics (`parts`, `cost`, `statesEvaluated`) and confirm they diverge on the same fixture before declaring integration complete.

## 2026-02-18 - Plane-aware experimental solvers can regress into fragmented micro-boxes or a single bbox
Root cause:
- Plane-region extraction accepted too many small regions without strong minimum coverage gating.
- QEM/plane-constrained simplification over-reduced detail before decomposition, making the downstream solver collapse to one coarse box.

Detection signal:
- User reported plane-graph output as scattered tiny boxes and QEM-plane output as essentially one bounding box.

Preventive checklist:
- Gate plane regions by relative coverage and suppress tiny residual components by minimum voxel mass.
- Add fallback from fragmented plane result to a stable global/hybrid decomposition path.
- For simplified pipelines, merge simplified points with sampled original points and reject one-box outcomes via fallback.

## 2026-02-18 - Collider-lab comparison quality regressed when a weak solver stayed in the matrix
Root cause:
- Keeping `QEM Plane` alongside stronger methods hid whether improvements came from algorithm changes or fallback behavior.
- Its simplification stage was not reliable enough on the target fixture, so outputs oscillated between over-fragmented and over-collapsed fits.

Detection signal:
- User reported `QEM Plane` produced many noisy boxes while `PlaneGraph Prism` remained only partly usable.
- Visual outputs did not communicate meaningful simplification progress.

Preventive checklist:
- Remove unstable solver variants from the default comparison set quickly instead of preserving them for parity.
- Keep one plane-aware path and invest in its region smoothing/splitting quality before adding new solver labels.
- Prefer region-level quality heuristics (fit error + footprint fill + split balance) over global fallback-heavy pipelines.

## 2026-02-18 - Box-only collider-lab outputs hid whether mesh simplification actually improved
Root cause:
- The lab compared collider box fits but did not render a real simplified mesh artifact, so algorithm changes looked like parameter churn.
- There was no direct face-count signal to validate simplification quality for mesh-collider workflows.

Detection signal:
- User reported outputs still looked "same/shitty" and asked for a flat-plane-aware simplified mesh preview.

Preventive checklist:
- In collider experiments, always pair box-fit overlays with a real simplified mesh preview and explicit face-count stats.
- Use plane clustering + planar boundary retriangulation for man-made props before trying generic decimation.
- Keep tiny-cluster suppression explicit so simplification goals are visible and tunable.

## 2026-02-18 - Plane-aware simplification quality needs live tolerance tuning
Root cause:
- Fixed default tolerances can over-prune small planar regions, causing visible holes on some assets.
- Without live controls, troubleshooting looked like algorithm failure instead of parameter sensitivity.

Detection signal:
- User confirmed simplification worked but reported holes and requested tolerance knobs.

Preventive checklist:
- Expose core plane-aware tolerances (normal, plane distance, vertex merge, boundary simplify, cluster area) directly in the lab UI.
- Rebuild simplified output live with debounce and keep face/cluster stats visible while tuning.

## 2026-02-18 - Patch-wise planar retriangulation is not watertight by construction
Root cause:
- Rebuilding each plane cluster independently changed boundary loops per patch and did not enforce shared seam topology.
- Cluster dropping/simplification could remove seam-supporting geometry, creating cracks/holes even from watertight input.

Detection signal:
- User reported persistent holes despite tolerance tuning and expected strict watertight preservation from a watertight source mesh.

Preventive checklist:
- Use topology-preserving simplification (global indexed edge-collapse) before any plane-aware vertex shaping.
- Keep shared index connectivity intact; never rebuild disconnected patches when watertightness is a hard requirement.
- Add a boundary-edge check and fallback path so closed input cannot emit open output.

## 2026-02-18 - Edge fidelity degrades when merge/snap ignores crease structure
Root cause:
- Vertex welding and plane snapping treated all regions uniformly, so high merge tolerance disproportionately damaged hard edges.
- Without explicit crease protection, simplifier choices optimized face count but eroded man-made silhouette lines.

Detection signal:
- User reported that as merge tolerance increased, planar edges degraded first even when overall simplification looked acceptable.

Preventive checklist:
- Detect crease/border edges from face dihedral and protect their vertices from planar snapping.
- Use normal-aware welding to avoid merging across sharp orientation changes.
- Expose crease threshold as a live tuning control in the lab.

## 2026-02-18 - `vertexMerge` control can silently become ineffective due internal clamp mismatch
Root cause:
- UI slider allowed merge values up to 0.08 m while simplifier internals clamped weld tolerance to 0.008 m.
- As a result, most of the slider travel produced no additional effect.

Detection signal:
- User reported `vertex merge` knob appeared to do nothing.

Preventive checklist:
- Keep control ranges consistent with effective algorithm clamp ranges.
- Include key tuning values in runtime stats/debug output.
- Ensure merge tolerance influences at least one visible stage (weld and/or non-crease snapping).

## 2026-02-18 - High merge should not collapse topology in mesh collection stage
Root cause:
- Reusing `vertexMerge` directly as weld tolerance in indexed mesh collection merged non-identical nearby vertices and dropped triangles before simplification.
- This created true geometric holes when slider values were high.

Detection signal:
- User reported holes returning specifically when increasing `vertex merge`.

Preventive checklist:
- Keep collection/weld tolerance tiny and fixed for topology stability.
- Apply high-level merge aggressiveness in constrained snapping stages, not in base connectivity construction.
- Guard snapping with local face-area/normal validity checks to prevent fold-over and degenerate triangles.

## 2026-02-18 - Merge knob can appear inert when projection-only moves cancel on multi-plane vertices
Root cause:
- Plane-only snapping can average to near-zero displacement on vertices influenced by multiple adjacent planes.
- On low/medium poly hard-surface meshes, many vertices are multi-plane, so slider changes looked ineffective.

Detection signal:
- User reported `vertex merge` still had no visible effect even after removing clamp bottlenecks.

Preventive checklist:
- Add a constrained one-ring centroid attraction pass for non-crease vertices so merge tolerance has observable impact.
- Keep the same local validity guard (area + normal checks) on this secondary merge move.

## 2026-02-18 - Experiment modules must return a cleanup function, not a `{ resize, dispose }` object
Root cause:
- A newly rewritten experiment (`compound-collider-lab`) used an outdated return shape from `init` and returned an object with `resize`/`dispose`.
- Current `ExperimentModule` contract requires `init` to return only a cleanup function.

Detection signal:
- TypeScript error `TS2322` on experiment `init` assignment in `packages/experiments/src/compound-collider-lab/index.ts`.

Preventive checklist:
- Before shipping experiment rewrites, verify `packages/experiments/src/runtime/types.ts` and match the exact `ExperimentModule` contract.
- Keep resize handling inside runtime-supported paths; return only `() => void` from experiment `init`.

## 2026-02-18 - PET convex segmentation violated Y-slab expectations at higher hull counts
Root cause:
- Layered segmentation and recursive splitting lacked an explicit global local-Y non-overlap invariant, so accepted candidates could violate the expected "one hull per Y band" contract in edge cases.

Detection signal:
- User reported that with target hull count `4`, two generated hulls occupied the same local-Y range despite XZ-plane cutting intent.

Preventive checklist:
- Track per-hull local-Y min/max in segmentation outputs and expose them in debug stats.
- Reject split candidates when child Y ranges overlap.
- Validate each accepted split against all active hull Y ranges before committing.

## 2026-02-18 - Desk-like concave furniture collapsed to one box despite obvious leg space
Root cause:
- Surface-only error scoring favored oversized colliders because it penalized points outside the collider but not excess interior volume.
- Concave fallback gating relied on `cavityScore`, which can read near zero for open desks in the current voxel proxy.

Detection signal:
- Synthetic desk regression produced `partCount=1` with `outsideRatio=0`, while desired shape was three parts (top + two vertical supports).

Preventive checklist:
- Add a desk-specific deterministic fallback for high-planarity/high-concavity low-layer meshes.
- Do not gate concave/desk candidate evaluation only on `cavityScore`; include shape cues (`planarity`, `concavityProxy`, `layerScore`).
- Keep explicit desk-shape assertions in `packages/experiments/src/auto-collider/api.test.ts` (exact 3 parts and layout checks).

## 2026-02-19 - Collider scoring accepted oversized boxes on chair-like furniture
Root cause:
- Error scoring only measured uncovered surface (`outsideRatio`, `meanOutsideDistance`) and ignored excess empty-space coverage.
- Large compound boxes spanning seat+armrest voids could win despite poor gameplay fit.

Detection signal:
- `professional-workbench-chair` generated a top box above the seating plane, blocking expected seating space.

Preventive checklist:
- Include an overfill metric in collider error scoring: penalize collider volume covering outside-air voxels from a deterministic voxel solid proxy.
- Keep early-stop criteria dependent on both surface coverage and overfill quality.
- Cache voxel solid proxies per prepared mesh + budget to keep scoring deterministic and fast.

## 2026-02-19 - Strict part budget can re-introduce seat/armrest bridge boxes after overfill scoring
Root cause:
- For layered chair topology, concave decomposition produced a better high-detail split, but strict part-count compaction merged it back into a large mid/top bridge box.
- Overfill scoring alone could not recover shape quality once compaction erased the split structure.

Detection signal:
- `professional-workbench-chair` still produced a wide central box spanning seating bay despite overfill penalties.
- Running concave generation at balanced budget reduced overfill and removed the bridge artifact.

Preventive checklist:
- Add a dynamic strict-mode refinement pass: when overfill remains high on planar/layered concave props, rerun concave generation with expanded budget and adopt if overfill improves without outside-coverage regression.
- Keep fixture regression tests that assert no large seat-bridge box remains for chair-like assets.

## 2026-02-19 - Commodore PET convex segmentation quality regressed without fixture guard
Root cause:
- Convex split heuristics changed repeatedly without a stable fixture-level regression for the lab preset (`targetParts=3`, `fit=max`).
- Generic axis/shape tests did not protect the specific three-band split quality expected for the PET prop.

Detection signal:
- User repeatedly reported the PET split as “wrong axis / too high / too low” after heuristic changes.

Preventive checklist:
- Keep a dedicated regression test for `commodore-pet-inspired-computer` using the exact lab preset options.
- Assert deterministic signature and contiguous Y bands, not only part count.

## 2026-02-19 - Centroid-only hull sampling made convex-segment fit visibly coarse
Root cause:
- Convex hulls were built from triangle centroids only, which discards boundary/extreme mesh vertices and underfits silhouettes.

Detection signal:
- User reported convex-segment overlays looked ugly except in max mode and called out centroid-based hull construction as the likely cause.

Preventive checklist:
- Build convex hull candidates from real triangle vertex samples (with downsampling budget), not centroid-only samples.
- Keep the lab’s convex mode pinned to max-fit tuning when visual fidelity is the goal.

## 2026-02-19 - Centroid-assigned band splits dropped cut-plane corner vertices
Root cause:
- Segmenting by assigning whole triangles to a band from triangle centroid Y ignored triangles crossing cut planes.
- No geometric clipping meant intersection/corner vertices created by cuts were missing from part geometry before hull build.

Detection signal:
- User reported convex hull errors concentrated near original mesh corners at cut boundaries.

Preventive checklist:
- Clip triangles against each Y-slab and recursive median split plane before building segment hulls.
- Build hull sample points from clipped triangle vertices so cut-plane intersections are represented.

## 2026-02-19 - Stride point sampling was not true mesh simplification for convex hull inputs
Root cause:
- Hull inputs were reduced with fixed-stride point picking, which ignores mesh topology and feature semantics.
- Flat regions were not simplified structurally, while edge/corner coverage depended on incidental point order.

Detection signal:
- User asked why convex hull complexity still tracked dense mesh detail and requested true optimization that preserves boundaries/corners while simplifying flats aggressively.

Preventive checklist:
- Run an actual mesh simplification pass before hull generation (topology-aware, with boundary protection).
- Apply an explicit face budget derived from hull-point budget instead of only index stride sampling.
- Use feature-aware point selection (boundary/crease/extrema + coverage) when reducing simplified vertices to hull points.

## 2026-02-19 - Auto-collider regressions overfit preset-specific desk assumptions
Root cause:
- Auto-collider mixed general strategy selection with desk-specific canonicalization/preset heuristics.
- Regression tests asserted exact part counts/orientation that were artifacts of preset logic, not stable quality guarantees.

Detection signal:
- After removing preset branches, colliders still met quality thresholds but tests failed on exact counts (`3`, `5`) and fixed axis expectation.

Preventive checklist:
- Keep auto-collider strategy path generic (boxy/concave) and avoid prop-specific canonicalization in shared runtime logic.
- Write regressions against stable quality metrics: outside ratio, overfill ratio, part-budget bounds, and coarse structural spread.
- Reserve exact-shape assertions for explicit algorithm contracts, not heuristic side effects.

## 2026-02-19 - Strategy-choice heuristics blocked direct UX control
Root cause:
- Auto-collider internally chose strategy order from metrics heuristics, while UI only surfaced the final chosen strategy as read-only status.
- Users could not compare `boxy-furniture` vs `concave-furniture` deterministically from the same menu.

Detection signal:
- User requested explicit menu control over the two remaining strategies and removal of automatic choice heuristics.

Preventive checklist:
- Expose strategy as an explicit option in UI where auto-collider is invoked.
- Thread selected strategy through generation APIs instead of deriving it implicitly from classifier order.
- Keep quality metrics/reporting, but do not use them to silently switch user-selected strategy.

## 2026-02-19 - Convex-hull collider quality should prioritize hull vertex quality, not mesh remesh topology
Root cause:
- We treated hull triangle topology as a physics-quality target and added heavy remeshing/debug controls.
- For Rapier convex colliders, solver behavior is driven by convex vertex set + part count, not pretty triangulation.

Detection signal:
- User observed little practical value from remeshing/topology controls and asked to remove the whole attempt.

Preventive checklist:
- For convex collider workflows, optimize point-set quality and hull complexity first.
- Keep topology-remesh experiments out of the main path unless trimesh colliders are a hard requirement.
- Validate improvements with physics metrics (stability/contact behavior), not wireframe aesthetics.

## 2026-02-20 - Strict TS unions can break strategy-param reset flows in multi-strategy labs
Root cause:
- Resetting `StrategyParamsById` by assigning `paramState[strategyId] = fresh[strategyId]` inside a `for ... of STRATEGY_IDS` loop produced a strict TypeScript indexed-access intersection mismatch.
- The union key iteration path lost per-key specificity, so assignment looked like `A | B | ...` into `A & B & ...`.

Detection signal:
- `tsc` error `TS2322` in the v2 collider lab UI reset handler during `pnpm --filter @experiments/catalog typecheck`.

Preventive checklist:
- For strongly typed strategy maps, prefer explicit per-key `Object.assign` (or key-narrowed helper functions) instead of direct indexed replacement in generic loops.
- Run package typecheck immediately after wiring reset/default-state UI for union-typed config objects.

## 2026-02-20 - Strategy canvases looked empty because card children overflowed min-content width in CSS grid
Root cause:
- Strategy card rows used a `pre` stats block with long unwrapped lines inside a grid container.
- Default grid-item `min-width: auto` allowed the `pre` min-content width to force sibling row items (`viewport` + `canvas`) wider than the card.
- The canvas rendered correctly but got clipped by card overflow, so meshes appeared off-screen or missing in fullscreen/reload layouts.

Detection signal:
- Playwright fullscreen screenshots showed floor fragments but missing props/colliders.
- DOM probe showed `card width ~382px` while `viewport/canvas width ~1165px` for the same card.

Preventive checklist:
- In strategy-card/grid UIs, explicitly set `gridTemplateColumns: minmax(0, 1fr)` on card grids and `minWidth: 0` on child rows.
- Keep wide `pre` text from driving layout; use `overflowX: auto` on stats panels.
- Add an E2E guard that asserts `card width ≈ viewport width ≈ canvas width` across fullscreen, reload, and reframe actions.

## 2026-02-20 - Orbit sync logic can accidentally disable all strategy interactions
Root cause:
- Sync orchestration toggled `controls.enabled` on/off using active-card start/end events.
- Any missed active transition or reset path left all cards disabled, so rotate/pan/zoom stopped working.

Detection signal:
- User reported no rotate, pan, or zoom response in strategy cards after recent camera-sync changes.

Preventive checklist:
- Keep OrbitControls enabled on every strategy card and sync other views from `change` events using a guarded apply phase.
- Do not gate camera interaction behind global active-card toggles unless pointer capture state is guaranteed.
- Add E2E interaction coverage that drags/wheels one card and verifies at least one sibling card view changes.

## 2026-02-20 - Playwright `addInitScript` can invalidate localStorage persistence tests on reload
Root cause:
- Test setup used `page.addInitScript` to clear localStorage keys.
- Init scripts run on every new document, so a reload re-cleared the key under test and produced false persistence failures.

Detection signal:
- Persistence test failed after reload while runtime behavior looked correct in manual verification.

Preventive checklist:
- For persistence tests, clear localStorage once before entering the target page (e.g. via `page.goto("/")` + `page.evaluate`), not via reload-time init scripts.
- Use visible-only selectors (`pre:visible`) when a feature intentionally hides UI sections.

## 2026-02-20 - Collapsed cards did not repack grid because row span was measured from stretched box size
Root cause:
- Masonry-like grid used fixed `grid-auto-rows`, but card row-span sizing was computed from `getBoundingClientRect().height`.
- Grid items were stretched, so collapsed cards still reported large visual height and kept large row spans.

Detection signal:
- Collapsed state flag changed, but card `gridRowEnd` remained large (`span 21`) and cards below did not move up.

Preventive checklist:
- For grid-masonry span math, use intrinsic height (`scrollHeight`) instead of stretched box height.
- Set card `align-self: start` so collapsed cards are not stretched by track sizing.
- Add E2E coverage asserting single-card collapse moves the nearest card below upward in the same column.

## 2026-02-20 - Strategy matrix exceeded browser WebGL context limits and crashed shader program setup
Root cause:
- The strategy grid created one `THREE.WebGLRenderer` per strategy card, which exceeded browser active-context limits as strategy count grew.
- Context loss then cascaded into runtime shader/program errors (`Cannot read properties of null (reading 'trim')`) during render.

Detection signal:
- Console warning `Too many active WebGL contexts. Oldest context will be lost.`
- Follow-on `WebGLProgram.getUniforms` / `onFirstUse` exception during the render loop.

Preventive checklist:
- Do not allocate one renderer per strategy in large comparison grids.
- Keep per-card scenes/cameras, but lazily attach renderer+controls only for visible, expanded cards (dispose on scroll-out/collapse).
- Add/keep E2E coverage for rotate/pan/zoom sync after renderer lifecycle changes.

## 2026-02-20 - Generated per-prop default maps should be typed as partial strategy maps
Root cause:
- `per-prop-defaults.generated.ts` stored tuned defaults for a previous strategy set and was typed as `Record<string, StrategyParamsById>`.
- Adding new strategy IDs made existing generated entries incomplete and broke typecheck (`TS2739`) immediately.

Detection signal:
- TypeScript compile errors in generated defaults file complaining missing new strategy keys after expanding `StrategyId`.

Preventive checklist:
- Type generated defaults as `Record<string, Partial<StrategyParamsById>>`.
- Merge generated per-prop overrides onto `DEFAULT_STRATEGY_PARAMS` at runtime instead of requiring full entries.
- Keep generator output format aligned with this partial-map contract.

## 2026-02-20 - Thin-part penalty and strict concave defaults can mis-rank legitimate furniture leg colliders
Root cause:
- `thinPartPenalty` treated moderately thin support legs as strongly undesirable, which pushed visually correct desk/chair strategies down in ranking.
- `concave-furniture` defaulted to strict budget in V2, causing avoidable underfill on desk-like fixtures and further hurting score.
- Base coverage bonus favored chunkier lower supports without a counterweight for footprint overreach.

Detection signal:
- For `large-desk-without-drawers`, `concave-furniture`/`boxy-furniture` ranked below `voxel-greedy` despite visibly better leg sizing.
- Diagnostic breakdown showed `underfill` + `thinPenalty` dominating concave score while voxel stayed near zero.

Preventive checklist:
- Keep thinness threshold conservative (penalize only near-needle parts, not normal furniture legs).
- Default `concave-furniture` to balanced budget unless strict is explicitly required.
- Include a base-footprint overreach term so oversized support footprints do not win from flat-base bonus alone.
- Use fixture diagnostics to inspect per-term contributions before changing global weights.

## 2026-02-20 - Per-prop tuner runs can lose progress or stall when expensive strategies explore extreme params
Root cause:
- The defaults tuner evaluated many strategy/prop combinations with broad random mutation ranges, which can hit high-cost parameter regions.
- A single long-running pass wrote output only at the end, so interruption meant losing completed prop tuning work.

Detection signal:
- Tuning runs appeared "stuck" for long periods on specific props while one worker stayed at full CPU.
- Generated defaults file timestamp did not advance until full completion.

Preventive checklist:
- Keep strategy-aware bounded search ranges for expensive parameter keys (resolution, maxParts, cluster counts, etc.).
- Write checkpoint output after each completed prop so long runs are resumable.
- Support prop filtering env vars for targeted reruns/debugging without rerunning the full matrix.

## 2026-02-20 - Overlap volume metrics can be wrong when evaluated only inside mesh bbox
Root cause:
- Overlap/coverage was computed on a voxel grid bounded to the mesh bbox, so collider volume outside the mesh bounds was clipped out.
- Fixed voxel resolution over changing bounds also changed voxel size, causing non-comparable overlap scores between strategies.

Detection signal:
- Oversized collider test case did not reduce overlap agreement as expected.
- Directional overlap numbers appeared inconsistent with obvious size mismatch.

Preventive checklist:
- Compute overlap metrics on merged mesh+collider bounds, not mesh bounds only.
- Scale voxel resolution with merged-bounds size (within a cap) to keep voxel size approximately stable.
- Keep a test asserting overlap agreement drops when collider is intentionally oversized.

## 2026-02-20 - Column-span solid fill can mislabel open air as mesh volume for furniture-like props
Root cause:
- Prop voxel solidification filled every Y cell between min/max occupied per XZ column.
- For disconnected vertical structures (e.g. desk tops + legs), this bridged open air and made bulky colliders look artificially "inside mesh".

Detection signal:
- User-reported visual mismatch: HACD looked overly bulky but still ranked above tight furniture strategies.
- Diagnostics showed `colHit=1.000` and near-zero overfill on visibly air-catching colliders.

Preventive checklist:
- Build mesh volume from shell + exterior flood-fill interior, not per-column min/max span fill.
- Prefer triangle-sampled shell voxels over pre-dilated point cloud for flood-fill boundaries.
- Re-run strategy diagnostics on representative furniture props after occupancy changes.

## 2026-02-20 - Strategy produced rotated boxes when workflow required world-axis alignment
Root cause:
- New `simplify-bsp-convex` strategy emitted per-segment OBBs (PCA-based orientation) after decomposition.
- Lab workflow expectation for this pipeline was axis-aligned box colliders for every strategy in the active comparison set.

Detection signal:
- User reported new-strategy boxes were not aligned to world/main axes while other algorithms were.

Preventive checklist:
- For any newly added strategy in collider-pipeline-lab-v2, verify whether output should be world-axis AABB or oriented OBB before shipping.
- If axis alignment is expected, build parts via world-space bounds (`axisAlignedPartFromBounds`) and avoid PCA rotation paths.
- Add a strategy-specific assertion that part rotations stay identity when axis-aligned behavior is required.

## 2026-02-20 - Multi-prop comparison view drifted into independent camera states and underlit scenes
Root cause:
- Prop cards used independent `OrbitControls` with no shared view-pose propagation, so pan/zoom/rotate diverged between cards.
- Lighting/background values were tuned too dark for hull/segment inspection in dense grid cards.

Detection signal:
- User requested that rotating/panning/zooming one prop should apply to all props and reported the scenes as too dark compared to previous behavior.

Preventive checklist:
- In multi-card comparison views, sync a shared camera pose from the active card to all sibling cards on controls `change` events.
- Guard synchronized updates with a re-entrancy flag to avoid recursive control-change loops.
- After reload/recompute paths, reapply a reference pose so cards remain aligned.
- Keep a readable lighting baseline (ambient + hemi + key/fill directional) and avoid near-black viewport backgrounds.

## 2026-02-20 - High-budget VHACD runs looked frozen with minimal status feedback
Root cause:
- Decomposition ran in long synchronous phases per prop, so the UI had few repaint opportunities and status stayed coarse (`Running N props...`).
- Progress surfaced only at prop boundaries, which is too sparse for high-budget presets.

Detection signal:
- User reported the page appeared stuck during aggressive defaults and asked for paced execution plus clearer progress indication.

Preventive checklist:
- For expensive mesh processing, expose phase-level progress (`collect`, `voxelize`, `split`, `merge`, `hulls`, `finalize`) rather than only item counts.
- Yield to the UI thread between major phases so progress bars/status can repaint.
- Show both overall progress (`current/total`) and active phase text in the HUD.

## 2026-02-20 - Hidden high-cost VHACD knobs made aggressive presets hard to recover from in UI
Root cause:
- We increased non-trivial compute controls (`maxHullPointSamples`, hull-vertex projection) without exposing them in the experiment HUD.
- Users could tune visible params but still hit large runtime costs from hidden defaults.

Detection signal:
- User reported aggressive settings were too slow and asked specifically to expose the increased-but-hidden parameters.

Preventive checklist:
- Any time compute defaults are raised, expose the corresponding controls in the same UI revision.
- Keep parameter guide text updated with practical speed/quality tradeoffs for each newly exposed knob.
- Ensure all runtime-costful options passed into core decomposition are user-adjustable from the panel.

## 2026-02-20 - Main-thread VHACD decomposition blocked interaction under high-budget presets
Root cause:
- VHACD execution (split/merge/hull/project phases) ran on the UI thread, so long props caused visible stalls even with progress text updates.
- Recompute actions only invalidated local tokens; they did not actively interrupt ongoing CPU-heavy work.

Detection signal:
- User reported the page looked stuck and requested worker offload plus graceful recompute restarts on param changes.

Preventive checklist:
- Move heavy decomposition into a dedicated worker and communicate via typed request/progress/result messages.
- Keep source mesh payloads serializable (flattened triangle positions) and rebuild renderable geometries on the main thread.
- On recompute/reload while running, terminate current worker job and start a fresh worker task with latest parameters.

## 2026-02-20 - Projection toggle forced recompute because only one hull variant was cached
Root cause:
- The decomposition result stored only the currently selected hull variant (`projectHullVertices` on or off).
- Checkbox changes had no precomputed alternate geometry to display, so the UI had to launch a fresh run.

Detection signal:
- User asked to compute both variants up front and reported the projection toggle did not provide immediate visible switching.

Preventive checklist:
- For UI toggles that compare algorithm variants, return all compared variants from the same worker result payload.
- Keep toggle handlers render-only (swap cached geometry) instead of triggering recompute.
- Include active variant and per-variant signatures in debug output so variant switching is verifiable.

## 2026-02-20 - Split-stage plane evaluation became the dominant runtime bottleneck at high resolutions
Root cause:
- Split-level processing evaluated each part sequentially inside a single worker, and each evaluation scanned many plane candidates with convex-hull estimates.
- Increasing resolution and grid-cell budget amplified per-level cost enough that split progress appeared stalled.

Detection signal:
- User reported `Split level` progress was very slow even after lowering unrelated knobs.

Preventive checklist:
- Parallelize per-part split decisions within each split level using a bounded nested-worker pool.
- Keep level ordering deterministic and apply split decisions in original part order after parallel evaluation.
- Provide a safe fallback to local sequential split evaluation if nested-worker initialization or task execution fails.

## 2026-02-20 - Worker parallelization was hard to verify without explicit split-mode telemetry
Root cause:
- Split evaluation moved to a nested worker pool, but run-time UI output did not explicitly show whether split processing was parallel, sequential, or fallback mode.

Detection signal:
- User asked how to ensure workers were actually doing split work in parallel.

Preventive checklist:
- Surface split evaluation mode and worker count in both live progress messages and final per-prop debug stats.
- If the pool fails and falls back, show an explicit fallback status instead of silently switching execution mode.

## 2026-02-20 - Fixed split-worker caps can underutilize CPUs on high-res runs
Root cause:
- Worker pool sizing used a hard voxel-threshold cap (`2` workers above a fixed voxel count), which was too conservative on machines with many cores and available memory.

Detection signal:
- User observed split phase reporting only `parallel x2` and asked for more aggressive parallelism.

Preventive checklist:
- Derive worker count from both CPU (`hardwareConcurrency`) and estimated per-worker memory footprint, not a single fixed threshold.
- Keep an upper safety cap for runaway worker spawning, but allow higher counts when memory budget permits.

## 2026-02-21 - Unbounded hull projection can create overlapping artifacts
Root cause:
- Projected hull vertices were always snapped to the nearest mesh surface point with no maximum distance threshold.
- Deep interior hull vertices could jump to distant exterior surfaces, causing distorted overlap.

Detection signal:
- User reported “funky overlapping hulls” when projection was enabled.

Preventive checklist:
- Keep a configurable projection max-distance cap and only snap when nearest distance is below it.
- Allow `0` as an explicit “no cap” mode for controlled experiments.

## 2026-02-21 - Unbounded hull-vertex projection can over-snap interior points and create overlapping hull artifacts
Root cause:
- Projection snapped each hull vertex to the globally closest source-triangle point without a maximum distance guard.
- Vertices deep inside a part could jump to far-away mesh surfaces, producing distorted/overlapping projected hulls.

Detection signal:
- User reported “funky overlapping hulls” when projection was enabled on some props.

Preventive checklist:
- Keep a configurable projection distance cap and only snap vertices when nearest surface distance is below that threshold.
- Expose the cap in UI with clear semantics (`0` disables cap).
- Pair projection with a sliver penalty in split scoring to reduce narrow wedge fragments before projection.

## 2026-02-21 - Float32 collider vertex tests failed on exact equality
Root cause:
- New compound-convex collider tests compared `Float32Array` values using strict equality against decimal literals.
- Float32 representation introduces tiny rounding differences (e.g. `0.15` -> `0.15000000596`), causing deterministic but noisy assertion failures.

Detection signal:
- `vitest` failure in `prop-collider-resolver.test.ts` showed only tiny numeric diffs between expected and actual flattened vertices.

Preventive checklist:
- For collider vertex arrays (especially `Float32Array`), assert per-element tolerance with `toBeCloseTo` instead of strict array equality.
- Keep exact-equality checks for integer/discrete metadata only.

## 2026-02-21 - Offline collider precompute picked empty processed models
Root cause:
- Precompute selected `processed/model.glb` whenever it existed, without validating that it contained mesh triangles.
- Some props had a placeholder/empty processed GLB while the usable mesh existed in `raw/tripo-output.glb`.

Detection signal:
- User reported a visible mesh, while precompute produced fallback one-box colliders and `sourceTriangleCount: 0`.
- Direct file inspection showed `processed/model.glb` with `0` meshes and raw GLB with expected triangle count.

Preventive checklist:
- When choosing source geometry for offline processing, validate triangle payload, not file existence.
- Probe both processed and raw model paths and pick the first with valid triangle data.
- Log when raw fallback is used because processed mesh content is empty.

## 2026-02-22 - Physics preview sim effect restarted itself via shared viewport state
Root cause:
- The Forge V2 simulation `useEffect` depended on shared `physicsViewState`.
- Inside the effect, calling `Viewport.setModel(...)` emitted `onViewChange`, which updated `physicsViewState` and immediately re-triggered the effect cleanup/restart loop.

Detection signal:
- Collider generation succeeded but physics preview appeared static / never progressed.
- No typecheck/build errors; issue reproduced only at runtime in the `ForgeV2` physics preview flow.

Preventive checklist:
- Keep long-running simulation/animation effects independent from UI camera-sync state unless camera changes must rebuild simulation state.
- If a viewport `setModel` emits `onViewChange`, do not include that shared view state in the same effect dependency list that sets the model.
- Split simulation world setup and camera synchronization into separate effects when both are needed.

## 2026-02-22 - One pixel pane stayed blank in multi-pane imperative preview grids
Root cause:
- `PixelQuad` pushed the model to child `ViewportPixel` instances only in a one-time `useEffect` keyed by `model`.
- If one child viewport mounted after that effect ran, it never received the current model and stayed blank.

Detection signal:
- In Forge V2 physics preview, a single angle/scenario pane (e.g. south on the 30deg slope row) could remain blank while sibling panes rendered normally.
- Rebuilds/prop switches sometimes moved the problem to a different pane, pointing to mount timing rather than scenario logic.

Preventive checklist:
- In imperative multi-pane wrappers, backfill current model/view state inside the child ref callback for late-mounted panes.
- Do not assume all child refs are attached before parent `model`/`view` effects fire.
- When a single pane is blank but siblings work, inspect ref-attachment timing before debugging scene content.

## 2026-02-22 - Forge V2 physics preview exceeded browser WebGL context limits
Root cause:
- Physics view mounted many independent WebGL canvases at once (multiple `Viewport` 3D panes plus `4 x N` pixel panes), exceeding the browser's active context cap.
- React StrictMode dev effect replays amplified context churn during mount, making failures easier to hit.

Detection signal:
- Browser console spammed “There are too many active WebGL contexts on this page, the oldest context will be lost.”
- Failures appeared in both `Viewport.tsx` and `ViewportPixel.tsx` stack traces during physics view mount.

Preventive checklist:
- For multi-pane preview grids, use one renderer/canvas with scissor viewports per grid (`PixelQuad` / similar wrappers) instead of one WebGL context per pane.
- Count worst-case visible panes before adding new preview rows, especially in React StrictMode/dev.
- Treat context-limit warnings as a correctness bug (they can cause random panes to disappear), not just a performance warning.

## 2026-02-22 - Shared scissor pixel panes drifted by 1px from independent panes
Root cause:
- A shared WebGLRenderer was reused across pane renders, but the pixel renderer's offscreen low-resolution pass did not explicitly reset scissor test / viewport / scissor before rendering to its render target.
- Pane-dependent WebGL state could leak into the offscreen pass and cause subtle rasterization differences in some panes (for example, a 1-pixel edge difference on the orange box in the east view).

Detection signal:
- A/B toggle looked almost identical overall, but specific pixel edges differed between independent and shared modes.
- The issue was easier to notice on high-DPI/Retina displays and in tight edge cases rather than broad scene composition.

Preventive checklist:
- In shared-renderer pipelines, explicitly set scissor test, viewport, and scissor before every offscreen render-target pass.
- Do not assume render-target switches restore all WebGL state needed for pixel-perfect parity.
- Validate shared-vs-independent A/B parity at DPR 2, not only DPR 1.

## 2026-02-22 - Touchpad wheel pan smoothing broke pixel stability and vertical wheel deltas felt chunky
Root cause:
- Replacing pixel-quantized pan with continuous world-space pan removed the camera-step quantization invariant and reintroduced shimmer.
- Touchpad vertical wheel events can arrive as larger per-event deltas than horizontal, so feeding one wheel event directly into quantized `applyPan(...)` caused immediate full "big-pixel" jumps.

Detection signal:
- User reported horizontal touchpad pan felt fluid while vertical pan jumped in large pixel units.
- A quick vertical attenuation hack only changed speed, not the stepped feel.
- Continuous smoothing fix removed the stepping but reintroduced shimmering.

Preventive checklist:
- Keep all pan motion (drag and wheel) inside the same pixel-quantized pan pipeline.
- For large wheel deltas, split one wheel event into smaller sub-steps and feed each through quantized pan rather than bypassing quantization.
- When patching scissor-vs-independent parity paths, mirror the fix in both `pixel-perfect-iso-view` and `pixel-perfect-iso-viewport-core` until the wrapper refactor removes duplication.

## 2026-02-22 - Forge V2 physics pixel previews silently bypassed `@common/render`
Root cause:
- `ForgeV2` physics used a custom `PixelQuad` renderer path with raw `THREE.WebGLRenderer` + hand-rolled scissor logic instead of the shared `@common/render` pixel viewport stack.
- That parallel implementation drifted from the render-library behavior and fixes, so "pixelated views" in physics setup could fail or behave differently even when `@common/render` was working elsewhere.

Detection signal:
- Forge V2 physics pixel strips did not match recent `@common/render` scissor/pixel fixes.
- Code inspection showed `apps/hub/src/pages/forge-v2/PixelQuad.tsx` rendering directly with `three` rather than `PixelPerfectIsoViewportCore` / `SharedScissorStage`.

Preventive checklist:
- Do not maintain parallel pixel-preview renderer implementations in app code when `@common/render` already provides the needed scissor/pixel pipeline.
- For multi-pane pixel previews, wrap `SharedScissorStage` + `PixelPerfectIsoViewportCore` in app components instead of custom renderer/scissor math.
- When debugging a preview regression, first verify the affected screen is actually using the intended shared library path.

## 2026-02-22 - Shared scissor stage mount setup overrode CSS-positioned overlay hosts
Root cause:
- `SharedScissorStage` checked `mount.style.position` (inline style only) and forced `position: relative` when empty.
- For mounts positioned via stylesheet (for example `position: absolute` scissor canvas overlays), the inline style was empty even though computed positioning was correct, so the stage unintentionally changed layout.

Detection signal:
- A scissor canvas host that should be an absolute overlay started occupying grid layout space (extra row/column item appeared).
- Pane hit-testing/scissor rect math became wrong because pane elements were measured relative to a now-mispositioned mount, causing blank rendering.

Preventive checklist:
- When conditionally mutating layout-affecting styles (`position`, `display`), inspect computed style (`getComputedStyle`) rather than inline style only.
- Treat scissor stage mount setup as compatible with CSS-positioned hosts, not only plain static mounts.
- If a scissor pane grid suddenly shows one pane on a new row, inspect whether the canvas host became an in-flow grid item.

## 2026-02-22 - Partial scissor migration can still exceed WebGL context limits in React StrictMode
Root cause:
- Forge V2 physics moved collider/sim preview panes to a shared scissor 3D renderer but left the primary source mesh preview on the legacy per-pane `Viewport` renderer.
- In dev/StrictMode, effect replays temporarily double context allocations, so a "mostly migrated" page can still cross the browser context cap and blank random panes.

Detection signal:
- Multi Prop Generation (fewer contexts) rendered correctly while Physics Setup still failed/blanked after a partial scissor migration.
- Code inspection showed one remaining independent `Viewport` in the physics pane alongside shared scissor renderers.

Preventive checklist:
- When migrating a context-heavy screen to scissor/shared rendering, count contexts after StrictMode effect replay, not only steady state.
- Do not leave a single legacy preview canvas in a dense preview matrix if the goal is context-cap safety.
- Complete migration of all same-class preview panes (source + variants) before judging context-limit fixes.

## 2026-02-22 - Shared scissor overlays can render "empty" when host sizing or cell backgrounds hide the canvas
Root cause:
- `ForgeScissorViewportPane` set inline `height: 100%`, which overrode the CSS height utility when the pane root itself was the sized host, collapsing some scissor pane hosts to `0px` height.
- Physics Setup sim-row pixel cells had a later opaque background rule that covered the shared scissor canvas overlay, so pixel panes looked blank even though rendering was happening.

Detection signal:
- Playwright DOM inspection showed visible pane containers with valid widths but top-row scissor pane hosts at `height: 0`.
- Shared scissor canvas and pane rects existed, but `.forgev2-sim-row-grid .forgev2-pixel-cell` computed backgrounds remained opaque over the overlay canvas.

Preventive checklist:
- Avoid inline `height: 100%` on reusable pane roots when the same component is sometimes the sizing host and sometimes nested inside one; let the caller-owned host class control height.
- When using one shared canvas behind pane DOM overlays, audit later CSS rules for opaque pane backgrounds that can mask the canvas output.
- In blank-pane debugging, inspect computed pane rects and overlay/background stacking before assuming render logic is broken.

## 2026-02-22 - Input extraction is incomplete if render-stage APIs still expose DOM event routing
Root cause:
- `@common/input` was moved out, but `SharedScissorStage` still exported `routePointer*` / `routeWheel` / `routeKey*` dispatch methods plus pane `onPointer*`/`onWheel`/`onKey*` hooks.
- That preserved low-level event mechanics inside `@common/render`, so the abstraction boundary remained leaky even though listeners moved.

Detection signal:
- `bindSharedScissorStageInput(...)` in `@common/input` still depended on stage route methods instead of `hitTestPane(...)` and explicit pane commands.
- `SharedScissorPane` interface still mixed rendering and DOM-event callbacks.

Preventive checklist:
- When extracting input into a separate package, remove both listener ownership and event-routing APIs from the render package in the same pass.
- Keep shared stage contracts render-only (`render`, `onResize`, `hitTestPane`, focus state) and route interactions through pane command methods from the input layer.
- Search for `PointerEvent`/`WheelEvent`/`KeyboardEvent` types in render-layer public interfaces after the extraction to verify the boundary is actually clean.

## 2026-02-23 - Horizontal PixelQuad strip can show "white ground" after switching from grid layout
Root cause:
- Forge V2 Multi Prop Generation switched `PixelQuad` to the horizontal `forgev2-pixel-strip` layout, but that strip class used a transparent background while scissor-mode pixel cells are also transparent.
- Pixel viewport letterboxing/gaps then revealed the light card background, which looked like a pane-specific render bug (often most visible in the north pane).

Detection signal:
- After changing Multi Prop Generation pixel previews from `forgev2-pixel-grid` to `forgev2-pixel-strip`, the north pane appeared to have a white floor/ground region while the render content itself was otherwise correct.
- CSS inspection showed `.forgev2-pixel-strip { background: transparent; }` and scissor-mode cells intentionally transparent.

Preventive checklist:
- When reusing `PixelQuad` in scissor mode, ensure the container/root layout class provides an explicit background because pane cells are transparent by design.
- Treat apparent per-pane "render color" glitches in scissor previews as possible host/background leaks before debugging renderer state.
- When changing preview layouts (`grid` -> `strip`), port the visual container styling (background/padding/border context) along with the grid template.

## 2026-02-23 - Scissor-clipped panes must not resize pixel cameras from clipped viewport dimensions
Root cause:
- `SharedScissorStage` reported only the clipped scissor rect device size.
- `PixelPerfectIsoScissorPane.onResize(...)` used that clipped `deviceWidth/deviceHeight` to recompute DPR and resize the pixel viewport core, so horizontally scrolled/offscreen panes were treated like actual resizes.

Detection signal:
- In Forge V2 pixel strips, horizontal scrolling worked but panes that moved out of the visible stage area changed apparent camera framing/viewport.
- The effect occurred without CSS size changes and correlated with scissor clipping at the container/browser edge.

Preventive checklist:
- Distinguish logical pane size from clipped render viewport size in shared scissor APIs.
- Pixel render cores should resize from the pane's full quantized device size, then render into a clipped scissor viewport when partially offscreen.
- When adding scroller-based pane layouts, test that offscreen clipping does not mutate camera framing/state.

## 2026-02-23 - Shared scissor pane ancestors with opaque backgrounds mask the canvas and make panes look blank
Root cause:
- `SharedScissorStage` renders one canvas behind pane DOM overlays; any opaque background on the pane element or an ancestor between the pane and the stage mount paints over the shared canvas in that pane region.
- This surfaced again in a new experiment where row cards were opaque even though pane surfaces themselves were transparent.

Detection signal:
- Pane DOM frames/labels are visible and correctly sized, but mesh/pixel renders appear empty.
- Switching an ancestor/card background from opaque to transparent immediately restores rendering without changing renderer logic.

Preventive checklist:
- Treat the full ancestor chain from pane surface to scissor stage mount as part of the rendering path; it must remain transparent in pane regions.
- Prefer borders/box-shadows for pane chrome instead of opaque fills when using a shared canvas behind overlay DOM.
- Keep the `SharedScissorStage` opaque-background warning enabled and investigate any warning before assuming render math is broken.

## 2026-02-24 - ThreeScene scissor panes can look horizontally/vertically squeezed when partially offscreen
Root cause:
- `ThreeSceneScissorPane` used the clipped scissor rect for both `setScissor(...)` and `setViewport(...)`.
- When a pane was partially clipped by scrolling, WebGL mapped the full scene into the smaller clipped viewport, visually compressing the content instead of showing a cropped slice.

Detection signal:
- In `tripo-face-limit-compare`, panes that should have been partially visible during scroll still showed the full scene squeezed into the visible portion.
- A unit test with a pane offset outside the stage showed scissor rect `(clipped)` but viewport also `(clipped)` instead of preserving the pane's full viewport origin/size.

Preventive checklist:
- In shared scissor rendering, use clipped rects for `setScissor(...)` but keep `setViewport(...)` aligned to the pane's unclipped device-space origin/size.
- Include a test for partially clipped panes that asserts scissor and viewport rectangles differ as expected.
- When debugging scroll-related scissor artifacts, check for viewport compression before camera/aspect math regressions.

## 2026-02-24 - Shared scissor overlay layering in experiment UIs can draw over page chrome and create misleading pane-edge artifacts
Root cause:
- The Tripo compare screen used a viewport-fixed shared scissor overlay with a high z-index (`10`), which placed rendered pane content above the experiment top header while scrolling.
- Pane frame chrome also used rounded borders, which made pane content corners appear slightly rounded/masked relative to the intended rectangular framing.

Detection signal:
- While scrolling inside the experiment root div, pane renders visually stayed above the description header instead of disappearing beneath it.
- Users reported slight corner rounding on pane content despite expecting square/rectangular pane visuals.

Preventive checklist:
- Keep shared scissor overlays only high enough to sit above pane shells, and explicitly reserve higher z-index for sticky/header chrome.
- Add a local stacking context (`isolation: isolate`) for experiment roots that host fixed overlays.
- Treat pane frame corner radius as a rendering-path decision in shared-canvas screens; test and standardize it instead of leaving cosmetic defaults.

## 2026-02-24 - Hub stage hosts need paint containment for experiments that use viewport-fixed shared scissor overlays
Root cause:
- Some experiments render a shared scissor canvas using `position: fixed` inside the experiment mount.
- Without a containing block on the Hub stage host, that fixed overlay anchors to the browser viewport and can paint above the Hub page header/description outside the stage.

Detection signal:
- While scrolling inside an experiment's internal scroll container, preview renders appear on top of the outer Hub header (title/description/build stamp) instead of remaining visually contained to the stage panel.

Preventive checklist:
- Make the Hub stage host a containing block/paint boundary for experiment content (`contain: paint` and local isolation) so fixed overlays stay inside the stage.
- Reserve a higher local layer for the Hub header when experiments may create overlay layers inside the stage.
- Add a CSS regression test for stage-host containment and header z-index when changing shell styles.

## 2026-02-24 - Pixel scissor panes can look "sticky" at scroll boundaries if clipped scissor origin is reused as the pane viewport origin
Root cause:
- `PixelPerfectIsoScissorPane` passed only the clipped visible rect into `PixelPerfectIsoViewportCore.renderToRenderer(...)`.
- The core used that rect for both `setScissor(...)` and viewport-relative output placement, so once a pane started clipping at the viewport edge, content stopped translating with the pane and appeared stuck to the boundary.

Detection signal:
- Pixel panes scroll normally until they begin clipping offscreen, then the visible content appears to stop moving while the pane continues scrolling.
- Renderer behavior shows scissor clipping should change while pane viewport origin should keep moving (possibly negative/offscreen).

Preventive checklist:
- Pixel scissor rendering should support separate pane viewport and clipped scissor rect inputs.
- Use unclipped pane viewport origin/size for viewport-relative output placement and clipped rect only for `setScissor(...)`.
- Keep a regression test that asserts clipped scissor and pane viewport can differ during partial offscreen rendering.

## 2026-02-24 - Shared scissor canvas on fractional mount edges can create visible pixelated seam/jump artifacts versus independent canvases
Root cause:
- `SharedScissorStage` quantized the renderer backing size from absolute device-pixel edges, but left the shared canvas CSS box pinned to unquantized mount CSS edges (`left/top=0`, raw CSS width/height).
- On fractional layout positions/sizes, browser `image-rendering: pixelated` scaling of one large shared canvas could land on a different sampling phase than per-pane canvases, causing visible row/column seam jumps when toggling shared scissor mode.

Detection signal:
- In `pixel-perfect-scissor-lab`, enabling the shared scissor toggle caused visible 1-3px jumps/seams (reported in the north/east panes) that did not appear in independent mode.
- Local world-projection/debug math could still match, pointing to a canvas CSS/backing alignment issue rather than scene/camera math.

Preventive checklist:
- When a shared canvas backing store is quantized from absolute edges, also align the canvas CSS box to those same quantized edges (left/top offset + CSS size from `deviceSize / dpr`).
- Add a regression test for fractional mount geometry that asserts shared canvas CSS left/top and width/height match device-pixel quantized mount edges.
- Treat shared-canvas pixelated rendering mismatches as potentially browser compositing/CSS alignment issues before changing scene/scissor math.

## 2026-03-06 - Imported prop shadow prep can silently disable floor shadows by forcing `shadowSide = BackSide`
Root cause:
- `physics-prop-drop` forced imported prop materials to `side = FrontSide` and `shadowSide = BackSide` instead of preserving the asset-authored sidedness.
- On forge-v2 props this prevented reliable shadow-map casting onto the room floor even though renderer shadows and mesh `castShadow` flags were enabled.

Detection signal:
- User reported no visible prop shadows on the floor in `#/exp/physics-prop-drop`.
- Local screenshot verification showed floor contact shadows appearing only after restoring `shadowSide` to match the material `side` and centralizing imported shadow prep.

Preventive checklist:
- For imported meshes, preserve authored material `side`; set `material.shadowSide = material.side` instead of forcing `BackSide`.
- Keep imported shadow prep in one helper that also normalizes unlit materials and repairs missing normals.
- Add a regression test for imported shadow prep before tweaking scene-light parameters.

## 2026-03-06 - Compound hull asset-forge props need pivot metadata, not bbox/box fallbacks, to align visual roots with Rapier bodies
Root cause:
- `physics-prop-drop` still mixed old box-collider assumptions (`bboxProcessed`, half-height drop offsets, box-only root offsets) into a path now fed mostly by forge-v2 compound convex hull colliders.
- Several forge-v2 props store the visual bottom-center pivot in `processing.transform.finalPivot.offset`; ignoring that made the rigid-body origin act like the prop pivot was centered.

Detection signal:
- User reported props looked like they had a pivot in the middle despite approved colliders.
- Local metadata inspection showed compound hull props such as `ammo-crate` had large `finalPivot.offset.y` values while the experiment hardcoded compound-hull root offsets to zero.

Preventive checklist:
- When consuming forge-v2 props, prefer the selected compound hull preset instead of generic bbox/box fallbacks.
- Derive rigid-body root offsets from `processing.transform.finalPivot.offset` for compound hull props.
- Treat processed forge-v2 visuals as bottom-center rooted and use root-space placement heights directly (for example `DROP_HEIGHT`) instead of re-adding half-height offsets.

## 2026-03-06 - Shared prop metadata must parse forge-v2 `colliders.presets`, `bboxProcessed`, `finalPivot`, and resolved physics together
Root cause:
- `settlement-builder-ecs/prop-library.ts` still assumed older prop metadata (`processing.bbox`, direct collider records, direct physics fields) and ignored current forge-v2 fields like `processing.mesh.bboxProcessed`, `processing.transform.finalPivot.offset`, `colliders.selectedPresetId`, and `physics.resolved`.
- That left shared collider resolution with zeroed compound-hull root offsets and incomplete physics hints even when the asset-forge metadata was correct.

Detection signal:
- Shared regression tests failed on forge-v2 shaped metadata with zero bbox dimensions and zero `localRootOffset` for compound convex hulls.
- User reported props looking center-pivoted and confirmed asset-forge compound hull props are now the forward path.

Preventive checklist:
- When adding or changing asset-forge metadata, update the shared prop parser first, not just experiment-local loaders.
- For forge-v2 props, derive compound hull data from `colliders.selectedPresetId` or the highest-hull fallback preset, and carry `finalPivot.offset` through to `rootOffset`.
- Parse physics hints from resolved/override payloads, not only legacy top-level fields.
- Keep regression tests that exercise real forge-v2 metadata shape in the shared parser and collider resolver.

## 2026-03-06 - Forge-v2 collider backfills need to write both preset results and missing processed metadata
Root cause:
- Some `generation-approved` forge-v2 props had valid processed GLBs but no `colliders`, no `physics`, and stale `processing.mesh` metrics (`bboxProcessed`, face counts still zero).
- Generating colliders alone was not enough for downstream consumers, because shared runtime code relies on `bboxProcessed` and `finalPivot` as well as the collider presets.

Detection signal:
- Four props under `assets/forge-v2/props` had no collider presets at all, and three of those also had zeroed processed mesh metadata despite existing `processed/model.glb` files.
- User reported that high-detail collider generation felt excessively slow and asked for the same end state as the forge UI's `Compute Colliders`.

Preventive checklist:
- When batch-backfilling forge-v2 colliders, write all configured presets, set `colliders.selectedPresetId`, update `processing.transform.finalPivot`, and mark the prop `physics-approved`.
- Backfill missing `processing.mesh.bboxProcessed` and face counts from the processed/raw GLBs when older props have stale zero values.
- Keep the `high-detail` VHACD preset only moderately above `balanced`; avoid jumps that dramatically increase hull count, point samples, or voxelization work without clear benefit.

## 2026-03-06 - Forge-v2 collider batch selection must match the UI's `Phy missing` semantics
Root cause:
- The batch script filtered `--missing-only` props by absence of collider presets, while the forge-v2 gallery's `Phy missing` filter is driven by props that still need physics approval (`lifecycle.status !== "physics-approved"`).
- That mismatch skipped props like `ammo-crate` and `stop-sign`, which already had some collider data on disk but were still pending physics approval in the UI.

Detection signal:
- Batch verification reported zero props missing colliders, but the asset forge UI still listed two props under `Phy missing`.
- Both props had `generation-approved` lifecycle state even though collider files and `physicsApprovedAt` data were present.

Preventive checklist:
- When a user asks for "the same as the asset forge UI", copy the UI's selection semantics exactly instead of inferring from raw files.
- Keep forge-v2 batch filters aligned with `lifecycle.status` when the UI stage filter is status-based.
- After collider batch runs, verify both the raw asset condition and the UI-equivalent pending set.
