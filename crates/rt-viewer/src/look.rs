//! Greybox LOOK presets for the gym — the whole aesthetic of the slice as
//! data: palette, player-body colours, lamp mood, lighting env, and the
//! dress switches `gym_scene::build_gym` keys off. Same greybox discipline
//! as ever (coloured boxes, 0.0625-wu XZ lattice); a look is a restyle,
//! never new render features.
//!
//! `LOOK=<name>` selects a preset (a shell-only env read, like AUDIO — see
//! rt-probe config.rs). Default is **scifi** — the owner's picked direction
//! (2026-07-10). The Faza-1 joyful presets replace these (docs/VISION.md);
//! the machinery — look-as-data — stays.

/// Roof silhouette for the building's cap (all variants stay occluder-marked
/// above the WALLCUT, so the indoor cutaway removes them). An eave fascia is
/// a separate switch ([`Look::fascia`]) — it combines with either style.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum RoofStyle {
    /// A plain flat cap (classic; inkwash keeps it as a graphic ink block).
    FlatCap,
    /// Flat cap + a raised `roof_trim` strip per row — reads as standing
    /// seams / tiled ridges and breaks up big roof expanses.
    Ridged,
}

/// One visual direction, fully data. Architecture colours are sRGB hex
/// (through `hex_linear`); body and lamp colours are linear f32 (authored
/// linear historically).
pub struct Look {
    pub name: &'static str,
    pub roof_style: RoofStyle,
    // ---- architecture
    pub street: u32,
    /// `Some` = per-cell cobble checker on Outdoor cells (breaks the floor
    /// row-run merge into per-cell quads — fine at gym scale).
    pub street_alt: Option<u32>,
    pub room_floor: u32,
    pub wall: u32,
    pub roof: u32,
    /// Ridge strip colour (RoofStyle::Ridged).
    pub roof_trim: u32,
    /// `Some` = an eave fascia lip under the cap, slightly wider than it.
    pub fascia: Option<u32>,
    /// `Some` = half-timber frame: posts on every wall-run cell boundary +
    /// a rail, occluder-marked so the WALLCUT takes them.
    pub timber: Option<u32>,
    /// `Some` = skirting plinth along wall bases (below the WALLCUT — it
    /// stays in the cutaway and grounds the wall stubs).
    pub plinth: Option<u32>,
    // ---- lamps (fixture colours + the named point light's tint/strength)
    pub lamp_post: [f32; 4],
    pub lamp_head: [f32; 4],
    pub lamp_glow: [f32; 4],
    pub lamp_tint: [f32; 3],
    pub lamp_scale: f32,
    // ---- lighting env [sun, sky, fog, fog_h] (scene.lighting)
    pub lighting: [f32; 4],
    // ---- the player body (linear)
    pub coat: [f32; 4],
    pub hood: [f32; 4],
    pub skin: [f32; 4],
    pub legs: [f32; 4],
    pub boots: [f32; 4],
}

/// The pre-look-system palette (pale stone, near-white walls, flat caps).
/// Geometry-wise it now renders the same refined kit as every other look —
/// the Legacy body/lamp kit went with the 2026-07-12 cut.
pub const CLASSIC: Look = Look {
    name: "classic",
    roof_style: RoofStyle::FlatCap,
    street: 0xcfcbc2,
    street_alt: None,
    room_floor: 0xfbe9b6,
    wall: 0xf6f2e8,
    roof: 0x8a7a62,
    roof_trim: 0x8a7a62,
    fascia: None,
    timber: None,
    plinth: None,
    lamp_post: [0.16, 0.17, 0.18, 1.0],
    lamp_head: [0.30, 0.24, 0.12, 1.0],
    lamp_glow: [5.5, 4.2, 2.2, 1.0],
    lamp_tint: [1.0, 0.82, 0.58],
    lamp_scale: 1.0,
    lighting: [0.0, 5.5, 0.22, 0.42],
    coat: [0.16, 0.42, 0.20, 1.0],
    hood: [0.09, 0.24, 0.12, 1.0],
    skin: [0.75, 0.60, 0.48, 1.0],
    legs: [0.32, 0.30, 0.26, 1.0],
    boots: [0.14, 0.12, 0.10, 1.0],
};

/// Wet cobbles & gas lamps: dark stone, desaturated cool darks so the warm
/// gas flames carry the frame. The nocturne mood.
pub const GASLIGHT: Look = Look {
    name: "gaslight",
    roof_style: RoofStyle::Ridged,
    street: 0x686d76,
    street_alt: Some(0x5e636c),
    room_floor: 0x8a6f55,
    wall: 0x8d95a4,
    roof: 0x45474d,
    roof_trim: 0x53555c,
    fascia: Some(0xa39e90),
    timber: None,
    plinth: Some(0x707580),
    lamp_post: [0.05, 0.055, 0.06, 1.0],
    lamp_head: [0.32, 0.22, 0.10, 1.0],
    lamp_glow: [7.5, 5.0, 2.2, 1.0],
    lamp_tint: [1.0, 0.72, 0.42],
    lamp_scale: 1.35,
    lighting: [0.0, 5.0, 0.32, 0.5],
    coat: [0.05, 0.16, 0.09, 1.0],
    hood: [0.03, 0.09, 0.05, 1.0],
    skin: [0.55, 0.42, 0.32, 1.0],
    legs: [0.10, 0.10, 0.11, 1.0],
    boots: [0.05, 0.045, 0.04, 1.0],
};

/// Market town: cream plaster + dark half-timber, terracotta ridged roofs,
/// sandy cobbles. Warm, cozy, painterly daylight.
pub const TIMBERED: Look = Look {
    name: "timbered",
    roof_style: RoofStyle::Ridged,
    street: 0xb5a284,
    street_alt: Some(0xab9878),
    room_floor: 0xc98f5a,
    wall: 0xf2e4c8,
    roof: 0xb35c3e,
    roof_trim: 0x9d4e33,
    fascia: Some(0x4a3626),
    timber: Some(0x4a3626),
    plinth: Some(0x8d7f66),
    lamp_post: [0.09, 0.09, 0.10, 1.0],
    lamp_head: [0.35, 0.26, 0.12, 1.0],
    lamp_glow: [5.5, 4.4, 2.4, 1.0],
    lamp_tint: [1.0, 0.80, 0.52],
    lamp_scale: 1.0,
    lighting: [0.0, 6.2, 0.20, 0.42],
    coat: [0.14, 0.38, 0.14, 1.0],
    hood: [0.08, 0.20, 0.08, 1.0],
    skin: [0.78, 0.60, 0.45, 1.0],
    legs: [0.28, 0.24, 0.20, 1.0],
    boots: [0.12, 0.08, 0.05, 1.0],
};

/// Printmaker's plate: warm parchment + bone walls, every trim in charcoal
/// ink (the cutaway reads as a drawn floorplan), figures near-ink.
pub const INKWASH: Look = Look {
    name: "inkwash",
    roof_style: RoofStyle::FlatCap,
    street: 0xd8d0bc,
    street_alt: None,
    room_floor: 0xcfc4a8,
    wall: 0xe8e0cc,
    roof: 0x35322e,
    roof_trim: 0x35322e,
    fascia: Some(0xd8d0bc),
    timber: Some(0x3a3835),
    plinth: Some(0x55524c),
    lamp_post: [0.045, 0.043, 0.04, 1.0],
    lamp_head: [0.30, 0.26, 0.16, 1.0],
    lamp_glow: [5.0, 4.2, 2.6, 1.0],
    lamp_tint: [1.0, 0.85, 0.60],
    lamp_scale: 0.9,
    lighting: [0.0, 5.8, 0.30, 0.55],
    coat: [0.10, 0.20, 0.11, 1.0],
    hood: [0.06, 0.11, 0.07, 1.0],
    skin: [0.70, 0.58, 0.42, 1.0],
    legs: [0.15, 0.14, 0.13, 1.0],
    boots: [0.08, 0.08, 0.08, 1.0],
};

/// Medieval stone keep: grey fieldstone, weathered oak-shingle roofs,
/// granite setts, torch-warm lamps. The period direction.
pub const BASTION: Look = Look {
    name: "bastion",
    roof_style: RoofStyle::Ridged,
    street: 0x8d8a82,
    street_alt: Some(0x83807a),
    room_floor: 0x9c7a4e,
    wall: 0xa8a49a,
    roof: 0x6b5138,
    roof_trim: 0x59422c,
    fascia: Some(0x4f3d2a),
    timber: None,
    plinth: Some(0x7a766c),
    lamp_post: [0.06, 0.055, 0.05, 1.0],
    lamp_head: [0.30, 0.20, 0.08, 1.0],
    lamp_glow: [6.5, 4.0, 1.6, 1.0],
    lamp_tint: [1.0, 0.62, 0.30],
    lamp_scale: 1.2,
    lighting: [0.0, 5.2, 0.26, 0.45],
    coat: [0.12, 0.30, 0.14, 1.0],
    hood: [0.07, 0.17, 0.08, 1.0],
    skin: [0.72, 0.56, 0.42, 1.0],
    legs: [0.24, 0.22, 0.19, 1.0],
    boots: [0.10, 0.08, 0.06, 1.0],
};

/// Desert kasbah: sun-baked adobe, flat earthen roofs, sandy lanes, linen-
/// clad figure. Bright, dry, high-key daylight.
pub const ADOBE: Look = Look {
    name: "adobe",
    roof_style: RoofStyle::FlatCap,
    street: 0xcdb289,
    street_alt: Some(0xc3a87e),
    room_floor: 0xb97a4e,
    wall: 0xd9a86e,
    roof: 0xb98a52,
    roof_trim: 0xb98a52,
    fascia: Some(0xe0cfa8),
    timber: None,
    plinth: Some(0xb98f5e),
    lamp_post: [0.10, 0.08, 0.06, 1.0],
    lamp_head: [0.38, 0.28, 0.14, 1.0],
    lamp_glow: [5.0, 3.9, 2.2, 1.0],
    lamp_tint: [1.0, 0.82, 0.55],
    lamp_scale: 0.95,
    lighting: [0.0, 6.5, 0.16, 0.4],
    coat: [0.13, 0.34, 0.16, 1.0],
    hood: [0.07, 0.19, 0.09, 1.0],
    skin: [0.62, 0.45, 0.32, 1.0],
    legs: [0.75, 0.68, 0.55, 1.0],
    boots: [0.28, 0.18, 0.10, 1.0],
};

/// Edo machiya lane: shoji-paper walls ruled by dark cedar posts, charcoal
/// tile roofs, raked gravel.
pub const EDO: Look = Look {
    name: "edo",
    roof_style: RoofStyle::Ridged,
    street: 0xb0aca0,
    street_alt: None,
    room_floor: 0xc8b878,
    wall: 0xe8e4d8,
    roof: 0x3c3c40,
    roof_trim: 0x2e2e33,
    fascia: Some(0x3a2f26),
    timber: Some(0x3a2f26),
    plinth: Some(0x4a4038),
    lamp_post: [0.06, 0.05, 0.045, 1.0],
    lamp_head: [0.50, 0.42, 0.28, 1.0],
    lamp_glow: [4.6, 3.8, 2.2, 1.0],
    lamp_tint: [1.0, 0.78, 0.50],
    lamp_scale: 1.0,
    lighting: [0.0, 5.6, 0.24, 0.45],
    coat: [0.10, 0.26, 0.13, 1.0],
    hood: [0.06, 0.14, 0.07, 1.0],
    skin: [0.76, 0.60, 0.46, 1.0],
    legs: [0.16, 0.16, 0.18, 1.0],
    boots: [0.08, 0.08, 0.09, 1.0],
};

/// Colony station: white resin panels with structural ribs, gunmetal seam
/// roofs, deck-plate ground, safety-orange fascia, cool white light.
pub const SCIFI: Look = Look {
    name: "scifi",
    roof_style: RoofStyle::Ridged,
    street: 0x9aa0a8,
    street_alt: Some(0x8f959d),
    room_floor: 0xd8dce2,
    wall: 0xe2e6ea,
    roof: 0x545a64,
    roof_trim: 0x616874,
    fascia: Some(0xd86a1e),
    timber: Some(0x565c66),
    plinth: Some(0x4a505a),
    lamp_post: [0.30, 0.32, 0.36, 1.0],
    lamp_head: [0.60, 0.65, 0.70, 1.0],
    lamp_glow: [4.5, 5.0, 5.6, 1.0],
    lamp_tint: [0.85, 0.92, 1.0],
    lamp_scale: 1.1,
    lighting: [0.0, 6.0, 0.14, 0.5],
    coat: [0.10, 0.36, 0.18, 1.0],
    hood: [0.06, 0.20, 0.10, 1.0],
    skin: [0.72, 0.56, 0.44, 1.0],
    legs: [0.55, 0.58, 0.62, 1.0],
    boots: [0.20, 0.22, 0.25, 1.0],
};

/// The concept paintings (docs/concepts/, owner directive 2026-07-12): one
/// white concrete monolith in a golden field, warm low sun, long soft
/// shadows, dark window slots as the only facade rhythm. The first joyful
/// Faza-1 candidate — sun ON (every older look is lamp/sky only).
pub const TECTA: Look = Look {
    name: "tecta",
    roof_style: RoofStyle::FlatCap,
    street: 0xc9a95e,
    street_alt: Some(0xbf9f55),
    room_floor: 0xe8dcbe,
    wall: 0xf2efe6,
    roof: 0xcfc8b8,
    roof_trim: 0xcfc8b8,
    fascia: None,
    timber: Some(0x35322c), // the tecta window-slot rhythm, as dark posts
    plinth: Some(0xa89f8e),
    lamp_post: [0.22, 0.21, 0.19, 1.0],
    lamp_head: [0.55, 0.50, 0.40, 1.0],
    lamp_glow: [5.0, 4.2, 2.8, 1.0],
    lamp_tint: [1.0, 0.85, 0.62],
    lamp_scale: 0.9,
    lighting: [0.6, 4.2, 0.08, 0.45], // SUN on — the golden-hour key light
    coat: [0.10, 0.34, 0.16, 1.0],
    hood: [0.06, 0.19, 0.09, 1.0],
    skin: [0.74, 0.58, 0.45, 1.0],
    legs: [0.30, 0.27, 0.22, 1.0],
    boots: [0.13, 0.11, 0.08, 1.0],
};

/// Cyberpunk backstreet: wet asphalt, raw concrete, cold cyan tube-light,
/// magenta livery stripes, techwear figure.
pub const NEON: Look = Look {
    name: "neon",
    roof_style: RoofStyle::FlatCap,
    street: 0x3f4148,
    street_alt: Some(0x393b42),
    room_floor: 0x5a5e66,
    wall: 0x6e737c,
    roof: 0x2e3036,
    roof_trim: 0x3a3d44,
    fascia: Some(0xd6329a),
    timber: None,
    plinth: Some(0x33353b),
    lamp_post: [0.04, 0.04, 0.05, 1.0],
    lamp_head: [0.20, 0.50, 0.55, 1.0],
    lamp_glow: [2.2, 6.5, 7.0, 1.0],
    lamp_tint: [0.55, 0.95, 1.0],
    lamp_scale: 1.5,
    lighting: [0.0, 3.8, 0.36, 0.55],
    coat: [0.07, 0.24, 0.12, 1.0],
    hood: [0.04, 0.13, 0.06, 1.0],
    skin: [0.60, 0.46, 0.36, 1.0],
    legs: [0.12, 0.12, 0.14, 1.0],
    boots: [0.06, 0.06, 0.07, 1.0],
};

pub static LOOKS: &[&Look] = &[&CLASSIC, &GASLIGHT, &TIMBERED, &INKWASH, &BASTION, &ADOBE, &EDO, &SCIFI, &TECTA, &NEON];

pub fn by_name(name: &str) -> Option<&'static Look> {
    LOOKS.iter().find(|l| l.name == name).copied()
}

/// Resolve `LOOK` from the environment (default: scifi — the picked
/// direction).
pub fn from_env() -> &'static Look {
    match std::env::var("LOOK") {
        Ok(name) => by_name(&name).unwrap_or_else(|| {
            eprintln!("LOOK={name}: unknown preset (classic gaslight timbered inkwash bastion adobe edo scifi tecta neon) — using scifi");
            &SCIFI
        }),
        Err(_) => &SCIFI,
    }
}
