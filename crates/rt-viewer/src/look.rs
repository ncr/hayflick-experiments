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
    /// gradient tints — golden hour vs noon vs pastel sky is LOOK data.
    pub sun: SunSky,
    // ---- the post stack + exposure (Faza 1b: merged into the look)
    pub style: StyleCfg,
    pub exposure: f32,
    // ---- the player body (linear)
    pub coat: [f32; 4],
    pub hood: [f32; 4],
    pub skin: [f32; 4],
    pub legs: [f32; 4],
    pub boots: [f32; 4],
}

/// The historical sun/sky constants (pre-1b shader built-ins) as authored
/// data — `SunSky::default()`, spelled const so look literals can use it.
const SUN_LEGACY: SunSky = SunSky { sun_dir: [0.62, 0.55, 0.38], sun_rgb: [1.0, 0.88, 0.70], horizon_rgb: [0.80, 0.83, 0.90], zenith_rgb: [0.28, 0.45, 0.92] };

/// The concept paintings (docs/concepts/, owner directive 2026-07-12): one
/// white concrete monolith in a golden field, warm low sun, long soft
/// shadows, dark window slots as the only facade rhythm. The first joyful
/// Faza-1 candidate — sun ON (the old looks were lamp/sky only).
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
    sun: SUN_LEGACY,
    style: StyleCfg::CLEAN,
    exposure: 0.40,
    coat: [0.10, 0.34, 0.16, 1.0],
    hood: [0.06, 0.19, 0.09, 1.0],
    skin: [0.74, 0.58, 0.45, 1.0],
    legs: [0.30, 0.27, 0.22, 1.0],
    boots: [0.13, 0.11, 0.08, 1.0],
};

pub static LOOKS: &[&Look] = &[&TECTA];

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
