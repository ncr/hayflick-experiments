//! The IDE adapter — the ONLY place that knows both the `ide` crate and the
//! game (the workspace's adapter tradition: `ide` never sees house-game or
//! the GPU, and nothing here leaks back into it).
//!
//! What crosses the boundary:
//! - out: an [`ide::SceneModel`] built fresh each frame from the live spec
//!   (`GymLevel` lamps/spawn, the wall RUNS from the crack lab, the player),
//! - in: [`ide::Edit`]s, applied to the SPEC — never to render geometry — and
//!   realized through the same `apply_look` rebuild every other authoring
//!   surface uses (probe bake is content-keyed on disk, so re-dialing a value
//!   back re-loads its bake instantly),
//! - pixels: the IDE's panels ride the existing STAMP path (CPU canvas +
//!   per-stamp integer scale, burned into `out` on both backends), so the
//!   whole overlay needs ZERO new GPU code and lands in SHOT captures for
//!   headless verification.
//!
//! Interaction contract (main.rs): Tab toggles, ESC closes, an open IDE
//! pauses the sim (pause = edit, the 2026-07-23 design anchor) and owns every
//! world click — chrome first, then ray-picking. Slider drags are coalesced
//! to one step per frame and their edits land on RELEASE (the input-pacing
//! discipline: an edit rebuilds the scene; a drag may not).
//!
//! SHAPE OF THIS FILE: every DECISION is a free function over borrowed data —
//! [`pick_target`] (which pickable a ray names), [`lift_plan`] (which piers a
//! selection lifts), [`wear_props`]/[`wear_row_of`] (what a wall exposes, and
//! the key that reaches each row back), [`split_edit`]/[`edit_val`] (the
//! `IDE_EDIT` grammar) — and the `impl Viewer` methods only feed them the live
//! state and write the result back. These decisions are plain state machines
//! over `Vec<usize>`/`Vec<Material>`, so as `&mut self` code they were
//! untestable without a GPU: a wrong-run outline, or a lift that misses the
//! chalk core and rings every groove from the inside, ships with a green tree.
//! Keep new logic on the free side of that line.

use crate::backend::Stamp;
use crate::gym_scene::{cell_world, Pier};
use crate::menu::{rows_of, Row};
use crate::viewer::Viewer;
use glam::{Vec2, Vec3};
use house_game::gym::grid::CellPos;
use ide::{Edit, Obj, ObjId, Prop, PropKind, PropVal, SceneModel};

/// IDE pixel scale for a window height: HALF the menu's UI pixel, floored at
/// 1 — at the default window that is exactly half the game texel, i.e. the
/// owner's "UI at 2x the game's pixel density" (2026-07-27). Tied to the menu
/// scale, not the zoom: tooling chrome must not grow when the world zooms.
pub fn ide_scale_for(ext_h: u32) -> u32 {
    (crate::backend::menu_scale_for(ext_h) / 2).max(1)
}

/// Live IDE state on the [`Viewer`].
pub struct IdeState {
    pub ui: ide::Ide,
    /// Coalescing flag — the `MenuState::drag_pending` discipline: motion
    /// events mark it, the frame loop applies ONE drag step.
    pub drag_pending: bool,
    /// Wheel accumulator (trackpads send fractional deltas).
    wheel: f32,
    /// The model events hit-test against — refreshed every frame while open
    /// (the world is frozen, so it only actually changes on an edit).
    model: SceneModel,
    /// `IDE_SEL=<object name>` boot selection (harness: a SHOT of a populated
    /// inspector), applied on the first refresh.
    boot_sel: Option<String>,
    /// Materials carrying the SEL tag for a NON-WALL pick (lamp fixture /
    /// player body): walls clear through the crack re-derive (`KEEP_FLAGS`
    /// strips SEL), these have no re-derive and are cleared explicitly on the
    /// next `ide_select`.
    lifted: Vec<usize>,
}

impl IdeState {
    pub fn from_env() -> IdeState {
        let mut ui = ide::Ide::default();
        ui.open = std::env::var(crate::wear_file::env::IDE).is_ok_and(|v| v != "0");
        IdeState { ui, drag_pending: false, wheel: 0.0, model: SceneModel { level: String::new(), objects: Vec::new() }, boot_sel: std::env::var(crate::wear_file::env::IDE_SEL).ok(), lifted: Vec::new() }
    }
}

/// What an [`ObjId`] names in the game. The encoding is stable across
/// rebuilds: 0 = player, 1 = spawn, then lamps, then wall runs.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Target {
    Player,
    Spawn,
    Lamp(usize),
    Run(usize),
}

fn obj_id(t: Target, n_lamps: usize) -> ObjId {
    ObjId(match t {
        Target::Player => 0,
        Target::Spawn => 1,
        Target::Lamp(i) => 2 + i as u32,
        Target::Run(r) => 2 + n_lamps as u32 + r as u32,
    })
}

fn target_of(id: ObjId, n_lamps: usize) -> Target {
    match id.0 {
        0 => Target::Player,
        1 => Target::Spawn,
        i if (i as usize) < 2 + n_lamps => Target::Lamp(i as usize - 2),
        i => Target::Run(i as usize - 2 - n_lamps),
    }
}

/// A wear-panel row's IDE prop key. ONE token each — the `IDE_EDIT` statement
/// grammar splits on spaces, so a key with one would be unreachable from the
/// harness (pinned by `wear_keys_are_single_tokens_and_unique`). The labels
/// keep the panel's spellings; only the keys flatten them.
fn wear_key(row: Row, pdefs: &'static [(&'static str, f32)]) -> &'static str {
    match row {
        Row::Cause(0) => "weather",
        Row::Cause(1) => "settlement",
        Row::Cause(_) => "cover_loss",
        Row::Layer(l) => l.name(),
        Row::MudTop => "mud_top",
        Row::Breaks => "breaks",
        Row::Shell => "shells",
        Row::Caliber => "caliber",
        Row::Scrub => "variant",
        Row::BandLo => "band_lo",
        Row::BandHi => "band_hi",
        Row::Grain => "grain",
        Row::Relief => "relief",
        Row::Pattern => "pattern",
        Row::Param(j) => pdefs.get(j).map(|(n, _)| *n).unwrap_or("param"),
    }
}

/// The wear row a prop key names, for the write path — the reverse of
/// [`wear_key`], over the SAME `rows_of` walk the props were built from, so a
/// key can only reach the row it was drawn for.
fn wear_row_of(spec: &wear_core::wall::WallSpec, key: &str) -> Option<Row> {
    let pdefs = crate::crack_geom::POLICY_PARAMS[spec.shape.pattern.code() as usize % crate::crack_geom::NPOL];
    rows_of(spec).iter().copied().find(|w| wear_key(*w, pdefs) == key)
}

/// A wall's wear sheet as inspector props — a walk of [`crate::menu::rows_of`],
/// the shared spelling of "what a wall exposes", so the inspector cannot invent
/// a row the wear model does not have. Values, pin marks and off-stops come
/// from that same row model. SHELL placement is a MODE, not an edit: its row
/// shows the count and whether place-mode is armed, and the hit lands on the
/// next world click. A [`wear_core::wall::Miss`] lands as the trailing read row:
/// what this wall asked for and did not get.
///
/// PURE over borrowed data (the adapter's decisions are the part worth
/// pinning; the `impl Viewer` half only feeds it the live spec and sheet).
fn wear_props(spec: &wear_core::wall::WallSpec, sheet: &wear_core::wall::Sheet, placing: bool) -> Vec<Prop> {
    let pdefs = crate::crack_geom::POLICY_PARAMS[spec.shape.pattern.code() as usize % crate::crack_geom::NPOL];
    let sf = |v: f32| PropKind::SliderF { v, min: 0.0, max: 1.0 };
    let mut props = Vec::new();
    for (i, row) in rows_of(spec).iter().copied().enumerate() {
        let key = wear_key(row, pdefs);
        let mut p = match row {
            Row::Cause(ci) => {
                let v = [spec.story.weather, spec.story.settlement, spec.story.cover_loss][ci.min(2)];
                Prop::new(key, key.replace('_', " "), sf(v))
            }
            Row::Layer(l) => {
                let v = sheet.area[l.index()];
                let pinned = spec.pin.get(l).is_some();
                Prop::new(key, l.name(), sf(v)).indent(8).show(format!("{v:.2}{}", if pinned { "*" } else { "" }))
            }
            Row::MudTop => Prop::new(key, "mud top", sf(spec.mud_top)).indent(16),
            Row::Breaks => Prop::new(key, "breaks", PropKind::SliderI { v: sheet.breaks.count as i32, min: 0, max: wear_core::wall::Breaks::MAX as i32 }),
            // a MODE row, not an edit: clicking it arms place-mode and the
            // next world click on the selected wall places the hit (or
            // removes the one it lands on) — the placing gesture IS the
            // authoring, so no slider can carry it
            Row::Shell => {
                let n = spec.shells.count();
                Prop::new(key, "shells", PropKind::Cycle { v: placing as i32, n: 2 }).show(if placing { format!("{n} [click wall]") } else { format!("{n} [place]") })
            }
            Row::Caliber => Prop::new(key, "caliber", sf(spec.shells.caliber)).indent(8).show(format!("{:.2}wu", spec.shells.caliber)),
            Row::Scrub => Prop::new(key, "variant", sf(spec.scrub)),
            Row::BandLo => {
                let off = spec.band.0 == 0.0;
                Prop::new(key, "band low", sf(spec.band.0)).show(if off { "off".into() } else { format!("{:.2}", spec.band.0) })
            }
            Row::BandHi => {
                let off = spec.band.1 == 1.0;
                Prop::new(key, "band high", sf(spec.band.1)).show(if off { "off".into() } else { format!("{:.2}", spec.band.1) })
            }
            Row::Grain => {
                let off = spec.shape.grain < wear_core::wall::GRAIN_OFF;
                Prop::new(key, "grain", sf(spec.shape.grain)).show(if off { "off".into() } else { format!("{:.2}wu", spec.shape.grain) })
            }
            Row::Relief => Prop::new(key, "relief", sf(spec.shape.relief)),
            Row::Pattern => Prop::new(key, "pattern", PropKind::Cycle { v: spec.shape.pattern.code() as i32, n: crate::crack_geom::NPOL as i32 }).show(format!("< {} >", spec.shape.pattern.name())),
            Row::Param(j) => Prop::new(key, key, sf(spec.shape.pattern.par().get(j).copied().unwrap_or(0.0))).indent(8),
        };
        if i == 0 {
            p = p.head("wear");
        }
        if row == Row::Grain {
            p = p.head("shape");
        }
        props.push(p);
    }
    match sheet.notes.first() {
        Some(wear_core::wall::Miss::Clamped { dial, asked, used, .. }) => {
            props.push(Prop::new("note", format!("{dial} limit"), PropKind::Read(format!("{asked:.2} -> {used:.2}"))));
        }
        Some(wear_core::wall::Miss::Coarse { layer, asked, got, .. }) => {
            props.push(Prop::new("note", format!("{} coarse", layer.name()), PropKind::Read(format!("{asked:.2} -> {got:.2}"))));
        }
        _ => {}
    }
    props
}

/// The nearest pier a ray strikes, with its distance — the wall half of a pick,
/// and place-mode's own hit test (which wants the PIER the ray hit, not its
/// run). Ties keep the earlier pier, as the inline loops this replaced did.
fn nearest_pier(o: Vec3, d: Vec3, piers: &[Pier]) -> Option<(f32, usize)> {
    let mut hit: Option<(f32, usize)> = None;
    for (i, pier) in piers.iter().enumerate() {
        if let Some(t) = crate::crack::ray_aabb(o, d, pier.lo, pier.hi) {
            if hit.is_none_or(|(bt, _)| t < bt) {
                hit = Some((t, i));
            }
        }
    }
    hit
}

/// Which pickable a ray strikes first, as the IDE names it — the pure decision
/// inside [`Viewer::ide_click`]'s world pick.
///
/// SELECTION IS THE RUN: a wall hit resolves through `pier_run` to the struck
/// pier's RUN, never to the pier. `gym_scene::wall_slab` cuts an authored wall
/// into piers wherever a window or a doorway interrupts it — a rendering fact
/// the level builder never typed — so the thing the ray hits is not the thing
/// the owner authored.
fn pick_target(o: Vec3, d: Vec3, piers: &[Pier], pier_run: &[usize], lamps: &[(CellPos, i32)], player: Vec3, spawn: Vec3) -> Option<Target> {
    let mut best: Option<(f32, Target)> = None;
    let mut consider = |t: Option<f32>, tg: Target| {
        if let Some(t) = t {
            if best.is_none_or(|(bt, _)| t < bt) {
                best = Some((t, tg));
            }
        }
    };
    if let Some((t, i)) = nearest_pier(o, d, piers) {
        consider(Some(t), Target::Run(pier_run.get(i).copied().unwrap_or(0)));
    }
    for (i, (cell, _)) in lamps.iter().enumerate() {
        let c = cell_world(*cell);
        consider(crate::crack::ray_aabb(o, d, Vec3::new(c.x - 0.1, 0.0, c.z - 0.15), Vec3::new(c.x + 0.4, 1.75, c.z + 0.15)), Target::Lamp(i));
    }
    consider(crate::crack::ray_aabb(o, d, Vec3::new(player.x - 0.3, 0.0, player.z - 0.3), Vec3::new(player.x + 0.3, 1.9, player.z + 0.3)), Target::Player);
    consider(crate::crack::ray_aabb(o, d, Vec3::new(spawn.x - 0.5, 0.0, spawn.z - 0.5), Vec3::new(spawn.x + 0.5, 0.06, spawn.z + 0.5)), Target::Spawn);
    best.map(|(_, tg)| tg)
}

/// What a selection costs the scene: the pier the crack lab takes as its own
/// pick (it addresses piers — the AA scope and `sel_run` hang off it), and
/// EVERY pier the amber outline lifts.
///
/// The whole run, or nothing: a facade cut into three panels by its windows
/// must outline as ONE wall, and a run's piers share one authored spec. Only a
/// wall lifts piers — a lamp or the player lifts its dynamic run's materials
/// instead ([`Viewer::ide_lift_dyn`]), and the spawn is a place with no mesh.
fn lift_plan(pier_run: &[usize], tg: Option<Target>) -> (Option<usize>, Vec<usize>) {
    let Some(Target::Run(r)) = tg else { return (None, Vec::new()) };
    let lift: Vec<usize> = pier_run.iter().enumerate().filter(|(_, pr)| **pr == r).map(|(i, _)| i).collect();
    (lift.first().copied(), lift)
}

/// One `IDE_EDIT` statement → (object, key, value). Split from the RIGHT: an
/// object name may hold spaces (it is whatever the wear file called the run —
/// "ramped control"), a key and a value may not (`wear_keys_are_single_tokens_and_unique`).
fn split_edit(stmt: &str) -> Option<(&str, &str, &str)> {
    let mut it = stmt.rsplitn(3, ' ');
    let (val, key, name) = (it.next()?, it.next()?, it.next()?);
    Some((name, key, val))
}

/// A replayed value, typed by the prop that will receive it — wear rows take
/// floats, everything else whole steps.
fn edit_val(kind: &PropKind, text: &str) -> Option<PropVal> {
    match kind {
        PropKind::SliderF { .. } => text.parse::<f32>().ok().map(PropVal::F),
        _ => text.parse::<i32>().ok().map(PropVal::I),
    }
}

impl Viewer {
    pub fn ide_scale(&self) -> u32 {
        ide_scale_for(self.backend.extent().1)
    }

    /// IDE viewport in IDE px.
    fn ide_viewport(&self) -> (i32, i32) {
        let s = self.ide_scale();
        let (w, h) = self.backend.extent();
        ((w / s) as i32, (h / s) as i32)
    }

    fn ide_px(&self, win: Vec2) -> (i32, i32) {
        let s = self.ide_scale() as f32;
        ((win.x / s) as i32, (win.y / s) as i32)
    }

    /// Toggle the IDE (Tab; ESC closes). Opening pauses the sim (pause =
    /// edit); either way every held input is dropped — a key held across the
    /// mode line must not keep walking the player. Closing CLEARS the
    /// selection: the amber lift is IDE chrome, and with the wall panel gone
    /// (2026-07-27) there is no surface left to hand it to — the game view
    /// comes back clean.
    pub fn ide_toggle(&mut self) {
        self.ide.ui.open = !self.ide.ui.open;
        self.gym.held = [false; 4];
        self.gym.run_held = false;
        self.ide.drag_pending = false;
        self.ide.ui.cancel_drag();
        if !self.ide.ui.open {
            let nl = self.gym.spec.lights.len();
            self.ide_select(None, nl);
        }
        self.ui_blip(if self.ide.ui.open { "menu_open" } else { "menu_close" });
        println!("ide: {}", if self.ide.ui.open { "open (tab/esc closes; click selects)" } else { "closed" });
    }

    /// Rebuild the scene model the IDE reads: lamps + spawn from the SPEC,
    /// wall runs from the crack lab's derivation, the player from the sim.
    fn ide_model(&self) -> SceneModel {
        let spec = &self.gym.spec;
        let nl = spec.lights.len();
        let (gw, gh) = (spec.grid.w as i32, spec.grid.h as i32);
        let mut objects = Vec::new();
        // runs derived from the piers directly — the crack lab's own copy only
        // exists on levels with authored wear, but every level has walls
        let (runs, pier_run) = crate::crack::runs_of(&self.piers);
        for (r, run) in runs.iter().enumerate() {
            let label = self.crack.label.get(r).copied().unwrap_or("");
            let n_piers = pier_run.iter().filter(|&&pr| pr == r).count();
            let mut props = vec![Prop::new("piers", "piers", PropKind::Read(format!("{n_piers}")))];
            match self.crack.active.then(|| self.crack.spec.get(r).zip(self.crack.sheets.get(r))).flatten() {
                Some((spec, sheet)) => props.extend(wear_props(spec, sheet, self.crack.placing)),
                None => props.push(Prop::new("wear", "wear", PropKind::Read("none on this level".into()))),
            }
            objects.push(Obj {
                id: obj_id(Target::Run(r), nl),
                name: if label.is_empty() { format!("wall {r}") } else { label.to_string() },
                group: "walls",
                pos: (0.5 * (run.lo + run.hi)).to_array(),
                size: (run.hi - run.lo).to_array(),
                props,
            });
        }
        for (i, (cell, glow)) in spec.lights.iter().enumerate() {
            let c = cell_world(*cell);
            objects.push(Obj {
                id: obj_id(Target::Lamp(i), nl),
                name: format!("lamp {i}"),
                group: "lamps",
                pos: [c.x, 0.0, c.z],
                size: [0.5, 1.75, 0.3],
                props: vec![
                    Prop::new("glow", "glow", PropKind::SliderI { v: *glow, min: 1, max: 8 }),
                    Prop::new("cx", "cell x", PropKind::SliderI { v: cell.x as i32, min: 0, max: gw - 1 }),
                    Prop::new("cz", "cell z", PropKind::SliderI { v: cell.z as i32, min: 0, max: gh - 1 }),
                ],
            });
        }
        let p = self.gym.cam_target();
        objects.push(Obj {
            id: obj_id(Target::Player, nl),
            name: "player".into(),
            group: "actors",
            pos: [p.x, 0.0, p.z],
            size: [0.5, 1.9, 0.5],
            props: vec![Prop::new("cell", "cell", PropKind::Read(format!("{} {}", p.x.floor(), p.z.floor())))],
        });
        objects.push(Obj {
            id: obj_id(Target::Spawn, nl),
            name: "spawn".into(),
            group: "actors",
            pos: cell_world(spec.player_start).to_array(),
            size: [1.0, 0.0, 1.0],
            props: vec![
                Prop::new("sx", "cell x", PropKind::SliderI { v: spec.player_start.x as i32, min: 0, max: gw - 1 }),
                Prop::new("sz", "cell z", PropKind::SliderI { v: spec.player_start.z as i32, min: 0, max: gh - 1 }),
                Prop::new("note", "note", PropKind::Read("applies on restart".into())),
            ],
        });
        SceneModel { level: self.cur_demo.map_or("gym", |d| d.name).to_string(), objects }
    }

    /// Apply one wear edit to run `r` through the SAME write path as the
    /// wall panel (`wear_set_row` / the breaks and pattern setters): spec
    /// mutation + live paint re-stream. The GEOMETRY is the caller's release
    /// (`crack_release`), exactly like a panel drag's mouse-up.
    fn ide_wear_apply(&mut self, r: usize, key: &str, v: PropVal) {
        if !self.crack.active || r >= self.crack.spec.len() {
            return;
        }
        let Some(row) = wear_row_of(&self.crack.spec[r], key) else { return };
        match (row, v) {
            (Row::Breaks, PropVal::I(n)) => self.wear_set_breaks(r, n.clamp(0, wear_core::wall::Breaks::MAX as i32) as u8),
            (Row::Pattern, PropVal::I(c)) => self.wear_set_pattern(r, c.rem_euclid(crate::crack_geom::NPOL as i32) as u8),
            // arming place-mode authors nothing (the click on the wall will),
            // so it must not dirty the save or claim the run
            (Row::Shell, PropVal::I(on)) => self.crack.placing = on != 0,
            (w, PropVal::F(f)) => self.wear_set_row(r, w, f.clamp(0.0, 1.0)),
            _ => {}
        }
    }

    /// Apply one IDE edit. A WALL edit goes through the wear machinery (live
    /// paint + `crack_release` geometry — the wall panel's exact cost model);
    /// lamp/spawn edits mutate the SPEC and rebuild through `apply_look`
    /// (same path as every authoring surface; sim untouched — lights and the
    /// spawn are render/boot data).
    fn ide_apply(&mut self, e: Edit) {
        let nl = self.gym.spec.lights.len();
        if let Target::Run(r) = target_of(e.obj, nl) {
            self.ide_wear_apply(r, e.key, e.v);
            self.crack_release(); // rebuild if a GeoKey moved, then persist
            self.ide_relift();
            self.ui_blip("menu_pick");
            return;
        }
        let spec = &mut self.gym.spec;
        let PropVal::I(v) = e.v else { return };
        match target_of(e.obj, spec.lights.len()) {
            Target::Lamp(i) => match e.key {
                "glow" => spec.lights[i].1 = v,
                "cx" => spec.lights[i].0.x = v as i16,
                "cz" => spec.lights[i].0.z = v as i16,
                _ => return,
            },
            Target::Spawn => {
                match e.key {
                    "sx" => spec.player_start.x = v as i16,
                    "sz" => spec.player_start.z = v as i16,
                    _ => return,
                }
                println!("ide: spawn moved — applies on restart");
            }
            _ => return,
        }
        let look = self.look;
        self.apply_look(look); // prints its own cost line
        self.ide_relift();
        self.ui_blip("menu_pick");
    }

    /// World click while the IDE owns the pointer: chrome first, then a ray
    /// pick over walls (pier AABBs — the SEL amber lift comes through the
    /// crack lab's own selection), lamps, the player and the spawn cell.
    /// Consumes EVERY click while open: the world is frozen, so there is no
    /// click-to-move to fall through to.
    pub fn ide_click(&mut self, win: Vec2) -> bool {
        if !self.ide.ui.open {
            return false;
        }
        let p = self.ide_px(win);
        let (vw, vh) = self.ide_viewport();
        if self.ide.ui.press(&self.ide.model, p, vw, vh) {
            self.ui_blip("menu_move");
            return true;
        }
        let nl = self.gym.spec.lights.len();
        let x = self.pick_xform();
        let (o, d) = iso_core::window_px_to_ray(win, &x);
        // SHELL place-mode (armed on the inspector's shells row): a click on
        // the SELECTED wall spends itself on the shell — at the ray's own hit
        // point, on the face the camera sees — and pays the geometry at once
        // (a click is its own release). Any other click falls through to the
        // pick below, whose selection change disarms (`crack_select`).
        if self.crack.placing {
            if let Some((t, i)) = nearest_pier(o, d, &self.piers) {
                if let (Some(sr), Some(pr)) = (self.crack.sel_run(), self.crack.pier_run.get(i).copied()) {
                    if sr == pr {
                        self.shell_place(i, o + d * t, d);
                        self.crack_release();
                        self.ide_relift();
                        return true;
                    }
                }
            }
        }
        let (_, pier_run) = crate::crack::runs_of(&self.piers);
        let pl = self.gym.cam_target();
        let sp = cell_world(self.gym.spec.player_start);
        match pick_target(o, d, &self.piers, &pier_run, &self.gym.spec.lights, pl, sp) {
            Some(tg) => {
                self.ide_select(Some(tg), nl);
                self.ui_blip("menu_pick");
            }
            None => self.ide_select(None, nl),
        }
        true
    }

    /// Select a target in both worlds: the IDE panels, and the SEL tag that
    /// the tonemap pass draws as the amber OUTLINE — for a wall on the WHOLE
    /// run (the IDE selects the authoring unit, not the pier the ray happened
    /// to strike), for a lamp or the player on their dynamic runs' materials.
    /// The crack lab's own pier selection follows a wall pick — it drives the
    /// AA scope and the wear machinery's `sel_run`.
    fn ide_select(&mut self, tg: Option<Target>, n_lamps: usize) {
        self.ide_unlift();
        let (_, pier_run) = crate::crack::runs_of(&self.piers);
        let (pick, lift) = lift_plan(&pier_run, tg);
        self.crack_select(pick);
        // re-derive every pier's paint (clears any stale run lift — KEEP_FLAGS
        // strips SEL), then tag every pier of the selected run
        for i in 0..self.piers.len() {
            self.crack_apply(i);
        }
        match tg {
            Some(Target::Run(_)) => self.ide_lift_piers(&lift),
            Some(Target::Lamp(i)) => self.ide_lift_dyn(&format!("lamp_fix_{i}")),
            Some(Target::Player) => self.ide_lift_dyn("player"),
            _ => {}
        }
        self.ide.ui.select(tg.map(|t| obj_id(t, n_lamps)));
    }

    /// OR the SEL tag onto the whole SURFACE of each given pier
    /// (`crack::pier_surface_mats`: main + chalk core + spall mats, or the
    /// outline rings every groove from the inside). The plan comes from
    /// [`lift_plan`] — the RUN, never the pier the ray struck.
    fn ide_lift_piers(&mut self, piers: &[usize]) {
        for i in piers.iter().copied().filter(|i| *i < self.piers.len()) {
            for mid in crate::crack::pier_surface_mats(&self.scene, &self.piers[i], &self.crack, i) {
                let pad = self.scene.materials[mid]._pad | crate::flags::SEL;
                self.scene.materials[mid]._pad = pad;
                self.backend.set_material_pad(mid, pad);
            }
        }
    }

    /// Lift run `r` — re-applied after every paint re-stream, because
    /// `crack_apply` rebuilds pads with the tag on the crack lab's ONE picked
    /// pier only.
    fn ide_lift_run(&mut self, r: usize) {
        let (_, pier_run) = crate::crack::runs_of(&self.piers);
        let (_, lift) = lift_plan(&pier_run, Some(Target::Run(r)));
        self.ide_lift_piers(&lift);
    }

    /// OR the SEL tag onto every material of the named dynamic run — plus its
    /// `name/…` sub-runs, so "player" covers the five body runs. The tag is
    /// invisible in shading; the tonemap outline draws the silhouette from it.
    /// Tagged ids are recorded for the explicit clear (`ide_unlift`).
    fn ide_lift_dyn(&mut self, name: &str) {
        let sub = format!("{name}/");
        let mats: Vec<usize> = self
            .scene
            .dynamics
            .iter()
            .filter(|(n, ..)| n.as_str() == name || n.starts_with(&sub))
            .flat_map(|(_, first, count, _)| *first..*first + *count)
            .map(|p| self.scene.primitives[p].material_id as usize)
            .collect();
        for mid in mats {
            let pad = self.scene.materials[mid]._pad | crate::flags::SEL;
            self.scene.materials[mid]._pad = pad;
            self.backend.set_material_pad(mid, pad);
            self.ide.lifted.push(mid);
        }
    }

    /// Clear the SEL tag from every non-wall material the last selection
    /// lifted. Guarded per id: after an `apply_look` rebuild the list is
    /// stale, but the fresh scene boots with SEL unset, so a stale id is a
    /// no-op rather than a wrong stamp.
    fn ide_unlift(&mut self) {
        for mid in std::mem::take(&mut self.ide.lifted) {
            let Some(m) = self.scene.materials.get_mut(mid) else { continue };
            if m._pad & crate::flags::SEL != 0 {
                m._pad &= !crate::flags::SEL;
                let pad = m._pad;
                self.backend.set_material_pad(mid, pad);
            }
        }
    }

    /// Re-apply the IDE's selection after a rebuild or re-stream re-stamped
    /// every pier from crack state (idempotent — `ide_select` re-derives).
    fn ide_relift(&mut self) {
        if let Some(sel) = self.ide.ui.sel {
            let nl = self.gym.spec.lights.len();
            self.ide_select(Some(target_of(sel, nl)), nl);
        }
    }

    /// Apply the `IDE_SEL=` boot selection once (consumed on first use —
    /// either the first frame's stamps, or `ide_env_edits` before a replay).
    fn ide_boot_sel(&mut self) {
        if let Some(name) = self.ide.boot_sel.take() {
            let nl = self.gym.spec.lights.len();
            if let Some(id) = self.ide.model.objects.iter().find(|o| o.name == name).map(|o| o.id) {
                self.ide_select(Some(target_of(id, nl)), nl);
            } else {
                eprintln!("IDE_SEL: no object named {name:?}");
            }
        }
    }

    /// The frame's ONE coalesced drag step, from the latest cursor. A WALL
    /// drag is LIVE like the wall panel's: the spec mutates and the paint
    /// re-streams per frame (`wear_set_row` → `wear_edit`), while the
    /// geometry waits for the release — the panel's exact cost model.
    pub fn ide_drag_step(&mut self) {
        let p = self.ide_px(self.view.cursor);
        let (vw, vh) = self.ide_viewport();
        self.ide.ui.drag_to(&self.ide.model, p, vw, vh);
        let nl = self.gym.spec.lights.len();
        if let Some((obj, key, v)) = self.ide.ui.drag_state(&self.ide.model) {
            if let Target::Run(r) = target_of(obj, nl) {
                self.ide_wear_apply(r, key, v);
                self.ide_lift_run(r); // wear_edit re-stamped the run's pads
            }
        }
    }

    /// Pointer release: the pending slider value becomes an [`Edit`] and is
    /// applied — release-only geometry cost, like the wall panel's knobs. A
    /// live WALL drag already wrote the spec (so the edit compares equal and
    /// yields `None`); its release still pays the geometry + save.
    pub fn ide_release(&mut self) {
        let nl = self.gym.spec.lights.len();
        let wear = self.ide.ui.drag_state(&self.ide.model).map(|(o, ..)| matches!(target_of(o, nl), Target::Run(_))).unwrap_or(false);
        if let Some(e) = self.ide.ui.release(&self.ide.model) {
            self.ide_apply(e);
        } else if wear {
            self.crack_release();
            self.ide_relift();
        }
    }

    /// Wheel: scrolls the hierarchy when the cursor is over it (whole rows,
    /// accumulated — trackpads send fractions). False = not consumed (zoom).
    pub fn ide_wheel(&mut self, win: Vec2, dy: f32) -> bool {
        if !self.ide.ui.open {
            return false;
        }
        let p = self.ide_px(win);
        let (vw, vh) = self.ide_viewport();
        self.ide.wheel += dy;
        let rows = self.ide.wheel as i32; // trunc toward zero
        let consumed = self.ide.ui.wheel(&self.ide.model, p, rows, vw, vh);
        if consumed {
            self.ide.wheel -= rows as f32;
        } else {
            self.ide.wheel = 0.0;
        }
        consumed
    }

    /// `IDE_EDIT="<object> <key> <value>[; ...]"` — replay IDE edits through
    /// the REAL path (`ide_apply`: spec mutation + rebuild) after boot, so a
    /// SHOT can verify what a mouse gesture would do. The `WEAR_EDIT`
    /// discipline: harness surface, not an owner surface.
    pub fn ide_env_edits(&mut self) {
        let Ok(v) = std::env::var(crate::wear_file::env::IDE_EDIT) else { return };
        self.ide.model = self.ide_model();
        // IDE_SEL first, so the two knobs compose in the interactive order
        // (select, then edit) — an edit-then-select would DISARM a mode the
        // replay just armed (`crack_select` clears place-mode on a change)
        self.ide_boot_sel();
        // a replay is not an interactive edit (the `WEAR_EDIT` discipline):
        // the dirty flag is restored so the session's saves stay the owner's —
        // and `IDE_EDIT` sits in `env_overridden` besides, so a save inside
        // the replay is blocked outright
        let dirty = self.crack.dirty;
        for stmt in v.split(';').map(str::trim).filter(|s| !s.is_empty()) {
            let Some((name, key, val)) = split_edit(stmt) else {
                eprintln!("IDE_EDIT: {stmt:?}: want \"<object> <key> <value>\"");
                continue;
            };
            let Some(o) = self.ide.model.objects.iter().find(|o| o.name == name) else {
                eprintln!("IDE_EDIT: no object named {name:?}");
                continue;
            };
            let Some(p) = o.props.iter().find(|p| p.key == key) else {
                eprintln!("IDE_EDIT: {name:?} has no prop {key:?}");
                continue;
            };
            // the prop declares its own value type: wear rows take floats
            let Some(num) = edit_val(&p.kind, val) else {
                eprintln!("IDE_EDIT: {stmt:?}: bad value");
                continue;
            };
            self.ide_apply(Edit { obj: o.id, key: p.key, v: num });
            self.ide.model = self.ide_model();
        }
        self.crack.dirty = dirty;
    }

    /// The IDE's stamps for this frame: refresh the model, rasterize the
    /// panels at the IDE scale, and bubble-mark the selected SPAWN cell — the
    /// one pickable that is a place, not a mesh, so the tonemap's amber
    /// selection outline (walls, lamps, the player) has nothing to trace.
    pub fn ide_stamps(&mut self) -> Vec<Stamp> {
        if !self.ide.ui.open {
            return Vec::new();
        }
        self.ide.model = self.ide_model();
        self.ide_boot_sel();
        let s = self.ide_scale();
        let (vw, vh) = self.ide_viewport();
        let cur = self.ide_px(self.view.cursor);
        self.ide.ui.cursor(cur);
        let mut out: Vec<Stamp> = self
            .ide
            .ui
            .frame(&self.ide.model, vw, vh)
            .into_iter()
            .map(|p| Stamp { pix: p.pix, w: p.w as i32, h: p.h as i32, x: p.x as i64 * s as i64, y: p.y as i64 * s as i64, scale: s })
            .collect();
        // selection marker over the spawn cell (the gym marker language)
        if let Some(sel) = self.ide.ui.sel {
            let nl = self.gym.spec.lights.len();
            if matches!(target_of(sel, nl), Target::Spawn) {
                if let Some(o) = self.ide.model.obj(sel) {
                    let anchor = Vec3::new(o.pos[0], o.size[1] + 0.35, o.pos[2]);
                    let (ext_w, ext_h) = self.backend.extent();
                    let (ext_w, ext_h) = (ext_w as i64, ext_h as i64);
                    let rs = self.rs().max(1) as i64;
                    let (pix, w, h) = crate::gym_loop::bubble(&o.name, ide::theme::ACCENT);
                    let win = iso_core::world_to_window_px(anchor, &self.pick_xform());
                    if win.x > -60.0 && win.y > -60.0 && win.x < ext_w as f32 + 60.0 && win.y < ext_h as f32 + 60.0 {
                        let x = (win.x as i64 - (w as i64 * rs) / 2).clamp(2, ext_w - w as i64 * rs - 2);
                        let y = (win.y as i64 - h as i64 * rs).clamp(2, ext_h - h as i64 * rs - 2);
                        out.push(Stamp { pix, w, h, x, y, scale: rs as u32 });
                    }
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn obj_ids_round_trip_for_every_target() {
        let nl = 3;
        for t in [Target::Player, Target::Spawn, Target::Lamp(0), Target::Lamp(2), Target::Run(0), Target::Run(11)] {
            assert_eq!(target_of(obj_id(t, nl), nl), t);
        }
    }

    /// Every wear row's key must survive the `IDE_EDIT` statement grammar
    /// (split on spaces → the key is one token) and name its row uniquely —
    /// checked across ALL patterns, since the param rows change with the
    /// policy.
    #[test]
    fn wear_keys_are_single_tokens_and_unique() {
        for code in 0..crate::crack_geom::NPOL as u8 {
            let mut spec = wear_core::wall::WallSpec::PRISTINE;
            spec.shape.pattern = wear_core::wall::pattern_of(code, crate::crack_geom::param_defaults(code));
            let pdefs = crate::crack_geom::POLICY_PARAMS[code as usize];
            let keys: Vec<&str> = rows_of(&spec).iter().map(|r| wear_key(*r, pdefs)).collect();
            let mut uniq = keys.clone();
            uniq.sort();
            uniq.dedup();
            assert_eq!(uniq.len(), keys.len(), "duplicate key under policy {code}: {keys:?}");
            for k in keys {
                assert!(!k.contains(' '), "{k:?} would break the IDE_EDIT statement grammar");
            }
        }
    }

    #[test]
    fn ide_scale_is_half_the_menu_pixel_floored_at_one() {
        // default window (800 px tall): menu 2 → ide 1 = half the game texel
        assert_eq!(ide_scale_for(800), 1);
        // tall monitor: menu 5 → ide 2 (readability floor keeps chrome legible)
        assert_eq!(ide_scale_for(2160), 2);
        assert_eq!(ide_scale_for(100), 1, "never zero");
    }

    /// The crack lab's own level, resolved exactly as a boot resolves it: the
    /// real piers, the real runs, the real authored wear.
    fn lab() -> (crate::gym_scene::GymMeta, crate::crack::CrackLab) {
        let (mut scene, meta) = crate::gym_scene::build_gym(&crate::demos::Level::Gym.spec(), &crate::look::POLANA);
        let mut lab = crate::crack::CrackLab::default();
        crate::crack::resolve(Some(crate::demos::lab_wear()), &mut lab, &meta.piers, &mut scene, 1);
        (meta, lab)
    }

    /// A ray straight down the middle of a pier — the pure pick's input,
    /// without a camera. Nothing in the gym stands over a wall, so the pier is
    /// always the nearest hit.
    fn ray_onto(p: &Pier) -> (Vec3, Vec3) {
        let c = 0.5 * (p.lo + p.hi);
        (Vec3::new(c.x, 10.0, c.z), Vec3::new(0.0, -1.0, 0.0))
    }

    /// SELECTION IS THE RUN. `wall_slab` cuts an authored wall into piers
    /// wherever a window or a doorway interrupts it, so a facade the owner
    /// typed as one line is three boxes to the ray — and a pick on ANY of them
    /// has to name the same wall. This is the claim the whole IDE selection
    /// rests on, and it used to live only inside `impl Viewer`.
    #[test]
    fn a_pick_on_any_pier_of_a_run_names_the_same_wall() {
        let (meta, _) = lab();
        let (runs, pier_run) = crate::crack::runs_of(&meta.piers);
        let cut = (0..runs.len()).find(|r| pier_run.iter().filter(|pr| *pr == r).count() > 1).expect("some gym wall is cut into piers by an opening");
        let mine: Vec<usize> = pier_run.iter().enumerate().filter(|(_, pr)| **pr == cut).map(|(i, _)| i).collect();
        assert!(mine.len() >= 2, "the fixture needs a multi-pier run");
        let player = Vec3::new(-99.0, 0.0, -99.0); // out of every column below
        for i in mine.iter().copied() {
            let (o, d) = ray_onto(&meta.piers[i]);
            let hit = pick_target(o, d, &meta.piers, &pier_run, &[], player, player);
            assert_eq!(hit, Some(Target::Run(cut)), "pier {i} must name its RUN, not itself");
        }
        // …and a pier of a DIFFERENT run names that one
        let other = (0..meta.piers.len()).find(|i| pier_run[*i] != cut).expect("the gym has more than one run");
        let (o, d) = ray_onto(&meta.piers[other]);
        assert_eq!(pick_target(o, d, &meta.piers, &pier_run, &[], player, player), Some(Target::Run(pier_run[other])));
    }

    /// The lift is the WHOLE run and NOTHING else — a wrong-run outline and a
    /// half-lifted facade are the two ways this can ship green.
    #[test]
    fn the_lift_is_every_pier_of_the_run_and_no_other() {
        let (meta, _) = lab();
        let (runs, pier_run) = crate::crack::runs_of(&meta.piers);
        for r in 0..runs.len() {
            let (pick, lift) = lift_plan(&pier_run, Some(Target::Run(r)));
            let mine: Vec<usize> = pier_run.iter().enumerate().filter(|(_, pr)| **pr == r).map(|(i, _)| i).collect();
            assert_eq!(lift, mine, "run {r}");
            assert_eq!(pick, mine.first().copied(), "the crack lab picks one pier OF the run");
            assert!(lift.iter().all(|i| pier_run[*i] == r), "no foreign pier rides along");
        }
        // the non-wall targets lift no pier at all (a lamp/player lifts its
        // dynamic materials; the spawn is a place with no mesh)
        for tg in [None, Some(Target::Player), Some(Target::Spawn), Some(Target::Lamp(0))] {
            assert_eq!(lift_plan(&pier_run, tg), (None, Vec::new()), "{tg:?}");
        }
    }

    /// A sheet spelled out by hand (the `crack_geom` test idiom): the inspector
    /// reads exactly these three fields, so the rows can be pinned as
    /// arithmetic instead of through a solve.
    fn sheet(area: [f32; wear_core::wall::Layer::N], notes: Vec<wear_core::wall::Miss>) -> wear_core::wall::Sheet {
        wear_core::wall::Sheet {
            label: "w",
            area,
            breaks: wear_core::wall::Breaks { count: 2, at: None },
            gate: [0.5; wear_core::wall::Layer::N],
            paint: wear_core::wall::Paint::default(),
            geom: wear_core::wall::Geom::default(),
            notes,
        }
    }

    /// The inspector's value LANGUAGE: a pinned layer wears the `*`, the
    /// belonging rows are indented under what they belong to, the two section
    /// heads open their groups, and a `wall::Miss` lands as the trailing read
    /// row — "what this wall asked for and did not get".
    #[test]
    fn the_wear_rows_mark_pins_indent_their_children_and_report_a_miss() {
        use wear_core::wall::Layer;
        let mut spec = wear_core::wall::WallSpec::PRISTINE;
        spec.pin = spec.pin.area(Layer::Spall, 0.02);
        let area = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
        let miss = wear_core::wall::Miss::Coarse { label: "w", layer: Layer::Chips, asked: 0.6, got: 0.2 };
        let props = wear_props(&spec, &sheet(area, vec![miss]), false);
        let get = |k: &str| props.iter().find(|p| p.key == k).unwrap_or_else(|| panic!("no {k} row"));
        // the PIN mark rides the value text, and only the pinned layer's
        assert_eq!(get("spall").show.as_deref(), Some("0.50*"));
        assert_eq!(get("stain").show.as_deref(), Some("0.10"));
        // indents: a layer belongs to its causes, a native param to its layer
        for l in Layer::ALL {
            assert_eq!(get(l.name()).indent, 8, "{}", l.name());
        }
        assert_eq!(get("mud_top").indent, 16, "mud's own param sits under the mud row");
        assert_eq!(get("caliber").indent, 8);
        assert_eq!(get("weather").indent, 0, "a CAUSE is the top level");
        // section heads
        assert_eq!(props[0].head, Some("wear"));
        assert_eq!(get("grain").head, Some("shape"));
        // the breaks row is the sheet's COUNT, absolute
        assert!(matches!(get("breaks").kind, PropKind::SliderI { v: 2, min: 0, max: 3 }));
        // shells is a MODE row, and it says which way it is pointing
        assert_eq!(get("shells").show.as_deref(), Some("0 [place]"));
        assert_eq!(wear_props(&spec, &sheet(area, Vec::new()), true).iter().find(|p| p.key == "shells").and_then(|p| p.show.as_deref()), Some("0 [click wall]"));
        // the MISS is the LAST row, read-only, naming the layer and the numbers
        let last = props.last().expect("rows");
        assert_eq!((last.key, last.label.as_str()), ("note", "chips coarse"));
        assert!(matches!(&last.kind, PropKind::Read(t) if t == "0.60 -> 0.20"), "{:?}", last.label);
        // …and a clean sheet grows no trailing row at all
        let clean = wear_props(&spec, &sheet(area, Vec::new()), false);
        assert_eq!(clean.len(), props.len() - 1);
        assert!(clean.iter().all(|p| p.key != "note"));
    }

    /// Every key the inspector draws must reach its row back — the write path
    /// (`ide_wear_apply`) looks the row up by key, so a key that resolves to
    /// nothing is a dead slider and a key that resolves to the WRONG row is an
    /// edit landing on another dial.
    #[test]
    fn every_drawn_key_resolves_back_to_its_own_row() {
        for code in 0..crate::crack_geom::NPOL as u8 {
            let mut spec = wear_core::wall::WallSpec::PRISTINE;
            spec.shape.pattern = wear_core::wall::pattern_of(code, crate::crack_geom::param_defaults(code));
            let pdefs = crate::crack_geom::POLICY_PARAMS[code as usize];
            let rows = rows_of(&spec);
            let props = wear_props(&spec, &sheet([0.0; wear_core::wall::Layer::N], Vec::new()), false);
            assert_eq!(props.len(), rows.len(), "one prop per row under policy {code}");
            for (p, row) in props.iter().zip(rows.iter().copied()) {
                assert!(wear_row_of(&spec, p.key) == Some(row), "{} under policy {code} resolves to another row", p.key);
            }
            // `note` is not a row: it must resolve to nothing rather than to
            // whatever row happens to answer first
            assert!(wear_row_of(&spec, "note").is_none());
            assert_eq!(wear_key(rows[0], pdefs), "weather", "causes open the sheet");
        }
    }

    /// `IDE_EDIT` splits from the RIGHT, because a run's name is whatever the
    /// wear file called it — spaces and all — while a key and a value are one
    /// token each.
    #[test]
    fn an_ide_edit_statement_splits_from_the_right() {
        assert_eq!(split_edit("ramped control weather 0.9"), Some(("ramped control", "weather", "0.9")));
        assert_eq!(split_edit("lamp 0 glow 3"), Some(("lamp 0", "glow", "3")));
        assert_eq!(split_edit("player cell"), None, "two tokens is not a statement");
        assert_eq!(split_edit("spawn"), None);
        // the prop declares the value's TYPE: wear rows take floats, the rest
        // whole steps (a float on an integer row is a typo, not a rounding)
        let f = PropKind::SliderF { v: 0.0, min: 0.0, max: 1.0 };
        let i = PropKind::SliderI { v: 1, min: 1, max: 8 };
        assert_eq!(edit_val(&f, "0.9"), Some(PropVal::F(0.9)));
        assert_eq!(edit_val(&i, "3"), Some(PropVal::I(3)));
        assert_eq!(edit_val(&i, "3.5"), None);
        assert_eq!(edit_val(&f, "off"), None);
        assert_eq!(edit_val(&PropKind::Cycle { v: 0, n: 3 }, "2"), Some(PropVal::I(2)), "a cycler takes an ABSOLUTE code");
    }
}
