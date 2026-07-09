//! thief_spine_clip — render the spine trace as a top-down map animation
//! (the M1 "clip" gate, docs/spec/12; kept as the headless debug projection
//! now that M2 integrates the real renderer).
//!
//!   cargo run --release -p house-game --bin thief_spine_clip -- <out_dir> [outfit]
//!
//! Writes frame_%04d.png at 1 frame / 12 ticks; assemble with ffmpeg (see
//! bin/ usage in the commit). `outfit` runs the counterfactual trace (the
//! thief sheds the hood before returning — no stop).

use house_game::mapviz::Canvas;
use house_game::thief::grid::{CellKind, CellPos, Dir, DoorState, EdgeKind, Prop, WindowState};
use house_game::thief::log::narrate;
use house_game::thief::perception::{Feature, Headwear, Hue};
use house_game::thief::sim::{spine_level, spine_trace, NpcState, Role, ThiefGame};
use sim_core::{Runner, Simulation};

const CELL: i32 = 16;
const HEADER: i32 = 44;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let out = args.get(1).cloned().unwrap_or_else(|| "/tmp/thief_spine".into());
    let outfit = args.iter().any(|a| a == "outfit");
    std::fs::create_dir_all(&out).unwrap();

    let spec = spine_level();
    let mut r = Runner::new(ThiefGame::new(spine_level()));
    r.feed(spine_trace(outfit));

    let frames = 350;
    let mut last_event = String::from("a quiet morning");
    let mut seen_events = 0usize;
    for f in 0..frames {
        r.run_ticks(12);
        let game = &r.sim;
        // Ticker = the newest line of the REAL event log (module 11).
        for s in &game.events[seen_events..] {
            if let Some(line) = narrate(&spec, s) {
                last_event = line;
            }
        }
        seen_events = game.events.len();
        let canvas = draw(game, (f * 12) as u64, &last_event);
        canvas.write_png(&format!("{out}/frame_{f:04}.png"));
    }
    println!("wrote {frames} frames to {out}");
}

fn draw(game: &ThiefGame, tick: u64, event: &str) -> Canvas {
    let g = game.grid();
    let target = game.spec().target;
    let (w, h) = (g.w as i32 * CELL, g.h as i32 * CELL);
    let mut c = Canvas::new(w as usize, (h + HEADER) as usize, [16, 17, 20]);

    // Cells, lit by the sim's own light field (lamps + day-phase ambient).
    for z in 0..g.h {
        for x in 0..g.w {
            let p = CellPos::new(x, z, 0);
            let cell = g.cell(p);
            let base: [i32; 3] = match cell.kind {
                CellKind::Void => [10, 10, 12],
                CellKind::Outdoor => [46, 50, 56],
                CellKind::Room(_) => [88, 74, 56],
            };
            let lvl = game.light_at(p).clamp(0, 8);
            let mut col = [
                (base[0] + lvl * 14).min(255) as u8,
                (base[1] + lvl * 12).min(255) as u8,
                (base[2] + lvl * 8).min(255) as u8,
            ];
            if cell.prop == Prop::Furniture {
                col = [40, 36, 32];
            }
            if cell.prop == Prop::HidingSpot {
                col = [58, 50, 72];
            }
            let (px, py) = (x as i32 * CELL, HEADER + z as i32 * CELL);
            c.fill(px, py, px + CELL, py + CELL, col);
            if p == target {
                c.rect_outline(px + 4, py + 4, px + CELL - 4, py + CELL - 4, [235, 200, 60]);
            }
        }
    }

    // Edges: walls dark, doors amber, windows cyan (drawn on Zm/Xm sides +
    // the far boundary).
    for z in 0..g.h {
        for x in 0..g.w {
            let p = CellPos::new(x, z, 0);
            let (px, py) = (x as i32 * CELL, HEADER + z as i32 * CELL);
            edge_line(&mut c, g.edge(p, Dir::Zm), px, py, true);
            edge_line(&mut c, g.edge(p, Dir::Xm), px, py, false);
            if z == g.h - 1 {
                edge_line(&mut c, g.edge(p, Dir::Zp), px, py + CELL - 2, true);
            }
            if x == g.w - 1 {
                edge_line(&mut c, g.edge(p, Dir::Xp), px + CELL - 2, py, false);
            }
        }
    }

    // NPCs, colored by role, labeled by ladder state; hunters get rings.
    let snap = game.snapshot();
    for n in &snap.npcs {
        let (cx, cy) = (
            n.pos.x as i32 * CELL + CELL / 2,
            HEADER + n.pos.z as i32 * CELL + CELL / 2,
        );
        let col = match n.role {
            Role::Guard => [80, 130, 230],
            Role::Civilian => [225, 205, 90],
        };
        match n.state {
            NpcState::Pursue => c.disc(cx, cy, 7, [235, 60, 50]),
            NpcState::Approach | NpcState::Confront => c.disc(cx, cy, 7, [235, 160, 50]),
            _ => {}
        }
        c.disc(cx, cy, 5, col);
        let label = match n.state {
            NpcState::Routine => "r",
            NpcState::Notice => "n",
            NpcState::Investigate => "i",
            NpcState::Reporting => "t",
            NpcState::Approach => "A",
            NpcState::Confront => "S",
            NpcState::Pursue => "P",
        };
        c.text(label, cx - 2, cy - 14, 1, [240, 240, 240]);
    }

    // The player: coat color from the live look; hood ring; loot dot.
    let (cx, cy) = (
        snap.player.x as i32 * CELL + CELL / 2,
        HEADER + snap.player.z as i32 * CELL + CELL / 2,
    );
    let coat = match game.look().top {
        Feature::Seen(Hue::Green) => [70, 160, 85],
        Feature::Seen(Hue::Brown) => [150, 100, 60],
        _ => [200, 200, 200],
    };
    if game.look().headwear == Feature::Seen(Headwear::Hood) {
        c.disc(cx, cy, 7, [25, 50, 30]);
    }
    c.disc(cx, cy, 5, coat);
    if snap.carrying {
        c.disc(cx, cy, 2, [250, 250, 250]);
    }

    // Header: clock, case count, the scrutiny meter, the event ticker.
    c.text(
        &format!(
            "M2 SLICE  t={tick:>5}  {:02}:{:02}  cases={}  coin={}",
            snap.day_min / 60,
            snap.day_min % 60,
            snap.n_cases,
            snap.coin
        ),
        6,
        4,
        1,
        [200, 200, 210],
    );
    c.text(&format!("scrutiny {:>3}", snap.scrutiny), 6, 16, 1, [200, 200, 210]);
    let bar = snap.scrutiny.clamp(0, 100) * 2;
    c.fill(110, 16, 110 + bar, 24, if snap.scrutiny >= 15 { [220, 70, 50] } else { [90, 160, 90] });
    c.rect_outline(110, 16, 310, 24, [120, 120, 130]);
    c.text(event, 6, 30, 1, [235, 220, 160]);
    c
}

/// Draw a barrier edge as a 2px band starting at the cell corner (x, y):
/// horizontal bands run along +x, vertical along +y.
fn edge_line(c: &mut Canvas, e: EdgeKind, x: i32, y: i32, horizontal: bool) {
    let col = match e {
        EdgeKind::Wall => Some([18, 18, 22]),
        EdgeKind::Door(DoorState::Open) => Some([214, 150, 60]),
        EdgeKind::Door(_) => Some([160, 100, 40]),
        EdgeKind::Window(WindowState::Shuttered) => Some([60, 70, 80]),
        EdgeKind::Window(_) => Some([90, 180, 200]),
        _ => None,
    };
    if let Some(col) = col {
        if horizontal {
            c.fill(x, y, x + CELL, y + 2, col);
        } else {
            c.fill(x, y, x + 2, y + CELL, col);
        }
    }
}
