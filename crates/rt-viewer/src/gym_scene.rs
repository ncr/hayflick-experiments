//! The gym greybox, built straight from the sim's `Grid` (cells hold ground,
//! EDGES hold walls). The same grid drives sim collision and these visuals,
//! so what blocks the walk blocks the eye — by construction.
//!
//! Greybox discipline (owner directive): colored boxes only, one grid cell =
//! 1 wu, ARCHITECTURE XZ dims on the 0.1-wu grid — the trimetric preset's
//! clean-stair lattice (1/10 wu along X, 1/20 along Z; see
//! `Projection::clean_xz`). No grid is clean under BOTH presets: tenths show
//! mixed treads under the iso21 A/B reference — the game projection wins.
//! The PLAYER body still sits on the legacy 1/16 lattice: it is animated
//! (treads invisible in motion) and Faza 2 rebuilds it anyway. Wall slabs
//! are 0.2 wu thick, centred on the shared edge; the building's roof is an
//! occluding cap. Occlusion is the dollhouse WALLCUT: outdoors the building
//! stands whole; indoors every occluder drops to sill height (`WALL_CUT_H`).
//!
//! The AESTHETIC is data: a [`Look`] preset (LOOK env, look.rs) supplies
//! every colour, the lamp mood, the lighting env and the dress switches.
//! The Faza-1 joyful looks replace the presets; the machinery stays.
//!
//! NEE discipline: the ONLY named lights are the spec lamps (conceptual point
//! lights). Every emissive box (lamp fixtures) is part of a dynamic run,
//! which the light scan and probe bake exclude — so the light-join stays
//! complete without naming dressing.

use crate::look::{Look, RoofStyle};
use glam::{Mat4, Vec3};
use house_game::gym::grid::{CellKind, CellPos, Dir, EdgeKind, Grid};
use house_game::gym::sim::GymLevel;
use rt_probe::{hex_linear, Scene};

/// Wall height (the building's occluding shell).
pub const WALL_TOP: f32 = 2.1875;
/// The WALLCUT sill-height cutaway plane: while the player is indoors, walls
/// drop to this height, bodies stay whole.
pub const WALL_CUT_H: f32 = 1.0;

const FLOOR_TOP: f32 = 6.0 / 128.0;
const WALL_HT: f32 = 0.1; // wall half-thickness (0.2 wu slab, on the 0.1 grid)
const RAIL_Y: f32 = 1.8125; // half-timber rail height
const ROOF_BASE: f32 = 2.375;
const ROOF_TOP: f32 = 2.5;

/// Flag a primitive's material as a see-through OCCLUDER (Material._pad = 1),
/// the bit the shade pass reads to know a primary-ray hit is a wall the ROI
/// reveal / WALLCUT may dissolve. `add_box_world` mints one material per box,
/// so this targets exactly this box. Floors and bodies stay 0.
fn mark_occluder(scene: &mut Scene, prim: usize) {
    let mid = scene.primitives[prim].material_id as usize;
    scene.materials[mid]._pad = 1;
}

/// World centre of a grid cell (on the ground plane).
pub fn cell_world(p: CellPos) -> Vec3 {
    Vec3::new(p.x as f32 + 0.5, FLOOR_TOP, p.z as f32 + 0.5)
}

/// Build the renderable greybox for the gym in the given look.
pub fn build_gym(spec: &GymLevel, look: &Look) -> Scene {
    let mut scene = Scene::new();
    let g = &spec.grid;
    let (w, h) = (g.w, g.h);

    // ---- floors: one quad per row-run of same tint (cheap prim merge; a
    // checker look breaks field rows into per-cell quads — fine at gym scale).
    for z in 0..h {
        let mut x = 0i16;
        while x < w {
            let tint = floor_tint(g, CellPos::new(x, z), look);
            let x0 = x;
            while x < w && floor_tint(g, CellPos::new(x, z), look) == tint {
                x += 1;
            }
            scene.add_floor(x0 as f32, x as f32, z as f32, z as f32 + 1.0, FLOOR_TOP, hex_linear(tint));
        }
    }

    // ---- walls: merge consecutive wall edges along each boundary line.
    // Z-boundaries (edges between (x,z-1) and (x,z), drawn per cell's Zm):
    for z in 0..h {
        let mut x = 0i16;
        while x < w {
            if g.edge(CellPos::new(x, z), Dir::Zm) == EdgeKind::Wall {
                let x0 = x;
                while x < w && g.edge(CellPos::new(x, z), Dir::Zm) == EdgeKind::Wall {
                    x += 1;
                }
                wall_slab(&mut scene, [x0 as f32 - WALL_HT, z as f32 - WALL_HT, x as f32 + WALL_HT, z as f32 + WALL_HT], true, look);
            } else {
                x += 1;
            }
        }
    }
    // X-boundaries (per cell's Xm):
    for x in 0..w {
        let mut z = 0i16;
        while z < h {
            if g.edge(CellPos::new(x, z), Dir::Xm) == EdgeKind::Wall {
                let z0 = z;
                while z < h && g.edge(CellPos::new(x, z), Dir::Xm) == EdgeKind::Wall {
                    z += 1;
                }
                wall_slab(&mut scene, [x as f32 - WALL_HT, z0 as f32 - WALL_HT, x as f32 + WALL_HT, z as f32 + WALL_HT], false, look);
            } else {
                z += 1;
            }
        }
    }

    // ---- roof: an occluding cap over every Room cell (merged per row).
    // Visible from outside (the building reads as a building); the WALLCUT
    // indoor cutaway dissolves it the moment the player steps inside.
    for z in 0..h {
        let mut x = 0i16;
        while x < w {
            if g.cell(CellPos::new(x, z)) == CellKind::Room {
                let x0 = x;
                while x < w && g.cell(CellPos::new(x, z)) == CellKind::Room {
                    x += 1;
                }
                roof_run(&mut scene, x0 as f32, x as f32, z as f32, look);
            } else {
                x += 1;
            }
        }
    }

    // ---- lamps: the spec's lamp cells, as NAMED conceptual point lights
    // (the ONLY named lights — the mirror join sees exactly these) + an
    // unnamed fixture post per lamp, registered as a never-patched dynamic
    // run so its glow head stays out of the NEE scan and probe bake.
    for (i, (cell, intensity)) in spec.lights.iter().enumerate() {
        let c = cell_world(*cell);
        let s = 620.0 * (*intensity as f32 / 8.0) * look.lamp_scale;
        // The conceptual light must have CLEAR AIR toward the ground: NEE
        // shadow rays see the fixture (a dynamic run), so the light hangs
        // UNDER the bracket-arm lantern, where a real luminaire emits.
        scene.point_lights.push([c.x + 0.3, 1.40625, c.z, 0.25, s * look.lamp_tint[0], s * look.lamp_tint[1], s * look.lamp_tint[2], 0.0]);
        scene.name_point_light(&format!("lamp_{i}"), scene.point_lights.len() - 1);
        let first = scene.primitives.len();
        // pedestal + slim post + bracket arm; the glowing lantern hangs off
        // the arm with the light point just below it (XZ on the 0.1 grid)
        scene.add_box_world(Vec3::new(c.x - 0.1, FLOOR_TOP, c.z - 0.1), Vec3::new(c.x + 0.1, 0.25, c.z + 0.1), look.lamp_post, [0.0; 4], 0.6, 0.0);
        scene.add_box_world(Vec3::new(c.x - 0.05, 0.25, c.z - 0.05), Vec3::new(c.x + 0.05, 1.75, c.z + 0.05), look.lamp_post, [0.0; 4], 0.6, 0.0);
        scene.add_box_world(Vec3::new(c.x, 1.6875, c.z - 0.05), Vec3::new(c.x + 0.2, 1.75, c.z + 0.05), look.lamp_post, [0.0; 4], 0.6, 0.0);
        scene.add_box_world(Vec3::new(c.x + 0.2, 1.5, c.z - 0.1), Vec3::new(c.x + 0.4, 1.6875, c.z + 0.1), look.lamp_head, look.lamp_glow, 0.4, 0.0);
        scene.add_box_world(Vec3::new(c.x + 0.15, 1.6875, c.z - 0.15), Vec3::new(c.x + 0.45, 1.75, c.z + 0.15), look.lamp_post, [0.0; 4], 0.6, 0.0);
        scene.register_dynamic(&format!("lamp_fix_{i}"), first, scene.primitives.len() - first, Mat4::IDENTITY);
    }

    scene.recompute_bounds();

    // ---- dynamics (after recompute_bounds, local space): the player body.
    build_player_body(&mut scene, look);

    scene.floor_rect = [0.0, 0.0, w as f32, h as f32];
    scene.solids = Vec::new(); // collision is the sim's grid, not AABBs
    scene.player_start = cell_world(spec.player_start);
    scene.lighting = look.lighting;
    scene.sun_sky = look.sun; // sun/sky-as-data (Faza 1b)
    scene
}

fn floor_tint(g: &Grid, p: CellPos, look: &Look) -> u32 {
    match g.cell(p) {
        CellKind::Outdoor => match look.street_alt {
            // cobble checker: per-cell parity split (breaks the row merge)
            Some(alt) if (p.x + p.z) & 1 == 1 => alt,
            _ => look.street,
        },
        CellKind::Room => look.room_floor,
    }
}

/// One merged wall slab + the look's dress: an optional skirting plinth
/// (below the WALLCUT — it survives the cutaway and grounds the wall stubs)
/// and optional half-timber framing (posts on every cell boundary + a
/// rail, occluder-marked so the cutaway takes them with the wall).
/// `along_x` says which axis the run spans.
fn wall_slab(scene: &mut Scene, rect: [f32; 4], along_x: bool, look: &Look) {
    let first = scene.primitives.len();
    scene.add_box_world(Vec3::new(rect[0], 0.0, rect[1]), Vec3::new(rect[2], WALL_TOP, rect[3]), hex_linear(look.wall), [0.0; 4], 0.85, 0.0);
    mark_occluder(scene, first);
    // COPLANARITY RULE (2026-07-12 white-flicker post-mortem): dress with a
    // DIFFERENT colour must never share a face plane with its host — offset
    // by a whole lattice step, inward or outward. Two coplanar faces of
    // different colours ray-z-fight: the per-pixel winner flips on sub-pixel
    // camera motion and the losing colour strobes through. Same-colour
    // coplanarity (rail vs post) is benign — the winner is invisible.
    if let Some(hexp) = look.plinth {
        // strictly the proudest thing at the base (±0.1 past the slab, one
        // step past the posts' ±0.05); run ends stay at ±0.05 so the end
        // caps tuck INSIDE the extended door posts, never flush with them
        let (lo, hi) = if along_x {
            (Vec3::new(rect[0] - 0.05, 0.0, rect[1] - 0.1), Vec3::new(rect[2] + 0.05, 0.1875, rect[3] + 0.1))
        } else {
            (Vec3::new(rect[0] - 0.1, 0.0, rect[1] - 0.05), Vec3::new(rect[2] + 0.1, 0.1875, rect[3] + 0.05))
        };
        scene.add_box_world(lo, hi, hex_linear(hexp), [0.0; 4], 0.85, 0.0);
    }
    if let Some(hext) = look.timber {
        let tc = hex_linear(hext);
        // posts at every integer boundary along the run (both ends included);
        // 0.0625 taller than the wall so the post top never fights the wall
        // top; END posts extend one lattice step outward and swallow the
        // slab's end cap whole (a doorframe / end frame read)
        let (a0, a1) = if along_x { (rect[0] + WALL_HT, rect[2] - WALL_HT) } else { (rect[1] + WALL_HT, rect[3] - WALL_HT) };
        let mut k = a0;
        while k <= a1 + 0.001 {
            let first = scene.primitives.len();
            let ext0 = if k - 0.5 < a0 { 0.1 } else { 0.0 }; // first post of the run
            let ext1 = if k + 0.5 > a1 { 0.1 } else { 0.0 }; // last post of the run
            let (lo, hi) = if along_x {
                (Vec3::new(k - 0.1 - ext0, 0.0, rect[1] - 0.05), Vec3::new(k + 0.1 + ext1, WALL_TOP + 0.0625, rect[3] + 0.05))
            } else {
                (Vec3::new(rect[0] - 0.05, 0.0, k - 0.1 - ext0), Vec3::new(rect[2] + 0.05, WALL_TOP + 0.0625, k + 0.1 + ext1))
            };
            scene.add_box_world(lo, hi, tc, [0.0; 4], 0.8, 0.0);
            mark_occluder(scene, first);
            k += 1.0;
        }
        // rail spanning the whole run (same colour as the posts it crosses)
        let first = scene.primitives.len();
        scene.add_box_world(Vec3::new(rect[0] - 0.05, RAIL_Y, rect[1] - 0.05), Vec3::new(rect[2] + 0.05, RAIL_Y + 0.09375, rect[3] + 0.05), tc, [0.0; 4], 0.8, 0.0);
        mark_occluder(scene, first);
    }
}

/// One merged roof run in the look's silhouette. Every box is an occluder
/// (the WALLCUT must take it) with its base above the wall tops.
fn roof_run(scene: &mut Scene, x0: f32, x1: f32, z: f32, look: &Look) {
    let rc = hex_linear(look.roof);
    let first = scene.primitives.len();
    scene.add_box_world(Vec3::new(x0 - 0.3, ROOF_BASE, z), Vec3::new(x1 + 0.3, ROOF_TOP, z + 1.0), rc, [0.0; 4], 0.85, 0.0);
    mark_occluder(scene, first);
    if let Some(hexf) = look.fascia {
        // a slightly wider eave lip under the cap
        let first = scene.primitives.len();
        scene.add_box_world(Vec3::new(x0 - 0.4, ROOF_BASE - 0.0625, z), Vec3::new(x1 + 0.4, ROOF_BASE, z + 1.0), hex_linear(hexf), [0.0; 4], 0.85, 0.0);
        mark_occluder(scene, first);
    }
    if look.roof_style == RoofStyle::Ridged {
        // a raised ridge strip per row — standing seams / tiled ridges
        let first = scene.primitives.len();
        scene.add_box_world(Vec3::new(x0 - 0.1, ROOF_TOP, z + 0.25), Vec3::new(x1 + 0.1, ROOF_TOP + 0.09375, z + 0.75), hex_linear(look.roof_trim), [0.0; 4], 0.85, 0.0);
        mark_occluder(scene, first);
    }
}

// ---- the player body --------------------------------------------------------
//
// One ARTICULATED figure (~1.4 wu tall) built from five dynamic runs — core
// (pelvis/belt/torso/shoulders/head/hood + nose), `player/legL`, `/legR`
// (thigh-to-boot, authored around the HIP pivot) and `player/armL`, `/armR`
// (sleeve + mitten hand, authored around the SHOULDER pivot) — so the loop
// can swing limbs per tick (deterministic walk cycle). Limb geometry is
// authored in PIVOT space: the loop's instance transform is
// `body * translate(pivot) * swing`, so a zero swing reproduces the rest
// pose exactly. The nose wedge makes facing read even axis-aligned.

/// Hip pivot height + lateral leg offset; shoulder pivot height + lateral
/// arm offset. The loop's limb transforms must use the SAME numbers.
pub const HIP: f32 = 0.46875;
pub const LEG_X: f32 = 0.0625;
pub const SHOULDER: f32 = 1.0;
pub const ARM_X: f32 = 0.1875;

fn build_player_body(scene: &mut Scene, look: &Look) {
    let (coat, hood, legs) = (look.coat, look.hood, look.legs);
    // ---- core: pelvis, belt, torso, shoulder slab, head, hood, nose
    let first = scene.primitives.len();
    part(scene, 0.125, 0.09375, HIP - 0.0625, HIP + 0.0625, legs); // pelvis
    part(scene, 0.15625, 0.109375, HIP + 0.0625, HIP + 0.125, look.boots); // belt
    part(scene, 0.15625, 0.125, HIP + 0.125, SHOULDER + 0.03125, coat); // torso
    part(scene, 0.1875, 0.125, SHOULDER - 0.03125, SHOULDER + 0.0625, coat); // shoulder slab
    part(scene, 0.09375, 0.09375, 1.0625, 1.3125, look.skin); // head
    part(scene, 0.125, 0.125, 1.25, 1.40625, hood); // hood cap
    // back drape (nose is +Z, so the drape hangs at -Z)
    scene.add_box_world(Vec3::new(-0.09375, 0.8125, -0.21875), Vec3::new(0.09375, 1.21875, -0.125), hood, [0.0; 4], 0.6, 0.0);
    // nose wedge on +Z at the head's face plane (facing read)
    scene.add_box_world(Vec3::new(-0.03125, 1.125, 0.09375), Vec3::new(0.03125, 1.21875, 0.15625), look.skin, [0.0; 4], 0.8, 0.0);
    scene.register_dynamic("player", first, scene.primitives.len() - first, Mat4::from_scale(Vec3::ZERO));

    // ---- legs: thigh-to-shin box + boot with a toe, hanging from the hip
    // pivot (geometry centred on x — the pivot translation supplies ±LEG_X)
    for suffix in ["legL", "legR"] {
        let first = scene.primitives.len();
        scene.add_box_world(Vec3::new(-0.0625, -HIP + 0.09375, -0.0625), Vec3::new(0.0625, 0.03125, 0.0625), legs, [0.0; 4], 0.6, 0.0);
        scene.add_box_world(Vec3::new(-0.0625, -HIP, -0.0625), Vec3::new(0.0625, -HIP + 0.09375, 0.125), look.boots, [0.0; 4], 0.6, 0.0);
        scene.register_dynamic(&format!("player/{suffix}"), first, scene.primitives.len() - first, Mat4::from_scale(Vec3::ZERO));
    }

    // ---- arms: sleeve + mitten hand from the shoulder pivot
    for suffix in ["armL", "armR"] {
        let first = scene.primitives.len();
        scene.add_box_world(Vec3::new(-0.03125, -0.40625, -0.03125), Vec3::new(0.03125, 0.03125, 0.03125), coat, [0.0; 4], 0.6, 0.0);
        scene.add_box_world(Vec3::new(-0.0625, -0.53125, -0.0625), Vec3::new(0.0625, -0.40625, 0.0625), look.skin, [0.0; 4], 0.6, 0.0);
        scene.register_dynamic(&format!("player/{suffix}"), first, scene.primitives.len() - first, Mat4::from_scale(Vec3::ZERO));
    }
}

fn part(scene: &mut Scene, hx: f32, hz: f32, y0: f32, y1: f32, color: [f32; 4]) {
    scene.add_box_world(Vec3::new(-hx, y0, -hz), Vec3::new(hx, y1, hz), color, [0.0; 4], 0.6, 0.0);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::look::LOOKS;
    use house_game::gym::sim::gym_level;

    /// EVERY look preset produces the five player runs the loop patches —
    /// and keeps the NEE discipline (the only named lights are the spec
    /// lamps; dressing stays in dynamic runs / non-emissive statics).
    #[test]
    fn every_look_registers_the_player_runs_and_lamps_only() {
        for look in LOOKS {
            let spec = gym_level();
            let scene = build_gym(&spec, look);
            for name in ["player", "player/legL", "player/legR", "player/armL", "player/armR"] {
                assert!(scene.dynamics.iter().any(|(n, ..)| n == name), "{}: missing run {name}", look.name);
            }
            // the only NEE lights are the named lamps
            let scan = rt_probe::scan_lights(&scene).unwrap();
            assert_eq!(scan.light_count as usize, spec.lights.len(), "{}: lamps only — dressing must stay in dynamic runs", look.name);
            assert_eq!(scan.names.len(), spec.lights.len());
        }
    }

    /// Roof dressing (every look) sits fully above the WALLCUT plane and is
    /// occluder-marked — the indoor cutaway must take the whole cap.
    #[test]
    fn roof_boxes_are_occluders_above_the_wallcut() {
        for look in LOOKS {
            let mut scene = Scene::new();
            roof_run(&mut scene, 0.0, 4.0, 0.0, look);
            for p in 0..scene.primitives.len() {
                let prim = scene.primitives[p];
                let base = (0..prim.vertex_count).map(|i| scene.vertices[(prim.vertex_offset + i) as usize].pos[1]).fold(f32::INFINITY, f32::min);
                assert!(base > WALL_CUT_H, "{}: roof box base {base} under the cutaway plane", look.name);
                assert_eq!(scene.materials[prim.material_id as usize]._pad, 1, "{}: roof box not occluder-marked", look.name);
            }
        }
    }

    /// The indoor cutaway plane sits below the wall tops (they dissolve to
    /// stubs) and above a lamp pedestal (furnishing-height dressing stays).
    #[test]
    #[allow(clippy::assertions_on_constants)] // a deliberate constants-relationship pin
    fn wall_cut_sits_below_wall_tops() {
        assert!(WALL_CUT_H < WALL_TOP, "walls must drop to stubs indoors");
        assert!(WALL_CUT_H > 0.25, "ground-level dressing survives the cutaway");
    }
}
