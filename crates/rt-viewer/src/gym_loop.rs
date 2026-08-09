//! The gym sim side of the viewer: a fixed-tick `GymGame` loop + the
//! snapshot→renderer adapter (docs/VISION.md Faza 0).
//!
//! Presentation choices, all sim-blind:
//! - keyboard movement feeds the headless sim's fixed-tick continuous mover;
//!   click-to-move and old replay traces retain their cell-step commands, with
//!   the shell easing those legacy steps between centres,
//! - MOUSE-first controls: LMB picks a ground cell, the shell BFS-plans a
//!   route over the sim's own grid and feeds one Move per tick — the sim
//!   still owns the cadence, and a replay trace stays pure Move commands.
//!   WASD is SCREEN-relative continuous input through the active projection.
//!   Shift = run.

use crate::backend::Stamp;
use crate::gym_scene::{cell_world, ARM_X, HIP, LEG_X, SHOULDER, WALL_CUT_H};
use crate::menu::{mrect, mtext};
use glam::{Mat4, Vec2, Vec3};
use house_game::gym::grid::CellKind;
use house_game::gym::route::Route;
use house_game::gym::sim::{Command, GymGame, GymLevel, GymSnapshot, MoveMode};
use house_game::gym::trace::parse_trace;
use house_game::TICK_DT;
use iso_core::{world_to_window_px, Projection, ViewXform};
use phys_spike::PhysWorld;
use rt_probe::{Config, InstanceKey, SceneHandles};
use sim_core::{FixedLoop, InputQueue, Simulation, Tick};

// Marker palette (the click-to-move destination tag).
const BG: u32 = 0x12151a;
const AMBER: u32 = 0xe8853c;
const INK: u32 = 0xd0d0c0;

/// Walk-cycle state — presentation-only, but ticked on the FIXED clock
/// (run_due's per-tick loop / demo_advance_tick) so DEMO captures replay
/// bit-identically. `phase` accumulates from actual ground distance; `blend`
/// fades the pose in/out so stops settle to the rest pose instead of
/// freezing mid-stride.
#[derive(Clone, Copy, Default)]
struct Gait {
    phase: f32,
    blend: f32,
}

/// Ground distance per full two-step cycle and hip swing amplitude (radians)
/// per movement mode — the whole feel of the walk in two numbers. Driving the
/// phase from distance keeps the feet tied to the body during acceleration,
/// braking, and collide-and-slide.
const WALK_STRIDE_WU: f32 = 1.6;
const RUN_STRIDE_WU: f32 = 2.0;

fn gait_params(mode: MoveMode) -> (f32, f32) {
    match mode {
        MoveMode::Walk => (WALK_STRIDE_WU, 0.5),
        MoveMode::Run => (RUN_STRIDE_WU, 0.72),
    }
}

/// Sample the cycle: (core bob, leg swing, arm swing) — arms counter-swing.
fn gait_pose(g: Gait, leg_amp: f32, arm_ratio: f32) -> (f32, f32, f32) {
    let s = g.phase.sin() * g.blend;
    ((g.phase * 2.0).sin().abs() * 0.02 * g.blend, s * leg_amp, -s * leg_amp * arm_ratio)
}

pub struct GymLoop {
    pub fixed: FixedLoop,
    pub queue: InputQueue<Command>,
    pub sim: GymGame,
    pub tick: Tick,
    pub cmds_prefix: u64,
    pub snap: GymSnapshot,
    pub spec: GymLevel,
    /// Held movement keys [up, down, left, right] (screen-relative).
    pub held: [bool; 4],
    pub run_held: bool,
    /// Camera quarter, mirrored from the view each frame so WASD stays
    /// screen-relative through q/e turns.
    pub yaw_q: u32,
    /// The live click-to-move route (None = keyboard/standing). Shell state:
    /// the sim only ever sees the per-tick world-input commands it steers.
    plan: Option<Route>,
    /// Projection used to interpret screen-relative movement.
    pub proj: Projection,
    /// Walk-cycle state.
    gait: Gait,
    /// Presentation facing for the player body (radians about Y).
    face: f32,
    /// Camera target the follow-cam last consumed.
    pub last_cam: Vec3,
    /// Destructibility spike: a box3d rigid-body world stepped once per fixed
    /// tick, rendered as extra `phys/{i}` dynamic runs — the wall-smash demo's
    /// debris (armed at its beat). `None` in the normal gym. NOT part of
    /// `state_hash` — presentation-layer physics.
    pub phys: Option<PhysWorld>,
}

impl GymLoop {
    #[allow(dead_code)]
    pub fn new(spec: GymLevel) -> GymLoop {
        let proj = iso_core::by_name("trimetric").expect("trimetric preset");
        Self::with_projection(spec, proj)
    }

    pub fn with_projection(spec: GymLevel, proj: Projection) -> GymLoop {
        let sim = GymGame::new(spec.clone());
        let snap = sim.snapshot();
        let p0 = cell_world(snap.player);
        GymLoop {
            fixed: FixedLoop::new(TICK_DT),
            queue: InputQueue::new(),
            sim,
            tick: Tick(0),
            cmds_prefix: 0,
            snap,
            spec,
            held: [false; 4],
            run_held: false,
            yaw_q: 0,
            plan: None,
            proj,
            gait: Gait::default(),
            face: 0.0,
            last_cam: p0,
            phys: None,
        }
    }

    /// Update the movement basis when the settings menu changes projection.
    pub fn set_projection(&mut self, proj: Projection) {
        self.proj = proj;
    }

    /// Step the physics spike one fixed tick (no-op unless the smash beat
    /// attached a world). Called from every tick-advancing path so physics
    /// stays locked to the sim clock — DEMO captures reproduce.
    fn phys_step(&mut self) {
        if let Some(p) = &mut self.phys {
            p.step();
        }
    }

    pub fn time(&self) -> f32 {
        self.tick.0 as f32 * TICK_DT
    }

    fn screen_input(&self) -> (i16, i16) {
        (
            self.held[3] as i16 - self.held[2] as i16,
            self.held[1] as i16 - self.held[0] as i16,
        )
    }

    /// Convert the held screen direction through the actual projection. This
    /// is the same inverse lattice used by clicks and the camera, so W/A/S/D
    /// keep their screen meaning for both iso21 and trimetric, at every yaw.
    fn world_input(&self) -> Vec3 {
        let (sx, sy) = self.screen_input();
        self.proj.screen_px_to_world(Vec2::new(sx as f32, sy as f32), 90.0 * self.yaw_q as f32)
    }

    /// Held keys → a normalized, fixed-point world input for the continuous
    /// headless mover. The projection inversion means a screen-cardinal key
    /// is a straight line on screen instead of an alternating grid path.
    fn held_command(&self) -> Option<Command> {
        let (sx, sy) = self.screen_input();
        if sx == 0 && sy == 0 {
            return None;
        }
        let w = self.world_input();
        let v = Vec2::new(w.x, w.z).normalize_or_zero() * house_game::gym::sim::WORLD_INPUT_SCALE;
        Some(Command::MoveWorld { dx: v.x.round() as i16, dz: v.y.round() as i16, mode: self.mode() })
    }

    fn mode(&self) -> MoveMode {
        if self.run_held {
            MoveMode::Run
        } else {
            MoveMode::Walk
        }
    }

    // ---- click-to-move (mouse-first controls) ---------------------------

    /// LMB on the ground: plan a route to the picked point and walk it.
    /// Clicking where the player already stands cancels the route.
    pub fn click_ground(&mut self, g: Vec3) {
        self.plan = Route::plan(self.sim.grid(), self.snap.position, Vec2::new(g.x, g.z));
    }

    /// How far the body would still travel if input stopped THIS tick —
    /// `v² / 2a` against the sim's braking rate. The route stops steering
    /// once the goal is inside it, so the body coasts to a halt ON the goal
    /// instead of arriving at full speed and oscillating around it.
    fn stop_distance(&self) -> f32 {
        let v = self.snap.velocity.length();
        v * v / (2.0 * house_game::gym::sim::BRAKE_WU_PER_S2)
    }

    /// Feed the live route one tick: steer at the next corner and push the
    /// resulting world input — the SAME command the keyboard produces.
    fn plan_step(&mut self) {
        if self.plan.is_none() {
            return;
        }
        let pos = self.sim.snapshot().position;
        let stop = self.stop_distance();
        let plan = self.plan.as_mut().expect("checked above");
        let Some(dir) = plan.steer(pos, stop) else {
            // Arrived: drop the route and feed nothing, so the sim's own
            // braking settles the body instead of a step landing it.
            self.plan = None;
            return;
        };
        let v = dir * house_game::gym::sim::WORLD_INPUT_SCALE;
        let mode = self.mode();
        self.queue.push(self.tick, Command::MoveWorld { dx: v.x.round() as i16, dz: v.y.round() as i16, mode });
    }

    /// Advance the accumulator and run the due ticks; held keys synthesize the
    /// world input (keyboard overrides any mouse route), else the route steers
    /// one. Both paths emit the same command, so there is one mover.
    pub fn run_due(&mut self, real_dt: f32) -> u32 {
        let n = self.fixed.advance(real_dt);
        for _ in 0..n {
            if let Some(command) = self.held_command() {
                self.plan = None;
                self.queue.push(self.tick, command);
            } else {
                self.plan_step();
            }
            let cmds = self.queue.drain_for(self.tick);
            self.sim.tick(self.tick, &cmds);
            self.tick.0 += 1;
            self.gait_tick();
            self.phys_step();
        }
        if n > 0 {
            self.refresh();
        }
        n
    }

    /// DEMO: one tick per rendered frame (deterministic gameplay capture).
    pub fn demo_advance_tick(&mut self) {
        // A live route steers here too, so a `WALK_TO=` capture records the
        // mouse path frame by frame exactly as the interactive loop walks it.
        self.plan_step();
        let cmds = self.queue.drain_for(self.tick);
        self.sim.tick(self.tick, &cmds);
        self.tick.0 += 1;
        self.gait_tick();
        self.phys_step();
        self.refresh();
    }

    /// DEMO=trace.txt (gym trace grammar): queue every command, return the
    /// tick count to play.
    pub fn demo_load(&mut self, cfg: &Config) -> u64 {
        let path = cfg.harness.demo.as_ref().expect("demo_load only on DEMO path");
        let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("DEMO {path}: {e}"));
        let trace = parse_trace(&text).unwrap_or_else(|e| panic!("DEMO: {e}"));
        let ticks = cfg.harness.demo_ticks.unwrap_or_else(|| trace.iter().map(|(t, _)| t.0 + 1).max().unwrap_or(0));
        let n = trace.len();
        for (t, c) in trace {
            self.queue.push(t, c);
        }
        println!("DEMO(gym): {n} commands, playing {ticks} ticks from {path}");
        ticks
    }

    /// `WALK_TO=x,z`: replay ONE click-to-move at boot. A trace can express
    /// held keys because those ARE commands; a click is a shell gesture that
    /// only produces commands once a route exists, so it needs its own knob —
    /// the same reason `WEAR_EDIT` and `IDE_EDIT` exist. Without it the mouse
    /// half of the mover has no headless form at all, which is how it kept a
    /// separate implementation for as long as it did.
    pub fn walk_to_from_env(&mut self, cfg: &Config) {
        if let Some((x, z)) = cfg.game.walk_to {
            self.click_ground(Vec3::new(x, 0.0, z));
            println!("WALK_TO: route to ({x}, {z}) — {} legs", self.plan.as_ref().map_or(0, |p| p.points().len()));
        }
    }

    /// CMDS=trace.txt: a deterministic startup replay prefix.
    pub fn run_cmds(&mut self, cfg: &Config) {
        let Some(path) = &cfg.game.cmds else { return };
        let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("CMDS {path}: {e}"));
        let trace = parse_trace(&text).unwrap_or_else(|e| panic!("CMDS: {e}"));
        let ticks = cfg.game.cmds_ticks.unwrap_or_else(|| trace.iter().map(|(t, _)| t.0 + 1).max().unwrap_or(0));
        let n = trace.len();
        for (t, c) in trace {
            self.queue.push(t, c);
        }
        for _ in 0..ticks {
            let cmds = self.queue.drain_for(self.tick);
            self.sim.tick(self.tick, &cmds);
            self.tick.0 += 1;
            self.phys_step();
        }
        self.cmds_prefix = self.tick.0;
        self.refresh();
        println!("CMDS(gym): {n} commands over {ticks} ticks — state {:016x}", self.sim.state_hash());
    }

    /// Advance the walk cycle one fixed tick from the distance the body
    /// ACTUALLY covered, so the gait cannot run in place against a wall or
    /// skate ahead of an accelerating body. One mover means one source for
    /// this: there is no longer a second, eased path to measure instead.
    fn gait_tick(&mut self) {
        let (stride, _) = gait_params(self.mode());
        let distance = self.sim.snapshot().velocity.length() * TICK_DT;
        let moving = distance > 1.0e-6;
        let g = &mut self.gait;
        g.blend = (g.blend + if moving { 0.34 } else { -0.12 }).clamp(0.0, 1.0);
        if moving {
            g.phase += std::f32::consts::TAU * distance / stride;
        } else if g.blend == 0.0 {
            g.phase = 0.0; // idle: next stride starts at heel-strike
        }
    }

    fn refresh(&mut self) {
        self.snap = self.sim.snapshot();
        // Facing follows the velocity, not a position delta: a body sliding
        // along a wall still travels, and the direction it travels is the one
        // the figure should face.
        let d = Vec3::new(self.snap.velocity.x, 0.0, self.snap.velocity.y);
        if d.length_squared() > 1e-6 {
            self.face = d.x.atan2(d.z);
        }
    }

    fn sim_position_world(&self) -> Vec3 {
        let y = cell_world(self.snap.player).y;
        Vec3::new(self.snap.position.x, y, self.snap.position.y)
    }

    fn render_position(&self) -> Vec3 {
        self.sim_position_world()
    }

    /// The camera's follow anchor: the sim's own continuous position, for
    /// every input device.
    pub fn cam_target(&self) -> Vec3 {
        self.render_position()
    }

    /// Is the player inside the building? Drives the dollhouse cutaway.
    pub fn indoors(&self) -> bool {
        self.sim.grid().cell(self.snap.player) == CellKind::Room
    }

    /// The WALLCUT sill-height cutaway: on while the player is indoors —
    /// every occluder wall drops to sill height so the interior reads like a
    /// dollhouse. A pure function of the player's cell.
    pub fn wall_cut(&self) -> Option<f32> {
        self.indoors().then_some(WALL_CUT_H)
    }

    // ---- per-frame instance skinning ------------------------------------

    /// Place the player body: core + four limbs composed from the gait
    /// sample. Limb transforms MUST mirror the pivot constants the builder
    /// authored the geometry around.
    pub fn instances(&self, handles: &SceneHandles) -> Vec<(InstanceKey, Mat4)> {
        let mut out = Vec::new();
        let get = |n: &str| handles.instances.get(n).copied();
        let base = Mat4::from_translation(self.render_position()) * Mat4::from_rotation_y(self.face);
        let Some(core) = get("player") else { return out };
        let (_, leg_amp) = gait_params(self.mode());
        let (bob, leg, arm) = gait_pose(self.gait, leg_amp, 0.65);
        out.push((core, base * Mat4::from_translation(Vec3::new(0.0, bob, 0.0))));
        let limb = |px: f32, py: f32, swing: f32| base * Mat4::from_translation(Vec3::new(px, py, 0.0)) * Mat4::from_rotation_x(swing);
        for (suffix, m) in [
            ("legL", limb(-LEG_X, HIP, leg)),
            ("legR", limb(LEG_X, HIP, -leg)),
            ("armL", limb(-ARM_X, SHOULDER, arm)),
            ("armR", limb(ARM_X, SHOULDER, -arm)),
        ] {
            if let Some(k) = get(&format!("player/{suffix}")) {
                out.push((k, m));
            }
        }
        out
    }

    /// Physics-spike movers: each box3d box's world transform, joined onto
    /// its `phys/{i}` run. Appended to `instances` — same TLAS-refit path
    /// as the player limbs. Empty in the normal gym.
    pub fn phys_instances(&self, handles: &SceneHandles) -> Vec<(InstanceKey, Mat4)> {
        let mut out = Vec::new();
        if let Some(p) = &self.phys {
            for (i, m) in p.box_transforms().into_iter().enumerate() {
                if let Some(k) = handles.instances.get(&format!("phys/{i}")).copied() {
                    out.push((k, m));
                }
            }
        }
        out
    }

    // ---- burned-in stamps -------------------------------------------------

    /// The click-to-move destination marker: a pulsing ">" tag over the goal
    /// cell. Rides into SHOT/DEMO captures (part of the game picture).
    pub fn stamps(&self, xf: &ViewXform, ext: (u32, u32), rs: u32) -> Vec<Stamp> {
        let mut out = Vec::new();
        let (ext_w, ext_h) = (ext.0 as i64, ext.1 as i64);
        let s = rs.max(1) as i64;
        let now = self.tick.0;
        if let Some(plan) = &self.plan {
            // The marker sits on the CLICKED point now, not its cell centre —
            // the route walks to where the click landed.
            let g = plan.goal();
            let goal = Vec3::new(g.x, cell_world(self.snap.player).y, g.y);
            let accent = if (now / 8).is_multiple_of(2) { AMBER } else { INK };
            let (pix, w, h) = bubble(">", accent);
            let win = world_to_window_px(goal + Vec3::new(0.0, 0.55, 0.0), xf);
            if win.x > -60.0 && win.y > -60.0 && win.x < ext_w as f32 + 60.0 && win.y < ext_h as f32 + 60.0 {
                let x = (win.x as i64 - (w as i64 * s) / 2).clamp(2, ext_w - w as i64 * s - 2);
                let y = (win.y as i64 - h as i64 * s).clamp(2, ext_h - h as i64 * s - 2);
                out.push(Stamp { pix, w, h, x, y, scale: rs });
            }
        }
        out
    }
}

/// A bordered plate.
fn plate(w: i32, h: i32, bg: u32, border: u32) -> Vec<u32> {
    let mut c = vec![bg; (w * h) as usize];
    mrect(&mut c, w, 0, 0, w, 1, border);
    mrect(&mut c, w, 0, h - 1, w, 1, border);
    mrect(&mut c, w, 0, 0, 1, h, border);
    mrect(&mut c, w, w - 1, 0, 1, h, border);
    c
}

/// A speech bubble with a tail.
pub(crate) fn bubble(label: &str, accent: u32) -> (Vec<u32>, i32, i32) {
    let w = 8 + label.len() as i32 * 8;
    let h = 14 + 3;
    let c = {
        let mut c = plate(w, h - 3, BG, accent);
        mtext(&mut c, w, 4, 3, label, accent);
        c
    };
    let mut full = vec![0u32; (w * h) as usize];
    full[..(w * (h - 3)) as usize].copy_from_slice(&c);
    for (i, tw) in [3i32, 2, 1].iter().enumerate() {
        let y = h - 3 + i as i32;
        mrect(&mut full, w, w / 2 - tw, y, tw * 2, 1, accent);
    }
    (full, w, h)
}

#[cfg(test)]
mod tests {
    use super::*;
    use house_game::gym::grid::CellPos;
    use house_game::gym::sim::gym_level;

    /// W means SCREEN up: the world-axis stairs must follow the active
    /// projection's inverse pixel basis. The old fixed alternation produced
    /// a visible sideways drift under the trimetric game projection.
    #[test]
    fn held_w_follows_the_projection_without_sideways_zigzag() {
        let mut t = GymLoop::new(house_game::gym::sim::GymLevel {
            grid: house_game::gym::grid::Grid::new(64, 64),
            player_start: CellPos::new(32, 32),
            lights: Vec::new(),
        });
        t.held[0] = true;
        let start = t.snap.position;
        for _ in 0..64 {
            t.run_due(TICK_DT);
        }
        let delta = start - t.snap.position;
        assert!(delta.x + delta.y > 0.1, "held walk must move: {start:?} -> {:?}", t.snap.position);
        let screen_x = delta.x * t.proj.px_x[0] as f32 + delta.y * t.proj.px_z[0] as f32;
        let screen_y = delta.x * t.proj.px_x[1] as f32 + delta.y * t.proj.px_z[1] as f32;
        assert!(screen_y > 0.0, "screen-up must move upward from the start: ({screen_x}, {screen_y})");
        assert!(screen_x.abs() < 1.0e-3, "screen-up must be a straight line, not a zigzag: ({screen_x}, {screen_y})");
    }

    /// Continuous movement comes to rest without snapping the player back to
    /// the last cell centre or desynchronising presentation from sim truth.
    #[test]
    fn continuous_position_settles_without_a_cell_snap() {
        let mut t = GymLoop::new(gym_level());
        t.held[0] = true;
        for _ in 0..30 {
            t.run_due(TICK_DT);
        }
        t.held[0] = false;
        for _ in 0..30 {
            t.run_due(TICK_DT);
        }
        let eased = t.cam_target();
        let truth = Vec3::new(t.snap.position.x, cell_world(t.snap.player).y, t.snap.position.y);
        assert!((eased - truth).length() < 1e-5, "presentation must follow continuous sim position: {eased} vs {truth}");
        for _ in 0..30 {
            t.run_due(TICK_DT);
        }
        assert!((t.cam_target() - truth).length() < 1e-5, "a stopped player must remain at the continuous position");
    }

    /// The mouse loop end-to-end: click INSIDE the building — the route goes
    /// around the walls, through the doorway, and clears on arrival. Since
    /// 2026-08-09 it drives the CONTINUOUS mover, so this also pins that a
    /// click no longer produces cell snapping: the body arrives with the
    /// route's own goal underfoot and then brakes to rest ON it.
    #[test]
    fn click_routes_through_the_doorway_and_arrives() {
        let mut t = GymLoop::new(gym_level());
        let goal = CellPos::new(5, 5); // inside the one building
        let target = cell_world(goal);
        t.click_ground(target);
        assert!(t.plan.is_some(), "the interior must be reachable via the doorway");
        for _ in 0..900 {
            t.run_due(TICK_DT);
        }
        assert_eq!(t.snap.player, goal, "the route must arrive");
        assert!(t.plan.is_none(), "a finished route clears");
        assert!(t.indoors(), "the goal is indoors");
        assert_eq!(t.wall_cut(), Some(WALL_CUT_H), "indoors turns the dollhouse cutaway on");
        // Arrival means STOPPED on the clicked point, not parked a stopping
        // distance past it.
        assert_eq!(t.snap.velocity, Vec2::ZERO, "the body brakes to rest");
        let miss = (t.snap.position - Vec2::new(target.x, target.z)).length();
        assert!(miss < 0.3, "the body rests on the clicked point, off by {miss}");
    }

    /// Clicking off the map or the player's own cell leaves no plan.
    #[test]
    fn invalid_clicks_leave_no_plan() {
        let mut t = GymLoop::new(gym_level());
        t.click_ground(Vec3::new(-3.0, 0.0, 5000.0)); // off the map
        assert!(t.plan.is_none());
        t.click_ground(cell_world(t.snap.player)); // own cell: cancel, no plan
        assert!(t.plan.is_none());
    }

    /// The walk cycle lives on the fixed clock: gait blends in while the
    /// body walks, swings the legs in antiphase, and settles back to the
    /// rest pose (blend 0) after the last ease lands.
    #[test]
    fn gait_swings_while_walking_and_settles_at_rest() {
        let mut t = GymLoop::new(gym_level());
        t.held[0] = true;
        for _ in 0..24 {
            t.run_due(TICK_DT);
        }
        let g = t.gait;
        assert!(g.blend > 0.9, "mid-walk the pose must be fully blended in (blend={})", g.blend);
        let (_, leg, arm) = gait_pose(g, 0.5, 0.65);
        assert!(leg.abs() <= 0.5 && arm.abs() <= 0.5 * 0.65);
        let mut peak: f32 = 0.0;
        for _ in 0..16 {
            t.run_due(TICK_DT);
            let (_, l, _) = gait_pose(t.gait, 0.5, 0.65);
            peak = peak.max(l.abs());
        }
        assert!(peak > 0.3, "a full cycle must reach a visible swing (peak={peak})");
        t.held[0] = false;
        for _ in 0..40 {
            t.run_due(TICK_DT);
        }
        assert_eq!(t.gait.blend, 0.0, "idle must settle to the rest pose");
        assert_eq!(t.gait.phase, 0.0, "the next stride restarts at heel-strike");
    }

    /// A walk cycle must cover a stable piece of ground. A fixed phase clock
    /// advances too quickly while the mover is accelerating, which makes the
    /// feet skate relative to the floor; distance-driven phase keeps the
    /// animation and the continuous body on the same stride.
    #[test]
    fn gait_phase_tracks_distance_instead_of_wall_clock() {
        let mut t = GymLoop::new(house_game::gym::sim::GymLevel {
            grid: house_game::gym::grid::Grid::new(64, 64),
            player_start: CellPos::new(32, 32),
            lights: Vec::new(),
        });
        t.held[0] = true;
        let start = t.snap.position;
        for _ in 0..180 {
            t.run_due(TICK_DT);
        }
        let distance = (t.snap.position - start).length();
        let cycles = t.gait.phase / std::f32::consts::TAU;
        assert!(cycles > 1.0, "the gait must advance while walking");
        let ground_per_cycle = distance / cycles;
        assert!((ground_per_cycle - WALK_STRIDE_WU).abs() < 0.02, "gait stride drifted from movement: {ground_per_cycle} wu/cycle");
    }

    /// The articulated body emits five runs with mirrored leg swings.
    #[test]
    fn articulated_instances_mirror_legs() {
        use std::collections::BTreeMap;
        let mut t = GymLoop::new(gym_level());
        t.held[0] = true;
        for _ in 0..20 {
            t.run_due(TICK_DT);
        }
        let mut instances = BTreeMap::new();
        let names = ["player", "player/legL", "player/legR", "player/armL", "player/armR"];
        for (i, n) in names.iter().enumerate() {
            instances.insert(n.to_string(), InstanceKey::from_index(i as u32));
        }
        let handles = SceneHandles { lights: BTreeMap::new(), instances };
        let out = t.instances(&handles);
        assert_eq!(out.len(), 5, "core + four limbs");
        let get = |name: &str| {
            let k = handles.instances[name];
            out.iter().find(|(ik, _)| *ik == k).map(|(_, m)| *m).unwrap()
        };
        let (ll, lr) = (get("player/legL"), get("player/legR"));
        let swing = |m: Mat4| {
            let z = m.transform_vector3(Vec3::Z);
            z.y.atan2(z.z)
        };
        assert!((swing(ll) + swing(lr)).abs() < 1e-5, "legs must mirror");
        assert!(swing(ll).abs() > 0.05, "mid-walk legs must be off rest");
    }
}
