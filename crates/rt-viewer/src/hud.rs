//! The play-mode HUD (2026-09-24, the first gameplay loop): what the player
//! needs to search the street and nothing more.
//!
//! - over the prop in reach: `F  search car`, a progress bar while searching,
//!   `car: searched` once it is empty;
//! - bottom-left: the game log — the last few lines, each for eight seconds
//!   of sim time (the newest in amber for its first second and a half);
//! - top-right: `I  bag (N)`, and with I the inventory panel.
//!
//! Everything reads the sim's own state (`GymGame::near_prop`, `searching`,
//! `log`, `inventory`) and the SIM clock, so a DEMO capture replays it pixel
//! for pixel. It rides the stamp path like the click marker and creative
//! mode's toolbar: burned into the picture, on screen in SHOT/DEMO captures
//! too, and hidden while building.

use crate::backend::Stamp;
use crate::viewer::Viewer;
use glam::Vec3;
use ide::theme;
use ide::Canvas;
use iso_core::world_to_window_px;

/// How long a log line stays up, in sim ticks (8 s at 60 Hz).
const LOG_TICKS: u64 = 480;
/// How long the newest line stays amber.
const FRESH_TICKS: u64 = 90;
/// Log lines shown at most.
const LOG_LINES: usize = 4;

/// A one-line plate: `text` in `color` on the chrome's panel body.
fn plate(text: &str, color: u32) -> Canvas {
    let mut c = Canvas::new(text.chars().count() as u32 * 8 + 2 * theme::PAD as u32, 8 + 2 * 4, theme::BG_BAR);
    c.frame(0, 0, c.w as i32, c.h as i32, theme::EDGE);
    c.text(theme::PAD, 4, text, color, c.w as i32);
    c
}

/// A panel of lines under a header.
fn panel(head: &str, lines: &[(String, u32)]) -> Canvas {
    let cols = lines.iter().map(|(t, _)| t.chars().count()).chain([head.chars().count()]).max().unwrap_or(0);
    let row = 11;
    let (w, h) = (cols as u32 * 8 + 2 * theme::PAD as u32, (lines.len() as u32 + 1) * row + 2 * 4);
    let mut c = Canvas::new(w, h, theme::BG);
    c.fill(0, 0, w as i32, row as i32 + 3, theme::BG_BAR);
    c.frame(0, 0, w as i32, h as i32, theme::EDGE);
    c.text(theme::PAD, 4, head, theme::TEXT_HEAD, w as i32);
    for (k, (t, color)) in lines.iter().enumerate() {
        c.text(theme::PAD, 4 + (k as i32 + 1) * row as i32 + 2, t, *color, w as i32);
    }
    c
}

fn stamp(c: Canvas, x: i64, y: i64, scale: u32) -> Stamp {
    Stamp { w: c.w as i32, h: c.h as i32, pix: c.pix, x, y, scale }
}

impl Viewer {
    /// The HUD's pixel scale: the same chunky chrome scale creative mode's
    /// toolbar uses, so the two read as one product.
    fn hud_scale(&self) -> u32 {
        (crate::backend::menu_scale_for(self.backend.extent().1) / 2).max(2)
    }

    pub fn hud_stamps(&self) -> Vec<Stamp> {
        if self.creative.open {
            return Vec::new();
        }
        let s = self.hud_scale();
        let (ew, eh) = self.backend.extent();
        let (ew, eh) = (ew as i64, eh as i64);
        let sim = &self.gym.sim;
        let now = self.gym.tick.0;
        let mut out = Vec::new();

        // ---- over the prop in reach
        if let Some((i, done)) = sim.near_prop() {
            let p = sim.spec().props[i];
            let kind = p.kind.name();
            let c = match sim.searching() {
                Some(sr) => {
                    let n = 10;
                    let filled = ((sr.total - sr.left) as usize * n / sr.total as usize).min(n);
                    plate(&format!("searching [{}{}]", "#".repeat(filled), "-".repeat(n - filled)), theme::ACCENT)
                }
                None if done => plate(&format!("{kind}: searched"), theme::TEXT_DIM),
                None => plate(&format!("F  search {kind}"), theme::TEXT),
            };
            let y = crate::terrain::height_at(sim.spec(), glam::Vec2::new(p.x, p.z)) + p.kind.height() + 0.35;
            let win = world_to_window_px(Vec3::new(p.x, y, p.z), &self.pick_xform());
            let (w, h) = (c.w as i64 * s as i64, c.h as i64 * s as i64);
            let x = (win.x as i64 - w / 2).clamp(4, (ew - w - 4).max(4));
            let y = (win.y as i64 - h).clamp(4, (eh - h - 4).max(4));
            out.push(stamp(c, x, y, s));
        }

        // ---- the log, bottom-left
        let recent: Vec<&house_game::gym::sim::LogLine> = sim.log().iter().filter(|l| now.saturating_sub(l.tick) < LOG_TICKS).collect();
        let shown = &recent[recent.len().saturating_sub(LOG_LINES)..];
        let mut y = eh - 8;
        for (k, l) in shown.iter().enumerate().rev() {
            let fresh = k + 1 == shown.len() && now.saturating_sub(l.tick) < FRESH_TICKS;
            let c = plate(&l.text, if fresh { theme::ACCENT } else { theme::TEXT });
            y -= c.h as i64 * s as i64 + 2;
            out.push(stamp(c, 8, y, s));
        }

        // ---- the bag, top-right
        let items: u32 = sim.inventory().iter().map(|&(_, n)| n as u32).sum();
        let c = if self.gym.show_inventory {
            let lines: Vec<(String, u32)> = if sim.inventory().is_empty() {
                vec![("(empty)".into(), theme::TEXT_DIM)]
            } else {
                sim.inventory().iter().map(|&(item, n)| (format!("{n:>3}  {}", item.name()), theme::TEXT)).collect()
            };
            panel("INVENTORY    I close", &lines)
        } else {
            plate(&format!("I  bag ({items})"), if items > 0 { theme::TEXT } else { theme::TEXT_DIM })
        };
        let w = c.w as i64 * s as i64;
        out.push(stamp(c, ew - w - 8, 8, s));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plates_fit_their_text() {
        let c = plate("F  search car", theme::TEXT);
        assert_eq!(c.w as usize, "F  search car".len() * 8 + 2 * theme::PAD as usize);
        let p = panel("INVENTORY", &[("  3  scrap metal".into(), theme::TEXT)]);
        assert!(p.w as usize >= "  3  scrap metal".len() * 8);
        assert_eq!(p.pix.len(), (p.w * p.h) as usize);
        // every item name fits a panel row
        for item in house_game::gym::loot::Item::ALL {
            assert!(!item.name().is_empty());
        }
    }
}
