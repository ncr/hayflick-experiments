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
