//! Geometric wall aging — the crack lab's cracks as REAL geometry.
//!
//! Every knobbed pier gets BOTH layers (owner round 6, 2026-07-23: patterns
//! must read on faulted walls too — fault and craze COMPOSE now):
//!
//! STRUCTURAL FAULTS (owner, 2026-07-23: painted faults read flat): a pier
//! whose knobs produce a structural fault (same lattice the shaders paint —
//! `faultAt` in shade.comp/shade.metal, mirrored here float-for-float) is
//! SPLIT: its box prim collapses to a point and jagged pieces are appended
//! along the crack path, separated by a real gap (wider at the top —
//! settlement taper) with one side DROPPED a few cm (the shear step). The
//! pieces share the pier's material, so knobs / selection / occluder flags
//! keep working per-segment; `Material._pad` bit 5 ([`GEO_BIT`]) tells the
//! shade pass to suppress the painted fault core + bevel.
//!
//! CRAZE (owner rounds 4-7: small cracks geometric, min width 1 px, depth
//! knob = groove depth sets the lighting/vibe, selectable pattern POLICIES,
//! and each policy exposes its algorithm's NATIVE params): the wall carries
//! a matte chalk CORE under a thin glaze VENEER of real fragments. A
//! [`POLICIES`] generator (host-side only — the shade pass suppresses ALL
//! cell paint via bits 5/6, so no shader port) produces the fragment
//! layout, steered by its [`POLICY_PARAMS`] sliders; seams inside the
//! damage zone open as real grooves cut to the core, width clamped at
//! one screen px or more ([`px_floor`] — sub-pixel line geometry
//! dot-dashes, the 2026-07-23 learning), widening with depth. Darkness is
//! shadowing + AO in a DROOPED cavity (walls slant down into the wall so no
//! orientation shows a sky-lit ledge); groove edges get a ~1 px CHAMFER
//! (owner round 7: beveled edges read natural at the low-res target) that
//! eats into the plate, never the gap. Damaged fragments sink; chip-gated
//! fragments are MISSING; top-row losses notch the cap. On a faulted pier
//! the same veneer rides the pieces — fragments are clipped against the
//! fault paths (a fault IS a cut), a fault HALO boosts the damage zone so
//! the network clusters along the big seam, and the piece front/back planes
//! become the chalk core.
//!
//! Sim untouched: gaps are centimetres, nobody walks through a cracked wall.
//! Render-side only, deterministic — a pure function of pier + knobs + policy.

use crate::gym_scene::Pier;
use glam::{Vec2, Vec3};
use rt_probe::Scene;
use std::cell::Cell as StdCell;

/// `Material._pad` bit 5: this pier's fault is geometric — the shade pass
/// (CRACK LAB block, both twins) zeroes the painted core + bevel (and the
/// cell-network paint, shared with bit 6).
pub const GEO_BIT: i32 = 32;

/// `Material._pad` bit 6: this pier's small-crack network is geometric
/// (craze veneer) — the shade pass zeroes ALL the painted cell work (lines,
/// lips, line halos, chips); only the sub-pixel fine web + stains stay paint.
pub const CRAZE_BIT: i32 = 64;

/// Craze pattern policies, panel row + `CRACKS=..,policy` order. `lightning`
/// is propagation: bolts root at the top or fork off their parent crack,
/// wander with kinks and taper to a dead-end tip (it replaced the recursive
/// `fracture` splitter — owner round 7: "unbelievable shapes");
/// `craquelure` a fine axis-biased ladder (glaze crack webs — owner: the
/// near-rectangular plates could seed a unique look); `mosaic` the Worley
/// cell A/B baseline (owner: reads fake — kept to compare against).
pub const POLICIES: [&str; 3] = ["lightning", "craquelure", "mosaic"];

/// Policy count (the per-pier param store is `[[f32; PARAMS_MAX]; NPOL]`).
pub const NPOL: usize = POLICIES.len();

/// Every policy exposes its algorithm's NATIVE steering (owner round 7:
/// "if i switch algo, i want unique native properties in the options") —
/// up to [`PARAMS_MAX`] (name, default) sliders on the crack panel below
/// the pattern row. Geometry-only inputs: a drag rebuilds on release, no
/// material bits involved.
pub const PARAMS_MAX: usize = 3;
pub const POLICY_PARAMS: [&[(&str, f32)]; 3] = [
    &[("branch", 0.5), ("straight", 0.55), ("spread", 0.45)],
    &[("scale", 0.5), ("wave", 0.35)],
    &[("scale", 0.5), ("jitter", 0.8)],
];

/// A policy's default param values (unused slots 0).
pub const fn param_defaults(policy: u8) -> [f32; PARAMS_MAX] {
    let p = POLICY_PARAMS[policy as usize];
    let mut out = [0.0; PARAMS_MAX];
    let mut i = 0;
    while i < p.len() {
        out[i] = p[i].1;
        i += 1;
    }
    out
}

/// Parse a policy name (or numeric index) from the CRACKS env; unknown -> 0.
pub fn policy_index(s: &str) -> u8 {
    POLICIES
        .iter()
        .position(|p| *p == s)
        .map(|i| i as u8)
        .or_else(|| s.parse::<u8>().ok().filter(|i| (*i as usize) < POLICIES.len()))
        .unwrap_or(0)
}

/// One screen pixel in wu along a face's WORST-projected direction, for the
/// game projection (trimetric (40,10)/(-20,20): world X spans √1700 ≈ 41.2
/// px/wu, world Y S·ûy ≈ 38.7, world Z only √800 ≈ 28.3). Groove widths
/// clamp here (+5% margin) so a crack line NEVER goes sub-pixel — the
/// owner's round-5 floor. The iso21 A/B preset sits within ~5%.
fn px_floor(run_x: bool) -> f32 {
    if run_x {
        0.0271
    } else {
        0.0371
    }
}

/// `crack::SEL_BIT` as i32 (the core never carries the selection highlight).
const SEL_BIT_I: i32 = crate::crack::SEL_BIT;

// ---- float-exact mirrors of the shader helpers (shade.comp) ----------------

fn fr(x: f32) -> f32 {
    x - x.floor()
}
fn mixf(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}
fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}
fn hash13(p: Vec3) -> f32 {
    let mut p = Vec3::new(fr(p.x * 0.1031), fr(p.y * 0.1031), fr(p.z * 0.1031));
    p += Vec3::splat(p.dot(Vec3::new(p.y, p.z, p.x) + Vec3::splat(33.33)));
    fr((p.x + p.y) * p.z)
}
fn vnoise(x: Vec3) -> f32 {
    let i = x.floor();
    let f = x - i;
    let f = f * f * (Vec3::splat(3.0) - 2.0 * f);
    let h = |ox: f32, oy: f32, oz: f32| hash13(i + Vec3::new(ox, oy, oz));
    let lerp = mixf;
    let n00 = lerp(h(0., 0., 0.), h(1., 0., 0.), f.x);
    let n10 = lerp(h(0., 1., 0.), h(1., 1., 0.), f.x);
    let n01 = lerp(h(0., 0., 1.), h(1., 0., 1.), f.x);
    let n11 = lerp(h(0., 1., 1.), h(1., 1., 1.), f.x);
    lerp(lerp(n00, n10, f.y), lerp(n01, n11, f.y), f.z)
}

// ---- the fault lattice (host side) -----------------------------------------

/// One structural crack crossing a pier: the shader lattice's strip, resolved
/// to a world-space path `u(y)` on the pier's run axis.
#[derive(Clone)]
struct Fault {
    si: f32,
    seed: f32,
    shift: f32, // lattice-2 evaluates in u+2.7 space (shader: cuvP + vec2(2.7, 0))
    ax: f32,
    tilt: f32,
    /// Gap half-width base (the shader's `mw` sans its per-y `wvar`).
    mw: f32,
    /// Which side drops: +1 = the right (higher-u) piece sinks.
    sign: f32,
}

impl Fault {
    fn u(&self, y: f32) -> f32 {
        let wob = (vnoise(Vec3::new(y * 0.8, self.si * 7.3, self.seed + 17.0)) - 0.5) * 1.3
            + (vnoise(Vec3::new(y * 4.1, self.si * 7.3, self.seed + 29.0)) - 0.5) * 0.22;
        self.ax + self.tilt * y + wob - self.shift
    }
    fn wvar(&self, y: f32) -> f32 {
        0.35 + 1.3 * vnoise(Vec3::new(y * 1.7, self.si * 3.1, self.seed + 41.0))
    }
    /// Full gap width at height `y`, tapered wider toward the top (settlement)
    /// and clamped to stay visible without gaping past believability.
    fn gap(&self, y: f32, y0: f32, y1: f32) -> f32 {
        let taper = 0.7 + 0.6 * (y - y0) / (y1 - y0).max(1e-4);
        (2.0 * self.mw * self.wvar(y) * taper).clamp(0.018, 0.09)
    }
}

/// The faults crossing a pier's run range, sorted by position. Mirrors the
/// shader's presence rule exactly; lattice 2 goes geometric once its fade
/// (`g2`) reaches half.
fn pier_faults(u0: f32, u1: f32, y0: f32, y1: f32, seg: f32, k: [f32; 4]) -> Vec<Fault> {
    let (age, den, dep) = (k[0], k[1], k[2]);
    let p_maj = 0.95 * smoothstep(0.12, 0.42, age) * smoothstep(0.04, 0.45, den);
    let g2 = smoothstep(0.65, 0.95, den);
    let mut out = Vec::new();
    let lattices: &[(f32, f32, bool)] = &[(0.0, seg, true), (2.7, seg + 130.0, g2 >= 0.5)];
    for &(shift, seed, on) in lattices {
        if !on {
            continue;
        }
        let (s0, s1) = (((u0 + shift) / 6.0).floor() as i32, ((u1 + shift) / 6.0).floor() as i32);
        for si in s0..=s1 {
            let si = si as f32;
            if hash13(Vec3::new(si, seed, 71.0)) >= p_maj {
                continue;
            }
            let ax = (si + mixf(0.22, 0.78, hash13(Vec3::new(si, seed, 83.0)))) * 6.0;
            let tilt = (hash13(Vec3::new(si, seed, 97.0)) - 0.5) * 0.8;
            let mw = mixf(0.022, 0.055, dep) * (0.55 + 0.45 * age);
            let sign = if hash13(Vec3::new(si, seed, 113.0)) < 0.5 { 1.0 } else { -1.0 };
            let f = Fault { si, seed, shift, ax, tilt, mw, sign };
            // keep ANY fault whose path ENTERS the face somewhere over the
            // pier's height (a strip anchored past the end can wander in and
            // clip a corner — the shader paints exactly that): GEO_BIT
            // suppresses the whole pier's fault paint, so every painted
            // crack must turn geometric. Corner-clippers become cracked-off
            // edges (the mesh's edge clamps keep pieces >= 0.06 wu wide).
            let (mut lo, mut hi) = (f32::MAX, f32::MIN);
            for s in 0..=6 {
                let u = f.u(y0 + (y1 - y0) * s as f32 / 6.0);
                lo = lo.min(u);
                hi = hi.max(u);
            }
            if hi > u0 + 0.02 && lo < u1 - 0.02 {
                out.push(f);
            }
        }
    }
    let ymid = (y0 + y1) * 0.5;
    out.sort_by(|a, b| a.u(ymid).total_cmp(&b.u(ymid)));
    out
}

// ---- mesh building ---------------------------------------------------------

/// Push one flat quad (two tris, `add_box` index pattern) with an explicit
/// flat normal (hit normals interpolate vertex attributes, winding is free).
fn quad(verts: &mut Vec<([f32; 3], [f32; 3])>, idx: &mut Vec<u32>, q: [[f32; 3]; 4], n: [f32; 3]) {
    let vi = verts.len() as u32;
    for p in q {
        verts.push((p, n));
    }
    idx.extend_from_slice(&[vi, vi + 1, vi + 2, vi, vi + 2, vi + 3]);
}

// ---- craze configuration ---------------------------------------------------
//
// polana's porcelain story taken literally: the wall is a matte body (chalk
// CORE) under a thin glaze VENEER of fragments. A pattern POLICY lays the
// fragments out; every seam inside the damage zone opens as a real groove
// down to the core — width >= 1 px by construction, darkness from real
// shadowing/AO in a groove whose DEPTH the depth knob sets (owner round 5:
// "use the depth of cracks to set the lighting/vibe"). Fragments in the
// zone sink a hair (lit lips, shadow steps); chip-gated fragments are
// MISSING. Outside the zone seams stay CLOSED (fragments touch —
// coincident internal walls no ray reaches), so an undamaged face still
// reads as one clean slab.

/// One veneer fragment: a simple CCW polygon in face coords (u, y) + its
/// aging gates (sampled at the fragment, not per pixel — whole plates let go).
struct Frag {
    poly: Vec<Vec2>,
    /// Per-edge (poly[i] -> poly[i+1]): does this edge border an OPEN groove?
    /// Only those edges get the chamfer — a bevel along a closed seam would
    /// carve a visible V-groove into what must stay one flush slab.
    open: Vec<bool>,
    spalled: bool,
    sink: f32,
}

/// The pier's damage gates + layout parameters — mirrors the shade pass
/// fields (same fbm/seeds) so fragments craze in the SAME patches the
/// painted stains sit in.
struct CrazeCfg {
    freq: f32,
    seed: f32,     // cell lattice seed (shader: seg + 5)
    dmg_seed: f32, // damage field seed (shader: seg * 7 + 3 — NOT the cell seed)
    cover: f32,
    d_t: f32,
    chip: f32,
    age: f32,
    dep: f32,
    /// Veneer thickness = groove/recess depth. The depth knob spans the
    /// WHOLE wall: 0.02 up to 0.45 × thickness (owner round 6: "ending at
    /// 1 is too small" — a fixed 0.10 cap left the slider's top third dead
    /// on 0.25-wu walls).
    t: f32,
    /// The >= 1 px groove-width floor for this pier's face directions.
    px1: f32,
    /// Split policies: a plate only sinks when its WHOLE perimeter sits in
    /// the open zone — a sunk plate must be cracked free all round, or its
    /// closed-seam step is sub-pixel and dashes out. (Mosaic needs no gate:
    /// a live cell grooves every edge by construction.)
    sink_perimeter: bool,
    /// The active policy's native params ([`POLICY_PARAMS`] order).
    par: [f32; PARAMS_MAX],
    /// The pier's structural faults — their HALO boosts the damage zone so
    /// the small-crack network clusters along the big seam (the shader's
    /// old mHalo term, now geometric).
    halo_faults: Vec<Fault>,
}

impl CrazeCfg {
    /// Build a pier's craze config from bucketed knobs + policy params.
    fn new(seg: f32, k: [f32; 4], run_x: bool, thick: f32, faults: &[Fault], par: [f32; PARAMS_MAX]) -> CrazeCfg {
        CrazeCfg {
            freq: mixf(1.1, 3.4, k[1]),
            seed: seg + 5.0,
            dmg_seed: seg * 7.0 + 3.0,
            cover: mixf(0.45, 0.9, k[0]),
            d_t: mixf(0.74, 0.55, k[0]),
            chip: k[3],
            age: k[0],
            dep: k[2],
            t: mixf(0.02, 0.45 * thick, k[2]),
            px1: px_floor(run_x),
            sink_perimeter: true,
            par,
            halo_faults: faults.to_vec(),
        }
    }
    /// Chamfer width (in-plane strip the plate loses to the bevel) — a hair
    /// over one screen px, widening as cracks deepen (owner round 7:
    /// chamfered edges read natural and play with the low-res target).
    fn cham_w(&self) -> f32 {
        self.px1 * (0.8 + 0.7 * self.dep)
    }
    /// Chamfer depth into the wall — ~45°, capped by the veneer.
    fn cham_d(&self) -> f32 {
        self.cham_w().min(0.55 * self.t)
    }
    /// The macro damage field at face coords (u, y) — exact fbm mirror.
    fn dmg(&self, su: f32, sy: f32) -> f32 {
        let rise = 1.0 - smoothstep(0.10, 1.0, sy);
        let p = Vec3::new(su * 0.45, sy * 0.7, self.dmg_seed);
        0.65 * vnoise(p) + 0.35 * vnoise(p * 2.03 + Vec3::splat(11.1)) + 0.16 * rise
    }
    /// Fault-proximity halo (0..1) — mirrors the paint's fracture zone.
    fn halo(&self, su: f32, sy: f32) -> f32 {
        let mut h = 0.0f32;
        for f in &self.halo_faults {
            h = h.max(1.0 - smoothstep(0.10, 0.55, (su - f.u(sy)).abs()));
        }
        h
    }
    fn zone(&self, su: f32, sy: f32) -> f32 {
        let z = smoothstep(self.d_t + 0.02, self.d_t + 0.08, self.dmg(su, sy));
        z.max(0.5 * self.halo(su, sy))
    }
    fn stain_w(&self, su: f32, sy: f32) -> f32 {
        smoothstep(self.d_t - 0.14, self.d_t + 0.02, self.dmg(su, sy))
    }
    /// Groove width for a seam: the pixel floor, widening as cracks deepen.
    fn groove_w(&self, hier: f32) -> f32 {
        (self.px1 * hier * (1.0 + 0.7 * self.dep)).max(self.px1)
    }
    /// Deepest a live fragment may sink — always shy of the veneer bottom.
    fn sink_max(&self) -> f32 {
        (0.4 * self.t).min(0.025) * (0.4 + 0.6 * self.age)
    }
    /// Fragment gates at a candidate polygon: live plates sink, chip-hit
    /// plates go MISSING. `h` = the generator's per-fragment hash channel.
    fn frag(&self, poly: Vec<Vec2>, open: Vec<bool>, h: impl Fn(f32) -> f32, opened: &StdCell<bool>) -> Option<Frag> {
        if poly.len() < 3 || poly_area(&poly) < 1e-5 {
            return None;
        }
        let c = poly_centroid(&poly);
        let mut live = self.zone(c.x, c.y) > 0.35 && h(91.0) < self.cover;
        if live && self.sink_perimeter {
            live = poly.iter().all(|p| self.zone(p.x, p.y) > 0.35);
        }
        // chips cluster in the stain patches AND bite the fault's flanks
        let chp_eff = self.chip * (smoothstep(0.45, 0.85, self.stain_w(c.x, c.y)) + 0.9 * self.halo(c.x, c.y)).clamp(0.0, 1.0);
        let chp_n = vnoise(Vec3::new(c.x * 2.3 + 57.0, c.y * 2.3 + 57.0, 57.0));
        // clean-zone plates can't spall (chp_eff ≈ 0 pushes the gate past
        // vnoise's range); the area cap keeps a whole-slab fragment safe
        let spalled = chp_n > mixf(1.02, 0.50, chp_eff) + 0.08 && poly_area(&poly) < 1.0;
        let sink = if live { h(201.0) * self.sink_max() } else { 0.0 };
        if live || spalled {
            opened.set(true);
        }
        Some(Frag { poly, open, spalled, sink })
    }
}

fn poly_area(p: &[Vec2]) -> f32 {
    let mut a = 0.0;
    for i in 0..p.len() {
        a += p[i].perp_dot(p[(i + 1) % p.len()]);
    }
    a * 0.5
}
fn poly_centroid(p: &[Vec2]) -> Vec2 {
    let a = poly_area(p);
    if a.abs() < 1e-9 {
        return p.iter().copied().sum::<Vec2>() / p.len().max(1) as f32;
    }
    let mut c = Vec2::ZERO;
    for i in 0..p.len() {
        let (q, r) = (p[i], p[(i + 1) % p.len()]);
        c += (q + r) * q.perp_dot(r);
    }
    c / (6.0 * a)
}

/// Clip a polygon to `f(p) <= 0` where `f` may CURVE: edges are subdivided
/// to ~0.08 wu so crossings track the iso-line. The walk preserves
/// orientation; both sides of a CLOSED seam sample the same points, so
/// their shared boundary matches exactly. (Straight-cut clips only — the
/// boundary between crossings is a chord; wandering cuts go through
/// [`cut_clip`], which re-samples the groove wall.)
fn curved_clip(poly: &[Vec2], f: &dyn Fn(Vec2) -> f32) -> Vec<Vec2> {
    let n = poly.len();
    let mut out = Vec::with_capacity(n * 2);
    for a in 0..n {
        let (pa, pb) = (poly[a], poly[(a + 1) % n]);
        let steps = ((pb - pa).length() / 0.08).ceil().max(1.0) as usize;
        let mut pp = pa;
        let mut pf = f(pa);
        if pf <= 0.0 {
            out.push(pa);
        }
        for s in 1..=steps {
            let p = pa + (pb - pa) * (s as f32 / steps as f32);
            let fv = f(p);
            if (pf <= 0.0) != (fv <= 0.0) {
                out.push(pp + (p - pp) * (pf / (pf - fv)));
            }
            if fv <= 0.0 && s < steps {
                out.push(p);
            }
            (pp, pf) = (p, fv);
        }
    }
    simplify(&mut out);
    out
}

/// Drop duplicate + near-chord vertices (< quarter-pixel deviation): the
/// clip's subdivision points on straight runs collapse back, groove edges
/// keep their wander. Purely per-polygon — grooved sides never touch, and
/// closed seams deviate under the tolerance (coincident to a quarter px).
fn simplify(poly: &mut Vec<Vec2>) {
    const TOL: f32 = 0.004;
    let mut i = 0;
    while poly.len() > 3 && i < poly.len() {
        let n = poly.len();
        let (a, b, c) = (poly[(i + n - 1) % n], poly[i], poly[(i + 1) % n]);
        let ac = c - a;
        let d = if ac.length_squared() < 1e-12 { 0.0 } else { (b - a).perp_dot(ac).abs() / ac.length() };
        if d < TOL || (b - a).length_squared() < 1e-10 {
            poly.remove(i);
        } else {
            i += 1;
        }
    }
}

/// Ear-clip a simple CCW polygon into triangles (local indices). Falls back
/// to a fan if the numerics dead-end (degenerate slivers) — worst case a few
/// flipped hidden tris, never a hole.
fn triangulate(poly: &[Vec2]) -> Vec<[u32; 3]> {
    let n = poly.len();
    let mut v: Vec<u32> = (0..n as u32).collect();
    let mut out = Vec::with_capacity(n.saturating_sub(2));
    let inside = |p: Vec2, a: Vec2, b: Vec2, c: Vec2| {
        (b - a).perp_dot(p - a) > 1e-9 && (c - b).perp_dot(p - b) > 1e-9 && (a - c).perp_dot(p - c) > 1e-9
    };
    'clip: while v.len() > 3 {
        let m = v.len();
        for i in 0..m {
            let (ia, ib, ic) = (v[(i + m - 1) % m], v[i], v[(i + 1) % m]);
            let (a, b, c) = (poly[ia as usize], poly[ib as usize], poly[ic as usize]);
            if (b - a).perp_dot(c - b) <= 1e-9 {
                continue; // reflex or flat corner: not an ear
            }
            if v.iter().any(|&j| j != ia && j != ib && j != ic && inside(poly[j as usize], a, b, c)) {
                continue;
            }
            out.push([ia, ib, ic]);
            v.remove(i);
            continue 'clip;
        }
        break; // no ear found: fan the remainder
    }
    for i in 1..v.len().saturating_sub(1) {
        out.push([v[0], v[i], v[i + 1]]);
    }
    out
}

// ---- wandering cuts --------------------------------------------------------

/// Anything a polygon can be clipped against along a wandering path: the
/// splitter's cuts AND the structural faults (a fault IS a cut — that's how
/// veneer fragments ride the fault pieces).
trait CutLike {
    /// Tangent direction (the path parameter axis).
    fn tangent(&self) -> Vec2;
    /// Clip field for one side (`side` +1 keeps below/left of the path,
    /// -1 the other side): negative = kept, zero = this side's groove wall.
    fn field(&self, p: Vec2, side: f32) -> f32;
    /// A point ON this side's groove wall at tangent coord `t`.
    fn wall(&self, t: f32, side: f32) -> Vec2;
}

/// One wandering cut through a region: signed field `s` (negative side A),
/// groove half-width opening only inside the damage zone — the crack
/// network's topology is global (hierarchy + T-junctions) but the cracks
/// themselves live in the damaged patches, hairline tips ending crisply.
#[derive(Clone)]
struct Cut {
    n: Vec2,
    d: Vec2,
    c0: f32,
    amp: f32,
    /// Extra high-frequency wander octave — the lightning policy's jag
    /// (straightness turns it down); zero for the ladder.
    kink: f32,
    idf: f32,
    seed: f32,
    half_g: f32,
    /// Width floor (half): the >= 1 px guarantee survives the taper.
    wfloor: f32,
    /// Tangent range where the groove is OPEN — resolved ONCE per cut from
    /// the damage field: first zone crossing to last, one continuous crack.
    /// (Per-sample gating chatters across the fbm threshold and the crack
    /// dashes out mid-run; real cracks connect their damaged ends.)
    span: Option<(f32, f32)>,
    /// Lightning propagation: (root t, tip t) — full width at the root
    /// (where the bolt entered or forked), tapering toward the dead-end
    /// tip. None = uniform width (the ladder).
    taper: Option<(f32, f32)>,
}

impl Cut {
    fn wander(&self, t: f32) -> f32 {
        ((vnoise(Vec3::new(t * 1.3, self.idf * 5.7, self.seed + 71.0)) - 0.5) * 1.6
            + (vnoise(Vec3::new(t * 5.3, self.idf * 5.7, self.seed + 87.0)) - 0.5) * 0.35)
            * self.amp
            + (vnoise(Vec3::new(t * 3.7, self.idf * 5.7, self.seed + 53.0)) - 0.5) * self.kink
    }
    /// Resolve the open span over the region's tangent range: the damage
    /// zone sampled along the CENTERLINE (both sides agree exactly).
    fn resolve_span(&mut self, cfg: &CrazeCfg, t0: f32, t1: f32, opened: &StdCell<bool>) {
        let steps = (((t1 - t0) / 0.1).ceil().max(1.0)) as usize;
        let (mut lo, mut hi) = (f32::MAX, f32::MIN);
        for s in 0..=steps {
            let t = mixf(t0, t1, s as f32 / steps as f32);
            let c = self.d * t + self.n * (self.c0 + self.wander(t));
            if cfg.zone(c.x, c.y) > 0.35 {
                lo = lo.min(t);
                hi = hi.max(t);
            }
        }
        self.span = (lo <= hi).then(|| {
            opened.set(true);
            (lo - 0.05, hi + 0.05)
        });
    }
    /// Groove half-width at tangent coord `t` — tapered root→tip for
    /// lightning bolts, never below the pixel floor while open.
    fn gate(&self, t: f32) -> f32 {
        match self.span {
            Some((a, b)) if t >= a && t <= b => match self.taper {
                Some((root, tip)) if (tip - root).abs() > 1e-4 => {
                    let u = ((t - root) / (tip - root)).clamp(0.0, 1.0);
                    (self.half_g * mixf(1.0, 0.30, u * u)).max(self.wfloor)
                }
                _ => self.half_g,
            },
            _ => 0.0,
        }
    }
}

impl CutLike for Cut {
    fn tangent(&self) -> Vec2 {
        self.d
    }
    fn field(&self, p: Vec2, side: f32) -> f32 {
        let t = p.dot(self.d);
        side * (p.dot(self.n) - self.c0 - self.wander(t)) + self.gate(t)
    }
    fn wall(&self, t: f32, side: f32) -> Vec2 {
        self.d * t + self.n * (self.c0 + self.wander(t) - side * self.gate(t))
    }
}

/// A structural fault seen as a cut in face coords: path `u = f.u(y)`,
/// always open at the full (tapered) gap width. Side +1 keeps the lower-u
/// piece.
struct FaultCut<'a> {
    f: &'a Fault,
    y0: f32,
    y1: f32,
}

impl CutLike for FaultCut<'_> {
    fn tangent(&self) -> Vec2 {
        Vec2::Y
    }
    fn field(&self, p: Vec2, side: f32) -> f32 {
        side * (p.x - self.f.u(p.y)) + self.f.gap(p.y, self.y0, self.y1) * 0.5
    }
    fn wall(&self, t: f32, side: f32) -> Vec2 {
        Vec2::new(self.f.u(t) - side * self.f.gap(t, self.y0, self.y1) * 0.5, t)
    }
}

/// Clip a region polygon to one side of a wandering cut. A plain polygon
/// walk only yields crossing points on the REGION's edges — the boundary
/// between an exit and the next entry would be a straight chord and the
/// cut's wander (the whole crack character) would vanish. So adjacent
/// crossing pairs get the groove wall re-sampled between them.
fn cut_clip(poly: &[Vec2], cut: &dyn CutLike, side: f32) -> Vec<Vec2> {
    let f = |p: Vec2| cut.field(p, side);
    let n = poly.len();
    let mut walk: Vec<(Vec2, bool)> = Vec::with_capacity(n * 2);
    for a in 0..n {
        let (pa, pb) = (poly[a], poly[(a + 1) % n]);
        let steps = ((pb - pa).length() / 0.08).ceil().max(1.0) as usize;
        let mut pp = pa;
        let mut pf = f(pa);
        if pf <= 0.0 {
            walk.push((pa, false));
        }
        for s in 1..=steps {
            let p = pa + (pb - pa) * (s as f32 / steps as f32);
            let fv = f(p);
            if (pf <= 0.0) != (fv <= 0.0) {
                walk.push((pp + (p - pp) * (pf / (pf - fv)), true));
            }
            if fv <= 0.0 && s < steps {
                walk.push((p, false));
            }
            (pp, pf) = (p, fv);
        }
    }
    let d = cut.tangent();
    let m = walk.len();
    let mut out = Vec::with_capacity(m * 2);
    for i in 0..m {
        let (p, px) = walk[i];
        out.push(p);
        let (q, qx) = walk[(i + 1) % m];
        if px && qx {
            // exit → entry: the dropped span runs along the cut — trace the wall
            let (t0, t1) = (p.dot(d), q.dot(d));
            let steps = ((t1 - t0).abs() / 0.06).ceil() as usize;
            for s in 1..steps {
                out.push(cut.wall(mixf(t0, t1, s as f32 / steps as f32), side));
            }
        }
    }
    simplify(&mut out);
    out
}

// ---- fragment generators (the pattern policies) ----------------------------

/// The recursive split policies (lightning / craquelure): carve the face
/// rect into fragments by wandering cuts. LIGHTNING is propagation dressed
/// as recursion: a near-vertical primary bolt roots at the top of the
/// damage span and runs a budgeted length (tapering to a dead-end tip);
/// each sub-region may then fork ONE child off the parent bolt — rooted at
/// the end nearest the parent's path, angled by `spread`, gated by
/// `branch`, jag set by `straight`. CRAQUELURE stays near-axis, finer and
/// uniform — the glaze-web ladder (`scale` sizes the plates, `wave` bends
/// the lines). Regions with no damage (and no fault halo) anywhere stop
/// splitting early (one flush plate, no wasted tris).
enum SplitMode {
    Bolt,
    Ladder,
}

struct Splitter<'a> {
    cfg: &'a CrazeCfg,
    mode: SplitMode,
    opened: &'a StdCell<bool>,
    /// Ancestor cuts + which side kept this branch — the leaf polygons'
    /// edges are probed against these to learn which edges border an OPEN
    /// groove (chamfer eligibility).
    stack: Vec<(Cut, f32)>,
    out: Vec<Frag>,
}

impl Splitter<'_> {
    fn h(&self, id: u32, k: f32) -> f32 {
        hash13(Vec3::new(id as f32 * 0.618, self.cfg.seed + k, 9.1))
    }

    /// Which leaf-polygon edges lie on an ancestor cut's OPEN groove wall.
    /// (field = 0 exactly on the kept side's wall; gate > 0 = the groove is
    /// open there. Closed seams have gate 0 and stay unmarked — flush.)
    fn edge_flags(&self, poly: &[Vec2]) -> Vec<bool> {
        (0..poly.len())
            .map(|i| {
                let m = (poly[i] + poly[(i + 1) % poly.len()]) * 0.5;
                self.stack.iter().any(|(cut, side)| {
                    cut.field(m, *side).abs() < 0.008 && cut.gate(m.dot(cut.d)) > 0.0
                })
            })
            .collect()
    }

    fn emit(&mut self, poly: Vec<Vec2>, id: u32) {
        let hh = |k: f32| self.h(id, k);
        let open = self.edge_flags(&poly);
        if let Some(f) = self.cfg.frag(poly, open, hh, self.opened) {
            self.out.push(f);
        }
    }

    fn rec(&mut self, poly: Vec<Vec2>, id: u32, depth: u32, pdir: Vec2) {
        if poly.len() < 3 {
            return;
        }
        let (branch, straight, spread) = (self.cfg.par[0], self.cfg.par[1], self.cfg.par[2]);
        let ladder = matches!(self.mode, SplitMode::Ladder);
        let (mut lo, mut hi) = (poly[0], poly[0]);
        for p in &poly {
            lo = lo.min(*p);
            hi = hi.max(*p);
        }
        // no damage anywhere near this region: it stays one flush plate
        let (mut dmax, mut hmax) = (f32::MIN, 0.0f32);
        for gy in 0..4 {
            for gx in 0..4 {
                let q = lo + (hi - lo) * Vec2::new(gx as f32 / 3.0, gy as f32 / 3.0);
                dmax = dmax.max(self.cfg.dmg(q.x, q.y));
                hmax = hmax.max(self.cfg.halo(q.x, q.y));
            }
        }
        if (dmax < self.cfg.d_t && hmax < 0.2) || depth >= 14 {
            self.emit(poly, id);
            return;
        }
        // lightning: branching is the owner's dial — a pruned region stays whole
        if !ladder && depth >= 1 && self.h(id, 31.0) >= mixf(0.30, 0.97, branch) {
            self.emit(poly, id);
            return;
        }
        let min_ext = if ladder {
            ((1.3 / self.cfg.freq) * mixf(0.55, 2.2, self.cfg.par[0])).max(0.14)
        } else {
            (1.5 / self.cfg.freq).max(0.18)
        };
        // cut orientation: bolts run near-vertical (settlement) at the root
        // and FORK off their parent's direction by the spread angle;
        // craquelure hugs the axes and splits its longer side
        let d = if ladder {
            let vert = hi.x - lo.x >= hi.y - lo.y;
            let base = if vert { Vec2::X } else { Vec2::Y };
            let ang = (self.h(id, 3.0) - 0.5) * mixf(0.02, 0.45, self.cfg.par[1]);
            let (sa, ca) = ang.sin_cos();
            Vec2::new(ca * base.x - sa * base.y, sa * base.x + ca * base.y).perp()
        } else if depth == 0 {
            let tilt = (self.h(id, 3.0) - 0.5) * 0.6;
            Vec2::new(tilt.sin(), -tilt.cos())
        } else {
            let fork = mixf(0.25, 1.15, spread) * (0.7 + 0.6 * self.h(id, 37.0));
            let sgn = if self.h(id, 41.0) < 0.5 { 1.0 } else { -1.0 };
            let (sa, ca) = (sgn * fork).sin_cos();
            Vec2::new(ca * pdir.x - sa * pdir.y, sa * pdir.x + ca * pdir.y)
        };
        let n = d.perp();
        let (mut s0, mut s1) = (f32::MAX, f32::MIN);
        for p in &poly {
            let s = p.dot(n);
            s0 = s0.min(s);
            s1 = s1.max(s);
        }
        let ext = s1 - s0;
        if ext < 2.0 * min_ext {
            self.emit(poly, id);
            return;
        }
        let span = if ladder { (0.42, 0.58) } else { (0.32, 0.68) };
        let c0 = mixf(s0 + ext * span.0, s0 + ext * span.1, self.h(id, 11.0));
        // straightness turns the bolt's wander AND its jag down together
        let (amp, kink) = if ladder {
            (mixf(0.003, 0.045, self.cfg.par[1]), 0.0)
        } else {
            ((mixf(0.30, 0.05, straight) * ext).min(0.12), (mixf(0.14, 0.015, straight) * ext).min(0.05))
        };
        // width hierarchy: the primary bolt is the trunk, forks thin out;
        // craquelure is uniformly hairline; everything widens with depth
        let hier = if ladder { 1.0 } else { (2.6 * 0.62f32.powi(depth as i32)).max(1.0) };
        let g = self.cfg.groove_w(hier * (1.0 + 0.4 * (self.h(id, 19.0) - 0.5)));
        let mut cut = Cut {
            n,
            d,
            c0,
            amp,
            kink,
            idf: id as f32,
            seed: self.cfg.seed,
            half_g: g * 0.5,
            wfloor: self.cfg.px1 * 0.5,
            span: None,
            taper: None,
        };
        let (mut td0, mut td1) = (f32::MAX, f32::MIN);
        for p in &poly {
            let t = p.dot(d);
            td0 = td0.min(t);
            td1 = td1.max(t);
        }
        cut.resolve_span(self.cfg, td0, td1, self.opened);
        // propagation: the bolt ROOTS at one end of its damage span — the
        // top for primaries (settlement enters from above), the end nearest
        // the parent's crack for forks — runs a budgeted length and dies in
        // a tapered dead-end tip instead of always crossing the region
        if !ladder {
            if let Some((zlo, zhi)) = cut.span {
                let cpt = |t: f32| cut.d * t + cut.n * (cut.c0 + cut.wander(t));
                let (plo, phi) = (cpt(zlo), cpt(zhi));
                let root_hi = if depth == 0 {
                    let bias = if phi.y > plo.y { 0.8 } else { 0.2 };
                    self.h(id, 29.0) < bias
                } else if let Some((pc, ps)) = self.stack.last() {
                    pc.field(phi, *ps).abs() < pc.field(plo, *ps).abs()
                } else {
                    self.h(id, 29.0) < 0.5
                };
                let len = mixf(0.45, 1.05, self.h(id, 23.0)) * (td1 - td0);
                let (a, b) = if root_hi { ((zhi - len).max(zlo), zhi) } else { (zlo, (zlo + len).min(zhi)) };
                cut.span = Some((a, b));
                cut.taper = Some(if root_hi { (b, a) } else { (a, b) });
            }
        }
        let a = cut_clip(&poly, &cut, 1.0);
        let b = cut_clip(&poly, &cut, -1.0);
        // a cut that missed (degenerate side) ends the recursion cleanly
        if a.len() < 3 || b.len() < 3 || poly_area(&a) < 1e-3 || poly_area(&b) < 1e-3 {
            self.emit(poly, id);
            return;
        }
        self.stack.push((cut, 1.0));
        self.rec(a, id * 2 + 1, depth + 1, d);
        self.stack.last_mut().unwrap().1 = -1.0;
        self.rec(b, id * 2 + 2, depth + 1, d);
        self.stack.pop();
    }
}

/// Shader `crackSite` mirror (the mosaic policy's cell lattice).
fn crack_site(c: Vec2, seed: f32) -> Vec2 {
    Vec2::new(hash13(Vec3::new(c.x, c.y, seed)), hash13(Vec3::new(c.x, c.y, seed + 47.0)))
}

/// Mosaic native params: `scale` sizes the cells (a frequency multiplier),
/// `jitter` scatters the sites — low jitter tends toward a grid.
fn mosaic_freq(cfg: &CrazeCfg) -> f32 {
    cfg.freq * mixf(1.7, 0.55, cfg.par[0])
}
fn mosaic_site(cfg: &CrazeCfg, ij: Vec2) -> Vec2 {
    ij + Vec2::splat(0.5) + (crack_site(ij, cfg.seed) - Vec2::splat(0.5)) * mixf(0.25, 1.0, cfg.par[1])
}

/// Is the mosaic cell at lattice coords `ij` in the damage zone (its plate
/// lets go)? Shared by the cell itself and its neighbors' groove test.
fn cell_live(cfg: &CrazeCfg, ij: Vec2) -> bool {
    let site = mosaic_site(cfg, ij);
    let f = mosaic_freq(cfg);
    let (su, sy) = (site.x / f, site.y / f);
    let cell_h = hash13(Vec3::new(ij.x, ij.y, cfg.seed + 91.0));
    cell_h < cfg.cover && cfg.zone(su, sy) > 0.35
}

/// The mosaic policy: Worley cells (the shader's old painted lattice), each
/// cell clipped by its neighbor bisectors — edges where either side is live
/// pull in by half a groove, so the crack opens between live plates.
fn mosaic_frags(cfg: &CrazeCfg, u0: f32, u1: f32, y0: f32, y1: f32, opened: &StdCell<bool>) -> Vec<Frag> {
    let f = mosaic_freq(cfg);
    let rect = [u0 * f, y0 * f, u1 * f, y1 * f];
    let (i0, i1) = ((u0 * f).floor() as i32 - 1, (u1 * f).floor() as i32 + 1);
    let (j0, j1) = ((y0 * f).floor() as i32 - 1, (y1 * f).floor() as i32 + 1);
    let mut out = Vec::new();
    for j in j0..=j1 {
        for i in i0..=i1 {
            let ij = Vec2::new(i as f32, j as f32);
            let site = mosaic_site(cfg, ij);
            let live = cell_live(cfg, ij);
            let mut poly = vec![
                Vec2::new(rect[0], rect[1]),
                Vec2::new(rect[2], rect[1]),
                Vec2::new(rect[2], rect[3]),
                Vec2::new(rect[0], rect[3]),
            ];
            // the bisectors that shaped this cell, for the edge-open probe
            // (world coords): midpoint offset, normal, grooved?
            let mut cuts: Vec<(Vec2, Vec2, bool)> = Vec::new();
            for dj in -2..=2 {
                for di in -2..=2 {
                    if di == 0 && dj == 0 {
                        continue;
                    }
                    let nij = ij + Vec2::new(di as f32, dj as f32);
                    let nsite = mosaic_site(cfg, nij);
                    let nrm = (nsite - site).normalize_or_zero();
                    let mut mid = (site + nsite) * 0.5;
                    let grooved = live || cell_live(cfg, nij);
                    if grooved {
                        // open a groove on this edge (>= the pixel floor;
                        // width seeded symmetrically so both sides agree)
                        opened.set(true);
                        let m2 = (site + nsite) * 0.5;
                        let gv = hash13(Vec3::new(m2.x, m2.y, cfg.seed + 163.0));
                        mid -= nrm * (cfg.groove_w(1.0 + 0.9 * gv) * 0.5 * f);
                    }
                    cuts.push((mid / f, nrm, grooved));
                    poly = curved_clip(&poly, &|p| (p - mid).dot(nrm));
                    if poly.len() < 3 {
                        break;
                    }
                }
            }
            let hh = |k: f32| hash13(Vec3::new(ij.x, ij.y, cfg.seed + k));
            let world: Vec<Vec2> = poly.iter().map(|p| *p / f).collect();
            let open: Vec<bool> = (0..world.len())
                .map(|a| {
                    let m = (world[a] + world[(a + 1) % world.len()]) * 0.5;
                    cuts.iter().any(|(mid, nrm, g)| *g && (m - *mid).dot(*nrm).abs() < 0.008)
                })
                .collect();
            if let Some(fr) = cfg.frag(world, open, hh, opened) {
                out.push(fr);
            }
        }
    }
    out
}

/// The policy dispatch: the pier face's fragment layout in face coords.
fn policy_frags(cfg: &CrazeCfg, policy: u8, u0: f32, u1: f32, y0: f32, y1: f32, opened: &StdCell<bool>) -> Vec<Frag> {
    match policy {
        2 => mosaic_frags(cfg, u0, u1, y0, y1, opened),
        p => {
            let root = vec![Vec2::new(u0, y0), Vec2::new(u1, y0), Vec2::new(u1, y1), Vec2::new(u0, y1)];
            let mode = if p == 1 { SplitMode::Ladder } else { SplitMode::Bolt };
            let mut sp = Splitter { cfg, mode, opened, stack: Vec::new(), out: Vec::new() };
            sp.rec(root, 0, 0, Vec2::NEG_Y);
            sp.out
        }
    }
}

// ---- emission --------------------------------------------------------------

/// Append one face's veneer fragments to the mesh buffers. Side walls
/// extrude DROOPED (slanted down into the wall): a near-horizontal crack
/// would otherwise show the lower fragment's up-facing ledge — sky-lit, so
/// the crack dashes out; drooped, the cavity is a down-facing overhang over
/// the shadowed core and reads dark at every orientation (chips gain a real
/// undercut). Edges bordering an OPEN groove get a CHAMFER (owner round 7):
/// the plate front insets by ~1 px (miter ring) and a bevel band slopes
/// down into the wall — the groove keeps its full width (the bevel eats the
/// plate, never the gap) and edge highlights read at the low-res target.
/// `w`/`wn` map face coords to world, `y_floor` pins everything inside the
/// pier box (scene bounds and the probe grid must not move).
#[allow(clippy::too_many_arguments)]
fn emit_frags(
    verts: &mut Vec<([f32; 3], [f32; 3])>,
    idx: &mut Vec<u32>,
    frags: &[Frag],
    t_face: f32,
    nz: f32,
    cfg: &CrazeCfg,
    w: &dyn Fn(f32, f32, f32) -> [f32; 3],
    wn: &dyn Fn(f32, f32, f32) -> [f32; 3],
    y_floor: f32,
) {
    let droop = 0.8 * cfg.t;
    let cw = cfg.cham_w();
    let cd = cfg.cham_d();
    for frag in frags {
        if frag.spalled {
            continue;
        }
        let np = frag.poly.len();
        let front = t_face - nz * frag.sink;
        let back = t_face - nz * cfg.t;
        // chamfer taper per vertex: full only BETWEEN two open groove edges,
        // zero at run ends — the bevel fades out where a groove meets a
        // closed seam, so no gussets and no cracks in the skin
        let mut tv = vec![0.0f32; np];
        if poly_area(&frag.poly) > 30.0 * cw * cw {
            for (i, t) in tv.iter_mut().enumerate() {
                if frag.open[(i + np - 1) % np] && frag.open[i] {
                    *t = 1.0;
                }
            }
        }
        // miter-inset ring at face level: the strip the plate cedes to the
        // bevel (clamped to the plate's bbox — a reflex corner's miter can
        // point outward, and nothing may leave the pier box)
        let (mut blo, mut bhi) = (frag.poly[0], frag.poly[0]);
        for p in &frag.poly {
            blo = blo.min(*p);
            bhi = bhi.max(*p);
        }
        let mut inset: Vec<Vec2> = (0..np)
            .map(|i| {
                if tv[i] == 0.0 {
                    return frag.poly[i];
                }
                let (a, b, c) = (frag.poly[(i + np - 1) % np], frag.poly[i], frag.poly[(i + 1) % np]);
                let n0 = (b - a).normalize_or_zero().perp();
                let n1 = (c - b).normalize_or_zero().perp();
                let m = (n0 + n1).normalize_or_zero();
                (b + m * (cw / m.dot(n1).max(0.35)).min(3.0 * cw)).clamp(blo, bhi)
            })
            .collect();
        // a folded ring means the plate was too tight for the bevel: stay sharp
        if poly_area(&inset) < 0.5 * poly_area(&frag.poly) {
            inset = frag.poly.clone();
            tv.iter_mut().for_each(|t| *t = 0.0);
        }
        let base = verts.len() as u32;
        for p in &inset {
            verts.push((w(p.x, p.y, front), wn(0.0, 0.0, nz)));
        }
        for tri in triangulate(&inset) {
            idx.extend_from_slice(&[base + tri[0], base + tri[1], base + tri[2]]);
        }
        for a in 0..np {
            let b = (a + 1) % np;
            let (pa, pb) = (frag.poly[a], frag.poly[b]);
            let e = (pb - pa).normalize_or_zero();
            // outward in-face normal of edge a->b for a CCW polygon
            let quad_n = wn(e.y, -e.x, 0.0);
            // the wall top follows the chamfer bottom (pushed into the wall)
            let (fa, fb) = (front - nz * cd * tv[a], front - nz * cd * tv[b]);
            let vi = verts.len() as u32;
            verts.push((w(pa.x, pa.y, fa), quad_n));
            verts.push((w(pb.x, pb.y, fb), quad_n));
            verts.push((w(pb.x, (pb.y - droop).max(y_floor), back), quad_n));
            verts.push((w(pa.x, (pa.y - droop).max(y_floor), back), quad_n));
            idx.extend_from_slice(&[vi, vi + 1, vi + 2, vi, vi + 2, vi + 3]);
            if frag.open[a] && tv[a] + tv[b] > 0.0 {
                let cn = wn(e.y * 0.707, -e.x * 0.707, nz * 0.707);
                let vi = verts.len() as u32;
                verts.push((w(pa.x, pa.y, fa), cn));
                verts.push((w(pb.x, pb.y, fb), cn));
                verts.push((w(inset[b].x, inset[b].y, front), cn));
                verts.push((w(inset[a].x, inset[a].y, front), cn));
                idx.extend_from_slice(&[vi, vi + 1, vi + 2, vi, vi + 2, vi + 3]);
            }
        }
    }
}

/// Mint the pier's matte chalk core material (near-porcelain: groove
/// floors and recesses read as the wall's body, a whisper off the glaze —
/// never a dark painted band). Carries the pier's knob bits + GEO/CRAZE (stains and
/// the fine web keep painting inside grooves and recesses) but never SEL.
/// Live knob drags leave this snapshot stale until the release rebuild —
/// sub-bucket drift, imperceptible.
fn chalk_material(scene: &mut Scene, mid: i32) -> i32 {
    let body = scene.materials[mid as usize];
    let mut core = body;
    core.base_color = [body.base_color[0] * 0.97, body.base_color[1] * 0.96, body.base_color[2] * 0.94, body.base_color[3]];
    core.roughness = 1.0;
    core._pad = (body._pad & !SEL_BIT_I) | 4 | GEO_BIT | CRAZE_BIT;
    scene.materials.push(core);
    scene.materials.len() as i32 - 1
}

/// Collapse the pier's original box prim (degenerate tris never hit).
fn collapse_box(scene: &mut Scene, pier: &Pier) {
    let pr = scene.primitives[pier.prim];
    let c = ((pier.lo + pier.hi) * 0.5).to_array();
    for v in &mut scene.vertices[pr.vertex_offset as usize..(pr.vertex_offset + pr.vertex_count) as usize] {
        v.pos = c;
    }
}

/// The pier's face frame: run axis mapping + face rect.
struct Frame {
    run_x: bool,
    u0: f32,
    u1: f32,
    t0: f32,
    t1: f32,
    y0: f32,
    y1: f32,
}

impl Frame {
    fn of(pier: &Pier) -> Frame {
        let run_x = (pier.hi.x - pier.lo.x) >= (pier.hi.z - pier.lo.z);
        let (u0, u1, t0, t1) = if run_x {
            (pier.lo.x, pier.hi.x, pier.lo.z, pier.hi.z)
        } else {
            (pier.lo.z, pier.hi.z, pier.lo.x, pier.hi.x)
        };
        Frame { run_x, u0, u1, t0, t1, y0: pier.lo.y, y1: pier.hi.y }
    }
    fn w(&self) -> impl Fn(f32, f32, f32) -> [f32; 3] + '_ {
        move |u, y, t| if self.run_x { [u, y, t] } else { [t, y, u] }
    }
    fn wn(&self) -> impl Fn(f32, f32, f32) -> [f32; 3] + '_ {
        move |nu, ny, nt| if self.run_x { [nu, ny, nt] } else { [nt, ny, nu] }
    }
}

// ---- the two pier treatments -----------------------------------------------

/// Point-to-segment distance (the fault-clip flag inheritance probe).
fn seg_dist(p: Vec2, a: Vec2, b: Vec2) -> f32 {
    let ab = b - a;
    let t = if ab.length_squared() < 1e-12 { 0.0 } else { ((p - a).dot(ab) / ab.length_squared()).clamp(0.0, 1.0) };
    (p - (a + ab * t)).length()
}

/// Edge-open flags for a veneer fragment RE-CLIPPED against the fault paths:
/// edges on a fault wall are open (the gap is real), surviving stretches of
/// the original perimeter inherit their old flag (their midpoints still lie
/// on the original edges).
fn fault_clip_flags(new_poly: &[Vec2], old: &Frag, fcs: &[(&FaultCut, f32)]) -> Vec<bool> {
    let np = new_poly.len();
    let no = old.poly.len();
    (0..np)
        .map(|i| {
            let m = (new_poly[i] + new_poly[(i + 1) % np]) * 0.5;
            if fcs.iter().any(|(fc, side)| fc.field(m, *side).abs() < 0.008) {
                return true;
            }
            (0..no)
                .filter(|&a| seg_dist(m, old.poly[a], old.poly[(a + 1) % no]) < 0.008)
                .map(|a| old.open[a])
                .next()
                .unwrap_or(false)
        })
        .collect()
}

/// Fragment an UNFAULTED pier into core box + veneer per the policy.
/// Returns false (scene untouched) when nothing opened — no groove, no live
/// or spalled plate: the pier keeps its box and its paint.
fn craze_pier(scene: &mut Scene, pier: &Pier, k: [f32; 4], policy: u8, par: [f32; PARAMS_MAX]) -> bool {
    let (mid, seg) = seg_of(scene, pier);
    let fr = Frame::of(pier);
    let cfg = CrazeCfg::new(seg, k, fr.run_x, fr.t1 - fr.t0, &[], par);
    let opened = StdCell::new(false);
    let frags = policy_frags(&cfg, policy, fr.u0, fr.u1, fr.y0, fr.y1, &opened);
    if !opened.get() {
        return false;
    }
    // the matte body: big faces pulled in by the veneer, ends/top/bottom flush
    let (blo, bhi) = if fr.run_x {
        (Vec3::new(pier.lo.x, fr.y0, fr.t0 + cfg.t), Vec3::new(pier.hi.x, fr.y1, fr.t1 - cfg.t))
    } else {
        (Vec3::new(fr.t0 + cfg.t, fr.y0, pier.lo.z), Vec3::new(fr.t1 - cfg.t, fr.y1, pier.hi.z))
    };
    // add_box_world mints the core its own material; restamp it as the chalk
    let body = scene.materials[mid as usize];
    let core_color = [body.base_color[0] * 0.97, body.base_color[1] * 0.96, body.base_color[2] * 0.94, body.base_color[3]];
    scene.add_box_world(blo, bhi, core_color, [0.0; 4], 1.0, 0.0);
    let core_mid = scene.primitives.last().unwrap().material_id as usize;
    scene.materials[core_mid]._pad = (body._pad & !SEL_BIT_I) | 4 | GEO_BIT | CRAZE_BIT;
    // veneer fragments, both big faces — ONE prim sharing the pier material
    let mut verts = Vec::new();
    let mut idx = Vec::new();
    for (t_face, nz) in [(fr.t1, 1.0f32), (fr.t0, -1.0f32)] {
        emit_frags(&mut verts, &mut idx, &frags, t_face, nz, &cfg, &fr.w(), &fr.wn(), fr.y0);
    }
    scene.add_mesh_world(&verts, &idx, mid);
    collapse_box(scene, pier);
    scene.materials[mid as usize]._pad |= CRAZE_BIT;
    true
}

/// Split a FAULTED pier along its faults AND craze the pieces: per piece a
/// full-thickness shell (fault walls + caps, pier material), inset front/
/// back planes (the chalk core showing in grooves and recesses), and the
/// policy veneer clipped against the fault paths — so the small-crack
/// pattern rides the broken wall and clusters along the seam (halo).
fn split_pier(scene: &mut Scene, pier: &Pier, faults: &[Fault], k: [f32; 4], policy: u8, par: [f32; PARAMS_MAX]) {
    let (mid, seg) = seg_of(scene, pier);
    let fr = Frame::of(pier);
    let (u0, u1, t0, t1, y0, y1) = (fr.u0, fr.u1, fr.t0, fr.t1, fr.y0, fr.y1);
    let w = fr.w();
    let wn = fr.wn();

    let cfg = CrazeCfg::new(seg, bucket(k), fr.run_x, t1 - t0, faults, par);
    let opened = StdCell::new(false);
    let all_frags = policy_frags(&cfg, policy, u0, u1, y0, y1, &opened);
    // the veneer inset only happens when the craze layer has anything to
    // show — a pristine-but-faulted wall stays full-thickness slabs
    let crazing = opened.get();
    let inset = if crazing { cfg.t } else { 0.0 };
    let core_mid = if crazing { chalk_material(scene, mid) } else { mid };

    // shear steps: each fault drops one side a few cm; cumulative left→right,
    // then shifted so nothing rises above the authored top
    let step = 0.015 + 0.035 * k[0];
    let n = faults.len();
    let mut drop = vec![0.0f32; n + 1];
    for j in 0..n {
        drop[j + 1] = drop[j] + step * faults[j].sign;
    }
    let top = drop.iter().fold(f32::MIN, |a, &b| a.max(b));
    for d in &mut drop {
        *d -= top;
    }

    let bands = (((y1 - y0) / 0.12).ceil() as usize).clamp(3, 12);
    // three meshes for the whole pier: the structural shells (pier mat), the
    // inset front/back planes (chalk), the veneer fragments (pier mat)
    let mut sv = Vec::new();
    let mut si = Vec::new();
    let mut cv = Vec::new();
    let mut ci = Vec::new();
    let mut vv = Vec::new();
    let mut vi = Vec::new();
    for j in 0..=n {
        // sampled edges: left/right u per band level, y dropped (bottom level
        // pinned at y0 — the buried part is invisible and keeps scene bounds,
        // and thus the probe grid, exactly where they were)
        let mut ls = Vec::with_capacity(bands + 1);
        let mut rs = Vec::with_capacity(bands + 1);
        let mut ys = Vec::with_capacity(bands + 1);
        for b in 0..=bands {
            let y = y0 + (y1 - y0) * b as f32 / bands as f32;
            let l = if j == 0 { u0 } else { faults[j - 1].u(y) + faults[j - 1].gap(y, y0, y1) * 0.5 };
            let r = if j == n { u1 } else { faults[j].u(y) - faults[j].gap(y, y0, y1) * 0.5 };
            let l = l.clamp(u0, u1 - 0.06);
            ls.push(l);
            rs.push(r.clamp(l + 0.06, u1));
            ys.push(if b == 0 { y0 } else { y + drop[j] });
        }
        let (ff, fb) = (t1 - inset, t0 + inset); // front/back planes (inset when crazing)
        for b in 0..bands {
            let (la, lb, ra, rb, ya, yb) = (ls[b], ls[b + 1], rs[b], rs[b + 1], ys[b], ys[b + 1]);
            {
                let (pv, pi) = if crazing { (&mut cv, &mut ci) } else { (&mut sv, &mut si) };
                quad(pv, pi, [w(la, ya, ff), w(ra, ya, ff), w(rb, yb, ff), w(lb, yb, ff)], wn(0.0, 0.0, 1.0));
                quad(pv, pi, [w(ra, ya, fb), w(la, ya, fb), w(lb, yb, fb), w(rb, yb, fb)], wn(0.0, 0.0, -1.0));
            }
            // side faces: flat per band, normal perpendicular to the band edge
            let el = glam::Vec2::new(lb - la, yb - ya).normalize_or_zero();
            quad(&mut sv, &mut si, [w(la, ya, t0), w(la, ya, t1), w(lb, yb, t1), w(lb, yb, t0)], wn(-el.y, el.x, 0.0));
            let er = glam::Vec2::new(rb - ra, yb - ya).normalize_or_zero();
            quad(&mut sv, &mut si, [w(ra, ya, t1), w(ra, ya, t0), w(rb, yb, t0), w(rb, yb, t1)], wn(er.y, -er.x, 0.0));
        }
        let (lt, rt, yt) = (ls[bands], rs[bands], ys[bands]);
        quad(&mut sv, &mut si, [w(lt, yt, t0), w(rt, yt, t0), w(rt, yt, t1), w(lt, yt, t1)], wn(0.0, 1.0, 0.0));
        quad(&mut sv, &mut si, [w(ls[0], y0, t1), w(rs[0], y0, t1), w(rs[0], y0, t0), w(ls[0], y0, t0)], wn(0.0, -1.0, 0.0));

        if !crazing {
            continue;
        }
        // this piece's veneer: fragments clipped against the bounding fault
        // paths (in UNDROPPED coords — the pattern lives in the material),
        // then shear-dropped with the piece
        let dj = drop[j];
        let mut piece_frags = Vec::new();
        for f in &all_frags {
            let mut poly = f.poly.clone();
            let (fcl, fcr);
            let mut fcs: Vec<(&FaultCut, f32)> = Vec::new();
            if j > 0 {
                fcl = FaultCut { f: &faults[j - 1], y0, y1 };
                poly = cut_clip(&poly, &fcl, -1.0);
                fcs.push((&fcl, -1.0));
            }
            if j < n && poly.len() >= 3 {
                fcr = FaultCut { f: &faults[j], y0, y1 };
                poly = cut_clip(&poly, &fcr, 1.0);
                fcs.push((&fcr, 1.0));
            }
            if poly.len() < 3 || poly_area(&poly) < 1e-4 {
                continue;
            }
            // flags BEFORE the drop (the probe geometry lives in undropped
            // coords); fault-wall edges chamfer like any open groove — the
            // big seam gets beveled lips too
            let open = fault_clip_flags(&poly, f, &fcs);
            for p in &mut poly {
                p.y = (p.y + dj).max(y0);
            }
            piece_frags.push(Frag { poly, open, spalled: f.spalled, sink: f.sink });
        }
        for (t_face, nz) in [(t1, 1.0f32), (t0, -1.0f32)] {
            emit_frags(&mut vv, &mut vi, &piece_frags, t_face, nz, &cfg, &w, &wn, y0);
        }
    }
    scene.add_mesh_world(&sv, &si, mid);
    if crazing {
        scene.add_mesh_world(&cv, &ci, core_mid);
        scene.add_mesh_world(&vv, &vi, mid);
    }
    collapse_box(scene, pier);
    scene.materials[mid as usize]._pad |= GEO_BIT | if crazing { CRAZE_BIT } else { 0 };
}

/// Geometry inputs come from BUCKETED knobs (0.1 grid), so the release-time
/// signature check is exact: a drag inside a bucket changes no geometry.
fn bucket(k: [f32; 4]) -> [f32; 4] {
    k.map(|v| (v * 10.0).round() / 10.0)
}

// ---- the public surface ----------------------------------------------------

fn seg_of(scene: &Scene, pier: &Pier) -> (i32, f32) {
    let mid = scene.primitives[pier.prim].material_id;
    (mid, (mid & 255) as f32 * 0.618)
}

fn faults_for(scene: &Scene, pier: &Pier, k: [f32; 4]) -> Vec<Fault> {
    let (_, seg) = seg_of(scene, pier);
    let fr = Frame::of(pier);
    pier_faults(fr.u0, fr.u1, fr.y0, fr.y1, seg, k)
}

/// Give every knobbed pier its geometric aging: structural faults split the
/// pier (and the craze veneer rides the pieces); fault-free piers fragment
/// into core + veneer per their pattern policy. `params` = each pier's
/// ACTIVE-policy native params (the caller resolves the per-policy store).
/// Runs post-build on the CPU scene (boot and every `apply_look` rebuild),
/// before the backend sees it — `crack::resolve` calls this right after
/// stamping the knobs.
pub fn apply_geometry(scene: &mut Scene, piers: &[Pier], knobs: &[[f32; 4]], policies: &[u8], params: &[[f32; PARAMS_MAX]]) {
    for (i, (pier, k)) in piers.iter().zip(knobs).enumerate() {
        let policy = policies.get(i).copied().unwrap_or(0);
        let par = params.get(i).copied().unwrap_or(param_defaults(policy));
        let faults = faults_for(scene, pier, *k);
        if !faults.is_empty() {
            split_pier(scene, pier, &faults, *k, policy, par);
        } else if *k != [0.0; 4] {
            craze_pier(scene, pier, bucket(*k), policy, par);
        }
    }
}

/// Geometry signature of a knob state: which faults exist (and their
/// quantized widths/steps) plus the craze bucket + policy + the active
/// policy's native params — the veneer rides FAULTED piers too, so all of
/// it signs for every knobbed pier. `Viewer::crack_release` rebuilds only
/// when a slider drag (or a policy click) actually changed this —
/// dial-within-a-bucket stays live-material cheap. (Params sign RAW: they
/// are geometry-only, so any param change means a rebuild.)
pub fn signature(scene: &Scene, piers: &[Pier], knobs: &[[f32; 4]], policies: &[u8], params: &[[f32; PARAMS_MAX]]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut mixh = |x: u64| {
        h ^= x;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    };
    for (i, (pier, k)) in piers.iter().zip(knobs).enumerate() {
        let faults = faults_for(scene, pier, *k);
        for f in &faults {
            mixh(i as u64);
            mixh(f.si.to_bits() as u64);
            mixh(f.seed.to_bits() as u64);
            mixh((f.mw / 0.004).round() as u64);
            mixh(((0.015 + 0.035 * k[0]) / 0.005).round() as u64);
            mixh(if f.sign > 0.0 { 1 } else { 2 });
        }
        if *k != [0.0; 4] {
            let policy = policies.get(i).copied().unwrap_or(0);
            mixh(i as u64 | 0x8000_0000);
            mixh(policy as u64 + 0x9e37);
            for v in bucket(*k) {
                mixh(v.to_bits() as u64);
            }
            for v in params.get(i).copied().unwrap_or(param_defaults(policy)) {
                mixh(v.to_bits() as u64);
            }
        }
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;
    use glam::Vec3;

    fn pier_at(scene: &mut Scene, x0: f32) -> Pier {
        let lo = Vec3::new(x0, 0.0, 9.9);
        let hi = Vec3::new(x0 + 6.0, 1.2, 10.15);
        scene.add_box_world(lo, hi, [0.9, 0.9, 0.9, 1.0], [0.0; 4], 0.85, 0.0);
        Pier { prim: scene.primitives.len() - 1, lo, hi, run_lo: lo, run_hi: hi }
    }

    const HOT: [f32; 4] = [1.0, 1.0, 0.5, 0.0];
    /// Crazes but never faults (cracks = 0 keeps pMaj at zero).
    const CRAZY: [f32; 4] = [0.9, 0.0, 0.6, 0.8];

    /// Find a pier position whose lattice actually faults at max knobs —
    /// presence is hash-gated per strip (p ≈ 0.95), so probe a few offsets
    /// instead of betting the test on one hash value.
    fn faulting_pier(scene: &mut Scene) -> Pier {
        for i in 0..8 {
            let pier = pier_at(scene, 1.0 + 7.0 * i as f32);
            if !faults_for(scene, &pier, HOT).is_empty() {
                return pier;
            }
        }
        panic!("no fault in 8 strips at pMaj 0.95 — the lattice mirror is broken");
    }

    fn assert_in_box(scene: &Scene, from: usize, pier: &Pier, tag: &str) {
        for p in &scene.primitives[from..] {
            for v in &scene.vertices[p.vertex_offset as usize..(p.vertex_offset + p.vertex_count) as usize] {
                assert!(v.pos[0] >= pier.lo.x - 1e-4 && v.pos[0] <= pier.hi.x + 1e-4, "{tag}: x in box");
                assert!(v.pos[1] >= pier.lo.y - 1e-4 && v.pos[1] <= pier.hi.y + 1e-4, "{tag}: y in box");
                assert!(v.pos[2] >= pier.lo.z - 1e-4 && v.pos[2] <= pier.hi.z + 1e-4, "{tag}: z in box");
            }
        }
    }

    /// A faulted pier splits into shell + chalk planes + veneer (the craze
    /// layer RIDES the pieces — owner round 6), everything inside the box
    /// (drops go DOWN only, bottoms pin at y0 — bounds/probe grid frozen).
    #[test]
    fn split_composes_shell_chalk_and_veneer() {
        let mut scene = Scene::default();
        let pier = faulting_pier(&mut scene);
        let before = scene.primitives.len();
        let mid = scene.primitives[pier.prim].material_id;
        apply_geometry(&mut scene, std::slice::from_ref(&pier), &[HOT], &[0], &[param_defaults(0)]);
        let added = scene.primitives.len() - before;
        assert_eq!(added, 3, "shell + chalk planes + veneer");
        assert_eq!(scene.primitives[before].material_id, mid, "shell shares the pier material");
        assert_ne!(scene.primitives[before + 1].material_id, mid, "chalk planes get the core material");
        assert_eq!(scene.primitives[before + 2].material_id, mid, "veneer shares the pier material");
        let pad = scene.materials[mid as usize]._pad;
        assert_ne!(pad & GEO_BIT, 0, "GEO_BIT set");
        assert_ne!(pad & CRAZE_BIT, 0, "CRAZE_BIT set (veneer rides the pieces)");
        // original box collapsed to a point
        let pr = scene.primitives[pier.prim];
        let c = scene.vertices[pr.vertex_offset as usize].pos;
        assert!(scene.vertices[pr.vertex_offset as usize..(pr.vertex_offset + pr.vertex_count) as usize].iter().all(|v| v.pos == c));
        assert_in_box(&scene, before, &pier, "fault");
    }

    #[test]
    fn zero_knobs_split_nothing_and_signature_tracks_faults() {
        let mut scene = Scene::default();
        let pier = faulting_pier(&mut scene);
        let before = scene.primitives.len();
        let dp = [param_defaults(0)];
        apply_geometry(&mut scene, std::slice::from_ref(&pier), &[[0.0; 4]], &[0], &dp);
        assert_eq!(scene.primitives.len(), before, "pristine pier untouched");
        assert_eq!(scene.materials[scene.primitives[pier.prim].material_id as usize]._pad & GEO_BIT, 0);
        let s0 = signature(&scene, std::slice::from_ref(&pier), &[[0.0; 4]], &[0], &dp);
        let s1 = signature(&scene, std::slice::from_ref(&pier), &[HOT], &[0], &dp);
        assert_eq!(s0, signature(&scene, std::slice::from_ref(&pier), &[[0.0; 4]], &[0], &dp), "deterministic");
        assert_ne!(s0, s1, "fault appearance changes the signature");
    }

    /// The round-6 bug: cycling the pattern on a FAULTED pier must change
    /// the signature (the veneer layout rides the pieces), or the release
    /// rebuild never fires and the pattern row is dead on most walls.
    /// Params held FIXED across policies so only the policy term separates.
    #[test]
    fn policy_signs_on_faulted_piers_too() {
        let mut scene = Scene::default();
        let pier = faulting_pier(&mut scene);
        let par = [[0.5; PARAMS_MAX]];
        let sigs: Vec<u64> = (0..POLICIES.len() as u8).map(|p| signature(&scene, std::slice::from_ref(&pier), &[HOT], &[p], &par)).collect();
        let mut uniq = sigs.clone();
        uniq.dedup();
        assert_eq!(uniq.len(), sigs.len(), "each policy signs distinctly on a faulted pier");
    }

    /// Round 7: the native params STEER the algorithm — different lightning
    /// params rebuild a different network (and sign differently, so the
    /// release rebuild fires on a param drag).
    #[test]
    fn lightning_params_steer_the_network() {
        let mk = |par: [f32; PARAMS_MAX]| {
            let mut scene = Scene::default();
            let pier = pier_at(&mut scene, 1.0);
            let before = scene.primitives.len();
            apply_geometry(&mut scene, std::slice::from_ref(&pier), &[CRAZY], &[0], &[par]);
            let sig = signature(&scene, std::slice::from_ref(&pier), &[CRAZY], &[0], &[par]);
            (scene.primitives[before + 1].vertex_count, sig)
        };
        let (v_few, s_few) = mk([0.05, 0.9, 0.3]);
        let (v_many, s_many) = mk([0.95, 0.2, 0.6]);
        assert_ne!(s_few, s_many, "param drags must change the signature");
        assert!(v_many > v_few, "more branching + wander must grow the network ({v_many} vs {v_few})");
    }

    /// Round 7: chamfer bands appear ONLY along open grooves — a bevel on a
    /// closed seam would carve a visible V into a flush slab. Open edges
    /// inset the plate front (the groove keeps its width).
    #[test]
    fn chamfer_bands_only_on_open_grooves() {
        let cfg = CrazeCfg::new(3.0, [0.5, 0.5, 0.5, 0.0], true, 0.25, &[], param_defaults(0));
        let sq = vec![Vec2::new(0.0, 0.0), Vec2::new(1.0, 0.0), Vec2::new(1.0, 1.0), Vec2::new(0.0, 1.0)];
        let fr = Frame { run_x: true, u0: 0.0, u1: 1.0, t0: 0.0, t1: 0.25, y0: 0.0, y1: 1.0 };
        let mut v = Vec::new();
        let mut ix = Vec::new();
        let closed = Frag { poly: sq.clone(), open: vec![false; 4], spalled: false, sink: 0.0 };
        emit_frags(&mut v, &mut ix, &[closed], 0.25, 1.0, &cfg, &fr.w(), &fr.wn(), 0.0);
        assert_eq!(v.len(), 20, "sharp plate: front + 4 walls, no bevel");
        v.clear();
        ix.clear();
        let open = Frag { poly: sq, open: vec![true; 4], spalled: false, sink: 0.0 };
        emit_frags(&mut v, &mut ix, &[open], 0.25, 1.0, &cfg, &fr.w(), &fr.wn(), 0.0);
        assert_eq!(v.len(), 36, "chamfered plate adds 4 bevel bands");
        for (p, _) in &v[0..4] {
            assert!(p[0] > 1e-4 && p[0] < 1.0 - 1e-4 && p[1] > 1e-4 && p[1] < 1.0 - 1e-4, "front ring inset by the bevel: {p:?}");
        }
    }

    /// Every policy fragments a hot fault-free pier: core + veneer appended,
    /// CRAZE_BIT on both materials, all geometry inside the pier box — and
    /// the signature separates the policies (the release rebuild must fire
    /// on a pattern click).
    #[test]
    fn every_policy_fragments_and_signs_distinctly() {
        let mut sigs = Vec::new();
        for policy in 0..POLICIES.len() as u8 {
            let mut scene = Scene::default();
            let pier = pier_at(&mut scene, 1.0);
            let before = scene.primitives.len();
            let mid = scene.primitives[pier.prim].material_id as usize;
            apply_geometry(&mut scene, std::slice::from_ref(&pier), &[CRAZY], &[policy], &[param_defaults(policy)]);
            let p = POLICIES[policy as usize];
            assert_eq!(scene.primitives.len() - before, 2, "{p}: core box + one veneer mesh");
            assert_ne!(scene.materials[mid]._pad & CRAZE_BIT, 0, "{p}: CRAZE_BIT on the pier");
            let core_mid = scene.primitives[before].material_id as usize;
            assert_ne!(scene.materials[core_mid]._pad & CRAZE_BIT, 0, "{p}: CRAZE_BIT on the core");
            assert_eq!(scene.materials[core_mid]._pad & 4, 4, "{p}: matte core");
            assert_eq!(scene.materials[core_mid]._pad & crate::crack::SEL_BIT, 0, "{p}: core never selected");
            let veneer = scene.primitives[before + 1];
            assert!(veneer.vertex_count > 12, "{p}: veneer actually fragmented");
            assert_in_box(&scene, before, &pier, p);
            sigs.push(signature(&scene, std::slice::from_ref(&pier), &[CRAZY], &[policy], &[[0.5; PARAMS_MAX]]));
        }
        sigs.dedup();
        assert_eq!(sigs.len(), POLICIES.len(), "policies must sign distinctly");
    }

    /// The depth knob spans the whole slider: bucketed depth steps keep
    /// changing the veneer thickness all the way to 1.0 (the old fixed cap
    /// left the top third dead on 0.25-wu walls).
    #[test]
    fn depth_range_has_no_deadzone() {
        let thick = 0.25;
        let t_of = |dep: f32| CrazeCfg::new(3.0, [0.5, 0.5, dep, 0.5], true, thick, &[], param_defaults(0)).t;
        let mut prev = t_of(0.0);
        for i in 1..=10 {
            let t = t_of(i as f32 / 10.0);
            assert!(t > prev + 1e-5, "depth bucket {i} must deepen (got {t} after {prev})");
            prev = t;
        }
        assert!(prev <= 0.5 * thick, "two-sided veneer must leave a core sliver");
    }

    /// The ear clipper handles the non-convex polygons the splitter produces.
    #[test]
    fn triangulate_covers_a_nonconvex_polygon() {
        // an L: area 3, reflex corner at (1,1)
        let l = vec![
            Vec2::new(0.0, 0.0),
            Vec2::new(2.0, 0.0),
            Vec2::new(2.0, 1.0),
            Vec2::new(1.0, 1.0),
            Vec2::new(1.0, 2.0),
            Vec2::new(0.0, 2.0),
        ];
        let tris = triangulate(&l);
        assert_eq!(tris.len(), l.len() - 2);
        let sum: f32 = tris.iter().map(|t| (l[t[1] as usize] - l[t[0] as usize]).perp_dot(l[t[2] as usize] - l[t[0] as usize]) * 0.5).sum();
        assert!((sum - 3.0).abs() < 1e-4, "triangles tile the polygon (area {sum})");
    }

    #[test]
    fn policy_index_parses_names_and_numbers() {
        assert_eq!(policy_index("lightning"), 0);
        assert_eq!(policy_index("craquelure"), 1);
        assert_eq!(policy_index("mosaic"), 2);
        assert_eq!(policy_index("2"), 2);
        assert_eq!(policy_index("nonsense"), 0);
        assert_eq!(policy_index("9"), 0, "out-of-range index falls back");
    }

    /// Every policy declares at least one native param and sane defaults.
    #[test]
    fn policy_params_are_declared_and_bounded() {
        for (pi, params) in POLICY_PARAMS.iter().enumerate() {
            assert!(!params.is_empty() && params.len() <= PARAMS_MAX, "{}", POLICIES[pi]);
            for (name, def) in *params {
                assert!(!name.is_empty() && (0.0..=1.0).contains(def), "{name}");
            }
            let d = param_defaults(pi as u8);
            for (j, (_, def)) in params.iter().enumerate() {
                assert_eq!(d[j], *def);
            }
        }
    }
}
