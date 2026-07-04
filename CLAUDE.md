# CLAUDE.md — Project Conventions (rust branch)

Native Rust only. The TypeScript web stack was removed in the `rust`-branch
pivot (it lives on `main`).

## Required Reading

Before making technical decisions, read:
- `docs/AGENT_LEARNINGS.md` — post-mortems and failure patterns (per `AGENTS.md`)
- `ARCHITECTURE.md` — binding design for the workspace split + ECS boundaries
- `docs/goo-mob-handoff.md` — goo sim/render state, determinism gotchas, arena notes

## Workspace

Cargo workspace at the repo root, members `crates/*`:

| Crate | Role | May depend on |
|---|---|---|
| `iso-core` | pure iso 2:1 camera/lattice math | glam only |
| `sim-core` | generic ECS runtime (hecs wrap, fixed tick, traces) | hecs, glam |
| `house-game` | ALL game logic, fully headless | sim-core, iso-core |
| `rt-probe` | deterministic renderer lib (Vulkan ray_query) + GLSL | iso-core |
| `rt-viewer` | `viewer` binary: winit shell, Metal backend, capture | everything |

**rt-probe and house-game never see each other** — only rt-viewer's adapter
knows both. The game must build and test without a GPU.

## Key Commands

| Command | Description |
|---|---|
| `bin/run [scene]` | Build + launch viewer (`cave` default; `arena` = goo shooter) |
| `bin/golden` | Golden-frame gate; auto-picks `golden-metal/` on macOS. `--update` regenerates |
| `cargo test` | Headless workspace tests incl. the goo hash oracles |
| `.claude/skills/record-gameplay` | Headless trace → MP4/GIF clip |

Env knobs pass through `bin/run` (see `crates/rt-probe/src/config.rs`):
`WINDOW=WxH SHOT=out.png` renders one headless frame; `DEMO=<trace>
DEMO_TICKS=N DEMO_DIR=<dir>` renders frame sequences; `CAVE_SEED=…` etc.

## Determinism — the load-bearing discipline

1. **Fixed tick, replayable command streams.** Sim time = `tick / 60`; traces
   (`<tick> <op> <args>`) drive headless runs bit-identically.
2. **`state_hash` oracles.** The four `goo_sim_hash_oracle_*` tests pin the goo
   sim's exact float behaviour. A refactor that reorders any goo float fails
   them. Intentional behaviour changes: re-capture the constants and say why in
   the commit. `goo_system` sub-steps are extracted to preserve float order —
   never reorder/reassociate inside them.
3. **Byte-exact goldens.** `bin/golden` compares whole-frame PNGs. Goldens are
   machine + backend specific: `crates/rt-probe/golden/` (Vulkan/RTX 5080) vs
   `crates/rt-probe/golden-metal/` (this M2 Pro). Mob-free scenes must stay
   byte-identical after ANY sim/shader change — the goo path is gated on
   `!mobs.is_empty()`.
4. **No wall-clock, no unseeded RNG in the sim.** All randomness via `Pcg32`
   seeded from `LevelSpec.seed`; flicker is stateless `hash(tick, seed)`.

## Two render backends — keep them in lockstep

`crates/rt-probe/src/shaders/*.comp` (GLSL/Vulkan) and
`crates/rt-viewer/src/shaders_metal/*.metal` (MSL) are line-for-line twins
(`goo.comp` ↔ `goo.metal`, `shade.comp` ↔ `shade.metal`). A feature added to
one must be ported to the other in the same effort, or documented as debt in
`docs/goo-mob-handoff.md`. Shared push-constant structs and look constants
live once in `crates/rt-viewer/src/backend.rs`.

This dev machine (M2 Pro) runs the **Metal** backend; the Hetzner "spawner"
box (RTX 5080) runs Vulkan and keeps its own golden set.

## Pixel-perfect iso contract (inherited, still binding)

- Primary rays go through pixel centres deterministically — no jitter (the
  low-res buffer must stay aliased; `AA=1` opts into jitter for stills).
- All post (grade → grain → dither) runs per low-res texel before the integer
  NEAREST upscale.
- Iso 2:1: input maps onto the screen-pixel lattice with `b = -y/2` so
  diagonals trace a clean Bresenham stair (see `iso-core` tests and the
  2026-05-16 learning).

## Verification

A change is not done until:
- `cargo test` passes (the headless suite is the CI-able layer), and
- `bin/golden` passes for render-side changes (or goldens are intentionally
  regenerated with justification), and
- for anything visible in motion: a recorded clip (record-gameplay skill or
  the DEMO env path) actually shows the intended behaviour.

Renderer-visible goo changes aren't covered by goldens (they're mob-free):
diff a `SCENE=goonursery … SHOT=` frame before/after instead.
