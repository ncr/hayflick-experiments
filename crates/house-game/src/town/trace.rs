//! The town text-trace format: `<tick> <op> <args>`, one command per line.
//!
//! The headless replay input (viewer DEMO/CMDS path, tests) and the
//! journaling output — `parse_trace ∘ format_command` round-trips.
//!
//! ```text
//! 10 move 1 0 walk      # dx dz [sneak|walk|run] (default walk)
//! 400 wait
//! ```

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
                let dx: i16 = w.next().ok_or_else(|| err("move: missing dx"))?.parse().map_err(|_| err("move: bad dx"))?;
                let dz: i16 = w.next().ok_or_else(|| err("move: missing dz"))?.parse().map_err(|_| err("move: bad dz"))?;
                let mode = match w.next() {
                    None | Some("walk") => MoveMode::Walk,
                    Some("sneak") => MoveMode::Sneak,
                    Some("run") => MoveMode::Run,
                    Some(m) => return Err(err(&format!("move: unknown mode {m:?}"))),
                };
                Command::Move { dx, dz, mode }
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
        Command::Move { dx, dz, mode } => {
            let m = match mode {
                MoveMode::Sneak => "sneak",
                MoveMode::Walk => "walk",
                MoveMode::Run => "run",
            };
            format!("{} move {} {} {}", tick.0, dx, dz, m)
        }
        Command::Wait => format!("{} wait", tick.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_and_format_round_trip() {
        let src = "10 move 1 0 walk\n18 move 0 -1 sneak\n30 move -1 0 run\n40 move 0 1\n99 wait\n";
        let trace = parse_trace(src).unwrap();
        assert_eq!(trace.len(), 5);
        let back: Vec<String> = trace.iter().map(|(t, c)| format_command(*t, c)).collect();
        let reparsed = parse_trace(&back.join("\n")).unwrap();
        assert_eq!(trace, reparsed);
    }

    #[test]
    fn comments_and_blanks_are_skipped_and_errors_name_the_line() {
        let trace = parse_trace("# header\n\n5 move 1 0 # inline\n").unwrap();
        assert_eq!(trace.len(), 1);
        assert!(parse_trace("5 fly").unwrap_err().contains("line 1"));
        assert!(parse_trace("5 move 1").unwrap_err().contains("missing dz"));
    }
}
