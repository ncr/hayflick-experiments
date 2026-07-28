//! `MetalBackend` — the GPU half on Apple Silicon (Metal compute ray tracing).
//!
//! The Metal twin of `VulkanBackend`: same `RenderBackend` contract, same
//! deterministic frame (stream this frame's lights → patch mover instances →
//! TLAS refit if dirty → shade → tonemap → present / readback). Geometry,
//! the concatenated scalar buffers, BLAS-per-primitive + TLAS, the two-bank GI
//! probe cache, and the ported `shade.metal` / `probes.metal` / `tonemap.metal`
//! kernels grew out of the verified `spikes/metal-rt/` spike (since deleted —
//! this backend is the permanent implementation).
//!
//! M2 is software RT (Apple8) — intersection runs on shader cores (no dedicated
//! RT block until M3); fine for this workload. Bindless geometry is the
//! concatenated-buffer + offset-table scheme (NOT gpuAddress): the four scalar
//! buffers are indexed by `intersection.instance_id`. Scalar byte-match is
//! load-bearing: `packed_float3` not `float3`; struct sizes asserted both sides.

use crate::backend::{build_tone_push, low_dims_for, menu_scale_for, overlay_origin, stamp_in_bounds, FramePresent, ProbeRefresh, RenderBackend};
use crate::capture::subsample_rgba;
use core_graphics_types::geometry::CGSize;
use glam::{Mat4, Vec3};
use metal::*;
use rt_probe::render::{frame_lights_cpu, scan_lights, LightScan};
use rt_probe::scene::{Material, Vertex};
use rt_probe::{bake_bank_emission, Config, InstanceTable, ProbeGrid, Scene, SceneHandles};
use std::ffi::c_void;
use std::mem::size_of;
use winit::window::Window;

/// Shade push constants — byte-identical to shade.metal's `Push` (its own
/// layout, NOT the Vulkan ShadePush — the two spell misc2 differently).
/// `hasProbes` used to sit in misc2.y: an M1 bring-up gate that had been
/// hardwired to its pass-through value (1) since the probe bake landed, and
/// the ONLY logic divergence between the two shade twins. Deleted 2026-07-28;
/// `wear.rs`'s FORBIDDEN table keeps it out of both sources.
#[repr(C)]
#[derive(Clone, Copy)]
struct Push {
    cam_right: [f32; 4], // xyz, w = ortho half-width
    cam_up: [f32; 4],    // xyz, w = ortho half-height
    cam_dir: [f32; 4],   // xyz forward, w = AO radius
    cam_pos: [f32; 4],   // xyz eye, w = AO strength
    misc: [i32; 4],      // W, H, aoRays, debug
    misc2: [i32; 4],     // lightCount, roomLights16, reflBlockPx, _
    env0: [f32; 4],      // sun, sky, fogD, fogH
    roi: [f32; 4],       // CAVE_ROI: player world xyz + disc radius (low-res px)
    roi2: [f32; 4],      // projected player px xy + disc falloff px + enabled (>0.5)
    look: [f32; 4],      // spec strength, bump strength, bump scale, gloss (look knobs)
    look2: [f32; 4],     // gi scale, matPoster levels, aoDither, reflStrength
    misc3: [i32; 4],     // floorCutY 16.16 (INT_MAX = off), wallCutY 16.16 (INT_MAX = off; occluder-only sill cut), _, _
    env1: [f32; 4],      // sun/sky-as-data (Faza 1b): sun dir xyz (normalized), _
    env2: [f32; 4],      // sun tint rgb, _
    env3: [f32; 4],      // sky horizon tint rgb, _
    env4: [f32; 4],      // sky zenith tint rgb, _
}

/// Probe-bake push constants — byte-identical to probes.metal's `ProbePush`.
#[repr(C)]
#[derive(Clone, Copy)]
struct ProbePush {
    misc: [i32; 4],  // probeCount, raysTotal, bounces, raysThisBatch
    misc2: [i32; 4], // batchStartRay, bank, lightCount, firstProbe (Stage-2 sub-range base)
    misc3: [i32; 4], // Stage-2 refresh box: (boxLoX, boxLoY, boxLoZ, boxWidthX); w>0 = box mode
    env0: [f32; 4],
    env1: [f32; 4], // sun/sky-as-data (Faza 1b) — the bake lights with the
    env2: [f32; 4], // exact sun/sky the shade pass shows
    env3: [f32; 4],
    env4: [f32; 4],
    roll: [f32; 4], // DDGI rolling refresh: (decay, wrapRays, primeCount, _); decay>0 = rolling
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

/// Scene-dependent GPU state — everything a runtime LOOK switch must rebuild
/// (Faza 1b): concatenated geometry/material/light buffers, the BLAS/TLAS
/// pair, the probe banks, the light/mover joins and the resolved env block.
/// The Metal twin of the Vulkan `SceneGpu`; device/queue/pipelines/target
/// stay on `MetalBackend` and survive the swap.
struct MetalScene {
    // geometry + lights (concatenated scalar buffers; Shared so per-frame
    // light/material/instance state is a CPU memcpy between waited frames)
    vbuf: Buffer,
    ibuf: Buffer,
    gbuf: Buffer,
    mbuf: Buffer,
    lbuf: Buffer,
    probe_buf: Buffer,
    probe_count: u32,
    // probe-grid geometry (Stage-2 tear-off refresh: a world AABB → probe index
    // runs; the grid header lives in probe_buf, these are the cheap scalars).
    probe_origin: Vec3,
    probe_spacing: f32,
    probe_dims: [u32; 3],
    blas_list: Vec<AccelerationStructure>,
    tlas: AccelerationStructure,
    tlas_scratch: Buffer,
    inst_buf: Buffer,
    instances: Vec<MTLAccelerationStructureInstanceDescriptor>,
    // resolved lighting environment (env0 scalars + sun/sky-as-data rows)
    env: rt_probe::EnvBlock,
    // per-frame light streaming (CPU shadows of lbuf/mbuf + the per-light link)
    lights_cpu: Vec<[f32; 12]>,
    mats_cpu: Vec<Material>,
    light_link: Vec<(i32, [f32; 3], bool)>,
    light_count: u32,
    // movers
    dyn_insts: Vec<(u32, u32)>,
    dyn_shadow: Vec<Mat4>,
    handles: SceneHandles,
    probes_baked: bool,
    // content hash of the bake inputs (geometry/materials/lights/grid/env/
    // rays) — the probe disk-cache filename, so every look caches separately.
    probe_key: u64,
}

pub struct MetalBackend {
    device: Device,
    queue: CommandQueue,
    /// Scene-dependent state, swapped whole by `rebuild_scene` (look switch).
    sc: MetalScene,
    // pipelines
    shade_pso: ComputePipelineState,
    probe_pso: ComputePipelineState,
    tonemap_pso: ComputePipelineState,
    base_scale: u32,
    tlas_dirty: bool,
    /// Stage-2 dynamic GI: the bake ray budget (per probe per bank), kept so the
    /// amortize=false ground-truth refresh re-bakes each touched probe to the
    /// SAME convergence as the startup bake (bit-exact).
    probe_rays: i32,
    /// DDGI rolling refresh (Stage-3): the hot probe box being settled, frames
    /// remaining, ray-cycle offset, and a one-shot prime flag. `roll_n` is the
    /// rolling Fibonacci set size / decay window (its OWN, smaller than the dense
    /// startup bake's `probe_rays`); `roll_k` rays/probe/frame — so a torn region
    /// reconverges in ~roll_n/roll_k frames, bounded to one dispatch/bank/frame.
    roll_box: Option<([u32; 3], [u32; 3])>,
    roll_frames: u32,
    roll_ray: i32,
    roll_prime: bool,
    roll_n: i32,
    roll_k: i32,
    roll_total: u32,
    // window-size resources + present surface
    target: Option<MetalTarget>,
    layer: Option<MetalLayer>,
    // GI probe disk cache: enabled only on the interactive (windowed) path so
    // headless capture stays a fresh deterministic bake.
    probe_cache: bool,
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

impl MetalScene {
    /// Build every scene-dependent GPU resource — the scene half of the old
    /// `new()`, shared by backend construction and the runtime look switch
    /// (`rebuild_scene`, Faza 1b). The Metal twin of `SceneGpu::build`.
    unsafe fn build(device: &Device, queue: &CommandQueue, scene: &Scene, cfg: &Config) -> Result<MetalScene, Box<dyn std::error::Error>> {
        // ---- concatenated geometry/material/light buffers
        let vbuf = make_buf(device, &scene.vertices);
        let ibuf = make_buf(device, &scene.indices);
        let gbuf = make_buf(device, &scene.geom_infos());
        let mbuf = make_buf(device, &scene.materials);
        let LightScan { lights, light_link, names: light_names, light_count } = scan_lights(scene)?;
        let lbuf = make_buf(device, &lights);
        let lights_cpu = lights.clone();
        let mats_cpu = scene.materials.clone();

        println!("scene: {} prims, {} tris (metal)", scene.primitives.len(), scene.indices.len() / 3);

        // ---- world-space probe grid (shared with Vulkan via gpu_scene; the
        // frozen-pad form is canonical — the old inline Metal loop re-derived the
        // pad with the widened spacing, which diverged once widening kicked in).
        let grid = ProbeGrid::build(scene.min, scene.max, cfg.render.probe_spacing);
        let probe_count = grid.count;
        let probe_buf = make_buf(device, &grid.header);
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
        let inst_buf = make_buf(device, &instances);

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

        // resolved lighting env: the env0 scalars (with the SUN/SKY/FOG/FOG_H
        // overrides applied) + the scene's authored sun/sky rows (Faza 1b)
        let env = rt_probe::EnvBlock::pack(cfg.lighting_env(scene.lighting), &scene.sun_sky);

        // content hash of every input the bake reads — the probe-cache filename.
        // Any geometry/material/light/grid/env/ray change (a look switch, a
        // palette edit) produces a new key and re-bakes; identical inputs
        // reload from disk — so every look caches its banks separately.
        let envb = [env.env0, env.env1, env.env2, env.env3, env.env4];
        let probe_key = rt_probe::probe_cache::content_key(&[
            rt_probe::probe_cache::bytes_of(&scene.vertices),
            rt_probe::probe_cache::bytes_of(&scene.indices),
            rt_probe::probe_cache::bytes_of(&scene.materials),
            rt_probe::probe_cache::bytes_of(&lights_cpu),
            rt_probe::probe_cache::bytes_of(&grid.header),
            rt_probe::probe_cache::bytes_of(&envb),
            rt_probe::probe_cache::bytes_of(&[cfg.render.probe_rays]),
        ]);

        Ok(MetalScene {
            vbuf,
            ibuf,
            gbuf,
            mbuf,
            lbuf,
            probe_buf,
            probe_count,
            probe_origin: grid.origin,
            probe_spacing: grid.spacing,
            probe_dims: grid.dims,
            blas_list,
            tlas,
            tlas_scratch,
            inst_buf,
            instances,
            env,
            lights_cpu,
            mats_cpu,
            light_link,
            light_count,
            dyn_insts,
            dyn_shadow,
            handles,
            probes_baked: false,
            probe_key,
        })
    }
}

impl MetalBackend {
    pub unsafe fn new(window: Option<&Window>, scene: &Scene, cfg: &Config) -> Result<MetalBackend, Box<dyn std::error::Error>> {
        assert_eq!(size_of::<Vertex>(), 24, "Vertex must be 24 B (packed_float3 layout)");
        assert_eq!(size_of::<Material>(), 48, "Material must be 48 B");

        let device = Device::system_default().ok_or("no Metal device")?;
        println!("device: {} (raytracing: {})", device.name(), device.supports_raytracing());
        assert!(device.supports_raytracing(), "Metal device lacks ray tracing");
        let queue = device.new_command_queue();

        let sc = MetalScene::build(&device, &queue, scene, cfg)?;

        // ---- compile the three kernels at runtime (the driver compiler).
        let opts = CompileOptions::new();
        opts.set_language_version(MTLLanguageVersion::V3_0);
        let shade_src = include_str!("shaders_metal/shade.metal");
        let shade_lib = device.new_library_with_source(shade_src, &opts).map_err(|e| format!("shade.metal: {e}"))?;
        let shade_pso = device.new_compute_pipeline_state_with_function(&shade_lib.get_function("shade", None).unwrap()).map_err(|e| format!("shade pso: {e}"))?;
        let probe_lib = device.new_library_with_source(include_str!("shaders_metal/probes.metal"), &opts).map_err(|e| format!("probes.metal: {e}"))?;
        let probe_pso = device.new_compute_pipeline_state_with_function(&probe_lib.get_function("bake_probes", None).unwrap()).map_err(|e| format!("probe pso: {e}"))?;
        let tone_lib = device.new_library_with_source(include_str!("shaders_metal/tonemap.metal"), &opts).map_err(|e| format!("tonemap.metal: {e}"))?;
        let tonemap_pso = device.new_compute_pipeline_state_with_function(&tone_lib.get_function("tonemap", None).unwrap()).map_err(|e| format!("tonemap pso: {e}"))?;

        let mut b = MetalBackend {
            device,
            queue,
            sc,
            shade_pso,
            probe_pso,
            tonemap_pso,
            base_scale: cfg.render.pixel,
            tlas_dirty: false,
            probe_rays: cfg.render.probe_rays,
            // DDGI rolling refresh knobs (env-tunable): its own small full-sphere
            // set (ROLL_N) cycled ROLL_K rays/probe/frame, decay-blended, over
            // ROLL_FRAMES frames after a tear — a bounded settle, no bake stall.
            roll_box: None,
            roll_frames: 0,
            roll_ray: 0,
            roll_prime: false,
            roll_n: std::env::var("ROLL_N").ok().and_then(|v| v.parse().ok()).unwrap_or(256),
            roll_k: std::env::var("ROLL_K").ok().and_then(|v| v.parse().ok()).unwrap_or(8),
            roll_total: std::env::var("ROLL_FRAMES").ok().and_then(|v| v.parse().ok()).unwrap_or(64),
            target: None,
            layer: None,
            probe_cache: window.is_some(), // interactive only — capture bakes fresh
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

    /// Runtime look switch (Faza 1b): swap the whole scene-dependent state
    /// for a rebuilt one, then rebake (or disk-load) the probe banks. The
    /// device, pipelines, layer and window target survive. Every inline
    /// command buffer is waited, so nothing is in flight during the swap.
    ///
    /// `refresh` decides the GI half: `Full` rebakes (or disk-loads) the whole
    /// grid; `Local` carries the baked banks across the swap and re-bakes only
    /// the probes near the dirty AABBs — the crack-lab knob release, which
    /// otherwise pays a 6.6 s whole-grid bake for one pier's boxes. Both paths
    /// leave `probes_baked` true and the lit light/material state loaded, so the
    /// next frame is identical except for the probes meant to change.
    unsafe fn rebuild_scene_impl(&mut self, scene: &Scene, cfg: &Config, refresh: ProbeRefresh) {
        // Snapshot the banks BEFORE the swap (probe_buf dies with the old scene)
        // and only when they can legally be carried: the grid is DERIVED from the
        // scene bounds, so anything that moves them (bounds, spacing, the probe
        // cap's widening) invalidates every probe position. Crack geometry stays
        // inside its pier's AABB by construction, which is exactly why the check
        // passes for a knob rebuild and would fail for a real level edit.
        // `Local` and `Roll` carry the same banks over the same dirty boxes and
        // differ only in WHO re-bakes them: `Local` here and now (3-5 s, exact),
        // `Roll` the per-frame DDGI roll over the following frames (~30 ms here).
        let (dirty, rolling) = match refresh {
            ProbeRefresh::Local(d) => (Some(d), false),
            ProbeRefresh::Roll(d) => (Some(d), true),
            ProbeRefresh::Full => (None, false),
        };
        let carried = match dirty {
            Some(dirty) if self.sc.probes_baked => {
                let g = ProbeGrid::build(scene.min, scene.max, cfg.render.probe_spacing);
                let same = g.origin == self.sc.probe_origin && g.spacing == self.sc.probe_spacing && g.dims == self.sc.probe_dims;
                let boxes = same.then(|| rt_probe::refresh_boxes_for(g.origin, g.spacing, g.dims, dirty)).flatten();
                if boxes.is_none() {
                    println!("probes: local refresh declined ({}) — full bake (metal)", if same { "a dirty region is off-grid, or the dirty set costs more than a bake" } else { "the probe grid moved" });
                }
                boxes.map(|b| (b, self.probe_bank_bytes()))
            }
            _ => None,
        };
        self.sc = MetalScene::build(&self.device, &self.queue, scene, cfg).expect("look-switch scene rebuild");
        self.tlas_dirty = false;
        let Some((boxes, banks)) = carried else {
            self.bake_probes(cfg.render.probe_rays);
            return;
        };
        // A cache HIT is a genuine full bake of exactly this scene — strictly
        // better than the carry (exact everywhere, ~ms), so try it first.
        if self.load_probe_cache() {
            return;
        }
        std::ptr::copy_nonoverlapping(banks.as_ptr(), self.sc.probe_buf.contents() as *mut u8, banks.len());
        self.sc.probes_baked = true; // …and so NEVER stored: a carried buffer is not a bake of this scene
        let n = rt_probe::probes_in(&boxes);
        if rolling {
            // DEFERRED: hand the dirty box to the per-frame roll and return — the
            // caller is animating (the age-ramp beat), and a synchronous refresh
            // costs 3-5 s whatever its size. Same arming as `tear_off(amortize)`.
            let Some(b) = rt_probe::union_box(&boxes) else { return };
            self.roll_box = Some(b);
            self.roll_frames = self.roll_total;
            self.roll_ray = 0;
            self.roll_prime = true;
            println!("probes: carried {} banks + ROLLING {n} probes over {} frames (metal)", self.sc.probe_count, self.roll_total);
            return;
        }
        let t0 = std::time::Instant::now();
        self.refresh_boxes(&boxes);
        println!("probes: carried {} banks + refreshed {n} probes ({:.0}%) in {:.0} ms (metal)", self.sc.probe_count, 100.0 * n as f32 / self.sc.probe_count as f32, t0.elapsed().as_secs_f32() * 1000.0);
    }

    /// The baked probe banks as raw bytes (the whole `probe_buf`, header
    /// included — the header is rebuilt identically by the next `MetalScene`, so
    /// carrying it costs nothing and keeps this a plain buffer copy).
    unsafe fn probe_bank_bytes(&self) -> Vec<u8> {
        let n = self.sc.probe_buf.length() as usize;
        std::slice::from_raw_parts(self.sc.probe_buf.contents() as *const u8, n).to_vec()
    }

    /// Load the current scene's probe banks from the disk cache (interactive
    /// sessions only — capture paths bake fresh). True = loaded, `probes_baked`
    /// set. Shared by the startup bake and the local-refresh rebuild.
    unsafe fn load_probe_cache(&mut self) -> bool {
        if !self.probe_cache {
            return false;
        }
        let probe_bytes = self.sc.probe_buf.length() as usize;
        let Some(bytes) = rt_probe::probe_cache::load(self.sc.probe_key, probe_bytes) else {
            return false;
        };
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), self.sc.probe_buf.contents() as *mut u8, probe_bytes);
        self.sc.probes_baked = true;
        println!("probes: loaded {} probes from cache ({:016x}) (metal)", self.sc.probe_count, self.sc.probe_key);
        true
    }

    /// Bake the two-bank GI probe cache (probes.metal). Bank 0 = practicals off
    /// (sun/sky, screens stay on); bank 1 = full. No-op after the first call.
    unsafe fn bake_probes(&mut self, rays_total: i32) {
        if self.sc.probes_baked {
            return;
        }
        // interactive path: reload the baked banks from disk if the scene inputs
        // are unchanged (skips ~6.5 s of software-RT baking on the M2). The lit
        // light/material buffers are already in their post-bake state (built lit
        // in new()), so a cache hit needs nothing but the probe bytes.
        let probe_bytes = self.sc.probe_buf.length() as usize;
        if self.load_probe_cache() {
            return;
        }
        let batch = self.probe_batch_for(self.sc.probe_count);
        println!("probes: batch {batch} rays/cb ({} lights)", self.sc.light_count);
        let t0 = std::time::Instant::now();
        for bank in 0..2i32 {
            // clone the lit state, apply the shared 2-bank emission, upload;
            // the full state is restored after the loop for the shade pass.
            let mut lights = self.sc.lights_cpu.clone();
            let mut mats = self.sc.mats_cpu.clone();
            bake_bank_emission(bank, &self.sc.light_link, &mut lights, &mut mats);
            write_buf(&self.sc.lbuf, &lights);
            write_buf(&self.sc.mbuf, &mats);
            let mut baked = 0;
            while baked < rays_total {
                self.probe_dispatch(0, self.sc.probe_count, bank, baked, batch, rays_total);
                baked += batch;
            }
        }
        // restore the full (lit) light/material state for the shade pass
        write_buf(&self.sc.lbuf, &self.sc.lights_cpu);
        write_buf(&self.sc.mbuf, &self.sc.mats_cpu);
        self.sc.probes_baked = true;
        println!("probes: baked {rays_total} rays × {} probes × 2 banks in {:.0} ms (metal)", self.sc.probe_count, t0.elapsed().as_secs_f32() * 1000.0);
        // persist the baked banks for the next interactive launch (best-effort).
        if self.probe_cache {
            let bytes = std::slice::from_raw_parts(self.sc.probe_buf.contents() as *const u8, probe_bytes);
            rt_probe::probe_cache::store(self.sc.probe_key, bytes);
        }
    }

    /// Rays-per-command-buffer for a dispatch over `m` probes. Keeps each
    /// dispatch under the GPU watchdog; the cost scales with the probe COUNT AND
    /// the NEE light count (every bounce samples every light), so the batch
    /// shrinks as either grows (the 32-ray batch that fit 13k probes/3 lamps blew
    /// the watchdog at 40k probes × ~30 lamps — town, 2026-07-12). Sized by `m`
    /// (not the whole grid) so a Stage-2 refresh of a ~dozen-probe run bakes its
    /// full ray budget in one command buffer instead of hundreds of tiny ones.
    fn probe_batch_for(&self, m: u32) -> i32 {
        (2_000_000_000 / (m.max(1) as i64 * (self.sc.light_count as i64 + 8) * 1000)).clamp(2, self.probe_rays.max(2) as i64) as i32
    }

    /// Bind the probe pipeline + every scene buffer + the residency for the
    /// acceleration structures onto `enc`. Shared setup for one or many
    /// back-to-back probe dispatches in the same encoder.
    unsafe fn bind_probe(&self, enc: &ComputeCommandEncoderRef) {
        enc.set_compute_pipeline_state(&self.probe_pso);
        enc.set_acceleration_structure(0, Some(&self.sc.tlas));
        enc.set_buffer(1, Some(&self.sc.vbuf), 0);
        enc.set_buffer(2, Some(&self.sc.ibuf), 0);
        enc.set_buffer(3, Some(&self.sc.gbuf), 0);
        enc.set_buffer(4, Some(&self.sc.mbuf), 0);
        enc.set_buffer(5, Some(&self.sc.lbuf), 0);
        enc.set_buffer(6, Some(&self.sc.probe_buf), 0);
        enc.use_resource(&self.sc.tlas, MTLResourceUsage::Read);
        for bl in &self.sc.blas_list {
            enc.use_resource(bl, MTLResourceUsage::Read);
        }
    }

    fn probe_push(&self, first: u32, bank: i32, batch_start: i32, batch_rays: i32, rays_total: i32, misc3: [i32; 4]) -> ProbePush {
        const BOUNCES: i32 = 4;
        let env = self.sc.env;
        ProbePush {
            misc: [self.sc.probe_count as i32, rays_total, BOUNCES, batch_rays],
            misc2: [batch_start, bank, self.sc.light_count as i32, first as i32],
            misc3,
            env0: env.env0,
            env1: env.env1,
            env2: env.env2,
            env3: env.env3,
            env4: env.env4,
            roll: [0.0; 4], // classic bake; roll_step overrides for the rolling refresh
        }
    }

    /// Encode + dispatch (waited) ONE probe-bake batch: `m` probes starting at
    /// `first` (the `firstProbe` sub-range base), rays `[batch_start,
    /// batch_start+batch_rays)` of `rays_total`, into `bank`. Caller has already
    /// put `bank`'s emission state in lbuf/mbuf. Used by the startup bake
    /// (`first=0, m=probe_count`, one big dispatch per ray-batch).
    unsafe fn probe_dispatch(&self, first: u32, m: u32, bank: i32, batch_start: i32, batch_rays: i32, rays_total: i32) {
        let push = self.probe_push(first, bank, batch_start, batch_rays, rays_total, [0; 4]); // box mode off
        let cb = self.queue.new_command_buffer();
        let enc = cb.new_compute_command_encoder();
        self.bind_probe(enc);
        enc.set_bytes(7, size_of::<ProbePush>() as u64, &push as *const _ as *const c_void);
        enc.dispatch_threads(MTLSize { width: m as u64, height: 1, depth: 1 }, MTLSize { width: 64, height: 1, depth: 1 });
        enc.end_encoding();
        cb.commit();
        cb.wait_until_completed();
        assert_eq!(cb.status(), MTLCommandBufferStatus::Completed, "probe dispatch failed (first {first} m {m} bank {bank} ray {batch_start})");
    }

    /// Stage-2 targeted refresh: reset then re-bake exactly the probes in the
    /// dirty lattice `boxes` (`lo` inclusive, `hi` exclusive), both banks, full
    /// `probe_rays`. RESET-before-rebake because the payload accumulates in place
    /// (ray sums + count, divided at read), so re-baking without zeroing would
    /// double-count; the zero is a direct memset of the Shared probe buffer (each
    /// box row is a contiguous 20-float×width block), safe because every command
    /// buffer here is waited (no in-flight GPU read).
    ///
    /// Each box is a SINGLE 3D dispatch per ray-batch (thread `(a,b,c)` → the
    /// box-local probe), so the dispatch count is `boxes × ray-batches × 2` — not
    /// one-per-row. That is the whole point: a naive per-row refresh paid ~20 ms
    /// of per-dispatch launch latency ×hundreds of rows (seconds); the box path
    /// pays it a handful of times, like the startup bake. Both banks finish
    /// before this returns (no half-updated probe reaches the shade pass) and the
    /// full lit light/material state is restored on exit.
    unsafe fn refresh_boxes(&self, boxes: &[([u32; 3], [u32; 3])]) {
        if boxes.is_empty() {
            return;
        }
        let (nx, ny) = (self.sc.probe_dims[0], self.sc.probe_dims[1]);
        let count = self.sc.probe_count;
        let pd = self.sc.probe_buf.contents() as *mut f32;
        for &(lo, hi) in boxes {
            let wx = hi[0] - lo[0];
            for iz in lo[2]..hi[2] {
                for iy in lo[1]..hi[1] {
                    let row0 = lo[0] + iy * nx + iz * nx * ny;
                    for bank in 0..2u32 {
                        let base = 16 + (bank * count + row0) as usize * 20;
                        std::ptr::write_bytes(pd.add(base), 0, wx as usize * 20); // 20 f32/probe → 0.0
                    }
                }
            }
        }
        for bank in 0..2i32 {
            let mut lights = self.sc.lights_cpu.clone();
            let mut mats = self.sc.mats_cpu.clone();
            bake_bank_emission(bank, &self.sc.light_link, &mut lights, &mut mats);
            write_buf(&self.sc.lbuf, &lights);
            write_buf(&self.sc.mbuf, &mats);
            for &(lo, hi) in boxes {
                let (wx, wy, wz) = (hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
                if wx == 0 || wy == 0 || wz == 0 {
                    continue;
                }
                let box3 = [lo[0] as i32, lo[1] as i32, lo[2] as i32, wx as i32];
                let batch = self.probe_batch_for(wx * wy * wz);
                let mut baked = 0;
                while baked < self.probe_rays {
                    let push = self.probe_push(0, bank, baked, batch, self.probe_rays, box3);
                    let cb = self.queue.new_command_buffer();
                    let enc = cb.new_compute_command_encoder();
                    self.bind_probe(enc);
                    enc.set_bytes(7, size_of::<ProbePush>() as u64, &push as *const _ as *const c_void);
                    enc.dispatch_threads(MTLSize { width: wx as u64, height: wy as u64, depth: wz as u64 }, MTLSize { width: 4, height: 4, depth: 4 });
                    enc.end_encoding();
                    cb.commit();
                    cb.wait_until_completed();
                    assert_eq!(cb.status(), MTLCommandBufferStatus::Completed, "probe refresh dispatch failed (bank {bank})");
                    baked += batch;
                }
            }
        }
        write_buf(&self.sc.lbuf, &self.sc.lights_cpu);
        write_buf(&self.sc.mbuf, &self.sc.mats_cpu);
    }

    /// DDGI rolling refresh step (Stage-3): for the hot `roll_box`, cast `roll_k`
    /// rays/probe into BOTH banks with a decay blend (a one-shot prime first
    /// rescales the dense bake's count down to `roll_n` so the blend responds
    /// immediately, without a brightness pop). ONE 3D dispatch per bank per frame
    /// — bounded, no stall — so a torn region settles over ~roll_n/roll_k frames.
    /// Bank emission uses CLONES of the light/material shadows and the full lit
    /// state is restored on exit, so the shade pass reads the right lights. Call
    /// once per frame before shade while `roll_box` is set.
    unsafe fn roll_step(&mut self) {
        let Some((lo, hi)) = self.roll_box else { return };
        let (wx, wy, wz) = (hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
        if self.roll_frames == 0 || wx == 0 || wy == 0 || wz == 0 {
            self.roll_box = None;
            return;
        }
        let box3 = [lo[0] as i32, lo[1] as i32, lo[2] as i32, wx as i32];
        let decay = 1.0 - self.roll_k as f32 / self.roll_n as f32;
        let prime = if self.roll_prime { self.roll_n as f32 } else { 0.0 };
        for bank in 0..2i32 {
            let mut lights = self.sc.lights_cpu.clone();
            let mut mats = self.sc.mats_cpu.clone();
            bake_bank_emission(bank, &self.sc.light_link, &mut lights, &mut mats);
            write_buf(&self.sc.lbuf, &lights);
            write_buf(&self.sc.mbuf, &mats);
            let mut push = self.probe_push(0, bank, self.roll_ray, self.roll_k, self.roll_n, box3);
            push.roll = [decay, 1.0, prime, 0.0];
            let cb = self.queue.new_command_buffer();
            let enc = cb.new_compute_command_encoder();
            self.bind_probe(enc);
            enc.set_bytes(7, size_of::<ProbePush>() as u64, &push as *const _ as *const c_void);
            enc.dispatch_threads(MTLSize { width: wx as u64, height: wy as u64, depth: wz as u64 }, MTLSize { width: 4, height: 4, depth: 4 });
            enc.end_encoding();
            cb.commit();
            cb.wait_until_completed();
            assert_eq!(cb.status(), MTLCommandBufferStatus::Completed, "probe roll dispatch failed (bank {bank})");
        }
        // restore the lit light/material state so the shade pass NEE is correct
        write_buf(&self.sc.lbuf, &self.sc.lights_cpu);
        write_buf(&self.sc.mbuf, &self.sc.mats_cpu);
        self.roll_ray = (self.roll_ray + self.roll_k) % self.roll_n;
        self.roll_frames -= 1;
        self.roll_prime = false;
    }

    /// Rebuild the TLAS from the (patched) instance buffer — cheap full build
    /// on dirty (mirrors the Vulkan record_tlas_rebuild BUILD-on-change).
    unsafe fn rebuild_tlas(&self) {
        let desc = tlas_descriptor(&self.sc.blas_list, &self.sc.inst_buf, self.sc.instances.len() as u64);
        let cb = self.queue.new_command_buffer();
        let enc = cb.new_acceleration_structure_command_encoder();
        enc.build_acceleration_structure(&self.sc.tlas, &desc, &self.sc.tlas_scratch, 0);
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
        if !stamp_in_bounds(dx, dy, pw, ph, ext_w, ext_h) {
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
        subsample_rgba(&full, w, h, rs)
    }
}

impl RenderBackend for MetalBackend {
    fn handles(&self) -> &SceneHandles {
        &self.sc.handles
    }
    fn light_count(&self) -> u32 {
        self.sc.light_count
    }
    unsafe fn rebuild_scene(&mut self, scene: &Scene, cfg: &Config, refresh: ProbeRefresh) {
        self.rebuild_scene_impl(scene, cfg, refresh);
    }
    /// Crack-lab live material update — Vulkan twin: `render_present` writes
    /// `mats_cpu` to `mbuf` whole every frame, so the shadow write is the
    /// entire job. (Blind-edited on the spawner — verify on the Mac.)
    fn set_material_pad(&mut self, material_id: usize, pad: i32) {
        self.sc.mats_cpu[material_id]._pad = pad;
    }
    /// Wear-family live material update (`crate::wear`'s effect word in
    /// `emissive[3]`) — same one-line mechanism as the pad above.
    fn set_material_effect(&mut self, material_id: usize, word: f32) {
        self.sc.mats_cpu[material_id].emissive[3] = word;
    }
    /// Story-key live update (the scrub dial's drag path) — same one-line
    /// mechanism as its two siblings above. BLIND EDIT (2026-07-27, written on
    /// the RTX box): line-for-line twin of the Vulkan impl.
    fn set_material_story(&mut self, material_id: usize, story: f32) {
        self.sc.mats_cpu[material_id].base_color[3] = story;
    }
    unsafe fn tear_off(&mut self, prims: &[usize], min: Vec3, max: Vec3, amortize: bool) {
        // hide the static instances (mask 0 → culled by primary AND probe rays)
        // then rebuild the TLAS so the refresh below traces the roofless world.
        for &p in prims {
            if let Some(inst) = self.sc.instances.get_mut(p) {
                inst.mask = 0;
            }
        }
        write_buf(&self.sc.inst_buf, &self.sc.instances);
        self.rebuild_tlas();
        // probes whose cells overlap the torn region as a lattice box, padded one
        // spacing so probes that newly see sky/lamps refresh too.
        let Some((lo, hi)) = rt_probe::probe_box(self.sc.probe_origin, self.sc.probe_spacing, self.sc.probe_dims, min, max, self.sc.probe_spacing) else {
            println!("tear_off: region misses the probe grid — roof hidden, no refresh (metal)");
            return;
        };
        let n = (hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2]);
        if amortize {
            // DDGI rolling refresh: settle the whole hot box over the next frames
            // (bounded roll_k rays/probe/frame, decay-blended), no whole-region
            // stall. The first frame primes it (rescales the dense bake's count
            // down to roll_n so the blend responds at once, without a brightness pop).
            self.roll_box = Some((lo, hi));
            self.roll_frames = self.roll_total;
            self.roll_ray = 0;
            self.roll_prime = true;
            println!("tear_off: rolling DDGI refresh of {n} probes over {} frames (metal)", self.roll_total);
        } else {
            let t0 = std::time::Instant::now();
            self.refresh_boxes(&[(lo, hi)]);
            println!("tear_off: refreshed {n} probes in {:.0} ms (metal)", t0.elapsed().as_secs_f32() * 1000.0);
        }
    }
    fn base_scale(&self) -> u32 {
        self.base_scale
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
        let (low_w, low_h) = low_dims_for(ext_w, ext_h, self.base_scale);
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
        let menu_scale = menu_scale_for(ext_h);
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
        println!("{} {}x{}  low-res {}x{} @ baseScale x{} (metal)", if self.layer.is_some() { "layer" } else { "offscreen" }, ext_w, ext_h, low_w, low_h, self.base_scale);
    }

    unsafe fn wait_idle(&self) {
        // Each command buffer is waited inline; nothing is in flight.
    }

    unsafe fn render_present(&mut self, fp: &FramePresent) -> bool {
        // ---- per-frame scene-state update (CPU shadows → Shared buffers)
        frame_lights_cpu(&mut self.sc.lights_cpu, &mut self.sc.mats_cpu, &self.sc.light_link, fp.fs);
        write_buf(&self.sc.lbuf, &self.sc.lights_cpu);
        write_buf(&self.sc.mbuf, &self.sc.mats_cpu);
        // patch mover instance transforms (player + door leaves) on change
        let mut moved = false;
        for &(key, m) in fp.fs.instances {
            let di = key.index() as usize;
            if self.sc.dyn_shadow[di] == m {
                continue;
            }
            let (first, count) = self.sc.dyn_insts[di];
            let tm = to_packed(m);
            for k in 0..count {
                self.sc.instances[(first + k) as usize].transformation_matrix = tm;
            }
            self.sc.dyn_shadow[di] = m;
            moved = true;
        }
        if moved {
            write_buf(&self.sc.inst_buf, &self.sc.instances);
            self.tlas_dirty = true;
        }
        if self.tlas_dirty {
            self.rebuild_tlas();
            self.tlas_dirty = false;
        }
        // Stage-3 DDGI rolling refresh: while a torn region is settling, cast a
        // bounded roll_k rays/probe into both banks and decay-blend them in (one
        // dispatch/bank), so the interior GI reconverges over ~roll_n/roll_k frames
        // with no whole-region stall. Runs before shade so it lights this frame.
        if self.roll_box.is_some() {
            self.roll_step();
        }

        let (low_w, low_h, ext_w, ext_h) = {
            let t = self.target.as_ref().unwrap();
            (t.low_w, t.low_h, t.ext_w, t.ext_h)
        };
        let cam = &fp.fs.cam;
        let light_count = self.sc.light_count as i32;
        let room_lights16 = (fp.fs.room_lights * 65536.0).round() as i32;
        let roi = match &fp.roi {
            Some(r) => rt_probe::roi_push(cam, low_w as i32, low_h as i32, r.player, r.radius_px, r.falloff_px, r.ghost),
            None => rt_probe::ROI_OFF,
        };
        // fp.env = the demo morph's per-frame sun/sky (else the baked scene env)
        let env = fp.env.unwrap_or(self.sc.env).dimmed(fp.sky_dim);
        let push = Push {
            cam_right: [cam.right.x, cam.right.y, cam.right.z, cam.half_w],
            cam_up: [cam.up.x, cam.up.y, cam.up.z, cam.half_h],
            cam_dir: [cam.dir.x, cam.dir.y, cam.dir.z, fp.ao_r],
            cam_pos: [cam.pos.x, cam.pos.y, cam.pos.z, fp.ao],
            misc: [low_w as i32, low_h as i32, fp.ao_n, fp.debug],
            misc2: [light_count, room_lights16, fp.refl_px, 0],
            env0: env.env0,
            roi: roi.roi,
            roi2: roi.roi2,
            look: [fp.spec, fp.bump, fp.bump_scale, fp.gloss],
            look2: [fp.gi, fp.matq, fp.ao_dither, fp.refl],
            misc3: [
                rt_probe::render::cut16(fp.cut_y),
                rt_probe::render::cut16(fp.wall_cut),
                (fp.aa.clamp(0.0, 1.0) * 65536.0).round() as i32, // CONTOUR AA tap weight (16.16)
                fp.aa_scope << 8,                                  // AA sample index (low byte) | scope << 8
            ],
            env1: env.env1,
            env2: env.env2,
            env3: env.env3,
            env4: env.env4,
        };
        let rs = self.rs(fp.zoom);
        let tp = build_tone_push(low_w, low_h, ext_w, ext_h, rs, fp.pan, fp.target, &fp.proj, fp.yaw_deg, fp.exposure, &fp.style, fp.frame);

        // ---- shade + tonemap in one command buffer (waited inline)
        {
            let t = self.target.as_ref().unwrap();
            let cb = self.queue.new_command_buffer();
            // shade: low_w×low_h, writes radiance/albedo/pos
            let enc = cb.new_compute_command_encoder();
            enc.set_compute_pipeline_state(&self.shade_pso);
            enc.set_acceleration_structure(0, Some(&self.sc.tlas));
            enc.set_buffer(1, Some(&self.sc.vbuf), 0);
            enc.set_buffer(2, Some(&self.sc.ibuf), 0);
            enc.set_buffer(3, Some(&self.sc.gbuf), 0);
            enc.set_buffer(4, Some(&self.sc.mbuf), 0);
            enc.set_buffer(5, Some(&self.sc.lbuf), 0);
            enc.set_buffer(6, Some(&self.sc.probe_buf), 0);
            enc.set_bytes(7, size_of::<Push>() as u64, &push as *const _ as *const c_void);
            enc.set_buffer(8, Some(&t.radiance), 0);
            enc.set_buffer(9, Some(&t.albedo), 0);
            enc.set_buffer(10, Some(&t.pos), 0);
            enc.use_resource(&self.sc.tlas, MTLResourceUsage::Read);
            for bl in &self.sc.blas_list {
                enc.use_resource(bl, MTLResourceUsage::Read);
            }
            enc.dispatch_threads(MTLSize { width: low_w as u64, height: low_h as u64, depth: 1 }, MTLSize { width: 8, height: 8, depth: 1 });
            enc.end_encoding();
            // CONTOUR AA (owner 2026-07-25): four extra dispatches of the SAME
            // shade kernel, each tracing one fixed sub-pixel offset and folding
            // its radiance into the texel's running mean. Every tap early-outs
            // on non-contour texels (shade.metal's aaGate), so the cost is
            // ~4 x (contour fraction). A fresh encoder per tap gives the
            // read-modify-write on `radiance` unambiguous ordering (the same
            // reason the shade -> tonemap split uses one).
            // the GATE pass runs for the softening too (it is what marks the
            // contour texels); only the taps need the coverage weight
            let aa_live = fp.aa > 0.0 || fp.style.aa_soft > 0.0;
            if aa_live && fp.debug == 0 {
                let mut tap = push;
                let taps: &[i32] = if fp.aa > 0.0 { &[5, 1, 2, 3, 4] } else { &[5] };
                for &s in taps {
                    tap.misc3[3] = s | (fp.aa_scope << 8);
                    let aenc = cb.new_compute_command_encoder();
                    aenc.set_compute_pipeline_state(&self.shade_pso);
                    aenc.set_acceleration_structure(0, Some(&self.sc.tlas));
                    aenc.set_buffer(1, Some(&self.sc.vbuf), 0);
                    aenc.set_buffer(2, Some(&self.sc.ibuf), 0);
                    aenc.set_buffer(3, Some(&self.sc.gbuf), 0);
                    aenc.set_buffer(4, Some(&self.sc.mbuf), 0);
                    aenc.set_buffer(5, Some(&self.sc.lbuf), 0);
                    aenc.set_buffer(6, Some(&self.sc.probe_buf), 0);
                    aenc.set_bytes(7, size_of::<Push>() as u64, &tap as *const _ as *const c_void);
                    aenc.set_buffer(8, Some(&t.radiance), 0);
                    aenc.set_buffer(9, Some(&t.albedo), 0);
                    aenc.set_buffer(10, Some(&t.pos), 0);
                    aenc.use_resource(&self.sc.tlas, MTLResourceUsage::Read);
                    for bl in &self.sc.blas_list {
                        aenc.use_resource(bl, MTLResourceUsage::Read);
                    }
                    aenc.dispatch_threads(MTLSize { width: low_w as u64, height: low_h as u64, depth: 1 }, MTLSize { width: 8, height: 8, depth: 1 });
                    aenc.end_encoding();
                }
            }
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

        // ---- stamps: tactic bubbles + the bottom HUD bar, burned into
        // out_tex (present + readback source) so they land in SHOT/DEMO
        // captures — the live "thinking" display is part of the game
        // picture, not shell UI.
        if !fp.stamps.is_empty() {
            let (ext_w, ext_h) = { let t = self.target.as_ref().unwrap(); (t.ext_w, t.ext_h) };
            let cbs = self.queue.new_command_buffer();
            let blit = cbs.new_blit_command_encoder();
            let mut staging: Vec<Texture> = Vec::new();
            {
                let t = self.target.as_ref().unwrap();
                for st in fp.stamps {
                    self.blit_overlay(blit, &t.out_tex, &st.pix, st.w, st.h, st.scale, st.x, st.y, ext_w, ext_h, &mut staging);
                }
            }
            blit.end_encoding();
            cbs.commit();
            cbs.wait_until_completed();
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
                    let (mc, mw, mh) = ov.menu;
                    // shared placement rule: centered game menus vs top-left
                    // tune panel (Vulkan twin uses the same fn)
                    let (mx, my) = overlay_origin(ov.menu_center, ext_w, ext_h, mw as u64 * menu_scale as u64, mh as u64 * menu_scale as u64, crate::menu::MENU_MARGIN as i64);
                    self.blit_overlay(blit, drawable.texture(), mc, mw, mh, menu_scale, mx, my, ext_w, ext_h, &mut staging);
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
