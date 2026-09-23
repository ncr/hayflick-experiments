//! The creative-mode toolbar: one block at the bottom of the screen, city-
//! builder shaped, three rows — what the active tool's mouse buttons do; the
//! CATEGORY tabs (F1..) with undo/redo and the way back to playing; the
//! active category's tools with their hotkeys (1..). That is the whole
//! chrome: the world stays the screen.
//!
//! Categories exist because a flat row stopped fitting: eleven tools do not
//! go across a 1280-px screen at a readable size, and a city builder groups
//! them the same way.
//!
//! Like the rest of this crate it knows nothing about the game: the adapter
//! hands in LABELS and gets back which button was hit. One layout walk
//! ([`layout`]) is shared by draw and hit-test, so the pixels and the clicks
//! cannot disagree.

use crate::canvas::{Canvas, Panel};
use crate::theme::*;

/// What the adapter tells the bar each frame.
pub struct BarModel<'a> {
    /// Category names, left to right; hotkeys F1.. in this order.
    pub groups: &'a [&'a str],
    pub group: usize,
    /// The ACTIVE category's tool labels; hotkeys 1.. in this order.
    pub tools: &'a [&'a str],
    pub active: usize,
    /// The active tool's mouse hint ("drag: build wall   right-drag: remove").
    pub hint: &'a str,
    pub can_undo: bool,
    pub can_redo: bool,
    /// Right-aligned status in the hint line ("wall built", "undone", …).
    pub status: &'a str,
}

/// A button the bar can report.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BarHit {
    Group(usize),
    Tool(usize),
    Undo,
    Redo,
    Play,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    fn contains(&self, p: (i32, i32)) -> bool {
        p.0 >= self.x && p.1 >= self.y && p.0 < self.x + self.w && p.1 < self.y + self.h
    }
}

const BTN_H: i32 = 24;
const HINT_H: i32 = 12;
const GAP: i32 = 3;
/// Bar height: the hint line over the two button rows, with padding.
pub const BAR_H: i32 = HINT_H + 2 * BTN_H + GAP + 2 * PAD;

fn tool_w(label: &str) -> i32 {
    // icon column (12) + label + hotkey column
    12 + Canvas::text_w(label) + 12
}

fn small_w(label: &str) -> i32 {
    Canvas::text_w(label) + 2 * PAD
}

/// The bar's own rect (bottom-centred) and every button in it, in bar px.
pub fn layout(m: &BarModel, vw: i32, vh: i32) -> (Rect, Vec<(Rect, BarHit)>) {
    // row 2: categories left, undo / redo / play right
    let tabs: Vec<(i32, BarHit)> = m.groups.iter().enumerate().map(|(i, g)| (small_w(g), BarHit::Group(i))).collect();
    let acts: Vec<(i32, BarHit)> = vec![(small_w("undo"), BarHit::Undo), (small_w("redo"), BarHit::Redo), (small_w("play"), BarHit::Play)];
    // row 3: the active category's tools
    let tools: Vec<(i32, BarHit)> = m.tools.iter().enumerate().map(|(i, t)| (tool_w(t), BarHit::Tool(i))).collect();
    let span = |row: &[(i32, BarHit)]| row.iter().map(|(w, _)| w + GAP).sum::<i32>() - GAP;
    let row2 = span(&tabs) + 4 * GAP + span(&acts);
    let min_w = Canvas::text_w(m.hint) + Canvas::text_w(m.status) + 4 * PAD;
    let w = (row2.max(span(&tools)) + 2 * PAD).max(min_w).min(vw);
    let bar = Rect { x: (vw - w) / 2, y: vh - BAR_H, w, h: BAR_H };
    let mut out = Vec::new();
    let mut place = |row: &[(i32, BarHit)], mut x: i32, y: i32| {
        for &(bw, hit) in row {
            out.push((Rect { x, y, w: bw, h: BTN_H }, hit));
            x += bw + GAP;
        }
    };
    let y2 = bar.y + PAD + HINT_H;
    place(&tabs, bar.x + PAD, y2);
    place(&acts, bar.x + w - PAD - span(&acts), y2);
    place(&tools, bar.x + PAD, y2 + BTN_H + GAP);
    (bar, out)
}

/// Whether a point is on the bar (the adapter routes it here, not to the
/// world).
pub fn over(m: &BarModel, p: (i32, i32), vw: i32, vh: i32) -> bool {
    layout(m, vw, vh).0.contains(p)
}

/// The button under a point, if any. A disabled undo/redo still reports —
/// the adapter's undo is a no-op on an empty stack, and a click that lands on
/// the bar must never fall through to the world.
pub fn hit(m: &BarModel, p: (i32, i32), vw: i32, vh: i32) -> Option<BarHit> {
    layout(m, vw, vh).1.into_iter().find(|(r, _)| r.contains(p)).map(|(_, h)| h)
}

/// 8x8 tool icons, one row per byte, bit 0 = left (the font8x8 convention).
fn icon(label: &str) -> [u8; 8] {
    match label {
        // a brick wall
        "wall" => [0x00, 0xff, 0x11, 0xff, 0x44, 0xff, 0x11, 0xff],
        // a house: roof and a door
        "building" => [0x18, 0x3c, 0x7e, 0xff, 0x81, 0x99, 0x99, 0xff],
        // a lantern on a post
        "lamp" => [0x3c, 0x7e, 0x7e, 0x3c, 0x18, 0x18, 0x18, 0x3c],
        // a flag
        "spawn" => [0x0e, 0x3e, 0xfe, 0x3e, 0x0e, 0x02, 0x02, 0x02],
        // rain: falling drops
        "rain" => [0x22, 0x22, 0x88, 0x88, 0x22, 0x22, 0x88, 0x88],
        // soot: a flame
        "soot" => [0x08, 0x18, 0x1c, 0x3e, 0x7e, 0x7f, 0x7e, 0x3c],
        // spall: a broken chunk with a crack
        "spall" => [0x7e, 0x43, 0x4d, 0x69, 0x51, 0x4b, 0x62, 0x3e],
        // grass: three blades
        "grass" => [0x00, 0x22, 0x2a, 0x2a, 0xaa, 0xaa, 0xab, 0xff],
        // dry grass: bent straw
        "dry" => [0x00, 0x04, 0x4a, 0x2a, 0x2a, 0xaa, 0xab, 0xff],
        // a tree: crown on a trunk
        "tree" => [0x3c, 0x7e, 0xff, 0x7e, 0x3c, 0x18, 0x18, 0x3c],
        // a bush: a low mound
        "bush" => [0x00, 0x00, 0x00, 0x6c, 0xfe, 0xff, 0xff, 0x52],
        // a window: a frame with a sill
        "window" => [0xff, 0x81, 0x81, 0x81, 0x81, 0x81, 0xff, 0xff],
        // a roof: a slab broken at one end
        "roof" => [0x00, 0x00, 0xff, 0xff, 0x3f, 0x0f, 0x00, 0x00],
        // road: a lane with its centre dashes
        "road" => [0xff, 0x00, 0x00, 0x66, 0x00, 0x00, 0xff, 0x00],
        // sidewalk: pour joints
        "walk" => [0xff, 0x89, 0x89, 0xff, 0x91, 0x91, 0xff, 0x00],
        // soil: clods
        "soil" => [0x00, 0x00, 0x24, 0x00, 0x49, 0x00, 0xb6, 0xff],
        // a pothole: a broken ring
        "hole" => [0x00, 0x3c, 0x42, 0x99, 0x99, 0x42, 0x3c, 0x00],
        // scorch: embers
        "scorch" => [0x10, 0x28, 0x10, 0x44, 0xaa, 0x44, 0xee, 0xff],
        _ => [0; 8],
    }
}

fn draw_icon(c: &mut Canvas, x: i32, y: i32, bits: [u8; 8], col: u32) {
    for (gy, row) in bits.iter().enumerate() {
        for gx in 0..8 {
            if row & (1 << gx) != 0 {
                c.px(x + gx, y + gy as i32, col);
            }
        }
    }
}

/// Rasterize the bar. `hover` is the cursor in bar px (for the hover tint).
pub fn draw(m: &BarModel, vw: i32, vh: i32, hover: (i32, i32)) -> Panel {
    let (bar, items) = layout(m, vw, vh);
    let mut c = Canvas::new(bar.w as u32, bar.h as u32, BG_BAR);
    c.frame(0, 0, bar.w, bar.h, EDGE);
    c.fill(1, 1, bar.w - 2, 1, EDGE_HI);
    c.text(PAD, PAD, m.hint, TEXT, bar.w - 2 * PAD);
    let sw = Canvas::text_w(m.status);
    c.text(bar.w - PAD - sw, PAD, m.status, TEXT_DIM, sw);
    for (r, hit) in items {
        let (x, y) = (r.x - bar.x, r.y - bar.y);
        let active = hit == BarHit::Tool(m.active) || hit == BarHit::Group(m.group);
        let enabled = match hit {
            BarHit::Undo => m.can_undo,
            BarHit::Redo => m.can_redo,
            _ => true,
        };
        let bg = if active {
            SEL_ROW
        } else if r.contains(hover) && enabled {
            HOVER_ROW
        } else {
            BG
        };
        c.fill(x, y, r.w, r.h, bg);
        c.frame(x, y, r.w, r.h, if active { ACCENT } else { EDGE });
        let ty = y + (BTN_H - 8) / 2;
        match hit {
            BarHit::Tool(i) => {
                let label = m.tools[i];
                let col = if active { TEXT_HEAD } else { TEXT };
                draw_icon(&mut c, x + 3, ty, icon(label), if active { ACCENT } else { TEXT_DIM });
                c.text(x + 13, ty, label, col, r.w);
                let key = format!("{}", i + 1);
                c.text(x + r.w - 10, ty, &key, TEXT_DIM, 8);
            }
            BarHit::Group(i) => {
                c.text(x + PAD, ty, m.groups[i], if active { ACCENT } else { TEXT_DIM }, r.w);
            }
            BarHit::Undo | BarHit::Redo | BarHit::Play => {
                let label = match hit {
                    BarHit::Undo => "undo",
                    BarHit::Redo => "redo",
                    _ => "play",
                };
                let col = if !enabled {
                    EDGE_HI
                } else if hit == BarHit::Play {
                    ACCENT
                } else {
                    TEXT
                };
                c.text(x + PAD, ty, label, col, r.w);
            }
        }
    }
    Panel { pix: c.pix, w: bar.w as u32, h: bar.h as u32, x: bar.x, y: bar.y }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model() -> BarModel<'static> {
        BarModel { groups: &["build", "walls", "plants"], group: 0, tools: &["wall", "building", "lamp", "spawn"], active: 1, hint: "drag: building", can_undo: true, can_redo: false, status: "saved" }
    }

    #[test]
    fn every_button_sits_inside_the_bar_and_none_overlap() {
        let m = model();
        let (bar, items) = layout(&m, 640, 400);
        assert_eq!(items.len(), m.groups.len() + m.tools.len() + 3);
        for (i, (r, _)) in items.iter().enumerate() {
            assert!(r.x >= bar.x && r.x + r.w <= bar.x + bar.w, "button {i} inside horizontally");
            assert!(r.y >= bar.y && r.y + r.h <= bar.y + bar.h, "button {i} inside vertically");
            for (s, _) in &items[i + 1..] {
                let apart = r.x + r.w <= s.x || s.x + s.w <= r.x || r.y + r.h <= s.y || s.y + s.h <= r.y;
                assert!(apart, "buttons do not overlap: {r:?} {s:?}");
            }
        }
        assert_eq!(bar.y + bar.h, 400, "the bar sits on the bottom edge");
    }

    #[test]
    fn the_hit_test_names_the_button_the_draw_put_there() {
        let m = model();
        let (_, items) = layout(&m, 640, 400);
        for (r, want) in items {
            let centre = (r.x + r.w / 2, r.y + r.h / 2);
            assert_eq!(hit(&m, centre, 640, 400), Some(want));
            assert!(over(&m, centre, 640, 400));
        }
        assert_eq!(hit(&m, (5, 5), 640, 400), None, "the world is not the bar");
        assert!(!over(&m, (5, 5), 640, 400));
    }

    #[test]
    fn the_widest_category_fits_a_1280_screen_at_2x() {
        let m = BarModel { groups: &["build", "ground", "walls", "plants"], group: 0, tools: &["wall", "building", "window", "roof", "lamp", "spawn"], active: 0, hint: "drag: building   right-drag: demolish", can_undo: true, can_redo: true, status: "building built" };
        let (bar, _) = layout(&m, 640, 400);
        assert!(bar.w < 640, "{} px", bar.w);
    }

    #[test]
    fn the_panel_matches_the_layout_rect() {
        let m = model();
        let (bar, _) = layout(&m, 640, 400);
        let p = draw(&m, 640, 400, (-1, -1));
        assert_eq!((p.x, p.y, p.w as i32, p.h as i32), (bar.x, bar.y, bar.w, bar.h));
        assert_eq!(p.pix.len(), (p.w * p.h) as usize);
    }
}
