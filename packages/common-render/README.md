# @common/render

Pixel-perfect iso-2:1 Three.js rendering foundation. Everything you need to
put a scene on screen with crisp upscaled pixels, stable panning, integer
zoom steps, and painterly depth+normal edge outlines — outlines on by
default because the game uses them.

## Quick start

```ts
import * as THREE from "three";
import { IsoGameView, addStandardGameLighting } from "@common/render";
import { bindIsoGameViewInput } from "@common/input";

const scene = new THREE.Scene();
addStandardGameLighting(scene);
scene.add(myWorld);

const view = new IsoGameView({
  mount,    // HTMLElement that already has layout dimensions
  width,    // initial CSS width
  height,   // initial CSS height
  scene
});
// Defaults: pixelated canvas, outlines ON (OutlineDefaults), iso-2:1 pitch,
// cameraYaw π/4, MSAA 4×, smooth pixel transitions on.

bindIsoGameViewInput({ view });   // MMB pan, Q/E rotate, wheel zoom

let prev = performance.now();
function tick(now: number) {
  const dt = Math.min((now - prev) / 1000, 0.1);
  prev = now;
  view.frame(now, dt);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
```

## Entry points

| You have… | Use |
|---|---|
| One scene, one pane, game-aligned defaults | `IsoGameView` |
| One scene, one pane, opting out of outlines | `IsoGameView` with `outlines: false` |
| One scene, multiple synchronized iso panes (quad view, split view) | `SharedScissorStage` + `PixelPerfectPane` per pane, wired with `bindPixelPerfectPaneBroadcast` |
| One scene, multiple focus-routed panes (2D editor + 3D preview) | `SharedScissorStage` + panes + `bindSharedScissorStageInput` |
| Perspective / orbital asset inspection (not pixel-perfect) | `SharedScissorStage` + `PerspectivePane` |

### `IsoGameView` — the default game view

```ts
new IsoGameView({ mount, width, height, scene });
// All other config is optional — defaults merged from PixelPerfectDefaults
// (see "Configuration" below). Override fields one at a time; the rest
// come from the frozen defaults:
new IsoGameView({
  mount, width, height, scene,
  clearColor: 0x1d2029,
  basePixelZoom: 2,
  outlines: false                   // opt out when prop-inspecting
});
```

`IsoGameView` composes `SharedScissorStage` + `PixelPerfectPane` + (optional)
`OutlinePipeline` internally. When outlines are on (the default), the pipeline
handle is available on `view.outline`.

### `SharedScissorStage` — multi-pane layouts

```ts
import {
  SharedScissorStage, PixelPerfectPane
} from "@common/render";
import { bindPixelPerfectPaneBroadcast } from "@common/input";

// Shadows are a per-renderer flag — opt in at the stage level when any
// pane needs them.
const stage = new SharedScissorStage({ mount, width, height, shadows: true });
const panes = angles.map((yaw) => new PixelPerfectPane({
  stage, id: `pane-${yaw}`, element: cell, scene,
  cameraYaw: yaw
}));
bindPixelPerfectPaneBroadcast({ stage, panes });
stage.start();
```

For mixed-purpose layouts (e.g. 2D editor pane + 3D preview pane on the same
scene), each pane configures its own pipeline declaratively:

```ts
const leftPane = new PixelPerfectPane({
  stage, id: "editor-2d", element: leftEl, scene,
  cameraPitch: "top-down",
  layers: [LAYER_2D_TINT],
  toneMapping: "none"               // keep NoToneMapping for this pane
});

const rightPane = new PixelPerfectPane({
  stage, id: "preview-3d", element: rightEl, scene,
  layers: [LAYER_3D_ONLY],
  toneMapping: "aces",              // ACES + sRGB low target
  shadows: true,                    // warns if stage.shadows is off
  outlines: true,                   // 4-pass outline pipeline
  outlineGroups: {                  // first-frame group assignment
    byName: { blockstudio_accent: "glass", blockstudio_trim: "trim" },
    default: "wall"
  }
});

// When you rebuild a subtree of the scene, re-apply the outline groups:
rightPane.reapplyOutlineGroups(sceneBuilder.root);
```

### `SharedScissorStage` + `PerspectivePane` — asset inspection

```ts
import { PerspectivePane } from "@common/render";

const pane = new PerspectivePane({
  stage, id: "inspector", element: cell,
  scene, camera   // caller-owned THREE.PerspectiveCamera + OrbitControls
});
stage.registerPane(pane);
```

## Presets

### `addStandardGameLighting(scene, options?)`

Three-to-five-light rig for game scenes. Ambient + warm key + cool fill +
hemisphere by default, rim opt-in. All knobs overridable; use the returned
handle to reach specific lights (e.g. to wire shadow frustums).

```ts
import { addStandardGameLighting } from "@common/render";

// Baseline — the standard defaults.
addStandardGameLighting(scene);

// Override individual fields.
const lights = addStandardGameLighting(scene, {
  ambient: 1.0,
  keyDirection: [4, 8, 3],
  shadows: true,
  rim: { intensity: 0.6 }
});
lights.key.shadow.mapSize.set(1024, 1024);
// lights.remove()      — later cleanup
```

Defaults: ambient 0.7, key 0xfff4e0 @ 1.8 from (2, 3, 4), fill 0xb0c4de @ 0.5
from (-3, 4, -2), hemisphere 0xe8edf5 / 0x8a8070 @ 0.5 (on), rim off,
shadows off.

### `assignOutlineGroupsByMaterialName(root, pipeline, map)`

Walks a subtree and assigns each mesh to an outline group by material name.
Same-key meshes produce a single silhouette (tiled walls read as one shape).

```ts
import { assignOutlineGroupsByMaterialName } from "@common/render";

assignOutlineGroupsByMaterialName(root, view.outline!, {
  byName: { blockstudio_accent: "glass", blockstudio_trim: "trim" },
  default: "wall"
});

// Shorthand form (when you only need byName → key):
assignOutlineGroupsByMaterialName(root, view.outline!, {
  blockstudio_accent: "glass"
});

// With predicate escape hatch (runs before byName; return null to fall through):
assignOutlineGroupsByMaterialName(root, view.outline!, {
  byName: { blockstudio_accent: "glass" },
  default: "wall",
  predicate: (mesh) => mesh.name.startsWith("fx-") ? "fx" : null
});
```

### Tileset viewer configs

`TILESET_VIEWER_TARGET_CONFIG` and `TILESET_VIEWER_NORMAL_CONFIG` — canonical
`IsoGameView` tuning for framing a single tileset in a preview pane.

### Pixel-art texture helpers

`applyPixelArtTextureDefaults(texture)` and
`applyPixelArtTextureDefaultsToTree(root)` — nearest filter + half-texel UV
offset for box-projected world-space UVs, required for tilesets where two
coplanar sub-meshes share the same UV scale. The `ToTree` helper traverses
a subtree and applies the defaults to every `MeshStandardMaterial`'s maps.

## Configuration

### `PixelPerfectDefaults`

Frozen reference tuning. Override fields via `IsoGameViewConfig`; the rest
come from here:

```
fixedRenderHeight    240          # low-res scanlines
baseOrthoHeight      4.8 · √2     # iso-2:1 tuning; tile centres on integer iso-cols
cameraDistance       40
cameraPitch          "iso-2to1"   # also: "top-down" | "side"
cameraYaw            π/4          # canonical diagonal
basePixelZoom        1
zoomMin / Max / Step 1 / 8 / 1
zoomAnimationRate    12           # (burst 24) inv-sec
lowTargetSamples     4            # MSAA; 0 to disable
smoothPixelTransitions  true      # 1-device-px fade at texel boundaries
outputOverscanLowPixels 2         # guard band
verticalBias         0.5          # target Y on screen
toneMapping          "none"       # "none" | "aces"; pane auto-derives "aces"
                                  # when outlines are on. Set explicitly to
                                  # also sRGB-tag the low target.
shadows              false        # per-pane "request shadows" flag; actual
                                  # shadowMap toggle lives on the stage.
```

### `OutlineDefaults`

The outline tuning knobs. Applied when `outlines: true` (the default);
override by passing a partial tuning: `outlines: { depthThreshold: 0.1 }`.

```
depthThreshold       0.05          # world-unit silhouette threshold
normalThreshold      0.3           # (1 - dot(n1,n2)) above this = crease edge
idSuppressNormalDot  0.5           # coplanar same-group seams suppress
suppressMode         "world-position" # or "depth" (cheaper, camera-variant)
suppressWorldEps     0.1           # 10 cm same-surface gate
outlineBrightness    1.35
outlineMix           1.0           # 0..1 blend
```

### `PixelView`

`"iso-2to1" | "top-down" | "side"` — discrete camera modes. Each resolves to
a fixed pitch that keeps the screen-to-world projection on the integer-pixel
grid.

## Outlines

A 4-pass pipeline: color → normals → linear depth → ids → edge-composite.
The pane/view owns the outline pipeline's lifecycle; construction flows
through the `outlines` / `outlineGroups` pane config. The handle is
exposed on `pane.outline` / `view.outline`.

```ts
// Outlines on by default for IsoGameView. Grab the pipeline handle to
// customise at runtime.
const view = new IsoGameView({ mount, width, height, scene });
const outline = view.outline!;

// Assign meshes to groups — same key → same id → coplanar same-group seams
// suppress (tiled walls read as one silhouette).
outline.assignOutlineGroup(wallMesh, "wall");
outline.assignOutlineGroupsUnder(root, (mesh) => "wall");

// Declarative form — set `outlineGroups` on the pane/view and the first
// frame applies it. Re-apply after scene-graph rebuilds:
const paneWithGroups = new PixelPerfectPane({
  stage, id: "iso", element, scene,
  outlines: true,
  outlineGroups: {
    byName: { blockstudio_accent: "glass", blockstudio_trim: "trim" },
    default: "wall"
  }
});
paneWithGroups.reapplyOutlineGroups(sceneBuilder.root);

// Typed debug views:
//   "final" | "color" | "depth" | "normals" | "ids" |
//   "edges" | "depth-edges" | "normal-edges"
outline.setDebugMode("edges");

// Runtime tuning knobs that don't need a view rebuild:
outline.setIdSuppression("on");            // "on" | "off"
outline.setSuppressMode("world-position"); // "world-position" | "depth"
```

All 5 materials (`LinearDepthMaterial`, `OutlineGroupMaterial`,
`EdgeDetectionMaterial`, `WorldPositionMaterial`, plus
`OutputUpscaleMaterial` for the upscale path) are exported for custom
assembly if the preset isn't what you want.

### Advanced: custom antialiasing

The pane exposes `getLowTarget`, `setLowTarget`, `setOutputSourceTexture`,
and the `beforeSceneRender` / `afterSceneRender` setters for cases the
declarative config can't cover — most commonly a post-process AA pass
(FXAA / SMAA / MSAA swapping) that runs on the low-res render target.
Reach for declarative `toneMapping` / `shadows` / `outlines` first; only
drop down to the hooks when you genuinely need a pass the library
doesn't ship.

## Pixel-perfect invariants

Full rationale in [`docs/PIXEL_PERFECT_FOUNDATION.md`](../../docs/PIXEL_PERFECT_FOUNDATION.md). Short version:

1. Canvas CSS size tracks mount size; does not change while zooming.
2. Low-res render target derived from viewport + DPR at **zoom=1**; rounded
   up to **even** dimensions so the buffer centre lands on an integer iso-col.
3. 1 world tile edge (128 cm) = 32 game pixels horizontal, 16 vertical — at
   every zoom level.
4. Final scene upscaled by integer render scale = `round(zoom · dpr)`.
5. Pan advances in whole low-res pixel steps with a carried remainder.
6. Zoom changes corrected by pan so the world point under the cursor stays
   fixed.
7. Overscan guard band prevents edge bars under remainder shifts.

## Shared scissor host contract

`@common/render` handles render math (pane rect measurement, scissor rects,
viewport behaviour, draw lifecycle). The **host** HTML/CSS must provide a
stable layout/stacking environment — most "scissor looks wrong" bugs are
host-side CSS issues, not renderer math.

### Host discipline checklist

1. **Pane elements are anchors, not canvases.** The shared canvas renders
   behind DOM. Pane DOM elements are measured (`getBoundingClientRect`) and
   provide chrome / input hit areas.
2. **Keep the pane-to-stage path transparent.** Any opaque background
   between the pane surface and the scissor stage mount can visually hide
   the shared canvas.
3. **Be intentional about clipping.** `overflow: hidden` and `border-radius`
   on pane frames clip the shared canvas visually.
4. **Contain overlays to the stage.** If an experiment mounts a shared
   scissor overlay with `position: fixed`, the host stage container must
   create a containing / paint boundary:
   ```css
   .stage-host { position: relative; contain: paint; isolation: isolate; }
   ```
5. **Reserve higher layers for page chrome.** Headers/toolbars outside the
   stage should have a higher local layer than stage content.
6. **Do not accidentally collapse pane sizing.** Pane hosts must have real
   width/height.
7. **Scroll clipping should crop, not squeeze.** Partially offscreen panes
   should be visually clipped, not resized.
8. **Avoid surprising transforms in pane ancestors.** CSS transforms change
   measured rects and complicate scissor alignment.

### Debug order when a scissor pane looks wrong

1. Check host CSS first (backgrounds, overflow, border radius, z-index,
   containment).
2. Confirm pane rects are measured correctly and sizes are non-zero.
3. Confirm clipping is cropping (not squeezing) when panes are partially
   offscreen.
4. Only then debug camera/aspect/render math.

## Testing

```bash
pnpm --filter @common/render test            # unit tests (fast)
pnpm --filter @common/render test:coverage   # enforces 70/70/60 lines/functions/branches
```

Pixel regressions are caught by a Playwright golden suite under
`e2e/render-invariants/`. Scenes live at `/#/diag/<slug>` (see
`apps/hub/src/pages/diag/registry.ts`). Tests run against a Chromium +
SwiftShader build with `maxDiffPixels: 0` — any pixel shift fails the suite.

Deep outline inspection uses `scripts/outline-testbed/`: captures edge-mode
screenshots + ASCII edge grids for the outline-walls tilesets, with diff
support (`--label before`, then `--diff before`).

`IsoGameView` itself (the facade) is unit-tested with mocked stage/pane. Its
internal pieces — `IsoCamera`, `IsoViewport`, `PixelPerfectController`,
`LowResolutionTarget`, animations, and all 5 outline materials — have their
own unit tests. End-to-end rendering correctness lives in the Playwright
goldens.

## Migration from `PixelPerfectView`

Renames in this release (deprecated aliases stay for one cycle):

| Old | New |
|---|---|
| `PixelPerfectView` | `IsoGameView` |
| `PixelPerfectViewConfig` | `IsoGameViewConfig` |
| `PixelPerfectViewPose` | `IsoGameViewPose` |
| `PixelPerfectViewState` | `IsoGameViewState` |
| `ThreeScenePane` | `PerspectivePane` |
| `ThreeScenePaneConfig` | `PerspectivePaneConfig` |
| `bindPixelPerfectViewInput` (from `@common/input`) | `bindIsoGameViewInput` |

**Behavioural change**: `outlines` now defaults to `true`. Consumers that
don't want outlines pass `outlines: false` explicitly.
