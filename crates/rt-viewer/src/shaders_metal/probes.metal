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
    int4   misc2; // batchStartRay, bank, lightCount, _
    float4 env0;  // sunScale, skyScale, fogDensity, fogHeight
};

constant float PI = 3.14159265;
constant float TWOPI = 6.2831853;
constant uint PROBE_MASK = 0x0Au;

static uint hashp(uint x){ x^=x>>16; x*=0x7feb352du; x^=x>>15; x*=0x846ca68bu; x^=x>>16; return x; }
static float rnd(thread uint& s){ s=hashp(s); return float(s)*(1.0/4294967296.0); }

static float3 skyCol(float3 d, float skyScale){
    float t = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
    float3 horizon = float3(0.80, 0.83, 0.90);
    float3 zenith  = float3(0.28, 0.45, 0.92);
    float3 ground  = float3(0.14, 0.13, 0.12);
    float3 c = (d.y > 0.0) ? mix(horizon, zenith, pow(t, 1.4)) : mix(horizon, ground, clamp(-d.y * 3.0, 0.0, 1.0));
    return c * 0.18 * skyScale;
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
    float3 sunDir = normalize(float3(0.62, 0.55, 0.38));
    float3 sun = float3(1.0, 0.88, 0.70) * 6.0 * pc.env0.x;
    float3 thru = float3(1.0), col = float3(0.0);
    for (int b = 0; b <= bounces; b++){
        Hit h;
        if (!trace(o, d, 300.0, accel, verts, indices, geoms, h)) { col += thru * skyCol(d, pc.env0.y); break; }
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
    uint gid [[thread_position_in_grid]])
{
    if (gid >= uint(pc.misc.x)) return;
    float3 origin = float3(pd[0], pd[1], pd[2]);
    float spacing = pd[3];
    int nx = int(pd[4]), ny = int(pd[5]);
    int3 g = int3(int(gid) % nx, (int(gid) / nx) % ny, int(gid) / (nx * ny));
    float3 P = origin + float3(g) * spacing;
    uint base = 16u + (uint(pc.misc2.y) * uint(pc.misc.x) + gid) * 20u;

    float3 sums[6];
    for (int f = 0; f < 6; f++) sums[f] = float3(pd[base + f*3u], pd[base + f*3u + 1u], pd[base + f*3u + 2u]);
    float count = pd[base + 18u];

    int N = pc.misc.y;
    for (int k = 0; k < pc.misc.w; k++){
        int ri = pc.misc2.x + k;
        if (ri >= N) break;
        float zc = 1.0 - (2.0 * float(ri) + 1.0) / float(N);
        float phi = TWOPI * fract(float(ri) * 0.6180339887);
        float rr = sqrt(max(0.0, 1.0 - zc * zc));
        float3 d = float3(rr * cos(phi), zc, rr * sin(phi));
        float3 L = radiance(P, d, hashp(gid * 9781u + uint(ri) * 6271u + 1u), pc, accel, verts, indices, geoms, mats, lights);
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
