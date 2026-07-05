//! Goo TUNING — every `GOO_*` knob plus the per-tier / per-kind balance
//! tables (pure data and tiny table accessors; no sim state, no float-order
//! coupling). Split out of `goo/mod.rs` as pure motion so the solver/system
//! code reads without the wall of knobs. The determinism contract is
//! unchanged: these values feed the hashed sim — retune in small steps and
//! re-capture the `goo_sim_hash_oracle_*` constants when a change is
//! intentional (with a dated note saying why).
use super::*;

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
/// G3: extra spine shortening while a Runner holds `Tactic::Windup` — the
/// pre-sprint crouch draws the body under its contracted rest length so the
/// pounce telegraph reads in silhouette. Only Windup blobs ever multiply it.
pub const GOO_WINDUP_CLENCH: f32 = 0.72;
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
/// The wave whose landing kills the pit lamps (the run's third act).
pub const LIGHTS_OUT_WAVE: u16 = 3;
/// Escaped tier mass that ends a containment run (4 Larges, 16 Smalls...).
pub const BREACH_CAP: u32 = 16;
/// Waves to survive to CLEAR the shift — the run's win condition.
pub const SHIFT_WAVES: u16 = 8;
/// L1: ticks before a squad lands that `WaveIncoming` fires — the shell's
/// klaxon + entrance-pad pulse window (the countdown the body can feel).
pub const WAVE_TELEGRAPH_TICKS: u16 = 60;

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

/// Per-blob fluid length scale by tier: R0/√2 per tier, matching the body
/// radius. Scaling BOTH the smoothing radius `h` and the rest spacing by this
/// leaves the rest density (a function of their ratio) unchanged — so the PBF
/// solver stays in its tuned-stable regime — while the equilibrium footprint
/// shrinks with the tier. A tier-2 mini packs into half a tier-0's spread.
pub fn goo_tier_scale(tier: u8) -> f32 {
    std::f32::consts::FRAC_1_SQRT_2.powi(tier as i32)
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
pub(super) fn goo_tier_hp(tier: u8) -> u16 {
    GOO_TIER_HP[(tier as usize).min(2)]
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
pub(super) const GOO_PIN_PULL: f32 = 14.0;

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
pub(super) const GOO_WAVE_RING: f32 = 7.0;
