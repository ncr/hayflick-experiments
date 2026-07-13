//! The physics-spike adapter: authors the `phys-spike` Rapier boxes into the
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
