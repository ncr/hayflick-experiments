//! View state + camera presentation: yaw / quarter-turn animation, zoom, pan,
//! lattice snapping, playerless camera panning, the click unprojection into
//! game commands, and the per-frame spotlight build from the game snapshot.
//! Player MOTION lives in house-game now (walk_system) — the viewer only
//! presents and translates input.

use crate::viewer::{Viewer, ZOOM_MAX, ZOOM_MIN};
use glam::{Vec2, Vec3};
use house_game::{flashlight_pose, iso_input_dir, recommended_min_px_per_sec, Command, PickRay};
use iso_core::{iso_basis, screen_px_to_world, whole_pixel_step, window_px_to_ground, window_px_to_ray, zoom_anchor_pan, ViewXform, ISO_R};
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
    /// Q = -1, E = +1. Mirrors the SIM's yaw_q (every change also queues
    /// RotateCamera).
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
    pub dragging: bool,
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
    /// integer target moves immediately, the camera eases after it. The turn
    /// is SIM state too: every press queues a matching RotateCamera command
    /// (the game applies it next tick; the ease is presentation-only).
    pub fn start_rotate(&mut self, delta: i32) {
        self.game.push(Command::RotateCamera { dq: delta as i8 });
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
    /// and the '0' reset; interactive q/e goes through `start_rotate`). Also
    /// queues the matching RotateCamera so the sim's yaw_q follows. The camera
    /// orbits its target.
    pub fn rotate(&mut self, delta: i32) {
        self.game.push(Command::RotateCamera { dq: delta as i8 });
        self.view.yaw_q = (self.view.yaw_q as i32 + delta).rem_euclid(4) as u32;
        self.view.rot = None; // instant turn supersedes any in-flight sweep
        self.view.move_accum = Vec2::ZERO;
        self.snap_target_to_lattice();
    }

    /// Snap the viewer's quarter to `target_q` WITHOUT queuing a RotateCamera
    /// command. `rotate` is for viewer-INITIATED turns (it tells the sim to
    /// follow); this is the inverse — the SIM already turned (a DEMO trace's
    /// `rotate` command, or any replay that rotated) and the viewer must catch
    /// up: re-snap the target onto the new yaw's lattice.
    /// No-op when already aligned.
    pub fn sync_view_yaw(&mut self, target_q: u32) {
        if self.view.yaw_q == target_q && self.view.rot.is_none() {
            return;
        }
        self.view.yaw_q = target_q;
        self.view.rot = None;
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

    /// Pan the camera by a screen-space delta in low pixels, quantised to
    /// whole low pixels with the remainder carried (#5 applied to the
    /// camera). Playerless scenes only — with a player the camera follows
    /// the sim instead (`follow_camera`).
    pub fn pan_camera_px(&mut self, d_low: Vec2) {
        self.view.move_accum += d_low;
        let (whole, rem) = whole_pixel_step(self.view.move_accum);
        self.view.move_accum = rem;
        if whole != Vec2::ZERO {
            let world = screen_px_to_world(whole, self.yaw_deg());
            self.pan_target(world);
        }
    }

    /// Held-key camera pan for scenes WITHOUT a player (lab) — the WASD
    /// branch the sim can't own (there is nothing to walk). Player scenes
    /// synthesize Command::Move per tick instead (`GameLoop::run_due`).
    pub fn pan_camera_held(&mut self, dt: f32) {
        let input_x = (self.game.held[3] as i32 - self.game.held[2] as i32) as f32; // right - left
        let input_y = (self.game.held[0] as i32 - self.game.held[1] as i32) as f32; // up - down
        let Some(dir) = iso_input_dir(input_x, input_y) else { return };
        let speed = self.pan_speed.max(recommended_min_px_per_sec(60.0));
        self.pan_camera_px(dir * speed * dt);
    }

    /// The ViewXform this frame's picks unproject through. During a rotation
    /// tween picks resolve at the SETTLED (target) quarter — sim determinism
    /// (ARCHITECTURE.md); `start_rotate` already snapped the camera target
    /// onto that yaw's lattice, so target and yaw are mutually consistent.
    pub fn pick_xform(&self) -> ViewXform {
        let q = self.view.rot.as_ref().map(|r| r.target).unwrap_or(self.view.yaw_q as i32);
        let (low, vis) = self.low_and_vis();
        ViewXform { target: self.view.target, yaw_off_deg: 90.0 * q as f32, pan: self.view.pan, render_scale: self.rs(), low, vis }
    }

    /// LMB in a player scene → Command::Click: the window pixel unprojects
    /// into a world pick ray + optional ground point HERE (window px never
    /// cross the game boundary); door-vs-walk resolution happens in-game.
    pub fn click_command(&mut self, win: Vec2) {
        let x = self.pick_xform();
        let (origin, dir) = window_px_to_ray(win, &x);
        let ground = window_px_to_ground(win, &x).map(|g| Vec2::new(g.x, g.z));
        self.game.push(Command::Click { ray: PickRay { origin, dir }, ground });
    }

    /// RMB → Command::Shoot (fires a projectile along the pick ray).
    pub fn shoot_command(&mut self, win: Vec2) {
        if !self.game.has_player {
            return;
        }
        let x = self.pick_xform();
        let (origin, dir) = window_px_to_ray(win, &x);
        self.game.push(Command::Shoot { ray: PickRay { origin, dir } });
    }

    /// Arena turret: keep the gun trained on the cursor. Unprojects the
    /// cursor to its ground point and pushes `Command::Aim` with the
    /// player→cursor world direction — but only when it moved ≥ ~0.5°, so a
    /// parked mouse adds nothing to the journal. Called every frame before
    /// the due ticks run.
    pub fn aim_command(&mut self, win: Vec2) {
        if !self.game.lmb_shoots {
            return;
        }
        let x = self.pick_xform();
        let Some(g) = window_px_to_ground(win, &x) else { return };
        let p = self.game.snap.player_pos;
        let Some(d) = (Vec2::new(g.x, g.z) - Vec2::new(p.x, p.z)).try_normalize() else { return };
        if self.game.last_aim.is_none_or(|la| la.dot(d) < 0.99996) {
            self.game.push(Command::Aim { dir: d });
            self.game.last_aim = Some(d);
        }
    }

    /// This frame's transient spotlights, read off the snapshot: the player
    /// flashlight (pose from the same pure fn the game's flashlight_system
    /// uses, at the lattice-SNAPPED snapshot position) and the 2-tick muzzle
    /// flash — at most N_RESERVED, packed into the reserved trailing NEE
    /// slots by record_frame.
    pub fn frame_spotlights(&self) -> Vec<Spotlight> {
        let mut v = Vec::new();
        if !self.game.has_player {
            return v;
        }
        let snap = &self.game.snap;
        if snap.flashlight {
            let (pos, dir) = flashlight_pose(snap.player_pos, snap.facing);
            // the NEE solid angle of an r=0.06 emitter is tiny (~3e-3 sr at
            // 2 wu) — slot radiance must be huge for a visible pool
            v.push(Spotlight { pos, dir, cone_cos: self.flash_cone.to_radians().cos(), power: self.flash_power * 1500.0, radius: 0.06, tint: rt_probe::render::SPOT_WARM });
        }
        if snap.muzzle_flash {
            // a muzzle flash is a POP, not a beam: a wide cone pointed
            // straight DOWN from just above the barrel tip pools hot light
            // AROUND the gun (the goo-light pattern) instead of painting a
            // flashlight cone across the floor. Recoil scales the burst.
            let f = snap.facing;
            let fd = glam::Vec3::new(f.x, 0.0, f.y);
            let (mp, _) = flashlight_pose(snap.player_pos, f);
            let pos = mp + fd * 0.55 + glam::Vec3::new(0.0, 0.30, 0.0);
            v.push(Spotlight { pos, dir: glam::Vec3::NEG_Y, cone_cos: 62.0f32.to_radians().cos(), power: 1500.0 * (1.0 + 1.2 * self.game.recoil), radius: 0.09, tint: rt_probe::render::SPOT_WARM });
        }
        // impact flash: a brief hot pop where the last round died (wall /
        // floor / blob splash) — the target-side half of the muzzle flash,
        // fading over its 3 ticks
        if let Some((at, ttl)) = self.game.impact_flash {
            let k = ttl as f32 / 3.0;
            v.push(Spotlight { pos: at + glam::Vec3::new(0.0, 0.26, 0.0), dir: glam::Vec3::NEG_Y, cone_cos: 60.0f32.to_radians().cos(), power: 1000.0 * k, radius: 0.07, tint: rt_probe::render::SPOT_WARM });
        }
        if let Some((at, k)) = snap.boom {
            // grenade detonation: a hot wide downward cone hovering over the
            // blast point, fading out over the flash ticks. Same tiny emitter
            // radius as the muzzle — packed slot radiance scales inversely
            // with emitter area, so a big radius quietly kills the flash.
            v.push(Spotlight {
                pos: at + glam::Vec3::new(0.0, 0.9, 0.0),
                dir: glam::Vec3::NEG_Y,
                cone_cos: 70.0f32.to_radians().cos(),
                power: 26000.0 * k,
                radius: 0.05,
                tint: [1.0, 0.72, 0.4],
            });
        }
        v
    }
}
