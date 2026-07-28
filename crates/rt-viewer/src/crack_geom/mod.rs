//! Geometric wall aging — the crack lab's cracks as REAL geometry.
//!
//! Every knobbed pier gets BOTH layers (owner round 6, 2026-07-23: patterns
//! must read on faulted walls too — fault and craze COMPOSE now):
//!
//! Both scales are PROPAGATED now (owner round 8, 2026-07-25: "cracks should
//! be more like lightning — branching, a bit irregular — not straight
//! lines"): [`cut::Walk`] grows a path, [`cut::Bolt`] wraps it as something
//! any polygon can be clipped against, [`cut::carve`] turns a face plus a bolt
//! list into pieces or plates. The one invariant that makes it exact: the
//! walker keeps every step inside a corridor around its launch axis, so a bolt
//! is a FUNCTION in its own frame — jagged, forked, but never folded back.
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
//! one screen px or more ([`craze::px_floor`] — sub-pixel line geometry
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
//!
//! # Module map
//!
//! - [`poly`] — the polygon toolkit: areas, clips, the ear clipper, the
//!   [`poly::Frag`] and its exact rect subtraction. No wear opinion in it.
//! - [`cut`] — the walk / bolt / carve propagator: BOTH crack scales are the
//!   same walker, and one carver turns a face plus a bolt list into pieces or
//!   plates.
//! - [`craze`] — a pier's damage config ([`craze::CrazeCfg`]) and the three
//!   pattern policies that lay its veneer out.
//! - [`breaks`] — the run's structural breaks: an authored count at authored
//!   places, and the jagged trunks they grow.
//! - [`emit`] — the Scene-emitting half: the meshes, the materials damage
//!   mints, and the two pier treatments. The ONLY module here that names a
//!   `Scene`.
//!
//! What stays in this file is the surface the rest of the crate sees: the
//! pattern vocabulary, [`Wear`] in, [`Aged`] and [`GeoKey`] out, the pier's
//! face [`Frame`], and the two entry points [`apply_geometry`] and [`keys`].

mod breaks;
mod craze;
mod cut;
mod emit;
mod poly;

#[cfg(test)]
mod fixtures;

use crate::gym_scene::Pier;
use rt_probe::Scene;
use breaks::faults_for;
use emit::{craze_pier, split_pier};

/// `Material._pad` bit 5: this pier's fault is geometric — the shade pass
/// (CRACK LAB block, both twins) zeroes the painted core + bevel (and the
/// cell-network paint, shared with bit 6).
pub use crate::flags::GEO as GEO_BIT;

/// `Material._pad` bit 6: this pier's small-crack network is geometric
/// (craze veneer) — the shade pass zeroes ALL the painted cell work (lines,
/// lips, line halos, chips); only the sub-pixel fine web + stains stay paint.
pub use crate::flags::CRAZE as CRAZE_BIT;

/// Craze pattern policies, panel row + `CRACKS=..,policy` order. `lightning`
/// is a real propagation NETWORK since round 8 ([`craze::bolt_network`]): roots
/// land where the wall is failing, each grows a kinked, forking tree whose
/// paths die on the damage zone's edge or on an older crack (T-junction), and
/// the plates are whatever the network leaves. (Rounds 4-7 emulated this by
/// shaping BSP cuts; a BSP cut always crosses its region, so the cracks came
/// out as long smooth curves — the owner's round-8 complaint.) `craquelure`
/// is the fine axis-biased [`craze::Ladder`] (glaze crack webs — owner: the
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
///
/// NATIVE is the whole test, and two of these failed it until 2026-07-26:
/// craquelure and mosaic each carried a `scale`, which is not native to
/// either — it is PLATE SIZE, the one property every pattern has, spelled
/// three different ways with three different curves. It now lives once, in
/// world units, as `wall::Shape::grain` (see [`craze::CrazeCfg::grain`]).
pub const PARAMS_MAX: usize = 3;
/// (lightning: `branch` = how hard the walk forks, `straight` = wander/kink
/// amplitude and heading persistence, `spread` = fork angle.)
pub const POLICY_PARAMS: [&[(&str, f32)]; 3] = [
    &[("branch", 0.5), ("straight", 0.55), ("spread", 0.45)],
    &[("wave", 0.35)],
    &[("jitter", 0.8)],
];

/// The LIGHTNING policy's `straight` default — the jaggedness a propagated crack
/// has when the wall's own pattern does not declare one (see `CrazeCfg::jag`).
pub const LIGHTNING_STRAIGHT: f32 = POLICY_PARAMS[0][1].1;

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

/// THE LEVEL'S COMPILED WEAR, as the geometry pass reads it: one
/// `wall::Sheet` per RUN plus the pier→run map.
///
/// One datum, passed whole, so no caller can hand the geometry pass and the
/// material streamer different sheets — the drift docs/AGENT_LEARNINGS.md
/// records twice. It also carries every input the generators need: the amounts,
/// the solved thresholds, the shape, the pattern's own params and the breaks are
/// all fields of the sheet, and the sheet is a function of `(run, WallSpec)`
/// alone.
#[derive(Clone, Copy)]
pub struct Wear<'a> {
    pub sheets: &'a [wear_core::wall::Sheet],
    /// Which RUN each pier belongs to (parallel to `piers`).
    pub pier_run: &'a [usize],
    /// Per RUN: the geometry pass skips these walls entirely — the effect
    /// catalogue's paint-only specimens, the only way to see the shade pass's
    /// painted layers on a wall the generator would otherwise have marked.
    pub paint_only: &'a [bool],
}

impl<'a> Wear<'a> {
    /// Pier `i`'s sheet, or `None` when its run is paint-only (or the level says
    /// nothing about it).
    pub fn of(&self, i: usize) -> Option<&'a wear_core::wall::Sheet> {
        let r = *self.pier_run.get(i)?;
        if self.paint_only.get(r).copied().unwrap_or(false) {
            return None;
        }
        self.sheets.get(r)
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

// ---- the public surface ----------------------------------------------------
//
// Every geometry input arrives through `GeoKey`, which is integer — so no
// generator behind this surface ever sees a knob the rebuild gate could not
// see.

/// The pier's own material id — the thing a generator has to read before it can
/// mint a variant of it.
///
/// It used to carry a second return, a PER-PANEL seed, and that seed's only
/// consumer was the break lattice this round deleted. The owner risk it existed
/// to hedge ("sharing the fault seed across a facade would crack three panels at
/// one repeated position") was a property of the 6-wu period, not of the
/// sharing: an authored count at authored places has no period to repeat, so the
/// breaks moved to the RUN with everything else that is true of a whole facade
/// (the damage field, the craze lattices, the run ramp — all [`story_of`]).
/// Depth and chip stay per panel, and those never used this seed.
fn mat_of(scene: &Scene, pier: &Pier) -> i32 {
    scene.primitives[pier.prim].material_id
}

/// The pier's facade STORY KEY, read back from where `wear::stamp_story` put it
/// (`base_color[3]`) rather than recomputed — the host and the shade pass must
/// seed the damage field off the exact same f32 bits, and the way to guarantee
/// that is to have ONE writer and two readers.
fn story_of(scene: &Scene, pier: &Pier) -> f32 {
    let mid = scene.primitives[pier.prim].material_id as usize;
    scene.materials[mid].base_color[3]
}

/// The materials the geometry pass MINTED per pier, and that therefore have to
/// be re-stamped by everything scoped per pier (the contour AA's opt-in bit, the
/// wear effect word). `-1` = this pier grew none.
#[derive(Default)]
pub struct Aged {
    /// The chalk CORE: groove floors and recesses — the surface the damage
    /// EXPOSED. Also the reason the AA scope has to stamp more than the pier
    /// itself: the crack's darkest pixels live here.
    pub cores: Vec<i32>,
    /// What a cover SPALL minted, `[steel, basin]`: the exposed, corroded rebar
    /// and the crater's own interior body. Both are thin/small detail — a bar is
    /// 2-3 px across and a crater rim is a 1-2 px lip — so both declare
    /// themselves to the contour AA along with the pier.
    pub spall_mats: Vec<[i32; 2]>,
}

/// Give every wall its geometric aging: structural BREAKS split the pier (and
/// the craze veneer rides the pieces); unbroken piers fragment into core +
/// veneer per their pattern; the SPALL layer blows cover craters through both
/// and exposes the reinforcement mat under them.
///
/// Everything it reads is the run's compiled [`Wear`] sheet — one datum,
/// per RUN, so two piers of one facade cannot be handed different answers.
/// Runs post-build on the CPU scene (boot and every `apply_look` rebuild),
/// before the backend sees it.
pub fn apply_geometry(scene: &mut Scene, piers: &[Pier], wear: Wear) -> Aged {
    let mut out = Aged { cores: vec![-1; piers.len()], spall_mats: vec![[-1, -1]; piers.len()] };
    for (i, pier) in piers.iter().enumerate() {
        let Some(sheet) = wear.of(i) else { continue };
        let faults = faults_for(scene, pier, sheet);
        // a wall with no cracking but a live SPALL amount still ages: cover loss
        // is its own mechanism (the base of a sound wall spalls first), and a
        // dial that does nothing on the wall the owner picked is a broken dial.
        // A placed SHELL alone opens a wall the same way.
        let anything = sheet.area.iter().any(|a| *a > 0.0) || sheet.breaks.count > 0 || sheet.geom.shell_count() > 0;
        (out.cores[i], out.spall_mats[i]) = if !faults.is_empty() {
            split_pier(scene, pier, &faults, sheet)
        } else if anything {
            craze_pier(scene, pier, sheet)
        } else {
            (-1, [-1, -1])
        };
    }
    out
}

/// PER-PIER GEOMETRY KEY — the rebuild gate, and an all-integer one.
///
/// Two piers with equal keys have identical built geometry, and the converse
/// holds too: everything the geometry pass reads is either IN here or derived
/// from what is in here. So `==` is exactly "the mesh in the scene is still
/// right", with no hash, no collisions and no grain to get wrong.
///
/// Since the authoring model landed it is just `wall::Geom` — which is where
/// the all-integer discipline belongs, because `Geom` is what the level
/// COMPILES to — plus the run's story key. It replaces a hand-rolled parallel
/// copy of the same idea (four knob bytes, a spall byte, a policy, three param
/// bytes, a break count and place), and before THAT an FNV over five different
/// grains with raw floats reaching the break decision, which is how one 0.02
/// slider step could flip a wall from whole to broken in half.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Default, Debug)]
pub struct GeoKey {
    /// Everything the level said about this wall, quantized.
    pub geom: wear_core::wall::Geom,
    /// The facade STORY key as raw bits: it seeds the veneer, the damage field
    /// AND (through the run's sorted samples) every solved threshold, so a
    /// change in it really is stale geometry. Not owner-editable today; it signs
    /// so the day it becomes editable the gate already covers it.
    pub story: u32,
}

/// Every pier's [`GeoKey`]. The release gate rebuilds exactly the piers whose
/// key moved — and since a key is `(the run's Geom, the run's story)`, the piers
/// of one run always move together, which is what "one wall, one story" means
/// for a rebuild.
pub fn keys(scene: &Scene, piers: &[Pier], wear: Wear) -> Vec<GeoKey> {
    piers
        .iter()
        .enumerate()
        .map(|(i, pier)| match wear.of(i) {
            Some(sheet) => GeoKey { geom: sheet.geom, story: story_of(scene, pier).to_bits() },
            // a paint-only wall builds nothing, and its key must say so — else
            // every drag on it would report the scene dirty and rebuild for
            // geometry that is never emitted
            None => GeoKey::default(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crack_geom::fixtures::*;
    use glam::Vec3;

    /// THE CONTAINMENT INVARIANT over the REAL level, per pier: every triangle
    /// the aging pass grows must stay inside the pier it belongs to.
    ///
    /// This is the test that caught the spall's one real leak (2026-07-25): the
    /// bisect SHOT showed a rust cage floating in the gym's doorway, and eyeballing
    /// cannot say which of fifteen piers grew it. Containment is also what the
    /// probe machinery leans on — `Viewer::crack_release` re-bakes only the dirty
    /// piers' own AABBs (`ProbeRefresh::Local`), so geometry outside its pier is
    /// lit by probes that never saw it, and `recompute_bounds` ran long before
    /// this pass, so a stray vertex silently moves nothing and lights wrong.
    ///
    /// Aged ONE PIER AT A TIME rather than the whole level at once: the gym's
    /// building corners are two slabs sharing a 0.2 × 0.2 column, so attributing
    /// a prim to "the pier containing its first vertex" sent the first report of
    /// this failure to the wrong pier (it named the z=3 south run for a leak the
    /// x=3 west facade grew). One pier per pass makes the owner exact.
    #[test]
    fn every_pier_of_the_real_gym_keeps_its_geometry_inside_its_own_box() {
        let spec = house_game::gym::sim::gym_level();
        // the crack lab's own boot state, plus the spall dial across its travel —
        // the top of the dial is the case that reaches furthest, since the count
        // of craters rides it. The gym is REBUILT per pier rather than cloned:
        // Scene is not Clone (it owns the GPU-facing buffers), and building it is
        // cheap next to what this pass then does to it.
        for area in [0.005f32, 0.012, wear_core::wall::SPALL_MAX] {
            let sh = [spalling(area)];
            let (probe, meta) = crate::gym_scene::build_gym(&spec, &crate::look::POLANA);
            drop(probe);
            for (pi, pier) in meta.piers.iter().enumerate() {
                let (mut sc, _) = crate::gym_scene::build_gym(&spec, &crate::look::POLANA);
                crate::wear::stamp_story(&mut sc, &meta.piers);
                
                let first = sc.primitives.len();
                apply_geometry(&mut sc, std::slice::from_ref(pier), wear1(&sh, 1));
                assert!(sc.primitives.len() > first, "spall {area}: pier {pi} grew nothing at all");
                for p in &sc.primitives[first..] {
                    for v in &sc.vertices[p.vertex_offset as usize..(p.vertex_offset + p.vertex_count) as usize] {
                        let v = Vec3::from(v.pos);
                        let pad = 1e-3;
                        assert!(
                            v.cmpge(pier.lo - pad).all() && v.cmple(pier.hi + pad).all(),
                            "spall {area}: pier {pi} ({:?}..{:?}) grew a vertex at {v:?}",
                            pier.lo,
                            pier.hi
                        );
                    }
                }
            }
        }
    }

    /// A faulted pier splits into shell + chalk planes + veneer (the craze
    /// layer RIDES the pieces — owner round 6), everything inside the box
    /// (drops go DOWN only, bottoms pin at y0 — bounds/probe grid frozen).
    #[test]
    fn split_composes_shell_chalk_and_veneer() {
        let mut scene = Scene::default();
        let pier = pier_at(&mut scene, 1.0);
        let before = scene.primitives.len();
        let mid = scene.primitives[pier.prim].material_id;
        apply_geometry(&mut scene, std::slice::from_ref(&pier), wear1(&[broken(0)], 1));
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
        let pier = pier_at(&mut scene, 1.0);
        let before = scene.primitives.len();
        apply_geometry(&mut scene, std::slice::from_ref(&pier), wear1(&[pristine()], 1));
        assert_eq!(scene.primitives.len(), before, "pristine pier untouched");
        assert_eq!(scene.materials[scene.primitives[pier.prim].material_id as usize]._pad & GEO_BIT, 0);
        let s0 = keys(&scene, std::slice::from_ref(&pier), wear1(&[pristine()], 1));
        let s1 = keys(&scene, std::slice::from_ref(&pier), wear1(&[hot(0)], 1));
        assert_eq!(s0, keys(&scene, std::slice::from_ref(&pier), wear1(&[pristine()], 1)), "deterministic");
        assert_ne!(s0, s1, "fault appearance changes the signature");
    }

    /// THE DIRTY-SET PIN (2026-07-25, task 3 step 2): a knob drag on one pier
    /// must move ONLY that pier's signature. `Viewer::crack_release` diffs this
    /// vector to decide which probe boxes to re-bake, so a signature that
    /// leaked across piers would either rebake the whole grid (slow) or — worse
    /// — leave a changed wall lit by probes that never saw it.
    #[test]
    fn a_knob_drag_dirties_exactly_one_pier() {
        let mut scene = Scene::default();
        let piers = [pier_at(&mut scene, 1.0), pier_at(&mut scene, 9.0)];
        let before = keys(&scene, &piers, Wear { sheets: &[crazy(0), crazy(0)], pier_run: &[0, 1], paint_only: &[false, false] });
        let after = keys(&scene, &piers, Wear { sheets: &[crazy(0), hot(0)], pier_run: &[0, 1], paint_only: &[false, false] });
        assert_eq!(before[0], after[0], "the untouched pier keeps its signature");
        assert_ne!(before[1], after[1], "the dragged pier's signature moves");
        // and a policy click is the same story (the panel's pattern row)
        let after = keys(&scene, &piers, Wear { sheets: &[crazy(0), crazy(1)], pier_run: &[0, 1], paint_only: &[false, false] });
        assert_eq!(before[0], after[0], "…for a pattern click too");
        assert_ne!(before[1], after[1]);
    }

    /// The round-6 bug: cycling the pattern on a FAULTED pier must change
    /// the signature (the veneer layout rides the pieces), or the release
    /// rebuild never fires and the pattern row is dead on most walls.
    /// Params held FIXED across policies so only the policy term separates.
    #[test]
    fn policy_signs_on_faulted_piers_too() {
        let mut scene = Scene::default();
        let pier = pier_at(&mut scene, 1.0);
        let sigs: Vec<Vec<GeoKey>> = (0..POLICIES.len() as u8).map(|p| keys(&scene, std::slice::from_ref(&pier), wear1(&[hot(p)], 1))).collect();
        let mut uniq = sigs.clone();
        uniq.dedup();
        assert_eq!(uniq.len(), sigs.len(), "each policy signs distinctly on a faulted pier");
    }

    /// Round 7: the native params STEER the algorithm — different lightning
    /// params rebuild a different network (and sign differently, so the
    /// release rebuild fires on a param drag).
    #[test]
    fn lightning_params_steer_the_network() {
        // CHIPS OFF for this measurement. Since chips became a literal fraction
        // of the plates inside the zone (they used to be gated by the stain
        // window on top), `CRAZY`'s 0.8 takes four plates in five away — and a
        // missing-plate lottery interacting with plate SIZE swamps the param
        // being measured, to the point that the relationship inverted (720 vs
        // 1330 verts). Isolating the variable is the fix; softening the fixture
        // would have hidden that the semantics moved.
        let mk = |par: [f32; PARAMS_MAX]| {
            let mut scene = Scene::default();
            let pier = pier_at(&mut scene, 1.0);
            let before = scene.primitives.len();
            let mut sh = crazy(0);
            sh.area[wear_core::wall::Layer::Chips.index()] = 0.0; // isolate the param
            sh.geom.par = par.map(|v: f32| (v.clamp(0.0, 1.0) * 63.0).round() as u8);
            let sh = [sh];
            apply_geometry(&mut scene, std::slice::from_ref(&pier), wear1(&sh, 1));
            let sig = keys(&scene, std::slice::from_ref(&pier), wear1(&sh, 1));
            (scene.primitives[before + 1].vertex_count, sig)
        };
        let (v_few, s_few) = mk([0.05, 0.9, 0.3]);
        let (v_many, s_many) = mk([0.95, 0.2, 0.6]);
        assert_ne!(s_few, s_many, "param drags must change the signature");
        assert!(v_many > v_few, "more branching + wander must grow the network ({v_many} vs {v_few})");
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
            apply_geometry(&mut scene, std::slice::from_ref(&pier), wear1(&[crazy(policy)], 1));
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
            sigs.push(keys(&scene, std::slice::from_ref(&pier), wear1(&[crazy(policy)], 1)));
        }
        sigs.dedup();
        assert_eq!(sigs.len(), POLICIES.len(), "policies must sign distinctly");
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
