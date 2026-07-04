# Agent Learnings — native Rust renderer

Post-mortems and failure patterns for the Rust workspace (rt-probe renderer,
rt-viewer, house-game). Append new entries chronologically. The pre-pivot
TypeScript-era learnings live on the `main` branch.

## 2026-05-16 — iso 2:1 diagonal wobble + geometry alignment

Three independent bugs surfaced together in the new game-studio playtest
shell. Easy to conflate; each has a distinct root cause and fix.

### Symptom #1 — diagonal wobble (input mapping)

Pressing A+W (screen up-left) made the player box wobble: motion ticked
predominantly horizontally with occasional vertical kicks, instead of
walking a clean diagonal.

Root cause: input was mapped to the camera's `(right, forward)` world-XZ
basis. The screen-pixel lattice `(a, b)` uses different magnitudes —
`|(vx, vz)| = 1/(R·cos π/6)` is `1.155×` `|(ux, uz)|` because the
vertical-on-screen direction is foreshortened. So at constant world
speed in the (right, forward) basis, the `b` coord accumulates ~0.866×
the rate of `a`. Independent `Math.round(a)` and `Math.round(b)` then
cross thresholds on different frames → per-frame deltas alternate
`(1, 0)` / `(0, 1)` → visible wobble.

Wrong fix (don't): coarsen snap to `{a:2, b:1}` ("force" the stair
shape via the lattice). That makes each tick a 2 H or 1 V hop and
amplifies the wobble — the independent rounding problem doesn't go away,
each axis just jumps in bigger chunks.

Right fix: map input directly onto the `(a, b)` lattice with an iso 2:1
ratio in the input itself. `aDir = inputX`, `bDir = -inputY * 0.5`,
normalize. Now a combined-key input traces direction `(2, 1)` in
`(a, b)` space. The independent rounding produces a clean Bresenham
walk: `(1, 0), (1, 0), (0, 1), (1, 0), (1, 0), (0, 1), …` — a perfect
iso 2:1 staircase. Speed becomes screen-pixels-per-second along the
diagonal direction.

Diagnostic / proof: `/Users/ncr/dev/wobble` worktree (detached at
commit `d69cb53`) holds the historical pixel-stable-moving-mesh
experiment retrofitted with the new input mapping and three snap modes
toggleable via N. The wobble is observable side-by-side. The e2e spec
`e2e/game-studio.spec.ts → "A+W diagonal traces a perfect iso 2:1
staircase (no wobble)"` enforces the invariant `|qa - 2·qb| ≤ 1` plus
no-reverse-hops.

### Symptom #2 — outline staircase has mixed-width treads

Even with the wobble killed, the box's silhouette outline showed
irregular treads: some 2 pixels wide, some 3 pixels wide, not a clean
`(2, 1) × N` repeat. This was independent of motion (visible on a
stationary box).

Root cause: grid-walker set `PLAYER_SIZE = 0.8` wu. The horizontal
silhouette edge has projected length `0.8 × 32 = 25.6 px` over
`0.8 × 16 = 12.8 px` vertical — the angle is exactly 2:1, but the
rasterizer must emit integer pixel runs. To approximate 25.6/12.8 it
alternates 2-wide and 3-wide treads. To the eye that's "the staircase
is broken".

Right fix: every XZ dimension must be a multiple of `0.0625 wu` (= 2 H
+ 1 V px = one whole iso 2:1 stair step). Grid-walker's `PLAYER_SIZE`
changed to `1` (= 32 H × 16 V = 16 perfect (2,1) steps). General clean
sizes: 1, 0.75, 0.5, 0.25, 0.125, 0.0625 wu.

Y is exempt — `cos π/6 = √3/2` is irrational, so Y always projects to
fractional pixels. Vertical edges of cubes still project purely
vertical and don't affect the stair pattern.

### Symptom #3 — user can shoot themselves in the foot with #2

A game author setting a "natural-looking" size like `0.8` or `1.2` gets
no error at construction time, only visible artifacts at runtime.
That's a bad API contract for a "rock-solid renderer".

Right fix: `isoCleanGeometryValidator` (in
`packages/common-render/src/scene/iso-geometry-validator.ts`) is wired
into `createThreeScene` via the new `validateGeometry` option and
called at every spawn. Misaligned XZ throws `IsoGeometryViolation` at
the bad call site, with a message naming the bad value, its projected
pixel size, and the nearest valid size. Wired in
`studios/game-studio/src/panes/ViewportPane.tsx` so every game running
through game-studio gets the guard for free.

### Detection signals for future regressions

- Wobble: `e2e/game-studio.spec.ts` (line-drift invariant in A+W).
- Mesh cornerstone: same spec's screenshot diff at two snap cells; must
  be exactly 0 differing pixels.
- Geometry alignment: `IsoGeometryViolation` thrown at spawn time; unit
  tests in `packages/common-render/src/scene/iso-geometry-validator.test.ts`
  cover the predicate + validator surface.

### Preventive checklist

- New `Scene.spawn*` primitives must thread XZ dimensions through the
  validator. Don't add a primitive that bypasses it.
- New experiments must pick stair-aligned XZ sizes. Use multiples of
  `0.0625` as the smallest unit; if you genuinely need a non-stair size
  for a debug primitive, do not wire the validator (and document why).
- Don't reintroduce coarser snap granularity as a "stair stabilizer";
  the stair shape belongs in input shaping, not in snap quantization.
  See CLAUDE.md invariants #8 and #9.

### Symptom #4 — low-speed motion looks choppy / non-stair

Set player speed below ~60 px/s and pressing A+W produces "left tick …
long pause … up tick … long pause" rather than a connected staircase.

Root cause: at low speed, the per-frame `(da, db)` deltas are sub-1-pixel,
so `Math.round(a)` and `Math.round(b)` cross thresholds many frames
apart. The cumulative trajectory still hugs the iso 2:1 line (the test
still passes — drift stays ≤ 1) but the timing between ticks is now
visible. The math:

  At 60 fps, dominant-axis advance per frame = `ISO_INPUT_DIAGONAL_A_RATE × v / 60`
  ≈ 0.0149·v. For ≥ 1 advance/frame: `v ≥ 60 / 0.894 ≈ 67 px/s`.

Right fix: `recommendedMinPxPerSecForIso({ targetFps })` in
`@common/gameplay`. Returns the dominant-axis-fluid threshold (default
67 @ 60 fps) or the full-stair-per-frame threshold (134 @ 60 fps).

Use it as a knob `min` so the tweak UI can't dial below the smooth zone:
grid-walker does `min: ceil(recommended/10)*10 = 70`. This is a
*recommendation*, not a hard floor — slow motion is sometimes desirable
(stealth, cinematic). Below the threshold motion is still **correct**
(no wobble, no drift), just visibly discrete.

What this is NOT: a renderer bug. The cornerstone and trajectory
invariants both hold below the threshold. The threshold is a perceptual
property of the snap, not a stability property.

## 2026-06-09 — native viewer screen-px→world basis missed the iso vertical foreshortening

Root cause:
- `native/rt-probe`'s held-key movement converted screen-pixel deltas to world
  ground deltas as `right_floor·(dx/R) - fwd_floor·(dy/R)` — treating one
  vertical screen pixel as the same ground distance as one horizontal pixel.
  In the iso 2:1 view the ground is foreshortened vertically by
  `sin(pitch) = 1/2`, so **one px down = 2/R wu** toward the camera (the web
  `IsoCamera.getSnapBasis()` gets this for free from its ground-plane raycast).
  Effect: vertical screen speed halved; an up+right walk traced a 4:1 screen
  line instead of the engine's 2:1 stair.

Detection signal:
- No visual test caught it — the existing lib tests pinned `iso_input_dir`
  (the px-space direction) but not the px→world mapping that followed it.
  Found by line-by-line comparison against `createControlledInputSystem` +
  `getSnapBasis` while rematching the web grid-walker.

Preventive checklist:
- When mirroring engine math natively, mirror the *basis* functions too and
  unit-test round trips: project the native world delta back to screen px and
  assert the engine's published rates (`ISO_INPUT_DIAGONAL_A/B_RATE`, the 2:1
  ratio). `rt-probe` now has `iso_pixel_basis()` / `screen_px_to_world()` /
  `snap_ground_to_lattice()` with exactly those tests.
- The web engine snaps every rendered mesh position to the screen-pixel
  lattice (`snapWorldPointOnGround`, nearest, (1,1)) while the ECS transform
  stays continuous. A native port must do the same split: continuous
  `player_pos`, snapped TLAS instance transform — and can use "snapped cell
  changed" as the re-render trigger (saves accumulation resets in a path
  tracer).
- `SCENE=grid` runs the native grid-walker rematch (fixed camera, speed 80,
  open level); `WALK=<secs>` + `SHOT=` is the headless held-key harness since
  winit input can't be scripted.

## 2026-06-09 — path tracer primary-ray jitter destroys the low-res pixel look

Root cause:
- `rt-probe`'s trace shader jittered the primary ray inside each low-res pixel
  (`px + rnd()`), which is standard path-tracer AA. Under the pixel-perfect
  contract that is exactly wrong: edge pixels accumulate fractional coverage,
  so the 2:1 staircase and 1-px grid lines render soft even though the
  upscale is integer-NEAREST. The web raster path is binary per low pixel
  (MSAA deliberately off — see the 2026-04-21 entry).

Detection signal:
- User compared screenshots: native box edges smooth, web box edges hard
  pixel stairs. The pipeline-level invariants (#2/#4 integer upscale) all
  held — the blur was baked into the accumulation buffer itself.

Preventive checklist:
- In any stochastic renderer feeding the pixel-perfect pipeline, the primary
  ray must go through the **pixel centre deterministically**; keep randomness
  only in bounce/light sampling (lighting converges, geometry stays binary).
  Crisp is the default; `AA=1` env opts into jitter for photoreal stills.
- "Integer NEAREST upscale" alone does not guarantee the pixel look — the
  low-res buffer contents must also be aliased (one binary visibility sample
  per pixel). Check both ends when a port looks soft.

## 2026-06-09 — lamp-lit path tracing needs NEE; "conceptual" lights need no geometry

Context: stylizing `rt-probe` (no sun, interiors lit by lamps; grade + fixed
palette + grain + height fog).

Root cause of the first failure: small emissive boxes (sconces, bulbs) were
added as geometry only. Random hemisphere bounces almost never hit a
0.1-wu-radius emitter, so even 2000 spp stayed salt-and-pepper noisy and the
rooms barely lit. Brute-forcing radiance up just trades darkness for fireflies.

What works:
- **Next-event estimation**: extract every emissive primitive (plus explicit
  geometry-less entries) into a light buffer (bounding sphere + radiance);
  sample a few per diffuse hit with solid-angle weighting; add surface
  emission only on directly/specularly-seen hits (`fromSpec`) to avoid double
  counting. 4 NEE samples/hit is ~free at this scene scale (0.6 ms frames).
- **Firefly clamp**: clamp the NEE term on indirect (b>0) hits — a bounce ray
  landing next to a lamp otherwise gets a huge solid angle through `thru`.
- **Conceptual lights** (user request: no visible ceiling fixtures): entries
  appended to the NEE list with NO geometry behind them. Nothing renders,
  nothing occludes at the source; rooms are lit "from the ceiling" that is
  never drawn. `Scene::point_lights` → appended in `SceneGpu::build`.
- Bigger emitter area at lower radiance converges fundamentally better than
  small-and-bright.

Stylized post stack invariants:
- All post (grade → grain → ordered-dither palette) runs **per LOW-RES texel**
  inside the tonemap pass, before the integer upscale — one game pixel = one
  post sample, so the pixel look survives. Ordered Bayer dither (not error
  diffusion) keeps it deterministic per pixel: no temporal shimmer.
- The GPU shader (`tonemap.comp`) and the CPU capture path
  (`capture_denoised` in viewer.rs, via `post_grade/post_grain/post_palette`
  in lib.rs) implement the same stack — keep them in sync or DENOISE=1 shots
  silently diverge from the live view.
- Height fog lives in the TRACE pass (primary segment only, closed-form
  optical depth, y clamped ≥ 0 so a void miss doesn't integrate unbounded
  density). It re-weights radiance smoothly and never moves hits, so fog is
  pixel-look-safe.

## 2026-06-10 — per-frame Monte Carlo can't be patched into stability; move the randomness to world space

Context: a dozen rounds of stabilizing `rt-probe`'s progressive path tracer
during camera motion (accumulation shift, seed correlation, SPP bursts,
always-on guided OIDN, demodulated + reprojected + clamped temporal history,
settle snapping). Every patch reduced one artifact and exposed another:
flicker became mush, mush became smear, smear became "lights dance".

Root cause (first principles): the per-frame image was a RANDOM VARIABLE — a
screen-space Monte Carlo estimate that re-rolls under any camera change. The
web renderer is stable because a rasterized frame is a pure deterministic
function of (scene, camera). No amount of variance-hiding gives you that
property back; the stack of stabilizers IS the artifact generator.

What works (`DET` mode, now the viewer default):
- **World-space irradiance probe cache** (`probes.comp`): ambient-cube probes
  on a 0.5-wu grid, path-traced with fixed spherical-Fibonacci ray sets at
  startup (~13k probes × 2048 rays ≈ 100 ms on the 5080), then FROZEN. Camera
  motion cannot invalidate world space. The dynamic player is excluded via a
  TLAS mask channel (player 0x05; probe rays cull 0x0A) so the cache never
  goes stale as it moves.
- **Deterministic per-frame shade** (`shade.comp`): 1 primary ray per pixel
  centre + deterministic shadow rays (sun + every significant light,
  contribution-culled) + probe lookup for GI. ZERO randomness per frame.
- Result: fixed camera ⇒ bit-identical frames (max pixel diff 0 across 70+
  frames, lab AND house); every rotation-sweep frame has settled quality
  (no convergence tail at all); house frames ~0.4 ms at >1M low-res px where
  the burst path tracer took 79 ms. The whole temporal stack goes dormant.
- Split of labour: shade owns direct light + camera-visible emission; probes
  own 1+-bounce light + sky and never count first-hit emissive (no double
  counting). Probes assume Lambertian — fine for the matte iso look.

Companion bug that blocked the comparison: glTF defaults `metallicFactor` to
1.0, and rt-probe never samples metallic-roughness textures — so every
Polyhaven tile-kit wall/floor (MR texture present, factor 1.0) loaded as
metallic=1: specProb=1, NEE disabled on all kit surfaces, the whole house lit
only via rough-specular chains (dim, slow, impossible to match with a
Lambertian pass). An unsampled MR texture means factor 1.0 is "unspecified",
not "gold" — treat ≥0.999 as dielectric (`gltf_scene.rs`). The fix brightened
the path-traced house ~2× (NEE finally applies); EXPOSURE/EMIT are the mood
knobs to retune on top.

## 2026-06-13 — bit-exact goldens silently captured at the window manager's size, not the requested one

Context: `rt-probe`'s golden gate (`bin/golden`) byte-compares SHOT PNGs of the
house/lab/grid scenes against checked-in references — the ship gate for the
deterministic renderer. SHOT originally ran through the real winit event loop:
it opened a window, let the swapchain take whatever inner size the compositor
granted, rendered, and captured. The checked-in goldens were 1143×652 — a size
nobody asked for. `WINDOW=1024x640` was set, but Hyprland tiled/decorated the
window to its own dimensions, so the capture extent was the WM's decision, not
the env var's.

Root cause: the capture size was an OUTPUT of the windowing system, not an
INPUT to the renderer. That makes the golden a function of (scene, camera,
**compositor layout, window rules, decorations, monitor**) — none of which are
in the repo. The gate passed only on the exact machine + WM state that
generated it; a different monitor, a tiling-rule change, or a headless CI box
would re-render at a new size and fail every scene identically, looking like a
renderer regression when nothing in the renderer changed. A `hyprctl
windowrule` hack was bolted on to force the size — papering over the coupling
rather than removing it.

Fix (the headless SHOT path): when `SHOT` is set, short-circuit before the
winit loop entirely. Build the Vulkan instance with no WSI/surface extensions,
pick the device on RT extensions + a bare compute queue (no swapchain, no
present support), and build the offscreen storage images at an extent taken
**verbatim from `WINDOW`** (default 1280×800). No window, no compositor, no
present — the capture size is now a pure input. Goldens regenerated once at
exactly 1024×640 and verified bit-stable across three independent runs per
scene. The `hyprctl` hack is gone; `bin/golden` no longer needs Hyprland (or
any display) at all.

Preventive checklist:
- For any pixel-exact/byte-exact capture gate, the capture dimensions MUST be an
  explicit input the test controls — never whatever a window manager, monitor,
  or DPI setting hands back. Assert the captured size equals the requested size.
- Treat "all goldens fail by the same amount" as a likely *environment* change
  (size, driver, GPU), not a content regression — re-check the capture extent
  and hardware before hunting the renderer.
- Goldens that depend on a specific GPU + driver float behaviour are
  machine-local artifacts; keep them out of generic CI unless the hardware is
  pinned, and document that in the gate script header (done in `bin/golden`).
- If you find yourself adding a compositor/WM rule to make a test pass, that is
  the smell: remove the dependency on the WM instead of constraining it.
