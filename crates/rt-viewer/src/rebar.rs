//! COVER SPALL WITH EXPOSED REBAR (owner headline, 2026-07-25: "large concrete
//! spalls with the REBAR showing underneath") — the reinforcement mat, the
//! corrosion sites where it fails, and the crater each site blows out of the
//! cover.
//!
//! **The CAGE first, the damage second** — that inversion is the whole design.
//! Today's "spall" is a veneer plate that goes MISSING over a chalk core: a hole
//! with nothing behind it. What makes a real spall read is that the thing which
//! pushed the cover off is still there, catching its own light and casting its
//! own shadow into the cavity — and a cast shadow is the one cue paint cannot
//! fake. So this module builds the mat FIRST, as a pure function of world
//! position, then asks where corrosion would break through it.
//!
//! Three properties the mat has by construction:
//!
//! - **World-anchored, not pier-relative.** Bars sit at `u = 0.4·i` and
//!   `y = 0.25 + 0.5·j` in WORLD coordinates, so the cage lines up across pier
//!   joints, past the window reveals and around the building corner — it is the
//!   same mat on both sides of the doorway, which is what a real wall's
//!   reinforcement is.
//! - **Only the exposed segments exist as geometry.** A bar is emitted only
//!   where a crater actually cuts past its cover ([`Crater::bars`] is empty
//!   until the dial's floor reaches the steel). The rest of the mat is a
//!   coordinate rule, not triangles.
//! - **Causal siting.** The crater lands at the arg-max of a corrosion
//!   potential ([`corr`]) built out of what the level already knows: the
//!   normalized damage field (water gets in where the wall is already failing),
//!   the splash zone at the base, the window REVEALS (classified straight off
//!   `Pier::run_lo/run_hi` — a pier end that is not a run end IS a reveal,
//!   because `wall_slab` cuts piers at `mid ± 0.2`; see [`reveal`] for what that
//!   rule cannot see), and
//!   the parapet band under the cap. Then the site SNAPS onto a bar or a bar
//!   crossing, so the bar the crater exposes is the bar that pushed the cover
//!   off.
//!
//! Everything here is pure geometry in the pier's FACE coordinates `(u, y)`
//! plus a depth measured inward from the face plane; `crack_geom` owns the mesh
//! emission (it is the module that knows about `Frag`, the droop rule and the
//! chamfer). The split is deliberate: this file is testable arithmetic.

use crate::crack_geom::{hash13, mixf, smoothstep};
use glam::{Vec2, Vec3};

/// Square bar section, in wu. 1.5 px across on an X-run face and 1.0 px on the
/// worst Z-run one, so a bar is a LINE of steel with one lit edge — which is
/// what rebar in a spall actually looks like, and what the contour AA is on this
/// geometry for.
///
/// It was 0.075 (3.1 / 2.1 px) through 2026-07-25, sized so the section could
/// carry a lit top facet AND a shaded side facet at a pixel each. The owner
/// rejected that on sight ("jest za gruby") and he is right on the arithmetic
/// too: 1 wu ≈ 1.2 m, so 0.075 wu is a ~9 cm bar — 6-7× real, and against a
/// 0.15-0.30 wu lens it filled the crater it was supposed to sit in (measured on
/// the gym's south facade at ZOOM=6: the basin was a solid brown mass, no chalk
/// floor visible between the tie and the rim). At 0.036 the same crater shows a
/// tie, a vertical crossing it and dark basin around both. Still ~3× real — that
/// residue is the price of a pixel, and it is the same stylization the blocky
/// greybox runs on.
///
/// The sweep that picked it is in the round's notes: 0.050 still read as a log,
/// 0.026 read fine at ZOOM ≥ 1 but is 0.73 px on a Z-run face, i.e. under one
/// texel — it survives today only on the rust-against-chalk contrast, and would
/// dot-dash the moment a look put the two closer together.
pub const BAR_S: f32 = 0.036;

/// Thinnest bar still worth emitting — two thirds of the section, the same ratio
/// the 0.075 era used. Under it the depth budget has eaten so much of the core
/// that the "bar" would be a sub-texel scratch the contour AA has to carry
/// alone; the dial then stops at LIFTED COVER and shows no steel at all (see
/// [`craters`]).
const BAR_S_MIN: f32 = 0.024;

/// How much of the bar's section must stand proud of the basin floor before the
/// dial is allowed to expose it. Below half, a bar reads as a bump in the basin,
/// which is worse than no bar; [`craters`]' staging knee IS this number.
const BAR_PROUD: f32 = 0.5;

/// How far the mat's front face sits BEHIND the core's front plane (i.e. behind
/// the cover the crater has to break through).
///
/// The sign here is the whole point, and the first cut had it backwards: the bar
/// was clamped to fit a depth budget and ended up IN FRONT of the core's front
/// plane, inside the veneer's hollow — so every groove and every missing plate on
/// an unspalled wall became a window onto rust (review 2026-07-25, "rust that
/// reads as brown paint" is this effect's named failure mode). Cover is therefore
/// derived, never clamped: `cover = veneer + BAR_SET`, so the mat is always
/// buried by construction, and everything else (the basin depth, the section)
/// gives way instead. The offset itself only has to beat coplanarity with the
/// core's front plane — the bar's buried ends run through it, and the mat on the
/// FAR face has to clear that same plane by the same margin (`budget` spends it
/// twice; at zero the two went coplanar and rust bled through every groove).
const BAR_SET: f32 = 0.006;

/// Concrete the basin floor must leave in front of the core's REAR plane.
/// Without it the floor goes coplanar with (and then past) that plane — two
/// chalk quads in one plane with opposite normals, round 8's coincident-face
/// class, and past it the nearest surface inside the crater becomes the core's
/// BACKFACING rear plane. Measured cost of getting this wrong: at depth knob ≥
/// 0.6 on the gym's 0.2-wu walls the old clamp (a fraction of the whole SLAB,
/// not of the core) put the floor exactly there.
const REAR: f32 = 0.015;

/// Vertical bar pitch in world `u`; horizontal bars start at [`BAR_Y0`] and
/// repeat every [`PITCH_Y`]. 0.4 wu = 16.5 px on X / 11.3 px on Z and 0.5 wu =
/// 19 px in Y, so a crater at any dial setting shows a bar plus at least one
/// crossing — a cage, never one lonely bar.
const PITCH_U: f32 = 0.4;
const PITCH_Y: f32 = 0.5;
const BAR_Y0: f32 = 0.25;

/// How far a bar runs past the crater's PATCH RECT, buried in the core solid.
/// Measured off the rect and not off the rim on purpose: inside the rect the
/// veneer is gone and the core's front plane is pierced, so a bar ending there
/// would show its end cap floating in the cavity. Past the rect the core is
/// solid at the mat's depth, so the cap is buried by construction. It stays
/// under [`EDGE_MARGIN`], which is what keeps the bar inside its own pier.
const BURY: f32 = 0.06;

/// Deepest a basin may cut as a fraction of the slab — a second, absolute guard
/// on top of the core-derived clamp ([`REAR`]): a perforation would break the
/// occluder / WALLCUT / ROI logic and leak light straight through the wall.
const BASIN_MAX_FRAC: f32 = 0.7;

/// Below this the dial does nothing at all (stage 1 of three: the wall is
/// merely CRACKED). The knob then walks lifted cover → blown spall; see
/// [`craters`].
pub const DIAL_ON: f32 = 0.12;

/// How many FRACTURE CORNERS the rim is built from, drawn per crater so no two
/// spalls share a silhouette. A lens is 14-27 px along its long axis, so its
/// perimeter is 45-90 px: 6-10 corners put a facet every 7-9 px, which is the
/// coarsest angular detail this target can carry and still read as broken
/// material rather than as noise on an oval.
const RIM_C_MIN: usize = 6;
const RIM_C_MAX: usize = 10;
/// One sample per facet is ragged INWARD by up to this fraction of its radius —
/// half a pixel of tooth on an otherwise straight break. Inward-only, so the
/// [`RIM_VAR`] containment bound survives it untouched.
const RIM_JAG: f32 = 0.07;
/// Radial variation of the rim, as a fraction of the lens's half-extents. The
/// patch rect is sized off this bound, so the rim is inside it BY CONSTRUCTION.
const RIM_VAR: f32 = 0.34;
/// Minimum width of the COLLAR — the strip of surviving cover between the rim
/// and the patch rect the veneer is cut back to. Keeps the rect off the rim
/// even where the radial variation peaks.
const RIM_PAD: f32 = 0.03;

/// Cover that must survive between a crater's patch rect and the pier's own
/// border. A crater reaching a pier end would open the jamb face and let rays
/// into the hollow core — round 8's leak class (docs/AGENT_LEARNINGS.md).
/// Consequence worth knowing on the 0.4-wu piers flanking the doorway: the
/// placeable window there is a single point, so the crater sits mid-pier and the
/// world mat's nearest VERTICAL may fall outside it — such a crater exposes the
/// horizontal ties only. That is the honest answer (the mat is where the mat is)
/// and it still reads as steel in a hole.
const EDGE_MARGIN: f32 = 0.08;

/// Cover left standing between two craters' patch rects — within one face, and
/// (via `crack_geom::rect_hits`) between the two FACES of one wall.
pub const PATCH_GAP: f32 = 0.06;

/// Smallest half-extent worth emitting: across the bar the crater must clear
/// the bar's own section plus a pixel of basin either side, or the "bar in a
/// hole" read collapses into a bump.
const MIN_H: f32 = 0.06;

/// Site search lattice — the 0.1-wu authoring grid, the same one `run_level`
/// samples the damage field on. Every term in [`corr`] is smooth over ≥ 0.3 wu,
/// so this resolves all of them, and the site then snaps onto the bar mat
/// anyway.
const LATTICE: f32 = 0.1;

/// Weights of the corrosion potential's non-field terms. All three are "where
/// water gets in and where cover is thin", and they are CALIBRATED against the
/// field's own span rather than picked: the damage field runs ≈0.35..1.0, so
/// `W_FIELD` spreads 0.36 across a face, and each modifier is under two thirds
/// of that. Any one of them alone can therefore open a crater on an otherwise
/// sound wall (which is what makes the dial always DO something on the wall the
/// owner picked), but none of them outranks a genuinely failing patch — measured
/// the other way round first, at 0.35, the splash term won on every face and the
/// craters lined up along the base regardless of the wall's own story.
const W_SPLASH: f32 = 0.22;
const W_REVEAL: f32 = 0.20;
const W_PARAPET: f32 = 0.15;
/// The damage field's own weight — the carbonation/water patch IS the field the
/// paint already stains, so a crater lands where the wall visibly fails.
const W_FIELD: f32 = 0.55;

/// One pier face, in the frame [`craters`] works in.
pub struct Face {
    pub u0: f32,
    pub u1: f32,
    pub y0: f32,
    pub y1: f32,
    /// The parent RUN's `u` range. A pier end that does NOT coincide with a run
    /// end is a window REVEAL or the doorway jamb (`gym_scene::wall_slab` cuts
    /// piers at `mid ± 0.2`), which is where the runoff and the thin cover are.
    pub run_u0: f32,
    pub run_u1: f32,
    /// Veneer thickness — the cover the crater has to break through.
    pub veneer: f32,
    /// Slab thickness (the basin depth clamp's denominator).
    pub thick: f32,
    /// The damage gate at this pier's age (`CrazeCfg::d_t`): the corrosion
    /// threshold rides it, so an old wall spalls from a wider set of sites.
    pub gate: f32,
    /// The facade STORY key — every draw in here is a function of it plus world
    /// position, so the mat and its damage are the same on every boot.
    pub seed: f32,
}

/// One exposed bar segment, in face coords.
#[derive(Clone)]
pub struct Bar {
    /// Does the bar run along `y` (a vertical bar) or along `u`?
    pub along_y: bool,
    /// Its cross-axis position (world `u` for a vertical bar, `y` for a tie).
    pub at: f32,
    /// The segment's span along its own axis, buried ends included.
    pub v0: f32,
    pub v1: f32,
}

/// One cover spall: a lens-shaped loss through the veneer AND into the core.
#[derive(Clone)]
pub struct Crater {
    /// Centre in face coords.
    pub c: Vec2,
    /// The rim polygon: CCW, star-shaped about `c`, strictly inside the patch
    /// rect. This is the CORE's opening.
    pub rim: Vec<Vec2>,
    /// The patch rect's boundary, sampled on the SAME rays as `rim` (so
    /// `rim[i]`/`ring[i]` bound a valid quad by construction). The four corner
    /// rays are in the sample set, so this traces the rect exactly.
    pub ring: Vec<Vec2>,
    /// The patch rect: the region the veneer is cut back to. Everything between
    /// it and the rim survives as the crater's COLLAR.
    pub lo: Vec2,
    pub hi: Vec2,
    /// Depth of the bar mat's front face below the wall face. Always at least
    /// the veneer (see [`BAR_SET`]) — the mat lives in the CORE, never in the
    /// veneer's hollow.
    pub cover: f32,
    /// Depth of the basin floor below the wall face.
    pub floor: f32,
    /// Section of the bars this crater exposes — [`BAR_S`] where the core can
    /// hold it, thinned toward [`BAR_S_MIN`] where the depth knob has eaten the
    /// core, 0 where no readable bar fits.
    pub bar_s: f32,
    /// The bar segments this crater actually exposes (empty until the floor
    /// reaches the steel — the dial's "lifted cover" stage).
    pub bars: Vec<Bar>,
}

impl Crater {
    /// The patch rect, for the caller's containment tests.
    pub fn rect(&self) -> (Vec2, Vec2) {
        (self.lo, self.hi)
    }
    /// A copy shifted down with a settlement-dropped structural piece: the
    /// crater and the steel it exposes belong to the piece of wall they are in,
    /// so they travel with its shear step.
    pub fn clone_dropped(&self, dy: f32) -> Crater {
        let mut c = self.clone();
        let d = Vec2::new(0.0, dy);
        c.c += d;
        c.lo += d;
        c.hi += d;
        for p in c.rim.iter_mut().chain(c.ring.iter_mut()) {
            *p += d;
        }
        for b in &mut c.bars {
            if b.along_y {
                b.v0 += dy;
                b.v1 += dy;
            } else {
                b.at += dy;
            }
        }
        c
    }
}

/// The corrosion potential along the cage, at face coords `(u, y)`.
///
/// Every term is a real mechanism, and all four are read off machinery the
/// level already has:
/// - the normalized damage field — carbonation and the water patch, literally
///   the field the paint stains with;
/// - `splash` — rising damp and splash-back off the ground, the single most
///   reliable place to find spalled cover on a real wall;
/// - `reveal` — a window reveal or the doorway jamb, where the cover is thin on
///   two faces at once and the runoff concentrates;
/// - `parapet` — the band under the cap, which is where the water gets in from
///   above.
pub fn corr(f: &Face, dmg: &dyn Fn(f32, f32) -> f32, u: f32, y: f32) -> f32 {
    // The splash zone is a BAND, not a ramp off the ground. Two reasons, one
    // physical and one measured: splash-back and rising damp attack a wall a
    // hand's height above grade, not the very base (which stays wet and is
    // usually the last cover to carbonate); and a monotone ramp put every arg-max
    // on the bottom row of every face, where a crater cannot fit, so `place`
    // clamped them all to the same lowest legal centre — 13 of 15 gym walls
    // ended up with an identically sized oval at y = 0.42 (review 2026-07-25).
    // The band peaks where a crater can actually sit, so the causality survives
    // placement instead of being undone by it.
    let h = (y - f.y0 - 0.42) / 0.32;
    let splash = W_SPLASH * (-h * h).exp();
    let parapet = W_PARAPET * smoothstep(f.y1 - 0.35, f.y1 - 0.10, y);
    W_FIELD * dmg(u, y) + splash + parapet + reveal(f, u)
}

/// The reveal term: raised beside any pier end the parent RUN did not put there.
/// `wall_slab` cuts a windowed run into piers at `mid ± 0.2`, so a pier end away
/// from `run_lo`/`run_hi` IS an opening's return face.
///
/// One honest limitation, stated because the effect claims causality: the
/// DOORWAY is where a run STOPS (the gym's z=8 wall is two runs, not one with a
/// gap), so a doorway jamb is a run end here and reads like a building corner.
/// Distinguishing them needs the run's neighbours, which `Pier` does not carry;
/// both are exposed arrises either way, so the cost is a weight, not a wrong
/// place.
fn reveal(f: &Face, u: f32) -> f32 {
    let mut w = 0.0f32;
    for (end, run_end) in [(f.u0, f.run_u0), (f.u1, f.run_u1)] {
        if (end - run_end).abs() < 1e-3 {
            continue; // a free wall end or a building corner, not an opening
        }
        w = w.max(1.0 - smoothstep(0.05, 0.40, (u - end).abs()));
    }
    W_REVEAL * w
}

/// The dial's three stages, as one number in 0..1 (0 = the wall is merely
/// cracked, 1 = blown spall). Extent, depth and count all ride it.
fn stage(dial: f32) -> f32 {
    ((dial - DIAL_ON) / (1.0 - DIAL_ON)).clamp(0.0, 1.0)
}

/// Where in the dial's travel the steel appears — the knee of the depth ramp.
/// The basin walks `floor0 → knee` over the first third (LIFTED COVER, a shallow
/// dish with no steel in it) and `knee → basin_max` over the rest (BLOWN SPALL).
/// Putting the knee at a fixed fraction of the DIAL rather than letting it fall
/// out of the depth arithmetic is what keeps the three stages readable on every
/// wall, however thick its cover happens to be.
const ST_STEEL: f32 = 0.35;

/// How deep the LIFTED COVER stage starts, past the veneer. One screen pixel
/// (0.0271 wu on an X-run face) is the least that reads as "the cover has come
/// away" rather than as a missing plate.
const FLOOR0: f32 = 0.03;

/// The crater's depth budget on one face: where the mat sits, how deep the basin
/// may cut and how fat a bar the remaining core can hold.
///
/// All three come off the CORE, never off the slab — the veneer is a shell of
/// plates on BOTH faces (`craze_pier` insets the core by `cfg.t` each side), so
/// the solid a crater actually eats into is `thick - 2·veneer`. Measuring the
/// clamp against the slab is what let the floor reach the core's rear plane at
/// depth knob 0.6 and pass through it above that.
fn budget(f: &Face) -> (f32, f32, f32) {
    let cover = f.veneer + BAR_SET;
    let basin_max = (BASIN_MAX_FRAC * f.thick).min(f.thick - f.veneer - REAR).max(f.veneer);
    // Two bounds on the section, and the fattest bar the core can carry is the
    // smaller: (a) `BAR_PROUD` of it has to stand clear of the deepest floor, or
    // the dial's blown-spall stage never arrives; (b) the WHOLE of it has to fit
    // between the core's two planes, because the mat on the far face is the same
    // rule mirrored — a bar 2 mm too fat pokes 2 mm through the opposite core
    // plane, and that side's veneer is a shell of plates, so it shows as rust in
    // a groove on a wall with no crater in it (measured: 26 k px at Δ174 on the
    // `SPALL_LAYER=2` bisect, against a 648 px @ Δ3 floor).
    let bar_s = ((basin_max - cover) / BAR_PROUD).min(f.thick - f.veneer - cover - BAR_SET).min(BAR_S);
    (cover, basin_max, if bar_s >= BAR_S_MIN { bar_s } else { 0.0 })
}

/// Every crater the dial opens on this face, worst site first.
///
/// ONE owner dial, staged (owner playtests via menus, so a dial that only does
/// something at its top end is a dial he cannot read):
///
/// | dial | what he sees |
/// |---|---|
/// | ≤ 0.12 | nothing — the wall is cracked, which is where round 8 left it |
/// | 0.12 … 0.43 | LIFTED COVER: one shallow lens, pale fresh-break floor, the surviving cover overhanging its top edge. No steel yet — the basin floor is still in front of the mat |
/// | 0.43 … 1 | BLOWN SPALL: the floor cuts past the mat, so 2-3 bars stand proud of it with their own shadows; the lens grows to 0.7 × 0.3 wu and up to three craters open |
///
/// The crossover ([`ST_STEEL`]) is a fraction of the DIAL, and the basin's depth
/// ramp is bent to meet it: at the knee the floor is exactly `cover +
/// BAR_PROUD · bar_s`, i.e. half the bar's section stands proud. Below that a
/// bar reads as a bump in the basin, which is worse than no bar at all.
///
/// ONE HONEST LIMIT, from the depth arithmetic ([`budget`]): the depth knob's
/// veneer eats the core from both sides (`t = 0.02 … 0.45 · thick`), so on the
/// gym's 0.2-wu walls there is no core left to expose steel in above depth ≈
/// 0.72 — that wall stays at LIFTED COVER however far the spall dial goes. The
/// alternative was a bar in front of the core's front plane, which is the bug
/// this replaced.
///
/// `fits` lets the caller veto a patch rect it cannot build — on a FAULTED pier
/// a crater has to sit wholly inside one structural piece. It is a parameter
/// rather than a post-filter because a vetoed site must not spend the dial's
/// budget: filtering afterwards made the dial non-monotone (measured — the
/// garden wall lost its crater between 0.25 and 0.55).
pub fn craters(f: &Face, dmg: &dyn Fn(f32, f32) -> f32, dial: f32, fits: &dyn Fn(Vec2, Vec2) -> bool) -> Vec<Crater> {
    if dial <= DIAL_ON {
        return Vec::new();
    }
    let st = stage(dial);
    let want = 1 + (st * 2.999) as usize;
    // The lens: 0.35-0.7 wu ALONG the bar × 0.15-0.30 across (14-27 × 6-12 px
    // on an X face, 10-20 × 4-8 on Z). Real spalls are lens-shaped because the
    // corrosion crack follows the bar, and a whole pier face is only 66 × 85 px
    // — so one crater is a quarter of the wall's width, LARGE by construction.
    let (ha, hb) = (mixf(0.175, 0.35, st), mixf(0.075, 0.15, st));
    // depth: the mat sits just behind the cover (never in it), and the floor
    // walks from "the cover has lifted" to "the steel stands clear of the floor"
    let (cover, basin_max, bar_s) = budget(f);
    let floor0 = (f.veneer + FLOOR0).min(basin_max);
    // The knee is where the steel is ALLOWED to show: deep enough that
    // `BAR_PROUD` of the section stands clear of the floor, but never shallower
    // than the lifted-cover stage already starts. That `max` is what the thinner
    // section (2026-07-25, 0.075 → 0.036) made load-bearing: at half a pixel of
    // proudness the knee fell 0.006 wu IN FRONT of `floor0`, so the ramp ran
    // BACKWARDS — the basin got shallower as the owner opened the dial — and the
    // steel was already showing at the bottom of the travel.
    let knee = (cover + BAR_PROUD * bar_s).max(floor0).min(basin_max);
    let floor = if st < ST_STEEL {
        mixf(floor0, knee, st / ST_STEEL)
    } else {
        mixf(knee, basin_max, (st - ST_STEEL) / (1.0 - ST_STEEL))
    };
    // …and the three stages are a fact about the DIAL, not a by-product of the
    // depth arithmetic. Geometry alone decided this until the section thinned,
    // and then agreed with the staging table only by coincidence: emit no steel
    // at all below the knee, whatever the depth budget happens to allow.
    let bar_s = if st >= ST_STEEL { bar_s } else { 0.0 };

    // candidate sites: the corrosion potential over the face, worst first
    let n = |a: f32, b: f32| (((b - a) / LATTICE).round() as usize).max(2);
    let (nu, ny) = (n(f.u0, f.u1), n(f.y0, f.y1));
    let mut cand: Vec<(f32, Vec2)> = Vec::with_capacity(nu * ny);
    for i in 0..nu {
        let u = mixf(f.u0, f.u1, (i as f32 + 0.5) / nu as f32);
        for j in 0..ny {
            let y = mixf(f.y0, f.y1, (j as f32 + 0.5) / ny as f32);
            cand.push((corr(f, dmg, u, y), Vec2::new(u, y)));
        }
    }
    cand.sort_by(|a, b| b.0.total_cmp(&a.0));
    // The threshold rides the pier's own damage gate, so "where this wall is
    // failing" means the same thing here as it does to the plates: a face's own
    // worst patches (the field's top few per cent, which `run_level` normalizes
    // onto `dT + 0.05`) clear it on the field alone.
    let floor_corr = W_FIELD * (f.gate - 0.05) + 0.04;

    let mut out: Vec<Crater> = Vec::new();
    for (v, p) in cand {
        if v < floor_corr || out.len() >= want {
            break;
        }
        let Some(cr) = place(f, p, ha, hb, cover, floor, bar_s) else { continue };
        if !fits(cr.lo, cr.hi) {
            continue;
        }
        // THE ONE CONSTRAINT the whole mesh construction rests on: patch rects
        // must be pairwise disjoint. Then subtracting them from the veneer and
        // from the core's front plane is a sequence of independent EXACT
        // operations (see `crack_geom::frag_minus_rect`) with no rect-vs-rect
        // boolean anywhere, and no crater's collar can land inside another
        // crater's hole. `PATCH_GAP` leaves real cover standing between two
        // spalls instead of a zero-width fin.
        if out.iter().any(|o| {
            cr.lo.x < o.hi.x + PATCH_GAP && o.lo.x < cr.hi.x + PATCH_GAP && cr.lo.y < o.hi.y + PATCH_GAP && o.lo.y < cr.hi.y + PATCH_GAP
        }) {
            continue;
        }
        out.push(cr);
    }
    out
}

/// Snap a candidate site onto the mat and build its crater, or `None` when the
/// pier is too narrow to carry a readable one (two building piers are only
/// 0.4 wu = 16 px wide).
fn place(f: &Face, p: Vec2, ha: f32, hb: f32, cover: f32, floor: f32, bar_s: f32) -> Option<Crater> {
    let h = |k: f32| hash13(Vec3::new(p.x * 3.7 + 1.0, p.y * 5.3 + 2.0, f.seed + k));
    let ub = (p.x / PITCH_U).round() * PITCH_U;
    let yb = BAR_Y0 + ((p.y - BAR_Y0) / PITCH_Y).round() * PITCH_Y;
    // Which family the spall grew along: the nearer bar (thin cover over a bar
    // is what lets the water in), with the draw tipped toward the verticals —
    // in a real mat they sit OUTSIDE the ties, i.e. under less cover.
    let mut along_y = (p.x - ub).abs() * 0.8 <= (p.y - yb).abs();
    // …and forced vertical when the pier is too narrow to hold a lens lying
    // across it, which is the 0.4-wu piers flanking the doorway.
    let room_u = (f.u1 - f.u0) * 0.5 - EDGE_MARGIN;
    let room_y = (f.y1 - f.y0) * 0.5 - EDGE_MARGIN;
    along_y |= room_u < ha * (1.0 + RIM_VAR) + RIM_PAD;

    let fit = |half: f32, room: f32| ((room - RIM_PAD) / (1.0 + RIM_VAR)).min(half);
    let (hu, hy) = if along_y { (hb, ha) } else { (ha, hb) };
    let (hu, hy) = (fit(hu, room_u), fit(hy, room_y));
    if hu < MIN_H || hy < MIN_H {
        return None;
    }
    // A bar dead-centre in every crater looks PLACED. So: across the bar the
    // crater is centred on it but offset a fraction of its own half-extent;
    // along the bar it keeps the corrosion max, EXCEPT at a crossing, where it
    // snaps to the intersection — two bars' cover overlapping is exactly where
    // real spalls open, and a crossing is what makes the cage read as a cage.
    let cross = h(3.0) < 0.45;
    let (off, along_off) = ((h(7.0) - 0.5) * 0.7, (h(11.0) - 0.5) * 0.5);
    let mut c = if along_y {
        Vec2::new(ub + off * hu, if cross { yb + along_off * hy } else { p.y })
    } else {
        Vec2::new(if cross { ub + along_off * hu } else { p.x }, yb + off * hy)
    };
    // the patch rect bounds the rim by construction (RIM_VAR is the rim's own
    // radial bound), so keeping the RECT inside the face keeps the rim inside
    let (pu, py) = (hu * (1.0 + RIM_VAR) + RIM_PAD, hy * (1.0 + RIM_VAR) + RIM_PAD);
    let (lo_c, hi_c) = (
        Vec2::new(f.u0 + EDGE_MARGIN + pu, f.y0 + EDGE_MARGIN + py),
        Vec2::new(f.u1 - EDGE_MARGIN - pu, f.y1 - EDGE_MARGIN - py),
    );
    if lo_c.cmpgt(hi_c).any() {
        return None;
    }
    // The u clamp is fine — a 16-px pier has no choice about where a crater sits
    // across it. A big Y clamp is NOT: y is where the causal terms live (splash
    // band, parapet), so a site dragged a long way up the wall to fit is no
    // longer the site the potential picked, and clamping them all landed every
    // gym wall's crater at the same height. Past a third of its own half-extent
    // the site is REJECTED and the loop takes the next candidate instead.
    let cy = c.y.clamp(lo_c.y, hi_c.y);
    if (cy - c.y).abs() > 0.34 * py {
        return None;
    }
    c = Vec2::new(c.x.clamp(lo_c.x, hi_c.x), cy);
    let (lo, hi) = (c - Vec2::new(pu, py), c + Vec2::new(pu, py));

    // The bars this crater exposes — geometry, not intent: the floor has to
    // reach past `BAR_PROUD` of the section or the "bar" is a bump in the basin.
    // A segment spans the whole PATCH RECT plus `BURY` at each end, so both end
    // caps sit in core solid rather than in the cavity (see `BURY`).
    let mut bars = Vec::new();
    if bar_s > 0.0 && floor >= cover + BAR_PROUD * bar_s - 1e-6 {
        for (vertical, pitch, base, cross_h) in [(true, PITCH_U, 0.0, hu), (false, PITCH_Y, BAR_Y0, hy)] {
            let ctr = if vertical { c.x } else { c.y };
            let (i0, i1) = (((ctr - cross_h - base) / pitch).ceil() as i32, ((ctr + cross_h - base) / pitch).floor() as i32);
            for i in i0..=i1 {
                let at = base + i as f32 * pitch;
                if (at - ctr).abs() > cross_h - 0.5 * bar_s {
                    continue; // grazes the rim: it would read as a nick, not a bar
                }
                let (v0, v1) = if vertical { (lo.y, hi.y) } else { (lo.x, hi.x) };
                bars.push(Bar { along_y: vertical, at, v0: v0 - BURY, v1: v1 + BURY });
            }
        }
    }
    let (rim, ring) = outline(c, hu, hy, f.seed, lo, hi, &bars);
    Some(Crater { c, rim, ring, lo, hi, cover, floor, bar_s, bars })
}

/// The rim polygon and the patch rect traced on the same rays.
///
/// Concrete does not spall in OVALS (owner, 2026-07-25: "owalne dziury nie są
/// realistyczne"). The cover fails as a brittle plate: the crack runs a
/// straightish way, turns at a flaw, runs again — so the loss is bounded by a
/// short chain of near-STRAIGHT facets meeting at hard corners, some of them
/// re-entrant. The first cut asked a smooth `r(θ)` (two octaves of value noise)
/// for that shape and could not give it: perturbing a radius keeps every
/// tangent continuous, so it produced a lumpy egg — an EYE, and 15 of them in
/// one frame read as a punched pattern rather than as damage.
///
/// So the rim is now a POLYGON of drawn corners, and the samples in between lie
/// on its straight chords instead of on a curve. Everything the mesh pass leans
/// on survives that change for free:
///
/// - **Star-shaped about `c`** — the corners are drawn at strictly increasing
///   angles (the jitter is a quarter of one gap, so it cannot reorder them), and
///   a polygon whose vertices ascend in angle is hit exactly once by every ray
///   out of `c`. That is what keeps `rim[i]`/`ring[i]` a valid quad ring.
/// - **Inside the patch rect** — every corner radius is within `1 ± RIM_VAR`, and
///   a chord between two points of a convex region stays inside it, so no chord
///   can bulge past the bound the rect was sized for. The ragging is inward-only
///   for the same reason. Containment stays a property of the generator, never a
///   test downstream (the same discipline as `Walk`'s corridor clamp).
fn outline(c: Vec2, hu: f32, hy: f32, seed: f32, lo: Vec2, hi: Vec2, bars: &[Bar]) -> (Vec<Vec2>, Vec<Vec2>) {
    let tau = std::f32::consts::TAU;
    // Everything until the last two lines happens in the lens's NORMALIZED frame
    // (where the lens is the unit circle) — including the rect-corner rays, which
    // is the frame they were already measured in.
    let h = |k: f32| hash13(Vec3::new(c.x * 3.1 + k, c.y * 4.7 + 1.0, seed + 0.5));
    let nc = RIM_C_MIN + (h(0.0) * (RIM_C_MAX - RIM_C_MIN + 1) as f32) as usize;
    let nc = nc.min(RIM_C_MAX);
    // Corrosion runs ALONG a bar, so the rim reaches out toward each crossing.
    // A BROAD reach (^4, not the ^8 the smooth rim used): on a curve a narrow
    // one was a gentle bulge, but between straight facets it converges to a
    // needle, and thirty needle-ended lenses in one frame read as a stencilled
    // leaf motif rather than as damage.
    let lobe = |a: f32| {
        let (s, cs) = a.sin_cos();
        bars.iter().fold(0.0f32, |l, b| l.max(if b.along_y { s.abs() } else { cs.abs() }.powi(4)))
    };
    // A corner sits in its own angular slot (base + a quarter-gap of jitter, so
    // the sequence stays ascending and inside 0..τ) at a drawn radius. The two
    // weights sum to exactly 1: the bound is `RIM_VAR` and nothing can exceed it.
    let corners: Vec<(f32, Vec2)> = (0..nc)
        .map(|i| {
            let k = i as f32;
            let a = tau * (k + 0.5 + 0.5 * (h(k + 1.0) - 0.5)) / nc as f32;
            let r = 1.0 + RIM_VAR * (0.78 * (2.0 * h(k + 31.0) - 1.0) + 0.22 * lobe(a));
            (a, r * Vec2::from_angle(a))
        })
        .collect();

    // The sample rays: every corner, one ragged point per facet, and the four
    // rect corners (so `ring` traces the rect exactly instead of chording it off).
    let mut ang: Vec<f32> = Vec::with_capacity(2 * nc + 4);
    for i in 0..nc {
        let (a0, a1) = (corners[i].0, corners[(i + 1) % nc].0 + if i + 1 == nc { tau } else { 0.0 });
        ang.push(a0);
        ang.push(mixf(a0, a1, 0.3 + 0.4 * h(i as f32 + 61.0)).rem_euclid(tau));
    }
    for corner in [Vec2::new(hi.x, hi.y), Vec2::new(lo.x, hi.y), Vec2::new(lo.x, lo.y), Vec2::new(hi.x, lo.y)] {
        let d = corner - c;
        ang.push((d.y / hy).atan2(d.x / hu).rem_euclid(tau));
    }
    ang.sort_by(f32::total_cmp);
    // Two rays a thousandth of a radian apart are the same ray at 27 px across;
    // keeping both would only emit a degenerate quad with an undefined normal.
    ang.dedup_by(|a, b| *a - *b < 2e-3);

    let (mut rim, mut ring) = (Vec::with_capacity(ang.len()), Vec::with_capacity(ang.len()));
    for (n, a) in ang.iter().enumerate() {
        let dir = Vec2::from_angle(*a);
        // the facet this ray crosses: the last corner at or before it, wrapping
        let i = corners.iter().rposition(|&(ca, _)| ca <= *a).unwrap_or(nc - 1);
        let (p0, p1) = (corners[i].1, corners[(i + 1) % nc].1);
        let e = p1 - p0;
        let den = dir.perp_dot(e);
        let mut s = if den.abs() > 1e-6 { p0.perp_dot(e) / den } else { p0.length() };
        // a facet's own midpoint frays inward — a straight break with a tooth in
        // it, never a bulge (see RIM_JAG)
        if !corners.iter().any(|&(ca, _)| (ca - *a).abs() < 1e-6) {
            s *= 1.0 - RIM_JAG * h(n as f32 + 97.0);
        }
        let p = c + Vec2::new(hu * s * dir.x, hy * s * dir.y);
        rim.push(p);
        ring.push(ray_rect(c, p - c, lo, hi));
    }
    (rim, ring)
}

/// Where the ray `c + t·dir` leaves the rect (`c` is inside it).
fn ray_rect(c: Vec2, dir: Vec2, lo: Vec2, hi: Vec2) -> Vec2 {
    let t = |d: f32, l: f32, h: f32| {
        if d > 1e-6 {
            h / d
        } else if d < -1e-6 {
            l / d
        } else {
            f32::MAX
        }
    };
    let tx = t(dir.x, lo.x - c.x, hi.x - c.x);
    let ty = t(dir.y, lo.y - c.y, hi.y - c.y);
    c + dir * tx.min(ty)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn face() -> Face {
        Face { u0: 9.9, u1: 16.1, y0: 0.0, y1: 2.1875, run_u0: 9.9, run_u1: 16.1, veneer: 0.05, thick: 0.2, gate: 0.62, seed: 41.2 }
    }
    /// No caller veto (the unfaulted-pier case; `split_pier` is the one that
    /// vetoes, and its own test covers that).
    fn anywhere(_: Vec2, _: Vec2) -> bool {
        true
    }
    /// A damage field with one strong patch, so the arg-max has an obvious
    /// answer the test can check against.
    fn patchy(u: f32, y: f32) -> f32 {
        0.45 + 0.5 * (-((u - 13.0).powi(2) + (y - 1.4).powi(2)) / 0.5).exp()
    }

    /// THE DIAL, as the owner walks it: nothing, then a crater with no steel
    /// showing, then bars standing clear of the floor with room for a shadow.
    /// Pinned because a menu dial that only does something at its top end is a
    /// dial he cannot read.
    #[test]
    fn the_dial_walks_cracked_then_lifted_cover_then_blown_spall() {
        let f = face();
        assert!(craters(&f, &patchy, 0.0, &anywhere).is_empty(), "a closed dial builds nothing");
        assert!(craters(&f, &patchy, DIAL_ON, &anywhere).is_empty(), "…including exactly at the threshold");
        let lifted = craters(&f, &patchy, 0.25, &anywhere);
        assert_eq!(lifted.len(), 1, "the first stage is ONE crater");
        assert!(lifted[0].bars.is_empty(), "lifted cover shows no steel yet");
        assert!(lifted[0].floor > f.veneer, "…but it is deeper than the veneer's own recess");
        let blown = craters(&f, &patchy, 1.0, &anywhere);
        // `want` is 3 at the top of the dial, and how many of those actually FIT
        // is geometry: at max extent a lens is 0.7 × 0.3 wu and the rects have to
        // stay disjoint inside one 6.2 × 2.19 face
        assert!(blown.len() >= 2, "the top of the dial opens more than one, got {}", blown.len());
        assert!(blown.len() > lifted.len(), "…and more than the first stage");
        for cr in &blown {
            assert!(!cr.bars.is_empty(), "a blown spall must expose steel");
            assert!(cr.floor >= cr.cover + BAR_PROUD * cr.bar_s - 1e-6, "the bar must stand proud of the floor: {} vs {}", cr.floor, cr.cover);
        }
        // and the extent grows with the dial (14-27 px on an X face)
        let w = |c: &Crater| c.hi.x - c.lo.x;
        assert!(w(&blown[0]) > 1.4 * w(&lifted[0]), "the lens grows with the dial: {} vs {}", w(&blown[0]), w(&lifted[0]));
    }

    /// THE DEPTH BUDGET, over the whole (depth knob × dial) grid the owner can
    /// reach: the mat never sits in the veneer's hollow, and the basin never
    /// reaches the CORE's rear plane. Both bounds were wrong in the first cut and
    /// both were invisible in a shot — the bar showed through grooves on walls
    /// with no crater, and the floor went coplanar with the core's back face at
    /// depth knob 0.6 — so they are pinned as arithmetic, per wall thickness.
    ///
    /// The gym's own walls are the 0.2 row; 0.3 stands in for a thicker slab, and
    /// the vacuity guard is that the 0.2 row must actually RUN OUT of steel at
    /// the top of the depth knob (that limit is real, and the staging table says
    /// so — a test that passed on both rows for the same reason would be pinning
    /// nothing).
    #[test]
    fn the_mat_is_always_buried_and_the_basin_never_reaches_the_cores_rear_plane() {
        let mut thin_ran_out = false;
        for thick in [0.2f32, 0.3] {
            for di in 0..=10 {
                // `CrazeCfg::t` — the veneer the depth knob sets, mirrored here
                let veneer = mixf(0.02, 0.45 * thick, di as f32 / 10.0);
                let f = Face { veneer, thick, ..face() };
                let mut steel = false;
                for dial in [0.2f32, 0.4, 0.6, 0.8, 1.0] {
                    for cr in craters(&f, &patchy, dial, &anywhere) {
                        assert!(cr.cover >= veneer, "thick {thick} depth {di}: the mat is in the veneer's hollow ({} < {veneer})", cr.cover);
                        assert!(
                            cr.floor <= thick - veneer - REAR + 1e-6,
                            "thick {thick} depth {di} dial {dial}: the basin reaches the core's rear plane ({} > {})",
                            cr.floor,
                            thick - veneer - REAR
                        );
                        assert!(cr.floor >= veneer, "thick {thick} depth {di}: a crater shallower than the cover it lost");
                        steel |= !cr.bars.is_empty();
                        if !cr.bars.is_empty() {
                            assert!(cr.bar_s >= BAR_S_MIN, "a sub-readable bar was emitted: {}", cr.bar_s);
                            // the WHOLE section inside the core, because the far
                            // face carries the same mat mirrored (see `budget`)
                            assert!(
                                cr.cover + cr.bar_s <= thick - veneer + 1e-6,
                                "thick {thick} depth {di}: the bar pokes through the far core plane ({} > {})",
                                cr.cover + cr.bar_s,
                                thick - veneer
                            );
                        }
                    }
                }
                thin_ran_out |= thick == 0.2 && di == 10 && !steel;
            }
        }
        assert!(thin_ran_out, "VACUOUS: on a 0.2-wu wall at depth 1 the veneer eats the core, so the steel stage MUST be unreachable");
    }

    /// CAUSALITY, not noise: the FIELD is the primary driver, so with one strong
    /// damage patch the first crater lands on it; the modifiers only decide where
    /// on an otherwise featureless wall, and there the splash zone wins — which
    /// is where real cover spalls first. Both halves are pinned because the
    /// balance between them is the effect's whole claim to being causal (the
    /// first weighting shipped had the splash term winning everywhere, and the
    /// craters lined up along the base of every wall in the level).
    #[test]
    fn craters_land_where_the_wall_is_failing() {
        let f = face();
        let cr = &craters(&f, &patchy, 0.6, &anywhere)[0];
        assert!((cr.c - Vec2::new(13.0, 1.4)).length() < 0.6, "the arg-max site is the damage patch: {:?}", cr.c);
        let flat = |_: f32, _: f32| 0.55;
        let base = &craters(&f, &flat, 0.6, &anywhere)[0];
        assert!(base.c.y < 0.8, "on a uniformly tired wall the splash zone wins: {:?}", base.c);
        // …and a window REVEAL outranks the middle of a sound wall, read
        // straight off the run rect (this is the gym's 0.4-wu pier between the
        // z=8 facade's window and the doorway)
        let jamb = Face { u0: 4.7, u1: 5.1, run_u0: 2.9, run_u1: 5.1, ..face() };
        assert!(reveal(&jamb, 4.72) > 0.15, "the window reveal is loaded");
        assert!(reveal(&jamb, 5.08) < 0.01, "…and a RUN end is not (see the caveat on `reveal`)");
    }

    /// The geometry the mesh pass leans on, pinned as invariants rather than
    /// checked downstream: the rim is inside the patch rect, the ring traces the
    /// rect, both are sampled on the same rays (so every quad between them is
    /// valid), and nothing leaves the pier's own face.
    #[test]
    fn the_rim_is_inside_the_patch_rect_and_the_ring_traces_it() {
        let f = face();
        for dial in [0.2, 0.5, 0.8, 1.0] {
            for cr in craters(&f, &patchy, dial, &anywhere) {
                assert_eq!(cr.rim.len(), cr.ring.len(), "one ray per vertex");
                assert!(cr.rim.len() >= 2 * RIM_C_MIN, "at least a corner and a ragged point per facet");
                assert!(cr.lo.x >= f.u0 + EDGE_MARGIN - 1e-4 && cr.hi.x <= f.u1 - EDGE_MARGIN + 1e-4, "cover survives at the pier's ends");
                assert!(cr.lo.y >= f.y0 + EDGE_MARGIN - 1e-4 && cr.hi.y <= f.y1 - EDGE_MARGIN + 1e-4, "…and at its base and top");
                let mut area = 0.0;
                for i in 0..cr.rim.len() {
                    let (a, b) = (cr.rim[i], cr.rim[(i + 1) % cr.rim.len()]);
                    area += a.perp_dot(b);
                    assert!(a.cmpge(cr.lo).all() && a.cmple(cr.hi).all(), "rim vertex outside the patch: {a:?} in {:?}..{:?}", cr.lo, cr.hi);
                    // the ring vertex is on the rect boundary, along the SAME ray
                    let r = cr.ring[i];
                    assert!(
                        (r.x - cr.lo.x).abs() < 1e-4 || (r.x - cr.hi.x).abs() < 1e-4 || (r.y - cr.lo.y).abs() < 1e-4 || (r.y - cr.hi.y).abs() < 1e-4,
                        "ring vertex off the rect: {r:?}"
                    );
                    assert!((r - cr.c).perp_dot(a - cr.c).abs() < 1e-3, "ring and rim must share a ray");
                }
                assert!(area > 0.0, "the rim must be CCW (the mesh pass triangulates it)");
            }
        }
    }

    /// The MAT is world-anchored, which is the whole reason the cage reads as
    /// one wall's reinforcement: two piers cut out of the same run expose bars
    /// at the same world coordinates, and every exposed bar crosses its crater.
    #[test]
    fn the_cage_is_world_anchored_and_every_exposed_bar_crosses_its_crater() {
        let f = face();
        for cr in craters(&f, &patchy, 0.9, &anywhere) {
            assert!(!cr.bars.is_empty());
            for b in &cr.bars {
                let (at, ctr, half) = if b.along_y {
                    (b.at, cr.c.x, (cr.hi.x - cr.lo.x) * 0.5)
                } else {
                    (b.at, cr.c.y, (cr.hi.y - cr.lo.y) * 0.5)
                };
                assert!((at - ctr).abs() < half, "an exposed bar must cross its crater");
                // on the world lattice, not the pier's
                let k = if b.along_y { at / PITCH_U } else { (at - BAR_Y0) / PITCH_Y };
                assert!((k - k.round()).abs() < 1e-4, "bar off the world mat: {at}");
                assert!(b.v1 - b.v0 > 2.0 * BURY, "a bar segment must span its crater");
                assert!(b.v0 > f.y0 - 1e-3 || !b.along_y, "…inside the pier box");
            }
            // 2-3 bars: a cage, never one lonely bar (bar pitch 0.4/0.5 wu
            // against a 0.35-0.7 × 0.15-0.30 lens)
            assert!(cr.bars.len() >= 2, "a crater must show a bar AND a crossing, got {}", cr.bars.len());
        }
    }

    /// A 0.4-wu pier (the two flanking the gym's doorway = 16 px) must either
    /// carry a crater that FITS with cover surviving at both ends, or none at
    /// all — a crater reaching the jamb would open the hollow core.
    #[test]
    fn a_sixteen_pixel_pier_clamps_its_crater_or_skips_it() {
        let narrow = Face { u0: 4.7, u1: 5.1, run_u0: 2.9, run_u1: 5.1, ..face() };
        let cs = craters(&narrow, &|_, _| 0.7, 1.0, &anywhere);
        for cr in &cs {
            assert!(cr.lo.x >= narrow.u0 + EDGE_MARGIN - 1e-4, "cover survives the jamb: {:?}", cr.lo);
            assert!(cr.hi.x <= narrow.u1 - EDGE_MARGIN + 1e-4, "…on both sides: {:?}", cr.hi);
            assert!(cr.hi.x - cr.lo.x > 0.1, "…and what is left still reads (4+ px)");
            // the lens has to LIE along the pier (there is no room across it),
            // and it still exposes steel — the ties, since the placeable window
            // on a 16-px pier is one point and the mat's verticals need not pass
            // through it (see EDGE_MARGIN)
            assert!(cr.hi.y - cr.lo.y > cr.hi.x - cr.lo.x, "a narrow pier's spall runs vertically: {:?}", cr.rect());
            assert!(!cr.bars.is_empty(), "…and still exposes steel");
        }
        assert!(!cs.is_empty(), "the doorway jamb is exactly where cover spalls — it must not be skipped");
    }

    /// Determinism, and independence from the knobs that do not belong to this
    /// effect: same face, same dial, same craters, every call.
    #[test]
    fn craters_are_a_pure_function_of_the_face_and_the_dial() {
        let f = face();
        let a = craters(&f, &patchy, 0.7, &anywhere);
        let b = craters(&f, &patchy, 0.7, &anywhere);
        assert_eq!(a.len(), b.len());
        for (x, y) in a.iter().zip(&b) {
            assert_eq!(x.c, y.c);
            assert_eq!(x.rim, y.rim);
            assert_eq!(x.floor, y.floor);
        }
        // a different facade tells a different story
        let other = Face { seed: 96.4, ..face() };
        assert_ne!(craters(&other, &patchy, 0.7, &anywhere)[0].rim, a[0].rim);
    }

    /// THE SHAPE, pinned as a measurement rather than as a screenshot (owner,
    /// 2026-07-25: "owalne dziury nie są realistyczne").
    ///
    /// Two statistics separate a broken plate from a perturbed oval, and both
    /// are structural rather than tuned:
    ///
    /// - some vertex turns HARD — a fracture corner. A smooth `r(θ)` sampled at
    ///   N rays spreads its 2π of turning evenly, so no vertex can exceed
    ///   ≈ 2·2π/N ≈ 0.6 rad however violent the noise is.
    /// - some vertex barely turns at all — the interior of a straight facet.
    ///   On a curve every sample turns by ≈ 2π/N ≈ 0.3 rad; there is no
    ///   straight run to find.
    ///
    /// Measured over four facades: max turn 1.90..2.43 rad, min turn
    /// 0.001..0.031, so the gates below sit an order of magnitude clear of the
    /// old generator's ceiling and floor. The third assert is the invariant the
    /// MESH rests on — the ring of quads between `rim` and `ring` is only valid
    /// while the rim is star-shaped about `c`.
    #[test]
    fn the_rim_is_a_broken_plate_and_not_a_perturbed_oval() {
        let f = face();
        let mut seen = 0;
        for seed in [41.2f32, 96.4, 12.0, 77.7] {
            let f = Face { seed, ..f };
            for cr in craters(&f, &patchy, 0.8, &anywhere) {
                let n = cr.rim.len();
                let turn = |i: usize| {
                    let (a, b, c) = (cr.rim[(i + n - 1) % n], cr.rim[i], cr.rim[(i + 1) % n]);
                    let (e0, e1) = ((b - a).normalize_or_zero(), (c - b).normalize_or_zero());
                    e0.perp_dot(e1).atan2(e0.dot(e1))
                };
                let turns: Vec<f32> = (0..n).map(turn).collect();
                let hard = turns.iter().cloned().fold(f32::MIN, f32::max);
                let flat = turns.iter().map(|t| t.abs()).fold(f32::MAX, f32::min);
                assert!(hard > 1.2, "seed {seed}: no fracture corner — this is a curve ({hard:.3} rad)");
                assert!(flat < 0.06, "seed {seed}: no straight facet — this is a curve ({flat:.4} rad)");
                // star-shaped about `c`: polar angle strictly increasing, which
                // is what makes every rim→ring band a valid quad
                let ang = |p: Vec2| (p - cr.c).to_angle();
                for i in 0..n {
                    let d = (ang(cr.rim[(i + 1) % n]) - ang(cr.rim[i])).rem_euclid(std::f32::consts::TAU);
                    assert!(d > 1e-4 && d < std::f32::consts::PI, "seed {seed}: rays out of order at {i} ({d:.5} rad)");
                }
                seen += 1;
            }
        }
        assert!(seen >= 8, "VACUOUS: only {seen} craters measured");
    }
}


