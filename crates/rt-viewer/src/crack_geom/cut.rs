//! THE PROPAGATOR — the crack walker, the [`Bolt`] primitive it grows, and the
//! carver that turns a face plus a bolt list into pieces or plates.
//!
//! Round 8's thesis in one module: BOTH crack scales are the same walker. A
//! structural break and a veneer seam differ in width, depth and who consumes
//! them, not in how they are grown — so the pier's pieces and the craze
//! veneer's plates come out of one [`carve`].
//!
//! The one invariant everything here rests on: [`Walk`] keeps every step inside
//! a corridor around its launch axis, so a bolt is a FUNCTION in its own frame
//! — jagged, forked, but never folded back — and side-of-crack is just the sign
//! of `u - f(v)`.

use glam::{Vec2, Vec3};
use super::poly::{poly_area, seg_dist, simplify, Frag};
use wear_core::field::{hash13, mixf, vnoise};

/// Anything a polygon can be clipped against along a wandering path: the
/// craquelure ladder's analytic [`super::craze::Cut`]s AND the propagated
/// [`Bolt`]s (both crack scales — a structural break IS a bolt, which is how
/// veneer fragments ride the fault pieces).
pub(super) trait CutLike {
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

// ---- propagation: the crack walker + the Bolt primitive (round 8) ----------
//
// Owner round 8 (2026-07-25): "the cracks should be more like LIGHTNING —
// branching, a bit irregular — not straight lines. Two kinds: the coarse one
// (a wall cracked in half) and the age crazing." Analytic lines cannot kink
// or branch, so both scales are grown by the same walker now.

/// The walker's dials. Steps are >= ~3 screen px so a kink actually RESOLVES
/// at the low-res target (the 2026-07-23 lesson in another suit: sub-pixel
/// detail is a per-pixel lottery, so irregularity has to be coarse).
pub(super) struct Walk {
    pub(super) seed: f32,
    /// mean segment length in wu
    pub(super) step: f32,
    /// per-step wander (radians)
    pub(super) turn: f32,
    /// chance a step KINKS, and by how much — the masonry stair-step that
    /// makes a crack read as brittle failure instead of a drawn curve
    pub(super) kink_p: f32,
    pub(super) kink_a: f32,
    /// how strongly the heading HOLDS an excursion (0 = snaps straight back
    /// to the launch axis and draws a line, ~0.95 = meanders like a crack)
    pub(super) persist: f32,
    /// HARD corridor around the launch axis: the walk may zig-zag violently
    /// but never fold back, so the path stays a function in its launch frame
    /// (see [`Bolt`] — that invariant is what keeps the clip exact).
    pub(super) corridor: f32,
}

impl Walk {
    fn h(&self, id: u32, i: usize, k: f32) -> f32 {
        hash13(Vec3::new(id as f32 * 0.618 + i as f32 * 1.37, self.seed + k, 13.0))
    }
    /// Propagate from `start` along `dir` for `budget` wu, stopping early
    /// wherever `stop` says the crack dies (out of the damage zone, off the
    /// face, or ON an older crack — the T-junction). The angle off the launch
    /// axis decays each step, so a bolt wanders and kinks but keeps heading.
    pub(super) fn grow(&self, start: Vec2, dir: Vec2, budget: f32, id: u32, stop: &dyn Fn(Vec2) -> bool) -> Vec<Vec2> {
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
pub(super) struct Bolt {
    pub(super) axis: Vec2,
    /// path vertices in the launch frame; `vs` strictly increasing
    pub(super) vs: Vec<f32>,
    pub(super) us: Vec<f32>,
    /// per-segment 1/cos of the tilt off the axis: the groove is measured
    /// along the frame's u, so a steep segment must open WIDER in u to keep
    /// its >= 1 px width ACROSS the crack (capped — 3x is plenty)
    pub(super) sec: Vec<f32>,
    /// the OPEN span in v; outside it the seam is CLOSED (plates touch, so
    /// the straight extensions that make the bolt cross its region — and
    /// therefore split it — stay invisible)
    pub(super) open: (f32, f32),
    /// width anchors: `half` at `root`, `half * tip_ratio` at `tip`
    pub(super) root: f32,
    pub(super) tip: f32,
    pub(super) half: f32,
    pub(super) tip_ratio: f32,
    pub(super) taper_pow: f32,
    /// pinch/gape along the run (0 = even width)
    pub(super) wobw: f32,
    pub(super) wfloor: f32,
    pub(super) seedf: f32,
    /// a STRUCTURAL break: separates the pier full depth and drops one side
    pub(super) through: bool,
    /// which `side` label sinks (only meaningful when `through`)
    pub(super) sink_side: f32,
    /// bbox of the OPEN span, half-width padded — the carve's reject test
    pub(super) lo: Vec2,
    pub(super) hi: Vec2,
}

impl Bolt {
    /// Wrap a grown path (face coords, root→tip) into a bolt. `None` when the
    /// path never advances along its axis (a stillborn crack).
    pub(super) fn new(path: &[Vec2], axis: Vec2, half: f32, wfloor: f32, seedf: f32) -> Option<Bolt> {
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
    pub(super) fn rooted_at_tip_end(mut self, ratio: f32, pow: f32) -> Bolt {
        (self.root, self.tip) = (self.open.1, self.open.0);
        (self.tip_ratio, self.taper_pow) = (ratio, pow);
        self
    }
    pub(super) fn tapered(mut self, ratio: f32, pow: f32) -> Bolt {
        (self.tip_ratio, self.taper_pow) = (ratio, pow);
        self
    }
    /// Mark this bolt a structural break: `sink` is the `side` that settles.
    pub(super) fn structural(mut self, sink: f32, wob: f32) -> Bolt {
        (self.through, self.sink_side, self.wobw) = (true, sink, wob);
        self
    }
    fn nrm(&self) -> Vec2 {
        Vec2::new(self.axis.y, -self.axis.x)
    }
    fn loc(&self, p: Vec2) -> Vec2 {
        Vec2::new(p.dot(self.nrm()), p.dot(self.axis))
    }
    pub(super) fn world(&self, l: Vec2) -> Vec2 {
        self.nrm() * l.x + self.axis * l.y
    }
    /// Segment index containing frame height `v` (clamped to the ends).
    pub(super) fn seg(&self, v: f32) -> usize {
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
    pub(super) fn f(&self, v: f32) -> f32 {
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
    pub(super) fn halfw(&self, v: f32) -> f32 {
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
    pub(super) fn hits(&self, p: Vec2, r: f32) -> bool {
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
pub(super) fn any_hit(bolts: &[Bolt], p: Vec2, skip: usize, r: f32) -> bool {
    bolts.iter().enumerate().any(|(i, b)| i != skip && b.hits(p, r))
}

/// Clip a region polygon to one side of a wandering cut. A plain polygon
/// walk only yields crossing points on the REGION's edges — the boundary
/// between an exit and the next entry would be a straight chord and the
/// cut's wander (the whole crack character) would vanish. So adjacent
/// crossing pairs get the groove wall re-sampled between them.
pub(super) fn cut_clip(poly: &[Vec2], cut: &dyn CutLike, side: f32) -> Vec<Vec2> {
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

// ---- carving a face with bolts ---------------------------------------------

/// One carved region: the polygon plus the (bolt index, kept side) pairs that
/// shaped it — the caller needs those for the per-edge OPEN flags (chamfer)
/// and, on a faulted pier, to re-clip the veneer onto the piece.
pub(super) type Region = (Vec<Vec2>, Vec<(usize, f32)>);

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
pub(super) fn carve(root: Vec<Vec2>, bolts: &[Bolt], cap: usize) -> Vec<Region> {
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
pub(super) fn open_flags(poly: &[Vec2], cuts: &[(usize, f32)], bolts: &[Bolt]) -> Vec<bool> {
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

/// Edge-open flags for a veneer fragment RE-CLIPPED onto a structural piece:
/// edges on a fault wall are open (the gap is real), surviving stretches of
/// the original perimeter inherit their old flag (their midpoints still lie
/// on the original edges).
pub(super) fn piece_clip_flags(new_poly: &[Vec2], old: &Frag, cuts: &[(usize, f32)], bolts: &[Bolt]) -> Vec<bool> {
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
pub(super) fn split_frags(frags: Vec<Frag>, bolts: &[Bolt], cap: usize) -> Vec<Frag> {
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

/// Does a rect sit wholly inside this carved piece? Clipping it against the
/// piece's own cuts must give it back untouched — the same `cut_clip` the veneer
/// uses, so "inside" means exactly what it means to every other layer.
pub(super) fn rect_inside(lo: Vec2, hi: Vec2, cuts: &[(usize, f32)], bolts: &[Bolt]) -> bool {
    let mut poly = vec![lo, Vec2::new(hi.x, lo.y), hi, Vec2::new(lo.x, hi.y)];
    let want = (hi.x - lo.x) * (hi.y - lo.y);
    for (bi, side) in cuts {
        poly = cut_clip(&poly, &bolts[*bi], *side);
        if poly.len() < 3 {
            return false;
        }
    }
    poly_area(&poly) > want - 1e-5
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crack_geom::breaks::{fault_bolts, faults_for};
    use crate::crack_geom::craze::CrazeCfg;
    use crate::crack_geom::fixtures::*;
    use crate::crack_geom::{story_of, Frame};
    use rt_probe::Scene;

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

    /// `carve` TILES its region: the pieces cover the face exactly (minus the
    /// gaps the open grooves take), so no hole and no double-covered sliver
    /// can hide in a break.
    #[test]
    fn carve_tiles_the_face() {
        let mut scene = Scene::default();
        let pier = pier_at(&mut scene, 1.0);
        let faults = faults_for(&scene, &pier, &broken(0));
        let fr = Frame::of(&pier);
        let bolts: Vec<Bolt> = fault_bolts(&faults, &fr, &CrazeCfg::new(story_of(&scene, &pier), &broken(0), fr.run_x, fr.t1 - fr.t0, &faults)).into_iter().filter(|b| b.through).collect();
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
}
