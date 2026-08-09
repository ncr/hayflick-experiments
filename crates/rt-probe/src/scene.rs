//! Scene model — the procedural geometry the renderer consumes.
//!
//! Every primitive's geometry is authored directly in WORLD space (or in local
//! space for a TLAS-movable run), so the renderer uses one BLAS per primitive
//! with an identity instance transform. Materials carry a base colour,
//! emissive, metallic/roughness and the `_pad` flag/knob word.
//!
//! There is no asset importer: the glTF loader (`load_model` / `preload` /
//! `place`) and the whole base-colour TEXTURE path it fed — `LoadedImage`, the
//! scene image list, `Material.tex_index`, `Vertex.uv` and the four sampling
//! branches in the shader twins — were deleted 2026-07-28. It had had zero
//! callers since the greybox directive (ARCHITECTURE.md, 2026-06-13: the game
//! scene uses no textured GLBs), which meant `tex_index` was `-1` on every
//! material ever built, `images` was always empty, and both backends pushed a
//! 1×1 white dummy purely to keep a bindless array non-empty. It was also the
//! project's one real twin divergence: `probes.comp` sampled the texture,
//! `probes.metal` did not.

use glam::{Mat4, Vec3};

#[repr(C)]
#[derive(Clone, Copy)]
pub struct Vertex {
    pub pos: [f32; 3],
    pub nrm: [f32; 3],
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
    /// FREE — 4 bytes nobody reads (was the glTF base-colour texture index).
    /// It stays in the struct because `Material` MUST be 48 B: MSL rounds any
    /// struct containing a `float4` up to a multiple of 16, so dropping the
    /// word would leave the host and the GLSL twin at 44 B and the Metal twin
    /// at 48 — a stride mismatch on the backend this box cannot compile. The
    /// `_pad` knob budget is documented as FULL (crates/rt-viewer/src/wear.rs);
    /// this is where the next per-material dial goes.
    pub _rsv: i32,
    pub _pad: i32,
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

impl Scene {
    pub fn new() -> Self {
        Scene {
            min: Vec3::splat(f32::INFINITY),
            max: Vec3::splat(f32::NEG_INFINITY),
            lighting: [1.0, 1.0, 0.0, 1.0], // full sun/sky, no fog
            ..Default::default()
        }
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

    /// Add a flat horizontal quad (a procedural floor) spanning `[xmin,xmax] ×
    /// [zmin,zmax]` at height `y` — the ground plane for procedural scenes.
    pub fn add_floor(&mut self, xmin: f32, xmax: f32, zmin: f32, zmax: f32, y: f32, color: [f32; 4]) {
        let material_id = self.materials.len() as i32;
        self.materials.push(Material { base_color: color, emissive: [0.0; 4], metallic: 0.0, roughness: 0.92, _rsv: 0, _pad: 0 });
        let vbase = self.vertices.len() as u32;
        let ibase = self.indices.len() as u32;
        let n = [0.0, 1.0, 0.0];
        for &(x, z) in &[(xmin, zmin), (xmax, zmin), (xmax, zmax), (xmin, zmax)] {
            self.vertices.push(Vertex { pos: [x, y, z], nrm: n });
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

    /// Mint one material and return its id — what `add_box` does before it
    /// emits its six faces, exposed so a caller can build a NON-box prim on the
    /// same terms.
    ///
    /// It was exposed FOR the eased-arris box→mesh promoter, which is deleted
    /// (2026-07-26); `add_box` is its only caller today. What outlives that
    /// promoter is the RULE it had to obey and the next box→mesh pass will too:
    /// a promoted box stays ONE primitive with ONE material, or every per-box
    /// mark keyed by prim index (the occluder / glass / matte bits, the wear
    /// paint lanes, the smash and roof-tear TLAS hides) addresses the wrong
    /// thing.
    pub fn new_material(&mut self, color: [f32; 4], emissive: [f32; 4], roughness: f32, metallic: f32) -> i32 {
        self.materials.push(Material { base_color: color, emissive, metallic, roughness, _rsv: 0, _pad: 0 });
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
                self.vertices.push(Vertex { pos: p, nrm: n });
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
            self.vertices.push(Vertex { pos: *pos, nrm: *nrm });
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
