//! Two-bone IK for legs (and arms): the animated pose supplies the bend
//! direction, the solver only moves the middle joint so the end lands on its
//! target with the bone lengths unchanged.
use crate::asset::Skeleton;
use crate::pose::Globals;
use glam::{Quat, Vec3};

/// Middle joint for links `a`, `b` from `root` towards `end`, bending
/// towards `pole`. An unreachable end is approached as far as the links
/// allow; a pole parallel to the limb falls back to a stable perpendicular.
pub fn joint(root: Vec3, end: Vec3, pole: Vec3, a: f32, b: f32) -> Vec3 {
    let delta = end - root;
    let dist = delta.length().clamp((a - b).abs() + 1e-3, a + b - 1e-4);
    let axis = delta.try_normalize().unwrap_or(-Vec3::Y);
    let along = (a * a - b * b + dist * dist) / (2.0 * dist);
    let projected = pole - axis * pole.dot(axis);
    let fallback = if axis.x.abs() < 0.7 { Vec3::X } else { Vec3::Z };
    let perp = projected.try_normalize().unwrap_or_else(|| (fallback - axis * fallback.dot(axis)).normalize());
    root + axis * along + perp * (a * a - along * along).max(0.0).sqrt()
}

/// Rotate bone `i`'s global rotation so its direction (joint → end) turns
/// from where it points now onto `dir`, by the smallest rotation — the twist
/// the animation gave it survives.
pub fn aim(g: &mut Globals, skel: &Skeleton, i: usize, dir: Vec3) {
    let b = &skel.bones[i];
    let now = (g.rot[i] * (b.tail - b.head)).normalize();
    let want = dir.normalize();
    g.rot[i] = (Quat::from_rotation_arc(now, want) * g.rot[i]).normalize();
}

/// Solve a two-bone chain (`upper`, `lower` = its child) so the lower bone's
/// end — the next joint down the chain — lands on `target`. The bend plane is
/// the animated one: the current middle joint relative to the root→target
/// line, nudged by `bias` so a nearly straight limb still bends the right
/// way. Updates both bones' global rotations and the lower joint position.
pub fn two_bone(g: &mut Globals, skel: &Skeleton, upper: usize, lower: usize, target: Vec3, bias: Vec3) {
    let root = g.head[upper];
    let mid = g.head[lower];
    let (a, b) = (skel.len(upper), skel.len(lower));
    let axis = (target - root).normalize_or_zero();
    let off = mid - root;
    let pole = (off - axis * off.dot(axis)) + bias;
    let knee = joint(root, target, pole, a, b);
    aim(g, skel, upper, knee - root);
    g.head[lower] = root + g.rot[upper] * (skel.bones[lower].head - skel.bones[upper].head);
    let end = if (target - root).length() > a + b { root + axis * (a + b) } else { target };
    aim(g, skel, lower, end - g.head[lower]);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_joint_keeps_both_link_lengths() {
        let k = joint(Vec3::new(0.0, 0.9, 0.0), Vec3::new(0.0, 0.1, 0.2), Vec3::Z, 0.42, 0.425);
        assert!((k.distance(Vec3::new(0.0, 0.9, 0.0)) - 0.42).abs() < 1e-4);
        assert!((k.distance(Vec3::new(0.0, 0.1, 0.2)) - 0.425).abs() < 1e-4);
        assert!(k.z > 0.1, "bends toward the pole");
    }

    #[test]
    fn a_pole_along_the_limb_cannot_collapse_the_joint() {
        let k = joint(Vec3::ZERO, Vec3::Y * 0.6, Vec3::Y, 0.4, 0.4);
        assert!((k.length() - 0.4).abs() < 1e-4);
        assert!((k.distance(Vec3::Y * 0.6) - 0.4).abs() < 1e-4);
    }
}
