//! Shared, authored neighborhood parcels. Data is also included by the GPU
//! material shader, so growth boundaries and paved geometry cannot drift.
use super::grid::{CellKind, CellPos, Dir, EdgeKind, Grid};
use super::sim::{GymLevel, PaintEffect, PaintStroke, Plant, PlantKind};
#[derive(Clone, Copy, Debug)]
pub struct Area {
    pub kind: u32,
    pub rect: [f32; 4],
    pub exposure: u32,
}
pub fn areas() -> Vec<Area> {
    include_str!("../../../../assets/procedural/neighborhood.layout")
        .lines()
        .filter_map(|s| {
            s.trim()
                .strip_prefix("AREA(")
                .and_then(|s| s.strip_suffix(')'))
        })
        .map(|s| {
            let v: Vec<f32> = s
                .split(',')
                .map(|n| n.trim().parse().expect("layout number"))
                .collect();
            assert_eq!(v.len(), 6);
            Area {
                kind: v[0] as u32,
                rect: [v[1], v[2], v[3], v[4]],
                exposure: v[5] as u32,
            }
        })
        .collect()
}
pub fn at(x: f32, z: f32) -> Option<Area> {
    areas()
        .into_iter()
        .rev()
        .find(|a| x >= a.rect[0] && z >= a.rect[1] && x < a.rect[2] && z < a.rect[3])
}
pub fn level() -> GymLevel {
    let mut grid = Grid::new(26, 23);
    for a in areas().iter().filter(|a| a.kind == 3) {
        let [x0, z0, x1, z1] = a.rect.map(|v| v as i16);
        for z in z0..z1 {
            for x in x0..x1 {
                grid.set_cell(CellPos::new(x, z), CellKind::Room);
            }
        }
        for x in x0..x1 {
            grid.set_edge(CellPos::new(x, z0), Dir::Zm, EdgeKind::Wall);
            grid.set_edge(CellPos::new(x, z1), Dir::Zm, EdgeKind::Wall);
        }
        for z in z0..z1 {
            grid.set_edge(CellPos::new(x0, z), Dir::Xm, EdgeKind::Wall);
            grid.set_edge(CellPos::new(x1, z), Dir::Xm, EdgeKind::Wall);
        }
        // Two-cell doors open onto the paths: southern door on north lots,
        // northern door on the southern lot. Collision and visible opening agree.
        let door = x0 + 3;
        let z = if z0 > 14 { z0 } else { z1 };
        for x in door..door + 2 {
            grid.set_edge(CellPos::new(x, z), Dir::Zm, EdgeKind::Open);
        }
    }
    GymLevel { ground: Vec::new(), plants: starting_plants(), paint: areas().iter().filter(|a| a.kind == 3).flat_map(history_strokes).collect(),
        neighborhood: true,
        grid,
        player_start: CellPos::new(12, 15),
        lights: vec![],
    }
}
/// The trees and bushes the street starts with — on open soil, off the
/// paving and the lots, clear of the spawn. Ordinary level data: creative
/// mode uproots and plants over them like any other.
fn starting_plants() -> Vec<Plant> {
    let tree = |x, z, seed| Plant { kind: PlantKind::Tree, x, z, seed };
    let bush = |x, z, seed| Plant { kind: PlantKind::Bush, x, z, seed };
    vec![
        tree(12.2, 4.0, 11),
        tree(24.0, 5.5, 23),
        tree(15.5, 20.0, 37),
        tree(22.5, 18.5, 41),
        tree(1.2, 20.5, 53),
        bush(10.5, 6.6, 61),
        bush(13.8, 7.2, 67),
        bush(23.0, 7.6, 71),
        bush(13.2, 17.6, 73),
        bush(2.8, 16.3, 79),
        bush(19.5, 21.8, 83),
        bush(17.2, 16.2, 89),
    ]
}

fn hash01(seed: u32, k: u32) -> f32 {
    let mut a = seed.wrapping_mul(0x9e37_79b9) ^ k.wrapping_mul(0x85eb_ca6b);
    a ^= a >> 16;
    a = a.wrapping_mul(0x7feb_352d);
    a ^= a >> 15;
    (a & 0xff_ffff) as f32 / 16_777_215.0
}

/// A dwelling lot's authored HISTORY written as ordinary brush strokes
/// (2026-09-22). The lot's exposure code — 2 corrosion, 3 fire, 4 blast —
/// used to select a branch in a shader; now it selects a preset of rain,
/// soot and spall dabs on the lot's walls, so the houses are painted with the
/// SAME brushes the owner holds in creative mode: they can be scrubbed,
/// painted over and undone like any stroke, and saved as level data.
///
/// Strokes go on both faces of each of the lot's four walls (the open front
/// shows the interiors). Window slots follow the facade's rule (every 2.4 wu
/// from 1.1 on a run of 3 wu or more) so craters avoid the openings, and a
/// fire's smoke leaves through the window heads.
pub fn history_strokes(a: &Area) -> Vec<PaintStroke> {
    let [x0, z0, x1, z1] = a.rect;
    let seed = ((x0 * 7.0 + z0 * 13.0) as u32) ^ a.exposure.wrapping_mul(977);
    // one draw sequence shared by every helper below (a Cell, so the draw
    // closure is `Fn` and the site picker can hold it too)
    let k = std::cell::Cell::new(0u32);
    let rnd = || {
        k.set(k.get() + 1);
        hash01(seed, k.get())
    };
    let mut out = Vec::new();
    // (along x?, the wall line, the OUTWARD normal sign)
    for (along_x, line, out_sign) in [(true, z0, -1i8), (true, z1, 1), (false, x0, -1), (false, x1, 1)] {
        let (start, len) = if along_x { (x0, x1 - x0) } else { (z0, z1 - z0) };
        let windows: Vec<f32> = if len >= 3.0 { (0..((len - 1.0) / 2.4) as usize).map(|i| 1.1 + i as f32 * 2.4).collect() } else { Vec::new() };
        // only the crater CENTRE must stay off an opening: a crater wrapping a
        // window's edge is exactly what a real facade shows, and the cut takes
        // the opening out of it anyway
        let in_window = |u: f32, v: f32| v > 0.9 && v < 2.25 && windows.iter().any(|w| (u - w).abs() < 0.45);
        for sign in [out_sign, -out_sign] {
            let outside = sign == out_sign;
            let plane = line + sign as f32 * 0.1;
            let axis = if along_x { 2 } else { 0 };
            let mut push = |effect, u: f32, v: f32, r: f32| {
                let pos = if along_x { [start + u, v, plane] } else { [plane, v, start + u] };
                out.push(PaintStroke { effect, pos, axis, sign, r });
            };
            // every house stood through the rain: water from the crown, the
            // whole length, on both faces (lighter inside, under the roof)
            // — in RUNS where the crown leaks, not the whole length: water
            // everywhere reads as a fluted wall, not a wet one
            let mut u = 0.15;
            while u < len - 0.1 {
                let run = 0.6 + rnd() * 1.4;
                if rnd() > if outside { 0.45 } else { 0.75 } {
                    let mut t = u;
                    while t < (u + run).min(len - 0.1) {
                        push(PaintEffect::Rain, t, 3.05, 0.42);
                        t += 0.3;
                    }
                }
                u += run + 0.3;
            }
            // a spot for a crater: off the window openings, off the ends
            let site = |v0: f32, v1: f32| -> Option<(f32, f32)> {
                for _ in 0..12 {
                    let (u, v) = (0.5 + rnd() * (len - 1.0), v0 + rnd() * (v1 - v0));
                    if !in_window(u, v) {
                        return Some((u, v));
                    }
                }
                None
            };
            match a.exposure {
                // CORROSION: the cover blown off the rusting mat in broad
                // patches, low and mid-height where water sits longest
                2 => {
                    let n = if outside { 2 + (len / 2.5) as usize } else { 1 };
                    for _ in 0..n {
                        if let Some((u, v)) = site(0.5, 1.9) {
                            push(PaintEffect::Spall, u, v, 0.9 + 0.5 * rnd());
                        }
                    }
                }
                // FIRE: smoke out of every window head outside; inside, the
                // burning contents char the wall from the floor up; heat
                // spalls the cover and cracks the crown
                3 => {
                    if outside {
                        for w in &windows {
                            push(PaintEffect::Soot, *w, 2.1, 0.5);
                        }
                    } else {
                        let mut u = 0.4 + rnd();
                        while u < len - 0.3 {
                            push(PaintEffect::Soot, u, 0.35, 0.6 + 0.2 * rnd());
                            u += 0.9 + rnd() * 1.2;
                        }
                    }
                    for _ in 0..2 {
                        if let Some((u, v)) = site(0.8, 2.3) {
                            push(PaintEffect::Spall, u, v, 0.45 + 0.2 * rnd());
                        }
                    }
                    if outside && rnd() > 0.4 {
                        push(PaintEffect::Spall, 0.6 + rnd() * (len - 1.2), 3.15, 0.55);
                    }
                }
                // BLAST: the impact tears the crown off and blows a cluster of
                // craters around it, scorched, from the street side
                _ => {
                    let cu = len * (0.25 + 0.5 * rnd());
                    if outside {
                        push(PaintEffect::Spall, cu, 3.2, 1.5 + 0.4 * rnd());
                        for _ in 0..4 {
                            let (u, v) = (cu + (rnd() - 0.5) * 2.2, 1.2 + rnd() * 1.4);
                            if !in_window(u, v) && u > 0.3 && u < len - 0.3 {
                                push(PaintEffect::Spall, u, v, 0.7 + 0.35 * rnd());
                            }
                        }
                        for _ in 0..3 {
                            push(PaintEffect::Soot, cu + (rnd() - 0.5) * 1.4, 1.2 + rnd() * 0.8, 0.55);
                        }
                    } else if let Some((u, v)) = site(1.0, 2.4) {
                        push(PaintEffect::Spall, u, v, 0.5);
                    }
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    /// Every lot's history lands as strokes on its own walls' faces, each
    /// exposure paints with its own brushes, and the level is deterministic.
    #[test]
    fn lot_histories_are_painted_strokes() {
        let l = level();
        assert!(!l.paint.is_empty());
        for a in areas().iter().filter(|a| a.kind == 3) {
            let s = history_strokes(a);
            let has = |e| s.iter().any(|p| p.effect == e);
            match a.exposure {
                2 => assert!(has(PaintEffect::Rain) && has(PaintEffect::Spall), "corrosion"),
                3 => assert!(has(PaintEffect::Soot), "fire"),
                _ => assert!(has(PaintEffect::Spall) && has(PaintEffect::Soot), "blast"),
            }
            for p in &s {
                let [x, _, z] = p.pos;
                let on_x = (p.axis == 0) && ((x - a.rect[0]).abs() < 0.11 || (x - a.rect[2]).abs() < 0.11);
                let on_z = (p.axis == 2) && ((z - a.rect[1]).abs() < 0.11 || (z - a.rect[3]).abs() < 0.11);
                assert!(on_x || on_z, "a stroke off its lot's walls: {p:?}");
            }
        }
        assert_eq!(level().paint, l.paint, "deterministic");
        for p in &l.plants {
            let a = at(p.x, p.z).map(|a| a.kind);
            assert_eq!(a, Some(0), "plant {p:?} stands on open soil");
        }
    }

    #[test]
    fn doors_join_houses_to_the_street() {
        let l = level();
        for a in areas().iter().filter(|a| a.kind == 3) {
            let x = a.rect[0] as i16 + 3;
            let z = if a.rect[1] > 14.0 {
                a.rect[1]
            } else {
                a.rect[3]
            } as i16;
            assert!(l.grid.open(CellPos::new(x, z - 1), Dir::Zp));
            assert_eq!(at(x as f32 + 0.5, 12.0).unwrap().kind, 1);
        }
    }
}
