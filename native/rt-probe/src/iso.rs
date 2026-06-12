//! The pixel-perfect ISO_VIEW_CONTRACT camera + interactive-view math.
//!
//! Mirrors `packages/common-render/src/iso-contract.ts`: orthographic,
//! yaw=π/4, pitch=π/6, and exactly R lowpixels per world unit (1 tile = 1 wu
//! -> 32 px H × 16 px V). Everything here is pure math (no Vulkan), so the
//! interactive rules (#4 integer render scale, #5 whole-pixel pan, #6 zoom
//! anchor, #7 guard band, lattice snapping) are regression-tested below.

use glam::{Vec2, Vec3};

pub const ISO_R: f32 = 32.0 * std::f32::consts::SQRT_2; // 45.25 lowpixels / world unit
pub const ISO_YAW_DEG: f32 = 45.0; // π/4
pub const ISO_PITCH_DEG: f32 = 30.0; // π/6  (sin = 1/2 exact -> the 2:1 staircase)

/// The ISO_VIEW_CONTRACT camera basis (forward, right, up) for a turntable
/// offset. `right = dir×Y`, `up = right×dir` reproduces three.js `lookAt`
/// exactly, so this matches the engine's `IsoCamera` projection.
pub fn iso_basis(yaw_off_deg: f32) -> (Vec3, Vec3, Vec3) {
    let yaw = (ISO_YAW_DEG + yaw_off_deg).to_radians();
    let pitch = ISO_PITCH_DEG.to_radians();
    let offset = Vec3::new(yaw.sin() * pitch.cos(), pitch.sin(), yaw.cos() * pitch.cos());
    let dir = -offset; // look toward target
    let right = dir.cross(Vec3::Y).normalize();
    let up = right.cross(dir).normalize();
    (dir, right, up)
}

/// Project an AABB into low-res screen space (lowpixels) at scale R for the
/// given basis, returning (xmin, xmax, ymin, ymax) about the AABB centroid.
pub fn iso_screen_bounds(min: Vec3, max: Vec3, right: Vec3, up: Vec3) -> (f32, f32, f32, f32) {
    let centroid = (min + max) * 0.5;
    let (mut xmin, mut xmax, mut ymin, mut ymax) = (f32::MAX, f32::MIN, f32::MAX, f32::MIN);
    for cx in [min.x, max.x] {
        for cy in [min.y, max.y] {
            for cz in [min.z, max.z] {
                let rel = Vec3::new(cx, cy, cz) - centroid;
                let sx = rel.dot(right) * ISO_R;
                let sy = rel.dot(up) * ISO_R;
                xmin = xmin.min(sx);
                xmax = xmax.max(sx);
                ymin = ymin.min(sy);
                ymax = ymax.max(sy);
            }
        }
    }
    (xmin, xmax, ymin, ymax)
}

/// The camera frame an iso view renders with: basis vectors, eye position and
/// ortho half-extents in world units. Pure data — `render::ShadePush` packs it
/// for the shader.
#[derive(Clone, Copy)]
pub struct CamFrame {
    pub right: Vec3,
    pub up: Vec3,
    pub dir: Vec3,
    pub pos: Vec3,
    pub half_w: f32,
    pub half_h: f32,
}

/// The ISO_VIEW_CONTRACT camera at an explicit world-space look-at `target`
/// for a `low_w × low_h` lowpixel buffer (scale locked to R lowpixels/wu).
/// `scene_min/max` only size the eye's backoff distance.
pub fn iso_camera_at(scene_min: Vec3, scene_max: Vec3, low_w: u32, low_h: u32, yaw_off_deg: f32, target: Vec3) -> CamFrame {
    let (dir, right, up) = iso_basis(yaw_off_deg);
    let half_w = low_w as f32 / (2.0 * ISO_R);
    let half_h = low_h as f32 / (2.0 * ISO_R);
    let dist = (scene_max - scene_min).length() * 1.5 + 5.0;
    let pos = target - dir * dist;
    CamFrame { right, up, dir, pos, half_w, half_h }
}

/// The look-at target that centres the scene: the AABB centroid shifted to the
/// middle of its projected bbox. The viewer seeds its movable target with this.
pub fn iso_target(scene_min: Vec3, scene_max: Vec3) -> Vec3 {
    let (_dir, right, up) = iso_basis(0.0);
    let centroid = (scene_min + scene_max) * 0.5;
    let (xmin, xmax, ymin, ymax) = iso_screen_bounds(scene_min, scene_max, right, up);
    centroid + right * ((xmin + xmax) * 0.5 / ISO_R) + up * ((ymin + ymax) * 0.5 / ISO_R)
}

// ---- pixel-perfect interactive-view rules ----------------------------------

/// Integer render scale for a zoom over a base scale (#4: round(zoom·base)).
pub fn render_scale(zoom: f32, base: u32) -> i32 {
    ((zoom * base as f32).round() as i32).max(1)
}

/// Pan that keeps the low-pixel under window-pixel `c` fixed when the render
/// scale changes `rs0 -> rs1` (#6 zoom-anchor): low_pixel = pan + c/rs is held.
pub fn zoom_anchor_pan(pan: Vec2, c: Vec2, rs0: f32, rs1: f32) -> Vec2 {
    pan + c * (1.0 / rs0 - 1.0 / rs1)
}

/// Clamp the crop so the `vis`-sized visible region stays inside the `low`
/// buffer (overscan headroom; beyond it the guard band would show, #7).
pub fn clamp_pan(pan: Vec2, low: Vec2, vis: Vec2) -> Vec2 {
    Vec2::new(pan.x.clamp(0.0, (low.x - vis.x).max(0.0)), pan.y.clamp(0.0, (low.y - vis.y).max(0.0)))
}

/// Split an accumulated sub-pixel camera move into the whole low-pixel steps to
/// apply now and the fractional remainder to carry to the next input (#5,
/// applied to the *camera* so a moving iso view stays on the pixel lattice —
/// no sub-pixel crawl/shimmer). Round (not trunc) keeps |remainder| ≤ 0.5.
pub fn whole_pixel_step(accum: Vec2) -> (Vec2, Vec2) {
    let whole = Vec2::new(accum.x.round(), accum.y.round());
    (whole, accum - whole)
}

/// World-space ground-plane deltas for one screen pixel: `u` = +1 px right,
/// `v` = +1 px down. The native mirror of the web `IsoCamera.getSnapBasis()`
/// ground-raycast basis. Horizontal pixels move 1/R wu along the screen-right
/// floor direction; vertical pixels are foreshortened by sin(pitch) = 1/2, so
/// one px down is **2/R** wu toward the camera. (Getting this 2× wrong halves
/// vertical screen speed and turns the 2:1 diagonal stair into 4:1.)
pub fn iso_pixel_basis(yaw_off_deg: f32) -> (Vec3, Vec3) {
    let yaw = (ISO_YAW_DEG + yaw_off_deg).to_radians();
    let sin_pitch = ISO_PITCH_DEG.to_radians().sin(); // 1/2 exact
    let right_floor = Vec3::new(yaw.cos(), 0.0, -yaw.sin());
    let toward_cam = Vec3::new(yaw.sin(), 0.0, yaw.cos()); // -fwd_floor
    (right_floor / ISO_R, toward_cam / (ISO_R * sin_pitch))
}

/// Convert a screen-pixel delta (x right, y down) into a world ground delta.
pub fn screen_px_to_world(d: Vec2, yaw_off_deg: f32) -> Vec3 {
    let (u, v) = iso_pixel_basis(yaw_off_deg);
    u * d.x + v * d.y
}

/// Snap a ground point to the nearest cell of the screen-pixel lattice,
/// staying on its ground plane (y preserved) — the native mirror of
/// `IsoGameView.snapWorldPointOnGround(.., "nearest")` with the uniform (1, 1)
/// granularity the engine mandates (CLAUDE.md invariant #9). The web routes
/// every mesh `setPosition` through this so a moving box renders identically
/// on every frame it occupies a pixel cell.
pub fn snap_ground_to_lattice(p: Vec3, yaw_off_deg: f32) -> Vec3 {
    let (_dir, right, up) = iso_basis(yaw_off_deg);
    let (u, v) = iso_pixel_basis(yaw_off_deg);
    let a = p.dot(right) * ISO_R; // screen px right
    let b = -p.dot(up) * ISO_R; // screen px down
    p + u * (a.round() - a) + v * (b.round() - b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_scale_is_integer_steps() {
        assert_eq!(render_scale(1.0, 4), 4); // zoom=1 -> baseline
        assert_eq!(render_scale(2.0, 4), 8);
        assert_eq!(render_scale(1.1, 4), 4); // round(4.4) -> still 4 (pixel-perfect quantization)
        assert_eq!(render_scale(1.2, 4), 5); // round(4.8) -> 5
        assert_eq!(render_scale(0.01, 4), 1); // never below 1
    }

    #[test]
    fn zoom_anchor_keeps_world_point_under_cursor() {
        // The low pixel under the cursor must not move (within rounding) when we
        // change zoom anchored at the cursor.
        let base = 4u32;
        let c = Vec2::new(900.0, 530.0); // cursor in window px
        let pan0 = Vec2::new(40.0, 24.0);
        for &(z0, z1) in &[(1.0f32, 2.0f32), (2.0, 3.5), (3.0, 1.0), (1.0, 8.0)] {
            let rs0 = render_scale(z0, base) as f32;
            let rs1 = render_scale(z1, base) as f32;
            let pan1 = zoom_anchor_pan(pan0, c, rs0, rs1);
            let before = (pan0 + c / rs0).round();
            let after = (pan1 + c / rs1).round();
            assert!((before - after).abs().max_element() <= 1.0, "anchor drifted: {before:?} vs {after:?} (z {z0}->{z1})");
        }
    }

    #[test]
    fn whole_pixel_step_carries_remainder() {
        // applied steps are integers; remainder stays small and accumulates to a step
        let (w, r) = whole_pixel_step(Vec2::new(0.3, -0.4));
        assert_eq!(w, Vec2::ZERO);
        assert!((r - Vec2::new(0.3, -0.4)).abs().max_element() < 1e-6);
        let (w, r) = whole_pixel_step(Vec2::new(2.6, -1.7));
        assert_eq!(w, Vec2::new(3.0, -2.0));
        assert!(r.abs().max_element() <= 0.5 + 1e-6);
        // feeding small deltas eventually yields a whole step
        let mut acc = Vec2::ZERO;
        let mut applied = 0.0;
        for _ in 0..10 {
            acc += Vec2::new(0.3, 0.0);
            let (w, rem) = whole_pixel_step(acc);
            applied += w.x;
            acc = rem;
        }
        assert_eq!(applied, 3.0); // 10 * 0.3 = 3.0 applied as whole steps
    }

    #[test]
    fn clamp_keeps_visible_region_in_buffer() {
        let low = Vec2::new(300.0, 200.0);
        let vis = Vec2::new(260.0, 160.0);
        assert_eq!(clamp_pan(Vec2::new(-50.0, -50.0), low, vis), Vec2::new(0.0, 0.0));
        assert_eq!(clamp_pan(Vec2::new(999.0, 999.0), low, vis), Vec2::new(40.0, 40.0));
        assert_eq!(clamp_pan(Vec2::new(20.0, 10.0), low, vis), Vec2::new(20.0, 10.0));
    }

    #[test]
    fn pixel_basis_maps_exactly_one_screen_pixel() {
        let (_d, right, up) = iso_basis(0.0);
        let (u, v) = iso_pixel_basis(0.0);
        // u projects to exactly (1, 0) screen px, v to (0, 1) (down-positive)
        assert!((u.dot(right) * ISO_R - 1.0).abs() < 1e-4);
        assert!((-u.dot(up) * ISO_R).abs() < 1e-4);
        assert!((v.dot(right) * ISO_R).abs() < 1e-4);
        assert!((-v.dot(up) * ISO_R - 1.0).abs() < 1e-4);
        // both are ground-plane vectors
        assert_eq!(u.y, 0.0);
        assert_eq!(v.y, 0.0);
        // vertical foreshortening: one px down covers 2x the ground of one px right
        assert!((v.length() / u.length() - 2.0).abs() < 1e-4);
    }

    #[test]
    fn pixel_basis_holds_at_every_quarter_turn() {
        for q in 0..4 {
            let yaw_off = 90.0 * q as f32;
            let (_d, right, up) = iso_basis(yaw_off);
            let (u, v) = iso_pixel_basis(yaw_off);
            assert!((u.dot(right) * ISO_R - 1.0).abs() < 1e-4, "q{q}");
            assert!((-v.dot(up) * ISO_R - 1.0).abs() < 1e-4, "q{q}");
            assert!((v.dot(right) * ISO_R).abs() < 1e-4, "q{q}");
            assert!((-u.dot(up) * ISO_R).abs() < 1e-4, "q{q}");
        }
    }

    #[test]
    fn snap_ground_lands_on_integer_lattice() {
        let (_d, right, up) = iso_basis(0.0);
        let p = Vec3::new(1.234, 0.0, -3.456);
        let s = snap_ground_to_lattice(p, 0.0);
        let a = s.dot(right) * ISO_R;
        let b = -s.dot(up) * ISO_R;
        assert!((a - a.round()).abs() < 1e-3, "a {a}");
        assert!((b - b.round()).abs() < 1e-3, "b {b}");
        assert_eq!(s.y, 0.0); // stays on the ground plane
        // idempotent + never moves more than ~a pixel cell
        assert!((snap_ground_to_lattice(s, 0.0) - s).length() < 1e-4);
        assert!((s - p).length() < 3.0 / ISO_R);
    }
}
