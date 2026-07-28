//! THE greybox look of the gym — since Faza 1b the WHOLE aesthetic of the
//! slice as one datum: palette, player-body colours, lamp mood, lighting
//! env, the sun + sky dome ([`rt_probe::SunSky`]), the post stack
//! ([`StyleCfg`]), exposure, surface response, plus the dress switches
//! `gym_scene::build_gym` keys off. Same greybox discipline as ever
//! (coloured boxes, clean-lattice XZ dims); a look is a restyle, never new
//! render features.
//!
//! The owner's pick (2026-07-12) is [`POLANA`] — porcelain × meadow — THE
//! locked look. On the voxel-physics-spike branch it gains a sibling
//! [`DUSK`]: the same porcelain greybox re-lit for golden hour (dim dusk
//! dome + warm raking key) so the dynamic-GI roof-tear has a dark interior
//! to flood. Two looks ⇒ the ESC menu look row is back (menu-first rule).
//! Super-clean porcelain volumes (minimal bump,
//! slight sheen — greens stay MATTE via the material bit), lush saturated
//! greens and sky, the facade rhythm as clean panels with occasional
//! FULL-HEIGHT black tinted-glass windows (real transmission — see
//! gym_scene/shade), amber lamp mood, red-coat walker.
//! The A/B parents (`porcelain`, `meadow`) and every earlier candidate live
//! in git history only. The ESC-menu look row went with them when [`POLANA`]
//! stood alone, and came BACK with [`DUSK`] — the menu-first rule, working as
//! designed: `menu`'s own test pin fails the build while `LOOKS.len() > 1` and
//! there is no row (docs/VISION.md).
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

/// One visual direction, fully data. Architecture colours are sRGB hex
/// (through `hex_linear`); body and lamp colours are linear f32 (authored
/// linear historically). Since the 2026-07-12 blocky mesh rebuild (owner:
/// prostsze kształty, blokowość jak tecta) a look carries NO trim switches
/// — no fascia, plinth or ridge — the meshes are the fewest boxes that
/// read, and the look is colours + light + response.
pub struct Look {
    pub name: &'static str,
    // ---- architecture
    pub street: u32,
    /// `Some` = per-cell checker on Outdoor cells (breaks the floor
    /// row-run merge into per-cell quads — fine at gym scale).
    pub street_alt: Option<u32>,
    pub room_floor: u32,
    pub wall: u32,
    pub roof: u32,
    /// `Some` = FULL-HEIGHT tinted-glass windows on building walls (owner
    /// directive 2026-07-12, refined same day: porcelain panels with a
    /// window only every so often — even world-coordinate cells). The hex
    /// is the pane's TRANSMISSION tint: real openings in the wall, the
    /// shade pass carries the primary ray through (black tinted but
    /// transparent). Occluder-marked so the WALLCUT takes them with the
    /// wall.
    pub window: Option<u32>,
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
    /// CONTOUR COVERAGE AA (owner 2026-07-25): the weight each of the four
    /// fixed sub-pixel coverage rays carries against the centre sample, on
    /// CONTOUR texels only — flat interiors, clean pixel stairs and painted
    /// detail stay one sample per texel and bit-identical. 0 = fully aliased
    /// (the pre-2026-07-25 image), 1 = the unbiased 5-sample box.
    pub aa: f32,
    // ---- the player body (linear)
    pub coat: [f32; 4],
    pub hood: [f32; 4],
    pub skin: [f32; 4],
    pub legs: [f32; 4],
    pub boots: [f32; 4],
}

/// THE look (owner pick 2026-07-12): porcelain × meadow. Super-clean
/// near-white ceramic monoliths with a slight sheen, occasional full-height
/// black tinted-glass windows as the only facade rhythm, lush saturated
/// meadow greens (MATTE by construction — grass never shines) with
/// grass-tuft dress, big błękit sky, red-coat walker. The amber accent
/// lives in the lamp mood since the blocky rebuild dropped the fascia.
pub const POLANA: Look = Look {
    name: "polana",
    street: 0x74b048,
    street_alt: Some(0x6ca343),
    room_floor: 0xf0ede5,
    wall: 0xfbf9f5,
    roof: 0xf1efe9,
    window: Some(0x60666c), // smoked-glass TRANSMISSION tint (~13% linear)
    grass: Some([0x5f9c3a, 0x82c455, 0x4c8a30]),
    lamp_post: [0.32, 0.32, 0.31, 1.0],
    lamp_head: [0.60, 0.45, 0.22, 1.0],
    lamp_glow: [5.5, 3.8, 1.6, 1.0],
    lamp_tint: [1.0, 0.72, 0.35], // amber
    lamp_scale: 0.9,
    lighting: [0.80, 4.6, 0.03, 0.5],
    sun: SunSky {
        // late morning, soft mid shadows. Azimuth balanced toward the SOUTH
        // (the long facades the trimetric camera actually sees) so the clean
        // warm-white key — not the green bounce — paints the porcelain, and
        // shadows pool toward the camera (owner 2026-07-12: walls must read
        // white, not gray-green).
        sun_dir: [0.45, 0.62, 0.55],
        sun_rgb: [1.0, 0.96, 0.87],         // clean warm-white key
        horizon_rgb: [1.04, 1.0, 0.94],     // warm-white haze: the camera-side
        // facades are SHADE-side — horizon light is what paints them, so it
        // must read porcelain, not blue-gray (owner 2026-07-12)
        zenith_rgb: [0.28, 0.55, 1.0],      // the big błękit
        ground_rgb: [0.8, 1.25, 0.42],      // the lush field keeps rolling
    },
    style: StyleCfg { sat: 1.42, contrast: 1.1, ..StyleCfg::CLEAN },
    exposure: 0.43,
    spec: 0.12, // the ceramic sheen…
    gloss: 0.9,
    bump: 0.1, // …on near-smooth porcelain (minimal bumps — owner)
    bump_scale: 7.0,
    gi: 0.5,
    aa: 0.8,
    coat: [0.42, 0.10, 0.08, 1.0], // the red-coat walker (from meadow)
    hood: [0.26, 0.05, 0.04, 1.0],
    skin: [0.74, 0.58, 0.45, 1.0],
    legs: [0.80, 0.75, 0.65, 1.0], // cream slacks
    boots: [0.10, 0.10, 0.11, 1.0],
};

/// The dusk sibling of polana (voxel-physics-spike): the SAME porcelain
/// greybox re-lit for golden hour — a low warm raking key, a DIM indigo
/// dusk dome, warm amber lamp pools as the hero interior light. It exists
/// to make the dynamic-GI roof-tear POP: with the sky ambient pulled right
/// down (4.6 → 1.3) the roofed interior sits dark and moody, so dropping
/// the roof floods it with warm sun the same frame and the DDGI bounce
/// settles in behind. The demo-winning contrast (strong sun, dim sky) is
/// baked into `lighting` here — no SUN/SKY/LIGHTS env knobs needed.
pub const DUSK: Look = Look {
    name: "dusk",
    // architecture: dusky-green meadow, porcelain volumes read cool in the
    // low light (the sun paints the warm on lit faces). Same greybox as
    // polana — a look is a re-light, never new geometry.
    street: 0x3f5a34,
    street_alt: Some(0x385230),
    room_floor: 0xd0cbc0,
    wall: 0xece7de,
    roof: 0xe0dbd3,
    window: Some(0x50565c), // same smoked-glass tint
    grass: Some([0x3f6b2a, 0x59853b, 0x33591f]),
    lamp_post: [0.30, 0.30, 0.29, 1.0],
    lamp_head: [0.64, 0.47, 0.22, 1.0],
    lamp_glow: [6.4, 4.1, 1.7, 1.0], // warm pools — the dark room's hero light
    lamp_tint: [1.0, 0.66, 0.28],    // deeper amber than polana
    lamp_scale: 0.9,
    // strong warm sun, DIM dusk dome. The sun is the flood (the shader weights
    // the sun key ~6x the sky dome) and it's kept HIGH so it pours through a
    // torn roof onto the floor rather than raking the walls; the dim indigo
    // dome keeps the outdoor moody and the roofed interior lamp-lit. (The
    // roofed floor is pinned by the doorway sun-spill + lamp bounce — no
    // lighting knob darkens it further, so the mood comes from exposure.)
    lighting: [1.25, 0.55, 0.05, 0.5],
    sun: SunSky {
        // LOW golden-hour key (~27° elevation): long raking evening shadows.
        // A dusk sun can't flood a full-height walled roofless room from
        // straight above, so the tear reveal is a bold warm BLADE raking
        // across the floor + the room opening to the sky, not a flat pour —
        // more evening-like anyway. Southward azimuth as polana (lit facades
        // face the camera, long shadows pool toward it).
        sun_dir: [0.46, 0.37, 0.56],
        sun_rgb: [1.0, 0.78, 0.50],      // warm golden key (bright, not orange)
        horizon_rgb: [1.18, 0.66, 0.36], // sunset band paints the shade-side
        zenith_rgb: [0.10, 0.17, 0.44],  // deep indigo dusk dome
        ground_rgb: [0.34, 0.30, 0.16],  // dim warm field bounce
    },
    style: StyleCfg { sat: 1.36, contrast: 1.18, ..StyleCfg::CLEAN },
    exposure: 0.42, // pulled down from polana's 0.43-ish for the dusk mood
    spec: 0.12,
    gloss: 0.9,
    bump: 0.1,
    bump_scale: 7.0,
    gi: 0.5,
    aa: 0.8,
    coat: [0.42, 0.10, 0.08, 1.0],
    hood: [0.26, 0.05, 0.04, 1.0],
    skin: [0.74, 0.58, 0.45, 1.0],
    legs: [0.80, 0.75, 0.65, 1.0],
    boots: [0.10, 0.10, 0.11, 1.0],
};

pub static LOOKS: &[&Look] = &[&POLANA, &DUSK];

pub fn by_name(name: &str) -> Option<&'static Look> {
    LOOKS.iter().find(|l| l.name == name).copied()
}

/// The per-frame "lightable" half of a look: everything a demo morph
/// ([`crate::demos`]) can cross-fade WITHOUT a scene rebuild — sun/sky
/// (packed into the per-frame `EnvBlock`), exposure, the post sat+contrast,
/// and the surface response. The palette (albedos, lamp/body colours) is
/// baked into the scene, so it stays at the demo's boot look; a full palette
/// morph would need per-frame material re-upload (a later step).
pub struct Lit {
    pub lighting: [f32; 4],
    pub sun: SunSky,
    pub exposure: f32,
    pub sat: f32,
    pub contrast: f32,
    pub spec: f32,
    pub gloss: f32,
    pub bump: f32,
    pub bump_scale: f32,
    pub gi: f32,
}

fn lf(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}
fn l3(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    [lf(a[0], b[0], t), lf(a[1], b[1], t), lf(a[2], b[2], t)]
}

/// Lerp the lightable half of two looks at `t` in `0..=1` (see [`Lit`]). The
/// demo morph runner drives `t` from the sim tick, so it's deterministic and
/// renders headlessly frame-for-frame.
pub fn lerp_lit(a: &Look, b: &Look, t: f32) -> Lit {
    let t = t.clamp(0.0, 1.0);
    Lit {
        lighting: [
            lf(a.lighting[0], b.lighting[0], t),
            lf(a.lighting[1], b.lighting[1], t),
            lf(a.lighting[2], b.lighting[2], t),
            lf(a.lighting[3], b.lighting[3], t),
        ],
        sun: SunSky {
            sun_dir: l3(a.sun.sun_dir, b.sun.sun_dir, t),
            sun_rgb: l3(a.sun.sun_rgb, b.sun.sun_rgb, t),
            horizon_rgb: l3(a.sun.horizon_rgb, b.sun.horizon_rgb, t),
            zenith_rgb: l3(a.sun.zenith_rgb, b.sun.zenith_rgb, t),
            ground_rgb: l3(a.sun.ground_rgb, b.sun.ground_rgb, t),
        },
        exposure: lf(a.exposure, b.exposure, t),
        sat: lf(a.style.sat, b.style.sat, t),
        contrast: lf(a.style.contrast, b.style.contrast, t),
        spec: lf(a.spec, b.spec, t),
        gloss: lf(a.gloss, b.gloss, t),
        bump: lf(a.bump, b.bump, t),
        bump_scale: lf(a.bump_scale, b.bump_scale, t),
        gi: lf(a.gi, b.gi, t),
    }
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
