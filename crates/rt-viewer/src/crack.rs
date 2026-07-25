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
    /// ± half-range of the deterministic per-pier variation on every knob.
    pub vary: f32,
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
    CrackSeed { age: n(0), cracks: n(1), depth: n(2), chip: n(3), vary, policy, params }
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

/// Stamp [`AA_BIT`] into the CPU scene for every pier (and its chalk core — the
/// groove floors are the crack's darkest pixels, so a scope that missed them
/// would AA the lips and leave the core hard). Returns the materials that
/// actually changed, so a live caller can stream just those.
pub fn stamp_aa(scene: &mut Scene, piers: &[Pier], lab: &CrackLab, scope: i32) -> Vec<(usize, i32)> {
    let mut out = Vec::new();
    for (i, pier) in piers.iter().enumerate() {
        let on = aa_wants(scene, pier, lab, i, scope);
        let core = lab.cores.get(i).copied().filter(|c| *c >= 0);
        for mid in [Some(scene.primitives[pier.prim].material_id), core].into_iter().flatten() {
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
        Some(s) => {
            // FIRST, before either the seeding or the geometry pass reads it: the
            // per-RUN story key (`base_color[3]`). Both the host damage field
            // (crack_geom) and the shade pass seed off this one f32, so it has to
            // be in the scene before anything derives anything from it.
            crate::wear::stamp_story(scene, piers);
            if lab.knobs.len() != piers.len() || lab.policy.len() != piers.len() || lab.params.len() != piers.len() {
                lab.knobs = seed_knobs(piers, &s);
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
            // structural faults + crazing become REAL geometry (crack_geom);
            // the built signature lets live knob drags rebuild only on change
            let par = lab.active_params();
            lab.cores = crate::crack_geom::apply_geometry(scene, piers, &lab.knobs, &lab.policy, &par);
            lab.geo_sigs = crate::crack_geom::signatures(scene, piers, &lab.knobs, &lab.policy, &par);
            stamp_aa(scene, piers, lab, aa_scope); // the AA scope's opt-in bits
        }
        None => {
            lab.knobs.clear();
            lab.policy.clear();
            lab.params.clear();
            lab.cores.clear();
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
    pub fn crack_release(&mut self) {
        if !self.crack.active {
            return;
        }
        let par = self.crack.active_params();
        let sigs = crate::crack_geom::signatures(&self.scene, &self.piers, &self.crack.knobs, &self.crack.policy, &par);
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
        } else {
            self.rebuild_in_look(look, ProbeRefresh::Local(&dirty));
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
        lab.cores = crate::crack_geom::apply_geometry(&mut scene, &piers, &lab.knobs, &lab.policy, &par);
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
        let s = CrackSeed { age: 0.6, cracks: 0.5, depth: 0.6, chip: 0.2, vary: 0.5, policy: 0, params: crate::crack_geom::param_defaults(0) };
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
}
