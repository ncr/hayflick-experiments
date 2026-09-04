//! Layered neighborhood ground and architecture, sharing parcels with the sim.
use crate::concrete::{self, hash, noise, Exposure, Mesh};
use glam::{Vec2, Vec3};
use house_game::gym::neighborhood::areas;
use rt_probe::Scene;

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
fn pothole(p: Vec2) -> f32 {
    [
        (Vec2::new(8.3, 11.8), 1.25),
        (Vec2::new(19.0, 13.5), 1.0),
        (Vec2::new(2.0, 10.4), 0.8),
    ]
    .iter()
    .map(|(c, r)| {
        ((1.0 - p.distance(*c) / r) * 3.0 + 0.2 * (noise(p * 9.0, 33) - 0.5)).clamp(0.0, 1.0)
    })
    .fold(0.0, f32::max)
}
/// The visible support height, shared by placement and the articulated rig.
pub fn height_at(p: Vec2) -> f32 {
    let Some(a) = house_game::gym::neighborhood::at(p.x, p.y) else {
        return -0.075;
    };
    if a.kind == 0 {
        return -0.075;
    }
    if a.kind == 1 {
        return -0.012 - pothole(p) * 0.052 + 0.003 * noise(p * 4.0, 11);
    }
    let step = if a.kind == 3 { 2.0 } else { 1.5 };
    let x0 = a.rect[0] + ((p.x - a.rect[0]) / step).floor() * step;
    let z0 = a.rect[1] + ((p.y - a.rect[1]) / step).floor() * step;
    let r = [
        x0 + 0.018,
        z0 + 0.018,
        (x0 + step).min(a.rect[2]) - 0.018,
        (z0 + step).min(a.rect[3]) - 0.018,
    ];
    let seed = (r[0] * 103.0 + r[1] * 317.0) as u32;
    let x = (p.x - r[0]) / (r[2] - r[0]);
    let z = (p.y - r[1]) / (r[3] - r[1]);
    let dx = if hash(1, 1, seed) > 0.5 { x } else { 1.0 - x };
    let dz = if hash(2, 1, seed) > 0.5 { z } else { 1.0 - z };
    let dist = (dx - 0.1).abs() * 0.8 + (dz - 0.2).abs();
    let loss = if hash(0, 0, seed) > 0.48 && a.kind != 3 {
        ((0.75 - dist) * 9.0 + 0.4 * (noise(Vec2::new(x, z) * 13.0, seed) - 0.5)).clamp(0.0, 1.0)
    } else {
        0.0
    };
    if loss > 0.90 {
        return -0.075;
    }
    crate::gym_scene::FLOOR_TOP + (hash(0, 1, seed) - 0.5) * 0.045 * x - loss * 0.106
}
pub fn ground(s: &mut Scene) {
    let soil = mat(s, 6, 1);
    let road = mat(s, 4, 4);
    let slab = mat(s, 5, 2);
    // One continuous soil layer remains below missing paving. No coplanar faces.
    let mut earth = Mesh::default();
    quad(
        &mut earth,
        Vec3::new(0.0, -0.075, 0.0),
        Vec3::new(26.0, -0.075, 0.0),
        Vec3::new(0.0, -0.075, 23.0),
        Vec3::new(26.0, -0.075, 23.0),
        [0.0; 4],
    );
    earth.emit(s, soil);
    for a in areas().iter().filter(|a| a.kind > 0) {
        if a.kind == 1 {
            let mut mesh = Mesh::default();
            let step = 0.2;
            let nx = ((a.rect[2] - a.rect[0]) / step).round() as i32;
            let nz = ((a.rect[3] - a.rect[1]) / step).round() as i32;
            let point = |i: i32, j: i32| {
                let p = Vec2::new(a.rect[0] + i as f32 * step, a.rect[1] + j as f32 * step);
                let loss = pothole(p);
                (
                    Vec3::new(p.x, -0.012 - loss * 0.052 + 0.003 * noise(p * 4.0, 11), p.y),
                    loss * 0.1,
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
                    quad(&mut mesh, p[0].0, p[1].0, p[2].0, p[3].0, p.map(|p| p.1));
                }
            }
            mesh.emit(s, road);
        } else {
            // Individual 5-foot sidewalk pours with real joints and missing corners.
            // Interiors use larger, less damaged pours of the same cement.
            let step = if a.kind == 3 { 2.0 } else { 1.5 };
            let mut x = a.rect[0];
            while x < a.rect[2] - 0.01 {
                let mut z = a.rect[1];
                while z < a.rect[3] - 0.01 {
                    panel(
                        s,
                        [
                            x + 0.018,
                            z + 0.018,
                            (x + step).min(a.rect[2]) - 0.018,
                            (z + step).min(a.rect[3]) - 0.018,
                        ],
                        slab,
                        a.kind == 3,
                    );
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
pub fn facade(s: &mut Scene, r: [f32; 4], along_x: bool) {
    let c = Vec2::new((r[0] + r[2]) * 0.5, (r[1] + r[3]) * 0.5);
    let lot = areas()
        .into_iter()
        .filter(|a| a.kind == 3)
        .find(|a| {
            c.x >= a.rect[0] - 0.2
                && c.x <= a.rect[2] + 0.2
                && c.y >= a.rect[1] - 0.2
                && c.y <= a.rect[3] + 0.2
        })
        .unwrap();
    let e = match lot.exposure {
        2 => Exposure::Corrosion,
        3 => Exposure::Fire,
        _ => Exposure::Blast,
    };
    let first = s.primitives.len();
    concrete::wall_detail(s, r, along_x, e, 0.085);
    let len = if along_x { r[2] - r[0] } else { r[3] - r[1] };
    if len < 3.0 {
        return;
    }
    // Cut actual windows through both cover and cage. Retain the rear/lintel
    // geometry and give each opening a thick sill. Mesh indices remain valid.
    let slots: Vec<f32> = (0..((len - 1.0) / 2.4) as usize)
        .map(|i| 1.1 + i as f32 * 2.4)
        .collect();
    let start = if along_x { r[0] } else { r[1] };
    for k in first..s.primitives.len() {
        let p = s.primitives[k];
        let mut vertices = Vec::new();
        for tri in s.indices[p.index_offset as usize..(p.index_offset + p.index_count) as usize]
            .chunks_exact(3)
        {
            let triangle: Vec<_> = tri
                .iter()
                .map(|&i| s.vertices[(p.vertex_offset + i) as usize])
                .collect();
            let mut polygons = vec![triangle];
            for u in &slots {
                polygons = polygons
                    .into_iter()
                    .flat_map(|poly| {
                        subtract_window(
                            poly,
                            if along_x { 0 } else { 2 },
                            [start + u - 0.48, 1.0, start + u + 0.48, 2.15],
                        )
                    })
                    .collect();
            }
            for poly in polygons {
                for i in 1..poly.len().saturating_sub(1) {
                    let [a, b, c] = [poly[0], poly[i], poly[i + 1]];
                    if (Vec3::from(b.pos) - Vec3::from(a.pos))
                        .cross(Vec3::from(c.pos) - Vec3::from(a.pos))
                        .length_squared()
                        > 1e-14
                    {
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
    let m = concrete::material(s, e, 0, 123);
    for u in slots {
        let c = if along_x {
            Vec3::new(start + u, 0.96, c.y)
        } else {
            Vec3::new(c.x, 0.96, start + u)
        };
        let half = if along_x {
            Vec3::new(0.54, 0.065, 0.17)
        } else {
            Vec3::new(0.17, 0.065, 0.54)
        };
        let i = s.primitives.len();
        s.add_box_world(
            c - half,
            c + half,
            [0.23, 0.22, 0.19, 0.0],
            [0.0; 4],
            0.95,
            0.0,
        );
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
pub fn details(s: &mut Scene) {
    for a in areas().iter().filter(|a| a.kind == 3) {
        let [x0, z0, x1, z1] = a.rect;
        let e = if a.exposure == 3 {
            Exposure::Fire
        } else {
            Exposure::Rain
        };
        let m = concrete::material(s, e, 0, 95 + a.exposure);
        let door_z = if z0 > 14.0 { z0 } else { z1 };
        let mut block = |lo: Vec3, hi: Vec3| {
            let i = s.primitives.len();
            s.add_box_world(lo, hi, [0.25, 0.24, 0.21, 0.0], [0.0; 4], 0.92, 0.0);
            s.primitives[i].material_id = m;
        };
        block(
            Vec3::new(x0 + 2.9, 2.25, door_z - 0.12),
            Vec3::new(x0 + 5.1, 2.83, door_z + 0.12),
        );
        // Surviving corner columns carry the remaining roof strip even where
        // the thinner fire-damaged infill has lost its crown.
        for x in [x0, x1] {
            block(
                Vec3::new(x - 0.12, 0.0, z0 - 0.12),
                Vec3::new(x + 0.12, 3.23, z0 + 0.12),
            );
        }
    }
}

pub fn roofs(s: &mut Scene) {
    for a in areas().iter().filter(|a| a.kind == 3) {
        // The surviving rear roof strip establishes a dwelling; the open front
        // makes collapsed rooms explorable and exposes fire damage below.
        let m = concrete::material(
            s,
            if a.exposure == 3 {
                Exposure::Fire
            } else {
                Exposure::Rain
            },
            0,
            81 + a.exposure,
        );
        let mut roof = Mesh::default();
        let [x0, z0, x1, _] = a.rect;
        let step = 0.25;
        let mut x = x0;
        while x < x1 {
            let front = z0 + 1.6 + 0.65 * noise(Vec2::new(x, 0.0) * 2.0, 31);
            let y = 3.23;
            quad(
                &mut roof,
                Vec3::new(x, y - 0.16, front),
                Vec3::new((x + step).min(x1), y - 0.16, front),
                Vec3::new(x, y - 0.16, z0),
                Vec3::new((x + step).min(x1), y - 0.16, z0),
                [0.02; 4],
            );
            quad(
                &mut roof,
                Vec3::new(x, y, z0),
                Vec3::new((x + step).min(x1), y, z0),
                Vec3::new(x, y, front),
                Vec3::new((x + step).min(x1), y, front),
                [0.04; 4],
            );
            quad(
                &mut roof,
                Vec3::new(x, y, front),
                Vec3::new((x + step).min(x1), y, front),
                Vec3::new(x, y - 0.16, front),
                Vec3::new((x + step).min(x1), y - 0.16, front),
                [0.09; 4],
            );
            x += step;
        }
        roof.emit(s, m);
    }
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
        let spec = house_game::gym::neighborhood::level();
        let (s, meta) = crate::gym_scene::build_gym(&spec, &crate::look::AFTERMATH, true);
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
                .chunks_exact(3)
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
