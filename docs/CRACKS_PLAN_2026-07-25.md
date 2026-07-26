# Procedural greybox aging — the 2026-07-25 owner round (plan)

Owner brief (2026-07-25, voice): the direction is **procedural shaders +
geometry on greyboxes** — flat boxes get cracks, scuffs, wear. Because the
render target is LOW-RES, every detail must be BIG enough to resolve and to
let the GI read it. Cracks are "reasonably readable" now; three asks, in
order, and NOT all at once:

1. **The crack ALGORITHM** (mesh deformation): cracks must read like
   LIGHTNING — branching, irregular — not straight/smooth lines. Two kinds:
   the coarse structural break (a wall cracked in half) and the fine
   age crazing. Both must get better.
2. **Spalling** (owner: "the ones whose name starts with Ą" — concrete
   losses that expose the REBAR underneath). Already "reasonably ok";
   improve it and show procedurally generated rebar in the cavity.
3. **New procedural wear kinds** — a proper brainstorm: what people do
   in the wild PLUS something unique to us. Pick, then build.

Process per CLAUDE.md: owner playtests via the LEVELS menu ("crack lab"),
every new dial gets a panel row, host-side work must not add shader-twin
debt while the spawner box is idle.

---

Mid-round addition (owner, same day): **a delicate ANTI-ALIASING on solid
CONTOURS only**, so deep thin crevices stop reading as isolated black
pixels. Queued as task 1.5 below — it is the one thing that would lift
the hairline end of the crack range, which is exactly where round 8 hit
its floor (nothing under ~2 px survives as a line today).

## Task 1 (round 8) — propagation cracks — DONE 2026-07-25 (awaiting owner playtest)

State before: `crack_geom.rs` grows nothing. Both scales are *analytic
lines*:

- the structural fault is `u(y) = ax + tilt·y + wob(y)` — one smooth
  vnoise wander per 6-wu strip, so it renders as a long soft arc; the
  pier is split into u-interval BANDS between successive faults;
- the "lightning" policy is a BSP splitter: each region is cut by one
  wandering line, roots/tapers/forks are *emulated* by shaping the cut's
  open span. Cuts still span whole regions, so plates are big shards and
  the visible cracks are again smooth curves.

Nothing in the model can KINK or BRANCH, which is exactly what the owner
sees. So round 8 replaces both with ONE shared primitive.

### The primitive: `Bolt` — a propagated crack path

A polyline in face coords grown by a deterministic walk:

- step ~0.1-0.25 wu (>= 3 px, so a kink resolves at the low-res target),
- per-step turn from a hash, plus a heavy-tail KINK draw (occasional
  50-75° stair step — the masonry look), plus mean reversion to the
  bolt's bias axis (settlement = vertical),
- FORKS: a child rooted at a parent vertex, angled by `spread`, gated by
  `branch`, budget and width scaled down per depth (a real hierarchy),
- dies on: budget spent, leaving the damage zone (crisp tip), leaving the
  face, or HITTING another bolt (T-junction — the strongest realism cue
  the old model could not express),
- per-arc-length half width: full at the root, tapering to the >= 1 px
  floor at the tip; CLOSED outside the open span.

`Bolt` implements the existing `CutLike` trait, so all the round-4..7
machinery carries over untouched: `cut_clip`, the >= 1 px `px_floor`, the
drooped groove walls, the chamfer, the sink/spall gates. Two changes to
the trait: `t_of(p)` replaces `tangent()`, and cuts may emit their own
wall polyline so kinks survive re-sampling. Side-of-path needs no
distance field and no parity walk: the walker's CORRIDOR clamp keeps the
path a function `u = f(v)` in its launch frame, so the side is the sign
of `u - f(v)` — the same structure the analytic cuts always had.

### Where it lands

- **Structural fault**: presence + the smooth SPINE stay (they mirror the
  shader's `faultAt` lattice float-for-float, which is what lets
  `GEO_BIT` suppress the paint and keeps the painted stain halo on the
  seam). The geometry path becomes a jagged trunk anchored to that spine
  (jag <= 0.15 wu, inside the 0.55-wu halo) plus 1-3 forks.
- **Pier splitting**: bands die. Pieces = the face rect clipped
  sequentially by every THROUGH bolt, each piece extruded to a PRISM
  (front/back planes + perimeter walls); settlement drop accumulates per
  through-cut. Forks are NOT through cuts — see "what actually landed".
- **Craze policy `lightning`**: the BSP splitter is replaced by a bolt
  NETWORK seeded in the damage patches; plates are whatever the network
  leaves. `craquelure` keeps the ladder splitter, `mosaic` the Worley
  baseline (both are the owner's A/B references).
- Panel params keep their names (branch/straight/spread) — they are now
  the walker's native dials, not shaping hacks on a BSP cut.

### Verification — done

`cargo test` (35 rt-viewer tests, 5 new: launch-frame monotonicity, the
network kinks + T-junctions, the >= 1 px across-crack floor, one through
break per fault + a jagging trunk, `carve` tiles the face) and
`cargo clippy --all-targets` are clean; `SHOT=` before/after at demo /
hot / max / craze-only; `LOOK_SWITCH=polana` rebuild path exercised
(6.5 s on the M2, bake-bound). Host-side only — **no shader edit, no new
Vulkan/Metal twin debt.**

### What actually landed (vs the sketch above)

- Fault forks do NOT carve pieces — they groove the veneer. A piece
  boundary is as long as whatever it splits, so a fork's invisible
  extension drew a hard line across the wall; three separate leaks made
  that extension visible before the layer move fixed the class. Details
  in docs/AGENT_LEARNINGS.md (2026-07-25 round 8).
- Width follows LENGTH (and forking follows length): uniform widths read
  as scratches no matter how well the path kinked.
- Cracks got their own, wider/earlier slice of the damage field
  (`crack_zone`): gating growth on the stain zone left a mid-aged wall
  visibly pristine.
- Bolt widths floor at ~2 px across the crack, not 1 px: a 1-px groove
  still dot-dashes even with the droop. Task 1.5 (contour AA) is the
  lever that could lower that floor again.

## Task 1.5 — delicate contour anti-aliasing — DONE 2026-07-25 (awaiting owner playtest)

Owner, 2026-07-25: a gentle AA that only anti-aliases the CONTOURS of
solids, so deep thin crevices read as lines instead of single black
pixels. This one touches the renderer, so it is a shader-twin round
(GLSL + MSL) — the first since the spawner box went idle.

BUILT: option 2 (true coverage), chosen by a 9-agent explore/judge workflow
over three rivals. Mechanism: `trace()` now returns the world distance to the
nearest gating triangle edge (the triangle's LONGEST edge is excluded, which is
every quad's diagonal); the shade pass converts it to screen px through the
exact minimum foreshortening `|n·d|` and parks it in the albedo G-buffer's
unused alpha; a GATE dispatch marks every texel that is NOT a contour (edge
farther than 0.42 px after a 4-neighbour dilation, or a locally PLANAR
neighbourhood — coplanar tilings like the grass grid are not contours); four tap
dispatches then re-run the SAME shade kernel with fixed sub-pixel offsets on the
survivors, accumulating `rgb = sum(w*L), a = sum(w)`; the tonemap divides. One
dial `contour aa` (ESC row, live at frame rate) + `AA=` env, `Look.aa = 0.8` on
both looks, `AA=0` bit-identical. Measured: gym 3.5 -> 6.8 ms, crack-lab
close-up 6.1 -> 16.4 ms (SIMD divergence, not the gated fraction — see the
learnings entry; compaction is the known lever). At the current 2.2-px crack
floor it visibly smooths every crack and silhouette; at a 1.1-px floor
(experiment, NOT shipped) hairlines go from dot-dash to continuous-but-faint,
which is the owner's payoff to approve.

Original options, kept for the record:

1. **G-buffer edge blend in the tonemap pass** (cheapest): the pass
   already has position/normal/flags per low-res texel, so detect
   silhouette/depth/id discontinuities and blend 2-3 taps at ~30-40%
   only across those. One pass, ~30 lines per twin, keeps interiors
   perfectly aliased (the pixel contract's intent), no extra rays. Risk:
   it blurs an EDGE, it cannot recover a crack the centre ray missed
   entirely — so a sub-pixel groove still dashes, it just dashes softer.
2. **Adaptive corner rays on discontinuity** (true coverage): where the
   4 pixel corners disagree, trace them and average. Recovers missed
   thin features (the real win for hairline cracks), costs rays only on
   contour pixels, stays deterministic (fixed corner offsets, no jitter).
   Risk: the shade pass is where the ROI/glass/cutaway logic lives, so
   the extra taps must reuse it without duplicating it.
3. Both, with a look-level strength knob + an ESC settings row (the
   owner playtests via menus, per docs/VISION.md).

The pixel-perfect contract needs an explicit amendment either way: it
currently forbids jitter and mandates hard pixel edges. Contour-only
coverage does not contradict its INTENT (no crawling, no temporal
shimmer, integer upscale untouched) but the wording must be updated
deliberately, with the owner's sign-off, not silently.

---

## Task 1.5b — scoped AA + crack softening — DONE 2026-07-25

Owner follow-up: "I'd like the anti-aliasing applied selectively — only on the
geometry of the chosen wall. Or else soften the rendering of those narrow cracks
so there are no mega-contrast pixels, harsh black and broken lines."

Both, on one gate:
- `aa scope` (ESC row, 0/1/2 = all surfaces / cracked piers / the PICKED pier),
  carried by `crack::AA_BIT` (`_pad` bit 7) stamped on each pier and its chalk
  core. Default 1, so the plain greybox keeps hard edges. Verified by a
  containment map: at scope 2 the changed pixels sit ENTIRELY on the picked
  wall. `CRACK_SEL=<index>` preselects for the harness.
- `aa soften` (ESC row, `AA_SOFT` env, look-authored default 0.35): the same
  contour gate, but the tonemap pulls the texel's radiance toward its
  4-neighbour mean. No rays: +0.2 ms on a full-screen wall.
- Cost after scoping: gym 3.49 -> 3.61 (soften) -> 3.72 ms (both); crack-lab
  close-up 5.91 -> 6.13 -> 14.91 ms. The 4-tap coverage is only expensive
  where the cracks actually fill the screen.

## Task 2 (after 1.5) — spalling with exposed rebar — SKETCH, built below

Sketch as first written (kept for the reasoning; the built version, its
measurements and the five defects the first cut had are further down): spall craters are currently plates that go
MISSING (chip gate) plus painted chalk. Owner wants the concrete loss to
expose REBAR. Direction: a procedural bar CAGE per wall (vertical bars on
a ~0.2-0.3 wu pitch + horizontal ties), living just under the veneer;
where a crater bites deeper than the cover depth, emit the bar segments
crossing it as real geometry (rusty, matte, round-ish = a few boxes at
this resolution, blocky per the tecta directive), with the crater rim
undercut and the bar casting its own contact shadow into the cavity. The
cage is a pure function of the pier, so it stays deterministic and
rebuild-cheap.

## Task 3, step 1 — the per-surface EFFECT WORD + the two mask fixes — DONE 2026-07-25

The approved catalogue's painted effects all need per-SURFACE dials, and
`Material` is full except its two ALPHA channels (unread by all four
kernels). `crates/rt-viewer/src/wear.rs` is now the ONE codec and the
single source of truth for the split: `emissive[3]` = the effect word,
four 6-bit unorm dials (24 bits, the f32 exact-integer budget, filled
exactly — lane 0 = EPOCH, lanes 1..3 unclaimed and named in that module
doc when claimed); `base_color[3]` = RESERVED for the facade story key,
which therefore needs no unpack and is inherited by chalk cores for free.
The word streams POST-BUILD only (`Viewer::wear_stamp` →
`RenderBackend::set_material_effect`), because the probe-cache key hashes
the material bytes and a pre-build stamp would buy a 6.5 s rebake for a
datum the bake cannot see. Harness seed: `WEAR=d0[,d1,d2,d3]`.

Landed with it, because two effects on a broken codec would clobber each
other silently: both knob stamps preserved only PART of the `_pad` flag
byte (`& 7` at boot, `& 231` on a live edit), so the next flag bit — the
wear family's value 16 — would have died at boot and on every knob touch.
There is now one shared `crack::stamped_pad` behind `crack::KEEP_FLAGS`
(the whole flag byte minus the recomputed selection bit) and a test that
pins a marked bit through boot + a live edit.

Inert by design (nothing reads the word yet): with `WEAR=1,1,1,1` (the
full 24-bit word on all 29 crack-lab pier/core materials) the crack-lab
SHOT differs from the pre-change baseline by 0.116% of pixels at max
delta 1/255 — BELOW the same session's two-run Metal noise floor
(0.137%, max 4). No shader edit; the Vulkan `set_material_effect` twin
was type-checked on macOS by temporarily dropping main.rs's cfg gate.

## Task 3, step 2 — LOCAL probe refresh for the crack-lab rebuild — DONE 2026-07-25

A knob release rebuilds the scene and re-baked the WHOLE probe grid
(~6.5 s on the M2, ~115 ms on the RTX). The geometry that changed is ONE
pier's boxes, inside that pier's own AABB — `crack_geom` already pins
that containment — so the baked banks are still right everywhere else.

- `RenderBackend::rebuild_scene` now takes a `ProbeRefresh`: `Full` (a
  look switch, a demo boot, a boot) or `Local(&[world AABB])`. The local
  arm CARRIES the baked banks across the scene swap and re-bakes only the
  probes around the dirty AABBs, using the `refresh_boxes` machinery that
  already existed in both backends for the Stage-2 tear-off. ONE trait
  entry point, not two: a "swap now, refresh later" pair would have a
  window where the frame renders against stale probes.
- Which piers are dirty comes from `crack_geom::signatures` — the release
  check became PER PIER (it was one whole-state hash), so a drag yields
  exactly the piers it moved. New test pins that a drag/pattern click
  dirties exactly one pier.
- The bake is kept for everything uncertain: no bake to carry, a grid that
  MOVED (it is derived from `scene.min/max`), a dirty region off-grid, or a
  dirty set past `LOCAL_REFRESH_MAX_FRACTION`. Cache semantics are intact
  by construction — only `bake_probes` ever `store`s, and the carried
  buffer is not a bake of the new scene, so nothing can write a cache file
  that lies. A cache HIT is tried FIRST on the local path (interactive
  only): an exact full bake of this scene beats a carry.
- Harness: `CRACK_EDIT=age,cracks,depth,chip[,pier]` replays a panel drag
  + release at the end of boot (an agent cannot click, and booting into the
  final knobs measures the BOOT bake, not the rebuild). `PROBE_LOCAL=0`
  forces the full rebake — the A/B below.

Measured on the M2 (crack lab, `CRACK_SEL=7`, 9672 probes @ 0.5 wu):

| rebuild | probes | ms |
|---|---|---|
| full rebake (`PROBE_LOCAL=0`) | 9672 | 6583–7380 |
| local, one pier | 1512 (16 %) | 3312–3804 |
| local, 15 piers | declined by the fraction cap → full | 6893 |

Only ~2×, and the reason is worth writing down: the refresh is
LATENCY-bound, not work-bound. One thread per probe serially casts
2048 rays × 2 banks, so a small dispatch cannot fill the GPU — 680 probes
cost 3091 ms and 1512 cost 3334 ms, while the whole grid as ONE box runs
at bake throughput (0.62 vs 0.66 ms/probe). Forcing the bake's
20-rays-per-dispatch batch onto the small box changed nothing (3534 vs
3451 ms), which pins it on occupancy rather than dispatch count. Two
consequences, both now constants with the measurements in their doc
comments (`rt_probe::gpu_scene`): the pad is nearly free, so
`REFRESH_PAD_SPACINGS = 3` buys the bounce halo; and past ~1/5 of the grid
the refresh costs MORE than the bake, hence `LOCAL_REFRESH_MAX_FRACTION`
(a 15-pier edit forced local took 12729 ms — the cap turns that into a
6893 ms bake). Getting past 2× needs either the amortized DDGI roll path
(zero stall, but a 256-ray estimate ≠ a full bake) or a ray-parallel probe
kernel (a shader edit in both twins) — neither is this step.

Image A/B, local vs a FULL rebake of the identical state (the residue is
the far-field bounce of the changed wall, which a local refresh cannot
capture; it is never ON the rebuilt wall):

| framing | two full runs (cross-run floor) | local vs full |
|---|---|---|
| close-up, 0.8→0.5 on pier 7 | 0.032 %, max 1/255 | 0.959 %, max 1/255 |
| wide level view, same edit | 0.015 %, max 1 | 0.824 %, max 1 |
| close-up, pristine→max BREAK | 5.313 %, max 9 | 0.750 %, max 64 |

The third row is the AA-heavy frame class from the 2026-07-25 learnings:
two identical FULL runs differ by 5.3 % there, and two identical LOCAL
runs by 0.264 % with the same max-64 single pixel — so the local path's
difference is well inside this machine's own cross-run noise. The pad
curve behind `REFRESH_PAD_SPACINGS = 3`: pad 1 → 2.58 % of pixels differ,
pad 2 → 1.68 %, pad 3 → 0.96 %, all at max 1/255, at essentially the same
wall-clock. Untouched paths re-verified: `LOOK_SWITCH=polana` still full
bakes and lands at the floor (0.074 %), the plain gym boot is 4 pixels
from its step-1 baseline, and a boot with both steps applied is 0.144 %
from a HEAD build rendered in the same session.

## Task 3, step 3 — EFFECT 10 "fresh break vs weathered skin" — DONE 2026-07-25

The chalk CORE is the surface the damage EXPOSED (groove floors, spalled
crater floors, the inset faces behind the veneer), but it copied the
pier's knob bits, so the shade pass painted the AGED SKIN's history onto
material that had been UNDER that skin: the tea-stain streaks ran
straight through a crater and the fine glaze web crazed inside it. With
the core only 3.9 % darker than the wall in luma, a crater read as a
faint dark DECAL instead of lost material.

- **Discriminator, no new flag bit.** MATTE (`_pad` bit 4) together with
  nonzero knob bits is unique to the chalk core: `mark_matte` only ever
  marks the grass floor and the tufts, which are never knobbed, and a
  pier is glazed porcelain, never matte. Claimed instead of the last free
  flag (value 16), and pinned over the WHOLE built gym by
  `crack_geom::matte_plus_knobs_is_only_the_chalk_core` — the test also
  asserts the matte greens are still there, so it cannot pass vacuously.
  A future generator that mints a matte material for a knobbed pier (the
  spall's rust-stained basin chalk is the obvious candidate) trips it.
- **Shader, both twins, 3 lines:** `float skin = (kb & 4u) != 0u ? 0.0 :
  1.0` — the WEATHERED fraction — multiplies `fineW` and `sAmt`. The
  painted chip patches needed no gate: `crazeG` already zeroes `chipM`
  on every core. The CONTACT GRIME term stays live on the core
  deliberately (a perfectly clean crater reads as spilled white paint,
  and AO is what darkens a deep one), as does the ~1 % greybox scuff
  (`bump = 0.1` on polana makes it invisible either way).
  `skin` is deliberately a FLOAT, not a bool: the EPOCH dial (wear.rs
  lane 0, step 1) turns it into a continuum so an old crater stains again.
- **Host:** `crack_geom::fresh_body` replaces a duplicated
  `0.97/0.96/0.94 × body` tint (it was spelled out twice — `chalk_material`
  and `craze_pier`'s inline core). The exposed body is the glaze
  DESATURATED to its own brightest channel — polana's wall is a warm
  off-white, so dropping the warm cast IS most of the paleness — lifted
  `FRESH_LIFT = 1.03` and clamped under 1. Host-side rather than
  shader-side because the probe bake reads `baseColor`, so a paler crater
  floor also bounces correctly. Cost: the probe-cache content key moves,
  so every cached crack-lab bake misses once.

Measured (crack lab, garden wall, `mask` = a magenta-core diagnostic
build; the numbers are from runs WITHOUT `CRACK_SEL` so the amber
selection tint cannot inflate them):

| framing / knobs | crater vs skin, luma | crater warm cast (R−B) vs skin |
|---|---|---|
| ZOOM 2.5, `0.8,0.8,0.7,0.9` before | +2.44 % | +15.0 vs +14.5 (identical) |
| … after | **+4.52 %** | **+8.7 vs +13.8** |
| ZOOM 2.5, `1.0,0.8,0.7,1.0` before | +3.69 % | +16.0 vs +15.0 |
| … after | **+6.29 %** | **+8.7 vs +14.2** |
| ZOOM 1 (game), `0.8,0.8,0.7,0.9` before | −1.66 % | +15.8 vs +16.1 |
| … after | +0.89 % | **+9.1 vs +16.0** |

Decomposed at max aging: +3.69 % (before) → +4.48 % (shader alone) →
+5.53 % (host colour alone) → +6.29 % (both); the host colour owns the HUE
cue, the shader owns the stain termination. In the hottest 64-px tile —
a big missing plate whose surviving veneer strips are stained — the mean
|Δ| is 21.7/255 and the peak 33/255: that is the read the owner judges.

**THE CEILING, stated plainly.** polana's wall albedo is already
0.965/0.947/0.913 linear, so "paler" has only ~5 % of albedo headroom
before white — `FRESH_LIFT` is within 0.5 % of the physical maximum. No
albedo-only change can make a crater assertive, and at ZOOM 1 a
chip-knob crater (4-20 px of a ~250-px-wide wall) still does not read as
lost material. The surviving cue there is chromatic (neutral body vs warm
stained glaze, amplified by the look's `sat = 1.42`); total RGB
separation crater-vs-skin roughly doubles at close range (7.5 → 16.0) but
only goes 5.4 → 6.9 at game range. The conclusion is the catalogue's own:
a crater's read has to come from GEOMETRY — the rebar spall's basin,
undercut lip and bar shadows — and THIS step is what stops that geometry
from wearing the old skin's stains.

Cost to the crack read, measured because the same core material is both
"crack floor" and "fresh break": the darkest core pixels lighten by ~2
levels (grooves-only case: min 44.0 → 45.9, p1 108.2 → 109.0), i.e. the
crack-to-skin contrast drops 1.4 %. The cracks keep their read; splitting
groove floors from crater floors needs two core materials, which is
exactly what the spall's basin-floor prim brings.

Containment (|Δ| ≥ 3 against the magenta core mask; cross-run floor for
this framing 4.52 % of pixels at max 4/255, 146 off-mask pixels ≥ 3):

| bucket | high chip | grooves only |
|---|---|---|
| on core surfaces | 93.4 % | 82.3 % |
| within 2-4 px (AA tap + local bounce) | 4.8 % | 12.7 % |
| elsewhere on the wall (GI bounce) | 1.7 % | 5.0 % |
| grass / everything else | 0.16 % (194 px) | 0.04 % (16 px) |

Untouched paths: the plain gym boot is 4 pixels (1 LSB) from its step-2
baseline; frame time unchanged (gym 3.79-4.01 ms, crack-lab close-up
15.2-16.5 ms); `CRACK_EDIT` still takes the local probe refresh (1512
probes, 3275 ms).

## Task 3, step 4 — EFFECT 9 "one wall, one story" — DONE 2026-07-25

13 of the crack-lab gym's 15 piers belong to ONE building, cut out of five
authored wall runs — and every one of them seeded its aging off
`material_id & 255` (host `seg_of`, shader `float(h.mat & 255) * 0.618`).
So the only structure in the level read as a pile of independently aged
slabs: a damage patch stopped dead at every window jamb, because the
field RESTARTED there.

- **The story key.** `wear::story_key` hashes the pier's parent RUN
  (`Pier::run_lo/run_hi`, quantized to the 0.1-wu authoring grid) into one
  f32 and `wear::stamp_story` writes it to `Material.base_color[3]` — the
  channel step 1 reserved for exactly this. The shade pass reads it RAW
  (`float story = m.baseColor.a`): no unpack, and no host/shader float
  mirror for the term at all, which is one FEWER mirror than the `seg` it
  replaces. Value = `(hash & 255) × 0.618`, deliberately the same
  distribution and range as the per-panel seed, so every field seeded off
  it (`story*7+3`, `story+5`, `story+9`) stays in its tuned regime.
  Stamped PRE-build (unlike the effect word) because the HOST geometry
  pass must read the same key; cost is the same one-time probe-cache miss
  `fresh_body` already paid. Chalk cores inherit it for free
  (`chalk_material` copies `base_color`).
- **What moved, and what did NOT.** On the run: the macro damage field
  (`dmgN`/`CrazeCfg::dmg` — hence stains, chips, zones, the whole veneer
  layout) and both craze lattices. Per PANEL, deliberately: the
  structural FAULT lattice (`seg`), because a shared fault seed rolls the
  6-wu settlement lattice once per facade and three panels cracking off
  one roll reads as a repeated stamp — the owner risk on record. Depth and
  chip stay per pier for the same reason (texture-scale dials).
- **The age ramp.** `crack::seed_knobs` took a pier-INDEX hash on all four
  knobs; age/cracks now take `crack::run_ramp` — a smooth monotone
  gradient along the parent run, direction drawn per run — so a facade has
  a bad end and a clean end instead of four unrelated panels. Honest note
  in the code: the catalogue's "one low-frequency vnoise cell spans the
  run" IS algebraically a rescaled smoothstep once it is normalized to the
  run's own ends (and normalizing is required — a raw sample's amplitude is
  a lottery, and a flat draw would age a whole facade uniformly); worse,
  drawing the direction off the noise's x axis gave all twelve trial runs
  the SAME direction (`hash13` x-axis bias at small offsets), so the
  direction is drawn on the story axis and pinned by a test.
- Both shader twins moved together (one added line + three seed swaps
  each, byte-parallel); `crack_geom::signatures` signs the story key.

Measured (M2, Metal, crack lab, `WINDOW=1280x800 ZOOM=1.6 TARGET_X=7.3
TARGET_Z=3.8` — the building's EAST facade, three panels of the x=8 run;
the garden walls the lab spawns beside are single-pier runs where this
effect cannot show):

| framing / knobs | changed pixels | max Δ |
|---|---|---|
| east facade, `0.6,0.5,0.55,0.2` | 16.90 % | 179 |
| east facade, demo boot seed (vary 0.4) | 18.17 % | 187 |
| east facade, hot `0.9,0.7,0.6,0.4` | see SHOTs | — |
| whole level, `0.6,0.5,0.55,0.2` | 11.98 % | 187 |
| south facade + doorway | 17.66 % | 184 |
| two identical AFTER runs (this framing's noise floor) | 0.141 % | 1 |

The age ramp, straight out of `seed_knobs` (demo seed, base age 0.55,
vary 0.4) — the east facade's three panels, far → near:

| | before (index hash) | after (run ramp) |
|---|---|---|
| age | 0.525 / 0.539 / 0.683 | **0.370 / 0.550 / 0.730** |
| cracks | 0.317 / 0.364 / 0.575 | **0.320 / 0.500 / 0.680** |

…and the direction is per run: the north facade ramps the other way
(0.730 / 0.550 / 0.370). The gym's seven runs get seven distinct story
keys (pinned). Single-pier runs (both garden walls) sit at the ramp's
pivot and keep the base knobs — their damage still varies across the wall,
through the field rather than the knobs.

Garden-wall check (the foreground z=10 run in the wide shot, wall pixels
only): damaged fraction 6.84 % → 7.26 %, deep-dark (crack cores) 4.62 % →
4.62 %, mean luma 193.9 → 193.8, warm cast 16.0 → 15.9. The pattern MOVED
(they are runs too, so their seed changed) but the amount and character
did not — they did not get worse.

Frame cost: nil. Plain gym 3.74-3.80 ms (unchanged, and its boot SHOT is 8
pixels from the step-3 baseline — the effect is scoped to knobbed piers).
The facade frame went 11.9 → 12.6-13.8 ms with the contour AA on, and
`AA=0` puts both at 5.7 ms — i.e. the difference is the AA's contour AREA
(this seed ages more of THIS facade), not a per-texel cost. Prims 359 →
363, tris 17324 → 16944. `CRACK_EDIT` still takes step 2's local probe
refresh (1512 probes, 3448 ms); `LOOK_SWITCH=polana` lands 0.88 % from a
direct boot at max Δ 2, scattered over the aged walls only — a re-stamp
that got the story wrong would have moved every patch instead.

Known consequence, not a defect: the doorway splits the south wall into
TWO authored runs, so they get two stories and the field jumps across the
opening. Nothing visible at any knob setting tried (there is no damage
adjacent to the doorway in those draws), and the one-line alternative —
hash the run's LINE (axis + coordinate + roomy flag) instead of its
extent — would merge them at the price of merging any two collinear runs.

## Task 3, step 5 — the FIELD LEVEL lane (the un-ageable facade) — DONE 2026-07-25, **RETIRED 2026-07-26**

> **Retired by the effects refactor** (`wall.rs`'s solved thresholds). The lane
> existed to nudge each run's field toward a canonical level — that is, to
> correct the SYMPTOM of a lottery. Solving each layer's threshold from the
> run's own sorted samples removes the lottery at the source, so `run_level`,
> `level_quantize`, `LEVEL_STEP`, `level_fraction` and `WEAR_LEVEL` are all
> deleted and lanes 0/1 of the effect word now carry two ABSOLUTE gate codes
> instead. The section below is kept as the record of the measurement that
> justified the lane, because the numbers in it (the gym's seven runs spreading
> 0.000 .. 0.645 of damaged area at age 0.9) are what the replacement had to
> beat, and it did: `an_amount_is_an_area` measures a worst error of 0.103.


Step 4's defect, fixed: `dmgN` is a raw fbm and every feature gate is an
ABSOLUTE threshold on it (`dT = mix(0.74, 0.55, age)`, zone at `dT + 0.02`,
cracks at `dT - 0.10`). One facade is only ~2 cells of the field's dominant
octave wide, so the LEVEL of its single draw is a lottery — and step 4 made it
ONE draw per RUN instead of one per panel. Measured over the crack-lab gym's
seven runs, the field's 98th percentile spread **0.491 .. 0.915**: the z=8 run
behind the doorway never cleared the zone gate at ANY age while the x=8 facade
was already wrecked at age 0.3.

**The fix, and why it is a fraction and not a percentile.** `crack_geom::run_level`
samples the field over the RUN's whole authored face on the 0.1-wu authoring
lattice (the same `dmg_field` the shader computes and `CrazeCfg::dmg` cuts
plates with — one definition, three callers), then returns the offset that puts
the `1 − f` percentile onto a canonical gate level, where

- the gate is `dT(age_ref) + 0.05` — the level at which the craze zone is HALF
  open, at `wear::LEVEL_AGE_REF = 0.6` (mid-slider, just above the demo's own
  base age 0.55);
- `f = wear::level_fraction(run)` is drawn PER RUN in `LEVEL_FRACTION =
  0.06..0.24` off a second salt of the story hash.

So a run's damaged AREA at the reference age IS the drawn fraction, by
construction. Normalizing to a drawn TARGET rather than to one constant is what
keeps the story: one wall is a bad wall and the next merely tired (4× between
the band's ends), and inside each, `crack::run_ramp` still gives a bad end and a
clean end. What the normalization deletes is only the part nobody authored — the
amplitude of one fbm draw.

The band is calibrated, not chosen: it leaves the level's MEAN damaged area
where the owner last saw it (0.152 → 0.180 of a face at the reference age) while
deleting both tails.

| run (authored rect ×10) | f drawn | offset | zone @ age 0.3 | @ 0.6 | @ 0.9 |
|---|---|---|---|---|---|
| south z=3 `[29,29,81,31]` | 0.174 | +0.072 | 0.001 → 0.018 | 0.013 → 0.184 | 0.129 → 0.487 |
| doorway W `[29,79,51,81]` | 0.130 | +0.120 | 0.000 → 0.085 | 0.017 → 0.137 | 0.079 → 0.189 |
| doorway E `[59,79,81,81]` | 0.178 | +0.240 | **0.000 → 0.035** | **0.000 → 0.247** | **0.000 → 0.490** |
| garden z=10 `[99,99,161,101]` | 0.216 | +0.048 | 0.001 → 0.082 | 0.102 → 0.223 | 0.257 → 0.511 |
| west x=3 `[29,29,31,81]` | 0.129 | −0.036 | 0.116 → 0.066 | 0.184 → 0.139 | 0.271 → 0.209 |
| east x=8 `[79,29,81,81]` | 0.112 | −0.132 | **0.234 → 0.076** | **0.423 → 0.118** | **0.645 → 0.176** |
| spur x=12 `[119,19,121,61]` | 0.204 | −0.072 | 0.221 → 0.135 | 0.329 → 0.210 | 0.498 → 0.273 |
| **range** | | −0.132..+0.240 | 0.000-0.234 → 0.018-0.135 | 0.000-0.423 → 0.118-0.247 | 0.000-0.645 → 0.176-0.511 |

(`zone` = the fraction of the run's face where `CrazeCfg::zone > 0.35`, the same
gate that opens a plate. Pinned by
`crack_geom::every_gym_run_ages_and_none_is_wrecked_young`, whose vacuity guard
recomputes the table at offset 0 and requires it to FAIL the bound.)

**The transport, and the one thing that made it signed.** The offset rides
`wear`'s lane 1. It is NOT a unorm dial: it is a 6-bit two's-complement code in
units of `LEVEL_STEP = 0.012`, because the empty word — every material nobody
stamped, including any core a future generator mints — has to decode to
*exactly no normalization*. A unorm lane would hand it the range's low end and
silently un-age it, which is this step's own defect applied to itself. Range
−0.384..+0.372 against a measured need of −0.132..+0.240 (≈50 % headroom;
past the end it clamps to a partly normalized run, never a wrapped sign). Grain
0.012 is 20 % of the zone gate's 0.06 window, i.e. ≤3 % of a face's damaged
area.

**Mirror discipline.** The value is measured on the host and applied on BOTH
sides, so the classic drift (geometry vs paint) is one `LEVEL_STEP` away.
`wear::level_quantize` is the only thing the host may add, and
`wear::both_shader_twins_decode_the_level_lane_exactly_as_the_host_packs_it`
`include_str!`s both `shade.comp` and `shade.metal` and fails the build if
either stops spelling the shift, the signed decode, the step, or the `+ dOff`
into `dmgN` — which also catches "ported one twin only".

The offset is a pure function of the RUN (rect + story key), independent of the
knobs, so a knob drag never moves it and the release gate still dirties exactly
the pier that moved (verified: `CRACK_EDIT` → 1512 probes, 3610 ms local
refresh). `WEAR_LEVEL=0` zeroes it at the ONE place both readers get it from —
the harness A/B, and the proof that "before" means before.

Measured (M2, Metal, 1280×800; every framing's own two-run floor first):

| framing | floor (two identical runs) | new vs HEAD |
|---|---|---|
| `CRACKS=0` pristine | 16 px @ 1 LSB | **16 px @ 1 LSB** (bit-identical) |
| plain gym boot (no lab) | — | **24 px @ 1 LSB**, 3.75 → 3.76 ms |
| hot `0.9,0.8,0.6,0.3`, SE corner | 0.119 % @ 4 | 20.94 % @ 180 |
| hot, north facade `ZOOM 2.0 X 6.8 Z 8.0` | 0.058 % @ 3 | 22.23 % @ 180 |
| demo boot seed, wide level view | max 10 (bake-to-bake) | 6.21 % @ 185 |
| `WEAR_LEVEL=0` vs HEAD (all framings) | — | at the floor (max 2-10) |

Frame cost: nil per texel (two ALU ops). The crack-lab close-up went 5.83 →
6.07 ms at `AA=0` and 14.3 → 15.0-16.9 ms with the contour AA on — that is the
extra crack GEOMETRY this seed now grows (prims 365 → 369, tris 32984 → 35584)
filling more contour area, the same accounting as step 4.

Known consequence, stated plainly: the east facade — the showcase wall of step
4's shots — is now the level's CLEAN one (0.645 → 0.176 damaged at age 0.9), and
the previously dead doorway-east panel is one of the worst. The roles swapped
because the normalization is two-sided; a one-sided variant (raise the dead,
never lower the wrecked) would preserve step 4's shots but leave the level's
mean damage 1.7× higher and keep half the "pristine facade beside a wrecked
wall" contrast that started this.

## Task 2 (the sketch above, built) — COVER SPALL WITH EXPOSED REBAR — DONE 2026-07-25

Delivers task 2's sketch, and the owner's own headline for the round
("large concrete spalls with the REBAR showing underneath"). Scope note for the
playtest: what landed this round is cover-spall-with-rebar plus step 5's field
level — nothing from the arris or glaze-chip families, so "does the eased arris
read as thicker ceramic" cannot be answered yet.

**The cage first, the damage second.** `rebar.rs` builds a WORLD-anchored
reinforcement mat (verticals at `u = 0.4·i`, ties at `y = 0.25 + 0.5·j`), so it
lines up across pier joints and around the building corner; then a corrosion
potential decides where the cover fails. Only the segments a crater actually
exposes ever become triangles. `crack_geom::emit_crater` is the mesh:

| ring | depth | what it is |
|---|---|---|
| `ins` → `ring` | 0 | the surviving cover's front face (the COLLAR) |
| `ins` → `rim` | 0 → `cham_d` | the chamfered lip |
| `rim` → `hole` | `cham_d` → `t` | the UNDERCUT — the cover overhangs the void by 0.04 wu |
| `hole` → `ring` | `t` | the SHELF the lost cover sat on |
| `ring` | 0 → `t` | the patch rect's wall |
| `hole` → `hole` | `t` → `floor` | the basin wall |
| `hole` | `floor` | the basin floor |

Every ring is sampled on the SAME rays out of the crater's centre, so each band
is a valid quad by construction — the same discipline as `Walk`'s corridor
clamp, and the reason this is not a polygon boolean.

**ONE owner dial**, the panel's `spall` row under the four knobs, staged so it
does something over its whole travel:

| dial | what he sees |
|---|---|
| ≤ 0.12 | nothing — the wall is cracked, where round 8 left it |
| 0.12 … 0.43 | LIFTED COVER: a shallow lens, pale fresh-break floor, cover overhanging its top edge, no steel |
| 0.43 … 1 | BLOWN SPALL: the floor cuts past the mat, 1-3 bars stand proud with their own shadows, up to three craters |

Harness: `SPALL=<0..1>` and `SPALL_LAYER=1|2|3` (both on config.rs's shell-only
exception list). The dial is a CEILING — `crack::seed_spall` multiplies by a
skewed per-pier draw, so `SPALL=0` is genuinely off and the demo's own boot seed
(0.65) leaves 4 of 15 walls clean, which is the control the damage is read
against.

### Five things that were wrong in the first cut, and what replaced them

1. **Rebar in FACE coordinates.** `Mesh::boxx` pushed its corners straight into
   `quad` without `Frame::w`, so all 7 Z-run piers put their cage at the
   transposed world position — a rust cross floating in the gym's doorway in the
   DEFAULT boot state. It now takes the world AABB (`Mesh::world_box`), which
   also sidesteps the winding flip the depth axis introduces.
2. **The mat in front of the cover.** `cover` was CLAMPED to fit a depth budget
   and came out smaller than the veneer, so the steel sat in the veneer's hollow
   and showed through grooves on walls with no crater. Cover is now DERIVED
   (`veneer + BAR_SET`) and everything else gives way: the basin depth and the
   bar's section are what get clamped.
3. **The perforation clamp measured against the SLAB.** The solid behind a
   crater is the CORE (inset by the veneer on both faces), so at depth knob ≥ 0.6
   the floor went coplanar with the core's rear plane and past it. `budget()`
   now derives everything from the core.
4. **A hole into the core's hollow.** The core's front plane was cut back to the
   patch RECT while the basin opened at the RIM — the annulus between them was a
   window into the box's interior. The SHELF row above closes it.
5. **A moss-green crater floor** (#717e64, G+13 on a wall that is neutral to
   −0.3): `FLOOR_TILT` aimed the floor's normal 45° down, i.e. at the lawn, under
   polana's `sat = 1.42`. Deleted. The cavity's darkness is now AUTHORED into the
   basin's albedo (`BASIN_AO`), which costs no hue, and every cavity normal
   points mostly OUT so nothing in the crater stares at the grass.

### The honest exaggerations, stated

- A crater on a 0.2-wu wall is ~15 px wide and ~2 px deep, so its REAL sky
  visibility is ~0.95 — traced faithfully it darkens by 5 %, which the tonemap
  eats whole (measured: the interior came out at 94 % of the wall's tone). The
  0.66 → 0.34 albedo is a baked AO, the same class of lie as round 4's drooped
  lip normal, and it buys 75 %.
- 1 wu ≈ 1.2 m, so a 0.075-wu bar is a ~9 cm rebar under ~7 cm of cover: 4-5×
  real. That is the price of ≥ 2 px, the same stylization the blocky greybox
  runs on. **Rejected on sight, 2026-07-26** ("jest za gruby") and the owner is
  right twice over: it is nearer 6-7× real, and against a 0.15-0.30 wu lens it
  filled the crater it was meant to sit in — at ZOOM 6 the basin was a solid
  brown mass with no chalk floor showing. The section is now **0.036 wu**
  (1.5 px on an X face, 1.0 on the worst Z one): a LINE of steel with one lit
  edge, which is both what rebar in a spall looks like and what the contour AA
  is on this geometry for. Sweep: 0.050 still read as a log; 0.026 read fine at
  every zoom but is 0.73 px on a Z-run face — under one texel, surviving only on
  the rust-against-chalk contrast. ~3× real is the residue, and it is the price
  of a pixel on the axis the projection foreshortens.
- The depth knob's veneer eats the core from both sides (`t = 0.02 … 0.45 ·
  thick`), so above depth ≈ 0.72 on a 0.2-wu wall there is no core left to hold
  a mat and the dial stops at LIFTED COVER. The alternative was the bar in front
  of the core's front plane, i.e. defect 2 again.

### Both faces spall

The camera is orthographic but the owner turns it in quarter steps (q/e), so a
wall shows either of its big faces over a session. A one-sided crater is damage
that vanishes when he presses `e` while the cracks and paint around it stay, so
each face gets its own crater set (same damage field, salted seed). The two sets
are vetoed DISJOINT in (u, y) — each basin may cut past the slab's
half-thickness, so two craters facing each other would perforate the wall.
Pinned by `a_walls_two_faces_never_spall_through_each_other`, with a vacuity
guard that the facing basins really are deep enough to meet.

### Measured (M2, Metal, 1280×800, ZOOM 2.6 on the z=10 garden wall)

| pair | result |
|---|---|
| two identical runs (the floor) | 648 px differ, **max delta 3** |
| `SPALL_LAYER=2` (steel only) vs `SPALL=0` | **0 px above 3 %**, max delta 4 — the mat is buried by construction |
| `SPALL_LAYER=1` (crater only) vs `SPALL=0` | 167 856 px, max 197 |
| `SPALL=1` vs `SPALL=0` | 170 304 px, max 191 |
| crater interior vs wall (crater only) | 148 vs 199 = **74 %**, G−max(R,B) = **+1** (was +13 and green) |
| basin floor beside the bar, with vs without the bar | 147 → 137: the bar's **cast shadow**, ~7 % over 2-3 texels |

Feature sizes at the game projection: crater 0.3 × 0.7 wu = **12.4 × 27 px** on
an X-run face, **8.5 × 27 px** on a Z-run one; bar section 0.036 wu = **1.5 /
1.0 px** across plus as much again of depth parallax (2026-07-26; it was
0.063-0.075 wu = 2.6-3.1 px, see the exaggerations above); undercut lip 0.04 wu
= **1.6 / 1.1 px**. Three sub-2-px features now, which is why the pier, its
core, its basin and its steel all take the contour AA's opt-in bit.

### The rim is a broken plate, not a perturbed oval (2026-07-26)

Owner, same look: "owalne dziury nie są realistyczne". The rim was `r(θ)` — the
lens ellipse with two octaves of value noise on its radius, the second octave
deliberately pitched above what 16 samples resolve so it would land as ragged
per-vertex jitter. It does not land that way: perturbing a radius keeps every
tangent continuous, so amplitude buys a lumpier egg and never a corner, and
fifteen of them in one frame read as a punched pattern.

The rim is now a POLYGON: 6-10 fracture corners drawn per crater, joined by
straight chords, with one inward-frayed sample per facet. Both invariants the
mesh pass rests on survive by construction rather than by test —

- **star-shaped about `c`**: corners are drawn at ascending angles (the jitter is
  a quarter of one gap, so it cannot reorder them), and a polygon whose vertices
  ascend in angle is hit exactly once by every ray out of `c`. That is what
  keeps `rim[i]`/`ring[i]` a valid quad ring in `emit_crater`.
- **inside the patch rect**: every corner radius is within `1 ± RIM_VAR` and a
  chord of a convex region stays inside it, so no chord can bulge past the bound
  the rect was sized for. The fraying is inward-only for the same reason.

The bar LOBE (the rim reaching out along a crossing) dropped from `^8` to `^4`:
on a curve a narrow reach was a gentle bulge, but between straight facets it
converges to a needle, and needle-ended lenses read as a stencilled leaf motif.

Pinned by `the_rim_is_a_broken_plate_and_not_a_perturbed_oval` with two
statistics the old generator could not produce: on a smoothly sampled curve the
2π of turning spreads evenly, so no vertex turns much past 2·2π/N ≈ 0.6 rad and
none turns ≈ 0. Measured on the facet rim over four facades: hardest corner
**1.90-2.43 rad**, flattest sample **0.001-0.031**. The gates are 1.2 and 0.06.

One consequence, and it is the round's real lesson: halving the section moved
the staging knee in front of the lifted-cover stage's own starting depth, so the
steel showed at the bottom of the dial and the floor ramp ran backwards. The
three stages are now a fact about the DIAL (`st >= ST_STEEL`), with
`knee.max(floor0)` to keep the ramp monotone — see the 2026-07-26 learning.

## Task 3, step 5 — EFFECT "eased arris" (glaze ease) — DONE 2026-07-25

The look is porcelain and a perfectly sharp arris is the tell of cardboard.
Every EXPOSED vertical corner and top edge of a static greybox box now carries a
chamfer with its own bisector normal, so the boxes read as thick glazed ceramic
volumes. It lifts every wall and roof in the level at once and it is the first
client of the box→MESH PROMOTER (`wear_geom::ease_box`) that the knocked-arris
and worn-doorway passes ride later.

### The three decisions worth keeping

**Authored in SCREEN pixels, not world units.** `wear_geom::sizes` derives the
chamfer from the game projection's own authored axis images: a vertical facet
spans +c on one ground axis and −c on the other, so the corner FACING the camera
projects to `c·|px_x − px_z|` = 60.8 px/wu — and that factor holds at all four
camera quarters, because the projection rotates with the camera. 3 px → c =
0.0493 wu. The 0.2-wu wall slab caps it at 0.05 (two facets may never eat half a
face), so the readability floor and the geometric ceiling agree within 1.5 % —
which is also why there is no bigger "jamb" class: a reveal's flat end face is
only 5.7 px wide to begin with.

**The promoter keeps the box's IDENTITY.** One prim, one material, at the index a
plain box would have taken. The `crack_geom` idiom (append a mesh, collapse the
box) would have silently broken the two things that hide a box BY PRIM INDEX —
the wall-smash rig and the roof tear-off.

**One run owns each junction.** The building's corners are two overlapping slabs
sharing a 0.2 × 0.2 column. Chamfer both and the two 45° facets are the SAME
plane (the 2026-07-12 strobe class); chamfer neither and the building's most
visible arris stays sharp. So `gym_scene::end_kind` classifies every run end from
the run rects alone — Open / Buried (a T-junction) / Yield — and the yielding
slab pulls out of the shared column by the overlap minus one authoring lattice
step, which leaves its end plane strictly INSIDE the owner rather than coplanar
with the owner's inner face. The yield is gated on the dial, so `ARRIS=0` is the
old level byte for byte.

### Measured (M2, Metal, 1280×800, plain gym boot — this framing's cross-run floor is 4-20 px at 1 LSB)

| feature | wu | game px |
|---|---|---|
| vertical facet, camera-facing corner | 0.0493 | **3.0** (measured 6 window px = 3 low-res texels) |
| vertical facet, silhouette corner | 0.0493 | back-facing — the outline just steps in 1.4 px and stays hard |
| top-arris facet | 0.0387 | **2.4** (measured 2 texels), and the wall top drops from 5.7 to 3.5 px of flat |

| tone (row 400 / 150, boot view) | before | after |
|---|---|---|
| garden wall: long face / END face | 201 / 191 | 201 / **211 facet** / 191 |
| building corner: facade A / facade B | 201 / 215 | 201 / **217,214,202 facet** / 215,208,188 |
| shaded corner where the sun grazes (yaw 1) | 192 / 137 | 192 / **68,91,65 facet** / 137 |

The last row is the honest one: a facet is a true third tone whose SIGN follows
the sun. Decomposed with `DEBUG_DIRECT`/`DEBUG_GI`, that dark band is not AO and
not acne — the lit face is grazed by the sun and the shaded face is lamp-lit, so
the 45° bisector falls past both terminators and is ambient-only. Real eased
arrises do exactly that; it is what makes a corner read as a corner.

| cost | before | after |
|---|---|---|
| gym frame | 3.71-3.74 ms | 4.13-4.20 ms (+13 %) |
| gym triangles | 1688 | 2184 (+29 %) |
| probe bake (boot / look switch / a dial step) | 2386 ms | 3275 ms (+37 %) |

So "zero per-frame cost" (the catalogue's claim) is wrong by 0.45 ms: the bill is
BLAS traversal on 29 % more triangles, and the bake pays it 2048 times per probe.
It takes no contour AA (`AA_BIT` untouched): a facet is an AREA of constant
screen width under a camera that cannot foreshorten it, so there is no sampling
lottery to fix — CLAUDE.md's rule is feature SIZE, and 3 px is not thin detail.

Known limit, stated rather than hidden: a crazed crack-lab pier LOSES its ease —
`apply_geometry` collapses the pier's prim and re-emits the whole face, so at the
demo's boot seed all 15 lab piers are sharp again while the roof and any unaged
wall are eased. The plain gym (the owner's default boot) is where this effect is
judged; handing `Frame::of` the inset rect is the follow-up the catalogue itself
sketched.

## Task 3, step 6 — THE OWNER'S SURFACE: facade spawn, a control wall, an age beat — DONE 2026-07-25

Everything above is invisible unless the level he opens shows it. Three
changes to `demos.rs` (plus the one backend addition the third needed), and a
recorded clip so the whole round arrives as motion instead of thirty SHOT pairs.

### 1. The lab faces the building now

Spawn `(13, 12)` → `(9, 11)`. The old spot stood between the two freestanding
garden walls — both SINGLE-PIER runs, so "one wall, one story" has no joint to
cross and no ramp, and they carry no cap, no windows, no corner and no jambs:
most of this round's causal gates were off screen, and the building was a
clipped sliver in the top-left with the lower third of the frame empty lawn.
From `(9, 11)` the building's SOUTH-EAST corner fills the upper half — two
facades, four window reveals, the doorway jambs, the parapet cap — with the
z=10 garden wall as foreground and the x=12 spur top-right.

**The staging constraint is an inequality, not taste.** The ROI reveal
dissolves an occluder only when the hit is IN FRONT of the player
(`dot(hit.xz − player.xz, fwd) >= 0` breaks the walk in both shade twins), and
the trimetric camera looks down `(1, 2)` in xz — so a wall is safe exactly
when its `x + 2z` is below the player's. The building maxes at 24.2 and the
player sits at 32.5. For a wall PARALLEL to the ground axis the crossover
point has a closed form: for the z=10 run it lands at screen
`(100·(p.z − 10), +25)` px from the disc centre — independent of `p.x` — so
any spawn with `p.z ≥ 11.11` puts it past the 79 + 33 px disc. `p.z = 11.5`
does; standing NORTH of that wall instead ghosts it from end to end, which is
what ruled out every framing that had the building bigger.

### 2. A pristine control wall (two of them)

`CrackSeed::pristine` is a list of world (x, z) points whose piers boot with
zero knobs and zero spall — named by point, not index, so re-cutting the level
cannot silently move the control (the `SmashWall` idiom). The demo names two,
and they do different jobs:

- **(12, 4), the x=12 spur** — the permanent NEGATIVE CONTROL. Without one in
  frame, "aged" quietly becomes the level's base tone and there is nothing to
  read the damage against.
- **(13, 10), the z=10 garden wall** — the biggest, nearest, least obstructed
  wall in the frame, and therefore what the age beat ramps. A ramp has to start
  from pristine or it only shows its own top half.

`a_wall_the_demo_names_pristine_is_exactly_the_plain_greybox` pins that a
control is the GREYBOX, not "less aged": zero knob BITS (so the shade pass's
CRACK LAB block never fires and never even reads the story key), no GEO/CRAZE
marks, no AA opt-in, no chalk core, no steel — and its vertices equal the same
gym built with no crack lab at all. That last comparison is the right one and a
24-vertex box is not: the eased-arris pass already promoted every static box to
a mesh.

### 3. The age beat — `Action::AgeWall { x, z, over }`

From tick 60, one wall weathers from the greybox to worse-than-the-level over
180 ticks (3 s). `crack::ramp_knobs` STAGES the layers instead of cross-fading
them, because that is the causal order the catalogue is built on and it is what
makes the beat read as a story: the glaze stains and crazes (0 → 0.55 of the
ramp), the crack network opens through it (0.25 → 0.85), chips come off
(0.45 → 1.0), and only at the end does the cover let go and show the rebar
(0.60 → 1.0). Each stage gets ~0.8 s to itself.

**Why (a) "ramp the paint, step the geometry" and not (b) "pre-build the
stages".** The painted layers ride the per-frame material stream, so they are
free at 60 fps. Geometry only exists after a scene rebuild, and the measurement
that decides everything is this: the scene swap costs **~30 ms**, while the
probe half of `ProbeRefresh::Local` costs **5.1 s**. Pre-building the stages
would need one baked probe set per stage and a way to show exactly one — a lot
of machinery to avoid a 30 ms step. So the beat commits geometry every 12 ticks
and the GI goes to a new third mode:

`backend::ProbeRefresh::Roll(&dirty)` — carry the baked banks exactly as
`Local` does, then hand the dirty box to the amortized DDGI roll (`roll_step`,
already there for the wall-smash tear-off) instead of blocking on the refresh.
This is not "a smaller refresh": a synchronous refresh is LATENCY-bound (one
thread per probe, 2048 rays serial), so 680 probes cost 3.1 s and 1512 cost
3.3 s — shrinking the box buys nothing, only deferring does.

| | Local (a mouse-up) | Roll (the beat) |
|---|---|---|
| scene swap | ~30 ms | ~30 ms |
| probe work in the call | 5.1 s (792 probes) | 0 — 64 amortized frames |
| exactness | a 2048-ray bake of the dirty probes | a 256-ray rolling estimate |

A mouse-up keeps `Local`: interactive dialing is not animating, and the owner
gets the exact answer for the state he stopped on.

**The roll is not free per frame, and that is the honest cost of this design.**
`roll_step` runs two WAITED command buffers per frame and rewrites the whole
light/material arrays four times around them, so on the M2 the crack lab's
frame goes 9.2 ms → 33.4 ms while a roll is armed (measured; ~30 fps). It is
ray-linear on top of a fixed floor — `ROLL_K` 2 / 8 / 16 → 20.7 / 33.4 /
50.3 ms, i.e. ≈ 7 ms fixed + 2.1 ms per ray per frame — and every commit
re-arms it, so the beat and its 64-frame tail run at 30-40 fps rather than 60.

Shipped anyway, with the reasoning on the record: it is a **bounded 4-second
window in a scripted beat**, not a stall; the path it replaces costs 16 × 5.1 s
of hard freezes; the same per-frame price is already paid by the approved
wall-smash demo; and `ROLL_K`/`ROLL_FRAMES` are backend-global, so tuning them
for this beat would silently retune that demo's settle. On the RTX the whole
grid bakes in ~115 ms, so `Roll` may be unnecessary there entirely. The two
levers, if the owner minds: arm the roll only on the ramp's FINAL commit (the
intermediate estimates never converge anyway, since each commit re-primes), or
drop `ROLL_K` and lengthen `ROLL_FRAMES` to match.

### Measured (M2, Metal, 1280×800, `LEVEL="crack lab"`)

| | |
|---|---|
| commits over the 180-tick ramp | 16, ALL of which moved the geometry |
| per commit | 21-32 ms — under two frames at 60 fps |
| triangles across the ramp | 18 091 → 33 517 |
| roll convergence (max Δ vs a full-bake run of the same tick) | 46 → 28 → 22 → **6** over its 64 frames |
| converged roll vs full bake | mean **0.023/255**, max **3.9/255** — and the difference map sits on the ramped wall, its shadow and the player, nowhere else |
| consecutive frames during the ramp | mean 0.007-0.028, max 1 — except max 23 at tick 180, which is a new spall crater appearing, not a GI pop |
| frame while a roll is armed | 9.2 → 33.4 ms (`ROLL_K` 2/8/16 → 20.7/33.4/50.3 — ≈7 ms fixed + 2.1 ms/ray) |
| plain gym boot vs the pre-change build | 12 px at 1 LSB (this framing's two-run floor: 4 px at 1 LSB) — untouched |
| `LOOK_SWITCH=polana` vs a direct boot | 237 px (0.023 %) at max 2 |
| `CRACK_EDIT` (a mouse-up) | still the EXACT local refresh: 792 probes, 5.1 s |

The clip: `.claude/skills/record-gameplay/scripts/record.sh` over a 470-tick
trace — stand and watch the wall age, walk east past it, back west, north to
the facade and in through the doorway (WALLCUT). 7.8 s at 60 fps.

### Playtest recipe, per effect (LEVELS → "crack lab")

| effect | where to look | what says it works |
|---|---|---|
| **the beat itself** | stand still for the first 5 s | the near garden wall goes from clean porcelain to a cracked, chipped wall with three rust bars showing, in one continuous read |
| **cover spall + rebar** (task 2) | the same wall at the end of the beat; or click any building pier and drag `spall` | a lens-shaped hole with a bar crossing it and the bar's own shadow on the floor of the crater; the surviving cover overhangs the top edge |
| **fresh break** (step 3) | inside any crater at high `chip` | the interior is PALER and neutral, and the tea-stain streaks stop dead at the lip instead of running through |
| **one wall, one story** (step 4) | the building's two visible facades | a damage patch crosses a window jamb instead of restarting at it, and each facade is worse at one end |
| **field level** (step 5) | the panel between the doorway and the corner | it ages at all — that panel was the un-ageable one |
| **glaze ease** (step 5b) | the pristine control walls and the parapet cap | a crisp 3-px band of a third grey down every corner and along every top edge; it is the CONTROL walls that show it, since a crazed pier still loses its ease |
| **the control** | the x=12 spur, top-right | it never changes, all session — that is the "before" |
| **the knobs** | click any wall | the panel replaces the hamburger: four knobs, the spall dial, the pattern row and that policy's own params |

### Known, and worth the owner's opinion

- The beat leaves the ramped wall's probes at the roll's 256-ray estimate
  rather than the bake's 2048. Invisible (max 3.9/255), and any later knob drag
  on that wall re-bakes them exactly.
- Two of the level's fifteen walls now boot clean, so the FIRST frame reads
  less weathered than it used to. That is the point of a control, but it is a
  taste call: `CrackSeed::pristine` is the one line that moves it.
- The lower-left of the boot frame is empty lawn. It is structural: the ROI
  inequality forces the player to the maximum `x + 2z` of everything he is
  meant to see un-ghosted, so the content is always up-left of him.

## Task 3 (later) — new wear kinds

Brainstorm to run when tasks 1-2 land. Seeds so far (unvetted): water
staining/runoff below openings and along cracks (we have a hint of it in
paint), efflorescence bloom, biological growth in the damp zone, impact
scars at knee height on corners, patch repairs (a lighter rectangle of
newer render over an old crack), settlement drift of whole piers, edge
rounding/chipping on every arris (cheap, huge readability win at low
res), sun-bleach gradients by orientation, dirt tide-lines from splash
back, graffiti-scale abstract marks, and OUR-own idea candidates: aging
that follows the GI (grime where the probes say it is dark), and a
"history" pass where one event (the settlement fault) CAUSES the
secondary features around it instead of every layer being independent
noise.
