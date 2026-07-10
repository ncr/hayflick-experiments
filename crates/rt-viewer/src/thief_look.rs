//! Greybox LOOK presets for the thief scene — the whole aesthetic of the
//! slice as data: palette, body colours, lamp mood, lighting env, and the
//! shape-kit switches `thief_scene::build_thief` keys off. Same greybox
//! discipline as ever (coloured boxes, 0.0625-wu XZ lattice); a look is a
//! restyle, never new render features.
//!
//! `LOOK=<name>` selects a preset (a shell-only env read, like DOORS /
//! DUMP_ROOMS / AUDIO — see rt-probe config.rs). Default is `classic`, which
//! reproduces the pre-look-system geometry byte-for-byte, so the pinned
//! thief golden holds until a direction is chosen.
//!
//! Hue discipline: the sim NARRATES the player's coat ("a green-hooded
//! figure…", perception's `Hue::Green`/`Hue::Brown`), so every preset must
//! keep outfit A readably green and outfit B readably brown. Guards stay in
//! the cool steel-blue family across looks so "that's the watch" reads
//! instantly regardless of palette.

/// Which geometry kit the builder emits. `Legacy` is the pre-look greybox,
/// frozen for the golden; `Refined` is the upgraded kit (plinths, roof
/// dressing, slim lamp posts, tailored bodies) all new looks share.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kit {
    Legacy,
    Refined,
}

/// Roof silhouette for Room-cell caps (all variants stay above the 2.25
/// FLOORCUT plane and occluder-marked, so both dollhouse cuts remove them).
/// An eave fascia is a separate switch ([`ThiefLook::fascia`]) — it combines
/// with either style.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum RoofStyle {
    /// The legacy flat cap (classic; inkwash keeps it as a graphic ink block).
    FlatCap,
    /// Flat cap + a raised `roof_trim` strip per row — reads as standing
    /// seams / tiled ridges and breaks up big roof expanses.
    Ridged,
}

/// One visual direction, fully data. Architecture colours are sRGB hex
/// (through `hex_linear`, like the level palettes everywhere else); body and
/// lamp colours are linear f32 (the classic constants were authored linear).
pub struct ThiefLook {
    pub name: &'static str,
    pub kit: Kit,
    pub roof_style: RoofStyle,
    // ---- architecture
    pub street: u32,
    /// `Some` = per-cell cobble checker on Outdoor cells (breaks the floor
    /// row-run merge into per-cell quads on streets — fine at spine scale;
    /// revisit the merge before M3's big towns).
    pub street_alt: Option<u32>,
    pub room_floors: [u32; 4],
    pub wall: u32,
    pub sill: u32,
    pub roof: u32,
    /// Ridge strip colour (RoofStyle::Ridged).
    pub roof_trim: u32,
    /// `Some` = an eave fascia lip under the cap, slightly wider than it.
    pub fascia: Option<u32>,
    pub door: u32,
    /// `Some` = half-timber frame: posts on every wall-run cell boundary +
    /// a lintel-height rail, occluder-marked so the WALLCUT takes them.
    pub timber: Option<u32>,
    /// `Some` = skirting plinth along wall bases (below the WALLCUT — it
    /// stays in the cutaway and grounds the wall stubs).
    pub plinth: Option<u32>,
    pub furn: u32,
    pub hay: u32,
    /// Refined-kit guards carry a spear (period looks); false = hands free
    /// (sci-fi / cyberpunk security reads wrong with a polearm).
    pub guard_polearm: bool,
    // ---- lamps (fixture colours + the named point light's tint/strength)
    pub lamp_post: [f32; 4],
    pub lamp_head: [f32; 4],
    pub lamp_glow: [f32; 4],
    pub lamp_tint: [f32; 3],
    pub lamp_scale: f32,
    // ---- lighting env [sun, sky, fog, fog_h] (scene.lighting)
    pub lighting: [f32; 4],
    // ---- bodies (linear)
    pub coat_green: [f32; 4],
    pub hood_green: [f32; 4],
    pub coat_brown: [f32; 4],
    pub skin: [f32; 4],
    pub legs: [f32; 4],
    pub boots: [f32; 4],
    pub npc_legs: [f32; 4],
    pub guard_coat: [f32; 4],
    pub guard_helm: [f32; 4],
    pub civ_coat: [f32; 4],
}

/// The pre-look-system greybox, verbatim: pale stone streets, near-white
/// walls, coral doors, flat caps, chunky bodies. Byte-identical geometry —
/// the pinned thief golden renders THIS.
pub const CLASSIC: ThiefLook = ThiefLook {
    name: "classic",
    kit: Kit::Legacy,
    roof_style: RoofStyle::FlatCap,
    street: 0xcfcbc2,
    street_alt: None,
    room_floors: [0xfbe9b6, 0xfcd4e0, 0xccd4fb, 0xbdf2da],
    wall: 0xf6f2e8,
    sill: 0xe8e2d4,
    roof: 0x8a7a62,
    roof_trim: 0x8a7a62,
    fascia: None,
    door: 0xff7a4d,
    timber: None,
    plinth: None,
    furn: 0xe39a6b,
    hay: 0xe3c06b,
    guard_polearm: true,
    lamp_post: [0.16, 0.17, 0.18, 1.0],
    lamp_head: [0.30, 0.24, 0.12, 1.0],
    lamp_glow: [5.5, 4.2, 2.2, 1.0],
    lamp_tint: [1.0, 0.82, 0.58],
    lamp_scale: 1.0,
    lighting: [0.0, 5.5, 0.22, 0.42],
    coat_green: [0.16, 0.42, 0.20, 1.0],
    hood_green: [0.09, 0.24, 0.12, 1.0],
    coat_brown: [0.45, 0.30, 0.18, 1.0],
    skin: [0.75, 0.60, 0.48, 1.0],
    legs: [0.32, 0.30, 0.26, 1.0],
    boots: [0.14, 0.12, 0.10, 1.0], // unused by the Legacy kit
    npc_legs: [0.22, 0.20, 0.18, 1.0],
    guard_coat: [0.22, 0.32, 0.58, 1.0],
    guard_helm: [0.55, 0.58, 0.62, 1.0],
    civ_coat: [0.66, 0.52, 0.28, 1.0],
};

/// Wet cobbles & gas lamps: a dark-stone port town, desaturated cool darks
/// so the warm gas flames (and the verdigris doors) carry the frame. The
/// nocturne stealth mood — night phases go properly theatrical.
pub const GASLIGHT: ThiefLook = ThiefLook {
    name: "gaslight",
    kit: Kit::Refined,
    roof_style: RoofStyle::Ridged,
    street: 0x686d76,
    street_alt: Some(0x5e636c),
    room_floors: [0x8a6f55, 0x757a6a, 0x806876, 0x657585],
    wall: 0x8d95a4,
    sill: 0xc2bdb0,
    roof: 0x45474d,
    roof_trim: 0x53555c,
    fascia: Some(0xa39e90),
    door: 0x4cc2a7,
    timber: None,
    plinth: Some(0x707580),
    furn: 0x7a5c40,
    hay: 0xb99a56,
    guard_polearm: true,
    lamp_post: [0.05, 0.055, 0.06, 1.0],
    lamp_head: [0.32, 0.22, 0.10, 1.0],
    lamp_glow: [7.5, 5.0, 2.2, 1.0],
    lamp_tint: [1.0, 0.72, 0.42],
    lamp_scale: 1.35,
    lighting: [0.0, 5.0, 0.32, 0.5],
    coat_green: [0.05, 0.16, 0.09, 1.0],
    hood_green: [0.03, 0.09, 0.05, 1.0],
    coat_brown: [0.16, 0.10, 0.06, 1.0],
    skin: [0.55, 0.42, 0.32, 1.0],
    legs: [0.10, 0.10, 0.11, 1.0],
    boots: [0.05, 0.045, 0.04, 1.0],
    npc_legs: [0.09, 0.085, 0.08, 1.0],
    guard_coat: [0.08, 0.12, 0.24, 1.0],
    guard_helm: [0.35, 0.38, 0.42, 1.0],
    civ_coat: [0.30, 0.20, 0.12, 1.0],
};

/// Market town: cream plaster + dark half-timber, terracotta ridged roofs,
/// sandy cobbles, cobalt doors. Warm, cozy, painterly daylight.
pub const TIMBERED: ThiefLook = ThiefLook {
    name: "timbered",
    kit: Kit::Refined,
    roof_style: RoofStyle::Ridged,
    street: 0xb5a284,
    street_alt: Some(0xab9878),
    room_floors: [0xc98f5a, 0xd9b47a, 0xb7794a, 0xcfa66a],
    wall: 0xf2e4c8,
    sill: 0xd9cba8,
    roof: 0xb35c3e,
    roof_trim: 0x9d4e33,
    fascia: Some(0x4a3626),
    door: 0x3a6bc4,
    timber: Some(0x4a3626),
    plinth: Some(0x8d7f66),
    furn: 0x9a6a3c,
    hay: 0xd8b45e,
    guard_polearm: true,
    lamp_post: [0.09, 0.09, 0.10, 1.0],
    lamp_head: [0.35, 0.26, 0.12, 1.0],
    lamp_glow: [5.5, 4.4, 2.4, 1.0],
    lamp_tint: [1.0, 0.80, 0.52],
    lamp_scale: 1.0,
    lighting: [0.0, 6.2, 0.20, 0.42],
    coat_green: [0.14, 0.38, 0.14, 1.0],
    hood_green: [0.08, 0.20, 0.08, 1.0],
    coat_brown: [0.38, 0.22, 0.11, 1.0],
    skin: [0.78, 0.60, 0.45, 1.0],
    legs: [0.28, 0.24, 0.20, 1.0],
    boots: [0.12, 0.08, 0.05, 1.0],
    npc_legs: [0.24, 0.20, 0.16, 1.0],
    guard_coat: [0.20, 0.30, 0.55, 1.0],
    guard_helm: [0.60, 0.62, 0.66, 1.0],
    civ_coat: [0.62, 0.44, 0.22, 1.0],
};

/// Printmaker's town: warm parchment + bone walls, every trim in charcoal
/// ink (the cutaway reads as a drawn floorplan), vermillion doors as the
/// single accent, figures near-ink. Built for the dither.
pub const INKWASH: ThiefLook = ThiefLook {
    name: "inkwash",
    kit: Kit::Refined,
    roof_style: RoofStyle::FlatCap,
    street: 0xd8d0bc,
    street_alt: None,
    room_floors: [0xcfc4a8, 0xc9beb4, 0xbfc4b2, 0xc6bcc8],
    wall: 0xe8e0cc,
    sill: 0x3a3835,
    roof: 0x35322e,
    roof_trim: 0x35322e,
    fascia: Some(0xd8d0bc),
    door: 0xd4472a,
    timber: Some(0x3a3835),
    plinth: Some(0x55524c),
    furn: 0x8a7f6c,
    hay: 0xcdbd8a,
    guard_polearm: true,
    lamp_post: [0.045, 0.043, 0.04, 1.0],
    lamp_head: [0.30, 0.26, 0.16, 1.0],
    lamp_glow: [5.0, 4.2, 2.6, 1.0],
    lamp_tint: [1.0, 0.85, 0.60],
    lamp_scale: 0.9,
    lighting: [0.0, 5.8, 0.30, 0.55],
    coat_green: [0.10, 0.20, 0.11, 1.0],
    hood_green: [0.06, 0.11, 0.07, 1.0],
    coat_brown: [0.24, 0.15, 0.08, 1.0],
    skin: [0.70, 0.58, 0.42, 1.0],
    legs: [0.15, 0.14, 0.13, 1.0],
    boots: [0.08, 0.08, 0.08, 1.0],
    npc_legs: [0.13, 0.125, 0.12, 1.0],
    guard_coat: [0.12, 0.15, 0.22, 1.0],
    guard_helm: [0.72, 0.70, 0.64, 1.0],
    civ_coat: [0.35, 0.31, 0.26, 1.0],
};

/// Medieval stone keep-town: grey fieldstone, weathered oak-shingle roofs,
/// granite setts, oxblood doors, torch-warm lamps. The period direction.
pub const BASTION: ThiefLook = ThiefLook {
    name: "bastion",
    kit: Kit::Refined,
    roof_style: RoofStyle::Ridged,
    street: 0x8d8a82,
    street_alt: Some(0x83807a),
    room_floors: [0x9c7a4e, 0x8a8578, 0x7d5a4a, 0x6f7a58],
    wall: 0xa8a49a,
    sill: 0xc8c2b2,
    roof: 0x6b5138,
    roof_trim: 0x59422c,
    fascia: Some(0x4f3d2a),
    door: 0x9e3a2c,
    timber: None,
    plinth: Some(0x7a766c),
    furn: 0x8a6a42,
    hay: 0xc4a45e,
    guard_polearm: true,
    lamp_post: [0.06, 0.055, 0.05, 1.0],
    lamp_head: [0.30, 0.20, 0.08, 1.0],
    lamp_glow: [6.5, 4.0, 1.6, 1.0],
    lamp_tint: [1.0, 0.62, 0.30],
    lamp_scale: 1.2,
    lighting: [0.0, 5.2, 0.26, 0.45],
    coat_green: [0.12, 0.30, 0.14, 1.0],
    hood_green: [0.07, 0.17, 0.08, 1.0],
    coat_brown: [0.32, 0.20, 0.10, 1.0],
    skin: [0.72, 0.56, 0.42, 1.0],
    legs: [0.24, 0.22, 0.19, 1.0],
    boots: [0.10, 0.08, 0.06, 1.0],
    npc_legs: [0.20, 0.18, 0.15, 1.0],
    guard_coat: [0.24, 0.30, 0.44, 1.0],
    guard_helm: [0.52, 0.54, 0.58, 1.0],
    civ_coat: [0.52, 0.40, 0.24, 1.0],
};

/// Desert kasbah: sun-baked adobe, flat earthen roofs, sandy lanes, saffron
/// doors, linen-clad figures. Bright, dry, high-key daylight.
pub const ADOBE: ThiefLook = ThiefLook {
    name: "adobe",
    kit: Kit::Refined,
    roof_style: RoofStyle::FlatCap,
    street: 0xcdb289,
    street_alt: Some(0xc3a87e),
    room_floors: [0xb97a4e, 0x5d6b8f, 0xc9974e, 0x9a8a68],
    wall: 0xd9a86e,
    sill: 0xe8d9b8,
    roof: 0xb98a52,
    roof_trim: 0xb98a52,
    fascia: Some(0xe0cfa8),
    door: 0xe8a01c,
    timber: None,
    plinth: Some(0xb98f5e),
    furn: 0xa87848,
    hay: 0xdec27e,
    guard_polearm: true,
    lamp_post: [0.10, 0.08, 0.06, 1.0],
    lamp_head: [0.38, 0.28, 0.14, 1.0],
    lamp_glow: [5.0, 3.9, 2.2, 1.0],
    lamp_tint: [1.0, 0.82, 0.55],
    lamp_scale: 0.95,
    lighting: [0.0, 6.5, 0.16, 0.4],
    coat_green: [0.13, 0.34, 0.16, 1.0],
    hood_green: [0.07, 0.19, 0.09, 1.0],
    coat_brown: [0.40, 0.24, 0.12, 1.0],
    skin: [0.62, 0.45, 0.32, 1.0],
    legs: [0.75, 0.68, 0.55, 1.0],
    boots: [0.28, 0.18, 0.10, 1.0],
    npc_legs: [0.70, 0.62, 0.48, 1.0],
    guard_coat: [0.22, 0.30, 0.50, 1.0],
    guard_helm: [0.65, 0.60, 0.48, 1.0],
    civ_coat: [0.80, 0.72, 0.58, 1.0],
};

/// Edo machiya lane: shoji-paper walls ruled by dark cedar posts, charcoal
/// tile roofs, raked gravel, indigo noren doors, paper lanterns.
pub const EDO: ThiefLook = ThiefLook {
    name: "edo",
    kit: Kit::Refined,
    roof_style: RoofStyle::Ridged,
    street: 0xb0aca0,
    street_alt: None,
    room_floors: [0xc8b878, 0x5a4632, 0x44506e, 0xd8d2c0],
    wall: 0xe8e4d8,
    sill: 0x3a2f26,
    roof: 0x3c3c40,
    roof_trim: 0x2e2e33,
    fascia: Some(0x3a2f26),
    door: 0x35427a,
    timber: Some(0x3a2f26),
    plinth: Some(0x4a4038),
    furn: 0x8a6a48,
    hay: 0xcdbd8a,
    guard_polearm: true,
    lamp_post: [0.06, 0.05, 0.045, 1.0],
    lamp_head: [0.50, 0.42, 0.28, 1.0],
    lamp_glow: [4.6, 3.8, 2.2, 1.0],
    lamp_tint: [1.0, 0.78, 0.50],
    lamp_scale: 1.0,
    lighting: [0.0, 5.6, 0.24, 0.45],
    coat_green: [0.10, 0.26, 0.13, 1.0],
    hood_green: [0.06, 0.14, 0.07, 1.0],
    coat_brown: [0.30, 0.19, 0.10, 1.0],
    skin: [0.76, 0.60, 0.46, 1.0],
    legs: [0.16, 0.16, 0.18, 1.0],
    boots: [0.08, 0.08, 0.09, 1.0],
    npc_legs: [0.14, 0.15, 0.18, 1.0],
    guard_coat: [0.16, 0.20, 0.34, 1.0],
    guard_helm: [0.30, 0.30, 0.34, 1.0],
    civ_coat: [0.28, 0.32, 0.44, 1.0],
};

/// Colony station: white resin panels with structural ribs, gunmetal seam
/// roofs, deck-plate streets, safety-orange livery, cool white light.
pub const SCIFI: ThiefLook = ThiefLook {
    name: "scifi",
    kit: Kit::Refined,
    roof_style: RoofStyle::Ridged,
    street: 0x9aa0a8,
    street_alt: Some(0x8f959d),
    room_floors: [0xd8dce2, 0x6a707a, 0xa8c8bc, 0xc9a25e],
    wall: 0xe2e6ea,
    sill: 0x8b929c,
    roof: 0x545a64,
    roof_trim: 0x616874,
    fascia: Some(0xd86a1e),
    door: 0xe87820,
    timber: Some(0x565c66),
    plinth: Some(0x4a505a),
    furn: 0x7a828c,
    hay: 0xb8b09a,
    guard_polearm: false,
    lamp_post: [0.30, 0.32, 0.36, 1.0],
    lamp_head: [0.60, 0.65, 0.70, 1.0],
    lamp_glow: [4.5, 5.0, 5.6, 1.0],
    lamp_tint: [0.85, 0.92, 1.0],
    lamp_scale: 1.1,
    lighting: [0.0, 6.0, 0.14, 0.5],
    coat_green: [0.10, 0.36, 0.18, 1.0],
    hood_green: [0.06, 0.20, 0.10, 1.0],
    coat_brown: [0.34, 0.22, 0.12, 1.0],
    skin: [0.72, 0.56, 0.44, 1.0],
    legs: [0.55, 0.58, 0.62, 1.0],
    boots: [0.20, 0.22, 0.25, 1.0],
    npc_legs: [0.50, 0.53, 0.58, 1.0],
    guard_coat: [0.20, 0.28, 0.48, 1.0],
    guard_helm: [0.85, 0.88, 0.92, 1.0],
    civ_coat: [0.62, 0.64, 0.60, 1.0],
};

/// Cyberpunk backstreet: wet asphalt, raw concrete, cold cyan tube-light,
/// magenta livery stripes, cyan doors, techwear figures.
pub const NEON: ThiefLook = ThiefLook {
    name: "neon",
    kit: Kit::Refined,
    roof_style: RoofStyle::FlatCap,
    street: 0x3f4148,
    street_alt: Some(0x393b42),
    room_floors: [0x5a5e66, 0x6e4a6e, 0x3f5f6a, 0x66584a],
    wall: 0x6e737c,
    sill: 0x9aa0a8,
    roof: 0x2e3036,
    roof_trim: 0x3a3d44,
    fascia: Some(0xd6329a),
    door: 0x22c8d6,
    timber: None,
    plinth: Some(0x33353b),
    furn: 0x50545c,
    hay: 0x8a8468,
    guard_polearm: false,
    lamp_post: [0.04, 0.04, 0.05, 1.0],
    lamp_head: [0.20, 0.50, 0.55, 1.0],
    lamp_glow: [2.2, 6.5, 7.0, 1.0],
    lamp_tint: [0.55, 0.95, 1.0],
    lamp_scale: 1.5,
    lighting: [0.0, 3.8, 0.36, 0.55],
    coat_green: [0.07, 0.24, 0.12, 1.0],
    hood_green: [0.04, 0.13, 0.06, 1.0],
    coat_brown: [0.22, 0.13, 0.07, 1.0],
    skin: [0.60, 0.46, 0.36, 1.0],
    legs: [0.12, 0.12, 0.14, 1.0],
    boots: [0.06, 0.06, 0.07, 1.0],
    npc_legs: [0.10, 0.10, 0.12, 1.0],
    guard_coat: [0.10, 0.14, 0.28, 1.0],
    guard_helm: [0.25, 0.28, 0.34, 1.0],
    civ_coat: [0.28, 0.22, 0.26, 1.0],
};

pub static LOOKS: &[&ThiefLook] = &[&CLASSIC, &GASLIGHT, &TIMBERED, &INKWASH, &BASTION, &ADOBE, &EDO, &SCIFI, &NEON];

pub fn by_name(name: &str) -> Option<&'static ThiefLook> {
    LOOKS.iter().find(|l| l.name == name).copied()
}

/// Resolve `LOOK` from the environment (default: classic — the golden look).
pub fn from_env() -> &'static ThiefLook {
    match std::env::var("LOOK") {
        Ok(name) => by_name(&name).unwrap_or_else(|| {
            eprintln!("LOOK={name}: unknown preset (classic gaslight timbered inkwash bastion adobe edo scifi neon) — using classic");
            &CLASSIC
        }),
        Err(_) => &CLASSIC,
    }
}
