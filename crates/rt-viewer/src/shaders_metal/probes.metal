// probes.metal — MSL port of rt-probe/src/shaders/probes.comp.
//
// World-space irradiance probe BAKE: each probe path-traces a deterministic
// batch of spherical-Fibonacci directions and accumulates incident radiance
// into a 6-axis ambient cube (HL2 style). Baked once into TWO banks (0 =
// practicals off / sun+sky only, 1 = full) that shade.metal lerps by the
// room-lights dim. Deterministic — fixed per-probe/per-ray seeds reproduce the
// cache bit-for-bit. Probe rays use mask 0x0A: skip dynamics (0x04 absent), hit
// every static wall (0xff) so baked transport is yaw-invariant (walls are solid;
// the CAVE_ROI see-through is a primary-ray-only effect).
//
// Double-count contract with shade.metal: probe rays NEVER count emissive seen
// directly (the pixel samples lights via NEE); they DO evaluate sun + NEE light
// at each hit and count sky on miss.
//
// Textures deferred (M3): albedo = baseColor, matching shade.metal's M2 state.

#include <metal_stdlib>
#include <metal_raytracing>
using namespace metal;
using namespace metal::raytracing;

struct Vertex   { packed_float3 pos; packed_float3 nrm; float2 uv; };
struct GeomInfo { uint indexOffset; uint vertexOffset; int materialId; uint pad; };
struct Material { float4 baseColor; float4 emissive; float metallic; float roughness; int texIndex; int pad; };
struct Light    { float4 posRad; float4 color; float4 dir; };

struct ProbePush {
    int4   misc;  // probeCount, raysTotal (Fibonacci N), bounces, raysThisBatch
    int4   misc2; // batchStartRay, bank, lightCount, firstProbe (Stage-2 sub-range base)
    int4   misc3; // Stage-2 refresh box: (boxLoX, boxLoY, boxLoZ, boxWidthX); w>0 = box mode
    float4 env0;  // sunScale, skyScale, fogDensity, fogHeight
    float4 env1;  // sun/sky-as-data (Faza 1b): sun dir xyz (normalized), w = ground tint r
    float4 env2;  // sun tint rgb, w = ground tint g
    float4 env3;  // sky horizon tint rgb, w = ground tint b
    float4 env4;  // sky zenith tint rgb, _
    float4 roll;  // DDGI rolling refresh: (decay, wrapRays, _, _); decay>0 = rolling
};

constant float PI = 3.14159265;
constant float TWOPI = 6.2831853;
constant uint PROBE_MASK = 0x0Au;

static uint hashp(uint x){ x^=x>>16; x*=0x7feb352du; x^=x>>15; x*=0x846ca68bu; x^=x>>16; return x; }
static float rnd(thread uint& s){ s=hashp(s); return float(s)*(1.0/4294967296.0); }

static float3 skyCol(float3 d, constant ProbePush& pc){
    float t = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
    float3 horizon = pc.env3.rgb; // look-authored (sun/sky-as-data, Faza 1b)
    float3 zenith  = pc.env4.rgb;
    float3 ground  = float3(pc.env1.w, pc.env2.w, pc.env3.w); // look-authored void tint
    float3 c = (d.y > 0.0) ? mix(horizon, zenith, pow(t, 1.4)) : mix(horizon, ground, clamp(-d.y * 3.0, 0.0, 1.0));
    return c * 0.18 * pc.env0.y;
}

struct Hit { float t; float3 n; float2 uv; int mat; };

static bool trace(float3 o, float3 dir, float tmax, instance_acceleration_structure accel,
                  device const Vertex* verts, device const uint* indices, device const GeomInfo* geoms, thread Hit& h){
    ray r; r.origin=o; r.direction=dir; r.min_distance=0.001; r.max_distance=tmax;
    intersector<instancing, triangle_data> isect;
    isect.assume_geometry_type(geometry_type::triangle);
    isect.force_opacity(forced_opacity::opaque);
    intersection_result<instancing, triangle_data> it = isect.intersect(r, accel, PROBE_MASK);
    if (it.type == intersection_type::none) return false;
    h.t = it.distance;
    int gi = int(it.instance_id);
    uint prim = it.primitive_id;
    float2 bc = it.triangle_barycentric_coord;
    float b0 = 1.0 - bc.x - bc.y, b1 = bc.x, b2 = bc.y;
    GeomInfo g = geoms[gi];
    uint i0 = indices[g.indexOffset + prim*3u + 0u] + g.vertexOffset;
    uint i1 = indices[g.indexOffset + prim*3u + 1u] + g.vertexOffset;
    uint i2 = indices[g.indexOffset + prim*3u + 2u] + g.vertexOffset;
    Vertex v0 = verts[i0], v1 = verts[i1], v2 = verts[i2];
    h.n  = normalize(b0*float3(v0.nrm) + b1*float3(v1.nrm) + b2*float3(v2.nrm));
    h.uv = b0*v0.uv + b1*v1.uv + b2*v2.uv;
    h.mat = g.materialId;
    return true;
}

static bool occluded(float3 o, float3 dir, float tmax, instance_acceleration_structure accel){
    ray r; r.origin=o; r.direction=dir; r.min_distance=0.001; r.max_distance=tmax;
    intersector<instancing, triangle_data> isect;
    isect.assume_geometry_type(geometry_type::triangle);
    isect.force_opacity(forced_opacity::opaque);
    isect.accept_any_intersection(true);
    return isect.intersect(r, accel, PROBE_MASK).type != intersection_type::none;
}

static float3 radiance(float3 o, float3 d, uint seed, constant ProbePush& pc,
                       instance_acceleration_structure accel, device const Vertex* verts,
                       device const uint* indices, device const GeomInfo* geoms,
                       device const Material* mats, device const Light* lights){
    int bounces = pc.misc.z;
    float3 sunDir = pc.env1.xyz; // normalized CPU-side (EnvBlock::pack)
    float3 sun = pc.env2.rgb * 6.0 * pc.env0.x;
    float3 thru = float3(1.0), col = float3(0.0);
    for (int b = 0; b <= bounces; b++){
        Hit h;
        if (!trace(o, d, 300.0, accel, verts, indices, geoms, h)) { col += thru * skyCol(d, pc); break; }
        Material m = mats[h.mat];
        float3 albedo = m.baseColor.rgb;  // M3: *= texture
        float3 n = h.n; if (dot(n, d) > 0.0) n = -n;
        float3 p = o + h.t * d + n * 0.003;

        float ndl = max(dot(n, sunDir), 0.0);
        if (pc.env0.x > 0.0 && ndl > 0.0 && !occluded(p, sunDir, 200.0, accel)) col += thru * albedo * sun * ndl;

        int lc = pc.misc2.z;
        if (lc > 0){
            const int NEE_S = 4;
            float lw = float(lc) / float(NEE_S);
            for (int ls = 0; ls < NEE_S; ls++){
                int li = clamp(int(rnd(seed) * float(lc)), 0, lc - 1);
                Light lt = lights[li];
                float3 toL = lt.posRad.xyz - p;
                float dist = max(length(toL), 1e-4);
                if (dist <= lt.posRad.w) continue;
                float3 ldir = toL / dist;
                float ndl2 = dot(n, ldir);
                if (ndl2 <= 0.0) continue;
                float emit = lt.dir.w > 0.0 ? 2.0 * max(dot(-ldir, lt.dir.xyz), 0.0) : 1.0;
                if (emit <= 0.0) continue;
                float sinT = clamp(lt.posRad.w / dist, 0.0, 1.0);
                float omega = TWOPI * (1.0 - sqrt(1.0 - sinT * sinT));
                if (!occluded(p, ldir, dist - lt.posRad.w, accel)){
                    float3 c = thru * albedo * (1.0/PI) * lt.color.rgb * ndl2 * omega * lw * emit;
                    col += min(c, float3(2.5)); // firefly clamp
                }
            }
        }

        thru *= albedo;
        float3 t1 = normalize(abs(n.y) < 0.99 ? cross(n, float3(0,1,0)) : cross(n, float3(1,0,0)));
        float3 t2 = cross(n, t1);
        float r1 = rnd(seed), r2 = rnd(seed);
        float phi = TWOPI * r1, sr = sqrt(r2), cz = sqrt(1.0 - r2);
        d = normalize(t1*cos(phi)*sr + t2*sin(phi)*sr + n*cz);
        o = p;
        if (max(thru.r, max(thru.g, thru.b)) < 0.02) break;
    }
    return col;
}

kernel void bake_probes(
    instance_acceleration_structure accel [[buffer(0)]],
    device const Vertex*   verts   [[buffer(1)]],
    device const uint*     indices [[buffer(2)]],
    device const GeomInfo* geoms   [[buffer(3)]],
    device const Material* mats    [[buffer(4)]],
    device const Light*    lights  [[buffer(5)]],
    device float*          pd      [[buffer(6)]],
    constant ProbePush&    pc      [[buffer(7)]],
    uint3 gid [[thread_position_in_grid]])
{
    float3 origin = float3(pd[0], pd[1], pd[2]);
    float spacing = pd[3];
    int nx = int(pd[4]), ny = int(pd[5]);
    // Two dispatch modes (twin of probes.comp). BAKE (misc3.w == 0): pi = gid.x +
    // firstProbe (misc2.w), a full bake passing 0. Stage-2 REFRESH (misc3.w > 0):
    // the dirty region is a lattice box dispatched as a 3D grid, thread (a,b,c) →
    // the box-local probe. pi drives the decode, payload offset AND ray seed, so
    // either path reproduces the full bake for probe pi exactly.
    uint pi;
    if (pc.misc3.w > 0) {
        if (int(gid.x) >= pc.misc3.w) return; // x padded; y,z exact
        int3 lo = pc.misc3.xyz;
        pi = uint((lo.x + int(gid.x)) + (lo.y + int(gid.y)) * nx + (lo.z + int(gid.z)) * nx * ny);
    } else {
        pi = gid.x + uint(pc.misc2.w);
        if (pi >= uint(pc.misc.x)) return;
    }
    int3 g = int3(int(pi) % nx, (int(pi) / nx) % ny, int(pi) / (nx * ny));
    float3 P = origin + float3(g) * spacing;
    uint base = 16u + (uint(pc.misc2.y) * uint(pc.misc.x) + pi) * 20u;

    float3 sums[6];
    for (int f = 0; f < 6; f++) sums[f] = float3(pd[base + f*3u], pd[base + f*3u + 1u], pd[base + f*3u + 2u]);
    float count = pd[base + 18u];

    // DDGI rolling refresh. roll = (decay, wrapRays, primeCount, _).
    // prime (roll.z>0, one-shot as a region enters rolling): rescale sums+count so
    // count==primeCount, preserving the estimate sum/count — otherwise the dense
    // startup bake's huge count makes the blend crawl. decay (roll.x>0): age old
    // samples out (scale both) so a geometry change is tracked over ~N/K frames.
    if (pc.roll.z > 0.0) {
        float fac = count > 0.0 ? pc.roll.z / count : 1.0;
        for (int i = 0; i < 6; i++) sums[i] *= fac;
        count = pc.roll.z;
    } else if (pc.roll.x > 0.0) {
        for (int i = 0; i < 6; i++) sums[i] *= pc.roll.x;
        count *= pc.roll.x;
    }

    int N = pc.misc.y;
    for (int k = 0; k < pc.misc.w; k++){
        int ri = pc.misc2.x + k;
        // rolling wraps the ray index (cycles the whole N-set across frames); a
        // one-shot bake instead stops at the end of its batch.
        if (pc.roll.y > 0.0) ri = ri % N; else if (ri >= N) break;
        float zc = 1.0 - (2.0 * float(ri) + 1.0) / float(N);
        float phi = TWOPI * fract(float(ri) * 0.6180339887);
        float rr = sqrt(max(0.0, 1.0 - zc * zc));
        float3 d = float3(rr * cos(phi), zc, rr * sin(phi));
        float3 L = radiance(P, d, hashp(pi * 9781u + uint(ri) * 6271u + 1u), pc, accel, verts, indices, geoms, mats, lights);
        sums[0] += L * max( d.x, 0.0); sums[1] += L * max(-d.x, 0.0);
        sums[2] += L * max( d.y, 0.0); sums[3] += L * max(-d.y, 0.0);
        sums[4] += L * max( d.z, 0.0); sums[5] += L * max(-d.z, 0.0);
        count += 1.0;
    }

    for (int f = 0; f < 6; f++){
        pd[base + f*3u] = sums[f].x;
        pd[base + f*3u + 1u] = sums[f].y;
        pd[base + f*3u + 2u] = sums[f].z;
    }
    pd[base + 18u] = count;
}
