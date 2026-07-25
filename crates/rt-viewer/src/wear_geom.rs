//! The box→mesh PROMOTER and its first client, the EASED ARRIS (glaze ease).
//!
//! The look is PORCELAIN, and real glaze pools and rounds every arris — a
//! perfectly sharp one is the tell of cardboard. So every exposed vertical
//! corner and top edge of a static greybox box carries a narrow facet with its
//! own bisector normal: a third, in-between grey between the two faces it
//! joins. Nothing about the blocky read changes (the faces are still flat
//! slabs, the silhouette is still a hard pixel stair); the boxes just stop
//! being paper-thin cutouts.
//!
//! WHY A PROMOTER AND NOT A NEW PRIM: [`ease_box`] re-emits the box as ONE
//! primitive with ONE material (`Scene::new_material` + `add_mesh_world`), at
//! the same primitive index a plain box would have taken. Everything the gym
//! keys by prim index or by "this box owns its material 1:1" therefore keeps
//! working untouched — the occluder / glass / matte marks, the crack-lab knob
//! bits and selection highlight, the wear effect word, the smash rig's TLAS
//! hide and the roof-tear's `roof_prims` range. Appending the mesh as a SECOND
//! prim and collapsing the box (the `crack_geom` idiom) would have quietly
//! broken the last two: they hide `pier.prim`, and the visible geometry would
//! no longer be there.
//!
//! WHICH ARRISES: the caller declares, per box, which of the four side faces
//! are EXPOSED ([`Ease::side`], profile order −Z, +X, +Z, −X). A vertical
//! arris is cut only where BOTH its faces are exposed, and a top arris only on
//! an exposed face. This is what keeps the pass off the 2026-07-12 coplanar
//! class: the building's corners are two overlapping wall slabs sharing a
//! 0.2 × 0.2 column and the roof cap is one box per Room ROW, so cutting an
//! arris that is buried inside a neighbour would either do nothing (the
//! neighbour fills the facet) or, at a shared outside corner, emit two
//! coincident 45° facets that ray-z-fight. `gym_scene` owns that
//! classification because it is the only place that knows which runs meet.
//!
//! ALL FOUR vertical arrises are candidates, not just the two the boot camera
//! sees: the owner turns the camera with q/e (`yaw_q` 0..3), and a chamfer
//! that vanishes on rotation is worse than none.
//!
//! SIZE IS AUTHORED IN SCREEN PIXELS ([`ARRIS_PX`], [`TOP_PX`]) and converted
//! to world units through the game projection's own axis images
//! ([`sizes`]) — the facet's whole job is to be a legible BAND at
//! 704×464, so a world constant would be the wrong invariant. Being an AREA
//! feature with a constant screen width (an orthographic camera cannot
//! foreshorten it), it needs no contour AA and deliberately does not take
//! `AA_BIT`: the greybox keeps its 3.5 ms baseline.
//!
//! Static boxes only. The player's limbs are dynamic runs authored in pivot
//! space (they rotate — the facet's screen width would not be constant), the
//! lamp fixture is a dynamic run too, and a grass tuft is 0.2 × 0.15 × 0.09 wu
//! (a 3-px facet would be most of it).

use crate::crack_geom::{quad, triangulate};
use glam::{Vec2, Vec3};
use rt_probe::Scene;

/// A world-space triangle soup as `add_mesh_world` takes it: (position,
/// normal) vertices plus local indices.
type Soup = (Vec<([f32; 3], [f32; 3])>, Vec<u32>);

/// The vertical arris facet's SCREEN width, in game pixels, on the corner
/// facing the camera. 3 px is the calibration: 2 px is the floor at which a
/// band reads as its own tone rather than as an anti-aliased edge (the same
/// floor the crack grooves hit — see `crack_geom::px_floor`), and the wall
/// slab's own 0.2-wu thickness caps it just above 3 px (two facets may not eat
/// more than half a face; see [`Ease::fit`]). So on this level the readability
/// floor and the geometric ceiling agree to within 1.5 % — there is no room to
/// argue about the number.
pub const ARRIS_PX: f32 = 3.0;

/// The top-arris ease, in game pixels. Smaller than [`ARRIS_PX`] on purpose: a
/// wall's top FACE is only 0.2 wu = 5.7 px across on a Z-run, so two 3-px
/// facets would leave nothing flat between them and the wall top would read as
/// a ridge instead of a slab with eased edges.
pub const TOP_PX: f32 = 2.4;

/// Screen-space work happens on the GAME projection (CLAUDE.md: `trimetric` is
/// THE game projection, `iso21` the A/B reference the owner can switch to).
/// Geometry is built once at scene build, so it cannot follow a live
/// projection switch — same rule `crack_geom::px_floor` already runs on.
fn game_proj() -> iso_core::Projection {
    iso_core::by_name("trimetric").expect("the game projection preset")
}

/// The two chamfer sizes in WORLD units for a dial value (1 = the authored
/// [`ARRIS_PX`] / [`TOP_PX`]), derived from the projection's authored axis
/// images rather than hardcoded:
///
/// - a VERTICAL arris facet spans +c along one ground axis and −c along the
///   other, so the corner facing the camera projects to `c·|px_x − px_z|`
///   (trimetric: 60.8 px/wu — and this is the FACING corner at every one of
///   the four camera quarters, because the projection rotates with the
///   camera);
/// - a TOP arris facet spans −t along a ground axis and +t along Y, so it
///   projects to `t·|py − px_x|` on an X-facing wall and `t·|py − px_z|` on a
///   Z-facing one (63.0 and 62.0 px/wu). The narrower one sets the size, so
///   BOTH read at least [`TOP_PX`].
pub fn sizes(dial: f32) -> (f32, f32) {
    let p = game_proj();
    let (px, pz) = (Vec2::new(p.px_x[0] as f32, p.px_x[1] as f32), Vec2::new(p.px_z[0] as f32, p.px_z[1] as f32));
    let (_, _, up) = p.basis(0.0);
    let py = Vec2::new(0.0, -p.s * up.y); // world +Y's screen image (x right, y down)
    let vert = (px - pz).length();
    let top = (py - px).length().min((py - pz).length());
    (dial.max(0.0) * ARRIS_PX / vert, dial.max(0.0) * TOP_PX / top)
}

/// Which arrises of one axis-aligned box are cut, and by how much.
///
/// `side` is the caller's causal EXPOSURE classification in profile order:
/// 0 = −Z, 1 = +X, 2 = +Z, 3 = −X. A face that is buried inside a neighbouring
/// slab declares `false` and everything on it stays sharp.
#[derive(Clone, Copy, Debug)]
pub struct Ease {
    pub side: [bool; 4],
    /// Vertical arris chamfer (wu). A corner is cut iff both its faces are
    /// exposed and this is > 0.
    pub c: f32,
    /// Top arris ease (wu), applied on every exposed face.
    pub t: f32,
}

impl Ease {
    /// Clamp the chamfers to what this box can afford: two facets may never
    /// eat more than HALF of any extent they meet, or the flat face between
    /// them disappears and the box reads as a bevelled stick rather than a
    /// slab with eased edges. On the gym's 0.2-wu wall slabs this binds at
    /// c ≤ 0.05 wu, which is the 3-px calibration almost exactly.
    pub fn fit(mut self, min: Vec3, max: Vec3) -> Ease {
        let d = max - min;
        let flat = 0.25 * d.x.min(d.z);
        self.c = self.c.min(flat);
        self.t = self.t.min(flat).min(0.25 * d.y);
        self
    }

    /// Is a vertical arris cut at corner `k` (between side k−1 and side k)?
    fn cut(&self, k: usize) -> bool {
        self.c > 1e-5 && self.side[(k + 3) % 4] && self.side[k]
    }

    /// Nothing to cut — the caller must emit a plain box, which is what keeps
    /// the dial's zero BYTE-identical to a build without this pass.
    fn is_sharp(&self) -> bool {
        (0..4).all(|k| !self.cut(k)) && (self.t <= 1e-5 || !self.side.iter().any(|s| *s))
    }
}

/// Which polygon edge of the horizontal profile this is: one of the box's four
/// original side faces, or the 45° facet that replaced a corner.
#[derive(Clone, Copy)]
enum Edge {
    Side(usize),
    Facet(usize),
}

/// Emit `[min, max]` as a static prim with its exposed arrises eased, and
/// return the primitive index (the same index a plain box would have taken).
/// `Ease::is_sharp` falls back to `add_box_world`, so a zeroed dial reproduces
/// the pre-pass scene exactly — the A/B this effect is judged on.
pub fn ease_box(scene: &mut Scene, min: Vec3, max: Vec3, color: [f32; 4], roughness: f32, e: Ease) -> usize {
    let e = e.fit(min, max);
    let prim = scene.primitives.len();
    if e.is_sharp() {
        scene.add_box_world(min, max, color, [0.0; 4], roughness, 0.0);
        return prim;
    }
    let mid = scene.new_material(color, [0.0; 4], roughness, 0.0);
    let (verts, idx) = mesh(min, max, &e);
    scene.add_mesh_world(&verts, &idx, mid);
    prim
}

/// The eased box as one closed triangle soup, in world space.
///
/// Built as a PROFILE EXTRUSION so validity is structural rather than checked:
/// the horizontal profile is the box's rect with its cut corners replaced by a
/// chord, and the top ease is the same profile INSET (each eased edge's line
/// moved in by `t`, each sharp edge's line left where it is) with a 45° band of
/// quads between the two. The band's quads are planar by construction — a
/// straight edge offset inward by a constant sweeps a plane — and consecutive
/// bands share their end edge exactly, so the mitre at each corner closes with
/// no gap.
///
/// The one thing worth reading twice: an eased edge's wedge also bites the
/// corner off its SHARP neighbour's face (the wedge is a half-space, it does
/// not stop at the corner). So a sharp face is emitted as one 4-to-6-sided
/// polygon with those bites already taken, not as a rectangle plus a patch —
/// which is what makes the whole mesh edge-manifold, with no T-vertices
/// anywhere for a ray to slip through.
fn mesh(min: Vec3, max: Vec3, e: &Ease) -> Soup {
    let (y0, y1) = (min.y, max.y);
    let corner = [Vec2::new(min.x, min.z), Vec2::new(max.x, min.z), Vec2::new(max.x, max.z), Vec2::new(min.x, max.z)];
    // outward normals of the four side faces, in profile order
    let nrm = [Vec2::new(0.0, -1.0), Vec2::new(1.0, 0.0), Vec2::new(0.0, 1.0), Vec2::new(-1.0, 0.0)];
    let dir = |s: usize| (corner[(s + 1) % 4] - corner[s]).normalize();

    // ---- profile: vertices in order + the edge LEAVING each of them
    let mut pts: Vec<Vec2> = Vec::with_capacity(8);
    let mut edge: Vec<Edge> = Vec::with_capacity(8);
    for (k, c) in corner.iter().enumerate() {
        if e.cut(k) {
            pts.push(*c - dir((k + 3) % 4) * e.c);
            edge.push(Edge::Facet(k));
            pts.push(*c + dir(k) * e.c);
            edge.push(Edge::Side(k));
        } else {
            pts.push(*c);
            edge.push(Edge::Side(k));
        }
    }
    let n = pts.len();
    let enrm: Vec<Vec2> = edge
        .iter()
        .map(|k| match k {
            Edge::Side(s) => nrm[*s],
            Edge::Facet(k) => (nrm[(*k + 3) % 4] + nrm[*k]).normalize(),
        })
        .collect();
    let eased: Vec<bool> = edge
        .iter()
        .map(|k| {
            e.t > 1e-5
                && match k {
                    Edge::Side(s) => e.side[*s],
                    Edge::Facet(k) => e.side[(*k + 3) % 4] && e.side[*k],
                }
        })
        .collect();

    // ---- the top ease's inset profile: each vertex is where its two
    // neighbouring edge lines land after being pushed in by their own offset
    // (0 on a face that keeps its sharp top). Consecutive edges of a convex
    // profile are never parallel, so the intersection always exists.
    let inset: Vec<Vec2> = (0..n)
        .map(|i| {
            let (a, b) = ((i + n - 1) % n, i);
            let (na, nb) = (enrm[a], enrm[b]);
            let (da, db) = (na.dot(pts[i]) - if eased[a] { e.t } else { 0.0 }, nb.dot(pts[i]) - if eased[b] { e.t } else { 0.0 });
            let det = na.x * nb.y - na.y * nb.x;
            Vec2::new((da * nb.y - db * na.y) / det, (na.x * db - nb.x * da) / det)
        })
        .collect();

    let (mut verts, mut idx) = (Vec::new(), Vec::new());
    let w = |p: Vec2, y: f32| [p.x, y, p.y];
    let yb = y1 - e.t; // the height every ease starts at
    for i in 0..n {
        let j = (i + 1) % n;
        let (a, b) = (pts[i], pts[j]);
        if (b - a).length() < 1e-6 {
            // Unreachable for any non-degenerate box: `fit` caps each chamfer at
            // a QUARTER of the smallest horizontal extent, so two of them can
            // take at most half of the shortest side. Dropping a face would
            // open the box, so if a caller ever manages it, say so in debug.
            debug_assert!(false, "eased box {min:?}..{max:?} has a side its chamfers consumed");
            continue;
        }
        let nh = [enrm[i].x, 0.0, enrm[i].y];
        if eased[i] {
            quad(&mut verts, &mut idx, [w(a, y0), w(b, y0), w(b, yb), w(a, yb)], nh);
            // the 45° band: face normal + up, which is what gives the facet its
            // own tone between the two faces it joins
            let nb = (Vec3::new(enrm[i].x, 0.0, enrm[i].y) + Vec3::Y).normalize().to_array();
            quad(&mut verts, &mut idx, [w(a, yb), w(b, yb), w(inset[j], y1), w(inset[i], y1)], nb);
        } else {
            // a sharp face, with the neighbouring wedges' bites taken out of
            // its top corners (`inset` already sits on THIS face's line there)
            let mut poly = vec![w(a, y0), w(b, y0)];
            if eased[j] {
                poly.push(w(b, yb));
                poly.push(w(inset[j], y1));
            } else {
                poly.push(w(b, y1));
            }
            if eased[(i + n - 1) % n] {
                poly.push(w(inset[i], y1));
                poly.push(w(a, yb));
            } else {
                poly.push(w(a, y1));
            }
            let vi = verts.len() as u32;
            for p in &poly {
                verts.push((*p, nh));
            }
            for k in 1..poly.len() as u32 - 1 {
                idx.extend_from_slice(&[vi, vi + k, vi + k + 1]); // convex: a fan is exact
            }
        }
    }
    // ---- caps: the inset profile on top, the raw profile underneath
    for (poly, y, nrm) in [(&inset, y1, [0.0, 1.0, 0.0]), (&pts, y0, [0.0, -1.0, 0.0])] {
        let base = verts.len() as u32;
        for p in poly.iter() {
            verts.push((w(*p, y), nrm));
        }
        for t in triangulate(poly) {
            idx.extend_from_slice(&[base + t[0], base + t[1], base + t[2]]);
        }
    }
    (verts, idx)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// All four faces exposed — a free-standing box (a garden wall's pier away
    /// from any junction, the whole roof of a one-row building).
    fn all(c: f32, t: f32) -> Ease {
        Ease { side: [true; 4], c, t }
    }

    /// THE CALIBRATION, pinned against the projection it is derived from: at
    /// dial 1 the facing vertical facet is [`ARRIS_PX`] and the narrower top
    /// facet [`TOP_PX`] — and the wall slab's own thickness caps the vertical
    /// one within 2 %, which is why there is no bigger "jamb" class.
    #[test]
    fn the_chamfer_is_authored_in_screen_pixels_and_the_wall_slab_caps_it() {
        let (c, t) = sizes(1.0);
        let p = game_proj();
        let (px, pz) = (Vec2::new(p.px_x[0] as f32, p.px_x[1] as f32), Vec2::new(p.px_z[0] as f32, p.px_z[1] as f32));
        let (_, _, up) = p.basis(0.0);
        let py = Vec2::new(0.0, -p.s * up.y);
        assert!(((px - pz).length() * c - ARRIS_PX).abs() < 1e-3, "facing vertical facet: {} px", (px - pz).length() * c);
        for f in [(py - px).length(), (py - pz).length()] {
            assert!(f * t >= TOP_PX - 1e-3, "top facet {} px must clear the floor on BOTH wall orientations", f * t);
        }
        // the 0.2-wu wall slab's ceiling (two facets ≤ half the thickness)
        let fit = all(c, t).fit(Vec3::ZERO, Vec3::new(0.2, 2.1875, 4.0));
        assert!((fit.c - c).abs() < 0.002, "the 3-px calibration must fit a wall slab (c {c} vs cap {})", fit.c);
        assert!(sizes(0.0) == (0.0, 0.0), "the dial's zero is zero");
        // …and a dial past 1 is what the cap is there for
        assert!(all(sizes(2.0).0, t).fit(Vec3::ZERO, Vec3::new(0.2, 2.1875, 4.0)).c < sizes(2.0).0);
    }

    /// Every triangle edge is shared by exactly two triangles: the eased box is
    /// a CLOSED surface, whatever mix of exposed faces it was handed. An open
    /// edge is a hole into the box's hollow interior — the failure round 8 spent
    /// three layers chasing (docs/AGENT_LEARNINGS.md) — and it would show as a
    /// black hole or a sky-lit slit along an arris.
    #[test]
    fn every_mix_of_exposed_faces_yields_a_closed_surface() {
        let (c, t) = sizes(1.0);
        let (min, max) = (Vec3::new(2.9, 0.0, 3.0), Vec3::new(3.1, 2.1875, 4.4));
        let mut sharp = 0;
        for m in 0..16u32 {
            let e = Ease { side: [m & 1 != 0, m & 2 != 0, m & 4 != 0, m & 8 != 0], c, t }.fit(min, max);
            if e.is_sharp() {
                sharp += 1;
                continue;
            }
            let (verts, idx) = mesh(min, max, &e);
            let mut count = std::collections::HashMap::new();
            for tri in idx.chunks(3) {
                for k in 0..3 {
                    // quantize: the mitre points are computed, not tabulated
                    let key = |i: usize| {
                        let p = verts[tri[i] as usize].0;
                        [(p[0] * 4096.0).round() as i64, (p[1] * 4096.0).round() as i64, (p[2] * 4096.0).round() as i64]
                    };
                    let (a, b) = (key(k), key((k + 1) % 3));
                    let e = if a < b { (a, b) } else { (b, a) };
                    *count.entry(e).or_insert(0) += 1;
                }
            }
            let open: Vec<_> = count.iter().filter(|(_, n)| **n != 2).collect();
            assert!(open.is_empty(), "mask {m:b}: {} open edges — the box leaks", open.len());
            // and it stays inside the box it replaced (nothing pokes out)
            for (p, _) in &verts {
                assert!(Vec3::from(*p).cmpge(min - 1e-4).all() && Vec3::from(*p).cmple(max + 1e-4).all(), "mask {m:b}: vertex {p:?} outside the box");
            }
        }
        assert_eq!(sharp, 1, "only the all-buried box has nothing to cut (it must fall back to a plain box)");
    }

    /// The facet is a THIRD TONE, not a rounding: its normal is the exact
    /// bisector of the two faces it joins, so under one directional key it
    /// lands between them by construction. Also pins that the top band's
    /// normal tilts UP (a facet that faced down would read as a shadow line).
    #[test]
    fn a_facet_carries_the_bisector_normal_of_the_two_faces_it_joins() {
        let (c, t) = sizes(1.0);
        let (min, max) = (Vec3::new(0.0, 0.0, 0.0), Vec3::new(1.0, 1.0, 1.0));
        let (verts, _) = mesh(min, max, &all(c, t));
        let has = |n: [f32; 3]| verts.iter().any(|(_, m)| (Vec3::from(*m) - Vec3::from(n)).length() < 1e-4);
        let d = std::f32::consts::FRAC_1_SQRT_2;
        for s in [[d, 0.0, d], [d, 0.0, -d], [-d, 0.0, d], [-d, 0.0, -d]] {
            assert!(has(s), "vertical facet {s:?} missing");
        }
        for s in [[d, d, 0.0], [-d, d, 0.0], [0.0, d, d], [0.0, d, -d]] {
            assert!(has(s), "top facet {s:?} missing");
        }
        assert!(verts.iter().all(|(_, n)| n[1] >= -1e-4 || (n[1] + 1.0).abs() < 1e-4), "no facet may face downward");
    }

    /// The promoter keeps the box's IDENTITY: one prim at the index a plain box
    /// would have taken, one material of its own. Everything the gym marks per
    /// box (occluder / glass / matte bits, crack knobs) and everything that
    /// hides a box by prim index (the smash rig, the roof tear) depends on it.
    #[test]
    fn an_eased_box_is_one_prim_with_its_own_material_like_a_plain_box() {
        let (c, t) = sizes(1.0);
        let mut a = Scene::default();
        a.add_box_world(Vec3::ZERO, Vec3::ONE, [1.0, 1.0, 1.0, 1.0], [0.0; 4], 0.85, 0.0);
        let plain = (a.primitives.len(), a.materials.len());
        let mut b = Scene::default();
        let prim = ease_box(&mut b, Vec3::ZERO, Vec3::ONE, [1.0, 1.0, 1.0, 1.0], 0.85, all(c, t));
        assert_eq!((b.primitives.len(), b.materials.len()), plain, "an eased box costs exactly one prim and one material");
        assert_eq!(prim, 0);
        assert_eq!(b.primitives[prim].material_id, 0);
        assert!(b.primitives[prim].index_count > a.primitives[0].index_count, "…and it really is a facetted mesh");
        // the OFF path is the plain box, vertex for vertex: this is what makes
        // `arris 0` a byte-identical A/B rather than an approximation
        let mut z = Scene::default();
        ease_box(&mut z, Vec3::ZERO, Vec3::ONE, [1.0, 1.0, 1.0, 1.0], 0.85, all(0.0, 0.0));
        assert_eq!(z.vertices.len(), a.vertices.len());
        assert!(z.vertices.iter().zip(&a.vertices).all(|(p, q)| p.pos == q.pos && p.nrm == q.nrm), "dial 0 must be the plain box");
    }
}
