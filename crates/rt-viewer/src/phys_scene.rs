//! The physics-spike adapter: authors the `phys-spike` box3d boxes into the
//! gym `Scene` as extra dynamic runs, and nothing else knows about physics
//! (mirrors how rt-viewer is the ONLY crate that bridges house-game ↔
//! rt-probe). This is throwaway exploration scaffolding — enabled by `PHYS=1`.
//!
//! Each box becomes a `phys/{i}` dynamic run: a unit box authored at the LOCAL
//! origin, registered at ZERO scale (so the frozen probe bake collapses it to
//! a point and never sees it — same policy as the player limbs), then driven
//! each frame by `GymLoop::phys_instances` patching the TLAS transform. The
//! colours are spike dressing — warm ceramic bricks and a charcoal
//! projectile, so they read against the porcelain look.

use glam::{Mat4, Vec3};
use phys_spike::PhysWorld;
use rt_probe::{hex_linear, Scene};

/// Warm terracotta brick tints (faint per-brick variation).
const BRICK: [u32; 3] = [0xc9_6b3f, 0xb8_5f37, 0xd0_7a4a];
/// The projectile block — charcoal, so it reads as the thing that hit.
const PROJECTILE: u32 = 0x2a_2e33;

/// Register the physics boxes as `phys/{i}` dynamic runs. Call AFTER
/// `build_gym` (its `recompute_bounds` must not see this local-space
/// geometry) and BEFORE the backend builds the scene.
pub fn author(scene: &mut Scene, phys: &PhysWorld) {
    let boxes = phys.boxes();
    let last = boxes.len().saturating_sub(1);
    for (i, b) in boxes.iter().enumerate() {
        let color = if i == last { hex_linear(PROJECTILE) } else { hex_linear(BRICK[i % 3]) };
        let first = scene.primitives.len();
        scene.add_box_world(-b.half, b.half, color, [0.0; 4], 0.8, 0.0);
        scene.register_dynamic(&format!("phys/{i}"), first, 1, Mat4::from_scale(Vec3::ZERO));
    }
}

/// Register the WALL-SMASH boxes (phase 3): the torn pier's bricks in the
/// look's own wall porcelain (faint per-brick tint variation so tumbled
/// rubble reads; wall roughness — they ARE wall chunks), the slug last in
/// charcoal. Zero-scale until the smash beat fires, exactly like [`author`];
/// `GymLoop::phys_instances` drives both through the same `phys/{i}` path.
pub fn author_wall_bricks(scene: &mut Scene, bricks: &[phys_spike::BrickSpec], look: &crate::look::Look) {
    let wall = hex_linear(look.wall);
    for (i, b) in bricks.iter().enumerate() {
        let v = [0.94, 1.0, 1.06][i % 3];
        let color = [(wall[0] * v).min(1.0), (wall[1] * v).min(1.0), (wall[2] * v).min(1.0), wall[3]];
        let first = scene.primitives.len();
        scene.add_box_world(-b.half, b.half, color, [0.0; 4], 0.85, 0.0);
        // rubble is greybox DETAIL geometry (a wall taken apart), so it opts into
        // the contour AA per the 2026-07-25 policy — see gym_scene::AA_BIT. Brick
        // silhouettes are small and tumbling; hard 1-px steps read as flicker.
        crate::gym_scene::mark_aa(scene, first);
        scene.register_dynamic(&format!("phys/{i}"), first, 1, Mat4::from_scale(Vec3::ZERO));
    }
    let first = scene.primitives.len();
    let s = phys_spike::SLUG_HALF;
    scene.add_box_world(Vec3::splat(-s), Vec3::splat(s), hex_linear(PROJECTILE), [0.0; 4], 0.8, 0.0);
    scene.register_dynamic(&format!("phys/{}", bricks.len()), first, 1, Mat4::from_scale(Vec3::ZERO));
}
