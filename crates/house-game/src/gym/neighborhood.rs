//! Shared, authored neighborhood parcels. Data is also included by the GPU
//! material shader, so growth boundaries and paved geometry cannot drift.
use super::grid::{CellKind, CellPos, Dir, EdgeKind, Grid};
use super::sim::GymLevel;
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
    GymLevel {
        neighborhood: true,
        grid,
        player_start: CellPos::new(12, 15),
        lights: vec![],
    }
}
#[cfg(test)]
mod tests {
    use super::*;
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
