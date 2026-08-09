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
//! in three words; [`derive()`] turns that into the five layer amounts through a
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

use crate::field::{hash13, mixf, smoothstep};
use glam::Vec3;

// ---------------------------------------------------------------------------
// 1. What happened to this wall
// ---------------------------------------------------------------------------

/// Three CAUSES, each writing a DISJOINT set of layers: `weather` writes the
/// four skin layers, `settlement` writes only breaks, `cover_loss` writes only
/// spall. Nothing writes two causes' layers — that disjointness is what makes
/// the [`derive()`] table legible rather than a second set of hidden couplings.
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
// 1b. The band mask — "the effect shows HERE"
// ---------------------------------------------------------------------------

/// The height every wall band is normalized against, in world units — the
/// authored wall top (`gym_scene::WALL_TOP`, pinned equal by test). A CONSTANT
/// rather than the run's own extent because both shader twins evaluate the
/// mask from a world-space hit position and know nothing about runs; every
/// authored run spans 0..WALL_TOP today, so the two spellings agree.
pub const BAND_TOP: f32 = 2.1875;

/// Feather half-width of a band edge, as a fraction of [`BAND_TOP`] — ~0.13 wu,
/// 5 px on an X face: soft enough that an edge never reads as a painted line,
/// tight enough that "lower half" means the lower half.
pub const BAND_FEATHER: f32 = 0.06;

/// The band's two 6-bit lane codes (effect word lanes 2/3). CODE 0 = that edge
/// is OFF — which makes the default `(0, 1)` authoring pack to `[0, 0]`, so
/// the empty word stays exactly +0.0 and an unbanded wall is provably
/// untouched. The upper edge counts DOWN from the top for the same reason.
pub fn band_codes(lo: f32, hi: f32) -> [u32; 2] {
    [(lo.clamp(0.0, 1.0) * 63.0).round() as u32, ((1.0 - hi.clamp(0.0, 1.0)) * 63.0).round() as u32]
}

/// The mask at normalized height `y01`, from the QUANTIZED codes — never from
/// the raw authored floats, so the solver, the geometry pass and the shader
/// twins (which mirror this exact shape) all evaluate one function.
pub fn band_mask(codes: [u32; 2], y01: f32) -> f32 {
    let y = y01.clamp(0.0, 1.0);
    let mut m = 1.0;
    if codes[0] > 0 {
        let e = codes[0] as f32 / 63.0;
        m *= smoothstep(e - BAND_FEATHER, e + BAND_FEATHER, y);
    }
    if codes[1] > 0 {
        let e = 1.0 - codes[1] as f32 / 63.0;
        m *= 1.0 - smoothstep(e - BAND_FEATHER, e + BAND_FEATHER, y);
    }
    m
}

/// The damage field with a wall's band applied: SUBTRACTION, not
/// multiplication, and the constant matters twice. In-band values pass through
/// EXACTLY (band off = a bit-identical wall, which is what keeps the shipped
/// levels byte-stable), and out-of-band values drop 2.0 — below
/// [`GATE_FULL`]'s −0.06 — so every gate excludes them, including "all of it"
/// (a multiplicative mask leaves 0.0, which the full-coverage gate CATCHES,
/// and the band would leak at the top of every dial).
pub fn banded(field: f32, codes: [u32; 2], y01: f32) -> f32 {
    field - 2.0 * (1.0 - band_mask(codes, y01))
}

// ---------------------------------------------------------------------------
// 2. The layers
// ---------------------------------------------------------------------------

/// SIX layers, ONE unit: the fraction of this wall's face the layer covers.
/// Homogeneous on purpose — a COUNT does not live in here (see [`Breaks`]),
/// because a heterogeneous array is exactly how the old dial set acquired names
/// that lied about their units.
///
/// MUD (2026-07-27, the effect-system round D — the first NEW effect through
/// the whole contract) is the odd citizen in two declared ways: it is
/// PURE-PIN — [`derive()`] never writes it, because splash-back mud is
/// environmental, not a product of the three causes, so the PIN gesture *is*
/// its authoring — and it is not DAMAGE-gated: it draws in its own splash
/// band ([`WallSpec::mud_top`]) through its own story-seeded breakup noise.
/// Its amount is the fraction OF THAT BAND covered, and it is SOLVED like
/// every other layer's — a quantile of the run's own noise samples
/// ([`mud_code`]) — because the first cut tried a global calibration curve
/// and a small band holds so few noise cells that per-story coverage was a
/// 1.8× lottery: the exact defect solved thresholds exist to remove.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Layer {
    Stain,
    Web,
    Cracks,
    Chips,
    Spall,
    Mud,
}

impl Layer {
    pub const N: usize = 6;
    pub const ALL: [Layer; Layer::N] = [Layer::Stain, Layer::Web, Layer::Cracks, Layer::Chips, Layer::Spall, Layer::Mud];
    pub const fn name(self) -> &'static str {
        match self {
            Layer::Stain => "stain",
            Layer::Web => "web",
            Layer::Cracks => "cracks",
            Layer::Chips => "chips",
            Layer::Spall => "spall",
            Layer::Mud => "mud",
        }
    }
    pub const fn index(self) -> usize {
        self as usize
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
    /// No break at all — the same value `Breaks::default()` gives, named for
    /// the generator tests that spell a sheet out by hand. Test-only: a level
    /// says "no break" by leaving the count at zero.
    #[cfg(any(test, feature = "testing"))]
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

/// One artillery hit: a PLACED crater. The place is 2-D run space — `u` along
/// the run, `y` up the wall, both 0..1 — plus WHICH FACE the shell struck
/// (the click's pick ray answers that for free; a file says `back`).
///
/// This is [`Breaks`] taken one step further: a break is a count with an
/// optional place, a shell is nothing BUT places. There is no derivation, no
/// jitter and no probability anywhere — artillery is an event, not a process,
/// so no cause writes it and the placing gesture IS the authoring (the same
/// argument that made mud pure-pin).
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Shell {
    pub u: f32,
    pub y: f32,
    pub back: bool,
}

/// A wall's shell hits: up to [`Shells::MAX`] placed craters sharing ONE
/// caliber — the crater radius in WORLD UNITS, on the [`Shape::grain`]
/// precedent (a shared property of the instances lives on the envelope, in a
/// unit the author can compare against the wall).
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Shells {
    /// Dense by construction: [`Self::add`] fills the first hole,
    /// [`Self::remove`] compacts — so slot order is authoring order and the
    /// serialized file has no gaps to invent a meaning for.
    hits: [Option<Shell>; Shells::MAX],
    pub caliber: f32,
}

impl Shells {
    /// Three, for the same reason breaks stop at three: a wall with a fourth
    /// shell hole in it is rubble, and rubble is the smash demo's job.
    pub const MAX: usize = 3;
    /// Default radius, wu: ~2.5× the spall lens's mean half-extent — clearly
    /// a hit, clearly not corrosion, and it fits the bench's 2.2-wu slab with
    /// room to place it off-centre.
    pub const CALIBER: f32 = 0.30;
    pub const NONE: Shells = Shells { hits: [None; Shells::MAX], caliber: Shells::CALIBER };

    pub fn count(&self) -> usize {
        self.hits.iter().flatten().count()
    }
    pub fn iter(&self) -> impl Iterator<Item = Shell> + '_ {
        self.hits.iter().flatten().copied()
    }
    /// Add into the first free slot; `false` when the wall is full.
    pub fn add(&mut self, s: Shell) -> bool {
        match self.hits.iter_mut().find(|h| h.is_none()) {
            Some(slot) => {
                *slot = Some(s);
                true
            }
            None => false,
        }
    }
    /// Remove hit `i` (slot order) and compact.
    pub fn remove(&mut self, i: usize) {
        if i < Self::MAX {
            self.hits[i] = None;
            let kept: Vec<Shell> = self.hits.iter().flatten().copied().collect();
            self.hits = [None; Self::MAX];
            for (slot, s) in self.hits.iter_mut().zip(kept) {
                *slot = Some(s);
            }
        }
    }
}

/// Amounts the author (or a panel drag) has taken over. `None` = use the value
/// [`derive()`] produced. This is how a bench wall gets ONE effect and nothing
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
/// flush plate (`rt_viewer::crack_geom` applies it, for every pattern, in one
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
    /// The BAND the damage field lives in, as normalized (lower, upper) edges
    /// of the wall's height — the author's "the effect shows HERE". The
    /// default `(0, 1)` is the whole face; the mask enters the FIELD itself
    /// ([`banded`]), so solved areas, painted gates, plates, chips and crater
    /// placement all obey one region. Breaks are deliberately NOT band-gated:
    /// a structural break spans the wall's height by nature, and gating it on
    /// a horizontal band would just be a hidden off-switch.
    pub band: (f32, f32),
    /// MUD's native param: the top edge of its splash band, as a fraction of
    /// the wall's height (the bottom is the floor — splash-back has nowhere
    /// else to come from; `rebar::corr`'s measured splash term peaks at the
    /// same height). Meaningless until `Layer::Mud` is pinned above zero.
    pub mud_top: f32,
    /// The wall's shell hits — PLACED craters, authored by the panel's
    /// place-mode click (or a file's `shell` lines). Deliberately NOT
    /// band-gated and untouched by every level dial, like a pinned break: an
    /// authored place outranks a region mask, and "show me this level clean"
    /// still shows where the shells landed because the hit is an event in the
    /// wall's history, not a stage of its aging.
    pub shells: Shells,
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
    /// Mud's default splash-band top: 0.35 of the wall — the height
    /// `rebar::corr`'s Gaussian splash term was measured to peak around.
    pub const MUD_TOP: f32 = 0.35;
    pub const PRISTINE: WallSpec = WallSpec { story: Story::ZERO, scrub: 0.0, band: (0.0, 1.0), mud_top: WallSpec::MUD_TOP, shells: Shells::NONE, pin: Pins::NONE, shape: Shape::DEFAULT, paint_only: false };
}

// ---------------------------------------------------------------------------
// 3. The level's wear
// ---------------------------------------------------------------------------

/// A level's whole wear authoring: a base story every wall starts from, a
/// spread between runs, and the walls that say something different.
///
/// Since 2026-07-27 this is FILE data (`rt_viewer::wear_file`), not const data:
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
    ///
    /// TEST-ONLY since the wear files (2026-07-27): a shipped level spells a
    /// pristine wall as a bare `wall <x> <z> <name>` line with no statements
    /// under it, and `wear_file` builds the [`WallSpec::PRISTINE`] default
    /// directly. The constructor survives because the parser's own round-trip
    /// test and the addressing tests need a wall with nothing on it.
    #[cfg(any(test, feature = "testing"))]
    pub const fn pristine(at: (f32, f32), label: &'static str) -> WallAt {
        WallAt { at, label, spec: WallSpec::PRISTINE }
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
            0.0,                     // Mud — PURE-PIN: environmental, no cause writes it
        ],
        Breaks { count: (Breaks::MAX as f32 * from(s.settlement, 0.40)).round() as u8, at: None },
    )
}

/// The amounts and breaks a wall actually gets: [`derive()`] from its story, then
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
    /// The whole face's samples, ascending — so the extremes are `sorted`'s two
    /// ends and are not stored a second time (the tests that assert the code
    /// range brackets a run read them from here).
    sorted: Vec<f32>,
}

impl RunField {
    /// THE FIELD — [`crate::field::dmg_field`] itself: one function shared with
    /// the geometry generator (`crack_geom`, and mirrored by both shader twins,
    /// pinned by the source-reading guard in `rt_viewer`'s `wear`), so the
    /// solver's thresholds, the built plates and the painted gates are three
    /// readers of ONE definition by construction. The per-wall `Origin` bias
    /// that used to sit on top is gone (2026-07-27): it moved the SOLVED
    /// THRESHOLD but never reached the field on either host or shader — a knob
    /// that changed how much instead of where. The band mask (effect-system
    /// round C) is the honest version of "damage collects HERE".
    pub fn at(story: f32, u: f32, y: f32) -> f32 {
        crate::field::dmg_field(crate::field::dmg_seed(story), u, y)
    }

    /// Sample a run's whole face on [`LATTICE`] and sort — the BANDED field
    /// ([`banded`]), so a solved threshold only ever spends its area inside
    /// the wall's band and [`Miss::Coarse`] reports an ask the band cannot
    /// hold. `[0, 0]` (band off) samples the raw field bit for bit.
    pub fn of(run_lo: Vec3, run_hi: Vec3, story: f32, band: [u32; 2]) -> RunField {
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
                sorted.push(banded(Self::at(story, u, y), band, y / BAND_TOP));
            }
        }
        sorted.sort_by(|a, b| a.partial_cmp(b).expect("the damage field is finite"));
        RunField { sorted }
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

    /// The field's `(min, max)`, read off the sorted samples themselves — they
    /// are not stored a second time. TEST-ONLY, and there are only two questions
    /// anything asks of them, both about whether the gate CODE RANGE brackets a
    /// run; the tests that ask them measure over the real shipped levels, so they
    /// live in `rt-viewer` and reach `sorted` through here.
    #[cfg(any(test, feature = "testing"))]
    pub fn extremes(&self) -> (f32, f32) {
        (self.sorted[0], self.sorted[self.sorted.len() - 1])
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
/// lanes (`rt_viewer::crack::pad_bits`) where four knobs used to.
#[derive(Clone, Copy, PartialEq, Debug, Default)]
pub struct Paint {
    /// WHERE: threshold codes ([`gate_code`] units), the effect word's lanes 0/1.
    pub stain: u32,
    pub web: u32,
    /// HOW MUCH: the layers' own amounts, `_pad` knob lanes 0/1.
    pub stain_amt: f32,
    pub web_amt: f32,
    /// WHERE ON THE FACE: the band's edge codes ([`band_codes`]), the effect
    /// word's lanes 2/3 — `[0, 0]` = the whole face, and the empty word stays
    /// exactly +0.0.
    pub band: [u32; 2],
    /// MUD: its SOLVED breakup-noise threshold as a 6-bit code (`_pad` knob
    /// lane 2 — 0 = no mud at all, which is what every unstamped material
    /// decodes to) and its splash-band top edge (`_pad` knob lane 3, forced
    /// to 0 while the amount is 0 so a mud-free level leaves the lanes — and
    /// the probe-cache key that hashes them — untouched).
    pub mud: u32,
    pub mud_top: u32,
}

/// Mud's breakup noise — the shader twins' `mudN`, one definition
/// ([`crate::field::fbm`] over the face coords), sampled by the solver
/// below and drawn by both twins.
pub fn mud_noise(story: f32, u: f32, y: f32) -> f32 {
    crate::field::fbm(Vec3::new(u * 2.0, y * 2.0, story * 3.0 + 17.0))
}

/// SOLVE mud's threshold code for one run: the quantile of the run's OWN
/// noise samples inside its OWN splash band that puts `amount` of the band
/// above it — [`RunField::threshold`]'s discipline applied to the mud noise.
/// A global amount→threshold curve was tried first and failed honestly: a
/// splash band a fraction of a wall high holds ~a dozen independent noise
/// cells, so fixed constants made per-story coverage a 1.8× lottery.
///
/// Code 0 = no mud (the unstamped-material value); a live amount clamps to
/// 1..=63, so "asked for mud" can never round to "none".
pub fn mud_code(story: f32, run_lo: Vec3, run_hi: Vec3, amount: f32, mud_top: f32) -> u32 {
    if amount <= 0.0 {
        return 0;
    }
    let run_x = (run_hi.x - run_lo.x) >= (run_hi.z - run_lo.z);
    let (a0, a1) = if run_x { (run_lo.x, run_hi.x) } else { (run_lo.z, run_hi.z) };
    let y1 = (mud_top.clamp(0.0, 1.0) * BAND_TOP).max(LATTICE);
    let n = |a: f32, b: f32| ((((b - a) / LATTICE).round()) as usize).max(2);
    let (nu, ny) = (n(a0, a1), n(0.0, y1));
    let mut vals = Vec::with_capacity(nu * ny);
    for i in 0..nu {
        let u = mixf(a0, a1, (i as f32 + 0.5) / nu as f32);
        for j in 0..ny {
            vals.push(mud_noise(story, u, mixf(0.0, y1, (j as f32 + 0.5) / ny as f32)));
        }
    }
    vals.sort_by(|a, b| a.partial_cmp(b).expect("mud noise is finite"));
    let t = vals[(((1.0 - amount.clamp(0.0, 1.0)) * (vals.len() - 1) as f32).round() as usize).min(vals.len() - 1)];
    ((t * 63.0).round() as u32).clamp(1, 63)
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
    /// The band's edge codes ([`band_codes`]) — the geometry pass masks its
    /// zones and vetoes its crater sites on them, so they sign the rebuild.
    pub band: [u8; 2],
    /// Shell caliber, quantized like the shape dials; 0 when the wall has no
    /// hits, so a caliber drag on a hole-free wall never reports the scene
    /// dirty.
    pub shell_r: u8,
    /// Shell places along the run, `1 + run-thousandths`; **0 = empty slot**,
    /// so `Geom::default()` — the paint-only key — means "no shells" instead
    /// of "three shells at the run's start".
    pub shell_u: [u16; 3],
    /// Shell heights in percent of the wall (fine enough: 1 % = 0.9 px).
    pub shell_y: [u8; 3],
    /// Which face each hit opens on, as a bitmask over the slots.
    pub shell_back: u8,
}

impl Geom {
    /// Decode the shell slots back to `(u, y, back)`, both 0..1 — the ONE
    /// reader (`crack_geom`), fed exactly the integers the rebuild gate
    /// signed, like every other field here.
    pub fn shells(&self) -> impl Iterator<Item = (f32, f32, bool)> + '_ {
        self.shell_u.iter().enumerate().filter(|(_, u)| **u > 0).map(|(i, u)| {
            ((*u - 1) as f32 / 1000.0, self.shell_y[i] as f32 / 100.0, self.shell_back & (1 << i) != 0)
        })
    }
    pub fn shell_count(&self) -> usize {
        self.shell_u.iter().filter(|u| **u > 0).count()
    }
}

/// One wall, compiled: what the author asked for, and what both consumers get.
///
/// A sheet does NOT carry its run index: [`compile_specs`] returns one sheet per
/// run IN RUN ORDER, so the position IS the run, and a second copy of it could
/// only ever disagree. The consumers index the slice (`crack_geom::Wear::of`,
/// `CrackLab.sheets`) and the runtime's own labels live beside it in
/// `CrackLab.label`.
#[derive(Clone, Debug)]
pub struct Sheet {
    /// The authored wall's name. TEST-ONLY: at runtime the labels ride
    /// `CrackLab.label` (which the IDE hierarchy and the wear-file save read),
    /// and a [`Miss`] carries its own copy — so nothing in the render path asks
    /// a sheet what it is called. The compile-time authoring checks do.
    #[cfg(any(test, feature = "testing"))]
    pub label: &'static str,
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
/// downstream can be right, so [`specs_of`] fails on them. The other two are
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
        story_key(self.lo, self.hi)
    }
    /// Run length — the long side, and with [`Self::thick`] the whole of a
    /// run's extent. Public on its merits, not as a test affordance: a crate
    /// whose subject IS the wall owes its callers the wall's dimensions, and
    /// both are read inside this module by the relief cap and the shell grid.
    /// (Contrast the genuinely authoring-only helpers — `compile`,
    /// `WallAt::pristine`, `Sheet::label`, `Breaks::NONE` — which are behind
    /// the `testing` feature because nothing but a test has business calling
    /// them.)
    pub fn length(&self) -> f32 {
        (self.hi.x - self.lo.x).max(self.hi.z - self.lo.z)
    }
    /// Slab thickness — the short side. Every depth budget in the renderer is
    /// measured against it, so the authoring model has to know it too.
    pub fn thick(&self) -> f32 {
        (self.hi.x - self.lo.x).min(self.hi.z - self.lo.z)
    }
}

/// The STORY KEY of a wall RUN: one seed shared by every pier the run was cut
/// into. A pure function of the AUTHORED slab (`Pier::run_lo`/`run_hi`), so the
/// three panels of one facade agree while the facade round the corner — a
/// different `wall_slab` call, a different rect — does not.
///
/// Quantized to the 0.1-wu authoring grid (the game projection's lattice: see
/// the pixel-perfect contract) before hashing, so the key can never wobble on a
/// float-exact rebuild. `y` is not hashed: every authored run spans 0..WALL_TOP,
/// so it carries no identity.
///
/// The value is `(hash & 255) × 0.618` — DELIBERATELY the same distribution and
/// 0..157.5 range as the `(material_id & 255) × 0.618` per-panel seed it
/// replaces, so every field seeded off it ([`crate::field::dmg_seed`] for the
/// damage fbm, `story+5`/`story+9` for the craze lattices) lands in the numeric
/// regime those fields were tuned in. A low-byte collision would merely give two
/// facades the same story, which is harmless; the gym's runs are pinned distinct
/// by a test.
///
/// It lives HERE, next to the [`RunRect`] whose rect it hashes, because a value
/// with one meaning gets one home: `rt_viewer`'s `wear` — which STAMPS it into
/// `Material.base_color[3]` for the shade pass — used to own the definition while
/// this module reached across for it, so the authoring model depended on the
/// material codec to know what a run is called.
pub fn story_key(run_lo: Vec3, run_hi: Vec3) -> f32 {
    (run_hash(run_lo, run_hi, 0) & 255) as f32 * 0.618
}

/// FNV-1a over a RUN's quantized authoring rect. `salt` is here to separate
/// INDEPENDENT per-run draws so two of them can never alias into the same value;
/// only salt 0 (the story key) has a caller today — the field level's damaged
/// fraction was the second one, and solved thresholds retired it. Salt 0
/// reproduces the story key's original hash byte for byte
/// (`0 ^ basis == basis`), which is load-bearing: the key seeds every damage
/// pattern in the level, every break in it, and the probe cache hashes it.
fn run_hash(run_lo: Vec3, run_hi: Vec3, salt: u32) -> u32 {
    let mut h: u32 = 0x811c_9dc5 ^ salt;
    for v in [run_lo.x, run_lo.z, run_hi.x, run_hi.z] {
        h ^= (v * 10.0).round() as i32 as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
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

/// Compile a level's authored wear against its runs — [`specs_of`] then
/// [`compile_specs`], the two halves in one call.
///
/// TEST-ONLY: the runtime keeps the halves apart on purpose (`CrackLab::load`
/// resolves once and recompiles the specs on every edit, so a live drag never
/// re-reads the level). What needs both at once is the check that every shipped
/// level ADDRESSES walls that exist, and that check is a test.
#[cfg(any(test, feature = "testing"))]
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
        // is applied here, once, and SAID. A wall with SHELL hits pays it too
        // (a hit's basin cuts past the same mat); walls that need no core are
        // untouched — the constraint belongs to the effects that need it, not
        // to the relief dial in general.
        if area[Layer::Spall.index()] > 0.0 || spec.shells.count() > 0 {
            let cap = crate::rebar::t_cap(r.thick());
            if veneer(spec.shape.relief, r.thick()) > cap + 1e-6 {
                let used = relief_of(cap, r.thick());
                notes.push(Miss::Clamped { label, dial: "relief", asked: spec.shape.relief, used });
                spec.shape.relief = used;
            }
        }
        let (shell_r, shell_u, shell_y, shell_back) = compile_shells(&spec.shells, r, label, &mut notes);
        let band = band_codes(spec.band.0, spec.band.1);
        let story = scrub_key(r.story(), spec.scrub);
        let field = RunField::of(r.lo, r.hi, story, band);
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
            // Mud is exempt with Spall: neither is realized by thresholding
            // the field (craters are counted out of it, mud draws through its
            // own splash band + breakup), so their gates are not what they
            // draw through. Mud's own promise is pinned by measurement
            // (`mud_coverage_is_calibrated`).
            let got = field.coverage(gate[l.index()]);
            if !matches!(l, Layer::Spall | Layer::Mud) && area[l.index()] > 0.0 && (got - area[l.index()]).abs() > 0.08 {
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
            #[cfg(any(test, feature = "testing"))]
            label,
            area,
            breaks,
            gate,
            paint: Paint {
                stain: gate_code(gate[Layer::Stain.index()]),
                web: gate_code(gate[Layer::Web.index()]),
                stain_amt: area[Layer::Stain.index()],
                web_amt: area[Layer::Web.index()],
                band,
                mud: mud_code(story, r.lo, r.hi, area[Layer::Mud.index()], spec.mud_top),
                mud_top: if area[Layer::Mud.index()] > 0.0 { (spec.mud_top.clamp(0.0, 1.0) * 63.0).round() as u32 } else { 0 },
            },
            notes,
            geom: Geom {
                band: [band[0] as u8, band[1] as u8],
                t_cracks: gate_code(gate[Layer::Cracks.index()]) as u8,
                t_chips: gate_code(gate[Layer::Chips.index()]) as u8,
                spall: q(area[Layer::Spall.index()]),
                grain: q(spec.shape.grain),
                relief: q(spec.shape.relief),
                pattern: spec.shape.pattern.code(),
                par,
                breaks: breaks.count,
                break_at: breaks.at.map_or(u16::MAX, |a| (a.clamp(0.0, 1.0) * 1000.0).round() as u16),
                shell_r,
                shell_u,
                shell_y,
                shell_back,
            },
        });
    }
    sheets
}

/// Compile a wall's SHELLS against its run: the caliber cap, the legal-centre
/// clamp and the overlap discipline, all decided HERE on the authored data —
/// so the geometry pass can never be handed an impossible pair, and every
/// limit is a [`Miss`] in the wall's own row instead of a crater that quietly
/// fails to appear.
///
/// Overlap is a DROP, not a nudge: two patches on one face would carve
/// intersecting basins, and two facing each other would perforate the slab
/// (each digs past half the thickness) — and moving a hit to make room would
/// mean the place the author clicked is not the place the shell landed. Slot
/// order wins, because slot order is authoring order.
fn compile_shells(shells: &Shells, r: &RunRect, label: &'static str, notes: &mut Vec<Miss>) -> (u8, [u16; 3], [u8; 3], u8) {
    const NONE: (u8, [u16; 3], [u8; 3], u8) = (0, [0; 3], [0; 3], 0);
    if shells.count() == 0 {
        return NONE;
    }
    let (len, height) = (r.length(), r.hi.y - r.lo.y);
    let cap = crate::rebar::shell_r_cap(len, height);
    let asked = shells.caliber.max(crate::rebar::SHELL_R_MIN);
    if cap < crate::rebar::SHELL_R_MIN {
        // this wall cannot hold even the smallest readable shell
        notes.push(Miss::Clamped { label, dial: "caliber", asked, used: 0.0 });
        return NONE;
    }
    // Quantize FIRST, rounding down onto the cap when the grid would poke past
    // it — the legality below is computed on `used`, and `used` is bit-exactly
    // what the generator will dequantize (`Geom.shell_r`), so the two can
    // never disagree about whether a patch fits. The Miss is keyed on the CAP,
    // not on the grid: the grid is not a limit, it is the dial's resolution.
    let mut code = ((asked.min(cap)).clamp(0.0, 1.0) * 63.0).round() as u8;
    if code as f32 / 63.0 > cap {
        code -= 1;
    }
    let used = code as f32 / 63.0;
    if asked > cap + 1e-6 {
        notes.push(Miss::Clamped { label, dial: "caliber", asked, used });
    }
    let Some((lo_c, hi_c)) = crate::rebar::shell_center_box(len, height, used) else { return NONE };
    let pu = crate::rebar::shell_patch_half(used);
    let (mut u_out, mut y_out, mut back_out) = ([0u16; 3], [0u8; 3], 0u8);
    let mut kept: Vec<glam::Vec2> = Vec::new();
    for s in shells.iter() {
        let c = glam::Vec2::new(s.u.clamp(0.0, 1.0) * len, s.y.clamp(0.0, 1.0) * height).clamp(lo_c, hi_c);
        if kept.iter().any(|o| (c.x - o.x).abs() < 2.0 * pu + crate::rebar::PATCH_GAP && (c.y - o.y).abs() < 2.0 * pu + crate::rebar::PATCH_GAP) {
            continue;
        }
        let i = kept.len();
        u_out[i] = 1 + (c.x / len * 1000.0).round() as u16;
        y_out[i] = (c.y / height * 100.0).round() as u8;
        back_out |= (s.back as u8) << i;
        kept.push(c);
    }
    if kept.len() < shells.count() {
        notes.push(Miss::Clamped { label, dial: "shells", asked: shells.count() as f32, used: kept.len() as f32 });
    }
    if kept.is_empty() {
        return NONE;
    }
    (code, u_out, y_out, back_out)
}

/// The claims that are ARITHMETIC — provable about the model itself, on data
/// this module can spell out.
///
/// The other eleven measure a property over the REAL SHIPPED LEVELS: they build
/// the gym (or the catalogue) through `gym_scene::build_gym`, which needs a
/// `Scene`, which is the GPU crate. Those stayed in `rt-viewer`
/// (`rt-viewer/src/wall_tests.rs`) and call back in through `wear_core::wall::…`
/// — they are integration tests by nature, and the crate split is what made that
/// honest. Rewriting one of them onto a synthetic fixture to bring it along would
/// have deleted exactly the property that makes it worth having.
#[cfg(test)]
mod tests {
    use super::*;

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

    /// A SHELL IS A PLACE, and every limit it can hit is a reported one: the
    /// caliber cap says so, an overlapping pair drops the LATER hit and says
    /// so, and a wall too small for the smallest readable shell says so —
    /// nothing in this feature can quietly fail to appear.
    #[test]
    fn a_shell_is_a_place_and_its_limits_report() {
        let r = RunRect { lo: glam::Vec3::new(1.0, 0.0, 9.9), hi: glam::Vec3::new(7.0, 2.1875, 10.1) };
        let hit = |u: f32, y: f32, back: bool| Shell { u, y, back };
        let mut sh = Shells::NONE;
        sh.add(hit(0.3, 0.6, false));
        sh.add(hit(0.8, 0.4, true));
        let sheet = compile_specs(std::slice::from_ref(&r), &[("hit twice", WallSpec { shells: sh, ..WallSpec::PRISTINE })]).remove(0);
        let g = sheet.geom;
        assert_eq!(g.shell_count(), 2);
        assert!(g.shell_r > 0, "the caliber rides the key — a caliber drag must rebuild");
        let hits: Vec<(f32, f32, bool)> = g.shells().collect();
        assert!((hits[0].0 - 0.3).abs() < 0.01 && (hits[0].1 - 0.6).abs() < 0.02 && !hits[0].2, "{hits:?}");
        assert!((hits[1].0 - 0.8).abs() < 0.01 && hits[1].2, "the second hit keeps its face: {hits:?}");
        assert!(sheet.notes.is_empty(), "legal shells carry no note: {:?}", sheet.notes);
        // `Geom::default()` is the paint-only key, and it must mean NO shells —
        // the empty-slot encoding (0, not a place) exists for exactly this
        assert_eq!(Geom::default().shell_count(), 0);

        // the caliber cap reports, and the used radius is bit-exactly what the
        // generator dequantizes — grid and cap can never disagree about a fit
        let mut big = sh;
        big.caliber = 0.9;
        let sheet = compile_specs(std::slice::from_ref(&r), &[("too big", WallSpec { shells: big, ..WallSpec::PRISTINE })]).remove(0);
        assert!(sheet.notes.iter().any(|n| matches!(n, Miss::Clamped { dial: "caliber", .. })), "{:?}", sheet.notes);
        assert!(sheet.geom.shell_count() > 0, "clamped, not dropped");
        assert!(sheet.geom.shell_r as f32 / 63.0 <= crate::rebar::shell_r_cap(6.0, 2.1875) + 1e-6);

        // overlap drops the LATER hit — same face or facing, either way (a
        // facing pair perforates the slab) — and never nudges: the place the
        // author clicked is the place the shell landed
        let mut twin = Shells::NONE;
        twin.add(hit(0.5, 0.5, false));
        twin.add(hit(0.52, 0.5, true));
        let sheet = compile_specs(std::slice::from_ref(&r), &[("stacked", WallSpec { shells: twin, ..WallSpec::PRISTINE })]).remove(0);
        assert_eq!(sheet.geom.shell_count(), 1, "the later hit is dropped");
        assert!((sheet.geom.shells().next().unwrap().0 - 0.5).abs() < 0.01, "…and the FIRST keeps its place");
        assert!(sheet.notes.iter().any(|n| matches!(n, Miss::Clamped { dial: "shells", .. })), "{:?}", sheet.notes);

        // a wall too small for even the smallest readable shell: nothing built,
        // and the note's `used: 0` says why
        let tiny = RunRect { lo: glam::Vec3::new(1.0, 0.0, 9.9), hi: glam::Vec3::new(1.4, 2.1875, 10.1) };
        let mut one = Shells::NONE;
        one.add(hit(0.5, 0.5, false));
        let sheet = compile_specs(std::slice::from_ref(&tiny), &[("doorway pier", WallSpec { shells: one, ..WallSpec::PRISTINE })]).remove(0);
        assert_eq!(sheet.geom.shell_count(), 0);
        assert!(sheet.notes.iter().any(|n| matches!(n, Miss::Clamped { dial: "caliber", used, .. } if *used == 0.0)), "{:?}", sheet.notes);
    }
}
