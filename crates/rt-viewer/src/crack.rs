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

/// Selection-highlight flag: `Material._pad` bit 3.
pub use crate::flags::SEL as SEL_BIT;

/// The `_pad` flag bits a knob stamp must PRESERVE: the whole flag byte
/// (bits 0..7) minus the selection bit, which the stamp itself recomputes.
/// Bits 0..2 are the gym's occluder/glass/matte marks, bit 4 (value 16) is the
/// last FREE flag, 5/6 are the geometry pass's GEO/CRAZE marks and 7 is the AA
/// opt-in. This constant exists because the two stamps used to spell the mask
/// out by hand and drifted apart (`& 7` at boot vs `& 231` on a live edit), so
/// any new flag bit was silently cleared at boot and every knob touch —
/// exactly the class of bug the 2026-07-25 catalogue's next flag would have hit.
pub const KEEP_FLAGS: i32 = crate::flags::BYTE & !SEL_BIT;

/// The greybox-detail AA opt-in ([`crate::gym_scene::AA_BIT`]) — the crack lab
/// is its first client: every pier the geometry pass actually rebuilt carries
/// it, and the `aa scope` row can narrow it to the picked wall.
pub use crate::gym_scene::AA_BIT;

/// The level's RUNS, in a stable order, plus which run each pier belongs to.
///
/// The RUN is the authoring unit (owner catalogue 2026-07-25, "one wall, one
/// story"). `gym_scene::wall_slab` cuts an authored slab into PIERS wherever a
/// window or a doorway interrupts it — a rendering fact the level builder never
/// typed and cannot see — so everything he says (the story, the shape, the pins)
/// is said about the run, and the piers inherit it.
pub fn runs_of(piers: &[Pier]) -> (Vec<crate::wall::RunRect>, Vec<usize>) {
    let mut runs: Vec<crate::wall::RunRect> = Vec::new();
    let mut of = Vec::with_capacity(piers.len());
    for p in piers {
        let same = |r: &&crate::wall::RunRect| (r.lo - p.run_lo).length() < 1e-4 && (r.hi - p.run_hi).length() < 1e-4;
        of.push(match runs.iter().position(|r| same(&r)) {
            Some(i) => i,
            None => {
                runs.push(crate::wall::RunRect { lo: p.run_lo, hi: p.run_hi });
                runs.len() - 1
            }
        });
    }
    (runs, of)
}

/// Live wear state on the [`Viewer`]: one [`crate::wall::WallSpec`] per RUN (the
/// level's, plus every panel edit), the sheets they compile to, and the
/// per-PIER materials the geometry pass minted from them.
///
/// The per-RUN / per-PIER split is the whole shape of this struct, and it is
/// load-bearing. Everything an author or the panel can SAY is per run; everything
/// the renderer produces is per pier. Before 2026-07-26 both halves were per
/// pier, so a facade cut into three panels by its windows held three
/// independently editable copies of one wall — the owner dragged a slider and one
/// third of a building changed.
pub struct CrackLab {
    /// Selection + panel enabled (the demo says `wear: Some(..)`).
    pub active: bool,
    /// The level's runs — the authoring unit.
    pub runs: Vec<crate::wall::RunRect>,
    /// Which RUN each pier belongs to (parallel to `Viewer::piers`).
    pub pier_run: Vec<usize>,
    /// Per RUN: what this wall says about itself — the level's authoring plus
    /// every panel edit. The AUTHORED intent, never the level rows' product: the
    /// three ESC rows are applied on the way to a sheet ([`Self::level_dials`]),
    /// so sliding `wear` back to 1 restores exactly what the author wrote and a
    /// panel edit survives all three.
    pub spec: Vec<crate::wall::WallSpec>,
    /// The `wear` master (ESC): 1 = the level as authored, 0 = the plain greybox.
    pub master: f32,
    /// `solo layer` (ESC): 0 = all of them, else `Layer::ALL[solo - 1]` alone.
    pub solo: usize,
    /// `surface grain` (ESC): a plate size in world units on every wall, or 0 to
    /// leave each wall its own.
    pub grain: f32,
    /// Per RUN: the name the level gave it — the panel's title, and what a
    /// [`crate::wall::Miss`] is reported against.
    pub label: Vec<&'static str>,
    /// Per RUN, per PATTERN: native params, so cycling the pattern keeps each
    /// one's tuning for the A/B (owner round 7).
    pub par: Vec<[[f32; crate::crack_geom::PARAMS_MAX]; crate::crack_geom::NPOL]>,
    /// Per RUN: the geometry pass skips this wall — the catalogue's paint-only
    /// specimens, the only way to see the shade pass's painted layers.
    pub paint_only: Vec<bool>,
    /// Per RUN: compiled. `wall::compile_specs` is the ONLY writer.
    pub sheets: Vec<crate::wall::Sheet>,
    /// The picked PIER. The ray hits a pier; the panel edits its RUN.
    pub sel: Option<usize>,
    pub row: usize,
    /// [`crate::crack_geom::GeoKey`] of the geometry currently BUILT into the
    /// scene, PER PIER — `Viewer::crack_release` rebuilds when a key disagrees,
    /// and the disagreeing entries are exactly the piers whose GI has to settle
    /// again. An integer struct, not a hash: `==` means "the built mesh is still
    /// right", by construction.
    pub geo_sigs: Vec<crate::crack_geom::GeoKey>,
    /// Each pier's CHALK CORE material (-1 = none): the groove floors live
    /// there, so the per-pier AA scope has to stamp it too.
    pub cores: Vec<i32>,
    /// What each pier's cover SPALL minted, `[steel, basin]` (-1 = none): the
    /// rebar in a crater is 1-2 px across and the crater's rim a 1-2 px lip, so
    /// both declare themselves to the contour AA alongside the pier and its core
    /// (CLAUDE.md, greybox detail = AA-scoped).
    pub spall_mats: Vec<[i32; 2]>,
}

impl Default for CrackLab {
    /// `master` is the only field whose empty value is not zero: 1 means "the
    /// level as authored", which is what a fresh lab has to be.
    fn default() -> CrackLab {
        CrackLab {
            active: false,
            runs: Vec::new(),
            pier_run: Vec::new(),
            spec: Vec::new(),
            master: 1.0,
            solo: 0,
            grain: 0.0,
            label: Vec::new(),
            par: Vec::new(),
            paint_only: Vec::new(),
            sheets: Vec::new(),
            sel: None,
            row: 0,
            geo_sigs: Vec::new(),
            cores: Vec::new(),
            spall_mats: Vec::new(),
        }
    }
}

impl CrackLab {
    /// The compiled wear, as both consumers read it — one datum, so the geometry
    /// pass and the material streamer cannot be looking at different sheets.
    pub fn wear(&self) -> crate::crack_geom::Wear<'_> {
        crate::crack_geom::Wear { sheets: &self.sheets, pier_run: &self.pier_run, paint_only: &self.paint_only }
    }

    /// The RUN the panel is editing.
    pub fn sel_run(&self) -> Option<usize> {
        self.pier_run.get(self.sel?).copied()
    }

    /// Recompile every run's sheet from its spec. Cheap (a sorted field sample
    /// per run) and it cannot fail — addressing already happened in
    /// [`crate::wall::specs_of`], which is what makes a live edit a
    /// pure-arithmetic step.
    pub fn recompile(&mut self) {
        let specs: Vec<(&'static str, crate::wall::WallSpec)> = self.label.iter().copied().zip(self.spec.iter().map(|s| self.level_dials(*s))).collect();
        self.sheets = crate::wall::compile_specs(&self.runs, &specs);
    }

    /// The three LEVEL-wide ESC rows, applied to one wall's authored spec. ONE
    /// place, on the way to a sheet, which is what makes them non-destructive:
    /// the authored spec is never overwritten, so every row is reversible and
    /// they compose with each other and with a panel edit.
    fn level_dials(&self, mut s: crate::wall::WallSpec) -> crate::wall::WallSpec {
        use crate::wall::Layer;
        // MASTER — scales the CAUSES and any PINS alike. Pins too, or a bench
        // wall (which is nothing but pins) would ignore the row entirely and
        // "show me this level clean" would leave the catalogue untouched.
        if self.master < 1.0 {
            let m = self.master.clamp(0.0, 1.0);
            s.story = crate::wall::Story { weather: s.story.weather * m, settlement: s.story.settlement * m, cover_loss: s.story.cover_loss * m };
            for l in Layer::ALL {
                if let Some(v) = s.pin.get(l) {
                    s.pin = s.pin.area(l, v * m);
                }
            }
        }
        // SOLO — pin every OTHER layer to zero. `derive` is still the only
        // writer; this is a pin like any other, which is why one row can do it.
        if self.solo > 0 {
            if let Some(keep) = Layer::ALL.get(self.solo - 1) {
                for l in Layer::ALL {
                    if l != *keep {
                        s.pin = s.pin.area(l, 0.0);
                    }
                }
            }
        }
        if self.grain > 0.0 {
            s.shape.grain = self.grain;
        }
        s
    }

    /// Point run `r`'s shape at pattern `code`, filling it from that pattern's
    /// own stored params. The two halves of the pattern state — which one is
    /// active, and each one's dialing — meet only here.
    pub fn set_pattern(&mut self, r: usize, code: u8) {
        let par = self.par[r][code as usize % crate::crack_geom::NPOL];
        self.spec[r].shape.pattern = crate::wall::pattern_of(code, par);
    }
}

/// Pack the two painted layers' STRENGTHS into `Material._pad` bits 8..31
/// (6-bit unorm each): stain at 8, web at 14, lanes 2/3 (bits 20, 26) unused.
/// The shader unpack (`shade.comp` / `shade.metal`, CRACK LAB block) mirrors
/// this exactly — pinned by the test.
///
/// Four knobs used to live here — age, cracks, depth, chip — and the shade pass
/// read exactly ONE of them (`age`) for both painted layers, because the other
/// three are geometry dials it has no business reading. So three of the four
/// lanes were paying rent for nothing while the two layers it does draw shared a
/// single strength. Now each layer carries its own.
pub fn pad_bits(p: crate::wall::Paint) -> i32 {
    let q = |v: f32| (v.clamp(0.0, 1.0) * 63.0).round() as u32;
    ((q(p.stain_amt) << 8) | (q(p.web_amt) << 14)) as i32
}

/// A pier's stamped `_pad`: the surviving flags ([`KEEP_FLAGS`]) + this wall's
/// paint lanes + the recomputed selection bit. ONE expression, shared by the
/// boot/rebuild stamp ([`stamp_all`]) and the live edit ([`Viewer::crack_apply`])
/// — they are the same operation and drifted when spelled out twice.
pub fn stamped_pad(pad: i32, p: crate::wall::Paint, selected: bool) -> i32 {
    (pad & KEEP_FLAGS) | pad_bits(p) | if selected { SEL_BIT } else { 0 }
}

/// Shader-side unpack, host-mirrored (the layout-pin test's other half).
#[cfg(test)]
pub fn unpack(pad: i32) -> [f32; 2] {
    let kb = pad as u32;
    let u = |sh: u32| ((kb >> sh) & 63) as f32 / 63.0;
    [u(8), u(14)]
}

/// `STORY=weather,settlement,cover_loss` — the three CAUSES, applied to every
/// run of the level, for headless SHOT verification. A shell-only env read, like
/// LOOK/PROJ/LEVEL (see the config.rs exception list).
///
/// It replaces `CRACKS=age,cracks,depth,chip`, whose four components no longer
/// exist as a set: two of them were amounts, one was a plate size and one was a
/// groove depth. A harness that asks for a STORY gets the same walls the level
/// builder would get from typing it.
fn story_from_env() -> Option<crate::wall::Story> {
    let v = std::env::var("STORY").ok()?;
    let parts: Vec<&str> = v.split(',').map(str::trim).collect();
    let n = |i: usize| parts.get(i).and_then(|s| s.parse::<f32>().ok()).unwrap_or(0.0);
    Some(crate::wall::Story { weather: n(0), settlement: n(1), cover_loss: n(2) })
}

/// `SHAPE=grain,relief[,pattern[,p1,p2,p3]]` — the wall's SHAPE, applied to
/// every run. `grain` is a plate size in world units, `pattern` a
/// `crack_geom::POLICIES` name or index. Shell-only, like [`story_from_env`].
fn shape_from_env() -> Option<crate::wall::Shape> {
    let v = std::env::var("SHAPE").ok()?;
    let parts: Vec<&str> = v.split(',').map(str::trim).collect();
    let f = |i: usize, d: f32| parts.get(i).and_then(|s| s.parse::<f32>().ok()).unwrap_or(d);
    let code = parts.get(2).map(|s| crate::crack_geom::policy_index(s)).unwrap_or(0);
    let mut par = crate::crack_geom::param_defaults(code);
    for (j, slot) in par.iter_mut().enumerate() {
        *slot = f(3 + j, *slot);
    }
    Some(crate::wall::Shape { grain: f(0, crate::wall::Shape::DEFAULT.grain), relief: f(1, crate::wall::Shape::DEFAULT.relief), pattern: crate::wall::pattern_of(code, par) })
}

/// `SPALL=<0..1>` — the cover-loss CAUSE on its own, kept as its own knob
/// because it is the owner's 2026-07-25 headline and every A/B recipe on record
/// uses it. Applied after [`story_from_env`], so `SPALL=0` is the "before" side
/// of every shot of this effect whatever else the level says.
fn spall_from_env() -> Option<f32> {
    std::env::var("SPALL").ok().and_then(|v| v.trim().parse::<f32>().ok())
}

/// `SPREAD=<0..1>` — the per-RUN story spread. A bare `STORY=` would otherwise
/// pin it to 0 and every verification shot would show one uniform level (review
/// finding, 2026-07-25, when this was `CRACK_VARY`).
fn spread_from_env() -> Option<f32> {
    std::env::var("SPREAD").ok().and_then(|v| v.trim().parse::<f32>().ok())
}

/// `WEAR_EDIT=weather,settlement,cover_loss[,run]` — the harness's stand-in for
/// the owner dragging the panel and letting go: after boot, write this story
/// (onto every run, or only `run`) and take the RELEASE path a mouse-up takes.
/// It exists because the release path is the expensive one — an agent cannot
/// click, and "boot straight into the final story" measures the BOOT bake, not
/// the rebuild.
fn edit_from_env() -> Option<(crate::wall::Story, Option<usize>)> {
    std::env::var("WEAR_EDIT").ok().map(|v| {
        let parts: Vec<&str> = v.split(',').map(str::trim).collect();
        let n = |i: usize| parts.get(i).and_then(|s| s.parse::<f32>().ok()).unwrap_or(0.0);
        (crate::wall::Story { weather: n(0), settlement: n(1), cover_loss: n(2) }, parts.get(3).and_then(|s| s.parse::<usize>().ok()))
    })
}

/// Apply every environment override to a resolved spec list. One place, so a
/// harness shot and the owner's own level cannot diverge in how they are read.
fn apply_env(specs: &mut [(&'static str, crate::wall::WallSpec)]) {
    let (story, shape, spall) = (story_from_env(), shape_from_env(), spall_from_env());
    if story.is_none() && shape.is_none() && spall.is_none() {
        return;
    }
    for (_, spec) in specs.iter_mut() {
        if let Some(st) = story {
            spec.story = st;
            spec.pin = crate::wall::Pins::NONE; // an override asks for the CAUSE, not the level's pins
        }
        if let Some(sh) = shape {
            spec.shape = sh;
        }
        if let Some(v) = spall {
            spec.story.cover_loss = v;
        }
    }
}

/// The wall pier a world (x, z) column runs through — how a demo names a wall
/// ([`crate::demos::Action::AgeWall`]) without knowing how `wall_slab` happened
/// to cut the run into piers. Mid-height, so a point authored on the ground
/// plane still lands in the slab.
pub fn pier_index_at(piers: &[Pier], x: f32, z: f32) -> Option<usize> {
    let p = Vec3::new(x, 1.0, z);
    piers.iter().position(|q| q.lo.cmple(p).all() && q.hi.cmpge(p).all())
}

/// The AGE RAMP curve: one 0..1 dial → a [`crate::wall::Story`], for the demo
/// beat that weathers a wall while the owner watches
/// ([`crate::demos::Action::AgeWall`]).
///
/// The three causes are STAGGERED rather than ramped together, because that is
/// the causal order the catalogue is built on and it is what makes the beat read
/// as a story instead of a cross-fade: the glaze stains and crazes first (that
/// is `weather` alone, on `derive`'s own ladder), the wall starts to shift, and
/// only at the end does the cover let go and show the rebar. `t = 0` returns
/// `Story::ZERO`, so the ramp's first frame is the pristine control it started
/// from, bit for bit.
///
/// It used to ramp five KNOBS through five hand-placed windows, four of which
/// were the same causal ladder `wall::derive` now owns — so the beat and the
/// authoring model each had their own opinion about what "getting older" means.
pub fn ramp_story(t: f32) -> crate::wall::Story {
    let seg = |a: f32, b: f32| {
        let u = ((t - a) / (b - a)).clamp(0.0, 1.0);
        u * u * (3.0 - 2.0 * u) // smoothstep: a linear cause crossing a gate pops
    };
    crate::wall::Story { weather: 0.95 * seg(0.00, 0.85), settlement: 0.55 * seg(0.35, 0.90), cover_loss: 0.85 * seg(0.60, 1.00) }
}

/// Write the paint lanes (and the selection bit) into the scene's materials —
/// the boot/rebuild path; live edits go through `Viewer::crack_apply` and the
/// backend's per-frame material stream instead.
pub fn stamp_all(scene: &mut Scene, piers: &[Pier], lab: &CrackLab) {
    for (i, pier) in piers.iter().enumerate() {
        let paint = lab.pier_run.get(i).and_then(|r| lab.sheets.get(*r)).map(|s| s.paint).unwrap_or_default();
        let mid = scene.primitives[pier.prim].material_id as usize;
        scene.materials[mid]._pad = stamped_pad(scene.materials[mid]._pad, paint, lab.sel == Some(i));
    }
}

/// Which piers opt into the contour AA at this scope: 1 = every wall the
/// generator actually built on, 2 = the PICKED one only (the owner's per-wall
/// A/B), 0 = the shader ignores the bit and AAs everything, anything else =
/// nothing.
fn aa_wants(scene: &Scene, pier: &Pier, lab: &CrackLab, i: usize, scope: i32) -> bool {
    match scope {
        // MODIFIED geometry: the pier's material carries the geometry pass's own
        // marks, so this is "the generator actually rebuilt this wall" rather
        // than "its amounts are non-zero" (a wall whose damage field left it
        // pristine builds nothing and must stay hard-edged)
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
/// hard) and the exposed rebar (1-2 px across, and its silhouette against the
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

/// Resolve the level's wear against a freshly built scene (boot and every
/// `apply_look` rebuild): the authored [`crate::wall::LevelWear`] seeds every
/// run's spec ONCE, and a rebuild with the same runs keeps the owner's live
/// edits (a look switch must not undo his dialing). No wear clears the lab.
///
/// An addressing MISS is loud and then survivable: the viewer boots with that
/// wall on the level's base story, because a black window is worse than a wall
/// that is less weathered than intended. It is FATAL where it can be —
/// `demos::every_demo_compiles_against_its_own_level`.
pub fn resolve(wear: Option<&'static crate::wall::LevelWear>, lab: &mut CrackLab, piers: &[Pier], scene: &mut Scene, aa_scope: i32) {
    let Some(lw) = wear else {
        *lab = CrackLab::default();
        return;
    };
    // FIRST, before anything derives anything from it: the per-RUN story key
    // (`base_color[3]`). Both the host damage field (crack_geom) and the shade
    // pass seed off this one f32.
    crate::wear::stamp_story(scene, piers);
    let (runs, pier_run) = runs_of(piers);
    if lab.runs.len() != runs.len() || lab.pier_run != pier_run {
        let mut specs = crate::wall::specs_of(&runs, lw).unwrap_or_else(|misses| {
            for m in &misses {
                eprintln!("wear: {m:?} — that wall keeps the level's base story");
            }
            runs.iter()
                .map(|_| ("", crate::wall::WallSpec { story: lw.base, origin: lw.origin, ..crate::wall::WallSpec::PRISTINE }))
                .collect()
        });
        apply_env(&mut specs);
        if let Some(sp) = spread_from_env() {
            let lw2 = crate::wall::LevelWear { spread: sp, ..*lw };
            if let Ok(mut s) = crate::wall::specs_of(&runs, &lw2) {
                apply_env(&mut s);
                specs = s;
            }
        }
        lab.par = specs
            .iter()
            .map(|(_, sp)| {
                let mut per = [crate::crack_geom::param_defaults(0), crate::crack_geom::param_defaults(1), crate::crack_geom::param_defaults(2)];
                per[sp.shape.pattern.code() as usize] = crate::wall::par_of(sp.shape.pattern);
                per
            })
            .collect();
        lab.paint_only = specs.iter().map(|(_, sp)| sp.paint_only).collect();
        lab.label = specs.iter().map(|(l, _)| *l).collect();
        lab.spec = specs.iter().map(|(_, sp)| *sp).collect();
        // CRACK_SEL=<pier index> preselects a segment for the headless harness
        // (the owner picks by clicking; an agent cannot, and the selection drives
        // the AA scope as well as the panel).
        lab.sel = std::env::var("CRACK_SEL").ok().and_then(|v| v.parse::<usize>().ok()).filter(|i| *i < piers.len());
        lab.row = 0;
    }
    lab.runs = runs;
    lab.pier_run = pier_run;
    lab.recompile();
    stamp_all(scene, piers, lab);
    // structural breaks + crazing + cover spall become REAL geometry
    let aged = crate::crack_geom::apply_geometry(scene, piers, lab.wear());
    (lab.cores, lab.spall_mats) = (aged.cores, aged.spall_mats);
    lab.geo_sigs = crate::crack_geom::keys(scene, piers, lab.wear());
    stamp_aa(scene, piers, lab, aa_scope); // the AA scope's opt-in bits
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

    /// Recompute + push pier `i`'s material `_pad` (paint lanes + selection),
    /// mirrored into the CPU scene (so rebuilds re-stamp the truth) and the
    /// backend's live material stream (visible next frame, nothing rebuilds).
    /// Every other flag is preserved ([`KEEP_FLAGS`]): GEO/CRAZE describe the
    /// geometry currently BUILT (only `crack_release`'s rebuild may change
    /// those), AA the scope, and the rest are the gym's own surface marks.
    pub fn crack_apply(&mut self, i: usize) {
        let paint = self.crack.pier_run.get(i).and_then(|r| self.crack.sheets.get(*r)).map(|s| s.paint).unwrap_or_default();
        let mid = self.scene.primitives[self.piers[i].prim].material_id as usize;
        let pad = stamped_pad(self.scene.materials[mid]._pad, paint, self.crack.sel == Some(i));
        self.scene.materials[mid]._pad = pad;
        self.backend.set_material_pad(mid, pad);
    }

    /// A live EDIT of run `r`'s spec, as the panel makes it: recompile the run,
    /// re-stream the paint of every pier the run was cut into — both the `_pad`
    /// lanes AND the effect word, because a story move changes the layers'
    /// strengths and their solved thresholds together — and leave the geometry
    /// for the release.
    ///
    /// Both halves, on every edit, is the fix for a real class of bug: the pad
    /// went out on a drag and the word only at boot, so the two painted layers'
    /// STRENGTH and their AREA came from different states of the same slider,
    /// and the wall drew stains at the new intensity inside the old patch.
    pub fn wear_edit(&mut self, r: usize) {
        self.crack.recompile();
        for i in 0..self.piers.len() {
            if self.crack.pier_run.get(i) == Some(&r) {
                self.crack_apply(i);
            }
        }
        self.wear_stamp();
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

    /// A LEVEL-WIDE wear row moved (`wear`, `solo layer`, `surface grain`):
    /// re-derive every run's sheet and re-stream all the paint. The geometry
    /// waits for the release, exactly like the panel's own rows — these rows are
    /// the level's version of the same edit, so they take the same path.
    pub fn wear_level_apply(&mut self) {
        if !self.crack.active {
            return;
        }
        self.crack.recompile();
        for i in 0..self.piers.len() {
            self.crack_apply(i);
        }
        self.wear_stamp();
    }

    /// Slider released (or the pattern row clicked): if the drag changed the
    /// built geometry — which faults exist, the craze bucket, the policy,
    /// its native params — rebuild the scene so the aging opens in place.
    /// Dial-within-a-bucket knob drags stay live-material cheap.
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
        let sigs = crate::crack_geom::keys(&self.scene, &self.piers, self.crack.wear());
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

    /// One frame of the AGE RAMP beat: write the ramped STORY onto the named
    /// wall's RUN (live, through the material stream — the painted layers move
    /// every frame for free) and, on a `commit` frame, rebuild so the geometry
    /// that story implies actually opens. The rebuild is a no-op unless a
    /// `GeoKey` moved, so the number of real rebuilds is the number of geometry
    /// buckets the ramp crosses, not the number of commit frames.
    pub fn age_wall_step(&mut self, x: f32, z: f32, t: f32, commit: bool) {
        if !self.crack.active {
            return; // a demo with no authored wear has nothing to ramp
        }
        let Some(r) = crate::crack::pier_index_at(&self.piers, x, z).and_then(|i| self.crack.pier_run.get(i).copied()) else {
            return; // a point that misses every wall is reported once, at boot
        };
        self.crack.spec[r].story = crate::crack::ramp_story(t);
        self.wear_edit(r);
        if commit {
            self.crack_rebuild(true);
        }
    }

    /// Replay a panel drag from the environment (`WEAR_EDIT=`, see
    /// [`edit_from_env`]): write the story live like a drag, then release. Runs
    /// at the very end of boot, so it exercises exactly the owner's path —
    /// including the rebuild and its probe refresh.
    pub fn crack_edit_from_env(&mut self) {
        let Some((story, which)) = edit_from_env() else { return };
        if !self.crack.active {
            eprintln!("WEAR_EDIT: this level has no authored wear — ignored");
            return;
        }
        for r in 0..self.crack.spec.len() {
            if which.is_none_or(|w| w == r) {
                self.crack.spec[r].story = story;
                self.wear_edit(r);
            }
        }
        println!("wear: WEAR_EDIT {story:?} on {} — releasing", which.map(|r| format!("run {r}")).unwrap_or_else(|| "every run".into()));
        self.crack_release();
    }

    /// The panel's pattern row: cycle the picked WALL's pattern — the release
    /// event that follows the click sees the changed key and rebuilds.
    pub fn crack_cycle_policy(&mut self) {
        if let Some(r) = self.crack.sel_run() {
            let n = crate::crack_geom::POLICIES.len() as u8;
            let next = (self.crack.spec[r].shape.pattern.code() + 1) % n;
            self.crack.set_pattern(r, next);
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
    use crate::wall::{LevelWear, Story, WallSpec};

    /// Build a level and resolve the given wear onto it.
    fn build(level: crate::demos::Level, wear: Option<&'static LevelWear>) -> (rt_probe::Scene, crate::gym_scene::GymMeta, CrackLab) {
        let (mut scene, meta) = crate::gym_scene::build_gym(&level.spec(), &crate::look::POLANA, true);
        let mut lab = CrackLab::default();
        resolve(wear, &mut lab, &meta.piers, &mut scene, 1);
        (scene, meta, lab)
    }
    fn pad_of(scene: &rt_probe::Scene, meta: &crate::gym_scene::GymMeta, i: usize) -> i32 {
        scene.materials[scene.primitives[meta.piers[i].prim].material_id as usize]._pad
    }
    /// A pier's own vertices, verbatim — for "is this wall bit-identical to the
    /// un-aged one" questions.
    fn verts(scene: &rt_probe::Scene, meta: &crate::gym_scene::GymMeta, i: usize) -> Vec<[f32; 3]> {
        let pr = &scene.primitives[meta.piers[i].prim];
        (0..pr.vertex_count as usize).map(|v| scene.vertices[pr.vertex_offset as usize + v].pos).collect()
    }

    /// The bit layout the shaders unpack (shade.comp / shade.metal CRACK LAB
    /// block): the two painted layers' STRENGTHS as 6-bit unorms at bits 8 and
    /// 14, flags 0..7 untouched, lanes 2/3 unused.
    #[test]
    fn pad_bits_layout_matches_the_shader_unpack() {
        let p = |stain: f32, web: f32| crate::wall::Paint { stain_amt: stain, web_amt: web, ..Default::default() };
        assert_eq!(pad_bits(p(0.0, 0.0)), 0, "no paint = zero bits (bit-identical image)");
        assert_eq!(pad_bits(p(1.0, 0.0)), 63 << 8);
        assert_eq!(pad_bits(p(0.0, 1.0)), 63 << 14);
        // …and nothing above lane 1: three of the four lanes used to be paid for
        // and never read
        assert_eq!(pad_bits(p(1.0, 1.0)) >> 20, 0, "lanes 2/3 must stay empty until something reads them");
        for (a, b) in unpack(pad_bits(p(0.55, 0.30))).iter().zip([0.55, 0.30]) {
            assert!((a - b).abs() <= 0.5 / 63.0, "{a} vs {b}");
        }
        assert_eq!(pad_bits(p(1.0, 1.0)) & 0xFF, 0, "paint bits never touch the flag byte");
    }

    /// THE MASK PIN (2026-07-25): a paint stamp recomputes the paint lanes and
    /// the selection bit and PRESERVES every other flag. Both stamps used to
    /// spell the mask out by hand — `& 7` at boot, `& 231` on a live edit — so a
    /// new flag bit died at boot and on every touch, silently. Pinned through
    /// the boot path AND the live expression, since a painted effect landing on
    /// a cleared flag looks like "the shader is wrong" and costs a session.
    #[test]
    fn a_marked_flag_survives_the_boot_stamp_and_a_live_edit() {
        use crate::gym_scene::Pier;
        use rt_probe::Scene;
        const FREE_BIT: i32 = crate::flags::FREE16;
        let mut scene = Scene::default();
        let (lo, hi) = (Vec3::new(1.0, 0.0, 9.9), Vec3::new(7.0, 2.2, 10.15));
        scene.add_box_world(lo, hi, [0.9, 0.9, 0.9, 1.0], [0.0; 4], 0.85, 0.0);
        let piers = vec![Pier { prim: scene.primitives.len() - 1, lo, hi, run_lo: lo, run_hi: hi }];
        let mid = scene.primitives[piers[0].prim].material_id as usize;
        let marks = crate::flags::OCCLUDER | crate::flags::MATTE | FREE_BIT | crate::crack_geom::GEO_BIT | crate::crack_geom::CRAZE_BIT | AA_BIT;
        scene.materials[mid]._pad = marks | SEL_BIT;

        // one run, one wall, weathered: the boot/rebuild path
        let (runs, pier_run) = runs_of(&piers);
        let mut lab = CrackLab {
            runs,
            pier_run,
            spec: vec![WallSpec { story: Story { weather: 0.8, ..Story::ZERO }, ..WallSpec::PRISTINE }],
            label: vec![""],
            paint_only: vec![false],
            ..Default::default()
        };
        lab.recompile();
        stamp_all(&mut scene, &piers, &lab);
        assert_eq!(scene.materials[mid]._pad & 0xFF, marks, "flags survive the boot stamp; a stale selection does not");
        let paint = lab.sheets[0].paint;
        assert_ne!(pad_bits(paint), 0, "VACUOUS: this wall carries no paint");
        assert_eq!(scene.materials[mid]._pad >> 8, pad_bits(paint) >> 8);

        // the live edit (`Viewer::crack_apply` is exactly this expression)
        let pad = stamped_pad(scene.materials[mid]._pad, paint, true);
        assert_eq!(pad & 0xFF, marks | SEL_BIT, "flags survive a live edit, selection follows the pick");
        assert_eq!(stamped_pad(pad, paint, false) & SEL_BIT, 0, "deselect clears only the selection bit");
    }

    /// **ONE RUN, ONE SHEET** — the round's whole thesis, as an equality.
    ///
    /// Every pier `wall_slab` cut out of one authored slab must read the SAME
    /// sheet and produce the SAME `GeoKey`, on both shipped levels. It is true by
    /// construction now (a sheet is per run and the piers index into it), and
    /// that is exactly why it is worth pinning: the previous three rounds each
    /// had to chase a per-PANEL value standing in for a per-RUN one — the fault
    /// seed, the break count, the field level — and each time the symptom was a
    /// facade that disagreed with itself across a window jamb.
    #[test]
    fn one_run_one_sheet() {
        for level in [crate::demos::Level::Gym, crate::demos::Level::Catalogue] {
            let wear = if level == crate::demos::Level::Gym { &crate::demos::LAB_WEAR } else { &crate::demos::CATALOGUE_WEAR };
            let (scene, meta, lab) = build(level, Some(wear));
            let keys = crate::crack_geom::keys(&scene, &meta.piers, lab.wear());
            let mut shared = 0;
            for i in 0..meta.piers.len() {
                for j in 0..meta.piers.len() {
                    if lab.pier_run[i] != lab.pier_run[j] {
                        continue;
                    }
                    assert_eq!(keys[i], keys[j], "{level:?}: piers {i} and {j} are one wall and disagree about its geometry");
                    shared += (i != j) as usize;
                }
            }
            // the vacuity guard: SOME run really is cut into more than one pier
            // (the gym's windowed facades), or the equality above is trivial
            if level == crate::demos::Level::Gym {
                assert!(shared > 0, "VACUOUS: no gym run is cut into two piers");
            }
            assert_eq!(lab.sheets.len(), lab.runs.len(), "one sheet per run");
            assert!(lab.runs.len() < meta.piers.len() || level == crate::demos::Level::Catalogue, "the gym must have fewer runs than piers");
        }
    }

    /// SPREAD IS BETWEEN RUNS, NEVER INSIDE ONE. A level reads varied because
    /// its WALLS differ, not because a wall's panels do — which is the whole
    /// difference between "one building" and "a stack of separately aged slabs"
    /// (owner catalogue 2026-07-25). The `vary` this replaces was per-PIER noise,
    /// and its later fix was a per-pier RAMP along the run: closer, but still a
    /// per-panel value, and still the thing that had to be special-cased in
    /// three rounds running.
    #[test]
    fn the_spread_varies_walls_and_never_panels() {
        let (_, _, lab) = build(crate::demos::Level::Gym, Some(&crate::demos::LAB_WEAR));
        let w: Vec<f32> = lab.spec.iter().map(|s| s.story.weather).collect();
        let (lo, hi) = (w.iter().cloned().fold(f32::MAX, f32::min), w.iter().cloned().fold(0.0f32, f32::max));
        assert!(hi - lo > 0.2, "the level must read varied wall to wall: {w:?}");
        // …and the two named controls are exactly zero, not merely low
        let zeros = lab.spec.iter().filter(|s| s.story == Story::ZERO).count();
        assert_eq!(zeros, 2, "the lab ships one ramped control and one permanent one");
        // NO spread inside a run: `spec` is per run, so this is a statement
        // about the model's shape, and the sheet equality above closes it.
        assert_eq!(lab.spec.len(), lab.runs.len());
    }

    /// THE NEGATIVE CONTROL, pinned (owner surface, 2026-07-25): a wall the level
    /// names PRISTINE comes out as the PLAIN GREYBOX — not "less aged", exactly
    /// the greybox — because a level with damage on every wall reads as a texture
    /// and the aged tone silently becomes the level's base tone. It is also the
    /// state an age ramp has to start from.
    ///
    /// Vacuity guard: the same level with the controls REMOVED must age both of
    /// those walls, or the assertions below pin nothing.
    #[test]
    fn a_wall_the_level_names_pristine_is_exactly_the_plain_greybox() {
        static NO_CONTROLS: LevelWear = LevelWear { walls: &[], ..crate::demos::LAB_WEAR };
        let (scene, meta, lab) = build(crate::demos::Level::Gym, Some(&crate::demos::LAB_WEAR));
        let (plain_scene, plain_meta, _) = build(crate::demos::Level::Gym, None);
        let (bare_scene, bare_meta, bare) = build(crate::demos::Level::Gym, Some(&NO_CONTROLS));

        let control: Vec<usize> = crate::demos::LAB_WEAR
            .walls
            .iter()
            .map(|w| pier_index_at(&meta.piers, w.at.0, w.at.1).unwrap_or_else(|| panic!("control \"{}\" must name a wall of the real gym", w.label)))
            .collect();
        assert_eq!(control.len(), 2, "one wall the ramp starts from + one that stays clean all session");
        assert_ne!(control[0], control[1], "the ramp wall and the permanent control must be different walls");
        for &i in &control {
            let r = lab.pier_run[i];
            assert_eq!(lab.spec[r].story, Story::ZERO, "pier {i}: a control wall has no story");
            assert_eq!(pad_of(&scene, &meta, i) >> 8, 0, "pier {i}: no paint BITS, so the shade pass's CRACK LAB block never fires");
            assert_eq!(
                pad_of(&scene, &meta, i) & (crate::crack_geom::GEO_BIT | crate::crack_geom::CRAZE_BIT | AA_BIT),
                0,
                "pier {i}: the generator built nothing, so it takes no AA either"
            );
            assert_eq!(lab.cores[i], -1, "pier {i}: no chalk core");
            assert_eq!(lab.spall_mats[i], [-1, -1], "pier {i}: no steel, no basin");
            assert_eq!(verts(&scene, &meta, i), verts(&plain_scene, &plain_meta, i), "pier {i}: geometry identical to the un-aged gym");
            // VACUITY: without the control list, the same wall ages
            assert_ne!(pad_of(&bare_scene, &bare_meta, i) >> 8, 0, "pier {i} must age without the control list — else this test pins nothing");
            assert_ne!(bare.spec[bare.pier_run[i]].story, Story::ZERO);
            assert_ne!(verts(&bare_scene, &bare_meta, i), verts(&plain_scene, &plain_meta, i), "…and its GEOMETRY moves too");
        }
        // …and the rest of the level IS aged, or "pristine" means nothing
        let aged = (0..meta.piers.len()).filter(|i| !control.contains(i)).filter(|&i| pad_of(&scene, &meta, i) >> 8 != 0).count();
        assert!(aged >= 10, "the other walls must still be weathered: {aged} of {}", meta.piers.len() - 2);
    }

    /// THE AGE RAMP IS A STORY, not a cross-fade: zero is exactly the pristine
    /// control it starts from, every cause only ever grows, they arrive in the
    /// causal order, and the end state is worse than the level's own boot aging —
    /// otherwise the beat ends on a wall that reads no worse than its neighbours.
    #[test]
    fn the_age_ramp_starts_at_the_greybox_and_ends_past_the_levels_own_aging() {
        assert_eq!(ramp_story(0.0), Story::ZERO, "t=0 must be the greybox, bit for bit");
        let base = crate::demos::LAB_WEAR.base;
        let end = ramp_story(1.0);
        let lanes = |s: Story| [s.weather, s.settlement, s.cover_loss];
        for (i, (v, b)) in lanes(end).iter().zip(lanes(base)).enumerate() {
            assert!(*v > b, "cause {i}: the ramp must end past the level's base {b}, not at {v}");
        }
        let mut prev = [0.0f32; 3];
        let mut half = [None; 3];
        for k in 0..=200 {
            let t = k as f32 / 200.0;
            let l = lanes(ramp_story(t));
            for i in 0..3 {
                assert!(l[i] >= prev[i] - 1e-6, "cause {i} dips at t={t}");
                if half[i].is_none() && l[i] >= 0.5 * lanes(end)[i] {
                    half[i] = Some(t);
                }
            }
            prev = l;
        }
        let h = half.map(|v| v.expect("every cause must reach its half point inside the ramp"));
        assert!(h[0] < h[1], "the glaze must weather before the wall starts shifting: {h:?}");
        assert!(h[1] < h[2], "…and the cover lets go LAST: {h:?}");
    }

    /// The beat's whole premise: the ramp grows real GEOMETRY, not only paint.
    /// If the wall's key barely moved, the demo would be a stain cross-fade with
    /// a fixed silhouette — and every commit frame the runner schedules would be
    /// wasted work.
    ///
    /// Measured on the MESH, not on a triangle COUNT. It used to compare counts,
    /// which read 9 of 15 the day the spall stopped ramping its lens size — while
    /// the craters had moved, resized and re-sited on every one of those steps.
    /// A proxy that answers the wrong question is worse than no test.
    #[test]
    fn the_age_ramp_grows_geometry_the_whole_way_not_only_paint() {
        let (x, z) = crate::demos::DemoRunner::age_point(crate::demos::by_name("crack lab").expect("the demo").script).expect("the crack lab ramps a wall");
        let steps: Vec<(crate::crack_geom::GeoKey, usize, u64)> = (0..=15)
            .map(|k| {
                let (mut scene, meta) = crate::gym_scene::build_gym(&crate::demos::Level::Gym.spec(), &crate::look::POLANA, true);
                let mut lab = CrackLab::default();
                resolve(Some(&crate::demos::LAB_WEAR), &mut lab, &meta.piers, &mut scene, 1);
                let i = pier_index_at(&meta.piers, x, z).expect("the ramp point names a wall");
                let r = lab.pier_run[i];
                // ONE wall ramps and every other one stays pristine, so the
                // triangle count below is about the beat's own wall and not
                // about the level around it
                lab.spec = lab.spec.iter().map(|_| WallSpec::PRISTINE).collect();
                lab.spec[r].story = ramp_story(k as f32 / 15.0);
                lab.recompile();
                let aged = crate::crack_geom::apply_geometry(&mut scene, &meta.piers, lab.wear());
                lab.cores = aged.cores;
                let sig = crate::crack_geom::keys(&scene, &meta.piers, lab.wear())[i];
                let mesh = scene.vertices.iter().fold(1469598103934665603u64, |h, v| v.pos.iter().fold(h, |h, c| (h ^ c.to_bits() as u64).wrapping_mul(1099511628211)));
                (sig, scene.indices.len() / 3, mesh)
            })
            .collect();
        let distinct: std::collections::HashSet<crate::crack_geom::GeoKey> = steps.iter().map(|s| s.0).collect();
        // Fewer buckets than the knob era (10 of 16), and for a good reason: the
        // key now carries the SOLVED thresholds rather than raw knob bytes, and a
        // threshold only moves when the coverage it encodes moves — so a commit
        // that would have rebuilt for a 0.1 knob step no longer rebuilds for
        // nothing. Seven real geometry changes over a 3-second beat is still one
        // every ~0.4 s.
        assert!(distinct.len() >= 7, "the ramp must cross at least 7 geometry buckets over 16 samples, got {}", distinct.len());
        // The wall's OWN geometry — the scene's total minus the same level with
        // that wall pristine. Measured as a delta because the beat runs inside a
        // real level: the gym's own 20 k triangles are not the claim.
        let (first, last) = (steps[0].1, steps[15].1);
        assert!(last as i64 - first as i64 > 2000, "the beat must grow thousands of triangles on one wall: {first} → {last} tris");
        // …and the geometry keeps MOVING rather than arriving in one cliff. The
        // beat's opening is PAINT by design (`ramp_story` weathers before the
        // wall shifts), so the claim is about the rest of it.
        let moved = steps.windows(2).filter(|w| w[1].2 != w[0].2).count();
        assert!(moved >= 6, "geometry must keep moving through the beat, not in one jump: {moved} of 15 steps changed the mesh");
        // …and none of those six is the whole jump: the largest single step must
        // be well under half the beat's growth, which is the actual claim ("not
        // in one cliff") stated as a measurement instead of as a step count.
        let grow: Vec<i64> = steps.windows(2).map(|w| w[1].1 as i64 - w[0].1 as i64).collect();
        let biggest = grow.iter().cloned().fold(0, i64::max);
        assert!(biggest * 2 < last as i64 - first as i64, "one commit carried {biggest} of the beat's {} triangles", last as i64 - first as i64);
    }

    /// **THE THREE LEVEL ROWS ARE NON-DESTRUCTIVE**, which is the property that
    /// lets them be sliders at all: they are applied on the way from the authored
    /// spec to a sheet, never written back into it. So `wear` 0 → 1 restores
    /// exactly what the level author wrote, `solo` composes with the master, and
    /// a panel edit on one wall survives all three.
    ///
    /// The alternative — rewriting every spec in place — is how a "master" dial
    /// usually ships, and it is one-way: the level's own authoring is gone after
    /// the first drag, so the owner cannot get back to the state he is comparing
    /// against.
    #[test]
    fn the_level_rows_compose_and_never_destroy_the_authoring() {
        let (_, _, mut lab) = build(crate::demos::Level::Gym, Some(&crate::demos::LAB_WEAR));
        let authored: Vec<crate::wall::WallSpec> = lab.spec.clone();
        let areas = |l: &CrackLab| l.sheets.iter().map(|s| s.area).collect::<Vec<_>>();
        let full = areas(&lab);
        assert!(full.iter().flatten().any(|a| *a > 0.0), "VACUOUS: this level is not weathered");

        // MASTER 0 = the plain greybox, on every wall and every layer
        lab.master = 0.0;
        lab.recompile();
        assert!(areas(&lab).iter().flatten().all(|a| *a == 0.0), "wear 0 must leave nothing at all");
        // …and it is REVERSIBLE, exactly
        lab.master = 1.0;
        lab.recompile();
        assert_eq!(areas(&lab), full, "wear 1 must restore the level as authored");
        assert_eq!(lab.spec, authored, "the authored spec was overwritten");

        // SOLO: one layer survives, on every wall
        for (k, keep) in crate::wall::Layer::ALL.into_iter().enumerate() {
            lab.solo = k + 1;
            lab.recompile();
            for (r, a) in areas(&lab).iter().enumerate() {
                for l in crate::wall::Layer::ALL {
                    if l != keep {
                        assert_eq!(a[l.index()], 0.0, "solo {}: run {r} still shows {}", keep.name(), l.name());
                    }
                }
            }
            // the soloed layer is untouched where the level had it
            let shown = areas(&lab).iter().filter(|a| a[keep.index()] > 0.0).count();
            assert_eq!(shown, full.iter().filter(|a| a[keep.index()] > 0.0).count(), "solo {} changed which walls have it", keep.name());
        }
        // …and it COMPOSES with the master rather than overriding it
        lab.solo = 1;
        lab.master = 0.5;
        lab.recompile();
        let half = areas(&lab);
        lab.master = 1.0;
        lab.recompile();
        let one = areas(&lab);
        assert!(
            half.iter().zip(&one).any(|(h, o)| h[0] < o[0] - 1e-6),
            "the master must still bite while a layer is soloed"
        );
        lab.solo = 0;

        // GRAIN: 0 leaves each wall its own, anything else overrides every wall
        lab.recompile();
        let own: Vec<u8> = lab.sheets.iter().map(|s| s.geom.grain).collect();
        lab.grain = 0.20;
        lab.recompile();
        assert!(lab.sheets.iter().all(|s| s.geom.grain == (0.20 * 63.0f32).round() as u8), "surface grain must reach every wall");
        lab.grain = 0.0;
        lab.recompile();
        assert_eq!(lab.sheets.iter().map(|s| s.geom.grain).collect::<Vec<_>>(), own, "grain 0 must give every wall its own back");
    }

    /// THE 2026-07-25 POLICY, pinned: geometry a generator REBUILT is AA-scoped
    /// by construction. A wall the pass rebuilt (its material carries the
    /// GEO/CRAZE marks) must carry [`AA_BIT`] at the default scope, its chalk
    /// core with it (the groove floors are the crack's darkest pixels); a
    /// pristine wall must stay hard-edged. Scope 2 narrows to the pick, scope 0
    /// needs no bit at all.
    #[test]
    fn rebuilt_geometry_opts_into_the_aa_scope() {
        let (mut scene, meta, mut lab) = build(crate::demos::Level::Gym, Some(&crate::demos::LAB_WEAR));
        let aged = (0..meta.piers.len()).find(|i| lab.cores[*i] >= 0).expect("some wall must have been rebuilt");
        let clean = (0..meta.piers.len()).find(|i| lab.spec[lab.pier_run[*i]].story == Story::ZERO).expect("the level ships a control");
        assert_ne!(pad_of(&scene, &meta, aged) & AA_BIT, 0, "rebuilt geometry is AA-scoped");
        assert_eq!(pad_of(&scene, &meta, clean) & AA_BIT, 0, "a pristine greybox wall stays hard-edged");
        let core = lab.cores[aged];
        assert_ne!(scene.materials[core as usize]._pad & AA_BIT, 0, "the core (groove floors) is scoped too");
        // scope 2 narrows to the pick
        stamp_aa(&mut scene, &meta.piers, &lab, 2);
        assert_eq!(pad_of(&scene, &meta, aged) & AA_BIT, 0, "scope 2 with no pick leaves the wall alone");
        lab.sel = Some(aged);
        stamp_aa(&mut scene, &meta.piers, &lab, 2);
        assert_ne!(pad_of(&scene, &meta, aged) & AA_BIT, 0, "scope 2 follows the pick");
    }
}

#[cfg(test)]
mod catalogue_tests {
    use super::*;
    use crate::crack_geom::{CRAZE_BIT, GEO_BIT};
    use crate::wall::Layer;

    /// **EVERY DEMO COMPILES AGAINST ITS OWN LEVEL.** An addressing miss used to
    /// be an `eprintln!` nobody read, and its symptom was "the effect I authored
    /// is not in the shot" with no cause anywhere. Now `wall::compile` returns
    /// the mistake, and this is the place it is FATAL: a level that names a wall
    /// it does not have, or two names on one wall, fails the tree.
    #[test]
    fn every_demo_compiles_against_its_own_level() {
        let mut checked = 0;
        for d in crate::demos::DEMOS {
            let Some(lw) = d.wear else { continue };
            let (_scene, meta) = crate::gym_scene::build_gym(&d.level.spec(), &crate::look::POLANA, true);
            let (runs, _) = crate::crack::runs_of(&meta.piers);
            let sheets = crate::wall::compile(&runs, lw).unwrap_or_else(|m| panic!("demo \"{}\" does not compile against its own level: {m:?}", d.name));
            assert_eq!(sheets.len(), runs.len(), "\"{}\": one sheet per run", d.name);
            for w in lw.walls {
                assert!(sheets.iter().any(|s| s.label == w.label), "\"{}\": the wall named \"{}\" produced no sheet", d.name, w.label);
            }
            checked += 1;
        }
        assert!(checked >= 2, "VACUOUS: only {checked} demos carry authored wear");
    }

    /// THE BENCH's contract (owner 2026-07-26, "a special level that shows each
    /// of them separately"): every specimen names a REAL wall, no two share one,
    /// and each is its own RUN.
    ///
    /// The last part is easy to lose and expensive to notice: a run carries the
    /// story key, the damage field and every solved threshold, so two specimens
    /// cut out of ONE run would share their damage pattern and the bench would be
    /// comparing two views of the same wall.
    #[test]
    fn every_specimen_names_its_own_wall_and_its_own_run() {
        let (_scene, meta) = crate::gym_scene::build_gym(&crate::demos::Level::Catalogue.spec(), &crate::look::POLANA, true);
        let specs = crate::demos::CATALOGUE_WEAR.walls;
        assert_eq!(specs.len(), 15, "three rows of five");
        let (runs, pier_run) = crate::crack::runs_of(&meta.piers);
        let mut seen: Vec<usize> = Vec::new();
        for sp in specs {
            let i = pier_index_at(&meta.piers, sp.at.0, sp.at.1).unwrap_or_else(|| panic!("specimen \"{}\" at {:?} misses every wall pier", sp.label, sp.at));
            let r = pier_run[i];
            assert!(!seen.contains(&r), "specimen \"{}\" shares run {r} with another", sp.label);
            seen.push(r);
            // its own run: exactly one pier indexes it
            assert_eq!(pier_run.iter().filter(|q| **q == r).count(), 1, "specimen \"{}\" shares its run with another pier", sp.label);
        }
        // …and the bench's building at the back is what makes that claim
        // non-trivial: it HAS multi-pier runs, so "its own run" is a property of
        // the specimens and not of the level.
        assert!(runs.len() < meta.piers.len(), "VACUOUS: this level has no multi-pier run to distinguish a specimen from");
    }

    /// The two isolations the bench needs, pinned as the geometry pass's
    /// OBSERVABLE effect on the scene rather than as a flag round-trip.
    ///
    /// `paint_only` is a real mechanism and still unreachable any other way: the
    /// generator marks every wall it touches and the shader gates its painted
    /// layers off that mark. `breaks: 0` stopped being an "isolation" on
    /// 2026-07-26 and became an ordinary authored zero.
    #[test]
    fn paint_only_leaves_no_geometry_and_a_zero_break_count_leaves_a_whole_wall() {
        let (mut scene, meta) = crate::gym_scene::build_gym(&crate::demos::Level::Catalogue.spec(), &crate::look::POLANA, true);
        let mut lab = CrackLab::default();
        let prims = scene.primitives.len();
        resolve(Some(&crate::demos::CATALOGUE_WEAR), &mut lab, &meta.piers, &mut scene, 1);
        assert!(scene.primitives.len() > prims, "VACUOUS: the geometry pass built nothing at all");

        let idx = |label: &str| {
            let sp = crate::demos::CATALOGUE_WEAR.walls.iter().find(|p| p.label == label).expect(label);
            pier_index_at(&meta.piers, sp.at.0, sp.at.1).expect(label)
        };
        let pad = |i: usize| scene.materials[scene.primitives[meta.piers[i].prim].material_id as usize]._pad;

        // paint-only: the material carries real paint, the geometry pass never
        // touched it — the whole condition the shader's painted layers are gated
        // on. The effect WORD has to arrive too, or the layers have no threshold.
        for label in ["stains", "wide stain patch", "glaze web alone"] {
            let i = idx(label);
            let r = lab.pier_run[i];
            assert_ne!(pad(i) >> 8, 0, "{label}: the paint must reach the shader");
            assert_eq!(pad(i) & (GEO_BIT | CRAZE_BIT), 0, "{label}: geometry ran on a paint-only specimen");
            assert_eq!(lab.cores[i], -1, "{label}: a paint-only specimen must have no chalk core");
            assert!(lab.sheets[r].paint.stain > 0 || lab.sheets[r].paint.web > 0, "{label}: no solved threshold reached the word");
        }
        // the break count: same class of ask, opposite outcome. `split_pier` is
        // the only path that mints a core with GEO_BIT set, so that bit IS "this
        // wall broke in half".
        let broken = idx("structural break");
        assert_ne!(pad(broken) & GEO_BIT, 0, "VACUOUS: the wall that asked for a break did not break");
        for label in ["lightning network", "craquelure", "mosaic"] {
            let i = idx(label);
            assert_ne!(pad(i) & CRAZE_BIT, 0, "{label}: the veneer must still be built");
            assert_eq!(pad(i) & GEO_BIT, 0, "{label}: zero breaks was ignored — this wall broke in half");
        }
        // …and ONE EFFECT PER WALL is a fact about the data: `WallAt::only` pins
        // every other layer to zero, so no slab can be contaminated by the base
        // story the way the old specimens could.
        for w in crate::demos::CATALOGUE_WEAR.walls {
            let r = lab.pier_run[idx(w.label)];
            let nonzero = Layer::ALL.into_iter().filter(|l| lab.sheets[r].area[l.index()] > 0.0).count();
            assert!(nonzero <= 2, "specimen \"{}\" shows {nonzero} layers at once — a bench slab is one effect", w.label);
        }
    }
}
