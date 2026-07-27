//! A tiny CPU raster target: `0xRRGGBB` pixels, top-left origin, IDE px.
//! Everything the IDE draws goes through here — rects, 1-px frames and the
//! same 8x8 glyphs the game menu uses (one product, two pixel densities).

/// One panel's pixel buffer.
pub struct Canvas {
    pub w: u32,
    pub h: u32,
    pub pix: Vec<u32>,
}

impl Canvas {
    pub fn new(w: u32, h: u32, bg: u32) -> Canvas {
        Canvas { w, h, pix: vec![bg; (w * h) as usize] }
    }

    pub fn px(&mut self, x: i32, y: i32, c: u32) {
        if x >= 0 && y >= 0 && (x as u32) < self.w && (y as u32) < self.h {
            self.pix[y as usize * self.w as usize + x as usize] = c;
        }
    }

    /// Filled rect, clipped to the canvas.
    pub fn fill(&mut self, x: i32, y: i32, w: i32, h: i32, c: u32) {
        for yy in y.max(0)..(y + h).min(self.h as i32) {
            for xx in x.max(0)..(x + w).min(self.w as i32) {
                self.pix[yy as usize * self.w as usize + xx as usize] = c;
            }
        }
    }

    /// 1-px outline rect.
    pub fn frame(&mut self, x: i32, y: i32, w: i32, h: i32, c: u32) {
        self.fill(x, y, w, 1, c);
        self.fill(x, y + h - 1, w, 1, c);
        self.fill(x, y, 1, h, c);
        self.fill(x + w - 1, y, 1, h, c);
    }

    /// 8x8 text; `max_w` clips (whole glyphs) so long names cannot escape a
    /// panel column. Returns the drawn width in px.
    pub fn text(&mut self, x: i32, y: i32, s: &str, c: u32, max_w: i32) -> i32 {
        let mut dx = 0;
        for ch in s.chars() {
            if dx + 8 > max_w {
                break;
            }
            let g = font8x8::legacy::BASIC_LEGACY.get(ch as usize).copied().unwrap_or_default();
            for (gy, row) in g.iter().enumerate() {
                for gx in 0..8 {
                    if row & (1 << gx) != 0 {
                        self.px(x + dx + gx, y + gy as i32, c);
                    }
                }
            }
            dx += 8;
        }
        dx
    }

    /// Text width in px (8 per glyph) — layout helper for right-aligned values.
    pub fn text_w(s: &str) -> i32 {
        s.chars().count() as i32 * 8
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fill_clips_and_text_stays_inside_max_w() {
        let mut c = Canvas::new(20, 10, 0x111111);
        c.fill(-5, -5, 100, 100, 0x222222);
        assert!(c.pix.iter().all(|&p| p == 0x222222), "fill clips to the canvas");
        let w = c.text(0, 1, "abcdef", 0xffffff, 17);
        assert_eq!(w, 16, "17 px holds exactly two whole glyphs");
        // column 16.. untouched by text
        for y in 0..10 {
            for x in 16..20 {
                assert_eq!(c.pix[y * 20 + x], 0x222222, "glyphs never cross max_w");
            }
        }
    }

    #[test]
    fn px_out_of_bounds_is_a_no_op() {
        let mut c = Canvas::new(4, 4, 0);
        c.px(-1, 0, 1);
        c.px(0, -1, 1);
        c.px(4, 0, 1);
        c.px(0, 4, 1);
        assert!(c.pix.iter().all(|&p| p == 0));
    }
}
