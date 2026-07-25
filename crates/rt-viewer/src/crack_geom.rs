//! Geometric wall aging — the crack lab's cracks as REAL geometry.
//!
//! Every knobbed pier gets BOTH layers (owner round 6, 2026-07-23: patterns
//! must read on faulted walls too — fault and craze COMPOSE now):
//!
//! Both scales are PROPAGATED now (owner round 8, 2026-07-25: "cracks should
//! be more like lightning — branching, a bit irregular — not straight
//! lines"): [`Walk`] grows a path, [`Bolt`] wraps it as something any polygon
//! can be clipped against, [`carve`] turns a face plus a bolt list into
//! pieces or plates. The one invariant that makes it exact: the walker keeps
//! every step inside a corridor around its launch axis, so a bolt is a
//! FUNCTION in its own frame — jagged, forked, but never folded back.
//!
//! STRUCTURAL FAULTS (owner, 2026-07-23: painted faults read flat): a pier
//! whose knobs produce a structural fault (presence + the smooth SPINE are
//! the lattice the shaders paint — `faultAt` in shade.comp/shade.metal,
//! mirrored here float-for-float, which is what lets [`GEO_BIT`] suppress the
//! paint and keeps the painted stain track on the seam) is SPLIT: its box
//! prim collapses to a point and the pieces the break carves are appended as
//! prisms, separated by a real gap (wider at the top — settlement taper) with
//! one side DROPPED a few cm (the shear step). The break's path is a jagged
//! spine-anchored trunk (round 8, was one smooth vnoise wander), and it FRAYS
//! into forks — short, wide, near-vertical surface cracks that groove the
//! veneer WITHOUT separating the wall (a non-through cut must never carve
//! pieces: a piece boundary is as long as whatever it splits, so the cut's
//! invisible extension would draw a line clean across the wall). The pieces
//! share the pier's material, so knobs / selection / occluder flags keep
//! working per-segment; `Material._pad` bit 5 ([`GEO_BIT`]) tells the shade
//! pass to suppress the painted fault core + bevel.
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
//! Two rules the round-8 geometry leans on, both learned the hard way (see
//! docs/AGENT_LEARNINGS.md): a CLOSED seam must carry a wall (or rays slip
//! into the hollow piece) but only across the CORE (or the sheet stands proud
//! of the inset face), and nothing keyed to "is this edge cracked" may fire
//! on a closed seam — chamfers and sink steps included.
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
/// is a real propagation NETWORK since round 8 ([`bolt_network`]): roots land
/// where the wall is failing, each grows a kinked, forking tree whose paths
/// die on the damage zone's edge or on an older crack (T-junction), and the
/// plates are whatever the network leaves. (Rounds 4-7 emulated this by
/// shaping BSP cuts; a BSP cut always crosses its region, so the cracks came
/// out as long smooth curves — the owner's round-8 complaint.) `craquelure`
/// is the fine axis-biased [`Ladder`] (glaze crack webs — owner: the
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
/// (lightning: `branch` = how hard the walk forks, `straight` = wander/kink
/// amplitude and heading persistence, `spread` = fork angle.)
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
    /// Where CRACKS may run — a wider, EARLIER slice of the damage field than
    /// the crazing/stain zone. A crack propagates out of the worst patch into
    /// merely tired material (that is why real cracks are long while the
    /// staining stays patchy); gating cracks on the stain zone left a
    /// mid-aged wall visibly pristine, which is not what "aged" looks like.
    fn crack_zone(&self, su: f32, sy: f32) -> f32 {
        let z = smoothstep(self.d_t - 0.10, self.d_t - 0.02, self.dmg(su, sy));
        z.max(0.7 * self.halo(su, sy))
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
            // cracked free ALL ROUND or it must not sink: a step along a
            // CLOSED seam is a sub-pixel edge that dot-dashes at best, and at
            // worst draws the bolt's invisible extension as a straight line
            // across the wall (round 8 — the round-4 rule, now read off the
            // real per-edge open flags instead of the damage field)
            live = open.iter().all(|o| *o);
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
    simplify(&mut out, 0.004);
    out
}

/// Drop duplicate + near-chord vertices (< quarter-pixel deviation): the
/// clip's subdivision points on straight runs collapse back, groove edges
/// keep their wander. Purely per-polygon — grooved sides never touch, and
/// closed seams deviate under the tolerance (coincident to a quarter px).
fn simplify(poly: &mut Vec<Vec2>, tol: f32) {
    let mut i = 0;
    while poly.len() > 3 && i < poly.len() {
        let n = poly.len();
        let (a, b, c) = (poly[(i + n - 1) % n], poly[i], poly[(i + 1) % n]);
        let ac = c - a;
        let d = if ac.length_squared() < 1e-12 { 0.0 } else { (b - a).perp_dot(ac).abs() / ac.length() };
        if d < tol || (b - a).length_squared() < 1e-10 {
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
/// craquelure ladder's analytic [`Cut`]s AND the propagated [`Bolt`]s (both
/// crack scales — a structural break IS a bolt, which is how veneer
/// fragments ride the fault pieces).
trait CutLike {
    /// The path's own parameter at `p` (the analytic cuts project onto their
    /// tangent; a bolt reports its launch-frame height).
    fn t_of(&self, p: Vec2) -> f32;
    /// Clip field for one side (`side` +1 keeps below/left of the path,
    /// -1 the other side): negative = kept, zero = this side's groove wall.
    fn field(&self, p: Vec2, side: f32) -> f32;
    /// A point ON this side's groove wall at path coord `t`.
    fn wall(&self, t: f32, side: f32) -> Vec2;
    /// This side's groove wall from `t0` to `t1` (ends excluded), appended in
    /// order. The default samples uniformly — smooth paths lose nothing;
    /// [`Bolt`] overrides it to walk its OWN vertices so kinks survive the
    /// clip instead of being averaged into a soft curve.
    fn wall_path(&self, t0: f32, t1: f32, side: f32, out: &mut Vec<Vec2>) {
        let steps = ((t1 - t0).abs() / 0.06).ceil() as usize;
        for s in 1..steps {
            out.push(self.wall(mixf(t0, t1, s as f32 / steps as f32), side));
        }
    }
}

/// One analytic wandering cut through a region (the craquelure ladder):
/// signed field `s` (negative side A), groove half-width opening only inside
/// the damage zone — the ladder's topology is global but the cracks
/// themselves live in the damaged patches, tips ending crisply.
#[derive(Clone)]
struct Cut {
    n: Vec2,
    d: Vec2,
    c0: f32,
    amp: f32,
    idf: f32,
    seed: f32,
    half_g: f32,
    /// Tangent range where the groove is OPEN — resolved ONCE per cut from
    /// the damage field: first zone crossing to last, one continuous crack.
    /// (Per-sample gating chatters across the fbm threshold and the crack
    /// dashes out mid-run; real cracks connect their damaged ends.)
    span: Option<(f32, f32)>,
}

impl Cut {
    fn wander(&self, t: f32) -> f32 {
        ((vnoise(Vec3::new(t * 1.3, self.idf * 5.7, self.seed + 71.0)) - 0.5) * 1.6
            + (vnoise(Vec3::new(t * 5.3, self.idf * 5.7, self.seed + 87.0)) - 0.5) * 0.35)
            * self.amp
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
    /// Groove half-width at tangent coord `t` (0 = closed seam).
    fn gate(&self, t: f32) -> f32 {
        match self.span {
            Some((a, b)) if t >= a && t <= b => self.half_g,
            _ => 0.0,
        }
    }
}

impl CutLike for Cut {
    fn t_of(&self, p: Vec2) -> f32 {
        p.dot(self.d)
    }
    fn field(&self, p: Vec2, side: f32) -> f32 {
        let t = p.dot(self.d);
        side * (p.dot(self.n) - self.c0 - self.wander(t)) + self.gate(t)
    }
    fn wall(&self, t: f32, side: f32) -> Vec2 {
        self.d * t + self.n * (self.c0 + self.wander(t) - side * self.gate(t))
    }
}

// ---- propagation: the crack walker + the Bolt primitive (round 8) ----------
//
// Owner round 8 (2026-07-25): "the cracks should be more like LIGHTNING —
// branching, a bit irregular — not straight lines. Two kinds: the coarse one
// (a wall cracked in half) and the age crazing." Analytic lines cannot kink
// or branch, so both scales are grown by the same walker now.

fn rot(v: Vec2, a: f32) -> Vec2 {
    let (s, c) = a.sin_cos();
    Vec2::new(c * v.x - s * v.y, s * v.x + c * v.y)
}

/// The walker's dials. Steps are >= ~3 screen px so a kink actually RESOLVES
/// at the low-res target (the 2026-07-23 lesson in another suit: sub-pixel
/// detail is a per-pixel lottery, so irregularity has to be coarse).
struct Walk {
    seed: f32,
    /// mean segment length in wu
    step: f32,
    /// per-step wander (radians)
    turn: f32,
    /// chance a step KINKS, and by how much — the masonry stair-step that
    /// makes a crack read as brittle failure instead of a drawn curve
    kink_p: f32,
    kink_a: f32,
    /// how strongly the heading HOLDS an excursion (0 = snaps straight back
    /// to the launch axis and draws a line, ~0.95 = meanders like a crack)
    persist: f32,
    /// HARD corridor around the launch axis: the walk may zig-zag violently
    /// but never fold back, so the path stays a function in its launch frame
    /// (see [`Bolt`] — that invariant is what keeps the clip exact).
    corridor: f32,
}

impl Walk {
    fn h(&self, id: u32, i: usize, k: f32) -> f32 {
        hash13(Vec3::new(id as f32 * 0.618 + i as f32 * 1.37, self.seed + k, 13.0))
    }
    /// Propagate from `start` along `dir` for `budget` wu, stopping early
    /// wherever `stop` says the crack dies (out of the damage zone, off the
    /// face, or ON an older crack — the T-junction). The angle off the launch
    /// axis decays each step, so a bolt wanders and kinks but keeps heading.
    fn grow(&self, start: Vec2, dir: Vec2, budget: f32, id: u32, stop: &dyn Fn(Vec2) -> bool) -> Vec<Vec2> {
        let a0 = dir.y.atan2(dir.x);
        let mut a = 0.0f32;
        let mut pts = vec![start];
        let mut len = 0.0;
        let mut i = 0usize;
        while len < budget && i < 48 {
            let mut da = (self.h(id, i, 3.0) - 0.5) * 2.0 * self.turn;
            if self.h(id, i, 17.0) < self.kink_p {
                let s = if self.h(id, i, 23.0) < 0.5 { 1.0 } else { -1.0 };
                da += s * self.kink_a * (0.55 + 0.9 * self.h(id, i, 29.0));
            }
            a = (a * self.persist + da).clamp(-self.corridor, self.corridor);
            let sl = self.step * (0.55 + 0.9 * self.h(id, i, 37.0));
            let p = *pts.last().unwrap() + Vec2::from_angle(a0 + a) * sl;
            if stop(p) {
                break;
            }
            pts.push(p);
            len += sl;
            i += 1;
        }
        pts
    }
}

/// A propagated crack — the round-8 primitive BOTH crack scales share.
///
/// Because the walker keeps every step inside a corridor around the launch
/// axis, the path is a FUNCTION `u = f(v)` in its own (normal, axis) frame:
/// it can zig-zag, kink and fork, but never fold back over itself. That
/// invariant keeps the clip EXACT — side-of-crack is just the sign of
/// `u - f(v)`, the same structure the analytic cuts always had, now with a
/// jagged f (no distance field, no parity walk, no ambiguous kink wedges).
struct Bolt {
    axis: Vec2,
    /// path vertices in the launch frame; `vs` strictly increasing
    vs: Vec<f32>,
    us: Vec<f32>,
    /// per-segment 1/cos of the tilt off the axis: the groove is measured
    /// along the frame's u, so a steep segment must open WIDER in u to keep
    /// its >= 1 px width ACROSS the crack (capped — 3x is plenty)
    sec: Vec<f32>,
    /// the OPEN span in v; outside it the seam is CLOSED (plates touch, so
    /// the straight extensions that make the bolt cross its region — and
    /// therefore split it — stay invisible)
    open: (f32, f32),
    /// width anchors: `half` at `root`, `half * tip_ratio` at `tip`
    root: f32,
    tip: f32,
    half: f32,
    tip_ratio: f32,
    taper_pow: f32,
    /// pinch/gape along the run (0 = even width)
    wobw: f32,
    wfloor: f32,
    seedf: f32,
    /// a STRUCTURAL break: separates the pier full depth and drops one side
    through: bool,
    /// which `side` label sinks (only meaningful when `through`)
    sink_side: f32,
    /// bbox of the OPEN span, half-width padded — the carve's reject test
    lo: Vec2,
    hi: Vec2,
}

impl Bolt {
    /// Wrap a grown path (face coords, root→tip) into a bolt. `None` when the
    /// path never advances along its axis (a stillborn crack).
    fn new(path: &[Vec2], axis: Vec2, half: f32, wfloor: f32, seedf: f32) -> Option<Bolt> {
        let axis = axis.normalize_or(Vec2::Y);
        let nrm = Vec2::new(axis.y, -axis.x);
        let (mut vs, mut us) = (Vec::with_capacity(path.len()), Vec::with_capacity(path.len()));
        for p in path {
            let v = p.dot(axis);
            if vs.last().is_some_and(|last: &f32| v <= *last + 1e-4) {
                continue;
            }
            vs.push(v);
            us.push(p.dot(nrm));
        }
        if vs.len() < 2 {
            return None;
        }
        let sec: Vec<f32> = (0..vs.len() - 1)
            .map(|i| {
                let (dv, du) = (vs[i + 1] - vs[i], us[i + 1] - us[i]);
                (dv.hypot(du) / dv.max(1e-4)).min(3.0)
            })
            .collect();
        let open = (vs[0], vs[vs.len() - 1]);
        let mut b = Bolt {
            axis,
            vs,
            us,
            sec,
            open,
            root: open.0,
            tip: open.1,
            half,
            tip_ratio: 0.35,
            taper_pow: 2.0,
            wobw: 0.45,
            wfloor,
            seedf,
            through: false,
            sink_side: 1.0,
            lo: Vec2::ZERO,
            hi: Vec2::ZERO,
        };
        let (mut lo, mut hi) = (path[0], path[0]);
        for p in path {
            lo = lo.min(*p);
            hi = hi.max(*p);
        }
        let pad = Vec2::splat(b.half * 3.0 + 0.02);
        (b.lo, b.hi) = (lo - pad, hi + pad);
        Some(b)
    }
    /// Root the width at the FAR end instead (settlement gaps are widest at
    /// the top, where the wall has pulled apart most).
    fn rooted_at_tip_end(mut self, ratio: f32, pow: f32) -> Bolt {
        (self.root, self.tip) = (self.open.1, self.open.0);
        (self.tip_ratio, self.taper_pow) = (ratio, pow);
        self
    }
    fn tapered(mut self, ratio: f32, pow: f32) -> Bolt {
        (self.tip_ratio, self.taper_pow) = (ratio, pow);
        self
    }
    /// Mark this bolt a structural break: `sink` is the `side` that settles.
    fn structural(mut self, sink: f32, wob: f32) -> Bolt {
        (self.through, self.sink_side, self.wobw) = (true, sink, wob);
        self
    }
    fn nrm(&self) -> Vec2 {
        Vec2::new(self.axis.y, -self.axis.x)
    }
    fn loc(&self, p: Vec2) -> Vec2 {
        Vec2::new(p.dot(self.nrm()), p.dot(self.axis))
    }
    fn world(&self, l: Vec2) -> Vec2 {
        self.nrm() * l.x + self.axis * l.y
    }
    /// Segment index containing frame height `v` (clamped to the ends).
    fn seg(&self, v: f32) -> usize {
        let n = self.vs.len();
        let (mut a, mut b) = (0usize, n - 1);
        while b - a > 1 {
            let m = (a + b) / 2;
            if self.vs[m] <= v {
                a = m;
            } else {
                b = m;
            }
        }
        a
    }
    /// The path's u at frame height `v`. Outside the grown span the path
    /// extends STRAIGHT ALONG THE AXIS (a closed seam, so its shape is
    /// invisible) — that keeps f total and the clip well-defined everywhere.
    fn f(&self, v: f32) -> f32 {
        let n = self.vs.len();
        if v <= self.vs[0] {
            return self.us[0];
        }
        if v >= self.vs[n - 1] {
            return self.us[n - 1];
        }
        let i = self.seg(v);
        mixf(self.us[i], self.us[i + 1], (v - self.vs[i]) / (self.vs[i + 1] - self.vs[i]).max(1e-6))
    }
    /// Groove half-width at frame height `v`, measured along the frame's u
    /// (0 = closed). Taper root→tip, a width wobble that pinches and gapes
    /// along the run, the >= 1 px floor, then the steep-segment correction.
    fn halfw(&self, v: f32) -> f32 {
        if v <= self.open.0 || v >= self.open.1 {
            return 0.0;
        }
        let t = ((v - self.root) / (self.tip - self.root)).clamp(0.0, 1.0);
        let taper = mixf(1.0, self.tip_ratio, t.powf(self.taper_pow));
        let wob = (1.0 + self.wobw * (vnoise(Vec3::new(v * 2.3, self.seedf, 41.0)) - 0.5) * 2.0).max(0.3);
        (self.half * taper * wob).max(self.wfloor) * self.sec[self.seg(v)]
    }
    /// Is `p` within `r` of this bolt's OPEN run? (The T-junction test: a
    /// crack that reaches another crack stops there — real networks are
    /// T-junctions, and the old BSP model could not express one.)
    fn hits(&self, p: Vec2, r: f32) -> bool {
        let l = self.loc(p);
        l.y > self.open.0 && l.y < self.open.1 && (l.x - self.f(l.y)).abs() / self.sec[self.seg(l.y)] < r
    }
}

impl CutLike for Bolt {
    fn t_of(&self, p: Vec2) -> f32 {
        self.loc(p).y
    }
    fn field(&self, p: Vec2, side: f32) -> f32 {
        let l = self.loc(p);
        side * (l.x - self.f(l.y)) + self.halfw(l.y)
    }
    fn wall(&self, t: f32, side: f32) -> Vec2 {
        self.world(Vec2::new(self.f(t) - side * self.halfw(t), t))
    }
    /// Walk the bolt's OWN vertices (plus intermediate samples for the width
    /// wobble): a kink must land on the polygon boundary as a kink.
    fn wall_path(&self, t0: f32, t1: f32, side: f32, out: &mut Vec<Vec2>) {
        let (lo, hi) = (t0.min(t1), t0.max(t1));
        let steps = ((hi - lo) / 0.06).ceil().max(1.0) as usize;
        let mut ts: Vec<f32> = (1..steps).map(|s| lo + (hi - lo) * s as f32 / steps as f32).collect();
        ts.extend(self.vs.iter().copied().filter(|v| *v > lo + 1e-4 && *v < hi - 1e-4));
        ts.sort_by(f32::total_cmp);
        if t1 < t0 {
            ts.reverse();
        }
        out.extend(ts.into_iter().map(|t| self.wall(t, side)));
    }
}

/// Does any bolt (bar `skip`) already own the ground at `p`? Cracks stop on
/// each other — that is what turns a bundle of paths into a NETWORK.
fn any_hit(bolts: &[Bolt], p: Vec2, skip: usize, r: f32) -> bool {
    bolts.iter().enumerate().any(|(i, b)| i != skip && b.hits(p, r))
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
    let m = walk.len();
    let mut out = Vec::with_capacity(m * 2);
    for i in 0..m {
        let (p, px) = walk[i];
        out.push(p);
        let (q, qx) = walk[(i + 1) % m];
        if px && qx {
            // exit → entry: the dropped span runs along the cut — trace the wall
            cut.wall_path(cut.t_of(p), cut.t_of(q), side, &mut out);
        }
    }
    // NEAR-exact only: both sides of a CLOSED seam are walked independently,
    // so any tolerance they do not agree on becomes a real gap between two
    // coplanar plates — a ray slips through it and draws the cut's invisible
    // extension as a dark dashed line across the wall (round 8's last
    // artifact: 0.004 wu is 1/6 px, which is 15% of a pixel's worth of slip).
    simplify(&mut out, 2e-4);
    out
}

// ---- fragment generators (the pattern policies) ----------------------------

/// The CRAQUELURE policy: a near-axis LADDER splitter — the glaze-web look
/// (fine, near-rectangular plates; `scale` sizes them, `wave` bends the
/// lines). Regions with no damage (and no fault halo) anywhere stop
/// splitting early (one flush plate, no wasted tris). Lightning left this
/// machinery in round 8 — a BSP cut always crosses its region, which is
/// exactly what a propagating crack must NOT do.
struct Ladder<'a> {
    cfg: &'a CrazeCfg,
    opened: &'a StdCell<bool>,
    /// Ancestor cuts + which side kept this branch — the leaf polygons'
    /// edges are probed against these to learn which edges border an OPEN
    /// groove (chamfer eligibility).
    stack: Vec<(Cut, f32)>,
    out: Vec<Frag>,
}

impl Ladder<'_> {
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
                self.stack.iter().any(|(cut, side)| cut.field(m, *side).abs() < 0.008 && cut.gate(m.dot(cut.d)) > 0.0)
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

    fn rec(&mut self, poly: Vec<Vec2>, id: u32, depth: u32) {
        if poly.len() < 3 {
            return;
        }
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
        let min_ext = ((1.3 / self.cfg.freq) * mixf(0.55, 2.2, self.cfg.par[0])).max(0.14);
        // the ladder hugs the axes and splits its longer side
        let d = {
            let vert = hi.x - lo.x >= hi.y - lo.y;
            let base = if vert { Vec2::X } else { Vec2::Y };
            let ang = (self.h(id, 3.0) - 0.5) * mixf(0.02, 0.45, self.cfg.par[1]);
            rot(base, ang).perp()
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
        let c0 = mixf(s0 + ext * 0.42, s0 + ext * 0.58, self.h(id, 11.0));
        let g = self.cfg.groove_w(1.0 + 0.4 * (self.h(id, 19.0) - 0.5));
        let mut cut = Cut {
            n,
            d,
            c0,
            amp: mixf(0.003, 0.045, self.cfg.par[1]),
            idf: id as f32,
            seed: self.cfg.seed,
            half_g: g * 0.5,
            span: None,
        };
        let (mut td0, mut td1) = (f32::MAX, f32::MIN);
        for p in &poly {
            let t = p.dot(d);
            td0 = td0.min(t);
            td1 = td1.max(t);
        }
        cut.resolve_span(self.cfg, td0, td1, self.opened);
        let a = cut_clip(&poly, &cut, 1.0);
        let b = cut_clip(&poly, &cut, -1.0);
        // a cut that missed (degenerate side) ends the recursion cleanly
        if a.len() < 3 || b.len() < 3 || poly_area(&a) < 1e-3 || poly_area(&b) < 1e-3 {
            self.emit(poly, id);
            return;
        }
        self.stack.push((cut, 1.0));
        self.rec(a, id * 2 + 1, depth + 1);
        self.stack.last_mut().unwrap().1 = -1.0;
        self.rec(b, id * 2 + 2, depth + 1);
        self.stack.pop();
    }
}

// ---- carving a face with bolts ---------------------------------------------

/// One carved region: the polygon plus the (bolt index, kept side) pairs that
/// shaped it — the caller needs those for the per-edge OPEN flags (chamfer)
/// and, on a faulted pier, to re-clip the veneer onto the piece.
type Region = (Vec<Vec2>, Vec<(usize, f32)>);

/// Split a region into polygons with a bolt list — the ONE carver behind both
/// scales: the pier's structural pieces and the craze veneer's plates.
///
/// Sequential clipping, not a planar-subdivision build: each bolt splits the
/// polygons it reaches into its two sides. A bolt that DEAD-ENDS inside a
/// polygon still splits it — past the tip its seam is closed, so the two
/// halves touch along coincident walls no ray reaches (the trick the veneer
/// has relied on since round 4) and what you see is a crack that stops.
/// Polygons the bolt's open run cannot reach are passed through untouched
/// (fewer plates, and the clip cost stays near-linear).
fn carve(root: Vec<Vec2>, bolts: &[Bolt], cap: usize) -> Vec<Region> {
    let mut out: Vec<Region> = vec![(root, Vec::new())];
    for (i, b) in bolts.iter().enumerate() {
        let mut next: Vec<Region> = Vec::with_capacity(out.len() + 1);
        for (poly, cuts) in out.into_iter() {
            let (mut lo, mut hi) = (poly[0], poly[0]);
            for p in &poly {
                lo = lo.min(*p);
                hi = hi.max(*p);
            }
            let miss = hi.x < b.lo.x || lo.x > b.hi.x || hi.y < b.lo.y || lo.y > b.hi.y;
            if miss || next.len() >= cap {
                next.push((poly, cuts));
                continue;
            }
            let a = cut_clip(&poly, b, 1.0);
            let c = cut_clip(&poly, b, -1.0);
            if a.len() < 3 || c.len() < 3 || poly_area(&a) < 1e-4 || poly_area(&c) < 1e-4 {
                next.push((poly, cuts));
                continue;
            }
            let mut ca = cuts.clone();
            ca.push((i, 1.0));
            let mut cc = cuts;
            cc.push((i, -1.0));
            next.push((a, ca));
            next.push((c, cc));
        }
        out = next;
    }
    out
}

/// Which polygon edges sit on an OPEN groove wall of the bolts that carved
/// it — the chamfer's per-edge knowledge (round 7). Closed seams stay flush.
fn open_flags(poly: &[Vec2], cuts: &[(usize, f32)], bolts: &[Bolt]) -> Vec<bool> {
    (0..poly.len())
        .map(|i| {
            let m = (poly[i] + poly[(i + 1) % poly.len()]) * 0.5;
            cuts.iter().any(|(bi, side)| {
                let b = &bolts[*bi];
                b.field(m, *side).abs() < 0.008 && b.halfw(b.t_of(m)) > 0.0
            })
        })
        .collect()
}

/// The LIGHTNING policy: a NETWORK of propagated cracks. Roots land on a
/// jittered lattice wherever the wall is failing, each grows a tree — the
/// trunk mostly vertical (shrinkage/settlement in a standing wall), forks
/// angled off it by `spread`, gated by `branch`, jag and wander set by
/// `straight` — and every path dies on the damage zone's edge, off the face,
/// or ON an older crack (T-junction). The plates are simply what the network
/// leaves over; nothing forces a crack to cross a region.
fn bolt_network(cfg: &CrazeCfg, u0: f32, u1: f32, y0: f32, y1: f32) -> Vec<Bolt> {
    let (branch, straight, spread) = (cfg.par[0], cfg.par[1], cfg.par[2]);
    let span = Vec2::new(u1 - u0, y1 - y0);
    let pitch = (1.5 / cfg.freq).clamp(0.30, 0.75);
    // (root, launch dir, depth, budget, half width, parent bolt index)
    let mut queue: Vec<(Vec2, Vec2, u32, f32, f32, usize)> = Vec::new();
    let (nx, ny) = ((span.x / pitch).ceil().max(1.0) as i32, (span.y / pitch).ceil().max(1.0) as i32);
    for j in 0..ny {
        for i in 0..nx {
            let h = |k: f32| hash13(Vec3::new(i as f32 * 1.7 + 3.0, j as f32 * 2.3 + 7.0, cfg.seed + k));
            if h(3.0) > 0.18 + 0.55 * cfg.age {
                continue;
            }
            // three tries per lattice cell: damage patches are about a cell
            // wide, so one jittered probe misses them half the time and the
            // network thins out exactly where the wall is worst
            let root = (0..3).map(|t| Vec2::new(u0 + pitch * (i as f32 + h(1.0 + t as f32)), y0 + pitch * (j as f32 + h(2.0 + t as f32)))).find(|p| {
                p.x < u1 && p.y < y1 && cfg.crack_zone(p.x, p.y) > 0.40
            });
            let Some(p) = root else { continue };
            // a standing wall cracks mostly vertically; a few runs rake off,
            // and those stay SHORT (a wall-long horizontal crack reads as a
            // scratch, not as failure)
            let rake = h(5.0) >= 0.78;
            let tilt = if rake { 0.95 + (h(7.0) - 0.5) * 0.7 } else { (h(7.0) - 0.5) * 0.9 };
            let dir = rot(if h(9.0) < 0.5 { Vec2::Y } else { Vec2::NEG_Y }, tilt);
            // skewed: mostly short cracks, the occasional long one
            let hb = h(11.0);
            let budget = mixf(0.22, 1.10, hb * hb) * span.y.max(0.6) * if rake { 0.45 } else { 1.0 };
            queue.push((p, dir, 0, budget, cfg.groove_w(2.6) * 0.5, usize::MAX));
        }
    }
    let mut out: Vec<Bolt> = Vec::new();
    let mut qi = 0;
    while qi < queue.len() && out.len() < 48 {
        let (p0, d0, depth, budget, nominal, parent) = queue[qi];
        qi += 1;
        let w = Walk {
            seed: cfg.seed + 17.0 * (depth as f32 + 1.0),
            // ~3 px per segment: a kink shorter than that cannot resolve
            step: (3.2 * cfg.px1).max(0.085) * mixf(1.35, 0.85, straight),
            turn: mixf(0.50, 0.10, straight),
            kink_p: mixf(0.50, 0.14, straight),
            kink_a: mixf(1.15, 0.40, straight),
            // hold an excursion enough to JOG off the axis, not enough to
            // curl: high persistence draws commas, none draws scratches
            persist: mixf(0.80, 0.62, straight),
            corridor: 1.15,
        };
        let id = qi as u32 * 31 + depth;
        let path = {
            let stop = |p: Vec2| {
                p.x < u0 + 0.01
                    || p.x > u1 - 0.01
                    || p.y < y0 + 0.01
                    || p.y > y1 - 0.01
                    || cfg.crack_zone(p.x, p.y) < 0.25
                    || any_hit(&out, p, parent, 2.2 * nominal)
            };
            w.grow(p0, d0, budget, id, &stop)
        };
        // WIDTH FOLLOWS LENGTH: a crack that ran far released more energy, so
        // it is a bigger crack. (Uniform widths were what made a long run
        // read as a scratch rather than a fracture.)
        let len: f32 = path.windows(2).map(|w| (w[1] - w[0]).length()).sum();
        let rel = (len / span.y.max(0.3)).clamp(0.0, 1.0);
        let half = (cfg.groove_w((1.4 + 1.8 * rel) * 0.72f32.powi(depth as i32)) * 0.5).max(cfg.px1 * 1.1);
        let Some(bolt) = Bolt::new(&path, d0, half, cfg.px1 * 1.1, cfg.seed + id as f32) else {
            continue;
        };
        let bi = out.len();
        // forks: `branch` is the owner's dial on how much the crack frays, and
        // a long crack frays more than a short one
        if depth < 2 && path.len() > 2 {
            let kids = if depth > 0 {
                1
            } else if rel > 0.5 {
                3
            } else {
                2
            };
            for c in 0..kids {
                let hf = |k: f32| hash13(Vec3::new(id as f32 * 0.618 + c as f32 * 5.1, cfg.seed + k, 3.7));
                if hf(3.0) > mixf(0.12, 0.85, branch) * (0.55 + 0.75 * rel) {
                    continue;
                }
                let vi = (1.0 + hf(5.0) * (path.len() as f32 - 2.0)).floor() as usize;
                let vi = vi.min(path.len() - 2).max(1);
                let td = (path[vi + 1] - path[vi - 1]).normalize_or(d0);
                let sgn = if hf(7.0) < 0.5 { 1.0 } else { -1.0 };
                let fd = rot(td, sgn * mixf(0.30, 1.25, spread) * (0.7 + 0.6 * hf(11.0)));
                let fn_ = cfg.groove_w(2.2 * 0.72f32.powi(depth as i32 + 1)) * 0.5;
                queue.push((path[vi] + fd * (half * 2.2), fd, depth + 1, budget * mixf(0.3, 0.6, hf(13.0)), fn_, bi));
            }
        }
        out.push(bolt.tapered(0.30, 1.6));
    }
    out
}

/// The lightning policy's fragments: carve the face with the network, then
/// gate each plate (sink / spall / flush) like any other policy's.
fn bolt_frags(cfg: &CrazeCfg, u0: f32, u1: f32, y0: f32, y1: f32, opened: &StdCell<bool>) -> Vec<Frag> {
    let bolts = bolt_network(cfg, u0, u1, y0, y1);
    if bolts.is_empty() {
        return Vec::new();
    }
    opened.set(true);
    let rect = vec![Vec2::new(u0, y0), Vec2::new(u1, y0), Vec2::new(u1, y1), Vec2::new(u0, y1)];
    carve(rect, &bolts, 400)
        .into_iter()
        .filter_map(|(poly, cuts)| {
            let open = open_flags(&poly, &cuts, &bolts);
            let c = poly_centroid(&poly);
            let h = |k: f32| hash13(Vec3::new(c.x * 3.1, c.y * 3.1, cfg.seed + k));
            cfg.frag(poly, open, h, opened)
        })
        .collect()
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
        1 => {
            let root = vec![Vec2::new(u0, y0), Vec2::new(u1, y0), Vec2::new(u1, y1), Vec2::new(u0, y1)];
            let mut sp = Ladder { cfg, opened, stack: Vec::new(), out: Vec::new() };
            sp.rec(root, 0, 0);
            sp.out
        }
        _ => bolt_frags(cfg, u0, u1, y0, y1, opened),
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
    rect: (Vec2, Vec2),
) {
    // every emitted (u, y) is clamped into the pier's face rect: a groove wall
    // re-sampled between two crossings can bulge a hair past a jagged bolt's
    // corner, and NOTHING may leave the pier box (scene bounds and the probe
    // grid must not move — the invariant holds by construction, not by luck)
    let (rlo, rhi) = rect;
    let cl = |p: Vec2| p.clamp(rlo, rhi);
    let y_floor = rlo.y;
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
            let p = cl(*p);
            verts.push((w(p.x, p.y, front), wn(0.0, 0.0, nz)));
        }
        for tri in triangulate(&inset) {
            idx.extend_from_slice(&[base + tri[0], base + tri[1], base + tri[2]]);
        }
        for a in 0..np {
            let b = (a + 1) % np;
            let (pa, pb) = (cl(frag.poly[a]), cl(frag.poly[b]));
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
                let (ia, ib) = (cl(inset[a]), cl(inset[b]));
                let vi = verts.len() as u32;
                verts.push((w(pa.x, pa.y, fa), cn));
                verts.push((w(pb.x, pb.y, fb), cn));
                verts.push((w(ib.x, ib.y, front), cn));
                verts.push((w(ia.x, ia.y, front), cn));
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

/// Edge-open flags for a veneer fragment RE-CLIPPED onto a structural piece:
/// edges on a fault wall are open (the gap is real), surviving stretches of
/// the original perimeter inherit their old flag (their midpoints still lie
/// on the original edges).
fn piece_clip_flags(new_poly: &[Vec2], old: &Frag, cuts: &[(usize, f32)], bolts: &[Bolt]) -> Vec<bool> {
    let np = new_poly.len();
    let no = old.poly.len();
    (0..np)
        .map(|i| {
            let m = (new_poly[i] + new_poly[(i + 1) % np]) * 0.5;
            // on a cut wall AND that stretch is open — a chamfer along a
            // CLOSED seam carves a visible V into what must stay one flush
            // slab, and it draws the bolt's invisible extension as a line
            if cuts.iter().any(|(bi, side)| {
                let b = &bolts[*bi];
                b.field(m, *side).abs() < 0.008 && b.halfw(b.t_of(m)) > 0.0
            }) {
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

/// Groove existing fragments with extra cuts — the fault's FORKS. A fork is a
/// crack in the surface, not a separation of the wall: it must not carve the
/// pier into pieces (a piece boundary runs the whole width of whatever it
/// splits, so a fork's invisible extension would draw a line clean across the
/// wall — round 8 chased that artifact through three layers before moving the
/// forks down here, where a cut's reach is one PLATE wide).
fn split_frags(frags: Vec<Frag>, bolts: &[Bolt], cap: usize) -> Vec<Frag> {
    let mut out = frags;
    for b in bolts {
        let mut next: Vec<Frag> = Vec::with_capacity(out.len() + 2);
        for f in out.into_iter() {
            let (mut lo, mut hi) = (f.poly[0], f.poly[0]);
            for p in &f.poly {
                lo = lo.min(*p);
                hi = hi.max(*p);
            }
            let miss = hi.x < b.lo.x || lo.x > b.hi.x || hi.y < b.lo.y || lo.y > b.hi.y;
            if miss || next.len() >= cap {
                next.push(f);
                continue;
            }
            let a = cut_clip(&f.poly, b, 1.0);
            let c = cut_clip(&f.poly, b, -1.0);
            if a.len() < 3 || c.len() < 3 || poly_area(&a) < 1e-5 || poly_area(&c) < 1e-5 {
                next.push(f);
                continue;
            }
            for (poly, side) in [(a, 1.0), (c, -1.0)] {
                let open = piece_clip_flags(&poly, &f, &[(0, side)], std::slice::from_ref(b));
                // a plate the fork left with a closed seam may not sink
                let sink = if open.iter().all(|o| *o) { f.sink } else { 0.0 };
                next.push(Frag { poly, open, spalled: f.spalled, sink });
            }
        }
        out = next;
    }
    out
}

/// The structural TRUNK in face coords: the shader's smooth SPINE walked as a
/// jagged stair. Every step advances in height (a settlement crack never
/// folds back), the lateral moves are big kinks that mean-revert to the
/// spine — so the crack reads like a break while the painted stain halo,
/// which still follows the spine, keeps hugging the real seam.
fn trunk_path(f: &Fault, y0: f32, y1: f32, jag: f32) -> Vec<Vec2> {
    let mut pts = Vec::new();
    let mut y = y0;
    let mut off = 0.0f32;
    let mut i = 0usize;
    while y < y1 - 1e-4 {
        pts.push(Vec2::new(f.u(y) + off, y));
        let h = |k: f32| hash13(Vec3::new(i as f32 * 1.37, f.seed + k, f.si * 3.7 + 5.0));
        let dy = (0.10 + 0.13 * h(3.0)).min(y1 - y);
        // a stair KINK on some steps, small drift on the rest
        let d = if h(11.0) < 0.42 { (h(17.0) - 0.5) * 1.7 * jag } else { (h(23.0) - 0.5) * 0.6 * jag };
        off = (0.7 * off + d).clamp(-jag, jag);
        y += dy;
        i += 1;
    }
    pts.push(Vec2::new(f.u(y1) + off, y1));
    pts
}

/// Every bolt of a pier's structural break: per fault a full-height jagged
/// TRUNK (real gap, settlement drop, widest at the top) plus a few FORKS
/// fraying off it — thinner, dead-ending, no drop of their own. Forks cut the
/// pier full depth like the trunk does: a break that frays is still a break.
fn fault_bolts(faults: &[Fault], fr: &Frame, k: [f32; 4], px1: f32) -> Vec<Bolt> {
    let mut out: Vec<Bolt> = Vec::new();
    let jag = mixf(0.06, 0.17, k[0]);
    let (y0, y1) = (fr.y0, fr.y1);
    for f in faults {
        let path = trunk_path(f, y0, y1, jag);
        let (g_top, g_bot) = (f.gap(y1, y0, y1), f.gap(y0, y0, y1));
        // side +1 keeps the lower-u piece, so the sinking side is the one the
        // shader lattice's `sign` points AWAY from (old cumulative drop rule)
        let sink = if f.sign > 0.0 { -1.0 } else { 1.0 };
        let Some(trunk) = Bolt::new(&path, Vec2::Y, g_top * 0.5, px1 * 0.5, f.seed + 3.0) else {
            continue;
        };
        let ti = out.len();
        out.push(trunk.rooted_at_tip_end((g_bot / g_top.max(1e-4)).clamp(0.35, 1.0), 1.0).structural(sink, 0.5));
        // forks: one or two, SHORT and WIDE, rooted in the trunk's upper
        // half where the break has pulled furthest apart. (Long thin forks
        // read as scratches — and a full-depth cut cannot hide a hairline:
        // round 8 measured both, see docs/AGENT_LEARNINGS.md.)
        let nf = (0.4 + 1.9 * k[1] * (0.35 + 0.65 * k[0])).round() as usize;
        for j in 0..nf {
            let h = |kk: f32| hash13(Vec3::new(j as f32 * 2.7 + 1.0, f.seed + kk, f.si * 5.3 + 11.0));
            let n = path.len();
            let vi = (n as f32 * mixf(0.35, 0.90, h(3.0))).floor() as usize;
            let vi = vi.clamp(1, n.saturating_sub(2).max(1));
            let td = (path[vi + 1] - path[vi - 1]).normalize_or(Vec2::Y);
            let sgn = if h(7.0) < 0.5 { 1.0 } else { -1.0 };
            let dir = rot(td, sgn * mixf(0.40, 0.90, h(11.0)));
            let w = Walk {
                seed: f.seed + 7.0 + j as f32,
                step: 0.12,
                turn: 0.40,
                kink_p: 0.36,
                kink_a: 0.85,
                persist: 0.90,
                corridor: 0.70,
            };
            let half = (px1 * 1.3).max(g_top * 0.45);
            let start = path[vi] + dir * (g_top * 0.6 + half);
            let fp = {
                let stop = |p: Vec2| {
                    p.x < fr.u0 + 0.01
                        || p.x > fr.u1 - 0.01
                        || p.y < y0 + 0.01
                        || p.y > y1 - 0.01
                        || any_hit(&out, p, ti, half * 2.5)
                };
                w.grow(start, dir, mixf(0.12, 0.35, h(17.0)) * (y1 - y0), 900 + j as u32, &stop)
            };
            if let Some(b) = Bolt::new(&fp, dir, half, px1 * 1.1, f.seed + 31.0 + j as f32) {
                out.push(b.tapered(0.40, 1.5));
            }
        }
    }
    out
}

/// Extrude one structural piece: front/back planes into `pv` (the chalk core
/// when the veneer is on, else the pier's own face) and the perimeter walls —
/// fault flanks, ends, top cap and base — into `sv`, full thickness. The
/// polygon boundary IS the crack path, so a kink shows in the silhouette.
#[allow(clippy::too_many_arguments)]
fn emit_prism(
    sv: &mut Vec<([f32; 3], [f32; 3])>,
    si: &mut Vec<u32>,
    pv: &mut Vec<([f32; 3], [f32; 3])>,
    pi: &mut Vec<u32>,
    poly: &[Vec2],
    closed: &[bool],
    t0: f32,
    t1: f32,
    ff: f32,
    fb: f32,
    w: &dyn Fn(f32, f32, f32) -> [f32; 3],
    wn: &dyn Fn(f32, f32, f32) -> [f32; 3],
) {
    let base = pv.len() as u32;
    for p in poly {
        pv.push((w(p.x, p.y, ff), wn(0.0, 0.0, 1.0)));
    }
    for p in poly {
        pv.push((w(p.x, p.y, fb), wn(0.0, 0.0, -1.0)));
    }
    let n = poly.len() as u32;
    for tri in triangulate(poly) {
        pi.extend_from_slice(&[base + tri[0], base + tri[1], base + tri[2]]);
        pi.extend_from_slice(&[base + n + tri[0], base + n + tri[2], base + n + tri[1]]);
    }
    for a in 0..poly.len() {
        // A CLOSED seam's wall spans only the CORE (plane to plane): the two
        // pieces are one solid there, so the sheet must (a) exist — dropping
        // it opens the prism and rays that slip in hit the far side from
        // inside, drawing the cut's invisible extension as a dark line — and
        // (b) never stand PROUD of the inset front plane, or it draws the same
        // line from the outside. Open grooves and the pier's own border keep
        // the full thickness. (Round 8 hit both artifacts in turn.)
        let (za, zb) = if closed[a] { (fb, ff) } else { (t0, t1) };
        let (pa, pb) = (poly[a], poly[(a + 1) % poly.len()]);
        let e = (pb - pa).normalize_or_zero();
        // A full-depth cut cannot overhang its lower lip (the round-4 droop
        // trick needs a solid behind it), so a near-horizontal lip would
        // present a SKY-LIT ledge and the crack would dash out. Tilt such a
        // lip's normal DOWN instead: the cavity reads dark at every
        // orientation, which is the invariant that matters.
        let mut nn = Vec2::new(e.y, -e.x);
        if nn.y > 0.0 && e.x.abs() > 0.55 {
            nn.y *= -0.5;
        }
        quad(sv, si, [w(pa.x, pa.y, za), w(pa.x, pa.y, zb), w(pb.x, pb.y, zb), w(pb.x, pb.y, za)], wn(nn.x, nn.y, 0.0));
    }
}

/// Fragment an UNFAULTED pier into core box + veneer per the policy.
/// Returns false (scene untouched) when nothing opened — no groove, no live
/// or spalled plate: the pier keeps its box and its paint.
fn craze_pier(scene: &mut Scene, pier: &Pier, k: [f32; 4], policy: u8, par: [f32; PARAMS_MAX]) -> i32 {
    let (mid, seg) = seg_of(scene, pier);
    let fr = Frame::of(pier);
    let cfg = CrazeCfg::new(seg, k, fr.run_x, fr.t1 - fr.t0, &[], par);
    let opened = StdCell::new(false);
    let frags = policy_frags(&cfg, policy, fr.u0, fr.u1, fr.y0, fr.y1, &opened);
    if !opened.get() {
        return -1;
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
    let rect = (Vec2::new(fr.u0, fr.y0), Vec2::new(fr.u1, fr.y1));
    for (t_face, nz) in [(fr.t1, 1.0f32), (fr.t0, -1.0f32)] {
        emit_frags(&mut verts, &mut idx, &frags, t_face, nz, &cfg, &fr.w(), &fr.wn(), rect);
    }
    scene.add_mesh_world(&verts, &idx, mid);
    collapse_box(scene, pier);
    scene.materials[mid as usize]._pad |= CRAZE_BIT;
    core_mid as i32
}

/// Split a FAULTED pier along its faults AND craze the pieces: per piece a
/// full-thickness shell (fault walls + caps, pier material), inset front/
/// back planes (the chalk core showing in grooves and recesses), and the
/// policy veneer clipped against the fault paths — so the small-crack
/// pattern rides the broken wall and clusters along the seam (halo).
fn split_pier(scene: &mut Scene, pier: &Pier, faults: &[Fault], k: [f32; 4], policy: u8, par: [f32; PARAMS_MAX]) -> i32 {
    let (mid, seg) = seg_of(scene, pier);
    let fr = Frame::of(pier);
    let (u0, u1, t0, t1, y0, y1) = (fr.u0, fr.u1, fr.t0, fr.t1, fr.y0, fr.y1);
    let w = fr.w();
    let wn = fr.wn();

    let cfg = CrazeCfg::new(seg, bucket(k), fr.run_x, t1 - t0, faults, par);
    // the break, grown: jagged trunks (THROUGH — they separate the wall) plus
    // their forks (surface cracks that groove the veneer only)
    let all_bolts = fault_bolts(faults, &fr, bucket(k), cfg.px1);
    let (bolts, forks): (Vec<Bolt>, Vec<Bolt>) = all_bolts.into_iter().partition(|b| b.through);
    let opened = StdCell::new(false);
    let all_frags = split_frags(policy_frags(&cfg, policy, u0, u1, y0, y1, &opened), &forks, 400);
    // the veneer inset only happens when the craze layer has anything to
    // show — a pristine-but-faulted wall stays full-thickness slabs
    let crazing = opened.get() || !forks.is_empty();
    let inset = if crazing { cfg.t } else { 0.0 };
    let core_mid = if crazing { chalk_material(scene, mid) } else { mid };
    let (ff, fb) = (t1 - inset, t0 + inset); // front/back planes (inset when crazing)

    let rect = vec![Vec2::new(u0, y0), Vec2::new(u1, y0), Vec2::new(u1, y1), Vec2::new(u0, y1)];
    let pieces = carve(rect, &bolts, 64);
    // shear steps: every THROUGH bolt drops the pieces on its sinking side a
    // few cm (cumulative when breaks stack), then everything is shifted so
    // nothing rises above the authored top
    let step = 0.015 + 0.035 * k[0];
    let mut drops: Vec<f32> = pieces
        .iter()
        .map(|(_, cuts)| step * cuts.iter().filter(|(i, s)| bolts[*i].through && *s == bolts[*i].sink_side).count() as f32)
        .collect();
    let top = drops.iter().fold(f32::MIN, |a, &b| a.max(b));
    for d in &mut drops {
        *d -= top;
    }

    // three meshes for the whole pier: the structural shells (pier mat), the
    // inset front/back planes (chalk), the veneer fragments (pier mat)
    let mut sv = Vec::new();
    let mut si = Vec::new();
    let mut cv = Vec::new();
    let mut ci = Vec::new();
    let mut vv = Vec::new();
    let mut vi = Vec::new();
    for ((poly, cuts), dj) in pieces.iter().zip(&drops) {
        // dropped copy (bottoms pinned at y0 — the buried part is invisible
        // and keeps scene bounds, and thus the probe grid, where they were)
        let dropped: Vec<Vec2> = poly.iter().map(|p| Vec2::new(p.x.clamp(u0, u1), (p.y + dj).clamp(y0, y1))).collect();
        // which edges are CLOSED seams (probed BEFORE the drop — the cut
        // fields live in undropped coords)
        let np = poly.len();
        let closed: Vec<bool> = (0..np)
            .map(|i| {
                let m = (poly[i] + poly[(i + 1) % np]) * 0.5;
                cuts.iter().any(|(bi, side)| {
                    let b = &bolts[*bi];
                    b.field(m, *side).abs() < 0.008 && b.halfw(b.t_of(m)) <= 0.0
                })
            })
            .collect();
        emit_prism(&mut sv, &mut si, &mut cv, &mut ci, &dropped, &closed, t0, t1, ff, fb, &w, &wn);
        if !crazing {
            continue;
        }
        // this piece's veneer: fragments clipped against the bolts that carved
        // the piece (in UNDROPPED coords — the pattern lives in the material),
        // then shear-dropped with the piece
        let mut piece_frags = Vec::new();
        for f in &all_frags {
            let mut fpoly = f.poly.clone();
            for (bi, side) in cuts {
                fpoly = cut_clip(&fpoly, &bolts[*bi], *side);
                if fpoly.len() < 3 {
                    break;
                }
            }
            if fpoly.len() < 3 || poly_area(&fpoly) < 1e-4 {
                continue;
            }
            // flags BEFORE the drop (the probe geometry lives in undropped
            // coords); fault-wall edges chamfer like any open groove — the
            // big seam gets beveled lips too
            let open = piece_clip_flags(&fpoly, f, cuts, &bolts);
            for p in &mut fpoly {
                *p = Vec2::new(p.x.clamp(u0, u1), (p.y + dj).clamp(y0, y1));
            }
            piece_frags.push(Frag { poly: fpoly, open, spalled: f.spalled, sink: f.sink });
        }
        for (t_face, nz) in [(t1, 1.0f32), (t0, -1.0f32)] {
            emit_frags(&mut vv, &mut vi, &piece_frags, t_face, nz, &cfg, &w, &wn, (Vec2::new(u0, y0), Vec2::new(u1, y1)));
        }
    }
    scene.add_mesh_world(&sv, &si, mid);
    scene.add_mesh_world(&cv, &ci, if crazing { core_mid } else { mid });
    if crazing {
        scene.add_mesh_world(&vv, &vi, mid);
    }
    collapse_box(scene, pier);
    scene.materials[mid as usize]._pad |= GEO_BIT | if crazing { CRAZE_BIT } else { 0 };
    if crazing {
        core_mid
    } else {
        -1
    }
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
/// into core + veneer per their pattern policy. Returns each pier's CHALK CORE
/// material id (-1 = the pier stayed a plain box): the core carries the groove
/// floors, so anything scoped per-pier — the contour AA's opt-in bit — has to
/// stamp it alongside the pier's own material or the crack's darkest pixels
/// fall outside the scope. `params` = each pier's
/// ACTIVE-policy native params (the caller resolves the per-policy store).
/// Runs post-build on the CPU scene (boot and every `apply_look` rebuild),
/// before the backend sees it — `crack::resolve` calls this right after
/// stamping the knobs.
pub fn apply_geometry(scene: &mut Scene, piers: &[Pier], knobs: &[[f32; 4]], policies: &[u8], params: &[[f32; PARAMS_MAX]]) -> Vec<i32> {
    let mut cores = vec![-1; piers.len()];
    for (i, (pier, k)) in piers.iter().zip(knobs).enumerate() {
        let policy = policies.get(i).copied().unwrap_or(0);
        let par = params.get(i).copied().unwrap_or(param_defaults(policy));
        let faults = faults_for(scene, pier, *k);
        cores[i] = if !faults.is_empty() {
            split_pier(scene, pier, &faults, *k, policy, par)
        } else if *k != [0.0; 4] {
            craze_pier(scene, pier, bucket(*k), policy, par)
        } else {
            -1
        };
    }
    cores
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
        emit_frags(&mut v, &mut ix, &[closed], 0.25, 1.0, &cfg, &fr.w(), &fr.wn(), (Vec2::ZERO, Vec2::ONE));
        assert_eq!(v.len(), 20, "sharp plate: front + 4 walls, no bevel");
        v.clear();
        ix.clear();
        let open = Frag { poly: sq, open: vec![true; 4], spalled: false, sink: 0.0 };
        emit_frags(&mut v, &mut ix, &[open], 0.25, 1.0, &cfg, &fr.w(), &fr.wn(), (Vec2::ZERO, Vec2::ONE));
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

    // ---- round 8: the propagation core --------------------------------------

    /// THE load-bearing invariant: a grown path is a FUNCTION of its launch
    /// frame (the corridor clamp keeps every step advancing along the axis).
    /// The whole clip is exact because of this — side-of-crack is the sign of
    /// `u - f(v)`, with no ambiguous wedges at a kink.
    #[test]
    fn grown_paths_stay_monotone_in_their_launch_axis() {
        let w = Walk { seed: 3.0, step: 0.12, turn: 0.6, kink_p: 0.5, kink_a: 1.2, persist: 0.95, corridor: 1.15 };
        for (i, dir) in [Vec2::Y, Vec2::NEG_Y, Vec2::X, Vec2::new(0.7, -0.7)].iter().enumerate() {
            let path = w.grow(Vec2::new(1.0, 0.5), *dir, 2.0, i as u32, &|_| false);
            assert!(path.len() > 4, "the walk must actually propagate");
            let b = Bolt::new(&path, *dir, 0.03, 0.02, 5.0).expect("a monotone path is a bolt");
            assert_eq!(b.vs.len(), path.len(), "no step may fail to advance along the axis");
            assert!(b.vs.windows(2).all(|w| w[1] > w[0]), "strictly increasing in the launch frame");
            // f interpolates its own vertices
            for (v, u) in b.vs.iter().zip(&b.us) {
                assert!((b.f(*v) - u).abs() < 1e-4);
            }
            // both sides of the path are labelled consistently by the field
            let mid = b.world(Vec2::new(b.f((b.open.0 + b.open.1) * 0.5) + 0.5, (b.open.0 + b.open.1) * 0.5));
            assert!(b.field(mid, 1.0) > 0.0 && b.field(mid, -1.0) < 0.0, "sides disagree exactly");
        }
    }

    /// A bolt KINKS (that is the round-8 ask: not smooth curves) and the
    /// network FORKS with T-junctions instead of BSP-splitting the face.
    #[test]
    fn the_network_kinks_and_forks() {
        // several segment seeds: the damage field decides where cracks may
        // grow at all, so one wall can legitimately come out nearly clean
        let bolts: Vec<Bolt> = (1..8)
            .flat_map(|seg| {
                let cfg = CrazeCfg::new(seg as f32 * 3.7, bucket(CRAZY), true, 0.25, &[], param_defaults(0));
                bolt_network(&cfg, 0.0, 6.0, 0.0, 2.2)
            })
            .collect();
        assert!(bolts.len() > 8, "hot walls grow networks, got {}", bolts.len());
        // at least one bolt turns hard somewhere along its run
        let kinked = bolts.iter().any(|b| {
            (1..b.vs.len().saturating_sub(1)).any(|i| {
                let (a, c) = (Vec2::new(b.us[i] - b.us[i - 1], b.vs[i] - b.vs[i - 1]), Vec2::new(b.us[i + 1] - b.us[i], b.vs[i + 1] - b.vs[i]));
                a.normalize_or_zero().dot(c.normalize_or_zero()) < 0.86 // > ~30 degrees
            })
        });
        assert!(kinked, "no bolt kinks — the paths are smooth again");
        // forks: some bolt starts ON another bolt's open run (a T-junction)
        let forked = bolts.iter().enumerate().any(|(i, b)| {
            let root = b.world(Vec2::new(b.us[0], b.vs[0]));
            bolts.iter().enumerate().any(|(j, o)| j != i && o.hits(root, 4.0 * o.half))
        });
        assert!(forked, "no T-junction — the network is a bundle of unrelated cracks");
    }

    /// Every open groove keeps its >= 1 px width ACROSS the crack, whatever
    /// the segment's tilt off the bolt frame (the `sec` correction) — the
    /// round-4 floor survives propagation.
    #[test]
    fn grooves_never_go_sub_pixel_across() {
        let cfg = CrazeCfg::new(7.4, bucket(CRAZY), true, 0.25, &[], param_defaults(0));
        let bolts = bolt_network(&cfg, 0.0, 6.0, 0.0, 2.2);
        assert!(!bolts.is_empty(), "nothing to measure");
        for b in &bolts {
            for s in 1..40 {
                let v = mixf(b.open.0, b.open.1, s as f32 / 40.0);
                let across = b.halfw(v) / b.sec[b.seg(v)] * 2.0;
                assert!(across >= cfg.px1 - 1e-5, "{across} wu across is under one pixel ({})", cfg.px1);
            }
        }
    }

    /// A fault grows ONE through trunk (the break that separates the wall)
    /// plus surface forks that must NOT separate it: a fork carving pieces
    /// would run its invisible extension clean across the wall.
    #[test]
    fn a_fault_separates_once_and_frays_on_the_surface() {
        let mut scene = Scene::default();
        let pier = faulting_pier(&mut scene);
        let faults = faults_for(&scene, &pier, HOT);
        let fr = Frame::of(&pier);
        let bolts = fault_bolts(&faults, &fr, bucket(HOT), px_floor(fr.run_x));
        let through = bolts.iter().filter(|b| b.through).count();
        assert_eq!(through, faults.len(), "one through break per fault");
        assert!(bolts.len() > through, "the break must fray into forks");
        // the trunk jags: many vertices, real lateral deviation from a line
        let trunk = bolts.iter().find(|b| b.through).unwrap();
        assert!(trunk.vs.len() >= 8, "the trunk is walked, not drawn");
        let (a, b) = (Vec2::new(trunk.us[0], trunk.vs[0]), Vec2::new(*trunk.us.last().unwrap(), *trunk.vs.last().unwrap()));
        let sag = (0..trunk.vs.len())
            .map(|i| {
                let p = Vec2::new(trunk.us[i], trunk.vs[i]);
                let t = ((p - a).dot(b - a) / (b - a).length_squared()).clamp(0.0, 1.0);
                (p - (a + (b - a) * t)).length()
            })
            .fold(0.0f32, f32::max);
        assert!(sag > 0.02, "the trunk must wander off the straight line (sag {sag})");
    }

    /// `carve` TILES its region: the pieces cover the face exactly (minus the
    /// gaps the open grooves take), so no hole and no double-covered sliver
    /// can hide in a break.
    #[test]
    fn carve_tiles_the_face() {
        let mut scene = Scene::default();
        let pier = faulting_pier(&mut scene);
        let faults = faults_for(&scene, &pier, HOT);
        let fr = Frame::of(&pier);
        let bolts: Vec<Bolt> = fault_bolts(&faults, &fr, bucket(HOT), px_floor(fr.run_x)).into_iter().filter(|b| b.through).collect();
        let rect = vec![Vec2::new(fr.u0, fr.y0), Vec2::new(fr.u1, fr.y0), Vec2::new(fr.u1, fr.y1), Vec2::new(fr.u0, fr.y1)];
        let area = poly_area(&rect);
        let pieces = carve(rect, &bolts, 64);
        assert!(pieces.len() > bolts.len(), "each through break adds a piece");
        let sum: f32 = pieces.iter().map(|(p, _)| poly_area(p)).sum();
        // the missing area is exactly the gaps: at most (gap 0.09) x height x cuts
        let gaps = 0.09 * (fr.y1 - fr.y0) * bolts.len() as f32;
        assert!(sum <= area + 1e-3 && sum >= area - gaps, "pieces tile the face: {sum} vs {area} (gaps <= {gaps})");
        for (p, cuts) in &pieces {
            assert!(poly_area(p) > 1e-4 && p.len() >= 3, "no degenerate piece");
            assert!(cuts.iter().all(|(i, s)| *i < bolts.len() && s.abs() == 1.0));
        }
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
