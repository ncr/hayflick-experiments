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
    build_player_body(&mut scene);
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
