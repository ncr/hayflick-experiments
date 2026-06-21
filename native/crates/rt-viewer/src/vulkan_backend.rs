//! `VulkanBackend` — the GPU half of the renderer on hardware ray-query
//! (NVIDIA/desktop). Owns the Vulkan device + presentation, the `SceneGpu`
//! (geometry/AS/pipelines/probe cache), the tonemap pipeline, and the clip
//! capture target. Implements `RenderBackend`; `Viewer` drives it.
//!
//! The frame is DETERMINISTIC end to end: stream this frame's light values
//! (practicals + flashlight slot), rebuild the TLAS if a mover moved, one
//! shade.comp dispatch (pure function of scene + camera), tonemap with the
//! integer-NEAREST upscale, blit, present. No accumulation, no denoiser, no
//! temporal state — a fixed camera produces bit-identical frames.

use crate::backend::{build_tone_push, FramePresent, RenderBackend};
use crate::menu::{HUD_H, HUD_W, MENU_MARGIN, MPANEL_H, MPANEL_W};
use ash::vk;
use glam::Vec2;
use raw_window_handle::{HasDisplayHandle, HasWindowHandle};
use rt_probe::*;
use std::ffi::{c_char, CStr, CString};
use winit::window::Window;

pub const MARGIN: u32 = 32; // low-res overscan border so pan/zoom never reveal edge bars

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
    pub hud_buf: Buffer,  // host-visible staging for the corner score HUD (overlay-only)
    pub menu_scale: u32,  // integer UI scale (from window height; pixel font stays readable)
    pub scene_pool: vk::DescriptorPool,
    pub scene_set: vk::DescriptorSet,
    pub tone_pool: vk::DescriptorPool,
    pub tone_set: vk::DescriptorSet,
    // one render-finished semaphore per swapchain image (avoids reuse hazard)
    pub render_finished: Vec<vk::Semaphore>,
}

/// Presentation half: surface + swapchain machinery. `None` for headless SHOT
/// captures — the backend then draws into the offscreen `out` image only and
/// the in-flight fence is the only synchronisation.
pub struct Present {
    pub surface_loader: ash::khr::surface::Instance,
    pub surface: vk::SurfaceKHR,
    pub swapchain_loader: ash::khr::swapchain::Device,
    pub surface_format: vk::SurfaceFormatKHR,
    pub present_mode: vk::PresentModeKHR,
    pub image_available: vk::Semaphore,
}

/// Persistent GPU-side clip-capture target: `out` (already in TRANSFER_SRC for
/// the swapchain blit) is NEAREST-blitted down to exact game pixels into `img`,
/// then copied into the host-visible `buf` — all inside the frame's own command
/// buffer. The CPU reads `buf` on the NEXT draw, after the in-flight fence
/// (`collect_pending_capture`), so recording never blocks the loop.
pub struct Cap {
    pub img: (vk::Image, vk::DeviceMemory, vk::ImageView),
    pub buf: Buffer,
    pub w: u32,
    pub h: u32,
    pub pending: bool, // a capture was recorded this frame; collect after the fence
}

pub struct VulkanBackend {
    // ---- Vulkan device & presentation (underscore fields: kept alive only)
    pub _entry: ash::Entry,
    pub _instance: ash::Instance,
    pub pdev: vk::PhysicalDevice,
    pub ctx: Ctx,
    pub present: Option<Present>,
    pub cmd: vk::CommandBuffer,
    pub in_flight: vk::Fence,
    pub swap: Option<Swap>,
    // ---- scene GPU resources + resolved lighting environment
    pub gpu: SceneGpu,
    pub env0: [f32; 4],
    // ---- tonemap pipeline (window-independent)
    pub tone_set_layout: vk::DescriptorSetLayout,
    pub tone_pipeline_layout: vk::PipelineLayout,
    pub tone_pipeline: vk::Pipeline,
    pub _tone_shader: vk::ShaderModule,
    // ---- render scale baseline + clip capture target
    pub base_scale: u32, // integer render scale at zoom=1 (the DPR baseline, #2/#4)
    pub cap: Option<Cap>,
}

impl VulkanBackend {
    /// `window: None` runs fully headless (SHOT captures): no surface, no
    /// swapchain device extension, no present-capable queue required — the
    /// offscreen extent is taken verbatim from `WINDOW` so capture sizes are
    /// reproducible regardless of what a window manager would grant.
    pub unsafe fn new(window: Option<&Window>, scene: &Scene, cfg: &Config) -> Result<VulkanBackend, Box<dyn std::error::Error>> {
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

        // scene GPU resources + acceleration structures + the resolved lighting
        // environment. The scene itself is owned by the Viewer (orchestration);
        // the backend only consumes it to build geometry/AS/lights.
        let gpu = SceneGpu::build(&ctx, scene, cfg.render.probe_spacing)?;
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
        let tone_push = [vk::PushConstantRange::default().stage_flags(vk::ShaderStageFlags::COMPUTE).offset(0).size(std::mem::size_of::<crate::backend::TonePush>() as u32)];
        let tone_pipeline_layout = ctx.device.create_pipeline_layout(&vk::PipelineLayoutCreateInfo::default().set_layouts(&tone_sl).push_constant_ranges(&tone_push), None)?;
        let tone_code = ash::util::read_spv(&mut std::io::Cursor::new(TONE_SPV))?; // rt_probe::TONE_SPV — shaders build in rt-probe
        let tone_shader = ctx.device.create_shader_module(&vk::ShaderModuleCreateInfo::default().code(&tone_code), None)?;
        let tone_name = CString::new("main").unwrap();
        let tone_pipeline = ctx
            .device
            .create_compute_pipelines(vk::PipelineCache::null(), &[vk::ComputePipelineCreateInfo::default().stage(vk::PipelineShaderStageCreateInfo::default().stage(vk::ShaderStageFlags::COMPUTE).module(tone_shader).name(&tone_name)).layout(tone_pipeline_layout)], None)
            .map_err(|(_, e)| e)?[0];

        let cmd = ctx.device.allocate_command_buffers(&vk::CommandBufferAllocateInfo::default().command_pool(pool).level(vk::CommandBufferLevel::PRIMARY).command_buffer_count(1))?[0];
        let in_flight = ctx.device.create_fence(&vk::FenceCreateInfo::default().flags(vk::FenceCreateFlags::SIGNALED), None)?;

        let mut b = VulkanBackend {
            _entry: entry,
            _instance: instance,
            pdev,
            ctx,
            present,
            cmd,
            in_flight,
            swap: None,
            gpu,
            env0,
            tone_set_layout,
            tone_pipeline_layout,
            tone_pipeline,
            _tone_shader: tone_shader,
            base_scale: cfg.render.pixel,
            cap: None,
        };

        // windowed: whatever inner size the WM actually granted; headless: the
        // WINDOW request verbatim — identical extent math from there on
        let (w0, h0) = match window {
            Some(w) => (w.inner_size().width, w.inner_size().height),
            None => cfg.harness.window.unwrap_or((1280, 800)),
        };
        b.recreate_gpu(w0.max(1), h0.max(1));
        // bake the GI probe cache (blocking, once — both light banks)
        let set = b.swap.as_ref().unwrap().scene_set;
        b.gpu.bake_probes(&b.ctx, set, b.env0, cfg.render.probe_rays);
        Ok(b)
    }

    /// (Re)build the swapchain and all window-size-dependent GPU resources.
    /// Pure GPU — the Viewer re-centres pan after calling this.
    pub unsafe fn recreate_gpu(&mut self, win_w: u32, win_h: u32) {
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
        let hud_buf = self.ctx.create_buffer(
            (HUD_W * HUD_H) as u64 * (menu_scale as u64 * menu_scale as u64) * 4,
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

        self.swap = Some(Swap { swapchain, extent, images, low_w, low_h, color, albedo, posg, out, menu_buf, hud_buf, menu_scale, scene_pool, scene_set, tone_pool, tone_set, render_finished });
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
        self.ctx.destroy_buffer(&s.hud_buf);
        if let Some(p) = &self.present {
            p.swapchain_loader.destroy_swapchain(s.swapchain, None);
        }
    }

    unsafe fn destroy_cap(&self, c: Cap) {
        let d = &self.ctx.device;
        d.destroy_image_view(c.img.2, None);
        d.destroy_image(c.img.0, None);
        d.free_memory(c.img.1, None);
        self.ctx.destroy_buffer(&c.buf);
    }
}

impl RenderBackend for VulkanBackend {
    fn handles(&self) -> &SceneHandles {
        &self.gpu.handles
    }
    fn light_count(&self) -> u32 {
        self.gpu.light_count
    }

    fn rs(&self, zoom: f32) -> i32 {
        render_scale(zoom, self.base_scale)
    }

    fn low_and_vis(&self, zoom: f32) -> (Vec2, Vec2) {
        let swap = self.swap.as_ref().unwrap();
        let rs = self.rs(zoom) as f32;
        let low = Vec2::new(swap.low_w as f32, swap.low_h as f32);
        let vis = Vec2::new((swap.extent.width as f32 / rs).ceil(), (swap.extent.height as f32 / rs).ceil());
        (low, vis)
    }

    fn low_dims(&self) -> (u32, u32) {
        let s = self.swap.as_ref().unwrap();
        (s.low_w, s.low_h)
    }

    fn extent(&self) -> (u32, u32) {
        let e = self.swap.as_ref().unwrap().extent;
        (e.width, e.height)
    }

    fn menu_scale(&self) -> u32 {
        self.swap.as_ref().map(|s| s.menu_scale).unwrap_or(2)
    }

    fn has_target(&self) -> bool {
        self.swap.is_some()
    }

    unsafe fn recreate(&mut self, w: u32, h: u32) {
        self.recreate_gpu(w, h);
    }

    unsafe fn wait_idle(&self) {
        self.ctx.device.device_wait_idle().unwrap();
    }

    /// Render + (windowed) present one frame. The GPU half of the old
    /// `Renderer::draw`, from the fence wait onward — moved verbatim so the
    /// command sequence/barriers (and thus the golden bytes) are unchanged.
    unsafe fn render_present(&mut self, fp: &FramePresent) -> bool {
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

        let (low_w, low_h, extent) = (swap.low_w, swap.low_h, swap.extent);
        let sc_image = idx.map(|i| swap.images[i as usize]);

        d.reset_command_buffer(self.cmd, vk::CommandBufferResetFlags::empty()).unwrap();
        d.begin_command_buffer(self.cmd, &vk::CommandBufferBeginInfo::default().flags(vk::CommandBufferUsageFlags::ONE_TIME_SUBMIT)).unwrap();
        let cmd = self.cmd;

        // This frame's scene-state update (lights → mover instances → TLAS
        // refit iff dirty), then the deterministic shade dispatch.
        self.gpu.record_frame(&self.ctx, cmd, fp.fs);
        let light_count = self.gpu.light_count as i32 + self.gpu.n_spot_active as i32;
        let mut push = ShadePush::new(&fp.fs.cam, low_w, low_h, self.env0, fp.fs.room_lights, light_count, fp.ao, fp.ao_r, fp.ao_n, fp.debug);
        if let Some(roi) = &fp.roi {
            let rp = rt_probe::roi_push(&fp.fs.cam, low_w as i32, low_h as i32, roi.player, roi.radius_px, roi.falloff_px, roi.ghost);
            push.roi = rp.roi;
            push.roi2 = rp.roi2;
        }
        d.cmd_bind_pipeline(cmd, vk::PipelineBindPoint::COMPUTE, self.gpu.shade_pipeline);
        d.cmd_bind_descriptor_sets(cmd, vk::PipelineBindPoint::COMPUTE, self.gpu.pipeline_layout, 0, &[swap.scene_set], &[]);
        d.cmd_push_constants(cmd, self.gpu.pipeline_layout, vk::ShaderStageFlags::COMPUTE, 0, push_bytes(&push));
        d.cmd_dispatch(cmd, low_w.div_ceil(8), low_h.div_ceil(8), 1);
        // radiance write -> tonemap read (same GENERAL layout)
        d.cmd_pipeline_barrier(cmd, vk::PipelineStageFlags::COMPUTE_SHADER, vk::PipelineStageFlags::COMPUTE_SHADER, vk::DependencyFlags::empty(), &[vk::MemoryBarrier::default().src_access_mask(vk::AccessFlags::SHADER_WRITE).dst_access_mask(vk::AccessFlags::SHADER_READ)], &[], &[]);

        // #5: the GPU crop origin is round(pan); the fractional remainder stays
        // on the CPU side so the upscale lattice is always integer-aligned.
        let rs = self.rs(fp.zoom);
        let tp = build_tone_push(low_w, low_h, extent.width, extent.height, rs, fp.pan, fp.target, fp.yaw_deg, fp.exposure, &fp.style, fp.frame);
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
            // pass no overlay.
            if let Some(ov) = &fp.overlay {
                let bgra = matches!(self.present.as_ref().unwrap().surface_format.format, vk::Format::B8G8R8A8_UNORM | vk::Format::B8G8R8A8_SRGB);
                let (canvas, mw, mh) = ov.menu;
                let bytes = crate::menu::expand_canvas(canvas, mw, mh, swap.menu_scale, bgra);
                let (pw, ph) = (mw as u32 * swap.menu_scale, mh as u32 * swap.menu_scale);
                if MENU_MARGIN as u32 + pw <= extent.width && MENU_MARGIN as u32 + ph <= extent.height {
                    self.ctx.upload(&swap.menu_buf, &bytes);
                    let region = vk::BufferImageCopy::default()
                        .image_subresource(layers)
                        .image_offset(vk::Offset3D { x: MENU_MARGIN, y: MENU_MARGIN, z: 0 })
                        .image_extent(vk::Extent3D { width: pw, height: ph, depth: 1 });
                    d.cmd_copy_buffer_to_image(cmd, swap.menu_buf.buffer, sc_image, vk::ImageLayout::TRANSFER_DST_OPTIMAL, &[region]);
                }
                // score HUD: player scenes only, top-right corner (same
                // overlay-only path — never on swap.out, so captures stay UI-free)
                if let Some((canvas, hw, hh)) = ov.score {
                    let bytes = crate::menu::expand_canvas(canvas, hw, hh, swap.menu_scale, bgra);
                    let (pw, ph) = (hw as u32 * swap.menu_scale, hh as u32 * swap.menu_scale);
                    if pw + MENU_MARGIN as u32 <= extent.width && ph + MENU_MARGIN as u32 <= extent.height {
                        self.ctx.upload(&swap.hud_buf, &bytes);
                        let region = vk::BufferImageCopy::default()
                            .image_subresource(layers)
                            .image_offset(vk::Offset3D { x: extent.width as i32 - MENU_MARGIN - pw as i32, y: MENU_MARGIN, z: 0 })
                            .image_extent(vk::Extent3D { width: pw, height: ph, depth: 1 });
                        d.cmd_copy_buffer_to_image(cmd, swap.hud_buf.buffer, sc_image, vk::ImageLayout::TRANSFER_DST_OPTIMAL, &[region]);
                    }
                }
            }
        }
        // clip capture: NEAREST blit `out` (still TRANSFER_SRC from the blit
        // above) down to exact game pixels — every texel of an rs x rs block
        // is identical after the integer-NEAREST upscale, so any sample is
        // the game pixel — then copy to the host-visible buffer, collected
        // next frame after the fence wait. Async by construction: no stalls.
        if fp.capture {
            let (cap_img, cap_buf, cap_w, cap_h) = {
                let cap = self.cap.as_ref().unwrap();
                (cap.img.0, cap.buf.buffer, cap.w, cap.h)
            };
            barrier(d, cmd, cap_img, vk::ImageLayout::UNDEFINED, vk::ImageLayout::TRANSFER_DST_OPTIMAL, vk::AccessFlags::empty(), vk::AccessFlags::TRANSFER_WRITE, vk::PipelineStageFlags::TOP_OF_PIPE, vk::PipelineStageFlags::TRANSFER);
            let down = vk::ImageBlit::default()
                .src_subresource(layers)
                .src_offsets([vk::Offset3D { x: 0, y: 0, z: 0 }, vk::Offset3D { x: (cap_w as i32) * rs, y: (cap_h as i32) * rs, z: 1 }])
                .dst_subresource(layers)
                .dst_offsets([vk::Offset3D { x: 0, y: 0, z: 0 }, vk::Offset3D { x: cap_w as i32, y: cap_h as i32, z: 1 }]);
            d.cmd_blit_image(cmd, swap.out.0, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, cap_img, vk::ImageLayout::TRANSFER_DST_OPTIMAL, &[down], vk::Filter::NEAREST);
            barrier(d, cmd, cap_img, vk::ImageLayout::TRANSFER_DST_OPTIMAL, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, vk::AccessFlags::TRANSFER_WRITE, vk::AccessFlags::TRANSFER_READ, vk::PipelineStageFlags::TRANSFER, vk::PipelineStageFlags::TRANSFER);
            let region = vk::BufferImageCopy::default().image_subresource(layers).image_extent(vk::Extent3D { width: cap_w, height: cap_h, depth: 1 });
            d.cmd_copy_image_to_buffer(cmd, cap_img, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, cap_buf, &[region]);
            // make the buffer write visible to the host read after the fence
            d.cmd_pipeline_barrier(cmd, vk::PipelineStageFlags::TRANSFER, vk::PipelineStageFlags::HOST, vk::DependencyFlags::empty(), &[vk::MemoryBarrier::default().src_access_mask(vk::AccessFlags::TRANSFER_WRITE).dst_access_mask(vk::AccessFlags::HOST_READ)], &[], &[]);
            self.cap.as_mut().unwrap().pending = true;
        }
        // out back to GENERAL for next frame; swapchain -> PRESENT
        barrier(d, cmd, swap.out.0, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, vk::ImageLayout::GENERAL, vk::AccessFlags::TRANSFER_READ, vk::AccessFlags::SHADER_WRITE, vk::PipelineStageFlags::TRANSFER, vk::PipelineStageFlags::COMPUTE_SHADER);
        if let Some(sc_image) = sc_image {
            barrier(d, cmd, sc_image, vk::ImageLayout::TRANSFER_DST_OPTIMAL, vk::ImageLayout::PRESENT_SRC_KHR, vk::AccessFlags::TRANSFER_WRITE, vk::AccessFlags::empty(), vk::PipelineStageFlags::TRANSFER, vk::PipelineStageFlags::BOTTOM_OF_PIPE);
        }

        d.end_command_buffer(cmd).unwrap();

        let cmds = [cmd];
        match (&self.present, idx) {
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
        }
    }

    /// Read back `out` and take every render-scale-th pixel — the exact
    /// low-res game image (the upscale is integer NEAREST). RGBA bytes.
    unsafe fn readback_out_subsampled(&self, rs: i32) -> (u32, u32, Vec<u8>) {
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
        let full = std::slice::from_raw_parts(ptr, n * 4);
        let rs = rs as u32;
        let (sw, sh) = (w / rs, h / rs);
        let mut sub = vec![0u8; (sw * sh * 4) as usize];
        for y in 0..sh {
            for x in 0..sw {
                let src = (((y * rs) * w + x * rs) * 4) as usize;
                let dst = ((y * sw + x) * 4) as usize;
                sub[dst..dst + 4].copy_from_slice(&full[src..src + 4]);
            }
        }
        self.ctx.device.unmap_memory(readback.memory);
        self.ctx.destroy_buffer(&readback);
        (sw, sh, sub)
    }

    /// Dump the `out` image (the exact thing blitted to the swapchain) to a PNG.
    unsafe fn capture_png(&self, path: &str) {
        self.ctx.device.device_wait_idle().unwrap();
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
        crate::capture::write_png(path, w, h, &pixels);
        println!("captured {path} ({w}x{h})");
    }

    fn capture_target_size(&self) -> Option<(u32, u32)> {
        self.cap.as_ref().map(|c| (c.w, c.h))
    }

    unsafe fn ensure_capture_target(&mut self, w: u32, h: u32) {
        if self.cap.as_ref().is_some_and(|c| (c.w, c.h) != (w, h)) {
            // size change with nothing collected yet: refit silently — the
            // Viewer only reaches here after the fence retired the old use.
            let c = self.cap.take().unwrap();
            self.destroy_cap(c);
        }
        if self.cap.is_none() {
            let img = make_storage_image(&self.ctx, w, h, vk::Format::R8G8B8A8_UNORM);
            let buf = self.ctx.create_buffer(
                (w * h * 4) as u64,
                vk::BufferUsageFlags::TRANSFER_DST,
                vk::MemoryPropertyFlags::HOST_VISIBLE | vk::MemoryPropertyFlags::HOST_COHERENT,
            );
            self.cap = Some(Cap { img, buf, w, h, pending: false });
        }
    }

    unsafe fn collect_pending_capture(&mut self) -> Option<(u32, u32, Vec<u8>)> {
        if !self.cap.as_ref().is_some_and(|c| c.pending) {
            return None;
        }
        self.ctx.device.wait_for_fences(&[self.in_flight], true, u64::MAX).unwrap();
        let cap = self.cap.as_mut().unwrap();
        cap.pending = false;
        let n = (cap.w * cap.h) as usize * 4;
        let ptr = self.ctx.device.map_memory(cap.buf.memory, 0, n as u64, vk::MemoryMapFlags::empty()).unwrap() as *const u8;
        let pixels = std::slice::from_raw_parts(ptr, n).to_vec();
        self.ctx.device.unmap_memory(cap.buf.memory);
        Some((cap.w, cap.h, pixels))
    }
}
