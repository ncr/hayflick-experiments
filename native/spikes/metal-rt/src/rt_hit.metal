// rt_hit.metal — Phase-0 spike kernel. VERIFIED to compile + link on this M2 Pro:
//   xcrun -sdk macosx metal -std=metal3.1 -c rt_hit.metal -o rt_hit.air   (exit 0)
//   xcrun -sdk macosx metallib rt_hit.air -o rt_hit.metallib              (exit 0)
// intersector<instancing, triangle_data>.intersect(ray, instance_acceleration_structure).
// Structs are byte-for-byte ports of the existing Vulkan shade.comp scalar-layout buffers
// (Vertex=32B, GeomInfo=16B, Material=48B) so the SAME concatenated device buffers bind
// unchanged when this grows into the real backend. float3 -> packed_float3 is load-bearing:
// MSL float3 is 16B-aligned; the Vulkan buffers are scalar-packed (vec3 = 12B).
#include <metal_stdlib>
#include <metal_raytracing>

using namespace metal;
using namespace metal::raytracing;

struct Vertex   { packed_float3 pos; packed_float3 nrm; float2 uv; };                 // 12+12+8  = 32 B
struct GeomInfo { uint indexOffset; uint vertexOffset; int materialId; uint pad; };   // 16 B
struct Material { float4 baseColor; float4 emissive; float metallic; float roughness; int texIndex; int pad; }; // 48 B

struct HitOut {
    float t;            // committed distance, -1.0 on miss
    int   primitive;    // primitive_id within the BLAS
    int   geom;         // instance_id == instanceCustomIndex == per-prim offset-table row
    int   mat;          // GeomInfo.materialId resolved through the offset table
    float nx, ny, nz;   // interpolated, normalized hit normal (world space)
    float u, v;         // interpolated UV
};

struct Cam {
    packed_float3 origin;
    packed_float3 right;
    packed_float3 up;
    packed_float3 dir;     // forward
    uint width;
    uint height;
};

kernel void rt_hit(
    instance_acceleration_structure accel   [[buffer(0)]],
    const device Vertex*   verts             [[buffer(1)]],
    const device uint*     indices           [[buffer(2)]],
    const device GeomInfo* geoms             [[buffer(3)]],
    const device Material* mats              [[buffer(4)]],
    constant Cam&          cam               [[buffer(5)]],
    device HitOut*         out               [[buffer(6)]],
    uint2 gid                                [[thread_position_in_grid]])
{
    if (gid.x >= cam.width || gid.y >= cam.height) return;
    uint idx = gid.y * cam.width + gid.x;

    float2 ndc = (float2(gid) + 0.5f) / float2(cam.width, cam.height) * 2.0f - 1.0f;
    float3 ro = float3(cam.origin);
    float3 rd = normalize(float3(cam.dir)
                          + ndc.x * float3(cam.right)
                          - ndc.y * float3(cam.up));

    ray r;
    r.origin       = ro;
    r.direction    = rd;
    r.min_distance = 0.001f;
    r.max_distance = INFINITY;

    intersector<instancing, triangle_data> isect;
    isect.assume_geometry_type(geometry_type::triangle);
    isect.force_opacity(forced_opacity::opaque);   // matches Vulkan gl_RayFlagsOpaqueEXT
    intersection_result<instancing, triangle_data> hit = isect.intersect(r, accel /*, mask defaults ~0U */);

    HitOut o;
    if (hit.type == intersection_type::none) {
        o.t = -1.0f; o.primitive = -1; o.geom = -1; o.mat = -1;
        o.nx = o.ny = o.nz = 0.0f; o.u = o.v = 0.0f;
        out[idx] = o;
        return;
    }

    // exact port of shade.comp:75-82 fetch path: offset-table + concatenated buffers
    int  gi   = int(hit.instance_id);            // == instanceCustomIndex == per-prim row
    uint prim = hit.primitive_id;
    float2 bc = hit.triangle_barycentric_coord;
    float b1 = bc.x, b2 = bc.y, b0 = 1.0f - bc.x - bc.y;

    GeomInfo g = geoms[gi];
    uint i0 = indices[g.indexOffset + prim * 3u + 0u] + g.vertexOffset;
    uint i1 = indices[g.indexOffset + prim * 3u + 1u] + g.vertexOffset;
    uint i2 = indices[g.indexOffset + prim * 3u + 2u] + g.vertexOffset;
    Vertex v0 = verts[i0], v1 = verts[i1], v2 = verts[i2];

    float3 n  = normalize(b0 * float3(v0.nrm) + b1 * float3(v1.nrm) + b2 * float3(v2.nrm));
    float2 uv = b0 * v0.uv + b1 * v1.uv + b2 * v2.uv;

    o.t = hit.distance; o.primitive = int(prim); o.geom = gi; o.mat = g.materialId;
    o.nx = n.x; o.ny = n.y; o.nz = n.z; o.u = uv.x; o.v = uv.y;
    out[idx] = o;
}
