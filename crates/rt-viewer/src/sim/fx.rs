//! Presentation-only game-feel FX: recoil, screenshake trauma, hit flashes,
//! bleed droplets, impact sparks, hitstop and the weak-blob lag glitch. All of
//! it is fed by the arena event tap and decayed on the TICK clock (never the
//! wall clock) so DEMO captures reproduce every kick and mote bit-exactly.
//! Nothing in this module feeds back into the sim — pure shell state, grouped
//! into [`Fx`] so `GameLoop` carries one field instead of fourteen.

use super::GameLoop;
use glam::Vec3;
use house_game::TICK_DT;

/// One bleed droplet: a tiny glowing ball torn off a blob by uzi fire,
/// ballistic to the floor, gone in half a second.
/// Seconds a landed splat spends spreading/fading before it despawns.
pub(super) const SPLAT_LIFE: f32 = 0.45;

/// One impact spark: a hot debris mote thrown where a round died. Ballistic,
/// gone in a quarter second — pure presentation, the droplets' hard twin.
pub struct Spark {
    pub pos: Vec3,
    pub vel: Vec3,
    pub age: f32,
}
/// Seconds a spark lives (shrinking the whole way).
pub(super) const SPARK_LIFE: f32 = 0.26;

pub struct Droplet {
    pub pos: Vec3,
    pub vel: Vec3,
    pub age: f32,
    /// <0 = airborne; >=0 = seconds since it hit the floor and became a
    /// flattening SPLAT (a widening puddle disc that fades out).
    pub splat: f32,
}

/// One weak blob's cached render body (see [`Fx::glitch`]).
pub(super) struct GlitchEntry {
    pub(super) id: house_game::MobId,
    pub(super) parts: [Vec3; house_game::GOO_PARTICLES],
    pub(super) vscale: f32,
    pub(super) refreshed: u32,
}

/// The gun/walk-feel FX state (PRESENTATION-ONLY, fed by the arena event tap,
/// decayed on the tick clock so DEMO replays reproduce them exactly).
pub struct Fx {
    /// Live render droplets (uzi bleed FX). PRESENTATION-ONLY: spawned off the
    /// event tap, advanced on the tick clock, never touches the sim.
    pub droplets: Vec<Droplet>,
    /// Render-side scatter counter for droplet spray directions (not sim RNG).
    pub(super) drop_seed: u32,
    /// recoil 0..1 — the selected gun's kick-back/pitch-up, armed per shot.
    pub recoil: f32,
    /// Screenshake trauma 0..1 — shots and detonations add, offset is
    /// trauma² (small hits barely tickle, a boom really throws the frame).
    pub trauma: f32,
    /// Per-blob hit flash 0..1 — a connecting shot blinks the body hot white.
    pub hit_flash: Vec<(house_game::MobId, f32)>,
    /// Walk-feel FX (arena only, tick-clocked like the rest):
    /// last tick's player position — the shell-side velocity estimate.
    pub(super) prev_player: Vec3,
    /// Smoothed player world-XZ velocity (wu/s) — drives the droid's lean
    /// into the motion and the hover-bob amplitude.
    pub lean_vel: glam::Vec2,
    /// Servo-step cadence accumulator + cues due (drained by the shell).
    pub(super) step_accum: f32,
    pub(super) steps_due: u32,
    /// Live impact sparks: hot debris motes thrown where a round died
    /// (wall/floor Impact events AND blob splashes). Tick-clocked twin of
    /// `droplets`, rendered from the "spark_slot" pool.
    pub sparks: Vec<Spark>,
    /// The most recent impact point + ticks left of its light pop — the
    /// target-side half of the muzzle flash (frame_spotlights reads it).
    pub impact_flash: Option<(Vec3, u32)>,
    /// Hitstop frames left: a terminal kill/solidify freezes the LIVE sim a
    /// few frames for punch. DEMO/SHOT ignore it (tick-deterministic).
    pub freeze: u32,
    /// Presentation frame counter (advances with sim ticks) for the glitch FX.
    pub(super) fx_frame: u32,
    /// Netcode-lag glitch cache: WEAK blobs render from a STALE body snapshot
    /// refreshed every ~8–15 ticks (per-id period), so a nearly-dead blob
    /// stutter-teleports while its true hitbox crawls on — aim at where it IS,
    /// not where it draws. Presentation-only (the sim never reads this).
    pub(super) glitch: Vec<GlitchEntry>,
}

impl Fx {
    /// Fresh, quiet FX state; `player0` seeds the walk-velocity estimate.
    pub(super) fn new(player0: Vec3) -> Fx {
        Fx {
            droplets: Vec::new(),
            drop_seed: 0,
            recoil: 0.0,
            trauma: 0.0,
            hit_flash: Vec::new(),
            prev_player: player0,
            lean_vel: glam::Vec2::ZERO,
            step_accum: 0.0,
            steps_due: 0,
            sparks: Vec::new(),
            impact_flash: None,
            freeze: 0,
            fx_frame: 0,
            glitch: Vec::new(),
        }
    }
}

impl GameLoop {
    /// Advance the presentation FX by `n` sim ticks: drain the arena event
    /// tap into droplet sprays, gun recoil, screenshake trauma and blob hit
    /// flashes, integrate droplet ballistics, and decay the transients.
    /// Tick-clocked (not wall-clocked) so DEMO captures stay reproducible.
    /// Presentation-only — nothing here feeds back into the sim.
    pub fn tick_fx(&mut self, n: u32) {
        self.fx.fx_frame = self.fx.fx_frame.wrapping_add(n);
        self.update_glitch();
        // drain the tap into a local list first so the arms below can call
        // &mut self helpers (spawn_sparks) without fighting the tap borrow
        let evs: Vec<house_game::GameEvent> = self.sim.res.event_tap.as_mut().map(std::mem::take).unwrap_or_default();
        {
            for ev in evs {
                match ev {
                    house_game::GameEvent::GooSplashed(_, at, dir, punch) => {
                        // spray budget: a pinprick sheds a couple of motes, a slug
                        // or point-blank volley tears off a real spray
                        let count = (3.0 + punch * 0.9).min(14.0) as u32;
                        let fwd = glam::Vec2::new(dir.x, dir.z).normalize_or_zero();
                        let side = glam::Vec2::new(-fwd.y, fwd.x);
                        for _ in 0..count {
                            self.fx.drop_seed = self.fx.drop_seed.wrapping_add(1);
                            let h = self.fx.drop_seed.wrapping_mul(2654435761);
                            let r0 = (h & 0xff) as f32 / 255.0;
                            let r1 = ((h >> 8) & 0xff) as f32 / 255.0;
                            let r2 = ((h >> 16) & 0xff) as f32 / 255.0;
                            // mostly THROUGH the body along the shot, fanned to the
                            // sides — an exit spray, not a fountain
                            let xz = (fwd * (0.5 + r0 * 0.9) + side * (r1 - 0.5) * 1.3).normalize_or_zero() * (1.0 + punch * (0.18 + 0.12 * r2));
                            let up = 1.3 + r2 * 1.3 + punch * 0.06;
                            self.fx.droplets.push(Droplet { pos: at + Vec3::new(0.0, 0.1, 0.0), vel: Vec3::new(xz.x, up, xz.y), age: 0.0, splat: -1.0 });
                        }
                        // plus the hard-impact tell at the splash point: hot
                        // sparks + a brief light pop (the goo motes alone
                        // read as goo, not as YOUR hit landing)
                        self.spawn_sparks(at + Vec3::new(0.0, 0.10, 0.0), Vec3::new(dir.x, 0.4, dir.z), 3);
                        self.fx.impact_flash = Some((at, 3));
                    }
                    house_game::GameEvent::Impact(at, n) => {
                        // a round died on a wall / chunk / the floor: debris
                        // sparks off the surface + the impact light pop
                        self.spawn_sparks(at, n * 1.1, 6);
                        self.fx.impact_flash = Some((at, 3));
                    }
                    house_game::GameEvent::ShotFired(_, class) => {
                        // per-weapon hand feel: kick the gun model, bump the shake
                        use house_game::WeaponClass as W;
                        let (kick, shake) = match class {
                            W::Slug => (1.0, 0.30),
                            W::Uzi => (0.45, 0.09),
                            W::Shotgun => (1.0, 0.42),
                            W::Grenade => (0.7, 0.15),
                            W::Harpoon => (0.9, 0.25),
                            W::Standard => (0.6, 0.15),
                        };
                        self.fx.recoil = self.fx.recoil.max(kick);
                        self.fx.trauma = (self.fx.trauma + shake).min(1.0);
                    }
                    house_game::GameEvent::Detonated(_) => {
                        self.fx.trauma = (self.fx.trauma + 0.65).min(1.0);
                        self.fx.freeze = self.fx.freeze.max(3);
                    }
                    house_game::GameEvent::WaveLanded(_) => {
                        self.fx.trauma = (self.fx.trauma + 0.30).min(1.0);
                    }
                    house_game::GameEvent::MobHit(id, _) => {
                        // blink the surviving body hot white (dead ones already
                        // play the split/die choreography)
                        match self.fx.hit_flash.iter_mut().find(|(i, _)| *i == id) {
                            Some((_, f)) => *f = 0.8,
                            None => self.fx.hit_flash.push((id, 0.8)),
                        }
                    }
                    // hitstop: terminal kills freeze the live sim a beat —
                    // the classic punch frame (the shell skips run_due while
                    // freeze > 0; DEMO/SHOT ignore it)
                    house_game::GameEvent::MobKilled(..) => {
                        self.fx.freeze = self.fx.freeze.max(4);
                        self.fx.trauma = (self.fx.trauma + 0.12).min(1.0);
                    }
                    house_game::GameEvent::MobSolidified(..) => {
                        self.fx.freeze = self.fx.freeze.max(5);
                        self.fx.trauma = (self.fx.trauma + 0.18).min(1.0);
                    }
                    _ => {}
                }
            }
        }
        // decay the gun-feel transients on the tick clock (frame-rate free)
        if n > 0 {
            let (kr, kt, kf) = (0.80f32.powi(n as i32), 0.88f32.powi(n as i32), 0.76f32.powi(n as i32));
            self.fx.recoil = if self.fx.recoil * kr > 0.01 { self.fx.recoil * kr } else { 0.0 };
            self.fx.trauma = if self.fx.trauma * kt > 0.01 { self.fx.trauma * kt } else { 0.0 };
            for (_, f) in self.fx.hit_flash.iter_mut() {
                *f *= kf;
            }
            self.fx.hit_flash.retain(|(_, f)| *f > 0.03);
            // walk-feel: estimate the player's world velocity off the snapshot
            // deltas, smooth it into the lean, and run the servo-step cadence
            // (arena only — the cave game keeps its stillness)
            if self.lmb_shoots {
                let dt = TICK_DT * n as f32;
                let dp = self.snap.player_pos - self.fx.prev_player;
                let vel = glam::Vec2::new(dp.x, dp.z) / dt;
                self.fx.lean_vel += (vel - self.fx.lean_vel) * (1.0 - 0.70f32.powi(n as i32));
                // step cadence scales with speed; ~4.3 ticks between cues at a
                // full 2 wu/s sprint, silent below a slow drift
                let speed = self.fx.lean_vel.length();
                if speed > 0.25 {
                    self.fx.step_accum += (speed / 2.0).min(1.25) * n as f32 / 14.0;
                    while self.fx.step_accum >= 1.0 {
                        self.fx.step_accum -= 1.0;
                        self.fx.steps_due += 1;
                    }
                } else {
                    self.fx.step_accum = 0.0;
                }
            }
            self.fx.prev_player = self.snap.player_pos;
        }
        // sparks: fast hard ballistics, shrink-and-gone in a quarter second
        if n > 0 && !self.fx.sparks.is_empty() {
            let dt = TICK_DT * n as f32;
            for s in self.fx.sparks.iter_mut() {
                s.vel.y -= 13.0 * dt;
                s.pos += s.vel * dt;
                s.age += dt;
            }
            self.fx.sparks.retain(|s| s.age < SPARK_LIFE && s.pos.y > -0.05);
        }
        if n > 0 {
            self.fx.impact_flash = self.fx.impact_flash.and_then(|(at, ttl)| (ttl > n).then(|| (at, ttl - n)));
        }
        if n > 0 && !self.fx.droplets.is_empty() {
            let dt = TICK_DT * n as f32;
            for d in self.fx.droplets.iter_mut() {
                if d.splat < 0.0 {
                    d.vel.y -= 9.0 * dt;
                    d.pos += d.vel * dt;
                    d.age += dt;
                    // touchdown → become a floor splat (skip if it aged out)
                    if d.pos.y <= 0.03 && d.vel.y < 0.0 {
                        d.pos.y = 0.02;
                        d.splat = 0.0;
                    }
                } else {
                    d.splat += dt;
                }
            }
            self.fx.droplets.retain(|d| if d.splat < 0.0 { d.age < 0.9 } else { d.splat < SPLAT_LIFE });
        }
    }

    /// Throw `count` hot debris motes from `at`, biased along `bias` (the
    /// surface normal, or the splash direction lifted a little) — the
    /// particle half of the impact tell. Same hash scatter as the droplets.
    fn spawn_sparks(&mut self, at: Vec3, bias: Vec3, count: u32) {
        for _ in 0..count {
            self.fx.drop_seed = self.fx.drop_seed.wrapping_add(1);
            let h = self.fx.drop_seed.wrapping_mul(2654435761);
            let r0 = (h & 0xff) as f32 / 255.0 - 0.5;
            let r1 = ((h >> 8) & 0xff) as f32 / 255.0 - 0.5;
            let r2 = ((h >> 16) & 0xff) as f32 / 255.0;
            let v = (bias * (1.2 + r2 * 1.6) + Vec3::new(r0 * 2.4, 1.2 + r2 * 1.0, r1 * 2.4)) * 1.4;
            self.fx.sparks.push(Spark { pos: at, vel: v, age: 0.0 });
        }
    }

    /// Drain the servo-step cues accumulated by the walk cadence (the shell
    /// plays one "step" tick per unit — presentation audio only).
    pub fn take_steps(&mut self) -> u32 {
        std::mem::take(&mut self.fx.steps_due)
    }

    /// The presentation frame counter (advances with sim ticks) — the shell's
    /// clock for tick-locked FX like the hover bob.
    pub fn fx_frame(&self) -> u32 {
        self.fx.fx_frame
    }

    /// This frame's screenshake offset in low-res px. Trauma² scaling (small
    /// arms tickle, a detonation throws the frame), direction from an integer
    /// hash of the tick clock — deterministic, zero when calm, and bounded
    /// well inside the low-buffer overscan margin.
    pub fn shake_px(&self) -> glam::Vec2 {
        if self.fx.trauma <= 0.0 {
            return glam::Vec2::ZERO;
        }
        const MAX_SHAKE_PX: f32 = 4.5;
        let a = self.fx.trauma * self.fx.trauma;
        let h = self.fx.fx_frame.wrapping_mul(2654435761);
        let nx = ((h >> 8) & 0xff) as f32 / 127.5 - 1.0;
        let ny = ((h >> 16) & 0xff) as f32 / 127.5 - 1.0;
        glam::Vec2::new(nx, ny) * (MAX_SHAKE_PX * a)
    }

    /// Maintain the lag-glitch cache: every WEAK blob gets a cached body that
    /// only refreshes on its own ~8–15-tick period (id-hashed, so a pack of
    /// weak blobs never snaps in unison); healthy and dead blobs drop out.
    fn update_glitch(&mut self) {
        let frame = self.fx.fx_frame;
        let snap = &self.snap;
        self.fx.glitch.retain(|e| snap.mobs.iter().any(|m| m.id == e.id && m.weak));
        for m in &self.snap.mobs {
            if !m.weak {
                continue;
            }
            let period = 8 + ((m.id.0.wrapping_mul(2654435761) >> 28) % 8);
            match self.fx.glitch.iter_mut().find(|e| e.id == m.id) {
                Some(e) => {
                    if frame.wrapping_sub(e.refreshed) >= period {
                        e.parts = m.parts;
                        e.vscale = m.vscale;
                        e.refreshed = frame;
                    }
                }
                None => self.fx.glitch.push(GlitchEntry { id: m.id, parts: m.parts, vscale: m.vscale, refreshed: frame }),
            }
        }
    }

}
