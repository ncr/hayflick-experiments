//! SCENE=thief — the M2 playable-slice greybox, built straight from the
//! thief sim's `TownGrid` (docs/spec/03: cells hold contents, EDGES hold
//! barriers). The same grid drives sim LOS/sound/light and these visuals, so
//! what blocks the eye blocks the cone — by construction.
//!
//! Greybox discipline (owner directive): colored boxes only, every XZ dim a
//! multiple of 0.0625 wu. One grid cell = 1 wu. Wall slabs are 0.25 wu thick,
//! centred on the shared edge; roofs are occluding caps. Occlusion is the
//! module-11 dollhouse: outdoors the buildings stand whole; indoors the
//! WALLCUT plane (`WALL_CUT_H` over the storey floor) drops every occluder
//! to sill height, and the storey FLOORCUT (`2.5·floor + 2.25`) lifts the
//! caps above the player's floor on upper storeys.
//!
//! The AESTHETIC is data: a [`ThiefLook`] preset (LOOK env, thief_look.rs)
//! supplies every colour, the lamp mood, the lighting env, and the shape-kit
//! switches (roof style, timber framing, plinths, body kit). `classic` takes
//! the Legacy code paths and reproduces the pre-look geometry byte-for-byte
//! — the pinned thief golden renders it.
//!
//! NEE discipline: the ONLY named lights are the spec lamps (conceptual point
//! lights). Every emissive box (loot chest, lamp fixtures, player bands) is
//! part of a dynamic run, which the light scan and probe bake exclude — so
//! the mirror light-join stays complete without naming dressing.

use crate::game_scene::{mark_occluder, DOOR_LEAF_H, WALL_TOP};
use crate::thief_look::{Kit, RoofStyle, ThiefLook};
use glam::{Mat4, Vec3};
use house_game::thief::grid::{CellKind, CellPos, Dir, EdgeKind, Prop, TownGrid};
use house_game::thief::perception::{Feature, Headwear};
use house_game::thief::sim::ThiefSpec;
use rt_probe::{hex_linear, Scene};

/// Storey pitch: floor f's walkable plane sits at `2.5·f` (the tower spike's
/// ceiling-slab top). The FLOORCUT plane for floor f is `2.5·f + 2.25` —
/// above the walls' top (2.1875), below the next slab's bottom.
pub const STOREY_H: f32 = 2.5;
/// The always-on reveal cut for a player on `floor` (M0 spike D, wired live).
pub fn cut_for_floor(floor: i8) -> f32 {
    STOREY_H * floor as f32 + 2.25
}
/// The WALLCUT sill-height cutaway plane (relative to the storey's floor):
/// above the window sills (0.9375), below everything a body owns — walls
/// drop to sill height while the player is indoors, bodies stay whole.
pub const WALL_CUT_H: f32 = 1.0;

const FLOOR_TOP: f32 = 6.0 / 128.0;
const WALL_HT: f32 = 0.125; // wall half-thickness (0.25 wu slab)
const SILL_H: f32 = 0.9375; // window sill top
const LINTEL_Y: f32 = 1.8125; // window/door lintel bottom

// Loot: a strongbox with a warm gleam (dynamic run — NEE never sees it).
// Shared across looks: gold gleams in every palette.
const CHEST_BASE: [f32; 4] = [0.30, 0.20, 0.10, 1.0];
const CHEST_GLOW: [f32; 4] = [3.2, 2.0, 0.6, 1.0];

/// A door edge discovered in the grid, in deterministic scan order — the
/// loop swings leaf `tdoor_<i>` by the live door state each frame.
#[derive(Clone, Copy, Debug)]
pub struct DoorRun {
    pub cell: CellPos,
    pub dir: Dir,
    /// World hinge (the leaf's local origin).
    pub hinge: Vec3,
}

/// Scan the grid's door edges in canonical (floor, z, x, [Zm, Xm]) order —
/// shared by the builder (registration) and the loop (state reads).
pub fn door_runs(grid: &TownGrid) -> Vec<DoorRun> {
    let mut out = Vec::new();
    for z in 0..grid.h {
        for x in 0..grid.w {
            let p = CellPos::new(x, z, 0);
            for dir in [Dir::Zm, Dir::Xm] {
                if let EdgeKind::Door(_) = grid.edge(p, dir) {
                    let hinge = match dir {
                        Dir::Zm => Vec3::new(x as f32, 0.0, z as f32),
                        _ => Vec3::new(x as f32, 0.0, z as f32),
                    };
                    out.push(DoorRun { cell: p, dir, hinge });
                }
            }
        }
    }
    out
}

/// The leaf transform at swing `angle` (0 = closed): rotate about the hinge.
pub fn door_leaf_at(d: &DoorRun, angle: f32) -> Mat4 {
    Mat4::from_translation(d.hinge) * Mat4::from_rotation_y(angle)
}

/// World centre of a grid cell (ground plane of its floor).
pub fn cell_world(p: CellPos) -> Vec3 {
    Vec3::new(p.x as f32 + 0.5, STOREY_H * p.floor as f32 + FLOOR_TOP, p.z as f32 + 0.5)
}

/// Build the renderable greybox for a thief level in the given look. Ground
/// floor only for the M2 spine (the grid supports stacked floors; M3's
/// towngen scenes extend the loops over `floor`).
pub fn build_thief(spec: &ThiefSpec, look: &ThiefLook) -> Scene {
    let mut scene = Scene::new();
    let g = &spec.grid;
    let (w, h) = (g.w, g.h);

    // ---- floors: one quad per row-run of same tint (cheap prim merge; a
    // checker look breaks street rows into per-cell quads — fine at spine
    // scale, revisit the merge before M3's big towns).
    for z in 0..h {
        let mut x = 0i16;
        while x < w {
            let tint = floor_tint(g, CellPos::new(x, z, 0), look);
            let x0 = x;
            while x < w && floor_tint(g, CellPos::new(x, z, 0), look) == tint {
                x += 1;
            }
            if let Some(c) = tint {
                scene.add_floor(x0 as f32, x as f32, z as f32, z as f32 + 1.0, FLOOR_TOP, hex_linear(c));
            }
        }
    }

    // ---- walls: merge consecutive wall edges along each boundary line.
    // Z-boundaries (edges between (x,z-1) and (x,z), drawn per cell's Zm):
    for z in 0..h {
        let mut x = 0i16;
        while x < w {
            let p = CellPos::new(x, z, 0);
            if g.edge(p, Dir::Zm) == EdgeKind::Wall {
                let x0 = x;
                while x < w && g.edge(CellPos::new(x, z, 0), Dir::Zm) == EdgeKind::Wall {
                    x += 1;
                }
                wall_slab(&mut scene, [x0 as f32 - WALL_HT, z as f32 - WALL_HT, x as f32 + WALL_HT, z as f32 + WALL_HT], true, look);
            } else {
                barrier_dress(&mut scene, g.edge(p, Dir::Zm), [x as f32, z as f32 - WALL_HT, x as f32 + 1.0, z as f32 + WALL_HT], look);
                x += 1;
            }
        }
    }
    // X-boundaries (per cell's Xm):
    for x in 0..w {
        let mut z = 0i16;
        while z < h {
            let p = CellPos::new(x, z, 0);
            if g.edge(p, Dir::Xm) == EdgeKind::Wall {
                let z0 = z;
                while z < h && g.edge(CellPos::new(x, z, 0), Dir::Xm) == EdgeKind::Wall {
                    z += 1;
                }
                wall_slab(&mut scene, [x as f32 - WALL_HT, z0 as f32 - WALL_HT, x as f32 + WALL_HT, z as f32 + WALL_HT], false, look);
            } else {
                barrier_dress(&mut scene, g.edge(p, Dir::Xm), [x as f32 - WALL_HT, z as f32, x as f32 + WALL_HT, z as f32 + 1.0], look);
                z += 1;
            }
        }
    }

    // ---- roofs: an occluding cap over every Room cell (merged per row).
    // Visible from the street (buildings read as buildings); the WALLCUT
    // indoor cutaway dissolves them (occluder-marked) the moment the player
    // steps inside. Every roof box sits ENTIRELY above the storey FLOORCUT
    // plane (bases ≥ 2.3125 vs the 2.25 cut) so the M3 multi-floor cap-lift
    // removes them cleanly too.
    for z in 0..h {
        let mut x = 0i16;
        while x < w {
            let roomy = matches!(g.cell(CellPos::new(x, z, 0)).kind, CellKind::Room(_));
            if roomy {
                let x0 = x;
                while x < w && matches!(g.cell(CellPos::new(x, z, 0)).kind, CellKind::Room(_)) {
                    x += 1;
                }
                roof_run(&mut scene, x0 as f32, x as f32, z as f32, look);
            } else {
                x += 1;
            }
        }
    }

    // ---- props: furniture crates + hay carts (hiding spots).
    for z in 0..h {
        for x in 0..w {
            let p = CellPos::new(x, z, 0);
            let (x0, z0) = (x as f32, z as f32);
            match g.cell(p).prop {
                Prop::Furniture => {
                    scene.add_box_world(Vec3::new(x0 + 0.125, FLOOR_TOP, z0 + 0.125), Vec3::new(x0 + 0.875, 0.625, z0 + 0.875), hex_linear(look.furn), [0.0; 4], 0.85, 0.0);
                }
                Prop::HidingSpot => {
                    // a hay cart: low tan mound + two dark axles — enterable
                    // concealment, deliberately NOT an occluder
                    scene.add_box_world(Vec3::new(x0 + 0.0625, FLOOR_TOP, z0 + 0.0625), Vec3::new(x0 + 0.9375, 0.6875, z0 + 0.9375), hex_linear(look.hay), [0.0; 4], 0.9, 0.0);
                    scene.add_box_world(Vec3::new(x0 + 0.125, FLOOR_TOP, z0 + 0.375), Vec3::new(x0 + 0.875, 0.25, z0 + 0.625), [0.15, 0.12, 0.09, 1.0], [0.0; 4], 0.7, 0.0);
                }
                Prop::None => {}
            }
        }
    }

    // ---- lamps: the spec's sim light sources, as NAMED conceptual point
    // lights (the ONLY named lights — the mirror join sees exactly these) +
    // an unnamed fixture post per lamp, registered as a never-patched
    // dynamic run so its glow head stays out of the NEE scan and probe bake.
    for (i, (cell, intensity)) in spec.lights.iter().enumerate() {
        let c = cell_world(*cell);
        let s = 620.0 * (*intensity as f32 / 8.0) * look.lamp_scale;
        scene.point_lights.push([c.x, 2.0, c.z, 0.25, s * look.lamp_tint[0], s * look.lamp_tint[1], s * look.lamp_tint[2], 0.0]);
        scene.name_point_light(&format!("lamp_{i}"), scene.point_lights.len() - 1);
        let first = scene.primitives.len();
        match look.kit {
            Kit::Legacy => {
                scene.add_box_world(Vec3::new(c.x - 0.0625, FLOOR_TOP, c.z - 0.0625), Vec3::new(c.x + 0.0625, 1.6875, c.z + 0.0625), look.lamp_post, [0.0; 4], 0.6, 0.0);
                scene.add_box_world(Vec3::new(c.x - 0.125, 1.6875, c.z - 0.125), Vec3::new(c.x + 0.125, 1.875, c.z + 0.125), look.lamp_head, look.lamp_glow, 0.4, 0.0);
            }
            Kit::Refined => {
                // pedestal, slim post, glowing lantern head, cap
                scene.add_box_world(Vec3::new(c.x - 0.09375, FLOOR_TOP, c.z - 0.09375), Vec3::new(c.x + 0.09375, 0.25, c.z + 0.09375), look.lamp_post, [0.0; 4], 0.6, 0.0);
                scene.add_box_world(Vec3::new(c.x - 0.03125, 0.25, c.z - 0.03125), Vec3::new(c.x + 0.03125, 1.6875, c.z + 0.03125), look.lamp_post, [0.0; 4], 0.6, 0.0);
                scene.add_box_world(Vec3::new(c.x - 0.09375, 1.6875, c.z - 0.09375), Vec3::new(c.x + 0.09375, 1.875, c.z + 0.09375), look.lamp_head, look.lamp_glow, 0.4, 0.0);
                scene.add_box_world(Vec3::new(c.x - 0.125, 1.875, c.z - 0.125), Vec3::new(c.x + 0.125, 1.9375, c.z + 0.125), look.lamp_post, [0.0; 4], 0.6, 0.0);
            }
        }
        scene.register_dynamic(&format!("lamp_fix_{i}"), first, scene.primitives.len() - first, Mat4::IDENTITY);
    }

    scene.recompute_bounds();

    // ---- dynamics (after recompute_bounds, local space): the two player
    // bodies, one body per NPC, the loot chest, and one leaf per door edge.
    let first = scene.primitives.len();
    build_player_body(&mut scene, look, look.coat_green, Some(look.hood_green));
    scene.register_dynamic("tplayer_a", first, scene.primitives.len() - first, Mat4::from_scale(Vec3::ZERO));
    let first = scene.primitives.len();
    build_player_body(&mut scene, look, look.coat_brown, None);
    scene.register_dynamic("tplayer_b", first, scene.primitives.len() - first, Mat4::from_scale(Vec3::ZERO));
    for n in &spec.npcs {
        let first = scene.primitives.len();
        match n.role {
            house_game::thief::sim::Role::Guard => build_guard_body(&mut scene, look),
            house_game::thief::sim::Role::Civilian => build_civilian_body(&mut scene, look),
        }
        scene.register_dynamic(&format!("npc_{}", n.id), first, scene.primitives.len() - first, Mat4::from_scale(Vec3::ZERO));
    }
    let first = scene.primitives.len();
    scene.add_box_world(Vec3::new(-0.25, 0.0, -0.1875), Vec3::new(0.25, 0.3125, 0.1875), CHEST_BASE, [0.0; 4], 0.6, 0.0);
    scene.add_box_world(Vec3::new(-0.1875, 0.3125, -0.125), Vec3::new(0.1875, 0.4375, 0.125), CHEST_BASE, CHEST_GLOW, 0.5, 0.0);
    scene.register_dynamic("loot", first, scene.primitives.len() - first, Mat4::from_scale(Vec3::ZERO));
    for (i, d) in door_runs(g).iter().enumerate() {
        let first = scene.primitives.len();
        // leaf local box: hinge at origin, spanning the edge's 1-wu run
        let (lo, hi) = match d.dir {
            Dir::Zm | Dir::Zp => (Vec3::new(0.0, 0.0, -WALL_HT), Vec3::new(1.0, DOOR_LEAF_H, WALL_HT)),
            _ => (Vec3::new(-WALL_HT, 0.0, 0.0), Vec3::new(WALL_HT, DOOR_LEAF_H, 1.0)),
        };
        scene.add_box_world(lo, hi, hex_linear(look.door), [0.0; 4], 0.8, 0.0);
        scene.register_dynamic(&format!("tdoor_{i}"), first, scene.primitives.len() - first, door_leaf_at(d, 0.0));
    }

    scene.floor_rect = [0.0, 0.0, w as f32, h as f32];
    scene.solids = Vec::new(); // collision is the thief sim's grid, not AABBs
    let ps = cell_world(spec.player_start);
    scene.player_start = ps;
    // the look's mood; the shell scales sky by the sim's day phase
    scene.lighting = look.lighting;
    scene
}

fn floor_tint(g: &TownGrid, p: CellPos, look: &ThiefLook) -> Option<u32> {
    match g.cell(p).kind {
        CellKind::Void => None,
        CellKind::Outdoor => Some(match look.street_alt {
            // cobble checker: per-cell parity split (breaks the row merge)
            Some(alt) if (p.x + p.z) & 1 == 1 => alt,
            _ => look.street,
        }),
        CellKind::Room(r) => Some(look.room_floors[r as usize % look.room_floors.len()]),
    }
}

/// One merged wall slab + the look's dress: an optional skirting plinth
/// (below the WALLCUT — it survives the cutaway and grounds the wall stubs)
/// and optional half-timber framing (posts on every cell boundary + a
/// lintel-height rail, occluder-marked so the cutaway takes them with the
/// wall). `along_x` says which axis the run spans.
fn wall_slab(scene: &mut Scene, rect: [f32; 4], along_x: bool, look: &ThiefLook) {
    let first = scene.primitives.len();
    scene.add_box_world(Vec3::new(rect[0], 0.0, rect[1]), Vec3::new(rect[2], WALL_TOP, rect[3]), hex_linear(look.wall), [0.0; 4], 0.85, 0.0);
    mark_occluder(scene, first);
    if let Some(hexp) = look.plinth {
        scene.add_box_world(Vec3::new(rect[0] - 0.0625, 0.0, rect[1] - 0.0625), Vec3::new(rect[2] + 0.0625, 0.1875, rect[3] + 0.0625), hex_linear(hexp), [0.0; 4], 0.85, 0.0);
    }
    if let Some(hext) = look.timber {
        let tc = hex_linear(hext);
        // posts at every integer boundary along the run (both ends included)
        let (a0, a1) = if along_x { (rect[0] + WALL_HT, rect[2] - WALL_HT) } else { (rect[1] + WALL_HT, rect[3] - WALL_HT) };
        let mut k = a0;
        while k <= a1 + 0.001 {
            let first = scene.primitives.len();
            let (lo, hi) = if along_x {
                (Vec3::new(k - 0.09375, 0.0, rect[1] - 0.0625), Vec3::new(k + 0.09375, WALL_TOP, rect[3] + 0.0625))
            } else {
                (Vec3::new(rect[0] - 0.0625, 0.0, k - 0.09375), Vec3::new(rect[2] + 0.0625, WALL_TOP, k + 0.09375))
            };
            scene.add_box_world(lo, hi, tc, [0.0; 4], 0.8, 0.0);
            mark_occluder(scene, first);
            k += 1.0;
        }
        // lintel-height rail spanning the whole run
        let first = scene.primitives.len();
        scene.add_box_world(Vec3::new(rect[0] - 0.0625, LINTEL_Y, rect[1] - 0.0625), Vec3::new(rect[2] + 0.0625, LINTEL_Y + 0.09375, rect[3] + 0.0625), tc, [0.0; 4], 0.8, 0.0);
        mark_occluder(scene, first);
    }
}

/// One merged roof run in the look's silhouette. Every box is an occluder
/// (both dollhouse cuts must take it) with its base above the 2.25 FLOORCUT.
fn roof_run(scene: &mut Scene, x0: f32, x1: f32, z: f32, look: &ThiefLook) {
    let rc = hex_linear(look.roof);
    let first = scene.primitives.len();
    scene.add_box_world(Vec3::new(x0 - 0.25, STOREY_H - 0.125, z), Vec3::new(x1 + 0.25, STOREY_H, z + 1.0), rc, [0.0; 4], 0.85, 0.0);
    mark_occluder(scene, first);
    if let Some(hexf) = look.fascia {
        // a slightly wider eave lip under the cap
        let first = scene.primitives.len();
        scene.add_box_world(Vec3::new(x0 - 0.3125, STOREY_H - 0.1875, z), Vec3::new(x1 + 0.3125, STOREY_H - 0.125, z + 1.0), hex_linear(hexf), [0.0; 4], 0.85, 0.0);
        mark_occluder(scene, first);
    }
    if look.roof_style == RoofStyle::Ridged {
        // a raised ridge strip per row — standing seams / tiled ridges
        let first = scene.primitives.len();
        scene.add_box_world(Vec3::new(x0 - 0.125, STOREY_H, z + 0.25), Vec3::new(x1 + 0.125, STOREY_H + 0.09375, z + 0.75), hex_linear(look.roof_trim), [0.0; 4], 0.85, 0.0);
        mark_occluder(scene, first);
    }
}

/// Non-wall barriers get partial dress: a window is a sill + lintel gap, a
/// door edge gets a lintel over the (dynamic) leaf. Open edges get nothing.
fn barrier_dress(scene: &mut Scene, e: EdgeKind, rect: [f32; 4], look: &ThiefLook) {
    match e {
        EdgeKind::Window(_) => {
            let first = scene.primitives.len();
            scene.add_box_world(Vec3::new(rect[0], 0.0, rect[1]), Vec3::new(rect[2], SILL_H, rect[3]), hex_linear(look.sill), [0.0; 4], 0.85, 0.0);
            scene.add_box_world(Vec3::new(rect[0], LINTEL_Y, rect[1]), Vec3::new(rect[2], WALL_TOP, rect[3]), hex_linear(look.wall), [0.0; 4], 0.85, 0.0);
            mark_occluder(scene, first + 1);
        }
        EdgeKind::Door(_) => {
            let first = scene.primitives.len();
            scene.add_box_world(Vec3::new(rect[0], DOOR_LEAF_H, rect[1]), Vec3::new(rect[2], WALL_TOP, rect[3]), hex_linear(look.wall), [0.0; 4], 0.85, 0.0);
            mark_occluder(scene, first);
        }
        _ => {}
    }
}

// ---- bodies ---------------------------------------------------------------
//
// Legacy kit: the chunky pre-look figures (classic — golden-pinned).
// Refined kit: tailored figures (~1.34 wu): boots / slim legs / flared coat
// skirt / belt / torso / head, a hood cap + back drape for outfit A, helm +
// pauldrons + crest + spear for the guard, a brimmed hat for the civilian.
// All keep the nose wedge so facing reads, and all survive the hidden-crouch
// y-squash (0.35) the loop applies when the player goes to ground.

fn build_player_body(scene: &mut Scene, look: &ThiefLook, coat: [f32; 4], hood: Option<[f32; 4]>) {
    match look.kit {
        Kit::Legacy => build_thief_body_legacy(scene, look, coat, hood),
        Kit::Refined => {
            tailored_base(scene, look.boots, look.legs, coat);
            part(scene, 0.09375, 0.09375, 1.03125, 1.28125, look.skin, [0.0; 4]); // head
            if let Some(hd) = hood {
                part(scene, 0.125, 0.125, 1.1875, 1.34375, hd, [0.0; 4]); // hood cap
                // back drape (nose is +Z, so the drape hangs at -Z)
                scene.add_box_world(Vec3::new(-0.09375, 0.78125, -0.21875), Vec3::new(0.09375, 1.1875, -0.09375), hd, [0.0; 4], 0.6, 0.0);
            }
            nose(scene, look.skin, 1.09375, 0.09375);
        }
    }
}

fn build_guard_body(scene: &mut Scene, look: &ThiefLook) {
    match look.kit {
        Kit::Legacy => build_npc_body_legacy(scene, look, look.guard_coat, Some(look.guard_helm)),
        Kit::Refined => {
            part(scene, 0.125, 0.09375, 0.0, 0.1875, look.boots, [0.0; 4]); // boots
            part(scene, 0.09375, 0.09375, 0.1875, 0.46875, look.npc_legs, [0.0; 4]); // legs
            part(scene, 0.15625, 0.125, 0.46875, 1.0, look.guard_coat, [0.0; 4]); // tabard
            part(scene, 0.1875, 0.15625, 0.65625, 0.71875, look.boots, [0.0; 4]); // duty belt
            // pauldrons
            scene.add_box_world(Vec3::new(0.15625, 0.9375, -0.09375), Vec3::new(0.28125, 1.0625, 0.09375), look.guard_helm, [0.0; 4], 0.6, 0.0);
            scene.add_box_world(Vec3::new(-0.28125, 0.9375, -0.09375), Vec3::new(-0.15625, 1.0625, 0.09375), look.guard_helm, [0.0; 4], 0.6, 0.0);
            part(scene, 0.09375, 0.09375, 1.0, 1.25, look.skin, [0.0; 4]); // head
            part(scene, 0.125, 0.125, 1.1875, 1.34375, look.guard_helm, [0.0; 4]); // helm
            part(scene, 0.03125, 0.09375, 1.34375, 1.4375, look.guard_coat, [0.0; 4]); // crest
            // spear at the right hand: pole + steel tip
            scene.add_box_world(Vec3::new(0.1875, 0.0, -0.03125), Vec3::new(0.25, 1.625, 0.03125), look.boots, [0.0; 4], 0.6, 0.0);
            scene.add_box_world(Vec3::new(0.1875, 1.625, -0.03125), Vec3::new(0.25, 1.8125, 0.03125), look.guard_helm, [0.0; 4], 0.4, 0.0);
            nose(scene, look.skin, 1.0625, 0.09375);
        }
    }
}

fn build_civilian_body(scene: &mut Scene, look: &ThiefLook) {
    match look.kit {
        Kit::Legacy => build_npc_body_legacy(scene, look, look.civ_coat, None),
        Kit::Refined => {
            tailored_base(scene, look.boots, look.npc_legs, look.civ_coat);
            part(scene, 0.09375, 0.09375, 1.03125, 1.28125, look.skin, [0.0; 4]); // head
            part(scene, 0.1875, 0.1875, 1.21875, 1.28125, look.boots, [0.0; 4]); // hat brim
            part(scene, 0.09375, 0.09375, 1.28125, 1.40625, look.boots, [0.0; 4]); // hat crown
            nose(scene, look.skin, 1.09375, 0.09375);
        }
    }
}

/// Boots / slim legs / flared coat skirt / leather belt / torso — the shared
/// lower body of the Refined figures (player + civilian).
fn tailored_base(scene: &mut Scene, boots: [f32; 4], legs: [f32; 4], coat: [f32; 4]) {
    part(scene, 0.125, 0.09375, 0.0, 0.1875, boots, [0.0; 4]);
    part(scene, 0.09375, 0.09375, 0.1875, 0.46875, legs, [0.0; 4]);
    part(scene, 0.1875, 0.15625, 0.46875, 0.71875, coat, [0.0; 4]); // skirt
    part(scene, 0.15625, 0.125, 0.71875, 0.78125, boots, [0.0; 4]); // belt
    part(scene, 0.15625, 0.125, 0.78125, 1.03125, coat, [0.0; 4]); // torso
}

/// The facing-read wedge on +Z at the given base height / face plane.
fn nose(scene: &mut Scene, skin: [f32; 4], y0: f32, face_z: f32) {
    scene.add_box_world(Vec3::new(-0.03125, y0, face_z), Vec3::new(0.03125, y0 + 0.09375, face_z + 0.0625), skin, [0.0; 4], 0.8, 0.0);
}

/// A chunky readable figure (~1.31 wu tall ≈ 60 low px): boots, coat, head,
/// optional hood/helm cap, and a small nose wedge so facing reads even
/// axis-aligned (NPC bodies rotate whole; the nose gives the player's four
/// facings a read too). Local space, feet at y=0. (The Legacy kit — the
/// classic golden renders these exact boxes.)
fn build_thief_body_legacy(scene: &mut Scene, look: &ThiefLook, coat: [f32; 4], hood: Option<[f32; 4]>) {
    part(scene, 0.125, 0.125, 0.0, 0.375, look.legs, [0.0; 4]); // legs
    part(scene, 0.1875, 0.15625, 0.375, 0.9375, coat, [0.0; 4]); // coat
    part(scene, 0.125, 0.125, 0.9375, 1.25, look.skin, [0.0; 4]); // head
    if let Some(hd) = hood {
        part(scene, 0.15625, 0.15625, 1.09375, 1.3125, hd, [0.0; 4]); // hood cap
    }
    // nose wedge on +Z (the body run rotates to facing)
    scene.add_box_world(Vec3::new(-0.0625, 1.0, 0.125), Vec3::new(0.0625, 1.125, 0.21875), look.skin, [0.0; 4], 0.8, 0.0);
}

fn build_npc_body_legacy(scene: &mut Scene, look: &ThiefLook, coat: [f32; 4], helm: Option<[f32; 4]>) {
    part(scene, 0.125, 0.125, 0.0, 0.375, look.npc_legs, [0.0; 4]);
    part(scene, 0.1875, 0.15625, 0.375, 0.9375, coat, [0.0; 4]);
    part(scene, 0.125, 0.125, 0.9375, 1.25, look.skin, [0.0; 4]);
    if let Some(hm) = helm {
        part(scene, 0.15625, 0.15625, 1.15625, 1.3125, hm, [0.0; 4]);
    }
    scene.add_box_world(Vec3::new(-0.0625, 1.0, 0.125), Vec3::new(0.0625, 1.125, 0.21875), look.skin, [0.0; 4], 0.8, 0.0);
}

fn part(scene: &mut Scene, hx: f32, hz: f32, y0: f32, y1: f32, color: [f32; 4], emissive: [f32; 4]) {
    scene.add_box_world(Vec3::new(-hx, y0, -hz), Vec3::new(hx, y1, hz), color, emissive, 0.6, 0.0);
}

/// Which player body run is visible for a live look (hooded ⇒ the green
/// working look; anything else ⇒ the shed brown look).
pub fn player_run_for_look(look: &house_game::thief::perception::Description) -> &'static str {
    if look.headwear == Feature::Seen(Headwear::Hood) {
        "tplayer_a"
    } else {
        "tplayer_b"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::thief_look::{CLASSIC, LOOKS};
    use house_game::thief::sim::spine_level;

    /// EVERY look preset produces the runs the loop patches: two player
    /// bodies, one per NPC, the loot chest, one leaf per door edge — and
    /// keeps the NEE discipline (the only named lights are the spec lamps;
    /// dressing stays in dynamic runs / non-emissive statics).
    #[test]
    fn every_look_registers_the_expected_runs() {
        for look in LOOKS {
            let spec = spine_level();
            let scene = build_thief(&spec, look);
            for name in ["tplayer_a", "tplayer_b", "npc_1", "npc_2", "loot", "tdoor_0", "tdoor_1"] {
                assert!(scene.dynamics.iter().any(|(n, ..)| n == name), "{}: missing run {name}", look.name);
            }
            assert_eq!(door_runs(&spec.grid).len(), 2, "the spine has two door edges");
            // the only NEE lights are the named lamps
            let scan = rt_probe::scan_lights(&scene).unwrap();
            assert_eq!(scan.light_count as usize, spec.lights.len(), "{}: lamps only — dressing must stay in dynamic runs", look.name);
            assert_eq!(scan.names.len(), spec.lights.len());
        }
    }

    /// Roof dressing (every look) sits entirely above the FLOORCUT plane —
    /// the M3 multi-floor cap-lift must remove roofs in one clean cut.
    #[test]
    fn roof_boxes_clear_the_floorcut_plane() {
        for look in LOOKS {
            let mut scene = Scene::new();
            roof_run(&mut scene, 0.0, 4.0, 0.0, look);
            for p in 0..scene.primitives.len() {
                let prim = scene.primitives[p];
                let base = (0..prim.vertex_count).map(|i| scene.vertices[(prim.vertex_offset + i) as usize].pos[1]).fold(f32::INFINITY, f32::min);
                assert!(base > cut_for_floor(0), "{}: roof box base {base} under the 2.25 cut", look.name);
                assert_eq!(scene.materials[prim.material_id as usize]._pad, 1, "{}: roof box not occluder-marked", look.name);
            }
        }
    }

    #[test]
    fn cut_plane_sits_inside_the_ceiling_gap() {
        assert_eq!(cut_for_floor(0), 2.25);
        assert!(cut_for_floor(0) > WALL_TOP && cut_for_floor(0) < STOREY_H);
        assert_eq!(cut_for_floor(1), 4.75);
    }

    /// The indoor cutaway plane clears the window sills (they stay, so the
    /// cut reads as walls dropping TO sill height) and undercuts every
    /// lintel and the wall tops (they go).
    #[test]
    #[allow(clippy::assertions_on_constants)] // a deliberate constants-relationship pin
    fn wall_cut_sits_above_sills_below_lintels() {
        assert!(WALL_CUT_H > SILL_H, "sills must survive the cutaway");
        assert!(WALL_CUT_H < LINTEL_Y && WALL_CUT_H < WALL_TOP, "lintels and wall tops must dissolve");
    }

    /// The classic preset is the golden look: spot-pin the values that place
    /// its geometry so a preset edit can't silently move the pinned frame.
    #[test]
    fn classic_is_the_frozen_legacy_kit() {
        assert!(matches!(CLASSIC.kit, crate::thief_look::Kit::Legacy));
        assert!(matches!(CLASSIC.roof_style, crate::thief_look::RoofStyle::FlatCap));
        assert!(CLASSIC.street_alt.is_none() && CLASSIC.timber.is_none() && CLASSIC.plinth.is_none());
        assert_eq!(CLASSIC.lighting, [0.0, 5.5, 0.22, 0.42]);
        assert_eq!(CLASSIC.lamp_scale, 1.0);
        assert_eq!(CLASSIC.lamp_tint, [1.0, 0.82, 0.58]);
    }
}
