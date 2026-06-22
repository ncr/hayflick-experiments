//! Procedural cave/dungeon generator — Diablo-flavoured rooms + corridors on a
//! tile grid, emitted as a [`LevelSpec`] so ONE spec drives both collision
//! (house-game) and the graybox visuals (rt-viewer's `build_game`). Fully
//! deterministic in `seed`.
//!
//! Rectangular rooms are placed by rejection sampling (1-cell margin between
//! them), then each room is joined to its nearest predecessor by an L-shaped
//! corridor — a spanning tree, so every room is reachable. Walls are the thin
//! (0.25 wu) boundary between a walkable cell and the rock/void: one slab per
//! floor↔non-floor grid edge, merged into runs split wherever the floor side
//! flips (so `build_game` can read each run's dollhouse hide direction from the
//! layout and let the iso camera see into the rooms).
//!
//! 1 grid cell = 1.0 wu = the wall-kit cell. Every emitted XZ coordinate is an
//! integer cell line ± the 0.125 wu wall half-thickness, so all geometry lands
//! on the iso 2:1 stair lattice (multiples of 0.0625 wu — invariant #8). Pinned
//! by `cave::tests::geometry_is_iso_stair_aligned`.

use crate::spec::{DoorId, DoorSpec, LevelSpec, LightId, LightKind, LightSpec, RoomId, RoomSpec};
use glam::Vec3;

/// A `RoomSpec` whose `id` is at or above this is a CORRIDOR floor quad (neutral
/// stone) rather than a coloured room — `build_game` keys the floor tint off it.
/// Far above any real room count, so the two id spaces never collide.
pub const CORRIDOR_ROOM_ID_BASE: u32 = 1_000_000;

/// Generator tunables, in tile cells (1 cell = 1.0 wu). The default is the
/// "medium ~10 rooms" preset.
#[derive(Clone, Copy, Debug)]
pub struct CaveParams {
    pub grid_w: i32,
    pub grid_h: i32,
    pub rooms: u32,    // target room count (rejection sampling may yield fewer)
    pub room_min: i32, // min room side
    pub room_max: i32, // max room side (inclusive)
    pub attempts: u32,    // placement tries before giving up
    pub loops: u32,       // extra corridors beyond the spanning tree (cycles → multiple routes)
    pub door_chance: f32, // 0..1: fraction of room↔corridor openings that get a swinging door
    pub thick_walls: bool, // true: fill the gaps with full 1×1 rock blocks (Diablo); false: thin boundary walls + void
}

impl Default for CaveParams {
    fn default() -> CaveParams {
        CaveParams::for_rooms(10, 3)
    }
}

impl CaveParams {
    /// A preset scaled to `rooms`: the grid grows with √rooms so rejection
    /// sampling stays easy (≈25% fill), and the placement budget tracks the
    /// count. `loops` adds cycles on top of the connecting spanning tree.
    pub fn for_rooms(rooms: u32, loops: u32) -> CaveParams {
        let rooms = rooms.max(1);
        let side = ((rooms as f32).sqrt() * 13.0).round() as i32;
        CaveParams { grid_w: side.max(20), grid_h: (side * 4 / 5).max(16), rooms, room_min: 4, room_max: 7, attempts: 40 * rooms, loops, door_chance: 0.7, thick_walls: false }
    }
}

/// SplitMix64 — a tiny deterministic PRNG. No `rand` dep: the spec's whole point
/// is reproducibility, so the generator owns its own stream. `pub(crate)` so the
/// hand-authored `village` layout can seed the shared `emit_grid_spec` tail.
pub(crate) struct Rng(pub(crate) u64);
impl Rng {
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    /// uniform in `[lo, hi)` (caller guarantees `hi > lo`)
    fn range(&mut self, lo: i32, hi: i32) -> i32 {
        lo + (self.next_u64() % (hi - lo) as u64) as i32
    }
    fn coin(&mut self) -> bool {
        self.next_u64() & 1 == 1
    }
}

/// A placed rectangle on the cell grid. `pub(crate)` so `village` can build its
/// own deterministic layout and hand it to the shared `emit_grid_spec` tail.
#[derive(Clone, Copy)]
pub(crate) struct Room {
    pub(crate) x: i32,
    pub(crate) z: i32,
    pub(crate) w: i32,
    pub(crate) h: i32,
}
impl Room {
    fn cx(&self) -> i32 {
        self.x + self.w / 2
    }
    fn cz(&self) -> i32 {
        self.z + self.h / 2
    }
    /// overlap test with a 1-cell breathing margin
    fn clashes(&self, o: &Room) -> bool {
        self.x - 1 < o.x + o.w && o.x - 1 < self.x + self.w && self.z - 1 < o.z + o.h && o.z - 1 < self.z + self.h
    }
}

/// Generate a cave level from `seed` with the default (medium) preset.
pub fn cave_level(seed: u64) -> LevelSpec {
    cave_level_with(seed, CaveParams::default())
}

/// Generate a cave level from `seed` with explicit params.
pub fn cave_level_with(seed: u64, p: CaveParams) -> LevelSpec {
    let mut rng = Rng(seed ^ 0xCA7E_5EED_A11C_E5E5); // de-correlate seed 0
    let (w, h) = (p.grid_w, p.grid_h);
    let at = |x: i32, z: i32| (z * w + x) as usize;

    // ---- rooms: rejection sampling, 1-cell margin between them ----
    let mut rooms: Vec<Room> = Vec::new();
    for _ in 0..p.attempts {
        if rooms.len() as u32 >= p.rooms {
            break;
        }
        let rw = rng.range(p.room_min, p.room_max + 1);
        let rh = rng.range(p.room_min, p.room_max + 1);
        let cand = Room { x: rng.range(1, (w - rw - 1).max(2)), z: rng.range(1, (h - rh - 1).max(2)), w: rw, h: rh };
        if rooms.iter().all(|r| !r.clashes(&cand)) {
            rooms.push(cand);
        }
    }
    assert!(!rooms.is_empty(), "cave: no rooms placed — grid {w}x{h} too small for the room size");

    // ---- carve floor cells: room interiors, then corridors joining each room
    // to its nearest predecessor (a spanning tree → every room reachable) ----
    let mut floor = vec![false; (w * h) as usize];
    let mut room_of = vec![-1i32; (w * h) as usize]; // -1 = corridor or rock
    for (ri, r) in rooms.iter().enumerate() {
        for z in r.z..r.z + r.h {
            for x in r.x..r.x + r.w {
                floor[at(x, z)] = true;
                room_of[at(x, z)] = ri as i32;
            }
        }
    }
    let carve = |floor: &mut [bool], x: i32, z: i32| {
        if (0..w).contains(&x) && (0..h).contains(&z) {
            floor[at(x, z)] = true;
        }
    };
    // L-shaped 1-cell corridor between two cells (horizontal-then-vertical or
    // vice-versa, by coin), carving floor.
    let carve_path = |floor: &mut [bool], rng: &mut Rng, a: (i32, i32), b: (i32, i32)| {
        let ((ax, az), (bx, bz)) = (a, b);
        if rng.coin() {
            for x in ax.min(bx)..=ax.max(bx) {
                carve(floor, x, az);
            }
            for z in az.min(bz)..=az.max(bz) {
                carve(floor, bx, z);
            }
        } else {
            for z in az.min(bz)..=az.max(bz) {
                carve(floor, ax, z);
            }
            for x in ax.min(bx)..=ax.max(bx) {
                carve(floor, x, bz);
            }
        }
    };
    // spanning tree: join each room to its nearest predecessor (connected)
    for i in 1..rooms.len() {
        let c = (rooms[i].cx(), rooms[i].cz());
        let j = (0..i).min_by_key(|&j| (rooms[j].cx() - c.0).abs() + (rooms[j].cz() - c.1).abs()).unwrap();
        carve_path(&mut floor, &mut rng, c, (rooms[j].cx(), rooms[j].cz()));
    }
    // loops: a few extra corridors between nearby rooms → cycles, so the dungeon
    // has more than one route (Manhattan threshold keeps them local, not crossing).
    for _ in 0..p.loops {
        let i = rng.range(0, rooms.len() as i32) as usize;
        let j = rng.range(0, rooms.len() as i32) as usize;
        if i != j && (rooms[i].cx() - rooms[j].cx()).abs() + (rooms[i].cz() - rooms[j].cz()).abs() <= 16 {
            carve_path(&mut floor, &mut rng, (rooms[i].cx(), rooms[i].cz()), (rooms[j].cx(), rooms[j].cz()));
        }
    }

    // ---- emit floors + walls + doors + lights from the carved grid. Shared
    // with the hand-authored `village` layout (same machinery; only the grid
    // differs). The spawn is room 0's centre, exactly as before.
    let r0 = &rooms[0];
    let player_start = Vec3::new(r0.x as f32 + r0.w as f32 * 0.5, 0.0, r0.z as f32 + r0.h as f32 * 0.5);
    emit_grid_spec(w, h, &floor, &room_of, &rooms, p.door_chance, p.thick_walls, &mut rng, player_start, seed)
}

/// Turn a carved cell grid (floor mask + per-cell `room_of`) plus the placed
/// rooms into a [`LevelSpec`]: coloured room floors, merged corridor runs, the
/// thin/thick wall slabs on every floor↔void edge, the room↔corridor doors, and
/// one ceiling lamp per room. Factored out of [`cave_level_with`] so `village`
/// reuses the identical wall/door emission (and its dollhouse cull metadata).
/// The RNG is consumed ONLY by door placement, in the same order as before, so
/// the cave's output stays byte-identical.
pub(crate) fn emit_grid_spec(w: i32, h: i32, floor: &[bool], room_of: &[i32], rooms: &[Room], door_chance: f32, thick_walls: bool, rng: &mut Rng, player_start: Vec3, seed: u64) -> LevelSpec {
    let at = |x: i32, z: i32| (z * w + x) as usize;

    // ---- floor quads: one RoomSpec per room (coloured), plus corridor floor
    // as merged horizontal runs of carved-but-roomless cells (neutral stone) ----
    let mut room_specs: Vec<RoomSpec> = rooms
        .iter()
        .enumerate()
        .map(|(ri, r)| RoomSpec { id: RoomId(ri as u32), floor_rect: [r.x as f32, r.z as f32, (r.x + r.w) as f32, (r.z + r.h) as f32] })
        .collect();
    let mut corridor_n = 0u32;
    for z in 0..h {
        let mut x = 0;
        while x < w {
            if floor[at(x, z)] && room_of[at(x, z)] < 0 {
                let x0 = x;
                while x < w && floor[at(x, z)] && room_of[at(x, z)] < 0 {
                    x += 1;
                }
                room_specs.push(RoomSpec { id: RoomId(CORRIDOR_ROOM_ID_BASE + corridor_n), floor_rect: [x0 as f32, z as f32, x as f32, (z + 1) as f32] });
                corridor_n += 1;
            } else {
                x += 1;
            }
        }
    }

    // ---- walls ----
    const T: f32 = 0.125; // thin-wall half-thickness (0.25 wu wall, kit = 32 cm)
    let is_floor = |x: i32, z: i32| (0..w).contains(&x) && (0..h).contains(&z) && floor[at(x, z)];
    let mut solids: Vec<[f32; 4]> = Vec::new();
    if thick_walls {
        // THICK ROCK: fill every non-floor cell 8-adjacent to a floor cell with a
        // full 1×1 block, flush against the room/corridor edges (rock between the
        // rooms, with visible wall-tops). build_game derives each block's
        // dollhouse-hide direction from its floor-facing neighbours.
        for z in 0..h {
            for x in 0..w {
                if !is_floor(x, z) && (-1..=1).any(|dz| (-1..=1).any(|dx| (dx, dz) != (0, 0) && is_floor(x + dx, z + dz))) {
                    solids.push([x as f32, z as f32, (x + 1) as f32, (z + 1) as f32]);
                }
            }
        }
    } else {
        // THIN walls: 0.25 wu slabs on every floor↔non-floor grid edge, runs
        // merged but SPLIT where the floor side flips (so each run has one outward
        // side for build_game's dollhouse cull).
        // vertical slabs on line x=k (between cells k-1 and k), spanning z
        for k in 0..=w {
            let mut z = 0;
            while z < h {
                let side = is_floor(k - 1, z); // floor on the -X side?
                if side ^ is_floor(k, z) {
                    let z0 = z;
                    while z < h && is_floor(k - 1, z) == side && (side ^ is_floor(k, z)) {
                        z += 1;
                    }
                    solids.push([k as f32 - T, z0 as f32, k as f32 + T, z as f32]);
                } else {
                    z += 1;
                }
            }
        }
        // horizontal slabs on line z=k (between cells k-1 and k), spanning x
        for k in 0..=h {
            let mut x = 0;
            while x < w {
                let side = is_floor(x, k - 1); // floor on the -Z side?
                if side ^ is_floor(x, k) {
                    let x0 = x;
                    while x < w && is_floor(x, k - 1) == side && (side ^ is_floor(x, k)) {
                        x += 1;
                    }
                    solids.push([x0 as f32, k as f32 - T, x as f32, k as f32 + T]);
                } else {
                    x += 1;
                }
            }
        }
    }

    // ---- doors: fill 1-cell room↔corridor openings with a swinging leaf. Each
    // such opening is a break the corridor punched in a room wall (both sides
    // floor → no wall slab there); a fraction get a door (the rest stay arches).
    // 100° swing, 24-tick sweep — matching the authored house leaves. ----
    const DOOR_OPEN: f32 = 1.745_329_3; // 100° in radians
    let kind = |x: i32, z: i32| -> u8 {
        if !is_floor(x, z) {
            0 // rock/void
        } else if room_of[at(x, z)] >= 0 {
            2 // room
        } else {
            1 // corridor
        }
    };
    let is_opening = |a: u8, b: u8| (a == 2 && b == 1) || (a == 1 && b == 2);
    let mut doors: Vec<DoorSpec> = Vec::new();
    let add_door = |doors: &mut Vec<DoorSpec>, rng: &mut Rng, hinge: Vec3, closed: [f32; 4]| {
        if (rng.next_u64() % 1000) as f32 / 1000.0 < door_chance {
            let id = doors.len() as u32;
            doors.push(DoorSpec { id: DoorId(id), hinge, axis_y: 1.0, closed_solid: closed, open_angle: DOOR_OPEN, anim_ticks: 24, name: format!("cave_door_{id}") });
        }
    };
    // vertical openings on line x=k (door slab spans one z cell)
    for k in 1..w {
        let mut z = 0;
        while z < h {
            if is_opening(kind(k - 1, z), kind(k, z)) {
                let z0 = z;
                while z < h && is_opening(kind(k - 1, z), kind(k, z)) {
                    z += 1;
                }
                if z - z0 == 1 {
                    add_door(&mut doors, rng, Vec3::new(k as f32, 0.0, z0 as f32), [k as f32 - T, z0 as f32, k as f32 + T, (z0 + 1) as f32]);
                }
            } else {
                z += 1;
            }
        }
    }
    // horizontal openings on line z=k (door slab spans one x cell)
    for k in 1..h {
        let mut x = 0;
        while x < w {
            if is_opening(kind(x, k - 1), kind(x, k)) {
                let x0 = x;
                while x < w && is_opening(kind(x, k - 1), kind(x, k)) {
                    x += 1;
                }
                if x - x0 == 1 {
                    add_door(&mut doors, rng, Vec3::new(x0 as f32, 0.0, k as f32), [x0 as f32, k as f32 - T, (x0 + 1) as f32, k as f32 + T]);
                }
            } else {
                x += 1;
            }
        }
    }

    // ---- one warm-white ceiling lamp per room (point lights, no emissive prims
    // → NEE slot order == spec order, which join_game_lights asserts) ----
    let lights: Vec<LightSpec> = rooms
        .iter()
        .enumerate()
        .map(|(ri, _)| LightSpec { id: LightId(ri as u32), room: RoomId(ri as u32), kind: LightKind::Incandescent, base_rgb: [1.0, 0.96, 0.9], name: format!("cave_lamp_{ri}") })
        .collect();

    LevelSpec { rooms: room_specs, static_solids: solids, doors, lights, targets: Vec::new(), items: Vec::new(), survival: None, mobs: Vec::new(), traps: Vec::new(), player_start, seed }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Same seed ⇒ byte-identical spec (the determinism the lab/headless paths
    /// rely on). Different seeds ⇒ different layouts.
    #[test]
    fn deterministic_in_seed() {
        let a = cave_level(7);
        let b = cave_level(7);
        assert_eq!(a.static_solids, b.static_solids);
        assert_eq!(a.rooms.len(), b.rooms.len());
        assert_eq!(a.doors.len(), b.doors.len());
        assert_eq!(a.player_start, b.player_start);
        let c = cave_level(8);
        assert!(a.static_solids != c.static_solids, "seed 7 and 8 should differ");
    }

    /// Every room is reachable from the player's spawn over the floor cells — the
    /// spanning-tree corridors must actually connect the whole dungeon. Flood
    /// fill the carved grid and assert no room centre is stranded.
    #[test]
    fn all_rooms_are_connected() {
        let p = CaveParams::default();
        // re-derive the floor grid the way the generator does, from the spec's
        // room+corridor rects (a black-box reachability check).
        let spec = cave_level_with(7, p);
        let (w, h) = (p.grid_w, p.grid_h);
        let mut floor = vec![false; (w * h) as usize];
        for r in &spec.rooms {
            let fr = r.floor_rect;
            for z in fr[1] as i32..fr[3] as i32 {
                for x in fr[0] as i32..fr[2] as i32 {
                    floor[(z * w + x) as usize] = true;
                }
            }
        }
        // flood fill from the spawn cell
        let start = ((spec.player_start.z as i32) * w + spec.player_start.x as i32) as usize;
        assert!(floor[start], "spawn cell must be floor");
        let mut seen = vec![false; (w * h) as usize];
        let mut stack = vec![start];
        seen[start] = true;
        while let Some(c) = stack.pop() {
            let (cx, cz) = ((c as i32) % w, (c as i32) / w);
            for (dx, dz) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                let (nx, nz) = (cx + dx, cz + dz);
                if (0..w).contains(&nx) && (0..h).contains(&nz) {
                    let n = (nz * w + nx) as usize;
                    if floor[n] && !seen[n] {
                        seen[n] = true;
                        stack.push(n);
                    }
                }
            }
        }
        // every NON-corridor room's centre cell must be reached
        for r in spec.rooms.iter().filter(|r| r.id.0 < CORRIDOR_ROOM_ID_BASE) {
            let fr = r.floor_rect;
            let (mx, mz) = (((fr[0] + fr[2]) * 0.5) as i32, ((fr[1] + fr[3]) * 0.5) as i32);
            assert!(seen[(mz * w + mx) as usize], "room {:?} at ({mx},{mz}) unreachable from spawn", r.id);
        }
    }

    /// Thick-rock mode emits unit (1×1 wu) blocks on the lattice, filling gaps
    /// only — never a room floor cell.
    #[test]
    fn thick_walls_are_unit_rock_blocks() {
        const STEP: f32 = 0.0625;
        let on = |v: f32| (v / STEP - (v / STEP).round()).abs() < 1e-4;
        let p = CaveParams { thick_walls: true, ..CaveParams::for_rooms(10, 3) };
        let spec = cave_level_with(2, p);
        assert!(!spec.static_solids.is_empty(), "thick mode must place rock blocks");
        let rooms: Vec<_> = spec.rooms.iter().filter(|r| r.id.0 < CORRIDOR_ROOM_ID_BASE).map(|r| r.floor_rect).collect();
        for s in &spec.static_solids {
            assert!((s[2] - s[0] - 1.0).abs() < 1e-4 && (s[3] - s[1] - 1.0).abs() < 1e-4, "thick wall not a 1×1 block: {s:?}");
            for v in *s {
                assert!(on(v), "block corner {v} off the lattice");
            }
            let (cx, cz) = ((s[0] + s[2]) * 0.5, (s[1] + s[3]) * 0.5);
            for r in &rooms {
                assert!(!(cx > r[0] && cx < r[2] && cz > r[1] && cz < r[3]), "rock block centre ({cx},{cz}) inside room {r:?}");
            }
        }
    }

    /// Rooms (not corridors) never overlap — rejection sampling holds.
    #[test]
    fn rooms_do_not_overlap() {
        let spec = cave_level(3);
        let rms: Vec<_> = spec.rooms.iter().filter(|r| r.id.0 < CORRIDOR_ROOM_ID_BASE).map(|r| r.floor_rect).collect();
        for (i, a) in rms.iter().enumerate() {
            for b in &rms[i + 1..] {
                let disjoint = a[2] <= b[0] || b[2] <= a[0] || a[3] <= b[1] || b[3] <= a[1];
                assert!(disjoint, "rooms {a:?} and {b:?} overlap");
            }
        }
    }

    /// Each door is a 0.25×1.0 wu leaf slab filling one room↔corridor opening,
    /// on the iso lattice, hinged centred across its thickness at one end of the
    /// gap (so build_game's place_door reconstructs the closed footprint).
    #[test]
    fn doors_are_one_cell_leaf_slabs() {
        const STEP: f32 = 0.0625;
        let on = |v: f32| (v / STEP - (v / STEP).round()).abs() < 1e-4;
        let p = CaveParams { door_chance: 1.0, ..CaveParams::for_rooms(10, 3) };
        let spec = cave_level_with(5, p);
        assert!(!spec.doors.is_empty(), "door_chance 1.0 must place doors");
        for d in &spec.doors {
            let s = d.closed_solid;
            let (w, h) = (s[2] - s[0], s[3] - s[1]);
            assert!((w.min(h) - 0.25).abs() < 1e-4 && (w.max(h) - 1.0).abs() < 1e-4, "door {:?}: want a 0.25×1.0 slab, got {w}×{h}", d.id);
            for v in s {
                assert!(on(v), "door {:?} corner {v} off the lattice", d.id);
            }
            if w < h {
                // vertical: hinge centred in x, at a z end
                assert!((d.hinge.x - (s[0] + s[2]) * 0.5).abs() < 1e-4, "door {:?} hinge x not on the wall line", d.id);
                assert!((d.hinge.z - s[1]).abs() < 1e-4 || (d.hinge.z - s[3]).abs() < 1e-4, "door {:?} hinge z not at a gap end", d.id);
            } else {
                assert!((d.hinge.z - (s[1] + s[3]) * 0.5).abs() < 1e-4, "door {:?} hinge z not on the wall line", d.id);
                assert!((d.hinge.x - s[0]).abs() < 1e-4 || (d.hinge.x - s[2]).abs() < 1e-4, "door {:?} hinge x not at a gap end", d.id);
            }
        }
    }

    /// All emitted XZ geometry lands on the iso 2:1 stair lattice (multiples of
    /// 0.0625 wu) — the native equivalent of the web `isoCleanGeometryValidator`
    /// (invariant #8). Room/corridor rects are integer; wall slabs are integer ±
    /// 0.125, both multiples of 0.0625.
    #[test]
    fn geometry_is_iso_stair_aligned() {
        const STEP: f32 = 0.0625;
        let on = |v: f32| (v / STEP - (v / STEP).round()).abs() < 1e-4;
        let spec = cave_level(11);
        for r in &spec.rooms {
            for v in r.floor_rect {
                assert!(on(v), "floor rect coord {v} off the 0.0625 lattice");
            }
        }
        for s in &spec.static_solids {
            for v in *s {
                assert!(on(v), "wall slab coord {v} off the 0.0625 lattice");
            }
        }
    }
}
