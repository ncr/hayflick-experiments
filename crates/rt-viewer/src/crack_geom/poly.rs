//! THE POLYGON TOOLKIT — the geometry `crack_geom` is built out of, with no
//! wear opinion in any of it.
//!
//! Areas and centroids, the two clippers (an analytic half-plane and a curved
//! iso-line), the ear-clip triangulator, and the [`Frag`] — a simple CCW
//! polygon plus the per-edge OPEN flags every consumer needs — with its exact
//! rect subtraction. Nothing here knows what a wall is; the one exception is
//! [`rect_hits`], which borrows the patch gap from `wear_core::rebar` because
//! the gap IS the rect test's tolerance.

use glam::Vec2;
use wear_core::rebar;

/// One veneer fragment: a simple CCW polygon in face coords (u, y) + its
/// aging gates (sampled at the fragment, not per pixel — whole plates let go).
#[derive(Clone)]
pub(super) struct Frag {
    pub(super) poly: Vec<Vec2>,
    /// Per-edge (`poly[i]` -> `poly[i+1]`): does this edge border an OPEN groove?
    /// Only those edges get the chamfer — a bevel along a closed seam would
    /// carve a visible V-groove into what must stay one flush slab.
    pub(super) open: Vec<bool>,
    pub(super) spalled: bool,
    pub(super) sink: f32,
}

pub(super) fn poly_area(p: &[Vec2]) -> f32 {
    let mut a = 0.0;
    for i in 0..p.len() {
        a += p[i].perp_dot(p[(i + 1) % p.len()]);
    }
    a * 0.5
}
pub(super) fn poly_centroid(p: &[Vec2]) -> Vec2 {
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
/// [`super::cut::cut_clip`], which re-samples the groove wall.)
pub(super) fn curved_clip(poly: &[Vec2], f: &dyn Fn(Vec2) -> f32) -> Vec<Vec2> {
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
pub(super) fn simplify(poly: &mut Vec<Vec2>, tol: f32) {
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
pub(crate) fn triangulate(poly: &[Vec2]) -> Vec<[u32; 3]> {
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

pub(super) fn rot(v: Vec2, a: f32) -> Vec2 {
    let (s, c) = a.sin_cos();
    Vec2::new(c * v.x - s * v.y, s * v.x + c * v.y)
}

/// Clip a flagged polygon to the half-plane `n·p >= c`. Edges the clip creates
/// are CLOSED seams — see rule 2 above.
fn clip_half(poly: &[Vec2], open: &[bool], n: Vec2, c: f32) -> (Vec<Vec2>, Vec<bool>) {
    let np = poly.len();
    let (mut vs, mut fs) = (Vec::with_capacity(np + 2), Vec::with_capacity(np + 2));
    for i in 0..np {
        let (a, b) = (poly[i], poly[(i + 1) % np]);
        let (da, db) = (n.dot(a) - c, n.dot(b) - c);
        if da >= 0.0 {
            vs.push(a);
            fs.push(open[i]);
        }
        if (da >= 0.0) != (db >= 0.0) {
            vs.push(a + (b - a) * (da / (da - db)));
            // leaving the half-plane, the new edge runs ALONG the clip line
            fs.push(if da >= 0.0 { false } else { open[i] });
        }
    }
    (vs, fs)
}

/// One veneer plate minus a crater's patch RECT, as up to four pieces: below,
/// above, and the two flanks of the rect's own y-band. Each piece is the plate
/// intersected with a CONVEX region, so it is a simple polygon by construction,
/// and the four regions tile the rect's complement exactly.
pub(super) fn frag_minus_rect(f: &Frag, lo: Vec2, hi: Vec2) -> Vec<Frag> {
    let band = [(Vec2::Y, lo.y), (Vec2::NEG_Y, -hi.y)];
    let regions: [&[(Vec2, f32)]; 4] = [
        &[(Vec2::NEG_Y, -lo.y)],
        &[(Vec2::Y, hi.y)],
        &[(Vec2::NEG_X, -lo.x), band[0], band[1]],
        &[(Vec2::X, hi.x), band[0], band[1]],
    ];
    let mut out = Vec::with_capacity(4);
    for region in regions {
        let (mut poly, mut open) = (f.poly.clone(), f.open.clone());
        for (n, c) in region {
            (poly, open) = clip_half(&poly, &open, *n, *c);
            if poly.len() < 3 {
                break;
            }
        }
        if poly.len() < 3 || poly_area(&poly) < 1e-5 {
            continue;
        }
        // a piece the crater left with a closed seam may not sink (round 8: a
        // step along a closed seam is a sub-pixel edge that dot-dashes at best)
        let sink = if open.iter().all(|o| *o) { f.sink } else { 0.0 };
        out.push(Frag { poly, open, spalled: f.spalled, sink });
    }
    out
}

/// Every plate minus every crater's patch rect. The rects are pairwise disjoint
/// (`rebar` gives each crater its own y band), so this is a sequence of
/// independent exact operations.
pub(super) fn frags_minus_rects(frags: Vec<Frag>, rects: &[(Vec2, Vec2)]) -> Vec<Frag> {
    let mut out = frags;
    for (lo, hi) in rects {
        out = out.into_iter().flat_map(|f| frag_minus_rect(&f, *lo, *hi)).collect();
    }
    out
}

/// The same subtraction for an unflagged polygon — the CORE's front plane,
/// which is the plane the crater actually pierces.
pub(super) fn poly_minus_rects(poly: &[Vec2], rects: &[(Vec2, Vec2)]) -> Vec<Vec<Vec2>> {
    let f = Frag { poly: poly.to_vec(), open: vec![false; poly.len()], spalled: false, sink: 0.0 };
    frags_minus_rects(vec![f], rects).into_iter().map(|g| g.poly).collect()
}

/// Does this patch rect overlap any of `rects` (plus the standing-cover gap)?
/// Cover spall is emitted on BOTH faces of a wall, and the two sets must be
/// disjoint in (u, y): each side's basin may cut past the wall's half-thickness,
/// so two craters facing each other at the same spot would PERFORATE the slab —
/// exactly the leak `rebar::REAR` exists to prevent, arriving from the other
/// side. Disjointness is the whole guard, which is why it is a veto handed to
/// the site chooser rather than a filter applied afterwards.
pub(super) fn rect_hits(rects: &[(Vec2, Vec2)], lo: Vec2, hi: Vec2) -> bool {
    let g = rebar::PATCH_GAP;
    rects.iter().any(|(a, b)| lo.x < b.x + g && a.x < hi.x + g && lo.y < b.y + g && a.y < hi.y + g)
}

/// Point-to-segment distance (the fault-clip flag inheritance probe).
pub(super) fn seg_dist(p: Vec2, a: Vec2, b: Vec2) -> f32 {
    let ab = b - a;
    let t = if ab.length_squared() < 1e-12 { 0.0 } else { ((p - a).dot(ab) / ab.length_squared()).clamp(0.0, 1.0) };
    (p - (a + ab * t)).length()
}

/// One flush, un-cracked cover plate over a whole face rect — every seam
/// closed, so it renders as the slab it stands in for.
pub(super) fn flush_plate(lo: Vec2, hi: Vec2) -> Frag {
    let poly = vec![lo, Vec2::new(hi.x, lo.y), hi, Vec2::new(lo.x, hi.y)];
    Frag { poly, open: vec![false; 4], spalled: false, sink: 0.0 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crack_geom::craze::CrazeCfg;
    use crate::crack_geom::fixtures::*;

    /// The ONE deliberate coincident pair in the crater mesh, pinned flush.
    ///
    /// The collar's patch-rect wall (`emit_crater` quad 5) and the walls
    /// `emit_frags` grows on the plate pieces the rect was cut out of are the
    /// same surface with opposite normals — the shared boundary between two
    /// closed shells. Emitting one of them would be cleaner, but neither side can
    /// guarantee coverage alone (a missing plate leaves no plate wall; a groove
    /// along the rect leaves no collar). They are invisible ONLY while they stay
    /// exactly flush: give either a sink, a chamfer or a different droop and the
    /// pair becomes a per-ray coin flip along the whole rect — round 8's strobe
    /// class. So pin the two things that make them flush: a piece the rect clip
    /// touched may not sink, and its rect edge may not chamfer.
    #[test]
    fn a_plate_the_crater_clipped_stays_flush_with_the_collars_wall() {
        let cfg = CrazeCfg::new(3.0, &hot(0), true, 0.2, &[]);
        let plate = Frag {
            poly: vec![Vec2::new(0.0, 0.0), Vec2::new(1.0, 0.0), Vec2::new(1.0, 1.0), Vec2::new(0.0, 1.0)],
            open: vec![true; 4], // every edge cracked open: the case that WOULD sink and chamfer
            spalled: false,
            sink: cfg.sink_max(),
        };
        assert!(plate.sink > 0.0, "VACUOUS: the fixture must be a plate that does sink");
        let pieces = frag_minus_rect(&plate, Vec2::new(0.3, 0.3), Vec2::new(0.7, 0.7));
        assert!(pieces.len() >= 3, "the rect cuts the plate into pieces, got {}", pieces.len());
        for g in &pieces {
            assert_eq!(g.sink, 0.0, "a piece the crater clipped must lie flush with the collar's front ring");
            let touches = g.poly.iter().any(|p| (p.x - 0.3).abs() < 1e-5 || (p.x - 0.7).abs() < 1e-5 || (p.y - 0.3).abs() < 1e-5 || (p.y - 0.7).abs() < 1e-5);
            assert!(touches, "every piece borders the rect it was cut by");
            for (i, o) in g.open.iter().enumerate() {
                let (a, b) = (g.poly[i], g.poly[(i + 1) % g.poly.len()]);
                let on_rect = |v: Vec2| {
                    ((v.x - 0.3).abs() < 1e-5 || (v.x - 0.7).abs() < 1e-5) && (0.3 - 1e-5..=0.7 + 1e-5).contains(&v.y)
                        || ((v.y - 0.3).abs() < 1e-5 || (v.y - 0.7).abs() < 1e-5) && (0.3 - 1e-5..=0.7 + 1e-5).contains(&v.x)
                };
                if on_rect(a) && on_rect(b) {
                    assert!(!*o, "the rect edge must stay a CLOSED seam (an open one takes a chamfer and breaks the flush pair)");
                }
            }
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
}
