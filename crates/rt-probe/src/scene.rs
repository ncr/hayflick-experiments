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

/// The sun + sky dome as DATA (look-as-data, Faza 1b). Historically these
/// were compile-time constants in all four shade/probe kernels; a look now
/// authors them and they ride to both backends as push rows env1..env4
/// (see [`EnvBlock`]). Defaults reproduce the historical built-ins exactly.
#[derive(Clone, Copy)]
pub struct SunSky {
    /// World-space direction TOWARD the sun (normalized in `EnvBlock::pack`).
    pub sun_dir: [f32; 3],
    /// Sun tint (linear); the shader key is `tint * 6.0 * env0.sunScale`.
    pub sun_rgb: [f32; 3],
    /// Sky-dome gradient tints (linear), scaled by `0.18 * env0.skyScale`.
    pub horizon_rgb: [f32; 3],
    pub zenith_rgb: [f32; 3],
    /// Below-horizon miss tint (the void outside the level), same scale as
    /// the sky rows — rides in the env1..env3 w channels (push space is at
    /// the 256 B cap, so no new row).
    pub ground_rgb: [f32; 3],
}

impl Default for SunSky {
    fn default() -> SunSky {
        // the pre-1b shader constants, bit-exact
        SunSky { sun_dir: [0.62, 0.55, 0.38], sun_rgb: [1.0, 0.88, 0.70], horizon_rgb: [0.80, 0.83, 0.90], zenith_rgb: [0.28, 0.45, 0.92], ground_rgb: [0.14, 0.13, 0.12] }
    }
}

/// The five environment push rows both backends feed to the shade AND probe
/// kernels: the resolved lighting scalars (env0) + the scene's [`SunSky`].
/// One layout, four shaders — GLSL/MSL twins read identical bytes.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct EnvBlock {
    pub env0: [f32; 4], // sunScale, skyScale, fogDensity, fogHeight
    pub env1: [f32; 4], // sun dir xyz (normalized), w = ground tint r
    pub env2: [f32; 4], // sun tint rgb, w = ground tint g
    pub env3: [f32; 4], // sky horizon rgb, w = ground tint b
    pub env4: [f32; 4], // sky zenith rgb, w unused
}

impl EnvBlock {
    /// Resolve the block from the env0 scalars (scene lighting with the
    /// SUN/SKY/FOG/FOG_H overrides already applied) and the scene's SunSky.
    pub fn pack(env0: [f32; 4], s: &SunSky) -> EnvBlock {
        let d = glam::Vec3::from(s.sun_dir).normalize_or_zero();
        EnvBlock {
            env0,
            env1: [d.x, d.y, d.z, s.ground_rgb[0]],
            env2: [s.sun_rgb[0], s.sun_rgb[1], s.sun_rgb[2], s.ground_rgb[1]],
            env3: [s.horizon_rgb[0], s.horizon_rgb[1], s.horizon_rgb[2], s.ground_rgb[2]],
            env4: [s.zenith_rgb[0], s.zenith_rgb[1], s.zenith_rgb[2], 0.0],
        }
    }

    /// This frame's block: the per-frame sky dim rides on the sun/sky scalars
    /// only (env0.xy) — the authored tints never change frame to frame.
    pub fn dimmed(mut self, sky_dim: f32) -> EnvBlock {
        self.env0[0] *= sky_dim;
        self.env0[1] *= sky_dim;
        self
    }
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
    /// LEGACY single-mover shim: merged (as the named run "player") into
    /// `dynamic_list` alongside `dynamics` — existing scenes keep compiling.
    pub dynamic_prim: Option<usize>,
    /// Named dynamic (TLAS-movable) primitive runs beyond the legacy player:
    /// (name, first prim, prim count, start instance transform). Geometry
    /// stays in LOCAL space; the per-frame instance transform places it
    /// (door leaves, movers). Filled by `register_dynamic`.
    pub dynamics: Vec<(String, usize, usize, Mat4)>,
    /// Named NEE lights: (name, prim index). `SceneGpu::build` joins these
    /// onto the emissive-scan slot order into `SceneHandles.lights`; naming a
    /// prim that lands no NEE slot is a loud build error, never a silent skip.
    pub named_lights: Vec<(String, usize)>,
    /// Named conceptual point lights: (name, index into `point_lights`).
    /// Their slots come after every emissive prim's in the NEE list.
    pub named_point_lights: Vec<(String, usize)>,
    /// Primitives whose NEE light is a DEVICE screen, not room lighting: they
    /// ignore the wall switch and bake at base level into BOTH probe banks
    /// (their bounce is a constant term, so the bank-lerp scalar stays exact).
    /// Authored, replacing the old emission-hue kind heuristic — flicker
    /// CURVES live in the game now (house-game `flicker`); the renderer keeps
    /// only this bake-bank distinction.
    pub screen_prims: Vec<usize>,
    pub player_start: Vec3,
    /// Collision data for the native game runtime (mirrors @common/gameplay
    /// `LevelResource.isBlocked`): the walkable floor rect (xmin, zmin, xmax,
    /// zmax) — already inset for the walls — and the XZ footprints of solid
    /// props the player can't walk through. Consumed by house-game's `Level`.
    pub floor_rect: [f32; 4],
    pub solids: Vec<[f32; 4]>,
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
    /// The sun direction/tint + sky gradient tints — look-authored data
    /// (Faza 1b); packed with the resolved `lighting` into an [`EnvBlock`].
    pub sun_sky: SunSky,
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

    /// Every dynamic primitive run with its name + start transform, in a fixed
    /// order: the legacy `dynamic_prim` Option (the unnamed movable player)
    /// merges FIRST under the name "player", starting at `player_start`, then
    /// `dynamics` in registration order. This is the renderer's single source
    /// for NEE-scan exclusion, bake-ray masking (0x05) and instance handles.
    pub fn dynamic_list(&self) -> Vec<(String, usize, usize, Mat4)> {
        let mut v: Vec<(String, usize, usize, Mat4)> = Vec::new();
        if let Some(p) = self.dynamic_prim {
            v.push(("player".to_string(), p, 1, Mat4::from_translation(self.player_start)));
        }
        v.extend(self.dynamics.iter().cloned());
        v
    }

    /// Register an already-appended primitive run (e.g. an `add_box_local`
    /// door leaf) as a named dynamic instance starting at `start`. The run's
    /// geometry stays in LOCAL space (pivot authoring — e.g. put a door leaf's
    /// hinge at the origin); the TLAS instance transform places it in the
    /// world, patched per frame through `SceneGpu::record_frame`. Per-instance
    /// policy (ARCHITECTURE.md flag table): excluded from the NEE emissive
    /// scan, bake-ray mask 0x05 (the frozen GI cache never sees movers).
    /// Call `recompute_bounds` BEFORE registering dynamics — local-space
    /// geometry must not stretch the world AABB.
    pub fn register_dynamic(&mut self, name: &str, first: usize, count: usize, start: Mat4) {
        self.dynamics.push((name.to_string(), first, count, start));
    }

    /// Name an emissive primitive for per-light game control. The NEE slot
    /// (`LightKey`) is resolved at `SceneGpu::build` from the emissive-scan
    /// order — naming never reorders the scan.
    pub fn name_light(&mut self, name: &str, prim: usize) {
        self.named_lights.push((name.to_string(), prim));
    }

    /// Name a conceptual point light (index into `point_lights`) for per-light
    /// game control; its slot follows every emissive prim's.
    pub fn name_point_light(&mut self, name: &str, idx: usize) {
        self.named_point_lights.push((name.to_string(), idx));
    }

    /// Tag a primitive's NEE light as a device screen (see `screen_prims`).
    pub fn mark_screen(&mut self, prim: usize) {
        self.screen_prims.push(prim);
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

    /// Append a UV sphere of unit radius centred at the LOCAL origin and return
    /// its primitive index. Kept local (like `add_box_local`) so a TLAS
    /// instance transform `translate · scale` positions and sizes it per frame
    /// — used for the goo-blob ellipsoid pool (one sphere skinned onto each
    /// spine node). Vertex normals are the unit position (smooth shading).
    pub fn add_sphere_local(&mut self, rings: u32, sectors: u32, color: [f32; 4], emissive: [f32; 4], roughness: f32) -> usize {
        let material_id = self.materials.len() as i32;
        self.materials.push(Material { base_color: color, emissive, metallic: 0.0, roughness, tex_index: -1, _pad: 0 });
        let idx = self.primitives.len();
        let vbase = self.vertices.len() as u32;
        let ibase = self.indices.len() as u32;
        for i in 0..=rings {
            let phi = std::f32::consts::PI * i as f32 / rings as f32; // 0..π (pole to pole)
            let (sp, cp) = phi.sin_cos();
            for j in 0..=sectors {
                let theta = std::f32::consts::TAU * j as f32 / sectors as f32;
                let (st, ct) = theta.sin_cos();
                let n = [sp * ct, cp, sp * st];
                self.vertices.push(Vertex { pos: n, nrm: n, uv: [j as f32 / sectors as f32, i as f32 / rings as f32] });
            }
        }
        let stride = sectors + 1;
        for i in 0..rings {
            for j in 0..sectors {
                let a = i * stride + j;
                let b = a + stride;
                self.indices.extend_from_slice(&[a, a + 1, b, a + 1, b + 1, b]);
            }
        }
        let vcount = (rings + 1) * (sectors + 1);
        let icount = self.indices.len() as u32 - ibase;
        self.primitives.push(Primitive { vertex_offset: vbase, index_offset: ibase, vertex_count: vcount, index_count: icount, material_id });
        idx
    }

    /// Append an axis-aligned box in WORLD space spanning `[min, max]` with the
    /// given material (static, identity instance). Used for emissive practicals
    /// (bulbs, sconces, screens) and any quick blockout geometry.
    #[allow(clippy::too_many_arguments)]
    pub fn add_box_world(&mut self, min: Vec3, max: Vec3, color: [f32; 4], emissive: [f32; 4], roughness: f32, metallic: f32) {
        self.add_box(min, max, color, emissive, roughness, metallic);
    }

    /// Mint one material and return its id — what `add_box` does before it
    /// emits its six faces, exposed so a caller can build a NON-box prim on the
    /// same terms. The box→mesh promoter (`rt_viewer::wear_geom`, the eased
    /// arris) needs exactly this: an eased box has to stay ONE primitive with
    /// ONE material, or every per-box mark keyed by prim index (the occluder /
    /// glass / matte bits, the crack-lab knobs, the smash and roof-tear TLAS
    /// hides) would address the wrong thing.
    pub fn new_material(&mut self, color: [f32; 4], emissive: [f32; 4], roughness: f32, metallic: f32) -> i32 {
        self.materials.push(Material { base_color: color, emissive, metallic, roughness, tex_index: -1, _pad: 0 });
        self.materials.len() as i32 - 1
    }

    fn add_box(&mut self, min: Vec3, max: Vec3, color: [f32; 4], emissive: [f32; 4], roughness: f32, metallic: f32) {
        let material_id = self.new_material(color, emissive, roughness, metallic);
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

    /// Append a raw world-space triangle mesh as ONE primitive that SHARES an
    /// existing material (crack-lab geometric faults: a split pier's halves
    /// keep the pier's material, so knobs / flags / selection stay
    /// per-segment). `indices` are local to `verts`, like `add_box`'s.
    pub fn add_mesh_world(&mut self, verts: &[([f32; 3], [f32; 3])], indices: &[u32], material_id: i32) {
        assert_eq!(indices.len() % 3, 0, "world mesh index data must contain complete triangles");
        // Metal's acceleration-structure builder rejects (or, on some Apple
        // drivers, crashes on) zero-area triangles. Procedural clipping can
        // legitimately collapse a polygon at a seam, so filter those triangles
        // at the shared scene boundary instead of making each generator carry
        // the same near-duplicate/collinearity guard. Vulkan accepts them, but
        // feeding different geometry to the two backends is worse than the
        // tiny, deterministic cleanup here.
        let mut kept = Vec::with_capacity(indices.len());
        for tri in indices.chunks_exact(3) {
            let [ia, ib, ic] = tri else { unreachable!() };
            assert!((*ia as usize) < verts.len() && (*ib as usize) < verts.len() && (*ic as usize) < verts.len(), "world mesh index out of bounds");
            let a = Vec3::from(verts[*ia as usize].0);
            let b = Vec3::from(verts[*ib as usize].0);
            let c = Vec3::from(verts[*ic as usize].0);
            let area2 = (b - a).cross(c - a).length_squared();
            if area2 > 1.0e-16 {
                kept.extend_from_slice(tri);
            }
        }
        if kept.is_empty() {
            return;
        }
        let vbase = self.vertices.len() as u32;
        let ibase = self.indices.len() as u32;
        for (pos, nrm) in verts {
            self.vertices.push(Vertex { pos: *pos, nrm: *nrm, uv: [0.0, 0.0] });
        }
        self.indices.extend_from_slice(&kept);
        self.primitives.push(Primitive {
            vertex_offset: vbase,
            index_offset: ibase,
            vertex_count: verts.len() as u32,
            index_count: kept.len() as u32,
            material_id,
        });
    }

    /// Validate the geometry contract required by Metal acceleration
    /// structures. Vulkan is permissive about a collapsed triangle, but
    /// Apple's builder can reject it or terminate the command buffer; keep
    /// this check beside the shared scene representation so a later geometry
    /// pass cannot reintroduce a backend-only crash.
    pub fn validate_acceleration_geometry(&self) -> Result<(), String> {
        for (pi, p) in self.primitives.iter().enumerate() {
            if p.vertex_count == 0 || p.index_count < 3 || p.index_count % 3 != 0 {
                return Err(format!("primitive {pi}: invalid vertex/index count ({}/{})", p.vertex_count, p.index_count));
            }
            let v_end = p.vertex_offset.checked_add(p.vertex_count).ok_or_else(|| format!("primitive {pi}: vertex range overflows"))? as usize;
            let i_end = p.index_offset.checked_add(p.index_count).ok_or_else(|| format!("primitive {pi}: index range overflows"))? as usize;
            if v_end > self.vertices.len() || i_end > self.indices.len() {
                return Err(format!("primitive {pi}: vertex/index range is outside the scene buffers"));
            }
            for (ti, tri) in self.indices[p.index_offset as usize..i_end].chunks_exact(3).enumerate() {
                let [ia, ib, ic] = tri else { unreachable!() };
                let local = [*ia as usize, *ib as usize, *ic as usize];
                if local.iter().any(|&i| i >= p.vertex_count as usize) {
                    return Err(format!("primitive {pi} triangle {ti}: index is outside its vertex range"));
                }
                let a = Vec3::from(self.vertices[p.vertex_offset as usize + local[0]].pos);
                let b = Vec3::from(self.vertices[p.vertex_offset as usize + local[1]].pos);
                let c = Vec3::from(self.vertices[p.vertex_offset as usize + local[2]].pos);
                if !a.is_finite() || !b.is_finite() || !c.is_finite() {
                    return Err(format!("primitive {pi} triangle {ti}: non-finite vertex"));
                }
                if (b - a).cross(c - a).length_squared() <= 1.0e-16 {
                    return Err(format!("primitive {pi} triangle {ti}: zero-area geometry"));
                }
            }
        }
        Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mesh_ingest_drops_degenerate_triangles_and_empty_meshes() {
        let mut scene = Scene::new();
        let material = scene.new_material([1.0; 4], [0.0; 4], 1.0, 0.0);
        let verts = [
            ([0.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
            ([1.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
            ([0.0, 0.0, 1.0], [0.0, 1.0, 0.0]),
            ([2.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
        ];
        scene.add_mesh_world(&verts, &[0, 1, 2, 0, 3, 3], material);
        assert_eq!(scene.primitives.len(), 1);
        assert_eq!(scene.primitives[0].index_count, 3);

        scene.add_mesh_world(&verts, &[0, 3, 3], material);
        assert_eq!(scene.primitives.len(), 1, "a mesh with no usable triangles must not enter the AS");
        scene.validate_acceleration_geometry().expect("filtered mesh is a valid AS input");
    }
}
