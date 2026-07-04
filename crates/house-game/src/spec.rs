//! LevelSpec — the single source of truth for a level (ARCHITECTURE.md):
//! ordered Vecs only (no HashMap iteration anywhere on the game side), so
//! spawning is deterministic by construction. For the new game scene the same
//! spec will generate BOTH collision and visual geometry (the scene builder
//! lives in rt-viewer's adapter); the game itself consumes only the
//! collision/semantic side here.

use glam::Vec3;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct RoomId(pub u32);
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct DoorId(pub u32);
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct LightId(pub u32);
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct TargetId(pub u32);
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct ItemId(pub u32);
/// Stable id for an NPC mob. Authored ids come from the spec; runtime-spawned
/// children (a goo blob splitting when shot) draw from a seeded monotonic
/// counter that starts above every authored id, so the two never collide and
/// iteration stays id-sorted regardless of archetype layout.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct MobId(pub u32);
/// Stable id for a live projectile (a physically-simulated shot). Drawn from a
/// seeded monotonic counter at fire time, so the projectile handle list stays
/// id-sorted regardless of hecs archetype layout (same discipline as MobId).
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct ProjectileId(pub u32);

/// What a world item restores when consumed. `Food` → hunger, `Battery` →
/// flashlight battery. Copy + Eq so it rides in `GameEvent` (which derives
/// Copy) and in the inventory Vec without lifetimes.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ItemKind {
    Food,
    Battery,
}

/// A pickup sitting on the floor. `id` is the StableId (iteration is id-sorted
/// everywhere, no HashMap), `kind` the consume effect, `pos` the world-XZ
/// centre (y is the floor; pickup is a flat XZ radius test).
#[derive(Clone, Copy, Debug)]
pub struct ItemSpec {
    pub id: ItemId,
    pub kind: ItemKind,
    pub pos: Vec3,
}

/// All the survival tuning for a level, in one struct so the lab can sweep it
/// (`Scenario` clones the LevelSpec; vary these fields per run). Needs are
/// f32 in 0..=1 and START FULL at 1.0. A level with `survival: None` spawns
/// NO needs/inventory/item components — it hashes and behaves exactly as
/// before this feature existed (the hash-stability invariant).
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct SurvivalParams {
    /// Hunger lost per tick (always; the clock of the run).
    pub hunger_decay: f32,
    /// Battery lost per tick WHILE the flashlight is on (zero while off).
    pub battery_drain: f32,
    /// A need is "critical" once it drops below this (edge-triggered event).
    pub critical: f32,
    /// Hunger restored by consuming one Food (clamped to 1.0).
    pub food_restore: f32,
    /// Battery restored by consuming one Battery (clamped to 1.0).
    pub battery_restore: f32,
    /// Max items the player can carry.
    pub inventory_cap: u32,
    /// World-XZ radius within which a WorldItem is auto-picked-up.
    pub pickup_radius: f32,
    /// Walk-speed multiplier applied while hunger == 0 (starving = sluggish).
    pub hunger_zero_speed_mul: f32,
}

impl Default for SurvivalParams {
    fn default() -> SurvivalParams {
        SURVIVAL_DEFAULT
    }
}

/// The canonical default tuning, as a const so the lab can name it without an
/// allocation and tests can reference exact numbers. ~60 s to empty hunger and
/// ~30 s of torch-on to empty battery at 60 fps; critical at the last fifth.
pub const SURVIVAL_DEFAULT: SurvivalParams = SurvivalParams {
    hunger_decay: 1.0 / 3600.0, // full → 0 in 3600 ticks (60 s @ 60 fps)
    battery_drain: 1.0 / 1800.0, // full → 0 in 1800 torch-on ticks (30 s)
    critical: 0.2,
    food_restore: 0.5,
    battery_restore: 0.5,
    inventory_cap: 8,
    pickup_radius: 0.4,
    hunger_zero_speed_mul: 0.5,
};

/// Practical-light animation family — maps 1:1 onto [`crate::flicker`]'s
/// numeric kinds (originally rt-probe render.rs compute_practicals). With the
/// kind in the spec, the renderer needs no hue-based kind heuristic: rt-viewer
/// consumes game-authored emission directly.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LightKind {
    Incandescent, // kind 1: value-noise flicker + breathing + rare dips
    Screen,       // kind 2: CRT throb + shimmer + hue wobble (ignores the wall switch)
    Drift,        // kind 3: gentle ceiling drift
}

impl LightKind {
    pub fn curve_kind(self) -> u32 {
        match self {
            LightKind::Incandescent => 1,
            LightKind::Screen => 2,
            LightKind::Drift => 3,
        }
    }
}

#[derive(Clone, Debug)]
pub struct RoomSpec {
    pub id: RoomId,
    pub floor_rect: [f32; 4], // xmin, zmin, xmax, zmax (walkable)
}

/// A hinged door filling a gap in an interior wall. `closed_solid` is the
/// leaf's collision footprint when shut; the hinge/axis/angle describe the
/// swing for the renderer (and the snapshot's per-door angle).
#[derive(Clone, Debug)]
pub struct DoorSpec {
    pub id: DoorId,
    pub hinge: Vec3,
    pub axis_y: f32,            // swing direction: +1 / -1 around world Y
    pub closed_solid: [f32; 4], // xmin, zmin, xmax, zmax
    pub open_angle: f32,        // radians at fully open
    pub anim_ticks: u32,        // ticks for a full open or close sweep (>= 1)
    pub name: String,           // join key to the renderer's named prim/light tables
}

#[derive(Clone, Debug)]
pub struct LightSpec {
    pub id: LightId,
    pub room: RoomId,
    pub kind: LightKind,
    pub base_rgb: [f32; 3],
    pub name: String,
}

/// Blob SPECIES — the arena's enemy-variety axis. `Green` is the baseline:
/// every kind multiplier is exactly 1.0, so pre-kind levels (all authored
/// Green) behave bit-identically to before the kind existed. `Runner` is
/// fast and twitchy and hunts the player from much further out; `Tank` is
/// slow and shrugs off small-arms fire (uzi/shotgun damage divided). The
/// renderer tints the body/light per kind (green / red / blue).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum GooKind {
    Green,
    Runner,
    Tank,
}

impl GooKind {
    /// Stable hash tag (enum discriminants are not order-stable; pin them).
    pub(crate) fn tag(self) -> u64 {
        match self {
            GooKind::Green => 0,
            GooKind::Runner => 1,
            GooKind::Tank => 2,
        }
    }
}

/// An authored NPC mob spawn: a gooey, splittable fluorescent blob crawling on
/// the floor. `tier` sizes it (0 = Large, 1 = Medium, 2 = Small); `kind` is
/// its species (behavior + resistances + tint); `pos` is the world-XZ centre
/// it spawns at (y is the floor — the blob hugs the ground).
#[derive(Clone, Copy, Debug)]
pub struct MobSpec {
    pub id: MobId,
    pub tier: u8,
    pub kind: GooKind,
    pub pos: Vec3,
}

/// A goo trap: a floor emitter that exerts an inverse-square gravitational pull
/// on nearby goo blobs (their particles AND their spine anchors, so the whole
/// creature gets dragged in if it strays within `radius`). `strength` scales
/// the pull; `radius` (wu) is the capture range outside which the trap is inert.
#[derive(Clone, Copy, Debug)]
pub struct TrapSpec {
    pub id: u32,
    pub pos: Vec3,
    pub strength: f32,
    pub radius: f32,
    /// Sim tick at which the trap goes permanently inert (0 = never expires).
    /// A timed hazard: e.g. a pulse that gathers blobs into a merge and then
    /// releases, so the survivor is free to crawl off instead of being held.
    pub off_tick: u32,
}

/// A shootable wall disc.
#[derive(Clone, Debug)]
pub struct TargetSpec {
    pub id: TargetId,
    pub center: Vec3,
    pub normal: Vec3,
    pub radius: f32,
}

/// Arena-mode tuning (the goo arena shooter). `Some` opts a level into the
/// arsenal: weapon selection (`Command::SelectWeapon`, keys 1–5), the arena
/// control scheme (the shell maps LMB to shoot instead of walk), kill
/// scoring, and the WAVE DIRECTOR (clear the floor → a bigger squad drops in
/// after `wave_lull`). A level with `arena: None` spawns none of it and
/// hashes exactly as before this feature existed (the `survival` discipline).
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct ArenaParams {
    /// Ticks of quiet between clearing the arena and the next wave landing.
    pub wave_lull: u16,
}

impl Default for ArenaParams {
    fn default() -> ArenaParams {
        ArenaParams { wave_lull: 120 }
    }
}

#[derive(Clone, Debug)]
pub struct LevelSpec {
    pub rooms: Vec<RoomSpec>,
    /// Interior walls + furniture footprints (xmin, zmin, xmax, zmax). The
    /// walkable floor is the bounding rect of `rooms` — interior structure is
    /// expressed as solids (matching the Level collision model).
    pub static_solids: Vec<[f32; 4]>,
    pub doors: Vec<DoorSpec>,
    pub lights: Vec<LightSpec>,
    pub targets: Vec<TargetSpec>,
    /// World pickups. EMPTY unless `survival` is `Some` — item entities are
    /// only spawned when survival is enabled (so a disabled level is unchanged).
    pub items: Vec<ItemSpec>,
    /// Survival tuning. `None` = survival OFF: no needs/inventory/item
    /// components spawn, nothing new enters state_hash or the snapshot.
    pub survival: Option<SurvivalParams>,
    /// Authored NPC mobs (goo blobs). EMPTY on the existing levels so they stay
    /// byte-identical: an empty `mobs` spawns no Goo entities, and the
    /// mob block is skipped in state_hash/snapshot (same discipline as items).
    pub mobs: Vec<MobSpec>,
    /// Goo traps (floor gravity emitters). EMPTY on the existing levels. Read by
    /// `goo_system` to pull nearby blobs; rendered as glowing floor rings.
    pub traps: Vec<TrapSpec>,
    /// Arena-shooter mode. `None` = arsenal OFF: no weapon-select state spawns,
    /// nothing new enters state_hash (same opt-in discipline as `survival`).
    pub arena: Option<ArenaParams>,
    /// The DRAIN zone (xmin, zmin, xmax, zmax): goo that reaches it ESCAPES —
    /// despawns and adds its tier mass to the breach meter; the meter full is
    /// the loss. `Some` turns the level into a containment stage (the goo
    /// seeks the drain, not you — only Runners and pacts still hunt). The
    /// wall in front of it is ordinary static_solids with slot gaps: slot
    /// width = squeeze time per tier, the sieve grammar.
    pub drain: Option<[f32; 4]>,
    /// Film-stage knob: tier-0 mothers do NOT bud minis. The demo scenes use
    /// it to keep a staged beat readable (e.g. the squeeze film — one Large,
    /// no trailing newborns). Default false; no shipped gameplay level sets
    /// it, so ordinary levels (and every hash oracle) are untouched.
    pub sterile: bool,
    pub player_start: Vec3,
    pub seed: u64,
}

impl LevelSpec {
    /// The walkable floor rect: the bounding rect of all room floors.
    pub fn floor_bounds(&self) -> [f32; 4] {
        let mut b = [f32::MAX, f32::MAX, f32::MIN, f32::MIN];
        for r in &self.rooms {
            b[0] = b[0].min(r.floor_rect[0]);
            b[1] = b[1].min(r.floor_rect[1]);
            b[2] = b[2].max(r.floor_rect[2]);
            b[3] = b[3].max(r.floor_rect[3]);
        }
        b
    }
}

/// The canonical test/headless level (ARCHITECTURE.md test strategy): 3 rooms
/// in a row (A west, B mid, C east), 2 doors in the interior walls, 4 named
/// lights, 3 wall targets, one free-standing crate in room A for slide tests.
/// All XZ dims are multiples of 0.0625 wu (iso stair-step invariant) so the
/// same spec can later grow greybox visuals unchanged.
pub fn fixture() -> LevelSpec {
    LevelSpec {
        rooms: vec![
            RoomSpec { id: RoomId(0), floor_rect: [-5.0, -2.5, -1.75, 2.5] },
            RoomSpec { id: RoomId(1), floor_rect: [-1.5, -2.5, 1.5, 2.5] },
            RoomSpec { id: RoomId(2), floor_rect: [1.75, -2.5, 5.0, 2.5] },
        ],
        static_solids: vec![
            // interior wall A|B (x -1.75..-1.5) with a door gap z -0.75..0.75
            [-1.75, -2.5, -1.5, -0.75],
            [-1.75, 0.75, -1.5, 2.5],
            // interior wall B|C (x 1.5..1.75), same gap
            [1.5, -2.5, 1.75, -0.75],
            [1.5, 0.75, 1.75, 2.5],
            // crate in room A (slide-along tests)
            [-4.0, 1.0, -3.0, 1.75],
        ],
        doors: vec![
            DoorSpec { id: DoorId(0), hinge: Vec3::new(-1.625, 0.0, -0.75), axis_y: 1.0, closed_solid: [-1.75, -0.75, -1.5, 0.75], open_angle: 110.0_f32.to_radians(), anim_ticks: 30, name: "door_ab".into() },
            DoorSpec { id: DoorId(1), hinge: Vec3::new(1.625, 0.0, -0.75), axis_y: -1.0, closed_solid: [1.5, -0.75, 1.75, 0.75], open_angle: 110.0_f32.to_radians(), anim_ticks: 30, name: "door_bc".into() },
        ],
        lights: vec![
            LightSpec { id: LightId(0), room: RoomId(0), kind: LightKind::Incandescent, base_rgb: [1.0, 0.85, 0.6], name: "lamp_a".into() },
            LightSpec { id: LightId(1), room: RoomId(1), kind: LightKind::Incandescent, base_rgb: [1.0, 0.8, 0.55], name: "lamp_b".into() },
            LightSpec { id: LightId(2), room: RoomId(1), kind: LightKind::Screen, base_rgb: [0.55, 0.95, 0.8], name: "crt_b".into() },
            LightSpec { id: LightId(3), room: RoomId(2), kind: LightKind::Drift, base_rgb: [0.9, 0.95, 1.0], name: "ceil_c".into() },
        ],
        targets: vec![
            TargetSpec { id: TargetId(0), center: Vec3::new(-3.5, 1.25, -2.5), normal: Vec3::new(0.0, 0.0, 1.0), radius: 0.3 },
            TargetSpec { id: TargetId(1), center: Vec3::new(0.0, 1.25, -2.5), normal: Vec3::new(0.0, 0.0, 1.0), radius: 0.3 },
            TargetSpec { id: TargetId(2), center: Vec3::new(5.0, 1.25, 0.0), normal: Vec3::new(-1.0, 0.0, 0.0), radius: 0.3 },
        ],
        items: vec![],     // survival off → no pickups
        survival: None,    // survival off → fixture hashes exactly as before
        mobs: vec![],      // no mobs → fixture hashes exactly as before
        traps: vec![],
        arena: None,       // arsenal off → fixture hashes exactly as before
        drain: None,
        sterile: false,
        player_start: Vec3::new(-3.5, 0.0, 0.0),
        seed: 42,
    }
}

/// The actual game level (ARCHITECTURE.md step 11): a five-room house on the
/// tile-kit grid (1 cell = 1.0 wu, wall lines on integer cell boundaries,
/// wall thickness 0.25 wu so the faces land on ±0.125 — multiples of 0.0625,
/// the iso stair step). The rt-viewer adapter builds the greybox `rt_probe
/// ::Scene` straight from THIS spec — collision and visuals share one source.
///
/// Footprint x∈[0,12], z∈[0,8]. Interior wall lines at x=4, x=8, z=4 split:
///   A (west)   x[0,4]  z[0,8]    — the entry hall, player spawns here
///   B (mid-N)  x[4,8]  z[0,4]
///   C (mid-S)  x[4,8]  z[4,8]
///   D (east-N) x[8,12] z[0,4]
///   E (east-S) x[8,12] z[4,8]
/// Four doors connect adjacent rooms: door_ab (x=4, z[3,4]: A↔B), door_bd
/// (x=8, z[1,2]: B↔D), door_ce (x=8, z[6,7]: C↔E), door_bc (z=4, x[6,7]: B↔C).
/// Five wall targets, six named lights (one Incandescent per room + a Screen
/// device in B). Every XZ dim is a multiple of 0.0625 wu.
pub fn game_level() -> LevelSpec {
    const T: f32 = 0.125; // wall half-thickness (0.25 wu wall, kit = 32 cm)
    // a wall segment ON the vertical line x=cx, spanning z[z0,z1] (thickness 2T)
    let vseg = |cx: f32, z0: f32, z1: f32| [cx - T, z0, cx + T, z1];
    // a wall segment ON the horizontal line z=cz, spanning x[x0,x1]
    let hseg = |x0: f32, cz: f32, x1: f32| [x0, cz - T, x1, cz + T];
    // a door leaf footprint filling a 1-cell gap on a vertical line
    let vdoor = |cx: f32, z0: f32, z1: f32| [cx - T, z0, cx + T, z1];
    let hdoor = |x0: f32, cz: f32, x1: f32| [x0, cz - T, x1, cz + T];
    let open = 100.0_f32.to_radians();

    LevelSpec {
        rooms: vec![
            RoomSpec { id: RoomId(0), floor_rect: [0.0, 0.0, 4.0, 8.0] },
            RoomSpec { id: RoomId(1), floor_rect: [4.0, 0.0, 8.0, 4.0] },
            RoomSpec { id: RoomId(2), floor_rect: [4.0, 4.0, 8.0, 8.0] },
            RoomSpec { id: RoomId(3), floor_rect: [8.0, 0.0, 12.0, 4.0] },
            RoomSpec { id: RoomId(4), floor_rect: [8.0, 4.0, 12.0, 8.0] },
        ],
        static_solids: vec![
            // x=4 line z[0,8], door gap z[3,4] (A↔B)
            vseg(4.0, 0.0, 3.0),
            vseg(4.0, 4.0, 8.0),
            // x=8 line z[0,8], door gaps z[1,2] (B↔D) and z[6,7] (C↔E)
            vseg(8.0, 0.0, 1.0),
            vseg(8.0, 2.0, 6.0),
            vseg(8.0, 7.0, 8.0),
            // z=4 line x[4,12], door gap x[6,7] (B↔C); x[8,12] solid (D|E)
            hseg(4.0, 4.0, 6.0),
            hseg(7.0, 4.0, 12.0),
            // a free-standing crate in room A (slide-along furnishing)
            [0.75, 5.5, 1.75, 6.5],
        ],
        doors: vec![
            DoorSpec { id: DoorId(0), hinge: Vec3::new(4.0, 0.0, 3.0), axis_y: 1.0, closed_solid: vdoor(4.0, 3.0, 4.0), open_angle: open, anim_ticks: 24, name: "door_ab".into() },
            DoorSpec { id: DoorId(1), hinge: Vec3::new(8.0, 0.0, 1.0), axis_y: -1.0, closed_solid: vdoor(8.0, 1.0, 2.0), open_angle: open, anim_ticks: 24, name: "door_bd".into() },
            DoorSpec { id: DoorId(2), hinge: Vec3::new(8.0, 0.0, 7.0), axis_y: 1.0, closed_solid: vdoor(8.0, 6.0, 7.0), open_angle: open, anim_ticks: 24, name: "door_ce".into() },
            DoorSpec { id: DoorId(3), hinge: Vec3::new(6.0, 0.0, 4.0), axis_y: 1.0, closed_solid: hdoor(6.0, 4.0, 7.0), open_angle: open, anim_ticks: 24, name: "door_bc".into() },
        ],
        // light ORDER is the NEE slot order (== the game's flicker index): the
        // emissive Screen device comes FIRST (it is the only emissive prim;
        // the room lamps are conceptual ceiling point lights, which the
        // renderer slots AFTER every emissive prim). The room each light
        // belongs to is carried in `room` regardless of order.
        lights: vec![
            // Retuned to near-neutral bright daylight: the old heavy warm-orange
            // cast muddied the clean pastels. Still flicker-driven (kind), still
            // in NEE slot order (screen first). See game_scene::place_light for
            // the raised emission multipliers that make the pastels read.
            LightSpec { id: LightId(0), room: RoomId(1), kind: LightKind::Screen, base_rgb: [0.55, 0.95, 0.82], name: "crt_b".into() },
            LightSpec { id: LightId(1), room: RoomId(0), kind: LightKind::Incandescent, base_rgb: [1.0, 0.97, 0.92], name: "lamp_a".into() },
            LightSpec { id: LightId(2), room: RoomId(1), kind: LightKind::Incandescent, base_rgb: [1.0, 0.96, 0.9], name: "lamp_b".into() },
            LightSpec { id: LightId(3), room: RoomId(2), kind: LightKind::Incandescent, base_rgb: [1.0, 0.96, 0.91], name: "lamp_c".into() },
            LightSpec { id: LightId(4), room: RoomId(3), kind: LightKind::Drift, base_rgb: [0.94, 0.97, 1.0], name: "ceil_d".into() },
            LightSpec { id: LightId(5), room: RoomId(4), kind: LightKind::Incandescent, base_rgb: [1.0, 0.96, 0.9], name: "lamp_e".into() },
        ],
        targets: vec![
            // discs ON inner wall faces (normal points into the room). The wall
            // face the disc sits on ties at the disc plane (does not occlude).
            TargetSpec { id: TargetId(0), center: Vec3::new(0.125, 1.25, 2.0), normal: Vec3::new(1.0, 0.0, 0.0), radius: 0.3 }, // A, west wall
            TargetSpec { id: TargetId(1), center: Vec3::new(2.0, 1.25, 0.125), normal: Vec3::new(0.0, 0.0, 1.0), radius: 0.3 }, // A, north wall
            TargetSpec { id: TargetId(2), center: Vec3::new(6.0, 1.25, 0.125), normal: Vec3::new(0.0, 0.0, 1.0), radius: 0.3 }, // B, north wall
            TargetSpec { id: TargetId(3), center: Vec3::new(11.875, 1.25, 2.0), normal: Vec3::new(-1.0, 0.0, 0.0), radius: 0.3 }, // D, east wall
            TargetSpec { id: TargetId(4), center: Vec3::new(6.0, 1.25, 7.875), normal: Vec3::new(0.0, 0.0, -1.0), radius: 0.3 }, // C, south wall
        ],
        items: vec![],     // survival off → game_level hashes exactly as before
        survival: None,    // (survival_level() below is the opt-in sandbox)
        mobs: vec![],      // no mobs → game_level hashes exactly as before (goo_level() is the demo)
        traps: vec![],
        arena: None,       // arsenal off → game_level hashes exactly as before
        drain: None,
        sterile: false,
        player_start: Vec3::new(9.5, 0.0, 6.5), // room E (SE corner, faces the camera), aligned with door_ce's gap row
        seed: 7,
    }
}

/// The goo-mob demo level: the SAME five-room house geometry as [`game_level`]
/// (collision world + renderer scene identical), but populated with a few
/// fluorescent goo blobs to crawl, jiggle, and split when shot. This is the
/// `SCENE=goo` content; `game_level()` and `fixture()` stay mob-free and
/// hash-stable. Blobs spawn on open room floors (away from the 0.125 walls).
pub fn goo_level() -> LevelSpec {
    LevelSpec {
        mobs: vec![
            // a Large in the entry hall (room A), two more across the house, and
            // one Large in room E in clear line-of-sight of the player spawn
            // (9.5, 6.5) so a shot can reach it without crossing a wall.
            MobSpec { id: MobId(0), tier: 0, kind: GooKind::Green, pos: Vec3::new(2.0, 0.0, 4.0) },
            MobSpec { id: MobId(1), tier: 0, kind: GooKind::Green, pos: Vec3::new(6.0, 0.0, 2.0) },
            MobSpec { id: MobId(2), tier: 1, kind: GooKind::Green, pos: Vec3::new(10.0, 0.0, 2.0) },
            MobSpec { id: MobId(3), tier: 0, kind: GooKind::Green, pos: Vec3::new(8.7, 0.0, 5.2) },
        ],
        traps: vec![
            // a trap in the open centre of room E: it gently drags the room-E
            // Large across the floor and pools the fluid onto the ring (a soft
            // pull so the two-lobe dumbbell survives while it's dragged in).
            TrapSpec { id: 0, pos: Vec3::new(9.2, 0.0, 4.3), strength: 1.2, radius: 2.5, off_tick: 0 },
        ],
        ..game_level()
    }
}

/// A clean goo PLAYGROUND: one large flat plane with walls ONLY on the two far
/// edges (−x / −z, which project to the top/back of the iso view), so nothing
/// near the camera obscures the goo. A handful of blobs of mixed tiers and a
/// trap sit on the open floor for unobstructed observation. Not hash-stable /
/// not tested — a free authoring stage (`SCENE=playground`).
pub fn playground_level() -> LevelSpec {
    LevelSpec {
        // far edges (−x/−z, top of view) close to the action as a backdrop;
        // the floor opens out toward the camera (+x/+z) for the "large plane".
        rooms: vec![RoomSpec { id: RoomId(0), floor_rect: [-3.0, -3.0, 9.0, 9.0] }],
        static_solids: vec![
            [-3.0, -3.0, 9.0, -2.75], // north (far) wall
            [-3.0, -3.0, -2.75, 9.0], // west (far) wall
        ],
        doors: vec![],
        lights: vec![LightSpec { id: LightId(0), room: RoomId(0), kind: LightKind::Incandescent, base_rgb: [1.0, 0.97, 0.92], name: "play_lamp".into() }],
        targets: vec![],
        mobs: vec![
            MobSpec { id: MobId(0), tier: 1, kind: GooKind::Green, pos: Vec3::new(-2.1, 0.0, -1.2) },
            MobSpec { id: MobId(1), tier: 1, kind: GooKind::Green, pos: Vec3::new(1.5, 0.0, -1.6) },
            MobSpec { id: MobId(2), tier: 1, kind: GooKind::Green, pos: Vec3::new(-1.7, 0.0, 0.9) },
            MobSpec { id: MobId(3), tier: 1, kind: GooKind::Green, pos: Vec3::new(1.6, 0.0, 0.7) },
            MobSpec { id: MobId(4), tier: 1, kind: GooKind::Green, pos: Vec3::new(-0.2, 0.0, 1.4) },
        ],
        traps: vec![TrapSpec { id: 0, pos: Vec3::new(0.1, 0.0, -0.2), strength: 1.4, radius: 4.0, off_tick: 0 }],
        player_start: Vec3::new(-0.5, 0.0, -0.5),
        ..game_level()
    }
}

/// A bare open floor with NO player marker (`SCENE=goofloor`): the simplest
/// possible stage for filming goo. No walls, no pillar — just a big lit plane
/// and the blobs. Because there is no player, the camera is fixed (no follow)
/// and nothing solid sits in the goo's way, so two blobs can actually MERGE and
/// the survivor can crawl freely. A central TIMED trap pulls the pair together
/// into a fuse, then expires; an offset trap out in +x then walks the survivor
/// across the open plane. Not hash-stable / not a golden — a free movie stage.
pub fn goofloor_level() -> LevelSpec {
    LevelSpec {
        // one large plane, centred on the origin, opening out in every direction
        rooms: vec![RoomSpec { id: RoomId(0), floor_rect: [-8.0, -8.0, 12.0, 12.0] }],
        static_solids: vec![], // NO walls
        doors: vec![],
        lights: vec![LightSpec { id: LightId(0), room: RoomId(0), kind: LightKind::Incandescent, base_rgb: [1.0, 0.97, 0.92], name: "floor_lamp".into() }],
        targets: vec![],
        // two blobs a z apart; a central timed trap holds + fuses them on the
        // left until it expires (~t180). The trace then walks the INVISIBLE
        // player marker (hidden in this scene) in as a lure: the merged goo seeks
        // it and the trace leads it +x across the open plane — a clean, directed
        // walk (traps can't steer a blob; only the head's seek can).
        mobs: vec![
            MobSpec { id: MobId(0), tier: 1, kind: GooKind::Green, pos: Vec3::new(-2.0, 0.0, -1.0) },
            MobSpec { id: MobId(1), tier: 1, kind: GooKind::Green, pos: Vec3::new(-2.0, 0.0, 1.0) },
        ],
        traps: vec![TrapSpec { id: 0, pos: Vec3::new(-2.0, 0.0, 0.0), strength: 1.3, radius: 2.6, off_tick: 180 }],
        player_start: Vec3::new(-2.0, 0.0, 3.0), // invisible lure, parked outside aggro during the merge
        ..game_level()
    }
}

/// A NURSERY stage for the mitosis showcase (`SCENE=goonursery`): a bare lit
/// floor, no walls, no player marker, and a SINGLE Large (tier-0) mother sat in
/// the middle. With nothing else around she spontaneously buds off mini goos on
/// her mitosis clock — each one flashing a hot pink bud site as it forms, then
/// popping off birth-immune so it crawls clear of her gravity well instead of
/// being reeled straight back. No trap (a trap would pull the newborns back in),
/// no lure. Not hash-stable / not a golden — a free movie stage. Edit freely.
pub fn goonursery_level() -> LevelSpec {
    LevelSpec {
        rooms: vec![RoomSpec { id: RoomId(0), floor_rect: [-10.0, -10.0, 20.0, 20.0] }],
        static_solids: vec![], // NO walls
        doors: vec![],
        lights: vec![LightSpec { id: LightId(0), room: RoomId(0), kind: LightKind::Incandescent, base_rgb: [1.0, 0.97, 0.92], name: "floor_lamp".into() }],
        targets: vec![],
        mobs: vec![MobSpec { id: MobId(0), tier: 0, kind: GooKind::Green, pos: Vec3::new(0.0, 0.0, 0.0) }],
        // a SMALL central well grips only the slow Large mother's centre so she
        // stays framed while she buds. Newborn minis are birth-immune to ALL
        // wells (this trap included) until they leave her influence, so the trap
        // can't recapture them — it just keeps mom centred. off_tick is far in
        // the future purely to suppress the floor ring (timed traps draw none).
        traps: vec![TrapSpec { id: 0, pos: Vec3::new(0.0, 0.0, 0.0), strength: 0.7, radius: 1.0, off_tick: 100_000 }],
        // the player exists (so has_player → fixed camera path) but is parked far
        // outside the mother's aggro radius and rendered invisible: she ignores it
        // and just wanders/buds in place. Keeps the camera from following.
        player_start: Vec3::new(0.0, 0.0, 8.0),
        ..game_level()
    }
}

/// A PAIR-COLLISION stage (`SCENE=goopair`): bare lit floor, no walls, no
/// traps, and two Large blobs dropped SUPERIMPOSED at the origin. Films the
/// blob–blob contact repulsion: the overlapped bodies push apart, then wander,
/// bump and SLIDE around each other (the pressed head yields and turns)
/// instead of crawling through and welding into one lump. Both Larges are
/// mothers, so a long take also shows their broods contact-mingling. The
/// player marker is parked far outside aggro (hidden in this scene, fixed
/// camera). Not hash-stable / not a golden — a free movie stage. Edit freely.
pub fn goopair_level() -> LevelSpec {
    LevelSpec {
        rooms: vec![RoomSpec { id: RoomId(0), floor_rect: [-8.0, -8.0, 12.0, 12.0] }],
        static_solids: vec![], // NO walls
        doors: vec![],
        lights: vec![LightSpec { id: LightId(0), room: RoomId(0), kind: LightKind::Incandescent, base_rgb: [1.0, 0.97, 0.92], name: "floor_lamp".into() }],
        targets: vec![],
        mobs: vec![
            MobSpec { id: MobId(0), tier: 0, kind: GooKind::Green, pos: Vec3::new(-0.15, 0.0, 0.0) },
            MobSpec { id: MobId(1), tier: 0, kind: GooKind::Green, pos: Vec3::new(0.15, 0.0, 0.0) },
        ],
        traps: vec![],
        player_start: Vec3::new(-6.0, 0.0, 6.0),
        ..game_level()
    }
}

/// A SHOOTING RANGE for the physical-projectile weapon work (`SCENE=range`): an
/// open lane (far backstop walls on −x/−z, like the playground, so nothing near
/// the camera blocks the view) with a row of shootable wall discs at the back,
/// plus goo blobs standing in the lane as soft targets. The player stands at the
/// near (+z) end and fires down the lane: slugs visibly travel, drop nothing
/// (flat pistol), splat the goo on impact, and split a Medium that drops. Not
/// hash-stable / not a golden — a free demo stage. Edit freely.
pub fn shooting_range_level() -> LevelSpec {
    LevelSpec {
        // SAME open footprint + camera framing as the playground (proven to frame
        // the goo well): far backstop walls on −x/−z (top/back of the iso view),
        // the floor opening toward the camera (+x/+z).
        rooms: vec![RoomSpec { id: RoomId(0), floor_rect: [-3.0, -3.0, 9.0, 9.0] }],
        static_solids: vec![
            [-3.0, -3.0, 9.0, -2.75], // north (far) backstop wall — the discs hang here
            [-3.0, -3.0, -2.75, 9.0], // west (far) wall
        ],
        doors: vec![],
        lights: vec![LightSpec { id: LightId(0), room: RoomId(0), kind: LightKind::Incandescent, base_rgb: [1.0, 0.97, 0.92], name: "range_lamp".into() }],
        // discs ON the −z backstop face (z = −2.75), facing the shooter (+z), at
        // staggered x and heights — the back-wall row the slugs fly up-range to.
        targets: vec![
            TargetSpec { id: TargetId(0), center: Vec3::new(-1.8, 1.25, -2.75), normal: Vec3::new(0.0, 0.0, 1.0), radius: 0.40 },
            TargetSpec { id: TargetId(1), center: Vec3::new(0.3, 1.55, -2.75), normal: Vec3::new(0.0, 0.0, 1.0), radius: 0.32 },
            TargetSpec { id: TargetId(2), center: Vec3::new(2.2, 1.00, -2.75), normal: Vec3::new(0.0, 0.0, 1.0), radius: 0.32 },
        ],
        // soft targets out on the floor in front of the shooter: two Larges
        // (survive a hit → splat & recoil) flanking a Medium (one kill → splits).
        // No trap — they stay three distinct, slow-crawling targets to shoot.
        mobs: vec![
            MobSpec { id: MobId(0), tier: 0, kind: GooKind::Green, pos: Vec3::new(-1.9, 0.0, -1.0) },
            MobSpec { id: MobId(1), tier: 1, kind: GooKind::Green, pos: Vec3::new(0.2, 0.0, -0.4) },
            MobSpec { id: MobId(2), tier: 0, kind: GooKind::Green, pos: Vec3::new(1.7, 0.0, -1.3) },
        ],
        traps: vec![],
        player_start: Vec3::new(-0.5, 0.0, 0.9),
        ..game_level()
    }
}

/// The goo ARENA (`SCENE=arena`): a large square walled pit for the arena
/// shooter — one 20×20 wu room whose rectangular auto-perimeter provides the
/// four walls (deliberately NOT a dollhouse scene), a bright four-lamp grid,
/// and a mixed-tier starting squad spread across the far half. The player
/// spawns centre-south with clear sightlines. `arena: Some(..)` opts into the
/// arsenal: keys 1–5 select a weapon and the shell maps LMB to shoot. Not
/// hash-stable / not a golden — the playtest stage. Edit freely.
pub fn arena_level() -> LevelSpec {
    LevelSpec {
        rooms: vec![RoomSpec { id: RoomId(0), floor_rect: [-10.0, -10.0, 10.0, 10.0] }],
        // Cover architecture (all thin 0.25-wu walls -> full-height render,
        // honest LOS + projectile blockers; every dim a 0.0625 multiple).
        // North wall with a 0.5625-wu SQUEEZE SLOT on the west lane: a Large
        // blob (~1 wu wide) must physically squeeze its PBF body through;
        // the east lane stays open. The mid-field L is a corner pointing at
        // the player spawn, made for show-then-hide ambushes; the east wall
        // is flank cover on the open lane.
        static_solids: vec![
            [-10.0, -2.125, -7.0, -1.875],
            [-6.4375, -2.125, -3.25, -1.875],
            [-4.25, 0.875, -0.75, 1.125],
            [-1.0, 1.125, -0.75, 3.125],
            [2.75, -0.125, 3.0, 2.875],
        ],
        doors: vec![],
        // one centre lamp; the open-studio sky fill carries the pit evenly
        // (lights place at the ROOM CENTRE — a lamp grid would need rooms)
        lights: vec![LightSpec { id: LightId(0), room: RoomId(0), kind: LightKind::Incandescent, base_rgb: [1.0, 0.97, 0.92], name: "arena_lamp".into() }],
        targets: vec![],
        // the wave-0 squad: mixed tiers AND KINDS, spread across the up-screen
        // half but INSIDE the spawn camera's ~14×9 wu view — the first frame
        // must show targets (a shooter that opens on empty floor reads as
        // broken). One blue Tank anchor, two red Runners for pressure.
        // spawn positions steer clear of the new walls (the old squad sat
        // where the L now stands); still inside the spawn camera's view
        mobs: vec![
            MobSpec { id: MobId(0), tier: 0, kind: GooKind::Tank, pos: Vec3::new(-5.75, 0.0, -0.25) },
            MobSpec { id: MobId(1), tier: 1, kind: GooKind::Runner, pos: Vec3::new(4.75, 0.0, 0.5) },
            MobSpec { id: MobId(2), tier: 1, kind: GooKind::Green, pos: Vec3::new(0.5, 0.0, 2.0) },
            MobSpec { id: MobId(3), tier: 2, kind: GooKind::Runner, pos: Vec3::new(-2.25, 0.0, 3.75) },
            MobSpec { id: MobId(4), tier: 2, kind: GooKind::Green, pos: Vec3::new(1.75, 0.0, 3.5) },
        ],
        traps: vec![],
        arena: Some(ArenaParams::default()),
        player_start: Vec3::new(0.0, 0.0, 6.0),
        ..game_level()
    }
}

/// The SQUEEZE film stage (`SCENE=squeeze`): the arena's north wall with its
/// 0.5625-wu slot, ONE Large blob north of it, the player standing guard due
/// south with a clean sightline. Made for filming the signature beat: a
/// ~1-wu body funnels itself through the slot (budding minis trail through
/// after their mother), then walks into the arsenal. `arena: Some` powers
/// the tactics brain (flow-field routing INTO the slot) + LMB shooting.
/// Not hash-stable / not a golden — a demo stage. Edit freely.
pub fn squeeze_level() -> LevelSpec {
    LevelSpec {
        rooms: vec![RoomSpec { id: RoomId(0), floor_rect: [-10.0, -10.0, 10.0, 10.0] }],
        static_solids: vec![
            [-10.0, -2.125, -7.0, -1.875],
            [-6.4375, -2.125, -3.25, -1.875],
        ],
        doors: vec![],
        lights: vec![LightSpec { id: LightId(0), room: RoomId(0), kind: LightKind::Incandescent, base_rgb: [1.0, 0.97, 0.92], name: "arena_lamp".into() }],
        targets: vec![],
        mobs: vec![MobSpec { id: MobId(0), tier: 0, kind: GooKind::Runner, pos: Vec3::new(-6.71875, 0.0, -5.0) }],
        traps: vec![],
        arena: Some(ArenaParams::default()),
        sterile: true, // one body, one slot — no trailing newborns in frame
        player_start: Vec3::new(-6.71875, 0.0, 2.0),
        ..game_level()
    }
}

/// HOLD THE DRAIN (`SCENE=drain`): the containment variant — the goo wants
/// OUT, not you. The south wall is a sieve: a Small slit (0.3125 wu), a
/// Medium slot (0.5625) and one wide, unsealable main drain (1.25). Goo
/// that squeezes past despawns into the breach meter (LEAK n/cap on the
/// HUD); the meter full ends the run. Kill-placement is the strategy: a
/// cure-solidified corpse can permanently seal the narrow slots. Runners
/// and comm pacts still hunt YOU while you play goalkeeper. Not a golden.
pub fn drain_level() -> LevelSpec {
    LevelSpec {
        rooms: vec![RoomSpec { id: RoomId(0), floor_rect: [-10.0, -10.0, 10.0, 10.0] }],
        static_solids: vec![
            // mid-field cover (the arena's familiar L + east wall)
            [-4.25, 0.875, -0.75, 1.125],
            [-1.0, 1.125, -0.75, 3.125],
            [2.75, -0.125, 3.0, 2.875],
            // the sieve wall: slit [-6,-5.6875], slot [-1,-0.4375], main [4,5.25]
            [-10.0, 8.25, -6.0, 8.5],
            [-5.6875, 8.25, -1.0, 8.5],
            [-0.4375, 8.25, 4.0, 8.5],
            [5.25, 8.25, 10.0, 8.5],
        ],
        doors: vec![],
        lights: vec![LightSpec { id: LightId(0), room: RoomId(0), kind: LightKind::Incandescent, base_rgb: [1.0, 0.97, 0.92], name: "arena_lamp".into() }],
        targets: vec![],
        mobs: vec![
            MobSpec { id: MobId(0), tier: 0, kind: GooKind::Green, pos: Vec3::new(-5.0, 0.0, -6.0) },
            MobSpec { id: MobId(1), tier: 1, kind: GooKind::Green, pos: Vec3::new(0.5, 0.0, -5.0) },
            MobSpec { id: MobId(2), tier: 1, kind: GooKind::Runner, pos: Vec3::new(4.5, 0.0, -5.5) },
            MobSpec { id: MobId(3), tier: 2, kind: GooKind::Green, pos: Vec3::new(-2.0, 0.0, -4.0) },
        ],
        traps: vec![],
        arena: Some(ArenaParams::default()),
        drain: Some([-10.0, 8.5, 10.0, 10.0]),
        player_start: Vec3::new(0.0, 0.0, 6.5),
        ..game_level()
    }
}

/// The survival experimentation sandbox: the SAME five-room house geometry as
/// [`game_level`] (rooms / walls / doors / lights / targets are cloned, so the
/// collision world and the renderer scene are identical), but with survival
/// ENABLED ([`SurvivalParams::default`]) and a handful of Food + Battery items
/// scattered across the rooms. This is the only level the survival systems run
/// on; `game_level()` and `fixture()` stay survival-off and hash-stable.
///
/// Item layout (all on room floors, away from the 0.125-thick walls):
///   Food    in A (entry hall, near spawn path), C (mid-S), D (east-N)
///   Battery in A (far corner), B (mid-N), E (east-S, by the spawn)
pub fn survival_level() -> LevelSpec {
    LevelSpec {
        items: vec![
            // A — entry hall x[0,4] z[0,8]
            ItemSpec { id: ItemId(0), kind: ItemKind::Food, pos: Vec3::new(2.0, 0.0, 2.0) },
            ItemSpec { id: ItemId(1), kind: ItemKind::Battery, pos: Vec3::new(1.0, 0.0, 7.0) },
            // B — mid-N x[4,8] z[0,4]
            ItemSpec { id: ItemId(2), kind: ItemKind::Battery, pos: Vec3::new(5.5, 0.0, 1.5) },
            // C — mid-S x[4,8] z[4,8]
            ItemSpec { id: ItemId(3), kind: ItemKind::Food, pos: Vec3::new(5.5, 0.0, 6.0) },
            // D — east-N x[8,12] z[0,4]
            ItemSpec { id: ItemId(4), kind: ItemKind::Food, pos: Vec3::new(10.0, 0.0, 2.0) },
            // E — east-S x[8,12] z[4,8] (player spawns at 9.5, 6.5)
            ItemSpec { id: ItemId(5), kind: ItemKind::Battery, pos: Vec3::new(11.0, 0.0, 5.0) },
        ],
        survival: Some(SurvivalParams::default()),
        ..game_level()
    }
}
