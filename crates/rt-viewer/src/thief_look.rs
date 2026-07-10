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

pub static LOOKS: &[&ThiefLook] = &[&CLASSIC, &GASLIGHT, &TIMBERED, &INKWASH];

pub fn by_name(name: &str) -> Option<&'static ThiefLook> {
    LOOKS.iter().find(|l| l.name == name).copied()
}

/// Resolve `LOOK` from the environment (default: classic — the golden look).
pub fn from_env() -> &'static ThiefLook {
    match std::env::var("LOOK") {
        Ok(name) => by_name(&name).unwrap_or_else(|| {
            eprintln!("LOOK={name}: unknown preset (classic gaslight timbered inkwash) — using classic");
            &CLASSIC
        }),
        Err(_) => &CLASSIC,
    }
}
