//! Headless trace player: the whole game with no window, no GPU, no clock.
//!
//!     headless <trace.txt> <ticks> [level]      level = fixture (default) | game
//!
//! Runs the chosen level for `<ticks>` fixed ticks with a NullSink, feeding the
//! tick-stamped commands from the trace file, then prints the state digest (the
//! replay oracle) and a snapshot summary.

use house_game::{fixture, game_level, parse_trace, HouseGame};
use sim_core::{NullSink, Runner, Simulation};

fn main() {
    let mut args = std::env::args().skip(1);
    let (Some(path), Some(ticks)) = (args.next(), args.next()) else {
        eprintln!("usage: headless <trace.txt> <ticks> [fixture|game]");
        std::process::exit(2);
    };
    let ticks: u64 = ticks.parse().expect("ticks must be an integer");
    let level = args.next().unwrap_or_else(|| "fixture".into());
    let spec = match level.as_str() {
        "fixture" => fixture(),
        "game" => game_level(),
        other => {
            eprintln!("unknown level {other:?} (fixture | game)");
            std::process::exit(2);
        }
    };
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    let trace = parse_trace(&text).unwrap_or_else(|e| panic!("{e}"));
    println!("trace: {} commands, {} ticks, level {level}", trace.len(), ticks);

    let mut runner = Runner::new(HouseGame::new(&spec, NullSink));
    runner.feed(trace);
    let hash = runner.run_ticks(ticks);
    let snap = runner.sim.snapshot();

    println!("state_hash: {hash:016x}");
    println!("player: pos ({:.3}, {:.3}, {:.3})  facing ({:.3}, {:.3})  flashlight {}  muzzle {}", snap.player_pos.x, snap.player_pos.y, snap.player_pos.z, snap.facing.x, snap.facing.y, snap.flashlight, snap.muzzle_flash);
    for (id, angle) in &snap.doors {
        println!("door {:?}: {:.1} deg", id, angle.to_degrees());
    }
    for (id, rgb) in &snap.lights {
        println!("light {:?}: [{:.3}, {:.3}, {:.3}]", id, rgb[0], rgb[1], rgb[2]);
    }
    println!("room_lights: {:.3}  yaw_q: {}  score: {}", snap.room_lights, snap.yaw_q, snap.score);
}
