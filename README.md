# Hayflick — Native Iso Ray-Traced Game

A deterministic, pixel-perfect isometric game engine in Rust: hardware ray
tracing (Vulkan `ash` on Linux/NVIDIA, Metal on Apple Silicon), a headless
`hecs` ECS game core, and the **Goo Arena** — a skill-shooter against
splittable, mergeable, physically simulated goo blobs.

This branch (`rust`) is the native-only pivot. The pre-pivot TypeScript
web stack lives on `main`.

## Quick start

```bash
bin/run                 # procedural graybox cave (default scene)
bin/run arena           # the goo arena shooter
bin/run house           # any SCENE value: cave | house | lab | grid | game | arena | ...
```

In the viewer: ESC opens the live-tune menu (sliders print the env string to
reproduce), `r` records a clip to `clips/`, `f` flashlight, `l` room lights.
Keys 1–5 pick arena weapons, LMB shoots.

## Layout

```
Cargo.toml            workspace: crates/*
crates/
  rt-probe/           deterministic renderer lib (Vulkan ray_query) + GLSL shaders + goldens
  rt-viewer/          the `viewer` binary: winit shell, Metal backend + MSL shaders, capture
  house-game/         all game logic; fully headless + hash-tested (no GPU needed)
  sim-core/           tiny generic ECS runtime (hecs wrap, fixed tick, command streams)
  iso-core/           pure iso 2:1 camera/lattice math (glam only)
bin/run               build + launch the viewer
bin/golden            golden-frame regression gate (auto-picks the Metal set on macOS)
assets/               tileset GLBs + props consumed by the house/lab scenes
docs/                 goo handoff + design notes, agent learnings
ARCHITECTURE.md       binding design doc for the workspace split + ECS
```

## Verify

```bash
cargo test              # headless: sim, hash oracles, iso math (fast, no GPU)
bin/golden              # byte-exact scene renders vs checked-in goldens (needs GPU)
```

Goldens are machine-specific (GPU + driver float behaviour) and per-backend:
`crates/rt-probe/golden/` (Vulkan/RTX) vs `crates/rt-probe/golden-metal/`
(M2 Pro). `bin/golden --update` regenerates after an intentional look change.

## Recording gameplay

The `record-gameplay` skill (`.claude/skills/record-gameplay/`) renders
headless frame sequences from a trace file into MP4/GIF — deterministic,
no window needed. See `docs/goo-mob-handoff.md` for the trace format.
