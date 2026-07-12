//! The gym's world model, cut to the bone: a single-floor grid where cells
//! hold ground kind and EDGES hold walls (the load-bearing modelling decision
//! kept from the old town model — movement and visuals share one source of
//! truth). 1 cell = 1 wu ≈ 1 m.
//!
//! Determinism: pure integer state, no floats, no RNG — `grid_hash` is
//! portable across machines.

/// A cell address. `1 cell = 1 wu ≈ 1 m`.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct CellPos {
    pub x: i16,
    pub z: i16,
}

impl CellPos {
    pub fn new(x: i16, z: i16) -> CellPos {
        CellPos { x, z }
    }

    /// Step one cell in `dir`.
    pub fn step(self, dir: Dir) -> CellPos {
        let (dx, dz) = dir.delta();
        CellPos { x: self.x + dx, z: self.z + dz }
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
}

/// What ground a cell is: open field or a building interior. Every cell is
/// walkable — blocking is the edges' job (and the grid boundary's).
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum CellKind {
    Outdoor,
    Room,
}

/// An edge either passes or is a wall. Doors, windows and the rest of the
/// thief-era barrier zoo are archived (tag `archive/pre-joyful-reset`).
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum EdgeKind {
    Open,
    Wall,
}

/// The gym's static single-floor grid: cells + shared edges.
#[derive(Clone)]
pub struct Grid {
    pub w: i16,
    pub h: i16,
    cells: Vec<CellKind>,   // w*h, z-major then x
    edges_x: Vec<EdgeKind>, // (w+1)*h — edge_x(x,z) separates (x-1,z) | (x,z)
    edges_z: Vec<EdgeKind>, // w*(h+1) — edge_z(x,z) separates (x,z-1) | (x,z)
}

impl Grid {
    /// All-outdoor grid with open edges; the level builder paints into it.
    pub fn new(w: i16, h: i16) -> Grid {
        assert!(w > 0 && h > 0, "degenerate grid");
        Grid {
            w,
            h,
            cells: vec![CellKind::Outdoor; w as usize * h as usize],
            edges_x: vec![EdgeKind::Open; (w as usize + 1) * h as usize],
            edges_z: vec![EdgeKind::Open; w as usize * (h as usize + 1)],
        }
    }

    pub fn in_bounds(&self, p: CellPos) -> bool {
        p.x >= 0 && p.x < self.w && p.z >= 0 && p.z < self.h
    }

    pub fn cell(&self, p: CellPos) -> CellKind {
        debug_assert!(self.in_bounds(p));
        self.cells[p.z as usize * self.w as usize + p.x as usize]
    }

    pub fn set_cell(&mut self, p: CellPos, c: CellKind) {
        assert!(self.in_bounds(p), "set_cell out of bounds: {p:?}");
        self.cells[p.z as usize * self.w as usize + p.x as usize] = c;
    }

    /// The edge on side `dir` of cell `p`. Cells on the grid boundary have
    /// real edges to the outside (x = 0/w, z = 0/h).
    pub fn edge(&self, p: CellPos, dir: Dir) -> EdgeKind {
        debug_assert!(self.in_bounds(p));
        let w = self.w as usize;
        let (x, z) = (p.x as usize, p.z as usize);
        match dir {
            Dir::Xm => self.edges_x[z * (w + 1) + x],
            Dir::Xp => self.edges_x[z * (w + 1) + x + 1],
            Dir::Zm => self.edges_z[z * w + x],
            Dir::Zp => self.edges_z[(z + 1) * w + x],
        }
    }

    /// Set the edge on side `dir` of cell `p` (shared storage: the same edge
    /// seen from the adjacent cell changes too).
    pub fn set_edge(&mut self, p: CellPos, dir: Dir, e: EdgeKind) {
        assert!(self.in_bounds(p), "set_edge out of bounds: {p:?}");
        let w = self.w as usize;
        let (x, z) = (p.x as usize, p.z as usize);
        match dir {
            Dir::Xm => self.edges_x[z * (w + 1) + x] = e,
            Dir::Xp => self.edges_x[z * (w + 1) + x + 1] = e,
            Dir::Zm => self.edges_z[z * w + x] = e,
            Dir::Zp => self.edges_z[(z + 1) * w + x] = e,
        }
    }

    /// Movement query: can an actor step from `p` in `dir`? Off-grid or a
    /// wall edge = no.
    pub fn open(&self, p: CellPos, dir: Dir) -> bool {
        self.in_bounds(p.step(dir)) && self.edge(p, dir) == EdgeKind::Open
    }

    /// FNV-1a over the full canonical grid state — the bit-identity oracle
    /// for "same builder → same level". Pure integers: portable.
    pub fn grid_hash(&self) -> u64 {
        let mut h: u64 = 0xcbf29ce484222325;
        let mut eat = |b: u8| {
            h = (h ^ b as u64).wrapping_mul(0x100000001b3);
        };
        for v in [self.w as u16, self.h as u16] {
            eat(v as u8);
            eat((v >> 8) as u8);
        }
        for c in &self.cells {
            eat(match c {
                CellKind::Outdoor => 0,
                CellKind::Room => 1,
            });
        }
        for e in self.edges_x.iter().chain(self.edges_z.iter()) {
            eat(match e {
                EdgeKind::Open => 0,
                EdgeKind::Wall => 1,
            });
        }
        h
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(x: i16, z: i16) -> CellPos {
        CellPos::new(x, z)
    }

    #[test]
    fn edge_storage_is_shared_between_neighbours() {
        let mut g = Grid::new(4, 4);
        g.set_edge(p(1, 1), Dir::Xp, EdgeKind::Wall);
        assert_eq!(g.edge(p(2, 1), Dir::Xm), EdgeKind::Wall);
        g.set_edge(p(2, 2), Dir::Zm, EdgeKind::Wall);
        assert_eq!(g.edge(p(2, 1), Dir::Zp), EdgeKind::Wall);
        // Boundary edges exist and are settable.
        g.set_edge(p(0, 0), Dir::Xm, EdgeKind::Wall);
        assert_eq!(g.edge(p(0, 0), Dir::Xm), EdgeKind::Wall);
    }

    #[test]
    fn open_blocks_walls_and_the_grid_boundary() {
        let mut g = Grid::new(4, 4);
        assert!(g.open(p(1, 1), Dir::Xp));
        g.set_edge(p(1, 1), Dir::Xp, EdgeKind::Wall);
        assert!(!g.open(p(1, 1), Dir::Xp));
        assert!(!g.open(p(2, 1), Dir::Xm), "the shared edge blocks both ways");
        // stepping off the map is blocked even over an Open boundary edge
        assert!(!g.open(p(0, 0), Dir::Xm));
        assert!(!g.open(p(3, 3), Dir::Zp));
    }

    #[test]
    fn grid_hash_is_stable_and_sensitive() {
        let build = || {
            let mut g = Grid::new(6, 5);
            g.set_cell(p(2, 2), CellKind::Room);
            g.set_edge(p(2, 2), Dir::Xm, EdgeKind::Wall);
            g
        };
        assert_eq!(build().grid_hash(), build().grid_hash(), "same construction → same hash");
        let mut g2 = build();
        g2.set_edge(p(3, 3), Dir::Zm, EdgeKind::Wall);
        assert_ne!(build().grid_hash(), g2.grid_hash(), "an edge flip must change the hash");
        let mut g3 = build();
        g3.set_cell(p(1, 1), CellKind::Room);
        assert_ne!(build().grid_hash(), g3.grid_hash(), "a cell flip must change the hash");
    }
}
