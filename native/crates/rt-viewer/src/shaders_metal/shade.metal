// shade.metal — MSL port of rt-probe/src/shaders/shade.comp.
//
// Deterministic per-frame ray-traced shade: one primary ray per pixel centre,
// exact shadow rays to the sun + every NEE light, short-range RT-AO, and an
// (optional) world-space irradiance-probe GI lookup. No randomness → a fixed
// camera gives a bit-identical image. This is the Apple-Silicon twin of the
// Vulkan ray_query shader; structs are byte-for-byte ports (packed_float3 to
// match GL_EXT_scalar_block_layout vec3 = 12 B).
//
// Differences from the GLSL while the headless renderer grows:
//   * textures (binding 6 in Vulkan) deferred → albedo = baseColor (M3 adds the
//     bindless texture array). texIndex is ignored here.
//   * probe GI gated by pc.hasProbes; M1 binds a dummy header and skips it.
// Everything else (sun NEE, light NEE incl. spotlight/screen falloff, AO, fog,
// sky, the +1/64 px tie bias) is a faithful port.

#include <metal_stdlib>
#include <metal_raytracing>
using namespace metal;
using namespace metal::raytracing;

struct Vertex   { packed_float3 pos; packed_float3 nrm; float2 uv; };                 // 32 B
struct GeomInfo { uint indexOffset; uint vertexOffset; int materialId; uint pad; };   // 16 B
struct Material { float4 baseColor; float4 emissive; float metallic; float roughness; int texIndex; int pad; }; // 48 B
struct Light    { float4 posRad; float4 color; float4 dir; };                         // 48 B

// Mirrors the Rust Push struct (see main.rs). cam*.w carries half-extents / AO.
struct Push {
    float4 camRight;  // xyz basis, w = ortho half-width (wu)
    float4 camUp;     // xyz basis, w = ortho half-height (wu)
    float4 camDir;    // xyz forward, w = RT-AO radius (wu)
    float4 camPos;    // xyz eye,     w = RT-AO strength
    int4   misc;      // W, H, aoRays, debug
    int4   misc2;     // lightCount, hasProbes, roomLights16, _
    float4 env0;      // sunScale, skyScale, fogDensity, fogHeight
    float4 roi;       // CAVE_ROI: player world xyz, w = disc radius (low-res px)
    float4 roi2;      // projected player px.xy, z = disc falloff px, w = enabled (>0.5)
    float4 look;      // spec strength, bump strength, bump scale (wu^-1), gloss (0..1)
    float4 look2;     // gi scale, _, _, _
};

constant float PI    = 3.14159265;
constant float TWOPI = 6.2831853;
constant float TIE   = 1.0 / 64.0;

// 4x4 ordered-Bayer threshold in [0,1) — byte-identical twin of shade.comp's
// bayer4 (same matrix, same shift) so the dithered reveal matches Vulkan.
static float bayer4(int2 lp){
  const float B[16] = {0.,8.,2.,10., 12.,4.,14.,6., 3.,11.,1.,9., 15.,7.,13.,5.};
  return (B[(lp.x & 3) + (lp.y & 3) * 4] + 0.5) / 16.0;
}

// NEAREST + REPEAT, no mips — one atlas texel = one game pixel (the pixel-perfect
// invariant; never LinearFilter on this chain). Base-colour textures are sampled
// from sRGB-format MTLTextures, so the GPU returns linear, matching hex_linear.
constexpr sampler texSamp(filter::nearest, mip_filter::none, address::repeat);

struct Hit { float t; float3 n; float2 uv; int mat; };

static float3 skyCol(float3 d, constant Push& pc) {
    float t = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
    float3 horizon = float3(0.80, 0.83, 0.90);
    float3 zenith  = float3(0.28, 0.45, 0.92);
    float3 ground  = float3(0.14, 0.13, 0.12);
    float3 c = (d.y > 0.0) ? mix(horizon, zenith, pow(t, 1.4))
                           : mix(horizon, ground, clamp(-d.y * 3.0, 0.0, 1.0));
    return c * 0.18 * pc.env0.y;
}

static float fogOD(float3 o, float3 d, float t, constant Push& pc) {
    float D = pc.env0.z, H = pc.env0.w;
    if (abs(d.y) < 1e-4) return D * exp(-o.y / H) * t;
    return D * (H / d.y) * (exp(-o.y / H) - exp(-(o.y + d.y * t) / H));
}

// closest-hit trace with the offset-table geometry fetch (shade.comp:65-84)
static bool trace(float3 o, float3 dir, float tmax, uint mask,
                  instance_acceleration_structure accel,
                  device const Vertex* verts, device const uint* indices,
                  device const GeomInfo* geoms, thread Hit& h) {
    ray r; r.origin = o; r.direction = dir; r.min_distance = 0.001; r.max_distance = tmax;
    intersector<instancing, triangle_data> isect;
    isect.assume_geometry_type(geometry_type::triangle);
    isect.force_opacity(forced_opacity::opaque);
    intersection_result<instancing, triangle_data> it = isect.intersect(r, accel, mask);
    if (it.type == intersection_type::none) return false;
    h.t = it.distance;
    int gi = int(it.instance_id);            // == instanceCustomIndex == prim row
    uint prim = it.primitive_id;
    float2 bc = it.triangle_barycentric_coord;
    float b0 = 1.0 - bc.x - bc.y, b1 = bc.x, b2 = bc.y;
    GeomInfo g = geoms[gi];
    uint i0 = indices[g.indexOffset + prim * 3u + 0u] + g.vertexOffset;
    uint i1 = indices[g.indexOffset + prim * 3u + 1u] + g.vertexOffset;
    uint i2 = indices[g.indexOffset + prim * 3u + 2u] + g.vertexOffset;
    Vertex v0 = verts[i0], v1 = verts[i1], v2 = verts[i2];
    h.n  = normalize(b0 * float3(v0.nrm) + b1 * float3(v1.nrm) + b2 * float3(v2.nrm));
    h.uv = b0 * v0.uv + b1 * v1.uv + b2 * v2.uv;
    h.mat = g.materialId;
    return true;
}

static bool occluded(float3 o, float3 dir, float tmax, instance_acceleration_structure accel) {
    ray r; r.origin = o; r.direction = dir; r.min_distance = 0.001; r.max_distance = tmax;
    intersector<instancing, triangle_data> isect;
    isect.assume_geometry_type(geometry_type::triangle);
    isect.force_opacity(forced_opacity::opaque);
    isect.accept_any_intersection(true);  // gl_RayFlagsTerminateOnFirstHitEXT
    return isect.intersect(r, accel, 0xFFu).type != intersection_type::none;
}

// AO visibility: 1 on miss, t/R on a first hit within range R.
static float aoVis(float3 o, float3 dir, float R, instance_acceleration_structure accel) {
    ray r; r.origin = o; r.direction = dir; r.min_distance = 0.001; r.max_distance = R;
    intersector<instancing, triangle_data> isect;
    isect.assume_geometry_type(geometry_type::triangle);
    isect.force_opacity(forced_opacity::opaque);
    isect.accept_any_intersection(true);
    intersection_result<instancing, triangle_data> it = isect.intersect(r, accel, 0xFFu);
    if (it.type == intersection_type::none) return 1.0;
    return clamp(it.distance / R, 0.0, 1.0);
}

static float rtAO(float3 p, float3 n, int N, float R, float strength, instance_acceleration_structure accel) {
    float3 t1 = normalize(abs(n.y) < 0.99 ? cross(n, float3(0,1,0)) : cross(n, float3(1,0,0)));
    float3 t2 = cross(n, t1);
    float vis = 0.0;
    for (int i = 0; i < N; i++) {
        float u = (float(i) + 0.5) / float(N);
        float rr = sqrt(u);
        float ph = TWOPI * fract(float(i) * 0.6180339887);
        float3 d = t1 * (rr * cos(ph)) + t2 * (rr * sin(ph)) + n * sqrt(max(1.0 - u, 0.0));
        vis += aoVis(p, d, R, accel);
    }
    return mix(1.0, vis / float(N), strength);
}

// world-space irradiance probe lookup (shade.comp:132-167). Two banks lerped by
// roomLights16/65536. M1 binds a dummy header (dims 0) → returns 0.
static float3 axisFaces(device const float* pd, uint b0, uint b1, uint off, float lp) {
    return mix(float3(pd[b0+off], pd[b0+off+1u], pd[b0+off+2u]),
               float3(pd[b1+off], pd[b1+off+1u], pd[b1+off+2u]), lp);
}
static float3 probeE(float3 p, float3 n, device const float* pd, constant Push& pc) {
    float3 origin = float3(pd[0], pd[1], pd[2]);
    float spacing = pd[3];
    int3 dims = int3(int(pd[4]), int(pd[5]), int(pd[6]));
    if (dims.x < 1 || dims.y < 1 || dims.z < 1) return float3(0.0);
    uint bankStride = uint(dims.x * dims.y * dims.z) * 20u;
    float lp = float(pc.misc2.z) / 65536.0;
    float3 f = (p + n * (0.3 * spacing) - origin) / spacing;
    f = clamp(f, float3(0.0), float3(dims) - 1.001);
    int3 i0 = int3(floor(f));
    float3 t = f - float3(i0);
    float3 n2 = n * n;
    float3 e = float3(0.0);
    float wsum = 0.0;
    for (int c = 0; c < 8; c++) {
        int3 ic = i0 + int3(c & 1, (c >> 1) & 1, (c >> 2) & 1);
        float3 w3 = mix(1.0 - t, t, float3(ic - i0));
        float w = w3.x * w3.y * w3.z;
        if (w <= 1e-5) continue;
        uint pi = uint(ic.x + ic.y * dims.x + ic.z * dims.x * dims.y);
        uint base = 16u + pi * 20u;
        uint base1 = base + bankStride;
        float cnt = pd[base + 18u];
        if (cnt < 1.0) continue;
        float3 fx = n.x > 0.0 ? axisFaces(pd, base, base1, 0u, lp)  : axisFaces(pd, base, base1, 3u, lp);
        float3 fy = n.y > 0.0 ? axisFaces(pd, base, base1, 6u, lp)  : axisFaces(pd, base, base1, 9u, lp);
        float3 fz = n.z > 0.0 ? axisFaces(pd, base, base1, 12u, lp) : axisFaces(pd, base, base1, 15u, lp);
        float3 E = (n2.x * fx + n2.y * fy + n2.z * fz) * (12.566370 / cnt);
        e += w * E;
        wsum += w;
    }
    return wsum > 1e-5 ? e / wsum : float3(0.0);
}

// ---- aesthetic look helpers (SPEC / BUMP / GLOSS) — byte-identical twin of
// shade.comp. Deterministic value noise → bit-identical surface detail; the
// knobs default off so BUMP=0 / SPEC=0 leave the image unchanged.
static float hash13(float3 p){
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
}
static float vnoise(float3 x){
    float3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash13(i + float3(0,0,0)), n100 = hash13(i + float3(1,0,0));
    float n010 = hash13(i + float3(0,1,0)), n110 = hash13(i + float3(1,1,0));
    float n001 = hash13(i + float3(0,0,1)), n101 = hash13(i + float3(1,0,1));
    float n011 = hash13(i + float3(0,1,1)), n111 = hash13(i + float3(1,1,1));
    return mix(mix(mix(n000,n100,f.x), mix(n010,n110,f.x), f.y),
               mix(mix(n001,n101,f.x), mix(n011,n111,f.x), f.y), f.z);
}
static float fbm(float3 p){ return 0.65 * vnoise(p) + 0.35 * vnoise(p * 2.03 + 11.1); }

// stylized point-light specular: GGX D × Schlick F, no solid-angle/geometry term
// (SPEC is the master gain); D clamped so a near-mirror lobe stays a soft plateau.
static float3 specBRDF(float3 n, float3 v, float3 l, float reff, float3 F0){
    float3 hh = normalize(v + l);
    float ndh = max(dot(n, hh), 0.0);
    float voh = max(dot(v, hh), 0.0);
    float a = max(reff * reff, 1e-3), a2 = a * a;
    float den = ndh * ndh * (a2 - 1.0) + 1.0;
    float D = min(a2 / (PI * den * den), 40.0);
    float3 F = F0 + (1.0 - F0) * pow(1.0 - voh, 5.0);
    return D * F;
}

kernel void shade(
    instance_acceleration_structure accel [[buffer(0)]],
    device const Vertex*   verts   [[buffer(1)]],
    device const uint*     indices [[buffer(2)]],
    device const GeomInfo* geoms   [[buffer(3)]],
    device const Material* mats    [[buffer(4)]],
    device const Light*    lights  [[buffer(5)]],
    device const float*    pd      [[buffer(6)]],
    constant Push&         pc      [[buffer(7)]],
    device float4*         outRadiance [[buffer(8)]],
    device float4*         outAlbedo   [[buffer(9)]],  // primary-hit albedo G-buffer (tonemap poster demodulation)
    device float4*         outPos      [[buffer(10)]], // primary-hit world position (tonemap outline; w=0 sky)
    array<texture2d<float>, NTEX_COUNT> texs [[texture(0)]],
    uint2 gid [[thread_position_in_grid]])
{
    int W = pc.misc.x, H = pc.misc.y;
    if (int(gid.x) >= W || int(gid.y) >= H) return;
    uint idx = gid.y * uint(W) + gid.x;

    float3 sunDir = normalize(float3(0.62, 0.55, 0.38));
    float3 sun = float3(1.0, 0.88, 0.70) * 6.0 * pc.env0.x;

    float u = ((float(gid.x) + 0.5 + TIE) / float(W)) * 2.0 - 1.0;
    float v = -(((float(gid.y) + 0.5 + TIE) / float(H)) * 2.0 - 1.0);
    float3 o = float3(pc.camPos.xyz) + u * pc.camRight.w * float3(pc.camRight.xyz)
                                     + v * pc.camUp.w    * float3(pc.camUp.xyz);
    float3 d = normalize(float3(pc.camDir.xyz));
    float3 o0 = o; // camera origin, kept for fog / world-distance after a ROI advance

    Hit h;
    bool hitb = trace(o, d, 300.0, 0x01u, accel, verts, indices, geoms, h);

    // CAVE_ROI dithered see-through — byte-identical twin of shade.comp: dissolve
    // occluder-wall hits (mats[h.mat].pad==1) between camera and player AND inside
    // the player-anchored screen disc, marching the same primary ray past them.
    // roi2.w carries the ghost cap in its MAGNITUDE and the contour flag in its SIGN:
    // <0 = GHOST+CONTOUR hybrid (faint stipple AND faint silhouette line-art, the
    // dissolved wall re-projected into outPos w=2); >0 = GHOST only. The stipple
    // lives in the COLOUR; the contour region is marked solid so its outline stays
    // clean. Enable is roi.w (radius)>0.
    bool roiContour = pc.roi2.w < 0.0;
    bool inContour = false;
    float3 wallPos = float3(0.0);
    if (pc.roi.w > 0.0) {
        float sd = distance(float2(gid) + float2(0.5), pc.roi2.xy);
        float wv = (1.0 - smoothstep(pc.roi.w - max(pc.roi2.z, 1.0), pc.roi.w, sd)) * abs(pc.roi2.w);
        float2 fwd = normalize(d.xz); // camera ground-forward (horizontal view dir)
        // Contour region: nearest hit is a FRONT occluder wall inside the disc (same
        // front-of-player gate as the dissolve loop), marked dissolved OR stipple-kept.
        if (roiContour && hitb && wv > 0.0 && mats[h.mat].pad == 1
            && !(h.t > 0.6 && dot((o + d * h.t).xz - pc.roi.xyz.xz, fwd) >= 0.0)) {
            inContour = true;
            wallPos = o + d * h.t;
        }
        // Anchor the screen-door dither to the WORLD, not the player: project the
        // world origin to low-res px (the same iso::project_lowres mapping that placed
        // the disc centre) so the stipple stays glued to the scene as the player walks.
        float3 orel = -float3(pc.camPos.xyz);
        int2 wpx = int2((dot(orel, float3(pc.camRight.xyz)) / pc.camRight.w * 0.5 + 0.5) * float(W),
                        (0.5 - dot(orel, float3(pc.camUp.xyz)) / pc.camUp.w * 0.5) * float(H));
        if (wv > bayer4(int2(gid) - wpx)) {
            for (int it = 0; it < 10 && hitb && mats[h.mat].pad == 1; it++) {
                // Gate on FLOOR position, not 3D view-depth: a plane perpendicular
                // to the tilted view dir slices tall walls diagonally by height,
                // revealing the tops of walls BEHIND the player. XZ-footprint along
                // the ground-forward axis keeps behind-player walls fully solid.
                // Gate ONLY a FRESH occluder (h.t large): a hit within ~one slab
                // thickness is the FAR FACE of the wall already dissolving — pass it
                // through, else its back face is kept as a sliver at the player plane.
                if (h.t > 0.6 && dot((o + d * h.t).xz - pc.roi.xyz.xz, fwd) >= 0.0) break;
                o = o + d * (h.t + (1.0 / 256.0));
                hitb = trace(o, d, 300.0, 0x01u, accel, verts, indices, geoms, h);
            }
        }
    }
    float tcam = hitb ? (h.t + dot(o - o0, d)) : 0.0; // camera→final-hit distance

    float fogT = 1.0;
    float3 fogAdd = float3(0.0);
    if (pc.env0.z > 0.0) {
        float tseg = hitb ? tcam : min(300.0, o0.y / max(-d.y, 1e-4));
        fogT = exp(-fogOD(o0, d, tseg, pc));
        float3 fogCol = float3(0.55, 0.58, 0.66) * 0.18 * pc.env0.y;
        fogAdd = fogCol * (1.0 - fogT);
        if (pc.env0.x > 0.0) {
            float L = min(tseg, 8.0 * pc.env0.w / max(-d.y, 0.05));
            float ts = tseg - 0.5 * L;
            float3 ps = o0 + d * ts;
            float ss = pc.env0.z * exp(-max(ps.y, 0.0) / pc.env0.w);
            if (ss > 1e-5 && !occluded(ps, sunDir, 200.0, accel))
                fogAdd += sun * ss * exp(-fogOD(o0, d, ts, pc)) * L * 0.08;
        }
    }

    float3 col;
    if (!hitb) {
        outAlbedo[idx] = float4(1.0);
        outPos[idx] = inContour ? float4(wallPos, 2.0) : float4(0.0); // w=0 → sky, w=2 → x-ray wall
        col = skyCol(d, pc) * fogT + fogAdd;
        outRadiance[idx] = float4(col, 1.0);
        return;
    }

    Material m = mats[h.mat];
    float3 albedo = m.baseColor.rgb;
    if (m.texIndex >= 0) albedo *= texs[m.texIndex].sample(texSamp, h.uv).rgb;
    float3 n = h.n; if (dot(n, d) > 0.0) n = -n;
    // procedural surface detail (BUMP) — twin of shade.comp: world-space value-noise
    // height perturbs the normal by its tangent-plane gradient + faint albedo wear,
    // on greybox walls/floors only (no texture, non-emissive). BUMP=0 → unchanged.
    float3 wpos = o + h.t * d;
    if (pc.look.y > 0.0 && m.texIndex < 0 && dot(m.emissive.rgb, float3(1.0)) <= 0.0) {
        const float AMP = 0.04;                  // relief scale (keeps slopes gentle)
        float freq = pc.look.z;
        float e = 0.5 / max(freq, 0.01);
        float h0 = fbm(wpos * freq);
        float3 g = AMP * (float3(fbm((wpos + float3(e,0,0)) * freq),
                                 fbm((wpos + float3(0,e,0)) * freq),
                                 fbm((wpos + float3(0,0,e)) * freq)) - h0) / e;
        g = g - n * dot(g, n);
        n = normalize(n - pc.look.y * g);
        albedo *= 1.0 - 0.07 * pc.look.y * (h0 - 0.5) * 2.0;
    }
    outAlbedo[idx] = float4(albedo, 1.0);
    // CONTOUR: re-project dissolved wall front face (w=2) so tonemap traces its
    // silhouette as x-ray line-art; radiance/albedo stay the room BEHIND.
    outPos[idx] = inContour ? float4(wallPos, 2.0) : float4(o + h.t * d, 1.0); // w=1 matches shade.comp
    if (pc.misc.w == 1) { outRadiance[idx] = float4(albedo, 1.0); return; }
    float3 p = o + h.t * d + n * 0.003;
    if (pc.misc.w == 2) { outRadiance[idx] = float4(albedo * (1.0/PI) * probeE(p, n, pd, pc), 1.0); return; }

    col = m.emissive.rgb; // camera sees emitters

    // specular params (SPEC>0): GLOSS remaps roughness toward polished; F0 dielectric
    // lerped to albedo by metallic; v toward camera.
    float3 vdir = -d;
    float reff = clamp(mix(m.roughness, 0.12, pc.look.w), 0.10, 1.0);
    float3 F0 = mix(float3(0.04), albedo, m.metallic);

    float ndl = max(dot(n, sunDir), 0.0);
    if (pc.env0.x > 0.0 && ndl > 0.0 && !occluded(p, sunDir, 200.0, accel)) {
        col += albedo * sun * ndl;
        if (pc.look.x > 0.0) col += sun * pc.look.x * specBRDF(n, vdir, sunDir, reff, F0) * ndl;
    }

    int lc = pc.misc2.x;
    for (int li = 0; li < lc; li++) {
        Light lt = lights[li];
        float3 toL = lt.posRad.xyz - p;
        float dist = max(length(toL), 1e-4);
        if (dist <= lt.posRad.w) continue;
        float3 ldir = toL / dist;
        float ndl2 = dot(n, ldir);
        if (ndl2 <= 0.0) continue;
        float emit = 1.0;
        if (lt.dir.w == 2.0) {
            float co = lt.color.w;
            emit = smoothstep(co, mix(co, 1.0, 0.6), dot(-ldir, lt.dir.xyz));
        } else if (lt.dir.w > 0.0) {
            emit = 2.0 * max(dot(-ldir, lt.dir.xyz), 0.0);
        }
        if (emit <= 0.0) continue;
        float sinT = clamp(lt.posRad.w / dist, 0.0, 1.0);
        float omega = TWOPI * (1.0 - sqrt(1.0 - sinT * sinT));
        float3 c = albedo * (1.0/PI) * lt.color.rgb * ndl2 * omega * emit;
        if (max(c.r, max(c.g, c.b)) < 0.0015) continue;
        if (!occluded(p, ldir, dist - lt.posRad.w, accel)) {
            col += c;
            if (pc.look.x > 0.0) col += lt.color.rgb * emit * pc.look.x * specBRDF(n, vdir, ldir, reff, F0) * ndl2;
        }
    }

    float ao = 1.0;
    if (pc.camPos.w > 0.0 && pc.misc.z > 0 && pc.camDir.w > 0.0)
        ao = rtAO(p, n, pc.misc.z, pc.camDir.w, pc.camPos.w, accel);
    if (pc.misc.w == 4) { outRadiance[idx] = float4(float3(ao), 1.0); return; }
    if (pc.misc.w != 3 && pc.misc2.y != 0) col += albedo * (1.0/PI) * probeE(p, n, pd, pc) * ao * pc.look2.x;

    col = col * fogT + fogAdd;
    outRadiance[idx] = float4(col, 1.0);
}
