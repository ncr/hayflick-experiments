# Native ECS Game Foundation — Architecture

Status: BINDING design for the workspace split + ECS game loop. Synthesized 2026-06-12
from a 3-proposal judge panel over a full code-reading pass of rt-probe.
Implementers: follow this doc; deviations require updating this doc in the same commit.

## Goal

Three separated areas + two service abstractions, beside the existing deterministic
Vulkan renderer (`rt-probe`):

- **(A) Renderer** — `rt-probe` (exists). Stays deterministic + headless-golden-testable.
- **(B) Game-loop/ECS framework** — `sim-core`. Generic; no game content, no GPU, no window.
- **(C) Game code** — `house-game`. This specific game; runs and tests fully headless.
- **Input** — command-stream abstraction (tick-stamped, world-space, replayable).
- **Audio** — event/cue abstraction (`AudioSink` trait; real backend pluggable later).

Top priority: minimal public surfaces, nothing leaks across boundaries, everything
testable without a GPU. The game must run without the renderer.

## Workspace layout

```
native/
  Cargo.toml            # [workspace] members = ["rt-probe", "crates/*"]
                        # [profile.release] debug = true  ← HOISTED (package-level profile ignored in workspace)
  rt-probe/             # (A) renderer lib. deps: ash, glam, png, gltf, iso-core.
                        #   keeps: gpu.rs, render.rs, scene.rs, scenes.rs, shaders/, build.rs
                        #   loses: game.rs → house-game; iso.rs → iso-core (re-export shim
                        #          `pub mod iso { pub use iso_core::*; }`); src/bin/viewer/ → rt-viewer
                        #   gains: typed FrameState/SceneHandles/Spotlight surface (below)
                        #   sheds deps: winit, ash-window, raw-window-handle, font8x8 (move to rt-viewer)
  crates/
    iso-core/           # pure-math leaf. deps: glam only. iso.rs verbatim + ViewXform,
                        #   window_px_to_ground, window_px_to_ray unprojection. Plus two
                        #   consts the inverse needs: PIXEL_CENTER_TIE (shade.comp's 1/64 px
                        #   tie bias) and RAY_BACKOFF (fixed 64 wu pick-ray origin backoff —
                        #   ViewXform carries no scene bounds; ground hits are independent).
    sim-core/           # (B). deps: hecs, glam. Tick, FixedLoop (+ MAX_FRAME_DT = 0.1 s
                        #   clamp const), InputQueue<C>, Events<E>,
                        #   Pcg32, Simulation trait, Runner, AudioCue/AudioSink/VecSink/NullSink.
                        #   NO winit, NO ash, NO rt-probe. Public surface FROZEN to these items;
                        #   pinned by a re-export-list test. Game-flavored helpers stay in house-game
                        #   until a second game demands promotion (experiment→promote rule).
    house-game/         # (C). deps: sim-core, iso-core, glam. LevelSpec, components, systems,
                        #   Command, GameSnapshot, state_hash, flicker authoring, Level collision
                        #   (moved from rt-probe/src/game.rs), iso_input_dir, speed floor.
                        #   Plus a `headless` [[bin]]: plays a trace.ron N ticks → state digest.
    rt-viewer/          # shell. [[bin]] name = "viewer" (binary path stays native/target/release/viewer).
                        #   deps: rt-probe, house-game, sim-core, iso-core, winit, ash-window,
                        #   raw-window-handle, font8x8 + ash/glam/png (viewer code uses them
                        #   first-hand: vk types in renderer.rs, PNG encode in capture.rs).
                        #   Shaders stay in rt-probe (build.rs is per-crate): rt-probe exports
                        #   render::TONE_SPV for the viewer's swapchain tonemap pipeline.
                        #   Owns: winit loop, FixedLoop driver,
                        #   input mapping (winit → Command via iso-core unprojection), camera
                        #   presentation (RotAnim easing, follow-cam pan with whole-pixel
                        #   remainder carry), snapshot→FrameState adapter, scene builder from
                        #   LevelSpec (new scene only), ESC menu, capture/golden harness, NullSink.
```

Dependency arrows: `rt-viewer → {rt-probe, house-game, sim-core, iso-core}`;
`house-game → {sim-core, iso-core}`; `rt-probe → {iso-core}`; `sim-core → hecs`.
**rt-probe and house-game never see each other** — only rt-viewer's adapter knows both.
`cargo test -p house-game` runs the whole game headless in milliseconds.

## ECS: hecs, wrapped

hecs (~0.10) re-exported behind `sim_core` (house-game imports only `sim_core::*`).
No scheduler — `tick()` is a hand-written, source-ordered sequence of
`fn(&mut World, &mut Res)` calls. Determinism discipline (enforced by tests, not hope):

- All spawning iterates ordered `Vec`s from `LevelSpec` — never HashMap iteration on the game side.
- Structural changes (spawn/despawn) go through a command buffer applied at ONE fixed point per tick.
- Every ordered output (snapshot mover/light lists, audio cue order) is **sorted by StableId
  before emit** — insurance against archetype iteration-order drift.
- All gameplay randomness through a `Pcg32` resource seeded from `LevelSpec.seed`.
- Flicker stays **stateless hash(tick, seed)** noise (verbatim port of compute_practicals
  curves) — `snapshot()` is a pure read, never advances RNG; pinned by a
  snapshot-twice-is-side-effect-free test.

## Frame loop

Fixed timestep `TICK_DT = 1/60`. Shell runs the accumulator: per redraw
`n = fixed_loop.advance(real_dt.min(0.1))` (clamp pinned at 0.1 s by test); for each tick,
`drain_for(tick)` then `game.tick(t, &cmds)` — drain is **per tick**, not per batch
(live play and trace replay must agree; pinned by test). Then `snapshot()` → adapter →
`SceneGpu::record_frame`. No interpolation: presentation positions are lattice-snapped to
whole low-res pixels anyway; an idle frame re-renders the previous snapshot bit-identically.

Sim time `t = tick * TICK_DT` rides in `FrameState.time` and replaces the renderer's
wall-clock as the light-anim clock. Goldens use LIGHT_ANIM=0 (frozen) so they're safe;
LIGHT_ANIM=1 becomes replayable.

Headless: `sim_core::Runner::new(game).feed(trace).run_ticks(n)` — no window, no GPU,
no clock. `state_hash()` (FNV over canonical field order) is the equality oracle.
f32 determinism is same-machine/same-binary — replay hashes and PNG goldens are
machine-local artifacts; the CI-able layer is the logical headless assertions. Never wire
bit-exact goldens into CI without pinned hardware.

## Boundaries (the only things that cross)

### Renderer surface (rt-probe additions; game never sees Vulkan)

```rust
pub struct LightKey(u32);     // NEE slot, frozen at build — names map onto the EXISTING
pub struct InstanceKey(u32);  // emissive-scan order (no-reorder pinned by test)
pub struct SceneHandles { pub lights: BTreeMap<String, LightKey>,
                          pub instances: BTreeMap<String, InstanceKey> }
pub struct Spotlight { pub pos: Vec3, pub dir: Vec3, pub cone_cos: f32,
                       pub power: f32, pub radius: f32 }   // replaces raw [f32;12] writes
pub struct FrameState<'a> {
    pub cam: iso_core::CamFrame,
    pub yaw_q: u32,                                  // dollhouse mask quarter
    pub room_lights: f32,                            // probe-bank lerp (instant GI switch)
    pub time: f32,                                   // SIM time, not wall clock
    pub light_emission: &'a [(LightKey, [f32; 3])],  // game-authored per-light rgb
    pub spotlights: &'a [Spotlight],                 // ≤ N_RESERVED trailing NEE slots
    pub instances: &'a [(InstanceKey, Mat4)],        // movers → inst_buf + TLAS rebuild
}
impl SceneGpu { pub unsafe fn record_frame(&mut self, ctx:&Ctx, cmd: vk::CommandBuffer,
                                           fs:&FrameState<'_>); }
// Scene: place_dynamic(&mut self, cm, name, local: Mat4) -> usize  (dynamic_prim → Vec)
//        name_light(&mut self, name, prim)
```

**Reserved spotlight slots: N_RESERVED = 2** (flashlight + muzzle flash). The slot count,
the shade-dispatch arithmetic (`light_count + n_active`), and the probe-bake exclusion
(bake uses bare `light_count`) generalize TOGETHER — off-by-one leaks a spotlight into
frozen GI.

**Per-instance flag table** (write before generalizing `dynamic_prim → Vec`; the three
consumers currently keyed to the single Option):

| flag                  | player | door leaf |
|-----------------------|--------|-----------|
| NEE emissive-scan excl.| yes   | yes       |
| bake-ray mask (0x05 vs cull 0x0A) | excluded from bake | excluded from bake |
| dollhouse near-hide bits | never hidden | never hidden (doors sit inside, not on outward walls) |

`record_frame` preserves the existing intra-frame recording order and barriers
(practicals upload → TLAS rebuild-if-dirty → shade), and the bake-before-first-frame
coupling to `swap.scene_set` stays as-is.

### Input

```rust
// sim-core
pub struct Tick(pub u64);
pub struct InputQueue<C> { /* push(t, c); drain_for(t) -> Vec<C> in push order */ }
pub trait Simulation { type Command: Clone; type Snapshot;
    fn tick(&mut self, t: Tick, cmds: &[Self::Command]);
    fn snapshot(&self) -> Self::Snapshot;
    fn state_hash(&self) -> u64; }
pub struct FixedLoop { /* dt, accumulator, tick; advance(real_dt) -> u32 */ }

// house-game — picks arrive PRE-UNPROJECTED; semantic resolution happens IN the game
pub struct PickRay { pub origin: Vec3, pub dir: Vec3 }
pub enum Command {
    Click  { ray: PickRay, ground: Option<Vec2> },  // LMB: door-hit → UseDoor, else WalkTo
    Shoot  { ray: PickRay },                        // RMB
    Move   { dir: IVec2 },                          // WASD fallback (kept through migration)
    ToggleFlashlight, ToggleRoomLights,
    RotateCamera { dq: i8 },                        // quarter-turns are SIM state
}
```

**Camera/yaw determinism (resolved):** `yaw_q` (settled quarter) is **sim state**, changed
only by `Command::RotateCamera` — walk trajectory math (`screen_px_to_world` at yaw) and
all replay are therefore deterministic. RotAnim easing is presentation-only in rt-viewer;
**clicks during a tween unproject at the settled (target) yaw_q** — pinned by test.
`ground: Option<Vec2>` — clicks that unproject off the floor or outside the pan clamp:
game ignores the walk (no clamp-to-edge in v1).

### Audio

```rust
// sim-core
pub struct CueId(pub &'static str);  // "door_open", "door_close", "pistol_fire", "target_hit", "switch"
pub struct AudioCue { pub id: CueId, pub pos: Option<Vec3>, pub gain: f32 }
pub trait AudioSink { fn play(&mut self, cue: AudioCue); }
pub struct VecSink(pub Vec<AudioCue>);  // tests assert exact contents
pub struct NullSink;                    // rt-viewer default until a real backend (e.g. rodio) lands
```

Game's audio system maps domain events (`DoorOpened`, `TargetHit`, …) → cues into the
injected `&mut dyn AudioSink` per tick. Nothing else crosses.

## The game (house-game)

**LevelSpec** (ordered Vecs, single source of truth): rooms `{id, floor_rect}`, static
solids, doors `{id, hinge, axis_y, closed_solid, open_angle, anim_ticks, name}`, lights
`{id, room, kind: Incandescent|Screen|Drift, base_rgb, name}`, targets
`{id, center, normal, radius}`, `player_start`, `seed`. For the NEW game scene, LevelSpec
generates BOTH collision and visual geometry (builder lives in rt-viewer's adapter,
composing rt_probe::Scene from the spec) — kills the hand-synced solids-vs-walls
duplication. The three existing scenes (grid/lab/house) and their goldens stay
byte-untouched; the game gets a NEW scene + NEW golden.

**Greybox visuals (owner directive 2026-06-13): the game scene uses NO textured tile
GLBs for walls/doors/floors.** Walls, door leaves, floors are nicely colored greyboxes
(`add_box_world` / local-space boxes for door leaves) with **dimensions identical to the
tile-kit assets they replace** (read the dims from the kit placement code in scenes.rs /
the kit manifest — tile module = 1.28 wu; all XZ dims stay multiples of 0.0625 wu per the
iso stair-step invariant). Use a deliberate, cohesive palette (per-room wall tints, darker
floor, contrasting door + target colors), not uniform grey. **Forge props are kept as-is**
(textured GLBs via Scene::preload/place) for furnishing.

**Components:** `Pos`, `Facing`, `Player{speed_px}` (floored by
`recommended_min_px_per_sec(60)`), `WalkTarget`, `Flashlight{on}`,
`Pistol{cooldown_ticks}`, `Door{id, state: Closed|Opening(u32)|Open|Closing(u32)}` +
`DoorBody{hinge, axis, open_angle, closed_solid}`, `Light{id, on, kind, base_rgb}`,
`Target{id, hits}` + `TargetDisc{center, normal, radius}`.
Resources: `Level{floor, static_solids}`, `DynSolids`, `Score`, `Pcg32`,
`Events<GameEvent>`, `FlashPose`.

**System order in `tick()` (fixed, source-ordered):**
1. `resolve_commands` — Click: ray-vs-door interact volume (closed slab inflated 0.3 wu)
   → UseDoor; else WalkTo(ground) if on floor. Shoot → ShotIntent. Toggles. RotateCamera.
2. `door_system` — state machine on tick counters; **safety rule: refuses to re-insert the
   leaf solid while the player AABB overlaps it** (door can't trap the player); collision
   solid present iff not fully Open; emits DoorOpened/DoorClosed; rebuilds DynSolids.
3. `walk_system` — WalkTarget → iso screen-px velocity (speed floor) → world delta via
   `screen_px_to_world(dpx, yaw)` → per-axis collide-and-slide (the view.rs loop, moved
   verbatim); arrive (<1 px cell) or blocked-two-ticks → clear; update Facing.
4. `shoot_system` — cooldown-gated hitscan from muzzle along pick ray; first-occluder test
   (wall solids + closed-door solids at target height band) vs TargetDisc; hit →
   `hits+=1`, `Score+=1`, TargetHit; always ShotFired; arms a 2-tick muzzle-flash spotlight.
5. `flashlight_system` — FlashPose from Pos+Facing (view.rs hand-height/pitch math, moved).
6. `light_system` — per-light on/off (room master AND per-light) + flicker curves at sim
   time (stateless hash) → per-light rgb; master also yields the `room_lights` scalar.
7. `audio_system` — Events → AudioCue into the sink.

`snapshot()` → `GameSnapshot { player_pos (lattice-snapped), facing, flashlight,
muzzle_flash, doors: Vec<(DoorId, angle)>, lights: Vec<(LightId, rgb)>, room_lights,
yaw_q, score }` — all lists StableId-sorted.

**Known GI approximation (accepted for v1, documented):** the probe cache has exactly two
global banks (all-on/all-off) lerped by ONE scalar — per-room toggles get exact direct
light but blended-average indirect. `room_lights = lit_fraction` of named lights.
Per-room probe banks are a renderer follow-up if content review demands it.

## Test strategy (per crate)

- **iso-core:** 7 existing tests verbatim + unprojection round-trips at all four yaw
  quarters, **adversarial pan-remainder + render_scale>1 cases** (where one-pixel click
  drift hides).
- **sim-core:** FixedLoop tick/remainder/clamp, InputQueue ordering, Pcg32 pinned sequence,
  Runner replay-twice-same-hash, VecSink, **public-API snapshot test** (re-export list).
- **house-game:** fixture LevelSpec (3 rooms, 2 doors, 4 named lights, 3 targets);
  scenario tests: walk-reaches-click, slide-along-wall, closed-door-blocks /
  open-admits-after-anim-ticks, door-state-machine-tick-exact, door-cant-close-on-player,
  shot-hits-scores / miss / through-open-door / blocked-by-closed-door, cooldown-swallows-
  spam, flashlight-pose-tracks-facing, toggle-lights-zeroes-emission, flicker-bit-equal-at-
  tick, audio-cues-exact, **replay_golden** (checked-in trace.ron + pinned state_hash),
  determinism-two-runs-identical, snapshot-twice-side-effect-free.
  Land the determinism tests in the FIRST house-game commit, not last.
- **rt-probe:** existing 4 tests + scene-handles-no-reorder, record_frame CPU-half
  (lights_cpu mutation testable sans Vulkan), spotlight-packs-documented-12float.
  GPU truth stays **bin/golden** (bit-exact cmp of grid/lab/house SHOTs) — run after EVERY step.
- **rt-viewer:** thin; adapter name-join-reports-missing-loudly + a CMDS=trace.ron replay
  golden through the real loop (replaces the held-key WALK hack; WASD stays as a live
  Command::Move during migration).

## Migration steps (each leaves the build green: `cargo test` + `bin/golden` byte-identical)

1. **Workspace**: native/Cargo.toml, hoist `[profile.release] debug=true`, update
   `bin/golden` + `bin/run` paths (`native/rt-probe/target/release/viewer` →
   `native/target/release/viewer`, `--manifest-path`). **Verify from a CLEAN build; delete
   the old `native/rt-probe/target/` in the same commit** (stale binary = vacuous gate).
2. **Move viewer** to crates/rt-viewer (`[[bin]] name="viewer"`), unchanged; rt-probe sheds
   winit/ash-window/raw-window-handle/font8x8 from its Cargo.toml.
3. **Extract iso-core** (pure code motion + re-export shim in rt-probe).
4. **iso-core unprojection** (ViewXform, window_px_to_ground/ray + round-trip tests).
5. **sim-core** (full surface + tests). Pure addition.
6. **Move game.rs** → house-game (Level minus from_scene, iso_input_dir, speed floor);
   port update_motion collide-and-slide + flashlight pose as pure functions, unit-tested;
   rt-viewer switches imports, old call path intact.
7. **Full game** in house-game (components, systems, snapshot, fixture, whole headless
   suite incl. replay_golden; flicker curves bit-compared against render.rs at sampled t
   BEFORE touching the renderer).
8. **rt-probe typed surface** (SceneHandles, Spotlight×2 slots, FrameState, record_frame
   composing existing calls; place_dynamic generalization per the flag table). Then
   **invert inside the OLD viewer first**: draw() builds a FrameState from its own state
   and routes through record_frame while the old binary still lives — byte-parity proven
   BEFORE the loop moves (turns step 9 into delete-only).
9. **Sim loop in rt-viewer**: FixedLoop accumulator, winit→Command mapping, adapter,
   delete in-draw sim. Preserve Config seeding order (pan offset, target override, player
   offset) verbatim. Frame-2 SHOT capture must be provably sim-independent (assert zero
   ticks before capture or input-free bit-stable prefix).
10. **Flicker out of renderer**: compute_practicals shrinks to "apply FrameState
    .light_emission"; kind-from-hue heuristic deleted (kind comes from LevelSpec).
11. **Game content**: new scene built from LevelSpec (colored-greybox walls/doors/floors
    at tile-kit dimensions — NO textured tilesets; props as-is; named doors via
    place_dynamic, wall targets, named lights), NEW golden + CMDS replay golden; adapter asserts
    name-join completeness AND geometry consistency (door closed_solid matches the named
    prim's footprint).
12. **Cleanup**: Config split RenderCfg/GameCfg/HarnessCfg (env-var names preserved —
    menu env_string round-trip is how dialed-in looks are saved), docs + memory updates.
