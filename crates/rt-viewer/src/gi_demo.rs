//! Stage-1 dynamic-GI proof (voxel-physics-spike branch): BAKED walls — static
//! geometry, TLAS mask 0xff, so they ARE in the probe bake — that we remove at
//! runtime and re-bake, so the indirect lighting updates.
//!
//! This is the opposite of the physics bricks: those are movers (mask 0x05),
//! excluded from the frozen bake, so destroying them never needed a GI update.
//!
//! In this bright daylit look, one-bounce colour bleed is a small fraction of
//! the total — too subtle to read. The indirect effect that DOES dominate is
//! enclosure darkening: a roofed carport (roof + two back walls), open toward
//! the camera so its shaded floor is visible. The roof/walls cut the floor off
//! from sun and most sky, so it sits in deep ambient shade — a strong, baked,
//! indirect darkening. Destroy the carport and re-bake and the floor returns to
//! full sunlit brightness. (Without a re-bake the floor would stay dark with no
//! structure to justify it — the ghost that dynamic GI fixes.)
//!
//! Enabled by `GI_DEMO=1` (intact) / `GI_DEMO=2` (booted already-destroyed, for
//! the static A/B). The runtime destroy path lives in the viewer.

use crate::look::Look;
use glam::Vec3;
use rt_probe::{hex_linear, Scene};

const FLOOR_TOP: f32 = 6.0 / 128.0;

/// Author the demo. The white catcher floor is always present; the carport
/// (roof + two back walls at the far +X/+Z sides, open toward the −X/−Z camera
/// corner) is the destructible part (`intact`). Plain `add_box_world` → static
/// → mask 0xff → in the probe bake (the whole point).
pub fn author(scene: &mut Scene, _look: &Look, intact: bool) {
    // White matte catcher floor (~1.4×1.4 wu), lifted a hair above the grass so
    // no face is coplanar with the ground plane.
    let white = hex_linear(0xf2f2f0);
    scene.add_box_world(Vec3::new(10.8, 0.0, 10.8), Vec3::new(12.2, FLOOR_TOP + 0.03, 12.2), white, [0.0; 4], 0.7, 0.0);

    if intact {
        let w = hex_linear(0xe8e8e4); // pale walls/roof (structure, not the catcher)
        // back wall (+X)
        scene.add_box_world(Vec3::new(12.2, 0.0, 10.6), Vec3::new(12.4, 2.2, 12.4), w, [0.0; 4], 0.85, 0.0);
        // back wall (+Z)
        scene.add_box_world(Vec3::new(10.6, 0.0, 12.2), Vec3::new(12.4, 2.2, 12.4), w, [0.0; 4], 0.85, 0.0);
        // roof — closes the top, so the floor loses the sky and sits in shade
        scene.add_box_world(Vec3::new(10.5, 2.1, 10.5), Vec3::new(12.5, 2.3, 12.5), w, [0.0; 4], 0.85, 0.0);
    }
}
