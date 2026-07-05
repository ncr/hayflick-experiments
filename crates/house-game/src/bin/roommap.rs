//! roommap — render top-down "floorplan" PNGs of the procedural cave generator
//! so the room layouts can be assessed by eye (and by a few derived metrics).
//!
//! For each seed it generates a `LevelSpec` (deterministic in the seed), then:
//!   * rasterises the walkable floor grid — each real room gets a distinct
//!     pastel hue, corridors a neutral grey, rock/void stays dark;
//!   * marks every door (orange) and the player spawn (green);
//!   * overlays the room↔corridor connectivity graph in cyan (room centres
//!     linked to the corridor-junction centroids that join them) so loops and
//!     dead-ends read at a glance;
//!   * stamps each room's id, and a header line of stats.
//!
//! It also writes a montage of all the seeds and prints per-seed metrics
//! (placed vs target rooms, doors, fill %, realised loops, dead-ends, room-area
//! spread) to stdout.
//!
//! Usage: `cargo run -p house-game --bin roommap -- <out_dir> [count=6] [rooms=10] [loops=3] [seed0=1]`

use house_game::mapviz::Canvas;
use house_game::{cave_level_with, CaveParams, LevelSpec, CORRIDOR_ROOM_ID_BASE};
use std::collections::{HashMap, HashSet};

const PX: i32 = 16; // pixels per world cell
const MARGIN: i32 = 10;
const HDR: i32 = 40; // header strip height (stats line)

// palette
const BG: [u8; 3] = [22, 24, 30]; // rock / void
const HDR_BG: [u8; 3] = [15, 16, 21];
const CORRIDOR: [u8; 3] = [78, 86, 104];
const DOOR: [u8; 3] = [255, 150, 40];
const START: [u8; 3] = [70, 230, 120];
const EDGE: [u8; 3] = [90, 205, 225]; // connectivity overlay
const LABEL: [u8; 3] = [22, 22, 28];
const HDR_FG: [u8; 3] = [220, 224, 235];

fn main() {
    let mut a = std::env::args().skip(1);
    let out_dir = a.next().unwrap_or_else(|| "/tmp/roommaps".into());
    let count: u64 = a.next().and_then(|s| s.parse().ok()).unwrap_or(6);
    let rooms: u32 = a.next().and_then(|s| s.parse().ok()).unwrap_or(10);
    let loops: u32 = a.next().and_then(|s| s.parse().ok()).unwrap_or(3);
    let seed0: u64 = a.next().and_then(|s| s.parse().ok()).unwrap_or(1);

    std::fs::create_dir_all(&out_dir).expect("create out_dir");

    let mut tiles: Vec<Canvas> = Vec::new();
    for k in 0..count {
        let seed = seed0 + k;
        let params = CaveParams::for_rooms(rooms, loops);
        let spec = cave_level_with(seed, params);
        let an = analyse(&spec, params);
        let canvas = render(&spec, &an, seed, rooms, loops);

        let path = format!("{out_dir}/room_s{seed:03}_r{rooms}_l{loops}.png");
        canvas.write_png(&path);

        // per-seed metrics to stdout (transcribed into the email body)
        let areas = &an.room_areas;
        let (amin, amed, amax) = spread(areas);
        println!(
            "seed={seed} placed={}/{rooms} corridors={} doors={} floor_cells={} fill={:.0}% \
             loops={}/{loops} dead_ends={} room_area[min/med/max]={amin}/{amed}/{amax}",
            an.placed,
            an.corridors,
            an.doors,
            an.floor_cells,
            100.0 * an.floor_cells as f32 / (params.grid_w * params.grid_h) as f32,
            an.realised_loops,
            an.dead_ends.len(),
        );
        eprintln!("  wrote {path}");
        tiles.push(canvas);
    }

    // montage: a grid of all the tiles (all share dimensions for fixed `rooms`)
    let cols = (count as i32).clamp(1, 3);
    let rows = ((count as i32) + cols - 1) / cols;
    let (tw, th) = (tiles[0].w as i32, tiles[0].h as i32);
    let pad = 14;
    let mw = pad + cols * (tw + pad);
    let mh = pad + rows * (th + pad);
    let mut mon = Canvas::new(mw as usize, mh as usize, [10, 11, 14]);
    for (i, t) in tiles.iter().enumerate() {
        let cx = (i as i32) % cols;
        let cy = (i as i32) / cols;
        let ox = pad + cx * (tw + pad);
        let oy = pad + cy * (th + pad);
        mon.blit(t, ox, oy);
    }
    let mpath = format!("{out_dir}/montage_r{rooms}_l{loops}.png");
    mon.write_png(&mpath);
    eprintln!("wrote montage {mpath} ({}x{})", mw, mh);
}

// ---------------------------------------------------------------- analysis ---

struct Analysis {
    placed: usize,
    corridors: usize,
    doors: usize,
    floor_cells: usize,
    realised_loops: i32,
    dead_ends: Vec<u32>,    // room ids with graph-degree 1
    room_areas: Vec<i32>,   // cell areas of real rooms
    // render aids:
    owner: Vec<i32>,        // per-cell real-room index, or -1
    real_centres: Vec<(f32, f32)>, // world centre per real room (index order)
    real_ids: Vec<u32>,     // id.0 per real room (index order)
    overlay: Vec<((f32, f32), (f32, f32))>, // world-space connectivity segments
    w: i32,
    h: i32,
}

fn analyse(spec: &LevelSpec, params: CaveParams) -> Analysis {
    let (w, h) = (params.grid_w, params.grid_h);
    let inb = |x: i32, z: i32| x >= 0 && x < w && z >= 0 && z < h;
    let id = |x: i32, z: i32| (z * w + x) as usize;
    let n = (w * h) as usize;

    let mut floor = vec![false; n];
    for r in &spec.rooms {
        let fr = r.floor_rect;
        for z in fr[1] as i32..fr[3] as i32 {
            for x in fr[0] as i32..fr[2] as i32 {
                if inb(x, z) {
                    floor[id(x, z)] = true;
                }
            }
        }
    }

    let real: Vec<&house_game::RoomSpec> = spec.rooms.iter().filter(|r| r.id.0 < CORRIDOR_ROOM_ID_BASE).collect();
    let mut owner = vec![-1i32; n];
    for (ri, r) in real.iter().enumerate() {
        let fr = r.floor_rect;
        for z in fr[1] as i32..fr[3] as i32 {
            for x in fr[0] as i32..fr[2] as i32 {
                if inb(x, z) {
                    owner[id(x, z)] = ri as i32;
                }
            }
        }
    }

    // union-find over corridor cells (floor && no room owner)
    let mut uf: Vec<usize> = (0..n).collect();
    let corr = |c: usize, fl: &[bool], ow: &[i32]| fl[c] && ow[c] == -1;
    for z in 0..h {
        for x in 0..w {
            let c = id(x, z);
            if !corr(c, &floor, &owner) {
                continue;
            }
            for (dx, dz) in [(1, 0), (0, 1)] {
                let (nx, nz) = (x + dx, z + dz);
                if inb(nx, nz) && corr(id(nx, nz), &floor, &owner) {
                    union(&mut uf, c, id(nx, nz));
                }
            }
        }
    }

    // comp rep -> adjacent rooms + member cells; plus room↔room direct adjacency
    let mut comp_rooms: HashMap<usize, HashSet<i32>> = HashMap::new();
    let mut comp_cells: HashMap<usize, Vec<(i32, i32)>> = HashMap::new();
    let mut room_room: HashSet<(i32, i32)> = HashSet::new();
    for z in 0..h {
        for x in 0..w {
            let c = id(x, z);
            if !floor[c] {
                continue;
            }
            if owner[c] == -1 {
                comp_cells.entry(find(&mut uf, c)).or_default().push((x, z));
            }
            for (dx, dz) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                let (nx, nz) = (x + dx, z + dz);
                if !inb(nx, nz) || !floor[id(nx, nz)] {
                    continue;
                }
                let nc = id(nx, nz);
                if owner[c] == -1 && owner[nc] >= 0 {
                    let rep = find(&mut uf, c);
                    comp_rooms.entry(rep).or_default().insert(owner[nc]);
                } else if owner[c] >= 0 && owner[nc] >= 0 && owner[c] != owner[nc] {
                    let (a, b) = (owner[c].min(owner[nc]), owner[c].max(owner[nc]));
                    room_room.insert((a, b));
                }
            }
        }
    }

    // graph: nodes = R rooms (0..R) + comps that touch >=1 room (R..R+K).
    // realised loops = cycle rank = E - V + C.
    let r_count = real.len();
    let comps: Vec<usize> = comp_rooms.keys().copied().collect();
    let comp_node: HashMap<usize, usize> = comps.iter().enumerate().map(|(i, &rep)| (rep, r_count + i)).collect();
    let v = r_count + comps.len();
    let mut guf: Vec<usize> = (0..v).collect();
    let mut deg = vec![0i32; r_count];
    let mut e = 0i32;
    for (&rep, rs) in &comp_rooms {
        let cn = comp_node[&rep];
        for &ri in rs {
            union(&mut guf, ri as usize, cn);
            deg[ri as usize] += 1;
            e += 1;
        }
    }
    for &(a, b) in &room_room {
        union(&mut guf, a as usize, b as usize);
        deg[a as usize] += 1;
        deg[b as usize] += 1;
        e += 1;
    }
    let mut roots = HashSet::new();
    for i in 0..v {
        roots.insert(find(&mut guf, i));
    }
    let realised_loops = e - v as i32 + roots.len() as i32;

    // render aids + per-room facts
    let mut real_centres = Vec::with_capacity(r_count);
    let mut real_ids = Vec::with_capacity(r_count);
    let mut room_areas = Vec::with_capacity(r_count);
    for r in &real {
        let fr = r.floor_rect;
        real_centres.push(((fr[0] + fr[2]) * 0.5, (fr[1] + fr[3]) * 0.5));
        real_ids.push(r.id.0);
        room_areas.push((fr[2] - fr[0]) as i32 * (fr[3] - fr[1]) as i32);
    }
    let mut dead_ends: Vec<u32> = (0..r_count).filter(|&i| deg[i] == 1).map(|i| real_ids[i]).collect();
    dead_ends.sort_unstable();

    // overlay segments: each room centre -> centroid of every joining comp
    let mut overlay = Vec::new();
    for (&rep, rs) in &comp_rooms {
        let cells = &comp_cells[&rep];
        let cc = (
            cells.iter().map(|c| c.0 as f32 + 0.5).sum::<f32>() / cells.len() as f32,
            cells.iter().map(|c| c.1 as f32 + 0.5).sum::<f32>() / cells.len() as f32,
        );
        for &ri in rs {
            overlay.push((real_centres[ri as usize], cc));
        }
    }

    Analysis {
        placed: r_count,
        corridors: spec.rooms.len() - r_count,
        doors: spec.doors.len(),
        floor_cells: floor.iter().filter(|&&f| f).count(),
        realised_loops,
        dead_ends,
        room_areas,
        owner,
        real_centres,
        real_ids,
        overlay,
        w,
        h,
    }
}

fn find(uf: &mut [usize], mut x: usize) -> usize {
    while uf[x] != x {
        uf[x] = uf[uf[x]];
        x = uf[x];
    }
    x
}
fn union(uf: &mut [usize], a: usize, b: usize) {
    let (ra, rb) = (find(uf, a), find(uf, b));
    if ra != rb {
        uf[ra] = rb;
    }
}

fn spread(v: &[i32]) -> (i32, i32, i32) {
    if v.is_empty() {
        return (0, 0, 0);
    }
    let mut s = v.to_vec();
    s.sort_unstable();
    (s[0], s[s.len() / 2], s[s.len() - 1])
}

// ----------------------------------------------------------------- render ---

fn render(spec: &LevelSpec, an: &Analysis, seed: u64, rooms: u32, loops: u32) -> Canvas {
    let (gw, gh) = (an.w, an.h);
    let cw = (MARGIN * 2 + gw * PX) as usize;
    let ch = (MARGIN * 2 + HDR + gh * PX) as usize;
    let mut c = Canvas::new(cw, ch, BG);

    // header strip
    c.fill(0, 0, cw as i32, HDR, HDR_BG);
    let header = format!(
        "SEED {seed}  ROOMS {}/{rooms}  DOORS {}  LOOPS {}/{loops}",
        an.placed, an.doors, an.realised_loops
    );
    c.text(&header, MARGIN, MARGIN + 4, 3, HDR_FG);

    let wx = |x: f32| MARGIN + (x * PX as f32) as i32;
    let wz = |z: f32| MARGIN + HDR + (z * PX as f32) as i32;

    // floor cells: room hue / corridor grey
    for z in 0..gh {
        for x in 0..gw {
            let o = an.owner[(z * gw + x) as usize];
            // a cell is floor if owned by a room, or if it's a corridor cell.
            // corridor cells aren't owned, so re-derive from the room rects via
            // owner==-1 is ambiguous with void; instead colour rooms here and
            // corridors below from the spec's corridor rects.
            if o >= 0 {
                let col = room_color(o as usize);
                c.fill(wx(x as f32), wz(z as f32), wx(x as f32) + PX, wz(z as f32) + PX, col);
            }
        }
    }
    // corridors (rects with id >= base) — drawn from the spec so we don't need a
    // separate floor grid in the renderer; rooms already painted above win where
    // they overlap because we skip cells already owned.
    for r in &spec.rooms {
        if r.id.0 < CORRIDOR_ROOM_ID_BASE {
            continue;
        }
        let fr = r.floor_rect;
        for z in fr[1] as i32..fr[3] as i32 {
            for x in fr[0] as i32..fr[2] as i32 {
                if x < 0 || x >= gw || z < 0 || z >= gh {
                    continue;
                }
                if an.owner[(z * gw + x) as usize] >= 0 {
                    continue; // a real room owns this cell
                }
                c.fill(wx(x as f32), wz(z as f32), wx(x as f32) + PX, wz(z as f32) + PX, CORRIDOR);
            }
        }
    }

    // room outlines (a darker border so adjacent hues separate cleanly)
    for r in &spec.rooms {
        if r.id.0 >= CORRIDOR_ROOM_ID_BASE {
            continue;
        }
        let fr = r.floor_rect;
        c.rect_outline(wx(fr[0]), wz(fr[1]), wx(fr[2]), wz(fr[3]), [12, 13, 17]);
    }

    // connectivity overlay (cyan): room centre -> corridor-junction centroid
    for &((rx, rz), (jx, jz)) in &an.overlay {
        c.line(wx(rx), wz(rz), wx(jx), wz(jz), EDGE);
    }

    // doors (orange leaf footprints)
    for d in &spec.doors {
        let s = d.closed_solid;
        c.fill(wx(s[0]), wz(s[1]), wx(s[2]).max(wx(s[0]) + 2), wz(s[3]).max(wz(s[1]) + 2), DOOR);
    }

    // player spawn (green disc)
    c.disc(wx(spec.player_start.x), wz(spec.player_start.z), (PX as f32 * 0.35) as i32, START);

    // room id labels (digits) at each room centre
    for (i, &(rx, rz)) in an.real_centres.iter().enumerate() {
        let s = an.real_ids[i].to_string();
        let scale = 2;
        let tw = s.len() as i32 * (4 * scale) - scale;
        c.text(&s, wx(rx) - tw / 2, wz(rz) - (5 * scale) / 2, scale, LABEL);
    }

    c
}

/// Distinct pastel hue per room via the golden-ratio hue rotation.
fn room_color(i: usize) -> [u8; 3] {
    let hue = (i as f32 * 0.618_034).fract();
    hsv(hue, 0.45, 0.92)
}

fn hsv(h: f32, s: f32, v: f32) -> [u8; 3] {
    let i = (h * 6.0).floor();
    let f = h * 6.0 - i;
    let (p, q, t) = (v * (1.0 - s), v * (1.0 - s * f), v * (1.0 - s * (1.0 - f)));
    let (r, g, b) = match (i as i32).rem_euclid(6) {
        0 => (v, t, p),
        1 => (q, v, p),
        2 => (p, v, t),
        3 => (p, q, v),
        4 => (t, p, v),
        _ => (v, p, q),
    };
    [(r * 255.0) as u8, (g * 255.0) as u8, (b * 255.0) as u8]
}
