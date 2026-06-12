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
}

pub fn push_bytes<T: Copy>(p: &T) -> &[u8] {
    unsafe { std::slice::from_raw_parts((p as *const T) as *const u8, std::mem::size_of::<T>()) }
}

/// Near-wall hide bits for a camera at `yaw_q` quarter-turns from canonical:
/// which OUTWARD wall directions (bit0=+X, bit1=+Z, bit2=-X, bit3=-Z) face the
/// camera and should be hidden for the dollhouse view. At the canonical yaw the
/// camera sits in the +X+Z quadrant, so the +X and +Z perimeter walls hide.
pub fn near_hide_bits(yaw_q: u32) -> u8 {
    let yaw = (crate::iso::ISO_YAW_DEG + 90.0 * (yaw_q & 3) as f32).to_radians();
    (if yaw.sin() > 0.0 { 1 } else { 4 }) | (if yaw.cos() > 0.0 { 2 } else { 8 })
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
    // light animation (record_light_anim): CPU shadows of lbuf/mbuf, the
    // per-light anim link (material id or -1, base rgb, kind), and the
    // persistent host-visible staging buffers for the per-frame copies
    pub lights_cpu: Vec<[f32; 12]>,
    pub mats_cpu: Vec<scene::Material>,
    pub light_link: Vec<(i32, [f32; 3], u32)>,
    pub light_stage: Buffer,
    pub mat_stage: Buffer,
    pub texes: Vec<GpuTex>,
    pub sampler: vk::Sampler,
    pub blas_list: Vec<(vk::AccelerationStructureKHR, Buffer, Buffer)>,
    pub tlas: vk::AccelerationStructureKHR,
    pub tlas_buf: Buffer,
    pub tlas_scratch: Buffer,
    pub inst_buf: Buffer, // host-visible: the dynamic instance transform is updated in place
    pub n_inst: u32,
    pub dynamic_instance: Option<u32>, // TLAS instance index of the movable player
    /// Per-instance near-wall hide bitmask (from `Scene::prim_hide_mask`); all
    /// zero when the scene doesn't use the dollhouse hide.
    pub hide_masks: Vec<u8>,
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

        // ---- emissive light list for NEE: small bright emitters (lamps,
        // sconces) never converge by random bounces alone, so the shader
        // samples them directly. Per emissive primitive: bounding sphere,
        // radiance, and the area-weighted MEAN SURFACE NORMAL — a screen or
        // panel emits one-sided (Lambertian) toward its facing, not
        // isotropically (an isotropic screen lights the floor BEHIND the desk,
        // which reads as the light re-aiming itself as the camera orbits).
        // Emitters whose normals point many ways (focus < 0.7) stay isotropic.
        // Record: [cx, cy, cz, radius, r, g, b, 0, nx, ny, nz, directionalFlag].
        let mut lights: Vec<[f32; 12]> = Vec::new();
        // per-light animation link: (material id or -1, base rgb, kind)
        // kind: 1 incandescent flicker, 2 screen pulse, 3 gentle drift
        let mut light_link: Vec<(i32, [f32; 3], u32)> = Vec::new();
        for (i, p) in scene.primitives.iter().enumerate() {
            if scene.dynamic_prim == Some(i) {
                continue;
            }
            let e = scene.materials[p.material_id as usize].emissive;
            if e[0].max(e[1]).max(e[2]) < 3.0 {
                continue;
            }
            light_link.push((p.material_id, [e[0], e[1], e[2]], if e[0] >= e[1] { 1 } else { 2 }));
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
            lights.push([c.x, c.y, c.z, r, e[0], e[1], e[2], 0.0, nd.x, nd.y, nd.z, df]);
        }
        for pl in &scene.point_lights {
            // conceptual (geometry-less) lights stay isotropic
            lights.push([pl[0], pl[1], pl[2], pl[3], pl[4], pl[5], pl[6], pl[7], 0.0, 0.0, 0.0, 0.0]);
            light_link.push((-1, [pl[4], pl[5], pl[6]], 3));
        }
        let light_count = lights.len() as u32;
        // reserved flashlight slot: the viewer streams a player-held spotlight
        // (dir.w = 2.0 → cone falloff in shade.comp) into this trailing entry.
        // It sits PAST light_count so the frozen probe bake never sees it — a
        // light that moves with the player must stay direct-only. The shade
        // dispatch passes lightCount+1 while the flashlight is on. (Also keeps
        // the binding valid in scenes with zero real lights.)
        let flash_idx = lights.len();
        lights.push([0.0; 12]);
        // TRANSFER_DST so record_light_anim can stream animated values in
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
        // Most primitives are baked to world space -> identity instances. The
        // movable player primitive is in local space -> its instance carries the
        // start transform and is updated per frame (dynamic scene).
        let dynamic_instance = scene.dynamic_prim.map(|p| p as u32);
        let identity = vk::TransformMatrixKHR { matrix: [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0] };
        let instances: Vec<vk::AccelerationStructureInstanceKHR> = blas_addrs
            .iter()
            .enumerate()
            .map(|(i, &addr)| vk::AccelerationStructureInstanceKHR {
                transform: if Some(i as u32) == dynamic_instance { mat_to_transform(Mat4::from_translation(scene.player_start)) } else { identity },
                // mask channels: 0x01 primary visibility, 0x02 dollhouse-hidden
                // walls, 0x04 dynamic. The movable player is 0x01|0x04 = 0x05:
                // camera (0x01) and shadow/AO rays (0xFF) see it, but probe
                // BAKE rays (0x0A) skip it so the world-space GI cache never
                // goes stale as it walks.
                instance_custom_index_and_mask: vk::Packed24_8::new(i as u32, if Some(i as u32) == dynamic_instance { 0x05 } else { 0xff }),
                instance_shader_binding_table_record_offset_and_flags: vk::Packed24_8::new(0, vk::GeometryInstanceFlagsKHR::TRIANGLE_FACING_CULL_DISABLE.as_raw() as u8),
                acceleration_structure_reference: vk::AccelerationStructureReferenceKHR { device_handle: addr },
            })
            .collect();
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

        // ---- world-space irradiance probe grid — scene AABB + one-spacing
        // pad, spacing widened until the count fits.
        // Header floats: origin.xyz, spacing, dims.xyz, pad.
        let mut spacing = probe_spacing;
        let pmin = scene.min - Vec3::splat(spacing);
        let pmax = scene.max + Vec3::splat(spacing);
        let ext = (pmax - pmin).max(Vec3::splat(0.1));
        let dims = loop {
            let d = [
                ((ext.x / spacing).ceil() as u32 + 1).max(2),
                ((ext.y / spacing).ceil() as u32 + 1).max(2),
                ((ext.z / spacing).ceil() as u32 + 1).max(2),
            ];
            if d[0] as u64 * d[1] as u64 * d[2] as u64 <= 262_144 {
                break d;
            }
            spacing *= 1.25;
        };
        let probe_count = dims[0] * dims[1] * dims[2];
        // TWO banks of probe payload (bank 0 = practicals off / sun+sky only,
        // bank 1 = full — shade.comp lerps them by the room-lights dim)
        let mut pdata = vec![0.0f32; 16 + probe_count as usize * 20 * 2];
        pdata[0] = pmin.x;
        pdata[1] = pmin.y;
        pdata[2] = pmin.z;
        pdata[3] = spacing;
        pdata[4] = dims[0] as f32;
        pdata[5] = dims[1] as f32;
        pdata[6] = dims[2] as f32;
        let probe_buf = ctx.device_local(&pdata, vk::BufferUsageFlags::STORAGE_BUFFER | vk::BufferUsageFlags::TRANSFER_DST);
        println!("probes: {}x{}x{} = {} @ spacing {:.2} wu ({:.1} MB x 2 banks)", dims[0], dims[1], dims[2], probe_count, spacing, probe_count as f32 * 80.0 / 1e6);

        let hide_masks: Vec<u8> = (0..scene.primitives.len()).map(|i| scene.prim_hide_mask.get(i).copied().unwrap_or(0)).collect();
        Ok(SceneGpu { vbuf, ibuf, gbuf, mbuf, lbuf, light_count, flash_idx, lights_cpu, mats_cpu, light_link, light_stage, mat_stage, texes, sampler, blas_list, tlas, tlas_buf, tlas_scratch, inst_buf, n_inst, dynamic_instance, hide_masks, set_layout, pipeline_layout, shade_pipeline, shade_shader, probe_pipeline, probe_shader, probe_buf, probe_count, probes_baked: false })
    }

    /// Patch the movable player's instance transform in the host-visible
    /// instance buffer. Call `record_tlas_rebuild` afterwards to apply it.
    pub unsafe fn set_player_transform(&self, ctx: &Ctx, m: Mat4) {
        let Some(i) = self.dynamic_instance else { return };
        let stride = std::mem::size_of::<vk::AccelerationStructureInstanceKHR>() as u64;
        let off = i as u64 * stride;
        // the transform (12 f32) is the first field of the instance struct
        let ptr = ctx.device.map_memory(self.inst_buf.memory, off, 48, vk::MemoryMapFlags::empty()).unwrap() as *mut f32;
        let t = mat_to_transform(m);
        std::ptr::copy_nonoverlapping(t.matrix.as_ptr(), ptr, 12);
        ctx.device.unmap_memory(self.inst_buf.memory);
    }

    /// Animate the practicals: deterministic-in-time flicker/pulse written
    /// over the NEE light list AND each linked material's emissive, so the
    /// visible bulb/screen brightens exactly in sync with the light it casts.
    /// Records the stage->device copies + barrier into `cmd` (run it BEFORE
    /// the shade dispatch). Kinds: 1 = incandescent flicker (value noise +
    /// slow breathing + rare deeper dips), 2 = screen pulse (throb + refresh
    /// shimmer + hue wobble), 3 = gentle drift (conceptual ceiling lights).
    /// The probe cache keeps the baked BASE levels — the modulation is direct
    /// light only, which dominates near the fixtures; indirect stays steady.
    ///
    /// `anim = false` freezes the flicker (constant values — bit-stability
    /// tests); `scale` is the room-lights master dim (0 = practicals off;
    /// indirect follows via the shader's probe-bank lerp).
    pub unsafe fn record_light_anim(&mut self, ctx: &Ctx, cmd: vk::CommandBuffer, t: f32, anim: bool, scale: f32) {
        self.compute_practicals(t, anim, scale);
        self.record_practicals_upload(ctx, cmd);
    }

    /// CPU half of `record_light_anim`: fill `lights_cpu` / `mats_cpu` from
    /// the per-light base values. Never touches the reserved flashlight slot.
    pub fn compute_practicals(&mut self, t: f32, anim: bool, scale: f32) {
        use std::f32::consts::TAU;
        fn h01(x: u32) -> f32 {
            let mut v = x.wrapping_mul(0x9E37_79B9);
            v ^= v >> 16;
            v = v.wrapping_mul(0x7feb_352d);
            v ^= v >> 15;
            (v & 0xFF_FFFF) as f32 / 16_777_216.0
        }
        // smooth value noise in [0,1] at integer lattice `t`
        let vnoise = |t: f32, seed: u32| {
            let i = t.floor();
            let f = t - i;
            let s = f * f * (3.0 - 2.0 * f);
            let a = h01((i as i32 as u32).wrapping_add(seed.wrapping_mul(7919)));
            let b = h01((i as i32 as u32).wrapping_add(1).wrapping_add(seed.wrapping_mul(7919)));
            a + (b - a) * s
        };
        for (li, &(mid, base, kind)) in self.light_link.iter().enumerate() {
            let seed = li as u32 + 1;
            let ph = h01(seed) * TAU;
            let (f, tint): (f32, [f32; 3]) = match kind {
                1 => {
                    let n = vnoise(t * 9.0 + ph, seed);
                    let dipn = vnoise(t * 1.7 + ph, seed.wrapping_mul(31));
                    let dip = if dipn > 0.93 { (dipn - 0.93) * 6.0 } else { 0.0 };
                    (1.0 + (n - 0.5) * 0.22 + (t * 0.7 + ph).sin() * 0.05 - dip, [1.0; 3])
                }
                2 => {
                    // CRT screen: slow throb + mid value-noise + fast refresh
                    // shimmer + rare horizontal-roll-style dips
                    let p = 1.0
                        + (t * 1.3 + ph).sin() * 0.20
                        + (vnoise(t * 5.0 + ph, seed) - 0.5) * 0.18
                        + (vnoise(t * 16.0 + ph, seed.wrapping_mul(13)) - 0.5) * 0.14;
                    let rolln = vnoise(t * 2.3 + ph, seed.wrapping_mul(37));
                    let roll = if rolln > 0.90 { (rolln - 0.90) * 4.0 } else { 0.0 };
                    let hue = (t * 0.45 + ph).sin() * 0.5 + 0.5;
                    (p - roll, [1.0 - 0.25 * hue, 1.0, 1.0 - 0.15 * (1.0 - hue)])
                }
                3 => (1.0 + (vnoise(t * 2.2 + ph, seed) - 0.5) * 0.08, [1.0; 3]),
                _ => (1.0, [1.0; 3]),
            };
            // screens (kind 2) are devices, not room lighting — the wall
            // switch (room-lights dim) never touches them. The probe-bank
            // lerp stays exact: their bounce is a constant term in BOTH banks.
            let f = (if anim { f.max(0.05) } else { 1.0 }) * (if kind == 2 { 1.0 } else { scale });
            let tint = if anim { tint } else { [1.0; 3] };
            let c = [base[0] * f * tint[0], base[1] * f * tint[1], base[2] * f * tint[2]];
            self.lights_cpu[li][4] = c[0];
            self.lights_cpu[li][5] = c[1];
            self.lights_cpu[li][6] = c[2];
            if mid >= 0 {
                self.mats_cpu[mid as usize].emissive = [c[0], c[1], c[2], 1.0];
            }
        }
    }

    /// GPU half of `record_light_anim`: stream `lights_cpu` + `mats_cpu` to
    /// the device buffers. Record BEFORE the shade dispatch. The reserved
    /// flashlight slot rides along in `lights_cpu`.
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

    /// Apply the dollhouse near-wall hide for a camera at `yaw_q` quarter
    /// turns: tagged instances whose outward direction faces the camera get
    /// TLAS visibility mask 0x02 (primary rays cull with 0x01 and skip them —
    /// the see-through; shadow/AO rays cull with 0xFF and still hit them, so
    /// the room stays ENCLOSED for light transport). Everything else 0xFF.
    /// Patches the host-visible instance buffer in place — call
    /// `record_tlas_rebuild` afterwards to take effect.
    pub unsafe fn set_yaw_masks(&self, ctx: &Ctx, yaw_q: u32) {
        let near = near_hide_bits(yaw_q);
        let stride = std::mem::size_of::<vk::AccelerationStructureInstanceKHR>() as u64;
        let ptr = ctx.device.map_memory(self.inst_buf.memory, 0, stride * self.n_inst as u64, vk::MemoryMapFlags::empty()).unwrap() as *mut u8;
        for (i, &bits) in self.hide_masks.iter().enumerate() {
            if bits == 0 {
                continue;
            }
            // subset match: hide only when EVERY tagged side faces the camera.
            // Single-bit walls hide as soon as their side is near; two-bit
            // corners survive while either adjacent wall run survives, so the
            // kept run still ends in a capped corner instead of an open
            // cross-section. (Mask 0 instead of 0x02 removed hidden walls from
            // sunlight too, so light flooded in through the camera-side
            // openings and the lighting followed the camera, not the world.)
            let mask: u32 = if bits & near == bits { 0x02 } else { 0xff };
            let word: u32 = (i as u32 & 0x00ff_ffff) | (mask << 24);
            // instanceCustomIndex:24 | mask:8 sits right after the 48-byte transform
            std::ptr::copy_nonoverlapping(word.to_le_bytes().as_ptr(), ptr.add(i * stride as usize + 48), 4);
        }
        ctx.device.unmap_memory(self.inst_buf.memory);
    }

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
            self.compute_practicals(0.0, false, bank as f32);
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
    use crate::iso::ISO_YAW_DEG;

    #[test]
    fn near_hide_bits_track_the_camera_quadrant() {
        // q=0: camera in +X+Z -> hide east(+X, bit0) + south(+Z, bit1) walls
        assert_eq!(near_hide_bits(0), 0b0011);
        assert_eq!(near_hide_bits(1), 0b1001); // +X -Z
        assert_eq!(near_hide_bits(2), 0b1100); // -X -Z
        assert_eq!(near_hide_bits(3), 0b0110); // -X +Z
        assert_eq!(near_hide_bits(4), near_hide_bits(0)); // wraps
        // consistency with the actual camera basis: the offset direction's
        // signs must match the bits for every quarter turn
        for q in 0..4u32 {
            let yaw = (ISO_YAW_DEG + 90.0 * q as f32).to_radians();
            let bits = near_hide_bits(q);
            assert!(bits & 0b0101 != 0); // exactly one X bit
            assert_eq!(bits & 1 != 0, yaw.sin() > 0.0);
            assert_eq!(bits & 2 != 0, yaw.cos() > 0.0);
        }
    }

    #[test]
    fn push_structs_share_one_layout_size() {
        assert_eq!(std::mem::size_of::<ShadePush>(), std::mem::size_of::<ProbePush>());
        assert_eq!(std::mem::size_of::<ShadePush>(), 112);
    }
}
