//! Phase-0 feasibility spike: prove the M2 Pro can build a Metal acceleration
//! structure (BLAS + TLAS) and run a ray-query intersect from a COMPUTE kernel
//! via the `metal` (metal-rs) crate, returning a correct hit/miss.
//!
//! This is the GATE for the native Metal backend (see
//! /Users/ncr/.claude/plans/dazzling-skipping-chipmunk.md, Phase 0). The
//! workflow already verified, on this exact machine: (a) metal-rs 0.33.0 links
//! every RT symbol, (b) rt_hit.metal compiles via the offline toolchain, (c)
//! the device reports supportsRaytracing / Apple8 and built a BLAS on GPU. The
//! one remaining end-to-end gap — metal-rs DRIVING a build + intersect +
//! readback that returns the right answer — is what this binary closes.
//!
//! Geometry: one triangle at z=+1 facing the camera at the origin looking +z.
//! Centre pixel ray hits it (t>0, geom/mat/prim == 0); a corner ray misses.

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("metal-rt-spike is macOS-only (needs Metal). Skipping on this platform.");
}

#[cfg(target_os = "macos")]
fn main() {
    use metal::*;
    use std::ffi::c_void;
    use std::mem::size_of;

    // --- byte-exact host mirrors of rt_hit.metal's scalar-layout structs ---
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Vertex { pos: [f32; 3], nrm: [f32; 3], uv: [f32; 2] } // 32 B
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct GeomInfo { index_offset: u32, vertex_offset: u32, material_id: i32, pad: u32 } // 16 B
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Material { base: [f32; 4], emissive: [f32; 4], metallic: f32, roughness: f32, tex: i32, pad: i32 } // 48 B
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Cam { origin: [f32; 3], right: [f32; 3], up: [f32; 3], dir: [f32; 3], width: u32, height: u32 } // 56 B
    #[repr(C)]
    #[derive(Clone, Copy, Default, Debug)]
    struct HitOut { t: f32, primitive: i32, geom: i32, mat: i32, nx: f32, ny: f32, nz: f32, u: f32, v: f32 } // 36 B

    // open-risk #8: scalar byte-match is load-bearing. Assert sizes up front.
    assert_eq!(size_of::<Vertex>(), 32);
    assert_eq!(size_of::<GeomInfo>(), 16);
    assert_eq!(size_of::<Material>(), 48);
    assert_eq!(size_of::<HitOut>(), 36);

    let device = Device::system_default().expect("no Metal device");
    println!("device: {}", device.name());
    println!("supports_raytracing: {}", device.supports_raytracing());
    let queue = device.new_command_queue();

    let shared = MTLResourceOptions::StorageModeShared;
    let private = MTLResourceOptions::StorageModePrivate;

    // 1. geometry — one 32B-stride Vertex triangle (BLAS reads pos @ offset 0;
    //    the kernel reads the same buffer for normals/uv — exactly the renderer's scheme).
    let verts = [
        Vertex { pos: [-0.5, -0.5, 1.0], nrm: [0.0, 0.0, -1.0], uv: [0.0, 0.0] },
        Vertex { pos: [ 0.5, -0.5, 1.0], nrm: [0.0, 0.0, -1.0], uv: [1.0, 0.0] },
        Vertex { pos: [ 0.0,  0.5, 1.0], nrm: [0.0, 0.0, -1.0], uv: [0.5, 1.0] },
    ];
    let indices: [u32; 3] = [0, 1, 2];
    let geom = GeomInfo { index_offset: 0, vertex_offset: 0, material_id: 0, pad: 0 };
    let mat = Material { base: [0.8, 0.2, 0.2, 1.0], emissive: [0.0; 4], metallic: 0.0, roughness: 1.0, tex: -1, pad: 0 };

    let vbuf = device.new_buffer_with_data(verts.as_ptr() as *const c_void, size_of::<Vertex>() as u64 * 3, shared);
    let ibuf = device.new_buffer_with_data(indices.as_ptr() as *const c_void, 12, shared);
    let gbuf = device.new_buffer_with_data(&geom as *const _ as *const c_void, 16, shared);
    let mbuf = device.new_buffer_with_data(&mat as *const _ as *const c_void, 48, shared);

    // 2-3. BLAS triangle geometry + primitive descriptor
    let tri = AccelerationStructureTriangleGeometryDescriptor::descriptor();
    tri.set_vertex_buffer(Some(&vbuf));
    tri.set_vertex_buffer_offset(0);
    tri.set_vertex_stride(size_of::<Vertex>() as u64); // 32 — read pos from each stride
    tri.set_vertex_format(MTLAttributeFormat::Float3);
    tri.set_index_buffer(Some(&ibuf));
    tri.set_index_buffer_offset(0);
    tri.set_index_type(MTLIndexType::UInt32);
    tri.set_triangle_count(1);

    let geom_ref: &AccelerationStructureGeometryDescriptorRef = &tri;
    let geoms_arr = Array::from_slice(&[geom_ref]);
    let blas_desc = PrimitiveAccelerationStructureDescriptor::descriptor();
    blas_desc.set_geometry_descriptors(geoms_arr);
    let blas_desc_ref: &AccelerationStructureDescriptorRef = &blas_desc;

    // 4. size + allocate BLAS
    let bsizes = device.acceleration_structure_sizes_with_descriptor(blas_desc_ref);
    let blas = device.new_acceleration_structure_with_size(bsizes.acceleration_structure_size);
    let bscratch = device.new_buffer(bsizes.build_scratch_buffer_size.max(1), private);

    // 5. one instance, identity transform (4 cols of float3), mask 0xff (renderer's static-prim mask)
    let inst = MTLAccelerationStructureInstanceDescriptor {
        // [[f32;3];4] = 4 columns of a packed 3x4 transform (col-major); identity + zero translation.
        transformation_matrix: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [0.0, 0.0, 0.0]],
        options: MTLAccelerationStructureInstanceOptions::Opaque,
        mask: 0xff,
        intersection_function_table_offset: 0,
        acceleration_structure_index: 0,
    };
    let inst_buf = device.new_buffer_with_data(&inst as *const _ as *const c_void, size_of::<MTLAccelerationStructureInstanceDescriptor>() as u64, shared);

    // 6. TLAS descriptor over the one BLAS
    let blas_arr = Array::from_slice(&[&blas as &AccelerationStructureRef]);
    let tlas_desc = InstanceAccelerationStructureDescriptor::descriptor();
    tlas_desc.set_instanced_acceleration_structures(blas_arr);
    tlas_desc.set_instance_count(1);
    tlas_desc.set_instance_descriptor_buffer(&inst_buf);
    tlas_desc.set_instance_descriptor_buffer_offset(0);
    tlas_desc.set_instance_descriptor_stride(size_of::<MTLAccelerationStructureInstanceDescriptor>() as u64);
    tlas_desc.set_instance_descriptor_type(MTLAccelerationStructureInstanceDescriptorType::Default);
    let tlas_desc_ref: &AccelerationStructureDescriptorRef = &tlas_desc;
    let tsizes = device.acceleration_structure_sizes_with_descriptor(tlas_desc_ref);
    let tlas = device.new_acceleration_structure_with_size(tsizes.acceleration_structure_size);
    let tscratch = device.new_buffer(tsizes.build_scratch_buffer_size.max(1), private);

    // 7. build BLAS then TLAS on the GPU (same encoder serializes them)
    let cb = queue.new_command_buffer();
    let enc = cb.new_acceleration_structure_command_encoder();
    enc.build_acceleration_structure(&blas, blas_desc_ref, &bscratch, 0);
    enc.build_acceleration_structure(&tlas, tlas_desc_ref, &tscratch, 0);
    enc.end_encoding();
    cb.commit();
    cb.wait_until_completed();
    assert_eq!(cb.status(), MTLCommandBufferStatus::Completed, "AS build did not complete");

    // 8. runtime-compile the MSL kernel (no offline metallib needed — verified working)
    let opts = CompileOptions::new();
    opts.set_language_version(MTLLanguageVersion::V3_0);
    let lib = device
        .new_library_with_source(include_str!("rt_hit.metal"), &opts)
        .expect("rt_hit.metal failed to compile at runtime");
    let func = lib.get_function("rt_hit", None).unwrap();
    let pso = device.new_compute_pipeline_state_with_function(&func).unwrap();

    // 9. output buffer (HitOut per pixel over a tiny grid)
    let (w, h) = (8u64, 8u64);
    let hit_buf = device.new_buffer(w * h * size_of::<HitOut>() as u64, shared);

    let cam = Cam {
        origin: [0.0, 0.0, 0.0],
        right: [1.0, 0.0, 0.0],
        up: [0.0, 1.0, 0.0],
        dir: [0.0, 0.0, 1.0],
        width: w as u32,
        height: h as u32,
    };

    // 10. dispatch
    let cb2 = queue.new_command_buffer();
    let cenc = cb2.new_compute_command_encoder();
    cenc.set_compute_pipeline_state(&pso);
    cenc.set_acceleration_structure(0, Some(&tlas));
    cenc.set_buffer(1, Some(&vbuf), 0);
    cenc.set_buffer(2, Some(&ibuf), 0);
    cenc.set_buffer(3, Some(&gbuf), 0);
    cenc.set_buffer(4, Some(&mbuf), 0);
    cenc.set_bytes(5, size_of::<Cam>() as u64, &cam as *const _ as *const c_void);
    cenc.set_buffer(6, Some(&hit_buf), 0);
    // residency (open-risk #5): the compute pass can't infer the BLAS reached via
    // the TLAS — make both resident or the traversal faults / returns garbage.
    cenc.use_resource(&blas, MTLResourceUsage::Read);
    cenc.use_resource(&tlas, MTLResourceUsage::Read);
    let grid = MTLSize { width: w, height: h, depth: 1 };
    let tg = MTLSize { width: 8, height: 8, depth: 1 };
    cenc.dispatch_threads(grid, tg);
    cenc.end_encoding();
    cb2.commit();
    cb2.wait_until_completed();
    assert_eq!(cb2.status(), MTLCommandBufferStatus::Completed, "compute dispatch did not complete");

    // 11. readback + assert
    let hits = unsafe { std::slice::from_raw_parts(hit_buf.contents() as *const HitOut, (w * h) as usize) };
    let centre = hits[(h / 2 * w + w / 2) as usize];
    let corner = hits[0];
    println!("centre pixel: {centre:?}");
    println!("corner pixel: {corner:?}");

    assert!(centre.t > 0.0, "centre ray must hit the triangle (t>0), got {}", centre.t);
    assert_eq!(centre.geom, 0, "centre hit geom (instance_id)");
    assert_eq!(centre.mat, 0, "centre hit materialId via offset table");
    assert_eq!(centre.primitive, 0, "centre hit primitive_id");
    assert!((centre.nz - (-1.0)).abs() < 1e-5, "interpolated normal should be (0,0,-1), got ({},{},{})", centre.nx, centre.ny, centre.nz);
    assert_eq!(corner.t, -1.0, "corner ray must miss");

    let hit_count = hits.iter().filter(|h| h.t > 0.0).count();
    println!(
        "OK: metal-rs built BLAS+TLAS and ray-query intersected. centre t={} n=({},{},{}); {}/{} pixels hit.",
        centre.t, centre.nx, centre.ny, centre.nz, hit_count, w * h
    );
}
