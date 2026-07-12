//! The gym sim — the smallest thing that is still a game: one player
//! cell-stepping around the hand-authored gym level. No NPCs, no doors, no
//! clock, no RNG (owner directive 2026-07-12: cut to a single level with a
//! few walls, one building and the player).
//!
//! The cell-stepper is INTERIM — the Faza-2 miodny continuous movement stack
//! replaces it. Don't grow it.
//!
//! Fully headless and deterministic: fixed tick, trace replay, `state_hash`
//! over every observable field.

use super::grid::{CellKind, CellPos, Dir, EdgeKind, Grid};
use sim_core::{Simulation, Tick};

/// Player step cadence per mode (ticks per landed cell).
pub const STEP_WALK: u64 = 8;
pub const STEP_RUN: u64 = 5;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MoveMode {
    Walk,
    Run,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Command {
    /// Step one cell (dx, dz ∈ {-1,0,1}, one axis only). The sim rate-limits
    /// to the mode's cadence; extra commands are dropped, not queued.
    Move { dx: i16, dz: i16, mode: MoveMode },
    Wait,
}

/// The gym level: the grid, where the player spawns, and the lamp cells the
/// scene builder turns into named point lights (render data — the sim has no
/// light model).
#[derive(Clone)]
pub struct GymLevel {
    pub grid: Grid,
    pub player_start: CellPos,
    /// Static lamps (cell, intensity 0..8-ish).
    pub lights: Vec<(CellPos, i32)>,
}

#[derive(Clone, Copy, Debug)]
pub struct GymSnapshot {
    pub player: CellPos,
}

pub struct GymGame {
    spec: GymLevel,
    player: CellPos,
    /// Earliest tick the next player step may land (sim-owned cadence).
    next_move_at: u64,
    tick: u64,
}

impl GymGame {
    pub fn new(spec: GymLevel) -> GymGame {
        GymGame { player: spec.player_start, next_move_at: 0, tick: 0, spec }
    }

    pub fn grid(&self) -> &Grid {
        &self.spec.grid
    }

    pub fn spec(&self) -> &GymLevel {
        &self.spec
    }

    fn step_period(mode: MoveMode) -> u64 {
        match mode {
            MoveMode::Walk => STEP_WALK,
            MoveMode::Run => STEP_RUN,
        }
    }
}

impl Simulation for GymGame {
    type Command = Command;
    type Snapshot = GymSnapshot;

    fn tick(&mut self, t: Tick, cmds: &[Command]) {
        self.tick = t.0;
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
                    if self.tick < self.next_move_at || !self.spec.grid.open(self.player, dir) {
                        continue;
                    }
                    self.player = self.player.step(dir);
                    self.next_move_at = self.tick + Self::step_period(mode);
                }
                Command::Wait => {}
            }
        }
    }

    fn snapshot(&self) -> GymSnapshot {
        GymSnapshot { player: self.player }
    }

    fn state_hash(&self) -> u64 {
        let mut h: u64 = 0xcbf29ce484222325;
        let mut eat = |v: u64| {
            for byte in v.to_le_bytes() {
                h = (h ^ byte as u64).wrapping_mul(0x100000001b3);
            }
        };
        eat(self.tick);
        eat(self.next_move_at);
        eat(self.player.x as u64);
        eat(self.player.z as u64);
        eat(self.spec.grid.grid_hash());
        h
    }
}

// ---------------------------------------------------------------------------
// The level builder — hand-authored, no seed, no RNG
// ---------------------------------------------------------------------------

/// Interior span of the one building (inclusive cell range on both axes).
pub const HOUSE: (i16, i16, i16, i16) = (3, 3, 7, 7); // x0, z0, x1, z1
/// The doorway cell: its +z edge stays open through the building's south wall.
pub const DOORWAY: CellPos = CellPos { x: 5, z: 7 };

/// The gym: an 18×14 field, one 5×5 building with a doorway, two
/// freestanding walls, two lamps, the player. Everything the Faza-1 look
/// work and the Faza-2 movement work needs, and nothing else.
pub fn gym_level() -> GymLevel {
    let mut grid = Grid::new(18, 14);
    let (x0, z0, x1, z1) = HOUSE;

    // The building: Room cells walled around, one doorway gap on the south
    // side (an open edge — no door leaf, nothing to operate).
    for z in z0..=z1 {
        for x in x0..=x1 {
            grid.set_cell(CellPos::new(x, z), CellKind::Room);
        }
        grid.set_edge(CellPos::new(x0, z), Dir::Xm, EdgeKind::Wall);
        grid.set_edge(CellPos::new(x1, z), Dir::Xp, EdgeKind::Wall);
    }
    for x in x0..=x1 {
        grid.set_edge(CellPos::new(x, z0), Dir::Zm, EdgeKind::Wall);
        if CellPos::new(x, z1) != DOORWAY {
            grid.set_edge(CellPos::new(x, z1), Dir::Zp, EdgeKind::Wall);
        }
    }

    // Freestanding walls in the open — silhouette / shadow / stair-read
    // material for the look work.
    for x in 10..=15 {
        grid.set_edge(CellPos::new(x, 10), Dir::Zm, EdgeKind::Wall);
    }
    for z in 2..=5 {
        grid.set_edge(CellPos::new(12, z), Dir::Xm, EdgeKind::Wall);
    }

    // One street lamp in the open, one lamp inside the building — off the
    // room's centre walking line (the sim has no prop collision; a lamp on a
    // natural destination cell would let the player stand inside the post).
    let lights = vec![(CellPos::new(11, 6), 6), (CellPos::new(6, 4), 7)];

    GymLevel { grid, player_start: CellPos::new(10, 11), lights }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sim_core::Runner;

    #[test]
    fn gym_level_is_bit_identical_every_build() {
        let a = gym_level();
        let b = gym_level();
        assert_eq!(a.grid.grid_hash(), b.grid.grid_hash());
        assert_eq!(a.lights, b.lights);
        assert_eq!(a.player_start, b.player_start);
        assert_eq!(a.grid.cell(DOORWAY), CellKind::Room);
        assert!(a.grid.open(DOORWAY, Dir::Zp), "the doorway must stay open");
    }

    #[test]
    fn replay_twice_is_bit_identical() {
        let walk_west: Vec<(Tick, Command)> = (0..8).map(|i| (Tick(i * STEP_WALK), Command::Move { dx: -1, dz: 0, mode: MoveMode::Walk })).collect();
        let run = || {
            let mut r = Runner::new(GymGame::new(gym_level()));
            r.feed(walk_west.clone());
            r.run_ticks(200);
            r.sim.state_hash()
        };
        assert_eq!(run(), run());
    }

    #[test]
    fn cadence_drops_early_steps() {
        let mut g = GymGame::new(gym_level());
        let start = g.snapshot().player;
        // spam two moves on consecutive ticks: only the first lands
        g.tick(Tick(0), &[Command::Move { dx: 1, dz: 0, mode: MoveMode::Walk }]);
        g.tick(Tick(1), &[Command::Move { dx: 1, dz: 0, mode: MoveMode::Walk }]);
        let p = g.snapshot().player;
        assert_eq!((p.x - start.x) + (p.z - start.z), 1, "the walk cadence must swallow the second step");
        // run cadence is shorter than walk — a constants-relationship pin
        const _: () = assert!(STEP_RUN < STEP_WALK);
    }

    #[test]
    fn walls_and_the_map_edge_block_the_player() {
        let mut g = GymGame::new(gym_level());
        // drive the player hard at the map edge for 400 ticks
        for t in 0..400u64 {
            g.tick(Tick(t), &[Command::Move { dx: 0, dz: 1, mode: MoveMode::Run }]);
        }
        let p = g.snapshot().player;
        assert!(g.grid().in_bounds(p), "the player can never leave the grid");
        assert_eq!(p.z, g.grid().h - 1, "the run must stop AT the boundary, not before");
    }

    #[test]
    fn the_doorway_is_the_only_way_in() {
        let mut g = GymGame::new(gym_level());
        // teleport-by-walking: from the spawn, walk to just south of the
        // doorway, then step north through it
        let script: Vec<(i16, i16)> = vec![(-1, 0); 5].into_iter().chain(vec![(0, -1); 3]).chain(vec![(0, -1); 1]).collect();
        let mut t = 0u64;
        for (dx, dz) in script {
            g.tick(Tick(t), &[Command::Move { dx, dz, mode: MoveMode::Walk }]);
            t += STEP_WALK;
        }
        assert_eq!(g.snapshot().player, DOORWAY, "the walk-in route ends inside the building");
        assert_eq!(g.grid().cell(g.snapshot().player), CellKind::Room);
        // a wall cell next to the doorway does NOT admit
        let mut g2 = GymGame::new(gym_level());
        let mut t = 0u64;
        for (dx, dz) in [(-1, 0), (-1, 0), (-1, 0), (-1, 0), (0, -1), (0, -1), (0, -1), (0, -1)] {
            g2.tick(Tick(t), &[Command::Move { dx, dz, mode: MoveMode::Walk }]);
            t += STEP_WALK;
        }
        // (6, 8) pushing north hits the building's south wall
        assert_eq!(g2.snapshot().player, CellPos::new(6, 8), "the wall must hold");
    }
}
