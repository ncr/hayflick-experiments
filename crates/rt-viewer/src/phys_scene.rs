//! The physics-spike adapter: authors the `phys-spike` box3d boxes into the
//! gym `Scene` as extra dynamic runs, and nothing else knows about physics
//! (mirrors how rt-viewer is the ONLY crate that bridges house-game ↔
//! rt-probe). Its one live caller is the shipped "wall smash" demo.
//!
//! Each box becomes a `phys/{i}` dynamic run: a unit box authored at the LOCAL
//! origin, registered at ZERO scale (so the frozen probe bake collapses it to
//! a point and never sees it — same policy as the player limbs), then driven
//! each frame by `GymLoop::phys_instances` patching the TLAS transform. The
//! colours are spike dressing — the look's own wall porcelain for the rubble
//! and a charcoal projectile, so they read against the porcelain look.
//!
//! The free-standing `PHYS=1` brick-wall demo (a second `author` entry point
//! over `PhysWorld::demo`) is DELETED (2026-07-28): the wall smash superseded
//! it, and it was reachable only from an undeclared env knob.

use glam::{Mat4, Vec3};
use rt_probe::{hex_linear, Scene};

/// The projectile block — charcoal, so it reads as the thing that hit.
const PROJECTILE: u32 = 0x2a_2e33;

/// Register the WALL-SMASH boxes (phase 3): the torn pier's bricks in the
/// look's own wall porcelain (faint per-brick tint variation so tumbled
/// rubble reads; wall roughness — they ARE wall chunks), the slug last in
/// charcoal. Registered at ZERO scale until the smash beat fires;
/// `GymLoop::phys_instances` drives them through the `phys/{i}` path.
pub fn author_wall_bricks(scene: &mut Scene, bricks: &[phys_spike::BrickSpec], look: &crate::look::Look) -> Vec<i32> {
    let wall = hex_linear(look.wall);
    // The rubble's materials are returned as CHUNKY detail (gym_scene::AA_BIT):
    // whether they take the contour AA is the owner's call, not the generator's
    // — a brick is 10-30 px across, so the AA has no sampling gap to fix there
    // and only softens the block read (owner verdict + `aa chunky`, 2026-07-25).
    let mut chunky = Vec::with_capacity(bricks.len());
    for (i, b) in bricks.iter().enumerate() {
        let v = [0.94, 1.0, 1.06][i % 3];
        let color = [(wall[0] * v).min(1.0), (wall[1] * v).min(1.0), (wall[2] * v).min(1.0), wall[3]];
        let first = scene.primitives.len();
        scene.add_box_world(-b.half, b.half, color, [0.0; 4], 0.85, 0.0);
        chunky.push(scene.primitives[first].material_id);
        scene.register_dynamic(&format!("phys/{i}"), first, 1, Mat4::from_scale(Vec3::ZERO));
    }
    let first = scene.primitives.len();
    let s = phys_spike::SLUG_HALF;
    scene.add_box_world(Vec3::splat(-s), Vec3::splat(s), hex_linear(PROJECTILE), [0.0; 4], 0.8, 0.0);
    scene.register_dynamic(&format!("phys/{}", bricks.len()), first, 1, Mat4::from_scale(Vec3::ZERO));
    chunky
}
