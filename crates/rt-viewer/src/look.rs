//! Greybox LOOK presets for the gym — since Faza 1b the WHOLE aesthetic of
//! the slice as one runtime-switchable datum: palette, player-body colours,
//! lamp mood, lighting env, the sun + sky dome ([`rt_probe::SunSky`]), the
//! post stack ([`StyleCfg`]), exposure, surface response, plus the dress
//! switches `gym_scene::build_gym` keys off. Same greybox discipline as
//! ever (coloured boxes, clean-lattice XZ dims); a look is a restyle,
//! never new render features.
//!
//! The ESC settings menu switches looks LIVE (scene rebuild + probe rebake,
//! disk-cached per look) — the owner's playtest hub (docs/VISION.md).
//! `LOOK=<name|index>` seeds the boot look for the agent/harness (a
//! shell-only env read, like AUDIO — see rt-probe config.rs); individual
//! style env vars (GRADE, SAT, …) override on top via `StyleCfg::env_over`.
//!
//! THE direction (owner directive 2026-07-12, after the 4-candidate
//! review): **porcelain × meadow**, merged as [`POLANA`] — super-clean
//! porcelain volumes (minimal bump, slight sheen), lush saturated greens
//! and sky, and the facade rhythm as clean panels with FULL-HEIGHT tinted
//! black window slots (the tecta read, porcelain feeling). `porcelain`
//! and `meadow` stay in the menu as the A/B parents; every other
//! candidate (tecta, sorbet — and before them the dirt-era looks) lives
//! in git history only.

use rt_probe::{StyleCfg, SunSky};

/// Roof silhouette for the building's cap (all variants stay occluder-marked
/// above the WALLCUT, so the indoor cutaway removes them). An eave fascia is
/// a separate switch ([`Look::fascia`]) — it combines with either style.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum RoofStyle {
    /// A plain flat cap.
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
    /// `Some` = per-cell checker on Outdoor cells (breaks the floor
    /// row-run merge into per-cell quads — fine at gym scale).
    pub street_alt: Option<u32>,
    pub room_floor: u32,
    pub wall: u32,
    pub roof: u32,
    /// Ridge strip colour (RoofStyle::Ridged).
    pub roof_trim: u32,
    /// `Some` = an eave fascia lip under the cap, slightly wider than it.
    pub fascia: Option<u32>,
    /// `Some` = FULL-HEIGHT tinted-glass window slots (owner directive
    /// 2026-07-12): one per wall cell, centred, floor to just above the
    /// wall top — the tecta window rhythm in porcelain-clean form.
    /// Occluder-marked so the WALLCUT takes them with the wall.
    pub window: Option<u32>,
    /// `Some` = skirting plinth along wall bases (below the WALLCUT — it
    /// stays in the cutaway and grounds the wall stubs).
    pub plinth: Option<u32>,
    /// `Some` = lush-nature dress: low grass-tuft boxes scattered over
    /// Outdoor cells in a deterministic hash pattern (three green tints).
    /// Pure visuals — the sim grid never sees them.
    pub grass: Option<[u32; 3]>,
    // ---- lamps (fixture colours + the named point light's tint/strength)
    pub lamp_post: [f32; 4],
    pub lamp_head: [f32; 4],
    pub lamp_glow: [f32; 4],
    pub lamp_tint: [f32; 3],
    pub lamp_scale: f32,
    // ---- lighting env [sun, sky, fog, fog_h] (scene.lighting)
    pub lighting: [f32; 4],
    /// The sun + sky dome as data (Faza 1b): direction, sun tint, sky
    /// gradient tints, void tint.
    pub sun: SunSky,
    // ---- the post stack + exposure (Faza 1b: merged into the look)
    pub style: StyleCfg,
    pub exposure: f32,
    // ---- surface response (Faza 1b: look data; SPEC/GLOSS/BUMP/BUMP_SCALE/
    // GI env vars override) — concrete vs ceramic lives here
    pub spec: f32,
    pub gloss: f32,
    pub bump: f32,
    pub bump_scale: f32,
    pub gi: f32,
    // ---- the player body (linear)
    pub coat: [f32; 4],
    pub hood: [f32; 4],
    pub skin: [f32; 4],
    pub legs: [f32; 4],
    pub boots: [f32; 4],
}

/// THE look (owner pick 2026-07-12): porcelain × meadow. Super-clean
/// near-white ceramic volumes with a slight sheen, full-height black glass
/// window slots as the only facade rhythm, one amber accent, lush saturated
/// meadow greens with grass-tuft dress, big błękit sky, red-coat walker.
pub const POLANA: Look = Look {
    name: "polana",
    roof_style: RoofStyle::FlatCap,
    street: 0x74b048,
    street_alt: Some(0x6ca343),
    room_floor: 0xf0ede5,
    wall: 0xf8f6f2,
    roof: 0xe9e6df,
    roof_trim: 0xe9e6df,
    fascia: Some(0xd8871e), // THE accent (kept from porcelain)
    window: Some(0x0d0f11), // full-height tinted glass, porcelain-smooth
    plinth: Some(0xd8d5cd),
    grass: Some([0x5f9c3a, 0x82c455, 0x4c8a30]),
    lamp_post: [0.32, 0.32, 0.31, 1.0],
    lamp_head: [0.60, 0.45, 0.22, 1.0],
    lamp_glow: [5.5, 3.8, 1.6, 1.0],
    lamp_tint: [1.0, 0.72, 0.35], // amber
    lamp_scale: 0.9,
    lighting: [0.72, 4.6, 0.03, 0.5],
    sun: SunSky {
        sun_dir: [0.55, 0.66, 0.35],        // late morning, soft mid shadows
        sun_rgb: [1.0, 0.96, 0.87],         // clean warm-white key
        horizon_rgb: [0.86, 0.92, 1.0],
        zenith_rgb: [0.28, 0.55, 1.0],      // the big błękit
        ground_rgb: [0.8, 1.25, 0.42],      // the lush field keeps rolling
    },
    style: StyleCfg { sat: 1.5, contrast: 1.1, ..StyleCfg::CLEAN },
    exposure: 0.43,
    spec: 0.12, // the ceramic sheen…
    gloss: 0.9,
    bump: 0.1, // …on near-smooth porcelain (minimal bumps — owner)
    bump_scale: 7.0,
    gi: 0.5,
    coat: [0.42, 0.10, 0.08, 1.0], // the red-coat walker (from meadow)
    hood: [0.26, 0.05, 0.04, 1.0],
    skin: [0.74, 0.58, 0.45, 1.0],
    legs: [0.80, 0.75, 0.65, 1.0], // cream slacks
    boots: [0.10, 0.10, 0.11, 1.0],
};

/// A/B parent: biel + akcent — clean white ceramic, one amber accent, pale
/// desaturated sky, no nature. What polana's architecture came from.
pub const PORCELAIN: Look = Look {
    name: "porcelain",
    roof_style: RoofStyle::Ridged,
    street: 0xd8d5ce,
    street_alt: Some(0xd0cdc6),
    room_floor: 0xefece4,
    wall: 0xf7f6f2,
    roof: 0xe8e5de,
    roof_trim: 0xdedbd2,
    fascia: Some(0xd8871e), // THE accent
    window: None,           // pure panels
    plinth: Some(0xc4c0b6),
    grass: None,
    lamp_post: [0.30, 0.30, 0.29, 1.0],
    lamp_head: [0.60, 0.45, 0.22, 1.0],
    lamp_glow: [5.5, 3.8, 1.6, 1.0],
    lamp_tint: [1.0, 0.72, 0.35], // amber
    lamp_scale: 0.9,
    lighting: [0.7, 4.4, 0.03, 0.5],
    sun: SunSky {
        sun_dir: [0.45, 0.75, 0.35],        // high, near-noon
        sun_rgb: [1.0, 0.96, 0.88],         // clean warm-white key
        horizon_rgb: [0.94, 0.94, 0.95],
        zenith_rgb: [0.55, 0.66, 0.86],     // quiet pale blue
        ground_rgb: [1.8, 1.8, 1.75],       // pale platform void
    },
    style: StyleCfg { sat: 1.2, contrast: 1.1, ..StyleCfg::CLEAN },
    exposure: 0.44,
    spec: 0.12, // the ceramic sheen…
    gloss: 0.9,
    bump: 0.12, // …on near-smooth surfaces
    bump_scale: 7.0,
    gi: 0.5,
    coat: [0.11, 0.11, 0.12, 1.0], // charcoal figure…
    hood: [0.06, 0.06, 0.07, 1.0],
    skin: [0.74, 0.58, 0.45, 1.0],
    legs: [0.17, 0.17, 0.18, 1.0],
    boots: [0.48, 0.20, 0.04, 1.0], // …with the amber boots
};

/// A/B parent: słoneczny dzień (the trip paintings) — fresh green field,
/// white walls, vivid błękit, red-coat walker. What polana's nature came
/// from (now with the rebuilt window-slot facade + grass dress).
pub const MEADOW: Look = Look {
    name: "meadow",
    roof_style: RoofStyle::FlatCap,
    street: 0x8fae5a,
    street_alt: Some(0x87a654),
    room_floor: 0xe6d9b8,
    wall: 0xf4f4ee,
    roof: 0xc8c2b2,
    roof_trim: 0xc8c2b2,
    fascia: None,
    window: Some(0x272c22), // dark moss glass
    plinth: Some(0xb0ab9c),
    grass: Some([0x79a04a, 0x94b862, 0x668c3e]),
    lamp_post: [0.20, 0.21, 0.20, 1.0],
    lamp_head: [0.50, 0.48, 0.40, 1.0],
    lamp_glow: [4.6, 4.2, 3.0, 1.0],
    lamp_tint: [1.0, 0.88, 0.68],
    lamp_scale: 0.8,
    lighting: [0.7, 4.6, 0.04, 0.45],
    sun: SunSky {
        sun_dir: [0.55, 0.66, 0.35],        // ~42°: late morning, soft mid shadows
        sun_rgb: [1.0, 0.95, 0.84],         // neutral-warm daylight
        horizon_rgb: [0.88, 0.93, 1.0],
        zenith_rgb: [0.30, 0.55, 1.0],      // the big błękit
        ground_rgb: [0.9, 1.25, 0.5],       // the sunlit valley keeps rolling
    },
    style: StyleCfg { sat: 1.45, contrast: 1.1, ..StyleCfg::CLEAN },
    exposure: 0.40,
    spec: 0.0,
    gloss: 0.85,
    bump: 0.55, // meadow turf, softer plaster
    bump_scale: 7.0,
    gi: 0.46,
    coat: [0.40, 0.10, 0.08, 1.0], // the red-coat walker
    hood: [0.25, 0.05, 0.04, 1.0],
    skin: [0.74, 0.58, 0.45, 1.0],
    legs: [0.22, 0.20, 0.18, 1.0],
    boots: [0.10, 0.08, 0.06, 1.0],
};

pub static LOOKS: &[&Look] = &[&POLANA, &PORCELAIN, &MEADOW];

pub fn by_name(name: &str) -> Option<&'static Look> {
    LOOKS.iter().find(|l| l.name == name).copied()
}

/// Resolve `LOOK` from the environment: a preset name or its menu index
/// (the ESC menu's env string prints the index, mirroring PROJ). Default:
/// polana — THE look direction (owner pick, 2026-07-12).
pub fn from_env() -> &'static Look {
    let default = &POLANA;
    match std::env::var("LOOK") {
        Ok(v) => v
            .parse::<usize>()
            .ok()
            .and_then(|i| LOOKS.get(i).copied())
            .or_else(|| by_name(&v))
            .unwrap_or_else(|| {
                let names: Vec<&str> = LOOKS.iter().map(|l| l.name).collect();
                eprintln!("LOOK={v}: unknown preset ({}) — using {}", names.join(" "), default.name);
                default
            }),
        Err(_) => default,
    }
}
