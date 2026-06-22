# Goo-Mob Handoff — continuation notes

Pick-up notes for a new session continuing the goo blob NPC. **Native Rust only**
(`native/`), **Metal backend** (Apple Silicon). Everything is deterministic and
golden-hashed: all goo work is gated on `!mobs.is_empty()`, so mob-free levels
stay **byte-identical** (the Metal goldens pin this).

On `main` as of the last session: commits for the feature, the cleanup, and the
player-collision are pushed. Read this + `docs/goo-mob-fissionite-design.md`.

## What the goo is now (all DONE)

A single, round, fluorescent, splittable/mergeable goo blob that crawls, lights
the scene, casts shadows, and collides with geometry + the player:

- **Real fluid body** — Position-Based Fluids (Macklin & Müller 2013) per blob,
  40 particles, CPU + f32, folded into `state_hash`.
- **Single round blob + crawl gait** — an internal 2-anchor **capsule spine** is
  a deformation skeleton (NOT a dumbbell). Particles pull toward the nearest
  point on the head↔tail segment. An integer `gait_phase` clock oscillates the
  spine length (bunch → lunge → reflow) so it inchworm-crawls, not slides. The
  head is AI-steered (wander/seek/idle); the tail trails for gooey lag.
- **Translucent SDF render** — `goo.metal` screen-space metaball composite
  (Beer–Lambert green absorption, additive glow, Fresnel rim, ground-flattened).
- **Goo emits REAL light + shadows** — one RT light per blob streamed into a
  reserved NEE slot (`sim.rs::goo_lights`), with soft 12-tap area shadows
  (`shade.metal::softVis`). The blob bodies are **proxy spheres in the
  acceleration structure** (mask `0x02` = shadow/AO only, invisible to the
  primary ray), so blobs self-shadow, shadow each other, and the room lamp casts
  their shadows. (This was "Phase C"; it is the permanent default — the old
  `GOO_BODY_RT` toggle and the fake screen-space ground-glow are removed.)
- **Split** — shooting a blob drops HP; on death it splits into two smaller
  blobs one tier down (`damage_goo`).
- **Merge** — two same-tier blobs (≥ Medium) that overlap fuse into one a tier
  larger (`merge_system`), the inverse of the split. The absorbed blob does NOT
  pop: it enters a **fusing collapse** (`Goo.fusing`/`fuse_pt`) — oozes into the
  survivor and deflates over ~⅓ s, then despawns, so no metaballs vanish in one
  frame. Survivor grows into its new tier smoothly (`body_len` lerps via
  `GOO_GROW_RATE`; render radius is derived from `body_len`). A 45-tick
  `merge_grace` on newborns stops instant re-fusing.
- **Traps** — floor gravity emitters pull blobs in (`trap_accel`), force **capped**
  (`GOO_TRAP_MAX`) so a blob on the singularity is held, not flung.
- **Collision** — walls/static solids/doors via `walk_blocked`, AND the player's
  pillar via `goo_solid` (goo-only; the player walks through its own marker).
  Blobs drape around the pillar instead of passing through.

Status: **68 house-game tests pass, Metal goldens byte-identical.**

## Where things live

| Area | File |
|---|---|
| Sim: `Goo`, `goo_system` (PBF+gait+fusing), `merge_system`, `damage_goo` (split), `trap_accel`, `goo_solid` (player collision), snapshot/state_hash mob blocks, ALL `GOO_*` consts, tests | `native/crates/house-game/src/game.rs` |
| Level specs (`goo_level`, `playground_level`), `MobSpec`/`TrapSpec` | `native/crates/house-game/src/spec.rs` |
| Translucent body SDF composite | `native/crates/rt-viewer/src/shaders_metal/goo.metal` |
| RT shade: `softVis` area shadows, NEE goo-light branch (`dir.w==2 && radius>0.15`) | `native/crates/rt-viewer/src/shaders_metal/shade.metal` |
| Goo SDF pass wiring, `GooPush` (emis/absorb), goo proxy BLAS + instances (mask 0x02, parked far when idle), `unit_sphere_mesh`, `GOO_SQUASH/FLOOR_Y/SMIN_K/MAX/PROXY_CAP/PROXY_SCALE` | `native/crates/rt-viewer/src/metal_backend.rs` |
| `goo_balls()` (metaballs), `goo_lights()` (per-blob RT lights), `goo_instances()` (Vulkan ellipsoid fallback) | `native/crates/rt-viewer/src/sim.rs` |
| Per-frame assembly (spotlights + goo lights into FrameState) | `native/crates/rt-viewer/src/viewer.rs` |
| `Spotlight` (+`tint`), `SPOT_WARM`, `N_RESERVED=16`, `frame_lights_cpu`, `scan_lights`, `FrameState`, `GooBall` | `native/rt-probe/src/render.rs` |
| Scene build: player pillar (`PLAYER_HALF` box), goo pool gate, trap rings, playground lighting, `is_dollhouse` | `native/crates/rt-viewer/src/game_scene.rs` |
| ROI scene allowlist | `native/rt-probe/src/config.rs` (`roi:` ~line 314) |

## How to run / capture

```bash
cd ~/dev/hayflick-26-2
SCENE=playground bin/run                               # live (interactive)
SCENE=playground WINDOW=1024x640 SHOT=/tmp/x.png \
  ./native/target/release/viewer                       # single frame
# headless frames → MP4 (the way to show motion):
printf "239 rotate 0\n" > /tmp/tr.txt                  # no-op trace = run N ticks
SCENE=playground WINDOW=720x450 LIGHT_ANIM=1 DEMO=/tmp/tr.txt DEMO_TICKS=240 \
  DEMO_DIR=/tmp/d ./native/target/release/viewer
ffmpeg -y -framerate 60 -i /tmp/d/d_%05d.png -c:v libx264 -pix_fmt yuv420p \
  -crf 18 -vf "scale=720:450:flags=neighbor" -movflags +faststart /tmp/out.mp4
```
Trace line = `<tick> <op> <args>` (`shoot ox oy oz dx dy dz`, `rotate dq`).
Deliver motion as MP4/GIF (animates in client; `Read` shows a still).
Tests: `cargo test -p house-game`. Goldens (MUST stay byte-identical):
`GOLDEN_DIR=native/rt-probe/golden-metal bin/golden`.

The **playground** is the authoring stage (5 Mediums + a central trap → they
crawl in, merge into Larges, under full C lighting; the player pillar is at
`(-0.5,-0.5)`). Edit `playground_level()` freely — it is NOT a golden scene.

## Proposed next work

1. **Splash** — bigger directional spray when a blob is shot (`damage_goo`
   already adds `kdir*1.5` to `vel`); add a splash when fast fluid slaps a wall
   or the player collider (detect high incoming speed at the clamp).
2. **Per-tier viscosity** — small blobs runnier, big ones thick (`GOO_VISCOSITY`
   as a per-tier value). Cheap character.
3. **Level-authored prop colliders** — extend `goo_solid` to a list of authored
   collider rects/circles so generated rooms can drop obstacles the goo flows
   around (the player-pillar case generalizes directly).
4. **Head-on jam fix** — a blob pulled DEAD-CENTRE into an obstacle (no lateral
   component) can jam (point-head, no pathfinding). Add a small lateral nudge to
   the head when it is blocked but the goal is beyond the obstacle.
5. **Light polish** (optional) — lift `goo_lights()` `LIFT` / raise `power` to
   brighten pool centres without losing the self-shadow contact.
6. **Generator integration** — emit mobs/traps into procedurally generated rooms.
7. **Vulkan parity** — the SDF body, goo lights, and RT shadows are Metal-only;
   Vulkan has the opaque sphere-pool fallback (`goo_instances`), no goo lights.

## Determinism + tuning gotchas (read before touching the sim/render)

- **Mob-free levels MUST stay byte-identical.** Everything is gated on
  `!mobs.is_empty()`. Re-run goldens after ANY sim/shader change.
- **Idle goo proxies MUST stay parked far away** (`y=-1000`, mask `0x00`). At the
  origin, 480 degenerate instances perturbed the BVH/probe-bake enough to flip
  ROI-dither pixels and FAIL the `game` golden (657px). `goo_proxy_parked()`.
- **`softVis` is gated to goo lights only** (`dir.w==2.0 && radius>0.15`) and the
  non-goo NEE path is kept VERBATIM, so scene-lamp/flashlight codegen is
  unchanged. Don't restructure the shared loop.
- **PBF stability is delicate** — the density correction MUST be Δp-clamped
  (`GOO_MAX_DP`) with soft CFM (`GOO_CFM_EPS`≈25) or it disperses. Tune in small
  steps + capture.
- **Render radius is derived from `body_len`** (`r = body_len / GOO_BODY_FRAC`),
  so the merge growth ramps. Keep that link.
- **Merge/split are deterministic**: id-sorted, one per tick, `merge_grace`
  prevents instant re-fuse, fusing blobs are skipped by merge AND shoot (no
  double-despawn). `next_mob_id` + all new `Goo` fields are hashed.
- **`N_RESERVED=16`** holds the flashlight + up to `GOO_LIVE_CAP`(12) goo lights.
- **Cost**: C adds ~+6.8 ms/frame at 720×450 (per-frame TLAS rebuild of ~480
  proxies + soft-shadow taps). Optimisations if needed: one ellipsoid proxy per
  blob (480→12), TLAS refit vs rebuild.

## Open product questions for the owner
- Should the goo damage/attack the player on contact, or stay passive prey?
- Merge across different tiers, or same-tier only (current)?
- Is Vulkan goo parity needed, or is Metal the shipping path?
