//! cave_tour — emit a DEMO trace that walks the player on a guided tour through
//! a procedurally generated cave, room to room, opening the doors it crosses.
//!
//! The cave generator is deterministic in `seed`, so this planner can rebuild
//! the exact floor grid the renderer will use, BFS a collision-free route over
//! the walkable cells, and stamp a command trace the headless DEMO path replays
//! one tick per frame (`SCENE=cave DEMO=<file> DEMO_DIR=<dir>`), dumping a PNG
//! per tick. Collision in the sim is a POINT test on the player centre, and
//! every BFS segment is axis-aligned through cell centres, so the straight
//! click-walks never clip a wall. Doors start shut (a collision solid); the
//! tour clicks each one open (a door-hitting ray beats a ground walk) and waits
//! out the swing before stepping through.
//!
//! Usage: `cargo run -p house-game --bin cave_tour -- [seed] [rooms] [loops] [max_rooms]`
//! (defaults match `bin/run`'s cave: seed 1, 10 rooms, 3 loops; visit 4 rooms).
//! The trace goes to stdout; a human summary + the ready-to-run DEMO command go
//! to stderr.

use house_game::{cave_level_with, CaveParams, CORRIDOR_ROOM_ID_BASE};
use std::collections::{HashMap, VecDeque};

/// Screen px per world unit (ISO_R = 32·√2) ÷ px per tick (PLAYER_SPEED_PX 140 ·
/// TICK_DT 1/60) = ticks to cross 1 wu at full walk speed. A planner heuristic;
/// the per-leg arrive margin absorbs any small drift if those constants move.
const TICKS_PER_WU: f32 = (32.0 * std::f32::consts::SQRT_2) / (140.0 / 60.0);
/// Extra ticks per walk leg so the player fully ARRIVES (WalkTarget clears)
/// before the next click — a turn that retargets early would cut the corner.
const ARRIVE_MARGIN: u64 = 6;
/// Ticks to wait after clicking a door open: the 24-tick swing + slack. The
/// leaf's collision solid only drops once the door is FULLY open.
const DOOR_WAIT: u64 = 30;

type Cell = (i32, i32);

fn main() {
    let mut a = std::env::args().skip(1);
    let seed: u64 = a.next().and_then(|s| s.parse().ok()).unwrap_or(1);
    let rooms: u32 = a.next().and_then(|s| s.parse().ok()).unwrap_or(10);
    let loops: u32 = a.next().and_then(|s| s.parse().ok()).unwrap_or(3);
    let max_rooms: usize = a.next().and_then(|s| s.parse().ok()).unwrap_or(4);

    let params = CaveParams::for_rooms(rooms, loops);
    let (w, h) = (params.grid_w, params.grid_h);
    let spec = cave_level_with(seed, params);
    let at = |x: i32, z: i32| (z * w + x) as usize;
    let in_bounds = |x: i32, z: i32| (0..w).contains(&x) && (0..h).contains(&z);

    // ---- rebuild the walkable floor grid from the spec's room+corridor rects
    // (exactly how cave::tests::all_rooms_are_connected re-derives it) ----
    let mut floor = vec![false; (w * h) as usize];
    for r in &spec.rooms {
        let fr = r.floor_rect;
        for z in fr[1] as i32..fr[3] as i32 {
            for x in fr[0] as i32..fr[2] as i32 {
                if in_bounds(x, z) {
                    floor[at(x, z)] = true;
                }
            }
        }
    }
    let is_floor = |c: Cell| in_bounds(c.0, c.1) && floor[at(c.0, c.1)];

    // ---- door edges: map each shut door onto the grid edge it blocks, with the
    // world point to aim the open-click at (the gap centre on the wall line) ----
    let mut door_edge: HashMap<(Cell, Cell), (f32, f32)> = HashMap::new();
    let key = |p: Cell, q: Cell| if p <= q { (p, q) } else { (q, p) };
    for d in &spec.doors {
        let s = d.closed_solid;
        let (dw, dh) = (s[2] - s[0], s[3] - s[1]);
        if dw < dh {
            // vertical leaf on line x=k, spanning one z cell → splits (k-1,z)|(k,z)
            let k = ((s[0] + s[2]) * 0.5).round() as i32;
            let z = s[1].round() as i32;
            door_edge.insert(key((k - 1, z), (k, z)), (k as f32, z as f32 + 0.5));
        } else {
            // horizontal leaf on line z=k, spanning one x cell → splits (x,k-1)|(x,k)
            let k = ((s[1] + s[3]) * 0.5).round() as i32;
            let x = s[0].round() as i32;
            door_edge.insert(key((x, k - 1), (x, k)), (x as f32 + 0.5, k as f32));
        }
    }

    // ---- room centres (non-corridor rooms, spec order) ----
    let centres: Vec<Cell> = spec
        .rooms
        .iter()
        .filter(|r| r.id.0 < CORRIDOR_ROOM_ID_BASE)
        .map(|r| {
            let fr = r.floor_rect;
            (((fr[0] + fr[2]) * 0.5) as i32, ((fr[1] + fr[3]) * 0.5) as i32)
        })
        .collect();
    assert!(!centres.is_empty(), "cave has no rooms");

    // ---- tour order: nearest-neighbour chain from room 0 (the spawn room) ----
    let manhattan = |a: Cell, b: Cell| (a.0 - b.0).abs() + (a.1 - b.1).abs();
    let mut order = vec![0usize];
    let mut remaining: Vec<usize> = (1..centres.len()).collect();
    while order.len() < max_rooms && !remaining.is_empty() {
        let last = centres[*order.last().unwrap()];
        let (pick_i, _) = remaining.iter().enumerate().min_by_key(|(_, &r)| manhattan(last, centres[r])).unwrap();
        order.push(remaining.remove(pick_i));
    }

    // ---- BFS each consecutive room pair, concatenate into one cell path ----
    let bfs = |start: Cell, goal: Cell| -> Vec<Cell> {
        let mut prev: HashMap<Cell, Cell> = HashMap::new();
        let mut q = VecDeque::new();
        q.push_back(start);
        prev.insert(start, start);
        while let Some(c) = q.pop_front() {
            if c == goal {
                break;
            }
            for (dx, dz) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                let n = (c.0 + dx, c.1 + dz);
                if is_floor(n) && !prev.contains_key(&n) {
                    prev.insert(n, c);
                    q.push_back(n);
                }
            }
        }
        // reconstruct
        let mut path = Vec::new();
        if !prev.contains_key(&goal) {
            return path; // unreachable (shouldn't happen — generator connects all)
        }
        let mut c = goal;
        while c != start {
            path.push(c);
            c = prev[&c];
        }
        path.push(start);
        path.reverse();
        path
    };

    let mut path: Vec<Cell> = Vec::new();
    for pair in order.windows(2) {
        let seg = bfs(centres[pair[0]], centres[pair[1]]);
        assert!(!seg.is_empty(), "room {} unreachable from {} — generator should connect all", pair[1], pair[0]);
        if path.is_empty() {
            path.extend(seg);
        } else {
            path.extend(seg.into_iter().skip(1)); // drop the shared junction cell
        }
    }
    assert!(path.len() >= 2, "tour path too short — need >= 2 rooms placed");

    // ---- emit the trace ----
    let centre = |c: Cell| (c.0 as f32 + 0.5, c.1 as f32 + 0.5);
    let click = |t: u64, gx: f32, gz: f32| {
        // a straight-down ray: it never grazes a door's inflated interact box
        // when aimed at a cell centre (0.5 wu clear > 0.425 inflate), so a
        // walk click stays a walk; aimed at a door centre it opens the door.
        println!("{t} click {gx:.3} 8.000 {gz:.3} 0 -1 0 {gx:.3} {gz:.3}");
    };

    let mut t: u64 = 8; // a short establishing hold on the spawn room
    println!("# cave tour — seed {seed}, rooms {rooms}, loops {loops}, visiting {} rooms", order.len());
    println!("3 flash"); // torch on early — lights the corridors as we go

    let n = path.len();
    let mut waypoints = 0u32;
    let mut doors_opened = 0u32;
    let mut i = 0usize;
    while i + 1 < n {
        let (a, b) = (path[i], path[i + 1]);
        if let Some(&(cx, cz)) = door_edge.get(&key(a, b)) {
            click(t, cx, cz); // open the door (ray hits it → interact, no walk)
            doors_opened += 1;
            t += DOOR_WAIT;
            let (gx, gz) = centre(b);
            click(t, gx, gz); // step through the now-open gap
            waypoints += 1;
            t += (TICKS_PER_WU.ceil() as u64) + ARRIVE_MARGIN;
            i += 1;
            continue;
        }
        // extend a straight run in this direction until it turns or hits a door
        let dir = (b.0 - a.0, b.1 - a.1);
        let mut j = i + 1;
        while j + 1 < n {
            let (c, d) = (path[j], path[j + 1]);
            if (d.0 - c.0, d.1 - c.1) != dir || door_edge.contains_key(&key(c, d)) {
                break;
            }
            j += 1;
        }
        let tgt = path[j];
        let dist = (tgt.0 - a.0).abs() + (tgt.1 - a.1).abs();
        let (gx, gz) = centre(tgt);
        click(t, gx, gz);
        waypoints += 1;
        t += (dist as f32 * TICKS_PER_WU).ceil() as u64 + ARRIVE_MARGIN;
        i = j;
    }

    // a tail hold on the final room, then a no-op Move to extend the timeline
    let tail = 40u64;
    let end = t + tail;
    println!("{end} move 0 0");
    let total = end + 1;

    eprintln!("cave_tour: seed {seed}, {} rooms placed, visiting {} ({:?})", centres.len(), order.len(), order);
    eprintln!("cave_tour: {} cells, {waypoints} walk waypoints, {doors_opened} doors opened", path.len());
    eprintln!("cave_tour: {total} ticks total (~{:.1}s of gameplay @ 60 fps)", total as f32 / 60.0);
    eprintln!("cave_tour: render with —");
    eprintln!("  SCENE=cave CAVE_SEED={seed} CAVE_ROOMS={rooms} CAVE_LOOPS={loops} \\");
    eprintln!("  DEMO=<trace> DEMO_DIR=<outdir> DEMO_TICKS={total} ./target/release/viewer");
}
