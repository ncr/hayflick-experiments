//! The game: commands, components, the fixed-order system sequence, snapshot
//! and state hash (ARCHITECTURE.md "The game (house-game)"). Everything is
//! headless and deterministic: ordered spawning from LevelSpec, structural
//! changes through ONE command-buffer flush per tick, StableId-sorted outputs,
//! stateless flicker — `cargo test -p house-game` runs the whole game in
//! milliseconds with no GPU and no window.

use crate::flicker::flicker;
use crate::spec::{DoorId, ItemId, ItemKind, LevelSpec, LightId, LightKind, MobId, SurvivalParams, TargetId};
use crate::{collide_and_slide, flashlight_pose, iso_input_dir, recommended_min_px_per_sec, Level};
use glam::{IVec2, Vec2, Vec3};
use iso_core::{iso_basis, screen_px_to_world, snap_ground_to_lattice, ISO_R};
use sim_core::{AudioCue, AudioSink, CommandBuffer, CueId, Entity, Events, NullSink, Pcg32, Simulation, Tick, World};

/// Fixed simulation timestep (the shell's FixedLoop runs at the same rate).
pub const TICK_DT: f32 = 1.0 / 60.0;
/// Player collision pillar half-extent in XZ (the renderer's marker prim).
pub const PLAYER_HALF: f32 = 0.1875;
/// Default walk speed in screen px/s (floored by the iso smoothness minimum).
pub const PLAYER_SPEED_PX: f32 = 140.0;
/// Ticks between pistol shots; extra Shoot commands inside are swallowed.
pub const PISTOL_COOLDOWN_TICKS: u32 = 15;
/// Ticks the muzzle-flash spotlight stays armed after a shot.
pub const MUZZLE_FLASH_TICKS: u32 = 2;
/// Door interact volume: the closed leaf slab inflated by this much (wu).
pub const DOOR_INTERACT_INFLATE: f32 = 0.3;

// ---- goo-mob tuning ---------------------------------------------------------
/// Tier-0 (Large) goo blob body radius in world units. Each tier down is
/// `/√2` (area-conserving 2-way split).
pub const GOO_BASE_RADIUS: f32 = 0.55;
/// Damage one pistol shot deals to a goo blob.
pub const GOO_DAMAGE: u16 = 6;
/// Hard ceiling on simultaneously live blobs (sized to the renderer's reserved
/// ellipsoid instance pool: GOO_LIVE_CAP × 4 nodes ≤ pool). Over-cap splits
/// degrade to a plain kill so division can never outrun the draw pool.
pub const GOO_LIVE_CAP: usize = 12;
/// Player-proximity (wu) at which a blob switches from wander to seek. Kept
/// short — slimes are dumb and slow, they don't beeline across a room.
pub const GOO_AGGRO: f32 = 1.5;
/// Verlet velocity retention per tick (1 = frictionless, <1 = gooey drag).
pub const GOO_VERLET_DAMP: f32 = 0.82;
/// Fraction of head inertia carried each tick (the rest is steering drive).
pub const GOO_HEAD_INERTIA: f32 = 0.45;
/// Max heading turn per tick (radians) — gummy, not instant.
pub const GOO_MAX_TURN: f32 = 0.05;
/// Rest spine length (head↔tail span) as a fraction of body radius. The spine
/// is now an internal *deformation skeleton*: the fluid pools around the whole
/// head–tail SEGMENT (a capsule field), so a short spine = one round blob and a
/// long spine = an elongated one. The gait oscillates the live length around
/// this rest value (see `GOO_LEN_MIN`/`GOO_LEN_MAX`) to squash-and-stretch.
pub const GOO_BODY_FRAC: f32 = 1.1;
/// Ticks per crawl gait cycle (bunch → lunge → reflow), ~1.1 s @ 60 fps. An
/// integer per-blob phase clock drives it — bit-exact, no f32 drift, hashed.
pub const GOO_GAIT_PERIOD: u16 = 66;
/// Live spine-length multipliers at the gait extremes: contracted (round-up,
/// the body gathers) and extended (the forward lunge that stretches it out).
pub const GOO_LEN_MIN: f32 = 0.55;
pub const GOO_LEN_MAX: f32 = 1.3;
/// Floor on the gait-modulated capsule pull (gather ramps it up over this), so
/// cohesion always wins and the blob never lets go of itself between pulses.
pub const GOO_PULL_BASE: f32 = 0.6;
/// Lateral (perpendicular-to-heading) velocity damping (1/s) — suppresses the
/// sideways smear a turn would otherwise leave, keeping the silhouette legible.
pub const GOO_LATERAL: f32 = 1.2;
/// Merge trigger: two same-tier blobs fuse when their centroids close within
/// this fraction of their (shared) body radius — i.e. the bodies clearly
/// overlap. The inverse of the shot-split; deterministic, one merge per tick.
pub const GOO_MERGE_FRAC: f32 = 1.25;
/// Ticks a freshly-born blob (spawned, split child, or fusion result) is immune
/// from merging, so a shot-split visibly separates before anything can re-fuse
/// (and a fusion result doesn't instantly grab a third neighbour).
pub const GOO_MERGE_GRACE: u16 = 45;
/// A fusing blob's collapse: how long (ticks) it deflates INTO the survivor
/// before despawning, how fast its particles slide to the fusion point, and how
/// fast it shrinks. Spread over ~⅓ s so no metaballs ever vanish in one frame —
/// the absorbed body oozes into the survivor instead of popping out.
pub const GOO_FUSE_TICKS: u16 = 22;
pub const GOO_FUSE_COLLAPSE: f32 = 0.14;
pub const GOO_FUSE_DEFLATE: f32 = 0.90;
/// Per-tick ease of the rest spine length toward its tier target — drives the
/// post-merge growth (a no-op for any already-settled blob). Slow (~1.2 s to
/// settle) so the survivor swells into its new tier almost imperceptibly.
pub const GOO_GROW_RATE: f32 = 0.03;
/// Hard cap on a trap's pull (wu/s²) so a blob sitting on the trap centre is
/// held, not flung — the inverse-square law alone spikes to absurd force at the
/// singularity (what made merged blobs spin). Far-field pull is unchanged.
pub const GOO_TRAP_MAX: f32 = 22.0;
/// Extra clearance (wu) the goo keeps around the player's pillar footprint, so
/// the fluid SURFACE drapes against it rather than the particle centres sinking
/// into the face. The goo treats the player as solid (it can't, walking freely).
pub const GOO_COLLIDER_MARGIN: f32 = 0.10;

// ---- goo fluid (Position-Based Fluids: Macklin & Müller 2013) ---------------
// The body is a real fluid — a cloud of SPH particles solved each tick for
// incompressibility (a density constraint), surface-tension cohesion (the
// tensile s_corr term — what makes it clump and slime), and XSPH viscosity (the
// gooey drag). It genuinely flows, pools on the floor, drapes over traps, and
// splashes when shot. An external body force pulls the fluid toward the spine
// capsule (the "muscle" that drives locomotion + the single round body) and
// toward any trap. CPU + f32 → deterministic and hashed like the player path.
/// Fluid particles per blob. Denser = smoother metaball surface (cheap on CPU).
pub const GOO_PARTICLES: usize = 40;
/// SPH smoothing radius (wu): a particle interacts with neighbours within this.
pub const GOO_H: f32 = 0.30;
/// Rest particle spacing (wu) — sets the fluid's rest density (`goo_rho0`).
/// Tighter than before so 40 particles still pack into a tier-sized blob.
pub const GOO_SPACING: f32 = 0.135;
/// Density-constraint solver (Jacobi) iterations per tick.
pub const GOO_SOLVER_ITERS: usize = 3;
/// Constraint-force-mixing relaxation (stabilises the density solve — larger =
/// softer/gentler corrections, which a small goo fluid needs to stay stable).
pub const GOO_CFM_EPS: f32 = 25.0;
/// Hard clamp on a single particle's per-iteration position correction (wu) —
/// the key stability guard against the density solve overshooting + exploding.
pub const GOO_MAX_DP: f32 = 0.03;
/// Tensile instability / cohesion strength (surface tension — the slimy clump).
pub const GOO_SCORR_K: f32 = 0.04;
/// Tensile term exponent.
pub const GOO_SCORR_N: i32 = 4;
/// XSPH viscosity (0 = inviscid water, higher = thick gooey drag).
pub const GOO_VISCOSITY: f32 = 0.18;
/// Body-force acceleration pulling each fluid particle toward the nearest point
/// on the spine SEGMENT (wu/s²) — the capsule muscle that hauls the body along
/// behind the crawling spine. Self-limiting (vanishes as a particle reaches the
/// segment); the Δp clamp keeps the density solve stable at this strength.
pub const GOO_END_PULL: f32 = 11.0;
/// Trap acceleration scale (wu/s²): a trap's `strength · this / dist²`.
pub const GOO_TRAP_PULL: f32 = 10.0;
/// Converts a trap's acceleration into the spine ends' per-tick Verlet
/// displacement, so a captured blob's anchors (and thus the whole creature) get
/// dragged in at a rate that overpowers the slow wander.
pub const GOO_END_TRAP: f32 = 8.0e-4;
/// Particle speed clamp (wu/s) — a hard guard against solver blow-ups.
pub const GOO_MAX_VEL: f32 = 6.0;
/// Velocity damping per tick (mild — most damping is the XSPH viscosity).
pub const GOO_DAMP: f32 = 0.99;
/// Inverse-distance softening (wu²) on the body-force denominators.
pub const GOO_SOFTEN: f32 = 0.02;
/// Particle metaball radius as a fraction of body radius (SDF lump size).
/// Smaller now that the fluid is denser — finer surface, still merges smoothly.
pub const GOO_PART_RADIUS_FRAC: f32 = 0.4;

/// SPH kernel W(r) = (1 − r/h)³ for r<h (unit peak at r=0). One smooth kernel
/// for both density and its gradient keeps the PBF scale self-consistent.
fn goo_w(r: f32) -> f32 {
    if r < GOO_H {
        let t = 1.0 - r / GOO_H;
        t * t * t
    } else {
        0.0
    }
}
/// ∇W magnitude factor: dW/dr = −3/h·(1 − r/h)². The gradient vector is this
/// times the unit direction (caller supplies the sign/direction).
fn goo_dw(r: f32) -> f32 {
    if r > 1e-6 && r < GOO_H {
        let t = 1.0 - r / GOO_H;
        -3.0 / GOO_H * t * t
    } else {
        0.0
    }
}
/// Rest density: the kernel sum a particle sees in an infinite square packing
/// at `GOO_SPACING`. Computed once (cheap) so the density target self-calibrates
/// to the kernel instead of being a hand-tuned magic number.
pub fn goo_rho0() -> f32 {
    let n = (GOO_H / GOO_SPACING).ceil() as i32 + 1;
    let mut rho = 0.0;
    for gx in -n..=n {
        for gz in -n..=n {
            let r = ((gx * gx + gz * gz) as f32).sqrt() * GOO_SPACING;
            rho += goo_w(r);
        }
    }
    rho
}

/// AI state of one goo blob (deliberately dumb: wander, chase, pause).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum GooState {
    Wander,
    Seek,
    Idle,
}

impl GooState {
    fn tag(self) -> u64 {
        match self {
            GooState::Wander => 0,
            GooState::Seek => 1,
            GooState::Idle => 2,
        }
    }
}

/// Tier → body radius (wu): R0, R0/√2, R0/2 for Large/Medium/Small.
pub fn goo_tier_radius(tier: u8) -> f32 {
    GOO_BASE_RADIUS * std::f32::consts::FRAC_1_SQRT_2.powi(tier as i32)
}
/// Tier → hit points. Large takes two shots then splits, Medium/Small one.
fn goo_tier_hp(tier: u8) -> u16 {
    match tier {
        0 => 12,
        1 => 6,
        _ => 3,
    }
}
/// Tier → crawl speed (wu/s). Smaller blobs scurry faster.
fn goo_tier_speed(tier: u8) -> f32 {
    match tier {
        0 => 0.8,
        1 => 1.1,
        _ => 1.5,
    }
}
/// Door leaf height (interact slab y extent before inflation).
pub const DOOR_H: f32 = 2.0;
/// Occluder height band for hitscan: solids block shots from floor to here.
pub const WALL_H: f32 = 2.56;
/// Perimeter wall thickness used for the hitscan occluder slabs.
pub const WALL_T: f32 = 0.25;
/// WalkTarget is reached when the remaining screen distance drops below 1 px.
pub const WALK_ARRIVE_PX: f32 = 1.0;
/// Consecutive fully-blocked ticks before a WalkTarget is abandoned.
pub const WALK_BLOCKED_TICKS: u32 = 2;

/// A world-space pick ray (already unprojected by the shell via iso-core).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PickRay {
    pub origin: Vec3,
    pub dir: Vec3, // unit
}

/// The whole input surface. Picks arrive PRE-UNPROJECTED (window px never
/// cross this boundary); semantic resolution (door vs walk) happens in-game.
#[derive(Clone, Debug, PartialEq)]
pub enum Command {
    /// LMB: door-hit → UseDoor, else WalkTo(ground) when on the floor.
    /// `ground` is None when the click unprojected off-window / guard band.
    Click { ray: PickRay, ground: Option<Vec2> },
    /// RMB hitscan.
    Shoot { ray: PickRay },
    /// WASD fallback (kept through migration): x = right − left, y = up − down.
    Move { dir: IVec2 },
    ToggleFlashlight,
    ToggleRoomLights,
    /// Quarter-turns are SIM state: walk trajectories depend on yaw_q.
    RotateCamera { dq: i8 },
    /// Consume one carried item of `kind` → restore the matching need (clamped
    /// to 1.0), emit `Consumed`. No-op if none carried or survival is off.
    Use { kind: ItemKind },
}

// ---- components -------------------------------------------------------------

pub struct Pos(pub Vec3);
pub struct Facing(pub Vec2); // world-XZ unit dir of the last walk input
pub struct Player {
    pub speed_px: f32,
}
/// Click-to-walk destination (ground XZ). Inserted/removed ONLY through the
/// per-tick command buffer (the one structural-change point).
#[derive(Clone, Copy)]
pub struct WalkTarget {
    pub ground: Vec2,
    pub blocked_ticks: u32,
}
pub struct Flashlight {
    pub on: bool,
}
pub struct Pistol {
    pub cooldown_ticks: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DoorState {
    Closed,
    Opening(u32), // remaining ticks until Open
    Open,
    Closing(u32), // remaining ticks until Closed
}

pub struct Door {
    pub id: DoorId,
    pub state: DoorState,
}
pub struct DoorBody {
    pub hinge: Vec3,
    pub axis_y: f32,
    pub open_angle: f32,
    pub anim_ticks: u32,
    pub closed_solid: [f32; 4],
}
pub struct Light {
    pub id: LightId,
    pub on: bool,
    pub kind: LightKind,
    pub base_rgb: [f32; 3],
    pub li: usize, // flicker index (spec order; = the renderer's NEE-list slot)
}
pub struct Target {
    pub id: TargetId,
    pub hits: u32,
}
pub struct TargetDisc {
    pub center: Vec3,
    pub normal: Vec3,
    pub radius: f32,
}

/// A gooey, splittable fluorescent blob mob. The creature is a tiny two-anchor
/// spine (head `ends[0]`, tail `ends[1]`) acting as an internal *deformation
/// skeleton*, plus a cloud of goo particles that pool around the whole head–tail
/// SEGMENT (a capsule field) — so the body is ONE cohesive blob that is round
/// when the spine is short and elongated when it stretches. The `gait_phase`
/// clock oscillates the live spine length (bunch → lunge → reflow) to crawl, and
/// the same capsule force law lets external traps pull the goo. The head is the
/// AI-steered muscle; the tail trails it (gooey lag). This is authoritative
/// gameplay state: it evolves on the fixed
/// clock, folds into `state_hash`, and replays bit-for-bit; the translucent
/// metaball skin is a pure render read of the particle field. Copy so the
/// system can lift one out, mutate a local, and write it back (sidestepping the
/// World borrow while calling `collide_and_slide` / drawing RNG).
#[derive(Clone, Copy)]
pub struct Goo {
    pub id: MobId,
    pub ends: [Vec2; 2],      // spine end anchors: head (0), tail (1)
    pub ends_prev: [Vec2; 2], // Verlet previous (velocity = ends - ends_prev)
    pub parts: [Vec2; GOO_PARTICLES], // fluid particle positions (world-XZ)
    pub vel: [Vec2; GOO_PARTICLES],   // fluid particle velocities (wu/s)
    pub body_len: f32, // rest distance between the two end anchors
    pub tier: u8,      // 0 Large, 1 Medium, 2 Small
    pub hp: u16,
    pub state: GooState,
    pub timer: u16, // integer ticks until the next wander/idle decision
    pub heading: Vec2,
    pub gait_phase: u16,  // integer crawl-cycle clock in 0..GOO_GAIT_PERIOD
    pub merge_grace: u16, // ticks of merge immunity remaining (newborn blobs)
    pub fusing: u16,      // >0: collapsing into a survivor (ticks to despawn)
    pub fuse_pt: Vec2,    // the point this blob collapses toward while fusing
}

impl Goo {
    /// Body centroid (mean of the goo particles), world-XZ.
    pub fn centroid(&self) -> Vec2 {
        let mut c = Vec2::ZERO;
        for p in &self.parts {
            c += *p;
        }
        c / GOO_PARTICLES as f32
    }
}

/// Build a fresh blob: head at `head`, tail trailing `body_len` along
/// `-heading`, and the particles scattered as a small grid over the spine (the
/// capsule muscle rounds them into one blob within a few ticks). `vel` (per-tick
/// displacement) is baked into every `prev` so the whole body drifts on its
/// first tick (split separation). `heading` must be unit; `id`-derived scatter keeps it
/// deterministic without consuming the shared RNG.
fn fresh_goo(id: MobId, tier: u8, head: Vec2, heading: Vec2, seed_vel: Vec2, timer: u16) -> Goo {
    let body_len = goo_tier_radius(tier) * GOO_BODY_FRAC;
    let tail = head - heading * body_len;
    let ends = [head, tail];
    let mid = (head + tail) * 0.5;
    let perp = Vec2::new(-heading.y, heading.x);
    // lay the fluid out as a rough grid blob centred on the body, packed near
    // GOO_SPACING so it starts close to rest density (deterministic id/index
    // hash for the small scatter — no RNG draw).
    let cols = 7i32;
    let mut parts = [Vec2::ZERO; GOO_PARTICLES];
    for (i, p) in parts.iter_mut().enumerate() {
        let gx = (i as i32 % cols) - cols / 2;
        let gz = (i as i32 / cols) - (GOO_PARTICLES as i32 / cols) / 2;
        let h = ((id.0.wrapping_mul(2654435761)).wrapping_add(i as u32 * 40503)) as f32;
        let jit = (h * 1e-7).fract() - 0.5;
        *p = mid + heading * (gx as f32 * GOO_SPACING + jit * 0.02) + perp * (gz as f32 * GOO_SPACING);
    }
    // desync the gait clock per blob from the same id hash (RNG-free), so split
    // children never pulse in lockstep with each other or the parent.
    let gait_phase = ((id.0.wrapping_mul(2654435761)) % GOO_GAIT_PERIOD as u32) as u16;
    Goo { id, ends, ends_prev: ends.map(|e| e - seed_vel), parts, vel: [seed_vel; GOO_PARTICLES], body_len, tier, hp: goo_tier_hp(tier), state: GooState::Wander, timer, heading, gait_phase, merge_grace: GOO_MERGE_GRACE, fusing: 0, fuse_pt: Vec2::ZERO }
}

/// Integer gait phase → (gather, stretch), both in [0,1], for the crawl cycle.
/// BUNCH (gather pull ramps up, the body rounds up and the tail catches the
/// head) → LUNGE (the spine stretches forward, the body elongates) → REFLOW
/// (length eases back, the rear flows in). A pure int→f32 map: deterministic,
/// no wall clock. `gather` boosts the capsule pull; `stretch` drives the live
/// spine length between `GOO_LEN_MIN` and `GOO_LEN_MAX`.
fn gait_profile(phase: u16) -> (f32, f32) {
    let t = phase as f32 / GOO_GAIT_PERIOD as f32; // 0..1
    // stretch: contracted through the gather window, a sin² bell over the lunge.
    let stretch = if (0.35..0.75).contains(&t) {
        let u = (t - 0.35) / 0.40;
        let s = (u * std::f32::consts::PI).sin();
        s * s
    } else {
        0.0
    };
    // gather: pull boost peaks during the contract/round-up, eases on the lunge.
    let gather = if t < 0.35 {
        let u = t / 0.35;
        0.4 + 0.6 * u * u
    } else {
        0.2
    };
    (gather, stretch)
}

/// Rotate unit vector `from` toward unit vector `to` by at most `max_rad`.
fn rotate_toward(from: Vec2, to: Vec2, max_rad: f32) -> Vec2 {
    let dot = from.dot(to).clamp(-1.0, 1.0);
    let ang = dot.acos();
    if ang <= max_rad || ang == 0.0 {
        return to;
    }
    let t = max_rad / ang;
    (from * (1.0 - t) + to * t).normalize_or_zero()
}

// ---- survival components (spawned ONLY when spec.survival.is_some()) --------

/// The two needs are plain f32 in 0..=1 (full at 1.0), one component each so
/// the queries read cleanly. Present on the player iff survival is enabled.
pub struct Hunger(pub f32);
pub struct Battery(pub f32);
/// Carried items, push-ordered (FIFO is irrelevant — Use consumes by kind).
pub struct Inventory {
    pub items: Vec<ItemKind>,
    pub cap: u32,
}
/// A pickup entity: its StableId, its consume effect, and a `Pos` (separate
/// component, reusing the player's `Pos`) for the proximity test.
pub struct WorldItem {
    pub id: ItemId,
    pub kind: ItemKind,
}

/// Which need an edge-triggered survival event refers to.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum NeedKind {
    Hunger,
    Battery,
}

// ---- resources ---------------------------------------------------------------

/// Domain events, emitted by systems and drained by audio (same tick).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum GameEvent {
    DoorOpened(DoorId, Vec3),
    DoorClosed(DoorId, Vec3),
    ShotFired(Vec3),
    TargetHit(TargetId, Vec3),
    Switch, // flashlight / room-lights toggle
    /// A world item entered the inventory (id, kind, world-XZ it was lying at).
    PickedUp(ItemId, ItemKind, Vec3),
    /// One carried item was consumed to restore its need.
    Consumed(ItemKind),
    /// A need crossed BELOW `critical` this tick (edge-triggered, fires once).
    NeedCritical(NeedKind),
    /// A need climbed back to/above `critical` this tick (edge-triggered).
    NeedRecovered(NeedKind),
    /// A goo blob was shot but survived (id, hit point).
    MobHit(MobId, Vec3),
    /// A goo blob's HP hit zero and it split into two smaller blobs (id, pos).
    MobSplit(MobId, Vec3),
    /// A goo blob died terminally (a Small blob, or a capped split) (id, pos).
    MobKilled(MobId, Vec3),
    /// Two same-tier blobs touched and fused into one a tier larger — the
    /// surviving (lower) id and the fusion point.
    MobMerged(MobId, Vec3),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FlashPose {
    pub pos: Vec3,
    pub dir: Vec3,
}

/// Plain-struct resources (no type-map indirection — determinism reads best
/// when the data flow is spelled out).
pub struct Res {
    pub level: Level,
    /// Closed/animating door leaf solids, DoorId-sorted (rebuilt by door_system).
    pub dyn_solids: Vec<(DoorId, [f32; 4])>,
    /// Hitscan occluders that never change: perimeter wall slabs + static solids.
    pub static_occluders: Vec<[f32; 4]>,
    pub score: u32,
    pub rng: Pcg32,
    pub events: Events<GameEvent>,
    /// OBSERVATION-ONLY event tap for the scenario lab (`lab.rs`). When `Some`,
    /// `audio_system` pushes a copy of every drained `GameEvent` here, in the
    /// same emission order the sink sees. It is NOT read by `state_hash` or
    /// `snapshot` and never feeds back into any system — recording is provably
    /// side-effect-free (pinned by `lab::tests::recording_is_side_effect_free`).
    /// `None` by default: zero behavior change on the renderer/viewer path.
    pub event_tap: Option<Vec<GameEvent>>,
    pub flash_pose: FlashPose,
    pub yaw_q: u32,
    pub master_lights: bool,
    pub muzzle_ticks: u32,
    /// Per-light emission rgb (LightId-sorted), cached by light_system so
    /// snapshot() stays a pure read.
    pub light_rgb: Vec<(LightId, [f32; 3])>,
    pub room_lights: f32, // lit fraction of switchable (non-screen) lights
    // per-tick command staging (filled by resolve_commands, drained downstream)
    shot_intents: Vec<PickRay>,
    use_door: Vec<DoorId>,
    move_dir: IVec2,
    /// Use-item intents this tick (kind to consume), filled by resolve_commands,
    /// applied by use_system. Cleared each tick like the other staging Vecs.
    use_items: Vec<ItemKind>,
    /// Survival tuning when enabled; `None` = survival OFF (all survival
    /// systems are no-ops and nothing survival-shaped enters the hash).
    pub survival: Option<SurvivalParams>,
    /// Edge-trigger memory for `NeedCritical`/`NeedRecovered`: was [hunger,
    /// battery] below `critical` LAST tick? Compared against this tick's level
    /// so the event fires once per crossing, not every tick below threshold.
    /// (Not hashed directly — it is derivable from the hashed need levels, and
    /// only exists in survival-enabled games.)
    need_was_critical: [bool; 2],
    /// Structural changes queue here all tick; applied at ONE fixed point.
    pub buf: CommandBuffer,
    /// Seeded monotonic id for runtime-spawned goo children, starting above
    /// every authored MobId so split offspring never collide with spec ids.
    /// Advances ONLY when a blob splits (drawn in id-sorted spawn order).
    next_mob_id: u32,
    /// Set when this tick queued a mob spawn/despawn, so the post-flush
    /// `rebuild_mobs` runs only when the mob set actually changed.
    mobs_dirty: bool,
    /// Goo traps (floor gravity emitters): (xz position, strength, radius).
    /// Static for the level's life; read by `goo_system` to pull blobs.
    pub traps: Vec<(Vec2, f32, f32)>,
    /// Cached PBF rest density (kernel-calibrated; see `goo_rho0`).
    pub goo_rho0: f32,
}

/// Renderer-facing pose of one goo blob: the goo particle cloud as world points
/// (Y lifted to the particle radius so the goo rests on the floor), plus the
/// body radius and the per-particle metaball radius. The renderer raymarches a
/// translucent metaball SDF over `parts` (and instances one shadow-proxy sphere
/// per particle). Presentation-only — a pure read of the hashed particle field.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MobRender {
    pub id: MobId,
    pub tier: u8,
    pub parts: [Vec3; GOO_PARTICLES],
    pub radius: f32,
    pub part_radius: f32,
}

/// Renderer-facing view of one tick's world: StableId-sorted lists, lattice-
/// snapped player position. The adapter (rt-viewer) turns this into FrameState.
#[derive(Clone, Debug, PartialEq)]
pub struct GameSnapshot {
    pub player_pos: Vec3, // snapped to the screen-pixel lattice at yaw_q
    pub facing: Vec2,
    pub flashlight: bool,
    pub muzzle_flash: bool,
    pub doors: Vec<(DoorId, f32)>,          // current swing angle (radians)
    pub lights: Vec<(LightId, [f32; 3])>,   // emission rgb at this tick's sim time
    pub room_lights: f32,
    pub yaw_q: u32,
    pub score: u32,
    // ---- survival (for the future HUD). When survival is OFF: hunger and
    // battery are 1.0 and inventory is empty — the disabled-level snapshot is
    // therefore independent of this feature (and the hash excludes them too).
    pub hunger: f32,
    pub battery: f32,
    pub inventory: Vec<ItemKind>,
    /// Goo blobs to draw this tick, MobId-sorted. Empty on mob-free levels.
    pub mobs: Vec<MobRender>,
}

pub struct HouseGame<S: AudioSink = NullSink> {
    pub world: World,
    pub res: Res,
    pub sink: S,
    pub player: Entity,
    // spec-order entity lists, sorted by StableId at build — iteration order
    // never depends on archetype layout
    doors: Vec<Entity>,
    lights: Vec<Entity>,
    targets: Vec<Entity>,
    /// World item entities, ItemId-sorted (empty when survival is off). The
    /// list is the StableId iteration order; pickup despawns drop entries.
    items: Vec<Entity>,
    /// Goo blob entities, MobId-sorted (empty unless the level authors mobs).
    /// Rebuilt from a World query after any split flush, so iteration order is
    /// the stable MobId order regardless of hecs archetype layout.
    mobs: Vec<Entity>,
}

impl<S: AudioSink> HouseGame<S> {
    pub fn new(spec: &LevelSpec, sink: S) -> HouseGame<S> {
        let mut world = World::new();
        let level = Level { floor: spec.floor_bounds(), solids: spec.static_solids.clone() };

        // default facing: toward the camera (screen-down) until the first walk
        let down = screen_px_to_world(Vec2::new(0.0, 1.0), 0.0);
        let facing = Vec2::new(down.x, down.z).normalize();
        let player = world.spawn((Pos(spec.player_start), Facing(facing), Player { speed_px: PLAYER_SPEED_PX }, Flashlight { on: false }, Pistol { cooldown_ticks: 0 }));
        // Survival is per-level opt-in: ONLY when enabled do the needs +
        // inventory components exist (so a disabled level's player archetype,
        // snapshot, and hash are byte-identical to before this feature).
        if let Some(sp) = spec.survival {
            world.insert(player, (Hunger(1.0), Battery(1.0), Inventory { items: Vec::new(), cap: sp.inventory_cap })).unwrap();
        }

        // World items, ItemId-sorted (no HashMap iteration). Spawned only when
        // survival is enabled; spec.items is empty otherwise by construction.
        let mut items: Vec<(ItemId, Entity)> = if spec.survival.is_some() {
            spec.items.iter().map(|it| (it.id, world.spawn((WorldItem { id: it.id, kind: it.kind }, Pos(it.pos))))).collect()
        } else {
            Vec::new()
        };
        items.sort_by_key(|(id, _)| *id);

        let mut doors: Vec<(DoorId, Entity)> = spec
            .doors
            .iter()
            .map(|d| {
                assert!(d.anim_ticks >= 1, "door {:?}: anim_ticks must be >= 1", d.id);
                (d.id, world.spawn((Door { id: d.id, state: DoorState::Closed }, DoorBody { hinge: d.hinge, axis_y: d.axis_y, open_angle: d.open_angle, anim_ticks: d.anim_ticks, closed_solid: d.closed_solid })))
            })
            .collect();
        doors.sort_by_key(|(id, _)| *id);
        let mut lights: Vec<(LightId, Entity)> = spec
            .lights
            .iter()
            .enumerate()
            .map(|(li, l)| (l.id, world.spawn((Light { id: l.id, on: true, kind: l.kind, base_rgb: l.base_rgb, li },))))
            .collect();
        lights.sort_by_key(|(id, _)| *id);
        let mut targets: Vec<(TargetId, Entity)> = spec.targets.iter().map(|t| (t.id, world.spawn((Target { id: t.id, hits: 0 }, TargetDisc { center: t.center, normal: t.normal, radius: t.radius })))).collect();
        targets.sort_by_key(|(id, _)| *id);

        // perimeter occluder slabs (targets sit ON the inner face: an exact
        // plane tie does not block — see shoot_system's strict comparison)
        let f = level.floor;
        let static_occluders: Vec<[f32; 4]> = [[f[0] - WALL_T, f[1] - WALL_T, f[0], f[3] + WALL_T], [f[2], f[1] - WALL_T, f[2] + WALL_T, f[3] + WALL_T], [f[0] - WALL_T, f[1] - WALL_T, f[2] + WALL_T, f[1]], [f[0] - WALL_T, f[3], f[2] + WALL_T, f[3] + WALL_T]]
            .into_iter()
            .chain(spec.static_solids.iter().copied())
            .collect();

        let res = Res {
            level,
            dyn_solids: Vec::new(),
            static_occluders,
            score: 0,
            rng: Pcg32::new(spec.seed),
            events: Events::new(),
            event_tap: None,
            flash_pose: FlashPose { pos: Vec3::ZERO, dir: Vec3::NEG_Y },
            yaw_q: 0,
            master_lights: true,
            muzzle_ticks: 0,
            light_rgb: Vec::new(),
            room_lights: 0.0,
            shot_intents: Vec::new(),
            use_door: Vec::new(),
            move_dir: IVec2::ZERO,
            use_items: Vec::new(),
            survival: spec.survival,
            need_was_critical: [false; 2], // needs start full (1.0) → not critical
            buf: CommandBuffer::new(),
            // children spawn above every authored id (0 when the level has none)
            next_mob_id: spec.mobs.iter().map(|m| m.id.0 + 1).max().unwrap_or(0),
            mobs_dirty: false,
            traps: spec.traps.iter().map(|t| (Vec2::new(t.pos.x, t.pos.z), t.strength, t.radius)).collect(),
            goo_rho0: goo_rho0(),
        };

        // Goo blobs, MobId-sorted (no HashMap iteration). Spawned only when the
        // level authors mobs; spec.mobs is empty otherwise by construction, so a
        // mob-free level's archetypes / hash / snapshot are byte-identical. RNG
        // is drawn ONLY here (and never for empty levels), in MobId order.
        let mut rng = res.rng.clone(); // seed initial headings without disturbing the live rng probe yet
        let mut mob_pairs: Vec<(MobId, Entity)> = spec
            .mobs
            .iter()
            .map(|m| {
                let head = Vec2::new(m.pos.x, m.pos.z);
                let a = rng.next_f32() * std::f32::consts::TAU;
                let heading = Vec2::new(a.cos(), a.sin());
                let timer = 60 + (rng.next_f32() * 120.0) as u16;
                (m.id, world.spawn((fresh_goo(m.id, m.tier, head, heading, Vec2::ZERO, timer),)))
            })
            .collect();
        mob_pairs.sort_by_key(|(id, _)| *id);
        let mut res = res;
        res.rng = rng; // adopt the advanced stream so the next draw is deterministic and distinct

        let mut g = HouseGame {
            world,
            res,
            sink,
            player,
            doors: doors.into_iter().map(|(_, e)| e).collect(),
            lights: lights.into_iter().map(|(_, e)| e).collect(),
            targets: targets.into_iter().map(|(_, e)| e).collect(),
            items: items.into_iter().map(|(_, e)| e).collect(),
            mobs: mob_pairs.into_iter().map(|(_, e)| e).collect(),
        };
        g.reseed();
        g
    }

    /// Re-derive the cached state (door solids, flash pose, per-light rgb at
    /// t = 0) so a pre-tick snapshot is coherent. Called once by `new`; the
    /// shell calls it again after its DIRECT Config seeding writes (flashlight
    /// boot state, yaw quarter, player offset bypass the command stream by
    /// design — they are world setup, not play).
    pub fn reseed(&mut self) {
        self.rebuild_dyn_solids();
        self.flashlight_system();
        self.light_system(0.0);
    }

    /// Rebuild the MobId-sorted `self.mobs` handle list from a World query.
    /// This is the runtime-spawn handle recovery: `CommandBuffer::spawn` does
    /// not return the `Entity` it creates, so after a split flush we re-find
    /// every `Goo` entity and sort by the stable, seeded `MobId`. Archetype
    /// iteration only BUILDS the set; the sort key (MobId) — never archetype
    /// order — becomes the iteration/hash order, so determinism holds.
    fn rebuild_mobs(&mut self) {
        let mut pairs: Vec<(MobId, Entity)> = self.world.query::<&Goo>().iter().map(|(e, g)| (g.id, e)).collect();
        pairs.sort_by_key(|(id, _)| *id);
        self.mobs = pairs.into_iter().map(|(_, e)| e).collect();
    }

    fn player_pos(&self) -> Vec3 {
        self.world.get::<&Pos>(self.player).unwrap().0
    }

    fn player_facing(&self) -> Vec2 {
        self.world.get::<&Facing>(self.player).unwrap().0
    }

    /// True if ground point (x, z) is blocked for WALKING: level (floor rect +
    /// static solids) or any present door leaf solid.
    fn walk_blocked(&self, x: f32, z: f32) -> bool {
        self.res.level.is_blocked(x, z) || self.res.dyn_solids.iter().any(|(_, s)| x >= s[0] && z >= s[1] && x <= s[2] && z <= s[3])
    }

    /// Solidity the GOO sees: everything `walk_blocked` blocks PLUS the player's
    /// pillar footprint (inflated by the goo's surface clearance). The player
    /// itself never tests this — it walks freely through its own marker — so the
    /// fluid flows and drapes around the player while the player is unobstructed.
    fn goo_solid(&self, x: f32, z: f32) -> bool {
        if self.walk_blocked(x, z) {
            return true;
        }
        let p = self.player_pos();
        let m = PLAYER_HALF + GOO_COLLIDER_MARGIN;
        (x - p.x).abs() < m && (z - p.z).abs() < m
    }

    /// Nearest door whose interact volume (closed slab inflated 0.3 wu) the
    /// ray passes through, regardless of current state.
    fn door_under_ray(&self, ray: &PickRay) -> Option<DoorId> {
        let mut best: Option<(f32, DoorId)> = None;
        for &e in &self.doors {
            let door = self.world.get::<&Door>(e).unwrap();
            let body = self.world.get::<&DoorBody>(e).unwrap();
            let s = body.closed_solid;
            let lo = Vec3::new(s[0] - DOOR_INTERACT_INFLATE, -DOOR_INTERACT_INFLATE, s[1] - DOOR_INTERACT_INFLATE);
            let hi = Vec3::new(s[2] + DOOR_INTERACT_INFLATE, DOOR_H + DOOR_INTERACT_INFLATE, s[3] + DOOR_INTERACT_INFLATE);
            if let Some((tmin, _)) = ray_aabb(ray, lo, hi) {
                if tmin >= 0.0 && best.map_or(true, |(bt, _)| tmin < bt) {
                    best = Some((tmin, door.id));
                }
            }
        }
        best.map(|(_, id)| id)
    }

    // ---- the 7 systems, fixed source order ------------------------------------

    /// 1. Commands → semantic intents. Click: door interact beats ground walk;
    /// walks to blocked/off-floor points are no-ops (no clamp-to-edge in v1).
    fn resolve_commands(&mut self, cmds: &[Command]) {
        self.res.move_dir = IVec2::ZERO;
        self.res.shot_intents.clear();
        self.res.use_door.clear();
        self.res.use_items.clear();
        for c in cmds {
            match c {
                Command::Click { ray, ground } => {
                    if let Some(id) = self.door_under_ray(ray) {
                        self.res.use_door.push(id);
                    } else if let Some(g) = ground {
                        if !self.walk_blocked(g.x, g.y) {
                            self.res.buf.insert_one(self.player, WalkTarget { ground: *g, blocked_ticks: 0 });
                        }
                    }
                }
                Command::Shoot { ray } => self.res.shot_intents.push(*ray),
                Command::Move { dir } => self.res.move_dir = *dir, // last press this tick wins
                Command::ToggleFlashlight => {
                    // A dead battery (battery == 0) makes turning the torch ON
                    // a no-op: you can't light a flashlight with no charge.
                    // Turning it off always works. (Survival-off games have no
                    // Battery component → the guard is vacuously true.)
                    let dead = self.battery_dead();
                    let mut fl = self.world.get::<&mut Flashlight>(self.player).unwrap();
                    let want_on = !fl.on;
                    if want_on && dead {
                        // swallowed: no state change, no Switch cue
                    } else {
                        fl.on = want_on;
                        drop(fl);
                        self.res.events.emit(GameEvent::Switch);
                    }
                }
                Command::ToggleRoomLights => {
                    self.res.master_lights = !self.res.master_lights;
                    self.res.events.emit(GameEvent::Switch);
                }
                Command::RotateCamera { dq } => self.res.yaw_q = (self.res.yaw_q as i32 + *dq as i32).rem_euclid(4) as u32,
                Command::Use { kind } => self.res.use_items.push(*kind), // applied by use_system
            }
        }
    }

    /// True when survival is on AND the battery is empty. Used to gate the
    /// flashlight toggle (and to force it off in needs_system). Survival-off
    /// games have no Battery component, so this is always false there.
    fn battery_dead(&self) -> bool {
        self.res.survival.is_some() && self.world.get::<&Battery>(self.player).map(|b| b.0 <= 0.0).unwrap_or(false)
    }

    /// 2. Door state machines on tick counters. The leaf collision solid is
    /// present iff the door is not fully Open; the anti-trap rule refuses to
    /// re-insert it (i.e. to start Closing) while the player AABB overlaps.
    fn door_system(&mut self) {
        let p = self.player_pos();
        for &e in &self.doors {
            let (body_solid, hinge, anim) = {
                let body = self.world.get::<&DoorBody>(e).unwrap();
                (body.closed_solid, body.hinge, body.anim_ticks)
            };
            let mut door = self.world.get::<&mut Door>(e).unwrap();
            let used = self.res.use_door.contains(&door.id);
            let id = door.id;
            door.state = match door.state {
                DoorState::Closed if used => DoorState::Opening(anim),
                DoorState::Open if used => {
                    let s = body_solid;
                    let overlap = p.x + PLAYER_HALF > s[0] && p.x - PLAYER_HALF < s[2] && p.z + PLAYER_HALF > s[1] && p.z - PLAYER_HALF < s[3];
                    if overlap {
                        DoorState::Open // refused: never trap the player
                    } else {
                        DoorState::Closing(anim)
                    }
                }
                DoorState::Opening(k) => {
                    let k = k - 1;
                    if k == 0 {
                        self.res.events.emit(GameEvent::DoorOpened(id, hinge));
                        DoorState::Open
                    } else {
                        DoorState::Opening(k)
                    }
                }
                DoorState::Closing(k) => {
                    let k = k - 1;
                    if k == 0 {
                        self.res.events.emit(GameEvent::DoorClosed(id, hinge));
                        DoorState::Closed
                    } else {
                        DoorState::Closing(k)
                    }
                }
                s => s,
            };
        }
        self.rebuild_dyn_solids();
    }

    fn rebuild_dyn_solids(&mut self) {
        self.res.dyn_solids.clear();
        for &e in &self.doors {
            let door = self.world.get::<&Door>(e).unwrap();
            if door.state != DoorState::Open {
                let body = self.world.get::<&DoorBody>(e).unwrap();
                self.res.dyn_solids.push((door.id, body.closed_solid));
            }
        }
        // self.doors is id-sorted, so dyn_solids already is too
    }

    /// 3. Movement: manual Move (iso 2:1 input dir) wins over a WalkTarget;
    /// both integrate at the floored speed on the screen-pixel basis at yaw_q
    /// and collide-and-slide. Arrive (< 1 px) or blocked-two-ticks clears the
    /// target. Facing tracks the ATTEMPTED direction (turning against a wall).
    fn walk_system(&mut self) {
        let yaw = 90.0 * self.res.yaw_q as f32;
        let speed = {
            let pl = self.world.get::<&Player>(self.player).unwrap();
            // Starving (hunger == 0) scales the effective px/s by
            // hunger_zero_speed_mul. We scale BEFORE the smoothness floor so a
            // slow-walk can dip below recommendedMinPxPerSec by design (the
            // cornerstone trajectory + mesh stability still hold; the eye just
            // sees discrete ticks — see CLAUDE.md invariant 10).
            let mul = if let Some(sp) = self.res.survival {
                if self.world.get::<&Hunger>(self.player).map(|h| h.0 <= 0.0).unwrap_or(false) {
                    sp.hunger_zero_speed_mul
                } else {
                    1.0
                }
            } else {
                1.0
            };
            (pl.speed_px * mul).max(recommended_min_px_per_sec(60.0) * mul)
        };
        let pos = self.player_pos();
        let manual = self.res.move_dir != IVec2::ZERO;
        let dpx: Option<Vec2> = if manual {
            // WASD fallback: a held key overrides (and cancels) click-walk
            if self.world.get::<&WalkTarget>(self.player).is_ok() {
                self.res.buf.remove_one::<WalkTarget>(self.player);
            }
            iso_input_dir(self.res.move_dir.x as f32, self.res.move_dir.y as f32).map(|d| d * speed * TICK_DT)
        } else if let Ok(wt) = self.world.get::<&WalkTarget>(self.player) {
            // remaining screen-px vector to the target at the CURRENT yaw
            let (_d, right, up) = iso_basis(yaw);
            let tgt = Vec3::new(wt.ground.x, 0.0, wt.ground.y);
            let d = Vec2::new((tgt - pos).dot(right) * ISO_R, -(tgt - pos).dot(up) * ISO_R);
            if d.length() < WALK_ARRIVE_PX {
                drop(wt);
                self.res.buf.remove_one::<WalkTarget>(self.player);
                None
            } else {
                Some(d * (d.length().min(speed * TICK_DT) / d.length()))
            }
        } else {
            None
        };
        let Some(dpx) = dpx else { return };
        let world_d = screen_px_to_world(dpx, yaw);
        if let Some(f) = Vec2::new(world_d.x, world_d.z).try_normalize() {
            self.world.get::<&mut Facing>(self.player).unwrap().0 = f;
        }
        let (px, pz) = {
            let blocked = |x: f32, z: f32| self.walk_blocked(x, z);
            collide_and_slide(blocked, pos.x, pos.z, world_d.x, world_d.z)
        };
        if px != pos.x || pz != pos.z {
            let mut p = self.world.get::<&mut Pos>(self.player).unwrap();
            p.0.x = px;
            p.0.z = pz;
        }
        // blocked accounting needs an epsilon: the screen->world round trip of
        // an axis-aligned walk leaves ~1e-7 wu of f32 drift on the slide axis,
        // which must not read as progress (a hard-blocked walk would then
        // never clear). Real steps are >= ~1e-2 wu (the 1 px arrive floor).
        let advanced = (px - pos.x).abs() > 1e-5 || (pz - pos.z).abs() > 1e-5;
        if !manual {
            if let Ok(mut wt) = self.world.get::<&mut WalkTarget>(self.player) {
                if advanced {
                    wt.blocked_ticks = 0;
                } else {
                    wt.blocked_ticks += 1;
                    if wt.blocked_ticks >= WALK_BLOCKED_TICKS {
                        drop(wt);
                        self.res.buf.remove_one::<WalkTarget>(self.player);
                    }
                }
            }
        }
    }

    /// 3b. Pickups: after the player has moved, any WorldItem within
    /// `pickup_radius` (world-XZ) is collected if the inventory has room —
    /// kind pushed to the inventory, item despawned via the command buffer,
    /// `PickedUp` emitted. Items iterate in ItemId-sorted order (self.items is
    /// id-sorted; despawns drop entries) so two items inside the radius on the
    /// same tick are picked in a deterministic, hash-stable order. No-op when
    /// survival is off (self.items is empty).
    fn pickup_system(&mut self) {
        let Some(sp) = self.res.survival else { return };
        if self.items.is_empty() {
            return;
        }
        let p = self.player_pos();
        let r2 = sp.pickup_radius * sp.pickup_radius;
        let mut picked: Vec<Entity> = Vec::new();
        for &e in &self.items {
            // room left this tick = cap − (carried so far including this tick's picks)
            let (count, cap) = {
                let inv = self.world.get::<&Inventory>(self.player).unwrap();
                (inv.items.len() as u32, inv.cap)
            };
            if count >= cap {
                break; // full; remaining items stay on the floor
            }
            let (id, kind, ipos) = {
                let wi = self.world.get::<&WorldItem>(e).unwrap();
                (wi.id, wi.kind, self.world.get::<&Pos>(e).unwrap().0)
            };
            let dx = ipos.x - p.x;
            let dz = ipos.z - p.z;
            if dx * dx + dz * dz <= r2 {
                self.world.get::<&mut Inventory>(self.player).unwrap().items.push(kind);
                self.res.buf.despawn(e); // the one structural-change point per tick
                self.res.events.emit(GameEvent::PickedUp(id, kind, ipos));
                picked.push(e);
            }
        }
        // drop the picked entities from the iteration list (the despawn lands
        // at the per-tick buffer flush; keep self.items consistent with it)
        if !picked.is_empty() {
            self.items.retain(|e| !picked.contains(e));
        }
    }

    /// Consume-item handling: each `Command::Use { kind }` this tick removes one
    /// carried item of that kind and restores the matching need (clamped 1.0),
    /// emitting `Consumed`. A Use with no matching item carried is a silent
    /// no-op (no event, no restore). No-op entirely when survival is off.
    fn use_system(&mut self) {
        let Some(sp) = self.res.survival else {
            return;
        };
        let intents = std::mem::take(&mut self.res.use_items);
        for kind in intents {
            // remove one carried item of this kind (FIFO; order is irrelevant)
            let removed = {
                let mut inv = self.world.get::<&mut Inventory>(self.player).unwrap();
                if let Some(i) = inv.items.iter().position(|k| *k == kind) {
                    inv.items.remove(i);
                    true
                } else {
                    false
                }
            };
            if !removed {
                continue; // nothing carried → no-op
            }
            match kind {
                ItemKind::Food => {
                    let mut h = self.world.get::<&mut Hunger>(self.player).unwrap();
                    h.0 = (h.0 + sp.food_restore).min(1.0);
                }
                ItemKind::Battery => {
                    let mut b = self.world.get::<&mut Battery>(self.player).unwrap();
                    b.0 = (b.0 + sp.battery_restore).min(1.0);
                }
            }
            self.res.events.emit(GameEvent::Consumed(kind));
        }
    }

    /// Needs tick (run near the end of the tick, after movement/use): hunger
    /// always decays; battery drains ONLY while the flashlight is on. Pressure
    /// effects: a dead battery (0) forces the flashlight OFF (and the toggle is
    /// already gated off in resolve_commands). NeedCritical fires the FIRST tick
    /// a need crosses BELOW `critical`; NeedRecovered when it climbs back to/
    /// above. Edge state lives in `need_was_critical`. Hunger-zero slowdown is
    /// applied in walk_system (it reads hunger there). No-op when survival off.
    fn needs_system(&mut self) {
        let Some(sp) = self.res.survival else { return };
        let flashlight_on = self.world.get::<&Flashlight>(self.player).unwrap().on;
        let (hunger, battery) = {
            let mut h = self.world.get::<&mut Hunger>(self.player).unwrap();
            h.0 = (h.0 - sp.hunger_decay).max(0.0);
            let mut b = self.world.get::<&mut Battery>(self.player).unwrap();
            if flashlight_on {
                b.0 = (b.0 - sp.battery_drain).max(0.0);
            }
            (h.0, b.0)
        };
        // dead battery → torch off (a no-op if already off; no Switch cue: the
        // torch dying is not a player-driven switch)
        if battery <= 0.0 {
            self.world.get::<&mut Flashlight>(self.player).unwrap().on = false;
        }
        // edge-triggered critical/recovered, hunger then battery (stable order)
        for (i, (level, need)) in [(hunger, NeedKind::Hunger), (battery, NeedKind::Battery)].into_iter().enumerate() {
            let now = level < sp.critical;
            if now && !self.res.need_was_critical[i] {
                self.res.events.emit(GameEvent::NeedCritical(need));
            } else if !now && self.res.need_was_critical[i] {
                self.res.events.emit(GameEvent::NeedRecovered(need));
            }
            self.res.need_was_critical[i] = now;
        }
    }

    /// 3c. Goo blobs crawl: per blob, a deliberately-dumb wander/seek/idle AI
    /// steers the head anchor (which moves via `collide_and_slide`, so walls stop
    /// it like the player); the tail trails it and the integer gait clock
    /// oscillates the spine length (bunch → lunge → reflow) for a crawling gait.
    /// The fluid body is then a full Position-Based Fluids step — a capsule
    /// muscle force toward the spine pulls the particles along, then a density
    /// (incompressibility) solve, tensile cohesion, wall clamp and XSPH
    /// viscosity. A blob mid-fusion instead just collapses into its survivor.
    /// No-op (and no RNG draw) when the level has no mobs, so mob-free levels
    /// stay byte-identical. Runs after walk (it is a mover) and before shoot
    /// (so hit tests see the current pose).
    fn goo_system(&mut self) {
        if self.mobs.is_empty() {
            return;
        }
        let player = self.player_pos();
        let pxz = Vec2::new(player.x, player.z);
        let aggro2 = GOO_AGGRO * GOO_AGGRO;
        // self.mobs is MobId-sorted, so the RNG draw order below is stable.
        let mobs = self.mobs.clone();
        for e in mobs {
            // lift the blob out as a local copy: mutating it in place would
            // hold a World borrow across the collide closure (which borrows
            // &self) and the RNG draws (which borrow &mut self.res).
            let mut g = *self.world.get::<&Goo>(e).unwrap();

            // --- FUSING: this blob is collapsing into a survivor. Ooze its
            // particles toward the fusion point and deflate it (render size
            // follows body_len), then despawn when the collapse completes. No
            // AI/gait/PBF while fusing — it just flows in and shrinks out. ---
            if g.fusing > 0 {
                g.fusing -= 1;
                for p in g.parts.iter_mut() {
                    *p += (g.fuse_pt - *p) * GOO_FUSE_COLLAPSE;
                }
                for v in g.vel.iter_mut() {
                    *v *= 0.5;
                }
                g.body_len *= GOO_FUSE_DEFLATE;
                g.ends = [g.fuse_pt, g.fuse_pt];
                g.ends_prev = g.ends;
                if g.fusing == 0 {
                    self.res.buf.despawn(e);
                    self.res.mobs_dirty = true;
                }
                *self.world.get::<&mut Goo>(e).unwrap() = g;
                continue;
            }

            // --- AI: pick a target travel direction (steers the head anchor) ---
            let head = g.ends[0];
            let to_player = pxz - head;
            let dist2 = to_player.length_squared();
            g.timer = g.timer.saturating_sub(1);
            // seek when the player is close; relax back to wander past a hysteresis band
            if dist2 < aggro2 {
                g.state = GooState::Seek;
            } else if g.state == GooState::Seek && dist2 > aggro2 * 1.7 {
                g.state = GooState::Wander;
                g.timer = 0; // re-pick a wander heading next
            }
            if g.state != GooState::Seek && g.timer == 0 {
                if self.res.rng.next_f32() < 0.25 {
                    g.state = GooState::Idle;
                    g.timer = 30 + (self.res.rng.next_f32() * 90.0) as u16;
                } else {
                    let a = self.res.rng.next_f32() * std::f32::consts::TAU;
                    g.heading = Vec2::new(a.cos(), a.sin());
                    g.state = GooState::Wander;
                    g.timer = 60 + (self.res.rng.next_f32() * 120.0) as u16;
                }
            }
            let target_dir = match g.state {
                GooState::Seek => to_player.normalize_or_zero(),
                GooState::Wander => g.heading,
                GooState::Idle => Vec2::ZERO,
            };
            if let Some(td) = target_dir.try_normalize() {
                g.heading = rotate_toward(g.heading, td, GOO_MAX_TURN);
            }
            let mv = if g.state == GooState::Idle { 0.0 } else { 1.0 };
            let speed = goo_tier_speed(g.tier);

            // --- crawl gait clock: advance the integer phase every tick (even
            // while Idle, so a resting blob still breathes) and read its
            // (gather, stretch) envelope. `stretch` sets the live spine length
            // → the body squashes and stretches; `gather` boosts the capsule
            // pull during the round-up. Deterministic, hashed as u64. ---
            g.gait_phase = (g.gait_phase + 1) % GOO_GAIT_PERIOD;
            g.merge_grace = g.merge_grace.saturating_sub(1); // newborn merge immunity ticks down
            // ease the rest spine length toward this tier's target — normally a
            // no-op (already there), but after a merge it grows the blob into its
            // new (larger) tier over ~½ s instead of snapping (drives render size).
            let bl_target = goo_tier_radius(g.tier) * GOO_BODY_FRAC;
            g.body_len += (bl_target - g.body_len) * GOO_GROW_RATE;
            let (gather, stretch) = gait_profile(g.gait_phase);
            let gait_len = g.body_len * (GOO_LEN_MIN + (GOO_LEN_MAX - GOO_LEN_MIN) * stretch);

            // --- head anchor: Verlet inertia + steering drive + trap pull,
            // through collide_and_slide (walls stop it like the player). The
            // drive surges with the lunge (`stretch`) so the creature pushes off
            // each gait cycle rather than gliding at a constant rate. ---
            let inertia = (g.ends[0] - g.ends_prev[0]) * GOO_VERLET_DAMP * GOO_HEAD_INERTIA;
            let drive = g.heading * (speed * mv * (0.5 + 0.5 * stretch) * TICK_DT);
            let d = inertia + drive + self.trap_accel(g.ends[0]) * GOO_END_TRAP;
            let (nx, nz) = collide_and_slide(|x, z| self.goo_solid(x, z), g.ends[0].x, g.ends[0].y, d.x, d.y);
            g.ends_prev[0] = g.ends[0];
            g.ends[0] = Vec2::new(nx, nz);

            // --- tail anchor: Verlet + trap pull, then a distance constraint
            // holding it the (gait-modulated) spine length behind the head. As
            // `gait_len` shrinks the tail catches up (round-up) and as it grows
            // the body extends (the inchworm reach). ---
            let tail_d = (g.ends[1] - g.ends_prev[1]) * GOO_VERLET_DAMP + self.trap_accel(g.ends[1]) * GOO_END_TRAP;
            g.ends_prev[1] = g.ends[1];
            g.ends[1] += tail_d;
            let span = g.ends[1] - g.ends[0];
            let dist = span.length().max(1e-5);
            g.ends[1] = g.ends[0] + span * (gait_len / dist);

            // --- fluid body: Position-Based Fluids (Macklin & Müller 2013).
            // External body forces (pull toward the two spine ends + traps)
            // predict positions; then density-constraint Jacobi iterations make
            // it incompressible, the tensile s_corr term gives surface-tension
            // cohesion (the slime clump), and XSPH viscosity gives the gooey
            // coherent flow. Walls clamp the predicted positions so the fluid
            // pools against geometry. ---
            let dt = TICK_DT;
            let rho0 = self.res.goo_rho0;
            let a_end = g.ends[0];
            let ab = g.ends[1] - g.ends[0];
            let ab2 = ab.length_squared().max(1e-6);
            let mid = a_end + ab * 0.5;
            // how "capsule-like" the attractor is this tick: at rest (stretch 0)
            // the whole body pulls toward the spine MIDPOINT → one round blob; on
            // the lunge (stretch 1) it pulls toward the nearest segment point →
            // the body elongates along the spine. This is the squash-and-stretch.
            let cap_blend = stretch;
            let perp = Vec2::new(-g.heading.y, g.heading.x);
            // capsule pull, ramped up by the gather envelope (round-up phase) but
            // floored so cohesion always wins — capped at GOO_END_PULL so the PBF
            // stability regime is exactly the one the solver was tuned against.
            let pull = GOO_END_PULL * (GOO_PULL_BASE + (1.0 - GOO_PULL_BASE) * gather);
            let mut xp = [Vec2::ZERO; GOO_PARTICLES];
            for i in 0..GOO_PARTICLES {
                let p = g.parts[i];
                // capsule muscle: softened inverse-distance pull toward an
                // anchor that blends from the spine MIDPOINT (round blob, at
                // rest) to the NEAREST point on the head→tail segment (elongated,
                // mid-lunge). One cohesive blob, hauled along as the spine
                // crawls. Self-limiting (vanishes at the anchor).
                let t = ((p - a_end).dot(ab) / ab2).clamp(0.0, 1.0);
                let seg = a_end + ab * t;
                let anchor = mid + (seg - mid) * cap_blend;
                let dir = anchor - p;
                let dist = dir.length();
                let mut a = dir / (dist + 0.10) * pull;
                // lateral self-centering: damp the velocity component across the
                // heading so turns don't smear the body sideways.
                a -= perp * (g.vel[i].dot(perp) * GOO_LATERAL);
                a += self.trap_accel(p);
                g.vel[i] = (g.vel[i] + a * dt) * GOO_DAMP;
                let vl = g.vel[i].length();
                if vl > GOO_MAX_VEL {
                    g.vel[i] *= GOO_MAX_VEL / vl;
                }
                xp[i] = p + g.vel[i] * dt;
            }
            let scorr_denom = goo_w(0.2 * GOO_H).max(1e-6);
            for _ in 0..GOO_SOLVER_ITERS {
                // density + per-particle lambda
                let mut lambda = [0.0f32; GOO_PARTICLES];
                for i in 0..GOO_PARTICLES {
                    let mut rho = 0.0;
                    let mut grad_i = Vec2::ZERO;
                    let mut sum_grad2 = 0.0;
                    for j in 0..GOO_PARTICLES {
                        let rij = xp[i] - xp[j];
                        let r = rij.length();
                        rho += goo_w(r);
                        if i != j && r > 1e-6 {
                            let gw = rij / r * goo_dw(r); // ∇W(p_i - p_j)
                            grad_i += gw;
                            sum_grad2 += gw.length_squared();
                        }
                    }
                    sum_grad2 += grad_i.length_squared();
                    let c = rho / rho0 - 1.0;
                    lambda[i] = -c / (sum_grad2 / (rho0 * rho0) + GOO_CFM_EPS);
                }
                // position corrections (incompressibility + cohesion)
                for i in 0..GOO_PARTICLES {
                    let mut dp = Vec2::ZERO;
                    for j in 0..GOO_PARTICLES {
                        if i == j {
                            continue;
                        }
                        let rij = xp[i] - xp[j];
                        let r = rij.length();
                        if r >= GOO_H || r < 1e-6 {
                            continue;
                        }
                        let scorr = -GOO_SCORR_K * (goo_w(r) / scorr_denom).powi(GOO_SCORR_N);
                        let gw = rij / r * goo_dw(r);
                        dp += gw * ((lambda[i] + lambda[j] + scorr) / rho0);
                    }
                    // clamp the correction so the density solve can never overshoot
                    let dl = dp.length();
                    if dl > GOO_MAX_DP {
                        dp *= GOO_MAX_DP / dl;
                    }
                    xp[i] += dp;
                }
                // walls + player pillar: keep the fluid out of solids (per-axis
                // slide back), so the body drapes against geometry and the player.
                for i in 0..GOO_PARTICLES {
                    if self.goo_solid(xp[i].x, xp[i].y) {
                        let o = g.parts[i];
                        if !self.goo_solid(xp[i].x, o.y) {
                            xp[i].y = o.y;
                        } else if !self.goo_solid(o.x, xp[i].y) {
                            xp[i].x = o.x;
                        } else {
                            xp[i] = o;
                        }
                    }
                }
            }
            // velocity from the solved motion, then XSPH viscosity for cohesion
            for i in 0..GOO_PARTICLES {
                g.vel[i] = (xp[i] - g.parts[i]) / dt;
            }
            let vin = g.vel;
            for i in 0..GOO_PARTICLES {
                let mut dv = Vec2::ZERO;
                for j in 0..GOO_PARTICLES {
                    if i == j {
                        continue;
                    }
                    let r = (xp[i] - xp[j]).length();
                    dv += (vin[j] - vin[i]) * goo_w(r);
                }
                g.vel[i] += dv * GOO_VISCOSITY;
            }
            g.parts = xp;

            *self.world.get::<&mut Goo>(e).unwrap() = g;
        }
    }

    /// Net inverse-square ACCELERATION (wu/s²) of every in-range trap on a
    /// world-XZ point: inert beyond `radius`, else `strength · GOO_TRAP_PULL /
    /// dist²` toward the centre. The shared force law for the fluid AND the
    /// spine ends (so a captured blob's whole body is dragged in).
    fn trap_accel(&self, p: Vec2) -> Vec2 {
        let mut f = Vec2::ZERO;
        for &(c, strength, radius) in &self.res.traps {
            let dir = c - p;
            let dist = dir.length();
            if dist > radius || dist < 1e-3 {
                continue;
            }
            let d2 = dist * dist + GOO_SOFTEN;
            f += dir / dist * (strength * GOO_TRAP_PULL / d2);
        }
        // cap the magnitude so the inverse-square singularity at a trap centre
        // holds a blob rather than flinging it (kept the merged blob from spinning).
        let fl = f.length();
        if fl > GOO_TRAP_MAX {
            f *= GOO_TRAP_MAX / fl;
        }
        f
    }

    /// 4. Cooldown-gated hitscan along the pick ray, starting at the muzzle
    /// (hits behind the player don't count). First-occluder test against
    /// perimeter walls + static solids + present door leaves in the [0, WALL_H]
    /// band vs the target discs; an exact plane tie (disc ON a wall face) hits.
    fn shoot_system(&mut self) {
        self.res.muzzle_ticks = self.res.muzzle_ticks.saturating_sub(1);
        {
            let mut pistol = self.world.get::<&mut Pistol>(self.player).unwrap();
            pistol.cooldown_ticks = pistol.cooldown_ticks.saturating_sub(1);
        }
        if self.res.shot_intents.is_empty() {
            return;
        }
        let intents = std::mem::take(&mut self.res.shot_intents);
        let pos = self.player_pos();
        let facing = self.player_facing();
        let (muzzle, _) = flashlight_pose(pos, facing); // hand height = muzzle height
        for ray in intents {
            {
                let mut pistol = self.world.get::<&mut Pistol>(self.player).unwrap();
                if pistol.cooldown_ticks > 0 {
                    continue; // swallowed: spam never queues
                }
                pistol.cooldown_ticks = PISTOL_COOLDOWN_TICKS;
            }
            self.res.muzzle_ticks = MUZZLE_FLASH_TICKS;
            self.res.events.emit(GameEvent::ShotFired(muzzle));
            // shots only count from the muzzle forward along the ray
            let t_start = (muzzle - ray.origin).dot(ray.dir).max(0.0);
            // nearest target disc past the muzzle
            let mut best: Option<(f32, Entity, TargetId, Vec3)> = None;
            for &e in &self.targets {
                let disc = self.world.get::<&TargetDisc>(e).unwrap();
                let denom = ray.dir.dot(disc.normal);
                if denom.abs() < 1e-6 {
                    continue;
                }
                let t = (disc.center - ray.origin).dot(disc.normal) / denom;
                if t <= t_start + 1e-4 {
                    continue;
                }
                let p = ray.origin + ray.dir * t;
                if (p - disc.center).length() <= disc.radius && best.map_or(true, |(bt, ..)| t < bt) {
                    let id = self.world.get::<&Target>(e).unwrap().id;
                    best = Some((t, e, id, p));
                }
            }
            // Goo blobs are shootable too: find the nearest blob bounding-sphere
            // the ray crosses past the muzzle. If a blob is closer than any disc
            // (and not behind a wall), the shot is spent on it — damage/split —
            // and we move to the next ray. No-op on mob-free levels (the disc
            // path below is then byte-identical to before).
            if !self.mobs.is_empty() {
                let mut mob_best: Option<(f32, Entity)> = None;
                for &me in &self.mobs {
                    let g = self.world.get::<&Goo>(me).unwrap();
                    if g.fusing > 0 {
                        continue; // a collapsing blob isn't a shot target (it's despawning)
                    }
                    let c2 = g.centroid();
                    let r = goo_tier_radius(g.tier);
                    let center = Vec3::new(c2.x, r, c2.y);
                    // hit sphere covers the whole fluid spread (the body spans
                    // ~body_len), so a shot anywhere on the blob connects.
                    if let Some(t) = ray_sphere(&ray, center, r + g.body_len * 0.7) {
                        if t > t_start + 1e-4 && mob_best.map_or(true, |(bt, _)| t < bt) {
                            mob_best = Some((t, me));
                        }
                    }
                }
                if let Some((t_mob, me)) = mob_best {
                    let disc_t = best.map_or(f32::MAX, |(t, ..)| t);
                    if t_mob < disc_t {
                        let wall_block = self.res.static_occluders.iter().chain(self.res.dyn_solids.iter().map(|(_, s)| s)).any(|s| {
                            let lo = Vec3::new(s[0], 0.0, s[1]);
                            let hi = Vec3::new(s[2], WALL_H, s[3]);
                            ray_aabb(&ray, lo, hi).is_some_and(|(tmin, _)| tmin > t_start + 1e-4 && tmin < t_mob - 1e-4)
                        });
                        if !wall_block {
                            self.damage_goo(me, &ray);
                        }
                        continue; // shot spent on the blob (or the wall in front of it)
                    }
                }
            }
            let Some((t_disc, e, id, p)) = best else { continue };
            // strict comparison: an occluder must be GENUINELY in front of the
            // disc to block (the disc's own wall face ties and does not)
            let occluded = self
                .res
                .static_occluders
                .iter()
                .chain(self.res.dyn_solids.iter().map(|(_, s)| s))
                .any(|s| {
                    let lo = Vec3::new(s[0], 0.0, s[1]);
                    let hi = Vec3::new(s[2], WALL_H, s[3]);
                    ray_aabb(&ray, lo, hi).is_some_and(|(tmin, _)| tmin > t_start + 1e-4 && tmin < t_disc - 1e-4)
                });
            if !occluded {
                self.world.get::<&mut Target>(e).unwrap().hits += 1;
                self.res.score += 1;
                self.res.events.emit(GameEvent::TargetHit(id, p));
            }
        }
    }

    /// Apply one pistol shot to a goo blob: deduct HP, shove the head for a
    /// jiggle tell, and on death either split into two smaller blobs (one tier
    /// down, born perpendicular to the shot with outward separation velocity)
    /// or — for a Small blob, or when the live cap would be exceeded — die
    /// terminally. All spawns/despawns queue on the per-tick buffer and land at
    /// the ONE flush; `mobs_dirty` triggers the post-flush handle rebuild.
    fn damage_goo(&mut self, e: Entity, ray: &PickRay) {
        let (id, tier, centroid) = {
            let g = self.world.get::<&Goo>(e).unwrap();
            (g.id, g.tier, g.centroid())
        };
        let hit_pt = Vec3::new(centroid.x, goo_tier_radius(tier), centroid.y);
        let dead = {
            let mut g = self.world.get::<&mut Goo>(e).unwrap();
            g.hp = g.hp.saturating_sub(GOO_DAMAGE);
            // knockback: shove the spine ends + splash the fluid velocity along
            // the shot → a visible recoil splatter
            let kdir = Vec2::new(ray.dir.x, ray.dir.z).normalize_or_zero();
            g.ends_prev[0] -= kdir * 0.06;
            g.ends_prev[1] -= kdir * 0.03;
            for v in g.vel.iter_mut() {
                *v += kdir * 1.5; // wu/s impulse into the fluid (a recoil splash)
            }
            g.hp == 0
        };
        if !dead {
            self.res.events.emit(GameEvent::MobHit(id, hit_pt));
            return;
        }
        // death — remove the parent at the flush
        self.res.buf.despawn(e);
        self.res.mobs_dirty = true;
        // Small is terminal; an over-cap split also degrades to a plain kill so
        // division can never outrun the renderer's instance pool.
        let live_after_split = self.mobs.len() - 1 + 2;
        if tier >= 2 || live_after_split > GOO_LIVE_CAP {
            self.res.events.emit(GameEvent::MobKilled(id, hit_pt));
            return;
        }
        // split: two children one tier down, separated along the axis
        // perpendicular to the shot ray ("split along the bullet")
        let perp = Vec2::new(-ray.dir.z, ray.dir.x).normalize_or_zero();
        let parent_r = goo_tier_radius(tier);
        let sep = parent_r * 0.6;
        for s in [-1.0f32, 1.0] {
            let cid = MobId(self.res.next_mob_id);
            self.res.next_mob_id += 1;
            let dir = (perp * s).normalize_or_zero();
            let chead = centroid + dir * sep;
            let vel = dir * (parent_r * 0.05); // outward separation, baked into prev
            let timer = 20 + (self.res.rng.next_f32() * 60.0) as u16;
            self.res.buf.spawn((fresh_goo(cid, tier + 1, chead, dir, vel, timer),));
        }
        self.res.events.emit(GameEvent::MobSplit(id, hit_pt));
    }

    /// Blob fusion — the inverse of the shot-split. Two LIVE blobs of the SAME
    /// tier (≥ 1, so the result can grow toward Large) whose bodies overlap fuse
    /// into one a tier larger. Deterministic: scan the MobId-sorted handle list,
    /// take the FIRST overlapping pair, keep the LOWER id (regrown one tier up at
    /// the fusion midpoint), queue the higher id for despawn, and drop it from
    /// the live handle list so a same-tick shot can't double-despawn it. One
    /// fusion per tick; the post-flush `rebuild_mobs` lands it. No-op below two
    /// blobs (so mob-free / lone-blob levels never enter this path).
    fn merge_system(&mut self) {
        if self.mobs.len() < 2 || self.res.mobs_dirty {
            return; // need a pair, and never fight a split/kill already queued
        }
        let mobs = self.mobs.clone(); // MobId-sorted → stable scan order
        let mut found: Option<(Entity, Entity, MobId, u8, Vec2, Vec2)> = None;
        'scan: for a in 0..mobs.len() {
            let ga = *self.world.get::<&Goo>(mobs[a]).unwrap();
            if ga.tier == 0 || ga.merge_grace > 0 || ga.fusing > 0 {
                continue; // Large can't grow; newborns/fusing blobs are immune
            }
            let ca = ga.centroid();
            let touch = goo_tier_radius(ga.tier) * GOO_MERGE_FRAC;
            for b in (a + 1)..mobs.len() {
                let gb = *self.world.get::<&Goo>(mobs[b]).unwrap();
                if gb.tier != ga.tier || gb.merge_grace > 0 || gb.fusing > 0 {
                    continue; // same-tier only, and both past grace / not fusing
                }
                if (ca - gb.centroid()).length() < touch {
                    found = Some((mobs[a], mobs[b], ga.id, ga.tier, (ca + gb.centroid()) * 0.5, ga.heading));
                    break 'scan;
                }
            }
        }
        let Some((ea, eb, id_a, tier, mid, _heading)) = found else {
            return;
        };
        // The survivor (ea) grows one tier LARGER in place — goo_system eases its
        // spine/render size up over ~1.2 s (no pop). The absorbed blob (eb) is NOT
        // despawned now: it enters a FUSING collapse (goo_system oozes its
        // particles into `mid` and deflates it over GOO_FUSE_TICKS, then despawns)
        // — so no metaballs ever vanish in a single frame. Newborn grace on the
        // survivor stops it grabbing a third neighbour mid-fusion.
        {
            let mut g = self.world.get::<&mut Goo>(ea).unwrap();
            g.tier = tier - 1;
            g.hp = goo_tier_hp(tier - 1);
            g.merge_grace = GOO_MERGE_GRACE;
        }
        {
            let mut g = self.world.get::<&mut Goo>(eb).unwrap();
            g.fusing = GOO_FUSE_TICKS;
            g.fuse_pt = mid;
        }
        let pt = Vec3::new(mid.x, goo_tier_radius(tier - 1), mid.y);
        self.res.events.emit(GameEvent::MobMerged(id_a, pt));
    }

    /// 5. Flashlight pose from the lattice-snapped position + facing (the same
    /// pure function the viewer uses).
    fn flashlight_system(&mut self) {
        let yaw = 90.0 * self.res.yaw_q as f32;
        let p = snap_ground_to_lattice(self.player_pos(), yaw);
        let (pos, dir) = flashlight_pose(p, self.player_facing());
        self.res.flash_pose = FlashPose { pos, dir };
    }

    /// 6. Per-light emission at sim time `t`: room master AND per-light state
    /// gate each light (screens ignore the wall switch, matching the renderer:
    /// devices are not room lighting), flicker modulates the lit ones.
    /// `room_lights` = lit fraction of the switchable (non-screen) lights —
    /// the probe-bank lerp scalar (known v1 GI approximation, ARCHITECTURE.md).
    fn light_system(&mut self, t: f32) {
        self.res.light_rgb.clear();
        let mut lit = 0u32;
        let mut switchable = 0u32;
        for &e in &self.lights {
            let l = self.world.get::<&Light>(e).unwrap();
            let screen = l.kind == LightKind::Screen;
            let on = l.on && (screen || self.res.master_lights);
            if !screen {
                switchable += 1;
                lit += on as u32;
            }
            let rgb = if on {
                let (f, tint) = flicker(l.kind.curve_kind(), l.li, t);
                let f = f.max(0.05); // renderer's anim floor
                [l.base_rgb[0] * f * tint[0], l.base_rgb[1] * f * tint[1], l.base_rgb[2] * f * tint[2]]
            } else {
                [0.0; 3]
            };
            self.res.light_rgb.push((l.id, rgb));
        }
        self.res.room_lights = if switchable == 0 { 0.0 } else { lit as f32 / switchable as f32 };
    }

    /// 7. Domain events → audio cues into the injected sink, emission order.
    fn audio_system(&mut self) {
        for ev in self.res.events.drain() {
            // Observation tap (lab only): record the STRUCTURED event before it
            // is flattened to a (lossy) AudioCue. Pure copy into an Option buffer
            // — touches nothing the hash reads.
            if let Some(tap) = self.res.event_tap.as_mut() {
                tap.push(ev);
            }
            let cue = match ev {
                GameEvent::DoorOpened(_, p) => AudioCue { id: CueId("door_open"), pos: Some(p), gain: 1.0 },
                GameEvent::DoorClosed(_, p) => AudioCue { id: CueId("door_close"), pos: Some(p), gain: 1.0 },
                GameEvent::ShotFired(p) => AudioCue { id: CueId("pistol_fire"), pos: Some(p), gain: 1.0 },
                GameEvent::TargetHit(_, p) => AudioCue { id: CueId("target_hit"), pos: Some(p), gain: 1.0 },
                GameEvent::Switch => AudioCue { id: CueId("switch"), pos: None, gain: 0.6 },
                GameEvent::PickedUp(_, _, p) => AudioCue { id: CueId("pickup"), pos: Some(p), gain: 0.8 },
                GameEvent::Consumed(_) => AudioCue { id: CueId("eat"), pos: None, gain: 0.7 },
                GameEvent::MobHit(_, p) => AudioCue { id: CueId("goo_hit"), pos: Some(p), gain: 0.7 },
                GameEvent::MobSplit(_, p) => AudioCue { id: CueId("goo_split"), pos: Some(p), gain: 1.0 },
                GameEvent::MobKilled(_, p) => AudioCue { id: CueId("goo_die"), pos: Some(p), gain: 0.8 },
                GameEvent::MobMerged(_, p) => AudioCue { id: CueId("goo_merge"), pos: Some(p), gain: 0.9 },
                // need-state crossings are HUD/feedback events, no audio cue yet
                GameEvent::NeedCritical(_) | GameEvent::NeedRecovered(_) => continue,
            };
            self.sink.play(cue);
        }
    }

    /// Current swing angle of a door (radians; 0 closed .. open_angle open).
    fn door_angle(&self, e: Entity) -> f32 {
        let door = self.world.get::<&Door>(e).unwrap();
        let body = self.world.get::<&DoorBody>(e).unwrap();
        let n = body.anim_ticks as f32;
        match door.state {
            DoorState::Closed => 0.0,
            DoorState::Open => body.open_angle,
            DoorState::Opening(k) => body.open_angle * (1.0 - k as f32 / n),
            DoorState::Closing(k) => body.open_angle * (k as f32 / n),
        }
    }
}

impl<S: AudioSink> Simulation for HouseGame<S> {
    type Command = Command;
    type Snapshot = GameSnapshot;

    fn tick(&mut self, t: Tick, cmds: &[Command]) {
        let sim_t = t.0 as f32 * TICK_DT;
        self.resolve_commands(cmds);
        self.door_system();
        self.walk_system();
        self.goo_system(); // blobs crawl (a mover) — after walk, before shoot
        self.pickup_system(); // after movement: collect items the walk reached
        self.use_system(); // consume carried items → restore needs
        self.shoot_system();
        self.merge_system(); // blobs that drifted together fuse (skipped if a shot already changed the set)
        self.flashlight_system();
        self.light_system(sim_t);
        self.needs_system(); // decay/drain + pressure effects, late in the tick
        self.audio_system();
        // the ONE fixed structural point per tick
        let mut buf = std::mem::replace(&mut self.res.buf, CommandBuffer::new());
        buf.run_on(&mut self.world);
        self.res.buf = buf;
        // recover spawned/despawned blob handles into the MobId-sorted list
        // (CommandBuffer::spawn returns no Entity) — only when mobs changed.
        if self.res.mobs_dirty {
            self.rebuild_mobs();
            self.res.mobs_dirty = false;
        }
    }

    /// Pure read — never advances RNG or any other state (pinned by test).
    fn snapshot(&self) -> GameSnapshot {
        let yaw = 90.0 * self.res.yaw_q as f32;
        GameSnapshot {
            player_pos: snap_ground_to_lattice(self.player_pos(), yaw),
            facing: self.player_facing(),
            flashlight: self.world.get::<&Flashlight>(self.player).unwrap().on,
            muzzle_flash: self.res.muzzle_ticks > 0,
            doors: self.doors.iter().map(|&e| (self.world.get::<&Door>(e).unwrap().id, self.door_angle(e))).collect(),
            lights: self.res.light_rgb.clone(),
            room_lights: self.res.room_lights,
            yaw_q: self.res.yaw_q,
            score: self.res.score,
            // survival fields read the components when present; survival-off
            // games have none → full needs, empty inventory (HUD-neutral).
            hunger: self.world.get::<&Hunger>(self.player).map(|h| h.0).unwrap_or(1.0),
            battery: self.world.get::<&Battery>(self.player).map(|b| b.0).unwrap_or(1.0),
            inventory: self.world.get::<&Inventory>(self.player).map(|i| i.items.clone()).unwrap_or_default(),
            // goo blobs (MobId-sorted): ends + particle cloud lifted to body
            // height. Pure read of the hashed field — empty on mob-free levels.
            mobs: self
                .mobs
                .iter()
                .map(|&e| {
                    let g = self.world.get::<&Goo>(e).unwrap();
                    // render size follows the (smoothly ramped) spine length, so a
                    // just-merged blob grows into its new tier instead of popping.
                    // Identical to goo_tier_radius(tier) for a settled blob.
                    let r = g.body_len / GOO_BODY_FRAC;
                    let pr = r * GOO_PART_RADIUS_FRAC;
                    let parts = g.parts.map(|p| Vec3::new(p.x, pr, p.y));
                    MobRender { id: g.id, tier: g.tier, parts, radius: r, part_radius: pr }
                })
                .collect(),
        }
    }

    /// FNV-1a over the canonical field order: player (pos, facing, flashlight,
    /// pistol cooldown, walk target), muzzle ticks, yaw_q, master switch,
    /// score, doors (id, state), lights (id, on), target hits, RNG probe.
    fn state_hash(&self) -> u64 {
        let mut h = Fnv::new();
        let p = self.player_pos();
        h.f32(p.x).f32(p.y).f32(p.z);
        let f = self.player_facing();
        h.f32(f.x).f32(f.y);
        h.u64(self.world.get::<&Flashlight>(self.player).unwrap().on as u64);
        h.u64(self.world.get::<&Pistol>(self.player).unwrap().cooldown_ticks as u64);
        match self.world.get::<&WalkTarget>(self.player) {
            Ok(wt) => {
                h.u64(1).f32(wt.ground.x).f32(wt.ground.y).u64(wt.blocked_ticks as u64);
            }
            Err(_) => {
                h.u64(0);
            }
        }
        h.u64(self.res.muzzle_ticks as u64).u64(self.res.yaw_q as u64).u64(self.res.master_lights as u64).u64(self.res.score as u64);
        for &e in &self.doors {
            let d = self.world.get::<&Door>(e).unwrap();
            h.u64(d.id.0 as u64);
            match d.state {
                DoorState::Closed => h.u64(0),
                DoorState::Opening(k) => h.u64(1).u64(k as u64),
                DoorState::Open => h.u64(2),
                DoorState::Closing(k) => h.u64(3).u64(k as u64),
            };
        }
        for &e in &self.lights {
            let l = self.world.get::<&Light>(e).unwrap();
            h.u64(l.id.0 as u64).u64(l.on as u64);
        }
        for &e in &self.targets {
            let t = self.world.get::<&Target>(e).unwrap();
            h.u64(t.id.0 as u64).u64(t.hits as u64);
        }
        // RNG state probe (fields are private; a clone-advance reads it purely)
        h.u64(self.res.rng.clone().next_u32() as u64);
        // Survival fields fold in ONLY when enabled, so a survival-OFF level
        // (game_level / fixture) hashes byte-identically to before this
        // feature: needs, inventory contents, and remaining world items. When
        // survival is None this whole block is skipped → no new bytes.
        if self.res.survival.is_some() {
            h.f32(self.world.get::<&Hunger>(self.player).unwrap().0);
            h.f32(self.world.get::<&Battery>(self.player).unwrap().0);
            let inv = self.world.get::<&Inventory>(self.player).unwrap();
            h.u64(inv.items.len() as u64);
            for k in &inv.items {
                h.u64(item_kind_tag(*k));
            }
            // remaining world items, id-sorted (self.items already is)
            for &e in &self.items {
                let wi = self.world.get::<&WorldItem>(e).unwrap();
                h.u64(wi.id.0 as u64).u64(item_kind_tag(wi.kind));
            }
        }
        // Goo mobs fold in ONLY when present, so a mob-free level (fixture /
        // game_level) hashes byte-identically to before this feature. The
        // seeded child-id counter is included so split determinism is pinned.
        // self.mobs is MobId-sorted (rebuilt from a World query after splits).
        if !self.mobs.is_empty() {
            h.u64(self.res.next_mob_id as u64);
            for &e in &self.mobs {
                let g = self.world.get::<&Goo>(e).unwrap();
                h.u64(g.id.0 as u64).u64(g.tier as u64).u64(g.hp as u64).u64(g.state.tag()).u64(g.timer as u64);
                for k in 0..2 {
                    h.f32(g.ends[k].x).f32(g.ends[k].y).f32(g.ends_prev[k].x).f32(g.ends_prev[k].y);
                }
                for k in 0..GOO_PARTICLES {
                    h.f32(g.parts[k].x).f32(g.parts[k].y).f32(g.vel[k].x).f32(g.vel[k].y);
                }
                h.f32(g.heading.x).f32(g.heading.y).u64(g.gait_phase as u64).u64(g.merge_grace as u64).u64(g.fusing as u64).f32(g.fuse_pt.x).f32(g.fuse_pt.y);
            }
        }
        h.0
    }
}

/// Stable hash tag for an item kind (the enum discriminant is not guaranteed
/// stable across reorders, so we pin it here for the state_hash fold).
fn item_kind_tag(k: ItemKind) -> u64 {
    match k {
        ItemKind::Food => 0,
        ItemKind::Battery => 1,
    }
}

/// FNV-1a, canonical little-endian byte order.
struct Fnv(u64);

impl Fnv {
    fn new() -> Fnv {
        Fnv(0xcbf29ce484222325)
    }

    fn u64(&mut self, v: u64) -> &mut Fnv {
        for b in v.to_le_bytes() {
            self.0 = (self.0 ^ b as u64).wrapping_mul(0x100000001b3);
        }
        self
    }

    fn f32(&mut self, v: f32) -> &mut Fnv {
        self.u64(v.to_bits() as u64)
    }
}

/// Ray vs sphere → the nearest entry parameter `t` (may be negative when the
/// origin is inside). `None` when the ray misses. `ray.dir` is unit.
fn ray_sphere(ray: &PickRay, center: Vec3, radius: f32) -> Option<f32> {
    let oc = ray.origin - center;
    let b = oc.dot(ray.dir);
    let c = oc.dot(oc) - radius * radius;
    let disc = b * b - c;
    if disc < 0.0 {
        return None;
    }
    Some(-b - disc.sqrt())
}

/// Ray vs AABB (slab method) → Some((t_entry, t_exit)) when the ray crosses
/// it (t_exit ≥ max(t_entry, 0)); t_entry may be negative when the origin is
/// inside. Zero direction components handled exactly (no 0/0 NaN).
fn ray_aabb(ray: &PickRay, lo: Vec3, hi: Vec3) -> Option<(f32, f32)> {
    let (mut tmin, mut tmax) = (f32::MIN, f32::MAX);
    for a in 0..3 {
        let (o, d, l, h) = (ray.origin[a], ray.dir[a], lo[a], hi[a]);
        if d.abs() < 1e-9 {
            if o < l || o > h {
                return None;
            }
            continue;
        }
        let (t1, t2) = ((l - o) / d, (h - o) / d);
        let (t1, t2) = if t1 <= t2 { (t1, t2) } else { (t2, t1) };
        tmin = tmin.max(t1);
        tmax = tmax.min(t2);
    }
    (tmax >= tmin.max(0.0)).then_some((tmin, tmax))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spec::fixture;
    use crate::trace::parse_trace;
    use sim_core::{Runner, VecSink};

    /// Test driver: a fixture game + a running tick counter, so scenarios read
    /// as "command, run n, assert" without juggling Tick numbers.
    struct Drv {
        g: HouseGame<VecSink>,
        t: u64,
    }

    impl Drv {
        fn new() -> Drv {
            Drv { g: HouseGame::new(&fixture(), VecSink::default()), t: 0 }
        }

        fn cmd(&mut self, c: Command) {
            self.g.tick(Tick(self.t), &[c]);
            self.t += 1;
        }

        fn cmds(&mut self, cs: &[Command]) {
            self.g.tick(Tick(self.t), cs);
            self.t += 1;
        }

        fn run(&mut self, n: u64) {
            for _ in 0..n {
                self.g.tick(Tick(self.t), &[]);
                self.t += 1;
            }
        }

        fn pos(&self) -> Vec3 {
            self.g.world.get::<&Pos>(self.g.player).unwrap().0
        }

        fn walking(&self) -> bool {
            self.g.world.get::<&WalkTarget>(self.g.player).is_ok()
        }

        fn cue_ids(&self) -> Vec<&'static str> {
            self.g.sink.0.iter().map(|c| c.id.0).collect()
        }
    }

    fn down_ray(x: f32, z: f32) -> PickRay {
        PickRay { origin: Vec3::new(x, 5.0, z), dir: Vec3::new(0.0, -1.0, 0.0) }
    }

    fn click_ground(x: f32, z: f32) -> Command {
        Command::Click { ray: down_ray(x, z), ground: Some(Vec2::new(x, z)) }
    }

    /// Straight down onto door_ab's slab centre — resolves as UseDoor even
    /// though a ground point is supplied (door interact beats walk).
    fn click_door_ab() -> Command {
        Command::Click { ray: down_ray(-1.625, 0.0), ground: Some(Vec2::new(-1.625, 0.0)) }
    }

    fn shoot(origin: Vec3, dir: Vec3) -> Command {
        Command::Shoot { ray: PickRay { origin, dir: dir.normalize() } }
    }

    const OPEN: f32 = 1.9198622; // 110 deg in radians (fixture open_angle)

    #[test]
    fn walk_reaches_click_and_blocked_points_are_noops() {
        let mut d = Drv::new();
        // clicking inside the crate is a no-op (no clamp-to-edge in v1)
        let p0 = d.pos();
        d.cmd(click_ground(-3.5, 1.4));
        assert!(!d.walking());
        d.run(10);
        assert_eq!(d.pos(), p0, "blocked click must not move the player");
        // a clear point in room A is reached and the target clears
        d.cmd(click_ground(-2.5, -1.5));
        d.run(150);
        assert!((d.pos() - Vec3::new(-2.5, 0.0, -1.5)).length() < 0.06, "{:?}", d.pos());
        assert!(!d.walking());
        // snapshot's player_pos is the lattice-snapped continuous pos
        let snap = d.g.snapshot();
        assert!((snap.player_pos - d.pos()).length() < 3.0 / ISO_R);
    }

    #[test]
    fn slide_along_wall() {
        let mut d = Drv::new();
        // hold screen-right: world (+x, -z) into wall A|B below the door gap;
        // x blocks at the wall face, z keeps sliding until the perimeter
        for _ in 0..150 {
            d.cmd(Command::Move { dir: IVec2::new(1, 0) });
        }
        let p = d.pos();
        assert!(p.x < -1.75 && p.x > -1.83, "x pinned at the wall: {p:?}");
        assert!(p.z < -2.4 && p.z >= -2.5, "z slid to the perimeter: {p:?}");
        assert!(!d.g.walk_blocked(p.x, p.z), "never ends inside a solid");
    }

    #[test]
    fn closed_door_blocks_then_open_admits_after_anim_ticks() {
        let mut d = Drv::new();
        d.cmd(click_ground(0.0, 0.0)); // room B centre, straight through door_ab
        d.run(200);
        let p = d.pos();
        assert!(p.x < -1.74 && p.x > -1.9, "stopped at the closed leaf: {p:?}");
        assert!(!d.walking(), "blocked-two-ticks must clear the target");
        // open the door, wait out the sweep, walk again -> admitted
        d.cmd(click_door_ab());
        d.run(31);
        assert_eq!(d.g.snapshot().doors[0], (DoorId(0), OPEN));
        d.cmd(click_ground(0.0, 0.0));
        d.run(150);
        assert!((d.pos() - Vec3::ZERO).length() < 0.06, "{:?}", d.pos());
    }

    #[test]
    fn door_state_machine_tick_exact() {
        let mut d = Drv::new();
        d.cmd(click_door_ab()); // tick T: Closed -> Opening(30), angle still 0
        assert_eq!(d.g.snapshot().doors[0].1, 0.0);
        d.run(15); // T+15: half-swept
        assert!((d.g.snapshot().doors[0].1 - OPEN * 0.5).abs() < 1e-5);
        d.run(14); // T+29: one tick short of open — no cue yet
        assert!(d.g.snapshot().doors[0].1 < OPEN);
        assert_eq!(d.cue_ids(), Vec::<&str>::new());
        d.run(1); // T+30: Open, DoorOpened fires EXACTLY here
        assert_eq!(d.g.snapshot().doors[0].1, OPEN);
        assert_eq!(d.cue_ids(), vec!["door_open"]);
        // close: same tick-exact sweep down
        d.cmd(click_door_ab());
        assert_eq!(d.g.snapshot().doors[0].1, OPEN); // Closing(30) starts full
        d.run(29);
        assert!(d.g.snapshot().doors[0].1 > 0.0);
        assert_eq!(d.cue_ids(), vec!["door_open"]);
        d.run(1);
        assert_eq!(d.g.snapshot().doors[0].1, 0.0);
        assert_eq!(d.cue_ids(), vec!["door_open", "door_close"]);
        // the other door never moved
        assert_eq!(d.g.snapshot().doors[1], (DoorId(1), 0.0));
    }

    #[test]
    fn door_cant_close_on_player() {
        let mut d = Drv::new();
        d.cmd(click_door_ab());
        d.run(31); // open
        // stand in the doorway: ground point is the doorway centre, but the
        // pick ray must not cross the door's interact volume (door beats walk)
        d.cmd(Command::Click { ray: down_ray(-3.0, 0.0), ground: Some(Vec2::new(-1.625, 0.0)) });
        d.run(120);
        assert!((d.pos() - Vec3::new(-1.625, 0.0, 0.0)).length() < 0.06, "{:?}", d.pos());
        d.cmd(click_door_ab()); // try to close on the player -> refused
        d.run(40);
        assert_eq!(d.g.snapshot().doors[0].1, OPEN, "door must refuse to close");
        assert_eq!(d.cue_ids(), vec!["door_open"]); // no door_close cue
        // step clear, then it closes normally
        d.cmd(click_ground(-3.0, 0.0));
        d.run(120);
        d.cmd(click_door_ab());
        d.run(31);
        assert_eq!(d.g.snapshot().doors[0].1, 0.0);
        assert_eq!(d.cue_ids(), vec!["door_open", "door_close"]);
    }

    #[test]
    fn shot_hits_scores_and_arms_muzzle_flash() {
        let mut d = Drv::new();
        // straight at target 0 on room A's north wall (disc ON the wall face:
        // the perimeter slab ties at the disc plane and must not block)
        d.cmd(shoot(Vec3::new(-3.5, 1.25, 0.0), Vec3::new(0.0, 0.0, -1.0)));
        let snap = d.g.snapshot();
        assert_eq!(snap.score, 1);
        assert!(snap.muzzle_flash, "armed for 2 ticks");
        assert_eq!(d.cue_ids(), vec!["pistol_fire", "target_hit"]);
        d.run(1);
        assert!(d.g.snapshot().muzzle_flash);
        d.run(1);
        assert!(!d.g.snapshot().muzzle_flash, "exactly 2 ticks");
        assert_eq!(d.g.world.get::<&Target>(d.g.targets[0]).unwrap().hits, 1);
    }

    #[test]
    fn shot_misses_off_disc() {
        let mut d = Drv::new();
        d.cmd(shoot(Vec3::new(-4.5, 1.25, 0.0), Vec3::new(0.0, 0.0, -1.0)));
        assert_eq!(d.g.snapshot().score, 0);
        assert_eq!(d.cue_ids(), vec!["pistol_fire"]); // fired, no hit
    }

    #[test]
    fn shot_blocked_by_closed_door_admitted_when_open() {
        // one ray, two worlds: through the A|B doorway at target 1 in room B
        let o = Vec3::new(-2.0, 1.25, 0.5);
        let dir = Vec3::new(2.0, 0.0, -3.0);
        let mut closed = Drv::new();
        closed.cmd(shoot(o, dir));
        assert_eq!(closed.g.snapshot().score, 0, "closed leaf occludes");
        assert_eq!(closed.cue_ids(), vec!["pistol_fire"]);
        let mut open = Drv::new();
        open.cmd(click_door_ab());
        open.run(31);
        open.cmd(shoot(o, dir));
        assert_eq!(open.g.snapshot().score, 1, "open doorway admits the shot");
        assert_eq!(open.g.world.get::<&Target>(open.g.targets[1]).unwrap().hits, 1);
    }

    #[test]
    fn cooldown_swallows_spam() {
        let mut d = Drv::new();
        let at_t0 = || shoot(Vec3::new(-3.5, 1.25, 0.0), Vec3::new(0.0, 0.0, -1.0));
        // two shots in ONE tick: the second is swallowed
        d.cmds(&[at_t0(), at_t0()]);
        assert_eq!(d.g.snapshot().score, 1);
        // spamming every tick inside the cooldown adds nothing
        for _ in 0..PISTOL_COOLDOWN_TICKS - 1 {
            d.cmd(at_t0());
        }
        assert_eq!(d.g.snapshot().score, 1);
        // first tick past the cooldown fires again
        d.cmd(at_t0());
        assert_eq!(d.g.snapshot().score, 2);
        assert_eq!(d.cue_ids(), vec!["pistol_fire", "target_hit", "pistol_fire", "target_hit"]);
    }

    #[test]
    fn rotate_changes_walk_frame() {
        // yaw_q is SIM state: the same Move input walks a different world
        // direction after RotateCamera
        let mut d = Drv::new();
        let p0 = d.pos();
        d.cmd(Command::Move { dir: IVec2::new(1, 0) });
        let p1 = d.pos();
        assert!(p1.x > p0.x && p1.z < p0.z, "yaw 0: screen-right = +x -z");
        d.cmd(Command::RotateCamera { dq: 1 });
        assert_eq!(d.g.snapshot().yaw_q, 1);
        d.cmd(Command::Move { dir: IVec2::new(1, 0) });
        let p2 = d.pos();
        assert!(p2.x < p1.x && p2.z < p1.z, "yaw 1: screen-right = -x -z");
        d.cmd(Command::RotateCamera { dq: -2 });
        assert_eq!(d.g.snapshot().yaw_q, 3, "rem_euclid wrap");
    }

    #[test]
    fn flashlight_pose_tracks_facing() {
        let mut d = Drv::new();
        d.cmd(Command::ToggleFlashlight);
        assert!(d.g.snapshot().flashlight);
        assert_eq!(d.cue_ids(), vec!["switch"]);
        d.cmd(Command::Move { dir: IVec2::new(1, 0) });
        let snap = d.g.snapshot();
        let f = snap.facing;
        assert!((f - Vec2::new(1.0, -1.0).normalize()).length() < 1e-4);
        // the resource holds exactly the shared pure-fn pose at the snapped pos
        let (want_pos, want_dir) = crate::flashlight_pose(snap.player_pos, f);
        assert_eq!(d.g.res.flash_pose, FlashPose { pos: want_pos, dir: want_dir });
        // walking against a wall still turns the beam (facing = attempt);
        // screen up-left is world -x exactly (the iso 2:1 diagonal)
        for _ in 0..200 {
            d.cmd(Command::Move { dir: IVec2::new(-1, 1) });
        }
        let f2 = d.g.snapshot().facing;
        assert!((f2 - Vec2::new(-1.0, 0.0)).length() < 1e-4, "{f2:?}");
    }

    #[test]
    fn toggle_lights_zeroes_emission() {
        let mut d = Drv::new();
        d.run(1);
        let on = d.g.snapshot();
        assert_eq!(on.room_lights, 1.0);
        assert_eq!(on.lights.len(), 4);
        assert!(on.lights.iter().all(|(_, rgb)| rgb[0] > 0.0));
        d.cmd(Command::ToggleRoomLights);
        let off = d.g.snapshot();
        assert_eq!(off.room_lights, 0.0);
        for (id, rgb) in &off.lights {
            if *id == LightId(2) {
                assert!(rgb[0] > 0.0, "the screen ignores the wall switch");
            } else {
                assert_eq!(*rgb, [0.0; 3], "light {id:?} must go dark");
            }
        }
        d.cmd(Command::ToggleRoomLights);
        assert_eq!(d.g.snapshot().room_lights, 1.0);
        assert_eq!(d.cue_ids(), vec!["switch", "switch"]);
    }

    #[test]
    fn audio_cues_exact() {
        let mut d = Drv::new();
        d.cmd(Command::ToggleFlashlight);
        d.cmd(Command::ToggleRoomLights);
        d.cmd(click_door_ab());
        d.run(30); // door_open lands on the last of these
        d.cmd(shoot(Vec3::new(-3.5, 1.25, 0.0), Vec3::new(0.0, 0.0, -1.0)));
        assert_eq!(d.cue_ids(), vec!["switch", "switch", "door_open", "pistol_fire", "target_hit"]);
        let cues = &d.g.sink.0;
        assert_eq!(cues[0].pos, None);
        assert_eq!(cues[0].gain, 0.6);
        assert_eq!(cues[2].pos, Some(Vec3::new(-1.625, 0.0, -0.75))); // the hinge
        assert_eq!(cues[2].gain, 1.0);
        assert!(cues[3].pos.is_some() && cues[4].pos.is_some());
        // the hit lands on the disc
        assert!((cues[4].pos.unwrap() - Vec3::new(-3.5, 1.25, -2.5)).length() < 0.31);
    }

    #[test]
    fn snapshot_twice_is_side_effect_free() {
        let mut d = Drv::new();
        d.cmd(Command::ToggleFlashlight);
        d.cmd(click_ground(-2.5, -1.5));
        d.run(40);
        let h0 = d.g.state_hash();
        let s0 = d.g.snapshot();
        let s1 = d.g.snapshot();
        assert_eq!(s0, s1, "snapshot must be a pure read");
        assert_eq!(d.g.state_hash(), h0, "snapshot/state_hash must not advance state");
        // and the next tick is unaffected by how many snapshots were taken
        d.run(1);
        let ha = d.g.state_hash();
        let mut e = Drv::new();
        e.cmd(Command::ToggleFlashlight);
        e.cmd(click_ground(-2.5, -1.5));
        e.run(41);
        assert_eq!(e.g.state_hash(), ha);
    }

    fn scripted_trace() -> Vec<(Tick, Command)> {
        vec![
            (Tick(0), Command::ToggleFlashlight),
            (Tick(2), click_door_ab()),
            (Tick(40), click_ground(0.0, 0.0)),
            (Tick(120), shoot(Vec3::new(0.0, 1.25, 0.0), Vec3::new(0.0, 0.0, -1.0))),
            (Tick(130), Command::ToggleRoomLights),
            (Tick(150), Command::RotateCamera { dq: 1 }),
            (Tick(160), Command::Move { dir: IVec2::new(0, 1) }),
            (Tick(161), Command::Move { dir: IVec2::new(0, 1) }),
        ]
    }

    #[test]
    fn determinism_two_runs_identical() {
        let mut a = Runner::new(HouseGame::new(&fixture(), VecSink::default()));
        a.feed(scripted_trace());
        let ha = a.run_ticks(200);
        let mut b = Runner::new(HouseGame::new(&fixture(), VecSink::default()));
        b.feed(scripted_trace());
        let hb = b.run_ticks(200);
        assert_eq!(ha, hb, "same trace, same world");
        assert_eq!(a.sim.snapshot(), b.sim.snapshot());
        assert_eq!(a.sim.sink.0, b.sim.sink.0, "cue streams must match exactly");
        // per-tick draining: batch boundaries cannot matter
        let mut c = Runner::new(HouseGame::new(&fixture(), VecSink::default()));
        c.feed(scripted_trace());
        c.run_ticks(67);
        c.run_ticks(133);
        assert_eq!(c.sim.state_hash(), ha);
        // the scripted run did real work (not vacuously equal empties)
        assert_eq!(a.sim.snapshot().score, 1);
        assert_eq!(a.sim.snapshot().yaw_q, 1);
    }

    /// The checked-in trace + pinned hash: any change to system order, math,
    /// or command semantics shows up here. Machine-local artifact per
    /// ARCHITECTURE.md (f32 + libm) — regenerate the pin via
    /// `cargo run -p house-game --bin headless -- traces/replay_golden.txt 240`
    /// ONLY when the behavior change is intended and reviewed.
    #[test]
    fn replay_golden() {
        let trace = parse_trace(include_str!("../traces/replay_golden.txt")).unwrap();
        let mut r = Runner::new(HouseGame::new(&fixture(), VecSink::default()));
        r.feed(trace);
        let h = r.run_ticks(240);
        let snap = r.sim.snapshot();
        // semantic checkpoints first, so a drift diagnoses itself
        assert_eq!(snap.score, 1, "the doorway shot must land");
        assert_eq!(snap.yaw_q, 1);
        assert_eq!(snap.doors[0].1, OPEN);
        assert!(snap.flashlight);
        assert_eq!(snap.room_lights, 1.0);
        assert_eq!(h, REPLAY_GOLDEN_HASH, "got {h:#018x}");
    }

    const REPLAY_GOLDEN_HASH: u64 = 0x6efef65b2724fcda;

    // ---- the real game level (spec::game_level) ------------------------------

    /// Driver over the actual game level (the SCENE=game content), so the
    /// content trace is exercised headless before the renderer ever sees it.
    struct GameDrv {
        g: HouseGame<VecSink>,
        t: u64,
    }
    impl GameDrv {
        fn new() -> GameDrv {
            GameDrv { g: HouseGame::new(&crate::spec::game_level(), VecSink::default()), t: 0 }
        }
        fn cmd(&mut self, c: Command) {
            self.g.tick(Tick(self.t), &[c]);
            self.t += 1;
        }
        fn run(&mut self, n: u64) {
            for _ in 0..n {
                self.g.tick(Tick(self.t), &[]);
                self.t += 1;
            }
        }
        fn pos(&self) -> Vec3 {
            self.g.world.get::<&Pos>(self.g.player).unwrap().0
        }
    }

    #[test]
    fn game_level_geometry_is_consistent() {
        let spec = crate::spec::game_level();
        // floor bounds = the full footprint, every dim a multiple of 0.0625
        assert_eq!(spec.floor_bounds(), [0.0, 0.0, 12.0, 8.0]);
        let on_lattice = |v: f32| (v / 0.0625).fract().abs() < 1e-4;
        for s in spec.static_solids.iter().chain(spec.doors.iter().map(|d| &d.closed_solid)) {
            for &c in s {
                assert!(on_lattice(c), "off-lattice coord {c} in {s:?}");
            }
        }
        // every door's closed_solid spans exactly one cell (1.0 wu) along its run
        for d in &spec.doors {
            let s = d.closed_solid;
            let run = (s[2] - s[0]).max(s[3] - s[1]);
            assert!((run - 1.0).abs() < 1e-4, "door {:?} run {run}", d.id);
        }
    }

    #[test]
    fn game_level_walk_open_door_through_and_shoot_twice() {
        let mut d = GameDrv::new();
        // door_ce (DoorId(2)) is the SE room E -> room C door at x=8, z[6,7];
        // shut, it blocks the way west at z=6.5
        d.cmd(click_ground(6.0, 6.5));
        d.run(120);
        assert!(d.pos().x > 8.0, "closed door_ce blocks the way west: {:?}", d.pos());
        // open door_ce (straight down onto its slab centre)
        d.cmd(Command::Click { ray: down_ray(8.0, 6.5), ground: Some(Vec2::new(8.0, 6.5)) });
        d.run(26); // anim_ticks = 24 (+ the tick the click lands on)
        assert_eq!(d.g.snapshot().doors[2].0, DoorId(2));
        assert!(d.g.snapshot().doors[2].1 > 0.0, "door_ce must be opening/open");
        // now walk through into room C, under target 4 (C south wall)
        d.cmd(click_ground(6.0, 6.0));
        d.run(180);
        assert!(d.pos().x < 7.0 && d.pos().z > 4.0, "reached room C: {:?}", d.pos());
        // shoot target 4 (C south wall, faces -z) twice, spaced past the cooldown
        d.cmd(shoot(Vec3::new(6.0, 1.25, 6.0), Vec3::new(0.0, 0.0, 1.0)));
        assert_eq!(d.g.snapshot().score, 1);
        d.run(20);
        d.cmd(shoot(Vec3::new(6.0, 1.25, 6.0), Vec3::new(0.0, 0.0, 1.0)));
        assert_eq!(d.g.snapshot().score, 2, "two spaced shots score twice");
        assert_eq!(d.g.world.get::<&Target>(d.g.targets[4]).unwrap().hits, 2);
    }

    /// The SCENE=game CMDS replay golden: the SAME checked-in trace the viewer
    /// plays as its startup prefix (traces/replay_game.txt), pinned end state.
    /// Machine-local artifact (f32 + libm) — regenerate via
    /// `cargo run -p house-game --bin headless -- traces/replay_game.txt 420 game`
    /// ONLY when the content/behavior change is intended and reviewed.
    #[test]
    fn replay_game_golden() {
        let trace = parse_trace(include_str!("../traces/replay_game.txt")).unwrap();
        let mut r = Runner::new(HouseGame::new(&crate::spec::game_level(), VecSink::default()));
        r.feed(trace);
        let h = r.run_ticks(420);
        let snap = r.sim.snapshot();
        // semantic checkpoints first, so a drift diagnoses itself
        assert_eq!(snap.score, 2, "both spaced shots must land on target 4");
        assert_eq!(snap.doors[2].0, DoorId(2));
        assert_eq!(snap.doors[2].1, GAME_OPEN, "door_ce fully open");
        assert!(snap.flashlight);
        assert_eq!(snap.room_lights, 0.0, "room lights toggled off");
        // the player walked west through door_ce into room C (x < the x=8 divider, z in C)
        assert!(snap.player_pos.x < 7.0 && snap.player_pos.z > 4.0, "{:?}", snap.player_pos);
        assert_eq!(h, REPLAY_GAME_HASH, "got {h:#018x}");
    }

    const GAME_OPEN: f32 = 1.7453293; // 100 deg in radians (game_level open_angle)
    const REPLAY_GAME_HASH: u64 = 0xf3783d2d43fe4009;

    // ---- survival systems (spec::survival_level, opt-in) ---------------------

    use crate::spec::{game_level, survival_level, ItemKind, ItemSpec, LevelSpec, SurvivalParams};

    /// Driver over a survival-enabled level. Defaults to `survival_level()` but
    /// `with_spec` lets a test build a minimal one-item world for a tight assert.
    struct SurvDrv {
        g: HouseGame<VecSink>,
        t: u64,
    }
    impl SurvDrv {
        fn new() -> SurvDrv {
            SurvDrv { g: HouseGame::new(&survival_level(), VecSink::default()), t: 0 }
        }
        fn with_spec(spec: LevelSpec) -> SurvDrv {
            SurvDrv { g: HouseGame::new(&spec, VecSink::default()), t: 0 }
        }
        fn cmd(&mut self, c: Command) {
            self.g.tick(Tick(self.t), &[c]);
            self.t += 1;
        }
        fn run(&mut self, n: u64) {
            for _ in 0..n {
                self.g.tick(Tick(self.t), &[]);
                self.t += 1;
            }
        }
        fn hunger(&self) -> f32 {
            self.g.world.get::<&Hunger>(self.g.player).unwrap().0
        }
        fn battery(&self) -> f32 {
            self.g.world.get::<&Battery>(self.g.player).unwrap().0
        }
        fn inv(&self) -> Vec<ItemKind> {
            self.g.world.get::<&Inventory>(self.g.player).unwrap().items.clone()
        }
        fn flashlight(&self) -> bool {
            self.g.world.get::<&Flashlight>(self.g.player).unwrap().on
        }
        fn cue_ids(&self) -> Vec<&'static str> {
            self.g.sink.0.iter().map(|c| c.id.0).collect()
        }
        fn set_hunger(&mut self, v: f32) {
            self.g.world.get::<&mut Hunger>(self.g.player).unwrap().0 = v;
        }
        fn set_battery(&mut self, v: f32) {
            self.g.world.get::<&mut Battery>(self.g.player).unwrap().0 = v;
        }
    }

    /// A 1-room survival level with a single food item at `food_pos` (player
    /// spawns at the room's south, like game_level). Tight worlds for asserts.
    fn one_item_level(kind: ItemKind, item_pos: Vec3, sp: SurvivalParams) -> LevelSpec {
        LevelSpec { items: vec![ItemSpec { id: ItemId(0), kind, pos: item_pos }], survival: Some(sp), ..game_level() }
    }

    #[test]
    fn pickup_on_proximity() {
        // food sitting right where the player will arrive; walk onto it
        let item = Vec3::new(9.5, 0.0, 5.0); // room E, north of spawn (9.5, 6.5)
        let mut d = SurvDrv::with_spec(one_item_level(ItemKind::Food, item, SurvivalParams::default()));
        assert_eq!(d.inv(), vec![], "starts empty");
        assert_eq!(d.g.items.len(), 1, "one world item spawned");
        d.cmd(click_ground(9.5, 5.0));
        d.run(120);
        assert_eq!(d.inv(), vec![ItemKind::Food], "food entered the inventory");
        assert_eq!(d.g.items.len(), 0, "world item despawned");
        // PickedUp emitted → "pickup" cue
        assert!(d.cue_ids().contains(&"pickup"), "{:?}", d.cue_ids());
    }

    #[test]
    fn use_restores_need() {
        let item = Vec3::new(9.5, 0.0, 5.0);
        let mut d = SurvDrv::with_spec(one_item_level(ItemKind::Food, item, SurvivalParams::default()));
        // Use with an empty inventory is a no-op
        d.cmd(Command::Use { kind: ItemKind::Food });
        assert!(!d.cue_ids().contains(&"eat"), "empty Use is a no-op");
        // grab the food, drop hunger, then consume to restore (clamped <= 1)
        d.cmd(click_ground(9.5, 5.0));
        d.run(120);
        assert_eq!(d.inv(), vec![ItemKind::Food]);
        d.set_hunger(0.3);
        d.cmd(Command::Use { kind: ItemKind::Food }); // use_system: +0.5 → 0.8, then needs_system decays one tick
        let expect = (0.8 - SurvivalParams::default().hunger_decay).max(0.0);
        assert!((d.hunger() - expect).abs() < 1e-5, "hunger restored (minus one tick decay): {}", d.hunger());
        assert_eq!(d.inv(), vec![], "the food was consumed");
        assert!(d.cue_ids().contains(&"eat"));
        // restore clamps at 1.0
        d.set_hunger(0.9);
        // give a fresh food directly into the inventory for the clamp check
        d.g.world.get::<&mut Inventory>(d.g.player).unwrap().items.push(ItemKind::Food);
        d.cmd(Command::Use { kind: ItemKind::Food }); // use_system: 0.9 + 0.5 clamps to 1.0, then one tick decay
        let clamped = (1.0 - SurvivalParams::default().hunger_decay).max(0.0);
        assert!((d.hunger() - clamped).abs() < 1e-5 && d.hunger() <= 1.0, "clamped to full (minus one tick): {}", d.hunger());
    }

    #[test]
    fn battery_drains_only_with_flashlight() {
        let mut d = SurvDrv::new();
        let b0 = d.battery();
        d.run(60);
        assert_eq!(d.battery(), b0, "battery constant while torch off");
        d.cmd(Command::ToggleFlashlight);
        assert!(d.flashlight());
        let b1 = d.battery();
        d.run(60);
        assert!(d.battery() < b1, "battery drains while torch on: {} < {}", d.battery(), b1);
        // and hunger always decays regardless
        assert!(d.hunger() < 1.0, "hunger always decays");
    }

    #[test]
    fn dead_battery_forces_torch_off() {
        let mut d = SurvDrv::new();
        d.cmd(Command::ToggleFlashlight);
        assert!(d.flashlight());
        d.set_battery(0.0001); // about to die
        d.run(2); // needs_system drains below 0 → clamps 0 → forces torch off
        assert_eq!(d.battery(), 0.0);
        assert!(!d.flashlight(), "dead battery forces the torch off");
        // toggle won't turn it back on with a dead battery (no Switch cue)
        let cues_before = d.cue_ids().len();
        d.cmd(Command::ToggleFlashlight);
        assert!(!d.flashlight(), "can't relight a dead torch");
        assert_eq!(d.cue_ids().len(), cues_before, "no Switch cue for the swallowed toggle");
    }

    #[test]
    fn hunger_zero_slows() {
        // two identical worlds, same Move input; one starved, one fed
        let mk = || SurvDrv::with_spec(LevelSpec { items: vec![], survival: Some(SurvivalParams::default()), ..game_level() });
        let mut fed = mk();
        let mut starved = mk();
        starved.set_hunger(0.0);
        // hold screen-up for 30 ticks (away from spawn, into open room E)
        for _ in 0..30 {
            fed.cmd(Command::Move { dir: IVec2::new(0, 1) });
            starved.cmd(Command::Move { dir: IVec2::new(0, 1) });
        }
        let fed_pos = fed.g.world.get::<&Pos>(fed.g.player).unwrap().0;
        let starved_pos = starved.g.world.get::<&Pos>(starved.g.player).unwrap().0;
        let fed_d = (fed_pos - Vec3::new(9.5, 0.0, 6.5)).length();
        let starved_d = (starved_pos - Vec3::new(9.5, 0.0, 6.5)).length();
        assert!(starved_d < fed_d, "starving covers less ground: {starved_d} < {fed_d}");
        // hunger stays 0 (already empty); fed still has hunger
        assert_eq!(starved.hunger(), 0.0);
    }

    #[test]
    fn need_critical_edge_triggered() {
        let mut d = SurvDrv::new();
        d.g.res.event_tap = Some(Vec::new());
        // sit just above critical, then cross below over two ticks
        let crit = SurvivalParams::default().critical;
        d.set_hunger(crit + SurvivalParams::default().hunger_decay * 0.5);
        d.run(1); // crosses below critical → ONE NeedCritical
        d.run(10); // stays below → must NOT re-fire
        let tap = d.g.res.event_tap.as_ref().unwrap();
        let crits = tap.iter().filter(|e| matches!(e, GameEvent::NeedCritical(NeedKind::Hunger))).count();
        assert_eq!(crits, 1, "NeedCritical fires once on crossing, not every tick");
        // recover above critical → NeedRecovered, then critical again re-arms
        d.set_hunger(crit + 0.3);
        d.run(1);
        let recs = d.g.res.event_tap.as_ref().unwrap().iter().filter(|e| matches!(e, GameEvent::NeedRecovered(NeedKind::Hunger))).count();
        assert_eq!(recs, 1, "NeedRecovered fires on the climb back");
    }

    #[test]
    fn survival_determinism() {
        // same survival scenario twice → identical timeline + hash
        let trace = vec![
            (Tick(0), Command::ToggleFlashlight),
            (Tick(10), click_ground(9.5, 5.0)),
            (Tick(120), Command::Use { kind: ItemKind::Battery }),
        ];
        let run = || {
            let mut r = Runner::new(HouseGame::new(&survival_level(), VecSink::default()));
            r.feed(trace.clone());
            let h = r.run_ticks(200);
            (h, r.sim.sink.0.clone(), r.sim.snapshot())
        };
        let (ha, cues_a, snap_a) = run();
        let (hb, cues_b, snap_b) = run();
        assert_eq!(ha, hb, "same survival trace, same hash");
        assert_eq!(cues_a, cues_b, "cue streams identical");
        assert_eq!(snap_a, snap_b, "snapshots identical");
    }

    // ---- goo mobs (spec::goo_level) ------------------------------------------

    use crate::spec::{goo_level, MobId};

    struct GooDrv {
        g: HouseGame<VecSink>,
        t: u64,
    }
    impl GooDrv {
        fn new() -> GooDrv {
            GooDrv { g: HouseGame::new(&goo_level(), VecSink::default()), t: 0 }
        }
        fn run(&mut self, n: u64) {
            for _ in 0..n {
                self.g.tick(Tick(self.t), &[]);
                self.t += 1;
            }
        }
        fn cmd(&mut self, c: Command) {
            self.g.tick(Tick(self.t), &[c]);
            self.t += 1;
        }
        fn mob_count(&self) -> usize {
            self.g.mobs.len()
        }
        fn world_goo_count(&self) -> usize {
            self.g.world.query::<&Goo>().iter().count()
        }
        /// Centroid of the blob with the given MobId, if alive.
        fn centroid_of(&self, id: MobId) -> Option<Vec2> {
            self.g.mobs.iter().find_map(|&e| {
                let g = self.g.world.get::<&Goo>(e).unwrap();
                (g.id == id).then(|| g.centroid())
            })
        }
        /// Shoot from the player's real muzzle toward a world-XZ point at blob
        /// height (so `t_start` is zero and the shot reaches a line-of-sight
        /// blob exactly as a real click would).
        fn shoot_at(&mut self, target: Vec2) {
            let p = self.g.player_pos();
            let facing = self.g.player_facing();
            let (muzzle, _) = flashlight_pose(p, facing);
            let tgt = Vec3::new(target.x, GOO_BASE_RADIUS, target.y);
            let dir = (tgt - muzzle).normalize();
            self.cmd(Command::Shoot { ray: PickRay { origin: muzzle, dir } });
        }
    }

    #[test]
    fn goo_spawns_and_crawls() {
        let mut d = GooDrv::new();
        // goo_level authors four blobs; the mob-free levels stay empty
        assert_eq!(d.mob_count(), 4, "four authored blobs");
        assert_eq!(d.world_goo_count(), 4);
        let c0 = d.centroid_of(MobId(0)).unwrap();
        d.run(120);
        let c1 = d.centroid_of(MobId(0)).unwrap();
        assert!((c1 - c0).length() > 0.05, "the blob crawled: {c0:?} -> {c1:?}");
        // the snapshot exposes a render pose per blob: the lifted particle cloud
        let snap = d.g.snapshot();
        assert_eq!(snap.mobs.len(), 4);
        assert!(snap.mobs.iter().all(|m| m.radius > 0.0 && m.part_radius > 0.0));
        assert!(snap.mobs.iter().all(|m| m.parts.iter().all(|p| p.y > 0.0)));
    }

    #[test]
    fn goo_is_one_cohesive_blob_not_a_dumbbell() {
        // the capsule field pools the fluid into ONE cohesive blob: it stays
        // bounded around its centroid (no stringing/fission) and — unlike the
        // old dumbbell — its MIDDLE third along the body axis is well populated
        // (no thin neck).
        let mut d = GooDrv::new();
        d.run(150); // let the fluid settle
        let g = *d.g.world.get::<&Goo>(d.g.mobs[0]).unwrap();
        let r = goo_tier_radius(g.tier);
        let cen = g.centroid();
        // cohesive: every particle stays within a bounded radius of the centroid
        let max_d = g.parts.iter().map(|p| (*p - cen).length()).fold(0.0, f32::max);
        assert!(max_d < r * 2.0, "the blob must stay one cohesive mass (max dist {max_d:.2} vs {:.2})", r * 2.0);
        // not a dumbbell: bin along the body axis normalized by the cloud's OWN
        // extent (the spine is now shorter than the blob, so spine-relative bins
        // would mis-scale). A round/even blob fills the middle third; a dumbbell
        // starves it. The central band of a roundish mass is in fact the fullest.
        let axis = (g.ends[1] - g.ends[0]).normalize_or_zero();
        let extent = g.parts.iter().map(|p| (*p - cen).dot(axis).abs()).fold(0.0, f32::max).max(1e-3);
        let mut bins = [0u32; 3]; // [front, middle, back]
        for &p in &g.parts {
            let s = (p - cen).dot(axis) / extent; // ∈ [-1, 1]
            let b = if s < -0.33 { 0 } else if s > 0.33 { 2 } else { 1 };
            bins[b] += 1;
        }
        let lobe_avg = (bins[0] + bins[2]) as f32 / 2.0;
        assert!(bins[1] as f32 >= 0.6 * lobe_avg, "the middle must NOT be a thin neck (a single blob, not a dumbbell): front={} middle={} back={}", bins[0], bins[1], bins[2]);
    }

    #[test]
    fn goo_trap_pulls_a_blob() {
        // goo_level authors a trap at (9.9, 4.1) in room E; the room-E Large
        // (MobId 3, spawns at 8.9,5.2) is within the 3.0 wu capture radius and
        // should get dragged toward the trap over time.
        let mut d = GooDrv::new();
        let trap = Vec2::new(9.2, 4.3);
        let d0 = (d.centroid_of(MobId(3)).unwrap() - trap).length();
        d.run(180);
        let d1 = (d.centroid_of(MobId(3)).unwrap() - trap).length();
        assert!(d1 < d0 - 0.2, "the trap pulled the blob in: {d0:.2} -> {d1:.2}");
    }

    #[test]
    fn goo_splits_into_two_when_killed() {
        let mut d = GooDrv::new();
        // MobId(3) is a Large (tier 0, hp 12) in room E, in clear sight of the
        // player. Two pistol shots (6 dmg each, spaced past the 15-tick
        // cooldown) drop it → split into two Mediums (+1 net population).
        let before = d.mob_count();
        let c = d.centroid_of(MobId(3)).unwrap();
        d.shoot_at(c);
        assert_eq!(d.mob_count(), before, "first shot only wounds the Large");
        assert!(d.g.sink.0.iter().any(|q| q.id.0 == "goo_hit"), "first shot registered a hit");
        d.run(16);
        let c = d.centroid_of(MobId(3)).expect("still alive after one shot");
        d.shoot_at(c);
        d.run(1); // let the despawn/spawn flush + handle rebuild land
        assert!(d.centroid_of(MobId(3)).is_none(), "the Large is gone");
        assert_eq!(d.mob_count(), before + 1, "one Large became two Mediums (+1 net)");
        assert_eq!(d.world_goo_count(), d.mob_count(), "handle list matches the World");
        // children carry fresh seeded ids above every authored id (0..=3)
        let ids: Vec<u32> = d.g.mobs.iter().map(|&e| d.g.world.get::<&Goo>(e).unwrap().id.0).collect();
        assert_eq!(ids.iter().filter(|&&i| i >= 4).count(), 2, "two runtime children: {ids:?}");
        // self.mobs stays MobId-sorted after the rebuild
        let mut sorted = ids.clone();
        sorted.sort();
        assert_eq!(ids, sorted, "mob handle list must stay MobId-sorted");
        assert!(d.g.sink.0.iter().any(|q| q.id.0 == "goo_split"), "a split cue fired");
    }

    #[test]
    fn goo_split_round_trip_is_deterministic() {
        // The novel mechanic — runtime CommandBuffer::spawn + handle recovery —
        // must replay bit-identically. Same shots, two worlds, equal hash. We
        // fire at a FIXED room-E point (deterministic regardless of where the
        // blobs crawled), so the split cascade is identical across runs.
        let script = |d: &mut GooDrv| {
            for _ in 0..6 {
                d.shoot_at(Vec2::new(9.5, 4.8));
                d.run(16);
            }
            d.run(40);
        };
        let mut a = GooDrv::new();
        script(&mut a);
        let mut b = GooDrv::new();
        script(&mut b);
        assert_eq!(a.g.state_hash(), b.g.state_hash(), "split replay must be bit-identical");
        assert_eq!(a.g.snapshot().mobs, b.g.snapshot().mobs, "render poses must match");
        // and real work happened: at least one split spawned runtime children
        // (the seeded id counter advanced past the authored ids). Robust to the
        // blobs later re-merging, which the population count is not.
        assert!(a.g.res.next_mob_id > 4, "the cascade spawned split children: next_mob_id={}", a.g.res.next_mob_id);
    }

    /// Two tier-1 blobs spawned overlapping, with a trap between them that holds
    /// them together so they reliably fuse once their merge-grace expires.
    fn merge_pair_level() -> LevelSpec {
        use crate::spec::{MobSpec, TrapSpec};
        let mut spec = goo_level();
        spec.mobs = vec![
            MobSpec { id: MobId(0), tier: 1, pos: Vec3::new(4.0, 0.0, 3.0) },
            MobSpec { id: MobId(1), tier: 1, pos: Vec3::new(4.4, 0.0, 3.0) },
        ];
        spec.traps = vec![TrapSpec { id: 0, pos: Vec3::new(4.2, 0.0, 3.0), strength: 2.0, radius: 3.0 }];
        spec
    }

    #[test]
    fn goo_two_blobs_merge_on_contact() {
        // two Mediums (tier 1) held together by a trap fuse into one Large (tier
        // 0) once their merge-grace lapses — the inverse of the shot-split. The
        // lower id survives. (Runs past GOO_MERGE_GRACE = 45 ticks.)
        let mut g = HouseGame::new(&merge_pair_level(), VecSink::default());
        assert_eq!(g.mobs.len(), 2, "two blobs to start");
        for t in 0..90 {
            g.tick(Tick(t), &[]);
        }
        assert_eq!(g.mobs.len(), 1, "the two blobs fused into one");
        let surv = *g.world.get::<&Goo>(g.mobs[0]).unwrap();
        assert_eq!(surv.id, MobId(0), "the lower id survives the fusion");
        assert_eq!(surv.tier, 0, "the survivor grew one tier (Medium → Large)");
        assert_eq!(g.world.query::<&Goo>().iter().count(), 1, "handle list matches the World");
        assert!(g.sink.0.iter().any(|q| q.id.0 == "goo_merge"), "a merge cue fired");
    }

    #[test]
    fn goo_merge_round_trip_is_deterministic() {
        // fusion draws RNG + despawns via the command buffer — it must replay
        // bit-identically across two worlds.
        let run = || {
            let mut g = HouseGame::new(&merge_pair_level(), VecSink::default());
            for t in 0..90 {
                g.tick(Tick(t), &[]);
            }
            g
        };
        let a = run();
        let b = run();
        assert_eq!(a.state_hash(), b.state_hash(), "merge replay must be bit-identical");
        assert_eq!(a.snapshot().mobs, b.snapshot().mobs, "render poses must match");
        assert_eq!(a.mobs.len(), 1, "the pair actually fused");
    }

    #[test]
    fn goo_drapes_around_player_pillar_not_through() {
        use crate::spec::{playground_level, MobSpec};
        // the goo treats the player's pillar as solid (the player does not):
        // a blob seeking the player crawls up and drapes AROUND it — no particle
        // ever ends inside the pillar footprint.
        let mut spec = playground_level();
        spec.player_start = Vec3::new(2.0, 0.0, 2.0);
        spec.mobs = vec![MobSpec { id: MobId(0), tier: 0, pos: Vec3::new(0.8, 0.0, 2.0) }];
        spec.traps = vec![];
        let mut g = HouseGame::new(&spec, VecSink::default());
        for t in 0..150 {
            g.tick(Tick(t), &[]);
        }
        let blob = *g.world.get::<&Goo>(g.mobs[0]).unwrap();
        let pp = Vec2::new(2.0, 2.0);
        for p in &blob.parts {
            assert!((p.x - pp.x).abs() >= PLAYER_HALF || (p.y - pp.y).abs() >= PLAYER_HALF, "a particle penetrated the player pillar: {p:?}");
        }
        // and it really came up to the player (so the assertion above is meaningful)
        assert!((blob.centroid() - pp).length() < 1.4, "the blob crawled up to the player: {:?}", blob.centroid());
    }

    #[test]
    fn goo_level_leaves_mob_free_levels_untouched() {
        // sanity: constructing the mob-free levels spawns no Goo and the hash
        // excludes the mob block (the replay goldens above already pin this).
        let g = HouseGame::new(&game_level(), VecSink::default());
        assert_eq!(g.mobs.len(), 0);
        assert!(g.snapshot().mobs.is_empty());
    }

    #[test]
    fn survival_off_is_hash_stable_and_hud_neutral() {
        // a survival-OFF level (game_level) carries NO survival components: the
        // snapshot reports full needs + empty inventory, and the hash is exactly
        // the survival-disabled hash (the replay goldens pin the real value).
        let g = HouseGame::new(&game_level(), VecSink::default());
        let snap = g.snapshot();
        assert_eq!(snap.hunger, 1.0);
        assert_eq!(snap.battery, 1.0);
        assert_eq!(snap.inventory, Vec::<ItemKind>::new());
        // Use is a no-op on a survival-off level (no panic, no state change)
        let mut d = GameDrv::new();
        let h0 = d.g.state_hash();
        d.cmd(Command::Use { kind: ItemKind::Food });
        assert_eq!(d.g.state_hash(), h0, "Use must not perturb a survival-off level");
    }
}
