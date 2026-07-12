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
use house_game::board::{BoardSpec, TileKind, D_POOR, D_RICH};
use house_game::{DoorSpec, LevelSpec, LightKind, LightSpec, TargetSpec};
use rt_probe::{hex_linear, Config, Scene};

/// Greybox wall height — the kit wallHeight (280 cm = 2.1875 wu). Distinct
/// from the projectile occluder band (`house_game::game::WALL_H` = 2.56) — the
/// visual wall can be shorter than the shoot band without changing gameplay.
pub const WALL_TOP: f32 = 2.1875;
/// Door leaf height — the kit door height (220 cm = 1.71875 wu).
pub const DOOR_LEAF_H: f32 = 1.71875;
/// Wall half-thickness (kit 32 cm = 0.25 wu wall).
const WALL_HT: f32 = 0.125;

/// Goo sphere tessellation (coarse — read as soft lumps under the low-res grid).
const GOO_SPHERE_RINGS: u32 = 8;
const GOO_SPHERE_SECTORS: u32 = 12;
/// Trap floor-ring color (hazard magenta), emissive so it glows. Linear.
const GOO_TRAP_EMISSIVE: [f32; 4] = [4.0, 0.5, 5.0, 1.0];
/// Near-black green body so unlit silhouette stays dark; the emissive carries
/// the glow. Linear RGBA.
const GOO_BASE_COLOR: [f32; 4] = [0.03, 0.10, 0.04, 1.0];
/// Fluorescent radioactive-green emission (green-biased, bloomed by the tone
/// stack). Magnitudes are on the renderer's emissive scale (screens emit ~10-17),
/// so the blob self-glows and blooms. Linear; alpha left 1.0 (reserved for a
/// future goo-id/IOR encode).
const GOO_EMISSIVE: [f32; 4] = [1.3, 6.5, 2.0, 1.0];

/// Projectile tracer sphere tessellation (tiny — a bright bolt, not a detailed
/// ball). Coarse keeps the per-slug geometry cheap.
const PROJ_SPHERE_RINGS: u32 = 6;
const PROJ_SPHERE_SECTORS: u32 = 8;
/// Near-black base so the unlit slug stays dark; the emissive carries the glow.
const PROJ_BASE_COLOR: [f32; 4] = [0.05, 0.04, 0.02, 1.0];
/// Hot white-gold tracer emission — reads as a fiery slug, distinct from the
/// green goo and the magenta trap rings. Linear, on the renderer emissive scale.
const PROJ_EMISSIVE: [f32; 4] = [11.0, 8.0, 3.5, 1.0];
/// Reserved projectile tracer pool size (max slugs drawn at once; extra live
/// projectiles simply aren't drawn, like the goo slot overflow).
pub fn proj_pool_size() -> usize {
    // sized for the arena arsenal's worst case: three 7-pellet shotgun volleys
    // in flight (max_age 20 ticks @ cooldown 35 keeps it to ~1, but uzi rounds
    // linger 2 s — headroom is cheap, an overflowing shot just doesn't draw)
    32
}

/// Reserved ellipsoid pool size: the live-blob cap × goo particles. Honors the
/// renderer constraint `live_cap × particles ≤ pool` by construction. Used by
/// the `GOO_SDF=0` opaque-sphere fallback (the default SDF composite path
/// needs no triangle pool).
pub fn goo_pool_size() -> usize {
    house_game::GOO_LIVE_CAP * house_game::GOO_PARTICLES
}

/// Whether the smooth translucent SDF goo composite is enabled (default on).
/// When on, BOTH backends render the goo via the screen-space metaball pass
/// (goo.metal on macOS, goo.comp on Vulkan) and NO triangle sphere pool is
/// built; set `GOO_SDF=0` for the opaque-sphere pool fallback.
pub fn goo_sdf_enabled() -> bool {
    std::env::var("GOO_SDF").map(|v| v != "0").unwrap_or(true)
}
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

/// Dead-chunk look: cold matte stone with a whisper of residual goo glow.
const CHUNK_BASE_COLOR: [f32; 4] = [0.30, 0.33, 0.31, 1.0];
const CHUNK_EMISSIVE: [f32; 4] = [0.04, 0.13, 0.07, 1.0];

// The wall/camera scene classifiers (is_dollhouse / is_open_studio_stage /
// is_goo_film_stage) live in `crate::scene_registry` — one row per scene.

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
    let dollhouse = crate::scene_registry::is_dollhouse(&cfg.scene);
    let wall_hex = if dollhouse { WALL_STONE } else { WALL_INNER };

    // ---- tiny-world BOARD scenes (the Larceny pivot): per-tile floors +
    // box-built miniatures replace the room/wall greybox entirely. No
    // perimeter walls — the diorama just ends at the board edge — and the
    // spec's board-derived solids already carry collision, so the generic
    // floor/perimeter/solid passes below are skipped wholesale.
    if let Some(board) = &spec.board {
        build_board(&mut scene, board);
    } else {

    // ---- floors: one quad per room in its own pastel tint (cave corridors get
    // the neutral stone tint); the room order is the spec order so the palette
    // reads stable. Keyed off `RoomId` so cave corridor ids select CORRIDOR_FLOOR.
    for r in spec.rooms.iter() {
        let c = if r.id.0 >= house_game::CORRIDOR_ROOM_ID_BASE { CORRIDOR_FLOOR } else { FLOOR_TINTS[(r.id.0 as usize) % FLOOR_TINTS.len()] };
        scene.add_floor(r.floor_rect[0], r.floor_rect[2], r.floor_rect[1], r.floor_rect[3], FLOOR_TOP, hex_linear(c));
    }

    // ---- arena deck detail (render DECALS only — no collision, no occluder
    // flags, no silhouette: flat quads a hair above the floor plane, ~0.2
    // low-px, so the iso contract never sees an edge). Seeded from the level
    // so a seed always deals the same deck. Three layers: scattered graphite
    // service plates, amber hazard strips ringing the drain zone (the
    // objective reads from across the pit), and dark landing pads on the
    // north entrance ring (the squad-drop telegraph).
    if spec.arena.is_some() {
        let y = FLOOR_TOP + 0.004;
        let quarter = |v: f32| (v * 4.0).round() * 0.25; // stair-grid snap
        let rnd = |k: u32| {
            let hh = (spec.seed as u32 ^ 0xa511e9b3).wrapping_add(k.wrapping_mul(2654435761)).wrapping_mul(2654435761);
            (hh >> 8) as f32 / 16777216.0
        };
        for i in 0..10u32 {
            let (r0, r1, r2, r3) = (rnd(i * 4), rnd(i * 4 + 1), rnd(i * 4 + 2), rnd(i * 4 + 3));
            let w = [1.25, 1.5, 2.0][((r2 * 3.0) as usize).min(2)];
            let d = [1.0, 1.25, 1.5][((r3 * 3.0) as usize).min(2)];
            let x0 = quarter(f[0] + 0.5 + r0 * (f[2] - f[0] - 1.0 - w));
            let z0 = quarter(f[1] + 0.5 + r1 * (f[3] - f[1] - 1.0 - d));
            // skip a panel that runs under a wall/solid — seams read as bugs
            let clear = spec.static_solids.iter().all(|s| x0 + w < s[0] - 0.2 || x0 > s[2] + 0.2 || z0 + d < s[1] - 0.2 || z0 > s[3] + 0.2);
            if !clear {
                continue;
            }
            // one step darker in the floor's own mint family — service
            // panels, not holes (a foreign gray crushes to black under the
            // dim teal light)
            let c = if i & 1 == 0 { 0xafe2cb } else { 0xa5d8c1 };
            scene.add_floor(x0, x0 + w, z0, z0 + d, y, hex_linear(c));
        }
        if let Some(dz) = spec.drain {
            let c = hex_linear(0xd9a13a); // hazard amber
            let (cx0, cx1) = ((dz[0] - 0.5).max(f[0]), (dz[2] + 0.5).min(f[2]));
            let (cz0, cz1) = ((dz[1] - 0.5).max(f[1]), (dz[3] + 0.5).min(f[3]));
            for [x0, z0, x1, z1] in [
                [cx0, (dz[1] - 0.375).max(f[1]), cx1, (dz[1] - 0.125).max(f[1])], // north strip
                [cx0, (dz[3] + 0.125).min(f[3]), cx1, (dz[3] + 0.375).min(f[3])], // south strip
                [(dz[0] - 0.375).max(f[0]), cz0, (dz[0] - 0.125).max(f[0]), cz1], // west strip
                [(dz[2] + 0.125).min(f[2]), cz0, (dz[2] + 0.375).min(f[2]), cz1], // east strip
            ] {
                if x1 > x0 && z1 > z0 {
                    scene.add_floor(x0, x1, z0, z1, y + 0.002, c);
                }
            }
        }
        // wave entrance ring (goo.rs GOO_WAVE_RING = 7.0, north semicircle):
        // two mint steps down — a clear telegraph, still floor-family
        for k in 0..3 {
            let a = std::f32::consts::PI * (1.25 + 0.25 * k as f32);
            let (cx, cz) = (quarter(a.cos() * 7.0), quarter(a.sin() * 7.0));
            if cx - 0.5 > f[0] && cx + 0.5 < f[2] && cz - 0.5 > f[1] && cz + 0.5 < f[3] {
                scene.add_floor(cx - 0.5, cx + 0.5, cz - 0.5, cz + 0.5, y + 0.001, hex_linear(0x93c8b1));
            }
        }
        // L3: grate bars over each sieve slot — pure dress (no mark_occluder,
        // so the sim's shots and the goo squeeze exactly as before) that makes
        // the slot grammar readable at a glance: slit = 3 thin bars, slot = 2,
        // main = one BROKEN stub (unsealable — the bar already lost).
        for gap in sieve_slots(spec) {
            let (x0, x1, z0, z1) = (gap[0], gap[1], gap[2], gap[3]);
            let w = x1 - x0;
            let bars: &[(f32, f32, f32)] = if w < 0.4 {
                &[(0.25, 0.03, 0.6), (0.5, 0.03, 0.6), (0.75, 0.03, 0.6)] // (frac, half-width, height)
            } else if w < 0.8 {
                &[(0.33, 0.04, 0.6), (0.67, 0.04, 0.6)]
            } else {
                &[(0.38, 0.05, 0.28)] // the main drain's snapped-off stub
            };
            for &(frac, hw, h) in bars {
                let bx = x0 + w * frac;
                box_world(&mut scene, [bx - hw, z0 + 0.02, bx + hw, z1 - 0.02], h, 0x4e5358);
            }
        }
    }

    // ---- perimeter walls: four slabs around the footprint, WALL_TOP tall,
    // 0.25 wu thick, sitting just OUTSIDE the walkable floor rect (the inner face
    // on the rect edge). Solid full-height geometry — the per-pixel CAVE_ROI
    // reveal sees through them around the player. The generated scenes
    // (`dollhouse`) skip this: their own boundary slabs already enclose every
    // region.
    let t = WALL_HT * 2.0;
    if !dollhouse {
        let perim: [[f32; 4]; 4] = [
            [f[0] - t, f[1] - t, f[0], f[3] + t], // west wall
            [f[2], f[1] - t, f[2] + t, f[3] + t], // east wall
            [f[0] - t, f[1] - t, f[2] + t, f[1]], // north wall
            [f[0] - t, f[3], f[2] + t, f[3] + t], // south wall
        ];
        for rect in perim {
            let first = box_world(&mut scene, rect, WALL_TOP, WALL_PERIM);
            mark_occluder(&mut scene, first);
        }
    }

    // ---- interior structure. Authored house: each static solid is a wall
    // (thin: one XZ dim == the wall thickness) or furniture (the free-standing
    // crate, a low box). Generated scenes: EVERY solid is a wall — a thin
    // boundary slab or a full 1×1 rock block. All walls are solid full-height
    // geometry; the CAVE_ROI reveal opens them per-pixel around the player.
    for s in &spec.static_solids {
        let (w, d) = (s[2] - s[0], s[3] - s[1]);
        if !dollhouse && w.min(d) > t + 1e-3 {
            box_world(&mut scene, *s, 0.6, FURNITURE); // crate-height greybox (not an occluder)
            continue;
        }
        let first = box_world(&mut scene, *s, WALL_TOP, wall_hex);
        mark_occluder(&mut scene, first);
    }

    } // end !board (the generic room/wall greybox path)

    // ---- L4 low cover: authored knee-high masonry (GOO_CHUNK_H, the chunk
    // band) — crisp warm-gray blocks the player shoots OVER and the goo must
    // flow around. Sim collision comes from spec.low_solids seeding
    // res.chunks; this is only the visual. Not an occluder (knee-high).
    for s in &spec.low_solids {
        box_world(&mut scene, *s, house_game::GOO_CHUNK_H, 0x9aa0a4);
    }

    // ---- wall targets: a pale backing plate flush on the wall + a bright red
    // disc-ish box just proud of it (greybox: a small square reads as a target
    // under the iso pixel grid). The disc face sits AT the wall plane so the
    // projectile-sweep tie (wall face vs disc) does not occlude — matching projectile_system.
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

    // ---- player: a small ceramic "warden" droid replacing the old plain
    // pillar — graphite base, white-ceramic torso wearing an amber power band,
    // a hovering head with a dark visor. Deliberately AXIS-ALIGNED (the body
    // never rotates, so its box silhouette stays crisp on the iso pixel
    // lattice); aim is shown by the weapon ring below, which DOES rotate.
    // One named dynamic run ("player"), translated per frame exactly like the
    // old single-box marker.
    let pfirst = scene.primitives.len();
    if spec.board.is_some() {
        build_human_body(&mut scene); // the Larceny thief — humans on the board
    } else {
        build_player_body(&mut scene);
    }
    scene.register_dynamic("player", pfirst, scene.primitives.len() - pfirst, Mat4::from_translation(Vec3::new(spec.player_start.x, FLOOR_TOP, spec.player_start.z)));

    // ---- weapon ring (arena only): one gun model per arsenal slot, all
    // registered zero-scale; each frame the shell shows the SELECTED slot's
    // gun at the player, rotated to the facing (the aim tell), and keeps the
    // rest collapsed — the same reserve-slot trick as every pool below.
    if spec.arena.is_some() {
        // muzzle flare: one hot emissive sphere the shell flashes AT the
        // barrel tip for the muzzle ticks (zero-scale otherwise) — the
        // visible half of the muzzle-flash spotlight, so the trigger, the
        // light burst and the tracer leave the same point on the same tick.
        register_sphere_pool(&mut scene, "flare_slot", 1, PROJ_SPHERE_RINGS, PROJ_SPHERE_SECTORS, [0.06, 0.05, 0.02, 1.0], [22.0, 16.0, 7.0, 1.0], 0.4);
        for slot in 1..=5u8 {
            let gfirst = scene.primitives.len();
            build_gun(&mut scene, slot);
            scene.register_dynamic(&format!("gun_{slot}"), gfirst, scene.primitives.len() - gfirst, Mat4::from_scale(Vec3::ZERO));
        }
    }

    // ---- goo blob ellipsoid pool: GOO_LIVE_CAP × 4 emissive unit spheres as
    // named dynamic instances ("goo_slot_N"). The adapter skins them onto the
    // live blobs' spine nodes each frame (translate · scale); unused slots
    // collapse to zero scale (invisible). Like the door leaves and player
    // marker, these are LOCAL-space dynamics added after recompute_bounds, so
    // their geometry never stretches the world AABB. Fluorescent radioactive
    // green: near-black base, strong green-biased emissive (camera sees it
    // directly; movers are excluded from NEE so it self-glows without lighting
    // the room — the documented v1 limitation).
    // gated on authored mobs so mob-free scenes (game / cave / …) add no goo
    // geometry and keep their goldens byte-identical. Skipped entirely when the
    // SDF composite is on (Metal renders goo screen-space, no triangles needed).
    if !spec.mobs.is_empty() && !goo_sdf_enabled() {
        register_sphere_pool(&mut scene, "goo_slot", goo_pool_size(), GOO_SPHERE_RINGS, GOO_SPHERE_SECTORS, GOO_BASE_COLOR, GOO_EMISSIVE, 0.3);
    }

    // ---- projectile tracer pool: PROJ-cap emissive spheres as named dynamics
    // ("proj_slot_N"), moved onto the live projectiles each frame (the Metal SDF
    // path needs no goo triangles but DOES want these — they are real primary-
    // visible geometry, unlike the goo SDF). Gated on authored mobs (the same
    // gate as goo) so mob-free golden scenes (game / cave / house) add no slug
    // geometry and stay byte-identical. Local-space dynamics (after
    // recompute_bounds), excluded from NEE/probe-bake like the goo pool.
    if !spec.mobs.is_empty() {
        register_sphere_pool(&mut scene, "proj_slot", proj_pool_size(), PROJ_SPHERE_RINGS, PROJ_SPHERE_SECTORS, PROJ_BASE_COLOR, PROJ_EMISSIVE, 0.4);
    }
    // dead-chunk pool (arena only): matte gray domes for solidified blob
    // remains — real TLAS geometry, so they catch light and cast shadows.
    // Slots skin from GameSnapshot.chunks; unused slots stay zero-scale.
    if spec.arena.is_some() {
        register_sphere_pool(&mut scene, "chunk_slot", house_game::GOO_CHUNK_CAP, 10, 14, CHUNK_BASE_COLOR, CHUNK_EMISSIVE, 0.9);
        // splash-droplet pool: hot-green motes torn off by ANY hit (sized for a
        // shotgun volley of sprays + their floor splats)
        register_sphere_pool(&mut scene, "drop_slot", 48, 5, 7, [0.02, 0.06, 0.03, 1.0], [2.5, 7.5, 3.0, 1.0], 0.5);
        // impact-spark pool: hot amber debris where rounds die (walls, floor,
        // blob splashes) — the target-side tell of every shot
        register_sphere_pool(&mut scene, "spark_slot", 24, 4, 6, [0.06, 0.04, 0.02, 1.0], [16.0, 10.0, 3.5, 1.0], 0.5);
        // ---- per-class tracer pools (D1 identity): every weapon's rounds
        // draw from a pool with its OWN emissive material — read-at-a-glance
        // tint the single shared pool can't give. Sized to each weapon's
        // worst realistic in-flight count (overflow just doesn't draw).
        // Same local radius 0.4 as proj_slot, so visual size = scale × 0.4.
        register_sphere_pool(&mut scene, "trc_slug", 4, PROJ_SPHERE_RINGS, PROJ_SPHERE_SECTORS, [0.06, 0.04, 0.01, 1.0], [14.0, 7.0, 1.8, 1.0], 0.4); // fat amber bolt
        register_sphere_pool(&mut scene, "trc_uzi", 14, PROJ_SPHERE_RINGS, PROJ_SPHERE_SECTORS, [0.05, 0.05, 0.05, 1.0], [10.0, 10.0, 10.5, 1.0], 0.4); // thin white needle
        register_sphere_pool(&mut scene, "trc_shot", 16, PROJ_SPHERE_RINGS, PROJ_SPHERE_SECTORS, [0.06, 0.03, 0.01, 1.0], [12.0, 4.8, 1.2, 1.0], 0.4); // short orange sparks
        register_sphere_pool(&mut scene, "trc_gren", 4, PROJ_SPHERE_RINGS, PROJ_SPHERE_SECTORS, [0.10, 0.10, 0.08, 1.0], [0.35, 0.40, 0.30, 1.0], 0.4); // matte shell
        register_sphere_pool(&mut scene, "trc_fuse", 4, 4, 6, [0.05, 0.02, 0.01, 1.0], [16.0, 3.0, 1.0, 1.0], 0.4); // its blinking red fuse glow
        register_sphere_pool(&mut scene, "trc_harp", 6, PROJ_SPHERE_RINGS, PROJ_SPHERE_SECTORS, [0.02, 0.05, 0.06, 1.0], [3.0, 10.0, 12.5, 1.0], 0.4); // cyan dart line + wire glint
        // harpoon muzzle rail streak: a line of cyan motes burned down the
        // first 1.5 wu of the shot (W4) — brighter than the dart, gone fast
        register_sphere_pool(&mut scene, "rail_slot", 12, 4, 6, [0.02, 0.05, 0.06, 1.0], [8.0, 20.0, 24.0, 1.0], 0.5);
        // grenade smoke puffs: the launcher's whole muzzle signature (no
        // flash) — faint warm-grey motes, barely emissive so they read in
        // the dim pit without glowing
        register_sphere_pool(&mut scene, "puff_slot", 6, 5, 7, [0.30, 0.29, 0.27, 1.0], [0.55, 0.52, 0.48, 1.0], 0.5);
        // L2: drain-current motes — one 4-mote lane per sieve slot, scrolled
        // INTO the mouths by flow_instances (cold cyan: the exit's color).
        // The pool only exists on containment scenes.
        if spec.drain.is_some() {
            let lanes = sieve_slots(spec).len().max(1);
            register_sphere_pool(&mut scene, "flow_slot", lanes * 4, 4, 6, [0.02, 0.05, 0.06, 1.0], [1.6, 4.2, 5.0, 1.0], 0.5);
        }
        // D4: harpoon pin bolts — one cyan nail standing in each pinned body
        // at its pin point, blinking through the last second of the hold
        register_sphere_pool(&mut scene, "pin_slot", 4, 4, 6, [0.02, 0.05, 0.06, 1.0], [4.0, 11.0, 13.0, 1.0], 0.5);
    }

    // ---- L5 corner service lamps (arena scenes): four glowing fixtures
    // inset from the pit corners — edge zoning against the dimmer mid-field
    // and an orientation anchor through camera rotation and the blackout act.
    // NEE-excluded fixtures (the trap-ring trick), so the light join and the
    // spotlight budget never see them.
    if spec.arena.is_some() {
        for (cx, cz) in [(f[0] + 1.25, f[1] + 1.25), (f[2] - 1.25, f[1] + 1.25), (f[0] + 1.25, f[3] - 1.25), (f[2] - 1.25, f[3] - 1.25)] {
            place_service_lamp(&mut scene, cx, cz);
        }
    }

    // ---- goo traps: a glowing hazard ring on the floor at each emitter. A flat
    // emissive annulus (outer square minus inner square as four thin bars) reads
    // as a ring under the iso grid; the magenta glow contrasts the green goo.
    for tr in &spec.traps {
        // timed traps (off_tick != 0) are transient pulses, not standing hazards
        // — they don't get a permanent floor ring (it would linger inert after
        // the pulse expires).
        if tr.off_tick != 0 {
            continue;
        }
        place_trap_ring(&mut scene, tr.pos.x, tr.pos.z, 0.55);
    }

    // collision is the game's job; the scene only needs floor_rect + solids for
    // the playerless camera paths and the legacy mirror — but for the game the
    // GameLoop builds its Level straight from the spec, so these stay the
    // footprint (matches floor_bounds) and the spec solids verbatim.
    scene.floor_rect = f;
    scene.solids = spec.static_solids.clone();
    scene.player_start = Vec3::new(spec.player_start.x, FLOOR_TOP, spec.player_start.z);

    // mood: per-scene lighting env off the registry row (studio fill / dungeon
    // / daylit dollhouse / lamp-lit house — see SceneEntry::lighting).
    scene.lighting = crate::scene_registry::entry(&cfg.scene).lighting;
    scene
}

/// Centre of the room a light belongs to (its emissive box / point sits here,
/// near the ceiling).
fn room_center(spec: &LevelSpec, l: &LightSpec) -> Vec3 {
    let r = spec.rooms.iter().find(|r| r.id == l.room).map(|r| r.floor_rect).unwrap_or([0.0, 0.0, 1.0, 1.0]);
    Vec3::new((r[0] + r[2]) * 0.5, 2.0, (r[1] + r[3]) * 0.5)
}

/// Add an axis-aligned box spanning the XZ rect from the floor (y=0) to
/// `height`, with a solid color (no emission). Returns the first prim index.
fn box_world(scene: &mut Scene, rect: [f32; 4], height: f32, hex: u32) -> usize {
    let first = scene.primitives.len();
    scene.add_box_world(Vec3::new(rect[0], 0.0, rect[1]), Vec3::new(rect[2], height, rect[3]), hex_linear(hex), [0.0; 4], 0.85, 0.0);
    first
}

/// Flag a wall primitive's material as a see-through OCCLUDER (Material._pad = 1),
/// the bit the shade pass reads (`mats[h.mat].pad`) to know a primary-ray hit is
/// a wall the CAVE_ROI reveal may dither away. `add_box` mints one material per
/// box, so this targets exactly this wall. Floors/furniture/lights/doors/the
/// player/cut-away stubs are left at 0 and never dissolve.
fn mark_occluder(scene: &mut Scene, prim: usize) {
    let mid = scene.primitives[prim].material_id as usize;
    scene.materials[mid]._pad = 1;
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
/// stair-step multiples (invariant #8) — the analytic `TargetDisc` the game's
/// projectile sweep uses keeps the spec's `center`/`radius`, so snapping the
/// *rendered* greybox to the lattice does not move the hitbox. The disc's back
/// face sits at the wall plane (`center` is on the inner wall face), so the tie
/// (wall slab vs disc) does NOT block — exactly the projectile_system contract.
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
    // projectile-sweep tie does not occlude), front face two stair-steps into the room.
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

/// The sieve-slot gaps in a containment level's drain wall (L2/L3): scan the
/// static solids whose far z-edge lands ON the drain zone's near edge (the
/// authored sieve-wall segments), sort them along x, and return each gap
/// between neighbours as `[x0, x1, z0, z1]` (the gap's footprint at the wall's
/// own thickness). Empty when the level has no drain. Pure spec read — the
/// sim's collision never sees any of this.
pub fn sieve_slots(spec: &LevelSpec) -> Vec<[f32; 4]> {
    let Some(dz) = spec.drain else {
        return Vec::new();
    };
    let mut segs: Vec<[f32; 4]> = spec.static_solids.iter().filter(|s| (s[3] - dz[1]).abs() < 1e-3).copied().collect();
    if segs.len() < 2 {
        return Vec::new();
    }
    segs.sort_by(|a, b| a[0].partial_cmp(&b[0]).unwrap());
    let mut out = Vec::new();
    for w in segs.windows(2) {
        if w[1][0] - w[0][2] > 0.05 {
            out.push([w[0][2], w[1][0], w[0][1], w[0][3]]);
        }
    }
    out
}

/// L5: a corner service lamp — a graphite post wearing a small warm emissive
/// head. Registered as a never-patched dynamic run (the trap-ring trick) so
/// the head glows to camera WITHOUT entering the NEE light scan or the probe
/// bake: an orientation fixture, alive through rotation and the blackout act,
/// that zones the pit's edges against the dimmer mid-field.
fn place_service_lamp(scene: &mut Scene, cx: f32, cz: f32) {
    let first = scene.primitives.len();
    // post: one iso stair step square, hip height
    scene.add_box_world(Vec3::new(cx - 0.0625, FLOOR_TOP, cz - 0.0625), Vec3::new(cx + 0.0625, 1.125, cz + 0.0625), [0.16, 0.17, 0.18, 1.0], [0.0; 4], 0.6, 0.0);
    // warm head, just proud of the post
    scene.add_box_world(Vec3::new(cx - 0.125, 1.125, cz - 0.125), Vec3::new(cx + 0.125, 1.3125, cz + 0.125), [0.30, 0.24, 0.12, 1.0], [5.5, 4.2, 2.2, 1.0], 0.4, 0.0);
    scene.register_dynamic(&format!("svc_lamp_{cx}_{cz}"), first, scene.primitives.len() - first, Mat4::IDENTITY);
}

/// A glowing trap ring on the floor centred at (cx, cz), outer half-extent `r`.
/// Four thin emissive bars form a square annulus (a hazard ring) just above the
/// floor. Magenta emissive so it glows and reads distinct from the green goo.
fn place_trap_ring(scene: &mut Scene, cx: f32, cz: f32, r: f32) {
    let y0 = FLOOR_TOP + 0.001;
    let y1 = FLOOR_TOP + 0.06;
    let t = 0.0625; // bar thickness (one iso stair step)
    let bars = [
        [cx - r, cz - r, cx + r, cz - r + t], // north
        [cx - r, cz + r - t, cx + r, cz + r], // south
        [cx - r, cz - r, cx - r + t, cz + r], // west
        [cx + r - t, cz - r, cx + r, cz + r], // east
    ];
    let first = scene.primitives.len();
    for b in bars {
        scene.add_box_world(Vec3::new(b[0], y0, b[1]), Vec3::new(b[2], y1, b[3]), [0.2, 0.05, 0.25, 1.0], GOO_TRAP_EMISSIVE, 0.4, 0.0);
    }
    // register as a static dynamic run (identity transform, never patched) so the
    // emissive ring is EXCLUDED from the NEE light scan + frozen probe bake — it
    // glows to camera without being named as a game light.
    scene.register_dynamic(&format!("trap_ring_{cx}_{cz}"), first, scene.primitives.len() - first, Mat4::IDENTITY);
}

// ---- tiny-world board (the Larceny hamlet) ---------------------------------
// One tile = 1 wu² = one whole building — an Into-the-Breach diorama. Every
// prop is an axis-aligned coloured box whose XZ offsets/dims are multiples of
// 0.0625 wu (invariant #8; pinned by `board_props_are_iso_stair_aligned`).
// Heights are exempt (Y always projects fractional). District keys the house
// palette so poor/market/rich quarters read at a glance.

// ground tints (sRGB hex), two per kind for the subtle (x+z) checker that
// makes the tile grid read like a board.
const B_GRASS: [u32; 2] = [0x9ccb72, 0x94c36b];
const B_FOREST_FLOOR: [u32; 2] = [0x83b061, 0x7ba95a];
const B_ROAD: [u32; 2] = [0xd0b98d, 0xc7b085];
const B_PLAZA: [u32; 2] = [0xd8d2c2, 0xd0cab9];
const B_FIELD: [u32; 2] = [0xe3c977, 0xdbc06d];
const B_WATER: [u32; 2] = [0x7fb7d9, 0x79b1d3];
const B_YARD: [u32; 2] = [0xb9a67e, 0xb29f78]; // dirt apron under buildings
const B_CROP: u32 = 0xc9a94f;
const B_HEDGE: u32 = 0x5f9350;
const B_TRUNK: u32 = 0x8a6a4a;
const B_CANOPY: [u32; 2] = [0x639e52, 0x578f49];
const B_STONE: u32 = 0xb8b5ad;
const B_STONE_DARK: u32 = 0x6e6a61;
const B_AWNING: u32 = 0xd9583b; // the shop's coral accent (door-colour family)
const B_CRATE: u32 = 0xa08c6a;
// (body, roof) per district family
const B_HOUSE_POOR: (u32, u32) = (0xcfc0a5, 0x8d7b66);
const B_HOUSE_MARKET: (u32, u32) = (0xe8dfc8, 0xc26d4f);
const B_HOUSE_RICH: (u32, u32) = (0xf1ecdd, 0x4f7d86);
const B_SHACK: (u32, u32) = (0x7a6a52, 0x55604a);

/// A matte coloured box from explicit XZ + Y spans (the board prop primitive).
#[allow(clippy::too_many_arguments)] // private helper; the args ARE the box
fn bbox(scene: &mut Scene, x0: f32, z0: f32, x1: f32, z1: f32, y0: f32, y1: f32, hex: u32) {
    scene.add_box_world(Vec3::new(x0, y0, z0), Vec3::new(x1, y1, z1), hex_linear(hex), [0.0; 4], 0.85, 0.0);
}

/// Deterministic per-tile scramble for cosmetic variation (chimneys, tree
/// layouts) — stateless, so the board renders identically every build.
fn tile_hash(x: i32, z: i32) -> u32 {
    let mut h = (x as u32).wrapping_mul(0x9E37_79B9) ^ (z as u32).wrapping_mul(0x85EB_CA6B) ^ 0x5EED;
    h ^= h >> 13;
    h = h.wrapping_mul(0xC2B2_AE35);
    h ^ (h >> 16)
}

/// Build the whole board: one floor quad per tile (checker-tinted by kind)
/// plus the miniature prop for solid tiles. Collision is NOT built here — the
/// spec's board-derived `static_solids` carry it (one source of truth).
fn build_board(scene: &mut Scene, board: &BoardSpec) {
    for z in 0..board.h {
        for x in 0..board.w {
            let k = board.kind(x, z).unwrap();
            let d = board.district_at(x, z);
            let (tx, tz) = (x as f32, z as f32);
            let ck = ((x + z) & 1) as usize;
            let th = tile_hash(x, z);
            let ground = match k {
                TileKind::Grass | TileKind::Hedge => B_GRASS[ck],
                TileKind::Road | TileKind::Gate => B_ROAD[ck],
                TileKind::Plaza => B_PLAZA[ck],
                TileKind::Field => B_FIELD[ck],
                TileKind::Forest => B_FOREST_FLOOR[ck],
                TileKind::Water => B_WATER[ck],
                TileKind::Well => B_PLAZA[ck], // the square's paving runs under it
                _ => B_YARD[ck], // buildings sit on a dirt apron
            };
            scene.add_floor(tx, tx + 1.0, tz, tz + 1.0, FLOOR_TOP, hex_linear(ground));
            match k {
                TileKind::House => prop_house(scene, tx, tz, d, th),
                TileKind::Manor => prop_manor(scene, tx, tz),
                TileKind::Shop => prop_shop(scene, tx, tz),
                TileKind::Guardhouse => prop_guardhouse(scene, tx, tz),
                TileKind::FenceShack => prop_fence_shack(scene, tx, tz),
                TileKind::Well => prop_well(scene, tx, tz),
                TileKind::Hedge => bbox(scene, tx + 0.0625, tz + 0.0625, tx + 0.9375, tz + 0.9375, 0.0, 0.5, B_HEDGE),
                TileKind::Gate => prop_gate(scene, board, x, z),
                TileKind::Forest => prop_trees(scene, tx, tz, th),
                TileKind::Field => prop_crops(scene, tx, tz),
                _ => {}
            }
        }
    }
}

/// A one-tile house. District picks the family: POOR = squat tan hovel with a
/// flat roof; RICH = taller cream walls under a slate-teal roof; everything
/// else = the market family (plaster + terracotta). A third of the market and
/// rich houses grow a chimney off the tile hash.
fn prop_house(scene: &mut Scene, tx: f32, tz: f32, district: u8, th: u32) {
    let (body, roof) = match district {
        D_POOR => B_HOUSE_POOR,
        D_RICH => B_HOUSE_RICH,
        _ => B_HOUSE_MARKET,
    };
    if district == D_POOR {
        bbox(scene, tx + 0.1875, tz + 0.1875, tx + 0.8125, tz + 0.8125, 0.0, 0.4375, body);
        bbox(scene, tx + 0.125, tz + 0.125, tx + 0.875, tz + 0.875, 0.4375, 0.53125, roof);
        return;
    }
    let h = if district == D_RICH { 0.6875 } else { 0.5625 };
    bbox(scene, tx + 0.125, tz + 0.125, tx + 0.875, tz + 0.875, 0.0, h, body);
    bbox(scene, tx + 0.0625, tz + 0.0625, tx + 0.9375, tz + 0.9375, h, h + 0.15625, roof);
    if th % 3 == 0 {
        bbox(scene, tx + 0.625, tz + 0.1875, tx + 0.75, tz + 0.3125, h + 0.15625, h + 0.375, B_STONE_DARK);
    }
}

/// The manor: near-full-tile body, a two-tier roof, a chimney — the tallest
/// house silhouette on the board (the rich quarter's prize).
fn prop_manor(scene: &mut Scene, tx: f32, tz: f32) {
    let (body, roof) = B_HOUSE_RICH;
    bbox(scene, tx + 0.0625, tz + 0.0625, tx + 0.9375, tz + 0.9375, 0.0, 0.8125, body);
    bbox(scene, tx, tz, tx + 1.0, tz + 1.0, 0.8125, 0.90625, roof);
    bbox(scene, tx + 0.25, tz + 0.25, tx + 0.75, tz + 0.75, 0.90625, 1.0, roof);
    bbox(scene, tx + 0.25, tz + 0.25, tx + 0.375, tz + 0.375, 1.0, 1.1875, B_STONE_DARK);
}

/// The shop: a market house wearing a coral awning over its street face.
fn prop_shop(scene: &mut Scene, tx: f32, tz: f32) {
    let (body, roof) = B_HOUSE_MARKET;
    bbox(scene, tx + 0.125, tz + 0.125, tx + 0.875, tz + 0.875, 0.0, 0.5625, body);
    bbox(scene, tx + 0.0625, tz + 0.0625, tx + 0.9375, tz + 0.9375, 0.5625, 0.71875, roof);
    // awning: a thin slab sloping off the south (camera-facing) wall
    bbox(scene, tx + 0.125, tz + 0.75, tx + 0.875, tz + 1.0, 0.46875, 0.53125, B_AWNING);
}

/// The guardhouse: a stone watchtower with a dark cap — the tallest structure
/// on the board, and later the patrol's anchor.
fn prop_guardhouse(scene: &mut Scene, tx: f32, tz: f32) {
    bbox(scene, tx + 0.25, tz + 0.25, tx + 0.75, tz + 0.75, 0.0, 1.1875, B_STONE);
    bbox(scene, tx + 0.1875, tz + 0.1875, tx + 0.8125, tz + 0.8125, 1.1875, 1.3125, B_STONE_DARK);
}

/// The fence's shack: a low mossy hut with a stray crate — deliberately the
/// shabbiest building silhouette, hidden in the forest clearing.
fn prop_fence_shack(scene: &mut Scene, tx: f32, tz: f32) {
    let (body, roof) = B_SHACK;
    bbox(scene, tx + 0.1875, tz + 0.1875, tx + 0.8125, tz + 0.8125, 0.0, 0.375, body);
    bbox(scene, tx + 0.125, tz + 0.125, tx + 0.875, tz + 0.875, 0.375, 0.46875, roof);
    bbox(scene, tx + 0.6875, tz + 0.75, tx + 0.9375, tz + 1.0, 0.0, 0.1875, B_CRATE);
}

/// The well: a stone ring, two posts, a little roof — the market square's
/// centrepiece.
fn prop_well(scene: &mut Scene, tx: f32, tz: f32) {
    let (r0, r1, t) = (0.25, 0.75, 0.125);
    bbox(scene, tx + r0, tz + r0, tx + r1, tz + r0 + t, 0.0, 0.25, B_STONE); // north ring bar
    bbox(scene, tx + r0, tz + r1 - t, tx + r1, tz + r1, 0.0, 0.25, B_STONE); // south
    bbox(scene, tx + r0, tz + r0 + t, tx + r0 + t, tz + r1 - t, 0.0, 0.25, B_STONE); // west
    bbox(scene, tx + r1 - t, tz + r0 + t, tx + r1, tz + r1 - t, 0.0, 0.25, B_STONE); // east
    bbox(scene, tx + 0.4375, tz + 0.25, tx + 0.5625, tz + 0.375, 0.0, 0.5625, B_TRUNK); // posts
    bbox(scene, tx + 0.4375, tz + 0.625, tx + 0.5625, tz + 0.75, 0.0, 0.5625, B_TRUNK);
    bbox(scene, tx + 0.3125, tz + 0.3125, tx + 0.6875, tz + 0.6875, 0.5625, 0.65625, B_HOUSE_MARKET.1);
}

/// A gate: two stone posts flanking the walkable gap, oriented along the
/// hedge line they interrupt.
fn prop_gate(scene: &mut Scene, board: &BoardSpec, x: i32, z: i32) {
    let (tx, tz) = (x as f32, z as f32);
    let horizontal = board.kind(x - 1, z) == Some(TileKind::Hedge) || board.kind(x + 1, z) == Some(TileKind::Hedge);
    let post = |scene: &mut Scene, x0: f32, z0: f32| {
        bbox(scene, x0, z0, x0 + 0.125, z0 + 0.25, 0.0, 0.6875, B_STONE);
        bbox(scene, x0 - 0.0625, z0 - 0.0625, x0 + 0.1875, z0 + 0.3125, 0.6875, 0.78125, B_STONE_DARK);
    };
    if horizontal {
        post(scene, tx, tz + 0.375);
        post(scene, tx + 0.875, tz + 0.375);
    } else {
        let post_v = |scene: &mut Scene, z0: f32| {
            bbox(scene, tx + 0.375, z0, tx + 0.625, z0 + 0.125, 0.0, 0.6875, B_STONE);
            bbox(scene, tx + 0.3125, z0 - 0.0625, tx + 0.6875, z0 + 0.1875, 0.6875, 0.78125, B_STONE_DARK);
        };
        post_v(scene, tz);
        post_v(scene, tz + 0.875);
    }
}

/// A forest tile: one big + one small chunky tree, in one of three layouts
/// picked by the tile hash so the woods never tile visibly.
fn prop_trees(scene: &mut Scene, tx: f32, tz: f32, th: u32) {
    let (big, small) = match th % 3 {
        0 => ((0.1875, 0.1875), (0.5625, 0.5625)),
        1 => ((0.4375, 0.125), (0.125, 0.5625)),
        _ => ((0.3125, 0.375), (0.625, 0.0625)),
    };
    let tree = |scene: &mut Scene, ox: f32, oz: f32, canopy: f32, trunk_h: f32, canopy_h: f32, hex: u32| {
        let cx = tx + ox + canopy * 0.5;
        let cz = tz + oz + canopy * 0.5;
        bbox(scene, cx - 0.0625, cz - 0.0625, cx + 0.0625, cz + 0.0625, 0.0, trunk_h, B_TRUNK);
        bbox(scene, tx + ox, tz + oz, tx + ox + canopy, tz + oz + canopy, trunk_h - 0.0625, trunk_h - 0.0625 + canopy_h, hex);
    };
    tree(scene, big.0, big.1, 0.375, 0.375, 0.4375, B_CANOPY[(th & 1) as usize]);
    tree(scene, small.0, small.1, 0.25, 0.25, 0.3125, B_CANOPY[((th >> 1) & 1) as usize]);
}

/// A field tile: three low crop rows over the golden ground.
fn prop_crops(scene: &mut Scene, tx: f32, tz: f32) {
    for i in 0..3 {
        let z0 = tz + 0.125 + i as f32 * 0.3125;
        bbox(scene, tx + 0.125, z0, tx + 0.875, z0 + 0.125, FLOOR_TOP, FLOOR_TOP + 0.09375, B_CROP);
    }
}

// ---- player droid + weapon-ring geometry -----------------------------------
// All parts are LOCAL-space boxes around the origin (feet at y=0), placed by
// the per-frame "player"/"gun_N" instance transforms. XZ dims stay multiples
// of 0.0625 wu at rest so the axis-aligned body rasterizes clean stair
// silhouettes (the guns rotate with aim, so for them it only fixes the rest
// pose — acceptable: they are thin).

/// Year-2200 palette: clean white ceramic + amber accent (the project style).
const P_CERAMIC: [f32; 4] = [0.85, 0.86, 0.88, 1.0];
const P_GRAPHITE: [f32; 4] = [0.10, 0.11, 0.13, 1.0];
const P_AMBER_BASE: [f32; 4] = [0.25, 0.15, 0.05, 1.0];
const P_AMBER_GLOW: [f32; 4] = [4.5, 2.4, 0.7, 1.0];
const P_VISOR: [f32; 4] = [0.05, 0.06, 0.08, 1.0];
const P_VISOR_GLOW: [f32; 4] = [0.35, 0.65, 0.85, 1.0];

/// One local-space box part: XZ half-extents, a y span, colours. Matte
/// (roughness 0.5, metallic 0) like the old marker so the body keeps picking
/// up the coloured goo light pools and AO grounding.
fn part(scene: &mut Scene, hx: f32, hz: f32, y0: f32, y1: f32, color: [f32; 4], emissive: [f32; 4]) {
    scene.add_box_world(Vec3::new(-hx, y0, -hz), Vec3::new(hx, y1, hz), color, emissive, 0.5, 0.0);
}

/// A gun part authored along +Z (the aim axis): x half-extent, y span, z span.
#[allow(clippy::too_many_arguments)] // private box helper; the args ARE the box
fn gpart(scene: &mut Scene, hx: f32, y0: f32, y1: f32, z0: f32, z1: f32, color: [f32; 4], emissive: [f32; 4]) {
    scene.add_box_world(Vec3::new(-hx, y0, z0), Vec3::new(hx, y1, z1), color, emissive, 0.5, 0.0);
}

/// The BOARD protagonist — a human, not a droid (owner directive on the
/// Larceny pivot): a hooded thief in rust leathers with the project-amber
/// belt, ~1.0 wu tall so he reads person-sized against the one-tile houses.
/// Axis-aligned like the droid (crisp iso silhouette); every XZ dim a
/// 0.0625-wu multiple. Board scenes build HIM; every other scene keeps the
/// warden droid below, so the golden-pinned game/replay frames never move.
const H_SKIN: [f32; 4] = [0.82, 0.62, 0.47, 1.0];
const H_TUNIC: [f32; 4] = [0.48, 0.23, 0.15, 1.0]; // rust leather
const H_DARK: [f32; 4] = [0.26, 0.20, 0.13, 1.0]; // hood / boots
const H_BELT: [f32; 4] = [0.72, 0.51, 0.16, 1.0]; // amber (matte, no glow)

fn build_human_body(scene: &mut Scene) {
    part(scene, 0.09375, 0.09375, 0.00, 0.375, H_DARK, [0.0; 4]); // boots + legs
    part(scene, 0.15625, 0.125, 0.375, 0.6875, H_TUNIC, [0.0; 4]); // tunic torso
    part(scene, 0.1875, 0.125, 0.375, 0.4375, H_BELT, [0.0; 4]); // belt, proud of the hips
    part(scene, 0.09375, 0.09375, 0.6875, 0.9375, H_SKIN, [0.0; 4]); // head
    part(scene, 0.125, 0.125, 0.875, 1.0, H_DARK, [0.0; 4]); // hood
    part(scene, 0.0625, 0.0625, 1.0, 1.0625, H_DARK, [0.0; 4]); // hood point
}

/// The warden droid body (feet at local y=0): base 0.28 tall, torso to 0.92,
/// amber band proud of the torso at chest height, then a 0.08 hover gap and
/// the visored head. Total 1.26 — reads at the old 1.3-pillar scale, so the
/// ROI mid-height anchor (+0.65) and camera framing stay right.
fn build_player_body(scene: &mut Scene) {
    part(scene, 0.125, 0.125, 0.00, 0.28, P_GRAPHITE, [0.0; 4]); // base skirt
    part(scene, 0.1875, 0.1875, 0.28, 0.92, P_CERAMIC, [0.0; 4]); // torso
    part(scene, 0.21875, 0.21875, 0.52, 0.64, P_AMBER_BASE, P_AMBER_GLOW); // power band
    part(scene, 0.125, 0.125, 1.00, 1.26, P_CERAMIC, [0.0; 4]); // hovering head
    part(scene, 0.15625, 0.15625, 1.06, 1.18, P_VISOR, P_VISOR_GLOW); // visor wrap
}

/// One arsenal gun (slot 1–5), authored aiming +Z at hand height — the muzzle
/// tip lands near the flashlight/muzzle-flash pose (feet +0.95, 0.32 forward),
/// so the existing flash spotlight reads as firing FROM the barrel. Silhouette
/// first: each weapon must be tellable apart at ~20 screen px.
fn build_gun(scene: &mut Scene, slot: u8) {
    match slot {
        // SLUG rivet rifle: long heavy receiver + barrel, committed and slow.
        1 => {
            gpart(scene, 0.0625, 0.88, 1.02, 0.125, 0.4375, P_GRAPHITE, [0.0; 4]); // receiver
            gpart(scene, 0.03125, 0.925, 0.985, 0.4375, 0.75, P_CERAMIC, [0.0; 4]); // barrel
            gpart(scene, 0.05, 0.91, 1.0, 0.75, 0.8125, P_AMBER_BASE, P_AMBER_GLOW); // rivet head
            gpart(scene, 0.03125, 0.74, 0.88, 0.1875, 0.28125, P_GRAPHITE, [0.0; 4]); // grip
        }
        // UZI stitcher: stubby compact block, tiny snout.
        2 => {
            gpart(scene, 0.0625, 0.88, 1.0, 0.125, 0.375, P_GRAPHITE, [0.0; 4]); // body
            gpart(scene, 0.03125, 0.92, 0.97, 0.375, 0.53125, P_GRAPHITE, [0.0; 4]); // snout
            gpart(scene, 0.04, 0.915, 0.975, 0.53125, 0.578125, P_AMBER_BASE, P_AMBER_GLOW); // tip
            gpart(scene, 0.03125, 0.76, 0.88, 0.1875, 0.25, P_GRAPHITE, [0.0; 4]); // mag
        }
        // SHOTGUN: wide flat twin-barrel slab — the broadest silhouette.
        3 => {
            gpart(scene, 0.09375, 0.88, 1.0, 0.125, 0.34375, P_GRAPHITE, [0.0; 4]); // receiver
            gpart(scene, 0.09375, 0.92, 0.98, 0.34375, 0.65625, P_CERAMIC, [0.0; 4]); // twin barrels
            gpart(scene, 0.109375, 0.915, 0.985, 0.65625, 0.703125, P_AMBER_BASE, P_AMBER_GLOW); // muzzle band
        }
        // GRENADE launcher: fat white drum, unmistakably chunky.
        4 => {
            gpart(scene, 0.09375, 0.86, 1.04, 0.125, 0.46875, P_CERAMIC, [0.0; 4]); // drum
            gpart(scene, 0.109375, 0.89, 1.01, 0.46875, 0.53125, P_AMBER_BASE, P_AMBER_GLOW); // muzzle ring
            gpart(scene, 0.046875, 0.78, 0.86, 0.1875, 0.3125, P_GRAPHITE, [0.0; 4]); // under-grip
        }
        // HARPOON: the longest, thinnest profile — a rail with a hot prong.
        _ => {
            gpart(scene, 0.03125, 0.91, 0.97, 0.0625, 0.8125, P_GRAPHITE, [0.0; 4]); // rail
            gpart(scene, 0.05, 0.9, 0.98, 0.8125, 0.90625, P_AMBER_BASE, P_AMBER_GLOW); // prong
            gpart(scene, 0.0625, 0.84, 0.94, 0.125, 0.25, P_CERAMIC, [0.0; 4]); // reel
        }
    }
}

/// Register a pool of `count` named LOCAL-space emissive spheres ("<prefix>_0",
/// "<prefix>_1", …) as zero-scale dynamic instances — the reserved slots the
/// adapter skins onto live blobs / projectiles each frame. Shared by the goo
/// ellipsoid pool and the projectile tracer pool (same instance-mover path,
/// different tessellation / colours / radius).
#[allow(clippy::too_many_arguments)] // private helper; the args ARE the pool recipe
fn register_sphere_pool(scene: &mut Scene, prefix: &str, count: usize, rings: u32, sectors: u32, base: [f32; 4], emissive: [f32; 4], radius: f32) {
    for i in 0..count {
        let first = scene.add_sphere_local(rings, sectors, base, emissive, radius);
        scene.register_dynamic(&format!("{prefix}_{i}"), first, 1, Mat4::from_scale(Vec3::ZERO));
    }
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
        // a player run + four dynamic door runs (the player droid is a named
        // multi-prim dynamic now, not the legacy dynamic_prim single box)
        assert!(scene.dynamics.iter().any(|(n, ..)| n == "player"), "player run present");
        assert_eq!(scene.dynamics.len(), spec.doors.len() + 1, "player + one dynamic run per door");
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

    /// Every board prop box (houses, trees, hedges, the well, gate posts…)
    /// keeps its XZ corners AND dimensions on the iso 2:1 stair lattice
    /// (invariant #8) — the board equivalent of the target-box test above.
    /// Floors span whole tiles (integer edges), so they pass trivially; a
    /// prop authored at a sloppy 0.03-ish inset fails here before it ever
    /// smears a silhouette.
    #[test]
    fn board_props_are_iso_stair_aligned() {
        const STEP: f32 = 0.0625;
        let on_lattice = |v: f32| (v / STEP - (v / STEP).round()).abs() < 1e-4;
        let spec = house_game::hamlet_level(1);
        let mut scene = Scene::new();
        build_board(&mut scene, spec.board.as_ref().unwrap());
        assert!(scene.primitives.len() > 200, "the hamlet is a real diorama");
        for (pi, p) in scene.primitives.iter().enumerate() {
            let verts = &scene.vertices[p.vertex_offset as usize..(p.vertex_offset + p.vertex_count) as usize];
            let (mut xmin, mut xmax, mut zmin, mut zmax) = (f32::INFINITY, f32::NEG_INFINITY, f32::INFINITY, f32::NEG_INFINITY);
            for v in verts {
                xmin = xmin.min(v.pos[0]);
                xmax = xmax.max(v.pos[0]);
                zmin = zmin.min(v.pos[2]);
                zmax = zmax.max(v.pos[2]);
            }
            for (axis, v) in [("xmin", xmin), ("xmax", xmax), ("zmin", zmin), ("zmax", zmax)] {
                assert!(on_lattice(v), "board prim {pi}: {axis}={v} off the 0.0625 lattice");
            }
        }
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
