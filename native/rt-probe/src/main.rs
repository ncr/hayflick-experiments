//! Headless Vulkan hardware-RT tool: beauty stills, orbit sequences, and a
//! dynamic-rebuild perf benchmark on a real GLTF scene. Shared GPU/scene/camera
//! plumbing lives in `lib.rs`; the interactive window is `bin/viewer.rs`.

use ash::vk;
use rt_probe::*;
use std::ffi::{c_char, CStr, CString};

/// Clear the accum image, accumulate `dispatches` passes at the low-res buffer
/// size (`low_w × low_h`), tonemap, then **integer-NEAREST upscale by `scale`**
/// (the pixel-perfect output rule) and write the PNG at `out`.
#[allow(clippy::too_many_arguments)]
unsafe fn render_frame(
    ctx: &Ctx,
    image: vk::Image,
    readback: &Buffer,
    pipeline: vk::Pipeline,
    pipeline_layout: vk::PipelineLayout,
    set: vk::DescriptorSet,
    push: &mut Push,
    dispatches: u32,
    exposure: f32,
    low_w: u32,
    low_h: u32,
    scale: u32,
    out: &str,
) {
    let range = vk::ImageSubresourceRange { aspect_mask: vk::ImageAspectFlags::COLOR, base_mip_level: 0, level_count: 1, base_array_layer: 0, layer_count: 1 };
    ctx.one_time(|cmd| {
        barrier(&ctx.device, cmd, image, vk::ImageLayout::UNDEFINED, vk::ImageLayout::GENERAL, vk::AccessFlags::empty(), vk::AccessFlags::TRANSFER_WRITE, vk::PipelineStageFlags::TOP_OF_PIPE, vk::PipelineStageFlags::TRANSFER);
        ctx.device.cmd_clear_color_image(cmd, image, vk::ImageLayout::GENERAL, &vk::ClearColorValue { float32: [0.0; 4] }, &[range]);
    });
    for d in 0..dispatches {
        push.misc2[0] = d as i32;
        ctx.one_time(|cmd| {
            ctx.device.cmd_bind_pipeline(cmd, vk::PipelineBindPoint::COMPUTE, pipeline);
            ctx.device.cmd_bind_descriptor_sets(cmd, vk::PipelineBindPoint::COMPUTE, pipeline_layout, 0, &[set], &[]);
            let bytes = std::slice::from_raw_parts((push as *const Push) as *const u8, std::mem::size_of::<Push>());
            ctx.device.cmd_push_constants(cmd, pipeline_layout, vk::ShaderStageFlags::COMPUTE, 0, bytes);
            ctx.device.cmd_dispatch(cmd, low_w.div_ceil(8), low_h.div_ceil(8), 1);
        });
    }
    ctx.one_time(|cmd| {
        barrier(&ctx.device, cmd, image, vk::ImageLayout::GENERAL, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, vk::AccessFlags::SHADER_WRITE, vk::AccessFlags::TRANSFER_READ, vk::PipelineStageFlags::COMPUTE_SHADER, vk::PipelineStageFlags::TRANSFER);
        let region = vk::BufferImageCopy::default().image_subresource(vk::ImageSubresourceLayers { aspect_mask: vk::ImageAspectFlags::COLOR, mip_level: 0, base_array_layer: 0, layer_count: 1 }).image_extent(vk::Extent3D { width: low_w, height: low_h, depth: 1 });
        ctx.device.cmd_copy_image_to_buffer(cmd, image, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, readback.buffer, &[region]);
    });
    let n = (low_w * low_h) as usize;
    let ptr = ctx.device.map_memory(readback.memory, 0, (n * 16) as u64, vk::MemoryMapFlags::empty()).unwrap() as *const f32;
    let floats = std::slice::from_raw_parts(ptr, n * 4);
    // resolve HDR -> 8-bit at low res (accum already holds the per-pixel mean)
    let mut low = vec![0u8; n * 4];
    for i in 0..n {
        for c in 0..3 {
            let mut v = floats[i * 4 + c] * exposure;
            v = v / (v + 1.0);
            v = v.powf(1.0 / 2.2);
            low[i * 4 + c] = (v.clamp(0.0, 1.0) * 255.0) as u8;
        }
        low[i * 4 + 3] = 255;
    }
    ctx.device.unmap_memory(readback.memory);

    // integer NEAREST upscale: one low-res texel -> scale×scale output block
    let (ow, oh) = (low_w * scale, low_h * scale);
    let mut big = vec![0u8; (ow * oh * 4) as usize];
    for y in 0..oh {
        let sy = y / scale;
        for x in 0..ow {
            let sx = x / scale;
            let s = ((sy * low_w + sx) * 4) as usize;
            let d = ((y * ow + x) * 4) as usize;
            big[d..d + 4].copy_from_slice(&low[s..s + 4]);
        }
    }
    let f = std::fs::File::create(out).unwrap();
    let mut enc = png::Encoder::new(std::io::BufWriter::new(f), ow, oh);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header().unwrap().write_image_data(&big).unwrap();
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    unsafe { run() }
}

unsafe fn run() -> Result<(), Box<dyn std::error::Error>> {
    println!("loading scene...");
    let scene = build_scene()?;
    println!(
        "scene: {} primitives, {} verts, {} tris, {} materials, {} textures, bbox {:?}..{:?}",
        scene.primitives.len(),
        scene.vertices.len(),
        scene.indices.len() / 3,
        scene.materials.len(),
        scene.images.len(),
        scene.min,
        scene.max
    );
    for (i, m) in scene.materials.iter().enumerate() {
        eprintln!("  mat {i}: base {:?} tex {} metal {:.2} rough {:.2} emis {:?}", m.base_color, m.tex_index, m.metallic, m.roughness, m.emissive);
    }
    if std::env::var("DUMP_TEX").is_ok() {
        for (i, im) in scene.images.iter().enumerate() {
            let f = std::fs::File::create(format!("tex_{i}.png")).unwrap();
            let mut e = png::Encoder::new(std::io::BufWriter::new(f), im.width, im.height);
            e.set_color(png::ColorType::Rgba);
            e.set_depth(png::BitDepth::Eight);
            e.write_header().unwrap().write_image_data(&im.pixels).unwrap();
        }
        eprintln!("  dumped {} textures", scene.images.len());
    }

    let entry = ash::Entry::load()?;
    let validation = CString::new("VK_LAYER_KHRONOS_validation").unwrap();
    let have_val = entry.enumerate_instance_layer_properties()?.iter().any(|l| (CStr::from_ptr(l.layer_name.as_ptr())) == validation.as_c_str());
    let mut layers: Vec<*const c_char> = Vec::new();
    let mut iexts: Vec<*const c_char> = Vec::new();
    if have_val {
        layers.push(validation.as_ptr());
        iexts.push(ash::ext::debug_utils::NAME.as_ptr());
    }
    let app = vk::ApplicationInfo::default().api_version(vk::API_VERSION_1_3);
    let instance = entry.create_instance(&vk::InstanceCreateInfo::default().application_info(&app).enabled_layer_names(&layers).enabled_extension_names(&iexts), None)?;
    let du = have_val.then(|| ash::ext::debug_utils::Instance::new(&entry, &instance));
    let messenger = du.as_ref().map(|d| {
        d.create_debug_utils_messenger(
            &vk::DebugUtilsMessengerCreateInfoEXT::default()
                .message_severity(vk::DebugUtilsMessageSeverityFlagsEXT::WARNING | vk::DebugUtilsMessageSeverityFlagsEXT::ERROR)
                .message_type(vk::DebugUtilsMessageTypeFlagsEXT::VALIDATION | vk::DebugUtilsMessageTypeFlagsEXT::GENERAL | vk::DebugUtilsMessageTypeFlagsEXT::PERFORMANCE)
                .pfn_user_callback(Some(debug_callback)),
            None,
        )
        .unwrap()
    });

    let req_exts = [ash::khr::acceleration_structure::NAME, ash::khr::ray_query::NAME, ash::khr::deferred_host_operations::NAME];
    let (pdev, qf) = instance
        .enumerate_physical_devices()?
        .iter()
        .find_map(|&pd| {
            let exts = instance.enumerate_device_extension_properties(pd).ok()?;
            if !req_exts.iter().all(|r| exts.iter().any(|e| (CStr::from_ptr(e.extension_name.as_ptr())) == *r)) {
                return None;
            }
            let q = instance.get_physical_device_queue_family_properties(pd).iter().position(|q| q.queue_flags.contains(vk::QueueFlags::COMPUTE))?;
            Some((pd, q as u32))
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
    let ctx = Ctx { device, as_dev, queue, pool, mem_props, timestamp_period: props.limits.timestamp_period, ext_mem_fd: None };
    println!("device: {}\n", CStr::from_ptr(props.device_name.as_ptr()).to_string_lossy());

    // ---- upload scene + build acceleration structures + pipeline ----
    let gpu = SceneGpu::build(&ctx, &scene)?;
    println!("built {} BLAS + TLAS ({} instances)\n", gpu.blas_list.len(), gpu.n_inst);

    // ---- pixel-perfect low-res buffer (ISO_VIEW_CONTRACT) ----
    let orbit = std::env::var("ORBIT").is_ok();
    let (low_w, low_h) = iso_frame_size(&scene, orbit, 8);
    let scale: u32 = std::env::var("SCALE").ok().and_then(|s| s.parse().ok()).unwrap_or(4).max(1);
    let (image, img_mem, view) = make_storage_image(&ctx, low_w, low_h, vk::Format::R32G32B32A32_SFLOAT);
    // albedo/normal G-buffers: required trace bindings (denoise guides; unused here)
    let (aux_a, _aux_a_mem, aux_a_view) = make_storage_image(&ctx, low_w, low_h, vk::Format::R32G32B32A32_SFLOAT);
    let (aux_n, _aux_n_mem, aux_n_view) = make_storage_image(&ctx, low_w, low_h, vk::Format::R32G32B32A32_SFLOAT);
    let (aux_p, _aux_p_mem, aux_p_view) = make_storage_image(&ctx, low_w, low_h, vk::Format::R32G32B32A32_SFLOAT);
    ctx.one_time(|cmd| {
        for img in [aux_a, aux_n, aux_p] {
            barrier(&ctx.device, cmd, img, vk::ImageLayout::UNDEFINED, vk::ImageLayout::GENERAL, vk::AccessFlags::empty(), vk::AccessFlags::SHADER_WRITE, vk::PipelineStageFlags::TOP_OF_PIPE, vk::PipelineStageFlags::COMPUTE_SHADER);
        }
    });
    let desc_pool = make_pool(&ctx, gpu.texes.len() as u32);
    let set = make_set(&ctx, gpu.set_layout, desc_pool, gpu.tlas, view, aux_a_view, aux_n_view, aux_p_view, &gpu.vbuf, &gpu.ibuf, &gpu.gbuf, &gpu.mbuf, &gpu.lbuf, &gpu.probe_buf, &gpu.texes, gpu.sampler);

    let readback = ctx.create_buffer((low_w * low_h * 16) as u64, vk::BufferUsageFlags::TRANSFER_DST, vk::MemoryPropertyFlags::HOST_VISIBLE | vk::MemoryPropertyFlags::HOST_COHERENT);
    let exposure: f32 = std::env::var("EXPOSURE").ok().and_then(|s| s.parse().ok()).unwrap_or(0.85);
    let debug_albedo = std::env::var("DEBUG_ALBEDO").is_ok() as i32;
    // AA=1 jitters primary rays (soft photoreal edges); default is pixel-centre
    // sampling = the crisp low-res game look.
    let aa = std::env::var("AA").is_ok() as i32;

    // Frame list: an orbit sequence (ORBIT=1) or a single still. The value is a
    // yaw offset; iso_camera adds the contract's base yaw (π/4) internally.
    let frames: Vec<(f32, String)> = if orbit {
        let n: u32 = std::env::var("FRAMES").ok().and_then(|s| s.parse().ok()).unwrap_or(120);
        std::fs::create_dir_all("frames").ok();
        (0..n).map(|i| (360.0 * i as f32 / n as f32, format!("frames/f_{i:04}.png"))).collect()
    } else {
        vec![(0.0, std::env::var("OUT").unwrap_or_else(|_| "beauty.png".into()))]
    };
    let dispatches = if orbit {
        std::env::var("ORBIT_DISPATCHES").ok().and_then(|s| s.parse().ok()).unwrap_or(24u32)
    } else {
        DISPATCHES
    };

    println!(
        "pixel-perfect iso: low-res {low_w}x{low_h} @ R={ISO_R:.3} lowpx/wu  ->  x{scale} NEAREST = {}x{}  ({} spp, {BOUNCES} bounces)",
        low_w * scale, low_h * scale, SPP_PER * dispatches as i32
    );
    let t0 = std::time::Instant::now();
    for (az, out) in &frames {
        let mut push = iso_camera(&scene, low_w, low_h, *az);
        push.misc2[1] = debug_albedo;
        push.misc2[2] = aa;
        push.misc2[3] = gpu.light_count as i32;
        render_frame(&ctx, image, &readback, gpu.pipeline, gpu.pipeline_layout, set, &mut push, dispatches, exposure, low_w, low_h, scale, out);
    }
    println!("  {} frame(s) in {:.2}s{}\n", frames.len(), t0.elapsed().as_secs_f32(), if orbit { " -> frames/" } else { "" });

    // ---- dynamic perf on the real scene (480x270, TLAS rebuild + trace) ----
    let query_pool = ctx.device.create_query_pool(&vk::QueryPoolCreateInfo::default().query_type(vk::QueryType::TIMESTAMP).query_count(3), None)?;
    let (pimg, pmem, pview) = make_storage_image(&ctx, 480, 270, vk::Format::R32G32B32A32_SFLOAT);
    let (paux_a, _paux_a_mem, paux_a_view) = make_storage_image(&ctx, 480, 270, vk::Format::R32G32B32A32_SFLOAT);
    let (paux_n, _paux_n_mem, paux_n_view) = make_storage_image(&ctx, 480, 270, vk::Format::R32G32B32A32_SFLOAT);
    let (paux_p, _paux_p_mem, paux_p_view) = make_storage_image(&ctx, 480, 270, vk::Format::R32G32B32A32_SFLOAT);
    let ppool = make_pool(&ctx, gpu.texes.len() as u32);
    let pset = make_set(&ctx, gpu.set_layout, ppool, gpu.tlas, pview, paux_a_view, paux_n_view, paux_p_view, &gpu.vbuf, &gpu.ibuf, &gpu.gbuf, &gpu.mbuf, &gpu.lbuf, &gpu.probe_buf, &gpu.texes, gpu.sampler);
    ctx.one_time(|cmd| {
        for img in [pimg, paux_a, paux_n, paux_p] {
            barrier(&ctx.device, cmd, img, vk::ImageLayout::UNDEFINED, vk::ImageLayout::GENERAL, vk::AccessFlags::empty(), vk::AccessFlags::SHADER_WRITE, vk::PipelineStageFlags::TOP_OF_PIPE, vk::PipelineStageFlags::COMPUTE_SHADER);
        }
    });
    let mut perf_push = iso_camera(&scene, 480, 270, 0.0);
    perf_push.misc2[3] = gpu.light_count as i32;
    perf_push.misc[3] = 4; // spp
    let mut sum_tlas = 0.0f64;
    let mut sum_trace = 0.0f64;
    let frames = 120u32;
    for f in 0..(frames + 10) {
        ctx.one_time(|cmd| {
            ctx.device.cmd_reset_query_pool(cmd, query_pool, 0, 3);
            ctx.device.cmd_write_timestamp(cmd, vk::PipelineStageFlags::TOP_OF_PIPE, query_pool, 0);
            // rebuild TLAS (dynamic-instance cost on the real instance count)
            let geos = [tlas_geometry(gpu.inst_buf.address)];
            let b = vk::AccelerationStructureBuildGeometryInfoKHR::default().ty(vk::AccelerationStructureTypeKHR::TOP_LEVEL).flags(vk::BuildAccelerationStructureFlagsKHR::PREFER_FAST_TRACE).mode(vk::BuildAccelerationStructureModeKHR::BUILD).geometries(&geos).dst_acceleration_structure(gpu.tlas).scratch_data(vk::DeviceOrHostAddressKHR { device_address: gpu.tlas_scratch.address });
            let r = vk::AccelerationStructureBuildRangeInfoKHR::default().primitive_count(gpu.n_inst);
            ctx.as_dev.cmd_build_acceleration_structures(cmd, &[b], &[&[r]]);
            ctx.device.cmd_write_timestamp(cmd, vk::PipelineStageFlags::ACCELERATION_STRUCTURE_BUILD_KHR, query_pool, 1);
            ctx.device.cmd_pipeline_barrier(cmd, vk::PipelineStageFlags::ACCELERATION_STRUCTURE_BUILD_KHR, vk::PipelineStageFlags::COMPUTE_SHADER, vk::DependencyFlags::empty(), &[vk::MemoryBarrier::default().src_access_mask(vk::AccessFlags::ACCELERATION_STRUCTURE_WRITE_KHR).dst_access_mask(vk::AccessFlags::ACCELERATION_STRUCTURE_READ_KHR)], &[], &[]);
            ctx.device.cmd_bind_pipeline(cmd, vk::PipelineBindPoint::COMPUTE, gpu.pipeline);
            ctx.device.cmd_bind_descriptor_sets(cmd, vk::PipelineBindPoint::COMPUTE, gpu.pipeline_layout, 0, &[pset], &[]);
            let bytes = std::slice::from_raw_parts((&perf_push as *const Push) as *const u8, std::mem::size_of::<Push>());
            ctx.device.cmd_push_constants(cmd, gpu.pipeline_layout, vk::ShaderStageFlags::COMPUTE, 0, bytes);
            ctx.device.cmd_dispatch(cmd, 480u32.div_ceil(8), 270u32.div_ceil(8), 1);
            ctx.device.cmd_write_timestamp(cmd, vk::PipelineStageFlags::COMPUTE_SHADER, query_pool, 2);
        });
        let mut ts = [0u64; 3];
        ctx.device.get_query_pool_results(query_pool, 0, &mut ts, vk::QueryResultFlags::TYPE_64 | vk::QueryResultFlags::WAIT)?;
        if f >= 10 {
            sum_tlas += ts[1].wrapping_sub(ts[0]) as f64 * ctx.timestamp_period as f64 / 1e6;
            sum_trace += ts[2].wrapping_sub(ts[1]) as f64 * ctx.timestamp_period as f64 / 1e6;
        }
    }
    let tlas_ms = sum_tlas / frames as f64;
    let trace_ms = sum_trace / frames as f64;
    println!("REAL-SCENE dynamic perf @480x270, 4spp, {BOUNCES} bounces:");
    println!("  TLAS rebuild ({} instances): {tlas_ms:.4} ms", gpu.n_inst);
    println!("  trace:                          {trace_ms:.4} ms");
    println!("  total per frame:                {:.4} ms  ({:.0} fps)", tlas_ms + trace_ms, 1000.0 / (tlas_ms + trace_ms));

    // ---- teardown ----
    ctx.device.device_wait_idle()?;
    ctx.device.destroy_query_pool(query_pool, None);
    ctx.device.destroy_image_view(pview, None);
    ctx.device.destroy_image(pimg, None);
    ctx.device.free_memory(pmem, None);
    ctx.device.destroy_descriptor_pool(ppool, None);
    ctx.destroy_buffer(&readback);
    ctx.device.destroy_image_view(view, None);
    ctx.device.destroy_image(image, None);
    ctx.device.free_memory(img_mem, None);
    ctx.device.destroy_descriptor_pool(desc_pool, None);
    gpu.destroy(&ctx);
    ctx.device.destroy_command_pool(ctx.pool, None);
    ctx.device.destroy_device(None);
    if let (Some(d), Some(m)) = (&du, messenger) {
        d.destroy_debug_utils_messenger(m, None);
    }
    instance.destroy_instance(None);
    Ok(())
}
