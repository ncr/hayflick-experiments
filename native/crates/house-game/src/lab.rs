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

use crate::game::{Command, GameEvent, HouseGame, NeedKind};
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
    // Final-snapshot need readouts (1.0 when survival is off — the snapshot
    // reports full needs for a survival-disabled level). `min_*` is the lowest
    // value observed across the run (sampled each tick after the sim step).
    pub final_hunger: f32,
    pub final_battery: f32,
    pub min_hunger: f32,
    pub min_battery: f32,
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
    // ---- survival counts (all zero when survival is off — no such events fire)
    pub items_collected: u32,
    pub consumes: u32,
    /// Ticks spent with hunger below `critical` — derived from the timeline's
    /// NeedCritical/NeedRecovered edge events for NeedKind::Hunger (the span
    /// between a critical edge and the next recovered edge, or the run end).
    pub ticks_hunger_critical: u32,
    /// Same for battery.
    pub ticks_battery_critical: u32,
}

impl Metrics {
    /// Count-by-variant fold over the (already tick-ordered) timeline.
    /// `ticks_run` closes any still-open critical span at the run's end.
    pub fn from_timeline(timeline: &[(Tick, GameEvent)], ticks_run: u64) -> Metrics {
        let mut m = Metrics::default();
        // open critical-span start tick per need ([hunger, battery]); None = not
        // currently critical. NeedCritical opens a span, NeedRecovered closes it.
        let mut crit_since: [Option<u64>; 2] = [None, None];
        let idx = |n: NeedKind| match n {
            NeedKind::Hunger => 0,
            NeedKind::Battery => 1,
        };
        for (t, ev) in timeline {
            m.total_events += 1;
            match ev {
                GameEvent::DoorOpened(..) => m.doors_opened += 1,
                GameEvent::DoorClosed(..) => m.doors_closed += 1,
                GameEvent::ShotFired(..) => m.shots_fired += 1,
                GameEvent::TargetHit(..) => m.targets_hit += 1,
                GameEvent::Switch => m.switches += 1,
                GameEvent::PickedUp(..) => m.items_collected += 1,
                GameEvent::Consumed(..) => m.consumes += 1,
                GameEvent::NeedCritical(n) => crit_since[idx(*n)] = Some(t.0),
                GameEvent::NeedRecovered(n) => {
                    let i = idx(*n);
                    if let Some(start) = crit_since[i].take() {
                        let span = (t.0 - start) as u32;
                        if i == 0 {
                            m.ticks_hunger_critical += span;
                        } else {
                            m.ticks_battery_critical += span;
                        }
                    }
                }
                // goo-mob events are not part of the survival-lab metrics
                GameEvent::MobHit(..) | GameEvent::MobSplit(..) | GameEvent::MobKilled(..) | GameEvent::MobMerged(..) => {}
            }
        }
        // close still-open spans at the run end
        for (i, start) in crit_since.into_iter().enumerate() {
            if let Some(start) = start {
                let span = ticks_run.saturating_sub(start) as u32;
                if i == 0 {
                    m.ticks_hunger_critical += span;
                } else {
                    m.ticks_battery_critical += span;
                }
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
    // running minima of the two needs (1.0 = never sampled / survival off)
    let (mut min_hunger, mut min_battery) = (1.0f32, 1.0f32);
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
        // sample need minima (snapshot is a pure read; full needs when off)
        let s = game.snapshot();
        min_hunger = min_hunger.min(s.hunger);
        min_battery = min_battery.min(s.battery);
    }

    let final_hash = game.state_hash();
    let snap = game.snapshot();
    let final_score = snap.score;
    let metrics = Metrics::from_timeline(&timeline, scenario.ticks);
    ScenarioReport { timeline, final_hash, final_score, ticks_run: scenario.ticks, metrics, final_hunger: snap.hunger, final_battery: snap.battery, min_hunger, min_battery }
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

    /// Survival in the lab: drive the sandbox level, grab an item, consume it.
    /// The metrics fold counts the survival events and the report carries the
    /// final/min need readouts. Survival-OFF levels report full needs (1.0).
    #[test]
    fn survival_metrics_and_need_readouts() {
        use crate::game::{Command, NeedKind, PickRay};
        use crate::spec::{game_level, survival_level, ItemKind};
        use glam::{Vec2, Vec3};

        // click-to-walk command onto ground (gx, gz) (straight-down pick ray)
        let click = |x: f32, z: f32| Command::Click { ray: PickRay { origin: Vec3::new(x, 5.0, z), dir: Vec3::new(0.0, -1.0, 0.0) }, ground: Some(Vec2::new(x, z)) };

        // survival-OFF baseline: needs read full, no survival events.
        let off = run_scenario(&Scenario::new(game_level(), 10));
        assert_eq!(off.final_hunger, 1.0);
        assert_eq!(off.final_battery, 1.0);
        assert_eq!(off.min_hunger, 1.0);
        assert_eq!(off.metrics.items_collected, 0);

        // survival ON: walk onto the room-E battery (id 5 @ 11,0,5), consume it.
        let trace = vec![
            (Tick(0), click(11.0, 5.0)),
            (Tick(200), Command::Use { kind: ItemKind::Battery }),
        ];
        let rep = run_scenario(&Scenario::new(survival_level(), 260).with_trace(trace));
        assert!(rep.metrics.items_collected >= 1, "picked up at least the battery");
        assert_eq!(rep.metrics.consumes, 1, "consumed once");
        assert!(rep.final_hunger < 1.0, "hunger decayed over 260 ticks");
        assert!(rep.min_hunger <= rep.final_hunger, "min <= final");
        // determinism of the derived fold
        let rep2 = run_scenario(&Scenario::new(survival_level(), 260).with_trace(vec![]));
        assert_eq!(rep2.metrics.consumes, 0);
        // critical-span counting: NeedCritical/Recovered drive the tick counts;
        // hunger barely moves in 260 ticks (decay 1/3600) so it stays well above
        // critical → zero critical ticks here (the seam is exercised, not the span).
        assert_eq!(rep.metrics.ticks_hunger_critical, 0);
        let _ = NeedKind::Battery; // keep the import meaningful if asserts change
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
