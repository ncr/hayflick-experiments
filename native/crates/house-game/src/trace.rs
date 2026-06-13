//! Plain-text command traces — the replay format for the headless bin and the
//! checked-in replay_golden test. One command per line, `#` comments and blank
//! lines ignored:
//!
//! ```text
//! <tick> click  ox oy oz dx dy dz gx gz   # Click with ground (gx, gz)
//! <tick> clickn ox oy oz dx dy dz         # Click, ground = None
//! <tick> shoot  ox oy oz dx dy dz
//! <tick> move   x y                       # x = right − left, y = up − down
//! <tick> flash                            # ToggleFlashlight
//! <tick> lights                           # ToggleRoomLights
//! <tick> rotate dq
//! <tick> use    food | battery             # Command::Use (consume a carried item)
//! ```
//!
//! Ray directions are normalised on parse, so traces can be written with
//! whole-number aim vectors.

use crate::game::{Command, PickRay};
use crate::spec::ItemKind;
use glam::{IVec2, Vec2, Vec3};
use sim_core::Tick;

pub fn parse_trace(text: &str) -> Result<Vec<(Tick, Command)>, String> {
    let mut out = Vec::new();
    for (ln, line) in text.lines().enumerate() {
        let line = line.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let err = |m: &str| format!("trace line {}: {} ({:?})", ln + 1, m, line);
        let mut it = line.split_whitespace();
        let tick = Tick(it.next().ok_or_else(|| err("missing tick"))?.parse::<u64>().map_err(|_| err("bad tick"))?);
        let op = it.next().ok_or_else(|| err("missing op"))?;
        // `use <food|battery>` takes a word arg, not floats — handle it before
        // the rest is parsed as a float list.
        if op == "use" {
            let kind = match it.next().ok_or_else(|| err("missing item kind"))? {
                "food" => ItemKind::Food,
                "battery" => ItemKind::Battery,
                other => return Err(err(&format!("unknown item kind {other:?}"))),
            };
            out.push((tick, Command::Use { kind }));
            continue;
        }
        let mut f = {
            let rest: Vec<f32> = it.map(|s| s.parse::<f32>().map_err(|_| err("bad number"))).collect::<Result<_, _>>()?;
            rest.into_iter()
        };
        let mut next = |n: &str| f.next().ok_or_else(|| format!("trace line {}: missing {}", ln + 1, n));
        let cmd = match op {
            "click" | "clickn" | "shoot" => {
                let origin = Vec3::new(next("ox")?, next("oy")?, next("oz")?);
                let dir = Vec3::new(next("dx")?, next("dy")?, next("dz")?).try_normalize().ok_or_else(|| err("zero ray dir"))?;
                let ray = PickRay { origin, dir };
                match op {
                    "shoot" => Command::Shoot { ray },
                    "click" => Command::Click { ray, ground: Some(Vec2::new(next("gx")?, next("gz")?)) },
                    _ => Command::Click { ray, ground: None },
                }
            }
            "move" => Command::Move { dir: IVec2::new(next("x")? as i32, next("y")? as i32) },
            "flash" => Command::ToggleFlashlight,
            "lights" => Command::ToggleRoomLights,
            "rotate" => Command::RotateCamera { dq: next("dq")? as i8 },
            _ => return Err(err("unknown op")),
        };
        out.push((tick, cmd));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_op_and_rejects_garbage() {
        let text = "\
# a comment
0 lights
2 click -1.625 5 0 0 -1 0 -1.625 0
3 clickn 0 5 0 0 -2 0   # dir normalised
4 shoot -2 1.25 0.5 2 0 -3
10 move 1 -1
11 flash
12 rotate -1
13 use food
14 use battery
";
        let t = parse_trace(text).unwrap();
        assert_eq!(t.len(), 9);
        assert_eq!(t[0], (Tick(0), Command::ToggleRoomLights));
        match &t[1].1 {
            Command::Click { ray, ground } => {
                assert_eq!(ray.dir, Vec3::new(0.0, -1.0, 0.0));
                assert_eq!(*ground, Some(Vec2::new(-1.625, 0.0)));
            }
            c => panic!("{c:?}"),
        }
        match &t[2].1 {
            Command::Click { ray, ground } => {
                assert_eq!(ray.dir, Vec3::new(0.0, -1.0, 0.0)); // normalised
                assert_eq!(*ground, None);
            }
            c => panic!("{c:?}"),
        }
        match &t[3].1 {
            Command::Shoot { ray } => assert!((ray.dir.length() - 1.0).abs() < 1e-6),
            c => panic!("{c:?}"),
        }
        assert_eq!(t[4], (Tick(10), Command::Move { dir: IVec2::new(1, -1) }));
        assert_eq!(t[5], (Tick(11), Command::ToggleFlashlight));
        assert_eq!(t[6], (Tick(12), Command::RotateCamera { dq: -1 }));
        assert_eq!(t[7], (Tick(13), Command::Use { kind: ItemKind::Food }));
        assert_eq!(t[8], (Tick(14), Command::Use { kind: ItemKind::Battery }));
        assert!(parse_trace("5 frobnicate").is_err());
        assert!(parse_trace("1 use gold").is_err()); // unknown item kind
        assert!(parse_trace("1 use").is_err()); // missing item kind
        assert!(parse_trace("x click 0 0 0 1 0 0 0 0").is_err());
        assert!(parse_trace("1 shoot 0 0 0").is_err()); // missing dir
        assert!(parse_trace("1 shoot 0 0 0 0 0 0").is_err()); // zero dir
    }
}
