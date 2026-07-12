//! The town sim — the movement/look testbed (docs/VISION.md, Faza 0).
//!
//! Deliberately tiny: a walkable town grid, a player with three movement
//! cadences, wandering/patrolling NPCs for life in the frame, and the day
//! clock the sky follows. The deduction/perception game that used to live
//! here is archived (tag `archive/pre-joyful-reset`); the miodny continuous
//! movement stack replaces this cell-stepper in Faza 2.
//!
//! Fully headless and deterministic: fixed tick, seeded `Pcg32`, trace
//! replay, `state_hash` over every observable field.

use super::grid::{CellField, CellKind, CellPos, Dir, DoorState, EdgeKind, Passage, TownGrid, DIRS};
use super::towngen::{generate_town, TownParams};
use sim_core::{Pcg32, Simulation, Tick};

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/// Ticks between NPC steps (guards and wanderers share the amble).
pub const NPC_MOVE_PERIOD: u64 = 12;

/// Player step cadence per mode (ticks per landed cell).
pub const STEP_SNEAK: u64 = 14;
pub const STEP_WALK: u64 = 8;
pub const STEP_RUN: u64 = 5;

/// Sim light thresholds the HUD/look may read (kept from the old sim).
pub const DIM_LIGHT: i32 = 4;
pub const DARK_LIGHT: i32 = 2;

/// Day-phase ambient light on outdoor cells.
pub const AMBIENT_DAY: i32 = 8;
pub const AMBIENT_DAWN_DUSK: i32 = 3;
pub const AMBIENT_NIGHT: i32 = 1;

// ---------------------------------------------------------------------------
// The day clock (unchanged from the old sim: minute 0..1440 over day_len)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DayPhase {
    Dawn,
    Day,
    Dusk,
    Night,
}

impl DayPhase {
    pub fn code(self) -> u8 {
        match self {
            DayPhase::Dawn => 0,
            DayPhase::Day => 1,
            DayPhase::Dusk => 2,
            DayPhase::Night => 3,
        }
    }
}

/// Phase from the tick: dawn 05:00–07:00, day 07:00–19:00, dusk 19:00–21:00,
/// night otherwise.
pub fn day_phase(tick: u64, day_len_ticks: u64) -> DayPhase {
    let m = day_minute(tick, day_len_ticks);
    match m {
        300..=419 => DayPhase::Dawn,
        420..=1139 => DayPhase::Day,
        1140..=1259 => DayPhase::Dusk,
        _ => DayPhase::Night,
    }
}

/// Minute-of-day 0..1440. The clock starts at 09:00 so a fresh sim boots in
/// full daylight (the joyful default — docs/VISION.md).
pub fn day_minute(tick: u64, day_len_ticks: u64) -> u32 {
    let day_len = day_len_ticks.max(1);
    (((tick % day_len) * 1440 / day_len + 540) % 1440) as u32
}

fn ambient(phase: DayPhase) -> i32 {
    match phase {
        DayPhase::Day => AMBIENT_DAY,
        DayPhase::Dawn | DayPhase::Dusk => AMBIENT_DAWN_DUSK,
        DayPhase::Night => AMBIENT_NIGHT,
    }
}

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Role {
    Guard,
    Civilian,
}

#[derive(Clone, Debug)]
pub struct NpcSpec {
    pub id: u16,
    pub role: Role,
    pub start: CellPos,
    pub facing: Dir,
    /// Waypoint loop (guards). Empty = free wanderer (seeded random strolls).
    pub patrol: Vec<CellPos>,
}

/// The town level: grid + population + lamps. Ordered Vecs only.
#[derive(Clone)]
pub struct TownLevel {
    pub grid: TownGrid,
    pub player_start: CellPos,
    pub npcs: Vec<NpcSpec>,
    /// Static lamp cells (cell, intensity) — the sim-side light field.
    pub lights: Vec<(CellPos, i32)>,
    /// Ticks per full day/night cycle.
    pub day_len_ticks: u64,
    pub seed: u64,
}

// ---------------------------------------------------------------------------
// Commands & snapshot
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MoveMode {
    Sneak,
    Walk,
    Run,
}

impl MoveMode {
    pub fn code(self) -> u8 {
        match self {
            MoveMode::Sneak => 0,
            MoveMode::Walk => 1,
            MoveMode::Run => 2,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Command {
    /// Step one cell (dx, dz ∈ {-1,0,1}, one axis only). The sim rate-limits
    /// to the mode's cadence; extra commands are dropped, not queued.
    Move { dx: i16, dz: i16, mode: MoveMode },
    Wait,
}

/// Per-NPC read model for presentation (bodies, gait).
#[derive(Clone, Copy, Debug)]
pub struct NpcView {
    pub id: u16,
    pub role: Role,
    pub pos: CellPos,
    pub facing: Dir,
}

#[derive(Clone, Debug)]
pub struct TownSnapshot {
    pub player: CellPos,
    pub npcs: Vec<NpcView>,
    pub phase: DayPhase,
    /// Minute-of-day, 0..1440 (for clocks).
    pub day_min: u32,
    /// Sim light level at the player's cell.
    pub light: i32,
}

// ---------------------------------------------------------------------------
// The sim
// ---------------------------------------------------------------------------

struct Npc {
    spec: NpcSpec,
    pos: CellPos,
    facing: Dir,
    waypoint: usize,
    /// A wanderer's current stroll goal (None = picking a new one).
    stroll: Option<CellPos>,
}

pub struct TownGame {
    spec: TownLevel,
    grid: TownGrid,
    light: CellField,
    player: CellPos,
    /// Earliest tick the next player step may land (sim-owned cadence).
    next_move_at: u64,
    npcs: Vec<Npc>,
    rng: Pcg32,
    tick: u64,
}

impl TownGame {
    pub fn new(spec: TownLevel) -> TownGame {
        let grid = spec.grid.clone();
        let light = grid.light_field(&spec.lights);
        let npcs = spec
            .npcs
            .iter()
            .map(|s| Npc { spec: s.clone(), pos: s.start, facing: s.facing, waypoint: 0, stroll: None })
            .collect();
        TownGame {
            player: spec.player_start,
            next_move_at: 0,
            npcs,
            rng: Pcg32::with_stream(spec.seed, 7),
            grid,
            light,
            tick: 0,
            spec,
        }
    }

    pub fn grid(&self) -> &TownGrid {
        &self.grid
    }

    pub fn spec(&self) -> &TownLevel {
        &self.spec
    }

    /// Effective sim light at a cell: lamp field, plus the day-phase ambient
    /// on outdoor ground.
    pub fn light_at(&self, pos: CellPos) -> i32 {
        let lamp = self.light.level(&self.grid, pos);
        if self.grid.cell(pos).kind == CellKind::Outdoor {
            lamp.max(ambient(day_phase(self.tick, self.spec.day_len_ticks)))
        } else {
            lamp
        }
    }

    fn step_period(mode: MoveMode) -> u64 {
        match mode {
            MoveMode::Sneak => STEP_SNEAK,
            MoveMode::Walk => STEP_WALK,
            MoveMode::Run => STEP_RUN,
        }
    }

    /// Player commands → movement. Doors open as you pass (v0 rule); walls,
    /// shut windows and locks block.
    fn resolve_commands(&mut self, cmds: &[Command]) {
        for c in cmds {
            match *c {
                Command::Move { dx, dz, mode } => {
                    let dir = match (dx, dz) {
                        (-1, 0) => Dir::Xm,
                        (1, 0) => Dir::Xp,
                        (0, -1) => Dir::Zm,
                        (0, 1) => Dir::Zp,
                        _ => continue,
                    };
                    // The sim owns the cadence: too soon = dropped.
                    if self.tick < self.next_move_at {
                        continue;
                    }
                    match self.grid.passage(self.player, dir) {
                        Passage::Free => {}
                        Passage::OpenFirst => {
                            if let EdgeKind::Door(_) = self.grid.edge(self.player, dir) {
                                self.grid.set_edge(self.player, dir, EdgeKind::Door(DoorState::Open));
                            } else {
                                continue; // shut windows stay shut
                            }
                        }
                        _ => continue, // locked/climb have no verbs here
                    }
                    self.player = self.player.step(dir);
                    self.next_move_at = self.tick + Self::step_period(mode);
                }
                Command::Wait => {}
            }
        }
    }

    /// One BFS step toward `to` (fixed DIRS order = canonical shortest).
    /// NPCs open doors as residents do; walls/windows/locks block.
    fn step_toward(&mut self, i: usize, to: CellPos) {
        let from = self.npcs[i].pos;
        if from == to {
            return;
        }
        let Some(dir) = next_step(&self.grid, from, to) else {
            self.npcs[i].stroll = None; // unreachable: pick a new goal
            return;
        };
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

    /// A wanderer's next stroll goal: a seeded random walkable outdoor cell.
    fn pick_stroll(&mut self, i: usize) -> CellPos {
        let (w, h) = (self.grid.w, self.grid.h);
        let floor = self.npcs[i].pos.floor;
        for _ in 0..64 {
            let x = (self.rng.next_u32() % w as u32) as i16;
            let z = (self.rng.next_u32() % h as u32) as i16;
            let p = CellPos::new(x, z, floor);
            if self.grid.cell(p).kind == CellKind::Outdoor {
                return p;
            }
        }
        self.npcs[i].spec.start
    }

    fn behave(&mut self) {
        if !self.tick.is_multiple_of(NPC_MOVE_PERIOD) {
            return;
        }
        for i in 0..self.npcs.len() {
            if self.npcs[i].spec.patrol.is_empty() {
                // Wanderer: stroll to a random outdoor cell, then pick anew.
                let goal = match self.npcs[i].stroll {
                    Some(g) if g != self.npcs[i].pos => g,
                    _ => {
                        let g = self.pick_stroll(i);
                        self.npcs[i].stroll = Some(g);
                        g
                    }
                };
                self.step_toward(i, goal);
            } else {
                // Patroller: loop the waypoints.
                let npc = &self.npcs[i];
                let wp = npc.spec.patrol[npc.waypoint];
                if npc.pos == wp {
                    self.npcs[i].waypoint = (npc.waypoint + 1) % npc.spec.patrol.len();
                } else {
                    self.step_toward(i, wp);
                }
            }
        }
    }
}

impl Simulation for TownGame {
    type Command = Command;
    type Snapshot = TownSnapshot;

    fn tick(&mut self, t: Tick, cmds: &[Command]) {
        self.tick = t.0;
        self.resolve_commands(cmds);
        self.behave();
    }

    fn snapshot(&self) -> TownSnapshot {
        TownSnapshot {
            player: self.player,
            npcs: self
                .npcs
                .iter()
                .map(|n| NpcView { id: n.spec.id, role: n.spec.role, pos: n.pos, facing: n.facing })
                .collect(),
            phase: day_phase(self.tick, self.spec.day_len_ticks),
            day_min: day_minute(self.tick, self.spec.day_len_ticks),
            light: self.light_at(self.player),
        }
    }

    fn state_hash(&self) -> u64 {
        let mut h: u64 = 0xcbf29ce484222325;
        let mut eat = |v: u64| {
            for byte in v.to_le_bytes() {
                h = (h ^ byte as u64).wrapping_mul(0x100000001b3);
            }
        };
        let eat_pos = |p: CellPos, eat: &mut dyn FnMut(u64)| {
            eat(p.x as u64);
            eat(p.z as u64);
            eat(p.floor as u64);
        };
        eat(self.tick);
        eat(self.next_move_at);
        eat_pos(self.player, &mut eat);
        for n in &self.npcs {
            eat(n.spec.id as u64);
            eat_pos(n.pos, &mut eat);
            eat(n.facing as u64);
            eat(n.waypoint as u64);
            match n.stroll {
                Some(p) => {
                    eat(1);
                    eat_pos(p, &mut eat);
                }
                None => eat(0),
            }
        }
        eat(self.grid.grid_hash());
        h
    }
}

/// First step of the canonical BFS route `from → to` (deterministic DIRS
/// scan order). NPCs and the shell's click-planner share this passability:
/// Free edges plus doors (opened in passing).
pub fn next_step(grid: &TownGrid, from: CellPos, to: CellPos) -> Option<Dir> {
    use std::collections::VecDeque;
    if from == to {
        return None;
    }
    let (w, h) = (grid.w as i32, grid.h as i32);
    let idx = |p: CellPos| (p.z as i32 * w + p.x as i32) as usize;
    let mut first: Vec<Option<Dir>> = vec![None; (w * h) as usize];
    let mut seen = vec![false; (w * h) as usize];
    let mut q = VecDeque::new();
    seen[idx(from)] = true;
    q.push_back(from);
    while let Some(p) = q.pop_front() {
        for dir in DIRS {
            let passable = match grid.passage(p, dir) {
                Passage::Free => true,
                Passage::OpenFirst => matches!(grid.edge(p, dir), EdgeKind::Door(_)),
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
            first[idx(n)] = first[idx(p)].or(Some(dir));
            if n == to {
                return first[idx(n)];
            }
            q.push_back(n);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// The level builder — the generated town, populated
// ---------------------------------------------------------------------------

/// The default town testbed: a generated district with lamps at doors and
/// room centres, a couple of gate-to-gate guards, and a handful of
/// wanderers. Deterministic in `seed`.
pub fn town_level(seed: u64) -> TownLevel {
    let params = TownParams { w: 32, h: 32, min_buildings: 6, max_buildings: 10, max_attempts: 16 };
    let town = generate_town(&params, seed).unwrap_or_else(|e| panic!("towngen(seed {seed}): {e}"));
    let grid = town.grid;

    // Lamps: one on the street side of every ground-floor front door, one at
    // the centroid cell of every room (so interiors read under the wallcut).
    let mut lights: Vec<(CellPos, i32)> = Vec::new();
    for b in &town.buildings {
        let (inside, dir) = b.front_door;
        let street = inside.step(dir);
        if grid.in_bounds(street) && grid.cell(street).kind == CellKind::Outdoor {
            lights.push((street, 6));
        }
    }
    // Room centroids on the GROUND floor only (upper storeys aren't rendered
    // yet — a lamp there would light empty air and tax the probe bake).
    let mut rooms: Vec<(u16, i64, i64, i64)> = Vec::new(); // id, Σx, Σz, n
    for z in 0..grid.h {
        for x in 0..grid.w {
            let p = CellPos::new(x, z, 0);
            if let CellKind::Room(id) = grid.cell(p).kind {
                match rooms.iter_mut().find(|r| r.0 == id) {
                    Some(r) => {
                        r.1 += x as i64;
                        r.2 += z as i64;
                        r.3 += 1;
                    }
                    None => rooms.push((id, x as i64, z as i64, 1)),
                }
            }
        }
    }
    for (_, sx, sz, n) in rooms {
        let p = CellPos::new((sx / n) as i16, (sz / n) as i16, 0);
        if grid.cell(p).walkable() {
            lights.push((p, 7));
        }
    }

    // Population: guards patrol gate→gate; civilians wander the streets.
    let mut rng = Pcg32::with_stream(seed, 11);
    let mut npcs: Vec<NpcSpec> = Vec::new();
    let mut id = 1u16;
    if town.gates.len() >= 2 {
        for g in 0..(town.gates.len() / 2).min(2) {
            let a = town.gates[(g * 2) % town.gates.len()];
            let b = town.gates[(g * 2 + 1) % town.gates.len()];
            npcs.push(NpcSpec { id, role: Role::Guard, start: a, facing: Dir::Xp, patrol: vec![a, b] });
            id += 1;
        }
    }
    let outdoor: Vec<CellPos> = (0..grid.h)
        .flat_map(|z| (0..grid.w).map(move |x| CellPos::new(x, z, 0)))
        .filter(|&p| grid.cell(p).kind == CellKind::Outdoor)
        .collect();
    for _ in 0..6 {
        let p = outdoor[(rng.next_u32() as usize) % outdoor.len()];
        npcs.push(NpcSpec { id, role: Role::Civilian, start: p, facing: Dir::Zp, patrol: vec![] });
        id += 1;
    }

    let player_start = town.gates.first().copied().unwrap_or(CellPos::new(1, 1, 0));
    TownLevel { grid, player_start, npcs, lights, day_len_ticks: 14_400, seed }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sim_core::Runner;

    fn walk_east(n: usize) -> Vec<(Tick, Command)> {
        (0..n).map(|i| (Tick(i as u64 * STEP_WALK), Command::Move { dx: 1, dz: 0, mode: MoveMode::Walk })).collect()
    }

    #[test]
    fn town_level_is_deterministic_in_seed() {
        let a = town_level(3);
        let b = town_level(3);
        assert_eq!(a.grid.grid_hash(), b.grid.grid_hash());
        assert_eq!(a.lights, b.lights);
        assert_eq!(a.npcs.len(), b.npcs.len());
        for (x, y) in a.npcs.iter().zip(&b.npcs) {
            assert_eq!((x.start, x.role, &x.patrol), (y.start, y.role, &y.patrol));
        }
        let c = town_level(4);
        assert_ne!(a.grid.grid_hash(), c.grid.grid_hash(), "different seed, different town");
    }

    #[test]
    fn replay_twice_is_bit_identical() {
        let lvl = town_level(3);
        let run = |lvl: TownLevel| {
            let mut r = Runner::new(TownGame::new(lvl));
            r.feed(walk_east(6));
            r.run_ticks(600);
            r.sim.state_hash()
        };
        assert_eq!(run(lvl.clone()), run(lvl));
    }

    #[test]
    fn cadence_drops_early_steps() {
        let lvl = town_level(3);
        let mut g = TownGame::new(lvl);
        let start = g.player;
        // spam two moves on consecutive ticks: only the first lands
        g.tick(Tick(0), &[Command::Move { dx: 1, dz: 0, mode: MoveMode::Walk }]);
        g.tick(Tick(1), &[Command::Move { dx: 1, dz: 0, mode: MoveMode::Walk }]);
        let d = (g.player.x - start.x) + (g.player.z - start.z);
        assert!(d.abs() <= 1, "the walk cadence must swallow the second step");
    }

    #[test]
    fn npcs_move_and_stay_on_walkable_cells() {
        let lvl = town_level(3);
        let mut g = TownGame::new(lvl);
        let start: Vec<CellPos> = g.snapshot().npcs.iter().map(|n| n.pos).collect();
        for t in 0..1200u64 {
            g.tick(Tick(t), &[]);
        }
        let now = g.snapshot();
        assert!(now.npcs.iter().zip(&start).any(|(a, &b)| a.pos != b), "somebody must have moved in 20 s");
        for n in &now.npcs {
            assert!(g.grid().cell(n.pos).walkable(), "npc {} on a non-walkable cell {:?}", n.id, n.pos);
        }
    }

    #[test]
    fn day_clock_boots_in_daylight_and_cycles() {
        let lvl = town_level(3);
        assert_eq!(day_minute(0, lvl.day_len_ticks), 540, "the clock boots at 09:00");
        assert_eq!(day_phase(0, lvl.day_len_ticks), DayPhase::Day);
        // half a day later (09:00 + 12 h = 21:00) it is night
        assert_eq!(day_phase(lvl.day_len_ticks / 2, lvl.day_len_ticks), DayPhase::Night);
        assert_eq!(day_minute(lvl.day_len_ticks, lvl.day_len_ticks), 540, "full cycle wraps");
    }

    #[test]
    fn walls_never_admit_the_player() {
        let lvl = town_level(3);
        let mut g = TownGame::new(lvl);
        // drive the player hard at the map edge: position must stay walkable
        for t in 0..400u64 {
            g.tick(Tick(t), &[Command::Move { dx: 0, dz: -1, mode: MoveMode::Run }]);
        }
        assert!(g.grid().cell(g.player).walkable(), "the player can never stand in a wall/void");
    }
}
