//! `MetalBackend` — the GPU half on Apple Silicon (Metal compute ray tracing).
//!
//! The Metal twin of `VulkanBackend`: same `RenderBackend` contract, same
//! deterministic frame (stream this frame's lights → patch mover instances →
//! TLAS refit if dirty → shade → tonemap → present / readback). Geometry,
//! the concatenated scalar buffers, BLAS-per-primitive + TLAS, the two-bank GI
//! probe cache, and the ported `shade.metal` / `probes.metal` / `tonemap.metal`
//! kernels grow directly from the verified `native/spikes/metal-renderer/`.
//!
//! M2 is software RT (Apple8) — intersection runs on shader cores (no dedicated
//! RT block until M3); fine for this workload. Bindless geometry is the
//! concatenated-buffer + offset-table scheme (NOT gpuAddress): the four scalar
//! buffers are indexed by `intersection.instance_id`. Scalar byte-match is
//! load-bearing: `packed_float3` not `float3`; struct sizes asserted both sides.

use crate::backend::{build_tone_push, FramePresent, RenderBackend};
use core_graphics_types::geometry::CGSize;
use glam::{Mat4, Vec2};
use metal::*;
use rt_probe::render::{frame_lights_cpu, scan_lights, LightScan};
use rt_probe::scene::{LoadedImage, Material, Vertex};
use rt_probe::{bake_bank_emission, render_scale, Config, InstanceTable, ProbeGrid, Scene, SceneHandles, ISO_R};
use std::ffi::c_void;
use std::mem::size_of;
use winit::window::Window;

const MARGIN: u32 = 32; // low-res overscan border (mirrors VulkanBackend)

/// Shade push constants — byte-identical to shade.metal's `Push` (the spike
/// layout, NOT the Vulkan ShadePush: this carries `hasProbes` in misc2.y).
#[repr(C)]
#[derive(Clone, Copy)]
struct Push {
    cam_right: [f32; 4], // xyz, w = ortho half-width
    cam_up: [f32; 4],    // xyz, w = ortho half-height
    cam_dir: [f32; 4],   // xyz forward, w = AO radius
    cam_pos: [f32; 4],   // xyz eye, w = AO strength
    misc: [i32; 4],      // W, H, aoRays, debug
    misc2: [i32; 4],     // lightCount, hasProbes, roomLights16, _
    env0: [f32; 4],      // sun, sky, fogD, fogH
    roi: [f32; 4],       // CAVE_ROI: player world xyz + disc radius (low-res px)
    roi2: [f32; 4],      // projected player px xy + disc falloff px + enabled (>0.5)
}

/// Probe-bake push constants — byte-identical to probes.metal's `ProbePush`.
#[repr(C)]
#[derive(Clone, Copy)]
struct ProbePush {
    misc: [i32; 4],  // probeCount, raysTotal, bounces, raysThisBatch
    misc2: [i32; 4], // batchStartRay, bank, lightCount, _
    env0: [f32; 4],
}

/// Window-size-dependent GPU resources (the Metal `Swap`): the low-res G-buffer
/// trio, the 8-bit out texture, the menu scale, and the deferred clip-capture.
struct MetalTarget {
    low_w: u32,
    low_h: u32,
    ext_w: u32,
    ext_h: u32,
    menu_scale: u32,
    radiance: Buffer, // low_w*low_h float4 (shade radiance out)
    albedo: Buffer,   // low_w*low_h float4 (primary-hit albedo G-buffer)
    pos: Buffer,      // low_w*low_h float4 (primary-hit world position)
    out_tex: Texture, // ext_w*ext_h RGBA8Unorm (tonemap out; present + readback source)
    /// Clip capture: the Viewer-requested game-pixel size, and the previous
    /// frame's subsampled readback awaiting collection (deferred one frame).
    cap_size: Option<(u32, u32)>,
    pending_capture: Option<(u32, u32, Vec<u8>)>,
}

pub struct MetalBackend {
    device: Device,
    queue: CommandQueue,
    // geometry + lights (concatenated scalar buffers; Shared so per-frame
    // light/material/instance state is a CPU memcpy between waited frames)
    vbuf: Buffer,
    ibuf: Buffer,
    gbuf: Buffer,
    mbuf: Buffer,
    lbuf: Buffer,
    probe_buf: Buffer,
    probe_count: u32,
    texes: Vec<Texture>,
    blas_list: Vec<AccelerationStructure>,
    tlas: AccelerationStructure,
    tlas_scratch: Buffer,
    inst_buf: Buffer,
    instances: Vec<MTLAccelerationStructureInstanceDescriptor>,
    // pipelines
    shade_pso: ComputePipelineState,
    probe_pso: ComputePipelineState,
    tonemap_pso: ComputePipelineState,
    // resolved env + render scale
    env0: [f32; 4],
    base_scale: u32,
    // per-frame light streaming (CPU shadows of lbuf/mbuf + the per-light link)
    lights_cpu: Vec<[f32; 12]>,
    mats_cpu: Vec<Material>,
    light_link: Vec<(i32, [f32; 3], bool)>,
    light_count: u32,
    flash_idx: usize,
    n_spot_active: u32,
    // movers
    dyn_insts: Vec<(u32, u32)>,
    dyn_shadow: Vec<Mat4>,
    tlas_dirty: bool,
    handles: SceneHandles,
    // window-size resources + present surface
    target: Option<MetalTarget>,
    layer: Option<MetalLayer>,
    probes_baked: bool,
    // GI probe disk cache: enabled only on the interactive (windowed) path so
    // headless capture stays a fresh deterministic bake. `probe_key` is the
    // content hash of the bake inputs (geometry/materials/lights/grid/env/rays).
    probe_cache: bool,
    probe_key: u64,
}

/// glam column-major Mat4 → Metal row-packed 4×3 instance transform.
fn to_packed(m: Mat4) -> [[f32; 3]; 4] {
    let c = m.to_cols_array_2d(); // [col][row]
    [[c[0][0], c[0][1], c[0][2]], [c[1][0], c[1][1], c[1][2]], [c[2][0], c[2][1], c[2][2]], [c[3][0], c[3][1], c[3][2]]]
}

fn make_buf<T: Copy>(device: &Device, data: &[T]) -> Buffer {
    let len = (size_of::<T>() as u64 * data.len() as u64).max(16);
    device.new_buffer_with_data(data.as_ptr() as *const c_void, len, MTLResourceOptions::StorageModeShared)
}

/// Overwrite a StorageModeShared buffer in place (CPU → GPU memcpy). Safe
/// between waited command buffers (no in-flight GPU read).
unsafe fn write_buf<T: Copy>(b: &Buffer, data: &[T]) {
    if data.is_empty() {
        return;
    }
    std::ptr::copy_nonoverlapping(data.as_ptr() as *const u8, b.contents() as *mut u8, std::mem::size_of_val(data));
}

/// Upload an RGBA8 image as a NEAREST-sampled sRGB texture (sampling returns
/// linear, matching the glTF base-colour convention + hex_linear).
fn upload_tex(device: &Device, img: &LoadedImage) -> Texture {
    let desc = TextureDescriptor::new();
    desc.set_texture_type(MTLTextureType::D2);
    desc.set_pixel_format(MTLPixelFormat::RGBA8Unorm_sRGB);
    desc.set_width(img.width as u64);
    desc.set_height(img.height as u64);
    desc.set_storage_mode(MTLStorageMode::Shared);
    desc.set_usage(MTLTextureUsage::ShaderRead);
    let tex = device.new_texture(&desc);
    let region = MTLRegion { origin: MTLOrigin { x: 0, y: 0, z: 0 }, size: MTLSize { width: img.width as u64, height: img.height as u64, depth: 1 } };
    tex.replace_region(region, 0, img.pixels.as_ptr() as *const c_void, img.width as u64 * 4);
    tex
}

/// Build an instance-AS descriptor over the BLAS list + the (mutable) instance
/// descriptor buffer. Rebuilt cheaply each TLAS refit (the descriptor is CPU).
fn tlas_descriptor(blas_list: &[AccelerationStructure], inst_buf: &Buffer, n: u64) -> InstanceAccelerationStructureDescriptor {
    let blas_refs: Vec<&AccelerationStructureRef> = blas_list.iter().map(|b| b.as_ref()).collect();
    let blas_arr = Array::from_slice(&blas_refs);
    let desc = InstanceAccelerationStructureDescriptor::descriptor();
    desc.set_instanced_acceleration_structures(blas_arr);
    desc.set_instance_count(n);
    desc.set_instance_descriptor_buffer(inst_buf);
    desc.set_instance_descriptor_stride(size_of::<MTLAccelerationStructureInstanceDescriptor>() as u64);
    desc.set_instance_descriptor_type(MTLAccelerationStructureInstanceDescriptorType::Default);
    desc.to_owned()
}

impl MetalBackend {
    pub unsafe fn new(window: Option<&Window>, scene: &Scene, cfg: &Config) -> Result<MetalBackend, Box<dyn std::error::Error>> {
        assert_eq!(size_of::<Vertex>(), 32, "Vertex must be 32 B (packed_float3 layout)");
        assert_eq!(size_of::<Material>(), 48, "Material must be 48 B");

        let device = Device::system_default().ok_or("no Metal device")?;
        println!("device: {} (raytracing: {})", device.name(), device.supports_raytracing());
        assert!(device.supports_raytracing(), "Metal device lacks ray tracing");
        let queue = device.new_command_queue();

        // ---- concatenated geometry/material/light buffers
        let vbuf = make_buf(&device, &scene.vertices);
        let ibuf = make_buf(&device, &scene.indices);
        let gbuf = make_buf(&device, &scene.geom_infos());
        let mbuf = make_buf(&device, &scene.materials);
        let LightScan { lights, light_link, names: light_names, light_count, flash_idx } = scan_lights(scene)?;
        let lbuf = make_buf(&device, &lights);
        let lights_cpu = lights.clone();
        let mats_cpu = scene.materials.clone();

        // textures: every scene image NEAREST sRGB; a 1×1 white keeps the
        // bindless array ≥ 1 (never sampled when texIndex == -1)
        let mut texes: Vec<Texture> = scene.images.iter().map(|im| upload_tex(&device, im)).collect();
        if texes.is_empty() {
            texes.push(upload_tex(&device, &LoadedImage { width: 1, height: 1, pixels: vec![255, 255, 255, 255] }));
        }
        let ntex = texes.len();
        println!("scene: {} prims, {} tris, {ntex} textures (metal)", scene.primitives.len(), scene.indices.len() / 3);

        // ---- world-space probe grid (shared with Vulkan via gpu_scene; the
        // frozen-pad form is canonical — the old inline Metal loop re-derived the
        // pad with the widened spacing, which diverged once widening kicked in).
        let grid = ProbeGrid::build(scene.min, scene.max, cfg.render.probe_spacing);
        let probe_count = grid.count;
        let probe_buf = make_buf(&device, &grid.header);
        println!("probes: {}x{}x{} = {probe_count} @ {:.2} wu (metal)", grid.dims[0], grid.dims[1], grid.dims[2], grid.spacing);

        // ---- one BLAS per primitive, sharing the global vertex/index buffers
        let mut blas_list: Vec<AccelerationStructure> = Vec::with_capacity(scene.primitives.len());
        {
            let cb = queue.new_command_buffer();
            let enc = cb.new_acceleration_structure_command_encoder();
            let mut scratches: Vec<Buffer> = Vec::new();
            for p in &scene.primitives {
                let tri = AccelerationStructureTriangleGeometryDescriptor::descriptor();
                tri.set_vertex_buffer(Some(&vbuf));
                tri.set_vertex_buffer_offset(p.vertex_offset as u64 * size_of::<Vertex>() as u64);
                tri.set_vertex_stride(size_of::<Vertex>() as u64);
                tri.set_vertex_format(MTLAttributeFormat::Float3);
                tri.set_index_buffer(Some(&ibuf));
                tri.set_index_buffer_offset(p.index_offset as u64 * 4);
                tri.set_index_type(MTLIndexType::UInt32);
                tri.set_triangle_count((p.index_count / 3) as u64);
                let geom_ref: &AccelerationStructureGeometryDescriptorRef = &tri;
                let geoms = Array::from_slice(&[geom_ref]);
                let desc = PrimitiveAccelerationStructureDescriptor::descriptor();
                desc.set_geometry_descriptors(geoms);
                let desc_ref: &AccelerationStructureDescriptorRef = &desc;
                let sizes = device.acceleration_structure_sizes_with_descriptor(desc_ref);
                let blas = device.new_acceleration_structure_with_size(sizes.acceleration_structure_size);
                let scratch = device.new_buffer(sizes.build_scratch_buffer_size.max(1), MTLResourceOptions::StorageModePrivate);
                enc.build_acceleration_structure(&blas, desc_ref, &scratch, 0);
                blas_list.push(blas);
                scratches.push(scratch);
            }
            enc.end_encoding();
            cb.commit();
            cb.wait_until_completed();
            assert_eq!(cb.status(), MTLCommandBufferStatus::Completed, "BLAS build failed");
        }

        // ---- TLAS: one instance per primitive, instance_id == i == offset row.
        // The build-time masks (0x05 dynamic / 0xff static), the dynamic-run
        // join, and the per-run patch ranges/shadow come from the shared
        // InstanceTable (same source the Vulkan SceneGpu uses). Walls are seen
        // through per-pixel on the primary ray (CAVE_ROI) — no per-yaw hiding.
        let table = InstanceTable::build(scene)?;
        let nprim = scene.primitives.len();
        let instances: Vec<MTLAccelerationStructureInstanceDescriptor> = (0..nprim)
            .map(|i| MTLAccelerationStructureInstanceDescriptor {
                transformation_matrix: to_packed(table.transforms[i]),
                options: MTLAccelerationStructureInstanceOptions::Opaque,
                mask: table.masks[i] as u32,
                intersection_function_table_offset: 0,
                acceleration_structure_index: i as u32,
            })
            .collect();
        let handles = SceneHandles { lights: light_names, instances: table.instances };
        let dyn_insts = table.dyn_insts;
        let dyn_shadow = table.dyn_shadow;
        let inst_buf = make_buf(&device, &instances);

        let tlas_desc = tlas_descriptor(&blas_list, &inst_buf, instances.len() as u64);
        let tsizes = device.acceleration_structure_sizes_with_descriptor(&tlas_desc);
        let tlas = device.new_acceleration_structure_with_size(tsizes.acceleration_structure_size);
        let tlas_scratch = device.new_buffer(tsizes.build_scratch_buffer_size.max(1), MTLResourceOptions::StorageModePrivate);
        {
            let cb = queue.new_command_buffer();
            let enc = cb.new_acceleration_structure_command_encoder();
            enc.build_acceleration_structure(&tlas, &tlas_desc, &tlas_scratch, 0);
            enc.end_encoding();
            cb.commit();
            cb.wait_until_completed();
            assert_eq!(cb.status(), MTLCommandBufferStatus::Completed, "TLAS build failed");
        }

        // ---- compile the three kernels at runtime (the driver compiler).
        let opts = CompileOptions::new();
        opts.set_language_version(MTLLanguageVersion::V3_0);
        // NTEX_COUNT is the bindless array size — injected at compile so it
        // matches exactly the textures bound in the shade pass.
        let shade_src = include_str!("shaders_metal/shade.metal").replace("NTEX_COUNT", &ntex.to_string());
        let shade_lib = device.new_library_with_source(&shade_src, &opts).map_err(|e| format!("shade.metal: {e}"))?;
        let shade_pso = device.new_compute_pipeline_state_with_function(&shade_lib.get_function("shade", None).unwrap()).map_err(|e| format!("shade pso: {e}"))?;
        let probe_lib = device.new_library_with_source(include_str!("shaders_metal/probes.metal"), &opts).map_err(|e| format!("probes.metal: {e}"))?;
        let probe_pso = device.new_compute_pipeline_state_with_function(&probe_lib.get_function("bake_probes", None).unwrap()).map_err(|e| format!("probe pso: {e}"))?;
        let tone_lib = device.new_library_with_source(include_str!("shaders_metal/tonemap.metal"), &opts).map_err(|e| format!("tonemap.metal: {e}"))?;
        let tonemap_pso = device.new_compute_pipeline_state_with_function(&tone_lib.get_function("tonemap", None).unwrap()).map_err(|e| format!("tonemap pso: {e}"))?;

        let env0 = cfg.lighting_env(scene.lighting);

        // content hash of every input the bake reads — the probe-cache filename.
        // Any geometry/material/light/grid/env/ray change (e.g. a palette edit)
        // produces a new key and re-bakes; identical inputs reload from disk.
        let probe_key = rt_probe::probe_cache::content_key(&[
            rt_probe::probe_cache::bytes_of(&scene.vertices),
            rt_probe::probe_cache::bytes_of(&scene.indices),
            rt_probe::probe_cache::bytes_of(&scene.materials),
            rt_probe::probe_cache::bytes_of(&lights_cpu),
            rt_probe::probe_cache::bytes_of(&grid.header),
            rt_probe::probe_cache::bytes_of(&env0),
            rt_probe::probe_cache::bytes_of(&[cfg.render.probe_rays]),
        ]);

        let mut b = MetalBackend {
            device,
            queue,
            vbuf,
            ibuf,
            gbuf,
            mbuf,
            lbuf,
            probe_buf,
            probe_count,
            texes,
            blas_list,
            tlas,
            tlas_scratch,
            inst_buf,
            instances,
            shade_pso,
            probe_pso,
            tonemap_pso,
            env0,
            base_scale: cfg.render.pixel,
            lights_cpu,
            mats_cpu,
            light_link,
            light_count,
            flash_idx,
            n_spot_active: 0,
            dyn_insts,
            dyn_shadow,
            tlas_dirty: false,
            handles,
            target: None,
            layer: None,
            probes_baked: false,
            probe_cache: window.is_some(), // interactive only — capture bakes fresh
            probe_key,
        };

        // bake the GI probe cache (blocking, once — both light banks), or load
        // it from the disk cache on the interactive path if the inputs match.
        b.bake_probes(cfg.render.probe_rays);

        // present surface (windowed only) + the window-size resources
        if let Some(w) = window {
            b.layer = attach_metal_layer(&b.device, w);
        }
        let (w0, h0) = match window {
            Some(w) => (w.inner_size().width, w.inner_size().height),
            None => cfg.harness.window.unwrap_or((1280, 800)),
        };
        b.recreate(w0.max(1), h0.max(1));
        Ok(b)
    }

    /// Bake the two-bank GI probe cache (probes.metal). Bank 0 = practicals off
    /// (sun/sky, screens stay on); bank 1 = full. No-op after the first call.
    unsafe fn bake_probes(&mut self, rays_total: i32) {
        if self.probes_baked {
            return;
        }
        // interactive path: reload the baked banks from disk if the scene inputs
        // are unchanged (skips ~4.5 s of software-RT baking on the M2). The lit
        // light/material buffers are already in their post-bake state (built lit
        // in new()), so a cache hit needs nothing but the probe bytes.
        let probe_bytes = self.probe_buf.length() as usize;
        if self.probe_cache {
            if let Some(bytes) = rt_probe::probe_cache::load(self.probe_key, probe_bytes) {
                std::ptr::copy_nonoverlapping(bytes.as_ptr(), self.probe_buf.contents() as *mut u8, probe_bytes);
                self.probes_baked = true;
                println!("probes: loaded {} probes from cache ({:016x}) (metal)", self.probe_count, self.probe_key);
                return;
            }
        }
        const BATCH: i32 = 32; // small per-cb batch keeps each dispatch under the GPU watchdog
        const BOUNCES: i32 = 4;
        let t0 = std::time::Instant::now();
        for bank in 0..2i32 {
            // clone the lit state, apply the shared 2-bank emission, upload;
            // the full state is restored after the loop for the shade pass.
            let mut lights = self.lights_cpu.clone();
            let mut mats = self.mats_cpu.clone();
            bake_bank_emission(bank, &self.light_link, &mut lights, &mut mats);
            write_buf(&self.lbuf, &lights);
            write_buf(&self.mbuf, &mats);
            let mut baked = 0;
            while baked < rays_total {
                let push = ProbePush { misc: [self.probe_count as i32, rays_total, BOUNCES, BATCH], misc2: [baked, bank, self.light_count as i32, 0], env0: self.env0 };
                let cb = self.queue.new_command_buffer();
                let enc = cb.new_compute_command_encoder();
                enc.set_compute_pipeline_state(&self.probe_pso);
                enc.set_acceleration_structure(0, Some(&self.tlas));
                enc.set_buffer(1, Some(&self.vbuf), 0);
                enc.set_buffer(2, Some(&self.ibuf), 0);
                enc.set_buffer(3, Some(&self.gbuf), 0);
                enc.set_buffer(4, Some(&self.mbuf), 0);
                enc.set_buffer(5, Some(&self.lbuf), 0);
                enc.set_buffer(6, Some(&self.probe_buf), 0);
                enc.set_bytes(7, size_of::<ProbePush>() as u64, &push as *const _ as *const c_void);
                enc.use_resource(&self.tlas, MTLResourceUsage::Read);
                for bl in &self.blas_list {
                    enc.use_resource(bl, MTLResourceUsage::Read);
                }
                enc.dispatch_threads(MTLSize { width: self.probe_count as u64, height: 1, depth: 1 }, MTLSize { width: 64, height: 1, depth: 1 });
                enc.end_encoding();
                cb.commit();
                cb.wait_until_completed();
                assert_eq!(cb.status(), MTLCommandBufferStatus::Completed, "probe bake batch failed (bank {bank}, ray {baked})");
                baked += BATCH;
            }
        }
        // restore the full (lit) light/material state for the shade pass
        write_buf(&self.lbuf, &self.lights_cpu);
        write_buf(&self.mbuf, &self.mats_cpu);
        self.probes_baked = true;
        println!("probes: baked {rays_total} rays × {} probes × 2 banks in {:.0} ms (metal)", self.probe_count, t0.elapsed().as_secs_f32() * 1000.0);
        // persist the baked banks for the next interactive launch (best-effort).
        if self.probe_cache {
            let bytes = std::slice::from_raw_parts(self.probe_buf.contents() as *const u8, probe_bytes);
            rt_probe::probe_cache::store(self.probe_key, bytes);
        }
    }

    /// Rebuild the TLAS from the (patched) instance buffer — cheap full build
    /// on dirty (mirrors the Vulkan record_tlas_rebuild BUILD-on-change).
    unsafe fn rebuild_tlas(&self) {
        let desc = tlas_descriptor(&self.blas_list, &self.inst_buf, self.instances.len() as u64);
        let cb = self.queue.new_command_buffer();
        let enc = cb.new_acceleration_structure_command_encoder();
        enc.build_acceleration_structure(&self.tlas, &desc, &self.tlas_scratch, 0);
        enc.end_encoding();
        cb.commit();
        cb.wait_until_completed();
    }

    /// Expand a logical overlay canvas to a staging texture and blit it onto
    /// `dst` (the presented drawable) at (dx, dy). RGBA bytes (the drawable is
    /// RGBA8Unorm). The staging texture is parked in `staging` so it outlives
    /// the (committed, unwaited) command buffer. Out-of-bounds → skipped.
    #[allow(clippy::too_many_arguments)]
    unsafe fn blit_overlay(&self, blit: &BlitCommandEncoderRef, dst: &TextureRef, canvas: &[u32], cw: i32, ch: i32, scale: u32, dx: i64, dy: i64, ext_w: u32, ext_h: u32, staging: &mut Vec<Texture>) {
        let (pw, ph) = (cw as u64 * scale as u64, ch as u64 * scale as u64);
        if dx < 0 || dy < 0 || dx as u64 + pw > ext_w as u64 || dy as u64 + ph > ext_h as u64 {
            return;
        }
        let bytes = crate::menu::expand_canvas(canvas, cw, ch, scale, false); // RGBA (drawable is RGBA8Unorm)
        let desc = TextureDescriptor::new();
        desc.set_texture_type(MTLTextureType::D2);
        desc.set_pixel_format(MTLPixelFormat::RGBA8Unorm);
        desc.set_width(pw);
        desc.set_height(ph);
        desc.set_storage_mode(MTLStorageMode::Shared);
        desc.set_usage(MTLTextureUsage::ShaderRead);
        let stage = self.device.new_texture(&desc);
        let full = MTLRegion { origin: MTLOrigin { x: 0, y: 0, z: 0 }, size: MTLSize { width: pw, height: ph, depth: 1 } };
        stage.replace_region(full, 0, bytes.as_ptr() as *const c_void, pw * 4);
        blit.copy_from_texture(&stage, 0, 0, MTLOrigin { x: 0, y: 0, z: 0 }, MTLSize { width: pw, height: ph, depth: 1 }, dst, 0, 0, MTLOrigin { x: dx as u64, y: dy as u64, z: 0 });
        staging.push(stage);
    }

    /// Subsample the out texture to exact low-res game pixels (the upscale is
    /// integer NEAREST, so any sample of an rs×rs block is the game pixel).
    unsafe fn readback_subsampled(&self, rs: u32) -> (u32, u32, Vec<u8>) {
        let tgt = self.target.as_ref().unwrap();
        let (w, h) = (tgt.ext_w, tgt.ext_h);
        let mut full = vec![0u8; (w * h * 4) as usize];
        let region = MTLRegion { origin: MTLOrigin { x: 0, y: 0, z: 0 }, size: MTLSize { width: w as u64, height: h as u64, depth: 1 } };
        tgt.out_tex.get_bytes(full.as_mut_ptr() as *mut c_void, w as u64 * 4, region, 0);
        let (sw, sh) = (w / rs, h / rs);
        let mut sub = vec![0u8; (sw * sh * 4) as usize];
        for y in 0..sh {
            for x in 0..sw {
                let src = (((y * rs) * w + x * rs) * 4) as usize;
                let dst = ((y * sw + x) * 4) as usize;
                sub[dst..dst + 4].copy_from_slice(&full[src..src + 4]);
            }
        }
        (sw, sh, sub)
    }
}

impl RenderBackend for MetalBackend {
    fn handles(&self) -> &SceneHandles {
        &self.handles
    }
    fn light_count(&self) -> u32 {
        self.light_count
    }
    fn rs(&self, zoom: f32) -> i32 {
        render_scale(zoom, self.base_scale)
    }
    fn low_and_vis(&self, zoom: f32) -> (Vec2, Vec2) {
        let tgt = self.target.as_ref().unwrap();
        let rs = self.rs(zoom) as f32;
        let low = Vec2::new(tgt.low_w as f32, tgt.low_h as f32);
        let vis = Vec2::new((tgt.ext_w as f32 / rs).ceil(), (tgt.ext_h as f32 / rs).ceil());
        (low, vis)
    }
    fn low_dims(&self) -> (u32, u32) {
        let t = self.target.as_ref().unwrap();
        (t.low_w, t.low_h)
    }
    fn extent(&self) -> (u32, u32) {
        let t = self.target.as_ref().unwrap();
        (t.ext_w, t.ext_h)
    }
    fn menu_scale(&self) -> u32 {
        self.target.as_ref().map(|t| t.menu_scale).unwrap_or(2)
    }
    fn has_target(&self) -> bool {
        self.target.is_some()
    }

    unsafe fn recreate(&mut self, win_w: u32, win_h: u32) {
        let (ext_w, ext_h) = (win_w.max(1), win_h.max(1));
        let low_w = ext_w.div_ceil(self.base_scale).max(1) + 2 * MARGIN;
        let low_h = ext_h.div_ceil(self.base_scale).max(1) + 2 * MARGIN;
        let n_low = (low_w * low_h) as usize;
        let radiance = self.device.new_buffer((n_low * 16) as u64, MTLResourceOptions::StorageModeShared);
        let albedo = self.device.new_buffer((n_low * 16) as u64, MTLResourceOptions::StorageModeShared);
        let pos = self.device.new_buffer((n_low * 16) as u64, MTLResourceOptions::StorageModeShared);
        let desc = TextureDescriptor::new();
        desc.set_texture_type(MTLTextureType::D2);
        desc.set_pixel_format(MTLPixelFormat::RGBA8Unorm);
        desc.set_width(ext_w as u64);
        desc.set_height(ext_h as u64);
        desc.set_storage_mode(MTLStorageMode::Shared);
        desc.set_usage(MTLTextureUsage::ShaderWrite | MTLTextureUsage::ShaderRead);
        let out_tex = self.device.new_texture(&desc);
        let menu_scale = (ext_h / 400).clamp(2, 6);
        // Pin the drawable to the PHYSICAL extent (= winit inner_size = ext =
        // out_tex). A CAMetalLayer's drawableSize otherwise defaults to
        // bounds(points)·contentsScale(1.0) = the LOGICAL size, so on a Retina
        // display (2×) the drawable would be half `ext` in each axis and the
        // present blit (a same-size copy of `ext`) would land only the top-left
        // quarter — the centred player ends up in a corner. `contentsScale` is
        // set at attach time (needs the window's scale factor); both share the
        // 0.2.0 `CGSize` metal-rs uses, so no type skew.
        if let Some(layer) = &self.layer {
            layer.set_drawable_size(CGSize { width: ext_w as f64, height: ext_h as f64 });
        }
        self.target = Some(MetalTarget { low_w, low_h, ext_w, ext_h, menu_scale, radiance, albedo, pos, out_tex, cap_size: None, pending_capture: None });
        println!("{} {}x{}  low-res {}x{} @ baseScale x{} (R={:.2}) (metal)", if self.layer.is_some() { "layer" } else { "offscreen" }, ext_w, ext_h, low_w, low_h, self.base_scale, ISO_R);
    }

    unsafe fn wait_idle(&self) {
        // Each command buffer is waited inline; nothing is in flight.
    }

    unsafe fn render_present(&mut self, fp: &FramePresent) -> bool {
        // ---- per-frame scene-state update (CPU shadows → Shared buffers)
        self.n_spot_active = frame_lights_cpu(&mut self.lights_cpu, &mut self.mats_cpu, &self.light_link, self.flash_idx, fp.fs);
        write_buf(&self.lbuf, &self.lights_cpu);
        write_buf(&self.mbuf, &self.mats_cpu);
        // patch mover instance transforms (player + door leaves) on change
        let mut moved = false;
        for &(key, m) in fp.fs.instances {
            let di = key.index() as usize;
            if self.dyn_shadow[di] == m {
                continue;
            }
            let (first, count) = self.dyn_insts[di];
            let tm = to_packed(m);
            for k in 0..count {
                self.instances[(first + k) as usize].transformation_matrix = tm;
            }
            self.dyn_shadow[di] = m;
            moved = true;
        }
        if moved {
            write_buf(&self.inst_buf, &self.instances);
            self.tlas_dirty = true;
        }
        if self.tlas_dirty {
            self.rebuild_tlas();
            self.tlas_dirty = false;
        }

        let (low_w, low_h, ext_w, ext_h) = {
            let t = self.target.as_ref().unwrap();
            (t.low_w, t.low_h, t.ext_w, t.ext_h)
        };
        let cam = &fp.fs.cam;
        let light_count = (self.light_count + self.n_spot_active) as i32;
        let room_lights16 = (fp.fs.room_lights * 65536.0).round() as i32;
        let roi = match &fp.roi {
            Some(r) => rt_probe::roi_push(cam, low_w as i32, low_h as i32, r.player, r.radius_px, r.falloff_px, r.ghost),
            None => rt_probe::ROI_OFF,
        };
        let push = Push {
            cam_right: [cam.right.x, cam.right.y, cam.right.z, cam.half_w],
            cam_up: [cam.up.x, cam.up.y, cam.up.z, cam.half_h],
            cam_dir: [cam.dir.x, cam.dir.y, cam.dir.z, fp.ao_r],
            cam_pos: [cam.pos.x, cam.pos.y, cam.pos.z, fp.ao],
            misc: [low_w as i32, low_h as i32, fp.ao_n, fp.debug],
            misc2: [light_count, 1, room_lights16, 0],
            env0: self.env0,
            roi: roi.roi,
            roi2: roi.roi2,
        };
        let rs = self.rs(fp.zoom);
        let tp = build_tone_push(low_w, low_h, ext_w, ext_h, rs, fp.pan, fp.target, fp.yaw_deg, fp.exposure, &fp.style, fp.frame);

        // ---- shade + tonemap in one command buffer (waited inline)
        {
            let t = self.target.as_ref().unwrap();
            let cb = self.queue.new_command_buffer();
            // shade: low_w×low_h, writes radiance/albedo/pos
            let enc = cb.new_compute_command_encoder();
            enc.set_compute_pipeline_state(&self.shade_pso);
            enc.set_acceleration_structure(0, Some(&self.tlas));
            enc.set_buffer(1, Some(&self.vbuf), 0);
            enc.set_buffer(2, Some(&self.ibuf), 0);
            enc.set_buffer(3, Some(&self.gbuf), 0);
            enc.set_buffer(4, Some(&self.mbuf), 0);
            enc.set_buffer(5, Some(&self.lbuf), 0);
            enc.set_buffer(6, Some(&self.probe_buf), 0);
            enc.set_bytes(7, size_of::<Push>() as u64, &push as *const _ as *const c_void);
            enc.set_buffer(8, Some(&t.radiance), 0);
            enc.set_buffer(9, Some(&t.albedo), 0);
            enc.set_buffer(10, Some(&t.pos), 0);
            for (i, tex) in self.texes.iter().enumerate() {
                enc.set_texture(i as u64, Some(tex));
            }
            enc.use_resource(&self.tlas, MTLResourceUsage::Read);
            for bl in &self.blas_list {
                enc.use_resource(bl, MTLResourceUsage::Read);
            }
            enc.dispatch_threads(MTLSize { width: low_w as u64, height: low_h as u64, depth: 1 }, MTLSize { width: 8, height: 8, depth: 1 });
            enc.end_encoding();
            // tonemap: ext_w×ext_h, reads the G-buffers, writes out_tex
            let tenc = cb.new_compute_command_encoder();
            tenc.set_compute_pipeline_state(&self.tonemap_pso);
            tenc.set_buffer(0, Some(&t.radiance), 0);
            tenc.set_buffer(1, Some(&t.albedo), 0);
            tenc.set_buffer(2, Some(&t.pos), 0);
            tenc.set_bytes(3, size_of::<crate::backend::TonePush>() as u64, &tp as *const _ as *const c_void);
            tenc.set_texture(0, Some(&t.out_tex));
            tenc.dispatch_threads(MTLSize { width: ext_w as u64, height: ext_h as u64, depth: 1 }, MTLSize { width: 8, height: 8, depth: 1 });
            tenc.end_encoding();
            cb.commit();
            cb.wait_until_completed();
        }

        // ---- minimap HUD: burn into out_tex (the present + readback source) so
        // it lands in the live view AND in SHOT/DUMP/DEMO captures, unlike the
        // menu/score overlay (drawable only). Bottom-left corner.
        if let Some((mc, mw, mh)) = fp.minimap {
            let (ext_w, ext_h, scale) = { let t = self.target.as_ref().unwrap(); (t.ext_w, t.ext_h, t.menu_scale) };
            let m: i64 = 12;
            let dy = ext_h as i64 - m - mh as i64 * scale as i64;
            let cbm = self.queue.new_command_buffer();
            let blit = cbm.new_blit_command_encoder();
            let mut staging: Vec<Texture> = Vec::new();
            {
                let t = self.target.as_ref().unwrap();
                self.blit_overlay(blit, &t.out_tex, mc, mw, mh, scale, m, dy, ext_w, ext_h, &mut staging);
            }
            blit.end_encoding();
            cbm.commit();
            cbm.wait_until_completed();
        }

        // ---- deferred clip capture: subsample the just-rendered out texture
        // (the Viewer collects it on the next frame, mirroring the Vulkan defer)
        if fp.capture {
            let pixels = self.readback_subsampled(rs as u32);
            if let Some(t) = self.target.as_mut() {
                t.pending_capture = Some(pixels);
            }
        }

        // ---- present (windowed): blit out_tex → the drawable, overlay the
        // CPU-drawn menu/HUD onto the PRESENTED drawable only (never out_tex, so
        // SHOT/MOVIE/DUMP captures stay UI-free), then present. Headless / SHOT
        // has no layer — nothing presents.
        if let Some(layer) = &self.layer {
            if let Some(drawable) = layer.next_drawable() {
                let (ext_w, ext_h, menu_scale) = { let t = self.target.as_ref().unwrap(); (t.ext_w, t.ext_h, t.menu_scale) };
                let zero = MTLOrigin { x: 0, y: 0, z: 0 };
                let cb = self.queue.new_command_buffer();
                let blit = cb.new_blit_command_encoder();
                {
                    let t = self.target.as_ref().unwrap();
                    blit.copy_from_texture(&t.out_tex, 0, 0, zero, MTLSize { width: ext_w as u64, height: ext_h as u64, depth: 1 }, drawable.texture(), 0, 0, zero);
                }
                let mut staging: Vec<Texture> = Vec::new(); // keep overlay textures alive until commit
                if let Some(ov) = &fp.overlay {
                    let m = crate::menu::MENU_MARGIN as i64;
                    let (mc, mw, mh) = ov.menu;
                    self.blit_overlay(blit, drawable.texture(), mc, mw, mh, menu_scale, m, m, ext_w, ext_h, &mut staging);
                    if let Some((sc, sw, sh)) = ov.score {
                        let dx = ext_w as i64 - m - sw as i64 * menu_scale as i64;
                        self.blit_overlay(blit, drawable.texture(), sc, sw, sh, menu_scale, dx, m, ext_w, ext_h, &mut staging);
                    }
                }
                blit.end_encoding();
                cb.present_drawable(drawable);
                cb.commit();
            }
        }
        true
    }

    unsafe fn readback_out_subsampled(&self, rs: i32) -> (u32, u32, Vec<u8>) {
        self.readback_subsampled(rs as u32)
    }

    unsafe fn capture_png(&self, path: &str) {
        let tgt = self.target.as_ref().unwrap();
        let (w, h) = (tgt.ext_w, tgt.ext_h);
        let mut pixels = vec![0u8; (w * h * 4) as usize];
        let region = MTLRegion { origin: MTLOrigin { x: 0, y: 0, z: 0 }, size: MTLSize { width: w as u64, height: h as u64, depth: 1 } };
        tgt.out_tex.get_bytes(pixels.as_mut_ptr() as *mut c_void, w as u64 * 4, region, 0);
        crate::capture::write_png(path, w, h, &pixels);
        println!("captured {path} ({w}x{h}) (metal)");
    }

    fn capture_target_size(&self) -> Option<(u32, u32)> {
        self.target.as_ref().and_then(|t| t.cap_size)
    }
    unsafe fn ensure_capture_target(&mut self, w: u32, h: u32) {
        if let Some(t) = self.target.as_mut() {
            t.cap_size = Some((w, h));
        }
    }
    unsafe fn collect_pending_capture(&mut self) -> Option<(u32, u32, Vec<u8>)> {
        self.target.as_mut().and_then(|t| t.pending_capture.take())
    }
}

/// Attach a `CAMetalLayer` to the winit window's `NSView` (macOS). Returns the
/// layer for present, or `None` if the raw handle isn't an AppKit view.
unsafe fn attach_metal_layer(device: &Device, window: &Window) -> Option<MetalLayer> {
    use objc::runtime::YES;
    use objc::{msg_send, sel, sel_impl};
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let handle = window.window_handle().ok()?.as_raw();
    let RawWindowHandle::AppKit(h) = handle else { return None };
    let layer = MetalLayer::new();
    layer.set_device(device);
    layer.set_pixel_format(MTLPixelFormat::RGBA8Unorm);
    layer.set_presents_with_transaction(false);
    // Map the layer's point-space bounds to physical pixels (Retina). The
    // drawable's exact size is then pinned per-resize in `recreate`.
    layer.set_contents_scale(window.scale_factor());
    let ns_view = h.ns_view.as_ptr() as *mut objc::runtime::Object;
    let _: () = msg_send![ns_view, setWantsLayer: YES];
    let _: () = msg_send![ns_view, setLayer: layer.as_ref()];
    Some(layer)
}

#[cfg(test)]
mod tests {
    use super::to_packed;
    use glam::{Mat4, Vec3};

    /// The one piece of instance-transform math written on both sides of the API
    /// boundary: Metal's `to_packed` (column-major 4×3) must encode the same
    /// affine transform as Vulkan's `mat_to_transform` (row-major 3×4). Pins it
    /// without a GPU or a window.
    #[test]
    fn to_packed_matches_mat_to_transform_rows() {
        let m = Mat4::from_translation(Vec3::new(1.5, -2.0, 3.25)) * Mat4::from_rotation_y(0.7);
        let packed = to_packed(m); // [col][row]
        let vk = rt_probe::render::mat_to_transform(m).matrix; // row-major 3×4
        for col in 0..4 {
            for row in 0..3 {
                assert!((packed[col][row] - vk[row * 4 + col]).abs() < 1e-6, "mismatch at col {col} row {row}");
            }
        }
    }
}
