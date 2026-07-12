//! Greybox LOOK presets for the gym — since Faza 1b the WHOLE aesthetic of
//! the slice as one runtime-switchable datum: palette, player-body colours,
//! lamp mood, lighting env, the sun + sky dome ([`rt_probe::SunSky`]), the
//! post stack ([`StyleCfg`]) and exposure, plus the dress switches
//! `gym_scene::build_gym` keys off. Same greybox discipline as ever
//! (coloured boxes, clean-lattice XZ dims); a look is a restyle, never new
//! render features.
//!
//! The ESC settings menu switches looks LIVE (scene rebuild + probe rebake,
//! disk-cached per look) — the owner's playtest hub (docs/VISION.md).
//! `LOOK=<name|index>` seeds the boot look for the agent/harness (a
//! shell-only env read, like AUDIO — see rt-probe config.rs); individual
//! style env vars (GRADE, SAT, …) override on top via `StyleCfg::env_over`.
//!
//! The pre-reset looks (classic/gaslight/timbered/inkwash/bastion/adobe/
//! edo/scifi/neon — the dirt-era directions) were deleted with the joyful
//! reset (owner directive 2026-07-12); they live under the git tag
//! `archive/town-testbed` and this commit's parents. The Faza-1c candidates
//! are authored against docs/VISION.md's anchors + `docs/concepts/`.

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
    /// The sun + sky dome as data (Faza 1b): direction, sun tint, sky
    /// gradient tints, void tint — golden hour vs noon vs pastel sky is
    /// LOOK data.
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

// ---- the Faza-1c joyful candidates ------------------------------------------
//
// Owner playtest pending: the pick + new goldens close Faza 1 (docs/VISION.md).
// Authored against docs/VISION.md's three anchors + docs/concepts/:
//   tecta     — golden hour (the concept paintings, literally)
//   meadow    — słoneczny dzień (the trip paintings: green valley, big sky)
//   porcelain — biel + akcent (white ceramic, one amber accent)
//   sorbet    — cukierkowe pastele (high-key candy palette)
// All four are SUN-ON daylight looks; they differ in sun angle/temperature,
// sky tints, palette and post — every axis is data (Faza 1b).

/// The concept paintings (docs/concepts/, owner directive 2026-07-12): one
/// white concrete monolith in a golden field, warm LOW sun, long soft
/// shadows, dark window slots as the only facade rhythm, huge warm sky.
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
    lighting: [0.85, 3.8, 0.06, 0.45], // strong key, softer fill — golden hour
    sun: SunSky {
        sun_dir: [0.80, 0.28, 0.45],        // ~16° elevation: the long shadows
        sun_rgb: [1.0, 0.74, 0.46],         // golden key light
        horizon_rgb: [0.97, 0.84, 0.64],    // lit warm haze
        zenith_rgb: [0.38, 0.50, 0.80],     // dusty evening blue
        ground_rgb: [1.7, 1.25, 0.55],      // the sunlit field runs to the horizon
    },
    style: StyleCfg { sat: 1.3, contrast: 1.1, ..StyleCfg::CLEAN },
    exposure: 0.40,
    spec: 0.0,
    gloss: 0.85,
    bump: 0.7, // raw concrete
    bump_scale: 7.0,
    gi: 0.42,
    coat: [0.10, 0.34, 0.16, 1.0],
    hood: [0.06, 0.19, 0.09, 1.0],
    skin: [0.74, 0.58, 0.45, 1.0],
    legs: [0.30, 0.27, 0.22, 1.0],
    boots: [0.13, 0.11, 0.08, 1.0],
};

/// Słoneczny dzień (the trip paintings): fresh green field, white walls,
/// vivid błękit sky, late-morning sun — and a red-coated walker for the
/// complementary pop. The carefree-hike mood.
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
    timber: Some(0x3a3f35), // window slots stay — the facade rhythm
    plinth: Some(0xb0ab9c),
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

/// Biel + akcent: clean white ceramic everything, ONE amber accent (the
/// fascia + the lamps + the walker's boots), pale desaturated sky. The
/// restrained high-key direction (the year-2200 clean-ceramic guide).
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
    timber: None,
    plinth: Some(0xc4c0b6),
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

/// Cukierkowe pastele: mint ground, cream-pink walls, coral roof, butter
/// fascia, lavender plinth, periwinkle-pink sky. The saturated high-key
/// multi-colour anchor; a teal walker pops on mint + coral.
pub const SORBET: Look = Look {
    name: "sorbet",
    roof_style: RoofStyle::Ridged,
    street: 0x9adcac,
    street_alt: Some(0x90d4a2),
    room_floor: 0xf6e6a8,
    wall: 0xfae4da,
    roof: 0xf28468,
    roof_trim: 0xe87352,
    fascia: Some(0xf5d76e),
    timber: None,
    plinth: Some(0xb8a8d8),
    lamp_post: [0.28, 0.24, 0.30, 1.0],
    lamp_head: [0.55, 0.42, 0.45, 1.0],
    lamp_glow: [5.0, 3.8, 3.6, 1.0],
    lamp_tint: [1.0, 0.75, 0.70], // soft pink
    lamp_scale: 0.85,
    lighting: [0.7, 4.6, 0.03, 0.45],
    sun: SunSky {
        sun_dir: [0.50, 0.62, 0.40],
        sun_rgb: [1.0, 0.90, 0.82],         // faintly pink-warm
        horizon_rgb: [1.0, 0.86, 0.88],     // candy horizon
        zenith_rgb: [0.46, 0.56, 0.96],     // periwinkle
        ground_rgb: [1.5, 2.0, 1.6],        // minty void
    },
    style: StyleCfg { sat: 1.6, contrast: 1.08, ..StyleCfg::CLEAN },
    exposure: 0.43,
    spec: 0.0,
    gloss: 0.85,
    bump: 0.25, // frosted, not concrete
    bump_scale: 7.0,
    gi: 0.5,
    coat: [0.05, 0.30, 0.32, 1.0], // teal walker
    hood: [0.03, 0.18, 0.20, 1.0],
    skin: [0.74, 0.58, 0.45, 1.0],
    legs: [0.85, 0.80, 0.70, 1.0], // cream slacks
    boots: [0.30, 0.12, 0.16, 1.0], // berry boots
};

pub static LOOKS: &[&Look] = &[&TECTA, &MEADOW, &PORCELAIN, &SORBET];

pub fn by_name(name: &str) -> Option<&'static Look> {
    LOOKS.iter().find(|l| l.name == name).copied()
}

/// Resolve `LOOK` from the environment: a preset name or its menu index
/// (the ESC menu's env string prints the index, mirroring PROJ). Default:
/// tecta — the first joyful candidate (docs/concepts/).
pub fn from_env() -> &'static Look {
    let default = &TECTA;
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
