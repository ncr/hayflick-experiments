//! Dev tool: run a scripted scenario headless and dump the skinned mesh per
//! tick for `tools/character/preview.py sheet` (contact sheets of the motion
//! without the renderer).
//!
//!     cargo run -p avatar --example dump -- <scenario> <out.bin>
//!
//! Scenarios: start-stop, turns, run, crouch, kerb, wall.
use avatar::body::drive;
use avatar::skin::{matrices, mesh, skin};
use avatar::Body;
use glam::{Vec2, Vec3};
use std::io::Write;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let scenario = args.get(1).map_or("start-stop", String::as_str);
    let out = args.get(2).map_or("frames.bin", String::as_str);
    let kerb = |p: Vec2| if p.x > 1.5 { 0.14 } else { 0.0 };
    let flat = |_: Vec2| 0.0;
    let ground: &dyn Fn(Vec2) -> f32 = if scenario == "kerb" { &kerb } else { &flat };
    let script: Box<dyn Fn(u32) -> (Vec2, bool)> = match scenario {
        "start-stop" => Box::new(|t| (if (30..150).contains(&t) { Vec2::X * 1.6 } else { Vec2::ZERO }, false)),
        "turns" => Box::new(|t| {
            let d = match t {
                0..30 => Vec2::ZERO,
                30..110 => Vec2::X,
                110..190 => Vec2::Y,
                190..270 => -Vec2::Y,
                _ => Vec2::ZERO,
            };
            (d * 1.6, false)
        }),
        "run" => Box::new(|t| (if (30..160).contains(&t) { Vec2::X * 4.2 } else { Vec2::ZERO }, false)),
        "crouch" => Box::new(|t| (if (80..220).contains(&t) { Vec2::X * 1.1 } else { Vec2::ZERO }, (20..300).contains(&t))),
        "kerb" => Box::new(|t| (if (20..160).contains(&t) { Vec2::X * 1.6 } else { Vec2::ZERO }, false)),
        "wall" => Box::new(|_| (Vec2::ZERO, false)),
        other => panic!("unknown scenario {other}"),
    };
    let ticks = 330;
    if scenario == "wall" {
        return wall(out, ticks);
    }
    let m = mesh();
    let mut pos = Vec2::ZERO;
    let mut vel = Vec2::ZERO;
    let mut body = Body::new(pos, ground);
    let mut f = std::fs::File::create(out).unwrap();
    f.write_all(&ticks.to_le_bytes()).unwrap();
    f.write_all(&(m.vertices.len() as u32).to_le_bytes()).unwrap();
    let mut buf = Vec::new();
    drive(&mut body, &mut pos, &mut vel, 0..ticks, script, &ground, |_, b| {
        let origin = Vec3::ZERO;
        skin(&m, &matrices(&b.skel, &b.pose, origin), &mut buf);
        for (p, n) in &buf {
            for x in p.to_array().into_iter().chain(n.to_array()) {
                f.write_all(&x.to_le_bytes()).unwrap();
            }
        }
    });
    println!("wrote {out}: {ticks} frames");
}

/// Walk north into a wall at z = 1 (the sim's collide-and-slide: the body
/// stops, keeps pushing, then lets go).
fn wall(out: &str, ticks: u32) {
    let m = mesh();
    let flat = |_: Vec2| 0.0;
    let mut pos = Vec2::ZERO;
    let mut vel = Vec2::ZERO;
    let mut body = Body::new(pos, flat);
    let mut f = std::fs::File::create(out).unwrap();
    f.write_all(&ticks.to_le_bytes()).unwrap();
    f.write_all(&(m.vertices.len() as u32).to_le_bytes()).unwrap();
    let mut buf = Vec::new();
    for t in 0..ticks {
        let want = if (20..200).contains(&t) { Vec2::Y * 1.6 } else { Vec2::ZERO };
        let limit = if want.length_squared() > 0.0 { 18.0 } else { 34.0 } * avatar::DT;
        let change = want - vel;
        vel = if change.length() <= limit { want } else { vel + change.normalize() * limit };
        let mut next = pos + vel * avatar::DT;
        let mut contact = Vec2::ZERO;
        if next.y > 1.0 - avatar::body::WALL_GAP {
            next.y = 1.0 - avatar::body::WALL_GAP;
            vel.y = 0.0;
            contact = Vec2::Y;
        }
        pos = next;
        body.tick(&avatar::Input { position: pos, velocity: vel, intent: want.normalize_or_zero(), contact, crouching: false }, &flat);
        skin(&m, &matrices(&body.skel, &body.pose, Vec3::ZERO), &mut buf);
        for (p, n) in &buf {
            for x in p.to_array().into_iter().chain(n.to_array()) {
                f.write_all(&x.to_le_bytes()).unwrap();
            }
        }
    }
    println!("wrote {out}: {ticks} frames");
}
