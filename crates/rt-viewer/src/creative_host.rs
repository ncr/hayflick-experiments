//! Creative mode's adapter (owner 2026-09-22): the game mode where you BUILD
//! the level, city-builder style. Tab switches between playing and building.
//!
//! What lives where:
//! - `house_game::gym::creative` — every decision about what a gesture means
//!   (snapping, the building's doorway, undo). Headless, unit-tested.
//! - `ide::toolbar` — the one strip of chrome at the bottom of the screen.
//! - here — the plumbing: pointer → ground point, the gesture's press/drag/
//!   release, the free camera, the tonemap's grid + ghost, and the rebuild +
//!   save after a commit.
//!
//! Building pauses the sim (the pause = edit anchor, same as the IDE). The
//! camera leaves the player: WASD/arrows pan, the wheel zooms, q/e turn. Every
//! commit rebuilds the scene through `apply_look`, hands the new grid to the
//! sim (a built wall must also BLOCK), and saves the level file when the level
//! is file-backed — exactly the IDE's lamp-edit path.

use crate::backend::Stamp;
use crate::viewer::Viewer;
use glam::{Vec2, Vec3};
use house_game::gym::creative::{self, Button, History, Preview, Tool, BRUSH_R};
use house_game::gym::sim::PaintStroke;
use ide::toolbar::{self, BarHit, BarModel};

/// Tool labels for the toolbar, in [`Tool::ALL`] order.
fn tool_labels() -> [&'static str; 7] {
    Tool::ALL.map(Tool::name)
}

/// Camera pan speed while building, world units per second at zoom 1.
const PAN_WU_PER_S: f32 = 9.0;
/// Grid lines are drawn on hits below this height: the ground, not the walls.
const GRID_MAX_Y: f32 = 0.3;
/// Half-thickness of a wall ghost in world units (walls are 0.2 thick).
const WALL_GHOST: f32 = 0.16;

pub struct CreativeState {
    pub open: bool,
    pub tool: Tool,
    /// The gesture in flight: which button, and the ground point it pressed.
    press: Option<(Button, (f32, f32))>,
    /// The ground point under the cursor (None off the ground / off screen).
    hover: Option<(f32, f32)>,
    pub hist: History,
    /// One line for the toolbar's status slot ("built", "undone", …).
    status: String,
    /// A paint drag's dabs so far (committed on release).
    dabs: Vec<PaintStroke>,
    /// The wall point under the cursor with a paint tool: (point, face slot).
    brush: Option<(Vec3, usize)>,
}

impl Default for CreativeState {
    fn default() -> CreativeState {
        CreativeState { open: false, tool: Tool::Wall, press: None, hover: None, hist: History::default(), status: String::new(), dabs: Vec::new(), brush: None }
    }
}

/// The ghost of a preview as ONE world-xz rect (x0, z0, x1, z1) — the tonemap
/// draws one rect. A wall line is a thin strip along its edges, a building its
/// footprint, a lamp or spawn its cell. `None` for an empty preview.
pub fn ghost_rect(pv: &Preview) -> Option<[f32; 4]> {
    let mut r = [f32::MAX, f32::MAX, f32::MIN, f32::MIN];
    let mut grow = |x0: f32, z0: f32, x1: f32, z1: f32| {
        r = [r[0].min(x0), r[1].min(z0), r[2].max(x1), r[3].max(z1)];
    };
    for &(p, _) in &pv.cells {
        grow(p.x as f32, p.z as f32, p.x as f32 + 1.0, p.z as f32 + 1.0);
    }
    if pv.cells.is_empty() {
        // a building's edges are inside its footprint; only a bare wall line
        // needs its own strip
        for &(x, z, _) in &pv.wall_x {
            grow(x as f32 - WALL_GHOST, z as f32, x as f32 + WALL_GHOST, z as f32 + 1.0);
        }
        for &(x, z, _) in &pv.wall_z {
            grow(x as f32, z as f32 - WALL_GHOST, x as f32 + 1.0, z as f32 + WALL_GHOST);
        }
    }
    for &(p, _) in &pv.lamps {
        grow(p.x as f32, p.z as f32, p.x as f32 + 1.0, p.z as f32 + 1.0);
    }
    if let Some(p) = pv.spawn {
        grow(p.x as f32, p.z as f32, p.x as f32 + 1.0, p.z as f32 + 1.0);
    }
    (r[0] <= r[2]).then_some(r)
}

impl Viewer {
    /// Tab: play ↔ build. Opening drops every held input and parks the camera
    /// where it is; closing hands the camera back to the follow-cam.
    pub fn creative_toggle(&mut self) {
        let c = &mut self.creative;
        c.open = !c.open;
        c.press = None;
        self.clear_live_input();
        if !self.creative.open {
            // force the follow-cam to re-aim at the player on the next frame
            self.gym.last_cam = Vec3::splat(f32::NAN);
        }
        self.creative.status = if self.creative.open { "creative".into() } else { String::new() };
        self.ui_blip(if self.creative.open { "menu_open" } else { "menu_close" });
        println!("creative: {}", if self.creative.open { "on (tab: play, 1-7: tools, ctrl+z: undo)" } else { "off" });
    }

    pub fn creative_set_tool(&mut self, i: usize) {
        if let Some(&t) = Tool::ALL.get(i) {
            self.creative.tool = t;
            self.creative.press = None;
            self.ui_blip("menu_move");
        }
    }

    /// The toolbar's pixel scale: game chrome, so it is never finer than two
    /// window px per bar px (half the menu's UI pixel alone would leave it
    /// 8 px tall at 1280x800).
    fn bar_scale(&self) -> u32 {
        (crate::backend::menu_scale_for(self.backend.extent().1) / 2).max(2)
    }

    fn bar_viewport(&self) -> (i32, i32) {
        let s = self.bar_scale();
        let (w, h) = self.backend.extent();
        ((w / s) as i32, (h / s) as i32)
    }

    fn bar_px(&self, win: Vec2) -> (i32, i32) {
        let s = self.bar_scale() as f32;
        ((win.x / s) as i32, (win.y / s) as i32)
    }

    fn creative_ground(&self, win: Vec2) -> Option<(f32, f32)> {
        iso_core::window_px_to_ground(win, &self.pick_xform()).map(|p| (p.x, p.z))
    }

    fn bar_model(&self) -> (usize, &'static str, bool, bool) {
        let active = Tool::ALL.iter().position(|&t| t == self.creative.tool).unwrap_or(0);
        (active, self.creative.tool.hint(), self.creative.hist.can_undo(), self.creative.hist.can_redo())
    }

    fn bar_hit(&self, win: Vec2) -> (bool, Option<BarHit>) {
        let labels = tool_labels();
        let (active, hint, can_undo, can_redo) = self.bar_model();
        let m = BarModel { tools: &labels, active, hint, can_undo, can_redo, status: &self.creative.status, groups: &[4] };
        let (vw, vh) = self.bar_viewport();
        let p = self.bar_px(win);
        (toolbar::over(&m, p, vw, vh), toolbar::hit(&m, p, vw, vh))
    }

    /// A mouse press while building. The toolbar takes its clicks; anywhere
    /// else starts a gesture at the ground point under the cursor.
    pub fn creative_press(&mut self, win: Vec2, button: Button) {
        let (over, hit) = self.bar_hit(win);
        if over {
            if button == Button::Build {
                match hit {
                    Some(BarHit::Tool(i)) => self.creative_set_tool(i),
                    Some(BarHit::Undo) => self.creative_undo(),
                    Some(BarHit::Redo) => self.creative_redo(),
                    Some(BarHit::Play) => self.creative_toggle(),
                    None => {}
                }
            }
            return;
        }
        if let Tool::Paint(_) = self.creative.tool {
            self.creative.brush = self.wall_hit(win);
            self.creative.dabs.clear();
            if self.creative.brush.is_some() {
                self.creative.press = Some((button, (0.0, 0.0)));
                self.paint_dab();
            }
            return;
        }
        self.creative.hover = self.creative_ground(win);
        self.creative.press = self.creative.hover.map(|p| (button, p));
    }

    pub fn creative_move(&mut self, win: Vec2) {
        self.creative.hover = self.creative_ground(win);
        if let Tool::Paint(_) = self.creative.tool {
            self.creative.brush = self.wall_hit(win);
            if self.creative.press.is_some() {
                self.paint_dab();
            }
        }
    }

    /// The painted wall face under a window pixel: the nearest face plane the
    /// cursor's primary ray crosses from the front, inside the face.
    fn wall_hit(&self, win: Vec2) -> Option<(Vec3, usize)> {
        let (o, d) = iso_core::window_px_ray(win, &self.pick_xform());
        let mut best: Option<(f32, Vec3, usize)> = None;
        for (i, f) in self.painted.iter().enumerate() {
            let n = if f.n_axis == 0 { Vec3::X } else { Vec3::Z } * f.n_sign as f32;
            let den = d.dot(n);
            if den >= -1e-4 {
                continue; // the face looks away from the camera
            }
            let t = (f.world(0.0, 0.0) - o).dot(n) / den;
            let p = o + d * t;
            let u = (p - f.origin).dot(f.axis);
            if t > 0.0 && (0.0..=f.spec.len).contains(&u) && (0.0..=crate::painted::HEIGHT).contains(&p.y) && best.is_none_or(|b| t < b.0) {
                best = Some((t, p, i));
            }
        }
        best.map(|(_, p, i)| (p, i))
    }

    /// Lay a dab under the brush if it moved far enough from the last one,
    /// then re-bake that face with it and push the atlas: paint shows under
    /// the cursor while the drag is still going, with no scene rebuild.
    fn paint_dab(&mut self) {
        let (Some((p, slot)), Some((button, _)), Tool::Paint(effect)) = (self.creative.brush, self.creative.press, self.creative.tool) else { return };
        let f = self.painted[slot];
        let dab = PaintStroke { effect, pos: p.to_array(), axis: f.n_axis, sign: f.n_sign, r: BRUSH_R };
        if self.creative.dabs.last().is_some_and(|l| (Vec3::from(l.pos) - p).length() < BRUSH_R * 0.45) {
            return;
        }
        self.creative.dabs.push(dab);
        let strokes: Vec<PaintStroke> = if button == Button::Build {
            self.gym.spec.paint.iter().chain(&self.creative.dabs).copied().collect()
        } else {
            self.gym.spec.paint.iter().filter(|s| !creative::scrubbed(s, &self.creative.dabs)).copied().collect()
        };
        let face = surface::Face::bake(f.spec, &f.strokes(&strokes));
        crate::painted::blit(&mut self.scene.atlas, &f, &face);
        unsafe { self.backend.update_atlas(&self.scene.atlas) };
    }

    /// Release: the gesture commits if it was this button's. A release off
    /// the ground (cursor left the window) cancels.
    pub fn creative_release(&mut self, button: Button) {
        let Some((b, p0)) = self.creative.press.take() else { return };
        if b != button {
            return;
        }
        if let Tool::Paint(e) = self.creative.tool {
            let dabs = std::mem::take(&mut self.creative.dabs);
            let changed = if button == Button::Build { creative::paint(&mut self.gym.spec, &mut self.creative.hist, &dabs) } else { creative::scrub(&mut self.gym.spec, &mut self.creative.hist, &dabs) };
            if changed {
                self.creative.status = if button == Button::Build { format!("{} painted", e.name()) } else { "paint scrubbed".into() };
                // the texture is already live; the rebuild brings the geometry
                // (a spall's crater and steel) and saves
                self.creative_rebuild();
            }
            return;
        }
        let Some(p1) = self.creative.hover else { return };
        let tool = self.creative.tool;
        if creative::commit(&mut self.gym.spec, &mut self.creative.hist, tool, button, p0, p1) {
            self.creative.status = format!("{} {}", tool.name(), if button == Button::Build { "built" } else { "removed" });
            self.creative_rebuild();
        }
    }

    /// Esc while building: drop the gesture in flight, or leave building.
    pub fn creative_cancel(&mut self) {
        if self.creative.press.take().is_none() {
            self.creative_toggle();
        } else if !self.creative.dabs.is_empty() {
            // the live preview already changed the atlas: rebuild it clean
            self.creative.dabs.clear();
            let look = self.look;
            self.apply_look(look);
        }
    }

    pub fn creative_undo(&mut self) {
        if self.creative.hist.undo(&mut self.gym.spec) {
            self.creative.status = "undone".into();
            self.creative_rebuild();
        }
    }

    pub fn creative_redo(&mut self) {
        if self.creative.hist.redo(&mut self.gym.spec) {
            self.creative.status = "redone".into();
            self.creative_rebuild();
        }
    }

    /// After any level change: the sim gets the new grid, the scene rebuilds,
    /// the file saves (file-backed levels only; `level_save` says why not).
    fn creative_rebuild(&mut self) {
        self.gym.sim.set_level(self.gym.spec.clone());
        // a spawn edit made here IS authoring (the IDE's rule)
        self.level.authored_spawn = self.gym.spec.player_start;
        self.level.dirty = true;
        let look = self.look;
        self.apply_look(look);
        self.level_save();
        self.ui_blip("menu_pick");
    }

    /// Held WASD/arrows pan the camera, screen-relative, while building.
    pub fn creative_pan(&mut self, dt: f32) {
        if !self.creative.open {
            return;
        }
        let [u, d, l, r] = self.keys.movement();
        let sx = r as i32 as f32 - l as i32 as f32;
        let sy = u as i32 as f32 - d as i32 as f32;
        if sx == 0.0 && sy == 0.0 {
            return;
        }
        let (_dir, right, up) = self.proj.basis(self.yaw_deg());
        // screen-up on the ground: `up` flattened onto xz
        let fwd = Vec3::new(up.x, 0.0, up.z).normalize_or_zero();
        let side = Vec3::new(right.x, 0.0, right.z).normalize_or_zero();
        let speed = PAN_WU_PER_S / self.view.zoom.max(1.0);
        self.pan_target((side * sx + fwd * sy).normalize_or_zero() * speed * dt);
    }

    /// The tonemap's creative words (`TonePush::edit1/edit2`): zero in play.
    pub fn creative_edit_push(&self) -> [[f32; 4]; 2] {
        let c = &self.creative;
        if !c.open {
            return [[0.0; 4]; 2];
        }
        if let Tool::Paint(_) = c.tool {
            return match c.brush {
                Some((p, _)) => {
                    let kind = if c.press.is_some_and(|(b, _)| b == Button::Remove) { 5.0 } else { 4.0 };
                    [[p.x, p.y, p.z, BRUSH_R], [1.0, kind, 0.0, GRID_MAX_Y]]
                }
                None => [[0.0; 4], [1.0, 0.0, 0.0, GRID_MAX_Y]],
            };
        }
        let (rect, kind) = match (c.press, c.hover) {
            (Some((b, p0)), Some(p1)) => {
                let pv = creative::preview(&self.gym.spec, c.tool, b, p0, p1);
                (ghost_rect(&pv), if b == Button::Build { 1.0 } else { 2.0 })
            }
            (None, Some(p)) => {
                // hover: the corner a wall would start at, or the cell
                let r = if c.tool == Tool::Wall {
                    let (x, z) = creative::snap_corner(&self.gym.spec, p.0, p.1);
                    let (x, z) = (x as f32, z as f32);
                    Some([x - WALL_GHOST, z - WALL_GHOST, x + WALL_GHOST, z + WALL_GHOST])
                } else {
                    let q = creative::snap_cell(&self.gym.spec, p.0, p.1);
                    Some([q.x as f32, q.z as f32, q.x as f32 + 1.0, q.z as f32 + 1.0])
                };
                (r, 3.0)
            }
            _ => (None, 0.0),
        };
        match rect {
            Some(r) => [r, [1.0, kind, 0.0, GRID_MAX_Y]],
            None => [[0.0; 4], [1.0, 0.0, 0.0, GRID_MAX_Y]],
        }
    }

    /// The toolbar as a stamp (IDE scale, bottom-centred). Empty in play.
    pub fn creative_stamps(&self, cursor: Vec2) -> Vec<Stamp> {
        if !self.creative.open {
            return Vec::new();
        }
        let labels = tool_labels();
        let (active, hint, can_undo, can_redo) = self.bar_model();
        let m = BarModel { tools: &labels, active, hint, can_undo, can_redo, status: &self.creative.status, groups: &[4] };
        let (vw, vh) = self.bar_viewport();
        let p = toolbar::draw(&m, vw, vh, self.bar_px(cursor));
        let s = self.bar_scale();
        vec![Stamp { pix: p.pix, w: p.w as i32, h: p.h as i32, x: p.x as i64 * s as i64, y: p.y as i64 * s as i64, scale: s }]
    }

    /// Window px of a toolbar button's centre — the play-script harness moves
    /// its cursor onto buttons by name.
    pub fn creative_button_px(&self, hit: BarHit) -> Option<Vec2> {
        let labels = tool_labels();
        let (active, hint, can_undo, can_redo) = self.bar_model();
        let m = BarModel { tools: &labels, active, hint, can_undo, can_redo, status: &self.creative.status, groups: &[4] };
        let (vw, vh) = self.bar_viewport();
        let s = self.bar_scale() as f32;
        toolbar::layout(&m, vw, vh).1.into_iter().find(|(_, h)| *h == hit).map(|(r, _)| Vec2::new((r.x as f32 + r.w as f32 * 0.5) * s, (r.y as f32 + r.h as f32 * 0.5) * s))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use house_game::gym::level_file;

    #[test]
    fn a_wall_ghost_is_a_thin_strip_and_a_building_ghost_its_footprint() {
        let lv = level_file::parse("size 10 8\nspawn 1 1\n").unwrap();
        let wall = creative::preview(&lv, Tool::Wall, Button::Build, (2.0, 3.0), (6.0, 3.0));
        let r = ghost_rect(&wall).unwrap();
        assert_eq!(r, [2.0, 3.0 - WALL_GHOST, 6.0, 3.0 + WALL_GHOST]);
        let room = creative::preview(&lv, Tool::Room, Button::Build, (2.5, 1.5), (5.5, 4.5));
        assert_eq!(ghost_rect(&room).unwrap(), [2.0, 1.0, 6.0, 5.0]);
        let none = creative::preview(&lv, Tool::Wall, Button::Build, (2.0, 3.0), (2.1, 3.1));
        assert_eq!(ghost_rect(&none), None, "a zero-length drag has no ghost");
    }
}
