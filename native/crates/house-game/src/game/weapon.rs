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
};

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
}

/// The first thing a projectile's swept path meets this tick (carries the world
/// impact point so the effect lands where the slug actually struck).
#[derive(Clone, Copy)]
enum ProjImpact {
    Target(Entity, TargetId, Vec3),
    Goo(Entity, Vec3),
    Solid, // wall / door / floor — the slug just stops (no effect but despawn)
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
    /// 4. Cooldown-gated FIRING: each trigger pull spawns the weapon's pellets as
    /// physical [`Projectile`]s on the aim ray, starting at the muzzle-forward
    /// point (so shots behind the player never spawn). The projectiles then fly
    /// and resolve their own hits in `projectile_system` — this system only
    /// births them. No-op (byte-identical) on a tick with no shot intents.
    pub(crate) fn shoot_system(&mut self) {
        self.res.muzzle_ticks = self.res.muzzle_ticks.saturating_sub(1);
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
        let w = PISTOL;
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
            // birth the slug ON the aim ray, at the point level with the muzzle —
            // so its flat flight path is exactly the old hitscan line (the same
            // target/blob it would have hit, just reached over time).
            let t_start = (muzzle - ray.origin).dot(ray.dir).max(0.0);
            let spawn = ray.origin + ray.dir * t_start;
            for k in 0..w.pellets {
                let d = pellet_dir(ray.dir, k, w.pellets, w.spread);
                let id = ProjectileId(self.res.next_projectile_id);
                self.res.next_projectile_id += 1;
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
            // 2) goo blobs (swept contact sphere)
            for &me in &self.mobs {
                let g = self.world.get::<&Goo>(me).unwrap();
                if g.fusing > 0 {
                    continue;
                }
                let c2 = g.centroid();
                let r = goo_tier_radius(g.tier);
                let center = Vec3::new(c2.x, r, c2.y);
                if let Some(t) = ray_sphere(&ray, center, r + g.body_len * 0.7 + p.radius) {
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
                    hit.consider(tmin + WALL_BIAS, ProjImpact::Solid);
                }
            }
            // 4) the floor plane (y = 0), only while descending
            if p.vel.y < 0.0 && new.y <= 0.0 && old.y > 0.0 {
                let frac = old.y / (old.y - new.y);
                hit.consider(seg_len * frac + WALL_BIAS, ProjImpact::Solid);
            }

            if let Some((_, what)) = hit.best {
                match what {
                    ProjImpact::Target(te, id, q) => {
                        self.world.get::<&mut Target>(te).unwrap().hits += 1;
                        self.res.score += 1;
                        self.res.events.emit(GameEvent::TargetHit(id, q));
                    }
                    ProjImpact::Goo(me, q) => self.damage_goo(me, q, dir, p.damage, p.knockback),
                    ProjImpact::Solid => {}
                }
                self.res.buf.despawn(e);
                self.res.projectiles_dirty = true;
                continue;
            }
            // no hit: advance, age, retire on range cap or once it leaves the floor
            p.pos = new;
            p.age += 1;
            let oob = new.x < floor[0] - 1.0 || new.z < floor[1] - 1.0 || new.x > floor[2] + 1.0 || new.z > floor[3] + 1.0;
            if p.age >= p.max_age || oob {
                self.res.buf.despawn(e);
                self.res.projectiles_dirty = true;
            } else {
                *self.world.get::<&mut Projectile>(e).unwrap() = p;
            }
        }
    }
}
