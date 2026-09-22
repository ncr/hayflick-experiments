//! The creative-mode toolbar: one strip at the bottom of the screen, city-
//! builder shaped — a button per tool with its hotkey, undo/redo, and the way
//! back to playing. Above it, one line saying what the active tool's mouse
//! buttons do. That is the whole chrome: the world stays the screen.
//!
//! Like the rest of this crate it knows nothing about the game: the adapter
//! hands in tool LABELS and gets back which button was hit. One layout walk
//! ([`layout`]) is shared by draw and hit-test, so the pixels and the clicks
//! cannot disagree.

use crate::canvas::Canvas;
use crate::shell::Panel;
use crate::theme::*;

/// What the adapter tells the bar each frame.
pub struct BarModel<'a> {
    /// Tool labels, left to right; hotkeys are 1.. in this order.
    pub tools: &'a [&'a str],
    pub active: usize,
    /// The active tool's mouse hint ("drag: build wall   right-drag: remove").
    pub hint: &'a str,
    pub can_undo: bool,
    pub can_redo: bool,
    /// Right-aligned status in the hint line ("saved", "unsaved: …").
    pub status: &'a str,
    /// Tool indices that start a new group (a wider gap before them) — the
    /// building tools and the paint brushes read as two sets.
    pub groups: &'a [usize],
}

/// A button the bar can report.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BarHit {
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
/// Bar height: the hint line over the button row, with padding.
pub const BAR_H: i32 = HINT_H + BTN_H + 2 * PAD;

fn btn_w(label: &str) -> i32 {
    // icon column (12) + label + hotkey column
    12 + Canvas::text_w(label) + 12
}

fn small_w(label: &str) -> i32 {
    Canvas::text_w(label) + 2 * PAD
}

/// The bar's own rect (bottom-centred) and every button in it, in IDE px.
pub fn layout(m: &BarModel, vw: i32, vh: i32) -> (Rect, Vec<(Rect, BarHit)>) {
    let mut items: Vec<(i32, BarHit)> = m.tools.iter().enumerate().map(|(i, t)| (btn_w(t), BarHit::Tool(i))).collect();
    items.push((small_w("undo"), BarHit::Undo));
    items.push((small_w("redo"), BarHit::Redo));
    items.push((small_w("play"), BarHit::Play));
    // a wider gap before each tool group, before undo and before play
    let split = |h: BarHit| matches!(h, BarHit::Undo | BarHit::Play) || matches!(h, BarHit::Tool(i) if m.groups.contains(&i));
    let groups = items.iter().filter(|(_, h)| split(*h)).count() as i32 * 2 * GAP;
    let inner: i32 = items.iter().map(|(w, _)| w + GAP).sum::<i32>() - GAP + groups;
    let min_w = Canvas::text_w(m.hint) + Canvas::text_w(m.status) + 4 * PAD;
    let w = (inner + 2 * PAD).max(min_w).min(vw);
    let bar = Rect { x: (vw - w) / 2, y: vh - BAR_H, w, h: BAR_H };
    let mut x = bar.x + (w - inner) / 2;
    let y = bar.y + PAD + HINT_H;
    let mut out = Vec::new();
    for (bw, hit) in items {
        if split(hit) {
            x += 2 * GAP;
        }
        out.push((Rect { x, y, w: bw, h: BTN_H }, hit));
        x += bw + GAP;
    }
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

/// Rasterize the bar. `hover` is the cursor in IDE px (for the hover tint).
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
        let active = hit == BarHit::Tool(m.active);
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
        BarModel { tools: &["wall", "building", "lamp", "spawn"], active: 1, hint: "drag: building", can_undo: true, can_redo: false, status: "saved", groups: &[2] }
    }

    #[test]
    fn every_button_sits_inside_the_bar_and_none_overlap() {
        let m = model();
        let (bar, items) = layout(&m, 640, 400);
        assert_eq!(items.len(), m.tools.len() + 3);
        for (i, (r, _)) in items.iter().enumerate() {
            assert!(r.x >= bar.x && r.x + r.w <= bar.x + bar.w, "button {i} inside horizontally");
            assert!(r.y >= bar.y && r.y + r.h <= bar.y + bar.h, "button {i} inside vertically");
            for (s, _) in &items[i + 1..] {
                assert!(r.x + r.w <= s.x, "buttons do not overlap");
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
    fn the_panel_matches_the_layout_rect() {
        let m = model();
        let (bar, _) = layout(&m, 640, 400);
        let p = draw(&m, 640, 400, (-1, -1));
        assert_eq!((p.x, p.y, p.w as i32, p.h as i32), (bar.x, bar.y, bar.w, bar.h));
        assert_eq!(p.pix.len(), (p.w * p.h) as usize);
    }
}
