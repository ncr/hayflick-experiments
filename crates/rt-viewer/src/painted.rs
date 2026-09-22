//! PAINTED WALLS (creative mode, 2026-09-22): a wall whose surface is baked on
//! the CPU by the `surface` crate from the brush strokes the level carries,
//! instead of evaluated per ray in the shade twins.
//!
//! Per wall this builds:
//! - two FACES, each a grid mesh displaced inward by the baked cover loss
//!   (a spall is a real crater: it casts shadows and holds the steel), whose
//!   `uv` is the ATLAS texel coordinate of the point — the shader reads the
//!   albedo there (`Material.surface == SURFACE_ATLAS`);
//! - the top and end sections, plain cast concrete;
//! - the reinforcement bars wherever the loss cut past the mat.
//!
//! The atlas layout is decided here (shelf packing, one region per face) and
//! returned as [`FaceSlot`]s, so the live paint preview can re-bake ONE face
//! into its region and re-upload without rebuilding the scene.

use crate::concrete::{self, Exposure, Mesh};
use glam::Vec3;
use house_game::gym::sim::{PaintEffect, PaintStroke};
use rt_probe::scene::{ATLAS_W, SURFACE_ATLAS};
use rt_probe::Scene;
use surface::{Effect, Face, FaceSpec, Stroke};

/// Painted walls stand as tall as the concrete study's.
pub const HEIGHT: f32 = concrete::HEIGHT;

/// One face's place in the world and in the atlas.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FaceSlot {
    /// Face frame: `origin + axis * u + Y * v` spans the face plane.
    pub origin: Vec3,
    pub axis: Vec3,
    /// Outward normal axis (0 = x, 2 = z) and sign — a stroke's `axis`/`sign`.
    pub n_axis: u8,
    pub n_sign: i8,
    /// Distance of the face plane from the wall's centre line.
    pub half: f32,
    pub spec: FaceSpec,
    /// Atlas texel of the face's (u, v) = (0, 0) corner.
    pub at: (u32, u32),
}

impl FaceSlot {
    /// The strokes of a level that land on this face, in face coordinates.
    pub fn strokes(&self, paint: &[PaintStroke]) -> Vec<Stroke> {
        let n = if self.n_axis == 0 { Vec3::X } else { Vec3::Z } * self.n_sign as f32;
        paint
            .iter()
            .filter(|s| s.axis == self.n_axis && s.sign == self.n_sign)
            .filter_map(|s| {
                let p = Vec3::from(s.pos);
                let d = p - self.origin;
                let (u, v) = (d.dot(self.axis), p.y);
                // on this face's plane (a stroke names a face, not a wall) and
                // within a brush of its extent
                let off_plane = (d.dot(n) - self.half).abs();
                (off_plane < 0.25 && u > -s.r && u < self.spec.len + s.r).then_some(Stroke { effect: effect_of(s.effect), u, v, r: s.r })
            })
            .collect()
    }

    /// World point of face coordinates, before any loss.
    pub fn world(&self, u: f32, v: f32) -> Vec3 {
        let n = if self.n_axis == 0 { Vec3::X } else { Vec3::Z } * self.n_sign as f32;
        self.origin + self.axis * u + Vec3::Y * v + n * self.half
    }
}

pub fn effect_of(e: PaintEffect) -> Effect {
    match e {
        PaintEffect::Rain => Effect::Rain,
        PaintEffect::Soot => Effect::Soot,
        PaintEffect::Spall => Effect::Spall,
    }
}

/// Shelf packer over the scene's atlas: faces fill rows left to right; a face
/// that does not fit starts a new shelf. Grows `scene.atlas` a shelf at a time.
#[derive(Default)]
pub struct Packer {
    x: u32,
    y: u32,
    shelf_h: u32,
}

impl Packer {
    fn alloc(&mut self, atlas: &mut Vec<u32>, w: u32, h: u32) -> (u32, u32) {
        assert!(w <= ATLAS_W, "a face wider than the atlas: {w} texels");
        if self.x + w > ATLAS_W {
            self.y += self.shelf_h;
            self.x = 0;
            self.shelf_h = 0;
        }
        let at = (self.x, self.y);
        self.x += w;
        self.shelf_h = self.shelf_h.max(h);
        let rows = (self.y + self.shelf_h) as usize;
        if atlas.len() < rows * ATLAS_W as usize {
            atlas.resize(rows * ATLAS_W as usize, 0);
        }
        at
    }
}

/// Write a baked face into its atlas region.
pub fn blit(atlas: &mut [u32], slot: &FaceSlot, face: &Face) {
    let rgb = face.shade();
    for j in 0..face.h {
        let row = (slot.at.1 as usize + j) * ATLAS_W as usize + slot.at.0 as usize;
        for i in 0..face.w {
            atlas[row + i] = surface::pack(rgb[j * face.w + i]);
        }
    }
}

fn mean_albedo(face: &Face) -> [f32; 4] {
    let rgb = face.shade();
    let n = rgb.len().max(1) as f32;
    let s = rgb.iter().fold([0.0f32; 3], |a, c| [a[0] + c[0], a[1] + c[1], a[2] + c[2]]);
    [s[0] / n, s[1] / n, s[2] / n, 0.0]
}

/// A triangle soup with per-vertex atlas uv (the concrete `Mesh` carries its
/// own uv meaning, so the faces get this one).
#[derive(Default)]
struct UvMesh {
    verts: Vec<([f32; 3], [f32; 3])>,
    uv: Vec<[f32; 2]>,
    idx: Vec<u32>,
}

impl UvMesh {
    fn tri(&mut self, p: [(Vec3, [f32; 2]); 3]) {
        let n = (p[1].0 - p[0].0).cross(p[2].0 - p[0].0);
        if n.length_squared() < 1e-14 {
            return;
        }
        let n = n.normalize().to_array();
        let i = self.verts.len() as u32;
        for (v, uv) in p {
            self.verts.push((v.to_array(), n));
            self.uv.push(uv);
        }
        self.idx.extend([i, i + 1, i + 2]);
    }

    fn emit(&self, scene: &mut Scene, material: i32) {
        if self.idx.is_empty() {
            return;
        }
        let start = scene.vertices.len();
        scene.add_mesh_world(&self.verts, &self.idx, material);
        for (v, uv) in scene.vertices[start..].iter_mut().zip(&self.uv) {
            v.uv = *uv;
        }
    }
}

/// Build one painted wall run into `scene`. Returns its two face slots (for
/// the live preview) — front (+normal) first.
pub fn wall(scene: &mut Scene, packer: &mut Packer, rect: [f32; 4], along_x: bool, paint: &[PaintStroke]) -> [FaceSlot; 2] {
    let (origin, len, half) = if along_x {
        (Vec3::new(rect[0], 0.0, (rect[1] + rect[3]) * 0.5), rect[2] - rect[0], (rect[3] - rect[1]) * 0.5)
    } else {
        (Vec3::new((rect[0] + rect[2]) * 0.5, 0.0, rect[1]), rect[3] - rect[1], (rect[2] - rect[0]) * 0.5)
    };
    let axis = if along_x { Vec3::X } else { Vec3::Z };
    let n_axis = if along_x { 2 } else { 0 };
    let tx_u = if along_x { surface::TX_ALONG_X } else { surface::TX_ALONG_Z };
    let base_seed = (origin.x * 11.0 + origin.z * 31.0).round().abs() as u32 + 1;
    let slots: [FaceSlot; 2] = [1i8, -1].map(|sign| {
        let spec = FaceSpec { len, height: HEIGHT, tx_u, tx_v: surface::TX_UP, seed: base_seed.wrapping_mul(2).wrapping_add((sign > 0) as u32) };
        let (w, h) = spec.dims();
        let at = packer.alloc(&mut scene.atlas, w as u32, h as u32);
        FaceSlot { origin, axis, n_axis, n_sign: sign, half, spec, at }
    });

    // steel: one material for the whole wall's exposed cage
    let steel = concrete::material(scene, Exposure::Corrosion, 1, base_seed);
    let mut cage = Mesh::default();
    let mut caps = Mesh::default();
    let mut cap_color = [0.0f32; 4];
    let mut faces = Vec::new();

    for slot in &slots {
        let face = Face::bake(slot.spec, &slot.strokes(paint));
        blit(&mut scene.atlas, slot, &face);
        let mean = mean_albedo(&face);
        for k in 0..3 {
            cap_color[k] += mean[k] * 0.5;
        }
        // the face mesh: a grid a few texels per cell, displaced by the loss
        let step_u = 3.0 / tx_u;
        let step_v = 3.0 / surface::TX_UP;
        let nx = (len / step_u).ceil() as usize;
        let ny = (HEIGHT / step_v).ceil() as usize;
        let n = if n_axis == 0 { Vec3::X } else { Vec3::Z } * slot.n_sign as f32;
        let (w, h) = (face.w as f32, face.h as f32);
        let pt = |i: usize, j: usize| {
            let u = len * i as f32 / nx as f32;
            let v = HEIGHT * j as f32 / ny as f32;
            let loss = face.loss_at(u, v);
            let p = origin + axis * u + Vec3::Y * v + n * (half - loss);
            // uv: the atlas texel under this face point, kept inside the region
            let uv = [slot.at.0 as f32 + (u * tx_u).clamp(0.0, w - 0.01), slot.at.1 as f32 + (v * surface::TX_UP).clamp(0.0, h - 0.01)];
            (p, uv)
        };
        let mut m = UvMesh::default();
        for j in 0..ny {
            for i in 0..nx {
                let (a, b, c, d) = (pt(i, j), pt(i + 1, j), pt(i, j + 1), pt(i + 1, j + 1));
                // winding so the geometric normal points OUT of the face
                if (slot.n_sign > 0) == along_x {
                    m.tri([a, b, c]);
                    m.tri([b, d, c]);
                } else {
                    m.tri([a, c, b]);
                    m.tri([b, c, d]);
                }
            }
        }
        let mat = scene.new_material(mean, [0.0; 4], 0.88, 0.0);
        scene.materials[mat as usize].surface = SURFACE_ATLAS;
        scene.materials[mat as usize]._pad = crate::flags::OCCLUDER;
        m.emit(scene, mat);

        // steel wherever the crater cut past the mat: vertical bars, then
        // horizontal, each a run of the spans that are exposed (plus a lip)
        let bar_plane = half - surface::COVER - 0.012;
        let exposed = |u: f32, v: f32| face.loss_at(u, v) > surface::COVER - 0.008;
        let mut u = surface::BAR_U0;
        while u < len - 0.05 {
            let mut run: Vec<Vec3> = Vec::new();
            let mut v = 0.05;
            while v <= HEIGHT - 0.05 {
                if exposed(u, v) {
                    run.push(origin + axis * u + Vec3::Y * v + n * bar_plane);
                } else if run.len() > 1 {
                    concrete::rod(&mut cage, &[run[0] - Vec3::Y * 0.05, *run.last().unwrap() + Vec3::Y * 0.05], 0.015);
                    run.clear();
                } else {
                    run.clear();
                }
                v += 0.02;
            }
            if run.len() > 1 {
                concrete::rod(&mut cage, &[run[0], *run.last().unwrap()], 0.015);
            }
            u += surface::BAR_PITCH_U;
        }
        let mut v = surface::BAR_V0;
        while v < HEIGHT - 0.05 {
            let mut run: Vec<Vec3> = Vec::new();
            let mut u = 0.05;
            while u <= len - 0.05 {
                if exposed(u, v) {
                    run.push(origin + axis * u + Vec3::Y * v + n * (bar_plane - 0.028));
                } else if run.len() > 1 {
                    concrete::rod(&mut cage, &[run[0] - axis * 0.05, *run.last().unwrap() + axis * 0.05], 0.0123);
                    run.clear();
                } else {
                    run.clear();
                }
                u += 0.02;
            }
            if run.len() > 1 {
                concrete::rod(&mut cage, &[run[0], *run.last().unwrap()], 0.0123);
            }
            v += surface::BAR_PITCH_V;
        }
        faces.push(face);
    }

    // top and ends: plain cast concrete joining the two displaced faces
    let (f0, f1) = (&faces[0], &faces[1]);
    let edge = |u: f32, v: f32, front: bool| {
        let (face, sign) = if front { (f0, 1.0) } else { (f1, -1.0) };
        let n = if n_axis == 0 { Vec3::X } else { Vec3::Z } * sign;
        origin + axis * u + Vec3::Y * v + n * (half - face.loss_at(u, v))
    };
    let seg = (len / 0.1).ceil() as usize;
    for i in 0..seg {
        let (u0, u1) = (len * i as f32 / seg as f32, len * (i + 1) as f32 / seg as f32);
        let (a, b, c, d) = (edge(u0, HEIGHT, true), edge(u1, HEIGHT, true), edge(u0, HEIGHT, false), edge(u1, HEIGHT, false));
        caps.tri(a, c, b, [0.0; 3]);
        caps.tri(b, c, d, [0.0; 3]);
    }
    let rows = (HEIGHT / 0.1).ceil() as usize;
    for u in [0.0, len] {
        for j in 0..rows {
            let (v0, v1) = (HEIGHT * j as f32 / rows as f32, HEIGHT * (j + 1) as f32 / rows as f32);
            let (a, b, c, d) = (edge(u, v0, true), edge(u, v1, true), edge(u, v0, false), edge(u, v1, false));
            caps.tri(a, b, c, [0.0; 3]);
            caps.tri(b, d, c, [0.0; 3]);
        }
    }
    let cap = scene.new_material(cap_color, [0.0; 4], 0.9, 0.0);
    scene.materials[cap as usize]._pad = crate::flags::OCCLUDER;
    caps.emit(scene, cap);
    cage.emit(scene, steel);
    slots
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stroke(effect: PaintEffect, pos: [f32; 3], sign: i8) -> PaintStroke {
        PaintStroke { effect, pos, axis: 2, sign, r: 0.4 }
    }

    #[test]
    fn a_stroke_lands_on_the_face_it_names_and_nowhere_else() {
        let mut scene = Scene::new();
        let mut packer = Packer::default();
        // a wall along x from x=2 to x=6 at z=5
        let paint = [stroke(PaintEffect::Soot, [3.0, 1.0, 5.1], 1), stroke(PaintEffect::Rain, [4.0, 2.0, 4.9], -1)];
        let slots = wall(&mut scene, &mut packer, [2.0, 4.9, 6.0, 5.1], true, &paint);
        let front = slots[0].strokes(&paint);
        let back = slots[1].strokes(&paint);
        assert_eq!(front.len(), 1);
        assert_eq!(back.len(), 1);
        assert_eq!(front[0].effect, Effect::Soot);
        assert!((front[0].u - 1.0).abs() < 1e-5 && (front[0].v - 1.0).abs() < 1e-5);
        // a stroke on another wall's plane does not bleed onto this one
        let far = [stroke(PaintEffect::Soot, [3.0, 1.0, 8.1], 1)];
        assert!(slots[0].strokes(&far).is_empty());
    }

    #[test]
    fn faces_get_disjoint_atlas_regions_and_uvs_stay_inside_them() {
        let mut scene = Scene::new();
        let mut packer = Packer::default();
        let a = wall(&mut scene, &mut packer, [2.0, 4.9, 8.0, 5.1], true, &[]);
        let b = wall(&mut scene, &mut packer, [9.9, 1.0, 10.1, 7.0], false, &[]);
        let rects: Vec<(u32, u32, u32, u32)> = a.iter().chain(&b).map(|s| {
            let (w, h) = s.spec.dims();
            (s.at.0, s.at.1, s.at.0 + w as u32, s.at.1 + h as u32)
        }).collect();
        for (i, r) in rects.iter().enumerate() {
            assert!(r.2 <= ATLAS_W && (r.3 as usize) * (ATLAS_W as usize) <= scene.atlas.len());
            for q in &rects[i + 1..] {
                let overlap = r.0 < q.2 && q.0 < r.2 && r.1 < q.3 && q.1 < r.3;
                assert!(!overlap, "atlas regions overlap: {r:?} {q:?}");
            }
        }
        // every atlas-surface vertex reads a texel inside the atlas
        for p in &scene.primitives {
            if scene.materials[p.material_id as usize].surface != SURFACE_ATLAS {
                continue;
            }
            for v in &scene.vertices[p.vertex_offset as usize..(p.vertex_offset + p.vertex_count) as usize] {
                let k = v.uv[1] as usize * ATLAS_W as usize + v.uv[0] as usize;
                assert!(k < scene.atlas.len(), "uv {:?} outside the atlas", v.uv);
            }
        }
    }

    #[test]
    fn a_spall_opens_a_crater_and_shows_steel() {
        let mut scene = Scene::new();
        let mut packer = Packer::default();
        let clean = {
            let mut s = Scene::new();
            wall(&mut s, &mut Packer::default(), [2.0, 4.9, 6.0, 5.1], true, &[]);
            s
        };
        let paint = [PaintStroke { effect: PaintEffect::Spall, pos: [4.0, 1.4, 5.1], axis: 2, sign: 1, r: 0.5 }];
        wall(&mut scene, &mut packer, [2.0, 4.9, 6.0, 5.1], true, &paint);
        let deepest = scene.vertices.iter().map(|v| v.pos[2]).filter(|z| *z > 5.0).fold(f32::MAX, f32::min);
        assert!(deepest < 5.1 - surface::COVER, "the crater floor is past the mat: {deepest}");
        let steel = |s: &Scene| s.materials.iter().enumerate().filter(|(_, m)| m.metallic > 0.5).map(|(i, _)| i as i32).collect::<Vec<_>>();
        let has_rods = |s: &Scene| s.primitives.iter().any(|p| steel(s).contains(&p.material_id));
        assert!(has_rods(&scene), "exposed steel is geometry");
        assert!(!has_rods(&clean), "a clean wall hides its cage");
    }
}
