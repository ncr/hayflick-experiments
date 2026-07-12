//! The thief world model (docs/spec/03-world-model.md, locked round 4).
//!
//! **Cells hold contents, EDGES hold barriers** — the load-bearing modelling
//! decision: movement, line-of-sight, and sound are all *edge-gated*, so one
//! model serves all three. 1 cell = 1 wu ≈ 1 m (architecture scale). The world
//! is a stack of grid z-layers (basements … ground … upper floors) connected
//! by explicit vertical links (stairs, ladders, exterior climbs).
//!
//! Determinism: everything in this module is **pure integer math** — LOS is an
//! exact rational supercover walk, sound/light propagation is integer Dijkstra
//! with a fixed pop order. No floats, no RNG, no wall-clock: results are
//! portable across machines (stronger than the machine-local f32 discipline;
//! see ARCHITECTURE.md's portability note).

/// Floor index: basements negative, ground = 0, upper floors positive.
pub type Floor = i8;

/// A cell address: (x, z) on a floor. `1 cell = 1 wu ≈ 1 m`.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct CellPos {
    pub x: i16,
    pub z: i16,
    pub floor: Floor,
}

impl CellPos {
    pub fn new(x: i16, z: i16, floor: Floor) -> CellPos {
        CellPos { x, z, floor }
    }

    /// Step one cell in `dir` on the same floor.
    pub fn step(self, dir: Dir) -> CellPos {
        let (dx, dz) = dir.delta();
        CellPos { x: self.x + dx, z: self.z + dz, floor: self.floor }
    }
}

/// Axis-aligned edge direction. `Xm` = toward −x, `Zp` = toward +z, etc.
/// (Deliberately not compass names — no camera/no north in sim space.)
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Dir {
    Xm,
    Xp,
    Zm,
    Zp,
}

pub const DIRS: [Dir; 4] = [Dir::Xm, Dir::Xp, Dir::Zm, Dir::Zp];

impl Dir {
    pub fn delta(self) -> (i16, i16) {
        match self {
            Dir::Xm => (-1, 0),
            Dir::Xp => (1, 0),
            Dir::Zm => (0, -1),
            Dir::Zp => (0, 1),
        }
    }

    pub fn opposite(self) -> Dir {
        match self {
            Dir::Xm => Dir::Xp,
            Dir::Xp => Dir::Xm,
            Dir::Zm => Dir::Zp,
            Dir::Zp => Dir::Zm,
        }
    }
}

// ---------------------------------------------------------------------------
// Edges — the barriers (module 03's controllable surface)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum DoorState {
    Open,
    Closed,
    Locked,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum WindowState {
    Shut,     // latched glass: passes sight (degraded), blocks movement until opened
    Open,     // climbable through, carries sound
    Shuttered, // barred: blocks sight AND movement
    Broken,   // smashed: as Open, and it STAYS evidence (module 05a)
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum EdgeKind {
    Open,
    Wall,
    Door(DoorState),
    Window(WindowState),
    /// Low wall / railing / counter: blocks nothing visually, vaultable.
    LowWall,
}

/// What crossing an edge takes, for movement/pathfinding. The fairness
/// validators (towngen) pick which levels count for a given question
/// ("reachable by a civilian" vs "reachable by a thief with picks").
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub enum Passage {
    /// Walk straight through (open edge, open door).
    Free,
    /// Must operate it first (closed unlocked door, shut window from inside).
    OpenFirst,
    /// Vault over (low wall) — slow, visible.
    Vault,
    /// Climb through (open/broken window) — slow, noisy-ish.
    ClimbThrough,
    /// Locked: needs a pick/key/force (a thief verb, module 07).
    NeedsPick,
    /// Impassable (wall, shuttered window).
    No,
}

impl EdgeKind {
    /// Canonical byte code for hashing (explicit — never `as u8` on a payload enum).
    pub fn code(self) -> u8 {
        match self {
            EdgeKind::Open => 0,
            EdgeKind::Wall => 1,
            EdgeKind::Door(DoorState::Open) => 2,
            EdgeKind::Door(DoorState::Closed) => 3,
            EdgeKind::Door(DoorState::Locked) => 4,
            EdgeKind::Window(WindowState::Shut) => 5,
            EdgeKind::Window(WindowState::Open) => 6,
            EdgeKind::Window(WindowState::Shuttered) => 7,
            EdgeKind::Window(WindowState::Broken) => 8,
            EdgeKind::LowWall => 9,
        }
    }

    pub fn passage(self) -> Passage {
        match self {
            EdgeKind::Open => Passage::Free,
            EdgeKind::Wall => Passage::No,
            EdgeKind::Door(DoorState::Open) => Passage::Free,
            EdgeKind::Door(DoorState::Closed) => Passage::OpenFirst,
            EdgeKind::Door(DoorState::Locked) => Passage::NeedsPick,
            EdgeKind::Window(WindowState::Shut) => Passage::OpenFirst,
            EdgeKind::Window(WindowState::Open) => Passage::ClimbThrough,
            EdgeKind::Window(WindowState::Shuttered) => Passage::No,
            EdgeKind::Window(WindowState::Broken) => Passage::ClimbThrough,
            EdgeKind::LowWall => Passage::Vault,
        }
    }

    /// Does this edge block line-of-sight? (05a: walls / closed doors /
    /// shutters block; open doors, windows, low-walls pass.)
    pub fn blocks_sight(self) -> bool {
        matches!(
            self,
            EdgeKind::Wall
                | EdgeKind::Door(DoorState::Closed)
                | EdgeKind::Door(DoorState::Locked)
                | EdgeKind::Window(WindowState::Shuttered)
        )
    }

    /// Sight passes but degraded (05a "possibly at reduced confidence"):
    /// glass, a vaulting-height obstruction, a door frame.
    pub fn degrades_sight(self) -> bool {
        match self {
            EdgeKind::Window(WindowState::Shut) => true, // through glass
            EdgeKind::LowWall => true,                   // partial cover line
            _ => false,
        }
    }

    /// Loudness lost crossing this edge (on top of [`STEP_ATTEN`] per cell).
    /// Tunables — chosen so 05a's calibration sentence holds: "through a shut
    /// door two rooms away a footstep is inaudible; a smashed window carries
    /// far" (pinned by test).
    pub fn sound_atten(self) -> i32 {
        match self {
            EdgeKind::Open | EdgeKind::LowWall => 0,
            EdgeKind::Door(DoorState::Open) => 1,
            EdgeKind::Window(WindowState::Open) | EdgeKind::Window(WindowState::Broken) => 1,
            EdgeKind::Window(WindowState::Shut) => 4,
            EdgeKind::Door(DoorState::Closed) | EdgeKind::Door(DoorState::Locked) => 5,
            EdgeKind::Window(WindowState::Shuttered) => 6,
            EdgeKind::Wall => WALL_SOUND_ATTEN,
        }
    }

    /// Light lost crossing this edge, or `None` if the edge blocks light.
    /// Glass passes light; closed doors and walls do not. (This is the v1
    /// CPU light-field model of 05a — a flood fill, not physical transport;
    /// the GI *visualizes* it and perceptual match is an M2 tuning duty.)
    pub fn light_atten(self) -> Option<i32> {
        match self {
            EdgeKind::Open | EdgeKind::LowWall => Some(0),
            EdgeKind::Door(DoorState::Open) => Some(0),
            EdgeKind::Window(WindowState::Open) | EdgeKind::Window(WindowState::Broken) => Some(0),
            EdgeKind::Window(WindowState::Shut) => Some(1), // glass, slight loss
            EdgeKind::Door(DoorState::Closed) | EdgeKind::Door(DoorState::Locked) => None,
            EdgeKind::Window(WindowState::Shuttered) => None,
            EdgeKind::Wall => None,
        }
    }
}

/// Per-cell-step distance attenuation for sound and light propagation.
pub const STEP_ATTEN: i32 = 1;
/// Sound through a bare wall: effectively two rooms of loss.
pub const WALL_SOUND_ATTEN: i32 = 10;
/// Crossing a vertical link (stairs/ladder) costs this much extra loudness.
pub const LINK_SOUND_ATTEN: i32 = 2;

/// Player-action loudness tiers (05a): sneak ≈ silent → walk → run →
/// force/break → combat; a dropped body is between run and force.
pub const LOUD_SNEAK: i32 = 0;
pub const LOUD_WALK: i32 = 8;
pub const LOUD_RUN: i32 = 12;
pub const LOUD_BODY: i32 = 14;
pub const LOUD_FORCE: i32 = 16;
pub const LOUD_COMBAT: i32 = 18;

// ---------------------------------------------------------------------------
// Cells — the contents
// ---------------------------------------------------------------------------

/// Unique room id within a town (assigned by the generator, ordered).
pub type RoomId = u16;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum CellKind {
    /// No floor here (open air above a street, outside the district, …).
    Void,
    /// Outdoor ground: street, alley, yard.
    Outdoor,
    /// Interior floor of a room.
    Room(RoomId),
}

/// Ground material → noise-on-step + look (module 03 "floor/ground material").
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Material {
    Dirt,
    Stone,
    Wood,
    Rug,
}

impl Material {
    pub fn code(self) -> u8 {
        match self {
            Material::Dirt => 0,
            Material::Stone => 1,
            Material::Wood => 2,
            Material::Rug => 3,
        }
    }

    /// Extra loudness a footstep gains/loses on this material
    /// (wood creaks, rugs muffle).
    pub fn step_loudness_mod(self) -> i32 {
        match self {
            Material::Dirt => -1,
            Material::Stone => 0,
            Material::Wood => 2,
            Material::Rug => -3,
        }
    }
}

/// At most one static prop per cell (module 03). Occupancy by actors is sim
/// state, not grid state.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Prop {
    None,
    /// Blocks movement, grants adjacent cover (table, dresser, crate stack).
    Furniture,
    /// Enterable concealment (closet, barrel, hay): walkable + hides.
    HidingSpot,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct Cell {
    pub kind: CellKind,
    pub material: Material,
    pub prop: Prop,
}

impl Cell {
    pub const VOID: Cell = Cell { kind: CellKind::Void, material: Material::Dirt, prop: Prop::None };

    /// Can an actor stand here? (Void and furniture-filled cells: no.)
    pub fn walkable(self) -> bool {
        self.kind != CellKind::Void && self.prop != Prop::Furniture
    }
}

// ---------------------------------------------------------------------------
// Vertical links — stairs, ladders, exterior climbs (module 03 verticality)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum LinkKind {
    Stairs,
    Ladder,
    /// Climbable exterior feature (drainpipe/trellis/crates): street cell →
    /// upper-floor cell, gated by the window edge you enter through.
    Climb,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct VerticalLink {
    pub kind: LinkKind,
    pub a: CellPos,
    pub b: CellPos,
    /// If set, traversing the link additionally requires passing this edge
    /// (the second-floor window an exterior climb enters through).
    pub gate: Option<(CellPos, Dir)>,
}

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct Layer {
    cells: Vec<Cell>,       // w*h, z-major then x
    edges_x: Vec<EdgeKind>, // (w+1)*h — edge_x(x,z) separates (x-1,z) | (x,z)
    edges_z: Vec<EdgeKind>, // w*(h+1) — edge_z(x,z) separates (x,z-1) | (x,z)
}

/// The town's static world grid: stacked floors of cells + edges, plus the
/// ordered vertical-link list. Dynamic edge state (a door opening) mutates
/// this in place through [`TownGrid::set_edge`]; the sim owns when.
#[derive(Clone)]
pub struct TownGrid {
    pub w: i16,
    pub h: i16,
    pub f_lo: Floor,
    pub f_hi: Floor,
    layers: Vec<Layer>,
    pub links: Vec<VerticalLink>,
}

impl TownGrid {
    /// All-void grid with open edges; generators paint into it.
    pub fn new(w: i16, h: i16, f_lo: Floor, f_hi: Floor) -> TownGrid {
        assert!(w > 0 && h > 0 && f_lo <= 0 && f_hi >= 0, "degenerate grid");
        let n_layers = (f_hi as i32 - f_lo as i32 + 1) as usize;
        let layer = Layer {
            cells: vec![Cell::VOID; w as usize * h as usize],
            edges_x: vec![EdgeKind::Open; (w as usize + 1) * h as usize],
            edges_z: vec![EdgeKind::Open; w as usize * (h as usize + 1)],
        };
        TownGrid { w, h, f_lo, f_hi, layers: vec![layer; n_layers], links: Vec::new() }
    }

    pub fn in_bounds(&self, p: CellPos) -> bool {
        p.x >= 0 && p.x < self.w && p.z >= 0 && p.z < self.h && p.floor >= self.f_lo && p.floor <= self.f_hi
    }

    fn layer(&self, floor: Floor) -> &Layer {
        &self.layers[(floor as i32 - self.f_lo as i32) as usize]
    }

    fn layer_mut(&mut self, floor: Floor) -> &mut Layer {
        &mut self.layers[(floor as i32 - self.f_lo as i32) as usize]
    }

    /// Canonical dense index of a cell within its layer (z-major, then x).
    pub fn cell_index(&self, p: CellPos) -> usize {
        p.z as usize * self.w as usize + p.x as usize
    }

    /// Canonical dense index across ALL layers (layer-major) — the sort key
    /// for every ordered per-cell output.
    pub fn flat_index(&self, p: CellPos) -> usize {
        let li = (p.floor as i32 - self.f_lo as i32) as usize;
        li * (self.w as usize * self.h as usize) + self.cell_index(p)
    }

    pub fn n_cells(&self) -> usize {
        self.layers.len() * self.w as usize * self.h as usize
    }

    pub fn cell(&self, p: CellPos) -> Cell {
        debug_assert!(self.in_bounds(p));
        self.layer(p.floor).cells[p.z as usize * self.w as usize + p.x as usize]
    }

    pub fn set_cell(&mut self, p: CellPos, c: Cell) {
        assert!(self.in_bounds(p), "set_cell out of bounds: {p:?}");
        let w = self.w as usize;
        self.layer_mut(p.floor).cells[p.z as usize * w + p.x as usize] = c;
    }

    /// The edge on side `dir` of cell `p`. Cells on the grid boundary have
    /// real edges to the outside (x = 0/w, z = 0/h).
    pub fn edge(&self, p: CellPos, dir: Dir) -> EdgeKind {
        debug_assert!(self.in_bounds(p));
        let (w, layer) = (self.w as usize, self.layer(p.floor));
        let (x, z) = (p.x as usize, p.z as usize);
        match dir {
            Dir::Xm => layer.edges_x[z * (w + 1) + x],
            Dir::Xp => layer.edges_x[z * (w + 1) + x + 1],
            Dir::Zm => layer.edges_z[z * w + x],
            Dir::Zp => layer.edges_z[(z + 1) * w + x],
        }
    }

    /// Set the edge on side `dir` of cell `p` (shared storage: the same edge
    /// seen from the adjacent cell changes too).
    pub fn set_edge(&mut self, p: CellPos, dir: Dir, e: EdgeKind) {
        assert!(self.in_bounds(p), "set_edge out of bounds: {p:?}");
        let w = self.w as usize;
        let layer = self.layer_mut(p.floor);
        let (x, z) = (p.x as usize, p.z as usize);
        match dir {
            Dir::Xm => layer.edges_x[z * (w + 1) + x] = e,
            Dir::Xp => layer.edges_x[z * (w + 1) + x + 1] = e,
            Dir::Zm => layer.edges_z[z * w + x] = e,
            Dir::Zp => layer.edges_z[(z + 1) * w + x] = e,
        }
    }

    /// Movement query: what does stepping from `p` in `dir` take? `No` when
    /// the destination is off-grid, void, or furniture-blocked.
    pub fn passage(&self, p: CellPos, dir: Dir) -> Passage {
        let q = p.step(dir);
        if !self.in_bounds(q) || !self.cell(q).walkable() {
            return Passage::No;
        }
        self.edge(p, dir).passage()
    }

    /// FNV-1a over the full canonical grid state — the bit-identity oracle
    /// for "same seed → same town". Pure integers: portable across machines.
    pub fn grid_hash(&self) -> u64 {
        let mut h: u64 = 0xcbf29ce484222325;
        let mut eat = |b: u8| {
            h = (h ^ b as u64).wrapping_mul(0x100000001b3);
        };
        for v in [self.w as u16, self.h as u16] {
            eat(v as u8);
            eat((v >> 8) as u8);
        }
        eat(self.f_lo as u8);
        eat(self.f_hi as u8);
        for layer in &self.layers {
            for c in &layer.cells {
                let kind = match c.kind {
                    CellKind::Void => 0u16,
                    CellKind::Outdoor => 1,
                    CellKind::Room(r) => 2 + r,
                };
                eat(kind as u8);
                eat((kind >> 8) as u8);
                eat(c.material.code());
                eat(match c.prop {
                    Prop::None => 0,
                    Prop::Furniture => 1,
                    Prop::HidingSpot => 2,
                });
            }
            for e in layer.edges_x.iter().chain(layer.edges_z.iter()) {
                eat(e.code());
            }
        }
        for l in &self.links {
            eat(match l.kind {
                LinkKind::Stairs => 0,
                LinkKind::Ladder => 1,
                LinkKind::Climb => 2,
            });
            for p in [l.a, l.b] {
                for v in [p.x as u16, p.z as u16] {
                    eat(v as u8);
                    eat((v >> 8) as u8);
                }
                eat(p.floor as u8);
            }
            match l.gate {
                None => eat(0xff),
                Some((p, d)) => {
                    eat(match d {
                        Dir::Xm => 0,
                        Dir::Xp => 1,
                        Dir::Zm => 2,
                        Dir::Zp => 3,
                    });
                    for v in [p.x as u16, p.z as u16] {
                        eat(v as u8);
                        eat((v >> 8) as u8);
                    }
                    eat(p.floor as u8);
                }
            }
        }
        h
    }
}

// ---------------------------------------------------------------------------
// Line of sight — exact integer supercover (05a edge-gated LOS)
// ---------------------------------------------------------------------------

/// LOS result: whether the sightline is clear, and how many sight-degrading
/// edges (glass, low walls) it crossed — 05a's "reduced confidence" input.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Sight {
    pub clear: bool,
    pub degradations: u32,
}

impl Sight {
    pub const BLOCKED: Sight = Sight { clear: false, degradations: 0 };
}

impl TownGrid {
    /// Edge-gated line of sight between two same-floor cell centres.
    /// Exact integer walk (doubled coordinates: centres odd, grid lines even);
    /// no epsilons, no floats. Cross-floor LOS is out of scope for v1
    /// (module 03: roofs are occluding caps).
    ///
    /// Corner rule: a ray exactly through a grid corner passes iff at least
    /// one of the two around-the-corner edge pairs is sight-clear (taking the
    /// worse pair's degradations when both pass).
    pub fn los(&self, a: CellPos, b: CellPos) -> Sight {
        if a.floor != b.floor || !self.in_bounds(a) || !self.in_bounds(b) {
            return Sight::BLOCKED;
        }
        if a == b {
            return Sight { clear: true, degradations: 0 };
        }
        // Doubled coords: centres at odd integers, grid lines at even.
        let (x0, z0) = (a.x as i64 * 2 + 1, a.z as i64 * 2 + 1);
        let (x1, z1) = (b.x as i64 * 2 + 1, b.z as i64 * 2 + 1);
        let (dx, dz) = (x1 - x0, z1 - z0);
        let (sx, sz) = (dx.signum() as i16, dz.signum() as i16);
        let mut cur = a;
        let mut deg = 0u32;
        while cur != b {
            // Next vertical / horizontal grid line ahead of the walk, in
            // doubled coords. t = dist/|d| along the ray; compare by
            // cross-multiplication (exact).
            let nvx = if sx > 0 { 2 * (cur.x as i64 + 1) } else { 2 * cur.x as i64 };
            let nhz = if sz > 0 { 2 * (cur.z as i64 + 1) } else { 2 * cur.z as i64 };
            let tv = if dx != 0 { Some((nvx - x0).abs() * dz.abs()) } else { None };
            let th = if dz != 0 { Some((nhz - z0).abs() * dx.abs()) } else { None };
            let (cross_x, cross_z) = match (tv, th) {
                (Some(v), Some(h)) if v == h => (true, true),
                (Some(v), Some(h)) => (v < h, h < v),
                (Some(_), None) => (true, false),
                (None, Some(_)) => (false, true),
                (None, None) => unreachable!("a == b handled above"),
            };
            if cross_x && cross_z {
                // Exact corner. Two routes around it:
                //   route 1: x-edge from cur, then z-edge from the x-neighbour
                //   route 2: z-edge from cur, then x-edge from the z-neighbour
                let xd = if sx > 0 { Dir::Xp } else { Dir::Xm };
                let zd = if sz > 0 { Dir::Zp } else { Dir::Zm };
                let e1a = self.edge(cur, xd);
                let e1b = self.edge(cur.step(xd), zd);
                let e2a = self.edge(cur, zd);
                let e2b = self.edge(cur.step(zd), xd);
                let r1 = !e1a.blocks_sight() && !e1b.blocks_sight();
                let r2 = !e2a.blocks_sight() && !e2b.blocks_sight();
                let route_deg = |ea: EdgeKind, eb: EdgeKind| {
                    ea.degrades_sight() as u32 + eb.degrades_sight() as u32
                };
                match (r1, r2) {
                    (false, false) => return Sight::BLOCKED,
                    (true, false) => deg += route_deg(e1a, e1b),
                    (false, true) => deg += route_deg(e2a, e2b),
                    (true, true) => deg += route_deg(e1a, e1b).max(route_deg(e2a, e2b)),
                }
                cur = CellPos { x: cur.x + sx, z: cur.z + sz, floor: cur.floor };
            } else if cross_x {
                let d = if sx > 0 { Dir::Xp } else { Dir::Xm };
                let e = self.edge(cur, d);
                if e.blocks_sight() {
                    return Sight::BLOCKED;
                }
                deg += e.degrades_sight() as u32;
                cur = cur.step(d);
            } else {
                let d = if sz > 0 { Dir::Zp } else { Dir::Zm };
                let e = self.edge(cur, d);
                if e.blocks_sight() {
                    return Sight::BLOCKED;
                }
                deg += e.degrades_sight() as u32;
                cur = cur.step(d);
            }
        }
        Sight { clear: true, degradations: deg }
    }
}

// ---------------------------------------------------------------------------
// Sound & light propagation — integer Dijkstra over the edge graph
// ---------------------------------------------------------------------------

/// A propagated scalar field over all cells (sound loudness or light level).
/// Dense per-cell storage in [`TownGrid::flat_index`] order; cells the field
/// never reached hold 0.
pub struct CellField {
    pub levels: Vec<i32>,
}

impl CellField {
    pub fn level(&self, grid: &TownGrid, p: CellPos) -> i32 {
        self.levels[grid.flat_index(p)]
    }
}

impl TownGrid {
    /// Propagate a noise of `loudness` emitted at `src` over the edge graph
    /// (05a hearing): each cell step costs [`STEP_ATTEN`], each edge its
    /// [`EdgeKind::sound_atten`], vertical links [`LINK_SOUND_ATTEN`] plus
    /// their gate edge's attenuation. A cell "hears" the noise if its level
    /// is ≥ 1. Integer Dijkstra, pop order fixed by (level desc, flat index
    /// asc) — deterministic and portable.
    pub fn propagate_sound(&self, src: CellPos, loudness: i32) -> CellField {
        self.propagate(src, loudness, PropKind::Sound)
    }

    /// The sim-side light field (05a): flood light from sources over the edge
    /// graph. Levels are "light units"; 0 = full dark. The renderer's GI
    /// *visualizes* this; it never feeds back in.
    pub fn light_field(&self, sources: &[(CellPos, i32)]) -> CellField {
        let mut field = CellField { levels: vec![0; self.n_cells()] };
        // Sources merge by max: propagate each and fold. Source order cannot
        // matter (max is commutative), but iterate in given (spec) order.
        for &(p, intensity) in sources {
            let one = self.propagate(p, intensity, PropKind::Light);
            for (dst, s) in field.levels.iter_mut().zip(one.levels.iter()) {
                *dst = (*dst).max(*s);
            }
        }
        field
    }

    fn propagate(&self, src: CellPos, start_level: i32, kind: PropKind) -> CellField {
        use std::cmp::Reverse;
        use std::collections::BinaryHeap;
        let mut levels = vec![0i32; self.n_cells()];
        if !self.in_bounds(src) || start_level <= 0 {
            return CellField { levels };
        }
        // Pre-index links by endpoint for the floor hops.
        let mut heap: BinaryHeap<(i32, Reverse<usize>)> = BinaryHeap::new();
        levels[self.flat_index(src)] = start_level;
        heap.push((start_level, Reverse(self.flat_index(src))));
        while let Some((lvl, Reverse(idx))) = heap.pop() {
            if levels[idx] != lvl {
                continue; // stale entry
            }
            let p = self.pos_of_flat(idx);
            let relax = |q: CellPos, cost: i32, levels: &mut Vec<i32>, heap: &mut BinaryHeap<(i32, Reverse<usize>)>| {
                let nl = lvl - cost;
                if nl <= 0 {
                    return;
                }
                let qi = self.flat_index(q);
                if nl > levels[qi] {
                    levels[qi] = nl;
                    heap.push((nl, Reverse(qi)));
                }
            };
            for d in DIRS {
                let q = p.step(d);
                if !self.in_bounds(q) {
                    continue;
                }
                let e = self.edge(p, d);
                let ecost = match kind {
                    PropKind::Sound => e.sound_atten(),
                    PropKind::Light => match e.light_atten() {
                        Some(c) => c,
                        None => continue,
                    },
                };
                relax(q, STEP_ATTEN + ecost, &mut levels, &mut heap);
            }
            for l in &self.links {
                let other = if l.a == p {
                    l.b
                } else if l.b == p {
                    l.a
                } else {
                    continue;
                };
                let gate_cost = match l.gate {
                    None => 0,
                    Some((gp, gd)) => {
                        let e = self.edge(gp, gd);
                        match kind {
                            PropKind::Sound => e.sound_atten(),
                            PropKind::Light => match e.light_atten() {
                                Some(c) => c,
                                None => continue,
                            },
                        }
                    }
                };
                relax(other, STEP_ATTEN + LINK_SOUND_ATTEN + gate_cost, &mut levels, &mut heap);
            }
        }
        CellField { levels }
    }

    fn pos_of_flat(&self, idx: usize) -> CellPos {
        let per_layer = self.w as usize * self.h as usize;
        let li = idx / per_layer;
        let rem = idx % per_layer;
        CellPos {
            x: (rem % self.w as usize) as i16,
            z: (rem / self.w as usize) as i16,
            floor: (li as i32 + self.f_lo as i32) as Floor,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PropKind {
    Sound,
    Light,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn p(x: i16, z: i16) -> CellPos {
        CellPos::new(x, z, 0)
    }

    /// 10×6 single-floor test box: outdoor ground everywhere, then a 4×4-cell
    /// room [1..5)×[1..5) walled off with a door on its +x side at z=2 and a
    /// window on its −x side at z=3.
    fn room_grid() -> TownGrid {
        let mut g = TownGrid::new(10, 6, 0, 0);
        for z in 0..6 {
            for x in 0..10 {
                g.set_cell(p(x, z), Cell { kind: CellKind::Outdoor, material: Material::Stone, prop: Prop::None });
            }
        }
        for z in 1..5 {
            for x in 1..5 {
                g.set_cell(p(x, z), Cell { kind: CellKind::Room(0), material: Material::Wood, prop: Prop::None });
            }
        }
        // Perimeter walls of the room.
        for z in 1..5 {
            g.set_edge(p(1, z), Dir::Xm, EdgeKind::Wall);
            g.set_edge(p(4, z), Dir::Xp, EdgeKind::Wall);
        }
        for x in 1..5 {
            g.set_edge(p(x, 1), Dir::Zm, EdgeKind::Wall);
            g.set_edge(p(x, 4), Dir::Zp, EdgeKind::Wall);
        }
        g.set_edge(p(4, 2), Dir::Xp, EdgeKind::Door(DoorState::Closed));
        g.set_edge(p(1, 3), Dir::Xm, EdgeKind::Window(WindowState::Shut));
        g
    }

    #[test]
    fn edge_storage_is_shared_between_neighbours() {
        let mut g = TownGrid::new(4, 4, 0, 0);
        g.set_edge(p(1, 1), Dir::Xp, EdgeKind::Wall);
        assert_eq!(g.edge(p(2, 1), Dir::Xm), EdgeKind::Wall);
        g.set_edge(p(2, 2), Dir::Zm, EdgeKind::Door(DoorState::Locked));
        assert_eq!(g.edge(p(2, 1), Dir::Zp), EdgeKind::Door(DoorState::Locked));
        // Boundary edges exist and are settable.
        g.set_edge(p(0, 0), Dir::Xm, EdgeKind::Wall);
        assert_eq!(g.edge(p(0, 0), Dir::Xm), EdgeKind::Wall);
    }

    #[test]
    fn passage_levels_match_the_locked_edge_semantics() {
        let mut g = room_grid();
        // Into the room through the closed door: OpenFirst.
        assert_eq!(g.passage(p(5, 2), Dir::Xm), Passage::OpenFirst);
        // Through the room wall: No.
        assert_eq!(g.passage(p(5, 3), Dir::Xm), Passage::No);
        // Through the shut window: OpenFirst; shuttered: No; broken: climb.
        assert_eq!(g.passage(p(0, 3), Dir::Xp), Passage::OpenFirst);
        g.set_edge(p(1, 3), Dir::Xm, EdgeKind::Window(WindowState::Shuttered));
        assert_eq!(g.passage(p(0, 3), Dir::Xp), Passage::No);
        g.set_edge(p(1, 3), Dir::Xm, EdgeKind::Window(WindowState::Broken));
        assert_eq!(g.passage(p(0, 3), Dir::Xp), Passage::ClimbThrough);
        // A locked door needs a pick.
        g.set_edge(p(4, 2), Dir::Xp, EdgeKind::Door(DoorState::Locked));
        assert_eq!(g.passage(p(5, 2), Dir::Xm), Passage::NeedsPick);
        // Stepping into furniture or void: No.
        g.set_cell(p(3, 3), Cell { kind: CellKind::Room(0), material: Material::Wood, prop: Prop::Furniture });
        assert_eq!(g.passage(p(2, 3), Dir::Xp), Passage::No);
        assert_eq!(g.passage(p(9, 5), Dir::Xp), Passage::No); // off-grid
    }

    #[test]
    fn los_straight_lines_respect_edge_gating() {
        let mut g = room_grid();
        // Open street: clear.
        assert!(g.los(p(5, 5), p(9, 5)).clear);
        // Through the room's wall: blocked.
        assert!(!g.los(p(0, 2), p(3, 2)).clear);
        // Through the closed door: blocked; open door: clear.
        assert!(!g.los(p(6, 2), p(3, 2)).clear);
        g.set_edge(p(4, 2), Dir::Xp, EdgeKind::Door(DoorState::Open));
        assert!(g.los(p(6, 2), p(3, 2)).clear);
        // Through the shut window: clear but degraded (glass).
        let s = g.los(p(0, 3), p(3, 3));
        assert!(s.clear);
        assert_eq!(s.degradations, 1);
        // Shutter the window: blocked.
        g.set_edge(p(1, 3), Dir::Xm, EdgeKind::Window(WindowState::Shuttered));
        assert!(!g.los(p(0, 3), p(3, 3)).clear);
        // Same cell and cross-floor.
        assert!(g.los(p(2, 2), p(2, 2)).clear);
        assert!(!g.los(p(2, 2), CellPos::new(2, 2, 1)).clear); // out of z-range here
    }

    #[test]
    fn los_diagonals_and_the_corner_rule() {
        // Empty 6x6, then a solid corner at cell (2,2)'s +x/+z edges meeting
        // (3,3)'s -x/-z edges: the exact-diagonal ray must respect the rule.
        let mut g = TownGrid::new(6, 6, 0, 0);
        for z in 0..6 {
            for x in 0..6 {
                g.set_cell(p(x, z), Cell { kind: CellKind::Outdoor, material: Material::Stone, prop: Prop::None });
            }
        }
        // Unobstructed exact diagonal: clear.
        assert!(g.los(p(0, 0), p(5, 5)).clear);
        assert!(g.los(p(5, 0), p(0, 5)).clear);
        // Wall both around-the-corner routes at the (2,2)→(3,3) corner:
        //   route 1 = (2,2)+x edge then (3,2)+z edge
        //   route 2 = (2,2)+z edge then (2,3)+x edge
        g.set_edge(p(2, 2), Dir::Xp, EdgeKind::Wall);
        g.set_edge(p(2, 2), Dir::Zp, EdgeKind::Wall);
        // Both first-hops walled: diagonal blocked.
        assert!(!g.los(p(0, 0), p(5, 5)).clear);
        // Re-open one route's first hop: passes again.
        g.set_edge(p(2, 2), Dir::Xp, EdgeKind::Open);
        assert!(g.los(p(0, 0), p(5, 5)).clear);
        // Off-diagonal lines cross single edges normally.
        g.set_edge(p(2, 2), Dir::Zp, EdgeKind::Wall);
        assert!(!g.los(p(2, 0), p(2, 5)).clear);
        assert!(g.los(p(1, 0), p(1, 5)).clear);
    }

    #[test]
    fn sound_calibration_sentence_from_05a_holds() {
        // "Through a shut door two rooms away a footstep is inaudible; a
        // smashed window carries far."
        let g = room_grid();
        // A walking footstep INSIDE the room (at (3,2), by the door).
        let f = g.propagate_sound(p(3, 2), LOUD_WALK);
        // Just outside the closed door (5,2): one open step to (4,2) then the
        // door crossing: 8 - 1 - (1+5) = 1 → faintly audible right at the door.
        assert_eq!(f.level(&g, p(5, 2)), 1);
        // Two rooms/streets away (9,2): inaudible (0).
        assert_eq!(f.level(&g, p(9, 2)), 0);
        // Sneaking is silent everywhere but the emitter cell.
        let s = g.propagate_sound(p(3, 2), LOUD_SNEAK);
        assert_eq!(s.level(&g, p(4, 2)), 0);
        // Forcing/smashing carries far down the open street.
        let loudest = g.propagate_sound(p(5, 2), LOUD_FORCE);
        assert!(loudest.level(&g, p(9, 5)) >= 1, "a smash should carry across the district");
        // And through the wall it's heavily muffled but nonzero nearby.
        assert_eq!(loudest.level(&g, p(4, 2)), LOUD_FORCE - (STEP_ATTEN + EdgeKind::Door(DoorState::Closed).sound_atten()));
    }

    #[test]
    fn sound_crosses_floors_via_links_only() {
        let mut g = TownGrid::new(4, 4, 0, 1);
        for f in 0..=1 {
            for z in 0..4 {
                for x in 0..4 {
                    g.set_cell(CellPos::new(x, z, f), Cell { kind: CellKind::Room(f as u16), material: Material::Wood, prop: Prop::None });
                }
            }
        }
        // No link: nothing crosses.
        let f0 = g.propagate_sound(p(1, 1), LOUD_RUN);
        assert_eq!(f0.level(&g, CellPos::new(1, 1, 1)), 0);
        // Stairs at (3,3): sound hops the link, attenuated.
        g.links.push(VerticalLink { kind: LinkKind::Stairs, a: p(3, 3), b: CellPos::new(3, 3, 1), gate: None });
        let f1 = g.propagate_sound(p(3, 3), LOUD_RUN);
        assert_eq!(f1.level(&g, CellPos::new(3, 3, 1)), LOUD_RUN - (STEP_ATTEN + LINK_SOUND_ATTEN));
        // A gated climb (through a shut window) attenuates by the gate too.
        g.links.push(VerticalLink {
            kind: LinkKind::Climb,
            a: p(0, 0),
            b: CellPos::new(0, 0, 1),
            gate: Some((CellPos::new(0, 0, 1), Dir::Xm)),
        });
        g.set_edge(CellPos::new(0, 0, 1), Dir::Xm, EdgeKind::Window(WindowState::Shut));
        let f2 = g.propagate_sound(p(0, 0), LOUD_RUN);
        assert_eq!(
            f2.level(&g, CellPos::new(0, 0, 1)),
            LOUD_RUN - (STEP_ATTEN + LINK_SOUND_ATTEN + EdgeKind::Window(WindowState::Shut).sound_atten())
        );
    }

    #[test]
    fn light_field_floods_rooms_and_stops_at_walls() {
        let mut g = room_grid();
        // A lamp in the room centre.
        let lamp = (p(2, 2), 6);
        let lf = g.light_field(&[lamp]);
        assert_eq!(lf.level(&g, p(2, 2)), 6);
        assert_eq!(lf.level(&g, p(4, 2)), 4); // two steps
        // Behind the wall: dark (closed door + walls block light).
        assert_eq!(lf.level(&g, p(6, 2)), 0);
        // Through the shut window (glass) light leaks out, attenuated:
        // (2,2)→(1,3) is 2 steps = 6-2 = 4 at (1,3); window edge (1 step +
        // glass 1) → 4 - 2 = 2 at (0,3).
        assert_eq!(lf.level(&g, p(0, 3)), 2);
        // Open the door: the doorway spills light into the street.
        g.set_edge(p(4, 2), Dir::Xp, EdgeKind::Door(DoorState::Open));
        let lf2 = g.light_field(&[lamp]);
        assert_eq!(lf2.level(&g, p(5, 2)), 3); // 6 - 3 steps
        // Two lamps merge by max, not sum.
        let lf3 = g.light_field(&[lamp, (p(2, 2), 4)]);
        assert_eq!(lf3.level(&g, p(2, 2)), 6);
    }

    #[test]
    fn grid_hash_is_stable_and_sensitive() {
        let g1 = room_grid();
        let g2 = room_grid();
        assert_eq!(g1.grid_hash(), g2.grid_hash(), "same construction → same hash");
        let mut g3 = room_grid();
        g3.set_edge(p(4, 2), Dir::Xp, EdgeKind::Door(DoorState::Open));
        assert_ne!(g1.grid_hash(), g3.grid_hash(), "a door state flip must change the hash");
        let mut g4 = room_grid();
        g4.links.push(VerticalLink { kind: LinkKind::Stairs, a: p(0, 0), b: p(0, 0), gate: None });
        assert_ne!(g1.grid_hash(), g4.grid_hash());
    }

    #[test]
    fn propagation_is_deterministic_across_runs() {
        let g = room_grid();
        let a = g.propagate_sound(p(3, 2), LOUD_COMBAT);
        let b = g.propagate_sound(p(3, 2), LOUD_COMBAT);
        assert_eq!(a.levels, b.levels);
        let la = g.light_field(&[(p(2, 2), 8), (p(7, 4), 5)]);
        let lb = g.light_field(&[(p(2, 2), 8), (p(7, 4), 5)]);
        assert_eq!(la.levels, lb.levels);
    }
}
