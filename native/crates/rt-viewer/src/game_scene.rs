//! The SCENE=game greybox builder (ARCHITECTURE.md step 11): compose an
//! `rt_probe::Scene` straight from a `house_game::LevelSpec`. ONE source of
//! truth — the same spec drives collision (house-game) and visuals (here), so
//! the hand-synced solids-vs-walls duplication that the house scene carries is
//! gone.
//!
//! OWNER DIRECTIVE — greybox visuals: walls / floors / door leaves are
//! NICELY COLORED boxes (no textured tile GLBs), at dimensions identical to
//! the desert_sandstone wall kit they replace (1 cell = 1.0 wu, wallThickness
//! 32 cm = 0.25 wu, wallHeight 280 cm = 2.1875 wu, floorThickness 6 cm; every
//! XZ dim a multiple of 0.0625 wu). Forge props stay textured (not used here
//! yet — the greybox house furnishes with simple boxes for now).
//!
//! Lights: every spec light becomes a NAMED emissive box (in spec order, so
//! the NEE slot order equals the spec / flicker index — `mirror_game_lights`
//! asserts that join). The Screen device is `mark_screen`'d (constant in both
//! probe banks). Drift/Incandescent are identical to the renderer (kind drives
//! game-side flicker only), so all six stay emissive prims and the slot order
//! never reshuffles into the point-light tail.

use glam::{Mat4, Vec3};
use house_game::{DoorSpec, LevelSpec, LightKind, LightSpec, TargetSpec};
use rt_probe::{hex_linear, Config, Scene};

/// Greybox wall height — the kit wallHeight (280 cm = 2.1875 wu). Distinct
/// from the hitscan occluder band (`house_game::game::WALL_H` = 2.56) — the
/// visual wall can be shorter than the shoot band without changing gameplay.
pub const WALL_TOP: f32 = 2.1875;
/// Door leaf height — the kit door height (220 cm = 1.71875 wu).
pub const DOOR_LEAF_H: f32 = 1.71875;
/// Wall half-thickness (kit 32 cm = 0.25 wu wall).
const WALL_HT: f32 = 0.125;
/// Floor slab top (kit floorThickness 6 cm).
const FLOOR_TOP: f32 = 6.0 / 128.0;

/// Bright flat-design greybox palette (sRGB hex, linearized by `hex_linear`),
/// Monument-Valley style. Each of the 5 rooms (A/B/C/D/E in spec order =
/// FLOOR_TINTS[0..4]) gets a distinct HIGH-VALUE pastel hue — mint, periwinkle,
/// blush, pale-gold, aqua — for instant room readability. Walls are near-white
/// neutrals (perimeter warm-white, inner cool-white) so they read as crisp
/// separators clearly lighter than every floor. The player pillar stays neutral
/// grey. The coral door + bright-red-on-near-white target are the two saturated
/// accents that pop off the white walls. Reads clean at LIGHTS=1 EMIT=1 once
/// the level lamps are raised (~4x) — see `place_light` + spec `game_level()`.
const FLOOR_TINTS: [u32; 5] = [
    0xbdf2da, // A — mint
    0xccd4fb, // B — periwinkle
    0xfcd4e0, // C — blush (nudged brighter/pinker per judge: stays clean pastel, not dusty)
    0xfbe9b6, // D — pale-gold
    0xb8f0f1, // E — aqua
];
const WALL_PERIM: u32 = 0xfbf6ec; // warm near-white perimeter
const WALL_INNER: u32 = 0xeef0f6; // cool near-white interior dividers
const FURNITURE: u32 = 0xe39a6b; // soft terracotta crate / prop greybox
const DOOR_COLOR: u32 = 0xff7a4d; // saturated coral door leaf
const TARGET_COLOR: u32 = 0xe83b46; // bright clean red disc face
const TARGET_RING: u32 = 0xfdfaf2; // crisp near-white backing plate
/// Cave walls: a single clean Greek-island stone white (the owner's call —
/// "a regular wall can be just white"), no warm/cool split. Pastel room floors
/// stay; the white walls read as crisp separators around every chamber.
const WALL_STONE: u32 = 0xf6f2e8;
/// Cave corridor floor — a neutral pale stone, distinct from the coloured
/// rooms so the connectors read as connectors, not chambers.
const CORRIDOR_FLOOR: u32 = 0xd8d4cc;

/// Scenes that render with GENERATED walls (one slab per region boundary, with
/// dollhouse cut-aways) rather than the authored rectangular auto-perimeter:
/// the procedural cave, the hand-authored village, and every floor-plan-derived
/// level (home / hospital / office / factory, via `floorplan::enclose`). Future
/// generated scenes join here.
pub fn is_dollhouse(scene: &str) -> bool {
    matches!(scene, "cave" | "village" | "home" | "hospital" | "office" | "factory")
}

/// Build the greybox game scene from the spec. Returns the scene; the caller
/// (renderer) bakes probes and constructs the GameLoop over the SAME spec.
pub fn build_game(spec: &LevelSpec, cfg: &Config) -> Scene {
    let mut scene = Scene::new();
    let f = spec.floor_bounds();
    // The procedural cave AND the hand-authored village provide their OWN
    // generated boundary walls (one slab per floor↔void edge, with dollhouse
    // cut-away metadata), so the rectangular auto-perimeter below is skipped and
    // they get the clean stone-white wall palette. The authored house (`game`)
    // keeps its near-white walls + enclosing perimeter. `dollhouse` gates the
    // shared generated-wall path; the village then takes a brighter daylit mood
    // (see `scene.lighting` below) since it is an open street, not a dungeon.
    let dollhouse = is_dollhouse(&cfg.scene);
    let wall_hex = if dollhouse { WALL_STONE } else { WALL_INNER };

    // ---- floors: one quad per room in its own pastel tint (cave corridors get
    // the neutral stone tint); the room order is the spec order so the palette
    // reads stable. Keyed off `RoomId` so cave corridor ids select CORRIDOR_FLOOR.
    for r in spec.rooms.iter() {
        let c = if r.id.0 >= house_game::CORRIDOR_ROOM_ID_BASE { CORRIDOR_FLOOR } else { FLOOR_TINTS[(r.id.0 as usize) % FLOOR_TINTS.len()] };
        scene.add_floor(r.floor_rect[0], r.floor_rect[2], r.floor_rect[1], r.floor_rect[3], FLOOR_TOP, hex_linear(c));
    }

    // ---- perimeter walls: four slabs around the footprint, WALL_TOP tall,
    // 0.25 wu thick, sitting just OUTSIDE the walkable floor rect (the inner
    // face on the rect edge). Tagged with their outward direction so the
    // dollhouse cull hides the camera-near sides per quarter-turn (Q/E). The
    // cave skips this — its generated wall slabs already enclose every region.
    let t = WALL_HT * 2.0;
    if !dollhouse {
        let perim: [([f32; 4], u8); 4] = [
            ([f[0] - t, f[1] - t, f[0], f[3] + t], 0b0100), // west wall, outward -X
            ([f[2], f[1] - t, f[2] + t, f[3] + t], 0b0001), // east wall, outward +X
            ([f[0] - t, f[1] - t, f[2] + t, f[1]], 0b1000), // north wall, outward -Z
            ([f[0] - t, f[3], f[2] + t, f[3] + t], 0b0010), // south wall, outward +Z
        ];
        for (rect, bits) in perim {
            let first = box_world(&mut scene, rect, WALL_TOP, WALL_PERIM);
            scene.tag_hide(first, bits);
        }
    }

    // ---- interior structure. Authored house: each static solid is a wall
    // (thin: one XZ dim == the wall thickness) or furniture (the free-standing
    // crate, a low box). Cave: EVERY solid is a wall — a thin boundary slab or a
    // full 1×1 rock block — rendered full height and tagged with its
    // layout-derived outward direction so the dollhouse cull lets the iso camera
    // see into every chamber.
    for s in &spec.static_solids {
        let (w, d) = (s[2] - s[0], s[3] - s[1]);
        if !dollhouse {
            if w.min(d) <= t + 1e-3 {
                box_world(&mut scene, *s, WALL_TOP, wall_hex);
            } else {
                box_world(&mut scene, *s, 0.6, FURNITURE); // crate-height greybox
            }
            continue;
        }
        let bits = if w.min(d) >= 0.9 { rock_block_bits(s, spec) } else { wall_outward_bits(s, spec) };
        let first = box_world(&mut scene, *s, WALL_TOP, wall_hex);
        if bits != 0 {
            // full wall: hide when its side faces the camera. Tag it BEFORE adding the
            // stub — `tag_hide` writes `[from..end]`, so each prim must be tagged while
            // it is the last one.
            scene.tag_hide(first, bits);
            // dollhouse cut-away: instead of vanishing, a camera-near wall leaves a
            // low WAVY stub — the bottom ~30 cm with an irregular top edge that reads
            // as "cut" so the iso view still sees in. The stub is shown by the INVERSE
            // dollhouse mask (visible exactly when the full wall is culled) and is
            // coincident with the wall's base, so the full wall keeps occluding for
            // shadows/GI (no light-transport change, no re-bake artefacts). CAVE_CUTAWAY=0
            // skips the stub for the original see-through dollhouse.
            if cfg.game.cave_cutaway {
                let run_x = (s[2] - s[0]) >= (s[3] - s[1]);
                let heights = wavy_stub_heights(*s, run_x);
                let stub = scene.add_wavy_top(*s, run_x, &heights, hex_linear(wall_hex), 0.85, 0.0);
                scene.tag_hide(stub, bits | rt_probe::HIDE_INVERT); // shown only when the wall is culled
            }
        }
    }

    // ---- wall targets: a pale backing plate flush on the wall + a bright red
    // disc-ish box just proud of it (greybox: a small square reads as a target
    // under the iso pixel grid). The disc face sits AT the wall plane so the
    // hitscan tie (wall face vs disc) does not occlude — matching shoot_system.
    for tg in &spec.targets {
        place_target(&mut scene, tg);
    }

    // ---- lights: every spec light → a named emissive box, IN SPEC ORDER so
    // the NEE slot order equals the spec / flicker index. The Screen device is
    // a thin wall slab marked as a screen (constant in both probe banks).
    for l in &spec.lights {
        place_light(&mut scene, l, room_center(spec, l), cfg.render.emit);
    }

    scene.recompute_bounds(); // bounds = the static world (no player, no doors)

    // ---- door leaves: LOCAL-space colored boxes (hinge at the origin) placed
    // as named DYNAMIC instances; the per-frame instance transform (rotate
    // about the hinge by the snapshot angle) swings them. Added AFTER
    // recompute_bounds so their local geometry never stretches the world AABB.
    for d in &spec.doors {
        place_door(&mut scene, d);
    }

    // ---- player marker: a matte near-white pillar (lattice-aligned footprint),
    // exactly like the house scene — a clean light albedo reads as a crisp white
    // actor against the bright scene (judge tweak: the old mid-grey pillar capped
    // dark/muddy), while still picking up the colored light pools and AO grounding.
    let pidx = scene.add_box_local(house_game::game::PLAYER_HALF, 1.3, house_game::game::PLAYER_HALF, [0.82, 0.84, 0.88, 1.0], [0.0; 4]);
    scene.prim_hide_mask.resize(scene.primitives.len(), 0);
    scene.dynamic_prim = Some(pidx);

    // collision is the game's job; the scene only needs floor_rect + solids for
    // the playerless camera paths and the legacy mirror — but for the game the
    // GameLoop builds its Level straight from the spec, so these stay the
    // footprint (matches floor_bounds) and the spec solids verbatim.
    scene.floor_rect = f;
    scene.solids = spec.static_solids.clone();
    scene.player_start = Vec3::new(spec.player_start.x, FLOOR_TOP, spec.player_start.z);

    // mood: lamp-lit interiors, no sun. The authored house keeps the bright
    // LIFTED sky fill (void outside the walls reads bright, not black). The cave
    // is a DUNGEON — a dimmer sky fill sinks the void into shadow so the lamp-lit
    // chambers pop, with a touch more mist for depth between the rooms.
    scene.lighting = if cfg.scene == "cave" {
        [0.0, 2.2, 0.26, 0.45]
    } else if dollhouse {
        // open street / daylit floor plan, not a dungeon: a brighter sky fill
        // carries the circulation (corridor floor has no lamp), interiors still
        // pop from their per-room lamp.
        [0.0, 5.5, 0.30, 0.42]
    } else {
        [0.0, 5.0, 0.18, 0.5]
    };
    scene
}

/// Centre of the room a light belongs to (its emissive box / point sits here,
/// near the ceiling).
fn room_center(spec: &LevelSpec, l: &LightSpec) -> Vec3 {
    let r = spec.rooms.iter().find(|r| r.id == l.room).map(|r| r.floor_rect).unwrap_or([0.0, 0.0, 1.0, 1.0]);
    Vec3::new((r[0] + r[2]) * 0.5, 2.0, (r[1] + r[3]) * 0.5)
}

/// Cut-away stub baseboard height (~32 cm = the owner's "say 30 cm") and the
/// wavy half-amplitude (≈ ±12 cm) around it.
const STUB_BASE: f32 = 0.25;
const STUB_AMP: f32 = 0.09;

/// Sample a gently wavy top contour for a cut-away wall stub along its run axis.
/// The phase is the WORLD coordinate along the run, so the undulation is coherent
/// across adjacent walls; two sine octaves keep it organic (not a flat repeat).
/// Heights snap to whole vertical low-pixels (Y projects 16·√6 ≈ 39.19 lowpx/wu)
/// so the cut edge reads crisp under the pixel-perfect downsample.
fn wavy_stub_heights(rect: [f32; 4], run_along_x: bool) -> Vec<f32> {
    let (lo, hi) = if run_along_x { (rect[0], rect[2]) } else { (rect[1], rect[3]) };
    let len = hi - lo;
    let segs = ((len * 4.0).round() as usize).clamp(3, 28); // ≈ one station / 0.25 wu
    let lp = 1.0 / (16.0 * 6.0_f32.sqrt()); // one vertical low-pixel, in world units
    (0..=segs)
        .map(|i| {
            let u = lo + (i as f32 / segs as f32) * len;
            let w = 0.62 * (u * 2.2).sin() + 0.38 * (u * 4.7 + 1.3).sin();
            ((STUB_BASE + STUB_AMP * w) / lp).round() * lp
        })
        .collect()
}

/// The dollhouse outward-hide bits of a cave wall slab, derived from the floor
/// layout: the side with NO floor is the exterior the iso camera should see
/// past. A thin-in-X slab is a vertical wall (test ±X); thin-in-Z is horizontal
/// (test ±Z). Each generated cave slab is a floor↔rock boundary, so exactly one
/// side is floor → exactly one bit (bit convention matches the perimeter above).
fn wall_outward_bits(s: &[f32; 4], spec: &LevelSpec) -> u8 {
    let (w, d) = (s[2] - s[0], s[3] - s[1]);
    let (mx, mz) = ((s[0] + s[2]) * 0.5, (s[1] + s[3]) * 0.5);
    // sample just outside the 0.25-thick slab; the neighbouring cell centre is
    // 0.5 away, so 0.1 past the face lands cleanly inside it (or in the void).
    let eps = 0.1;
    let on_floor = |x: f32, z: f32| spec.rooms.iter().any(|r| x >= r.floor_rect[0] && x <= r.floor_rect[2] && z >= r.floor_rect[1] && z <= r.floor_rect[3]);
    let mut bits = 0u8;
    if w <= d {
        let (west, east) = (on_floor(s[0] - eps, mz), on_floor(s[2] + eps, mz));
        if east && !west {
            bits |= 0b0100; // floor east → exterior west (-X)
        }
        if west && !east {
            bits |= 0b0001; // floor west → exterior east (+X)
        }
        if west && east {
            bits |= 0b0100 | 0b0001; // INTERIOR partition (floor both sides): cut from
                                     // BOTH sides so whichever room is behind it is never
                                     // occluded — the wall always shows as a low stub.
        }
    } else {
        let (north, south) = (on_floor(mx, s[1] - eps), on_floor(mx, s[3] + eps));
        if south && !north {
            bits |= 0b1000; // floor south → exterior north (-Z)
        }
        if north && !south {
            bits |= 0b0010; // floor north → exterior south (+Z)
        }
        if north && south {
            bits |= 0b1000 | 0b0010; // interior partition: cut from both sides
        }
    }
    bits
}

/// The dollhouse outward-hide bits of a THICK 1×1 rock block: a bit for every
/// side that fronts a floor cell (so the block hides when the camera looks at it
/// from the exterior of a room it borders). Cardinal neighbours first; if the
/// block only touches floor diagonally (an outer corner), the two bits of the
/// outward diagonal. Bit convention matches the perimeter / `wall_outward_bits`.
fn rock_block_bits(s: &[f32; 4], spec: &LevelSpec) -> u8 {
    let (mx, mz) = ((s[0] + s[2]) * 0.5, (s[1] + s[3]) * 0.5);
    let e = 0.1;
    let on = |x: f32, z: f32| spec.rooms.iter().any(|r| x >= r.floor_rect[0] && x <= r.floor_rect[2] && z >= r.floor_rect[1] && z <= r.floor_rect[3]);
    let mut bits = 0u8;
    if on(mx, s[3] + e) {
        bits |= 0b1000; // floor south → outward north (-Z)
    }
    if on(mx, s[1] - e) {
        bits |= 0b0010; // floor north → outward south (+Z)
    }
    if on(s[2] + e, mz) {
        bits |= 0b0100; // floor east → outward west (-X)
    }
    if on(s[0] - e, mz) {
        bits |= 0b0001; // floor west → outward east (+X)
    }
    if bits == 0 {
        // diagonal-only contact (outer corner): outward is the 2-bit diagonal
        // pointing away from the room the block touches.
        if on(s[2] + e, s[3] + e) {
            bits |= 0b1000 | 0b0100; // floor SE → outward NW
        }
        if on(s[0] - e, s[3] + e) {
            bits |= 0b1000 | 0b0001; // floor SW → outward NE
        }
        if on(s[2] + e, s[1] - e) {
            bits |= 0b0010 | 0b0100; // floor NE → outward SW
        }
        if on(s[0] - e, s[1] - e) {
            bits |= 0b0010 | 0b0001; // floor NW → outward SE
        }
    }
    bits
}

/// Add an axis-aligned box spanning the XZ rect from the floor (y=0) to
/// `height`, with a solid color (no emission). Returns the first prim index.
fn box_world(scene: &mut Scene, rect: [f32; 4], height: f32, hex: u32) -> usize {
    let first = scene.primitives.len();
    scene.add_box_world(Vec3::new(rect[0], 0.0, rect[1]), Vec3::new(rect[2], height, rect[3]), hex_linear(hex), [0.0; 4], 0.85, 0.0);
    first
}

/// One iso 2:1 stair step (`0.0625 wu` = 2 H + 1 V px). Every target XZ
/// half-extent and every along-normal offset is a multiple of this so the
/// backing plate + disc boxes rasterize clean silhouettes (invariant #8). The
/// spec target centers are already on the lattice (wall face + tangent both
/// land on multiples of `STAIR`), so on-lattice center ± stair-multiple
/// half-extent keeps every box min/max on the lattice too.
const STAIR: f32 = 0.0625;
/// Backing-plate / disc dimensions, all stair multiples. The original `radius`
/// (0.3 wu) snaps to the nearest stair grid: plate face = 0.5 wu (8 steps),
/// disc face = 0.375 wu (6 steps); both are flat box-faces, not analytic discs.
const PLATE_HALF: f32 = 0.25; // 4 steps → 0.5 wu plate face
const DISC_HALF: f32 = 0.1875; // 3 steps → 0.375 wu disc face
const FACE_DEPTH: f32 = STAIR; // 0.0625 wu box thickness along the wall normal

/// A wall target: a pale backing plate flush on the wall, then a smaller bright
/// disc box just proud of it along the inward normal. Both faces are sized to
/// stair-step multiples (invariant #8) — the analytic `TargetDisc` the game
/// hitscan uses keeps the spec's `center`/`radius`, so snapping the *rendered*
/// greybox to the lattice does not move the hitbox. The disc's back face sits
/// at the wall plane (`center` is on the inner wall face), so the hitscan tie
/// (wall slab vs disc) does NOT block — exactly the shoot_system contract.
fn place_target(scene: &mut Scene, tg: &TargetSpec) {
    let n = tg.normal;
    let c = tg.center;
    let along_x = n.x.abs() > 0.5; // wall normal is ±X → the face spans Z (+ Y)
    // Build each box from explicit min/max. The two axes perpendicular to n get
    // the tangent half-extent (a stair multiple, so center ± it stays on the
    // lattice). Along n the box runs from the wall plane (`c`) `depth` into the
    // room: min/max are `c` and `c + n*depth`, both on the lattice. Y is exempt.
    let face_box = |tangent_half: f32, depth: f32| -> (Vec3, Vec3) {
        let (lo_n, hi_n) = if n.x + n.z >= 0.0 { (0.0, depth) } else { (-depth, 0.0) };
        let (lx, hx, lz, hz) = if along_x { (lo_n, hi_n, -tangent_half, tangent_half) } else { (-tangent_half, tangent_half, lo_n, hi_n) };
        (Vec3::new(c.x + lx, c.y - tangent_half, c.z + lz), Vec3::new(c.x + hx, c.y + tangent_half, c.z + hz))
    };
    // backing plate: one stair-step deep into the room, flush on the wall.
    let (plo, phi) = face_box(PLATE_HALF, FACE_DEPTH);
    scene.add_box_world(plo, phi, hex_linear(TARGET_RING), [0.0; 4], 0.9, 0.0);
    // red disc proud of the plate: back face AT the wall plane (= center, so the
    // hitscan tie does not occlude), front face two stair-steps into the room.
    let (dlo, dhi) = face_box(DISC_HALF, FACE_DEPTH * 2.0);
    scene.add_box_world(dlo, dhi, hex_linear(TARGET_COLOR), [0.0; 4], 0.7, 0.0);
}

/// Place a named light. The Screen device is an emissive WALL SLAB (the only
/// emissive prim → NEE slot 0; `mark_screen` + an authored forward facing keep
/// it one-sided and constant in both probe banks). Every room lamp is a
/// CONCEPTUAL ceiling point light (no geometry → light reaches the floor
/// unobstructed, like the house's interior lamps) — these slot AFTER the
/// emissive prim, so the spec light order (screen first, then lamps) IS the
/// NEE slot order that `join_game_lights` asserts.
fn place_light(scene: &mut Scene, l: &LightSpec, center: Vec3, emit: f32) {
    let rgb = l.base_rgb;
    match l.kind {
        LightKind::Screen => {
            // a thin wall-mounted slab, emitting forward (+Z) into the room,
            // like the house terminal screens; strength for a readable glow.
            let s = 18.0 * emit;
            let p = Vec3::new(center.x, 0.8, center.z - 1.875); // near the room's north interior wall
            scene.add_box_world(Vec3::new(p.x - 0.25, p.y, p.z - 0.02), Vec3::new(p.x + 0.25, p.y + 0.4, p.z + 0.02), [0.1, 0.3, 0.25, 1.0], [rgb[0] * s, rgb[1] * s, rgb[2] * s, 1.0], 0.8, 0.0);
            let prim = scene.primitives.len() - 1;
            scene.name_light(&l.name, prim);
            scene.mark_screen(prim);
            scene.prim_light_dir.resize(scene.primitives.len(), [0.0; 3]);
            *scene.prim_light_dir.last_mut().unwrap() = [0.0, 0.0, 1.0]; // emits into the room (+Z)
        }
        _ => {
            // conceptual ceiling lamp (no rendered fixture): [cx,cy,cz,radius,
            // r,g,b,0]. The room is lamp-lit (no sun), so these carry it.
            let s = 620.0 * emit;
            scene.point_lights.push([center.x, 2.0, center.z, 0.25, rgb[0] * s, rgb[1] * s, rgb[2] * s, 0.0]);
            scene.name_point_light(&l.name, scene.point_lights.len() - 1);
        }
    }
}

/// Place one door leaf as a named dynamic instance. The leaf is a LOCAL-space
/// box: the closed footprint shifted so the hinge is at the origin, from y=0 to
/// DOOR_LEAF_H. The instance starts at identity; the per-frame transform
/// `translate(hinge) * rotate_y(axis_y · angle)` swings it (`door_instance`).
/// ASSERTS geometry consistency: at angle 0 the local box + hinge reconstructs
/// the spec's `closed_solid` exactly.
fn place_door(scene: &mut Scene, d: &DoorSpec) {
    let s = d.closed_solid;
    let (hx, hz) = (d.hinge.x, d.hinge.z);
    // local footprint = closed_solid shifted by -hinge.xz (hinge -> origin)
    let lmin = Vec3::new(s[0] - hx, 0.0, s[1] - hz);
    let lmax = Vec3::new(s[2] - hx, DOOR_LEAF_H, s[3] - hz);
    let first = scene.primitives.len();
    scene.add_box_world(lmin, lmax, hex_linear(DOOR_COLOR), [0.0; 4], 0.8, 0.0);
    scene.register_dynamic(&d.name, first, scene.primitives.len() - first, Mat4::IDENTITY);
    // geometry consistency: translate(hinge) on the local box must equal
    // closed_solid (the footprint the game collides against).
    let recon = [lmin.x + hx, lmin.z + hz, lmax.x + hx, lmax.z + hz];
    assert!(
        recon.iter().zip(s.iter()).all(|(a, b)| (a - b).abs() < 1e-4),
        "door {:?}: leaf footprint {recon:?} != closed_solid {s:?}",
        d.id
    );
}

/// The per-frame world transform of a door leaf at swing `angle` (radians):
/// rotate about the hinge (world Y, signed by `axis_y`), then translate to the
/// hinge. The leaf geometry is hinge-at-origin local space.
pub fn door_instance(hinge: Vec3, axis_y: f32, angle: f32) -> Mat4 {
    Mat4::from_translation(hinge) * Mat4::from_rotation_y(axis_y * angle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sim::join_game_lights;
    use house_game::game_level;
    use rt_probe::{scan_lights, SceneHandles};

    fn game_cfg() -> Config {
        // a default-ish config; build_game only reads cfg.render.emit
        std::env::set_var("SCENE", "game");
        Config::from_env()
    }

    /// The greybox builder produces a renderable scene whose NEE slots, named
    /// dynamic door instances, and probe-bank screen flag all line up with the
    /// authored spec — the adapter join + geometry-consistency contract.
    #[test]
    fn build_game_joins_lights_and_doors_to_the_spec() {
        let spec = game_level();
        let scene = build_game(&spec, &game_cfg());
        // a player marker + four dynamic door runs
        assert!(scene.dynamic_prim.is_some(), "player marker present");
        assert_eq!(scene.dynamics.len(), spec.doors.len(), "one dynamic run per door");
        for d in &spec.doors {
            assert!(scene.dynamics.iter().any(|(n, ..)| n == &d.name), "door {:?} registered", d.name);
        }
        // light name-join: every NEE slot named, IN SPEC ORDER (asserts inside)
        let scan = scan_lights(&scene).unwrap();
        let handles = SceneHandles { lights: scan.names.clone(), instances: Default::default() };
        let joined = join_game_lights(&spec, &handles, scan.light_count);
        assert_eq!(joined.len(), spec.lights.len());
        for (i, l) in spec.lights.iter().enumerate() {
            assert_eq!(joined[i].1, l.kind, "slot {i} kind");
        }
        // exactly one screen device (crt_b), marked for the constant probe bank
        assert_eq!(scene.screen_prims.len(), 1, "one screen device");
    }

    /// Every greybox target box (backing plate + disc) has XZ dimensions AND
    /// min/max corners on the iso 2:1 stair lattice (multiples of 0.0625 wu) —
    /// invariant #8. The native `rt_probe::Scene` has no validator (unlike the
    /// web `isoCleanGeometryValidator`), so this test is the native equivalent:
    /// a regression that reintroduces sub-pixel insets (e.g. 0.005 wu) or a
    /// raw `radius`-derived extent (0.3 wu → 9.6 px) fails here.
    #[test]
    fn target_boxes_are_iso_stair_aligned() {
        const STEP: f32 = 0.0625;
        let on_lattice = |v: f32| (v / STEP - (v / STEP).round()).abs() < 1e-4;
        let spec = game_level();
        for tg in &spec.targets {
            let mut scene = Scene::new();
            place_target(&mut scene, tg);
            assert_eq!(scene.primitives.len(), 2, "target {:?}: plate + disc", tg.id);
            for (pi, p) in scene.primitives.iter().enumerate() {
                let verts = &scene.vertices[p.vertex_offset as usize..(p.vertex_offset + p.vertex_count) as usize];
                let (mut xmin, mut xmax, mut zmin, mut zmax) = (f32::INFINITY, f32::NEG_INFINITY, f32::INFINITY, f32::NEG_INFINITY);
                for v in verts {
                    xmin = xmin.min(v.pos[0]);
                    xmax = xmax.max(v.pos[0]);
                    zmin = zmin.min(v.pos[2]);
                    zmax = zmax.max(v.pos[2]);
                }
                // corners on the lattice (the web validator only checks dims;
                // the finding asks for both — on-lattice center keeps min/max on
                // the lattice iff every extent is a stair multiple).
                for (axis, v) in [("xmin", xmin), ("xmax", xmax), ("zmin", zmin), ("zmax", zmax)] {
                    assert!(on_lattice(v), "target {:?} box {pi}: {axis}={v} off the 0.0625 lattice", tg.id);
                }
                // dimensions are stair multiples (multiple of 0.0625 ⇒ d*32 even)
                for (axis, d) in [("x", xmax - xmin), ("z", zmax - zmin)] {
                    assert!(on_lattice(d), "target {:?} box {pi}: {axis} dim {d} not a 0.0625 multiple", tg.id);
                }
            }
        }
    }

    /// Every cullable cave wall pairs with an INVERSE cut-away stub: same
    /// direction nibble + HIDE_INVERT, footprint coincident with the wall, and a
    /// low wavy top (a cut baseboard, ≈30 cm). The authored `game` scene must
    /// emit NO inverse tags (its goldens stay byte-identical).
    #[test]
    fn cave_walls_get_inverse_cutaway_stubs() {
        use house_game::cave_level;
        // set cfg.scene directly (not via $SCENE) — the env is shared across the
        // parallel test threads, so `game_cfg()` elsewhere would race it.
        let mut cfg = game_cfg();
        cfg.scene = "cave".to_string();
        let spec = cave_level(1);
        let scene = build_game(&spec, &cfg);
        let inv = rt_probe::HIDE_INVERT;
        let walls = scene.prim_hide_mask.iter().filter(|&&m| m != 0 && m & inv == 0).count();
        let stubs = scene.prim_hide_mask.iter().filter(|&&m| m & inv != 0).count();
        assert!(stubs > 0, "cave should emit cut-away stubs");
        assert_eq!(walls, stubs, "exactly one stub per cullable wall");
        // each stub: direction nibble is a real wall direction, the cut stays low,
        // and its XZ footprint corners land on the iso stair lattice.
        const STEP: f32 = 0.0625;
        let on = |v: f32| (v / STEP - (v / STEP).round()).abs() < 1e-3;
        for (pi, &m) in scene.prim_hide_mask.iter().enumerate() {
            if m & inv == 0 {
                continue;
            }
            assert_ne!(m & 0x0F, 0, "stub prim {pi}: lost its direction nibble");
            let p = &scene.primitives[pi];
            let vs = &scene.vertices[p.vertex_offset as usize..(p.vertex_offset + p.vertex_count) as usize];
            let (mut xmn, mut xmx, mut zmn, mut zmx, mut ymx) = (f32::INFINITY, f32::NEG_INFINITY, f32::INFINITY, f32::NEG_INFINITY, 0.0f32);
            for v in vs {
                xmn = xmn.min(v.pos[0]);
                xmx = xmx.max(v.pos[0]);
                zmn = zmn.min(v.pos[2]);
                zmx = zmx.max(v.pos[2]);
                ymx = ymx.max(v.pos[1]);
            }
            assert!(ymx > 0.12 && ymx < 0.45, "stub prim {pi}: cut height {ymx} off (~30 cm)");
            for (axis, v) in [("xmn", xmn), ("xmx", xmx), ("zmn", zmn), ("zmx", zmx)] {
                assert!(on(v), "stub prim {pi}: footprint {axis}={v} off the lattice");
            }
        }
    }

    /// Golden guard: the authored `game` scene never uses the cut-away (inverse)
    /// dollhouse tag, so its dollhouse masks — and goldens — are untouched.
    #[test]
    fn authored_game_scene_has_no_inverse_tags() {
        let spec = game_level();
        let scene = build_game(&spec, &game_cfg());
        assert!(scene.prim_hide_mask.iter().all(|&m| m & rt_probe::HIDE_INVERT == 0), "non-cave scene must not emit cut-away stubs");
    }

    /// A closed door leaf (angle 0) occupies exactly its spec closed_solid
    /// footprint — the renderer leaf and the game collision agree. (The builder
    /// asserts this internally too; this pins it as a public contract.)
    #[test]
    fn closed_door_leaf_matches_closed_solid() {
        let spec = game_level();
        for d in &spec.doors {
            // the leaf local box is closed_solid - hinge.xz; door_instance at
            // angle 0 is translate(hinge), so it reconstructs closed_solid.
            let m = door_instance(d.hinge, d.axis_y, 0.0);
            let lo = m.transform_point3(Vec3::new(d.closed_solid[0] - d.hinge.x, 0.0, d.closed_solid[1] - d.hinge.z));
            let hi = m.transform_point3(Vec3::new(d.closed_solid[2] - d.hinge.x, 0.0, d.closed_solid[3] - d.hinge.z));
            assert!((lo.x - d.closed_solid[0]).abs() < 1e-4 && (lo.z - d.closed_solid[1]).abs() < 1e-4, "door {:?} lo", d.id);
            assert!((hi.x - d.closed_solid[2]).abs() < 1e-4 && (hi.z - d.closed_solid[3]).abs() < 1e-4, "door {:?} hi", d.id);
        }
    }
}
