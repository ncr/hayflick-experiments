//! THE SCENE-EMITTING HALF — the only part of `crack_geom` that may name a
//! `Scene` or a `Material`.
//!
//! Everything above it hands this module polygons; this module turns them into
//! prims. The veneer's plates ([`emit_frags`]), a cover spall's crater
//! ([`emit_crater`]), a structural piece ([`emit_prism`]), the three materials
//! damage mints (chalk core, basin body, corroded steel), and the two pier
//! treatments the public entry dispatches to — [`craze_pier`] for a wall that
//! only crazes, [`split_pier`] for one a break carved.
//!
//! It also owns where a crater LANDS ([`allocate_craters`]), because the
//! ordering that keeps two faces from perforating each other is the same
//! ordering both treatments have to run.

use crate::gym_scene::Pier;
use glam::{Vec2, Vec3};
use rt_probe::Scene;
use std::cell::Cell as StdCell;
use super::breaks::{fault_bolts, Fault};
use super::craze::{policy_frags, CrazeCfg};
use super::cut::{carve, cut_clip, piece_clip_flags, rect_inside, split_frags, Bolt, CutLike};
use super::poly::{flush_plate, frags_minus_rects, poly_area, poly_minus_rects, rect_hits, triangulate, Frag};
use super::{mat_of, story_of, Frame, CRAZE_BIT, GEO_BIT};
use wear_core::rebar;

/// `crack::SEL_BIT` as i32 (the core never carries the selection highlight).
const SEL_BIT_I: i32 = crate::crack::SEL_BIT;

// ---- mesh building ---------------------------------------------------------

/// Push one flat quad (two tris, `add_box` index pattern) with an explicit
/// flat normal (hit normals interpolate vertex attributes, winding is free).
pub(crate) fn quad(verts: &mut Vec<([f32; 3], [f32; 3])>, idx: &mut Vec<u32>, q: [[f32; 3]; 4], n: [f32; 3]) {
    let vi = verts.len() as u32;
    for p in q {
        verts.push((p, n));
    }
    idx.extend_from_slice(&[vi, vi + 1, vi + 2, vi, vi + 2, vi + 3]);
}

/// A mesh under construction: `crack_geom` emits three per pier (cover, core,
/// bars), and passing two vectors per mesh through the crater emitter is how
/// the argument list gets out of hand.
#[derive(Default)]
struct Mesh {
    v: Vec<([f32; 3], [f32; 3])>,
    i: Vec<u32>,
}

impl Mesh {
    fn quad(&mut self, q: [[f32; 3]; 4], n: [f32; 3]) {
        quad(&mut self.v, &mut self.i, q, n);
    }
    fn is_empty(&self) -> bool {
        self.i.is_empty()
    }
    /// One axis-aligned box in WORLD coordinates, all six faces. A closed prism
    /// on purpose: an open one lets rays in and shows its own far side from
    /// inside (round 8).
    ///
    /// World, not face, coordinates — the caller maps its two corners through
    /// `Frame::w` and hands over the world AABB. The first cut took FACE corners
    /// and pushed them straight into `quad`, so every Z-run pier (`w(u,y,t) =
    /// [t,y,u]`, 7 of the gym's 15) got its rebar transposed across the diagonal:
    /// a rust cross floating in the doorway and a bar lying in the lawn, in the
    /// crack lab's DEFAULT boot state. The AABB form also sidesteps the winding
    /// flip the depth axis introduces (`d()` inverts it when `nz = +1`).
    fn world_box(&mut self, lo: [f32; 3], hi: [f32; 3]) {
        let (a, b) = (lo, hi);
        self.quad([[a[0], a[1], b[2]], [b[0], a[1], b[2]], [b[0], b[1], b[2]], [a[0], b[1], b[2]]], [0.0, 0.0, 1.0]);
        self.quad([[a[0], a[1], a[2]], [a[0], b[1], a[2]], [b[0], b[1], a[2]], [b[0], a[1], a[2]]], [0.0, 0.0, -1.0]);
        self.quad([[a[0], b[1], a[2]], [a[0], b[1], b[2]], [b[0], b[1], b[2]], [b[0], b[1], a[2]]], [0.0, 1.0, 0.0]);
        self.quad([[a[0], a[1], a[2]], [b[0], a[1], a[2]], [b[0], a[1], b[2]], [a[0], a[1], b[2]]], [0.0, -1.0, 0.0]);
        self.quad([[b[0], a[1], a[2]], [b[0], b[1], a[2]], [b[0], b[1], b[2]], [b[0], a[1], b[2]]], [1.0, 0.0, 0.0]);
        self.quad([[a[0], a[1], a[2]], [a[0], a[1], b[2]], [a[0], b[1], b[2]], [a[0], b[1], a[2]]], [-1.0, 0.0, 0.0]);
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

// ---- cover spall: the crater mesh and the veneer subtraction ---------------
//
// The crater is a lens-shaped loss through the VENEER and into the CORE, with
// the bar it exposed still crossing it. Two rules keep the mesh out of round
// 8's coincident-seam class (docs/AGENT_LEARNINGS.md), and both are structural
// rather than tolerance-based:
//
// 1. The veneer is cut back to the crater's PATCH RECT, never to the lens. A
//    rect is four half-planes, so "plate minus rect" is four exact convex
//    clips ([`frag_minus_rect`]); subtracting the concave lens would be a real
//    polygon boolean, and a near-miss boolean is precisely what drew round 8's
//    invisible extensions. The cover between the rect and the lens survives as
//    the crater's COLLAR, so the only boundary you ever SEE is the lens.
// 2. Every seam the subtraction creates is CLOSED (flush cover joints), so
//    nothing keyed to "this edge is cracked" — the chamfer, the sink step —
//    fires on it, and the pieces' drooped walls stay coincident with the
//    collar's outer wall.

/// A cavity must read DARK at every orientation, and the one surface that fights
/// that is a near-horizontal lip facing UP: it takes full sky exactly where the
/// hole should be deepest, and the feature dashes out. So tilt such a lip's
/// normal DOWN. That lie is round 4's droop rule in normal form; it lived inline
/// in [`emit_prism`] until the spall basin needed the identical treatment on its
/// own rim, and one definition is the point (the two drifting apart would give a
/// crater a bright bottom arc and a fault a dark one).
///
/// `nn` is the lip's true in-face outward normal, `e` its edge direction.
fn lip_tilt(nn: Vec2, e: Vec2) -> Vec2 {
    let mut nn = nn;
    if nn.y > 0.0 && e.x.abs() > 0.55 {
        nn.y *= -0.5;
    }
    nn
}

/// Collapse ONE face of a freshly added box prim (degenerate tris are never
/// hit), so a mesh with a hole in it can take that face's place. Found by
/// NORMAL rather than by index: `add_box`'s face order is an implementation
/// detail of `rt_probe::Scene` and this pass should not depend on it.
fn collapse_face(scene: &mut Scene, prim: usize, nrm: [f32; 3]) {
    let pr = scene.primitives[prim];
    for f in 0..(pr.vertex_count as usize / 4) {
        let o = pr.vertex_offset as usize + f * 4;
        if scene.vertices[o].nrm == nrm {
            let c = scene.vertices[o].pos;
            for v in &mut scene.vertices[o..o + 4] {
                v.pos = c;
            }
            return;
        }
    }
    unreachable!("a box prim has a face for every axis direction");
}

/// The ONE warm tint this look allows (owner catalogue 2026-07-25): exposed,
/// corroded steel. Ochre on white porcelain is the family's known failure mode,
/// so the tint is confined to the bar — the basin floor stays the pale
/// fresh-break body ([`fresh_body`]) and the collar stays glaze.
///
/// MEASURED, not chosen. The first value shipped here was a mid ochre
/// (0xa5623a, linear luma 0.16) and it failed exactly as the catalogue's cut
/// list predicted: polana's post stack runs `sat = 1.42`, so at 3 px wide
/// against a 0.94-luma wall the bar read as a stripe of orange PAINT and
/// dominated the frame. This is the same hue two stops down — linear luma 0.05,
/// i.e. 5 % of the wall — so the bar reads as a dark solid whose HUE is warm,
/// which is what steel in a shaded cavity looks like. The saturation stays
/// (rust IS chromatic and it is the only chromatic thing on the wall); only the
/// value came down.
const RUST_HEX: u32 = 0x54321f;

/// Mint the pier's exposed-steel material. Deliberately NOT a clone of the
/// chalk core: the knob bits must be ZERO so the shade pass's CRACK LAB paint
/// block (`(pad >> 8) != 0`) never fires on steel, and MATTE + zero knobs keeps
/// `matte_plus_knobs_is_only_the_chalk_core` — the fresh-break discriminator —
/// true. Emissive stays 0 (any emission would mint an NEE light and kill the
/// greybox wear gate); the occluder bit is inherited, or the bars would hang in
/// mid-air the moment the WALLCUT dissolves their wall.
fn rust_material(scene: &mut Scene, mid: i32) -> i32 {
    let body = scene.materials[mid as usize];
    let mut steel = body;
    let c = rt_probe::hex_linear(RUST_HEX);
    steel.base_color = [c[0], c[1], c[2], body.base_color[3]]; // alpha = the facade story key
    steel.roughness = 0.95;
    steel.metallic = 0.0; // ≥ 0.2 and the shade pass's REFL block starts mirroring on it
    steel.emissive = [0.0; 4];
    steel._pad = (body._pad & crate::flags::OCCLUDER) | crate::flags::MATTE;
    scene.materials.push(steel);
    scene.materials.len() as i32 - 1
}

/// How much of the sky a spall's interior actually keeps — the cavity's baked
/// ambient occlusion, and the one number in this effect that is a deliberate
/// exaggeration rather than a measurement.
///
/// State the honest version first: a crater on a 0.2-wu wall is ~15 px wide and
/// ~2 px deep, so its real sky visibility is about 0.95. Traced faithfully it
/// darkens by 5 %, which the tonemap's luma quantize eats whole, and MEASURED
/// that way the crater came out at 94 % of the wall's tone — a pale scuff, not a
/// hole. The two mechanisms that would darken it honestly both miss at this
/// scale: the probe grid is 0.5 wu, so the baked GI cannot see the pocket at all
/// and hands its floor the open wall's sky, and the cavity is far too shallow for
/// the shade pass's contact-grime radius to bite.
///
/// So the occlusion is AUTHORED into the basin's albedo — the same class of lie
/// as round 4's drooped lip normal, and deliberately chosen over that lie's
/// hue-free cousin: the first cut bought its darkness by tilting the floor's
/// NORMAL 45° down, which aimed it at the lawn and produced a moss-green crater
/// floor (#717e64, G+13 where the wall is −0.3) under polana's sat = 1.42.
/// Albedo costs no hue, and it is the only lever with any authority here: the
/// tonemap compresses hard, so a 0.45 albedo ratio only moved the interior to
/// 82 % of the wall's tone. 0.34 measures at ~76 % —
/// dark enough to read as a cavity at 15 px, light enough that it still reads as
/// the pale, unstained fresh break the 2026-07-25 step established.
const BASIN_AO: f32 = 0.34;

/// Mint the crater's INTERIOR body — the shelf the lost cover sat on, the basin
/// walls and its floor. A fresh break like the chalk core, and dimmed by
/// [`BASIN_AO`] because it is a fresh break inside a hole.
///
/// Knob bits ZERO, deliberately: the shade pass's CRACK LAB paint block gates on
/// `(pad >> 8) != 0`, so a crater interior takes no stains, no fine web and no
/// crack paint — which IS the fresh-break suppression, bought here for free
/// instead of through the matte discriminator. It also keeps
/// `matte_plus_knobs_is_only_the_chalk_core` true, whose own doc names
/// "rust-stained basin chalk" as the generator that would break it.
fn basin_material(scene: &mut Scene, core_mid: i32) -> i32 {
    let core = scene.materials[core_mid as usize];
    let mut b = core;
    for c in b.base_color.iter_mut().take(3) {
        *c *= BASIN_AO;
    }
    b.roughness = 1.0;
    b.metallic = 0.0;
    b.emissive = [0.0; 4];
    b._pad = (core._pad & crate::flags::OCCLUDER) | crate::flags::MATTE; // occluder inherited, MATTE, no knobs
    scene.materials.push(b);
    scene.materials.len() as i32 - 1
}

/// How far the CORE's opening stands outside the cover's, measured radially in
/// the face plane. This is the UNDERCUT: the surviving cover overhangs the void
/// by this much all round, so the crater's top arc is a lip with a real shadow
/// under it and the cavity cannot read as a sky-lit dish. 0.04 wu is 1.6 px on
/// an X-run face and 1.1 px on a Z-run one — the one sub-2-px feature in this
/// effect, which is why the pier (and its core) declare THIN to the contour AA.
/// Clamped per ray to half the rim→rect gap so the core's opening always stays
/// strictly inside the patch rect, whatever the rim's radial noise did.
const UNDERCUT: f32 = 0.04;

/// Emit one cover spall: the surviving COLLAR of cover (pier material, into
/// `cov`), the BASIN it opens into (chalk core, into `bas`) and the bar segments
/// the loss exposed (steel, into `bar`).
///
/// Depths are measured inward from the face plane, exactly as `emit_frags`
/// measures them, and the surface is CLOSED — which is the whole reason this is
/// written as one ring of quads per crater rather than as a boolean. Every ring
/// is sampled on the SAME rays out of `cr.c` (`rebar::outline` guarantees that
/// and guarantees the ordering `rim ≤ hole ≤ ring`), so each band between two
/// rings is a valid quad by construction:
///
/// | ring | depth | what it is |
/// |---|---|---|
/// | `ins` → `ring` | 0 | the surviving cover's front face (the COLLAR) |
/// | `ins` → `rim` | 0 → `cham_d` | the chamfered lip (owner round 7) |
/// | `rim` → `hole` | `cham_d` → `t` | the UNDERCUT: the cover overhanging the void |
/// | `hole` → `ring` | `t` | the SHELF the lost cover sat on |
/// | `ring` | 0 → `t` | the patch rect's wall |
/// | `hole` → `hole` | `t` → `floor` | the basin wall (chalk) |
/// | `hole` | `floor` | the basin floor (chalk) |
///
/// The shelf is the row the first cut was missing, and it was a real hole: with
/// the core's front plane cut back to the RECT but the basin opening at the RIM,
/// the annulus between them was open into the core box's hollow interior.
#[allow(clippy::too_many_arguments)]
fn emit_crater(
    cr: &rebar::Crater,
    cfg: &CrazeCfg,
    t_face: f32,
    nz: f32,
    w: &dyn Fn(f32, f32, f32) -> [f32; 3],
    wn: &dyn Fn(f32, f32, f32) -> [f32; 3],
    rect: (Vec2, Vec2),
    cov: &mut Mesh,
    bas: &mut Mesh,
    bar: &mut Mesh,
) {
    let n = cr.rim.len();
    let d = |depth: f32| t_face - nz * depth;
    let droop = 0.8 * cfg.t;
    let (cw, cd) = (cfg.cham_w(), cfg.cham_d());
    // Same discipline as `emit_frags`: every emitted (u, y) is clamped into the
    // pier's face rect, because NOTHING may leave the pier box (scene bounds and
    // the probe grid must not move, and `ProbeRefresh::Local` re-bakes only this
    // pier's AABB). A crater riding a settlement-dropped structural piece is the
    // case that needs it — `Crater::clone_dropped` shifts it down with the piece,
    // and the piece's own polygon is clamped the same way in `split_pier`.
    let cl = |p: Vec2| p.clamp(rect.0, rect.1);
    let y_floor = rect.0.y;
    // Two rings pushed OUT of the rim along its own rays, each clamped to a
    // fraction of the rim→rect gap so both stay strictly inside the patch rect
    // however the rim's radial noise fell: the chamfer's inset (the plate cedes
    // the strip, the opening keeps its width — owner round 7) and the core's
    // opening (the undercut).
    let (rim, ring): (Vec<Vec2>, Vec<Vec2>) = (cr.rim.iter().map(|p| cl(*p)).collect(), cr.ring.iter().map(|p| cl(*p)).collect());
    let out_ring = |dist: f32, cap: f32| -> Vec<Vec2> {
        (0..n)
            .map(|k| {
                let m = ring[k] - rim[k];
                cl(rim[k] + m * (dist / m.length().max(1e-6)).min(cap))
            })
            .collect()
    };
    let ins = out_ring(cw, 0.45);
    let hole = out_ring(UNDERCUT, 0.5);
    // the collar's rect wall drops as it goes back, exactly like the walls
    // `emit_frags` grows on the plate pieces the rect was cut out of
    let sag = |p: Vec2| Vec2::new(p.x, (p.y - droop).max(y_floor));
    if spall_layers() & 1 != 0 {
        for k in 0..n {
            let j = (k + 1) % n;
            let (a, b) = (rim[k], rim[j]);
            // outward radial at this edge (the collar's "away from the crater")
            let r = ((a + b) * 0.5 - cr.c).normalize_or(Vec2::Y);
            // A cavity must read dark at EVERY orientation (the round-4 rule).
            // The crater's walls face INWARD, so its BOTTOM arc faces UP and
            // would take full sky — the cavity's brightest pixels exactly where
            // it should be deepest. `emit_prism` already answers this for a
            // full-depth cut: tilt a near-horizontal upward lip's normal DOWN.
            let rw = lip_tilt(-r, (b - a).normalize_or_zero());
            let e = (0.0, ring[k], ring[j], hole[k], hole[j]);
            // 1. the surviving cover's front face, chamfer ring → patch rect
            cov.quad(
                [w(ins[k].x, ins[k].y, d(e.0)), w(ins[j].x, ins[j].y, d(e.0)), w(e.2.x, e.2.y, d(e.0)), w(e.1.x, e.1.y, d(e.0))],
                wn(0.0, 0.0, nz),
            );
            // 2. the chamfered lip: down into the wall at ~45°
            cov.quad(
                [w(ins[k].x, ins[k].y, d(e.0)), w(ins[j].x, ins[j].y, d(e.0)), w(b.x, b.y, d(cd)), w(a.x, a.y, d(cd))],
                wn(-r.x * 0.707, -r.y * 0.707, nz * 0.707),
            );
            // 3. the UNDERCUT: the surviving cover's inner wall, leaning OUT as
            //    it goes back, so the cover overhangs the void by `UNDERCUT`.
            //    It is BASIN body, not glaze: what you see under a spalled lip is
            //    the broken face of the cover, never its glazed outside — which
            //    also means its darkness comes from `BASIN_AO` instead of from a
            //    normal aimed at the lawn (the top arc's true normal faces DOWN,
            //    and a down-facing normal is a green one in this look).
            bas.quad(
                [w(a.x, a.y, d(cd)), w(b.x, b.y, d(cd)), w(e.4.x, e.4.y, d(cfg.t)), w(e.3.x, e.3.y, d(cfg.t))],
                wn(rw.x * 0.55, rw.y * 0.55, nz * 0.84),
            );
            // 4. the SHELF: what the lost cover sat on, core opening → patch
            //    rect. This is what closes the cover layer's underside; without
            //    it the ring between them is a window into the core's hollow.
            bas.quad(
                [w(e.3.x, e.3.y, d(cfg.t)), w(e.4.x, e.4.y, d(cfg.t)), w(e.2.x, e.2.y, d(cfg.t)), w(e.1.x, e.1.y, d(cfg.t))],
                wn(0.0, 0.0, nz),
            );
            // 5. the patch rect's own wall — a CLOSED seam, coincident with the
            //    walls of the plate pieces the rect was subtracted from
            let (qa, qb) = (sag(e.1), sag(e.2));
            cov.quad(
                [w(e.1.x, e.1.y, d(e.0)), w(e.2.x, e.2.y, d(e.0)), w(qb.x, qb.y, d(cfg.t)), w(qa.x, qa.y, d(cfg.t))],
                wn(r.x, r.y, 0.0),
            );
            // 6. the basin wall: a straight prism down to the floor. Its true
            //    normal lies IN the wall's plane, which points it at the
            //    HORIZON — and half the horizon is lawn, so the shipped rim came
            //    out with a dark green band down one side under polana's
            //    sat = 1.42. Tilt it mostly OUT instead: a cavity's wall then
            //    samples the same neutral sky the wall face does, and all of its
            //    darkness comes from `BASIN_AO`, which costs no hue.
            bas.quad(
                [w(e.3.x, e.3.y, d(cfg.t)), w(e.4.x, e.4.y, d(cfg.t)), w(e.4.x, e.4.y, d(cr.floor)), w(e.3.x, e.3.y, d(cr.floor))],
                wn(rw.x * 0.5, rw.y * 0.5, nz * 0.87),
            );
        }
        // the basin floor — a plain outward normal, like every other exposed
        // face of the core. It reads as a hole because it is one: the collar
        // overhangs it, the bar stands in front of it and both cast into it.
        // (The first cut tilted this normal 0.45 DOWN to buy darkness and bought
        // the LAWN instead — measured #717e64, G+13 on a wall that is neutral to
        // −0.3. Never aim a normal at the grass under polana's sat = 1.42.)
        let base = bas.v.len() as u32;
        for p in &hole {
            bas.v.push((w(p.x, p.y, d(cr.floor)), wn(0.0, 0.0, nz)));
        }
        for tri in triangulate(&hole) {
            bas.i.extend_from_slice(&[base + tri[0], base + tri[1], base + tri[2]]);
        }
    }
    // the bars: blocky per the tecta directive — a bar at this resolution is a
    // box, not a cylinder. They INTERPENETRATE the wall solid; no boolean is
    // needed because the buried part is behind the core's own front plane
    // (`rebar::BAR_SET`) and runs past the patch rect (`rebar::BURY`).
    for b in cr.bars.iter().take_while(|_| spall_layers() & 2 != 0) {
        let h = 0.5 * cr.bar_s;
        let (lo, hi) = if b.along_y {
            (cl(Vec2::new(b.at - h, b.v0)), cl(Vec2::new(b.at + h, b.v1)))
        } else {
            (cl(Vec2::new(b.v0, b.at - h)), cl(Vec2::new(b.v1, b.at + h)))
        };
        let (lo, hi) = ([lo.x, lo.y, cr.cover], [hi.x, hi.y, cr.cover + cr.bar_s]);
        // face coords → WORLD (`Frame::w`, the step the first cut skipped), then
        // the world AABB: the map permutes the axes and `d()` flips the depth one
        let (a, c) = (w(lo[0], lo[1], d(lo[2])), w(hi[0], hi[1], d(hi[2])));
        let (mut wlo, mut whi) = (a, c);
        for i in 0..3 {
            wlo[i] = a[i].min(c[i]);
            whi[i] = a[i].max(c[i]);
        }
        bar.world_box(wlo, whi);
    }
}

/// The pier's cover spalls, in face coords. The corrosion mat is seeded on the
/// RUN's damage seed, so the two piers of one facade grow the same character of
/// crater — one wall, one story (2026-07-25).
///
/// `area` is the SPALL layer's amount: the fraction of this face whose cover is
/// gone. Taken from `Wear`'s amounts like every other layer, never from the
/// panel's dial — the generator reads what the model resolved, so the dial can
/// be re-scaled or replaced without touching the geometry.
fn pier_craters(cfg: &CrazeCfg, fr: &Frame, pier: &Pier, area: f32, salt: f32, fits: &dyn Fn(Vec2, Vec2) -> bool) -> Vec<rebar::Crater> {
    let (run_u0, run_u1) = if fr.run_x { (pier.run_lo.x, pier.run_hi.x) } else { (pier.run_lo.z, pier.run_hi.z) };
    let face = rebar::Face {
        u0: fr.u0,
        u1: fr.u1,
        y0: fr.y0,
        y1: fr.y1,
        run_u0,
        run_u1,
        veneer: cfg.t,
        thick: fr.t1 - fr.t0,
        seed: cfg.dmg_seed + salt,
    };
    if spall_layers() == 0 {
        return Vec::new(); // the whole effect off — see `spall_layers`
    }
    // The BAND veto, composed into `fits` like the back face's disjointness
    // veto: a vetoed site must never spend the budget (rebar's monotonicity
    // rule), and the banded `dmg` alone only SORTS out-of-band sites last —
    // a count larger than the band can hold would still spill past its edge.
    let in_band = |lo: Vec2, hi: Vec2| wear_core::wall::band_mask(cfg.band, (lo.y + hi.y) * 0.5 / wear_core::wall::BAND_TOP) > 0.5;
    rebar::craters(&face, &|u, y| cfg.dmg(u, y), area, &|lo, hi| in_band(lo, hi) && fits(lo, hi))
}

/// The pier's PLACED shell craters, per face. Places arrive through
/// `wall::Geom` like every other geometry input — compile-clamped, quantized
/// and overlap-vetoed in `wall::compile_shells` — so this is pure resolution:
/// run space → face coords, each hit claimed by the ONE pier whose face holds
/// its centre. The run's u axis IS the world axis the piers were cut on, so a
/// place never moves when a run is re-cut into panels — the same argument
/// that anchors the breaks. Deliberately NOT band-vetoed, also like the
/// breaks: an authored place outranks a region mask.
fn pier_shells(cfg: &CrazeCfg, fr: &Frame, pier: &Pier, g: &wear_core::wall::Geom) -> (Vec<rebar::Crater>, Vec<rebar::Crater>) {
    let (mut front, mut back) = (Vec::new(), Vec::new());
    if g.shell_count() == 0 || spall_layers() == 0 {
        return (front, back);
    }
    let (run_u0, run_u1) = if fr.run_x { (pier.run_lo.x, pier.run_hi.x) } else { (pier.run_lo.z, pier.run_hi.z) };
    let face = rebar::Face {
        u0: fr.u0,
        u1: fr.u1,
        y0: fr.y0,
        y1: fr.y1,
        run_u0,
        run_u1,
        veneer: cfg.t,
        thick: fr.t1 - fr.t0,
        seed: cfg.dmg_seed,
    };
    let r = g.shell_r as f32 / 63.0;
    for (u01, y01, b) in g.shells() {
        let au = run_u0 + u01 * (run_u1 - run_u0);
        if !(fr.u0..fr.u1).contains(&au) {
            continue; // another panel of the run holds this place
        }
        let ay = fr.y0 + y01 * (fr.y1 - fr.y0);
        if let Some(cr) = rebar::shell_crater(&face, Vec2::new(au, ay), r) {
            if b { back.push(cr) } else { front.push(cr) }
        }
    }
    (front, back)
}

/// The seed salt for the wall's BACK face. Both faces read the same damage
/// field — one wall, one story — so the back set starts from the same ranked
/// candidate list and takes the best sites the front did not; the salt is what
/// gives its lenses their own orientation, offset and rim noise.
const BACK_SALT: f32 = 37.13;

/// THE WHOLE CRATER ORDERING, once — every crater a pier carries, per face,
/// returned as `(front, back)` with the PLACED hits first and the derived spall
/// appended.
///
/// The order IS the contract, and it has three rules that only compose in this
/// sequence:
///
/// 1. PLACED shells go on each face's list FIRST — an authored place outranks a
///    derived one, so the spall pass packs around the shells instead of the
///    other way round.
/// 2. The FRONT spall is vetoed against the shell rects of BOTH faces. A spall
///    meeting a shell on its own face is two intersecting basins; meeting it
///    across the slab is a PERFORATION — `rect_hits`' own depth argument, and a
///    shell digs deeper than a spall.
/// 3. The BACK spall is vetoed against the front spall's rects PLUS the same
///    shell rects. Both faces spall, because the camera is orthographic but the
///    owner turns it in quarter steps (q/e): a one-sided crater is damage that
///    disappears when he presses `e`, while the cracks, plates and paint around
///    it stay.
///
/// Every veto is handed to the site CHOOSER rather than applied afterwards — a
/// vetoed site must never spend the budget, or the authored amount stops being
/// monotone (`rebar`'s rule).
///
/// `holds` is the caller's own site predicate, composed into every veto: a
/// faulted pier passes its piece containment (a crater straddling a break would
/// be cut in half by the fault gap and dropped by two different amounts, so its
/// patch must sit wholly inside ONE piece), an unfaulted one passes `|_, _|
/// true`. It also filters the placed hits, which is how a shell straddling the
/// break gets DROPPED rather than nudged or carved across the gap.
fn allocate_craters(
    cfg: &CrazeCfg,
    fr: &Frame,
    pier: &Pier,
    sheet: &wear_core::wall::Sheet,
    holds: &dyn Fn(Vec2, Vec2) -> bool,
) -> (Vec<rebar::Crater>, Vec<rebar::Crater>) {
    let spall = sheet.area[wear_core::wall::Layer::Spall.index()];
    let (mut front, mut back) = pier_shells(cfg, fr, pier, &sheet.geom);
    front.retain(|cr| holds(cr.lo, cr.hi));
    back.retain(|cr| holds(cr.lo, cr.hi));
    let mut shell_rects = patch_rects(&front);
    shell_rects.extend(patch_rects(&back));
    let sp_front = pier_craters(cfg, fr, pier, spall, 0.0, &|lo, hi| holds(lo, hi) && !rect_hits(&shell_rects, lo, hi));
    let mut fr_rects = patch_rects(&sp_front);
    fr_rects.extend(shell_rects);
    let sp_back = pier_craters(cfg, fr, pier, spall, BACK_SALT, &|lo, hi| holds(lo, hi) && !rect_hits(&fr_rects, lo, hi));
    front.extend(sp_front);
    back.extend(sp_back);
    (front, back)
}

/// Geometry inputs are BUCKETED so a drag inside a bucket rebuilds nothing; the
/// spall dial gets a finer grain than the knobs (0.05 vs 0.1) because its three
/// stages sit inside one slider.
/// `SPALL_LAYER=0|1|2|3` — the BISECT knob (default 3 = both layers). 0 takes
/// the whole effect out of the geometry pass, so `SPALL_LAYER=0` vs `SPALL=0`
/// is the A/B that proves the DIAL's zero is the same thing as the effect not
/// existing. Bit 1 is the crater (the veneer cut, the collar, the pierced core
/// plane and the basin), bit 2 is the exposed steel. Round 8's lesson, and the task's instruction:
/// a coincident-face question is settled by disabling one layer at a time, never
/// by reasoning about which face wins. Both halves are diagnostic:
/// `SPALL_LAYER=1` shows the cavity with no bar in it, and `SPALL_LAYER=2` must
/// render a wall INDISTINGUISHABLE from `SPALL=0` — the bars are inside the
/// solid, and if any of them shows through, the interpenetration this design
/// relies on (no boolean, the buried part hidden by the core's own faces) is
/// wrong. A shell-only read, like `CRACKS=`/`SPALL=`.
fn spall_layers() -> i32 {
    static L: std::sync::OnceLock<i32> = std::sync::OnceLock::new();
    *L.get_or_init(|| std::env::var("SPALL_LAYER").ok().and_then(|v| v.trim().parse().ok()).unwrap_or(3))
}

/// How much brighter the unglazed body is than the glaze's brightest channel.
/// 3 % is the most that still leaves headroom under 1.0 on polana's near-white
/// wall (peak 0.965 linear → 0.994): a crater floor at albedo 1.0 is literally
/// white paint, which is this effect's named failure mode.
const FRESH_LIFT: f32 = 1.03;

/// The freshly EXPOSED body colour, derived from the pier's own glaze — what
/// damage UNCOVERS, as against the weathered skin it took away (owner
/// catalogue 2026-07-25, "fresh break vs weathered skin").
///
/// Derived, not tuned: what a break exposes is unglazed porcelain, so it is the
/// glaze DESATURATED to its own brightest channel — polana's wall is a warm
/// off-white (0.965 / 0.947 / 0.913 linear), so dropping the warm cast IS most
/// of the paleness — then lifted by [`FRESH_LIFT`] and clamped at 1.
///
/// It replaces a 0.97/0.96/0.94 tint that left the core 3.9 % DARKER than the
/// wall in luma: invisible at 704x464 and the wrong SIGN — a crater floor read
/// as a faint dark decal instead of lost material. This is +9.0 % in luma
/// against that old core and +4.8 % against the glaze, and neutral against a
/// warm wall, which is the second (hue) cue. Host-side rather than shader-side
/// on purpose: the probe bake reads `baseColor` too, so a paler crater floor
/// bounces correctly instead of only looking paler.
///
/// Alpha rides through verbatim — `base_color[3]` is the facade story key
/// ([`crate::wear`]), which a core must inherit from its pier.
fn fresh_body(body: [f32; 4]) -> [f32; 4] {
    let pale = (body[0].max(body[1]).max(body[2]) * FRESH_LIFT).min(1.0);
    [pale, pale, pale, body[3]]
}

/// Mint the pier's matte chalk core material: the surface the damage EXPOSED —
/// groove floors, crater floors, the inset faces behind the veneer. Pale
/// unglazed body ([`fresh_body`]), dead matte (bit 4 kills the sheen), and
/// carrying the pier's knob bits + GEO/CRAZE — the shade pass needs the knobs
/// to know how aged the WALL is, and reads bit 4 + nonzero knobs as "this is
/// the fresh break": the skin's stains and fine web stop at the lip. Never SEL.
/// Live knob drags leave this snapshot stale until the release rebuild —
/// sub-bucket drift, imperceptible.
fn chalk_material(scene: &mut Scene, mid: i32) -> i32 {
    let body = scene.materials[mid as usize];
    let mut core = body;
    core.base_color = fresh_body(body.base_color);
    core.roughness = 1.0;
    core._pad = (body._pad & !SEL_BIT_I) | crate::flags::MATTE | GEO_BIT | CRAZE_BIT;
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

// ---- the two pier treatments -----------------------------------------------


/// Extrude one structural piece: front/back planes into `pv` (the chalk core
/// when the veneer is on, else the pier's own face) and the perimeter walls —
/// fault flanks, ends, top cap and base — into `sv`, full thickness. The
/// polygon boundary IS the crack path, so a kink shows in the silhouette.
///
/// `holes` are the spall craters' patch rects PER FACE (`[front, back]`): a
/// crater cuts through the plane of the face it opened on, and cover spalls on
/// both faces of a wall (the owner turns the camera in quarter steps), so both
/// planes take their own holes. The perimeter walls take none.
#[allow(clippy::too_many_arguments)]
fn emit_prism(
    sv: &mut Vec<([f32; 3], [f32; 3])>,
    si: &mut Vec<u32>,
    pv: &mut Vec<([f32; 3], [f32; 3])>,
    pi: &mut Vec<u32>,
    poly: &[Vec2],
    closed: &[bool],
    holes: [&[(Vec2, Vec2)]; 2],
    t0: f32,
    t1: f32,
    ff: f32,
    fb: f32,
    w: &dyn Fn(f32, f32, f32) -> [f32; 3],
    wn: &dyn Fn(f32, f32, f32) -> [f32; 3],
) {
    for face in poly_minus_rects(poly, holes[0]) {
        let base = pv.len() as u32;
        for p in &face {
            pv.push((w(p.x, p.y, ff), wn(0.0, 0.0, 1.0)));
        }
        for tri in triangulate(&face) {
            pi.extend_from_slice(&[base + tri[0], base + tri[1], base + tri[2]]);
        }
    }
    for face in poly_minus_rects(poly, holes[1]) {
        let base = pv.len() as u32;
        for p in &face {
            pv.push((w(p.x, p.y, fb), wn(0.0, 0.0, -1.0)));
        }
        for tri in triangulate(&face) {
            pi.extend_from_slice(&[base + tri[0], base + tri[2], base + tri[1]]);
        }
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
        // present a SKY-LIT ledge and the crack would dash out — see [`lip_tilt`].
        let nn = lip_tilt(Vec2::new(e.y, -e.x), e);
        quad(sv, si, [w(pa.x, pa.y, za), w(pa.x, pa.y, zb), w(pb.x, pb.y, zb), w(pb.x, pb.y, za)], wn(nn.x, nn.y, 0.0));
    }
}

/// Fragment an UNFAULTED pier into core box + veneer per the policy, and blow
/// the SPALL layer's cover craters through both layers. Returns the pier's chalk
/// core and steel materials (`-1` = none): the scene is untouched when nothing
/// opened — no groove, no live or spalled plate, no crater — and the pier keeps
/// its box and its paint.
pub(super) fn craze_pier(scene: &mut Scene, pier: &Pier, sheet: &wear_core::wall::Sheet) -> (i32, [i32; 2]) {
    let policy = sheet.geom.pattern;
    let mid = mat_of(scene, pier);
    let fr = Frame::of(pier);
    let cfg = CrazeCfg::new(story_of(scene, pier), sheet, fr.run_x, fr.t1 - fr.t0, &[]);
    let opened = StdCell::new(false);
    let mut frags = policy_frags(&cfg, policy, fr.u0, fr.u1, fr.y0, fr.y1, &opened);
    // every crater this pier carries, placed then derived — see
    // `allocate_craters` for the ordering and why it is one function. An
    // UNFAULTED pier has no piece containment to impose, so nothing is held
    // back beyond the craters' own disjointness.
    let (front, back) = allocate_craters(&cfg, &fr, pier, sheet, &|_, _| true);
    if !opened.get() && front.is_empty() && back.is_empty() {
        return (-1, [-1, -1]);
    }
    let rect = (Vec2::new(fr.u0, fr.y0), Vec2::new(fr.u1, fr.y1));
    // A spall on an otherwise SOUND wall still needs its cover: with no plates
    // at all the inset core box would stand exposed and the wall would read 2t
    // thinner and chalk-pale. One flush plate over the whole face IS unaged
    // cover — every seam closed, so it renders as the slab it replaces.
    if frags.is_empty() {
        frags.push(flush_plate(rect.0, rect.1));
    }
    // the matte body: big faces pulled in by the veneer, ends/top/bottom flush
    let (blo, bhi) = if fr.run_x {
        (Vec3::new(pier.lo.x, fr.y0, fr.t0 + cfg.t), Vec3::new(pier.hi.x, fr.y1, fr.t1 - cfg.t))
    } else {
        (Vec3::new(fr.t0 + cfg.t, fr.y0, pier.lo.z), Vec3::new(fr.t1 - cfg.t, fr.y1, pier.hi.z))
    };
    // add_box_world mints the core its own material; restamp it as the chalk
    let body = scene.materials[mid as usize];
    scene.add_box_world(blo, bhi, fresh_body(body.base_color), [0.0; 4], 1.0, 0.0);
    let core_prim = scene.primitives.len() - 1;
    let core_mid = scene.primitives[core_prim].material_id as usize;
    scene.materials[core_mid]._pad = (body._pad & !SEL_BIT_I) | crate::flags::MATTE | GEO_BIT | CRAZE_BIT;
    // veneer fragments, both big faces — ONE prim sharing the pier material.
    // Only the +t face can ever be seen (the camera is a fixed ortho rig that
    // only ever shows +X/+Z/+Y), so the craters live there and there only.
    let (w, wn) = (fr.w(), fr.wn());
    let (mut cov, mut plane_mesh) = (Mesh::default(), Mesh::default());
    let (mut bas, mut bar) = (Mesh::default(), Mesh::default());
    let plane = vec![Vec2::new(fr.u0, fr.y0), Vec2::new(fr.u1, fr.y0), Vec2::new(fr.u1, fr.y1), Vec2::new(fr.u0, fr.y1)];
    for (t_face, nz, crs) in [(fr.t1, 1.0f32, &front), (fr.t0, -1.0f32, &back)] {
        let rects = patch_rects(crs);
        emit_frags(&mut cov.v, &mut cov.i, &frags_minus_rects(frags.clone(), &rects), t_face, nz, &cfg, &w, &wn, rect);
        if !rects.is_empty() {
            // this face's core plane gets the holes; the box face steps aside
            collapse_face(scene, core_prim, wn(0.0, 0.0, nz));
            for poly in poly_minus_rects(&plane, &rects) {
                let base = plane_mesh.v.len() as u32;
                for p in &poly {
                    plane_mesh.v.push((w(p.x, p.y, t_face - nz * cfg.t), wn(0.0, 0.0, nz)));
                }
                for tri in triangulate(&poly) {
                    plane_mesh.i.extend_from_slice(&[base + tri[0], base + tri[1], base + tri[2]]);
                }
            }
        }
        for cr in crs {
            emit_crater(cr, &cfg, t_face, nz, &w, &wn, rect, &mut cov, &mut bas, &mut bar);
        }
    }
    if !plane_mesh.is_empty() {
        scene.add_mesh_world(&plane_mesh.v, &plane_mesh.i, core_mid as i32);
    }
    scene.add_mesh_world(&cov.v, &cov.i, mid);
    let spall_mats = spend_spall(scene, mid, core_mid as i32, &bas, &bar);
    collapse_box(scene, pier);
    scene.materials[mid as usize]._pad |= CRAZE_BIT;
    (core_mid as i32, spall_mats)
}

/// The patch rects the cover is cut back to — empty when the bisect knob has the
/// crater layer off, which is what makes `SPALL_LAYER=2` an intact wall with the
/// steel buried inside it.
fn patch_rects(craters: &[rebar::Crater]) -> Vec<(Vec2, Vec2)> {
    if spall_layers() & 1 == 0 {
        return Vec::new();
    }
    craters.iter().map(|c| c.rect()).collect()
}

/// Add the crater's two own prims — the BASIN's interior and the exposed STEEL —
/// minting each material only if there is something to hang on it (an empty mesh
/// must not leave a material behind: the probe cache keys on the material bytes).
/// Returns `[steel, basin]`, `-1` for either that did not happen.
fn spend_spall(scene: &mut Scene, mid: i32, core_mid: i32, bas: &Mesh, bar: &Mesh) -> [i32; 2] {
    let mut out = [-1, -1];
    if !bas.is_empty() {
        out[1] = basin_material(scene, core_mid);
        scene.add_mesh_world(&bas.v, &bas.i, out[1]);
    }
    if !bar.is_empty() {
        out[0] = rust_material(scene, mid);
        scene.add_mesh_world(&bar.v, &bar.i, out[0]);
    }
    out
}

/// Split a FAULTED pier along its faults AND craze the pieces: per piece a
/// full-thickness shell (fault walls + caps, pier material), inset front/
/// back planes (the chalk core showing in grooves and recesses), and the
/// policy veneer clipped against the fault paths — so the small-crack
/// pattern rides the broken wall and clusters along the seam (halo).
#[allow(clippy::too_many_arguments)]
pub(super) fn split_pier(scene: &mut Scene, pier: &Pier, faults: &[Fault], sheet: &wear_core::wall::Sheet) -> (i32, [i32; 2]) {
    let policy = sheet.geom.pattern;
    let mid = mat_of(scene, pier);
    let fr = Frame::of(pier);
    let (u0, u1, t0, t1, y0, y1) = (fr.u0, fr.u1, fr.t0, fr.t1, fr.y0, fr.y1);
    let w = fr.w();
    let wn = fr.wn();

    // the veneer, the damage field AND the breaks all take the RUN's story now
    // (`faults_for`), so a facade tells one story down to where it is broken
    let cfg = CrazeCfg::new(story_of(scene, pier), sheet, fr.run_x, t1 - t0, faults);
    // the break, grown: jagged trunks (THROUGH — they separate the wall) plus
    // their forks (surface cracks that groove the veneer only)
    let all_bolts = fault_bolts(faults, &fr, &cfg);
    let (bolts, forks): (Vec<Bolt>, Vec<Bolt>) = all_bolts.into_iter().partition(|b| b.through);
    let opened = StdCell::new(false);
    let mut all_frags = split_frags(policy_frags(&cfg, policy, u0, u1, y0, y1, &opened), &forks, 400);

    let rect = vec![Vec2::new(u0, y0), Vec2::new(u1, y0), Vec2::new(u1, y1), Vec2::new(u0, y1)];
    let pieces = carve(rect, &bolts, 64);
    // Craters come AFTER the carve, and the site chooser is told which rects can
    // land: a crater straddling a break would be cut in half by the fault gap and
    // dropped by two different amounts, so its patch must sit wholly inside ONE
    // piece. Filtering afterwards instead would make the AMOUNT non-monotone
    // (measured: the garden wall lost its crater between 0.25 and 0.55), which
    // is the one thing an authored area may not do.
    let piece_of = |lo: Vec2, hi: Vec2| pieces.iter().position(|(_, cuts)| rect_inside(lo, hi, cuts, &bolts));
    // The SAME crater ordering `craze_pier` runs (`allocate_craters`: placed
    // first, both faces vetoed against each other), with the piece containment
    // as its site predicate — so on a broken wall a hit straddling the break is
    // DROPPED (pinned by test; the alternatives are worse: nudging it moves the
    // author's click, and carving it across the gap would draw the fault's
    // invisible extension through the basin).
    let (craters, craters_b) = allocate_craters(&cfg, &fr, pier, sheet, &|lo, hi| piece_of(lo, hi).is_some());
    // the veneer inset only happens when the craze layer has anything to
    // show — a pristine-but-faulted wall stays full-thickness slabs
    let crazing = opened.get() || !forks.is_empty() || !craters.is_empty() || !craters_b.is_empty();
    if crazing && all_frags.is_empty() {
        // same reason as in `craze_pier`: the inset planes are the CORE, so a
        // pier that insets without emitting cover reads thin and chalk-pale
        all_frags.push(flush_plate(Vec2::new(u0, y0), Vec2::new(u1, y1)));
    }
    let inset = if crazing { cfg.t } else { 0.0 };
    let core_mid = if crazing { chalk_material(scene, mid) } else { mid };
    let (ff, fb) = (t1 - inset, t0 + inset); // front/back planes (inset when crazing)

    // shear steps: every THROUGH bolt drops the pieces on its sinking side a
    // few cm (cumulative when breaks stack), then everything is shifted so
    // nothing rises above the authored top
    // SHEAR STEP: how far a broken piece settles. It rides the break COUNT,
    // because both are the same authored cause — `wall::derive` turns
    // `Story::settlement` into a count, so a wall that settled more has more
    // breaks AND drops further, from one number. It read the `age` knob before,
    // which meant a weathered-but-stable wall dropped its pieces as far as a
    // subsiding one.
    let step = 0.015 + 0.035 * (sheet.breaks.count as f32 / wear_core::wall::Breaks::MAX as f32);
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
    let (mut bar, mut bas) = (Mesh::default(), Mesh::default());
    for (pi, ((poly, cuts), dj)) in pieces.iter().zip(&drops).enumerate() {
        // the craters this PIECE carries, per face, riding its settlement drop
        let of_piece = |set: &[rebar::Crater]| -> Vec<rebar::Crater> {
            set.iter().filter(|cr| piece_of(cr.lo, cr.hi) == Some(pi)).map(|cr| cr.clone_dropped(*dj)).collect()
        };
        let (mine, mine_b) = (of_piece(&craters), of_piece(&craters_b));
        let (holes, holes_b) = (patch_rects(&mine), patch_rects(&mine_b));
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
        emit_prism(&mut sv, &mut si, &mut cv, &mut ci, &dropped, &closed, [&holes, &holes_b], t0, t1, ff, fb, &w, &wn);
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
        let rect = (Vec2::new(u0, y0), Vec2::new(u1, y1));
        let mut cov = Mesh { v: vv, i: vi };
        for (t_face, nz, hs, crs) in [(t1, 1.0f32, &holes, &mine), (t0, -1.0f32, &holes_b, &mine_b)] {
            let fs = frags_minus_rects(piece_frags.clone(), hs);
            emit_frags(&mut cov.v, &mut cov.i, &fs, t_face, nz, &cfg, &w, &wn, rect);
            for cr in crs {
                emit_crater(cr, &cfg, t_face, nz, &w, &wn, rect, &mut cov, &mut bas, &mut bar);
            }
        }
        (vv, vi) = (cov.v, cov.i);
    }
    scene.add_mesh_world(&sv, &si, mid);
    scene.add_mesh_world(&cv, &ci, if crazing { core_mid } else { mid });
    if crazing {
        scene.add_mesh_world(&vv, &vi, mid);
    }
    let spall_mats = spend_spall(scene, mid, core_mid, &bas, &bar);
    collapse_box(scene, pier);
    scene.materials[mid as usize]._pad |= GEO_BIT | if crazing { CRAZE_BIT } else { 0 };
    (if crazing { core_mid } else { -1 }, spall_mats)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crack_geom::fixtures::*;

    /// THE TWO-SIDED SPALL'S ONE STRUCTURAL GUARD, over the real gym at every
    /// stage of the dial: the front and back crater sets must be DISJOINT in
    /// (u, y). Each side's basin is allowed to cut past the slab's half-thickness
    /// (that is what makes the "blown" stage reach the mat at all), so two
    /// craters facing each other at the same spot PERFORATE the wall — light
    /// straight through it, and the occluder / WALLCUT / ROI logic all read a
    /// solid. The veto lives in the site chooser (`rect_hits`), so this test
    /// asks the question the renderer would: does any front rect meet any back
    /// rect, in depth AND in plan?
    ///
    /// It runs the SHIPPED allocator (`allocate_craters`) rather than a copy of
    /// its ordering — a copy pins the copy, which is exactly how the shell veto
    /// came to be deletable from both production sites with every test green.
    #[test]
    fn a_walls_two_faces_never_spall_through_each_other() {
        let spec = house_game::gym::sim::gym_level();
        let (scene, meta) = crate::gym_scene::build_gym(&spec, &crate::look::POLANA);
        let (mut checked, mut deep) = (0, false);
        for area in [0.02f32, 0.04, wear_core::wall::SPALL_MAX] {
            let sh = spalling(area);
            for pier in &meta.piers {
                let fr = Frame::of(pier);
                let cfg = CrazeCfg::new(story_of(&scene, pier), &sh, fr.run_x, fr.t1 - fr.t0, &[]);
                let (front, back) = allocate_craters(&cfg, &fr, pier, &sh, &|_, _| true);
                for a in &front {
                    for b in &back {
                        assert!(!rect_hits(&[a.rect()], b.lo, b.hi), "area {area}: a front and a back crater overlap at {:?} / {:?}", a.rect(), b.rect());
                        // …and the premise: at the top of the dial two facing
                        // basins really would meet, so disjointness is what stops
                        // the perforation rather than the depth clamp
                        deep |= a.floor + b.floor > fr.t1 - fr.t0;
                        checked += 1;
                    }
                }
            }
        }
        assert!(checked > 30, "the gym must actually grow craters on both faces to pin this ({checked} pairs)");
        assert!(deep, "VACUOUS: no two facing basins are deep enough to meet, so disjointness pins nothing");
    }

    /// …AND THE SAME GUARD WITH A PLACED HIT IN IT — the composed path no
    /// shipped level exercises (the catalogue pins spall to 0 on its shell
    /// slab; the crack lab authors no shells), which is exactly why it went
    /// unpinned: the shell veto could be deleted from BOTH production sites
    /// with every test green.
    ///
    /// A shell parked in a corner nothing competes for would pin nothing, so
    /// the hit is placed ON THE SITE THE DAMAGE FIELD ITSELF WANTS: the
    /// allocation is run shell-free first, then a hit is put on the OTHER
    /// face's best site. Both faces then genuinely want the same (u, y), and
    /// only `allocate_craters`' veto keeps the two basins from meeting inside
    /// the slab — a shell digs to the honest depth limit, so a facing pair is
    /// a perforation and not a dent.
    #[test]
    fn a_placed_shell_and_the_spall_around_it_never_perforate_the_wall() {
        let (lo, hi) = (Vec3::new(1.0, 0.0, 9.9), Vec3::new(7.0, 2.1875, 10.1));
        let pier = Pier { prim: 0, lo, hi, run_lo: lo, run_hi: hi };
        let fr = Frame::of(&pier);
        let run = wear_core::wall::RunRect { lo, hi };
        // the spall amount is PINNED, so this is the top of the dial and not
        // whatever a story happened to derive
        let compile = |shells| {
            let spec = wear_core::wall::WallSpec {
                pin: wear_core::wall::Pins::NONE.area(wear_core::wall::Layer::Spall, wear_core::wall::SPALL_MAX),
                shells,
                ..wear_core::wall::WallSpec::PRISTINE
            };
            wear_core::wall::compile_specs(std::slice::from_ref(&run), &[("shelled", spec)]).remove(0)
        };
        let story = run.story();
        let bare = compile(wear_core::wall::Shells::NONE);
        let cfg = CrazeCfg::new(story, &bare, fr.run_x, fr.t1 - fr.t0, &[]);
        let (bare_f, bare_b) = allocate_craters(&cfg, &fr, &pier, &bare, &|_, _| true);
        assert!(!bare_f.is_empty() && !bare_b.is_empty(), "VACUOUS: the shell-free wall spalls on neither face");

        for back in [false, true] {
            // the hit goes on the face OPPOSITE the set whose best site it
            // takes, so each pass leans on a different half of the veto: a
            // FRONT hit is what the back spall must be kept off, and vice versa
            let want = if back { &bare_f[0] } else { &bare_b[0] };
            let mut sh = wear_core::wall::Shells::NONE;
            sh.add(wear_core::wall::Shell { u: (want.c.x - fr.u0) / (fr.u1 - fr.u0), y: (want.c.y - fr.y0) / (fr.y1 - fr.y0), back });
            let sheet = compile(sh);
            assert_eq!(sheet.geom.shell_count(), 1, "back {back}: the hit did not survive the compile: {:?}", sheet.notes);
            let cfg = CrazeCfg::new(story, &sheet, fr.run_x, fr.t1 - fr.t0, &[]);
            let (front, back_set) = allocate_craters(&cfg, &fr, &pier, &sheet, &|_, _| true);
            let hit = if back { back_set.len() } else { front.len() };
            assert!(hit > 1 && !front.is_empty() && !back_set.is_empty(), "VACUOUS: back {back} — the wall must carry the hit AND spall on both faces ({} / {})", front.len(), back_set.len());
            let mut deep = false;
            for a in &front {
                for b in &back_set {
                    assert!(!rect_hits(&[a.rect()], b.lo, b.hi), "back {back}: a front and a back crater overlap at {:?} / {:?}", a.rect(), b.rect());
                    deep |= a.floor + b.floor > fr.t1 - fr.t0;
                }
            }
            assert!(deep, "VACUOUS: back {back} — no two facing basins are deep enough to meet");
            // …and on ONE face two basins may not intersect either: a spall
            // packed into a shell is one torn hole, not the two effects
            for set in [&front, &back_set] {
                for (i, a) in set.iter().enumerate() {
                    for b in &set[i + 1..] {
                        assert!(!rect_hits(&[a.rect()], b.lo, b.hi), "back {back}: two craters of ONE face overlap at {:?} / {:?}", a.rect(), b.rect());
                    }
                }
            }
        }
    }

    /// …and the price of that disjointness is a SHARED packing budget, so the
    /// top of the cover-loss dial has to be an amount BOTH faces can still have.
    ///
    /// This is what fixes `wall::SPALL_MAX` at a number rather than at a taste:
    /// the front face takes the worst sites and the back is vetoed off every
    /// rect it took, so an amount near a face's packing limit leaves the back
    /// with nothing — the owner presses `e`, the camera turns, and the wall he
    /// just destroyed is intact on the other side. Measured over every pier of
    /// the gym, at the amount the dial's top actually asks for.
    #[test]
    fn both_faces_get_the_spall_they_asked_for_at_the_top_of_the_dial() {
        let spec = house_game::gym::sim::gym_level();
        let (scene, meta) = crate::gym_scene::build_gym(&spec, &crate::look::POLANA);
        let asked = wear_core::wall::SPALL_MAX;
        let sh = spalling(asked);
        let (mut checked, mut worst) = (0, 0.0f32);
        for pier in &meta.piers {
            let fr = Frame::of(pier);
            let cfg = CrazeCfg::new(story_of(&scene, pier), &sh, fr.run_x, fr.t1 - fr.t0, &[]);
            let face = (fr.u1 - fr.u0) * (fr.y1 - fr.y0);
            let (front, back) = allocate_craters(&cfg, &fr, pier, &sh, &|_, _| true);
            for (side, cs) in [("front", &front), ("back", &back)] {
                let got = cs.iter().map(|c| c.area()).sum::<f32>() / face;
                // half a crater of rounding either way, and the ±LENS_VAR draw
                // over however many craters the ask came to
                let tol = 0.12 * (0.5 + 0.25 * (asked * face / 0.12).sqrt().max(1.0)) / face;
                assert!(
                    got >= asked - tol,
                    "{side} of the {:.1}-wu pier at ({:.1}, {:.1}) asked {asked:.3} and lost {got:.3} — the two faces cannot both have it",
                    fr.u1 - fr.u0,
                    pier.lo.x,
                    pier.lo.z
                );
                worst = worst.max(asked - got);
                checked += 1;
            }
        }
        assert!(checked >= 30, "VACUOUS: only {checked} faces measured");
        println!("worst shortfall over {checked} faces: {worst:.4} of the face ({:.0}% of the ask)", 100.0 * worst / asked);
    }

    /// Round 7: chamfer bands appear ONLY along open grooves — a bevel on a
    /// closed seam would carve a visible V into a flush slab. Open edges
    /// inset the plate front (the groove keeps its width).
    #[test]
    fn chamfer_bands_only_on_open_grooves() {
        let cfg = CrazeCfg::new(3.0, &hot(0), true, 0.25, &[]);
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

    /// THE FRESH-BREAK DISCRIMINATOR (owner catalogue 2026-07-25), pinned over
    /// the WHOLE gym: the shade pass decides "this surface is a fresh break,
    /// suppress the skin's stains and fine web" from MATTE (`_pad` bit 4) plus
    /// nonzero knob bits, because the last free flag bit is worth more
    /// elsewhere. That is only sound if nothing ELSE in a real scene carries
    /// both — `mark_matte` also marks the grass floor and every tuft, and the
    /// crack lab stamps knobs on every pier. A future generator that mints a
    /// matte material for a knobbed pier (rust-stained basin chalk, say) breaks
    /// the read for stains and the fine web, and it will trip here first.
    #[test]
    fn matte_plus_knobs_is_only_the_chalk_core() {
        let spec = house_game::gym::sim::gym_level();
        let (mut scene, meta) = crate::gym_scene::build_gym(&spec, &crate::look::POLANA);
        // the crack lab's own boot state: every pier knobbed (demos.rs), the
        // knob bits stamped, then the geometry pass mints the chalk cores
        crate::wear::stamp_story(&mut scene, &meta.piers); // boot order: the story seeds the field
        let mut lab = crate::crack::CrackLab::default();
        crate::crack::resolve(Some(crate::demos::lab_wear()), &mut lab, &meta.piers, &mut scene, 1);
        let cores = lab.cores.clone();
        // the CORE inherits its facade's story for free (chalk_material copies
        // base_color, fresh_body passes alpha through) — the surface a crack
        // exposed belongs to the same wall as the skin that was over it
        for (pier, core) in meta.piers.iter().zip(&cores).filter(|(_, c)| **c >= 0) {
            let story = story_of(&scene, pier);
            assert_eq!(scene.materials[*core as usize].base_color[3], story, "the chalk core must inherit the pier's story key");
            assert_eq!(story, wear_core::wall::story_key(pier.run_lo, pier.run_hi));
        }
        let mut expect: Vec<usize> = cores.iter().filter(|c| **c >= 0).map(|c| *c as usize).collect();
        expect.sort_unstable();
        assert!(expect.len() > 8, "the crack lab must actually have cores to pin ({})", expect.len());
        let got: Vec<usize> = (0..scene.materials.len()).filter(|m| scene.materials[*m]._pad & 4 != 0 && scene.materials[*m]._pad >> 8 != 0).collect();
        assert_eq!(got, expect, "matte + knobbed must be exactly the chalk cores");
        // and the grass IS matte (so the test is not passing because nothing is)
        assert!(
            scene.materials.iter().any(|m| m._pad & 4 != 0 && m._pad >> 8 == 0),
            "the gym's matte greens must still be present, unknobbed"
        );
    }

    /// The exposed body is PALER than the glaze and neutral — the old core was
    /// 3.9 % darker, which read as a dark decal instead of lost material. Pins
    /// the sign and the clamp (albedo 1.0 would be white paint), not the exact
    /// value.
    #[test]
    fn fresh_body_is_paler_and_neutral_than_the_glaze() {
        let glaze = [0.9647, 0.9473, 0.9131, 0.5];
        let f = fresh_body(glaze);
        let luma = |c: [f32; 4]| 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
        assert!(luma(f) > luma(glaze) * 1.03, "the break must read PALER than the skin: {} vs {}", luma(f), luma(glaze));
        assert!(f[0] < 1.0 && f[0] == f[1] && f[1] == f[2], "neutral, and a shade under white: {f:?}");
        assert_eq!(f[3], glaze[3], "the story key (base_color.w) rides through");
        // a dark wall stays dark — the lift is relative, so no look can blow out
        let dark = fresh_body([0.2, 0.18, 0.15, 1.0]);
        assert!(dark[0] < 0.25, "a dark body must not jump to white: {dark:?}");
    }
}
