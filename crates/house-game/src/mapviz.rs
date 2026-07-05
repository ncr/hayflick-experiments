//! mapviz — a generic top-down PNG renderer for any [`LevelSpec`], used by the
//! generator dev-tool bins (`roommap`, `floormap`, …) to assess layout quality
//! by eye. Pure CPU; one atlas pixel is one map cell scaled by [`PX`].
//!
//! Convention shared with the generators: a `RoomSpec` whose `id.0 >=
//! CORRIDOR_ROOM_ID_BASE` is circulation (drawn neutral grey); anything below is
//! a room (drawn a distinct pastel + its id). Doors are orange, the player spawn
//! a green disc, and the optional `overlay` segments (room↔junction links) cyan.

use crate::cave::SERVICE_ROOM_ID_BASE;
use crate::{LevelSpec, CORRIDOR_ROOM_ID_BASE};

pub const PX: i32 = 16; // pixels per world cell
pub const MARGIN: i32 = 10;
pub const HDR: i32 = 40; // header strip height (stats line)

const BG: [u8; 3] = [22, 24, 30];
const HDR_BG: [u8; 3] = [15, 16, 21];
const CORRIDOR: [u8; 3] = [78, 86, 104];
const SERVICE: [u8; 3] = [100, 125, 150];
const DOOR: [u8; 3] = [255, 150, 40];
const START: [u8; 3] = [70, 230, 120];
const EDGE: [u8; 3] = [90, 205, 225];
const LABEL: [u8; 3] = [22, 22, 28];
const HDR_FG: [u8; 3] = [220, 224, 235];
const OUTLINE: [u8; 3] = [12, 13, 17];

/// A world-space overlay segment: (from, to) in world XZ.
pub type Seg = ((f32, f32), (f32, f32));

/// Render `spec` (its grid is `gw`×`gh` cells) into a labelled top-down map.
/// `header` is the stats line; `overlay` draws cyan connectivity segments in
/// world coordinates (pass `&[]` for none).
pub fn render(spec: &LevelSpec, gw: i32, gh: i32, header: &str, overlay: &[Seg]) -> Canvas {
    let cw = (MARGIN * 2 + gw * PX) as usize;
    let ch = (MARGIN * 2 + HDR + gh * PX) as usize;
    let mut c = Canvas::new(cw, ch, BG);

    c.fill(0, 0, cw as i32, HDR, HDR_BG);
    c.text(header, MARGIN, MARGIN + 4, 3, HDR_FG);

    let wx = |x: f32| MARGIN + (x * PX as f32) as i32;
    let wz = |z: f32| MARGIN + HDR + (z * PX as f32) as i32;

    // circulation first (grey), then rooms on top (so any overlap reads as room)
    for r in &spec.rooms {
        if r.id.0 < CORRIDOR_ROOM_ID_BASE {
            continue;
        }
        let f = r.floor_rect;
        c.fill(wx(f[0]), wz(f[1]), wx(f[2]), wz(f[3]), CORRIDOR);
    }
    let mut idx = 0;
    for r in &spec.rooms {
        if r.id.0 >= CORRIDOR_ROOM_ID_BASE {
            continue;
        }
        let col = if r.id.0 >= SERVICE_ROOM_ID_BASE {
            SERVICE
        } else {
            let c = room_color(idx);
            idx += 1;
            c
        };
        let f = r.floor_rect;
        c.fill(wx(f[0]), wz(f[1]), wx(f[2]), wz(f[3]), col);
        c.rect_outline(wx(f[0]), wz(f[1]), wx(f[2]), wz(f[3]), OUTLINE);
    }

    for &((ax, az), (bx, bz)) in overlay {
        c.line(wx(ax), wz(az), wx(bx), wz(bz), EDGE);
    }

    for d in &spec.doors {
        let s = d.closed_solid;
        c.fill(wx(s[0]), wz(s[1]), wx(s[2]).max(wx(s[0]) + 2), wz(s[3]).max(wz(s[1]) + 2), DOOR);
    }

    c.disc(wx(spec.player_start.x), wz(spec.player_start.z), (PX as f32 * 0.35) as i32, START);

    // labels last (on top of outlines/overlay)
    for r in &spec.rooms {
        if r.id.0 >= CORRIDOR_ROOM_ID_BASE {
            continue;
        }
        let f = r.floor_rect;
        let s = if r.id.0 >= SERVICE_ROOM_ID_BASE { "S".to_string() } else { r.id.0.to_string() };
        let scale = 2;
        let tw = s.len() as i32 * (4 * scale) - scale;
        let (cx, cz) = ((f[0] + f[2]) * 0.5, (f[1] + f[3]) * 0.5);
        c.text(&s, wx(cx) - tw / 2, wz(cz) - (5 * scale) / 2, scale, LABEL);
    }

    c
}

/// Lay tiles out in a `cols`-wide grid with `pad` between them.
pub fn montage(tiles: &[Canvas], cols: i32, pad: i32) -> Canvas {
    let cols = cols.max(1);
    let rows = (tiles.len() as i32 + cols - 1) / cols;
    let (tw, th) = (tiles[0].w as i32, tiles[0].h as i32);
    let mut m = Canvas::new((pad + cols * (tw + pad)) as usize, (pad + rows * (th + pad)) as usize, [10, 11, 14]);
    for (i, t) in tiles.iter().enumerate() {
        let (cx, cy) = (i as i32 % cols, i as i32 / cols);
        m.blit(t, pad + cx * (tw + pad), pad + cy * (th + pad));
    }
    m
}

fn room_color(i: usize) -> [u8; 3] {
    hsv((i as f32 * 0.618_034).fract(), 0.45, 0.92)
}

fn hsv(h: f32, s: f32, v: f32) -> [u8; 3] {
    let i = (h * 6.0).floor();
    let f = h * 6.0 - i;
    let (p, q, t) = (v * (1.0 - s), v * (1.0 - s * f), v * (1.0 - s * (1.0 - f)));
    let (r, g, b) = match (i as i32).rem_euclid(6) {
        0 => (v, t, p),
        1 => (q, v, p),
        2 => (p, v, t),
        3 => (p, q, v),
        4 => (t, p, v),
        _ => (v, p, q),
    };
    [(r * 255.0) as u8, (g * 255.0) as u8, (b * 255.0) as u8]
}

// ----------------------------------------------------------------- canvas ---

pub struct Canvas {
    pub w: usize,
    pub h: usize,
    buf: Vec<u8>, // RGBA
}

impl Canvas {
    pub fn new(w: usize, h: usize, bg: [u8; 3]) -> Self {
        let mut buf = vec![0u8; w * h * 4];
        for p in buf.chunks_exact_mut(4) {
            p[..3].copy_from_slice(&bg);
            p[3] = 255;
        }
        Canvas { w, h, buf }
    }

    pub fn put(&mut self, x: i32, y: i32, c: [u8; 3]) {
        if x < 0 || y < 0 || x >= self.w as i32 || y >= self.h as i32 {
            return;
        }
        let i = (y as usize * self.w + x as usize) * 4;
        self.buf[i..i + 3].copy_from_slice(&c);
        self.buf[i + 3] = 255;
    }

    pub fn fill(&mut self, x0: i32, y0: i32, x1: i32, y1: i32, c: [u8; 3]) {
        for y in y0..y1 {
            for x in x0..x1 {
                self.put(x, y, c);
            }
        }
    }

    pub fn rect_outline(&mut self, x0: i32, y0: i32, x1: i32, y1: i32, c: [u8; 3]) {
        for x in x0..x1 {
            self.put(x, y0, c);
            self.put(x, y1 - 1, c);
        }
        for y in y0..y1 {
            self.put(x0, y, c);
            self.put(x1 - 1, y, c);
        }
    }

    pub fn line(&mut self, x0: i32, y0: i32, x1: i32, y1: i32, c: [u8; 3]) {
        let (mut x0, mut y0) = (x0, y0);
        let dx = (x1 - x0).abs();
        let dy = -(y1 - y0).abs();
        let sx = if x0 < x1 { 1 } else { -1 };
        let sy = if y0 < y1 { 1 } else { -1 };
        let mut err = dx + dy;
        loop {
            self.put(x0, y0, c);
            if x0 == x1 && y0 == y1 {
                break;
            }
            let e2 = 2 * err;
            if e2 >= dy {
                err += dy;
                x0 += sx;
            }
            if e2 <= dx {
                err += dx;
                y0 += sy;
            }
        }
    }

    pub fn disc(&mut self, cx: i32, cy: i32, r: i32, c: [u8; 3]) {
        for y in -r..=r {
            for x in -r..=r {
                if x * x + y * y <= r * r {
                    self.put(cx + x, cy + y, c);
                }
            }
        }
    }

    fn glyph(&mut self, ch: char, x: i32, y: i32, scale: i32, c: [u8; 3]) -> i32 {
        if let Some(rows) = glyph_rows(ch) {
            for (ry, row) in rows.iter().enumerate() {
                for rx in 0..3 {
                    if (row >> (2 - rx)) & 1 == 1 {
                        self.fill(x + rx * scale, y + ry as i32 * scale, x + (rx + 1) * scale, y + (ry as i32 + 1) * scale, c);
                    }
                }
            }
        }
        4 * scale
    }

    pub fn text(&mut self, s: &str, x: i32, y: i32, scale: i32, c: [u8; 3]) -> i32 {
        let mut cx = x;
        for ch in s.chars() {
            cx += self.glyph(ch.to_ascii_uppercase(), cx, y, scale, c);
        }
        cx
    }

    pub fn blit(&mut self, src: &Canvas, ox: i32, oy: i32) {
        for y in 0..src.h as i32 {
            for x in 0..src.w as i32 {
                let i = (y as usize * src.w + x as usize) * 4;
                self.put(ox + x, oy + y, [src.buf[i], src.buf[i + 1], src.buf[i + 2]]);
            }
        }
    }

    pub fn write_png(&self, path: &str) {
        let f = std::fs::File::create(path).unwrap();
        let mut enc = png::Encoder::new(std::io::BufWriter::new(f), self.w as u32, self.h as u32);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.write_header().unwrap().write_image_data(&self.buf).unwrap();
    }
}

/// Compact 3x5 bitmap font: A–Z, 0–9, space, and a few symbols. Each row's low
/// 3 bits are the pixels (left→right).
fn glyph_rows(ch: char) -> Option<[u8; 5]> {
    let g = match ch {
        '0' => [0b111, 0b101, 0b101, 0b101, 0b111],
        '1' => [0b010, 0b110, 0b010, 0b010, 0b111],
        '2' => [0b111, 0b001, 0b111, 0b100, 0b111],
        '3' => [0b111, 0b001, 0b111, 0b001, 0b111],
        '4' => [0b101, 0b101, 0b111, 0b001, 0b001],
        '5' => [0b111, 0b100, 0b111, 0b001, 0b111],
        '6' => [0b111, 0b100, 0b111, 0b101, 0b111],
        '7' => [0b111, 0b001, 0b010, 0b010, 0b010],
        '8' => [0b111, 0b101, 0b111, 0b101, 0b111],
        '9' => [0b111, 0b101, 0b111, 0b001, 0b111],
        'A' => [0b010, 0b101, 0b111, 0b101, 0b101],
        'B' => [0b110, 0b101, 0b110, 0b101, 0b110],
        'C' => [0b011, 0b100, 0b100, 0b100, 0b011],
        'D' => [0b110, 0b101, 0b101, 0b101, 0b110],
        'E' => [0b111, 0b100, 0b110, 0b100, 0b111],
        'F' => [0b111, 0b100, 0b110, 0b100, 0b100],
        'G' => [0b011, 0b100, 0b101, 0b101, 0b011],
        'H' => [0b101, 0b101, 0b111, 0b101, 0b101],
        'I' => [0b111, 0b010, 0b010, 0b010, 0b111],
        'J' => [0b001, 0b001, 0b001, 0b101, 0b010],
        'K' => [0b101, 0b110, 0b100, 0b110, 0b101],
        'L' => [0b100, 0b100, 0b100, 0b100, 0b111],
        'M' => [0b101, 0b111, 0b111, 0b101, 0b101],
        'N' => [0b101, 0b111, 0b111, 0b111, 0b101],
        'O' => [0b111, 0b101, 0b101, 0b101, 0b111],
        'P' => [0b111, 0b101, 0b111, 0b100, 0b100],
        'Q' => [0b111, 0b101, 0b101, 0b111, 0b011],
        'R' => [0b111, 0b101, 0b111, 0b110, 0b101],
        'S' => [0b011, 0b100, 0b010, 0b001, 0b110],
        'T' => [0b111, 0b010, 0b010, 0b010, 0b010],
        'U' => [0b101, 0b101, 0b101, 0b101, 0b111],
        'V' => [0b101, 0b101, 0b101, 0b101, 0b010],
        'W' => [0b101, 0b101, 0b111, 0b111, 0b101],
        'X' => [0b101, 0b101, 0b010, 0b101, 0b101],
        'Y' => [0b101, 0b101, 0b010, 0b010, 0b010],
        'Z' => [0b111, 0b001, 0b010, 0b100, 0b111],
        '/' => [0b001, 0b001, 0b010, 0b100, 0b100],
        '-' => [0b000, 0b000, 0b111, 0b000, 0b000],
        '.' => [0b000, 0b000, 0b000, 0b000, 0b010],
        '%' => [0b101, 0b001, 0b010, 0b100, 0b101],
        ' ' => [0, 0, 0, 0, 0],
        _ => return None,
    };
    Some(g)
}
