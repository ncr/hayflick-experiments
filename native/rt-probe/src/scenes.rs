//! Scene builders — the content side of the probe. Three scenes:
//!
//! - `grid`  — native rematch of the web `experiments/grid-walker` GameModule
//! - `lab`   — minimal synthetic isolation scene for renderer debugging
//! - `house` — Fallout-flavoured three-room example house (the default)

use crate::config::Config;
use crate::scene::{hex_linear, CachedModel, Scene};
use glam::{Mat4, Vec3};

pub fn build_scene(cfg: &Config) -> Result<Scene, Box<dyn std::error::Error>> {
    match cfg.scene.as_str() {
        "grid" => build_grid_walker(),
        "lab" => build_lab(),
        "house" => build_house(cfg),
        other => Err(format!("unknown SCENE={other} (house | lab | grid)").into()),
    }
}

/// Native rematch of `experiments/grid-walker` — the smallest web GameModule:
/// a 20×20-tile floor (0x1f2329) with GridHelper tile lines (centre 0x6a6558,
/// rest 0x3a3d44) and a 1-wu orange box (0xd97706, anchor bottom) at the
/// origin, driven by arrows/WASD. The web version uses the engine's OPEN level
/// (nothing blocks), a FIXED camera, and snaps the box mesh to the screen-pixel
/// lattice each frame — the viewer mirrors all three when SCENE=grid.
pub fn build_grid_walker() -> Result<Scene, Box<dyn std::error::Error>> {
    let mut scene = Scene::new();
    let size = 20.0; // wu = tiles (1 tile = 1 wu = 1.28 m)
    let half = size * 0.5;
    scene.add_floor(-half, half, -half, half, 0.0, hex_linear(0x1f2329));
    // GridHelper(20, 20, 0x6a6558, 0x3a3d44) at y = 0.001, lines ~1 lowpixel wide
    scene.add_ground_grid(size, 20, 0.001, 1.0 / 32.0, hex_linear(0x6a6558), hex_linear(0x3a3d44));
    scene.recompute_bounds();
    // grid-walker runs on the engine's open level: nothing ever blocks.
    scene.floor_rect = [-1e30, -1e30, 1e30, 1e30];
    scene.solids = Vec::new();
    // spawnBox({ size: 1, color: 0xd97706, anchor: "bottom" }) at (0, 0)
    let pidx = scene.add_box_local(0.5, 1.0, 0.5, hex_linear(0xd97706), [0.0; 4]);
    scene.dynamic_prim = Some(pidx);
    scene.player_start = Vec3::ZERO;
    Ok(scene)
}

/// Minimal synthetic isolation scene (SCENE=lab) — small enough to reason
/// about every pixel: an 8×8 flat floor, three matte boxes of distinct colour
/// and height (hard silhouettes + shadow edges), one isotropic emissive lamp
/// pillar and one directional emissive "screen" slab (both NEE light shapes),
/// moderate sun + sky, NO fog, NO textures, NO dollhouse masks, no player
/// (q/e orbits, WASD pans — same camera paths as the house). Anything that
/// flickers here is the renderer, not the content.
pub fn build_lab() -> Result<Scene, Box<dyn std::error::Error>> {
    let mut scene = Scene::new();
    scene.add_floor(-4.0, 4.0, -4.0, 4.0, 0.0, [0.45, 0.44, 0.42, 1.0]);
    // three matte boxes: tall blue, mid red, low broad green slab
    scene.add_box_world(Vec3::new(-1.5, 0.0, -1.5), Vec3::new(-0.5, 2.0, -0.5), [0.20, 0.30, 0.75, 1.0], [0.0; 4], 0.9, 0.0);
    scene.add_box_world(Vec3::new(0.75, 0.0, 0.25), Vec3::new(1.75, 1.0, 1.25), [0.75, 0.22, 0.18, 1.0], [0.0; 4], 0.9, 0.0);
    scene.add_box_world(Vec3::new(-1.0, 0.0, 1.5), Vec3::new(1.0, 0.25, 2.5), [0.25, 0.62, 0.28, 1.0], [0.0; 4], 0.9, 0.0);
    // isotropic NEE lamp: warm pillar near a corner (closed box -> isotropic)
    scene.add_box_world(Vec3::new(2.4, 0.0, -2.6), Vec3::new(2.6, 0.8, -2.4), [1.0, 0.8, 0.5, 1.0], [8.0, 5.6, 2.4, 1.0], 0.4, 0.0);
    scene.name_light("lab_lamp", scene.primitives.len() - 1);
    // directional NEE screen: thin teal slab facing +Z (authored facing) — the
    // exact shape the house terminal screens use, minus everything else
    scene.add_box_world(Vec3::new(-2.6, 0.4, -2.0), Vec3::new(-2.2, 1.0, -1.97), [0.1, 0.3, 0.25, 1.0], [3.0, 12.0, 9.6, 1.0], 0.8, 0.0);
    let slab = scene.primitives.len() - 1;
    scene.name_light("lab_screen", slab);
    scene.mark_screen(slab); // device: ignores the wall switch, constant in both probe banks
    scene.prim_light_dir.resize(scene.primitives.len(), [0.0; 3]);
    *scene.prim_light_dir.last_mut().unwrap() = [0.0, 0.0, 1.0];
    scene.recompute_bounds();
    scene.floor_rect = [-3.7, -3.7, 3.7, 3.7];
    scene.solids = Vec::new();
    scene.dynamic_prim = None; // no player — WASD pans, q/e orbits (house camera)
    scene.player_start = Vec3::ZERO; // camera target seed
    scene.lighting = [0.6, 0.5, 0.0, 1.0]; // gentle sun + sky, NO fog
    Ok(scene)
}

/// Fallout-flavoured example house assembled from the blockstudio tile kits
/// (`desert_sandstone` wall kit + `ground_tiles` floors), following
/// `docs/blockstudio/game-consumer-contract.md`: 1 glTF unit = 1 cell = 1 wu;
/// floors at cell centres, walls at edge midpoints (rotate 90° for Z-runs),
/// corners at vertices (canonical legs +X/-Z, one cell long — adjacent wall
/// segments are skipped). Three rooms (common room, lab, storage), doors +
/// windows, forge props inside, grass/asphalt yard with a road outside.
/// Perimeter walls carry `prim_hide_mask` outward tags so the viewer can hide
/// the camera-near sides per quarter-turn (Q/E).
pub fn build_house(cfg: &Config) -> Result<Scene, Box<dyn std::error::Error>> {
    use std::f32::consts::{FRAC_PI_2, PI};
    let mut scene = Scene::new();
    let tiles = "assets/tilesets/desert_sandstone/artifacts/tiles";
    let ground = "assets/tilesets/ground_tiles/artifacts/tiles";
    let wall = scene.preload(&format!("{tiles}/wall/wall.glb"))?;
    let door = scene.preload(&format!("{tiles}/door/door.glb"))?;
    let win = scene.preload(&format!("{tiles}/window_middle/window_middle.glb"))?;
    let corner = scene.preload(&format!("{tiles}/corner/corner.glb"))?;
    let concrete = scene.preload(&format!("{ground}/concrete_walk/concrete_walk.glb"))?;
    let grass = scene.preload(&format!("{ground}/grass/grass.glb"))?;
    let asphalt = scene.preload(&format!("{ground}/asphalt/asphalt.glb"))?;
    let sandstone = scene.preload(&format!("{ground}/sandstone/sandstone.glb"))?;

    // House footprint: cells [0,14) x [0,10). Interior walls split off a lab
    // (x>=8, z<5) and a storage room (x>=8, z>=5) from the common room.
    const FLOOR_TOP: f32 = 6.0 / 128.0; // ground tiles are 6 cm thick

    // ---- floors: concrete inside; grass yard, asphalt road, sandstone path
    for gx in -3..17 {
        for gz in -3..13 {
            let inside = (0..14).contains(&gx) && (0..10).contains(&gz);
            let cm = if inside {
                &concrete
            } else if gz >= 11 {
                &asphalt // the road along the south side
            } else if gx == 4 && gz == 10 {
                &sandstone // door step path
            } else {
                &grass
            };
            scene.place(cm, Mat4::from_translation(Vec3::new(gx as f32 + 0.5, 0.0, gz as f32 + 0.5)));
        }
    }

    let rot_q = |q: i32| Mat4::from_rotation_y(q as f32 * FRAC_PI_2);
    // ---- perimeter walls (tagged with their outward direction for the
    // per-yaw dollhouse hide). Corner legs are one cell long, so each edge run
    // starts at 1 and ends at len-1.
    for x in 1..13 {
        // north edge (z=0), outward -Z (bit3)
        let cm = if [3, 6, 10].contains(&x) { &win } else { &wall };
        let first = scene.place(cm, Mat4::from_translation(Vec3::new(x as f32 + 0.5, 0.0, 0.0)));
        scene.tag_hide(first, 0b1000);
        // south edge (z=10), outward +Z (bit1); main door at x=4
        let cm = if x == 4 { &door } else if [8, 11].contains(&x) { &win } else { &wall };
        let t = Mat4::from_translation(Vec3::new(x as f32 + 0.5, 0.0, 10.0)) * Mat4::from_rotation_y(PI);
        let first = scene.place(cm, t);
        scene.tag_hide(first, 0b0010);
    }
    for z in 1..9 {
        // west edge (x=0), outward -X (bit2)
        let cm = if z == 4 { &win } else { &wall };
        let t = Mat4::from_translation(Vec3::new(0.0, 0.0, z as f32 + 0.5)) * rot_q(1);
        let first = scene.place(cm, t);
        scene.tag_hide(first, 0b0100);
        // east edge (x=14), outward +X (bit0)
        let cm = if [2, 7].contains(&z) { &win } else { &wall };
        let t = Mat4::from_translation(Vec3::new(14.0, 0.0, z as f32 + 0.5)) * rot_q(1);
        let first = scene.place(cm, t);
        scene.tag_hide(first, 0b0001);
    }
    // perimeter corners: (vertex, quarter-turns, outward bits of both sides)
    for (vx, vz, q, bits) in [(0, 0, 3, 0b1100u8), (14, 0, 2, 0b1001), (14, 10, 1, 0b0011), (0, 10, 0, 0b0110)] {
        let t = Mat4::from_translation(Vec3::new(vx as f32, 0.0, vz as f32)) * rot_q(q);
        let first = scene.place(&corner, t);
        scene.tag_hide(first, bits);
    }

    // ---- interior walls (never hidden; rotate with Q/E to see past them)
    for z in 0..10 {
        // x=8 divider, doors into the lab (z=2) and storage (z=7)
        let cm = if z == 2 || z == 7 { &door } else { &wall };
        scene.place(cm, Mat4::from_translation(Vec3::new(8.0, 0.0, z as f32 + 0.5)) * rot_q(1));
    }
    for x in 8..14 {
        // z=5 divider between lab and storage, door at x=11
        let cm = if x == 11 { &door } else { &wall };
        scene.place(cm, Mat4::from_translation(Vec3::new(x as f32 + 0.5, 0.0, 5.0)));
    }

    // ---- props (forge catalogue), scaled to real-world heights (1 wu = 1.28 m)
    const PLAYER_R: f32 = 0.18;
    let mut solids: Vec<[f32; 4]> = Vec::new();
    let mut prop_cache: std::collections::HashMap<&str, CachedModel> = Default::default();
    let props: &[(&str, f32, f32, f32, f32, f32)] = &[
        // (prop id, target height wu, x, height above floor, z, rotation deg)
        ("mainframe-with-many-distinct-status-lights", 1.40, 2.0, 0.0, 1.1, 180.0),
        // on the desk, screen toward the chair. The model's painted CRT screen
        // is the dark texture patch on its +X face (NOT the slanted cream
        // face, which is styling over a sealed internal cavity) — rot -90 maps
        // model +X -> world +Z.
        ("commodore-pet-inspired-computer", 0.45, 3.0, 0.62, 3.2, -90.0),
        ("large-desk-without-drawers", 0.62, 3.0, 0.0, 3.2, 0.0),
        ("professional-workbench-chair", 0.75, 3.0, 0.0, 4.2, 180.0),
        ("eames-style-chair-but-in-our-scifi-style", 0.68, 6.2, 0.0, 7.6, -45.0),
        ("tall-standing-lamp", 1.35, 7.2, 0.0, 0.9, 0.0),
        ("braun-inspired-desk", 0.60, 10.5, 0.0, 1.3, 0.0),
        ("microscope", 0.35, 9.3, 0.6, 1.4, 30.0),
        ("chemical-flask", 0.22, 11.9, 0.6, 1.5, 0.0),
        ("professional-workbench-chair", 0.75, 10.5, 0.0, 2.3, 180.0),
        ("mainframe-with-many-distinct-status-lights", 1.40, 13.1, 0.0, 2.5, 270.0),
        ("ammo-crate", 0.40, 9.3, 0.0, 8.7, 10.0),
        ("ammo-crate", 0.40, 10.3, 0.0, 8.6, 35.0),
        ("ammo-crate", 0.40, 9.7, 0.0, 7.8, 75.0),
        ("tall-standing-lamp", 1.35, 13.2, 0.0, 9.1, 0.0),
        ("stop-sign", 1.70, 16.2, 0.0, 10.6, 200.0),
        ("ammo-crate", 0.40, -1.4, 0.0, 5.2, 50.0),
    ];
    let mut pet_prim: Option<usize> = None;
    for &(id, target_h, x, y_off, z, rot_deg) in props {
        let path = format!("assets/forge/props/{id}/processed/model.glb");
        if !prop_cache.contains_key(id) {
            match scene.preload(&path) {
                Ok(cm) => {
                    prop_cache.insert(id, cm);
                }
                Err(e) => {
                    eprintln!("skip prop {id}: {e}");
                    continue;
                }
            }
        }
        let cm = &prop_cache[id];
        let (pmin, pmax) = cm.bounds();
        let pc = (pmin + pmax) * 0.5;
        let s = target_h / (pmax.y - pmin.y).max(1e-4);
        let t = Mat4::from_translation(Vec3::new(x, FLOOR_TOP + y_off, z))
            * Mat4::from_rotation_y(rot_deg.to_radians())
            * Mat4::from_scale(Vec3::splat(s))
            * Mat4::from_translation(Vec3::new(-pc.x, -pmin.y, -pc.z));
        let first = scene.place(cm, t);
        if id == "commodore-pet-inspired-computer" {
            pet_prim = Some(first);
        }
        // floor-standing props block the player; tabletop items don't
        if y_off == 0.0 {
            let r = s * (pmax.x - pmin.x).max(pmax.z - pmin.z) * 0.5 + PLAYER_R;
            solids.push([x - r, z - r, x + r, z + r]);
        }
    }

    // ---- emissive practicals: with the sun dimmed (lighting below) these
    // carry the interiors. The renderer treats emissive boxes as real area
    // lights — warm pools + colored bounce for free. Sizes stay on the 0.0625
    // wu lattice (invariant #8). Walls are ±0.125 wu thick, so sconces sit at
    // 0.156 off the wall line (proud of the inner face).
    // cfg.render.emit scales all practicals (tuning knob, default 1)
    // Every practical is NAMED (name_light / name_point_light): the viewer's
    // adapter mirrors them into the game's LevelSpec, and house-game's
    // light_system authors their per-tick emission (flicker curves live
    // there now). An unnamed light would freeze at base — the adapter
    // asserts full name coverage instead of letting that slip.
    let emit = cfg.render.emit;
    let warm = move |s: f32| [1.0 * s * emit, 0.64 * s * emit, 0.30 * s * emit, 1.0];
    let mut bulb = |name: &str, p: Vec3, half: f32, e: [f32; 4]| {
        scene.add_box_world(p - Vec3::splat(half), p + Vec3::splat(half), [1.0, 0.95, 0.85, 1.0], e, 0.6, 0.0);
        scene.name_light(name, scene.primitives.len() - 1);
    };
    // heads of the two tall-standing-lamp props (1.35 wu tall)
    bulb("lamp_floor_w", Vec3::new(7.2, 1.125, 0.9), 0.0625, warm(150.0));
    bulb("lamp_floor_e", Vec3::new(13.2, 1.125, 9.1), 0.0625, warm(150.0));
    // ceiling lights: the main interior lights (no sun — interiors are
    // lamp-lit). CONCEPTUAL emitters: no fixture geometry is rendered (there
    // is no ceiling to mount one on) — they exist only in the NEE light list,
    // so rooms get lit from above with nothing floating in view.
    let ceiling_lamps = [(2.5f32, 2.5f32), (5.0, 7.0), (11.0, 2.5), (11.0, 7.5)];
    for (i, (x, z)) in ceiling_lamps.into_iter().enumerate() {
        let c = warm(80.0);
        scene.point_lights.push([x, 2.0, z, 0.25, c[0], c[1], c[2], 0.0]);
        scene.name_point_light(&format!("ceiling_{i}"), scene.point_lights.len() - 1);
    }
    // wall sconces: (center, which axis is the wall normal)
    let sconces: &[(f32, f32, f32, bool)] = &[
        (2.5, 1.625, 0.156, false),  // common room, north wall
        (0.156, 1.625, 6.5, true),   // common room, west wall
        (6.5, 1.625, 9.844, false),  // common room, south wall
        (9.5, 1.625, 0.156, false),  // lab, north wall
        (12.5, 1.625, 4.844, false), // lab, divider wall
        (4.5, 1.875, 10.156, false), // porch light over the front door
    ];
    for (si, &(x, y, z, x_normal)) in sconces.iter().enumerate() {
        let (hx, hz) = if x_normal { (0.03125, 0.09375) } else { (0.09375, 0.03125) };
        let (min, max) = (Vec3::new(x - hx, y - 0.0625, z - hz), Vec3::new(x + hx, y + 0.0625, z + hz));
        scene.add_box_world(min, max, [1.0, 0.9, 0.75, 1.0], warm(90.0), 0.7, 0.0);
        scene.name_light(&format!("sconce_{si}"), scene.primitives.len() - 1);
    }
    // status-light glow strips on the two mainframes (teal, faint) — placed
    // just proud of each prop's front face, sized from the cached bounds
    if let Some(cm) = prop_cache.get("mainframe-with-many-distinct-status-lights") {
        let (pmin, pmax) = cm.bounds();
        let teal = [0.25 * 12.0 * emit, 1.0 * 12.0 * emit, 0.8 * 12.0 * emit, 1.0];
        let s = 1.40 / (pmax.y - pmin.y).max(1e-4);
        let half_d = (pmax.z - pmin.z) * 0.5 * s;
        // (2.0, 1.1) rot 180 -> front faces +Z
        let f = 1.1 + half_d + 0.03;
        scene.add_box_world(Vec3::new(1.875, 0.5625, f), Vec3::new(2.125, 0.9375, f + 0.03), [0.1, 0.3, 0.25, 1.0], teal, 0.8, 0.0);
        let glow = scene.primitives.len() - 1;
        scene.name_light("mainframe_glow_w", glow);
        scene.mark_screen(glow); // device glow: ignores the wall switch
        scene.prim_light_dir.resize(scene.primitives.len(), [0.0; 3]);
        *scene.prim_light_dir.last_mut().unwrap() = [0.0, 0.0, 1.0]; // screen emits forward (+Z), not through the desk
        // (13.1, 2.5) rot 270 -> front faces -X (depth becomes the x extent)
        let f = 13.1 - half_d - 0.06;
        scene.add_box_world(Vec3::new(f, 0.5625, 2.375), Vec3::new(f + 0.03, 0.9375, 2.625), [0.1, 0.3, 0.25, 1.0], teal, 0.8, 0.0);
        let glow = scene.primitives.len() - 1;
        scene.name_light("mainframe_glow_e", glow);
        scene.mark_screen(glow);
        scene.prim_light_dir.resize(scene.primitives.len(), [0.0; 3]);
        *scene.prim_light_dir.last_mut().unwrap() = [-1.0, 0.0, 0.0]; // screen emits forward (-X)
    }
    // PET computer screen: make the ACTUAL screen surface emissive — the dark
    // texture patch the model paints as its CRT (on model +X, world +Z after
    // the rot above). Texture-keyed: that patch is the only dark region on
    // the +Z face (the case is cream). Carving it gives NEE a directional
    // light at the true screen surface; the animator pulses it (green ->
    // screen kind). Re-measure with PET_DUMP=1 if the prop moves.
    if let Some(pp) = pet_prim {
        if cfg.render.pet_dump {
            scene.dump_tris_csv(pp, "/tmp/pet_tris.csv");
        }
        let g = 8.0 * emit;
        let carved = scene.carve_emissive_region(
            pp,
            Vec3::Z,
            Vec3::new(2.70, 0.80, 2.90),
            Vec3::new(3.30, 1.12, 3.50),
            0.45, // dark texels only: the painted CRT glass
            [0.35 * g, 1.0 * g, 0.45 * g, 1.0],
            false,
        );
        match carved {
            Some(np) => {
                scene.name_light("pet_screen", np);
                scene.mark_screen(np); // CRT: pulses on its own, never the wall switch
                let p = &scene.primitives[np];
                let (mut lo, mut hi) = (Vec3::splat(f32::MAX), Vec3::splat(f32::MIN));
                for &i in &scene.indices[p.index_offset as usize..(p.index_offset + p.index_count) as usize] {
                    let v = Vec3::from(scene.vertices[p.vertex_offset as usize + i as usize].pos);
                    lo = lo.min(v);
                    hi = hi.max(v);
                }
                println!("PET screen carve: {} tris, aabb {:.3?}..{:.3?}", p.index_count / 3, lo, hi);
            }
            None => eprintln!("PET screen carve matched no triangles"),
        }
    }

    // ---- player collision: interior dividers + perimeter (door gaps open).
    // Inflate by wall half-thickness (0.125) + the player radius.
    let w = 0.125 + PLAYER_R;
    for (z0, z1) in [(0.0, 2.0), (3.0, 7.0), (8.0, 10.0)] {
        solids.push([8.0 - w, z0, 8.0 + w, z1]); // x=8 divider (doors at z=2, z=7)
    }
    for (x0, x1) in [(8.0, 11.0), (12.0, 14.0)] {
        solids.push([x0, 5.0 - w, x1, 5.0 + w]); // z=5 divider (door at x=11)
    }
    solids.push([0.0, -w, 14.0, w]); // north perimeter
    solids.push([0.0, 10.0 - w, 4.0, 10.0 + w]); // south, west of the front door
    solids.push([5.0, 10.0 - w, 14.0, 10.0 + w]); // south, east of the front door
    solids.push([-w, 0.0, w, 10.0]); // west
    solids.push([14.0 - w, 0.0, 14.0 + w, 10.0]); // east

    scene.recompute_bounds(); // bounds = world WITHOUT the movable player
    // placeholder player: a matte light-grey pillar (lattice-aligned footprint)
    // — neutral albedo shows the coloured light pools and the AO grounding
    let pidx = scene.add_box_local(0.1875, 1.3, 0.1875, [0.62, 0.64, 0.70, 1.0], [0.0; 4]);
    scene.prim_hide_mask.resize(scene.primitives.len(), 0);
    scene.floor_rect = [-2.7, -2.7, 16.7, 12.7]; // full grounds; walls are solids
    scene.solids = solids;
    scene.dynamic_prim = Some(pidx);
    scene.player_start = Vec3::new(4.0, FLOOR_TOP, 6.0); // common room
    // night mood: NO sun — interiors are entirely lamp-lit (ceiling lamps +
    // sconces + practicals); a faint sky fill keeps the yard readable and a
    // knee-deep ground mist sits outside. SUN/SKY/FOG/FOG_H override for tuning.
    scene.lighting = [0.0, 0.45, 0.3, 0.6];
    Ok(scene)
}
