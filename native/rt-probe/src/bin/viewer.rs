//! Interactive ISO_VIEW_CONTRACT viewer — a winit window over the hardware-RT
//! path tracer. The scene path-traces progressively into an HDR accumulation
//! buffer (grain → clean as samples build), a tonemap compute resolves it with
//! the pixel-perfect integer-NEAREST upscale, and the result is blitted to the
//! swapchain.
//!
//! Controls: WASD / arrows = walk the player (held = continuous, camera
//! follows); drag = nudge the player; scroll / +- = zoom; 0 = reset; j = toggle
//! OIDN denoise; Esc = quit.
//!
//! SCENE=grid — the native rematch of the web `experiments/grid-walker`
//! GameModule: 20×20 tile floor + grid lines + a 1-wu orange box, FIXED camera
//! (the box moves across the screen), speed 80 px/s (the web knob default),
//! open level (nothing blocks). Movement semantics mirror @common/gameplay
//! exactly: iso 2:1 input mapping, smoothness-floor clamp, continuous ECS
//! transform with the rendered mesh snapped to the screen-pixel lattice.
//!
//! Game runtime (mirrors @common/gameplay): held keys feed the iso 2:1 input
//! mapping (`iso_input_dir`), the player walks at a smoothness-floored speed and
//! is blocked by the `Level` (floor rect + prop footprints, `is_blocked`),
//! sliding along walls. The player is a dynamic TLAS instance; moving re-renders
//! (TLAS rebuild ~0.05ms), so the path-traced grain returns while walking and
//! resolves when still; the camera target snaps to the pixel lattice so the
//! world stays crisp. Zoom is an integer render-scale (#4) display-crop,
//! cursor-anchored (#6), no re-render; fixed low-res target (#2) + overscan
//! margin + guard band (#7). The pan/zoom/input/collision math is in `lib.rs`
//! (unit-tested).
//!
//! Denoise dial (j / DENOISE=1): Intel OIDN over the HDR accumulator into the
//! `denoised` image which the tonemap resolves. Three paths, best-first:
//!   1. ASYNC interop (`oidn::AsyncInteropDenoiser` + `cuda::CudaSync`): OIDN
//!      runs on a CUDA stream synced to Vulkan with two external semaphores —
//!      copy-in signals semA, CUDA waits it / denoises / signals semB, the
//!      present cmd waits semB. NO CPU-blocking sync (~6ms vs ~12ms CPU/frame).
//!   2. SYNC interop (`oidn::InteropDenoiser`): zero-copy shared VRAM, but two
//!      blocking submits + `oidnSyncDevice` (used if async init fails).
//!   3. host-copy OIDN (CUDA or CPU) if no external-memory interop at all.
//! NO_ASYNC=1 forces path 2 (benchmark A/B); FRAMES=N logs avg CPU frame time.

use ash::vk;
use glam::{Mat4, Vec2, Vec3};
use raw_window_handle::{HasDisplayHandle, HasWindowHandle};
use rt_probe::*;
use std::ffi::{c_char, CStr, CString};
use std::sync::Arc;
use winit::application::ApplicationHandler;
use winit::event::{ElementState, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, EventLoop};
use winit::keyboard::{Key, NamedKey};
use winit::window::{Window, WindowId};

const MAX_SAMPLES: i32 = 4096; // stop dispatching once converged (idle = no GPU burn)
const MARGIN: u32 = 32; // low-res overscan border so pan/zoom never reveal edge bars
const ZOOM_MIN: f32 = 1.0;
const ZOOM_MAX: f32 = 8.0;

#[repr(C)]
#[derive(Clone, Copy)]
struct TonePush {
    dims: [i32; 4], // low_w, low_h, out_w, out_h
    cfg: [i32; 4],  // scale, samples, pan_x, pan_y
    fcfg: [f32; 4], // exposure, _, _, _
}

/// Window-size-dependent resources, recreated on resize.
struct Swap {
    swapchain: vk::SwapchainKHR,
    extent: vk::Extent2D,
    images: Vec<vk::Image>,
    low_w: u32,
    low_h: u32,
    accum: (vk::Image, vk::DeviceMemory, vk::ImageView),
    out: (vk::Image, vk::DeviceMemory, vk::ImageView),
    denoised: (vk::Image, vk::DeviceMemory, vk::ImageView), // OIDN result (HDR mean), tonemapped when the dial is on
    trace_pool: vk::DescriptorPool,
    trace_set: vk::DescriptorSet,
    tone_pool: vk::DescriptorPool,
    tone_set: vk::DescriptorSet,    // tonemap reads accum
    tone_set_dn: vk::DescriptorSet, // tonemap reads denoised
    // one render-finished semaphore per swapchain image (avoids reuse hazard)
    render_finished: Vec<vk::Semaphore>,
}

#[allow(dead_code)]
struct Renderer {
    _entry: ash::Entry,
    instance: ash::Instance,
    surface_loader: ash::khr::surface::Instance,
    surface: vk::SurfaceKHR,
    pdev: vk::PhysicalDevice,
    qf: u32,
    ctx: Ctx,
    swapchain_loader: ash::khr::swapchain::Device,
    surface_format: vk::SurfaceFormatKHR,
    present_mode: vk::PresentModeKHR,
    gpu: SceneGpu,
    scene: gltf_scene::Scene,
    tone_set_layout: vk::DescriptorSetLayout,
    tone_pipeline_layout: vk::PipelineLayout,
    tone_pipeline: vk::Pipeline,
    tone_shader: vk::ShaderModule,
    cmd: vk::CommandBuffer,
    image_available: vk::Semaphore,
    in_flight: vk::Fence,
    swap: Option<Swap>,
    // view / accumulation state
    base_scale: u32, // integer render scale at zoom=1 (the DPR baseline, #2/#4)
    exposure: f32,
    debug: i32,
    aa: i32, // AA=1: jitter primary rays (soft edges); default 0 = crisp pixel look
    samples: i32,
    frame: u32,
    // pixel-perfect interactive view (#5 pan, #6 zoom-anchor, #7 guard band).
    // pan is a float low-pixel crop offset; the GPU gets round(pan) and the
    // remainder is carried frame-to-frame so motion stays on the pixel lattice.
    zoom: f32,
    pan: Vec2,
    cursor: Vec2, // window-space cursor (physical px)
    dragging: bool,
    // camera-follow motion: panning moves the world look-at target (re-renders,
    // so the path-traced grain returns while moving and resolves when still).
    target: Vec3,
    move_accum: Vec2, // sub-low-pixel remainder carried between moves (#5)
    reset_accum: bool,
    // player (a dynamic TLAS instance): WASD moves it on the floor, camera follows
    player_pos: Vec3,
    player_dirty: bool,
    // continuous held-key movement + collision (the native game runtime mirror
    // of @common/gameplay): held = [up, down, left, right]; the player walks at
    // `player_speed` px/s (floored to the iso smoothness minimum) and is blocked
    // by `level`. `last_frame` clocks dt for velocity integration.
    held: [bool; 4],
    player_speed: f32,
    level: Level,
    // grid-walker rematch (SCENE=grid): the web experiment has a FIXED camera —
    // the box moves across the screen. Room scene keeps camera-follow.
    follow_cam: bool,
    last_frame: Option<std::time::Instant>,
    // headless-capture mode: dump `out` to PNG at `shot_spp` samples, then exit
    shot: Option<String>,
    shot_spp: i32,
    // headless walk test: hold up+right for WALK seconds from launch, then
    // release — drives the real held-key/update_motion path without a keyboard.
    walk: Option<f32>,
    start_time: std::time::Instant,
    denoise: bool,      // headless DENOISE capture
    denoise_live: bool, // interactive denoise dial ('j')
    denoiser: Option<oidn::Denoiser>, // persistent host-copy OIDN (fallback)
    // zero-copy interop: a Vulkan-exported buffer aliased by OIDN (no host readback)
    interop: Option<oidn::InteropDenoiser>,
    shared_buf: Option<Buffer>,
    interop_dims: (u32, u32),
    interop_failed: bool,
    // fully-async interop: OIDN on a CUDA stream synced to Vulkan via two
    // external semaphores — no CPU-blocking round-trips (the preferred path).
    ext_sem_fd: ash::khr::external_semaphore_fd::Device,
    async_interop: Option<oidn::AsyncInteropDenoiser>,
    cuda: Option<cuda::CudaSync>,
    sem_copy_done: vk::Semaphore,    // Vulkan signals (copy-in done) -> CUDA waits
    sem_denoise_done: vk::Semaphore, // CUDA signals (denoise done) -> Vulkan waits
    copy_cmd: vk::CommandBuffer,     // dedicated buffer for the async copy-in submit
    async_failed: bool,
    // benchmark: FRAMES=N -> log avg frame time and exit after N rendered frames
    frames_limit: Option<u32>,
    frame_time_sum: f32,
    exit_requested: bool,
}

impl Renderer {
    unsafe fn new(window: &Window) -> Result<Renderer, Box<dyn std::error::Error>> {
        let entry = ash::Entry::load()?;
        let validation = CString::new("VK_LAYER_KHRONOS_validation").unwrap();
        let have_val = entry.enumerate_instance_layer_properties()?.iter().any(|l| (CStr::from_ptr(l.layer_name.as_ptr())) == validation.as_c_str());

        let display_handle = window.display_handle()?.as_raw();
        let window_handle = window.window_handle()?.as_raw();
        let mut iexts: Vec<*const c_char> = ash_window::enumerate_required_extensions(display_handle)?.to_vec();
        let mut layers: Vec<*const c_char> = Vec::new();
        if have_val {
            layers.push(validation.as_ptr());
            iexts.push(ash::ext::debug_utils::NAME.as_ptr());
        }
        let app = vk::ApplicationInfo::default().api_version(vk::API_VERSION_1_3);
        let instance = entry.create_instance(&vk::InstanceCreateInfo::default().application_info(&app).enabled_layer_names(&layers).enabled_extension_names(&iexts), None)?;

        let surface = ash_window::create_surface(&entry, &instance, display_handle, window_handle, None)?;
        let surface_loader = ash::khr::surface::Instance::new(&entry, &instance);

        // physical device: RT + swapchain + present support on our surface
        let req_exts = [
            ash::khr::acceleration_structure::NAME,
            ash::khr::ray_query::NAME,
            ash::khr::deferred_host_operations::NAME,
            ash::khr::swapchain::NAME,
            ash::khr::external_memory_fd::NAME,    // zero-copy OIDN interop
            ash::khr::external_semaphore_fd::NAME, // async OIDN/CUDA sync
        ];
        let (pdev, qf) = instance
            .enumerate_physical_devices()?
            .iter()
            .find_map(|&pd| {
                let exts = instance.enumerate_device_extension_properties(pd).ok()?;
                if !req_exts.iter().all(|r| exts.iter().any(|e| (CStr::from_ptr(e.extension_name.as_ptr())) == *r)) {
                    return None;
                }
                let qfp = instance.get_physical_device_queue_family_properties(pd);
                let q = (0..qfp.len() as u32).find(|&i| {
                    qfp[i as usize].queue_flags.contains(vk::QueueFlags::COMPUTE)
                        && surface_loader.get_physical_device_surface_support(pd, i, surface).unwrap_or(false)
                })?;
                Some((pd, q))
            })
            .ok_or("no RT+present device")?;
        let props = instance.get_physical_device_properties(pdev);
        let mem_props = instance.get_physical_device_memory_properties(pdev);

        let qpri = [1.0f32];
        let qci = [vk::DeviceQueueCreateInfo::default().queue_family_index(qf).queue_priorities(&qpri)];
        let ext_ptrs: Vec<*const c_char> = req_exts.iter().map(|c| c.as_ptr()).collect();
        let mut vk12 = vk::PhysicalDeviceVulkan12Features::default()
            .buffer_device_address(true)
            .scalar_block_layout(true)
            .descriptor_indexing(true)
            .runtime_descriptor_array(true)
            .shader_sampled_image_array_non_uniform_indexing(true);
        let mut accel = vk::PhysicalDeviceAccelerationStructureFeaturesKHR::default().acceleration_structure(true);
        let mut rq = vk::PhysicalDeviceRayQueryFeaturesKHR::default().ray_query(true);
        let mut f2 = vk::PhysicalDeviceFeatures2::default().push_next(&mut vk12).push_next(&mut accel).push_next(&mut rq);
        let device = instance.create_device(pdev, &vk::DeviceCreateInfo::default().queue_create_infos(&qci).enabled_extension_names(&ext_ptrs).push_next(&mut f2), None)?;
        let queue = device.get_device_queue(qf, 0);
        let as_dev = ash::khr::acceleration_structure::Device::new(&instance, &device);
        let pool = device.create_command_pool(&vk::CommandPoolCreateInfo::default().queue_family_index(qf).flags(vk::CommandPoolCreateFlags::RESET_COMMAND_BUFFER), None)?;
        let swapchain_loader = ash::khr::swapchain::Device::new(&instance, &device);
        let ext_mem_fd = ash::khr::external_memory_fd::Device::new(&instance, &device);
        let ctx = Ctx { device, as_dev, queue, pool, mem_props, timestamp_period: props.limits.timestamp_period, ext_mem_fd: Some(ext_mem_fd) };
        println!("device: {}", CStr::from_ptr(props.device_name.as_ptr()).to_string_lossy());

        // surface format + present mode (FIFO = vsync, always available)
        let formats = surface_loader.get_physical_device_surface_formats(pdev, surface)?;
        let surface_format = formats
            .iter()
            .copied()
            .find(|f| f.format == vk::Format::B8G8R8A8_UNORM && f.color_space == vk::ColorSpaceKHR::SRGB_NONLINEAR)
            .unwrap_or(formats[0]);
        let modes = surface_loader.get_physical_device_surface_present_modes(pdev, surface)?;
        let present_mode = if modes.contains(&vk::PresentModeKHR::MAILBOX) { vk::PresentModeKHR::MAILBOX } else { vk::PresentModeKHR::FIFO };

        // scene + acceleration structures + trace pipeline
        let scene = build_scene()?;
        println!("scene: {} prims, {} tris, {} textures", scene.primitives.len(), scene.indices.len() / 3, scene.images.len());
        let player0 = scene.player_start;
        let level = Level::from_scene(&scene);
        println!("level: floor rect {:?}, {} solids", level.floor, level.solids.len());
        let gpu = SceneGpu::build(&ctx, &scene)?;

        // tonemap pipeline (window-independent)
        let tone_bindings = [dslb(0, vk::DescriptorType::STORAGE_IMAGE, 1), dslb(1, vk::DescriptorType::STORAGE_IMAGE, 1)];
        let tone_set_layout = ctx.device.create_descriptor_set_layout(&vk::DescriptorSetLayoutCreateInfo::default().bindings(&tone_bindings), None)?;
        let tone_sl = [tone_set_layout];
        let tone_push = [vk::PushConstantRange::default().stage_flags(vk::ShaderStageFlags::COMPUTE).offset(0).size(std::mem::size_of::<TonePush>() as u32)];
        let tone_pipeline_layout = ctx.device.create_pipeline_layout(&vk::PipelineLayoutCreateInfo::default().set_layouts(&tone_sl).push_constant_ranges(&tone_push), None)?;
        const TONE_SPV: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/tonemap.comp.spv"));
        let tone_code = ash::util::read_spv(&mut std::io::Cursor::new(&TONE_SPV[..]))?;
        let tone_shader = ctx.device.create_shader_module(&vk::ShaderModuleCreateInfo::default().code(&tone_code), None)?;
        let tone_name = CString::new("main").unwrap();
        let tone_pipeline = ctx
            .device
            .create_compute_pipelines(vk::PipelineCache::null(), &[vk::ComputePipelineCreateInfo::default().stage(vk::PipelineShaderStageCreateInfo::default().stage(vk::ShaderStageFlags::COMPUTE).module(tone_shader).name(&tone_name)).layout(tone_pipeline_layout)], None)
            .map_err(|(_, e)| e)?[0];

        let cmds = ctx.device.allocate_command_buffers(&vk::CommandBufferAllocateInfo::default().command_pool(pool).level(vk::CommandBufferLevel::PRIMARY).command_buffer_count(2))?;
        let (cmd, copy_cmd) = (cmds[0], cmds[1]);
        let image_available = ctx.device.create_semaphore(&vk::SemaphoreCreateInfo::default(), None).unwrap();
        let in_flight = ctx.device.create_fence(&vk::FenceCreateInfo::default().flags(vk::FenceCreateFlags::SIGNALED), None)?;

        // two semaphores exportable as OPAQUE_FD, for CUDA external-semaphore sync
        let ext_sem_fd = ash::khr::external_semaphore_fd::Device::new(&instance, &ctx.device);
        let make_exportable_sem = || {
            let mut ext = vk::ExportSemaphoreCreateInfo::default().handle_types(vk::ExternalSemaphoreHandleTypeFlags::OPAQUE_FD);
            ctx.device.create_semaphore(&vk::SemaphoreCreateInfo::default().push_next(&mut ext), None).unwrap()
        };
        let sem_copy_done = make_exportable_sem();
        let sem_denoise_done = make_exportable_sem();

        let base_scale: u32 = std::env::var("PIXEL").ok().and_then(|s| s.parse().ok()).unwrap_or(4).max(1);
        let exposure: f32 = std::env::var("EXPOSURE").ok().and_then(|s| s.parse().ok()).unwrap_or(0.22);
        let debug = std::env::var("DEBUG_ALBEDO").is_ok() as i32;
        let aa = std::env::var("AA").is_ok() as i32;
        // grid-walker rematch: fixed camera + the web knob's default speed (80 px/s)
        let grid_mode = std::env::var("SCENE").map(|s| s == "grid" || s == "grid-walker").unwrap_or(false);
        let default_speed = if grid_mode { 80.0 } else { 140.0 };

        let mut r = Renderer {
            _entry: entry,
            instance,
            surface_loader,
            surface,
            pdev,
            qf,
            ctx,
            swapchain_loader,
            surface_format,
            present_mode,
            gpu,
            scene,
            tone_set_layout,
            tone_pipeline_layout,
            tone_pipeline,
            tone_shader,
            cmd,
            image_available,
            in_flight,
            swap: None,
            base_scale,
            exposure,
            debug,
            aa,
            samples: 0,
            frame: 0,
            zoom: std::env::var("ZOOM").ok().and_then(|s| s.parse().ok()).unwrap_or(1.0_f32).clamp(ZOOM_MIN, ZOOM_MAX),
            pan: Vec2::ZERO,
            cursor: Vec2::ZERO,
            dragging: false,
            target: player0,
            move_accum: Vec2::ZERO,
            reset_accum: false,
            player_pos: player0,
            player_dirty: false,
            held: [false; 4],
            player_speed: std::env::var("PLAYER_SPEED").ok().and_then(|s| s.parse().ok()).unwrap_or(default_speed),
            level,
            follow_cam: !grid_mode,
            last_frame: None,
            shot: std::env::var("SHOT").ok(),
            shot_spp: std::env::var("SHOT_SPP").ok().and_then(|s| s.parse().ok()).unwrap_or(512),
            walk: std::env::var("WALK").ok().and_then(|s| s.parse().ok()),
            start_time: std::time::Instant::now(),
            denoise: std::env::var("DENOISE").is_ok(),
            denoise_live: std::env::var("DENOISE").is_ok(),
            denoiser: None,
            interop: None,
            shared_buf: None,
            interop_dims: (0, 0),
            interop_failed: false,
            ext_sem_fd,
            async_interop: None,
            cuda: None,
            sem_copy_done,
            sem_denoise_done,
            copy_cmd,
            async_failed: std::env::var("NO_ASYNC").is_ok(), // force the sync-interop path (benchmark A/B)
            frames_limit: std::env::var("FRAMES").ok().and_then(|s| s.parse().ok()),
            frame_time_sum: 0.0,
            exit_requested: false,
        };
        r.recreate_swapchain(window.inner_size().width.max(1), window.inner_size().height.max(1));
        // optional initial pan offset (low pixels), for headless capture tests
        let px: f32 = std::env::var("PAN_X").ok().and_then(|s| s.parse().ok()).unwrap_or(0.0);
        let py: f32 = std::env::var("PAN_Y").ok().and_then(|s| s.parse().ok()).unwrap_or(0.0);
        if px != 0.0 || py != 0.0 {
            r.pan_by_low(Vec2::new(px, py));
        }
        // optional player world offset (camera NOT moved) — proves the dynamic
        // TLAS rebuild displaces the marker in headless capture tests.
        let plx: f32 = std::env::var("PLAYER_X").ok().and_then(|s| s.parse().ok()).unwrap_or(0.0);
        let plz: f32 = std::env::var("PLAYER_Z").ok().and_then(|s| s.parse().ok()).unwrap_or(0.0);
        if plx != 0.0 || plz != 0.0 {
            r.player_pos += Vec3::new(plx, 0.0, plz);
            r.player_dirty = true;
        }
        Ok(r)
    }

    /// Whole-low-pixel render scale for the current zoom (#4).
    fn rs(&self) -> i32 {
        render_scale(self.zoom, self.base_scale)
    }

    /// (low buffer size, visible-region size) in low pixels, for pan clamping.
    fn low_and_vis(&self) -> (Vec2, Vec2) {
        let swap = self.swap.as_ref().unwrap();
        let rs = self.rs() as f32;
        let low = Vec2::new(swap.low_w as f32, swap.low_h as f32);
        let vis = Vec2::new((swap.extent.width as f32 / rs).ceil(), (swap.extent.height as f32 / rs).ceil());
        (low, vis)
    }

    fn clamp_pan_to_buffer(&mut self) {
        if self.swap.is_some() {
            let (low, vis) = self.low_and_vis();
            self.pan = clamp_pan(self.pan, low, vis);
        }
    }

    /// Zoom by `factor` keeping the world point under window-pixel `c` fixed (#6).
    fn zoom_at(&mut self, factor: f32, c: Vec2) {
        let rs0 = self.rs() as f32;
        self.zoom = (self.zoom * factor).clamp(ZOOM_MIN, ZOOM_MAX);
        let rs1 = self.rs() as f32;
        if rs1 != rs0 {
            self.pan = zoom_anchor_pan(self.pan, c, rs0, rs1);
        }
        self.clamp_pan_to_buffer();
    }

    fn reset_render(&mut self) {
        self.samples = 0;
        self.reset_accum = true;
    }

    /// Ensure the zero-copy interop denoiser (Vulkan-exported buffer aliased by
    /// OIDN/CUDA) exists for the current low-res size. Falls back to the host
    /// denoiser (`ensure_denoiser`) if interop can't be set up (no CUDA / import
    /// failure). Lazy: built on first use, rebuilt on resize.
    unsafe fn ensure_interop(&mut self, lw: u32, lh: u32) {
        if self.interop.is_some() && self.interop_dims == (lw, lh) {
            return;
        }
        // tear down stale interop resources
        self.interop = None;
        if let Some(b) = self.shared_buf.take() {
            self.ctx.destroy_buffer(&b);
        }
        if self.interop_failed {
            self.ensure_denoiser(lw as usize, lh as usize);
            return;
        }
        let (buf, size) = self.ctx.create_exportable_buffer((lw * lh * 16) as u64, vk::BufferUsageFlags::TRANSFER_SRC | vk::BufferUsageFlags::TRANSFER_DST);
        match self.ctx.export_memory_fd(&buf) {
            Ok(fd) => match oidn::InteropDenoiser::from_fd(fd, size as usize, lw as usize, lh as usize) {
                Ok(it) => {
                    println!("interop denoiser ready: zero-copy OIDN CUDA, {lw}x{lh} (no host readback)");
                    self.interop = Some(it);
                    self.shared_buf = Some(buf);
                    self.interop_dims = (lw, lh);
                    return;
                }
                Err(e) => {
                    eprintln!("interop denoiser unavailable ({e}); falling back to host-copy OIDN");
                    self.ctx.destroy_buffer(&buf);
                }
            },
            Err(e) => {
                eprintln!("memory fd export failed ({e:?}); falling back to host-copy OIDN");
                self.ctx.destroy_buffer(&buf);
            }
        }
        self.interop_failed = true;
        self.ensure_denoiser(lw as usize, lh as usize);
    }

    /// Host-copy OIDN fallback (used when interop is unavailable).
    fn ensure_denoiser(&mut self, lw: usize, lh: usize) {
        if self.denoiser.as_ref().map(|d| d.matches(lw, lh)) != Some(true) {
            match oidn::Denoiser::new(lw, lh) {
                Ok(d) => {
                    println!("denoiser ready: host-copy OIDN {} device, {lw}x{lh}", d.device_name());
                    self.denoiser = Some(d);
                }
                Err(e) => eprintln!("denoiser init failed: {e}"),
            }
        }
    }

    /// Zero-copy denoise: copy the summed accumulator into the shared buffer
    /// (GPU), OIDN-denoise it in place (no host transfer), copy the result into
    /// the `denoised` image (GPU). The tonemap then divides by the sample count.
    unsafe fn denoise_interop_inplace(&self) {
        let swap = self.swap.as_ref().unwrap();
        let shared = self.shared_buf.as_ref().unwrap();
        let (lw, lh) = (swap.low_w, swap.low_h);
        let region = vk::BufferImageCopy::default().image_subresource(vk::ImageSubresourceLayers { aspect_mask: vk::ImageAspectFlags::COLOR, mip_level: 0, base_array_layer: 0, layer_count: 1 }).image_extent(vk::Extent3D { width: lw, height: lh, depth: 1 });
        // accum image (sum) -> shared buffer
        self.ctx.one_time(|cmd| {
            barrier(&self.ctx.device, cmd, swap.accum.0, vk::ImageLayout::GENERAL, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, vk::AccessFlags::SHADER_WRITE, vk::AccessFlags::TRANSFER_READ, vk::PipelineStageFlags::COMPUTE_SHADER, vk::PipelineStageFlags::TRANSFER);
            self.ctx.device.cmd_copy_image_to_buffer(cmd, swap.accum.0, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, shared.buffer, &[region]);
            barrier(&self.ctx.device, cmd, swap.accum.0, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, vk::ImageLayout::GENERAL, vk::AccessFlags::TRANSFER_READ, vk::AccessFlags::SHADER_WRITE, vk::PipelineStageFlags::TRANSFER, vk::PipelineStageFlags::COMPUTE_SHADER);
        });
        // OIDN in place on the shared VRAM (Vulkan idle above; sync inside)
        if let Some(it) = self.interop.as_ref() {
            if let Err(e) = it.denoise() {
                eprintln!("interop denoise: {e}");
            }
        }
        // shared buffer -> denoised image
        self.ctx.one_time(|cmd| {
            barrier(&self.ctx.device, cmd, swap.denoised.0, vk::ImageLayout::GENERAL, vk::ImageLayout::TRANSFER_DST_OPTIMAL, vk::AccessFlags::SHADER_READ, vk::AccessFlags::TRANSFER_WRITE, vk::PipelineStageFlags::COMPUTE_SHADER, vk::PipelineStageFlags::TRANSFER);
            self.ctx.device.cmd_copy_buffer_to_image(cmd, shared.buffer, swap.denoised.0, vk::ImageLayout::TRANSFER_DST_OPTIMAL, &[region]);
            barrier(&self.ctx.device, cmd, swap.denoised.0, vk::ImageLayout::TRANSFER_DST_OPTIMAL, vk::ImageLayout::GENERAL, vk::AccessFlags::TRANSFER_WRITE, vk::AccessFlags::SHADER_READ, vk::PipelineStageFlags::TRANSFER, vk::PipelineStageFlags::COMPUTE_SHADER);
        });
    }

    /// Build the CUDA context + stream + imported Vulkan semaphores (once,
    /// size-independent). Exports a fresh OPAQUE_FD for each semaphore and hands
    /// ownership to CUDA.
    unsafe fn ensure_cuda(&mut self) -> Result<(), String> {
        if self.cuda.is_some() {
            return Ok(());
        }
        let fd_copy = self.export_sem_fd(self.sem_copy_done)?;
        let fd_denoise = self.export_sem_fd(self.sem_denoise_done)?;
        self.cuda = Some(cuda::CudaSync::new(fd_copy, fd_denoise)?);
        Ok(())
    }

    unsafe fn export_sem_fd(&self, sem: vk::Semaphore) -> Result<i32, String> {
        self.ext_sem_fd
            .get_semaphore_fd(&vk::SemaphoreGetFdInfoKHR::default().semaphore(sem).handle_type(vk::ExternalSemaphoreHandleTypeFlags::OPAQUE_FD))
            .map_err(|e| format!("vkGetSemaphoreFdKHR: {e:?}"))
    }

    /// Ensure the fully-async denoiser (OIDN on a CUDA stream, external-semaphore
    /// synced) for the current low-res size. Falls back to the sync interop /
    /// host denoiser (`ensure_interop`) if any async init step fails — so the
    /// renderer never breaks, it just loses the smoothness win.
    unsafe fn ensure_denoise(&mut self, lw: u32, lh: u32) {
        if self.async_failed {
            self.ensure_interop(lw, lh);
            return;
        }
        if self.async_interop.is_some() && self.interop_dims == (lw, lh) {
            return;
        }
        self.async_interop = None;
        if let Some(b) = self.shared_buf.take() {
            self.ctx.destroy_buffer(&b);
        }
        let r: Result<(), String> = (|s: &mut Self| {
            s.ensure_cuda()?;
            let stream = s.cuda.as_ref().unwrap().stream;
            let (buf, size) = s.ctx.create_exportable_buffer((lw * lh * 16) as u64, vk::BufferUsageFlags::TRANSFER_SRC | vk::BufferUsageFlags::TRANSFER_DST);
            let fd = s.ctx.export_memory_fd(&buf).map_err(|e| format!("export_memory_fd: {e:?}"))?;
            match oidn::AsyncInteropDenoiser::from_fd_and_stream(fd, size as usize, lw as usize, lh as usize, stream) {
                Ok(it) => {
                    s.async_interop = Some(it);
                    s.shared_buf = Some(buf);
                    s.interop_dims = (lw, lh);
                    Ok(())
                }
                Err(e) => {
                    s.ctx.destroy_buffer(&buf);
                    Err(e)
                }
            }
        })(self);
        match r {
            Ok(()) => println!("async denoiser ready: OIDN on CUDA stream + external-semaphore sync, {lw}x{lh} (no CPU sync)"),
            Err(e) => {
                eprintln!("async interop unavailable ({e}); falling back to sync interop / host OIDN");
                self.async_failed = true;
                self.interop_dims = (0, 0); // force sync-interop (re)build
                self.ensure_interop(lw, lh);
            }
        }
    }

    /// Submit the copy accum(sum) -> shared buffer on its own command buffer,
    /// signalling `sem_copy_done` (no fence, no wait). CUDA then waits that
    /// semaphore before denoising. Non-blocking on the CPU.
    unsafe fn submit_copy_in_async(&self) {
        let swap = self.swap.as_ref().unwrap();
        let shared = self.shared_buf.as_ref().unwrap();
        let (lw, lh) = (swap.low_w, swap.low_h);
        let region = vk::BufferImageCopy::default().image_subresource(vk::ImageSubresourceLayers { aspect_mask: vk::ImageAspectFlags::COLOR, mip_level: 0, base_array_layer: 0, layer_count: 1 }).image_extent(vk::Extent3D { width: lw, height: lh, depth: 1 });
        let d = &self.ctx.device;
        d.reset_command_buffer(self.copy_cmd, vk::CommandBufferResetFlags::empty()).unwrap();
        d.begin_command_buffer(self.copy_cmd, &vk::CommandBufferBeginInfo::default().flags(vk::CommandBufferUsageFlags::ONE_TIME_SUBMIT)).unwrap();
        barrier(d, self.copy_cmd, swap.accum.0, vk::ImageLayout::GENERAL, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, vk::AccessFlags::SHADER_WRITE, vk::AccessFlags::TRANSFER_READ, vk::PipelineStageFlags::COMPUTE_SHADER, vk::PipelineStageFlags::TRANSFER);
        d.cmd_copy_image_to_buffer(self.copy_cmd, swap.accum.0, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, shared.buffer, &[region]);
        barrier(d, self.copy_cmd, swap.accum.0, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, vk::ImageLayout::GENERAL, vk::AccessFlags::TRANSFER_READ, vk::AccessFlags::SHADER_WRITE, vk::PipelineStageFlags::TRANSFER, vk::PipelineStageFlags::COMPUTE_SHADER);
        d.end_command_buffer(self.copy_cmd).unwrap();
        let cmds = [self.copy_cmd];
        let sig = [self.sem_copy_done];
        d.queue_submit(self.ctx.queue, &[vk::SubmitInfo::default().command_buffers(&cmds).signal_semaphores(&sig)], vk::Fence::null()).unwrap();
    }

    /// Record the copy shared buffer -> `denoised` image into `cmd` (the present
    /// command buffer). Run after the present submit waits `sem_denoise_done`,
    /// so CUDA's denoise result is visible.
    unsafe fn record_copy_out(&self, cmd: vk::CommandBuffer) {
        let swap = self.swap.as_ref().unwrap();
        let shared = self.shared_buf.as_ref().unwrap();
        let (lw, lh) = (swap.low_w, swap.low_h);
        let region = vk::BufferImageCopy::default().image_subresource(vk::ImageSubresourceLayers { aspect_mask: vk::ImageAspectFlags::COLOR, mip_level: 0, base_array_layer: 0, layer_count: 1 }).image_extent(vk::Extent3D { width: lw, height: lh, depth: 1 });
        let d = &self.ctx.device;
        barrier(d, cmd, swap.denoised.0, vk::ImageLayout::GENERAL, vk::ImageLayout::TRANSFER_DST_OPTIMAL, vk::AccessFlags::SHADER_READ, vk::AccessFlags::TRANSFER_WRITE, vk::PipelineStageFlags::COMPUTE_SHADER, vk::PipelineStageFlags::TRANSFER);
        d.cmd_copy_buffer_to_image(cmd, shared.buffer, swap.denoised.0, vk::ImageLayout::TRANSFER_DST_OPTIMAL, &[region]);
        barrier(d, cmd, swap.denoised.0, vk::ImageLayout::TRANSFER_DST_OPTIMAL, vk::ImageLayout::GENERAL, vk::AccessFlags::TRANSFER_WRITE, vk::AccessFlags::SHADER_READ, vk::PipelineStageFlags::TRANSFER, vk::PipelineStageFlags::COMPUTE_SHADER);
    }

    /// Shift the (zoom) display crop by low pixels — used only by headless
    /// PAN_X/PAN_Y capture; interactive pan moves the camera instead.
    fn pan_by_low(&mut self, d: Vec2) {
        self.pan += d;
        self.clamp_pan_to_buffer();
    }

    /// Snap the camera target so the rendered world lands on the low-pixel
    /// lattice (shift by the sub-pixel projection remainder along right/up) —
    /// keeps the scene crisp regardless of the player's continuous position.
    fn snap_target_to_lattice(&mut self) {
        let (_d, right, up) = iso_basis(0.0);
        let px = self.target.dot(right) * ISO_R;
        let py = self.target.dot(up) * ISO_R;
        self.target += right * ((px.round() - px) / ISO_R) + up * ((py.round() - py) / ISO_R);
    }

    /// Move the player on the floor by a screen-space delta in low pixels,
    /// quantised to whole low pixels with the remainder carried (#5).
    fn move_player(&mut self, d_low: Vec2) {
        self.move_accum += d_low;
        let (whole, rem) = whole_pixel_step(self.move_accum);
        self.move_accum = rem;
        if whole != Vec2::ZERO {
            let world = screen_px_to_world(whole);
            let (nx, nz) = (self.player_pos.x + world.x, self.player_pos.z + world.z);
            self.commit_player(nx, nz);
        }
    }

    /// Apply a new continuous player position — the web engine's contract:
    /// the ECS transform stays continuous, but the RENDERED mesh is snapped to
    /// the screen-pixel lattice on every setPosition (`snapWorldPointOnGround`,
    /// nearest, uniform (1,1) granularity). So the TLAS transform + the costly
    /// accumulation reset only happen when the snapped point crosses a pixel
    /// cell. In follow mode (room scene) the camera target tracks the player.
    fn commit_player(&mut self, nx: f32, nz: f32) {
        let old_snap = snap_ground_to_lattice(self.player_pos);
        self.player_pos.x = nx;
        self.player_pos.z = nz;
        let new_snap = snap_ground_to_lattice(self.player_pos);
        if self.follow_cam {
            self.target = self.player_pos;
            self.snap_target_to_lattice();
            self.recenter_pan();
        }
        if new_snap != old_snap {
            self.player_dirty = true;
            self.reset_render();
        }
    }

    /// Continuous held-key movement (the native @common/gameplay loop): map the
    /// held inputs through the iso 2:1 direction, integrate at `player_speed`
    /// (floored to the smoothness minimum) over `dt` on the screen-pixel basis
    /// (`screen_px_to_world` — 1 px right = 1/R wu, 1 px down = 2/R wu), then
    /// collide against the level. Blocked moves slide along the unobstructed
    /// axis. Moving re-renders (grain) once the snapped position changes.
    fn update_motion(&mut self, dt: f32) {
        let input_x = (self.held[3] as i32 - self.held[2] as i32) as f32; // right - left
        let input_y = (self.held[0] as i32 - self.held[1] as i32) as f32; // up - down
        let Some(dir) = iso_input_dir(input_x, input_y) else { return };
        let speed = self.player_speed.max(recommended_min_px_per_sec(60.0));
        let dpx = dir * speed * dt; // screen pixels this frame (right, down)
        let world = screen_px_to_world(dpx);

        let (ox, oz) = (self.player_pos.x, self.player_pos.z);
        let (nx, nz) = (ox + world.x, oz + world.z);
        let (mut px, mut pz) = (ox, oz);
        if !self.level.is_blocked(nx, nz) {
            px = nx;
            pz = nz;
        } else {
            // slide: keep whichever axis is clear (nicer than a hard wall stop)
            if world.x != 0.0 && !self.level.is_blocked(nx, oz) {
                px = nx;
            }
            if world.z != 0.0 && !self.level.is_blocked(px, nz) {
                pz = nz;
            }
        }
        if px != ox || pz != oz {
            self.commit_player(px, pz);
        }
    }

    /// Dump the `out` image (the exact thing blitted to the swapchain) to a PNG.
    unsafe fn capture(&self, path: &str) {
        let swap = self.swap.as_ref().unwrap();
        let (w, h) = (swap.extent.width, swap.extent.height);
        let n = (w * h) as usize;
        let readback = self.ctx.create_buffer((n * 4) as u64, vk::BufferUsageFlags::TRANSFER_DST, vk::MemoryPropertyFlags::HOST_VISIBLE | vk::MemoryPropertyFlags::HOST_COHERENT);
        self.ctx.one_time(|cmd| {
            barrier(&self.ctx.device, cmd, swap.out.0, vk::ImageLayout::GENERAL, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, vk::AccessFlags::SHADER_WRITE, vk::AccessFlags::TRANSFER_READ, vk::PipelineStageFlags::COMPUTE_SHADER, vk::PipelineStageFlags::TRANSFER);
            let region = vk::BufferImageCopy::default().image_subresource(vk::ImageSubresourceLayers { aspect_mask: vk::ImageAspectFlags::COLOR, mip_level: 0, base_array_layer: 0, layer_count: 1 }).image_extent(vk::Extent3D { width: w, height: h, depth: 1 });
            self.ctx.device.cmd_copy_image_to_buffer(cmd, swap.out.0, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, readback.buffer, &[region]);
            barrier(&self.ctx.device, cmd, swap.out.0, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, vk::ImageLayout::GENERAL, vk::AccessFlags::TRANSFER_READ, vk::AccessFlags::SHADER_WRITE, vk::PipelineStageFlags::TRANSFER, vk::PipelineStageFlags::COMPUTE_SHADER);
        });
        let ptr = self.ctx.device.map_memory(readback.memory, 0, (n * 4) as u64, vk::MemoryMapFlags::empty()).unwrap() as *const u8;
        let pixels = std::slice::from_raw_parts(ptr, n * 4).to_vec();
        self.ctx.device.unmap_memory(readback.memory);
        self.ctx.destroy_buffer(&readback);
        let f = std::fs::File::create(path).unwrap();
        let mut enc = png::Encoder::new(std::io::BufWriter::new(f), w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.write_header().unwrap().write_image_data(&pixels).unwrap();
        println!("captured {path} ({w}x{h}, {} spp)", self.samples);
    }

    /// Read back the low-res HDR accumulation buffer, OIDN-denoise it, then CPU
    /// tonemap + integer-NEAREST upscale (by base_scale) to a PNG. This is the
    /// denoise dial proving low-spp frames can be cleaned (the grainy per-move
    /// frame, made clean).
    /// Record (clear +) one trace dispatch into the accumulator via a blocking
    /// submit. Used by the denoise dial so the accumulator is ready to read back
    /// before the present command is built.
    unsafe fn trace_one_time(&self, do_clear: bool, dispatch: bool, rebuild_tlas: bool, cam: &Push) {
        let swap = self.swap.as_ref().unwrap();
        let (lw, lh) = (swap.low_w, swap.low_h);
        self.ctx.one_time(|cmd| {
            let d = &self.ctx.device;
            if rebuild_tlas {
                self.gpu.record_tlas_rebuild(&self.ctx, cmd);
            }
            if do_clear {
                let range = vk::ImageSubresourceRange { aspect_mask: vk::ImageAspectFlags::COLOR, base_mip_level: 0, level_count: 1, base_array_layer: 0, layer_count: 1 };
                d.cmd_clear_color_image(cmd, swap.accum.0, vk::ImageLayout::GENERAL, &vk::ClearColorValue { float32: [0.0; 4] }, &[range]);
                d.cmd_pipeline_barrier(cmd, vk::PipelineStageFlags::TRANSFER, vk::PipelineStageFlags::COMPUTE_SHADER, vk::DependencyFlags::empty(), &[vk::MemoryBarrier::default().src_access_mask(vk::AccessFlags::TRANSFER_WRITE).dst_access_mask(vk::AccessFlags::SHADER_WRITE)], &[], &[]);
            }
            if dispatch {
                d.cmd_bind_pipeline(cmd, vk::PipelineBindPoint::COMPUTE, self.gpu.pipeline);
                d.cmd_bind_descriptor_sets(cmd, vk::PipelineBindPoint::COMPUTE, self.gpu.pipeline_layout, 0, &[swap.trace_set], &[]);
                let bytes = std::slice::from_raw_parts((cam as *const Push) as *const u8, std::mem::size_of::<Push>());
                d.cmd_push_constants(cmd, self.gpu.pipeline_layout, vk::ShaderStageFlags::COMPUTE, 0, bytes);
                d.cmd_dispatch(cmd, lw.div_ceil(8), lh.div_ceil(8), 1);
            }
        });
    }

    /// Read back the low-res HDR accumulator and normalise summed radiance to
    /// the per-pixel mean, packed FLOAT3 (what OIDN wants).
    unsafe fn readback_accum_mean(&self) -> Vec<f32> {
        let swap = self.swap.as_ref().unwrap();
        let (lw, lh) = (swap.low_w, swap.low_h);
        let n = (lw * lh) as usize;
        let readback = self.ctx.create_buffer((n * 16) as u64, vk::BufferUsageFlags::TRANSFER_DST, vk::MemoryPropertyFlags::HOST_VISIBLE | vk::MemoryPropertyFlags::HOST_COHERENT);
        self.ctx.one_time(|cmd| {
            barrier(&self.ctx.device, cmd, swap.accum.0, vk::ImageLayout::GENERAL, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, vk::AccessFlags::SHADER_WRITE, vk::AccessFlags::TRANSFER_READ, vk::PipelineStageFlags::COMPUTE_SHADER, vk::PipelineStageFlags::TRANSFER);
            let region = vk::BufferImageCopy::default().image_subresource(vk::ImageSubresourceLayers { aspect_mask: vk::ImageAspectFlags::COLOR, mip_level: 0, base_array_layer: 0, layer_count: 1 }).image_extent(vk::Extent3D { width: lw, height: lh, depth: 1 });
            self.ctx.device.cmd_copy_image_to_buffer(cmd, swap.accum.0, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, readback.buffer, &[region]);
            barrier(&self.ctx.device, cmd, swap.accum.0, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, vk::ImageLayout::GENERAL, vk::AccessFlags::TRANSFER_READ, vk::AccessFlags::SHADER_WRITE, vk::PipelineStageFlags::TRANSFER, vk::PipelineStageFlags::COMPUTE_SHADER);
        });
        let ptr = self.ctx.device.map_memory(readback.memory, 0, (n * 16) as u64, vk::MemoryMapFlags::empty()).unwrap() as *const f32;
        let acc = std::slice::from_raw_parts(ptr, n * 4);
        let samples = self.samples.max(SPP_PER) as f32;
        let mut color = vec![0.0f32; n * 3];
        for i in 0..n {
            for c in 0..3 {
                color[i * 3 + c] = acc[i * 4 + c] / samples;
            }
        }
        self.ctx.device.unmap_memory(readback.memory);
        self.ctx.destroy_buffer(&readback);
        color
    }

    /// Upload a packed-FLOAT3 HDR image (mean radiance) into the `denoised`
    /// rgba32f storage image so the tonemap can read it (with samples = 1).
    unsafe fn upload_denoised(&self, color: &[f32]) {
        let swap = self.swap.as_ref().unwrap();
        let (lw, lh) = (swap.low_w, swap.low_h);
        let n = (lw * lh) as usize;
        let mut rgba = vec![0.0f32; n * 4];
        for i in 0..n {
            rgba[i * 4] = color[i * 3];
            rgba[i * 4 + 1] = color[i * 3 + 1];
            rgba[i * 4 + 2] = color[i * 3 + 2];
            rgba[i * 4 + 3] = 1.0;
        }
        let staging = self.ctx.create_buffer((n * 16) as u64, vk::BufferUsageFlags::TRANSFER_SRC, vk::MemoryPropertyFlags::HOST_VISIBLE | vk::MemoryPropertyFlags::HOST_COHERENT);
        self.ctx.upload(&staging, &rgba);
        self.ctx.one_time(|cmd| {
            barrier(&self.ctx.device, cmd, swap.denoised.0, vk::ImageLayout::GENERAL, vk::ImageLayout::TRANSFER_DST_OPTIMAL, vk::AccessFlags::SHADER_READ, vk::AccessFlags::TRANSFER_WRITE, vk::PipelineStageFlags::COMPUTE_SHADER, vk::PipelineStageFlags::TRANSFER);
            let region = vk::BufferImageCopy::default().image_subresource(vk::ImageSubresourceLayers { aspect_mask: vk::ImageAspectFlags::COLOR, mip_level: 0, base_array_layer: 0, layer_count: 1 }).image_extent(vk::Extent3D { width: lw, height: lh, depth: 1 });
            self.ctx.device.cmd_copy_buffer_to_image(cmd, staging.buffer, swap.denoised.0, vk::ImageLayout::TRANSFER_DST_OPTIMAL, &[region]);
            barrier(&self.ctx.device, cmd, swap.denoised.0, vk::ImageLayout::TRANSFER_DST_OPTIMAL, vk::ImageLayout::GENERAL, vk::AccessFlags::TRANSFER_WRITE, vk::AccessFlags::SHADER_READ, vk::PipelineStageFlags::TRANSFER, vk::PipelineStageFlags::COMPUTE_SHADER);
        });
        self.ctx.destroy_buffer(&staging);
    }

    unsafe fn capture_denoised(&self, path: &str) {
        let swap = self.swap.as_ref().unwrap();
        let (lw, lh) = (swap.low_w, swap.low_h);
        let mut color = self.readback_accum_mean();

        let t = std::time::Instant::now();
        match oidn::Denoiser::new(lw as usize, lh as usize) {
            Ok(dn) => {
                if let Err(e) = dn.denoise(&mut color) {
                    eprintln!("denoise failed: {e}");
                }
            }
            Err(e) => eprintln!("denoiser init failed: {e}"),
        }
        let dms = t.elapsed().as_secs_f32() * 1000.0;

        // CPU tonemap (Reinhard+gamma) + integer NEAREST upscale by base_scale
        let scale = self.base_scale;
        let (ow, oh) = (lw * scale, lh * scale);
        let mut big = vec![0u8; (ow * oh * 4) as usize];
        for y in 0..oh {
            let sy = (y / scale) as usize;
            for x in 0..ow {
                let sx = (x / scale) as usize;
                let s = (sy * lw as usize + sx) * 3;
                let d = ((y * ow + x) * 4) as usize;
                for c in 0..3 {
                    let mut v = color[s + c] * self.exposure;
                    v = v / (v + 1.0);
                    v = v.powf(1.0 / 2.2);
                    big[d + c] = (v.clamp(0.0, 1.0) * 255.0) as u8;
                }
                big[d + 3] = 255;
            }
        }
        let f = std::fs::File::create(path).unwrap();
        let mut enc = png::Encoder::new(std::io::BufWriter::new(f), ow, oh);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.write_header().unwrap().write_image_data(&big).unwrap();
        println!("captured {path} (denoised {lw}x{lh}->x{scale}, {} spp, OIDN {dms:.1}ms)", self.samples);
    }

    /// (Re)build the swapchain and all window-size-dependent resources.
    unsafe fn recreate_swapchain(&mut self, win_w: u32, win_h: u32) {
        self.ctx.device.device_wait_idle().ok();
        if let Some(old) = self.swap.take() {
            self.destroy_swap(old);
        }

        let caps = self.surface_loader.get_physical_device_surface_capabilities(self.pdev, self.surface).unwrap();
        let extent = if caps.current_extent.width != u32::MAX {
            caps.current_extent
        } else {
            vk::Extent2D {
                width: win_w.clamp(caps.min_image_extent.width, caps.max_image_extent.width),
                height: win_h.clamp(caps.min_image_extent.height, caps.max_image_extent.height),
            }
        };
        let mut count = caps.min_image_count + 1;
        if caps.max_image_count > 0 {
            count = count.min(caps.max_image_count);
        }
        let swapchain = self
            .swapchain_loader
            .create_swapchain(
                &vk::SwapchainCreateInfoKHR::default()
                    .surface(self.surface)
                    .min_image_count(count)
                    .image_format(self.surface_format.format)
                    .image_color_space(self.surface_format.color_space)
                    .image_extent(extent)
                    .image_array_layers(1)
                    .image_usage(vk::ImageUsageFlags::TRANSFER_DST | vk::ImageUsageFlags::COLOR_ATTACHMENT)
                    .image_sharing_mode(vk::SharingMode::EXCLUSIVE)
                    .pre_transform(caps.current_transform)
                    .composite_alpha(vk::CompositeAlphaFlagsKHR::OPAQUE)
                    .present_mode(self.present_mode)
                    .clipped(true),
                None,
            )
            .unwrap();
        let images = self.swapchain_loader.get_swapchain_images(swapchain).unwrap();

        // pixel-perfect low-res buffer (#2): window / base-scale at zoom=1, plus
        // an overscan border so the pan crop never reveals edge bars (#7).
        let low_w = extent.width.div_ceil(self.base_scale).max(1) + 2 * MARGIN;
        let low_h = extent.height.div_ceil(self.base_scale).max(1) + 2 * MARGIN;

        let accum = make_storage_image(&self.ctx, low_w, low_h, vk::Format::R32G32B32A32_SFLOAT);
        let denoised = make_storage_image(&self.ctx, low_w, low_h, vk::Format::R32G32B32A32_SFLOAT);
        let out = make_storage_image(&self.ctx, extent.width, extent.height, vk::Format::R8G8B8A8_UNORM);
        // accum: UNDEFINED -> GENERAL + clear; denoised + out: UNDEFINED -> GENERAL
        let range = vk::ImageSubresourceRange { aspect_mask: vk::ImageAspectFlags::COLOR, base_mip_level: 0, level_count: 1, base_array_layer: 0, layer_count: 1 };
        self.ctx.one_time(|cmd| {
            barrier(&self.ctx.device, cmd, accum.0, vk::ImageLayout::UNDEFINED, vk::ImageLayout::GENERAL, vk::AccessFlags::empty(), vk::AccessFlags::TRANSFER_WRITE, vk::PipelineStageFlags::TOP_OF_PIPE, vk::PipelineStageFlags::TRANSFER);
            self.ctx.device.cmd_clear_color_image(cmd, accum.0, vk::ImageLayout::GENERAL, &vk::ClearColorValue { float32: [0.0; 4] }, &[range]);
            barrier(&self.ctx.device, cmd, denoised.0, vk::ImageLayout::UNDEFINED, vk::ImageLayout::GENERAL, vk::AccessFlags::empty(), vk::AccessFlags::TRANSFER_WRITE, vk::PipelineStageFlags::TOP_OF_PIPE, vk::PipelineStageFlags::TRANSFER);
            barrier(&self.ctx.device, cmd, out.0, vk::ImageLayout::UNDEFINED, vk::ImageLayout::GENERAL, vk::AccessFlags::empty(), vk::AccessFlags::SHADER_WRITE, vk::PipelineStageFlags::TOP_OF_PIPE, vk::PipelineStageFlags::COMPUTE_SHADER);
        });

        // descriptor sets
        let trace_pool = make_pool(&self.ctx, self.gpu.texes.len() as u32);
        let trace_set = make_set(&self.ctx, self.gpu.set_layout, trace_pool, self.gpu.tlas, accum.2, &self.gpu.vbuf, &self.gpu.ibuf, &self.gpu.gbuf, &self.gpu.mbuf, &self.gpu.texes, self.gpu.sampler);
        let tone_pool = {
            let sizes = [vk::DescriptorPoolSize { ty: vk::DescriptorType::STORAGE_IMAGE, descriptor_count: 4 }];
            self.ctx.device.create_descriptor_pool(&vk::DescriptorPoolCreateInfo::default().max_sets(2).pool_sizes(&sizes), None).unwrap()
        };
        let make_tone_set = |src_view: vk::ImageView| {
            let layouts = [self.tone_set_layout];
            let set = self.ctx.device.allocate_descriptor_sets(&vk::DescriptorSetAllocateInfo::default().descriptor_pool(tone_pool).set_layouts(&layouts)).unwrap()[0];
            let a = [vk::DescriptorImageInfo::default().image_view(src_view).image_layout(vk::ImageLayout::GENERAL)];
            let o = [vk::DescriptorImageInfo::default().image_view(out.2).image_layout(vk::ImageLayout::GENERAL)];
            let writes = [
                vk::WriteDescriptorSet::default().dst_set(set).dst_binding(0).descriptor_type(vk::DescriptorType::STORAGE_IMAGE).image_info(&a),
                vk::WriteDescriptorSet::default().dst_set(set).dst_binding(1).descriptor_type(vk::DescriptorType::STORAGE_IMAGE).image_info(&o),
            ];
            self.ctx.device.update_descriptor_sets(&writes, &[]);
            set
        };
        let tone_set = make_tone_set(accum.2);
        let tone_set_dn = make_tone_set(denoised.2);

        let render_finished: Vec<vk::Semaphore> = images.iter().map(|_| self.ctx.device.create_semaphore(&vk::SemaphoreCreateInfo::default(), None).unwrap()).collect();

        self.samples = 0;
        self.swap = Some(Swap { swapchain, extent, images, low_w, low_h, accum, out, denoised, trace_pool, trace_set, tone_pool, tone_set, tone_set_dn, render_finished });
        self.recenter_pan(); // start centred in the buffer
        println!("swapchain {}x{}  low-res {}x{} @ baseScale x{} (R={:.2})", extent.width, extent.height, low_w, low_h, self.base_scale, ISO_R);
    }

    /// Centre the visible crop in the low buffer.
    fn recenter_pan(&mut self) {
        if self.swap.is_some() {
            let (low, vis) = self.low_and_vis();
            self.pan = (low - vis) * 0.5;
        }
    }

    unsafe fn destroy_swap(&self, s: Swap) {
        let d = &self.ctx.device;
        for sem in &s.render_finished {
            d.destroy_semaphore(*sem, None);
        }
        d.destroy_descriptor_pool(s.trace_pool, None);
        d.destroy_descriptor_pool(s.tone_pool, None);
        for (img, mem, view) in [s.accum, s.denoised, s.out] {
            d.destroy_image_view(view, None);
            d.destroy_image(img, None);
            d.free_memory(mem, None);
        }
        self.swapchain_loader.destroy_swapchain(s.swapchain, None);
    }

    /// Render + present one frame. Returns false if the swapchain needs rebuild.
    unsafe fn draw(&mut self) -> bool {
        if self.swap.is_none() {
            return true;
        }
        // advance the held-key game loop (dt clamped so a stall can't teleport)
        let now = std::time::Instant::now();
        let dt = self.last_frame.map(|t| (now - t).as_secs_f32().min(0.1)).unwrap_or(0.0);
        self.last_frame = Some(now);
        // headless walk test: synthesize a held up+right for the first WALK secs
        if let Some(w) = self.walk {
            self.held = if self.start_time.elapsed().as_secs_f32() < w { [true, false, false, true] } else { [false; 4] };
        }
        if self.held != [false; 4] {
            self.update_motion(dt);
        }
        // (re)build the denoiser (async interop, then sync interop, then host
        // fallback) before the long `swap` borrow
        if self.denoise_live {
            let (lw, lh) = { let s = self.swap.as_ref().unwrap(); (s.low_w, s.low_h) };
            self.ensure_denoise(lw, lh);
        }
        let swap = self.swap.as_ref().unwrap();
        let d = &self.ctx.device;
        d.wait_for_fences(&[self.in_flight], true, u64::MAX).unwrap();

        let (idx, _suboptimal) = match self.swapchain_loader.acquire_next_image(swap.swapchain, u64::MAX, self.image_available, vk::Fence::null()) {
            Ok(r) => r,
            Err(vk::Result::ERROR_OUT_OF_DATE_KHR) => return false,
            Err(e) => panic!("acquire: {e:?}"),
        };
        d.reset_fences(&[self.in_flight]).unwrap();

        // Player moved: patch its dynamic instance transform (fence wait above
        // guarantees no in-flight TLAS read), then the TLAS is rebuilt below.
        // The rendered position is the lattice-SNAPPED one (web invariant: every
        // mesh setPosition routes through the ground snap; the ECS transform in
        // `player_pos` stays continuous).
        if self.player_dirty {
            self.gpu.set_player_transform(&self.ctx, Mat4::from_translation(snap_ground_to_lattice(self.player_pos)));
        }
        let rebuild = self.player_dirty;

        let dispatch_trace = self.samples < MAX_SAMPLES;
        let do_clear = self.reset_accum;
        let (low_w, low_h, extent) = (swap.low_w, swap.low_h, swap.extent);
        let sc_image = swap.images[idx as usize];

        // camera: ISO_VIEW_CONTRACT at the movable look-at target
        let mut cam = iso_camera_at(&self.scene, low_w, low_h, 0.0, self.target);
        cam.misc2[0] = self.frame as i32;
        cam.misc2[1] = self.debug;
        cam.misc2[2] = self.aa;

        let samples_now = if dispatch_trace { self.samples + SPP_PER } else { self.samples.max(SPP_PER) };

        // Denoise dial: trace + OIDN run out-of-band producing the `denoised`
        // HDR image; the present cmd then just tonemaps that (samples=1, since it
        // holds mean radiance). Fast path records the trace into the present cmd
        // and tonemaps the raw accumulator.
        let mut wait_denoise = false; // present cmd must wait CUDA's denoise (async path)
        let (tone_set, tone_samples, trace_in_present) = if self.denoise_live && self.async_interop.is_some() {
            // ASYNC zero-copy path: trace, submit copy-in (signals sem_copy_done),
            // CUDA waits it + OIDN-denoises on its stream + signals sem_denoise_done.
            // No CPU-blocking sync; the present cmd waits sem_denoise_done.
            self.trace_one_time(do_clear, dispatch_trace, rebuild, &cam);
            self.submit_copy_in_async();
            let _ = self.cuda.as_ref().unwrap().enqueue_wait();
            let _ = self.async_interop.as_ref().unwrap().execute_async();
            let _ = self.cuda.as_ref().unwrap().enqueue_signal();
            wait_denoise = true;
            (swap.tone_set_dn, samples_now, false)
        } else if self.denoise_live && self.interop.is_some() {
            // zero-copy path: denoise the SUM in shared VRAM, tonemap divides it
            self.trace_one_time(do_clear, dispatch_trace, rebuild, &cam);
            let t = std::time::Instant::now();
            self.denoise_interop_inplace();
            if self.frame % 60 == 5 {
                println!("OIDN zero-copy denoise: {:.2}ms ({}x{})", t.elapsed().as_secs_f32() * 1000.0, low_w, low_h);
            }
            (swap.tone_set_dn, samples_now, false)
        } else if self.denoise_live {
            // host-copy fallback: denoise the MEAN, tonemap divides by 1
            self.trace_one_time(do_clear, dispatch_trace, rebuild, &cam);
            let mut color = self.readback_accum_mean();
            if let Some(dn) = self.denoiser.as_ref() {
                let t = std::time::Instant::now();
                if let Err(e) = dn.denoise(&mut color) {
                    eprintln!("denoise: {e}");
                }
                if self.frame % 60 == 5 {
                    println!("OIDN {} (host-copy) denoise: {:.2}ms ({}x{})", dn.device_name(), t.elapsed().as_secs_f32() * 1000.0, low_w, low_h);
                }
            }
            self.upload_denoised(&color);
            (swap.tone_set_dn, 1, false)
        } else {
            (swap.tone_set, samples_now, true)
        };

        d.reset_command_buffer(self.cmd, vk::CommandBufferResetFlags::empty()).unwrap();
        d.begin_command_buffer(self.cmd, &vk::CommandBufferBeginInfo::default().flags(vk::CommandBufferUsageFlags::ONE_TIME_SUBMIT)).unwrap();
        let cmd = self.cmd;

        // async denoise: bring CUDA's result (shared VRAM) into the `denoised`
        // image before the tonemap reads it (gated by sem_denoise_done below).
        if wait_denoise {
            self.record_copy_out(cmd);
        }

        if trace_in_present {
            if rebuild {
                self.gpu.record_tlas_rebuild(&self.ctx, cmd);
            }
            if do_clear {
                // camera moved -> wipe the HDR accumulator and start fresh (grain).
                let range = vk::ImageSubresourceRange { aspect_mask: vk::ImageAspectFlags::COLOR, base_mip_level: 0, level_count: 1, base_array_layer: 0, layer_count: 1 };
                d.cmd_clear_color_image(cmd, swap.accum.0, vk::ImageLayout::GENERAL, &vk::ClearColorValue { float32: [0.0; 4] }, &[range]);
                d.cmd_pipeline_barrier(cmd, vk::PipelineStageFlags::TRANSFER, vk::PipelineStageFlags::COMPUTE_SHADER, vk::DependencyFlags::empty(), &[vk::MemoryBarrier::default().src_access_mask(vk::AccessFlags::TRANSFER_WRITE).dst_access_mask(vk::AccessFlags::SHADER_WRITE)], &[], &[]);
            }
            if dispatch_trace {
                d.cmd_bind_pipeline(cmd, vk::PipelineBindPoint::COMPUTE, self.gpu.pipeline);
                d.cmd_bind_descriptor_sets(cmd, vk::PipelineBindPoint::COMPUTE, self.gpu.pipeline_layout, 0, &[swap.trace_set], &[]);
                let bytes = std::slice::from_raw_parts((&cam as *const Push) as *const u8, std::mem::size_of::<Push>());
                d.cmd_push_constants(cmd, self.gpu.pipeline_layout, vk::ShaderStageFlags::COMPUTE, 0, bytes);
                d.cmd_dispatch(cmd, low_w.div_ceil(8), low_h.div_ceil(8), 1);
                // accum write -> tonemap read (same GENERAL layout)
                d.cmd_pipeline_barrier(cmd, vk::PipelineStageFlags::COMPUTE_SHADER, vk::PipelineStageFlags::COMPUTE_SHADER, vk::DependencyFlags::empty(), &[vk::MemoryBarrier::default().src_access_mask(vk::AccessFlags::SHADER_WRITE).dst_access_mask(vk::AccessFlags::SHADER_READ)], &[], &[]);
            }
        }

        // #5: the GPU crop origin is round(pan); the fractional remainder stays
        // on the CPU side so the upscale lattice is always integer-aligned.
        let rs = self.rs();
        let pan = self.pan.round();
        let tp = TonePush {
            dims: [low_w as i32, low_h as i32, extent.width as i32, extent.height as i32],
            cfg: [rs, tone_samples, pan.x as i32, pan.y as i32],
            fcfg: [self.exposure, 0.0, 0.0, 0.0],
        };
        d.cmd_bind_pipeline(cmd, vk::PipelineBindPoint::COMPUTE, self.tone_pipeline);
        d.cmd_bind_descriptor_sets(cmd, vk::PipelineBindPoint::COMPUTE, self.tone_pipeline_layout, 0, &[tone_set], &[]);
        let tbytes = std::slice::from_raw_parts((&tp as *const TonePush) as *const u8, std::mem::size_of::<TonePush>());
        d.cmd_push_constants(cmd, self.tone_pipeline_layout, vk::ShaderStageFlags::COMPUTE, 0, tbytes);
        d.cmd_dispatch(cmd, extent.width.div_ceil(8), extent.height.div_ceil(8), 1);

        // out: GENERAL (compute write) -> TRANSFER_SRC; swapchain: UNDEFINED -> TRANSFER_DST
        barrier(d, cmd, swap.out.0, vk::ImageLayout::GENERAL, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, vk::AccessFlags::SHADER_WRITE, vk::AccessFlags::TRANSFER_READ, vk::PipelineStageFlags::COMPUTE_SHADER, vk::PipelineStageFlags::TRANSFER);
        barrier(d, cmd, sc_image, vk::ImageLayout::UNDEFINED, vk::ImageLayout::TRANSFER_DST_OPTIMAL, vk::AccessFlags::empty(), vk::AccessFlags::TRANSFER_WRITE, vk::PipelineStageFlags::TOP_OF_PIPE, vk::PipelineStageFlags::TRANSFER);
        let layers = vk::ImageSubresourceLayers { aspect_mask: vk::ImageAspectFlags::COLOR, mip_level: 0, base_array_layer: 0, layer_count: 1 };
        let blit = vk::ImageBlit::default()
            .src_subresource(layers)
            .src_offsets([vk::Offset3D { x: 0, y: 0, z: 0 }, vk::Offset3D { x: extent.width as i32, y: extent.height as i32, z: 1 }])
            .dst_subresource(layers)
            .dst_offsets([vk::Offset3D { x: 0, y: 0, z: 0 }, vk::Offset3D { x: extent.width as i32, y: extent.height as i32, z: 1 }]);
        d.cmd_blit_image(cmd, swap.out.0, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, sc_image, vk::ImageLayout::TRANSFER_DST_OPTIMAL, &[blit], vk::Filter::NEAREST);
        // out back to GENERAL for next frame; swapchain -> PRESENT
        barrier(d, cmd, swap.out.0, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, vk::ImageLayout::GENERAL, vk::AccessFlags::TRANSFER_READ, vk::AccessFlags::SHADER_WRITE, vk::PipelineStageFlags::TRANSFER, vk::PipelineStageFlags::COMPUTE_SHADER);
        barrier(d, cmd, sc_image, vk::ImageLayout::TRANSFER_DST_OPTIMAL, vk::ImageLayout::PRESENT_SRC_KHR, vk::AccessFlags::TRANSFER_WRITE, vk::AccessFlags::empty(), vk::PipelineStageFlags::TRANSFER, vk::PipelineStageFlags::BOTTOM_OF_PIPE);

        d.end_command_buffer(cmd).unwrap();

        // wait on image-available (for the blit) and, on the async path, on
        // CUDA's sem_denoise_done (for the copy-out at TRANSFER).
        let (wait, wait_stage): (Vec<vk::Semaphore>, Vec<vk::PipelineStageFlags>) = if wait_denoise {
            (vec![self.image_available, self.sem_denoise_done], vec![vk::PipelineStageFlags::COMPUTE_SHADER, vk::PipelineStageFlags::TRANSFER])
        } else {
            (vec![self.image_available], vec![vk::PipelineStageFlags::COMPUTE_SHADER])
        };
        let sig = [swap.render_finished[idx as usize]];
        let cmds = [cmd];
        d.queue_submit(self.ctx.queue, &[vk::SubmitInfo::default().wait_semaphores(&wait).wait_dst_stage_mask(&wait_stage).command_buffers(&cmds).signal_semaphores(&sig)], self.in_flight).unwrap();

        let swapchains = [swap.swapchain];
        let indices = [idx];
        let present = vk::PresentInfoKHR::default().wait_semaphores(&sig).swapchains(&swapchains).image_indices(&indices);
        let ok = match self.swapchain_loader.queue_present(self.ctx.queue, &present) {
            Ok(false) => true,
            Ok(true) | Err(vk::Result::ERROR_OUT_OF_DATE_KHR) => false,
            Err(e) => panic!("present: {e:?}"),
        };

        if dispatch_trace {
            self.samples += SPP_PER;
        }
        self.reset_accum = false;
        self.player_dirty = false;
        self.frame = self.frame.wrapping_add(1);

        // CPU frame-time (how long draw() blocks the main thread). The async
        // denoise path's win shows up here: no per-frame OIDN/copy fence waits.
        let cpu_ms = now.elapsed().as_secs_f32() * 1000.0;
        self.frame_time_sum += cpu_ms;
        if self.denoise_live && self.frame % 60 == 5 {
            let path = if self.async_interop.is_some() { "async (no CPU sync)" } else if self.interop.is_some() { "sync interop" } else { "host-copy" };
            println!("denoise {path}: CPU frame {cpu_ms:.2}ms ({low_w}x{low_h})");
        }
        if let Some(limit) = self.frames_limit {
            if self.frame >= limit {
                d.device_wait_idle().unwrap();
                println!("FRAMES={limit}: avg CPU frame {:.2}ms (denoise {})", self.frame_time_sum / limit as f32, if self.denoise_live { "on" } else { "off" });
                self.exit_requested = true;
            }
        }

        // headless capture: once a few hundred spp have accumulated, dump + exit.
        if let Some(path) = self.shot.clone() {
            if self.samples >= self.shot_spp {
                d.device_wait_idle().unwrap();
                if self.denoise && !self.denoise_live {
                    self.capture_denoised(&path); // headless denoise without the live dial
                } else {
                    self.capture(&path); // `out` already holds the live-denoised result
                }
                self.exit_requested = true;
            }
        }
        ok
    }
}

struct App {
    window: Option<Arc<Window>>,
    renderer: Option<Renderer>,
}

impl ApplicationHandler for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }
        let attrs = Window::default_attributes().with_title("rt-probe — iso viewer").with_inner_size(winit::dpi::LogicalSize::new(1280.0, 800.0));
        let window = Arc::new(event_loop.create_window(attrs).unwrap());
        let renderer = unsafe { Renderer::new(&window).expect("renderer init") };
        self.window = Some(window);
        self.renderer = Some(renderer);
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => event_loop.exit(),
            WindowEvent::KeyboardInput { event, .. } => {
                let Some(r) = self.renderer.as_mut() else { return };
                // movement keys are held-state (continuous walk); index = [up,down,left,right]
                let held_idx = match event.logical_key.as_ref() {
                    Key::Named(NamedKey::ArrowUp) | Key::Character("w") => Some(0),
                    Key::Named(NamedKey::ArrowDown) | Key::Character("s") => Some(1),
                    Key::Named(NamedKey::ArrowLeft) | Key::Character("a") => Some(2),
                    Key::Named(NamedKey::ArrowRight) | Key::Character("d") => Some(3),
                    _ => None,
                };
                if let Some(i) = held_idx {
                    r.held[i] = event.state.is_pressed();
                    return;
                }
                if !event.state.is_pressed() {
                    return; // discrete actions fire on press only
                }
                match event.logical_key.as_ref() {
                    Key::Named(NamedKey::Escape) => event_loop.exit(),
                    Key::Character("=") | Key::Character("+") => {
                        let c = r.cursor;
                        r.zoom_at(1.25, c);
                    }
                    Key::Character("-") | Key::Character("_") => {
                        let c = r.cursor;
                        r.zoom_at(0.8, c);
                    }
                    Key::Character("0") => {
                        r.zoom = 1.0;
                        r.player_pos = r.scene.player_start;
                        r.target = r.player_pos;
                        r.snap_target_to_lattice();
                        r.move_accum = Vec2::ZERO;
                        r.recenter_pan();
                        r.player_dirty = true;
                        r.reset_render();
                    }
                    Key::Character("j") => {
                        r.denoise_live = !r.denoise_live;
                        println!("denoise dial: {}", if r.denoise_live { "ON" } else { "OFF" });
                    }
                    _ => {}
                }
            }
            WindowEvent::CursorMoved { position, .. } => {
                if let Some(r) = self.renderer.as_mut() {
                    let np = Vec2::new(position.x as f32, position.y as f32);
                    if r.dragging {
                        let rs = r.rs() as f32;
                        let d = np - r.cursor;
                        r.move_player(d / rs); // drag moves the player
                    }
                    r.cursor = np;
                }
            }
            WindowEvent::MouseInput { state, button, .. } if button == MouseButton::Left => {
                if let Some(r) = self.renderer.as_mut() {
                    r.dragging = state == ElementState::Pressed;
                }
            }
            WindowEvent::MouseWheel { delta, .. } => {
                if let Some(r) = self.renderer.as_mut() {
                    let dy = match delta {
                        MouseScrollDelta::LineDelta(_, y) => y,
                        MouseScrollDelta::PixelDelta(p) => p.y as f32 / 50.0,
                    };
                    let c = r.cursor;
                    r.zoom_at(1.15f32.powf(dy), c);
                }
            }
            WindowEvent::Resized(size) => {
                if let Some(r) = &mut self.renderer {
                    if size.width > 0 && size.height > 0 {
                        unsafe { r.recreate_swapchain(size.width, size.height) };
                    }
                }
            }
            WindowEvent::RedrawRequested => {
                if let (Some(r), Some(w)) = (&mut self.renderer, &self.window) {
                    let ok = unsafe { r.draw() };
                    if r.exit_requested {
                        event_loop.exit();
                        return;
                    }
                    if !ok {
                        let s = w.inner_size();
                        if s.width > 0 && s.height > 0 {
                            unsafe { r.recreate_swapchain(s.width, s.height) };
                        }
                    }
                }
            }
            _ => {}
        }
    }

    fn about_to_wait(&mut self, _event_loop: &ActiveEventLoop) {
        if let Some(w) = &self.window {
            w.request_redraw();
        }
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let event_loop = EventLoop::new()?;
    event_loop.set_control_flow(winit::event_loop::ControlFlow::Poll);
    let mut app = App { window: None, renderer: None };
    event_loop.run_app(&mut app)?;
    Ok(())
}
