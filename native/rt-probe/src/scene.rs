//! Scene model + minimal GLTF loader.
//!
//! Bakes node-world transforms into vertices (positions + normals) so each
//! primitive's geometry lands in world space; the renderer then uses one BLAS
//! per primitive with an identity instance transform. Materials carry a base
//! colour, emissive, metallic/roughness and an optional base-colour texture
//! index into the scene's image list.

use glam::{Mat3, Mat4, Vec3};

#[repr(C)]
#[derive(Clone, Copy)]
pub struct Vertex {
    pub pos: [f32; 3],
    pub nrm: [f32; 3],
    pub uv: [f32; 2],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct GeomInfo {
    pub index_offset: u32,
    pub vertex_offset: u32,
    pub material_id: i32,
    pub _pad: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct Material {
    pub base_color: [f32; 4],
    pub emissive: [f32; 4], // rgb * strength
    pub metallic: f32,
    pub roughness: f32,
    pub tex_index: i32, // -1 = none
    pub _pad: i32,
}

pub struct LoadedImage {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>, // rgba8
}

#[derive(Clone, Copy)]
pub struct Primitive {
    pub vertex_offset: u32,
    pub index_offset: u32,
    pub vertex_count: u32,
    pub index_count: u32,
    pub material_id: i32,
}

#[derive(Default)]
pub struct Scene {
    pub vertices: Vec<Vertex>,
    pub indices: Vec<u32>,
    pub primitives: Vec<Primitive>,
    pub materials: Vec<Material>,
    pub images: Vec<LoadedImage>,
    pub min: Vec3,
    pub max: Vec3,
    /// Primitive index of the movable player marker, if any. Its geometry is in
    /// LOCAL space (centred on XZ, base at y=0), so the TLAS instance transform
    /// places it — letting it move via per-frame TLAS rebuild (dynamic scene).
    pub dynamic_prim: Option<usize>,
    pub player_start: Vec3,
    /// Collision data for the native game runtime (mirrors @common/gameplay
    /// `LevelResource.isBlocked`): the walkable floor rect (xmin, zmin, xmax,
    /// zmax) — already inset for the walls — and the XZ footprints of solid
    /// props the player can't walk through. Consumed by `game::Level`.
    pub floor_rect: [f32; 4],
    pub solids: Vec<[f32; 4]>,
    /// Per-primitive near-wall hide tag (dollhouse cull under camera rotation).
    /// Bitmask of OUTWARD directions: bit0=+X, bit1=+Z, bit2=-X, bit3=-Z;
    /// 0 = never hidden. `SceneGpu` turns these into per-yaw TLAS instance
    /// visibility masks. Empty vec = feature unused (all visible). When used,
    /// must be exactly `primitives.len()` long — see `tag_hide`.
    pub prim_hide_mask: Vec<u8>,
    /// Authored NEE emission direction per primitive (zero = none/isotropic;
    /// overrides the geometric heuristic). Sparse: may be shorter than
    /// `primitives` — index with `.get(i)`.
    pub prim_light_dir: Vec<[f32; 3]>,
    /// Conceptual lights: NEE-only emitters with NO geometry — nothing renders
    /// at their position, nothing occludes right at them; light simply arrives
    /// (e.g. lamps recessed in a ceiling that is never drawn). Same layout as
    /// the extracted emissive-prim lights: [cx, cy, cz, radius, r, g, b, 0].
    /// SceneGpu::build appends these to the light list.
    pub point_lights: Vec<[f32; 8]>,
    /// Per-scene lighting environment, fed to the shaders as `env0`:
    /// [sun_scale, sky_scale, fog_density, fog_height_falloff_wu].
    /// sun/sky scale the shader's built-in key + sky dome; fog is an
    /// exponential ground-mist (sigma = density * exp(-y/height)) with a
    /// single-scatter sun term, applied on the primary segment only.
    /// Overridable at runtime via SUN / SKY / FOG / FOG_H (see `Config`).
    pub lighting: [f32; 4],
}

/// A single loaded file, geometry already in file-world space (node transforms baked).
struct Model {
    vertices: Vec<Vertex>,
    indices: Vec<u32>,
    primitives: Vec<Primitive>,
    materials: Vec<Material>,
    images: Vec<LoadedImage>,
    min: Vec3,
    max: Vec3,
}

fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
}

/// 0xRRGGBB (three.js-style sRGB hex) -> linear rgba, like THREE.Color does
/// before a material colour reaches the renderer.
pub fn hex_linear(hex: u32) -> [f32; 4] {
    let r = ((hex >> 16) & 0xff) as f32 / 255.0;
    let g = ((hex >> 8) & 0xff) as f32 / 255.0;
    let b = (hex & 0xff) as f32 / 255.0;
    [srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b), 1.0]
}

fn to_rgba8(img: &gltf::image::Data) -> LoadedImage {
    use gltf::image::Format::*;
    let (w, h) = (img.width, img.height);
    let p = &img.pixels;
    let mut out = Vec::with_capacity((w * h * 4) as usize);
    match img.format {
        R8G8B8A8 => out.extend_from_slice(p),
        R8G8B8 => {
            for c in p.chunks_exact(3) {
                out.extend_from_slice(c);
                out.push(255);
            }
        }
        R8 => {
            for &v in p {
                out.extend_from_slice(&[v, v, v, 255]);
            }
        }
        R8G8 => {
            for c in p.chunks_exact(2) {
                out.extend_from_slice(&[c[0], c[0], c[0], c[1]]);
            }
        }
        other => {
            eprintln!("  (unsupported image format {other:?} -> magenta placeholder)");
            for _ in 0..(w * h) {
                out.extend_from_slice(&[255, 0, 255, 255]);
            }
        }
    }
    LoadedImage { width: w, height: h, pixels: out }
}

fn load_model(path: &str) -> Result<Model, Box<dyn std::error::Error>> {
    let (doc, buffers, images) = gltf::import(path)?;

    let images: Vec<LoadedImage> = images.iter().map(to_rgba8).collect();

    // materials: local index 0 is a default; file materials follow at 1+.
    let mut materials = vec![Material {
        base_color: [0.7, 0.7, 0.72, 1.0],
        emissive: [0.0; 4],
        metallic: 0.0,
        roughness: 0.9,
        tex_index: -1,
        _pad: 0,
    }];
    for m in doc.materials() {
        let pbr = m.pbr_metallic_roughness();
        let tex_index = pbr
            .base_color_texture()
            .map(|t| t.texture().source().index() as i32)
            .unwrap_or(-1);
        let es = m.emissive_strength().unwrap_or(1.0);
        let ef = m.emissive_factor();
        // glTF defaults metallicFactor to 1.0, and we never SAMPLE the
        // metallic-roughness texture (only base colour is bound) — so a
        // full-metal factor is "unspecified", not gold, whether or not an MR
        // texture exists. Trusting it rendered the whole tile-kit house
        // (Polyhaven walls/floors, MR texture present, factor 1.0) as rough
        // MIRRORS: NEE off on every kit surface, all light via specular
        // chains — dim, slow-converging, and impossible to match with a
        // Lambertian direct pass. Treat factor >= 1 as dielectric; authored
        // partial metalness (< 1) is preserved.
        let mut metallic = pbr.metallic_factor();
        if metallic >= 0.999 {
            metallic = 0.0;
        }
        materials.push(Material {
            base_color: pbr.base_color_factor(),
            emissive: [ef[0] * es, ef[1] * es, ef[2] * es, 1.0],
            metallic,
            roughness: pbr.roughness_factor(),
            tex_index,
            _pad: 0,
        });
    }

    let mut vertices: Vec<Vertex> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    let mut primitives: Vec<Primitive> = Vec::new();
    let mut min = Vec3::splat(f32::INFINITY);
    let mut max = Vec3::splat(f32::NEG_INFINITY);

    // recurse the node hierarchy, accumulating world transforms
    let mut stack: Vec<(gltf::Node, Mat4)> = doc
        .default_scene()
        .map(|s| s.nodes().map(|n| (n, Mat4::IDENTITY)).collect())
        .unwrap_or_default();
    if stack.is_empty() {
        // no default scene: take scene 0
        if let Some(s) = doc.scenes().next() {
            stack = s.nodes().map(|n| (n, Mat4::IDENTITY)).collect();
        }
    }

    while let Some((node, parent)) = stack.pop() {
        let local = Mat4::from_cols_array_2d(&node.transform().matrix());
        let world = parent * local;
        let normal_mat = Mat3::from_mat4(world).inverse().transpose();

        if let Some(mesh) = node.mesh() {
            for prim in mesh.primitives() {
                let reader = prim.reader(|b| Some(&buffers[b.index()]));
                let pos: Vec<[f32; 3]> = match reader.read_positions() {
                    Some(p) => p.collect(),
                    None => continue,
                };
                let nrm: Vec<[f32; 3]> = reader
                    .read_normals()
                    .map(|n| n.collect())
                    .unwrap_or_else(|| vec![[0.0, 1.0, 0.0]; pos.len()]);
                let uv: Vec<[f32; 2]> = reader
                    .read_tex_coords(0)
                    .map(|t| t.into_f32().collect())
                    .unwrap_or_else(|| vec![[0.0, 0.0]; pos.len()]);
                let local_idx: Vec<u32> = match reader.read_indices() {
                    Some(i) => i.into_u32().collect(),
                    None => (0..pos.len() as u32).collect(),
                };

                let vertex_offset = vertices.len() as u32;
                let index_offset = indices.len() as u32;
                for i in 0..pos.len() {
                    let wp = world.transform_point3(Vec3::from(pos[i]));
                    let wn = (normal_mat * Vec3::from(nrm[i])).normalize_or_zero();
                    min = min.min(wp);
                    max = max.max(wp);
                    vertices.push(Vertex {
                        pos: wp.to_array(),
                        nrm: wn.to_array(),
                        uv: uv[i],
                    });
                }
                indices.extend_from_slice(&local_idx);

                let material_id = prim.material().index().map(|i| i as i32 + 1).unwrap_or(0);
                primitives.push(Primitive {
                    vertex_offset,
                    index_offset,
                    vertex_count: pos.len() as u32,
                    index_count: local_idx.len() as u32,
                    material_id,
                });
            }
        }
        for child in node.children() {
            stack.push((child, world));
        }
    }

    Ok(Model { vertices, indices, primitives, materials, images, min, max })
}

/// A glTF file parsed once and registered with a `Scene` (materials + images
/// pushed a single time); `Scene::place` then instantiates its geometry under
/// any number of transforms without duplicating textures. The tile-based house
/// builder places the same handful of wall/floor GLBs dozens of times.
pub struct CachedModel {
    model: Model,
    material_base: i32,
}

impl CachedModel {
    /// Local-space AABB of the model (for placement scaling decisions).
    pub fn bounds(&self) -> (Vec3, Vec3) {
        (self.model.min, self.model.max)
    }
}

impl Scene {
    pub fn new() -> Self {
        Scene {
            min: Vec3::splat(f32::INFINITY),
            max: Vec3::splat(f32::NEG_INFINITY),
            lighting: [1.0, 1.0, 0.0, 1.0], // full sun/sky, no fog
            ..Default::default()
        }
    }

    /// Parse `path` once and register its materials/images with this scene.
    pub fn preload(&mut self, path: &str) -> Result<CachedModel, Box<dyn std::error::Error>> {
        let m = load_model(path)?;
        let image_base = self.images.len() as i32;
        let material_base = self.materials.len() as i32;
        let mut model = m;
        for mat in &mut model.materials {
            if mat.tex_index >= 0 {
                mat.tex_index += image_base;
            }
            self.materials.push(*mat);
        }
        self.images.append(&mut model.images);
        Ok(CachedModel { model, material_base })
    }

    /// Instantiate a preloaded model under `transform` (geometry baked to world
    /// space, materials shared). Returns the index of the first primitive added.
    pub fn place(&mut self, cm: &CachedModel, transform: Mat4) -> usize {
        let first = self.primitives.len();
        let normal_mat = Mat3::from_mat4(transform).inverse().transpose();
        for p in &cm.model.primitives {
            let vbase = self.vertices.len() as u32;
            let ibase = self.indices.len() as u32;
            for li in 0..p.vertex_count {
                let v = cm.model.vertices[(p.vertex_offset + li) as usize];
                let wp = transform.transform_point3(Vec3::from(v.pos));
                let wn = (normal_mat * Vec3::from(v.nrm)).normalize_or_zero();
                self.vertices.push(Vertex { pos: wp.to_array(), nrm: wn.to_array(), uv: v.uv });
            }
            let tris = &cm.model.indices[p.index_offset as usize..(p.index_offset + p.index_count) as usize];
            self.indices.extend_from_slice(tris);
            self.primitives.push(Primitive {
                vertex_offset: vbase,
                index_offset: ibase,
                vertex_count: p.vertex_count,
                index_count: p.index_count,
                material_id: p.material_id + cm.material_base,
            });
        }
        first
    }

    /// Debug helper: dump every triangle of a primitive as CSV
    /// (centroid xyz, world normal xyz, texel luma at the UV centroid).
    pub fn dump_tris_csv(&self, prim: usize, path: &str) {
        use std::io::Write;
        let p = self.primitives[prim];
        let vbase = p.vertex_offset as usize;
        let mat = self.materials[p.material_id as usize];
        let img = if mat.tex_index >= 0 { self.images.get(mat.tex_index as usize) } else { None };
        let mut f = std::fs::File::create(path).unwrap();
        writeln!(f, "cx,cy,cz,nx,ny,nz,luma,ax,ay,az,bx,by,bz,qx,qy,qz").unwrap();
        let idx = &self.indices[p.index_offset as usize..(p.index_offset + p.index_count) as usize];
        for t in idx.chunks_exact(3) {
            let va = self.vertices[vbase + t[0] as usize];
            let vb = self.vertices[vbase + t[1] as usize];
            let vc = self.vertices[vbase + t[2] as usize];
            let (a, b, c) = (Vec3::from(va.pos), Vec3::from(vb.pos), Vec3::from(vc.pos));
            let n = (b - a).cross(c - a).normalize_or_zero();
            let ctr = (a + b + c) / 3.0;
            let mut luma = -1.0;
            if let Some(im) = img {
                let u = (va.uv[0] + vb.uv[0] + vc.uv[0]) / 3.0;
                let v = (va.uv[1] + vb.uv[1] + vc.uv[1]) / 3.0;
                let tx = (u.rem_euclid(1.0) * im.width as f32) as usize % im.width.max(1) as usize;
                let ty = (v.rem_euclid(1.0) * im.height as f32) as usize % im.height.max(1) as usize;
                let s = (ty * im.width as usize + tx) * 4;
                luma = (0.2126 * im.pixels[s] as f32 + 0.7152 * im.pixels[s + 1] as f32 + 0.0722 * im.pixels[s + 2] as f32) / 255.0;
            }
            writeln!(
                f,
                "{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{}",
                ctr.x, ctr.y, ctr.z, n.x, n.y, n.z, luma, a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z
            )
            .unwrap();
        }
    }

    /// Carve an emissive sub-surface out of a placed primitive — the "make the
    /// screen itself glow" model edit, done at load time. Triangles of `prim`
    /// whose geometric normal aligns with `dir` (dot > 0.6), whose centroid
    /// lies inside the world AABB, and whose base-colour texel is DARK
    /// (luma < dark_max — CRT glass is dark in the texture, the case is light)
    /// move into a NEW primitive sharing the same vertex window, with a cloned
    /// material whose emissive is set. The original prim's index range is
    /// compacted in place; the vacated tail goes unused (per-prim BLAS ranges
    /// make that harmless). NEE light extraction then sees the new prim as an
    /// emissive surface at its TRUE position with its TRUE facing.
    ///
    /// `flip_winding` reverses each carved triangle (its geometric normal ends
    /// up at -dir): for surfaces the source model authored INSIDE-OUT (e.g. a
    /// recessed CRT plane facing into the case) — the flip makes the carved
    /// screen face outward, so NEE light extraction gets the true facing.
    ///
    /// Returns the new prim index if any triangle matched.
    #[allow(clippy::too_many_arguments)]
    pub fn carve_emissive_region(&mut self, prim: usize, dir: Vec3, min: Vec3, max: Vec3, dark_max: f32, emissive: [f32; 4], flip_winding: bool) -> Option<usize> {
        let p = self.primitives[prim];
        let vbase = p.vertex_offset as usize;
        let mat = self.materials[p.material_id as usize];
        let img = if mat.tex_index >= 0 { self.images.get(mat.tex_index as usize) } else { None };
        let idx: Vec<u32> = self.indices[p.index_offset as usize..(p.index_offset + p.index_count) as usize].to_vec();
        let (mut keep, mut carved): (Vec<u32>, Vec<u32>) = (Vec::new(), Vec::new());
        for t in idx.chunks_exact(3) {
            let va = self.vertices[vbase + t[0] as usize];
            let vb = self.vertices[vbase + t[1] as usize];
            let vc = self.vertices[vbase + t[2] as usize];
            let (a, b, c) = (Vec3::from(va.pos), Vec3::from(vb.pos), Vec3::from(vc.pos));
            let n = (b - a).cross(c - a).normalize_or_zero();
            let ctr = (a + b + c) / 3.0;
            let inside = ctr.cmpge(min).all() && ctr.cmple(max).all();
            let mut dark = true;
            if let Some(im) = img {
                let u = (va.uv[0] + vb.uv[0] + vc.uv[0]) / 3.0;
                let v = (va.uv[1] + vb.uv[1] + vc.uv[1]) / 3.0;
                let tx = (u.rem_euclid(1.0) * im.width as f32) as usize % im.width.max(1) as usize;
                let ty = (v.rem_euclid(1.0) * im.height as f32) as usize % im.height.max(1) as usize;
                let s = (ty * im.width as usize + tx) * 4;
                let luma = (0.2126 * im.pixels[s] as f32 + 0.7152 * im.pixels[s + 1] as f32 + 0.0722 * im.pixels[s + 2] as f32) / 255.0;
                dark = luma < dark_max;
            }
            if n.dot(dir) > 0.6 && inside && dark {
                if flip_winding {
                    carved.extend_from_slice(&[t[0], t[2], t[1]]);
                } else {
                    carved.extend_from_slice(t);
                }
            } else {
                keep.extend_from_slice(t);
            }
        }
        if carved.is_empty() {
            return None;
        }
        let off = p.index_offset as usize;
        self.indices[off..off + keep.len()].copy_from_slice(&keep);
        self.primitives[prim].index_count = keep.len() as u32;
        let ibase = self.indices.len() as u32;
        self.indices.extend_from_slice(&carved);
        let mid = self.materials.len() as i32;
        self.materials.push(Material { emissive, ..mat });
        self.primitives.push(Primitive { vertex_offset: p.vertex_offset, index_offset: ibase, vertex_count: p.vertex_count, index_count: carved.len() as u32, material_id: mid });
        Some(self.primitives.len() - 1)
    }

    /// Tag every primitive from `from` to the current end with a near-wall hide
    /// bitmask (see `prim_hide_mask`), padding untagged predecessors with 0.
    pub fn tag_hide(&mut self, from: usize, bits: u8) {
        self.prim_hide_mask.resize(self.primitives.len(), 0);
        for m in &mut self.prim_hide_mask[from..] {
            *m = bits;
        }
    }

    /// Add a flat horizontal quad (a procedural floor) spanning `[xmin,xmax] ×
    /// [zmin,zmax]` at height `y` — the ground plane for procedural scenes.
    pub fn add_floor(&mut self, xmin: f32, xmax: f32, zmin: f32, zmax: f32, y: f32, color: [f32; 4]) {
        let material_id = self.materials.len() as i32;
        self.materials.push(Material { base_color: color, emissive: [0.0; 4], metallic: 0.0, roughness: 0.92, tex_index: -1, _pad: 0 });
        let vbase = self.vertices.len() as u32;
        let ibase = self.indices.len() as u32;
        let n = [0.0, 1.0, 0.0];
        for &(x, z) in &[(xmin, zmin), (xmax, zmin), (xmax, zmax), (xmin, zmax)] {
            self.vertices.push(Vertex { pos: [x, y, z], nrm: n, uv: [0.0, 0.0] });
        }
        // two triangles (winding irrelevant — instances disable face culling and
        // the shader flips the normal toward the ray).
        self.indices.extend_from_slice(&[0, 1, 2, 0, 2, 3]);
        self.primitives.push(Primitive { vertex_offset: vbase, index_offset: ibase, vertex_count: 4, index_count: 6, material_id });
    }

    /// GridHelper-style tile lines (mirrors `THREE.GridHelper(size, divisions,
    /// centerColor, color)` as the web grid-walker uses it): `divisions` cells
    /// over a `size`×`size` square centred at the origin, drawn as thin quads
    /// `line_w` wide at height `y`. The two centre lines take `center_color`,
    /// the rest `color`. One primitive per colour.
    pub fn add_ground_grid(&mut self, size: f32, divisions: u32, y: f32, line_w: f32, center_color: [f32; 4], color: [f32; 4]) {
        let half = size * 0.5;
        let step = size / divisions.max(1) as f32;
        let mut center: Vec<(bool, f32)> = Vec::new();
        let mut others: Vec<(bool, f32)> = Vec::new();
        for i in 0..=divisions {
            let k = -half + i as f32 * step;
            let is_center = k.abs() < step * 1e-3;
            for along_x in [true, false] {
                if is_center { center.push((along_x, k)) } else { others.push((along_x, k)) }
            }
        }
        self.add_line_quads(&center, half, y, line_w * 0.5, center_color);
        self.add_line_quads(&others, half, y, line_w * 0.5, color);
    }

    fn add_line_quads(&mut self, lines: &[(bool, f32)], half: f32, y: f32, hw: f32, color: [f32; 4]) {
        if lines.is_empty() {
            return;
        }
        let material_id = self.materials.len() as i32;
        self.materials.push(Material { base_color: color, emissive: [0.0; 4], metallic: 0.0, roughness: 1.0, tex_index: -1, _pad: 0 });
        let vbase = self.vertices.len() as u32;
        let ibase = self.indices.len() as u32;
        let mut vi = 0u32;
        for &(along_x, k) in lines {
            let quad: [(f32, f32); 4] = if along_x {
                [(-half, k - hw), (half, k - hw), (half, k + hw), (-half, k + hw)]
            } else {
                [(k - hw, -half), (k + hw, -half), (k + hw, half), (k - hw, half)]
            };
            for (x, z) in quad {
                self.vertices.push(Vertex { pos: [x, y, z], nrm: [0.0, 1.0, 0.0], uv: [0.0, 0.0] });
            }
            self.indices.extend_from_slice(&[vi, vi + 1, vi + 2, vi, vi + 2, vi + 3]);
            vi += 4;
        }
        self.primitives.push(Primitive { vertex_offset: vbase, index_offset: ibase, vertex_count: vi, index_count: vi / 4 * 6, material_id });
    }

    /// Append a box in LOCAL space (centred on XZ, base at y=0, top at y=height)
    /// and return its primitive index. Kept local so a TLAS instance transform
    /// can move it. Used for the movable player marker.
    pub fn add_box_local(&mut self, hx: f32, height: f32, hz: f32, color: [f32; 4], emissive: [f32; 4]) -> usize {
        let idx = self.primitives.len();
        self.add_box(Vec3::new(-hx, 0.0, -hz), Vec3::new(hx, height, hz), color, emissive, 0.5, 0.0);
        idx
    }

    /// Append an axis-aligned box in WORLD space spanning `[min, max]` with the
    /// given material (static, identity instance). Used for emissive practicals
    /// (bulbs, sconces, screens) and any quick blockout geometry.
    #[allow(clippy::too_many_arguments)]
    pub fn add_box_world(&mut self, min: Vec3, max: Vec3, color: [f32; 4], emissive: [f32; 4], roughness: f32, metallic: f32) {
        self.add_box(min, max, color, emissive, roughness, metallic);
    }

    fn add_box(&mut self, min: Vec3, max: Vec3, color: [f32; 4], emissive: [f32; 4], roughness: f32, metallic: f32) {
        let material_id = self.materials.len() as i32;
        self.materials.push(Material { base_color: color, emissive, metallic, roughness, tex_index: -1, _pad: 0 });
        let vbase = self.vertices.len() as u32;
        let ibase = self.indices.len() as u32;
        let (x0, y0, z0, x1, y1, z1) = (min.x, min.y, min.z, max.x, max.y, max.z);
        let faces: [([f32; 3], [[f32; 3]; 4]); 6] = [
            ([1., 0., 0.], [[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]]),
            ([-1., 0., 0.], [[x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1]]),
            ([0., 0., 1.], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]),
            ([0., 0., -1.], [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]]),
            ([0., 1., 0.], [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]]),
            ([0., -1., 0.], [[x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0]]),
        ];
        let mut vi = 0u32;
        for (n, quad) in faces {
            for p in quad {
                self.vertices.push(Vertex { pos: p, nrm: n, uv: [0.0, 0.0] });
            }
            self.indices.extend_from_slice(&[vi, vi + 1, vi + 2, vi, vi + 2, vi + 3]);
            vi += 4;
        }
        self.primitives.push(Primitive { vertex_offset: vbase, index_offset: ibase, vertex_count: 24, index_count: 36, material_id });
    }

    /// Recompute the AABB from only the vertices actually referenced by kept triangles.
    pub fn recompute_bounds(&mut self) {
        self.min = Vec3::splat(f32::INFINITY);
        self.max = Vec3::splat(f32::NEG_INFINITY);
        for p in &self.primitives {
            let tris = &self.indices[p.index_offset as usize..(p.index_offset + p.index_count) as usize];
            for &li in tris {
                let v = Vec3::from(self.vertices[(p.vertex_offset + li) as usize].pos);
                self.min = self.min.min(v);
                self.max = self.max.max(v);
            }
        }
    }

    pub fn geom_infos(&self) -> Vec<GeomInfo> {
        self.primitives
            .iter()
            .map(|p| GeomInfo {
                index_offset: p.index_offset,
                vertex_offset: p.vertex_offset,
                material_id: p.material_id,
                _pad: 0,
            })
            .collect()
    }
}
