//! Procedural town generation (docs/spec/03-world-model.md, locked round 4).
//!
//! **Fully algorithmic + mandatory validation**: `generate_town` builds a
//! candidate district from `Pcg32::with_stream(seed, attempt)`, runs the
//! fairness pass ([`super::fairness`]), and re-rolls (bounded) until a town
//! provably satisfies the invariants. Same seed → the same accepted town,
//! bit-identical (pinned by `spec_hash`).
//!
//! v0 scope (M0 spike): one intimate district — border ring street, building
//! bands, 10–20 multi-floor buildings (BSP rooms, doors, windows, stairs,
//! exterior climb links), locked strongbox targets, extraction gates.
//! NPC homes/roles/patrols arrive with module 04 at M1/M3; the patrol-gap
//! fairness invariant lands with them.

use super::grid::{Cell, CellKind, CellPos, Dir, DoorState, EdgeKind, LinkKind, Material, Prop, RoomId, TownGrid, VerticalLink, WindowState};
use sim_core::Pcg32;

/// Generation knobs. Sim-affecting config: rides in the spec (replay identity
/// includes the knobs — docs/spec/12).
#[derive(Clone, Copy, Debug)]
pub struct TownParams {
    pub w: i16,
    pub h: i16,
    pub min_buildings: usize,
    pub max_buildings: usize,
    /// Fairness re-roll bound: generation fails loudly rather than looping.
    pub max_attempts: u32,
}

impl Default for TownParams {
    fn default() -> TownParams {
        TownParams { w: 48, h: 48, min_buildings: 10, max_buildings: 20, max_attempts: 16 }
    }
}

/// Half-open cell rectangle [x0,x1) × [z0,z1).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Rect {
    pub x0: i16,
    pub z0: i16,
    pub x1: i16,
    pub z1: i16,
}

impl Rect {
    pub fn w(&self) -> i16 {
        self.x1 - self.x0
    }

    pub fn h(&self) -> i16 {
        self.z1 - self.z0
    }

    pub fn area(&self) -> i32 {
        self.w() as i32 * self.h() as i32
    }

    pub fn contains(&self, x: i16, z: i16) -> bool {
        x >= self.x0 && x < self.x1 && z >= self.z0 && z < self.z1
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BuildingFn {
    Home,
    Shop,
    Workshop,
    Tavern,
}

#[derive(Clone, Debug)]
pub struct Building {
    pub id: u16,
    pub lot: Rect,
    /// Total storeys including ground: 1..=3. Floors 0..n_floors carry cells.
    pub n_floors: u8,
    pub wealth: u8, // 1..=3, drives loot & (later) guard density
    pub function: BuildingFn,
    /// Interior cell just inside the front door + the door edge's direction.
    pub front_door: (CellPos, Dir),
    /// Ordered room ids across all floors (canonical: floor asc, BSP order).
    pub rooms: Vec<RoomId>,
}

/// A locked big-value target (strongbox). `cell` is walkable; the lock lives
/// on the container, the room door is Locked too (generator policy).
#[derive(Clone, Copy, Debug)]
pub struct TargetSpec {
    pub id: u16,
    pub building: u16,
    pub cell: CellPos,
    pub value: u32,
}

/// The generated town — the thief game's level source of truth. Ordered Vecs
/// only (determinism discipline, ARCHITECTURE.md).
pub struct TownSpec {
    pub seed: u64,
    /// Which re-roll passed validation (< params.max_attempts).
    pub attempt: u32,
    pub params: TownParams,
    pub grid: TownGrid,
    pub buildings: Vec<Building>,
    pub targets: Vec<TargetSpec>,
    /// Extraction points on the district boundary (module 02: leaving banks
    /// the run).
    pub gates: Vec<CellPos>,
}

impl TownSpec {
    /// Bit-identity oracle over the whole spec (grid + all ordered lists).
    /// Pure integers — portable across machines.
    pub fn spec_hash(&self) -> u64 {
        let mut h = self.grid.grid_hash();
        let mut eat = |v: u64| {
            for byte in v.to_le_bytes() {
                h = (h ^ byte as u64).wrapping_mul(0x100000001b3);
            }
        };
        eat(self.seed);
        eat(self.attempt as u64);
        for b in &self.buildings {
            eat(b.id as u64);
            eat(((b.lot.x0 as u64) << 48) | ((b.lot.z0 as u64 & 0xffff) << 32) | ((b.lot.x1 as u64 & 0xffff) << 16) | (b.lot.z1 as u64 & 0xffff));
            eat(b.n_floors as u64);
            eat(b.wealth as u64);
            eat(match b.function {
                BuildingFn::Home => 0,
                BuildingFn::Shop => 1,
                BuildingFn::Workshop => 2,
                BuildingFn::Tavern => 3,
            });
            eat(cellpos_key(b.front_door.0));
            eat(match b.front_door.1 {
                Dir::Xm => 0,
                Dir::Xp => 1,
                Dir::Zm => 2,
                Dir::Zp => 3,
            });
            for &r in &b.rooms {
                eat(r as u64);
            }
        }
        for t in &self.targets {
            eat(t.id as u64);
            eat(t.building as u64);
            eat(cellpos_key(t.cell));
            eat(t.value as u64);
        }
        for &g in &self.gates {
            eat(cellpos_key(g));
        }
        h
    }

    /// All interior cells of a building (its lot footprint on each storey).
    pub fn building_cells(&self, b: &Building) -> impl Iterator<Item = CellPos> + '_ {
        let lot = b.lot;
        let n = b.n_floors as i8;
        (0..n).flat_map(move |f| {
            (lot.z0..lot.z1).flat_map(move |z| (lot.x0..lot.x1).map(move |x| CellPos::new(x, z, f)))
        })
    }
}

fn cellpos_key(p: CellPos) -> u64 {
    ((p.x as u64 & 0xffff) << 32) | ((p.z as u64 & 0xffff) << 16) | (p.floor as u8 as u64)
}

/// Seeded inclusive integer range (modulo bias is irrelevant at gen scale,
/// and the SAME bias replays identically).
fn range(rng: &mut Pcg32, lo: i32, hi: i32) -> i32 {
    debug_assert!(lo <= hi);
    lo + (rng.next_u32() % (hi - lo + 1) as u32) as i32
}

/// Generate a fair town: build → validate → re-roll (bounded). The public
/// entry point; the fairness invariants live in [`super::fairness`].
pub fn generate_town(params: &TownParams, seed: u64) -> Result<TownSpec, String> {
    let mut last_failures = Vec::new();
    for attempt in 0..params.max_attempts {
        let spec = build_town(params, seed, attempt);
        let report = super::fairness::validate_town(&spec);
        if report.failures.is_empty() {
            return Ok(spec);
        }
        last_failures = report.failures;
    }
    Err(format!(
        "no fair town within {} attempts for seed {seed}; last failures: {last_failures:?}",
        params.max_attempts
    ))
}

/// One deterministic candidate (unvalidated — the fairness pass judges it).
fn build_town(params: &TownParams, seed: u64, attempt: u32) -> TownSpec {
    // Stream 1000+attempt: re-rolls are fresh streams, never "the same town
    // shifted"; streams never collide (sim-core Pcg32).
    let mut rng = Pcg32::with_stream(seed, 1000 + attempt as u64);
    let (w, h) = (params.w, params.h);
    let mut grid = TownGrid::new(w, h, 0, 2);

    // 1 · Ground floor: street everywhere; buildings paint over it.
    for z in 0..h {
        for x in 0..w {
            grid.set_cell(CellPos::new(x, z, 0), Cell { kind: CellKind::Outdoor, material: Material::Stone, prop: Prop::None });
        }
    }

    // 2 · Lots: horizontal building bands between streets, ring street kept
    // clear (margin 2 on every side).
    let margin: i16 = 2;
    let mut lots: Vec<Rect> = Vec::new();
    let mut z0 = margin;
    while z0 + 5 <= h - margin {
        let band_h = range(&mut rng, 6, 9) as i16;
        let z1 = (z0 + band_h).min(h - margin);
        if z1 - z0 >= 5 {
            let mut x0 = margin;
            while x0 + 5 <= w - margin {
                let lot_w = range(&mut rng, 6, 10) as i16;
                let x1 = (x0 + lot_w).min(w - margin);
                if x1 - x0 >= 5 && lots.len() < params.max_buildings {
                    lots.push(Rect { x0, z0, x1, z1 });
                }
                x0 = x1 + range(&mut rng, 2, 3) as i16;
            }
        }
        z0 = z1 + 2; // band street
    }

    // 3 · Buildings.
    let mut buildings = Vec::new();
    let mut next_room: RoomId = 0;
    let mut tavern_placed = false;
    for (i, &lot) in lots.iter().enumerate() {
        let b = build_building(&mut grid, &mut rng, lot, i as u16, &mut next_room, &mut tavern_placed);
        buildings.push(b);
    }

    // 4 · Targets: strongboxes in the wealthiest buildings.
    let mut order: Vec<usize> = (0..buildings.len()).collect();
    order.sort_by_key(|&i| (std::cmp::Reverse(buildings[i].wealth), i));
    let n_targets = 3.min(buildings.len());
    let mut targets = Vec::new();
    for (tid, &bi) in order[..n_targets].iter().enumerate() {
        let t = place_target(&mut grid, &buildings[bi], tid as u16);
        targets.push(t);
    }
    targets.sort_by_key(|t| t.id);

    // 5 · Extraction gates on the ring street.
    let candidates = [
        CellPos::new(w / 2, 0, 0),
        CellPos::new(w - 1, h / 2, 0),
        CellPos::new(w / 2, h - 1, 0),
        CellPos::new(0, h / 2, 0),
    ];
    let n_gates = range(&mut rng, 2, 4) as usize;
    let first = range(&mut rng, 0, 3) as usize;
    let mut gates: Vec<CellPos> = (0..n_gates).map(|k| candidates[(first + k) % 4]).collect();
    gates.sort_by_key(|&p| (p.z, p.x));

    TownSpec { seed, attempt, params: *params, grid, buildings, targets, gates }
}

fn build_building(grid: &mut TownGrid, rng: &mut Pcg32, lot: Rect, id: u16, next_room: &mut RoomId, tavern_placed: &mut bool) -> Building {
    let wealth = match rng.next_u32() % 10 {
        0..=4 => 1,
        5..=7 => 2,
        _ => 3,
    } as u8;
    let n_floors = match wealth {
        1 => range(rng, 1, 2) as u8,
        2 => 2,
        _ => range(rng, 2, 3) as u8,
    };
    let function = if wealth >= 2 && !*tavern_placed {
        *tavern_placed = true;
        BuildingFn::Tavern
    } else {
        match rng.next_u32() % 10 {
            0..=5 => BuildingFn::Home,
            6..=7 => BuildingFn::Shop,
            _ => BuildingFn::Workshop,
        }
    };

    let mut rooms = Vec::new();
    let mut stair_cells: Vec<(i16, i16)> = Vec::new();
    let mut all_leaves: Vec<(i8, Rect)> = Vec::new();

    for f in 0..n_floors as i8 {
        // Paint the storey's cells.
        for z in lot.z0..lot.z1 {
            for x in lot.x0..lot.x1 {
                grid.set_cell(CellPos::new(x, z, f), Cell { kind: CellKind::Room(0), material: Material::Wood, prop: Prop::None });
            }
        }
        // Perimeter walls.
        for x in lot.x0..lot.x1 {
            grid.set_edge(CellPos::new(x, lot.z0, f), Dir::Zm, EdgeKind::Wall);
            grid.set_edge(CellPos::new(x, lot.z1 - 1, f), Dir::Zp, EdgeKind::Wall);
        }
        for z in lot.z0..lot.z1 {
            grid.set_edge(CellPos::new(lot.x0, z, f), Dir::Xm, EdgeKind::Wall);
            grid.set_edge(CellPos::new(lot.x1 - 1, z, f), Dir::Xp, EdgeKind::Wall);
        }
        // BSP rooms + connecting doors.
        let mut leaves = Vec::new();
        split_rooms(grid, rng, lot, f, &mut leaves);
        // Assign ids and paint (canonical: BSP emit order).
        for leaf in &leaves {
            let rid = *next_room;
            *next_room += 1;
            rooms.push(rid);
            for z in leaf.z0..leaf.z1 {
                for x in leaf.x0..leaf.x1 {
                    let p = CellPos::new(x, z, f);
                    let c = grid.cell(p);
                    grid.set_cell(p, Cell { kind: CellKind::Room(rid), ..c });
                }
            }
            all_leaves.push((f, *leaf));
        }
        // Stairs up to the next storey (reserved cell, same (x,z) both floors).
        if (f as u8) < n_floors - 1 {
            let sx = lot.x0 + 1;
            let sz = lot.z0 + 1;
            stair_cells.push((sx, sz));
            grid.links.push(VerticalLink {
                kind: LinkKind::Stairs,
                a: CellPos::new(sx, sz, f),
                b: CellPos::new(sx, sz, f + 1),
                gate: None,
            });
        }
        // Windows every ~3rd perimeter edge (ground: onto the street; upper:
        // onto the air — future climb gates and light).
        let offset = range(rng, 0, 2) as i16;
        let mut k: i16 = 0;
        let mut perimeter: Vec<(CellPos, Dir)> = Vec::new();
        for x in lot.x0..lot.x1 {
            perimeter.push((CellPos::new(x, lot.z0, f), Dir::Zm));
            perimeter.push((CellPos::new(x, lot.z1 - 1, f), Dir::Zp));
        }
        for z in lot.z0..lot.z1 {
            perimeter.push((CellPos::new(lot.x0, z, f), Dir::Xm));
            perimeter.push((CellPos::new(lot.x1 - 1, z, f), Dir::Xp));
        }
        for (p, d) in perimeter {
            k += 1;
            if (k + offset) % 3 != 0 {
                continue;
            }
            let state = match rng.next_u32() % 10 {
                0..=5 => WindowState::Shut,
                6..=8 => WindowState::Shuttered,
                _ => WindowState::Open,
            };
            grid.set_edge(p, d, EdgeKind::Window(state));
        }
    }

    // Front door: a street-facing side, position seeded along it.
    let side = if rng.next_u32() % 2 == 0 { Dir::Zm } else { Dir::Zp };
    let fx = range(rng, lot.x0 as i32 + 1, lot.x1 as i32 - 2) as i16;
    let fz = if side == Dir::Zm { lot.z0 } else { lot.z1 - 1 };
    let front = CellPos::new(fx, fz, 0);
    grid.set_edge(front, side, EdgeKind::Door(DoorState::Closed));

    // Exterior climb (drainpipe) for multi-storey buildings, ~60%: street
    // cell → first-floor cell behind a (shut) window; the window is the gate.
    if n_floors >= 2 && rng.next_u32() % 10 < 6 {
        let cx = range(rng, lot.x0 as i32 + 1, lot.x1 as i32 - 2) as i16;
        let (up, out_dir, street) = if rng.next_u32() % 2 == 0 {
            (CellPos::new(cx, lot.z0, 1), Dir::Zm, CellPos::new(cx, lot.z0 - 1, 0))
        } else {
            (CellPos::new(cx, lot.z1 - 1, 1), Dir::Zp, CellPos::new(cx, lot.z1, 0))
        };
        grid.set_edge(up, out_dir, EdgeKind::Window(WindowState::Shut));
        grid.links.push(VerticalLink { kind: LinkKind::Climb, a: street, b: up, gate: Some((up, out_dir)) });
    }

    // Furniture per room, plus a hiding spot in every sizeable room. A
    // furniture placement that would pinch off a walkable pocket is REVERTED
    // (module 03: reject-or-repair — this is the local repair; the fairness
    // pass still re-checks reachability globally). The rng is consumed per
    // candidate cell regardless, so the stream stays stable.
    for &(f, leaf) in &all_leaves {
        for z in leaf.z0..leaf.z1 {
            for x in leaf.x0..leaf.x1 {
                let p = CellPos::new(x, z, f);
                let roll = rng.next_u32() % 100 < 12;
                if !roll || stair_cells.contains(&(x, z)) || has_door(grid, p) {
                    continue;
                }
                let c = grid.cell(p);
                grid.set_cell(p, Cell { prop: Prop::Furniture, ..c });
                if !room_connected(grid, leaf, f) {
                    grid.set_cell(p, c); // would pocket the room: revert
                }
            }
        }
        // Hiding spots are walkable (no pocket risk): first eligible cell.
        if leaf.area() >= 12 {
            'hide: for z in leaf.z0..leaf.z1 {
                for x in leaf.x0..leaf.x1 {
                    let p = CellPos::new(x, z, f);
                    if grid.cell(p).prop == Prop::None && !stair_cells.contains(&(x, z)) && !has_door(grid, p) {
                        let c = grid.cell(p);
                        grid.set_cell(p, Cell { prop: Prop::HidingSpot, ..c });
                        break 'hide;
                    }
                }
            }
        }
    }

    Building { id, lot, n_floors, wealth, function, front_door: (front, side), rooms }
}

fn has_door(grid: &TownGrid, p: CellPos) -> bool {
    super::grid::DIRS.iter().any(|&d| matches!(grid.edge(p, d), EdgeKind::Door(_)))
}

/// Are the walkable cells of a leaf room still one connected component?
/// (Leaves are BSP terminals: no interior edges, so plain 4-adjacency within
/// the rect is the room's true connectivity.)
fn room_connected(grid: &TownGrid, leaf: Rect, f: i8) -> bool {
    let mut cells = Vec::new();
    for z in leaf.z0..leaf.z1 {
        for x in leaf.x0..leaf.x1 {
            if grid.cell(CellPos::new(x, z, f)).walkable() {
                cells.push((x, z));
            }
        }
    }
    let Some(&start) = cells.first() else { return false };
    let mut seen = vec![start];
    let mut queue = vec![start];
    while let Some((x, z)) = queue.pop() {
        for (dx, dz) in [(-1i16, 0i16), (1, 0), (0, -1), (0, 1)] {
            let n = (x + dx, z + dz);
            if cells.contains(&n) && !seen.contains(&n) {
                seen.push(n);
                queue.push(n);
            }
        }
    }
    seen.len() == cells.len()
}

/// Recursive BSP: split until rooms are ≤ 5 cells a side, walling each split
/// line with a door in it (30% of interior doors start open).
fn split_rooms(grid: &mut TownGrid, rng: &mut Pcg32, rect: Rect, f: i8, out: &mut Vec<Rect>) {
    let (w, h) = (rect.w(), rect.h());
    if w <= 5 && h <= 5 {
        out.push(rect);
        return;
    }
    if w >= h {
        let cut = range(rng, rect.x0 as i32 + 3, rect.x1 as i32 - 3) as i16;
        for z in rect.z0..rect.z1 {
            grid.set_edge(CellPos::new(cut, z, f), Dir::Xm, EdgeKind::Wall);
        }
        let dz = range(rng, rect.z0 as i32, rect.z1 as i32 - 1) as i16;
        let state = if rng.next_u32() % 10 < 3 { DoorState::Open } else { DoorState::Closed };
        grid.set_edge(CellPos::new(cut, dz, f), Dir::Xm, EdgeKind::Door(state));
        split_rooms(grid, rng, Rect { x1: cut, ..rect }, f, out);
        split_rooms(grid, rng, Rect { x0: cut, ..rect }, f, out);
    } else {
        let cut = range(rng, rect.z0 as i32 + 3, rect.z1 as i32 - 3) as i16;
        for x in rect.x0..rect.x1 {
            grid.set_edge(CellPos::new(x, cut, f), Dir::Zm, EdgeKind::Wall);
        }
        let dx = range(rng, rect.x0 as i32, rect.x1 as i32 - 1) as i16;
        let state = if rng.next_u32() % 10 < 3 { DoorState::Open } else { DoorState::Closed };
        grid.set_edge(CellPos::new(dx, cut, f), Dir::Zm, EdgeKind::Door(state));
        split_rooms(grid, rng, Rect { z1: cut, ..rect }, f, out);
        split_rooms(grid, rng, Rect { z0: cut, ..rect }, f, out);
    }
}

/// Put the strongbox in the top-floor's far corner room: lock every door
/// into that room, guarantee two hiding spots in it (module 03's density
/// floor near valuables), clear the target cell itself.
fn place_target(grid: &mut TownGrid, b: &Building, tid: u16) -> TargetSpec {
    let f = (b.n_floors - 1) as i8;
    // Far corner room = the room containing the lot's far corner cell.
    let corner = CellPos::new(b.lot.x1 - 2, b.lot.z1 - 2, f);
    let rid = match grid.cell(corner).kind {
        CellKind::Room(r) => r,
        _ => unreachable!("building corner must be interior"),
    };
    let room_cells: Vec<CellPos> = (b.lot.z0..b.lot.z1)
        .flat_map(|z| (b.lot.x0..b.lot.x1).map(move |x| CellPos::new(x, z, f)))
        .filter(|&p| grid.cell(p).kind == CellKind::Room(rid))
        .collect();
    // Lock the room: every Door edge on its boundary becomes Locked.
    for &p in &room_cells {
        for d in super::grid::DIRS {
            if let EdgeKind::Door(_) = grid.edge(p, d) {
                let q = p.step(d);
                let q_in_room = grid.in_bounds(q) && grid.cell(q).kind == CellKind::Room(rid);
                if !q_in_room {
                    grid.set_edge(p, d, EdgeKind::Door(DoorState::Locked));
                }
            }
        }
    }
    // The strongbox cell: room centre-ish (first cell nearest the centroid).
    let (mut cx, mut cz) = (0i32, 0i32);
    for &p in &room_cells {
        cx += p.x as i32;
        cz += p.z as i32;
    }
    let (cx, cz) = (cx / room_cells.len() as i32, cz / room_cells.len() as i32);
    let target = *room_cells
        .iter()
        .min_by_key(|p| {
            let (dx, dz) = (p.x as i32 - cx, p.z as i32 - cz);
            (dx * dx + dz * dz, p.z, p.x)
        })
        .expect("room has cells");
    let c = grid.cell(target);
    grid.set_cell(target, Cell { prop: Prop::None, material: Material::Rug, ..c });
    // Two guaranteed hiding spots in the room (fairness floor), away from the
    // strongbox cell, canonical scan order.
    let mut placed = 0;
    for &p in &room_cells {
        if placed >= 2 {
            break;
        }
        if p != target && grid.cell(p).prop == Prop::None && !has_door(grid, p) {
            let c = grid.cell(p);
            grid.set_cell(p, Cell { prop: Prop::HidingSpot, ..c });
            placed += 1;
        }
    }
    TargetSpec { id: tid, building: b.id, cell: target, value: 100 * b.wealth as u32 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fairness_oracle_over_many_seeds() {
        // THE M0 spike-B gate (docs/spec/12): M seeds, every invariant holds.
        let params = TownParams::default();
        for seed in 0..32u64 {
            let spec = generate_town(&params, seed)
                .unwrap_or_else(|e| panic!("seed {seed}: {e}"));
            assert!(spec.buildings.len() >= params.min_buildings, "seed {seed}: too few buildings");
            assert!(spec.buildings.len() <= params.max_buildings);
            assert!((2..=4).contains(&spec.gates.len()), "seed {seed}: gate count");
            assert_eq!(spec.targets.len(), 3);
            assert!(spec.attempt < params.max_attempts);
        }
    }

    #[test]
    fn same_seed_is_bit_identical_and_seeds_differ() {
        let params = TownParams::default();
        let a = generate_town(&params, 7).unwrap();
        let b = generate_town(&params, 7).unwrap();
        assert_eq!(a.spec_hash(), b.spec_hash(), "same seed must reproduce the town bit-identically");
        assert_eq!(a.grid.grid_hash(), b.grid.grid_hash());
        let c = generate_town(&params, 8).unwrap();
        assert_ne!(a.spec_hash(), c.spec_hash(), "different seeds must differ");
    }

    #[test]
    fn towns_have_multi_storey_buildings_with_stairs_and_climbs() {
        let spec = generate_town(&TownParams::default(), 3).unwrap();
        let multi = spec.buildings.iter().filter(|b| b.n_floors >= 2).count();
        assert!(multi >= 3, "want a real multi-floor town, got {multi} multi-storey buildings");
        let stairs = spec.grid.links.iter().filter(|l| l.kind == LinkKind::Stairs).count();
        assert!(stairs >= multi, "every extra storey needs stairs");
        // Targets sit on top floors behind locked doors, hiding spots nearby.
        for t in &spec.targets {
            let b = &spec.buildings[t.building as usize];
            assert_eq!(t.cell.floor, (b.n_floors - 1) as i8);
            assert!(b.lot.contains(t.cell.x, t.cell.z));
        }
    }

    /// Diagnostic, not a gate: `cargo test -p house-game attempt_histogram
    /// -- --ignored --nocapture` prints how many re-rolls seeds need. If the
    /// tail grows after a generator change, the generator got more fragile
    /// and is leaning on the re-roll bound instead of being fixed.
    #[test]
    #[ignore]
    fn attempt_histogram() {
        let params = TownParams::default();
        let mut counts = vec![0usize; params.max_attempts as usize];
        for seed in 0..64u64 {
            let spec = generate_town(&params, seed).unwrap();
            counts[spec.attempt as usize] += 1;
        }
        println!("attempts needed (idx = re-rolls): {counts:?}");
    }

    #[test]
    fn rerolls_are_bounded_and_recorded() {
        // A cramped parameterization forces some re-rolls but must stay
        // within the bound for these seeds (fails loudly otherwise).
        let params = TownParams { w: 32, h: 32, min_buildings: 6, max_buildings: 12, max_attempts: 16 };
        for seed in 0..8u64 {
            let spec = generate_town(&params, seed).unwrap_or_else(|e| panic!("seed {seed}: {e}"));
            assert!(spec.attempt < params.max_attempts);
        }
    }
}
