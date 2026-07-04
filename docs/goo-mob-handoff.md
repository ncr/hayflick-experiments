# Goo-Mob Handoff — continuation notes

Pick-up notes for a new session continuing the goo blob NPC. **Native Rust only**
**Metal backend** (Apple Silicon). Everything is deterministic and
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
| Sim: `Goo`, `goo_system` (PBF+gait+fusing), `merge_system`, `damage_goo` (split), `trap_accel`, `goo_solid` (player collision), snapshot/state_hash mob blocks, ALL `GOO_*` consts, tests | `crates/house-game/src/game.rs` |
| Level specs (`goo_level`, `playground_level`), `MobSpec`/`TrapSpec` | `crates/house-game/src/spec.rs` |
| Translucent body SDF composite | `crates/rt-viewer/src/shaders_metal/goo.metal` |
| RT shade: `softVis` area shadows, NEE goo-light branch (`dir.w==2 && radius>0.15`) | `crates/rt-viewer/src/shaders_metal/shade.metal` |
| Goo SDF pass wiring, `GooPush` (emis/absorb), goo proxy BLAS + instances (mask 0x02, parked far when idle), `unit_sphere_mesh`, `GOO_SQUASH/FLOOR_Y/SMIN_K/MAX/PROXY_CAP/PROXY_SCALE` | `crates/rt-viewer/src/metal_backend.rs` |
| `goo_balls()` (metaballs), `goo_lights()` (per-blob RT lights), `goo_instances()` (Vulkan ellipsoid fallback) | `crates/rt-viewer/src/sim.rs` |
| Per-frame assembly (spotlights + goo lights into FrameState) | `crates/rt-viewer/src/viewer.rs` |
| `Spotlight` (+`tint`), `SPOT_WARM`, `N_RESERVED=16`, `frame_lights_cpu`, `scan_lights`, `FrameState`, `GooBall` | `crates/rt-probe/src/render.rs` |
| Scene build: player pillar (`PLAYER_HALF` box), goo pool gate, trap rings, playground lighting, `is_dollhouse` | `crates/rt-viewer/src/game_scene.rs` |
| ROI scene allowlist | `crates/rt-probe/src/config.rs` (`roi:` ~line 314) |

## How to run / capture

```bash
cd ~/dev/hayflick-26-2
SCENE=playground bin/run                               # live (interactive)
SCENE=playground WINDOW=1024x640 SHOT=/tmp/x.png \
  ./target/release/viewer                       # single frame
# headless frames → MP4 (the way to show motion):
printf "239 rotate 0\n" > /tmp/tr.txt                  # no-op trace = run N ticks
SCENE=playground WINDOW=720x450 LIGHT_ANIM=1 DEMO=/tmp/tr.txt DEMO_TICKS=240 \
  DEMO_DIR=/tmp/d ./target/release/viewer
ffmpeg -y -framerate 60 -i /tmp/d/d_%05d.png -c:v libx264 -pix_fmt yuv420p \
  -crf 18 -vf "scale=720:450:flags=neighbor" -movflags +faststart /tmp/out.mp4
```
Trace line = `<tick> <op> <args>` (`shoot ox oy oz dx dy dz`, `rotate dq`).
Deliver motion as MP4/GIF (animates in client; `Read` shows a still).
Tests: `cargo test -p house-game`. Goldens (MUST stay byte-identical):
`bin/golden   # auto-picks the Metal set on macOS`.

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
7. **Vulkan parity** — DONE for the SDF body (2026-07-02, see below) and the
   goo lights (they always were cross-platform: `append_goo_lights` + the
   `dir.w==2.0` cone path in shade.comp). Still Metal-only: the goo SHADOW
   proxies (mask 0x02 spheres in the TLAS) — on Vulkan the body casts no shadow.

## 2026-07-02 review round 2 (uncommitted, with the round-1 fixes)

- **Blob–blob contact repulsion** (`GOO_REPEL`/`_MAX`/`_SKIN`, `GooContact`,
  `goo_repel_at` in `goo.rs`): different blobs' particles softly repel within a
  contact skin, sampled against start-of-tick snapshots (symmetric, order-free);
  the spine ends feel it too, and a pressed head YIELDS (drive stalls, heading
  rotates off at 2× the AI turn rate — an equal rate is cancelled by the AI
  steer). Opt-outs: merge-compatible pairs, fusing blobs, tethered newborns
  (the nursery oracle pinned the birth choreography untouched). Behaviour test:
  `goo_overlapping_bodies_push_apart_not_through`.
- **`gait_profile` gather is seam-free** — smoothstep release (t 0.35→0.55) and
  pre-wrap rise (0.85→1.0) replace the two per-cycle force steps.
- **Render (Metal-only, NOT yet compiled)**: `goo.metal` gained screen-space
  refraction (pre-pass blit of radiance → `bgRad` buffer(6); never read
  `radiance` off-pixel — it races other threads' writes) and two-level SDF
  culling (per-blob bounding spheres from `goo_balls` → buffer(7), `dims.w` =
  blob count; a far blob contributes its bound distance via plain `min` — a
  safe under-estimate; `GOO_CULL_NEAR` must stay > smin k so cross-blob welds
  like the tether neck expand exactly). First Mac run must verify this plus the
  earlier vscale buffer(5) + specular glint.
- All four `goo_sim_hash_oracle_*` constants re-captured (dated comment in
  `game.rs` explains which change moved what).
- **Vulkan SDF composite port (same day)**: `rt-probe/src/shaders/goo.comp` is
  a line-for-line GLSL port of goo.metal (refraction, culling, specular,
  vscale, birth glow — keep the two in lockstep), compiled by rt-probe's
  build.rs and exported as `GOO_SPV`. `GooPush` + the shared look/limit
  constants moved to `crate::backend` (one source for both backends);
  vulkan_backend gained the pipeline, a `goo_bg` snapshot image (radiance is
  COPIED before the pass — the refraction's neighbour taps would race the
  in-place writes), and the pass between shade and tonemap. Verified live on
  the RTX 5080 (goopair/goonursery/goo/goofloor clips). `GOO_SDF=0` still
  selects the old opaque sphere-pool fallback. A new `goopair` film stage
  (two Larges spawned superimposed) demos the contact repulsion.

## Determinism + tuning gotchas (read before touching the sim/render)

- **The goo image goldens are all MOB-FREE** — they verify the goo code didn't
  perturb the *non-goo* path, but never exercise the goo sim's float results.
  The guard for goo float behaviour is the **`goo_sim_hash_oracle_*` tests**
  (`game.rs`): four pinned `state_hash` values (crawl+mitosis, nursery, split,
  merge). Any refactor that reorders a goo float fails these. If you change goo
  behaviour ON PURPOSE, re-capture the four constants and say why in the commit.
  The goo *render* path (SDF/shaders/lights/proxies) also isn't golden-covered —
  diff a `SCENE=goonursery … SHOT=` frame before/after a render-side change.
- `goo_system` is a thin orchestrator over verbatim per-tick sub-steps
  (`goo_step_fusing/_mitosis/_ai/_head_anchor/_tail_anchor`, `goo_pbf_lambda`/
  `_correct`, `goo_xsph_viscosity`, `goo_clamp_to_solids`). They are extracted
  to preserve float order EXACTLY — don't reorder/reassociate when editing.
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

## 2026-07-03 — Goo Arena pivot (arena shooter MVP)

The prototype pivoted to an arena shooter built on the goo (see
`SCENE=arena`): five weapons on keys 1–5 (slug / uzi / shotgun / grenade /
harpoon — data-driven `WeaponSpec`s + a `WeaponClass` damage-typing enum),
blob SPECIES (`GooKind`: Green baseline / red Runner / blue Tank) with
per-kind movement multipliers, per-class damage resistances and per-kind
render tint + light color, harpoon pinning (`Goo.pinned`/`pin_pt`), grenade
bounce + AoE (`explode`, `Res.boom` flash), and an arsenal-gated hash block
(`spec.arena`, the survival pattern).

- **Oracle recapture 2026-07-03**: the per-blob hash fold grew five fields
  (kind/cure/pinned/pin_pt) — all four `goo_sim_hash_oracle_*` constants
  recaptured once. Behavior on all-Green levels is bit-identical (Green
  multipliers are exact ×1.0; new fields default 0).
- ~~METAL LOCKSTEP DEBT~~ **CLEARED 2026-07-04**: `goo.metal` now has the
  tint twin (`tints` at buffer(8) — buffer(7) was already taken by the blob
  bounds — `goo_tint_at`, and the `pc.emis × tint` reweight before the
  birth-amber mix); `metal_backend` streams `FrameState.goo_tint` like
  glow/vscale. Species colours verified live on the M2 Pro (blue Tank / red
  Runner / green baseline), Metal goldens still byte-identical. The round-2
  render features (refraction, two-level culling, vscale, specular glint)
  also passed their first Mac run the same day.
- `Goo.cure` exists (hashed) but its behavior (slug solidify → dead chunks)
  lands in the next milestone.

## 2026-07-04 — player droid + weapon ring (rust branch)

The player is no longer a plain pillar: `game_scene::build_player_body` builds
a small ceramic "warden" droid (graphite base, white torso, amber emissive
power band, hovering visored head) as the named dynamic run "player";
`has_player` now keys off that run, not the legacy `dynamic_prim`. On arena
levels `build_gun` registers five "gun_N" runs (slug rifle / uzi / shotgun /
grenade drum / harpoon rail — distinct silhouettes, amber muzzle accents);
the shell renders the SELECTED slot's gun at the player rotated to
`snap.facing` (guns are authored aiming +Z at the muzzle-flash hand height),
others zero-scale. Metal `game`/`game_replay` goldens regenerated for the new
body. **Vulkan golden debt**: crates/rt-probe/golden/{game,game_replay}.png
are stale until regenerated on the spawner (RTX 5080).

## 2026-07-04 — goo intelligence (tactics, comms, arena architecture)

`game/tactics.rs` is the arena brain — composable, deterministic, RNG-free
(ID_HASH_STRIDE timing), arena-gated so the four goo oracles stand untouched:
LOS + a BFS flow field (0.125-wu grid from the player, derived cache in
`Res.nav`) + wall-corner cover points + timed sprints compose into
Direct / Flank / ToCover→Peek→Hide→Sprint / CoordWait / Sprint, selected by
per-species doctrine (Runners flank, Greens cover-ambush, Tanks anchor).
Comm pacts: two blobs with mutual LOS + player LOS agree a strike tick and
blink an accelerating hot-white pulse (body tint + cone light, `comm_pulse`)
until the synchronized rush. The arena gained thin-wall cover (mid-field L,
east flank wall) and a north wall with a 0.5625-wu squeeze slot — a Large
PBF body physically funnels through (`large_blob_squeezes_through` pins it).

Presentation: per-blob thinking bubbles (`hud.rs::bubble`, anchored via
`iso_core::world_to_window_px`) + the bottom weapon bar ride
`FramePresent::stamps`, burned into out_tex on Metal so DEMO/SHOT captures
show them. **Vulkan debt**: stamps (and the pre-existing minimap gap) are
not burned by vulkan_backend yet — TODO at the top of its render_present.

Ballistics fix: a projectile starting its tick INSIDE a blob's contact
sphere registers contact at t=0 (grenades used to bounce in and coast
through without detonating).

## 2026-07-04 — M1 "It can kill you" (Warden Pit direction, docs/gameplay-directions.md)

Arena levels now have a FAIL STATE. `Res.run: Option<RunState>` (arsenal
pattern, hashed under the arena gate): `integrity_system` (goo.rs, right
after goo_system) drains suit integrity per fluid particle overlapping the
player pillar — GOO_TOUCH_MARGIN (0.28) must exceed GOO_COLLIDER_MARGIN
(0.10), the wall clamp parks settled particles exactly at the collider
margin so a tighter band never fires. The pressing fluid also SHOVES the
droid (collide_and_slide, capped). Integrity 0 -> dead latch + PlayerDown
event: player verbs (Move/Click/Shoot/SelectWeapon) are swallowed, camera
ops stay live. HUD: HULL plate (green/amber/red) + centered CONTAINMENT
BREACHED panel (wave/bio/survived + SPACE prompt); Space rebuilds a fresh
GameLoop from the Viewer's stored spec clone (a new run is a new sim).

BIOMASS scoring replaced the old arena score: splits pay 0 (nothing left
the board), terminal kills pay the tier's mass (Large 4 / Medium 2 /
Small 1, `goo_tier_mass`), solidify pays 2x the net mass removed (body
minus escapee: Large +4, Medium +2). HUD label SC -> BIO.

Tests: engulf-death determinism (same death tick twice), downed-verb
lockout, biomass accounting. Oracles + goldens untouched (all fields
arena-gated). Next per the plan: M2 = wave-lull mutation draft + chunk-as-
cover + a minimal audio backend (AudioSink is still a stub).

## 2026-07-04 — M2: mutation draft, chunk cover, synth audio

- **Draft** (`game/draft.rs`): clearing the floor deals a 3-card hand for
  the wave lull — `deal(seed, wave)` through the Knuth stride (no RNG
  draws), 12-card pool of pure data deltas (WeaponSpec transforms + droid
  multipliers + hull regen). Keys Z/X/C -> `Command::PickCard`, trace op
  `card <1-3>`; picks are hashed (arsenal gate) and permanent;
  `apply_cards` mutates `current_weapon()` at read time; SERVO LEGS /
  PLATING / NANO REPAIR apply in walk_system / integrity_system. The hand
  expires when the next squad lands. HUD: amber card plates above the bar.
- **Chunks are cover**: `los_clear2(solids, chunks, ..)` — the knee-high
  corpses block goo-height sightlines, join `pick_cover` candidates, and
  gate doctrine rolls + comm pacts. The horde hides behind your masonry.
- **Audio** (`rt-viewer/src/audio.rs`): cpal + code-generated square/sine/
  noise voices — no asset files. GameLoop's sink is now `VecSink`; the
  viewer drains cues per frame (fail-soft `None` when headless/AUDIO=0)
  and plays a comm_blink tick on each pact-pulse rising edge. New cues:
  card_pick, player_down. Windowed sessions only; SHOT/DEMO stay silent.
- **HUD fit guard**: stamps auto-step their scale down when wider than the
  window (the widened bar at squeeze's old PIXEL=4 default clipped to
  nothing — negative-x stamps never draw); squeeze joined arena's PIXEL=2.

## 2026-07-04 — M3: blackout act, death reel, HOLD THE DRAIN, seeds

- **Blackout**: wave 3 (`LIGHTS_OUT_WAVE`) kills the lamps + snaps the
  torch on (LightsOut event/cue). New `FramePresent.sky_dim` scales the
  env sun/sky per frame; the viewer drives it from sim room_lights on
  open-studio scenes ONLY (game_replay ends lights-off — its golden must
  not move, and doesn't). The pit goes genuinely dark: goo glow + torch.
- **Death reel**: GameLoop journals every live-drained command; on the
  death tick the shell writes clips/last_run.txt (trace format via new
  `trace::format_command`, lossless round-trip incl. clickn) and V spawns
  record.sh to render clips/last_run.mp4 in the background.
- **HOLD THE DRAIN** (`SCENE=drain`): spec.drain zone + sieve wall (slit
  0.3125 / slot 0.5625 / main 1.25); non-Runner blobs descend a SECOND
  flow field seeded from the drain (Res.nav_drain) while Runners + pacts
  still hunt; `drain_system` despawns escapees into `Res.breach`
  (tier mass, hashed under the arsenal gate) — `BREACH_CAP` (16) latches
  the same death as integrity zero. HUD LEAK row (LKn/16, reddens past
  half). Tests: a lone Green escapes at a replay-exact tick; four Larges
  through the main drain end the run.
- **Seeds**: SEED env aliases CAVE_SEED; arena/drain specs take it (drafts
  + goo jitter already flow from spec.seed).

## 2026-07-04 — M4: the shift (drain = flagship; decision recorded)

Decision (docs/gameplay-directions.md M4): HOLD THE DRAIN subsumes the
pit — it is the flagship mode. Added the run ARC: clearing SHIFT_WAVES
(8) sets `RunState.won` (same latch family as dead; death_tick = end
tick), fires ShiftComplete (fanfare cue), locks the verbs, and shows the
green SHIFT COMPLETE panel (run_panel generalizes the death panel).
Space restarts; the reel saves on wins too. Bodies closing on the drain
telegraph with a cyan OUT! bubble (`MobRender.escaping`, derived within
2.5 wu of the zone). Emergent keeper: drain-marching Greens can still be
recruited into SYNC pacts mid-march and turn on the player.
