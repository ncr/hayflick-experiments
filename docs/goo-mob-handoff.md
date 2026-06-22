# Goo-Mob Handoff — continuation plan

Pick-up notes for a new session continuing the goo blob NPC. Read this +
`docs/goo-mob-fissionite-design.md` (original design) first. Everything below is
**native Rust only** (`native/`), Metal backend (Apple Silicon). All changes so
far keep the deterministic, golden-hashed architecture intact.

## Current state (done)

A gooey, splittable, fluorescent blob mob, fully working:

- **Real fluid body** — Position-Based Fluids (Macklin & Müller 2013) per blob:
  incompressible density solve + tensile surface-tension cohesion + XSPH
  viscosity, wall collisions. CPU, f32, deterministic, folded into `state_hash`.
- **Two-lobe dumbbell** — each particle is assigned to one of two spine-end
  anchors (the AI-driven "muscle"); the fluid pools into two lobes joined by a
  density-coupled neck.
- **Lies flat on the ground** — the SDF render squashes metaballs vertically and
  clamps the field to the floor plane → a flat puddle with a flat underside.
- **Traps** — `TrapSpec` floor emitters pull the fluid (and the spine anchors)
  with an inverse-square force → the creature is dragged in and pools into a
  flat captured splat.
- **Splits when shot** — `shoot_system` ray-vs-sphere → HP/tier → two children
  one tier down (runtime `CommandBuffer::spawn` + handle recovery).
- **Translucent SDF render (Metal)** — screen-space metaball composite
  (`goo.metal`): raymarched `smin`, Beer–Lambert green absorption, additive
  glow, Fresnel rim; depth-occluded against the scene.
- **Playground scene** — `SCENE=playground`: large flat plane, walls only on the
  far edges, nothing obscured. The authoring stage for all goo work.

Status: **65 house-game tests green; Metal goldens byte-identical** (`game` /
`game_replay` untouched — the whole feature is gated on `!spec.mobs.is_empty()`).

## Where things live

| Area | File |
|---|---|
| Fluid sim, AI, split, traps, hashing, all `GOO_*` consts | `native/crates/house-game/src/game.rs` (`goo_system`, `damage_goo`, `trap_accel`, `goo_w`/`goo_dw`/`goo_rho0`, `Goo`, `MobRender`) |
| Level specs (`goo_level`, `playground_level`), `MobSpec`/`TrapSpec` | `native/crates/house-game/src/spec.rs` |
| SDF composite shader | `native/crates/rt-viewer/src/shaders_metal/goo.metal` |
| Metal pass wiring + `GooPush` + `GOO_SQUASH`/`GOO_FLOOR_Y`/`GOO_SMIN_K`/`GOO_MAX` | `native/crates/rt-viewer/src/metal_backend.rs` (`render_present`, search `goo_pso`) |
| `FrameState.goo` + `GooBall` | `native/rt-probe/src/render.rs` |
| `goo_balls()` (snapshot → metaballs), `goo_instances()` (Vulkan fallback pool) | `native/crates/rt-viewer/src/sim.rs` |
| Scene build: goo pool gate, trap rings, playground lighting, `is_dollhouse` | `native/crates/rt-viewer/src/game_scene.rs` |
| Scene select + ROI list | `viewer.rs` (`game_spec` match) ; `rt-probe/src/config.rs:~314` (`roi:` allowlist) |

## How to run / capture

```bash
cd ~/dev/hayflick-26-2
# live (interactive)
SCENE=playground bin/run
# single frame
SCENE=playground WINDOW=1024x640 SHOT=/tmp/x.png ./native/target/release/viewer
# headless frame sequence → GIF (the way to show motion):
printf "179 rotate 0\n" > /tmp/tr.txt   # a no-op trace just runs N ticks
SCENE=playground WINDOW=720x450 LIGHT_ANIM=1 DEMO=/tmp/tr.txt DEMO_TICKS=180 \
  DEMO_DIR=/tmp/goo-demo ./native/target/release/viewer
ffmpeg -y -framerate 60 -i /tmp/goo-demo/d_%05d.png \
  -vf "fps=24,scale=540:-1:flags=neighbor,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4" \
  /tmp/goo.gif
```
DEMO bakes probes once then dumps `d_NNNNN.png` per tick. A trace line is
`<tick> <op> <args>` (`shoot ox oy oz dx dy dz`, `rotate dq`, `click ...`).
Always deliver motion as a **GIF** (animates in the client; inline it shows a
still). Tests: `cargo test -p house-game`; goldens:
`GOLDEN_DIR=native/rt-probe/golden-metal bin/golden` (must stay byte-identical).

## Proposed continuation work (priority order)

### 1. More fluid behaviors — biggest "it's really a fluid" payoff
- **Blob merging on contact**: when two blobs' fluids overlap, fuse into one
  entity (sum particles up to a cap, combine HP/tier, drop one entity via the
  command buffer). The SDF already visually merges; this makes it *gameplay*.
  Watch the determinism: merge order must be id-sorted; route despawn through
  `res.buf`; rebuild `self.mobs` (mobs_dirty). Cross-blob neighbor coupling in
  PBF is currently OFF (each blob solves only its own particles) — merging needs
  a touch test (centroid distance < r0+r1) before fusing, not full cross-blob SPH.
- **Splash on hard landing / shot**: scale the existing knockback (`damage_goo`
  adds `kdir * 1.5` to `vel`); add a splash when a fast-moving fluid hits a wall
  (detect high incoming speed in the wall-clamp branch → spray velocity).
- **Viscosity knob as a per-tier trait**: small blobs runnier, large ones thick
  (`GOO_VISCOSITY` per tier). Cheap, adds character.

### 2. Look tuning (pairs with #1)
- Thin the neck further / tune lobe roundness: `GOO_BODY_FRAC`,
  `GOO_END_PULL`, the end-pull softening (`dist + 0.10` in `goo_system`), and
  the render `GOO_SQUASH` / `GOO_SMIN_K`.
- Push translucency/glow: `emis` / `absorb` in `metal_backend.rs::render_present`
  (the `GooPush` literal). Consider a subtle emissive **breathing** pulse off
  `FrameState.time` (presentation-only, already plumbed).
- Optional: a thin specular **Fresnel highlight** rim color, and tint variation
  per tier.

### 3. Locomotion gait
- Right now the spine ends crawl (head steered by AI, tail trails) and the fluid
  is dragged along — it *slides*. Make it read as goo locomotion: oscillate the
  two ends' target separation (peristalsis) or add an inchworm phase so the body
  bunches and extends. All in `goo_system`'s ends section; keep it deterministic
  (drive off the sim tick, not wall clock).

### 4. Demo framing polish (mostly done via playground)
- `playground_level()` is the stage. Possible: hide/relocate the player marker
  pillar (it's a reference; for pure goo shots set it aside or skip
  `scene.dynamic_prim` for playground), add a couple more blobs/tiers, and a
  second trap to show interactions.

### 5. Scale / perf check
- PBF is O(N²) per blob (N=40). At the live cap (12 blobs × 40) it's ~tens of µs
  — fine. If you ever want 80–100+ particles/blob, add a spatial-hash neighbor
  grid (per blob, or a shared grid if cross-blob coupling lands in #1).

## Determinism + tuning gotchas (read before touching the sim)

- **Mob-free levels must stay byte-identical.** Everything is gated on
  `!self.mobs.is_empty()` in `state_hash`/`snapshot`/`goo_system`. Don't draw RNG
  or touch state for mob-free levels. Re-run goldens after any sim change.
- **PBF stability is delicate.** The density correction MUST be clamped
  (`GOO_MAX_DP`) and the CFM relaxation kept soft (`GOO_CFM_EPS`≈25), or the
  fluid explodes and disperses into scattered puddles. Change `GOO_H` /
  `GOO_SPACING` / particle count together and re-check (rho0 self-calibrates via
  `goo_rho0()`, but the gradient scale shifts).
- **A real incompressible fluid won't spontaneously form two lobes** — the
  per-particle end assignment (`i < N/2`) is what makes the dumbbell. Keep it.
- **Force scales:** `trap_accel` is wu/s² (integrated by dt for the fluid);
  the spine ends multiply it by `GOO_END_TRAP`≈8e-4 to get a per-tick Verlet
  displacement. Mixing these up makes traps ~1000× too weak/strong.
- **New scenes need ROI added** to the `roi:` allowlist in `config.rs:~314` or
  they get no dithered reveal (playground deliberately omits it — open stage).
- **`GOO_MAX`** (metal_backend) caps total metaballs = live_cap × particles;
  bump if you raise either.
- Tune in **small steps + screenshot/GIF** — the fluid is sensitive.

## Open product questions for the owner
- Merging: should two blobs of different tiers fuse up a tier, or just pool?
- Should the goo damage the player / have an attack, or stay passive prey?
- Generator integration: emit mobs into procedurally generated rooms (the design
  doc's level-integration step — not started).
- Vulkan: goo currently renders only on Metal (Vulkan has the opaque sphere-pool
  fallback via `GOO_SDF=0`). Port `goo.metal` → a Vulkan compute pass if needed.
