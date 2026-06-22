//! Goo-mob fluid sim (split out of `game.rs`): the Position-Based-Fluids blob
//! creatures — tuning constants + kernels, the `Goo` component, the crawl/AI
//! `goo_system`, trap pull, shot damage/split, and same-tier fusion. These are
//! `impl HouseGame` methods and free items in a CHILD module of `game`, so they
//! reach `Res`'s private fields with no visibility widening. Pure relocation —
//! the 7-system tick order, snapshot, and state_hash stay in `game.rs`.
use super::*;
use crate::collide_and_slide;
use crate::spec::MobId;
use glam::{Vec2, Vec3};
use sim_core::{AudioSink, Entity};

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
    pub(crate) fn tag(self) -> u64 {
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
pub(crate) fn fresh_goo(id: MobId, tier: u8, head: Vec2, heading: Vec2, seed_vel: Vec2, timer: u16) -> Goo {
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

impl<S: AudioSink> HouseGame<S> {
    /// Solidity the GOO sees: everything `walk_blocked` blocks PLUS the player's
    /// pillar footprint (inflated by the goo's surface clearance). The player
    /// itself never tests this — it walks freely through its own marker — so the
    /// fluid flows and drapes around the player while the player is unobstructed.
    pub(crate) fn goo_solid(&self, x: f32, z: f32) -> bool {
        if self.walk_blocked(x, z) {
            return true;
        }
        let p = self.player_pos();
        let m = PLAYER_HALF + GOO_COLLIDER_MARGIN;
        (x - p.x).abs() < m && (z - p.z).abs() < m
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
    pub(crate) fn goo_system(&mut self) {
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
    pub(crate) fn trap_accel(&self, p: Vec2) -> Vec2 {
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

    /// Apply one projectile impact to a goo blob at world point `hit`, travelling
    /// `dir` (XZ heading of the slug). Deducts `damage` HP and punches `knockback`
    /// momentum into the fluid LOCALISED at the entry wound (strongest at `hit`,
    /// falling off across the body) — a directional splat, not a uniform shove.
    /// On death the blob splits into two smaller ones (one tier down, separated
    /// perpendicular to the slug), or — Small / over-cap — dies terminally. All
    /// spawns/despawns queue on the per-tick buffer (post-flush `rebuild_mobs`).
    pub(crate) fn damage_goo(&mut self, e: Entity, hit: Vec3, dir: Vec3, damage: u16, knockback: f32) {
        let (id, tier, centroid) = {
            let g = self.world.get::<&Goo>(e).unwrap();
            (g.id, g.tier, g.centroid())
        };
        let kdir = Vec2::new(dir.x, dir.z).normalize_or_zero();
        let hit_xz = Vec2::new(hit.x, hit.z);
        let reach = goo_tier_radius(tier).max(0.2);
        let dead = {
            let mut g = self.world.get::<&mut Goo>(e).unwrap();
            g.hp = g.hp.saturating_sub(damage);
            // momentum transfer: push the fluid along the slug's heading, weighted
            // by closeness to the impact point so the hit side caves/sprays.
            g.ends_prev[0] -= kdir * (0.05 * knockback);
            for i in 0..GOO_PARTICLES {
                let w = (1.0 - (g.parts[i] - hit_xz).length() / reach).clamp(0.0, 1.0);
                g.vel[i] += kdir * (knockback * w);
            }
            g.hp == 0
        };
        let hit_evt = Vec3::new(centroid.x, goo_tier_radius(tier), centroid.y);
        if !dead {
            self.res.events.emit(GameEvent::MobHit(id, hit_evt));
            return;
        }
        // death — remove the parent at the flush
        self.res.buf.despawn(e);
        self.res.mobs_dirty = true;
        // Small is terminal; an over-cap split also degrades to a plain kill so
        // division can never outrun the renderer's instance pool.
        let live_after_split = self.mobs.len() - 1 + 2;
        if tier >= 2 || live_after_split > GOO_LIVE_CAP {
            self.res.events.emit(GameEvent::MobKilled(id, hit_evt));
            return;
        }
        // split: two children one tier down, separated along the axis
        // perpendicular to the slug heading ("split along the bullet")
        let mut perp = Vec2::new(-kdir.y, kdir.x).normalize_or_zero();
        if perp.length_squared() < 1e-6 {
            perp = Vec2::X; // dead-vertical impact: pick a stable split axis
        }
        let parent_r = goo_tier_radius(tier);
        let sep = parent_r * 0.6;
        for s in [-1.0f32, 1.0] {
            let cid = MobId(self.res.next_mob_id);
            self.res.next_mob_id += 1;
            let d = (perp * s).normalize_or_zero();
            let chead = centroid + d * sep;
            let vel = d * (parent_r * 0.05); // outward separation, baked into prev
            let timer = 20 + (self.res.rng.next_f32() * 60.0) as u16;
            self.res.buf.spawn((fresh_goo(cid, tier + 1, chead, d, vel, timer),));
        }
        self.res.events.emit(GameEvent::MobSplit(id, hit_evt));
    }

    /// Blob fusion — the inverse of the shot-split. Two LIVE blobs of the SAME
    /// tier (≥ 1, so the result can grow toward Large) whose bodies overlap fuse
    /// into one a tier larger. Deterministic: scan the MobId-sorted handle list,
    /// take the FIRST overlapping pair, keep the LOWER id (regrown one tier up at
    /// the fusion midpoint), queue the higher id for despawn, and drop it from
    /// the live handle list so a same-tick shot can't double-despawn it. One
    /// fusion per tick; the post-flush `rebuild_mobs` lands it. No-op below two
    /// blobs (so mob-free / lone-blob levels never enter this path).
    pub(crate) fn merge_system(&mut self) {
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
}
