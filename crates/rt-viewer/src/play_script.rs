//! "Let's play" clips (owner 2026-09-22: "show me clips of you using the new
//! UI, so I can see what you press and where you click"). `PLAY_SCRIPT=<file>`
//! drives the viewer with scripted mouse and keyboard input, frame by frame,
//! through the SAME viewer methods the window's events call; a DEMO capture
//! then composites a visible cursor, the keys being pressed and a caption
//! onto every frame.
//!
//! The overlay is drawn on the CPU onto the captured frame, never into the
//! game image: the real window has the OS cursor, and a harness annotation
//! must not become game UI.
//!
//! Grammar — one statement per line, `#` comments, `<frame>` counted from 0
//! (a DEMO capture renders 60 frames per second):
//! - `<f> say <text…>` — caption at the top of the screen (`say -` clears)
//! - `<f> key <name>` — one press: `tab`, `esc`, `f1`..`f4` (category),
//!   `1`..`9` (tool in the category), `ctrl+z`,
//!   `ctrl+y`, `q`, `e`, `+`, `-`
//! - `<f> hold <key> <frames>` — hold `w`/`a`/`s`/`d`/`shift` for n frames
//! - `<f> to <x> <z> <frames>` — glide the cursor to a world ground point
//! - `<f> at <x> <y> <z> <frames>` — glide the cursor to any world point (a
//!   spot on a wall, for the paint tools)
//! - `<f> button <name> <frames>` — glide the cursor onto a toolbar button:
//!   a category (`build`, `walls`, `plants`), a tool of the ACTIVE category
//!   (`wall`, `rain`, `tree`, …), `undo`, `redo` or `play`
//! - `<f> down left|right`, `<f> up left|right` — mouse buttons

use crate::viewer::Viewer;
use glam::{Vec2, Vec3};
use house_game::gym::creative::Button;
use ide::toolbar::BarHit;
use winit::keyboard::KeyCode;

#[derive(Clone, Debug, PartialEq)]
enum Op {
    Say(String),
    Key(String),
    Hold(String, u32),
    To(f32, f32, u32),
    At(f32, f32, f32, u32),
    Btn(String, u32),
    Down(Button),
    Up(Button),
}

#[derive(Clone, Copy)]
enum Aim {
    World(Vec3),
    Bar(BarHit),
}

struct Glide {
    from: Vec2,
    to: Aim,
    start: u32,
    frames: u32,
}

pub struct PlayScript {
    ops: Vec<(u32, Op)>,
    next: usize,
    frame: u32,
    glide: Option<Glide>,
    /// Keys held by `hold`, with the frame they release on.
    held: Vec<(KeyCode, String, u32)>,
    caption: Option<String>,
    /// The last discrete key and the frame it was pressed (shown ~1 s).
    last_key: Option<(String, u32)>,
    mouse: Option<Button>,
}

fn parse(text: &str) -> Result<Vec<(u32, Op)>, String> {
    let mut out = Vec::new();
    for (ln, raw) in text.lines().enumerate() {
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let err = |m: &str| format!("PLAY_SCRIPT line {}: {m}: {raw:?}", ln + 1);
        let mut it = line.split_whitespace();
        let f: u32 = it.next().and_then(|t| t.parse().ok()).ok_or_else(|| err("bad frame"))?;
        let op = it.next().ok_or_else(|| err("missing op"))?;
        let rest: Vec<&str> = it.collect();
        let num = |i: usize| -> Result<f32, String> { rest.get(i).and_then(|t| t.parse().ok()).ok_or_else(|| err("bad number")) };
        let button = |i: usize| -> Result<Button, String> {
            match rest.get(i).copied() {
                Some("left") => Ok(Button::Build),
                Some("right") => Ok(Button::Remove),
                _ => Err(err("expected left|right")),
            }
        };
        out.push((
            f,
            match op {
                "say" => Op::Say(rest.join(" ")),
                "key" => Op::Key(rest.first().ok_or_else(|| err("missing key"))?.to_string()),
                "hold" => Op::Hold(rest.first().ok_or_else(|| err("missing key"))?.to_string(), num(1)? as u32),
                "to" => Op::To(num(0)?, num(1)?, num(2)? as u32),
                "at" => Op::At(num(0)?, num(1)?, num(2)?, num(3)? as u32),
                "button" => Op::Btn(rest.first().ok_or_else(|| err("missing button"))?.to_string(), num(1)? as u32),
                "down" => Op::Down(button(0)?),
                "up" => Op::Up(button(0)?),
                _ => return Err(err("unknown op")),
            },
        ));
    }
    out.sort_by_key(|(f, _)| *f); // stable: same-frame ops keep file order
    Ok(out)
}


fn hold_code(name: &str) -> Option<KeyCode> {
    Some(match name {
        "w" => KeyCode::KeyW,
        "a" => KeyCode::KeyA,
        "s" => KeyCode::KeyS,
        "d" => KeyCode::KeyD,
        "shift" => KeyCode::ShiftLeft,
        _ => return None,
    })
}

/// How a key name is drawn on its key cap.
fn cap(name: &str) -> String {
    match name {
        "tab" => "Tab".into(),
        "esc" => "Esc".into(),
        "ctrl+z" => "Ctrl+Z".into(),
        "ctrl+y" => "Ctrl+Y".into(),
        "shift" => "Shift".into(),
        n => n.to_uppercase(),
    }
}

impl PlayScript {
    pub fn from_env() -> Option<PlayScript> {
        let path = std::env::var("PLAY_SCRIPT").ok()?;
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("PLAY_SCRIPT {path}: {e}"));
        let ops = parse(&text).unwrap_or_else(|e| panic!("{e}"));
        println!("PLAY_SCRIPT: {} statements from {path}", ops.len());
        Some(PlayScript { ops, next: 0, frame: 0, glide: None, held: Vec::new(), caption: None, last_key: None, mouse: None })
    }
}

impl Viewer {
    fn aim_px(&self, aim: Aim) -> Vec2 {
        match aim {
            Aim::World(p) => iso_core::world_to_window_px(p, &self.pick_xform()),
            Aim::Bar(h) => self.creative_button_px(h).unwrap_or(self.view.cursor),
        }
    }

    fn play_cursor(&mut self, p: Vec2) {
        self.view.cursor = p;
        if self.creative.open {
            self.creative_move(p);
        }
    }

    fn play_key(&mut self, name: &str) {
        match name {
            "tab" => self.creative_toggle(),
            "esc" => {
                if self.creative.open {
                    self.creative_cancel();
                } else {
                    self.menu_toggle();
                }
            }
            "ctrl+z" => self.creative_undo(),
            "ctrl+y" => self.creative_redo(),
            "q" => self.start_rotate(-1),
            "e" => self.start_rotate(1),
            "+" => self.zoom_step(1, self.view.cursor),
            "-" => self.zoom_step(-1, self.view.cursor),
            "r" if self.creative.open => self.creative_turn(),
            "0" if self.creative.open => self.creative_set_tool(9),
            "f1" | "f2" | "f3" | "f4" | "f5" => self.creative_set_group(name[1..].parse::<usize>().unwrap_or(1) - 1),
            n => match n.parse::<usize>() {
                Ok(d @ 1..=9) if self.creative.open => self.creative_set_tool(d - 1),
                _ => eprintln!("PLAY_SCRIPT: key {n:?} does nothing here"),
            },
        }
    }

    fn play_mouse(&mut self, b: Button, down: bool) {
        let c = self.view.cursor;
        if down {
            if self.creative.open {
                self.creative_press(c, b);
            } else if b == Button::Build && !self.menu_click(c) {
                self.click_move(c);
            }
        } else if self.creative.open {
            self.creative_release(b);
        }
    }

    fn sync_held_keys(&mut self) {
        if !self.creative.open {
            self.gym.held = self.keys.movement();
            self.gym.run_held = self.keys.run();
        }
    }

    /// Run this frame's scripted input. Called at the top of `draw()`.
    pub fn play_frame(&mut self) {
        let Some(mut ps) = self.play.take() else { return };
        let f = ps.frame;
        // releases due now
        let mut released = false;
        ps.held.retain(|(code, _, until)| {
            if *until <= f {
                self.keys.update(*code, false, false, true);
                released = true;
                false
            } else {
                true
            }
        });
        if released {
            self.sync_held_keys();
        }
        while ps.next < ps.ops.len() && ps.ops[ps.next].0 <= f {
            let op = ps.ops[ps.next].1.clone();
            ps.next += 1;
            match op {
                Op::Say(t) => ps.caption = (t != "-").then_some(t),
                Op::Key(k) => {
                    ps.last_key = Some((cap(&k), f));
                    self.play_key(&k);
                }
                Op::Hold(k, n) => {
                    if let Some(code) = hold_code(&k) {
                        self.keys.update(code, true, false, true);
                        ps.held.push((code, cap(&k), f + n));
                        self.sync_held_keys();
                    }
                }
                Op::To(x, z, n) => ps.glide = Some(Glide { from: self.view.cursor, to: Aim::World(Vec3::new(x, 0.0, z)), start: f, frames: n.max(1) }),
                Op::At(x, y, z, n) => ps.glide = Some(Glide { from: self.view.cursor, to: Aim::World(Vec3::new(x, y, z)), start: f, frames: n.max(1) }),
                Op::Btn(name, n) => match self.creative_bar_target(&name) {
                    Some(h) => ps.glide = Some(Glide { from: self.view.cursor, to: Aim::Bar(h), start: f, frames: n.max(1) }),
                    None => eprintln!("PLAY_SCRIPT: no toolbar button {name:?}"),
                },
                Op::Down(b) => {
                    ps.mouse = Some(b);
                    self.play_mouse(b, true);
                }
                Op::Up(b) => {
                    ps.mouse = None;
                    self.play_mouse(b, false);
                }
            }
        }
        if let Some(g) = &ps.glide {
            let t = ((f - g.start) as f32 / g.frames as f32).clamp(0.0, 1.0);
            let e = t * t * (3.0 - 2.0 * t);
            let (from, to) = (g.from, self.aim_px(g.to));
            let done = t >= 1.0;
            self.play_cursor(from + (to - from) * e);
            if done {
                ps.glide = None;
            }
        } else {
            // keep the hover fresh while the camera pans under a still cursor
            let c = self.view.cursor;
            self.play_cursor(c);
        }
        ps.frame += 1;
        self.play = Some(ps);
    }

    /// Composite the let's-play annotations onto a captured RGBA frame.
    pub fn play_overlay(&self, rgba: &mut [u8], w: u32, h: u32) {
        let Some(ps) = &self.play else { return };
        let mut img = Img { px: rgba, w: w as i32, h: h as i32 };
        let s = (h as i32 / 400).max(2); // text/cursor scale: 2 at 800 px tall
        // caption, top centre
        if let Some(t) = &ps.caption {
            let tw = t.chars().count() as i32 * 8 * s;
            let (bx, by) = ((img.w - tw) / 2 - 6 * s, 10 * s);
            img.rect(bx, by, tw + 12 * s, 14 * s, [12, 12, 12], 0.78);
            img.text(bx + 6 * s, by + 3 * s, t, s, [240, 236, 224]);
        }
        // key caps, top left: held keys, then the last press for ~1 s
        let mut caps: Vec<(String, bool)> = ps.held.iter().map(|(_, n, _)| (n.clone(), true)).collect();
        if let Some((k, at)) = &ps.last_key {
            if ps.frame.saturating_sub(*at) < 60 {
                caps.push((k.clone(), false));
            }
        }
        if let Some(b) = ps.mouse {
            caps.push((if b == Button::Build { "LMB".into() } else { "RMB".into() }, true));
        }
        let mut x = 12 * s;
        // top left, clear of the caption (centred) and of the toolbar, whose
        // height depends on the category
        let y = 10 * s;
        for (k, held) in caps {
            let tw = k.chars().count() as i32 * 8 * s;
            let bw = tw + 10 * s;
            img.rect(x, y, bw, 16 * s, if held { [232, 133, 60] } else { [40, 40, 40] }, 0.92);
            img.frame(x, y, bw, 16 * s, s, [235, 235, 225]);
            img.text(x + 5 * s, y + 4 * s, &k, s, if held { [20, 16, 10] } else { [240, 236, 224] });
            x += bw + 6 * s;
        }
        // the cursor, last so it sits on top of everything
        let c = self.view.cursor;
        let fill = match ps.mouse {
            Some(Button::Build) => [255, 200, 90],
            Some(Button::Remove) => [255, 80, 60],
            None => [255, 255, 255],
        };
        img.cursor(c.x as i32, c.y as i32, s, fill);
    }
}

/// A tiny RGBA painter over the captured frame.
struct Img<'a> {
    px: &'a mut [u8],
    w: i32,
    h: i32,
}

impl Img<'_> {
    fn blend(&mut self, x: i32, y: i32, c: [u8; 3], a: f32) {
        if x < 0 || y < 0 || x >= self.w || y >= self.h {
            return;
        }
        let i = ((y * self.w + x) * 4) as usize;
        for (dst, src) in self.px[i..i + 3].iter_mut().zip(c) {
            *dst = (*dst as f32 * (1.0 - a) + src as f32 * a).round() as u8;
        }
    }

    fn rect(&mut self, x: i32, y: i32, w: i32, h: i32, c: [u8; 3], a: f32) {
        for yy in y..y + h {
            for xx in x..x + w {
                self.blend(xx, yy, c, a);
            }
        }
    }

    fn frame(&mut self, x: i32, y: i32, w: i32, h: i32, t: i32, c: [u8; 3]) {
        self.rect(x, y, w, t, c, 1.0);
        self.rect(x, y + h - t, w, t, c, 1.0);
        self.rect(x, y, t, h, c, 1.0);
        self.rect(x + w - t, y, t, h, c, 1.0);
    }

    fn text(&mut self, x: i32, y: i32, s: &str, scale: i32, c: [u8; 3]) {
        for (i, ch) in s.chars().enumerate() {
            let g = font8x8::legacy::BASIC_LEGACY.get(ch as usize).copied().unwrap_or_default();
            for (gy, row) in g.iter().enumerate() {
                for gx in 0..8 {
                    if row & (1 << gx) != 0 {
                        self.rect(x + (i as i32 * 8 + gx) * scale, y + gy as i32 * scale, scale, scale, c, 1.0);
                    }
                }
            }
        }
    }

    /// A classic arrow pointer, hot spot at (x, y): `#` outline, `o` fill.
    fn cursor(&mut self, x: i32, y: i32, s: i32, fill: [u8; 3]) {
        const ARROW: [&str; 17] = [
            "#", "##", "#o#", "#oo#", "#ooo#", "#oooo#", "#ooooo#", "#oooooo#", "#ooooooo#", "#oooooooo#", "#ooooo#####", "#oo#oo#", "#o# #oo#", "##  #oo#", "#    #oo#", "      #oo#", "       ##",
        ];
        for (row, line) in ARROW.iter().enumerate() {
            for (col, ch) in line.chars().enumerate() {
                let c = match ch {
                    '#' => [0, 0, 0],
                    'o' => fill,
                    _ => continue,
                };
                self.rect(x + col as i32 * s, y + row as i32 * s, s, s, c, 1.0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_script_grammar_parses_every_op_and_names_bad_lines() {
        let ops = parse("# intro\n0 say hello there\n10 key tab\n12 hold w 30\n20 to 3.5 4 15\n40 button building 12\n60 down left\n70 up right\n").unwrap();
        assert_eq!(ops.len(), 7);
        assert_eq!(ops[0], (0, Op::Say("hello there".into())));
        assert_eq!(ops[3], (20, Op::To(3.5, 4.0, 15)));
        assert_eq!(ops[5], (60, Op::Down(Button::Build)));
        assert_eq!(ops[6], (70, Op::Up(Button::Remove)));
        let e = parse("0 say ok\n5 wiggle\n").unwrap_err();
        assert!(e.contains("line 2"), "{e}");
        assert!(parse("x key tab\n").is_err());
        assert!(parse("1 down middle\n").is_err());
    }

    #[test]
    fn same_frame_statements_keep_their_file_order() {
        let ops = parse("5 key tab\n0 say a\n5 key 2\n").unwrap();
        assert_eq!(ops.iter().map(|(f, _)| *f).collect::<Vec<_>>(), vec![0, 5, 5]);
        assert_eq!(ops[1].1, Op::Key("tab".into()));
        assert_eq!(ops[2].1, Op::Key("2".into()));
    }

}
