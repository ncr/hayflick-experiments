//! The sim side of the viewer: a fixed-tick `house-game` loop plus the
//! snapshot→renderer adapter state (ARCHITECTURE.md step 9). This is the ONLY
//! place that knows both the game and the renderer — the game never sees
//! Vulkan, the renderer never sees commands; `GameSnapshot` → `FrameState` is
//! everything that crosses per frame.
//!
//! The level is spec-generated (game-content stage, step 11): one `LevelSpec`
//! drives both the renderer scene (`game_scene::build_game`) and the game's
//! collision fields, so click-to-walk collides against exactly what the eye
//! sees — by construction, not by mirroring.

use crate::viewer::Viewer;
use glam::{IVec2, Mat4, Vec2, Vec3};
use house_game::game::{Facing, Flashlight, Player, Pos};
use house_game::{parse_trace, Command, DoorId, GameSnapshot, HouseGame, LevelSpec, LightId, LightKind, LightSpec, RoomId, RoomSpec, TICK_DT};
use rt_probe::{screen_px_to_world, Config, InstanceKey, LightKey, Scene, SceneHandles};
use sim_core::{FixedLoop, InputQueue, NullSink, Simulation, Tick};

/// Vertical flatten applied to the goo metaballs so the body lies on the floor
/// as a spread puddle: the resting-height math `floor + radius·squash` is shared
/// by the CPU ball placement (`goo_balls`) AND the Metal proxy/shader squash, so
/// they MUST agree. Single source of truth — `metal_backend` imports these (it
/// is macOS-gated; `sim` always compiles, so the canonical home is here). A
/// `goo_render_consts_agree` test pins them.
pub(crate) const GOO_SQUASH: f32 = 0.74;
/// Floor plane Y (kit floorThickness 6 cm) — the goo's flat underside.
pub(crate) const GOO_FLOOR_Y: f32 = 6.0 / 128.0;

/// Per-door render binding: the renderer instance handle for the leaf, plus the
/// hinge + signed swing axis the per-frame transform needs (the snapshot gives
/// only the angle). Built from the spec's DoorSpecs joined onto the scene's
/// named dynamic instances.
pub struct DoorRender {
    pub id: DoorId,
    pub inst: InstanceKey,
    pub hinge: Vec3,
    pub axis_y: f32,
}

/// The viewer's game-loop state: the fixed-timestep accumulator, the
/// tick-stamped command queue, the running game, and the cached snapshot the
/// per-frame adapter reads.
pub struct GameLoop {
    pub fixed: FixedLoop,
    pub queue: InputQueue<Command>,
    pub sim: HouseGame<NullSink>,
    /// Next tick to simulate (includes any CMDS replay prefix).
    pub tick: Tick,
    /// Ticks consumed by the deterministic CMDS prefix at startup — the SHOT
    /// capture asserts the wall clock added NONE on top (sim-independence).
    pub cmds_prefix: u64,
    pub snap: GameSnapshot,
    /// Snapshot player position at the last follow-cam decision: the camera
    /// retargets only when the player actually MOVED (Config seeding parity:
    /// TARGET_X/Z and PLAYER_X/Z must not fight a startup retarget).
    pub last_player: Vec3,
    pub held: [bool; 4], // up, down, left, right
    /// The scene has a movable player marker: WASD/clicks drive the sim.
    /// Otherwise (lab) they pan the camera viewer-side — presentation only.
    pub has_player: bool,
    pub follow_cam: bool,
    /// Arena control scheme (`spec.arena`): LMB fires instead of walking
    /// (WASD is the only locomotion) and the OS cursor becomes a crosshair.
    pub lmb_shoots: bool,
    /// Per spec light, in slot order (spec index == NEE slot == game flicker
    /// index): the renderer key, the kind, and the authored base rgb — the
    /// per-frame emission build and the LIGHT_ANIM=0 freeze read these.
    pub light_keys: Vec<(LightKey, LightKind, [f32; 3])>,
    /// Per door: the leaf instance handle + hinge/axis for the swing transform.
    /// Empty for the interim mirror scenes (no doors); populated for SCENE=game.
    pub doors: Vec<DoorRender>,
    /// Reserved goo-blob ellipsoid pool handles ("goo_slot_N", in slot order).
    /// Empty unless the scene authored a goo pool (SCENE=goo). The adapter skins
    /// these onto the snapshot's live blob spine nodes each frame.
    pub goo_slots: Vec<InstanceKey>,
    /// Reserved projectile tracer instance slots ("proj_slot_N"), moved onto the
    /// live projectiles each frame; empty when the scene authored no pool.
    pub proj_slots: Vec<InstanceKey>,
    /// Reserved dead-chunk dome slots ("chunk_slot_N", arena scenes only).
    pub chunk_slots: Vec<InstanceKey>,
    /// Reserved bleed-droplet slots ("drop_slot_N", arena scenes only).
    pub drop_slots: Vec<InstanceKey>,
    /// Live render droplets (uzi bleed FX). PRESENTATION-ONLY: spawned off the
    /// event tap, advanced on the tick clock, never touches the sim.
    pub droplets: Vec<Droplet>,
    /// Render-side scatter counter for droplet spray directions (not sim RNG).
    drop_seed: u32,
    /// Presentation frame counter (advances with sim ticks) for the glitch FX.
    fx_frame: u32,
    /// Netcode-lag glitch cache: WEAK blobs render from a STALE body snapshot
    /// refreshed every ~8–15 ticks (per-id period), so a nearly-dead blob
    /// stutter-teleports while its true hitbox crawls on — aim at where it IS,
    /// not where it draws. Presentation-only (the sim never reads this).
    glitch: Vec<GlitchEntry>,
}

/// One weak blob's cached render body (see `GameLoop::glitch`).
struct GlitchEntry {
    id: house_game::MobId,
    parts: [Vec3; house_game::GOO_PARTICLES],
    vscale: f32,
    refreshed: u32,
}

/// One bleed droplet: a tiny glowing ball torn off a blob by uzi fire,
/// ballistic to the floor, gone in half a second.
/// Seconds a landed splat spends spreading/fading before it despawns.
const SPLAT_LIFE: f32 = 0.45;

pub struct Droplet {
    pub pos: Vec3,
    pub vel: Vec3,
    pub age: f32,
    /// <0 = airborne; >=0 = seconds since it hit the floor and became a
    /// flattening SPLAT (a widening puddle disc that fades out).
    pub splat: f32,
}

impl GameLoop {
    /// Interim mirror path (grid / lab / house): the level is reverse-derived
    /// from the renderer scene's collision fields + named lights (no doors /
    /// targets). The game scene uses [`GameLoop::from_spec`] instead.
    pub fn new(scene: &Scene, handles: &SceneHandles, light_count: u32, cfg: &Config) -> GameLoop {
        let lights = mirror_lights(scene, handles, light_count);
        let spec = mirror_spec(scene, &lights);
        let light_keys: Vec<_> = lights.into_iter().map(|(_, kind, base, key)| (key, kind, base)).collect();
        GameLoop::assemble(spec, scene, handles, light_keys, Vec::new(), cfg)
    }

    /// The SCENE=game path: the AUTHORED spec drives both the scene (built by
    /// `game_scene::build_game`) and the game. Joins the spec's lights onto the
    /// NEE slots IN SPEC ORDER (asserting the slot order equals the spec order,
    /// so the game's flicker index == the renderer slot) and binds each door's
    /// leaf instance handle. The light join + slot-order assert is the game
    /// analogue of `mirror_lights`' completeness check.
    pub fn from_spec(spec: LevelSpec, scene: &Scene, handles: &SceneHandles, light_count: u32, cfg: &Config) -> GameLoop {
        let light_keys = join_game_lights(&spec, handles, light_count);
        let doors = spec
            .doors
            .iter()
            .map(|d| {
                let inst = *handles.instances.get(&d.name).unwrap_or_else(|| panic!("game scene missing door instance {:?} — the builder must register_dynamic every spec door", d.name));
                DoorRender { id: d.id, inst, hinge: d.hinge, axis_y: d.axis_y }
            })
            .collect();
        GameLoop::assemble(spec, scene, handles, light_keys, doors, cfg)
    }

    /// Shared construction: seed the game from Config (DIRECT pre-tick state
    /// writes — world setup, not play), snapshot, and wire follow-cam.
    fn assemble(spec: LevelSpec, scene: &Scene, handles: &SceneHandles, light_keys: Vec<(LightKey, LightKind, [f32; 3])>, doors: Vec<DoorRender>, cfg: &Config) -> GameLoop {
        // discover the reserved goo ellipsoid + projectile tracer pools
        // ("goo_slot_N" / "proj_slot_N") in slot order — empty when the scene
        // authored no such pool.
        let goo_slots = discover_pool(handles, "goo_slot");
        let proj_slots = discover_pool(handles, "proj_slot");
        let chunk_slots = discover_pool(handles, "chunk_slot");
        let drop_slots = discover_pool(handles, "drop_slot");
        let mut sim: HouseGame<NullSink> = HouseGame::new(&spec, NullSink);
        if spec.arena.is_some() {
            // arena: tap the event stream for bleed droplets (observation-only;
            // pinned side-effect-free by the lab's recording test)
            sim.res.event_tap = Some(Vec::new());
        }
        // ---- Config seeding: DIRECT pre-tick state writes (world setup, not
        // play), then re-derive. Flashlight boot state, the camera quarter
        // (yaw_q is sim state), walk speed, the room-lights master (LIGHTS=0
        // boots dark; fractional LIGHTS stays a viewer-side dim), and the
        // default facing toward the camera at THAT yaw — the exact expression
        // the old viewer used.
        sim.world.get::<&mut Flashlight>(sim.player).unwrap().on = cfg.game.flash;
        sim.res.yaw_q = cfg.game.yaw_q;
        sim.res.master_lights = cfg.game.lights > 0.0;
        sim.world.get::<&mut Player>(sim.player).unwrap().speed_px = cfg.game.player_speed.unwrap_or(cfg.default_player_speed());
        let down = screen_px_to_world(Vec2::new(0.0, 1.0), 90.0 * cfg.game.yaw_q as f32);
        sim.world.get::<&mut Facing>(sim.player).unwrap().0 = Vec2::new(down.x, down.z).try_normalize().unwrap_or(Vec2::new(0.0, 1.0));
        sim.reseed();
        let snap = sim.snapshot();
        // a "player" dynamic run marks a playable scene: the game scenes
        // register the droid as a named multi-prim run; the legacy rt-probe
        // scenes still use `dynamic_prim` (merged in as "player" by
        // `dynamic_list`).
        let has_player = scene.dynamic_list().iter().any(|(n, ..)| n == "player");
        let lmb_shoots = spec.arena.is_some() && has_player;
        GameLoop {
            fixed: FixedLoop::new(TICK_DT),
            queue: InputQueue::new(),
            sim,
            tick: Tick(0),
            cmds_prefix: 0,
            last_player: snap.player_pos,
            snap,
            held: [false; 4],
            has_player,
            follow_cam: has_player && cfg.scene != "grid" && !crate::game_scene::is_goo_film_stage(&cfg.scene),
            lmb_shoots,
            light_keys,
            doors,
            goo_slots,
            proj_slots,
            chunk_slots,
            drop_slots,
            droplets: Vec::new(),
            drop_seed: 0,
            fx_frame: 0,
            glitch: Vec::new(),
        }
    }

    /// This frame's game-authored per-light emission, slot-aligned (the
    /// snapshot's LightId order IS the slot order — ids are assigned in spec
    /// order, which `mirror_lights` builds slot-sorted). `light_anim = false`
    /// freezes the flicker to base values while still honouring on/off
    /// (golden bit-stability: LIGHT_ANIM=0); `dim` is the LIGHTS env
    /// multiplier on switchable (non-screen) lights — exactly the old
    /// renderer-side dim semantics.
    pub fn light_emission(&self, light_anim: bool, dim: f32) -> Vec<(LightKey, [f32; 3])> {
        emission_frame(&self.snap.lights, &self.light_keys, light_anim, dim)
    }

    /// PLAYER_X/Z seeding: offset the player's continuous position pre-tick.
    /// The camera is NOT moved (`last_player` tracks the new spot) — headless
    /// capture tests rely on the displaced marker under a fixed camera.
    pub fn offset_player(&mut self, dx: f32, dz: f32) {
        {
            let mut p = self.sim.world.get::<&mut Pos>(self.sim.player).unwrap();
            p.0.x += dx;
            p.0.z += dz;
        }
        self.sim.reseed();
        self.snap = self.sim.snapshot();
        self.last_player = self.snap.player_pos;
    }

    /// CMDS=trace.txt: replay a tick-stamped command trace as a DETERMINISTIC
    /// startup prefix — the wall-clock WALK hack's replacement. Same plain-text
    /// format as house-game's headless bin; CMDS_TICKS overrides the length
    /// (default: last stamp + 1). `last_player` is deliberately left at its
    /// pre-trace value so a trace that walked the player triggers one follow
    /// retarget before the first frame (the camera shows the walk's result).
    pub fn run_cmds(&mut self, cfg: &Config) {
        let Some(path) = &cfg.game.cmds else { return };
        let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("CMDS {path}: {e}"));
        let trace = parse_trace(&text).unwrap_or_else(|e| panic!("CMDS: {e}"));
        let ticks = cfg.game.cmds_ticks.unwrap_or_else(|| trace.iter().map(|(t, _)| t.0 + 1).max().unwrap_or(0));
        let n_cmds = trace.len();
        for (t, c) in trace {
            self.queue.push(t, c);
        }
        for _ in 0..ticks {
            let cmds = self.queue.drain_for(self.tick);
            self.sim.tick(self.tick, &cmds);
            self.tick.0 += 1;
        }
        self.cmds_prefix = self.tick.0;
        self.snap = self.sim.snapshot();
        println!("CMDS: {n_cmds} commands over {ticks} ticks — state {:016x}", self.sim.state_hash());
    }

    /// DEMO=trace.txt: load the trace and queue every command at its stamp,
    /// returning the tick count to play (DEMO_TICKS override, else last stamp
    /// + 1). Unlike `run_cmds` (a startup PREFIX that runs all ticks before
    /// frame 0 with no per-frame output), DEMO leaves the queue loaded and the
    /// caller advances ONE tick per rendered frame via `demo_advance_tick`, so
    /// every tick of real gameplay becomes a captured frame.
    pub fn demo_load(&mut self, cfg: &Config) -> u64 {
        let path = cfg.harness.demo.as_ref().expect("demo_load only on DEMO path");
        let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("DEMO {path}: {e}"));
        let trace = parse_trace(&text).unwrap_or_else(|e| panic!("DEMO: {e}"));
        let ticks = cfg.harness.demo_ticks.unwrap_or_else(|| trace.iter().map(|(t, _)| t.0 + 1).max().unwrap_or(0));
        let n_cmds = trace.len();
        for (t, c) in trace {
            self.queue.push(t, c);
        }
        println!("DEMO: {n_cmds} commands, playing {ticks} ticks from {path}");
        ticks
    }

    /// Drain the current tick's queued commands, tick the sim once, refresh the
    /// snapshot. The per-tick command-drain mirrors `run_cmds`/`run_due` (the
    /// queue is the single source of truth for what the sim sees this tick), but
    /// runs on the render cadence (one call per drawn frame) instead of the wall
    /// clock — DEMO is a fixed-tick gameplay capture, not a perf trace.
    pub fn demo_advance_tick(&mut self) {
        let cmds = self.queue.drain_for(self.tick);
        self.sim.tick(self.tick, &cmds);
        self.tick.0 += 1;
        self.snap = self.sim.snapshot();
    }

    /// Advance the accumulator by a real frame delta and run the due ticks.
    /// Commands drain PER TICK (live play and trace replay must agree); held
    /// movement keys synthesize one `Command::Move` per tick (continuous
    /// walk). Refreshes the cached snapshot when anything ran.
    pub fn run_due(&mut self, real_dt: f32) -> u32 {
        let n = self.fixed.advance(real_dt);
        for _ in 0..n {
            if self.has_player {
                let dir = IVec2::new(self.held[3] as i32 - self.held[2] as i32, self.held[0] as i32 - self.held[1] as i32);
                if dir != IVec2::ZERO {
                    self.queue.push(self.tick, Command::Move { dir });
                }
            }
            let cmds = self.queue.drain_for(self.tick);
            self.sim.tick(self.tick, &cmds);
            self.tick.0 += 1;
        }
        if n > 0 {
            self.snap = self.sim.snapshot();
        }
        n
    }

    /// Queue a command for the next simulated tick.
    pub fn push(&mut self, c: Command) {
        self.queue.push(self.tick, c);
    }

    /// This frame's door leaf instance transforms: for each bound door, the
    /// snapshot's swing angle through `door_instance` (rotate about the hinge).
    /// record_frame patches each only on a bit-change, so idle doors never
    /// rebuild the TLAS.
    pub fn door_instances(&self) -> Vec<(InstanceKey, Mat4)> {
        self.doors
            .iter()
            .map(|dr| {
                let angle = self.snap.doors.iter().find(|(id, _)| *id == dr.id).map(|(_, a)| *a).unwrap_or(0.0);
                (dr.inst, crate::game_scene::door_instance(dr.hinge, dr.axis_y, angle))
            })
            .collect()
    }

    /// Per-frame goo blob instances: skin one emissive ellipsoid onto each live
    /// blob's particle nodes, then collapse every unused pool slot to zero
    /// scale (invisible). The Y scale (and the matching lift, so the lump
    /// stays grounded) tracks the blob's `vscale` — the same per-blob height
    /// breathing the SDF composite draws, so the fallback shows the gait
    /// flatten / jelly bounce too. Presentation-only — a pure read of the
    /// snapshot's hashed particle field; nothing here feeds back into the sim.
    pub fn goo_instances(&self) -> Vec<(InstanceKey, Mat4)> {
        let xforms = self.snap.mobs.iter().flat_map(|m| {
            let ry = m.part_radius * m.vscale;
            m.parts.iter().map(move |part| Mat4::from_translation(Vec3::new(part.x, ry, part.z)) * Mat4::from_scale(Vec3::new(m.part_radius, ry, m.part_radius)))
        });
        skin_pool(&self.goo_slots, xforms)
    }

    /// Per-frame projectile tracer instances: skin one small emissive sphere onto
    /// each live projectile (translate · uniform scale), collapsing every unused
    /// pool slot to zero scale. Pure read of the snapshot's hashed projectile
    /// state — the same instance-mover path the goo ellipsoids use.
    pub fn projectile_instances(&self) -> Vec<(InstanceKey, Mat4)> {
        let xforms = self.snap.projectiles.iter().map(|p| Mat4::from_translation(Vec3::new(p.pos.x, p.pos.y, p.pos.z)) * Mat4::from_scale(Vec3::splat(p.radius)));
        skin_pool(&self.proj_slots, xforms)
    }

    /// Per-frame dead-chunk instances: one squashed matte dome per solidified
    /// blob (translate to the rect centre, scale to its half-extents; the local
    /// unit sphere's lower half sinks under the floor). Pure snapshot read.
    pub fn chunk_instances(&self) -> Vec<(InstanceKey, Mat4)> {
        let xforms = self.snap.chunks.iter().map(|c| {
            let cx = (c[0] + c[2]) * 0.5;
            let cz = (c[1] + c[3]) * 0.5;
            let hx = (c[2] - c[0]) * 0.5;
            let hz = (c[3] - c[1]) * 0.5;
            Mat4::from_translation(Vec3::new(cx, 0.0, cz)) * Mat4::from_scale(Vec3::new(hx, house_game::GOO_CHUNK_H, hz))
        });
        skin_pool(&self.chunk_slots, xforms)
    }

    /// Advance the splash FX by `n` sim ticks: drain GooSplashed events from
    /// the tap into directional droplet sprays (count + speed scale with the
    /// hit's fluid punch), integrate ballistics, then let each droplet land as
    /// a widening floor SPLAT that fades. Tick-clocked (not wall-clocked) so
    /// DEMO captures stay reproducible. Presentation-only.
    pub fn tick_droplets(&mut self, n: u32) {
        self.fx_frame = self.fx_frame.wrapping_add(n);
        self.update_glitch();
        if let Some(tap) = self.sim.res.event_tap.as_mut() {
            for ev in tap.drain(..) {
                if let house_game::GameEvent::GooSplashed(_, at, dir, punch) = ev {
                    // spray budget: a pinprick sheds a couple of motes, a slug
                    // or point-blank volley tears off a real spray
                    let count = (3.0 + punch * 0.9).min(14.0) as u32;
                    let fwd = glam::Vec2::new(dir.x, dir.z).normalize_or_zero();
                    let side = glam::Vec2::new(-fwd.y, fwd.x);
                    for _ in 0..count {
                        self.drop_seed = self.drop_seed.wrapping_add(1);
                        let h = self.drop_seed.wrapping_mul(2654435761);
                        let r0 = (h & 0xff) as f32 / 255.0;
                        let r1 = ((h >> 8) & 0xff) as f32 / 255.0;
                        let r2 = ((h >> 16) & 0xff) as f32 / 255.0;
                        // mostly THROUGH the body along the shot, fanned to the
                        // sides — an exit spray, not a fountain
                        let xz = (fwd * (0.5 + r0 * 0.9) + side * (r1 - 0.5) * 1.3).normalize_or_zero() * (1.0 + punch * (0.18 + 0.12 * r2));
                        let up = 1.3 + r2 * 1.3 + punch * 0.06;
                        self.droplets.push(Droplet { pos: at + Vec3::new(0.0, 0.1, 0.0), vel: Vec3::new(xz.x, up, xz.y), age: 0.0, splat: -1.0 });
                    }
                }
            }
        }
        if n > 0 && !self.droplets.is_empty() {
            let dt = TICK_DT * n as f32;
            for d in self.droplets.iter_mut() {
                if d.splat < 0.0 {
                    d.vel.y -= 9.0 * dt;
                    d.pos += d.vel * dt;
                    d.age += dt;
                    // touchdown → become a floor splat (skip if it aged out)
                    if d.pos.y <= 0.03 && d.vel.y < 0.0 {
                        d.pos.y = 0.02;
                        d.splat = 0.0;
                    }
                } else {
                    d.splat += dt;
                }
            }
            self.droplets.retain(|d| if d.splat < 0.0 { d.age < 0.9 } else { d.splat < SPLAT_LIFE });
        }
    }

    /// Maintain the lag-glitch cache: every WEAK blob gets a cached body that
    /// only refreshes on its own ~8–15-tick period (id-hashed, so a pack of
    /// weak blobs never snaps in unison); healthy and dead blobs drop out.
    fn update_glitch(&mut self) {
        let frame = self.fx_frame;
        self.glitch.retain(|e| self.snap.mobs.iter().any(|m| m.id == e.id && m.weak));
        for m in &self.snap.mobs {
            if !m.weak {
                continue;
            }
            let period = 8 + ((m.id.0.wrapping_mul(2654435761) >> 28) % 8);
            match self.glitch.iter_mut().find(|e| e.id == m.id) {
                Some(e) => {
                    if frame.wrapping_sub(e.refreshed) >= period {
                        e.parts = m.parts;
                        e.vscale = m.vscale;
                        e.refreshed = frame;
                    }
                }
                None => self.glitch.push(GlitchEntry { id: m.id, parts: m.parts, vscale: m.vscale, refreshed: frame }),
            }
        }
    }

    /// Per-frame droplet instances: airborne motes are tiny glowing balls;
    /// landed ones flatten into widening, thinning puddle discs (the same
    /// sphere squashed to the floor) that vanish at SPLAT_LIFE.
    pub fn droplet_instances(&self) -> Vec<(InstanceKey, Mat4)> {
        let xforms = self.droplets.iter().map(|d| {
            if d.splat < 0.0 {
                Mat4::from_translation(d.pos) * Mat4::from_scale(Vec3::splat(0.045))
            } else {
                let t = (d.splat / SPLAT_LIFE).min(1.0);
                let r = 0.05 + t * 0.13; // spreads out...
                let h = 0.020 * (1.0 - t) + 0.004; // ...as it drains away
                Mat4::from_translation(d.pos) * Mat4::from_scale(Vec3::new(r, h, r))
            }
        });
        skin_pool(&self.drop_slots, xforms)
    }

    /// This frame's goo metaballs for the screen-space SDF composite, plus the
    /// parallel per-ball birth-glow and vertical-scale slices and the per-BLOB
    /// bounding spheres. One metaball per fluid particle — the solved fluid
    /// distribution IS the surface. Centres sit at the blob's flattened resting
    /// height (`floor + radius·squash·vscale`) so the shader's vertical squash
    /// and floor clamp settle each lump flat on the ground while the body
    /// breathes in height (gait lunge flattens, jelly wobble bounces, birth
    /// tension draws up — see `MobRender.vscale`). Each bound encloses its
    /// blob's whole merged surface — every ball plus its radius at the LARGEST
    /// axis scale, plus the outward smin bulge — so the shader's two-level
    /// march can trust it as a conservative distance proxy. Pure read of the
    /// hashed field.
    pub fn goo_balls(&self) -> (Vec<rt_probe::GooBall>, Vec<f32>, Vec<f32>, Vec<rt_probe::GooBall>, Vec<[f32; 4]>) {
        // Outward bulge of the smin union past the plain sphere union: at most
        // k/4 (k = the shader's GOO_SMIN_K 0.14 → 0.035), plus slack. A too-
        // generous margin only expands a blob's balls a step early — never a
        // visual change — so this need not track k exactly.
        const GOO_BOUND_MARGIN: f32 = 0.06;
        let mut out = Vec::new();
        let mut glow = Vec::new(); // PARALLEL to `out`: per-ball birth-glow 0..1
        let mut vscales = Vec::new(); // PARALLEL to `out`: per-ball vertical scale
        let mut bounds = Vec::new(); // one per BLOB (mob order = ball group order)
        let mut tints = Vec::new(); // PARALLEL to `out`: per-ball species tint
        for m in &self.snap.mobs {
            // species tint, desaturated toward a dull gray-teal as cure stacks
            // build (the visible "solidifying" read; full gray never quite hits)
            let kt = goo_kind_body_tint(m.kind);
            let k = (m.cure as f32 / house_game::GOO_CURE_MAX as f32) * 0.8;
            const GRAY: [f32; 3] = [0.55, 0.09, 0.26]; // × GOO_EMIS ≈ dull stone-teal
            let mut tint = [kt[0] + (GRAY[0] - kt[0]) * k, kt[1] + (GRAY[1] - kt[1]) * k, kt[2] + (GRAY[2] - kt[2]) * k, kt[3]];
            // comm-pact telegraph: flash the whole body toward a hot signal
            // white (deliberately NOT the amber birth tint) by the pulse —
            // both pact members share a strike tick, so they blink in sync.
            if m.comm > 0.0 {
                const FLASH: [f32; 3] = [2.6, 2.9, 3.4];
                for (t, f) in tint.iter_mut().zip(FLASH) {
                    *t += (f - *t) * m.comm;
                }
            }
            // netcode-lag glitch: a WEAK blob renders its CACHED body (the true
            // hitbox crawls on — shots resolve against the sim, not the draw),
            // dimming as the snapshot ages so the pop-forward reads as a stutter
            // and not a renderer bug.
            let (parts, vscale) = match self.glitch.iter().find(|e| e.id == m.id) {
                Some(e) if m.weak => {
                    let stale = self.fx_frame.wrapping_sub(e.refreshed) as f32;
                    let dim = (1.0 - 0.04 * stale).max(0.55);
                    tint = [tint[0] * dim, tint[1] * dim, tint[2] * dim, tint[3]];
                    (&e.parts, e.vscale)
                }
                _ => (&m.parts, m.vscale),
            };
            let pr = m.part_radius;
            let y = GOO_FLOOR_Y + pr * GOO_SQUASH * vscale;
            let mut c = Vec3::ZERO;
            for p in parts.iter() {
                c += *p;
            }
            let c = c / parts.len() as f32;
            // enclosing-sphere radius of one squashed ball: the ellipsoid's
            // largest semi-axis (horizontal pr, or vertical pr·squash·vscale —
            // the jelly wobble can bulge the body above neutral)
            let ball_r = pr * (GOO_SQUASH * vscale).max(1.0);
            let mut reach = 0.0f32;
            for p in parts.iter() {
                let dx = p.x - c.x;
                let dz = p.z - c.z;
                reach = reach.max((dx * dx + dz * dz).sqrt());
            }
            bounds.push(rt_probe::GooBall { center: [c.x, y, c.z], radius: reach + ball_r + GOO_BOUND_MARGIN });
            for (p, &gl) in parts.iter().zip(m.glow.iter()) {
                out.push(rt_probe::GooBall { center: [p.x, y, p.z], radius: pr });
                glow.push(gl);
                vscales.push(vscale);
                tints.push(tint);
            }
        }
        (out, glow, vscales, bounds, tints)
    }

    /// One real RT light per live blob (streamed into reserved NEE slots), so
    /// the goo genuinely illuminates the scene and casts ray-traced shadows. A
    /// wide downward green cone sitting just above each blob's centroid: it
    /// pools green light on the floor around the body and — via the shade pass's
    /// per-light shadow rays — the player pillar, walls, and (with the goo proxy
    /// geometry) the blobs themselves cast real shadows. Presentation-only:
    /// a pure read of the snapshot, never baked into the static GI probes.
    pub fn goo_lights(&self) -> Vec<rt_probe::Spotlight> {
        const LIFT: f32 = 0.40; // light height above the floor (wu)
        // Wide downward green cone. Power = base + per-radius boost, so bigger
        // blobs glow a touch brighter; the area-light radius (the shade pass
        // reads posRad.w) tracks the body size and drives the soft-shadow
        // penumbra. The tint is FIXED so the pool colour never flickers.
        const POWER_BASE: f32 = 9.0;
        const POWER_PER_RADIUS: f32 = 3.0;
        const CONE_DEG: f32 = 115.0;
        const SHADOW_RADIUS_FRAC: f32 = 0.8;
        const SHADOW_RADIUS_MIN: f32 = 0.25;
        // per-species pool colour (matches the body tint mapping below)
        let mut out = Vec::with_capacity(self.snap.mobs.len());
        for m in &self.snap.mobs {
            if m.parts.is_empty() {
                continue;
            }
            let c = m.centroid();
            let centroid = Vec3::new(c.x, LIFT, c.z);
            // the comm blink also drives the floor pool: brighter and pulled
            // toward white while signalling (readable even when the body is
            // partly behind cover — which is exactly when pacts happen)
            let power = (POWER_BASE + POWER_PER_RADIUS * m.radius) * (1.0 + 1.4 * m.comm);
            let mut tint = goo_kind_light_tint(m.kind);
            for t in tint.iter_mut() {
                *t += (1.0 - *t) * (0.7 * m.comm);
            }
            out.push(rt_probe::Spotlight {
                pos: centroid,
                dir: Vec3::new(0.0, -1.0, 0.0),
                cone_cos: CONE_DEG.to_radians().cos(),
                power,
                radius: (m.radius * SHADOW_RADIUS_FRAC).max(SHADOW_RADIUS_MIN),
                tint,
            });
        }
        out
    }

    /// Sim time for `FrameState.time` — ticks, never the wall clock.
    pub fn time(&self) -> f32 {
        self.tick.0 as f32 * TICK_DT
    }
}

/// Species → body-emissive tint: a channel-wise multiplier on the shader's
/// green GOO_EMIS, REWEIGHTED so the product is genuinely red/blue (the base
/// is green-heavy — a naive red multiplier would land on orange). Green is
/// exactly white = the historical look, bit-identical.
fn goo_kind_body_tint(kind: house_game::GooKind) -> [f32; 4] {
    match kind {
        house_game::GooKind::Green => [1.0, 1.0, 1.0, 1.0],
        // GOO_EMIS (0.55, 3.3, 1.15) × this ≈ (3.5, 0.6, 0.5) — hot red
        house_game::GooKind::Runner => [6.4, 0.18, 0.43, 1.0],
        // × this ≈ (0.45, 1.15, 4.0) — deep blue
        house_game::GooKind::Tank => [0.8, 0.35, 3.5, 1.0],
    }
}

/// Species → floor-pool light colour (the per-blob cone in `goo_lights`).
fn goo_kind_light_tint(kind: house_game::GooKind) -> [f32; 3] {
    match kind {
        house_game::GooKind::Green => [0.32, 1.0, 0.5], // the historical green
        house_game::GooKind::Runner => [1.0, 0.22, 0.28],
        house_game::GooKind::Tank => [0.25, 0.45, 1.0],
    }
}

/// Discover a reserved named instance pool ("<prefix>_0", "<prefix>_1", …) in
/// slot order, stopping at the first gap. Empty when the scene authored no pool.
/// Shared by the goo-ellipsoid and projectile-tracer slot discovery.
fn discover_pool(handles: &SceneHandles, prefix: &str) -> Vec<InstanceKey> {
    let mut slots: Vec<InstanceKey> = Vec::new();
    while let Some(&k) = handles.instances.get(&format!("{prefix}_{}", slots.len())) {
        slots.push(k);
    }
    slots
}

/// Skin an ordered pool of reserved instance slots onto a stream of per-item
/// transforms: fill the slots in order from `xforms`, then collapse every
/// leftover slot to zero scale (invisible). Transforms beyond the pool size are
/// dropped (the pool caps how many items draw at once). Shared by the
/// goo-ellipsoid and projectile-tracer movers — a pure read of the snapshot.
fn skin_pool(slots: &[InstanceKey], mut xforms: impl Iterator<Item = Mat4>) -> Vec<(InstanceKey, Mat4)> {
    slots.iter().map(|&slot| (slot, xforms.next().unwrap_or_else(|| Mat4::from_scale(Vec3::ZERO)))).collect()
}

/// Join the scene's named lights (emissive prims + conceptual point lights)
/// onto their frozen NEE slots, returned in SLOT order: (name, kind, base
/// rgb, key). The game's flicker index is the spec order, which must equal
/// the renderer slot for the curves to line up — so EVERY slot must be named
/// (the adapter reports a gap loudly instead of letting a light silently
/// freeze at base). Kinds: marked screens → Screen, other prims →
/// Incandescent, conceptual points → Drift — the renderer's old hue-kind
/// assignments, now authored.
pub fn mirror_lights(scene: &Scene, handles: &SceneHandles, light_count: u32) -> Vec<(String, LightKind, [f32; 3], LightKey)> {
    assert!(
        handles.lights.len() == light_count as usize,
        "adapter name-join incomplete: {} named lights over {} NEE slots — name every emissive prim / point light in the scene builder so game flicker indices match renderer slots",
        handles.lights.len(),
        light_count
    );
    let mut by_slot: Vec<(&String, LightKey)> = handles.lights.iter().map(|(n, &k)| (n, k)).collect();
    by_slot.sort_by_key(|&(_, k)| k);
    by_slot
        .into_iter()
        .map(|(name, key)| {
            if let Some(&(_, prim)) = scene.named_lights.iter().find(|(n, _)| n == name) {
                let e = scene.materials[scene.primitives[prim].material_id as usize].emissive;
                let kind = if scene.screen_prims.contains(&prim) { LightKind::Screen } else { LightKind::Incandescent };
                (name.clone(), kind, [e[0], e[1], e[2]], key)
            } else if let Some(&(_, idx)) = scene.named_point_lights.iter().find(|(n, _)| n == name) {
                let p = scene.point_lights[idx];
                (name.clone(), LightKind::Drift, [p[4], p[5], p[6]], key)
            } else {
                unreachable!("SceneHandles light {name:?} missing from the scene's name lists")
            }
        })
        .collect()
}

/// SCENE=game light join: walk the AUTHORED spec lights IN ORDER, look each
/// name up in the scene's NEE slot table, and return (key, kind, base) in spec
/// order. Asserts (a) full coverage — every NEE slot is a named spec light and
/// vice versa, and (b) the slot order EQUALS the spec order, so the game's
/// flicker index (spec order) is the renderer slot. A mismatch means the
/// builder placed lights out of spec order (or named the wrong prim).
pub fn join_game_lights(spec: &LevelSpec, handles: &SceneHandles, light_count: u32) -> Vec<(LightKey, LightKind, [f32; 3])> {
    assert!(
        handles.lights.len() == light_count as usize && light_count as usize == spec.lights.len(),
        "game light join incomplete: {} named NEE slots, {} NEE slots, {} spec lights — name every emissive prim in spec order in build_game",
        handles.lights.len(),
        light_count,
        spec.lights.len()
    );
    let mut prev: Option<LightKey> = None;
    spec.lights
        .iter()
        .map(|l| {
            let key = *handles.lights.get(&l.name).unwrap_or_else(|| panic!("spec light {:?} has no NEE slot — build_game must name_light it", l.name));
            assert!(prev.map_or(true, |p| key > p), "spec light {:?} slot {key:?} is out of spec order (prev {prev:?}) — the builder must place lights in spec order so flicker index == NEE slot", l.name);
            prev = Some(key);
            (key, l.kind, l.base_rgb)
        })
        .collect()
}

/// Per-frame emission build, free-fn form for tests: snapshot light rgb →
/// (LightKey, rgb) in slot order, with the LIGHT_ANIM=0 freeze (base value
/// when lit, dark stays dark) and the LIGHTS dim on non-screen lights.
pub fn emission_frame(snap_lights: &[(LightId, [f32; 3])], keys: &[(LightKey, LightKind, [f32; 3])], light_anim: bool, dim: f32) -> Vec<(LightKey, [f32; 3])> {
    snap_lights
        .iter()
        .zip(keys)
        .map(|((_id, rgb), &(key, kind, base))| {
            let rgb = if light_anim {
                *rgb
            } else if *rgb != [0.0; 3] {
                base // frozen: lit lights at authored base, exactly LIGHT_ANIM=0 of old
            } else {
                [0.0; 3]
            };
            let s = if kind == LightKind::Screen { 1.0 } else { dim }; // devices ignore the dim
            (key, [rgb[0] * s, rgb[1] * s, rgb[2] * s])
        })
        .collect()
}

/// INTERIM level spec: mirror the renderer scene's collision fields (one room
/// = the floor rect, scene solids verbatim, no doors/targets) + the named
/// lights in slot order. The content stage replaces this with a spec that
/// GENERATES the scene instead.
pub fn mirror_spec(scene: &Scene, lights: &[(String, LightKind, [f32; 3], LightKey)]) -> LevelSpec {
    LevelSpec {
        rooms: vec![RoomSpec { id: RoomId(0), floor_rect: scene.floor_rect }],
        static_solids: scene.solids.clone(),
        doors: Vec::new(),
        lights: lights.iter().enumerate().map(|(i, (name, kind, base, _))| LightSpec { id: LightId(i as u32), room: RoomId(0), kind: *kind, base_rgb: *base, name: name.clone() }).collect(),
        targets: Vec::new(),
        items: Vec::new(), // survival is per-level opt-in; the mirror spec leaves it off
        survival: None,
        mobs: Vec::new(), // mobs are authored per-level; the mirror scenes have none
        traps: Vec::new(),
        arena: None,
        player_start: scene.player_start,
        seed: 42,
    }
}

impl Viewer {
    /// Follow-cam: when the (lattice-snapped) player moved, retarget the
    /// camera at it. The whole-low-pixel step with carried remainder (#5)
    /// is inherent in the lattice snap: consecutive snapped positions differ
    /// by INTEGER screen-pixel steps while the player's continuous position
    /// carries the sub-pixel remainder — pinned by
    /// `follow_cam_steps_whole_pixels_and_carries_the_remainder` below.
    pub fn follow_camera(&mut self) {
        if !self.game.follow_cam || self.game.snap.player_pos == self.game.last_player {
            return;
        }
        let t = self.game.snap.player_pos;
        self.game.last_player = t;
        self.retarget(t);
        self.recenter_pan();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::viewer::shot_sim_dt;
    use rt_probe::iso::{iso_basis, snap_ground_to_lattice, ISO_R};

    /// SHOT mode selects dt = 0 regardless of the wall-clock delta — the pure
    /// selection that `draw()` makes before feeding the fixed loop. This pins
    /// the "provably sim-independent" capture claim (ARCHITECTURE step 9) at
    /// the CPU/`cargo test` level instead of leaning only on the GPU-path
    /// runtime assert in `capture.rs` (which fires only inside `bin/golden`).
    #[test]
    fn shot_mode_feeds_zero_dt() {
        for dt in [0.0, 1.0 / 60.0, 0.1, 1.0, 9999.0] {
            assert_eq!(shot_sim_dt(true, dt), 0.0, "SHOT must feed dt=0 (wall clock got {dt})");
            assert_eq!(shot_sim_dt(false, dt), dt, "live mode passes the wall clock through");
        }
    }

    /// Feeding the fixed loop dt = 0 (what SHOT mode does every frame) runs
    /// ZERO ticks and leaves the tick counter pinned at the CMDS prefix — so a
    /// SHOT capture is a pure function of (scene, config, CMDS prefix). This is
    /// the sim-independence guarantee the GPU-path assert
    /// (`tick.0 == cmds_prefix`) checks, proven here without Vulkan: a
    /// regression that ran wall-clock ticks under SHOT would fail this test.
    #[test]
    fn run_due_zero_dt_adds_no_ticks() {
        std::env::set_var("SCENE", "lab"); // a playerless mirror scene → no Move synth
        let cfg = Config::from_env();
        let scene = lit_scene();
        let (handles, light_count) = lit_handles(&scene);
        let mut game = GameLoop::new(&scene, &handles, light_count, &cfg);
        // simulate a CMDS prefix having run (set tick == cmds_prefix, as run_cmds does)
        game.tick = Tick(5);
        game.cmds_prefix = 5;
        let before = game.sim.state_hash();
        for dt in [0.0f32, 0.0, 0.0] {
            let n = game.run_due(dt);
            assert_eq!(n, 0, "dt=0 must advance no ticks");
        }
        assert_eq!(game.tick.0, game.cmds_prefix, "tick must stay pinned at the CMDS prefix under dt=0");
        assert_eq!(game.sim.state_hash(), before, "dt=0 must not mutate sim state");
    }

    #[test]
    fn follow_cam_steps_whole_pixels_and_carries_the_remainder() {
        // A 60 fps walk advances ~2.33 screen px per tick (a non-integer): the
        // FOLLOWED position (the lattice snap of the continuous pos — exactly
        // what `follow_camera` retargets at, via snapshot.player_pos) must
        // advance in WHOLE screen pixels every tick while staying within half
        // a pixel cell of the continuous path: the remainder is carried by
        // the continuous position, never lost and never accumulating drift.
        let yaw = 0.0;
        let (_d, right, up) = iso_basis(yaw);
        let px = |p: Vec3| Vec2::new(p.dot(right) * ISO_R, -p.dot(up) * ISO_R);
        // the iso 2:1 diagonal at 140 px/s, one 60 Hz tick per step
        let dpx = Vec2::new(2.0 / 5.0f32.sqrt(), -1.0 / 5.0f32.sqrt()) * (140.0 / 60.0);
        let step = screen_px_to_world(dpx, yaw);
        let mut p = Vec3::new(4.0, 0.046875, 6.0); // house spawn (y = FLOOR_TOP)
        let mut prev = snap_ground_to_lattice(p, yaw);
        for i in 0..1000 {
            p += step;
            let s = snap_ground_to_lattice(p, yaw);
            let d = px(s) - px(prev);
            assert!((d.x - d.x.round()).abs() < 1e-2 && (d.y - d.y.round()).abs() < 1e-2, "step {i}: non-integer camera step {d:?}");
            let err = px(s) - px(p);
            assert!(err.x.abs() <= 0.5 + 1e-2 && err.y.abs() <= 0.5 + 1e-2, "step {i}: remainder drifted {err:?}");
            assert_eq!(s.y, p.y, "the snap must stay on the player's ground plane");
            prev = s;
        }
    }

    /// A small named-lights scene: warm box (slot 0), marked screen (slot 1),
    /// named conceptual point (slot 2). Names sort AGAINST slot order so a
    /// name-ordered join would flip everything.
    fn lit_scene() -> Scene {
        let mut scene = Scene::new();
        scene.floor_rect = [-2.5, -1.0, 16.5, 12.0];
        scene.solids = vec![[0.0, 0.0, 1.0, 1.0], [3.0, 4.0, 5.0, 6.5]];
        scene.player_start = Vec3::new(4.0, 0.046875, 6.0);
        scene.add_box_world(Vec3::ZERO, Vec3::new(0.25, 0.5, 0.25), [1.0; 4], [9.0, 6.0, 3.0, 1.0], 0.6, 0.0);
        scene.name_light("zz_warm", 0);
        scene.add_box_world(Vec3::new(1.0, 0.4, 1.0), Vec3::new(1.4, 1.0, 1.03), [0.1, 0.3, 0.25, 1.0], [3.0, 12.0, 9.6, 1.0], 0.8, 0.0);
        scene.name_light("mm_screen", 1);
        scene.mark_screen(1);
        scene.point_lights.push([1.0, 2.0, 3.0, 0.25, 5.0, 4.0, 3.0, 0.0]);
        scene.name_point_light("aa_ceiling", 0);
        scene
    }

    fn lit_handles(scene: &Scene) -> (rt_probe::SceneHandles, u32) {
        let scan = rt_probe::scan_lights(scene).unwrap();
        (rt_probe::SceneHandles { lights: scan.names, instances: Default::default() }, scan.light_count)
    }

    #[test]
    fn mirror_spec_carries_the_scene_collision_and_slot_ordered_lights() {
        let scene = lit_scene();
        let (handles, light_count) = lit_handles(&scene);
        let lights = mirror_lights(&scene, &handles, light_count);
        // slot order, NOT name order: warm prim, screen prim, then the point
        let want = [("zz_warm", LightKind::Incandescent, [9.0, 6.0, 3.0]), ("mm_screen", LightKind::Screen, [3.0, 12.0, 9.6]), ("aa_ceiling", LightKind::Drift, [5.0, 4.0, 3.0])];
        for (i, (name, kind, base)) in want.iter().enumerate() {
            assert_eq!(lights[i].0, *name, "slot {i}");
            assert_eq!(lights[i].1, *kind);
            assert_eq!(lights[i].2, *base);
        }
        let spec = mirror_spec(&scene, &lights);
        assert_eq!(spec.rooms.len(), 1);
        assert_eq!(spec.rooms[0].floor_rect, scene.floor_rect);
        assert_eq!(spec.floor_bounds(), scene.floor_rect);
        assert_eq!(spec.static_solids, scene.solids);
        assert_eq!(spec.player_start, scene.player_start);
        assert!(spec.doors.is_empty() && spec.targets.is_empty());
        // spec light ids = spec order = slot order (the game's flicker index)
        for (i, l) in spec.lights.iter().enumerate() {
            assert_eq!(l.id, LightId(i as u32));
            assert_eq!(l.name, want[i].0);
        }
    }

    #[test]
    #[should_panic(expected = "name-join incomplete")]
    fn mirror_lights_reports_an_unnamed_slot_loudly() {
        let mut scene = lit_scene();
        scene.point_lights.push([9.0, 2.0, 9.0, 0.25, 2.0, 2.0, 2.0, 0.0]); // unnamed slot 3
        let scan = rt_probe::scan_lights(&scene).unwrap();
        let handles = rt_probe::SceneHandles { lights: scan.names, instances: Default::default() };
        mirror_lights(&scene, &handles, scan.light_count);
    }

    #[test]
    fn emission_freeze_and_dim_match_the_old_renderer_semantics() {
        let scene = lit_scene();
        let (handles, light_count) = lit_handles(&scene);
        let lights = mirror_lights(&scene, &handles, light_count);
        let keys: Vec<_> = lights.into_iter().map(|(_, kind, base, key)| (key, kind, base)).collect();
        // a snapshot with flickered values: lit warm + screen, point dark
        let snap = [(LightId(0), [9.9f32, 6.6, 3.3]), (LightId(1), [2.5, 11.0, 9.0]), (LightId(2), [0.0; 3])];
        // anim on, dim 1: snapshot rgb passes through verbatim
        let live = emission_frame(&snap, &keys, true, 1.0);
        assert_eq!(live[0].1, [9.9, 6.6, 3.3]);
        assert_eq!(live[1].1, [2.5, 11.0, 9.0]);
        // anim OFF: lit lights freeze at authored base (LIGHT_ANIM=0 golden
        // semantics), dark stays dark
        let frozen = emission_frame(&snap, &keys, false, 1.0);
        assert_eq!(frozen[0].1, [9.0, 6.0, 3.0]);
        assert_eq!(frozen[1].1, [3.0, 12.0, 9.6]);
        assert_eq!(frozen[2].1, [0.0; 3]);
        // LIGHTS dim scales switchable lights only — devices ignore it
        let dimmed = emission_frame(&snap, &keys, false, 0.5);
        assert_eq!(dimmed[0].1, [4.5, 3.0, 1.5]);
        assert_eq!(dimmed[1].1, [3.0, 12.0, 9.6], "screens ignore the dim");
    }
}
