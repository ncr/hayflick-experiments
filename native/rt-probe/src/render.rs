//! GPU renderer core: everything derived from a `Scene` — geometry/material
//! buffers, bindless textures, BLAS-per-primitive + TLAS, the two compute
//! pipelines (per-frame deterministic shade + startup probe bake), the NEE
//! light list with animated practicals, and the world-space GI probe cache.
//!
//! The renderer is DETERMINISTIC: shade.comp is a pure function of
//! (scene, camera) — one primary ray per pixel centre, exact shadow rays,
//! GI from the frozen probe cache. Monte Carlo runs exactly once, at startup,
//! inside `bake_probes` (probes.comp), into TWO probe banks (practicals off /
//! full) that the shader lerps by the room-lights dim — light transport is
//! linear in emission, so any dim level is exact with no re-bake.

use crate::gpu::{dslb, Buffer, Ctx, GpuTex};
use crate::iso::CamFrame;
use crate::scene::{self, Scene, Vertex};
use ash::vk;
use glam::{Mat4, Vec3};
use std::collections::BTreeMap;
use std::ffi::CString;

/// Compiled tonemap/blit shader. All SPIR-V is produced by rt-probe's
/// build.rs (rt-viewer has no build script), so the viewer's swapchain
/// tonemap pipeline pulls its bytes from here.
pub const TONE_SPV: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/tonemap.comp.spv"));

/// Push constants for shade.comp. Field names match the shader's `pc` block.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct ShadePush {
    pub cam_right: [f32; 4],
    pub cam_up: [f32; 4],
    pub cam_dir: [f32; 4], // w = RT-AO radius (wu)
    pub cam_pos: [f32; 4], // w = RT-AO strength
    pub width: i32,
    pub height: i32,
    pub ao_rays: i32,
    pub debug: i32, // 0 off, 1 albedo, 2 probe GI, 3 direct only, 4 AO term
    /// Room-lights dim in 16.16 fixed point — the probe-bank lerp factor.
    pub room_lights16: i32,
    pub light_count: i32,
    pub _r0: i32,
    pub _r1: i32,
    pub env0: [f32; 4], // sun, sky, fog density, fog height
    /// Dollhouse see-through region of interest (CAVE_ROI). `roi` = player world
    /// xyz + disc radius (low-res px); `roi2` = projected player pixel xy +
    /// disc falloff px + enabled flag (>0.5). Disabled → both zeroed and the
    /// shader early-outs, reproducing the pre-ROI image bit-for-bit.
    pub roi: [f32; 4],
    pub roi2: [f32; 4],
}

/// Packed CAVE_ROI see-through reveal fields for [`ShadePush`] / the Metal `Push` twin.
#[derive(Clone, Copy)]
pub struct RoiPush {
    pub roi: [f32; 4],
    pub roi2: [f32; 4],
}

/// Disabled ROI: shader sees `roi2.w == 0` and skips the whole reveal block.
pub const ROI_OFF: RoiPush = RoiPush { roi: [0.0; 4], roi2: [0.0; 4] };

/// Build the ROI push fields for a player at world `p`, projecting the disc
/// centre with the shared [`iso::project_lowres`] so Metal and Vulkan agree.
/// `ghost` (0..1] is the max reveal coverage at the disc centre: <1 leaves a
/// faint Bayer-stipple ghost of the wall (the x-ray look). Doubles as the
/// shader's enable flag (`roi2.w > 0`).
pub fn roi_push(cam: &CamFrame, w: i32, h: i32, p: Vec3, radius_px: f32, falloff_px: f32, ghost: f32) -> RoiPush {
    let (px, py) = crate::iso::project_lowres(cam, w, h, p);
    RoiPush { roi: [p.x, p.y, p.z, radius_px], roi2: [px, py, falloff_px, ghost] }
}

impl ShadePush {
    #[allow(clippy::too_many_arguments)]
    pub fn new(cam: &CamFrame, w: u32, h: u32, env0: [f32; 4], room_lights: f32, light_count: i32, ao: f32, ao_r: f32, ao_rays: i32, debug: i32) -> ShadePush {
        ShadePush {
            cam_right: [cam.right.x, cam.right.y, cam.right.z, cam.half_w],
            cam_up: [cam.up.x, cam.up.y, cam.up.z, cam.half_h],
            cam_dir: [cam.dir.x, cam.dir.y, cam.dir.z, ao_r],
            cam_pos: [cam.pos.x, cam.pos.y, cam.pos.z, ao],
            width: w as i32,
            height: h as i32,
            ao_rays,
            debug,
            room_lights16: (room_lights * 65536.0).round() as i32,
            light_count,
            _r0: 0,
            _r1: 0,
            env0,
            roi: ROI_OFF.roi,
            roi2: ROI_OFF.roi2,
        }
    }
}

/// Push constants for probes.comp (same pipeline layout as shade — the camera
/// block is unused padding; only env0 carries through).
#[repr(C)]
#[derive(Clone, Copy)]
struct ProbePush {
    _cam: [f32; 16],
    probe_count: i32,
    rays_total: i32, // the full spherical-Fibonacci set size N
    bounces: i32,
    batch_rays: i32,
    batch_start: i32,
    bank: i32, // 0 = practicals off (sun/sky only), 1 = full
    light_count: i32,
    _r0: i32,
    env0: [f32; 4],
    _roi: [f32; 8], // pad to ShadePush size (shared push-constant range); unused by probes.comp
}

pub fn push_bytes<T: Copy>(p: &T) -> &[u8] {
    unsafe { std::slice::from_raw_parts((p as *const T) as *const u8, std::mem::size_of::<T>()) }
}

// ---- typed renderer surface (the only things the game side ever sees) ------

/// NEE light-list slot of a named light, frozen at `SceneGpu::build` — names
/// join onto the EXISTING emissive-scan order (pinned by the no-reorder test).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct LightKey(u32);

/// Handle of a named dynamic run (player, door leaves) for per-frame
/// instance-transform updates through `FrameState.instances`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct InstanceKey(u32);

// Opaque-key (de)construction for backends that build their own handle maps
// outside this crate (the Metal backend mirrors SceneGpu's dynamic-run join).
// The Vulkan path constructs these directly (same crate); these accessors keep
// the wrapped index private while letting another crate round-trip a key.
impl LightKey {
    pub fn from_index(i: u32) -> LightKey {
        LightKey(i)
    }
    pub fn index(self) -> u32 {
        self.0
    }
}
impl InstanceKey {
    pub fn from_index(i: u32) -> InstanceKey {
        InstanceKey(i)
    }
    pub fn index(self) -> u32 {
        self.0
    }
}

/// Name → handle maps built once at `SceneGpu::build`; the viewer adapter
/// joins game ids onto these (and must report missing names loudly).
pub struct SceneHandles {
    pub lights: BTreeMap<String, LightKey>,
    pub instances: BTreeMap<String, InstanceKey>,
}

/// Reserved trailing NEE spotlight slots (flashlight + muzzle flash). The
/// slot count, the shade-dispatch `light_count + n_active` arithmetic, and
/// the probe-bake exclusion (the bake uses bare `light_count`) generalize
/// TOGETHER — an off-by-one leaks a moving spotlight into the frozen GI.
pub const N_RESERVED: usize = 2;

/// A transient/held spotlight (player flashlight, muzzle flash) — replaces
/// the raw `[f32; 12]` slot writes the viewer used to hand-build.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Spotlight {
    pub pos: Vec3,
    pub dir: Vec3,
    pub cone_cos: f32, // cos of the outer half-angle
    pub power: f32,    // packed slot radiance (the viewer maps its knob via ×1500)
    pub radius: f32,   // emitter radius (wu); tiny → huge radiance for a visible pool
}

impl Spotlight {
    /// Pack into the NEE light record shade.comp expects. `dir.w = 2.0` marks
    /// the spotlight cone path (color.w = cos outer half-angle, soft edge over
    /// the outer 40%); the rgb carries the warm white the flashlight always
    /// used (1.0 / 0.97 / 0.88 of `power`).
    pub fn pack(&self) -> [f32; 12] {
        let c = self.power;
        [self.pos.x, self.pos.y, self.pos.z, self.radius, c, c * 0.97, c * 0.88, self.cone_cos, self.dir.x, self.dir.y, self.dir.z, 2.0]
    }
}

/// Everything the game/viewer hands the renderer for one frame. Consumed by
/// `SceneGpu::record_frame`; nothing else crosses per frame.
pub struct FrameState<'a> {
    pub cam: CamFrame,
    /// Room-lights master dim — probe-bank lerp factor (instant GI switch).
    pub room_lights: f32,
    /// SIM time (ticks · TICK_DT) — replayable; no wall clock below the shell.
    pub time: f32,
    /// Game-authored per-light rgb — THE light animation (flicker curves live
    /// in house-game now). Applied to the NEE record and the linked material,
    /// so the visible fixture matches the light it casts; slots not addressed
    /// keep their previous (initial = authored base) values.
    pub light_emission: &'a [(LightKey, [f32; 3])],
    /// Active spotlights, packed into the ≤ N_RESERVED trailing NEE slots.
    pub spotlights: &'a [Spotlight],
    /// Mover transforms — patched into inst_buf; any change rebuilds the TLAS.
    pub instances: &'a [(InstanceKey, Mat4)],
}

/// CPU half of the NEE light-list build, factored out of `SceneGpu::build` so
/// the slot order is testable without a GPU: scan emissive primitives in
/// PRIMITIVE ORDER (dynamic runs skipped), append the conceptual point
/// lights, then the N_RESERVED zeroed spotlight slots; join the scene's named
/// lights (prims AND point lights) onto the resulting slot order.
pub struct LightScan {
    pub lights: Vec<[f32; 12]>, // light_count real records + N_RESERVED reserved
    /// Per real light: (material id or -1, authored base rgb, screen flag —
    /// device lights bake at base into BOTH probe banks). Flicker curves live
    /// in the game; the renderer keeps no animation knowledge.
    pub light_link: Vec<(i32, [f32; 3], bool)>,
    pub names: BTreeMap<String, LightKey>,
    pub light_count: u32,
    pub flash_idx: usize, // first reserved slot (== light_count)
}

pub fn scan_lights(scene: &Scene) -> Result<LightScan, String> {
    // dynamic prims never join the scan: their light would bake into the
    // frozen GI at the START pose and stay there as they move
    let mut dyn_flag = vec![false; scene.primitives.len()];
    for (_, first, count, _) in scene.dynamic_list() {
        for f in &mut dyn_flag[first..first + count] {
            *f = true;
        }
    }
    // emissive light list for NEE: small bright emitters (lamps, sconces)
    // never converge by random bounces alone, so the shader samples them
    // directly. Per emissive primitive: bounding sphere, radiance, and the
    // area-weighted MEAN SURFACE NORMAL — a screen or panel emits one-sided
    // (Lambertian) toward its facing, not isotropically (an isotropic screen
    // lights the floor BEHIND the desk, which reads as the light re-aiming
    // itself as the camera orbits). Emitters whose normals point many ways
    // (focus < 0.7) stay isotropic.
    // Record: [cx, cy, cz, radius, r, g, b, 0, nx, ny, nz, directionalFlag].
    let mut lights: Vec<[f32; 12]> = Vec::new();
    // per-light link: (material id or -1, base rgb, authored screen flag)
    let mut light_link: Vec<(i32, [f32; 3], bool)> = Vec::new();
    let mut slot_of_prim: Vec<(usize, u32)> = Vec::new(); // (prim, NEE slot)
    for (i, p) in scene.primitives.iter().enumerate() {
        if dyn_flag[i] {
            continue;
        }
        let e = scene.materials[p.material_id as usize].emissive;
        if e[0].max(e[1]).max(e[2]) < 3.0 {
            continue;
        }
        light_link.push((p.material_id, [e[0], e[1], e[2]], scene.screen_prims.contains(&i)));
        let vs = &scene.vertices[p.vertex_offset as usize..(p.vertex_offset + p.vertex_count) as usize];
        let idx = &scene.indices[p.index_offset as usize..(p.index_offset + p.index_count) as usize];
        // bound the vertices the indices actually REFERENCE, not the whole
        // vertex window — carved prims (PET screen) share their parent's
        // window, and bounding that puts the light at the prop's center
        // with the prop's radius instead of on the carved surface
        let mut mn = Vec3::splat(f32::INFINITY);
        let mut mx = Vec3::splat(f32::NEG_INFINITY);
        for &i in idx {
            let v = Vec3::from(vs[i as usize].pos);
            mn = mn.min(v);
            mx = mx.max(v);
        }
        let c = (mn + mx) * 0.5;
        let r = (mx - mn).length() * 0.5;
        let mut nsum = Vec3::ZERO;
        let mut area2 = 0.0f32;
        for t in idx.chunks_exact(3) {
            let a = Vec3::from(vs[t[0] as usize].pos);
            let b = Vec3::from(vs[t[1] as usize].pos);
            let c2 = Vec3::from(vs[t[2] as usize].pos);
            let f = (b - a).cross(c2 - a); // face normal * 2A
            nsum += f;
            area2 += f.length();
        }
        let focus = if area2 > 1e-9 { nsum.length() / area2 } else { 0.0 };
        let authored = scene.prim_light_dir.get(i).copied().unwrap_or([0.0; 3]);
        let (nd, df) = if authored != [0.0; 3] {
            (Vec3::from(authored).normalize(), 1.0) // authored facing (e.g. screens)
        } else if focus > 0.7 {
            (nsum.normalize(), 1.0) // open emissive surface: geometric facing
        } else {
            (Vec3::ZERO, 0.0) // closed/mixed shape (boxes): isotropic
        };
        println!("  NEE light: pos ({:.1},{:.1},{:.1}) r {:.2} rgb ({:.1},{:.1},{:.1}) focus {:.2} -> {}", c.x, c.y, c.z, r, e[0], e[1], e[2], focus, if df > 0.0 { "directional" } else { "isotropic" });
        slot_of_prim.push((i, lights.len() as u32));
        lights.push([c.x, c.y, c.z, r, e[0], e[1], e[2], 0.0, nd.x, nd.y, nd.z, df]);
    }
    let emissive_count = lights.len() as u32; // point-light slots start here
    for pl in &scene.point_lights {
        // conceptual (geometry-less) lights stay isotropic
        lights.push([pl[0], pl[1], pl[2], pl[3], pl[4], pl[5], pl[6], pl[7], 0.0, 0.0, 0.0, 0.0]);
        light_link.push((-1, [pl[4], pl[5], pl[6]], false));
    }
    let light_count = lights.len() as u32;
    // join the authored names onto the frozen slot order — loudly
    let mut names: BTreeMap<String, LightKey> = BTreeMap::new();
    for (name, prim) in &scene.named_lights {
        let slot = slot_of_prim.iter().find(|&&(p, _)| p == *prim).map(|&(_, s)| s).ok_or_else(|| format!("named light {name:?}: prim {prim} landed no NEE slot (dim emissive, or a dynamic prim)"))?;
        if names.insert(name.clone(), LightKey(slot)).is_some() {
            return Err(format!("named light {name:?}: duplicate name"));
        }
    }
    for (name, idx) in &scene.named_point_lights {
        if *idx >= scene.point_lights.len() {
            return Err(format!("named point light {name:?}: index {idx} out of range ({} point lights)", scene.point_lights.len()));
        }
        if names.insert(name.clone(), LightKey(emissive_count + *idx as u32)).is_some() {
            return Err(format!("named point light {name:?}: duplicate name"));
        }
    }
    // reserved spotlight slots: the viewer/game streams transient spotlights
    // (dir.w = 2.0 → cone falloff in shade.comp) into these trailing entries.
    // They sit PAST light_count so the frozen probe bake never sees them — a
    // light that moves must stay direct-only. The shade dispatch passes
    // light_count + n_active. (Also keeps the binding valid in scenes with
    // zero real lights.)
    let flash_idx = lights.len();
    for _ in 0..N_RESERVED {
        lights.push([0.0; 12]);
    }
    Ok(LightScan { lights, light_link, names, light_count, flash_idx })
}


/// glam column-major Mat4 -> Vulkan row-major 3x4 instance transform.
pub fn mat_to_transform(m: Mat4) -> vk::TransformMatrixKHR {
    let c = m.to_cols_array(); // column-major: c[col*4 + row]
    let mut t = [0.0f32; 12];
    for row in 0..3 {
        for col in 0..4 {
            t[row * 4 + col] = c[col * 4 + row];
        }
    }
    vk::TransformMatrixKHR { matrix: t }
}

fn tlas_geometry(addr: u64) -> vk::AccelerationStructureGeometryKHR<'static> {
    vk::AccelerationStructureGeometryKHR::default()
        .geometry_type(vk::GeometryTypeKHR::INSTANCES)
        .flags(vk::GeometryFlagsKHR::OPAQUE)
        .geometry(vk::AccelerationStructureGeometryDataKHR {
            instances: vk::AccelerationStructureGeometryInstancesDataKHR::default().array_of_pointers(false).data(vk::DeviceOrHostAddressConstKHR { device_address: addr }),
        })
}

pub unsafe fn make_pool(ctx: &Ctx, ntex: u32) -> vk::DescriptorPool {
    let sizes = [
        vk::DescriptorPoolSize { ty: vk::DescriptorType::ACCELERATION_STRUCTURE_KHR, descriptor_count: 1 },
        vk::DescriptorPoolSize { ty: vk::DescriptorType::STORAGE_IMAGE, descriptor_count: 3 },
        vk::DescriptorPoolSize { ty: vk::DescriptorType::STORAGE_BUFFER, descriptor_count: 6 },
        vk::DescriptorPoolSize { ty: vk::DescriptorType::COMBINED_IMAGE_SAMPLER, descriptor_count: ntex.max(1) },
    ];
    ctx.device.create_descriptor_pool(&vk::DescriptorPoolCreateInfo::default().max_sets(1).pool_sizes(&sizes), None).unwrap()
}

/// Write the scene descriptor set: TLAS + the three per-view storage images
/// (radiance out, albedo G-buffer, world-position G-buffer) + the scene
/// buffers + bindless textures + the probe cache.
#[allow(clippy::too_many_arguments)]
pub unsafe fn make_set(
    ctx: &Ctx,
    gpu: &SceneGpu,
    pool: vk::DescriptorPool,
    color_view: vk::ImageView,
    albedo_view: vk::ImageView,
    pos_view: vk::ImageView,
) -> vk::DescriptorSet {
    let layouts = [gpu.set_layout];
    let set = ctx.device.allocate_descriptor_sets(&vk::DescriptorSetAllocateInfo::default().descriptor_pool(pool).set_layouts(&layouts)).unwrap()[0];

    let tlas_arr = [gpu.tlas];
    let mut as_ext = vk::WriteDescriptorSetAccelerationStructureKHR::default().acceleration_structures(&tlas_arr);
    let mut w_as = vk::WriteDescriptorSet::default().dst_set(set).dst_binding(0).descriptor_type(vk::DescriptorType::ACCELERATION_STRUCTURE_KHR).push_next(&mut as_ext);
    w_as.descriptor_count = 1;

    let img = |view: vk::ImageView| [vk::DescriptorImageInfo::default().image_view(view).image_layout(vk::ImageLayout::GENERAL)];
    let buf = |b: &Buffer| [vk::DescriptorBufferInfo::default().buffer(b.buffer).range(vk::WHOLE_SIZE)];
    let color_info = img(color_view);
    let alb_info = img(albedo_view);
    let pos_info = img(pos_view);
    let vb = buf(&gpu.vbuf);
    let ib = buf(&gpu.ibuf);
    let gb = buf(&gpu.gbuf);
    let mb = buf(&gpu.mbuf);
    let lb = buf(&gpu.lbuf);
    let pb = buf(&gpu.probe_buf);
    let tex_info: Vec<vk::DescriptorImageInfo> = gpu.texes.iter().map(|t| vk::DescriptorImageInfo::default().image_view(t.view).sampler(gpu.sampler).image_layout(vk::ImageLayout::SHADER_READ_ONLY_OPTIMAL)).collect();

    let writes = [
        w_as,
        vk::WriteDescriptorSet::default().dst_set(set).dst_binding(1).descriptor_type(vk::DescriptorType::STORAGE_IMAGE).image_info(&color_info),
        vk::WriteDescriptorSet::default().dst_set(set).dst_binding(2).descriptor_type(vk::DescriptorType::STORAGE_BUFFER).buffer_info(&vb),
        vk::WriteDescriptorSet::default().dst_set(set).dst_binding(3).descriptor_type(vk::DescriptorType::STORAGE_BUFFER).buffer_info(&ib),
        vk::WriteDescriptorSet::default().dst_set(set).dst_binding(4).descriptor_type(vk::DescriptorType::STORAGE_BUFFER).buffer_info(&gb),
        vk::WriteDescriptorSet::default().dst_set(set).dst_binding(5).descriptor_type(vk::DescriptorType::STORAGE_BUFFER).buffer_info(&mb),
        vk::WriteDescriptorSet::default().dst_set(set).dst_binding(6).descriptor_type(vk::DescriptorType::COMBINED_IMAGE_SAMPLER).image_info(&tex_info),
        vk::WriteDescriptorSet::default().dst_set(set).dst_binding(7).descriptor_type(vk::DescriptorType::STORAGE_BUFFER).buffer_info(&lb),
        vk::WriteDescriptorSet::default().dst_set(set).dst_binding(8).descriptor_type(vk::DescriptorType::STORAGE_IMAGE).image_info(&alb_info),
        vk::WriteDescriptorSet::default().dst_set(set).dst_binding(9).descriptor_type(vk::DescriptorType::STORAGE_IMAGE).image_info(&pos_info),
        vk::WriteDescriptorSet::default().dst_set(set).dst_binding(10).descriptor_type(vk::DescriptorType::STORAGE_BUFFER).buffer_info(&pb),
    ];
    ctx.device.update_descriptor_sets(&writes, &[]);
    set
}

/// All GPU resources derived from a `Scene`.
pub struct SceneGpu {
    pub vbuf: Buffer,
    pub ibuf: Buffer,
    pub gbuf: Buffer,
    pub mbuf: Buffer,
    pub lbuf: Buffer, // emissive light list for NEE (see build)
    pub light_count: u32,
    /// Index of the reserved flashlight slot in `lights_cpu` (== light_count;
    /// past the probe bake's light range, so the frozen cache never sees it).
    pub flash_idx: usize,
    // per-frame light streaming (record_frame): CPU shadows of lbuf/mbuf, the
    // per-light link (material id or -1, base rgb, screen flag), and the
    // persistent host-visible staging buffers for the per-frame copies
    pub lights_cpu: Vec<[f32; 12]>,
    pub mats_cpu: Vec<scene::Material>,
    pub light_link: Vec<(i32, [f32; 3], bool)>,
    pub light_stage: Buffer,
    pub mat_stage: Buffer,
    pub texes: Vec<GpuTex>,
    pub sampler: vk::Sampler,
    pub blas_list: Vec<(vk::AccelerationStructureKHR, Buffer, Buffer)>,
    pub tlas: vk::AccelerationStructureKHR,
    pub tlas_buf: Buffer,
    pub tlas_scratch: Buffer,
    pub inst_buf: Buffer, // host-visible: dynamic instance transforms are updated in place
    pub n_inst: u32,
    pub dynamic_instance: Option<u32>, // TLAS instance index of the movable player (legacy shim)
    /// Name → key maps for the game-facing surface (lights frozen at the
    /// emissive-scan order, instances at the dynamic-run order).
    pub handles: SceneHandles,
    /// Per dynamic run: (first TLAS instance, instance count) — `InstanceKey`
    /// indexes this table.
    pub dyn_insts: Vec<(u32, u32)>,
    /// CPU shadow of each run's last-patched transform: `record_frame` skips
    /// the patch (and the TLAS rebuild) when a mover didn't actually move.
    dyn_shadow: Vec<Mat4>,
    /// Spotlights packed into the reserved trailing slots by the last
    /// `record_frame` — the shade dispatch passes `light_count + n_spot_active`.
    pub n_spot_active: u32,
    /// An instance transform or visibility mask changed since the last
    /// recorded rebuild; `record_frame` consumes it.
    pub tlas_dirty: bool,
    pub set_layout: vk::DescriptorSetLayout,
    pub pipeline_layout: vk::PipelineLayout,
    /// Deterministic per-frame shade pass (shade.comp) — primary ray + exact
    /// shadow rays + probe-cache GI; zero per-frame randomness.
    pub shade_pipeline: vk::Pipeline,
    pub shade_shader: vk::ShaderModule,
    /// World-space irradiance probe bake (probes.comp) + its cache buffer:
    /// 16-float header (origin, spacing, dims) + 2 banks × 20 floats per probe
    /// (6-face ambient cube sums + ray count).
    pub probe_pipeline: vk::Pipeline,
    pub probe_shader: vk::ShaderModule,
    pub probe_buf: Buffer,
    pub probe_count: u32,
    probes_baked: bool,
}

impl SceneGpu {
    /// Upload scene buffers + textures, build one BLAS per primitive + a TLAS,
    /// and create the shade + probe compute pipelines + descriptor layout.
    pub unsafe fn build(ctx: &Ctx, scene: &Scene, probe_spacing: f32) -> Result<SceneGpu, Box<dyn std::error::Error>> {
        let vbuf = ctx.device_local(&scene.vertices, vk::BufferUsageFlags::STORAGE_BUFFER | vk::BufferUsageFlags::ACCELERATION_STRUCTURE_BUILD_INPUT_READ_ONLY_KHR | vk::BufferUsageFlags::SHADER_DEVICE_ADDRESS);
        let ibuf = ctx.device_local(&scene.indices, vk::BufferUsageFlags::STORAGE_BUFFER | vk::BufferUsageFlags::ACCELERATION_STRUCTURE_BUILD_INPUT_READ_ONLY_KHR | vk::BufferUsageFlags::SHADER_DEVICE_ADDRESS);
        let geom_infos = scene.geom_infos();
        let gbuf = ctx.device_local(&geom_infos, vk::BufferUsageFlags::STORAGE_BUFFER);
        let mbuf = ctx.device_local(&scene.materials, vk::BufferUsageFlags::STORAGE_BUFFER | vk::BufferUsageFlags::TRANSFER_DST);

        // ---- NEE light list (scan factored into `scan_lights` — slot order
        // pinned by CPU tests) + the scene's name → handle joins
        let LightScan { lights, light_link, names: light_names, light_count, flash_idx } = scan_lights(scene)?;
        // TRANSFER_DST so record_frame can stream the per-frame light state in
        let lbuf = ctx.device_local(&lights, vk::BufferUsageFlags::STORAGE_BUFFER | vk::BufferUsageFlags::TRANSFER_DST);
        let host = vk::MemoryPropertyFlags::HOST_VISIBLE | vk::MemoryPropertyFlags::HOST_COHERENT;
        let light_stage = ctx.create_buffer(std::mem::size_of_val(&lights[..]) as u64, vk::BufferUsageFlags::TRANSFER_SRC, host);
        let mat_stage = ctx.create_buffer(std::mem::size_of_val(&scene.materials[..]) as u64, vk::BufferUsageFlags::TRANSFER_SRC, host);
        let lights_cpu = lights.clone();
        let mats_cpu = scene.materials.clone();

        let mut texes: Vec<GpuTex> = scene.images.iter().map(|im| ctx.upload_texture(im)).collect();
        if texes.is_empty() {
            let white = scene::LoadedImage { width: 1, height: 1, pixels: vec![255, 255, 255, 255] };
            texes.push(ctx.upload_texture(&white));
        }
        let sampler = ctx.device.create_sampler(
            &vk::SamplerCreateInfo::default().mag_filter(vk::Filter::NEAREST).min_filter(vk::Filter::NEAREST).address_mode_u(vk::SamplerAddressMode::REPEAT).address_mode_v(vk::SamplerAddressMode::REPEAT),
            None,
        )?;

        // ---- BLAS per primitive ----
        let as_storage = vk::BufferUsageFlags::ACCELERATION_STRUCTURE_STORAGE_KHR | vk::BufferUsageFlags::SHADER_DEVICE_ADDRESS;
        let scratch_usage = vk::BufferUsageFlags::STORAGE_BUFFER | vk::BufferUsageFlags::SHADER_DEVICE_ADDRESS;
        let mut blas_addrs: Vec<u64> = Vec::with_capacity(scene.primitives.len());
        let mut blas_list: Vec<(vk::AccelerationStructureKHR, Buffer, Buffer)> = Vec::new();
        for p in &scene.primitives {
            let tris = vk::AccelerationStructureGeometryTrianglesDataKHR::default()
                .vertex_format(vk::Format::R32G32B32_SFLOAT)
                .vertex_data(vk::DeviceOrHostAddressConstKHR { device_address: vbuf.address })
                .vertex_stride(std::mem::size_of::<Vertex>() as u64)
                .max_vertex(p.vertex_count - 1)
                .index_type(vk::IndexType::UINT32)
                .index_data(vk::DeviceOrHostAddressConstKHR { device_address: ibuf.address });
            let geos = [vk::AccelerationStructureGeometryKHR::default().geometry_type(vk::GeometryTypeKHR::TRIANGLES).flags(vk::GeometryFlagsKHR::OPAQUE).geometry(vk::AccelerationStructureGeometryDataKHR { triangles: tris })];
            let nt = p.index_count / 3;
            let mut build = vk::AccelerationStructureBuildGeometryInfoKHR::default()
                .ty(vk::AccelerationStructureTypeKHR::BOTTOM_LEVEL)
                .flags(vk::BuildAccelerationStructureFlagsKHR::PREFER_FAST_TRACE)
                .mode(vk::BuildAccelerationStructureModeKHR::BUILD)
                .geometries(&geos);
            let mut sizes = vk::AccelerationStructureBuildSizesInfoKHR::default();
            ctx.as_dev.get_acceleration_structure_build_sizes(vk::AccelerationStructureBuildTypeKHR::DEVICE, &build, &[nt], &mut sizes);
            let asbuf = ctx.create_buffer(sizes.acceleration_structure_size, as_storage, vk::MemoryPropertyFlags::DEVICE_LOCAL);
            let blas = ctx.as_dev.create_acceleration_structure(&vk::AccelerationStructureCreateInfoKHR::default().buffer(asbuf.buffer).size(sizes.acceleration_structure_size).ty(vk::AccelerationStructureTypeKHR::BOTTOM_LEVEL), None)?;
            let scratch = ctx.create_buffer(sizes.build_scratch_size, scratch_usage, vk::MemoryPropertyFlags::DEVICE_LOCAL);
            build = build.dst_acceleration_structure(blas).scratch_data(vk::DeviceOrHostAddressKHR { device_address: scratch.address });
            let range = vk::AccelerationStructureBuildRangeInfoKHR::default().primitive_count(nt).primitive_offset(p.index_offset * 4).first_vertex(p.vertex_offset);
            ctx.one_time(|cmd| ctx.as_dev.cmd_build_acceleration_structures(cmd, &[build], &[&[range]]));
            blas_addrs.push(ctx.as_dev.get_acceleration_structure_device_address(&vk::AccelerationStructureDeviceAddressInfoKHR::default().acceleration_structure(blas)));
            blas_list.push((blas, asbuf, scratch));
        }

        // ---- TLAS ----
        // Most primitives are baked to world space -> identity instances.
        // Dynamic runs (the movable player, named movers) are in local space
        // -> their instances carry the start transform and are updated per
        // frame (dynamic scene). One instance per primitive, 1:1.
        // backend-agnostic instance/mask table (the dynamic-run join, the build-
        // time masks, the per-run patch ranges + CPU transform
        // shadow) — shared with the Metal backend; see crate::gpu_scene.
        let dynamic_instance = scene.dynamic_prim.map(|p| p as u32); // Vulkan-only legacy shim
        let table = crate::gpu_scene::InstanceTable::build(scene)?;
        let identity = vk::TransformMatrixKHR { matrix: [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0] };
        let instances: Vec<vk::AccelerationStructureInstanceKHR> = blas_addrs
            .iter()
            .enumerate()
            .map(|(i, &addr)| vk::AccelerationStructureInstanceKHR {
                // statics keep the literal identity const (bit-identical to
                // mat_to_transform(IDENTITY)); dynamics carry their start xform.
                // mask: 0x05 dynamic (0x01 primary | 0x04 dynamic) / 0xff static.
                // Walls are seen through per-pixel on the primary ray (CAVE_ROI),
                // so there is no per-yaw instance hiding.
                transform: if table.is_dynamic[i] { mat_to_transform(table.transforms[i]) } else { identity },
                instance_custom_index_and_mask: vk::Packed24_8::new(i as u32, table.masks[i]),
                instance_shader_binding_table_record_offset_and_flags: vk::Packed24_8::new(0, vk::GeometryInstanceFlagsKHR::TRIANGLE_FACING_CULL_DISABLE.as_raw() as u8),
                acceleration_structure_reference: vk::AccelerationStructureReferenceKHR { device_handle: addr },
            })
            .collect();
        let handles = SceneHandles { lights: light_names, instances: table.instances };
        let dyn_insts = table.dyn_insts;
        let dyn_shadow = table.dyn_shadow;
        // host-visible so the dynamic instance transform can be patched in place
        let inst_buf = ctx.create_buffer(
            std::mem::size_of_val(&instances[..]) as u64,
            vk::BufferUsageFlags::ACCELERATION_STRUCTURE_BUILD_INPUT_READ_ONLY_KHR | vk::BufferUsageFlags::SHADER_DEVICE_ADDRESS,
            vk::MemoryPropertyFlags::HOST_VISIBLE | vk::MemoryPropertyFlags::HOST_COHERENT,
        );
        ctx.upload(&inst_buf, &instances);
        let n_inst = instances.len() as u32;

        let tlas_geos = [tlas_geometry(inst_buf.address)];
        let mut tlas_build = vk::AccelerationStructureBuildGeometryInfoKHR::default().ty(vk::AccelerationStructureTypeKHR::TOP_LEVEL).flags(vk::BuildAccelerationStructureFlagsKHR::PREFER_FAST_TRACE).mode(vk::BuildAccelerationStructureModeKHR::BUILD).geometries(&tlas_geos);
        let mut tlas_sizes = vk::AccelerationStructureBuildSizesInfoKHR::default();
        ctx.as_dev.get_acceleration_structure_build_sizes(vk::AccelerationStructureBuildTypeKHR::DEVICE, &tlas_build, &[n_inst], &mut tlas_sizes);
        let tlas_buf = ctx.create_buffer(tlas_sizes.acceleration_structure_size, as_storage, vk::MemoryPropertyFlags::DEVICE_LOCAL);
        let tlas = ctx.as_dev.create_acceleration_structure(&vk::AccelerationStructureCreateInfoKHR::default().buffer(tlas_buf.buffer).size(tlas_sizes.acceleration_structure_size).ty(vk::AccelerationStructureTypeKHR::TOP_LEVEL), None)?;
        let tlas_scratch = ctx.create_buffer(tlas_sizes.build_scratch_size, scratch_usage, vk::MemoryPropertyFlags::DEVICE_LOCAL);
        tlas_build = tlas_build.dst_acceleration_structure(tlas).scratch_data(vk::DeviceOrHostAddressKHR { device_address: tlas_scratch.address });
        let tlas_range = vk::AccelerationStructureBuildRangeInfoKHR::default().primitive_count(n_inst);
        ctx.one_time(|cmd| ctx.as_dev.cmd_build_acceleration_structures(cmd, &[tlas_build], &[&[tlas_range]]));

        // ---- descriptor layout + pipelines ----
        let bindings = [
            dslb(0, vk::DescriptorType::ACCELERATION_STRUCTURE_KHR, 1),
            dslb(1, vk::DescriptorType::STORAGE_IMAGE, 1), // radiance out
            dslb(2, vk::DescriptorType::STORAGE_BUFFER, 1), // vertices
            dslb(3, vk::DescriptorType::STORAGE_BUFFER, 1), // indices
            dslb(4, vk::DescriptorType::STORAGE_BUFFER, 1), // geom infos
            dslb(5, vk::DescriptorType::STORAGE_BUFFER, 1), // materials
            dslb(6, vk::DescriptorType::COMBINED_IMAGE_SAMPLER, texes.len() as u32),
            dslb(7, vk::DescriptorType::STORAGE_BUFFER, 1), // NEE lights
            dslb(8, vk::DescriptorType::STORAGE_IMAGE, 1), // albedo G-buffer (tonemap demodulation)
            dslb(9, vk::DescriptorType::STORAGE_IMAGE, 1), // world-position G-buffer (tonemap outline)
            dslb(10, vk::DescriptorType::STORAGE_BUFFER, 1), // irradiance probe cache
        ];
        let set_layout = ctx.device.create_descriptor_set_layout(&vk::DescriptorSetLayoutCreateInfo::default().bindings(&bindings), None)?;
        let set_layouts = [set_layout];
        let push_range = [vk::PushConstantRange::default().stage_flags(vk::ShaderStageFlags::COMPUTE).offset(0).size(std::mem::size_of::<ShadePush>() as u32)];
        let pipeline_layout = ctx.device.create_pipeline_layout(&vk::PipelineLayoutCreateInfo::default().set_layouts(&set_layouts).push_constant_ranges(&push_range), None)?;
        let name = CString::new("main").unwrap();
        let make_pipeline = |spv: &[u8]| -> Result<(vk::Pipeline, vk::ShaderModule), Box<dyn std::error::Error>> {
            let code = ash::util::read_spv(&mut std::io::Cursor::new(spv))?;
            let shader = ctx.device.create_shader_module(&vk::ShaderModuleCreateInfo::default().code(&code), None)?;
            let pipeline = ctx
                .device
                .create_compute_pipelines(vk::PipelineCache::null(), &[vk::ComputePipelineCreateInfo::default().stage(vk::PipelineShaderStageCreateInfo::default().stage(vk::ShaderStageFlags::COMPUTE).module(shader).name(&name)).layout(pipeline_layout)], None)
                .map_err(|(_, e)| e)?[0];
            Ok((pipeline, shader))
        };
        const SHADE_SPV: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/shade.comp.spv"));
        const PROBE_SPV: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/probes.comp.spv"));
        let (shade_pipeline, shade_shader) = make_pipeline(SHADE_SPV)?;
        let (probe_pipeline, probe_shader) = make_pipeline(PROBE_SPV)?;

        // ---- world-space irradiance probe grid (shared with Metal; the header
        // float buffer is what TWO banks of payload — bank 0 practicals off,
        // bank 1 full — hang off, zeroed until bake_probes fills them).
        let grid = crate::gpu_scene::ProbeGrid::build(scene.min, scene.max, probe_spacing);
        let probe_count = grid.count;
        let probe_buf = ctx.device_local(&grid.header, vk::BufferUsageFlags::STORAGE_BUFFER | vk::BufferUsageFlags::TRANSFER_DST);
        println!("probes: {}x{}x{} = {} @ spacing {:.2} wu ({:.1} MB x 2 banks)", grid.dims[0], grid.dims[1], grid.dims[2], probe_count, grid.spacing, probe_count as f32 * 80.0 / 1e6);

        Ok(SceneGpu { vbuf, ibuf, gbuf, mbuf, lbuf, light_count, flash_idx, lights_cpu, mats_cpu, light_link, light_stage, mat_stage, texes, sampler, blas_list, tlas, tlas_buf, tlas_scratch, inst_buf, n_inst, dynamic_instance, handles, dyn_insts, dyn_shadow, n_spot_active: 0, tlas_dirty: false, set_layout, pipeline_layout, shade_pipeline, shade_shader, probe_pipeline, probe_shader, probe_buf, probe_count, probes_baked: false })
    }

    /// Patch the movable player's instance transform (legacy per-field API —
    /// a shim over `set_instance_transform` so the dyn shadow stays coherent).
    /// Call `record_tlas_rebuild` (or `record_frame`) afterwards to apply it.
    pub unsafe fn set_player_transform(&mut self, ctx: &Ctx, m: Mat4) {
        let Some(i) = self.dynamic_instance else { return };
        let di = self.dyn_insts.iter().position(|&(first, _)| first == i).expect("legacy player run registered by build");
        self.set_instance_transform(ctx, InstanceKey(di as u32), m);
    }

    /// Patch a named dynamic run's instance transform in the host-visible
    /// instance buffer — a no-op when the transform is bit-unchanged (CPU
    /// shadow compare), so idle movers never force TLAS rebuilds. On change,
    /// marks the TLAS dirty; `record_frame` rebuilds it.
    pub unsafe fn set_instance_transform(&mut self, ctx: &Ctx, key: InstanceKey, m: Mat4) {
        let di = key.0 as usize;
        if self.dyn_shadow[di] == m {
            return;
        }
        let (first, count) = self.dyn_insts[di];
        let stride = std::mem::size_of::<vk::AccelerationStructureInstanceKHR>() as u64;
        let t = mat_to_transform(m);
        // the transform (12 f32) is the first field of each instance struct
        let ptr = ctx.device.map_memory(self.inst_buf.memory, first as u64 * stride, count as u64 * stride, vk::MemoryMapFlags::empty()).unwrap() as *mut u8;
        for k in 0..count as usize {
            std::ptr::copy_nonoverlapping(t.matrix.as_ptr(), ptr.add(k * stride as usize) as *mut f32, 12);
        }
        ctx.device.unmap_memory(self.inst_buf.memory);
        self.dyn_shadow[di] = m;
        self.tlas_dirty = true;
    }

    /// Record one frame's scene-state update, composing the existing calls in
    /// the existing order: lights CPU pass (game-authored emission + reserved
    /// spotlight slots) → patch mover instance transforms → stream lights/
    /// materials to the device → TLAS rebuild iff anything moved. Recorded
    /// command order and barriers are identical to the old viewer-driven
    /// sequence (practicals upload → TLAS rebuild → the caller's shade
    /// dispatch). Caller must hold the in-flight fence: this writes
    /// host-visible memory the GPU reads.
    pub unsafe fn record_frame(&mut self, ctx: &Ctx, cmd: vk::CommandBuffer, fs: &FrameState<'_>) {
        self.n_spot_active = frame_lights_cpu(&mut self.lights_cpu, &mut self.mats_cpu, &self.light_link, self.flash_idx, fs);
        for &(key, m) in fs.instances {
            self.set_instance_transform(ctx, key, m);
        }
        self.record_practicals_upload(ctx, cmd);
        if self.tlas_dirty {
            self.record_tlas_rebuild(ctx, cmd);
            self.tlas_dirty = false;
        }
    }

    /// GPU half of the per-frame light streaming: stage `lights_cpu` +
    /// `mats_cpu` and record the copies + barrier into `cmd` (BEFORE the
    /// shade dispatch). The reserved spotlight slots ride along in
    /// `lights_cpu`.
    pub unsafe fn record_practicals_upload(&self, ctx: &Ctx, cmd: vk::CommandBuffer) {
        ctx.upload(&self.light_stage, &self.lights_cpu);
        ctx.upload(&self.mat_stage, &self.mats_cpu);
        let lc = vk::BufferCopy::default().size(std::mem::size_of_val(&self.lights_cpu[..]) as u64);
        ctx.device.cmd_copy_buffer(cmd, self.light_stage.buffer, self.lbuf.buffer, &[lc]);
        let mc = vk::BufferCopy::default().size(std::mem::size_of_val(&self.mats_cpu[..]) as u64);
        ctx.device.cmd_copy_buffer(cmd, self.mat_stage.buffer, self.mbuf.buffer, &[mc]);
        let mb = vk::MemoryBarrier::default().src_access_mask(vk::AccessFlags::TRANSFER_WRITE).dst_access_mask(vk::AccessFlags::SHADER_READ);
        ctx.device.cmd_pipeline_barrier(cmd, vk::PipelineStageFlags::TRANSFER, vk::PipelineStageFlags::COMPUTE_SHADER, vk::DependencyFlags::empty(), &[mb], &[], &[]);
    }
}

/// CPU half of `record_frame`, free-function form (no Vulkan): apply the
/// game-authored per-light emission (the flicker curves live in house-game —
/// the old renderer-side `compute_practicals` and its hue-kind heuristic are
/// gone), then the reserved trailing spotlight slots (unused slots zeroed).
/// Slots not addressed by `light_emission` keep their previous values
/// (initial = authored base, restored by the bank-1 bake fill) — a scene
/// that names no lights renders constants. Returns the number of active
/// spotlights — the shade dispatch adds it to `light_count`; the probe bake
/// never sees these slots.
pub fn frame_lights_cpu(lights_cpu: &mut [[f32; 12]], mats_cpu: &mut [scene::Material], light_link: &[(i32, [f32; 3], bool)], flash_idx: usize, fs: &FrameState<'_>) -> u32 {
    for &(key, rgb) in fs.light_emission {
        let li = key.0 as usize;
        assert!(li < light_link.len(), "light_emission key {li} past light_count {}", light_link.len());
        lights_cpu[li][4] = rgb[0];
        lights_cpu[li][5] = rgb[1];
        lights_cpu[li][6] = rgb[2];
        let (mid, _, _) = light_link[li];
        if mid >= 0 {
            mats_cpu[mid as usize].emissive = [rgb[0], rgb[1], rgb[2], 1.0];
        }
    }
    assert!(fs.spotlights.len() <= N_RESERVED, "{} spotlights > N_RESERVED {N_RESERVED}", fs.spotlights.len());
    for s in 0..N_RESERVED {
        lights_cpu[flash_idx + s] = fs.spotlights.get(s).map(|sp| sp.pack()).unwrap_or([0.0; 12]);
    }
    fs.spotlights.len() as u32
}

impl SceneGpu {
    /// Record a TLAS rebuild + an AS-build→ray-trace barrier into `cmd` (cheap:
    /// ~0.05ms on the 5080). Run after `set_player_transform`, before tracing.
    pub unsafe fn record_tlas_rebuild(&self, ctx: &Ctx, cmd: vk::CommandBuffer) {
        let geos = [tlas_geometry(self.inst_buf.address)];
        let b = vk::AccelerationStructureBuildGeometryInfoKHR::default()
            .ty(vk::AccelerationStructureTypeKHR::TOP_LEVEL)
            .flags(vk::BuildAccelerationStructureFlagsKHR::PREFER_FAST_TRACE)
            .mode(vk::BuildAccelerationStructureModeKHR::BUILD)
            .geometries(&geos)
            .dst_acceleration_structure(self.tlas)
            .scratch_data(vk::DeviceOrHostAddressKHR { device_address: self.tlas_scratch.address });
        let r = vk::AccelerationStructureBuildRangeInfoKHR::default().primitive_count(self.n_inst);
        ctx.as_dev.cmd_build_acceleration_structures(cmd, &[b], &[&[r]]);
        ctx.device.cmd_pipeline_barrier(
            cmd,
            vk::PipelineStageFlags::ACCELERATION_STRUCTURE_BUILD_KHR,
            vk::PipelineStageFlags::COMPUTE_SHADER,
            vk::DependencyFlags::empty(),
            &[vk::MemoryBarrier::default().src_access_mask(vk::AccessFlags::ACCELERATION_STRUCTURE_WRITE_KHR).dst_access_mask(vk::AccessFlags::ACCELERATION_STRUCTURE_READ_KHR)],
            &[],
            &[],
        );
    }

    /// Bake the world-space irradiance probe cache to convergence (blocking,
    /// once at startup, ~hundreds of ms): `rays_total` spherical-Fibonacci
    /// rays per probe in fixed batches, into TWO banks (0 = practicals off /
    /// sun+sky only, 1 = full) — each bank baked against an explicitly
    /// uploaded light state. Fully deterministic: same scene, same cache,
    /// every run. Camera motion never invalidates it (world space), so the
    /// per-frame shade pass stays a pure function of (scene, camera).
    /// No-op after the first call.
    pub unsafe fn bake_probes(&mut self, ctx: &Ctx, set: vk::DescriptorSet, env0: [f32; 4], rays_total: i32) {
        if self.probes_baked {
            return;
        }
        const PROBE_BOUNCES: i32 = 4;
        const BATCH: i32 = 256;
        let t = std::time::Instant::now();
        for bank in 0..2i32 {
            // bank light/material state (shared with Metal): 0 = practicals off
            // EXCEPT screens (constant in both banks so the lerp stays exact),
            // 1 = all at base. In place so bank 1 leaves the full state the first
            // record_frame expects.
            crate::gpu_scene::bake_bank_emission(bank, &self.light_link, &mut self.lights_cpu, &mut self.mats_cpu);
            ctx.one_time(|cmd| self.record_practicals_upload(ctx, cmd));
            let mut baked = 0;
            while baked < rays_total {
                let push = ProbePush {
                    _cam: [0.0; 16],
                    probe_count: self.probe_count as i32,
                    rays_total,
                    bounces: PROBE_BOUNCES,
                    batch_rays: BATCH,
                    batch_start: baked,
                    bank,
                    light_count: self.light_count as i32,
                    _r0: 0,
                    env0,
                    _roi: [0.0; 8],
                };
                ctx.one_time(|cmd| {
                    let d = &ctx.device;
                    d.cmd_bind_pipeline(cmd, vk::PipelineBindPoint::COMPUTE, self.probe_pipeline);
                    d.cmd_bind_descriptor_sets(cmd, vk::PipelineBindPoint::COMPUTE, self.pipeline_layout, 0, &[set], &[]);
                    d.cmd_push_constants(cmd, self.pipeline_layout, vk::ShaderStageFlags::COMPUTE, 0, push_bytes(&push));
                    d.cmd_dispatch(cmd, self.probe_count.div_ceil(64), 1, 1);
                });
                baked += BATCH;
            }
        }
        self.probes_baked = true;
        println!("probes: baked {} rays x {} probes x 2 light banks in {:.0} ms", rays_total, self.probe_count, t.elapsed().as_secs_f32() * 1000.0);
    }

    pub unsafe fn destroy(self, ctx: &Ctx) {
        ctx.device.destroy_pipeline(self.shade_pipeline, None);
        ctx.device.destroy_shader_module(self.shade_shader, None);
        ctx.device.destroy_pipeline(self.probe_pipeline, None);
        ctx.device.destroy_shader_module(self.probe_shader, None);
        ctx.device.destroy_pipeline_layout(self.pipeline_layout, None);
        ctx.device.destroy_descriptor_set_layout(self.set_layout, None);
        ctx.device.destroy_sampler(self.sampler, None);
        for t in &self.texes {
            ctx.device.destroy_image_view(t.view, None);
            ctx.device.destroy_image(t.image, None);
            ctx.device.free_memory(t.memory, None);
        }
        ctx.as_dev.destroy_acceleration_structure(self.tlas, None);
        ctx.destroy_buffer(&self.tlas_buf);
        ctx.destroy_buffer(&self.tlas_scratch);
        ctx.destroy_buffer(&self.inst_buf);
        for (blas, asbuf, scratch) in &self.blas_list {
            ctx.as_dev.destroy_acceleration_structure(*blas, None);
            ctx.destroy_buffer(asbuf);
            ctx.destroy_buffer(scratch);
        }
        ctx.destroy_buffer(&self.vbuf);
        ctx.destroy_buffer(&self.ibuf);
        ctx.destroy_buffer(&self.gbuf);
        ctx.destroy_buffer(&self.mbuf);
        ctx.destroy_buffer(&self.lbuf);
        ctx.destroy_buffer(&self.light_stage);
        ctx.destroy_buffer(&self.mat_stage);
        ctx.destroy_buffer(&self.probe_buf);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_structs_share_one_layout_size() {
        assert_eq!(std::mem::size_of::<ShadePush>(), std::mem::size_of::<ProbePush>());
        assert_eq!(std::mem::size_of::<ShadePush>(), 144);
    }

    /// A throwaway CPU scene exercising every scan case: a non-emissive floor,
    /// two emissive boxes (one warm, one marked as a device screen), an
    /// EMISSIVE legacy-dynamic player (must be skipped), and one point light.
    fn scan_fixture() -> Scene {
        let mut s = Scene::new();
        s.add_floor(-2.0, 2.0, -2.0, 2.0, 0.0, [0.5, 0.5, 0.5, 1.0]); // prim 0: dark
        s.add_box_world(Vec3::new(0.0, 0.0, 0.0), Vec3::new(0.25, 0.5, 0.25), [1.0; 4], [9.0, 6.0, 3.0, 1.0], 0.6, 0.0); // prim 1 → slot 0
        let dynp = s.add_box_local(0.2, 1.0, 0.2, [1.0; 4], [20.0, 5.0, 5.0, 1.0]); // prim 2: bright but DYNAMIC
        s.dynamic_prim = Some(dynp);
        s.add_box_world(Vec3::new(1.0, 0.4, 1.0), Vec3::new(1.4, 1.0, 1.03), [0.1, 0.3, 0.25, 1.0], [2.0, 8.0, 6.0, 1.0], 0.8, 0.0); // prim 3 → slot 1
        s.mark_screen(3); // authored device flag (the hue heuristic is gone)
        s.point_lights.push([1.0, 2.0, 3.0, 0.25, 5.0, 4.0, 3.0, 0.0]); // slot 2
        s
    }

    #[test]
    fn scene_handles_join_the_emissive_scan_order_without_reordering() {
        let mut s = scan_fixture();
        // names chosen so any name-ordered assignment would FLIP the slots:
        // the BTreeMap sorts keys, the LightKeys must still follow prim order
        s.name_light("zzz_warm_box", 1);
        s.name_light("aaa_screen", 3);
        s.name_point_light("mmm_point", 0);
        let scan = scan_lights(&s).unwrap();
        assert_eq!(scan.light_count, 3); // 2 emissive prims + 1 point light; dynamic skipped
        assert_eq!(scan.flash_idx, 3);
        assert_eq!(scan.lights.len(), 3 + N_RESERVED); // reserved slots appended, zeroed
        assert_eq!(scan.lights[3], [0.0; 12]);
        assert_eq!(scan.lights[4], [0.0; 12]);
        assert_eq!(scan.names["zzz_warm_box"], LightKey(0));
        assert_eq!(scan.names["aaa_screen"], LightKey(1));
        assert_eq!(scan.names["mmm_point"], LightKey(2)); // points slot after every emissive prim
        // link pins the scan rules: authored screen flag, points never screens
        assert_eq!(scan.light_link[0], (1, [9.0, 6.0, 3.0], false));
        assert_eq!(scan.light_link[1].2, true);
        assert_eq!(scan.light_link[2], (-1, [5.0, 4.0, 3.0], false));
        // the dynamic prim's 20.0-bright emissive landed NO slot
        assert!(scan.lights[..3].iter().all(|l| l[4] != 20.0));
    }

    #[test]
    fn naming_a_slotless_prim_is_a_loud_error() {
        let mut s = scan_fixture();
        s.name_light("the_floor", 0); // not emissive → no slot
        assert!(scan_lights(&s).is_err());
        let mut s = scan_fixture();
        s.name_light("the_player", 2); // dynamic → excluded from the scan
        assert!(scan_lights(&s).is_err());
        let mut s = scan_fixture();
        s.name_light("twice", 1);
        s.name_light("twice", 3); // duplicate name
        assert!(scan_lights(&s).is_err());
        let mut s = scan_fixture();
        s.name_point_light("ghost", 1); // only one point light exists
        assert!(scan_lights(&s).is_err());
        let mut s = scan_fixture();
        s.name_light("twice", 1);
        s.name_point_light("twice", 0); // duplicate across prim/point names
        assert!(scan_lights(&s).is_err());
    }

    #[test]
    fn spotlight_packs_the_documented_12float_record() {
        // exactly the record view.rs::update_flashlight hand-built: warm white
        // (1.0/0.97/0.88), color.w = cos(outer half-angle), dir.w = 2.0 (the
        // shade.comp spotlight-cone marker)
        let (pos, dir) = (Vec3::new(4.2, 0.9, 6.1), Vec3::new(0.6, -0.3, 0.74));
        let (flash_power, flash_cone) = (2.5f32, 32.0f32);
        let c = flash_power * 1500.0;
        let cone_cos = flash_cone.to_radians().cos();
        let rec = [pos.x, pos.y, pos.z, 0.06, c, c * 0.97, c * 0.88, cone_cos, dir.x, dir.y, dir.z, 2.0];
        let sp = Spotlight { pos, dir, cone_cos, power: c, radius: 0.06 };
        assert_eq!(sp.pack(), rec);
        assert_eq!(sp.pack()[11], 2.0);
    }

    fn dummy_cam() -> CamFrame {
        CamFrame { right: Vec3::X, up: Vec3::Y, dir: -Vec3::Z, pos: Vec3::ZERO, half_w: 1.0, half_h: 1.0 }
    }

    #[test]
    fn record_frame_cpu_half_mutates_lights_without_vulkan() {
        // two real lights (slot 0 material-linked) + the reserved slots
        let light_link = vec![(0i32, [8.0f32, 5.0, 2.0], false), (-1, [3.0, 4.0, 5.0], false)];
        let flash_idx = 2;
        let mut lights = vec![[1.0f32, 2.0, 3.0, 0.5, 8.0, 5.0, 2.0, 0.0, 0.0, 0.0, 0.0, 0.0]; 2 + N_RESERVED];
        let mut mats = vec![scene::Material { base_color: [1.0; 4], emissive: [8.0, 5.0, 2.0, 1.0], metallic: 0.0, roughness: 0.5, tex_index: -1, _pad: 0 }];
        let sp = Spotlight { pos: Vec3::new(1.0, 0.9, 2.0), dir: Vec3::new(0.0, -0.2, 0.98), cone_cos: 0.86, power: 3000.0, radius: 0.06 };
        let spots = [sp];
        let emis = [(LightKey(1), [0.5f32, 0.6, 0.7])];
        let fs = FrameState { cam: dummy_cam(), room_lights: 1.0, time: 0.0, light_emission: &emis, spotlights: &spots, instances: &[] };
        let n = frame_lights_cpu(&mut lights, &mut mats, &light_link, flash_idx, &fs);
        assert_eq!(n, 1);
        // an unaddressed slot keeps its previous values (light 0 holds base);
        // the linked material is untouched too — emission is game-authored,
        // not recomputed renderer-side
        assert_eq!(&lights[0][4..7], &[8.0, 5.0, 2.0]);
        assert_eq!(mats[0].emissive, [8.0, 5.0, 2.0, 1.0]);
        // game-authored emission lands on light 1
        assert_eq!(&lights[1][4..7], &[0.5, 0.6, 0.7]);
        // position/radius/dir of real lights untouched by the whole pass
        assert_eq!(&lights[0][0..4], &[1.0, 2.0, 3.0, 0.5]);
        // spotlight packed into the first reserved slot, the rest zeroed
        assert_eq!(lights[flash_idx], sp.pack());
        assert_eq!(lights[flash_idx + 1], [0.0; 12]);
        // next frame without the spotlight: the slot zeroes again
        let fs2 = FrameState { spotlights: &[], ..fs };
        assert_eq!(frame_lights_cpu(&mut lights, &mut mats, &light_link, flash_idx, &fs2), 0);
        assert_eq!(lights[flash_idx], [0.0; 12]);
        // a material-linked override drives the fixture's emissive with it
        let emis2 = [(LightKey(0), [0.1f32, 0.2, 0.3])];
        let fs3 = FrameState { light_emission: &emis2, ..fs2 };
        frame_lights_cpu(&mut lights, &mut mats, &light_link, flash_idx, &fs3);
        assert_eq!(&lights[0][4..7], &[0.1, 0.2, 0.3]);
        assert_eq!(mats[0].emissive, [0.1, 0.2, 0.3, 1.0]);
        assert_eq!(&lights[1][4..7], &[0.5, 0.6, 0.7], "stays at its last value");
    }
}
