//! The IDE shell: a Unity-shaped chrome — top bar, hierarchy left, inspector
//! right — rasterized into [`Panel`]s at IDE pixel scale. One layout walk is
//! shared by draw, hit-test and drag (the menu.rs rows discipline), so the
//! pixels and the clicks can never disagree.
//!
//! Interaction contract with the viewer:
//! - `over(p)` says whether a point is on IDE chrome; the viewer routes
//!   pointer events here when it is, to world picking when it is not.
//! - drags are COALESCED by the caller (one `drag_to` per frame from the
//!   latest cursor, tail flushed on release — the input-pacing discipline).
//! - [`Edit`]s are emitted on RELEASE only; during a drag the pending value
//!   is display-state, so a drag costs pixels, never rebuilds.

use crate::canvas::Canvas;
use crate::scene::{slider_frac, slider_value, Edit, ObjId, PropKind, PropVal, SceneModel};
use crate::theme::*;

/// One rasterized panel, positioned in IDE px; the viewer stamps it at the
/// IDE scale (2x the game's pixel density).
pub struct Panel {
    pub pix: Vec<u32>,
    pub w: u32,
    pub h: u32,
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Copy, PartialEq, Debug)]
struct Rect {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

impl Rect {
    fn contains(&self, p: (i32, i32)) -> bool {
        p.0 >= self.x && p.1 >= self.y && p.0 < self.x + self.w && p.1 < self.y + self.h
    }
}

/// Panel header strip height (the "hierarchy" / "inspector" caption).
const HEAD_H: i32 = 12;
/// Slider track x-range inside an inspector row.
const TRACK_X0: i32 = 60;
const TRACK_X1: i32 = INSP_W - 36;

/// An active slider drag.
struct Drag {
    obj: ObjId,
    prop: usize,
    pending: PropVal,
}

/// One hierarchy row: a group caption or a selectable object.
enum HRow {
    Head(&'static str),
    Obj(ObjId),
}

/// One inspector row; `Slider(i)` / `Read(i)` index into the object's props.
enum IRow {
    Sub,
    Section(&'static str),
    Pos,
    Size,
    Read(usize),
    Slider(usize),
}

pub struct Ide {
    pub open: bool,
    pub sel: Option<ObjId>,
    cursor: (i32, i32),
    scroll: i32,
    drag: Option<Drag>,
}

impl Default for Ide {
    fn default() -> Ide {
        Ide { open: false, sel: None, cursor: (-1, -1), scroll: 0, drag: None }
    }
}

fn rects(vw: i32, vh: i32) -> (Rect, Rect, Rect) {
    let bar = Rect { x: 0, y: 0, w: vw, h: TOPBAR_H };
    let hier = Rect { x: 0, y: TOPBAR_H, w: HIER_W, h: vh - TOPBAR_H };
    let insp = Rect { x: vw - INSP_W, y: TOPBAR_H, w: INSP_W, h: vh - TOPBAR_H };
    (bar, hier, insp)
}

fn hier_rows(scene: &SceneModel) -> Vec<HRow> {
    let mut rows = Vec::new();
    let mut groups: Vec<&'static str> = Vec::new();
    for o in &scene.objects {
        if !groups.contains(&o.group) {
            groups.push(o.group);
        }
    }
    for g in groups {
        rows.push(HRow::Head(g));
        for o in scene.objects.iter().filter(|o| o.group == g) {
            rows.push(HRow::Obj(o.id));
        }
    }
    rows
}

fn insp_rows(scene: &SceneModel, sel: ObjId) -> Vec<IRow> {
    let Some(o) = scene.obj(sel) else { return Vec::new() };
    let mut rows = vec![IRow::Sub, IRow::Section("transform"), IRow::Pos, IRow::Size];
    if !o.props.is_empty() {
        rows.push(IRow::Section("properties"));
        for (i, p) in o.props.iter().enumerate() {
            rows.push(match p.kind {
                PropKind::Read(_) => IRow::Read(i),
                _ => IRow::Slider(i),
            });
        }
    }
    rows
}

impl Ide {
    /// Is the point on IDE chrome? (Dead chrome consumes clicks too — the
    /// world must never receive a click that visually landed on a panel.)
    pub fn over(&self, p: (i32, i32), vw: i32, vh: i32) -> bool {
        let (bar, hier, insp) = rects(vw, vh);
        bar.contains(p) || hier.contains(p) || insp.contains(p)
    }

    pub fn cursor(&mut self, p: (i32, i32)) {
        self.cursor = p;
    }

    /// World-pick entry (the viewer resolved a world click to an object).
    pub fn select(&mut self, id: Option<ObjId>) {
        self.sel = id;
        self.drag = None;
    }

    /// Pointer press in IDE px. Returns true when the press landed on chrome
    /// (and was handled or swallowed); false routes the press to the world.
    pub fn press(&mut self, scene: &SceneModel, p: (i32, i32), vw: i32, vh: i32) -> bool {
        let (bar, hier, insp) = rects(vw, vh);
        if hier.contains(p) {
            let rows = hier_rows(scene);
            let i = (p.1 - (hier.y + HEAD_H + 1)) / ROW_H + self.scroll;
            if p.1 >= hier.y + HEAD_H && i >= 0 {
                if let Some(HRow::Obj(id)) = rows.get(i as usize) {
                    self.sel = Some(*id);
                }
            }
            return true;
        }
        if insp.contains(p) {
            if let Some(sel) = self.sel {
                let rows = insp_rows(scene, sel);
                let i = p.1 - (insp.y + HEAD_H + 1 + ROW_H); // first row is the name header
                let i = if i >= 0 { i / ROW_H } else { -1 };
                if i >= 0 {
                    if let Some(IRow::Slider(pi)) = rows.get(i as usize) {
                        let x0 = insp.x + TRACK_X0;
                        let x1 = insp.x + TRACK_X1;
                        if p.0 >= x0 - 2 && p.0 <= x1 + 2 {
                            let o = scene.obj(sel).expect("sel resolved above");
                            let frac = (p.0 - x0) as f32 / (x1 - x0) as f32;
                            let pending = slider_value(&o.props[*pi].kind, frac);
                            self.drag = Some(Drag { obj: sel, prop: *pi, pending });
                        }
                    }
                }
            }
            return true;
        }
        bar.contains(p)
    }

    /// Coalesced drag step (once per frame from the latest cursor).
    pub fn drag_to(&mut self, scene: &SceneModel, p: (i32, i32), vw: i32, _vh: i32) {
        self.cursor = p;
        let Some(d) = &mut self.drag else { return };
        let Some(o) = scene.obj(d.obj) else { return };
        let insp_x = vw - INSP_W;
        let (x0, x1) = (insp_x + TRACK_X0, insp_x + TRACK_X1);
        let frac = (p.0 - x0) as f32 / (x1 - x0) as f32;
        d.pending = slider_value(&o.props[d.prop].kind, frac);
    }

    /// Pointer release: ends a drag; the edit lands here (release-only cost).
    pub fn release(&mut self, scene: &SceneModel) -> Option<Edit> {
        let d = self.drag.take()?;
        let o = scene.obj(d.obj)?;
        let unchanged = match (&o.props[d.prop].kind, d.pending) {
            (PropKind::SliderI { v, .. }, PropVal::I(p)) => *v == p,
            (PropKind::SliderF { v, .. }, PropVal::F(p)) => *v == p,
            _ => true,
        };
        if unchanged {
            return None;
        }
        Some(Edit { obj: d.obj, key: o.props[d.prop].key, v: d.pending })
    }

    pub fn dragging(&self) -> bool {
        self.drag.is_some()
    }

    /// Drop an in-flight drag without emitting an edit (focus loss).
    pub fn cancel_drag(&mut self) {
        self.drag = None;
    }

    /// Wheel over the hierarchy scrolls it. Returns true when consumed.
    pub fn wheel(&mut self, scene: &SceneModel, p: (i32, i32), dy: i32, vw: i32, vh: i32) -> bool {
        let (_, hier, _) = rects(vw, vh);
        if !hier.contains(p) {
            return false;
        }
        let rows = hier_rows(scene).len() as i32;
        let visible = (hier.h - HEAD_H - 2) / ROW_H;
        self.scroll = (self.scroll - dy).clamp(0, (rows - visible).max(0));
        true
    }

    /// Rasterize the chrome. Pure: same state + same model = same pixels.
    pub fn frame(&self, scene: &SceneModel, vw: i32, vh: i32) -> Vec<Panel> {
        let (bar, hier, insp) = rects(vw, vh);
        vec![self.draw_bar(scene, bar), self.draw_hier(scene, hier), self.draw_insp(scene, insp)]
    }

    fn panel_chrome(r: Rect, caption: &str) -> Canvas {
        let mut c = Canvas::new(r.w as u32, r.h as u32, BG);
        c.fill(0, 0, r.w, HEAD_H, BG_BAR);
        c.text(PAD, 2, caption, TEXT_DIM, r.w - 2 * PAD);
        c.frame(0, 0, r.w, r.h, EDGE);
        c
    }

    fn draw_bar(&self, scene: &SceneModel, r: Rect) -> Panel {
        let mut c = Canvas::new(r.w as u32, r.h as u32, BG_BAR);
        c.fill(0, r.h - 1, r.w, 1, EDGE);
        let mut x = PAD;
        x += c.text(x, 4, "pracownia", ACCENT, 100) + 12;
        c.text(x, 4, &scene.level, TEXT, r.w / 2);
        let hint = "tab: close   paused";
        c.text(r.w - PAD - Canvas::text_w(hint), 4, hint, TEXT_DIM, r.w);
        Panel { pix: c.pix, w: r.w as u32, h: r.h as u32, x: r.x, y: r.y }
    }

    fn draw_hier(&self, scene: &SceneModel, r: Rect) -> Panel {
        let mut c = Self::panel_chrome(r, "hierarchy");
        let rows = hier_rows(scene);
        let y0 = HEAD_H + 1;
        let visible = (r.h - y0 - 1) / ROW_H;
        for (vi, row) in rows.iter().skip(self.scroll.max(0) as usize).take(visible as usize).enumerate() {
            let y = y0 + vi as i32 * ROW_H;
            match row {
                HRow::Head(g) => {
                    c.text(PAD, y + 3, g, TEXT_DIM, r.w - 2 * PAD);
                }
                HRow::Obj(id) => {
                    let o = scene.obj(*id).expect("hier rows come from the model");
                    let hovered = r.contains(self.cursor) && (self.cursor.1 - r.y - y0) / ROW_H == vi as i32 && self.cursor.1 - r.y >= y0;
                    if self.sel == Some(*id) {
                        c.fill(1, y, r.w - 2, ROW_H, SEL_ROW);
                    } else if hovered {
                        c.fill(1, y, r.w - 2, ROW_H, HOVER_ROW);
                    }
                    c.text(PAD + 8, y + 3, &o.name, if self.sel == Some(*id) { TEXT_HEAD } else { TEXT }, r.w - PAD - 10);
                }
            }
        }
        Panel { pix: c.pix, w: r.w as u32, h: r.h as u32, x: r.x, y: r.y }
    }

    fn draw_insp(&self, scene: &SceneModel, r: Rect) -> Panel {
        let mut c = Self::panel_chrome(r, "inspector");
        let Some(sel) = self.sel else {
            c.text(PAD, HEAD_H + 6, "nothing selected", TEXT_DIM, r.w - 2 * PAD);
            c.text(PAD, HEAD_H + 6 + ROW_H, "click an object", TEXT_DIM, r.w - 2 * PAD);
            return Panel { pix: c.pix, w: r.w as u32, h: r.h as u32, x: r.x, y: r.y };
        };
        let Some(o) = scene.obj(sel) else {
            return Panel { pix: c.pix, w: r.w as u32, h: r.h as u32, x: r.x, y: r.y };
        };
        // name header row, then the shared row walk
        let mut y = HEAD_H + 1;
        c.text(PAD, y + 3, &o.name, TEXT_HEAD, r.w - 2 * PAD);
        y += ROW_H;
        for row in insp_rows(scene, sel) {
            match row {
                IRow::Sub => {
                    c.text(PAD, y + 3, o.group, TEXT_DIM, r.w - 2 * PAD);
                }
                IRow::Section(s) => {
                    c.fill(1, y + 1, r.w - 2, ROW_H - 2, BG_BAR);
                    c.text(PAD, y + 3, s, TEXT_DIM, r.w - 2 * PAD);
                }
                IRow::Pos => Self::kv(&mut c, y, "pos", &format!("{:.1} {:.1}", o.pos[0], o.pos[2])),
                IRow::Size => Self::kv(&mut c, y, "size", &format!("{:.1} {:.1} {:.1}", o.size[0], o.size[1], o.size[2])),
                IRow::Read(i) => {
                    if let PropKind::Read(v) = &o.props[i].kind {
                        Self::kv(&mut c, y, o.props[i].label, v);
                    }
                }
                IRow::Slider(i) => self.slider_row(&mut c, y, o, i),
            }
            y += ROW_H;
        }
        Panel { pix: c.pix, w: r.w as u32, h: r.h as u32, x: r.x, y: r.y }
    }

    fn kv(c: &mut Canvas, y: i32, label: &str, value: &str) {
        c.text(PAD, y + 3, label, TEXT_DIM, TRACK_X0 - PAD);
        c.text(TRACK_X0, y + 3, value, TEXT, INSP_W - TRACK_X0 - PAD);
    }

    fn slider_row(&self, c: &mut Canvas, y: i32, o: &crate::scene::Obj, i: usize) {
        let p = &o.props[i];
        let pending = self.drag.as_ref().filter(|d| d.obj == o.id && d.prop == i).map(|d| d.pending);
        let frac = slider_frac(&p.kind, pending).clamp(0.0, 1.0);
        c.text(PAD, y + 3, p.label, TEXT_DIM, TRACK_X0 - PAD);
        let (x0, x1) = (TRACK_X0, TRACK_X1);
        let ty = y + ROW_H / 2 - 2;
        c.fill(x0, ty, x1 - x0, 4, BG_WELL);
        let fx = x0 + ((x1 - x0 - 3) as f32 * frac).round() as i32;
        c.fill(x0, ty, fx - x0, 4, if pending.is_some() { ACCENT } else { EDGE_HI });
        c.fill(fx, ty - 1, 3, 6, if pending.is_some() { ACCENT } else { TEXT });
        let shown = pending.unwrap_or(match p.kind {
            PropKind::SliderI { v, .. } => PropVal::I(v),
            PropKind::SliderF { v, .. } => PropVal::F(v),
            PropKind::Read(_) => PropVal::F(0.0),
        });
        let txt = match shown {
            PropVal::I(v) => format!("{v}"),
            PropVal::F(v) => format!("{v:.2}"),
        };
        c.text(TRACK_X1 + 4, y + 3, &txt, TEXT, INSP_W - TRACK_X1 - 4 - 2);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::{Obj, Prop, SceneModel};

    fn fixture() -> SceneModel {
        let lamp = |id: u32, name: &str| Obj {
            id: ObjId(id),
            name: name.into(),
            group: "lamps",
            pos: [2.5, 0.0, 12.5],
            size: [0.4, 2.2, 0.4],
            props: vec![
                Prop { key: "glow", label: "glow", kind: PropKind::SliderI { v: 6, min: 1, max: 8 } },
                Prop { key: "cx", label: "cell x", kind: PropKind::SliderI { v: 2, min: 0, max: 17 } },
            ],
        };
        SceneModel {
            level: "gym".into(),
            objects: vec![
                Obj { id: ObjId(0), name: "player".into(), group: "actors", pos: [10.5, 0.0, 11.5], size: [0.5, 1.8, 0.5], props: vec![] },
                lamp(1, "lamp a"),
                lamp(2, "lamp b"),
            ],
        }
    }

    const VW: i32 = 480;
    const VH: i32 = 300;

    #[test]
    fn chrome_owns_its_rects_and_the_world_keeps_the_rest() {
        let ide = Ide::default();
        assert!(ide.over((0, 0), VW, VH), "top bar");
        assert!(ide.over((HIER_W - 1, TOPBAR_H + 5), VW, VH), "hierarchy");
        assert!(ide.over((VW - 1, VH - 1), VW, VH), "inspector");
        assert!(!ide.over((VW / 2, VH / 2), VW, VH), "the world stays clickable between panels");
    }

    #[test]
    fn hierarchy_click_selects_objects_not_headers() {
        let scene = fixture();
        let mut ide = Ide::default();
        let y0 = TOPBAR_H + HEAD_H + 1;
        // row 0 = "actors" header: consumed, nothing selected
        assert!(ide.press(&scene, (10, y0 + 3), VW, VH));
        assert_eq!(ide.sel, None);
        // row 1 = player
        assert!(ide.press(&scene, (10, y0 + ROW_H + 3), VW, VH));
        assert_eq!(ide.sel, Some(ObjId(0)));
        // row 3 = lamp a (row 2 is the "lamps" header)
        assert!(ide.press(&scene, (10, y0 + 3 * ROW_H + 3), VW, VH));
        assert_eq!(ide.sel, Some(ObjId(1)));
    }

    #[test]
    fn slider_drag_edits_on_release_only_and_snaps() {
        let scene = fixture();
        let mut ide = Ide::default();
        ide.select(Some(ObjId(1)));
        // rows after the name header: Sub, transform, pos, size, properties, glow
        let row_y = TOPBAR_H + HEAD_H + 1 + ROW_H + 5 * ROW_H + ROW_H / 2;
        let (x0, x1) = (VW - INSP_W + TRACK_X0, VW - INSP_W + TRACK_X1);
        assert!(ide.press(&scene, (x1, row_y), VW, VH), "press on track");
        assert!(ide.dragging());
        ide.drag_to(&scene, (x0 + (x1 - x0) / 2, row_y), VW, VH);
        let e = ide.release(&scene).expect("value moved");
        assert_eq!(e.obj, ObjId(1));
        assert_eq!(e.key, "glow");
        assert_eq!(e.v, PropVal::I(5), "midpoint of 1..8 rounds to 5");
        // a click that lands on the current value emits nothing
        let frac6 = slider_frac(&scene.obj(ObjId(1)).unwrap().props[0].kind, None);
        let x6 = x0 + ((x1 - x0) as f32 * frac6).round() as i32;
        assert!(ide.press(&scene, (x6, row_y), VW, VH));
        assert_eq!(ide.release(&scene), None, "unchanged value is a no-op");
    }

    #[test]
    fn press_on_dead_chrome_consumes_without_selecting() {
        let scene = fixture();
        let mut ide = Ide::default();
        assert!(ide.press(&scene, (VW - 10, TOPBAR_H + HEAD_H + 2), VW, VH), "inspector body consumes");
        assert_eq!(ide.sel, None);
        assert!(!ide.dragging());
        assert!(!ide.press(&scene, (VW / 2, VH / 2), VW, VH), "world click passes through");
    }

    #[test]
    fn wheel_scrolls_only_over_the_hierarchy_and_clamps() {
        let scene = fixture();
        let mut ide = Ide::default();
        assert!(!ide.wheel(&scene, (VW / 2, VH / 2), -1, VW, VH));
        assert!(ide.wheel(&scene, (10, TOPBAR_H + 10), -1, VW, VH));
        // 5 rows all fit in VH: scroll stays clamped at 0
        assert_eq!(ide.scroll, 0);
        // shrink the viewport so only 2 rows fit; scroll can reach rows-2
        for _ in 0..99 {
            ide.wheel(&scene, (10, TOPBAR_H + 10), -1, VW, TOPBAR_H + HEAD_H + 2 + 2 * ROW_H);
        }
        assert_eq!(ide.scroll, 3);
        ide.wheel(&scene, (10, TOPBAR_H + 10), 99, VW, VH);
        assert_eq!(ide.scroll, 0);
    }

    #[test]
    fn frame_renders_three_panels_with_the_layout_rects() {
        let scene = fixture();
        let mut ide = Ide::default();
        ide.select(Some(ObjId(1)));
        let panels = ide.frame(&scene, VW, VH);
        assert_eq!(panels.len(), 3);
        let (bar, hier, insp) = rects(VW, VH);
        for (p, r) in panels.iter().zip([bar, hier, insp]) {
            assert_eq!((p.x, p.y, p.w as i32, p.h as i32), (r.x, r.y, r.w, r.h));
            assert_eq!(p.pix.len(), (p.w * p.h) as usize);
        }
        // determinism: same state renders identical pixels
        let again = ide.frame(&scene, VW, VH);
        for (a, b) in panels.iter().zip(again.iter()) {
            assert_eq!(a.pix, b.pix);
        }
    }
}
