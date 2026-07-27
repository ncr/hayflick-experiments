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
  Crisp is the default; jitter stays forbidden outright. (`AA` means
  something else since 2026-07-25: the contour-coverage strength — fixed
  offsets, contour-gated, never a jittered centre ray.)
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

## 2026-07-09 — FLOORCUT slabs must sit ENTIRELY above the cut plane

Context: wiring the thief M2 scene's roofs to the live FLOORCUT reveal
(cut plane at `2.5·floor + 2.25`).

Root cause: the roof slab was authored at `WALL_TOP..WALL_TOP+0.125`
(2.1875..2.3125) — STRADDLING the 2.25 cut. The FLOORCUT loop dissolves a
hit only when `hit.y >= cutY`; the primary ray dissolved the slab's TOP face
(2.3125 ≥ 2.25), re-traced, and then hit the slab's INTERIOR BOTTOM face at
2.1875 < 2.25 — which shaded normally. The "removed" roof rendered as its
own dark underside, lit by interior lamps (read as broken striping, worsened
by overlapping per-row slabs).

Fix + rule: geometry the cut must remove has to live ENTIRELY above the cut
plane — both faces. The tower spike already encoded this (ceiling slab
2.375..2.5 vs cut 2.25); the thief roofs now use the same band
(`STOREY_H-0.125..STOREY_H`). If a cap must visually touch the wall top,
move the CUT, not the slab, and keep `wall_top < cut < slab_bottom`.

Detection signal: a "cut-away" slab that still renders, but dark and lit
from inside the room — that is its underside, not a reveal failure.

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

## 2026-07-09 — A parallel game loop must re-anchor EVERY player-anchored effect

Context: SCENE=thief runs its own `ThiefLoop` beside the house `GameLoop`
(which idles as a light-join mirror with no "player" run). M2 wired the
thief loop into the camera, instances, stamps, sky and FLOORCUT — and the
slice shipped. The owner's first playtest verdict included "it's not really
clear what's inside": part of that was the CAVE_ROI see-through disc, which
was still anchored on `self.game.snap.player_pos` — the *mirror's* static
spawn point. The reveal never followed the thief, so walking behind any
building simply hid the player, and nobody noticed for a whole milestone
because the golden frames the spawn cell, where the stale anchor and the
true player coincide.

Root cause: integrating a parallel loop by grepping for where the old loop
feeds the renderer finds the *data* joins (instances, lights, time), but
player-anchored EFFECTS (reveal discs, follow cams, spotlights, audio
listeners) read the player through scattered `self.game.snap.*` paths that
don't fail loudly when the mirror has no player — they just produce a
plausible constant.

Fix + checklist:
- `roi_info()` now prefers `self.thief.cam_target()`; the golden stayed
  byte-identical (spawn == anchor there — exactly why the gate missed it).
- When adding a parallel sim loop, enumerate every read of the old loop's
  player (`snap.player_pos`, `snap.facing`, `has_player`…) and decide each
  one explicitly; a golden framed at spawn cannot catch stale anchors —
  verify with a DEMO frame mid-route, behind an occluder.
- The CMDS replay prefix has the same class of trap: presentation state
  (eases) seeded from tick 0 glides after the prefix, so a SHOT right after
  `run_cmds` captured bodies at their PRE-replay cells. Snap presentation
  state to sim truth at the end of any replay prefix.

## 2026-07-12 — fixed-size GPU bake batches silently outgrow the watchdog

Context: the Faza-0 town testbed (40k GI probes, 48 NEE lamps) intermittently
failed the Metal probe bake with command-buffer status `Error` at a random
batch (`probe bake batch failed (bank N, ray M)`), on a path that had been
rock-solid for months.

Root cause: the bake used a FIXED 32-rays-per-command-buffer batch, tuned on
a 13k-probe / 3-lamp scene. Batch cost scales with probes × lights (every
bounce NEE-samples every light), so the town's batches ran ~40× longer and
intermittently crossed the macOS GPU watchdog. Nothing was wrong with the
shader — the schedule was stale.

Fix: `metal_backend.rs` derives the batch from `probe_count × (light_count+8)`
(clamped 2..32), so per-cb work stays roughly constant as scenes grow.

Detection signal: NON-deterministic command-buffer `Error` at varying batch
indices on a bigger-than-usual scene = wall-clock watchdog, not a logic bug.

Preventive checklist: any fixed GPU batch size is an implicit assumption
about scene size — derive it from the actual per-item cost factors, and say
which factors in a comment.

## 2026-07-12 — replacing a trig-chain camera with an exact derivation flips FP-fragile seam pixels

Context: Faza 1a replaced `iso_basis` (f32 sin/cos of yaw/pitch + cross +
normalize) with `Projection::derive` (closed-form f64 solve from the two
integer ground-axis pixel images, cast to f32 at the end). The iso21 preset
is algebraically the SAME camera.

Observation: the before/after gym SHOT still differed in 2544 px of 1.024M
(0.25%). Diagnosis order that worked: (1) diff-mask image — scattered
1–4 px speckles, all at geometry seam junctions, none in open gradients →
not a framing/offset bug; (2) compare both bases at f32: `right`
bit-identical, `dir`/`up` off by exactly 1 ulp on two components. A 1-ulp
basis change moves every primary ray by ~1e-7 wu, which only matters for
rays grazing world-lattice seam planes — the same FP-fragile population
PIXEL_CENTER_TIE exists for. The f64-derived value is the MORE exact one.

Rules:
- An ulp-level camera change is indistinguishable from "no change" except
  at seam-grazing pixels; expect ~0.1–0.3% speckle diff on greybox scenes
  and read a diff MASK (structure vs speckle) before hunting bugs.
- "All diffs are isolated speckles at silhouette/seam junctions" = FP
  reclassification; "any diff forms lines/regions" = a real offset bug.
- Byte goldens must be re-pinned after ANY basis-derivation change, even a
  provably-more-exact one (they pin bit behaviour, not correctness).

## 2026-07-12 — a rolled axonometric camera breaks wall verticals into stairs

Context: the first `trimetric` preset copied the authentic Fallout floor
lattice ((4,1)/(-4,3) primitive steps). Geometrically valid, derived
cleanly — and the owner's first look at it: "pionowe ściany nie są pionowe,
schodki na pionowych elementach".

Root cause: that lattice implies ~3.7° camera ROLL (its ground images have
`C = a1·b1 + a2·b2 ≠ 0`). Under roll the world Y axis projects to a
slightly tilted screen line (x-extent `S·r̂y` px/wu ≈ -2.8), so every wall
edge rasterizes as a ragged ~1:14 stair instead of one pixel column.
Ground-axis stairs were fine — the failure lives ONLY on verticals, which
is exactly where pixel-art eyes are least forgiving. (Fallout itself gets
away with it because its art is pre-rendered sprites, not runtime rays.)

Fix (by construction, not tuning): `Projection::derive` now REJECTS data
with `C ≠ 0` — the wall contract "world-vertical projects screen-vertical"
is a representability constraint, not a preset convention. The Fallout-
spirit preset became (32,8)/(-16,16): X keeps the authentic 4:1 Fallout
stair (14°), Z is a clean 1:1 diagonal, pitch exactly 30°, and BOTH ground
axes get uniform stair runs (primitives (4,1)/(-1,1)).

Rules:
- For any axonometric preset, check `a1·b1 + a2·b2 = 0` FIRST. Nonzero =
  roll = leaning verticals, regardless of how authentic the source lattice.
- "Authentic reference projection" ≠ "valid pixel-art projection" — sprite
  games can paint verticals vertical under a rolled camera; a renderer
  cannot.
- Prefer primitive stair vectors of the (n,1) form on ground axes: uniform
  runs. Mixed-run primitives like (-4,3) read as "broken staircase" (see
  the 2026-05-16 learning).

## 2026-07-12 — coplanar faces of DIFFERENT colours strobe under camera motion

Context: right after the 0.1-wu re-grid of the gym architecture, the owner
reported white points flickering on the walls' narrow end faces during
movement.

Root cause: the re-grid made the timber-post half-width (0.1) equal to
WALL_HT (0.1), so an end post's outer face became EXACTLY coplanar with
the wall slab's end cap (before: 0.09375 vs 0.125 — 1/32 wu apart, no
overlap). Two triangles in one plane give the ray query two hits at
identical t; the winner is deterministic per exact ray but flips on
sub-pixel camera motion — with a DARK post over a NEAR-WHITE wall
(scifi), the losing colour strobes through as white pixels. The same
mechanism (post top coplanar with wall top) had been producing the older
"dark ragged junction" speckle all along.

Diagnosis pattern that worked: deterministic DEMO dump → motion-
compensated frame diff (align by integer camera shift, then threshold) →
crop the hotspots and LOOK. First suspect (ROI stipple) was cleared in
one experiment: identical flicker metric with ROI=0.

Fix + the rule (gym_scene "COPLANARITY RULE" comment): dress geometry of
a DIFFERENT colour must never share a face plane with its host — offset
it by a whole lattice step, inward or outward (end posts now extend 0.1
past the slab and swallow the end cap; post tops sit 0.0625 above the
wall top; the plinth is strictly the proudest at the base). Same-colour
coplanarity (rail vs posts) is benign — the winner is invisible.

Checklist for any lattice/dimension change: after re-gridding, AUDIT for
newly-equal offsets between touching boxes of different colours — every
pair that lands on the same plane is a strobe. Equality that "looks
tidy" in data (half-widths matching) is exactly the hazard.

## 2026-07-12 — Metal frames are bit-stable within a run, NOT across process runs

Context: verifying the Faza-1b runtime look switch. `LOOK=tecta
LOOK_SWITCH=sorbet SHOT=…` was expected to be byte-identical to a direct
`LOOK=sorbet` boot. It differed by 12 px × 1 LSB — but so did two direct
runs of the SAME config: the diff was the process, not the code path.

Observation: across process runs the Metal gym frame has an intermittent
noise floor of up to ~a dozen pixels × 1 LSB (sometimes exactly 0 — the
Faza-1b neutrality check got byte-identical at iso21 and 4 px at
trimetric). Most likely source: the GPU acceleration-structure build is
not bit-deterministic across runs (BVH layout varies), so seam-grazing /
equal-t rays reclassify by 1 ulp. WITHIN one process, a fixed camera still
produces bit-identical frames (the 2026-06-10 determinism contract is
per-run).

Rules:
- Never verify a Metal render change by byte-comparing PNGs from two
  separate process runs and expecting 0. Establish the same-config
  cross-run noise floor first (run the baseline twice); a change is
  "neutral" when its diff matches that floor in count AND magnitude
  (isolated speckles, ≤1 LSB).
- For equivalence checks between two code paths, capture both inside ONE
  process where possible (`LOOK_SWITCH` exists exactly for this).
- Re-pinning byte goldens on Metal must account for this floor: pin from
  one run and compare with a ≤1-LSB/≤20-px tolerance, or the gate will
  flake. Vulkan/RTX may have a different floor — measure before assuming.

## 2026-07-12 — cutaway × thick see-through geometry: two failure modes

Adding real tinted-glass window panes (0.3 wu thick, proud of the wall,
side-buried 0.1 into the piers) to the WALLCUT dollhouse cutaway produced
two distinct artifacts. Diagnosed by rendering the same CMDS frame under
`WALLCUT=<y>` / `ROI=0` / `DEBUG_ALBEDO=1` sweeps and, decisively, by a
TEMPORARY paint-debug in the Metal shader (tint-path → magenta,
backface-final → green): pixel colors tell you which code path a stray
column actually took — minutes, vs. hours of hit-sequence theorycrafting.

### Failure #1 — floating glass plates over cut windows

The wallcut prefix loop's far-face rule (`wallPass && h.t <= 0.6`) is
tuned to one 0.2-wu wall slab. A pane is 0.3 thick and crossed OBLIQUELY:
through a Z-boundary pane the trimetric ray travels `0.3/|d.z| ≈ 0.78` wu
face-to-face. When the front face sits just above the cut plane and the
far face lands below it, the far face fails both the height test and the
0.6 bound → the loop breaks ON the pane's far face → a glass plate floats
over every cut window (band height = crossing · |d.y| ≈ 0.39 wu).

Fix: widen the far-face bound for GLASS hits only (`pad & 2 → 1.0`; the
in-glass path is bounded by thickness/|d.axis| ≤ 0.78). Keep 0.6 for
walls — an unbounded or generous global bound would punch through real
second walls, and an unconditional glass pass would dissolve legit stub
slots reached over the roof (wallPass persists across the room's air gap).

### Failure #2 — dark 1-2 px "antennas" on window stubs

Not a code bug: the opening's porcelain JAMB stands to the same 1.0 stub
height as everything else, but sits 0.25-0.45 wu deeper along the view
than the pane's proud front — same world height projects HIGHER on screen
at depth, so the jamb's cut edge pokes above the pane-stub silhouette as
a thin column, and it renders near-black because the pane (still solid in
the TLAS) blocks its sun. Any deeper-but-equal-height geometry behind a
dissolve-boundary silhouette can do this.

Fix: cut glass 0.3125 HIGHER than walls (`wy = wallY + 0.3125` for glass
hits) — the taller dark stub covers the jamb sliver and doubles as a
design echo of the pane's proud crown lip. Geometry-side alternatives all
lose: exact-width panes z-fight the jamb planes (coplanarity rule),
recessed panes keep the shadowed sliver, air gaps read as see-through
slits.

## 2026-07-17 — demo composition must respect the ROI screen disc (and the follow-cam)

Context: staging the phase-3 wall-smash demo (a real gym wall bursts into
physics bricks). Four spawn attempts failed before one worked, all for
COMPOSITION reasons the code couldn't see:

- The ROI reveal is a SCREEN-SPACE disc (~180 px at the default zoom)
  around the player, and it stipple-dissolves EVERY occluder-marked wall
  it touches — not just walls between camera and player. Since the
  follow-cam centres the player, anything within ~180 px of frame centre
  gets eaten. A demo's action (here: the breach) must sit OUTSIDE that
  disc or it plays under a dither cloud.
  **CORRECTED 2026-07-25** (see the "owner's surface" entry at the end):
  the dissolve IS one-sided — the walk breaks on
  `dot(hit.xz − player.xz, fwd) >= 0`, so a wall behind the player's
  plane keeps its pixels however close it is on screen. The usable rule
  is `wall.x + 2·wall.z <= player.x + 2·player.z` under trimetric.
- World-space clearance is meaningless on its own: walls south of the
  player stay screen-close (depth compresses along the view axis). Think
  in the projection's pixel images: at trimetric, world-X maps ~82
  screen px/wu (the longest direction), world-Z only ~28. Offsetting the
  spawn ALONG X buys the most screen separation per wu — (12,5) put the
  breach 4.5 wu ≈ 360 px out: clear of the disc, still large.
- Standing dead-on the action line is self-defeating: the follow-cam puts
  the player sprite exactly over it.
- Diagnosis pattern that worked: render the SAME boot state at all four
  YAW_Q quarters + frame-diff key ticks to localize what actually changed
  (the beat-swap diff also verified the slab→bricks swap is silhouette-
  and shadow-invisible except the slug's one-frame pop-in).

## 2026-07-23 — thin geometry cannot draw lines under the pixel contract

Context: promoting the crack lab's painted cracks to real geometry. The
STRUCTURAL fault (a 0.02-0.09 wu gap splitting a pier) worked first try —
silhouette notch, settlement step, see-through gap. Extending the same
idea to the crazing NETWORK (carving 0.02-0.08 wu grooves between veneer
fragments) failed three ways before the design settled:

- Carved grooves render as DOT-DASH noise, not lines: with primary rays
  through pixel centres and no AA (the binding contract), a 1-3 px world
  feature is hit-or-miss per pixel, and its darkness flips with edge
  orientation vs the sun. Painted lines are per-pixel COVERAGE — always
  coherent; geometric lines are per-pixel LOTTERY.
- Painting the groove floor doesn't rescue it: at the iso view angle a
  0.03-deep groove SELF-OCCLUDES (the near lip hides the floor), so the
  paint is invisible exactly where the line should read. Related trap:
  the veneer inset had carved away exactly the strip the painted line
  occupied, so "keep the paint" changed nothing until the paint moved to
  the core material under the groove.
- Half-measures (thinner veneer, partial inset, half-strength paint)
  just rebalance the same speckle.

Rule: under a no-AA pixel-centre contract, geometry is for AREA and
SILHOUETTE features (gaps wide enough to see through, recesses, steps,
cap notches — roughly >= 2 px in every visible dimension); LINES stay
painted. When both express the same underlying feature, they must share
one lattice (host mirrors the shader hashes float-for-float) so the
paint sits exactly on the geometry.

## 2026-07-23 (later) — line geometry works with three guarantees; per-sample gates chatter

Context: the owner overrode the "lines stay painted" rule the same day
("do the physical small cracks too, min width of 1px is good") and it
WORKS — the crack lab's whole small-crack network is now real grooves
(crack_geom.rs policies). The previous entry's failure analysis was
right about the mechanism but wrong about the conclusion: the dot-dash
lottery is a property of SUB-PIXEL line geometry, not of line geometry.
Three guarantees turn geometric lines coherent:

- A HARD >= 1-px width floor derived from the projection's axis images
  (`px_floor`: trimetric world-Z spans only ~28 px/wu vs ~41 for X and
  ~39 for Y, so the floor is per-face-direction, 0.027-0.037 wu). A
  groove at >= 1 px always owns a contiguous pixel run — no lottery.
- The cavity must read DARK at every orientation. A groove's up-facing
  ledge catches full sky and washes out near-horizontal runs (they
  dashed while vertical runs read solid). Fix: DROOP the groove walls —
  extrude them slanted down into the wall so every opening shows a
  down-facing overhang + shadowed floor, never a lit ledge. Same trap
  in another suit: sub-pixel SINK STEPS between flush plates dot out —
  a plate may only sink when its whole perimeter is grooved.
- Continuity is per-CRACK, not per-sample: gating groove width on the
  damage field at each sample makes the fbm threshold chatter and the
  crack dashes mid-run. Resolve each cut's open interval ONCE (first
  zone crossing to last = one continuous crack with crisp tips).

Bonus of geometry ownership: pattern POLICIES (hierarchical fracture
with T-junctions, craquelure ladder, mosaic) live host-side only — no
per-pixel closed form needed, no shader twin to port. The shader's cell
paint is dead code behind the suppression bits on aged piers; only the
sub-pixel fine web + stains remain paint (below the 1-px floor, where
the previous entry's rule still binds).

Two round-6 addenda (same day): (1) a knob whose mapped range hits a
CLAMP mid-slider leaves a dead top — the craze depth mapped 0.025..0.10
but clamped at 0.35 × wall thickness = 0.0875 on the gym's 0.25 walls,
so the slider's top third did nothing ("depth ending at 1 is too
small"). Map knob ranges FROM the constraint (0.02..0.45 × thickness),
never toward a constant that a clamp then eats. (2) A feature that only
applies in one MODE of a system is invisible if the owner's dial sits
in the other mode: pattern policies applied only to fault-free piers,
but at the owner's knobs (pMaj ≈ 0.95) every wall was faulted — "cycled
all patterns, no visual change". Compose orthogonal layers (the veneer
now rides the fault pieces, clipped against the fault paths) instead of
making them exclusive modes.

## 2026-07-23 (round 7) — expose the algorithm's OWN dials; a chamfer needs to know which edges are real

Owner round on the crack policies: "fracture produces unbelievable
shapes... let's use some kind of lightning-bolt propagation style algo —
and expose its settings: branching strength, straightness, whatever is
steerable. Do that generally: if I switch algo, I want its unique native
properties in the options." Plus: chamfered crack edges read natural and
play well with the low-res target.

- A procedural generator's KNOBS are part of its identity. One shared
  parameter set (age/cracks/depth/chip) flattens every algorithm to the
  same few degrees of freedom — the owner could not steer what makes
  each pattern distinct, so they all read as variations of the same
  fake. Now each policy declares its native params
  (`crack_geom::POLICY_PARAMS`) and the panel grows rows per policy
  (lightning: branch/straight/spread; craquelure: scale/wave; mosaic:
  scale/jitter), stored per pier PER POLICY so A/B-ing keeps tunings.
  Params are geometry-only: they sign raw into the release signature —
  no material bits, no shader involvement.
- "Lightning" did not need a walker/DBM engine: the existing recursive
  cut machinery IS a propagation structure if you shape the cuts —
  root each cut's open span at one end (the top for primaries, the end
  nearest the parent's crack for forks), budget its length so it
  dead-ends in a taper instead of always crossing the region, fork the
  direction off the parent's by a spread angle, and add a kink octave
  to the wander. Reuse beat reinvention: spans, cut_clip, the pixel
  floor and the droop all carried over untouched.
- A chamfer is edge-selective geometry: beveling EVERY plate edge
  carves visible V-grooves into closed seams (coincident walls that
  must stay one flush slab). The bevel needs per-edge knowledge of
  "does this edge border an OPEN groove", which the generators know
  but the emitter did not — so fragments now carry per-edge open
  flags (probed against the ancestor cuts / bisectors / fault paths;
  field ~ 0 AND gate > 0). The bevel then eats into the PLATE (miter
  inset ring, taper to zero at open/closed junctions — no gussets),
  never into the gap: the >= 1-px groove width guarantee survives.

## 2026-07-25 (round 8) — propagation needs ONE invariant; a non-through cut must not carve pieces

Owner round: "work on the algorithm that draws the cracks / deforms the
meshes — they should be more like LIGHTNING, branching, a bit irregular,
not straight lines. There are two kinds: the coarse one (a wall cracked
in half) and the age crazing." Both scales were analytic lines: the
fault was `u(y) = ax + tilt·y + wob(y)` (one smooth vnoise wander) and
"lightning" was round 7's BSP splitter with propagation-shaped spans. A
BSP cut always crosses its region, and a smooth wander cannot kink — so
the wall rendered as two or three long soft arcs, exactly what the owner
saw. Round 8 replaced both with a walker (`Walk`) + a cut primitive
(`Bolt`) + one carver (`carve`).

- The enabling invariant is a CORRIDOR, not a clever field. Clamp every
  step's heading to ±66° of the bolt's launch axis and the path stays a
  FUNCTION `u = f(v)` in its own frame: side-of-crack is the sign of
  `u - f(v)`, exactly as for the old analytic cuts, so `cut_clip`, the
  >= 1-px floor, the droop and the chamfer all carried over unchanged.
  Without it you need signed distance + a parity/winding side test,
  which is ambiguous inside a sharp kink's wedge — the alternative was
  a much worse machine. Corridor-clamped zig-zag is still plenty jagged.
- A CUT THAT DOES NOT SEPARATE THE WALL MUST NOT CARVE PIECES. Fault
  forks were first modelled as full-depth piece cuts. A piece boundary
  runs the whole width of whatever it splits, and a dead-ending cut is
  represented as a split whose seam CLOSES past the tip — so every fork
  drew a hard straight line clean across the wall along its invisible
  extension. Three separate leaks made that extension visible, each a
  variant of "something keyed to *cracked* fired on a closed seam":
  the chamfer flags (fixed: `field ≈ 0` AND `halfw > 0`), the sink step
  (fixed: a plate may sink only if EVERY edge is open — the round-4 rule
  now read off the real flags, not the damage field), and the piece wall
  (a closed seam DOES need its sheet, or rays slip into the hollow
  prism and hit it from inside — but only across the CORE, or the sheet
  stands proud of the inset front plane and shows from outside). Even
  with all three fixed the class stayed fragile, so forks moved down a
  layer: they groove the VENEER, where a cut's reach is one plate wide.
  Bisecting this cost most of the round — the shortcut that worked was
  disabling one layer at a time (forks off, veneer off) rather than
  reasoning about which coincident face wins.
- WIDTH FOLLOWS LENGTH. Uniform-width bolts read as scratches however
  well they kinked; scaling each bolt's width by how far it actually
  propagated (`groove_w(1.4 + 1.8·rel)`) is one line and it is what
  makes a long crack read as a fracture and a short one as a hairline.
  Same shape for forking: a long bolt frays more than a short one.
- Cracks need their OWN zone. Gating growth on the crazing/stain damage
  zone left a mid-aged wall visibly pristine (the demo's own seed showed
  one crack) — the stain zone is a steep slice around the age threshold.
  A crack propagates out of the worst patch into merely tired material,
  so `crack_zone` is a wider, EARLIER slice of the same field. Layers
  that share a field still need their own thresholds.
- Numbers worth keeping: nothing under ~2 px of groove width survives as
  a line at this render scale (1 px dot-dashes even with the droop), a
  step of ~3 px per walk segment is the smallest kink that resolves, and
  a knob-release rebuild on the M2 is ~6.5 s (probe rebake, vs ~115 ms
  on the RTX) — the crack lab's edit loop is bake-bound on the Mac.

## 2026-07-25 (contour AA) — the cost of a sparse GPU pass is DIVERGENCE, not the sparse fraction

Owner ask, same day as the crack round: "a delicate anti-aliasing that
anti-aliases only the CONTOURS of solids, so deep thin crevices stop
looking like single black pixels." Explored with a 9-agent workflow (four
designs, three judge lenses, one synthesis); the winner was true coverage
— a fixed 4-ray sub-pixel pattern fired ONLY on contour texels, resolved
in the tonemap. It works, the wall now reads as continuous lines, and the
implementation notes are in CLAUDE.md. Three things worth keeping:

- **A tap that re-dispatches the SAME kernel reuses the whole state
  machine by identity.** The shade pass carries 150 lines of
  FLOORCUT/WALLCUT/ROI/glass logic plus a Bayer stipple keyed to the
  texel. A coverage sample that changes only the sub-pixel ray offset —
  same `px`, same push constants — cannot diverge from the centre's cut,
  stipple or dissolve decisions. No refactor, no duplicated predicate,
  nothing to keep in sync. That property is what made the design cheap
  enough to land in a day, and it is worth reaching for whenever a
  renderer needs "the same shading, sampled differently".
- **Sparse work costs what its WARPS cost, not what its pixels cost.**
  The gate fires on 3.7% of the gym's texels and 25% of a crack-lab
  close-up, so the predicted price was 4 × 3.7% × frame ≈ 0.5 ms. Measured:
  +3.3 ms (3.5 → 6.8 ms). Bisected by dispatching taps that return
  immediately (+0.1 ms — so neither launch overhead nor the gate loads)
  and taps that shade (+0.8 ms each). The cost is SIMD divergence:
  contours are LINES, so nearly every 8×8 tile contains one, and a tile
  with a single live thread pays a full shading. The honest fix is
  compaction (append contour texels to a list, dispatch over the list) —
  not fewer taps, not a cheaper gate. Recorded as the optimization if the
  owner finds the price too high; 4 taps shipped because quality first
  and 6.8 ms is 147 fps.
- **A gate cannot be cached in the buffer it reads.** First attempt
  cached the dilated gate result into `albedoImg.a`, the same channel the
  dilation reads from its neighbours — a read/write race inside one
  dispatch, i.e. nondeterminism, in the one codebase where determinism is
  load-bearing. Fix: a separate GATE dispatch that reads the edge channel
  and writes a different one (a negative weight in the radiance alpha,
  which every consumer already reads as "one sample"). Same trick as the
  round-8 closed-seam probes: when a pass needs its neighbours' values,
  its own output must live somewhere else.
- Bonus measurement, correcting a stale note: the M2 Pro's Metal
  cross-run noise floor on this scene is NOT ~1 LSB — it is 5.6% of
  pixels differing with a max delta of 6/255 (identical binary, identical
  args, two runs). So byte-diffing SHOTs across process runs is invalid
  here in both directions; neutrality must be checked as "no STRUCTURED
  difference", e.g. against the two-run floor measured the same session.

### Addendum, same day — the SCOPE fixed the cost too, and a 0.2 ms cousin

The owner's next round ("apply the AA selectively, only on the chosen wall's
geometry; or else soften those narrow cracks so they stop being harsh black
broken pixels") turned out to answer the cost problem above:

- Scoping the gate to opted-in materials (`Material._pad` bit 7, stamped per
  pier AND its chalk core — the core carries the groove floors, so a scope
  that missed it would AA the lips and leave the crack's darkest pixels
  hard) drops the game view's price from +3.3 ms to **+0.23 ms**, because in
  the gym nothing opts in. Divergence is only expensive where the contours
  actually are. A feature the owner wanted narrower for LOOK reasons was
  also the performance fix — worth checking for that alignment before
  optimizing.
- The cheap cousin ships alongside: on the same gate, pull a contour texel's
  radiance a fraction toward its 4-neighbour mean in the tonemap. No rays,
  **+0.2 ms even on a wall filling the screen**, and it directly attacks the
  owner's words (contrast, not continuity). Coverage AA and softening are
  now two knobs on one gate: `contour aa` makes a thin line CONTINUOUS,
  `aa soften` takes the CONTRAST off it. Keeping them separate matters —
  they fail differently and cost two orders of magnitude apart.
- `CRACK_SEL=<pier>` joined the harness knobs: the selection drives the panel,
  the highlight and now the AA scope, and an agent cannot click.
- The owner then GENERALIZED the shape into a project rule (CLAUDE.md,
  "Greybox detail = AA-scoped"): every generator that modifies greybox
  geometry marks its output, and the AA scopes itself to those marks. The bit
  and its helper moved out of the crack lab into `gym_scene` beside
  `mark_occluder`/`mark_glass`, the wall-smash rubble became its second
  client, and the scope-1 test now reads the geometry pass's own GEO/CRAZE
  marks instead of "the knobs are non-zero" — a knobbed pier whose damage
  field left it pristine builds nothing and must stay hard-edged.

## 2026-07-25 (the owner's surface) — a demo is STAGED, and a deferred GI update beats a smaller one

Context: five effects had landed in the crack lab and none of them was
visible from where the demo spawned the owner. Four lessons, none of them
about the effects.

- **The ROI dissolve is ONE-SIDED, so demo staging is an inequality you
  can solve — this corrects the 2026-07-17 entry.** That entry says the
  reveal disc "stipple-dissolves EVERY occluder-marked wall it touches —
  not just walls between camera and player". It does not: both shade
  twins break the dissolve walk on `dot(hit.xz − player.xz, fwd) >= 0`,
  i.e. a wall BEHIND the player's plane keeps its pixels however close it
  is on screen. Under trimetric `fwd` is `−(1, 2)/√5` in xz, so "safe"
  is exactly `wall.x + 2·wall.z <= player.x + 2·player.z`. That turns
  staging from four failed spawn attempts into arithmetic: list the
  walls' `x + 2z`, put the player above the max. For a wall parallel to a
  ground axis the crossover point (where it leaves the safe half-plane)
  even has a closed form in screen px that is INDEPENDENT of the player's
  other coordinate — for the gym's z=10 run it is `(100·(p.z − 10), +25)`
  px from the disc centre, so `|p.z − 10| > 1.11` clears the 79+33 px
  disc whatever `p.x` is. Solve it before rendering candidates; the
  renders then only settle taste.
- **Ship the negative control IN THE LEVEL, and make it the greybox, not
  "less aged".** Every wall weathered means weathered IS the base tone
  and the owner has nothing to read damage against — the same trap the
  spall dial's variance hit two steps earlier. The fix is one field of
  level data (`CrackSeed::pristine`, world points so re-cutting the level
  cannot move it silently), and the test must assert the control equals
  the UN-AGED BUILD, not some hand-written invariant: the first version
  asserted "still a 24-vertex box" and failed, because the eased-arris
  pass had already promoted every static box to a mesh. Compare against
  the other build, not against your memory of it.
- **When a synchronous GPU update is LATENCY-bound, defer it — do not
  shrink it.** An animated geometry effect (a wall aging over 3 s) needs
  ~16 scene rebuilds. The scene swap costs 30 ms; the local probe refresh
  costs 5.1 s, and it costs that at ANY size (one thread per probe × 2048
  serial rays: 680 probes 3.1 s, 1512 probes 3.3 s). So the interesting
  axis was never "how few probes" but "who re-bakes, and when": a third
  refresh mode that carries the banks and hands the dirty box to the
  amortized roll that already existed for the tear-off made a geometry
  step cost the swap alone. It converges to within max 4/255 of a full
  re-bake over its 64 frames — verified against a `PROBE_LOCAL=0` run of
  the same demo, which forces a real bake per commit and is the only
  ground truth that means anything here. Keep the exact path for the
  non-animating caller (a mouse-up): the two callers want different
  answers, not different tunings of one. Measure the DEFERRED path's own
  per-frame price too, and say it out loud: this roll costs 9.2 → 33.4 ms
  a frame while armed (≈7 ms fixed for two waited command buffers and
  four whole-material uploads, plus 2.1 ms per ray), so the beat runs at
  30-40 fps. Deferring converts a stall into a slowdown; it does not make
  the work free, and a report that only quotes the 30 ms swap is lying by
  omission.
- **Let the change's own SIGNATURE decide when to commit.** The beat
  attempts a rebuild on a fixed tick grid and the rebuild returns
  immediately unless the pier's geometry signature moved. That is why the
  cadence needed no tuning against the knob curve — and measuring it
  afterwards (all 16 attempts moved geometry, 18 k → 34 k tris) is what
  turns "should be cheap" into a number in the comment.
- Small one, general: **a UI band that renders `take(n)` of its content
  truncates in silence.** The LEVELS blurb band drew two lines and the
  test that claimed to check the wrap only checked the PANEL fit. A demo
  blurb is the owner's only description of a demo; the assertion now
  exists, and the band is three lines because the crack lab has three
  things to say.

## 2026-07-26 (the rebar round) — a stage boundary must be DECLARED, and a facet is not a rougher curve

The owner's first look at the cover spall named two things: "jest za gruby"
(the bar) and "owalne dziury nie są realistyczne" (the crater). Both fixes
were three-line changes; the interesting part is what each one broke or
taught.

- **A staging knee that only COINCIDES with the geometry is not a knee.**
  The spall dial's three stages (cracked → lifted cover → blown spall) were
  documented as a fraction of the DIAL, and the depth ramp was bent to meet
  that fraction — but the code that decided whether to emit steel asked a
  purely geometric question ("does `BAR_PROUD` of the section stand clear of
  the floor?"). With the old 0.075 section the two agreed, so the design
  looked right for as long as nobody moved the constant. Halving the section
  halved the knee's depth, it fell 0.006 wu IN FRONT of where the lifted
  stage even starts, and two things broke at once: the steel showed at the
  very bottom of the dial's travel, and the floor ramp `mix(floor0, knee)`
  ran BACKWARDS — the crater got shallower as the owner opened the dial.
  The fix is to say it: `bar_s = if st >= ST_STEEL { bar_s } else { 0.0 }`,
  plus `knee.max(floor0)` so the ramp cannot invert. **If a stage boundary
  is a product decision, write it as one; deriving it from geometry that
  happens to land in the right place makes every future constant change a
  silent regression.** The existing dial test caught this on the first run,
  which is the argument for pinning a staging TABLE rather than a threshold.

- **Faceting is a different generator, not a louder noise.** The first
  crater rim was an ellipse with two octaves of value noise on its radius,
  and the second octave was deliberately above what the sample count could
  resolve — the reasoning being that unresolvable noise lands as per-vertex
  jitter, i.e. as a ragged edge. It does not. Perturbing a radius keeps
  every tangent continuous, so more amplitude buys a lumpier EGG and never a
  corner; fifteen of them in one frame read as a punched pattern. Broken
  concrete is a chain of near-straight facets meeting at hard corners, so
  the generator has to be a POLYGON: draw the corners, join them with
  chords, sample the chords. Both invariants the mesh pass rests on came
  along free — corners drawn at ascending angles keep the rim star-shaped
  about its centre, and a chord between two points of a convex region stays
  inside it, so the containment bound the patch rect was sized for is
  untouched. Same discipline as `Walk`'s corridor clamp: pick the
  parameterisation that makes the invariant true, don't test for it after.

- **Pin a SHAPE with a statistic that the rejected version could not
  produce.** "Not an oval" sounds untestable, so the temptation is to ship a
  screenshot and move on. Two numbers separate the two generators by an
  order of magnitude and neither is tuned: on a smoothly sampled curve the
  2π of turning is spread evenly, so no vertex can turn much past 2·2π/N
  (≈0.6 rad) and none can turn ≈0 (there is no straight run to find). The
  facet rim measures 1.90-2.43 rad at its hardest corner and 0.001-0.031 at
  its flattest sample. Gates at 1.2 and 0.06 sit clear of both, and would
  fail loudly if someone smoothed the generator back out.

- Small one: **the sub-pixel floor is per AXIS, not per feature.** 0.026 wu
  looked fine in every shot — because every shot framed an X-run face at
  1.07 px. The same bar on a Z-run face is 0.73 px, under one texel, and it
  survives there only on rust-against-chalk contrast. 0.036 was picked as
  the thinnest section that clears a texel on the WORST axis; when a
  candidate is judged by eye, shoot the axis the projection foreshortens.

## 2026-07-26 — the Metal probe bake is BIMODAL, and two samples cannot see it

Verifying a deletion that should have been byte-neutral, a 1500×950 catalogue
frame came out 12 px different at max delta 72 — three low-res texels, two of
them swapping a lit grass texel for a shadowed one. Bisected by stash to a
commit that contained nothing but renames (`_pad |= 1` → `_pad |= flags::OCCLUDER`
and friends, every substitution value-identical). A commit that cannot change a
material byte had apparently moved pixels.

It had not. Six FRESH bakes of the identical scene from the identical binary
split into two groups — 1-4 agree, 5-6 agree, and the two groups differ by
exactly those 12 px at exactly max 72. The bake has (at least) two stable
outcomes on the M2, and which one you get is decided by something outside the
scene: **the same binary rendering the same frame is bit-stable within a mode
and 72/255 apart between modes.**

Why it is 72 and not 1: the differing texels sit on a HARD SHADOW BOUNDARY. A
sub-LSB difference in one probe's irradiance moves the boundary by one texel, and
one texel of boundary is the full contrast between lit meadow and its shadow.
The amplification is the shadow, not the noise.

What this breaks, and it is the important part: **the verification method used
throughout this session.** "Render before, render after, diff, 0 px above the
floor" is only sound if the floor was measured with enough samples to contain the
mode split — and the floor measurements taken here (two runs, cached; two runs,
fresh) both landed inside ONE mode and reported a floor of 0 px / max 3. Two
consecutive runs agreeing proves nothing about a bimodal source. The first
attribution off that evidence was wrong, and it was wrong in the most expensive
direction: it accused a correct commit.

Rules that follow:

- **A Metal "byte-identical" claim needs ≥ 4 runs of EACH side**, all-pairs
  diffed, and the floor is the max over all pairs — not the delta between one
  pair. Anything under that cannot distinguish "my change" from "the other mode".
- **Suspect the amplifier, not the size.** A max delta of 70+ on a handful of
  texels beside a shadow edge is the signature of a tiny difference upstream, not
  of a large one. A large real change moves regions, not three texels.
- CLAUDE.md's "Metal's ~1-LSB cross-run noise floor" is true of the RADIANCE
  pass and false of the pipeline end to end once a hard shadow is in frame. The
  Vulkan/RTX floor is recorded as ZERO; that claim now also needs ≥ 4 samples
  before it can be relied on for a byte diff.
- The probe CACHE is not the culprit and was cleared of it explicitly: cached
  and fresh bakes of the same scene agree exactly, within a mode.

## 2026-07-26 (breaks become a count) — a probability cannot be authored, and a shim can smuggle the old defect back in

Replacing the structural break's 6-wu-strip coin flip with an authored count was
the cleanest of the refactor's steps and still produced two lessons, one about
the thing being replaced and one about the replacement.

### A probability has no "none" and no "one", and both absences cost real work

The old rule fired at `0.95 · smoothstep(0.12, 0.42, age) · smoothstep(0.04,
0.45, cracks)` per strip. Everything downstream had to be built around the fact
that a level author could not name an outcome:

- **No "one".** A 2.2-wu bench slab contained a strip's axis about a third of the
  time, so the effect catalogue's break specimen came up EMPTY on its first
  build. The fix at the time was to widen that slab to four cells — a real
  measurement, an honest response, and a permanent asymmetry in a bench whose
  entire premise is that the slabs are identical. It reverted to two cells in one
  line the moment the count existed.
- **No "none".** Presence and the crack network share `age`, so at every age
  where a veneer pattern was visible the odds of also breaking the wall in half
  were ≥ 0.9. "Cracked but not broken through" therefore needed a VETO FLAG
  (`Specimen::faults`, `CrackLab::no_fault`, a `no_fault` argument threaded
  through `apply_geometry` and `keys`) to be expressible at all. Six code sites
  existed to say a thing the model should have been able to say with a zero.

The generalizable shape: **when a system's output is a probability, every state
an author wants becomes a flag, and every flag has to be plumbed.** Count the
flags around a mechanism — that count is the measure of how badly the mechanism
is parameterized. Here it was four (`faults`, `no_fault`, `SPEC_WIDE`, and the
low-`cracks` convention every unrelated specimen had to follow to keep its odds
down), and all four were deleted by one struct with two fields.

A third defect only became visible once the mechanism was written down: the
strips are anchored in RUN space but the roll was seeded PER PANEL, so a strip
straddling a window jamb was rolled twice with different seeds. The same break
existed on one panel and not its neighbour, and the crack stopped dead at the
opening. Nobody had reported it, and no test could have caught it, because the
system had no notion of "the same break" to compare.

### The owner risk that justified a decision can expire with the decision

Step 4 deliberately kept the fault seed per PANEL against a recorded owner risk:
"a shared fault seed would crack a facade at one repeated position". That was
correct — while a break was a coin flip on a 6-wu LATTICE, sharing the seed would
have rolled the period once and cracked every panel at the same offset. An
authored count at authored places has no period, so the risk died with the
lattice, and a test that had been asserting `assert_ne!` on the two panels' seeds
had to be inverted to `assert_eq!` on their break sets.

**Re-read the reason, not the conclusion.** A hedge recorded against a mechanism
is not a standing preference; when the mechanism goes, check whether the hedge
still describes anything. Both the old and the new claim are pinned in the same
test with the argument written next to them, so the next person can audit the
inversion instead of trusting it.

### The shim reintroduced the defect the round exists to remove

The four legacy knobs still drive the panel, so a shim maps them onto the new
`Story`. `settlement` came from age × cracks, and the naive spelling asked each
PIER for its own count. But `seed_knobs` deliberately RAMPS age/cracks along a
run (a facade with a bad end and a clean end), so the gym's east facade derived
counts of **2, 2 and 1** for ONE authored slab — and its three panels then
computed three different break sets and cut three different walls. Exactly the
per-panel disagreement the round exists to delete, walked straight back in
through the compatibility layer.

Caught only by MEASURING: a throwaway test that printed every pier's run, count
and resulting break list. The unit tests were green — they pinned that a run's
breaks are a function of `(run, story, count)`, which was true; the bug was in
what `count` was handed. The fix is the run's MEAN knobs (the ramp is symmetric
about the base the author typed), and it is now pinned over both shipped levels
with a vacuity guard that the knobs really do differ across a run.

**A shim is where a refactor's invariant goes to die.** The new code is written
with the invariant in mind; the shim is written to preserve old behaviour, and
"old behaviour" includes the defect. Any per-RUN quantity derived from per-PANEL
legacy state needs its own equality test, not just the new engine's.

## 2026-07-26 (spall becomes an area) — a staged dial is a symptom, and a proxy metric fails for the wrong reason

Step 7 of the effects refactor deleted the cover-spall dial's three stages
(a 0.12 deadband → LIFTED COVER → BLOWN SPALL) and replaced them with
`Layer::Spall`'s AREA. Three things worth keeping.

- **A staged dial is what you build when the layers underneath it are not
  separable amounts.** The previous day's learning here says "if a stage
  boundary is a product decision, write it as one". The deeper reading is
  that this boundary should never have existed: stage two was *cover lifted
  but no steel showing*, which is a CHIP, and `Layer::Chips` builds exactly
  that. The dial was carrying a state only because chips and spall were not
  two amounts you could ask for independently. When you find yourself
  staging a slider, check whether the stages are separate layers wearing one
  control — and if they are, the staging table, its knee constant, its
  deadband and the depth ramp bent to meet it all delete together.

- **A limit you DOCUMENT is not a limit you REPORT.** The module doc carried
  a paragraph headed ONE HONEST LIMIT: past relief ≈ 0.72 on a 0.2-wu wall
  there is no core left to hold the reinforcement mat, so the spall silently
  stopped showing steel. Honest to a reader of the source; invisible to the
  person holding the slider, who sees an effect that stops working and no
  reason why. The bound is arithmetic, so it can be SOLVED for the dial
  instead of tested against it (`rebar::t_cap`), applied once where the value
  is born, and said out loud per wall (`wall::Miss::Clamped`). It cost the
  top 9 % of the relief slider on the gym's own walls, which is what that
  paragraph was actually worth.

- **A proxy metric fails for reasons that are not the claim.** A test asked
  "does the age beat keep moving the geometry, or does it arrive in one
  cliff?" and answered it by comparing TRIANGLE COUNTS between commits. It
  went red at 9 of 15 the moment the spall's lens stopped growing with the
  dial — while the craters had in fact moved, resized and re-sited on every
  one of those steps; only the count repeated. Two lessons in one failure:
  measure the thing (an FNV over the vertex positions is four lines), and
  when a long-passing test breaks, check whether it was ever measuring its
  own claim. Restating it also surfaced that the beat's first third is PAINT
  by design, so the honest claim is about the geometry phase — which the
  test now asserts from both ends.

- Small one, and the same shape as the round-6 break: **monotonicity is
  cheaper to get by construction than to test for.** Spending a running
  budget ("take this crater while it fits what's left") reads natural and is
  not monotone — a bigger ask can accept an early large crater that then
  blocks two later ones. Deciding the COUNT up front and walking a candidate
  list whose order does not depend on the budget makes a larger amount take
  a superset of the sites a smaller one took, and the test is then an
  assertion about the mechanism rather than a search for a counterexample.

## 2026-07-26 (plate size) — a property every variant has does not belong to any of them

Step 8 replaced a cells-per-wu FREQUENCY plus two per-policy `scale` params
with one world-unit `grain`.

- **"Native parameters" is a claim to check, not a category to fill.** The
  policies were given native sliders on the owner's ask ("if i switch algo, i
  want unique native properties"), and two of the three filled a slot with
  `scale` — which is not native to anything: every pattern has a plate size.
  The test is whether the OTHER variants would want the same dial. If they
  would, it is a shared property wearing a local name, and it will drift:
  these two were on different curves, so one slider position meant 0.79-wu
  plates under craquelure and 0.40 under mosaic, and the catalogue shipped a
  bench row whose middle slab was three plates tall.

- **A shared property needs a shared UNIT, and a length is usually it.** The
  frequency could not be compared against anything the author can see: not the
  wall's own size, and not the pixel floor. As a length, both questions are
  arithmetic — `GRAIN_OFF = 0.09 wu` is 3.7 screen px, so it is where the
  lattice starts to dot-dash, and that makes it a real OFF-STOP rather than
  the bottom of a slider.

- **Agreement between variants is measured, then corrected once.** Pointing
  all three at the same number was not enough: Worley cells tile their lattice
  exactly, but a plate's readable size is `sqrt(area)`, `sqrt` is concave and
  a jittered cell set has spread, so mosaic came out a third small. One
  measured constant (`MOSAIC_FILL`) fixes it, and the test that measured it is
  the test that fails if it drifts. A per-variant correction derived from a
  measurement is not the same thing as a per-variant dial: nobody can set it
  wrong.

- **Make the shim exact where the mechanism is not changing.** `grain_of` is
  the reciprocal of the frequency it replaces, so the lightning policy is
  byte-identical across the change. The A/B then shows exactly the two
  patterns that moved, instead of a diff nobody can attribute.

## 2026-07-26 (the run becomes the authoring unit) — state shaped like the renderer cannot be authored

Steps 9-11 finished the effects refactor: the per-PIER knob state is gone and a
level is a `wall::LevelWear` compiled to one `Sheet` per RUN.

- **If three rounds in a row fix the same symptom, the SHAPE of the state is
  the bug.** The fault seed, the break count and the field level were each
  "a per-panel value standing in for a per-run cause", and each got its own
  targeted fix: seed off the run, average the run's knobs, normalize the run's
  field. All three were right, and none of them could be the last one, because
  the state was still indexed by pier — a rendering artifact the level builder
  never typed and cannot see. Re-shaping the state deleted all three fixes
  along with the defect, and the last of them (`geom_input`'s hand-rolled
  "average the run's masked knobs") is the clearest possible sign that the
  refactor was overdue: a compatibility layer reconstructing a number the
  author had literally typed.

- **A budget nobody reads is not a budget, it is four lanes of rent.**
  `Material._pad` carried four 6-bit knobs and the shade pass read ONE of them,
  for both painted layers at once — so their AREAS were independent (an earlier
  step solved that) while their INTENSITIES shared a slider, and three lanes
  were paying for nothing. Worth grepping the shader for what it actually reads
  before defending a packing layout: the honest answer here freed two lanes AND
  made a sentence expressible ("stains darker than the crazing") that the
  budget had been hiding.

- **A cross-layer coupling hides in a threshold's NAME.** The veneer's zone read
  the WEB layer's solved threshold, and Web is a *painted* layer — so a wall
  authored as "cracked" built no plates unless it also happened to be asked for
  crazing. The catalogue's pattern row shipped empty on the first build of this
  step and that is how it surfaced. When one layer's geometry gates on another
  layer's number, the name is doing the arguing; make it read its own.

- **A panel with 19 rows cannot be positional.** Four constants and three copies
  of "row index minus the number of knobs" survived a 7-row panel. The layout is
  a `Vec<Row>` now and the draw, the hit-test and the drag all walk it — and the
  row TYPE is what lets the panel say what it is for: a CAUSE, a derived AMOUNT
  (with a pin marker, and a drag that pins it) and a SHAPE dial are three
  different things, and a bare row number cannot carry the difference.

- **A master dial should not be destructive.** The three new level-wide rows are
  applied on the way from the authored spec to a sheet, never written back into
  it. That is the only version worth having: the usual in-place rewrite loses the
  level's own authoring on the first drag, so the owner cannot return to the
  state he is comparing against. It also makes them compose for free — with each
  other and with a per-wall edit.

## 2026-07-27 — the effect-system foundation (wear files, scrub, band, mud)

Owner concept: a PBR-like modular effect system (independent + composable,
paintable regions, per-instance transforms, renderer-honest). Landed as a
CONTRACT in the data model, not a plugin system, in four rounds: wear-as-file,
the variant dial + Origin's deletion, the band mask, and mud — the first new
effect through the whole pipeline.

- **A global calibration curve on a small field is the lottery solved
  thresholds exist to remove — applied to a NEW layer, not just old ones.**
  Mud's first cut mapped amount→threshold with two constants fitted to pooled
  noise quantiles; a splash band holds ~a dozen independent noise cells, so
  per-story coverage measured 1.8× the ask. The system already knew the fix —
  solve the quantile of the run's OWN samples — and the lesson is that a new
  layer must EARN skipping the solver, not default to it because it is
  "paint-only". The pooled-quantile dump was still worth one throwaway test:
  it produced the shape (near-linear) that said solving would be cheap.

- **A half-wired knob reads as a feature until you trace both consumers.**
  `Origin` (ground/even/coping/both) biased the SOLVED threshold but never
  reached the field on host or shader — it changed HOW MUCH while claiming
  WHERE, on every wall, since the day it shipped. Found only because the plan
  round audited every channel end to end. The band mask is the honest version,
  and the deletion collapsed `RunField::at` into literally the generator's
  `dmg_field` — the solver, the geometry and both twins now read one function.

- **A mask must enter the FIELD, and by SUBTRACTION.** Masking layer visibility
  per consumer re-creates the paint-vs-plates drift; masking the field steers
  every consumer at once. And a multiplicative mask leaks at the top of every
  dial (zero is still above the full-coverage gate) where subtraction keeps
  in-band values bit-exact and drops out-of-band below every gate — the
  byte-stable default and the provable exclusion come from the same operator.

- **An unauthored slab is not a specimen.** Catalogue row 3 first built five
  slabs for two subjects, and the two empty ones nearest the spawn sat inside
  the ROI reveal disc and dissolved on boot — a bench artifact indistinguishable
  from a render bug in the SHOT. Build what has a subject; grow the row with
  the round that brings one.

- **Persistence changes what a panel IS.** Until the wear file, every drag died
  on exit, so the panel was a demo dial; the same panel with a save path is an
  AUTHORING tool, and the save's edge cases (env overrides must not freeze
  themselves into the file, demo beats must not write, derived runs must stay
  derived so the spread keeps breathing) are where that difference lives.

## 2026-07-27 — round E: the artillery hole (the first PLACED effect)

The owner workflow's last verb — "dodaję efekt dziury po pocisku" — as a
placed crater: `wall::Shells` (≤3 hits in run space + one caliber in wu),
click-to-place through the pick ray, `rebar::shell_crater` generalizing the
spall crater (round, perimeter-scaled rim corners, floor at the honest depth
limit, both mat families). Zero shader edits, zero new materials.

- **A harness knob is a name in an INHERITED namespace.** The env knob was
  born `SHELL=` — and `SHELL` is the login shell in every Unix process, so
  every wall of every level grew a crater and the `env_overridden` guard
  blocked every save. Six tests failed and none of them named the cause; the
  failures looked exactly like a geometry bug. Check `env` before claiming a
  knob name, and prefer a name no shell exports (`HOLE=`).

- **A placed feature is compiled like DATA, not like geometry.** Legality
  (does the patch fit), the caliber cap, and the overlap discipline (drop the
  later hit — same face is two intersecting basins, facing is a perforation)
  all live in `compile_specs`, on authored numbers — so every limit is a
  `Miss` in the wall's own row and a headless arithmetic test, where the
  geometry pass could only have silently not-emitted. The one veto the
  compiler cannot see (a hit straddling a fault, a per-pier geometric fact)
  is pinned by test instead.

- **`Default` for a rebuild key must mean "nothing".** The paint-only GeoKey
  is `Geom::default()`, so a naive `shell_u: [u16; 3]` of places would have
  read as "three shells at the run's start" on every paint-only wall. The
  slot encoding (0 = empty, 1 + thousandths = place) exists for that one
  consumer.

- **Quantize BEFORE legality, rounding onto the cap.** The compiler clamps
  places against the radius the GENERATOR will dequantize (`Geom.shell_r`),
  not against the raw dial — round-to-nearest could poke half a grid step
  past the cap, and the generator's own clamp would then quietly move a
  place the author clicked. Same lesson as paint-vs-plates, geometry edition.

- **Snap UI dials as `k / N`, never `k * step`.** 0.02 has no exact f32;
  multiplying wrote `scrub 0.39999998` into the owner's first saved wear file
  (the file's `num` prints shortest-round-tripping text, so the ugliness WAS
  the value). `(t * 50).round() / 50` lands on the nearest f32 of k/50, which
  prints clean.

## 2026-07-27 — the fullscreen "mouse lag" was the compositor starving

Owner repro after the artillery round: "in full screen the mouse gets almost
unresponsive, and placing does nothing". The renderer was measured innocent
(240 frames in ~0.4 s at near-fullscreen), and his own saved wear file proved
the placing gesture WORKED — the craters render on a boot from his session.

- **An uncapped render loop is a system-wide bug, not a local waste.**
  MAILBOX + Poll + unconditional redraw = ~600 fps of discarded frames. In a
  1280x800 window nobody notices; a 5120x2160 fullscreen surface saturates
  the GPU and starves the COMPOSITOR — and on Hyprland+NVIDIA the cursor is
  software-rendered, so the MOUSE ITSELF lags. The symptom appears two
  layers above the cause, in a different process. Default to vsync (FIFO)
  when the sim is fixed-tick; keep the uncapped mode behind a knob.

- **"Nothing happens" can be pure feedback starvation.** The click landed,
  the data saved, the geometry built — the frames showing it were seconds
  behind. Before debugging a gesture, check whether its RESULT is on disk
  (the wear file was; that one look replaced a day of pick-ray suspicion).

- **Per-event work must be paced by frames, not by the device.** A slider
  drag recompiled the level per motion event; gaming mice deliver ~1000/s.
  Coalesce to the latest position once per frame and flush the tail on
  release — nothing an author can perceive lives between two frames.

- **A demo beat that mutates authored state will eventually get saved.**
  The AgeWall ramp writes spec[r].story; the dirty flag kept beat-only
  sessions out of files, but an edited session saved the beat's story into
  the ramped control. A beat must apply on the way to a sheet (the
  level_dials discipline), never into the authoring. Parked, owner call.

## 2026-07-27 — the FIFO fix froze the event loop (never block on the compositor)

The morning's FIFO present (the fix for MAILBOX starving the compositor's
software cursor) shipped a worse bug by evening: on Hyprland + NVIDIA
(explicit sync), a FIFO present WAITS on a DRM syncobj that only a
compositor render signals, and a fullscreen window under VFR can go
unrendered indefinitely. The main thread parks in
`drm_syncobj_array_wait_timeout`, the winit event loop dies with it, and the
owner reads it as "the whole keyboard stops working in fullscreen" — the gym
is mostly static, so a frozen frame looks alive, and the mouse cursor keeps
moving because the compositor draws it.

- **The evidence chain that settled it** (each step keyboard-free): thread
  wchan named the kernel block point; `grim -o <output>` — which forces one
  compositor render of that output — un-froze the loop mid-probe, proving
  render starvation rather than key delivery; a `VSYNC=0` MAILBOX control
  sailed through the same transition. One mechanism, three independent
  confirmations.
- **"Not reproducible" was a RACE verdict, not an absence.** The first
  keyboard report got probed on a real monitor where any damage (a moving
  cursor, an injected key that repaints) rescues the block — so the probe
  measured a healthy loop and shipped defensive guards. On a headless output
  with zero extraneous damage the same freeze is DETERMINISTIC. When a
  symptom is intermittent, first ask what background activity your probe
  adds that the owner's idle session lacks.
- **Never let the frame loop block on the compositor.** The fix is not a
  better present mode: present is MAILBOX (never blocks) and the GPU cap
  the FIFO was bought for lives in the loop itself — `ControlFlow::WaitUntil`
  paced to the monitor's refresh period, re-read on every Resized. Liveness
  and pacing are now separate concerns; the compositor controls neither.
- **`FS_AT=<secs>` exists because the owner was at the keyboard.** The
  trigger was fullscreen, not keys — so the viewer learned to request
  compositor fullscreen itself, and the repro ran on a `hyprctl output
  create headless` monitor with zero focus theft. When a symptom needs a
  window-manager transition, give the app a harness knob for the transition
  instead of injecting input into a session the owner is actively using.
- **Hyprland 0.56: `hyprctl keyword windowrulev2 …` answers "ok" and does
  NOTHING** (deprecated). Two probe windows landed tiled — and once
  fullscreen-frozen — on the owner's live monitor before a version check
  exposed it. The 0.56 dynamic form is
  `hyprctl keyword windowrule "<field> <value>, match:title <re>"`
  (`no_initial_focus on`, `monitor <name>`); after adding rules, VERIFY the
  window's monitor id before letting anything fullscreen.

## 2026-07-27 (round F, the IDE) — a sibling tool's cache is not scene truth

**Context.** The personal IDE's hierarchy and world-pick needed the wall
RUNS. The crack lab already holds exactly that — `CrackLab.runs`,
`pier_run`, `label` — so the first cut read them.

**What went wrong.** Those fields are RESOLVE products: they are populated
when a level's wear authoring is compiled, which happens on levels that HAVE
authored wear. On the plain gym they are empty — so the first `IDE=1` SHOT
shipped a hierarchy with no walls at all, and (after a partial fix) a
selection lift on a single window-jamb sliver instead of the wall, because
`crack_select` selects a PIER while the IDE selects the authoring unit.

**The fix.** Derive from the artifact's own facts: `crack::runs_of(&piers)`
recomputes runs + the pier→run map from `Pier.run_lo/run_hi` — data every
build carries — and the lab's copies are used only for what they uniquely
own (the authored labels, guarded with a fallback name). Selection stamps
the SEL bit on EVERY pier of the run (clearing stale bits by re-deriving all
pier pads first — `KEEP_FLAGS` strips SEL, so the re-derive is the eraser).

**The lesson.** A cache that exists to serve tool A is empty exactly when
tool B assumes it. Before reading another module's state, ask what populates
it and WHEN — and if the underlying facts are cheap to re-derive (15 piers),
re-derive them. Corollary of the round-9 lesson at the selection layer: the
pier is a rendering artifact; anything user-facing (a pick, a highlight, a
list row) must speak in runs.

## 2026-07-27 (round H, the wall panel retires) — a failing test can be data, not code

**What happened.** Mid-round, four crack/crack_geom tests went red at once
("the level ships a control", "a control wall has no story — left: weather
0.68"). Every failure smelled like a regression from the deletions in
flight, and the natural move was to diff the round's own edits hunting the
break.

**What it actually was.** `crates/rt-viewer/wear/crack_lab.wear` had changed
on disk at 18:34 — between the previous round's verification battery and the
owner's next message. The owner had PLAYTESTED the new wear-in-IDE build:
his interactive slider exploration persisted (by design — edits save on
release) onto both of the lab's CONTROL walls, and the ramped control's
story carried the AgeWall beat's mid-flight state (the parked wrinkle,
fired in the wild the same day it was documented). The tests pin the
checked-in authoring, so they were correctly reporting that the LEVEL
changed — the code was innocent.

**The fix.** `git status` on data files FIRST when tests fail after a gap in
which the owner may have run the build — a wear file, a level file, a golden
is exactly as load-bearing as source. The session file was copied aside and
restored from git (controls must stay controls — the level's own design),
and the wrinkle got its prescribed fix in the same round: the beat is now a
`CrackLab::beat` override applied in `recompile` on the way to the sheet,
never written into the authored spec, so a mid-beat save can no longer
freeze ramp state into a file.

**The lesson.** On a project where playtests WRITE files into the working
tree, "tests passed an hour ago" is not evidence the tree is the same tree.
Check the data layer before suspecting the diff — and when a by-design
persistence surface meets a demo that mutates authored state, the demo must
ride an override lane (the level_dials discipline), or every playtest
quietly becomes an author.
