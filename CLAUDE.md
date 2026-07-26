# CLAUDE.md — Project Conventions (rust branch)

Native Rust only. The TypeScript web stack lives on `main`; every dropped
direction (goo arena, thief deduction, cave/village generator scenes, the
generated town with its NPCs) lives under the git tags
`archive/pre-joyful-reset` and `archive/town-testbed` (2026-07-12 purges).

## Required Reading

Before making technical decisions, read:
- `docs/VISION.md` — the BINDING direction: joyful greyboxes → miodny player
  → gameplay, and the process rules (owner playtests via ESC menu only)
- `docs/AGENT_LEARNINGS.md` — post-mortems and failure patterns (per `AGENTS.md`)
- `ARCHITECTURE.md` — the workspace split + boundaries (historical sections
  reference deleted systems; the dependency rules still bind)

## Workspace

Cargo workspace at the repo root, members `crates/*`:

| Crate | Role | May depend on |
|---|---|---|
| `iso-core` | pure projection-as-data camera/lattice math (Faza 1a DONE: `Projection` derives the camera from two integer pixel vectors; presets `iso21`, `trimetric`) | glam only |
| `sim-core` | generic sim runtime (fixed tick, InputQueue, Pcg32, traces) | hecs, glam |
| `house-game` | ALL game logic, fully headless: the `gym` testbed + movement primitives | sim-core, iso-core |
| `rt-probe` | deterministic renderer lib (Vulkan ray_query) + GLSL | iso-core |
| `rt-viewer` | `viewer` binary: winit shell, Metal backend, gym loop, capture | everything |

**rt-probe and house-game never see each other** — only rt-viewer's adapter
knows both. The game must build and test without a GPU.

## The second level: the effect catalogue (owner 2026-07-26)

The gym is still THE scene. The catalogue (`house_game::gym::sim::catalogue_level`,
menu entry "effect catalogue", `LEVEL="effect catalogue"`) is a BENCH, added on
the owner's ask "create a special level that shows each of them separately":
fifteen identical 2.2 × 2.1875 wu slabs in three rows of five on open grass,
each its own wall RUN, plus one small building at the back for the dress that
needs a Room (windows, glass, a doorway jamb, a parapet cap). Row 0 = pattern
and scale, row 1 = loss, row 2 = paint, and rows 0 and 2 each open on a
PRISTINE control. Identical is the point — a difference between two slabs is the
EFFECT, which the gym's fifteen piers (different lengths, orientations,
neighbours and glazing) can never show. The rows are offset +2 cells in x per
+4 wu of z so they stack in one SCREEN column: the projection's axis images are
+x → (40, 10) px and +z → (−20, 20) px, so the two shifts cancel to (0, +100).

`crack::CrackSeed::specimens` is the mechanism: a per-wall override named by
world point (like `pristine`), applied LAST so it outranks the base knobs, the
variance and the pristine list. Building it surfaced two effects that the
system could not otherwise isolate, and both got a real dial rather than a
test hook:

- **`Specimen::paint_only`** — stamp the knobs, skip the geometry pass
  (`CrackLab::geom_input` masks that pier for BOTH `apply_geometry` and
  `signatures`). Without it the shade pass's painted crack network and painted
  chips are DEAD CODE: `craze_pier` runs on any pier with a nonzero knob and
  sets `CRAZE_BIT`, which is exactly what the shader gates those two layers off.
  The whole paint row is paint-only, including the two slabs with no crack knob
  at all — a nonzero AGE alone is enough to trigger the geometry pass.
- **`Specimen::faults` / `crack_geom::faults_for`'s veto** — fault presence and
  the small-crack network are coupled through AGE (`0.95 · smoothstep(0.12,
  0.42, age) · smoothstep(0.04, 0.45, cracks)`, and the damage field only opens
  a readable patch above age ≈ 0.5), so at every age where a veneer pattern is
  visible the odds of also breaking the wall in half are ≥ 0.9. `apply_geometry`
  and `signatures` take a per-pier `no_fault` mask.

ONE specimen is not 2 cells wide, and the reason is the effect's own scale: a
fault is drawn once per 6-wu STRIP with its axis anywhere inside it, so a 2.2-wu
slab contains that axis about a third of the time — the fault specimen came up
EMPTY on the first build (caught by `catalogue_tests`). It is 4 cells
(`sim::SPEC_WIDE`). Pinned: every specimen names a real pier, no two share one,
each is its own run, paint-only piers carry knobs but no `GEO/CRAZE` bit, and
the vetoed piers keep their veneer while the fault specimen really faults.

## The one scene: the gym

`viewer` boots the gym (`house_game::gym::sim::gym_level`): ONE hand-authored
18×14 level — a few freestanding walls, one building with a doorway, two
lamps, the player. No NPCs, no generators, no seed (owner directive
2026-07-12: everything the look/movement work needs, nothing else).
`LOOK=<name|index>` seeds the greybox look (`rt-viewer/src/look.rs`; Faza 1b
DONE: a Look is the WHOLE aesthetic as one datum — palette, sun/sky
(`SunSky`), post stack (`StyleCfg`), exposure, surface response).
THE look (owner pick + same-day "delete rest", 2026-07-12): **`polana` is
the ONLY look** — porcelain × meadow: clean ceramic volumes; occasional
FULL-HEIGHT black tinted-glass windows on building walls only (even
world-coordinate cells; REAL wall openings + transmissive panes — the
shade pass carries primary rays through with the pane's tint, shadow
rays/probe bake keep glass opaque, and in the WALLCUT cutaway glass stubs
deliberately stand 0.3125 proud of wall stubs to cover the bay jambs);
lush saturated greens + grass-tuft dress; amber lamp mood. The other
candidates are deleted (git history) and the ESC menu has NO look row
(one preset = dead UI; a menu.rs test pin demands the row back the moment
a second look lands). Lock + goldens await the owner playtest.
Same-day BLOCKY mesh rebuild (owner: prostsze kształty, blokowość jak
tecta): every gym mesh is the fewest boxes that read — walls are clean
slabs (no plinth), the roof is ONE inset parapet cap (no fascia — the
amber accent moved to the lamps — no ridge; `RoofStyle` deleted), lamps
are post + lantern block, grass tufts single blocks, the player a 10-box
figure. Greens are MATTE by construction (`Material._pad` bit 4, set by
`gym_scene::mark_matte` on the grass floor + tufts): the shade pass skips
spec + the gloss remap there — "trawa nie może się błyszczeć"; porcelain
and glass keep the sheen.
GLAZE EASE (2026-07-25, the approved effects catalogue): the blocky boxes
are no longer paper cutouts — every EXPOSED arris of a wall pier or roof
cap carries a chamfer authored in SCREEN pixels (3 px on the vertical
corner facing the camera, 2.4 px on a top edge, derived from the
projection's axis images in `wear_geom::sizes`, clamped so two facets never
eat half a face). `wear_geom::ease_box` is the box→mesh PROMOTER: one prim,
one material, at the index a plain box would have taken — everything that
marks or hides a box by prim index keeps working. WHICH arrises are exposed
is a fact about the level, so `gym_scene` decides it (`end_kind`): the
building's corners are two overlapping slabs sharing a 0.2 × 0.2 column, so
one run OWNS each corner and the other YIELDS the column (chamfering both
would emit two coincident 45° facets — the 2026-07-12 strobe class). Dial:
ESC row "glaze ease" / `ARRIS=` (look-authored 1.0), and it is GEOMETRY —
a step rebuilds + rebakes (~3 s on the M2), and `ARRIS=0` rebuilds the
plain boxes byte for byte. A crazed crack-lab pier loses its ease (the
geometry pass collapses the box and re-emits the whole face) — known, and
the hook to hand it the inset rect is in `wear_geom`'s doc.
THE CRACK-LAB DEMO IS THE OWNER'S SURFACE for all of the above, and since
2026-07-25 it is STAGED rather than just enabled. It spawns at (9, 11)
FACING the building's south-east corner — two facades, their window
reveals, the doorway jambs and the parapet cap — with the z=10 garden wall
as foreground and the x=12 spur top-right. (It used to open at (13, 12),
between the two garden walls: both single-pier runs, so "one wall, one
story" had no joint to cross, and with no cap, no windows, no corner and
no jambs most of the round's causal gates were off screen.) The staging
rule is not taste: the ROI reveal only dissolves occluders IN FRONT of
the player, and the trimetric camera looks down (1, 2) in xz, so a wall
is safe exactly when its `x + 2z` is below the player's — from (9.5, 11.5)
the whole building and the garden wall's near half are, and the wall's
crossover into the disc sits 152 px out (the disc is 79 + 33 px).
TWO WALLS BOOT PRISTINE (`CrackSeed::pristine`, named by world point, not
index): the x=12 spur is the permanent NEGATIVE CONTROL — without one in
frame, "aged" silently becomes the level's base tone — and the z=10 garden
wall is what the `AgeWall` beat ramps. That beat is the round's clip:
from tick 60 it weathers one wall from the greybox to worse-than-the-level
over 3 s, staging the layers in causal order (stains and the fine web,
then the crack network, then chips, then the cover letting go and the
rebar showing). The painted knobs ride the per-frame material stream, the
GEOMETRY is committed every 12 ticks (16 rebuilds, 21-32 ms each, 18 k →
34 k tris) — cheap because the commit takes the new
`backend::ProbeRefresh::Roll`: carry the baked banks, hand the dirty box to
the amortized DDGI roll instead of the 3-5 s synchronous refresh (which is
latency-bound, so shrinking it does not help). Measured: the roll converges
to within max 4/255 of a full re-bake in its 64 frames. A mouse-up still
takes the EXACT `Local` refresh — interactive dialing is not animating.
STATED COST: an armed roll costs 9.2 → 33.4 ms/frame on the M2 (two waited
command buffers + four whole-material uploads per frame), so the beat and
its tail run at 30-40 fps, not 60 — bounded, ~4 s, and against 16 × 5.1 s
of freezes on the path it replaced. Levers in
docs/CRACKS_PLAN_2026-07-25.md if the owner minds.
`LOOK_SWITCH=polana` force-rebuilds INTO the booted look via
`RenderBackend::rebuild_scene` + probe rebake (disk-cached per look) — the
headless identity check for the whole runtime-switch machinery (a SHOT
after it must match a direct boot up to the Metal cross-run noise floor —
see the 2026-07-12 learning).
`PROJ=<name|index>` seeds the projection preset; the DEFAULT is
`trimetric` — THE game projection (owner pick, 2026-07-12) — with `iso21`
kept as the A/B reference the owner can switch to in the ESC settings menu.
The WALLCUT dollhouse cutaway and the ROI reveal follow the live player.

The gym's cell-stepping mover is INTERIM — Faza 2 replaces it with the
continuous miodny movement stack. Don't grow it.

## Key Commands

| Command | Description |
|---|---|
| `bin/run` | Build + launch the viewer (the gym; ESC = game menu) |
| `cargo test` | Headless workspace tests (the CI-able layer) |
| `bin/golden` | SUSPENDED until the Faza-1 look lock (prints the interim procedure) |
| `.claude/skills/record-gameplay` | Headless gym trace → MP4 clip |

Env knobs pass through `bin/run` (see `crates/rt-probe/src/config.rs`):
`WINDOW=WxH SHOT=out.png` renders one headless frame; `DEMO=<trace>
DEMO_TICKS=N DEMO_DIR=<dir>` renders frame sequences; `LOOK=…`.

## Determinism — the load-bearing discipline

1. **Fixed tick (60 Hz), replayable command streams.** Sim time = `tick / 60`;
   gym traces (`<tick> move dx dz [walk|run]`) drive headless runs
   bit-identically.
2. **`state_hash` + replay tests** pin sim behaviour (`cargo test`).
3. **No wall-clock, no unseeded RNG in the sim.** (The current gym sim uses
   no RNG at all; anything seeded goes through `Pcg32`.)
4. **Byte goldens are suspended** during the visual reset (Faza 0/1). Verify
   render changes with before/after `SHOT=` diffs; re-pin goldens per
   machine/backend once the owner locks the look (see `bin/golden`).

## Two render backends — keep them in lockstep

`crates/rt-probe/src/shaders/*.comp` (GLSL/Vulkan) and
`crates/rt-viewer/src/shaders_metal/*.metal` (MSL) are line-for-line twins.
A feature added to one must be ported to the other in the same effort, or
documented as debt. Shared push-constant structs live once in
`crates/rt-viewer/src/backend.rs`. Since the contour AA (2026-07-25) the
radiance image carries `rgb = sum(w*L), a = sum(w)`: **every reader must divide
by `.a` when `.a > 1`** (two per twin today — the tonemap's radiance load and
its bloom tap; a negative `.a` marks a non-contour texel the gate pass skipped).

The Mac dev machine (M2 Pro) runs the **Metal** backend; the Arch "spawner"
box (RTX 5080) runs Vulkan. **Spawner duty DISCHARGED (2026-07-17,
first hardware session):** the whole blind-edit backlog (Faza 0–1b hosts,
`Material.pad` bitfield shaders, Stage-2/3 GI, `fp.env`) ran on the RTX
5080. One real break found: Faza-1b's blind edit dropped `use glam::Vec3`
from `vulkan_backend.rs` (never compiled on macOS — cfg-gated). Facts
worth keeping: ShadePush 256 B IS accepted by the device; the full 2048-ray
bake takes ~115 ms (vs seconds on the M2); `LOOK_SWITCH=polana` is
BYTE-IDENTICAL to a direct boot; and the Vulkan/RTX cross-run noise floor
is ZERO (unlike Metal's ~1-LSB floor — byte-diffing across process runs is
valid here). **BLIND VULKAN (2026-07-25):** the contour-AA work — `shade.comp`'s edge
distance / gate / tap offsets, `tonemap.comp`'s two divides, and
`vulkan_backend.rs`'s five extra dispatches with a memory barrier between each
— is unverified on hardware. The GLSL type-checks here (rt-probe's build.rs
runs glslangValidator), but the read-modify-write ordering of the tap
dispatches on the radiance image is runtime semantics only the RTX box can
confirm. First Vulkan session: `AA=0` must be byte-identical (its cross-run
floor is zero) and `AA=0.8` must agree with Metal in character.

**BLIND VULKAN (2026-07-25, the wear round):** three more items, all unrun on
hardware. (1) `VulkanBackend::set_material_effect` — the effect-word streamer,
written blind (it type-checks on macOS only by temporarily dropping main.rs's
cfg gate). (2) The WHOLE Vulkan local-probe-refresh carry path
(`SceneGpu::carry_probes` + `refresh_boxes_for`'s callers): its accept/decline
thresholds are derived from M2 occupancy, and on the RTX a full bake is ~115 ms,
so a 16%-of-grid local refresh may well be SLOWER there — first session must
time `CRACK_EDIT="0.5,0.5,0.4,0.6,7"` with and without `PROBE_LOCAL=0` and
record both numbers next to the M2 table. (2b) The `roll` arm of that same
`SceneGpu::carry_probes` (the age-ramp beat's `ProbeRefresh::Roll`) — it
compiles on macOS (rt-probe's `render` module is not cfg-gated) but has never
run; boot `LEVEL="crack lab"` on the RTX and watch the z=10 garden wall
weather from tick 60: the wall must age with NO brightness pop and no stall,
and 64 frames after the last commit the frame must match a `PROBE_LOCAL=0`
run of the same tick (which forces a full bake per commit). Note the RTX
bakes the whole grid in ~115 ms, so `Roll` may simply be unnecessary there —
if a full bake per commit is under a frame, say so in this register rather
than keeping a path nobody needs. (3) `shade.comp`'s fresh-break and
story-key reads (the MSL twins are the VERIFIED side this round — the blind side
is INVERTED versus 2026-07-17/23, so do not assume the old direction). The
discriminating check for the story key: `LEVEL="crack lab"
CRACKS="0.9,0.7,0.6,0.4" WINDOW=1280x800 ZOOM=1.6 TARGET_X=7.3 TARGET_Z=3.8` —
the three panels of the east facade must share ONE damage pattern that continues
across the window jambs; per-panel islands mean the story key never arrived.

**Open Metal duty (2026-07-17):** the phase-3 wall-smash demo
(`LEVEL="wall smash"`, demos/viewer/phys-spike/gym_scene edits) is
host-side only — no shader or backend code touched — but was built and
verified on Vulkan only; first Mac session should boot it and eyeball the
collapse + GI settle. ALSO 2026-07-17: the crack-lab CRACK LAB block in
shade.metal + `MetalBackend::set_material_pad` are blind line-for-line
twins of the Vulkan-verified GLSL/host code — boot `LEVEL="crack lab"`,
check the aged walls match the Vulkan SHOTs in character, and click/drag
the knob panel once. 2026-07-23: the heterogeneous-aging rework of that
same block (per-segment damage field + sparse structural fault cracks,
Vulkan-verified) is again a blind MSL twin — the same crack-lab boot
check covers it. Structural faults and the WHOLE small-crack network
are REAL geometry now (crack_geom.rs — host-side, shared by both
backends), and the two layers COMPOSE: every knobbed pier gets a
matte-chalk core + a veneer of plates laid out by a selectable pattern
POLICY — lightning/craquelure/mosaic since 2026-07-23 round 7
— panel "pattern" row, and BELOW it each policy's NATIVE param sliders
(`crack_geom::POLICY_PARAMS`: lightning branch/straight/spread,
craquelure scale/wave, mosaic scale/jitter; stored per pier per policy);
`CRACKS=a,c,d,p[,policy[,p1,p2,p3]]` — split by 1-px-or-wider drooped
grooves (depth knob = groove depth, adaptive 0.02..0.45 × wall thickness
so the whole slider is live) with CHAMFERED edges (~1-px miter-inset
bevel on open-groove edges only — the plate cedes the strip, the gap
keeps its width), recessed chips and sinks; faulted piers additionally
split into jagged pieces with a gap + settlement drop, the veneer
clipped against the fault paths (fault lips chamfer too) and the network
clustering along the seam (halo). Rounds 7-8 are host-side only — no new
shader debt; the only blind MSL edit left in that block is the
pad-bit-5/-6 `show`-suppression branch (+ the crazeG chip line), and a
2026-07-25 headless Mac boot of `LEVEL="crack lab"` renders it right
(the knob panel's click/drag still wants a windowed pass).
The chalk core is the FRESH BREAK since 2026-07-25 (task-3 step 3): what
the damage exposed is not the weathered skin, so the shade pass gates the
stains and the fine glaze web off it (`float skin`, keyed on MATTE bit 4
+ nonzero knob bits — no new flag bit; pinned by
`crack_geom::matte_plus_knobs_is_only_the_chalk_core`) and
`crack_geom::fresh_body` mints it as pale NEUTRAL unglazed body instead
of a 4 %-darker tint. **The blind side is INVERTED for this one:** the
MSL twin was verified here on Metal, the GLSL twin compiles (build.rs
runs glslangValidator) but has never RUN — a first Vulkan session should
boot `LEVEL="crack lab" CRACKS="1.0,0.8,0.7,1.0"` and confirm the crater
interiors read pale-neutral while the stain streaks stop at the lip. A
knob-release rebuild (`Viewer::crack_release`) measured ~6.5 s on the M2
vs ~115 ms on the RTX; since 2026-07-25 it takes the LOCAL probe path
(`backend::ProbeRefresh::Local` — carry the baked banks across the scene
swap, re-bake only the probes around the piers whose per-pier
`crack_geom::signatures` moved) and costs ~3.3 s on the M2. Only 2×
because the refresh is latency-bound (one thread per probe × 4096 serial
rays), not because of the probe count — the numbers and the two constants
they set (`REFRESH_PAD_SPACINGS`, `LOCAL_REFRESH_MAX_FRACTION`) are in
`rt_probe::gpu_scene` and docs/CRACKS_PLAN_2026-07-25.md. Harness:
`CRACK_EDIT=age,cracks,depth,chip[,pier]` replays a panel drag + release
after boot; `PROBE_LOCAL=0` forces the old full rebake for the A/B.
ONE WALL, ONE STORY since 2026-07-25 (task-3 step 4): aging is seeded per
WALL RUN, not per panel. `wear::story_key` hashes the pier's authored run
(`Pier::run_lo/run_hi`) into `Material.base_color[3]`, `crack::resolve`
stamps it before the geometry pass, and BOTH the host damage field
(`crack_geom::CrazeCfg`) and the shade pass (`float story =
m.baseColor.a`) seed off that one f32 — so a damage patch crosses a
window opening instead of restarting at the jamb (pinned as an equality
by `crack_geom::piers_of_one_run_share_a_damage_field_but_not_a_fault_lattice`),
and chalk cores inherit it for free. The structural FAULT lattice stays
per panel (`seg`) — a shared fault seed would crack a facade at one
repeated position — as do the depth/chip knobs; `crack::run_ramp` puts
only age/cracks on a per-run gradient, so a facade has a bad end and a
clean end. The two `_pad`/alpha budgets are documented in one place:
`crates/rt-viewer/src/wear.rs`. The GLSL twin's one-line `story` read is
blind (same inverted side as step 3, same crack-lab boot check).
FIELD LEVEL since 2026-07-25 (task-3 step 5), the effect word's first real
consumer: the damage field's gates are ABSOLUTE thresholds on an fbm, and
one facade is only ~2 cells of its dominant octave wide, so once the field
went per-RUN a whole facade could be UN-AGEABLE (measured: the gym's seven
runs spread their damaged area from 0.000 to 0.645 at age 0.9).
`crack_geom::run_level` samples the field over the RUN's own face on the
0.1-wu lattice and returns the offset that puts a per-run drawn FRACTION of
it (`wear::level_fraction`, 0.06..0.24 of the face at age 0.6) over the
gate; `wear`'s lane 1 carries it to the shade pass as a 6-bit TWO'S-
COMPLEMENT code in units of `LEVEL_STEP = 0.012` (signed precisely so the
EMPTY word means "not normalized" — a unorm lane would un-age every
unstamped surface). Host and shader both apply `level_quantize`'s value, and
`wear::both_shader_twins_decode_the_level_lane_exactly_as_the_host_packs_it`
reads both `.comp` and `.metal` at compile time and fails the build if
either drifts. `WEAR_LEVEL=0` is the harness A/B (bit-identical to before
the lane). Same inverted blind side: the GLSL twin's two lines compile
(build.rs runs glslangValidator) but have never RUN. The failure signature
is NOT a blank wall — the HOST always applies its own copy of the offset, so
a dead GLSL read shows as PAINT THAT DISAGREES WITH THE PLATES (stains and
the fine web sitting off the grooved region), a tonal shift only, ~15 % of
the frame at Δ31 (simulated on Metal, 2026-07-25). A first Vulkan session
should boot `LEVEL="crack lab" CRACKS="0.9,0.8,0.6,0.3" WINDOW=1280x800
ZOOM=2.0 TARGET_X=6.8 TARGET_Z=8.0` and compare the panel between the
doorway and the corner against the Metal reference; the RTX cross-run noise
floor is zero, so any byte difference from a `WEAR_LEVEL=0` build is real
signal either way.

COVER SPALL WITH REBAR since 2026-07-25 (task-3 step 2, owner headline
"large concrete spalls with the REBAR showing underneath"): one staged
panel dial — `spall`, under the four knobs — walks cracked (<= 0.12) ->
LIFTED COVER (a shallow lens, no steel) -> BLOWN SPALL (the floor cuts past
a world-anchored reinforcement mat, so 1-3 bars stand proud of the basin and
cast into it). `rebar.rs` is the mat, the corrosion potential (the
normalized damage field + a splash BAND + window reveals + the parapet) and
the crater outline; `crack_geom::emit_crater` is the mesh — collar, chamfer,
undercut, shelf, basin, bars. Host-side only: no shader edit, no material
budget spent, geometry consumed by `apply_geometry` at rebuild time like the
policy params. Harness: `SPALL=<0..1>` (a CEILING — variance only takes
walls down, so `SPALL=0` really is off) and `SPALL_LAYER=1|2|3` to bisect
(1 = crater only, 2 = steel only and it MUST be indistinguishable from
`SPALL=0` — the bars are buried by construction; measured 0 px above 3 % at
max delta 4 against a floor of 3). Both faces of a wall spall (the owner
turns the camera with q/e) with the two sets vetoed disjoint, because each
basin may cut past the slab's half-thickness. ONE HONEST LIMIT: the depth
knob's veneer eats the core from both sides, so above depth ~0.72 on the
gym's 0.2-wu walls there is no core left to hold a mat and the dial stops at
LIFTED COVER.
2026-07-26, both halves reworked on the owner's first look ("jest za gruby",
"owalne dziury nie są realistyczne"). (1) The section went 0.075 -> 0.036 wu
(3.1 -> 1.5 px on an X face): a bar is a LINE of steel with one lit edge, not
a log — at 0.075 it filled the 0.15-0.30 lens it was supposed to sit in.
(2) The rim is no longer a perturbed ellipse but a POLYGON of 6-10 drawn
fracture corners joined by straight facets, each frayed inward at one
midpoint; the two invariants the mesh rests on survive by construction
(corners are drawn at ascending angles, so the rim stays star-shaped about
`c`; a chord of a convex region stays inside it, so `RIM_VAR` still bounds
the rim inside the patch rect). Pinned by
`rebar::the_rim_is_a_broken_plate_and_not_a_perturbed_oval`, which measures
the turning: some vertex must turn > 1.2 rad (a corner no smoothly sampled
curve can reach) and some must turn < 0.06 (a straight run no curve has).
The thin section then broke the DIAL's staging — see the 2026-07-26 learning;
the fix is that the three stages are now a fact about the dial
(`st >= ST_STEEL`), never a by-product of the depth arithmetic.

ROUND 8 (owner 2026-07-25: "cracks should be more like LIGHTNING —
branching, irregular — not straight lines; two kinds: the coarse one and
the age crazing"): BOTH scales are PROPAGATED now — a walker grows a
kinked path inside a corridor around its launch axis (which keeps it a
function in its own frame, so the whole clip machinery stays exact), and
one carver turns a face + a bolt list into pieces or plates. The
structural break is a jagged spine-anchored trunk (the smooth analytic
wander is gone) that FRAYS into short wide forks; a fork grooves the
VENEER and never carves pieces (a piece boundary is as long as whatever
it splits, so an invisible extension would draw a line across the wall —
see the round-8 learning). `lightning` is a real network: roots where
the wall is failing, forks down a width hierarchy, paths dying on the
damage zone's edge or on an older crack (T-junction), and width scaling
with how far the crack actually ran. Owner playtest + look lock still
pending.

## Pixel-perfect iso contract (binding; generalizes, never weakens)

- Primary rays go through pixel centres deterministically — no jitter, ever, on
  any ray. The ONE exception is CONTOUR COVERAGE (`AA`, owner ask 2026-07-25:
  "a delicate anti-aliasing, only on the contours of solids, so deep thin
  crevices stop reading as single black pixels"): a low-res texel whose primary
  hit — or a 4-neighbour's — lies within 0.42 px of a solid's silhouette /
  crease / crevice edge AND whose neighbourhood is NOT locally planar also
  fires 4 rays at FIXED sub-pixel offsets (constant for all time: no frame
  index, no hash, no history, no accumulation), and resolves to their weighted
  mean. The offsets are EVEN multiples of 1/64 px on top of the +1/64 tie bias,
  so every ray still lands off the BLAS seam planes. Everywhere else the
  low-res buffer stays exactly ONE sample per texel and hard-edged — flat
  interiors, clean pixel stairs, quad diagonals (the triangle's longest edge
  never gates), coplanar tilings (the grass grid, panel seams, closed crack
  seams — their position field is exactly affine under the ortho camera) and
  ALL painted detail (wear, stains, painted cracks, AO dither, MATQ) are
  bit-identical. It is also SCOPED (owner, same day: "apply it selectively —
  only on the chosen wall's geometry"): `aa scope` = every surface / CRACKED
  piers (the default, so the plain greybox keeps its hard edges) / the PICKED
  pier only, carried by `Material._pad` bit 7 on the pier AND its chalk core.
  A companion stage, `aa soften`, pulls a CONTOUR texel's radiance a fraction
  toward its 4-neighbour mean — same gate, same scope, no extra rays: that is
  the cheap answer to "narrow cracks read as harsh black broken pixels".
  `AA=0 AA_SOFT=0` reproduces the pre-amendment image exactly. (The
  pre-reset "`AA=1` opts into jitter" note is retired — that path lived only in
  the deleted TypeScript tracer.) **Owner sign-off on this wording still
  pending; `Look.aa = 0` reverts the feature and the amendment together.**
- All post (grade → grain → dither) runs per low-res texel before the integer
  NEAREST upscale.
- Projection-as-data (Faza 1a, DONE 2026-07-12): a projection IS its two
  integer ground-axis pixel images (`iso_core::Projection`); the camera
  basis, px/wu scale, px→world input mapping and the per-axis clean-size
  validator are DERIVED, so the invariants hold by construction for EVERY
  preset (pinned by `derived_camera_reprojects_the_axis_images_exactly`).
  Iso 2:1 is now the `iso21` preset (historical 0.0625-wu lattice,
  `stairs_per_wu() = (16, 16)`); `trimetric` — the game projection — is
  (10, 20): ARCHITECTURE is authored on the 0.1-wu grid. No grid is clean
  under both presets; the game projection wins, iso21 A/B shows mixed
  treads on tenths. The player body stays on the legacy 1/16 lattice
  (animated; Faza 2 rebuilds it). Trimetric scale is j=10 of the
  (4j,j)/(-2j,2j) angle family — S = 20√5 ≈ iso21's 32√2 within 1.2%, so
  preset switching compares angle, not zoom.
- **The wall contract (owner, 2026-07-12): world-vertical projects
  screen-vertical.** A rolled camera tips wall edges off the pixel column
  into ragged stairs; `Projection::derive` REJECTS such data
  (`a1·b1 + a2·b2 must be 0`), so every representable preset keeps wall
  verticals as clean pixel columns.
- Input maps onto the screen-pixel lattice (iso21: `b = -y/2`, the clean
  (2,1) stair — see the 2026-05-16 learning); Faza 2 generalizes input
  shaping per projection via `Projection::pixel_basis`.

## Greybox detail = AA-scoped (owner policy, 2026-07-25; binding)

The contour AA is OFF on plain greybox — flat slabs and their clean pixel
stairs ARE the look — and ON exactly where a generator has added procedural
detail geometry, because that detail lives at the pixel scale where a thin
dark feature turns into isolated black dots. The owner approved this shape and
generalized it: **"the selective-AA approach, only on the areas that MODIFY the
greyboxes — let's use it for all modifications of this kind."**

The deciding criterion is FEATURE SIZE, not novelty (measured with A/B clips
the same day, owner: "leave it configurable, it IS a visual decision"):

- THIN detail — crack grooves, veneer plates, spall craters, the rebar to come:
  features 1-3 px across, where the sampling lottery breaks a dark line into
  isolated black dots. AA ON by default.
- CHUNKY detail — whole blocks, e.g. the wall-smash rubble: 10-30 px across, so
  no continuity is at risk; AA only softens the blocky read the look is built
  on and adds a per-frame shimmer to tumbling silhouettes. Declared but OFF by
  default, owner-toggleable (`aa rubble` row / `AA_CHUNKY`).

So a generator DECLARES its detail and its class; it does not decide. Crack
geometry declares itself through the geometry pass's GEO/CRAZE marks; the rubble
returns its material ids. The host owns `Material._pad` bit 7
(`gym_scene::AA_BIT`, stamped by `crack::stamp_aa` + `Viewer::aa_stamp`) and
re-derives it from the ESC rows. A generator of THIN detail that forgets to
declare ships detail that dot-dashes; the crack lab pins the rule with
`rebuilt_geometry_opts_into_the_aa_scope`.

## Process (docs/VISION.md, binding)

- The owner playtests ONLY via the in-game menus (ESC) — never CLI params.
  Anything he must compare (looks, projections, control schemes) gets a menu
  row. Env knobs remain the agent/harness interface.
- Phase exit gate = owner playtest + a recorded clip. Green tests alone
  never close a phase.
- Delete legacy immediately when it creates work; tag archives in git.

## Verification

A change is not done until:
- `cargo test` passes and `cargo clippy --all-targets` is warning-free, and
- for render-side changes: a before/after `SHOT=` diff shows exactly the
  intended difference, and
- for anything visible in motion: a recorded clip (record-gameplay skill or
  the DEMO env path) actually shows the intended behaviour.
