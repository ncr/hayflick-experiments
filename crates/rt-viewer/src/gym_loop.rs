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
use house_game::gym::grid::{CellKind, CellPos, Dir};
use house_game::gym::sim::{Command, GymGame, GymLevel, GymSnapshot, MoveMode};
use house_game::gym::trace::parse_trace;
use house_game::TICK_DT;
use iso_core::{world_to_window_px, Projection, ViewXform};
use phys_spike::PhysWorld;
use rt_probe::{Config, InstanceKey, SceneHandles};
use sim_core::{FixedLoop, InputQueue, Simulation, Tick};
use std::collections::VecDeque;

/// Ticks the body glides between cells (presentation-only, tick-clocked).
/// Legacy click/replay step easing. Keyboard movement follows the continuous
/// sim position directly and does not use this interpolator.
const EASE_TICKS: f32 = 9.0;

// Marker palette (the click-to-move destination tag).
const BG: u32 = 0x12151a;
const AMBER: u32 = 0xe8853c;
const INK: u32 = 0xd0d0c0;

/// A body easing from one cell centre to the next.
#[derive(Clone, Copy)]
struct Ease {
    from: Vec3,
    to: Vec3,
    start: u64,
}

impl Ease {
    fn pinned(p: Vec3) -> Ease {
        Ease { from: p, to: p, start: 0 }
    }
    fn at(&self, tick: u64) -> Vec3 {
        let t = ((tick.saturating_sub(self.start)) as f32 / EASE_TICKS).min(1.0);
        self.from + (self.to - self.from) * t
    }
    fn retarget(&mut self, to: Vec3, tick: u64) {
        if to != self.to {
            self.from = self.at(tick);
            self.to = to;
            self.start = tick;
        }
    }
}

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

/// A click-to-move route over the sim grid: the remaining cells in walk
/// order. Pure shell state — the sim only ever sees the per-tick Move
/// commands it produces.
struct Plan {
    cells: Vec<CellPos>,
    next: usize,
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
    /// The live click-to-move route (None = keyboard/no movement).
    plan: Option<Plan>,
    /// Projection used to interpret screen-relative movement.
    pub proj: Projection,
    /// Once keyboard movement has taken over, presentation follows the
    /// continuous sim position instead of easing between cell centres.
    continuous_active: bool,
    /// Eased world position of the player body.
    ease: Ease,
    /// Walk-cycle state.
    gait: Gait,
    /// Presentation facing for the player body (radians about Y).
    face: f32,
    /// Camera target the follow-cam last consumed.
    pub last_cam: Vec3,
    /// Destructibility spike: a box3d rigid-body world stepped once per fixed
    /// tick, rendered as extra `phys/{i}` dynamic runs — the PHYS=1 brick
    /// wall, or the wall-smash demo's debris (armed at its beat). `None` in
    /// the normal gym. NOT part of `state_hash` — presentation-layer physics.
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
            continuous_active: false,
            ease: Ease::pinned(p0),
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

    /// Step the physics spike one fixed tick (no-op unless PHYS=1 attached a
    /// world). Called from every tick-advancing path so physics stays locked
    /// to the sim clock — DEMO captures reproduce.
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

    /// LMB on the ground: plan a BFS route to the picked cell and follow it.
    /// Clicking the player's own cell just cancels the plan.
    pub fn click_ground(&mut self, g: Vec3) {
        let (w, h) = (self.sim.grid().w, self.sim.grid().h);
        let (cx, cz) = (g.x.floor() as i32, g.z.floor() as i32);
        if cx < 0 || cz < 0 || cx >= w as i32 || cz >= h as i32 {
            return;
        }
        let cell = CellPos::new(cx as i16, cz as i16);
        if cell == self.snap.player {
            self.plan = None;
            return;
        }
        self.continuous_active = false;
        if let Some(cells) = self.bfs(self.snap.player, cell) {
            self.plan = Some(Plan { cells, next: 0 });
        }
    }

    /// Shortest 4-dir route over the sim's own grid (deterministic scan
    /// order); wall edges and the grid boundary block. Returns the cells to
    /// visit AFTER `from`.
    fn bfs(&self, from: CellPos, to: CellPos) -> Option<Vec<CellPos>> {
        let g = self.sim.grid();
        let (w, h) = (g.w as i32, g.h as i32);
        let idx = |p: CellPos| (p.z as i32 * w + p.x as i32) as usize;
        let mut prev: Vec<Option<CellPos>> = vec![None; (w * h) as usize];
        let mut seen = vec![false; (w * h) as usize];
        let mut q = VecDeque::new();
        seen[idx(from)] = true;
        q.push_back(from);
        'search: while let Some(p) = q.pop_front() {
            for dir in [Dir::Xp, Dir::Xm, Dir::Zp, Dir::Zm] {
                if !g.open(p, dir) {
                    continue;
                }
                let n = p.step(dir);
                if seen[idx(n)] {
                    continue;
                }
                seen[idx(n)] = true;
                prev[idx(n)] = Some(p);
                if n == to {
                    break 'search;
                }
                q.push_back(n);
            }
        }
        if !seen[idx(to)] {
            return None;
        }
        let mut cells = vec![to];
        let mut cur = to;
        while let Some(p) = prev[idx(cur)] {
            if p == from {
                break;
            }
            cells.push(p);
            cur = p;
        }
        cells.reverse();
        Some(cells)
    }

    /// Feed the live plan one tick: advance past reached cells, push the
    /// next Move (the sim's cadence drops early ones).
    fn plan_step(&mut self) {
        if self.plan.is_none() {
            return;
        }
        let s = self.sim.snapshot();
        let plan = self.plan.as_mut().unwrap();
        while plan.next < plan.cells.len() && plan.cells[plan.next] == s.player {
            plan.next += 1;
        }
        if plan.next == plan.cells.len() {
            self.plan = None;
            return;
        }
        let tgt = plan.cells[plan.next];
        let (dx, dz) = (tgt.x - s.player.x, tgt.z - s.player.z);
        if dx.abs() + dz.abs() != 1 {
            // knocked off the route — replan once
            let goal = *plan.cells.last().unwrap();
            self.plan = self.bfs(s.player, goal).map(|cells| Plan { cells, next: 0 });
            return;
        }
        let mode = self.mode();
        self.queue.push(self.tick, Command::Move { dx: dx.signum(), dz: dz.signum(), mode });
    }

    /// Advance the accumulator and run the due ticks; held keys synthesize
    /// one Move per tick (keyboard overrides any mouse plan), else the plan
    /// feeds (the SIM owns the step cadence and drops extras).
    pub fn run_due(&mut self, real_dt: f32) -> u32 {
        let n = self.fixed.advance(real_dt);
        for _ in 0..n {
            if let Some(command) = self.held_command() {
                self.plan = None;
                self.continuous_active = true;
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
        // A replay prefix isn't gameplay to animate: snap presentation to sim
        // truth (otherwise a SHOT right after the prefix — which never ticks
        // — can capture a legacy ease mid-glide).
        self.ease = Ease::pinned(self.ease.to);
        println!("CMDS(gym): {n} commands over {ticks} ticks — state {:016x}", self.sim.state_hash());
    }

    /// Advance the walk cycle one fixed tick. Continuous movement contributes
    /// its actual distance this tick; legacy click/replay easing contributes
    /// its eased distance. The gait therefore cannot run in place against a
    /// wall or skate ahead of an accelerating body.
    fn gait_tick(&mut self) {
        let now = self.tick.0;
        let e = self.ease;
        let (stride, _) = gait_params(self.mode());
        let (moving, distance) = if self.continuous_active {
            let snap = self.sim.snapshot();
            let distance = snap.velocity.length() * TICK_DT;
            (distance > 1.0e-6, distance)
        } else {
            let distance = (e.at(now) - e.at(now.saturating_sub(1))).length();
            (distance > 1.0e-6 && now <= e.start + EASE_TICKS as u64, distance)
        };
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
        let cell_p = cell_world(self.snap.player);
        let sim_p = Vec3::new(self.snap.position.x, cell_p.y, self.snap.position.y);
        if !self.continuous_active && (self.snap.position - Vec2::new(cell_p.x, cell_p.z)).length_squared() > 1.0e-8 {
            // DEMO/CMDS traces can carry the additive continuous command too;
            // infer the presentation mode from the snapshot when no live key
            // set explicitly selected it.
            self.continuous_active = true;
        }
        let now = self.tick.0;
        let p = if self.continuous_active { sim_p } else { cell_p };
        let prev_to = self.ease.to;
        if self.continuous_active {
            self.ease = Ease::pinned(p);
        } else {
            self.ease.retarget(p, now);
        }
        if p != prev_to {
            let d = if self.continuous_active {
                Vec3::new(self.snap.velocity.x, 0.0, self.snap.velocity.y)
            } else {
                p - prev_to
            };
            if d.length_squared() > 1e-6 {
                self.face = d.x.atan2(d.z);
            }
        }
    }

    fn sim_position_world(&self) -> Vec3 {
        let y = cell_world(self.snap.player).y;
        Vec3::new(self.snap.position.x, y, self.snap.position.y)
    }

    fn render_position(&self) -> Vec3 {
        if self.continuous_active {
            self.sim_position_world()
        } else {
            self.ease.at(self.tick.0)
        }
    }

    /// The camera's follow anchor: continuous world position for keyboard
    /// movement, or the eased cell centre for legacy click/replay steps.
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
            let goal = *plan.cells.last().unwrap();
            let accent = if (now / 8).is_multiple_of(2) { AMBER } else { INK };
            let (pix, w, h) = bubble(">", accent);
            let win = world_to_window_px(cell_world(goal) + Vec3::new(0.0, 0.55, 0.0), xf);
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

    /// The mouse loop end-to-end: click INSIDE the building — the plan
    /// routes around the walls, through the doorway, and clears on arrival.
    /// Replay stays pure Move commands.
    #[test]
    fn click_routes_through_the_doorway_and_arrives() {
        let mut t = GymLoop::new(gym_level());
        let goal = CellPos::new(5, 5); // inside the one building
        t.click_ground(cell_world(goal));
        assert!(t.plan.is_some(), "the interior must be BFS-reachable via the doorway");
        for _ in 0..900 {
            t.run_due(TICK_DT);
        }
        assert_eq!(t.snap.player, goal, "the plan must arrive");
        assert!(t.plan.is_none(), "a finished plan clears");
        assert!(t.indoors(), "the goal is indoors");
        assert_eq!(t.wall_cut(), Some(WALL_CUT_H), "indoors turns the dollhouse cutaway on");
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
