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

/// Practical-light animation family — maps 1:1 onto the renderer's numeric
/// flicker kinds (render.rs compute_practicals / [`crate::flicker`]). With the
/// kind in the spec, the renderer's hue-based kind heuristic dies in step 10.
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

/// A shootable wall disc.
#[derive(Clone, Debug)]
pub struct TargetSpec {
    pub id: TargetId,
    pub center: Vec3,
    pub normal: Vec3,
    pub radius: f32,
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
        player_start: Vec3::new(9.5, 0.0, 6.5), // room E (SE corner, faces the camera), aligned with door_ce's gap row
        seed: 7,
    }
}
