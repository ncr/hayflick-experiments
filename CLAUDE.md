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
| `iso-core` | pure iso 2:1 camera/lattice math (Faza 1 generalizes to projection-as-data) | glam only |
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
`LOOK=<name>` picks a greybox aesthetic preset (`rt-viewer/src/look.rs`).
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

This dev machine (M2 Pro) runs the **Metal** backend; the Hetzner "spawner"
box (RTX 5080) runs Vulkan. **Open spawner duty (2026-07-12):** the purge
edited `vulkan_backend.rs`/`shade.comp` blind (they don't compile on macOS) —
first Vulkan session must `cargo check` + eyeball one gym SHOT.

## Pixel-perfect iso contract (binding; generalizes, never weakens)

- Primary rays go through pixel centres deterministically — no jitter (the
  low-res buffer must stay aliased; `AA=1` opts into jitter for stills).
- All post (grade → grain → dither) runs per low-res texel before the integer
  NEAREST upscale.
- Iso 2:1: input maps onto the screen-pixel lattice with `b = -y/2` so
  diagonals trace a clean Bresenham stair (see `iso-core` tests and the
  2026-05-16 learning). Faza 1 re-derives this contract from projection-as-
  data (integer pixel basis vectors) — the invariants must then hold by
  construction for EVERY projection preset.

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
