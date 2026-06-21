// tonemap.metal — MSL port of rt-probe/src/shaders/tonemap.comp.
//
// Resolves the low-res HDR radiance (+ albedo / world-pos G-buffers) to the
// 8-bit window image, doing the pixel-perfect integer-NEAREST upscale on the
// GPU: one low-res texel maps to a scale×scale block of output pixels. `pan`
// shifts which low-res texel sits under a given output pixel (whole low-res
// pixels — carried remainder lives on the CPU side, so this stays crisp).
// Output pixels outside the low-res buffer get the neutral guard band.
//
// Buffer-based twin of the Vulkan storage-image version: shade.metal writes
// device float4* radiance/albedo/pos buffers (low_w*low_h), and this writes a
// device uchar4* out buffer (out_w*out_h). The full stylized post stack is a
// faithful port (cel-posterize -> bloom -> tonemap -> grade -> shadow dither
// -> outline -> vignette -> grain -> ordered-dither quantize); every stage is
// deterministic per (texel, frame). Push constants are byte-identical to the
// Rust TonePush (backend.rs).

#include <metal_stdlib>
using namespace metal;

struct Push {
    int4   dims;   // low_w, low_h, out_w, out_h
    int4   cfg;    // scale, pan_x, pan_y, _
    float4 fcfg;   // exposure, grain strength, frame, dither world-phase x
    float4 projA;  // px.x = dot(P, projA.xyz) + projA.w
    float4 projB;  // px.y = dot(P, projB.xyz) + projB.w
    float4 style1; // grade preset, poster bands, dither mode, dither amount
    float4 style2; // palette mode, palette param, vignette, outline strength
    float4 style3; // grain size px, grain static flag, bloom strength, bloom threshold
    float4 style4; // shadow dither: strength, levels, luma threshold, dither world-phase y
    float4 style5; // saturation, contrast, _, _ (post-grade colour shaping)
};

static float luma(float3 c) { return dot(c, float3(0.2126, 0.7152, 0.0722)); }

// ---- grade presets (style1.x) -------------------------------------------
static float3 gradeFallout(float3 g) {
    float y = luma(g);
    g = mix(g, float3(y), 0.22);
    g += float3(0.04, 0.10, 0.10) * (1.0 - y) * 0.55 + float3(0.10, 0.06, -0.04) * y * 0.55;
    g = g * 0.92 + 0.02;
    g = clamp(g, 0.0, 1.0);
    float3 s = g * g * (3.0 - 2.0 * g);
    return clamp(mix(g, s, 0.35), 0.0, 1.0);
}
static float3 gradeNoir(float3 g) {
    float y = luma(g);
    g = mix(g, float3(y), 0.85);
    g += float3(-0.02, 0.00, 0.04) * (1.0 - y) * 0.6;
    g = (g - 0.5) * 1.28 + 0.46;
    g = clamp(g, 0.0, 1.0);
    float3 s = g * g * (3.0 - 2.0 * g);
    return clamp(mix(g, s, 0.5), 0.0, 1.0);
}
static float3 gradeSepia(float3 g) {
    float y = luma(g);
    float3 sep = float3(1.10, 0.96, 0.72) * pow(y, 0.95);
    g = mix(g, sep, 0.7);
    return clamp(g * 0.94 + 0.03, 0.0, 1.0);
}
static float3 gradeNeon(float3 g) {
    float y = luma(g);
    g += float3(-0.06, 0.06, 0.14) * (1.0 - y) * 0.8 + float3(0.16, -0.03, 0.12) * y * 0.6;
    g = clamp(g, 0.0, 1.0);
    float3 s = g * g * (3.0 - 2.0 * g);
    return clamp(mix(g, s, 0.45), 0.0, 1.0);
}
static float3 gradeBleach(float3 g) {
    float y = luma(g);
    float3 d = mix(g, float3(y), 0.55);
    float3 ov = mix(2.0 * d * y, 1.0 - 2.0 * (1.0 - d) * (1.0 - y), step(0.5, y));
    return clamp(mix(d, ov, 0.6), 0.0, 1.0);
}
static float3 gradeMidnight(float3 g) {
    float y = luma(g);
    float sh = 1.0 - smoothstep(0.0, 0.55, y);
    float3 ind = float3(0.45, 0.40, 1.00) * y * 1.15;
    return clamp(mix(g, ind, 0.55 * sh), 0.0, 1.0);
}

static uint hashu(uint x) { x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return x; }

// Ordered-dither threshold matrices, centred to [-0.5, 0.5)
constant float BAYER[64] = {
     0., 32.,  8., 40.,  2., 34., 10., 42., 48., 16., 56., 24., 50., 18., 58., 26.,
    12., 44.,  4., 36., 14., 46.,  6., 38., 60., 28., 52., 20., 62., 30., 54., 22.,
     3., 35., 11., 43.,  1., 33.,  9., 41., 51., 19., 59., 27., 49., 17., 57., 25.,
    15., 47.,  7., 39., 13., 45.,  5., 37., 63., 31., 55., 23., 61., 29., 53., 21.,
};
constant float BAYER4[16] = { 0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5. };
constant float BAYER2[4] = { 0., 2., 3., 1. };

// ordered-dither threshold for game pixel lp, centred to [-0.5, 0.5)
// (mode: 1 bayer8, 2 bayer4, 3 bayer2, 4 IGN static, 5 white animated)
static float ditherAt(int dm, int2 lp, uint frame) {
    if (dm == 1) return (BAYER[(lp.x & 7) + (lp.y & 7) * 8] + 0.5) / 64.0 - 0.5;
    if (dm == 2) return (BAYER4[(lp.x & 3) + (lp.y & 3) * 4] + 0.5) / 16.0 - 0.5;
    if (dm == 3) return (BAYER2[(lp.x & 1) + (lp.y & 1) * 2] + 0.5) / 4.0 - 0.5;
    if (dm == 4) return fract(52.9829189 * fract(0.06711056 * float(lp.x) + 0.00583715 * float(lp.y))) - 0.5; // IGN, static
    if (dm == 5) return float(hashu(uint(lp.x) * 7919u + uint(lp.y) * 104729u + frame * 15485863u)) * (1.0 / 4294967296.0) - 0.5; // white, animated
    return 0.0;
}

// Hand-designed 32-colour palette (gamma space).
constant float3 PAL[32] = {
    float3(0.0196, 0.0235, 0.0314), float3(0.0510, 0.0549, 0.0784),
    float3(0.0824, 0.0941, 0.1373), float3(0.1137, 0.1412, 0.2000),
    float3(0.1529, 0.2039, 0.2784), float3(0.1961, 0.2118, 0.1686),
    float3(0.2588, 0.2745, 0.2275), float3(0.3333, 0.3529, 0.2784),
    float3(0.4157, 0.4392, 0.3373), float3(0.5137, 0.5373, 0.4078),
    float3(0.6157, 0.6392, 0.4941), float3(0.2275, 0.1647, 0.1098),
    float3(0.3608, 0.2549, 0.1569), float3(0.5216, 0.3608, 0.2000),
    float3(0.6902, 0.4902, 0.2549), float3(0.8392, 0.6431, 0.3373),
    float3(0.9490, 0.8118, 0.5412), float3(0.7098, 0.7020, 0.6039),
    float3(0.8157, 0.8039, 0.7059), float3(0.9098, 0.8941, 0.8118),
    float3(0.9804, 0.9647, 0.9020), float3(0.1137, 0.2902, 0.2902),
    float3(0.1843, 0.4784, 0.4314), float3(0.3216, 0.7686, 0.6588),
    float3(0.2902, 0.1137, 0.1137), float3(0.5412, 0.2000, 0.1529),
    float3(0.7608, 0.3373, 0.2118), float3(0.6510, 0.4157, 0.1216),
    float3(0.8784, 0.6039, 0.1686), float3(0.1647, 0.2118, 0.1333),
    float3(0.2667, 0.3294, 0.1882), float3(0.3961, 0.4667, 0.2902),
};
// DMG Game Boy 4-tone (darkest -> lightest)
constant float3 GB[4] = {
    float3(0.059, 0.220, 0.059), float3(0.188, 0.384, 0.188),
    float3(0.545, 0.675, 0.059), float3(0.608, 0.737, 0.059),
};

kernel void tonemap(
    device const float4* colorBuf  [[buffer(0)]], // radiance (low_w*low_h)
    device const float4* albedoBuf [[buffer(1)]], // primary-hit albedo
    device const float4* posBuf    [[buffer(2)]], // primary-hit world position (w=0 sky)
    constant Push&       pc        [[buffer(3)]],
    texture2d<float, access::write> outTex [[texture(0)]], // 8-bit window image (out_w*out_h)
    uint2 gid [[thread_position_in_grid]])
{
    int2 o = int2(gid);
    if (o.x >= pc.dims.z || o.y >= pc.dims.w) return;
    int lowW = pc.dims.x, lowH = pc.dims.y;
    int scale = max(pc.cfg.x, 1);
    uint frame = uint(pc.fcfg.z);

    // output pixel -> low-res source texel (+ whole-pixel pan)
    int2 lp = o / scale + int2(pc.cfg.y, pc.cfg.z);

    float3 col;
    if (lp.x < 0 || lp.y < 0 || lp.x >= lowW || lp.y >= lowH) {
        col = float3(0.05, 0.05, 0.06); // guard band
    } else {
        uint li = uint(lp.y * lowW + lp.x);
        float3 radiance = colorBuf[li].rgb;

        // world-anchored lattice for dither + grain
        int2 dlp = lp - int2(int(pc.fcfg.w), int(pc.style4.w));

        // cel-posterized lighting (style1.y)
        int poster = int(pc.style1.y + 0.5);
        if (poster > 0) {
            float3 alb = max(albedoBuf[li].rgb, float3(1e-3));
            float3 irr = radiance / alb;
            float y = luma(irr) * pc.fcfg.x;
            if (y > 1e-5) {
                float t = y / (y + 1.0);
                float tq = (floor(t * float(poster)) + 0.5) / float(poster);
                float yq = tq / max(1.0 - tq, 1e-3);
                irr *= yq / y;
            }
            radiance = irr * alb;
        }

        float3 hdr = radiance * pc.fcfg.x;

        // bloom: octagonal HDR gather at 3 radii (style3.z/.w). Pre-tonemap.
        if (pc.style3.z > 0.0) {
            const int2 OCT[8] = { int2(1,0), int2(1,1), int2(0,1), int2(-1,1), int2(-1,0), int2(-1,-1), int2(0,-1), int2(1,-1) };
            float3 bacc = float3(0.0);
            float bw = 0.0;
            for (int r = 0; r < 3; r++) {
                int rad = 2 << r;
                float w = 1.0 / float(1 << r);
                for (int k = 0; k < 8; k++) {
                    int2 q = clamp(lp + OCT[k] * rad, int2(0), int2(lowW - 1, lowH - 1));
                    float3 s = colorBuf[uint(q.y * lowW + q.x)].rgb * pc.fcfg.x;
                    float l = luma(s);
                    bacc += s * (max(l - pc.style3.w, 0.0) / max(l, 1e-4)) * w;
                    bw += w;
                }
            }
            hdr += bacc / bw * pc.style3.z;
        }

        col = hdr / (hdr + float3(1.0));   // Reinhard
        col = pow(col, float3(1.0 / 2.2)); // gamma

        int gp = int(pc.style1.x + 0.5);
        if      (gp == 1) col = gradeFallout(col);
        else if (gp == 2) col = gradeNoir(col);
        else if (gp == 3) col = gradeSepia(col);
        else if (gp == 4) col = gradeNeon(col);
        else if (gp == 5) col = gradeBleach(col);
        else if (gp == 6) col = gradeMidnight(col);

        // punchy colour shaping (style5): saturation around luma, then contrast
        // around mid-grey. Neutral (1,1) skips → byte-identical to the old look.
        if (pc.style5.x != 1.0 || pc.style5.y != 1.0) {
            float yl = luma(col);
            col = yl + (col - yl) * pc.style5.x;
            col = (col - 0.5) * pc.style5.y + 0.5;
            col = clamp(col, 0.0, 1.0);
        }

        // shadow dither (style4)
        if (pc.style4.x > 0.0) {
            float y = luma(col);
            float sw = (1.0 - smoothstep(pc.style4.z * 0.55, pc.style4.z, y)) * pc.style4.x;
            if (sw > 1e-3 && y > 1e-4) {
                float dth = ditherAt(int(pc.style1.z + 0.5), dlp, frame);
                float L = max(pc.style4.y, 2.0) - 1.0;
                float yq = floor(clamp(y + dth / L, 0.0, 1.0) * L + 0.5) / L;
                col = mix(col, col * (yq / y), sw);
            }
        }

        // outline (style2.w): darken silhouette / sky-adjacent pixels. A dissolved
        // wall (ROI contour) is tagged P0.w==2 and MUST outline even when the global
        // outline knob is off — the contour IS the x-ray feature.
        float4 P0 = posBuf[li];
        bool isContour = P0.w > 1.5;
        if (P0.w > 0.0 && (pc.style2.w > 0.0 || isContour)) {
            float3 f = normalize(cross(pc.projA.xyz, pc.projB.xyz));
            float d0 = dot(P0.xyz, f);
            float edge = 0.0;
            const int2 N4[4] = { int2(1,0), int2(-1,0), int2(0,1), int2(0,-1) };
            for (int k = 0; k < 4; k++) {
                int2 q = clamp(lp + N4[k], int2(0), int2(lowW - 1, lowH - 1));
                float4 Pn = posBuf[uint(q.y * lowW + q.x)];
                float dn = dot(Pn.xyz, f) - d0;
                // contour traces the FULL wall silhouette → fire on a depth jump in
                // EITHER direction (top + side silhouettes). Normal outline keeps the
                // directional test so goldens stay byte-identical.
                if (Pn.w == 0.0 || (isContour ? abs(dn) > 0.20 : dn > 0.28)) { edge = 1.0; break; }
            }
            // contour CREASE: the wall BASE meets the floor with a normal flip but
            // almost no depth jump (same signature as the disc edge, which must stay
            // clean). Curvature tells them apart: a crease bends the position field
            // (Laplacian large), the disc edge keeps a flat wall plane (~0).
            if (isContour && edge == 0.0) {
                float4 PL = posBuf[uint(clamp(lp.y, 0, lowH - 1) * lowW + clamp(lp.x - 1, 0, lowW - 1))];
                float4 PR = posBuf[uint(clamp(lp.y, 0, lowH - 1) * lowW + clamp(lp.x + 1, 0, lowW - 1))];
                float4 PU = posBuf[uint(clamp(lp.y - 1, 0, lowH - 1) * lowW + clamp(lp.x, 0, lowW - 1))];
                float4 PD = posBuf[uint(clamp(lp.y + 1, 0, lowH - 1) * lowW + clamp(lp.x, 0, lowW - 1))];
                if (PL.w > 0.0 && PR.w > 0.0 && length(PL.xyz + PR.xyz - 2.0 * P0.xyz) > 0.02) edge = 1.0;
                if (PU.w > 0.0 && PD.w > 0.0 && length(PU.xyz + PD.xyz - 2.0 * P0.xyz) > 0.02) edge = 1.0;
            }
            if (isContour) {
                // x-ray CONTOUR: dissolved-wall silhouette as a FAINT cool line over
                // the ghost stipple + room behind — subtle additive cyan, half blend.
                col = mix(col, clamp(col * 1.10 + float3(0.05, 0.12, 0.18), 0.0, 1.0), edge * 0.5);
            } else {
                col = mix(col, col * 0.30, pc.style2.w * edge);
            }
        }

        // vignette (style2.z), over the VISIBLE crop
        if (pc.style2.z > 0.0) {
            float2 vis = float2(pc.dims.z, pc.dims.w) / float(scale);
            float2 uvv = (float2(lp - int2(pc.cfg.y, pc.cfg.z)) + 0.5) / vis - 0.5;
            float v2 = dot(uvv, uvv) * 2.0;
            col *= 1.0 - pc.style2.z * smoothstep(0.2, 1.0, v2);
        }

        // film grain (fcfg.y), per grain cell (style3.x), shadow-weighted
        if (pc.fcfg.y > 0.0) {
            int gs = max(int(pc.style3.x + 0.5), 1);
            int2 gq = int2(floor(float2(dlp) / float(gs)));
            uint fr = pc.style3.y > 0.5 ? 0u : frame;
            uint h = hashu(uint(gq.x) * 1973u + uint(gq.y) * 9277u + fr * 26699u + 1u);
            float g = float(h) * (1.0 / 4294967296.0) - 0.5;
            col += g * pc.fcfg.y * (0.35 + 0.65 * (1.0 - luma(col)));
            col = clamp(col, 0.0, 1.0);
        }

        // ordered-dither quantize (style2.x)
        int pm = int(pc.style2.x + 0.5);
        if (pm > 0) {
            float dth = ditherAt(int(pc.style1.z + 0.5), dlp, frame);
            float3 c2 = clamp(col + dth * pc.style1.w, 0.0, 1.0);
            if (pm == 1) { // nearest in the 32-colour palette
                float best = 1e9;
                float3 bc = c2;
                for (int i = 0; i < 32; i++) {
                    float3 dd = PAL[i] - c2;
                    float d2 = dot(dd, dd);
                    if (d2 < best) { best = d2; bc = PAL[i]; }
                }
                col = bc;
            } else if (pm == 2) { // per-channel posterize to N levels
                float L = max(pc.style2.y, 2.0) - 1.0;
                col = floor(c2 * L + 0.5) / L;
            } else if (pm == 3) { // duotone luma ramp (param picks the pair)
                int pair = int(pc.style2.y + 0.5);
                float3 A, B;
                if      (pair == 1) { A = float3(0.04, 0.16, 0.18); B = float3(0.98, 0.76, 0.62); }
                else if (pair == 2) { A = float3(0.01, 0.05, 0.02); B = float3(0.45, 0.95, 0.45); }
                else                { A = float3(0.08, 0.07, 0.20); B = float3(0.99, 0.82, 0.50); }
                col = mix(A, B, luma(c2));
            } else if (pm == 4) { // Game Boy 4-tone
                col = GB[clamp(int(luma(c2) * 4.0), 0, 3)];
            }
        }
    }
    outTex.write(float4(clamp(col, 0.0, 1.0), 1.0), uint2(gid));
}
