//! Pixel-canvas builders for the burned-in game HUD: the bottom weapon bar
//! and the tactic "thinking" bubbles over goo blobs. Chunky Doom/Factorio
//! plates: opaque dark panels, 1-px light borders, 8×8 font, no alpha —
//! rasterized at LOGICAL pixels and stamped at the render scale, so HUD
//! pixels are exactly game pixels. Unlike the ESC menu / hamburger overlay
//! (drawable-only), these ship in SHOT/DEMO captures via `FramePresent::stamps`.

use crate::backend::Stamp;
use crate::menu::{mrect, mtext};
use house_game::game::Tactic;
use house_game::{MobRender, WeaponKind};

const BG: u32 = 0x14141a;
const BG_SEL: u32 = 0x24242e;
const BORDER: u32 = 0x565664;
const AMBER: u32 = 0xe0a84c;

/// A bordered plate primitive (every HUD element is one).
fn plate(w: i32, h: i32, bg: u32, border: u32) -> Vec<u32> {
    let mut c = vec![bg; (w * h) as usize];
    mrect(&mut c, w, 0, 0, w, 1, border);
    mrect(&mut c, w, 0, h - 1, w, 1, border);
    mrect(&mut c, w, 0, 0, 1, h, border);
    mrect(&mut c, w, w - 1, 0, 1, h, border);
    c
}

/// The tactic bubble over one blob: `None` for the silent states. Returns
/// (canvas, w, h, accent) — the accent color doubles as border + text so a
/// glance reads the intent even before the word does.
pub fn bubble(m: &MobRender) -> Option<(Vec<u32>, i32, i32)> {
    // comm blink: the SYNC bubble flashes WITH the body pulse — the pact
    // members' bubbles strobe in the same phase (same strike tick)
    let (label, accent) = match m.tac {
        Tactic::Direct => return None,
        Tactic::Flank => ("FLANK", 0x8fd08f),
        Tactic::ToCover => ("SNEAK", 0x9ab8e0),
        Tactic::Peek => ("PEEK", 0xe0c060),
        Tactic::Hide => ("...", 0x9a9aa2),
        Tactic::CoordWait => ("SYNC", if m.comm > 0.0 { 0xbef2ff } else { 0x5a8a96 }),
        Tactic::Sprint => ("RUSH!", 0xe86858),
    };
    let w = 8 + label.len() as i32 * 8;
    let h = 14 + 3; // plate + 3-px tail
    let mut c = plate(w, h - 3, BG, accent);
    mtext(&mut c, w, 4, 3, label, accent);
    // chunky speech tail under the centre
    let mut full = vec![0u32; (w * h) as usize];
    full[..(w * (h - 3)) as usize].copy_from_slice(&c);
    for (i, tw) in [3i32, 2, 1].iter().enumerate() {
        let y = h - 3 + i as i32;
        mrect(&mut full, w, w / 2 - tw, y, tw * 2, 1, accent);
    }
    Some((full, w, h))
}

/// The bottom weapon bar: five slot plates (selected = amber border, brighter
/// face, cooldown fill along its bottom) + a score/wave plate. Logical px.
pub fn bottom_bar(weapon: Option<(WeaponKind, u32, u32)>, score: u32, wave: Option<u16>) -> (Vec<u32>, i32, i32) {
    const SLOT_W: i32 = 50;
    const H: i32 = 26;
    const GAP: i32 = 2;
    const INFO_W: i32 = 84;
    let w = 5 * (SLOT_W + GAP) + INFO_W;
    let mut c = vec![0u32; (w * H) as usize];
    let sel = weapon.map(|(k, _, _)| k.slot());
    for slot in 1..=5u8 {
        let x0 = (slot as i32 - 1) * (SLOT_W + GAP);
        let selected = sel == Some(slot);
        let p = plate(SLOT_W, H, if selected { BG_SEL } else { BG }, if selected { AMBER } else { BORDER });
        for y in 0..H {
            let src = (y * SLOT_W) as usize;
            let dst = (y * w + x0) as usize;
            c[dst..dst + SLOT_W as usize].copy_from_slice(&p[src..src + SLOT_W as usize]);
        }
        let name = WeaponKind::from_slot(slot).map(|k| k.name()).unwrap_or("?");
        mtext(&mut c, w, x0 + 4, 4, &slot.to_string(), if selected { AMBER } else { 0x767682 });
        mtext(&mut c, w, x0 + 14, 4, name, if selected { 0xe8e8d8 } else { 0x9a9aa2 });
        // cooldown fill along the selected slot's bottom (doom-style ready bar)
        if selected {
            if let Some((_, cd, total)) = weapon {
                let track = SLOT_W - 8;
                let frac = if total == 0 { 1.0 } else { 1.0 - (cd as f32 / total as f32).clamp(0.0, 1.0) };
                mrect(&mut c, w, x0 + 4, H - 8, track, 3, 0x30303a);
                mrect(&mut c, w, x0 + 4, H - 8, (track as f32 * frac) as i32, 3, if cd == 0 { 0x8fd08f } else { AMBER });
            }
        }
    }
    // score / wave plate on the right
    let x0 = 5 * (SLOT_W + GAP);
    let p = plate(INFO_W, H, BG, BORDER);
    for y in 0..H {
        let src = (y * INFO_W) as usize;
        let dst = (y * w + x0) as usize;
        c[dst..dst + INFO_W as usize].copy_from_slice(&p[src..src + INFO_W as usize]);
    }
    mtext(&mut c, w, x0 + 4, 4, &format!("SC {score}"), 0x99cc99);
    if let Some(wv) = wave {
        mtext(&mut c, w, x0 + 4, 15, &format!("WAVE {wv}"), 0x9ab8e0);
    }
    (c, w, H)
}

/// Assemble this frame's stamps: one bubble per thinking blob (anchored just
/// above the body via the forward iso projection) + the bottom bar, centred.
pub fn build_stamps(mobs: &[MobRender], weapon: Option<(WeaponKind, u32, u32)>, score: u32, wave: Option<u16>, xf: &iso_core::ViewXform, ext: (u32, u32), rs: u32) -> Vec<Stamp> {
    let mut out = Vec::new();
    let (ext_w, ext_h) = (ext.0 as i64, ext.1 as i64);
    let s = rs.max(1) as i64;
    for m in mobs {
        let Some((pix, w, h)) = bubble(m) else { continue };
        let c = m.centroid();
        let top = glam::Vec3::new(c.x, m.radius * 1.1 + 0.35, c.z);
        let win = iso_core::world_to_window_px(top, xf);
        let x = (win.x as i64 - (w as i64 * s) / 2).clamp(2, ext_w - w as i64 * s - 2);
        let y = (win.y as i64 - h as i64 * s).clamp(2, ext_h - h as i64 * s - 2);
        // cull bubbles whose anchor is far off-screen (clamping a corpse of a
        // despawned-cam view to the edge would read as a stuck sticker)
        if win.x < -60.0 || win.y < -60.0 || win.x > ext_w as f32 + 60.0 || win.y > ext_h as f32 + 60.0 {
            continue;
        }
        out.push(Stamp { pix, w, h, x, y, scale: rs });
    }
    if weapon.is_some() {
        let (pix, w, h) = bottom_bar(weapon, score, wave);
        let x = (ext_w - w as i64 * s) / 2;
        let y = ext_h - h as i64 * s - 6;
        out.push(Stamp { pix, w, h, x, y, scale: rs });
    }
    out
}
