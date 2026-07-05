//! Minimap HUD — a compact top-down schematic of the level, drawn on the CPU
//! into an RGBA `u32` canvas (the same logical-pixel format the menu/score HUDs
//! use). Unlike those overlays the backend burns the minimap into `out_tex`, so
//! it appears in headless DEMO/SHOT captures, not just the live present.
//!
//! The level layout never changes mid-run, so the room/wall schematic is drawn
//! ONCE into `base` at construction; each frame [`Minimap::frame`] clones it and
//! stamps the player marker (a bright dot + a short facing tick). North-up, +X
//! right / +Z down — a fixed orientation independent of the camera quarter.

use glam::{Vec2, Vec3};
use house_game::{LevelSpec, CORRIDOR_ROOM_ID_BASE};

const PANEL_BG: u32 = 0x121820; // dark slate panel
const PANEL_EDGE: u32 = 0x3c4656; // subtle border
const WALL: u32 = 0xeceae2; // near-white walls (matches the stone palette)
const CORRIDOR: u32 = 0xc9c6bd; // neutral street / corridor stone
const PLAYER: u32 = 0xff5a3c; // hot coral player marker (pops off the pastels)
const PLAYER_EDGE: u32 = 0x2a0d06; // dark rim so the dot reads on light floors
/// Room floor tints — the same pastel ramp `game_scene` uses, keyed by id % 5.
const FLOOR_TINTS: [u32; 5] = [0xbdf2da, 0xccd4fb, 0xfcd4e0, 0xfbe9b6, 0xb8f0f1];

/// Precomputed minimap: the static schematic plus the world→canvas mapping.
pub struct Minimap {
    base: Vec<u32>,
    w: i32,
    h: i32,
    bounds: [f32; 4], // xmin, zmin, xmax, zmax (already padded for the wall ring)
    sc: i32,          // canvas px per world unit
    pad: i32,         // border padding in canvas px
}

#[allow(clippy::too_many_arguments)] // private rect blit; a struct would just rename the args
fn fill(c: &mut [u32], cw: i32, ch: i32, x: i32, y: i32, w: i32, h: i32, col: u32) {
    for py in y.max(0)..(y + h).min(ch) {
        for px in x.max(0)..(x + w).min(cw) {
            c[(py * cw + px) as usize] = col;
        }
    }
}

impl Minimap {
    /// Build the static schematic from the spec (rooms, corridors, wall slabs).
    pub fn from_spec(spec: &LevelSpec) -> Minimap {
        let mut b = spec.floor_bounds();
        b[0] -= 1.0;
        b[1] -= 1.0;
        b[2] += 1.0;
        b[3] += 1.0; // include the perimeter wall ring + a little air
        let (span_x, span_z) = (b[2] - b[0], b[3] - b[1]);
        // target ~165 logical px on the long side, 3..6 px/wu (rooms stay legible).
        let sc = ((165.0 / span_x.max(span_z)).round() as i32).clamp(3, 6);
        let pad = 3;
        let w = (span_x * sc as f32).ceil() as i32 + pad * 2;
        let h = (span_z * sc as f32).ceil() as i32 + pad * 2;
        let mut base = vec![PANEL_BG; (w * h) as usize];

        let mut mm = Minimap { base: Vec::new(), w, h, bounds: b, sc, pad };
        // rooms / corridors as filled rects (corridor stone for circulation ids).
        for r in &spec.rooms {
            let col = if r.id.0 >= CORRIDOR_ROOM_ID_BASE { CORRIDOR } else { FLOOR_TINTS[(r.id.0 as usize) % FLOOR_TINTS.len()] };
            let (x0, y0) = mm.px(r.floor_rect[0], r.floor_rect[1]);
            let (x1, y1) = mm.px(r.floor_rect[2], r.floor_rect[3]);
            fill(&mut base, w, h, x0, y0, (x1 - x0).max(1), (y1 - y0).max(1), col);
        }
        // wall slabs on top, clamped to at least 1 px so thin walls stay visible.
        for s in &spec.static_solids {
            let (x0, y0) = mm.px(s[0], s[1]);
            let (x1, y1) = mm.px(s[2], s[3]);
            fill(&mut base, w, h, x0, y0, (x1 - x0).max(1), (y1 - y0).max(1), WALL);
        }
        // 1px border frame.
        fill(&mut base, w, h, 0, 0, w, 1, PANEL_EDGE);
        fill(&mut base, w, h, 0, h - 1, w, 1, PANEL_EDGE);
        fill(&mut base, w, h, 0, 0, 1, h, PANEL_EDGE);
        fill(&mut base, w, h, w - 1, 0, 1, h, PANEL_EDGE);
        mm.base = base;
        mm
    }

    /// World XZ → canvas px (top-left origin, +X right / +Z down).
    fn px(&self, x: f32, z: f32) -> (i32, i32) {
        (self.pad + ((x - self.bounds[0]) * self.sc as f32).round() as i32, self.pad + ((z - self.bounds[1]) * self.sc as f32).round() as i32)
    }

    /// This frame's canvas: the schematic plus the player marker. Returns the
    /// RGBA `u32` buffer + (w, h) for the backend to expand and blit.
    pub fn frame(&self, player: Vec3, facing: Vec2) -> (Vec<u32>, i32, i32) {
        let mut c = self.base.clone();
        let (px, py) = self.px(player.x, player.z);
        // facing tick first (so the dot draws over its root).
        if facing.length_squared() > 1e-4 {
            let f = facing.normalize();
            let len = (self.sc as f32 * 2.5).max(4.0);
            for i in 1..=len as i32 {
                let gx = px + (f.x * i as f32).round() as i32;
                let gy = py + (f.y * i as f32).round() as i32;
                fill(&mut c, self.w, self.h, gx, gy, 1, 1, PLAYER);
            }
        }
        // player dot: a filled square with a dark rim.
        let r = (self.sc / 2).max(1) + 1;
        fill(&mut c, self.w, self.h, px - r - 1, py - r - 1, 2 * r + 3, 2 * r + 3, PLAYER_EDGE);
        fill(&mut c, self.w, self.h, px - r, py - r, 2 * r + 1, 2 * r + 1, PLAYER);
        (c, self.w, self.h)
    }
}
