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
pub const GOO_VERLET_DECAY: f32 = 0.82;
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
/// Lowered (from 1.2) so the body sways side-to-side as it crawls — a low-freq,
/// jelly-like jiggle. Not pushed all the way down: too little lateral damping
/// reads as a glitchy buzz rather than an organic wobble.
pub const GOO_LATERAL: f32 = 0.8;
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

// ---- mitosis: a Large mother spontaneously buds off mini goos --------------
/// Ticks between a Large (tier-0) mother budding off a mini goo (~3.3 s @ 60).
/// Each tier-0 blob runs its own `spawn_timer` countdown (id-desynced so two
/// mothers never bud in lockstep). Over-cap births are skipped (timer resets).
pub const GOO_SPAWN_PERIOD: u16 = 200;
/// The trailing slice of the spawn cycle is GESTATION: the bud site swells with
/// a colour signal that ramps 0→1 as the birth nears. ~1 s.
pub const GOO_GESTATE_TICKS: u16 = 60;
/// After the birth the bud colour does NOT snap off: it holds for `GOO_BIRTH_HOLD`
/// ticks while the mini peels away, then eases smoothly back to the normal green
/// over the remainder of `GOO_BIRTH_FADE` — a gentle revert, not an abrupt cut.
pub const GOO_BIRTH_FADE: u16 = 90;
pub const GOO_BIRTH_HOLD: u16 = 24;
/// Tier a budded mini is born at (2 = Small — a clearly tiny offspring).
pub const GOO_BIRTH_TIER: u8 = 2;
/// A newborn starts as a small DROPLET embedded in the mother's body at the bud
/// site (this fraction of its eventual body_len), then inflates via the gait's
/// body_len ease while crawling clear — emerging as a piece of her, the reverse
/// of a fusion collapse, rather than popping into existence fully formed.
pub const GOO_BIRTH_SEED: f32 = 0.18;
/// Gentle outward per-tick displacement baked into a newborn so it oozes off the
/// mother's surface rather than popping — the crawl AI then carries it clear.
pub const GOO_BIRTH_SPEED: f32 = 0.02;
/// Birth EFFORT: through the final push the mother tenses — she clenches toward
/// a rounder, tighter ball and all but stops crawling — then relaxes over the
/// afterglow. `PULL` is the extra capsule-cohesion fraction at peak tension (she
/// pulls herself together harder); `CLENCH` is how much shorter her spine draws
/// (rounder/contracted). Both ease in over gestation and back out after birth.
pub const GOO_TENSE_PULL: f32 = 0.55;
pub const GOO_TENSE_CLENCH: f32 = 0.28;
/// Centripetal SQUEEZE (wu/s² per wu) at peak tension: pulls every particle in
/// toward the centroid so the fluid promptly follows the shrinking footprint.
pub const GOO_TENSE_SQUEEZE: f32 = 8.0;
/// How much smaller (fraction) the WHOLE body draws at peak tension — both the
/// fluid rest-footprint (via the smoothing radius) AND the rendered size shrink
/// by this together, so she visibly balls up into a tight knot for the push and
/// swells back out as it releases. This is THE readable contraction.
pub const GOO_TENSE_SHRINK: f32 = 0.34;

// ---- birth TETHER: the mini is TORN off, not popped off ---------------------
// After birth the newborn stays BONDED to a frozen bud-site anchor by a yielding
// spring while its crawl AI hauls its head clear: the body lags, so the render's
// single smin metaball union (which fuses any blob surfaces within ~k) draws a
// real, thinning NECK between mother and mini. The bond lives a fixed
// `GOO_TETHER_TICKS`; mother and mini are armed on the SAME tick and count down
// in lockstep, so the SNAP (and the jelly wobble both then fire) lands on the
// SAME tick on both bodies with zero cross-entity coupling — fully deterministic.
/// Bond lifetime in ticks (~0.67 s @ 60). The neck stretches over this, then snaps.
pub const GOO_TETHER_TICKS: u16 = 40;
/// Spring accel (wu/s²) pulling the newborn's particles back to the bud site at
/// zero stretch. Below GOO_END_PULL (11) so the PBF solver stays in its regime.
pub const GOO_TETHER_PULL: f32 = 9.0;
/// Slack length (wu, ×g_scale) before the spring engages — the bud sits just
/// under the surface, so a hair of separation is free.
pub const GOO_TETHER_REST: f32 = 0.10;
/// Over-stretch (wu) at which the spring has fully YIELDED to zero — past this the
/// neck has thinned to nothing and the body drifts on its crawl until the timeout
/// fires the snap. A touch over the render smin k (0.14) so the visual waist
/// pinches as the spring lets go.
pub const GOO_TETHER_SNAP: f32 = 0.22;

// ---- jelly WOBBLE: the snap-back + ring-down (and shot-impact jiggle) --------
// A single decaying oscillator per blob (amplitude + axis + integer phase). When
// the bond snaps it is armed on BOTH bodies: the mother's tear-site sucks INWARD
// and her whole body rings; the mini lurches OUT and rings too. It drives a soft
// additive spine-length flex in the SIM (real motion, but the incompressible
// fluid low-pass-filters most of it) and — the readable part — an anisotropic
// squash of the metaball cloud in the SNAPSHOT (render-only, where the fluid
// itself cannot deform fast enough). Coherent and low-frequency, never buzz.
/// Initial wobble amplitude armed at the snap.
pub const GOO_WOBBLE_AMP0: f32 = 1.0;
/// The mother rings a little less than the mini (more mass / inertia).
pub const GOO_MOTHER_WOBBLE_FRAC: f32 = 0.85;
/// Geometric ring-down per tick: 0.955^66 ≈ 0.045 → ~4 visible swings over ~1.1 s.
/// Slow enough that the jelly keeps quivering for a beat after the snap, not a
/// single twitch — the render squash carries it (it isn't fluid-filtered).
pub const GOO_WOBBLE_DECAY: f32 = 0.955;
/// Wobble angular rate (rad/tick): period ~15.7 ticks (~3.8 Hz) — a gelatinous
/// jiggle. (The render squash reads this sinusoid directly and so is NOT subject
/// to the fluid's low-pass filtering that mutes the physical spine wobble.)
pub const GOO_WOBBLE_OMEGA: f32 = 0.40;
/// Phase offset (≈round(π/OMEGA)) that flips the FIRST half-swing: armed at this
/// the body starts INWARD (the mother's tear-site suck-back); armed at 0 it
/// starts OUTWARD (the mini's released-spring lurch).
pub const GOO_WOBBLE_HALF: u16 = 8;
/// Spine-length wobble: the wobble oscillates the live spine length by this
/// fraction, an ADDITIVE delta on gait_len. This is the PHYSICAL half of the
/// jiggle — real particle motion — but the incompressible cloud low-pass-filters
/// most of it (it can't track a fast shape change), so it reads as a soft
/// underlying flex; the crisp visible squash is the render term below.
pub const GOO_WOBBLE_LEN: f32 = 0.30;
/// RENDER squash: the wobble anisotropically scales the metaball cloud about its
/// centroid in the snapshot — stretched along the tear axis, pinched across it
/// (volume-ish preserved). Presentation-only and computed from the hashed wobble
/// state (like `tension`/`glow`), so it is crisp and unfiltered where the
/// incompressible fluid cannot be — THIS is the readable jelly shake.
pub const GOO_WOBBLE_RENDER: f32 = 0.52;
/// One-shot outward velocity kick (wu/s) on the mini at the snap — the recoil pop.
pub const GOO_WOBBLE_KICK: f32 = 0.6;
/// Amplitude floor: below this the oscillator settles to EXACTLY 0 (hash-clean).
pub const GOO_WOBBLE_EPS: f32 = 0.04;
/// A Large mother is a soft GRAVITY WELL on free (tier>0) blobs within this
/// radius (wu): the inverse-square pull law below herds strays back toward her.
pub const GOO_MOTHER_RADIUS: f32 = 2.8;
/// Mother-gravity acceleration scale (wu/s²): `GOO_MOTHER_PULL / dist²` toward
/// her centroid, capped like a trap. Deliberately GENTLE — a soft influence the
/// mini drifts out of, not a leash that reels it back onto her (that just clumps
/// the brood). A freshly-born mini is IMMUNE to this pull (and to any nest trap)
/// until it leaves the well, so it pops cleanly off her and crawls away; once
/// outside, immunity drops and the gentle well can nudge it if it wanders back.
pub const GOO_MOTHER_PULL: f32 = 1.6;

// ---- goo fluid (Position-Based Fluids: Macklin & Müller 2013) ---------------
// The body is a real fluid — a cloud of SPH particles solved each tick for
// incompressibility (a density constraint), surface-tension cohesion (the
// tensile s_corr term — what makes it clump and slime), and XSPH viscosity (the
// gooey drag). It genuinely flows, pools on the floor, drapes over traps, and
// splashes when shot. An external body force pulls the fluid toward the spine
// capsule (the "muscle" that drives locomotion + the single round body) and
// toward any trap. CPU + f32 → deterministic and hashed like the player path.
//
// The solver constants below (`GOO_CFM_EPS`, `GOO_MAX_DP`, `GOO_SCORR_K`/`_N`,
// `GOO_VISCOSITY`) are a COUPLED stability set, not independent knobs: each was
// tuned against the others to keep the small 40-particle fluid from dispersing
// or clustering, so retuning one usually means retuning its neighbours. Tune in
// small steps and re-capture (the `goo_sim_hash_oracle_*` tests pin the result).
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
/// Kept at the tuned-stable value: pushing it higher for a springier surface
/// tips the PBF tensile term into instability (particles snap into clusters —
/// the "glitchy" high-freq jitter), so the springiness comes from the gait and
/// the lateral sway instead, not from over-driving cohesion.
pub const GOO_SCORR_K: f32 = 0.04;
/// Tensile term exponent.
pub const GOO_SCORR_N: i32 = 4;
/// XSPH viscosity (0 = inviscid water, higher = thick gooey drag). Lowered a
/// little (from 0.18) so a disturbance sloshes across the body for a few ticks
/// — a soft wobble. Not pushed lower: too little XSPH lets each particle's
/// velocity decouple and buzz (the "glitchy" jitter), losing the coherent flow.
pub const GOO_VISCOSITY: f32 = 0.15;
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
/// Left at the original value: nudging it toward 1 let kinetic energy build up
/// across ticks and the body buzzed/jittered (the "glitchy shake") instead of
/// settling between wobbles.
pub const GOO_VELOCITY_DECAY: f32 = 0.99;
/// Inverse-distance softening (wu²) on the body-force denominators.
pub const GOO_SOFTEN: f32 = 0.02;
/// Particle metaball radius as a fraction of body radius (SDF lump size).
/// Bumped up so each particle contributes a fatter lump — the metaball surface
/// reads as a thicker, fuller, more voluminous goo body (the "thicker" knob).
pub const GOO_PART_RADIUS_FRAC: f32 = 0.58;

/// SPH kernel W(r) = (1 − r/h)³ for r<h (unit peak at r=0). One smooth kernel
/// for both density and its gradient keeps the PBF scale self-consistent. `h`
/// is per-blob now (smaller blobs use a smaller smoothing radius — see
/// `goo_tier_scale` — so their fluid packs into a smaller footprint).
fn goo_w(r: f32, h: f32) -> f32 {
    if r < h {
        let t = 1.0 - r / h;
        t * t * t
    } else {
        0.0
    }
}
/// ∇W magnitude factor: dW/dr = −3/h·(1 − r/h)². The gradient vector is this
/// times the unit direction (caller supplies the sign/direction).
fn goo_dw(r: f32, h: f32) -> f32 {
    if r > 1e-6 && r < h {
        let t = 1.0 - r / h;
        -3.0 / h * t * t
    } else {
        0.0
    }
}
/// Per-blob fluid length scale by tier: R0/√2 per tier, matching the body
/// radius. Scaling BOTH the smoothing radius `h` and the rest spacing by this
/// leaves the rest density (a function of their ratio) unchanged — so the PBF
/// solver stays in its tuned-stable regime — while the equilibrium footprint
/// shrinks with the tier. A tier-2 mini packs into half a tier-0's spread.
pub fn goo_tier_scale(tier: u8) -> f32 {
    std::f32::consts::FRAC_1_SQRT_2.powi(tier as i32)
}
/// The fluid scale a blob ACTUALLY runs at — derived from its live `body_len`
/// rather than its tier, so a body that is still growing (a freshly-budded mini
/// inflating, or a merge survivor swelling into its new tier) packs its fluid
/// into a correspondingly smaller footprint that grows WITH it. For a settled
/// blob `body_len` is the tier target, so this equals `goo_tier_scale(tier)`.
/// Floored so a near-zero seed can't drive the smoothing radius to an unstable
/// sliver; the seed sits at this floor and the footprint grows as it inflates.
pub(crate) fn goo_body_scale(body_len: f32) -> f32 {
    (body_len / (GOO_BASE_RADIUS * GOO_BODY_FRAC)).clamp(0.26, 1.0)
}
/// Birth-EFFORT tension 0..1 for a blob, from its (already-updated) spawn state.
/// Mothers only: builds through the final push of gestation, peaks at birth,
/// then relaxes out over the afterglow. Shared by the SIM (it clenches/shrinks
/// the body) and the SNAPSHOT (it shrinks the rendered size to match), so the
/// fluid footprint and the drawn silhouette contract in lockstep.
pub(crate) fn goo_tension(tier: u8, spawn_timer: u16, birth_glow: u16) -> f32 {
    if tier != 0 {
        0.0
    } else if birth_glow > 0 {
        let t = birth_glow as f32 / GOO_BIRTH_FADE as f32; // 1 (just after birth) → 0
        t * t // ease the relaxation out
    } else if spawn_timer <= GOO_GESTATE_TICKS {
        let f = 1.0 - spawn_timer as f32 / GOO_GESTATE_TICKS as f32; // 0 → 1 toward birth
        f.powf(1.3) // builds steadily through the push, peaking at birth
    } else {
        0.0
    }
}
/// Render-side wobble scalar in [−amp, amp] from a blob's (hashed) oscillator
/// state — the same sinusoid the sim advances, read by the SNAPSHOT to squash the
/// drawn metaball cloud along the tear axis. Presentation-only (like `goo_tension`
/// for the render size), so the visible jelly shake is crisp where the
/// incompressible fluid itself cannot deform fast enough. 0 once settled.
pub(crate) fn goo_wobble_render(wobble_amp: f32, wobble_phase: u16) -> f32 {
    if wobble_amp <= 0.0 {
        0.0
    } else {
        wobble_amp * (wobble_phase as f32 * GOO_WOBBLE_OMEGA).sin()
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
            rho += goo_w(r, GOO_H);
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

/// Per-tier game-balance curves, indexed by tier (0 Large, 1 Medium, 2 Small),
/// surfaced as const tables next to the other `GOO_*` tuning so the balance is
/// greppable rather than buried in `match` arms.
/// Tier → hit points: Large takes two shots then splits, Medium/Small one.
pub const GOO_TIER_HP: [u16; 3] = [12, 6, 3];
/// Tier → crawl speed (wu/s): smaller blobs scurry faster.
pub const GOO_TIER_SPEED: [f32; 3] = [0.8, 1.1, 1.5];

/// Tier → body radius (wu): R0, R0/√2, R0/2 for Large/Medium/Small.
pub fn goo_tier_radius(tier: u8) -> f32 {
    GOO_BASE_RADIUS * std::f32::consts::FRAC_1_SQRT_2.powi(tier as i32)
}
/// Tier → hit points (see `GOO_TIER_HP`; tiers past Small clamp to Small).
fn goo_tier_hp(tier: u8) -> u16 {
    GOO_TIER_HP[(tier as usize).min(2)]
}
/// Tier → crawl speed (see `GOO_TIER_SPEED`; tiers past Small clamp to Small).
fn goo_tier_speed(tier: u8) -> f32 {
    GOO_TIER_SPEED[(tier as usize).min(2)]
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
    pub spawn_timer: u16, // tier-0 only: ticks until the next mini buds off (mitosis)
    pub spawn_dir: Vec2,  // unit dir centroid→bud site while gestating/after-glowing (ZERO = off)
    pub birth_glow: u16,  // tier-0 only: post-birth afterglow ticks remaining (gentle colour revert)
    pub birth_immune: bool, // a budded mini ignores mother-gravity until it leaves the well
    pub tether: u16,        // newborn: ticks the bond to the bud site still holds (0 = free)
    pub tether_anchor: Vec2, // newborn: frozen world-XZ bud site the tether spring pulls back to
    pub tear_ticks: u16,    // mother: ticks until the bond snaps and her tear-site shakes (0 = idle)
    pub wobble_amp: f32,    // jelly oscillator amplitude (0 = at rest); decays each tick
    pub wobble_dir: Vec2,   // jelly oscillator squash axis (the tear direction)
    pub wobble_phase: u16,  // jelly oscillator integer phase clock (bit-exact, no f32 drift)
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

/// FNV-1a 32-bit offset basis, reused here as a multiplier for RNG-free,
/// id-derived deterministic scattering (particle jitter, gait-clock and mitosis
/// desync) so split children and co-located mothers never line up in lockstep —
/// all without consuming the shared RNG, which keeps the draw order stable.
const GOO_ID_HASH: u32 = 2654435761;
/// Secondary odd multiplier that mixes the particle index / mitosis-desync term
/// (a different stride from `GOO_ID_HASH` so the two scrambles don't correlate).
const GOO_ID_MIX: u32 = 40503;

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
    let spacing = GOO_SPACING * goo_tier_scale(tier); // smaller tiers start tighter
    let mut parts = [Vec2::ZERO; GOO_PARTICLES];
    for (i, p) in parts.iter_mut().enumerate() {
        let gx = (i as i32 % cols) - cols / 2;
        let gz = (i as i32 / cols) - (GOO_PARTICLES as i32 / cols) / 2;
        let h = ((id.0.wrapping_mul(GOO_ID_HASH)).wrapping_add(i as u32 * GOO_ID_MIX)) as f32;
        let jit = (h * 1e-7).fract() - 0.5;
        *p = mid + heading * (gx as f32 * spacing + jit * 0.02) + perp * (gz as f32 * spacing);
    }
    // desync the gait clock per blob from the same id hash (RNG-free), so split
    // children never pulse in lockstep with each other or the parent.
    let gait_phase = ((id.0.wrapping_mul(GOO_ID_HASH)) % GOO_GAIT_PERIOD as u32) as u16;
    // tier-0 mothers bud on the mitosis clock; desync the FIRST bud per-id (over
    // the back half of the cycle) so co-located mothers don't pulse in lockstep.
    // Non-mothers never bud (spawn_timer 0, the spawn block is tier-0-gated).
    let spawn_timer = if tier == 0 {
        GOO_SPAWN_PERIOD - ((id.0.wrapping_mul(GOO_ID_MIX)) % (GOO_SPAWN_PERIOD as u32 / 2)) as u16
    } else {
        0
    };
    Goo { id, ends, ends_prev: ends.map(|e| e - seed_vel), parts, vel: [seed_vel; GOO_PARTICLES], body_len, tier, hp: goo_tier_hp(tier), state: GooState::Wander, timer, heading, gait_phase, merge_grace: GOO_MERGE_GRACE, fusing: 0, fuse_pt: Vec2::ZERO, spawn_timer, spawn_dir: Vec2::ZERO, birth_glow: 0, birth_immune: false, tether: 0, tether_anchor: Vec2::ZERO, tear_ticks: 0, wobble_amp: 0.0, wobble_dir: Vec2::ZERO, wobble_phase: 0 }
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
    /// Per-particle birth-glow 0..1: nonzero only on a gestating mother, peaking
    /// at the bud site as the birth nears, snapping back to 0 once the mini is
    /// born. The shader lerps the goo colour toward a hot birth tint by this.
    /// Pure presentation — derived from the hashed spawn state, never hashed.
    pub glow: [f32; GOO_PARTICLES],
}

/// A blob is free to take part in a fusion only once it is past its newborn
/// merge-grace AND not already collapsing into another survivor. Shared by both
/// ends of the `merge_system` pairing scan so the eligibility rule lives once.
fn goo_merge_ready(g: &Goo) -> bool {
    g.merge_grace == 0 && g.fusing == 0
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
        // Large mothers act as gravity wells on free minis — snapshot their
        // centroids up front (a settled, MobId-sorted read) so the per-blob pull
        // below doesn't re-borrow the World mid-mutation. Fusing mothers don't pull.
        let mothers: Vec<Vec2> = mobs
            .iter()
            .filter_map(|&e| {
                let g = self.world.get::<&Goo>(e).unwrap();
                (g.tier == 0 && g.fusing == 0).then(|| g.centroid())
            })
            .collect();
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

            // --- MITOSIS / MOTHER-GRAVITY. A Large (tier-0) mother counts down
            // to budding off a mini; every smaller blob instead feels the pull of
            // any mother whose well it sits in (unless still birth-immune). ---
            let mut mother_acc = Vec2::ZERO; // net mother-gravity on THIS blob (wu/s²)
            if g.tier == 0 {
                // tick down the post-birth afterglow; when it lapses the bud site
                // is fully back to green, so release spawn_dir for the next cycle.
                if g.birth_glow > 0 {
                    g.birth_glow -= 1;
                    if g.birth_glow == 0 {
                        g.spawn_dir = Vec2::ZERO;
                    }
                }
                g.spawn_timer = g.spawn_timer.saturating_sub(1);
                // tear countdown: armed at birth, it lapses in lockstep with the
                // newborn's tether (both set GOO_TETHER_TICKS the same tick), so the
                // bond snaps and her tear-site shakes on the SAME tick the mini does.
                if g.tear_ticks > 0 {
                    g.tear_ticks -= 1;
                    if g.tear_ticks == 0 {
                        // the bond gives: her tear-site sucks back and she rings.
                        g.wobble_amp = GOO_WOBBLE_AMP0 * GOO_MOTHER_WOBBLE_FRAC;
                        g.wobble_phase = GOO_WOBBLE_HALF; // first half-swing INWARD
                        // wobble_dir (the tear axis) was set at birth.
                    }
                }
                if g.spawn_timer == GOO_GESTATE_TICKS {
                    // enter gestation: the bud forms toward the CAMERA so the birth
                    // always plays out clearly in view (in front of the mother, not
                    // occluded). The iso view sits in the +X+Z octant at yaw 45°, so
                    // world (+X,+Z) — angle π/4 — faces the viewer; a small random
                    // jitter (±~27°) keeps successive births from looking identical.
                    let a = std::f32::consts::FRAC_PI_4 + (self.res.rng.next_f32() - 0.5) * (std::f32::consts::PI * 0.30);
                    g.spawn_dir = Vec2::new(a.cos(), a.sin());
                }
                if g.spawn_timer == 0 {
                    // BIRTH — skipped (and the timer waits a full cycle) if it
                    // would breach the live cap, so mitosis never outruns the
                    // renderer's metaball pool.
                    if self.mobs.len() < GOO_LIVE_CAP {
                        let c = g.centroid();
                        let dir = g.spawn_dir.try_normalize().unwrap_or(g.heading);
                        // the bud forms INSIDE her body at the bud site (just under
                        // the surface), as a small deflated droplet, then inflates
                        // and oozes out — a piece of her pinching off.
                        let site = c + dir * (goo_tier_radius(g.tier) * 0.55);
                        let cid = MobId(self.res.next_mob_id);
                        self.res.next_mob_id += 1;
                        let timer = 20 + (self.res.rng.next_f32() * 60.0) as u16;
                        // born at REST (no outward pop): the tether spring must
                        // build the neck tension itself, not fight an initial shove.
                        let mut baby = fresh_goo(cid, GOO_BIRTH_TIER, site, dir, Vec2::ZERO, timer);
                        // deflate to a droplet and shrink the cloud to match, so it
                        // EMERGES (the gait's body_len ease re-inflates it) instead
                        // of appearing full-size — the reverse of a fusion collapse.
                        let seed_len = baby.body_len * GOO_BIRTH_SEED;
                        let shrink = goo_body_scale(seed_len) / goo_tier_scale(GOO_BIRTH_TIER);
                        let bc = baby.centroid();
                        for p in baby.parts.iter_mut() {
                            *p = site + (*p - bc) * shrink;
                        }
                        baby.vel = [Vec2::ZERO; GOO_PARTICLES];
                        baby.body_len = seed_len;
                        baby.ends = [site + dir * (seed_len * 0.5), site - dir * (seed_len * 0.5)];
                        baby.ends_prev = baby.ends;
                        baby.birth_immune = true; // ignores mom's pull until it clears the well
                        // BOND: a yielding spring tethers the newborn to the frozen
                        // bud site while its crawl hauls its head clear → a thinning
                        // neck the render union draws, snapping at GOO_TETHER_TICKS.
                        baby.tether = GOO_TETHER_TICKS;
                        baby.tether_anchor = site;
                        self.res.buf.spawn((baby,));
                        self.res.mobs_dirty = true;
                        // arm the mother's matching tear: same lifetime, set the SAME
                        // tick, so her shake fires in lockstep with the mini's snap.
                        g.tear_ticks = GOO_TETHER_TICKS;
                        g.wobble_dir = dir; // tear axis: outward toward where the bud left
                        self.res.events.emit(GameEvent::MobSplit(g.id, Vec3::new(c.x, goo_tier_radius(g.tier), c.y)));
                    }
                    g.spawn_timer = GOO_SPAWN_PERIOD;
                    // keep spawn_dir and start the afterglow: the bud colour holds
                    // through the mini's separation, then eases gently back to green.
                    g.birth_glow = GOO_BIRTH_FADE;
                }
            } else {
                let c = g.centroid();
                let mut inside = false;
                for &mc in &mothers {
                    let d = mc - c;
                    let dist = d.length();
                    if dist >= GOO_MOTHER_RADIUS || dist < 1e-3 {
                        continue;
                    }
                    inside = true;
                    if !g.birth_immune {
                        let d2 = dist * dist + GOO_SOFTEN;
                        mother_acc += d / dist * (GOO_MOTHER_PULL / d2);
                    }
                }
                // a birth-immune mini becomes a normal blob the moment it leaves
                // EVERY mother's well — then the well can draw it back if it returns.
                if g.birth_immune && !inside {
                    g.birth_immune = false;
                }
                let ml = mother_acc.length();
                if ml > GOO_TRAP_MAX {
                    mother_acc *= GOO_TRAP_MAX / ml;
                }
            }
            // a birth-immune newborn ignores EVERY external well — the mother's
            // gravity (already gated above) AND any trap it buds inside — so it
            // pops cleanly off her instead of being recaptured by the nest.
            let well = if g.birth_immune { 0.0 } else { 1.0 };

            // birth-EFFORT envelope (mothers only): tension ramps in through the
            // final push of gestation, peaks at birth, then relaxes back out over
            // the afterglow. It shrinks/clenches the body and stalls her crawl —
            // the visible "push". Shared with the snapshot so render size matches.
            let tension = goo_tension(g.tier, g.spawn_timer, g.birth_glow);

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

            // --- BIRTH TETHER: while the bond holds, a yielding spring drags the
            // newborn's particles back toward the frozen bud site. Its crawl hauls
            // the head out, so the body lags and the render's metaball union shows
            // a stretching, thinning neck. At the timeout the bond SNAPS: the mini
            // gets an outward recoil kick and starts ringing (the mother fires her
            // matching shake the same tick, off her own tear countdown). ---
            let cen_now = g.centroid();
            let mut tether_k = 0.0f32;
            if g.tether > 0 {
                g.tether -= 1;
                // yielding spring: full pull when short, fading to zero as the neck
                // stretches past GOO_TETHER_SNAP (where the visual waist has pinched).
                let over = ((cen_now - g.tether_anchor).length() - GOO_TETHER_REST * goo_body_scale(g.body_len)).max(0.0);
                tether_k = GOO_TETHER_PULL * (1.0 - (over / GOO_TETHER_SNAP).min(1.0));
                if g.tether == 0 {
                    // SNAP: the released-spring lurch + the ring-down begins.
                    let away = (cen_now - g.tether_anchor).try_normalize().unwrap_or(g.heading);
                    g.wobble_amp = GOO_WOBBLE_AMP0;
                    g.wobble_dir = away;
                    g.wobble_phase = 0; // first half-swing OUTWARD (the lurch)
                    for v in g.vel.iter_mut() {
                        *v += away * GOO_WOBBLE_KICK;
                    }
                    tether_k = 0.0; // bond's gone this very tick
                }
            }

            // --- JELLY WOBBLE oscillator: a single decaying sinusoid on an integer
            // phase clock (bit-exact). It feeds an additive spine-length flex
            // (folded into gait_len just below — the physical, fluid-filtered half)
            // and the snapshot's metaball squash (the readable half). Settles to
            // EXACTLY 0 at the floor so the hash quiesces. ---
            let wobble = if g.wobble_amp > GOO_WOBBLE_EPS {
                g.wobble_phase = g.wobble_phase.wrapping_add(1);
                let w = g.wobble_amp * (g.wobble_phase as f32 * GOO_WOBBLE_OMEGA).sin();
                g.wobble_amp *= GOO_WOBBLE_DECAY;
                w
            } else {
                g.wobble_amp = 0.0;
                0.0
            };

            let (gather, mut stretch) = gait_profile(g.gait_phase);
            // tension holds her round: suppress the lunge stretch so she doesn't
            // elongate, and draw the spine shorter (a clench) for a tight ball.
            stretch *= 1.0 - tension;
            // the wobble rides the spine length as an ADDITIVE delta: a real flex
            // along the body axis as it rings down (the snapshot squash carries the
            // crisp visible part). Additive (not a multiplier) so the birth tension
            // clench, still relaxing through the afterglow, can't scale it away.
            // Clamped to a small positive so a deep swing can't invert the spine.
            let gait_base = g.body_len * (GOO_LEN_MIN + (GOO_LEN_MAX - GOO_LEN_MIN) * stretch) * (1.0 - tension * GOO_TENSE_CLENCH);
            let gait_len = (gait_base + g.body_len * wobble * GOO_WOBBLE_LEN).max(g.body_len * 0.2);

            // --- head anchor: Verlet inertia + steering drive + trap pull,
            // through collide_and_slide (walls stop it like the player). The
            // drive surges with the lunge (`stretch`) so the creature pushes off
            // each gait cycle rather than gliding at a constant rate. ---
            let inertia = (g.ends[0] - g.ends_prev[0]) * GOO_VERLET_DECAY * GOO_HEAD_INERTIA;
            // she all but stops crawling while she pushes (tension → 0 drive)
            let drive = g.heading * (speed * mv * (0.5 + 0.5 * stretch) * (1.0 - 0.85 * tension) * TICK_DT);
            let d = inertia + drive + (self.trap_accel(g.ends[0]) * well + mother_acc) * GOO_END_TRAP;
            let (nx, nz) = collide_and_slide(|x, z| self.goo_solid(x, z), g.ends[0].x, g.ends[0].y, d.x, d.y);
            g.ends_prev[0] = g.ends[0];
            g.ends[0] = Vec2::new(nx, nz);

            // --- tail anchor: Verlet + trap pull, then a distance constraint
            // holding it the (gait-modulated) spine length behind the head. As
            // `gait_len` shrinks the tail catches up (round-up) and as it grows
            // the body extends (the inchworm reach). ---
            let tail_d = (g.ends[1] - g.ends_prev[1]) * GOO_VERLET_DECAY + (self.trap_accel(g.ends[1]) * well + mother_acc) * GOO_END_TRAP;
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
            // per-blob fluid scale, derived from the LIVE body_len so a growing
            // body (an inflating newborn, a swelling merge survivor) packs its
            // 40 particles into a footprint that grows with it (rho0 is
            // scale-invariant, so the solver stays in its tuned regime). Tension
            // shrinks it further: a smaller smoothing radius packs the same fluid
            // into a tighter rest-footprint → she balls up for the push.
            let g_scale = goo_body_scale(g.body_len) * (1.0 - GOO_TENSE_SHRINK * tension);
            let h = GOO_H * g_scale;
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
            // tension boosts the capsule cohesion so she visibly draws herself
            // together into a firmer, rounder ball during the push.
            let pull = GOO_END_PULL * (GOO_PULL_BASE + (1.0 - GOO_PULL_BASE) * gather) * (1.0 + GOO_TENSE_PULL * tension);
            // centre the tension squeeze on the body centroid (only while pushing)
            let squeeze = tension * GOO_TENSE_SQUEEZE;
            let cen = if squeeze > 0.0 { g.centroid() } else { Vec2::ZERO };
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
                let mut a = dir / (dist + 0.10 * g_scale) * pull;
                // lateral self-centering: damp the velocity component across the
                // heading so turns don't smear the body sideways.
                a -= perp * (g.vel[i].dot(perp) * GOO_LATERAL);
                a += self.trap_accel(p) * well + mother_acc;
                a += (cen - p) * squeeze; // tension: compact toward the centroid
                if tether_k > 0.0 {
                    // bond spring: haul the body back to the bud site → the neck.
                    a += (g.tether_anchor - p) * tether_k;
                }
                g.vel[i] = (g.vel[i] + a * dt) * GOO_VELOCITY_DECAY;
                let vl = g.vel[i].length();
                let max_vel = GOO_MAX_VEL * g_scale; // scale the guard with the blob
                if vl > max_vel {
                    g.vel[i] *= max_vel / vl;
                }
                xp[i] = p + g.vel[i] * dt;
            }
            let scorr_denom = goo_w(0.2 * h, h).max(1e-6);
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
                        rho += goo_w(r, h);
                        if i != j && r > 1e-6 {
                            let gw = rij / r * goo_dw(r, h); // ∇W(p_i - p_j)
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
                        if r >= h || r < 1e-6 {
                            continue;
                        }
                        let scorr = -GOO_SCORR_K * (goo_w(r, h) / scorr_denom).powi(GOO_SCORR_N);
                        let gw = rij / r * goo_dw(r, h);
                        dp += gw * ((lambda[i] + lambda[j] + scorr) / rho0);
                    }
                    // clamp the correction so the density solve can never overshoot
                    // (scaled with the blob so a small one isn't over-corrected)
                    let dl = dp.length();
                    let max_dp = GOO_MAX_DP * g_scale;
                    if dl > max_dp {
                        dp *= max_dp / dl;
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
                    dv += (vin[j] - vin[i]) * goo_w(r, h);
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
        for &(c, strength, radius, off_tick) in &self.res.traps {
            // a timed trap goes inert once the sim reaches its off_tick (0 = never)
            if off_tick != 0 && self.res.cur_tick >= off_tick as u64 {
                continue;
            }
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
            // a struck blob wobbles like jelly: arm the same oscillator the birth
            // snap uses, squashing along the slug heading (don't damp an existing
            // stronger ring). Cheap, deterministic, and makes every goo springy.
            g.wobble_amp = g.wobble_amp.max(GOO_WOBBLE_AMP0 * GOO_MOTHER_WOBBLE_FRAC);
            g.wobble_dir = kdir;
            g.wobble_phase = 0;
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
            if ga.tier == 0 || !goo_merge_ready(&ga) {
                continue; // Large can't grow; newborns/fusing blobs are immune
            }
            let ca = ga.centroid();
            let touch = goo_tier_radius(ga.tier) * GOO_MERGE_FRAC;
            for b in (a + 1)..mobs.len() {
                let gb = *self.world.get::<&Goo>(mobs[b]).unwrap();
                if gb.tier != ga.tier || !goo_merge_ready(&gb) {
                    continue; // same-tier only, and both past grace / not fusing
                }
                let cb = gb.centroid();
                if (ca - cb).length() < touch {
                    // midpoint kept as the exact `(ca + cb) * 0.5` — f32 is
                    // non-associative, so this expression is hashed verbatim.
                    found = Some((mobs[a], mobs[b], ga.id, ga.tier, (ca + cb) * 0.5, ga.heading));
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
            // a survivor promoted to Large becomes a mother — arm its mitosis
            // clock to a FULL cycle so it doesn't bud the instant it grows (its
            // pre-merge spawn_timer was 0; without this it births every tick).
            if g.tier == 0 {
                g.spawn_timer = GOO_SPAWN_PERIOD;
            }
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
