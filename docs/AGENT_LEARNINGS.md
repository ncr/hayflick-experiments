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
