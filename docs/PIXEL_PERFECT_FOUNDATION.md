# Pixel-Perfect Foundation (2:1 Isometric)

## Scope
This document captures the stable invariants and architecture behind
`pixel-perfect-2to1`, and outlines how to extract the mechanics into reusable
foundational code for game experiments.

## Current Invariants
1. Fixed canvas footprint:
   - Canvas CSS size tracks mount size and does not change while zooming.
2. Stable low-res sampling grid:
   - Low-res render target is derived from viewport + DPR baseline (`zoom=1`).
   - Zoom must not recompute low-res grid dimensions.
3. World-to-game-pixel contract:
   - 1 world tile edge (`128cm`) maps to `32` game pixels horizontally and `16`
     game pixels vertically.
   - Contract holds at all zoom levels.
4. Integer upscale:
   - Final scene is upscaled by integer render scale (`round(zoom * dpr)`).
5. Pixel-stable pan:
   - Pointer deltas convert through canvas CSS->device ratios.
   - Camera advances in whole low-res pixel steps with carried remainder.
6. Cursor-anchored zoom:
   - Zoom changes are corrected by pan so world point under cursor stays fixed.
7. Overscan guard band:
   - Output viewport includes low-res overscan to prevent edge bars under
     remainder shifts.

## Runtime Pipeline
1. Resolve device viewport:
   - `css size * dpr`, clamped by WebGL caps.
2. Resolve low-res target (zoom independent):
   - Derived from device viewport and render scale at `zoom=1`.
3. Resolve active output layout:
   - Apply current render scale to low-res target + overscan.
4. Render passes:
   - Scene -> low-res target.
   - Low-res texture -> final viewport using nearest sampling and UV window.
5. Input mapping:
   - Client CSS coordinates map through active scene viewport (excluding
     overscan pad) for both world pick and projection.

## Reusable Building Blocks (Now in `@common/render`)
`packages/common-render/src/pixel-perfect.ts`
- `computeRenderScale`
- `computeViewportDeviceSize`
- `computeLowResolutionSize`
- `computeOutputViewportLayout`
- `computeOrthoHeightForLowResolution`

`packages/common-render/src/pixel-perfect-controller.ts`
- `PixelPerfectController`
- zoom mode + safe ladder logic
- pan phase state/stepping helpers
- resize/layout recomputation against GPU caps
- client <-> scene mapping helpers
- yaw (quarter-turn) state for rotatable isometric cameras

`packages/common-render/src/pixel-stage.ts`
- `PixelStage` host wrapper for renderer/canvas lifecycle
- mount + canvas style ownership with cleanup restore
- resize observer wiring
- canvas css->device metrics helper
- shared WebGL backing-size cap discovery

## Extraction Plan (Foundational Library)
### Phase 1: Core Primitives (done)
- Keep pure sizing/projection helpers in `@common/render`.
- Keep focused tests for invariants and edge cases.

### Phase 2: Controller Layer (done)
- `pixel-perfect-2to1` now delegates pan/zoom/rotate/layout state to
  `PixelPerfectController`.
- Wheel "burst lock" throttling was removed; each wheel event advances exactly
  one zoom step.

### Phase 3: Host Integration (started)
- `pixel-perfect-2to1` now uses `PixelStage` for mount/canvas/resize/cap logic.
- Remaining work: add a higher-level stage orchestration wrapper (optional HUD
  and pluggable render-loop callbacks) so future experiments adopt with minimal glue.

### Phase 4: Feature Extensions
- Add optional modules:
- inertial pan
- bounded camera limits
- touch pinch/zoom
- deterministic replayable input events.

## Camera-based Zoom Prototype
- The `pixel-perfect-camera-zoom` experiment keeps the low-res render target fixed and drives zoom through the orthographic camera height instead of increasing the backing resolution.
- It reuses `PixelStage`/`PixelPerfectController` for pan, layout, and input mappings while handling its own `cameraZoom` multiplier plus cursor-anchor correction so the point under the cursor stays stable.
- This prototype shows how a future experiment can explore camera-based zoom without touching the promoted controller.

## API Shape Proposal
```ts
type PixelStageConfig = {
  referenceLowHeight: number;
  baseOrthoHeight: number;
  overscanLowPixels: number;
  zoomRange: { min: number; max: number };
};

type PixelController = {
  resize(cssWidth: number, cssHeight: number, dpr: number): void;
  panByCss(deltaCssX: number, deltaCssY: number, sx: number, sy: number): void;
  stepZoom(direction: -1 | 1): boolean;
  rotateQuarterTurns(step: -1 | 1): number;
  getScenePointFromClient(x: number, y: number, metrics: CanvasMetrics): Point | null;
  getClientPointFromScene(x: number, y: number, metrics: CanvasMetrics): Point | null;
  getState(): { /* viewport, low-res, scale, pads, zoom/yaw/pan metrics */ };
};
```

## Migration Notes
- Keep current experiment as the integration test-bed for host/view wiring.
- Keep scene setup and camera raycast/projection ownership in the experiment;
  controller owns only deterministic pan/zoom/layout state.
- Preserve existing Playwright interaction probes during extraction.
