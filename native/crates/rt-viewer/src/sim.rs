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
use glam::{IVec2, Vec2, Vec3};
use house_game::game::{Facing, Flashlight, Player, Pos};
use house_game::{parse_trace, Command, GameSnapshot, HouseGame, LevelSpec, RoomId, RoomSpec, TICK_DT};
use rt_probe::{screen_px_to_world, Config, Scene};
use sim_core::{FixedLoop, InputQueue, NullSink, Simulation, Tick};

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
}

impl GameLoop {
    pub fn new(scene: &Scene, cfg: &Config) -> GameLoop {
        let spec = mirror_spec(scene);
        let mut sim: HouseGame<NullSink> = HouseGame::new(&spec, NullSink);
        // ---- Config seeding: DIRECT pre-tick state writes (world setup, not
        // play), then re-derive. Flashlight boot state, the camera quarter
        // (yaw_q is sim state), walk speed, and the default facing toward the
        // camera at THAT yaw — the exact expression the old viewer used.
        sim.world.get::<&mut Flashlight>(sim.player).unwrap().on = cfg.flash;
        sim.res.yaw_q = cfg.yaw_q;
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
        }
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

    /// Sim time for `FrameState.time` — ticks, never the wall clock.
    pub fn time(&self) -> f32 {
        self.tick.0 as f32 * TICK_DT
    }
}

/// INTERIM level spec: mirror the renderer scene's collision fields (one room
/// = the floor rect, scene solids verbatim, no doors/targets). The content
/// stage replaces this with a spec that GENERATES the scene instead.
pub fn mirror_spec(scene: &Scene) -> LevelSpec {
    LevelSpec {
        rooms: vec![RoomSpec { id: RoomId(0), floor_rect: scene.floor_rect }],
        static_solids: scene.solids.clone(),
        doors: Vec::new(),
        lights: Vec::new(),
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

    #[test]
    fn mirror_spec_carries_the_scene_collision_verbatim() {
        let mut scene = Scene::new();
        scene.floor_rect = [-2.5, -1.0, 16.5, 12.0];
        scene.solids = vec![[0.0, 0.0, 1.0, 1.0], [3.0, 4.0, 5.0, 6.5]];
        scene.player_start = Vec3::new(4.0, 0.046875, 6.0);
        let spec = mirror_spec(&scene);
        assert_eq!(spec.rooms.len(), 1);
        assert_eq!(spec.rooms[0].floor_rect, scene.floor_rect);
        assert_eq!(spec.floor_bounds(), scene.floor_rect);
        assert_eq!(spec.static_solids, scene.solids);
        assert_eq!(spec.player_start, scene.player_start);
        assert!(spec.doors.is_empty() && spec.targets.is_empty());
    }
}
