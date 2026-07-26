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
//   * textures ride a fixed-size texture-table array (`texs`, [[texture(0)]])
//     instead of Vulkan's binding-6 descriptor array; texIndex selects the
//     slot and albedo multiplies the NEAREST-sampled base colour, same result.
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
    float4 look2;     // gi scale, matPoster levels, aoDither, reflStrength
    int4   misc3;     // floorCutY 16.16 (INT_MAX = off), wallCutY 16.16 (INT_MAX = off; occluder-only sill cut), _, _
    float4 env1;      // sun/sky-as-data (Faza 1b): sun dir xyz (normalized), w = ground tint r
    float4 env2;      // sun tint rgb, w = ground tint g
    float4 env3;      // sky horizon tint rgb, w = ground tint b
    float4 env4;      // sky zenith tint rgb, _
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

// `edge` = world distance to the nearest GATING triangle edge (contour AA).
struct Hit { float t; float3 n; float2 uv; int mat; float edge; };

static float3 skyCol(float3 d, constant Push& pc) {
    float t = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
    float3 horizon = pc.env3.rgb; // look-authored (sun/sky-as-data, Faza 1b)
    float3 zenith  = pc.env4.rgb;
    float3 ground  = float3(pc.env1.w, pc.env2.w, pc.env3.w); // look-authored void tint
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
    // CONTOUR AA: distance to the nearest triangle edge in world units, the
    // triangle's LONGEST edge excluded (that is the quad diagonal every box
    // face is split by — gating it would band flat faces). See shade.comp.
    float3 E0 = float3(v2.pos) - float3(v1.pos);
    float3 E1 = float3(v0.pos) - float3(v2.pos);
    float3 E2 = float3(v1.pos) - float3(v0.pos);
    float L0 = length(E0), L1 = length(E1), L2 = length(E2);
    float A2 = length(cross(E2, -E1));
    float Lm = max(L0, max(L1, L2));
    h.edge = min(L0 >= Lm ? 1e9 : A2 * b0 / max(L0, 1e-6),
             min(L1 >= Lm ? 1e9 : A2 * b1 / max(L1, 1e-6),
                 L2 >= Lm ? 1e9 : A2 * b2 / max(L2, 1e-6)));
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

// ---- crack-lab helpers (per-segment aging) — byte-identical twin of
// shade.comp's crackSite/crackEdge: 2D cellular (Worley) edge distance on a
// wall face. Returns F2-F1 (0 on a boundary); `site` the vector to the
// nearest cell site (edge bevel), `cellH` the nearest cell's hash (coverage).
static float2 crackSite(float2 c, float seed){
    return float2(hash13(float3(c, seed)), hash13(float3(c, seed + 47.0)));
}
static float crackEdge(float2 p, float seed, thread float2& site, thread float& cellH){
    float2 i = floor(p), f = fract(p);
    float f1 = 8.0, f2 = 8.0;
    float2 r1 = float2(0.0), c1 = float2(0.0);
    for (int y = -1; y <= 1; y++)
        for (int x = -1; x <= 1; x++) {
            float2 g = float2(float(x), float(y));
            float2 r = g + crackSite(i + g, seed) - f;
            float dd = dot(r, r);
            if (dd < f1) { f2 = f1; f1 = dd; r1 = r; c1 = i + g; }
            else if (dd < f2) { f2 = dd; }
        }
    site = r1;
    cellH = hash13(float3(c1, seed + 91.0));
    return sqrt(f2) - sqrt(f1);
}
// One STRUCTURAL fault lattice on a face plane — twin of shade.comp's

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

// ---- CONTOUR COVERAGE AA (owner 2026-07-25) --------------------------------
// Line-for-line twin of the shade.comp block: a coverage tap is the SAME kernel
// re-dispatched with a fixed sub-pixel ray offset, so every cutaway / ROI /
// glass / material path is reused by identity. See shade.comp for the reasoning.
constant float AA_R = 0.42; // px — clears the max tap reach |(24,8)|/64 = 0.3953
constant int2 AAOFF[5] = { int2(0, 0), int2(24, 8), int2(-8, 24), int2(-24, -8), int2(8, -24) };

static bool aaGate(int2 px, int W, int H, constant Push& pc,
                   device const float4* outAlbedo, device const float4* outPos) {
    const int2 N4[4] = { int2(1, 0), int2(-1, 0), int2(0, 1), int2(0, -1) };
    int2 hi = int2(W - 1, H - 1);
    float e = outAlbedo[px.y * W + px.x].w;
    for (int k = 0; k < 4; k++) {
        int2 q = clamp(px + N4[k], int2(0), hi);
        e = min(e, outAlbedo[q.y * W + q.x].w);
    }
    if (e >= AA_R) return false;
    float4 P0 = outPos[px.y * W + px.x];
    if (P0.w == 0.0) return true; // sky texel: the far side of a silhouette
    float tol = 0.6 * (2.0 * pc.camRight.w / float(W)); // 0.6 px, in wu
    for (int k = 0; k < 2; k++) {
        int2 o = k == 0 ? int2(1, 0) : int2(0, 1);
        int2 qa = clamp(px + o, int2(0), hi), qb = clamp(px - o, int2(0), hi);
        float4 Pa = outPos[qa.y * W + qa.x], Pb = outPos[qb.y * W + qb.x];
        if (Pa.w == 0.0 || Pb.w == 0.0) return true;
        if (length(Pa.xyz + Pb.xyz - 2.0 * P0.xyz) > tol) return true;
    }
    return false;
}

// rgb = sum(w*L), a = sum(w). Every reader must divide by .a when .a > 1.
static void aaAccum(device float4* outRadiance, uint idx, float w, float3 c) {
    float4 a = outRadiance[idx];
    outRadiance[idx] = float4(a.rgb + w * c, a.a + w);
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

    // CONTOUR AA: misc3.z = tap weight (16.16), misc3.w = sample index (0 = the
    // centre pass, 1..4 = a coverage tap that exists only on contour texels).
    float aaW = float(pc.misc3.z) * (1.0 / 65536.0);
    int S = pc.misc3.w & 255;              // AA sample index
    int aaScope = (pc.misc3.w >> 8) & 3;   // 0 = every surface, else per-material opt-in (crack::AA_BIT)
    // S == 5 = the GATE pass: run the contour test once, mark non-contour
    // texels with a negative weight, and every tap then skips with ONE load.
    // See shade.comp for why it cannot be cached in place.
    if (S == 5) {
        float4 c = outRadiance[idx];
        if (!aaGate(int2(gid), W, H, pc, outAlbedo, outPos)) outRadiance[idx] = float4(c.rgb, -1.0);
        return;
    }
    if (S > 0) {
        if (pc.misc.w != 0) return;                      // debug views stay centre-only
        if (outRadiance[idx].a < 0.0) return;            // interiors: not one extra ray
    }

    float3 sunDir = pc.env1.xyz; // normalized CPU-side (EnvBlock::pack)
    float3 sun = pc.env2.rgb * 6.0 * pc.env0.x;

    // an EVEN multiple of 1/64, so a tap ray still lands on an ODD multiple —
    // off every dyadic seam plane, exactly like the TIE bias itself
    float2 aaOff = float2(AAOFF[S]) * (1.0 / 64.0);
    float u = ((float(gid.x) + 0.5 + TIE + aaOff.x) / float(W)) * 2.0 - 1.0;
    float v = -(((float(gid.y) + 0.5 + TIE + aaOff.y) / float(H)) * 2.0 - 1.0);
    float3 o = float3(pc.camPos.xyz) + u * pc.camRight.w * float3(pc.camRight.xyz)
                                     + v * pc.camUp.w    * float3(pc.camUp.xyz);
    float3 d = normalize(float3(pc.camDir.xyz));
    float3 o0 = o; // camera origin, kept for fog / world-distance after a ROI advance

    Hit h;
    bool hitb = trace(o, d, 300.0, 0x01u, accel, verts, indices, geoms, h);

    // FLOORCUT dollhouse (module 11 auto-reveal), two planes — twin of
    // shade.comp:
    // - STOREY cut (misc3.x): EVERY primary-ray hit at or above the plane
    //   dissolves — storeys above the player's floor and their roofs come off
    //   like lifting a dollhouse cap.
    // - WALL cut (misc3.y): only OCCLUDER hits (mats[..].pad bit 1 — walls,
    //   roofs, glass panes) at or above the plane dissolve. The game sets it to
    //   sill height while the player is INDOORS, so buildings open into a
    //   cutaway while bodies, props and door leaves keep their full height.
    // INT_MAX disables a plane; both off skips the block entirely
    // (bit-identical pre-cut image). The iso camera looks DOWN (d.y < 0):
    // hit Y decreases monotonically along the ray, so one prefix loop
    // suffices and the CAVE_ROI block below never sees above-cut hits.
    if (pc.misc3.x != 2147483647 || pc.misc3.y != 2147483647) {
        bool storey = pc.misc3.x != 2147483647;
        bool wall = pc.misc3.y != 2147483647;
        float cutY = float(pc.misc3.x) * (1.0 / 65536.0);
        float wallY = float(pc.misc3.y) * (1.0 / 65536.0);
        // wallPass: the previous hit was a wall we are cutting — a nearby
        // occluder hit (h.t <= 0.6, ~one slab thickness) is that slab's FAR
        // face, which may already sit BELOW the plane (walls straddle it);
        // pass through it or its inner surface renders as a dark band along
        // every cut edge (the ROI loop's proven far-face rule). GLASS panes
        // (pad bit 2) get a wider far-face bound — 0.3 thick, crossed
        // obliquely up to ~0.78 wu at the trimetric d, so the 0.6 bound
        // left the pane's below-plane far face as a floating glass plate
        // over every cut window; gated to glass so real second walls stay
        // solid (a parallel occluder is beyond a loop-breaking floor hit).
        // Glass stubs stand 0.3125 taller than wall stubs: the pane is the
        // proudest thing in its bay, so its cut silhouette must COVER the
        // opening's porcelain jamb behind it — same world height but deeper
        // in view, the jamb's cut edge projects higher on screen and would
        // poke out as a thin dark sliver (it sits in the still-solid pane's
        // sun shadow). The taller glass stub also echoes the crown lip.
        bool wallPass = false;
        for (int it = 0; it < 16 && hitb; it++) {
            float hy = (o + d * h.t).y;
            bool glass = (mats[h.mat].pad & 2) != 0;
            bool occ = (mats[h.mat].pad & 1) == 1;
            float ffar = glass ? 1.0 : 0.6;
            float wy = glass ? wallY + 0.3125 : wallY;
            bool cut = (storey && hy >= cutY) || (wall && occ && (hy >= wy || (wallPass && h.t <= ffar)));
            if (!cut) break;
            wallPass = occ;
            o = o + d * (h.t + (1.0 / 256.0));
            hitb = trace(o, d, 300.0, 0x01u, accel, verts, indices, geoms, h);
        }
    }

    // CAVE_ROI dithered see-through — byte-identical twin of shade.comp: dissolve
    // occluder-wall hits (mats[h.mat].pad bit 1) between camera and player AND inside
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
        if (roiContour && hitb && wv > 0.0 && (mats[h.mat].pad & 1) == 1
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
            for (int it = 0; it < 10 && hitb && (mats[h.mat].pad & 1) == 1; it++) {
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
    // GLASS transmission (mats[..].pad bit 2 — the polana window panes), byte-
    // identical twin of shade.comp: the primary ray passes THROUGH tinted
    // glass, multiplying the pane's base colour into everything behind it —
    // "black tinted but transparent" (owner, 2026-07-12). One tint per pane:
    // only ENTERING faces count, the exit face passes free. Each entered pane
    // adds the porcelain sheen (sun key + fresnel sky reflection), attenuated
    // by the panes already crossed. Shadow rays and the probe bake keep glass
    // OPAQUE — a camera-only effect, the GI/NEE double-count contract holds.
    float3 gtint = float3(1.0);
    float3 gsheen = float3(0.0);
    for (int it = 0; it < 6 && hitb && (mats[h.mat].pad & 2) != 0; it++) {
        if (dot(h.n, d) < 0.0) { // entering face
            Material gm = mats[h.mat];
            if (pc.look.x > 0.0) {
                float3 gp = o + d * h.t + h.n * 0.003;
                float greff = clamp(mix(gm.roughness, 0.12, pc.look.w), 0.10, 1.0);
                float3 sheen = float3(0.0);
                float gndl = max(dot(h.n, sunDir), 0.0);
                if (pc.env0.x > 0.0 && gndl > 0.0 && !occluded(gp, sunDir, 200.0, accel))
                    sheen += sun * pc.look.x * specBRDF(h.n, -d, sunDir, greff, float3(0.04)) * gndl;
                float F = 0.04 + 0.96 * pow(1.0 - max(dot(h.n, -d), 0.0), 5.0);
                // fresnel SKY reflection: mirror the dome (|y|) — glass
                // reflects the sky, never the below-horizon void tint
                float3 rd = reflect(d, h.n);
                rd.y = abs(rd.y);
                sheen += skyCol(rd, pc) * F * min(pc.look.x * 8.0, 1.0);
                gsheen += gtint * sheen;
            }
            gtint *= gm.baseColor.rgb;
        }
        o = o + d * (h.t + (1.0 / 256.0));
        hitb = trace(o, d, 300.0, 0x01u, accel, verts, indices, geoms, h);
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
        col = (skyCol(d, pc) * gtint + gsheen) * fogT + fogAdd;
        if (S > 0) { aaAccum(outRadiance, idx, aaW, col); return; } // a tap that escapes IS coverage
        outAlbedo[idx] = float4(gtint, 8.0); // sky through glass demodulates tinted (w = the AA gate's "no edge")
        outPos[idx] = inContour ? float4(wallPos, 2.0) : float4(0.0); // w=0 → sky, w=2 → x-ray wall
        outRadiance[idx] = float4(col, 1.0);
        return;
    }

    Material m = mats[h.mat];
    float3 albedo = m.baseColor.rgb;
    if (m.texIndex >= 0) albedo *= texs[m.texIndex].sample(texSamp, h.uv).rgb;
    float3 n = h.n; if (dot(n, d) > 0.0) n = -n;
    // the FLAT face normal, kept before wear/bump rewrite it (contour AA gate)
    float3 aaGn = n;
    // procedural WEAR & TEAR on greybox walls/floors — twin of shade.comp: (1) relief
    // normal bump; (2) broad worn zones + fine scuff + sparse scratches in the albedo;
    // (3) contact grime in occluded crevices (below, once AO is known). BUMP=0 → unchanged.
    float3 wpos = o + h.t * d;
    bool greybox = pc.look.y > 0.0 && m.texIndex < 0 && dot(m.emissive.rgb, float3(1.0)) <= 0.0;
    float wstr = pc.look.y;
    float floorw = 0.55 + 0.45 * clamp(n.y, 0.0, 1.0);
    if (greybox) {
        float freq = pc.look.z;
        const float AMP = 0.045;
        float e = 0.5 / max(freq, 0.01);
        float h0 = fbm(wpos * freq);
        float3 g = AMP * (float3(fbm((wpos + float3(e,0,0)) * freq),
                                 fbm((wpos + float3(0,e,0)) * freq),
                                 fbm((wpos + float3(0,0,e)) * freq)) - h0) / e;
        g = g - n * dot(g, n);
        n = normalize(n - wstr * g);
        floorw = 0.55 + 0.45 * clamp(n.y, 0.0, 1.0);
        float broad = fbm(wpos * freq * 0.30 + 17.0);
        float fine  = fbm(wpos * freq * 2.30 + 41.0);
        float dirt = wstr * floorw * (0.40 * (1.0 - broad) * (1.0 - broad) + 0.10 * (1.0 - fine));
        float sc1 = vnoise(wpos * float3(freq * 0.5, freq * 4.5, freq * 4.5) + 7.0);
        float sc2 = vnoise(wpos * float3(freq * 4.5, freq * 4.5, freq * 0.5) + 23.0);
        float scratch = max(smoothstep(0.66, 0.78, sc1), smoothstep(0.66, 0.78, sc2));
        dirt += wstr * floorw * 0.22 * scratch;
        dirt = clamp(dirt, 0.0, 0.6);
        albedo *= 1.0 - dirt;
        albedo = mix(albedo, float3(dot(albedo, float3(0.299, 0.587, 0.114))), dirt * 0.5);
    }
    // ---- WEATHERED SKIN — line-for-line twin of the other dialect.
    //
    // What the shade pass paints on an aged wall is now exactly TWO layers: tea
    // STAINS in the damage patches, and the fine GLAZE WEB inside the worst of
    // them. Everything else this block used to draw — a painted structural fault,
    // a painted craze cell network, chalky chip patches, and the normal bevels
    // that went with them — was DELETED 2026-07-26 (owner call).
    //
    // The argument for deleting rather than fixing: none of the three could draw
    // where it mattered. `crack_geom::craze_pier` runs on ANY pier with a nonzero
    // knob and sets CRAZE, and this block gated all three off that bit — so they
    // rendered only on the piers the geometry pass happened to skip (measured: 3
    // of the gym's 15 walls at one ordinary knob setting), and there they
    // disagreed with the geometric version on the wall next door. The geometric
    // version is the one the owner has been looking at since round 8. What
    // survives here is the paint that belongs BESIDE it, not a second copy of it.
    //
    // So this block reads ONE knob — age — plus the field level lane and the story
    // key. `cracks` / `depth` / `chip` still exist and still matter; they are
    // GEOMETRY dials, and the shade pass has no business reading them.
    {
        uint kb = uint(m.pad);
        if ((kb >> 8) != 0u && m.texIndex < 0 && dot(m.emissive.rgb, float3(1.0)) <= 0.0) {
            float cAge = float((kb >> 8) & 63u) * (1.0 / 63.0);
            float story = m.baseColor.a;
            // FRESH BREAK: what the damage EXPOSED is unglazed body, so neither
            // layer here belongs on it (crack_geom::fresh_body mints the pale
            // neutral albedo; MATTE kills the sheen). Contact grime below stays
            // LIVE on it — a perfectly clean crater reads as spilled white paint.
            float skin = (kb & 4u) != 0u ? 0.0 : 1.0;
            float3 an = abs(n);
            bool wallF = an.y <= 0.5;
            float2 cuv = an.x > 0.5 ? wpos.zy : (an.y > 0.5 ? wpos.xz : wpos.xy);
            // MACRO DAMAGE FIELD — where THIS run is failing. The two painted layers'
        // gates are ABSOLUTE thresholds SOLVED for this run host-side
        // (`wall::RunField::threshold`) and carried here as 6-bit codes counting DOWN
        // from `wall::GATE_HI`, so an amount is a FRACTION OF THIS FACE rather than
        // whatever this run's fbm draw happened to give it.
        //
        // Code 0 — the empty word, hence every material nobody stamped — sits above
        // the field's maximum, so it means provably nothing. That property is why the
        // codec counts down: the SIGNED per-run level offset this replaces was
        // calibrated for run-to-run variation at one reference age, not for a dial's
        // whole travel, so a large coverage on a low-level run needed an offset past
        // its clamp — a dead region at the top of the central dial.
        //
        // The band is centred on the threshold, so the threshold is the 50 % point,
        // which is what makes the coverage the shader draws equal the amount the host
        // solved for. Host mirror: `CrazeCfg::zone` / `stain_w`.
        uint ew = uint(m.emissive.a);
        float tStain = 1.20 - float( ew        & 63u) * 0.020;  // wall::GATE_HI, GATE_STEP
        float tWeb   = 1.20 - float((ew >> 6) & 63u) * 0.020;
        float rise = wallF ? 1.0 - smoothstep(0.10, 1.0, cuv.y) : 0.0;
        float dmgN = fbm(float3(cuv * float2(0.45, 0.7), story * 7.0 + 3.0)) + 0.16 * rise;
        float stainW = smoothstep(tStain - 0.05, tStain + 0.05, dmgN);
        float fineG  = smoothstep(tWeb   - 0.03, tWeb   + 0.03, dmgN);
        // FINE GLAZE WEB. Its lattice is a CONSTANT 6 cells/wu — it used to be
            // mix(1.1, 3.4, cracks), which drew a COARSE cell network at cracks = 0,
            // so the name lied about what you were looking at. 6/wu is 0.167 wu per
            // cell = ~6.8 px on an X-run face, i.e. a ~1 px line: fine BY
            // CONSTRUCTION and independent of every geometry dial.
            float2 siteF; float cellF;
            float edF = crackEdge(cuv * 6.0 + 31.0, story + 9.0, siteF, cellF);
            float web = (1.0 - smoothstep(0.0, 0.07, edF)) * step(cellF, cAge * 0.9) * fineG * skin;
            albedo *= 1.0 - web * 0.35 * smoothstep(0.15, 0.7, cAge);
            // TEA STAINS in the damage patches. `skin` gates the whole term: the
            // runoff stained the surface that spalled AWAY, so a streak stops at a
            // crater lip instead of running down through the hole.
            float stain = fbm(wpos * 0.9 + 31.0);
            float sAmt = skin * cAge * clamp(0.55 * smoothstep(0.45, 0.85, stain) * (0.20 + 0.80 * stainW), 0.0, 1.0);
            albedo = mix(albedo, albedo * float3(0.78, 0.70, 0.58), sAmt);
        }
    }
    float3 p = o + h.t * d + n * 0.003;
    // AO computed ONCE (reused for contact grime + the indirect term below).
    float ao = 1.0;
    if (pc.camPos.w > 0.0 && pc.misc.z > 0 && pc.camDir.w > 0.0)
        ao = rtAO(p, n, pc.misc.z, pc.camDir.w, pc.camPos.w, accel);
    if (greybox) { // (3) contact grime: dirt cakes into occluded crevices
        float c = clamp((1.0 - ao) * 1.8 * wstr, 0.0, 1.0);
        albedo = mix(albedo, albedo * float3(0.50, 0.47, 0.43), c * 0.7);
    }
    // ---- MATERIAL POSTERIZE (MATQ = look2.y >= 2) — twin of shade.comp: clamp
    // the material's tonal range — albedo snapped to N levels per channel AFTER
    // wear/grime (roughness snaps below, at reff). The quantized albedo feeds
    // the G-buffer too, so tonemap's poster demodulation stays consistent.
    if (pc.look2.y >= 2.0) {
        float Lq = pc.look2.y - 1.0;
        albedo = floor(albedo * Lq + 0.5) / Lq;
    }
    // ---- DITHERED SHADOWS (AO_DITHER = look2.z > 0) — twin of shade.comp: the
    // smooth RT-AO gradient collapses to a binary per-pixel stipple — remap AO
    // to its [1-strength, 1] envelope, threshold against the ordered 4x4 Bayer,
    // snap to floor or full. Applied AFTER contact grime (wants the smooth term).
    if (pc.look2.z > 0.0 && pc.camPos.w > 0.0) {
        float aot = (ao - (1.0 - pc.camPos.w)) / max(pc.camPos.w, 1e-4);
        ao = aot >= bayer4(int2(gid)) ? 1.0 : 1.0 - pc.camPos.w;
    }
    // crack-lab SELECTION highlight (pad bit 3) — twin of shade.comp: a steady
    // amber lift on the picked segment (no pulse; captures stay deterministic).
    if ((uint(m.pad) & 8u) != 0u) albedo = mix(albedo, float3(1.0, 0.82, 0.40), 0.22);
    // .w = screen-px distance to the nearest gating triangle edge — the CONTOUR
    // AA gate (was a constant 1.0, read by nobody). |n·d| is the exact minimum
    // foreshortening of an in-plane distance, so this is a conservative LOWER
    // bound: the gate may over-report, never miss. See shade.comp.
    // SCOPE: outside it the texel reports "no edge", so neither the coverage
    // taps nor the softening touch it. See shade.comp.
    float edgePx = 8.0;
    if (aaScope == 0 || (m.pad & 128) != 0)
        edgePx = min(h.edge * (0.5 * float(W) / pc.camRight.w) * max(abs(dot(aaGn, d)), 0.08), 8.0);
    if (S == 0) outAlbedo[idx] = float4(albedo * gtint, edgePx); // tint in the G-buffer keeps demodulation consistent
    // CONTOUR: re-project dissolved wall front face (w=2) so tonemap traces its
    // silhouette as x-ray line-art; radiance/albedo stay the room BEHIND.
    if (S == 0) outPos[idx] = inContour ? float4(wallPos, 2.0) : float4(o + h.t * d, 1.0); // w=1 matches shade.comp
    // DEBUG_AA (misc.w == 5): red = fires coverage taps, green ramp = edgePx.
    if (pc.misc.w == 5) {
        outRadiance[idx] = float4(edgePx < 0.42 ? 1.0 : 0.0, min(edgePx, 4.0) * 0.25, 0.0, 1.0);
        return;
    }
    if (pc.misc.w == 1) { outRadiance[idx] = float4(albedo, 1.0); return; }
    if (pc.misc.w == 2) { outRadiance[idx] = float4(albedo * (1.0/PI) * probeE(p, n, pd, pc), 1.0); return; }

    col = m.emissive.rgb; // camera sees emitters

    // specular params (SPEC>0): GLOSS remaps roughness toward polished; F0 dielectric
    // lerped to albedo by metallic; v toward camera. MATTE materials (pad bit 4 —
    // grass floor/tufts) opt out of the whole ceramic response: no gloss remap,
    // no specular anywhere — the authored roughness stands (grass never shines).
    float3 vdir = -d;
    bool matte = (m.pad & 4) != 0;
    float reff = matte ? 1.0 : clamp(mix(m.roughness, 0.12, pc.look.w), 0.10, 1.0);
    // crack-lab CHIP — twin of shade.comp: spalled patches lose the glaze —
    float specX = pc.look.x;
    if (pc.look2.y >= 2.0) reff = clamp(floor(reff * 3.0 + 0.5) / 3.0, 0.10, 1.0); // MATQ: roughness in coarse steps too
    float3 F0 = mix(float3(0.04), albedo, m.metallic);

    float ndl = max(dot(n, sunDir), 0.0);
    if (pc.env0.x > 0.0 && ndl > 0.0 && !occluded(p, sunDir, 200.0, accel)) {
        col += albedo * sun * ndl;
        if (pc.look.x > 0.0 && !matte) col += sun * specX * specBRDF(n, vdir, sunDir, reff, F0) * ndl;
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
            if (pc.look.x > 0.0 && !matte) col += lt.color.rgb * emit * specX * specBRDF(n, vdir, ldir, reff, F0) * ndl2;
        }
    }

    if (pc.misc.w == 4) { outRadiance[idx] = float4(float3(ao), 1.0); return; }
    if (pc.misc.w != 3 && pc.misc2.y != 0) col += albedo * (1.0/PI) * probeE(p, n, pd, pc) * ao * pc.look2.x;

    // ---- PIXELATED REFLECTIONS (REFL = look2.w > 0) — twin of shade.comp: a
    // mirror bounce rendered at 1/REFL_PX resolution and composited over the
    // full-res image. Every pixel in a REFL_PX×REFL_PX screen block re-derives
    // the BLOCK ANCHOR's primary ray (ortho camera: same direction, shifted
    // origin), so the whole block computes one identical reflection — the same
    // picture a low-res reflection buffer + NEAREST upsample would give,
    // without a second pass. Floors and metals reflect; the bounce is shaded
    // cheaply (emissive + sun NEE + probe GI, no per-light loop) and added at
    // knob strength — a stylized wet-floor sheen, not PBR. REFL=0 → no rays.
    // MATTE floors (grass) never turn into wet mirrors either.
    if (pc.look2.w > 0.0 && !matte && (m.metallic > 0.5 || n.y > 0.8)) {
        int B = max(pc.misc2.w, 1);
        int2 bp = (int2(gid) / B) * B;
        float ub = ((float(bp.x) + 0.5 + TIE) / float(W)) * 2.0 - 1.0;
        float vb = -(((float(bp.y) + 0.5 + TIE) / float(H)) * 2.0 - 1.0);
        float3 ob = float3(pc.camPos.xyz) + ub * pc.camRight.w * float3(pc.camRight.xyz)
                                          + vb * pc.camUp.w    * float3(pc.camUp.xyz);
        Hit bh;
        float3 rc = float3(0.0);
        if (trace(ob, d, 300.0, 0x01u, accel, verts, indices, geoms, bh)) {
            float3 bn = bh.n; if (dot(bn, d) > 0.0) bn = -bn;
            float3 bpos = ob + d * bh.t + bn * 0.003;
            float3 rdir = reflect(d, bn);
            Hit rh;
            // mask 0x05 (primary | dynamic): the player shows in the floor.
            if (trace(bpos, rdir, 60.0, 0x05u, accel, verts, indices, geoms, rh)) {
                Material rm = mats[rh.mat];
                float3 ralb = rm.baseColor.rgb;
                if (rm.texIndex >= 0) ralb *= texs[rm.texIndex].sample(texSamp, rh.uv).rgb;
                float3 rn = rh.n; if (dot(rn, rdir) > 0.0) rn = -rn;
                float3 rp = bpos + rdir * rh.t + rn * 0.003;
                rc = rm.emissive.rgb;
                float rndl = max(dot(rn, sunDir), 0.0);
                if (pc.env0.x > 0.0 && rndl > 0.0 && !occluded(rp, sunDir, 200.0, accel)) rc += ralb * sun * rndl;
                if (pc.misc2.y != 0) rc += ralb * (1.0/PI) * probeE(rp, rn, pd, pc) * pc.look2.x;
            } else {
                rc = skyCol(rdir, pc);
            }
        }
        col += rc * pc.look2.w;
    }

    col = (col * gtint + gsheen) * fogT + fogAdd;
    if (S > 0) aaAccum(outRadiance, idx, aaW, col); else outRadiance[idx] = float4(col, 1.0);
}
