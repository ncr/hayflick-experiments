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
mod weapon;
pub use goo::*;
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
    /// WASD fallback (kept through migration): x = right − left, y = up − down.
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
    /// A cured blob died and SOLIDIFIED: a dead chunk now stands at the point
    /// (id of the body that died, its centre).
    MobSolidified(MobId, Vec3),
    /// An uzi round tore a droplet off a surviving blob (id, impact point) —
    /// a presentation event (the shell spawns render droplets; no audio).
    MobBled(MobId, Vec3),
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
    /// Last WASD direction pressed this tick (zero = none); walk_system reads it.
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

    // ---- the 7 systems, fixed source order ------------------------------------

    /// 1. Commands → semantic intents. Click: door interact beats ground walk;
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
        let intents = std::mem::take(&mut self.res.staging.use_items);
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
                GameEvent::MobSolidified(_, p) => AudioCue { id: CueId("goo_solidify"), pos: Some(p), gain: 0.9 },
                // need-state crossings are HUD/feedback events, no audio cue yet;
                // bleed droplets are pure presentation (the hit cue already plays)
                GameEvent::NeedCritical(_) | GameEvent::NeedRecovered(_) | GameEvent::MobBled(..) => continue,
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
mod tests {
    use super::*;
    use crate::spec::{fixture, MobSpec};
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
    /// Ticks to let a close-range slug fly to an in-room target before asserting
    /// the (now travel-delayed) hit — generous: 24·(26/60) ≈ 10 wu of travel.
    const PROJ_FLY: u64 = 24;

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
        // the slug is now in flight: muzzle is armed, but the hit lands later.
        assert!(snap.muzzle_flash, "armed for 2 ticks");
        assert_eq!(snap.score, 0, "score waits for the slug to reach the disc");
        assert_eq!(d.cue_ids(), vec!["pistol_fire"]);
        d.run(1);
        assert!(d.g.snapshot().muzzle_flash);
        d.run(1);
        assert!(!d.g.snapshot().muzzle_flash, "exactly 2 ticks");
        // let the projectile travel to the wall and resolve the hit
        d.run(PROJ_FLY);
        assert_eq!(d.g.snapshot().score, 1, "the slug landed on the disc");
        assert_eq!(d.g.world.get::<&Target>(d.g.targets[0]).unwrap().hits, 1);
        assert_eq!(d.cue_ids(), vec!["pistol_fire", "target_hit"]);
    }

    #[test]
    fn shot_misses_off_disc() {
        let mut d = Drv::new();
        d.cmd(shoot(Vec3::new(-4.5, 1.25, 0.0), Vec3::new(0.0, 0.0, -1.0)));
        d.run(PROJ_FLY);
        assert_eq!(d.g.snapshot().score, 0);
        assert_eq!(d.cue_ids(), vec!["pistol_fire"]); // fired, no hit
    }

    #[test]
    fn projectile_flies_over_ticks_then_lands() {
        let mut d = Drv::new();
        d.cmd(shoot(Vec3::new(-3.5, 1.25, 0.0), Vec3::new(0.0, 0.0, -1.0)));
        // the slug is a live entity now, exposed to the renderer, NOT yet landed
        let s0 = d.g.snapshot();
        assert_eq!(s0.projectiles.len(), 1, "the shot is a physical projectile in flight");
        assert_eq!(s0.score, 0, "it has not reached the disc yet");
        // it travels a measurable distance each tick (not a hitscan)
        d.run(1);
        let a = d.g.snapshot().projectiles[0].pos;
        d.run(1);
        let b = d.g.snapshot().projectiles[0].pos;
        assert!((b - a).length() > 0.1, "the slug moved between ticks: {a:?} -> {b:?}");
        // and eventually lands, scores, and despawns (no leak)
        d.run(PROJ_FLY);
        assert_eq!(d.g.snapshot().score, 1, "the slug reached and scored the disc");
        assert!(d.g.snapshot().projectiles.is_empty(), "a landed slug is removed");
    }

    #[test]
    fn projectile_flight_replays_bit_identically() {
        // a shot in mid-flight folds into the hash; two runs must agree exactly.
        let run = || {
            let mut d = Drv::new();
            d.cmd(shoot(Vec3::new(-3.5, 1.25, 0.0), Vec3::new(0.0, 0.0, -1.0)));
            d.run(3); // freeze the world mid-flight (slug still travelling)
            d
        };
        let a = run();
        let b = run();
        assert_eq!(a.g.snapshot().projectiles.len(), 1, "still in flight at the checkpoint");
        assert_eq!(a.g.state_hash(), b.g.state_hash(), "projectile flight must be deterministic");
        assert_eq!(a.g.snapshot().projectiles, b.g.snapshot().projectiles, "render poses must match");
    }

    #[test]
    fn shot_blocked_by_closed_door_admitted_when_open() {
        // one ray, two worlds: through the A|B doorway at target 1 in room B
        let o = Vec3::new(-2.0, 1.25, 0.5);
        let dir = Vec3::new(2.0, 0.0, -3.0);
        let mut closed = Drv::new();
        closed.cmd(shoot(o, dir));
        closed.run(PROJ_FLY);
        assert_eq!(closed.g.snapshot().score, 0, "closed leaf occludes");
        assert_eq!(closed.cue_ids(), vec!["pistol_fire"]);
        let mut open = Drv::new();
        open.cmd(click_door_ab());
        open.run(31);
        open.cmd(shoot(o, dir));
        open.run(PROJ_FLY);
        assert_eq!(open.g.snapshot().score, 1, "open doorway admits the shot");
        assert_eq!(open.g.world.get::<&Target>(open.g.targets[1]).unwrap().hits, 1);
    }

    #[test]
    fn cooldown_swallows_spam() {
        let mut d = Drv::new();
        let at_t0 = || shoot(Vec3::new(-3.5, 1.25, 0.0), Vec3::new(0.0, 0.0, -1.0));
        let fired = |d: &Drv| d.cue_ids().iter().filter(|c| **c == "pistol_fire").count();
        // two shots in ONE tick: the second is swallowed → one slug leaves
        d.cmds(&[at_t0(), at_t0()]);
        assert_eq!(fired(&d), 1);
        // spamming every tick inside the cooldown adds nothing
        for _ in 0..PISTOL_COOLDOWN_TICKS - 1 {
            d.cmd(at_t0());
        }
        assert_eq!(fired(&d), 1);
        // first tick past the cooldown fires again
        d.cmd(at_t0());
        assert_eq!(fired(&d), 2);
        // let both slugs land; both score (order of fire/hit cues can interleave
        // with travel time, so assert the counts, not the sequence)
        d.run(PROJ_FLY);
        assert_eq!(d.g.snapshot().score, 2, "both fired slugs hit the disc");
        let hits = d.cue_ids().iter().filter(|c| **c == "target_hit").count();
        assert_eq!(hits, 2);
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
        d.run(PROJ_FLY); // the slug flies to the disc, THEN the hit cue lands
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
        // shoot target 4 (C south wall, faces -z) twice, spaced past the cooldown;
        // each slug now flies before it scores, so wait for it to land
        d.cmd(shoot(Vec3::new(6.0, 1.25, 6.0), Vec3::new(0.0, 0.0, 1.0)));
        d.run(20);
        assert_eq!(d.g.snapshot().score, 1);
        d.cmd(shoot(Vec3::new(6.0, 1.25, 6.0), Vec3::new(0.0, 0.0, 1.0)));
        d.run(20);
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

    /// Build a fresh game on `spec` and advance it `ticks` ticks with no input —
    /// the bare deterministic-sim loop shared by the merge/nursery scenarios.
    fn run_ticks(spec: &LevelSpec, ticks: u64) -> HouseGame<VecSink> {
        let mut g = HouseGame::new(spec, VecSink::default());
        for t in 0..ticks {
            g.tick(Tick(t), &[]);
        }
        g
    }

    #[test]
    fn select_weapon_noop_without_arsenal() {
        // SelectWeapon spam on a non-arena level must be byte-invisible: the
        // arsenal doesn't exist there, so the command is swallowed with no
        // state change (the gated-block discipline, like survival).
        let spec = fixture();
        let mut a = HouseGame::new(&spec, VecSink::default());
        let mut b = HouseGame::new(&spec, VecSink::default());
        for t in 0..60 {
            a.tick(Tick(t), &[Command::SelectWeapon { slot: (t % 5 + 1) as u8 }]);
            b.tick(Tick(t), &[]);
        }
        assert_eq!(a.state_hash(), b.state_hash(), "SelectWeapon must be a no-op without an arsenal");
        assert_eq!(a.snapshot().weapon, None, "non-arena snapshots carry no weapon HUD");
    }

    #[test]
    fn arena_select_weapon_is_hashed_and_selects() {
        // On the arena level the selection is real sim state: it lands in the
        // snapshot HUD tuple and moves state_hash (the arsenal-gated block).
        let spec = crate::spec::arena_level();
        let mut a = HouseGame::new(&spec, VecSink::default());
        let mut b = HouseGame::new(&spec, VecSink::default());
        a.tick(Tick(0), &[Command::SelectWeapon { slot: 3 }]);
        b.tick(Tick(0), &[]);
        assert_eq!(a.snapshot().weapon.map(|w| w.0), Some(WeaponKind::Shotgun));
        assert_eq!(b.snapshot().weapon.map(|w| w.0), Some(WeaponKind::Slug), "default slot is 1 (slug)");
        assert_ne!(a.state_hash(), b.state_hash(), "selection folds into the arena hash");
        // out-of-range slots are swallowed (selection unchanged)
        a.tick(Tick(1), &[Command::SelectWeapon { slot: 9 }]);
        assert_eq!(a.snapshot().weapon.map(|w| w.0), Some(WeaponKind::Shotgun));
    }

    /// Aim ray from the arena spawn's muzzle toward a floor point — shared by
    /// the arsenal tests below.
    fn arena_aim(gx: f32, gz: f32) -> Command {
        let muzzle = Vec3::new(0.0, 1.25, 6.0);
        let dir = (Vec3::new(gx, GOO_BASE_RADIUS, gz) - muzzle).normalize();
        Command::Shoot { ray: PickRay { origin: muzzle, dir } }
    }

    #[test]
    fn arena_weapons_replay_deterministically() {
        // the whole arsenal path (selection, bloom jitter, pellet fan) must be
        // RNG-free: the same command trace twice → the same state hash.
        let spec = crate::spec::arena_level();
        let run = || {
            let mut g = HouseGame::new(&spec, VecSink::default());
            for t in 0..240u64 {
                let cmds: Vec<Command> = match t {
                    10 => vec![Command::SelectWeapon { slot: 2 }],
                    20 | 26 | 32 => vec![arena_aim(0.0, 2.0), Command::Move { dir: IVec2::new(1, 0) }],
                    60 => vec![Command::SelectWeapon { slot: 3 }],
                    70 | 110 => vec![arena_aim(4.0, 0.5)],
                    150 => vec![Command::SelectWeapon { slot: 1 }],
                    160 => vec![arena_aim(-4.0, 1.0)],
                    _ => vec![],
                };
                g.tick(Tick(t), &cmds);
            }
            g.state_hash()
        };
        assert_eq!(run(), run(), "arsenal fire must be bit-reproducible");
    }

    #[test]
    fn shotgun_fires_seven_pellets_and_uzi_blooms_wider_moving() {
        let spec = crate::spec::arena_level();
        // shotgun: one trigger pull births `pellets` projectiles
        let mut g = HouseGame::new(&spec, VecSink::default());
        g.tick(Tick(0), &[Command::SelectWeapon { slot: 3 }]);
        g.tick(Tick(1), &[arena_aim(0.0, 2.0)]);
        assert_eq!(g.snapshot().projectiles.len(), SHOTGUN.pellets as usize);

        // uzi bloom: the same trigger tick fired while HOLDING a move key must
        // leave the projectile on a different (wider-scattered) velocity than
        // the planted shot — same id, same aim ray, only the movement differs.
        let fire_at = |moving: bool| -> Vec3 {
            let mut g = HouseGame::new(&spec, VecSink::default());
            g.tick(Tick(0), &[Command::SelectWeapon { slot: 2 }]);
            let mut cmds = vec![arena_aim(0.0, 2.0)];
            if moving {
                cmds.push(Command::Move { dir: IVec2::new(1, 0) });
            }
            g.tick(Tick(1), &cmds);
            let e = g.projectiles[0];
            let vel = g.world.get::<&Projectile>(e).unwrap().vel;
            vel
        };
        let planted = fire_at(false);
        let running = fire_at(true);
        assert_ne!(planted, running, "moving must widen the bloom cone");
        // both still fly at muzzle speed (jitter only bends, never brakes)
        assert!((planted.length() - UZI.muzzle_speed).abs() < 1e-3);
        assert!((running.length() - UZI.muzzle_speed).abs() < 1e-3);
    }

    #[test]
    fn grenade_bounces_off_the_wall_and_replays_bit_exact() {
        // fire a grenade at the arena's south wall (z = 10, 4 wu behind the
        // spawn): it must SURVIVE the wall hit with its z-velocity reflected,
        // then die by fuse — and the whole dance must replay to the same hash.
        let spec = crate::spec::arena_level();
        let run = || {
            let mut g = HouseGame::new(&spec, VecSink::default());
            g.tick(Tick(0), &[Command::SelectWeapon { slot: 4 }]);
            let ray = PickRay { origin: Vec3::new(0.0, 1.25, 6.0), dir: Vec3::new(0.0, -0.05, 1.0).normalize() };
            g.tick(Tick(1), &[Command::Shoot { ray }]);
            let mut bounced = false;
            let mut hashes = Vec::new();
            for t in 2..140u64 {
                g.tick(Tick(t), &[]);
                if let Some(&e) = g.projectiles.first() {
                    let p = *g.world.get::<&Projectile>(e).unwrap();
                    if p.vel.z < 0.0 {
                        bounced = true; // flying back off the south wall
                    }
                }
                hashes.push(g.state_hash());
            }
            assert!(bounced, "the grenade must reflect off the wall, not despawn");
            assert!(g.projectiles.is_empty(), "the fuse (max_age 90) must have detonated it");
            hashes
        };
        assert_eq!(run(), run(), "grenade flight must be bit-reproducible");
    }

    #[test]
    fn grenade_blast_damages_both_blobs_of_a_pair() {
        // two Mediums 1.2 wu apart on an open floor; one grenade lobbed at the
        // first must damage BOTH (contact/fuse detonation + 1.6 wu falloff).
        let spec = LevelSpec {
            mobs: vec![
                MobSpec { id: MobId(0), tier: 1, kind: crate::spec::GooKind::Green, pos: Vec3::new(0.0, 0.0, 0.0) },
                MobSpec { id: MobId(1), tier: 1, kind: crate::spec::GooKind::Green, pos: Vec3::new(1.2, 0.0, 0.0) },
            ],
            arena: Some(crate::spec::ArenaParams::default()),
            player_start: Vec3::new(0.0, 0.0, 4.0),
            ..crate::spec::goopair_level()
        };
        let mut g = HouseGame::new(&spec, VecSink::default());
        g.res.event_tap = Some(Vec::new());
        g.tick(Tick(0), &[Command::SelectWeapon { slot: 4 }]);
        let ray = PickRay { origin: Vec3::new(0.0, 1.25, 4.0), dir: Vec3::new(0.0, -0.9, -4.0).normalize() };
        g.tick(Tick(1), &[Command::Shoot { ray }]);
        for t in 2..220u64 {
            g.tick(Tick(t), &[]);
        }
        let tap = g.res.event_tap.take().unwrap();
        let touched = |id: MobId| tap.iter().any(|ev| matches!(ev, GameEvent::MobHit(i, _) | GameEvent::MobSplit(i, _) | GameEvent::MobKilled(i, _) if *i == id));
        assert!(touched(MobId(0)), "the contact blob must take blast damage: {tap:?}");
        assert!(touched(MobId(1)), "the neighbour inside the blast radius must take falloff damage: {tap:?}");
    }

    #[test]
    fn tank_resists_small_arms_but_not_the_slug() {
        // arena MobId(0) is the tier-0 Tank (hp 12): uzi damage quarters
        // (2 -> 0 -> floored to 1), slug lands in full.
        let spec = crate::spec::arena_level();
        let mut g = HouseGame::new(&spec, VecSink::default());
        let e = g.mobs[0];
        assert_eq!(g.world.get::<&Goo>(e).unwrap().kind, crate::spec::GooKind::Tank);
        let hit = Vec3::new(-4.0, 0.3, 1.0);
        g.damage_goo(e, hit, Vec3::Z, UZI.damage, 0.0, WeaponClass::Uzi);
        assert_eq!(g.world.get::<&Goo>(e).unwrap().hp, 11, "uzi vs tank: 2/4 floored to 1");
        g.damage_goo(e, hit, Vec3::Z, PISTOL.damage, 0.0, WeaponClass::Standard);
        assert_eq!(g.world.get::<&Goo>(e).unwrap().hp, 5, "standard lands in full");
    }

    #[test]
    fn harpoon_pins_a_blob_in_place() {
        // pin the arena's fast Runner (tier 1 at (4, 0.5)) and let the sim run:
        // its centroid must stay at the nail point instead of hunting off
        // (an unpinned Runner covers ~1.76 wu/s — 5+ wu over the window).
        let spec = crate::spec::arena_level();
        let mut g = HouseGame::new(&spec, VecSink::default());
        let e = g.mobs[1];
        assert_eq!(g.world.get::<&Goo>(e).unwrap().kind, crate::spec::GooKind::Runner);
        g.damage_goo(e, Vec3::new(4.0, 0.3, 0.5), Vec3::Z, HARPOON.damage, HARPOON.knockback, WeaponClass::Harpoon);
        let (pin_pt, pinned) = {
            let gg = g.world.get::<&Goo>(e).unwrap();
            (gg.pin_pt, gg.pinned)
        };
        assert_eq!(pinned, GOO_PIN_TICKS);
        for t in 0..180u64 {
            g.tick(Tick(t), &[]);
        }
        let gg = *g.world.get::<&Goo>(e).unwrap();
        let drift = (gg.centroid() - pin_pt).length();
        assert!(drift < 0.6, "pinned blob must stay nailed (drifted {drift:.2} wu)");
        assert_eq!(gg.pinned, GOO_PIN_TICKS - 180, "the pin ticks down");
    }

    #[test]
    fn blobs_merge_only_within_a_species() {
        // two overlapping tier-1 blobs. Same kind -> they fuse into a tier-0;
        // different kinds -> contact repulsion pushes them apart and NO fusion
        // ever fires (the merge gate and the repulsion opt-out must agree).
        let pair = |kind_b: crate::spec::GooKind| -> (usize, bool) {
            let spec = LevelSpec {
                mobs: vec![
                    MobSpec { id: MobId(0), tier: 1, kind: crate::spec::GooKind::Green, pos: Vec3::new(-0.1, 0.0, 0.0) },
                    MobSpec { id: MobId(1), tier: 1, kind: kind_b, pos: Vec3::new(0.1, 0.0, 0.0) },
                ],
                // the goofloor trick: a central well holds the pair together
                // through the newborn grace (they repel until both merge-ready)
                traps: vec![crate::spec::TrapSpec { id: 0, pos: Vec3::ZERO, strength: 1.3, radius: 2.6, off_tick: 0 }],
                ..crate::spec::goopair_level()
            };
            let mut g = HouseGame::new(&spec, VecSink::default());
            for t in 0..400u64 {
                g.tick(Tick(t), &[]);
            }
            let any_large = g.mobs.iter().any(|&e| g.world.get::<&Goo>(e).unwrap().tier == 0);
            (g.mobs.len(), any_large)
        };
        let (n_same, large_same) = pair(crate::spec::GooKind::Green);
        // (a fused tier-0 is a MOTHER — by t400 it has budded a mini, so the
        // count is survivor + brood; the tier-0's existence is the fusion proof)
        assert!(large_same, "same-species overlap must fuse up: {n_same} mobs, large={large_same}");
        let (n_mixed, large_mixed) = pair(crate::spec::GooKind::Runner);
        assert!(!large_mixed && n_mixed == 2, "mixed species must never fuse: {n_mixed} mobs, large={large_mixed}");
    }

    /// One lone Large on an open floor (the chunk-mechanics fixture).
    fn lone_large_spec() -> LevelSpec {
        LevelSpec {
            mobs: vec![MobSpec { id: MobId(0), tier: 0, kind: crate::spec::GooKind::Green, pos: Vec3::new(0.0, 0.0, 0.0) }],
            traps: vec![],
            ..crate::spec::goopair_level()
        }
    }

    #[test]
    fn three_slugs_solidify_a_large_into_a_chunk() {
        // 4+4+4 slug damage kills the 12-hp Large AT the cure threshold: a
        // dead solid chunk forms (blocks walking, enters hash + snapshot) and
        // ONE small escapee squirms free instead of the usual two-way split.
        let spec = lone_large_spec();
        let mut g = HouseGame::new(&spec, VecSink::default());
        g.res.event_tap = Some(Vec::new());
        let e = g.mobs[0];
        let c = g.world.get::<&Goo>(e).unwrap().centroid();
        let hit = Vec3::new(c.x, 0.3, c.y);
        for _ in 0..3 {
            g.damage_goo(e, hit, Vec3::Z, SLUG.damage, 0.0, WeaponClass::Slug);
        }
        g.tick(Tick(0), &[]); // flush the queued despawn/spawn
        assert_eq!(g.res.chunks.len(), 1, "a chunk must stand");
        let ch = g.res.chunks[0];
        assert!(g.walk_blocked((ch[0] + ch[2]) * 0.5, (ch[1] + ch[3]) * 0.5), "the chunk blocks walking");
        assert_eq!(g.mobs.len(), 1, "one escapee, not a two-way split");
        assert_eq!(g.world.get::<&Goo>(g.mobs[0]).unwrap().tier, 1, "the escapee is a tier down");
        assert_eq!(g.snapshot().chunks.len(), 1, "the renderer sees it");
        let tap = g.res.event_tap.take().unwrap();
        assert!(tap.iter().any(|ev| matches!(ev, GameEvent::MobSolidified(MobId(0), _))), "{tap:?}");
    }

    #[test]
    fn an_uncured_kill_still_splits_in_two() {
        // one slug (cure 1 < threshold 2) + pistol finish: the classic split.
        let spec = lone_large_spec();
        let mut g = HouseGame::new(&spec, VecSink::default());
        let e = g.mobs[0];
        let c = g.world.get::<&Goo>(e).unwrap().centroid();
        let hit = Vec3::new(c.x, 0.3, c.y);
        g.damage_goo(e, hit, Vec3::Z, SLUG.damage, 0.0, WeaponClass::Slug); // hp 8, cure 1
        g.damage_goo(e, hit, Vec3::Z, PISTOL.damage, 0.0, WeaponClass::Standard); // hp 2
        g.damage_goo(e, hit, Vec3::Z, PISTOL.damage, 0.0, WeaponClass::Standard); // dead, cure 1
        g.tick(Tick(0), &[]);
        assert!(g.res.chunks.is_empty(), "no chunk below the cure threshold");
        assert_eq!(g.mobs.len(), 2, "the classic two-way split");
    }

    #[test]
    fn clearing_the_arena_summons_the_next_wave_deterministically() {
        // a one-Small arena: kill it (terminal, +2 score), wait out the lull,
        // and wave 1 lands — 4 mixed blobs on the north entrance ring. The
        // whole cycle must replay to identical hashes.
        let spec = LevelSpec {
            mobs: vec![MobSpec { id: MobId(0), tier: 2, kind: crate::spec::GooKind::Green, pos: Vec3::new(0.0, 0.0, 2.0) }],
            ..crate::spec::arena_level()
        };
        let lull = spec.arena.unwrap().wave_lull as u64;
        let run = || {
            let mut g = HouseGame::new(&spec, VecSink::default());
            let e = g.mobs[0];
            let c = g.world.get::<&Goo>(e).unwrap().centroid();
            g.damage_goo(e, Vec3::new(c.x, 0.3, c.y), Vec3::Z, 99, 0.0, WeaponClass::Standard);
            g.tick(Tick(0), &[]); // flush the kill
            assert!(g.mobs.is_empty(), "arena clear");
            assert_eq!(g.res.score, 2, "terminal kill scores 2");
            assert_eq!(g.snapshot().wave, Some(0));
            for t in 1..=(lull + 2) {
                g.tick(Tick(t), &[]);
            }
            assert_eq!(g.snapshot().wave, Some(1), "wave 1 must have landed");
            assert_eq!(g.mobs.len(), 4, "wave 1 = 3 + idx blobs");
            // every entrant lands on the north half (z < 0), off the walls
            for &e in &g.mobs {
                let c = g.world.get::<&Goo>(e).unwrap().centroid();
                assert!(c.y < 0.5 && c.x.abs() < 9.0, "ring spawn out of bounds: {c:?}");
            }
            let mut h = Vec::new();
            for t in (lull + 3)..(lull + 120) {
                g.tick(Tick(t), &[]);
                h.push(g.state_hash());
            }
            h
        };
        assert_eq!(run(), run(), "wave landings must replay bit-exact");
    }

    #[test]
    fn uzi_hits_emit_bleed_droplet_events() {
        let spec = lone_large_spec();
        let mut g = HouseGame::new(&spec, VecSink::default());
        g.res.event_tap = Some(Vec::new());
        let e = g.mobs[0];
        let c = g.world.get::<&Goo>(e).unwrap().centroid();
        g.damage_goo(e, Vec3::new(c.x, 0.3, c.y), Vec3::Z, UZI.damage, 0.0, WeaponClass::Uzi);
        g.tick(Tick(0), &[]);
        let tap = g.res.event_tap.take().unwrap();
        assert!(tap.iter().any(|ev| matches!(ev, GameEvent::MobBled(..))), "{tap:?}");
        assert!(tap.iter().any(|ev| matches!(ev, GameEvent::MobHit(..))), "the hit still lands: {tap:?}");
    }

    #[test]
    fn weak_flag_trips_at_a_third_of_tier_hp() {
        // tier-0: 12 hp -> weak at hp <= 4 (the render shell's glitch gate)
        let spec = lone_large_spec();
        let mut g = HouseGame::new(&spec, VecSink::default());
        let e = g.mobs[0];
        let c = g.world.get::<&Goo>(e).unwrap().centroid();
        let hit = Vec3::new(c.x, 0.3, c.y);
        assert!(!g.snapshot().mobs[0].weak);
        g.damage_goo(e, hit, Vec3::Z, 7, 0.0, WeaponClass::Standard); // hp 5
        assert!(!g.snapshot().mobs[0].weak, "hp 5 of 12 is not weak yet");
        g.damage_goo(e, hit, Vec3::Z, 1, 0.0, WeaponClass::Standard); // hp 4
        assert!(g.snapshot().mobs[0].weak, "hp 4 of 12 is weak");
    }

    #[test]
    fn kill_scoring_is_arena_only() {
        // the same terminal kill on a NON-arena level must not move score
        let spec = lone_large_spec(); // goopair base: no arena
        let mut g = HouseGame::new(&spec, VecSink::default());
        let e = g.mobs[0];
        let c = g.world.get::<&Goo>(e).unwrap().centroid();
        g.damage_goo(e, Vec3::new(c.x, 0.3, c.y), Vec3::Z, 99, 0.0, WeaponClass::Standard);
        g.tick(Tick(0), &[]);
        assert_eq!(g.res.score, 0, "score is gated on the arsenal");
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
        d.run(10); // the first slug flies to the Large and wounds it
        assert_eq!(d.mob_count(), before, "first shot only wounds the Large");
        assert!(d.g.sink.0.iter().any(|q| q.id.0 == "goo_hit"), "first shot registered a hit");
        let c = d.centroid_of(MobId(3)).expect("still alive after one shot");
        d.run(8); // clear the 15-tick cooldown before the second shot
        d.shoot_at(c);
        d.run(12); // the second slug flies + the despawn/spawn flush + rebuild land
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
    fn second_projectile_on_a_dead_blob_same_tick_is_a_no_op() {
        // Two projectiles can strike the SAME blob in one tick — the despawn
        // only lands at the flush, so the corpse is still in `self.mobs` for
        // the second impact. The hp-0 dead-guard must make that second hit a
        // no-op; without it the blob died twice (a duplicate despawn, FOUR
        // children, doubled split events).
        let mut d = GooDrv::new();
        let before = d.mob_count();
        let e = *d.g.mobs.iter().find(|&&e| d.g.world.get::<&Goo>(e).unwrap().id == MobId(3)).unwrap();
        let c = d.centroid_of(MobId(3)).unwrap();
        let hit = Vec3::new(c.x, 0.3, c.y);
        // kill the Large outright, then hit the corpse again the SAME tick
        d.g.damage_goo(e, hit, Vec3::X, 12, 0.6, WeaponClass::Standard);
        d.g.damage_goo(e, hit, Vec3::X, 12, 0.6, WeaponClass::Standard);
        d.run(2); // flush + rebuild + audio drain
        assert!(d.centroid_of(MobId(3)).is_none(), "the Large is dead");
        assert_eq!(d.mob_count(), before + 1, "exactly one split: two children replace the parent");
        assert_eq!(d.world_goo_count(), d.mob_count(), "handle list matches the World");
        let splits = d.g.sink.0.iter().filter(|q| q.id.0 == "goo_split").count();
        assert_eq!(splits, 1, "one split cue, not two");
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
            MobSpec { id: MobId(0), tier: 1, kind: crate::spec::GooKind::Green, pos: Vec3::new(4.0, 0.0, 3.0) },
            MobSpec { id: MobId(1), tier: 1, kind: crate::spec::GooKind::Green, pos: Vec3::new(4.4, 0.0, 3.0) },
        ];
        spec.traps = vec![TrapSpec { id: 0, pos: Vec3::new(4.2, 0.0, 3.0), strength: 2.0, radius: 3.0, off_tick: 0 }];
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
    fn goo_overlapping_bodies_push_apart_not_through() {
        use crate::spec::MobSpec;
        // two Larges (tier 0 — NEVER merge-compatible) dropped superimposed in
        // the open centre of room E must separate: the blob–blob contact
        // repulsion pushes the bodies apart, where the old blind per-blob PBF
        // left them crawling through each other (and the render's global smin
        // union welded the pair into one lump). The player is parked across
        // the house (no seek, no pillar) and the run stays under the first
        // mitosis bud (~tick 100) so the scene is exactly the pair.
        let mut spec = goo_level();
        spec.mobs = vec![
            MobSpec { id: MobId(0), tier: 0, kind: crate::spec::GooKind::Green, pos: Vec3::new(9.5, 0.0, 5.5) },
            MobSpec { id: MobId(1), tier: 0, kind: crate::spec::GooKind::Green, pos: Vec3::new(9.8, 0.0, 5.5) },
        ];
        spec.traps = vec![];
        spec.player_start = Vec3::new(1.5, 0.0, 1.5);
        let g = run_ticks(&spec, 90);
        assert_eq!(g.mobs.len(), 2, "tier-0 pairs never merge");
        let a = g.world.get::<&Goo>(g.mobs[0]).unwrap().centroid();
        let b = g.world.get::<&Goo>(g.mobs[1]).unwrap().centroid();
        let d = (a - b).length();
        assert!(d > 0.8, "overlapping bodies failed to push apart: centroids {d:.3} wu apart");
    }

    #[test]
    fn goo_merge_round_trip_is_deterministic() {
        // fusion draws RNG + despawns via the command buffer — it must replay
        // bit-identically across two worlds.
        let run = || run_ticks(&merge_pair_level(), 90);
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
        spec.mobs = vec![MobSpec { id: MobId(0), tier: 0, kind: crate::spec::GooKind::Green, pos: Vec3::new(0.8, 0.0, 2.0) }];
        spec.traps = vec![];
        let g = run_ticks(&spec, 150);
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

    // Goo-sim determinism oracle. // Golden anchor: must not change.
    //
    // The goo goldens (house/lab/grid/game/game_replay) are all MOB-FREE, so the
    // goo sim's float results are NOT exercised by any image golden, and the
    // round-trip tests above only compare new-vs-new (they catch non-determinism,
    // not a float REORDER that is consistently wrong). These pinned hashes are
    // the real guard: any change that perturbs the goo sim's float evaluation
    // order moves a hash and fails here. Each scenario exercises a distinct slice
    // of `goo_system`:
    //   goo_level@300  — crawl/gait/AI/PBF + tier-0 mitosis (budding, mother
    //                    gravity, tether, wobble) across a full spawn period.
    //   goonursery@400 — the pure mitosis showcase (single tier-0 mother).
    //   split@trace    — `damage_goo` shot-driven split cascade.
    //   merge@90       — `merge_system` fusing-collapse + survivor promotion.
    // If a hash changes from an INTENTIONAL behaviour change, re-capture and
    // explain why in the commit; if it changes from a refactor, the refactor
    // reordered floats and must be reverted.
    // Re-captured 2026-07-02 (second pass): the gait `gather` envelope is now
    // seam-free (the smoothstep release/rise replaces two per-cycle force
    // steps — every blob every tick, so ALL FOUR moved), and blob–blob contact
    // repulsion landed (goo_overlapping_bodies_push_apart_not_through pins the
    // behaviour). The nursery hash is byte-identical under different repulsion
    // tunings — the tether opt-out + the mini clearing the contact skin before
    // the snap mean repulsion never fires there, so the birth choreography is
    // pinned unperturbed; its movement is the gait smoothing alone.
    // (First pass earlier today: tail-anchor collide_and_slide + damage_goo
    // dead-guard/pending-cap — see the commit introducing them.)
    // Re-captured 2026-07-03: the arena-species block (GooKind + cure +
    // harpoon pin) appended five fields to the per-blob hash fold — HASH BYTES
    // ONLY. Behavior on these all-Green levels is bit-identical by
    // construction: Green multipliers are exact ×1.0 IEEE identities, cure/
    // pinned default 0 (their branches never run), and the pin spring adds
    // Vec2::ZERO through the mother-well channel. All new Goo fields were
    // deliberately batched into this ONE recapture (see docs/goo-mob-handoff).
    const ORACLE_GOO_LEVEL_300: u64 = 0x5644a8cc5c2f849c;
    const ORACLE_GOONURSERY_400: u64 = 0x101f8d4981288431;
    const ORACLE_SPLIT_TRACE: u64 = 0x0d970347abdd933b;
    const ORACLE_MERGE_90: u64 = 0xb0f0b86bcd448008;

    #[test]
    fn goo_sim_hash_oracle_crawl_and_mitosis() {
        let mut a = GooDrv::new();
        a.run(300);
        assert_eq!(a.g.state_hash(), ORACLE_GOO_LEVEL_300, "got {:#018x}", a.g.state_hash());
    }

    #[test]
    fn goo_sim_hash_oracle_nursery() {
        let n = run_ticks(&crate::spec::goonursery_level(), 400);
        assert_eq!(n.state_hash(), ORACLE_GOONURSERY_400, "got {:#018x}", n.state_hash());
    }

    #[test]
    fn goo_sim_hash_oracle_split() {
        let mut s = GooDrv::new();
        for _ in 0..6 {
            s.shoot_at(Vec2::new(9.5, 4.8));
            s.run(16);
        }
        s.run(40);
        assert_eq!(s.g.state_hash(), ORACLE_SPLIT_TRACE, "got {:#018x}", s.g.state_hash());
    }

    #[test]
    fn goo_sim_hash_oracle_merge() {
        let m = run_ticks(&merge_pair_level(), 90);
        assert_eq!(m.state_hash(), ORACLE_MERGE_90, "got {:#018x}", m.state_hash());
    }
}
