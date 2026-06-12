//! Renderer core: Vulkan device + swapchain init, per-frame draw.
//!
//! The frame is DETERMINISTIC end to end: stream this frame's light values
//! (practicals + flashlight slot), rebuild the TLAS if the player moved,
//! one shade.comp dispatch (pure function of scene + camera), tonemap with
//! the integer-NEAREST upscale, blit, present. No accumulation, no denoiser,
//! no temporal state — a fixed camera produces bit-identical frames.

use crate::capture::Harness;
use crate::menu::{MenuState, MENU_MARGIN, MPANEL_H, MPANEL_W};
use crate::view::{PlayerState, ViewState};
use ash::vk;
use glam::{Vec2, Vec3};
use raw_window_handle::{HasDisplayHandle, HasWindowHandle};
use rt_probe::*;
use std::ffi::{c_char, CStr, CString};
use winit::window::Window;

pub const MARGIN: u32 = 32; // low-res overscan border so pan/zoom never reveal edge bars
pub const ZOOM_MIN: f32 = 1.0;
pub const ZOOM_MAX: f32 = 4.0; // web game-studio: zoomMin 1, zoomMax 4, zoomStep 1

/// Push constants for tonemap.comp. Field names match the shader's `pc` block.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct TonePush {
    pub dims: [i32; 4], // low_w, low_h, out_w, out_h
    pub cfg: [i32; 4],  // scale, pan_x, pan_y, _
    pub fcfg: [f32; 4], // exposure, grain, frame, dither world-phase x
    // current frame's screen projection rows (outline forward recovery):
    // buffer px of world P = (dot(P, proj_a.xyz) + proj_a.w, dot(P, proj_b.xyz) + proj_b.w)
    pub proj_a: [f32; 4],
    pub proj_b: [f32; 4],
    pub style1: [f32; 4], // grade preset, poster bands, dither mode, dither amount
    pub style2: [f32; 4], // palette mode, palette param, vignette, outline strength
    pub style3: [f32; 4], // grain size px, grain static flag, bloom strength, bloom threshold
    pub style4: [f32; 4], // shadow dither: strength, levels, luma threshold, dither world-phase y
}

/// Window-size-dependent resources, recreated on resize. Headless SHOT mode
/// builds one too (the extent comes verbatim from WINDOW) — `swapchain` is
/// then null and `images` / `render_finished` are empty.
pub struct Swap {
    pub swapchain: vk::SwapchainKHR,
    pub extent: vk::Extent2D,
    pub images: Vec<vk::Image>,
    pub low_w: u32,
    pub low_h: u32,
    pub color: (vk::Image, vk::DeviceMemory, vk::ImageView),  // shade.comp radiance out
    pub albedo: (vk::Image, vk::DeviceMemory, vk::ImageView), // primary-hit albedo G-buffer
    pub posg: (vk::Image, vk::DeviceMemory, vk::ImageView),   // primary-hit world-position G-buffer
    pub out: (vk::Image, vk::DeviceMemory, vk::ImageView),    // 8-bit window image
    pub menu_buf: Buffer, // host-visible staging for the ESC tune-menu overlay
    pub menu_scale: u32,  // integer UI scale (from window height; pixel font stays readable)
    pub scene_pool: vk::DescriptorPool,
    pub scene_set: vk::DescriptorSet,
    pub tone_pool: vk::DescriptorPool,
    pub tone_set: vk::DescriptorSet,
    // one render-finished semaphore per swapchain image (avoids reuse hazard)
    pub render_finished: Vec<vk::Semaphore>,
}

/// Presentation half: surface + swapchain machinery. `None` for headless SHOT
/// captures — the renderer then draws into the offscreen `out` image only and
/// the in-flight fence is the only synchronisation.
pub struct Present {
    pub surface_loader: ash::khr::surface::Instance,
    pub surface: vk::SurfaceKHR,
    pub swapchain_loader: ash::khr::swapchain::Device,
    pub surface_format: vk::SurfaceFormatKHR,
    pub present_mode: vk::PresentModeKHR,
    pub image_available: vk::Semaphore,
}

pub struct Renderer {
    // ---- Vulkan device & presentation (underscore fields: kept alive only)
    pub _entry: ash::Entry,
    pub _instance: ash::Instance,
    pub pdev: vk::PhysicalDevice,
    pub ctx: Ctx,
    pub present: Option<Present>,
    pub cmd: vk::CommandBuffer,
    pub in_flight: vk::Fence,
    pub swap: Option<Swap>,
    // ---- scene + GPU resources
    pub gpu: SceneGpu,
    pub scene: Scene,
    pub env0: [f32; 4], // resolved lighting environment (scene defaults + overrides)
    pub tone_set_layout: vk::DescriptorSetLayout,
    pub tone_pipeline_layout: vk::PipelineLayout,
    pub tone_pipeline: vk::Pipeline,
    pub _tone_shader: vk::ShaderModule,
    // ---- resolved config + live tunables (the ESC menu writes these)
    pub cfg: Config,
    pub base_scale: u32, // integer render scale at zoom=1 (the DPR baseline, #2/#4)
    pub exposure: f32,
    pub style: StyleCfg,
    pub ao: f32,
    pub ao_r: f32,
    pub ao_n: i32,
    pub light_anim: bool,
    pub room_lights: f32, // master dim: direct via per-frame practicals, indirect via probe-bank lerp
    pub flash_on: bool,
    pub flash_power: f32,
    pub flash_cone: f32,
    pub debug: i32,
    // ---- grouped state
    pub view: ViewState,
    pub player: PlayerState,
    pub menu: MenuState,
    pub harness: Harness,
    pub rec: Option<crate::capture::Rec>,
    pub rec_jobs: Vec<std::thread::JoinHandle<()>>,
    pub cap: Option<crate::capture::Cap>,
    pub movie: Option<crate::capture::Movie>,
    // ---- frame clock / lifecycle
    pub frame: u32,
    pub start_time: std::time::Instant,
    pub last_frame: Option<std::time::Instant>,
    pub frame_time_sum: f32,
    pub exit_requested: bool,
}

impl Renderer {
    /// `window: None` runs fully headless (SHOT captures): no surface, no
    /// swapchain device extension, no present-capable queue required — the
    /// offscreen extent is taken verbatim from `WINDOW` so capture sizes are
    /// reproducible regardless of what a window manager would grant.
    pub unsafe fn new(window: Option<&Window>, cfg: Config) -> Result<Renderer, Box<dyn std::error::Error>> {
        let entry = ash::Entry::load()?;
        let validation = CString::new("VK_LAYER_KHRONOS_validation").unwrap();
        let have_val = entry.enumerate_instance_layer_properties()?.iter().any(|l| (CStr::from_ptr(l.layer_name.as_ptr())) == validation.as_c_str());

        // instance extensions: the platform surface set only when a window
        // exists (headless needs none — it never touches WSI)
        let mut iexts: Vec<*const c_char> = match window {
            Some(w) => ash_window::enumerate_required_extensions(w.display_handle()?.as_raw())?.to_vec(),
            None => Vec::new(),
        };
        let mut layers: Vec<*const c_char> = Vec::new();
        if have_val {
            layers.push(validation.as_ptr());
            iexts.push(ash::ext::debug_utils::NAME.as_ptr());
        }
        let app = vk::ApplicationInfo::default().api_version(vk::API_VERSION_1_3);
        let instance = entry.create_instance(&vk::InstanceCreateInfo::default().application_info(&app).enabled_layer_names(&layers).enabled_extension_names(&iexts), None)?;

        let surface_pair = match window {
            Some(w) => {
                let surface = ash_window::create_surface(&entry, &instance, w.display_handle()?.as_raw(), w.window_handle()?.as_raw(), None)?;
                Some((ash::khr::surface::Instance::new(&entry, &instance), surface))
            }
            None => None,
        };

        // physical device: RT, plus swapchain + present support when windowed
        let mut req_exts = vec![
            ash::khr::acceleration_structure::NAME,
            ash::khr::ray_query::NAME,
            ash::khr::deferred_host_operations::NAME,
        ];
        if window.is_some() {
            req_exts.push(ash::khr::swapchain::NAME);
        }
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
                        && surface_pair.as_ref().map_or(true, |(sl, s)| sl.get_physical_device_surface_support(pd, i, *s).unwrap_or(false))
                })?;
                Some((pd, q))
            })
            .ok_or("no RT device")?;
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
        let ctx = Ctx { device, as_dev, queue, pool, mem_props };
        println!("device: {}", CStr::from_ptr(props.device_name.as_ptr()).to_string_lossy());

        // presentation half (windowed only): surface format + present mode
        let present = match surface_pair {
            Some((surface_loader, surface)) => {
                let formats = surface_loader.get_physical_device_surface_formats(pdev, surface)?;
                let surface_format = formats
                    .iter()
                    .copied()
                    .find(|f| f.format == vk::Format::B8G8R8A8_UNORM && f.color_space == vk::ColorSpaceKHR::SRGB_NONLINEAR)
                    .unwrap_or(formats[0]);
                let modes = surface_loader.get_physical_device_surface_present_modes(pdev, surface)?;
                let present_mode = if modes.contains(&vk::PresentModeKHR::MAILBOX) { vk::PresentModeKHR::MAILBOX } else { vk::PresentModeKHR::FIFO };
                let swapchain_loader = ash::khr::swapchain::Device::new(&instance, &ctx.device);
                let image_available = ctx.device.create_semaphore(&vk::SemaphoreCreateInfo::default(), None)?;
                Some(Present { surface_loader, surface, swapchain_loader, surface_format, present_mode, image_available })
            }
            None => None,
        };

        // scene + acceleration structures + pipelines
        let scene = build_scene(&cfg)?;
        println!("scene: {} prims, {} tris, {} textures", scene.primitives.len(), scene.indices.len() / 3, scene.images.len());
        let player0 = scene.player_start;
        let level = Level::from_scene(&scene);
        println!("level: floor rect {:?}, {} solids", level.floor, level.solids.len());
        let gpu = SceneGpu::build(&ctx, &scene, cfg.probe_spacing)?;
        let env0 = cfg.lighting_env(scene.lighting);

        // tonemap pipeline (window-independent)
        let tone_bindings = [
            dslb(0, vk::DescriptorType::STORAGE_IMAGE, 1), // radiance
            dslb(1, vk::DescriptorType::STORAGE_IMAGE, 1), // 8-bit output
            dslb(2, vk::DescriptorType::STORAGE_IMAGE, 1), // primary-hit albedo (poster demodulation)
            dslb(3, vk::DescriptorType::STORAGE_IMAGE, 1), // world-position G-buffer (outline)
        ];
        let tone_set_layout = ctx.device.create_descriptor_set_layout(&vk::DescriptorSetLayoutCreateInfo::default().bindings(&tone_bindings), None)?;
        let tone_sl = [tone_set_layout];
        let tone_push = [vk::PushConstantRange::default().stage_flags(vk::ShaderStageFlags::COMPUTE).offset(0).size(std::mem::size_of::<TonePush>() as u32)];
        let tone_pipeline_layout = ctx.device.create_pipeline_layout(&vk::PipelineLayoutCreateInfo::default().set_layouts(&tone_sl).push_constant_ranges(&tone_push), None)?;
        const TONE_SPV: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/tonemap.comp.spv"));
        let tone_code = ash::util::read_spv(&mut std::io::Cursor::new(TONE_SPV))?;
        let tone_shader = ctx.device.create_shader_module(&vk::ShaderModuleCreateInfo::default().code(&tone_code), None)?;
        let tone_name = CString::new("main").unwrap();
        let tone_pipeline = ctx
            .device
            .create_compute_pipelines(vk::PipelineCache::null(), &[vk::ComputePipelineCreateInfo::default().stage(vk::PipelineShaderStageCreateInfo::default().stage(vk::ShaderStageFlags::COMPUTE).module(tone_shader).name(&tone_name)).layout(tone_pipeline_layout)], None)
            .map_err(|(_, e)| e)?[0];

        let cmd = ctx.device.allocate_command_buffers(&vk::CommandBufferAllocateInfo::default().command_pool(pool).level(vk::CommandBufferLevel::PRIMARY).command_buffer_count(1))?[0];
        let in_flight = ctx.device.create_fence(&vk::FenceCreateInfo::default().flags(vk::FenceCreateFlags::SIGNALED), None)?;

        let grid_mode = cfg.scene == "grid";
        let mut r = Renderer {
            _entry: entry,
            _instance: instance,
            pdev,
            ctx,
            present,
            cmd,
            in_flight,
            swap: None,
            gpu,
            scene,
            env0,
            tone_set_layout,
            tone_pipeline_layout,
            tone_pipeline,
            _tone_shader: tone_shader,
            base_scale: cfg.pixel,
            exposure: cfg.exposure,
            style: cfg.style,
            ao: cfg.ao,
            ao_r: cfg.ao_r,
            ao_n: cfg.ao_n,
            light_anim: cfg.light_anim,
            room_lights: cfg.lights,
            flash_on: cfg.flash,
            flash_power: cfg.flash_power,
            flash_cone: cfg.flash_cone,
            debug: cfg.debug,
            view: ViewState {
                zoom: cfg.zoom.round().clamp(ZOOM_MIN, ZOOM_MAX),
                yaw_q: cfg.yaw_q,
                mask_q: cfg.yaw_q,
                rot: None,
                yaw_anim: 0.0,
                pan: Vec2::ZERO,
                target: player0,
                move_accum: Vec2::ZERO,
                cursor: Vec2::ZERO,
                wheel_accum: 0.0,
                dragging: false,
            },
            player: PlayerState {
                pos: player0,
                facing: Vec2::ZERO, // seeded toward screen-down below
                dirty: false,
                held: [false; 4],
                speed: cfg.player_speed.unwrap_or(cfg.default_player_speed()),
                level,
                follow_cam: !grid_mode,
            },
            menu: MenuState { open: false, sel: 0, drag: false },
            harness: Harness::from_cfg(&cfg),
            rec: None,
            rec_jobs: Vec::new(),
            cap: None,
            movie: cfg.movie.clone().map(|dir| {
                std::fs::create_dir_all(&dir).ok();
                crate::capture::Movie::new(dir, &cfg)
            }),
            frame: 0,
            start_time: std::time::Instant::now(),
            last_frame: None,
            frame_time_sum: 0.0,
            exit_requested: false,
            cfg,
        };
        if !r.scene.prim_hide_mask.is_empty() {
            // MASK_Q (diagnostic): decouple the dollhouse masks from the camera
            // quarter to prove/disprove mask-dependent light transport.
            let mq = r.cfg.mask_q.unwrap_or(r.view.yaw_q);
            r.gpu.set_yaw_masks(&r.ctx, mq);
            r.view.mask_q = mq;
            r.player.dirty = true; // first TLAS rebuild applies the masks
        }
        // windowed: whatever inner size the WM actually granted; headless: the
        // WINDOW request verbatim — identical extent math from there on
        let (w0, h0) = match window {
            Some(w) => (w.inner_size().width, w.inner_size().height),
            None => r.cfg.window.unwrap_or((1280, 800)),
        };
        r.recreate_swapchain(w0.max(1), h0.max(1));
        // bake the GI probe cache (blocking, once — both light banks)
        let set = r.swap.as_ref().unwrap().scene_set;
        r.gpu.bake_probes(&r.ctx, set, r.env0, r.cfg.probe_rays);
        // optional initial pan offset (low pixels), for headless capture tests
        if r.cfg.pan != (0.0, 0.0) {
            let d = Vec2::new(r.cfg.pan.0, r.cfg.pan.1);
            r.view.pan += d;
            r.clamp_pan_to_buffer();
        }
        // optional camera look-at override (world units), for framing captures
        if r.cfg.target.0.is_some() || r.cfg.target.1.is_some() {
            let t = Vec3::new(r.cfg.target.0.unwrap_or(r.view.target.x), 0.0, r.cfg.target.1.unwrap_or(r.view.target.z));
            r.view.target = snap_ground_to_lattice(t, r.yaw_deg());
        }
        // optional player world offset (camera NOT moved) — proves the dynamic
        // TLAS rebuild displaces the marker in headless capture tests.
        if r.cfg.player_off != (0.0, 0.0) {
            r.player.pos += Vec3::new(r.cfg.player_off.0, 0.0, r.cfg.player_off.1);
            r.player.dirty = true;
        }
        // default flashlight aim: toward the camera (screen-down), until the
        // first walk input sets a real facing
        let down = screen_px_to_world(Vec2::new(0.0, 1.0), r.yaw_deg());
        r.player.facing = Vec2::new(down.x, down.z).try_normalize().unwrap_or(Vec2::new(0.0, 1.0));
        Ok(r)
    }

    /// Whole-low-pixel render scale for the current zoom (#4).
    pub fn rs(&self) -> i32 {
        render_scale(self.view.zoom, self.base_scale)
    }

    /// (low buffer size, visible-region size) in low pixels, for pan clamping.
    pub fn low_and_vis(&self) -> (Vec2, Vec2) {
        let swap = self.swap.as_ref().unwrap();
        let rs = self.rs() as f32;
        let low = Vec2::new(swap.low_w as f32, swap.low_h as f32);
        let vis = Vec2::new((swap.extent.width as f32 / rs).ceil(), (swap.extent.height as f32 / rs).ceil());
        (low, vis)
    }

    pub fn clamp_pan_to_buffer(&mut self) {
        if self.swap.is_some() {
            let (low, vis) = self.low_and_vis();
            self.view.pan = clamp_pan(self.view.pan, low, vis);
        }
    }

    /// Centre the visible crop in the low buffer.
    pub fn recenter_pan(&mut self) {
        if self.swap.is_some() {
            let (low, vis) = self.low_and_vis();
            self.view.pan = (low - vis) * 0.5;
        }
    }

    /// (Re)build the swapchain and all window-size-dependent resources.
    pub unsafe fn recreate_swapchain(&mut self, win_w: u32, win_h: u32) {
        self.ctx.device.device_wait_idle().ok();
        if let Some(old) = self.swap.take() {
            self.destroy_swap(old);
        }

        // headless: no swapchain — the extent IS the requested size, so SHOT
        // dimensions are exactly WINDOW with no WM in the loop
        let (extent, swapchain, images) = match &self.present {
            Some(p) => {
                let caps = p.surface_loader.get_physical_device_surface_capabilities(self.pdev, p.surface).unwrap();
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
                let swapchain = p
                    .swapchain_loader
                    .create_swapchain(
                        &vk::SwapchainCreateInfoKHR::default()
                            .surface(p.surface)
                            .min_image_count(count)
                            .image_format(p.surface_format.format)
                            .image_color_space(p.surface_format.color_space)
                            .image_extent(extent)
                            .image_array_layers(1)
                            .image_usage(vk::ImageUsageFlags::TRANSFER_DST | vk::ImageUsageFlags::COLOR_ATTACHMENT)
                            .image_sharing_mode(vk::SharingMode::EXCLUSIVE)
                            .pre_transform(caps.current_transform)
                            .composite_alpha(vk::CompositeAlphaFlagsKHR::OPAQUE)
                            .present_mode(p.present_mode)
                            .clipped(true),
                        None,
                    )
                    .unwrap();
                let images = p.swapchain_loader.get_swapchain_images(swapchain).unwrap();
                (extent, swapchain, images)
            }
            None => (vk::Extent2D { width: win_w, height: win_h }, vk::SwapchainKHR::null(), Vec::new()),
        };

        // pixel-perfect low-res buffer (#2): window / base-scale at zoom=1, plus
        // an overscan border so the pan crop never reveals edge bars (#7).
        let low_w = extent.width.div_ceil(self.base_scale).max(1) + 2 * MARGIN;
        let low_h = extent.height.div_ceil(self.base_scale).max(1) + 2 * MARGIN;

        let color = make_storage_image(&self.ctx, low_w, low_h, vk::Format::R32G32B32A32_SFLOAT);
        let albedo = make_storage_image(&self.ctx, low_w, low_h, vk::Format::R32G32B32A32_SFLOAT);
        let posg = make_storage_image(&self.ctx, low_w, low_h, vk::Format::R32G32B32A32_SFLOAT);
        let out = make_storage_image(&self.ctx, extent.width, extent.height, vk::Format::R8G8B8A8_UNORM);
        // ESC tune-menu overlay staging (sized for the full panel at this scale)
        let menu_scale = (extent.height / 400).clamp(2, 6);
        let menu_buf = self.ctx.create_buffer(
            (MPANEL_W * MPANEL_H) as u64 * (menu_scale as u64 * menu_scale as u64) * 4,
            vk::BufferUsageFlags::TRANSFER_SRC,
            vk::MemoryPropertyFlags::HOST_VISIBLE | vk::MemoryPropertyFlags::HOST_COHERENT,
        );
        self.ctx.one_time(|cmd| {
            for img in [color.0, albedo.0, posg.0, out.0] {
                barrier(&self.ctx.device, cmd, img, vk::ImageLayout::UNDEFINED, vk::ImageLayout::GENERAL, vk::AccessFlags::empty(), vk::AccessFlags::SHADER_WRITE, vk::PipelineStageFlags::TOP_OF_PIPE, vk::PipelineStageFlags::COMPUTE_SHADER);
            }
        });

        // descriptor sets
        let scene_pool = make_pool(&self.ctx, self.gpu.texes.len() as u32);
        let scene_set = make_set(&self.ctx, &self.gpu, scene_pool, color.2, albedo.2, posg.2);
        let tone_pool = {
            let sizes = [vk::DescriptorPoolSize { ty: vk::DescriptorType::STORAGE_IMAGE, descriptor_count: 4 }];
            self.ctx.device.create_descriptor_pool(&vk::DescriptorPoolCreateInfo::default().max_sets(1).pool_sizes(&sizes), None).unwrap()
        };
        let tone_set = {
            let layouts = [self.tone_set_layout];
            let set = self.ctx.device.allocate_descriptor_sets(&vk::DescriptorSetAllocateInfo::default().descriptor_pool(tone_pool).set_layouts(&layouts)).unwrap()[0];
            let c = [vk::DescriptorImageInfo::default().image_view(color.2).image_layout(vk::ImageLayout::GENERAL)];
            let o = [vk::DescriptorImageInfo::default().image_view(out.2).image_layout(vk::ImageLayout::GENERAL)];
            let al = [vk::DescriptorImageInfo::default().image_view(albedo.2).image_layout(vk::ImageLayout::GENERAL)];
            let po = [vk::DescriptorImageInfo::default().image_view(posg.2).image_layout(vk::ImageLayout::GENERAL)];
            let writes = [
                vk::WriteDescriptorSet::default().dst_set(set).dst_binding(0).descriptor_type(vk::DescriptorType::STORAGE_IMAGE).image_info(&c),
                vk::WriteDescriptorSet::default().dst_set(set).dst_binding(1).descriptor_type(vk::DescriptorType::STORAGE_IMAGE).image_info(&o),
                vk::WriteDescriptorSet::default().dst_set(set).dst_binding(2).descriptor_type(vk::DescriptorType::STORAGE_IMAGE).image_info(&al),
                vk::WriteDescriptorSet::default().dst_set(set).dst_binding(3).descriptor_type(vk::DescriptorType::STORAGE_IMAGE).image_info(&po),
            ];
            self.ctx.device.update_descriptor_sets(&writes, &[]);
            set
        };

        let render_finished: Vec<vk::Semaphore> = images.iter().map(|_| self.ctx.device.create_semaphore(&vk::SemaphoreCreateInfo::default(), None).unwrap()).collect();

        self.swap = Some(Swap { swapchain, extent, images, low_w, low_h, color, albedo, posg, out, menu_buf, menu_scale, scene_pool, scene_set, tone_pool, tone_set, render_finished });
        self.recenter_pan(); // start centred in the buffer
        println!("{} {}x{}  low-res {}x{} @ baseScale x{} (R={:.2})", if self.present.is_some() { "swapchain" } else { "offscreen" }, extent.width, extent.height, low_w, low_h, self.base_scale, ISO_R);
    }

    pub unsafe fn destroy_swap(&self, s: Swap) {
        let d = &self.ctx.device;
        for sem in &s.render_finished {
            d.destroy_semaphore(*sem, None);
        }
        d.destroy_descriptor_pool(s.scene_pool, None);
        d.destroy_descriptor_pool(s.tone_pool, None);
        for (img, mem, view) in [s.color, s.albedo, s.posg, s.out] {
            d.destroy_image_view(view, None);
            d.destroy_image(img, None);
            d.free_memory(mem, None);
        }
        self.ctx.destroy_buffer(&s.menu_buf);
        if let Some(p) = &self.present {
            p.swapchain_loader.destroy_swapchain(s.swapchain, None);
        }
    }

    /// Render + present one frame. Returns false if the swapchain needs rebuild.
    pub unsafe fn draw(&mut self) -> bool {
        if self.swap.is_none() {
            return true;
        }
        // advance the held-key game loop (dt clamped so a stall can't teleport)
        let now = std::time::Instant::now();
        let dt = self.last_frame.map(|t| (now - t).as_secs_f32().min(0.1)).unwrap_or(0.0);
        self.last_frame = Some(now);
        self.harness_pre_frame(); // WALK / ROTATE_AT / DUMP_AT synthetic inputs
        if self.player.held != [false; 4] {
            self.update_motion(dt);
        }
        // smooth quarter-turn in flight: ease the yaw, swap masks at crossings
        self.advance_rotation(dt);
        // clip recording: collect last frame's capture + decide if this frame
        // captures (all &mut self work, so it runs before the `swap` borrow)
        let cap_issue = self.prepare_capture();
        // flashlight: refresh the reserved NEE slot from the player pose
        self.update_flashlight();

        let swap = self.swap.as_ref().unwrap();
        let d = &self.ctx.device;
        d.wait_for_fences(&[self.in_flight], true, u64::MAX).unwrap();

        // windowed: acquire the swapchain image to blit + present into;
        // headless SHOT renders into `out` only — nothing to acquire
        let idx = match &self.present {
            Some(p) => match p.swapchain_loader.acquire_next_image(swap.swapchain, u64::MAX, p.image_available, vk::Fence::null()) {
                Ok((idx, _suboptimal)) => Some(idx),
                Err(vk::Result::ERROR_OUT_OF_DATE_KHR) => return false,
                Err(e) => panic!("acquire: {e:?}"),
            },
            None => None,
        };
        d.reset_fences(&[self.in_flight]).unwrap();
        let t_acq = std::time::Instant::now(); // fence wait + acquire done

        // Player moved: patch its dynamic instance transform (fence wait above
        // guarantees no in-flight TLAS read), then the TLAS is rebuilt below.
        // The rendered position is the lattice-SNAPPED one (web invariant: every
        // mesh setPosition routes through the ground snap; the game transform in
        // `player.pos` stays continuous).
        if self.player.dirty {
            self.gpu.set_player_transform(&self.ctx, glam::Mat4::from_translation(snap_ground_to_lattice(self.player.pos, self.yaw_deg())));
        }
        let rebuild = self.player.dirty;

        let (low_w, low_h, extent) = (swap.low_w, swap.low_h, swap.extent);
        let sc_image = idx.map(|i| swap.images[i as usize]);

        // camera: ISO_VIEW_CONTRACT at the movable look-at target. The
        // flashlight rides in the reserved trailing NEE slot: +1 includes it
        // while lit (the probe bake always used the bare light_count — the GI
        // cache stays torch-free; a light that moves must be direct-only).
        let cam = iso_camera_at(self.scene.min, self.scene.max, low_w, low_h, self.yaw_deg(), self.view.target);
        let light_count = self.gpu.light_count as i32 + (self.flash_on && self.scene.dynamic_prim.is_some()) as i32;
        let push = ShadePush::new(&cam, low_w, low_h, self.env0, self.room_lights, light_count, self.ao, self.ao_r, self.ao_n, self.debug);

        d.reset_command_buffer(self.cmd, vk::CommandBufferResetFlags::empty()).unwrap();
        d.begin_command_buffer(self.cmd, &vk::CommandBufferBeginInfo::default().flags(vk::CommandBufferUsageFlags::ONE_TIME_SUBMIT)).unwrap();
        let cmd = self.cmd;

        // stream this frame's light values: practicals (flicker anim + room
        // dim; LIGHT_ANIM=0 freezes to constants — bit-stable) + the
        // flashlight slot, which rides along in the same upload.
        self.gpu.record_light_anim(&self.ctx, cmd, self.start_time.elapsed().as_secs_f32(), self.light_anim, self.room_lights);
        if rebuild {
            self.gpu.record_tlas_rebuild(&self.ctx, cmd);
        }
        // deterministic shade: one dispatch, every pixel final
        d.cmd_bind_pipeline(cmd, vk::PipelineBindPoint::COMPUTE, self.gpu.shade_pipeline);
        d.cmd_bind_descriptor_sets(cmd, vk::PipelineBindPoint::COMPUTE, self.gpu.pipeline_layout, 0, &[swap.scene_set], &[]);
        d.cmd_push_constants(cmd, self.gpu.pipeline_layout, vk::ShaderStageFlags::COMPUTE, 0, push_bytes(&push));
        d.cmd_dispatch(cmd, low_w.div_ceil(8), low_h.div_ceil(8), 1);
        // radiance write -> tonemap read (same GENERAL layout)
        d.cmd_pipeline_barrier(cmd, vk::PipelineStageFlags::COMPUTE_SHADER, vk::PipelineStageFlags::COMPUTE_SHADER, vk::DependencyFlags::empty(), &[vk::MemoryBarrier::default().src_access_mask(vk::AccessFlags::SHADER_WRITE).dst_access_mask(vk::AccessFlags::SHADER_READ)], &[], &[]);

        // #5: the GPU crop origin is round(pan); the fractional remainder stays
        // on the CPU side so the upscale lattice is always integer-aligned.
        let rs = self.rs();
        let pan = self.view.pan.round();
        let yaw_now = self.yaw_deg();
        // current projection rows: buffer px of world P (outline forward recovery)
        let (_cd, cright, cup) = iso_basis(yaw_now);
        let pa = cright * ISO_R;
        let pb = -cup * ISO_R;
        let off_x = -self.view.target.dot(cright) * ISO_R + low_w as f32 * 0.5 - 0.5;
        let off_y = self.view.target.dot(cup) * ISO_R + low_h as f32 * 0.5 - 0.5;
        // world-anchored dither/grain phase: the CURRENT camera's screen
        // position of the world origin, rounded to the pixel lattice. The
        // tonemap subtracts it from lp, so ordered-dither/grain patterns
        // travel WITH the scene during WASD pans instead of crawling against
        // it (the camera moves in whole pixels, so the fraction is constant
        // within a pan and the glue is exact).
        // quantize with round(x - 0.25): the value is INTEGRAL when the low
        // dim is even but HALF-INTEGRAL when odd (the dim/2 - 0.5 term), and
        // f32 noise (~1e-4) flips floor() at integers and round() at halves —
        // either choice slips the pattern 1 px on some window parities. The
        // -0.25 bias puts the decision points a full 0.25 from BOTH lattices,
        // and integer camera steps still advance the phase by exactly 1.
        let dphase_x = (-self.view.target.dot(cright) * ISO_R + low_w as f32 * 0.5 - 0.75).round();
        let dphase_y = (self.view.target.dot(cup) * ISO_R + low_h as f32 * 0.5 - 0.75).round();
        let tp = TonePush {
            dims: [low_w as i32, low_h as i32, extent.width as i32, extent.height as i32],
            cfg: [rs, pan.x as i32, pan.y as i32, 0],
            fcfg: [self.exposure, self.style.grain, self.frame as f32, dphase_x],
            proj_a: [pa.x, pa.y, pa.z, off_x],
            proj_b: [pb.x, pb.y, pb.z, off_y],
            style1: [self.style.grade, self.style.poster, self.style.dither, self.style.dither_amt],
            style2: [self.style.palette, self.style.pal_p, self.style.vignette, self.style.outline],
            style3: [self.style.grain_sz, self.style.grain_static, self.style.bloom, self.style.bloom_th],
            style4: [self.style.sdither, self.style.sdither_n, self.style.sdither_th, dphase_y],
        };
        d.cmd_bind_pipeline(cmd, vk::PipelineBindPoint::COMPUTE, self.tone_pipeline);
        d.cmd_bind_descriptor_sets(cmd, vk::PipelineBindPoint::COMPUTE, self.tone_pipeline_layout, 0, &[swap.tone_set], &[]);
        d.cmd_push_constants(cmd, self.tone_pipeline_layout, vk::ShaderStageFlags::COMPUTE, 0, push_bytes(&tp));
        d.cmd_dispatch(cmd, extent.width.div_ceil(8), extent.height.div_ceil(8), 1);

        // out: GENERAL (compute write) -> TRANSFER_SRC (swapchain blit + clip
        // capture source; headless keeps the same layout round-trip)
        barrier(d, cmd, swap.out.0, vk::ImageLayout::GENERAL, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, vk::AccessFlags::SHADER_WRITE, vk::AccessFlags::TRANSFER_READ, vk::PipelineStageFlags::COMPUTE_SHADER, vk::PipelineStageFlags::TRANSFER);
        let layers = vk::ImageSubresourceLayers { aspect_mask: vk::ImageAspectFlags::COLOR, mip_level: 0, base_array_layer: 0, layer_count: 1 };
        if let Some(sc_image) = sc_image {
            // swapchain: UNDEFINED -> TRANSFER_DST, then the integer-NEAREST blit
            barrier(d, cmd, sc_image, vk::ImageLayout::UNDEFINED, vk::ImageLayout::TRANSFER_DST_OPTIMAL, vk::AccessFlags::empty(), vk::AccessFlags::TRANSFER_WRITE, vk::PipelineStageFlags::TOP_OF_PIPE, vk::PipelineStageFlags::TRANSFER);
            let blit = vk::ImageBlit::default()
                .src_subresource(layers)
                .src_offsets([vk::Offset3D { x: 0, y: 0, z: 0 }, vk::Offset3D { x: extent.width as i32, y: extent.height as i32, z: 1 }])
                .dst_subresource(layers)
                .dst_offsets([vk::Offset3D { x: 0, y: 0, z: 0 }, vk::Offset3D { x: extent.width as i32, y: extent.height as i32, z: 1 }]);
            d.cmd_blit_image(cmd, swap.out.0, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, sc_image, vk::ImageLayout::TRANSFER_DST_OPTIMAL, &[blit], vk::Filter::NEAREST);
            // ESC tune-menu overlay (panel, or the hamburger icon when closed):
            // CPU-drawn, copied onto the PRESENTED image only — swap.out stays
            // clean, so SHOT/MOVIE/DUMP captures never contain UI. Headless modes
            // skip it entirely.
            if self.harness.shot.is_none() && self.movie.is_none() && self.harness.dump_dir.is_none() {
                let (canvas, mw, mh) = self.menu_canvas();
                let bgra = matches!(self.present.as_ref().unwrap().surface_format.format, vk::Format::B8G8R8A8_UNORM | vk::Format::B8G8R8A8_SRGB);
                let bytes = crate::menu::expand_canvas(&canvas, mw, mh, swap.menu_scale, bgra);
                let (pw, ph) = (mw as u32 * swap.menu_scale, mh as u32 * swap.menu_scale);
                if MENU_MARGIN as u32 + pw <= extent.width && MENU_MARGIN as u32 + ph <= extent.height {
                    self.ctx.upload(&swap.menu_buf, &bytes);
                    let region = vk::BufferImageCopy::default()
                        .image_subresource(layers)
                        .image_offset(vk::Offset3D { x: MENU_MARGIN, y: MENU_MARGIN, z: 0 })
                        .image_extent(vk::Extent3D { width: pw, height: ph, depth: 1 });
                    d.cmd_copy_buffer_to_image(cmd, swap.menu_buf.buffer, sc_image, vk::ImageLayout::TRANSFER_DST_OPTIMAL, &[region]);
                }
            }
        }
        // clip capture: NEAREST blit `out` (still TRANSFER_SRC from the blit
        // above) down to exact game pixels — every texel of an rs x rs block
        // is identical after the integer-NEAREST upscale, so any sample is
        // the game pixel — then copy to the host-visible buffer, collected
        // next frame after the fence wait. Async by construction: no stalls.
        if cap_issue {
            let cap = self.cap.as_ref().unwrap();
            barrier(d, cmd, cap.img.0, vk::ImageLayout::UNDEFINED, vk::ImageLayout::TRANSFER_DST_OPTIMAL, vk::AccessFlags::empty(), vk::AccessFlags::TRANSFER_WRITE, vk::PipelineStageFlags::TOP_OF_PIPE, vk::PipelineStageFlags::TRANSFER);
            let down = vk::ImageBlit::default()
                .src_subresource(layers)
                .src_offsets([vk::Offset3D { x: 0, y: 0, z: 0 }, vk::Offset3D { x: (cap.w as i32) * rs, y: (cap.h as i32) * rs, z: 1 }])
                .dst_subresource(layers)
                .dst_offsets([vk::Offset3D { x: 0, y: 0, z: 0 }, vk::Offset3D { x: cap.w as i32, y: cap.h as i32, z: 1 }]);
            d.cmd_blit_image(cmd, swap.out.0, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, cap.img.0, vk::ImageLayout::TRANSFER_DST_OPTIMAL, &[down], vk::Filter::NEAREST);
            barrier(d, cmd, cap.img.0, vk::ImageLayout::TRANSFER_DST_OPTIMAL, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, vk::AccessFlags::TRANSFER_WRITE, vk::AccessFlags::TRANSFER_READ, vk::PipelineStageFlags::TRANSFER, vk::PipelineStageFlags::TRANSFER);
            let region = vk::BufferImageCopy::default().image_subresource(layers).image_extent(vk::Extent3D { width: cap.w, height: cap.h, depth: 1 });
            d.cmd_copy_image_to_buffer(cmd, cap.img.0, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, cap.buf.buffer, &[region]);
            // make the buffer write visible to the host read after the fence
            d.cmd_pipeline_barrier(cmd, vk::PipelineStageFlags::TRANSFER, vk::PipelineStageFlags::HOST, vk::DependencyFlags::empty(), &[vk::MemoryBarrier::default().src_access_mask(vk::AccessFlags::TRANSFER_WRITE).dst_access_mask(vk::AccessFlags::HOST_READ)], &[], &[]);
        }
        // out back to GENERAL for next frame; swapchain -> PRESENT
        barrier(d, cmd, swap.out.0, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, vk::ImageLayout::GENERAL, vk::AccessFlags::TRANSFER_READ, vk::AccessFlags::SHADER_WRITE, vk::PipelineStageFlags::TRANSFER, vk::PipelineStageFlags::COMPUTE_SHADER);
        if let Some(sc_image) = sc_image {
            barrier(d, cmd, sc_image, vk::ImageLayout::TRANSFER_DST_OPTIMAL, vk::ImageLayout::PRESENT_SRC_KHR, vk::AccessFlags::TRANSFER_WRITE, vk::AccessFlags::empty(), vk::PipelineStageFlags::TRANSFER, vk::PipelineStageFlags::BOTTOM_OF_PIPE);
        }

        d.end_command_buffer(cmd).unwrap();

        let cmds = [cmd];
        let ok = match (&self.present, idx) {
            (Some(p), Some(idx)) => {
                let wait = [p.image_available];
                let wait_stage = [vk::PipelineStageFlags::COMPUTE_SHADER];
                let sig = [swap.render_finished[idx as usize]];
                d.queue_submit(self.ctx.queue, &[vk::SubmitInfo::default().wait_semaphores(&wait).wait_dst_stage_mask(&wait_stage).command_buffers(&cmds).signal_semaphores(&sig)], self.in_flight).unwrap();

                let swapchains = [swap.swapchain];
                let indices = [idx];
                let present = vk::PresentInfoKHR::default().wait_semaphores(&sig).swapchains(&swapchains).image_indices(&indices);
                match p.swapchain_loader.queue_present(self.ctx.queue, &present) {
                    Ok(false) => true,
                    Ok(true) | Err(vk::Result::ERROR_OUT_OF_DATE_KHR) => false,
                    Err(e) => panic!("present: {e:?}"),
                }
            }
            // headless: nothing presents — the in-flight fence is the only sync
            _ => {
                d.queue_submit(self.ctx.queue, &[vk::SubmitInfo::default().command_buffers(&cmds)], self.in_flight).unwrap();
                true
            }
        };

        self.player.dirty = false;
        self.frame = self.frame.wrapping_add(1);

        // CPU frame-time (how long draw() blocks the main thread)
        let cpu_ms = now.elapsed().as_secs_f32() * 1000.0;
        if self.cfg.timing {
            let wait_ms = (t_acq - now).as_secs_f32() * 1000.0;
            println!("TIME f={:04} total={:6.2}ms wait={:6.2} record+present={:6.2} rot={}", self.frame, cpu_ms, wait_ms, cpu_ms - wait_ms, self.view.rot.is_some());
        }
        self.frame_time_sum += cpu_ms;
        if let Some(limit) = self.cfg.frames_limit {
            if self.frame >= limit {
                d.device_wait_idle().unwrap();
                println!("FRAMES={limit}: avg CPU frame {:.2}ms", self.frame_time_sum / limit as f32);
                self.exit_requested = true;
            }
        }

        // harness outputs: DUMP frame collection, the scripted movie, SHOT
        self.harness_post_frame();

        ok
    }
}
