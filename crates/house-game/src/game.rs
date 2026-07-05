//! The game: commands, components, resources, world construction, and the
//! fixed-order system sequence in `tick()` (ARCHITECTURE.md "The game
//! (house-game)"). The system bodies live in `game/systems.rs`; snapshot +
//! state_hash (THE REPLAY ORACLE) live in `game/snapshot.rs`. Everything is
//! headless and deterministic: ordered spawning from LevelSpec, structural
//! changes through ONE command-buffer flush per tick, StableId-sorted outputs,
//! stateless flicker — `cargo test -p house-game` runs the whole game in
//! milliseconds with no GPU and no window.

use crate::flicker::flicker;
use crate::spec::{DoorId, ItemId, ItemKind, LevelSpec, LightId, LightKind, MobId, SurvivalParams, TargetId};
use crate::{collide_and_slide, flashlight_pose, iso_input_dir, recommended_min_px_per_sec, Level};
use glam::{IVec2, Vec2, Vec3};
use iso_core::{iso_basis, screen_px_to_world, snap_ground_to_lattice, ISO_R};
use sim_core::{AudioCue, AudioSink, CommandBuffer, Component, CueId, Entity, Events, NullSink, Pcg32, Simulation, Tick, World};

mod draft;
mod goo;
mod snapshot;
mod survival;
mod systems;
mod tactics;
mod weapon;
pub(crate) use systems::{id_sorted_handles, ray_aabb};
pub use draft::*;
pub use goo::*;
pub use survival::*;
pub use tactics::*;
pub use weapon::*;

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

/// Door leaf height (interact slab y extent before inflation).
pub const DOOR_H: f32 = 2.0;
/// Occluder height band for projectile sweeps: solids block shots from floor to here.
pub const WALL_H: f32 = 2.56;
/// Perimeter wall thickness used for the projectile occluder slabs.
pub const WALL_T: f32 = 0.25;
/// WalkTarget is reached when the remaining screen distance drops below 1 px.
pub const WALK_ARRIVE_PX: f32 = 1.0;
/// Consecutive fully-blocked ticks before a WalkTarget is abandoned.
pub const WALK_BLOCKED_TICKS: u32 = 2;
/// Arena walk momentum (see `ArenaRes.walk_vel_px`): per-tick lerp rates toward
/// the input step (accel ~7 ticks to 95%) and back to zero (a shorter skid).
pub const WALK_ACCEL: f32 = 0.35;
pub const WALK_DECEL: f32 = 0.25;
/// Knuth's multiplicative stride — the shared multiplier for RNG-free,
/// id-salted deterministic scrambles (goo particle jitter, gait/mitosis
/// desync, per-shot aim wobble). The stable id — already unique, already
/// hashed sim state — is the only entropy, so replays stay bit-exact with NO
/// RNG draw and the shared RNG's draw order never shifts.
pub(crate) const ID_HASH_STRIDE: u32 = 2654435761;

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
    /// RMB: fire the weapon (spawns physical projectiles on the aim ray).
    Shoot { ray: PickRay },
    /// WASD movement: x = right − left, y = up − down. Load-bearing, not a
    /// fallback: walk_system integrates it (a held key overrides click-walk),
    /// and shoot_system's moving-bloom penalty reads the staged direction.
    Move { dir: IVec2 },
    ToggleFlashlight,
    ToggleRoomLights,
    /// Quarter-turns are SIM state: walk trajectories depend on yaw_q.
    RotateCamera { dq: i8 },
    /// Consume one carried item of `kind` → restore the matching need (clamped
    /// to 1.0), emit `Consumed`. No-op if none carried or survival is off.
    Use { kind: ItemKind },
    /// Keys 1–5: select an arsenal weapon slot. No-op on levels without
    /// `arena` (the arsenal state doesn't exist there) and for unknown slots.
    SelectWeapon { slot: u8 },
    /// Keys Z/X/C (1-3): take a card from the open wave-lull draft hand.
    /// Swallowed when no hand is open or off arena levels.
    PickCard { slot: u8 },
    /// Mouse aim (arena turret): world-XZ unit direction from the player to
    /// the cursor's ground point. Sets `Facing` directly — the gun ring, the
    /// muzzle pose and the torch all track the mouse, tank-turret style,
    /// decoupled from the walk direction (walk no longer writes Facing on
    /// arena levels). The shell pushes one only when the direction actually
    /// moved (~0.5°), so the journal stays lean. No-op off arena.
    Aim { dir: Vec2 },
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
/// The player's shared fire-cooldown component. Born as the pistol's
/// component; since the arsenal landed it is the ONE cooldown every weapon
/// draws down (switching mid-cooldown never resets the timer — the
/// anti-exploit, see `shoot_system`).
pub struct GunCooldown {
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


// ---- resources ---------------------------------------------------------------

/// Domain events, emitted by systems and drained by audio (same tick).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum GameEvent {
    DoorOpened(DoorId, Vec3),
    DoorClosed(DoorId, Vec3),
    /// A weapon fired (muzzle point, the firing weapon's damage class — the
    /// shell keys per-weapon fire sound + recoil kick + screenshake off it).
    ShotFired(Vec3, WeaponClass),
    /// A grenade detonated at the point — the boom cue + the big shake.
    Detonated(Vec3),
    /// A squad lands in WAVE_TELEGRAPH_TICKS (its 1-based index) — the L1
    /// countdown beat: klaxon swell + the entrance pads pulse amber→red.
    WaveIncoming(u32),
    /// A wave squad just landed (its 1-based index) — the lull-over beat.
    WaveLanded(u32),
    /// A bouncy round (the grenade) rebounded off a solid/floor (impact
    /// point) — the D5 bounce "tok"; the shot stays alive, so no Impact.
    GrenadeBounced(Vec3),
    /// A hard round died on a wall / chunk / the floor (impact point, surface
    /// normal, the round's knockback). The shell's spark burst, impact flash
    /// and thip live here, scaled by the knockback so a slug crater visibly
    /// outranks an uzi tick. Bounces don't emit (the grenade is still
    /// alive); blob hits use `GooSplashed`.
    Impact(Vec3, Vec3, f32),
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
    /// A goo blob was shot but survived (id, hit point, resisted, class).
    /// `resisted` = the species damage multiplier floored the hit below face
    /// value (Tank vs uzi/shotgun) — the shell teaches the resist with a dull
    /// grey flash + thunk cue instead of the hot white pop. The class lets
    /// the shell weigh the hit (W6: a surviving SLUG hit chunks time).
    MobHit(MobId, Vec3, bool, WeaponClass),
    /// A Runner entered its pre-sprint WINDUP crouch (id, head) — the G3
    /// anticipation beat; the shell plays the rising two-note tell.
    MobWindup(MobId, Vec3),
    /// A goo blob's HP hit zero and it split into two smaller blobs (id, pos).
    MobSplit(MobId, Vec3),
    /// A goo blob died terminally (a Small blob, or a capped split) (id, pos).
    MobKilled(MobId, Vec3),
    /// Two same-tier blobs touched and fused into one a tier larger — the
    /// surviving (lower) id and the fusion point.
    MobMerged(MobId, Vec3),
    /// A cured blob died and SOLIDIFIED: a dead chunk now stands at the point
    /// (id of the body that died, its centre).
    MobSolidified(MobId, Vec3),
    /// A draft card entered the run (the pick cue + HUD refresh).
    CardPicked(Card),
    /// The pit lamps died (the wave-3 blackout) — the power-down cue.
    LightsOut,
    /// A blob squeezed past the sieve and escaped (its tier mass) — the
    /// breach klaxon tick.
    GooEscaped(u32),
    /// The full shift survived (SHIFT_WAVES cleared) — the clock-out fanfare.
    ShiftComplete,
    /// The run ended: goo contact drained suit integrity to zero. The shell
    /// shows the summary panel; a new run is a fresh sim (not a sim command).
    PlayerDown,
    /// A projectile splashed goo fluid: EVERY damaging hit emits one (uzi
    /// pinprick through grenade blast), carrying the impact point, the impact
    /// direction and the fluid punch (the weapon's knockback; killing blows
    /// boosted) — the shell scales its droplet spray from it. Presentation
    /// event only (no audio; the hit cue already plays).
    GooSplashed(MobId, Vec3, Vec3, f32),
}

/// Arena RUN state (the fail state): suit integrity 0..=1 drained by goo
/// contact (per overlapping fluid particle — an engulf wraps more of the
/// body and drains proportionally faster, so tier scaling falls out of the
/// physics), the death latch, and the tick it happened. `Some` only on
/// arena levels (the arsenal pattern); hashed under the same gate.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct RunState {
    pub integrity: f32,
    pub dead: bool,
    /// Survived the full shift (SHIFT_WAVES cleared) — the win latch. A run
    /// is OVER when either latch is set; `death_tick` is the end tick for
    /// both (the panel's SURVIVED line).
    pub won: bool,
    pub death_tick: u64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FlashPose {
    pub pos: Vec3,
    pub dir: Vec3,
}

/// Per-tick command staging: the semantic intents `resolve_commands` distils
/// from this tick's raw `Command`s, drained by the systems downstream and reset
/// every tick. Held apart from the persistent `Res` resources — NONE of it
/// enters `state_hash` (it is fully consumed/cleared within the tick it is built
/// in). The Vecs accumulate this tick's intents; `move_dir` is the last WASD
/// press (last write wins).
#[derive(Default)]
struct Staging {
    /// RMB shot rays this tick — each fires the weapon's pellets in shoot_system.
    shot_intents: Vec<PickRay>,
    /// Door ids whose interact volume a Click hit — applied by door_system.
    use_door: Vec<DoorId>,
    /// Last WASD direction pressed this tick (zero = none). Read by walk_system
    /// (movement) AND shoot_system (the moving-bloom accuracy penalty).
    move_dir: IVec2,
    /// Use-item intents (kind to consume) — applied by use_system.
    use_items: Vec<ItemKind>,
}

impl Staging {
    /// Reset to empty at the top of `resolve_commands` (one place, not four).
    fn clear(&mut self) {
        self.shot_intents.clear();
        self.use_door.clear();
        self.move_dir = IVec2::ZERO;
        self.use_items.clear();
    }
}

/// The arena-shooter resource block: everything that only ever moves on
/// levels with `spec.arena` (the arsenal/survival opt-in discipline). Grouped
/// so `Res` reads as core + gated blocks; the fields keep their individual
/// `Option`/default gates (drain is `None` on the plain pit, etc.), and the
/// `state_hash` fold order is unchanged — only field PATHS moved
/// (`res.arsenal` → `res.arena.arsenal`).
pub struct ArenaRes {
    /// Arsenal (arena-shooter weapon selection) when the level opts in via
    /// `spec.arena`; `None` = arsenal OFF (SelectWeapon is a no-op and nothing
    /// arsenal-shaped enters the hash — the survival-block discipline).
    pub arsenal: Option<ArsenalState>,
    /// A live explosion flash: blast point + ticks left. Armed by `explode`
    /// (grenade detonations), decayed each tick, surfaced to the renderer as a
    /// transient spotlight. Only ever `Some` on arsenal levels (grenades don't
    /// exist elsewhere), and hashed inside the arsenal-gated block.
    pub boom: Option<(Vec3, u32)>,
    /// Wave-director state; `Some` on arena levels only (hashed in the
    /// arsenal-gated block, like `boom`).
    pub wave: Option<WaveState>,
    /// Arena tactics: the BFS flow-field cache. DERIVED state — a pure
    /// function of (floor, solids, player cell), rebuilt on a cadence by
    /// `tactic_system`; never hashed (the `Level` precedent). `None` off
    /// arena levels forever.
    pub nav: Option<NavField>,
    /// Wall-corner cover candidates, computed once from the spec's solids
    /// (pure function of the spec — same standing as `Level.solids`).
    /// Populated on every level, read only by the arena brain.
    pub cover: Vec<Vec2>,
    /// Comm-pact cooldown: the next tick a new blob pact may form. Hashed
    /// under the arsenal gate (it only ever moves on arena levels).
    pub next_comm_tick: u64,
    /// Arena run state (integrity / death latch) — `Some` iff `spec.arena`.
    pub run: Option<RunState>,
    /// The open wave-lull draft hand (arena; None between drafts).
    pub draft: Option<DraftState>,
    /// Cards taken this run, pick order (arena-gated hash fold).
    pub picked: Vec<Card>,
    /// The drain zone (spec.drain): goo reaching it escapes into `breach`.
    pub drain: Option<[f32; 4]>,
    /// Escaped tier mass. `breach >= BREACH_CAP` fails the run. Hashed
    /// under the arsenal gate (only drain levels ever move it).
    pub breach: u32,
    /// The drain-seeker flow field (derived cache, the `nav` twin).
    pub nav_drain: Option<NavField>,
    /// Arena walk momentum: the screen-px step actually applied last tick.
    /// `walk_system` ramps it toward the input step (accel) and back to zero
    /// (a short skid) instead of binary start/stop — the hover-droid feel.
    /// Only ever non-zero on arena levels; hashed under the arsenal gate.
    pub walk_vel_px: Vec2,
}

/// Plain-struct resources (no type-map indirection — determinism reads best
/// when the data flow is spelled out).
pub struct Res {
    pub level: Level,
    /// Closed/animating door leaf solids, DoorId-sorted (rebuilt by door_system).
    pub dyn_solids: Vec<(DoorId, [f32; 4])>,
    /// Projectile-sweep occluders that never change: perimeter wall slabs + static solids.
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
    /// Per-tick command staging (see [`Staging`]) — reset each tick, never hashed.
    staging: Staging,
    /// Survival tuning when enabled; `None` = survival OFF (all survival
    /// systems are no-ops and nothing survival-shaped enters the hash).
    pub survival: Option<SurvivalParams>,
    /// The arena-shooter block (see [`ArenaRes`]): arsenal, waves, run
    /// state, draft, drain, tactics caches, walk momentum. Always present;
    /// each field keeps its own arena gate.
    pub arena: ArenaRes,
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
    /// Net blob count change queued this tick (spawns − despawns, applied at
    /// the flush). `self.mobs` only rebuilds post-flush, so every same-tick
    /// GOO_LIVE_CAP decision (a birth, a shot-split) must add this to the
    /// stale handle count — without it two same-tick splits/births each pass
    /// the gate and overshoot the cap (overflowing the renderer's fixed
    /// metaball/shadow-proxy pools). Reset every tick; never hashed (it is
    /// derivable scratch, like `staging`).
    pending_mob_delta: i32,
    /// Seeded monotonic id for runtime-spawned projectiles, so the handle list
    /// stays id-sorted. Advances on every fired pellet.
    next_projectile_id: u32,
    /// Set when this tick queued a projectile spawn/despawn, so the post-flush
    /// `rebuild_projectiles` runs only when the set actually changed.
    projectiles_dirty: bool,
    /// Goo traps (floor gravity emitters): (xz position, strength, radius,
    /// off_tick). Read by `goo_system` to pull blobs; a trap with a non-zero
    /// `off_tick` goes inert once `cur_tick` reaches it (a timed hazard pulse).
    pub traps: Vec<(Vec2, f32, f32, u32)>,
    /// Current sim tick, mirrored each `tick()` so `trap_accel` (a `&self`
    /// reader) can expire timed traps without threading the tick everywhere.
    pub cur_tick: u64,
    /// Cached PBF rest density (kernel-calibrated; see `goo_rho0`).
    pub goo_rho0: f32,
    /// Dead solid chunks (xmin, zmin, xmax, zmax): the remains of cured blobs.
    /// Inert obstacles — they block walking (goo inherits via `walk_blocked`)
    /// and low projectiles (a knee-high slab, `GOO_CHUNK_H`). Append-only,
    /// capped at `GOO_CHUNK_CAP`; hashed only when non-empty (the mobs-block
    /// pattern), so chunk-free levels hash exactly as before.
    pub chunks: Vec<[f32; 4]>,
    /// Level-authored film knob (spec.sterile): tier-0 mothers skip budding.
    pub sterile: bool,
    /// The level seed (mirrors spec.seed) — salts the draft hands; the shell
    /// also reads it for trace/reel naming.
    pub seed: u64,
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
    /// Arsenal HUD state: (selected weapon, cooldown ticks remaining, the
    /// selected weapon's full cooldown). `None` on non-arena levels, so the
    /// old-level snapshot is independent of the arena feature.
    pub weapon: Option<(WeaponKind, u32, u32)>,
    /// A live explosion flash: blast point + remaining intensity 0..1 (the
    /// renderer turns it into a transient spotlight). `None` when quiet.
    pub boom: Option<(Vec3, f32)>,
    /// Arena run state (suit integrity + death latch); `None` off arena.
    pub run: Option<RunState>,
    /// The open draft hand, for the HUD card plates. `None` between drafts.
    pub draft: Option<DraftState>,
    /// How many cards the run has taken (HUD tally).
    pub picked: u32,
    /// Containment levels: (escaped mass, cap) for the LEAK meter.
    pub breach: Option<(u32, u32)>,
    /// Current wave number (arena levels; 0 = the authored squad).
    pub wave: Option<u16>,
    /// Goo blobs to draw this tick, MobId-sorted. Empty on mob-free levels.
    pub mobs: Vec<MobRender>,
    /// Projectiles in flight this tick, ProjectileId-sorted. Empty when nothing
    /// has been fired / everything has landed.
    pub projectiles: Vec<ProjectileRender>,
    /// Dead solid chunks (xmin, zmin, xmax, zmax) — cured-blob remains the
    /// renderer skins as matte domes. Empty everywhere but a fought arena.
    pub chunks: Vec<[f32; 4]>,
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
    /// Live projectile entities, ProjectileId-sorted (empty when nothing is in
    /// flight). Rebuilt from a World query after any fire/impact flush.
    projectiles: Vec<Entity>,
}

impl<S: AudioSink> HouseGame<S> {
    pub fn new(spec: &LevelSpec, sink: S) -> HouseGame<S> {
        let mut world = World::new();
        let level = Level { floor: spec.floor_bounds(), solids: spec.static_solids.clone() };

        // default facing: toward the camera (screen-down) until the first walk
        let down = screen_px_to_world(Vec2::new(0.0, 1.0), 0.0);
        let facing = Vec2::new(down.x, down.z).normalize();
        let player = world.spawn((Pos(spec.player_start), Facing(facing), Player { speed_px: PLAYER_SPEED_PX }, Flashlight { on: false }, GunCooldown { cooldown_ticks: 0 }));
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
        // plane tie does not block — see NearestHit::consider's strict `<` and
        // the WALL_BIAS rule in game/weapon.rs's projectile_system)
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
            staging: Staging::default(),
            survival: spec.survival,
            arena: ArenaRes {
                arsenal: spec.arena.map(|_| ArsenalState::default()),
                boom: None,
                wave: spec.arena.map(|a| WaveState { idx: 0, lull: a.wave_lull, lull_full: a.wave_lull }),
                nav: None,
                cover: cover_points(&spec.static_solids),
                next_comm_tick: 0,
                run: spec.arena.map(|_| RunState { integrity: 1.0, dead: false, won: false, death_tick: 0 }),
                draft: None,
                picked: Vec::new(),
                drain: spec.drain,
                breach: 0,
                nav_drain: None,
                walk_vel_px: Vec2::ZERO,
            },
            need_was_critical: [false; 2], // needs start full (1.0) → not critical
            buf: CommandBuffer::new(),
            // children spawn above every authored id (0 when the level has none)
            next_mob_id: spec.mobs.iter().map(|m| m.id.0 + 1).max().unwrap_or(0),
            mobs_dirty: false,
            pending_mob_delta: 0,
            next_projectile_id: 0,
            projectiles_dirty: false,
            traps: spec.traps.iter().map(|t| (Vec2::new(t.pos.x, t.pos.z), t.strength, t.radius, t.off_tick)).collect(),
            cur_tick: 0,
            goo_rho0: goo_rho0(),
            chunks: Vec::new(),
            sterile: spec.sterile,
            seed: spec.seed,
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
                (m.id, world.spawn((fresh_goo(m.id, m.tier, m.kind, head, heading, Vec2::ZERO, timer),)))
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
            projectiles: Vec::new(),
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
        self.mobs = id_sorted_handles(&self.world, |g: &Goo| g.id);
    }

    /// Same discipline as `rebuild_mobs`: the command buffer's spawn/despawn
    /// don't return handles, so after a fire/impact flush we re-find every live
    /// `Projectile` and sort by the stable `ProjectileId`.
    fn rebuild_projectiles(&mut self) {
        self.projectiles = id_sorted_handles(&self.world, |p: &Projectile| p.id);
    }

    fn player_pos(&self) -> Vec3 {
        self.world.get::<&Pos>(self.player).unwrap().0
    }

    fn player_facing(&self) -> Vec2 {
        self.world.get::<&Facing>(self.player).unwrap().0
    }
}

impl<S: AudioSink> Simulation for HouseGame<S> {
    type Command = Command;
    type Snapshot = GameSnapshot;

    fn tick(&mut self, t: Tick, cmds: &[Command]) {
        let sim_t = t.0 as f32 * TICK_DT;
        self.res.cur_tick = t.0; // for timed-trap expiry in trap_accel
        self.res.pending_mob_delta = 0; // fresh tick: no queued blob spawns/despawns yet
        self.resolve_commands(cmds);
        self.door_system();
        self.walk_system();
        self.tactic_system(); // arena brain: advance tactics before the bodies move
        self.goo_system(); // blobs crawl (a mover) — after walk, before shoot
        self.drain_system(); // containment: escapes despawn into the breach meter
        self.integrity_system(); // arena: contact drain + shove, on fresh poses
        self.pickup_system(); // after movement: collect items the walk reached
        self.use_system(); // consume carried items → restore needs
        self.shoot_system();
        self.projectile_system(); // advance live shots, resolve impacts (after they spawn)
        self.merge_system(); // blobs that drifted together fuse (skipped if a shot already changed the set)
        self.wave_system(); // arena: land the next squad once the floor is clear
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
        if self.res.projectiles_dirty {
            self.rebuild_projectiles();
            self.res.projectiles_dirty = false;
        }
    }

    /// Pure read — never advances RNG or any other state (pinned by test).
    /// Body: `snapshot_impl` in `game/snapshot.rs`, the replay-oracle module.
    fn snapshot(&self) -> GameSnapshot {
        self.snapshot_impl()
    }

    /// THE REPLAY ORACLE — body + full fold contract on `hash_impl` in
    /// `game/snapshot.rs`. The fold order is the replay contract; a change
    /// that moves it breaks every golden. Do not edit casually.
    fn state_hash(&self) -> u64 {
        self.hash_impl()
    }
}

#[cfg(test)]
mod tests;
