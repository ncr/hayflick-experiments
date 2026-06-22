// goo.metal — screen-space translucent metaball composite.
//
// Runs AFTER shade writes the HDR radiance + primary-hit world-position
// G-buffers, and BEFORE tonemap. For each low-res pixel it rebuilds the SAME
// orthographic primary ray shade used, sphere-traces the smooth `smin` union of
// the goo metaballs, and — where the goo surface is in front of the scene —
// composites a translucent, self-emitting fluorescent body over the scene
// colour: Beer–Lambert green absorption through the marched thickness, an
// additive radioactive-green glow, and a Fresnel rim.
//
// The goo LIES ON THE GROUND: every metaball is flattened vertically (`squash`)
// into an ellipsoid, and the field is clamped to the floor plane (`floorY`), so
// the body spreads into a flat puddle with a flat underside rather than floating
// as spheres. Presentation-only; reads + writes only its own pixel's radiance.

#include <metal_stdlib>
using namespace metal;

constant float TIE = 1.0 / 64.0; // pixel-centre tie bias (matches shade.metal)

struct GooPush {
    float4 camRight; // xyz basis, w = ortho half-width
    float4 camUp;    // xyz basis, w = ortho half-height
    float4 camDir;   // xyz forward, w = vertical squash (<1 = flatter)
    float4 camPos;   // xyz eye,     w = floor plane Y
    int4   dims;     // W, H, ballCount, _
    float4 emis;     // emissive rgb, w = glow intensity
    float4 absorb;   // absorption rgb (per wu), w = surface alpha
    float4 params;   // x = smin merge radius k; yzw unused
};

// soft-min: smoothly merges two SDFs so nearby balls fuse into one lump.
static inline float smin(float a, float b, float k) {
    float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
    return mix(b, a, h) - k * h * (1.0 - h);
}

// signed distance to the ground-hugging metaball field: a smooth union of
// vertically-squashed ellipsoids, clamped above the floor plane.
static float goo_sdf(float3 p, device const float4* balls, int n, float k, float squash, float floorY) {
    float d = 1e9;
    for (int i = 0; i < n; ++i) {
        float3 q = p - balls[i].xyz;
        q.y /= squash;                 // stretch the query in Y → flat ellipsoid
        float di = (length(q) - balls[i].w) * squash; // conservative scale
        d = smin(d, di, k);
    }
    // clamp to the floor: nothing exists below the ground, giving a flat bottom
    return max(d, floorY - p.y);
}

static inline float3 goo_normal(float3 p, device const float4* balls, int n, float k, float squash, float floorY) {
    const float e = 0.010;
    float2 h = float2(1.0, -1.0) * 0.5773;
    return normalize(h.xyy * goo_sdf(p + h.xyy * e, balls, n, k, squash, floorY) + h.yyx * goo_sdf(p + h.yyx * e, balls, n, k, squash, floorY) + h.yxy * goo_sdf(p + h.yxy * e, balls, n, k, squash, floorY) + h.xxx * goo_sdf(p + h.xxx * e, balls, n, k, squash, floorY));
}

kernel void goo_composite(
    device float4*       radiance [[buffer(0)]], // read + write (HDR scene colour)
    device const float4* posBuf   [[buffer(1)]], // primary-hit world pos (w = hit flag)
    device const float4* balls    [[buffer(2)]], // metaballs (xyz centre, w radius)
    constant GooPush&    pc        [[buffer(3)]],
    uint2 gid [[thread_position_in_grid]])
{
    int W = pc.dims.x, H = pc.dims.y, N = pc.dims.z;
    if (int(gid.x) >= W || int(gid.y) >= H || N <= 0) return;
    uint idx = gid.y * uint(W) + gid.x;

    float squash = pc.camDir.w;
    float floorY = pc.camPos.w;
    float k = pc.params.x;

    // rebuild shade's orthographic primary ray for this pixel
    float u = ((float(gid.x) + 0.5 + TIE) / float(W)) * 2.0 - 1.0;
    float v = -(((float(gid.y) + 0.5 + TIE) / float(H)) * 2.0 - 1.0);
    float3 ro = pc.camPos.xyz + u * pc.camRight.w * pc.camRight.xyz + v * pc.camUp.w * pc.camUp.xyz;
    float3 rd = normalize(pc.camDir.xyz);

    // scene occlusion: distance along the ray to the primary hit (sky = far).
    // (The goo also lights the floor for REAL — one RT light per blob with
    // ray-traced shadows in the shade pass — so this composite only draws the
    // translucent body itself.)
    float4 hp = posBuf[idx];
    float sceneT = (hp.w > 0.5 && hp.w < 1.5) ? dot(hp.xyz - ro, rd) : 1e9;

    // sphere-trace to the goo surface
    const int STEPS = 96;
    float t = 0.0;
    float tmax = min(sceneT, 90.0);
    bool hit = false;
    for (int i = 0; i < STEPS; ++i) {
        float3 p = ro + rd * t;
        float d = goo_sdf(p, balls, N, k, squash, floorY);
        if (d < 0.0012) { hit = true; break; }
        t += max(d, 0.003);
        if (t > tmax) break;
    }
    if (!hit) return; // no goo on this pixel — leave the scene colour untouched

    // march on through the body to the exit surface → thickness (for absorption)
    float3 pen = ro + rd * t; // entry point
    float texit = t;
    for (int i = 0; i < STEPS; ++i) {
        float3 p = ro + rd * texit;
        float d = goo_sdf(p, balls, N, k, squash, floorY);
        if (d > 0.0012) break; // back outside → exit found
        texit += max(-d, 0.008);
        if (texit > tmax) { texit = tmax; break; }
    }
    float thickness = max(texit - t, 0.0);

    float3 nrm = goo_normal(pen, balls, N, k, squash, floorY);
    float fres = pow(clamp(1.0 - max(dot(nrm, -rd), 0.0), 0.0, 1.0), 3.0); // rim

    // Beer–Lambert: the scene colour behind the goo is tinted green by how much
    // body the ray crossed (thin edges stay clear, thick centres go saturated).
    float3 trans = exp(-pc.absorb.xyz * thickness);
    float3 bg = radiance[idx].xyz * trans;

    // additive fluorescent glow — brighter through more body and at the rim
    float3 glow = pc.emis.xyz * pc.emis.w * (0.35 + 1.6 * (1.0 - trans) + 1.1 * fres);

    // coverage: full body opaque-ish, but the silhouette edge softens via Fresnel
    float alpha = clamp(pc.absorb.w + 0.5 * fres, 0.0, 1.0);
    float3 outc = mix(radiance[idx].xyz, bg, alpha) + glow;
    radiance[idx] = float4(outc, 1.0);
}
