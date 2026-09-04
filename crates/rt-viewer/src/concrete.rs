//! Reinforced concrete, independent of the ceramic/wear pipeline.
//! Geometry is a cement body with cover loss around an embedded steel cage.
//! Per-vertex UV.x carries actual removed cover (wu) to the material shader.
use crate::flags;
use glam::{Vec2, Vec3};
use rt_probe::Scene;

pub const HEIGHT: f32 = 3.2;
const STEP: f32 = 0.06;
const PITCH: f32 = 0.45;
const BAR_R: f32 = 0.015;

#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(u32)]
pub enum Exposure {
    Sound = 0,
    Rain = 1,
    Corrosion = 2,
    Fire = 3,
    Blast = 4,
}

/// Authored histories for the yard, addressed by world point. Rendering
/// topology and wall order do not choose which event happened to a wall.
pub const HISTORIES: [((f32, f32), Exposure); 5] = [
    ((2.0, 3.0), Exposure::Sound),
    ((6.0, 6.0), Exposure::Blast),
    ((3.0, 10.0), Exposure::Rain),
    ((11.0, 11.0), Exposure::Corrosion),
    ((13.0, 5.0), Exposure::Fire),
];

pub fn history(rect: [f32; 4]) -> Exposure {
    HISTORIES
        .iter()
        .find(|((x, z), _)| *x >= rect[0] && *x <= rect[2] && *z >= rect[1] && *z <= rect[3])
        .map_or(Exposure::Rain, |(_, e)| *e)
}

pub(crate) fn hash(x: i32, y: i32, seed: u32) -> f32 {
    let mut a = (x as u32).wrapping_mul(0x9e3779b9)
        ^ (y as u32).wrapping_mul(0x85ebca6b)
        ^ seed.wrapping_mul(0xc2b2ae35);
    a ^= a >> 16;
    a = a.wrapping_mul(0x7feb352d);
    a ^= a >> 15;
    (a & 0xffffff) as f32 / 16777215.0
}
pub(crate) fn noise(p: Vec2, seed: u32) -> f32 {
    let i = p.floor();
    let f = p - i;
    let f = f * f * (Vec2::splat(3.0) - f * 2.0);
    let x = i.x as i32;
    let y = i.y as i32;
    let a = hash(x, y, seed) * (1.0 - f.x) + hash(x + 1, y, seed) * f.x;
    let b = hash(x, y + 1, seed) * (1.0 - f.x) + hash(x + 1, y + 1, seed) * f.x;
    a * (1.0 - f.y) + b * f.y
}
fn smooth(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}
fn lens(p: Vec2, c: Vec2, radius: Vec2, seed: u32) -> f32 {
    let q = (p - c) / radius;
    // Fracture fronts follow intersecting facets. Adding noise to an ellipse
    // only produces a lumpy oval, so the patch starts as an irregular polygon.
    let mut boundary = -10.0f32;
    for k in 0..7 {
        let angle = k as f32 * std::f32::consts::TAU / 7.0 + (hash(k, 0, seed) - 0.5) * 0.22;
        let n = Vec2::new(angle.cos(), angle.sin());
        boundary = boundary.max(q.dot(n) / (0.78 + 0.24 * hash(k, 1, seed)));
    }
    1.0 - boundary + 0.11 * (noise(p * 7.0, seed) - 0.5) + 0.045 * (noise(p * 17.0, seed + 5) - 0.5)
}
fn top(u: f32, len: f32, e: Exposure, seed: u32) -> f32 {
    let n = noise(Vec2::new(u * 3.4, 0.0), seed);
    let loss = match e {
        Exposure::Blast => {
            0.12 + 1.35 * (-((u - len * 0.78) / (len * 0.22)).powi(2)).exp() + 0.23 * n
        }
        Exposure::Fire => 0.05 + 0.18 * n,
        Exposure::Corrosion => 0.015 + 0.075 * n,
        _ => 0.0,
    };
    HEIGHT - loss
}
/// Stress cracks propagate outward from the damaged zone, with piecewise
/// straight changes of direction at aggregate-scale obstacles. The same
/// scalar opens geometry and supplies the shader's crevice coverage.
fn fissure(u: f32, y: f32, len: f32, e: Exposure, seed: u32) -> f32 {
    if matches!(e, Exposure::Sound | Exposure::Rain) {
        return 0.0;
    }
    let p = Vec2::new(u, y);
    let origin = match e {
        Exposure::Blast => Vec2::new(len * 0.58, 1.45),
        Exposure::Fire => Vec2::new(len * 0.48, 1.9),
        _ => Vec2::new(len * 0.45, 1.05),
    };
    let mut amount = 0.0f32;
    for k in 0..7 {
        let angle = if e == Exposure::Corrosion {
            std::f32::consts::FRAC_PI_2 + (hash(k, 7, seed) - 0.5) * 0.55
        } else {
            k as f32 * std::f32::consts::TAU / 7.0 + (hash(k, 0, seed) - 0.5) * 0.45
        };
        let axis = Vec2::new(angle.cos(), angle.sin());
        let t = (p - origin).dot(axis);
        let reach = 0.75 + hash(k, 1, seed) * 2.1;
        if t < 0.0 || t > reach {
            continue;
        }
        let cell = (t / 0.18).floor() as i32;
        let f = t / 0.18 - cell as f32;
        let wander =
            ((1.0 - f) * hash(cell, k, seed + 55) + f * hash(cell + 1, k, seed + 55) - 0.5) * 0.19;
        let distance = ((p - origin).dot(Vec2::new(-axis.y, axis.x)) - wander).abs();
        let width = (0.025 + 0.023 * hash(k, 2, seed)) * (1.0 - 0.5 * t / reach);
        amount = amount.max(
            (1.0 - smooth(width * 0.3, width + 0.025, distance))
                * (1.0 - smooth(reach - 0.25, reach, t)),
        );
    }
    amount
}

/// Removed cover is continuous. The irregular shoulder, fractured transition
/// and recessed body are one surface; there is no decal sitting over a hole.
fn depth(u: f32, y: f32, len: f32, e: Exposure, seed: u32, back: bool) -> f32 {
    if e == Exposure::Sound {
        return 0.0;
    }
    let p = Vec2::new(u, y);
    let rough = noise(p * 13.0, seed + 3);
    if back {
        return 0.003 + 0.014 * rough;
    }
    let q = match e {
        Exposure::Sound => -1.0,
        Exposure::Rain => -1.0,
        Exposure::Corrosion => {
            let cx = (len * 0.45 / PITCH).round() * PITCH;
            lens(p, Vec2::new(cx, 1.05), Vec2::new(len * 0.33, 0.84), seed).max(lens(
                p,
                Vec2::new(cx + 0.5, 1.85),
                Vec2::new(0.35, 0.8),
                seed + 7,
            ))
        }
        Exposure::Fire => lens(
            p,
            Vec2::new(len * 0.48, 1.9),
            Vec2::new(len * 0.39, 0.85),
            seed,
        )
        .max(lens(
            p,
            Vec2::new(len * 0.78, 0.6),
            Vec2::new(0.7, 0.55),
            seed + 9,
        )),
        Exposure::Blast => lens(
            p,
            Vec2::new(len * 0.58, 1.45),
            Vec2::new(len * 0.37, 1.05),
            seed,
        )
        .max(lens(
            p,
            Vec2::new(len * 0.84, 2.65),
            Vec2::new(len * 0.25, 0.8),
            seed + 13,
        )),
    };
    let loss = smooth(-0.025, 0.065, q);
    let base = if e == Exposure::Rain {
        0.008 + 0.018 * rough
    } else {
        0.003
    };
    // Reach behind the near mat and leave a solid rear ligament. Large
    // aggregate is still embedded in the rough, exposed cement body.
    (base + loss * (0.108 + 0.026 * rough) + 0.025 * fissure(u, y, len, e, seed) * (1.0 - loss))
        .min(0.145)
}

#[derive(Default)]
pub(crate) struct Mesh {
    vertices: Vec<([f32; 3], [f32; 3])>,
    indices: Vec<u32>,
    cover: Vec<f32>,
}
impl Mesh {
    pub(crate) fn tri(&mut self, a: Vec3, b: Vec3, c: Vec3, uv: [f32; 3]) {
        let cross = (b - a).cross(c - a);
        if cross.length_squared() < 1e-14 {
            return;
        }
        let n = cross.normalize().to_array();
        let i = self.vertices.len() as u32;
        self.vertices
            .extend([(a.to_array(), n), (b.to_array(), n), (c.to_array(), n)]);
        self.cover.extend(uv);
        self.indices.extend([i, i + 1, i + 2]);
    }
    pub(crate) fn emit(&self, scene: &mut Scene, material: i32) {
        if self.indices.is_empty() {
            return;
        }
        let start = scene.vertices.len();
        scene.add_mesh_world(&self.vertices, &self.indices, material);
        for (v, d) in scene.vertices[start..].iter_mut().zip(&self.cover) {
            v.uv = [*d, 0.0];
        }
    }
}

/// kind 0=cast concrete, 1=steel, 2=fracture/debris, 3=ground.
/// base alpha carries kind*8+exposure; emissive alpha is a stable seed.
pub(crate) fn material(scene: &mut Scene, e: Exposure, kind: u32, seed: u32) -> i32 {
    let color = match kind {
        1 => [0.12, 0.065, 0.031, 0.0],
        2 => [0.25, 0.235, 0.21, 0.0],
        3 => [0.135, 0.125, 0.105, 0.0],
        _ => [0.255, 0.25, 0.23, 0.0],
    };
    let mut c = color;
    c[3] = (kind * 8 + e as u32) as f32;
    let m = scene.new_material(
        c,
        [0.0, 0.0, 0.0, seed as f32],
        0.88,
        if kind == 1 { 0.65 } else { 0.0 },
    );
    scene.materials[m as usize]._pad = flags::CONCRETE
        | if kind == 3 {
            0
        } else {
            flags::OCCLUDER | flags::AA
        };
    m
}

pub fn ground(scene: &mut Scene) {
    // Called before architecture and dynamics: only the floor quads exist.
    for m in &mut scene.materials {
        m._pad = flags::CONCRETE;
        m.base_color[3] = 24.0;
        m.emissive[3] = 17.0;
        m.roughness = 0.95;
    }
}

fn rod(mesh: &mut Mesh, points: &[Vec3], radius: f32) {
    // Straight reinforcement needs one segment, not a tessellated chain.
    // Retain every actual bend while reducing traversal/AS cost on Metal.
    let simplified: Vec<Vec3> = points
        .iter()
        .enumerate()
        .filter_map(|(i, p)| {
            if i == 0
                || i + 1 == points.len()
                || (*p - points[i - 1])
                    .cross(points[i + 1] - *p)
                    .length_squared()
                    > 1e-10
            {
                Some(*p)
            } else {
                None
            }
        })
        .collect();
    let points = &simplified;

    let sides = 8;
    for j in 0..points.len() - 1 {
        let axis = (points[j + 1] - points[j]).normalize();
        let helper = if axis.y.abs() < 0.9 { Vec3::Y } else { Vec3::X };
        let a = axis.cross(helper).normalize();
        let b = axis.cross(a);
        for k in 0..sides {
            let t = k as f32 * std::f32::consts::TAU / sides as f32;
            let q = (k + 1) as f32 * std::f32::consts::TAU / sides as f32;
            let r = (a * t.cos() + b * t.sin()) * radius;
            let s = (a * q.cos() + b * q.sin()) * radius;
            mesh.tri(points[j] + r, points[j] + s, points[j + 1] + r, [0.0; 3]);
            mesh.tri(
                points[j] + s,
                points[j + 1] + s,
                points[j + 1] + r,
                [0.0; 3],
            );
            if j == 0 {
                mesh.tri(points[0], points[0] + s, points[0] + r, [0.0; 3]);
            }
            if j == points.len() - 2 {
                mesh.tri(
                    points[j + 1],
                    points[j + 1] + r,
                    points[j + 1] + s,
                    [0.0; 3],
                );
            }
        }
    }
}

/// Fresh mesh construction. Does not call the old crack, veneer or rebar code.
pub fn wall(scene: &mut Scene, rect: [f32; 4], along_x: bool) {
    wall_history(scene, rect, along_x, history(rect));
}
pub fn wall_history(scene: &mut Scene, rect: [f32; 4], along_x: bool, e: Exposure) {
    wall_detail(scene, rect, along_x, e, STEP);
}
pub fn wall_detail(scene: &mut Scene, rect: [f32; 4], along_x: bool, e: Exposure, step: f32) {
    let (origin, len) = if along_x {
        (
            Vec3::new(rect[0], 0.0, (rect[1] + rect[3]) * 0.5),
            rect[2] - rect[0],
        )
    } else {
        (
            Vec3::new((rect[0] + rect[2]) * 0.5, 0.0, rect[1]),
            rect[3] - rect[1],
        )
    };
    let axis = if along_x { Vec3::X } else { Vec3::Z };
    let normal = if along_x { Vec3::Z } else { Vec3::X };
    // The lot has four independent histories: the surviving reference at
    // the back, acid-washed return, corroded foreground, and the blasted wing.
    let seed = (origin.x * 11.0 + origin.z * 31.0).round().abs() as u32 + 1;
    let skin = material(scene, e, 0, seed);
    let broken = material(scene, e, 2, seed);
    let steel = material(scene, e, 1, seed);
    let nx = (len / step).ceil() as usize;
    let ny = (HEIGHT / step).ceil() as usize;
    let point = |i: usize, j: usize, back: bool| {
        let mut u = len * i as f32 / nx as f32;
        let mut v = j as f32 / ny as f32;
        if i > 0 && i < nx {
            u += (hash(i as i32, j as i32, seed) - 0.5) * step * 0.48;
        }
        if j > 0 && j < ny {
            v += (hash(i as i32, j as i32, seed + 1) - 0.5) * step / HEIGHT * 0.48;
        }
        let y = v * top(u, len, e, seed);
        let d = depth(u, y, len, e, seed, back);
        let z = if back { -0.1 + d } else { 0.1 - d };
        (origin + axis * u + Vec3::Y * y + normal * z, d)
    };
    let mut face = Mesh::default();
    let mut edges = Mesh::default();
    for back in [false, true] {
        for j in 0..ny {
            for i in 0..nx {
                let (a, da) = point(i, j, back);
                let (b, db) = point(i + 1, j, back);
                let (c, dc) = point(i, j + 1, back);
                let (d, dd) = point(i + 1, j + 1, back);
                if back {
                    face.tri(a, c, b, [da, dc, db]);
                    face.tri(b, c, d, [db, dc, dd]);
                } else {
                    face.tri(a, b, c, [da, db, dc]);
                    face.tri(b, d, c, [db, dd, dc]);
                }
            }
        }
    }
    // Close the top and end sections with the same boundary samples.
    for i in 0..nx {
        for j in [0, ny] {
            let a = point(i, j, false).0;
            let b = point(i + 1, j, false).0;
            let c = point(i, j, true).0;
            let d = point(i + 1, j, true).0;
            edges.tri(a, c, b, [0.1; 3]);
            edges.tri(b, c, d, [0.1; 3]);
        }
    }
    for i in [0, nx] {
        for j in 0..ny {
            let a = point(i, j, false).0;
            let b = point(i, j + 1, false).0;
            let c = point(i, j, true).0;
            let d = point(i, j + 1, true).0;
            edges.tri(a, b, c, [0.1; 3]);
            edges.tri(b, d, c, [0.1; 3]);
        }
    }
    let first_vertex = scene.vertices.len();
    face.emit(scene, skin);
    for v in &mut scene.vertices[first_vertex..] {
        let p = Vec3::from(v.pos);
        let u = (p - origin).dot(axis);
        v.uv[1] = fissure(u, p.y, len, e, seed);
    }
    edges.emit(scene, if e == Exposure::Sound { skin } else { broken });
    if matches!(e, Exposure::Corrosion | Exposure::Fire | Exposure::Blast) {
        let mut cage = Mesh::default();
        for rear in [false, true] {
            let z = if rear { -0.045 } else { 0.045 };
            let mut u = 0.24;
            while u < len - 0.12 {
                let height = if e == Exposure::Blast {
                    HEIGHT - 0.12 - 0.13 * hash((u * 100.0) as i32, 0, seed)
                } else {
                    top(u, len, e, seed) - 0.055
                };
                let mut points = Vec::new();
                for j in 0..=24 {
                    let y = 0.10 + (height - 0.10) * j as f32 / 24.0;
                    let free = (y - top(u, len, e, seed) + 0.13).max(0.0);
                    let bend = if e == Exposure::Blast {
                        free * free * (0.35 + hash((u * 100.0) as i32, 1, seed) * 0.4)
                    } else {
                        0.0
                    };
                    points.push(
                        origin + axis * (u + 0.12 * bend) + Vec3::Y * y + normal * (z + bend),
                    );
                }
                rod(&mut cage, &points, BAR_R);
                u += PITCH;
            }
            let mut y = 0.32;
            while y < HEIGHT - 0.15 {
                let mut points = Vec::new();
                for i in 0..=nx {
                    let u = 0.07 + (len - 0.14) * i as f32 / nx as f32;
                    // Only stirrups below the remaining wall survive. Broken
                    // horizontal steel ends at the torn edge, verticals bend.
                    if y > top(u, len, e, seed) - 0.035 {
                        if points.len() > 1 {
                            rod(&mut cage, &points, BAR_R * 0.82);
                        }
                        points.clear();
                        continue;
                    }
                    points.push(origin + axis * u + Vec3::Y * y + normal * (z - 0.021));
                }
                if points.len() > 1 {
                    rod(&mut cage, &points, BAR_R * 0.82);
                }
                y += 0.5;
            }
        }
        cage.emit(scene, steel);
    }
    // Rubble lands directly below lost cover; flat, faceted fragments have
    // concrete section thickness, not the shape of generic rocks.
    if e != Exposure::Sound {
        let mut rubble = Mesh::default();
        for i in 0..(len * 8.0) as i32 {
            let u = hash(i, 1, seed) * len;
            let damage = depth(u, 1.1, len, e, seed, false);
            if damage < 0.03 && hash(i, 2, seed) > 0.18 {
                continue;
            }
            let spread = 0.18 + hash(i, 3, seed) * 0.85;
            let c = origin
                + axis * u
                + normal * spread
                + Vec3::Y * (crate::gym_scene::FLOOR_TOP - 0.003);
            let r = 0.055 + 0.15 * hash(i, 4, seed);
            let h = 0.035 + 0.08 * hash(i, 5, seed);
            let angle = hash(i, 6, seed) * 6.28;
            let a = Vec3::new(angle.cos(), 0.0, angle.sin()) * r;
            let b = Vec3::new(-angle.sin(), 0.0, angle.cos()) * r * 0.65;
            let pts = [
                c - a - b,
                c + a - b * 0.7,
                c + a * 0.65 + b,
                c - a + b * 0.8,
            ];
            let peak = c + Vec3::Y * h;
            for k in 0..4 {
                rubble.tri(pts[k], pts[(k + 1) % 4], peak, [0.12; 3]);
            }
            rubble.tri(pts[0], pts[2], pts[1], [0.12; 3]);
            rubble.tri(pts[0], pts[3], pts[2], [0.12; 3]);
        }
        let m = material(scene, e, 2, seed + 1);
        scene.materials[m as usize]._pad = flags::CONCRETE | flags::AA;
        rubble.emit(scene, m);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn the_yard_builds_every_history_without_the_legacy_wear_pipeline() {
        let (scene, meta) = crate::gym_scene::build_gym(
            &house_game::gym::sim::concrete_level(),
            &crate::look::AFTERMATH,
            true,
        );
        assert!(
            meta.piers.is_empty(),
            "legacy wear must not reprocess concrete"
        );
        for (_, e) in HISTORIES {
            assert!(
                scene
                    .materials
                    .iter()
                    .any(|m| m._pad & flags::CONCRETE != 0 && m.base_color[3] == e as u32 as f32),
                "missing {e:?} specimen"
            );
        }
        for e in [Exposure::Sound, Exposure::Rain] {
            assert!(scene
                .materials
                .iter()
                .filter(|m| m._pad & flags::CONCRETE != 0 && m.base_color[3] == e as u32 as f32)
                .all(|m| m.roughness > 0.8));
        }
    }
    #[test]
    fn loss_exposes_the_cage_without_erasing_the_rear_ligament() {
        for e in [
            Exposure::Rain,
            Exposure::Corrosion,
            Exposure::Fire,
            Exposure::Blast,
        ] {
            let mut exposed = 0;
            for i in 0..100 {
                for j in 0..60 {
                    let u = i as f32 * 0.06;
                    let y = j as f32 * 0.05;
                    let d = depth(u, y, 6.0, e, 73, false);
                    assert!(d + depth(u, y, 6.0, e, 73, true) < 0.2 - 0.02);
                    if d > 0.08 {
                        exposed += 1;
                    }
                }
            }
            if e != Exposure::Rain {
                assert!(exposed > 200, "{e:?} has no readable exposed cage");
            }
        }
    }
    #[test]
    fn concrete_meshes_are_deterministic_finite_and_metal_safe() {
        let build = || {
            let mut s = Scene::new();
            wall(&mut s, [3.0, 5.9, 10.0, 6.1], true);
            s
        };
        let s = build();
        let t = build();
        assert_eq!(s.indices, t.indices);
        assert_eq!(
            s.vertices.iter().map(|v| v.pos).collect::<Vec<_>>(),
            t.vertices.iter().map(|v| v.pos).collect::<Vec<_>>()
        );
        for p in &s.primitives {
            for tri in s.indices[p.index_offset as usize..(p.index_offset + p.index_count) as usize]
                .chunks_exact(3)
            {
                let v = |i: u32| Vec3::from(s.vertices[(p.vertex_offset + i) as usize].pos);
                let a = v(tri[0]);
                let b = v(tri[1]);
                let c = v(tri[2]);
                assert!(a.is_finite() && b.is_finite() && c.is_finite());
                assert!((b - a).cross(c - a).length_squared() > 1e-16);
            }
        }
        assert!(s.materials.iter().any(|m| m.metallic > 0.5));
        assert!(s.vertices.iter().any(|v| v.uv[0] > 0.08));
    }
}
