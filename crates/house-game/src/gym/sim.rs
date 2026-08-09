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
const ACCEL_WU_PER_S2: f32 = 18.0;
/// Deceleration when no input arrives. Public because click-to-move has to
/// know it: [`super::route::Route::steer`] stops steering one stopping
/// distance (`v² / 2a`) short of the goal so the body coasts onto it.
pub const BRAKE_WU_PER_S2: f32 = 24.0;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MoveMode {
    Walk,
    Run,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Command {
    /// Continuous world-space input, quantized at [`WORLD_INPUT_SCALE`],
    /// sampled every fixed tick. THE movement command since 2026-08-09: the
    /// keyboard produces one from held keys and the mouse produces one from
    /// [`super::route::Route::steer`], so both devices drive one mover.
    ///
    /// It replaced a `Move { dx, dz }` that stepped ONE cell on a per-mode
    /// tick cadence, teleporting the body to the cell centre and zeroing its
    /// velocity. Keeping both meant the player accelerated and slid under
    /// WASD and snapped under the mouse — and every property the continuous
    /// mover is pinned on (stride from distance, collide-and-slide, arrival)
    /// silently did not apply to click-to-move.
    MoveWorld { dx: i16, dz: i16, mode: MoveMode },
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
    /// Continuous player centre in world XZ (cell centres are x/z + 0.5).
    pub position: Vec2,
    pub velocity: Vec2,
}

pub struct GymGame {
    spec: GymLevel,
    player: CellPos,
    position: Vec2,
    velocity: Vec2,
    tick: u64,
}

impl GymGame {
    pub fn new(spec: GymLevel) -> GymGame {
        let position = Vec2::new(spec.player_start.x as f32 + 0.5, spec.player_start.z as f32 + 0.5);
        GymGame { player: spec.player_start, position, velocity: Vec2::ZERO, tick: 0, spec }
    }

    pub fn grid(&self) -> &Grid {
        &self.spec.grid
    }

    pub fn spec(&self) -> &GymLevel {
        &self.spec
    }

    fn speed(mode: MoveMode) -> f32 {
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
        let target = dir * Self::speed(mode);
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
        let grid = &self.spec.grid;
        let (x, z) = collide_and_slide(
            |x, z| grid.blocked_point(x, z, PLAYER_RADIUS),
            self.position.x,
            self.position.y,
            self.velocity.x * TICK_DT,
            self.velocity.y * TICK_DT,
        );
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
        let mut world_input = None;
        for c in cmds {
            match *c {
                Command::MoveWorld { dx, dz, mode } => world_input = Some((dx, dz, mode)),
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
        GymSnapshot { player: self.player, position: self.position, velocity: self.velocity }
    }

    fn state_hash(&self) -> u64 {
        let mut h: u64 = 0xcbf29ce484222325;
        let mut eat = |v: u64| {
            for byte in v.to_le_bytes() {
                h = (h ^ byte as u64).wrapping_mul(0x100000001b3);
            }
        };
        eat(self.tick);
        eat(self.player.x as u64);
        eat(self.player.z as u64);
        eat(self.position.x.to_bits() as u64);
        eat(self.position.y.to_bits() as u64);
        eat(self.velocity.x.to_bits() as u64);
        eat(self.velocity.y.to_bits() as u64);
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
    GymLevel { grid, player_start: CellPos::new(20, 20), lights }
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

    /// A held world input, as a trace feeds it.
    fn hold(dx: f32, dz: f32, mode: MoveMode) -> Command {
        let v = Vec2::new(dx, dz).normalize_or_zero() * WORLD_INPUT_SCALE;
        Command::MoveWorld { dx: v.x.round() as i16, dz: v.y.round() as i16, mode }
    }

    #[test]
    fn replay_twice_is_bit_identical() {
        let walk_west: Vec<(Tick, Command)> = (0..60).map(|i| (Tick(i), hold(-1.0, 0.0, MoveMode::Walk))).collect();
        let run = || {
            let mut r = Runner::new(GymGame::new(gym_level()));
            r.feed(walk_west.clone());
            r.run_ticks(200);
            r.sim.state_hash()
        };
        assert_eq!(run(), run());
    }

    /// Speed is REACHED, not assumed. This replaced a cadence test: the old
    /// mover rate-limited whole cell steps, and the property that survived the
    /// change is that the body ramps — one tick of input cannot produce full
    /// speed, and holding it does, within the ramp the constant promises.
    #[test]
    fn speed_ramps_instead_of_arriving_whole() {
        let mut g = GymGame::new(GymLevel { grid: Grid::new(16, 16), player_start: CellPos::new(8, 8), lights: Vec::new() });
        g.tick(Tick(0), &[hold(1.0, 0.0, MoveMode::Walk)]);
        let first = g.snapshot().velocity.length();
        assert!(first > 0.0 && first < SPEED_WALK, "one tick must not reach walking speed: {first}");
        assert!((first - ACCEL_WU_PER_S2 * TICK_DT).abs() < 1e-5, "the first tick is exactly one acceleration step: {first}");
        // ceil(SPEED_WALK / (ACCEL * dt)) ticks to reach the target, plus one.
        let need = (SPEED_WALK / (ACCEL_WU_PER_S2 * TICK_DT)).ceil() as u64 + 1;
        for t in 1..=need {
            g.tick(Tick(t), &[hold(1.0, 0.0, MoveMode::Walk)]);
        }
        assert!((g.snapshot().velocity.length() - SPEED_WALK).abs() < 1e-5, "holding input must reach walking speed");
    }

    /// Releasing input brakes to a STOP — the property click-to-move's arrival
    /// leans on when it stops steering a stopping distance short of the goal.
    #[test]
    fn releasing_input_brakes_to_rest() {
        let mut g = GymGame::new(GymLevel { grid: Grid::new(16, 16), player_start: CellPos::new(8, 8), lights: Vec::new() });
        for t in 0..30u64 {
            g.tick(Tick(t), &[hold(1.0, 0.0, MoveMode::Run)]);
        }
        let moving = g.snapshot();
        assert!(moving.velocity.length() > 0.0);
        let need = (SPEED_RUN / (BRAKE_WU_PER_S2 * TICK_DT)).ceil() as u64 + 1;
        for t in 30..30 + need {
            g.tick(Tick(t), &[]);
        }
        let rest = g.snapshot();
        assert_eq!(rest.velocity, Vec2::ZERO, "no input must brake all the way to rest");
        // The coast is the stopping distance the router predicts: v²/2a.
        let coast = rest.position.x - moving.position.x;
        let predicted = moving.velocity.length_squared() / (2.0 * BRAKE_WU_PER_S2);
        assert!((coast - predicted).abs() < 0.05, "coast {coast} vs predicted {predicted}");
    }

    #[test]
    fn continuous_input_moves_between_cells_without_snapping() {
        let mut g = GymGame::new(GymLevel { grid: Grid::new(16, 16), player_start: CellPos::new(4, 4), lights: Vec::new() });
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
    fn continuous_input_collides_with_grid_edges_and_keeps_sliding() {
        let mut grid = Grid::new(8, 8);
        grid.set_edge(CellPos::new(1, 2), Dir::Xp, EdgeKind::Wall);
        let mut g = GymGame::new(GymLevel { grid, player_start: CellPos::new(1, 2), lights: Vec::new() });
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
            g.tick(Tick(t), &[hold(0.0, 1.0, MoveMode::Run)]);
        }
        let s = g.snapshot();
        assert!(g.grid().in_bounds(s.player), "the player can never leave the grid");
        assert_eq!(s.player.z, g.grid().h - 1, "the run must stop AT the boundary, not before");
        assert!(
            s.position.y >= g.grid().h as f32 - 1.0 && s.position.y <= g.grid().h as f32 - PLAYER_RADIUS + 1e-4,
            "the body rests against the boundary with its own clearance: {:?}",
            s.position
        );
    }

    /// Walking a continuous body straight north from the spawn hits the
    /// building's south wall and STAYS out; the same walk offset onto the
    /// doorway's column goes in. The old version scripted cell steps through
    /// the door, which only proved the cadence executed the script.
    #[test]
    fn the_doorway_is_the_only_way_in() {
        // The doorway column, approached from the south.
        let mut open = GymGame::new(GymLevel {
            grid: gym_level().grid,
            player_start: CellPos::new(DOORWAY.x, DOORWAY.z + 3),
            lights: Vec::new(),
        });
        for t in 0..180u64 {
            open.tick(Tick(t), &[hold(0.0, -1.0, MoveMode::Walk)]);
        }
        assert_eq!(open.grid().cell(open.snapshot().player), CellKind::Room, "the doorway admits");

        // One cell east of it is the building's south wall.
        let mut shut = GymGame::new(GymLevel {
            grid: gym_level().grid,
            player_start: CellPos::new(DOORWAY.x + 1, DOORWAY.z + 3),
            lights: Vec::new(),
        });
        for t in 0..180u64 {
            shut.tick(Tick(t), &[hold(0.0, -1.0, MoveMode::Walk)]);
        }
        let s = shut.snapshot();
        assert_ne!(shut.grid().cell(s.player), CellKind::Room, "the wall must hold: {:?}", s.position);
        assert!(s.position.y > DOORWAY.z as f32 + 1.0, "the body stops south of the wall: {:?}", s.position);
    }
}
