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
    /// Smash the wall pier containing world point (x, z) — phase 3, physics ×
    /// dynamic GI: the pier is TLAS-masked and its bricks (pre-authored at
    /// boot from the SAME layout) go live as a box3d world, a slug already
    /// inbound; the rolling probe refresh tracks the breach as it opens. The
    /// viewer resolves the pier + arms the brick runs at boot
    /// ([`Demo::smash_point`]), the beat only pulls the trigger.
    SmashWall { x: f32, z: f32 },
}

pub struct Demo {
    /// Menu label.
    pub name: &'static str,
    /// One-line, owner-facing description of what the demo shows (menu footer).
    pub blurb: &'static str,
    /// Boot look preset (`crate::look::by_name`) — the palette + starting light.
    pub look: &'static str,
    /// Player start cell (gym grid). Interior is x3-7 / z3-7, doorway at (5,7).
    pub spawn: (i16, i16),
    /// Timeline of scheduled beats (sorted by `at`; ticks from boot).
    pub script: &'static [Beat],
    /// Crack-lab weathering: `Some` pre-ages every wall pier from this seed at
    /// boot AND enables the lab interaction (click a segment, drag the knob
    /// panel). `None` = untouched porcelain + no lab UI (every other demo).
    pub cracks: Option<crate::crack::CrackSeed>,
    /// Kept for reference after a pivot: disposable, not maintained.
    pub outdated: bool,
}

pub static DEMOS: &[Demo] = &[
    Demo {
        name: "gym",
        blurb: "the plain greybox gym in polana daylight",
        look: "polana",
        spawn: (10, 11),
        script: &[],
        cracks: None,
        outdated: false,
    },
    Demo {
        name: "dusk flood",
        blurb: "roof tears at dusk - warm light floods, GI settles",
        look: "dusk",
        spawn: (5, 5),
        script: &[Beat { at: 45, action: Action::TearRoof }],
        cracks: None,
        outdated: false,
    },
    Demo {
        name: "day to dusk",
        blurb: "the gym morphs from noon to golden dusk over ~3s",
        look: "polana",
        spawn: (10, 11),
        script: &[Beat { at: 20, action: Action::MorphTo { look: "dusk", over: 180 } }],
        cracks: None,
        outdated: false,
    },
    Demo {
        name: "wall smash",
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
        cracks: None,
        outdated: false,
    },
    Demo {
        name: "crack lab",
        blurb: "click a wall - knobs age it: cracks, depth, chips",
        look: "polana",
        // among the freestanding garden walls (the z=10 run + the x=12 spur),
        // a couple of cells off so the ROI reveal disc around the centred
        // player leaves the wall under study un-stippled
        spawn: (13, 12),
        script: &[],
        // boot pre-age with real variance: the level reads weathered the
        // moment it opens, and every segment starts somewhere different
        cracks: Some(crate::crack::CrackSeed { age: 0.55, cracks: 0.5, depth: 0.55, chip: 0.2, vary: 0.4 }),
        outdated: false,
    },
];

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
}

/// Drives a demo's tick timeline: fires scheduled beats and advances the
/// active look morph. Self-contained state machine with NO renderer/viewer
/// coupling — it consumes the sim tick + the current look and emits a
/// [`DemoStep`] the loop maps onto generic knobs (tear, exposure, env, …).
pub struct DemoRunner {
    script: &'static [Beat],
    cursor: usize,
    morph: Option<LookMorph>,
}

impl DemoRunner {
    pub fn new(script: &'static [Beat]) -> DemoRunner {
        DemoRunner { script, cursor: 0, morph: None }
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
            }
            self.cursor += 1;
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
        DemoStep { tear, smash, lit }
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

    /// Demos without a smash beat report no breach point — the viewer must
    /// not author brick runs (or stand down PHYS=1) for them.
    #[test]
    fn non_smash_demos_have_no_breach_point() {
        for d in DEMOS.iter().filter(|d| d.name != "wall smash") {
            assert_eq!(d.smash_point(), None, "{}", d.name);
        }
    }
}
