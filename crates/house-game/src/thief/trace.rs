//! The thief text-trace format: `<tick> <op> <args>`, one command per line.
//!
//! The headless replay input (viewer DEMO/CMDS path, clip bins, tests) and
//! the journaling output — `parse_trace ∘ format_command` round-trips. Same
//! plain-text discipline as the goo game's `crate::trace`, separate grammar.
//!
//! ```text
//! 10 move 1 0 walk      # dx dz [sneak|walk|run] (default walk)
//! 90 steal
//! 120 drop
//! 200 outfit brown bare # <top hue> <headwear>
//! 300 stop bluff        # bluff|bribe|submit|flee
//! 400 wait
//! ```

use super::perception::{Headwear, Hue};
use super::sim::{Command, MoveMode, StopChoice};
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
        let tick: u64 = w
            .next()
            .ok_or_else(|| err("missing tick"))?
            .parse()
            .map_err(|_| err("bad tick"))?;
        let op = w.next().ok_or_else(|| err("missing op"))?;
        let cmd = match op {
            "move" => {
                let dx: i16 = w
                    .next()
                    .ok_or_else(|| err("move: missing dx"))?
                    .parse()
                    .map_err(|_| err("move: bad dx"))?;
                let dz: i16 = w
                    .next()
                    .ok_or_else(|| err("move: missing dz"))?
                    .parse()
                    .map_err(|_| err("move: bad dz"))?;
                let mode = match w.next() {
                    None | Some("walk") => MoveMode::Walk,
                    Some("sneak") => MoveMode::Sneak,
                    Some("run") => MoveMode::Run,
                    Some(m) => return Err(err(&format!("move: unknown mode {m:?}"))),
                };
                Command::Move { dx, dz, mode }
            }
            "steal" => Command::Steal,
            "drop" => Command::Drop,
            "outfit" => {
                let top = parse_hue(w.next().ok_or_else(|| err("outfit: missing hue"))?)
                    .ok_or_else(|| err("outfit: unknown hue"))?;
                let headwear =
                    parse_headwear(w.next().ok_or_else(|| err("outfit: missing headwear"))?)
                        .ok_or_else(|| err("outfit: unknown headwear"))?;
                Command::Outfit { top, headwear }
            }
            "stop" => {
                let choice = match w.next().ok_or_else(|| err("stop: missing choice"))? {
                    "bluff" => StopChoice::Bluff,
                    "bribe" => StopChoice::Bribe,
                    "submit" => StopChoice::Submit,
                    "flee" => StopChoice::Flee,
                    c => return Err(err(&format!("stop: unknown choice {c:?}"))),
                };
                Command::Stop(choice)
            }
            "wait" => Command::Wait,
            _ => return Err(err(&format!("unknown op {op:?}"))),
        };
        out.push((Tick(tick), cmd));
    }
    Ok(out)
}

/// One trace line body (no tick prefix) for a command — journaling half of
/// the round-trip.
pub fn format_command(c: &Command) -> String {
    match *c {
        Command::Move { dx, dz, mode } => {
            let m = match mode {
                MoveMode::Sneak => "sneak",
                MoveMode::Walk => "walk",
                MoveMode::Run => "run",
            };
            format!("move {dx} {dz} {m}")
        }
        Command::Steal => "steal".into(),
        Command::Drop => "drop".into(),
        Command::Outfit { top, headwear } => {
            format!("outfit {} {}", hue_str(top), headwear_str(headwear))
        }
        Command::Stop(choice) => format!(
            "stop {}",
            match choice {
                StopChoice::Bluff => "bluff",
                StopChoice::Bribe => "bribe",
                StopChoice::Submit => "submit",
                StopChoice::Flee => "flee",
            }
        ),
        Command::Wait => "wait".into(),
    }
}

fn parse_hue(s: &str) -> Option<Hue> {
    Some(match s {
        "drab" => Hue::Drab,
        "brown" => Hue::Brown,
        "green" => Hue::Green,
        "blue" => Hue::Blue,
        "red" => Hue::Red,
        "black" => Hue::Black,
        "white" => Hue::White,
        _ => return None,
    })
}

fn hue_str(h: Hue) -> &'static str {
    match h {
        Hue::Drab => "drab",
        Hue::Brown => "brown",
        Hue::Green => "green",
        Hue::Blue => "blue",
        Hue::Red => "red",
        Hue::Black => "black",
        Hue::White => "white",
    }
}

fn parse_headwear(s: &str) -> Option<Headwear> {
    Some(match s {
        "bare" => Headwear::Bare,
        "hood" => Headwear::Hood,
        "hat" => Headwear::Hat,
        "helmet" => Headwear::Helmet,
        _ => return None,
    })
}

fn headwear_str(h: Headwear) -> &'static str {
    match h {
        Headwear::Bare => "bare",
        Headwear::Hood => "hood",
        Headwear::Hat => "hat",
        Headwear::Helmet => "helmet",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_command_round_trips() {
        let cmds = [
            Command::Move {
                dx: -1,
                dz: 0,
                mode: MoveMode::Sneak,
            },
            Command::Move {
                dx: 0,
                dz: 1,
                mode: MoveMode::Walk,
            },
            Command::Move {
                dx: 1,
                dz: 0,
                mode: MoveMode::Run,
            },
            Command::Steal,
            Command::Drop,
            Command::Outfit {
                top: Hue::Brown,
                headwear: Headwear::Bare,
            },
            Command::Stop(StopChoice::Bluff),
            Command::Stop(StopChoice::Bribe),
            Command::Stop(StopChoice::Submit),
            Command::Stop(StopChoice::Flee),
            Command::Wait,
        ];
        let text: String = cmds
            .iter()
            .enumerate()
            .map(|(i, c)| format!("{} {}\n", i * 10, format_command(c)))
            .collect();
        let parsed = parse_trace(&text).unwrap();
        assert_eq!(parsed.len(), cmds.len());
        for (i, (t, c)) in parsed.iter().enumerate() {
            assert_eq!(t.0, (i * 10) as u64);
            assert_eq!(c, &cmds[i]);
        }
    }

    #[test]
    fn comments_defaults_and_errors() {
        let ok = parse_trace("# header\n\n5 move 1 0 # east\n8 wait\n").unwrap();
        assert_eq!(
            ok[0].1,
            Command::Move {
                dx: 1,
                dz: 0,
                mode: MoveMode::Walk
            }
        );
        assert!(parse_trace("5 move 1").is_err());
        assert!(parse_trace("5 dance").is_err());
        assert!(parse_trace("x wait").is_err());
        assert!(parse_trace("5 stop politely").is_err());
        assert!(parse_trace("5 outfit plaid hood").is_err());
    }
}
