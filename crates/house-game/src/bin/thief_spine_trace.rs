//! thief_spine_trace — print the scripted spine trace (sim.rs::spine_trace)
//! in the thief text-trace grammar, for the viewer's DEMO/CMDS harness:
//!
//!   cargo run -p house-game --bin thief_spine_trace [outfit] > /tmp/spine.txt
//!   SCENE=thief DEMO=/tmp/spine.txt DEMO_TICKS=3000 DEMO_DIR=/tmp/d viewer

use house_game::thief::sim::spine_trace;
use house_game::thief::trace::format_command;

fn main() {
    let outfit = std::env::args().any(|a| a == "outfit");
    println!("# thief spine trace (outfit={outfit}) — grammar: thief/trace.rs");
    for (t, c) in spine_trace(outfit) {
        println!("{} {}", t.0, format_command(&c));
    }
}
