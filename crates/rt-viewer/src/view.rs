//! View state + camera presentation: yaw / quarter-turn animation, zoom, pan,
//! lattice snapping, and the click unprojection into the gym's click-to-move.
//! Player MOTION lives in house-game (the gym sim) — the viewer only
//! presents and translates input.

use crate::viewer::{Viewer, ZOOM_MAX, ZOOM_MIN};
use glam::{Vec2, Vec3};
use iso_core::{window_px_to_ground, zoom_anchor_pan, ViewXform};

/// Interactive quarter-turn animation — the native mirror of the web
/// `RotationAnimation` (`viewport-animation.ts`, framing preset): exponential
/// approach toward the integer target at ROT_RATE/s, then a fixed 0.08s
/// smoothstep settle once within ROT_EPS so it lands EXACTLY. Extra q/e
/// presses mid-flight just move `target` and the ease redirects.
pub struct RotAnim {
    pub turns: f32, // animated absolute quarter-turns (unbounded; yaw = 90°·turns)
    pub target: i32,
    pub settle: Option<(f32, f32)>, // (from_turns, elapsed_secs) of the snap settle
}
const ROT_RATE: f32 = 18.0; // web framing preset rotationAnimationRate
const ROT_EPS: f32 = 0.012; // hand over to the fixed settle ~1° out
const ROT_SETTLE: f32 = 0.08; // web RotationAnimation.SNAP_SETTLE_SECONDS

/// Camera/view state: zoom, yaw, crop pan, the movable look-at target.
pub struct ViewState {
    pub zoom: f32,
    /// camera yaw in quarter-turns from canonical (web rotateQuarterTurns):
    /// Q = -1, E = +1. Presentation-only — the gym shell mirrors it for
    /// screen-relative WASD.
    pub yaw_q: u32,
    /// in-flight smooth quarter-turn (q/e); None when settled at yaw_q
    pub rot: Option<RotAnim>,
    /// transient extra yaw in degrees during a MOVIE orbit sweep (0 when idle)
    pub yaw_anim: f32,
    /// float low-pixel crop offset; the GPU gets round(pan) (#5)
    pub pan: Vec2,
    /// the world look-at target (snapped to the pixel lattice)
    pub target: Vec3,
    /// sub-low-pixel remainder carried between camera pans (#5)
    pub move_accum: Vec2,
    pub cursor: Vec2, // window-space cursor (physical px)
    pub wheel_accum: f32, // accumulates scroll into discrete zoom steps
}

impl Viewer {
    /// Camera yaw offset in degrees: the animated quarter-turn sweep when one
    /// is in flight, else the settled quarter-turn count; plus the transient
    /// movie-orbit sweep (0 outside MOVIE mode).
    pub fn yaw_deg(&self) -> f32 {
        let base = match &self.view.rot {
            Some(r) => 90.0 * r.turns,
            None => 90.0 * self.view.yaw_q as f32,
        };
        base + self.view.yaw_anim
    }

    /// q/e: start (or extend) the smooth quarter-turn — web semantics: the
    /// integer target moves immediately, the camera eases after it.
    pub fn start_rotate(&mut self, delta: i32) {
        let target = match &mut self.view.rot {
            Some(r) => {
                r.target += delta;
                r.settle = None; // retargeted mid-settle -> back to the ease
                r.target
            }
            None => {
                let target = self.view.yaw_q as i32 + delta;
                self.view.rot = Some(RotAnim { turns: self.view.yaw_q as f32, target, settle: None });
                target
            }
        };
        // Align the target to the DESTINATION yaw's pixel lattice NOW: snapping
        // at landing instead shifts the whole image by a subpixel hop in the
        // final (slow, attention-grabbing) frame. Here the half-px hop is
        // swallowed by the sweep's own motion.
        self.snap_target_for_yaw(90.0 * target as f32);
    }

    /// Advance the in-flight rotation by `dt`. Every det frame of the sweep is
    /// fully converged by construction.
    pub fn advance_rotation(&mut self, dt: f32) {
        let Some(r) = &mut self.view.rot else { return };
        let tgt = r.target as f32;
        let mut landed = false;
        if let Some((from, elapsed)) = &mut r.settle {
            *elapsed += dt.max(0.0);
            let t = (*elapsed / ROT_SETTLE).clamp(0.0, 1.0);
            let e = t * t * (3.0 - 2.0 * t);
            r.turns = *from + (tgt - *from) * e;
            if t >= 1.0 {
                r.turns = tgt;
                landed = true;
            }
        } else {
            r.turns += (tgt - r.turns) * (1.0 - (-ROT_RATE * dt).exp());
            if (r.turns - tgt).abs() <= ROT_EPS {
                r.settle = Some((r.turns, 0.0));
            }
        }
        let target_q = r.target.rem_euclid(4) as u32;
        if landed {
            self.view.yaw_q = target_q;
            self.view.rot = None;
            self.view.move_accum = Vec2::ZERO;
            self.snap_target_to_lattice();
        }
    }

    /// Step the zoom by whole increments (web `stepCameraZoom`: target +
    /// direction * zoomStep, clamped to [zoomMin, zoomMax]), keeping the world
    /// point under window-pixel `c` fixed (#6).
    pub fn zoom_step(&mut self, dir: i32, c: Vec2) {
        let rs0 = self.rs() as f32;
        self.view.zoom = (self.view.zoom + dir as f32).clamp(ZOOM_MIN, ZOOM_MAX);
        let rs1 = self.rs() as f32;
        if rs1 != rs0 {
            self.view.pan = zoom_anchor_pan(self.view.pan, c, rs0, rs1);
        }
        self.clamp_pan_to_buffer();
    }

    /// Rotate the view by quarter turns instantly (the movie's landing path
    /// and the '0' reset; interactive q/e goes through `start_rotate`). The
    /// camera orbits its target.
    pub fn rotate(&mut self, delta: i32) {
        self.view.yaw_q = (self.view.yaw_q as i32 + delta).rem_euclid(4) as u32;
        self.view.rot = None; // instant turn supersedes any in-flight sweep
        self.view.move_accum = Vec2::ZERO;
        self.snap_target_to_lattice();
    }

    /// Snap the camera target so the rendered world lands on the low-pixel
    /// lattice (shift by the sub-pixel projection remainder along right/up) —
    /// keeps the scene crisp regardless of the player's continuous position.
    pub fn snap_target_to_lattice(&mut self) {
        self.snap_target_for_yaw(self.yaw_deg());
    }

    pub fn snap_target_for_yaw(&mut self, yaw_deg: f32) {
        let (_d, right, up) = self.proj.basis(yaw_deg);
        let px = self.view.target.dot(right) * self.proj.s;
        let py = self.view.target.dot(up) * self.proj.s;
        self.view.target += right * ((px.round() - px) / self.proj.s) + up * ((py.round() - py) / self.proj.s);
    }

    /// Re-aim the camera at `new_target`, snapped to the lattice.
    pub fn retarget(&mut self, new_target: Vec3) {
        self.view.target = new_target;
        self.snap_target_to_lattice();
    }

    /// Move the camera target by a world delta (whole-pixel quantisation has
    /// already happened in screen space), keeping it on the pixel lattice.
    pub fn pan_target(&mut self, world: Vec3) {
        self.retarget(self.view.target + world);
    }

    /// Follow-cam: track the EASED player body (the gym sim steps whole
    /// cells; the loop glides between them), re-snapped to the lattice by
    /// `retarget` like every camera move.
    pub fn follow_player_camera(&mut self) {
        let p = self.gym.cam_target();
        if p == self.gym.last_cam {
            return;
        }
        self.gym.last_cam = p;
        self.retarget(p);
        self.recenter_pan();
    }

    /// The ViewXform this frame's picks unproject through. During a rotation
    /// tween picks resolve at the SETTLED (target) quarter; `start_rotate`
    /// already snapped the camera target onto that yaw's lattice, so target
    /// and yaw are mutually consistent.
    pub fn pick_xform(&self) -> ViewXform {
        let q = self.view.rot.as_ref().map(|r| r.target).unwrap_or(self.view.yaw_q as i32);
        let (low, vis) = self.low_and_vis();
        ViewXform { proj: self.proj, target: self.view.target, yaw_off_deg: 90.0 * q as f32, pan: self.view.pan, render_scale: self.rs(), low, vis }
    }

    /// LMB: unproject to the ground and hand the click to the gym loop's
    /// click-to-move planner (window px never cross the game boundary — the
    /// plan feeds pure Move commands).
    pub fn click_move(&mut self, win: Vec2) {
        let x = self.pick_xform();
        if let Some(g) = window_px_to_ground(win, &x) {
            self.gym.click_ground(g);
        }
    }
}
