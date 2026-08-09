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
| `ide` | the personal IDE (pracownia): headless UI model + CPU rasterizer for the 2x-density editor overlay; knows neither the game nor the GPU | font8x8 only |
| `phys-spike` | throwaway Box3D rigid-body world (leaf: no game, no GPU, no renderer) — the `wall smash` demo's rubble is its one consumer, through `rt-viewer/src/phys_scene.rs` | glam only |
| `wear-core` | THE WEAR MODEL (extracted 2026-07-28): `wall` (what a level AUTHOR says about a wall — `Story` → `Layer` amounts → the solved-threshold `Sheet`), `rebar` (the mat, its corrosion sites, their craters), `field` (the noise + damage field both shader twins mirror). No `Scene`, no `Material`, no bits, no GPU | glam only |
| `rt-viewer` | `viewer` binary: winit shell, Metal backend, gym loop, capture | everything |

**rt-probe and house-game never see each other** — only rt-viewer's adapter
knows both. The game must build and test without a GPU.
**`wear-core`'s "glam only" is the enforcement, not a note.** `wall.rs` has
declared its own purity in prose since it was written — *"No `Scene`, no
`Material`, no bits, no GPU"* — and for as long as it sat in `rt-viewer` (a
BINARY, no lib target) nothing checked it: a `use rt_probe::Scene` added on any
afternoon would have compiled, and ~3 k lines of arithmetic could only be built
by a crate that also needs `glslangValidator` and a window. What did NOT follow
the move: the eleven `wall` tests that measure a property over the two REAL
SHIPPED LEVELS — they build a level through `gym_scene::build_gym`, hence a
`Scene` — so they live in `rt-viewer/src/wall_tests.rs` and call in through
`wear_core::wall::…`. That is the split working, not a casualty of it: they are
integration tests by nature, and rewriting one onto a synthetic fixture to make
it move would delete the exact property worth having. `field::dmg_seed` is the
one name for `story * 7.0 + 3.0`, which used to be spelled independently in
`wall.rs`, `crack_geom` and BOTH shade twins; the shaders keep their literal
(they cannot call Rust) and `wear.rs`'s `HOST_MIRRORS` guard pins that last
mirror against `wear-core/src/field.rs`. `story_key` moved too (it was in
`wear.rs`, which owns the material STAMP): a value with one meaning gets one
home, next to the `RunRect` whose rect it hashes.

**`crack_geom` is a DIRECTORY since 2026-07-28**, cut along the seams the audit
found rather than the ones it guessed: `poly` (the polygon toolkit — areas,
clips, the ear clipper, the `Frag` and its exact rect subtraction; no wear
opinion in it), `cut` (the walk / bolt / carve propagator — round 8's thesis
that BOTH crack scales are the same walker, in one file), `craze` (a pier's
`CrazeCfg` and the three pattern policies), `breaks` (the run's structural
breaks — an authored count at authored places, and the trunks they grow) and
`emit` (the ONLY module that may name a `Scene` or a `Material`: the meshes,
the materials damage mints, and the two pier treatments). `mod.rs` keeps the
surface the rest of the crate already used — the pattern vocabulary, `Wear` in,
`Aged`/`GeoKey` out, `Frame`, `apply_geometry` and `keys` — so not one caller
moved. A pure MOVE: gym, crack lab and catalogue all BYTE-IDENTICAL, 198 tests
before and after, tests filed with the code they test and their fixtures shared
once in `crack_geom/fixtures.rs`.

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
- **`Specimen::breaks`** — WAS `Specimen::faults`, a veto flag against a
  probability, and is now an ordinary authored count (see BREAKS ARE A COUNT
  below). Break presence and the small-crack network used to be coupled through
  AGE (`0.95 · smoothstep(0.12, 0.42, age) · smoothstep(0.04, 0.45, cracks)`,
  and the damage field only opens a readable patch above age ≈ 0.5), so at every
  age where a veneer pattern was visible the odds of also breaking the wall in
  half were ≥ 0.9, and "cracked but not broken" needed a flag to be expressible
  at all. `breaks: 0` is that state now, and `breaks: 1` is the one slab whose
  subject IS the break.

Every specimen is the SAME 2 cells wide (`sim::SPEC_CELLS`) — identical is the
point of a bench. One of them could not be, until 2026-07-26: a break was drawn
once per 6-wu STRIP with its axis anywhere inside it, so a 2.2-wu slab contained
that axis about a third of the time and the break specimen came up EMPTY on the
first build (caught by `catalogue_tests`). Widening it to 4 cells was the honest
answer to a probability; an authored count removes the probability, so the row is
uniform again. Pinned: every specimen names a real pier, no two share one, each
is its own run, paint-only piers carry knobs but no `GEO/CRAZE` bit, and the
`breaks: 0` piers keep their veneer while the break specimen really breaks.

## The one scene: the gym

`viewer` boots the gym (`house_game::gym::sim::gym_level`): ONE hand-authored
18×14 level — a few freestanding walls, one building with a doorway, two
lamps, the player. No NPCs, no generators, no seed (owner directive
2026-07-12: everything the look/movement work needs, nothing else).
`LOOK=<name|index>` seeds the greybox look (`rt-viewer/src/look.rs`; Faza 1b
DONE: a Look is the WHOLE aesthetic as one datum — palette, sun/sky
(`SunSky`), post stack (`StyleCfg`), exposure, surface response).
THE look (owner pick + same-day "delete rest", 2026-07-12): **`polana` is
THE look** — porcelain × meadow: clean ceramic volumes; occasional
FULL-HEIGHT black tinted-glass windows on building walls only (even
world-coordinate cells; REAL wall openings + transmissive panes — the
shade pass carries primary rays through with the pane's tint, shadow
rays/probe bake keep glass opaque, and in the WALLCUT cutaway glass stubs
deliberately stand 0.3125 proud of wall stubs to cover the bay jambs);
lush saturated greens + grass-tuft dress; amber lamp mood. The other
2026-07-12 candidates are deleted (git history), and with one preset left
the ESC look row was pulled (one preset = dead UI) behind a menu.rs test
pin that demanded it back the moment a second look landed. IT LANDED and
THE PIN FIRED: `look::LOOKS` is `&[&POLANA, &DUSK]` — the
voxel-physics-spike's `dusk` sibling, the same porcelain greybox re-lit for
golden hour so the dynamic-GI roof-tear has a dark interior to flood — so
the ESC menu HAS a live look row again (`menu.rs`'s `MENU[0]`, `max` pinned
to `LOOKS.len() - 1`). Treat that as the worked example of the menu-first
rule: the mechanism restored the owner's choice without anyone remembering
to. Lock + goldens await the owner playtest.
Same-day BLOCKY mesh rebuild (owner: prostsze kształty, blokowość jak
tecta): every gym mesh is the fewest boxes that read — walls are clean
slabs (no plinth), the roof is ONE inset parapet cap (no fascia — the
amber accent moved to the lamps — no ridge; `RoofStyle` deleted), lamps
are post + lantern block, grass tufts single blocks, the player a 10-box
figure. Greens are MATTE by construction (`flags::MATTE`, set by
`gym_scene::mark_matte` on the grass floor + tufts): the shade pass skips
spec + the gloss remap there — "trawa nie może się błyszczeć"; porcelain
and glass keep the sheen.
GLAZE EASE — DELETED 2026-07-26 (owner call). The eased-arris pass gave every
exposed arris a screen-pixel chamfer through a box→mesh promoter
(`wear_geom`), and it shipped OFF: a thin vertical facet's GI lookup lands in
the meadow bounce and reads olive-green on white porcelain, and an aged pier
loses its bevel because the crack pass re-emits the face. Carrying a disabled
feature costs more than removing it, so `wear_geom`, `RunEnd`/`end_kind`, the
junction yield, `Look.arris`, `ARRIS` and the ESC row are all gone. What
survives is the INVARIANT the promoter threatened, now a standing test:
`gym_scene::the_greybox_is_boxes_and_every_pier_mesh_is_its_authored_box` —
the crack lab, the pick ray, the smash rig and the local probe refresh all
address `Pier.lo/hi`, so the next box→mesh pass gets that assertion aimed at
it on day one.
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

MOVEMENT IS ONE MOVER (Faza 2, first slice 2026-08-02, finished 2026-08-09).
The cell-stepping mover is GONE. `Command::MoveWorld` is the only movement
command: acceleration ramp (`ACCEL_WU_PER_S2` 18), braking
(`BRAKE_WU_PER_S2` 24), collide-and-slide against the grid at
`PLAYER_RADIUS`, and a gait whose phase comes from the distance the body
ACTUALLY covered (`WALK_STRIDE_WU` 1.6) so feet cannot skate or run in place
against a wall.
2026-08-02 did the keyboard half: screen input converts through the ACTIVE
projection's pixel basis (`Projection::screen_px_to_world`), so W is screen-up
as a straight line under any preset at any yaw — the old hard-coded 2:1 map
zigzagged under trimetric.
2026-08-09 did the mouse half, which had stayed on the OTHER mover: a click
ran a cell BFS and fed `Command::Move`, which TELEPORTED the body to a cell
centre on a per-mode tick cadence and zeroed its velocity. So the same player
accelerated and slid under WASD and snapped under the mouse, and every
property the continuous mover is pinned on silently did not apply to
click-to-move. `house_game::gym::route::Route` replaces it: the BFS still
finds the way (the grid is what knows about walls), then the cell-centre
polyline is STRING-PULLED — a waypoint whose neighbours can see each other in
a straight line is not a corner — and the survivors are walked as straight
legs at any angle. Sight lines test the SAME predicate the integrator uses
(`blocked_point` at `PLAYER_RADIUS`), so a shortcut the route takes is one the
body can walk; testing cell openness instead yields paths that steer into a
jamb and stall with both halves behaving correctly. Steering stops one
STOPPING DISTANCE (`v²/2a`) short of the goal so the body coasts onto it
instead of arriving at speed and oscillating. Measured on the gym: spawn to
(5.5, 5.5) inside the building is TWO legs, where the cell path was a ten-cell
staircase.
THE PLANNER LIVES IN `house-game`, not the viewer — it is game logic, and in
`rt-viewer` it could not be tested without a window. The viewer now only hands
a click's world point in and pushes the steered direction onto the queue.
DELETED with the second mover: `Command::Move`, `STEP_WALK`/`STEP_RUN` and the
cadence, `next_move_at` (and its `state_hash` term), `GymLoop::bfs`, the `Ease`
interpolator, `EASE_TICKS` and the `continuous_active` flag. Presentation
follows the sim position for every input device; facing follows VELOCITY, so a
body sliding along a wall faces where it travels. The trace grammar lost
`move <dx> <dz>` — a trace holding one now FAILS to parse with an error naming
`move_world`, rather than replaying as something else.
HARNESS: `WALK_TO=x,z` replays ONE click at boot (a trace can express held keys
because those ARE commands; a click only produces commands once a route exists
— the `WEAR_EDIT`/`IDE_EDIT` precedent), and `demo_advance_tick` steers a live
route so a `WALK_TO=` + `DEMO=` capture records the mouse path frame by frame.
Without it the mouse half had no headless form at all, which is a large part of
why it kept its own implementation for as long as it did.
STILL OPEN in Faza 2 (`docs/VISION.md`): turn-rate limit, foot-planting
IK-lite, lean into acceleration, settling on footfall, pad support (gilrs),
both WASD variants as a menu row, and a scene built for feel-testing.

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

## Material._pad flags: one home (2026-07-26)

`rt-viewer/src/flags.rs` owns all eight, NAMED BY VALUE, with the allocation
table in one place; the old names (`crack::SEL_BIT`, `crack_geom::GEO_BIT` /
`CRAZE_BIT`, `gym_scene::AA_BIT`) are re-exports and the bare literals are gone.
It exists because the prose had drifted into two incompatible readings of the
word "bit" — `gym_scene`/`crack_geom`/both shaders say "bit 4" meaning VALUE 4
(matte), `crack`/`wear` say "bit 4 (value 16)" meaning INDEX 4 — so "the last
free flag is bit 4" pointed at two different bits depending on the file.
`the_flag_byte_is_a_partition` walks the exhaustive list; a second claimant on
any bit fails the tree. `both_twins_spell_every_flag_value_as_the_host_does`
reads BOTH shader sources at compile time, because a flag whose value moves on
the host and not in a shader is a silent, backend-specific wrong image.

The twin guard in `wear.rs` is TWO-SIDED: a REQUIRED table (fragments each twin
must contain) and a FORBIDDEN table (fragments each must NOT). A required-only
guard can prove a line is present and never that a line is gone, so it is blind
to a deletion applied to one twin and forgotten in the other — which compiles,
passes every test, and ships a different image on the other backend. Since
2026-07-28 the fragment tables are the HOST↔SHADER half of that job only (see
THE TWIN DIFF below); `wear::HOST_MIRRORS` is the standing list, each entry
naming a constant that must be spelled the same in both twins AND in the Rust
that mirrors it (`story * 7.0 + 3.0`, the damage field's `0.45/0.7/0.16` shape,
`fbm`'s two octaves, the mud seed and frequency).

## Two render backends — keep them in lockstep

`crates/rt-probe/src/shaders/*.comp` (GLSL/Vulkan) and
`crates/rt-viewer/src/shaders_metal/*.metal` (MSL) are line-for-line twins.
A feature added to one must be ported to the other in the same effort, or
documented as debt. ONE push-constant struct is genuinely shared: `TonePush`
(tonemap), which lives in `crates/rt-viewer/src/backend.rs` and feeds either
backend's tonemap kernel byte for byte. THE SHADE PUSH IS A KNOWN DIVERGENCE —
`rt_probe::render::ShadePush` (flat named fields) and `metal_backend::Push`
(packed `misc`/`misc2`/`misc3` vectors, in a DIFFERENT order and carrying
different contents) are two independent declarations, each self-consistent with
its own shader, so no image is wrong today; but NOTHING compares the two Rust
structs — a field added to one is not a field added to the other, and the twin
diff below only sees the shader side of that contract. The same is true of the
two `ProbePush` declarations. Since the contour AA (2026-07-25) the
radiance image carries `rgb = sum(w*L), a = sum(w)`: **every reader must divide
by `.a` when `.a > 1`** (two per twin today — the tonemap's radiance load and
its bloom tap; a negative `.a` marks a non-contour texel the gate pass skipped).

THE TWIN DIFF since 2026-07-28 (`wear::twin::twins_are_structurally_identical`)
is what makes "line-for-line twins" a FACT instead of a promise. It reads all
six sources at compile time, splits each into top-level items (functions,
structs, file-scope constants), normalizes both dialects onto one token stream
and asserts the two are EQUAL, item for item — so a change to either twin that
the other did not get fails `cargo test` with the diverging tokens printed.
It replaced a fragment whitelist that never compared the twins to each other
and covered 2 of the 6 files: four image-changing edits to `shade.metal` alone
(stain tint, glaze-web line width, mud strength, the damage field's `rise`)
each passed all 183 tests before it, and each fails now. The normalization is
documented rule by rule in `wear.rs`'s `mod twin` doc — types, numbers by
value, swizzles, single-argument casts, MSL's threaded resource parameters,
buffer-vs-image storage access, the two hosts' different push-constant packing,
and the ray-cast setup (the one elided region: `rayQueryEXT` against
`intersector<>` has no common spelling, so the SETUP goes and the hit
ACCESSORS are mapped, which keeps everything the trace DOES with a hit under
the diff). What is left is `twin::ALLOW`: NAMED formatting divergences, each
stating why it is not drift and each required to fire an exact number of times,
so the list cannot rot into a whitelist. **Adding to `ALLOW` is the last
resort** — the first answer to a diff failure is to port the change.

The Mac dev machine (M2 Pro) runs the **Metal** backend; the Arch "spawner"
box (RTX 5080) runs Vulkan. **Spawner duty DISCHARGED (2026-07-17,
first hardware session):** the whole blind-edit backlog (Faza 0–1b hosts,
`Material.pad` bitfield shaders, Stage-2/3 GI, `fp.env`) ran on the RTX
5080. One real break found: Faza-1b's blind edit dropped `use glam::Vec3`
from `vulkan_backend.rs` (never compiled on macOS — cfg-gated). Facts
worth keeping: ShadePush 256 B IS accepted by the device; the full 2048-ray
bake takes ~115 ms (vs seconds on the M2); `LOOK_SWITCH=polana` is
BYTE-IDENTICAL to a direct boot; and the Vulkan/RTX cross-run noise floor
was measured ZERO over the runs taken that session (Metal's is NOT ~1 LSB end
to end — see the 2026-07-26 learning: the M2 bake is BIMODAL, two stable
outcomes 72/255 apart at a hard shadow edge, so a byte-diff claim on either
backend needs >= 4 runs of each side, all-pairs diffed, before it means
anything). **BLIND VULKAN (2026-07-25):** the contour-AA work — `shade.comp`'s edge
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
(`SceneGpu::carry_probes` + `refresh_boxes_for`'s callers) — **MEASURED
2026-07-27 (RTX)**: `WEAR_EDIT="0.6,0.4,0.5,3"` refreshes 1512 probes (16%)
in **96 ms** vs a full re-bake of 147 ms (bake alone; the whole
`apply_look` full path is ~520 ms with the AS rebuild) — so `Local` WINS on
the RTX too and the accept/decline thresholds stay. (2b) The `roll` arm of that same
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
STORY="0.9,0.5,0.4" WINDOW=1280x800 ZOOM=1.6 TARGET_X=7.3 TARGET_Z=3.8` —
the three panels of the east facade must share ONE damage pattern that continues
across the window jambs; per-panel islands mean the story key never arrived.

**BLIND METAL (2026-07-28, the spike-retirement audit):** `hasProbes` is
DELETED — an M1 bring-up gate that lived ONLY in shade.metal and whose host
(`metal_backend.rs`) had written the literal `1` ever since the probe bake
landed, i.e. the last logic divergence between the two shade twins. Its slot
went with it, so Metal's `misc2` REPACKED: `[lightCount, roomLights16,
reflBlockPx, _]` (was `[lightCount, hasProbes, roomLights16, reflBlockPx]`) and
shade.metal's three readers shifted `.z→.y` (the probe-bank lerp) and `.w→.z`
(the reflection block size). Vulkan's `ShadePush.misc2` is a DIFFERENT layout
and did not move. Same day, same file: the `dir.w == 2.0` spotlight cone branch
is gone from both twins with `rt_probe::Spotlight` (no writer since the
pre-reset flashlight; `scan_lights` only ever writes 0.0 or 1.0 there). Both
edits are inert on Vulkan — gym, crack lab and catalogue are BYTE-IDENTICAL
here — but the MSL side is UNRUN. First Mac session: boot `LEVEL="crack lab"`
and compare against the Vulkan reference. The failure signature of a bad repack
is loud and specific: probe GI at the wrong dim (a flat-lit or black-ambient
image) if `.y` is wrong, `REFL` blocks at the wrong size if `.z` is. Both twins
now carry `hasProbes` and `dir.w == 2.0` in `wear.rs`'s FORBIDDEN table, so
neither can come back to one source alone.

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
are REAL geometry now (`crack_geom/` — host-side, shared by both
backends), and the two layers COMPOSE: every knobbed pier gets a
matte-chalk core + a veneer of plates laid out by a selectable pattern
POLICY — lightning/craquelure/mosaic since 2026-07-23 round 7
— panel "pattern" row, and BELOW it each policy's NATIVE param sliders
(`crack_geom::POLICY_PARAMS`: lightning branch/straight/spread,
craquelure wave, mosaic jitter; stored per pier per policy — NATIVE steering
only, see PLATE SIZE IS ONE NUMBER below);
`SHAPE=grain,relief[,pattern[,p1,p2,p3]]` — split by 1-px-or-wider drooped
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
boot `LEVEL="crack lab" STORY="1.0,0.6,0.5"` and confirm the crater
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
`WEAR_EDIT=weather,settlement,cover_loss[,run]` replays a panel drag + release
after boot; `PROBE_LOCAL=0` forces the old full rebake for the A/B.
ONE WALL, ONE STORY since 2026-07-25 (task-3 step 4): aging is seeded per
WALL RUN, not per panel. `wear::story_key` hashes the pier's authored run
(`Pier::run_lo/run_hi`) into `Material.base_color[3]`, `crack::resolve`
stamps it before the geometry pass, and BOTH the host damage field
(`crack_geom::CrazeCfg`) and the shade pass (`float story =
m.baseColor.a`) seed off that one f32 — so a damage patch crosses a
window opening instead of restarting at the jamb (pinned as an equality
by `crack_geom::piers_of_one_run_share_a_damage_field_and_their_breaks`),
and chalk cores inherit it for free. The BREAKS joined the run on
2026-07-26 — the per-panel `seg` seed and the risk it hedged ("a shared
fault seed would crack a facade at one repeated position") both belonged
to the 6-wu lattice that is now gone. Depth and chip stay per panel;
`crack::run_ramp` puts only age/cracks on a per-run gradient, so a facade
has a bad end and a clean end. The two `_pad`/alpha budgets are documented in one place:
`crates/rt-viewer/src/wear.rs`. The GLSL twin's one-line `story` read is
blind (same inverted side as step 3, same crack-lab boot check).
SOLVED THRESHOLDS since 2026-07-25 (task-3 step 5), the effect word's
first real consumer, and the round's central change. The gates USED to be
one age-derived value `d_t` sliding five FIXED windows (stains at
`d_t − 0.14`, cracks at `−0.10`, the veneer zone at `+0.02`, the web at
`+0.08`), so how much of a face was damaged was whatever that run's fbm
draw happened to give it: the gym's seven runs spread their damaged area
from 0.000 to 0.645 at age 0.9, and the run behind the doorway was
UN-AGEABLE at any age. Now each layer has its own ABSOLUTE threshold
SOLVED from the run's own sorted samples (`wall::RunField::threshold`,
`crack::gates_of`), so an AMOUNT IS AN AREA and the layers are
independent — "stains spread wider than the cracking" is a sentence the
model can express. `wear`'s lanes 0 and 1 carry the two PAINTED layers'
thresholds to the shade pass as 6-bit codes counting DOWN from
`wall::GATE_HI` in `GATE_STEP = 0.020`, and
`wear::both_shader_twins_spell_every_wear_decode_as_the_host_packs_it`
reads both `.comp` and `.metal` at compile time so neither can drift. ONE
function, TWO callers: the geometry pass uses exactly the quantized value
the shader will decode, because splitting them leaves paint and plates in
different patches. This DELETED the whole FIELD LEVEL machinery
(`run_level`, `level_quantize`, `WEAR_LEVEL`) — it existed to nudge each run's
field toward a canonical level, i.e. to correct a lottery's symptom —
plus four of `age`'s silent extra jobs (plate dropout, the settlement
factor, the chip gate's dependence on the stain window, the root density's
age term). Verified 4 runs per side: `gym` BYTE-IDENTICAL, `crack lab`
1.9 % at max 183. Same inverted blind side: the GLSL twin's gate reads
compile (build.rs runs glslangValidator) but have never RUN. The failure
signature is NOT a blank wall — the HOST applies its own copy — but PAINT
THAT DISAGREES WITH THE PLATES (stains and the fine web sitting off the
grooved region). A first Vulkan session should boot `LEVEL="crack lab"
STORY="0.9,0.5,0.4" WINDOW=1280x800 ZOOM=2.0 TARGET_X=6.8
TARGET_Z=8.0` and compare against the Metal reference; the RTX cross-run
noise floor is zero, so any byte difference is real signal either way.

BREAKS ARE A COUNT AND A PLACE since 2026-07-26 (task-3 step 6). A
structural break used to be a coin flip on a 6-wu STRIP lattice —
`0.95 · smoothstep(0.12, 0.42, age) · smoothstep(0.04, 0.45, cracks)` per
strip, with a second lattice fading in above cracks ≈ 0.8 — and it was
wrong three ways at once, none of which a level author could work around:
you could not ask for ONE (a 2.2-wu slab held a strip's axis a third of
the time, so the catalogue's break specimen shipped 4 cells wide until the
hash cooperated); you could not ask for NONE (presence and the crack
network share `age`, so at every visible age the odds were ≥ 0.9, and
"cracked but not broken" needed a veto flag); and the roll was seeded PER
PANEL while the strips are anchored in RUN space, so a break landing on a
window jamb existed on one panel and not its neighbour. `wall::Breaks`
{count ≤ 3, at} + `crack_geom::run_breaks` replace all of it: breaks are
placed on the RUN, evenly spread and jittered at most ±0.17 of one spacing
(so order and a 0.66/count minimum gap hold by construction), kept
`BREAK_MARGIN = 0.35` wu off the ends, and each panel keeps the ones that
cross it. `Specimen::faults`/`CrackLab::no_fault`/`sim::SPEC_WIDE` are
gone; `GeoKey` signs the count and the place. Host-side only — since the
painted-layer cull no shader reads a fault. The shim
(`crack::story_of_knobs`) still derives settlement from age × cracks,
calibrated ×0.8 to reproduce the ~1.9 breaks per 6-wu run the old lattice
averaged, and it derives it PER RUN from the run's mean knobs: the naive
per-panel reading gave one facade counts of 2, 2 and 1 and three panels
cut three different break sets (pinned by
`crack::one_run_gets_one_break_count_even_though_the_knobs_ramp`).
Verified 4 runs per side: `gym` BYTE-IDENTICAL, `crack lab` 1.8 % at max
189 — the difference being facades that lost their coin flip and now break
because their story says so.

COVER SPALL WITH REBAR since 2026-07-25 (task-3 step 2, owner headline
"large concrete spalls with the REBAR showing underneath"): the panel's
`spall` dial, under the four knobs, is the COVER-LOSS cause; the crater cuts
past a world-anchored reinforcement mat, so bars stand proud of the basin and
cast into it. `rebar.rs` is the mat, the corrosion potential (the
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
basin may cut past the slab's half-thickness.
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
The thin section then broke the DIAL's staging — see the 2026-07-26 learning
— and the staging itself is gone since the same day (below).

SPALL IS AN AREA since 2026-07-26 (task-3 step 7). The dial USED to be
staged — a 0.12 deadband, then LIFTED COVER (a lens with no steel in it),
then BLOWN SPALL — with extent, depth and count all riding the one number.
Three faults in one: the stages were three different LAYERS on one slider
(cover lifted but no steel is a CHIP, and `Layer::Chips` builds exactly
that); the amount was not an area, so dial 0.5 lost 7 % of a 2.2-wu slab and
2.5 % of a 6.2-wu facade; and the depth ramp's knee was a fraction of the
DIAL, so a wall whose cover was too deep for the mat quietly stopped at
stage two. Now `Layer::Spall`'s amount is the fraction of the face whose
cover is gone, spent in whole craters of ONE canonical size (`rebar`'s
0.32 × 0.13 wu lens = one bay of the mat, ±25 % of its AREA), and the count
falls out of the area. A spall shows steel BY DEFINITION; the basin cuts
`BAR_CLEAR` sections behind the mat, never a ramp. Deciding the count up
front is what makes the amount monotone BY CONSTRUCTION — the candidate
order does not depend on the budget, so more area takes a superset of the
same sites. `rebar::stage`, `ST_STEEL`, `FLOOR0`, `DIAL_ON` and
`Face::gate` are deleted.
THE HONEST LIMIT MOVED FROM A SILENT ONE TO A REPORTED ONE. `rebar::t_cap`
is the deepest veneer that still leaves the core somewhere to hold a mat
(0.082 of a 0.2-wu wall against a knob top of 0.090), `CrazeCfg::new`
applies it to walls that spall, and `wall::Miss::Clamped` says so per wall —
where the old code just stopped emitting steel and the module doc called it
an honest limit. `Miss` split in two at the same time: NoWall/Duplicate are
TYPOS and still fail `compile`, while Coarse/Clamped are honoured WITH A
DIFFERENCE and ride `Sheet::notes` for the panel to print in that wall's row.
`wall::SPALL_MAX = 0.025` is the cause→amount ceiling and it is MEASURED,
not taste: a wall's two faces share one packing (two facing craters would
perforate the slab), so the binding case is a small pier's BACK face —
0.025 costs the worst gym face 8 % of its ask, 0.03 costs it 23 %, 0.06
costs it 48 %. At that ceiling a 6.2-wu facade loses 3 patches and the
bench's 2.2-wu slab 1, which is what the staged dial's top produced too. The
LEVER if a wall ever needs to lose more: interleave the two faces' craters
from ONE candidate list instead of running the back through the front's
leftovers, which would roughly double it. Verified 4 runs per side: `gym`
BYTE-IDENTICAL, `crack lab` 0.52 % at max 186 (after-side cross-run floor
128 px / max 75). Visible change the owner should rule on: at the TOP of the
dial small piers now lose less than they used to, because the old count was
3 per face whatever the wall's size.

PLATE SIZE IS ONE NUMBER since 2026-07-26 (task-3 step 8). Every pattern has
a plate size and it used to be spelled three ways on three curves: a
cells-per-wu FREQUENCY from the `cracks` knob, times craquelure's `scale`,
or times mosaic's `scale`. So one slider position meant 0.79-wu plates under
craquelure and 0.40 under mosaic — a 2.2-wu bench slab three plates tall,
which is why that catalogue row shipped with a pattern nobody could see.
`wall::Shape::grain` is that property once, in WORLD UNITS
(`CrazeCfg::grain`): mosaic's cell IS it (times the measured `MOSAIC_FILL`
0.66, since a jittered Worley cell's mean SIDE is short of its lattice
spacing), craquelure stops splitting at 0.72 of it so its leaves average it,
and lightning pitches its root lattice on it. Measured by
`every_pattern_reads_at_its_own_defaults` over three grains: all three land
0.82-1.08 x the authored size and within 1.3x of each other. A LENGTH is
also the only unit the pixel floor can be stated in, which is what makes
`wall::GRAIN_OFF = 0.09` (3.7 px on an X face) a real OFF-STOP — below it
`policy_frags` returns ONE FLUSH PLATE for every pattern, so "no veneer" is
a reachable state and not just "a lattice too fine to render". `scale` is
deleted from both policies that had it; lightning KEEPS its three
(branch/straight/spread — `straight` is how jagged a crack is, which is the
property the owner asked this policy for), so `PARAMS_MAX` stays 3 and
`wall::Geom::par` carries three. The shim `crack::grain_of` is the reciprocal
of the old frequency, so the LIGHTNING policy is byte-identical across the
change and the A/B shows only the two patterns that really moved. Verified 4
runs per side: `gym` and `crack lab` BYTE-IDENTICAL (the lab boots
lightning); the catalogue's pattern row is where it shows.

THE RUN IS THE AUTHORING UNIT since 2026-07-26 (task-3 steps 9-11, the round's
last change and the one the other eight were for). `crack::CrackSeed`,
`Specimen`, `seed_knobs`, `seed_spall`, `clear_pristine`, `apply_specimens`,
`run_ramp`/`run_pos` and the four-knob panel are DELETED. A level is now a
`wall::LevelWear` — a base `Story`, a per-RUN `spread`, and the
walls that say something different as `WallAt` entries named by world point —
and `wall::specs_of` + `compile_specs` turn it into one `Sheet` per run.

WHY: the state was per PIER, and a pier is a rendering artifact. `wall_slab`
cuts an authored slab wherever a window or a doorway interrupts it, so the gym's
east facade was THREE independently editable copies of one wall: the owner
dragged a slider and one third of a building changed. Three rounds running had
to chase the same symptom under different names — the fault seed, the break
count, the field level were each a per-panel value standing in for a per-run
cause — and `crack::CrackLab::geom_input` ended with a hand-rolled "average the
run's masked knobs" just to recover the number the author had typed. Now the
model has no place to put a per-panel opinion: `spec` is per run, `sheets` is
per run, and the piers index into them. `one_run_one_sheet` pins the equality
over both shipped levels with a vacuity guard.

- `crack_geom::apply_geometry`/`keys` take ONE datum — `crack_geom::Wear`
  (sheets + pier→run + the paint-only mask) — so the geometry pass and the
  material streamer cannot be handed different sheets. `CrazeCfg::new` reads the
  sheet and nothing else; `GeoKey` is now just `wall::Geom` + the story key,
  where the all-integer discipline belongs (`Geom` is what a level COMPILES to).
- The VENEER's zone reads `Layer::Cracks`, not `Layer::Web`. It read the Web
  gate through step 5, and Web is a PAINTED layer — so a wall authored as
  "cracked" built no plates at all unless it happened to be asked for crazing
  too, which is exactly how the catalogue's pattern row went out empty on the
  first build of step 9. One layer, one threshold; the two BANDS still differ
  (`zone` ±0.03, `crack_zone` ±0.04) so a path reaches past the plates it freed.
- `Material._pad`'s knob lanes carry the two PAINTED LAYERS' STRENGTHS (stain
  at bit 8, web at 14; lanes 2/3 unclaimed and now FORBIDDEN in both twins).
  Four knobs lived there and the shade pass read exactly ONE of them (`age`) for
  both layers, so three lanes paid rent for nothing while the two layers it does
  draw shared a strength: their AREAS were independent since step 5 and their
  intensities were not. Both twins edited in the same commit; the `wear.rs`
  source guard now requires each layer to read its own lane.
- `wear_edit` re-streams BOTH halves of the paint on every edit — the `_pad`
  strengths and the effect word's thresholds — because a story move changes them
  together. Streaming one and not the other draws stains at the new intensity
  inside the old patch.
- THE PANEL is 17-19 rows and DATA: `menu::rows_of(spec)` returns a `Vec<Row>`
  that the draw, the hit-test and the drag all walk (`Row::Cause` /
  `Layer` / `Breaks` / `Scrub` / `Grain` / `Relief` / `Pattern` / `Param`).
  Three CAUSES, then the five LAYER amounts they derive — indented, with a `*`
  when pinned, and a drag on one PINS it, which is the whole authoring gesture
  behind "old, but no chips at all" — then breaks, variant, grain, relief,
  pattern and the pattern's own params. (THE PANEL ITSELF IS DELETED since
  2026-07-27 round H — the IDE inspector draws these same rows now; see THE
  PERSONAL IDE below. `rows_of` and the row model survive as the shared
  spelling of "what a wall exposes".)
- THREE NEW ESC ROWS, all level-wide and all non-destructive (they are applied
  on the way from the authored spec to a sheet, in `CrackLab::level_dials`, so
  every one is reversible and they compose with each other and with a panel
  edit): `wear` (a master on the level's story — 1 = as authored, 0 = the plain
  greybox, so "show me this level clean" is one row and not fifteen), `solo
  layer` (pin the other four to zero on every wall — the catalogue's question,
  asked on the level the owner is standing in), `surface grain` (plate size in
  world units on every wall; below `GRAIN_OFF` there is no veneer anywhere).
  Pinned by `the_level_rows_compose_and_never_destroy_the_authoring`.
- THE CATALOGUE is one BLOCK per slab in `crates/rt-viewer/wear/catalogue.wear`
  (a `wall <x> <z> <name>` line, then the one layer's `pin <layer> <amount>`
  and an explicit `pin <layer> 0` for each of the five it is NOT about, plus
  `breaks 0`), so "one effect per wall" is a fact about the data and is pinned
  by `crack::catalogue_tests`. The `WallAt::only` / `only_breaks` constructors
  that spelled this before the wear files are DELETED (2026-07-28) — the file
  is the authoring surface. Two specimens changed subject: the painted crack
  network and painted chips are gone from the shader, so those two slabs now
  show a wide stain patch and the glaze web alone.
- THE HARNESS: `STORY=weather,settlement,cover_loss`,
  `SHAPE=grain,relief[,pattern[,p1,p2,p3]]`, `SPREAD=`, `SPALL=` (kept — the
  owner headline, and every A/B recipe on record uses it), `CRACK_SEL=`,
  `WEAR_EDIT=weather,settlement,cover_loss[,run]`. `CRACKS=`, `CRACK_VARY=` and
  `CRACK_EDIT=` are gone: their four components no longer exist as a set.

WEAR IS FILE DATA since 2026-07-27 (effect-system round A, the enabling layer
for the owner's modular-effects concept — plan in the session log, decisions:
foundation+mud first, scrub not translate, Origin dies for the band).
`crates/rt-viewer/wear/{crack_lab,catalogue}.wear` replace the demos.rs
statics: hand-parsed one-statement-per-line text (grammar in `wear_file.rs`),
canonical form pinned by `checked_in_wear_files_are_canonical`, parsed once
per process and leaked, `Demo.wear` now names a `WearFile`. INTERACTIVE panel
edits persist on release (`Viewer::wear_save`): a run the level names — or the
owner touches — serializes back with its live spec (hand-edited unnamed runs
get a synthesized point at the run centre); derived runs stay out of the file
so `spread` keeps breathing; the age-ramp beat and `WEAR_EDIT=` replays never
set the dirty flag, and any wear env override (`STORY=`/`SHAPE=`/`SPALL=`/
`SPREAD=`/`WEAR_EDIT=`) blocks the save so a SHOT recipe cannot freeze itself
into the authoring. `WEAR_FILE=<path>` overrides load AND save (a missing
path boots the baked default and saves to the new file). Verified: gym,
crack lab, catalogue all BYTE-IDENTICAL to the statics era (Vulkan/RTX,
floor zero).
THAT ALLOWLIST IS DERIVED since 2026-07-28: `wear_file::env` is ONE table of
every env knob the wear path reads, each with a "writes the authored spec"
column — the parsers take their names from it (`std::env::var(env::STORY)`),
`env_overridden` walks the `true` half, and the source guard
`every_wear_env_read_names_a_knob_from_the_table` fails the tree on a bare
`env::var("…")` anywhere in crack.rs / ide_host.rs / wear_file.rs, so a tenth
knob cannot join a parser without joining the allowlist. It was a hand-kept
9-name list guarding the writer that overwrites the OWNER'S files, and this
project has been bitten from both ends already (`SHELL` colliding with the
login shell; the AgeWall beat freezing ramp state into his file) — the
name-hygiene and both-directions checks are tests now. Render-side bisects
(`SPALL_LAYER`) stay out on purpose: they change the image built FROM a spec,
never the spec.

SCRUB REPLACES TRANSLATE and ORIGIN IS DELETED since 2026-07-27 (round B).
The panel's "variant" row (`WallSpec.scrub`, file line `scrub v`, env
`SCRUB=`) slides the run's story key through noise space
(`wall::scrub_key`, 6-bit quantized, `SCRUB_SPAN = 2.0`), so ONE dial
re-rolls paint, plates and breaks coherently — the honest form of
"przesuwam" under a 24-free-bit material budget (a spatial offset applied
host-only would re-create the step-5 paint-vs-plates drift). A scrub drag
morphs the painted field LIVE (`backend.set_material_story`, the third
live-material sibling; the MSL impl is a BLIND one-line twin — next Mac
session: drag the variant row once); release rebuilds via the normal
GeoKey/story path, and a sub-bucket drag rebuilds nothing by construction.
`Origin` (ground/even/coping/both) is GONE: it biased the SOLVED THRESHOLD
but never reached the field on host or shader (hardcoded 0.16*rise both
sides), i.e. it changed HOW MUCH, never WHERE — the round-C band mask is
the honest version. With it gone `wall::RunField::at` DELEGATES to
`field::dmg_field` (moved to `wear-core` 2026-07-28, with `wall`/`rebar`):
the threshold solver, the geometry generator and
both shader twins now read literally one definition. Zero shader edits this
round; gym, crack lab AND catalogue BYTE-IDENTICAL at defaults, `SCRUB=0.6`
A/B confirms the dial moves the image.

THE BAND MASK since 2026-07-27 (round C) — "rysowanie obszaru" v1, and the
EFFECT WORD IS NOW FULL. `WallSpec.band` = normalized (lower, upper) edges
of the wall's height (panel rows "band low"/"band high", file line
`band lo hi`, env `BAND=lo,hi`); the mask enters the DAMAGE FIELD ITSELF
(`wall::banded` — SUBTRACTION, not multiplication: in-band values pass
bit-exactly, so the default is byte-stable, and out-of-band drops 2.0 below
`GATE_FULL` so even "all of it" excludes it — a multiplicative mask leaks at
the top of every dial). ONE region steers everything: `RunField` samples the
banded field (solved areas live inside the band; an ask the band cannot hold
reports `Miss::Coarse`), `CrazeCfg::dmg` bands identically (plates, chips,
sinks, roots, walk-stop follow via zone/crack_zone), crater sites get a
band VETO composed into `fits` (a veto must not spend budget), and the twins
subtract the same mask from `dmgN`. Breaks are deliberately NOT band-gated
(a break spans the height; a horizontal band would be a hidden off-switch).
Codes ride effect-word lanes 2/3 (`wall::band_codes`: 0 = edge off, upper
edge counts DOWN so the default packs to the empty word); `Geom.band` signs
the rebuild; `wear.rs` REQUIRED table pins all four lane decodes + the mask's
three constants (`/ 2.1875` = `wall::BAND_TOP` — pinned equal to
`gym_scene::WALL_TOP` — feather 0.06, the `2.0 * (1.0 - band)` drop) in BOTH
twins. `WEAR=` is deleted: all four lanes are derived, each driven by its own
dial. The GLSL twin is the VERIFIED side (this round ran on the RTX box);
the MSL twin is a blind line-for-line port — first Mac session: boot
`LEVEL="crack lab" BAND=0,0.45 WINDOW=1280x800` and compare against the
Vulkan reference (damage confined to the lower band, upper walls clean).
Verified here: gym / crack lab / catalogue BYTE-IDENTICAL at defaults;
`BAND=0,0.45` A/B shows the intended confinement and nothing else.

MUD SPLASH since 2026-07-27 (round D — the first NEW effect through the whole
contract, and the `_pad` KNOB BUDGET IS NOW FULL — but see `Material._rsv`
below: since the glTF deletion freed `tex_index`, the next per-material dial
gets a whole 32-bit word before anyone pays for an aux buffer).
`Layer::Mud` is the SIXTH layer, class Paint,
PURE-PIN (`derive` never writes it — splash-back is environmental, so the pin
gesture IS the authoring; the master/solo level rows compose with it for
free). Its amount is the fraction of its OWN SPLASH BAND covered (bottom =
floor, top = `WallSpec.mud_top`, panel row "mud top" indented under the mud
row, file line `mudtop v`, default 0.35 — where `rebar::corr`'s measured
splash term peaks), drawn through story-seeded breakup noise with no damage
gate and gated off fresh-break cores by `skin`. THE AMOUNT IS SOLVED, NOT
CALIBRATED: the first cut mapped amount→threshold with two global constants
and a splash band holds so few noise cells that per-story coverage measured a
1.8× lottery — so `wall::mud_code` solves the quantile of the run's own noise
inside its own band (`RunField::threshold`'s discipline on a second field),
`_pad` lane 2 carries the solved 6-bit threshold code (0 = no mud = every
unstamped material), lane 3 the band-top code (forced 0 while the amount is
0, so a mud-free level leaves the lanes and the probe-cache key untouched).
`wall::mud_noise` + `field::fbm` are the one host mirror; the twin guard
pins both lane decodes, the threshold decode and the breakup seed. Lane 3
spans bit 31 — `_pad` reads must go through `uint(pad)`, never `pad > 0`
(pinned in `pad_bits_layout...`). THE CATALOGUE grew row 3 (z=19, 22×22 grid,
spawn deepened to (20,20)): a pristine control + the mud specimen — row 3
builds ONLY the slabs it has subjects for, because an unauthored slab next to
the spawn sat inside the ROI disc and dissolved on boot; the hole round grows
the count. Mud has NO env knob of its own — it is pin-authored; a harness
recipe reaches it through `WEAR_FILE=`. Same blind side as round C: MSL is
the untested twin — the Mac boot recipe is `LEVEL="effect catalogue"
ZOOM=2.5 TARGET_X=10 TARGET_Z=19` against the Vulkan reference (brown
blotches in the lower band of the right slab, control clean, hard stop at
the band top). Verified here: gym AND crack lab BYTE-IDENTICAL; the
catalogue differs exactly by row 3.
- Verified 4 runs per side, all pairs: `gym` BYTE-IDENTICAL, `crack lab` 3.18 %
  at max 187, catalogue 1.65 % at max 168 — the aging is authored differently, so
  the walls differ; the plain greybox does not move at all.

THE ARTILLERY HOLE since 2026-07-27 (effect-system round E — the last verb of
the owner's original workflow, and the first PLACED effect). `wall::Shells` on
`WallSpec.shells`: up to 3 `Shell { u, y, back }` hits in RUN space sharing one
`caliber` (crater radius, WORLD UNITS — the grain precedent). Breaks taken one
step further: no derivation, no jitter, no probability — artillery is an EVENT,
so no cause writes it and the placing gesture IS the authoring (mud's pure-pin
argument), which also means the level dials and the band deliberately do NOT
touch it. AUTHORED BY CLICK: the `shells` row arms place-mode (a MODE, not
an edit — arming never dirties the save), the next click on the selected
wall places the hit at the pick ray's own point (the face is the one the
camera sees, from the ray's sign on the thin axis), clicking an existing hit
REMOVES it; `caliber` is a slider under it. (Since 2026-07-27 round H the
arming row and the world click live in the IDE — `ide_click` → `shell_place`
— because the wall panel that first carried the gesture is deleted.) GEOMETRY: `rebar::shell_crater` — same depth budget,
same polygon rim, same world-anchored mat as the spall, so `emit_crater`
cannot tell the two apart. The three differences: ROUND (`hu = hy = r`, no bar
snap — BOTH families cross wherever the world mat crosses, which is what makes
the cage read as a cage), rim corner count ∝ perimeter (the spall's 6-10 would
stretch into an obvious polygon at 2-4× the size), and the floor digs to the
honest depth limit (`basin_max`) instead of stopping `BAR_CLEAR` sections past
the mat — an excavation, never a perforation (a through hole is a
renderer-contract change: occluders, WALLCUT, light leaks — deliberately NOT
this round). COMPILE-TIME DISCIPLINE (`wall::compile_shells`): the caliber is
quantized FIRST, rounding down onto `rebar::shell_r_cap`, so legality is
computed on bit-exactly what the generator dequantizes and the grid can never
disagree with the cap; the cap reports `Miss::Clamped { dial: "caliber" }`; an
overlapping pair — same face or facing, a facing pair perforates — DROPS the
later hit and reports (`dial: "shells"`; slot order = authoring order, and a
nudge would move the author's click); a wall below `SHELL_R_MIN = 0.10`
reports `used: 0`. `Geom` grew shell_r/shell_u/shell_y/shell_back with **0 =
empty slot** (`Geom::default()` is the paint-only key and must mean "no
shells", not "three at the run's start"); the relief cap / `t_cap` fire on
shell walls too; SPALL PACKS AROUND SHELLS (their rects, both faces, join both
spall `fits` vetoes — authored outranks derived); on a FAULTED wall a hit
straddling the break is DROPPED, pinned by test (the alternatives draw the
fault's invisible extension through the basin, or move the click). That whole
ordering — placed hits first, front spall vetoed against both shell sets, back
spall vetoed against the front's rects PLUS the shells — is ONE function since
2026-07-28, `crack_geom::allocate_craters`, called by `craze_pier`, by
`split_pier` (which passes its piece containment as the site predicate) and by
the invariant tests. It was written out three times before, and the third copy
— the tests' — had no shell veto in it at all, so the line that stops two
facing basins perforating a slab could be deleted from BOTH production sites
with the whole suite green (no shipped level composes the two: the catalogue
pins spall to 0 on its shell slab, the crack lab authors no shells).
`a_placed_shell_and_the_spall_around_it_never_perforate_the_wall` is the pin,
and it places the hit on the site the damage field itself wants — a shell
parked where nothing competes for it pins nothing. File:
`shell <u> <y> [back]` ×3 + `caliber <v>`; env `HOLE=u,y[,r]` — named HOLE
because `SHELL` is the login shell in EVERY Unix environment: that spelling
put a crater on every wall of every test and its `env_overridden` entry
blocked every save (docs/AGENT_LEARNINGS.md 2026-07-27E). The catalogue's row
3 grew the `shell hole` slab (n = 3, 18 walls). (The wall panel that carried
these rows is DELETED since 2026-07-27 round H — the arming row and the
place-click live in the IDE now, and `menu::PANEL_MAX_H` is back to the
settings sheet's height.) Zero shader edits, zero new materials (basin +
rust reused) — nothing enters the blind-Metal register beyond the next
windowed Mac pass touching the shell rows and one place-click (in the IDE). ALSO this
round: panel drags snap as `k / 50`, not `k * 0.02` — 0.02 has no exact f32,
and the owner's first saved wear file printed the accumulated error verbatim
(`scrub 0.39999998`; the file's `num` is shortest-ROUND-TRIPPING text, so the
ugliness genuinely was the value). Verified 2 runs per side, cross-run floor
zero: `gym` and `crack lab` BYTE-IDENTICAL, catalogue differs with every
delta > 30 confined to the new slab's screen box (the ≤ 30 remainder is the
probe field re-baking around a new occluder); `HOLE=0.35,0.6,0.4` on the lab
composes with the aged facades and the close-up shows the two-family cross
standing proud of a pale basin.

INPUT PACING since 2026-07-27 (owner repro: "in full screen the mouse gets
almost unresponsive, and placing seems to do nothing"). TWO causes, neither
of them the renderer (measured: 240 frames in ~0.4 s at BOTH 1280x800 and
near-fullscreen — the RTX is never the bottleneck): (1) the swapchain was
MAILBOX with `ControlFlow::Poll` + unconditional redraw, i.e. ~600 fps of
DISCARDED frames — free in a small window, but a 5120x2160 fullscreen
surface saturated the GPU and starved the COMPOSITOR, whose software cursor
(Hyprland renders one on this NVIDIA setup, `cursor:no_hardware_cursors` =
auto) then lagged SYSTEM-WIDE and click feedback arrived seconds late —
"nothing happens" was feedback starvation, not a broken gesture (the owner's
session file proves the shells were placed and saved; booting it renders
both craters). The FIFO answer this bought lasted half a day — see THE FIFO
DEADLOCK below; the cap is a self-paced loop over MAILBOX now. (2) slider drags
applied per MOTION EVENT, and a wall-panel drag recompiles the level — at
1000 Hz mouse polling that is a backlog the frame loop can never drain;
drags are COALESCED now to one `menu_drag_to` per frame from the latest
cursor, with the tail flushed on mouse-up so the release lands on the value
under the cursor (`MenuState::drag_pending`).
THE FIFO DEADLOCK (same day, owner: "keyboard unresponsive in fullscreen" /
"cała klawiatura nie działa jeśli zrobię super+f"): the FIFO present that
fixed the cursor starvation can FREEZE THE WHOLE EVENT LOOP on this stack.
Mechanism, measured on a frozen probe: Hyprland + NVIDIA use explicit sync,
a FIFO present waits on a DRM syncobj that only a COMPOSITOR RENDER signals,
and a fullscreen window under VFR can go unrendered indefinitely — the main
thread parks in `drm_syncobj_array_wait_timeout` (thread wchan), no event is
ever processed again, and since the gym is mostly static a frozen frame
LOOKS live: the only visible symptom is "keyboard dead, mouse cursor still
moves" (the compositor draws the cursor). Forcing one compositor render
(`grim -o <output>`) un-froze the loop mid-probe — that is the proof it was
render starvation, not key delivery; a MAILBOX control run sailed through
the same transition. Intermittent on a real monitor (needs a VFR idle beat
at the transition — the first keyboard report and the earlier "not
reproducible" probe verdict were BOTH this race), deterministic on a
headless output. FIX: present is ALWAYS MAILBOX (never blocks) and the GPU
cap moved into the frame loop — `main.rs` paces redraws to the monitor's
refresh period via `ControlFlow::WaitUntil` (re-read on every Resized, so
monitor hops track; `VSYNC=0` uncaps). Two earlier same-day defenses stay,
correct on their own: ESC/Enter/Space carry `!event.repeat` guards (Wayland
key repeat is CLIENT-SIDE — a delayed loop injects repeats and an unguarded
ESC toggles twice per press), and `Focused(false)` clears held movement keys
+ the panel drag. HARNESS: `FS_AT=<secs>` makes the viewer request
compositor fullscreen itself — fullscreen-only symptoms reproduce with no
keyboard and no focus theft (pair with a headless `hyprctl output create
headless` + a `windowrule monitor …, match:title ^(Hayflick)$` — NOTE
Hyprland 0.56 deprecated `windowrulev2`, and its `hyprctl keyword` form
returns "ok" while doing NOTHING, which put two earlier probe windows on the
owner's live monitor). Field diagnostic unchanged: `TIMING=1 bin/run`,
fullscreen, press `l` — "lamps:" prints prove keys arrive; TIME lines prove
the loop is alive; which half is silent names the culprit.
KNOWN WRINKLE — RESOLVED 2026-07-27 (round H), after the owner's first
wear-in-IDE playtest hit it the same day it was parked: the AgeWall beat
used to write `spec[r].story` while it ramped, and a save triggered by ANY
interactive edit then froze the beat's current story into the wear file for
the level-named ramped control (the owner's saved file carried
`story 0.56 0.48 0.85` he never dialed — restored from git, session copy in
that round's scratchpad). The fix is the level_dials discipline as
prescribed: `CrackLab::beat` is an `(run, story)` OVERRIDE applied inside
`recompile` on the way to the sheet, the authored spec never carries it, a
level switch clears it, and an owner CAUSE edit on the ramped run clears it
too (a masked slider would read dead). Pinned by
`the_age_beat_rides_the_sheet_and_never_the_authored_spec`; the image path
is bit-identical by construction (nothing but the serializer and the
inspector display read `spec.story` outside `recompile`).

THE PERSONAL IDE — PRACOWNIA since 2026-07-27 (owner: "the ESC menu has
worked hard enough; as the game grows we'll have ever more sliders — make a
personal IDE tailored to this game, Unity-editor-shaped, minimal to start,
cleanly separated from the game, its UI at ~2x the game pixel's resolution").
v1 is select-and-inspect: Tab toggles it (ESC closes; `IDE=1` boots it open),
an open IDE PAUSES the sim — the 2026-07-23 pause=edit anchor
(docs/EDITOR_HANDOFF_2026-07-23.md) — clears held keys, and owns every
pointer event: chrome first, then a world ray-pick over walls, lamps, the
player and the spawn cell. Top bar + hierarchy (grouped, wheel-scrolled,
labels from the wear file's authored run names) + inspector (transform,
declared props). THE SEPARATION IS A CRATE: `crates/ide` holds the whole UI —
layout, widgets, rasterization, interaction — and knows neither house-game
nor the GPU; the boundary is plain data (`SceneModel` in, `Edit` out) and
`rt-viewer/src/ide_host.rs` is the ONLY adapter, in the rt-probe/house-game
tradition. THE OVERLAY IS STAMPS: panels are CPU canvases on the existing
per-stamp-scale Stamp path (burned into `out` on both backends), so the whole
IDE shipped with ZERO new GPU code, no new blind-Metal debt, and the panels
land in SHOT captures BY DESIGN — a SHOT with `IDE=1` is the headless
verification of the overlay. `ide_scale = max(1, menu_scale/2)` (half the
menu's UI pixel = half the game texel at the default window) — tied to the
menu scale, NOT the zoom: tooling chrome must not grow when the world zooms.
SELECTION IS THE RUN: a wall pick lifts the WHOLE run with the SEL amber
(every pier, not the pier the ray struck), and the crack lab's own selection
follows it, so closing the IDE with a wall picked hands straight over to the
wear panel; lamps/player/spawn get an amber bubble marker instead (no
material to lift). (The amber FILL and the lamp/player bubbles are GONE
since round I — SELECTION IS AN OUTLINE below; the run-not-pier rule stands.) EDITS ARE RELEASE-ONLY (the input-pacing discipline —
drags are coalesced to one step per frame and only move display state; the
release mutates the SPEC and rebuilds via `apply_look`, probe cache
content-keyed): v1 edits are lamp glow (1..8), lamp cell x/z and the spawn
cell. Slider snapping is `k/50` (the wear-file lesson). HARNESS: `IDE=1`,
`IDE_SEL=<object name>` (boot selection), `IDE_EDIT="<obj> <key> <v>[;…]"`
(replay edits through the real apply path — the `WEAR_EDIT` discipline).
Verified on Vulkan/RTX: gym SHOT with the IDE closed is BYTE-IDENTICAL to
pre-IDE HEAD (cross-run floor zero); `IDE_EDIT="lamp 0 glow 1"` A/B moves the
whole lighting; the catalogue's hierarchy lists all 23 runs by their wear
names. THE ADAPTER'S DECISIONS ARE FREE FUNCTIONS since 2026-07-28 — the
`impl Viewer` halves only feed them and write the result, because a state
machine over `Vec<usize>` inside `&mut self` is a wrong-run outline that
ships green: `pick_target` (which pickable a ray names — a wall as its RUN),
`lift_plan` (the crack lab's one pier + EVERY pier the outline lifts),
`wear_props` / `wear_row_of` (the sheet's rows, and the key that reaches each
one back), `split_edit` / `edit_val` (the `IDE_EDIT` grammar). Pinned on the
real gym piers: a pick on ANY pier of a cut facade names the same wall, the
lift is that run and nothing else, the pin `*`, the row indents, the section
heads and the trailing `wall::Miss` row. NEXT (not this round): save — the
level-as-data migration waits in
`archive/editor-v0` (level_file.rs + gym.level, the handoff's load-bearing
decision); wall/grid ops (editor-v0's `apply_op` vocabulary). First Mac
session: boot `IDE=1` once — the stamp path is shared code, but the
per-stamp staging-texture allocation in `blit_overlay` has never carried
four window-tall panels.
WEAR IN THE INSPECTOR since 2026-07-27 (round G, owner: "ustawianie
parametrów efektów w crack labie też sensownie w IDE"): a picked wall's
inspector shows the WHOLE wear sheet — the same `menu::rows_of(spec)` walk
the wall panel draws, mapped row→prop by the adapter (`wear_props`), so the
two surfaces cannot disagree about what a wall exposes. Writes have ONE
spelling: `wear_set_row` (extracted from `crack_drag_to`; the panel
delegates) plus `wear_set_breaks`/`wear_set_pattern` (the panel's cyclers
delegate too; `crack_cycle_policy` deleted). The IDE's release-only rule
BENDS for wear, deliberately: a wall slider drag is LIVE like the panel's —
`ide::Ide::drag_state` exposes the in-flight (obj, key, pending) and the
host applies spec + `wear_edit` one coalesced step per frame — while the
release pays the geometry via `crack_release`, so paint morphs under the
drag and a sub-bucket drag rebuilds nothing (the panel's exact economics;
which rows are cheap is a game opinion, so the IDE only EXPOSES the drag
and the adapter decides). Layer drags PIN (the `*` rides the value text),
breaks is an absolute count slider, pattern the new `ide::PropKind::Cycle`
(one click one step, emitting the ABSOLUTE code so a replay can name a
policy), a `wall::Miss` lands as the trailing read row, and SHELL PLACEMENT
deliberately stays the wall panel's click gesture (the IDE owns every world
click) — its row shows the count. Prop keys are ONE TOKEN ("cover_loss",
"band_lo", "mud_top", native param names) because `IDE_EDIT=` splits
statements on spaces — pinned by `wear_keys_are_single_tokens_and_unique`;
`IDE_EDIT` takes floats now (the prop declares its value type), joined
`env_overridden`, and the replay restores the dirty flag (a harness run
never writes wear files). The inspector grew the panel's value language:
per-prop `show` text ("off", "0.30wu", the pin mark), indents, section
heads, `INSP_W` 168→224 for the labels. Verified on Vulkan/RTX: gym, crack
lab AND catalogue BYTE-IDENTICAL to 2a124e9 with the IDE closed (HEAD
worktree A/B); `IDE_EDIT="ramped control weather 0.9"` ages the pristine
control through the real release path, twice → byte-identical, save
correctly blocked; `…pattern 2;…breaks 2` flips the veneer to mosaic and
breaks the wall; `…spall 0.8` pins with the `*` and opens craters + rebar.
The windowed click/drag of the new rows rides the owner playtest (the
shell's press/drag/release logic is unit-tested; `drag_state` live-apply is
the only new runtime frame).
THE WALL PANEL IS DELETED since 2026-07-27 (round H, owner: "zostało jeszcze
takie menu w rogu na crack labie — uprzątnąć"): with the inspector carrying
the whole wear sheet, the corner panel was a second copy of the same rows,
so `crack_canvas`, `crack_panel_click`, `crack_drag_to`, `crack_cycle`,
`crack_panel_visible`, `crack_click` and `CrackLab.row` are GONE and
`menu::PANEL_MAX_H` is the settings sheet's height again (IDE panels ride
the Stamp path, not the menu staging buffer). What moved rather than died:
SHELL PLACEMENT is the IDE's now — the inspector's `shells` row is the
arming MODE toggle (`PropKind::Cycle` over armed/disarmed, value text
"n [place]" / "n [click wall]"; arming never dirties) and `ide_click` routes
an armed click on the selected wall to `crack::shell_place` + an immediate
`crack_release` (a click is its own release). A closed menu owns NOTHING
(REC badge aside), and outside the IDE a world click is purely the game's —
SELECTION IS IDE CHROME: closing the IDE clears the pick and its amber lift
(there is no surface left to hand it to), `CRACK_SEL=` still preselects for
headless AA-scope work. `IDE_SEL=` now applies BEFORE an `IDE_EDIT=` replay,
so the two compose in the interactive order (an edit-then-select would
disarm the mode the replay just armed). SAME ROUND, the parked AgeWall
wrinkle got its fix (see KNOWN WRINKLE — RESOLVED above) after the owner's
first wear-in-IDE playtest froze ramp state into his wear file; that session
file was restored from git (copy kept in the round's scratchpad). Verified
on Vulkan/RTX: gym, crack lab AND catalogue BYTE-IDENTICAL at defaults
across the deletion; `CRACK_SEL=5` shows the lift with NO corner panel;
`IDE_SEL="ramped control" IDE_EDIT="ramped control shells 1"` renders the
armed row. The windowed place-click through the IDE rides the owner
playtest.
SELECTION IS AN OUTLINE since 2026-07-27 (round I, owner: "mamy gdzieś chyba
taki efekt outline na siatkach — zastosujmy go do pokazywania wybranego game
objectu w naszym IDE"). The SEL bit no longer tints albedo: the shade pass
writes a posImg TAG (w=3, beside the ROI contour's w=2 — contour OUTRANKS it
on a dissolved wall) and the TONEMAP pass draws a steady 1-game-px amber line
(mix toward the SEL accent (1.0, 0.82, 0.40) at 0.85) on the tag-region
boundary — sel side, sky included, depth ignored — so the visible silhouette
outlines, interiors don't, and two piers of one lifted run draw no seam
(openings DO outline: a doorway or a glass pane is not the run's material,
and the ring reads as the selection's true extent). Like the x-ray contour it
fires with the global outline knob off: editor chrome, not a look knob. WHY:
the old fill tinted the very surface being authored — an outline shows the
wall's true paint while marked, which is the point of a wear IDE. The tag
must cover the whole SURFACE: `crack::pier_surface_mats` (main + chalk core +
spall basin/steel — the same set the AA scope walks, now extracted and
shared) feeds `stamp_all`, `crack_apply` and `ide_lift_run`, or the outline
rings every groove and crater from the inside. NEW REACH: lamps and the
player take the outline too — `ide_lift_dyn` tags their dynamic runs'
materials by name (every box mints its own material, so nothing else lifts),
`IdeState.lifted` records them for the explicit clear on the next select
(walls clear through the crack re-derive; stale ids after a rebuild are
no-ops) — and the bubble marker survives ONLY for the spawn cell (a place,
not a mesh). GUARDS: the deleted albedo lift joined wear.rs FORBIDDEN (both
shade twins), `both_tonemap_twins_draw_the_selection_outline` pins the
tonemap decode + amber in both twins, flags.rs re-documents SEL. BLIND MSL
(this round ran on the RTX): shade.metal's tag write + lift deletion and
tonemap.metal's whole sel branch — first Mac session boots `LEVEL="crack
lab" CRACK_SEL=5` and `IDE=1 IDE_SEL="lamp 0"` and compares character
against the Vulkan refs. Verified here: gym, crack lab AND catalogue
BYTE-IDENTICAL at defaults (no selection → the tag path is inert);
`CRACK_SEL=5` draws the outline with no fill and no interior rings on an
aged pier; IDE_SEL wall/lamp/player SHOTs trace run/fixture/figure; two runs
of the aged-facade selection are byte-identical. (The gold squiggles beside
the craters are the walls' own rust paint — present without any selection;
checked before believing them.)
THAT "NO INTERIOR RINGS" CLAIM WAS ASPIRATIONAL UNTIL 2026-07-28. The surface
tag rode `stamp_all`, which runs BEFORE the geometry pass — so it read
`lab.cores`/`lab.spall_mats` from the PREVIOUS scene: empty on a first boot, so
`CRACK_SEL=5` tagged only the veneer and the outline DID ring every crater from
the inside (measured: 740 px, the crater ring, gone after the fix); and stale on
a rebuild, where the ids index a resized materials vec — either past its end
(`WEAR_EDIT=` and every `IDE_EDIT=` wear recipe panicked, `len 334 index 334`,
and the crack lab's own AgeWall beat crashed the level ~1 s into a playtest) or,
when the new scene has MORE materials, onto whatever now sits in the old slot,
silently tagging an unrelated surface. The pass is its own function
(`crack::stamp_surface_sel`) called AFTER `apply_geometry` assigns the fresh ids,
which is the only point where those ids belong to the scene being stamped.
Pinned by `crack::a_rebuild_lays_the_selection_on_this_scenes_materials_and_not_the_last_ones`,
which runs the real two-scene rebuild and reproduces the exact production panic
when the order is inverted. The three shipped levels are byte-identical across
the fix (nothing is selected at boot); only `CRACK_SEL=`/`IDE_SEL=` move.
GOTCHA pinned in docs/AGENT_LEARNINGS.md (2026-07-27F): `crack.runs`/
`pier_run`/`label` are RESOLVE products — populated only when the level has
authored wear — so the IDE derives runs from the piers themselves
(`crack::runs_of`) and treats the lab's copies as optional labels.

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
- `RUSTDOCFLAGS="-D warnings" cargo doc --no-deps` is warning-free, and
- for render-side changes: a before/after `SHOT=` diff shows exactly the
  intended difference, and
- for anything visible in motion: a recorded clip (record-gameplay skill or
  the DEMO env path) actually shows the intended behaviour.

**Why the doc gate is a gate.** This codebase is ~30 % comment lines and treats
its prose as the spec — a stale paragraph is a defect, not untidiness, because
the next agent reads it and acts on it. `cargo doc` is the one mechanical check
on that prose we have: it catches every intra-doc link that names a symbol which
no longer exists, which is exactly the trace a deletion leaves behind. It was
never in the bar, and by 2026-07-28 it had accumulated 23 warnings — including a
live intra-doc link to `run_level`, a function three rounds dead, sitting in the
doc of the damage field everything else reads. It does NOT catch a paragraph
that is merely WRONG (no tool does); it catches the ones that name a corpse, and
those are the ones a deletion commit creates. So deletions should still end with
an `rg` for the deleted symbol across `crates/`, `bin/`, `docs/` and the
shaders — `cargo doc` only sees names spelled as intra-doc links.
