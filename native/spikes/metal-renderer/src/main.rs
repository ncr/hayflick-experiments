//! Headless Metal renderer of a real `rt_probe::Scene`, on Apple Silicon.
//!
//! Mirrors `SceneGpu::build` (rt-probe/src/render.rs): one BLAS per primitive +
//! a TLAS of identity instances, the same concatenated geometry/material/light
//! buffers, the same NEE light list from `scan_lights`. Runs the ported
//! `shade.metal` kernel, reads back the HDR radiance buffer, and Reinhard-
//! tonemaps to a PNG on the CPU (the full stylized tonemap.comp port is a later
//! milestone). The image is a pure function of (scene, camera) — deterministic.
//!
//! M1 scope: primary visibility + sun/NEE direct light + RT-AO. GI probes and
//! the bindless texture array are deferred (see shade.metal header).
//!
//! Run:  cargo run -p metal-renderer            (writes /tmp/metal-render.png)
//!       DEBUG=4 cargo run -p metal-renderer    (AO term only; 1=albedo,3=direct)

use metal::*;
use std::ffi::c_void;
use std::mem::size_of;

use glam::{Mat4, Vec3};
use iso_core::{iso_basis, iso_camera_at, iso_screen_bounds, iso_target, ISO_R};
use rt_probe::config::Config;
use rt_probe::render::{near_hide_bits, scan_lights};
use rt_probe::scene::{hex_linear, LoadedImage, Material, Scene, Vertex};
use rt_probe::scenes::build_scene;

/// Push constants — byte-identical to shade.metal's `Push`.
#[repr(C)]
#[derive(Clone, Copy)]
struct Push {
    cam_right: [f32; 4], // xyz, w = ortho half-width
    cam_up: [f32; 4],    // xyz, w = ortho half-height
    cam_dir: [f32; 4],   // xyz, w = AO radius
    cam_pos: [f32; 4],   // xyz, w = AO strength
    misc: [i32; 4],      // W, H, aoRays, debug
    misc2: [i32; 4],     // lightCount, hasProbes, roomLights16, _
    env0: [f32; 4],      // sun, sky, fogD, fogH
}

/// Probe-bake push constants — byte-identical to probes.metal's `ProbePush`.
#[repr(C)]
#[derive(Clone, Copy)]
struct ProbePush {
    misc: [i32; 4],  // probeCount, raysTotal, bounces, raysThisBatch
    misc2: [i32; 4], // batchStartRay, bank, lightCount, _
    env0: [f32; 4],
}

/// Bayer 8×8 ordered-dither matrix (tonemap.comp), centred to [-0.5, 0.5) on use.
#[rustfmt::skip]
const BAYER8: [f32; 64] = [
     0., 32.,  8., 40.,  2., 34., 10., 42., 48., 16., 56., 24., 50., 18., 58., 26.,
    12., 44.,  4., 36., 14., 46.,  6., 38., 60., 28., 52., 20., 62., 30., 54., 22.,
     3., 35., 11., 43.,  1., 33.,  9., 41., 51., 19., 59., 27., 49., 17., 57., 25.,
    15., 47.,  7., 39., 13., 45.,  5., 37., 63., 31., 55., 23., 61., 29., 53., 21.,
];

fn luma(c: [f32; 3]) -> f32 {
    0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

fn smoothstep(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn make_buf<T: Copy>(device: &Device, data: &[T]) -> Buffer {
    let len = (std::mem::size_of_val(data) as u64).max(16);
    device.new_buffer_with_data(data.as_ptr() as *const c_void, len, MTLResourceOptions::StorageModeShared)
}

/// Overwrite a StorageModeShared buffer's contents in place (CPU → GPU memcpy).
/// Safe to call between waited command buffers (no in-flight GPU read).
unsafe fn write_buf<T: Copy>(b: &Buffer, data: &[T]) {
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

/// A small, unambiguous iso room: floor, two far walls, furniture boxes casting
/// shadows, a warm emissive lamp (NEE light), a cool overhead point light.
fn build_room() -> Scene {
    let mut s = Scene::new(); // lighting = [sun 1, sky 1, fog 0, fogH 1]
    let wall = hex_linear(0x6b6f78);
    let floor = hex_linear(0x4c5158);
    s.add_floor(-4.0, 4.0, -4.0, 4.0, 0.0, floor);
    // far walls only (-X, -Z) so the iso camera sees the interior (no dollhouse yet)
    s.add_box_world(Vec3::new(-4.0, 0.0, -4.0), Vec3::new(4.0, 2.5, -3.8), wall, [0.0; 4], 0.9, 0.0);
    s.add_box_world(Vec3::new(-4.0, 0.0, -3.8), Vec3::new(-3.8, 2.5, 4.0), wall, [0.0; 4], 0.9, 0.0);
    // furniture
    s.add_box_world(Vec3::new(-1.5, 0.0, -1.0), Vec3::new(-0.5, 1.0, 0.0), hex_linear(0xb5651d), [0.0; 4], 0.8, 0.0);
    s.add_box_world(Vec3::new(0.5, 0.0, 1.0), Vec3::new(1.5, 0.6, 2.0), hex_linear(0x3a7d44), [0.0; 4], 0.85, 0.0);
    s.add_box_world(Vec3::new(-2.5, 0.0, 1.5), Vec3::new(-2.0, 1.8, 2.0), hex_linear(0x9a9da5), [0.0; 4], 0.7, 0.0);
    // warm emissive lamp cube on a short stand → a NEE light (emissive ≥ 3)
    s.add_box_world(Vec3::new(1.6, 0.0, -2.0), Vec3::new(1.8, 1.2, -1.8), hex_linear(0x222222), [0.0; 4], 0.5, 0.0); // stand
    s.add_box_world(Vec3::new(1.45, 1.2, -2.15), Vec3::new(1.95, 1.6, -1.65), [1.0, 0.95, 0.85, 1.0], [16.0, 12.0, 7.0, 1.0], 0.5, 0.0);
    // cool overhead conceptual point light: [cx,cy,cz, radius, r,g,b, 0]
    s.point_lights.push([-0.5, 3.2, 0.0, 0.25, 7.0, 7.5, 9.0, 0.0]);
    s.recompute_bounds();
    s
}

fn main() {
    // Config from env (SCENE, EXPOSURE, AO, PROBE_RAYS, …) — same knobs as the
    // Vulkan renderer. SCENE=room is our hand-built test scene; grid/lab/house
    // come from rt_probe::scenes (house loads textured GLBs from assets/).
    let cfg = Config::from_env();
    // build_house's asset paths are relative to the repo root; `cargo run` sets
    // CWD to the crate dir, so hop up to the repo root (native/spikes/metal-renderer).
    let _ = std::env::set_current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../../.."));

    let out_path = std::env::var("SHOT").unwrap_or_else(|_| "/tmp/metal-render.png".to_string());
    let debug: i32 = std::env::var("DEBUG").ok().and_then(|s| s.parse().ok()).unwrap_or(0);
    let exposure: f32 = cfg.render.exposure;
    let ao_rays: i32 = std::env::var("AO_RAYS").ok().and_then(|s| s.parse().ok()).unwrap_or(8);

    let scene = match cfg.scene.as_str() {
        "room" => build_room(),
        _ => build_scene(&cfg).expect("build_scene"),
    };
    let scan = scan_lights(&scene).expect("scan_lights");
    println!(
        "scene: {} prims, {} tris, {} verts, {} real lights (+{} reserved)",
        scene.primitives.len(),
        scene.indices.len() / 3,
        scene.vertices.len(),
        scan.light_count,
        scan.lights.len() - scan.light_count as usize,
    );

    // ---- camera: frame the whole scene in an iso view, auto-sizing the buffer
    let (_d, right, up) = iso_basis(0.0);
    let (xmin, xmax, ymin, ymax) = iso_screen_bounds(scene.min, scene.max, right, up);
    let margin = 24.0_f32;
    let w = ((xmax - xmin).ceil() + 2.0 * margin).min(1600.0) as u32;
    let h = ((ymax - ymin).ceil() + 2.0 * margin).min(1600.0) as u32;
    let target = iso_target(scene.min, scene.max);
    let cam = iso_camera_at(scene.min, scene.max, w, h, 0.0, target);
    println!("camera: {w}x{h} low px, R={ISO_R:.2}, target=({:.2},{:.2},{:.2})", target.x, target.y, target.z);

    // ---- Metal device + geometry buffers (the concatenated-buffer scheme)
    let device = Device::system_default().expect("no Metal device");
    println!("device: {} (raytracing: {})", device.name(), device.supports_raytracing());
    let queue = device.new_command_queue();

    let vbuf = make_buf(&device, &scene.vertices);
    let ibuf = make_buf(&device, &scene.indices);
    let gbuf = make_buf(&device, &scene.geom_infos());
    let mbuf = make_buf(&device, &scene.materials);
    let lbuf = make_buf(&device, &scan.lights); // Vec<[f32;12]> == Light[]

    assert_eq!(size_of::<Vertex>(), 32);
    assert_eq!(size_of::<Material>(), 48);

    // textures: every scene image as a NEAREST sRGB texture; a 1×1 white stands
    // in for scenes with none so the bindless array is always ≥1 (never sampled
    // when texIndex == -1). Bound to texture slots 0..ntex in the shade pass.
    let mut texes: Vec<Texture> = scene.images.iter().map(|im| upload_tex(&device, im)).collect();
    if texes.is_empty() {
        texes.push(upload_tex(&device, &LoadedImage { width: 1, height: 1, pixels: vec![255, 255, 255, 255] }));
    }
    let ntex = texes.len();
    println!("textures: {ntex}");

    // ---- world-space irradiance probe grid (mirrors SceneGpu::build): scene
    // AABB + one-spacing pad, spacing widened until the count fits. Header
    // floats: origin.xyz, spacing, dims.xyz; then 2 banks × 20 floats/probe.
    let mut spacing = cfg.render.probe_spacing;
    let dims = loop {
        let pmin = scene.min - Vec3::splat(spacing);
        let pmax = scene.max + Vec3::splat(spacing);
        let ext = (pmax - pmin).max(Vec3::splat(0.1));
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
    let pmin = scene.min - Vec3::splat(spacing);
    let mut pdata = vec![0.0f32; 16 + probe_count as usize * 20 * 2];
    pdata[0] = pmin.x;
    pdata[1] = pmin.y;
    pdata[2] = pmin.z;
    pdata[3] = spacing;
    pdata[4] = dims[0] as f32;
    pdata[5] = dims[1] as f32;
    pdata[6] = dims[2] as f32;
    let probe_buf = make_buf(&device, &pdata);
    println!("probes: {}x{}x{} = {probe_count} @ {spacing:.2} wu", dims[0], dims[1], dims[2]);

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

    // ---- TLAS: one instance per primitive, instance i → blas i, instance_id
    // == i == the offset-table row. Masks mirror SceneGpu::build: dynamic runs
    // (doors/player) use their start transform + mask 0x05; static prims use
    // identity + a dollhouse near-wall hide mask (0x02 = primary-ray see-through
    // but still lit/occluding) computed for the settled yaw quarter 0.
    let dyn_list = scene.dynamic_list();
    let nprim = scene.primitives.len();
    let mut dyn_of_prim: Vec<Option<usize>> = vec![None; nprim];
    for (di, (_, first, count, _)) in dyn_list.iter().enumerate() {
        for s in *first..*first + *count {
            dyn_of_prim[s] = Some(di);
        }
    }
    let near = near_hide_bits(0);
    let to_packed = |m: Mat4| {
        let c = m.to_cols_array_2d(); // [col][row]
        [[c[0][0], c[0][1], c[0][2]], [c[1][0], c[1][1], c[1][2]], [c[2][0], c[2][1], c[2][2]], [c[3][0], c[3][1], c[3][2]]]
    };
    let instances: Vec<MTLAccelerationStructureInstanceDescriptor> = (0..nprim)
        .map(|i| {
            let (mask, m) = match dyn_of_prim[i] {
                Some(di) => (0x05u32, dyn_list[di].3),
                None => {
                    let b = scene.prim_hide_mask.get(i).copied().unwrap_or(0);
                    (if b != 0 && (b & near) == b { 0x02 } else { 0xff }, Mat4::IDENTITY)
                }
            };
            MTLAccelerationStructureInstanceDescriptor {
                transformation_matrix: to_packed(m),
                options: MTLAccelerationStructureInstanceOptions::Opaque,
                mask,
                intersection_function_table_offset: 0,
                acceleration_structure_index: i as u32,
            }
        })
        .collect();
    let inst_buf = make_buf(&device, &instances);

    let blas_refs: Vec<&AccelerationStructureRef> = blas_list.iter().map(|b| b.as_ref()).collect();
    let blas_arr = Array::from_slice(&blas_refs);
    let tlas_desc = InstanceAccelerationStructureDescriptor::descriptor();
    tlas_desc.set_instanced_acceleration_structures(blas_arr);
    tlas_desc.set_instance_count(instances.len() as u64);
    tlas_desc.set_instance_descriptor_buffer(&inst_buf);
    tlas_desc.set_instance_descriptor_buffer_offset(0);
    tlas_desc.set_instance_descriptor_stride(size_of::<MTLAccelerationStructureInstanceDescriptor>() as u64);
    tlas_desc.set_instance_descriptor_type(MTLAccelerationStructureInstanceDescriptorType::Default);
    let tlas_desc_ref: &AccelerationStructureDescriptorRef = &tlas_desc;
    let tsizes = device.acceleration_structure_sizes_with_descriptor(tlas_desc_ref);
    let tlas = device.new_acceleration_structure_with_size(tsizes.acceleration_structure_size);
    {
        let tscratch = device.new_buffer(tsizes.build_scratch_buffer_size.max(1), MTLResourceOptions::StorageModePrivate);
        let cb = queue.new_command_buffer();
        let enc = cb.new_acceleration_structure_command_encoder();
        enc.build_acceleration_structure(&tlas, tlas_desc_ref, &tscratch, 0);
        enc.end_encoding();
        cb.commit();
        cb.wait_until_completed();
        assert_eq!(cb.status(), MTLCommandBufferStatus::Completed, "TLAS build failed");
    }

    // ---- bake the two-bank GI probe cache (probes.metal). Bank 0 = practicals
    // off (sun/sky only, screens stay on); bank 1 = full. shade.metal lerps
    // them by roomLights — linear in emission, so any dim is exact, no re-bake.
    {
        let opts = CompileOptions::new();
        opts.set_language_version(MTLLanguageVersion::V3_0);
        let plib = device.new_library_with_source(include_str!("probes.metal"), &opts).expect("probes.metal compile");
        let pfunc = plib.get_function("bake_probes", None).unwrap();
        let ppso = device.new_compute_pipeline_state_with_function(&pfunc).unwrap();
        const BATCH: i32 = 32; // small per-command-buffer ray batch: keeps each
                               // bake dispatch well under the GPU watchdog timeout
        const BOUNCES: i32 = 4;
        let rays_total: i32 = std::env::var("RAYS").ok().and_then(|s| s.parse().ok()).unwrap_or(cfg.render.probe_rays);
        let t0 = std::time::Instant::now();
        for bank in 0..2i32 {
            // per-bank emission: materials follow so emissive surfaces bake right
            let mut lights = scan.lights.clone();
            let mut mats = scene.materials.clone();
            for (li, (mid, base, screen)) in scan.light_link.iter().enumerate() {
                let c = if bank == 1 || *screen { *base } else { [0.0; 3] };
                lights[li][4] = c[0];
                lights[li][5] = c[1];
                lights[li][6] = c[2];
                if *mid >= 0 {
                    mats[*mid as usize].emissive = [c[0], c[1], c[2], 1.0];
                }
            }
            unsafe {
                write_buf(&lbuf, &lights);
                write_buf(&mbuf, &mats);
            }
            let mut baked = 0;
            while baked < rays_total {
                let push = ProbePush {
                    misc: [probe_count as i32, rays_total, BOUNCES, BATCH],
                    misc2: [baked, bank, scan.light_count as i32, 0],
                    env0: scene.lighting,
                };
                let cb = queue.new_command_buffer();
                let enc = cb.new_compute_command_encoder();
                enc.set_compute_pipeline_state(&ppso);
                enc.set_acceleration_structure(0, Some(&tlas));
                enc.set_buffer(1, Some(&vbuf), 0);
                enc.set_buffer(2, Some(&ibuf), 0);
                enc.set_buffer(3, Some(&gbuf), 0);
                enc.set_buffer(4, Some(&mbuf), 0);
                enc.set_buffer(5, Some(&lbuf), 0);
                enc.set_buffer(6, Some(&probe_buf), 0);
                enc.set_bytes(7, size_of::<ProbePush>() as u64, &push as *const _ as *const c_void);
                enc.use_resource(&tlas, MTLResourceUsage::Read);
                for b in &blas_list {
                    enc.use_resource(b, MTLResourceUsage::Read);
                }
                enc.dispatch_threads(MTLSize { width: probe_count as u64, height: 1, depth: 1 }, MTLSize { width: 64, height: 1, depth: 1 });
                enc.end_encoding();
                cb.commit();
                cb.wait_until_completed();
                if cb.status() != MTLCommandBufferStatus::Completed {
                    panic!("probe bake batch failed (bank {bank}, ray {baked}): status {:?}", cb.status() as i64);
                }
                baked += BATCH;
            }
        }
        // restore the full (lit) light/material state for the shade pass
        unsafe {
            write_buf(&lbuf, &scan.lights);
            write_buf(&mbuf, &scene.materials);
        }
        println!("probes: baked {rays_total} rays × {probe_count} probes × 2 banks in {:.0} ms", t0.elapsed().as_secs_f32() * 1000.0);
    }

    // ---- compile the shade kernel at runtime + compute pipeline
    let opts = CompileOptions::new();
    opts.set_language_version(MTLLanguageVersion::V3_0);
    // NTEX_COUNT is the bindless array size — injected at compile so it matches
    // exactly the textures bound below (Metal needs a compile-time array size).
    let shade_src = include_str!("shade.metal").replace("NTEX_COUNT", &ntex.to_string());
    let lib = device.new_library_with_source(&shade_src, &opts).expect("shade.metal compile");
    let func = lib.get_function("shade", None).unwrap();
    let pso = device.new_compute_pipeline_state_with_function(&func).unwrap();

    let push = Push {
        cam_right: [cam.right.x, cam.right.y, cam.right.z, cam.half_w],
        cam_up: [cam.up.x, cam.up.y, cam.up.z, cam.half_h],
        cam_dir: [cam.dir.x, cam.dir.y, cam.dir.z, cfg.render.ao_r], // AO radius (wu)
        cam_pos: [cam.pos.x, cam.pos.y, cam.pos.z, cfg.render.ao],   // AO strength
        misc: [w as i32, h as i32, ao_rays, debug],
        misc2: [scan.light_count as i32, 1 /*hasProbes*/, 65536 /*roomLights=1.0*/, 0],
        env0: scene.lighting,
    };

    let out_buf = device.new_buffer(w as u64 * h as u64 * 16, MTLResourceOptions::StorageModeShared);

    let cb = queue.new_command_buffer();
    let enc = cb.new_compute_command_encoder();
    enc.set_compute_pipeline_state(&pso);
    enc.set_acceleration_structure(0, Some(&tlas));
    enc.set_buffer(1, Some(&vbuf), 0);
    enc.set_buffer(2, Some(&ibuf), 0);
    enc.set_buffer(3, Some(&gbuf), 0);
    enc.set_buffer(4, Some(&mbuf), 0);
    enc.set_buffer(5, Some(&lbuf), 0);
    enc.set_buffer(6, Some(&probe_buf), 0);
    enc.set_bytes(7, size_of::<Push>() as u64, &push as *const _ as *const c_void);
    enc.set_buffer(8, Some(&out_buf), 0);
    for (i, t) in texes.iter().enumerate() {
        enc.set_texture(i as u64, Some(t));
    }
    // residency: the compute pass can't infer the BLAS reached through the TLAS
    enc.use_resource(&tlas, MTLResourceUsage::Read);
    for b in &blas_list {
        enc.use_resource(b, MTLResourceUsage::Read);
    }
    let grid = MTLSize { width: w as u64, height: h as u64, depth: 1 };
    let tg = MTLSize { width: 8, height: 8, depth: 1 };
    enc.dispatch_threads(grid, tg);
    enc.end_encoding();
    let t0 = std::time::Instant::now();
    cb.commit();
    cb.wait_until_completed();
    assert_eq!(cb.status(), MTLCommandBufferStatus::Completed, "shade dispatch failed");
    println!("shade: {:.1} ms", t0.elapsed().as_secs_f32() * 1000.0);

    // ---- readback HDR radiance → tonemap → PNG. Default-look parity with
    // tonemap.comp: Reinhard → gamma → shadow dither (the only stylized stage
    // on by default; STYLE presets grade/bloom/outline/palette stay opt-in,
    // not yet ported). Shadow dither ordered-dithers the LUMA of shadow pixels
    // onto an N-band ladder (hue preserved), fading in below sdither_th.
    let sdither: f32 = std::env::var("SDITHER").ok().and_then(|s| s.parse().ok()).unwrap_or(1.0);
    let sdither_n: f32 = std::env::var("SDITHER_N").ok().and_then(|s| s.parse().ok()).unwrap_or(16.0);
    let sdither_th: f32 = std::env::var("SDITHER_TH").ok().and_then(|s| s.parse().ok()).unwrap_or(if cfg.scene == "game" { 0.75 } else { 0.35 });

    let n = (w * h) as usize;
    let radiance = unsafe { std::slice::from_raw_parts(out_buf.contents() as *const [f32; 4], n) };
    let mut rgba = vec![0u8; n * 4];
    let mut hit_px = 0usize;
    for (i, px) in radiance.iter().enumerate() {
        if px[0] + px[1] + px[2] > 0.0 {
            hit_px += 1;
        }
        let mut col = [0f32; 3];
        for c in 0..3 {
            let hdr = px[c] * exposure;
            col[c] = (hdr / (hdr + 1.0)).powf(1.0 / 2.2); // Reinhard + gamma
        }
        if sdither > 0.0 {
            let y = luma(col);
            let sw = (1.0 - smoothstep(sdither_th * 0.55, sdither_th, y)) * sdither;
            if sw > 1e-3 && y > 1e-4 {
                let (px_x, px_y) = ((i as u32 % w) as usize, (i as u32 / w) as usize);
                let dth = (BAYER8[(px_x & 7) + (px_y & 7) * 8] + 0.5) / 64.0 - 0.5;
                let l = (sdither_n.max(2.0)) - 1.0;
                let yq = ((y + dth / l).clamp(0.0, 1.0) * l + 0.5).floor() / l;
                let s = yq / y;
                for c in 0..3 {
                    col[c] = col[c] * (1.0 - sw) + col[c] * s * sw; // mix(col, col*s, sw)
                }
            }
        }
        for c in 0..3 {
            rgba[i * 4 + c] = (col[c].clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
        }
        rgba[i * 4 + 3] = 255;
    }

    let file = std::fs::File::create(&out_path).unwrap();
    let mut enc = png::Encoder::new(std::io::BufWriter::new(file), w, h);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header().unwrap().write_image_data(&rgba).unwrap();
    println!("wrote {out_path} ({w}x{h}); {hit_px}/{n} non-black px");
}
