//! THE BREAKS OF A RUN — an authored COUNT at authored PLACES, and the jagged
//! trunks they grow.
//!
//! A [`Fault`] is a place on the RUN resolved to a world-space path `u(y)`;
//! [`run_breaks`] places the run's whole set (so every panel of a facade
//! computes the identical one and a cut crosses a window jamb), [`faults_for`]
//! keeps the ones that cross a given panel, and [`fault_bolts`] grows each into
//! a through TRUNK plus the surface FORKS that fray off it.

use crate::gym_scene::Pier;
use glam::{Vec2, Vec3};
use rt_probe::Scene;
use super::craze::CrazeCfg;
use super::cut::{any_hit, Bolt, Walk};
use super::poly::rot;
use super::{story_of, Frame};
use wear_core::field::{hash13, mixf, vnoise};

/// One structural break crossing a pier: an authored place on the RUN, resolved
/// to a world-space path `u(y)` on the run axis.
#[derive(Clone)]
pub(super) struct Fault {
    /// Which break of the run this is — the second noise coordinate, so two
    /// breaks of one wall wander differently.
    pub(super) j: f32,
    pub(super) seed: f32,
    pub(super) ax: f32,
    pub(super) tilt: f32,
    /// Gap half-width base (sans the per-y `wvar`).
    pub(super) mw: f32,
    /// Which side drops: +1 = the right (higher-u) piece sinks.
    pub(super) sign: f32,
}

impl Fault {
    pub(super) fn u(&self, y: f32) -> f32 {
        let wob = (vnoise(Vec3::new(y * 0.8, self.j * 7.3, self.seed + 17.0)) - 0.5) * 1.3
            + (vnoise(Vec3::new(y * 4.1, self.j * 7.3, self.seed + 29.0)) - 0.5) * 0.22;
        self.ax + self.tilt * y + wob
    }
    fn wvar(&self, y: f32) -> f32 {
        0.35 + 1.3 * vnoise(Vec3::new(y * 1.7, self.j * 3.1, self.seed + 41.0))
    }
    /// Full gap width at height `y`, tapered wider toward the top (settlement)
    /// and clamped to stay visible without gaping past believability.
    fn gap(&self, y: f32, y0: f32, y1: f32) -> f32 {
        let taper = 0.7 + 0.6 * (y - y0) / (y1 - y0).max(1e-4);
        (2.0 * self.mw * self.wvar(y) * taper).clamp(0.018, 0.09)
    }
}

/// How close to a run's end a break may land, in world units. A break is a
/// through-cut, so the piece it leaves has to read as a piece: below ~0.35 wu
/// (14 px on an X face) it is a sliver hanging off the end, which reads as a
/// modelling error rather than as damage. Also the run's own margin — a run
/// shorter than `2 · MARGIN` gets the proportional version instead, so a short
/// wall asked for a break still gets one.
const BREAK_MARGIN: f32 = 0.35;

/// THE BREAKS OF ONE WALL RUN — an authored COUNT at authored PLACES.
///
/// # What this replaced, and why it had to go
///
/// Until 2026-07-26 a break was a coin flip on a 6-wu STRIP lattice: presence
/// fired at `0.95 · smoothstep(0.12, 0.42, age) · smoothstep(0.04, 0.45,
/// cracks)` per strip, with a second lattice fading in on top of the first. It
/// was wrong in three separate ways, and a level author had no way around any of
/// them:
///
/// - **You could not ask for one.** The knobs bought a PROBABILITY. A 2.2-wu
///   slab holds a strip's axis about a third of the time, so the effect
///   catalogue's break specimen came up EMPTY on its first build — the fix at
///   the time was to widen the slab to four cells until the hash cooperated.
/// - **You could not ask for none.** Presence and the small-crack network share
///   `age`, and the damage field only opens a readable patch above age ≈ 0.5, so
///   at every age where a veneer pattern was visible the odds of also breaking
///   the wall in half were ≥ 0.9. "Cracked but not broken through" needed a veto
///   flag on the specimen to be expressible at all (`breaks: 0` is that state
///   now, and the flag is deleted).
/// - **It disagreed across a joint.** The strips are anchored in RUN space but
///   the roll was seeded PER PANEL, so a strip straddling a window jamb was
///   rolled twice with different seeds: the same break existed on one panel and
///   not on its neighbour, and the crack stopped dead at the opening.
///
/// A count and a place fix all three by construction, and the owner risk that
/// kept the seed per panel ("a shared fault seed would crack a facade at one
/// repeated position") goes with the lattice that caused it: there is no period
/// left to repeat.
///
/// `u0`/`u1` are the RUN's extent on its own axis — not the pier's. Every panel
/// of a run therefore computes the identical break set, and the caller keeps the
/// ones that actually cross it.
pub(super) fn run_breaks(u0: f32, u1: f32, story: f32, b: wear_core::wall::Breaks, relief: f32, cracked: f32) -> Vec<Fault> {
    let m = BREAK_MARGIN.min(0.4 * (u1 - u0));
    b.places(story)
        .into_iter()
        .enumerate()
        .map(|(j, frac)| {
            let h = |s: f32| hash13(Vec3::new(j as f32, story * 13.0 + s, 71.0));
            Fault {
                j: j as f32,
                // the wander/width noise wants a coordinate that differs
                // between RUNS, and the story key is the only thing that does
                seed: story * 6.0,
                ax: mixf(u0 + m, u1 - m, frac),
                tilt: (h(97.0) - 0.5) * 0.8,
                // The GAP a break opens: as deep as the wall's relief allows,
                // widened by how tired the material is. It read `depth × age`
                // before, and age was the wrong half — a wall that is barely
                // cracked does not come apart with a 9 cm gap.
                mw: mixf(0.022, 0.055, relief) * (0.55 + 0.45 * cracked),
                sign: if h(113.0) < 0.5 { 1.0 } else { -1.0 },
            }
        })
        .collect()
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
        let h = |k: f32| hash13(Vec3::new(i as f32 * 1.37, f.seed + k, f.j * 3.7 + 5.0));
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
pub(super) fn fault_bolts(faults: &[Fault], fr: &Frame, cfg: &CrazeCfg) -> Vec<Bolt> {
    let (px1, jag_amt, cracked) = (cfg.px1, cfg.jag, cfg.a_cracks);
    let mut out: Vec<Bolt> = Vec::new();
    // How jagged the trunk runs is the material's own `straight`, at the coarse
    // scale (`CrazeCfg::jag`); how much it FRAYS is how cracked the wall is. Both
    // used to read the `age` knob, which is the job age should never have had:
    // a wall's crack SHAPE and its crack AMOUNT are different questions, and the
    // fork count in particular was `1.9 · cracks · (0.35 + 0.65 · age)` — two
    // dials multiplied to answer one.
    let jag = mixf(0.06, 0.17, jag_amt);
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
        let nf = (0.4 + 1.9 * cracked).round() as usize;
        for j in 0..nf {
            let h = |kk: f32| hash13(Vec3::new(j as f32 * 2.7 + 1.0, f.seed + kk, f.j * 5.3 + 11.0));
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

/// THE BREAKS THAT CROSS THIS PANEL — its share of its RUN's authored set.
///
/// The whole run's breaks are computed first ([`run_breaks`]) and then filtered,
/// which is the only way a panel and its neighbour can agree about a break that
/// lands on the joint between them. There is no veto argument any more:
/// `Breaks { count: 0 }` IS the veto, and it is a thing a level author can type.
pub(super) fn faults_for(scene: &Scene, pier: &Pier, sheet: &wear_core::wall::Sheet) -> Vec<Fault> {
    let fr = Frame::of(pier);
    let (r0, r1) = if fr.run_x { (pier.run_lo.x, pier.run_hi.x) } else { (pier.run_lo.z, pier.run_hi.z) };
    let relief = sheet.geom.relief as f32 / 63.0;
    let cracked = sheet.area[wear_core::wall::Layer::Cracks.index()];
    let mut out: Vec<Fault> = run_breaks(r0, r1, story_of(scene, pier), sheet.breaks, relief, cracked)
        .into_iter()
        .filter(|f| {
            // keep ANY break whose path ENTERS this face somewhere over the
            // pier's height: the path wanders (±0.76 wu at the extremes), so a
            // break anchored just past a panel's end can still cut its corner,
            // and dropping it would leave the neighbouring panel's cut running
            // into a wall that is whole. Corner-clippers become cracked-off
            // edges (the mesh's edge clamps keep pieces >= 0.06 wu wide).
            let (mut lo, mut hi) = (f32::MAX, f32::MIN);
            for s in 0..=6 {
                let u = f.u(fr.y0 + (fr.y1 - fr.y0) * s as f32 / 6.0);
                lo = lo.min(u);
                hi = hi.max(u);
            }
            hi > fr.u0 + 0.02 && lo < fr.u1 - 0.02
        })
        .collect();
    let ymid = (fr.y0 + fr.y1) * 0.5;
    out.sort_by(|a, b| a.u(ymid).total_cmp(&b.u(ymid)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crack_geom::fixtures::*;

    /// (The knob-grain pair that used to sit here — "a drag inside one bucket
    /// rebuilds nothing" and "the fault is quantized like everything else" —
    /// moved to `wall::geom_is_integer_and_moves_only_when_the_mesh_would`. The
    /// quantizer is `wall::compile_specs` now, so that is where the claim
    /// belongs; keeping a copy here would test a `GeoKey` built by hand.)
    /// A SHORT WALL ASKED FOR A BREAK GETS ONE — over every pier of both shipped
    /// levels, at every count the model allows.
    ///
    /// This is the test the old system provably could not pass, and the reason
    /// the round happened. A break used to be a coin flip per 6-wu strip with its
    /// axis uniform inside, so a 2.2-wu catalogue slab held that axis about a
    /// third of the time: the bench's break specimen came up EMPTY on its first
    /// build and had to be widened to four cells until the hash cooperated. Now
    /// the count is the answer.
    ///
    /// Both directions are pinned, because a level author needs both: `count: n`
    /// puts n breaks through the run, and `count: 0` puts none through a wall
    /// that is otherwise as damaged as its neighbours.
    #[test]
    fn a_short_wall_asked_for_a_break_gets_one() {
        let mut one_panel_runs = 0;
        for level in [crate::demos::Level::Gym, crate::demos::Level::Catalogue] {
            let (mut scene, meta) = crate::gym_scene::build_gym(&level.spec(), &crate::look::POLANA);
            crate::wear::stamp_story(&mut scene, &meta.piers);
            for (i, pier) in meta.piers.iter().enumerate() {
                let fr = Frame::of(pier);
                let (r0, r1) = if fr.run_x { (pier.run_lo.x, pier.run_hi.x) } else { (pier.run_lo.z, pier.run_hi.z) };
                assert!(
                    faults_for(&scene, pier, &hot(0)).is_empty(),
                    "{level:?} pier {i}: count 0 still broke the wall — the veto is not a veto"
                );
                for n in 1..=wear_core::wall::Breaks::MAX {
                    let b = wear_core::wall::Breaks { count: n, at: None };
                    // the RUN gets exactly what it asked for…
                    assert_eq!(
                        run_breaks(r0, r1, story_of(&scene, pier), b, REL, CRK).len(),
                        n as usize,
                        "{level:?} pier {i}: run [{r0}, {r1}] asked for {n} breaks"
                    );
                    // …and no panel of it is left whole while its neighbour is
                    // cut, which is what the per-panel roll used to do
                    let mine = faults_for(&scene, pier, &with_breaks(b)).len();
                    assert!(mine <= n as usize, "{level:?} pier {i}: {mine} breaks from a run of {n}");
                }
                // the run's own share, summed over its panels, must cover it: a
                // single-pier run IS its run, so it can never come up empty
                if (r1 - r0 - (fr.u1 - fr.u0)).abs() < 1e-4 {
                    one_panel_runs += 1;
                    assert_eq!(faults_for(&scene, pier, &broken(0)).len(), 1, "{level:?} pier {i}: a one-panel run asked for a break and got none");
                }
            }
        }
        // the catalogue is fifteen one-panel runs and the gym has the two garden
        // walls, so a zero here means the strongest arm of the test was skipped
        assert!(one_panel_runs > 15, "VACUOUS: only {one_panel_runs} one-panel runs were checked");
    }

    /// TWO RUNS MUST NOT BREAK ALIKE — the hash-bias guard.
    ///
    /// A break's lean, its drop direction and its story-seeded place all come off
    /// `hash13` at coordinates derived from the run's story key, and this codebase
    /// has already been burnt once by exactly that: `crack::run_ramp` drew its
    /// gradient sign off the noise's x axis and all twelve trial runs came out
    /// leaning the same way, because `hash13` carries a bias at small offsets. So
    /// the variety is a measured claim, not an assumption.
    #[test]
    fn breaks_of_different_runs_do_not_all_lean_the_same_way() {
        let mut leans = (0, 0);
        let mut drops = (0, 0);
        let mut places: Vec<i64> = Vec::new();
        for level in [crate::demos::Level::Gym, crate::demos::Level::Catalogue] {
            let (mut scene, meta) = crate::gym_scene::build_gym(&level.spec(), &crate::look::POLANA);
            crate::wear::stamp_story(&mut scene, &meta.piers);
            for pier in &meta.piers {
                for f in run_breaks(0.0, 6.0, story_of(&scene, pier), ONE_BREAK, REL, CRK) {
                    *(if f.tilt > 0.0 { &mut leans.0 } else { &mut leans.1 }) += 1;
                    *(if f.sign > 0.0 { &mut drops.0 } else { &mut drops.1 }) += 1;
                    places.push((f.ax * 100.0) as i64);
                }
            }
        }
        places.sort_unstable();
        places.dedup();
        assert!(leans.0 > 3 && leans.1 > 3, "every run leans the same way ({leans:?}) — the tilt hash is biased");
        assert!(drops.0 > 3 && drops.1 > 3, "every run drops the same side ({drops:?}) — the sign hash is biased");
        assert!(places.len() > 8, "only {} distinct places over both levels — the place hash is degenerate", places.len());
    }

    /// BREAK `at` LANDS WHERE IT WAS ASKED, within the wander the effect is made
    /// of. An authored place is the half of the model a bench needs and a
    /// probability could not offer at all; the tolerance is the path's own
    /// amplitude (±0.76 wu at the extremes of two noise octaves), so this pins
    /// the ANCHOR, which is the thing the author typed.
    #[test]
    fn break_at_lands_where_it_was_asked() {
        for at in [0.0f32, 0.25, 0.5, 0.75, 1.0] {
            let (u0, u1) = (3.0f32, 9.0f32);
            let b = wear_core::wall::Breaks { count: 1, at: Some(at) };
            let f = &run_breaks(u0, u1, 0.37, b, REL, CRK)[0];
            let want = mixf(u0 + BREAK_MARGIN, u1 - BREAK_MARGIN, at);
            assert!((f.ax - want).abs() < 1e-4, "at {at}: anchored at {} not {want}", f.ax);
            assert!(f.ax > u0 + 0.3 && f.ax < u1 - 0.3, "at {at}: {} is a sliver off the end, not a break", f.ax);
        }
    }

    /// A fault grows ONE through trunk (the break that separates the wall)
    /// plus surface forks that must NOT separate it: a fork carving pieces
    /// would run its invisible extension clean across the wall.
    #[test]
    fn a_fault_separates_once_and_frays_on_the_surface() {
        let mut scene = Scene::default();
        let pier = pier_at(&mut scene, 1.0);
        let faults = faults_for(&scene, &pier, &broken(0));
        let fr = Frame::of(&pier);
        let bolts = fault_bolts(&faults, &fr, &CrazeCfg::new(story_of(&scene, &pier), &broken(0), fr.run_x, fr.t1 - fr.t0, &faults));
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
}
