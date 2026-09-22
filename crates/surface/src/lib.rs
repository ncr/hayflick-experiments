//! surface — painted wall surfaces, baked on the CPU at game-pixel density
//! (owner 2026-09-22: the wear pipeline's sliders are too complicated; walls
//! get painted with brushes in creative mode instead).
//!
//! WHY BAKE. The game renders with big pixels: a 6 × 3.2 wu wall face is about
//! 240 × 124 game pixels on screen. Evaluating procedural noise per ray every
//! frame, in two shader languages, through a 32-bit material budget, buys
//! nothing a one-off bake of those ~30 k texels does not — and the bake is one
//! Rust function per effect: no GLSL/MSL twins, no bit budget, testable and
//! PNG-dumpable without a GPU.
//!
//! WHY THIS DENSITY. A face's texel grid is chosen so ONE TEXEL IS ONE GAME
//! PIXEL: the game projection images 1 wu of world +x as 40 px across, 1 wu of
//! +z as 20 px, and 1 wu of height as 38.73 px (trimetric; `iso_core`), so a
//! wall along x gets 40 texels per wu, a wall along z 20, and every face 38.73
//! rows per wu. The shader samples NEAREST, so a wall reads as pixel art with
//! no shimmer; after a q/e quarter turn the two densities swap and the ratio is
//! 2:1 or 1:2 — still whole pixels.
//!
//! THE MODEL. A face is a stack of texel LAYERS — `loss` (cover lost, in wu:
//! drives the displaced mesh and the exposed aggregate), `crack`, `wet`,
//! `leach`, `soot`, `rust` — written by brush [`Stroke`]s through one function
//! per [`Effect`], then composed into albedo by [`Face::shade`]. Order is
//! fixed (spall → rain → rust → soot) so a stroke list is a complete,
//! order-independent description of a wall's history.

/// A brush effect. The creative-mode palette, one tool each.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Effect {
    /// Water runoff: dark wet streaks flowing DOWN from the stroke, pale
    /// leached lime at their edges, a damp foot.
    Rain,
    /// Fire: soot rising UP from the stroke in a widening plume, heat-tinted
    /// cement near the source.
    Soot,
    /// Cover loss: an angular crater of broken cover with exposed aggregate,
    /// radiating cracks, and — past the mat — steel that bleeds rust downward.
    Spall,
}

impl Effect {
    pub const ALL: [Effect; 3] = [Effect::Rain, Effect::Soot, Effect::Spall];

    pub fn name(self) -> &'static str {
        match self {
            Effect::Rain => "rain",
            Effect::Soot => "soot",
            Effect::Spall => "spall",
        }
    }

    pub fn by_name(s: &str) -> Option<Effect> {
        Effect::ALL.into_iter().find(|e| e.name() == s)
    }
}

/// One brush dab, in FACE coordinates: `u` along the wall from its start, `v`
/// up from the ground, both world units; `r` the brush radius.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Stroke {
    pub effect: Effect,
    pub u: f32,
    pub v: f32,
    pub r: f32,
}

/// Texels per world unit along a wall running along world x / z, and up.
pub const TX_ALONG_X: f32 = 40.0;
pub const TX_ALONG_Z: f32 = 20.0;
pub const TX_UP: f32 = 38.729_83;

/// Deepest cover loss a spall cuts (wu). Leaves the rear half of a 0.2 wall.
pub const LOSS_MAX: f32 = 0.13;
/// Depth of the reinforcement mat behind the face (wu): a spall deeper than
/// this shows steel.
pub const COVER: f32 = 0.055;
/// Mat pitch: vertical bars every `BAR_PITCH_U` from `BAR_U0`, horizontal
/// bars every `BAR_PITCH_V` from `BAR_V0` (the concrete study's cage).
pub const BAR_U0: f32 = 0.24;
pub const BAR_PITCH_U: f32 = 0.45;
pub const BAR_V0: f32 = 0.32;
pub const BAR_PITCH_V: f32 = 0.5;

/// What the bake needs to know about a face.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct FaceSpec {
    /// Face length along the wall and height, wu.
    pub len: f32,
    pub height: f32,
    /// Texels per wu along the wall ([`TX_ALONG_X`] or [`TX_ALONG_Z`]) and up.
    pub tx_u: f32,
    pub tx_v: f32,
    /// Per-face noise seed (the adapter derives it from the world position,
    /// so a wall's texture does not change when another wall is added).
    pub seed: u32,
}

impl FaceSpec {
    pub fn dims(&self) -> (usize, usize) {
        (((self.len * self.tx_u).ceil() as usize).max(1), ((self.height * self.tx_v).ceil() as usize).max(1))
    }
}

/// A baked face. Every layer is `w × h`, row-major, row 0 at the BOTTOM.
pub struct Face {
    pub spec: FaceSpec,
    pub w: usize,
    pub h: usize,
    pub loss: Vec<f32>,
    pub crack: Vec<f32>,
    pub wet: Vec<f32>,
    pub leach: Vec<f32>,
    pub soot: Vec<f32>,
    pub rust: Vec<f32>,
}

// ---- noise --------------------------------------------------------------

fn hash(x: i32, y: i32, seed: u32) -> f32 {
    let mut a = (x as u32).wrapping_mul(0x9e37_79b9) ^ (y as u32).wrapping_mul(0x85eb_ca6b) ^ seed.wrapping_mul(0xc2b2_ae35);
    a ^= a >> 16;
    a = a.wrapping_mul(0x7feb_352d);
    a ^= a >> 15;
    (a & 0xff_ffff) as f32 / 16_777_215.0
}

fn noise(x: f32, y: f32, seed: u32) -> f32 {
    let (ix, iy) = (x.floor(), y.floor());
    let (fx, fy) = (x - ix, y - iy);
    let (sx, sy) = (fx * fx * (3.0 - 2.0 * fx), fy * fy * (3.0 - 2.0 * fy));
    let (x0, y0) = (ix as i32, iy as i32);
    let a = hash(x0, y0, seed) * (1.0 - sx) + hash(x0 + 1, y0, seed) * sx;
    let b = hash(x0, y0 + 1, seed) * (1.0 - sx) + hash(x0 + 1, y0 + 1, seed) * sx;
    a * (1.0 - sy) + b * sy
}

fn fbm(x: f32, y: f32, seed: u32) -> f32 {
    0.57 * noise(x, y, seed) + 0.29 * noise(x * 2.07 + 19.3, y * 2.07, seed + 1) + 0.14 * noise(x * 4.13 + 7.1, y * 4.13, seed + 2)
}

fn smooth(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn stroke_seed(s: &Stroke, seed: u32) -> u32 {
    seed ^ ((s.u * 97.0) as i32 as u32).wrapping_mul(2_654_435_761) ^ ((s.v * 131.0) as i32 as u32).wrapping_mul(40_503)
}

/// A brush footprint: a soft disc whose rim is broken by noise, so a stroke
/// never reads as a circle.
fn dab(s: &Stroke, u: f32, v: f32, seed: u32) -> f32 {
    let d = ((u - s.u).powi(2) + (v - s.v).powi(2)).sqrt() / s.r.max(1e-3);
    if d > 1.4 {
        return 0.0;
    }
    let n = fbm(u * 4.0, v * 4.0, stroke_seed(s, seed));
    1.0 - smooth(0.5, 1.0, d + 0.4 * (n - 0.5))
}

/// A spall crater's depth fraction (0 outside, 1 at full depth): an irregular
/// POLYGON of fracture facets, not an oval — broken cover fails along planes.
fn crater(s: &Stroke, u: f32, v: f32, seed: u32) -> f32 {
    let (qx, qy) = ((u - s.u) / s.r.max(1e-3), (v - s.v) / (s.r.max(1e-3) * 0.8));
    if qx * qx + qy * qy > 2.5 {
        return 0.0;
    }
    let ss = stroke_seed(s, seed);
    let mut boundary = -10.0f32;
    for k in 0..7 {
        let a = k as f32 * std::f32::consts::TAU / 7.0 + (hash(k, 0, ss) - 0.5) * 0.5;
        boundary = boundary.max((qx * a.cos() + qy * a.sin()) / (0.72 + 0.3 * hash(k, 1, ss)));
    }
    let q = 1.0 - boundary + 0.12 * (noise(u * 7.0, v * 7.0, ss) - 0.5) + 0.05 * (noise(u * 17.0, v * 17.0, ss + 5) - 0.5);
    smooth(-0.02, 0.2, q)
}

/// Cracks radiating from a spall: a few kinked rays, one texel wide, fading
/// with distance. Returns 0..1 coverage at (u, v).
fn cracks(s: &Stroke, u: f32, v: f32, seed: u32, texel: f32) -> f32 {
    let ss = stroke_seed(s, seed) ^ 0x51ed;
    let (dx, dy) = (u - s.u, v - s.v);
    let mut c = 0.0f32;
    for k in 0..5 {
        let a = k as f32 * std::f32::consts::TAU / 5.0 + (hash(k, 3, ss) - 0.5) * 0.9;
        let (ax, ay) = (a.cos(), a.sin());
        let t = dx * ax + dy * ay;
        let reach = s.r * (1.3 + 1.4 * hash(k, 4, ss));
        if t < s.r * 0.5 || t > reach {
            continue;
        }
        // a kinked path: the lateral offset wanders per 0.12-wu segment
        let seg = (t / 0.12).floor() as i32;
        let f = t / 0.12 - seg as f32;
        let wander = ((1.0 - f) * hash(seg, k, ss) + f * hash(seg + 1, k, ss) - 0.5) * 0.1;
        let side = (-dx * ay + dy * ax - wander).abs();
        let fade = 1.0 - smooth(reach * 0.6, reach, t);
        if side < texel * 0.75 {
            c = c.max(fade);
        }
    }
    c
}

fn on_bar(u: f32, v: f32, width: f32) -> bool {
    let du = ((u - BAR_U0) / BAR_PITCH_U).round() * BAR_PITCH_U + BAR_U0 - u;
    let dv = ((v - BAR_V0) / BAR_PITCH_V).round() * BAR_PITCH_V + BAR_V0 - v;
    du.abs() < width || dv.abs() < width
}

impl Face {
    /// Bake a face from its strokes. Pure: same spec + strokes, same bytes.
    pub fn bake(spec: FaceSpec, strokes: &[Stroke]) -> Face {
        let (w, h) = spec.dims();
        let n = w * h;
        let mut f = Face { spec, w, h, loss: vec![0.0; n], crack: vec![0.0; n], wet: vec![0.0; n], leach: vec![0.0; n], soot: vec![0.0; n], rust: vec![0.0; n] };
        let seed = spec.seed;
        let texel = 1.0 / spec.tx_u.min(spec.tx_v);
        let at = |i: usize, j: usize| ((i as f32 + 0.5) / spec.tx_u, (j as f32 + 0.5) / spec.tx_v);
        let of = |e: Effect| strokes.iter().filter(move |s| s.effect == e);

        // 1. SPALL — cover loss, cracks
        for s in of(Effect::Spall) {
            for j in 0..h {
                for i in 0..w {
                    let (u, v) = at(i, j);
                    let k = j * w + i;
                    let c = crater(s, u, v, seed);
                    if c > 0.0 {
                        let rough = noise(u * 13.0, v * 13.0, seed + 3);
                        f.loss[k] = f.loss[k].max((c * (0.1 + 0.03 * rough)).min(LOSS_MAX));
                    }
                    f.crack[k] = f.crack[k].max(cracks(s, u, v, seed, texel) * (1.0 - c));
                }
            }
        }
        // 2. RAIN — sources, then transport down each column
        let mut src = vec![0.0f32; n];
        for s in of(Effect::Rain) {
            for j in 0..h {
                for i in 0..w {
                    let (u, v) = at(i, j);
                    src[j * w + i] = src[j * w + i].max(dab(s, u, v, seed));
                }
            }
        }
        if src.iter().any(|&x| x > 0.0) {
            for i in 0..w {
                let u = (i as f32 + 0.5) / spec.tx_u;
                // some columns carry water, some stay dry: streaks, not a
                // wash — at this pixel size a streak must be a decided column
                let carry = if noise(u * 13.0, 0.0, seed + 13) > 0.5 { 1.0 } else { 0.3 * hash(i as i32, 0, seed + 14) };
                let mut flow = 0.0f32;
                for j in (0..h).rev() {
                    let k = j * w + i;
                    let v = (j as f32 + 0.5) / spec.tx_v;
                    // each streak thins out as it runs, and breaks up here and there
                    let run = 0.994 - 0.01 * noise(u * 5.0, v * 3.0, seed + 15);
                    flow = (flow * run).max(src[k] * carry);
                    f.wet[k] = flow.max(src[k] * 0.3);
                    // lime leaches out along the streak edges, higher up
                    let edge = smooth(0.62, 0.8, noise(u * 23.0, v * 0.6, seed + 17));
                    f.leach[k] = flow * edge * smooth(0.25, 0.9, v);
                    // a damp foot where a streak reaches the ground
                    f.wet[k] = f.wet[k].max(flow * (1.0 - smooth(0.0, 0.45, v)) * 1.2);
                }
            }
        }
        // 3. RUST — from steel a spall exposed, bleeding down in narrow,
        // broken runs: only some columns under the steel carry it, and each
        // run thins out as it goes
        for i in 0..w {
            let u = (i as f32 + 0.5) / spec.tx_u;
            let runs = smooth(0.55, 0.8, noise(u * 17.0, 0.0, seed + 31));
            let mut bleed = 0.0f32;
            for j in (0..h).rev() {
                let k = j * w + i;
                let v = (j as f32 + 0.5) / spec.tx_v;
                let steel = f.loss[k] > COVER && on_bar(u, v, 0.03);
                bleed = (bleed * 0.982).max(if steel { runs } else { 0.0 });
                let breakup = smooth(0.25, 0.7, fbm(u * 9.0, v * 1.2, seed + 29));
                // oxide stains the whole crater floor near the mat, lightly
                let floor = if f.loss[k] > COVER * 0.7 { 0.3 * breakup } else { 0.0 };
                f.rust[k] = (bleed * breakup).max(floor);
            }
        }
        // 4. SOOT — each fire source feeds a plume: a cone that widens
        // linearly as it climbs, sways sideways, thins out with height and is
        // broken into tongues by stretched noise
        for s in of(Effect::Soot) {
            let ss = stroke_seed(s, seed) ^ 0x50_07;
            for j in 0..h {
                for i in 0..w {
                    let k = j * w + i;
                    let (u, v) = at(i, j);
                    // the fire's seat: charred, broken — not a flat stamp
                    let seat = smooth(0.3, 0.75, fbm(u * 6.0, v * 6.0, ss + 3));
                    let base = dab(s, u, v, seed) * (0.35 + 0.5 * seat);
                    let dv = v - s.v;
                    let plume = if dv > 0.0 {
                        let width = s.r * 0.6 + dv * 0.42;
                        let sway = (fbm(v * 0.9, 0.0, ss) - 0.5) * 0.9 * dv;
                        let lateral = (u - s.u - sway).abs() / width;
                        let edge = fbm(u * 3.0, v * 1.4, ss + 1);
                        let body = 1.0 - smooth(0.45, 1.0, lateral + 0.45 * (edge - 0.5));
                        let tongue = smooth(0.2, 0.7, fbm(u * 3.2, v * 0.8, ss + 2));
                        body * (0.45 + 0.55 * tongue) * (-dv * 0.32).exp()
                    } else {
                        0.0
                    };
                    f.soot[k] = f.soot[k].max(base.max(plume).min(1.0));
                }
            }
        }
        f
    }

    fn idx(&self, i: usize, j: usize) -> usize {
        j * self.w + i
    }

    /// Cover loss at a face point (bilinear over texel centres) — the
    /// geometry pass displaces the mesh with this.
    pub fn loss_at(&self, u: f32, v: f32) -> f32 {
        let x = (u * self.spec.tx_u - 0.5).clamp(0.0, (self.w - 1) as f32);
        let y = (v * self.spec.tx_v - 0.5).clamp(0.0, (self.h - 1) as f32);
        let (i0, j0) = (x.floor() as usize, y.floor() as usize);
        let (i1, j1) = ((i0 + 1).min(self.w - 1), (j0 + 1).min(self.h - 1));
        let (fx, fy) = (x - i0 as f32, y - j0 as f32);
        let l = |i, j| self.loss[self.idx(i, j)];
        (l(i0, j0) * (1.0 - fx) + l(i1, j0) * fx) * (1.0 - fy) + (l(i0, j1) * (1.0 - fx) + l(i1, j1) * fx) * fy
    }

    /// Compose the layers into LINEAR albedo, one rgb per texel.
    pub fn shade(&self) -> Vec<[f32; 3]> {
        let seed = self.spec.seed;
        let mut out = Vec::with_capacity(self.w * self.h);
        let mix = |a: [f32; 3], b: [f32; 3], t: f32| [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
        let mul = |a: [f32; 3], s: f32| [a[0] * s, a[1] * s, a[2] * s];
        for j in 0..self.h {
            for i in 0..self.w {
                let k = self.idx(i, j);
                let (u, v) = ((i as f32 + 0.5) / self.spec.tx_u, (j as f32 + 0.5) / self.spec.tx_v);
                let macro_ = fbm(u * 0.85, v * 0.85, seed);
                let mottle = fbm(u * 3.1, v * 3.1, seed + 51);
                let mut c = mix([0.17, 0.173, 0.16], [0.315, 0.31, 0.283], macro_);
                c = mul(c, 0.9 + 0.2 * mottle);
                // per-texel grit: THE pixel-art grain of cast concrete
                c = mul(c, 0.955 + 0.09 * hash(i as i32, j as i32, seed + 41));
                let exposed = smooth(0.015, 0.06, self.loss[k]);
                let skin = 1.0 - exposed;
                // casting history survives only on the original skin: faint
                // lift joints every 0.62 wu and recessed form-tie holes
                let lift = ((v / 0.62 + 0.5).fract() - 0.5).abs() * 0.62;
                if lift < 0.5 / self.spec.tx_v {
                    c = mul(c, 1.0 - 0.13 * skin);
                }
                let (tu, tv) = (((u / 1.1 + 0.5).fract() - 0.5) * 1.1, ((v / 0.62 + 0.25).fract() - 0.5) * 0.62);
                if tu.abs() < 0.6 / self.spec.tx_u && tv.abs() < 0.6 / self.spec.tx_v {
                    c = mul(c, 1.0 - 0.5 * skin);
                }
                // exposed aggregate: angular stones at ~15 per wu
                if exposed > 0.0 {
                    // nearest of the jittered cell centres around this texel
                    let (gx, gy) = (u * 12.0, v * 12.0);
                    let (cx, cy) = (gx.floor() as i32, gy.floor() as i32);
                    let mut best = (9.0f32, 0.0f32);
                    for dy in -1..=1 {
                        for dx in -1..=1 {
                            let a = hash(cx + dx, cy + dy, seed + 23);
                            let px = (cx + dx) as f32 + 0.2 + 0.6 * a;
                            let py = (cy + dy) as f32 + 0.2 + 0.6 * hash(cx + dx, cy + dy, seed + 24);
                            let (fx, fy) = (gx - px, gy - py);
                            // crushed stone is angular: a slab intersection, not a disc
                            let d = (fx.abs() * 1.1).max(fy.abs() * 1.45).max((fx + fy).abs() * 0.85) - 0.16 * a;
                            if d < best.0 {
                                best = (d, a);
                            }
                        }
                    }
                    if best.0 < 0.22 {
                        c = mix(c, mix([0.055, 0.062, 0.057], [0.30, 0.295, 0.27], best.1), exposed * 0.9);
                    }
                    // the crater floor sits in its own shadow
                    c = mul(c, 1.0 - 0.28 * smooth(0.04, LOSS_MAX, self.loss[k]));
                }
                c = mul(c, 1.0 - 0.55 * self.crack[k]);
                c = mul(c, 1.0 - 0.58 * self.wet[k].min(1.0));
                c = mix(c, [0.44, 0.445, 0.415], 0.45 * self.leach[k] * skin);
                c = mix(c, [0.205, 0.075, 0.021], 0.73 * self.rust[k].min(1.0));
                // heat alters the cement near a fire before soot covers it
                let soot = self.soot[k].min(1.0);
                c = mix(c, [0.25, 0.18, 0.135], 0.3 * smooth(0.2, 0.6, soot) * smooth(0.4, 0.65, macro_));
                c = mix(c, [0.027, 0.029, 0.027], 0.92 * soot * (1.0 - 0.65 * exposed));
                out.push(c);
            }
        }
        out
    }
}

/// Pack linear rgb for the GPU: gamma-2 encoded RGBA8 (the shader squares it
/// back), so the darks keep their steps in 8 bits.
pub fn pack(c: [f32; 3]) -> u32 {
    let q = |x: f32| (x.max(0.0).sqrt().min(1.0) * 255.0 + 0.5) as u32;
    q(c[0]) | q(c[1]) << 8 | q(c[2]) << 16 | 0xff << 24
}

pub fn unpack(p: u32) -> [f32; 3] {
    let d = |s: u32| {
        let x = ((p >> s) & 0xff) as f32 / 255.0;
        x * x
    };
    [d(0), d(8), d(16)]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> FaceSpec {
        FaceSpec { len: 4.0, height: 3.2, tx_u: TX_ALONG_X, tx_v: TX_UP, seed: 7 }
    }

    fn col_mean(layer: &[f32], f: &Face, v0: f32, v1: f32, u0: f32, u1: f32) -> f32 {
        let mut s = 0.0;
        let mut n = 0;
        for j in 0..f.h {
            for i in 0..f.w {
                let (u, v) = ((i as f32 + 0.5) / f.spec.tx_u, (j as f32 + 0.5) / f.spec.tx_v);
                if v >= v0 && v < v1 && u >= u0 && u < u1 {
                    s += layer[j * f.w + i];
                    n += 1;
                }
            }
        }
        s / n.max(1) as f32
    }

    #[test]
    fn one_texel_is_one_game_pixel() {
        let (w, h) = spec().dims();
        assert_eq!((w, h), (160, 124), "4 wu along x = 160 px, 3.2 wu up = 124 rows");
    }

    #[test]
    fn a_clean_face_has_no_effects_and_a_stroke_is_deterministic() {
        let f = Face::bake(spec(), &[]);
        assert!(f.loss.iter().chain(&f.wet).chain(&f.soot).chain(&f.rust).all(|&x| x == 0.0));
        let s = [Stroke { effect: Effect::Rain, u: 2.0, v: 2.6, r: 0.4 }, Stroke { effect: Effect::Spall, u: 1.0, v: 1.2, r: 0.35 }];
        let (a, b) = (Face::bake(spec(), &s), Face::bake(spec(), &s));
        assert_eq!(a.shade().iter().map(|&c| pack(c)).collect::<Vec<_>>(), b.shade().iter().map(|&c| pack(c)).collect::<Vec<_>>());
    }

    #[test]
    fn rain_runs_down_and_soot_rises() {
        let rain = Face::bake(spec(), &[Stroke { effect: Effect::Rain, u: 2.0, v: 2.6, r: 0.35 }]);
        let below = col_mean(&rain.wet, &rain, 0.8, 2.0, 1.6, 2.4);
        let above = col_mean(&rain.wet, &rain, 3.0, 3.2, 1.6, 2.4);
        assert!(below > 0.1 && below > 4.0 * above, "rain streaks run DOWN: below {below} above {above}");
        let soot = Face::bake(spec(), &[Stroke { effect: Effect::Soot, u: 2.0, v: 0.6, r: 0.35 }]);
        let up = col_mean(&soot.soot, &soot, 1.2, 2.4, 1.6, 2.4);
        let down = col_mean(&soot.soot, &soot, 0.0, 0.15, 0.0, 1.0);
        assert!(up > 0.2 && up > 4.0 * down, "soot RISES: up {up} down {down}");
    }

    #[test]
    fn a_spall_is_a_bounded_crater_that_shows_steel_and_bleeds_rust() {
        let f = Face::bake(spec(), &[Stroke { effect: Effect::Spall, u: 2.0, v: 1.5, r: 0.45 }]);
        assert!(f.loss_at(2.0, 1.5) > COVER, "the centre cuts past the mat: {}", f.loss_at(2.0, 1.5));
        assert!(f.loss.iter().all(|&l| l <= LOSS_MAX), "never deeper than the cap");
        assert_eq!(f.loss_at(0.2, 0.2), 0.0, "far away is untouched");
        let below = |k: usize| {
            let (i, j) = (k % f.w, k / f.w);
            let (u, v) = ((i as f32 + 0.5) / f.spec.tx_u, (j as f32 + 0.5) / f.spec.tx_v);
            (1.6..2.4).contains(&u) && v < 0.9 && f.rust[k] > 0.3
        };
        let runs = (0..f.rust.len()).filter(|&k| below(k)).count();
        assert!(runs > 20, "exposed steel bleeds rust runs below the crater: {runs} texels");
        assert!(f.crack.iter().any(|&c| c > 0.5), "cracks radiate from the crater");
    }

    #[test]
    fn pack_round_trips_within_one_step() {
        for &x in &[0.0f32, 0.01, 0.05, 0.2, 0.5, 1.0] {
            let back = unpack(pack([x, x, x]))[0];
            assert!((back.sqrt() - x.sqrt()).abs() <= 0.5 / 255.0 + 1e-6, "{x} -> {back}");
        }
    }
}
