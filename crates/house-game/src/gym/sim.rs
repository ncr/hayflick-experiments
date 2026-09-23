//! The gym sim — the smallest thing that is still a game: one player moving
//! continuously around the hand-authored gym level. ONE mover since
//! 2026-08-09 ([`Command::MoveWorld`] — keyboard and click-to-move both feed
//! it; the cell-step command is gone). No NPCs, no doors, no clock, no RNG
//! (owner directive 2026-07-12: cut to a single level with a few walls, one
//! building and the player).
//!
//! Fully headless and deterministic: fixed tick, trace replay, `state_hash`
//! over every observable field.

use super::grid::{CellPos, Dir, EdgeKind, Grid};
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
pub const SURVIVOR_WALK: f32 = 2.2;
pub const SURVIVOR_RUN: f32 = 4.2;
pub const SPEED_CROUCH: f32 = 1.1;
const ACCEL_WU_PER_S2: f32 = 18.0;
/// Deceleration when no input arrives. Public because click-to-move has to
/// know it: [`super::route::Route::steer`] stops steering one stopping
/// distance (`v² / 2a`) short of the goal so the body coasts onto it.
/// 34 since 2026-09-05 (owner: a released sprint stops within eight ticks
/// and a quarter metre — was 24).
pub const BRAKE_WU_PER_S2: f32 = 34.0;

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
    Crouch(bool),
    Wait,
}

/// A wall-paint brush effect (creative mode's palette). The surface crate
/// owns what each one looks like; the level only names it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PaintEffect {
    Rain,
    Soot,
    Spall,
}

impl PaintEffect {
    pub const ALL: [PaintEffect; 3] = [PaintEffect::Rain, PaintEffect::Soot, PaintEffect::Spall];

    pub fn name(self) -> &'static str {
        match self {
            PaintEffect::Rain => "rain",
            PaintEffect::Soot => "soot",
            PaintEffect::Spall => "spall",
        }
    }

    pub fn by_name(s: &str) -> Option<PaintEffect> {
        PaintEffect::ALL.into_iter().find(|e| e.name() == s)
    }
}

/// One brush dab on a wall, WORLD-anchored: the point on the wall face, which
/// face (the outward normal's axis and sign: `+x`, `-x`, `+z`, `-z`), and the
/// brush radius. World anchoring keeps a stroke on its spot when walls around
/// it are rebuilt or merged into longer runs.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct PaintStroke {
    pub effect: PaintEffect,
    pub pos: [f32; 3],
    /// Outward normal: axis 0 = x, 2 = z; `sign` ±1.
    pub axis: u8,
    pub sign: i8,
    pub r: f32,
}

/// A ground brush (creative mode's plants category): grow green grass, dry
/// it to straw, or mow it down. The `flora` crate bakes what each one does.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum GrowBrush {
    Grass,
    Dry,
    Mow,
    /// Scorch the ground (fire): burnt soil, and whatever grows there goes
    /// sparse and dry.
    Scorch,
}

impl GrowBrush {
    pub const ALL: [GrowBrush; 4] = [GrowBrush::Grass, GrowBrush::Dry, GrowBrush::Mow, GrowBrush::Scorch];
    pub fn name(self) -> &'static str {
        match self {
            GrowBrush::Grass => "grass",
            GrowBrush::Dry => "dry",
            GrowBrush::Mow => "mow",
            GrowBrush::Scorch => "scorch",
        }
    }
    pub fn by_name(s: &str) -> Option<GrowBrush> {
        GrowBrush::ALL.into_iter().find(|b| b.name() == s)
    }
}

/// One ground dab at world (x, z) with radius `r`.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct GroundStroke {
    pub brush: GrowBrush,
    pub x: f32,
    pub z: f32,
    pub r: f32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PlantKind {
    Tree,
    Bush,
}

impl PlantKind {
    pub fn name(self) -> &'static str {
        match self {
            PlantKind::Tree => "tree",
            PlantKind::Bush => "bush",
        }
    }
    pub fn by_name(s: &str) -> Option<PlantKind> {
        [PlantKind::Tree, PlantKind::Bush].into_iter().find(|k| k.name() == s)
    }
}

/// A street prop (creative mode's props category). The `props` crate grows
/// its geometry from the seed; the level only names the kind, and the sim
/// knows its footprint (props are solid).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PropKind {
    Car,
    Barrel,
    Crate,
    Tires,
    Barrier,
    Pole,
    Sign,
    Hydrant,
    Mailbox,
    Bench,
}

impl PropKind {
    pub const ALL: [PropKind; 10] = [PropKind::Car, PropKind::Barrel, PropKind::Crate, PropKind::Tires, PropKind::Barrier, PropKind::Pole, PropKind::Sign, PropKind::Hydrant, PropKind::Mailbox, PropKind::Bench];

    pub fn name(self) -> &'static str {
        match self {
            PropKind::Car => "car",
            PropKind::Barrel => "barrel",
            PropKind::Crate => "crate",
            PropKind::Tires => "tires",
            PropKind::Barrier => "barrier",
            PropKind::Pole => "pole",
            PropKind::Sign => "sign",
            PropKind::Hydrant => "hydrant",
            PropKind::Mailbox => "mailbox",
            PropKind::Bench => "bench",
        }
    }

    pub fn by_name(s: &str) -> Option<PropKind> {
        PropKind::ALL.into_iter().find(|k| k.name() == s)
    }

    /// Footprint half extents along the prop's own x and z (the `props`
    /// crate builds each kind to fit this, pinned by its tests).
    pub fn half(self) -> (f32, f32) {
        match self {
            PropKind::Car => (2.1, 0.9),
            PropKind::Barrel => (0.32, 0.32),
            PropKind::Crate => (0.42, 0.42),
            PropKind::Tires => (0.42, 0.42),
            PropKind::Barrier => (1.0, 0.32),
            PropKind::Pole => (0.15, 0.15),
            PropKind::Sign => (0.07, 0.07),
            PropKind::Hydrant => (0.2, 0.2),
            PropKind::Mailbox => (0.12, 0.12),
            PropKind::Bench => (0.9, 0.3),
        }
    }
}

/// A placed prop: kind, world position, turn about y (radians), seed.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Prop {
    pub kind: PropKind,
    pub x: f32,
    pub z: f32,
    pub yaw: f32,
    pub seed: u32,
}

impl Prop {
    /// Whether a body of radius `r` centred at (x, z) overlaps this prop's
    /// footprint (an oriented rectangle grown by `r`).
    pub fn blocks(&self, x: f32, z: f32, r: f32) -> bool {
        let (hx, hz) = self.kind.half();
        let (s, c) = self.yaw.sin_cos();
        let (dx, dz) = (x - self.x, z - self.z);
        // into the prop's frame (the renderer turns local +x by `yaw` about y)
        let (lx, lz) = (dx * c - dz * s, dx * s + dz * c);
        lx.abs() < hx + r && lz.abs() < hz + r
    }
}

/// What covers the ground in a floor rectangle. A building's Room cells are
/// always slab floor; everything no rectangle covers is open soil.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FloorKind {
    Soil,
    Road,
    Walk,
}

impl FloorKind {
    pub const ALL: [FloorKind; 3] = [FloorKind::Soil, FloorKind::Road, FloorKind::Walk];
    pub fn name(self) -> &'static str {
        match self {
            FloorKind::Soil => "soil",
            FloorKind::Road => "road",
            FloorKind::Walk => "walk",
        }
    }
    pub fn by_name(s: &str) -> Option<FloorKind> {
        FloorKind::ALL.into_iter().find(|k| k.name() == s)
    }
}

/// A rectangle of ground surface, world (x0, z0, x1, z1). Later rectangles
/// cover earlier ones — painting is layering.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Floor {
    pub kind: FloorKind,
    pub rect: [f32; 4],
}

/// A placed plant: procedural, so the seed IS the plant (the renderer grows
/// the same tree from it every time). Presentation only — the sim walks
/// through foliage.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Plant {
    pub kind: PlantKind,
    pub x: f32,
    pub z: f32,
    pub seed: u32,
}

/// The gym level: the grid, where the player spawns, and the lamp cells the
/// scene builder turns into named point lights (render data — the sim has no
/// light model).
#[derive(Clone)]
pub struct GymLevel {
    /// Brush strokes painted onto walls in creative mode — presentation data
    /// the sim never reads (the renderer bakes them into wall surfaces), kept
    /// here because it is authored with the level and saved in its file.
    pub paint: Vec<PaintStroke>,
    /// Ground brush strokes (grass, dry, mow) over the level's natural growth.
    pub ground: Vec<GroundStroke>,
    /// Trees and bushes.
    pub plants: Vec<Plant>,
    /// Ground surface rectangles (road, sidewalk, soil), later over earlier.
    pub floors: Vec<Floor>,
    /// Potholes in the road: world (x, z, radius).
    pub potholes: Vec<[f32; 3]>,
    /// Window openings: world (x, z) of the opening's centre on a wall line.
    pub windows: Vec<[f32; 2]>,
    /// Broken roof slabs over world rects (x0, z0, x1, z1); the +z edge is the
    /// torn one.
    pub roofs: Vec<[f32; 4]>,
    /// Street props (solid).
    pub props: Vec<Prop>,
    pub neighborhood: bool,
    pub grid: Grid,
    pub player_start: CellPos,
    /// Static lamps (cell, intensity 0..8-ish).
    pub lights: Vec<(CellPos, i32)>,
}

/// A tree trunk's collision radius (bushes are walked through).
pub const TRUNK_R: f32 = 0.14;

impl GymLevel {
    /// The body-centre collision query: the grid's walls and boundary, every
    /// prop's footprint, and tree trunks. The sim's collide-and-slide and the
    /// click-to-move route's sight lines both ask this, so a shortcut the
    /// route takes is one the body can walk.
    pub fn blocked(&self, x: f32, z: f32, r: f32) -> bool {
        self.grid.blocked_point(x, z, r)
            || self.props.iter().any(|p| p.blocks(x, z, r))
            || self.plants.iter().any(|p| p.kind == PlantKind::Tree && (p.x - x).powi(2) + (p.z - z).powi(2) < (TRUNK_R + r).powi(2))
    }
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
    tick: u64,
}

impl GymGame {
    pub fn new(spec: GymLevel) -> GymGame {
        let position = Vec2::new(spec.player_start.x as f32 + 0.5, spec.player_start.z as f32 + 0.5);
        GymGame { player: spec.player_start, position, velocity: Vec2::ZERO, contact: Vec2::ZERO, intent: Vec2::ZERO, crouching: false, tick: 0, spec }
    }

    pub fn grid(&self) -> &Grid {
        &self.spec.grid
    }

    pub fn spec(&self) -> &GymLevel {
        &self.spec
    }

    /// Swap in an edited level (creative mode) WITHOUT respawning: the body
    /// keeps its position and stops. Before this the sim kept the level it was
    /// constructed with, so a wall built in an editor rendered and could be
    /// walked through. A body the new walls now overlap is left where it is;
    /// collide-and-slide only refuses moves INTO a wall, so it can walk out.
    pub fn set_level(&mut self, spec: GymLevel) {
        self.spec = spec;
        self.velocity = Vec2::ZERO;
        self.intent = Vec2::ZERO;
        self.player = self.cell_for_position();
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
        let spec = &self.spec;
        let (x, z) = collide_and_slide(
            |x, z| spec.blocked(x, z, PLAYER_RADIUS),
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
/// DOCUMENTS the checked-in `gym.level` — the file is the source since
/// 2026-08-09; a test pins the two against each other so an editor edit that
/// moves the building fails loudly here instead of silently orphaning every
/// test that walks it.
pub const HOUSE: (i16, i16, i16, i16) = (3, 3, 7, 7); // x0, z0, x1, z1
/// The doorway cell: its +z edge stays open through the building's south wall.
pub const DOORWAY: CellPos = CellPos { x: 5, z: 7 };

/// The gym: an 18×14 field, one 5×5 building with a doorway, two
/// freestanding walls, two lamps, the player. Everything the Faza-1 look
/// work and the Faza-2 movement work needs, and nothing else.
///
/// LEVEL-AS-DATA since 2026-08-09: this parses the checked-in
/// [`super::level_file::GYM_LEVEL_SRC`] — the same bytes creative mode's save writes back
/// — verified grid-hash-identical to the hand-written builder it replaced.
/// Panics only on a malformed checked-in file, which
/// `checked_in_level_is_canonical` catches at `cargo test` time first.
pub fn gym_level() -> GymLevel {
    super::level_file::parse(super::level_file::GYM_LEVEL_SRC).expect("checked-in gym.level must parse")
}

/// A derelict concrete test yard: clear walking lanes between five histories.
/// The walls share the collision grid; cover erosion stays inside each slab.
/// Code-generated (its walls are authored in rt-viewer's `concrete.rs`).
pub fn concrete_level() -> GymLevel {
    let mut grid = Grid::new(18, 15);
    for (x0,x1,z) in [(1,4,3),(3,10,6),(1,5,10),(9,14,11)] {
        for x in x0..x1 { grid.set_edge(CellPos::new(x,z),Dir::Zm,EdgeKind::Wall); }
    }
    for z in 3..8 { grid.set_edge(CellPos::new(13,z),Dir::Xm,EdgeKind::Wall); }
    GymLevel { props: Vec::new(), floors: Vec::new(), potholes: Vec::new(), windows: Vec::new(), roofs: Vec::new(), ground: Vec::new(), plants: Vec::new(), paint: Vec::new(), neighborhood: false, grid, player_start: CellPos::new(8,12), lights: Vec::new() }
}

#[cfg(test)]
mod tests {
    #[test]
    fn props_and_tree_trunks_block_the_body() {
        let mut lv = super::gym_level();
        lv.props.push(super::Prop { kind: super::PropKind::Car, x: 8.0, z: 8.0, yaw: std::f32::consts::FRAC_PI_2, seed: 1 });
        lv.plants.push(super::Plant { kind: super::PlantKind::Tree, x: 3.0, z: 12.0, seed: 1 });
        // a car turned a quarter runs along z: long in z, narrow in x
        assert!(lv.blocked(8.0, 9.8, 0.2), "along the car's length");
        assert!(!lv.blocked(9.4, 8.0, 0.2), "clear of its side");
        assert!(lv.blocked(3.2, 12.0, 0.2) && !lv.blocked(3.5, 12.0, 0.2), "the trunk, and just past it");
    }

    use super::*;
    use crate::gym::grid::CellKind;
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

    /// [`HOUSE`]/[`DOORWAY`] document the checked-in `gym.level`; this is the
    /// pin that keeps the constants and the file telling one story after an
    /// editor save moves a wall. Every interior cell is Room, the perimeter is
    /// walled, and the doorway's own edge is the one gap.
    #[test]
    fn the_house_constants_describe_the_checked_in_level() {
        let lvl = gym_level();
        let (x0, z0, x1, z1) = HOUSE;
        for z in z0..=z1 {
            for x in x0..=x1 {
                assert_eq!(lvl.grid.cell(CellPos::new(x, z)), CellKind::Room, "({x}, {z}) inside HOUSE");
            }
            assert!(!lvl.grid.open(CellPos::new(x0, z), Dir::Xm), "west wall at z={z}");
            assert!(!lvl.grid.open(CellPos::new(x1, z), Dir::Xp), "east wall at z={z}");
        }
        for x in x0..=x1 {
            assert!(!lvl.grid.open(CellPos::new(x, z0), Dir::Zm), "north wall at x={x}");
            let south_open = lvl.grid.open(CellPos::new(x, z1), Dir::Zp);
            assert_eq!(south_open, CellPos::new(x, z1) == DOORWAY, "south wall at x={x}: the doorway is the one gap");
        }
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
        let mut g = GymGame::new(GymLevel { props: Vec::new(), floors: Vec::new(), potholes: Vec::new(), windows: Vec::new(), roofs: Vec::new(), ground: Vec::new(), plants: Vec::new(), paint: Vec::new(), neighborhood: false, grid: Grid::new(16, 16), player_start: CellPos::new(8, 8), lights: Vec::new() });
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
        let mut g = GymGame::new(GymLevel { props: Vec::new(), floors: Vec::new(), potholes: Vec::new(), windows: Vec::new(), roofs: Vec::new(), ground: Vec::new(), plants: Vec::new(), paint: Vec::new(), neighborhood: false, grid: Grid::new(16, 16), player_start: CellPos::new(8, 8), lights: Vec::new() });
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
        let mut g = GymGame::new(GymLevel { props: Vec::new(), floors: Vec::new(), potholes: Vec::new(), windows: Vec::new(), roofs: Vec::new(), ground: Vec::new(), plants: Vec::new(), paint: Vec::new(), neighborhood: false, grid: Grid::new(16, 16), player_start: CellPos::new(4, 4), lights: Vec::new() });
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
        let mut g = GymGame::new(GymLevel { props: Vec::new(), floors: Vec::new(), potholes: Vec::new(), windows: Vec::new(), roofs: Vec::new(), ground: Vec::new(), plants: Vec::new(), paint: Vec::new(), neighborhood: true, grid: Grid::new(64,64), player_start: CellPos::new(20,20), lights: Vec::new() });
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
        let mut g=GymGame::new(GymLevel { props: Vec::new(), floors: Vec::new(), potholes: Vec::new(), windows: Vec::new(), roofs: Vec::new(), ground: Vec::new(), plants: Vec::new(), paint: Vec::new(),neighborhood:true,grid:Grid::new(64,64),player_start:CellPos::new(20,20),lights:Vec::new()});
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
        let mut g = GymGame::new(GymLevel { props: Vec::new(), floors: Vec::new(), potholes: Vec::new(), windows: Vec::new(), roofs: Vec::new(), ground: Vec::new(), plants: Vec::new(), paint: Vec::new(), neighborhood: false, grid, player_start: CellPos::new(1, 2), lights: Vec::new() });
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
        let mut open = GymGame::new(GymLevel { props: Vec::new(), floors: Vec::new(), potholes: Vec::new(), windows: Vec::new(), roofs: Vec::new(), ground: Vec::new(), plants: Vec::new(), paint: Vec::new(),
            neighborhood: false,
            grid: gym_level().grid,
            player_start: CellPos::new(DOORWAY.x, DOORWAY.z + 3),
            lights: Vec::new(),
        });
        for t in 0..180u64 {
            open.tick(Tick(t), &[hold(0.0, -1.0, MoveMode::Walk)]);
        }
        assert_eq!(open.grid().cell(open.snapshot().player), CellKind::Room, "the doorway admits");

        // One cell east of it is the building's south wall.
        let mut shut = GymGame::new(GymLevel { props: Vec::new(), floors: Vec::new(), potholes: Vec::new(), windows: Vec::new(), roofs: Vec::new(), ground: Vec::new(), plants: Vec::new(), paint: Vec::new(),
            neighborhood: false,
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
