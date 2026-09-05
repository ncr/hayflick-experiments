//! The gym sim — the smallest thing that is still a game: one player moving
//! continuously around the hand-authored gym level. Legacy cell-step commands
//! remain for deterministic click routes and old traces. No NPCs, no doors, no
//! clock, no RNG (owner directive 2026-07-12: cut to a single level with a
//! few walls, one building and the player).
//!
//! Fully headless and deterministic: fixed tick, trace replay, `state_hash`
//! over every observable field.

use super::grid::{CellKind, CellPos, Dir, EdgeKind, Grid};
use glam::Vec2;
use sim_core::{Simulation, Tick};
use crate::{collide_and_slide, TICK_DT};

/// Player step cadence per mode (ticks per landed cell).
pub const STEP_WALK: u64 = 8;
pub const STEP_RUN: u64 = 5;

/// Fixed-point scale used by the additive continuous movement command. The
/// command stays integer-only for deterministic traces; the sim turns it into
/// a normalized world-space direction at the fixed tick.
pub const WORLD_INPUT_SCALE: f32 = 1024.0;
/// Centre-to-edge clearance in world units: the player body is about 0.156 wu
/// wide at half-width and the rendered wall slab adds 0.1 wu on each side.
/// Keeping the combined clearance here stops the rendered body at the visible
/// wall instead of letting it overlap the slab.
pub const PLAYER_RADIUS: f32 = 0.26;
pub const SPEED_WALK: f32 = 3.0;
pub const SPEED_RUN: f32 = 5.0;
pub const SURVIVOR_WALK: f32 = 2.2;
pub const SURVIVOR_RUN: f32 = 4.2;
pub const SPEED_CROUCH: f32 = 1.1;
const ACCEL_WU_PER_S2: f32 = 18.0;
const BRAKE_WU_PER_S2: f32 = 34.0;

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
    /// Continuous world-space input, quantized at [`WORLD_INPUT_SCALE`].
    /// Unlike `Move`, this is sampled every fixed tick and does not snap to a
    /// cell; the grid remains the collision source of truth.
    MoveWorld { dx: i16, dz: i16, mode: MoveMode },
    Crouch(bool),
    Wait,
}

/// The gym level: the grid, where the player spawns, and the lamp cells the
/// scene builder turns into named point lights (render data — the sim has no
/// light model).
#[derive(Clone)]
pub struct GymLevel {
    pub neighborhood: bool,
    pub grid: Grid,
    pub player_start: CellPos,
    /// Static lamps (cell, intensity 0..8-ish).
    pub lights: Vec<(CellPos, i32)>,
}

#[derive(Clone, Copy, Debug)]
pub struct GymSnapshot {
    pub player: CellPos,
    /// Continuous player centre in world XZ (cell centres are x/z + 0.5).
    pub position: Vec2,
    pub velocity: Vec2,
    /// Direction into the blocking surface, from the attempted displacement.
    pub contact: Vec2,
    pub intent: Vec2,
    pub crouching: bool,
}

pub struct GymGame {
    spec: GymLevel,
    player: CellPos,
    position: Vec2,
    velocity: Vec2,
    contact: Vec2,
    intent: Vec2,
    crouching: bool,
    /// Earliest tick the next player step may land (sim-owned cadence).
    next_move_at: u64,
    tick: u64,
}

impl GymGame {
    pub fn new(spec: GymLevel) -> GymGame {
        let position = Vec2::new(spec.player_start.x as f32 + 0.5, spec.player_start.z as f32 + 0.5);
        GymGame { player: spec.player_start, position, velocity: Vec2::ZERO, contact: Vec2::ZERO, intent: Vec2::ZERO, crouching: false, next_move_at: 0, tick: 0, spec }
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

    fn speed(&self, mode: MoveMode) -> f32 {
        if self.crouching { return SPEED_CROUCH; }
        if self.spec.neighborhood {return match mode {MoveMode::Walk=>SURVIVOR_WALK,MoveMode::Run=>SURVIVOR_RUN};}
        match mode {
            MoveMode::Walk => SPEED_WALK,
            MoveMode::Run => SPEED_RUN,
        }
    }

    fn cell_for_position(&self) -> CellPos {
        CellPos::new(
            self.position.x.floor().clamp(0.0, self.spec.grid.w as f32 - 1.0) as i16,
            self.position.y.floor().clamp(0.0, self.spec.grid.h as f32 - 1.0) as i16,
        )
    }

    fn sync_player_cell(&mut self) {
        self.player = self.cell_for_position();
    }

    /// Advance the continuous mover one fixed tick. Input is already in the
    /// world basis and quantized, so camera/projection policy stays outside
    /// the headless sim while collision and acceleration stay inside it.
    fn move_world(&mut self, dx: i16, dz: i16, mode: MoveMode) {
        let raw = Vec2::new(dx as f32, dz as f32) / WORLD_INPUT_SCALE;
        let dir = raw.normalize_or_zero();
        self.intent = dir;
        let target = dir * self.speed(mode);
        let change = target - self.velocity;
        let max_change = ACCEL_WU_PER_S2 * TICK_DT;
        self.velocity = if change.length_squared() <= max_change * max_change {
            target
        } else {
            self.velocity + change.normalize() * max_change
        };
        self.integrate_position();
    }

    fn brake_world(&mut self) {
        let max_change = BRAKE_WU_PER_S2 * TICK_DT;
        let speed = self.velocity.length();
        self.velocity = if speed <= max_change { Vec2::ZERO } else { self.velocity * ((speed - max_change) / speed) };
        self.integrate_position();
    }

    fn integrate_position(&mut self) {
        let requested = self.velocity * TICK_DT;
        let grid = &self.spec.grid;
        let (x, z) = collide_and_slide(
            |x, z| grid.blocked_point(x, z, PLAYER_RADIUS),
            self.position.x,
            self.position.y,
            self.velocity.x * TICK_DT,
            self.velocity.y * TICK_DT,
        );
        let actual = Vec2::new(x,z) - self.position;
        let blocked = requested - actual;
        self.contact = if blocked.length_squared()>1e-9 {blocked.normalize()} else {Vec2::ZERO};
        if (x - self.position.x).abs() < f32::EPSILON {
            self.velocity.x = 0.0;
        }
        if (z - self.position.y).abs() < f32::EPSILON {
            self.velocity.y = 0.0;
        }
        self.position = Vec2::new(x, z);
        self.sync_player_cell();
    }
}

impl Simulation for GymGame {
    type Command = Command;
    type Snapshot = GymSnapshot;

    fn tick(&mut self, t: Tick, cmds: &[Command]) {
        self.tick = t.0;
        self.intent = Vec2::ZERO;
        let mut world_input = None;
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
                    self.position = Vec2::new(self.player.x as f32 + 0.5, self.player.z as f32 + 0.5);
                    self.velocity = Vec2::ZERO;
                    self.next_move_at = self.tick + Self::step_period(mode);
                }
                Command::MoveWorld { dx, dz, mode } => world_input = Some((dx, dz, mode)),
                Command::Crouch(active) => self.crouching = active,
                Command::Wait => {}
            }
        }
        if let Some((dx, dz, mode)) = world_input {
            self.move_world(dx, dz, mode);
        } else {
            self.brake_world();
        }
    }

    fn snapshot(&self) -> GymSnapshot {
        GymSnapshot { player: self.player, position: self.position, velocity: self.velocity, contact: self.contact, intent: self.intent, crouching: self.crouching }
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
        eat(self.position.x.to_bits() as u64);
        eat(self.position.y.to_bits() as u64);
        eat(self.velocity.x.to_bits() as u64);
        eat(self.velocity.y.to_bits() as u64);
        eat(self.contact.x.to_bits() as u64); eat(self.contact.y.to_bits() as u64);
        eat(self.intent.x.to_bits() as u64); eat(self.intent.y.to_bits() as u64);
        eat(self.crouching as u64);
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

    GymLevel { neighborhood: false, grid, player_start: CellPos::new(10, 11), lights }
}

/// A derelict concrete test yard: clear walking lanes between five histories.
/// The walls share the collision grid; cover erosion stays inside each slab.
pub fn concrete_level() -> GymLevel {
    let mut grid = Grid::new(18, 15);
    for (x0,x1,z) in [(1,4,3),(3,10,6),(1,5,10),(9,14,11)] {
        for x in x0..x1 { grid.set_edge(CellPos::new(x,z),Dir::Zm,EdgeKind::Wall); }
    }
    for z in 3..8 { grid.set_edge(CellPos::new(13,z),Dir::Xm,EdgeKind::Wall); }
    GymLevel { neighborhood: false, grid, player_start: CellPos::new(8,12), lights: Vec::new() }
}

// ---------------------------------------------------------------------------
// The effect catalogue — the SECOND level (owner ask, 2026-07-26)
// ---------------------------------------------------------------------------

/// Cell pitch between two specimen walls: 2 cells of wall, 1 cell of grass.
/// The gap has to survive the projection — 1 wu is ~41 px on world-X, so two
/// neighbours never share a silhouette even at the widest framing.
pub const SPEC_PITCH: i16 = 3;
/// The x cell each specimen row starts on, and how many stand in a row.
pub const SPEC_X0: i16 = 1;
pub const SPEC_N: i16 = 5;
/// The specimen rows, as the z of the wall line they sit on. 4 wu apart:
/// the trimetric camera looks down (1, 2) in xz, so a nearer row rides UP the
/// screen — at 4 wu the row in front clears the 2.1875-wu wall behind it.
/// Row 3 (z=19) arrived with the mud effect (2026-07-27, effect-system round
/// D) and grew the shell-hole slab with the artillery round; its remaining
/// slots wait for the next placed effect.
pub const SPEC_Z: [i16; 4] = [7, 11, 15, 19];
/// Cells each row is shifted along +x relative to the one behind it, so the
/// three rows stack in one SCREEN COLUMN instead of staggering across the
/// frame. It is arithmetic, not taste: the game projection's axis images are
/// +x → (40, 10) px and +z → (−20, 20) px, so a row 4 wu further out lands
/// (−80, +80) px away, and +2 wu of x puts (+80, +20) back — net (0, +100).
/// Authored here because the LEVEL is what has to know it; `spec_point` is the
/// one place that resolves a (row, index) to a world point.
pub const SPEC_ROW_DX: i16 = 2;
/// The catalogue's own little building — Room cells, so its facades are the
/// only walls in the level that carry the look's windows (a freestanding run
/// is never glazed; see `gym_scene::wall_runs`). Its south wall keeps a
/// doorway, so the level also shows a jamb and a parapet cap.
pub const SPEC_HOUSE: (i16, i16, i16, i16) = (2, 1, 6, 3);
pub const SPEC_DOOR: CellPos = CellPos { x: 4, z: 3 };

/// Every specimen is the SAME 2 cells wide — identical is the whole point of the
/// bench, and until 2026-07-26 one slab could not be.
///
/// The break specimen used to need four cells: a break was drawn once per 6-wu
/// STRIP with its axis anywhere inside, so a 2.2-wu slab contained that axis
/// barely a third of the time and the bench's break came up EMPTY on its first
/// build. Widening it was the honest answer to a probability — the effect's own
/// scale really was 6 wu, and a bench that hid that would have been lying about
/// the effect. Now a break is an authored COUNT placed on the run
/// (`rt_viewer::crack_geom::run_breaks`), so a 2.2-wu wall asked for one gets
/// one, and the row is uniform again.
pub const SPEC_CELLS: i16 = 2;

/// World (x, z) of specimen `i` in row `r` — the point a caller names it by.
/// The wall line is the cell's -z edge, so its world z IS the row index.
pub fn spec_point(row: usize, i: i16) -> (f32, f32) {
    (spec_x0(row, i) as f32 + SPEC_CELLS as f32 * 0.5, SPEC_Z[row] as f32)
}

/// The x cell specimen `i` of row `row` starts on.
fn spec_x0(row: usize, i: i16) -> i16 {
    SPEC_X0 + row as i16 * SPEC_ROW_DX + i * SPEC_PITCH
}

/// THE EFFECT CATALOGUE (owner, 2026-07-26: "create a special level that shows
/// each of them separately"). Fifteen identical freestanding wall specimens in
/// three rows, each its own RUN — so each carries its own story key, its own
/// damage field and its own knob set, and nothing composes with its neighbour.
/// One small building at the back for the level dress that needs a Room to
/// exist (windows, glass, a doorway jamb, a parapet cap).
///
/// Identical is the point: every specimen is the same 2.2 × 2.1875 wu slab on
/// the same grass under the same sun, so a difference between two of them is
/// the EFFECT and nothing else. The gym cannot do that job — its fifteen piers
/// differ in length, orientation, neighbours and glazing.
///
/// The player spawns in the far corner on purpose. The ROI reveal dissolves an
/// occluder only when its wall FACE puts him on the far side (the `x + 2z`
/// ground-depth gate retired 2026-08-02), and every specimen sits well away
/// from the spawn — so no specimen can ghost at boot, at any camera framing.
/// (The spawn moved 4 cells deeper with row 3, staying clear of the slabs.)
pub fn catalogue_level() -> GymLevel {
    let mut grid = Grid::new(22, 22);
    for (row, &z) in SPEC_Z.iter().enumerate() {
        // Row 3 builds only the slabs it has SUBJECTS for (a control, mud,
        // and the shell hole since the artillery round); an unauthored slab
        // is not a specimen, and the empty ones nearest the spawn sat inside
        // the ROI reveal disc and dissolved on boot. Further placed effects
        // grow this count with their subjects.
        let n = if row == 3 { 3 } else { SPEC_N };
        for i in 0..n {
            let x0 = spec_x0(row, i);
            for x in x0..x0 + SPEC_CELLS {
                grid.set_edge(CellPos::new(x, z), Dir::Zm, EdgeKind::Wall);
            }
        }
    }
    let (x0, z0, x1, z1) = SPEC_HOUSE;
    for z in z0..=z1 {
        for x in x0..=x1 {
            grid.set_cell(CellPos::new(x, z), CellKind::Room);
        }
        grid.set_edge(CellPos::new(x0, z), Dir::Xm, EdgeKind::Wall);
        grid.set_edge(CellPos::new(x1, z), Dir::Xp, EdgeKind::Wall);
    }
    for x in x0..=x1 {
        grid.set_edge(CellPos::new(x, z0), Dir::Zm, EdgeKind::Wall);
        if CellPos::new(x, z1) != SPEC_DOOR {
            grid.set_edge(CellPos::new(x, z1), Dir::Zp, EdgeKind::Wall);
        }
    }
    // One lamp, in the corner opposite everything: the level needs a practical
    // (the probe bake and the look's amber accent both assume one), but an
    // amber pool ON a specimen would be a second variable in every read.
    let lights = vec![(CellPos::new(18, 2), 6)];
    GymLevel { neighborhood: false, grid, player_start: CellPos::new(20, 20), lights }
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
    fn continuous_input_moves_between_cells_without_snapping() {
        let mut g = GymGame::new(GymLevel { neighborhood: false, grid: Grid::new(16, 16), player_start: CellPos::new(4, 4), lights: Vec::new() });
        let start = g.snapshot().position;
        for t in 0..30u64 {
            g.tick(Tick(t), &[Command::MoveWorld { dx: WORLD_INPUT_SCALE as i16, dz: 0, mode: MoveMode::Walk }]);
        }
        let s = g.snapshot();
        assert!(s.position.x > start.x + 0.5, "continuous input must cover part of a cell: {start:?} -> {:?}", s.position);
        assert!((s.position.y - start.y).abs() < 1e-6, "a world-X input must not zigzag in Z: {start:?} -> {:?}", s.position);
        assert_ne!(s.position.x, s.player.x as f32 + 0.5, "the continuous position must not be snapped to the cell centre");
    }

    #[test]
    fn crouch_survives_idle_limits_running_and_releases_cleanly() {
        let mut g = GymGame::new(GymLevel { neighborhood: true, grid: Grid::new(64,64), player_start: CellPos::new(20,20), lights: Vec::new() });
        g.tick(Tick(0), &[Command::Crouch(true)]);
        let crouch_hash = g.state_hash();
        let mut standing=GymGame::new(g.spec().clone()); standing.tick(Tick(0),&[]);
        assert_ne!(crouch_hash,standing.state_hash(),"stance must be part of replay state");
        for t in 1..61 { g.tick(Tick(t), &[]); }
        assert!(g.snapshot().crouching);
        let drive=Command::MoveWorld {dx:1024,dz:0,mode:MoveMode::Run};
        for t in 61..121 {g.tick(Tick(t), &[drive]);}
        assert!((g.snapshot().velocity.length()-SPEED_CROUCH).abs()<0.001);
        g.tick(Tick(121), &[Command::Crouch(false)]);
        for t in 122..182 {g.tick(Tick(t), &[drive]);}
        assert!((g.snapshot().velocity.length()-SURVIVOR_RUN).abs()<0.001);
        assert!(!g.snapshot().crouching);
        for t in 182..200 {g.tick(Tick(t), &[]);}
        assert_eq!(g.snapshot().velocity,Vec2::ZERO);
    }

    #[test]
    fn releasing_sprint_stops_within_eight_ticks_and_a_quarter_metre() {
        let mut g=GymGame::new(GymLevel {neighborhood:true,grid:Grid::new(64,64),player_start:CellPos::new(20,20),lights:Vec::new()});
        for t in 0..60 {g.tick(Tick(t),&[Command::MoveWorld {dx:1024,dz:0,mode:MoveMode::Run}]);}
        let released=g.snapshot().position;
        for t in 60..68 {g.tick(Tick(t),&[]);}
        assert_eq!(g.snapshot().velocity,Vec2::ZERO);
        assert!(g.snapshot().position.distance(released)<0.25);
    }

    #[test]
    fn continuous_input_collides_with_grid_edges_and_keeps_sliding() {
        let mut grid = Grid::new(8, 8);
        grid.set_edge(CellPos::new(1, 2), Dir::Xp, EdgeKind::Wall);
        let mut g = GymGame::new(GymLevel { neighborhood: false, grid, player_start: CellPos::new(1, 2), lights: Vec::new() });
        for t in 0..120u64 {
            g.tick(Tick(t), &[Command::MoveWorld { dx: WORLD_INPUT_SCALE as i16, dz: 0, mode: MoveMode::Run }]);
        }
        let s = g.snapshot();
        assert!(s.position.x <= 2.0 - PLAYER_RADIUS + 1e-4, "the player must stop before the wall: {:?}", s.position);
        assert!((s.position.y - 2.5).abs() < 1e-6, "an axis-aligned wall must not move the player along Z: {:?}", s.position);
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
