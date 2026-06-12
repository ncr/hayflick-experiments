//! View + player state: camera yaw / quarter-turn animation, zoom, pan,
//! lattice snapping, continuous held-key movement with collision, and the
//! player flashlight. The native mirror of the web view/runtime semantics.

use crate::renderer::{Renderer, ZOOM_MAX, ZOOM_MIN};
use glam::{Vec2, Vec3};
use rt_probe::*;

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
    /// Q = -1, E = +1. Tagged scenes re-mask near walls per turn (dollhouse).
    pub yaw_q: u32,
    /// which quarter the dollhouse masks are currently set for (swaps at the
    /// nearest-quarter crossing during a rotation sweep)
    pub mask_q: u32,
    /// in-flight smooth quarter-turn (q/e); None when settled at yaw_q
    pub rot: Option<RotAnim>,
    /// transient extra yaw in degrees during a MOVIE orbit sweep (0 when idle)
    pub yaw_anim: f32,
    /// float low-pixel crop offset; the GPU gets round(pan) (#5)
    pub pan: Vec2,
    /// the world look-at target (snapped to the pixel lattice)
    pub target: Vec3,
    /// sub-low-pixel remainder carried between moves (#5)
    pub move_accum: Vec2,
    pub cursor: Vec2, // window-space cursor (physical px)
    pub wheel_accum: f32, // accumulates scroll into discrete zoom steps
    pub dragging: bool,
}

/// Player state (the native @common/gameplay mirror): continuous position,
/// held-key input, collision level, camera-follow flag, and the facing the
/// flashlight aims along.
pub struct PlayerState {
    pub pos: Vec3,
    pub facing: Vec2, // world-XZ unit dir of the last walk input — beam aim
    pub dirty: bool,  // snapped position changed -> TLAS rebuild this frame
    pub held: [bool; 4], // up, down, left, right
    pub speed: f32,   // px/s (floored to the iso smoothness minimum)
    pub level: Level,
    pub follow_cam: bool, // camera tracks the player (grid scene: fixed camera)
}

impl Renderer {
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
    /// fully converged by construction; the dollhouse masks swap when the
    /// sweep crosses into a new nearest quarter.
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
        // swap the dollhouse masks at the nearest-quarter crossing (side-on)
        let mq = (r.turns.round() as i32).rem_euclid(4) as u32;
        let target_q = r.target.rem_euclid(4) as u32;
        if landed {
            self.view.yaw_q = target_q;
            self.view.rot = None;
            self.view.move_accum = Vec2::ZERO;
            self.snap_target_to_lattice();
        }
        if mq != self.view.mask_q {
            self.view.mask_q = mq;
            if !self.scene.prim_hide_mask.is_empty() {
                unsafe { self.gpu.set_yaw_masks(&self.ctx, mq) };
            }
            self.player.dirty = true; // TLAS rebuild applies the masks
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

    /// Rotate the view by quarter turns instantly (the movie's landing path;
    /// interactive q/e goes through `start_rotate`). The camera orbits its
    /// target; dollhouse-tagged scenes re-mask which perimeter walls are
    /// hidden, applied by the next TLAS rebuild.
    pub fn rotate(&mut self, delta: i32) {
        self.view.yaw_q = (self.view.yaw_q as i32 + delta).rem_euclid(4) as u32;
        self.view.rot = None; // instant turn supersedes any in-flight sweep
        self.view.mask_q = self.view.yaw_q;
        if !self.scene.prim_hide_mask.is_empty() {
            unsafe { self.gpu.set_yaw_masks(&self.ctx, self.view.yaw_q) };
        }
        self.view.move_accum = Vec2::ZERO;
        self.snap_target_to_lattice();
        self.player.dirty = true; // TLAS rebuild applies the new masks
    }

    /// Snap the camera target so the rendered world lands on the low-pixel
    /// lattice (shift by the sub-pixel projection remainder along right/up) —
    /// keeps the scene crisp regardless of the player's continuous position.
    pub fn snap_target_to_lattice(&mut self) {
        self.snap_target_for_yaw(self.yaw_deg());
    }

    pub fn snap_target_for_yaw(&mut self, yaw_deg: f32) {
        let (_d, right, up) = iso_basis(yaw_deg);
        let px = self.view.target.dot(right) * ISO_R;
        let py = self.view.target.dot(up) * ISO_R;
        self.view.target += right * ((px.round() - px) / ISO_R) + up * ((py.round() - py) / ISO_R);
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

    /// Move the player on the floor by a screen-space delta in low pixels,
    /// quantised to whole low pixels with the remainder carried (#5).
    pub fn move_player(&mut self, d_low: Vec2) {
        self.view.move_accum += d_low;
        let (whole, rem) = whole_pixel_step(self.view.move_accum);
        self.view.move_accum = rem;
        if whole != Vec2::ZERO {
            let world = screen_px_to_world(whole, self.yaw_deg());
            if self.scene.dynamic_prim.is_none() {
                // no player (lab scene): drag pans the camera — the world
                // follows the cursor, so the target moves opposite the drag.
                self.pan_target(-world);
            } else {
                let (nx, nz) = (self.player.pos.x + world.x, self.player.pos.z + world.z);
                self.commit_player(nx, nz);
            }
        }
    }

    /// Apply a new continuous player position — the web engine's contract:
    /// the game transform stays continuous, but the RENDERED mesh is snapped
    /// to the screen-pixel lattice on every move (`snapWorldPointOnGround`,
    /// nearest, uniform (1,1) granularity). The TLAS rebuild only happens when
    /// the snapped point crosses a pixel cell. In follow mode the camera
    /// target tracks the player.
    pub fn commit_player(&mut self, nx: f32, nz: f32) {
        let old_snap = snap_ground_to_lattice(self.player.pos, self.yaw_deg());
        self.player.pos.x = nx;
        self.player.pos.z = nz;
        let new_snap = snap_ground_to_lattice(self.player.pos, self.yaw_deg());
        if self.player.follow_cam {
            self.retarget(self.player.pos);
            self.recenter_pan();
        }
        if new_snap != old_snap {
            self.player.dirty = true;
        }
    }

    /// Continuous held-key movement (the native @common/gameplay loop): map the
    /// held inputs through the iso 2:1 direction, integrate at `player.speed`
    /// (floored to the smoothness minimum) over `dt` on the screen-pixel basis
    /// (`screen_px_to_world` — 1 px right = 1/R wu, 1 px down = 2/R wu), then
    /// collide against the level. Blocked moves slide along the unobstructed
    /// axis.
    pub fn update_motion(&mut self, dt: f32) {
        let input_x = (self.player.held[3] as i32 - self.player.held[2] as i32) as f32; // right - left
        let input_y = (self.player.held[0] as i32 - self.player.held[1] as i32) as f32; // up - down
        let Some(dir) = iso_input_dir(input_x, input_y) else { return };
        let speed = self.player.speed.max(recommended_min_px_per_sec(60.0));
        let dpx = dir * speed * dt; // screen pixels this frame (right, down)
        let world = screen_px_to_world(dpx, self.yaw_deg());

        if self.scene.dynamic_prim.is_none() {
            // no player (lab scene): WASD pans the camera in whole-low-pixel
            // steps with the remainder carried (#5 applied to the camera).
            self.view.move_accum += dpx;
            let (whole, rem) = whole_pixel_step(self.view.move_accum);
            self.view.move_accum = rem;
            if whole != Vec2::ZERO {
                let w = screen_px_to_world(whole, self.yaw_deg());
                self.pan_target(w);
            }
            return;
        }

        // walk input aims the flashlight, even when the move itself is blocked
        // (turning in place against a wall)
        if let Some(f) = Vec2::new(world.x, world.z).try_normalize() {
            self.player.facing = f;
        }

        let (ox, oz) = (self.player.pos.x, self.player.pos.z);
        let (nx, nz) = (ox + world.x, oz + world.z);
        let (mut px, mut pz) = (ox, oz);
        if !self.player.level.is_blocked(nx, nz) {
            px = nx;
            pz = nz;
        } else {
            // slide: keep whichever axis is clear (nicer than a hard wall stop)
            if world.x != 0.0 && !self.player.level.is_blocked(nx, oz) {
                px = nx;
            }
            if world.z != 0.0 && !self.player.level.is_blocked(px, nz) {
                pz = nz;
            }
        }
        if px != ox || pz != oz {
            self.commit_player(px, pz);
        }
    }

    /// 'f' / the menu toggle: the player-held spotlight.
    pub fn toggle_flashlight(&mut self) {
        self.flash_on = !self.flash_on;
        println!("flashlight: {}", if self.flash_on { "on" } else { "off" });
    }

    /// Refresh the reserved NEE flashlight slot from the player pose + knobs.
    /// Runs every frame before the command buffer records; the per-frame
    /// practicals upload streams the slot to the GPU along with everything
    /// else (compute_practicals never touches it).
    pub fn update_flashlight(&mut self) {
        let rec: [f32; 12] = if self.flash_on && self.scene.dynamic_prim.is_some() {
            let p = snap_ground_to_lattice(self.player.pos, self.yaw_deg());
            let f = self.player.facing;
            // held at hand height, far enough in front of the pillar (half
            // extent 0.1875) that the body never occludes its own beam; aimed
            // ahead and pitched down so the cone pools a couple of tiles out
            let pos = Vec3::new(p.x + f.x * 0.32, p.y + 0.95, p.z + f.y * 0.32);
            let dir = Vec3::new(f.x, -0.55, f.y).normalize();
            // the NEE solid angle of an r=0.06 emitter is tiny (~3e-3 sr at
            // 2 wu) — slot radiance must be huge for a visible pool
            let c = self.flash_power * 1500.0;
            let cone_cos = self.flash_cone.to_radians().cos();
            [pos.x, pos.y, pos.z, 0.06, c, c * 0.97, c * 0.88, cone_cos, dir.x, dir.y, dir.z, 2.0]
        } else {
            [0.0; 12]
        };
        self.gpu.lights_cpu[self.gpu.flash_idx] = rec;
    }
}
