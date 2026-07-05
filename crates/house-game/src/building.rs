//! building — a *realistic interior floor plan* generator (the successor to the
//! cave generator's scattered-rooms-and-tunnels look). Rooms PARTITION a
//! contiguous building footprint and line a circulation network — reading as a
//! hospital ward / office floor — rather than floating in void joined by 1-wide
//! tunnels.
//!
//! Model: a main corridor across the long axis, optionally crossed by a
//! perpendicular corridor (a `+`/`T` giving secondary exits). The room bands
//! either side are sliced into rooms of varied width; the entrance end gets an
//! enlarged LOBBY and one band hosts a tagged SERVICE core (stairs/WC). Every
//! room doors onto the corridor; the whole footprint is floor (no void). Emitted
//! as a [`LevelSpec`] for the shared `mapviz` renderer / future game path.
//! Interior partition WALLS + collision are a later pass.
//!
//! 1 grid cell = 1.0 wu, same lattice as the cave generator. Deterministic in
//! `seed`.

use crate::cave::{CORRIDOR_ROOM_ID_BASE, SERVICE_ROOM_ID_BASE};
use crate::spec::{DoorId, DoorSpec, LevelSpec, LightId, LightKind, LightSpec, RoomId, RoomSpec};
use glam::Vec3;

/// Floor-plan tunables, in tile cells. `kind` only tags the preset for display.
#[derive(Clone, Copy, Debug)]
pub struct BuildingParams {
    pub kind: &'static str,
    pub w: i32,          // footprint width (cells, the main corridor's long axis)
    pub h: i32,          // footprint depth (cells)
    pub corridor_w: i32, // corridor width
    pub room_min: i32,   // min room width along the corridor
    pub room_max: i32,   // max room width along the corridor
}

impl Default for BuildingParams {
    fn default() -> Self {
        BuildingParams::hospital()
    }
}

impl BuildingParams {
    /// Long double-loaded ward corridor: many narrow, uniform rooms both sides.
    pub fn hospital() -> Self {
        BuildingParams { kind: "hospital", w: 46, h: 16, corridor_w: 2, room_min: 3, room_max: 5 }
    }
    /// Shorter floor, wider and more varied rooms (offices / suites).
    pub fn office() -> Self {
        BuildingParams { kind: "office", w: 38, h: 18, corridor_w: 2, room_min: 4, room_max: 7 }
    }
}

/// SplitMix64 — own deterministic stream (matches the cave generator's choice).
struct Rng(u64);
impl Rng {
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn range(&mut self, lo: i32, hi: i32) -> i32 {
        lo + (self.next_u64() % (hi - lo).max(1) as u64) as i32
    }
    fn chance(&mut self, num: u64, den: u64) -> bool {
        self.next_u64() % den < num
    }
}

const DOOR_OPEN: f32 = 1.745_329_3; // 100° in radians
const T: f32 = 0.125; // wall / leaf half-thickness (0.25 wu)

/// A planned room before id assignment.
struct Plan {
    x: i32,
    z: i32,
    w: i32,
    d: i32,
    on_top: bool, // sits above the main corridor (door on its bottom edge)
    service: bool,
}

/// Generate a building floor from `seed`.
pub fn building_floor(seed: u64, p: BuildingParams) -> LevelSpec {
    let mut rng = Rng(seed ^ 0xB011_D11A_F100_0001);
    let (w, h) = (p.w, p.h);
    let cw = p.corridor_w.clamp(1, (h - 6).max(1));

    // main horizontal corridor, off-centre so the two room bands differ in depth
    let cz0 = rng.range((h as f32 * 0.30) as i32, (h as f32 * 0.55) as i32 + 1).clamp(3, h - cw - 3);
    let cz1 = cz0 + cw;

    // optional perpendicular cross-corridor → secondary N/S circulation + exits
    let cross = if w >= 30 && rng.chance(3, 5) {
        Some(rng.range(w / 3, 2 * w / 3).clamp(p.room_max + 2, w - p.room_max - 2 - cw))
    } else {
        None
    };

    // x-spans of each band, split by the cross-corridor column
    let spans: Vec<(i32, i32)> = match cross {
        Some(xc) => vec![(0, xc), (xc + cw, w - (xc + cw))],
        None => vec![(0, w)],
    };

    let mut plans: Vec<Plan> = Vec::new();
    // top band: rooms above the corridor; lobby in the entrance (first) span
    for (si, &(x0, span)) in spans.iter().enumerate() {
        fill_span(&mut rng, &mut plans, x0, span, 0, cz0, true, &p, si == 0, false);
    }
    // bottom band: service core in the last span
    let last = spans.len() - 1;
    for (si, &(x0, span)) in spans.iter().enumerate() {
        fill_span(&mut rng, &mut plans, x0, span, cz1, h - cz1, false, &p, false, si == last);
    }

    // ---- assign ids & emit ----
    let mut rooms: Vec<RoomSpec> = Vec::new();
    let (mut nrm, mut svc) = (0u32, 0u32);
    for pl in &plans {
        let id = if pl.service {
            let id = SERVICE_ROOM_ID_BASE + svc;
            svc += 1;
            id
        } else {
            let id = nrm;
            nrm += 1;
            id
        };
        rooms.push(RoomSpec { id: RoomId(id), floor_rect: [pl.x as f32, pl.z as f32, (pl.x + pl.w) as f32, (pl.z + pl.d) as f32] });
    }
    let n_rooms = rooms.len();

    // corridors: main + cross stubs (above/below the main band, so nothing overlaps)
    let mut corr = 0u32;
    let push_corr = |rooms: &mut Vec<RoomSpec>, rect: [f32; 4], corr: &mut u32| {
        rooms.push(RoomSpec { id: RoomId(CORRIDOR_ROOM_ID_BASE + *corr), floor_rect: rect });
        *corr += 1;
    };
    push_corr(&mut rooms, [0.0, cz0 as f32, w as f32, cz1 as f32], &mut corr);
    if let Some(xc) = cross {
        push_corr(&mut rooms, [xc as f32, 0.0, (xc + cw) as f32, cz0 as f32], &mut corr);
        push_corr(&mut rooms, [xc as f32, cz1 as f32, (xc + cw) as f32, h as f32], &mut corr);
    }

    // ---- doors ----
    let mut doors: Vec<DoorSpec> = Vec::new();
    for pl in &plans {
        let cx = pl.x + pl.w / 2;
        let line = if pl.on_top { cz0 } else { cz1 };
        add_door(&mut doors, Vec3::new(cx as f32, 0.0, line as f32), [cx as f32, line as f32 - T, (cx + 1) as f32, line as f32 + T]);
    }
    // entrance: leaf at the left end of the main corridor
    add_door(&mut doors, Vec3::new(0.0, 0.0, cz0 as f32), [-T, cz0 as f32, T, cz1 as f32]);
    // cross-corridor exterior exits (top & bottom)
    if let Some(xc) = cross {
        let cxc = xc + cw / 2;
        add_door(&mut doors, Vec3::new(cxc as f32, 0.0, 0.0), [cxc as f32, -T, (cxc + 1) as f32, T]);
        add_door(&mut doors, Vec3::new(cxc as f32, 0.0, h as f32), [cxc as f32, h as f32 - T, (cxc + 1) as f32, h as f32 + T]);
    }

    let lights: Vec<LightSpec> = (0..n_rooms as u32)
        .map(|i| LightSpec { id: LightId(i), room: RoomId(i), kind: LightKind::Incandescent, base_rgb: [1.0, 0.96, 0.9], name: format!("floor_lamp_{i}") })
        .collect();

    LevelSpec {
        rooms,
        static_solids: Vec::new(), // v1: layout only; partition walls + collision deferred
        doors,
        lights,
        targets: Vec::new(),
        items: Vec::new(),
        survival: None,
        drain: None,
        low_solids: Vec::new(),
        sterile: false,
        mobs: Vec::new(),
        traps: Vec::new(),
        arena: None,
        player_start: Vec3::new(1.5, 0.0, (cz0 + cz1) as f32 * 0.5),
        seed,
    }
}

/// Slice one band-span `[x0, x0+span)` at depth band `[z0, z0+depth)` into rooms
/// of varied width, optionally enlarging a leading LOBBY and tagging a 2-wide
/// SERVICE core near the middle.
#[allow(clippy::too_many_arguments)]
fn fill_span(rng: &mut Rng, plans: &mut Vec<Plan>, x0: i32, span: i32, z0: i32, depth: i32, on_top: bool, p: &BuildingParams, lobby: bool, service: bool) {
    if span < p.room_min || depth < 2 {
        if span > 0 && depth >= 2 {
            plans.push(Plan { x: x0, z: z0, w: span, d: depth, on_top, service: false });
        }
        return;
    }
    // raw varied-width slots
    let mut slots: Vec<(i32, i32)> = Vec::new();
    let mut x = 0;
    while x < span {
        let rem = span - x;
        let mut wd = if rem <= p.room_max { rem } else { rng.range(p.room_min, p.room_max + 1) };
        if rem - wd < p.room_min {
            wd = rem; // absorb a would-be sliver
        }
        slots.push((x, wd));
        x += wd;
    }
    // lobby: merge leading slots into one wider room
    if lobby && slots.len() >= 2 {
        let target = (p.room_max + 2).min(span);
        let (mut acc, mut k) = (0, 0);
        while k < slots.len() && acc < target {
            acc += slots[k].1;
            k += 1;
        }
        let mut merged = vec![(0, acc)];
        merged.extend_from_slice(&slots[k..]);
        slots = merged;
    }
    // service: tag 2 consecutive middle slots
    let svc = if service && slots.len() >= 4 { Some(slots.len() / 2) } else { None };
    for (i, &(xo, wd)) in slots.iter().enumerate() {
        let is_svc = svc.is_some_and(|s| i == s || i == s + 1);
        plans.push(Plan { x: x0 + xo, z: z0, w: wd, d: depth, on_top, service: is_svc });
    }
}

fn add_door(doors: &mut Vec<DoorSpec>, hinge: Vec3, closed: [f32; 4]) {
    let id = doors.len() as u32;
    doors.push(DoorSpec { id: DoorId(id), hinge, axis_y: 1.0, closed_solid: closed, open_angle: DOOR_OPEN, anim_ticks: 24, name: format!("floor_door_{id}") });
}

fn uf_find(uf: &mut [usize], mut x: usize) -> usize {
    while uf[x] != x {
        uf[x] = uf[uf[x]];
        x = uf[x];
    }
    x
}

/// The 1-cell door between two wall-sharing rooms, or `None` if they don't share
/// a wall of length >= 1. Returns the closed-leaf footprint + hinge.
fn shared_door(a: &[i32; 4], b: &[i32; 4]) -> Option<([f32; 4], Vec3)> {
    let vshared = |l: &[i32; 4], r: &[i32; 4]| -> Option<([f32; 4], Vec3)> {
        if l[2] != r[0] {
            return None;
        }
        let (zlo, zhi) = (l[1].max(r[1]), l[3].min(r[3]));
        if zhi - zlo < 1 {
            return None;
        }
        let (line, zc) = (l[2] as f32, ((zlo + zhi) / 2) as f32);
        Some(([line - T, zc, line + T, zc + 1.0], Vec3::new(line, 0.0, zc)))
    };
    let hshared = |t: &[i32; 4], b: &[i32; 4]| -> Option<([f32; 4], Vec3)> {
        if t[3] != b[1] {
            return None;
        }
        let (xlo, xhi) = (t[0].max(b[0]), t[2].min(b[2]));
        if xhi - xlo < 1 {
            return None;
        }
        let (line, xc) = (t[3] as f32, ((xlo + xhi) / 2) as f32);
        Some(([xc, line - T, xc + 1.0, line + T], Vec3::new(xc, 0.0, line)))
    };
    vshared(a, b).or_else(|| vshared(b, a)).or_else(|| hshared(a, b)).or_else(|| hshared(b, a))
}

/// HOUSE floor: recursive binary space partition of a small footprint into rooms
/// of varied size that share walls; a spanning tree of inter-room doors (plus a
/// few extra) makes every room reachable; one perimeter room gets the front
/// door. No corridor — rooms open onto each other, the way a house plan reads.
pub fn house_floor(seed: u64) -> LevelSpec {
    let mut rng = Rng(seed ^ 0x4057_E0FF_0CE0_0001);
    let (w, h) = (rng.range(14, 19), rng.range(11, 15));
    let (room_min, room_max) = (3, 7);

    // BSP into leaf rooms
    let mut leaves: Vec<[i32; 4]> = Vec::new();
    let mut stack = vec![[0, 0, w, h]];
    while let Some(r) = stack.pop() {
        let long = (r[2] - r[0]).max(r[3] - r[1]);
        let can = long > 2 * room_min;
        let must = long > room_max;
        if can && (must || rng.chance(3, 5)) {
            if r[2] - r[0] >= r[3] - r[1] {
                let cut = rng.range(r[0] + room_min, r[2] - room_min + 1);
                stack.push([r[0], r[1], cut, r[3]]);
                stack.push([cut, r[1], r[2], r[3]]);
            } else {
                let cut = rng.range(r[1] + room_min, r[3] - room_min + 1);
                stack.push([r[0], r[1], r[2], cut]);
                stack.push([r[0], cut, r[2], r[3]]);
            }
        } else {
            leaves.push(r);
        }
    }

    let rooms: Vec<RoomSpec> = leaves.iter().enumerate().map(|(i, &r)| RoomSpec { id: RoomId(i as u32), floor_rect: [r[0] as f32, r[1] as f32, r[2] as f32, r[3] as f32] }).collect();

    // doors: spanning tree over wall-sharing pairs, plus ~1/4 of the rest
    let n = leaves.len();
    let mut uf: Vec<usize> = (0..n).collect();
    let mut doors: Vec<DoorSpec> = Vec::new();
    for i in 0..n {
        for j in i + 1..n {
            if let Some((closed, hinge)) = shared_door(&leaves[i], &leaves[j]) {
                let (ri, rj) = (uf_find(&mut uf, i), uf_find(&mut uf, j));
                if ri != rj {
                    uf[ri] = rj;
                    add_door(&mut doors, hinge, closed);
                } else if rng.chance(1, 4) {
                    add_door(&mut doors, hinge, closed);
                }
            }
        }
    }

    // front door: the widest room on the front (z=h) wall
    let entry = leaves.iter().enumerate().filter(|(_, r)| r[3] == h).max_by_key(|(_, r)| r[2] - r[0]).map(|(i, _)| i).unwrap_or(0);
    let e = leaves[entry];
    let exc = ((e[0] + e[2]) / 2) as f32;
    add_door(&mut doors, Vec3::new(exc, 0.0, h as f32), [exc, h as f32 - T, exc + 1.0, h as f32 + T]);

    let lights: Vec<LightSpec> = (0..n as u32).map(|i| LightSpec { id: LightId(i), room: RoomId(i), kind: LightKind::Incandescent, base_rgb: [1.0, 0.96, 0.9], name: format!("house_lamp_{i}") }).collect();

    LevelSpec { rooms, static_solids: Vec::new(), doors, lights, targets: Vec::new(), items: Vec::new(), survival: None, drain: None,
        low_solids: Vec::new(),
        sterile: false, mobs: Vec::new(), traps: Vec::new(), arena: None, player_start: Vec3::new(exc + 0.5, 0.0, h as f32 - 1.5), seed }
}

/// FACTORY floor: one big open production HALL plus a strip of offices down one
/// side, fed by a service corridor. Hall = room 0; offices line the corridor;
/// the corridor opens into the hall; the hall has an exterior bay door.
pub fn factory_floor(seed: u64) -> LevelSpec {
    let mut rng = Rng(seed ^ 0xFAC0_24FF_0000_0001);
    let (w, h) = (rng.range(32, 42), rng.range(18, 26));
    let ow = rng.range(10, 14); // office strip width (incl. corridor)
    let cw = 2; // service corridor width, on the strip's inner edge
    let ax1 = ow - cw; // office right edge / corridor left edge

    let mut rooms: Vec<RoomSpec> = vec![RoomSpec { id: RoomId(0), floor_rect: [ow as f32, 0.0, w as f32, h as f32] }]; // the hall
    let mut doors: Vec<DoorSpec> = Vec::new();

    // offices: slice the [0, ax1) strip along z
    let mut z = 0;
    let mut oid = 1u32;
    while z < h {
        let rem = h - z;
        let mut hh = if rem <= 6 { rem } else { rng.range(3, 7) };
        if rem - hh < 3 {
            hh = rem;
        }
        rooms.push(RoomSpec { id: RoomId(oid), floor_rect: [0.0, z as f32, ax1 as f32, (z + hh) as f32] });
        let zc = (z + hh / 2) as f32;
        add_door(&mut doors, Vec3::new(ax1 as f32, 0.0, zc), [ax1 as f32 - T, zc, ax1 as f32 + T, zc + 1.0]); // office -> corridor
        oid += 1;
        z += hh;
    }
    // service corridor
    rooms.push(RoomSpec { id: RoomId(CORRIDOR_ROOM_ID_BASE), floor_rect: [ax1 as f32, 0.0, ow as f32, h as f32] });
    let hz = (h / 2) as f32;
    add_door(&mut doors, Vec3::new(ow as f32, 0.0, hz), [ow as f32 - T, hz, ow as f32 + T, hz + 1.0]); // corridor -> hall
    add_door(&mut doors, Vec3::new(w as f32, 0.0, hz), [w as f32 - T, hz, w as f32 + T, hz + 1.0]); // hall bay door (exterior)

    let lights: Vec<LightSpec> = (0..oid).map(|i| LightSpec { id: LightId(i), room: RoomId(i), kind: LightKind::Incandescent, base_rgb: [1.0, 0.97, 0.92], name: format!("factory_lamp_{i}") }).collect();

    LevelSpec { rooms, static_solids: Vec::new(), doors, lights, targets: Vec::new(), items: Vec::new(), survival: None, drain: None,
        low_solids: Vec::new(),
        sterile: false, mobs: Vec::new(), traps: Vec::new(), arena: None, player_start: Vec3::new(((ow + w) / 2) as f32, 0.0, hz), seed }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_in_seed() {
        let a = building_floor(7, BuildingParams::hospital());
        let b = building_floor(7, BuildingParams::hospital());
        assert_eq!(a.rooms.len(), b.rooms.len());
        assert_eq!(a.doors.len(), b.doors.len());
    }

    /// Rooms (incl. corridors + service) must TILE the footprint with no gaps or
    /// overlaps — the core "parts of a floor" property the cave generator lacked.
    #[test]
    fn rooms_tile_the_footprint_with_no_gaps() {
        for seed in 1..12 {
            for p in [BuildingParams::hospital(), BuildingParams::office()] {
                let spec = building_floor(seed, p);
                let mut cover = vec![0u8; (p.w * p.h) as usize];
                for r in &spec.rooms {
                    let f = r.floor_rect;
                    for z in f[1] as i32..f[3] as i32 {
                        for x in f[0] as i32..f[2] as i32 {
                            cover[(z * p.w + x) as usize] += 1;
                        }
                    }
                }
                assert!(cover.iter().all(|&c| c == 1), "seed {seed} {}: every cell covered exactly once", p.kind);
            }
        }
    }

    /// Every room (rooms + service, not corridors) has its own door.
    #[test]
    fn every_room_has_a_door() {
        let spec = building_floor(5, BuildingParams::office());
        let n_rooms = spec.rooms.iter().filter(|r| r.id.0 < CORRIDOR_ROOM_ID_BASE).count();
        assert!(spec.doors.len() >= n_rooms, "at least one door per room");
    }

    fn tiles_exactly(spec: &LevelSpec) -> bool {
        let b = spec.floor_bounds();
        let (w, h) = (b[2] as i32, b[3] as i32);
        let mut cover = vec![0u8; (w * h) as usize];
        for r in &spec.rooms {
            let f = r.floor_rect;
            for z in f[1] as i32..f[3] as i32 {
                for x in f[0] as i32..f[2] as i32 {
                    cover[(z * w + x) as usize] += 1;
                }
            }
        }
        cover.iter().all(|&c| c == 1)
    }

    /// House BSP tiles the footprint, and has at least a spanning tree of doors
    /// (n-1 interior + 1 front) so every room is reachable.
    #[test]
    fn house_tiles_and_is_connected() {
        for seed in 1..12 {
            let spec = house_floor(seed);
            assert!(tiles_exactly(&spec), "house seed {seed} tiles with no gaps/overlaps");
            assert!(spec.doors.len() >= spec.rooms.len(), "house seed {seed}: spanning tree + front door");
        }
    }

    /// Factory tiles: offices strip + service corridor + one big hall.
    #[test]
    fn factory_tiles() {
        for seed in 1..12 {
            let spec = factory_floor(seed);
            assert!(tiles_exactly(&spec), "factory seed {seed} tiles with no gaps/overlaps");
        }
    }

    #[test]
    fn geometry_is_iso_stair_aligned() {
        const STEP: f32 = 0.0625;
        let on = |v: f32| (v / STEP - (v / STEP).round()).abs() < 1e-4;
        let spec = building_floor(11, BuildingParams::hospital());
        for r in &spec.rooms {
            for v in r.floor_rect {
                assert!(on(v), "room rect coord {v} off the lattice");
            }
        }
        for d in &spec.doors {
            for v in d.closed_solid {
                assert!(on(v), "door coord {v} off the lattice");
            }
        }
    }
}
