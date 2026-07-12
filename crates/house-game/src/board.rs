//! The tiny-world BOARD — the Larceny pivot's map layer (see
//! `docs/larceny-mvp-brainstorm.md`). One tile = 1.0 wu² = one whole thing:
//! a house, a road, a field, a well. Civ-map scale, Into-the-Breach read —
//! buildings are never entered; every interaction (casing, burgling,
//! gathering, trading) is a channel performed standing NEXT to a tile.
//!
//! The board is authored as an ASCII grid and carried on the `LevelSpec` as
//! `board: Some(BoardSpec)` — the same opt-in discipline as `survival`/`mobs`:
//! every existing level keeps `board: None` and spawns/hashes exactly as
//! before. Collision falls out of the tile grid (blocked tiles → merged
//! per-row `static_solids` runs), so the game's `Level::is_blocked` and the
//! renderer's board path share one source of truth.
//!
//! Tile (x, z) covers world rect [x, z, x+1, z+1] — integer edges, so every
//! emitted coordinate is trivially on the iso 2:1 stair lattice (multiples of
//! 0.0625 wu, invariant #8). The renderer's PROP boxes inside each tile must
//! keep their own offsets on the lattice too (pinned by rt-viewer tests).

use crate::spec::{LevelSpec, RoomId, RoomSpec};
use glam::Vec3;

/// What a 1-wu tile IS. Walkable ground kinds carry only a floor tint;
/// blocked kinds also emit collision and a prop (the renderer's box-built
/// miniature). Buildings get hidden inventories / owners in later milestones.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TileKind {
    // walkable ground
    Grass,
    Road,
    Plaza,
    Field,  // crops — the legit gathering spot
    Gate,   // a walkable gap in a hedge line (posts, no leaf)
    // blocked terrain
    Forest, // dense trees — blocks walk (gathering happens adjacent)
    Water,
    Hedge, // blocks walk AND (later) sight — the rich quarter's wall
    // blocked buildings (the burglary targets / services)
    House,
    Manor,
    Shop,
    Guardhouse,
    FenceShack,
    Well,
}

impl TileKind {
    /// Whether the tile is solid to walking. The compiler turns every blocked
    /// tile into `static_solids` coverage, so the sim's collision and this
    /// predicate can never drift apart.
    pub fn blocks_walk(self) -> bool {
        !matches!(self, TileKind::Grass | TileKind::Road | TileKind::Plaza | TileKind::Field | TileKind::Gate)
    }

    /// Buildings — casing/burglary targets and service fronts (not terrain).
    pub fn is_building(self) -> bool {
        matches!(self, TileKind::House | TileKind::Manor | TileKind::Shop | TileKind::Guardhouse | TileKind::FenceShack)
    }
}

/// Districts — an authoring convention over the grid (a byte per tile), not a
/// system: they key the renderer's prop palette today and the loot tables /
/// lamp density / patrol coverage in later milestones.
pub const D_RURAL: u8 = 0;
pub const D_POOR: u8 = 1;
pub const D_MARKET: u8 = 2;
pub const D_RICH: u8 = 3;

/// The tile board riding on a `LevelSpec`. Row-major, index `z * w + x`;
/// tile (x, z) covers world [x, z, x+1, z+1].
#[derive(Clone, PartialEq, Debug)]
pub struct BoardSpec {
    pub w: i32,
    pub h: i32,
    pub tiles: Vec<TileKind>,
    pub district: Vec<u8>,
}

impl BoardSpec {
    pub fn kind(&self, x: i32, z: i32) -> Option<TileKind> {
        (x >= 0 && x < self.w && z >= 0 && z < self.h).then(|| self.tiles[(z * self.w + x) as usize])
    }

    pub fn district_at(&self, x: i32, z: i32) -> u8 {
        if x >= 0 && x < self.w && z >= 0 && z < self.h {
            self.district[(z * self.w + x) as usize]
        } else {
            D_RURAL
        }
    }
}

/// The authored hamlet: 16×12 tiles, three districts + a rural south edge.
/// West = POOR quarter (hovels, pocket-change loot). Center = MARKET row
/// (shop + well plaza on the main street — daytime eyes). North-east = RICH
/// quarter (manor + house behind a hedge wall, one gate, guardhouse at the
/// spur). South = fields (legit gathering), a pond, and the forest hiding the
/// fence's shack at the end of a grass path.
///
/// Legend: `.` grass  `r` road  `p` plaza  `f` field  `t` forest  `w` water
///         `h` hedge  `g` gate  `H` house  `M` manor  `S` shop
///         `G` guardhouse  `F` fence shack  `W` well
const HAMLET_W: i32 = 16;
const HAMLET_H: i32 = 12;
#[rustfmt::skip]
const HAMLET_MAP: [&str; HAMLET_H as usize] = [
    "tt.........h....", // z=0  north (far in iso)
    "t.H.H......hM.H.", // z=1  poor hovels west; manor + rich house inside the hedge
    ".......S...h....", // z=2  shop faces the market square
    ".H.H..pWp..hhghh", // z=3  well on the square; the rich quarter's gate
    "......ppp....rG.", // z=4  plaza opens to the street; road spur + guardhouse
    "rrrrrrrrrrrrrrrr", // z=5  the main street, west→east
    "..H.........H...", // z=6
    ".H...H..H.....H.", // z=7
    ".ff...ww..tttt..", // z=8  fields SW, pond, forest SE
    "ffff..w...tttt..", // z=9
    "ffff......Ftttt.", // z=10 fence shack in a forest clearing
    "ff.....ttttttt..", // z=11 south (near in iso)
];

fn hamlet_tile(c: u8) -> TileKind {
    match c {
        b'.' => TileKind::Grass,
        b'r' => TileKind::Road,
        b'p' => TileKind::Plaza,
        b'f' => TileKind::Field,
        b't' => TileKind::Forest,
        b'w' => TileKind::Water,
        b'h' => TileKind::Hedge,
        b'g' => TileKind::Gate,
        b'H' => TileKind::House,
        b'M' => TileKind::Manor,
        b'S' => TileKind::Shop,
        b'G' => TileKind::Guardhouse,
        b'F' => TileKind::FenceShack,
        b'W' => TileKind::Well,
        other => panic!("hamlet map: unknown tile char {:?}", other as char),
    }
}

/// District assignment — rectangles over the grid, streets included so a
/// tile's district is always defined (loot/patrol logic reads it later).
fn hamlet_district(x: i32, z: i32) -> u8 {
    if x >= 11 && z <= 4 {
        D_RICH
    } else if (6..=10).contains(&x) && z <= 7 || x >= 11 && (5..=7).contains(&z) {
        D_MARKET
    } else if x <= 5 && z <= 7 {
        D_POOR
    } else {
        D_RURAL
    }
}

/// Build the hamlet level. The layout is fixed (hand-authored); `seed` rides
/// into `LevelSpec.seed` for later content rolls (hidden inventories, NPC
/// quirks), exactly like the village.
pub fn hamlet_level(seed: u64) -> LevelSpec {
    let (w, h) = (HAMLET_W, HAMLET_H);
    let mut tiles = Vec::with_capacity((w * h) as usize);
    let mut district = Vec::with_capacity((w * h) as usize);
    for (z, row) in HAMLET_MAP.iter().enumerate() {
        assert_eq!(row.len(), w as usize, "hamlet map row {z} must be {w} tiles");
        for (x, c) in row.bytes().enumerate() {
            tiles.push(hamlet_tile(c));
            district.push(hamlet_district(x as i32, z as i32));
        }
    }
    let board = BoardSpec { w, h, tiles, district };

    // collision: merge each row's consecutive blocked tiles into one solid.
    let mut static_solids: Vec<[f32; 4]> = Vec::new();
    for z in 0..h {
        let mut x = 0;
        while x < w {
            if board.tiles[(z * w + x) as usize].blocks_walk() {
                let x0 = x;
                while x < w && board.tiles[(z * w + x) as usize].blocks_walk() {
                    x += 1;
                }
                static_solids.push([x0 as f32, z as f32, x as f32, (z + 1) as f32]);
            } else {
                x += 1;
            }
        }
    }

    LevelSpec {
        rooms: vec![RoomSpec { id: RoomId(0), floor_rect: [0.0, 0.0, w as f32, h as f32] }],
        static_solids,
        doors: vec![],
        lights: vec![],
        targets: vec![],
        items: vec![],
        survival: None,
        mobs: vec![],
        traps: vec![],
        arena: None,
        drain: None,
        low_solids: Vec::new(),
        sterile: false,
        board: Some(board),
        // on the street by the market square — near the board centre, so the
        // boot camera (which targets the spawn) frames the whole diorama.
        player_start: Vec3::new(7.5, 0.0, 5.5),
        seed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Level;

    fn board(spec: &LevelSpec) -> &BoardSpec {
        spec.board.as_ref().expect("hamlet carries a board")
    }

    /// Same seed twice → identical board and collision (and the layout is in
    /// fact seed-independent — the seed only rides along for later rolls).
    #[test]
    fn hamlet_is_deterministic() {
        let a = hamlet_level(1);
        let b = hamlet_level(1);
        assert_eq!(a.static_solids, b.static_solids);
        assert_eq!(board(&a), board(&b));
        let c = hamlet_level(99);
        assert_eq!(a.static_solids, c.static_solids, "layout is seed-independent");
        assert_eq!(c.seed, 99);
    }

    /// Every emitted rect is on the iso 2:1 stair lattice (invariant #8) —
    /// trivially, since tiles have integer edges; this pins it stays so.
    #[test]
    fn hamlet_geometry_is_iso_stair_aligned() {
        const STEP: f32 = 0.0625;
        let on = |v: f32| (v / STEP - (v / STEP).round()).abs() < 1e-4;
        let spec = hamlet_level(1);
        for r in &spec.rooms {
            for v in r.floor_rect {
                assert!(on(v), "floor rect coord {v} off the lattice");
            }
        }
        for s in &spec.static_solids {
            for v in *s {
                assert!(on(v), "solid coord {v} off the lattice");
            }
        }
    }

    /// The board and the emitted collision can never disagree: the centre of
    /// every blocked tile is solid to `Level::is_blocked`, every walkable
    /// tile centre is clear.
    #[test]
    fn board_and_collision_agree() {
        let spec = hamlet_level(1);
        let b = board(&spec);
        let lvl = Level { floor: spec.floor_bounds(), solids: spec.static_solids.clone() };
        for z in 0..b.h {
            for x in 0..b.w {
                let k = b.kind(x, z).unwrap();
                let (cx, cz) = (x as f32 + 0.5, z as f32 + 0.5);
                assert_eq!(lvl.is_blocked(cx, cz), k.blocks_walk(), "tile ({x},{z}) {k:?}");
            }
        }
    }

    /// Flood-fill from the spawn: every walkable tile is reachable (no
    /// stranded pockets), and every BUILDING has at least one reachable
    /// walkable neighbour — you can always stand next to it to case it.
    #[test]
    fn every_tile_reachable_and_every_building_approachable() {
        let spec = hamlet_level(1);
        let b = board(&spec);
        let (w, h) = (b.w, b.h);
        let start = (spec.player_start.x as i32, spec.player_start.z as i32);
        assert!(!b.kind(start.0, start.1).unwrap().blocks_walk(), "spawn tile walkable");
        let mut seen = vec![false; (w * h) as usize];
        let mut stack = vec![start];
        seen[(start.1 * w + start.0) as usize] = true;
        while let Some((cx, cz)) = stack.pop() {
            for (dx, dz) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                let (nx, nz) = (cx + dx, cz + dz);
                if let Some(k) = b.kind(nx, nz) {
                    let ni = (nz * w + nx) as usize;
                    if !k.blocks_walk() && !seen[ni] {
                        seen[ni] = true;
                        stack.push((nx, nz));
                    }
                }
            }
        }
        for z in 0..h {
            for x in 0..w {
                let k = b.kind(x, z).unwrap();
                if !k.blocks_walk() {
                    assert!(seen[(z * w + x) as usize], "walkable tile ({x},{z}) stranded");
                }
                if k.is_building() {
                    let approachable = [(1, 0), (-1, 0), (0, 1), (0, -1)].iter().any(|(dx, dz)| {
                        b.kind(x + dx, z + dz).is_some_and(|nk| !nk.blocks_walk()) && seen[((z + dz) * w + (x + dx)) as usize]
                    });
                    assert!(approachable, "building {k:?} at ({x},{z}) has no reachable adjacent tile");
                }
            }
        }
    }

    /// District coverage sanity: all four districts appear, and the marquee
    /// tiles sit in the right ones (manor RICH, shop/well MARKET, fence RURAL).
    #[test]
    fn districts_cover_the_map() {
        let spec = hamlet_level(1);
        let b = board(&spec);
        for d in [D_RURAL, D_POOR, D_MARKET, D_RICH] {
            assert!(b.district.contains(&d), "district {d} missing");
        }
        let find = |want: TileKind| {
            (0..b.h)
                .flat_map(|z| (0..b.w).map(move |x| (x, z)))
                .find(|&(x, z)| b.kind(x, z) == Some(want))
                .unwrap_or_else(|| panic!("no {want:?} tile"))
        };
        let (mx, mz) = find(TileKind::Manor);
        assert_eq!(b.district_at(mx, mz), D_RICH);
        let (sx, sz) = find(TileKind::Shop);
        assert_eq!(b.district_at(sx, sz), D_MARKET);
        let (wx, wz) = find(TileKind::Well);
        assert_eq!(b.district_at(wx, wz), D_MARKET);
        let (fx, fz) = find(TileKind::FenceShack);
        assert_eq!(b.district_at(fx, fz), D_RURAL);
        let (gx, gz) = find(TileKind::Guardhouse);
        assert_eq!(b.district_at(gx, gz), D_RICH);
    }
}
