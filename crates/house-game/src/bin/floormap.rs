//! floormap — render top-down PNGs of the building-floor generators
//! ([`house_game::building`]) so the realistic floor-plan layouts can be assessed
//! by eye. Sibling to `roommap` (the cave generator's map tool); both share the
//! `mapviz` renderer.
//!
//! Usage: `cargo run -p house-game --bin floormap -- <out_dir> [count=6] [kind=hospital] [seed0=1]`
//! `kind` is `hospital`, `office`, `house`, or `factory`.

use house_game::{building_floor, factory_floor, house_floor, mapviz, BuildingParams, LevelSpec, CORRIDOR_ROOM_ID_BASE};

fn gen(kind: &str, seed: u64) -> LevelSpec {
    match kind {
        "office" => building_floor(seed, BuildingParams::office()),
        "house" => house_floor(seed),
        "factory" => factory_floor(seed),
        _ => building_floor(seed, BuildingParams::hospital()),
    }
}

fn main() {
    let mut a = std::env::args().skip(1);
    let out_dir = a.next().unwrap_or_else(|| "/tmp/floormaps".into());
    let count: u64 = a.next().and_then(|s| s.parse().ok()).unwrap_or(6);
    let kind = a.next().unwrap_or_else(|| "hospital".into());
    let seed0: u64 = a.next().and_then(|s| s.parse().ok()).unwrap_or(1);

    std::fs::create_dir_all(&out_dir).expect("create out_dir");

    let mut tiles = Vec::new();
    for k in 0..count {
        let seed = seed0 + k;
        let spec = gen(&kind, seed);
        let b = spec.floor_bounds();
        let (gw, gh) = (b[2] as i32, b[3] as i32);

        let rooms: Vec<i32> = spec
            .rooms
            .iter()
            .filter(|r| r.id.0 < CORRIDOR_ROOM_ID_BASE)
            .map(|r| {
                let f = r.floor_rect;
                ((f[2] - f[0]) * (f[3] - f[1])) as i32
            })
            .collect();
        let (amin, amax) = (*rooms.iter().min().unwrap(), *rooms.iter().max().unwrap());
        let amean = rooms.iter().sum::<i32>() as f32 / rooms.len() as f32;

        let header = format!("{} FLOOR  SEED {seed}  ROOMS {}  DOORS {}", kind.to_uppercase(), rooms.len(), spec.doors.len());
        let canvas = mapviz::render(&spec, gw, gh, &header, &[]);
        let path = format!("{out_dir}/floor_{kind}_s{seed:03}.png");
        canvas.write_png(&path);
        tiles.push(canvas);

        println!("seed={seed} kind={kind} footprint={gw}x{gh} rooms={} doors={} room_area[min/mean/max]={amin}/{amean:.0}/{amax}", rooms.len(), spec.doors.len());
        eprintln!("  wrote {path}");
    }

    let mon = mapviz::montage(&tiles, 2, 14);
    let mpath = format!("{out_dir}/montage_{kind}.png");
    mon.write_png(&mpath);
    eprintln!("wrote montage {mpath} ({}x{})", mon.w, mon.h);
}
