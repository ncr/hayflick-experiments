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
