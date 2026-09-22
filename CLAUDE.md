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
| `ide` | the game's chrome: creative mode's toolbar + the CPU raster it draws with; knows neither the game nor the GPU | font8x8 only |
| `surface` | painted wall surfaces (2026-09-22): brush strokes → texel layers → albedo, baked on the CPU at one texel per game pixel | std only |
| `flora` | vegetation (2026-09-22): the grass density map from ground brush strokes, procedural trees and bushes as triangle soups | std only |
| `phys-spike` | throwaway Box3D rigid-body world (leaf: no game, no GPU, no renderer) — the `wall smash` demo's rubble is its one consumer, through `rt-viewer/src/phys_scene.rs` | glam only |
| `rt-viewer` | `viewer` binary: winit shell, Metal backend, gym loop, capture | everything |

**rt-probe and house-game never see each other** — only rt-viewer's adapter
knows both. The game must build and test without a GPU.

## CREATIVE MODE + PAINTED SURFACES + FOLIAGE (owner 2026-09-22) — the editor reset

Owner: "I don't want SolidWorks or Unreal. I want a GAME, and the editor is one
of its modes, cut for it — tools worth a good city builder or level editor.
Chat/AI is only an add-on." So the authoring surface is now **creative mode**,
not the slider IDE:

- **Tab = play ↔ build.** Building pauses the sim, frees the camera (WASD pans,
  wheel zooms, q/e turn), draws a 1-game-px build grid, and shows ONE toolbar
  at the bottom (`ide::toolbar`, the only chrome) with three CATEGORIES
  (F1..F3 or click; 1.. picks a tool inside the category): **build** — wall
  (drag corner to corner), building (drag a rect: floor, walls, a +z
  doorway), lamp, spawn; **walls** — rain, soot, spall (drag over a wall);
  **plants** — grass, dry (drag over the ground; right-drag mows), tree
  (click), bush (drag scatters). Right button removes / scrubs / mows /
  uproots, Esc cancels a gesture, Ctrl+Z / Ctrl+Y undo/redo
  (whole-level snapshots). The ghost of the gesture in flight is drawn by the
  TONEMAP from the primary-hit world position (`TonePush.edit1/edit2`, both
  twins) — stamps are opaque copies and cannot carry a ghost.
- **All gesture decisions are headless** in `house_game::gym::creative`
  (`preview` builds the ghost AND the commit from one function); the viewer
  adapter is `rt-viewer/src/creative_host.rs`. A commit hands the new grid to
  the sim (`GymGame::set_level` — before it, a wall built in an editor could
  be walked through), rebuilds, and saves file-backed levels.

**PAINTED SURFACES** replace per-ray procedural wear for EVERY wall of "after
the rain". A dwelling lot's authored history is no longer a shader branch: its exposure
code (2 corrosion / 3 fire / 4 blast) selects a STROKE PRESET written into the
level data (`neighborhood::history_strokes` — rain runs from leaking crowns,
broad corrosion craters, smoke out of window heads, a blast tearing the crown
off), so the houses are painted with the owner's own brushes and can be
scrubbed, repainted and undone like any stroke. `terrain::cut_windows` then
cuts the lot walls' openings through the painted mesh (uv interpolates, the
atlas stays put). A spall reaching the top edge BREAKS THE CROWN
(`Face::crown`, the notch is the crater's outline; both faces share the lower
crown) and the torn bars stand proud of it; lost cover lies as rubble below
each crater.
The `surface` crate (std only) BAKES a face on the CPU at **one texel per game
pixel** — 40 texels/wu along world x, 20 along z, 38.73 up (the trimetric
axis images; after a q/e turn the ratio is 2:1, still whole pixels) — from the
level's brush strokes (`GymLevel.paint`, file line `paint rain|soot|spall X Y
Z ±x|±z R`, world-anchored). A face is layers — `loss` (cover lost, wu),
`crack`, `wet`, `leach`, `soot`, `rust` — one function per effect, composed by
`Face::shade`. `rt-viewer/src/painted.rs` displaces the face mesh by the loss
(a spall is a real crater), grows the steel where the loss passes `COVER`,
and packs the albedo into `Scene::atlas` (binding 6 / Metal `buffer(11)`,
`ATLAS_W` 2048, gamma-2 RGBA8; `Material.surface == SURFACE_ATLAS`, vertex uv
= atlas texel). A paint drag re-bakes ONE face and re-uploads the atlas per
dab (`RenderBackend::update_atlas`) — paint shows under the cursor with no
rebuild; the release rebuilds for the geometry. WHY (the argument the owner
accepted): an effect is one CPU function — no GLSL/MSL twins, no `_pad` budget,
PNG-dumpable (`cargo run -p surface --example preview`) — and at this pixel
size a bake loses nothing a per-ray evaluation had.
**BLIND METAL:** `shade.metal`'s atlas read + `buffer(11)` binding,
`tonemap.metal`'s grid/ghost/brush branch and `MetalBackend::update_atlas`
are unrun. First Mac session: `LEVEL="after the rain"`, Tab, build a wall,
paint it with 5/6/7 — the paint must show live and survive the release.
**FOLIAGE** (the plants category) follows the same rule — data in the level,
baked on the CPU, the shader only reads. The `flora` crate (std only) bakes
the GRASS DENSITY MAP (`green`, `dry` per texel, 4 texels per wu, a fixed
256 × 256 square from the world origin) from the level's natural growth
(`foliage::natural` — open soil in noise patches, the road only in its
cracks, the burnt lot's surroundings scorched to sparse straw; moved out of
the shade pass) plus the ground brush strokes (`GymLevel.ground`, file line
`grow grass|dry|mow X Z R`). The map lives in the atlas's reserved top-left
corner (painted faces pack below it, `Packer::below`), and `terrain.inc`'s
`floraAt` decides per blade whether it roots and how much of it is straw —
the analytic, wind-blown, player-bent blades themselves are unchanged. The
atlas reaches the shared include through `ATLAS_PARAM`/`ATLAS_ARG` (empty in
GLSL, whose buffer is a global declared above the includes; the kernel
parameter in MSL). A ground drag re-bakes the map per dab and re-uploads —
grass grows under the cursor with no rebuild. TREES and BUSHES
(`GymLevel.plants`, file line `plant tree|bush X Z SEED`) are grown from
their seed by `flora::plant` (a wandering trunk, forking branches, faceted
leaf clumps; one in five trees is dead; the ground's `dry` browns the
leaves) and merged into three MATTE primitives (bark, leaf, dry leaf) by
`rt-viewer/src/foliage.rs`. The street starts with a dozen
(`neighborhood::starting_plants`). The sim walks through foliage.
**BLIND METAL** adds `terrain.inc`'s atlas read through the threaded
parameter.

**HARNESS:** `PLAY_SCRIPT=<file>` + `DEMO=` records "let's play" clips: scripted
keys/mouse (`say`, `key`, `hold`, `to x z`, `at x y z`, `button <name>`,
`down/up left|right`) through the same viewer methods as the window, with the
cursor, key caps and captions composited onto the captured frames on the CPU
(never game UI). Grammar in `play_script.rs`.
A/B against Codex's per-ray facades (2026-09-22, same four cameras): the
presets reach comparable damage (full bar grids in the corrosion craters, the
blast crown torn, rubble); Codex's lenses are still larger and more integrated
— a preset-tuning job, not a model limit. NEXT: owner playtest.

## The wear/crack pipeline and the slider IDE — DELETED (2026-09-22)

Owner: "private project, no legacy — if something needs deleting, delete it;
git history is the safety net." Creative mode + painted surfaces superseded
both, so they are gone: the `wear-core` crate, `crack.rs`, `crack_geom/`,
`wear.rs`, `wear_file.rs` and the `.wear` files, the per-ray WEATHERED SKIN /
effect-word / story-key / mud / band shader blocks in BOTH twins, the
`_pad` knob lanes and the GEO/CRAZE/SEL/AA flags, the `ProbeRefresh::Local/Roll`
carry paths (only the crack lab used them — the wall smash and roof tear keep
the amortized roll through `tear_off`), the AgeWall beat, the "crack lab",
"effect catalogue" and "weathered courtyard" levels, the slider IDE
(`ide_host.rs`, the `ide` crate's shell/scene, F2), the wear ESC rows, every
`WEAR_*`/`STORY`/`SHAPE`/`SPALL`/`SCRUB`/`BAND`/`HOLE`/`CRACK_SEL`/`IDE*`/
`PROBE_LOCAL` knob, and the already-disabled contour AA (`aa`, `aa scope`,
`aa soften`, `aa rubble`, the tap/gate dispatches, `DEBUG_AA`). What survived
is the part that was never about wear: the structural TWIN DIFF moved to
`rt-viewer/src/twin.rs`, and `flags.rs` keeps OCCLUDER/GLASS/MATTE/CONCRETE.
For the deleted code and its long design history (the rounds, the measured
numbers, the blind-backend registers), check out commit `6940129` — the last
tree that has it — and read its CLAUDE.md and `docs/CRACKS_PLAN_2026-07-25.md`.

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
the smash rig and its probe refresh address `Pier.lo/hi`, so the next
box→mesh pass gets that assertion aimed at it on day one.
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
because those ARE commands; a click only produces commands once a route
exists), and `demo_advance_tick` steers a live
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

`rt-viewer/src/flags.rs` owns every flag, NAMED BY VALUE (`_pad & VALUE`,
never a bit index — the prose once drifted into two readings of "bit 4"):
OCCLUDER 1, GLASS 2, MATTE 4, CONCRETE 16; 8/32/64/128 and everything above
the flag byte are free since the wear deletion. `the_flags_are_distinct_bits`
walks the exhaustive list, and `both_twins_spell_every_flag_value_as_the_host_does`
reads BOTH shader sources at compile time, because a flag whose value moves on
the host and not in a shader is a silent, backend-specific wrong image.

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
two `ProbePush` declarations. (The trailing `misc3` slots — Vulkan's `.yzw`,
Metal's `.zw` — are unused since the contour AA was deleted.)

THE TWIN DIFF since 2026-07-28 (`twin::twins_are_structurally_identical`)
is what makes "line-for-line twins" a FACT instead of a promise. It reads all
six sources at compile time, splits each into top-level items (functions,
structs, file-scope constants), normalizes both dialects onto one token stream
and asserts the two are EQUAL, item for item — so a change to either twin that
the other did not get fails `cargo test` with the diverging tokens printed.
It replaced a fragment whitelist that never compared the twins to each other
and covered 2 of the 6 files: four image-changing edits to `shade.metal` alone
(stain tint, glaze-web line width, mud strength, the damage field's `rise`)
each passed all 183 tests before it. The normalization is
documented rule by rule in `twin.rs`'s module doc — types, numbers by
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
anything).

**THE AFTER-THE-RAIN MERGE (2026-09-22) — the inversion again.** Codex's
2026-09-05 round (concrete aftermath, the neighborhood, the Vault 42 survivor,
dusty air; docs/*_2026-09-05.md) ran on Metal ONLY; the merge ran it on the
RTX, where all of it renders (Vulkan is now the verified side for the codex
work). Merge facts the next agent needs: `Vertex.uv` is BACK (24 → 32 B, both
twins' `Vertex` structs including the probes pair) as a generator-authored
channel, not a texture coordinate; the free `_rsv` word is `Material.surface`
(survivor garments -2..=-16); the shared material
sources are `rt-probe/src/shaders/*.inc`, `#include`d by glslangValidator and
string-spliced by `metal_backend.rs`; the twin diff strips `#`-lines and maps
the hit instance transform (`HIT_W2O`). BLIND ON METAL: the merged
`shade.metal` (main's `hasProbes` deletion + `misc2` repack together with
codex's blocks), the restored 32-B `Vertex` in `probes.metal`, and the splice
without `NTEX_COUNT`. First Mac session: boot `LEVEL="after the rain"` and
compare against the Vulkan SHOTs.

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
edits are inert on Vulkan, but the MSL side is UNRUN. First Mac session: boot
`LEVEL=gym` and compare against the Vulkan reference. The failure signature of
a bad repack is loud and specific: probe GI at the wrong dim (a flat-lit or
black-ambient image) if `.y` is wrong, `REFL` blocks at the wrong size if `.z`
is.

**BLIND METAL (2026-09-22, the wear deletion):** `shade.metal`'s wear/AA/
selection blocks and `tonemap.metal`'s AA divide, contour soften and selection
outline were deleted in lockstep with the GLSL twins (the twin diff passes),
and `metal_backend.rs` lost `rebuild_scene`'s carry path, the three
`set_material_*` hooks and the AA tap dispatches — all written on the RTX box,
never compiled for macOS. First Mac session: build, then boot `LEVEL=gym`,
`LEVEL="after the rain"` and `LEVEL="wall smash"` against the Vulkan SHOTs.

**Open Metal duty (2026-07-17):** the phase-3 wall-smash demo
(`LEVEL="wall smash"`, demos/viewer/phys-spike/gym_scene edits) is
host-side only — no shader or backend code touched — but was built and
verified on Vulkan only; first Mac session should boot it and eyeball the
collapse + GI settle.

## Input pacing and the fullscreen deadlock (2026-07-27)

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
session file proved the clicks had landed). The FIFO answer this bought
lasted half a day — see THE FIFO DEADLOCK below; the cap is a self-paced loop
over MAILBOX now. (2) slider drags applied per MOTION EVENT — at 1000 Hz mouse
polling that is a backlog the frame loop can never drain; drags are COALESCED
now to one `menu_drag_to` per frame from the latest
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
+ the menu drag. HARNESS: `FS_AT=<secs>` makes the viewer request
compositor fullscreen itself — fullscreen-only symptoms reproduce with no
keyboard and no focus theft (pair with a headless `hyprctl output create
headless` + a `windowrule monitor …, match:title ^(Hayflick)$` — NOTE
Hyprland 0.56 deprecated `windowrulev2`, and its `hyprctl keyword` form
returns "ok" while doing NOTHING, which put two earlier probe windows on the
owner's live monitor). Field diagnostic unchanged: `TIMING=1 bin/run`,
fullscreen, press `l` — "lamps:" prints prove keys arrive; TIME lines prove
the loop is alive; which half is silent names the culprit.

## The level is file data (2026-08-09)

THE LEVEL IS FILE DATA since 2026-08-09 (the editor-v0 resume; the archived
level_file.rs + gym.level came off the tag, drift-adjusted to today's grid
API). `house_game::gym::level_file` is the format — `size/spawn/lamp/room/
wallx/wallz`, one statement per line, canonical serialize pinned as a
fixpoint — and `gym_level()` IS `parse(GYM_LEVEL_SRC)`: the hand-written
builder is gone, verified grid-hash-identical (a CMDS replay prints the same
state hash to the bit), all levels SHOT-byte-identical across the swap. The
other levels (concrete aftermath, after the rain) stay generated code.
`HOUSE`/`DOORWAY` now DOCUMENT the file, pinned by
`the_house_constants_describe_the_checked_in_level`.
THE AUTHORED SPEC AND THE BOOT SPEC ARE NOT THE SAME THING — that is the
AgeWall lesson applied to geometry, and it is load-bearing: a demo boots
with its own spawn, so `level_host::load` remembers the AUTHORED spawn and
`Viewer::level_save` writes THAT; an owner spawn edit in creative mode
updates both. Creative-mode commits save (`creative_rebuild` → `level_save`):
dirty-gated (interactive edits only), blocked by any env knob whose table row
says it writes the authoring (`EDIT=`), redirected — load
AND save — by `LEVEL_FILE=` (missing path boots the baked default and saves
to the new file), and refused with one line on the code-generated levels.
`level_host::env` is the table; the source-scan guard
`every_level_env_read_names_a_knob_from_the_table` fails the tree on a bare
env read in level_host.rs. HARNESS: `EDIT="wallx 9 9; room 1 1; lamp 2 2 5;
spawn 4 4"` applies `level_file::EditOp` ops at boot (`apply_op` — every op
its own undo, out-of-bounds rejected without touching the spec; the ONE
mutation vocabulary), verified: one op = one new wall in the SHOT,
missing-file boot byte-identical.
BOOT_DEMO RELOADS THE SPEC for the demo's level through the same `load` —
before this round it reused the CURRENT level's grid, so an ESC LEVELS
switch onto another level rebuilt the GYM with that level's spawn; levels
booted only via `LEVEL=` (which takes the correct path) never showed it.

## Pixel-perfect iso contract (binding; generalizes, never weakens)

- Primary rays go through pixel centres deterministically — no jitter, ever, on
  any ray: the low-res buffer is exactly ONE sample per texel and hard-edged.
  (The one exception it ever had, the scoped contour-coverage AA of
  2026-07-25, was switched off by the owner 2026-09-05 and deleted
  2026-09-22.)
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
