//! The thief sim side of the viewer (M2 playable slice): a fixed-tick
//! `ThiefGame` loop + the snapshot→renderer adapter for SCENE=thief. The
//! twin of `sim.rs::GameLoop` for the thief `Simulation` — the house
//! GameLoop still exists on this scene as an idle light-join mirror; all
//! play routes here.
//!
//! Presentation choices, all sim-blind:
//! - the sim steps whole cells at its own cadence; the shell EASES bodies
//!   between cells over a few ticks (tick-clocked, so DEMO captures ease
//!   identically),
//! - the stealth read is stamps (docs/spec/11): per-NPC alertness bubbles,
//!   the status plate (clock/coin/load/exposure), the scrolling event LOG
//!   (the sim's narrated stream, verbatim), and the stop panel with the
//!   05c outs. Stamps burn into SHOT/DEMO captures.

use crate::backend::Stamp;
use crate::menu::{mrect, mtext};
use crate::thief_scene::{cell_world, cut_for_floor, door_leaf_at, door_runs, player_run_for_look, DoorRun};
use glam::{Mat4, Vec3};
use house_game::thief::grid::{Dir, DoorState, EdgeKind};
use house_game::thief::log::narrate;
use house_game::thief::sim::{
    Command, DayPhase, MoveMode, NpcState, ThiefGame, ThiefSnapshot, ThiefSpec, BRIBE_COST,
    DARK_LIGHT, DIM_LIGHT, STOP_DECIDE_TICKS,
};
use house_game::thief::trace::parse_trace;
use house_game::TICK_DT;
use iso_core::{world_to_window_px, ViewXform};
use rt_probe::{Config, InstanceKey, SceneHandles};
use sim_core::{FixedLoop, InputQueue, Simulation, Tick};

/// Ticks a body glides between cells (presentation-only, tick-clocked).
const EASE_TICKS: f32 = 7.0;

const BG: u32 = 0x14141a;
const BORDER: u32 = 0x565664;
const AMBER: u32 = 0xe0a84c;
const RED: u32 = 0xe86858;
const GREEN: u32 = 0x8fd08f;
const INK: u32 = 0xd0d0c0;
const DIMTX: u32 = 0x9a9aa2;

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
    /// The prose event log (module 11) — narrated sim events, in order.
    pub log: Vec<String>,
    seen_events: usize,
    doors: Vec<DoorRun>,
    /// Eased world positions: [player, npcs in snapshot order...].
    ease: Vec<Ease>,
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
        let p0 = cell_world(snap.player);
        ThiefLoop {
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
            ease,
            face: 0.0,
            last_cam: p0,
        }
    }

    pub fn push(&mut self, c: Command) {
        self.queue.push(self.tick, c);
    }

    pub fn time(&self) -> f32 {
        self.tick.0 as f32 * TICK_DT
    }

    /// Held keys → one grid step direction (screen-relative, rotated to the
    /// camera quarter; both axes held alternates by tick parity — a clean
    /// staircase diagonal on the cell grid).
    fn held_dir(&self) -> (i16, i16) {
        let sx = self.held[3] as i16 - self.held[2] as i16; // screen right
        let sy = self.held[1] as i16 - self.held[0] as i16; // screen down
        let (mut dx, mut dz) = if sx != 0 && sy != 0 {
            if self.tick.0.is_multiple_of(2) {
                (sx, 0)
            } else {
                (0, sy)
            }
        } else {
            (sx, sy)
        };
        // rotate screen axes onto world grid axes by the camera quarter
        for _ in 0..(self.yaw_q % 4) {
            let (nx, nz) = (dz, -dx);
            dx = nx;
            dz = nz;
        }
        (dx, dz)
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

    /// Advance the accumulator and run the due ticks; held keys synthesize
    /// one Move per tick (the SIM owns the step cadence and drops extras).
    pub fn run_due(&mut self, real_dt: f32) -> u32 {
        let n = self.fixed.advance(real_dt);
        for _ in 0..n {
            let (dx, dz) = self.held_dir();
            if (dx, dz) != (0, 0) {
                let mode = self.mode();
                self.queue.push(self.tick, Command::Move { dx, dz, mode });
            }
            let cmds = self.queue.drain_for(self.tick);
            self.sim.tick(self.tick, &cmds);
            self.tick.0 += 1;
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
        println!("CMDS(thief): {n} commands over {ticks} ticks — state {:016x}", self.sim.state_hash());
    }

    fn refresh(&mut self) {
        self.snap = self.sim.snapshot();
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
        for s in &self.sim.events[self.seen_events..] {
            if let Some(line) = narrate(&self.spec, s) {
                self.log.push(line);
            }
        }
        self.seen_events = self.sim.events.len();
    }

    /// The camera's follow anchor: the eased player body.
    pub fn cam_target(&self) -> Vec3 {
        self.ease[0].at(self.tick.0)
    }

    /// The live FLOORCUT plane: a pure function of the player's storey.
    pub fn cut_y(&self) -> f32 {
        cut_for_floor(self.snap.player.floor)
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

    pub fn instances(&self, handles: &SceneHandles) -> Vec<(InstanceKey, Mat4)> {
        let mut out = Vec::new();
        let get = |n: &str| handles.instances.get(n).copied();
        let now = self.tick.0;
        let ppos = self.ease[0].at(now);
        let active = player_run_for_look(self.sim.look());
        for run in ["tplayer_a", "tplayer_b"] {
            if let Some(k) = get(run) {
                let m = if run == active {
                    let base = Mat4::from_translation(ppos) * Mat4::from_rotation_y(self.face);
                    if self.snap.hidden {
                        // sunk into the hay: a low crouch reads as concealed
                        base * Mat4::from_scale(Vec3::new(1.0, 0.35, 1.0))
                    } else {
                        base
                    }
                } else {
                    Mat4::from_scale(Vec3::ZERO)
                };
                out.push((k, m));
            }
        }
        for (i, n) in self.snap.npcs.iter().enumerate() {
            if let Some(k) = get(&format!("npc_{}", n.id)) {
                let pos = self.ease[1 + i].at(now);
                out.push((k, Mat4::from_translation(pos) * Mat4::from_rotation_y(facing_angle(n.facing))));
            }
        }
        if let Some(k) = get("loot") {
            let m = match self.snap.loot_pos {
                Some(c) => Mat4::from_translation(cell_world(c)),
                None => Mat4::from_scale(Vec3::ZERO),
            };
            out.push((k, m));
        }
        for (i, d) in self.doors.iter().enumerate() {
            if let Some(k) = get(&format!("tdoor_{i}")) {
                let open = matches!(self.sim.grid().edge(d.cell, d.dir), EdgeKind::Door(DoorState::Open));
                out.push((k, door_leaf_at(d, if open { 1.75 } else { 0.0 })));
            }
        }
        out
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
        // status plate: clock/phase/coin, load + exposure flags, scrutiny bar
        {
            const W: i32 = 168;
            const H: i32 = 42;
            let mut c = plate(W, H, BG, BORDER);
            let phase = match self.snap.phase {
                DayPhase::Dawn => "DAWN",
                DayPhase::Day => "DAY",
                DayPhase::Dusk => "DUSK",
                DayPhase::Night => "NIGHT",
            };
            let row1 = format!("{:02}:{:02} {}  {}C", self.snap.day_min / 60, self.snap.day_min % 60, phase, self.snap.coin);
            mtext(&mut c, W, 4, 4, &row1, INK);
            let cap = self.spec.carry_capacity.map(|v| v.to_string()).unwrap_or_else(|| "-".into());
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
            mtext(&mut c, W, 4, 15, &format!("LOAD {}/{cap}", self.snap.load), DIMTX);
            mtext(&mut c, W, W - 4 - light.len() as i32 * 8, 15, light, lcol);
            mtext(&mut c, W, 4, 28, "HEAT", DIMTX);
            let track = W - 44;
            let frac = (self.snap.scrutiny.clamp(0, 60) as f32 / 60.0 * track as f32) as i32;
            mrect(&mut c, W, 38, 29, track, 6, 0x30303a);
            mrect(&mut c, W, 38, 29, frac, 6, if self.snap.scrutiny >= 15 { RED } else { GREEN });
            out.push(Stamp { pix: c, w: W, h: H, x: 6, y: 6, scale: fit_scale(W, rs, ext_w) });
        }
        // the event LOG (module 11): the last five narrated lines
        if !self.log.is_empty() {
            const COLS: i32 = 58;
            const W: i32 = 8 + COLS * 8;
            let n = self.log.len().min(5);
            let h = 8 + n as i32 * 10;
            let mut c = plate(W, h, BG, BORDER);
            for (row, line) in self.log[self.log.len() - n..].iter().enumerate() {
                let last = row == n - 1;
                let txt = sanitize(line, COLS as usize);
                mtext(&mut c, W, 4, 4 + row as i32 * 10, &txt, if last { INK } else { DIMTX });
            }
            let bs = fit_scale(W, rs, ext_w);
            out.push(Stamp { pix: c, w: W, h, x: 6, y: ext_h - h as i64 * bs as i64 - 6, scale: bs });
        }
        // the stop panel (05c): the guard's question and your outs
        if let Some(stop) = self.snap.stop {
            const W: i32 = 288;
            const H: i32 = 46;
            let mut c = plate(W, H, 0x1a1016, RED);
            mrect(&mut c, W, 1, 1, W - 2, 1, RED);
            mtext(&mut c, W, (W - 10 * 8) / 2, 5, "STAND FAST", RED);
            let can_pay = self.snap.coin >= BRIBE_COST;
            mtext(&mut c, W, 8, 18, "1 BLUFF  2 BRIBE  3 SUBMIT  4 RUN", INK);
            if !can_pay {
                mtext(&mut c, W, 8 + 9 * 8, 18, "2 BRIBE", 0x565664); // greyed: purse too light
            }
            let track = W - 16;
            let frac = (stop.ticks_left as f32 / STOP_DECIDE_TICKS as f32 * track as f32) as i32;
            mrect(&mut c, W, 8, 34, track, 5, 0x30303a);
            mrect(&mut c, W, 8, 34, frac, 5, AMBER);
            let bs = fit_scale(W, rs, ext_w);
            let x = (ext_w - W as i64 * bs as i64) / 2;
            out.push(Stamp { pix: c, w: W, h: H, x, y: ext_h / 4, scale: bs });
        }
        out
    }
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

    /// The loop's held-key synthesis is sim-gated: holding a direction for a
    /// second walks exactly the sim's cadence, not one cell per tick.
    #[test]
    fn held_walk_steps_at_the_sims_cadence() {
        let mut t = ThiefLoop::new(spine_level());
        t.held[2] = true; // walk screen-left = west at yaw 0
        let x0 = t.snap.player.x;
        for _ in 0..60 {
            t.run_due(TICK_DT);
        }
        let steps = (x0 - t.snap.player.x) as i64;
        // walk period 8 → 60 ticks fit 8 steps (ticks 0,8,…,56)
        assert_eq!(steps, 8, "60 ticks of held walk must land 8 grid steps");
    }

    /// Bodies ease between cells but always ARRIVE (presentation never
    /// desyncs from sim truth).
    #[test]
    fn ease_converges_on_the_sim_cell() {
        let mut t = ThiefLoop::new(spine_level());
        t.held[2] = true;
        for _ in 0..30 {
            t.run_due(TICK_DT);
        }
        t.held[2] = false;
        for _ in 0..30 {
            t.run_due(TICK_DT);
        }
        let eased = t.cam_target();
        let truth = cell_world(t.snap.player);
        assert!((eased - truth).length() < 1e-4, "ease must settle on the cell: {eased} vs {truth}");
    }

    #[test]
    fn log_lines_render_font_safe() {
        assert_eq!(sanitize("a — b ’x’", 40), "a - b 'x'");
        assert_eq!(sanitize("abcdef", 3), "abc");
    }
}
