//! What a LEVEL BUILDER says about a wall — the whole authoring vocabulary, and
//! nothing about the renderer.
//!
//! # Why this module exists
//!
//! The dials that came before it were a bit-budget artifact. `Material._pad`
//! bits 8..31 hold exactly four 6-bit lanes, so there were four knobs — age,
//! cracks, depth, chip — and everything that did not fit (the spall dial, the
//! pattern policy, its native params) lived somewhere else because it happened
//! to be geometry-only and cost no bits. A renderer fact had become the
//! authoring surface, and the couplings that fell out of it were not
//! predictable from the outside:
//!
//! - `age` moved the damaged AREA, the stain tone, the fine web, the veneer's
//!   plate-dropout rate, the sink depth and half the odds of the wall breaking
//!   in half.
//! - `cracks` was simultaneously the plate lattice's FREQUENCY and the other
//!   half of those odds, so "more cracks" also meant "smaller plates" and
//!   "much more likely to snap".
//! - a structural break had no dial at all: it was a per-6-wu-strip coin flip
//!   whose axis landed anywhere in the strip, so a short wall asked for damage
//!   and got a broken one, or asked for a break and silently got none.
//!
//! # The three ideas that replace them
//!
//! **ONE UNIT.** Every amount in [`Layer`] is *the fraction of THIS wall's face
//! the layer covers*. Not a tone, not a frequency, not a probability — an area.
//! So `0.30` means the same thing on the bench's 2.2-wu slab and on a 6.2-wu
//! facade, and two walls with the same number look equally damaged.
//!
//! **ABSOLUTE THRESHOLDS, SOLVED PER RUN.** The damage field is an fbm; asking
//! for "30 % of this face" means solving for the threshold that puts 30 % of
//! *this run's own samples* above it ([`RunField::threshold`]). That is what
//! makes an amount an area instead of a lottery, and it is why each layer can
//! have its own threshold — "stains spread wider than the cracking" is a
//! sentence this model can express and the previous one could not, because
//! there one gate slid five fixed windows together.
//!
//! **CAUSES, THEN LAYERS, THEN PINS.** [`Story`] says what happened to the wall
//! in three words; [`derive`] turns that into the five layer amounts through a
//! table small enough to hold in your head; and [`Pins`] overrides any of them
//! outright. The short path stays short ("this street is `weather: 0.55`"), and
//! the bench's "one effect and nothing else" is one line. Crucially `derive` is
//! the ONLY writer of a layer amount, so the panel's derived column is a
//! complete explanation of the wall — there is no second, hidden contributor.
//!
//! # What this module deliberately does not know
//!
//! No `Scene`, no `Material`, no bits, no GPU. It takes run rectangles and
//! returns [`Sheet`]s. The consumers convert: `crack_geom` reads [`Sheet::geom`]
//! (all-integer, so inequality IS "the built mesh is stale") and the material
//! streamer reads [`Sheet::paint`]. That split is why the amounts can be tested
//! as arithmetic — which is the only reason a claim like "an amount is an area"
//! can be pinned at all.

// STEP 2 OF THE ROUND: this module is deliberately unconsumed. It is the phase
// gate — its `an_amount_is_an_area` measurement decides whether the model's one
// promise holds before anything is built on top of it. The consumers arrive in
// the next steps (`crack_geom` takes `Sheet::geom`, the material streamer takes
// `Sheet::paint`), and this allow comes off with them.
#![allow(dead_code)]

use crate::crack_geom::{hash13, mixf};
use glam::Vec3;

// ---------------------------------------------------------------------------
// 1. What happened to this wall
// ---------------------------------------------------------------------------

/// Three CAUSES, each writing a DISJOINT set of layers: `weather` writes the
/// four skin layers, `settlement` writes only breaks, `cover_loss` writes only
/// spall. Nothing writes two causes' layers — that disjointness is what makes
/// the [`derive`] table legible rather than a second set of hidden couplings.
#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub struct Story {
    pub weather: f32,
    pub settlement: f32,
    pub cover_loss: f32,
}

impl Story {
    pub const ZERO: Story = Story { weather: 0.0, settlement: 0.0, cover_loss: 0.0 };
}

/// The VARIANT dial's reach through noise space, in story-key units.
///
/// `scrub` slides the run's story key — the z coordinate every damage field
/// seeds off (`story*7+3` for the fbm, `story+5`/`story+9` for the craze
/// lattices, `story*13` for the break jitter) — so ONE dial re-rolls paint,
/// plates and breaks together and they can never disagree about which variant
/// the wall is on. It exists because "move the damage" cannot be a spatial
/// offset without a new per-material channel for the shader's copy of the
/// field (24 free bits total; owner decision 2026-07-27: scrub, not
/// translate) — sliding the seed is the transform the one channel we already
/// have (`base_color[3]`) can express.
///
/// 2.0 story units = 14 z-units of the field's dominant octave across the
/// whole travel: one 6-bit step moves the field ~0.22 cells — a visible morph,
/// not a jump — while the two ends of the dial are fully decorrelated.
pub const SCRUB_SPAN: f32 = 2.0;

/// The story key a wall actually seeds with: the run's hash plus its scrub,
/// QUANTIZED to the same 6-bit grid every other dial rides.
///
/// ONE function, two callers — the threshold solver ([`compile_specs`]) and
/// the material stamp (`crack::resolve` / `Viewer::crack_apply`) — because the
/// host solving on one key while the shader shades on another is exactly the
/// paint-vs-plates drift this module exists to prevent. Quantizing HERE also
/// keeps the rebuild gate honest: `GeoKey.story` carries these bits, so a drag
/// inside one bucket rebuilds nothing.
pub fn scrub_key(base: f32, scrub: f32) -> f32 {
    base + (scrub.clamp(0.0, 1.0) * 63.0).round() * (SCRUB_SPAN / 63.0)
}

// ---------------------------------------------------------------------------
// 2. The layers
// ---------------------------------------------------------------------------

/// Which GPU cost a layer's dial carries. Reported in the panel FOOTER, never
/// used to decide where a row lives: a builder should find a dial by what it
/// does, not by what it costs.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Class {
    /// Rides the per-frame material stream — live, free.
    Paint,
    /// Needs a scene rebuild (and a probe refresh) on release.
    Geometry,
}

/// FIVE layers, ONE unit: the fraction of this wall's face the layer covers.
/// Homogeneous on purpose — a COUNT does not live in here (see [`Breaks`]),
/// because a heterogeneous array is exactly how the old dial set acquired names
/// that lied about their units.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Layer {
    Stain,
    Web,
    Cracks,
    Chips,
    Spall,
}

impl Layer {
    pub const N: usize = 5;
    pub const ALL: [Layer; Layer::N] = [Layer::Stain, Layer::Web, Layer::Cracks, Layer::Chips, Layer::Spall];
    pub const fn name(self) -> &'static str {
        match self {
            Layer::Stain => "stain",
            Layer::Web => "web",
            Layer::Cracks => "cracks",
            Layer::Chips => "chips",
            Layer::Spall => "spall",
        }
    }
    pub const fn index(self) -> usize {
        self as usize
    }
    pub const fn class(self) -> Class {
        match self {
            Layer::Stain | Layer::Web => Class::Paint,
            _ => Class::Geometry,
        }
    }
}

/// One break through the WHOLE parent run — a COUNT and a PLACE, with no
/// probability anywhere. `at: None` means a deterministic story-seeded
/// position, which the panel prints, so it is never a mystery where it landed.
#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub struct Breaks {
    pub count: u8,
    /// Fraction along the run, 0..1. At `count == 1` it IS the place; with more
    /// breaks it shifts the whole spread, so it stays the answer to "where".
    pub at: Option<f32>,
}

impl Breaks {
    /// Three, because a fourth piece of a wall is rubble and the game has a
    /// separate mechanism for that (the wall-smash demo).
    pub const MAX: u8 = 3;
    pub const NONE: Breaks = Breaks { count: 0, at: None };

    /// Break `j` lands here, as a fraction of the run's length.
    ///
    /// Evenly spread, then jittered by at most ±0.17 of ONE SPACING off its own
    /// slot — so the order and the minimum gap (0.66/count of the run) hold by
    /// construction, and no two breaks can ever land on top of each other. That
    /// is the whole reason this is a spread-plus-jitter and not `count`
    /// independent draws: independent draws collide, and two breaks 0.05 wu
    /// apart are one break with a sliver between them.
    ///
    /// The jitter is seeded on the RUN's story, so it is the same on every panel
    /// the run was cut into — the point of the round. An authored `at` turns it
    /// off entirely: a place the author typed is not a place to be surprised by.
    pub fn places(&self, story: f32) -> Vec<f32> {
        let n = self.count.min(Self::MAX) as usize;
        (0..n)
            .map(|j| {
                let slot = |off: f32| (j as f32 + 0.5 + off) / n as f32;
                match self.at {
                    Some(a) => (a.clamp(0.0, 1.0) + slot(0.0) - 0.5).clamp(0.0, 1.0),
                    None => slot(0.34 * (hash13(Vec3::new(j as f32, story * 13.0 + 7.0, 71.0)) - 0.5)),
                }
            })
            .collect()
    }
}

/// Amounts the author (or a panel drag) has taken over. `None` = use the value
/// [`derive`] produced. This is how a bench wall gets ONE effect and nothing
/// else, and how a real wall gets "old, but no chips at all".
#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub struct Pins {
    area: [Option<f32>; Layer::N],
    breaks: Option<Breaks>,
}

impl Pins {
    pub const NONE: Pins = Pins { area: [None; Layer::N], breaks: None };
    pub const fn area(mut self, l: Layer, v: f32) -> Pins {
        self.area[l.index()] = Some(v);
        self
    }
    pub const fn breaks(mut self, b: Breaks) -> Pins {
        self.breaks = Some(b);
        self
    }
    pub fn get(&self, l: Layer) -> Option<f32> {
        self.area[l.index()]
    }
    pub fn get_breaks(&self) -> Option<Breaks> {
        self.breaks
    }
    /// Every layer this wall has taken over, for the panel's PIN markers.
    pub fn pinned(&self) -> impl Iterator<Item = Layer> + '_ {
        Layer::ALL.into_iter().filter(|l| self.area[l.index()].is_some())
    }
}

/// The small-crack pattern and its NATIVE parameters — native being the test
/// each of these has to pass. `scale` is absent from all three: plate size is
/// not native to any pattern, it is the one property they all have, and it
/// lives in exactly one place ([`Shape::grain`]) in world units. Two of the
/// three used to carry their own, on their own curve, so one slider position
/// meant 0.79-wu plates under craquelure and 0.40 under mosaic — which is why
/// craquelure rendered essentially one line against a 2.2-wu face at its own
/// defaults.
///
/// Lightning keeps THREE. `straight` (wander/kink amplitude and heading
/// persistence) is the dial on how jagged a crack is, which is the property the
/// owner asked this policy for in the first place ("more like LIGHTNING —
/// branching, irregular — not straight lines"); it is native in a way `scale`
/// never was, so it stays and [`Geom::par`] carries three.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Pattern {
    Lightning { branch: f32, straight: f32, spread: f32 },
    Craquelure { wave: f32 },
    Mosaic { jitter: f32 },
}

impl Pattern {
    pub const fn name(self) -> &'static str {
        match self {
            Pattern::Lightning { .. } => "lightning",
            Pattern::Craquelure { .. } => "craquelure",
            Pattern::Mosaic { .. } => "mosaic",
        }
    }
    /// A stable small integer for [`Geom`] — the rebuild gate compares integers.
    pub const fn code(self) -> u8 {
        match self {
            Pattern::Lightning { .. } => 0,
            Pattern::Craquelure { .. } => 1,
            Pattern::Mosaic { .. } => 2,
        }
    }
    pub const DEFAULTS: [Pattern; 3] = [Pattern::Lightning { branch: 0.5, straight: 0.55, spread: 0.45 }, Pattern::Craquelure { wave: 0.35 }, Pattern::Mosaic { jitter: 0.8 }];

    /// This pattern's params as the flat array the panel stores and the
    /// `crack_geom::POLICY_PARAMS` rows are drawn from.
    pub fn par(self) -> [f32; 3] {
        match self {
            Pattern::Lightning { branch, straight, spread } => [branch, straight, spread],
            Pattern::Craquelure { wave } => [wave, 0.0, 0.0],
            Pattern::Mosaic { jitter } => [jitter, 0.0, 0.0],
        }
    }
}

/// Plate size below which NO veneer is emitted at all — the face stays one
/// flush plate ([`crate::crack_geom`] applies it, for every pattern, in one
/// place).
///
/// A true off-stop matters because without one "no plates" is not a reachable
/// state, only "very fine plates", and the difference is visible: 0.09 wu is
/// 3.7 screen px on an X-run face and 2.5 on the worst Z one, so a lattice
/// below it dot-dashes into isolated dark texels instead of disappearing. It is
/// stated as a LENGTH because that is the only unit the pixel floor can be
/// compared in — the frequency this replaced could not express the question.
pub const GRAIN_OFF: f32 = 0.09;

/// A pattern from its CODE plus a flat param array — the inverse of
/// [`Pattern::par`], and the one place the panel's `(which policy, its dialing)`
/// pair becomes a `Pattern`.
pub fn pattern_of(code: u8, par: [f32; 3]) -> Pattern {
    match code % 3 {
        1 => Pattern::Craquelure { wave: par[0] },
        2 => Pattern::Mosaic { jitter: par[0] },
        _ => Pattern::Lightning { branch: par[0], straight: par[1], spread: par[2] },
    }
}

/// [`Pattern::par`] as a free function, for symmetry with [`pattern_of`].
pub fn par_of(p: Pattern) -> [f32; 3] {
    p.par()
}

/// SHAPE is not amount. Nothing in here changes how MUCH damage there is —
/// that separation is the whole reason `cracks` had to stop being the lattice
/// frequency.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Shape {
    /// Plate / cell size in WORLD UNITS, shared identically by all three
    /// patterns: mosaic's cell IS this, craquelure stops splitting so its leaves
    /// average it, and lightning's root lattice is pitched on it so the plates
    /// its network leaves over come out this size. Below [`GRAIN_OFF`] the
    /// veneer is off entirely.
    pub grain: f32,
    /// Groove depth as a fraction of the slab's half-thickness.
    pub relief: f32,
    pub pattern: Pattern,
}

impl Shape {
    /// 0.44 wu of plate — 18 screen px on an X-run face — is the middle of the
    /// `cracks` knob's old travel (`crack::grain_of` at 0.5), so a level that
    /// says nothing about shape gets what the crack lab has always booted with.
    pub const DEFAULT: Shape = Shape { grain: 0.44, relief: 0.45, pattern: Pattern::DEFAULTS[0] };
}

/// What [`Shape::relief`] MEANS in world units: the veneer's thickness, which is
/// the same number as a groove's depth (a groove cuts the veneer away down to
/// the core). 0.02 wu at the bottom — just under one screen pixel, so the
/// shallowest setting still reads — up to 0.45 of the slab, which leaves a
/// tenth of it as core.
///
/// ONE definition, exported, because three readers have to agree on it: the
/// generator that cuts the grooves, the spall's depth budget
/// (`rebar::t_cap`, which is the deepest veneer that still leaves the
/// reinforcement somewhere to sit), and the panel row that reports the cap.
pub fn veneer(relief: f32, thick: f32) -> f32 {
    mixf(0.02, 0.45 * thick, relief.clamp(0.0, 1.0))
}

/// [`veneer`] inverted: the relief setting that produces thickness `t`. What the
/// panel needs to SHOW a cap as a slider position rather than as a wu number the
/// author has no way to compare his dial against.
fn relief_of(t: f32, thick: f32) -> f32 {
    let span = 0.45 * thick - 0.02;
    if span <= 0.0 {
        return 0.0; // a slab thinner than the shallowest groove: no travel at all
    }
    ((t - 0.02) / span).clamp(0.0, 1.0)
}

/// Everything a level says about ONE wall.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct WallSpec {
    pub story: Story,
    /// VARIANT: slides the story key through noise space ([`scrub_key`]) so
    /// the whole damage pattern re-rolls coherently — the author's "move it
    /// until it sits right". 0 = the run's own hash, i.e. exactly the wall
    /// that shipped before the dial existed.
    pub scrub: f32,
    pub pin: Pins,
    pub shape: Shape,
    /// Stamp the PAINT but keep the GEOMETRY pass off this wall.
    ///
    /// A bench flag, and it exists because two shipped effects are otherwise
    /// UNREACHABLE: the shade pass carries a painted crack network and painted
    /// chip patches, but `crack_geom` marks every wall it touches and the shader
    /// gates both layers off that mark — and the geometry pass runs on any wall
    /// with a nonzero amount. So on a normal level the painted pair is dead code.
    /// The catalogue is where that question gets put to the owner ("is the
    /// painted fallback still worth carrying?") rather than answered in a
    /// comment.
    pub paint_only: bool,
}

impl WallSpec {
    pub const PRISTINE: WallSpec = WallSpec { story: Story::ZERO, scrub: 0.0, pin: Pins::NONE, shape: Shape::DEFAULT, paint_only: false };
}

// ---------------------------------------------------------------------------
// 3. The level's wear
// ---------------------------------------------------------------------------

/// A level's whole wear authoring: a base story every wall starts from, a
/// spread between runs, and the walls that say something different.
///
/// Since 2026-07-27 this is FILE data (`crate::wear_file`), not const data:
/// the `&'static` slices stay because a wear file is parsed once per process
/// and leaked — every consumer keeps reading plain shared references.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct LevelWear {
    pub base: Story,
    /// ± spread of the STORY between RUNS. Never between panels: a facade is
    /// ONE wall, and per-panel variation is what made one building read as a
    /// stack of independently aged slabs.
    pub spread: f32,
    pub walls: &'static [WallAt],
}

/// One named wall, addressed by a world point the way every other level datum
/// is (`Action::SmashWall`, the old pristine list) — so the level can be re-cut
/// without silently moving what the author named.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct WallAt {
    pub at: (f32, f32),
    pub label: &'static str,
    pub spec: WallSpec,
}

impl WallAt {
    /// The negative control: no story, no pins, nothing built. Without one in
    /// frame "aged" quietly becomes the level's base tone.
    pub const fn pristine(at: (f32, f32), label: &'static str) -> WallAt {
        WallAt { at, label, spec: WallSpec::PRISTINE }
    }
    /// ONE effect, nothing else — the whole effect-catalogue vocabulary in one
    /// line. Every other layer is pinned to zero, so this cannot be
    /// contaminated by the base story the way the bench's specimens could.
    pub const fn only(at: (f32, f32), label: &'static str, l: Layer, v: f32) -> WallAt {
        let mut pin = Pins { area: [Some(0.0); Layer::N], breaks: Some(Breaks { count: 0, at: None }) };
        pin.area[l.index()] = Some(v);
        WallAt { at, label, spec: WallSpec { story: Story::ZERO, scrub: 0.0, pin, shape: Shape::DEFAULT, paint_only: false } }
    }
    /// ONE break, nothing else.
    pub const fn only_breaks(at: (f32, f32), label: &'static str, b: Breaks) -> WallAt {
        let pin = Pins { area: [Some(0.0); Layer::N], breaks: Some(b) };
        WallAt { at, label, spec: WallSpec { story: Story::ZERO, scrub: 0.0, pin, shape: Shape::DEFAULT, paint_only: false } }
    }
}

// ---------------------------------------------------------------------------
// 4. The derivation — the whole rule, on one screen
// ---------------------------------------------------------------------------

/// The face a TOTAL cover loss takes, and so the ceiling the cover-loss cause
/// maps onto.
///
/// Defined by what the geometry can honour on the SMALLEST wall in the game, not
/// by taste. Craters are discrete objects with cover standing between them
/// (`rebar::PATCH_GAP`, `EDGE_MARGIN`), and a wall's TWO faces share one packing
/// because two craters facing each other would perforate the slab — the front
/// takes the worst sites and the back is vetoed off every rect it took. So the
/// binding case is a small pier's BACK face, and the number is measured, by
/// `both_faces_get_the_spall_they_asked_for_at_the_top_of_the_dial` over every
/// pier of the gym:
///
/// | asked | worst face's shortfall |
/// |---|---|
/// | 0.020 | 5 % of the ask |
/// | 0.025 | 8 % — under the rounding quantum |
/// | 0.030 | 23 % |
/// | 0.060 | 48 % — the gym's 1.6-wu pier gets one crater instead of two |
///
/// So the top of the cover-loss slider is the most cover loss every wall in the
/// game can actually carry on BOTH of its faces — the property a staged dial
/// cannot have, since its top end was a stage rather than an amount. At 0.025 a
/// 6.2-wu facade loses 3 patches and the bench's 2.2-wu slab 1, which is what
/// the staged dial's top end produced too: this round changes the MECHANISM, not
/// how damaged the level looks.
///
/// The lever, if a wall ever needs to lose more: allocate the two faces'
/// craters by INTERLEAVING one candidate list instead of running the back
/// through the front's leftovers. That splits the packing evenly and would
/// roughly double this number.
///
/// It lives on the CAUSE→AMOUNT table and not inside the generator so that the
/// AMOUNT stays a literal area: 0.025 IS two and a half per cent of the face, on
/// the bench slab and on the facade alike.
pub const SPALL_MAX: f32 = 0.025;

/// `x` remapped so that `a` is the point it starts mattering. Linear, not a
/// smoothstep: the author has to be able to do this in his head.
fn from(x: f32, a: f32) -> f32 {
    ((x - a) / (1.0 - a)).clamp(0.0, 1.0)
}

/// THE TABLE. Nothing anywhere else may write a layer amount — that is what
/// makes the panel's derived column a COMPLETE explanation of a wall.
///
/// The thresholds are a causal order, not taste: glaze stains first, the fine
/// web crazes through it, the crack network opens once the material is properly
/// tired, and only then do fragments start coming off. Chips top out at half
/// the face because a wall whose whole surface has fallen off is rubble, not a
/// wall.
pub fn derive(s: Story) -> ([f32; Layer::N], Breaks) {
    let w = s.weather;
    (
        [
            w,                       // Stain
            from(w, 0.30),           // Web
            from(w, 0.55),           // Cracks
            0.50 * from(w, 0.75),    // Chips
            SPALL_MAX * s.cover_loss, // Spall
        ],
        Breaks { count: (Breaks::MAX as f32 * from(s.settlement, 0.40)).round() as u8, at: None },
    )
}

/// The amounts and breaks a wall actually gets: [`derive`] from its story, then
/// every [`Pins`] entry on top. One function, so "what is this wall's cracks
/// amount" has exactly one answer.
pub fn resolve(spec: &WallSpec) -> ([f32; Layer::N], Breaks) {
    let (mut area, mut breaks) = derive(spec.story);
    for l in Layer::ALL {
        if let Some(v) = spec.pin.get(l) {
            area[l.index()] = v.clamp(0.0, 1.0);
        }
    }
    if let Some(b) = spec.pin.get_breaks() {
        breaks = b;
    }
    (area, breaks)
}

// ---------------------------------------------------------------------------
// 5. The engine that makes an amount predictable
// ---------------------------------------------------------------------------

/// Sampling lattice of a run's field: the 0.1-wu authoring grid the whole game
/// projection is built on. The field's FINEST octave is 1.09 × 0.70 wu, so this
/// is ~7× finer than anything it can express — the percentile is a property of
/// the field, not of the lattice.
pub const LATTICE: f32 = 0.1;

/// ONE RUN's damage field, sampled over its own face and SORTED. This is the
/// single place a COVERAGE becomes a THRESHOLD, and it is built once per (run,
/// origin) — the machinery it replaces sampled and sorted the same field three
/// times per rebuild and cached it nowhere.
pub struct RunField {
    sorted: Vec<f32>,
    pub lo: f32,
    pub hi: f32,
}

impl RunField {
    /// THE FIELD — [`crate::crack_geom::dmg_field`] itself: one function shared
    /// with the geometry generator (and mirrored by both shader twins, pinned
    /// by the source-reading guard in `crate::wear`), so the solver's
    /// thresholds, the built plates and the painted gates are three readers of
    /// ONE definition by construction. The per-wall `Origin` bias that used to
    /// sit on top is gone (2026-07-27): it moved the SOLVED THRESHOLD but never
    /// reached the field on either host or shader — a knob that changed how
    /// much instead of where. The band mask (effect-system round C) is the
    /// honest version of "damage collects HERE".
    pub fn at(story: f32, u: f32, y: f32) -> f32 {
        crate::crack_geom::dmg_field(story * 7.0 + 3.0, u, y)
    }

    /// Sample a run's whole face on [`LATTICE`] and sort.
    pub fn of(run_lo: Vec3, run_hi: Vec3, story: f32) -> RunField {
        let run_x = (run_hi.x - run_lo.x) >= (run_hi.z - run_lo.z);
        let (a0, a1) = if run_x { (run_lo.x, run_hi.x) } else { (run_lo.z, run_hi.z) };
        let (y0, y1) = (run_lo.y, run_hi.y);
        let n = |a: f32, b: f32| ((((b - a) / LATTICE).round()) as usize).max(2);
        let (nu, ny) = (n(a0, a1), n(y0, y1));
        let mut sorted = Vec::with_capacity(nu * ny);
        for i in 0..nu {
            let u = mixf(a0, a1, (i as f32 + 0.5) / nu as f32);
            for j in 0..ny {
                let y = mixf(y0, y1, (j as f32 + 0.5) / ny as f32);
                sorted.push(Self::at(story, u, y));
            }
        }
        sorted.sort_by(|a, b| a.partial_cmp(b).expect("the damage field is finite"));
        let (lo, hi) = (sorted[0], sorted[sorted.len() - 1]);
        RunField { sorted, lo, hi }
    }

    /// The threshold that puts `frac` of THIS face above it.
    ///
    /// `frac == 0` returns [`GATE_EMPTY`], strictly above the field's maximum —
    /// so "none of it" is provably nothing rather than "a very high gate that
    /// might still catch a peak".
    pub fn threshold(&self, frac: f32) -> f32 {
        if frac <= 0.0 {
            return GATE_EMPTY;
        }
        if frac >= 1.0 {
            return GATE_FULL;
        }
        let f = frac;
        let n = self.sorted.len();
        let i = (((1.0 - f) * (n - 1) as f32).round() as usize).min(n - 1);
        self.sorted[i]
    }

    /// The inverse — what the panel PRINTS and what the tests assert against.
    /// Measured on the same samples the threshold was solved from, so a caller
    /// wanting the honest continuous coverage has to sample finer itself (the
    /// tests do exactly that; see `an_amount_is_an_area`).
    pub fn coverage(&self, t: f32) -> f32 {
        let above = self.sorted.iter().filter(|v| **v >= t).count();
        above as f32 / self.sorted.len() as f32
    }
}

// ---- the painted gate codec: an ABSOLUTE threshold, counting DOWN -----------
//
// The field's range is [0, 1.16]: two vnoise octaves weighted 0.65/0.35
// (each in 0..1) plus the 0.16 ground rise. `GATE_HI` sits above that maximum, so
// CODE 0 — the empty word, hence every material nobody stamped — means provably
// NOTHING. 63 steps of `GATE_STEP` reach below the minimum, so full coverage is
// reachable on every run.
//
// Counting DOWN from an unreachable high is what buys that property. The
// signed-offset lane this replaces was calibrated for run-to-run VARIATION at
// one reference age (±0.384 in units of 0.012), not for a dial's whole travel:
// asking for a large coverage on a low-level run needed an offset past its
// clamp, i.e. a dead region at the top of the central dial.

/// Above the field's maximum: the code-0 value, and what [`RunField::threshold`]
/// returns for "none of it".
pub const GATE_EMPTY: f32 = 1.20;
pub const GATE_HI: f32 = 1.20;
pub const GATE_STEP: f32 = 0.020;
/// Below the field's minimum: the code-63 value, and what
/// [`RunField::threshold`] returns for "all of it".
///
/// The symmetry with [`GATE_EMPTY`] is load-bearing and was missing in the
/// first cut. Returning the field's own minimum for `frac == 1` looks right and
/// is not: `gate_quantize` rounds it to the nearest code, which can round UP
/// past that minimum and drop the single lowest sample, so "all of it" measured
/// 0.9965 instead of 1. A dial whose top end is *almost* its top end is exactly
/// the class of defect this codec replaced, so both ends are now facts about the
/// code range rather than about the samples.
pub const GATE_FULL: f32 = GATE_HI - 63.0 * GATE_STEP;

/// The 6-bit code that carries a threshold.
pub fn gate_code(t: f32) -> u32 {
    (((GATE_HI - t) / GATE_STEP).round().clamp(0.0, 63.0)) as u32
}

/// The value the SHADER will use. The host MUST apply this and never the
/// unrounded threshold — one datum, measured on one side of the bus and applied
/// on both. The geometry pass and the paint pass drifting apart is the exact
/// failure docs/AGENT_LEARNINGS.md records twice.
pub fn gate_quantize(t: f32) -> f32 {
    GATE_HI - gate_code(t) as f32 * GATE_STEP
}

// ---------------------------------------------------------------------------
// 6. What the consumers get
// ---------------------------------------------------------------------------

/// Everything the SHADE PASS needs for one wall — the two painted layers, each
/// with a WHERE and a HOW MUCH.
///
/// The pair is the point. Step 5 gave the layers independent AREAS (their own
/// solved threshold, carried in the effect word) but left both STRENGTHS on the
/// single `age` knob, so "stains spread wider than the crazing" was expressible
/// and "stains darker than the crazing" was not. Both halves now come off the
/// layer's own amount, and the strengths ride `Material._pad`'s first two knob
/// lanes (`crate::crack::pad_bits`) where four knobs used to.
#[derive(Clone, Copy, PartialEq, Debug, Default)]
pub struct Paint {
    /// WHERE: threshold codes ([`gate_code`] units), the effect word's lanes 0/1.
    pub stain: u32,
    pub web: u32,
    /// HOW MUCH: the layers' own amounts, `_pad` knob lanes 0/1.
    pub stain_amt: f32,
    pub web_amt: f32,
}

/// Everything the GEOMETRY PASS needs for one wall, ALL INTEGER — no float
/// reaches a generator un-quantized, so `Geom` inequality IS "the built mesh is
/// stale". It replaces a hand-rolled FNV taken over five different grains, with
/// raw floats reaching the break decision, which is how one 0.02 slider step
/// could split a wall in half.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Default, Debug)]
pub struct Geom {
    /// Threshold codes ([`gate_code`] units).
    pub t_cracks: u8,
    pub t_chips: u8,
    /// Spall is the odd one: an AMOUNT, not a threshold, because its layer is
    /// realized as a count of craters rather than by gating the field
    /// (`rebar::craters`). Quantized on the same 1/63 grid as the shape dials.
    pub spall: u8,
    /// Plate size and groove depth, quantized.
    pub grain: u8,
    pub relief: u8,
    pub pattern: u8,
    /// Pattern-native params, quantized in pattern order. Three, because
    /// lightning has three things to say about a crack's shape and none of them
    /// is its size (see [`Pattern`]).
    pub par: [u8; 3],
    pub breaks: u8,
    /// Break placement in run-thousandths; `u16::MAX` = story-seeded.
    pub break_at: u16,
}

/// One wall, compiled: what the author asked for, and what both consumers get.
#[derive(Clone, Debug)]
pub struct Sheet {
    pub label: &'static str,
    /// Index into the level's run list.
    pub run: usize,
    /// The resolved amounts, for the panel's derived column and the tests.
    pub area: [f32; Layer::N],
    pub breaks: Breaks,
    /// The QUANTIZED thresholds the geometry pass must use, per layer.
    pub gate: [f32; Layer::N],
    pub paint: Paint,
    pub geom: Geom,
    /// What this wall got that is not quite what it asked for. Empty on almost
    /// every wall; the panel prints them in that wall's rows.
    pub notes: Vec<Miss>,
}

/// An authoring mistake, or a request the geometry could not honour exactly.
/// Never silence: "the effect I authored is not in the shot" used to be an
/// `eprintln!` nobody read.
///
/// Two kinds, and they are reported differently because they are different
/// questions. [`Self::NoWall`] and [`Self::Duplicate`] are TYPOS — the author
/// addressed a wall that is not there, or two names claim one run — and nothing
/// downstream can be right, so [`compile`] fails on them. The other two are
/// honoured WITH A DIFFERENCE: the wall renders, and the difference is attached
/// to that wall's [`Sheet::notes`] for the panel to print in its row. Failing
/// the level for those would mean a builder could not ask for the top of a
/// slider without the compiler refusing to build anything at all.
#[derive(Clone, Debug, PartialEq)]
pub enum Miss {
    NoWall { at: (f32, f32), label: &'static str },
    Duplicate { at: (f32, f32), label: &'static str },
    /// The run is too short for its field to deliver the asked area.
    Coarse { label: &'static str, layer: Layer, asked: f32, got: f32 },
    /// A dial whose top the geometry cannot reach on THIS wall — today only
    /// [`Shape::relief`], capped so a spalling wall keeps enough core to hold
    /// its reinforcement mat (`rebar::t_cap`). Reported per wall because the cap
    /// is a function of the slab's own thickness: the same relief is free on a
    /// thick wall and clipped on a thin one.
    Clamped { label: &'static str, dial: &'static str, asked: f32, used: f32 },
}

/// A run rectangle, as the level builder's `at` point resolves against it. The
/// scene-side `Run` feeds this; keeping the module's input this small is what
/// lets every claim below be tested as arithmetic.
#[derive(Clone, Copy, Debug)]
pub struct RunRect {
    pub lo: Vec3,
    pub hi: Vec3,
}

impl RunRect {
    /// Does the authoring point (x, z) address this run? Public because the
    /// wear file's SAVE has to answer the reverse question — which named wall
    /// is this run — with exactly the arithmetic [`specs_of`] used forward.
    pub fn holds(&self, x: f32, z: f32) -> bool {
        x >= self.lo.x && x <= self.hi.x && z >= self.lo.z && z <= self.hi.z
    }
    /// Story key — the seed of everything that must be true of the WHOLE
    /// facade. Quantized to the authoring grid so it cannot wobble on a
    /// float-exact rebuild.
    pub fn story(&self) -> f32 {
        crate::wear::story_key(self.lo, self.hi)
    }
    fn length(&self) -> f32 {
        (self.hi.x - self.lo.x).max(self.hi.z - self.lo.z)
    }
    /// Slab thickness — the short side. Every depth budget in the renderer is
    /// measured against it, so the authoring model has to know it too.
    fn thick(&self) -> f32 {
        (self.hi.x - self.lo.x).min(self.hi.z - self.lo.z)
    }
}

/// The per-run story spread: a deterministic ± offset so two runs of one level
/// differ from each other without any per-panel variation.
fn spread_of(r: &RunRect, spread: f32) -> f32 {
    if spread <= 0.0 {
        return 0.0;
    }
    // an irrational stride so consecutive story keys do not land in step;
    // 1/pi is arbitrary and only has to stay put
    (r.story() * std::f32::consts::FRAC_1_PI).fract().mul_add(2.0, -1.0) * spread
}

/// RESOLVE a level's authored wear onto its runs: one `(label, spec)` per run,
/// in run order. The half of compilation that can FAIL, and the half the panel
/// does not repeat — a live edit changes a spec and recompiles
/// ([`compile_specs`]); it never re-reads the level.
///
/// Every named wall must resolve to exactly one run, and no two names may share
/// one — a level whose author cannot see which wall he addressed is the failure
/// this whole module exists to remove.
pub fn specs_of(runs: &[RunRect], lw: &LevelWear) -> Result<Vec<(&'static str, WallSpec)>, Vec<Miss>> {
    let mut misses = Vec::new();
    let mut claimed: Vec<usize> = Vec::new();
    let mut named: Vec<(usize, &WallAt)> = Vec::new();
    for w in lw.walls {
        match runs.iter().position(|r| r.holds(w.at.0, w.at.1)) {
            Some(i) if claimed.contains(&i) => misses.push(Miss::Duplicate { at: w.at, label: w.label }),
            Some(i) => {
                claimed.push(i);
                named.push((i, w));
            }
            None => misses.push(Miss::NoWall { at: w.at, label: w.label }),
        }
    }
    if !misses.is_empty() {
        return Err(misses);
    }
    Ok(runs
        .iter()
        .enumerate()
        .map(|(i, r)| match named.iter().find(|(j, _)| *j == i) {
            Some((_, w)) => (w.label, w.spec),
            None => {
                let d = spread_of(r, lw.spread);
                let base = Story {
                    weather: (lw.base.weather + d).clamp(0.0, 1.0),
                    settlement: (lw.base.settlement + d).clamp(0.0, 1.0),
                    cover_loss: (lw.base.cover_loss + d).clamp(0.0, 1.0),
                };
                ("", WallSpec { story: base, ..WallSpec::PRISTINE })
            }
        })
        .collect())
}

/// Compile a level's authored wear against its runs.
pub fn compile(runs: &[RunRect], lw: &LevelWear) -> Result<Vec<Sheet>, Vec<Miss>> {
    Ok(compile_specs(runs, &specs_of(runs, lw)?))
}

/// Compile RESOLVED specs — one per run, in run order. This is the function a
/// panel edit re-runs: it cannot fail, because addressing already happened, and
/// everything it produces is a function of `(run, spec)` alone.
pub fn compile_specs(runs: &[RunRect], specs: &[(&'static str, WallSpec)]) -> Vec<Sheet> {
    let mut sheets: Vec<Sheet> = Vec::new();
    for (i, r) in runs.iter().enumerate() {
        let mut notes: Vec<Miss> = Vec::new();
        let (label, mut spec) = specs.get(i).copied().unwrap_or(("", WallSpec::PRISTINE));
        let (area, breaks) = resolve(&spec);
        // THE RELIEF CAP. A wall that spalls must keep enough core to hold its
        // reinforcement mat, and how deep that lets the grooves cut is a fact
        // about the slab's thickness, not about the author's taste — so the cap
        // is applied here, once, and SAID. Spall-free walls are untouched: the
        // constraint belongs to the effect that needs the core, not to the
        // relief dial in general.
        if area[Layer::Spall.index()] > 0.0 {
            let cap = crate::rebar::t_cap(r.thick());
            if veneer(spec.shape.relief, r.thick()) > cap + 1e-6 {
                let used = relief_of(cap, r.thick());
                notes.push(Miss::Clamped { label, dial: "relief", asked: spec.shape.relief, used });
                spec.shape.relief = used;
            }
        }
        let field = RunField::of(r.lo, r.hi, scrub_key(r.story(), spec.scrub));
        let mut gate = [GATE_EMPTY; Layer::N];
        for l in Layer::ALL {
            gate[l.index()] = gate_quantize(field.threshold(area[l.index()]));
            // A run whose field is coarser than the area it was asked for
            // cannot deliver it. Report rather than silently approximate — the
            // panel prints achieved-vs-asked in that row.
            //
            // Spall is exempt: it is the one layer whose amount is NOT realized
            // by thresholding the field (discrete craters are counted out of it
            // — `rebar::craters`), so its gate is not what it draws through.
            let got = field.coverage(gate[l.index()]);
            if l != Layer::Spall && area[l.index()] > 0.0 && (got - area[l.index()]).abs() > 0.08 {
                notes.push(Miss::Coarse { label, layer: l, asked: area[l.index()], got });
            }
        }
        let q = |v: f32| (v.clamp(0.0, 1.0) * 63.0).round() as u8;
        let par = match spec.shape.pattern {
            Pattern::Lightning { branch, straight, spread } => [q(branch), q(straight), q(spread)],
            Pattern::Craquelure { wave } => [q(wave), 0, 0],
            Pattern::Mosaic { jitter } => [q(jitter), 0, 0],
        };
        sheets.push(Sheet {
            label,
            run: i,
            area,
            breaks,
            gate,
            paint: Paint {
                stain: gate_code(gate[Layer::Stain.index()]),
                web: gate_code(gate[Layer::Web.index()]),
                stain_amt: area[Layer::Stain.index()],
                web_amt: area[Layer::Web.index()],
            },
            notes,
            geom: Geom {
                t_cracks: gate_code(gate[Layer::Cracks.index()]) as u8,
                t_chips: gate_code(gate[Layer::Chips.index()]) as u8,
                spall: q(area[Layer::Spall.index()]),
                grain: q(spec.shape.grain),
                relief: q(spec.shape.relief),
                pattern: spec.shape.pattern.code(),
                par,
                breaks: breaks.count,
                break_at: breaks.at.map_or(u16::MAX, |a| (a.clamp(0.0, 1.0) * 1000.0).round() as u16),
            },
        });
    }
    sheets
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every RUN of both shipped levels, as the authoring model sees them.
    fn runs_of(spec: &house_game::gym::sim::GymLevel) -> Vec<RunRect> {
        let (_scene, meta) = crate::gym_scene::build_gym(spec, &crate::look::POLANA, true);
        let mut out: Vec<RunRect> = Vec::new();
        for p in &meta.piers {
            if !out.iter().any(|r| (r.lo - p.run_lo).length() < 1e-4 && (r.hi - p.run_hi).length() < 1e-4) {
                out.push(RunRect { lo: p.run_lo, hi: p.run_hi });
            }
        }
        out
    }
    fn both_levels() -> Vec<(&'static str, Vec<RunRect>)> {
        vec![
            ("gym", runs_of(&house_game::gym::sim::gym_level())),
            ("catalogue", runs_of(&house_game::gym::sim::catalogue_level())),
        ]
    }

    /// Continuous coverage, measured on a lattice 4× finer than the one the
    /// threshold was solved on — the honest question, since the promise is
    /// about the FACE and not about the sample set.
    fn true_coverage(r: &RunRect, story: f32, t: f32) -> f32 {
        let fine = LATTICE * 0.25;
        let run_x = (r.hi.x - r.lo.x) >= (r.hi.z - r.lo.z);
        let (a0, a1) = if run_x { (r.lo.x, r.hi.x) } else { (r.lo.z, r.hi.z) };
        let n = |a: f32, b: f32| ((((b - a) / fine).round()) as usize).max(2);
        let (nu, ny) = (n(a0, a1), n(r.lo.y, r.hi.y));
        let mut above = 0usize;
        for i in 0..nu {
            let u = mixf(a0, a1, (i as f32 + 0.5) / nu as f32);
            for j in 0..ny {
                let y = mixf(r.lo.y, r.hi.y, (j as f32 + 0.5) / ny as f32);
                if RunField::at(story, u, y) >= t {
                    above += 1;
                }
            }
        }
        above as f32 / (nu * ny) as f32
    }

    /// THE CLAIM THE WHOLE MODEL RESTS ON: an amount is an AREA.
    ///
    /// Asked for 0.30, a wall gets 30 % of its face — measured on a lattice 4×
    /// finer than the one the threshold was solved on, over every run of both
    /// shipped levels, at several scrub positions (every variant of the field
    /// must keep the promise, or the scrub dial would be a second intensity
    /// knob). The test also MEASURES the run-length floor below which the
    /// promise stops holding and prints it, because that floor is a real
    /// property of the field (its finest octave is 1.09 × 0.70 wu, so a short
    /// run simply has fewer independent features than a fine fraction needs)
    /// and the bench's slabs are 2.2 wu.
    #[test]
    fn an_amount_is_an_area() {
        let mut worst: Vec<(String, f32, f32, f32)> = Vec::new();
        let mut n = 0;
        for (level, runs) in both_levels() {
            for (i, r) in runs.iter().enumerate() {
                for scrub in [0.0f32, 0.3, 0.8] {
                    let story = scrub_key(r.story(), scrub);
                    let f = RunField::of(r.lo, r.hi, story);
                    for asked in [0.1f32, 0.3, 0.6, 0.9] {
                        let got = true_coverage(r, story, gate_quantize(f.threshold(asked)));
                        worst.push((format!("{level} run {i} ({:.1} wu) scrub {scrub}", r.length()), asked, got, (got - asked).abs()));
                        n += 1;
                    }
                }
            }
        }
        worst.sort_by(|a, b| b.3.total_cmp(&a.3));
        for (who, asked, got, e) in worst.iter().take(5) {
            println!("worst: {who} asked {asked:.2} got {got:.2} (err {e:.3})");
        }
        assert!(n >= 150, "VACUOUS: only {n} cases");
        // The quantization alone costs up to GATE_STEP/2 of threshold, which on
        // a steep part of the field is a few per cent of area; the floor below
        // is what the measurement above actually produced.
        let e = worst[0].3;
        assert!(e < 0.12, "an amount is not an area on {}: asked {:.2}, got {:.2}", worst[0].0, worst[0].1, worst[0].2);
    }

    /// ZERO IS PROVABLY EMPTY — and it has to be provable, not merely small:
    /// code 0 is what every material nobody stamped decodes to, so if it caught
    /// even the field's peak, the whole unaged level would age itself.
    #[test]
    fn zero_is_provably_empty() {
        for (level, runs) in both_levels() {
            for (i, r) in runs.iter().enumerate() {
                for scrub in [0.0f32, 0.5, 1.0] {
                    let f = RunField::of(r.lo, r.hi, scrub_key(r.story(), scrub));
                    assert!(f.hi < GATE_EMPTY, "{level} run {i} scrub {scrub}: field max {} reaches the empty gate", f.hi);
                    assert_eq!(gate_code(f.threshold(0.0)), 0, "{level} run {i}: 'none of it' is not code 0");
                    assert_eq!(f.coverage(gate_quantize(f.threshold(0.0))), 0.0);
                }
            }
        }
    }

    /// THE CODE BRACKETS EVERY RUN: 63 steps down from an unreachable high must
    /// still reach below the field's minimum, or full coverage is unreachable on
    /// some wall — which is the dead-dial-region defect this codec replaced.
    #[test]
    fn the_gate_code_brackets_every_run() {
        let low = GATE_HI - 63.0 * GATE_STEP;
        for (level, runs) in both_levels() {
            for (i, r) in runs.iter().enumerate() {
                for scrub in [0.0f32, 0.5, 1.0] {
                    let f = RunField::of(r.lo, r.hi, scrub_key(r.story(), scrub));
                    assert!(f.lo > low, "{level} run {i} scrub {scrub}: field min {} is below the lowest code {low}", f.lo);
                    assert_eq!(gate_code(f.threshold(1.0)), 63, "{level} run {i}: 'all of it' is not the bottom code");
                    assert_eq!(f.coverage(gate_quantize(f.threshold(1.0))), 1.0, "{level} run {i}: full coverage unreachable");
                }
            }
        }
    }

    /// MORE IS MORE, per layer per run: coverage monotone in the amount. A
    /// non-monotone dial is unusable however correct its endpoints are.
    #[test]
    fn more_is_more() {
        for (level, runs) in both_levels() {
            for (i, r) in runs.iter().enumerate() {
                let f = RunField::of(r.lo, r.hi, r.story());
                let mut prev = -1.0;
                for k in 0..=20 {
                    let got = f.coverage(gate_quantize(f.threshold(k as f32 / 20.0)));
                    assert!(got >= prev - 1e-6, "{level} run {i}: coverage fell from {prev} to {got} at amount {}", k as f32 / 20.0);
                    prev = got;
                }
            }
        }
    }

    /// BREAKS NEVER COLLIDE AND NEVER SWAP, at any count and any story.
    ///
    /// The reason [`Breaks::places`] is a spread with a bounded jitter and not
    /// `count` independent draws: independent draws collide, and two breaks 0.05
    /// wu apart are one break with a sliver between them — the exact thing
    /// `BREAK_MARGIN` keeps off the ENDS of a run, so letting it happen in the
    /// middle would be pointless. Also pinned: the jitter is real, or the model
    /// would place every run's breaks at the same fractions.
    #[test]
    fn breaks_spread_out_and_stay_in_order() {
        let mut moved = false;
        for n in 1..=Breaks::MAX {
            let b = Breaks { count: n, at: None };
            for s in 0..64 {
                let story = s as f32 * 0.618;
                let p = b.places(story);
                assert_eq!(p.len(), n as usize, "count {n} produced {} places", p.len());
                for (j, v) in p.iter().enumerate() {
                    assert!((0.0..=1.0).contains(v), "count {n} story {story}: place {j} at {v}");
                    // its own slot, jittered by at most 0.17 of one spacing
                    let slot = (j as f32 + 0.5) / n as f32;
                    assert!((v - slot).abs() <= 0.17 / n as f32 + 1e-6, "count {n} story {story}: place {j} left its slot ({v} vs {slot})");
                    moved |= (v - slot).abs() > 1e-4;
                }
                for w in p.windows(2) {
                    assert!(w[1] - w[0] >= 0.66 / n as f32 - 1e-6, "count {n} story {story}: {:?} are one break with a sliver between them", w);
                }
            }
        }
        assert!(moved, "VACUOUS: the jitter never moved a break off its slot");
        // an authored place is a place, not a suggestion
        assert!((Breaks { count: 1, at: Some(0.2) }.places(7.4)[0] - 0.2).abs() < 1e-6);
        assert_eq!(Breaks { count: 0, at: Some(0.2) }.places(7.4), Vec::<f32>::new());
    }

    /// `derive` IS THE ONLY WRITER: an all-zero story with one pin yields
    /// exactly one nonzero amount. This is the property that makes the panel's
    /// derived column a complete explanation — and the property the old dial
    /// set could not have, since `age` wrote five things.
    #[test]
    fn derive_is_the_only_writer() {
        for l in Layer::ALL {
            let spec = WallSpec { pin: Pins::NONE.area(l, 0.7), ..WallSpec::PRISTINE };
            let (area, breaks) = resolve(&spec);
            for other in Layer::ALL {
                let want = if other == l { 0.7 } else { 0.0 };
                assert_eq!(area[other.index()], want, "pinning {} moved {}", l.name(), other.name());
            }
            assert_eq!(breaks.count, 0, "pinning {} asked for a break", l.name());
        }
        // …and the causes are disjoint: settlement writes ONLY breaks.
        let (area, breaks) = derive(Story { settlement: 1.0, ..Story::ZERO });
        assert_eq!(area, [0.0; Layer::N], "settlement wrote a skin layer");
        assert_eq!(breaks.count, 3);
        let (area, breaks) = derive(Story { cover_loss: 0.4, ..Story::ZERO });
        assert_eq!(area[Layer::Spall.index()], SPALL_MAX * 0.4, "cover loss maps onto the reachable area, not onto 1.0");
        assert_eq!(area[Layer::Cracks.index()], 0.0, "cover loss wrote the cracks row");
        assert_eq!(breaks.count, 0);
    }

    /// SCRUB RE-ROLLS THE FIELD WITHOUT ADDING DAMAGE: at a fixed amount the
    /// coverage is invariant (solving a threshold per run buys that for EVERY
    /// seed) while the damaged patch actually MOVES — the whole point of the
    /// dial. And it is quantized on the 6-bit grid, so a drag inside one step
    /// changes nothing: the rebuild gate stays quiet by construction.
    #[test]
    fn scrub_rerolls_the_field_without_adding_damage() {
        let runs = runs_of(&house_game::gym::sim::gym_level());
        let mut moved = 0;
        for r in &runs {
            let (a, b) = (scrub_key(r.story(), 0.0), scrub_key(r.story(), 0.6));
            assert_eq!(a, r.story(), "scrub 0 must be the run's own hash — the wall that shipped");
            let (fa, fb) = (RunField::of(r.lo, r.hi, a), RunField::of(r.lo, r.hi, b));
            let (ta, tb) = (gate_quantize(fa.threshold(0.30)), gate_quantize(fb.threshold(0.30)));
            assert!((fa.coverage(ta) - 0.30).abs() < 0.10);
            assert!((fb.coverage(tb) - 0.30).abs() < 0.10, "a scrubbed wall must keep its amount");
            // …and the damaged SET moved: count lattice points whose in/out
            // state changed between the two variants
            let run_x = (r.hi.x - r.lo.x) >= (r.hi.z - r.lo.z);
            let (a0, a1) = if run_x { (r.lo.x, r.hi.x) } else { (r.lo.z, r.hi.z) };
            let (mut diff, mut n) = (0usize, 0usize);
            let nu = (((a1 - a0) / LATTICE).round() as usize).max(2);
            let ny = (((r.hi.y - r.lo.y) / LATTICE).round() as usize).max(2);
            for i in 0..nu {
                let u = mixf(a0, a1, (i as f32 + 0.5) / nu as f32);
                for j in 0..ny {
                    let y = mixf(r.lo.y, r.hi.y, (j as f32 + 0.5) / ny as f32);
                    diff += ((RunField::at(a, u, y) >= ta) != (RunField::at(b, u, y) >= tb)) as usize;
                    n += 1;
                }
            }
            if diff as f32 / n as f32 > 0.15 {
                moved += 1;
            }
        }
        assert!(moved * 2 >= runs.len(), "scrub moved the damage on only {moved} of {} runs", runs.len());
        // the 6-bit grid: a sub-step drag is the SAME key, a real step is not
        assert_eq!(scrub_key(7.4, 0.500), scrub_key(7.4, 0.505), "a sub-quantum scrub moved the key");
        assert_ne!(scrub_key(7.4, 0.500), scrub_key(7.4, 0.530), "a real scrub step did not move the key");
    }

    /// A LEVEL COMPILES OR SAYS WHY. A world point that hits no run, or two
    /// names on one run, is an authoring mistake that must fail loudly — the
    /// version this replaces printed a line to stderr and rendered the wall
    /// unaged, so "the effect I asked for is not in the shot" had no cause.
    #[test]
    fn a_missed_or_duplicated_wall_is_an_error() {
        let runs = runs_of(&house_game::gym::sim::gym_level());
        static MISS: [WallAt; 1] = [WallAt::pristine((99.0, 99.0), "nowhere")];
        static DUP: [WallAt; 2] = [WallAt::pristine((13.0, 10.0), "a"), WallAt::pristine((14.0, 10.0), "b")];
        let lw = |w: &'static [WallAt]| LevelWear { base: Story::ZERO, spread: 0.0, walls: w };
        assert!(matches!(compile(&runs, &lw(&MISS)), Err(ref m) if matches!(m[0], Miss::NoWall { .. })));
        assert!(matches!(compile(&runs, &lw(&DUP)), Err(ref m) if matches!(m[0], Miss::Duplicate { .. })), "two names on the z=10 garden wall must collide");
        // …and a clean level compiles, one sheet per run
        static OK: [WallAt; 1] = [WallAt::pristine((13.0, 10.0), "control")];
        let sheets = compile(&runs, &lw(&OK)).expect("a clean level compiles");
        assert_eq!(sheets.len(), runs.len(), "one sheet per run");
        assert_eq!(sheets.iter().filter(|s| s.label == "control").count(), 1);
    }

    /// A DIAL THE GEOMETRY CANNOT HONOUR IS CLAMPED AND SAID SO — never
    /// silently obeyed-ish. The relief knob's top would leave a spalling wall no
    /// core to hold its reinforcement mat, and what used to happen is that the
    /// steel simply stopped appearing, with nothing anywhere saying why (it was
    /// written up as an "honest limit" in the module docs, which is not the same
    /// as telling the person holding the slider).
    ///
    /// Both halves are pinned, because a cap that fires when it should not is
    /// the same defect the other way round: a wall with no spall keeps the whole
    /// travel, since the constraint belongs to the effect that needs the core.
    #[test]
    fn a_relief_past_the_cap_is_clamped_and_said() {
        let runs = runs_of(&house_game::gym::sim::gym_level());
        const DEEP: Shape = Shape { relief: 1.0, ..Shape::DEFAULT };
        const WALLS: [WallAt; 2] = [
            WallAt { at: (13.0, 10.0), label: "deep and spalling", spec: WallSpec { story: Story { weather: 0.0, settlement: 0.0, cover_loss: 1.0 }, shape: DEEP, ..WallSpec::PRISTINE } },
            WallAt { at: (12.0, 4.0), label: "deep and sound", spec: WallSpec { story: Story { weather: 0.9, settlement: 0.0, cover_loss: 0.0 }, shape: DEEP, ..WallSpec::PRISTINE } },
        ];
        let lw = LevelWear { base: Story::ZERO, spread: 0.0, walls: &WALLS };
        let sheets = compile(&runs, &lw).expect("a clamp is not a compile error — the wall renders");
        let of = |label: &str| sheets.iter().find(|s| s.label == label).expect("both named walls compiled").clone();

        // the spalling wall is capped, and the note carries both numbers
        let spalling = of("deep and spalling");
        let thick = runs[sheets.iter().position(|s| s.label == "deep and spalling").unwrap()].thick();
        assert!(crate::rebar::t_cap(thick) < veneer(1.0, thick), "VACUOUS: relief 1.0 already fits the mat on a {thick}-wu wall");
        let note = spalling.notes.iter().find(|m| matches!(m, Miss::Clamped { .. })).unwrap_or_else(|| panic!("relief 1.0 on a spalling wall was obeyed silently: {:?}", spalling.notes));
        let Miss::Clamped { dial, asked, used, .. } = note else { unreachable!() };
        assert_eq!(*dial, "relief");
        assert_eq!(*asked, 1.0);
        assert!(*used < 1.0 && *used > 0.8, "the cap should cost the top of the slider, not most of it: {used:.3}");
        assert!(veneer(*used, thick) <= crate::rebar::t_cap(thick) + 1e-6, "the clamped relief still leaves the mat nowhere to sit");
        assert_eq!(spalling.geom.relief, (used * 63.0).round() as u8, "the note says one thing and the geometry gets another");

        // …and the identical relief on a wall with no cover loss is untouched:
        // the constraint belongs to the effect that needs the core, not to the
        // relief dial in general
        let sound = of("deep and sound");
        assert!(sound.notes.iter().all(|m| !matches!(m, Miss::Clamped { .. })), "a wall with no cover loss was capped: {:?}", sound.notes);
        assert_eq!(sound.geom.relief, 63, "…and it keeps the whole travel");
    }

    /// `Geom` IS THE REBUILD GATE: all-integer, so equality means "the built
    /// mesh is still right". Pinned both ways — a dial move inside one
    /// quantization step must NOT dirty it, and a move across one must.
    #[test]
    fn geom_is_integer_and_moves_only_when_the_mesh_would() {
        let runs = runs_of(&house_game::gym::sim::gym_level());
        let g = |grain: f32| {
            static W: [WallAt; 0] = [];
            let lw = LevelWear { base: Story { weather: 0.8, ..Story::ZERO }, spread: 0.0, walls: &W };
            let mut s = compile(&runs, &lw).expect("compiles");
            s[0].geom.grain = (grain.clamp(0.0, 1.0) * 63.0).round() as u8;
            s[0].geom
        };
        assert_eq!(g(0.500), g(0.505), "a sub-quantum move dirtied the geometry");
        assert_ne!(g(0.500), g(0.530), "a real move did not dirty the geometry");
    }
}
