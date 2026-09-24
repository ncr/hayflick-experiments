//! The gym sim — the smallest thing that is still a game: one player moving
//! continuously around the hand-authored gym level. ONE mover since
//! 2026-08-09 ([`Command::MoveWorld`] — keyboard and click-to-move both feed
//! it; the cell-step command is gone). No NPCs, no doors, no clock, no RNG
//! (owner directive 2026-07-12: cut to a single level with a few walls, one
//! building and the player).
//!
//! Fully headless and deterministic: fixed tick, trace replay, `state_hash`
//! over every observable field.
//!
//! THE FIRST GAMEPLAY LOOP (2026-09-24): the player SEARCHES props
//! ([`Command::Search`] — cars, crates, barrels, mailboxes; what each holds is
//! [`super::loot`]'s pure function of its seed), carries an inventory, reads a
//! log of what happened, and leaves a level through its EXITS (rectangles
//! naming another level). An inventory and the set of searched props cross
//! levels as a [`Carry`].

use super::grid::{CellPos, Dir, EdgeKind, Grid};
use super::loot::{self, Item};
use std::collections::BTreeSet;
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
    /// Search the nearest searchable prop within reach ([`GymGame::search_target`]).
    /// The search takes the prop's [`loot::search_ticks`]; the body stands
    /// still meanwhile, and movement input breaks it off.
    Search,
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
            PropKind::Car => (2.4, 0.95),
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

    /// Roughly how tall the prop stands (wu) — enough for a click to pick it
    /// by its body, not only by its footprint on the ground.
    pub fn height(self) -> f32 {
        match self {
            PropKind::Car => 1.45,
            PropKind::Barrel => 0.9,
            PropKind::Crate => 0.85,
            PropKind::Tires => 0.6,
            PropKind::Barrier => 0.8,
            PropKind::Pole => 3.0,
            PropKind::Sign => 2.2,
            PropKind::Hydrant => 0.75,
            PropKind::Mailbox => 1.25,
            PropKind::Bench => 0.8,
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

    /// Distance from (x, z) to the prop's footprint (0 inside it).
    pub fn distance(&self, x: f32, z: f32) -> f32 {
        let (hx, hz) = self.kind.half();
        let (s, c) = self.yaw.sin_cos();
        let (dx, dz) = (x - self.x, z - self.z);
        let (lx, lz) = (dx * c - dz * s, dx * s + dz * c);
        Vec2::new((lx.abs() - hx).max(0.0), (lz.abs() - hz).max(0.0)).length()
    }

    /// Where a ray (origin `o`, direction `d`) first enters the prop's box
    /// (footprint × height, each half extent at least `min_half`), as a ray
    /// parameter — `None` on a miss.
    pub fn hit(&self, o: glam::Vec3, d: glam::Vec3, min_half: f32) -> Option<f32> {
        let (hx, hz) = self.kind.half();
        let (hx, hz) = (hx.max(min_half), hz.max(min_half));
        let (s, c) = self.yaw.sin_cos();
        let local = |v: glam::Vec3| glam::Vec3::new(v.x * c - v.z * s, v.y, v.x * s + v.z * c);
        let (lo, ld) = (local(o - glam::Vec3::new(self.x, 0.0, self.z)), local(d));
        let (min, max) = (glam::Vec3::new(-hx, -0.1, -hz), glam::Vec3::new(hx, self.kind.height(), hz));
        let (mut t0, mut t1) = (f32::NEG_INFINITY, f32::INFINITY);
        for a in 0..3 {
            if ld[a].abs() < 1e-9 {
                if lo[a] < min[a] || lo[a] > max[a] {
                    return None;
                }
                continue;
            }
            let (ta, tb) = ((min[a] - lo[a]) / ld[a], (max[a] - lo[a]) / ld[a]);
            t0 = t0.max(ta.min(tb));
            t1 = t1.min(ta.max(tb));
        }
        (t0 <= t1 && t1 >= 0.0).then_some(t0.max(0.0))
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

/// A way out of a level: walking into `rect` (world x0, z0, x1, z1) takes the
/// player to the level named `to` (a LEVELS menu name), at cell `spawn`
/// there.
#[derive(Clone, PartialEq, Debug)]
pub struct Exit {
    pub rect: [f32; 4],
    pub spawn: CellPos,
    pub to: String,
}

impl Exit {
    pub fn contains(&self, p: Vec2) -> bool {
        p.x >= self.rect[0] && p.y >= self.rect[1] && p.x <= self.rect[2] && p.y <= self.rect[3]
    }
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
    /// Ways out to other levels.
    pub exits: Vec<Exit>,
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

    /// The SEARCHABLE prop a click ray hits first (the viewer unprojects the
    /// click into the ray) — `None` when it hits none.
    pub fn pick_prop(&self, o: glam::Vec3, d: glam::Vec3) -> Option<usize> {
        self.props
            .iter()
            .enumerate()
            .filter(|(_, p)| super::loot::search_ticks(p.kind).is_some())
            // a mailbox is a hand wide: the pick box is at least 0.3 wu a
            // side, or a click must land on its few pixels exactly
            .filter_map(|(i, p)| p.hit(o, d, 0.3).map(|t| (i, t)))
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(i, _)| i)
    }

    /// Where to stand to search prop `i`: a free point just outside its
    /// footprint, within [`REACH`], nearest to `from` — `None` if every side
    /// is walled in. Candidates ring the footprint (sides and corners) in the
    /// prop's own frame, a hair outside the body's collision: a route counts
    /// itself arrived within one body radius of its goal, and the point must
    /// still be in reach from there.
    pub fn approach(&self, i: usize, from: Vec2) -> Option<Vec2> {
        let p = self.props[i];
        let (hx, hz) = p.kind.half();
        let gap = PLAYER_RADIUS + 0.04;
        let (s, c) = p.yaw.sin_cos();
        let mut best: Option<(f32, Vec2)> = None;
        for k in 0..16 {
            let a = k as f32 * std::f32::consts::TAU / 16.0;
            // a point on the footprint's boundary in direction `a`, pushed out
            let (dx, dz) = (a.cos(), a.sin());
            let scale = (hx / dx.abs().max(1e-6)).min(hz / dz.abs().max(1e-6));
            let (lx, lz) = (dx * scale + dx.signum() * gap * (dx.abs() > 0.3) as i32 as f32, dz * scale + dz.signum() * gap * (dz.abs() > 0.3) as i32 as f32);
            // back to the world (the inverse of `blocks`' turn)
            let w = Vec2::new(p.x + lx * c + lz * s, p.z - lx * s + lz * c);
            if self.blocked(w.x, w.y, PLAYER_RADIUS) || !p.blocks(w.x, w.y, PLAYER_RADIUS + REACH) {
                continue;
            }
            let d = w.distance_squared(from);
            if best.is_none_or(|(bd, _)| d < bd) {
                best = Some((d, w));
            }
        }
        best.map(|(_, w)| w)
    }
}

/// How far past the body's radius a prop can be and still be searched (wu).
pub const REACH: f32 = 0.35;

/// A prop's identity for the searched set: kind, seed and position. Not its
/// index — a creative-mode edit reorders the list.
pub fn prop_key(p: &Prop) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for v in [p.kind as u64, p.seed as u64, p.x.to_bits() as u64, p.z.to_bits() as u64] {
        for byte in v.to_le_bytes() {
            h = (h ^ byte as u64).wrapping_mul(0x100_0000_01b3);
        }
    }
    h
}

/// One line of the game log: when it happened and what.
#[derive(Clone, PartialEq, Debug)]
pub struct LogLine {
    pub tick: u64,
    pub text: String,
}

/// A search in progress: which prop (index into the level's props, and its
/// key), and ticks left of how many.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Search {
    pub prop: usize,
    pub key: u64,
    pub left: u32,
    pub total: u32,
}

/// What the player takes from one level to the next.
#[derive(Clone, Default, PartialEq, Debug)]
pub struct Carry {
    /// Items in the order they were first found, each with its count.
    pub inventory: Vec<(Item, u16)>,
    /// [`prop_key`]s of every prop searched so far, on any level.
    pub searched: BTreeSet<u64>,
    pub log: Vec<LogLine>,
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
    carry: Carry,
    search: Option<Search>,
    /// The exit the body stands in (entering one is what takes it).
    in_exit: Option<usize>,
    /// The exit taken, once the body walks into one — the shell switches
    /// level on it.
    exit: Option<usize>,
}

impl GymGame {
    pub fn new(spec: GymLevel) -> GymGame {
        GymGame::with_carry(spec, Carry::default())
    }

    /// A fresh game on `spec` that carries in what the player brought from
    /// the last level.
    pub fn with_carry(spec: GymLevel, carry: Carry) -> GymGame {
        let position = Vec2::new(spec.player_start.x as f32 + 0.5, spec.player_start.z as f32 + 0.5);
        // spawning inside an exit does not take it: only walking in does
        let in_exit = spec.exits.iter().position(|e| e.contains(position));
        GymGame { player: spec.player_start, position, velocity: Vec2::ZERO, contact: Vec2::ZERO, intent: Vec2::ZERO, crouching: false, tick: 0, carry, search: None, in_exit, exit: None, spec }
    }

    /// Everything the player carries, to hand to the next level.
    pub fn carry(&self) -> &Carry {
        &self.carry
    }

    pub fn inventory(&self) -> &[(Item, u16)] {
        &self.carry.inventory
    }

    pub fn log(&self) -> &[LogLine] {
        &self.carry.log
    }

    /// The search in progress, if any.
    pub fn searching(&self) -> Option<Search> {
        self.search
    }

    /// The exit the player walked into, once they have.
    pub fn exit_taken(&self) -> Option<&Exit> {
        self.exit.map(|i| &self.spec.exits[i])
    }

    /// Forget a taken exit the shell could not follow (a level name it does
    /// not know) — the player stays, and walking out and back in retries.
    pub fn clear_exit(&mut self) {
        self.exit = None;
    }

    /// The nearest SEARCHABLE prop within reach of the body, and whether it
    /// has been searched already — the HUD's prompt reads this, and
    /// [`Command::Search`] acts on it (if unsearched).
    pub fn near_prop(&self) -> Option<(usize, bool)> {
        let p = self.position;
        self.spec
            .props
            .iter()
            .enumerate()
            .filter(|(_, q)| loot::search_ticks(q.kind).is_some() && q.blocks(p.x, p.y, PLAYER_RADIUS + REACH))
            // nearest by footprint, not centre: beside a car's door the car
            // is nearer than a mailbox by its bonnet
            .min_by(|a, b| a.1.distance(p.x, p.y).total_cmp(&b.1.distance(p.x, p.y)))
            .map(|(i, q)| (i, self.carry.searched.contains(&prop_key(q))))
    }

    /// The prop a [`Command::Search`] this tick would start on.
    pub fn search_target(&self) -> Option<usize> {
        self.near_prop().filter(|&(_, done)| !done).map(|(i, _)| i)
    }

    fn say(&mut self, text: String) {
        self.carry.log.push(LogLine { tick: self.tick, text });
    }

    fn start_search(&mut self) {
        if self.search.is_some() {
            return;
        }
        let Some(i) = self.search_target() else { return };
        let q = self.spec.props[i];
        let total = loot::search_ticks(q.kind).expect("near_prop only offers searchable props");
        self.search = Some(Search { prop: i, key: prop_key(&q), left: total, total });
    }

    /// One tick of the search in progress; the last one hands over the finds.
    fn search_tick(&mut self) {
        let Some(mut s) = self.search else { return };
        s.left -= 1;
        if s.left > 0 {
            self.search = Some(s);
            return;
        }
        self.search = None;
        let q = self.spec.props[s.prop];
        let found = loot::contents(q.kind, q.seed);
        for &(item, n) in &found {
            match self.carry.inventory.iter_mut().find(|(i, _)| *i == item) {
                Some(slot) => slot.1 = slot.1.saturating_add(n),
                None => self.carry.inventory.push((item, n)),
            }
        }
        self.carry.searched.insert(s.key);
        self.say(loot::describe(q.kind, &found));
    }

    /// Did the body walk into an exit this tick?
    fn exit_check(&mut self) {
        let now = self.spec.exits.iter().position(|e| e.contains(self.position));
        if let Some(i) = now.filter(|_| now != self.in_exit && self.exit.is_none()) {
            self.exit = Some(i);
            let to = self.spec.exits[i].to.clone();
            self.say(format!("heading to {to}"));
        }
        self.in_exit = now;
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
        // the prop list may have been reordered under a search in progress
        self.search = None;
        self.in_exit = self.spec.exits.iter().position(|e| e.contains(self.position));
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
        let mut search = false;
        for c in cmds {
            match *c {
                Command::MoveWorld { dx, dz, mode } => world_input = Some((dx, dz, mode)),
                Command::Crouch(active) => self.crouching = active,
                Command::Search => search = true,
                Command::Wait => {}
            }
        }
        if search {
            self.start_search();
        }
        // walking off breaks a search off
        if self.search.is_some() && world_input.is_some_and(|(dx, dz, _)| dx != 0 || dz != 0) {
            let q = self.spec.props[self.search.unwrap().prop];
            self.search = None;
            self.say(format!("stopped searching the {}", q.kind.name()));
        }
        if self.search.is_some() {
            self.brake_world();
            self.search_tick();
        } else if let Some((dx, dz, mode)) = world_input {
            self.move_world(dx, dz, mode);
        } else {
            self.brake_world();
        }
        self.exit_check();
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
        for &(item, n) in &self.carry.inventory {
            eat(item as u64);
            eat(n as u64);
        }
        for &k in &self.carry.searched {
            eat(k);
        }
        eat(self.carry.log.len() as u64);
        if let Some(s) = self.search {
            eat(s.key);
            eat(s.left as u64);
        }
        eat(self.exit.map_or(u64::MAX, |i| i as u64));
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
    GymLevel { props: Vec::new(), exits: Vec::new(), floors: Vec::new(), potholes: Vec::new(), windows: Vec::new(), roofs: Vec::new(), ground: Vec::new(), plants: Vec::new(), paint: Vec::new(), neighborhood: false, grid, player_start: CellPos::new(8,12), lights: Vec::new() }
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
        let mut g = GymGame::new(GymLevel { props: Vec::new(), exits: Vec::new(), floors: Vec::new(), potholes: Vec::new(), windows: Vec::new(), roofs: Vec::new(), ground: Vec::new(), plants: Vec::new(), paint: Vec::new(), neighborhood: false, grid: Grid::new(16, 16), player_start: CellPos::new(8, 8), lights: Vec::new() });
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
        let mut g = GymGame::new(GymLevel { props: Vec::new(), exits: Vec::new(), floors: Vec::new(), potholes: Vec::new(), windows: Vec::new(), roofs: Vec::new(), ground: Vec::new(), plants: Vec::new(), paint: Vec::new(), neighborhood: false, grid: Grid::new(16, 16), player_start: CellPos::new(8, 8), lights: Vec::new() });
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
        let mut g = GymGame::new(GymLevel { props: Vec::new(), exits: Vec::new(), floors: Vec::new(), potholes: Vec::new(), windows: Vec::new(), roofs: Vec::new(), ground: Vec::new(), plants: Vec::new(), paint: Vec::new(), neighborhood: false, grid: Grid::new(16, 16), player_start: CellPos::new(4, 4), lights: Vec::new() });
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
        let mut g = GymGame::new(GymLevel { props: Vec::new(), exits: Vec::new(), floors: Vec::new(), potholes: Vec::new(), windows: Vec::new(), roofs: Vec::new(), ground: Vec::new(), plants: Vec::new(), paint: Vec::new(), neighborhood: true, grid: Grid::new(64,64), player_start: CellPos::new(20,20), lights: Vec::new() });
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
        let mut g=GymGame::new(GymLevel { props: Vec::new(), exits: Vec::new(), floors: Vec::new(), potholes: Vec::new(), windows: Vec::new(), roofs: Vec::new(), ground: Vec::new(), plants: Vec::new(), paint: Vec::new(),neighborhood:true,grid:Grid::new(64,64),player_start:CellPos::new(20,20),lights:Vec::new()});
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
        let mut g = GymGame::new(GymLevel { props: Vec::new(), exits: Vec::new(), floors: Vec::new(), potholes: Vec::new(), windows: Vec::new(), roofs: Vec::new(), ground: Vec::new(), plants: Vec::new(), paint: Vec::new(), neighborhood: false, grid, player_start: CellPos::new(1, 2), lights: Vec::new() });
        for t in 0..120u64 {
            g.tick(Tick(t), &[Command::MoveWorld { dx: WORLD_INPUT_SCALE as i16, dz: 0, mode: MoveMode::Run }]);
        }
        let s = g.snapshot();
        assert!(s.position.x <= 2.0 - PLAYER_RADIUS + 1e-4, "the player must stop before the wall: {:?}", s.position);
        assert!((s.position.y - 2.5).abs() < 1e-6, "an axis-aligned wall must not move the player along Z: {:?}", s.position);
    }

    /// An open 16×16 field with a crate beside the spawn and an exit east.
    fn yard() -> GymLevel {
        let mut lv = super::super::level_file::parse("size 16 16\nspawn 4 8\nprop crate 5.5 8.5 0 7\nprop pole 3.5 8.5 0 1\nexit 14 6 16 11 2 3 the lot\n").unwrap();
        lv.neighborhood = false;
        lv
    }

    fn crate_seed_with_loot() -> u32 {
        (0..).find(|&s| !loot::contents(PropKind::Crate, s).is_empty()).unwrap()
    }

    #[test]
    fn searching_a_crate_takes_its_time_then_fills_the_inventory_once() {
        let mut lv = yard();
        lv.props[0].seed = crate_seed_with_loot();
        let mut g = GymGame::new(lv);
        assert_eq!(g.search_target(), Some(0), "the crate is in reach; the pole is not searchable");
        g.tick(Tick(0), &[Command::Search]);
        let total = loot::search_ticks(PropKind::Crate).unwrap();
        for t in 1..total as u64 {
            assert!(g.inventory().is_empty(), "nothing is found before the search ends (tick {t})");
            g.tick(Tick(t), &[]);
        }
        let found = loot::contents(PropKind::Crate, g.spec().props[0].seed);
        assert_eq!(g.inventory(), &found[..]);
        assert!(g.searching().is_none());
        assert_eq!(g.near_prop(), Some((0, true)), "the crate reads as searched");
        assert_eq!(g.search_target(), None, "and cannot be searched twice");
        g.tick(Tick(total as u64 + 1), &[Command::Search]);
        assert!(g.searching().is_none());
        assert_eq!(g.log().len(), 1, "one line for the finds");
    }

    #[test]
    fn walking_off_breaks_a_search_off_and_finds_nothing() {
        let mut g = GymGame::new(yard());
        g.tick(Tick(0), &[Command::Search]);
        assert!(g.searching().is_some());
        let before = g.snapshot().position;
        g.tick(Tick(1), &[]);
        assert_eq!(g.snapshot().position, before, "the body stands still while it searches");
        g.tick(Tick(2), &[hold(-1.0, 0.0, MoveMode::Walk)]);
        assert!(g.searching().is_none());
        assert!(g.inventory().is_empty());
        assert!(g.log()[0].text.starts_with("stopped searching"));
        assert_eq!(g.search_target(), Some(0), "a broken-off search can be started again");
    }

    #[test]
    fn nothing_in_reach_means_a_search_does_nothing() {
        let mut lv = yard();
        lv.player_start = CellPos::new(10, 2);
        let mut g = GymGame::new(lv);
        let h = g.state_hash();
        g.tick(Tick(0), &[Command::Search]);
        assert!(g.searching().is_none() && g.log().is_empty());
        let mut idle = GymGame::new(g.spec().clone());
        idle.tick(Tick(0), &[]);
        assert_eq!(h, g.state_hash(), "a standing body's tick 0 changes nothing");
        assert_eq!(idle.state_hash(), g.state_hash(), "a search with nothing in reach is a wait");
    }

    #[test]
    fn walking_into_an_exit_takes_it_and_the_carry_crosses_over() {
        let mut lv = yard();
        lv.props[0].seed = crate_seed_with_loot();
        let mut g = GymGame::new(lv);
        g.tick(Tick(0), &[Command::Search]);
        let mut t = 1;
        while g.searching().is_some() {
            g.tick(Tick(t), &[]);
            t += 1;
        }
        // around the crate (a step north) and east into the exit
        for _ in 0..18 {
            g.tick(Tick(t), &[hold(0.0, -1.0, MoveMode::Run)]);
            t += 1;
        }
        for _ in 0..200 {
            g.tick(Tick(t), &[hold(1.0, 0.0, MoveMode::Run)]);
            t += 1;
            if g.exit_taken().is_some() {
                break;
            }
        }
        let exit = g.exit_taken().unwrap_or_else(|| panic!("the exit must be taken: at {:?}", g.snapshot().position)).clone();
        assert_eq!((exit.to.as_str(), exit.spawn), ("the lot", CellPos::new(2, 3)));
        // back to the same yard (the same crate, the same seed)
        let next = GymGame::with_carry(g.spec().clone(), g.carry().clone());
        assert_eq!(next.inventory(), g.inventory());
        assert_eq!(next.search_target(), None, "props searched before are remembered");
    }

    #[test]
    fn spawning_inside_an_exit_does_not_take_it() {
        let mut lv = yard();
        lv.player_start = CellPos::new(15, 8);
        let mut g = GymGame::new(lv);
        for t in 0..10 {
            g.tick(Tick(t), &[]);
        }
        assert!(g.exit_taken().is_none());
    }

    #[test]
    fn a_click_ray_picks_the_crate_by_its_body_and_an_approach_reaches_it() {
        let lv = yard();
        // a ray falling at the game's pitch onto the crate's top, from above
        let d = glam::Vec3::new(0.4, -0.5, 0.77).normalize();
        let top = glam::Vec3::new(5.5, 0.8, 8.5);
        assert_eq!(lv.pick_prop(top - d * 20.0, d), Some(0));
        // the same ray shifted clear of it misses; the pole is never picked
        assert_eq!(lv.pick_prop(top + glam::Vec3::new(3.0, 0.0, 0.0) - d * 20.0, d), None);
        assert_eq!(lv.pick_prop(glam::Vec3::new(3.5, 1.5, 8.5) - d * 20.0, d), None);
        let stand = lv.approach(0, Vec2::new(1.5, 8.5)).expect("the crate is reachable");
        assert!(!lv.blocked(stand.x, stand.y, PLAYER_RADIUS));
        assert!(lv.props[0].blocks(stand.x, stand.y, PLAYER_RADIUS + REACH), "the stand point is in reach");
        assert!(stand.x < 5.5, "on the side facing where the player comes from: {stand:?}");
        let mut g = GymGame::new(GymLevel { player_start: CellPos::new(stand.x as i16, stand.y as i16), ..lv.clone() });
        g.position = stand;
        assert_eq!(g.search_target(), Some(0));
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
        let mut open = GymGame::new(GymLevel { props: Vec::new(), exits: Vec::new(), floors: Vec::new(), potholes: Vec::new(), windows: Vec::new(), roofs: Vec::new(), ground: Vec::new(), plants: Vec::new(), paint: Vec::new(),
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
        let mut shut = GymGame::new(GymLevel { props: Vec::new(), exits: Vec::new(), floors: Vec::new(), potholes: Vec::new(), windows: Vec::new(), roofs: Vec::new(), ground: Vec::new(), plants: Vec::new(), paint: Vec::new(),
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
