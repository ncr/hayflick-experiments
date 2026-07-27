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

use crate::backend::Stamp;
use crate::gym_scene::cell_world;
use crate::viewer::Viewer;
use glam::{Vec2, Vec3};
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
}

impl IdeState {
    pub fn from_env() -> IdeState {
        let mut ui = ide::Ide::default();
        ui.open = std::env::var("IDE").is_ok_and(|v| v != "0");
        IdeState { ui, drag_pending: false, wheel: 0.0, model: SceneModel { level: String::new(), objects: Vec::new() }, boot_sel: std::env::var("IDE_SEL").ok() }
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
    /// mode line must not keep walking the player.
    pub fn ide_toggle(&mut self) {
        self.ide.ui.open = !self.ide.ui.open;
        self.gym.held = [false; 4];
        self.gym.run_held = false;
        self.ide.drag_pending = false;
        self.ide.ui.cancel_drag();
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
            objects.push(Obj {
                id: obj_id(Target::Run(r), nl),
                name: if label.is_empty() { format!("wall {r}") } else { label.to_string() },
                group: "walls",
                pos: (0.5 * (run.lo + run.hi)).to_array(),
                size: (run.hi - run.lo).to_array(),
                props: vec![
                    Prop { key: "piers", label: "piers", kind: PropKind::Read(format!("{n_piers}")) },
                    Prop { key: "wear", label: "wear", kind: PropKind::Read("wall panel".into()) },
                ],
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
                    Prop { key: "glow", label: "glow", kind: PropKind::SliderI { v: *glow, min: 1, max: 8 } },
                    Prop { key: "cx", label: "cell x", kind: PropKind::SliderI { v: cell.x as i32, min: 0, max: gw - 1 } },
                    Prop { key: "cz", label: "cell z", kind: PropKind::SliderI { v: cell.z as i32, min: 0, max: gh - 1 } },
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
            props: vec![Prop { key: "cell", label: "cell", kind: PropKind::Read(format!("{} {}", p.x.floor(), p.z.floor())) }],
        });
        objects.push(Obj {
            id: obj_id(Target::Spawn, nl),
            name: "spawn".into(),
            group: "actors",
            pos: cell_world(spec.player_start).to_array(),
            size: [1.0, 0.0, 1.0],
            props: vec![
                Prop { key: "sx", label: "cell x", kind: PropKind::SliderI { v: spec.player_start.x as i32, min: 0, max: gw - 1 } },
                Prop { key: "sz", label: "cell z", kind: PropKind::SliderI { v: spec.player_start.z as i32, min: 0, max: gh - 1 } },
                Prop { key: "note", label: "note", kind: PropKind::Read("applies on restart".into()) },
            ],
        });
        SceneModel { level: self.cur_demo.map_or("gym", |d| d.name).to_string(), objects }
    }

    /// Apply one IDE edit: mutate the SPEC, rebuild through `apply_look`
    /// (same path as every authoring surface; sim untouched — lights and the
    /// spawn are render/boot data).
    fn ide_apply(&mut self, e: Edit) {
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
        // the rebuild re-stamped every pier from crack state — re-apply the
        // IDE's own selection lift on top
        if let Some(sel) = self.ide.ui.sel {
            let nl = self.gym.spec.lights.len();
            self.ide_select(Some(target_of(sel, nl)), nl);
        }
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
        let (_, pier_run) = crate::crack::runs_of(&self.piers);
        let mut best: Option<(f32, Target)> = None;
        let mut consider = |t: Option<f32>, tg: Target| {
            if let Some(t) = t {
                if best.is_none_or(|(bt, _)| t < bt) {
                    best = Some((t, tg));
                }
            }
        };
        for (i, pier) in self.piers.iter().enumerate() {
            consider(crate::crack::ray_aabb(o, d, pier.lo, pier.hi), Target::Run(pier_run.get(i).copied().unwrap_or(0)));
        }
        for (i, (cell, _)) in self.gym.spec.lights.iter().enumerate() {
            let c = cell_world(*cell);
            consider(crate::crack::ray_aabb(o, d, Vec3::new(c.x - 0.1, 0.0, c.z - 0.15), Vec3::new(c.x + 0.4, 1.75, c.z + 0.15)), Target::Lamp(i));
        }
        let pl = self.gym.cam_target();
        consider(crate::crack::ray_aabb(o, d, Vec3::new(pl.x - 0.3, 0.0, pl.z - 0.3), Vec3::new(pl.x + 0.3, 1.9, pl.z + 0.3)), Target::Player);
        let sp = cell_world(self.gym.spec.player_start);
        consider(crate::crack::ray_aabb(o, d, Vec3::new(sp.x - 0.5, 0.0, sp.z - 0.5), Vec3::new(sp.x + 0.5, 0.06, sp.z + 0.5)), Target::Spawn);
        match best {
            Some((_, tg)) => {
                self.ide_select(Some(tg), nl);
                self.ui_blip("menu_pick");
            }
            None => self.ide_select(None, nl),
        }
        true
    }

    /// Select a target in both worlds: the IDE panels, and — for a wall — the
    /// amber SEL lift on the WHOLE run (the IDE selects the authoring unit,
    /// not the pier the ray happened to strike). The crack lab's own pier
    /// selection follows a wall pick, so closing the IDE hands the picked
    /// wall straight to the wear panel.
    fn ide_select(&mut self, tg: Option<Target>, n_lamps: usize) {
        let run = match tg {
            Some(Target::Run(r)) => Some(r),
            _ => None,
        };
        let (_, pier_run) = crate::crack::runs_of(&self.piers);
        self.crack_select(run.and_then(|r| pier_run.iter().position(|&pr| pr == r)));
        // re-derive every pier's paint (clears any stale run lift — KEEP_FLAGS
        // strips SEL), then lift every pier of the selected run
        for i in 0..self.piers.len() {
            self.crack_apply(i);
        }
        if let Some(r) = run {
            for (i, pier) in self.piers.iter().enumerate() {
                if pier_run[i] == r {
                    let mid = self.scene.primitives[pier.prim].material_id as usize;
                    let pad = self.scene.materials[mid]._pad | crate::flags::SEL;
                    self.scene.materials[mid]._pad = pad;
                    self.backend.set_material_pad(mid, pad);
                }
            }
        }
        self.ide.ui.select(tg.map(|t| obj_id(t, n_lamps)));
    }

    /// The frame's ONE coalesced drag step, from the latest cursor.
    pub fn ide_drag_step(&mut self) {
        let p = self.ide_px(self.view.cursor);
        let (vw, vh) = self.ide_viewport();
        self.ide.ui.drag_to(&self.ide.model, p, vw, vh);
    }

    /// Pointer release: the pending slider value becomes an [`Edit`] and is
    /// applied (spec mutation + rebuild) — release-only cost, like the wall
    /// panel's geometry knobs.
    pub fn ide_release(&mut self) {
        if let Some(e) = self.ide.ui.release(&self.ide.model) {
            self.ide_apply(e);
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
        let Ok(v) = std::env::var("IDE_EDIT") else { return };
        self.ide.model = self.ide_model();
        for stmt in v.split(';').map(str::trim).filter(|s| !s.is_empty()) {
            let mut it = stmt.rsplitn(3, ' ');
            let (val, key, name) = (it.next(), it.next(), it.next());
            let (Some(val), Some(key), Some(name)) = (val, key, name) else {
                eprintln!("IDE_EDIT: {stmt:?}: want \"<object> <key> <value>\"");
                continue;
            };
            let Ok(num) = val.parse::<i32>() else {
                eprintln!("IDE_EDIT: {stmt:?}: bad value");
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
            self.ide_apply(Edit { obj: o.id, key: p.key, v: PropVal::I(num) });
            self.ide.model = self.ide_model();
        }
    }

    /// The IDE's stamps for this frame: refresh the model, rasterize the
    /// panels at the IDE scale, and bubble-mark the selected object when it
    /// has no material highlight of its own (lamps, player, spawn — walls
    /// carry the SEL lift instead).
    pub fn ide_stamps(&mut self) -> Vec<Stamp> {
        if !self.ide.ui.open {
            return Vec::new();
        }
        self.ide.model = self.ide_model();
        if let Some(name) = self.ide.boot_sel.take() {
            let nl = self.gym.spec.lights.len();
            if let Some(id) = self.ide.model.objects.iter().find(|o| o.name == name).map(|o| o.id) {
                self.ide_select(Some(target_of(id, nl)), nl);
            } else {
                eprintln!("IDE_SEL: no object named {name:?}");
            }
        }
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
        // selection marker over lamp/player/spawn (the gym marker language)
        if let Some(sel) = self.ide.ui.sel {
            let nl = self.gym.spec.lights.len();
            if !matches!(target_of(sel, nl), Target::Run(_)) {
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

    #[test]
    fn ide_scale_is_half_the_menu_pixel_floored_at_one() {
        // default window (800 px tall): menu 2 → ide 1 = half the game texel
        assert_eq!(ide_scale_for(800), 1);
        // tall monitor: menu 5 → ide 2 (readability floor keeps chrome legible)
        assert_eq!(ide_scale_for(2160), 2);
        assert_eq!(ide_scale_for(100), 1, "never zero");
    }
}
