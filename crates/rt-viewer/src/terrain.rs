//! The street's ground and building details, built from LEVEL DATA
//! (2026-09-23): floor rectangles (road, sidewalk, soil — later over
//! earlier), potholes, window openings, roofs; a building's Room cells are
//! slab floor, and its lintels and corner columns follow from its walls.
//! Before this, all of it came from a compile-time layout file baked into the
//! shader, so none of it could be built from an empty level.
use crate::concrete::{self, hash, noise, Exposure, Mesh};
use glam::{Vec2, Vec3};
use house_game::gym::grid::{CellKind, CellPos, EdgeKind};
use house_game::gym::sim::{FloorKind, GymLevel};
use rt_probe::Scene;

/// Ground surface kinds, as the shade pass's `terrainParcel` reads them from
/// the density map's byte 2 (low two bits).
pub const SOIL: u8 = 0;
pub const ROAD: u8 = 1;
pub const WALK: u8 = 2;
pub const SLAB: u8 = 3;

/// The surface kind at a world point: a Room cell is slab floor, else the
/// LAST floor rectangle covering the point, else open soil.
pub fn kind_at(spec: &GymLevel, x: f32, z: f32) -> u8 {
    let c = CellPos::new(x.floor() as i16, z.floor() as i16);
    if spec.grid.in_bounds(c) && spec.grid.cell(c) == CellKind::Room {
        return SLAB;
    }
    spec.floors
        .iter()
        .rev()
        .find(|f| x >= f.rect[0] && z >= f.rect[1] && x < f.rect[2] && z < f.rect[3])
        .map_or(SOIL, |f| match f.kind {
            FloorKind::Soil => SOIL,
            FloorKind::Road => ROAD,
            FloorKind::Walk => WALK,
        })
}

/// Half-wu cells: the resolution the surface kinds are resolved at.
const CELL: f32 = 0.5;

/// The level's paved surfaces as maximal rectangles per kind (rows of equal
/// kind merged, then equal rows stacked) — the ground mesh is built per
/// rectangle, and a sidewalk's pour joints restart at each one.
pub fn surface_rects(spec: &GymLevel) -> Vec<(u8, [f32; 4])> {
    let (w, h) = ((spec.grid.w as f32 / CELL) as usize, (spec.grid.h as f32 / CELL) as usize);
    let kind: Vec<u8> = (0..w * h).map(|k| kind_at(spec, ((k % w) as f32 + 0.5) * CELL, ((k / w) as f32 + 0.5) * CELL)).collect();
    let mut used = vec![false; w * h];
    let mut out = Vec::new();
    for j in 0..h {
        for i in 0..w {
            let k = kind[j * w + i];
            if k == SOIL || used[j * w + i] {
                continue;
            }
            let mut i1 = i;
            while i1 < w && kind[j * w + i1] == k && !used[j * w + i1] {
                i1 += 1;
            }
            let mut j1 = j + 1;
            while j1 < h && (i..i1).all(|x| kind[j1 * w + x] == k && !used[j1 * w + x]) {
                j1 += 1;
            }
            for y in j..j1 {
                for x in i..i1 {
                    used[y * w + x] = true;
                }
            }
            out.push((k, [i as f32 * CELL, j as f32 * CELL, i1 as f32 * CELL, j1 as f32 * CELL]));
        }
    }
    out
}

fn mat(s: &mut Scene, kind: u32, e: u32) -> i32 {
    let id = concrete::material(s, Exposure::Rain, kind, 47 + e);
    let m = &mut s.materials[id as usize];
    m.base_color[3] = (kind * 8 + e) as f32;
    m.base_color[..3].copy_from_slice(match kind {
        4 => &[0.045, 0.043, 0.038],
        5 => &[0.25, 0.245, 0.22],
        _ => &[0.12, 0.10, 0.067],
    });
    m._pad = crate::flags::CONCRETE;
    id
}
fn quad(m: &mut Mesh, a: Vec3, b: Vec3, c: Vec3, d: Vec3, loss: [f32; 4]) {
    m.tri(a, c, b, [loss[0], loss[2], loss[1]]);
    m.tri(b, c, d, [loss[1], loss[2], loss[3]]);
}
/// How deep the road is holed at a point, 0..1 (the level's potholes, with a
/// broken rim).
pub fn pothole(spec: &GymLevel, p: Vec2) -> f32 {
    spec.potholes
        .iter()
        .map(|h| ((1.0 - p.distance(Vec2::new(h[0], h[1])) / h[2]) * 3.0 + 0.2 * (noise(p * 9.0, 33) - 0.5)).clamp(0.0, 1.0))
        .fold(0.0, f32::max)
}

/// The visible support height, shared by placement and the articulated rig.
pub fn height_at(spec: &GymLevel, p: Vec2) -> f32 {
    let kind = kind_at(spec, p.x, p.y);
    if kind == SOIL {
        return -0.075;
    }
    if kind == ROAD {
        return -0.012 - pothole(spec, p) * 0.052 + 0.003 * noise(p * 4.0, 11);
    }
    let Some((_, rect)) = surface_rects(spec).into_iter().find(|(_, r)| p.x >= r[0] && p.y >= r[1] && p.x < r[2] && p.y < r[3]) else {
        return -0.075;
    };
    let step = if kind == SLAB { 2.0 } else { 1.5 };
    let x0 = rect[0] + ((p.x - rect[0]) / step).floor() * step;
    let z0 = rect[1] + ((p.y - rect[1]) / step).floor() * step;
    let r = [x0 + 0.018, z0 + 0.018, (x0 + step).min(rect[2]) - 0.018, (z0 + step).min(rect[3]) - 0.018];
    let seed = (r[0] * 103.0 + r[1] * 317.0) as u32;
    let x = (p.x - r[0]) / (r[2] - r[0]);
    let z = (p.y - r[1]) / (r[3] - r[1]);
    let dx = if hash(1, 1, seed) > 0.5 { x } else { 1.0 - x };
    let dz = if hash(2, 1, seed) > 0.5 { z } else { 1.0 - z };
    let dist = (dx - 0.1).abs() * 0.8 + (dz - 0.2).abs();
    let loss = if hash(0, 0, seed) > 0.48 && kind != SLAB {
        ((0.75 - dist) * 9.0 + 0.4 * (noise(Vec2::new(x, z) * 13.0, seed) - 0.5)).clamp(0.0, 1.0)
    } else {
        0.0
    };
    if loss > 0.90 {
        return -0.075;
    }
    crate::gym_scene::FLOOR_TOP + (hash(0, 1, seed) - 0.5) * 0.045 * x - loss * 0.106
}
pub fn ground(s: &mut Scene, spec: &GymLevel) {
    let soil = mat(s, 6, 1);
    let road = mat(s, 4, 4);
    let slab = mat(s, 5, 2);
    let (w, h) = (spec.grid.w as f32, spec.grid.h as f32);
    // One continuous soil layer remains below missing paving. No coplanar faces.
    let mut earth = Mesh::default();
    quad(&mut earth, Vec3::new(0.0, -0.075, 0.0), Vec3::new(w, -0.075, 0.0), Vec3::new(0.0, -0.075, h), Vec3::new(w, -0.075, h), [0.0; 4]);
    earth.emit(s, soil);
    for (kind, rect) in surface_rects(spec) {
        if kind == ROAD {
            let mut mesh = Mesh::default();
            let step = 0.2;
            let nx = ((rect[2] - rect[0]) / step).round() as i32;
            let nz = ((rect[3] - rect[1]) / step).round() as i32;
            let point = |i: i32, j: i32| {
                let p = Vec2::new(rect[0] + i as f32 * step, rect[1] + j as f32 * step);
                let loss = pothole(spec, p);
                (Vec3::new(p.x, -0.012 - loss * 0.052 + 0.003 * noise(p * 4.0, 11), p.y), loss * 0.1)
            };
            for j in 0..nz {
                for i in 0..nx {
                    let p = [point(i, j), point(i + 1, j), point(i, j + 1), point(i + 1, j + 1)];
                    quad(&mut mesh, p[0].0, p[1].0, p[2].0, p[3].0, p.map(|p| p.1));
                }
            }
            mesh.emit(s, road);
        } else {
            // Individual 5-foot sidewalk pours with real joints and missing
            // corners. Building floors use larger, less damaged pours.
            let step = if kind == SLAB { 2.0 } else { 1.5 };
            let mut x = rect[0];
            while x < rect[2] - 0.01 {
                let mut z = rect[1];
                while z < rect[3] - 0.01 {
                    panel(s, [x + 0.018, z + 0.018, (x + step).min(rect[2]) - 0.018, (z + step).min(rect[3]) - 0.018], slab, kind == SLAB);
                    z += step;
                }
                x += step;
            }
        }
    }
}
fn panel(s: &mut Scene, r: [f32; 4], mat: i32, interior: bool) {
    let seed = (r[0] * 103.0 + r[1] * 317.0) as u32;
    let nx = ((r[2] - r[0]) / 0.12).ceil() as usize;
    let nz = ((r[3] - r[1]) / 0.12).ceil() as usize;
    let corner = hash(0, 0, seed) > 0.48 && !interior;
    let mut mesh = Mesh::default();
    let point = |i: usize, j: usize| {
        let x = i as f32 / nx as f32;
        let z = j as f32 / nz as f32;
        let dx = if hash(1, 1, seed) > 0.5 { x } else { 1.0 - x };
        let dz = if hash(2, 1, seed) > 0.5 { z } else { 1.0 - z };
        let dist = (dx - 0.1).abs() * 0.8 + (dz - 0.2).abs();
        let loss = if corner {
            ((0.75 - dist) * 9.0 + 0.4 * (noise(Vec2::new(x, z) * 13.0, seed) - 0.5))
                .clamp(0.0, 1.0)
        } else {
            0.0
        };
        let height =
            crate::gym_scene::FLOOR_TOP + (hash(0, 1, seed) - 0.5) * 0.045 * x - loss * 0.106;
        (
            Vec3::new(r[0] + x * (r[2] - r[0]), height, r[1] + z * (r[3] - r[1])),
            loss * 0.11,
        )
    };
    for j in 0..nz {
        for i in 0..nx {
            let p = [
                point(i, j),
                point(i + 1, j),
                point(i, j + 1),
                point(i + 1, j + 1),
            ];
            if !p.iter().all(|p| p.1 > 0.099) {
                quad(&mut mesh, p[0].0, p[1].0, p[2].0, p[3].0, p.map(|p| p.1));
            }
        }
    }
    // Sidewalls carry the pour thickness; they never float over their shadows.
    for j in 0..nz {
        for i in [0, nx] {
            let a = point(i, j).0;
            let b = point(i, j + 1).0;
            quad(
                &mut mesh,
                a,
                b,
                Vec3::new(a.x, -0.07, a.z),
                Vec3::new(b.x, -0.07, b.z),
                [0.08; 4],
            );
        }
    }
    for i in 0..nx {
        for j in [0, nz] {
            let a = point(i, j).0;
            let b = point(i + 1, j).0;
            quad(
                &mut mesh,
                a,
                b,
                Vec3::new(a.x, -0.07, a.z),
                Vec3::new(b.x, -0.07, b.z),
                [0.08; 4],
            );
        }
    }
    mesh.emit(s, mat);
}
/// Cut the level's window openings that lie on this wall run through every
/// primitive built since `first` (faces, caps and steel alike — a polygon
/// subtraction, so a bar is clipped at the opening instead of vanishing
/// whole) and set a thick sill in each. The PAINTED wall (painted.rs) is
/// built first and then cut here: the uv interpolates across the clip, so
/// the atlas texels stay put.
pub fn cut_windows(s: &mut Scene, first: usize, r: [f32; 4], along_x: bool, windows: &[[f32; 2]]) {
    let c = Vec2::new((r[0] + r[2]) * 0.5, (r[1] + r[3]) * 0.5);
    let (start, end) = if along_x { (r[0], r[2]) } else { (r[1], r[3]) };
    // a window is on this run when it sits on the wall line within the run
    let slots: Vec<f32> = windows
        .iter()
        .filter(|w| if along_x { (w[1] - c.y).abs() < 0.2 } else { (w[0] - c.x).abs() < 0.2 })
        .map(|w| if along_x { w[0] } else { w[1] })
        .filter(|&u| u - 0.48 > start + 0.05 && u + 0.48 < end - 0.05)
        .collect();
    if slots.is_empty() {
        return;
    }
    for k in first..s.primitives.len() {
        let p = s.primitives[k];
        let mut vertices = Vec::new();
        for tri in s.indices[p.index_offset as usize..(p.index_offset + p.index_count) as usize].as_chunks::<3>().0 {
            let triangle: Vec<_> = tri.iter().map(|&i| s.vertices[(p.vertex_offset + i) as usize]).collect();
            let mut polygons = vec![triangle];
            for u in &slots {
                polygons = polygons.into_iter().flat_map(|poly| subtract_window(poly, if along_x { 0 } else { 2 }, [u - 0.48, 1.0, u + 0.48, 2.15])).collect();
            }
            for poly in polygons {
                for i in 1..poly.len().saturating_sub(1) {
                    let [a, b, c] = [poly[0], poly[i], poly[i + 1]];
                    if (Vec3::from(b.pos) - Vec3::from(a.pos)).cross(Vec3::from(c.pos) - Vec3::from(a.pos)).length_squared() > 1e-14 {
                        vertices.extend([a, b, c]);
                    }
                }
            }
        }
        s.primitives[k].vertex_offset = s.vertices.len() as u32;
        s.primitives[k].vertex_count = vertices.len() as u32;
        s.primitives[k].index_offset = s.indices.len() as u32;
        s.primitives[k].index_count = vertices.len() as u32;
        s.indices.extend(0..vertices.len() as u32);
        s.vertices.extend(vertices);
    }
    let m = concrete::material(s, Exposure::Sound, 0, 123);
    for u in slots {
        let c = if along_x { Vec3::new(u, 0.96, c.y) } else { Vec3::new(c.x, 0.96, u) };
        let half = if along_x { Vec3::new(0.54, 0.065, 0.17) } else { Vec3::new(0.17, 0.065, 0.54) };
        let i = s.primitives.len();
        s.add_box_world(c - half, c + half, [0.23, 0.22, 0.19, 0.0], [0.0; 4], 0.95, 0.0);
        s.primitives[i].material_id = m;
    }
}
// Polygon subtraction clips even a long straight steel triangle at a window.
// A centroid test would erase a whole bar or leave it crossing the opening.
fn subtract_window(
    poly: Vec<rt_probe::scene::Vertex>,
    axis: usize,
    r: [f32; 4],
) -> Vec<Vec<rt_probe::scene::Vertex>> {
    let planes = [
        (axis, r[0], 1.0),
        (1, r[1], 1.0),
        (axis, r[2], -1.0),
        (1, r[3], -1.0),
    ];
    if planes
        .iter()
        .any(|(a, v, sign)| poly.iter().all(|p| (p.pos[*a] - v) * sign <= 0.0))
    {
        return vec![poly];
    }
    let mut remain = poly;
    let mut out = Vec::new();
    for (a, v, sign) in planes {
        let outside = clip_plane(&remain, a, v, -sign);
        if outside.len() >= 3 {
            out.push(outside);
        }
        remain = clip_plane(&remain, a, v, sign);
        if remain.len() < 3 {
            break;
        }
    }
    out
}
fn clip_plane(
    poly: &[rt_probe::scene::Vertex],
    axis: usize,
    value: f32,
    sign: f32,
) -> Vec<rt_probe::scene::Vertex> {
    let mut out = Vec::new();
    if poly.is_empty() {
        return out;
    }
    for i in 0..poly.len() {
        let a = poly[i];
        let b = poly[(i + 1) % poly.len()];
        let da = (a.pos[axis] - value) * sign;
        let db = (b.pos[axis] - value) * sign;
        if da >= 0.0 {
            out.push(a);
        }
        if (da > 0.0 && db < 0.0) || (da < 0.0 && db > 0.0) {
            let t = da / (da - db);
            let mut v = a;
            for k in 0..3 {
                v.pos[k] = a.pos[k] + t * (b.pos[k] - a.pos[k]);
                v.nrm[k] = a.nrm[k] + t * (b.nrm[k] - a.nrm[k]);
            }
            for k in 0..2 {
                v.uv[k] = a.uv[k] + t * (b.uv[k] - a.uv[k]);
            }
            out.push(v);
        }
    }
    out
}
/// A building's structural details, derived from its walls: a LINTEL over
/// every doorway (a 1-3 cell gap in a wall line that bounds a Room) and a
/// COLUMN at every corner where two walls of a building meet.
pub fn details(s: &mut Scene, spec: &GymLevel) {
    let g = &spec.grid;
    let m = concrete::material(s, Exposure::Rain, 0, 95);
    let block = |s: &mut Scene, lo: Vec3, hi: Vec3| {
        let i = s.primitives.len();
        s.add_box_world(lo, hi, [0.25, 0.24, 0.21, 0.0], [0.0; 4], 0.92, 0.0);
        s.primitives[i].material_id = m;
    };
    let room = |x: i16, z: i16| g.in_bounds(CellPos::new(x, z)) && g.cell(CellPos::new(x, z)) == CellKind::Room;
    let wall_z = |x: i16, z: i16| x >= 0 && x < g.w && z >= 0 && z <= g.h && g.edge_z(x, z) == EdgeKind::Wall;
    let wall_x = |x: i16, z: i16| x >= 0 && x <= g.w && z >= 0 && z < g.h && g.edge_x(x, z) == EdgeKind::Wall;
    // lintels: along z-lines (walls between rows) and x-lines
    for z in 0..=g.h {
        let mut x = 0;
        while x < g.w {
            if !wall_z(x, z) && (room(x, z) || room(x, z - 1)) && x > 0 && wall_z(x - 1, z) {
                let x0 = x;
                while x < g.w && !wall_z(x, z) && (room(x, z) || room(x, z - 1)) {
                    x += 1;
                }
                if x < g.w && wall_z(x, z) && x - x0 <= 3 {
                    block(s, Vec3::new(x0 as f32 - 0.1, 2.25, z as f32 - 0.12), Vec3::new(x as f32 + 0.1, 2.83, z as f32 + 0.12));
                }
            } else {
                x += 1;
            }
        }
    }
    for x in 0..=g.w {
        let mut z = 0;
        while z < g.h {
            if !wall_x(x, z) && (room(x, z) || room(x - 1, z)) && z > 0 && wall_x(x, z - 1) {
                let z0 = z;
                while z < g.h && !wall_x(x, z) && (room(x, z) || room(x - 1, z)) {
                    z += 1;
                }
                if z < g.h && wall_x(x, z) && z - z0 <= 3 {
                    block(s, Vec3::new(x as f32 - 0.12, 2.25, z0 as f32 - 0.1), Vec3::new(x as f32 + 0.12, 2.83, z as f32 + 0.1));
                }
            } else {
                z += 1;
            }
        }
    }
    // corner columns: a grid corner where an x-wall and a z-wall of a
    // building meet
    for z in 0..=g.h {
        for x in 0..=g.w {
            let xw = wall_x(x, z) || wall_x(x, z - 1);
            let zw = wall_z(x, z) || wall_z(x - 1, z);
            let building = room(x, z) || room(x - 1, z) || room(x, z - 1) || room(x - 1, z - 1);
            let straight = (wall_x(x, z) && wall_x(x, z - 1) && !zw) || (wall_z(x, z) && wall_z(x - 1, z) && !xw);
            if xw && zw && building && !straight {
                block(s, Vec3::new(x as f32 - 0.12, 0.0, z as f32 - 0.12), Vec3::new(x as f32 + 0.12, 3.23, z as f32 + 0.12));
            }
        }
    }
}

/// The level's broken roof slabs: flat at the crown over the rect, the +z
/// edge torn ragged (the open front of a collapsed room).
pub fn roofs(s: &mut Scene, spec: &GymLevel) {
    if spec.roofs.is_empty() {
        return;
    }
    let m = concrete::material(s, Exposure::Rain, 0, 81);
    let mut roof = Mesh::default();
    for &[x0, z0, x1, z1] in &spec.roofs {
        let step = 0.25;
        let mut x = x0;
        while x < x1 {
            let front = z1 - 0.35 + 0.65 * noise(Vec2::new(x, 0.0) * 2.0, 31);
            let y = 3.23;
            let xe = (x + step).min(x1);
            quad(&mut roof, Vec3::new(x, y - 0.16, front), Vec3::new(xe, y - 0.16, front), Vec3::new(x, y - 0.16, z0), Vec3::new(xe, y - 0.16, z0), [0.02; 4]);
            quad(&mut roof, Vec3::new(x, y, z0), Vec3::new(xe, y, z0), Vec3::new(x, y, front), Vec3::new(xe, y, front), [0.04; 4]);
            quad(&mut roof, Vec3::new(x, y, front), Vec3::new(xe, y, front), Vec3::new(x, y - 0.16, front), Vec3::new(xe, y - 0.16, front), [0.09; 4]);
            x += step;
        }
    }
    roof.emit(s, m);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clipping_a_long_triangle_keeps_its_surviving_area() {
        use rt_probe::scene::Vertex;
        let vertex = |x, y| Vertex {
            pos: [x, y, 0.0],
            nrm: [0.0, 0.0, 1.0],
            uv: [x, y],
        };
        let pieces = subtract_window(
            vec![vertex(0.0, 0.0), vertex(3.0, 0.0), vertex(0.0, 3.0)],
            0,
            [0.5, 0.5, 1.5, 1.5],
        );
        let mut area = 0.0;
        for poly in pieces {
            assert!(
                poly.iter().all(|v| v.pos[0] <= 0.50001)
                    || poly.iter().all(|v| v.pos[0] >= 1.49999)
                    || poly.iter().all(|v| v.pos[1] <= 0.50001)
                    || poly.iter().all(|v| v.pos[1] >= 1.49999)
            );
            for i in 1..poly.len() - 1 {
                let a = Vec3::from(poly[0].pos);
                let b = Vec3::from(poly[i].pos);
                let c = Vec3::from(poly[i + 1].pos);
                area += (b - a).cross(c - a).length() * 0.5;
            }
        }
        assert!((area - 3.5).abs() < 1e-5);
    }
    #[test]
    fn neighborhood_geometry_is_finite_and_has_all_ground_families() {
        let spec = crate::demos::Level::Neighborhood.spec();
        let (s, meta) = crate::gym_scene::build_gym(&spec, &crate::look::AFTERMATH);
        assert!(meta.piers.is_empty());
        for kind in [4, 5, 6] {
            assert!(s
                .materials
                .iter()
                .any(|m| m._pad & crate::flags::CONCRETE != 0
                    && (m.base_color[3] as u32) / 8 == kind));
        }
        for p in &s.primitives {
            assert!(p.index_count > 0);
            let verts =
                &s.vertices[p.vertex_offset as usize..(p.vertex_offset + p.vertex_count) as usize];
            for tri in s.indices[p.index_offset as usize..(p.index_offset + p.index_count) as usize]
                .as_chunks::<3>()
            .0
            {
                let a = Vec3::from(verts[tri[0] as usize].pos);
                let b = Vec3::from(verts[tri[1] as usize].pos);
                let c = Vec3::from(verts[tri[2] as usize].pos);
                assert!(a.is_finite() && b.is_finite() && c.is_finite());
                assert!((b - a).cross(c - a).length_squared() > 1e-14);
            }
        }
    }
}
