//! The gym text-trace format: `<tick> <op> <args>`, one command per line.
//!
//! The headless replay input (viewer DEMO/CMDS path, tests) and the
//! journaling output — `parse_trace ∘ format_command` round-trips.
//!
//! ```text
//! 11 move_world 1024 0 walk # dx dz [walk|run] (default walk), fixed-point
//! 400 wait
//! ```
//!
//! `move <dx> <dz>` — one cell step on a tick cadence — was the other half of
//! this format until 2026-08-09. It went with the mover that executed it; a
//! trace holding one now fails to parse rather than replaying as something
//! else, and the error names its replacement.

use super::sim::{Command, MoveMode};
use sim_core::Tick;

pub fn parse_trace(src: &str) -> Result<Vec<(Tick, Command)>, String> {
    let mut out = Vec::new();
    for (ln, line) in src.lines().enumerate() {
        let line = line.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let mut w = line.split_whitespace();
        let err = |m: &str| format!("trace line {}: {} ({:?})", ln + 1, m, line);
        let tick: u64 = w.next().ok_or_else(|| err("missing tick"))?.parse().map_err(|_| err("bad tick"))?;
        let op = w.next().ok_or_else(|| err("missing op"))?;
        let cmd = match op {
            "move" => {
                return Err(err("move: the cell-step mover is gone — use move_world <dx> <dz> at WORLD_INPUT_SCALE"));
            }
            "move_world" => {
                let dx: i16 = w.next().ok_or_else(|| err("move_world: missing dx"))?.parse().map_err(|_| err("move_world: bad dx"))?;
                let dz: i16 = w.next().ok_or_else(|| err("move_world: missing dz"))?.parse().map_err(|_| err("move_world: bad dz"))?;
                let mode = match w.next() {
                    None | Some("walk") => MoveMode::Walk,
                    Some("run") => MoveMode::Run,
                    Some(m) => return Err(err(&format!("move_world: unknown mode {m:?}"))),
                };
                Command::MoveWorld { dx, dz, mode }
            }
            "wait" => Command::Wait,
            _ => return Err(err(&format!("unknown op {op:?}"))),
        };
        out.push((Tick(tick), cmd));
    }
    Ok(out)
}

/// The exact inverse of `parse_trace` — journaled live commands replay
/// losslessly.
pub fn format_command(tick: Tick, c: &Command) -> String {
    match c {
        Command::MoveWorld { dx, dz, mode } => {
            let m = match mode {
                MoveMode::Walk => "walk",
                MoveMode::Run => "run",
            };
            format!("{} move_world {} {} {}", tick.0, dx, dz, m)
        }
        Command::Wait => format!("{} wait", tick.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_and_format_round_trip() {
        let src = "10 move_world 1024 0 walk\n30 move_world -1024 0 run\n40 move_world 0 1024\n50 move_world 512 -1024 run\n99 wait\n";
        let trace = parse_trace(src).unwrap();
        assert_eq!(trace.len(), 5);
        let back: Vec<String> = trace.iter().map(|(t, c)| format_command(*t, c)).collect();
        let reparsed = parse_trace(&back.join("\n")).unwrap();
        assert_eq!(trace, reparsed);
    }

    #[test]
    fn comments_and_blanks_are_skipped_and_errors_name_the_line() {
        let trace = parse_trace("# header\n\n5 move_world 1024 0 # inline\n").unwrap();
        assert_eq!(trace.len(), 1);
        assert!(parse_trace("5 fly").unwrap_err().contains("line 1"));
        assert!(parse_trace("5 move_world 1").unwrap_err().contains("missing dz"));
        assert!(parse_trace("5 move_world 1 0 sneak").unwrap_err().contains("unknown mode"));
    }

    /// A trace written for the cell-step mover must FAIL rather than replay as
    /// something else, and say what to write instead.
    #[test]
    fn a_cell_step_trace_is_rejected_by_name() {
        let e = parse_trace("10 move 1 0 walk\n").unwrap_err();
        assert!(e.contains("move_world"), "the error must name the replacement: {e}");
    }
}
