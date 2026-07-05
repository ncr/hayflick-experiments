//! Hand-authored "village" level — a couple of buildings on a central street,
//! emitted through the SAME grid→[`LevelSpec`] machinery as the cave generator
//! ([`crate::cave::emit_grid_spec`]), so it inherits the auto wall slabs AND the
//! dollhouse cut-aways for free (every floor↔void edge becomes a wall the iso
//! camera can see past).
//!
//! Unlike the cave the layout is DELIBERATE, not random. A straight road runs
//! west→east across the middle of the grid. The west building is a THREE-ROOM
//! house — three coloured rooms in a row, each separated from the next by an
//! interior wall with a one-cell doorway, the whole thing entered from the
//! street through a front doorway. The east building (south of the road) is a
//! single room, for village context. Openings are arches (no door leaves), so
//! the level is walkable end-to-end with nothing to interact with.
//!
//! Interior walls fall out of the grid for free: two rooms separated by a
//! one-cell void column get a wall on each room edge; a single carved "throat"
//! cell punched into that column is floor on both sides, so the emitter reads it
//! as a one-cell room↔room opening — a doorway. Because each such wall still has
//! void behind it, the dollhouse cull lets the camera see into every room.
//!
//! 1 grid cell = 1.0 wu (the wall-kit cell); every emitted coordinate lands on
//! the iso 2:1 stair lattice exactly as the cave does (pinned by the tests).

use crate::cave::{emit_grid_spec, Room};
use crate::spec::LevelSpec;
use glam::Vec3;

const GRID_W: i32 = 48;
const GRID_H: i32 = 24;

/// The street: a 3-cell-tall band (rows 12..15) spanning most of the width.
const ROAD_Z0: i32 = 12;
const ROAD_Z1: i32 = 15; // exclusive (rows 12, 13, 14)

/// Fill a room rectangle (cells) into the grid and register it; returns nothing
/// (the room index is just `rooms.len()` before the push). Free fns rather than
/// closures so the three buffers can be borrowed mutably without aliasing.
#[allow(clippy::too_many_arguments)] // grid buffers + a rect; a struct would just rename the args
fn add_room(floor: &mut [bool], room_of: &mut [i32], rooms: &mut Vec<Room>, w: i32, x: i32, z: i32, rw: i32, rh: i32) {
    let ri = rooms.len() as i32;
    for zz in z..z + rh {
        for xx in x..x + rw {
            floor[(zz * w + xx) as usize] = true;
            room_of[(zz * w + xx) as usize] = ri;
        }
    }
    rooms.push(Room { x, z, w: rw, h: rh });
}

/// Carve one roomless throat cell (floor, `room_of` stays −1): a doorway sill
/// between two rooms, or between a room and the street.
fn throat(floor: &mut [bool], w: i32, x: i32, z: i32) {
    floor[(z * w + x) as usize] = true;
}

/// Build the village level. `seed` only rides into `LevelSpec.seed` (the layout
/// is fixed); the shared emitter takes `door_chance = 0` so every opening stays
/// an arch.
pub fn village_level(seed: u64) -> LevelSpec {
    let (w, h) = (GRID_W, GRID_H);
    let at = |x: i32, z: i32| (z * w + x) as usize;
    let mut floor = vec![false; (w * h) as usize];
    let mut room_of = vec![-1i32; (w * h) as usize];
    let mut rooms: Vec<Room> = Vec::new();

    // ---- the street: carved floor, roomless → renders as corridor stone.
    for z in ROAD_Z0..ROAD_Z1 {
        for x in 4..44 {
            floor[at(x, z)] = true;
        }
    }

    // ---- west building: a THREE-ROOM house north of the road. Rooms A|B|C in a
    // row at z[16,21], each 5×5 cells, separated by one-cell void columns (x=11
    // between A and B, x=17 between B and C). Internal throats at z=18 punch a
    // doorway through each divider; a front throat at (8,15) links room A to the
    // street.
    add_room(&mut floor, &mut room_of, &mut rooms, w, 6, 16, 5, 5); // A  cells x6..10
    add_room(&mut floor, &mut room_of, &mut rooms, w, 12, 16, 5, 5); // B  cells x12..16
    add_room(&mut floor, &mut room_of, &mut rooms, w, 18, 16, 5, 5); // C  cells x18..22
    throat(&mut floor, w, 8, 15); // street → A (front door)
    throat(&mut floor, w, 11, 18); // A ↔ B
    throat(&mut floor, w, 17, 18); // B ↔ C

    // ---- east building: a single room south of the road, for village context.
    add_room(&mut floor, &mut room_of, &mut rooms, w, 26, 5, 7, 6); // D  cells x26..32, z5..10
    throat(&mut floor, w, 29, 11); // street → D (front door)

    // spawn on the road, just in front of the three-room house's front door.
    let player_start = Vec3::new(8.5, 0.0, (ROAD_Z0 + ROAD_Z1) as f32 * 0.5);
    let mut rng = crate::cave::Rng(seed ^ 0x7111_7A6E_5EED_u64);
    emit_grid_spec(w, h, &floor, &room_of, &rooms, 0.0, false, &mut rng, player_start, seed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cave::CORRIDOR_ROOM_ID_BASE;

    /// Four coloured rooms (three in the west house + one east), arch-only.
    #[test]
    fn village_is_deterministic_and_doorless() {
        let a = village_level(1);
        let b = village_level(1);
        assert_eq!(a.static_solids, b.static_solids);
        assert!(a.doors.is_empty(), "village openings are arches, no leaves");
        let coloured = a.rooms.iter().filter(|r| r.id.0 < CORRIDOR_ROOM_ID_BASE).count();
        assert_eq!(coloured, 4, "three-room house + one single-room building");
        assert_eq!(a.lights.len(), 4, "one lamp per room");
    }

    /// All emitted XZ geometry lands on the iso 2:1 stair lattice (invariant #8),
    /// exactly like the cave — integer rects and integer±0.125 wall slabs.
    #[test]
    fn geometry_is_iso_stair_aligned() {
        const STEP: f32 = 0.0625;
        let on = |v: f32| (v / STEP - (v / STEP).round()).abs() < 1e-4;
        let spec = village_level(1);
        for r in &spec.rooms {
            for v in r.floor_rect {
                assert!(on(v), "floor rect coord {v} off the lattice");
            }
        }
        for s in &spec.static_solids {
            for v in *s {
                assert!(on(v), "wall slab coord {v} off the lattice");
            }
        }
    }

    /// Every room is reachable from the spawn across the carved floor — the
    /// throats actually connect the three house rooms to each other and the
    /// street, and the east building to the road. Flood-fill the implied grid.
    #[test]
    fn all_rooms_reachable_from_spawn() {
        let spec = village_level(1);
        let (w, h) = (GRID_W, GRID_H);
        let mut floor = vec![false; (w * h) as usize];
        for r in &spec.rooms {
            let fr = r.floor_rect;
            for z in fr[1] as i32..fr[3] as i32 {
                for x in fr[0] as i32..fr[2] as i32 {
                    floor[(z * w + x) as usize] = true;
                }
            }
        }
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
        for r in spec.rooms.iter().filter(|r| r.id.0 < CORRIDOR_ROOM_ID_BASE) {
            let fr = r.floor_rect;
            let (mx, mz) = (((fr[0] + fr[2]) * 0.5) as i32, ((fr[1] + fr[3]) * 0.5) as i32);
            assert!(seen[(mz * w + mx) as usize], "room {:?} unreachable from spawn", r.id);
        }
    }
}
