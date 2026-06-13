//! The sim side of the viewer: a fixed-tick `house-game` loop plus the
//! snapshot→renderer adapter state (ARCHITECTURE.md step 9). This is the ONLY
//! place that knows both the game and the renderer — the game never sees
//! Vulkan, the renderer never sees commands; `GameSnapshot` → `FrameState` is
//! everything that crosses per frame.
//!
//! Until the game-content stage (step 11) lands a spec-generated scene, the
//! level is an INTERIM mirror of the renderer scene's collision fields (floor
//! rect + solids verbatim, no doors/targets), so click-to-walk collides
//! against exactly what the eye sees.

use crate::renderer::Renderer;
use glam::{IVec2, Mat4, Vec2, Vec3};
use house_game::game::{Facing, Flashlight, Player, Pos};
use house_game::{parse_trace, Command, DoorId, GameSnapshot, HouseGame, LevelSpec, LightId, LightKind, LightSpec, RoomId, RoomSpec, TICK_DT};
use rt_probe::{screen_px_to_world, Config, InstanceKey, LightKey, Scene, SceneHandles};
use sim_core::{FixedLoop, InputQueue, NullSink, Simulation, Tick};

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
    /// Per spec light, in slot order (spec index == NEE slot == game flicker
    /// index): the renderer key, the kind, and the authored base rgb — the
    /// per-frame emission build and the LIGHT_ANIM=0 freeze read these.
    pub light_keys: Vec<(LightKey, LightKind, [f32; 3])>,
    /// Per door: the leaf instance handle + hinge/axis for the swing transform.
    /// Empty for the interim mirror scenes (no doors); populated for SCENE=game.
    pub doors: Vec<DoorRender>,
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
    fn assemble(spec: LevelSpec, scene: &Scene, _handles: &SceneHandles, light_keys: Vec<(LightKey, LightKind, [f32; 3])>, doors: Vec<DoorRender>, cfg: &Config) -> GameLoop {
        let mut sim: HouseGame<NullSink> = HouseGame::new(&spec, NullSink);
        // ---- Config seeding: DIRECT pre-tick state writes (world setup, not
        // play), then re-derive. Flashlight boot state, the camera quarter
        // (yaw_q is sim state), walk speed, the room-lights master (LIGHTS=0
        // boots dark; fractional LIGHTS stays a viewer-side dim), and the
        // default facing toward the camera at THAT yaw — the exact expression
        // the old viewer used.
        sim.world.get::<&mut Flashlight>(sim.player).unwrap().on = cfg.flash;
        sim.res.yaw_q = cfg.yaw_q;
        sim.res.master_lights = cfg.lights > 0.0;
        sim.world.get::<&mut Player>(sim.player).unwrap().speed_px = cfg.player_speed.unwrap_or(cfg.default_player_speed());
        let down = screen_px_to_world(Vec2::new(0.0, 1.0), 90.0 * cfg.yaw_q as f32);
        sim.world.get::<&mut Facing>(sim.player).unwrap().0 = Vec2::new(down.x, down.z).try_normalize().unwrap_or(Vec2::new(0.0, 1.0));
        sim.reseed();
        let snap = sim.snapshot();
        let has_player = scene.dynamic_prim.is_some();
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
            follow_cam: has_player && cfg.scene != "grid",
            light_keys,
            doors,
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
        let Some(path) = &cfg.cmds else { return };
        let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("CMDS {path}: {e}"));
        let trace = parse_trace(&text).unwrap_or_else(|e| panic!("CMDS: {e}"));
        let ticks = cfg.cmds_ticks.unwrap_or_else(|| trace.iter().map(|(t, _)| t.0 + 1).max().unwrap_or(0));
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

    /// Sim time for `FrameState.time` — ticks, never the wall clock.
    pub fn time(&self) -> f32 {
        self.tick.0 as f32 * TICK_DT
    }
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
        player_start: scene.player_start,
        seed: 42,
    }
}

impl Renderer {
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
    use rt_probe::iso::{iso_basis, snap_ground_to_lattice, ISO_R};

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
