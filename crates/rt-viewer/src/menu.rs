//! The in-viewer menus, drawn with an 8x8 pixel font on the CPU, expanded by
//! an integer UI scale, and copied onto the presented swapchain image after
//! the blit (never onto swap.out — SHOT / MOVIE / DUMP captures stay clean).
//!
//! Two families share the machinery:
//! - GAME menus (windowed): a centered TITLE screen at boot (START /
//!   SETTINGS / QUIT) and an ESC PAUSE menu (RESUME / RESTART / SETTINGS /
//!   QUIT). While either is open the sim clock is stopped dead. This is the
//!   owner's playtest hub (docs/VISION.md): every variant he compares must
//!   be reachable from here, never via CLI.
//! - SETTINGS: the render-tune panel (sliders + toggles + record), a
//!   submenu that returns to the game menu it came from. Values land in
//!   the SAME fields the env vars seed; leaving settings prints the env
//!   string to stdout to lock a look in.

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
    // look row (menu-first rule, docs/VISION.md): the voxel-physics-spike
    // DUSK sibling brought LOOKS back to >1, so the owner-facing choice
    // returns. Index into look::LOOKS; `max` must stay LOOKS.len() - 1
    // (pinned by the test below). Switching rebuilds the scene + probe banks
    // (blocking, disk-cached per look) via Viewer::apply_look.
    MenuItem { key: "look", label: "look", kind: ItemKind::Slider { min: 0.0, max: 2.0, step: 1.0 } },
    // projection-as-data (Faza 1a): the preset index in iso_core::presets();
    // `max` must stay presets().len() - 1 (pinned by the test below)
    MenuItem { key: "proj", label: "projection", kind: ItemKind::Slider { min: 0.0, max: 1.0, step: 1.0 } },
    MenuItem { key: "exposure", label: "exposure", kind: ItemKind::Slider { min: 0.01, max: 4.0, step: 0.01 } },
    MenuItem { key: "fog", label: "air density", kind: ItemKind::Slider { min: 0.0, max: 0.08, step: 0.002 } },
    MenuItem { key: "fog_h", label: "haze height", kind: ItemKind::Slider { min: 0.2, max: 5.0, step: 0.1 } },
    MenuItem { key: "grain", label: "film grain", kind: ItemKind::Slider { min: 0.0, max: 0.15, step: 0.005 } },
    MenuItem { key: "lights", label: "lamps", kind: ItemKind::Toggle },
    MenuItem { key: "ao", label: "ao strength", kind: ItemKind::Slider { min: 0.0, max: 1.0, step: 0.05 } },
    MenuItem { key: "ao_r", label: "ao radius", kind: ItemKind::Slider { min: 0.1, max: 3.0, step: 0.05 } },
    MenuItem { key: "ao_n", label: "ao rays", kind: ItemKind::Slider { min: 1.0, max: 32.0, step: 1.0 } },
    MenuItem { key: "sdither", label: "sd strength", kind: ItemKind::Slider { min: 0.0, max: 1.0, step: 0.05 } },
    MenuItem { key: "sdither_n", label: "sd levels", kind: ItemKind::Slider { min: 2.0, max: 48.0, step: 1.0 } },
    MenuItem { key: "sdither_th", label: "sd threshold", kind: ItemKind::Slider { min: 0.0, max: 1.0, step: 0.01 } },
    MenuItem { key: "dither", label: "sd pattern", kind: ItemKind::Slider { min: 1.0, max: 5.0, step: 1.0 } },
    // Owner 2026-09-05: antialiasing and contour softening are disabled.
    // ---- THE LEVEL'S WEAR, three rows (2026-07-26). The per-wall panel says
    // what ONE wall is; these say what the whole level is, which is the question
    // the owner actually asks while walking around it. All three are geometry, so
    // they land on the mouse RELEASE like the panel's rows do.
    //
    // A MASTER on the level's authored story. 1 = as authored, 0 = the plain
    // greybox — so "show me this level clean" is one row and not fifteen, and
    // every A/B of the whole wear family has a before side reachable from a menu.
    MenuItem { key: "wear_master", label: "wear", kind: ItemKind::Slider { min: 0.0, max: 1.0, step: 0.05 } },
    // SOLO one layer: pin the other four to zero on every wall. The effect
    // catalogue answers "what does each of these look like" on fifteen identical
    // slabs; this answers it on the level the owner is standing in, which is
    // where a layer's read against real geometry actually gets decided.
    MenuItem { key: "wear_solo", label: "solo layer", kind: ItemKind::Slider { min: 0.0, max: crate::wall::Layer::N as f32, step: 1.0 } },
    // SURFACE GRAIN on every wall at once — plate size in world units, the one
    // shape dial that is a length (`wall::Shape::grain`). Below `GRAIN_OFF` the
    // veneer is off entirely, so the bottom of this row is "no plates anywhere".
    MenuItem { key: "wear_grain", label: "surface grain", kind: ItemKind::Slider { min: 0.0, max: 1.0, step: 0.02 } },
    // GLAZE EASE (owner catalogue 2026-07-25): the chamfer on every exposed
    MenuItem { key: "light_anim", label: "light anim", kind: ItemKind::Toggle },
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
pub const MENU_MARGIN: i32 = 12; // physical px from the window's top-left

/// Game-menu panel height for `items` rows (title band + rows + footer).
pub(crate) const fn gpanel_h(items: usize) -> i32 {
    GPAD * 2 + GROW * (1 + items as i32) + 12
}

/// LEVELS panel height: a game menu plus the blurb band for the selected demo.
/// Shared by the draw and the click hit-test so rows line up.
pub(crate) const fn lpanel_h(items: usize) -> i32 {
    gpanel_h(items) + LBLURB_H
}
/// Blurb lines the band shows. THREE since 2026-07-25: the blurb is the owner's
/// only description of a demo, and the crack lab now has three things to say
/// (what he is looking at, that one wall is the untouched control, and that
/// clicking a wall opens the knobs). `levels_blurb_fits_the_band` fails if any
/// demo's blurb wraps past this — the band used to truncate in silence.
pub(crate) const LBLURB_LINES: usize = 3;
pub(crate) const LBLURB_COLS: usize = 28; // 8 px/char against GPANEL_W
const LBLURB_H: i32 = 4 + 9 * LBLURB_LINES as i32; // 8px lines on a 9px pitch + air
// The centered panels share the settings staging buffer (MPANEL_W × MPANEL_H);
// keep the LEVELS list short enough to fit (compile guard, generous bound).
const _: () = assert!(lpanel_h(crate::demos::DEMOS.len()) <= MPANEL_H);

// Every centered game panel shares the settings panel's staging buffer
// (Vulkan menu_buf is MPANEL_W × MPANEL_H): the tallest must fit, or the
// copy overruns. Compile-time, so a grown menu fails the build, not the GPU.
const _: () = assert!(gpanel_h(PAUSE_MENU.len()) <= MPANEL_H);

/// Which menu is on screen. `Title` and `Pause` are the GAME menus (centered
/// panel, sim paused); `Settings` is the tune panel (top-left).
#[derive(Clone, Copy, PartialEq)]
pub enum MenuMode {
    Closed,
    Title,
    Pause,
    Settings,
    /// The LEVELS list: named demos (`demos::DEMOS`) the owner picks to boot
    /// (owner directive 2026-07-16). Centered panel like the game menus.
    Levels,
}

/// One row of a game menu.
#[derive(Clone, Copy)]
pub enum GameAction {
    Start,
    Resume,
    Restart,
    Levels,
    Settings,
    Quit,
}
pub const TITLE_MENU: &[(&str, GameAction)] = &[("start", GameAction::Start), ("levels", GameAction::Levels), ("settings", GameAction::Settings), ("quit", GameAction::Quit)];
pub const PAUSE_MENU: &[(&str, GameAction)] = &[("resume", GameAction::Resume), ("restart", GameAction::Restart), ("levels", GameAction::Levels), ("settings", GameAction::Settings), ("quit", GameAction::Quit)];

// game-menu panel layout (logical px; physical = logical * menu_scale)
const GROW: i32 = 16; // taller rows than the tune panel
const GPAD: i32 = 10;
pub const GPANEL_W: i32 = MPANEL_W; // shares the settings panel's staging buffer

/// Menu interaction state (the tunable values live on `Viewer`).
pub struct MenuState {
    pub mode: MenuMode,
    /// Where Settings returns on ESC/back: the game menu it was opened from,
    /// or Closed on dev scenes (ESC opens Settings directly there).
    pub back: MenuMode,
    pub sel: usize,
    pub drag: bool,
    /// Cursor moved since the drag was last APPLIED. Motion events are
    /// coalesced to one `menu_drag_to` per FRAME (main.rs): a wall-panel drag
    /// recompiles the level and re-streams materials, and a gaming mouse
    /// delivers ~1000 motion events a second — applying per EVENT built a
    /// backlog the frame loop could never drain, which read as "the mouse is
    /// almost unresponsive" (owner, 2026-07-27). Only the cursor's LATEST
    /// position matters to a slider; the ones in between were pure waste.
    pub drag_pending: bool,
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

/// Render the LEVELS picker panel: title band, one row per demo (selected
/// highlighted, outdated greyed + tagged), and a wrapped blurb band for the
/// selected demo. Pure fn of the selection + `demos::DEMOS`, so it draws
/// headless (the test dumps it; the live overlay calls it from `menu_canvas`).
pub(crate) fn levels_canvas(sel: usize) -> (Vec<u32>, i32, i32) {
    const BORDER: u32 = 0x6a6a78;
    const TEXT: u32 = 0xc8c8d0;
    let demos = crate::demos::DEMOS;
    let (w, h) = (GPANEL_W, lpanel_h(demos.len()));
    let mut c = vec![0x101018u32; (w * h) as usize];
    mrect(&mut c, w, 0, 0, w, 1, BORDER);
    mrect(&mut c, w, 0, h - 1, w, 1, BORDER);
    mrect(&mut c, w, 0, 0, 1, h, BORDER);
    mrect(&mut c, w, w - 1, 0, 1, h, BORDER);
    mrect(&mut c, w, 2, 2, w - 4, 1, 0x8a6a2a);
    let title = "L E V E L S";
    mtext(&mut c, w, (w - title.len() as i32 * 8) / 2, GPAD + 2, title, 0xe8b84a);
    for (i, demo) in demos.iter().enumerate() {
        let y = GPAD + GROW * (1 + i as i32);
        let is_sel = i == sel;
        if is_sel {
            mrect(&mut c, w, 6, y, w - 12, GROW - 2, 0x2a2a1e);
        }
        let name = if demo.outdated { format!("{} (outdated)", demo.name) } else { demo.name.to_string() };
        let text = if is_sel { format!("> {name} <") } else { name };
        let color = if demo.outdated { 0x707078 } else if is_sel { 0xf0e8c8 } else { TEXT };
        mtext(&mut c, w, (w - text.len() as i32 * 8) / 2, y + 3, &text, color);
    }
    // blurb band: the selected demo's description, wrapped to the panel width
    let by = GPAD + GROW * (1 + demos.len() as i32) + 2;
    let blurb = demos.get(sel).map(|d| d.blurb).unwrap_or("");
    for (li, line) in wrap_text(blurb, LBLURB_COLS).into_iter().take(LBLURB_LINES).enumerate() {
        let lx = (w - line.len() as i32 * 8) / 2;
        mtext(&mut c, w, lx.max(2), by + li as i32 * 9, &line, 0x9a9aa8);
    }
    (c, w, h)
}

/// Greedy word-wrap to `cols` characters per line (the menu font is fixed
/// 8px/char, so columns == pixels/8). Used for the LEVELS blurb band.
fn wrap_text(s: &str, cols: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let mut line = String::new();
    for word in s.split_whitespace() {
        if line.is_empty() {
            line = word.to_string();
        } else if line.len() + 1 + word.len() <= cols {
            line.push(' ');
            line.push_str(word);
        } else {
            lines.push(std::mem::take(&mut line));
            line = word.to_string();
        }
    }
    if !line.is_empty() {
        lines.push(line);
    }
    lines
}

/// ONE AUTHORING ROW of a wall. The layout is a `Vec<Row>` derived from the
/// wall's own spec ([`rows_of`]), and every consumer walks that same list, so
/// they cannot disagree about which row is which — and the list changes shape
/// with the pattern (each one has a different number of native params) without
/// separate places needing to agree on the arithmetic.
///
/// Born as the wall panel's layout; the panel is DELETED (2026-07-27 — the
/// IDE inspector is the walls' property surface) and this survives as the ONE
/// spelling of "what a wall exposes": `ide_host::wear_props` maps it to
/// inspector rows and [`Viewer::wear_set_row`] writes by it.
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Row {
    /// One of the three CAUSES — what happened to this wall.
    Cause(usize),
    /// One LAYER's amount. Shows what `wall::derive` produced, with a `*` when
    /// it is PINNED; dragging it pins it, which is how a bench wall asks for one
    /// effect and nothing else.
    Layer(crate::wall::Layer),
    /// MUD's native param: its splash band's top edge. Indented under the mud
    /// layer row like a pattern param under its pattern.
    MudTop,
    /// The break COUNT — a count, drawn as a count and stepped by clicking.
    Breaks,
    /// SHELL place-mode: clicking this row arms it, and the next click on the
    /// wall itself places an artillery hit at the ray's own point (or removes
    /// the hit it landed on). A count is drawn, but the ROW is a mode toggle —
    /// the places live on the wall, where they belong, not on a slider.
    Shell,
    /// The shells' shared crater radius, world units — indented under the
    /// shell row like mud's top under the mud row.
    Caliber,
    /// The VARIANT dial: slides the story key through noise space
    /// (`wall::scrub_key`), re-rolling paint, plates and breaks together —
    /// the author's "move the damage until it sits right".
    Scrub,
    /// The BAND's two edges — "the damage shows HERE": one authored region
    /// that the painted gates, the plates and the crater sites all obey
    /// (`wall::banded` enters the field itself).
    BandLo,
    BandHi,
    Grain,
    Relief,
    /// The small-crack pattern: a cycler.
    Pattern,
    /// The active pattern's `j`-th native param.
    Param(usize),
}

/// The rows for one wall, in order: what HAPPENED to it, what that came to, then
/// what SHAPE it takes. Causes first because that is the order an author thinks
/// in, and the layer rows under them are the DERIVED column — so the sheet is a
/// complete explanation of the wall rather than a pile of dials.
pub(crate) fn rows_of(spec: &crate::wall::WallSpec) -> Vec<Row> {
    let mut v: Vec<Row> = (0..3).map(Row::Cause).collect();
    v.extend(crate::wall::Layer::ALL.into_iter().map(Row::Layer));
    v.push(Row::MudTop); // right under the mud layer row it belongs to
    v.push(Row::Breaks);
    v.push(Row::Shell);
    v.push(Row::Caliber);
    v.push(Row::Scrub);
    v.push(Row::BandLo);
    v.push(Row::BandHi);
    v.push(Row::Grain);
    v.push(Row::Relief);
    v.push(Row::Pattern);
    let np = crate::crack_geom::POLICY_PARAMS[spec.shape.pattern.code() as usize % crate::crack_geom::NPOL].len();
    v.extend((0..np).map(Row::Param));
    v
}

/// The tallest overlay canvas any panel can produce, sizing the shared
/// staging buffer (Vulkan `menu_buf`; Metal sizes its blit per canvas). The
/// wall panel that once outgrew the settings menu is DELETED (2026-07-27 —
/// the IDE inspector is the walls' property surface, and IDE panels ride the
/// Stamp path, not this buffer), so the settings sheet is the ceiling again.
pub const PANEL_MAX_H: i32 = MPANEL_H;

/// Slider value as shown in the menu (pattern/preset sliders show names).
fn fmt_val(key: &str, v: f32, step: f32) -> String {
    if key == "look" {
        return crate::look::LOOKS.get(v as usize).map(|l| l.name).unwrap_or("?").to_string();
    }
    if key == "dither" {
        return ["off", "bay8", "bay4", "bay2", "ign", "white"].get(v as usize).copied().unwrap_or("?").to_string();
    }
    if key == "proj" {
        return iso_core::presets().get(v as usize).map(|p| p.name).unwrap_or("?").to_string();
    }
    if step >= 1.0 {
        format!("{v:.0}")
    } else if step < 0.01 {
        format!("{v:.3}")
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
            "look" => crate::look::LOOKS.iter().position(|l| std::ptr::eq(*l, self.look)).unwrap_or(0) as f32,
            "proj" => iso_core::presets().iter().position(|p| p.name == self.proj.name).unwrap_or(0) as f32,
            "ao" => self.ao,
            "ao_r" => self.ao_r,
            "ao_n" => self.ao_n as f32,
            "sdither" => self.style.sdither,
            "sdither_n" => self.style.sdither_n,
            "sdither_th" => self.style.sdither_th,
            "dither" => self.style.dither,
            "aa" => self.aa,
            "aa_scope" => self.aa_scope,
            "aa_soft" => self.style.aa_soft,
            "aa_chunky" => self.aa_chunky,
            "wear_master" => self.crack.master,
            "wear_solo" => self.crack.solo as f32,
            "wear_grain" => self.crack.grain,
            "exposure" => self.exposure,
            "fog" => self.cfg.render.fog.unwrap_or(self.look.lighting[2]),
            "fog_h" => self.cfg.render.fog_h.unwrap_or(self.look.lighting[3]),
            "grain" => self.style.grain,
            "lights" => (self.lights_dim > 0.0) as i32 as f32,
            "light_anim" => self.light_anim as i32 as f32,
            _ => 0.0,
        }
    }

    pub fn tune_set(&mut self, key: &str, v: f32) {
        match key {
            // switching the look rebuilds the scene + probe banks (blocking;
            // disk-cached per look) — the sim keeps running where it stood.
            // apply_look guards on ptr::eq so re-selecting the current look
            // is a no-op (unlike the LOOK_SWITCH harness knob's forced rebuild)
            "look" => {
                if let Some(l) = crate::look::LOOKS.get(v as usize) {
                    if !std::ptr::eq(*l, self.look) {
                        self.apply_look(l);
                    }
                }
            }
            // switching the projection re-derives the whole camera from the
            // preset's data; the look-at target must land on the NEW preset's
            // pixel lattice or the first frame renders off-grid
            "proj" => {
                if let Some(p) = iso_core::presets().get(v as usize) {
                    if self.proj != *p {
                        self.proj = *p;
                        self.gym.set_projection(*p);
                        self.view.move_accum = glam::Vec2::ZERO;
                        self.snap_target_to_lattice();
                    }
                }
            }
            "ao" => self.ao = v,
            "ao_r" => self.ao_r = v,
            "ao_n" => self.ao_n = v as i32,
            "sdither" => self.style.sdither = v,
            "sdither_n" => self.style.sdither_n = v,
            "sdither_th" => self.style.sdither_th = v,
            "dither" => self.style.dither = v,
            "aa" => self.aa = v,
            // the scope drives per-material opt-in bits: re-stamp them now, so
            // the change lands next frame without a rebuild
            "aa_scope" => {
                self.aa_scope = v;
                self.aa_stamp();
            }
            "aa_soft" => self.style.aa_soft = v,
            "aa_chunky" => {
                self.aa_chunky = v;
                self.aa_stamp();
            }
            // The three LEVEL-wide wear rows. Each rewrites every run's spec
            // through `wear_level_apply` and re-streams the paint; the geometry
            // waits for the release, exactly like the panel's own rows.
            "wear_master" => {
                self.crack.master = v;
                self.wear_level_apply();
            }
            "wear_solo" => {
                self.crack.solo = v.round() as usize;
                self.wear_level_apply();
            }
            "wear_grain" => {
                self.crack.grain = v;
                self.wear_level_apply();
            }
            // The glaze ease is real geometry over the WHOLE level (every box
            // moved a little, so there is no local-refresh set to hand it) —
            // 3-5 s of full rebake per step. `menu_drag_to` fires on every
            // CursorMoved, so rebuilding here froze the window for 8-20 s on a
            // single drag: the dial takes the value now and the rebuild waits
            // for the mouse RELEASE, exactly like the crack knobs
            // (`crack_release`). Keyboard steps release immediately.
            "exposure" => self.exposure = v,
            "fog" => self.cfg.render.fog = Some(v.clamp(0.0, 0.08)),
            "fog_h" => self.cfg.render.fog_h = Some(v.clamp(0.2, 5.0)),
            "grain" => self.style.grain = v.clamp(0.0, 0.15),
            // the lamp master is a presentation dim (direct via the emission
            // build, indirect via the probe-bank lerp — same frame, no rebake)
            "lights" => self.lights_dim = if v != 0.0 { 1.0 } else { 0.0 },
            "light_anim" => self.light_anim = v != 0.0,
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
                    ItemKind::Slider { step, .. } if step < 0.01 => format!("{v:.3}"),
                    ItemKind::Slider { step, .. } if step < 1.0 => format!("{v:.2}"),
                    _ => format!("{v:.0}"),
                };
                format!("{}={}", i.key.to_uppercase(), s)
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// Any menu on screen (captures arrows/enter; game menus also pause).
    pub fn menu_open(&self) -> bool {
        self.menu.mode != MenuMode::Closed
    }

    /// Rows of the menu currently on screen (keyboard nav wraps on this).
    pub fn menu_len(&self) -> usize {
        match self.menu.mode {
            MenuMode::Title => TITLE_MENU.len(),
            MenuMode::Pause => PAUSE_MENU.len(),
            MenuMode::Levels => crate::demos::DEMOS.len(),
            _ => MENU.len(),
        }
    }

    fn menu_set(&mut self, mode: MenuMode) {
        self.clear_live_input();
        self.menu.mode = mode;
        self.menu.sel = 0;
        self.menu.drag = false;
    }

    /// ESC. Closed → PAUSE. Settings → back where it came from (printing the
    /// env string that reproduces the dialed-in look). Title stays — the
    /// game hasn't started, there is nothing to close onto.
    pub fn menu_toggle(&mut self) {
        match self.menu.mode {
            MenuMode::Closed => self.menu_set(MenuMode::Pause),
            MenuMode::Pause => self.menu_set(MenuMode::Closed),
            MenuMode::Title => {}
            // Levels/Settings are submenus: ESC returns to the game menu they
            // were opened from (Settings also logs the dialed-in env string).
            MenuMode::Levels => {
                let back = self.menu.back;
                self.menu_set(back);
            }
            MenuMode::Settings => {
                println!("tune: {}", self.env_string());
                let back = self.menu.back;
                self.menu_set(back);
            }
        }
        self.ui_blip("menu_move");
    }

    /// Arrow left/right on the selected row (settings sliders only).
    pub fn menu_adjust(&mut self, dir: f32) {
        if self.menu.mode != MenuMode::Settings {
            return;
        }
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
        match self.menu.mode {
            MenuMode::Title | MenuMode::Pause => {
                let items = if self.menu.mode == MenuMode::Title { TITLE_MENU } else { PAUSE_MENU };
                let (_, action) = items[self.menu.sel.min(items.len() - 1)];
                self.ui_blip("menu_pick");
                match action {
                    GameAction::Start | GameAction::Resume => self.menu_set(MenuMode::Closed),
                    GameAction::Restart => {
                        self.restart_gym();
                        self.menu_set(MenuMode::Closed);
                    }
                    GameAction::Levels => {
                        let from = self.menu.mode;
                        self.menu_set(MenuMode::Levels);
                        self.menu.back = from;
                    }
                    GameAction::Settings => {
                        let from = self.menu.mode;
                        self.menu_set(MenuMode::Settings);
                        self.menu.back = from;
                    }
                    GameAction::Quit => self.exit_requested = true,
                }
            }
            MenuMode::Levels => {
                let demos = crate::demos::DEMOS;
                let demo = &demos[self.menu.sel.min(demos.len() - 1)];
                self.ui_blip("menu_pick");
                self.boot_demo(demo); // blocking scene + probe rebuild
                self.menu_set(MenuMode::Closed);
            }
            MenuMode::Settings => {
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
            MenuMode::Closed => {}
        }
    }

    /// UI scale of the current swapchain (panel physical px = logical * scale).
    fn menu_ui_scale(&self) -> f32 {
        self.backend.menu_scale() as f32
    }

    /// Top-left window px of the on-screen panel: game menus are centered,
    /// the settings/wall panels sit at the top-left margin.
    fn menu_origin(&self, pw: i32, ph: i32) -> Vec2 {
        match self.menu.mode {
            MenuMode::Title | MenuMode::Pause | MenuMode::Levels => {
                let ms = self.menu_ui_scale();
                let (ew, eh) = self.backend.extent();
                Vec2::new((ew as f32 - pw as f32 * ms) * 0.5, (eh as f32 - ph as f32 * ms) * 0.5)
            }
            _ => Vec2::splat(MENU_MARGIN as f32),
        }
    }

    /// Left-press routing. Returns true when the menu consumed the click.
    pub fn menu_click(&mut self, p: Vec2) -> bool {
        let ms = self.menu_ui_scale();
        match self.menu.mode {
            // a closed menu owns nothing: the hamburger is gone (owner
            // 2026-07-27) and so is the wall panel (same day — the IDE
            // inspector is the walls' property surface)
            MenuMode::Closed => false,
            MenuMode::Title | MenuMode::Pause | MenuMode::Levels => {
                let n = self.menu_len();
                let ph = if self.menu.mode == MenuMode::Levels { lpanel_h(n) } else { gpanel_h(n) };
                let (pw, ph) = (GPANEL_W, ph);
                let org = self.menu_origin(pw, ph);
                let l = (p - org) / ms;
                if l.x < 0.0 || l.y < 0.0 || l.x >= pw as f32 || l.y >= ph as f32 {
                    return true; // a game menu is MODAL: clicks outside do nothing
                }
                // first GROW is the title band (guard BEFORE dividing —
                // -6/16 truncates to 0 and would select the first row)
                let dy = l.y as i32 - GPAD - GROW;
                if dy >= 0 && ((dy / GROW) as usize) < n {
                    self.menu.sel = (dy / GROW) as usize;
                    self.menu_activate();
                }
                true
            }
            MenuMode::Settings => {
                let org = Vec2::splat(MENU_MARGIN as f32);
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
        }
    }

    /// Slider drag: set the selected value from the cursor's track position
    /// (Settings only — the wall panel that once took the closed-menu drag is
    /// gone; wall drags live in the IDE inspector).
    pub fn menu_drag_to(&mut self, p: Vec2) {
        if self.menu.mode != MenuMode::Settings {
            return;
        }
        let ms = self.menu_ui_scale();
        let lx = (p.x - MENU_MARGIN as f32) / ms;
        if let ItemKind::Slider { min, max, step } = MENU[self.menu.sel].kind {
            let t = ((lx - MTRACK_X as f32) / MTRACK_W as f32).clamp(0.0, 1.0);
            let v = min + ((t * (max - min)) / step).round() * step;
            self.tune_set(MENU[self.menu.sel].key, v.clamp(min, max));
        }
    }

    /// Write ONE wear row's value on run `r` — the rows discipline extended to
    /// the value write: this match is the only spelling of "which spec field a
    /// row means", written for the wall panel's drag and surviving it (the
    /// panel is gone; the IDE inspector's sliders are the caller now, via
    /// `Viewer::ide_wear_apply`). Values arrive on the `k / 50` grid — the
    /// snap lives in `ide::slider_value`, which owns the wear-file lesson.
    pub fn wear_set_row(&mut self, r: usize, kind: Row, v: f32) {
        // a CAUSE edit on the beat's ramped run takes the wall over: the
        // override would mask the slider and the drag would read dead
        if matches!(kind, Row::Cause(_)) && self.crack.beat.is_some_and(|(br, _)| br == r) {
            self.crack.beat = None;
        }
        match kind {
            Row::Cause(0) => self.crack.spec[r].story.weather = v,
            Row::Cause(1) => self.crack.spec[r].story.settlement = v,
            Row::Cause(_) => self.crack.spec[r].story.cover_loss = v,
            // Dragging a derived amount PINS it. That is the whole authoring
            // gesture behind "old, but no chips at all" — and it is why the row
            // shows a `*` afterwards: the panel has to say that this wall has
            // stopped listening to its causes on that layer.
            Row::Layer(l) => self.crack.spec[r].pin = self.crack.spec[r].pin.area(l, v),
            Row::MudTop => self.crack.spec[r].mud_top = v,
            Row::Caliber => self.crack.spec[r].shells.caliber = v,
            Row::Scrub => self.crack.spec[r].scrub = v,
            Row::BandLo => self.crack.spec[r].band.0 = v,
            Row::BandHi => self.crack.spec[r].band.1 = v,
            Row::Grain => self.crack.spec[r].shape.grain = v,
            Row::Relief => self.crack.spec[r].shape.relief = v,
            Row::Param(j) => {
                let code = self.crack.spec[r].shape.pattern.code();
                let np = crate::crack_geom::POLICY_PARAMS[code as usize % crate::crack_geom::NPOL].len();
                if j < np {
                    self.crack.par[r][code as usize][j] = v;
                    self.crack.set_pattern(r, code);
                }
            }
            _ => return, // a cycler has no track
        }
        // an INTERACTIVE edit: the run turns authored, and the release that
        // ends this drag persists it (`Viewer::wear_save`)
        if let Some(a) = self.crack.authored.get_mut(r) {
            *a = true;
        }
        self.crack.dirty = true;
        // PAINT rows show live; GEOMETRY rows wait for the release (the footer
        // says which is which). `wear_edit` re-streams both halves of the paint —
        // the `_pad` strengths and the effect word's thresholds — because a
        // story move changes them together.
        self.wear_edit(r);
    }

    /// Set the break COUNT on run `r` — a pin: an author saying how many he
    /// wants outranks the derivation from `settlement`. A no-op when the
    /// sheet already shows `n`, so an IDE slider parked on the current count
    /// does not silently pin the wall.
    pub fn wear_set_breaks(&mut self, r: usize, n: u8) {
        let n = n.min(crate::wall::Breaks::MAX);
        if self.crack.sheets.get(r).map(|s| s.breaks.count) == Some(n) {
            return;
        }
        self.crack.spec[r].pin = self.crack.spec[r].pin.breaks(crate::wall::Breaks { count: n, at: None });
        if let Some(a) = self.crack.authored.get_mut(r) {
            *a = true;
        }
        self.crack.dirty = true;
        self.wear_edit(r);
    }

    /// Point run `r` at pattern `code`, absolute — the IDE's cycler emits the
    /// next code, a harness replay may name any policy. The release that
    /// follows sees the changed key and rebuilds.
    pub fn wear_set_pattern(&mut self, r: usize, code: u8) {
        let code = code % crate::crack_geom::POLICIES.len() as u8;
        if self.crack.spec[r].shape.pattern.code() == code {
            return;
        }
        self.crack.set_pattern(r, code);
        if let Some(a) = self.crack.authored.get_mut(r) {
            *a = true;
        }
        self.crack.dirty = true;
        self.wear_edit(r);
    }

    /// Draw the overlay at logical resolution: the open panel (game menu /
    /// settings), the wall panel or the REC badge when closed — `None` when
    /// there is nothing to show (ESC is the only way into the menu; the
    /// hamburger icon is gone, owner 2026-07-27).
    pub fn menu_canvas(&self) -> Option<(Vec<u32>, i32, i32)> {
        const BG: u32 = 0x16161c;
        const BORDER: u32 = 0x6a6a78;
        const TEXT: u32 = 0xc8c8d0;
        // game menus: a centered panel with big rows — a REGULAR game menu,
        // not the dev tune sheet
        if matches!(self.menu.mode, MenuMode::Title | MenuMode::Pause) {
            let items = if self.menu.mode == MenuMode::Title { TITLE_MENU } else { PAUSE_MENU };
            let (w, h) = (GPANEL_W, gpanel_h(items.len()));
            let mut c = vec![0x101018u32; (w * h) as usize];
            // double border: outer line + inner amber accent
            mrect(&mut c, w, 0, 0, w, 1, BORDER);
            mrect(&mut c, w, 0, h - 1, w, 1, BORDER);
            mrect(&mut c, w, 0, 0, 1, h, BORDER);
            mrect(&mut c, w, w - 1, 0, 1, h, BORDER);
            mrect(&mut c, w, 2, 2, w - 4, 1, 0x8a6a2a);
            let title = if self.menu.mode == MenuMode::Title { "H A Y F L I C K" } else { "P A U S E D" };
            let tx = (w - title.len() as i32 * 8) / 2;
            mtext(&mut c, w, tx, GPAD + 2, title, 0xe8b84a);
            for (i, (label, action)) in items.iter().enumerate() {
                let y = GPAD + GROW * (1 + i as i32);
                let sel = i == self.menu.sel;
                if sel {
                    mrect(&mut c, w, 6, y, w - 12, GROW - 2, 0x2a2a1e);
                }
                let text = if sel { format!("> {label} <") } else { label.to_string() };
                let x = (w - text.len() as i32 * 8) / 2;
                let color = match action {
                    GameAction::Quit => 0xcc8888,
                    _ if sel => 0xf0e8c8,
                    _ => TEXT,
                };
                mtext(&mut c, w, x, y + 3, &text, color);
            }
            let fy = GPAD + GROW * (1 + items.len() as i32) + 3;
            let hint = if self.menu.mode == MenuMode::Title { "beztroska games" } else { "esc resumes" };
            let hx = (w - hint.len() as i32 * 8) / 2;
            mtext(&mut c, w, hx.max(2), fy, hint, 0x707078);
            return Some((c, w, h));
        }
        // LEVELS: the named-demo picker (owner directive 2026-07-16 — the demo
        // IS the deliverable, self-described). Pure fn of the selection so it
        // renders headless for verification (`levels_canvas_dumps` test).
        if self.menu.mode == MenuMode::Levels {
            return Some(levels_canvas(self.menu.sel));
        }
        if self.menu.mode == MenuMode::Closed {
            // while recording, a standalone REC badge (overlay-only — clips
            // capture swap.out, never UI); otherwise the closed menu shows
            // NOTHING — ESC is the menu, and the walls' property surface is
            // the IDE inspector (the wall panel is gone, owner 2026-07-27)
            if let Some(rec) = &self.rec {
                let (w, h) = (72, 14);
                let mut c = vec![BG; (w * h) as usize];
                mrect(&mut c, w, 0, 0, w, 1, BORDER);
                mrect(&mut c, w, 0, h - 1, w, 1, BORDER);
                mrect(&mut c, w, 0, 0, 1, h, BORDER);
                mrect(&mut c, w, w - 1, 0, 1, h, BORDER);
                mrect(&mut c, w, 4, 4, 6, 6, 0xdd4444);
                let secs = rec.frames.len() as f32 / rec.fps as f32;
                mtext(&mut c, w, 14, 3, &format!("{secs:5.1}s"), 0xdd8888);
                return Some((c, w, h));
            }
            return None;
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
        Some((c, w, h))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fine_atmosphere_steps_remain_visible_in_the_menu() {
        assert_eq!(fmt_val("fog", 0.026, 0.002), "0.026");
        assert_eq!(fmt_val("grain", 0.055, 0.005), "0.055");
    }

    /// The projection slider's range is authored as a literal (MENU is const);
    /// it must track iso_core::presets() or the menu can't reach a preset.
    #[test]
    fn proj_slider_covers_every_preset() {
        let item = MENU.iter().find(|i| i.key == "proj").expect("projection row");
        let ItemKind::Slider { min, max, step } = item.kind else { panic!("proj must be a slider") };
        assert_eq!(min, 0.0);
        assert_eq!(step, 1.0);
        assert_eq!(max as usize + 1, iso_core::presets().len(), "MENU proj max must be presets().len() - 1");
        // every index formats to its preset name (the owner-facing labels)
        for (i, p) in iso_core::presets().iter().enumerate() {
            assert_eq!(fmt_val("proj", i as f32, 1.0), p.name);
        }
    }

    /// The blurb band draws `take(LBLURB_LINES)` and drops the rest ON THE
    /// FLOOR, so a blurb that wraps one line too far loses its tail in silence —
    /// and the blurb is the ONLY description of a demo the owner ever sees. The
    /// sibling test below only checked the PANEL fits; this checks the text does.
    #[test]
    fn every_demo_blurb_fits_the_band() {
        for d in crate::demos::DEMOS {
            let lines = wrap_text(d.blurb, LBLURB_COLS);
            assert!(lines.len() <= LBLURB_LINES, "demo {:?}: blurb wraps to {} lines, band shows {LBLURB_LINES} — {lines:?}", d.name, lines.len());
            assert!(!lines.is_empty(), "demo {:?} has no blurb", d.name);
            // a word longer than the band cannot wrap at all — it would overhang
            assert!(lines.iter().all(|l| l.len() <= LBLURB_COLS), "demo {:?}: an unbreakable word overflows the band — {lines:?}", d.name);
        }
    }

    /// The LEVELS panel must fit the shared staging buffer for every demo and
    /// every selection. Dumps PPMs to `$LEVELS_DUMP` for a visual check when set.
    #[test]
    fn levels_canvas_dumps() {
        let dump = std::env::var("LEVELS_DUMP").ok();
        for sel in 0..crate::demos::DEMOS.len() {
            let (buf, w, h) = levels_canvas(sel);
            assert_eq!(buf.len(), (w * h) as usize);
            assert!(w <= MPANEL_W && h <= MPANEL_H, "levels panel overruns the staging buffer");
            if let Some(dir) = &dump {
                let mut ppm = format!("P6\n{w} {h}\n255\n").into_bytes();
                for px in &buf {
                    ppm.extend_from_slice(&[(px >> 16) as u8, (px >> 8) as u8, *px as u8]);
                }
                std::fs::write(format!("{dir}/levels_{sel}.ppm"), ppm).unwrap();
            }
        }
    }

    /// THE ROW TABLE, pinned. The wall panel that drew it is gone (2026-07-27
    /// — the IDE inspector is the walls' property surface), but `rows_of`
    /// survives as the ONE spelling of "what a wall exposes": the inspector's
    /// wear props walk it and `wear_set_row` writes by it. This pins the
    /// model's own order — causes, then the amounts they derive, then the
    /// shape — and the counts that order rests on.
    #[test]
    fn the_row_table_is_the_wall_authoring_model() {
        for policy in 0..crate::crack_geom::NPOL as u8 {
            let spec = crate::wall::WallSpec {
                shape: crate::wall::Shape { pattern: crate::wall::Pattern::DEFAULTS[policy as usize], ..crate::wall::Shape::DEFAULT },
                ..crate::wall::WallSpec::PRISTINE
            };
            let rows = rows_of(&spec);
            assert!(matches!(rows[0], Row::Cause(0)), "the first row must be the first CAUSE");
            assert!(matches!(rows[3], Row::Layer(crate::wall::Layer::Stain)), "the derived column starts after the three causes");
            assert_eq!(rows.iter().filter(|r| matches!(r, Row::Layer(_))).count(), crate::wall::Layer::N, "every layer gets a row");
            assert_eq!(rows.iter().filter(|r| matches!(r, Row::Param(_))).count(), crate::crack_geom::POLICY_PARAMS[policy as usize].len());
            // the three rows that are not 0..1 sliders: the break count, the
            // shell place-mode toggle and the pattern cycler
            assert_eq!(rows.iter().filter(|r| matches!(r, Row::Breaks | Row::Shell | Row::Pattern)).count(), 3);
        }
    }

    /// The menu-first rule (docs/VISION.md): a look CHOICE needs a menu row.
    /// With the DUSK sibling LOOKS is >1, so the row is mandatory and its
    /// literal `max` must track look::LOOKS or the owner can't reach a
    /// candidate from the menu. (If LOOKS ever collapses back to one, this
    /// fails and the dead one-preset row must be pulled again.)
    #[test]
    fn look_slider_covers_every_preset() {
        assert!(crate::look::LOOKS.len() > 1, "one look = dead UI: pull the look row");
        let item = MENU.iter().find(|i| i.key == "look").expect("look row");
        let ItemKind::Slider { min, max, step } = item.kind else { panic!("look must be a slider") };
        assert_eq!(min, 0.0);
        assert_eq!(step, 1.0);
        assert_eq!(max as usize + 1, crate::look::LOOKS.len(), "MENU look max must be LOOKS.len() - 1");
        for (i, l) in crate::look::LOOKS.iter().enumerate() {
            assert_eq!(fmt_val("look", i as f32, 1.0), l.name);
        }
    }
}
