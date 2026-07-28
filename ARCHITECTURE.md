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
./                      # repo root IS the workspace root (post-pivot: the `rust` branch)
  Cargo.toml            # [workspace] members = ["crates/*"]
                        # [profile.release] debug = true  ← HOISTED (package-level profile ignored in workspace)
  crates/rt-probe/      # (A) renderer lib. deps: ash, glam, iso-core.
                        #   keeps: gpu.rs, render.rs, scene.rs, scenes.rs, shaders/, build.rs
                        #   loses: game.rs → house-game; iso.rs → iso-core (re-export shim
                        #          `pub mod iso { pub use iso_core::*; }`); src/bin/viewer/ → rt-viewer
                        #   gains: typed FrameState/SceneHandles surface (below)
                        #   sheds deps: winit, ash-window, raw-window-handle, font8x8 (move to rt-viewer)
  crates/
    iso-core/           # pure-math leaf. deps: glam only. Faza 1a: projection-as-data —
                        #   `Projection` (two integer ground-axis pixel images -> derived
                        #   camera basis/scale/pixel_basis/validator; presets iso21,
                        #   trimetric) + ViewXform unprojection (window_px_to_ground/_ray).
                        #   Plus two consts the inverse needs: PIXEL_CENTER_TIE (shade.comp's
                        #   1/64 px tie bias) and RAY_BACKOFF (fixed 64 wu pick-ray origin
                        #   backoff — ViewXform carries no scene bounds).
    sim-core/           # (B). deps: hecs, glam. Tick, FixedLoop (+ MAX_FRAME_DT = 0.1 s
                        #   clamp const), InputQueue<C>, Events<E>,
                        #   Pcg32, Simulation trait, Runner, AudioCue/AudioSink/VecSink/NullSink.
                        #   NO winit, NO ash, NO rt-probe. Public surface FROZEN to these items;
                        #   pinned by a re-export-list test. Game-flavored helpers stay in house-game
                        #   until a second game demands promotion (experiment→promote rule).
    house-game/         # (C). deps: sim-core, iso-core, glam. LevelSpec, components, systems,
                        #   Command, GameSnapshot, state_hash, flicker authoring, Level collision
                        #   (moved from rt-probe/src/game.rs), iso_input_dir, speed floor.
                        #   Plus a `headless` [[bin]]: plays a trace file N ticks → state digest
                        #   (plain-text format, trace.rs — no RON dep; one command per line).
    ide/                # the personal IDE ("pracownia", owner 2026-07-27): headless UI
                        #   model + CPU rasterizer for the 2x-density editor overlay.
                        #   deps: font8x8 only — knows neither the game nor the GPU;
                        #   boundary is plain data (SceneModel in, Edit out), and
                        #   rt-viewer/src/ide_host.rs is the ONLY adapter. Panels ride
                        #   the existing Stamp path (no GPU code of its own).
    phys-spike/         # throwaway Box3D rigid-body world (destructibility spike).
                        #   deps: glam only — no game, no GPU, no renderer. Its one
                        #   consumer is the shipped "wall smash" demo, through
                        #   rt-viewer/src/phys_scene.rs (the adapter, in the same
                        #   tradition as ide_host.rs).
    rt-viewer/          # shell. [[bin]] name = "viewer" (binary path: target/release/viewer).
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

Dependency arrows: `rt-viewer → {rt-probe, house-game, sim-core, iso-core, ide,
phys-spike}`; `house-game → {sim-core, iso-core}`; `rt-probe → {iso-core}`;
`sim-core → hecs`; `ide → {font8x8}` and `phys-spike → {glam}` (both leaves —
neither sees the game or the GPU).
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
pub struct FrameState<'a> {
    pub cam: iso_core::CamFrame,
    pub yaw_q: u32,                                  // dollhouse mask quarter
    pub room_lights: f32,                            // probe-bank lerp (instant GI switch)
    pub time: f32,                                   // SIM time, not wall clock
    pub light_emission: &'a [(LightKey, [f32; 3])],  // game-authored per-light rgb
    pub instances: &'a [(InstanceKey, Mat4)],        // movers → inst_buf + TLAS rebuild
}
impl SceneGpu { pub unsafe fn record_frame(&mut self, ctx:&Ctx, cmd: vk::CommandBuffer,
                                           fs:&FrameState<'_>); }
// Scene: place_dynamic(&mut self, cm, name, local: Mat4) -> usize  (dynamic_prim → Vec)
//        name_light(&mut self, name, prim)
```

**Step-8 reality notes (implemented):** `SceneHandles` lives at `SceneGpu.handles`.
The legacy `Scene.dynamic_prim` Option stays as a compat shim and merges into the
dynamic list as the named run **"player"** (start = `player_start`), so existing scenes
get an instance handle for free; `place_dynamic` bakes `local` as the pivot frame and
starts at identity. The NEE scan is factored into CPU-testable `scan_lights` (slot order
pinned without a GPU). `FrameState.yaw_q` is recorded but not yet consumed: dollhouse mask writes
stay event-driven (`set_yaw_masks`, which now marks the TLAS dirty) until the step-9 loop;
`record_frame` patches mover transforms only on bit-change (CPU shadow), so idle frames
never rebuild the TLAS.

### Render backends — `RenderBackend` trait (Vulkan + Metal)

The GPU half is swappable behind a `RenderBackend` trait (`rt-viewer/src/backend.rs`),
selected at compile time by target OS (`new_backend`). The `Viewer`
(`rt-viewer/src/viewer.rs`) owns the sim/camera/pan/harness orchestration and the
`Scene`, and drives the GPU exclusively through the trait — it never names a Vulkan or
Metal type. Everything crossing the boundary is plain data (`FrameState`,
`SceneHandles` — all Vulkan-free, in `rt-probe`) plus the small `FramePresent` /
`TonePush` bundles in `backend.rs`.

```
Viewer (sim loop, camera/pan, harness, FrameState builder)
  └── RenderBackend  ── #[cfg(target_os = "…")]
        ├── VulkanBackend  (rt-viewer/src/vulkan_backend.rs) — hardware ray_query (NVIDIA/desktop)
        └── MetalBackend   (rt-viewer/src/metal_backend.rs)  — Metal compute RT (Apple Silicon)
```

- **Why two backends, not MoltenVK:** MoltenVK still implements no ray tracing /
  acceleration structures (June 2026), so the Vulkan binary can't run on Apple Silicon at
  all. `MetalBackend` uses Metal's own `metal::raytracing::intersector` + an
  `MTLInstanceAccelerationStructure`, via `metal-rs` 0.33. Bindless geometry is the
  **concatenated scalar buffers + offset table** (indexed by `intersection.instance_id`),
  NOT `gpuAddress`. Scalar byte-match is load-bearing: `packed_float3` not `float3`
  (`Vertex` 32 B, `Material` 48 B asserted both sides).
- **Shaders:** the three GLSL compute shaders (`rt-probe/src/shaders/*.comp`, SPIR-V via
  `glslangValidator`) are hand-ported to MSL in `rt-viewer/src/shaders_metal/`
  (`shade.metal` + `probes.metal` + `tonemap.metal`), compiled at runtime with the driver
  compiler. `tonemap.metal` is the full stylized post stack (poster → bloom → tonemap →
  grade → shadow-dither → outline → vignette → grain → ordered-dither quantize).
- **Per-frame parity:** both backends preserve the exact intra-frame order — stream this
  frame's lights/materials → patch mover instance transforms → TLAS refit iff dirty →
  shade → tonemap (integer-NEAREST upscale) → present / readback. Dollhouse `set_yaw_masks`
  and mover transforms are event-driven (dirty bit), so idle frames never rebuild the TLAS.
- **Determinism + goldens:** each backend is bit-stable (a fixed camera gives bit-identical
  frames). Goldens are machine- AND backend-specific (GPU float behaviour differs):
  `bin/golden` (default `crates/rt-probe/golden`, Vulkan/RTX) takes a `GOLDEN_DIR` switch;
  the M2 Pro set lives in `crates/rt-probe/golden-metal`. The cross-platform invariant
  stays the `house-game` logical replay hashes (platform-independent).
- **Deps:** `metal` is a `[target.'cfg(target_os = "macos")']` dep so the Linux/NVIDIA
  build never sees it; `ash` stays common (it compiles on macOS — just doesn't run — so the
  Mac still compile-checks shared code).

**Step-9 reality notes (implemented):** the viewer's sim side is
`rt-viewer/src/sim.rs::GameLoop` (FixedLoop + InputQueue + HouseGame<NullSink> +
cached snapshot). The level is an INTERIM `mirror_spec(scene)` of the renderer
scene's collision fields (one room = floor rect, solids verbatim, no doors/
targets) until step 11 generates the scene from a real spec. Config seeding
(FLASH, YAW_Q, PLAYER_SPEED, PLAYER_X/Z) writes sim state DIRECTLY pre-tick
(+ `HouseGame::reseed()` re-derives caches) — world setup, not play — keeping
the pan→target→player-offset seeding order verbatim. **SHOT mode feeds the
fixed loop dt = 0**, so the wall clock NEVER ticks the sim; captures are pure
functions of (scene, config, CMDS trace), pinned by an assert at capture time.
`CMDS=trace.txt` (+ `CMDS_TICKS`, default last-stamp+1) replaces the WALK
wall-clock hack: a deterministic tick-stamped replay prefix run before the
first frame (house-game trace format). The follow-cam retargets ONLY when the
snapshot player position changed (startup parity with TARGET_X/Z overrides);
its whole-pixel/remainder behaviour is pinned by a unit test in sim.rs. The
'0' reset is camera-only now (player position is sim state; no teleport
command). The muzzle flash renders as a placeholder wide warm spotlight in the
second reserved slot. `q`/`e`/instant rotates queue `Command::RotateCamera`;
the ease is presentation-only and picks unproject at the settled quarter.

**Step-10 reality notes (implemented):** `compute_practicals` and its hue-kind
heuristic are GONE — `frame_lights_cpu` only applies `light_emission` (+ the
linked material) and packs the spotlight slots; slots not addressed keep their
previous values (initial = authored base). The transitional `FrameState.anim`
is deleted: LIGHT_ANIM=0 is now an ADAPTER freeze (emission = authored base
for lit lights), and LIGHT_ANIM=1 is replayable (flicker = house-game curves
at sim time, bit-equal to the old renderer curves by the stage-3 pin). The
renderer keeps ONE authored bit per light: `Scene::mark_screen(prim)` (device
screens stay at base in BOTH probe banks — the bake fill is inline in
`bake_probes`). Scenes must NAME every NEE light — emissive prims via
`name_light`, conceptual point lights via `name_point_light` (slots after all
emissive prims) — because the adapter (`mirror_lights`) asserts full coverage:
the game's flicker index (spec order) must equal the NEE slot. LIGHTS env =
master seed (0 boots dark) + a viewer-side dim multiplier on switchable
lights; the menu "lights" row is a Toggle routing `Command::ToggleRoomLights`
(env round-trip prints LIGHTS=0/1 — fractional dims are env-only until the
step-12 Config split).

**Reserved spotlight slots — DELETED 2026-07-28.** `Spotlight`, `SPOT_WARM`, the
`N_RESERVED` trailing slots (grown to 16 along the way), the shade-dispatch
`light_count + n_active` arithmetic and both twins' `dir.w == 2.0` cone branch are gone.
The flashlight that wrote them went with `view.rs::update_flashlight` (commit 4f8364c)
and nothing replaced it: the viewer's only call site passed `&[]`, so the reserved region
was 16 zeroed light records uploaded every frame and a shader branch no light could take.
The step-8/9/10 notes above and the muzzle-flash line below are HISTORY — they describe
the pre-reset thief/arena game. A future held light re-adds the region AND the probe-bake
exclusion in ONE change: the rule those two rode together (off-by-one leaks a moving
light into frozen GI) is the reason the arithmetic existed, and it still holds.

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
floor, contrasting door + target colors), not uniform grey. The directive won outright: the
glTF importer (`Scene::preload`/`place`) and the whole base-colour TEXTURE path it fed —
`LoadedImage`, `Scene.images`, `Material.tex_index`, `Vertex.uv`, both backends' bindless
image arrays and the four sampling branches in the shader twins — were DELETED 2026-07-28
after a year with zero callers. **There is no asset importer.** A textured prop is a new
feature, not a revival: it would have to re-earn its stride cost on both backends.

**Components:** `Pos`, `Facing`, `Player{speed_px}` (floored by
`recommended_min_px_per_sec(60)`), `WalkTarget`, `Flashlight{on}`,
`Pistol{cooldown_ticks}`, `Door{id, state: Closed|Opening(u32)|Open|Closing(u32)}` +
`DoorBody{hinge, axis, open_angle, anim_ticks, closed_solid}`, `Light{id, on, kind, base_rgb}`,
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
light but blended-average indirect. `room_lights = lit_fraction` of the SWITCHABLE
(non-screen) named lights — screens ignore the wall switch and their bounce is a
constant term in both probe banks, so they stay out of the lerp scalar.
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
  tick, audio-cues-exact, **replay_golden** (checked-in trace + pinned state_hash),
  determinism-two-runs-identical, snapshot-twice-side-effect-free.
  Land the determinism tests in the FIRST house-game commit, not last.
- **rt-probe:** existing 4 tests + scene-handles-no-reorder, record_frame CPU-half
  (lights_cpu mutation testable sans Vulkan), spotlight-packs-documented-12float.
  GPU truth stays **bin/golden** (bit-exact cmp of grid/lab/house SHOTs) — run after EVERY step.
- **rt-viewer:** thin; adapter name-join-reports-missing-loudly + a CMDS=trace.txt replay
  golden through the real loop (replaces the held-key WALK hack; WASD stays as a live
  Command::Move during migration).

## Migration steps (each leaves the build green: `cargo test` + `bin/golden` byte-identical)

**Status (2026-06-13): all 12 steps DONE and merged.** Both gates green at every
commit (cargo test 60: house_game 27, iso_core 11, rt_probe 7, viewer 6, sim_core 9;
`bin/golden` OK house/lab/grid/game/game_replay). Per-step deviations are recorded
inline below and in the step-reality-notes blocks above (steps 8/9/10). The list
is kept as the historical map; ☑ marks completion.

1. ☑ **Workspace**: native/Cargo.toml, hoist `[profile.release] debug=true`, update
   `bin/golden` + `bin/run` paths (`native/rt-probe/target/release/viewer` →
   `native/target/release/viewer`, `--manifest-path`). **Verify from a CLEAN build; delete
   the old `native/rt-probe/target/` in the same commit** (stale binary = vacuous gate).
2. ☑ **Move viewer** to crates/rt-viewer (`[[bin]] name="viewer"`), unchanged; rt-probe sheds
   winit/ash-window/raw-window-handle/font8x8 from its Cargo.toml. *Deviation: rt-viewer's
   Cargo.toml also carries ash/glam/png (the moved viewer code uses them first-hand); one
   forced line — tonemap SPIR-V `include_bytes!(OUT_DIR)` can't cross crates, so rt-probe
   exports `render::TONE_SPV` and renderer.rs consumes it.*
3. ☑ **Extract iso-core** (pure code motion + re-export shim in rt-probe).
4. ☑ **iso-core unprojection** (ViewXform, window_px_to_ground/ray + round-trip tests).
   *PIXEL_CENTER_TIE = 1/64, RAY_BACKOFF = 64 wu as specified.*
5. ☑ **sim-core** (full surface + tests). Pure addition. *Deviations: MAX_FRAME_DT is a pub
   const on the surface (not only an internal clamp); hecs is a curated 13-item re-export
   list (not `pub use hecs::*`), pinned by the public_api_snapshot test.*
6. ☑ **Move game.rs** → house-game (Level minus from_scene, iso_input_dir, speed floor);
   port update_motion collide-and-slide + flashlight pose as pure functions, unit-tested;
   rt-viewer switches imports, old call path intact. *collide_and_slide takes an abstract
   `blocked: impl Fn` closure (it runs against Level alone in the viewer and Level+DynSolids
   in walk_system).*
7. ☑ **Full game** in house-game (components, systems, snapshot, fixture, whole headless
   suite incl. replay_golden; flicker curves bit-compared against render.rs at sampled t
   BEFORE touching the renderer). *Deviations: trace format is plain text (trace.rs), not
   trace.ron (no serde/ron dep); DoorBody carries anim_ticks per-entity; flicker bit-compare
   used a standalone rustc oracle of the render.rs formula block (SceneGpu needs a live Ctx,
   so it couldn't be called CPU-side); door interact volume = CLOSED slab inflated 0.3 wu
   tested regardless of door state.*
8. ☑ **rt-probe typed surface** (SceneHandles, Spotlight×2 slots, FrameState, record_frame
   composing existing calls; place_dynamic generalization per the flag table). Then
   **invert inside the OLD viewer first**: draw() builds a FrameState from its own state
   and routes through record_frame while the old binary still lives — byte-parity proven
   BEFORE the loop moves (turns step 9 into delete-only). *See the step-8 reality notes
   above; transitional `FrameState.anim` added here (deleted at step 10); record_frame does
   NOT consume `FrameState.yaw_q` — masks stay event-driven via set_yaw_masks.*
9. ☑ **Sim loop in rt-viewer**: FixedLoop accumulator, winit→Command mapping, adapter,
   delete in-draw sim. Preserve Config seeding order (pan offset, target override, player
   offset) verbatim. Frame-2 SHOT capture must be provably sim-independent (assert zero
   ticks before capture or input-free bit-stable prefix). *See step-9 reality notes; SHOT
   feeds the FixedLoop dt=0 (sim-independence by construction); '0' reset is camera-only;
   HouseGame::reseed() added; LMB is click-to-walk (drag-pan kept for playerless scenes).*
10. ☑ **Flicker out of renderer**: compute_practicals shrinks to "apply FrameState
    .light_emission"; kind-from-hue heuristic deleted (kind comes from LevelSpec). *See
    step-10 reality notes; added Scene::name_point_light + Scene::mark_screen because every
    NEE light must be named/bank-authored once the hue heuristic dies.*
11. ☑ **Game content**: new scene built from LevelSpec (colored-greybox walls/doors/floors
    at tile-kit dimensions — NO textured tilesets; props as-is; named doors via
    place_dynamic, wall targets, named lights), NEW golden + CMDS replay golden; adapter asserts
    name-join completeness AND geometry consistency (door closed_solid matches the named
    prim's footprint). *Deviations: the game scene is a FIVE-room spec (`house_game::game_level`),
    built by `rt-viewer/src/game_scene.rs::build_game` (the LevelSpec→Scene greybox builder
    lives in the adapter, as the doc prescribes). Door leaves use `register_dynamic` over
    local boxes (not place_dynamic); lamps are point lights and the Screen is the only
    emissive prim, so slot order is Screen-then-lamps matching spec order; per-room floor
    tints + warm-perimeter/cool-interior walls; player_start in room E for a lit default
    view. DOOR_LEAF_H 1.71875 / WALL_TOP 2.1875 distinct from WALL_H 2.56. Two new goldens:
    `game` (lit spawn) + `game_replay` (dark, door open, score 2 — the CMDS replay end state,
    hash matches house-game's replay_game_golden 0xf3783d2d43fe4009).*
12. ☑ **Cleanup**: Config split RenderCfg/GameCfg/HarnessCfg (env-var names preserved —
    menu env_string round-trip is how dialed-in looks are saved), docs + memory updates.
    *`Config` composes the three sub-cfgs + the shared `scene` identity field (read by both
    the rt-probe scene builders and the viewer's game adapter); `lighting_env` forwards to
    RenderCfg, `default_player_speed` bridges scene+game. The ESC menu reads Renderer fields
    (not Config), so its env_string round-trip is unchanged by the split; pinned by
    `config::tests::env_string_round_trip`. rt-probe's lib.rs re-export surface trimmed to
    exactly what crosses the boundary (CamFrame/LightScan/frame_lights_cpu/
    mat_to_transform/ISO_*_DEG/iso_pixel_basis/iso_target are rt-probe-internal now; the
    `GpuTex` that used to head that list died with the texture path, 2026-07-28).*
