//! Crack lab — per-wall-segment procedural aging (the "crack lab" demo).
//!
//! Every wall pier owns its material 1:1 (`add_box_world` mints one per box),
//! so a segment's ENTIRE aged appearance is four knobs — age / cracks /
//! depth / chip — quantized to 6-bit unorm each and packed into the material's
//! `_pad` bits 8..31 ([`pad_bits`]; the whole FLAG byte 0..7 below them belongs
//! to other owners — see [`KEEP_FLAGS`] — and a stamp only ever recomputes the
//! knob bits and the selection bit). The shade pass (shade.comp /
//! shade.metal CRACK LAB block) unpacks them per pixel; the materials buffer
//! already re-uploads every frame (the practicals stream), so a live knob edit
//! costs nothing — no scene rebuild, no probe rebake (the bake reads base
//! colour only).
//!
//! Owner surface: the LEVELS menu's "crack lab" demo — click a wall segment
//! (ray-picked against `GymMeta.piers`), drag the slider panel that replaces
//! the hamburger; below the knobs a pattern row cycles the small-crack
//! POLICY (`crack_geom::POLICIES` — owner round 5, 2026-07-23: Voronoi
//! reads fake, give me patterns to choose from) and under IT sit that
//! policy's NATIVE param sliders (`crack_geom::POLICY_PARAMS` — owner
//! round 7: switching algo must surface its unique properties; params are
//! stored per pier per policy, so A/B-ing policies keeps each one's
//! tuning). Agent surface:
//! `CRACKS=age,cracks,depth,chip[,policy[,p1,p2,p3]]` stamps every pier
//! uniformly at boot for headless SHOT verification (a shell-only env
//! read, like LOOK/PROJ/LEVEL — see the config.rs exception list); policy
//! by name or index, params defaulting per policy. `CRACK_SEL=<index>`
//! preselects a segment, which is how the harness reaches anything the
//! owner drives by clicking (the knob panel, the highlight, and since
//! 2026-07-25 the contour-AA scope's "picked wall only" mode).

use crate::backend::ProbeRefresh;
use crate::gym_scene::Pier;
use crate::viewer::Viewer;
use glam::{Vec2, Vec3};
use rt_probe::Scene;

/// Knob labels, in pack order (panel rows + the CRACKS env order).
pub const LABELS: [&str; 4] = ["age", "cracks", "depth", "chip"];

/// Selection-highlight flag: `Material._pad` bit 3.
pub const SEL_BIT: i32 = 8;

/// The `_pad` flag bits a knob stamp must PRESERVE: the whole flag byte
/// (bits 0..7) minus the selection bit, which the stamp itself recomputes.
/// Bits 0..2 are the gym's occluder/glass/matte marks, bit 4 (value 16) is the
/// last FREE flag, 5/6 are the geometry pass's GEO/CRAZE marks and 7 is the AA
/// opt-in. This constant exists because the two stamps used to spell the mask
/// out by hand and drifted apart (`& 7` at boot vs `& 231` on a live edit), so
/// any new flag bit was silently cleared at boot and every knob touch —
/// exactly the class of bug the 2026-07-25 catalogue's next flag would have hit.
pub const KEEP_FLAGS: i32 = 0xFF & !SEL_BIT;

/// The greybox-detail AA opt-in ([`crate::gym_scene::AA_BIT`]) — the crack lab
/// is its first client: every pier the geometry pass actually rebuilt carries
/// it, and the `aa scope` row can narrow it to the picked wall.
pub use crate::gym_scene::AA_BIT;

/// A demo's boot weathering: uniform base knobs + a per-pier hash variance so
/// the level reads varied the moment it opens. Plain data (demos.rs literals).
#[derive(Clone, Copy)]
pub struct CrackSeed {
    pub age: f32,
    pub cracks: f32,
    pub depth: f32,
    pub chip: f32,
    /// COVER SPALL (owner headline 2026-07-25): one staged dial — cracked →
    /// lifted cover → blown spall with the rebar showing. Geometry-only, so it
    /// lives host-side and never touches `Material._pad` (whose knob bits are
    /// full: four 6-bit dials fill bits 8..31 exactly).
    pub spall: f32,
    /// ± half-range of the deterministic per-pier variation on every knob.
    pub vary: f32,
    /// World (x, z) points naming walls that boot PRISTINE — the negative
    /// control. Without one in frame, "aged" quietly becomes the level's base
    /// tone and the owner has nothing to read the damage against (review
    /// 2026-07-25); it is also where an age-ramp beat has to start from, since
    /// a ramp that begins on an already-weathered wall shows only its top half.
    /// Named by world point, not pier index, so the level can be re-cut without
    /// silently moving the control (same idiom as [`crate::demos::Action::SmashWall`]).
    pub pristine: &'static [(f32, f32)],
    /// Small-crack pattern policy for every pier (`crack_geom::POLICIES`).
    pub policy: u8,
    /// The seeded policy's native params (`crack_geom::POLICY_PARAMS`).
    pub params: [f32; crate::crack_geom::PARAMS_MAX],
}

/// Live crack-lab state on the [`Viewer`]: one knob quad per pier (parallel
/// to `Viewer::piers`), the picked segment, and the panel's active row.
#[derive(Default)]
pub struct CrackLab {
    /// Selection + knob panel enabled (the demo says `cracks: Some(..)`).
    pub active: bool,
    pub knobs: Vec<[f32; 4]>,
    /// Per-pier small-crack pattern policy (parallel to `knobs`).
    pub policy: Vec<u8>,
    /// Per-pier, PER-POLICY native params (parallel to `knobs`): cycling
    /// the pattern keeps each policy's dialing for the A/B.
    pub params: Vec<[[f32; crate::crack_geom::PARAMS_MAX]; crate::crack_geom::NPOL]>,
    /// Per-pier COVER SPALL dial (parallel to `knobs`) — the owner's one knob
    /// for cover loss and exposed rebar. Host-side: `Material` has no room left
    /// and the crater is geometry, so it is consumed by `apply_geometry` at
    /// rebuild time exactly like the policy params.
    pub spall: Vec<f32>,
    pub sel: Option<usize>,
    pub row: usize,
    /// [`crate::crack_geom::signatures`] of the geometry currently BUILT into
    /// the scene, PER PIER — `Viewer::crack_release` rebuilds when the knobs
    /// disagree, and the disagreeing entries are exactly the piers whose GI has
    /// to settle again (everything else keeps its baked probes).
    pub geo_sigs: Vec<u64>,
    /// Each pier's CHALK CORE material (-1 = none): the groove floors live
    /// there, so the per-pier AA scope has to stamp it too.
    pub cores: Vec<i32>,
    /// What each pier's cover SPALL minted, `[steel, basin]` (-1 = none): the
    /// rebar in a crater is 2-3 px across and the crater's rim is a 1-2 px lip,
    /// so both declare themselves to the contour AA alongside the pier and its
    /// core (CLAUDE.md, greybox detail = AA-scoped).
    pub spall_mats: Vec<[i32; 2]>,
}

impl CrackLab {
    /// Each pier's ACTIVE-policy params — the shape `crack_geom` takes.
    pub fn active_params(&self) -> Vec<[f32; crate::crack_geom::PARAMS_MAX]> {
        self.policy.iter().zip(&self.params).map(|(p, per)| per[*p as usize]).collect()
    }
}

/// Pack four 0..1 knobs into `Material._pad` bits 8..31 (6-bit unorm each):
/// age at 8, cracks at 14, depth at 20, chip at 26. The shader unpack
/// (`shade.comp` CRACK LAB block) mirrors this exactly — pinned by the test.
pub fn pad_bits(k: [f32; 4]) -> i32 {
    let q = |v: f32| (v.clamp(0.0, 1.0) * 63.0).round() as u32;
    ((q(k[0]) << 8) | (q(k[1]) << 14) | (q(k[2]) << 20) | (q(k[3]) << 26)) as i32
}

/// A pier's stamped `_pad`: the surviving flags ([`KEEP_FLAGS`]) + this pier's
/// knob bits + the recomputed selection bit. ONE expression, shared by the
/// boot/rebuild stamp ([`stamp_all`]) and the live edit ([`Viewer::crack_apply`])
/// — they are the same operation and drifted when spelled out twice.
pub fn stamped_pad(pad: i32, k: [f32; 4], selected: bool) -> i32 {
    (pad & KEEP_FLAGS) | pad_bits(k) | if selected { SEL_BIT } else { 0 }
}

/// Shader-side unpack, host-mirrored (the layout-pin test's other half).
#[cfg(test)]
pub fn unpack(pad: i32) -> [f32; 4] {
    let kb = pad as u32;
    let u = |sh: u32| ((kb >> sh) & 63) as f32 / 63.0;
    [u(8), u(14), u(20), u(26)]
}

/// `CRACKS=age,cracks,depth,chip[,policy[,p1,p2,p3]]` — the harness
/// override: stamp every pier uniformly at boot (missing components read 0,
/// no variance; policy by `crack_geom::POLICIES` name or index, default
/// `lightning`; trailing floats override that policy's native params).
pub fn seed_from_env() -> Option<CrackSeed> {
    std::env::var("CRACKS").ok().map(|v| parse_seed(&v))
}

/// The pure half of [`seed_from_env`].
fn parse_seed(v: &str) -> CrackSeed {
    let parts: Vec<&str> = v.split(',').map(str::trim).collect();
    let n = |i: usize| parts.get(i).and_then(|s| s.parse::<f32>().ok()).unwrap_or(0.0);
    let policy = parts.get(4).map(|s| crate::crack_geom::policy_index(s)).unwrap_or(0);
    let mut params = crate::crack_geom::param_defaults(policy);
    for (j, slot) in params.iter_mut().enumerate() {
        if let Some(p) = parts.get(5 + j).and_then(|s| s.parse::<f32>().ok()) {
            *slot = p;
        }
    }
    // CRACK_VARY: the per-pier spread AND the run ramp's amplitude (see
    // seed_knobs). It is the whole visible half of "one wall, one story", and a
    // bare CRACKS= would otherwise pin it to 0 — every verification shot of the
    // ramp would then show only the story-key half (review finding, 2026-07-25).
    let vary = std::env::var("CRACK_VARY").ok().and_then(|v| v.parse().ok()).unwrap_or(0.0);
    // spall stays 0 here: `SPALL=` is applied in `resolve`, so the one override
    // reaches the DEMO's authored seed as well as this one. `pristine` is empty
    // for the same reason `vary` defaults to 0: a harness shot wants EVERY pier
    // stamped with the value it asked for, controls included.
    CrackSeed { age: n(0), cracks: n(1), depth: n(2), chip: n(3), spall: 0.0, vary, policy, params, pristine: &[] }
}

/// `SPALL=<0..1>` — the cover-spall dial for headless shots, a shell-only read
/// like `CRACKS=`/`CRACK_SEL=` (see the config.rs exception list). Applied to
/// whichever seed is in play, so `SPALL=0` is the "before" side of every A/B in
/// this effect and `SPALL=1` the "after" on the demo's own boot state.
fn spall_from_env() -> Option<f32> {
    std::env::var("SPALL").ok().and_then(|v| v.trim().parse::<f32>().ok())
}

/// `CRACK_EDIT=age,cracks,depth,chip[,pier]` — the harness's stand-in for the
/// owner dragging the panel and letting go: after boot, write these knobs (onto
/// every pier, or only `pier`) and take the RELEASE path a mouse-up takes.
/// A shell-only read like `CRACKS=`/`CRACK_SEL=` (see the config.rs exception
/// list). It exists because the release path is the expensive one — an agent
/// cannot click, and "boot straight into the final knobs" measures the BOOT
/// bake, not the rebuild.
fn edit_from_env() -> Option<([f32; 4], Option<usize>)> {
    std::env::var("CRACK_EDIT").ok().map(|v| {
        let parts: Vec<&str> = v.split(',').map(str::trim).collect();
        let n = |i: usize| parts.get(i).and_then(|s| s.parse::<f32>().ok()).unwrap_or(0.0);
        ([n(0), n(1), n(2), n(3)], parts.get(4).and_then(|s| s.parse::<usize>().ok()))
    })
}

/// Where a pier sits along its parent RUN (0..1) and the run's story key — the
/// two things the age ramp is a function of.
fn run_pos(pier: &Pier) -> (f32, f32) {
    let run_x = (pier.run_hi.x - pier.run_lo.x) >= (pier.run_hi.z - pier.run_lo.z);
    let (c, a0, a1) = if run_x {
        ((pier.lo.x + pier.hi.x) * 0.5, pier.run_lo.x, pier.run_hi.x)
    } else {
        ((pier.lo.z + pier.hi.z) * 0.5, pier.run_lo.z, pier.run_hi.z)
    };
    (((c - a0) / (a1 - a0).max(1e-4)).clamp(0.0, 1.0), crate::wear::story_key(pier.run_lo, pier.run_hi))
}

/// The facade's AGE RAMP at a pier: −0.5..0.5, a smooth MONOTONE gradient along
/// the parent run. It replaces a per-pier index hash, which is what made one
/// building read as a row of separately aged panels (owner catalogue 2026-07-25,
/// "one wall, one story"): a real facade gets worse toward one corner because
/// whatever is eating it — driving rain, splash, a downpipe — comes from one
/// side, so `vary` has to be a GRADIENT along the wall, not noise per panel.
///
/// It is a smoothstep ease with a per-run DIRECTION — and the shape of that
/// answer is a measurement, not a preference. The design started as the
/// catalogue's "one low-frequency vnoise cell spans the whole run", which is a
/// gradient by construction at any run length; but a single-cell sample
/// normalized to its own two ends (normalized because a raw sample's amplitude
/// is a lottery — two nearby end hashes would age a whole facade UNIFORMLY,
/// the very failure this replaces) is ALGEBRAICALLY just a rescaled smoothstep
/// whose one free parameter is the SIGN of that cell's gradient. And drawing the
/// sign off the noise's x axis gave all twelve trial runs the same direction —
/// `hash13`'s x axis carries a bias at these small offsets. So the direction is
/// drawn on the STORY axis, where runs actually differ, and pinned by a test.
///
/// A one-pier run (the garden walls) sits mid-ramp and keeps the base knobs:
/// its damage still varies across the wall, but through the field, not the knobs.
fn run_ramp(pier: &Pier) -> f32 {
    let (s, story) = run_pos(pier);
    let s = if crate::crack_geom::vnoise(Vec3::new(story * 1.7, 11.0, 3.0)) < 0.5 { 1.0 - s } else { s };
    s * s * (3.0 - 2.0 * s) - 0.5 // the same ease the damage field is built out of
}

/// Deterministic per-pier knob quads from a seed (no RNG state — same level,
/// same weathering, every boot). TWO kinds of variance, and the split is the
/// point: `age`/`cracks` follow the facade's [`run_ramp`], so one wall tells one
/// story with a bad end and a clean end, while `depth`/`chip` keep the per-pier
/// index hash — they are texture-scale dials, and putting them on the run too
/// would leave a facade with one uniform crack width (the owner risk on record
/// for this effect: shared seeds reading as a repeated stamp).
pub fn seed_knobs(piers: &[Pier], s: &CrackSeed) -> Vec<[f32; 4]> {
    let h = |i: u32, k: u32| {
        let mut x = i.wrapping_mul(0x9E37_79B9) ^ k.wrapping_mul(0x85EB_CA6B);
        x ^= x >> 13;
        x = x.wrapping_mul(0xC2B2_AE35);
        (x ^ (x >> 16)) as f32 / u32::MAX as f32 - 0.5
    };
    piers
        .iter()
        .enumerate()
        .map(|(i, pier)| {
            let g = run_ramp(pier);
            let v = |base: f32, k: u32| (base + s.vary * h(i as u32, k)).clamp(0.0, 1.0);
            let r = |base: f32| (base + s.vary * g).clamp(0.0, 1.0);
            [r(s.age), r(s.cracks), v(s.depth, 3), v(s.chip, 4)]
        })
        .collect()
}

/// Per-pier COVER SPALL dials from a seed.
///
/// Deliberately NOT the same variance shape as the knobs, for two reasons the
/// first cut got wrong in opposite directions:
///
/// - The dial is a CEILING, not a centre: variance only ever takes a wall DOWN
///   (`seed · x^g`). Additive variance meant `SPALL=0` still opened craters on a
///   third of the piers — so every A/B taken with `SPALL=0` as the "before" was
///   measuring spall-with-variance against spall (review 2026-07-25). Zero now
///   means zero at every pier, by construction.
/// - The draw is SKEWED (`vary` sets the exponent), so a level reads as "some
///   walls are failing" rather than "every wall has a hole in it": at the demo's
///   own seed roughly two fifths of the piers land under `rebar::DIAL_ON` and
///   carry no crater at all. Spall is the loudest thing in the catalogue, and
///   without clean walls beside them the craters read as a texture, not as
///   damage — the owner needs a control in the same frame.
pub fn seed_spall(piers: &[Pier], s: &CrackSeed) -> Vec<f32> {
    piers
        .iter()
        .enumerate()
        .map(|(i, _)| {
            let mut x = (i as u32).wrapping_mul(0x9E37_79B9) ^ 0x51ED_2701u32.wrapping_mul(0x85EB_CA6B);
            x ^= x >> 13;
            x = x.wrapping_mul(0xC2B2_AE35);
            let h = (x ^ (x >> 16)) as f32 / u32::MAX as f32;
            // `vary` is a SKEW here, not a ± half-range: 0 is exactly the dial on
            // every wall (what a harness shot wants), and it bends the draw toward
            // zero as it opens, so most walls come out clean and a few come out bad
            s.spall.clamp(0.0, 1.0) * h.powf(4.0 * s.vary)
        })
        .collect()
}

/// The wall pier a world (x, z) column runs through — how a demo names a wall
/// (`CrackSeed::pristine`, [`crate::demos::Action::AgeWall`]) without knowing
/// how `wall_slab` happened to cut the run into piers. Mid-height, so a point
/// authored on the ground plane still lands in the slab.
pub fn pier_index_at(piers: &[Pier], x: f32, z: f32) -> Option<usize> {
    let p = Vec3::new(x, 1.0, z);
    piers.iter().position(|q| q.lo.cmple(p).all() && q.hi.cmpge(p).all())
}

/// Zero every knob (and the spall dial) on the piers the seed names PRISTINE.
/// Applied AFTER the seeding rather than inside it so the control is exactly
/// the greybox: `pad_bits([0; 4])` is 0 and `apply_geometry` builds nothing, so
/// a pristine pier is bit-identical to the same wall in the plain gym.
fn clear_pristine(piers: &[Pier], s: &CrackSeed, knobs: &mut [[f32; 4]], spall: &mut [f32]) {
    for &(x, z) in s.pristine {
        match pier_index_at(piers, x, z) {
            Some(i) => {
                knobs[i] = [0.0; 4];
                spall[i] = 0.0;
            }
            None => eprintln!("crack: pristine point ({x}, {z}) misses every wall pier — ignored"),
        }
    }
}

/// The AGE RAMP curve: one 0..1 dial → the five aging knobs, for the demo beat
/// that weathers a wall while the owner watches
/// ([`crate::demos::Action::AgeWall`]).
///
/// The layers are STAGGERED rather than ramped together, because that is the
/// causal order the catalogue is built on and it is what makes the beat read as
/// a story instead of a cross-fade: the glaze stains and crazes first, the crack
/// network opens through it, chips start coming off the plates, and only at the
/// end does the cover let go and show the rebar. Each layer therefore has the
/// frame to itself when it arrives — at 60 fps and ~3 s a beat, that is roughly
/// 0.8 s per stage, which is about as fast as a change this size can be read.
///
/// `t = 0` returns exactly zero on every lane, so the ramp's first frame is the
/// pristine control it started from, bit for bit.
pub fn ramp_knobs(t: f32) -> ([f32; 4], f32) {
    // smoothstep inside each stage's window: a linear knob crossing a gate
    // threshold pops a whole feature on in one frame
    let seg = |a: f32, b: f32| {
        let u = ((t - a) / (b - a)).clamp(0.0, 1.0);
        u * u * (3.0 - 2.0 * u)
    };
    let age = 0.95 * seg(0.00, 0.55);
    let cracks = 0.80 * seg(0.25, 0.85);
    let depth = 0.70 * seg(0.25, 0.85);
    let chip = 0.45 * seg(0.45, 1.00);
    let spall = 0.85 * seg(0.60, 1.00);
    ([age, cracks, depth, chip], spall)
}

/// Write the knob bits (and the selection bit) into the scene's materials —
/// the boot/rebuild path; live edits go through `Viewer::crack_apply` and the
/// backend's per-frame material stream instead.
pub fn stamp_all(scene: &mut Scene, piers: &[Pier], knobs: &[[f32; 4]], sel: Option<usize>) {
    for (i, (pier, k)) in piers.iter().zip(knobs).enumerate() {
        let mid = scene.primitives[pier.prim].material_id as usize;
        scene.materials[mid]._pad = stamped_pad(scene.materials[mid]._pad, *k, sel == Some(i));
    }
}

/// Which piers opt into the contour AA at this scope: 1 = every CRACKED pier,
/// 2 = the PICKED one only (the owner's per-wall A/B), 0 = the shader ignores
/// the bit and AAs everything, anything else = nothing.
fn aa_wants(scene: &Scene, pier: &Pier, lab: &CrackLab, i: usize, scope: i32) -> bool {
    match scope {
        // MODIFIED geometry: the pier's material carries the geometry pass's own
        // marks, so this is "the generator actually rebuilt this wall" rather
        // than "its knobs are non-zero" (a knobbed pier whose damage field left
        // it pristine builds nothing and must stay hard-edged)
        1 => {
            let mid = scene.primitives[pier.prim].material_id as usize;
            scene.materials[mid]._pad & (crate::crack_geom::GEO_BIT | crate::crack_geom::CRAZE_BIT) != 0
        }
        2 => lab.sel == Some(i),
        _ => false,
    }
}

/// Stamp [`AA_BIT`] into the CPU scene for every pier and every material its
/// aging minted — the chalk core (the groove floors are the crack's darkest
/// pixels, so a scope that missed them would AA the lips and leave the core
/// hard) and the exposed rebar (2-3 px across, and its silhouette against the
/// dark basin is exactly the kind of contour the AA exists for). Returns the
/// materials that actually changed, so a live caller can stream just those.
pub fn stamp_aa(scene: &mut Scene, piers: &[Pier], lab: &CrackLab, scope: i32) -> Vec<(usize, i32)> {
    let mut out = Vec::new();
    for (i, pier) in piers.iter().enumerate() {
        let on = aa_wants(scene, pier, lab, i, scope);
        let core = lab.cores.get(i).copied().filter(|c| *c >= 0);
        let spall = lab.spall_mats.get(i).copied().unwrap_or([-1, -1]);
        let extra = spall.map(|c| if c >= 0 { Some(c) } else { None });
        for mid in [Some(scene.primitives[pier.prim].material_id), core].into_iter().chain(extra).flatten() {
            let m = mid as usize;
            let pad = if on { scene.materials[m]._pad | AA_BIT } else { scene.materials[m]._pad & !AA_BIT };
            if pad != scene.materials[m]._pad {
                scene.materials[m]._pad = pad;
                out.push((m, pad));
            }
        }
    }
    out
}

/// Resolve the crack state against a freshly built scene (boot and every
/// `apply_look` rebuild): a seed keeps live-edited knobs when the pier count
/// matches (look switches preserve the owner's dialing), else re-seeds; no
/// seed clears the lab. Stamps the result into the scene pre-upload.
pub fn resolve(seed: Option<CrackSeed>, lab: &mut CrackLab, piers: &[Pier], scene: &mut Scene, aa_scope: i32) {
    match seed {
        Some(mut s) => {
            if let Some(v) = spall_from_env() {
                s.spall = v; // one override for the demo seed and the CRACKS seed alike
            }
            // FIRST, before either the seeding or the geometry pass reads it: the
            // per-RUN story key (`base_color[3]`). Both the host damage field
            // (crack_geom) and the shade pass seed off this one f32, so it has to
            // be in the scene before anything derives anything from it.
            crate::wear::stamp_story(scene, piers);
            if lab.knobs.len() != piers.len() || lab.policy.len() != piers.len() || lab.params.len() != piers.len() {
                lab.knobs = seed_knobs(piers, &s);
                lab.spall = seed_spall(piers, &s);
                clear_pristine(piers, &s, &mut lab.knobs, &mut lab.spall);
                lab.policy = vec![s.policy; piers.len()];
                let mut per = [
                    crate::crack_geom::param_defaults(0),
                    crate::crack_geom::param_defaults(1),
                    crate::crack_geom::param_defaults(2),
                ];
                per[s.policy as usize] = s.params;
                lab.params = vec![per; piers.len()];
                // CRACK_SEL=<pier index> preselects a segment for the headless
                // harness (the owner picks by clicking; an agent cannot, and the
                // selection now drives the AA scope as well as the panel).
                lab.sel = std::env::var("CRACK_SEL").ok().and_then(|v| v.parse::<usize>().ok()).filter(|i| *i < piers.len());
                lab.row = 0;
            }
            stamp_all(scene, piers, &lab.knobs, lab.sel);
            // structural faults + crazing + cover spall become REAL geometry
            // (crack_geom); the built signature lets live knob drags rebuild
            // only on change
            let par = lab.active_params();
            let aged = crate::crack_geom::apply_geometry(scene, piers, &lab.knobs, &lab.policy, &par, &lab.spall);
            (lab.cores, lab.spall_mats) = (aged.cores, aged.spall_mats);
            lab.geo_sigs = crate::crack_geom::signatures(scene, piers, &lab.knobs, &lab.policy, &par, &lab.spall);
            stamp_aa(scene, piers, lab, aa_scope); // the AA scope's opt-in bits
        }
        None => {
            lab.knobs.clear();
            lab.spall.clear();
            lab.policy.clear();
            lab.params.clear();
            lab.cores.clear();
            lab.spall_mats.clear();
            lab.sel = None;
            lab.geo_sigs.clear();
        }
    }
}

/// Ray/AABB slab test → entry distance (`None` on miss). The pick ray comes
/// from `iso_core::window_px_to_ray`, whose origin is backed off behind the
/// scene, so `tmin ≥ 0` always holds for visible piers.
fn ray_aabb(o: Vec3, d: Vec3, lo: Vec3, hi: Vec3) -> Option<f32> {
    let inv = d.recip();
    let a = (lo - o) * inv;
    let b = (hi - o) * inv;
    let tmin = a.min(b).max_element().max(0.0);
    let tmax = a.max(b).min_element();
    (tmax >= tmin).then_some(tmin)
}

impl Viewer {
    /// The crack knob panel is on screen: lab active, a segment picked, no
    /// menu over it (the panel replaces the hamburger while editing).
    pub fn crack_panel_visible(&self) -> bool {
        self.crack.active && self.crack.sel.is_some() && !self.menu_open()
    }

    /// Recompute + push pier `i`'s material `_pad` (knob bits + selection),
    /// mirrored into the CPU scene (so rebuilds re-stamp the truth) and the
    /// backend's live material stream (visible next frame, nothing rebuilds).
    /// Every other flag is preserved ([`KEEP_FLAGS`]): GEO/CRAZE describe the
    /// geometry currently BUILT (only `crack_release`'s rebuild may change
    /// those), AA the scope, and the rest are the gym's own surface marks.
    pub fn crack_apply(&mut self, i: usize) {
        let mid = self.scene.primitives[self.piers[i].prim].material_id as usize;
        let pad = stamped_pad(self.scene.materials[mid]._pad, self.crack.knobs[i], self.crack.sel == Some(i));
        self.scene.materials[mid]._pad = pad;
        self.backend.set_material_pad(mid, pad);
    }

    /// Re-derive the contour-AA opt-in bit for every pier from the current
    /// scope and push the changes to the backend's live material stream (no
    /// rebuild, no rebake — visible next frame). Called on every pick, knob
    /// edit and scope change; the boot/rebuild path stamps the same bits
    /// through [`stamp_aa`].
    pub fn aa_stamp(&mut self) {
        let scope = self.aa_scope.round() as i32;
        for (m, pad) in stamp_aa(&mut self.scene, &self.piers, &self.crack, scope) {
            self.backend.set_material_pad(m, pad);
        }
        // CHUNKY detail (rubble) is the owner's visual call, and it never takes
        // the "picked wall" scope — there is nothing to pick.
        let on = self.aa_chunky > 0.5 && scope == 1;
        for mid in self.aa_chunky_mats.clone() {
            let m = mid as usize;
            let pad = if on { self.scene.materials[m]._pad | AA_BIT } else { self.scene.materials[m]._pad & !AA_BIT };
            if pad != self.scene.materials[m]._pad {
                self.scene.materials[m]._pad = pad;
                self.backend.set_material_pad(m, pad);
            }
        }
    }

    /// Slider released (or the pattern row clicked): if the drag changed the
    /// built geometry — which faults exist, the craze bucket, the policy,
    /// its native params — rebuild the scene so the aging opens in place.
    /// Dial-within-a-bucket knob drags stay live-material cheap.
    ///
    /// The rebuild takes the LOCAL probe path: a drag re-generates ONE pier's
    /// boxes inside that pier's own AABB (`crack_geom` pins that containment),
    /// so every other probe in the level is still exactly right and only the
    /// dirty piers' neighbourhoods need re-baking — 6.6 s → 3.3 s on this M2
    /// (16 % of the probes; the refresh is latency-bound, not probe-bound, see
    /// `rt_probe::gpu_scene::LOCAL_REFRESH_MAX_FRACTION`). `PROBE_LOCAL=0`
    /// forces the full rebake — the A/B that shows the local refresh leaves no
    /// stale probe.
    /// Mouse released: settle whatever a drag left pending. The GLAZE EASE is
    /// level-wide geometry (3-5 s of full rebake), so its row only takes the
    /// value while dragging — the rebuild happens here, once, like the crack
    /// knobs' own signature check below.
    pub fn ease_release(&mut self) {
        if (self.arris - self.arris_built).abs() > 1e-4 {
            self.arris_built = self.arris;
            self.apply_look(self.look);
        }
    }

    pub fn crack_release(&mut self) {
        self.crack_rebuild(false);
    }

    /// The rebuild body behind [`Self::crack_release`], with the GI half as a
    /// parameter. `rolling` is the age-ramp beat
    /// ([`crate::demos::Action::AgeWall`]): it steps the geometry several times
    /// a second, and a synchronous refresh costs 3-5 s WHATEVER its size (the
    /// refresh is latency-bound), so the dirty probes go to the amortized DDGI
    /// roll instead and the step costs only the scene swap (~30 ms on the M2).
    /// A mouse-up is not animating, so it keeps the exact refresh.
    fn crack_rebuild(&mut self, rolling: bool) {
        if !self.crack.active {
            return;
        }
        let par = self.crack.active_params();
        let sigs = crate::crack_geom::signatures(&self.scene, &self.piers, &self.crack.knobs, &self.crack.policy, &par, &self.crack.spall);
        if sigs == self.crack.geo_sigs {
            return;
        }
        // The piers whose geometry actually moved. A count change means the level
        // itself changed under us (never today — the pier count is look-stable),
        // so fall back to the full bake rather than guess.
        let dirty: Vec<(Vec3, Vec3)> = if sigs.len() == self.crack.geo_sigs.len() {
            self.piers
                .iter()
                .zip(sigs.iter().zip(&self.crack.geo_sigs))
                .filter(|(_, (a, b))| a != b)
                .map(|(p, _)| (p.lo, p.hi))
                .collect()
        } else {
            Vec::new()
        };
        let look = self.look;
        if dirty.is_empty() || !self.cfg.render.probe_local {
            self.apply_look(look);
        } else if rolling {
            self.rebuild_in_look(look, ProbeRefresh::Roll(&dirty));
        } else {
            self.rebuild_in_look(look, ProbeRefresh::Local(&dirty));
        }
    }

    /// One frame of the AGE RAMP beat: write the ramped knobs onto the named
    /// wall (live, through the material stream — the painted layers move every
    /// frame for free) and, on a `commit` frame, rebuild so the GEOMETRY the new
    /// knobs imply actually opens. The rebuild is a no-op unless the pier's
    /// geometry SIGNATURE moved, so the number of real rebuilds is the number of
    /// geometry buckets the ramp crosses, not the number of commit frames.
    pub fn age_wall_step(&mut self, x: f32, z: f32, t: f32, commit: bool) {
        if !self.crack.active {
            return; // a demo without a crack seed has no knobs to ramp
        }
        let Some(i) = crate::crack::pier_index_at(&self.piers, x, z) else {
            return; // a point that misses every wall is reported once, at boot
        };
        let (knobs, spall) = crate::crack::ramp_knobs(t);
        self.crack.knobs[i] = knobs;
        self.crack.spall[i] = spall;
        self.crack_apply(i);
        if commit {
            self.crack_rebuild(true);
        }
    }

    /// Replay a panel drag from the environment (`CRACK_EDIT=`, see
    /// [`edit_from_env`]): stamp the knobs live like a drag, then release. Runs
    /// at the very end of boot, so it exercises exactly the owner's path —
    /// including the rebuild and its probe refresh.
    pub fn crack_edit_from_env(&mut self) {
        let Some((k, which)) = edit_from_env() else { return };
        if !self.crack.active {
            eprintln!("CRACK_EDIT: this level has no crack lab — ignored");
            return;
        }
        for i in 0..self.crack.knobs.len() {
            if which.is_none_or(|w| w == i) {
                self.crack.knobs[i] = k;
                self.crack_apply(i);
            }
        }
        println!("crack: CRACK_EDIT {k:?} on {} — releasing", which.map(|i| format!("pier {i}")).unwrap_or_else(|| "every pier".into()));
        self.crack_release();
    }

    /// The panel's pattern row: cycle the picked pier's policy — the release
    /// event that follows the click sees the changed signature and rebuilds.
    pub fn crack_cycle_policy(&mut self) {
        if let Some(sel) = self.crack.sel {
            let n = crate::crack_geom::POLICIES.len() as u8;
            self.crack.policy[sel] = (self.crack.policy[sel] + 1) % n;
        }
    }

    /// Change the picked segment (both the old and new highlight bits).
    pub fn crack_select(&mut self, sel: Option<usize>) {
        let old = self.crack.sel;
        if old == sel {
            return;
        }
        self.crack.sel = sel;
        if let Some(o) = old {
            self.crack_apply(o);
        }
        if let Some(n) = sel {
            self.crack_apply(n);
        }
        self.aa_stamp(); // scope 2 follows the pick
    }

    /// Crack-lab world click: ray-pick the nearest wall pier under the
    /// cursor. Hit → select it (true); miss with a live selection → dismiss
    /// (true, the click is spent putting the knobs away); else false and the
    /// click falls through to click-to-move.
    pub fn crack_click(&mut self, win: Vec2) -> bool {
        if !self.crack.active || self.menu_open() {
            return false;
        }
        let x = self.pick_xform();
        let (o, d) = iso_core::window_px_to_ray(win, &x);
        let mut best: Option<(f32, usize)> = None;
        for (i, pier) in self.piers.iter().enumerate() {
            if let Some(t) = ray_aabb(o, d, pier.lo, pier.hi) {
                if best.is_none_or(|(bt, _)| t < bt) {
                    best = Some((t, i));
                }
            }
        }
        match best {
            Some((_, i)) => {
                self.crack_select(Some(i));
                self.ui_blip("menu_pick");
                true
            }
            None if self.crack.sel.is_some() => {
                self.crack_select(None);
                self.ui_blip("menu_move");
                true
            }
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The bit layout the shaders unpack (shade.comp / shade.metal CRACK LAB
    /// block): 6-bit unorm knobs at bits 8/14/20/26, flags 0..7 untouched.
    #[test]
    fn pad_bits_layout_matches_the_shader_unpack() {
        assert_eq!(pad_bits([0.0; 4]), 0, "zero knobs = zero bits (bit-identical image)");
        assert_eq!(pad_bits([1.0, 0.0, 0.0, 0.0]), 63 << 8);
        assert_eq!(pad_bits([0.0, 1.0, 0.0, 0.0]), 63 << 14);
        assert_eq!(pad_bits([0.0, 0.0, 1.0, 0.0]), 63 << 20);
        assert_eq!(pad_bits([0.0, 0.0, 0.0, 1.0]), (63u32 << 26) as i32);
        // full quad round-trips through the shader-side unpack at 6-bit grain
        let k = [0.55, 0.30, 0.80, 0.15];
        for (a, b) in unpack(pad_bits(k)).iter().zip(k) {
            assert!((a - b).abs() <= 0.5 / 63.0, "{a} vs {b}");
        }
        // knob bits never touch the flag bits (occluder/glass/matte/selected)
        assert_eq!(pad_bits([1.0; 4]) & 0xFF, 0);
    }

    /// THE MASK PIN (2026-07-25): a knob stamp recomputes the knob bits and the
    /// selection bit and PRESERVES every other flag. Both stamps used to spell
    /// the mask out by hand — `& 7` at boot, `& 231` on a live edit — so a new
    /// flag bit (the wear family's value 16, next in line) died at boot and on
    /// every knob touch, silently. Pinned through the boot path AND the live
    /// expression, since a painted effect landing on a cleared flag looks like
    /// "the shader is wrong" and costs a session to find.
    #[test]
    fn a_marked_flag_survives_the_boot_stamp_and_a_live_edit() {
        use crate::gym_scene::Pier;
        use rt_probe::Scene;
        const FREE_BIT: i32 = 16; // the wear family's claim (crate::wear)
        let mut scene = Scene::default();
        let (lo, hi) = (Vec3::new(1.0, 0.0, 9.9), Vec3::new(7.0, 2.2, 10.15));
        scene.add_box_world(lo, hi, [0.9, 0.9, 0.9, 1.0], [0.0; 4], 0.85, 0.0);
        let piers = vec![Pier { prim: scene.primitives.len() - 1, lo, hi, run_lo: lo, run_hi: hi }];
        let mid = scene.primitives[piers[0].prim].material_id as usize;
        // every flag a pier can carry: occluder + matte + the free bit + the
        // geometry pass's marks + the AA opt-in, plus a STALE selection
        let marks = 1 | 4 | FREE_BIT | crate::crack_geom::GEO_BIT | crate::crack_geom::CRAZE_BIT | AA_BIT;
        scene.materials[mid]._pad = marks | SEL_BIT;

        stamp_all(&mut scene, &piers, &[[0.5, 0.4, 0.3, 0.2]], None); // boot/rebuild path
        assert_eq!(scene.materials[mid]._pad & 0xFF, marks, "flags survive the boot stamp; a stale selection does not");
        assert_eq!(unpack(scene.materials[mid]._pad), [0.5, 0.4, 0.3, 0.2].map(|v: f32| (v * 63.0).round() / 63.0));

        // the live edit (`Viewer::crack_apply` is exactly this expression)
        let pad = stamped_pad(scene.materials[mid]._pad, [1.0, 0.0, 0.0, 0.0], true);
        assert_eq!(pad & 0xFF, marks | SEL_BIT, "flags survive a live knob edit, selection follows the pick");
        assert_eq!(pad >> 8, 63, "…and the knob bits are the new ones");
        assert_eq!(stamped_pad(pad, [1.0, 0.0, 0.0, 0.0], false) & SEL_BIT, 0, "deselect clears only the selection bit");
    }

    /// `CRACKS=` parsing: policy by name, trailing floats override that
    /// policy's native params, missing tails keep the defaults.
    #[test]
    fn parse_seed_reads_policy_and_params() {
        let d = crate::crack_geom::param_defaults(0);
        let s = parse_seed("0.5,0.4,0.3,0.2");
        assert_eq!((s.policy, s.params), (0, d), "bare quad: default policy + params");
        let s = parse_seed("1,1,0.5,0,craquelure");
        assert_eq!(s.policy, 1);
        assert_eq!(s.params, crate::crack_geom::param_defaults(1));
        let s = parse_seed("1,1,0.5,0,lightning,0.9,0.1");
        assert_eq!(s.params, [0.9, 0.1, d[2]], "trailing floats override in order");
    }

    /// THE 2026-07-25 POLICY, pinned: geometry a generator REBUILT is
    /// AA-scoped by construction. A pier the crack pass rebuilt (its material
    /// carries the GEO/CRAZE marks) must carry [`AA_BIT`] at the default scope,
    /// its chalk core with it (the groove floors are the crack's darkest
    /// pixels); a pristine pier must stay hard-edged. Scope 2 narrows to the
    /// pick, scope 0 needs no bit at all.
    #[test]
    fn rebuilt_geometry_opts_into_the_aa_scope() {
        use crate::gym_scene::Pier;
        use rt_probe::Scene;
        let mut scene = Scene::default();
        let mk = |scene: &mut Scene, x0: f32| {
            let (lo, hi) = (Vec3::new(x0, 0.0, 9.9), Vec3::new(x0 + 6.0, 2.2, 10.15));
            scene.add_box_world(lo, hi, [0.9, 0.9, 0.9, 1.0], [0.0; 4], 0.85, 0.0);
            Pier { prim: scene.primitives.len() - 1, lo, hi, run_lo: lo, run_hi: hi }
        };
        let piers = vec![mk(&mut scene, 1.0), mk(&mut scene, 9.0)];
        // pier 0 aged, pier 1 pristine
        let mut lab = CrackLab {
            knobs: vec![[0.9, 0.8, 0.6, 0.2], [0.0; 4]],
            policy: vec![0; 2],
            params: vec![[crate::crack_geom::param_defaults(0); crate::crack_geom::NPOL]; 2],
            ..Default::default()
        };
        let par = lab.active_params();
        lab.cores = crate::crack_geom::apply_geometry(&mut scene, &piers, &lab.knobs, &lab.policy, &par, &[]).cores;
        let pad = |scene: &Scene, p: &Pier| scene.materials[scene.primitives[p.prim].material_id as usize]._pad;
        assert_ne!(pad(&scene, &piers[0]) & (crate::crack_geom::GEO_BIT | crate::crack_geom::CRAZE_BIT), 0, "the aged pier was rebuilt");
        stamp_aa(&mut scene, &piers, &lab, 1);
        assert_ne!(pad(&scene, &piers[0]) & AA_BIT, 0, "rebuilt geometry is AA-scoped");
        assert_eq!(pad(&scene, &piers[1]) & AA_BIT, 0, "a pristine greybox pier stays hard-edged");
        let core = lab.cores[0];
        assert!(core >= 0, "the aged pier has a chalk core");
        assert_ne!(scene.materials[core as usize]._pad & AA_BIT, 0, "the core (groove floors) is scoped too");
        // scope 2 narrows to the pick: nothing picked -> nobody opts in
        stamp_aa(&mut scene, &piers, &lab, 2);
        assert_eq!(pad(&scene, &piers[0]) & AA_BIT, 0, "scope 2 with no pick leaves the wall alone");
        lab.sel = Some(0);
        stamp_aa(&mut scene, &piers, &lab, 2);
        assert_ne!(pad(&scene, &piers[0]) & AA_BIT, 0, "scope 2 follows the pick");
    }

    /// One facade's piers, left to right, as `wall_slab` cuts them (piers share
    /// the parent run's rect; `z` picks a different run).
    fn facade(z: f32) -> Vec<crate::gym_scene::Pier> {
        let (run_lo, run_hi) = (Vec3::new(3.0, 0.0, z), Vec3::new(8.0, 2.1875, z + 0.25));
        [(3.0, 4.3), (4.7, 6.3), (6.7, 8.0)]
            .iter()
            .map(|(a, b)| crate::gym_scene::Pier {
                prim: 0,
                lo: Vec3::new(*a, 0.0, z),
                hi: Vec3::new(*b, 2.1875, z + 0.25),
                run_lo,
                run_hi,
            })
            .collect()
    }

    /// THE 2026-07-25 SPLIT, pinned: `vary` puts age/cracks on a GRADIENT along
    /// the facade (one bad end, one clean end — a real wall is eaten from one
    /// side) and leaves depth/chip on the per-pier hash (texture-scale dials; a
    /// facade with one uniform crack width would read as a repeated stamp).
    /// Before this, every knob was per-pier noise, which is precisely why one
    /// building read as a row of separately aged panels.
    #[test]
    fn seed_knobs_ramps_age_along_the_run_and_keeps_depth_per_pier() {
        let s = CrackSeed { age: 0.6, cracks: 0.5, depth: 0.6, chip: 0.2, spall: 0.0, vary: 0.5, policy: 0, params: crate::crack_geom::param_defaults(0), pristine: &[] };
        let piers = facade(3.0);
        let a = seed_knobs(&piers, &s);
        assert_eq!(a, seed_knobs(&piers, &s), "same level, same weathering");
        assert!(a.iter().flatten().all(|v| (0.0..=1.0).contains(v)), "clamped");
        // age + cracks: MONOTONE across the three panels, and the swing has to be
        // most of `vary` or the gradient is not visible (the raw noise amplitude
        // was a lottery, hence run_ramp's normalization)
        for lane in [0, 1] {
            let (l, m, r) = (a[0][lane], a[1][lane], a[2][lane]);
            assert!((l < m && m < r) || (l > m && m > r), "lane {lane} must ramp monotonically across the facade: {l} {m} {r}");
            assert!((r - l).abs() > 0.6 * s.vary, "lane {lane} swing {} must be most of vary {}", (r - l).abs(), s.vary);
        }
        assert!(a[0][2] != a[1][2] && a[1][2] != a[2][2], "depth stays per-pier (neighbours differ)");
        // which END is the bad one is per RUN: over a sweep of run rects both
        // directions must occur, or every facade in the game ages the same way
        let dirs: Vec<bool> = (0..12).map(|i| run_ramp(&facade(i as f32)[2]) > 0.0).collect();
        assert!(dirs.contains(&true) && dirs.contains(&false), "the ramp direction must vary per run: {dirs:?}");
        // THE SPLIT, stated as independence: two facades that age in OPPOSITE
        // directions must give the same pier index the same depth/chip (those are
        // per-pier and run-blind) and a different age/cracks (those are the run's)
        let (i, j) = (
            dirs.iter().position(|d| *d).unwrap() as f32,
            dirs.iter().position(|d| !*d).unwrap() as f32,
        );
        let (p, q) = (seed_knobs(&facade(i), &s), seed_knobs(&facade(j), &s));
        for k in 0..3 {
            assert_eq!((p[k][2], p[k][3]), (q[k][2], q[k][3]), "pier {k}: depth/chip must not depend on the run");
        }
        for k in [0, 2] {
            assert_ne!(p[k][0], q[k][0], "end pier {k}: age must follow ITS run's ramp (the middle pier sits at the pivot either way)");
        }
        assert!((p[0][0] - q[2][0]).abs() < 1e-6, "opposite ramps mirror each other end for end");
        // a one-pier run (the garden walls) has no gradient — base knobs, no NaN
        let solo = crate::gym_scene::Pier {
            prim: 0,
            lo: Vec3::new(10.0, 0.0, 9.9),
            hi: Vec3::new(16.0, 2.1875, 10.15),
            run_lo: Vec3::new(10.0, 0.0, 9.9),
            run_hi: Vec3::new(16.0, 2.1875, 10.15),
        };
        let one = seed_knobs(std::slice::from_ref(&solo), &s);
        assert!(one[0][0].is_finite() && (one[0][0] - s.age).abs() < 0.11, "a whole-run pier sits mid-ramp: {}", one[0][0]);
        let u = seed_knobs(&piers, &CrackSeed { vary: 0.0, ..s });
        assert!(u.windows(2).all(|w| w[0] == w[1]), "vary=0 is exactly uniform");
    }

    /// THE SPALL DIAL'S ZERO IS ABSOLUTE, and the demo's boot state keeps clean
    /// walls in frame. Both are what the first cut got wrong: additive variance
    /// meant `SPALL=0` still cratered a third of the level, so every before/after
    /// this effect was verified with compared spall against spall; and the demo
    /// seed put a crater on 13 of the gym's 15 walls, i.e. the loudest effect in
    /// the catalogue with nothing to read it against (review 2026-07-25).
    #[test]
    fn the_spall_dial_is_a_ceiling_so_zero_is_off_and_the_demo_boots_with_clean_walls() {
        let spec = house_game::gym::sim::gym_level();
        let (_scene, meta) = crate::gym_scene::build_gym(&spec, &crate::look::POLANA, true, 1.0);
        let boot = demo_seed();
        let dials = seed_spall(&meta.piers, &boot);
        assert_eq!(dials.len(), 15, "the crack lab's gym is 15 piers");
        let clean = dials.iter().filter(|d| **d <= crate::rebar::DIAL_ON).count();
        assert!((4..=9).contains(&clean), "the boot state needs a pristine control beside the damage: {clean} of 15 clean — {dials:?}");
        assert!(dials.iter().any(|d| *d > 0.55), "…and at least one wall blown far enough to show steel: {dials:?}");
        assert!(dials.iter().all(|d| *d <= boot.spall + 1e-6), "the dial is a CEILING, never a centre");
        // the off switch, at every `vary`: a zeroed dial builds nothing anywhere
        for vary in [0.0f32, 0.4, 1.0] {
            let off = seed_spall(&meta.piers, &CrackSeed { spall: 0.0, vary, ..boot });
            assert!(off.iter().all(|d| *d == 0.0), "SPALL=0 must be the geometric OFF switch at vary {vary}: {off:?}");
        }
        // …and vary = 0 is exactly uniform, so a harness shot can pin one dial
        let flat = seed_spall(&meta.piers, &CrackSeed { vary: 0.0, ..boot });
        assert!(flat.iter().all(|d| (*d - boot.spall).abs() < 1e-6), "vary=0 is exactly the dial");
    }

    /// THE NEGATIVE CONTROL, pinned (owner surface, 2026-07-25): a wall the demo
    /// names PRISTINE must come out as the PLAIN GREYBOX — not "less aged",
    /// exactly the greybox — because a level with damage on every wall reads as
    /// a texture and the aged tone silently becomes the level's base tone. It is
    /// also the state an age ramp has to start from.
    ///
    /// Vacuity guard: the same level seeded with an EMPTY pristine list must age
    /// both of those piers, or the assertions below pin nothing.
    #[test]
    fn a_wall_the_demo_names_pristine_is_exactly_the_plain_greybox() {
        let spec = house_game::gym::sim::gym_level();
        let boot = demo_seed();
        assert!(!boot.pristine.is_empty(), "the crack lab must ship a control wall");
        // (built inside the closure: `apply_geometry` mutates the scene)
        let build = |seed: Option<CrackSeed>| {
            let (mut scene, meta) = crate::gym_scene::build_gym(&spec, &crate::look::POLANA, true, 1.0);
            let mut lab = CrackLab::default();
            resolve(seed, &mut lab, &meta.piers, &mut scene, 1);
            let marks: Vec<i32> = meta.piers.iter().map(|p| scene.materials[scene.primitives[p.prim].material_id as usize]._pad).collect();
            // the pier's own geometry, verbatim — the eased-arris pass already
            // turned every static box into a mesh, so "unchanged" is measured
            // against the UN-AGED build, not against a 24-vertex box
            let geom: Vec<Vec<[f32; 3]>> = meta
                .piers
                .iter()
                .map(|p| {
                    let pr = &scene.primitives[p.prim];
                    (0..pr.vertex_count as usize).map(|v| scene.vertices[pr.vertex_offset as usize + v].pos).collect()
                })
                .collect();
            (meta, lab, marks, geom)
        };
        let (meta, lab, marks, geom) = build(Some(boot));
        let (_, _, _, plain) = build(None); // the same gym with no crack lab at all
        let control: Vec<usize> = boot.pristine.iter().map(|&(x, z)| pier_index_at(&meta.piers, x, z).unwrap_or_else(|| panic!("pristine point ({x}, {z}) must name a wall of the real gym"))).collect();
        assert_eq!(control.len(), 2, "one wall the ramp starts from + one that stays clean all session");
        assert_ne!(control[0], control[1], "the ramp wall and the permanent control must be different walls");
        for &i in &control {
            assert_eq!(lab.knobs[i], [0.0; 4], "pier {i}: a control wall carries no knobs");
            assert_eq!(lab.spall[i], 0.0, "pier {i}: …and no cover spall");
            assert_eq!(marks[i] >> 8, 0, "pier {i}: no knob BITS, so the shade pass's CRACK LAB block never fires (and never reads the story key)");
            assert_eq!(marks[i] & (crate::crack_geom::GEO_BIT | crate::crack_geom::CRAZE_BIT | AA_BIT), 0, "pier {i}: the generator built nothing, so it takes no AA either");
            assert_eq!(lab.cores[i], -1, "pier {i}: no chalk core");
            assert_eq!(lab.spall_mats[i], [-1, -1], "pier {i}: no steel, no basin");
            assert_eq!(geom[i], plain[i], "pier {i}: geometry identical to the un-aged gym — not a re-emitted mesh");
        }
        // …and the rest of the level IS aged, or "pristine" means nothing
        let aged = (0..meta.piers.len()).filter(|i| !control.contains(i)).filter(|&i| marks[i] >> 8 != 0).count();
        assert!(aged >= 10, "the other walls must still be weathered: {aged} of {}", meta.piers.len() - 2);
        // VACUITY: drop the pristine list and the same two piers age
        let (_, bare, bare_marks, bare_geom) = build(Some(CrackSeed { pristine: &[], ..boot }));
        for &i in &control {
            assert_ne!(bare_marks[i] >> 8, 0, "pier {i} must be aged without the pristine list — else this test pins nothing");
            assert!(bare.knobs[i] != [0.0; 4]);
            assert_ne!(bare_geom[i], plain[i], "…and its GEOMETRY moves too, so the equality above is a real check");
        }
    }

    /// THE AGE RAMP IS A STORY, not a cross-fade: zero is exactly the pristine
    /// control it starts from, every lane only ever grows, the layers arrive in
    /// the causal order (the glaze stains and crazes, the crack network opens
    /// through it, chips come off, and only then does the cover let go), and the
    /// end state is worse than the level's own boot aging — otherwise the beat
    /// ends on a wall that reads no worse than its neighbours.
    #[test]
    fn the_age_ramp_starts_at_the_greybox_and_ends_past_the_levels_own_aging() {
        assert_eq!(ramp_knobs(0.0), ([0.0; 4], 0.0), "t=0 must be the greybox, bit for bit");
        let boot = demo_seed();
        let (end, end_spall) = ramp_knobs(1.0);
        for (lane, (v, base)) in end.iter().zip([boot.age, boot.cracks, boot.depth, boot.chip]).enumerate() {
            assert!(*v > base, "lane {lane}: the ramp must end past the level's base {base}, not at {v}");
        }
        assert!(end_spall > boot.spall, "…including the cover spall: {end_spall} vs {}", boot.spall);
        // monotone on every lane (a knob that dips would UN-crack the wall mid-beat)
        let mut prev = ([0.0f32; 4], 0.0f32);
        let mut half = [None; 5];
        for k in 0..=200 {
            let t = k as f32 / 200.0;
            let (kn, sp) = ramp_knobs(t);
            for lane in 0..4 {
                assert!(kn[lane] >= prev.0[lane] - 1e-6, "lane {lane} dips at t={t}");
                if half[lane].is_none() && kn[lane] >= 0.5 * end[lane] {
                    half[lane] = Some(t);
                }
            }
            assert!(sp >= prev.1 - 1e-6, "spall dips at t={t}");
            if half[4].is_none() && sp >= 0.5 * end_spall {
                half[4] = Some(t); // the SAME half-of-final rule as the four lanes above
            }
            prev = (kn, sp);
        }
        let h = half.map(|v| v.expect("every lane must reach its half point inside the ramp"));
        assert!(h[0] < h[1], "the glaze must stain before the crack network opens: {h:?}");
        assert!(h[1] < h[3], "…and the network before the chips come off: {h:?}");
        assert!(h[3] < h[4], "…and the cover lets go LAST: {h:?}");
    }

    /// The beat's whole premise: the ramp grows real GEOMETRY, not only paint.
    /// If the pier's geometry signature barely moved, the demo would be a
    /// stain cross-fade with a fixed silhouette — and every commit frame the
    /// runner schedules would be wasted work.
    #[test]
    fn the_age_ramp_grows_geometry_the_whole_way_not_only_paint() {
        let spec = house_game::gym::sim::gym_level();
        let (x, z) = crate::demos::DemoRunner::age_point(crate::demos::by_name("crack lab").expect("the demo").script).expect("the crack lab ramps a wall");
        let steps: Vec<(u64, usize)> = (0..=15)
            .map(|k| {
                let t = k as f32 / 15.0;
                let (mut scene, meta) = crate::gym_scene::build_gym(&spec, &crate::look::POLANA, true, 1.0);
                let i = pier_index_at(&meta.piers, x, z).expect("the ramp point names a wall");
                let n = meta.piers.len();
                let (kn, sp) = ramp_knobs(t);
                let (mut knobs, mut spall) = (vec![[0.0; 4]; n], vec![0.0; n]);
                (knobs[i], spall[i]) = (kn, sp);
                let (policy, par) = (vec![0u8; n], vec![crate::crack_geom::param_defaults(0); n]);
                crate::crack_geom::apply_geometry(&mut scene, &meta.piers, &knobs, &policy, &par, &spall);
                let sig = crate::crack_geom::signatures(&scene, &meta.piers, &knobs, &policy, &par, &spall)[i];
                (sig, scene.indices.len() / 3)
            })
            .collect();
        let distinct: std::collections::BTreeSet<u64> = steps.iter().map(|s| s.0).collect();
        assert!(distinct.len() >= 10, "the ramp must cross at least 10 geometry buckets over 16 samples, got {}", distinct.len());
        let (first, last) = (steps[0].1, steps[15].1);
        assert!(last > first * 3 / 2, "the aged wall must carry far more geometry than the pristine one: {first} → {last} tris");
        // …and the growth is spread over the ramp, not one cliff at the end
        let grew = steps.windows(2).filter(|w| w[1].1 > w[0].1).count();
        assert!(grew >= 8, "geometry must keep arriving through the beat, not in one jump: {grew} of 15 steps grew");
    }

    /// The crack lab demo's authored boot seed — the state the owner's playtest
    /// actually opens in, read from `demos.rs` rather than copied.
    fn demo_seed() -> CrackSeed {
        crate::demos::DEMOS.iter().find(|d| d.name == "crack lab").and_then(|d| d.cracks).expect("the crack lab demo boots pre-aged")
    }
}
