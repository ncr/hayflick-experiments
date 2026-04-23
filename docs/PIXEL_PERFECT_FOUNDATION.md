# Pixel-Perfect Foundation (2:1 Isometric)

## Scope

Stable invariants and architecture of `@common/render`'s pixel-perfect iso-2:1
pipeline. The package README covers API shape and usage; this doc is the
authoritative source of truth for the pixel-stable math and the layering.

## Invariants

1. **Fixed canvas footprint.** Canvas CSS size tracks mount size; does not
   change while zooming.
2. **Stable low-res sampling grid.** Low-res render target is derived from
   viewport + DPR baseline at `zoom=1`; zoom must not recompute its
   dimensions. Dimensions are rounded up to even values so the buffer centre
   lands on an integer iso-col.
3. **World→game-pixel contract.** 1 world tile edge (128 cm) = 32 game
   pixels horizontal, 16 vertical. Holds at every zoom level.
4. **Integer upscale.** Final scene upscaled by integer render scale
   `round(zoom · dpr)`.
5. **Pixel-stable pan.** Pointer deltas pass through canvas CSS→device
   ratios; camera advances in whole low-res pixel steps with a carried
   remainder to preserve sub-step input.
6. **Cursor-anchored zoom.** Zoom changes are corrected by pan so the world
   point under the cursor stays fixed.
7. **Overscan guard band.** Output viewport includes a small low-res
   overscan pad to prevent edge bars under remainder shifts.

## Runtime pipeline

1. Resolve device viewport: `css size * dpr`, clamped by WebGL caps.
2. Resolve low-res target (zoom-independent): derived from device viewport
   and render scale at `zoom=1`.
3. Resolve active output layout: apply current render scale to low-res
   target + overscan.
4. Render passes:
   - Scene → low-res target (with optional outline sideband passes).
   - Low-res texture → final viewport using nearest sampling + UV window.
5. Input mapping: client CSS coordinates map through active scene viewport
   (excluding overscan) for both world pick and projection.

## Architecture

The pipeline is layered, not monolithic. Each layer has one job.

```
IsoGameView (facade)                   src/iso-game-view.ts
  └─ SharedScissorStage                src/stage/shared-scissor-stage.ts
       └─ PixelPerfectPane             src/stage/pixel-perfect-pane.ts
            └─ IsoViewport             src/internals/iso-viewport.ts  (orchestrator)
                 ├─ IsoCamera          src/internals/iso-camera.ts
                 ├─ LowResolutionTarget  src/internals/low-resolution-target.ts
                 │    └─ OutputUpscaleMaterial
                 ├─ PixelPerfectController  src/internals/pixel-perfect-controller.ts
                 └─ RotationAnimation + ZoomAnimation  src/internals/viewport-animation.ts
  └─ OutlinePipeline (optional)        src/outline/outline-pipeline.ts
       ├─ LinearDepthMaterial
       ├─ OutlineGroupMaterial
       ├─ WorldPositionMaterial
       └─ EdgeDetectionMaterial
```

- **`IsoGameView`** is a thin facade. Composes stage + pane + optional
  outline; owns mount background save/restore and client↔local CSS.
- **`SharedScissorStage`** owns the shared WebGL context, the single canvas
  positioned behind DOM panes, the RAF loop, and per-frame scissor math.
  Pane elements are DOM anchors measured via `getBoundingClientRect`.
- **`PixelPerfectPane`** is a pane adapter. Auto-sizes its `IsoViewport`
  against the stage's device-pixel backing caps and handles resize/dispose.
- **`IsoViewport`** is the per-pane orchestrator. It runs the per-frame
  update: advance animations → apply pose → resize low-res + output layout
  → drive scene render → upscale to device framebuffer.
- **`IsoCamera`** owns the `THREE.OrthographicCamera` plus screen↔world
  basis. Understands "iso-2to1", "top-down", "side" pitches. Exposes
  `worldAtNdc`, `snapWorldPointOnGround`.
- **`LowResolutionTarget`** owns the low-res RT, the upscale fullscreen quad,
  and the `OutputUpscaleMaterial` shader (smooth pixel transitions or hard
  nearest). Handles MSAA tuning (`setLowTarget`).
- **`PixelPerfectController`** is pure math: pan quantization via two-stage
  carry+remainder accumulation, safe-ladder vs free zoom mode, render-scale
  computation, layout composition.
- **`RotationAnimation` / `ZoomAnimation`** are small state machines:
  exponential approach + smoothstep snap for rotation; dual-rate
  (base + burst) for zoom.

## Outline pipeline (optional)

4-pass pre-process that hooks into the viewport's `beforeSceneRender` /
`afterSceneRender`:

1. Color pass (the scene's normal render, into `colorTarget`).
2. Normal pass (`MeshNormalMaterial` swap).
3. Linear-depth pass (`LinearDepthMaterial`, packed to half-float RGBA).
4. World-position or depth gate pass (same-surface suppression G-buffer).
5. ID pass (`OutlineGroupMaterial` swap, encodes group id as 24-bit RGB).

Edge composite (`EdgeDetectionMaterial`) reads the 5 textures and produces
`postTarget`, which is then the upscale source.

Group assignment controls silhouette merging: meshes with the same group key
hash to the same id and suppress their coplanar seam. The
`assignOutlineGroupsByMaterialName` preset covers the material-name-based
convention.

## Configuration surface

`PixelPerfectDefaults` and `OutlineDefaults` are the frozen reference
tuning; `IsoGameViewConfig` is a partial override. See the README for field
rationale.

## History

The package was extracted from the `pixel-perfect-2to1` experiment in three
phases:

- **Phase 1** extracted pure sizing/projection helpers
  (`computeRenderScale`, `computeViewportDeviceSize`,
  `computeLowResolutionSize`, `computeOutputViewportLayout`).
- **Phase 2** split pan/zoom/rotate state into `PixelPerfectController` and
  layout/animation into viewport + animation classes.
- **Phase 3** consolidated mount/canvas/resize/cap logic into
  `SharedScissorStage` + `PixelPerfectPane` and wrapped both behind the
  `IsoGameView` facade.

A subsequent refactor renamed `PixelPerfectView → IsoGameView`,
`PixelPerfectViewportCore → IsoViewport`, `ThreeScenePane → PerspectivePane`,
flipped outlines default to on, and introduced the
`addStandardGameLighting` / `assignOutlineGroupsByMaterialName` presets to
consolidate duplicated consumer code.

## Migration notes (for integrators)

- Keep scene setup and raycast/projection ownership in the experiment;
  `IsoViewport` owns only deterministic pan/zoom/layout state.
- Preserve existing Playwright interaction probes (`e2e/render-invariants/`)
  during any touch — they are the primary gate on pixel stability.
