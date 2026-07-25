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

## Task 2 (after 1.5) — spalling with exposed rebar

Sketch, not committed: spall craters are currently plates that go
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
