//! Scenario lab CLI: a richer sibling of `headless` that prints the EVENT
//! TIMELINE, not just the end-state digest. The experimentation substrate for
//! discovering an emergent loop — define a trace, run it headless, read back a
//! reproducible event timeline + metrics.
//!
//!     lab <trace.txt> <ticks> [level]      level = fixture (default) | game
//!
//! Builds a Scenario (chosen level + the tick-stamped trace + tick budget),
//! runs it with a NullSink while recording every `GameEvent`, then prints the
//! tick-stamped timeline, the metrics summary, and the final hash/score.

use house_game::{fixture, game_level, parse_trace, run_scenario, survival_level, Scenario};

fn main() {
    let mut args = std::env::args().skip(1);
    let (Some(path), Some(ticks)) = (args.next(), args.next()) else {
        eprintln!("usage: lab <trace.txt> <ticks> [fixture|game|survival]");
        std::process::exit(2);
    };
    let ticks: u64 = ticks.parse().expect("ticks must be an integer");
    let level = args.next().unwrap_or_else(|| "fixture".into());
    let spec = match level.as_str() {
        "fixture" => fixture(),
        "game" => game_level(),
        "survival" => survival_level(),
        other => {
            eprintln!("unknown level {other:?} (fixture | game | survival)");
            std::process::exit(2);
        }
    };
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    let trace = parse_trace(&text).unwrap_or_else(|e| panic!("{e}"));
    println!("scenario: {} commands, {ticks} ticks, level {level}", trace.len());

    let scenario = Scenario::new(spec, ticks).with_trace(trace);
    let report = run_scenario(&scenario);

    println!("\n--- event timeline ({} events) ---", report.timeline.len());
    for (t, ev) in &report.timeline {
        println!("  t{:>5}  {ev:?}", t.0);
    }

    let m = report.metrics;
    println!("\n--- metrics ---");
    println!("  total_events {}  doors_opened {}  doors_closed {}", m.total_events, m.doors_opened, m.doors_closed);
    println!("  shots_fired {}  targets_hit {}  switches {}", m.shots_fired, m.targets_hit, m.switches);

    println!("\nfinal_hash: {:016x}  final_score: {}  ticks_run: {}", report.final_hash, report.final_score, report.ticks_run);
}
