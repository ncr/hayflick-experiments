//! Weapon/projectile sim (split out of `game.rs`): the data-driven `WeaponSpec`,
//! the physically-simulated `Projectile`, the swept-collision `projectile_system`
//! and the cooldown-gated `shoot_system`. Child module of `game`, so the methods
//! reach `Res`'s private fields directly. Pure relocation — behavior unchanged.
use super::*;
use crate::flashlight_pose;
use crate::spec::{ProjectileId, TargetId};
use glam::Vec3;
use sim_core::{AudioSink, Entity};

/// A data-driven weapon. Firing spawns `pellets` physical [`Projectile`]s along
/// the aim ray; each travels under `gravity`, sweeps for collisions every tick,
/// and deals `damage` (+ `knockback` momentum into goo) on impact. New weapons
/// are just new `WeaponSpec` values — no new code path. All fields are exact
/// f32/int so the sim stays deterministic & hashable.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WeaponSpec {
    /// Initial speed (wu/s) imparted along the aim direction.
    pub muzzle_speed: f32,
    /// Downward acceleration (wu/s²). 0 = flat laser; >0 = ballistic arc.
    pub gravity: f32,
    /// Projectile collision radius (wu) — the swept contact sphere.
    pub radius: f32,
    /// HP removed from a goo blob per hit (a target disc always counts as 1).
    pub damage: u16,
    /// Momentum (wu/s) punched into the goo fluid at the impact point.
    pub knockback: f32,
    /// Ticks a projectile lives before it expires (range cap).
    pub max_age: u16,
    /// Shots per trigger pull (1 = single; >1 = a spread of pellets).
    pub pellets: u8,
    /// Cone half-angle (rad) the pellets fan over (ignored when `pellets == 1`).
    pub spread: f32,
    /// Per-shot aim wobble cone (rad), applied on top of the pellet fan via the
    /// deterministic [`shot_jitter`] scramble. Standing quarters it (0.25×),
    /// moving pays it in full — the skill knob that rewards planted feet.
    /// 0 = perfectly true (the pistol and the slug stay skill-pure).
    pub bloom: f32,
    /// Velocity kept after a wall/floor bounce (0 = the shot just stops and
    /// despawns — every non-grenade). >0 turns solids into cushions: the
    /// velocity reflects about the surface normal and scales by this.
    pub restitution: f32,
    /// Blast radius (wu). 0 = point impact. >0: the shot DETONATES — on goo
    /// contact or when its fuse (`max_age`) runs out — damaging every blob
    /// whose body edge is within the radius, with linear falloff.
    pub aoe_radius: f32,
    /// Damage typing for per-blob-kind multipliers and on-hit payloads
    /// (cure/pin) — the later milestones key off this, ballistics don't.
    pub class: WeaponClass,
    /// Ticks between trigger pulls; extra Shoot commands inside are swallowed.
    pub cooldown_ticks: u32,
}

/// What KIND of hit a projectile delivers (damage typing), independent of its
/// ballistics. `Standard` is the legacy pistol — every blob treats it as ×1.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum WeaponClass {
    Standard,
    Slug,
    Uzi,
    Shotgun,
    Grenade,
    Harpoon,
}

/// The starter sidearm: a single fast flat slug that one-shots a Medium blob.
pub const PISTOL: WeaponSpec = WeaponSpec {
    muzzle_speed: 26.0,
    gravity: 0.0,
    radius: 0.06,
    damage: GOO_DAMAGE,
    knockback: 2.4,
    max_age: 120,
    pellets: 1,
    spread: 0.0,
    bloom: 0.0,
    restitution: 0.0,
    aoe_radius: 0.0,
    class: WeaponClass::Standard,
    cooldown_ticks: PISTOL_COOLDOWN_TICKS,
};

/// Slot 1 — the RIVET slug gun: slow trigger, a fat SLOW round (12 wu/s vs the
/// pistol's 26 — you LEAD a crawling blob or you miss) and a brutal fluid
/// punch. Zero bloom: where you aim is where it flies. Each hit adds a CURE
/// stack (slows + stiffens); a body that dies with ≥GOO_CURE_CHUNK stacks
/// SOLIDIFIES into a dead chunk instead of splitting free. Damage 4 on
/// purpose: a Large takes three committed slugs (4+4+4 = 12 hp) and dies
/// exactly at the chunk threshold — the weapon is a plan, not a delete key.
pub const SLUG: WeaponSpec = WeaponSpec {
    muzzle_speed: 12.0,
    gravity: 0.0,
    radius: 0.12,
    damage: 4,
    knockback: 8.0,
    max_age: 180,
    pellets: 1,
    spread: 0.0,
    bloom: 0.0,
    restitution: 0.0,
    aoe_radius: 0.0,
    class: WeaponClass::Slug,
    cooldown_ticks: 45,
};

/// Slot 2 — the STITCHER uzi: 12 rounds/s of fast pinpricks. Each does almost
/// nothing (2 hp, a nudge of knockback) — the weapon is sustained TRACKING, and
/// the bloom cone makes run-and-gun spray wide while planted bursts stay tight.
pub const UZI: WeaponSpec = WeaponSpec {
    muzzle_speed: 30.0,
    gravity: 0.0,
    radius: 0.03,
    damage: 2,
    knockback: 0.6,
    max_age: 120,
    pellets: 1,
    spread: 0.0,
    bloom: 0.055,
    restitution: 0.0,
    aoe_radius: 0.0,
    class: WeaponClass::Uzi,
    cooldown_ticks: 5,
};

/// Slot 3 — the SHOTGUN: seven pellets over a wide fan, hard knockback per
/// pellet (a point-blank volley visibly SPLASHES the fluid), and a short fuse
/// (max_age caps reach at ~7 wu — a panic tool, not a rifle).
pub const SHOTGUN: WeaponSpec = WeaponSpec {
    muzzle_speed: 22.0,
    gravity: 0.0,
    radius: 0.05,
    damage: 2,
    knockback: 5.0,
    max_age: 20,
    pellets: 7,
    spread: 0.22,
    bloom: 0.02,
    restitution: 0.0,
    aoe_radius: 0.0,
    class: WeaponClass::Shotgun,
    cooldown_ticks: 35,
};

/// Slot 4 — the GRENADE: a slow lobbed ball under real gravity that BOUNCES
/// off walls and floor (restitution 0.5 — bank it around the arena) and
/// detonates on blob contact or when the ~1.5 s fuse runs out: a 1.6 wu blast
/// with linear falloff that shoves every body near it. The one weapon whose
/// skill is geometry, not tracking.
pub const GRENADE: WeaponSpec = WeaponSpec {
    muzzle_speed: 10.0,
    gravity: 9.0,
    radius: 0.09,
    damage: 8,
    knockback: 6.0,
    max_age: 90,
    pellets: 1,
    spread: 0.0,
    bloom: 0.0,
    restitution: 0.5,
    aoe_radius: 1.6,
    class: WeaponClass::Grenade,
    cooldown_ticks: 50,
};

/// Slot 5 — the HARPOON: a fast true dart that barely hurts but NAILS the hit
/// blob to the floor for ~4 s (`GOO_PIN_TICKS`): its drive is cut and a stiff
/// spring holds its body at the pin point — line up the slug on something
/// that can't dodge. The utility weapon.
pub const HARPOON: WeaponSpec = WeaponSpec {
    muzzle_speed: 34.0,
    gravity: 0.0,
    radius: 0.05,
    damage: 1,
    knockback: 0.5,
    max_age: 90,
    pellets: 1,
    spread: 0.0,
    bloom: 0.0,
    restitution: 0.0,
    aoe_radius: 0.0,
    class: WeaponClass::Harpoon,
    cooldown_ticks: 40,
};

/// Ticks the explosion flash spotlight stays lit (longer than the 2-tick
/// muzzle blink — a detonation lingers).
pub const BOOM_FLASH_TICKS: u32 = 6;

/// The five arena weapon slots (keys 1–5). Selection state, not ballistics:
/// each kind maps to a [`WeaponSpec`] in [`HouseGame::current_weapon`].
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum WeaponKind {
    Slug,
    Uzi,
    Shotgun,
    Grenade,
    Harpoon,
}

impl WeaponKind {
    /// Slot key (1–5) → kind. `None` for out-of-range slots (swallowed).
    pub fn from_slot(slot: u8) -> Option<WeaponKind> {
        match slot {
            1 => Some(WeaponKind::Slug),
            2 => Some(WeaponKind::Uzi),
            3 => Some(WeaponKind::Shotgun),
            4 => Some(WeaponKind::Grenade),
            5 => Some(WeaponKind::Harpoon),
            _ => None,
        }
    }

    /// The 1-based arsenal slot this kind sits in (inverse of `from_slot`).
    pub fn slot(self) -> u8 {
        match self {
            WeaponKind::Slug => 1,
            WeaponKind::Uzi => 2,
            WeaponKind::Shotgun => 3,
            WeaponKind::Grenade => 4,
            WeaponKind::Harpoon => 5,
        }
    }

    /// Short HUD label (fits the corner plate at 8 px/char).
    pub fn name(self) -> &'static str {
        match self {
            WeaponKind::Slug => "SLUG",
            WeaponKind::Uzi => "UZI",
            WeaponKind::Shotgun => "SHOT",
            WeaponKind::Grenade => "GREN",
            WeaponKind::Harpoon => "HARP",
        }
    }

    /// Stable hash tag (enum discriminants are not order-stable; pin them).
    pub(crate) fn tag(self) -> u64 {
        self.slot() as u64
    }
}

/// Arsenal state for arena levels (`spec.arena.is_some()`): which weapon slot
/// is selected. Lives in `Res` (the survival-block pattern) and folds into
/// `state_hash` only when present, so non-arena levels hash exactly as before.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct ArsenalState {
    pub current: WeaponKind,
}

impl Default for ArsenalState {
    fn default() -> ArsenalState {
        ArsenalState { current: WeaponKind::Slug }
    }
}

/// Render radius (wu) of the glowing projectile tracer sphere.
pub const PROJ_RENDER_RADIUS: f32 = 0.14;

/// A live, physically-simulated shot. Integrated each tick by `projectile_system`
/// (gravity → position → swept collision). Self-contained: it carries the impact
/// params copied from its [`WeaponSpec`] at fire time, so the system never needs
/// to look the weapon back up. Folded into `state_hash`/`snapshot` while alive.
#[derive(Clone, Copy, Debug)]
pub struct Projectile {
    pub id: ProjectileId,
    pub pos: Vec3,
    pub vel: Vec3,
    pub age: u16,
    pub radius: f32,
    pub damage: u16,
    pub knockback: f32,
    pub gravity: f32,
    pub max_age: u16,
    // ---- immutable-after-spawn payload params (NOT folded into state_hash:
    // the hashed pos/vel/age already pin the trajectory, and these are a pure
    // function of the firing WeaponSpec, itself pinned by the hashed arsenal
    // selection + command stream)
    pub class: WeaponClass,
    pub restitution: f32,
    pub aoe_radius: f32,
}

/// The first thing a projectile's swept path meets this tick (carries the world
/// impact point so the effect lands where the slug actually struck).
#[derive(Clone, Copy)]
enum ProjImpact {
    Target(Entity, TargetId, Vec3),
    Goo(Entity, Vec3),
    /// Wall / door / floor. A plain shot just stops (despawn); a bouncy one
    /// (restitution > 0) reflects about the carried surface normal.
    Solid { normal: Vec3 },
}

/// Bias (wu) added to a wall/floor candidate `t` so a target disc sitting ON its
/// own backing wall (a coincident `t`) is NOT pre-empted by that wall — only a
/// wall GENUINELY in front of the disc blocks. The wall-face-vs-disc tie rule.
const WALL_BIAS: f32 = 1e-3;

/// Accumulates the nearest impact along one projectile's swept segment this
/// tick. `consider` keeps the smallest in-range `t` under a STRICT `<` test, so
/// on an exact-`t` tie the FIRST candidate offered wins — the phase order
/// (targets → goo → walls → floor, and the per-loop iteration order within each)
/// is therefore the tie-break, which the [`WALL_BIAS`] rule leans on. The STORED
/// `t` is clamped to ≥0 (origin-inside case) while the COMPARISON reads the raw
/// incoming `t`; both are exactly as the original inline closure did, so the
/// chosen impact — and thus the state hash — is unchanged.
struct NearestHit {
    seg_len: f32,
    best: Option<(f32, ProjImpact)>,
}

impl NearestHit {
    fn new(seg_len: f32) -> NearestHit {
        NearestHit { seg_len, best: None }
    }

    fn consider(&mut self, t: f32, what: ProjImpact) {
        if t >= -1e-4 && t <= self.seg_len + 1e-4 && self.best.map_or(true, |(bt, _)| t < bt) {
            self.best = Some((t.max(0.0), what));
        }
    }
}

/// Deterministic aim wobble: deflect `base` inside a `cone` half-angle by a
/// scramble of the projectile id. Disc-uniform-ish (sqrt radius), direction
/// from the high hash bits so consecutive ids swing around the clock instead
/// of drifting one way. `cone <= 0` returns `base` BYTE-IDENTICAL — the
/// pistol path (and every old golden trace) never sees this function's math.
fn shot_jitter(base: Vec3, cone: f32, salt: u32) -> Vec3 {
    if cone <= 0.0 {
        return base;
    }
    // +1 before the multiply: salt 0 (the game's very first shot) must not
    // collapse to h = 0 == zero deflection
    let h = salt.wrapping_add(1).wrapping_mul(ID_HASH_STRIDE);
    let ang = (h >> 8) as f32 / 16_777_216.0 * std::f32::consts::TAU;
    let r = cone * ((h & 0xff) as f32 / 255.0).sqrt();
    let aux = if base.y.abs() < 0.9 { Vec3::Y } else { Vec3::X };
    let right = base.cross(aux).normalize_or_zero();
    let up = right.cross(base).normalize_or_zero();
    (base + right * (r * ang.cos()) + up * (r * ang.sin())).normalize_or_zero()
}

/// Direction for pellet `k` of `n` fired through `base`, fanned over a `spread`
/// cone via a deterministic golden-angle spiral (no RNG — replays bit-exact).
fn pellet_dir(base: Vec3, k: u8, n: u8, spread: f32) -> Vec3 {
    if n <= 1 || spread <= 0.0 {
        return base;
    }
    // orthonormal basis around the aim direction
    let aux = if base.y.abs() < 0.9 { Vec3::Y } else { Vec3::X };
    let right = base.cross(aux).normalize_or_zero();
    let up = right.cross(base).normalize_or_zero();
    // Vogel/golden-angle disc sampling, mapped onto the cone
    let ga = 2.399_963_2_f32; // 2π·(1 − 1/φ)
    let frac = (k as f32 + 0.5) / n as f32;
    let r = spread * frac.sqrt();
    let ang = ga * k as f32;
    (base + right * (r * ang.cos()) + up * (r * ang.sin())).normalize_or_zero()
}

/// Renderer-facing pose of one live projectile: a glowing tracer sphere. A pure
/// read of the hashed projectile state, ProjectileId-sorted. Empty when nothing
/// is in flight (so non-shooting frames carry no projectile draw data).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ProjectileRender {
    pub id: ProjectileId,
    pub pos: Vec3,
    pub radius: f32,
}

/// Outward normal of the AABB face a ray ENTERS through: the axis whose slab
/// entry parameter is the largest (the standard slab-test entry axis), signed
/// against the ray. Companion to `ray_aabb` — call with its hit confirmed.
fn aabb_entry_normal(ray: &PickRay, lo: Vec3, hi: Vec3) -> Vec3 {
    let (mut best_t, mut n) = (f32::MIN, Vec3::Y);
    for a in 0..3 {
        let d = ray.dir[a];
        if d.abs() < 1e-9 {
            continue;
        }
        let face = if d > 0.0 { lo[a] } else { hi[a] };
        let t = (face - ray.origin[a]) / d;
        if t > best_t {
            best_t = t;
            let mut v = Vec3::ZERO;
            v[a] = -d.signum();
            n = v;
        }
    }
    n
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

impl<S: AudioSink> HouseGame<S> {
    /// The WeaponSpec the player fires THIS tick: on arena levels the
    /// arsenal's selected slot maps to its real spec (slug, uzi, shotgun,
    /// grenade, harpoon); non-arena levels have no arsenal and always fire
    /// the plain PISTOL.
    pub fn current_weapon(&self) -> WeaponSpec {
        match self.res.arsenal {
            None => PISTOL,
            // the draft's picked cards mutate the base spec at read time
            // (pure data deltas — see game/draft.rs)
            Some(a) => apply_cards(
                match a.current {
                    WeaponKind::Slug => SLUG,
                    WeaponKind::Uzi => UZI,
                    WeaponKind::Shotgun => SHOTGUN,
                    WeaponKind::Grenade => GRENADE,
                    WeaponKind::Harpoon => HARPOON,
                },
                &self.res.picked,
            ),
        }
    }

    /// Cooldown-gated FIRING: each trigger pull spawns the weapon's pellets as
    /// physical [`Projectile`]s on the aim ray, starting at the muzzle-forward
    /// point (so shots behind the player never spawn). The projectiles then fly
    /// and resolve their own hits in `projectile_system` — this system only
    /// births them. No-op (byte-identical) on a tick with no shot intents.
    pub(crate) fn shoot_system(&mut self) {
        self.res.muzzle_ticks = self.res.muzzle_ticks.saturating_sub(1);
        // decay a live explosion flash (armed by `explode` LATER in the tick —
        // projectile_system runs after this — so a fresh boom always presents
        // at full intensity for its first frame)
        self.res.boom = self.res.boom.and_then(|(at, t)| (t > 1).then_some((at, t - 1)));
        {
            let mut pistol = self.world.get::<&mut Pistol>(self.player).unwrap();
            pistol.cooldown_ticks = pistol.cooldown_ticks.saturating_sub(1);
        }
        if self.res.staging.shot_intents.is_empty() {
            return;
        }
        let intents = std::mem::take(&mut self.res.staging.shot_intents);
        let pos = self.player_pos();
        let facing = self.player_facing();
        let (muzzle, _) = flashlight_pose(pos, facing); // hand height = muzzle height
        let w = self.current_weapon();
        // the bloom skill knob: run-and-gun pays the full wobble cone, planted
        // feet quarter it. Staging is never hashed, but the read lands in the
        // hashed projectile velocities via the command stream — deterministic.
        let moving = self.res.staging.move_dir != IVec2::ZERO || self.world.get::<&WalkTarget>(self.player).is_ok();
        let bloom = w.bloom * if moving { 1.0 } else { 0.25 };
        for ray in intents {
            {
                let mut pistol = self.world.get::<&mut Pistol>(self.player).unwrap();
                if pistol.cooldown_ticks > 0 {
                    continue; // swallowed: spam never queues
                }
                // the FIRING weapon's cooldown; switching mid-cooldown does not
                // reset the timer (the shared component is the anti-exploit)
                pistol.cooldown_ticks = w.cooldown_ticks;
            }
            self.res.muzzle_ticks = MUZZLE_FLASH_TICKS;
            self.res.events.emit(GameEvent::ShotFired(muzzle));
            // birth the slug ON the aim ray, at the point level with the muzzle —
            // so its flat flight path is exactly the old hitscan line (the same
            // target/blob it would have hit, just reached over time).
            let t_start = (muzzle - ray.origin).dot(ray.dir).max(0.0);
            let spawn = ray.origin + ray.dir * t_start;
            for k in 0..w.pellets {
                let id = ProjectileId(self.res.next_projectile_id);
                self.res.next_projectile_id += 1;
                // fan first (golden-angle spiral), then the per-pellet jitter —
                // each pellet salts with its OWN id, so a shotgun volley is a
                // fresh scatter every trigger pull, not a stamped pattern.
                let d = shot_jitter(pellet_dir(ray.dir, k, w.pellets, w.spread), bloom, id.0);
                self.res.buf.spawn((Projectile {
                    id,
                    pos: spawn,
                    vel: d * w.muzzle_speed,
                    age: 0,
                    radius: w.radius,
                    damage: w.damage,
                    knockback: w.knockback,
                    gravity: w.gravity,
                    max_age: w.max_age,
                    class: w.class,
                    restitution: w.restitution,
                    aoe_radius: w.aoe_radius,
                },));
            }
            self.res.projectiles_dirty = true;
        }
    }

    /// 4b. Advance every live projectile one fixed tick and resolve the FIRST
    /// thing its swept path hits this tick: a target disc (score), a goo blob
    /// (damage/split + knockback), or a wall / the floor / its range cap (just
    /// despawn). Deterministic: integrate (semi-implicit), then take the nearest
    /// impact parameter along the old→new segment. No-op when nothing is in
    /// flight, so non-shooting levels never enter it.
    pub(crate) fn projectile_system(&mut self) {
        if self.projectiles.is_empty() {
            return;
        }
        let dt = TICK_DT;
        let floor = self.res.level.floor;
        let handles = self.projectiles.clone(); // damage_goo mutates buffers, not this list
        for e in handles {
            let mut p = *self.world.get::<&Projectile>(e).unwrap();
            p.vel.y -= p.gravity * dt; // semi-implicit Euler
            let old = p.pos;
            let new = old + p.vel * dt;
            let seg = new - old;
            let seg_len = seg.length();
            // candidate impacts along the segment, parameterised by t ∈ [0, seg_len]
            let dir = if seg_len > 1e-6 { seg / seg_len } else { p.vel.normalize_or_zero() };
            let ray = PickRay { origin: old, dir };
            // 1) target discs
            let mut hit = NearestHit::new(seg_len);
            for &te in &self.targets {
                let disc = self.world.get::<&TargetDisc>(te).unwrap();
                let denom = dir.dot(disc.normal);
                if denom.abs() < 1e-6 {
                    continue;
                }
                let t = (disc.center - old).dot(disc.normal) / denom;
                if t < -1e-4 || t > seg_len + 1e-4 {
                    continue;
                }
                let q = old + dir * t;
                if (q - disc.center).length() <= disc.radius {
                    let id = self.world.get::<&Target>(te).unwrap().id;
                    hit.consider(t, ProjImpact::Target(te, id, q));
                }
            }
            // 2) goo blobs (swept contact sphere). A projectile whose tick
            // STARTS inside the sphere is already touching the body — contact
            // at t=0 (ray_sphere returns a negative entry there, which the
            // in-range gate rejects; before this rule a grenade could bounce
            // INTO a blob's contact sphere and coast through, never
            // detonating — real physics says it is embedded in goo).
            for &me in &self.mobs {
                let g = self.world.get::<&Goo>(me).unwrap();
                if g.fusing > 0 {
                    continue;
                }
                let c2 = g.centroid();
                let r = goo_tier_radius(g.tier);
                let center = Vec3::new(c2.x, r, c2.y);
                let contact = r + g.body_len * 0.7 + p.radius;
                if (old - center).length_squared() < contact * contact {
                    hit.consider(0.0, ProjImpact::Goo(me, old));
                } else if let Some(t) = ray_sphere(&ray, center, contact) {
                    let q = old + dir * t.max(0.0);
                    hit.consider(t, ProjImpact::Goo(me, q));
                }
            }
            // 3) walls / doors (occluder slabs, floor→WALL_H band). Each wall
            // candidate is biased back by WALL_BIAS (the wall-face-vs-disc tie
            // rule, see the const) so a disc on its own backing wall isn't
            // pre-empted — only a wall genuinely in front blocks.
            for s in self.res.static_occluders.iter().chain(self.res.dyn_solids.iter().map(|(_, s)| s)) {
                let lo = Vec3::new(s[0], 0.0, s[1]);
                let hi = Vec3::new(s[2], WALL_H, s[3]);
                if let Some((tmin, _)) = ray_aabb(&ray, lo, hi) {
                    hit.consider(tmin + WALL_BIAS, ProjImpact::Solid { normal: aabb_entry_normal(&ray, lo, hi) });
                }
            }
            // 3b) dead solid chunks — KNEE-HIGH slabs (GOO_CHUNK_H, not WALL_H):
            // a muzzle-height shot flies over a chunk; low slugs and grounded
            // grenades are stopped (and grenades bounce off the sides/top).
            for s in self.res.chunks.iter() {
                let lo = Vec3::new(s[0], 0.0, s[1]);
                let hi = Vec3::new(s[2], GOO_CHUNK_H, s[3]);
                if let Some((tmin, _)) = ray_aabb(&ray, lo, hi) {
                    hit.consider(tmin + WALL_BIAS, ProjImpact::Solid { normal: aabb_entry_normal(&ray, lo, hi) });
                }
            }
            // 4) the floor plane (y = 0), only while descending
            if p.vel.y < 0.0 && new.y <= 0.0 && old.y > 0.0 {
                let frac = old.y / (old.y - new.y);
                hit.consider(seg_len * frac + WALL_BIAS, ProjImpact::Solid { normal: Vec3::Y });
            }

            if let Some((t, what)) = hit.best {
                match what {
                    ProjImpact::Target(te, id, q) => {
                        self.world.get::<&mut Target>(te).unwrap().hits += 1;
                        self.res.score += 1;
                        self.res.events.emit(GameEvent::TargetHit(id, q));
                    }
                    ProjImpact::Goo(me, q) => {
                        if p.aoe_radius > 0.0 {
                            self.explode(q, &p); // contact detonation
                        } else {
                            self.damage_goo(me, q, dir, p.damage, p.knockback, p.class);
                        }
                    }
                    ProjImpact::Solid { normal } => {
                        if p.restitution > 0.0 {
                            // bounce: reflect about the face normal, bleed energy,
                            // re-seat just off the surface. The fuse keeps running —
                            // the shot stays alive, so DON'T fall through to despawn.
                            p.pos = old + dir * t + normal * 0.02;
                            p.vel = (p.vel - normal * (2.0 * p.vel.dot(normal))) * p.restitution;
                            p.age += 1;
                            if p.age >= p.max_age {
                                if p.aoe_radius > 0.0 {
                                    self.explode(p.pos, &p); // fuse ran out mid-bounce
                                }
                                self.res.buf.despawn(e);
                                self.res.projectiles_dirty = true;
                            } else {
                                *self.world.get::<&mut Projectile>(e).unwrap() = p;
                            }
                            continue;
                        }
                    }
                }
                self.res.buf.despawn(e);
                self.res.projectiles_dirty = true;
                continue;
            }
            // no hit: advance, age, retire on range cap (grenades: the FUSE —
            // they detonate where they lie) or once it leaves the floor
            p.pos = new;
            p.age += 1;
            let oob = new.x < floor[0] - 1.0 || new.z < floor[1] - 1.0 || new.x > floor[2] + 1.0 || new.z > floor[3] + 1.0;
            if p.age >= p.max_age || oob {
                if p.age >= p.max_age && p.aoe_radius > 0.0 {
                    self.explode(p.pos, &p);
                }
                self.res.buf.despawn(e);
                self.res.projectiles_dirty = true;
            } else {
                *self.world.get::<&mut Projectile>(e).unwrap() = p;
            }
        }
    }

    /// Detonate a blast at `at`: every live blob whose body EDGE is inside
    /// `aoe_radius` takes linear-falloff damage and a radial fluid shove.
    /// Iterates the MobId-sorted handle list (fixed order — deterministic);
    /// `damage_goo`'s dead-guard + pending-cap accounting make same-blast
    /// multi-kills safe. Arms the boom flash the renderer turns into light.
    fn explode(&mut self, at: Vec3, p: &Projectile) {
        self.res.boom = Some((at, BOOM_FLASH_TICKS));
        let targets = self.mobs.clone(); // damage_goo mutates buffers, not this list
        for me in targets {
            let (center, r) = {
                let g = self.world.get::<&Goo>(me).unwrap();
                if g.fusing > 0 {
                    continue;
                }
                let c2 = g.centroid();
                let r = goo_tier_radius(g.tier);
                (Vec3::new(c2.x, r, c2.y), r)
            };
            let d = center - at;
            let dist_edge = (d.length() - r).max(0.0);
            if dist_edge > p.aoe_radius {
                continue;
            }
            let falloff = 1.0 - dist_edge / p.aoe_radius;
            let dmg = ((p.damage as f32 * falloff) as u16).max(1);
            let dir = d.try_normalize().unwrap_or(Vec3::Y);
            // strike the near surface so the fluid shove is one-sided (the
            // whole body visibly rides away from the blast)
            let hit = at + dir * (d.length() - r).max(0.0);
            self.damage_goo(me, hit, dir, dmg, p.knockback * falloff, p.class);
        }
    }
}
