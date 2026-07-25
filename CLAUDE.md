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
`crates/rt-viewer/src/backend.rs`.

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
valid here). **Open Metal duty (2026-07-17):** the phase-3 wall-smash demo
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
(the knob panel's click/drag still wants a windowed pass). A
knob-release rebuild (`Viewer::crack_release` → apply_look) measures
~6.5 s on the M2 vs ~115 ms on the RTX — the crack lab's edit loop is
probe-bake bound on the Mac.

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

- Primary rays go through pixel centres deterministically — no jitter (the
  low-res buffer must stay aliased; `AA=1` opts into jitter for stills).
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
- for render-side changes: a before/after `SHOT=` diff shows exactly the
  intended difference, and
- for anything visible in motion: a recorded clip (record-gameplay skill or
  the DEMO env path) actually shows the intended behaviour.
