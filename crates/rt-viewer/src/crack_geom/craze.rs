//! THE CRAZE MODEL — a pier's damage config and the pattern POLICIES that lay
//! its veneer out.
//!
//! [`CrazeCfg`] is the sheet dequantized into the numbers the generators read,
//! and it owns the damage field the shade pass mirrors float-for-float. The
//! three policies below it ([`super::POLICIES`]) are the only things that
//! decide where a plate ends: `lightning` grows a real network with
//! [`bolt_network`], `craquelure` splits with the analytic [`Ladder`], `mosaic`
//! tiles Worley cells.
//!
//! One back-reference, and it is honest: the damage field's HALO is a function
//! of the run's structural breaks, so this module reads [`super::breaks::Fault`].

use glam::{Vec2, Vec3};
use std::cell::Cell as StdCell;
use super::breaks::Fault;
use super::cut::{any_hit, carve, cut_clip, open_flags, Bolt, CutLike, Walk};
use super::poly::{curved_clip, poly_area, poly_centroid, rot, Frag};
use super::{LIGHTNING_STRAIGHT, PARAMS_MAX};
use wear_core::field::{dmg_field, hash13, mixf, smoothstep, vnoise};

/// One screen pixel in wu along a face's WORST-projected direction, for the
/// game projection (trimetric (40,10)/(-20,20): world X spans √1700 ≈ 41.2
/// px/wu, world Y S·ûy ≈ 38.7, world Z only √800 ≈ 28.3). Groove widths
/// clamp here (+5% margin) so a crack line NEVER goes sub-pixel — the
/// owner's round-5 floor. The iso21 A/B preset sits within ~5%.
pub(super) fn px_floor(run_x: bool) -> f32 {
    if run_x {
        0.0271
    } else {
        0.0371
    }
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

/// The pier's damage gates + layout parameters — mirrors the shade pass
/// fields (same fbm/seeds) so fragments craze in the SAME patches the
/// painted stains sit in.
pub(super) struct CrazeCfg {
    /// PLATE SIZE, in WORLD UNITS — `wall::Shape::grain`, and the only place
    /// a pattern's scale lives.
    ///
    /// It replaces `freq`, a cells-per-wu frequency derived from the CRACKS
    /// knob, plus a `scale` multiplier on two of the three policies. Three
    /// spellings of one property, on three curves, none of them a length: the
    /// same slider position meant 0.79-wu plates under craquelure and 0.40 under
    /// mosaic, which is why craquelure rendered essentially one line on a 2.2-wu
    /// bench slab at its own defaults. A LENGTH is the honest unit here — it is
    /// what the author sees on the wall, it is comparable against the wall's own
    /// size, and it is the number the pixel floor ([`wear_core::wall::GRAIN_OFF`]) is
    /// stated in.
    pub(super) grain: f32,
    pub(super) seed: f32,     // cell lattice seed (shader: story + 5)
    pub(super) dmg_seed: f32, // damage field seed (`wear_core::field::dmg_seed` — NOT the cell seed)
    /// The wall's BAND edge codes (`wall::band_codes`, from `Geom.band`) —
    /// applied inside [`Self::dmg`], so every consumer of the field obeys the
    /// authored region without knowing it exists.
    pub(super) band: [u32; 2],
    /// ABSOLUTE damage-field thresholds, one per layer, SOLVED for this run by
    /// `wall::RunField::threshold` and quantized exactly as the shade pass will
    /// decode them (`wall::gate_quantize`).
    ///
    /// This is the round's central change. The gates used to be one
    /// age-derived value `d_t` sliding five FIXED windows (stains at
    /// `d_t − 0.14`, cracks at `−0.10`, plates at `+0.02`, the web at `+0.08`),
    /// so how much of a face was damaged was whatever that run's fbm draw
    /// happened to give it, and "stains spread wider than the cracking" was not
    /// a sentence the system could express. A threshold solved from the run's
    /// own sorted samples makes the amount an AREA, and one per layer makes the
    /// layers independent.
    /// The CRACKS layer's solved threshold — where this wall's plates are
    /// cracked free, and where a crack path may run. ONE threshold, because it
    /// is one layer: the veneer's zone used to read the WEB layer's gate, which
    /// is a PAINTED layer, so a wall authored as "cracked" built no plates at
    /// all unless it also happened to be asked for crazing. The two BANDS around
    /// it still differ (`zone` ±0.03, `crack_zone` ±0.04), which is what lets a
    /// path reach a little past the plates it freed.
    pub(super) t_crack: f32,
    /// The CHIPS amount — the fraction of plates inside the zone that go
    /// missing. A literal fraction, not a noise gate multiplied by the stain
    /// window, which is why the chip dial used to do nothing at low age.
    pub(super) chip: f32,
    /// The CRACKS AMOUNT — how cracked this wall is, as a fraction of its face.
    /// Read by the layers that scale with that rather than with where the zone
    /// is: the lightning network's root density. It used to read `age`, which is
    /// one of the four jobs that dial should never have had.
    pub(super) a_cracks: f32,
    pub(super) dep: f32,
    /// Veneer thickness = groove/recess depth. The depth knob spans the
    /// WHOLE wall: 0.02 up to 0.45 × thickness (owner round 6: "ending at
    /// 1 is too small" — a fixed 0.10 cap left the slider's top third dead
    /// on 0.25-wu walls).
    pub(super) t: f32,
    /// The >= 1 px groove-width floor for this pier's face directions.
    pub(super) px1: f32,
    /// Split policies: a plate only sinks when its WHOLE perimeter sits in
    /// the open zone — a sunk plate must be cracked free all round, or its
    /// closed-seam step is sub-pixel and dashes out. (Mosaic needs no gate:
    /// a live cell grooves every edge by construction.)
    pub(super) sink_perimeter: bool,
    /// The active policy's native params ([`super::POLICY_PARAMS`] order).
    pub(super) par: [f32; PARAMS_MAX],
    /// Jaggedness of a PROPAGATED crack at the coarse (structural) scale — see
    /// [`CrazeCfg::new`].
    pub(super) jag: f32,
    /// The pier's structural faults — their HALO boosts the damage zone so
    /// the small-crack network clusters along the big seam (the shader's
    /// old mHalo term, now geometric).
    pub(super) halo_faults: Vec<Fault>,
}

impl CrazeCfg {
    /// Build a pier's craze config from its run's compiled SHEET.
    ///
    /// Every input is a field of the sheet, dequantized through
    /// `wall::Geom` — so the generator sees exactly the integers the rebuild
    /// gate signed, and nothing reaches it as a raw authored float. `story` is
    /// the RUN's key ([`super::story_of`]), not the panel's: the damage field and the
    /// craze lattices are functions of world position plus this seed, so sharing
    /// it is what makes a patch cross a panel joint instead of restarting at it
    /// (owner catalogue 2026-07-25, "one wall, one story").
    pub(super) fn new(story: f32, sheet: &wear_core::wall::Sheet, run_x: bool, thick: f32, faults: &[Fault]) -> CrazeCfg {
        use wear_core::wall::Layer;
        let (amt, gate, g) = (&sheet.area, &sheet.gate, &sheet.geom);
        let dq = |v: u8| v as f32 / 63.0;
        let relief = dq(g.relief);
        let par = g.par.map(dq);
        CrazeCfg {
            grain: dq(g.grain),
            band: g.band.map(u32::from),
            seed: story + 5.0,
            dmg_seed: wear_core::field::dmg_seed(story),
            t_crack: gate[Layer::Cracks.index()],
            chip: amt[Layer::Chips.index()],
            a_cracks: amt[Layer::Cracks.index()],
            dep: relief,
            // THE RELIEF CAP (`rebar::t_cap`), applied at the ONE place the
            // veneer's thickness is born. A wall that spalls has to keep enough
            // core to hold its reinforcement mat; without the cap the relief
            // knob's top end silently deleted the steel and the spall stopped
            // at a shallow dish. Spall-free walls keep the whole travel — the
            // constraint belongs to the effect that needs the core.
            t: {
                let t = wear_core::wall::veneer(relief, thick);
                if amt[Layer::Spall.index()] > 0.0 || g.shell_count() > 0 {
                    t.min(wear_core::rebar::t_cap(thick))
                } else {
                    t
                }
            },
            // HOW JAGGED a crack in this material is — read at the COARSE scale
            // too, because round 8's thesis is that both scales are the same
            // walker. Only the lightning pattern declares it (`straight` is its
            // native dial); the other two get lightning's default, since a
            // structural break is a propagated crack whatever the veneer's
            // lattice happens to be.
            jag: if g.pattern == 0 { par[1] } else { LIGHTNING_STRAIGHT },
            px1: px_floor(run_x),
            sink_perimeter: true,
            par,
            halo_faults: faults.to_vec(),
        }
    }
    /// Chamfer width (in-plane strip the plate loses to the bevel) — a hair
    /// over one screen px, widening as cracks deepen (owner round 7:
    /// chamfered edges read natural and play with the low-res target).
    pub(super) fn cham_w(&self) -> f32 {
        self.px1 * (0.8 + 0.7 * self.dep)
    }
    /// Chamfer depth into the wall — ~45°, capped by the veneer.
    pub(super) fn cham_d(&self) -> f32 {
        self.cham_w().min(0.55 * self.t)
    }
    /// The macro damage field at face coords (u, y) — exact fbm mirror, with
    /// the wall's BAND applied the same way both shader twins apply it
    /// (`wall::banded`: in-band exact, out-of-band dropped below every gate).
    /// Banding HERE is what makes one authored region steer everything at
    /// once: `zone`, `crack_zone`, chip recesses, crack roots, the walk's
    /// stop condition and the crater potential all read this one function.
    pub(super) fn dmg(&self, su: f32, sy: f32) -> f32 {
        wear_core::wall::banded(dmg_field(self.dmg_seed, su, sy), self.band, sy / wear_core::wall::BAND_TOP)
    }
    /// Fault-proximity halo (0..1) — mirrors the paint's fracture zone.
    pub(super) fn halo(&self, su: f32, sy: f32) -> f32 {
        let mut h = 0.0f32;
        for f in &self.halo_faults {
            h = h.max(1.0 - smoothstep(0.10, 0.55, (su - f.u(sy)).abs()));
        }
        h
    }
    /// Where the VENEER crazes. Soft band centred on the threshold, so the
    /// threshold is the 50 % point — which is what makes the measured coverage
    /// equal the amount that was asked for.
    pub(super) fn zone(&self, su: f32, sy: f32) -> f32 {
        let z = smoothstep(self.t_crack - 0.03, self.t_crack + 0.03, self.dmg(su, sy));
        z.max(0.5 * self.halo(su, sy))
    }
    /// Where CRACKS may run — a wider, EARLIER slice of the damage field than
    /// the crazing/stain zone. A crack propagates out of the worst patch into
    /// merely tired material (that is why real cracks are long while the
    /// staining stays patchy); gating cracks on the stain zone left a
    /// mid-aged wall visibly pristine, which is not what "aged" looks like.
    pub(super) fn crack_zone(&self, su: f32, sy: f32) -> f32 {
        let z = smoothstep(self.t_crack - 0.04, self.t_crack + 0.04, self.dmg(su, sy));
        z.max(0.7 * self.halo(su, sy))
    }
    /// Groove width for a seam: the pixel floor, widening as cracks deepen.
    pub(super) fn groove_w(&self, hier: f32) -> f32 {
        (self.px1 * hier * (1.0 + 0.7 * self.dep)).max(self.px1)
    }
    /// Deepest a live fragment may sink — always shy of the veneer bottom.
    pub(super) fn sink_max(&self) -> f32 {
        // …and NOT scaled by age any more: how deep a freed plate settles is a
        // property of the veneer's thickness, and letting the weathering dial
        // move it too was one of `age`'s four silent extra jobs.
        (0.4 * self.t).min(0.025)
    }
    /// Fragment gates at a candidate polygon: live plates sink, chip-hit
    /// plates go MISSING. `h` = the generator's per-fragment hash channel.
    pub(super) fn frag(&self, poly: Vec<Vec2>, open: Vec<bool>, h: impl Fn(f32) -> f32, opened: &StdCell<bool>) -> Option<Frag> {
        if poly.len() < 3 || poly_area(&poly) < 1e-5 {
            return None;
        }
        let c = poly_centroid(&poly);
        // Inside the zone a plate IS cracked free. The `h(91.0) < cover` dropout
        // that used to sit here made `age` decide how many plates existed at all,
        // on top of deciding how large the zone was — the same dial twice.
        let mut live = self.zone(c.x, c.y) > 0.35;
        if live && self.sink_perimeter {
            // cracked free ALL ROUND or it must not sink: a step along a
            // CLOSED seam is a sub-pixel edge that dot-dashes at best, and at
            // worst draws the bolt's invisible extension as a straight line
            // across the wall (round 8 — the round-4 rule, now read off the
            // real per-edge open flags instead of the damage field)
            live = open.iter().all(|o| *o);
        }
        // CHIPS: a literal fraction of the plates inside the zone, plus the
        // fault's flanks. It used to be `chip * smoothstep(0.45, 0.85, stain_w)`,
        // which is why the chip slider did nothing until the stain window had
        // opened — a dial whose effect was conditional on another dial's value.
        let inside = (self.zone(c.x, c.y) + 0.9 * self.halo(c.x, c.y)).clamp(0.0, 1.0);
        let spalled = inside > 0.35 && h(157.0) < self.chip && poly_area(&poly) < 1.0;
        let sink = if live { h(201.0) * self.sink_max() } else { 0.0 };
        if live || spalled {
            opened.set(true);
        }
        Some(Frag { poly, open, spalled, sink })
    }
}

// ---- wandering cuts --------------------------------------------------------


/// One analytic wandering cut through a region (the craquelure ladder):
/// signed field `s` (negative side A), groove half-width opening only inside
/// the damage zone — the ladder's topology is global but the cracks
/// themselves live in the damaged patches, tips ending crisply.
#[derive(Clone)]
pub(super) struct Cut {
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

// ---- fragment generators (the pattern policies) ----------------------------


/// The CRAQUELURE policy: a near-axis LADDER splitter — the glaze-web look
/// (fine, near-rectangular plates; `scale` sizes them, `wave` bends the
/// lines). Regions with no damage (and no fault halo) anywhere stop
/// splitting early (one flush plate, no wasted tris). Lightning left this
/// machinery in round 8 — a BSP cut always crosses its region, which is
/// exactly what a propagating crack must NOT do.
pub(super) struct Ladder<'a> {
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
        if (dmax < self.cfg.t_crack && hmax < 0.2) || depth >= 14 {
            self.emit(poly, id);
            return;
        }
        // Below `grain` a region is not split again, so the leaves land between
        // one and two grains — 0.72 puts their MEAN on the authored size. The
        // 0.14 floor is the sub-pixel guard the ladder has always had.
        let min_ext = (0.72 * self.cfg.grain).max(0.14);
        // the ladder hugs the axes and splits its longer side
        let d = {
            let vert = hi.x - lo.x >= hi.y - lo.y;
            let base = if vert { Vec2::X } else { Vec2::Y };
            let ang = (self.h(id, 3.0) - 0.5) * mixf(0.02, 0.45, self.cfg.par[0]);
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

/// The LIGHTNING policy: a NETWORK of propagated cracks. Roots land on a
/// jittered lattice wherever the wall is failing, each grows a tree — the
/// trunk mostly vertical (shrinkage/settlement in a standing wall), forks
/// angled off it by `spread`, gated by `branch`, jag and wander set by
/// `straight` — and every path dies on the damage zone's edge, off the face,
/// or ON an older crack (T-junction). The plates are simply what the network
/// leaves over; nothing forces a crack to cross a region.
pub(super) fn bolt_network(cfg: &CrazeCfg, u0: f32, u1: f32, y0: f32, y1: f32) -> Vec<Bolt> {
    let (branch, straight, spread) = (cfg.par[0], cfg.par[1], cfg.par[2]);
    let span = Vec2::new(u1 - u0, y1 - y0);
    // The plates are what the network LEAVES OVER, so the root lattice's pitch
    // is the plate size. The clamp is a cost bound and nothing else: below 0.30
    // the root count grows as 1/pitch² over the whole face, and `wall::GRAIN_OFF`
    // is the stop that means "no veneer" rather than "a very fine one".
    let pitch = (1.5 * cfg.grain).clamp(0.30, 0.75);
    // (root, launch dir, depth, budget, half width, parent bolt index)
    let mut queue: Vec<(Vec2, Vec2, u32, f32, f32, usize)> = Vec::new();
    let (nx, ny) = ((span.x / pitch).ceil().max(1.0) as i32, (span.y / pitch).ceil().max(1.0) as i32);
    for j in 0..ny {
        for i in 0..nx {
            let h = |k: f32| hash13(Vec3::new(i as f32 * 1.7 + 3.0, j as f32 * 2.3 + 7.0, cfg.seed + k));
            if h(3.0) > 0.18 + 0.55 * cfg.a_cracks {
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

/// The mosaic lattice, in cells per wu — one cell IS one grain, exactly. Mosaic
/// is the policy whose plate size the author can read off the wall directly.
/// `jitter`, its one native param, scatters the sites — low jitter tends toward
/// a grid.
fn mosaic_freq(cfg: &CrazeCfg) -> f32 {
    MOSAIC_FILL / cfg.grain.max(1e-3)
}

/// Mean plate SIDE as a fraction of the mosaic's lattice spacing. Worley cells
/// tile the lattice exactly, so their mean AREA is the cell's — but a plate's
/// readable size is its side, `sqrt(area)` is concave, and a jittered cell set
/// has real spread, so the mean side comes out short. Measured 0.66 by
/// `every_pattern_reads_at_its_own_defaults`, which fails if it drifts.
///
/// Without it the three patterns still disagreed by a third at the same
/// authored grain — the same defect as three `scale` params, just smaller. One
/// number per pattern, measured once, is what makes the authored size mean the
/// same thing whichever pattern the wall wears.
const MOSAIC_FILL: f32 = 0.66;
fn mosaic_site(cfg: &CrazeCfg, ij: Vec2) -> Vec2 {
    ij + Vec2::splat(0.5) + (crack_site(ij, cfg.seed) - Vec2::splat(0.5)) * mixf(0.25, 1.0, cfg.par[0])
}

/// Is the mosaic cell at lattice coords `ij` in the damage zone (its plate
/// lets go)? Shared by the cell itself and its neighbors' groove test.
fn cell_live(cfg: &CrazeCfg, ij: Vec2) -> bool {
    let site = mosaic_site(cfg, ij);
    let f = mosaic_freq(cfg);
    let (su, sy) = (site.x / f, site.y / f);
    cfg.zone(su, sy) > 0.35
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
pub(super) fn policy_frags(cfg: &CrazeCfg, policy: u8, u0: f32, u1: f32, y0: f32, y1: f32, opened: &StdCell<bool>) -> Vec<Frag> {
    // THE OFF-STOP. Below `GRAIN_OFF` a plate is under a screen pixel across, so
    // the lattice does not render as fine plates — it dot-dashes, which is the
    // one thing this look cannot carry. So the bottom of the grain dial is not
    // "very fine plates" but NO VENEER: the face stays one flush plate, with no
    // groove, no chamfer and no `opened` mark, exactly as a pristine wall does.
    // A dial whose off state is unreachable is a dial with a lie at one end.
    if cfg.grain < wear_core::wall::GRAIN_OFF {
        return vec![Frag { poly: vec![Vec2::new(u0, y0), Vec2::new(u1, y0), Vec2::new(u1, y1), Vec2::new(u0, y1)], open: vec![false; 4], spalled: false, sink: 0.0 }];
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crack_geom::breaks::run_breaks;
    use crate::crack_geom::fixtures::*;
    use crate::crack_geom::{story_of, Frame, POLICIES};
    use crate::gym_scene::Pier;

    /// **EVERY PATTERN READS AT ITS OWN DEFAULTS**, and it reads at the SAME
    /// size — which is the whole claim of moving plate size out of the policies
    /// and into one world-unit number.
    ///
    /// Measured on a 2.2 × 2.19 bench slab with the damage zone fully open, so
    /// the question is about the LATTICE and not about where the wall is
    /// failing. Before this, `scale` at its own default meant 0.79-wu plates
    /// under craquelure against 0.40 under mosaic — a slab three plates tall,
    /// i.e. essentially one line, which is what sent the owner's catalogue row
    /// out with a pattern nobody could see.
    #[test]
    fn every_pattern_reads_at_its_own_defaults() {
        let (u0, u1, y0, y1) = (6.0f32, 8.2, 0.0, 2.1875);
        for grain in [wear_core::wall::Shape::DEFAULT.grain, 0.25, 0.70] {
            let mut sizes = Vec::new();
            for policy in 0..POLICIES.len() as u8 {
                let mut cfg = CrazeCfg::new(3.0, &sheet([0.9, 0.9, 0.9, 0.0, 0.0, 0.0], 0.0, shape(policy), NO_BREAK), true, 0.2, &[]);
                cfg.grain = grain;
                let opened = StdCell::new(false);
                let frags = policy_frags(&cfg, policy, u0, u1, y0, y1, &opened);
                // a plate's SIZE is the side of the square with its area — the
                // only measure that compares a mosaic cell, a ladder leaf and
                // whatever a bolt network happened to leave over
                let n = frags.len();
                let mean = frags.iter().map(|f| poly_area(&f.poly).abs().sqrt()).sum::<f32>() / n.max(1) as f32;
                println!("grain {grain:.2} {}: {n} plates, mean side {mean:.3} wu ({:.2} × grain)", POLICIES[policy as usize], mean / grain);
                assert!(n >= 6, "{} at grain {grain}: {n} plates on a 2.2-wu slab is not a pattern", POLICIES[policy as usize]);
                assert!(
                    (0.78..1.28).contains(&(mean / grain)),
                    "{} at grain {grain}: plates average {mean:.3} wu — the authored size is not what the wall shows",
                    POLICIES[policy as usize]
                );
                sizes.push(mean);
            }
            // …and the three agree with EACH OTHER, which is the property three
            // separate `scale` params could not have
            let (lo, hi) = (sizes.iter().cloned().fold(f32::MAX, f32::min), sizes.iter().cloned().fold(0.0f32, f32::max));
            assert!(hi <= 1.35 * lo, "at grain {grain} the patterns disagree about plate size: {sizes:?}");
        }
    }

    /// **THE OFF-STOP IS OFF**, for every pattern: below `wall::GRAIN_OFF` the
    /// face is ONE flush plate — no groove, no chamfer, nothing marked open —
    /// and not a lattice too fine to render, which is what dot-dashes.
    #[test]
    fn below_grain_off_the_face_is_one_flush_plate() {
        let (u0, u1, y0, y1) = (6.0f32, 8.2, 0.0, 2.1875);
        for policy in 0..POLICIES.len() as u8 {
            let mut cfg = CrazeCfg::new(3.0, &sheet([0.9, 0.9, 0.9, 0.0, 0.0, 0.0], 0.0, shape(policy), NO_BREAK), true, 0.2, &[]);
            // …and the vacuity guard: a hair ABOVE the stop, the same wall is a
            // pattern. Without it this test passes on any generator that emits
            // nothing at all.
            cfg.grain = wear_core::wall::GRAIN_OFF * 1.02;
            let opened = StdCell::new(false);
            let live = policy_frags(&cfg, policy, u0, u1, y0, y1, &opened);
            assert!(live.len() > 20, "{} just above the stop: {} plates", POLICIES[policy as usize], live.len());

            cfg.grain = wear_core::wall::GRAIN_OFF * 0.98;
            let opened = StdCell::new(false);
            let off = policy_frags(&cfg, policy, u0, u1, y0, y1, &opened);
            assert_eq!(off.len(), 1, "{} below the stop must be one plate", POLICIES[policy as usize]);
            assert!(off[0].open.iter().all(|o| !o), "{} below the stop grooved an edge", POLICIES[policy as usize]);
            assert!(!opened.get(), "{} below the stop marked the face opened", POLICIES[policy as usize]);
            assert!((poly_area(&off[0].poly).abs() - (u1 - u0) * (y1 - y0)).abs() < 1e-3, "{}: the flush plate is not the whole face", POLICIES[policy as usize]);
        }
    }

    /// ONE WALL, ONE STORY (owner catalogue 2026-07-25) as an EQUALITY: two
    /// piers of one authored run share ONE damage field — not a similar one, the
    /// SAME function of world position — which is what makes a patch cross a
    /// window opening instead of restarting at the jamb. Sampled right across a
    /// real joint of the gym's own facade, because the whole defect was that the
    /// pattern reset exactly there.
    ///
    /// THE BREAKS ARE THE SAME EQUALITY as of 2026-07-26, and the test now says
    /// so — it used to assert the opposite.
    ///
    /// The old claim was that the two panels' fault SEEDS must differ, hedging an
    /// owner risk on record: "a shared fault seed would crack a facade at one
    /// repeated position". That risk was real while a break was a coin flip on a
    /// 6-wu LATTICE — sharing the seed across a facade would have rolled the
    /// period once and cracked every panel at the same offset. An authored count
    /// at authored places has no period, so the risk dies with the lattice and
    /// the correct claim inverts: both panels of a run must compute the IDENTICAL
    /// break set, or a cut stops dead at a window jamb. Which is exactly what
    /// the per-panel roll did to a break landing on a joint.
    #[test]
    fn piers_of_one_run_share_a_damage_field_and_their_breaks() {
        let spec = house_game::gym::sim::gym_level();
        let (mut scene, meta) = crate::gym_scene::build_gym(&spec, &crate::look::POLANA);
        crate::wear::stamp_story(&mut scene, &meta.piers);
        let rect = |p: &Pier| [p.run_lo.x, p.run_lo.z, p.run_hi.x, p.run_hi.z].map(|v| (v * 10.0).round() as i32);
        // two piers of one run (a facade with a window between them), plus one
        // from a different run as the negative control
        let (a, b) = meta
            .piers
            .iter()
            .enumerate()
            .find_map(|(i, p)| meta.piers[i + 1..].iter().find(|q| rect(q) == rect(p)).map(|q| (p, q)))
            .expect("the gym's facades are cut into several piers");
        let c = meta.piers.iter().find(|p| rect(p) != rect(a)).expect("the gym has more than one run");
        let cfg = |p: &Pier| {
            let fr = Frame::of(p);
            CrazeCfg::new(story_of(&scene, p), &hot(0), fr.run_x, fr.t1 - fr.t0, &[])
        };
        let (ca, cb, cc) = (cfg(a), cfg(b), cfg(c));
        // sample ACROSS the joint: from inside pier a, through the opening, into b
        let fr = Frame::of(a);
        let (u0, u1) = (fr.u0 - 0.5, Frame::of(b).u1 + 0.5);
        let mut differs_from_other_run = false;
        for i in 0..=40 {
            let u = mixf(u0, u1, i as f32 / 40.0);
            for j in 0..=8 {
                let y = mixf(fr.y0, fr.y1, j as f32 / 8.0);
                assert_eq!(ca.dmg(u, y), cb.dmg(u, y), "one run, ONE damage field (u={u}, y={y})");
                assert_eq!(ca.zone(u, y), cb.zone(u, y), "…so the craze zone crosses the joint too");
                differs_from_other_run |= cc.dmg(u, y) != ca.dmg(u, y);
            }
        }
        assert!(differs_from_other_run, "a different run must tell a different story");
        // the run's breaks, computed from each panel in turn: same anchors, same
        // widths, same drop directions — a break on the joint belongs to both
        let brk = |p: &Pier| {
            let f = Frame::of(p);
            let (r0, r1) = if f.run_x { (p.run_lo.x, p.run_hi.x) } else { (p.run_lo.z, p.run_hi.z) };
            run_breaks(r0, r1, story_of(&scene, p), wear_core::wall::Breaks { count: 2, at: None }, REL, CRK)
                .iter()
                .map(|x| ((x.ax / 1e-6) as i64, (x.mw / 1e-6) as i64, (x.tilt / 1e-6) as i64, x.sign as i64))
                .collect::<Vec<_>>()
        };
        assert_eq!(brk(a), brk(b), "one run, ONE set of breaks — a cut must not stop at the jamb");
        assert_ne!(brk(a), brk(c), "a different run must break in different places");
    }

    /// THE FIX, as the number the owner would judge: the fraction of each wall
    /// RUN's own face inside the craze zone, over the gym's seven authored runs.
    ///
    /// Before the level lane the gates were absolute thresholds on an
    /// unnormalized fbm, so this fraction was whatever one draw per facade
    /// happened to give: measured 0.000 .. 0.645 at age 0.9 — the z=8 run
    /// behind the doorway never cleared the gate AT ANY AGE (an un-ageable
    /// facade) while the x=8 facade was already 0.234 at age 0.3. Both tails
    /// have to go, and the middle has to STAY spread or every facade would read
    /// equally damaged.
    ///
    /// The bounds are deliberately loose around the measurement (age 0.9:
    /// 0.176 .. 0.511, age 0.3: 0.018 .. 0.135) — they pin the SHAPE of the
    /// answer, not the tuning. The vacuity guard is the same table computed with
    /// AN AMOUNT IS AN AREA — measured on the BUILT VENEER, not on the model.
    ///
    /// `wall::an_amount_is_an_area` pins the solver; this pins the thing that
    /// consumes it. For every RUN of the gym, at the amounts the crack lab's own
    /// knobs produce, the fraction of the face whose plates actually open
    /// (`CrazeCfg::frag`'s `zone > 0.35` gate — the real gate, not a proxy) must
    /// match the asked Web amount.
    ///
    /// This is the successor to the FIELD LEVEL test, and the reason that
    /// machinery is gone. The old gates were absolute thresholds against a field
    /// whose LEVEL was a per-run lottery: measured over these same runs, the
    /// damaged area at age 0.9 ran 0.000 (the run behind the doorway — an
    /// un-ageable facade) to 0.645, so a signed per-run offset was added to nudge
    /// each field toward a canonical level. Solving the threshold itself deletes
    /// the lottery at its root instead of correcting for it, and the two tails
    /// the offset was calibrated to remove cannot exist: an un-ageable run would
    /// have to fail this equality.
    #[test]
    fn the_built_veneer_covers_the_area_that_was_asked_for() {
        use wear_core::wall::Layer;
        let spec = house_game::gym::sim::gym_level();
        let (mut scene, meta) = crate::gym_scene::build_gym(&spec, &crate::look::POLANA);
        crate::wear::stamp_story(&mut scene, &meta.piers);
        let rect = |p: &Pier| [p.run_lo.x, p.run_lo.z, p.run_hi.x, p.run_hi.z].map(|v| (v * 10.0).round() as i32);
        let mut runs: Vec<&Pier> = Vec::new();
        for p in &meta.piers {
            if !runs.iter().any(|q| rect(q) == rect(p)) {
                runs.push(p);
            }
        }
        assert!(runs.len() >= 6, "the gym has 5 building runs + 2 garden walls");
        let cov = |p: &Pier, age: f32| -> (f32, f32) {
            let fr = Frame::of(p);
            let (a0, a1) = if fr.run_x { (p.run_lo.x, p.run_hi.x) } else { (p.run_lo.z, p.run_hi.z) };
            // ONE COMPILED SHEET, through the real solver — the whole point of
            // the measurement is that the AREA the author asked for is the area
            // the veneer covers, so nothing here may quantize by hand.
            let spec = wear_core::wall::WallSpec { story: wear_core::wall::Story { weather: age, ..wear_core::wall::Story::ZERO }, ..wear_core::wall::WallSpec::PRISTINE };
            let rect = wear_core::wall::RunRect { lo: p.run_lo, hi: p.run_hi };
            let sh = wear_core::wall::compile_specs(std::slice::from_ref(&rect), &[("", spec)]).remove(0);
            let asked = sh.area[Layer::Cracks.index()];
            let cfg = CrazeCfg::new(story_of(&scene, p), &sh, fr.run_x, fr.t1 - fr.t0, &[]);
            let (nu, ny) = (96, 40);
            let mut hit = 0;
            for i in 0..nu {
                let u = mixf(a0, a1, (i as f32 + 0.5) / nu as f32);
                for j in 0..ny {
                    let y = mixf(p.run_lo.y, p.run_hi.y, (j as f32 + 0.5) / ny as f32);
                    hit += (cfg.zone(u, y) > 0.35) as usize;
                }
            }
            (asked, hit as f32 / (nu * ny) as f32)
        };
        let mut worst = 0.0f32;
        for p in &runs {
            for age in [0.3f32, 0.6, 0.9] {
                let (asked, got) = cov(p, age);
                // the >0.35 gate sits ~0.007 of field below the threshold, so the
                // built area reads a shade high; that plus one quantization step
                // is what the tolerance covers
                let e = (got - asked).abs();
                assert!(e < 0.14, "run {:?} at age {age}: asked {asked:.3} of the face, built {got:.3}", rect(p));
                worst = worst.max(e);
            }
            // and no run may be un-ageable or wrecked young — the two tails the
            // deleted level offset was calibrated to remove
            assert!(cov(p, 0.9).1 > 0.12, "run {:?} still barely ages at age 0.9", rect(p));
            assert!(cov(p, 0.3).1 < 0.20, "run {:?} is already wrecked at age 0.3", rect(p));
        }
        println!("worst built-vs-asked area error over {} runs x 3 ages: {worst:.3}", runs.len());
    }

    /// The depth knob spans the whole slider: bucketed depth steps keep
    /// changing the veneer thickness all the way to 1.0 (the old fixed cap
    /// left the top third dead on 0.25-wu walls).
    #[test]
    fn depth_range_has_no_deadzone() {
        let thick = 0.25;
        let t_of = |dep: f32| CrazeCfg::new(3.0, &relief_sheet(dep), true, thick, &[]).t;
        let mut prev = t_of(0.0);
        for i in 1..=10 {
            let t = t_of(i as f32 / 10.0);
            assert!(t > prev + 1e-5, "depth bucket {i} must deepen (got {t} after {prev})");
            prev = t;
        }
        assert!(prev <= 0.5 * thick, "two-sided veneer must leave a core sliver");
    }

    /// A bolt KINKS (that is the round-8 ask: not smooth curves) and the
    /// network FORKS with T-junctions instead of BSP-splitting the face.
    #[test]
    fn the_network_kinks_and_forks() {
        // several segment seeds: the damage field decides where cracks may
        // grow at all, so one wall can legitimately come out nearly clean
        let bolts: Vec<Bolt> = (1..8)
            .flat_map(|seg| {
                let cfg = CrazeCfg::new(seg as f32 * 3.7, &crazy(0), true, 0.25, &[]);
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
        let cfg = CrazeCfg::new(7.4, &crazy(0), true, 0.25, &[]);
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
}
