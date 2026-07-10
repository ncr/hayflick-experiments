//! The thief sim side of the viewer (M2 playable slice + feel round): a
//! fixed-tick `ThiefGame` loop + the snapshot→renderer adapter for
//! SCENE=thief. The twin of `sim.rs::GameLoop` for the thief `Simulation` —
//! the house GameLoop still exists on this scene as an idle light-join
//! mirror; all play routes here.
//!
//! Presentation choices, all sim-blind:
//! - the sim steps whole cells at its own cadence; the shell EASES bodies
//!   between cells over a few ticks (tick-clocked, so DEMO captures ease
//!   identically),
//! - MOUSE-first controls (owner feel round): LMB picks a ground cell, the
//!   shell BFS-plans a route over the sim's own grid and feeds one Move per
//!   tick — the sim still owns the cadence, and a replay trace stays pure
//!   Move/Steal commands. Clicking the loot walks there and lifts it; a
//!   live stop turns the 05c outs into buttons (and CANCELS any plan, so a
//!   queued route can never auto-flee a stop). WASD stays as SCREEN-relative
//!   nudging: screen-up walks visually up the iso staircase,
//! - the stealth read is stamps (docs/spec/11): per-NPC alertness bubbles,
//!   a Fallout-1/2-style full-width bottom bar — the narrated event LOG
//!   with day-clock prefixes beside the status cluster (clock / coin /
//!   load / exposure / heat) — and the stop panel. Stamps burn into
//!   SHOT/DEMO captures: they are the game picture, not shell UI.

use crate::backend::Stamp;
use crate::game_scene::DOOR_LEAF_H;
use crate::menu::{mrect, mtext};
use crate::thief_scene::{cell_world, cut_for_floor, door_leaf_at, door_runs, player_run_for_look, DoorRun, ARM_X, HIP, LEG_X, SHOULDER, STOREY_H, WALL_CUT_H};
use glam::{Mat4, Vec2, Vec3};
use house_game::thief::grid::{CellKind, CellPos, Dir, DoorState, EdgeKind, Passage};
use house_game::thief::log::narrate;
use house_game::thief::sim::{
    day_minute, Command, DayPhase, MoveMode, NpcState, Role, StopChoice, ThiefGame,
    ThiefSnapshot, ThiefSpec, BRIBE_COST, DARK_LIGHT, DIM_LIGHT, STOP_DECIDE_TICKS,
};
use house_game::thief::trace::parse_trace;
use house_game::TICK_DT;
use iso_core::{world_to_window_px, ViewXform};
use rt_probe::{Config, InstanceKey, SceneHandles};
use sim_core::{FixedLoop, InputQueue, Simulation, Tick};
use std::collections::VecDeque;

/// Ticks a body glides between cells (presentation-only, tick-clocked).
/// Slightly LONGER than the walk cadence (8): consecutive eases overlap, so
/// the 4-dir staircase reads as a rounded glide instead of a hard zigzag.
const EASE_TICKS: f32 = 9.0;

// HUD palette, tuned to the picked scifi look (2026-07-10): cool near-black
// console, steel border, the station's safety-orange livery as the accent.
const BG: u32 = 0x12151a;
const BORDER: u32 = 0x505a68;
const AMBER: u32 = 0xe8853c;
const RED: u32 = 0xe86858;
const GREEN: u32 = 0x8fd08f;
const INK: u32 = 0xd0d0c0;
const DIMTX: u32 = 0x9a9aa2;
const FAINT: u32 = 0x6e6e78;

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

/// Walk-cycle state for one body (player or NPC) — presentation-only, but
/// ticked on the FIXED clock (run_due's per-tick loop / demo_advance_tick)
/// so DEMO captures replay bit-identically. `phase` accumulates while the
/// body's ease is gliding; `blend` fades the pose in/out so stops settle to
/// the rest pose instead of freezing mid-stride.
#[derive(Clone, Copy, Default)]
struct Gait {
    phase: f32,
    blend: f32,
}

/// Stride period (ticks per full two-step cycle) and hip swing amplitude
/// (radians) per movement mode — the whole feel of the walk in two numbers.
fn gait_params(mode: MoveMode) -> (f32, f32) {
    match mode {
        MoveMode::Sneak => (22.0, 0.34),
        MoveMode::Walk => (16.0, 0.5),
        MoveMode::Run => (11.0, 0.72),
    }
}

/// The movement mode an NPC's state implies (hunters run).
fn npc_mode(state: NpcState) -> MoveMode {
    match state {
        NpcState::Approach | NpcState::Pursue => MoveMode::Run,
        _ => MoveMode::Walk,
    }
}

/// Sample the cycle: (core bob, leg swing, arm swing) — arms counter-swing.
fn gait_pose(g: Gait, leg_amp: f32, arm_ratio: f32) -> (f32, f32, f32) {
    let s = g.phase.sin() * g.blend;
    ((g.phase * 2.0).sin().abs() * 0.02 * g.blend, s * leg_amp, -s * leg_amp * arm_ratio)
}

/// A click-to-move route over the sim grid: the remaining cells in walk
/// order, plus whether arriving should lift the loot. Pure shell state —
/// the sim only ever sees the per-tick Move/Steal commands it produces.
struct Plan {
    cells: Vec<CellPos>,
    next: usize,
    steal: bool,
}

pub struct ThiefLoop {
    pub fixed: FixedLoop,
    pub queue: InputQueue<Command>,
    pub sim: ThiefGame,
    pub tick: Tick,
    pub cmds_prefix: u64,
    pub snap: ThiefSnapshot,
    pub spec: ThiefSpec,
    /// Held movement keys [up, down, left, right] (screen-relative).
    pub held: [bool; 4],
    pub run_held: bool,
    pub sneak_held: bool,
    /// Camera quarter, mirrored from the view each frame so WASD stays
    /// screen-relative through q/e turns.
    pub yaw_q: u32,
    /// Live outfit toggle state (O): hooded-green ⇄ bare-brown.
    pub outfit_alt: bool,
    /// The prose event log (module 11) — narrated sim events with a
    /// day-clock prefix, in order.
    pub log: Vec<String>,
    seen_events: usize,
    doors: Vec<DoorRun>,
    /// The live click-to-move route (None = keyboard/no movement).
    plan: Option<Plan>,
    /// Diagonal staircase phase: flips on every LANDED step, so a held
    /// screen-diagonal alternates axes by actual progress (tick parity
    /// fails here — the walk cadence is even, so every accepted move
    /// would land on the same parity and the diagonal would degenerate).
    stair: bool,
    /// Eased world positions: [player, npcs in snapshot order...].
    ease: Vec<Ease>,
    /// Walk-cycle state, parallel to `ease`.
    gait: Vec<Gait>,
    /// Presentation facing for the player body (radians about Y).
    face: f32,
    /// Camera target the follow-cam last consumed.
    pub last_cam: Vec3,
}

impl ThiefLoop {
    pub fn new(spec: ThiefSpec) -> ThiefLoop {
        let doors = door_runs(&spec.grid);
        let sim = ThiefGame::new(spec.clone());
        let snap = sim.snapshot();
        let mut ease = vec![Ease::pinned(cell_world(snap.player))];
        ease.extend(snap.npcs.iter().map(|n| Ease::pinned(cell_world(n.pos))));
        let gait = vec![Gait::default(); ease.len()];
        let p0 = cell_world(snap.player);
        let mut t = ThiefLoop {
            fixed: FixedLoop::new(TICK_DT),
            queue: InputQueue::new(),
            sim,
            tick: Tick(0),
            cmds_prefix: 0,
            snap,
            spec,
            held: [false; 4],
            run_held: false,
            sneak_held: false,
            yaw_q: 0,
            outfit_alt: false,
            log: Vec::new(),
            seen_events: 0,
            doors,
            plan: None,
            stair: false,
            ease,
            gait,
            face: 0.0,
            last_cam: p0,
        };
        // Scene-setting + controls, as the log's opening lines (11: the log
        // is the primary screen — no modal tutorial).
        t.log_line(0, "Dockside, before dawn. The counting-house strongbox is the prize.".into());
        t.log_line(0, "Click to move. SHIFT run, CTRL sneak. SPACE steal, G drop, O coat.".into());
        t
    }

    pub fn push(&mut self, c: Command) {
        self.queue.push(self.tick, c);
    }

    pub fn time(&self) -> f32 {
        self.tick.0 as f32 * TICK_DT
    }

    /// Append a narrated line with its day-clock prefix.
    fn log_line(&mut self, tick: u64, line: String) {
        let m = day_minute(tick, self.spec.day_len_ticks);
        self.log.push(format!("{:02}:{:02}  {line}", m / 60, m % 60));
    }

    /// Held keys → one grid step direction. SCREEN-relative for real: on the
    /// 2:1 iso lattice screen-right is world (+X,-Z) and screen-down is
    /// (+X,+Z), so a single held key wants BOTH axes — walked as a staircase
    /// that alternates on every landed step (`stair`). Two adjacent keys
    /// cancel to a pure axis (screen up-right = world -Z). The result is
    /// rotated to the camera quarter so q/e turns keep W meaning "up".
    fn held_dir(&self) -> (i16, i16) {
        let sx = self.held[3] as i16 - self.held[2] as i16; // screen right
        let sy = self.held[1] as i16 - self.held[0] as i16; // screen down
        if sx == 0 && sy == 0 {
            return (0, 0);
        }
        let (mut wx, mut wz) = (sx + sy, sy - sx);
        // rotate world axes by the camera quarter
        for _ in 0..(self.yaw_q % 4) {
            let (nx, nz) = (wz, -wx);
            wx = nx;
            wz = nz;
        }
        let (cx, cz) = (wx.signum(), wz.signum());
        match (cx, cz) {
            (0, z) => (0, z),
            (x, 0) => (x, 0),
            (x, z) => {
                if self.stair {
                    (x, 0)
                } else {
                    (0, z)
                }
            }
        }
    }

    fn mode(&self) -> MoveMode {
        if self.sneak_held {
            MoveMode::Sneak
        } else if self.run_held {
            MoveMode::Run
        } else {
            MoveMode::Walk
        }
    }

    // ---- click-to-move (mouse-first controls) ---------------------------

    /// LMB on the ground: plan a BFS route to the picked cell and follow it.
    /// Clicking the loot cell walks there and lifts it on arrival; clicking
    /// the player's own cell lifts loot underfoot or just cancels the plan.
    pub fn click_ground(&mut self, g: Vec3) {
        if self.snap.stop.is_some() {
            return; // a live stop is answered with the panel, never a walk
        }
        let (w, h) = (self.sim.grid().w, self.sim.grid().h);
        let (cx, cz) = (g.x.floor() as i32, g.z.floor() as i32);
        if cx < 0 || cz < 0 || cx >= w as i32 || cz >= h as i32 {
            return;
        }
        let cell = CellPos::new(cx as i16, cz as i16, self.snap.player.floor);
        if self.sim.grid().cell(cell).kind == CellKind::Void {
            return;
        }
        let steal = self.snap.loot_pos == Some(cell);
        if cell == self.snap.player {
            self.plan = None;
            if steal {
                self.push(Command::Steal);
            }
            return;
        }
        if let Some(cells) = self.bfs(self.snap.player, cell) {
            self.plan = Some(Plan { cells, next: 0, steal });
        }
    }

    /// Shortest 4-dir route over the sim's own grid (deterministic scan
    /// order). Passable = an open edge or ANY door (the sim auto-opens
    /// closed doors as you pass — 03's v0 movement rule); shut windows,
    /// locks and walls block. Returns the cells to visit AFTER `from`.
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
                let passable = match g.passage(p, dir) {
                    Passage::Free => true,
                    Passage::OpenFirst => matches!(g.edge(p, dir), EdgeKind::Door(_)),
                    _ => false,
                };
                if !passable {
                    continue;
                }
                let n = p.step(dir);
                if n.x < 0 || n.z < 0 || n.x as i32 >= w || n.z as i32 >= h || seen[idx(n)] {
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
    /// next Move (the sim's cadence drops early ones), fire the arrival
    /// steal. A live stop cancels the plan outright — bolting out of a stop
    /// is the FLEE answer (05c) and must never happen by queued autopilot.
    fn plan_step(&mut self) {
        if self.plan.is_none() {
            return;
        }
        let s = self.sim.snapshot();
        if s.stop.is_some() {
            self.plan = None;
            return;
        }
        let plan = self.plan.as_mut().unwrap();
        while plan.next < plan.cells.len() && plan.cells[plan.next] == s.player {
            plan.next += 1;
        }
        if plan.next == plan.cells.len() {
            if plan.steal {
                self.queue.push(self.tick, Command::Steal);
            }
            self.plan = None;
            return;
        }
        let tgt = plan.cells[plan.next];
        let (dx, dz) = (tgt.x - s.player.x, tgt.z - s.player.z);
        if dx.abs() + dz.abs() != 1 {
            // knocked off the route (shouldn't happen in v0) — replan once
            let goal = *plan.cells.last().unwrap();
            let steal = plan.steal;
            self.plan = self.bfs(s.player, goal).map(|cells| Plan { cells, next: 0, steal });
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
            let (dx, dz) = self.held_dir();
            if (dx, dz) != (0, 0) {
                self.plan = None;
                let mode = self.mode();
                self.queue.push(self.tick, Command::Move { dx, dz, mode });
            } else {
                self.plan_step();
            }
            let cmds = self.queue.drain_for(self.tick);
            self.sim.tick(self.tick, &cmds);
            self.tick.0 += 1;
            self.gait_tick();
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
        self.refresh();
    }

    /// DEMO=trace.txt (thief trace grammar): queue every command, return the
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
        println!("DEMO(thief): {n} commands, playing {ticks} ticks from {path}");
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
        }
        self.cmds_prefix = self.tick.0;
        self.refresh();
        // A replay prefix isn't gameplay to animate: snap every body to its
        // sim cell (otherwise a SHOT right after the prefix — which never
        // ticks — captures the eases mid-glide at their pre-replay cells).
        for e in &mut self.ease {
            *e = Ease::pinned(e.to);
        }
        println!("CMDS(thief): {n} commands over {ticks} ticks — state {:016x}", self.sim.state_hash());
    }

    /// Advance every body's walk cycle one fixed tick: phase runs while the
    /// body's ease is gliding, blend fades the pose in/out around it. Reads
    /// the last refreshed snapshot (at most one tick stale in live bursts —
    /// presentation-only; the DEMO path refreshes every tick).
    fn gait_tick(&mut self) {
        let now = self.tick.0;
        for i in 0..self.gait.len() {
            let e = self.ease[i];
            let moving = e.from != e.to && now <= e.start + EASE_TICKS as u64;
            let mode = if i == 0 {
                self.mode()
            } else {
                self.snap.npcs.get(i - 1).map(|n| npc_mode(n.state)).unwrap_or(MoveMode::Walk)
            };
            let (period, _) = gait_params(mode);
            let g = &mut self.gait[i];
            g.blend = (g.blend + if moving { 0.34 } else { -0.12 }).clamp(0.0, 1.0);
            if g.blend > 0.0 {
                g.phase += std::f32::consts::TAU / period;
            } else {
                g.phase = 0.0; // idle: next stride starts at heel-strike
            }
        }
    }

    fn refresh(&mut self) {
        let prev_cell = self.snap.player;
        self.snap = self.sim.snapshot();
        if self.snap.player != prev_cell {
            self.stair = !self.stair; // staircase axis flips per landed step
        }
        let now = self.tick.0;
        let p = cell_world(self.snap.player);
        let prev_to = self.ease[0].to;
        self.ease[0].retarget(p, now);
        if p != prev_to {
            let d = p - prev_to;
            if d.length_squared() > 1e-6 {
                self.face = d.x.atan2(d.z);
            }
        }
        for (i, n) in self.snap.npcs.iter().enumerate() {
            self.ease[1 + i].retarget(cell_world(n.pos), now);
        }
        // narrate the new events into the log (the module-11 projection)
        for i in self.seen_events..self.sim.events.len() {
            let s = self.sim.events[i];
            if let Some(line) = narrate(&self.spec, &s) {
                self.log_line(s.tick, line);
            }
        }
        self.seen_events = self.sim.events.len();
    }

    /// The camera's follow anchor: the eased player body.
    pub fn cam_target(&self) -> Vec3 {
        self.ease[0].at(self.tick.0)
    }

    /// Is the player inside a building? Drives the module-11 dollhouse.
    pub fn indoors(&self) -> bool {
        matches!(self.sim.grid().cell(self.snap.player).kind, CellKind::Room(_))
    }

    /// The FLOORCUT storey plane: only above ground level (upper storeys of
    /// M3+ towns come off as a cap; the ground storey keeps its roofs so
    /// buildings read as buildings from the street).
    pub fn cut_y(&self) -> Option<f32> {
        (self.snap.player.floor > 0).then_some(cut_for_floor(self.snap.player.floor))
    }

    /// The WALLCUT sill-height cutaway: on while the player is indoors —
    /// every occluder wall drops to sill height so interiors read like a
    /// dollhouse. A pure function of the player's cell (11: golden-testable).
    pub fn wall_cut(&self) -> Option<f32> {
        self.indoors().then_some(STOREY_H * self.snap.player.floor as f32 + WALL_CUT_H)
    }

    /// Sky/sun scale for the sim's day phase — the renderer visualizes the
    /// same clock the detection reads (05a's perceptual-consistency duty).
    pub fn sky(&self) -> f32 {
        match self.snap.phase {
            DayPhase::Day => 1.0,
            DayPhase::Dawn | DayPhase::Dusk => 0.55,
            DayPhase::Night => 0.16,
        }
    }

    // ---- per-frame instance skinning ------------------------------------

    /// Place one body: the Legacy kit is a single run at `base`; the
    /// articulated Refined kit (detected by its limb runs) composes core +
    /// four limbs from the gait sample. Limb transforms MUST mirror the
    /// pivot constants the builder authored the geometry around.
    #[allow(clippy::too_many_arguments)] // a body placement is genuinely this wide
    fn push_body(&self, out: &mut Vec<(InstanceKey, Mat4)>, handles: &SceneHandles, name: &str, base: Mat4, g: Gait, leg_amp: f32, arm_ratio: f32) {
        let get = |n: &str| handles.instances.get(n).copied();
        let Some(core) = get(name) else { return };
        if get(&format!("{name}/legL")).is_none() {
            out.push((core, base)); // Legacy single-run body
            return;
        }
        let (bob, leg, arm) = gait_pose(g, leg_amp, arm_ratio);
        out.push((core, base * Mat4::from_translation(Vec3::new(0.0, bob, 0.0))));
        let limb = |px: f32, py: f32, swing: f32| base * Mat4::from_translation(Vec3::new(px, py, 0.0)) * Mat4::from_rotation_x(swing);
        for (suffix, m) in [
            ("legL", limb(-LEG_X, HIP, leg)),
            ("legR", limb(LEG_X, HIP, -leg)),
            ("armL", limb(-ARM_X, SHOULDER, arm)),
            ("armR", limb(ARM_X, SHOULDER, -arm)),
        ] {
            if let Some(k) = get(&format!("{name}/{suffix}")) {
                out.push((k, m));
            }
        }
    }

    /// Hide a body entirely (the player's inactive outfit).
    fn zero_body(&self, out: &mut Vec<(InstanceKey, Mat4)>, handles: &SceneHandles, name: &str) {
        let zero = Mat4::from_scale(Vec3::ZERO);
        for n in [name.to_string(), format!("{name}/legL"), format!("{name}/legR"), format!("{name}/armL"), format!("{name}/armR")] {
            if let Some(k) = handles.instances.get(&n) {
                out.push((*k, zero));
            }
        }
    }

    pub fn instances(&self, handles: &SceneHandles) -> Vec<(InstanceKey, Mat4)> {
        let mut out = Vec::new();
        let get = |n: &str| handles.instances.get(n).copied();
        let now = self.tick.0;
        let ppos = self.ease[0].at(now);
        let active = player_run_for_look(self.sim.look());
        for run in ["tplayer_a", "tplayer_b"] {
            if run == active {
                let mut base = Mat4::from_translation(ppos) * Mat4::from_rotation_y(self.face);
                let mut g = self.gait[0];
                if self.snap.hidden {
                    // sunk into the hay: a low crouch reads as concealed
                    base *= Mat4::from_scale(Vec3::new(1.0, 0.35, 1.0));
                    g.blend = 0.0; // crouched still, not mid-stride
                }
                let (_, leg_amp) = gait_params(self.mode());
                self.push_body(&mut out, handles, run, base, g, leg_amp, 0.65);
            } else {
                self.zero_body(&mut out, handles, run);
            }
        }
        for (i, n) in self.snap.npcs.iter().enumerate() {
            let name = format!("npc_{}", n.id);
            let pos = self.ease[1 + i].at(now);
            let base = Mat4::from_translation(pos) * Mat4::from_rotation_y(facing_angle(n.facing));
            let (_, leg_amp) = gait_params(npc_mode(n.state));
            // guards swing their arms less: the spear hand stays a carry
            let arm_ratio = if n.role == Role::Guard { 0.35 } else { 0.65 };
            self.push_body(&mut out, handles, &name, base, self.gait[1 + i], leg_amp, arm_ratio);
        }
        if let Some(k) = get("loot") {
            let m = match self.snap.loot_pos {
                Some(c) => Mat4::from_translation(cell_world(c)),
                None => Mat4::from_scale(Vec3::ZERO),
            };
            out.push((k, m));
        }
        // Door leaves aren't occluders (the WALLCUT keeps them whole). While
        // indoors a CLOSED leaf crushes to the cut height — a full-height
        // slab sticking out of a sill-high wall reads as a glitch, not a
        // door — but an OPEN leaf stands inside the room like furniture and
        // keeps its height.
        let leaf_squash = if self.indoors() {
            Mat4::from_scale(Vec3::new(1.0, WALL_CUT_H / DOOR_LEAF_H, 1.0))
        } else {
            Mat4::IDENTITY
        };
        for (i, d) in self.doors.iter().enumerate() {
            if let Some(k) = get(&format!("tdoor_{i}")) {
                let open = matches!(self.sim.grid().edge(d.cell, d.dir), EdgeKind::Door(DoorState::Open));
                let m = if open {
                    door_leaf_at(d, 1.75)
                } else {
                    door_leaf_at(d, 0.0) * leaf_squash
                };
                out.push((k, m));
            }
        }
        out
    }

    // ---- the stop panel (05c), shared by draw + click hit-test ----------

    /// LMB while a stop is live: answer with the panel buttons. Swallows the
    /// click either way (a stray ground click must not read as anything).
    pub fn stop_click(&mut self, win: Vec2, ext: (u32, u32), rs: u32) -> bool {
        if self.snap.stop.is_none() {
            return false;
        }
        let (ox, oy, bs) = stop_origin(ext.0 as i64, ext.1 as i64, rs);
        for (i, (bx, by, bw, bh)) in stop_buttons().into_iter().enumerate() {
            let (x0, y0) = (ox + bx as i64 * bs as i64, oy + by as i64 * bs as i64);
            let (x1, y1) = (x0 + bw as i64 * bs as i64, y0 + bh as i64 * bs as i64);
            if (win.x as i64) >= x0 && (win.x as i64) < x1 && (win.y as i64) >= y0 && (win.y as i64) < y1 {
                let choice = STOP_CHOICES[i];
                if choice == StopChoice::Bribe && self.snap.coin < BRIBE_COST {
                    return true; // greyed: purse too light
                }
                self.push(Command::Stop(choice));
                return true;
            }
        }
        true
    }

    // ---- the stealth-read HUD (stamps; ride into SHOT/DEMO captures) ----

    pub fn stamps(&self, xf: &ViewXform, ext: (u32, u32), rs: u32) -> Vec<Stamp> {
        let mut out = Vec::new();
        let (ext_w, ext_h) = (ext.0 as i64, ext.1 as i64);
        let s = rs.max(1) as i64;
        let now = self.tick.0;
        // per-NPC alertness bubbles (the ladder, made watchable — 08/11)
        for (i, n) in self.snap.npcs.iter().enumerate() {
            let Some((label, accent)) = bubble_for(n.state) else { continue };
            let (pix, w, h) = bubble(label, accent);
            let pos = self.ease[1 + i].at(now);
            let win = world_to_window_px(pos + Vec3::new(0.0, 1.55, 0.0), xf);
            if win.x < -60.0 || win.y < -60.0 || win.x > ext_w as f32 + 60.0 || win.y > ext_h as f32 + 60.0 {
                continue;
            }
            let x = (win.x as i64 - (w as i64 * s) / 2).clamp(2, ext_w - w as i64 * s - 2);
            let y = (win.y as i64 - h as i64 * s).clamp(2, ext_h - h as i64 * s - 2);
            out.push(Stamp { pix, w, h, x, y, scale: rs });
        }
        // the click-to-move destination marker: a pulsing tag over the goal
        // cell ("$" when the goal is the loot — arriving lifts it)
        if let Some(plan) = &self.plan {
            let goal = *plan.cells.last().unwrap();
            let accent = if (now / 8).is_multiple_of(2) { AMBER } else { INK };
            let (pix, w, h) = bubble(if plan.steal { "$" } else { ">" }, accent);
            let win = world_to_window_px(cell_world(goal) + Vec3::new(0.0, 0.55, 0.0), xf);
            if win.x > -60.0 && win.y > -60.0 && win.x < ext_w as f32 + 60.0 && win.y < ext_h as f32 + 60.0 {
                let x = (win.x as i64 - (w as i64 * s) / 2).clamp(2, ext_w - w as i64 * s - 2);
                let y = (win.y as i64 - h as i64 * s).clamp(2, ext_h - h as i64 * s - 2);
                out.push(Stamp { pix, w, h, x, y, scale: rs });
            }
        }
        // the Fallout-style bottom bar: event LOG left, status cluster right
        out.push(self.bottom_bar(ext_w, ext_h, rs));
        // the stop panel (05c): the guard's question and your outs as buttons
        if let Some(stop) = self.snap.stop {
            let (pix, w, h) = self.stop_panel(stop.ticks_left);
            let (ox, oy, bs) = stop_origin(ext_w, ext_h, rs);
            out.push(Stamp { pix, w, h, x: ox, y: oy, scale: bs });
        }
        out
    }

    /// The full-width bottom bar (module 11's readable event log, locked as
    /// Fallout-1/2 style): last log lines word-wrapped with day-clock
    /// prefixes; the status cluster (clock/phase, coin, load, exposure,
    /// heat) boxed on the right.
    fn bottom_bar(&self, ext_w: i64, ext_h: i64, rs: u32) -> Stamp {
        let mut bs = rs.max(1);
        while bs > 1 && ext_w / (bs as i64) < 300 {
            bs -= 1;
        }
        let w = (ext_w / bs as i64) as i32;
        const H: i32 = 58;
        const SW: i32 = 152; // status cluster width
        let mut c = plate(w, H, BG, BORDER);
        let sx = (w - SW).max(0);
        mrect(&mut c, w, sx - 2, 1, 1, H - 2, BORDER);
        // -- status cluster
        let phase = match self.snap.phase {
            DayPhase::Dawn => "DAWN",
            DayPhase::Day => "DAY",
            DayPhase::Dusk => "DUSK",
            DayPhase::Night => "NIGHT",
        };
        let row1 = format!("{:02}:{:02} {}", self.snap.day_min / 60, self.snap.day_min % 60, phase);
        mtext(&mut c, w, sx + 6, 5, &row1, INK);
        let coin = format!("{}C", self.snap.coin);
        mtext(&mut c, w, w - 6 - coin.len() as i32 * 8, 5, &coin, AMBER);
        let cap = self.spec.carry_capacity.map(|v| v.to_string()).unwrap_or_else(|| "-".into());
        mtext(&mut c, w, sx + 6, 18, &format!("LOAD {}/{cap}", self.snap.load), DIMTX);
        let light = if self.snap.hidden {
            "HIDDEN"
        } else if self.snap.light < DARK_LIGHT {
            "DARK"
        } else if self.snap.light < DIM_LIGHT {
            "DIM"
        } else {
            "LIT"
        };
        let lcol = match light {
            "HIDDEN" | "DARK" => GREEN,
            "DIM" => AMBER,
            _ => RED,
        };
        mtext(&mut c, w, w - 6 - light.len() as i32 * 8, 18, light, lcol);
        mtext(&mut c, w, sx + 6, 33, "HEAT", DIMTX);
        let track = SW - 50;
        let frac = (self.snap.scrutiny.clamp(0, 60) as f32 / 60.0 * track as f32) as i32;
        mrect(&mut c, w, sx + 42, 34, track, 6, 0x30303a);
        mrect(&mut c, w, sx + 42, 34, frac, 6, if self.snap.scrutiny >= 15 { RED } else { GREEN });
        // -- the event log (newest line bright, older lines dimmed)
        let cols = (((sx - 12) / 8).max(10)) as usize;
        const ROWS: usize = 5;
        let mut rows: Vec<(String, bool)> = Vec::new();
        'gather: for (i, line) in self.log.iter().enumerate().rev() {
            let newest = i + 1 == self.log.len();
            for r in wrap(line, cols).into_iter().rev() {
                rows.push((r, newest));
                if rows.len() == ROWS {
                    break 'gather;
                }
            }
        }
        rows.reverse();
        for (row, (txt, newest)) in rows.iter().enumerate() {
            let col = if *newest { INK } else if row + 2 >= rows.len() { DIMTX } else { FAINT };
            mtext(&mut c, w, 6, 4 + row as i32 * 10, &sanitize(txt, cols), col);
        }
        Stamp { pix: c, w, h: H, x: (ext_w - w as i64 * bs as i64) / 2, y: ext_h - (H as i64) * bs as i64, scale: bs }
    }

    /// The stop panel canvas: STAND FAST, four answer buttons, the patience
    /// bar. Button rects come from `stop_buttons` — the same table the click
    /// hit-test reads.
    fn stop_panel(&self, ticks_left: u64) -> (Vec<u32>, i32, i32) {
        let mut c = plate(STOP_W, STOP_H, 0x1a1016, RED);
        mrect(&mut c, STOP_W, 1, 1, STOP_W - 2, 1, RED);
        mtext(&mut c, STOP_W, (STOP_W - 10 * 8) / 2, 6, "STAND FAST", RED);
        let can_pay = self.snap.coin >= BRIBE_COST;
        for (i, (bx, by, bw, bh)) in stop_buttons().into_iter().enumerate() {
            let enabled = STOP_CHOICES[i] != StopChoice::Bribe || can_pay;
            let (border, ink) = if enabled { (BORDER, INK) } else { (0x3a3a44, 0x565664) };
            mrect(&mut c, STOP_W, bx, by, bw, 1, border);
            mrect(&mut c, STOP_W, bx, by + bh - 1, bw, 1, border);
            mrect(&mut c, STOP_W, bx, by, 1, bh, border);
            mrect(&mut c, STOP_W, bx + bw - 1, by, 1, bh, border);
            let label = STOP_LABELS[i];
            mtext(&mut c, STOP_W, bx + (bw - label.len() as i32 * 8) / 2, by + 4, label, ink);
        }
        let track = STOP_W - 16;
        let frac = (ticks_left as f32 / STOP_DECIDE_TICKS as f32 * track as f32) as i32;
        mrect(&mut c, STOP_W, 8, STOP_H - 9, track, 5, 0x30303a);
        mrect(&mut c, STOP_W, 8, STOP_H - 9, frac, 5, AMBER);
        (c, STOP_W, STOP_H)
    }
}

const STOP_W: i32 = 332;
const STOP_H: i32 = 60;
const STOP_CHOICES: [StopChoice; 4] = [StopChoice::Bluff, StopChoice::Bribe, StopChoice::Submit, StopChoice::Flee];
const STOP_LABELS: [&str; 4] = ["1 BLUFF", "2 BRIBE", "3 YIELD", "4 RUN"];

/// The four stop buttons' local rects (x, y, w, h) inside the panel.
fn stop_buttons() -> [(i32, i32, i32, i32); 4] {
    let mut out = [(0, 0, 0, 0); 4];
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = (8 + i as i32 * 80, 20, 76, 16);
    }
    out
}

/// Window-space origin + integer scale of the stop panel.
fn stop_origin(ext_w: i64, ext_h: i64, rs: u32) -> (i64, i64, u32) {
    let bs = fit_scale(STOP_W, rs, ext_w);
    ((ext_w - STOP_W as i64 * bs as i64) / 2, ext_h / 4, bs)
}

fn facing_angle(d: Dir) -> f32 {
    match d {
        Dir::Zp => 0.0,
        Dir::Xp => std::f32::consts::FRAC_PI_2,
        Dir::Zm => std::f32::consts::PI,
        Dir::Xm => -std::f32::consts::FRAC_PI_2,
    }
}

/// The ladder, as a glanceable glyph (08: legible alertness IS the loop).
fn bubble_for(state: NpcState) -> Option<(&'static str, u32)> {
    match state {
        NpcState::Routine => None,
        NpcState::Notice => Some(("?", 0xe0c060)),
        NpcState::Investigate => Some(("?!", 0xf0a050)),
        NpcState::Reporting => Some(("TELL", 0x9ab8e0)),
        NpcState::Approach => Some(("HALT", RED)),
        NpcState::Confront => Some(("!", RED)),
        NpcState::Pursue => Some(("!!", 0xe83b46)),
    }
}

/// A bordered plate (the hud.rs primitive, local copy — hud's is private).
fn plate(w: i32, h: i32, bg: u32, border: u32) -> Vec<u32> {
    let mut c = vec![bg; (w * h) as usize];
    mrect(&mut c, w, 0, 0, w, 1, border);
    mrect(&mut c, w, 0, h - 1, w, 1, border);
    mrect(&mut c, w, 0, 0, 1, h, border);
    mrect(&mut c, w, w - 1, 0, 1, h, border);
    c
}

/// A speech bubble with a tail (hud::bubble's shape, thief labels).
fn bubble(label: &str, accent: u32) -> (Vec<u32>, i32, i32) {
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

/// 8×8-font-safe ASCII, truncated to `cols` (the font has no idea what an
/// em-dash is).
fn sanitize(s: &str, cols: usize) -> String {
    s.chars()
        .map(|ch| match ch {
            '—' | '–' => '-',
            '’' | '‘' => '\'',
            '“' | '”' => '"',
            c if c.is_ascii() => c,
            _ => '?',
        })
        .take(cols)
        .collect()
}

/// Word-wrap `s` to `cols` columns; continuation rows are indented under
/// the day-clock prefix.
fn wrap(s: &str, cols: usize) -> Vec<String> {
    let mut rows = Vec::new();
    let mut cur = String::new();
    for word in s.split_whitespace() {
        let sep = if cur.is_empty() || cur.ends_with(' ') { 0 } else { 1 };
        if !cur.trim().is_empty() && cur.chars().count() + sep + word.chars().count() > cols {
            rows.push(std::mem::take(&mut cur));
            cur = "       ".into(); // hang under "HH:MM  "
        }
        if sep == 1 {
            cur.push(' ');
        }
        cur.push_str(word);
    }
    if !cur.trim().is_empty() {
        rows.push(cur);
    }
    if rows.is_empty() {
        rows.push(String::new());
    }
    rows
}

/// Largest integer stamp scale ≤ rs that fits (hud.rs's rule).
fn fit_scale(w: i32, rs: u32, ext_w: i64) -> u32 {
    let mut bs = rs.max(1);
    while bs > 1 && (w as i64) * bs as i64 > ext_w - 8 {
        bs -= 1;
    }
    bs
}

#[cfg(test)]
mod tests {
    use super::*;
    use house_game::thief::sim::spine_level;

    /// W means SCREEN up: the iso staircase alternates axes per LANDED step
    /// at the sim's cadence (never one cell per tick, never a straight
    /// grid-axis line).
    #[test]
    fn held_w_walks_screen_up_the_staircase_at_the_sims_cadence() {
        let mut t = ThiefLoop::new(spine_level());
        t.held[0] = true;
        let (x0, z0) = (t.snap.player.x, t.snap.player.z);
        for _ in 0..64 {
            t.run_due(TICK_DT);
        }
        let (dx, dz) = (x0 - t.snap.player.x, z0 - t.snap.player.z);
        // walk period 8 → 8 steps in 64 ticks (ticks 0,8,…,56)
        assert_eq!(dx + dz, 8, "64 ticks of held walk must land 8 grid steps");
        assert!((dx - dz).abs() <= 1, "screen-up must stair-step both axes: dx={dx} dz={dz}");
    }

    /// Two adjacent screen keys cancel to a pure world axis (up+right = -Z).
    #[test]
    fn screen_diagonal_keys_walk_a_pure_world_axis() {
        let mut t = ThiefLoop::new(spine_level());
        t.held[0] = true; // up
        t.held[3] = true; // right
        let (x0, z0) = (t.snap.player.x, t.snap.player.z);
        for _ in 0..64 {
            t.run_due(TICK_DT);
        }
        assert_eq!(t.snap.player.x, x0, "up+right is pure -Z at yaw 0");
        assert_eq!((z0 - t.snap.player.z) as i64, 8);
    }

    /// Bodies ease between cells but always ARRIVE (presentation never
    /// desyncs from sim truth).
    #[test]
    fn ease_converges_on_the_sim_cell() {
        let mut t = ThiefLoop::new(spine_level());
        t.held[0] = true;
        for _ in 0..30 {
            t.run_due(TICK_DT);
        }
        t.held[0] = false;
        for _ in 0..30 {
            t.run_due(TICK_DT);
        }
        let eased = t.cam_target();
        let truth = cell_world(t.snap.player);
        assert!((eased - truth).length() < 1e-4, "ease must settle on the cell: {eased} vs {truth}");
    }

    /// The mouse loop end-to-end: click the strongbox from the street — the
    /// plan routes through both doors (the sim opens them in passing),
    /// arrives, and lifts the loot. Replay stays pure Move/Steal commands.
    #[test]
    fn click_on_the_loot_plans_a_route_and_steals_on_arrival() {
        let mut t = ThiefLoop::new(spine_level());
        let loot = t.snap.loot_pos.expect("the spine starts with loot placed");
        t.click_ground(cell_world(loot));
        assert!(t.plan.is_some(), "the loot must be BFS-reachable from the start");
        for _ in 0..600 {
            t.run_due(TICK_DT);
        }
        assert!(t.snap.carrying, "the plan must reach the strongbox and lift it");
        assert!(t.plan.is_none(), "a finished plan clears");
    }

    /// Clicking a wall-locked void cell or clicking during a stop is inert.
    #[test]
    fn invalid_clicks_leave_no_plan() {
        let mut t = ThiefLoop::new(spine_level());
        t.click_ground(Vec3::new(-3.0, 0.0, 5.0)); // off the map
        assert!(t.plan.is_none());
        t.click_ground(cell_world(t.snap.player)); // own cell: cancel, no plan
        assert!(t.plan.is_none());
    }

    /// The stop buttons tile inside the panel without overlap — the click
    /// hit-test and the drawn plate share this table.
    #[test]
    fn stop_buttons_tile_inside_the_panel() {
        let btns = stop_buttons();
        for (i, (x, y, w, h)) in btns.into_iter().enumerate() {
            assert!(x >= 0 && y >= 0 && x + w <= STOP_W && y + h <= STOP_H, "button {i} inside panel");
            if i > 0 {
                let (px, _, pw, _) = btns[i - 1];
                assert!(px + pw <= x, "button {i} must not overlap its neighbour");
            }
        }
    }

    #[test]
    fn log_lines_render_font_safe_and_wrap_with_indent() {
        assert_eq!(sanitize("a — b ’x’", 40), "a - b 'x'");
        assert_eq!(sanitize("abcdef", 3), "abc");
        let rows = wrap("06:12  the watch now hunts a hooded figure in green", 24);
        assert!(rows.len() >= 2, "must wrap: {rows:?}");
        assert!(rows[0].chars().count() <= 24);
        assert!(rows[1].starts_with("       "), "continuation hangs under the clock prefix");
    }

    /// The walk cycle lives on the fixed clock: gait blends in while the
    /// body walks, swings the legs in antiphase, and settles back to the
    /// rest pose (blend 0) after the last ease lands.
    #[test]
    fn gait_swings_while_walking_and_settles_at_rest() {
        let mut t = ThiefLoop::new(spine_level());
        t.held[0] = true;
        for _ in 0..24 {
            t.run_due(TICK_DT);
        }
        let g = t.gait[0];
        assert!(g.blend > 0.9, "mid-walk the pose must be fully blended in (blend={})", g.blend);
        let (_, leg, arm) = gait_pose(g, 0.5, 0.65);
        assert!(leg.abs() <= 0.5 && arm.abs() <= 0.5 * 0.65);
        // legs are antiphase by construction (push_body negates the swing);
        // the pose itself must be non-degenerate somewhere in the cycle
        let mut peak: f32 = 0.0;
        for _ in 0..16 {
            t.run_due(TICK_DT);
            let (_, l, _) = gait_pose(t.gait[0], 0.5, 0.65);
            peak = peak.max(l.abs());
        }
        assert!(peak > 0.3, "a full cycle must reach a visible swing (peak={peak})");
        t.held[0] = false;
        for _ in 0..40 {
            t.run_due(TICK_DT);
        }
        assert_eq!(t.gait[0].blend, 0.0, "idle must settle to the rest pose");
        assert_eq!(t.gait[0].phase, 0.0, "the next stride restarts at heel-strike");
    }

    /// Articulated bodies emit five runs with mirrored leg swings; the
    /// inactive outfit's five runs are all zeroed.
    #[test]
    fn articulated_instances_mirror_legs_and_zero_the_spare_outfit() {
        use std::collections::BTreeMap;
        let mut t = ThiefLoop::new(spine_level());
        t.held[0] = true;
        for _ in 0..20 {
            t.run_due(TICK_DT);
        }
        let mut instances = BTreeMap::new();
        let mut names = vec!["loot".to_string(), "tdoor_0".to_string(), "tdoor_1".to_string()];
        for body in ["tplayer_a", "tplayer_b", "npc_1", "npc_2"] {
            names.push(body.to_string());
            for limb in ["legL", "legR", "armL", "armR"] {
                names.push(format!("{body}/{limb}"));
            }
        }
        for (i, n) in names.iter().enumerate() {
            instances.insert(n.clone(), InstanceKey::from_index(i as u32));
        }
        let handles = SceneHandles { lights: BTreeMap::new(), instances };
        let out = t.instances(&handles);
        let get = |name: &str| {
            let k = handles.instances[name];
            out.iter().find(|(ik, _)| *ik == k).map(|(_, m)| *m).unwrap()
        };
        // the active (hooded) body walks: legs swing in antiphase
        let (ll, lr) = (get("tplayer_a/legL"), get("tplayer_a/legR"));
        let swing = |m: Mat4| {
            let z = m.transform_vector3(Vec3::Z);
            z.y.atan2(z.z)
        };
        assert!((swing(ll) + swing(lr)).abs() < 1e-5, "legs must mirror");
        assert!(swing(ll).abs() > 0.05, "mid-walk legs must be off rest");
        // the spare outfit is fully hidden — every run zero-scaled
        for limb in ["", "/legL", "/legR", "/armL", "/armR"] {
            let m = get(&format!("tplayer_b{limb}"));
            assert_eq!(m.transform_vector3(Vec3::ONE), Vec3::ZERO, "spare outfit run tplayer_b{limb} must be zeroed");
        }
    }
}
