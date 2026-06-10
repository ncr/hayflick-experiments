//! Shared GPU + scene + ISO-camera plumbing for the rt-probe binaries.
//!
//! `main.rs` is the headless beauty/orbit/perf tool; `bin/viewer.rs` is the
//! interactive winit window. Both build the same scene, upload the same
//! ray-tracing acceleration structures, and use the same pixel-perfect
//! ISO_VIEW_CONTRACT camera — all of which live here.

pub mod cuda;
pub mod gltf_scene;
pub mod oidn;
use gltf_scene::{Scene, Vertex};

use ash::vk;
use glam::{Mat4, Vec3};
use std::ffi::{CStr, CString};

// Beauty shot defaults (headless). The viewer overrides spp/bounces per frame.
pub const BOUNCES: i32 = 5;
pub const SPP_PER: i32 = 8;
pub const DISPATCHES: u32 = 64; // total spp = SPP_PER * DISPATCHES = 512

// ISO_VIEW_CONTRACT (mirrored from packages/common-render/src/iso-contract.ts).
// The pixel-perfect cornerstone: orthographic, yaw=π/4, pitch=π/6, and exactly
// R lowpixels per world unit (1 tile = 1 wu -> 32 px H × 16 px V).
pub const ISO_R: f32 = 32.0 * std::f32::consts::SQRT_2; // 45.25 lowpixels / world unit
pub const ISO_YAW_DEG: f32 = 45.0; // π/4
pub const ISO_PITCH_DEG: f32 = 30.0; // π/6  (sin = 1/2 exact -> the 2:1 staircase)

#[repr(C)]
#[derive(Clone, Copy)]
pub struct Push {
    pub cam_right: [f32; 4],
    pub cam_up: [f32; 4],
    pub cam_dir: [f32; 4],
    pub cam_pos: [f32; 4],
    pub misc: [i32; 4],
    pub misc2: [i32; 4],
    /// [sun_scale, sky_scale, fog_density, fog_height] — see `Scene::lighting`.
    pub env0: [f32; 4],
}

pub unsafe extern "system" fn debug_callback(
    severity: vk::DebugUtilsMessageSeverityFlagsEXT,
    _t: vk::DebugUtilsMessageTypeFlagsEXT,
    data: *const vk::DebugUtilsMessengerCallbackDataEXT<'_>,
    _u: *mut std::ffi::c_void,
) -> vk::Bool32 {
    eprintln!("[vk {severity:?}] {}", CStr::from_ptr((*data).p_message).to_string_lossy());
    vk::FALSE
}

pub fn find_memory_type(mp: &vk::PhysicalDeviceMemoryProperties, bits: u32, flags: vk::MemoryPropertyFlags) -> u32 {
    (0..mp.memory_type_count)
        .find(|&i| (bits & (1 << i)) != 0 && mp.memory_types[i as usize].property_flags.contains(flags))
        .expect("no memory type")
}

pub struct Buffer {
    pub buffer: vk::Buffer,
    pub memory: vk::DeviceMemory,
    pub address: u64,
}

pub struct GpuTex {
    pub image: vk::Image,
    pub memory: vk::DeviceMemory,
    pub view: vk::ImageView,
}

pub struct Ctx {
    pub device: ash::Device,
    pub as_dev: ash::khr::acceleration_structure::Device,
    pub queue: vk::Queue,
    pub pool: vk::CommandPool,
    pub mem_props: vk::PhysicalDeviceMemoryProperties,
    pub timestamp_period: f32,
    /// Present only when VK_KHR_external_memory_fd is enabled (the viewer, for
    /// zero-copy OIDN interop). Headless tool leaves it None.
    pub ext_mem_fd: Option<ash::khr::external_memory_fd::Device>,
}

impl Ctx {
    pub unsafe fn create_buffer(&self, size: u64, usage: vk::BufferUsageFlags, props: vk::MemoryPropertyFlags) -> Buffer {
        let want_addr = usage.contains(vk::BufferUsageFlags::SHADER_DEVICE_ADDRESS);
        let buffer = self
            .device
            .create_buffer(&vk::BufferCreateInfo::default().size(size.max(1)).usage(usage).sharing_mode(vk::SharingMode::EXCLUSIVE), None)
            .unwrap();
        let req = self.device.get_buffer_memory_requirements(buffer);
        let mut flags = vk::MemoryAllocateFlagsInfo::default().flags(vk::MemoryAllocateFlags::DEVICE_ADDRESS);
        let mut alloc = vk::MemoryAllocateInfo::default()
            .allocation_size(req.size)
            .memory_type_index(find_memory_type(&self.mem_props, req.memory_type_bits, props));
        if want_addr {
            alloc = alloc.push_next(&mut flags);
        }
        let memory = self.device.allocate_memory(&alloc, None).unwrap();
        self.device.bind_buffer_memory(buffer, memory, 0).unwrap();
        let address = if want_addr {
            self.device.get_buffer_device_address(&vk::BufferDeviceAddressInfo::default().buffer(buffer))
        } else {
            0
        };
        Buffer { buffer, memory, address }
    }

    pub unsafe fn destroy_buffer(&self, b: &Buffer) {
        self.device.destroy_buffer(b.buffer, None);
        self.device.free_memory(b.memory, None);
    }

    /// Create a DEVICE_LOCAL buffer whose memory can be exported as an OPAQUE_FD
    /// (for sharing with OIDN/CUDA, zero-copy denoise). Returns the buffer and
    /// the actual allocation size (which OIDN's import must match).
    pub unsafe fn create_exportable_buffer(&self, size: u64, usage: vk::BufferUsageFlags) -> (Buffer, u64) {
        let mut ext_buf = vk::ExternalMemoryBufferCreateInfo::default().handle_types(vk::ExternalMemoryHandleTypeFlags::OPAQUE_FD);
        let buffer = self
            .device
            .create_buffer(&vk::BufferCreateInfo::default().size(size.max(1)).usage(usage).sharing_mode(vk::SharingMode::EXCLUSIVE).push_next(&mut ext_buf), None)
            .unwrap();
        let req = self.device.get_buffer_memory_requirements(buffer);
        let mut export = vk::ExportMemoryAllocateInfo::default().handle_types(vk::ExternalMemoryHandleTypeFlags::OPAQUE_FD);
        let alloc = vk::MemoryAllocateInfo::default()
            .allocation_size(req.size)
            .memory_type_index(find_memory_type(&self.mem_props, req.memory_type_bits, vk::MemoryPropertyFlags::DEVICE_LOCAL))
            .push_next(&mut export);
        let memory = self.device.allocate_memory(&alloc, None).unwrap();
        self.device.bind_buffer_memory(buffer, memory, 0).unwrap();
        (Buffer { buffer, memory, address: 0 }, req.size)
    }

    /// Export a buffer's memory as a fresh OPAQUE_FD (ownership passes to caller;
    /// hand it to OIDN which then owns it).
    pub unsafe fn export_memory_fd(&self, b: &Buffer) -> Result<i32, vk::Result> {
        let dev = self.ext_mem_fd.as_ref().ok_or(vk::Result::ERROR_EXTENSION_NOT_PRESENT)?;
        dev.get_memory_fd(&vk::MemoryGetFdInfoKHR::default().memory(b.memory).handle_type(vk::ExternalMemoryHandleTypeFlags::OPAQUE_FD))
    }

    pub unsafe fn upload<T: Copy>(&self, b: &Buffer, data: &[T]) {
        if data.is_empty() {
            return;
        }
        let size = std::mem::size_of_val(data) as u64;
        let ptr = self.device.map_memory(b.memory, 0, size, vk::MemoryMapFlags::empty()).unwrap() as *mut T;
        std::ptr::copy_nonoverlapping(data.as_ptr(), ptr, data.len());
        self.device.unmap_memory(b.memory);
    }

    pub unsafe fn device_local<T: Copy>(&self, data: &[T], usage: vk::BufferUsageFlags) -> Buffer {
        let size = (std::mem::size_of_val(data) as u64).max(1);
        let host = vk::MemoryPropertyFlags::HOST_VISIBLE | vk::MemoryPropertyFlags::HOST_COHERENT;
        let staging = self.create_buffer(size, vk::BufferUsageFlags::TRANSFER_SRC, host);
        self.upload(&staging, data);
        let dst = self.create_buffer(size, usage | vk::BufferUsageFlags::TRANSFER_DST, vk::MemoryPropertyFlags::DEVICE_LOCAL);
        self.one_time(|cmd| {
            self.device.cmd_copy_buffer(cmd, staging.buffer, dst.buffer, &[vk::BufferCopy::default().size(size)]);
        });
        self.destroy_buffer(&staging);
        dst
    }

    pub unsafe fn one_time(&self, record: impl FnOnce(vk::CommandBuffer)) {
        let cmd = self
            .device
            .allocate_command_buffers(&vk::CommandBufferAllocateInfo::default().command_pool(self.pool).level(vk::CommandBufferLevel::PRIMARY).command_buffer_count(1))
            .unwrap()[0];
        self.device.begin_command_buffer(cmd, &vk::CommandBufferBeginInfo::default().flags(vk::CommandBufferUsageFlags::ONE_TIME_SUBMIT)).unwrap();
        record(cmd);
        self.device.end_command_buffer(cmd).unwrap();
        let fence = self.device.create_fence(&vk::FenceCreateInfo::default(), None).unwrap();
        let cmds = [cmd];
        self.device.queue_submit(self.queue, &[vk::SubmitInfo::default().command_buffers(&cmds)], fence).unwrap();
        self.device.wait_for_fences(&[fence], true, u64::MAX).unwrap();
        self.device.destroy_fence(fence, None);
        self.device.free_command_buffers(self.pool, &[cmd]);
    }

    pub unsafe fn upload_texture(&self, img: &gltf_scene::LoadedImage) -> GpuTex {
        let host = vk::MemoryPropertyFlags::HOST_VISIBLE | vk::MemoryPropertyFlags::HOST_COHERENT;
        let staging = self.create_buffer(img.pixels.len() as u64, vk::BufferUsageFlags::TRANSFER_SRC, host);
        self.upload(&staging, &img.pixels);
        let image = self
            .device
            .create_image(
                &vk::ImageCreateInfo::default()
                    .image_type(vk::ImageType::TYPE_2D)
                    .format(vk::Format::R8G8B8A8_UNORM)
                    .extent(vk::Extent3D { width: img.width, height: img.height, depth: 1 })
                    .mip_levels(1)
                    .array_layers(1)
                    .samples(vk::SampleCountFlags::TYPE_1)
                    .tiling(vk::ImageTiling::OPTIMAL)
                    .usage(vk::ImageUsageFlags::SAMPLED | vk::ImageUsageFlags::TRANSFER_DST)
                    .initial_layout(vk::ImageLayout::UNDEFINED),
                None,
            )
            .unwrap();
        let req = self.device.get_image_memory_requirements(image);
        let memory = self
            .device
            .allocate_memory(&vk::MemoryAllocateInfo::default().allocation_size(req.size).memory_type_index(find_memory_type(&self.mem_props, req.memory_type_bits, vk::MemoryPropertyFlags::DEVICE_LOCAL)), None)
            .unwrap();
        self.device.bind_image_memory(image, memory, 0).unwrap();
        let range = vk::ImageSubresourceRange { aspect_mask: vk::ImageAspectFlags::COLOR, base_mip_level: 0, level_count: 1, base_array_layer: 0, layer_count: 1 };
        self.one_time(|cmd| {
            barrier(&self.device, cmd, image, vk::ImageLayout::UNDEFINED, vk::ImageLayout::TRANSFER_DST_OPTIMAL, vk::AccessFlags::empty(), vk::AccessFlags::TRANSFER_WRITE, vk::PipelineStageFlags::TOP_OF_PIPE, vk::PipelineStageFlags::TRANSFER);
            let region = vk::BufferImageCopy::default()
                .image_subresource(vk::ImageSubresourceLayers { aspect_mask: vk::ImageAspectFlags::COLOR, mip_level: 0, base_array_layer: 0, layer_count: 1 })
                .image_extent(vk::Extent3D { width: img.width, height: img.height, depth: 1 });
            self.device.cmd_copy_buffer_to_image(cmd, staging.buffer, image, vk::ImageLayout::TRANSFER_DST_OPTIMAL, &[region]);
            barrier(&self.device, cmd, image, vk::ImageLayout::TRANSFER_DST_OPTIMAL, vk::ImageLayout::SHADER_READ_ONLY_OPTIMAL, vk::AccessFlags::TRANSFER_WRITE, vk::AccessFlags::SHADER_READ, vk::PipelineStageFlags::TRANSFER, vk::PipelineStageFlags::COMPUTE_SHADER);
        });
        self.destroy_buffer(&staging);
        let view = self
            .device
            .create_image_view(&vk::ImageViewCreateInfo::default().image(image).view_type(vk::ImageViewType::TYPE_2D).format(vk::Format::R8G8B8A8_UNORM).subresource_range(range), None)
            .unwrap();
        GpuTex { image, memory, view }
    }
}

#[allow(clippy::too_many_arguments)]
pub unsafe fn barrier(device: &ash::Device, cmd: vk::CommandBuffer, image: vk::Image, old: vk::ImageLayout, new: vk::ImageLayout, sa: vk::AccessFlags, da: vk::AccessFlags, ss: vk::PipelineStageFlags, ds: vk::PipelineStageFlags) {
    let b = vk::ImageMemoryBarrier::default()
        .old_layout(old)
        .new_layout(new)
        .src_access_mask(sa)
        .dst_access_mask(da)
        .image(image)
        .subresource_range(vk::ImageSubresourceRange { aspect_mask: vk::ImageAspectFlags::COLOR, base_mip_level: 0, level_count: 1, base_array_layer: 0, layer_count: 1 });
    device.cmd_pipeline_barrier(cmd, ss, ds, vk::DependencyFlags::empty(), &[], &[], &[b]);
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

/// Native rematch of `experiments/grid-walker` — the smallest web GameModule:
/// a 20×20-tile floor (0x1f2329) with GridHelper tile lines (centre 0x6a6558,
/// rest 0x3a3d44) and a 1-wu orange box (0xd97706, anchor bottom) at the
/// origin, driven by arrows/WASD. The web version uses the engine's OPEN level
/// (nothing blocks), a FIXED camera, and snaps the box mesh to the screen-pixel
/// lattice each frame — the viewer mirrors all three when SCENE=grid.
pub fn build_grid_walker() -> Result<Scene, Box<dyn std::error::Error>> {
    let mut scene = Scene::new();
    let size = 20.0; // wu = tiles (1 tile = 1 wu = 1.28 m)
    let half = size * 0.5;
    scene.add_floor(-half, half, -half, half, 0.0, hex_linear(0x1f2329));
    // GridHelper(20, 20, 0x6a6558, 0x3a3d44) at y = 0.001, lines ~1 lowpixel wide
    scene.add_ground_grid(size, 20, 0.001, 1.0 / 32.0, hex_linear(0x6a6558), hex_linear(0x3a3d44));
    scene.recompute_bounds();
    // grid-walker runs on the engine's open level: nothing ever blocks.
    scene.floor_rect = [-1e30, -1e30, 1e30, 1e30];
    scene.solids = Vec::new();
    // spawnBox({ size: 1, color: 0xd97706, anchor: "bottom" }) at (0, 0)
    let pidx = scene.add_box_local(0.5, 1.0, 0.5, hex_linear(0xd97706), [0.0; 4]);
    scene.dynamic_prim = Some(pidx);
    scene.player_start = Vec3::ZERO;
    Ok(scene)
}

/// Minimal synthetic isolation scene (SCENE=lab) — small enough to reason
/// about every pixel: an 8×8 flat floor, three matte boxes of distinct colour
/// and height (hard silhouettes + shadow edges), one isotropic emissive lamp
/// pillar and one directional emissive "screen" slab (both NEE light shapes),
/// moderate sun + sky, NO fog, NO textures, NO dollhouse masks, no player
/// (q/e orbits, WASD pans — same camera paths as the house). Anything that
/// flickers here is the renderer, not the content.
pub fn build_lab() -> Result<Scene, Box<dyn std::error::Error>> {
    let mut scene = Scene::new();
    scene.add_floor(-4.0, 4.0, -4.0, 4.0, 0.0, [0.45, 0.44, 0.42, 1.0]);
    // three matte boxes: tall blue, mid red, low broad green slab
    scene.add_box_world(Vec3::new(-1.5, 0.0, -1.5), Vec3::new(-0.5, 2.0, -0.5), [0.20, 0.30, 0.75, 1.0], [0.0; 4], 0.9, 0.0);
    scene.add_box_world(Vec3::new(0.75, 0.0, 0.25), Vec3::new(1.75, 1.0, 1.25), [0.75, 0.22, 0.18, 1.0], [0.0; 4], 0.9, 0.0);
    scene.add_box_world(Vec3::new(-1.0, 0.0, 1.5), Vec3::new(1.0, 0.25, 2.5), [0.25, 0.62, 0.28, 1.0], [0.0; 4], 0.9, 0.0);
    // isotropic NEE lamp: warm pillar near a corner (closed box -> isotropic)
    scene.add_box_world(Vec3::new(2.4, 0.0, -2.6), Vec3::new(2.6, 0.8, -2.4), [1.0, 0.8, 0.5, 1.0], [8.0, 5.6, 2.4, 1.0], 0.4, 0.0);
    // directional NEE screen: thin teal slab facing +Z (authored facing) — the
    // exact shape the house terminal screens use, minus everything else
    scene.add_box_world(Vec3::new(-2.6, 0.4, -2.0), Vec3::new(-2.2, 1.0, -1.97), [0.1, 0.3, 0.25, 1.0], [3.0, 12.0, 9.6, 1.0], 0.8, 0.0);
    scene.prim_light_dir.resize(scene.primitives.len(), [0.0; 3]);
    *scene.prim_light_dir.last_mut().unwrap() = [0.0, 0.0, 1.0];
    scene.recompute_bounds();
    scene.floor_rect = [-3.7, -3.7, 3.7, 3.7];
    scene.solids = Vec::new();
    scene.dynamic_prim = None; // no player — WASD pans, q/e orbits (house camera)
    scene.player_start = Vec3::ZERO; // camera target seed
    scene.lighting = [0.6, 0.5, 0.0, 1.0]; // gentle sun + sky, NO fog
    Ok(scene)
}

/// Near-wall hide bits for a camera at `yaw_q` quarter-turns from canonical:
/// which OUTWARD wall directions (bit0=+X, bit1=+Z, bit2=-X, bit3=-Z) face the
/// camera and should be hidden for the dollhouse view. At the canonical yaw the
/// camera sits in the +X+Z quadrant, so the +X and +Z perimeter walls hide.
pub fn near_hide_bits(yaw_q: u32) -> u8 {
    let yaw = (ISO_YAW_DEG + 90.0 * (yaw_q & 3) as f32).to_radians();
    (if yaw.sin() > 0.0 { 1 } else { 4 }) | (if yaw.cos() > 0.0 { 2 } else { 8 })
}

/// Fallout-flavoured example house assembled from the blockstudio tile kits
/// (`desert_sandstone` wall kit + `ground_tiles` floors), following
/// `docs/blockstudio/game-consumer-contract.md`: 1 glTF unit = 1 cell = 1 wu;
/// floors at cell centres, walls at edge midpoints (rotate 90° for Z-runs),
/// corners at vertices (canonical legs +X/-Z, one cell long — adjacent wall
/// segments are skipped). Three rooms (common room, lab, storage), doors +
/// windows, forge props inside, grass/asphalt yard with a road outside.
/// Perimeter walls carry `prim_hide_mask` outward tags so the viewer can hide
/// the camera-near sides per quarter-turn (Q/E).
pub fn build_house() -> Result<Scene, Box<dyn std::error::Error>> {
    use std::f32::consts::{FRAC_PI_2, PI};
    let mut scene = Scene::new();
    let tiles = "assets/tilesets/desert_sandstone/artifacts/tiles";
    let ground = "assets/tilesets/ground_tiles/artifacts/tiles";
    let wall = scene.preload(&format!("{tiles}/wall/wall.glb"))?;
    let door = scene.preload(&format!("{tiles}/door/door.glb"))?;
    let win = scene.preload(&format!("{tiles}/window_middle/window_middle.glb"))?;
    let corner = scene.preload(&format!("{tiles}/corner/corner.glb"))?;
    let concrete = scene.preload(&format!("{ground}/concrete_walk/concrete_walk.glb"))?;
    let grass = scene.preload(&format!("{ground}/grass/grass.glb"))?;
    let asphalt = scene.preload(&format!("{ground}/asphalt/asphalt.glb"))?;
    let sandstone = scene.preload(&format!("{ground}/sandstone/sandstone.glb"))?;

    // House footprint: cells [0,14) x [0,10). Interior walls split off a lab
    // (x>=8, z<5) and a storage room (x>=8, z>=5) from the common room.
    const FLOOR_TOP: f32 = 6.0 / 128.0; // ground tiles are 6 cm thick

    // ---- floors: concrete inside; grass yard, asphalt road, sandstone path
    for gx in -3..17 {
        for gz in -3..13 {
            let inside = (0..14).contains(&gx) && (0..10).contains(&gz);
            let cm = if inside {
                &concrete
            } else if gz >= 11 {
                &asphalt // the road along the south side
            } else if gx == 4 && gz == 10 {
                &sandstone // door step path
            } else {
                &grass
            };
            scene.place(cm, Mat4::from_translation(Vec3::new(gx as f32 + 0.5, 0.0, gz as f32 + 0.5)));
        }
    }

    let rot_q = |q: i32| Mat4::from_rotation_y(q as f32 * FRAC_PI_2);
    // ---- perimeter walls (tagged with their outward direction for the
    // per-yaw dollhouse hide). Corner legs are one cell long, so each edge run
    // starts at 1 and ends at len-1.
    for x in 1..13 {
        // north edge (z=0), outward -Z (bit3)
        let cm = if [3, 6, 10].contains(&x) { &win } else { &wall };
        let first = scene.place(cm, Mat4::from_translation(Vec3::new(x as f32 + 0.5, 0.0, 0.0)));
        scene.tag_hide(first, 0b1000);
        // south edge (z=10), outward +Z (bit1); main door at x=4
        let cm = if x == 4 { &door } else if [8, 11].contains(&x) { &win } else { &wall };
        let t = Mat4::from_translation(Vec3::new(x as f32 + 0.5, 0.0, 10.0)) * Mat4::from_rotation_y(PI);
        let first = scene.place(cm, t);
        scene.tag_hide(first, 0b0010);
    }
    for z in 1..9 {
        // west edge (x=0), outward -X (bit2)
        let cm = if z == 4 { &win } else { &wall };
        let t = Mat4::from_translation(Vec3::new(0.0, 0.0, z as f32 + 0.5)) * rot_q(1);
        let first = scene.place(cm, t);
        scene.tag_hide(first, 0b0100);
        // east edge (x=14), outward +X (bit0)
        let cm = if [2, 7].contains(&z) { &win } else { &wall };
        let t = Mat4::from_translation(Vec3::new(14.0, 0.0, z as f32 + 0.5)) * rot_q(1);
        let first = scene.place(cm, t);
        scene.tag_hide(first, 0b0001);
    }
    // perimeter corners: (vertex, quarter-turns, outward bits of both sides)
    for (vx, vz, q, bits) in [(0, 0, 3, 0b1100u8), (14, 0, 2, 0b1001), (14, 10, 1, 0b0011), (0, 10, 0, 0b0110)] {
        let t = Mat4::from_translation(Vec3::new(vx as f32, 0.0, vz as f32)) * rot_q(q);
        let first = scene.place(&corner, t);
        scene.tag_hide(first, bits);
    }

    // ---- interior walls (never hidden; rotate with Q/E to see past them)
    for z in 0..10 {
        // x=8 divider, doors into the lab (z=2) and storage (z=7)
        let cm = if z == 2 || z == 7 { &door } else { &wall };
        scene.place(cm, Mat4::from_translation(Vec3::new(8.0, 0.0, z as f32 + 0.5)) * rot_q(1));
    }
    for x in 8..14 {
        // z=5 divider between lab and storage, door at x=11
        let cm = if x == 11 { &door } else { &wall };
        scene.place(cm, Mat4::from_translation(Vec3::new(x as f32 + 0.5, 0.0, 5.0)));
    }

    // ---- props (forge catalogue), scaled to real-world heights (1 wu = 1.28 m)
    let mut prop_cache: std::collections::HashMap<&str, gltf_scene::CachedModel> = Default::default();
    let props: &[(&str, f32, f32, f32, f32)] = &[
        // (prop id, target height wu, x, z, rotation deg)
        ("mainframe-with-many-distinct-status-lights", 1.40, 2.0, 1.1, 180.0),
        ("commodore-pet-inspired-computer", 0.45, 3.6, 1.0, 180.0),
        ("large-desk-without-drawers", 0.62, 3.0, 3.2, 0.0),
        ("professional-workbench-chair", 0.75, 3.0, 4.2, 180.0),
        ("eames-style-chair-but-in-our-scifi-style", 0.68, 6.2, 7.6, -45.0),
        ("tall-standing-lamp", 1.35, 7.2, 0.9, 0.0),
        ("braun-inspired-desk", 0.60, 10.5, 1.3, 0.0),
        ("microscope", 0.35, 9.3, 1.4, 30.0),
        ("chemical-flask", 0.22, 11.9, 1.5, 0.0),
        ("professional-workbench-chair", 0.75, 10.5, 2.3, 180.0),
        ("mainframe-with-many-distinct-status-lights", 1.40, 13.1, 2.5, 270.0),
        ("ammo-crate", 0.40, 9.3, 8.7, 10.0),
        ("ammo-crate", 0.40, 10.3, 8.6, 35.0),
        ("ammo-crate", 0.40, 9.7, 7.8, 75.0),
        ("tall-standing-lamp", 1.35, 13.2, 9.1, 0.0),
        ("stop-sign", 1.70, 16.2, 10.6, 200.0),
        ("ammo-crate", 0.40, -1.4, 5.2, 50.0),
    ];
    for &(id, target_h, x, z, rot_deg) in props {
        let path = format!("assets/forge/props/{id}/processed/model.glb");
        if !prop_cache.contains_key(id) {
            match scene.preload(&path) {
                Ok(cm) => {
                    prop_cache.insert(id, cm);
                }
                Err(e) => {
                    eprintln!("skip prop {id}: {e}");
                    continue;
                }
            }
        }
        let cm = &prop_cache[id];
        let (pmin, pmax) = cm.bounds();
        let pc = (pmin + pmax) * 0.5;
        let s = target_h / (pmax.y - pmin.y).max(1e-4);
        let t = Mat4::from_translation(Vec3::new(x, FLOOR_TOP, z))
            * Mat4::from_rotation_y(rot_deg.to_radians())
            * Mat4::from_scale(Vec3::splat(s))
            * Mat4::from_translation(Vec3::new(-pc.x, -pmin.y, -pc.z));
        scene.place(cm, t);
    }

    // ---- emissive practicals: with the sun dimmed (lighting below) these
    // carry the interiors. The path tracer treats emissive boxes as real area
    // lights — warm pools + colored bounce for free. Sizes stay on the 0.0625
    // wu lattice (invariant #8). Walls are ±0.125 wu thick, so sconces sit at
    // 0.156 off the wall line (proud of the inner face).
    // EMIT env var scales all practicals (tuning knob, default 1)
    let emit: f32 = std::env::var("EMIT").ok().and_then(|s| s.parse().ok()).unwrap_or(1.0);
    let warm = move |s: f32| [1.0 * s * emit, 0.64 * s * emit, 0.30 * s * emit, 1.0];
    let mut bulb = |p: Vec3, half: f32, e: [f32; 4]| {
        scene.add_box_world(p - Vec3::splat(half), p + Vec3::splat(half), [1.0, 0.95, 0.85, 1.0], e, 0.6, 0.0);
    };
    // heads of the two tall-standing-lamp props (1.35 wu tall)
    bulb(Vec3::new(7.2, 1.125, 0.9), 0.0625, warm(150.0));
    bulb(Vec3::new(13.2, 1.125, 9.1), 0.0625, warm(150.0));
    // ceiling lights: the main interior lights (no sun — interiors are
    // lamp-lit). CONCEPTUAL emitters: no fixture geometry is rendered (there
    // is no ceiling to mount one on) — they exist only in the NEE light list,
    // so rooms get lit from above with nothing floating in view.
    let ceiling_lamps = [(2.5f32, 2.5f32), (5.0, 7.0), (11.0, 2.5), (11.0, 7.5)];
    for (x, z) in ceiling_lamps {
        let c = warm(80.0);
        scene.point_lights.push([x, 2.0, z, 0.25, c[0], c[1], c[2], 0.0]);
    }
    // wall sconces: (center, which axis is the wall normal)
    let sconces: &[(f32, f32, f32, bool)] = &[
        (2.5, 1.625, 0.156, false),    // common room, north wall
        (0.156, 1.625, 6.5, true),     // common room, west wall
        (6.5, 1.625, 9.844, false),    // common room, south wall
        (9.5, 1.625, 0.156, false),    // lab, north wall
        (12.5, 1.625, 4.844, false),   // lab, divider wall
        (4.5, 1.875, 10.156, false),   // porch light over the front door
    ];
    for &(x, y, z, x_normal) in sconces {
        let (hx, hz) = if x_normal { (0.03125, 0.09375) } else { (0.09375, 0.03125) };
        let (min, max) = (Vec3::new(x - hx, y - 0.0625, z - hz), Vec3::new(x + hx, y + 0.0625, z + hz));
        scene.add_box_world(min, max, [1.0, 0.9, 0.75, 1.0], warm(90.0), 0.7, 0.0);
    }
    // status-light glow strips on the two mainframes (teal, faint) — placed
    // just proud of each prop's front face, sized from the cached bounds
    if let Some(cm) = prop_cache.get("mainframe-with-many-distinct-status-lights") {
        let (pmin, pmax) = cm.bounds();
        let teal = [0.25 * 12.0 * emit, 1.0 * 12.0 * emit, 0.8 * 12.0 * emit, 1.0];
        let s = 1.40 / (pmax.y - pmin.y).max(1e-4);
        let half_d = (pmax.z - pmin.z) * 0.5 * s;
        // (2.0, 1.1) rot 180 -> front faces +Z
        let f = 1.1 + half_d + 0.03;
        scene.add_box_world(Vec3::new(1.875, 0.5625, f), Vec3::new(2.125, 0.9375, f + 0.03), [0.1, 0.3, 0.25, 1.0], teal, 0.8, 0.0);
        scene.prim_light_dir.resize(scene.primitives.len(), [0.0; 3]);
        *scene.prim_light_dir.last_mut().unwrap() = [0.0, 0.0, 1.0]; // screen emits forward (+Z), not through the desk
        // (13.1, 2.5) rot 270 -> front faces -X (depth becomes the x extent)
        let f = 13.1 - half_d - 0.06;
        scene.add_box_world(Vec3::new(f, 0.5625, 2.375), Vec3::new(f + 0.03, 0.9375, 2.625), [0.1, 0.3, 0.25, 1.0], teal, 0.8, 0.0);
        scene.prim_light_dir.resize(scene.primitives.len(), [0.0; 3]);
        *scene.prim_light_dir.last_mut().unwrap() = [-1.0, 0.0, 0.0]; // screen emits forward (-X)
    }

    scene.recompute_bounds();
    scene.prim_hide_mask.resize(scene.primitives.len(), 0);
    scene.floor_rect = [0.3, 0.3, 13.7, 9.7];
    scene.dynamic_prim = None; // no player — WASD pans the camera
    scene.player_start = Vec3::new(7.0, 0.0, 5.0); // seeds the camera target
    // night mood: NO sun — interiors are entirely lamp-lit (ceiling lamps +
    // sconces + practicals); a faint sky fill keeps the yard readable and a
    // knee-deep ground mist sits outside. SUN/SKY/FOG/FOG_H override for tuning.
    scene.lighting = [0.0, 0.45, 0.3, 0.6];
    Ok(scene)
}

pub fn build_scene() -> Result<Scene, Box<dyn std::error::Error>> {
    match std::env::var("SCENE").as_deref() {
        Ok("grid") | Ok("grid-walker") => return build_grid_walker(),
        Ok("house") => return build_house(),
        Ok("lab") => return build_lab(),
        _ => {}
    }
    if std::env::var("SHOWCASE").is_ok() {
        return build_showcase();
    }
    let mut scene = Scene::new();
    let room = "assets/tilesets/desert_sandstone/project/example_room.glb";
    // open the ceiling for a top-down dollhouse view: drop triangles in the top
    // ~25% of the room's height.
    let (room_min, room_max) = Scene::file_bounds(room)?;
    let clip_y = room_min.y + (room_max.y - room_min.y) * 0.72;
    // Near-wall cull (dollhouse): at the canonical iso yaw the camera sits in
    // the +toward_h direction, so those walls block the interior. Skip when
    // orbiting (that camera rotates, so a baked cull would be wrong).
    let cull = if std::env::var("ORBIT").is_ok() {
        None
    } else {
        let yaw = ISO_YAW_DEG.to_radians();
        let toward_h = Vec3::new(yaw.sin(), 0.0, yaw.cos()).normalize();
        let center = (room_min + room_max) * 0.5;
        let thresh = 0.3 * (room_max - center).dot(toward_h);
        Some(gltf_scene::WallCull { toward_h, center, thresh })
    };
    scene.add_file_ex(room, Mat4::IDENTITY, clip_y, cull)?;
    // Use the FULL room bounds (pre-cull) for the floor / placement / collision —
    // the near-wall cull shrinks the rendered AABB on the camera side, so a
    // post-cull bbox would give an undersized, offset floor + walkable rect.
    let (rmin, rmax) = (room_min, room_max);
    // example_room.glb is walls-only — add a sandstone ground plane to sit on.
    scene.add_floor(rmin.x, rmax.x, rmin.z, rmax.z, rmin.y, [0.80, 0.76, 0.68, 1.0]);
    let rext = rmax - rmin;
    let floor_y = rmin.y;
    let center = (rmin + rmax) * 0.5;
    let target = rext.max_element() * 0.13;
    let radius = rext.x.min(rext.z) * 0.28;

    // Favour props that carry actual colour (the red stop-sign, the mainframe's
    // status lights + gold trim, the commodore-pet's accents) — most of the
    // catalogue is pale clay, so these are where the renderer shows colour.
    let props = [
        "assets/forge/props/mainframe-with-many-distinct-status-lights/processed/model.glb",
        "assets/forge/props/stop-sign/processed/model.glb",
        "assets/forge/props/commodore-pet-inspired-computer/processed/model.glb",
        "assets/forge/props/microscope/processed/model.glb",
        "assets/forge/props/tall-standing-lamp/processed/model.glb",
        "assets/forge/props/chemical-flask/processed/model.glb",
        "assets/forge/props/eames-style-chair-but-in-our-scifi-style/processed/model.glb",
    ];
    // Collision (mirrors @common/gameplay): the player is confined to the floor
    // rect inset by the walls + its own radius, and blocked by prop footprints.
    const PLAYER_R: f32 = 0.18;
    const WALL_INSET: f32 = 0.45;
    let inset = WALL_INSET + PLAYER_R;
    let mut solids: Vec<[f32; 4]> = Vec::new();

    let golden = 2.399_963_2_f32;
    for (i, path) in props.iter().enumerate() {
        let (pmin, pmax) = match Scene::file_bounds(path) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("skip {path}: {e}");
                continue;
            }
        };
        let pext = pmax - pmin;
        eprintln!("  prop {i} {path}: bounds {pmin:?}..{pmax:?} ext {pext:?}");
        let scale = target / pext.max_element().max(1e-4);
        let angle = i as f32 * golden;
        let pos = Vec3::new(center.x + angle.cos() * radius, floor_y, center.z + angle.sin() * radius);
        let pcenter = (pmin + pmax) * 0.5;
        // scale about prop center, drop so its base sits on the floor, then translate to pos
        let transform = Mat4::from_translation(pos)
            * Mat4::from_rotation_y(angle * 1.7)
            * Mat4::from_scale(Vec3::splat(scale))
            * Mat4::from_translation(Vec3::new(-pcenter.x, -pmin.y, -pcenter.z));
        let before = scene.indices.len();
        if let Err(e) = scene.add_file(path, transform, f32::INFINITY) {
            eprintln!("skip {path}: {e}");
            continue;
        }
        eprintln!("    -> added {} tris (transform col3 {:?})", (scene.indices.len() - before) / 3, transform.col(3));
        // rotation-agnostic footprint: half the larger XZ extent, + player radius.
        let r = scale * pext.x.max(pext.z) * 0.5 + PLAYER_R;
        solids.push([pos.x - r, pos.z - r, pos.x + r, pos.z + r]);
    }

    // Coloured emissive accent lights — the catalogue props are pale clay, so
    // these little glowing pillars are where the path tracer gets its colour
    // (direct + bounced). Each is also a solid the player can't walk through.
    let lights: [(Vec3, [f32; 3], f32); 4] = [
        (Vec3::new(center.x - radius * 0.95, floor_y, center.z - radius * 0.25), [0.10, 0.85, 1.00], 9.0), // cyan
        (Vec3::new(center.x + radius * 0.95, floor_y, center.z + radius * 0.30), [1.00, 0.40, 0.10], 8.0), // orange
        (Vec3::new(center.x + radius * 0.10, floor_y, center.z - radius * 0.95), [0.45, 1.00, 0.25], 7.0), // green
        (Vec3::new(center.x - radius * 0.25, floor_y, center.z + radius * 0.95), [0.80, 0.20, 1.00], 8.0), // violet
    ];
    for (p, c, s) in lights {
        let (hw, h) = (0.07_f32, 0.30_f32);
        scene.add_box_world(Vec3::new(p.x - hw, p.y, p.z - hw), Vec3::new(p.x + hw, p.y + h, p.z + hw), [c[0], c[1], c[2], 1.0], [c[0] * s, c[1] * s, c[2] * s, 1.0], 0.4, 0.0);
        let r = hw + PLAYER_R;
        solids.push([p.x - r, p.z - r, p.x + r, p.z + r]);
    }

    scene.recompute_bounds(); // bounds = room + floor + props + lights (before the movable player)
    scene.floor_rect = [rmin.x + inset, rmin.z + inset, rmax.x - inset, rmax.z - inset];
    scene.solids = solids;

    // Movable player marker: a small emissive box, added LAST in local space so
    // a per-frame TLAS instance transform moves it (the dynamic-scene path).
    let pidx = scene.add_box_local(PLAYER_R, 0.42, PLAYER_R, [0.90, 0.25, 0.18, 1.0], [0.95, 0.28, 0.16, 1.0]);
    scene.dynamic_prim = Some(pidx);
    scene.player_start = Vec3::new(center.x, floor_y, center.z);
    Ok(scene)
}

/// A row of props on a floor tile — to inspect prop detail/colour up close.
pub fn build_showcase() -> Result<Scene, Box<dyn std::error::Error>> {
    let mut scene = Scene::new();
    let floor = "assets/tilesets/greek_island_white/artifacts/tiles/floor_tile/floor_tile.glb";
    if let Ok((fmin, fmax)) = Scene::file_bounds(floor) {
        let fext = fmax - fmin;
        let fc = (fmin + fmax) * 0.5;
        let s = 7.5 / fext.x.max(fext.z).max(1e-4);
        let t = Mat4::from_scale(Vec3::new(s, s, s)) * Mat4::from_translation(Vec3::new(-fc.x, -fmax.y, -fc.z));
        scene.add_file(floor, t, f32::INFINITY)?;
    }
    let props = [
        "assets/forge/props/stop-sign/processed/model.glb",
        "assets/forge/props/mainframe-with-many-distinct-status-lights/processed/model.glb",
        "assets/forge/props/commodore-pet-inspired-computer/processed/model.glb",
        "assets/forge/props/tall-standing-lamp/processed/model.glb",
    ];
    for (i, path) in props.iter().enumerate() {
        let (pmin, pmax) = Scene::file_bounds(path)?;
        let pext = pmax - pmin;
        let pc = (pmin + pmax) * 0.5;
        let scale = 2.0 / pext.max_element().max(1e-4);
        let x = (i as f32 - (props.len() as f32 - 1.0) * 0.5) * 1.9;
        let transform = Mat4::from_translation(Vec3::new(x, 0.0, 0.0))
            * Mat4::from_scale(Vec3::splat(scale))
            * Mat4::from_translation(Vec3::new(-pc.x, -pmin.y, -pc.z));
        scene.add_file(path, transform, f32::INFINITY)?;
    }
    scene.recompute_bounds();
    Ok(scene)
}

/// The ISO_VIEW_CONTRACT camera basis (forward, right, up) for a turntable
/// offset. `right = dir×Y`, `up = right×dir` reproduces three.js `lookAt`
/// exactly, so this matches the engine's `IsoCamera` projection.
pub fn iso_basis(yaw_off_deg: f32) -> (Vec3, Vec3, Vec3) {
    let yaw = (ISO_YAW_DEG + yaw_off_deg).to_radians();
    let pitch = ISO_PITCH_DEG.to_radians();
    let offset = Vec3::new(yaw.sin() * pitch.cos(), pitch.sin(), yaw.cos() * pitch.cos());
    let dir = -offset; // look toward target
    let right = dir.cross(Vec3::Y).normalize();
    let up = right.cross(dir).normalize();
    (dir, right, up)
}

/// Project the scene AABB into low-res screen space (lowpixels) at scale R for
/// the given basis, returning (xmin, xmax, ymin, ymax) about the scene centroid.
pub fn iso_screen_bounds(scene: &Scene, right: Vec3, up: Vec3) -> (f32, f32, f32, f32) {
    let centroid = (scene.min + scene.max) * 0.5;
    let (mut xmin, mut xmax, mut ymin, mut ymax) = (f32::MAX, f32::MIN, f32::MAX, f32::MIN);
    for cx in [scene.min.x, scene.max.x] {
        for cy in [scene.min.y, scene.max.y] {
            for cz in [scene.min.z, scene.max.z] {
                let rel = Vec3::new(cx, cy, cz) - centroid;
                let sx = rel.dot(right) * ISO_R;
                let sy = rel.dot(up) * ISO_R;
                xmin = xmin.min(sx); xmax = xmax.max(sx);
                ymin = ymin.min(sy); ymax = ymax.max(sy);
            }
        }
    }
    (xmin, xmax, ymin, ymax)
}

/// Low-res buffer size in lowpixels. A still tightly fits the scene's projected
/// bbox at the canonical yaw; an orbit uses the bounding-sphere diameter so the
/// frame size stays constant across azimuths.
pub fn iso_frame_size(scene: &Scene, orbit: bool, margin: u32) -> (u32, u32) {
    if orbit {
        let r = (scene.max - scene.min).length() * 0.5;
        let d = (2.0 * r * ISO_R).ceil() as u32 + 2 * margin;
        (d, d)
    } else {
        let (_, right, up) = iso_basis(0.0);
        let (xmin, xmax, ymin, ymax) = iso_screen_bounds(scene, right, up);
        ((xmax - xmin).ceil() as u32 + 2 * margin, (ymax - ymin).ceil() as u32 + 2 * margin)
    }
}

// ---- stylized post stack (CPU mirror of tonemap.comp — keep in sync) -------
// Applied per LOW-RES texel (one game pixel = one post sample) after
// exposure/Reinhard/gamma: grade -> film grain -> ordered-dither palette.

/// Hand-designed 32-colour palette (gamma space): teal shadow ramp, olive
/// midtones, lamp amber, bone highlights + terminal/rust/hazard/grass accents.
/// Mirrored in tonemap.comp `PAL` — keep in sync.
pub const PALETTE32: [[f32; 3]; 32] = [
    [0.0196, 0.0235, 0.0314], [0.0510, 0.0549, 0.0784],
    [0.0824, 0.0941, 0.1373], [0.1137, 0.1412, 0.2000],
    [0.1529, 0.2039, 0.2784], [0.1961, 0.2118, 0.1686],
    [0.2588, 0.2745, 0.2275], [0.3333, 0.3529, 0.2784],
    [0.4157, 0.4392, 0.3373], [0.5137, 0.5373, 0.4078],
    [0.6157, 0.6392, 0.4941], [0.2275, 0.1647, 0.1098],
    [0.3608, 0.2549, 0.1569], [0.5216, 0.3608, 0.2000],
    [0.6902, 0.4902, 0.2549], [0.8392, 0.6431, 0.3373],
    [0.9490, 0.8118, 0.5412], [0.7098, 0.7020, 0.6039],
    [0.8157, 0.8039, 0.7059], [0.9098, 0.8941, 0.8118],
    [0.9804, 0.9647, 0.9020], [0.1137, 0.2902, 0.2902],
    [0.1843, 0.4784, 0.4314], [0.3216, 0.7686, 0.6588],
    [0.2902, 0.1137, 0.1137], [0.5412, 0.2000, 0.1529],
    [0.7608, 0.3373, 0.2118], [0.6510, 0.4157, 0.1216],
    [0.8784, 0.6039, 0.1686], [0.1647, 0.2118, 0.1333],
    [0.2667, 0.3294, 0.1882], [0.3961, 0.4667, 0.2902],
];

/// 8x8 Bayer matrix value for a low-res pixel, centred to [-0.5, 0.5).
pub fn bayer8(lx: u32, ly: u32) -> f32 {
    const B: [u8; 64] = [
        0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26,
        12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
        3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25,
        15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
    ];
    (B[((lx & 7) + (ly & 7) * 8) as usize] as f32 + 0.5) / 64.0 - 0.5
}

fn post_luma(c: [f32; 3]) -> f32 {
    c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722
}

/// Fallout-ish grade: desaturate a touch, split-tone teal shadows / amber
/// highlights, soft lift, gentle s-curve. Mirror of tonemap.comp `grade()`.
pub fn post_grade(c: [f32; 3]) -> [f32; 3] {
    let y = post_luma(c);
    let teal = [0.04f32, 0.10, 0.10];
    let amber = [0.10f32, 0.06, -0.04];
    let mut g = [0.0f32; 3];
    for i in 0..3 {
        let v = c[i] + (y - c[i]) * 0.22;
        let v = v + teal[i] * (1.0 - y) * 0.55 + amber[i] * y * 0.55;
        let v = (v * 0.92 + 0.02).clamp(0.0, 1.0);
        let s = v * v * (3.0 - 2.0 * v);
        g[i] = (v + (s - v) * 0.35).clamp(0.0, 1.0);
    }
    g
}

/// Animated film grain, per game pixel, luminance-weighted toward shadows.
/// Same hash + weighting as tonemap.comp.
pub fn post_grain(c: [f32; 3], lx: u32, ly: u32, frame: u32, strength: f32) -> [f32; 3] {
    if strength <= 0.0 {
        return c;
    }
    let mut x = lx.wrapping_mul(1973).wrapping_add(ly.wrapping_mul(9277)).wrapping_add(frame.wrapping_mul(26699)).wrapping_add(1);
    x ^= x >> 16;
    x = x.wrapping_mul(0x7feb352d);
    x ^= x >> 15;
    x = x.wrapping_mul(0x846ca68b);
    x ^= x >> 16;
    let g = x as f32 * (1.0 / 4294967296.0) - 0.5;
    let w = strength * (0.35 + 0.65 * (1.0 - post_luma(c)));
    [(c[0] + g * w).clamp(0.0, 1.0), (c[1] + g * w).clamp(0.0, 1.0), (c[2] + g * w).clamp(0.0, 1.0)]
}

/// Ordered-dither quantize to PALETTE32. Mirror of tonemap.comp.
pub fn post_palette(c: [f32; 3], lx: u32, ly: u32) -> [f32; 3] {
    let bay = bayer8(lx, ly) * 0.07;
    let c2 = [(c[0] + bay).clamp(0.0, 1.0), (c[1] + bay).clamp(0.0, 1.0), (c[2] + bay).clamp(0.0, 1.0)];
    let mut best = f32::INFINITY;
    let mut bc = c2;
    for p in &PALETTE32 {
        let d = (p[0] - c2[0]).powi(2) + (p[1] - c2[1]).powi(2) + (p[2] - c2[2]).powi(2);
        if d < best {
            best = d;
            bc = *p;
        }
    }
    bc
}

/// Build the pixel-perfect ISO_VIEW_CONTRACT camera: orthographic, scale locked
/// to R lowpixels/wu, scene centred in a `low_w × low_h` buffer.
pub fn iso_camera(scene: &Scene, low_w: u32, low_h: u32, yaw_off_deg: f32) -> Push {
    let (_dir, right, up) = iso_basis(yaw_off_deg);
    let centroid = (scene.min + scene.max) * 0.5;
    let (xmin, xmax, ymin, ymax) = iso_screen_bounds(scene, right, up);
    // re-centre target on the projected bbox centre (in world units)
    let target = centroid + right * ((xmin + xmax) * 0.5 / ISO_R) + up * ((ymin + ymax) * 0.5 / ISO_R);
    iso_camera_at(scene, low_w, low_h, yaw_off_deg, target)
}

/// Same as `iso_camera` but with an explicit world-space look-at `target`
/// (used by the interactive viewer to pan). half-extents lock the scale.
pub fn iso_camera_at(scene: &Scene, low_w: u32, low_h: u32, yaw_off_deg: f32, target: Vec3) -> Push {
    let (dir, right, up) = iso_basis(yaw_off_deg);
    let half_w = low_w as f32 / (2.0 * ISO_R);
    let half_h = low_h as f32 / (2.0 * ISO_R);
    let dist = (scene.max - scene.min).length() * 1.5 + 5.0;
    let pos = target - dir * dist;
    Push {
        cam_right: [right.x, right.y, right.z, half_w],
        cam_up: [up.x, up.y, up.z, half_h],
        cam_dir: [dir.x, dir.y, dir.z, 0.0],
        cam_pos: [pos.x, pos.y, pos.z, 0.0],
        misc: [low_w as i32, low_h as i32, std::env::var("BOUNCES").ok().and_then(|s| s.parse().ok()).unwrap_or(BOUNCES), SPP_PER],
        misc2: [0; 4],
        env0: lighting_env(scene),
    }
}

/// Scene lighting defaults with SUN / SKY / FOG / FOG_H env-var overrides
/// (live-tuning knobs; see `Scene::lighting` for the meaning of each slot).
pub fn lighting_env(scene: &Scene) -> [f32; 4] {
    let mut e = scene.lighting;
    for (i, var) in ["SUN", "SKY", "FOG", "FOG_H"].iter().enumerate() {
        if let Some(v) = std::env::var(var).ok().and_then(|s| s.parse().ok()) {
            e[i] = v;
        }
    }
    e
}

// ---- pixel-perfect interactive-view math (pure, unit-tested) ----------------
// These encode the ISO_VIEW_CONTRACT interactive rules independently of Vulkan
// so they can be regression-tested. The viewer calls them; the display crop is
// `low_pixel(out) = round(pan) + out / render_scale`.

/// Integer render scale for a zoom over a base scale (#4: round(zoom·base)).
pub fn render_scale(zoom: f32, base: u32) -> i32 {
    ((zoom * base as f32).round() as i32).max(1)
}

/// Pan that keeps the low-pixel under window-pixel `c` fixed when the render
/// scale changes `rs0 -> rs1` (#6 zoom-anchor): low_pixel = pan + c/rs is held.
pub fn zoom_anchor_pan(pan: glam::Vec2, c: glam::Vec2, rs0: f32, rs1: f32) -> glam::Vec2 {
    pan + c * (1.0 / rs0 - 1.0 / rs1)
}

/// Clamp the crop so the `vis`-sized visible region stays inside the `low`
/// buffer (overscan headroom; beyond it the guard band would show, #7).
pub fn clamp_pan(pan: glam::Vec2, low: glam::Vec2, vis: glam::Vec2) -> glam::Vec2 {
    glam::Vec2::new(pan.x.clamp(0.0, (low.x - vis.x).max(0.0)), pan.y.clamp(0.0, (low.y - vis.y).max(0.0)))
}

/// Split an accumulated sub-pixel camera move into the whole low-pixel steps to
/// apply now and the fractional remainder to carry to the next input (#5,
/// applied to the *camera* so a moving iso view stays on the pixel lattice —
/// no sub-pixel crawl/shimmer). Round (not trunc) keeps |remainder| ≤ 0.5.
pub fn whole_pixel_step(accum: glam::Vec2) -> (glam::Vec2, glam::Vec2) {
    let whole = glam::Vec2::new(accum.x.round(), accum.y.round());
    (whole, accum - whole)
}

// ---- native game runtime: collision + iso input (mirrors @common/gameplay) --
// The TS engine can't be imported here, so these replicate its movement rules:
// `LevelResource.isBlocked(x,y)` (single-point solidity test) and the iso 2:1
// input mapping (`bDir = -inputY * 0.5`, normalised, projected onto a pixel
// basis) with the smoothness-floor speed.

/// The walkable level: a floor rect plus solid prop footprints, all in world
/// XZ. `is_blocked` mirrors `@common/gameplay`'s `LevelResource.isBlocked` —
/// out of the floor rect (the walls) or inside a solid = blocked.
#[derive(Clone, Default)]
pub struct Level {
    pub floor: [f32; 4], // xmin, zmin, xmax, zmax (walkable, already wall-inset)
    pub solids: Vec<[f32; 4]>, // xmin, zmin, xmax, zmax footprints
}

impl Level {
    pub fn from_scene(scene: &Scene) -> Level {
        Level { floor: scene.floor_rect, solids: scene.solids.clone() }
    }

    /// True if world point (x, z) is non-walkable (outside the floor rect, or
    /// inside any solid). Out-of-bounds = blocked, matching the TS grid level.
    pub fn is_blocked(&self, x: f32, z: f32) -> bool {
        if x < self.floor[0] || z < self.floor[1] || x > self.floor[2] || z > self.floor[3] {
            return true;
        }
        self.solids.iter().any(|s| x >= s[0] && z >= s[1] && x <= s[2] && z <= s[3])
    }
}

/// World-space ground-plane deltas for one screen pixel: `u` = +1 px right,
/// `v` = +1 px down. The native mirror of the web `IsoCamera.getSnapBasis()`
/// ground-raycast basis. Horizontal pixels move 1/R wu along the screen-right
/// floor direction; vertical pixels are foreshortened by sin(pitch) = 1/2, so
/// one px down is **2/R** wu toward the camera. (Getting this 2× wrong halves
/// vertical screen speed and turns the 2:1 diagonal stair into 4:1.)
pub fn iso_pixel_basis(yaw_off_deg: f32) -> (Vec3, Vec3) {
    let yaw = (ISO_YAW_DEG + yaw_off_deg).to_radians();
    let sin_pitch = ISO_PITCH_DEG.to_radians().sin(); // 1/2 exact
    let right_floor = Vec3::new(yaw.cos(), 0.0, -yaw.sin());
    let toward_cam = Vec3::new(yaw.sin(), 0.0, yaw.cos()); // -fwd_floor
    (right_floor / ISO_R, toward_cam / (ISO_R * sin_pitch))
}

/// Convert a screen-pixel delta (x right, y down) into a world ground delta.
pub fn screen_px_to_world(d: glam::Vec2, yaw_off_deg: f32) -> Vec3 {
    let (u, v) = iso_pixel_basis(yaw_off_deg);
    u * d.x + v * d.y
}

/// Snap a ground point to the nearest cell of the screen-pixel lattice,
/// staying on its ground plane (y preserved) — the native mirror of
/// `IsoGameView.snapWorldPointOnGround(.., "nearest")` with the uniform (1, 1)
/// granularity the engine mandates (CLAUDE.md invariant #9). The web routes
/// every mesh `setPosition` through this so a moving box renders identically
/// on every frame it occupies a pixel cell.
pub fn snap_ground_to_lattice(p: Vec3, yaw_off_deg: f32) -> Vec3 {
    let (_dir, right, up) = iso_basis(yaw_off_deg);
    let (u, v) = iso_pixel_basis(yaw_off_deg);
    let a = p.dot(right) * ISO_R; // screen px right
    let b = -p.dot(up) * ISO_R; // screen px down
    p + u * (a.round() - a) + v * (b.round() - b)
}

/// The iso 2:1 input direction (mirrors `createControlledInputSystem`): combine
/// the axis inputs, scale the vertical by 0.5 so a diagonal traces the clean
/// (2,1) screen stair, then normalise. Returns a unit (right, down) screen
/// vector, or None when there is no input. Pure up → (0,-1); up+right →
/// (2/√5, -1/√5) ≈ (0.894, -0.447) = the engine's ISO_INPUT_DIAGONAL rates.
pub fn iso_input_dir(input_x: f32, input_y: f32) -> Option<glam::Vec2> {
    if input_x == 0.0 && input_y == 0.0 {
        return None;
    }
    let a = input_x;
    let b = -input_y * 0.5;
    let len = (a * a + b * b).sqrt();
    Some(glam::Vec2::new(a / len, b / len))
}

/// The smoothness-floor speed in screen px/s (mirrors
/// `recommendedMinPxPerSecForIso`): `fps / (2/√5) = fps·√5/2` ≈ 67 @ 60 fps.
/// Below this the dominant axis advances < 1 px/frame and motion ticks visibly.
pub fn recommended_min_px_per_sec(fps: f32) -> f32 {
    fps * 5.0_f32.sqrt() / 2.0
}

/// The look-at target `iso_camera` centres on: the scene centroid shifted to
/// the middle of its projected bbox. The interactive viewer seeds its movable
/// camera target with this.
pub fn iso_target(scene: &Scene) -> Vec3 {
    let (_dir, right, up) = iso_basis(0.0);
    let centroid = (scene.min + scene.max) * 0.5;
    let (xmin, xmax, ymin, ymax) = iso_screen_bounds(scene, right, up);
    centroid + right * ((xmin + xmax) * 0.5 / ISO_R) + up * ((ymin + ymax) * 0.5 / ISO_R)
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

pub fn tlas_geometry(addr: u64) -> vk::AccelerationStructureGeometryKHR<'static> {
    vk::AccelerationStructureGeometryKHR::default()
        .geometry_type(vk::GeometryTypeKHR::INSTANCES)
        .flags(vk::GeometryFlagsKHR::OPAQUE)
        .geometry(vk::AccelerationStructureGeometryDataKHR {
            instances: vk::AccelerationStructureGeometryInstancesDataKHR::default().array_of_pointers(false).data(vk::DeviceOrHostAddressConstKHR { device_address: addr }),
        })
}

pub fn dslb(binding: u32, ty: vk::DescriptorType, count: u32) -> vk::DescriptorSetLayoutBinding<'static> {
    vk::DescriptorSetLayoutBinding::default().binding(binding).descriptor_type(ty).descriptor_count(count).stage_flags(vk::ShaderStageFlags::COMPUTE)
}

pub unsafe fn make_storage_image(ctx: &Ctx, w: u32, h: u32, format: vk::Format) -> (vk::Image, vk::DeviceMemory, vk::ImageView) {
    let image = ctx
        .device
        .create_image(&vk::ImageCreateInfo::default().image_type(vk::ImageType::TYPE_2D).format(format).extent(vk::Extent3D { width: w, height: h, depth: 1 }).mip_levels(1).array_layers(1).samples(vk::SampleCountFlags::TYPE_1).tiling(vk::ImageTiling::OPTIMAL).usage(vk::ImageUsageFlags::STORAGE | vk::ImageUsageFlags::TRANSFER_SRC | vk::ImageUsageFlags::TRANSFER_DST).initial_layout(vk::ImageLayout::UNDEFINED), None)
        .unwrap();
    let req = ctx.device.get_image_memory_requirements(image);
    let mem = ctx.device.allocate_memory(&vk::MemoryAllocateInfo::default().allocation_size(req.size).memory_type_index(find_memory_type(&ctx.mem_props, req.memory_type_bits, vk::MemoryPropertyFlags::DEVICE_LOCAL)), None).unwrap();
    ctx.device.bind_image_memory(image, mem, 0).unwrap();
    let view = ctx.device.create_image_view(&vk::ImageViewCreateInfo::default().image(image).view_type(vk::ImageViewType::TYPE_2D).format(format).subresource_range(vk::ImageSubresourceRange { aspect_mask: vk::ImageAspectFlags::COLOR, base_mip_level: 0, level_count: 1, base_array_layer: 0, layer_count: 1 }), None).unwrap();
    (image, mem, view)
}

pub unsafe fn make_pool(ctx: &Ctx, ntex: u32) -> vk::DescriptorPool {
    let sizes = [
        vk::DescriptorPoolSize { ty: vk::DescriptorType::ACCELERATION_STRUCTURE_KHR, descriptor_count: 1 },
        vk::DescriptorPoolSize { ty: vk::DescriptorType::STORAGE_IMAGE, descriptor_count: 4 },
        vk::DescriptorPoolSize { ty: vk::DescriptorType::STORAGE_BUFFER, descriptor_count: 6 },
        vk::DescriptorPoolSize { ty: vk::DescriptorType::COMBINED_IMAGE_SAMPLER, descriptor_count: ntex.max(1) },
    ];
    ctx.device.create_descriptor_pool(&vk::DescriptorPoolCreateInfo::default().max_sets(1).pool_sizes(&sizes), None).unwrap()
}

#[allow(clippy::too_many_arguments)]
pub unsafe fn make_set(
    ctx: &Ctx,
    layout: vk::DescriptorSetLayout,
    pool: vk::DescriptorPool,
    tlas: vk::AccelerationStructureKHR,
    image_view: vk::ImageView,
    albedo_view: vk::ImageView,
    normal_view: vk::ImageView,
    pos_view: vk::ImageView,
    vbuf: &Buffer,
    ibuf: &Buffer,
    gbuf: &Buffer,
    mbuf: &Buffer,
    lbuf: &Buffer,
    pbuf: &Buffer,
    texes: &[GpuTex],
    sampler: vk::Sampler,
) -> vk::DescriptorSet {
    let layouts = [layout];
    let set = ctx.device.allocate_descriptor_sets(&vk::DescriptorSetAllocateInfo::default().descriptor_pool(pool).set_layouts(&layouts)).unwrap()[0];

    let tlas_arr = [tlas];
    let mut as_ext = vk::WriteDescriptorSetAccelerationStructureKHR::default().acceleration_structures(&tlas_arr);
    let mut w_as = vk::WriteDescriptorSet::default().dst_set(set).dst_binding(0).descriptor_type(vk::DescriptorType::ACCELERATION_STRUCTURE_KHR).push_next(&mut as_ext);
    w_as.descriptor_count = 1;

    let img_info = [vk::DescriptorImageInfo::default().image_view(image_view).image_layout(vk::ImageLayout::GENERAL)];
    let alb_info = [vk::DescriptorImageInfo::default().image_view(albedo_view).image_layout(vk::ImageLayout::GENERAL)];
    let nrm_info = [vk::DescriptorImageInfo::default().image_view(normal_view).image_layout(vk::ImageLayout::GENERAL)];
    let pos_info = [vk::DescriptorImageInfo::default().image_view(pos_view).image_layout(vk::ImageLayout::GENERAL)];
    let vb = [vk::DescriptorBufferInfo::default().buffer(vbuf.buffer).range(vk::WHOLE_SIZE)];
    let ib = [vk::DescriptorBufferInfo::default().buffer(ibuf.buffer).range(vk::WHOLE_SIZE)];
    let gb = [vk::DescriptorBufferInfo::default().buffer(gbuf.buffer).range(vk::WHOLE_SIZE)];
    let mb = [vk::DescriptorBufferInfo::default().buffer(mbuf.buffer).range(vk::WHOLE_SIZE)];
    let lb = [vk::DescriptorBufferInfo::default().buffer(lbuf.buffer).range(vk::WHOLE_SIZE)];
    let pb = [vk::DescriptorBufferInfo::default().buffer(pbuf.buffer).range(vk::WHOLE_SIZE)];
    let tex_info: Vec<vk::DescriptorImageInfo> = texes.iter().map(|t| vk::DescriptorImageInfo::default().image_view(t.view).sampler(sampler).image_layout(vk::ImageLayout::SHADER_READ_ONLY_OPTIMAL)).collect();

    let writes = [
        w_as,
        vk::WriteDescriptorSet::default().dst_set(set).dst_binding(1).descriptor_type(vk::DescriptorType::STORAGE_IMAGE).image_info(&img_info),
        vk::WriteDescriptorSet::default().dst_set(set).dst_binding(2).descriptor_type(vk::DescriptorType::STORAGE_BUFFER).buffer_info(&vb),
        vk::WriteDescriptorSet::default().dst_set(set).dst_binding(3).descriptor_type(vk::DescriptorType::STORAGE_BUFFER).buffer_info(&ib),
        vk::WriteDescriptorSet::default().dst_set(set).dst_binding(4).descriptor_type(vk::DescriptorType::STORAGE_BUFFER).buffer_info(&gb),
        vk::WriteDescriptorSet::default().dst_set(set).dst_binding(5).descriptor_type(vk::DescriptorType::STORAGE_BUFFER).buffer_info(&mb),
        vk::WriteDescriptorSet::default().dst_set(set).dst_binding(6).descriptor_type(vk::DescriptorType::COMBINED_IMAGE_SAMPLER).image_info(&tex_info),
        vk::WriteDescriptorSet::default().dst_set(set).dst_binding(7).descriptor_type(vk::DescriptorType::STORAGE_BUFFER).buffer_info(&lb),
        vk::WriteDescriptorSet::default().dst_set(set).dst_binding(8).descriptor_type(vk::DescriptorType::STORAGE_IMAGE).image_info(&alb_info),
        vk::WriteDescriptorSet::default().dst_set(set).dst_binding(9).descriptor_type(vk::DescriptorType::STORAGE_IMAGE).image_info(&nrm_info),
        vk::WriteDescriptorSet::default().dst_set(set).dst_binding(10).descriptor_type(vk::DescriptorType::STORAGE_IMAGE).image_info(&pos_info),
        vk::WriteDescriptorSet::default().dst_set(set).dst_binding(11).descriptor_type(vk::DescriptorType::STORAGE_BUFFER).buffer_info(&pb),
    ];
    ctx.device.update_descriptor_sets(&writes, &[]);
    set
}

/// All GPU resources derived from a `Scene`: geometry/material buffers, bindless
/// textures, the BLAS-per-primitive + TLAS, and the path-trace compute pipeline.
/// Shared by the headless tool and the interactive viewer.
pub struct SceneGpu {
    pub vbuf: Buffer,
    pub ibuf: Buffer,
    pub gbuf: Buffer,
    pub mbuf: Buffer,
    pub lbuf: Buffer, // emissive light list for NEE (see build)
    pub light_count: u32,
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
    pub pipeline: vk::Pipeline,
    pub shader: vk::ShaderModule,
    /// Deterministic per-frame shade pass (shade.comp) — primary ray + fixed
    /// shadow rays + probe-cache GI; zero per-frame randomness.
    pub shade_pipeline: vk::Pipeline,
    pub shade_shader: vk::ShaderModule,
    /// World-space irradiance probe bake (probes.comp) + its cache buffer:
    /// 16-float header (origin, spacing, dims) + 20 floats per probe
    /// (6-face ambient cube sums + ray count).
    pub probe_pipeline: vk::Pipeline,
    pub probe_shader: vk::ShaderModule,
    pub probe_buf: Buffer,
    pub probe_count: u32,
}

impl SceneGpu {
    /// Upload scene buffers + textures, build one BLAS per primitive + a TLAS,
    /// and create the path-trace compute pipeline + descriptor layout.
    pub unsafe fn build(ctx: &Ctx, scene: &Scene) -> Result<SceneGpu, Box<dyn std::error::Error>> {
        let vbuf = ctx.device_local(&scene.vertices, vk::BufferUsageFlags::STORAGE_BUFFER | vk::BufferUsageFlags::ACCELERATION_STRUCTURE_BUILD_INPUT_READ_ONLY_KHR | vk::BufferUsageFlags::SHADER_DEVICE_ADDRESS);
        let ibuf = ctx.device_local(&scene.indices, vk::BufferUsageFlags::STORAGE_BUFFER | vk::BufferUsageFlags::ACCELERATION_STRUCTURE_BUILD_INPUT_READ_ONLY_KHR | vk::BufferUsageFlags::SHADER_DEVICE_ADDRESS);
        let geom_infos = scene.geom_infos();
        let gbuf = ctx.device_local(&geom_infos, vk::BufferUsageFlags::STORAGE_BUFFER);
        let mbuf = ctx.device_local(&scene.materials, vk::BufferUsageFlags::STORAGE_BUFFER);

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
        for (i, p) in scene.primitives.iter().enumerate() {
            if scene.dynamic_prim == Some(i) {
                continue;
            }
            let e = scene.materials[p.material_id as usize].emissive;
            if e[0].max(e[1]).max(e[2]) < 3.0 {
                continue;
            }
            let vs = &scene.vertices[p.vertex_offset as usize..(p.vertex_offset + p.vertex_count) as usize];
            let mut mn = Vec3::splat(f32::INFINITY);
            let mut mx = Vec3::splat(f32::NEG_INFINITY);
            for v in vs {
                mn = mn.min(Vec3::from(v.pos));
                mx = mx.max(Vec3::from(v.pos));
            }
            let c = (mn + mx) * 0.5;
            let r = (mx - mn).length() * 0.5;
            let idx = &scene.indices[p.index_offset as usize..(p.index_offset + p.index_count) as usize];
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
        }
        let light_count = lights.len() as u32;
        if lights.is_empty() {
            lights.push([0.0; 12]); // keep the binding valid
        }
        let lbuf = ctx.device_local(&lights, vk::BufferUsageFlags::STORAGE_BUFFER);

        let mut texes: Vec<GpuTex> = scene.images.iter().map(|im| ctx.upload_texture(im)).collect();
        if texes.is_empty() {
            let white = gltf_scene::LoadedImage { width: 1, height: 1, pixels: vec![255, 255, 255, 255] };
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
                // camera (0x01) and shadow/bounce rays (0xFF) see it, but probe
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

        // ---- descriptor layout + pipeline ----
        let bindings = [
            dslb(0, vk::DescriptorType::ACCELERATION_STRUCTURE_KHR, 1),
            dslb(1, vk::DescriptorType::STORAGE_IMAGE, 1),
            dslb(2, vk::DescriptorType::STORAGE_BUFFER, 1),
            dslb(3, vk::DescriptorType::STORAGE_BUFFER, 1),
            dslb(4, vk::DescriptorType::STORAGE_BUFFER, 1),
            dslb(5, vk::DescriptorType::STORAGE_BUFFER, 1),
            dslb(6, vk::DescriptorType::COMBINED_IMAGE_SAMPLER, texes.len() as u32),
            dslb(7, vk::DescriptorType::STORAGE_BUFFER, 1),
            dslb(8, vk::DescriptorType::STORAGE_IMAGE, 1), // albedo G-buffer (denoise guide)
            dslb(9, vk::DescriptorType::STORAGE_IMAGE, 1), // normal G-buffer (denoise guide)
            dslb(10, vk::DescriptorType::STORAGE_IMAGE, 1), // world-position G-buffer (history reprojection)
            dslb(11, vk::DescriptorType::STORAGE_BUFFER, 1), // irradiance probe cache (shade reads, probes.comp writes)
        ];
        let set_layout = ctx.device.create_descriptor_set_layout(&vk::DescriptorSetLayoutCreateInfo::default().bindings(&bindings), None)?;
        let set_layouts = [set_layout];
        let push_range = [vk::PushConstantRange::default().stage_flags(vk::ShaderStageFlags::COMPUTE).offset(0).size(std::mem::size_of::<Push>() as u32)];
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
        const SPV: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/trace.comp.spv"));
        const SHADE_SPV: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/shade.comp.spv"));
        const PROBE_SPV: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/probes.comp.spv"));
        let (pipeline, shader) = make_pipeline(SPV)?;
        let (shade_pipeline, shade_shader) = make_pipeline(SHADE_SPV)?;
        let (probe_pipeline, probe_shader) = make_pipeline(PROBE_SPV)?;

        // ---- world-space irradiance probe grid (deterministic render mode) —
        // scene AABB + one-spacing pad, spacing widened until the count fits.
        // Header floats: origin.xyz, spacing, dims.xyz, pad.
        let spacing0: f32 = std::env::var("PROBE_SPACING").ok().and_then(|s| s.parse().ok()).unwrap_or(0.5);
        let mut spacing = spacing0.max(0.05);
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
        let mut pdata = vec![0.0f32; 16 + probe_count as usize * 20];
        pdata[0] = pmin.x;
        pdata[1] = pmin.y;
        pdata[2] = pmin.z;
        pdata[3] = spacing;
        pdata[4] = dims[0] as f32;
        pdata[5] = dims[1] as f32;
        pdata[6] = dims[2] as f32;
        let probe_buf = ctx.device_local(&pdata, vk::BufferUsageFlags::STORAGE_BUFFER);
        println!("probes: {}x{}x{} = {} @ spacing {:.2} wu ({:.1} MB)", dims[0], dims[1], dims[2], probe_count, spacing, probe_count as f32 * 80.0 / 1e6);

        let hide_masks: Vec<u8> = (0..scene.primitives.len()).map(|i| scene.prim_hide_mask.get(i).copied().unwrap_or(0)).collect();
        Ok(SceneGpu { vbuf, ibuf, gbuf, mbuf, lbuf, light_count, texes, sampler, blas_list, tlas, tlas_buf, tlas_scratch, inst_buf, n_inst, dynamic_instance, hide_masks, set_layout, pipeline_layout, pipeline, shader, shade_pipeline, shade_shader, probe_pipeline, probe_shader, probe_buf, probe_count })
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

    /// Apply the dollhouse near-wall hide for a camera at `yaw_q` quarter
    /// turns: tagged instances whose outward direction faces the camera get
    /// TLAS visibility mask 0 (rays with cull mask 0xFF skip them); everything
    /// else 0xFF. Patches the host-visible instance buffer in place — call
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
            // cross-section.
            // Hidden walls keep mask 0x02: PRIMARY rays cull with 0x01 (the
            // dollhouse see-through), but shadow/bounce rays cull with 0xFF and
            // still hit them — the room stays ENCLOSED for light transport.
            // (Mask 0 removed them from sunlight too, so sun/sky flooded in
            // through the camera-side openings and the lighting followed the
            // camera instead of the world.)
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

    pub unsafe fn destroy(self, ctx: &Ctx) {
        ctx.device.destroy_pipeline(self.pipeline, None);
        ctx.device.destroy_shader_module(self.shader, None);
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use glam::Vec2;

    #[test]
    fn post_palette_returns_palette_member_deterministically() {
        let c = post_palette([0.31, 0.29, 0.27], 5, 9);
        assert!(PALETTE32.contains(&c), "quantized colour must be a palette entry");
        assert_eq!(c, post_palette([0.31, 0.29, 0.27], 5, 9)); // same pixel -> same colour
        // a different Bayer cell may dither to a different entry, but stays in-palette
        assert!(PALETTE32.contains(&post_palette([0.31, 0.29, 0.27], 6, 9)));
    }

    #[test]
    fn post_grain_zero_strength_is_identity_and_is_per_pixel() {
        let c = [0.4, 0.5, 0.6];
        assert_eq!(post_grain(c, 3, 4, 7, 0.0), c);
        let a = post_grain(c, 3, 4, 7, 0.1);
        let b = post_grain(c, 3, 5, 7, 0.1);
        assert_eq!(a, post_grain(c, 3, 4, 7, 0.1)); // deterministic per (pixel, frame)
        assert_ne!(a, b); // varies across pixels
    }

    #[test]
    fn render_scale_is_integer_steps() {
        assert_eq!(render_scale(1.0, 4), 4); // zoom=1 -> baseline
        assert_eq!(render_scale(2.0, 4), 8);
        assert_eq!(render_scale(1.1, 4), 4); // round(4.4) -> still 4 (pixel-perfect quantization)
        assert_eq!(render_scale(1.2, 4), 5); // round(4.8) -> 5
        assert_eq!(render_scale(0.01, 4), 1); // never below 1
    }

    #[test]
    fn zoom_anchor_keeps_world_point_under_cursor() {
        // The low pixel under the cursor must not move (within rounding) when we
        // change zoom anchored at the cursor.
        let base = 4u32;
        let c = Vec2::new(900.0, 530.0); // cursor in window px
        let pan0 = Vec2::new(40.0, 24.0);
        for &(z0, z1) in &[(1.0f32, 2.0f32), (2.0, 3.5), (3.0, 1.0), (1.0, 8.0)] {
            let rs0 = render_scale(z0, base) as f32;
            let rs1 = render_scale(z1, base) as f32;
            let pan1 = zoom_anchor_pan(pan0, c, rs0, rs1);
            let before = (pan0 + c / rs0).round();
            let after = (pan1 + c / rs1).round();
            assert!((before - after).abs().max_element() <= 1.0, "anchor drifted: {before:?} vs {after:?} (z {z0}->{z1})");
        }
    }

    #[test]
    fn whole_pixel_step_carries_remainder() {
        // applied steps are integers; remainder stays small and accumulates to a step
        let (w, r) = whole_pixel_step(Vec2::new(0.3, -0.4));
        assert_eq!(w, Vec2::ZERO);
        assert!((r - Vec2::new(0.3, -0.4)).abs().max_element() < 1e-6);
        let (w, r) = whole_pixel_step(Vec2::new(2.6, -1.7));
        assert_eq!(w, Vec2::new(3.0, -2.0));
        assert!(r.abs().max_element() <= 0.5 + 1e-6);
        // feeding small deltas eventually yields a whole step
        let mut acc = Vec2::ZERO;
        let mut applied = 0.0;
        for _ in 0..10 {
            acc += Vec2::new(0.3, 0.0);
            let (w, rem) = whole_pixel_step(acc);
            applied += w.x;
            acc = rem;
        }
        assert_eq!(applied, 3.0); // 10 * 0.3 = 3.0 applied as whole steps
    }

    #[test]
    fn clamp_keeps_visible_region_in_buffer() {
        let low = Vec2::new(300.0, 200.0);
        let vis = Vec2::new(260.0, 160.0);
        assert_eq!(clamp_pan(Vec2::new(-50.0, -50.0), low, vis), Vec2::new(0.0, 0.0));
        assert_eq!(clamp_pan(Vec2::new(999.0, 999.0), low, vis), Vec2::new(40.0, 40.0));
        assert_eq!(clamp_pan(Vec2::new(20.0, 10.0), low, vis), Vec2::new(20.0, 10.0));
    }

    #[test]
    fn level_blocks_outside_floor_and_inside_solids() {
        let lvl = Level { floor: [-5.0, -5.0, 5.0, 5.0], solids: vec![[1.0, 1.0, 2.0, 2.0]] };
        assert!(!lvl.is_blocked(0.0, 0.0)); // open interior
        assert!(lvl.is_blocked(-6.0, 0.0)); // past the west wall
        assert!(lvl.is_blocked(0.0, 9.0)); // past the south wall
        assert!(lvl.is_blocked(1.5, 1.5)); // inside the prop footprint
        assert!(!lvl.is_blocked(2.5, 2.5)); // just clear of the prop
    }

    #[test]
    fn iso_input_dir_traces_the_2to1_stair() {
        assert!(iso_input_dir(0.0, 0.0).is_none());
        let up = iso_input_dir(0.0, 1.0).unwrap();
        assert!((up - Vec2::new(0.0, -1.0)).abs().max_element() < 1e-6);
        let right = iso_input_dir(1.0, 0.0).unwrap();
        assert!((right - Vec2::new(1.0, 0.0)).abs().max_element() < 1e-6);
        // up+right: the clean (2,1) screen diagonal = engine ISO_INPUT_DIAGONAL rates
        let diag = iso_input_dir(1.0, 1.0).unwrap();
        assert!((diag.x - 2.0 / 5.0_f32.sqrt()).abs() < 1e-6, "a-rate {}", diag.x);
        assert!((diag.y + 1.0 / 5.0_f32.sqrt()).abs() < 1e-6, "b-rate {}", diag.y);
        assert!((diag.length() - 1.0).abs() < 1e-6); // unit
    }

    #[test]
    fn smoothness_floor_matches_engine() {
        assert!((recommended_min_px_per_sec(60.0) - 67.082).abs() < 0.01);
    }

    #[test]
    fn pixel_basis_maps_exactly_one_screen_pixel() {
        let (_d, right, up) = iso_basis(0.0);
        let (u, v) = iso_pixel_basis(0.0);
        // u projects to exactly (1, 0) screen px, v to (0, 1) (down-positive)
        assert!((u.dot(right) * ISO_R - 1.0).abs() < 1e-4);
        assert!((-u.dot(up) * ISO_R).abs() < 1e-4);
        assert!((v.dot(right) * ISO_R).abs() < 1e-4);
        assert!((-v.dot(up) * ISO_R - 1.0).abs() < 1e-4);
        // both are ground-plane vectors
        assert_eq!(u.y, 0.0);
        assert_eq!(v.y, 0.0);
        // vertical foreshortening: one px down covers 2x the ground of one px right
        assert!((v.length() / u.length() - 2.0).abs() < 1e-4);
    }

    #[test]
    fn diagonal_input_traces_2to1_screen_stair_through_the_basis() {
        // iso_input_dir + the pixel basis must reproduce the engine's screen
        // rates: up+right = (2/sqrt5 right, 1/sqrt5 up) px per unit time.
        let dir = iso_input_dir(1.0, 1.0).unwrap();
        let w = screen_px_to_world(dir, 0.0);
        let (_d, right, up) = iso_basis(0.0);
        let sx = w.dot(right) * ISO_R;
        let sy = -w.dot(up) * ISO_R; // screen down
        assert!((sx - 2.0 / 5.0_f32.sqrt()).abs() < 1e-4, "a-rate {sx}");
        assert!((sy + 1.0 / 5.0_f32.sqrt()).abs() < 1e-4, "b-rate {sy}");
        assert!((sx / -sy - 2.0).abs() < 1e-3); // the 2:1 stair
    }

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
            assert_eq!(bits & 0b0101 != 0, true); // exactly one X bit
            assert_eq!((bits & 1 != 0), yaw.sin() > 0.0);
            assert_eq!((bits & 2 != 0), yaw.cos() > 0.0);
        }
    }

    #[test]
    fn pixel_basis_holds_at_every_quarter_turn() {
        for q in 0..4 {
            let yaw_off = 90.0 * q as f32;
            let (_d, right, up) = iso_basis(yaw_off);
            let (u, v) = iso_pixel_basis(yaw_off);
            assert!((u.dot(right) * ISO_R - 1.0).abs() < 1e-4, "q{q}");
            assert!((-v.dot(up) * ISO_R - 1.0).abs() < 1e-4, "q{q}");
            assert!((v.dot(right) * ISO_R).abs() < 1e-4, "q{q}");
            assert!((-u.dot(up) * ISO_R).abs() < 1e-4, "q{q}");
        }
    }

    #[test]
    fn snap_ground_lands_on_integer_lattice() {
        let (_d, right, up) = iso_basis(0.0);
        let p = Vec3::new(1.234, 0.0, -3.456);
        let s = snap_ground_to_lattice(p, 0.0);
        let a = s.dot(right) * ISO_R;
        let b = -s.dot(up) * ISO_R;
        assert!((a - a.round()).abs() < 1e-3, "a {a}");
        assert!((b - b.round()).abs() < 1e-3, "b {b}");
        assert_eq!(s.y, 0.0); // stays on the ground plane
        // idempotent + never moves more than ~a pixel cell
        assert!((snap_ground_to_lattice(s, 0.0) - s).length() < 1e-4);
        assert!((s - p).length() < 3.0 / ISO_R);
    }
}
