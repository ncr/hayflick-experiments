//! Scenario lab — the headless experimentation substrate for discovering an
//! emergent survival-game loop (ARCHITECTURE.md area C, experiment layer).
//!
//! A `Scenario` is a level + a way to drive the player + a tick budget. Run it
//! with [`run_scenario`] and you get back a reproducible [`ScenarioReport`]: the
//! full tick-stamped `GameEvent` timeline plus a cheap [`Metrics`] "did anything
//! interesting happen?" summary, alongside the replay oracle (`final_hash`).
//!
//! The whole point is to reuse the game's EXISTING event stream rather than bolt
//! on parallel instrumentation: we tap `Res::event_tap` (observation-only — see
//! `game::HouseGame::audio_system`), so the timeline is exactly the events the
//! audio system already emits, and recording is provably side-effect-free
//! (`tests::recording_is_side_effect_free` pins state_hash with vs without the
//! tap). No GPU, no window, no clock — `cargo test -p house-game` runs it in ms.

use crate::game::{Command, GameEvent, HouseGame};
use crate::spec::{DoorId, LevelSpec, TargetId};
use sim_core::{NullSink, Simulation, Tick};

/// How the scenario drives the player. One variant TODAY — a recorded command
/// trace — but expressed as an enum so heuristic policies (wander, seek, flee)
/// can be added later without reshaping `Scenario` or `run_scenario`. (No
/// speculative generality: the heuristics are not built yet, only the seam.)
pub enum Policy {
    /// Tick-stamped commands, delivered exactly as `Runner` would (a command
    /// stamped at tick `t` is applied on the tick `t` step, late ones never
    /// dropped). Same semantics as the headless trace player.
    Trace(Vec<(Tick, Command)>),
}

/// A self-contained, reproducible experiment: a level, a driving policy, and a
/// fixed tick budget. `seed`, when `Some`, overrides `level.seed` so the same
/// level geometry can be re-rolled under different RNG without editing the spec.
pub struct Scenario {
    pub level: LevelSpec,
    pub policy: Policy,
    pub ticks: u64,
    pub seed: Option<u64>,
}

impl Scenario {
    /// An empty-policy scenario: just run the level forward `ticks` steps. Add
    /// commands with [`Scenario::with_trace`].
    pub fn new(level: LevelSpec, ticks: u64) -> Scenario {
        Scenario { level, policy: Policy::Trace(Vec::new()), ticks, seed: None }
    }

    /// Drive the player with a recorded command trace (the only policy today).
    pub fn with_trace(mut self, trace: Vec<(Tick, Command)>) -> Scenario {
        self.policy = Policy::Trace(trace);
        self
    }

    /// Override the level's RNG seed for this run (leaves geometry untouched).
    pub fn with_seed(mut self, seed: u64) -> Scenario {
        self.seed = Some(seed);
        self
    }
}

/// The outcome of one scenario run. `timeline` is the load-bearing artifact —
/// every emitted `GameEvent` paired with the tick it fired on, in emission
/// order; `final_hash` is the replay oracle (identical input → identical hash),
/// and `metrics` is a derived summary for quick "interesting?" triage.
pub struct ScenarioReport {
    pub timeline: Vec<(Tick, GameEvent)>,
    pub final_hash: u64,
    pub final_score: u32,
    pub ticks_run: u64,
    pub metrics: Metrics,
}

/// Cheap timeline-derived summary. Deliberately a *fold over the timeline*, not
/// a parallel instrumentation path: new survival events (added to `GameEvent`
/// later) need only a new arm in [`Metrics::from_timeline`] / a new field here,
/// never a new emit site. This is a seed, not a framework.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Metrics {
    pub total_events: u32,
    pub doors_opened: u32,
    pub doors_closed: u32,
    pub shots_fired: u32,
    pub targets_hit: u32,
    pub switches: u32,
}

impl Metrics {
    /// Count-by-variant fold over the (already tick-ordered) timeline.
    pub fn from_timeline(timeline: &[(Tick, GameEvent)]) -> Metrics {
        let mut m = Metrics::default();
        for (_, ev) in timeline {
            m.total_events += 1;
            match ev {
                GameEvent::DoorOpened(..) => m.doors_opened += 1,
                GameEvent::DoorClosed(..) => m.doors_closed += 1,
                GameEvent::ShotFired(..) => m.shots_fired += 1,
                GameEvent::TargetHit(..) => m.targets_hit += 1,
                GameEvent::Switch => m.switches += 1,
            }
        }
        m
    }
}

/// First tick on which an event satisfying `pred` fired, if any — a small
/// lookup so experiments can ask "when did the player first open a door?"
/// without re-walking the timeline by hand. (Variant-agnostic on purpose:
/// `GameEvent` carries payloads, so a closure beats a discriminant enum here.)
pub fn first_tick_of(timeline: &[(Tick, GameEvent)], pred: impl Fn(&GameEvent) -> bool) -> Option<Tick> {
    timeline.iter().find(|(_, ev)| pred(ev)).map(|(t, _)| *t)
}

// Convenience predicates for the common survival/loop questions. They read at
// the call site as `first_tick_of(&tl, is_target_hit)`.
pub fn is_door_opened(ev: &GameEvent) -> bool {
    matches!(ev, GameEvent::DoorOpened(..))
}
pub fn is_target_hit(ev: &GameEvent) -> bool {
    matches!(ev, GameEvent::TargetHit(..))
}
pub fn is_shot_fired(ev: &GameEvent) -> bool {
    matches!(ev, GameEvent::ShotFired(..))
}

// Payload accessors — the timeline keeps the structured event, so experiments
// can pull the DoorId / TargetId out without re-deriving it from positions.
pub fn door_of(ev: &GameEvent) -> Option<DoorId> {
    match ev {
        GameEvent::DoorOpened(id, _) | GameEvent::DoorClosed(id, _) => Some(*id),
        _ => None,
    }
}
pub fn target_of(ev: &GameEvent) -> Option<TargetId> {
    match ev {
        GameEvent::TargetHit(id, _) => Some(*id),
        _ => None,
    }
}

/// Build the game from the scenario, feed its policy, run the fixed tick budget
/// while recording the event timeline, and return the report. Deterministic:
/// the same `Scenario` always yields the same timeline and `final_hash`.
///
/// The driving loop mirrors `sim_core::Runner` (per-tick command drain, never
/// per-batch — live play and replay must agree) but interleaves a per-tick
/// drain of `Res::event_tap` so each event is paired with the tick it fired on.
pub fn run_scenario(scenario: &Scenario) -> ScenarioReport {
    let mut spec = scenario.level.clone();
    if let Some(seed) = scenario.seed {
        spec.seed = seed;
    }

    let mut game = HouseGame::new(&spec, NullSink);
    game.res.event_tap = Some(Vec::new()); // arm the observation tap

    // Tick-stamped command queue, drained per tick (Runner semantics, inlined
    // so we can read the tap right after each tick step).
    let Policy::Trace(trace) = &scenario.policy;
    let mut queue = trace.clone();
    queue.sort_by_key(|(t, _)| *t); // stable: same-tick push order preserved

    let mut timeline: Vec<(Tick, GameEvent)> = Vec::new();
    for i in 0..scenario.ticks {
        let t = Tick(i);
        // every command stamped at or before `t` that has not yet fired
        let due: Vec<Command> = queue.iter().filter(|(st, _)| st.0 <= i).map(|(_, c)| c.clone()).collect();
        queue.retain(|(st, _)| st.0 > i);
        game.tick(t, &due);
        // drain this tick's tapped events into the timeline, stamped with `t`
        if let Some(tap) = game.res.event_tap.as_mut() {
            for ev in tap.drain(..) {
                timeline.push((t, ev));
            }
        }
    }

    let final_hash = game.state_hash();
    let final_score = game.snapshot().score;
    let metrics = Metrics::from_timeline(&timeline);
    ScenarioReport { timeline, final_hash, final_score, ticks_run: scenario.ticks, metrics }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spec::game_level;
    use crate::trace::parse_trace;
    use sim_core::Runner;

    fn replay_game_scenario() -> Scenario {
        let trace = parse_trace(include_str!("../traces/replay_game.txt")).unwrap();
        Scenario::new(game_level(), 420).with_trace(trace)
    }

    /// The checked-in game trace, run through the lab: the timeline must carry
    /// the door-open and the two target hits at the expected ticks, and the
    /// final score must be 2 (matches replay_game_golden in game.rs).
    #[test]
    fn timeline_matches_known_trace() {
        let report = run_scenario(&replay_game_scenario());
        assert_eq!(report.final_score, 2, "both spaced shots land on target 4");
        assert_eq!(report.ticks_run, 420);

        // door_ce (DoorId(2)) opens once: clicked at tick 2, anim_ticks=24, so
        // it lands ~tick 26. Assert presence + DoorId, near the known tick.
        let open = report.timeline.iter().find(|(_, ev)| is_door_opened(ev)).expect("door must open");
        assert_eq!(door_of(&open.1), Some(DoorId(2)), "door_ce is the one opened");
        assert!((open.0.0 as i64 - 26).abs() <= 2, "door opens ~tick 26, got {:?}", open.0);

        // exactly two TargetHit on target 4, fired at ticks 280 and 300.
        let hits: Vec<_> = report.timeline.iter().filter(|(_, ev)| is_target_hit(ev)).collect();
        assert_eq!(hits.len(), 2, "two hits");
        assert!(hits.iter().all(|(_, ev)| target_of(ev) == Some(TargetId(4))), "both on target 4");
        assert_eq!(hits[0].0, Tick(280));
        assert_eq!(hits[1].0, Tick(300));

        // first shot/hit lookup via the helper
        assert_eq!(first_tick_of(&report.timeline, is_target_hit), Some(Tick(280)));
    }

    /// Recording must not perturb the sim: a lab run (tap armed) and a plain
    /// Runner over the SAME scenario must produce the identical state_hash.
    #[test]
    fn recording_is_side_effect_free() {
        let scenario = replay_game_scenario();
        let recorded = run_scenario(&scenario);

        // plain Runner over the same level + trace, NO event tap.
        let Policy::Trace(trace) = &scenario.policy;
        let mut r = Runner::new(HouseGame::new(&scenario.level, NullSink));
        r.feed(trace.clone());
        let plain_hash = r.run_ticks(scenario.ticks);

        assert_eq!(recorded.final_hash, plain_hash, "tapping events must not change state");
        // and it matches the pinned game golden (so we know plain_hash is right)
        assert_eq!(recorded.final_hash, 0xf3783d2d43fe4009, "got {:#018x}", recorded.final_hash);
    }

    /// Same scenario twice → identical timeline AND identical final_hash.
    #[test]
    fn scenario_is_deterministic() {
        let a = run_scenario(&replay_game_scenario());
        let b = run_scenario(&replay_game_scenario());
        assert_eq!(a.timeline, b.timeline, "timelines must match exactly");
        assert_eq!(a.final_hash, b.final_hash);
        assert_eq!(a.metrics, b.metrics);
    }

    /// Metrics are a faithful count-by-variant fold of the known trace.
    #[test]
    fn metrics_count_events() {
        let m = run_scenario(&replay_game_scenario()).metrics;
        assert_eq!(m.doors_opened, 1, "door_ce opens once");
        assert_eq!(m.targets_hit, 2, "two hits on target 4");
        assert_eq!(m.shots_fired, 2, "two shots fired (both land, none swallowed)");
        assert_eq!(m.switches, 2, "flashlight on (tick 0) + room lights off (tick 360)");
        assert_eq!(m.doors_closed, 0);
        assert_eq!(m.total_events, m.doors_opened + m.doors_closed + m.shots_fired + m.targets_hit + m.switches);
    }

    /// `seed` override changes RNG without touching geometry. (The house game's
    /// RNG only shows up in the state_hash probe today, but the seam must work.)
    #[test]
    fn seed_override_applies() {
        let base = run_scenario(&Scenario::new(game_level(), 10));
        let reseeded = run_scenario(&Scenario::new(game_level(), 10).with_seed(99));
        // same geometry + empty trace, only the seed differs → hashes differ
        // because the hash folds an RNG probe.
        assert_ne!(base.final_hash, reseeded.final_hash, "seed must reach the RNG");
    }
}
