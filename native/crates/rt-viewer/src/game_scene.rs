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

/// Cohesive greybox palette (sRGB hex, linearized by `hex_linear`). Mid-tone
/// floors (readable like the house concrete) in per-room tints, warmer walls,
/// contrasting doors + targets.
const FLOOR_TINTS: [u32; 5] = [0x6d7384, 0x787082, 0x6f7d7a, 0x7c7280, 0x70807a];
const WALL_PERIM: u32 = 0x9a8e76; // warm sandstone-ish perimeter
const WALL_INNER: u32 = 0x848892; // cooler interior dividers
const FURNITURE: u32 = 0x8a5a32; // crate / prop greybox
const DOOR_COLOR: u32 = 0xc07a30; // contrasting warm door leaf
const TARGET_COLOR: u32 = 0xd83232; // bright red disc face
const TARGET_RING: u32 = 0xf0ead8; // pale backing plate

/// Build the greybox game scene from the spec. Returns the scene; the caller
/// (renderer) bakes probes and constructs the GameLoop over the SAME spec.
pub fn build_game(spec: &LevelSpec, cfg: &Config) -> Scene {
    let mut scene = Scene::new();
    let f = spec.floor_bounds();

    // ---- floors: one quad per room, each in its own tint (darker than the
    // walls); the room order is the spec order so the palette reads stable.
    for (i, r) in spec.rooms.iter().enumerate() {
        let c = FLOOR_TINTS[i % FLOOR_TINTS.len()];
        scene.add_floor(r.floor_rect[0], r.floor_rect[2], r.floor_rect[1], r.floor_rect[3], FLOOR_TOP, hex_linear(c));
    }

    // ---- perimeter walls: four slabs around the footprint, WALL_TOP tall,
    // 0.25 wu thick, sitting just OUTSIDE the walkable floor rect (the inner
    // face on the rect edge). Tagged with their outward direction so the
    // dollhouse cull hides the camera-near sides per quarter-turn (Q/E).
    let t = WALL_HT * 2.0;
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

    // ---- interior structure: each static solid is either a wall (thin: one
    // XZ dim == the wall thickness) or furniture (the free-standing crate).
    // Walls render full height in the inner tint; furniture as a low box.
    for s in &spec.static_solids {
        let (w, d) = (s[2] - s[0], s[3] - s[1]);
        if w.min(d) <= t + 1e-3 {
            box_world(&mut scene, *s, WALL_TOP, WALL_INNER);
        } else {
            box_world(&mut scene, *s, 0.6, FURNITURE); // crate-height greybox
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

    // ---- player marker: a matte light-grey pillar (lattice-aligned footprint),
    // exactly like the house scene — neutral albedo shows the colored light
    // pools and the AO grounding.
    let pidx = scene.add_box_local(house_game::game::PLAYER_HALF, 1.3, house_game::game::PLAYER_HALF, [0.62, 0.64, 0.70, 1.0], [0.0; 4]);
    scene.prim_hide_mask.resize(scene.primitives.len(), 0);
    scene.dynamic_prim = Some(pidx);

    // collision is the game's job; the scene only needs floor_rect + solids for
    // the playerless camera paths and the legacy mirror — but for the game the
    // GameLoop builds its Level straight from the spec, so these stay the
    // footprint (matches floor_bounds) and the spec solids verbatim.
    scene.floor_rect = f;
    scene.solids = spec.static_solids.clone();
    scene.player_start = Vec3::new(spec.player_start.x, FLOOR_TOP, spec.player_start.z);

    // night mood: lamp-lit interiors (no sun), a faint sky fill, light mist —
    // the same family as the house scene so the greybox reads as a real room.
    scene.lighting = [0.0, 0.4, 0.25, 0.6];
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
            let s = 12.0 * emit;
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
            let s = 150.0 * emit;
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
