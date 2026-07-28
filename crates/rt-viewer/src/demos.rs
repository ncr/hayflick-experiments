//! Named demos for the owner-facing LEVELS menu (owner directive 2026-07-16:
//! deliver anything I want the owner to see in person as a named,
//! self-describing menu entry — a demo is "sort of a level conceptually" —
//! never as a CLI/env recipe he has to run himself).
//!
//! A demo is a boot config (`look`, `spawn`) + a **tick-driven timeline**
//! (`script`) of scheduled [`Beat`]s. Because the timeline is driven by the
//! deterministic sim tick, a demo renders headlessly frame-for-frame — the
//! agent boots it with `LEVEL=<name|index>` and the DEMO harness plays the
//! exact thing the owner sees (that closes the "can't drive the live menu"
//! verification gap). The menu entry is the OWNER's surface; `LEVEL=` is mine.
//!
//! Authoring a demo is meant to be trivial: add a `Demo` literal with a short
//! `blurb` and a `script` of `(at_tick, action)` beats. Beats can fire
//! one-shot events (tear the roof) OR drive gradual animations (cross-fade the
//! lighting to another look over N ticks — see [`Action::MorphTo`]).
//!
//! `outdated` marks a demo kept only for reference after a pivot: it still
//! lists (greyed, tagged) but signals "disposable, not maintained" so old
//! demos never become a legacy-code obligation — delete them when convenient.

/// One scheduled beat on a demo's timeline (fires when the sim tick reaches
/// `at`, counting from the demo boot at tick 0).
pub struct Beat {
    pub at: u64,
    pub action: Action,
}

/// What a beat does. One-shots fire once; `MorphTo` starts an animation the
/// per-frame runner advances until it completes.
pub enum Action {
    /// Tear the roof off and let the dynamic GI settle (the DDGI flood).
    TearRoof,
    /// Cross-fade the LIGHTING to another look over `over` ticks (sun angle +
    /// tint, sky dome, exposure, response, post sat/contrast — everything in
    /// [`crate::look::Lit`]). Smooth, no rebake; the palette stays at the boot
    /// look. `look` is `crate::look::by_name`.
    MorphTo { look: &'static str, over: u64 },
    /// Weather the wall pier containing world point (x, z) from PRISTINE to
    /// fully aged over `over` ticks — the whole greybox-wear catalogue as one
    /// continuous read instead of a before/after pair (`crack::ramp_story` owns
    /// the curve and the order the causes arrive in).
    ///
    /// The wall must boot pristine — a bare `wall <x> <z> <name>` line in the
    /// level's wear file, with no statements under it — because a ramp that
    /// starts on an already-weathered wall shows only its top half.
    ///
    /// Painted layers (stains, the fine glaze web, chip patches) ride the
    /// per-frame material stream, so they move every frame for free; the
    /// GEOMETRY (grooves, plates, the cover spall and its rebar) only exists
    /// after a scene rebuild, so the runner marks a few frames as COMMITS. That
    /// is the whole design decision: pre-building the stages would need one
    /// baked probe set per stage, while a commit that defers its GI to the DDGI
    /// roll costs ~30 ms — two frames — and only fires when the geometry
    /// signature actually moved.
    AgeWall { x: f32, z: f32, over: u64 },
    /// Smash the wall pier containing world point (x, z) — phase 3, physics ×
    /// dynamic GI: the pier is TLAS-masked and its bricks (pre-authored at
    /// boot from the SAME layout) go live as a box3d world, a slug already
    /// inbound; the rolling probe refresh tracks the breach as it opens. The
    /// viewer resolves the pier + arms the brick runs at boot
    /// ([`Demo::smash_point`]), the beat only pulls the trigger.
    SmashWall { x: f32, z: f32 },
}

/// Which hand-authored level a demo boots. The gym is THE scene (CLAUDE.md);
/// the catalogue is the owner's 2026-07-26 exception — a bench whose only job
/// is to hold one effect per wall under identical light.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Level {
    Gym,
    Catalogue,
}

impl Level {
    pub fn spec(self) -> house_game::gym::sim::GymLevel {
        match self {
            Level::Gym => house_game::gym::sim::gym_level(),
            Level::Catalogue => house_game::gym::sim::catalogue_level(),
        }
    }
}

pub struct Demo {
    /// Menu label.
    pub name: &'static str,
    /// Which level layout to build (almost always [`Level::Gym`]).
    pub level: Level,
    /// One-line, owner-facing description of what the demo shows (menu footer).
    pub blurb: &'static str,
    /// Boot look preset (`crate::look::by_name`) — the palette + starting light.
    pub look: &'static str,
    /// Player start cell (gym grid). Interior is x3-7 / z3-7, doorway at (5,7).
    pub spawn: (i16, i16),
    /// Timeline of scheduled beats (sorted by `at`; ticks from boot).
    pub script: &'static [Beat],
    /// The level's WEAR: `Some` loads this wear FILE, compiles its authoring
    /// onto the level's wall RUNS at boot AND enables the lab interaction
    /// (click a wall, drag the panel; interactive edits save back to the
    /// file). `None` = untouched porcelain + no panel (every other demo).
    pub wear: Option<&'static crate::wear_file::WearFile>,
    /// Kept for reference after a pivot: disposable, not maintained.
    pub outdated: bool,
}

pub static DEMOS: &[Demo] = &[
    Demo {
        name: "gym",
        level: Level::Gym,
        blurb: "the plain greybox gym in polana daylight",
        look: "polana",
        spawn: (10, 11),
        script: &[],
        wear: None,
        outdated: false,
    },
    Demo {
        name: "dusk flood",
        level: Level::Gym,
        blurb: "roof tears at dusk - warm light floods, GI settles",
        look: "dusk",
        spawn: (5, 5),
        script: &[Beat { at: 45, action: Action::TearRoof }],
        wear: None,
        outdated: false,
    },
    Demo {
        name: "day to dusk",
        level: Level::Gym,
        blurb: "the gym morphs from noon to golden dusk over ~3s",
        look: "polana",
        spawn: (10, 11),
        script: &[Beat { at: 20, action: Action::MorphTo { look: "dusk", over: 180 } }],
        wear: None,
        outdated: false,
    },
    Demo {
        name: "wall smash",
        level: Level::Gym,
        // dusk sun sits to the SOUTH-EAST (look.rs) — it pours straight
        // through the east-facade breach the moment the bricks clear it
        blurb: "a slug smashes the east wall to bricks - dusk light breaches",
        look: "dusk",
        // due east of the breach, 4.5 wu out along world-X: the ROI reveal
        // disc is a SCREEN disc (~180 px) around the centred player that
        // stipples every occluder it touches, and world-X maps longest on
        // screen (~82 px/wu) — so a big X offset clears the disc while the
        // facade still reads large. The slug whooshes right past the player.
        spawn: (12, 5),
        script: &[Beat { at: 40, action: Action::SmashWall { x: 8.0, z: 5.5 } }],
        wear: None,
        outdated: false,
    },
    Demo {
        name: "crack lab",
        level: Level::Gym,
        blurb: "aged facades, one clean wall = the before; a wall ages live; click for knobs",
        look: "polana",
        // FACING THE BUILDING (2026-07-25): the lab used to open at (13, 12),
        // between the two freestanding garden walls — both SINGLE-PIER runs, so
        // "one wall, one story" has no joint to cross and no ramp, and they have
        // no cap, no windows, no corner and no jambs, i.e. most of the round's
        // causal gates were off screen. From here the building's south-east
        // corner fills the upper half: two facades, their window reveals, the
        // doorway jambs and the parapet cap, with the z=10 garden wall as
        // foreground and the x=12 spur top-right.
        //
        // The ROI reveal disc only dissolves occluders IN FRONT of the player
        // (`dot(hit.xz - player.xz, fwd) >= 0` breaks the walk), and the
        // trimetric camera looks down (1, 2) in xz — so a wall is safe when its
        // `x + 2z` is below the player's. At (9.5, 11.5) the whole building
        // (max 24.2) and the garden wall's near half are behind that plane, and
        // the wall's crossover into the disc sits 152 px out, well past the
        // 79+33 px disc. Standing NORTH of the garden wall instead would ghost
        // it from end to end.
        spawn: (9, 11),
        // …and one wall weathers while he watches, so the whole catalogue
        // arrives as one continuous read (see `Action::AgeWall`). It starts a
        // second in, so the boot frame is the honest "before".
        script: &[Beat { at: 60, action: Action::AgeWall { x: 13.0, z: 10.0, over: 180 } }],
        wear: Some(&LAB_WEAR_FILE),
        outdated: false,
    },
    Demo {
        name: "effect catalogue",
        level: Level::Catalogue,
        blurb: "one effect per wall, 18 identical slabs - the bench for picking what to work on",
        look: "polana",
        // the far corner: every specimen's `x + 2z` is below this cell's, so
        // the ROI reveal can never ghost one (see `catalogue_level`)
        spawn: (20, 16),
        script: &[],
        wear: Some(&CATALOGUE_WEAR_FILE),
        outdated: false,
    },
];

/// THE CRACK LAB's wear file (owner surface for the whole greybox-wear
/// family): one BASE story every wall starts from, a per-RUN spread so the
/// level reads varied the moment it opens, and two named controls — the z=10
/// garden wall the AgeWall beat ramps (it must boot pristine to ramp FROM
/// pristine) and the x=12 spur that stays clean all session, the negative
/// control the aged facades are read against. `cover_loss` boots ON (the
/// owner's 2026-07-25 headline); the spread takes walls DOWN from the base,
/// which keeps some of them visibly sound.
pub static LAB_WEAR_FILE: crate::wear_file::WearFile =
    crate::wear_file::WearFile::new("crack lab", include_str!("../wear/crack_lab.wear"), "crates/rt-viewer/wear/crack_lab.wear");

/// THE CATALOGUE's wear file: no base at all (the bench's whole point is that
/// a wall shows what its own lines say and not one thing more), fifteen slabs
/// in three rows — row 0 = pattern and scale, row 1 = loss, row 2 = paint,
/// rows 0 and 2 each opening on a PRISTINE control — plus row 3 for the
/// placed effects (a control, the mud splash, the shell hole). Every slab
/// pins every OTHER layer to zero, which is what makes "one effect per wall"
/// a fact about the data rather than a hope about the numbers.
pub static CATALOGUE_WEAR_FILE: crate::wear_file::WearFile =
    crate::wear_file::WearFile::new("effect catalogue", include_str!("../wear/catalogue.wear"), "crates/rt-viewer/wear/catalogue.wear");

/// The lab's loaded authoring — the tests' shorthand; the viewer itself goes
/// through `Demo::wear` so a menu switch and a `LEVEL=` boot read one path.
#[cfg(test)]
pub fn lab_wear() -> &'static crate::wall::LevelWear {
    LAB_WEAR_FILE.level_wear()
}

/// The catalogue's loaded authoring (the specimen tests walk its walls).
#[cfg(test)]
pub fn catalogue_wear() -> &'static crate::wall::LevelWear {
    CATALOGUE_WEAR_FILE.level_wear()
}

impl Demo {
    /// The demo's wall-breach point, if its script smashes one — the viewer
    /// arms the brick runs + the pier rig at boot from this (the layout must
    /// exist in the scene before the backend builds it).
    pub fn smash_point(&self) -> Option<(f32, f32)> {
        self.script.iter().find_map(|b| match b.action {
            Action::SmashWall { x, z } => Some((x, z)),
            _ => None,
        })
    }
}

pub fn by_name(name: &str) -> Option<&'static Demo> {
    DEMOS.iter().find(|d| d.name == name)
}

/// Sim ticks between GEOMETRY commits during an [`Action::AgeWall`] ramp.
///
/// 12 ticks = 0.2 s, which is the grain at which a crack network visibly grows
/// rather than jumping. A commit whose pier signature did not move returns
/// without rebuilding, so this is an upper bound; measured on the shipped
/// 180-tick ramp, all 16 attempts DO move the geometry (18 091 → 33 517 tris)
/// and each costs 21-32 ms on the M2 — under two frames, because the GI goes to
/// the roll (`ProbeRefresh::Roll`) instead of the 5 s synchronous refresh.
const AGE_COMMIT_TICKS: u64 = 12;

/// An in-flight wall-aging ramp ([`Action::AgeWall`]).
struct AgeRamp {
    x: f32,
    z: f32,
    start: u64,
    over: u64,
}

/// This frame's slice of an age ramp: the wall (world x/z, resolved to a pier by
/// the viewer), how far along the ramp is, and whether the GEOMETRY should be
/// rebuilt this frame.
#[derive(Clone, Copy)]
pub struct AgeStep {
    pub x: f32,
    pub z: f32,
    pub t: f32,
    pub commit: bool,
}

/// An in-flight look cross-fade: lerp the lightable half of `from`→`to`
/// ([`crate::look::Lit`]) as the sim tick sweeps `start..start+over`.
struct LookMorph {
    from: &'static crate::look::Look,
    to: &'static crate::look::Look,
    start: u64,
    over: u64,
}

/// The per-frame outputs of a [`DemoRunner`] step, for the game loop to apply
/// to its generic knobs (so no demo logic leaks into the loop).
pub struct DemoStep {
    /// Tear the roof off this frame (the DDGI flood).
    pub tear: bool,
    /// Fire the wall smash this frame (the armed rig knows the pier).
    pub smash: bool,
    /// The cross-fade lighting to apply this frame (`None` = no active morph;
    /// the loop leaves its lighting untouched).
    pub lit: Option<crate::look::Lit>,
    /// This frame's age-ramp slice (`None` = no ramp running).
    pub age: Option<AgeStep>,
}

/// Drives a demo's tick timeline: fires scheduled beats and advances the
/// active look morph. Self-contained state machine with NO renderer/viewer
/// coupling — it consumes the sim tick + the current look and emits a
/// [`DemoStep`] the loop maps onto generic knobs (tear, exposure, env, …).
pub struct DemoRunner {
    script: &'static [Beat],
    cursor: usize,
    morph: Option<LookMorph>,
    age: Option<AgeRamp>,
}

impl DemoRunner {
    pub fn new(script: &'static [Beat]) -> DemoRunner {
        DemoRunner { script, cursor: 0, morph: None, age: None }
    }

    /// The wall an [`Action::AgeWall`] beat ramps, if the script has one — the
    /// viewer resolves it against the freshly built piers at boot so a point
    /// that misses every wall is reported once, not silently every frame.
    pub fn age_point(script: &[Beat]) -> Option<(f32, f32)> {
        script.iter().find_map(|b| match b.action {
            Action::AgeWall { x, z, .. } => Some((x, z)),
            _ => None,
        })
    }

    /// Stop any in-flight look cross-fade (a hard look switch supersedes it).
    /// The rest of the timeline keeps running.
    pub fn cancel_morph(&mut self) {
        self.morph = None;
    }

    /// Advance the timeline to `tick`: fire every due beat (a `MorphTo` anchors
    /// its start on `look`, the live look at fire time), then sample the active
    /// morph. Idempotent within a tick — beats fire once via the cursor.
    pub fn step(&mut self, tick: u64, look: &'static crate::look::Look) -> DemoStep {
        let mut tear = false;
        let mut smash = false;
        while self.cursor < self.script.len() && self.script[self.cursor].at <= tick {
            match &self.script[self.cursor].action {
                Action::TearRoof => tear = true,
                Action::SmashWall { .. } => smash = true,
                Action::MorphTo { look: to, over } => {
                    if let Some(to) = crate::look::by_name(to) {
                        self.morph = Some(LookMorph { from: look, to, start: tick, over: (*over).max(1) });
                    }
                }
                Action::AgeWall { x, z, over } => {
                    self.age = Some(AgeRamp { x: *x, z: *z, start: tick, over: (*over).max(1) });
                }
            }
            self.cursor += 1;
        }
        // the ramp emits its FINAL frame (t = 1, a commit) before it retires, so
        // the wall always lands on the full aged state even if `over` and
        // `AGE_COMMIT_TICKS` do not divide
        let age = self.age.as_ref().map(|a| {
            let n = tick.saturating_sub(a.start);
            let t = (n as f32 / a.over as f32).min(1.0);
            AgeStep { x: a.x, z: a.z, t, commit: n.is_multiple_of(AGE_COMMIT_TICKS) || n >= a.over }
        });
        if let Some(a) = &self.age {
            if tick >= a.start + a.over {
                self.age = None;
            }
        }
        let lit = self.morph.as_ref().map(|m| {
            let t = (tick.saturating_sub(m.start) as f32) / m.over as f32;
            crate::look::lerp_lit(m.from, m.to, t)
        });
        // Drop the morph once its window closes; the final `Lit` (t=1) was just
        // emitted, and the loop's env_override + tunables hold it thereafter.
        if let Some(m) = &self.morph {
            if tick >= m.start + m.over {
                self.morph = None;
            }
        }
        DemoStep { tear, smash, lit, age }
    }
}

/// Resolve a demo from `LEVEL` (name or index) — the agent/harness boot knob
/// that renders a demo's timeline headlessly. `None` = no demo selected.
pub fn from_env() -> Option<&'static Demo> {
    let v = std::env::var("LEVEL").ok()?;
    v.parse::<usize>().ok().and_then(|i| DEMOS.get(i)).or_else(|| by_name(&v))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The wall-smash demo names the east facade's middle-pier breach point,
    /// and its runner fires the smash exactly once (the one-shot cursor).
    #[test]
    fn wall_smash_demo_fires_its_beat_once() {
        let demo = by_name("wall smash").expect("the phase-3 demo exists");
        assert_eq!(demo.smash_point(), Some((8.0, 5.5)), "breach point pins the east middle pier");
        assert_eq!(demo.look, "dusk", "the dusk sun is SE — it pours through an east breach");
        let look = crate::look::by_name(demo.look).unwrap();
        let mut runner = DemoRunner::new(demo.script);
        let fired: Vec<u64> = (0..120).filter(|&t| runner.step(t, look).smash).collect();
        assert_eq!(fired, vec![40], "one smash, at the scripted beat");
    }

    /// The age-ramp beat's TIMELINE contract, which the viewer relies on and
    /// cannot check itself: the ramp opens on the pristine state (t = 0, and a
    /// commit, so the geometry starts from the greybox), sweeps monotonically to
    /// EXACTLY 1, commits on a fixed tick grid, and retires afterwards so a
    /// finished beat stops writing knobs the owner may then have dialled.
    #[test]
    fn the_age_ramp_sweeps_zero_to_one_and_retires() {
        let demo = by_name("crack lab").expect("the crack lab demo");
        let (x, z) = DemoRunner::age_point(demo.script).expect("it ages a wall");
        assert_eq!(demo.script.len(), 1, "one beat: the ramp");
        let Action::AgeWall { over, .. } = demo.script[0].action else { panic!("the beat must be an AgeWall") };
        let start = demo.script[0].at;
        assert!(over >= 120, "a ramp shorter than two seconds cannot be read: {over} ticks");
        let look = crate::look::by_name(demo.look).unwrap();
        let mut runner = DemoRunner::new(demo.script);
        let steps: Vec<(u64, AgeStep)> = (0..start + over + 60).filter_map(|t| runner.step(t, look).age.map(|a| (t, a))).collect();
        assert_eq!(steps.first().map(|s| s.0), Some(start), "the ramp starts on its beat's tick");
        assert_eq!(steps.last().map(|s| s.0), Some(start + over), "…and stops the tick it completes");
        assert!(steps.iter().all(|(_, a)| (a.x, a.z) == (x, z)), "every frame names the same wall");
        assert_eq!(steps[0].1.t, 0.0, "the first frame is the PRISTINE control, so the beat shows the whole change");
        assert!(steps[0].1.commit, "…and commits, so the geometry starts from the greybox too");
        assert_eq!(steps.last().unwrap().1.t, 1.0, "the last frame lands on full age exactly");
        assert!(steps.last().unwrap().1.commit, "…and commits it, whatever `over` does modulo the commit grid");
        assert!(steps.windows(2).all(|w| w[1].1.t >= w[0].1.t), "t never goes backwards");
        let commits = steps.iter().filter(|(_, a)| a.commit).count();
        assert_eq!(commits, (over / AGE_COMMIT_TICKS) as usize + 1, "commits sit on the {AGE_COMMIT_TICKS}-tick grid");
        assert!(commits >= 8, "too few geometry steps to read as growth: {commits}");
        // …and once it is over, the runner leaves the wall alone
        assert!((start + over + 1..start + over + 60).all(|t| runner.step(t, look).age.is_none()), "a finished ramp must stop writing knobs");
    }

    /// Demos without a smash beat report no breach point — the viewer must
    /// not author brick runs for them.
    #[test]
    fn non_smash_demos_have_no_breach_point() {
        for d in DEMOS.iter().filter(|d| d.name != "wall smash") {
            assert_eq!(d.smash_point(), None, "{}", d.name);
        }
    }
}
