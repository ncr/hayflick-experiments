//! Goo-mob fluid sim (split out of `game.rs`): the Position-Based-Fluids blob
//! creatures — tuning constants + kernels, the `Goo` component, the crawl/AI
//! `goo_system`, trap pull, shot damage/split, and same-tier fusion. These are
//! `impl HouseGame` methods and free items in a CHILD module of `game`, so they
//! reach `Res`'s private fields with no visibility widening. Pure relocation —
//! the authoritative per-tick system order (`tick()` in game.rs, one commented
//! call per step), snapshot, and state_hash stay in `game.rs`.
use super::*;
use crate::collide_and_slide;
use crate::spec::{GooKind, MobId};
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
// ---- integrity (the arena fail state) ---------------------------------------
/// A fluid particle within this margin of the player pillar counts as
/// CONTACT (wu beyond PLAYER_HALF). MUST exceed GOO_COLLIDER_MARGIN (0.10):
/// the wall clamp keeps settled particles exactly that far out, so a touch
/// band inside it never fires — the pressing body has to be read in the
/// ring just outside the clamp. Metaball render radii overlap the pillar
/// visually well before this, so contact reads honest on screen.
pub const GOO_TOUCH_MARGIN: f32 = 0.28;
/// Integrity drained per contacting particle per second. A full Large
/// engulf wraps ~15+ particles -> lethal in ~3 s; a single pressing Medium
/// (~8) gives ~6 s to react; a Small brushing with 2-3 chips slowly. Tier
/// scaling IS the particle count.
pub const GOO_DRAIN_PER_PART: f32 = 0.02;
/// Droid shove per contacting particle (wu/s), capped — being pressed by
/// fluid moves you like fluid, and an engulf can pin you against a wall.
pub const GOO_CONTACT_PUSH: f32 = 0.06;
pub const GOO_CONTACT_PUSH_CAP: f32 = 0.60;

/// Tier -> biomass mass units (Large 4, Medium 2, Small 1): the conserved
/// quantity the arena economy pays out in when mass PERMANENTLY leaves the
/// board (see damage_goo scoring).
pub fn goo_tier_mass(tier: u8) -> u32 {
    [4, 2, 1][(tier as usize).min(2)]
}

/// Crater burst: fraction of a hit's knockback that particles near the impact
/// receive RADIALLY away from the strike point (on top of the directional
/// shove above) — the entry wound visibly caves and side-sprays (2026-07-04).
pub const GOO_CRATER_FRAC: f32 = 0.45;
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

// ---- render-side VERTICAL body language (presentation-only) ------------------
// The composite's global vertical squash is modulated PER BLOB so the body
// breathes in height (the fluid is world-XZ only — without this the goo never
// changes height at all, the least jelly-like thing about it). All three
// drivers are pure reads of already-hashed state (gait phase, wobble
// oscillator, spawn state), fed to the renderer through `MobRender.vscale` —
// like `tension` and the wobble squash, nothing here re-enters the hash.
/// How much FLATTER the body draws at full lunge stretch: the plan-view
/// elongation trades off height (volume-ish conservation, the inchworm reach
/// pressing low as it extends).
pub const GOO_VS_LUNGE: f32 = 0.22;
/// Vertical bounce per unit of jelly wobble, in ANTIPHASE to the horizontal
/// squash: as the cloud stretches out along the tear axis it flattens, and as
/// it pinches back it bulges up — the classic jelly bounce.
pub const GOO_VS_WOBBLE: f32 = 0.30;
/// Extra height at peak birth tension: the tightening knot draws UP as its
/// footprint shrinks, so the mother visibly balls up rather than just shrinking.
pub const GOO_VS_TENSE: f32 = 0.25;
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

// ---- blob–blob CONTACT: separate bodies stay separate ------------------------
// Each blob's PBF solve is otherwise blind to every other blob, so two crawling
// bodies pass straight through each other — and the render's global smin union
// welds the crossing pair into one lump. A soft contact force between DIFFERENT
// blobs' particles keeps the bodies apart while still letting surfaces kiss on
// touch (a brief contact weld reads as goopy; full interpenetration reads as a
// bug). Both sides of a pair read start-of-tick snapshots, so the force is
// symmetric and independent of the MobId processing order. Pairs that are
// ALLOWED to overlap opt out: a merge-compatible pair (fusion IS their contact
// response), a fusing blob (it collapses INTO its survivor), and a tethered
// newborn (the umbilical neck IS an overlap).
/// Repulsion acceleration scale (wu/s²) per unit of summed linear overlap of
/// foreign particles within the contact skin.
pub const GOO_REPEL: f32 = 30.0;
/// Cap on the summed repulsion at one sample point (wu/s²): ABOVE both the
/// capsule muscle (`GOO_END_PULL` 11) and the trap ceiling (`GOO_TRAP_MAX` 22)
/// so deep overlap ALWAYS resolves — via `GOO_END_TRAP` this converts to
/// ~1.5 wu/s of spine push, which out-runs every tier's crawl, so a wandering
/// head cannot grind through a body it's being pushed out of. (Merge-eligible
/// pairs opt out entirely, so fusion under a trap is unaffected.)
pub const GOO_REPEL_MAX: f32 = 32.0;
/// Contact skin (wu, × the pair's mean fluid scale): foreign particles repel
/// within this range. Wider than the smoothing radius `GOO_H` (0.30) — the
/// metaball surface extends ~`GOO_PART_RADIUS_FRAC`·R past each particle, so
/// the skin must engage while the CLOUDS are still apart or the silhouettes
/// weld before any force builds.
pub const GOO_REPEL_SKIN: f32 = 0.45;

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

// ---- PBF density solver passes ----------------------------------------------
// One Jacobi iteration of the Position-Based-Fluids density constraint is a
// LAMBDA pass (per-particle pressure multiplier) followed by a CORRECTION pass
// (apply the resulting position deltas). Both are O(N²) over the blob's own
// particles. Pulled out of `goo_system` VERBATIM — the i/j loop order, the
// `i==j` / radius guards, and every float operation are unchanged, so the
// state_hash is byte-identical (see `goo_sim_hash_oracle_*`). DO NOT reorder the
// accumulations or reassociate the sums: f32 is non-associative and hashed.

/// Density-constraint pass: the per-particle λ multiplier for predicted
/// positions `xp` (rest density `rho0`, smoothing radius `h`).
fn goo_pbf_lambda(xp: &[Vec2; GOO_PARTICLES], rho0: f32, h: f32) -> [f32; GOO_PARTICLES] {
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
    lambda
}

/// Correction pass: apply the incompressibility + tensile-cohesion position
/// deltas (from `lambda`) to `xp` in place, each clamped to `GOO_MAX_DP·g_scale`
/// so the density solve can never overshoot. `scorr_denom` is the cohesion
/// normaliser the caller computes once per blob.
fn goo_pbf_correct(
    xp: &mut [Vec2; GOO_PARTICLES],
    lambda: &[f32; GOO_PARTICLES],
    rho0: f32,
    h: f32,
    g_scale: f32,
    scorr_denom: f32,
) {
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
}

/// XSPH viscosity: nudge each particle's velocity toward its neighbours' so the
/// body flows as one coherent slime. Snapshots the incoming velocities, then
/// accumulates the symmetric pairwise delta (same `i==j` guard and order as the
/// extracted loop) and applies `GOO_VISCOSITY` of it.
fn goo_xsph_viscosity(vel: &mut [Vec2; GOO_PARTICLES], xp: &[Vec2; GOO_PARTICLES], h: f32) {
    let vin = *vel;
    for i in 0..GOO_PARTICLES {
        let mut dv = Vec2::ZERO;
        for j in 0..GOO_PARTICLES {
            if i == j {
                continue;
            }
            let r = (xp[i] - xp[j]).length();
            dv += (vin[j] - vin[i]) * goo_w(r, h);
        }
        vel[i] += dv * GOO_VISCOSITY;
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

/// Per-blob VERTICAL scale for the render (1 = the resting `GOO_SQUASH`
/// profile): the lunge flattens the body, the jelly wobble bounces it in
/// antiphase to the horizontal squash, and birth tension draws it up into a
/// taller knot. The lunge term mirrors the sim's tension-suppressed stretch so
/// a pushing mother doesn't flatten mid-clench. Presentation-only — a pure
/// read of hashed state, consumed by the snapshot (never re-hashed).
pub(crate) fn goo_render_vscale(g: &Goo) -> f32 {
    let (_, stretch) = gait_profile(g.gait_phase);
    let tension = goo_tension(g.tier, g.spawn_timer, g.birth_glow);
    let stretch = stretch * (1.0 - tension);
    let wob = goo_wobble_render(g.wobble_amp, g.wobble_phase);
    ((1.0 - GOO_VS_LUNGE * stretch) * (1.0 - GOO_VS_WOBBLE * wob) * (1.0 + GOO_VS_TENSE * tension)).clamp(0.5, 1.6)
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

/// A blob is WEAK below a third of its tier's hit points — the render shell
/// gives weak bodies the netcode-lag glitch (their drawn body stutters behind
/// the true, still-authoritative hitbox). Pure presentation read.
pub(crate) fn goo_is_weak(g: &Goo) -> bool {
    g.hp * 3 <= goo_tier_hp(g.tier)
}
/// Tier → crawl speed (see `GOO_TIER_SPEED`; tiers past Small clamp to Small).
pub(crate) fn goo_tier_speed(tier: u8) -> f32 {
    GOO_TIER_SPEED[(tier as usize).min(2)]
}

/// Kind → (speed, turn, aggro) multipliers on the tier baselines. GREEN IS
/// EXACTLY 1.0 EVERYWHERE — `x * 1.0` is a bit-exact identity in IEEE f32, so
/// all-Green levels (every pre-kind level) simulate byte-identically and the
/// goo oracles only moved for the hash-fold bytes, not behavior.
pub fn goo_kind_moves(kind: GooKind) -> (f32, f32, f32) {
    match kind {
        GooKind::Green => (1.0, 1.0, 1.0),
        // twitchy hunter: faster crawl, much sharper steering, and it smells
        // the player from 3× the distance (4.5 wu) — the pressure enemy
        GooKind::Runner => (1.6, 2.5, 3.0),
        // slow wall of goo (its resistances are the threat, not its legs)
        GooKind::Tank => (0.6, 0.7, 1.0),
    }
}

/// Kind × weapon class → integer damage multiplier (numerator, denominator),
/// applied as `(damage · n / d).max(1)` — exact integer math, no float drift.
/// The Tank shrugs off small-arms: uzi pinpricks quarter, shotgun pellets
/// halve. Everything else is ×1 (the slug/grenade/harpoon land in full).
pub fn goo_kind_damage_mult(kind: GooKind, class: WeaponClass) -> (u16, u16) {
    match (kind, class) {
        (GooKind::Tank, WeaponClass::Uzi) => (1, 4),
        (GooKind::Tank, WeaponClass::Shotgun) => (1, 2),
        _ => (1, 1),
    }
}

/// Ticks a harpooned blob stays pinned to the floor (4 s @ 60).
pub const GOO_PIN_TICKS: u16 = 240;
/// Pin spring stiffness (wu/s² per wu of displacement), fed through the same
/// mother-well channel (anchors ×GOO_END_TRAP + fluid direct), capped at
/// GOO_TRAP_MAX like every external well so it can't destabilise the solver.
const GOO_PIN_PULL: f32 = 14.0;

/// Cure stacks a body can hold (further slugs keep the count here).
pub const GOO_CURE_MAX: u8 = 4;
/// Dying with at least this many cure stacks SOLIDIFIES the body: a dead
/// solid chunk is left on the floor (blocks walking + low shots) and only a
/// single small live escapee squirms free — the slug's payoff over splitting.
pub const GOO_CURE_CHUNK: u8 = 2;
/// Crawl-speed penalty per cure stack (multiplier = 1 − 0.2·cure, floored).
pub(crate) const GOO_CURE_SLOW: f32 = 0.2;
/// Solid-chunk footprint half-extent as a fraction of the body radius.
pub const GOO_CHUNK_FRAC: f32 = 0.8;
/// Solid-chunk height (wu): knee-high — shots at muzzle height fly OVER it,
/// grounded crawlers and low slugs are blocked.
pub const GOO_CHUNK_H: f32 = 0.55;
/// Hard cap on standing chunks (renderer pool size); at the cap a cured death
/// degrades to a plain kill so the arena can't brick itself solid.
pub const GOO_CHUNK_CAP: usize = 16;

/// Wave entrance ring radius (wu): new squads land on the north semicircle,
/// always up-screen of the player's spawn half.
const GOO_WAVE_RING: f32 = 7.0;

/// Wave-director state (arena levels): the current wave index (0 = the
/// authored squad) and the lull countdown that runs while the floor is clear.
#[derive(Clone, Copy, Debug)]
pub struct WaveState {
    pub idx: u16,
    /// Ticks left before the next wave lands (counts down only while clear).
    pub lull: u16,
    /// Authored lull length (ArenaParams.wave_lull, re-armed every wave).
    pub lull_full: u16,
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
    pub kind: GooKind, // species: behavior multipliers + resistances + tint
    pub cure: u8,      // slug "cure" stacks (solidify payload; behavior in M5)
    pub pinned: u16,   // >0: harpooned to the floor — drive cut, pin spring on
    pub pin_pt: Vec2,  // world-XZ point the harpoon nailed the body to
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
    // ---- arena tactics (mutated ONLY by tactic_system on arena levels;
    // hashed only under the arsenal gate — see state_hash)
    pub tac: Tactic,     // current maneuver state
    pub tac_timer: u16,  // phase clock within the maneuver
    pub tac_point: Vec2, // maneuver waypoint (cover / peek / flank)
    pub strike: u64,     // agreed comm-pact strike tick (0 = no pact)
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

/// Secondary odd multiplier that mixes the particle index / mitosis-desync term
/// (a different stride from the shared [`ID_HASH_STRIDE`] Knuth multiplier so
/// the two scrambles don't correlate). The id-derived scattering (particle
/// jitter, gait-clock and mitosis desync) keeps split children and co-located
/// mothers out of lockstep without consuming the shared RNG, which keeps the
/// draw order stable.
pub(crate) const GOO_ID_MIX: u32 = 40503;

/// Build a fresh blob: head at `head`, tail trailing `body_len` along
/// `-heading`, and the particles scattered as a small grid over the spine (the
/// capsule muscle rounds them into one blob within a few ticks). `vel` (per-tick
/// displacement) is baked into every `prev` so the whole body drifts on its
/// first tick (split separation). `heading` must be unit; `id`-derived scatter keeps it
/// deterministic without consuming the shared RNG.
pub(crate) fn fresh_goo(id: MobId, tier: u8, kind: GooKind, head: Vec2, heading: Vec2, seed_vel: Vec2, timer: u16) -> Goo {
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
        let h = ((id.0.wrapping_mul(ID_HASH_STRIDE)).wrapping_add(i as u32 * GOO_ID_MIX)) as f32;
        let jit = (h * 1e-7).fract() - 0.5;
        *p = mid + heading * (gx as f32 * spacing + jit * 0.02) + perp * (gz as f32 * spacing);
    }
    // desync the gait clock per blob from the same id hash (RNG-free), so split
    // children never pulse in lockstep with each other or the parent.
    let gait_phase = ((id.0.wrapping_mul(ID_HASH_STRIDE)) % GOO_GAIT_PERIOD as u32) as u16;
    // tier-0 mothers bud on the mitosis clock; desync the FIRST bud per-id (over
    // the back half of the cycle) so co-located mothers don't pulse in lockstep.
    // Non-mothers never bud (spawn_timer 0, the spawn block is tier-0-gated).
    let spawn_timer = if tier == 0 {
        GOO_SPAWN_PERIOD - ((id.0.wrapping_mul(GOO_ID_MIX)) % (GOO_SPAWN_PERIOD as u32 / 2)) as u16
    } else {
        0
    };
    Goo { id, kind, cure: 0, pinned: 0, pin_pt: Vec2::ZERO, ends, ends_prev: ends.map(|e| e - seed_vel), parts, vel: [seed_vel; GOO_PARTICLES], body_len, tier, hp: goo_tier_hp(tier), state: GooState::Wander, timer, heading, gait_phase, merge_grace: GOO_MERGE_GRACE, fusing: 0, fuse_pt: Vec2::ZERO, spawn_timer, spawn_dir: Vec2::ZERO, birth_glow: 0, birth_immune: false, tether: 0, tether_anchor: Vec2::ZERO, tear_ticks: 0, wobble_amp: 0.0, wobble_dir: Vec2::ZERO, wobble_phase: 0, tac: Tactic::Direct, tac_timer: 0, tac_point: Vec2::ZERO, strike: 0 }
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
    // gather: the pull boost ramps up through the round-up, RELEASES smoothly
    // across the early lunge, rests, then eases back up to the wrap value. The
    // old profile snapped 1.0 → 0.2 at t=0.35 and 0.2 → 0.4 across the cycle
    // wrap — a twice-per-cycle force STEP the whole fluid read as a pulse.
    // smoothstep ends with zero slope and the u² ramp starts with zero slope,
    // so even the wrap is kink-free.
    let gather = if t < 0.35 {
        let u = t / 0.35;
        0.4 + 0.6 * u * u
    } else if t < 0.55 {
        let v = (t - 0.35) / 0.20;
        1.0 - 0.8 * (v * v * (3.0 - 2.0 * v)) // 1.0 → 0.2, eased both ends
    } else if t < 0.85 {
        0.2
    } else {
        let v = (t - 0.85) / 0.15;
        0.2 + 0.2 * (v * v * (3.0 - 2.0 * v)) // 0.2 → 0.4 = the t=0 ramp start
    };
    (gather, stretch)
}

/// Rotate unit vector `from` toward unit vector `to` by at most `max_rad`.
pub(crate) fn rotate_toward(from: Vec2, to: Vec2, max_rad: f32) -> Vec2 {
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
    /// Species — drives the render tint (green/red/blue) and light color.
    pub kind: GooKind,
    /// Cure stacks 0..=GOO_CURE_MAX — the renderer desaturates a curing body.
    pub cure: u8,
    /// Weak (hp ≤ ⅓ of tier max): the render shell applies the lag-glitch.
    pub weak: bool,
    pub parts: [Vec3; GOO_PARTICLES],
    pub radius: f32,
    pub part_radius: f32,
    /// Per-particle birth-glow 0..1: nonzero only on a gestating mother, peaking
    /// at the bud site as the birth nears, snapping back to 0 once the mini is
    /// born. The shader lerps the goo colour toward a hot birth tint by this.
    /// Pure presentation — derived from the hashed spawn state, never hashed.
    pub glow: [f32; GOO_PARTICLES],
    /// Per-blob vertical scale on the composite's resting squash (1 = neutral):
    /// gait lunge flattens, jelly wobble bounces, birth tension draws up. See
    /// `goo_render_vscale`. Pure presentation, like `glow`.
    pub vscale: f32,
    /// Comm-pact blink 0..1 — the visible blob-to-blob telegraph: both pact
    /// members pulse in sync (same strike tick), accelerating toward the
    /// strike. The shell flashes the body tint + cone light by it. Pure
    /// presentation, derived from hashed pact state (see `comm_pulse`).
    pub comm: f32,
    /// The blob's current tactic — the shell renders it as a "thinking"
    /// bubble over the body (the live-readable mind). Pure presentation
    /// read of the hashed arena brain state; `Direct` everywhere off arena.
    pub tac: Tactic,
}

impl MobRender {
    /// Mean of the lifted particle positions (world XYZ). The accumulation order
    /// matches the hand-rolled sum the renderer used so the result is bit-stable.
    pub fn centroid(&self) -> Vec3 {
        let mut c = Vec3::ZERO;
        for p in &self.parts {
            c += *p;
        }
        c / self.parts.len() as f32
    }
}

/// Render-pose particle cloud (world XYZ, each lifted to height `pr`). While the
/// jelly oscillator is live it anisotropically squashes the cloud about the
/// centroid — stretched along the tear axis, pinched across it — so the crisp
/// visible quiver lives here, where the incompressible fluid can't flex fast
/// enough; otherwise a plain lift. Presentation-only (a pure read of the hashed
/// wobble state, never re-hashed); the float ops are kept verbatim.
pub(crate) fn goo_render_parts(g: &Goo, pr: f32) -> [Vec3; GOO_PARTICLES] {
    let wob = goo_wobble_render(g.wobble_amp, g.wobble_phase);
    if wob != 0.0 && g.wobble_dir != Vec2::ZERO {
        let c = g.centroid();
        let d = g.wobble_dir;
        let sa = 1.0 + wob * GOO_WOBBLE_RENDER; // along the tear axis
        let sp = 1.0 - 0.5 * wob * GOO_WOBBLE_RENDER; // across it
        g.parts.map(|p| {
            let rel = p - c;
            let al = rel.dot(d);
            let across = rel - d * al;
            let q = c + d * (al * sa) + across * sp;
            Vec3::new(q.x, pr, q.y)
        })
    } else {
        g.parts.map(|p| Vec3::new(p.x, pr, p.y))
    }
}

/// Per-particle birth-glow 0..1 for the render: nonzero only on a gestating /
/// after-glowing mother, concentrated at the bud site and falling off across the
/// body, so the hot birth tint reads as the birth PLACE. AFTERGLOW holds full
/// then smoothsteps back to green; GESTATION ramps 0→1 (sqrt-eased). Presentation
/// only — derived from the hashed spawn state, never hashed. Kept verbatim.
pub(crate) fn goo_render_glow(g: &Goo) -> [f32; GOO_PARTICLES] {
    let mut glow = [0.0f32; GOO_PARTICLES];
    let strength = if g.birth_glow > 0 {
        let elapsed = GOO_BIRTH_FADE - g.birth_glow; // 0 → GOO_BIRTH_FADE
        if elapsed < GOO_BIRTH_HOLD {
            1.0
        } else {
            let u = (elapsed - GOO_BIRTH_HOLD) as f32 / (GOO_BIRTH_FADE - GOO_BIRTH_HOLD) as f32;
            1.0 - u * u * (3.0 - 2.0 * u)
        }
    } else if g.spawn_timer <= GOO_GESTATE_TICKS {
        (1.0 - g.spawn_timer as f32 / GOO_GESTATE_TICKS as f32).sqrt()
    } else {
        0.0
    };
    if strength > 0.0 && g.spawn_dir != Vec2::ZERO {
        let c = g.centroid();
        let mr = goo_tier_radius(g.tier);
        let site = c + g.spawn_dir * mr;
        let falloff = mr * 0.95; // tight around the bud so the vivid tint reads as the birth PLACE
        for k in 0..GOO_PARTICLES {
            let prox = (1.0 - (g.parts[k] - site).length() / falloff).clamp(0.0, 1.0);
            glow[k] = strength * prox;
        }
    }
    glow
}

/// A blob is free to take part in a fusion only once it is past its newborn
/// merge-grace AND not already collapsing into another survivor. Shared by both
/// ends of the `merge_system` pairing scan so the eligibility rule lives once.
fn goo_merge_ready(g: &Goo) -> bool {
    g.merge_grace == 0 && g.fusing == 0
}

/// Start-of-tick contact snapshot of one blob, index-aligned with the mob
/// handle list, for the blob–blob repulsion. Every blob repels against these
/// FROZEN positions (not the live World, which mutates as the loop walks the
/// MobId order), so the pair forces are symmetric and order-independent.
struct GooContact {
    centroid: Vec2,
    /// Broad-phase reach: how far this blob's particles spread from `centroid`.
    reach: f32,
    parts: [Vec2; GOO_PARTICLES],
    tier: u8,
    /// Species: merge compatibility is same-tier AND same-kind now, so the
    /// repulsion opt-out below must match or a mixed-kind pair would overlap
    /// forever (each waiting for a fusion that never comes).
    kind: GooKind,
    /// `goo_body_scale(body_len)` — sizes the pair's contact skin.
    scale: f32,
    merge_ready: bool,
    /// Fusing or tethered: this blob's overlap is the POINT — never repel it.
    bonded: bool,
}

impl GooContact {
    fn of(g: &Goo) -> Self {
        let centroid = g.centroid();
        let mut reach = 0.0f32;
        for p in &g.parts {
            reach = reach.max((*p - centroid).length());
        }
        GooContact { centroid, reach, parts: g.parts, tier: g.tier, kind: g.kind, scale: goo_body_scale(g.body_len), merge_ready: goo_merge_ready(g), bonded: g.fusing > 0 || g.tether > 0 }
    }
}

/// Blob–blob contact repulsion (wu/s²) on world point `p` belonging to blob
/// `me`: a soft push away from every OTHER blob's particles within the pair's
/// contact skin (`GOO_REPEL_SKIN`, scaled to the pair), linear in overlap,
/// capped at `GOO_REPEL_MAX`. Opt-outs per the constants block above.
/// Accumulation walks the MobId-sorted snapshot in order — f32 is
/// non-associative and hashed.
fn goo_repel_at(p: Vec2, me: usize, contacts: &[GooContact]) -> Vec2 {
    let my = &contacts[me];
    if my.bonded {
        return Vec2::ZERO;
    }
    let mut acc = Vec2::ZERO;
    for (j, o) in contacts.iter().enumerate() {
        if j == me || o.bonded {
            continue;
        }
        // a merge-compatible pair may flow together (fusion handles the contact)
        if o.tier == my.tier && o.kind == my.kind && my.tier > 0 && my.merge_ready && o.merge_ready {
            continue;
        }
        let skin = GOO_REPEL_SKIN * 0.5 * (my.scale + o.scale);
        let broad = o.reach + skin;
        if (o.centroid - p).length_squared() > broad * broad {
            continue;
        }
        for q in &o.parts {
            let d = p - *q;
            let r = d.length();
            if r < skin && r > 1e-6 {
                acc += d / r * (1.0 - r / skin);
            }
        }
    }
    let mut f = acc * GOO_REPEL;
    let fl = f.length();
    if fl > GOO_REPEL_MAX {
        f *= GOO_REPEL_MAX / fl;
    }
    f
}

impl<S: AudioSink> HouseGame<S> {
    /// Live blob count INCLUDING this tick's already-queued spawns/despawns.
    /// `self.mobs` only rebuilds at the post-tick flush, so every same-tick
    /// GOO_LIVE_CAP gate must count through this — otherwise two splits (or
    /// two births) in one tick each read the same stale length, both pass,
    /// and the cap overshoots into the renderer's fixed metaball/proxy pools.
    fn goo_live_pending(&self) -> i32 {
        self.mobs.len() as i32 + self.res.pending_mob_delta
    }

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

    /// 3d. Arena integrity: every fluid particle overlapping the player
    /// pillar drains the suit and shoves the droid (fluid pressure). Runs on
    /// the tick's FRESH goo poses, right after goo_system. `None` off arena
    /// levels -> hard no-op, so the four goo oracles and every non-arena
    /// level are untouched.
    pub(crate) fn integrity_system(&mut self) {
        let Some(mut run) = self.res.run else { return };
        if run.dead || self.mobs.is_empty() {
            return;
        }
        let p = self.player_pos();
        let m = PLAYER_HALF + GOO_TOUCH_MARGIN;
        // Per-particle MASS weight: every tier carries GOO_PARTICLES(40)
        // particles — a Small just packs them tighter, so a raw count would
        // make the smallest blobs the deadliest (the inverted first cut).
        // Weighting by tier mass (Large 1.0 / Medium 0.5 / Small 0.25) makes
        // pressure proportional to how much goo is actually pressing.
        let mut w = 0.0f32;
        let mut away = Vec2::ZERO;
        for &e in &self.mobs {
            let g = self.world.get::<&Goo>(e).unwrap();
            if g.fusing > 0 {
                continue;
            }
            let wgt = goo_tier_mass(g.tier) as f32 * 0.25;
            for q in &g.parts {
                if (q.x - p.x).abs() < m && (q.y - p.z).abs() < m {
                    w += wgt;
                    away += Vec2::new(p.x - q.x, p.z - q.y) * wgt;
                }
            }
        }
        if w > 0.0 {
            // PLATING cards damp the drain (1.0 with none picked)
            run.integrity = (run.integrity - GOO_DRAIN_PER_PART * drain_mult(&self.res.picked) * w * TICK_DT).max(0.0);
            // fluid pressure shoves the droid (wall-clamped like every mover)
            let push = away.normalize_or_zero() * (GOO_CONTACT_PUSH * w).min(GOO_CONTACT_PUSH_CAP) * TICK_DT;
            if push != Vec2::ZERO {
                let (nx, nz) = collide_and_slide(|x, z| self.walk_blocked(x, z), p.x, p.z, push.x, push.y);
                self.world.get::<&mut Pos>(self.player).unwrap().0 = Vec3::new(nx, p.y, nz);
            }
            if run.integrity <= 0.0 {
                run.dead = true;
                run.death_tick = self.res.cur_tick;
                self.res.events.emit(GameEvent::PlayerDown);
            }
        }
        else {
            // NANO REPAIR: the hull regrows while nothing is touching it
            // (0.0/s without the card — exact no-op on the sub, and the
            // branch only runs on arena levels)
            let regen = regen_rate(&self.res.picked);
            if regen > 0.0 {
                run.integrity = (run.integrity + regen * TICK_DT).min(1.0);
            }
        }
        self.res.run = Some(run);
    }

    /// Push any predicted particle position `xp[i]` that landed inside a solid
    /// back out, axis by axis (X tried before Z — the order is deterministic and
    /// hashed), falling back to the pre-step position when neither axis frees it.
    /// `orig` is the blob's particle positions from the start of the tick.
    fn goo_clamp_to_solids(&self, xp: &mut [Vec2; GOO_PARTICLES], orig: &[Vec2; GOO_PARTICLES]) {
        for i in 0..GOO_PARTICLES {
            if self.goo_solid(xp[i].x, xp[i].y) {
                let o = orig[i];
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

    /// FUSING step: a blob collapsing into a merge survivor. Ooze its particles
    /// toward the fusion point and deflate it (render size follows `body_len`),
    /// then despawn when the collapse completes. Returns `true` if the blob is
    /// fusing (the caller writes it back and skips the rest of the tick — no
    /// AI/gait/PBF while it just flows in and shrinks out). Verbatim extraction.
    fn goo_step_fusing(&mut self, e: Entity, g: &mut Goo) -> bool {
        if g.fusing == 0 {
            return false;
        }
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
            self.res.pending_mob_delta -= 1;
        }
        true
    }

    /// MITOSIS / MOTHER-GRAVITY step. A Large (tier-0) mother counts down to
    /// budding off a mini (drawing RNG in a fixed order, spawning via the buffer);
    /// every smaller blob instead feels the inverse-square pull of any mother
    /// whose well it sits in (unless still birth-immune). Returns the net
    /// mother-gravity acceleration on this blob. `mothers` is the MobId-sorted
    /// centroid snapshot — accumulating over it in order is hash-load-bearing.
    /// Verbatim extraction: RNG draw count/order and float ops are unchanged.
    fn goo_step_mitosis(&mut self, g: &mut Goo, mothers: &[Vec2]) -> Vec2 {
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
            // sterile film stages freeze the bud clock (never reaches 0)
            if !self.res.sterile {
                g.spawn_timer = g.spawn_timer.saturating_sub(1);
            }
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
                // Enter gestation ONLY if the birth could actually land right
                // now: at the cap the whole cycle waits instead. Gating here
                // (not just at the birth tick) is what keeps a full nest from
                // playing phantom labor — a mother straining, glowing amber
                // and clenching for a second, then producing nothing.
                if self.goo_live_pending() < GOO_LIVE_CAP as i32 {
                    // the bud forms toward the CAMERA so the birth always plays
                    // out clearly in view (in front of the mother, not
                    // occluded). The iso view sits in the +X+Z octant at yaw
                    // 45°, so world (+X,+Z) — angle π/4 — faces the viewer; a
                    // small random jitter (±~27°) keeps successive births from
                    // looking identical.
                    let a = std::f32::consts::FRAC_PI_4 + (self.res.rng.next_f32() - 0.5) * (std::f32::consts::PI * 0.30);
                    g.spawn_dir = Vec2::new(a.cos(), a.sin());
                } else {
                    g.spawn_timer = GOO_SPAWN_PERIOD; // full nest: try next cycle
                }
            }
            if g.spawn_timer == 0 {
                // BIRTH — skipped (and the timer waits a full cycle) if the cap
                // filled up DURING gestation (a shot-split), so mitosis never
                // outruns the renderer's metaball pool. Rare now that gestation
                // entry is gated; the afterglow below still fades the already-
                // played gestation glow out smoothly rather than cutting it.
                if self.goo_live_pending() < GOO_LIVE_CAP as i32 {
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
                    // Buds inherit the mother's species.
                    let mut baby = fresh_goo(cid, GOO_BIRTH_TIER, g.kind, site, dir, Vec2::ZERO, timer);
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
                    self.res.pending_mob_delta += 1;
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
            for &mc in mothers {
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
        mother_acc
    }

    /// AI step: pick a travel direction (wander/seek/idle) and steer the head
    /// heading toward it. Draws RNG for the wander/idle re-rolls in a FIXED order
    /// (count and order are hash-load-bearing — see the oracle). Returns
    /// `(mv, speed)`: the move gate (0 while Idle) and this tier's crawl speed.
    /// Verbatim extraction.
    fn goo_step_ai(&mut self, g: &mut Goo, pxz: Vec2, aggro2: f32) -> (f32, f32) {
        // arena levels run the tactics brain instead (game/tactics.rs): the
        // legacy wander/seek below stays VERBATIM (same float ops, same RNG
        // draw order) for every pre-arena level, so the oracles never move.
        if self.res.arsenal.is_some() {
            return self.goo_step_ai_arena(g, pxz);
        }
        // species multipliers — Green is exactly 1.0 across the board, so this
        // block is a bit-exact no-op on all-Green (pre-kind) levels
        let (kind_speed, kind_turn, kind_aggro) = goo_kind_moves(g.kind);
        let aggro2 = aggro2 * (kind_aggro * kind_aggro);
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
            g.heading = rotate_toward(g.heading, td, GOO_MAX_TURN * kind_turn);
        }
        let mv = if g.state == GooState::Idle { 0.0 } else { 1.0 };
        // cure stiffens the legs: −20 %/stack, floored (cure 0 is exactly ×1.0)
        let cure_mul = (1.0 - GOO_CURE_SLOW * g.cure as f32).max(0.4);
        let speed = goo_tier_speed(g.tier) * kind_speed * cure_mul;
        (mv, speed)
    }

    /// HEAD anchor step: Verlet inertia + steering drive + trap/mother pull,
    /// resolved through `collide_and_slide` so walls stop it like the player. The
    /// drive surges with the lunge (`stretch`) so the creature pushes off each
    /// gait cycle rather than gliding. `contact` is the blob–blob repulsion
    /// sampled at the head — folded in like the trap pull so the whole SPINE
    /// deflects off another body (fluid-only repulsion would leave the capsule
    /// attractor driving the fluid into the foreign body it's pushed out of).
    #[allow(clippy::too_many_arguments)]
    fn goo_step_head_anchor(&self, g: &mut Goo, speed: f32, mv: f32, stretch: f32, tension: f32, well: f32, mother_acc: Vec2, contact: Vec2) {
        // contact YIELD: a body pressing into another cannot push through — the
        // drive stalls with contact pressure and the heading is physically
        // rotated toward the push, so a head-on pair slides apart around each
        // other instead of grinding at a force equilibrium mid-overlap. The
        // contact turn is 2× the AI turn rate: `goo_step_ai` re-aims at the
        // wander target by GOO_MAX_TURN every tick, so an equal rate would
        // cancel to zero net rotation and the stalemate would hold.
        let yield_k = (contact.length() / GOO_REPEL_MAX).min(1.0);
        if let Some(pd) = contact.try_normalize() {
            g.heading = rotate_toward(g.heading, pd, GOO_MAX_TURN * 2.0 * yield_k);
        }
        let inertia = (g.ends[0] - g.ends_prev[0]) * GOO_VERLET_DECAY * GOO_HEAD_INERTIA;
        // she all but stops crawling while she pushes (tension → 0 drive)
        let drive = g.heading * (speed * mv * (0.5 + 0.5 * stretch) * (1.0 - 0.85 * tension) * (1.0 - 0.9 * yield_k) * TICK_DT);
        let d = inertia + drive + (self.trap_accel(g.ends[0]) * well + mother_acc + contact) * GOO_END_TRAP;
        let (nx, nz) = collide_and_slide(|x, z| self.goo_solid(x, z), g.ends[0].x, g.ends[0].y, d.x, d.y);
        g.ends_prev[0] = g.ends[0];
        g.ends[0] = Vec2::new(nx, nz);
    }

    /// TAIL anchor step: Verlet + trap/mother pull, then a distance constraint
    /// holding the tail the (gait-modulated) `gait_len` behind the head. As
    /// `gait_len` shrinks the tail catches up (round-up); as it grows the body
    /// extends (the inchworm reach). The constrained move is resolved through
    /// `collide_and_slide` like the head — an unclamped tail could pin inside
    /// a wall, dragging the capsule attractor in with it, and the fluid would
    /// grind against the wall clamp every solver iteration instead of settling
    /// flush. (The spine re-tensions next tick; the constraint is soft across
    /// a wall contact.)
    fn goo_step_tail_anchor(&self, g: &mut Goo, gait_len: f32, well: f32, mother_acc: Vec2, contact: Vec2) {
        let tail_d = (g.ends[1] - g.ends_prev[1]) * GOO_VERLET_DECAY + (self.trap_accel(g.ends[1]) * well + mother_acc + contact) * GOO_END_TRAP;
        let old = g.ends[1];
        g.ends_prev[1] = old;
        let free = old + tail_d;
        let span = free - g.ends[0];
        let dist = span.length().max(1e-5);
        let want = g.ends[0] + span * (gait_len / dist);
        let (nx, nz) = collide_and_slide(|x, z| self.goo_solid(x, z), old.x, old.y, want.x - old.x, want.y - old.y);
        g.ends[1] = Vec2::new(nx, nz);
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
        // start-of-tick contact snapshot (index-aligned with `mobs`): every blob
        // repels against these frozen clouds, so blob A stepping before blob B
        // in the MobId order doesn't skew the pair force.
        let contacts: Vec<GooContact> = mobs.iter().map(|&e| GooContact::of(&self.world.get::<&Goo>(e).unwrap())).collect();
        for (mi, &e) in mobs.iter().enumerate() {
            // lift the blob out as a local copy: mutating it in place would
            // hold a World borrow across the collide closure (which borrows
            // &self) and the RNG draws (which borrow &mut self.res).
            let mut g = *self.world.get::<&Goo>(e).unwrap();

            // --- FUSING: a blob collapsing into a survivor handles its whole
            // tick here (ooze in + deflate + despawn) and skips AI/gait/PBF. ---
            if self.goo_step_fusing(e, &mut g) {
                *self.world.get::<&mut Goo>(e).unwrap() = g;
                continue;
            }

            // --- MITOSIS / MOTHER-GRAVITY: a Large mother counts down to budding;
            // a smaller blob feels the pull of any mother well it sits in. ---
            let mother_acc = self.goo_step_mitosis(&mut g, &mothers);
            // a birth-immune newborn ignores EVERY external well — the mother's
            // gravity (already gated above) AND any trap it buds inside — so it
            // pops cleanly off her instead of being recaptured by the nest.
            let well = if g.birth_immune { 0.0 } else { 1.0 };

            // birth-EFFORT envelope (mothers only): tension ramps in through the
            // final push of gestation, peaks at birth, then relaxes back out over
            // the afterglow. It shrinks/clenches the body and stalls her crawl —
            // the visible "push". Shared with the snapshot so render size matches.
            let tension = goo_tension(g.tier, g.spawn_timer, g.birth_glow);

            // --- AI: pick a target travel direction, steer the head heading. ---
            let (mut mv, speed) = self.goo_step_ai(&mut g, pxz, aggro2);

            // --- HARPOON PIN: a pinned blob's crawl drive is cut and a stiff
            // spring hauls the whole body back to the nail point. The AI still
            // ran above — its RNG draw order is hash-load-bearing — the blob
            // just strains against the pin instead of going anywhere. The
            // spring rides the mother-well channel (spine ends ×GOO_END_TRAP +
            // fluid direct) so it needs no new force plumbing, and is capped
            // like every external well so the solver regime holds. ---
            let pin_acc = if g.pinned > 0 {
                g.pinned -= 1;
                mv = 0.0;
                let d = (g.pin_pt - g.centroid()) * GOO_PIN_PULL;
                let dl = d.length();
                if dl > GOO_TRAP_MAX {
                    d * (GOO_TRAP_MAX / dl)
                } else {
                    d
                }
            } else {
                Vec2::ZERO
            };
            // the pin spring joins the mother-well channel: every downstream
            // consumer (head/tail anchors, fluid) already sums mother_acc.
            // Adding ZERO is bit-exact — unpinned blobs are untouched.
            let mother_acc = mother_acc + pin_acc;

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

            // --- head anchor (Verlet + steering drive + trap/mother/contact
            // pull, resolved through collide_and_slide), then the trailing tail
            // anchor pinned `gait_len` behind it (the squash-and-stretch
            // inchworm reach). Contact repulsion is sampled at each end so the
            // spine itself deflects off another body, not just the fluid. ---
            let contact_ends = [goo_repel_at(g.ends[0], mi, &contacts), goo_repel_at(g.ends[1], mi, &contacts)];
            self.goo_step_head_anchor(&mut g, speed, mv, stretch, tension, well, mother_acc, contact_ends[0]);
            self.goo_step_tail_anchor(&mut g, gait_len, well, mother_acc, contact_ends[1]);

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
                a += goo_repel_at(p, mi, &contacts); // blob–blob contact push
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
                let lambda = goo_pbf_lambda(&xp, rho0, h);
                goo_pbf_correct(&mut xp, &lambda, rho0, h, g_scale, scorr_denom);
                // walls + player pillar: keep the fluid out of solids (per-axis
                // slide back), so the body drapes against geometry and the player.
                self.goo_clamp_to_solids(&mut xp, &g.parts);
            }
            // velocity from the solved motion, then XSPH viscosity for cohesion
            for i in 0..GOO_PARTICLES {
                g.vel[i] = (xp[i] - g.parts[i]) / dt;
            }
            goo_xsph_viscosity(&mut g.vel, &xp, h);
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
    pub(crate) fn damage_goo(&mut self, e: Entity, hit: Vec3, dir: Vec3, damage: u16, knockback: f32, class: WeaponClass) {
        let (id, tier, kind, cure0, centroid) = {
            let g = self.world.get::<&Goo>(e).unwrap();
            // hp 0 = already killed THIS tick (the despawn queues at the flush,
            // so a second projectile still finds the body in `self.mobs`).
            // Without this guard the corpse dies again: a duplicate despawn,
            // a SECOND split (four children), and doubled events/audio.
            if g.hp == 0 {
                return;
            }
            (g.id, g.tier, g.kind, g.cure, g.centroid())
        };
        // species resistance: exact integer scaling, floored at 1 so every hit
        // at least chips (a Tank under uzi fire dies slowly, not never)
        let (mn, md) = goo_kind_damage_mult(kind, class);
        let damage = ((damage as u32 * mn as u32 / md as u32) as u16).max(1);
        let kdir = Vec2::new(dir.x, dir.z).normalize_or_zero();
        let hit_xz = Vec2::new(hit.x, hit.z);
        let reach = goo_tier_radius(tier).max(0.2);
        let dead = {
            let mut g = self.world.get::<&mut Goo>(e).unwrap();
            g.hp = g.hp.saturating_sub(damage);
            // the harpoon's payload: nail the body to where it stands (a dying
            // blob skips it — the pin would evaporate with the split anyway)
            if class == WeaponClass::Harpoon && g.hp > 0 {
                g.pinned = GOO_PIN_TICKS;
                g.pin_pt = centroid;
            }
            // the slug's payload: a cure stack per hit (counted even on the
            // killing blow — the death path below reads it for solidify)
            if class == WeaponClass::Slug {
                g.cure = (g.cure + 1).min(GOO_CURE_MAX);
            }
            // momentum transfer: push the fluid along the slug's heading, weighted
            // by closeness to the impact point so the hit side caves/sprays.
            g.ends_prev[0] -= kdir * (0.05 * knockback);
            for i in 0..GOO_PARTICLES {
                let w = (1.0 - (g.parts[i] - hit_xz).length() / reach).clamp(0.0, 1.0);
                g.vel[i] += kdir * (knockback * w);
            }
            // crater burst (2026-07-04): particles near the impact ALSO fly
            // radially away from the strike point — the hit side visibly
            // caves in and sprays sideways before the PBF density reflows
            // it. w² concentrates the burst at the entry wound; particles
            // exactly on the hit point fall back to the slug heading.
            for i in 0..GOO_PARTICLES {
                let d = g.parts[i] - hit_xz;
                let r = d.length();
                let w = (1.0 - r / reach).clamp(0.0, 1.0);
                let out = if r > 1e-4 { d / r } else { kdir };
                g.vel[i] += out * (knockback * GOO_CRATER_FRAC * w * w);
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
        // every damaging hit splashes fluid (presentation-only; the shell
        // scales its droplet spray from the punch — a killing blow tears the
        // body open, so it sprays harder)
        let punch = if dead { knockback * 1.6 } else { knockback };
        self.res.events.emit(GameEvent::GooSplashed(id, hit, dir, punch));
        if !dead {
            self.res.events.emit(GameEvent::MobHit(id, hit_evt));
            return;
        }
        // death — remove the parent at the flush
        self.res.buf.despawn(e);
        self.res.mobs_dirty = true;
        self.res.pending_mob_delta -= 1;
        // SOLIDIFIED death: a body that dies with enough cure stacks leaves a
        // dead solid CHUNK (an inert obstacle) and a single small escapee —
        // the un-cured remainder squirming free — instead of splitting in two.
        // The cure counted on the killing blow too (cure0 read pre-hit, +1 if
        // this was a slug). Degrades to a plain kill at the chunk cap, or if
        // the chunk would form ON the player (never wall someone in), or on a
        // terminal Small (no mass worth a chunk).
        let cure_now = if class == WeaponClass::Slug { (cure0 + 1).min(GOO_CURE_MAX) } else { cure0 };
        if cure_now >= GOO_CURE_CHUNK && tier < 2 && self.res.chunks.len() < GOO_CHUNK_CAP {
            let half = goo_tier_radius(tier) * GOO_CHUNK_FRAC;
            let p = self.player_pos();
            let clear = PLAYER_HALF + 0.1;
            let on_player = p.x > centroid.x - half - clear && p.x < centroid.x + half + clear && p.z > centroid.y - half - clear && p.z < centroid.y + half + clear;
            if !on_player {
                self.res.chunks.push([centroid.x - half, centroid.y - half, centroid.x + half, centroid.y + half]);
                // one escapee (tier down), popped out past the chunk edge along
                // the slug heading — if the cap has room for it
                if self.goo_live_pending() + 1 <= GOO_LIVE_CAP as i32 {
                    let cid = MobId(self.res.next_mob_id);
                    self.res.next_mob_id += 1;
                    let d = kdir.try_normalize().unwrap_or(Vec2::X);
                    let chead = centroid + d * (half + goo_tier_radius(tier + 1) * 0.8);
                    let timer = 20 + (self.res.rng.next_f32() * 60.0) as u16;
                    self.res.buf.spawn((fresh_goo(cid, tier + 1, kind, chead, d, d * 0.05, timer),));
                    self.res.pending_mob_delta += 1;
                }
                if self.res.arsenal.is_some() {
                    // biomass: solidify pays 2x the NET mass removed (the
                    // body minus its escapee) — the committed-play premium
                    self.res.score += 2 * (goo_tier_mass(tier) - goo_tier_mass(tier + 1));
                }
                self.res.events.emit(GameEvent::MobSolidified(id, hit_evt));
                return;
            }
        }
        // Small is terminal; an over-cap split also degrades to a plain kill so
        // division can never outrun the renderer's instance pool (the pending
        // delta counts this tick's other queued splits/births toward the cap).
        let live_after_split = self.goo_live_pending() + 2;
        if tier >= 2 || live_after_split > GOO_LIVE_CAP as i32 {
            if self.res.arsenal.is_some() {
                // biomass: a terminal kill removes the whole body's mass
                self.res.score += goo_tier_mass(tier);
            }
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
            // children inherit the species — a Tank splits into small Tanks
            self.res.buf.spawn((fresh_goo(cid, tier + 1, kind, chead, d, vel, timer),));
            self.res.pending_mob_delta += 1;
        }
        // a split pays NOTHING: no mass left the board, it just got angrier
        // (the biomass economy's core lesson, priced in from the first uzi)
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
        let mut found: Option<(Entity, Entity, MobId, u8, Vec2)> = None;
        'scan: for a in 0..mobs.len() {
            let ga = *self.world.get::<&Goo>(mobs[a]).unwrap();
            if ga.tier == 0 || !goo_merge_ready(&ga) {
                continue; // Large can't grow; newborns/fusing blobs are immune
            }
            let ca = ga.centroid();
            let touch = goo_tier_radius(ga.tier) * GOO_MERGE_FRAC;
            for b in (a + 1)..mobs.len() {
                let gb = *self.world.get::<&Goo>(mobs[b]).unwrap();
                if gb.tier != ga.tier || gb.kind != ga.kind || !goo_merge_ready(&gb) {
                    continue; // same tier AND species only, both past grace / not fusing
                }
                let cb = gb.centroid();
                if (ca - cb).length() < touch {
                    // midpoint kept as the exact `(ca + cb) * 0.5` — f32 is
                    // non-associative, so this expression is hashed verbatim.
                    found = Some((mobs[a], mobs[b], ga.id, ga.tier, (ca + cb) * 0.5));
                    break 'scan;
                }
            }
        }
        let Some((ea, eb, id_a, tier, mid)) = found else {
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

    /// 5b. WAVE DIRECTOR (arena levels): while the floor holds no live blob
    /// (and none is queued this tick), a lull counts down; at zero the next —
    /// bigger, mixed-species — squad lands on the north entrance ring. Spawn
    /// placement is id-hash scattered (RNG-free); headings/timers draw the
    /// shared RNG in fixed order exactly like authored spawns. No-op (and no
    /// state touch) on non-arena levels: `wave` is None there.
    pub(crate) fn wave_system(&mut self) {
        let Some(mut w) = self.res.wave else { return };
        if !self.mobs.is_empty() || self.res.pending_mob_delta != 0 || self.res.mobs_dirty {
            // not clear: keep the countdown armed at full for the next clear
            w.lull = w.lull_full;
            self.res.wave = Some(w);
            return;
        }
        if w.lull > 0 {
            if w.lull == w.lull_full {
                self.open_draft(); // the clear just landed: deal the lull hand
            }
            w.lull -= 1;
            self.res.wave = Some(w);
            return;
        }
        w.idx += 1;
        w.lull = w.lull_full;
        self.res.draft = None; // the hand expires when the next squad lands
        // squad size grows with the wave, capped well under GOO_LIVE_CAP so
        // splits/mitosis have headroom before the renderer pool ceiling
        let count = (3 + w.idx as u32).min(GOO_LIVE_CAP as u32 - 2);
        for i in 0..count {
            let cid = MobId(self.res.next_mob_id);
            self.res.next_mob_id += 1;
            // entrance ring over the north semicircle (z < 0), fanned by slot
            // with a small id-hash jitter so waves never stamp the same line
            let jit = (((cid.0.wrapping_mul(ID_HASH_STRIDE)) >> 8) & 0xff) as f32 / 255.0 - 0.5;
            let a = std::f32::consts::PI * (1.0 + (i as f32 + 0.5 + jit * 0.5) / count as f32);
            let head = Vec2::new(a.cos(), a.sin()) * GOO_WAVE_RING;
            // composition: mediums anchor, smalls swarm, and from wave 2 on
            // the third slot is a MOTHER (kill her first or she out-breeds you)
            let tier = if w.idx >= 2 && i == 2 { 0 } else if i % 3 == 0 { 1 } else { 2 };
            let kind = match (w.idx as u32 + i) % 3 {
                0 => GooKind::Green,
                1 => GooKind::Runner,
                _ => GooKind::Tank,
            };
            let hd = self.res.rng.next_f32() * std::f32::consts::TAU;
            let heading = Vec2::new(hd.cos(), hd.sin());
            let timer = 60 + (self.res.rng.next_f32() * 120.0) as u16;
            self.res.buf.spawn((fresh_goo(cid, tier, kind, head, heading, Vec2::ZERO, timer),));
            self.res.pending_mob_delta += 1;
            self.res.mobs_dirty = true;
        }
        self.res.wave = Some(w);
    }
}
