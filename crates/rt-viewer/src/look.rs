//! THE greybox look of the gym — since Faza 1b the WHOLE aesthetic of the
//! slice as one datum: palette, player-body colours, lamp mood, lighting
//! env, the sun + sky dome ([`rt_probe::SunSky`]), the post stack
//! ([`StyleCfg`]), exposure, surface response, plus the dress switches
//! `gym_scene::build_gym` keys off. Same greybox discipline as ever
//! (coloured boxes, clean-lattice XZ dims); a look is a restyle, never new
//! render features.
//!
//! Since the owner's polana pick (2026-07-12) there is ONE look: [`POLANA`]
//! — porcelain × meadow. Super-clean porcelain volumes (minimal bump,
//! slight sheen), lush saturated greens and sky, the facade rhythm as clean
//! panels with occasional FULL-HEIGHT black tinted-glass windows (real
//! transmission — see gym_scene/shade), one amber accent, red-coat walker.
//! The A/B parents (`porcelain`, `meadow`) and every earlier candidate live
//! in git history only; the ESC-menu look row went with them (nothing left
//! to compare — docs/VISION.md keeps the menu-first rule for real choices).
//!
//! The runtime-switch machinery (backend `rebuild_scene`) stays: it is how
//! any future look variant gets its menu row back, and the harness knob
//! `LOOK_SWITCH=polana` force-rebuilds INTO the booted look — a SHOT after
//! it must match a direct boot at the Metal cross-run noise floor, which
//! pins the whole rebuild path (scene swap, probe rebake, light re-join).
//! `LOOK=<name|index>` still seeds the boot look for the agent/harness;
//! individual style env vars (GRADE, SAT, …) override via
//! [`StyleCfg::env_over`].

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
    /// `Some` = FULL-HEIGHT tinted-glass windows on building walls (owner
    /// directive 2026-07-12, refined same day: porcelain panels with a
    /// window only every so often — even world-coordinate cells). The hex
    /// is the pane's TRANSMISSION tint: real openings in the wall, the
    /// shade pass carries the primary ray through (black tinted but
    /// transparent). Occluder-marked so the WALLCUT takes them with the
    /// wall.
    pub window: Option<u32>,
    /// `Some` = skirting plinth along wall bases (below the WALLCUT — it
    /// stays in the cutaway and grounds the wall stubs). Breaks at window
    /// openings: the glass runs floor-to-top.
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
/// near-white ceramic volumes with a slight sheen, occasional full-height
/// black tinted-glass windows as the only facade rhythm, one amber accent,
/// lush saturated meadow greens with grass-tuft dress, big błękit sky,
/// red-coat walker.
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
    window: Some(0x60666c), // smoked-glass TRANSMISSION tint (~13% linear)
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

pub static LOOKS: &[&Look] = &[&POLANA];

pub fn by_name(name: &str) -> Option<&'static Look> {
    LOOKS.iter().find(|l| l.name == name).copied()
}

/// Resolve `LOOK` from the environment: a preset name or its index. With
/// polana as the only look this is a validity gate more than a choice —
/// the knob stays so harness command lines survive future look variants.
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
