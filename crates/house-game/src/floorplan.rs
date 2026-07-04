//! floorplan — the bridge from a floor PLAN (rooms + doors, no walls) to a
//! PLAYABLE [`LevelSpec`] (walls + collision). This is the missing half the
//! believable-home generators ([`crate::building`]) deferred: they emit rooms
//! that tile a footprint plus door openings, but `static_solids: Vec::new()`,
//! so nothing encloses or collides.
//!
//! [`enclose`] fills that in, and is GENERAL over any generator that yields
//! non-overlapping axis-aligned room rectangles + door slabs (cave-style void
//! gaps, BSP homes, corridor buildings, or future plans). It builds the
//! rectilinear subdivision induced by the room edges — a grid of variable-size
//! cells, each entirely inside one room or the exterior void — and emits a wall
//! slab on every cell boundary where the room region CHANGES (room↔room
//! partitions, room↔void envelope), then subtracts the door openings. Nothing is
//! assumed about a uniform cell size, so finer/odd future grids work unchanged.
//!
//! Walls land on the iso 2:1 stair lattice as long as the plan's room edges do:
//! a boundary on a lattice line ± the 0.125 half-thickness stays a multiple of
//! 0.0625 (invariant #8). Pinned by the tests.

use crate::spec::{DoorSpec, LevelSpec, RoomSpec};

/// Wall-synthesis options.
#[derive(Clone, Copy, Debug)]
pub struct WallOpts {
    /// Full wall thickness in wu (default 0.25 = the kit's 32 cm wall).
    pub thickness: f32,
    /// Keep the plan's swinging `DoorSpec` leaves (closed, interactive). When
    /// false (the default) the leaves are dropped and every opening is a plain
    /// arch — the level is then walkable end-to-end with nothing to interact
    /// with, which is what the headless walkthrough capture wants.
    pub keep_door_leaves: bool,
}

impl Default for WallOpts {
    fn default() -> WallOpts {
        WallOpts { thickness: 0.25, keep_door_leaves: false }
    }
}

/// Region id of a subdivision cell: a room INDEX, or `VOID` for the exterior.
/// Only equality matters (a wall sits wherever neighbouring cells differ).
const VOID: i32 = i32::MIN;

/// Enclose a floor plan: derive the wall `static_solids` from the plan's rooms +
/// doors and return the playable spec. Rooms, lights, player_start, seed are
/// carried through untouched; door leaves are kept or dropped per `opts`.
pub fn enclose(mut plan: LevelSpec, opts: WallOpts) -> LevelSpec {
    let t = opts.thickness * 0.5;

    // ---- rectilinear subdivision: the sorted unique room-edge coordinates.
    let mut xs: Vec<f32> = plan.rooms.iter().flat_map(|r| [r.floor_rect[0], r.floor_rect[2]]).collect();
    let mut zs: Vec<f32> = plan.rooms.iter().flat_map(|r| [r.floor_rect[1], r.floor_rect[3]]).collect();
    dedup_sorted(&mut xs);
    dedup_sorted(&mut zs);
    if xs.len() < 2 || zs.len() < 2 {
        return plan; // degenerate / empty plan: nothing to enclose
    }
    let (nx, nz) = (xs.len() - 1, zs.len() - 1);

    // region of each cell, by its centre point (strictly inside one room or void)
    let mut cell = vec![VOID; nx * nz];
    for j in 0..nz {
        let cz = 0.5 * (zs[j] + zs[j + 1]);
        for i in 0..nx {
            let cx = 0.5 * (xs[i] + xs[i + 1]);
            cell[j * nx + i] = room_at(&plan.rooms, cx, cz);
        }
    }
    let reg = |i: i32, j: i32| -> i32 {
        if i < 0 || j < 0 || i >= nx as i32 || j >= nz as i32 {
            VOID
        } else {
            cell[j as usize * nx + i as usize]
        }
    };

    let mut walls: Vec<[f32; 4]> = Vec::new();

    // ---- vertical walls: on each x line, the z-runs where the region differs
    // across it, minus the door openings on that line.
    for (xi, &x) in xs.iter().enumerate() {
        let runs = boundary_runs(nz, &zs, |j| reg(xi as i32 - 1, j) != reg(xi as i32, j));
        for (z0, z1) in subtract(runs, &gaps_on(&plan.doors, Axis::X, x)) {
            walls.push([x - t, z0, x + t, z1]);
        }
    }
    // ---- horizontal walls: symmetric, on each z line across x.
    for (zj, &z) in zs.iter().enumerate() {
        let runs = boundary_runs(nx, &xs, |i| reg(i, zj as i32 - 1) != reg(i, zj as i32));
        for (x0, x1) in subtract(runs, &gaps_on(&plan.doors, Axis::Z, z)) {
            walls.push([x0, z - t, x1, z + t]);
        }
    }

    plan.static_solids = walls;
    if !opts.keep_door_leaves {
        plan.doors.clear();
    }
    plan
}

/// Index of the room containing point (x, z), or `VOID`. Strict interior test:
/// the callers only ever pass subdivision-cell centres, which lie strictly
/// inside exactly one room (or a gap), so boundaries never tie.
fn room_at(rooms: &[RoomSpec], x: f32, z: f32) -> i32 {
    for (i, r) in rooms.iter().enumerate() {
        let f = r.floor_rect;
        if x > f[0] && x < f[2] && z > f[1] && z < f[3] {
            return i as i32;
        }
    }
    VOID
}

/// Merge consecutive cells `[coords[k], coords[k+1]]` for which `is_wall(k)`
/// holds into maximal runs, returned as (lo, hi) intervals on the line.
fn boundary_runs(n: usize, coords: &[f32], is_wall: impl Fn(i32) -> bool) -> Vec<(f32, f32)> {
    let mut runs = Vec::new();
    let mut k = 0;
    while k < n {
        if is_wall(k as i32) {
            let lo = coords[k];
            let mut e = k;
            while e < n && is_wall(e as i32) {
                e += 1;
            }
            runs.push((lo, coords[e]));
            k = e;
        } else {
            k += 1;
        }
    }
    runs
}

enum Axis {
    X,
    Z,
}

/// Door openings (lo, hi) lying on the line `coord` of the given axis: a door is
/// matched to a vertical (X) line by the centre of its thin-in-x slab, to a
/// horizontal (Z) line by the centre of its thin-in-z slab.
fn gaps_on(doors: &[DoorSpec], axis: Axis, coord: f32) -> Vec<(f32, f32)> {
    doors
        .iter()
        .filter_map(|d| {
            let s = d.closed_solid;
            let (wx, wz) = (s[2] - s[0], s[3] - s[1]);
            match axis {
                Axis::X if wx <= wz => ((0.5 * (s[0] + s[2]) - coord).abs() < 1e-3).then_some((s[1], s[3])),
                Axis::Z if wz < wx => ((0.5 * (s[1] + s[3]) - coord).abs() < 1e-3).then_some((s[0], s[2])),
                _ => None,
            }
        })
        .collect()
}

/// Subtract the `gaps` from each wall run, returning the remaining solid
/// intervals (door openings punched out, slivers dropped).
fn subtract(runs: Vec<(f32, f32)>, gaps: &[(f32, f32)]) -> Vec<(f32, f32)> {
    let mut out = Vec::new();
    for (mut a, b) in runs {
        let mut gs: Vec<(f32, f32)> = gaps.iter().copied().filter(|g| g.1 > a && g.0 < b).collect();
        gs.sort_by(|p, q| p.0.partial_cmp(&q.0).unwrap());
        for (g0, g1) in gs {
            if g0 > a {
                out.push((a, g0));
            }
            a = a.max(g1);
        }
        if b > a {
            out.push((a, b));
        }
    }
    out.into_iter().filter(|(a, b)| b - a > 1e-4).collect()
}

fn dedup_sorted(v: &mut Vec<f32>) {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v.dedup_by(|a, b| (*a - *b).abs() < 1e-4);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::building::{building_floor, factory_floor, house_floor, BuildingParams};
    use crate::spec::{DoorId, RoomId};
    use glam::Vec3;

    fn inside_any_wall(walls: &[[f32; 4]], x: f32, z: f32) -> bool {
        walls.iter().any(|s| x >= s[0] && x <= s[2] && z >= s[1] && z <= s[3])
    }

    /// A minimal two-room plan: rooms A|B sharing the x=3 wall, one door at
    /// z[1,2]. Expect a perimeter ring + the shared partition with a gap exactly
    /// at the door (open), the rest of the partition solid.
    #[test]
    fn two_rooms_share_a_walled_partition_with_a_door_gap() {
        let plan = LevelSpec {
            rooms: vec![RoomSpec { id: RoomId(0), floor_rect: [0.0, 0.0, 3.0, 3.0] }, RoomSpec { id: RoomId(1), floor_rect: [3.0, 0.0, 6.0, 3.0] }],
            static_solids: vec![],
            doors: vec![DoorSpec { id: DoorId(0), hinge: Vec3::new(3.0, 0.0, 1.0), axis_y: 1.0, closed_solid: [2.875, 1.0, 3.125, 2.0], open_angle: 1.74, anim_ticks: 24, name: "d".into() }],
            lights: vec![],
            targets: vec![],
            items: vec![],
            survival: None,
            sterile: false,
            mobs: vec![],
            traps: vec![],
            arena: None,
            player_start: Vec3::ZERO,
            seed: 0,
        };
        let lvl = enclose(plan, WallOpts::default());
        assert!(!lvl.static_solids.is_empty());
        assert!(lvl.doors.is_empty(), "default drops leaves → arches");
        // the door centre is OPEN, the partition above/below it is SOLID
        assert!(!inside_any_wall(&lvl.static_solids, 3.0, 1.5), "door gap must be open");
        assert!(inside_any_wall(&lvl.static_solids, 3.0, 0.5), "partition below door is wall");
        assert!(inside_any_wall(&lvl.static_solids, 3.0, 2.5), "partition above door is wall");
        // perimeter is enclosed on all four sides (sample mid-edges, off the door)
        assert!(inside_any_wall(&lvl.static_solids, 0.0, 1.5), "west perimeter");
        assert!(inside_any_wall(&lvl.static_solids, 6.0, 1.5), "east perimeter");
        assert!(inside_any_wall(&lvl.static_solids, 1.5, 0.0), "north perimeter");
        assert!(inside_any_wall(&lvl.static_solids, 1.5, 3.0), "south perimeter");
    }

    /// Every believable generator becomes playable: walls appear, and each door
    /// opening is actually a gap (not sealed by a wall slab).
    #[test]
    fn believable_generators_get_walls_with_open_doors() {
        let plans = [house_floor(3), building_floor(3, BuildingParams::hospital()), building_floor(3, BuildingParams::office()), factory_floor(3)];
        for plan in plans {
            let doors = plan.doors.clone();
            let lvl = enclose(plan, WallOpts { keep_door_leaves: true, ..WallOpts::default() });
            assert!(!lvl.static_solids.is_empty(), "walls synthesized");
            for d in &doors {
                let s = d.closed_solid;
                let (cx, cz) = (0.5 * (s[0] + s[2]), 0.5 * (s[1] + s[3]));
                assert!(!inside_any_wall(&lvl.static_solids, cx, cz), "door {:?} opening must be clear of walls", d.id);
            }
        }
    }

    /// Synthesized walls stay on the iso 2:1 stair lattice (room edges are
    /// integer here, ±0.125 thickness keeps multiples of 0.0625) — invariant #8.
    #[test]
    fn walls_are_iso_stair_aligned() {
        const STEP: f32 = 0.0625;
        let on = |v: f32| (v / STEP - (v / STEP).round()).abs() < 1e-4;
        for seed in 1..8 {
            let lvl = enclose(house_floor(seed), WallOpts::default());
            for s in &lvl.static_solids {
                for v in *s {
                    assert!(on(v), "wall coord {v} off the lattice (seed {seed})");
                }
            }
        }
    }
}
