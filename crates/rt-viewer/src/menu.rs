//! The in-viewer tune menu (ESC): a hamburger panel drawn with an 8x8 pixel
//! font on the CPU, expanded by an integer UI scale, and copied onto the
//! presented swapchain image after the blit (never onto swap.out — SHOT /
//! MOVIE / DUMP captures stay clean). Values land in the SAME fields the env
//! vars seed, so the renderer picks them up the very next frame; closing the
//! menu prints the matching env string to stdout to lock a look in.

use crate::viewer::Viewer;
use glam::Vec2;

/// One row of the ESC menu. `key` is the tune id; uppercased it is also the
/// env var printed on menu close.
pub enum ItemKind {
    /// continuous value; `step` is also the arrow-key increment
    Slider { min: f32, max: f32, step: f32 },
    Toggle,
    /// start/stop clip recording (also the `r` key) — not a tune value,
    /// excluded from the env string
    Record,
    Quit,
}
pub struct MenuItem {
    pub key: &'static str,
    pub label: &'static str,
    pub kind: ItemKind,
}

pub const MENU: &[MenuItem] = &[
    MenuItem { key: "exposure", label: "exposure", kind: ItemKind::Slider { min: 0.01, max: 4.0, step: 0.01 } },
    MenuItem { key: "lights", label: "room lights", kind: ItemKind::Toggle },
    MenuItem { key: "ao", label: "ao strength", kind: ItemKind::Slider { min: 0.0, max: 1.0, step: 0.05 } },
    MenuItem { key: "ao_r", label: "ao radius", kind: ItemKind::Slider { min: 0.1, max: 3.0, step: 0.05 } },
    MenuItem { key: "ao_n", label: "ao rays", kind: ItemKind::Slider { min: 1.0, max: 32.0, step: 1.0 } },
    MenuItem { key: "sdither", label: "sd strength", kind: ItemKind::Slider { min: 0.0, max: 1.0, step: 0.05 } },
    MenuItem { key: "sdither_n", label: "sd levels", kind: ItemKind::Slider { min: 2.0, max: 48.0, step: 1.0 } },
    MenuItem { key: "sdither_th", label: "sd threshold", kind: ItemKind::Slider { min: 0.0, max: 1.0, step: 0.01 } },
    MenuItem { key: "dither", label: "sd pattern", kind: ItemKind::Slider { min: 1.0, max: 5.0, step: 1.0 } },
    MenuItem { key: "light_anim", label: "light anim", kind: ItemKind::Toggle },
    MenuItem { key: "flash", label: "flashlight", kind: ItemKind::Toggle },
    MenuItem { key: "flash_power", label: "fl power", kind: ItemKind::Slider { min: 0.1, max: 4.0, step: 0.05 } },
    MenuItem { key: "flash_cone", label: "fl cone", kind: ItemKind::Slider { min: 8.0, max: 50.0, step: 1.0 } },
    MenuItem { key: "record", label: "record clip", kind: ItemKind::Record },
    MenuItem { key: "quit", label: "quit viewer", kind: ItemKind::Quit },
];

// menu layout, in LOGICAL pixels (8x8 font units); physical = logical * menu_scale
const MPAD: i32 = 6;
const MROW: i32 = 12;
const MLABEL_X: i32 = 8;
const MTRACK_X: i32 = 110; // label column: 12 chars + gap
const MTRACK_W: i32 = 70;
const MVAL_X: i32 = 186;
pub const MPANEL_W: i32 = 242;
pub const MPANEL_H: i32 = MPAD * 2 + MROW * (MENU.len() as i32 + 2); // title + items + footer
const MICON_W: i32 = 18; // hamburger icon shown when the menu is closed
const MICON_H: i32 = 14;
pub const MENU_MARGIN: i32 = 12; // physical px from the window's top-left

// corner score HUD (player scenes only): a small badge in the TOP-RIGHT,
// drawn like the menu (overlay-only, never onto swap.out — SHOT/MOVIE/DUMP
// captures stay clean), at the same integer UI scale as the menu.
// consumer is the Vulkan backend (its score-overlay staging buffer sizing);
// the score plate itself moved into the burned-in bottom bar (hud.rs)
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub const HUD_W: i32 = 72;
pub const HUD_H: i32 = 14;
/// Tallest plate `score_canvas` can return (arena levels add a weapon row) —
/// sizes the Vulkan staging buffer, which is allocated once per swapchain.
// Its only consumer is the Vulkan backend, which is cfg'd out on macOS.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub const HUD_H_MAX: i32 = HUD_H + 14;

/// Menu interaction state (the tunable values live on `Viewer`).
pub struct MenuState {
    pub open: bool,
    pub sel: usize,
    pub drag: bool,
}

pub(crate) fn mrect(canvas: &mut [u32], cw: i32, x: i32, y: i32, w: i32, h: i32, color: u32) {
    for py in y.max(0)..(y + h).min(canvas.len() as i32 / cw) {
        for px in x.max(0)..(x + w).min(cw) {
            canvas[(py * cw + px) as usize] = color;
        }
    }
}

pub(crate) fn mtext(canvas: &mut [u32], cw: i32, x: i32, y: i32, s: &str, color: u32) {
    let ch_rows = canvas.len() as i32 / cw;
    let mut cx = x;
    for ch in s.chars() {
        let g = font8x8::legacy::BASIC_LEGACY.get(ch as usize).copied().unwrap_or_default();
        for (ry, row) in g.iter().enumerate() {
            for rx in 0..8 {
                if row & (1 << rx) != 0 {
                    let (px, py) = (cx + rx, y + ry as i32);
                    if px >= 0 && py >= 0 && px < cw && py < ch_rows {
                        canvas[(py * cw + px) as usize] = color;
                    }
                }
            }
        }
        cx += 8;
    }
}

/// Slider value as shown in the menu (pattern slider shows names).
fn fmt_val(key: &str, v: f32, step: f32) -> String {
    if key == "dither" {
        return ["off", "bay8", "bay4", "bay2", "ign", "white"].get(v as usize).copied().unwrap_or("?").to_string();
    }
    if step >= 1.0 {
        format!("{v:.0}")
    } else {
        format!("{v:.2}")
    }
}

/// Expand the logical canvas by an integer scale and emit bytes in the
/// swapchain's channel order (rows built once, then repeated).
pub fn expand_canvas(canvas: &[u32], w: i32, h: i32, scale: u32, bgra: bool) -> Vec<u8> {
    let (w, h, scale) = (w as usize, h as usize, scale as usize);
    let sw = w * scale;
    let mut out = vec![0u8; sw * h * scale * 4];
    for y in 0..h {
        let mut row = vec![0u8; sw * 4];
        for x in 0..w {
            let c = canvas[y * w + x];
            let (r, g, b) = ((c >> 16) as u8, (c >> 8) as u8, c as u8);
            let px = if bgra { [b, g, r, 255] } else { [r, g, b, 255] };
            for s in 0..scale {
                row[(x * scale + s) * 4..(x * scale + s) * 4 + 4].copy_from_slice(&px);
            }
        }
        for s in 0..scale {
            let o = (y * scale + s) * sw * 4;
            out[o..o + sw * 4].copy_from_slice(&row);
        }
    }
    out
}

impl Viewer {
    // ---- tune values are read/written through a key so the menu, the env
    // seeding (Config), and the close-time env-string printout stay in sync

    pub fn tune_get(&self, key: &str) -> f32 {
        match key {
            "ao" => self.ao,
            "ao_r" => self.ao_r,
            "ao_n" => self.ao_n as f32,
            "sdither" => self.style.sdither,
            "sdither_n" => self.style.sdither_n,
            "sdither_th" => self.style.sdither_th,
            "dither" => self.style.dither,
            "exposure" => self.exposure,
            "lights" => self.game.sim.res.master_lights as i32 as f32, // sim state
            "light_anim" => self.light_anim as i32 as f32,
            "flash" => self.game.snap.flashlight as i32 as f32, // sim state
            "flash_power" => self.flash_power,
            "flash_cone" => self.flash_cone,
            _ => 0.0,
        }
    }

    pub fn tune_set(&mut self, key: &str, v: f32) {
        match key {
            "ao" => self.ao = v,
            "ao_r" => self.ao_r = v,
            "ao_n" => self.ao_n = v as i32,
            "sdither" => self.style.sdither = v,
            "sdither_n" => self.style.sdither_n = v,
            "sdither_th" => self.style.sdither_th = v,
            "dither" => self.style.dither = v,
            "exposure" => self.exposure = v,
            // the room-lights MASTER is sim state: route as a Command (direct
            // light follows via the emission build, indirect via the probe-
            // bank lerp — same frame, no rebake)
            "lights" => {
                if (v != 0.0) != self.game.sim.res.master_lights {
                    self.game.push(house_game::Command::ToggleRoomLights);
                }
            }
            "light_anim" => self.light_anim = v != 0.0,
            // flashlight is sim state: route the change as a Command (applied
            // next tick; the row reads the snapshot, so it follows)
            "flash" => {
                if (v != 0.0) != self.game.snap.flashlight {
                    self.game.push(house_game::Command::ToggleFlashlight);
                }
            }
            "flash_power" => self.flash_power = v,
            "flash_cone" => self.flash_cone = v,
            _ => {}
        }
    }

    /// The env vars that reproduce the current menu values (printed on close).
    pub fn env_string(&self) -> String {
        MENU.iter()
            .filter(|i| !matches!(i.kind, ItemKind::Quit | ItemKind::Record))
            .map(|i| {
                let v = self.tune_get(i.key);
                let s = match i.kind {
                    ItemKind::Slider { step, .. } if step < 1.0 => format!("{v:.2}"),
                    _ => format!("{v:.0}"),
                };
                format!("{}={}", i.key.to_uppercase(), s)
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    pub fn menu_toggle(&mut self) {
        self.menu.open = !self.menu.open;
        self.menu.drag = false;
        if !self.menu.open {
            println!("tune: {}", self.env_string());
        }
    }

    /// Arrow left/right on the selected row.
    pub fn menu_adjust(&mut self, dir: f32) {
        let item = &MENU[self.menu.sel];
        match item.kind {
            ItemKind::Slider { min, max, step } => {
                let v = self.tune_get(item.key) + dir * step;
                let v = min + ((v - min) / step).round() * step;
                self.tune_set(item.key, v.clamp(min, max));
            }
            ItemKind::Toggle => self.menu_activate(),
            ItemKind::Record | ItemKind::Quit => {}
        }
    }

    /// Enter/space/click on the selected row.
    pub fn menu_activate(&mut self) {
        let item = &MENU[self.menu.sel];
        match item.kind {
            ItemKind::Toggle => {
                let v = self.tune_get(item.key);
                self.tune_set(item.key, if v != 0.0 { 0.0 } else { 1.0 });
            }
            ItemKind::Record => self.toggle_recording(),
            ItemKind::Quit => self.exit_requested = true,
            ItemKind::Slider { .. } => {}
        }
    }

    /// UI scale of the current swapchain (panel physical px = logical * scale).
    fn menu_ui_scale(&self) -> f32 {
        self.backend.menu_scale() as f32
    }

    /// Left-press routing. Returns true when the menu consumed the click.
    pub fn menu_click(&mut self, p: Vec2) -> bool {
        let ms = self.menu_ui_scale();
        let org = Vec2::splat(MENU_MARGIN as f32);
        if !self.menu.open {
            // hamburger icon
            if p.x >= org.x && p.y >= org.y && p.x < org.x + MICON_W as f32 * ms && p.y < org.y + MICON_H as f32 * ms {
                self.menu_toggle();
                return true;
            }
            return false;
        }
        let l = (p - org) / ms;
        if l.x < 0.0 || l.y < 0.0 || l.x >= MPANEL_W as f32 || l.y >= MPANEL_H as f32 {
            return false; // outside the open panel: fall through to player drag
        }
        let row = (l.y as i32 - MPAD) / MROW - 1; // row 0 is the title
        if row >= 0 && (row as usize) < MENU.len() {
            self.menu.sel = row as usize;
            if matches!(MENU[self.menu.sel].kind, ItemKind::Slider { .. }) {
                self.menu.drag = true;
                self.menu_drag_to(p);
            } else {
                self.menu_activate();
            }
        }
        true
    }

    /// Slider drag: set the selected value from the cursor's track position.
    pub fn menu_drag_to(&mut self, p: Vec2) {
        let ms = self.menu_ui_scale();
        let lx = (p.x - MENU_MARGIN as f32) / ms;
        if let ItemKind::Slider { min, max, step } = MENU[self.menu.sel].kind {
            let t = ((lx - MTRACK_X as f32) / MTRACK_W as f32).clamp(0.0, 1.0);
            let v = min + ((t * (max - min)) / step).round() * step;
            self.tune_set(MENU[self.menu.sel].key, v.clamp(min, max));
        }
    }

    /// Draw the overlay at logical resolution: the open panel, or the
    /// hamburger icon when closed.
    pub fn menu_canvas(&self) -> (Vec<u32>, i32, i32) {
        const BG: u32 = 0x16161c;
        const BORDER: u32 = 0x6a6a78;
        const TEXT: u32 = 0xc8c8d0;
        if !self.menu.open {
            // hamburger icon; while recording, a REC badge rides next to it
            // (the badge is overlay-only — clips capture swap.out, never UI)
            let w = if self.rec.is_some() { MICON_W + 78 } else { MICON_W };
            let h = MICON_H;
            let mut c = vec![BG; (w * h) as usize];
            mrect(&mut c, w, 0, 0, w, 1, BORDER);
            mrect(&mut c, w, 0, h - 1, w, 1, BORDER);
            mrect(&mut c, w, 0, 0, 1, h, BORDER);
            mrect(&mut c, w, w - 1, 0, 1, h, BORDER);
            for k in 0..3 {
                mrect(&mut c, w, 4, 3 + k * 3, MICON_W - 8, 1, TEXT);
            }
            if let Some(rec) = &self.rec {
                mrect(&mut c, w, MICON_W + 3, 4, 6, 6, 0xdd4444);
                let secs = rec.frames.len() as f32 / rec.fps as f32;
                mtext(&mut c, w, MICON_W + 12, 3, &format!("{secs:5.1}s"), 0xdd8888);
            }
            return (c, w, h);
        }
        let (w, h) = (MPANEL_W, MPANEL_H);
        let mut c = vec![BG; (w * h) as usize];
        mrect(&mut c, w, 0, 0, w, 1, BORDER);
        mrect(&mut c, w, 0, h - 1, w, 1, BORDER);
        mrect(&mut c, w, 0, 0, 1, h, BORDER);
        mrect(&mut c, w, w - 1, 0, 1, h, BORDER);
        mtext(&mut c, w, MLABEL_X, MPAD + 2, "rt-probe tune", 0xaaccaa);
        for (i, item) in MENU.iter().enumerate() {
            let y = MPAD + MROW * (1 + i as i32);
            if i == self.menu.sel {
                mrect(&mut c, w, 2, y, w - 4, MROW, 0x24242e);
            }
            let label_c = match item.kind {
                ItemKind::Quit => 0xcc8888,
                _ if i == self.menu.sel => 0xe8e8f0,
                _ => TEXT,
            };
            mtext(&mut c, w, MLABEL_X, y + 2, item.label, label_c);
            match item.kind {
                ItemKind::Slider { min, max, step } => {
                    let v = self.tune_get(item.key);
                    let t = ((v - min) / (max - min)).clamp(0.0, 1.0);
                    mrect(&mut c, w, MTRACK_X, y + MROW / 2, MTRACK_W, 2, 0x34343c);
                    mrect(&mut c, w, MTRACK_X, y + MROW / 2, (MTRACK_W as f32 * t) as i32, 2, 0x7aa86a);
                    let kx = MTRACK_X + (t * (MTRACK_W - 2) as f32) as i32;
                    mrect(&mut c, w, kx, y + 2, 2, MROW - 4, 0xd8e8c8);
                    mtext(&mut c, w, MVAL_X, y + 2, &fmt_val(item.key, v, step), 0x99cc99);
                }
                ItemKind::Toggle => {
                    let on = self.tune_get(item.key) != 0.0;
                    mtext(&mut c, w, MTRACK_X, y + 2, if on { "[on]" } else { "[off]" }, if on { 0x99cc99 } else { 0x808088 });
                }
                ItemKind::Record => match &self.rec {
                    Some(rec) => {
                        mrect(&mut c, w, MTRACK_X, y + 3, 6, 6, 0xdd4444);
                        let secs = rec.frames.len() as f32 / rec.fps as f32;
                        mtext(&mut c, w, MTRACK_X + 10, y + 2, &format!("stop {secs:.1}s"), 0xdd8888);
                    }
                    None => mtext(&mut c, w, MTRACK_X, y + 2, "[r] mp4+gif", 0x808088),
                },
                ItemKind::Quit => {}
            }
        }
        let fy = MPAD + MROW * (1 + MENU.len() as i32) + 2;
        mtext(&mut c, w, MLABEL_X, fy, "esc close+log  arrows/drag", 0x707078);
        (c, w, h)
    }
}
