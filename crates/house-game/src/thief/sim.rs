//! The M1 spine: a playable-in-trace `ThiefGame` simulation
//! (docs/spec/12 — "M1 · The spine, headless").
//!
//! Greybox scope, whole spine: a player with a describable look moves through
//! an edge-gated level; NPCs sense (cones + LOS + the CPU light field, 05a),
//! remember, and report with real travel latency (05b's "race the rumor");
//! reported observations correlate into Cases; a guard who later SEES someone
//! matching a live profile past the scrutiny threshold starts hunting (05c's
//! notice→approach, v0: straight to pursuit). The alertness ladder (08) —
//! fast rise, slow decay to a heightened baseline — arbitrates NPC behavior
//! over their routine.
//!
//! Determinism: all integer state; NPCs iterate in spec order; observations
//! ingest in (tick, npc-order) order; movement/pathing is BFS with a fixed
//! direction order. `state_hash` is a portable replay oracle.

use super::deduction::CaseFile;
use super::grid::{CellField, CellPos, Dir, DoorState, EdgeKind, Passage, TownGrid, DIRS, LOUD_WALK};
use super::perception::{ActionKind, Description, Feature, Headwear, Hue, NpcId, Observation, Source};
use sim_core::{Simulation, Tick};

// ---------------------------------------------------------------------------
// Tunables (integers; sim-affecting ones belong to the spec / trace header)
// ---------------------------------------------------------------------------

/// NPC vision range, cells (Chebyshev), inside a 90° facing cone.
pub const VISION_RANGE: i32 = 8;
/// Minimum read clarity for a sighting to register at all.
pub const CONF_GATE: i32 = 25;
/// A memory this alarming sends a civilian off to report it.
pub const REPORT_SALIENCE: u8 = 60;
/// Scrutiny at/above this and an authority moves to stop/pursue (05c).
pub const STOP_SCRUTINY: i32 = 15;
/// NPCs take one grid step per this many ticks.
pub const MOVE_PERIOD: u64 = 12;
/// An NPC re-records a continuously-visible subject doing the SAME thing at
/// most this often; a change of action registers immediately. (Staring is
/// one memory, not sixty a second.)
pub const OBS_PERIOD: u64 = 60;
/// Alertness decays one point per this many ticks.
pub const ALERT_DECAY_PERIOD: u64 = 30;
/// Light level below which a sighting is heavily degraded (night stealth).
pub const DIM_LIGHT: i32 = 4;
pub const DARK_LIGHT: i32 = 2;
/// Secondhand confidence: reported observations keep 3/4 of their clarity.
const SECONDHAND_NUM: u32 = 3;
const SECONDHAND_DEN: u32 = 4;

// ---------------------------------------------------------------------------
// Spec — the level source of truth (ordered Vecs only)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Role {
    Guard,
    Civilian,
}

#[derive(Clone, Debug)]
pub struct NpcSpec {
    pub id: NpcId,
    pub role: Role,
    pub start: CellPos,
    pub facing: Dir,
    /// Waypoint loop for guards; a civilian stays near `start` (v0 routine —
    /// module 04 schedules replace this at M3).
    pub patrol: Vec<CellPos>,
}

#[derive(Clone)]
pub struct ThiefSpec {
    pub grid: TownGrid,
    pub player_start: CellPos,
    /// The player's ground-truth look — every field Seen (module 06's worn
    /// state; observers down-grade it to partial Descriptions).
    pub player_look: Description,
    pub npcs: Vec<NpcSpec>,
    /// The stealable target (M1: one strongbox cell).
    pub target: CellPos,
    /// Static light sources (cell, intensity) — the sim-side light field.
    pub lights: Vec<(CellPos, i32)>,
    pub seed: u64,
}

// ---------------------------------------------------------------------------
// Commands & events
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Command {
    /// Step one cell (dx, dz ∈ {-1,0,1}, one axis only in v0).
    Move { dx: i16, dz: i16 },
    /// Take the target if standing on it.
    Steal,
    /// Change worn layers (v0: anywhere; M4 adds witnessed-change).
    Outfit { top: Hue, headwear: Headwear },
    Wait,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum GameEvent {
    Stole { at: CellPos },
    Seen { by: NpcId, action: ActionKind, salience: u8 },
    Reported { by: NpcId, to: NpcId, count: u8 },
    CaseOpened { id: u16 },
    HuntStarted { guard: NpcId },
}

// ---------------------------------------------------------------------------
// NPC runtime state — the alertness ladder (module 08)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum NpcState {
    Routine,
    Notice,
    Investigate,
    /// Civilian: traveling to tell a guard what they saw.
    Reporting,
    /// Guard: actively hunting a matching suspect (the M1 gate state).
    Pursue,
}

impl NpcState {
    fn code(self) -> u8 {
        match self {
            NpcState::Routine => 0,
            NpcState::Notice => 1,
            NpcState::Investigate => 2,
            NpcState::Reporting => 3,
            NpcState::Pursue => 4,
        }
    }
}

#[derive(Clone, Debug)]
struct Npc {
    spec: NpcSpec,
    pos: CellPos,
    facing: Dir,
    state: NpcState,
    /// 0..=100; fast rise, slow decay to `baseline`.
    alertness: i32,
    /// Heightened floor after a real scare (08: never back to oblivious).
    baseline: i32,
    /// Personal memory: everything this NPC perceived (05b ground truth).
    memory: Vec<Observation>,
    /// How many of `memory` have been handed to the authorities.
    reported: usize,
    /// Where the current stimulus points (investigate / pursue anchor).
    stimulus: Option<CellPos>,
    waypoint: usize,
    /// (tick, action, confidence) of this NPC's last recorded sighting of
    /// the player — the re-notice cooldown.
    last_obs: Option<(u64, ActionKind, u8)>,
}

// ---------------------------------------------------------------------------
// The game
// ---------------------------------------------------------------------------

pub struct ThiefGame {
    spec: ThiefSpec,
    grid: TownGrid,
    light: CellField,
    player: CellPos,
    look: Description,
    carrying: bool,
    /// Ticks since the theft (drives Fleeing reads); u64::MAX = not yet.
    stole_at: u64,
    stole_this_tick: bool,
    npcs: Vec<Npc>,
    pub cases: CaseFile,
    pub events: Vec<GameEvent>,
    tick: u64,
}

#[derive(Clone, Debug)]
pub struct ThiefSnapshot {
    pub player: CellPos,
    pub carrying: bool,
    pub npcs: Vec<(CellPos, NpcState)>,
    pub n_cases: usize,
    /// Live scrutiny of the player's current look — the exposure meter.
    pub scrutiny: i32,
}

impl ThiefGame {
    pub fn new(spec: ThiefSpec) -> ThiefGame {
        let grid = spec.grid.clone();
        let light = grid.light_field(&spec.lights);
        let npcs = spec
            .npcs
            .iter()
            .map(|s| Npc {
                spec: s.clone(),
                pos: s.start,
                facing: s.facing,
                state: NpcState::Routine,
                alertness: 0,
                baseline: 0,
                memory: Vec::new(),
                reported: 0,
                stimulus: None,
                waypoint: 0,
                last_obs: None,
            })
            .collect();
        ThiefGame {
            player: spec.player_start,
            look: spec.player_look,
            carrying: false,
            stole_at: u64::MAX,
            stole_this_tick: false,
            grid,
            light,
            npcs,
            cases: CaseFile::new(),
            events: Vec::new(),
            spec,
            tick: 0,
        }
    }

    // -- systems, fixed source order --------------------------------------

    /// 1 · Player commands → movement, theft, outfit. Emits noise.
    fn resolve_commands(&mut self, cmds: &[Command], noises: &mut Vec<(CellPos, i32)>) {
        self.stole_this_tick = false;
        for c in cmds {
            match *c {
                Command::Move { dx, dz } => {
                    let dir = match (dx, dz) {
                        (-1, 0) => Dir::Xm,
                        (1, 0) => Dir::Xp,
                        (0, -1) => Dir::Zm,
                        (0, 1) => Dir::Zp,
                        _ => continue,
                    };
                    match self.grid.passage(self.player, dir) {
                        Passage::Free => {}
                        Passage::OpenFirst => {
                            // v0: doors open as you pass (noisier); windows too.
                            if let EdgeKind::Door(_) = self.grid.edge(self.player, dir) {
                                self.grid.set_edge(self.player, dir, EdgeKind::Door(DoorState::Open));
                            } else {
                                continue; // shut windows stay shut for v0 movement
                            }
                            noises.push((self.player, LOUD_WALK + 4));
                        }
                        _ => continue, // locked/vault/climb are M2+ verbs
                    }
                    self.player = self.player.step(dir);
                    let mat_mod = self.grid.cell(self.player).material.step_loudness_mod();
                    noises.push((self.player, LOUD_WALK + mat_mod));
                }
                Command::Steal => {
                    if self.player == self.spec.target && !self.carrying {
                        self.carrying = true;
                        self.stole_at = self.tick;
                        self.stole_this_tick = true;
                        noises.push((self.player, LOUD_WALK));
                        self.events.push(GameEvent::Stole { at: self.player });
                    }
                }
                Command::Outfit { top, headwear } => {
                    self.look = Description {
                        top: Feature::Seen(top),
                        headwear: Feature::Seen(headwear),
                        ..self.look
                    };
                }
                Command::Wait => {}
            }
        }
    }

    /// What is the player DOING, as an observer would name it?
    fn player_action(&self, moved_recently: bool) -> ActionKind {
        if self.stole_this_tick {
            ActionKind::Stealing
        } else if self.carrying && self.tick.saturating_sub(self.stole_at) < 600 && moved_recently {
            ActionKind::Fleeing
        } else if self.carrying && moved_recently {
            ActionKind::Carrying
        } else {
            ActionKind::Loitering
        }
    }

    /// 2 · NPC senses: vision cones (05a). A sighting emits an Observation
    /// into the NPC's own memory; guards (authority) also ingest into the
    /// case file at once and run the scrutiny check (05c).
    fn sense(&mut self, player_moved: bool) {
        let action = self.player_action(player_moved);
        for i in 0..self.npcs.len() {
            let npc = &self.npcs[i];
            if !in_cone(npc.pos, npc.facing, self.player) {
                continue;
            }
            let sight = self.grid.los(npc.pos, self.player);
            if !sight.clear {
                continue;
            }
            let dist = chebyshev(npc.pos, self.player);
            if dist > VISION_RANGE {
                continue;
            }
            // Read clarity: distance, light at the SUBJECT's cell, glass,
            // motion (a moving figure draws the eye — 05a).
            let light = self.light.level(&self.grid, self.player);
            let mut conf = 90 - 5 * dist - 15 * sight.degradations as i32;
            conf += if light < DARK_LIGHT {
                -40
            } else if light < DIM_LIGHT {
                -20
            } else {
                0
            };
            conf += if player_moved { 10 } else { -10 };
            // Point blank you see SOMETHING regardless of dark.
            if dist <= 1 {
                conf = conf.max(CONF_GATE);
            }
            if conf < CONF_GATE {
                continue;
            }
            let conf = conf.clamp(0, 100) as u8;
            // Re-notice cooldown: the same action, recently recorded, at no
            // better clarity → no new atom. A materially CLEARER look (they
            // came closer, stepped into the light) re-registers at once —
            // staring is one memory, but a good look is a better memory.
            if let Some((t0, a0, c0)) = npc.last_obs {
                if a0 == action && self.tick.saturating_sub(t0) < OBS_PERIOD && conf <= c0.saturating_add(4) {
                    continue;
                }
            }
            let obs = Observation {
                observer: npc.spec.id,
                subject: partial_read(&self.look, conf),
                action,
                at: self.player,
                when: Tick(self.tick),
                confidence: conf,
                salience: action.base_salience(),
                source: Source::Direct,
            };
            self.events.push(GameEvent::Seen { by: npc.spec.id, action, salience: obs.salience });
            let is_guard = npc.spec.role == Role::Guard;
            let npc = &mut self.npcs[i];
            npc.last_obs = Some((self.tick, action, conf));
            npc.memory.push(obs);
            // Sighting stimulus: rise fast (08).
            let stim = (conf as i32 + obs.salience as i32) / 2;
            npc.alertness = npc.alertness.max(stim);
            npc.stimulus = Some(obs.at);
            if obs.salience >= REPORT_SALIENCE {
                npc.baseline = npc.baseline.max(20);
            }
            if is_guard {
                // Authority: goes straight into the case file (self-report).
                npc.reported = npc.memory.len();
                let had = self.cases.cases.len();
                self.cases.ingest(obs);
                if self.cases.cases.len() > had {
                    self.events.push(GameEvent::CaseOpened { id: self.cases.cases[had].id });
                }
                // The 05b scrutiny rule, live: does this person match a
                // wanted profile enough to stop them?
                let scr = self.cases.scrutiny(&obs.subject);
                let npc = &mut self.npcs[i];
                if scr >= STOP_SCRUTINY && npc.state != NpcState::Pursue {
                    npc.state = NpcState::Pursue;
                    npc.alertness = 100;
                    npc.stimulus = Some(obs.at);
                    self.events.push(GameEvent::HuntStarted { guard: self.npcs[i].spec.id });
                }
            }
        }
    }

    /// 3 · Noise: propagate each emission; hearers get a low-fidelity
    /// observation + an alertness bump (05a hearing).
    fn hear(&mut self, noises: &[(CellPos, i32)]) {
        for &(src, loudness) in noises {
            if loudness <= 0 {
                continue;
            }
            let field = self.grid.propagate_sound(src, loudness);
            for npc in &mut self.npcs {
                let lvl = field.level(&self.grid, npc.pos);
                if lvl < 1 || npc.pos == src {
                    continue;
                }
                let obs = Observation {
                    observer: npc.spec.id,
                    subject: Description::UNKNOWN,
                    action: ActionKind::Noise,
                    at: src,
                    when: Tick(self.tick),
                    confidence: (lvl * 8).clamp(0, 40) as u8,
                    salience: ActionKind::Noise.base_salience(),
                    source: Source::Direct,
                };
                npc.memory.push(obs);
                npc.alertness = npc.alertness.max((lvl * 4).min(50));
                if npc.state == NpcState::Routine || npc.state == NpcState::Notice {
                    npc.stimulus = Some(src);
                }
            }
        }
    }

    /// 4 · The ladder + movement (08: alertness overrides schedule; resumes
    /// it on decay). One step per MOVE_PERIOD.
    fn behave(&mut self) {
        let step_tick = self.tick % MOVE_PERIOD == 0;
        for i in 0..self.npcs.len() {
            // Decay: slow fall to the heightened baseline.
            if self.tick % ALERT_DECAY_PERIOD == 0 {
                let npc = &mut self.npcs[i];
                npc.alertness = (npc.alertness - 1).max(npc.baseline);
            }
            // State from alertness (guards' Pursue and civs' Reporting are
            // sticky until resolved below).
            let npc = &mut self.npcs[i];
            if npc.state != NpcState::Pursue && npc.state != NpcState::Reporting {
                npc.state = if npc.alertness >= 70 {
                    NpcState::Investigate
                } else if npc.alertness >= 40 {
                    NpcState::Notice
                } else {
                    NpcState::Routine
                };
                // A civilian with an unreported alarming memory goes to tell
                // a guard (05b reporting: latency = the travel).
                if npc.spec.role == Role::Civilian
                    && npc.memory[npc.reported..].iter().any(|o| o.salience >= REPORT_SALIENCE)
                {
                    npc.state = NpcState::Reporting;
                }
            }
            if !step_tick {
                continue;
            }
            match self.npcs[i].state {
                NpcState::Routine => self.step_routine(i),
                NpcState::Notice => {} // stand and look (v0: no head turn)
                NpcState::Investigate => {
                    if let Some(t) = self.npcs[i].stimulus {
                        if self.npcs[i].pos == t {
                            // Checked out, nothing here: let it decay.
                            self.npcs[i].stimulus = None;
                            self.npcs[i].alertness = self.npcs[i].alertness.min(60);
                        } else {
                            self.step_toward(i, t);
                        }
                    }
                }
                NpcState::Reporting => {
                    // Head for the nearest guard (spec order breaks ties).
                    let guard = self
                        .npcs
                        .iter()
                        .enumerate()
                        .filter(|(_, n)| n.spec.role == Role::Guard)
                        .min_by_key(|(gi, n)| (chebyshev(n.pos, self.npcs[i].pos), *gi))
                        .map(|(gi, _)| gi);
                    if let Some(gi) = guard {
                        let gpos = self.npcs[gi].pos;
                        if chebyshev(self.npcs[i].pos, gpos) <= 1 {
                            self.deliver_report(i, gi);
                        } else {
                            self.step_toward(i, gpos);
                        }
                    }
                }
                NpcState::Pursue => {
                    if let Some(t) = self.npcs[i].stimulus {
                        if self.npcs[i].pos == t {
                            // Lost them: heightened routine, hunt cools.
                            let npc = &mut self.npcs[i];
                            npc.stimulus = None;
                            npc.state = NpcState::Investigate;
                            npc.alertness = 65;
                            npc.baseline = npc.baseline.max(20);
                        } else {
                            self.step_toward(i, t);
                        }
                    }
                }
            }
        }
    }

    /// Civilian i hands everything unreported to guard g; the guard ingests
    /// it into the case file secondhand (reduced confidence, tagged source).
    fn deliver_report(&mut self, i: usize, g: usize) {
        let from = self.npcs[i].spec.id;
        let to_report: Vec<Observation> = self.npcs[i].memory[self.npcs[i].reported..].to_vec();
        let n = to_report.len() as u8;
        self.npcs[i].reported = self.npcs[i].memory.len();
        self.npcs[i].state = NpcState::Routine;
        self.npcs[i].baseline = self.npcs[i].baseline.max(20);
        let mut opened = Vec::new();
        for mut obs in to_report {
            obs.source = Source::Secondhand { from };
            obs.confidence = ((obs.confidence as u32 * SECONDHAND_NUM) / SECONDHAND_DEN) as u8;
            let had = self.cases.cases.len();
            self.cases.ingest(obs);
            if self.cases.cases.len() > had {
                opened.push(self.cases.cases[had].id);
            }
        }
        // The briefed guard raises his guard and goes to look (08).
        let guard = &mut self.npcs[g];
        guard.alertness = guard.alertness.max(70);
        guard.baseline = guard.baseline.max(20);
        if guard.state != NpcState::Pursue {
            if let Some(worst) = self.cases.pool.iter().rev().max_by_key(|o| o.salience) {
                guard.stimulus = Some(worst.at);
            }
        }
        self.events.push(GameEvent::Reported { by: from, to: self.npcs[g].spec.id, count: n });
        for id in opened {
            self.events.push(GameEvent::CaseOpened { id });
        }
    }

    fn step_routine(&mut self, i: usize) {
        let npc = &self.npcs[i];
        if npc.spec.patrol.is_empty() {
            // Civilians drift home to their start cell.
            if npc.pos != npc.spec.start {
                self.step_toward(i, self.npcs[i].spec.start);
            }
            return;
        }
        let wp = npc.spec.patrol[npc.waypoint];
        if npc.pos == wp {
            self.npcs[i].waypoint = (npc.waypoint + 1) % npc.spec.patrol.len();
        } else {
            self.step_toward(i, wp);
        }
    }

    /// BFS next-step (fixed DIRS order, first-found = canonical shortest).
    /// NPCs walk Free edges and open doors as residents do (OpenFirst), no
    /// climbing/picking.
    fn step_toward(&mut self, i: usize, to: CellPos) {
        let from = self.npcs[i].pos;
        if from == to {
            return;
        }
        let Some(dir) = next_step(&self.grid, from, to) else { return };
        // Doors open as NPCs pass, same as the player.
        if self.grid.edge(from, dir).passage() == Passage::OpenFirst {
            if let EdgeKind::Door(_) = self.grid.edge(from, dir) {
                self.grid.set_edge(from, dir, EdgeKind::Door(DoorState::Open));
            } else {
                return;
            }
        }
        let npc = &mut self.npcs[i];
        npc.pos = npc.pos.step(dir);
        npc.facing = dir;
    }
}

fn chebyshev(a: CellPos, b: CellPos) -> i32 {
    let dx = (a.x as i32 - b.x as i32).abs();
    let dz = (a.z as i32 - b.z as i32).abs();
    dx.max(dz)
}

/// 90° vision cone: the target must lie in the facing half-plane with
/// |lateral| ≤ |forward|, same floor.
fn in_cone(pos: CellPos, facing: Dir, target: CellPos) -> bool {
    if pos.floor != target.floor {
        return false;
    }
    let (dx, dz) = (target.x as i32 - pos.x as i32, target.z as i32 - pos.z as i32);
    let (fx, fz) = {
        let (a, b) = facing.delta();
        (a as i32, b as i32)
    };
    let fwd = dx * fx + dz * fz;
    let lat = dx * fz - dz * fx;
    (fwd > 0 && lat.abs() <= fwd) || (dx == 0 && dz == 0)
}

/// Degrade the ground-truth look to what a read at `conf` resolves (05a: a
/// poor read fills fields with Unknown). Deterministic clarity bands.
fn partial_read(truth: &Description, conf: u8) -> Description {
    let mut d = Description::UNKNOWN;
    if conf >= 30 {
        d.build = truth.build;
        d.top = truth.top;
        d.headwear = truth.headwear;
    }
    if conf >= 50 {
        d.bottom = truth.bottom;
        d.masked = truth.masked;
    }
    if conf >= 70 {
        d.gait = truth.gait;
        d.mark = truth.mark;
    }
    d
}

/// BFS from `from` until `to`; returns the first step of the canonical
/// shortest path (DIRS order tie-break). Resident-level passability.
fn next_step(grid: &TownGrid, from: CellPos, to: CellPos) -> Option<Dir> {
    use std::collections::VecDeque;
    let mut prev: Vec<u8> = vec![u8::MAX; grid.n_cells()];
    let mut q = VecDeque::new();
    prev[grid.flat_index(from)] = 4; // sentinel "start"
    q.push_back(from);
    while let Some(p) = q.pop_front() {
        if p == to {
            // Walk back to the step after `from`.
            let mut cur = p;
            loop {
                let d_code = prev[grid.flat_index(cur)];
                let d = DIRS[d_code as usize];
                let back = cur.step(d.opposite());
                if back == from {
                    return Some(d);
                }
                cur = back;
            }
        }
        for (di, d) in DIRS.iter().enumerate() {
            let n = p.step(*d);
            if !grid.in_bounds(n) || prev[grid.flat_index(n)] != u8::MAX {
                continue;
            }
            let pass = grid.passage(p, *d);
            if pass != Passage::Free && pass != Passage::OpenFirst {
                continue;
            }
            // Only doors auto-open; a shut window is not a walking route.
            if pass == Passage::OpenFirst && !matches!(grid.edge(p, *d), EdgeKind::Door(_)) {
                continue;
            }
            prev[grid.flat_index(n)] = di as u8;
            q.push_back(n);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Simulation impl
// ---------------------------------------------------------------------------

impl Simulation for ThiefGame {
    type Command = Command;
    type Snapshot = ThiefSnapshot;

    fn tick(&mut self, t: Tick, cmds: &[Command]) {
        self.tick = t.0;
        let before = self.player;
        let mut noises = Vec::new();
        self.resolve_commands(cmds, &mut noises);
        let player_moved = self.player != before;
        self.sense(player_moved);
        self.hear(&noises);
        self.behave();
        self.cases.decay_tick(t);
    }

    fn snapshot(&self) -> ThiefSnapshot {
        ThiefSnapshot {
            player: self.player,
            carrying: self.carrying,
            npcs: self.npcs.iter().map(|n| (n.pos, n.state)).collect(),
            n_cases: self.cases.cases.len(),
            scrutiny: self.cases.scrutiny(&self.look),
        }
    }

    fn state_hash(&self) -> u64 {
        let mut h: u64 = 0xcbf29ce484222325;
        let mut eat = |b: u8| {
            h = (h ^ b as u64).wrapping_mul(0x100000001b3);
        };
        let mut eat_pos = |p: CellPos, eat: &mut dyn FnMut(u8)| {
            eat(p.x as u8);
            eat((p.x >> 8) as u8);
            eat(p.z as u8);
            eat((p.z >> 8) as u8);
            eat(p.floor as u8);
        };
        eat_pos(self.player, &mut eat);
        self.look.eat_into(&mut eat);
        eat(self.carrying as u8);
        for byte in self.stole_at.to_le_bytes() {
            eat(byte);
        }
        for npc in &self.npcs {
            eat_pos(npc.pos, &mut eat);
            eat(npc.state.code());
            eat(npc.alertness as u8);
            eat(npc.baseline as u8);
            eat(npc.memory.len() as u8);
            eat(npc.reported as u8);
            match npc.stimulus {
                None => eat(0xff),
                Some(p) => eat_pos(p, &mut eat),
            }
            match npc.last_obs {
                None => eat(0xfe),
                Some((t, a, c)) => {
                    for byte in t.to_le_bytes() {
                        eat(byte);
                    }
                    eat(a.code());
                    eat(c);
                }
            }
            eat(npc.waypoint as u8);
            for obs in &npc.memory {
                obs.eat_into(&mut eat);
            }
        }
        // Dynamic edges (opened doors) matter: fold the grid in.
        for byte in self.grid.grid_hash().to_le_bytes() {
            eat(byte);
        }
        for byte in self.cases.state_hash().to_le_bytes() {
            eat(byte);
        }
        h
    }
}

// ---------------------------------------------------------------------------
// The M1 greybox fixture + the deduction-scenario gate
// ---------------------------------------------------------------------------

/// One building (shop + back room), a shopkeeper in the back room, a guard
/// patrolling the street. The M1 stage.
pub fn spine_level() -> ThiefSpec {
    use super::grid::{Cell, CellKind, Material, Prop, WindowState};
    let mut grid = TownGrid::new(24, 12, 0, 0);
    for z in 0..12 {
        for x in 0..24 {
            grid.set_cell(CellPos::new(x, z, 0), Cell { kind: CellKind::Outdoor, material: Material::Stone, prop: Prop::None });
        }
    }
    // Building [3,11) × [3,9): back room (z 3..6) with the strongbox, shop
    // front (z 6..9) opening SOUTH — the guard's beat is the NORTH street,
    // so approach and flee can stay out of his sight; the return is the
    // confrontation.
    for z in 3..9 {
        for x in 3..11 {
            grid.set_cell(CellPos::new(x, z, 0), Cell { kind: CellKind::Room(if z < 6 { 1 } else { 0 }), material: Material::Wood, prop: Prop::None });
        }
    }
    let p = |x, z| CellPos::new(x, z, 0);
    for x in 3..11 {
        grid.set_edge(p(x, 3), Dir::Zm, EdgeKind::Wall);
        grid.set_edge(p(x, 8), Dir::Zp, EdgeKind::Wall);
        grid.set_edge(p(x, 6), Dir::Zm, EdgeKind::Wall); // interior wall
    }
    for z in 3..9 {
        grid.set_edge(p(3, z), Dir::Xm, EdgeKind::Wall);
        grid.set_edge(p(10, z), Dir::Xp, EdgeKind::Wall);
    }
    // South front door onto the z=9 street; interior door; shopfront glass.
    grid.set_edge(p(5, 8), Dir::Zp, EdgeKind::Door(DoorState::Closed));
    grid.set_edge(p(6, 6), Dir::Zm, EdgeKind::Door(DoorState::Closed));
    grid.set_edge(p(9, 8), Dir::Zp, EdgeKind::Window(WindowState::Shut));
    // Lamps light both rooms; one street lamp by the door.
    let lights = vec![(p(6, 7), 8), (p(8, 4), 8), (p(5, 10), 6)];
    ThiefSpec {
        grid,
        player_start: p(20, 10),
        player_look: Description {
            build: Feature::Seen(super::perception::Build::Average),
            top: Feature::Seen(Hue::Green),
            bottom: Feature::Seen(Hue::Drab),
            headwear: Feature::Seen(Headwear::Hood),
            masked: Feature::Seen(false),
            gait: Feature::Seen(super::perception::Gait::Normal),
            mark: Feature::Seen(super::perception::Mark::None),
        },
        npcs: vec![
            NpcSpec { id: 1, role: Role::Guard, start: p(2, 1), facing: Dir::Xp, patrol: vec![p(2, 1), p(8, 1)] },
            NpcSpec { id: 2, role: Role::Civilian, start: p(4, 4), facing: Dir::Xp, patrol: vec![] },
        ],
        target: p(9, 4),
        lights,
        seed: 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sim_core::Runner;

    /// The scripted M1 trace: enter by night… well, by stage light — walk
    /// in the front door, through the shop, into the back room; steal under
    /// the shopkeeper's eyes; flee to the far street corner; then stroll
    /// back into the guard's beat still wearing the same hood.
    fn spine_trace(change_outfit: bool) -> Vec<(Tick, Command)> {
        let mut t = Vec::new();
        let mut tick = 10u64;
        let mut mv = |tick: &mut u64, dx: i16, dz: i16, n: usize| {
            let mut v = Vec::new();
            for _ in 0..n {
                v.push((Tick(*tick), Command::Move { dx, dz }));
                *tick += 8;
            }
            v
        };
        // Approach along the south street, out of the north-beat guard's
        // sight: (20,10) → door (5,9) → shop → back room → strongbox (9,4).
        t.extend(mv(&mut tick, -1, 0, 15)); // x 20 → 5 on z=10
        t.extend(mv(&mut tick, 0, -1, 1)); // → (5,9) doorstep
        t.extend(mv(&mut tick, 0, -1, 1)); // through the front door → (5,8)
        t.extend(mv(&mut tick, 1, 0, 1)); // → (6,8)
        t.extend(mv(&mut tick, 0, -1, 2)); // → (6,6)
        t.extend(mv(&mut tick, 0, -1, 1)); // through the interior door → (6,5)
        t.extend(mv(&mut tick, 1, 0, 3)); // → (9,5)
        t.extend(mv(&mut tick, 0, -1, 1)); // → (9,4) the strongbox
        t.push((Tick(tick), Command::Steal));
        tick += 30;
        // Flee back out south, then east along z=10 — still unseen.
        t.extend(mv(&mut tick, 0, 1, 1));
        t.extend(mv(&mut tick, -1, 0, 3));
        t.extend(mv(&mut tick, 0, 1, 3)); // through the interior door → (6,8)
        t.extend(mv(&mut tick, -1, 0, 1)); // → (5,8)
        t.extend(mv(&mut tick, 0, 1, 2)); // out the front door → (5,10)
        t.extend(mv(&mut tick, 1, 0, 15)); // east to (20,10)
        // Lie low a moment (the rumor races: shopkeeper → guard).
        tick += 1200;
        if change_outfit {
            t.push((Tick(tick), Command::Outfit { top: Hue::Brown, headwear: Headwear::Bare }));
            tick += 10;
        }
        // Stroll back up the east street and west into the guard's beat.
        t.extend(mv(&mut tick, -1, 0, 8)); // → (12,10)
        t.extend(mv(&mut tick, 0, -1, 8)); // → (12,2) up the open east street
        t.extend(mv(&mut tick, -1, 0, 3)); // → (9,2), inside the beat's eye
        // Stand there long enough to be looked at.
        t.push((Tick(tick + 600), Command::Wait));
        t
    }

    fn run_spine(change_outfit: bool) -> (ThiefGame, u64) {
        let mut r = Runner::new(ThiefGame::new(spine_level()));
        r.feed(spine_trace(change_outfit));
        let hash = r.run_ticks(6000);
        (r.sim, hash)
    }

    /// THE M1 gate (docs/spec/12): steal → seen → word spreads → a
    /// description forms → the guard hunts the matching profile.
    #[test]
    fn deduction_scenario_steal_seen_spread_hunt() {
        let (game, _) = run_spine(false);
        let ev = &game.events;
        // 1 · The theft happened and was SEEN happening.
        assert!(ev.iter().any(|e| matches!(e, GameEvent::Stole { .. })), "no theft: {ev:?}");
        assert!(
            ev.iter().any(|e| matches!(e, GameEvent::Seen { by: 2, action: ActionKind::Stealing, .. })),
            "the shopkeeper must witness the steal: {ev:?}"
        );
        // 2 · Word spread: the shopkeeper reached the guard and reported.
        assert!(
            ev.iter().any(|e| matches!(e, GameEvent::Reported { by: 2, to: 1, .. })),
            "the report must reach the guard: {ev:?}"
        );
        // 3 · A description formed: a case whose profile wears the hood.
        assert!(!game.cases.cases.is_empty(), "a case must open");
        let case = &game.cases.cases[0];
        assert_eq!(case.profile.headwear, Feature::Seen(Headwear::Hood), "profile: {:?}", case.profile);
        assert_eq!(case.profile.top, Feature::Seen(Hue::Green));
        assert!(case.confidence > 0 && case.severity >= 80);
        // 4 · The guard hunts the matching profile.
        assert!(
            ev.iter().any(|e| matches!(e, GameEvent::HuntStarted { guard: 1 })),
            "the guard must start hunting on sight of the matching hood: {ev:?}"
        );
        let snap = game.snapshot();
        assert!(snap.scrutiny >= STOP_SCRUTINY, "the hooded look must stay hot: {}", snap.scrutiny);
    }

    /// The counterfactual that proves the loop is systemic, not scripted:
    /// same crime, same witnesses — but the thief sheds the hood and coat
    /// before strolling back. The guard looks straight past them.
    #[test]
    fn changing_look_defeats_the_description() {
        let (game, _) = run_spine(true);
        let ev = &game.events;
        // The crime still happened, was seen, was reported…
        assert!(ev.iter().any(|e| matches!(e, GameEvent::Reported { by: 2, to: 1, .. })));
        assert!(!game.cases.cases.is_empty());
        // …but no hunt: the walker no longer matches the wanted profile.
        assert!(
            !ev.iter().any(|e| matches!(e, GameEvent::HuntStarted { .. })),
            "a changed look must not trigger the hunt: {ev:?}"
        );
        let snap = game.snapshot();
        assert!(snap.scrutiny < STOP_SCRUTINY, "scrutiny of the new look must collapse: {}", snap.scrutiny);
    }

    /// Latency is real: between the sighting and the delivered report there
    /// are ticks where the town "knows" nothing — the race-the-rumor window
    /// (05b).
    #[test]
    fn the_rumor_has_latency() {
        let mut r = Runner::new(ThiefGame::new(spine_level()));
        r.feed(spine_trace(false));
        // Run to just past the steal (it lands around tick ~250).
        r.run_ticks(300);
        assert!(r.sim.events.iter().any(|e| matches!(e, GameEvent::Stole { .. })));
        // Incidental street sightings may already sit in the file, but the
        // CRIME cannot be known yet — the witness is still walking.
        assert!(
            !r.sim.cases.cases.iter().any(|c| c.severity >= 80),
            "the case file must not know of the theft yet: {:#?}",
            r.sim.cases.cases
        );
        r.run_ticks(5700);
        assert!(
            r.sim.cases.cases.iter().any(|c| c.severity >= 80),
            "the report must eventually land"
        );
    }

    /// M1 determinism gates: replay-twice-identical; the two traces diverge.
    #[test]
    fn spine_replays_bit_identical() {
        let (_, h1) = run_spine(false);
        let (_, h2) = run_spine(false);
        assert_eq!(h1, h2, "same trace must replay to the same state hash");
        let (_, h3) = run_spine(true);
        assert_ne!(h1, h3, "a different trace is a different world");
    }

    /// Pinned portable oracle (all-integer sim). Recapture only with a
    /// reason, in the commit message.
    #[test]
    fn spine_state_hash_oracle_pinned() {
        let (_, h) = run_spine(false);
        assert_eq!(h, 0x9058_98b9_d500_4d81, "recapture: {h:#018x}");
    }

    #[test]
    fn snapshot_is_pure() {
        let (game, _) = run_spine(false);
        let a = format!("{:?}", game.snapshot());
        let b = format!("{:?}", game.snapshot());
        assert_eq!(a, b);
        let h1 = game.state_hash();
        let _ = game.snapshot();
        assert_eq!(game.state_hash(), h1, "snapshot must not mutate state");
    }
}
