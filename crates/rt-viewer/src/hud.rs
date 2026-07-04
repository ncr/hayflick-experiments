//! Pixel-canvas builders for the burned-in game HUD: the bottom weapon bar
//! and the tactic "thinking" bubbles over goo blobs. Chunky Doom/Factorio
//! plates: opaque dark panels, 1-px light borders, 8×8 font, no alpha —
//! rasterized at LOGICAL pixels and stamped at the render scale, so HUD
//! pixels are exactly game pixels. Unlike the ESC menu / hamburger overlay
//! (drawable-only), these ship in SHOT/DEMO captures via `FramePresent::stamps`.

use crate::backend::Stamp;
use crate::menu::{mrect, mtext};
use house_game::game::{Card, DraftState, RunState, Tactic};
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

/// The bottom weapon bar: an integrity (HULL) plate, five weapon slot plates
/// (selected = amber border, cooldown fill along its bottom), and a
/// biomass/wave plate. Logical px.
pub fn bottom_bar(weapon: Option<(WeaponKind, u32, u32)>, score: u32, wave: Option<u16>, run: Option<RunState>) -> (Vec<u32>, i32, i32) {
    const SLOT_W: i32 = 50;
    const H: i32 = 26;
    const GAP: i32 = 2;
    const INFO_W: i32 = 84;
    const HULL_W: i32 = 64;
    let hull_w = if run.is_some() { HULL_W + GAP } else { 0 };
    let w = hull_w + 5 * (SLOT_W + GAP) + INFO_W;
    let mut c = vec![0u32; (w * H) as usize];
    let sel = weapon.map(|(k, _, _)| k.slot());
    // HULL plate: the run's integrity as a chunky doom-style bar. Green
    // while healthy, amber under half, red + hot border when critical.
    if let Some(r) = run {
        let frac = r.integrity.clamp(0.0, 1.0);
        let (fill, border) = if frac > 0.5 {
            (0x8fd08f, BORDER)
        } else if frac > 0.25 {
            (AMBER, BORDER)
        } else {
            (0xe86858, 0xe86858)
        };
        let pl = plate(HULL_W, H, BG, border);
        for y in 0..H {
            let src = (y * HULL_W) as usize;
            let dst = (y * w) as usize;
            c[dst..dst + HULL_W as usize].copy_from_slice(&pl[src..src + HULL_W as usize]);
        }
        mtext(&mut c, w, 4, 4, "HULL", 0x9a9aa2);
        let track = HULL_W - 8;
        mrect(&mut c, w, 4, H - 10, track, 5, 0x30303a);
        mrect(&mut c, w, 4, H - 10, (track as f32 * frac) as i32, 5, fill);
    }
    for slot in 1..=5u8 {
        let x0 = hull_w + (slot as i32 - 1) * (SLOT_W + GAP);
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
    // biomass / wave plate on the right
    let x0 = hull_w + 5 * (SLOT_W + GAP);
    let p = plate(INFO_W, H, BG, BORDER);
    for y in 0..H {
        let src = (y * INFO_W) as usize;
        let dst = (y * w + x0) as usize;
        c[dst..dst + INFO_W as usize].copy_from_slice(&p[src..src + INFO_W as usize]);
    }
    mtext(&mut c, w, x0 + 4, 4, &format!("BIO {score}"), 0x99cc99);
    if let Some(wv) = wave {
        mtext(&mut c, w, x0 + 4, 15, &format!("WAVE {wv}"), 0x9ab8e0);
    }
    (c, w, H)
}

/// The wave-lull draft hand: three card plates with their pick keys. Sits
/// above the weapon bar while the hand is open; picking (or the next wave
/// landing) removes it.
pub fn draft_hand(d: &DraftState) -> (Vec<u32>, i32, i32) {
    const CARD_W: i32 = 104;
    const CARD_H: i32 = 40;
    const GAP: i32 = 4;
    let keys = ["Z", "X", "C"];
    let w = 3 * CARD_W + 2 * GAP;
    let mut c = vec![0u32; (w * CARD_H) as usize];
    for (i, card) in d.offers.iter().enumerate() {
        let x0 = i as i32 * (CARD_W + GAP);
        let p = plate(CARD_W, CARD_H, 0x1a1a22, AMBER);
        for y in 0..CARD_H {
            let src = (y * CARD_W) as usize;
            let dst = (y * w + x0) as usize;
            c[dst..dst + CARD_W as usize].copy_from_slice(&p[src..src + CARD_W as usize]);
        }
        mtext(&mut c, w, x0 + 4, 4, keys[i], AMBER);
        mtext(&mut c, w, x0 + 16, 4, card.name(), 0xe8e8d8);
        mtext(&mut c, w, x0 + 4, 16, card.desc(), 0x9ab8e0);
        mtext(&mut c, w, x0 + 4, 28, kind_line(*card), 0x767682);
    }
    (c, w, CARD_H)
}

/// Which system a card touches — the plate's bottom rubric.
fn kind_line(c: Card) -> &'static str {
    match c {
        Card::HeavySlug | Card::LongRivet => "SLUG",
        Card::DrumUzi | Card::SteadyAim => "UZI",
        Card::WideChoke | Card::TightChoke => "SHOTGUN",
        Card::BigBoom | Card::Bouncy => "GRENADE",
        Card::BarbedHarpoon => "HARPOON",
        Card::ServoLegs | Card::Plating | Card::NanoRepair => "DROID",
    }
}

/// The run-over panel: containment breached, the tallies, and the restart
/// prompt. Stamped dead-centre at the render scale.
pub fn death_panel(wave: Option<u16>, score: u32, secs: f32) -> (Vec<u32>, i32, i32) {
    const W: i32 = 176;
    const H: i32 = 58;
    let mut c = plate(W, H, 0x1a1016, 0xe86858);
    mrect(&mut c, W, 1, 1, W - 2, 1, 0xe86858); // doubled top rule — alarm plate
    mtext(&mut c, W, (W - 20 * 8) / 2, 6, "CONTAINMENT BREACHED", 0xe86858);
    let line = format!("WAVE {}  BIO {}", wave.unwrap_or(0), score);
    mtext(&mut c, W, (W - line.len() as i32 * 8) / 2, 22, &line, 0xd0d0c0);
    let line2 = format!("SURVIVED {secs:.1}S");
    mtext(&mut c, W, (W - line2.len() as i32 * 8) / 2, 34, &line2, 0x9a9aa2);
    mtext(&mut c, W, (W - 15 * 8) / 2, 46, "SPACE - NEW RUN", 0x8fd08f);
    (c, W, H)
}

/// The largest integer stamp scale ≤ `rs` that fits `w` logical px into the
/// window — HUD plates shrink before they clip (a stamp pushed to negative
/// x simply never draws, which reads as "the HUD vanished").
fn fit_scale(w: i32, rs: u32, ext_w: i64) -> u32 {
    let mut bs = rs.max(1);
    while bs > 1 && (w as i64) * bs as i64 > ext_w - 8 {
        bs -= 1;
    }
    bs
}

/// Assemble this frame's stamps: one bubble per thinking blob (anchored just
/// above the body via the forward iso projection) + the bottom bar, centred.
pub fn build_stamps(mobs: &[MobRender], weapon: Option<(WeaponKind, u32, u32)>, score: u32, wave: Option<u16>, run: Option<RunState>, draft: Option<DraftState>, now_tick: u64, xf: &iso_core::ViewXform, ext: (u32, u32), rs: u32) -> Vec<Stamp> {
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
        let (pix, w, h) = bottom_bar(weapon, score, wave, run);
        // a plate wider than the window steps down its scale instead of
        // clipping into oblivion (negative-x stamps never draw)
        let bs = fit_scale(w, rs, ext_w);
        let x = (ext_w - w as i64 * bs as i64) / 2;
        let y = ext_h - h as i64 * bs as i64 - 6;
        out.push(Stamp { pix, w, h, x, y, scale: bs });
    }
    if let Some(d) = &draft {
        let (pix, w, h) = draft_hand(d);
        let bs = fit_scale(w, rs, ext_w);
        let x = (ext_w - w as i64 * bs as i64) / 2;
        let y = ext_h - (26 + 14) * s - h as i64 * bs as i64; // floats above the bar
        out.push(Stamp { pix, w, h, x, y, scale: bs });
    }
    if let Some(r) = run {
        if r.dead {
            let secs = now_tick.saturating_sub(r.death_tick) as f32; // unused: freeze on survived time
            let _ = secs;
            let survived = r.death_tick as f32 * house_game::TICK_DT;
            let (pix, w, h) = death_panel(wave, score, survived);
            let bs = fit_scale(w, rs, ext_w);
            let x = (ext_w - w as i64 * bs as i64) / 2;
            let y = (ext_h - h as i64 * bs as i64) / 2;
            out.push(Stamp { pix, w, h, x, y, scale: bs });
        }
    }
    out
}
