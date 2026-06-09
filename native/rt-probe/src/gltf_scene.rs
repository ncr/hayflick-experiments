//! Minimal GLTF → ray-tracing scene loader.
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
    /// props the player can't walk through. Consumed by `Level` in lib.rs.
    pub floor_rect: [f32; 4],
    pub solids: Vec<[f32; 4]>,
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
        // AI / Tripo exports often leave metallic-roughness at the glTF defaults
        // (1.0 / 1.0) with no MR texture, which renders as pure rough metal.
        // Treat unauthored metalness as dielectric so the base-colour shows.
        let mut metallic = pbr.metallic_factor();
        if pbr.metallic_roughness_texture().is_none() && metallic >= 0.999 {
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

/// Dollhouse near-wall cull: drop vertical-ish ("wall") triangles whose
/// centroid sits on the camera-near side of the room, so a fixed iso camera
/// looking down `toward_h` sees the interior. Floors (near-horizontal normal)
/// and far walls survive — so shadows / GI bounce off them as normal.
#[derive(Clone, Copy)]
pub struct WallCull {
    pub toward_h: Vec3, // horizontal unit dir from room centre toward the camera
    pub center: Vec3,   // room centre
    pub thresh: f32,    // cull when (centroid-center)·toward_h exceeds this (world units)
}

impl Scene {
    /// Load a file and merge it under `transform`. Triangles whose world-space
    /// centroid Y is at or above `clip_y` are dropped (used to open the room's
    /// ceiling for a top-down dollhouse view); pass `f32::INFINITY` to keep all.
    pub fn add_file(&mut self, path: &str, transform: Mat4, clip_y: f32) -> Result<(), Box<dyn std::error::Error>> {
        self.add_file_ex(path, transform, clip_y, None)
    }

    /// As `add_file`, plus an optional near-wall cull (see `WallCull`).
    pub fn add_file_ex(
        &mut self,
        path: &str,
        transform: Mat4,
        clip_y: f32,
        cull: Option<WallCull>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let m = load_model(path)?;
        let image_base = self.images.len() as i32;
        let material_base = self.materials.len() as i32;
        for mut mat in m.materials {
            if mat.tex_index >= 0 {
                mat.tex_index += image_base;
            }
            self.materials.push(mat);
        }
        self.images.extend(m.images);

        let normal_mat = Mat3::from_mat4(transform).inverse().transpose();
        for p in &m.primitives {
            let vbase = self.vertices.len() as u32;
            let ibase = self.indices.len() as u32;
            for li in 0..p.vertex_count {
                let v = m.vertices[(p.vertex_offset + li) as usize];
                let wp = transform.transform_point3(Vec3::from(v.pos));
                let wn = (normal_mat * Vec3::from(v.nrm)).normalize_or_zero();
                self.vertices.push(Vertex { pos: wp.to_array(), nrm: wn.to_array(), uv: v.uv });
            }
            let tris = &m.indices[p.index_offset as usize..(p.index_offset + p.index_count) as usize];
            let mut kept = 0u32;
            for t in tris.chunks_exact(3) {
                let pos = |li: u32| Vec3::from(self.vertices[(vbase + li) as usize].pos);
                let (p0, p1, p2) = (pos(t[0]), pos(t[1]), pos(t[2]));
                let centroid = (p0 + p1 + p2) / 3.0;
                if centroid.y >= clip_y {
                    continue;
                }
                if let Some(c) = cull {
                    // geometric face normal; a "wall" is near-vertical.
                    let n = (p1 - p0).cross(p2 - p0).normalize_or_zero();
                    let is_wall = n.y.abs() < 0.5;
                    let near = (centroid - c.center).dot(c.toward_h) > c.thresh;
                    if is_wall && near {
                        continue;
                    }
                }
                self.indices.extend_from_slice(t);
                kept += 3;
            }
            if kept == 0 {
                continue;
            }
            self.primitives.push(Primitive {
                vertex_offset: vbase,
                index_offset: ibase,
                vertex_count: p.vertex_count,
                index_count: kept,
                material_id: p.material_id + material_base,
            });
        }
        Ok(())
    }

    /// Add a flat horizontal quad (a procedural floor) spanning `[xmin,xmax] ×
    /// [zmin,zmax]` at height `y`. `example_room.glb` is walls-only, so the
    /// dollhouse view needs a ground plane for the props to sit on and for the
    /// sun/GI to bounce off.
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

    /// Append a box in LOCAL space (centred on XZ, base at y=0, top at y=height)
    /// and return its primitive index. Kept local so a TLAS instance transform
    /// can move it. Used for the movable player marker.
    pub fn add_box_local(&mut self, hx: f32, height: f32, hz: f32, color: [f32; 4], emissive: [f32; 4]) -> usize {
        let material_id = self.materials.len() as i32;
        self.materials.push(Material { base_color: color, emissive, metallic: 0.0, roughness: 0.5, tex_index: -1, _pad: 0 });
        let vbase = self.vertices.len() as u32;
        let ibase = self.indices.len() as u32;
        let (lo, hi) = (0.0f32, height);
        let faces: [([f32; 3], [[f32; 3]; 4]); 6] = [
            ([1., 0., 0.], [[hx, lo, -hz], [hx, lo, hz], [hx, hi, hz], [hx, hi, -hz]]),
            ([-1., 0., 0.], [[-hx, lo, hz], [-hx, lo, -hz], [-hx, hi, -hz], [-hx, hi, hz]]),
            ([0., 0., 1.], [[-hx, lo, hz], [hx, lo, hz], [hx, hi, hz], [-hx, hi, hz]]),
            ([0., 0., -1.], [[hx, lo, -hz], [-hx, lo, -hz], [-hx, hi, -hz], [hx, hi, -hz]]),
            ([0., 1., 0.], [[-hx, hi, -hz], [hx, hi, -hz], [hx, hi, hz], [-hx, hi, hz]]),
            ([0., -1., 0.], [[-hx, lo, hz], [hx, lo, hz], [hx, lo, -hz], [-hx, lo, -hz]]),
        ];
        let mut vi = 0u32;
        for (n, quad) in faces {
            for p in quad {
                self.vertices.push(Vertex { pos: p, nrm: n, uv: [0.0, 0.0] });
            }
            self.indices.extend_from_slice(&[vi, vi + 1, vi + 2, vi, vi + 2, vi + 3]);
            vi += 4;
        }
        let idx = self.primitives.len();
        self.primitives.push(Primitive { vertex_offset: vbase, index_offset: ibase, vertex_count: 24, index_count: 36, material_id });
        idx
    }

    /// Append an axis-aligned box in WORLD space spanning `[min, max]` with the
    /// given material (static, identity instance). Used for coloured emissive
    /// accent lights: the path tracer bounces their colour onto the otherwise
    /// pale clay scene, so the render reads as lit/colourful rather than flat.
    #[allow(clippy::too_many_arguments)]
    pub fn add_box_world(&mut self, min: Vec3, max: Vec3, color: [f32; 4], emissive: [f32; 4], roughness: f32, metallic: f32) {
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

    pub fn new() -> Self {
        Scene { min: Vec3::splat(f32::INFINITY), max: Vec3::splat(f32::NEG_INFINITY), ..Default::default() }
    }

    /// World-space AABB of a freshly loaded file (for placement/scaling decisions).
    pub fn file_bounds(path: &str) -> Result<(Vec3, Vec3), Box<dyn std::error::Error>> {
        let m = load_model(path)?;
        Ok((m.min, m.max))
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
