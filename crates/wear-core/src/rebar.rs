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
//!   where a crater actually cuts past its cover. The rest of the mat is a
//!   coordinate rule, not triangles.
//! - **Causal siting.** The crater lands at the arg-max of a corrosion
//!   potential ([`corr`]) built out of what the level already knows: the
//!   normalized damage field (water gets in where the wall is already failing),
//!   the splash zone at the base, the window REVEALS (classified straight off
//!   `Pier::run_lo/run_hi` — a pier end that is not a run end IS a reveal,
//!   because `wall_slab` cuts piers at `mid ± 0.2`; see `reveal` for what that
//!   rule cannot see), and
//!   the parapet band under the cap. Then the site SNAPS onto a bar or a bar
//!   crossing, so the bar the crater exposes is the bar that pushed the cover
//!   off.
//!
//! Everything here is pure geometry in the pier's FACE coordinates `(u, y)`
//! plus a depth measured inward from the face plane; `crack_geom` owns the mesh
//! emission (it is the module that knows about `Frag`, the droop rule and the
//! chamfer). The split is deliberate: this file is testable arithmetic.

// This module's PUBLIC functions are documented in terms of the private
// constants they are made of — `craters` cannot be explained without naming
// `LENS_ALONG`, and `t_cap` cannot be explained without naming `budget`. Those
// names are CODE SPANS, not intra-doc links: a link from a public item to a
// private one is an error under this workspace's `-D warnings` doc gate, and
// silencing it with `allow(rustdoc::private_intra_doc_links)` would leave every
// one of them unchecked — so a later rename of `budget` would rot the prose
// while the gate stayed green. A code span makes no promise rustdoc has to keep.

use crate::field::{hash13, mixf, smoothstep};
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
/// alone. It is [`t_cap`]'s binding constraint: rather than let the relief knob
/// walk the section down to nothing and quietly stop showing steel, the wall's
/// own cover is capped so this floor is never reached.
const BAR_S_MIN: f32 = 0.024;

/// How much of the bar's section must stand proud of the basin floor. Below
/// half, a bar reads as a bump in the basin, which is worse than no bar — so
/// this is the depth a spall MUST reach, and [`t_cap`] is the statement that it
/// always can.
const BAR_PROUD: f32 = 0.5;

/// How far the basin floor sits behind the mat's front face, in bar sections.
/// 1.5 stands the whole section clear and leaves half a section of basin under
/// it — the gap the bar's own cast shadow needs to read, and a cast shadow is
/// the one cue paint cannot fake. Clamped by the depth budget, never by a stage.
const BAR_CLEAR: f32 = 1.5;

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

/// THE CANONICAL SPALL, as half-extents along and across the bar it grew on.
///
/// Its SIZE is a property of the wall, not of the amount: corrosion follows one
/// bar and lifts the plate of cover between it and its neighbours, so a spall is
/// about one bay of the mat across ([`PITCH_U`] = 0.4) and rather more than one
/// along. 0.32 × 0.13 wu = 26 × 11 px on an X-run face, 18 × 7 on the worst Z
/// one. That is the whole reason an AMOUNT can be a count: the size answers to
/// the cage, the count answers to the author.
///
/// `LENS_ALONG` is not free: at its SMALLEST draw it still has to reach half a
/// tie pitch plus half a section (0.25 + 0.018 = 0.268 wu), because that is what
/// makes "a bar AND a crossing" a fact about the geometry rather than a lucky
/// hash — the mat's nearest crossing bar is at most half a pitch away, so a
/// shorter lens leaves some craters showing one lonely bar. `√(1−LENS_VAR) ·
/// 0.32 = 0.277`, pinned by `the_cage_is_world_anchored_…`.
///
/// It replaces a pair that RAMPED with the dial (0.175→0.35 along, 0.075→0.15
/// across), which made one dial mean two things at once — how much cover is
/// gone, and how big the pieces are — and left the bottom of its travel with
/// craters too small to show a crossing.
const LENS_ALONG: f32 = 0.32;
const LENS_ACROSS: f32 = 0.13;
/// ± of the lens's AREA, drawn per crater — two identical holes in one wall read
/// as a stencil. Deliberately expressed in area and not in the half-extents it
/// is applied to (the draw goes through a square root): a ±25 % linear jitter is
/// a ±56 % area jitter, and a spread that wide against a quantum this size is
/// the difference between an amount you can author and an amount you can only
/// observe.
const LENS_VAR: f32 = 0.25;
/// Mean RIM area as a fraction of the ellipse it was drawn from. A drawn rim is
/// a chain of CHORDS between 6-10 corners, so it is inscribed in that ellipse
/// (a hexagon keeps 0.83 of its circle, a decagon 0.94) and [`RIM_JAG`] frays a
/// little more off; the radial noise gives some back. Measured over 800+ craters
/// by `spall_area_is_monotone_and_conserved`, which fails if it drifts.
///
/// It is a CALIBRATION, and the honest kind: the count is solved from a nominal
/// area, so if that nominal were the ellipse's the amount would land ~11 % low
/// on every wall in the game. Measuring it once beats correcting each crater.
const RIM_FILL: f32 = 0.919;

/// The area ONE crater costs — the quantum an amount is spent in. 0.120 wu²,
/// i.e. 2.5 % of the bench's 2.2 × 2.19 slab and 0.9 % of the gym's east facade.
const LENS_AREA: f32 = std::f32::consts::PI * LENS_ALONG * LENS_ACROSS * RIM_FILL;

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

/// Site search lattice — the 0.1-wu authoring grid, the same one
/// `wall::RunField::of` samples the damage field on when it solves a run's
/// thresholds. Every term in [`corr`] is smooth over ≥ 0.3 wu,
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
    /// Veneer thickness — the cover the crater has to break through. Never
    /// deeper than [`t_cap`]: a wall that spalls cannot have grooves deep enough
    /// to leave its own reinforcement nowhere to sit.
    pub veneer: f32,
    /// Slab thickness (the basin depth clamp's denominator).
    pub thick: f32,
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
    /// the veneer (see `BAR_SET`) — the mat lives in the CORE, never in the
    /// veneer's hollow.
    pub cover: f32,
    /// Depth of the basin floor below the wall face.
    pub floor: f32,
    /// Section of the bars this crater exposes — [`BAR_S`] where the core can
    /// hold it, thinned toward `BAR_S_MIN` where the relief knob has eaten the
    /// core.
    pub bar_s: f32,
    /// The bar segments this crater exposes. A spall shows steel BY DEFINITION
    /// — cover that has merely lifted is the `Chips` layer's job — and [`t_cap`]
    /// is what makes that definition survive the relief knob.
    pub bars: Vec<Bar>,
}

impl Crater {
    /// The patch rect, for the caller's containment tests.
    pub fn rect(&self) -> (Vec2, Vec2) {
        (self.lo, self.hi)
    }
    /// The face this crater actually costs — the RIM's own area, measured on
    /// the polygon rather than on the lens it was drawn from, because that is
    /// the hole a viewer sees.
    ///
    /// Unconsumed outside the tests today, and that is the point: it is how
    /// `spall_area_is_monotone_and_conserved` checks the unit against the mesh
    /// instead of against the arithmetic that produced it, and it is what the
    /// panel's achieved-vs-asked row will read when the panel lands.
    #[allow(dead_code)]
    pub fn area(&self) -> f32 {
        let n = self.rim.len();
        0.5 * (0..n).map(|i| self.rim[i].perp_dot(self.rim[(i + 1) % n])).sum::<f32>()
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

/// THE DEEPEST VENEER A SPALLING WALL MAY HAVE — the relief knob's real top on
/// a slab this thick, and the reason [`Crater::bars`] is never empty.
///
/// Cover, basin and section all come out of the same solid: the veneer eats the
/// core from BOTH faces, so a deep relief leaves the mat nowhere to sit. That
/// used to be a documented limit — "above relief ≈ 0.72 on the gym's 0.2-wu
/// walls the dial stops at LIFTED COVER" — which is a polite way of saying that
/// one dial silently deleted another dial's effect, with nothing on screen to
/// say why. The three bounds below are exactly the three the `budget`
/// arithmetic imposes, solved for the veneer instead of tested against it:
///
/// 1. the basin must reach `BAR_PROUD` of a minimum section past the cover;
/// 2. …without passing `BASIN_MAX_FRAC` of the slab;
/// 3. the WHOLE section must fit between the core's two planes, since the far
///    face carries the same mat mirrored.
///
/// On the gym's 0.2-wu walls this caps the veneer at 0.082 against a knob top
/// of 0.090 — the last 9 % of the relief slider, which is what that "honest
/// limit" was actually costing. The caller applies it (`CrazeCfg::new`) and the
/// level says so out loud (`wall::Miss::Clamped`); `budget` only checks that
/// somebody did.
pub fn t_cap(thick: f32) -> f32 {
    let knee = BAR_PROUD * BAR_S_MIN;
    let a = 0.5 * (thick - REAR - BAR_SET - knee);
    let b = BASIN_MAX_FRAC * thick - BAR_SET - knee;
    let c = 0.5 * (thick - 2.0 * BAR_SET - BAR_S_MIN);
    // …minus a thousandth of a wu (a twentieth of a screen pixel). Solving the
    // bound exactly lands the section ON `BAR_S_MIN`, where f32 rounding
    // decides whether a bar is emitted at all — measured: a 0.3-wu slab at
    // relief 1 came out at 0.023999996 and dropped its steel.
    (a.min(b).min(c) - 0.001).max(0.0)
}

/// The crater's depth budget on one face: where the mat sits, how deep the basin
/// may cut and how fat a bar the remaining core can hold.
///
/// All three come off the CORE, never off the slab — the veneer is a shell of
/// plates on BOTH faces (`craze_pier` insets the core by `cfg.t` each side), so
/// the solid a crater actually eats into is `thick - 2·veneer`. Measuring the
/// clamp against the slab is what let the floor reach the core's rear plane at
/// depth knob 0.6 and pass through it above that.
fn budget(f: &Face) -> (f32, f32, f32) {
    debug_assert!(f.veneer <= t_cap(f.thick) + 1e-6, "a Face was built with a veneer past t_cap ({} > {})", f.veneer, t_cap(f.thick));
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

/// The craters that lose `area` of this face, worst site first.
///
/// `area` is the layer unit the whole authoring model runs on: **the fraction of
/// this face whose cover is gone**. It is spent, not staged. Each site takes one
/// canonical lens (`LENS_ALONG` × `LENS_ACROSS`, ±`LENS_VAR`) out of the
/// budget, and the loop stops when what is left is worth less than half a
/// crater — so a count falls out of an area instead of the author having to
/// think in counts, and the same 0.10 means the same loss on the bench's 2.2-wu
/// slab and on the gym's 6.2-wu facade.
///
/// **What this replaced, and why none of it survived.** There was ONE staged
/// dial: a 0.12 deadband, then LIFTED COVER (a lens with no steel), then BLOWN
/// SPALL, with extent, depth and count all riding the same number. Three
/// separate faults, and they are the same three the break lattice had:
///
/// - the stages were three different LAYERS on one slider. "Cover lifted but no
///   steel" is a chip — `Layer::Chips` builds exactly that — so a spall that
///   does not show steel is a spall that is not there yet. The dial had to
///   carry that state because chips and spall were not separable amounts.
/// - the amount was not an area, so it could not mean the same thing twice: at
///   dial 0.5 a 2.2-wu slab lost 7 % of its face and a 6.2-wu facade 2.5 %.
/// - the depth ramp's knee was a fraction of the DIAL and the extent ramp was
///   another, so a wall whose cover was too deep for the mat quietly stopped at
///   stage two. That limit is now [`t_cap`]'s job, and it reports.
///
/// The basin depth is no longer a ramp at all: a spall cuts to `BAR_CLEAR`
/// sections behind the mat, or as deep as `budget` allows, whichever is
/// shallower. Depth is a fact about the wall, not about how much of it is gone.
///
/// `fits` lets the caller veto a patch rect it cannot build — on a broken pier a
/// crater has to sit wholly inside one structural piece. It is a parameter
/// rather than a post-filter because a vetoed site must not spend the budget:
/// filtering afterwards made the amount non-monotone (measured — the garden wall
/// lost its crater between 0.25 and 0.55).
pub fn craters(f: &Face, dmg: &dyn Fn(f32, f32) -> f32, area: f32, fits: &dyn Fn(Vec2, Vec2) -> bool) -> Vec<Crater> {
    let target = area.clamp(0.0, 1.0) * (f.u1 - f.u0) * (f.y1 - f.y0);
    if target <= 0.0 {
        return Vec::new();
    }
    // Depth: the mat sits just behind the cover (never in it), and the floor
    // cuts past it far enough for the bar to cast into the basin. `t_cap`
    // guarantees `cover + BAR_PROUD·bar_s <= basin_max`, so the clamp below can
    // never land in front of the knee and the steel always shows.
    let (cover, basin_max, bar_s) = budget(f);
    let floor = (cover + BAR_CLEAR * bar_s).clamp(cover + BAR_PROUD * bar_s, basin_max);

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
    // There is no corrosion FLOOR any more. The amount says how much cover is
    // gone and the potential says where it goes first; a threshold on top of
    // both would silently overrule the author on exactly the walls he dialled.

    // HOW MANY craters that is — the amount, quantized in whole craters, with a
    // floor of one so a nonzero ask always renders something (a dial that does
    // nothing on the wall the owner picked is the deadband this round deleted).
    //
    // Deciding the count UP FRONT is what makes the amount monotone BY
    // CONSTRUCTION rather than by tuning: the candidate order does not depend on
    // the budget, so a larger amount takes a superset of the sites a smaller one
    // took. Spending a running total instead — take a crater while it fits the
    // remaining budget — reads more natural and is not monotone: a bigger ask
    // can accept an early large crater that then blocks two later ones.
    let want = (target / LENS_AREA).round().max(1.0) as usize;

    let mut out: Vec<Crater> = Vec::new();
    for (_, p) in cand {
        if out.len() >= want {
            break;
        }
        // one lens per site, its size drawn ± LENS_VAR so two holes in one wall
        // are not the same hole twice
        let s = (1.0 + LENS_VAR * (2.0 * hash13(Vec3::new(p.x * 2.9 + 5.0, p.y * 4.1 + 3.0, f.seed + 17.0)) - 1.0)).sqrt();
        let Some(site) = site(f, p, LENS_ALONG * s, LENS_ACROSS * s, bar_s) else { continue };
        if !fits(site.lo, site.hi) {
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
            site.lo.x < o.hi.x + PATCH_GAP && o.lo.x < site.hi.x + PATCH_GAP && site.lo.y < o.hi.y + PATCH_GAP && o.lo.y < site.hi.y + PATCH_GAP
        }) {
            continue;
        }
        out.push(site.build(f.seed, cover, floor, bar_s, (RIM_C_MIN, RIM_C_MAX)));
    }
    out
}

// ---------------------------------------------------------------------------
// The PLACED crater — the artillery hit
// ---------------------------------------------------------------------------

/// The smallest shell radius worth building. Below it the hit is a chip —
/// `Layer::Chips` builds exactly that — so the caliber dial's bottom stops
/// here instead of shading into a second effect.
pub const SHELL_R_MIN: f32 = 0.10;

/// The patch half-extent a shell of radius `r` needs (a shell is round, so one
/// number serves both axes). ONE definition, because two callers must agree on
/// it: the authoring model's legality clamp (`wall::compile_specs` keeps every
/// authored centre where this patch fits the RUN) and [`shell_crater`] here.
pub fn shell_patch_half(r: f32) -> f32 {
    r * (1.0 + RIM_VAR) + RIM_PAD
}

/// The largest shell radius whose patch still has a legal centre on a face of
/// these extents — [`shell_patch_half`] inverted against the face's own room.
/// The authoring model clamps the caliber dial to this and REPORTS the clamp
/// (`wall::Miss::Clamped`), so "the hole I authored is not in the shot" can
/// never be a silent state.
pub fn shell_r_cap(len: f32, height: f32) -> f32 {
    let room = 0.5 * len.min(height) - EDGE_MARGIN;
    ((room - RIM_PAD) / (1.0 + RIM_VAR)).max(0.0)
}

/// The legal-centre box for a shell of radius `r`, in face-local coordinates
/// (0..len, 0..height) — `None` when the patch does not fit. The COMPILER
/// clamps every authored centre into this box (`wall::compile_shells`), so
/// [`shell_crater`]'s own clamp is a no-op on compiled data and a place the
/// author clicked is the place the crater opens.
pub fn shell_center_box(len: f32, height: f32, r: f32) -> Option<(Vec2, Vec2)> {
    let pu = shell_patch_half(r);
    let (lo, hi) = (Vec2::splat(EDGE_MARGIN + pu), Vec2::new(len - EDGE_MARGIN - pu, height - EDGE_MARGIN - pu));
    (lo.x <= hi.x && lo.y <= hi.y).then_some((lo, hi))
}

/// A PLACED shell crater: authored centre (face coords) and radius, both the
/// author's — nothing here is drawn from the corrosion potential, because an
/// artillery hit is not corrosion. What it shares with the spall is everything
/// downstream of the place: the same depth budget, the same polygon rim, the
/// same mat — `emit_crater` cannot tell the two apart, which is the point.
///
/// Three deliberate differences from `site`:
/// - ROUND (`hu = hy = r`) and NOT snapped onto a bar: a shell lands where it
///   lands, and the world-anchored mat crosses it wherever it crosses — both
///   families over the whole patch, which is what makes the cage read as a
///   CAGE in a hole this size.
/// - The rim's corner count scales with the perimeter. The spall's 6-10
///   corners put a facet every 7-9 px; a shell 2-4× the lens would stretch the
///   same corners into an obvious polygon.
/// - The floor digs to the honest depth limit (`budget`'s `basin_max`) instead
///   of stopping `BAR_CLEAR` sections past the mat: a hit excavates, cover
///   corrosion only lifts. Still a crater, never a perforation — the through
///   hole is a renderer-contract change (occluders, WALLCUT, light) and it is
///   deliberately NOT this round.
///
/// Returns `None` when THIS face cannot hold the patch — the run-level fit is
/// the compiler's promise, but a run's narrow pier (the 0.4-wu doorway
/// flanks) can still be asked for a hole it has no room for, and a shell that
/// cannot fit is skipped rather than shrunk: a smaller hole is a different
/// authored statement.
pub fn shell_crater(f: &Face, at: Vec2, r: f32) -> Option<Crater> {
    let (cover, basin_max, bar_s) = budget(f);
    // deepest honest floor, with the spall's own clamp so the steel always
    // stands proud of the basin ([`BAR_PROUD`])
    let floor = basin_max.max(cover + BAR_PROUD * bar_s);
    let pu = shell_patch_half(r);
    let (lo_c, hi_c) = (
        Vec2::new(f.u0 + EDGE_MARGIN + pu, f.y0 + EDGE_MARGIN + pu),
        Vec2::new(f.u1 - EDGE_MARGIN - pu, f.y1 - EDGE_MARGIN - pu),
    );
    if lo_c.cmpgt(hi_c).any() {
        return None;
    }
    let c = at.clamp(lo_c, hi_c);
    let (lo, hi) = (c - Vec2::splat(pu), c + Vec2::splat(pu));
    // Both families of the world mat, wherever they cross the hole — same
    // graze veto as the spall (a bar clipping the rim reads as a nick).
    let mut bars = Vec::new();
    if bar_s > 0.0 {
        for (vertical, pitch, base) in [(true, PITCH_U, 0.0), (false, PITCH_Y, BAR_Y0)] {
            let ctr = if vertical { c.x } else { c.y };
            let (i0, i1) = (((ctr - r - base) / pitch).ceil() as i32, ((ctr + r - base) / pitch).floor() as i32);
            for i in i0..=i1 {
                let bat = base + i as f32 * pitch;
                if (bat - ctr).abs() > r - 0.5 * bar_s {
                    continue;
                }
                let (v0, v1) = if vertical { (lo.y, hi.y) } else { (lo.x, hi.x) };
                bars.push(Bar { along_y: vertical, at: bat, v0: v0 - BURY, v1: v1 + BURY });
            }
        }
    }
    // corner count ∝ perimeter, so the facet length stays in the spall's
    // measured 7-9 px window whatever the caliber
    let scale = r / (0.5 * (LENS_ALONG + LENS_ACROSS));
    let nc_min = ((RIM_C_MIN as f32 * scale).round() as usize).clamp(RIM_C_MIN, 20);
    let nc_max = ((RIM_C_MAX as f32 * scale).round() as usize).clamp(nc_min + 2, 28);
    Some(Site { c, hu: r, hy: r, lo, hi, bars }.build(f.seed, cover, floor, bar_s, (nc_min, nc_max)))
}

/// A crater's PLACE, before its outline is drawn. The split is a cost one and
/// it earns its keep the moment a face carries more than a handful of craters:
/// the caller vetoes a site on its rect alone (the `fits` test, the pairwise
/// disjointness), and tracing 20-odd rays for a site about to be thrown away is
/// the one avoidable cost in this pass.
struct Site {
    c: Vec2,
    hu: f32,
    hy: f32,
    lo: Vec2,
    hi: Vec2,
    bars: Vec<Bar>,
}

impl Site {
    /// Draw the rim and make the crater. Split out of `site` on cost, not on
    /// meaning: everything here is a pure function of the place. `nc` is the
    /// rim's corner-count range — the spall lens always passes
    /// ([`RIM_C_MIN`], [`RIM_C_MAX`]); a shell scales it with its perimeter.
    fn build(self, seed: f32, cover: f32, floor: f32, bar_s: f32, nc: (usize, usize)) -> Crater {
        let (rim, ring) = outline(self.c, self.hu, self.hy, seed, self.lo, self.hi, &self.bars, nc);
        Crater { c: self.c, rim, ring, lo: self.lo, hi: self.hi, cover, floor, bar_s, bars: self.bars }
    }
}

/// Snap a candidate site onto the mat, or `None` when the pier is too narrow to
/// carry a readable crater (two building piers are only 0.4 wu = 16 px wide).
fn site(f: &Face, p: Vec2, ha: f32, hb: f32, bar_s: f32) -> Option<Site> {
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
    let cy = p.y.clamp(lo_c.y, hi_c.y);
    if (cy - p.y).abs() > 0.34 * py {
        return None;
    }
    let p = Vec2::new(p.x.clamp(lo_c.x, hi_c.x), cy);

    // THEN snap onto the mat — after the clamp and inside the legal box, not
    // before it. A bar dead-centre in every crater looks PLACED, so: across the
    // bar the crater is centred on it but offset a fraction of its own
    // half-extent; along the bar it keeps the corrosion max, EXCEPT at a
    // crossing, where it snaps to the intersection — two bars' cover overlapping
    // is exactly where real spalls open, and a crossing is what makes the cage
    // read as a cage.
    //
    // Order matters and used to be the other way round: the site snapped onto a
    // bar and the CLAMP then dragged it off again, by up to a third of the patch
    // rect. Near a face's edge that was more than the lens's own half-extent
    // across the bar, so the bar it had been snapped to fell outside the rim and
    // the crater came out with one lonely bar in it (measured on the gym's east
    // facade). Snapping inside the box makes "a bar and a crossing" hold by
    // construction wherever the box is at least one pitch wide.
    let snap = |v: f32, pitch: f32, base: f32, lo: f32, hi: f32| {
        let k = ((v - base) / pitch).round();
        let (i0, i1) = (((lo - base) / pitch).ceil(), ((hi - base) / pitch).floor());
        // no bar of this family lies inside the legal box (the 0.4-wu piers
        // flanking the doorway are narrower than one pitch): keep the nearest
        // one anyway and let the graze test decide whether it shows
        base + if i1 < i0 { k } else { k.clamp(i0, i1) } * pitch
    };
    let ub = snap(p.x, PITCH_U, 0.0, lo_c.x, hi_c.x);
    let yb = snap(p.y, PITCH_Y, BAR_Y0, lo_c.y, hi_c.y);
    let cross = h(3.0) < 0.45;
    let (off, along_off) = ((h(7.0) - 0.5) * 0.7, (h(11.0) - 0.5) * 0.5);
    let c = if along_y {
        Vec2::new(ub + off * hu, if cross { yb + along_off * hy } else { p.y })
    } else {
        Vec2::new(if cross { ub + along_off * hu } else { p.x }, yb + off * hy)
    };
    let c = c.clamp(lo_c, hi_c);
    let (lo, hi) = (c - Vec2::new(pu, py), c + Vec2::new(pu, py));

    // The bars this crater exposes. A segment spans the whole PATCH RECT plus
    // `BURY` at each end, so both end caps sit in core solid rather than in the
    // cavity (see `BURY`). There is no "deep enough yet" test any more: the
    // floor clears `BAR_PROUD` of the section by construction ([`t_cap`]), so a
    // spall shows steel or the caller broke the cap.
    let mut bars = Vec::new();
    if bar_s > 0.0 {
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
    Some(Site { c, hu, hy, lo, hi, bars })
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
#[allow(clippy::too_many_arguments)]
fn outline(c: Vec2, hu: f32, hy: f32, seed: f32, lo: Vec2, hi: Vec2, bars: &[Bar], nc: (usize, usize)) -> (Vec<Vec2>, Vec<Vec2>) {
    let tau = std::f32::consts::TAU;
    // Everything until the last two lines happens in the lens's NORMALIZED frame
    // (where the lens is the unit circle) — including the rect-corner rays, which
    // is the frame they were already measured in.
    let h = |k: f32| hash13(Vec3::new(c.x * 3.1 + k, c.y * 4.7 + 1.0, seed + 0.5));
    let (nc_min, nc_max) = nc;
    let nc = nc_min + (h(0.0) * (nc_max - nc_min + 1) as f32) as usize;
    let nc = nc.min(nc_max);
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
        Face { u0: 9.9, u1: 16.1, y0: 0.0, y1: 2.1875, run_u0: 9.9, run_u1: 16.1, veneer: 0.05, thick: 0.2, seed: 41.2 }
    }
    /// The face area an amount is a fraction OF.
    fn face_area(f: &Face) -> f32 {
        (f.u1 - f.u0) * (f.y1 - f.y0)
    }
    /// What a face actually lost, as a fraction of itself — the answer to the
    /// only question the unit poses.
    fn lost(f: &Face, cs: &[Crater]) -> f32 {
        cs.iter().map(|c| c.area()).sum::<f32>() / face_area(f)
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

    /// **AN AMOUNT IS AN AREA** — the one claim the layer model makes about this
    /// effect, measured on the rim polygons the mesh pass actually emits.
    ///
    /// Three properties, and each of them replaces a defect the staged dial had:
    ///
    /// - MONOTONE, and by construction rather than by tuning: the candidate
    ///   order does not depend on the budget, so more area takes a SUPERSET of
    ///   the same sites. (The old dial was non-monotone the moment a caller
    ///   vetoed a site, which is why `fits` is a parameter and not a filter.)
    /// - CONSERVED: what a face loses is what was asked for, within the quantum
    ///   — one crater, [`LENS_AREA`], 2.3 % of the bench slab.
    /// - SIZE-INDEPENDENT: 0.10 means the same loss on a 2.2-wu slab as on a
    ///   6.2-wu facade. The dial it replaced meant 7 % on one and 2.5 % on the
    ///   other, which is precisely why an "amount" that is not an area cannot be
    ///   authored against.
    ///
    /// It also PRINTS the two numbers the design rests on: the mean rim fill
    /// ([`RIM_FILL`]'s calibration) and the largest area a face can actually be
    /// packed with, which is the ceiling `wall::derive` maps the cover-loss cause
    /// onto.
    #[test]
    fn spall_area_is_monotone_and_conserved() {
        let bench = || Face { u0: 6.0, u1: 8.2, run_u0: 6.0, run_u1: 8.2, ..face() };
        let (mut fill_sum, mut fill_n, mut ceiling) = (0.0f32, 0usize, 1.0f32);
        for f in [face(), bench()] {
            let mut prev: Vec<(Vec2, Vec2)> = Vec::new();
            let mut worst = 0.0f32;
            for k in 0..=20 {
                let asked = k as f32 / 20.0 * 0.30;
                let cs = craters(&f, &patchy, asked, &anywhere);
                // monotone: every rect of the smaller ask is still here
                for r in &prev {
                    assert!(cs.iter().any(|c| c.rect() == *r), "asked {asked:.3}: a crater the smaller amount had is gone");
                }
                prev = cs.iter().map(|c| c.rect()).collect();
                for c in &cs {
                    let (hu, hy) = ((c.hi.x - c.lo.x) * 0.5 - RIM_PAD, (c.hi.y - c.lo.y) * 0.5 - RIM_PAD);
                    fill_sum += c.area() / (std::f32::consts::PI * hu * hy / (1.0 + RIM_VAR).powi(2));
                    fill_n += 1;
                }
                let got = lost(&f, &cs);
                // Conserved — within the QUANTUM (half a crater, the rounding)
                // plus what the ±LENS_VAR draw is worth over the craters that
                // were actually built. Independent draws, so √n and not n: the
                // worst case is real but it is not what a wall looks like, and a
                // tolerance nobody could ever hit pins nothing.
                let want = (asked * face_area(&f) / LENS_AREA).round().max(1.0);
                let quantum = LENS_AREA * (0.5 + LENS_VAR * want.sqrt()) / face_area(&f);
                if asked > 0.0 && got + 1e-6 < asked - quantum {
                    // an ask the packing cannot deliver: record the ceiling
                    // rather than fail — it is a real property of the face
                    ceiling = ceiling.min(got);
                } else {
                    assert!(got <= asked + quantum, "asked {asked:.3} of a {:.1}-wu face, lost {got:.3} (quantum {quantum:.3})", f.u1 - f.u0);
                }
                worst = worst.max(got);
            }
            println!("face {:.1} wu: densest packing {worst:.3} of the face", f.u1 - f.u0);
        }
        assert!(fill_n >= 200, "VACUOUS: only {fill_n} craters measured");
        let fill = fill_sum / fill_n as f32;
        println!("mean rim fill {fill:.3} (RIM_FILL = {RIM_FILL}), packing ceiling {ceiling:.3}");
        assert!((fill - RIM_FILL).abs() < 0.03, "RIM_FILL is miscalibrated: measured {fill:.3}");
        // …and the same amount is the same LOSS on both faces, which is the
        // whole point of the unit
        let (a, b) = (lost(&face(), &craters(&face(), &patchy, 0.10, &anywhere)), lost(&bench(), &craters(&bench(), &patchy, 0.10, &anywhere)));
        assert!((a - b).abs() < 0.04, "0.10 means {a:.3} on a 6.2-wu face and {b:.3} on a 2.2-wu one");
    }

    /// THE DEPTH BUDGET, over the whole (relief × amount) grid the owner can
    /// reach: the mat never sits in the veneer's hollow, and the basin never
    /// reaches the CORE's rear plane. Both bounds were wrong in the first cut and
    /// both were invisible in a shot — the bar showed through grooves on walls
    /// with no crater, and the floor went coplanar with the core's back face at
    /// relief 0.6 — so they are pinned as arithmetic, per wall thickness.
    ///
    /// The gym's own walls are the 0.2 row; 0.3 stands in for a thicker slab.
    #[test]
    fn the_mat_is_always_buried_and_the_basin_never_reaches_the_cores_rear_plane() {
        for thick in [0.2f32, 0.3] {
            for di in 0..=10 {
                let veneer = crate::wall::veneer(di as f32 / 10.0, thick).min(t_cap(thick));
                let f = Face { veneer, thick, ..face() };
                for area in [0.02f32, 0.05, 0.10, 0.20, 0.30] {
                    for cr in craters(&f, &patchy, area, &anywhere) {
                        assert!(cr.cover >= veneer, "thick {thick} relief {di}: the mat is in the veneer's hollow ({} < {veneer})", cr.cover);
                        assert!(
                            cr.floor <= thick - veneer - REAR + 1e-6,
                            "thick {thick} relief {di} area {area}: the basin reaches the core's rear plane ({} > {})",
                            cr.floor,
                            thick - veneer - REAR
                        );
                        assert!(cr.floor >= veneer, "thick {thick} relief {di}: a crater shallower than the cover it lost");
                        assert!(cr.bar_s >= BAR_S_MIN, "a sub-readable bar was emitted: {}", cr.bar_s);
                        // the WHOLE section inside the core, because the far
                        // face carries the same mat mirrored (see `budget`)
                        assert!(
                            cr.cover + cr.bar_s <= thick - veneer + 1e-6,
                            "thick {thick} relief {di}: the bar pokes through the far core plane ({} > {})",
                            cr.cover + cr.bar_s,
                            thick - veneer
                        );
                    }
                }
            }
        }
    }

    /// **THE RELIEF KNOB CANNOT DELETE THE MAT.** A spall shows steel — that is
    /// what makes it a spall and not a chip — so at EVERY relief setting on
    /// every wall thickness the game has, every crater carries bars.
    ///
    /// What this replaces was a documented limit: "above relief ≈ 0.72 on the
    /// gym's 0.2-wu walls there is no core left, so that wall stays at LIFTED
    /// COVER however far the spall dial goes". One dial silently deleting
    /// another's effect, with nothing on screen to say why — and the honest cost
    /// of removing it is the top 9 % of the relief slider, which the vacuity
    /// guard below measures rather than assumes.
    #[test]
    fn relief_cannot_delete_the_mat() {
        let mut bit = 0;
        for thick in [0.2f32, 0.25, 0.3] {
            for di in 0..=10 {
                let relief = di as f32 / 10.0;
                let asked = crate::wall::veneer(relief, thick);
                let veneer = asked.min(t_cap(thick));
                bit += (veneer < asked - 1e-6) as usize;
                let f = Face { veneer, thick, ..face() };
                let cs = craters(&f, &patchy, 0.10, &anywhere);
                assert!(!cs.is_empty(), "thick {thick} relief {relief}: a 10 % ask built nothing");
                for cr in &cs {
                    assert!(!cr.bars.is_empty(), "thick {thick} relief {relief}: a spall with no steel in it");
                    assert!(cr.floor >= cr.cover + BAR_PROUD * cr.bar_s - 1e-6, "the bar does not stand proud: floor {} cover {}", cr.floor, cr.cover);
                }
            }
        }
        assert!(bit > 0, "VACUOUS: t_cap never bit, so this test proves nothing about the relief knob");
        // …and it costs the TOP of the slider only: on the gym's own walls the
        // cap is 0.082 against a knob top of 0.090
        assert!(t_cap(0.2) > crate::wall::veneer(0.85, 0.2), "the cap eats more than the last sixth of the relief knob on a 0.2-wu wall");
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
        let cr = &craters(&f, &patchy, 0.02, &anywhere)[0];
        assert!((cr.c - Vec2::new(13.0, 1.4)).length() < 0.6, "the arg-max site is the damage patch: {:?}", cr.c);
        let flat = |_: f32, _: f32| 0.55;
        let base = &craters(&f, &flat, 0.02, &anywhere)[0];
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
        for area in [0.02, 0.08, 0.16, 0.30] {
            for cr in craters(&f, &patchy, area, &anywhere) {
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
        for cr in craters(&f, &patchy, 0.20, &anywhere) {
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
            // against a 0.30 × 0.13 lens, ±25 %)
            assert!(cr.bars.len() >= 2, "a crater must show a bar AND a crossing, got {}", cr.bars.len());
        }
    }

    /// A 0.4-wu pier (the two flanking the gym's doorway = 16 px) must either
    /// carry a crater that FITS with cover surviving at both ends, or none at
    /// all — a crater reaching the jamb would open the hollow core.
    #[test]
    fn a_sixteen_pixel_pier_clamps_its_crater_or_skips_it() {
        let narrow = Face { u0: 4.7, u1: 5.1, run_u0: 2.9, run_u1: 5.1, ..face() };
        let cs = craters(&narrow, &|_, _| 0.7, 0.30, &anywhere);
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
    /// effect: same face, same amount, same craters, every call.
    #[test]
    fn craters_are_a_pure_function_of_the_face_and_the_amount() {
        let f = face();
        let a = craters(&f, &patchy, 0.12, &anywhere);
        let b = craters(&f, &patchy, 0.12, &anywhere);
        assert_eq!(a.len(), b.len());
        for (x, y) in a.iter().zip(&b) {
            assert_eq!(x.c, y.c);
            assert_eq!(x.rim, y.rim);
            assert_eq!(x.floor, y.floor);
        }
        // a different facade tells a different story
        let other = Face { seed: 96.4, ..face() };
        assert_ne!(craters(&other, &patchy, 0.12, &anywhere)[0].rim, a[0].rim);
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
        let (mut seen, mut flattest) = (0, f32::MAX);
        for seed in [41.2f32, 96.4, 12.0, 77.7] {
            let f = Face { seed, ..f };
            for cr in craters(&f, &patchy, 0.20, &anywhere) {
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
                // A straight FACET is a property of the population, not of every
                // rim: each facet carries one ragged midpoint, so whether a given
                // crater has a sample that lands on the straight part is a draw.
                // What no curve can do is produce one at all.
                assert!(flat < 0.20, "seed {seed}: every vertex turns like a sampled curve ({flat:.4} rad)");
                flattest = flattest.min(flat);
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
        println!("flattest vertex over {seen} craters: {flattest:.4} rad");
        assert!(flattest < 0.06, "no rim anywhere has a straight run in it ({flattest:.4} rad over {seen} craters)");
    }

    /// THE PLACED CRATER: it opens exactly where it was asked, digs past the
    /// spall's just-behind-the-mat shelf to the honest depth limit, is crossed
    /// by BOTH mat families, and draws a rim with more corners than any spall
    /// — the 6-10 the lens uses would stretch into an obvious polygon over a
    /// shell's perimeter. Everything else (containment, star shape) it
    /// inherits from the same `outline`, covered by the tests above.
    #[test]
    fn a_shell_crater_is_round_deep_and_carries_both_families() {
        let f = face();
        let at = Vec2::new(12.9, 1.1);
        let cr = shell_crater(&f, at, 0.45).expect("a 6.2-wu face holds a 0.45-wu shell");
        assert!((cr.c - at).length() < 1e-6, "a legal centre is not moved");
        let (cover, basin_max, bar_s) = budget(&f);
        let spall_floor = (cover + BAR_CLEAR * bar_s).clamp(cover + BAR_PROUD * bar_s, basin_max);
        assert!(cr.floor > spall_floor + 0.01, "a hit digs past the spall's shelf: {} vs {spall_floor}", cr.floor);
        assert!(cr.floor <= basin_max + 1e-6, "…but never past the honest limit");
        assert!(cr.bars.iter().any(|b| b.along_y) && cr.bars.iter().any(|b| !b.along_y), "both families cross a hole this size: {:?}", cr.bars.len());
        assert_eq!(cr.rim.len(), cr.ring.len());
        for p in &cr.rim {
            assert!(p.x >= cr.lo.x - 1e-5 && p.x <= cr.hi.x + 1e-5 && p.y >= cr.lo.y - 1e-5 && p.y <= cr.hi.y + 1e-5, "rim point outside the patch rect");
        }
        // corner count ∝ perimeter: at r = 0.45 the range is 12..=20 corners,
        // so even the smallest draw beats the spall's densest rim (2·10+4 rays)
        assert!(cr.rim.len() > 24, "a shell rim must out-sample the spall's densest ({} rays)", cr.rim.len());
        // …and a face that cannot hold the patch says None, never a shrunk hole
        assert!(shell_crater(&Face { u1: f.u0 + 0.4, ..f }, at, 0.45).is_none(), "a 0.4-wu pier cannot hold a 0.45-wu shell");
    }
}


