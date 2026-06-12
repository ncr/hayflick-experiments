//! Native game runtime: collision + iso input (mirrors @common/gameplay).
//!
//! The TS engine can't be imported here, so these replicate its movement
//! rules: `LevelResource.isBlocked(x,y)` (single-point solidity test) and the
//! iso 2:1 input mapping (`bDir = -inputY * 0.5`, normalised, projected onto a
//! pixel basis) with the smoothness-floor speed.

use crate::scene::Scene;
use glam::Vec2;

/// The walkable level: a floor rect plus solid prop footprints, all in world
/// XZ. `is_blocked` mirrors `@common/gameplay`'s `LevelResource.isBlocked` —
/// out of the floor rect (the walls) or inside a solid = blocked.
#[derive(Clone, Default)]
pub struct Level {
    pub floor: [f32; 4],       // xmin, zmin, xmax, zmax (walkable, already wall-inset)
    pub solids: Vec<[f32; 4]>, // xmin, zmin, xmax, zmax footprints
}

impl Level {
    pub fn from_scene(scene: &Scene) -> Level {
        Level { floor: scene.floor_rect, solids: scene.solids.clone() }
    }

    /// True if world point (x, z) is non-walkable (outside the floor rect, or
    /// inside any solid). Out-of-bounds = blocked, matching the TS grid level.
    pub fn is_blocked(&self, x: f32, z: f32) -> bool {
        if x < self.floor[0] || z < self.floor[1] || x > self.floor[2] || z > self.floor[3] {
            return true;
        }
        self.solids.iter().any(|s| x >= s[0] && z >= s[1] && x <= s[2] && z <= s[3])
    }
}

/// The iso 2:1 input direction (mirrors `createControlledInputSystem`): combine
/// the axis inputs, scale the vertical by 0.5 so a diagonal traces the clean
/// (2,1) screen stair, then normalise. Returns a unit (right, down) screen
/// vector, or None when there is no input. Pure up → (0,-1); up+right →
/// (2/√5, -1/√5) ≈ (0.894, -0.447) = the engine's ISO_INPUT_DIAGONAL rates.
pub fn iso_input_dir(input_x: f32, input_y: f32) -> Option<Vec2> {
    if input_x == 0.0 && input_y == 0.0 {
        return None;
    }
    let a = input_x;
    let b = -input_y * 0.5;
    let len = (a * a + b * b).sqrt();
    Some(Vec2::new(a / len, b / len))
}

/// The smoothness-floor speed in screen px/s (mirrors
/// `recommendedMinPxPerSecForIso`): `fps / (2/√5) = fps·√5/2` ≈ 67 @ 60 fps.
/// Below this the dominant axis advances < 1 px/frame and motion ticks visibly.
pub fn recommended_min_px_per_sec(fps: f32) -> f32 {
    fps * 5.0_f32.sqrt() / 2.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::iso::{iso_basis, screen_px_to_world, ISO_R};

    #[test]
    fn level_blocks_outside_floor_and_inside_solids() {
        let lvl = Level { floor: [-5.0, -5.0, 5.0, 5.0], solids: vec![[1.0, 1.0, 2.0, 2.0]] };
        assert!(!lvl.is_blocked(0.0, 0.0)); // open interior
        assert!(lvl.is_blocked(-6.0, 0.0)); // past the west wall
        assert!(lvl.is_blocked(0.0, 9.0)); // past the south wall
        assert!(lvl.is_blocked(1.5, 1.5)); // inside the prop footprint
        assert!(!lvl.is_blocked(2.5, 2.5)); // just clear of the prop
    }

    #[test]
    fn iso_input_dir_traces_the_2to1_stair() {
        assert!(iso_input_dir(0.0, 0.0).is_none());
        let up = iso_input_dir(0.0, 1.0).unwrap();
        assert!((up - Vec2::new(0.0, -1.0)).abs().max_element() < 1e-6);
        let right = iso_input_dir(1.0, 0.0).unwrap();
        assert!((right - Vec2::new(1.0, 0.0)).abs().max_element() < 1e-6);
        // up+right: the clean (2,1) screen diagonal = engine ISO_INPUT_DIAGONAL rates
        let diag = iso_input_dir(1.0, 1.0).unwrap();
        assert!((diag.x - 2.0 / 5.0_f32.sqrt()).abs() < 1e-6, "a-rate {}", diag.x);
        assert!((diag.y + 1.0 / 5.0_f32.sqrt()).abs() < 1e-6, "b-rate {}", diag.y);
        assert!((diag.length() - 1.0).abs() < 1e-6); // unit
    }

    #[test]
    fn smoothness_floor_matches_engine() {
        assert!((recommended_min_px_per_sec(60.0) - 67.082).abs() < 0.01);
    }

    #[test]
    fn diagonal_input_traces_2to1_screen_stair_through_the_basis() {
        // iso_input_dir + the pixel basis must reproduce the engine's screen
        // rates: up+right = (2/sqrt5 right, 1/sqrt5 up) px per unit time.
        let dir = iso_input_dir(1.0, 1.0).unwrap();
        let w = screen_px_to_world(dir, 0.0);
        let (_d, right, up) = iso_basis(0.0);
        let sx = w.dot(right) * ISO_R;
        let sy = -w.dot(up) * ISO_R; // screen down
        assert!((sx - 2.0 / 5.0_f32.sqrt()).abs() < 1e-4, "a-rate {sx}");
        assert!((sy + 1.0 / 5.0_f32.sqrt()).abs() < 1e-4, "b-rate {sy}");
        assert!((sx / -sy - 2.0).abs() < 1e-3); // the 2:1 stair
    }
}
