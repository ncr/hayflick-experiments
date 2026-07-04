//! plans — compare several *house floor-plan* generation techniques side by side.
//!
//! Self-contained dev tool (imports only the public `house_game` surface): each
//! technique is a `fn(seed) -> LevelSpec`; we render N seeds per technique into a
//! montage via the shared `mapviz` renderer, and print quantitative believability
//! metrics so the layouts can be rated by eye AND by number.
//!
//! Usage: `cargo run -p house-game --bin plans -- <out_dir> [count=6] [seed0=1]`
//!
//! Convention (shared with mapviz): a room whose `id.0 >= CORRIDOR_ROOM_ID_BASE`
//! is circulation (grey); `>= SERVICE_ROOM_ID_BASE` is a service room (utility).

#![allow(dead_code)]

use house_game::mapviz::{self, SERVICE_ROOM_ID_BASE};
use house_game::{DoorId, DoorSpec, LevelSpec, LightId, LightKind, LightSpec, RoomId, RoomSpec, CORRIDOR_ROOM_ID_BASE};
use glam::Vec3;

// ----------------------------------------------------------------- shared ---

const DOOR_OPEN: f32 = 1.745_329_3; // 100°
const T: f32 = 0.125; // door-leaf half thickness

/// SplitMix64 — deterministic per-seed stream (matches the other generators).
pub struct Rng(pub u64);
impl Rng {
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    /// uniform in [lo, hi)
    pub fn range(&mut self, lo: i32, hi: i32) -> i32 {
        lo + (self.next_u64() % (hi - lo).max(1) as u64) as i32
    }
    pub fn chance(&mut self, num: u64, den: u64) -> bool {
        self.next_u64() % den < num
    }
    /// uniform f32 in [0,1)
    pub fn frac(&mut self) -> f32 {
        (self.next_u64() >> 11) as f32 / (1u64 << 53) as f32
    }
    pub fn pick<'a, T>(&mut self, xs: &'a [T]) -> &'a T {
        &xs[(self.next_u64() % xs.len() as u64) as usize]
    }
}

/// A rectangle in integer grid cells: [x0, z0, x1, z1) (half-open).
pub type Rect = [i32; 4];

pub fn area(r: &Rect) -> i32 {
    (r[2] - r[0]) * (r[3] - r[1])
}
pub fn rectf(r: &Rect) -> [f32; 4] {
    [r[0] as f32, r[1] as f32, r[2] as f32, r[3] as f32]
}

/// Door leaf on the vertical line x=line over z[zc,zc+1].
pub fn vdoor(line: i32, zc: i32) -> ([f32; 4], Vec3) {
    let l = line as f32;
    ([l - T, zc as f32, l + T, zc as f32 + 1.0], Vec3::new(l, 0.0, zc as f32))
}
/// Door leaf on the horizontal line z=line over x[xc,xc+1].
pub fn hdoor(line: i32, xc: i32) -> ([f32; 4], Vec3) {
    let l = line as f32;
    ([xc as f32, l - T, xc as f32 + 1.0, l + T], Vec3::new(xc as f32, 0.0, l))
}

pub fn push_door(doors: &mut Vec<DoorSpec>, leaf: ([f32; 4], Vec3)) {
    let id = doors.len() as u32;
    doors.push(DoorSpec {
        id: DoorId(id),
        hinge: leaf.1,
        axis_y: 1.0,
        closed_solid: leaf.0,
        open_angle: DOOR_OPEN,
        anim_ticks: 24,
        name: format!("plan_door_{id}"),
    });
}

/// The 1-cell door rect (+hinge) between two wall-sharing rooms, or None.
/// Returns the closed-leaf footprint placed at the mid of the shared edge.
pub fn shared_door(a: &Rect, b: &Rect) -> Option<([f32; 4], Vec3)> {
    let vshared = |l: &Rect, r: &Rect| -> Option<([f32; 4], Vec3)> {
        if l[2] != r[0] {
            return None;
        }
        let (zlo, zhi) = (l[1].max(r[1]), l[3].min(r[3]));
        if zhi - zlo < 1 {
            return None;
        }
        Some(vdoor(l[2], (zlo + zhi) / 2))
    };
    let hshared = |t: &Rect, b: &Rect| -> Option<([f32; 4], Vec3)> {
        if t[3] != b[1] {
            return None;
        }
        let (xlo, xhi) = (t[0].max(b[0]), t[2].min(b[2]));
        if xhi - xlo < 1 {
            return None;
        }
        Some(hdoor(t[3], (xlo + xhi) / 2))
    };
    vshared(a, b).or_else(|| vshared(b, a)).or_else(|| hshared(a, b)).or_else(|| hshared(b, a))
}

/// Assemble a LevelSpec from typed room rects + corridor rects + service rects +
/// doors, with one ceiling light per non-corridor room and a player start.
#[allow(clippy::too_many_arguments)]
pub fn assemble(rooms: &[Rect], corridors: &[Rect], services: &[Rect], doors: Vec<DoorSpec>, start: Vec3, seed: u64) -> LevelSpec {
    let mut out: Vec<RoomSpec> = Vec::new();
    let mut id = 0u32;
    for r in rooms {
        out.push(RoomSpec { id: RoomId(id), floor_rect: rectf(r) });
        id += 1;
    }
    for (i, s) in services.iter().enumerate() {
        out.push(RoomSpec { id: RoomId(SERVICE_ROOM_ID_BASE + i as u32), floor_rect: rectf(s) });
    }
    for (i, c) in corridors.iter().enumerate() {
        out.push(RoomSpec { id: RoomId(CORRIDOR_ROOM_ID_BASE + i as u32), floor_rect: rectf(c) });
    }
    let n_lit = rooms.len() + services.len();
    let lights = (0..n_lit as u32)
        .map(|i| LightSpec { id: LightId(i), room: RoomId(i), kind: LightKind::Incandescent, base_rgb: [1.0, 0.96, 0.9], name: format!("plan_lamp_{i}") })
        .collect();
    LevelSpec { rooms: out, static_solids: Vec::new(), doors, lights, targets: Vec::new(), items: Vec::new(), survival: None, mobs: Vec::new(), traps: Vec::new(), arena: None, player_start: start, seed }
}

// --------------------------------------------------------------- metrics ---

/// Quantitative believability proxies, all computed from the rendered grid.
pub struct Metrics {
    pub rooms: usize,
    pub corridor_cells: i32,
    pub corridor_pct: f32,
    pub area_min: i32,
    pub area_med: i32,
    pub area_max: i32,
    pub area_cv: f32,        // coeff. of variation of room areas (size variety)
    pub bad_aspect: usize,   // rooms with aspect ratio worse than 1:3
    /// rooms reachable from the entry ONLY by passing through another *room*
    /// (no corridor on the path) — the "bedroom-through-bedroom" anti-pattern.
    pub through_room_rooms: usize,
    pub doors: usize,
}

pub fn metrics(spec: &LevelSpec) -> Metrics {
    let b = spec.floor_bounds();
    let (w, h) = (b[2] as i32, b[3] as i32);
    let idx = |x: i32, z: i32| (z * w + x) as usize;
    let n = (w * h) as usize;

    // owner grid: room index (>=0), corridor (-2), or void (-1)
    let real: Vec<&RoomSpec> = spec.rooms.iter().filter(|r| r.id.0 < CORRIDOR_ROOM_ID_BASE).collect();
    let mut owner = vec![-1i32; n];
    for (ri, r) in real.iter().enumerate() {
        let f = r.floor_rect;
        for z in f[1] as i32..f[3] as i32 {
            for x in f[0] as i32..f[2] as i32 {
                if x >= 0 && x < w && z >= 0 && z < h {
                    owner[idx(x, z)] = ri as i32;
                }
            }
        }
    }
    for r in &spec.rooms {
        if r.id.0 < CORRIDOR_ROOM_ID_BASE {
            continue;
        }
        let f = r.floor_rect;
        for z in f[1] as i32..f[3] as i32 {
            for x in f[0] as i32..f[2] as i32 {
                if x >= 0 && x < w && z >= 0 && z < h && owner[idx(x, z)] == -1 {
                    owner[idx(x, z)] = -2; // corridor
                }
            }
        }
    }

    let corridor_cells = owner.iter().filter(|&&o| o == -2).count() as i32;
    let floor_cells = owner.iter().filter(|&&o| o != -1).count() as i32;

    let mut areas: Vec<i32> = real
        .iter()
        .map(|r| {
            let f = r.floor_rect;
            ((f[2] - f[0]) * (f[3] - f[1])) as i32
        })
        .collect();
    let bad_aspect = real
        .iter()
        .filter(|r| {
            let f = r.floor_rect;
            let (rw, rh) = (f[2] - f[0], f[3] - f[1]);
            let (lo, hi) = (rw.min(rh), rw.max(rh));
            lo > 0.0 && hi / lo > 3.0
        })
        .count();
    areas.sort_unstable();
    let (amin, amax) = (*areas.first().unwrap_or(&0), *areas.last().unwrap_or(&0));
    let amed = areas.get(areas.len() / 2).copied().unwrap_or(0);
    let mean = if areas.is_empty() { 0.0 } else { areas.iter().sum::<i32>() as f32 / areas.len() as f32 };
    let var = if areas.is_empty() { 0.0 } else { areas.iter().map(|&a| (a as f32 - mean).powi(2)).sum::<f32>() / areas.len() as f32 };
    let cv = if mean > 0.0 { var.sqrt() / mean } else { 0.0 };

    // through-room metric: which rooms touch a corridor cell (4-neighbour)?
    // Then BFS the room-adjacency graph from the entry; a room is "through-room"
    // if EVERY shortest path from the entry to it would require passing through
    // another room (i.e. it is not corridor-served and not the entry). We
    // approximate: a room is well-served if it is corridor-adjacent OR is the
    // entry room. through_room = rooms neither corridor-adjacent nor entry.
    let mut corridor_served = vec![false; real.len()];
    for z in 0..h {
        for x in 0..w {
            if owner[idx(x, z)] != -2 {
                continue;
            }
            for (dx, dz) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                let (nx, nz) = (x + dx, z + dz);
                if nx >= 0 && nx < w && nz >= 0 && nz < h {
                    let o = owner[idx(nx, nz)];
                    if o >= 0 {
                        corridor_served[o as usize] = true;
                    }
                }
            }
        }
    }
    // entry room: the one containing the player start
    let (sx, sz) = (spec.player_start.x as i32, spec.player_start.z as i32);
    let entry = if sx >= 0 && sx < w && sz >= 0 && sz < h { owner[idx(sx, sz)] } else { -1 };
    let through_room_rooms = (0..real.len()).filter(|&i| !corridor_served[i] && i as i32 != entry).count();

    Metrics {
        rooms: real.len(),
        corridor_cells,
        corridor_pct: if floor_cells > 0 { 100.0 * corridor_cells as f32 / floor_cells as f32 } else { 0.0 },
        area_min: amin,
        area_med: amed,
        area_max: amax,
        area_cv: cv,
        bad_aspect,
        through_room_rooms,
        doors: spec.doors.len(),
    }
}

// ------------------------------------------------------------ generators ---
// Filled in after the research synthesis lands. Each: fn(u64) -> LevelSpec.

include!("../plans_techniques.rs");

// ----------------------------------------------------------------- main ---

type Gen = (&'static str, fn(u64) -> LevelSpec);

fn main() {
    let mut a = std::env::args().skip(1);
    let out_dir = a.next().unwrap_or_else(|| "/tmp/floorplans".into());
    let count: u64 = a.next().and_then(|s| s.parse().ok()).unwrap_or(6);
    let seed0: u64 = a.next().and_then(|s| s.parse().ok()).unwrap_or(1);

    std::fs::create_dir_all(&out_dir).expect("create out_dir");

    let gens: Vec<Gen> = techniques();

    for (name, g) in &gens {
        let dir = format!("{out_dir}/{name}");
        std::fs::create_dir_all(&dir).expect("create technique dir");
        let mut tiles = Vec::new();
        println!("\n== {name} ==");
        for k in 0..count {
            let seed = seed0 + k;
            let spec = g(seed);
            let m = metrics(&spec);
            let b = spec.floor_bounds();
            let (gw, gh) = (b[2] as i32, b[3] as i32);
            let header = format!("{} S{seed} R{} CORR{:.0}% THRU{}", name.to_uppercase(), m.rooms, m.corridor_pct, m.through_room_rooms);
            let canvas = mapviz::render(&spec, gw, gh, &header, &[]);
            canvas.write_png(&format!("{dir}/s{seed:03}.png"));
            tiles.push(canvas);
            println!(
                "  seed={seed} {gw}x{gh} rooms={} doors={} corr={:.0}% area[min/med/max]={}/{}/{} cv={:.2} badAR={} through_room={}",
                m.rooms, m.doors, m.corridor_pct, m.area_min, m.area_med, m.area_max, m.area_cv, m.bad_aspect, m.through_room_rooms
            );
        }
        let mon = mapviz::montage(&tiles, 3, 14);
        mon.write_png(&format!("{out_dir}/montage_{name}.png"));
        eprintln!("wrote {out_dir}/montage_{name}.png");
    }
}
