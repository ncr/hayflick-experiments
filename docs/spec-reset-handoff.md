# Spec Reset Handoff — from conversational experiments to a written spec

_Written 2026-07-09 by Claude (Fable 5) at Jacek's request. Audience: the
assistant session that will help Jacek write the game spec, and later the
session(s) that implement it. Read this before either task._

## 1. The pivot

Until now the game's direction was explored conversationally (goo arena
shooter, survival-economy seeds, emergent-gameplay search). That mode is
over. The new process:

1. Jacek writes a **very detailed, multi-page game spec** — down to the last
   detail — with an assistant acting as interviewer/editor (see §5).
2. An implementing session then works **long and autonomously** against that
   spec, needing little or no human input, producing one coherent result
   instead of iterative vibes.

This document states what survives from the existing codebase, what is
dropped as direction, and what the spec must decide.

## 2. Salvaged — binding constraints on the new game

These are kept **because they work and are already verified**. The spec must
be written to fit them; the implementation must not re-litigate them.

### 2.1 The visual pipeline (the whole point of the salvage)

Isometric, large visible pixels, but **globally illuminated / hardware
ray-traced** — the "pixel-art that light behaves correctly in" look. This is
the rt-probe/rt-viewer pipeline on the `rust` branch:

- Low-res buffer rendered by ray tracing (Vulkan `ray_query` on the RTX 5080
  box, Metal on the M2 Pro), then **integer NEAREST upscale** to the window.
- **Pixel-perfect iso contract**: 2:1 isometric (yaw 45°, pitch 30° so
  sin(pitch) = 1/2 exactly), primary rays through pixel centres, no jitter,
  all post (grade → grain → dither) per low-res texel before upscale,
  camera motion snapped to whole low-pixels (no sub-pixel crawl).
- The two shader backends (`crates/rt-probe/src/shaders/*.comp` GLSL ↔
  `crates/rt-viewer/src/shaders_metal/*.metal` MSL) are line-for-line twins
  and must stay in lockstep.

### 2.2 The grid, and the one rule that defines scale

The world is **grid-based with no imported assets**. Geometry is procedural;
the only authored inputs are grid cell contents + material/look parameters.
The single rule tying world to screen:

> **1 world unit = R low-res pixels**, currently `ISO_R = 32·√2 ≈ 45.25`
> (`crates/iso-core/src/lib.rs:12`). Under the 2:1 iso this makes a 1×1 wu
> ground cell a 64×32-lowpixel diamond.

What is binding is the **form** of this contract (a single R constant, the
integer pixel lattice, the clean 2:1 Bresenham stair on diagonals — see
`iso-core` tests), not necessarily the current value of R. If the spec
decides 1 wu is something big (see §4), R may change — once, in the spec,
with goldens regenerated.

### 2.3 Architecture and determinism discipline

The Cargo workspace split and its dependency rules (see `ARCHITECTURE.md`
and the root `CLAUDE.md`) are kept as-is:

| Crate | Role |
|---|---|
| `iso-core` | pure iso camera/lattice math (glam only) |
| `sim-core` | generic ECS runtime — fixed 60 Hz tick, replayable traces |
| `house-game` | ALL game logic, fully headless, builds/tests without a GPU |
| `rt-probe` | deterministic renderer lib + GLSL |
| `rt-viewer` | winit shell, Metal backend, capture; the ONLY crate that sees both game and renderer |

Determinism is the load-bearing discipline and carries over wholesale:
fixed tick, `<tick> <op> <args>` trace replay, `state_hash` oracles for
float-exact sim behaviour, byte-exact golden frames (`bin/golden`,
per-machine golden sets), no wall-clock, all RNG `Pcg32`-seeded from the
level spec.

### 2.4 Tooling

`bin/run [scene]`, `bin/golden`, the headless `SHOT=`/`DEMO=` env paths,
`cargo test` hash oracles, and the `record-gameplay` skill (headless trace →
MP4/GIF). The implementing session should lean on these for verification
exactly as `CLAUDE.md` § Verification prescribes.

## 3. Dropped as direction (kept as reference code)

The following were **experiments, not commitments**. The spec supersedes
them; none of their mechanics are assumed to survive:

- The **goo arena shooter** (`SCENE=arena`: weapons, species, waves, glitch)
  and the goo sim/render path generally.
- The **survival-economy seed** (hunger, flashlight battery) and the
  emergent-gameplay scenario lab.
- The content generators: `cave.rs`, `village.rs`, `building.rs`,
  `floorplan.rs` in `house-game`.

Do not delete this code preemptively — it is working reference for "how a
scene/system plugs into the pipeline" and some of it (goo rendering, the
weapon feel work) may be cannibalized if the spec calls for something
similar. Deletion happens when the spec makes something definitively dead.

## 4. Open decisions the spec MUST close

The headline question, in Jacek's words: **is 1 wu a single wall tile, or
does it represent a field of grass?** I.e. what is the semantic scale of a
grid cell:

- **Architecture scale** — cell = one wall/floor segment; interiors, rooms,
  dungeon/house granularity (what the current scenes do), or
- **Terrain scale** — cell = a patch of terrain (a grass field, a forest
  cell); zoomed-out overworld granularity,
- or a layered answer (overworld grid + local grid), which the spec must
  then define precisely for both layers.

Everything downstream hangs off this: the value of R, camera framing,
what a "cell's contents" is as a data structure, how much geometric detail
one cell procedurally generates, sim granularity, pathfinding. The spec
interview should force this decision **first**.

Other decisions the spec must make explicit (not exhaustive): core loop and
genre commitment (prior lean was iso RPG/survival — reconfirm or replace),
world generation vs authored layouts, entity/mob model, interaction verbs,
UI/HUD within the pixel contract, audio (currently none), progression,
failure states, scope of v1.

## 5. Instructions for the spec-writing session

- **Role**: interviewer and editor, not implementer. Drive the open
  decisions in §4 to closure one at a time, starting with cell scale.
  Push back on vagueness; every mechanic must be stated concretely enough
  that a headless test could be written for it.
- **Constraints**: everything in §2 is fixed. If a spec idea conflicts with
  the pixel contract, determinism rules, or the headless split, surface the
  conflict immediately rather than speccing around it silently.
- **Output**: `docs/GAME_SPEC.md` in this repo. Multiple pages is expected.
  Structure suggestion: 1. Vision & pillars, 2. World model (cell scale,
  grid semantics, generation), 3. Camera & presentation, 4. Entities &
  systems (each with tick-level behaviour), 5. Player verbs & controls,
  6. Progression & failure, 7. UI/HUD, 8. Out of scope for v1,
  9. Milestone plan with per-milestone verification (tests, goldens, clips).
- **For the implementing session** afterwards: required reading is this
  file, `docs/GAME_SPEC.md`, root `CLAUDE.md`, `ARCHITECTURE.md`, and
  `docs/AGENT_LEARNINGS.md`. The verification bar in `CLAUDE.md` applies to
  every milestone: `cargo test` + `bin/golden` + a recorded clip for
  anything visible in motion.
