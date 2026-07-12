//! Projection-as-data camera + pixel-perfect interactive-view math.
//!
//! Faza 1a (docs/VISION.md): a projection is DATA — the two integer screen-
//! pixel images of the world ground axes (`px_x`, `px_z`: y-down screen px
//! per 1 wu). Everything else — the orthographic camera basis (yaw/pitch/
//! roll), the px/wu scale, the vertical foreshortening, the px→world input
//! mapping and the wu-dimension validator — is DERIVED, so the pixel
//! contract (clean Bresenham stairs, lattice snapping, view rules #4–#7)
//! holds by construction for EVERY preset, never by tuning.
//!
//! The classic ISO_VIEW_CONTRACT (yaw 45°, pitch 30°, R = 32√2 px/wu,
//! 1 wu → 32 px H × 16 px V) is now just the [`iso21`] preset
//! `px_x = (32, 16)`, `px_z = (-32, 16)`. (VISION's `(2,-1)/(2,1)` notation
//! is the same pair with screen y up and the 16× lattice scale dropped.)
//! The Fallout-spirit [`trimetric`] preset — THE game projection since the
//! owner's 2026-07-12 pick — is `px_x = (40, 10)`, `px_z = (-20, 20)`: the
//! authentic Fallout 4:1 floor stair on X (14°), a clean 1:1 diagonal on Z
//! (45°), pitch 30°, UNIFORM stair runs on both ground axes, no roll, and
//! S = 20√5 px/wu — within 1.2% of iso21, so switching presets compares
//! angle, not zoom.
//!
//! The pixel-art wall contract (owner, 2026-07-12): world-vertical MUST
//! project screen-vertical — a rolled camera tips wall edges off the pixel
//! column and they rasterize as ragged stairs. Screen-vertical Y means the
//! camera right vector is horizontal (r̂y = 0), which for the data reads
//! `C = a1·b1 + a2·b2 = 0`; `derive` rejects everything else, so the
//! contract holds by construction. (The authentic Fallout lattice
//! (4,1)/(-4,3) carries ~3.7° roll and fails this — its verticals lean.)
//!
//! Derivation (why it is exact): an ortho camera with unit right `r̂`/up `û`
//! and uniform scale S px/wu maps a world vector w to screen px
//! (S·w·r̂, -S·w·û). Reading the ground-axis images back gives
//! r̂ = (a1/S, 0, a2/S) and û = (-b1/S, ûy, -b2/S). With A = a1²+a2² and
//! B = b1²+b2², |r̂| = 1 forces S = √A, |û| = 1 forces ûy = √(1 - B/A)
//! (real and positive iff A > B — equality is the top-down/edge-on
//! degeneracy), r̂·û = -C/S² = 0 holds by the contract gate, and
//! dir = û × r̂ has dir.y = -det(P)/A: data with det > 0 looks down at the
//! ground, everything else is rejected at derive time.

use glam::{DVec3, Mat3, Vec2, Vec3};
use std::sync::LazyLock;

/// One projection: the authored integer data plus everything derived from it.
/// Copy-small on purpose — it rides inside [`ViewXform`] so picks, stamps and
/// the render all agree on the frame's projection by value.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Projection {
    pub name: &'static str,
    /// Screen-px image of world +X per 1 wu (x right, y DOWN).
    pub px_x: [i32; 2],
    /// Screen-px image of world +Z per 1 wu.
    pub px_z: [i32; 2],
    /// Derived: screen px per wu (iso21: 32√2 — the old ISO_R).
    pub s: f32,
    // derived camera basis at yaw offset 0 (turntable turns rotate it about Y)
    right: Vec3,
    up: Vec3,
    dir: Vec3,
}

impl Projection {
    /// Derive the camera from the two ground-axis pixel images. Errors name
    /// the failure instead of producing a subtly wrong camera: collinear or
    /// mirrored images (det ≤ 0 — no downward-looking camera exists), rolled
    /// cameras (C ≠ 0 — wall verticals would lean off the pixel column and
    /// rasterize as ragged stairs), and top-down/edge-on degeneracies
    /// (A ≤ B — screen-up never leaves the ground plane).
    pub fn derive(name: &'static str, px_x: [i32; 2], px_z: [i32; 2]) -> Result<Projection, String> {
        let (a1, b1) = (px_x[0] as f64, px_x[1] as f64);
        let (a2, b2) = (px_z[0] as f64, px_z[1] as f64);
        let det = a1 * b2 - a2 * b1;
        if det <= 0.0 {
            return Err(format!("{name}: det(px_x, px_z) = {det} must be positive — collinear images have no px→world mapping, negative ones only an under-ground/mirrored camera"));
        }
        let c = a1 * b1 + a2 * b2;
        if c != 0.0 {
            return Err(format!(
                "{name}: a1·b1 + a2·b2 = {c} must be 0 (the pixel-art wall contract) — a rolled camera tips world-vertical off screen-vertical and wall edges rasterize as ragged stairs; rebalance the axis images so a1·b1 = -a2·b2"
            ));
        }
        let (aa, bb) = (a1 * a1 + a2 * a2, b1 * b1 + b2 * b2);
        let uy2 = 1.0 - bb / aa; // |û| = 1 with S = √A
        if uy2 <= 1e-9 {
            return Err(format!("{name}: degenerate camera (top-down or edge-on) — screen-up never tilts out of the ground plane (needs a1²+a2² > b1²+b2²)"));
        }
        let s = aa.sqrt();
        let r = DVec3::new(a1 / s, 0.0, a2 / s); // r̂y = 0 BY the C gate: verticals stay vertical
        let u = DVec3::new(-b1 / s, uy2.sqrt(), -b2 / s);
        let d = u.cross(r); // d.y = -det/A < 0: looks down, by the det check
        debug_assert!(d.y < 0.0 && r.dot(u).abs() < 1e-12);
        Ok(Projection { name, px_x, px_z, s: s as f32, right: r.as_vec3(), up: u.as_vec3(), dir: d.as_vec3() })
    }

    /// The camera basis (dir, right, up) for a turntable yaw offset — the
    /// derived base rotated about world Y (same tuple order as the old
    /// `iso_basis`, which this reproduces exactly for the iso21 data).
    pub fn basis(&self, yaw_off_deg: f32) -> (Vec3, Vec3, Vec3) {
        let rot = Mat3::from_rotation_y(yaw_off_deg.to_radians());
        (rot * self.dir, rot * self.right, rot * self.up)
    }

    /// World-space ground-plane deltas for one screen pixel: `u` = +1 px
    /// right, `v` = +1 px down — the columns of P⁻¹ (P = the authored pixel
    /// images), so "u projects to exactly (1, 0) px" is an identity, not a
    /// trig fact. iso21 reproduces the old closed forms (1 px right = 1/64 wu
    /// along the floor-right diagonal; 1 px down = 2/R wu toward the camera —
    /// the sin(pitch) foreshortening the 2026-06-09 learning documents).
    pub fn pixel_basis(&self, yaw_off_deg: f32) -> (Vec3, Vec3) {
        let det = (self.px_x[0] * self.px_z[1] - self.px_z[0] * self.px_x[1]) as f32;
        let u = Vec3::new(self.px_z[1] as f32, 0.0, -self.px_x[1] as f32) / det;
        let v = Vec3::new(-self.px_z[0] as f32, 0.0, self.px_x[0] as f32) / det;
        let rot = Mat3::from_rotation_y(yaw_off_deg.to_radians());
        (rot * u, rot * v)
    }

    /// Convert a screen-pixel delta (x right, y down) into a world ground delta.
    pub fn screen_px_to_world(&self, d: Vec2, yaw_off_deg: f32) -> Vec3 {
        let (u, v) = self.pixel_basis(yaw_off_deg);
        u * d.x + v * d.y
    }

    /// Snap a ground point to the nearest cell of the screen-pixel lattice,
    /// staying on its ground plane (y preserved) — uniform (1, 1) granularity
    /// (invariant #9). Every rendered mesh position routes through this so a
    /// moving box draws identically on every frame it occupies a pixel cell.
    pub fn snap_ground_to_lattice(&self, p: Vec3, yaw_off_deg: f32) -> Vec3 {
        let (_dir, right, up) = self.basis(yaw_off_deg);
        let (u, v) = self.pixel_basis(yaw_off_deg);
        let a = p.dot(right) * self.s; // screen px right
        let b = -p.dot(up) * self.s; // screen px down
        p + u * (a.round() - a) + v * (b.round() - b)
    }

    /// The projection's camera at an explicit world-space look-at `target`
    /// for a `low_w × low_h` lowpixel buffer (scale locked to `s` px/wu).
    /// `scene_min/max` only size the eye's backoff distance.
    pub fn camera_at(&self, scene_min: Vec3, scene_max: Vec3, low_w: u32, low_h: u32, yaw_off_deg: f32, target: Vec3) -> CamFrame {
        let (dir, right, up) = self.basis(yaw_off_deg);
        let half_w = low_w as f32 / (2.0 * self.s);
        let half_h = low_h as f32 / (2.0 * self.s);
        let dist = (scene_max - scene_min).length() * 1.5 + 5.0;
        let pos = target - dir * dist;
        CamFrame { right, up, dir, pos, half_w, half_h }
    }

    /// Whole stair steps per wu along each ground axis: gcd of the axis
    /// image's components. The primitive stair vector is `px / gcd`; a box
    /// edge renders a clean repeating stair iff its wu length is a whole
    /// multiple of `1/gcd` (iso21: 16 → the historical 0.0625-wu lattice;
    /// trimetric: 9 along X, 6 along Z).
    pub fn stairs_per_wu(&self) -> (u32, u32) {
        let g = |p: [i32; 2]| gcd(p[0].unsigned_abs(), p[1].unsigned_abs());
        (g(self.px_x), g(self.px_z))
    }

    /// The wu-dimension validator, generalized from the old
    /// `isoCleanGeometryValidator` (2026-05-16 learning): reject XZ extents
    /// whose silhouette can't rasterize as a clean repeating stair, naming
    /// the bad value and the nearest clean size. Y is exempt (it projects to
    /// irrational px under any tilted camera and never affects the stair).
    pub fn clean_xz(&self, dx: f32, dz: f32) -> Result<(), String> {
        let (gx, gz) = self.stairs_per_wu();
        let check = |len: f32, g: u32, axis: char| -> Result<(), String> {
            let steps = len * g as f32;
            if (steps - steps.round()).abs() > 1e-3 {
                return Err(format!(
                    "{}: {axis} extent {len} wu is not a multiple of the {axis}-axis stair step 1/{g} wu — nearest clean size {}",
                    self.name,
                    steps.round() / g as f32
                ));
            }
            Ok(())
        };
        check(dx, gx, 'x')?;
        check(dz, gz, 'z')
    }
}

fn gcd(a: u32, b: u32) -> u32 {
    if b == 0 {
        a
    } else {
        gcd(b, a % b)
    }
}

// ---- presets ----------------------------------------------------------------

/// The projection presets the ESC menu cycles (PROJ env for the harness).
/// Index order is the menu order; `presets()[0]` is the default.
static PRESETS: LazyLock<[Projection; 2]> = LazyLock::new(|| {
    [
        Projection::derive("iso21", [32, 16], [-32, 16]).expect("iso21 preset"),
        // THE game projection (owner pick, 2026-07-12). Fallout-spirit,
        // roll-free: X = the authentic Fallout 4:1 floor stair (14°), Z = a
        // clean 1:1 diagonal (45°), pitch 30°, uniform stair runs on BOTH
        // ground axes, verticals exactly vertical. This angle family is
        // px_x = (4j, j) / px_z = (-2j, 2j); j = 10 puts S = 20√5 = 44.72
        // px/wu within 1.2% of iso21's 32√2, so the ESC A/B compares pure
        // ANGLE, not zoom. (j = 8 read ~21% smaller — owner bounced it.)
        // Clean-size lattice: 1/10 wu along X, 1/20 along Z — author
        // architecture on the 0.1-wu grid.
        Projection::derive("trimetric", [40, 10], [-20, 20]).expect("trimetric preset"),
    ]
});

pub fn presets() -> &'static [Projection] {
    &*PRESETS
}

pub fn by_name(name: &str) -> Option<Projection> {
    presets().iter().find(|p| p.name == name).copied()
}

/// The classic pixel-perfect iso 2:1 contract, as data.
pub fn iso21() -> Projection {
    presets()[0]
}

/// The camera frame a view renders with: basis vectors, eye position and
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

/// Project a world point to its low-res pixel centre under the orthographic
/// camera — the inverse of shade.comp's per-pixel ray basis (`u = dot(rel,right)
/// / half_w`, then `px = (u·0.5+0.5)·W`; Y is flipped because screen Y runs down).
/// Both GPU backends call THIS one Rust fn to derive the dollhouse-reveal disc
/// centre, so the projection is bit-identical across Metal and Vulkan (no
/// in-shader projection → no FP-parity hazard against the golden compare).
pub fn project_lowres(cam: &CamFrame, w: i32, h: i32, p: Vec3) -> (f32, f32) {
    let rel = p - cam.pos;
    let u = rel.dot(cam.right) / cam.half_w;
    let v = rel.dot(cam.up) / cam.half_h;
    ((u * 0.5 + 0.5) * w as f32, (0.5 - v * 0.5) * h as f32)
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
/// applied to the *camera* so a moving view stays on the pixel lattice —
/// no sub-pixel crawl/shimmer). Round (not trunc) keeps |remainder| ≤ 0.5.
pub fn whole_pixel_step(accum: Vec2) -> (Vec2, Vec2) {
    let whole = Vec2::new(accum.x.round(), accum.y.round());
    (whole, accum - whole)
}

// ---- unprojection: window pixel -> world (inverse of the render chain) -----

/// shade.comp's pixel-centre tie-break: primary rays go through
/// `px + 0.5 + 1/64` so they never lie exactly on a world-lattice seam plane
/// (see the "primary ray through the pixel CENTRE" block there). The inverse
/// must use the same offset — drop it and every unprojected point is biased
/// 1/64 px toward the top-left.
pub const PIXEL_CENTER_TIE: f32 = 1.0 / 64.0;

/// How far behind the on-screen point `window_px_to_ray` starts its origin
/// (world units). The ground intersection is independent of it; occlusion
/// tests need the origin to precede all geometry — 64 wu comfortably exceeds
/// the renderer's own camera backoff (scene diagonal · 1.5 + 5) at house scale.
pub const RAY_BACKOFF: f32 = 64.0;

/// The view transform a frame actually rendered with — everything needed to
/// invert the tonemap upscale + pan crop + ortho camera for one window
/// pixel. The viewer builds one per click: `proj` is the frame's projection
/// preset, `target` / `yaw_off_deg` come from the SETTLED camera (clicks
/// during a rotation tween unproject at the target quarter — sim
/// determinism), `pan` is the float crop pan (the GPU crops at `round(pan)`
/// and so do we; the carried #5 remainder must not shift picks),
/// `render_scale` the integer upscale (#4), `low` / `vis` the low-buffer and
/// visible-region sizes in low pixels (`Renderer::low_and_vis`).
#[derive(Clone, Copy, Debug)]
pub struct ViewXform {
    pub proj: Projection,
    pub target: Vec3,
    pub yaw_off_deg: f32,
    pub pan: Vec2,
    pub render_scale: i32,
    pub low: Vec2,
    pub vis: Vec2,
}

/// The integer low pixel a window pixel shows — exactly tonemap.comp's
/// `lp = o / scale + ivec2(round(pan))` (integer division = floor for o ≥ 0;
/// floor(win/rs) equals floor(floor(win)/rs), so fractional cursor positions
/// pick the pixel they sit in).
fn window_px_to_low(win: Vec2, v: &ViewXform) -> Vec2 {
    let rs = v.render_scale.max(1) as f32;
    (win / rs).floor() + v.pan.round()
}

/// The camera ray that rendered low pixel `lp` — shade.comp's primary ray:
/// through the pixel centre + TIE bias, along the projection's view direction.
fn low_px_ray(lp: Vec2, v: &ViewXform) -> (Vec3, Vec3) {
    let (dir, right, up) = v.proj.basis(v.yaw_off_deg);
    let sx = lp.x + 0.5 + PIXEL_CENTER_TIE - v.low.x * 0.5; // px right of buffer centre
    let sy = lp.y + 0.5 + PIXEL_CENTER_TIE - v.low.y * 0.5; // px down
    let through = v.target + right * (sx / v.proj.s) - up * (sy / v.proj.s);
    (through - dir * RAY_BACKOFF, dir)
}

/// Pick ray for a window pixel (physical px, top-left origin) → (origin, unit
/// dir). Bit-faithful to the render: all rs×rs window pixels of one upscale
/// block return the SAME ray — the one whose colour they show on screen.
pub fn window_px_to_ray(win: Vec2, v: &ViewXform) -> (Vec3, Vec3) {
    low_px_ray(window_px_to_low(win, v), v)
}

/// FORWARD projection: world point → window pixel (the top-left of the
/// upscale block whose primary ray passes nearest the point). The inverse of
/// `window_px_to_ray` up to the block quantization — used to anchor screen
/// annotations (tactic bubbles) over world objects. Points off-screen come
/// back with out-of-range coordinates; callers clamp or cull.
pub fn world_to_window_px(p: Vec3, v: &ViewXform) -> Vec2 {
    let (_dir, right, up) = v.proj.basis(v.yaw_off_deg);
    let d = p - v.target;
    let sx = d.dot(right) * v.proj.s; // px right of the buffer centre
    let sy = -d.dot(up) * v.proj.s; // px down
    let lp = Vec2::new(sx - 0.5 - PIXEL_CENTER_TIE + v.low.x * 0.5, sy - 0.5 - PIXEL_CENTER_TIE + v.low.y * 0.5);
    let rs = v.render_scale.max(1) as f32;
    (lp - v.pan.round().floor()) * rs
}

/// Ground-plane (y = 0) pick for a window pixel. `None` when the pixel maps
/// outside the visible region or into the overscan guard band (#7 — those
/// pixels show no world); the game treats such clicks as no-ops (no
/// clamp-to-edge in v1).
pub fn window_px_to_ground(win: Vec2, v: &ViewXform) -> Option<Vec3> {
    let rs = v.render_scale.max(1) as f32;
    let s = win / rs;
    if win.x < 0.0 || win.y < 0.0 || s.x >= v.vis.x || s.y >= v.vis.y {
        return None;
    }
    let lp = window_px_to_low(win, v);
    if lp.x < 0.0 || lp.y < 0.0 || lp.x >= v.low.x || lp.y >= v.low.y {
        return None;
    }
    let (o, d) = low_px_ray(lp, v);
    let t = -o.y / d.y; // derive() guarantees dir.y < 0 — never parallel
    let p = o + d * t;
    Some(Vec3::new(p.x, 0.0, p.z))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The old hardcoded contract, for the regression pins below.
    const OLD_ISO_R: f32 = 45.254834; // 32·√2

    /// The pre-Faza-1a `iso_basis` closed form (yaw 45° + off, pitch 30°),
    /// kept ONLY here: the derived iso21 camera must reproduce it.
    fn legacy_iso_basis(yaw_off_deg: f32) -> (Vec3, Vec3, Vec3) {
        let yaw = (45.0 + yaw_off_deg).to_radians();
        let pitch = 30.0_f32.to_radians();
        let offset = Vec3::new(yaw.sin() * pitch.cos(), pitch.sin(), yaw.cos() * pitch.cos());
        let dir = -offset;
        let right = dir.cross(Vec3::Y).normalize();
        let up = right.cross(dir).normalize();
        (dir, right, up)
    }

    #[test]
    fn iso21_reproduces_the_legacy_contract() {
        let p = iso21();
        assert!((p.s - OLD_ISO_R).abs() < 1e-3, "s {} vs legacy R {OLD_ISO_R}", p.s);
        for q in 0..4 {
            let yaw = 90.0 * q as f32;
            let (d, r, u) = p.basis(yaw);
            let (ld, lr, lu) = legacy_iso_basis(yaw);
            assert!((d - ld).length() < 1e-6, "q{q} dir {d:?} vs {ld:?}");
            assert!((r - lr).length() < 1e-6, "q{q} right {r:?} vs {lr:?}");
            assert!((u - lu).length() < 1e-6, "q{q} up {u:?} vs {lu:?}");
        }
        // the historical clean-size lattice: 16 stair steps per wu, both axes
        assert_eq!(p.stairs_per_wu(), (16, 16));
    }

    /// THE by-construction pin: for every preset, pushing the world ground
    /// axes through the derived camera returns exactly the authored integer
    /// pixel images. Everything else (stairs, input mapping, validator)
    /// follows from these being exact.
    #[test]
    fn derived_camera_reprojects_the_axis_images_exactly() {
        for p in presets() {
            let (_d, right, up) = p.basis(0.0);
            for (axis, img) in [(Vec3::X, p.px_x), (Vec3::Z, p.px_z)] {
                let a = axis.dot(right) * p.s;
                let b = -axis.dot(up) * p.s;
                assert!((a - img[0] as f32).abs() < 1e-3, "{}: {axis:?} → ({a}, {b}) vs {img:?}", p.name);
                assert!((b - img[1] as f32).abs() < 1e-3, "{}: {axis:?} → ({a}, {b}) vs {img:?}", p.name);
            }
            // basis stays orthonormal and the camera looks down
            let (d, r, u) = p.basis(0.0);
            assert!(d.is_normalized() && r.is_normalized() && u.is_normalized(), "{}", p.name);
            assert!(r.dot(u).abs() < 1e-6 && d.y < 0.0, "{}", p.name);
        }
    }

    #[test]
    fn trimetric_is_roll_free_fallout_spirit_at_iso_scale() {
        let p = by_name("trimetric").unwrap();
        // j = 10 of the (4j,j)/(-2j,2j) family: optical parity with iso21
        assert!((p.s - 2000.0_f32.sqrt()).abs() < 1e-3, "s {}", p.s);
        assert!((p.s / iso21().s - 1.0).abs() < 0.02, "must sit within 2% of iso21's px/wu (owner: no zoom jump on switch)");
        let (d, r, u) = p.basis(0.0);
        assert_eq!(r.y, 0.0, "no roll — the pixel-art wall contract");
        assert!((u.y - 0.8660254).abs() < 1e-6, "up.y {}", u.y);
        assert!((d.y - -0.5).abs() < 1e-6, "pitch must be exactly 30°: dir.y {}", d.y);
        // uniform stair runs: primitives (4,1) on X and (-1,1) on Z
        assert_eq!(p.stairs_per_wu(), (10, 20));
    }

    /// The owner's wall contract (2026-07-12): a wall's vertical edge must
    /// rasterize as ONE pixel column. World +Y must project to screen px
    /// (0, -k) exactly, at every preset and every quarter turn.
    #[test]
    fn verticals_project_screen_vertical_for_every_preset() {
        for p in presets() {
            for q in 0..4 {
                let (_d, right, up) = p.basis(90.0 * q as f32);
                let a = Vec3::Y.dot(right) * p.s; // screen-x extent of a 1-wu vertical
                let b = -Vec3::Y.dot(up) * p.s; // screen-y (down) extent
                assert_eq!(a, 0.0, "{} q{q}: vertical leans {a} px/wu off the pixel column", p.name);
                assert!(b < 0.0, "{} q{q}: +Y must project UP the screen", p.name);
            }
        }
    }

    #[test]
    fn derive_rejects_degenerate_data() {
        // perpendicular equal-length images = a rotated top-down plan view
        assert!(Projection::derive("topdown", [16, 32], [-32, 16]).is_err());
        // collinear images: no px→world mapping exists
        assert!(Projection::derive("collinear", [32, 16], [64, 32]).is_err());
        // mirrored/under-ground camera (det < 0)
        assert!(Projection::derive("mirrored", [-32, 16], [32, 16]).is_err());
        // the authentic Fallout lattice carries ~3.7° roll: verticals lean —
        // rejected by the wall contract, with an error that says why
        let err = Projection::derive("fallout-rolled", [36, 9], [-24, 18]).unwrap_err();
        assert!(err.contains("vertical"), "roll rejection must name the wall contract: {err}");
    }

    #[test]
    fn clean_xz_validates_per_axis_stair_steps() {
        let iso = iso21();
        iso.clean_xz(0.75, 0.0625).expect("historical clean sizes stay clean");
        let err = iso.clean_xz(0.8, 1.0).unwrap_err();
        assert!(err.contains("0.8") && err.contains("0.8125"), "names the bad value + nearest clean: {err}");
        let tri = by_name("trimetric").unwrap();
        tri.clean_xz(0.1, 0.05).expect("the 0.1-wu authoring grid is clean under trimetric (0.05 on Z)");
        tri.clean_xz(0.3, 1.0).expect("tenths are clean along X");
        assert!(tri.clean_xz(0.25, 1.0).is_err(), "the old quarter-wu iso lattice is NOT clean along trimetric X");
        assert!(tri.clean_xz(1.0, 0.0625).is_err(), "sixteenths are NOT clean along trimetric Z");
    }

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
    fn pixel_basis_maps_exactly_one_screen_pixel_for_every_preset() {
        for p in presets() {
            for q in 0..4 {
                let yaw_off = 90.0 * q as f32;
                let (_d, right, up) = p.basis(yaw_off);
                let (u, v) = p.pixel_basis(yaw_off);
                // u projects to exactly (1, 0) screen px, v to (0, 1) (down-positive)
                assert!((u.dot(right) * p.s - 1.0).abs() < 1e-4, "{} q{q}", p.name);
                assert!((-u.dot(up) * p.s).abs() < 1e-4, "{} q{q}", p.name);
                assert!((v.dot(right) * p.s).abs() < 1e-4, "{} q{q}", p.name);
                assert!((-v.dot(up) * p.s - 1.0).abs() < 1e-4, "{} q{q}", p.name);
                // both are ground-plane vectors
                assert!(u.y.abs() < 1e-7 && v.y.abs() < 1e-7, "{} q{q}", p.name);
            }
        }
        // iso21 keeps the documented 2× vertical foreshortening (2026-06-09)
        let (u, v) = iso21().pixel_basis(0.0);
        assert!((v.length() / u.length() - 2.0).abs() < 1e-4);
    }

    #[test]
    fn snap_ground_lands_on_integer_lattice_for_every_preset() {
        for p in presets() {
            let (_d, right, up) = p.basis(0.0);
            let pt = Vec3::new(1.234, 0.0, -3.456);
            let s = p.snap_ground_to_lattice(pt, 0.0);
            let a = s.dot(right) * p.s;
            let b = -s.dot(up) * p.s;
            assert!((a - a.round()).abs() < 1e-3, "{} a {a}", p.name);
            assert!((b - b.round()).abs() < 1e-3, "{} b {b}", p.name);
            assert_eq!(s.y, 0.0, "{}", p.name); // stays on the ground plane
            // idempotent + never moves more than ~a pixel cell
            assert!((p.snap_ground_to_lattice(s, 0.0) - s).length() < 1e-4, "{}", p.name);
            assert!((s - pt).length() < 3.0 / p.s, "{}", p.name);
        }
    }

    // ---- unprojection ------------------------------------------------------

    /// Forward-project a world point to continuous low-pixel coordinates the
    /// way shade.comp renders it: pixel `lp` shows p iff its centre ray
    /// (lp + 0.5 + TIE about the buffer centre) passes through p. Written from
    /// the shader formula, independent of the unprojection implementation.
    fn project_to_low_px(p: Vec3, v: &ViewXform) -> Vec2 {
        let (_d, right, up) = v.proj.basis(v.yaw_off_deg);
        let a = (p - v.target).dot(right) * v.proj.s + v.low.x * 0.5 - 0.5 - PIXEL_CENTER_TIE;
        let b = -(p - v.target).dot(up) * v.proj.s + v.low.y * 0.5 - 0.5 - PIXEL_CENTER_TIE;
        Vec2::new(a, b)
    }

    #[test]
    fn unproject_ground_round_trips_at_all_quarters_for_every_preset() {
        // adversarial view at every yaw quarter: integer upscale > 1 AND a pan
        // with a fractional remainder (the carried #5 remainder must not shift
        // picks — the GPU crops at round(pan); one-pixel drift hides here).
        let low = Vec2::new(360.0, 260.0);
        let vis = Vec2::new(342.0, 214.0);
        let pan = Vec2::new(9.4, 22.6); // rounds to (9, 23)
        for p in presets() {
            for q in 0..4 {
                let v = ViewXform { proj: *p, target: Vec3::new(1.7, 0.4, -2.3), yaw_off_deg: 90.0 * q as f32, pan, render_scale: 3, low, vis };
                let g0 = Vec3::new(0.83, 0.0, -1.91); // arbitrary ground point
                let lp = project_to_low_px(g0, &v).round(); // nearest pixel-centre ray
                // any window pixel inside that low pixel's 3×3 upscale block
                let win = (lp - pan.round()) * 3.0 + Vec2::new(1.0, 2.7);
                let g1 = window_px_to_ground(win, &v).expect("inside the buffer");
                assert_eq!(g1.y, 0.0, "{} q{q}", p.name);
                // exact inversion: g1 reprojects to EXACTLY that pixel centre
                let back = project_to_low_px(g1, &v);
                assert!((back - lp).abs().max_element() < 1e-3, "{} q{q}: {back:?} vs {lp:?}", p.name);
                // and stays within the half-pixel quantisation of the click point
                assert!((g1 - g0).length() < 1.5 / p.s, "{} q{q}: {g1:?} vs {g0:?}", p.name);
            }
        }
    }

    #[test]
    fn unproject_is_block_constant_and_steps_one_pixel() {
        // one upscale block = one low pixel = one ground point, bit-identical;
        // crossing into the next block steps by EXACTLY the one-screen-pixel
        // ground basis (pixel_basis / screen_px_to_world) — this is the
        // direct detector for one-pixel click drift under remainder + scale.
        for p in presets() {
            let v = ViewXform { proj: *p, target: Vec3::new(-0.4, 0.25, 3.1), yaw_off_deg: 90.0, pan: Vec2::new(40.6, 23.4), render_scale: 5, low: Vec2::new(400.0, 300.0), vis: Vec2::new(380.0, 280.0) };
            let base = Vec2::new(35.0 * 5.0, 17.0 * 5.0); // top-left of one block
            let g = window_px_to_ground(base, &v).unwrap();
            for ox in 0..5 {
                for oy in 0..5 {
                    let w = base + Vec2::new(ox as f32 + 0.49, oy as f32);
                    assert_eq!(window_px_to_ground(w, &v), Some(g), "{} block px ({ox},{oy})", p.name);
                }
            }
            let gr = window_px_to_ground(base + Vec2::new(5.0, 0.0), &v).unwrap();
            let gd = window_px_to_ground(base + Vec2::new(0.0, 5.0), &v).unwrap();
            let step_r = g + p.screen_px_to_world(Vec2::new(1.0, 0.0), v.yaw_off_deg);
            let step_d = g + p.screen_px_to_world(Vec2::new(0.0, 1.0), v.yaw_off_deg);
            assert!((gr - step_r).length() < 1e-4, "{}: {gr:?} vs {step_r:?}", p.name);
            assert!((gd - step_d).length() < 1e-4, "{}: {gd:?} vs {step_d:?}", p.name);
        }
    }

    #[test]
    fn unproject_ray_passes_through_wall_point() {
        for p in presets() {
            let v = ViewXform { proj: *p, target: Vec3::new(0.5, 0.0, 0.25), yaw_off_deg: 0.0, pan: Vec2::new(12.0, 8.0), render_scale: 2, low: Vec2::new(300.0, 200.0), vis: Vec2::new(280.0, 180.0) };
            let (dir, right, up) = p.basis(0.0);
            // construct an off-ground "wall" point exactly on pixel (97, 41)'s
            // centre ray, 1 wu along it
            let lp = Vec2::new(97.0, 41.0);
            let sx = lp.x + 0.5 + PIXEL_CENTER_TIE - v.low.x * 0.5;
            let sy = lp.y + 0.5 + PIXEL_CENTER_TIE - v.low.y * 0.5;
            let w = v.target + right * (sx / p.s) - up * (sy / p.s) + dir * 1.0;
            assert!(w.y.abs() > 0.1, "genuinely off the ground plane: {w:?}");
            let win = (lp - v.pan) * 2.0 + Vec2::new(1.0, 0.0); // interior of the block
            let (o, d) = window_px_to_ray(win, &v);
            assert!((d - dir).length() < 1e-6, "{}", p.name);
            let t = (w - o).dot(d);
            assert!(t > 0.0, "{}: wall point must be in FRONT of the ray origin", p.name);
            assert!((o + d * t - w).length() < 1e-4, "{}: ray misses the wall point", p.name);
            // and the ground pick is exactly this ray's y=0 intersection
            let g = window_px_to_ground(win, &v).unwrap();
            assert!((o + d * (-o.y / d.y) - g).length() < 1e-4, "{}", p.name);
        }
    }

    #[test]
    fn unproject_rejects_off_window_and_guard_band() {
        let v = ViewXform { proj: iso21(), target: Vec3::ZERO, yaw_off_deg: 0.0, pan: Vec2::ZERO, render_scale: 2, low: Vec2::new(300.0, 200.0), vis: Vec2::new(280.0, 180.0) };
        assert!(window_px_to_ground(Vec2::new(-1.0, 5.0), &v).is_none());
        assert!(window_px_to_ground(Vec2::new(280.0 * 2.0, 5.0), &v).is_none()); // past vis
        assert!(window_px_to_ground(Vec2::new(5.0, 180.0 * 2.0), &v).is_none());
        assert!(window_px_to_ground(Vec2::new(1.0, 1.0), &v).is_some());
        // an unclamped pan lands in the guard band -> None, never a bogus point
        let v2 = ViewXform { pan: Vec2::new(-30.0, 0.0), ..v };
        assert!(window_px_to_ground(Vec2::new(1.0, 1.0), &v2).is_none());
    }
}
