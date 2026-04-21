# @common/render

Pixel-perfect iso-2:1 Three.js rendering foundation. Everything you need to
put a scene on screen with crisp upscaled pixels, stable panning, integer
zoom steps, and — if you want them — painterly depth+normal edge outlines.

## When to use which thing

| You have… | Use |
|---|---|
| One scene, one pane, want it to look right | `PixelPerfectView` |
| One scene, one pane, want crisp outline edges | `PixelPerfectOutlinedView` |
| One scene, multiple synchronized panes (quad view, split view) | `SharedScissorStage` + `PixelPerfectViewportCore` per pane, wired with `bindPixelPerfectPaneBroadcast` |
| One scene, multiple focus-routed panes (2D editor + 3D preview) | `SharedScissorStage` + cores + `bindSharedScissorStageInput` |
| Per-pane scenes (each pane owns its own `THREE.Scene`) | `SharedScissorStage` + `ThreeSceneScissorPane` |

See `docs/PIXEL_PERFECT_FOUNDATION.md` for invariants (they're at the bottom
of this file too).

---

## `PixelPerfectView` — single scene

```ts
import * as THREE from "three";
import { PixelPerfectView } from "@common/render";
import { bindPixelPerfectViewInput } from "@common/input";

const scene = new THREE.Scene();

const view = new PixelPerfectView({
  mount,            // HTMLElement that already has layout dimensions
  width,            // initial CSS width
  height,           // initial CSS height
  scene,
  // Everything else is optional — defaults tuned for iso-2:1 tile art
  // (see PixelPerfectDefaults). Only list what actually differs.
  basePixelZoom: 2,
  clearColor: 0x1d2029
});

bindPixelPerfectViewInput({ view });  // MMB pan, Q/E rotate, wheel zoom

// RAF loop:
function tick(now: number) {
  view.frame(now, deltaSeconds);
  requestAnimationFrame(tick);
}
```

`PixelPerfectDefaults` (exported) bakes in the reference tuning:
`fixedRenderHeight = 240`, `baseOrthoHeight = 4.8·√2`, `cameraPitch =
"iso-2to1"`, `cameraYaw = π/4`, MSAA 4×, smooth pixel transitions on.
Override fields one at a time; the rest come from the frozen defaults.

---

## `PixelPerfectOutlinedView` — single scene + edges

```ts
import { PixelPerfectOutlinedView } from "@common/render";

const outlined = new PixelPerfectOutlinedView({
  mount, width, height, scene,
  outline: {
    // Optional — these are the defaults shown for reference.
    depthThreshold: 0.05,
    normalThreshold: 0.3,
    idSuppressNormalDot: 0.5,
    outlineBrightness: 1.35,
    outlineMix: 1.0
  }
});

// Assign meshes to outline groups — same key → same id → coplanar
// same-group seams suppress (tiled walls read as one silhouette).
outlined.assignOutlineGroup(wallMesh, "wall");
outlined.assignOutlineGroup(glassMesh, "glass");
outlined.assignOutlineGroupsUnder(rootObj, (mesh) => {
  if (materialName(mesh) === "blockstudio_accent") return "glass";
  return "wall";
});

// Typed debug views:
//   "final" | "color" | "depth" | "normals" | "ids" |
//   "edges" | "depth-edges" | "normal-edges"
outlined.setDebugMode("edges");

outlined.frame(now, deltaSeconds);
```

Behind the scenes: a 4-pass pipeline (color → normals → linear depth → ids
→ edge-composite) using `LinearDepthMaterial` (ortho-safe view-z) and
`EdgeDetectionMaterial` (depth + normal + id with asymmetric L/U ≤ vs R/D <
tie-break). All exported for custom assembly if the preset isn't what you want.

---

## `SharedScissorStage` — multi-pane (broadcast)

```ts
import {
  SharedScissorStage,
  PixelPerfectViewportCore,
  PixelPerfectScissorPane
} from "@common/render";
import { bindPixelPerfectPaneBroadcast } from "@common/input";

const stage = new SharedScissorStage({ mount, width, height });

const panes = angles.map((angle) => {
  const core = new PixelPerfectViewportCore({
    width: cell.clientWidth, height: cell.clientHeight, scene,
    cameraYaw: angle,
    maxBackingWidth: stage.maxBackingWidth,
    maxBackingHeight: stage.maxBackingHeight,
    devicePixelRatio: stage.getDevicePixelRatio()
  });
  const pane = new PixelPerfectScissorPane({
    id: `pane-${angle}`, element: cell, core
  });
  stage.registerPane(pane);
  return pane;
});

bindPixelPerfectPaneBroadcast({ stage, panes });
stage.start();
```

For **focus-routed** panes (input only affects the pane under the cursor),
use `bindSharedScissorStageInput` instead.

---

## Testing

Promoted primitives run under `pnpm test:promoted` with coverage gates:

```bash
pnpm --filter @common/render test            # unit tests (fast)
pnpm --filter @common/render test:coverage   # enforces 70/70/60 lines/functions/branches
```

`PixelPerfectOutlinedView` itself isn't unit-tested (needs a real WebGL
context); its constituent materials (`LinearDepthMaterial`,
`OutlineGroupMaterial`, `EdgeDetectionMaterial`, `OutputUpscaleMaterial`) are.

---

## Pixel-perfect invariants

Full rationale in `docs/PIXEL_PERFECT_FOUNDATION.md`. Short version:

1. Canvas CSS size tracks mount size; does not change while zooming.
2. The low-res render target is derived from viewport + DPR at **zoom=1**
   and is always rounded up to **even** dimensions so the buffer centre
   lands on an integer iso-col (the fix from `fb7e6d9`).
3. 1 world tile edge (128 cm) = 32 game pixels horizontal, 16 vertical —
   holds at every zoom level.
4. The final scene is upscaled by integer render scale = `round(zoom · dpr)`.
5. Pan advances in whole low-res pixel steps with a carried remainder.
6. Zoom changes are corrected by pan so the world point under the cursor
   stays fixed.
7. Overscan guard band prevents edge bars under remainder shifts.

---

## Shared Scissor Host Contract

`@common/render` handles render math (pane rect measurement, scissor rects,
viewport behaviour, draw lifecycle). The **host** HTML/CSS must provide a
stable layout/stacking environment — most "scissor looks wrong" bugs are
host-side CSS issues, not renderer math.

### Responsibilities

- `@common/render`: scissor math, viewport/scissor correctness, per-pane
  rendering lifecycle.
- Host HTML/CSS: sizing, overflow, clipping, transparency, z-index, stacking
  contexts, scroll behaviour.

### Renderer Invariants

- Shared scissor rendering must treat the pane viewport and the visible
  clip/scissor rect as separate concepts during partial offscreen rendering.
- Use the pane's full (unclipped) viewport origin/size for viewport-relative
  placement.
- Use the clipped visible rect only for `setScissor(...)`.
- If the clipped rect is reused as the pane viewport origin, content can
  appear "sticky" at scroll boundaries when panes start clipping offscreen.

### Host Discipline Checklist

1. **Pane elements are anchors, not canvases.** The shared canvas renders
   behind DOM. Pane DOM elements are measured (`getBoundingClientRect`) and
   provide chrome / input hit areas.
2. **Keep the pane-to-stage path transparent.** Any opaque background between
   the pane surface and the scissor stage mount can visually hide the shared
   canvas.
3. **Be intentional about clipping.** `overflow: hidden` and `border-radius`
   on pane frames clip the shared canvas visually.
4. **Contain overlays to the stage.** If an experiment mounts a shared
   scissor overlay with `position: fixed`, the host stage container must
   create a containing / paint boundary:

   ```css
   .stage-host {
     position: relative;
     contain: paint;
     isolation: isolate;
   }
   ```

5. **Reserve higher layers for page chrome.** Headers/toolbars outside the
   stage should have a higher local layer than stage content.
6. **Do not accidentally collapse pane sizing.** Pane hosts must have real
   width/height — watch out for reusable `height: 100%` styles without a
   sized parent.
7. **Scroll clipping should crop, not squeeze.** Partially offscreen panes
   should be visually clipped, not resized/compressed.
8. **Avoid surprising transforms in pane ancestors.** CSS transforms change
   measured rects and complicate scissor alignment.

### Debug order when a scissor pane looks wrong

1. Check host CSS first (backgrounds, overflow, border radius, z-index,
   containment).
2. Confirm pane rects are measured correctly and sizes are non-zero.
3. Confirm clipping is cropping (not squeezing) when panes are partially
   offscreen.
4. Only then debug camera/aspect/render math.
