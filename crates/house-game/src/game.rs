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
use sim_core::{AudioCue, AudioSink, CommandBuffer, Component, CueId, Entity, Events, NullSink, Pcg32, Simulation, Tick, World};

mod goo;
mod survival;
mod weapon;
pub use goo::*;
pub use survival::*;
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
    /// A cured blob died and SOLIDIFIED: a dead chunk now stands at the point
    /// (id of the body that died, its centre).
    MobSolidified(MobId, Vec3),
    /// A projectile splashed goo fluid: EVERY damaging hit emits one (uzi
    /// pinprick through grenade blast), carrying the impact point, the impact
    /// direction and the fluid punch (the weapon's knockback; killing blows
    /// boosted) — the shell scales its droplet spray from it. Presentation
    /// event only (no audio; the hit cue already plays).
    GooSplashed(MobId, Vec3, Vec3, f32),
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
            arsenal: spec.arena.map(|_| ArsenalState::default()),
            boom: None,
            wave: spec.arena.map(|a| WaveState { idx: 0, lull: a.wave_lull, lull_full: a.wave_lull }),
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

    /// True if ground point (x, z) is blocked for WALKING: level (floor rect +
    /// static solids) or any present door leaf solid.
    fn walk_blocked(&self, x: f32, z: f32) -> bool {
        self.res.level.is_blocked(x, z)
            || self.res.dyn_solids.iter().any(|(_, s)| x >= s[0] && z >= s[1] && x <= s[2] && z <= s[3])
            || self.res.chunks.iter().any(|s| x >= s[0] && z >= s[1] && x <= s[2] && z <= s[3])
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

    // ---- systems. The ONE authoritative per-tick order is `tick()` below
    // (one commented call per step); more systems live in game/goo.rs,
    // game/weapon.rs and game/survival.rs. -------------------------------------

    /// Commands → semantic intents. Click: door interact beats ground walk;
    /// walks to blocked/off-floor points are no-ops (no clamp-to-edge in v1).
    fn resolve_commands(&mut self, cmds: &[Command]) {
        self.res.staging.clear();
        for c in cmds {
            match c {
                Command::Click { ray, ground } => {
                    if let Some(id) = self.door_under_ray(ray) {
                        self.res.staging.use_door.push(id);
                    } else if let Some(g) = ground {
                        if !self.walk_blocked(g.x, g.y) {
                            self.res.buf.insert_one(self.player, WalkTarget { ground: *g, blocked_ticks: 0 });
                        }
                    }
                }
                Command::Shoot { ray } => self.res.staging.shot_intents.push(*ray),
                Command::Move { dir } => self.res.staging.move_dir = *dir, // last press this tick wins
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
                Command::Use { kind } => self.res.staging.use_items.push(*kind), // applied by use_system
                Command::SelectWeapon { slot } => {
                    // arsenal levels only; unknown slots are swallowed. Selection
                    // is instant and does NOT reset the shared cooldown timer.
                    if let (Some(a), Some(k)) = (self.res.arsenal.as_mut(), WeaponKind::from_slot(*slot)) {
                        a.current = k;
                    }
                }
            }
        }
    }

    /// Door state machines on tick counters. The leaf collision solid is
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
            let used = self.res.staging.use_door.contains(&door.id);
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

    /// Movement: manual Move (iso 2:1 input dir) wins over a WalkTarget;
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
        let manual = self.res.staging.move_dir != IVec2::ZERO;
        let dpx: Option<Vec2> = if manual {
            // WASD fallback: a held key overrides (and cancels) click-walk
            if self.world.get::<&WalkTarget>(self.player).is_ok() {
                self.res.buf.remove_one::<WalkTarget>(self.player);
            }
            iso_input_dir(self.res.staging.move_dir.x as f32, self.res.staging.move_dir.y as f32).map(|d| d * speed * TICK_DT)
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


    /// Flashlight pose from the lattice-snapped position + facing (the same
    /// pure function the viewer uses).
    fn flashlight_system(&mut self) {
        let yaw = 90.0 * self.res.yaw_q as f32;
        let p = snap_ground_to_lattice(self.player_pos(), yaw);
        let (pos, dir) = flashlight_pose(p, self.player_facing());
        self.res.flash_pose = FlashPose { pos, dir };
    }

    /// Per-light emission at sim time `t`: room master AND per-light state
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

    /// Domain events → audio cues into the injected sink, emission order.
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
                GameEvent::MobSolidified(_, p) => AudioCue { id: CueId("goo_solidify"), pos: Some(p), gain: 0.9 },
                // need-state crossings are HUD/feedback events, no audio cue yet;
                // bleed droplets are pure presentation (the hit cue already plays)
                GameEvent::NeedCritical(_) | GameEvent::NeedRecovered(_) | GameEvent::GooSplashed(..) => continue,
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
        self.res.cur_tick = t.0; // for timed-trap expiry in trap_accel
        self.res.pending_mob_delta = 0; // fresh tick: no queued blob spawns/despawns yet
        self.resolve_commands(cmds);
        self.door_system();
        self.walk_system();
        self.goo_system(); // blobs crawl (a mover) — after walk, before shoot
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
            // arsenal HUD (arena levels): selected weapon + shared cooldown
            weapon: self.res.arsenal.map(|a| {
                let cd = self.world.get::<&Pistol>(self.player).unwrap().cooldown_ticks;
                (a.current, cd, self.current_weapon().cooldown_ticks)
            }),
            boom: self.res.boom.map(|(at, t)| (at, t as f32 / BOOM_FLASH_TICKS as f32)),
            wave: self.res.wave.map(|w| w.idx),
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
                    // tension (the birth push) shrinks the drawn size in lockstep
                    // with the fluid footprint, so she visibly balls up then swells
                    // back — identical factor to goo_system's g_scale shrink.
                    let tense = goo_tension(g.tier, g.spawn_timer, g.birth_glow);
                    let r = g.body_len / GOO_BODY_FRAC * (1.0 - GOO_TENSE_SHRINK * tense);
                    let pr = r * GOO_PART_RADIUS_FRAC;
                    // the render pose (jelly-wobble squash), the per-particle
                    // birth glow, and the vertical body scale are pure
                    // presentation reads of the hashed state.
                    let parts = goo_render_parts(&g, pr);
                    let glow = goo_render_glow(&g);
                    let vscale = goo_render_vscale(&g);
                    MobRender { id: g.id, tier: g.tier, kind: g.kind, cure: g.cure, weak: goo_is_weak(&g), parts, radius: r, part_radius: pr, glow, vscale }
                })
                .collect(),
            // projectiles in flight (ProjectileId-sorted) — empty when idle.
            projectiles: self
                .projectiles
                .iter()
                .map(|&e| {
                    let p = self.world.get::<&Projectile>(e).unwrap();
                    // tracer size follows the shot's physical radius so the five
                    // weapons READ differently in flight (fat slug, pinprick uzi);
                    // the pistol lands exactly on the historical 0.14.
                    ProjectileRender { id: p.id, pos: p.pos, radius: p.radius * (PROJ_RENDER_RADIUS / PISTOL.radius) }
                })
                .collect(),
            chunks: self.res.chunks.clone(),
        }
    }

    /// FNV-1a over the canonical field order: player (pos, facing, flashlight,
    /// pistol cooldown, walk target), muzzle ticks, yaw_q, master switch,
    /// score, doors (id, state), lights (id, on), target hits, RNG probe.
    ///
    /// THE REPLAY ORACLE. This fold — its FIXED field-visit order, every float
    /// op, and which components are folded — is the contract the golden replays
    /// and the determinism tests assert against. Changing the order, switching a
    /// sim float to f64, or reordering an accumulation that feeds it breaks every
    /// golden. The mob and projectile blocks fold ONLY when non-empty, so
    /// mob-free / shot-free levels stay byte-identical to before those features.
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
        // Arsenal folds in ONLY on arena levels (spec.arena), so every other
        // level hashes byte-identically to before the arena feature. The boom
        // flash rides inside the same gate (grenades exist only here).
        if let Some(a) = self.res.arsenal {
            h.u64(a.current.tag());
            match self.res.boom {
                Some((at, t)) => {
                    h.u64(1).f32(at.x).f32(at.y).f32(at.z).u64(t as u64);
                }
                None => {
                    h.u64(0);
                }
            }
            if let Some(w) = self.res.wave {
                h.u64(w.idx as u64).u64(w.lull as u64);
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
                h.u64(g.spawn_timer as u64).f32(g.spawn_dir.x).f32(g.spawn_dir.y).u64(g.birth_glow as u64).u64(g.birth_immune as u64);
                h.u64(g.tether as u64).f32(g.tether_anchor.x).f32(g.tether_anchor.y).u64(g.tear_ticks as u64);
                h.f32(g.wobble_amp).f32(g.wobble_dir.x).f32(g.wobble_dir.y).u64(g.wobble_phase as u64);
                // arena-species block (2026-07-03): kind + cure + harpoon pin.
                // Appending these moved ALL FOUR goo oracles (hash bytes only —
                // Green multipliers are exact 1.0 identities, so oracle-level
                // BEHAVIOR is unchanged; see the dated recapture note there).
                h.u64(g.kind.tag()).u64(g.cure as u64).u64(g.pinned as u64).f32(g.pin_pt.x).f32(g.pin_pt.y);
            }
        }
        // Projectiles block — ProjectileId-sorted, folded ONLY while shots are in
        // flight (empty → skipped, like mobs, so idle/non-shooting frames hash
        // exactly as before this feature). The counter is folded inside the block.
        if !self.projectiles.is_empty() {
            h.u64(self.res.next_projectile_id as u64);
            for &e in &self.projectiles {
                let p = self.world.get::<&Projectile>(e).unwrap();
                h.u64(p.id.0 as u64).u64(p.age as u64);
                h.f32(p.pos.x).f32(p.pos.y).f32(p.pos.z);
                h.f32(p.vel.x).f32(p.vel.y).f32(p.vel.z);
            }
        }
        // Dead solid chunks fold in ONLY when one exists (they require a cured
        // arena kill), so every chunk-free level hashes exactly as before.
        if !self.res.chunks.is_empty() {
            h.u64(self.res.chunks.len() as u64);
            for c in &self.res.chunks {
                h.f32(c[0]).f32(c[1]).f32(c[2]).f32(c[3]);
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

/// Rebuild a StableId-sorted entity handle list from a World query — the shared
/// runtime-spawn handle recovery used for both the goo (`Goo`/`MobId`) and the
/// projectile (`Projectile`/`ProjectileId`) lists. `CommandBuffer::spawn` does
/// not return the `Entity` it creates, so after a structural flush we re-find
/// every live `C` and sort by its stable id. The sort key — never archetype
/// order — becomes the iteration/hash order, so determinism holds (ids are
/// unique, so the unstable sort is fully ordered).
fn id_sorted_handles<C: Component, Id: Ord + Copy>(world: &World, id_of: impl Fn(&C) -> Id) -> Vec<Entity> {
    let mut pairs: Vec<(Id, Entity)> = world.query::<&C>().iter().map(|(e, c)| (id_of(c), e)).collect();
    pairs.sort_by_key(|(id, _)| *id);
    pairs.into_iter().map(|(_, e)| e).collect()
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
mod tests;
