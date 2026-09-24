//! The locomotion controller: one fixed tick in, one world-space skeleton
//! out. Motion comes from the captured clips; code only decides WHICH clips,
//! at WHAT phase, and then keeps the result honest against the world:
//!
//! 1. **Phase from distance.** The gait phase advances by the distance the
//!    body actually covered this tick over the stride length for its speed,
//!    so a blocked or braking body cannot run in place.
//! 2. **Blend by speed.** idle ↔ walk ↔ brisk ↔ run (and the knees-bent
//!    walk when crouched) are sampled at the SAME phase — every cycle starts
//!    at a left heel strike — and blended by speed.
//! 3. **Stride warping.** The chosen stride rarely equals the blended clips'
//!    natural stride; the feet's fore-aft excursion is scaled by the ratio,
//!    which is what makes a planted foot's speed relative to the pelvis equal
//!    the body's speed.
//! 4. **Foot locking.** A foot whose clip contact says "planted" is pinned
//!    to the world where it landed until the clip lifts it; the leg is then
//!    solved by two-bone IK. That is the whole anti-sliding mechanism.
//! 5. **Stepping at rest.** Standing, a foot that ends up far from where the
//!    idle pose wants it (a stop mid-stride, a turn on the spot) takes a
//!    corrective step — one foot at a time.
//! 6. **Ground.** Feet follow the terrain (kerbs, potholes); the pelvis
//!    lowers when a leg could not otherwise reach its foot.
//! 7. **Weight.** The upper body leans into acceleration and turns through
//!    an underdamped spring, so it overshoots a little and settles.
use crate::asset::{parse_anim, Clip, Skeleton, ANIM_BYTES};
use crate::ik;
use crate::pose::{blend, sample, Globals, Pose};
use glam::{Quat, Vec2, Vec3};

/// Fixed tick length (the sim's 60 Hz).
pub const DT: f32 = 1.0 / 60.0;

/// How far the sim's body centre stops from a wall's surface (its collision
/// radius, `house_game::gym::sim::PLAYER_RADIUS`): where braced palms land.
pub const WALL_GAP: f32 = 0.26;

/// What the sim knows about the body this tick.
#[derive(Clone, Copy, Debug, Default)]
pub struct Input {
    /// Body centre on the ground plane (world x, z).
    pub position: Vec2,
    /// Sim velocity (x, z), wu/s.
    pub velocity: Vec2,
    /// The direction the player is pushing (unit or zero).
    pub intent: Vec2,
    /// Direction into a blocking surface, or zero.
    pub contact: Vec2,
    pub crouching: bool,
}

#[derive(Clone, Copy, Debug)]
struct Step {
    from: Vec3,
    from_rot: Quat,
    t: f32,
    /// Seconds for the whole step.
    time: f32,
}

#[derive(Clone, Copy, Debug)]
struct Foot {
    /// Pinned to the world (planted).
    locked: bool,
    /// Current ankle target and foot rotation (world).
    pos: Vec3,
    rot: Quat,
    /// Where the foot left its lock, and how far it has blended back onto
    /// the animated path (0..1).
    from: Vec3,
    from_rot: Quat,
    release: f32,
    /// Heading of a planted foot.
    yaw: f32,
    step: Option<Step>,
}

/// A critically/under-damped scalar spring.
#[derive(Clone, Copy, Debug, Default)]
struct Spring {
    x: f32,
    v: f32,
}

impl Spring {
    fn tick(&mut self, target: f32, omega: f32, zeta: f32) {
        let a = omega * omega * (target - self.x) - 2.0 * zeta * omega * self.v;
        self.v += a * DT;
        self.x += self.v * DT;
    }
}

fn smooth(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn wrap(a: f32) -> f32 {
    (a + std::f32::consts::PI).rem_euclid(std::f32::consts::TAU) - std::f32::consts::PI
}

/// Which clip plays what part.
#[derive(Clone, Copy, Debug)]
struct Clips {
    idle: usize,
    walk: usize,
    brisk: usize,
    run: usize,
    sneak: usize,
}

#[derive(Clone, Copy, Debug)]
struct Bones {
    spine: usize,
    chest: usize,
    neck: usize,
    head: usize,
    upperarm: [usize; 2],
    forearm: [usize; 2],
    hand: [usize; 2],
    /// Every arm bone, both sides (clavicle to hand).
    arm: [usize; 8],
    thigh: [usize; 2],
    shin: [usize; 2],
    foot: [usize; 2],
    toe: [usize; 2],
}

/// The body: persistent locomotion state + the last solved skeleton.
#[derive(Clone, Debug)]
pub struct Body {
    pub skel: Skeleton,
    clips: Vec<Clip>,
    which: Clips,
    b: Bones,
    /// Facing (radians about +Y; 0 faces +Z) and its rate.
    pub heading: f32,
    yaw_rate: f32,
    /// Gait cycle phase (0 = left heel strike).
    pub phase: f32,
    idle_t: f32,
    /// Smoothed actual speed and how much of the gait is blended in.
    pub speed: f32,
    pub moving: f32,
    last: Option<Vec2>,
    /// Crouch amount 0..1.
    pub crouch: f32,
    crouch_v: f32,
    pitch: Spring,
    roll: Spring,
    /// Leaning on a wall the body is pushed against (0..1).
    pub brace: f32,
    ground: Spring,
    drop: f32,
    feet: [Foot; 2],
    cool: u32,
    /// The solved skeleton (world space) after the last tick.
    pub pose: Globals,
    /// The ground under the body centre at the last tick (world y).
    pub ground_y: f32,
    /// Stride length used at the last tick (wu per full cycle).
    pub stride: f32,
    /// Cycles per second at the last moving tick.
    cadence: f32,
    /// The gait has come to rest after a stop (see `tick`).
    settled: bool,
    /// Re-plant steps forced by a turn or a reversal (a straight walk or
    /// run never needs one — pinned by a test).
    pub forced_steps: u32,
}

impl Body {
    pub fn new(position: Vec2, ground: impl Fn(Vec2) -> f32) -> Body {
        let (skel, clips) = parse_anim(ANIM_BYTES);
        let find = |n: &str| clips.iter().position(|c| c.name == n).unwrap_or_else(|| panic!("clip {n}"));
        let which = Clips { idle: find("idle"), walk: find("walk"), brisk: find("brisk"), run: find("run"), sneak: find("sneak") };
        let side = |n: &str| [skel.index(&format!("{n}L")), skel.index(&format!("{n}R"))];
        let b = Bones {
            spine: skel.index("spine"),
            chest: skel.index("chest"),
            neck: skel.index("neck"),
            head: skel.index("head"),
            upperarm: side("upperarm"),
            forearm: side("forearm"),
            hand: side("hand"),
            arm: {
                let [a, b, c, d] = [side("clav"), side("upperarm"), side("forearm"), side("hand")];
                [a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1]]
            },
            thigh: side("thigh"),
            shin: side("shin"),
            foot: side("foot"),
            toe: side("toe"),
        };
        let g0 = ground(position);
        let foot = Foot { locked: false, pos: Vec3::ZERO, rot: Quat::IDENTITY, from: Vec3::ZERO, from_rot: Quat::IDENTITY, release: 1.0, yaw: 0.0, step: None };
        let pose = Globals { rot: vec![Quat::IDENTITY; skel.bones.len()], head: skel.bones.iter().map(|b| b.head).collect() };
        let mut body = Body {
            skel,
            clips,
            which,
            b,
            heading: 0.0,
            yaw_rate: 0.0,
            phase: 0.0,
            idle_t: 0.0,
            speed: 0.0,
            moving: 0.0,
            last: None,
            crouch: 0.0,
            crouch_v: 0.0,
            pitch: Spring::default(),
            roll: Spring::default(),
            brace: 0.0,
            ground: Spring { x: g0, v: 0.0 },
            drop: 0.0,
            feet: [foot; 2],
            cool: 0,
            pose,
            ground_y: g0,
            stride: 1.0,
            cadence: 0.0,
            settled: true,
            forced_steps: 0,
        };
        // settle into the idle stance: both feet planted where it stands
        body.tick(&Input { position, ..Input::default() }, &ground);
        for f in &mut body.feet {
            f.step = None;
        }
        body
    }

    fn clip(&self, i: usize) -> &Clip {
        &self.clips[i]
    }

    /// The gait blend at `speed`: (clip, weight) pairs, weights summing to 1.
    fn gait_weights(&self, speed: f32) -> Vec<(usize, f32)> {
        let (w, br, r) = (self.clip(self.which.walk).speed(), self.clip(self.which.brisk).speed(), self.clip(self.which.run).speed());
        // the everyday walk carries the game's walking speed (1.6) with its
        // stride stretched; the brisk capture — a power walk, knees bent —
        // only takes over on the way to a run
        let w = w.max(1.75);
        let upright = if speed <= w {
            vec![(self.which.walk, 1.0)]
        } else if speed <= br {
            let t = (speed - w) / (br - w);
            vec![(self.which.walk, 1.0 - t), (self.which.brisk, t)]
        } else {
            // the walk→run switch sits where people make it (~2.2 m/s)
            let t = smooth((speed - br - 0.1) / (r - br - 0.2));
            vec![(self.which.brisk, 1.0 - t), (self.which.run, t)]
        };
        let c = smooth(self.crouch);
        let mut out: Vec<(usize, f32)> = upright.into_iter().map(|(i, x)| (i, x * (1.0 - c))).collect();
        out.push((self.which.sneak, c));
        out.retain(|&(_, x)| x > 1e-4);
        out
    }

    /// Stride length (wu per cycle) at `speed`: each clip's stride scaled by
    /// (speed / its natural speed)^0.6 — people lengthen AND quicken their
    /// steps as they speed up — and shortened at a shuffle.
    fn stride_at(&self, weights: &[(usize, f32)], speed: f32) -> (f32, f32) {
        let mut natural = 0.0;
        let mut chosen = 0.0;
        for &(i, w) in weights {
            let c = self.clip(i);
            let ratio = (speed / c.speed()).max(0.05);
            let scale = if ratio < 1.0 { ratio.sqrt().max(0.35) } else { ratio.powf(0.6) };
            natural += w * c.stride;
            chosen += w * c.stride * scale;
        }
        (chosen.max(0.1), natural.max(0.1))
    }

    fn contact_at(&self, weights: &[(usize, f32)], phase: f32) -> [f32; 2] {
        let mut c = [0.0; 2];
        for &(i, w) in weights {
            let p = sample(self.clip(i), phase);
            c[0] += w * p.contact[0];
            c[1] += w * p.contact[1];
        }
        c
    }

    fn sample_gait(&self, weights: &[(usize, f32)]) -> Pose {
        let mut acc: Option<Pose> = None;
        let mut total = 0.0;
        for &(i, w) in weights {
            let p = sample(self.clip(i), self.phase);
            total += w;
            acc = Some(match acc {
                None => p,
                Some(a) => blend(&a, &p, w / total),
            });
        }
        acc.unwrap_or_else(|| Pose::rest(self.skel.bones.len()))
    }

    /// Advance one fixed tick.
    pub fn tick(&mut self, inp: &Input, ground: &impl Fn(Vec2) -> f32) {
        let pos = inp.position;
        let dist = self.last.map_or(0.0, |l| (pos - l).length());
        self.last = Some(pos);
        let speed_now = dist / DT;
        let prev_speed = self.speed;
        self.speed += (speed_now - self.speed) * 0.5;
        let accel = (self.speed - prev_speed) / DT;

        // ---- facing: follows travel (or the push against a wall), turning
        // at a human rate instead of snapping
        let dir = if inp.velocity.length() > 0.05 {
            Some(inp.velocity)
        } else if inp.contact.length_squared() > 0.1 && inp.intent.length_squared() > 0.1 {
            Some(inp.intent)
        } else {
            None
        };
        let prev_heading = self.heading;
        if let Some(d) = dir {
            let target = d.x.atan2(d.y);
            let diff = wrap(target - self.heading);
            let rate = (diff * 12.0).clamp(-10.0, 10.0);
            self.heading = wrap(self.heading + rate * DT);
        }
        self.yaw_rate = wrap(self.heading - prev_heading) / DT;

        // ---- crouch (about a quarter second down or up)
        let want = if inp.crouching { 1.0 } else { 0.0 };
        let a = 180.0 * (want - self.crouch) - 2.0 * 13.4 * self.crouch_v;
        self.crouch_v += a * DT;
        self.crouch = (self.crouch + self.crouch_v * DT).clamp(0.0, 1.0);

        // ---- pushing against a wall: lean on it
        let pushing = inp.contact.length_squared() > 0.1 && inp.intent.length_squared() > 0.1 && inp.contact.dot(inp.intent) > 0.5;
        let want = if pushing && self.speed < 0.3 { 1.0 } else { 0.0 };
        self.brace += (want - self.brace) * if want > self.brace { 0.14 } else { 0.2 };

        // ---- gait
        let weights = self.gait_weights(self.speed.max(0.05));
        let (stride, natural) = self.stride_at(&weights, self.speed.max(0.05));
        self.stride = stride;
        let was_still = self.moving < 0.02;
        let target_moving = smooth(self.speed / 0.7);
        if dist > 0.0 {
            if was_still {
                self.phase = self.start_phase(inp.velocity.normalize_or_zero());
            }
            self.phase = (self.phase + dist / stride).rem_euclid(1.0);
            self.cadence = dist / stride / DT;
            self.settled = false;
        } else if self.moving > 0.05 && !self.settled {
            // the body stopped with a foot in the air: finish that step in
            // time — no hovering foot, no lunge — and settle once a foot lands
            let before = self.contact_at(&weights, self.phase);
            self.phase = (self.phase + self.cadence.max(0.8) * DT).rem_euclid(1.0);
            let after = self.contact_at(&weights, self.phase);
            let landed = (0..2).any(|s| before[s] < 0.5 && after[s] >= 0.5);
            if landed || (after[0] >= 0.5 && after[1] >= 0.5) {
                self.settled = true;
            }
        }
        if self.settled || dist > 0.0 {
            self.moving += (target_moving - self.moving) * if target_moving > self.moving { 0.3 } else { 0.12 };
        }
        self.idle_t += DT;
        let idle = sample(self.clip(self.which.idle), self.idle_t / self.clip(self.which.idle).duration);
        let mut gait = self.sample_gait(&weights);
        // the knees-bent capture holds its arms out for balance like wings;
        // a sneaking man keeps them in — crouched, the arms come from the
        // everyday walk at the same phase
        let c_arms = smooth(self.crouch);
        if c_arms > 0.0 {
            let walk = sample(self.clip(self.which.walk), self.phase);
            for &i in &self.b.arm {
                gait.rot[i] = crate::pose::nlerp(gait.rot[i], walk.rot[i], c_arms);
            }
        }
        let mut pose = blend(&idle, &gait, self.moving);
        // planted-or-not comes from the gait while walking and from the idle
        // stance at rest — never a blend of the two, which would keep both
        // feet "planted" through the first steps of a start
        let stance = self.moving < 0.3;
        pose.contact = if stance { [1.0; 2] } else { gait.contact };
        let warp = 1.0 + (stride / natural - 1.0) * self.moving;

        // ---- weight: lean into acceleration and turns (underdamped: a small
        // overshoot, then it settles)
        let lean_target = (accel * 0.012).clamp(-0.12, 0.16) + 0.05 * (self.speed / 4.0).min(1.0) + 0.1 * self.brace;
        self.pitch.tick(lean_target, 11.0, 0.42);
        let bank = (-self.speed * self.yaw_rate * 0.03).clamp(-0.18, 0.18);
        self.roll.tick(bank, 10.0, 0.5);
        let c = smooth(self.crouch);
        let (pitch, roll) = (self.pitch.x, self.roll.x);
        let rx = |a: f32| Quat::from_rotation_x(a);
        let b = self.b;
        pose.rot[b.spine] = rx(pitch * 0.55 + c * 0.32 * (1.0 - 0.6 * self.moving)) * Quat::from_rotation_z(roll * 0.6) * pose.rot[b.spine];
        pose.rot[b.chest] = rx(pitch * 0.3 + c * 0.1) * pose.rot[b.chest];
        pose.rot[b.neck] = rx(-pitch * 0.4 - c * 0.18) * pose.rot[b.neck];
        pose.rot[b.head] = rx(-pitch * 0.35 - c * 0.14) * Quat::from_rotation_z(-roll * 0.5) * pose.rot[b.head];
        for s in 0..2 {
            // crouched, the arms come forward a little, elbows bent
            pose.rot[b.upperarm[s]] = rx(-c * 0.3 * (1.0 - self.moving)) * pose.rot[b.upperarm[s]];
            pose.rot[b.forearm[s]] = rx(-c * 0.45 * (1.0 - self.moving)) * pose.rot[b.forearm[s]];
        }

        // ---- pelvis
        let g_here = ground(pos);
        self.ground_y = g_here;
        // the pelvis rides between its two supports: stepping up a kerb it
        // rises as the second foot follows, not the moment the centre crosses
        let under = |f: &Foot| ground(Vec2::new(f.pos.x, f.pos.z));
        let support = if self.feet.iter().all(|f| f.pos != Vec3::ZERO) { 0.5 * (under(&self.feet[0]) + under(&self.feet[1])) } else { g_here };
        self.ground.tick(0.5 * (support + g_here), 22.0, 1.0);
        let heading = Quat::from_rotation_y(self.heading);
        let crouch_drop = c * (0.26 - 0.08 * self.moving);
        let root = pose.root;
        let pelvis = Vec3::new(pos.x, self.ground.x + root.y - crouch_drop, pos.y) + heading * Vec3::new(root.x, 0.0, root.z * warp);
        let pelvis_rot = heading * Quat::from_rotation_z(roll * 0.4) * pose.rot[0];
        let mut g = Globals::fk(&self.skel, pelvis, pelvis_rot, &pose.rot);

        // ---- feet
        let centre = Vec3::new(pelvis.x, 0.0, pelvis.z);
        let mut wanted = [(Vec3::ZERO, Quat::IDENTITY); 2];
        for (s, want) in wanted.iter_mut().enumerate() {
            let f = b.foot[s];
            let mut local = heading.inverse() * (g.head[f] - centre);
            local.z *= warp;
            // a wider base when crouched and standing
            local.x += if s == 0 { 1.0 } else { -1.0 } * 0.05 * c * (1.0 - self.moving);
            let mut p = centre + heading * local;
            let rot = g.rot[f];
            let gf = ground(Vec2::new(p.x, p.z));
            p.y += gf - self.ground.x;
            p.y = p.y.max(self.sole_floor(p, rot, ground));
            *want = (p, rot);
        }
        if self.cool > 0 {
            self.cool -= 1;
        }
        // how far each planted foot has been left behind (or aside) by the
        // hip that must carry it — past `overreach` the leg is a lunge
        let spread = |s: usize, foot: Vec3| {
            let hip = g.head[b.thigh[s]];
            Vec2::new(hip.x - foot.x, hip.z - foot.z).length()
        };
        let spreads = [spread(0, self.feet[0].pos), spread(1, self.feet[1].pos)];
        let overreach = 0.6 + 0.2 * c;
        // a foot the clip lifts within a tenth of a cycle anyway is left alone
        let lifting_soon = self.contact_at(&weights, self.phase + 0.1);
        for s in 0..2 {
            let (anim, anim_rot) = wanted[s];
            let contact = pose.contact[s];
            let floor = self.sole_floor(anim, anim_rot, ground);
            let foot = &mut self.feet[s];
            if let Some(mut st) = foot.step {
                if !stance && contact < 0.5 {
                    // the gait took over mid-step: hand the foot to its swing
                    foot.step = None;
                    foot.from = foot.pos;
                    foot.from_rot = foot.rot;
                    foot.release = 0.0;
                } else {
                    // a corrective step: lift, carry, set down where the pose wants it
                    st.t = (st.t + DT / st.time).min(1.0);
                    let t = smooth(st.t);
                    let mut p = st.from.lerp(anim, t);
                    p.y = st.from.y + (floor.max(anim.y) - st.from.y) * t + (std::f32::consts::PI * st.t).sin() * 0.075;
                    foot.pos = p;
                    foot.rot = st.from_rot.slerp(anim_rot, t);
                    if st.t >= 1.0 {
                        foot.step = None;
                        foot.locked = true;
                        foot.yaw = yaw_of(anim_rot);
                        self.cool = 3;
                    } else {
                        foot.step = Some(st);
                    }
                    continue;
                }
            }
            if contact >= 0.5 {
                if !foot.locked {
                    let at = if foot.release < 1.0 { foot.pos } else { anim };
                    if at.y - floor > 0.03 {
                        // landing from higher than a heel strike (a stop with a
                        // foot in the air): finish the step instead of snapping
                        foot.step = Some(Step { from: foot.pos, from_rot: foot.rot, t: 0.0, time: 0.3 });
                        continue;
                    }
                    foot.locked = true;
                    foot.pos = at;
                    foot.yaw = yaw_of(anim_rot);
                }
                // planted: the clip's heel-toe roll, the foot's own heading
                // (a planted foot swivels only as far as an ankle allows), and
                // the lowest sole point resting on the ground
                let dev = wrap(foot.yaw - yaw_of(anim_rot)).clamp(-0.6, 0.6);
                foot.yaw = yaw_of(anim_rot) + dev;
                foot.rot = (Quat::from_rotation_y(dev) * anim_rot).normalize();
                let rot = foot.rot;
                foot.pos.y = sole_floor(&self.skel, foot.pos, rot, ground);
                let foot = &mut self.feet[s];
                let drift = Vec2::new(foot.pos.x - anim.x, foot.pos.z - anim.z).length();
                if !stance && lifting_soon[s] >= 0.5 && (drift > 0.3 || spreads[s] > overreach) {
                    // a sharp turn or a reversal left the planted foot where
                    // the leg can no longer carry the body: a quick step
                    // re-plants it where the gait wants it, instead of the
                    // pelvis sinking into a lunge to keep it
                    foot.locked = false;
                    foot.step = Some(Step { from: foot.pos, from_rot: foot.rot, t: 0.0, time: 0.2 });
                    self.forced_steps += 1;
                }
            } else {
                if foot.locked {
                    foot.locked = false;
                    foot.from = foot.pos;
                    foot.from_rot = foot.rot;
                    foot.release = 0.0;
                }
                foot.release = (foot.release + DT / 0.12).min(1.0);
                let t = smooth(foot.release);
                foot.pos = foot.from.lerp(anim, t);
                foot.pos.y = foot.pos.y.max(floor);
                foot.rot = foot.from_rot.slerp(anim_rot, t);
            }
        }
        if stance && self.cool == 0 && self.feet.iter().all(|f| f.step.is_none()) {
            // the foot farthest from where the idle stance wants it steps first
            let err = |s: usize| {
                let f = &self.feet[s];
                let (p, r) = wanted[s];
                let d = Vec2::new(f.pos.x - p.x, f.pos.z - p.z).length();
                let yaw = wrap(yaw_of(f.rot) - yaw_of(r)).abs();
                (d, yaw)
            };
            let (e0, e1) = (err(0), err(1));
            let s = if e0.0 + e0.1 * 0.2 >= e1.0 + e1.1 * 0.2 { 0 } else { 1 };
            let (d, yaw) = if s == 0 { e0 } else { e1 };
            if d > 0.11 || yaw > 0.55 {
                let f = &mut self.feet[s];
                // a long way to go (a sprint stop) is a quicker, bigger step
                let time = if d > 0.35 { 0.22 } else { 0.3 };
                f.step = Some(Step { from: f.pos, from_rot: f.rot, t: 0.0, time });
                f.locked = false;
            }
        }

        // whatever moved a foot this tick, its sole ends on or above the ground
        for f in &mut self.feet {
            f.pos.y = f.pos.y.max(sole_floor(&self.skel, f.pos, f.rot, ground));
        }

        // ---- pelvis drop so both feet stay reachable
        let mut need: f32 = 0.0;
        for s in 0..2 {
            let hip = g.head[b.thigh[s]];
            let reach = (self.skel.len(b.thigh[s]) + self.skel.len(b.shin[s])) * 0.985;
            let t = self.feet[s].pos;
            let h2 = Vec2::new(hip.x - t.x, hip.z - t.z).length_squared();
            let v = hip.y - t.y;
            let fit = (reach * reach - h2).max(0.0).sqrt();
            need = need.max(v - fit);
        }
        // capped: past this a foot steps (above) rather than the body sinking
        let need = need.min(0.28);
        self.drop = if need > self.drop { need } else { self.drop + (need - self.drop) * 0.15 };
        if self.drop > 0.0 {
            for h in &mut g.head {
                h.y -= self.drop;
            }
        }

        // ---- legs
        let forward = heading * Vec3::Z;
        let locals = pose.rot.clone();
        for s in 0..2 {
            let (thigh, shin, foot, toe) = (b.thigh[s], b.shin[s], b.foot[s], b.toe[s]);
            ik::two_bone(&mut g, &self.skel, thigh, shin, self.feet[s].pos, forward * 0.08);
            g.head[foot] = g.tail(&self.skel, shin);
            g.rot[foot] = self.feet[s].rot;
            g.rot[toe] = (g.rot[foot] * locals[toe]).normalize();
            g.head[toe] = g.head[foot] + g.rot[foot] * (self.skel.bones[toe].head - self.skel.bones[foot].head);
        }
        // ---- arms: palms on the wall the body is pushing against. The body
        // centre stops WALL_GAP short of the wall's surface.
        let e = smooth(self.brace);
        if e > 0.0 {
            for s in 0..2 {
                let (upper, fore, hand) = (b.upperarm[s], b.forearm[s], b.hand[s]);
                let side = if s == 0 { 1.0 } else { -1.0 };
                let wall = Vec3::new(pos.x, self.ground.x, pos.y) + heading * Vec3::new(side * 0.2, 1.28 - 0.35 * c, WALL_GAP - 0.03);
                let anim = g.tail(&self.skel, fore);
                let target = anim.lerp(wall, e);
                ik::two_bone(&mut g, &self.skel, upper, fore, target, Vec3::new(0.0, -0.1, 0.0) + heading * Vec3::new(side * 0.2, 0.0, -0.1));
                g.head[hand] = g.tail(&self.skel, fore);
                // fingers up, palm to the wall
                let flat = heading * Quat::from_rotation_z(std::f32::consts::PI) * Quat::from_rotation_x(-0.25);
                g.rot[hand] = g.rot[hand].slerp(flat, e);
            }
        }
        self.pose = g;
    }

    fn sole_floor(&self, ankle: Vec3, rot: Quat, ground: &impl Fn(Vec2) -> f32) -> f32 {
        sole_floor(&self.skel, ankle, rot, ground)
    }

    /// Starting from a standstill: the feet stand side by side, which is
    /// the gait's MID-STANCE (one foot under the body, the other passing it),
    /// not a heel strike. The foot further behind along the new direction
    /// swings first: phase 0.2 swings the right foot over a planted left,
    /// 0.7 the mirror.
    fn start_phase(&self, dir: Vec2) -> f32 {
        let along = |s: usize| Vec2::new(self.feet[s].pos.x, self.feet[s].pos.z).dot(dir);
        if along(1) <= along(0) {
            0.2
        } else {
            0.7
        }
    }

    /// Planted feet (for tests and debug overlays).
    pub fn planted(&self) -> [bool; 2] {
        [self.feet[0].locked, self.feet[1].locked]
    }

    /// Ankle targets (world).
    pub fn feet(&self) -> [Vec3; 2] {
        [self.feet[0].pos, self.feet[1].pos]
    }

    /// World heel and ball points of both feet in the solved pose.
    pub fn soles(&self) -> [[Vec3; 2]; 2] {
        let f = |s: usize| {
            let i = self.b.foot[s];
            [self.pose.point(i, self.skel.heel), self.pose.point(i, self.skel.ball)]
        };
        [f(0), f(1)]
    }
}

/// The lowest ankle height at which the foot's heel and ball both stay on
/// or above the ground.
fn sole_floor(skel: &Skeleton, ankle: Vec3, rot: Quat, ground: &impl Fn(Vec2) -> f32) -> f32 {
    let at = |o: Vec3| ground(Vec2::new(ankle.x + o.x, ankle.z + o.z)) - o.y;
    at(rot * skel.heel).max(at(rot * skel.ball))
}

fn yaw_of(q: Quat) -> f32 {
    let f = q * Vec3::Z;
    f.x.atan2(f.z)
}

/// A stand-in for the sim's mover (accelerate 18, brake 34 wu/s²) so the
/// controller can be exercised headless: `script(tick)` gives the wanted
/// velocity and crouch.
#[doc(hidden)]
pub fn drive(body: &mut Body, pos: &mut Vec2, vel: &mut Vec2, ticks: std::ops::Range<u32>, script: impl Fn(u32) -> (Vec2, bool), ground: &impl Fn(Vec2) -> f32, mut each: impl FnMut(u32, &Body)) {
    for t in ticks {
        let (want, crouching) = script(t);
        let limit = if want.length_squared() > 0.0 { 18.0 } else { 34.0 } * DT;
        let change = want - *vel;
        *vel = if change.length() <= limit { want } else { *vel + change.normalize() * limit };
        *pos += *vel * DT;
        body.tick(&Input { position: *pos, velocity: *vel, intent: want.normalize_or_zero(), contact: Vec2::ZERO, crouching }, ground);
        each(t, body);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat(_: Vec2) -> f32 {
        0.0
    }

    #[test]
    fn a_planted_foot_does_not_move_while_walking_running_or_turning() {
        for speed in [0.6, 1.6, 2.6, 4.2] {
            let mut pos = Vec2::ZERO;
            let mut vel = Vec2::ZERO;
            let mut body = Body::new(pos, flat);
            let mut last: [Option<Vec3>; 2] = [None, None];
            let mut worst: f32 = 0.0;
            drive(&mut body, &mut pos, &mut vel, 0..360, |t| {
                let a = if t > 180 { (t - 180) as f32 * 0.01 } else { 0.0 };
                (Vec2::new(a.sin(), a.cos()) * speed, false)
            }, &flat, |_, b| {
                for (s, last) in last.iter_mut().enumerate() {
                    let p = b.feet()[s];
                    if b.planted()[s] {
                        if let Some(q) = *last {
                            worst = worst.max(Vec2::new(p.x - q.x, p.z - q.z).length());
                        }
                        *last = Some(p);
                    } else {
                        *last = None;
                    }
                }
            });
            assert!(worst < 1e-5, "a planted foot slid {worst} wu per tick at {speed} wu/s");
            assert_eq!(body.forced_steps, 0, "a straight path or a gentle curve must never force a re-plant step at {speed} wu/s");
        }
    }

    #[test]
    fn the_legs_reach_their_feet_and_the_soles_stay_on_or_above_uneven_ground() {
        // a kerb across the path, a pothole after it
        let ground = |p: Vec2| {
            if (2.0..2.4).contains(&p.x) && p.y.abs() < 0.5 {
                -0.08
            } else if p.x > 0.0 {
                0.14
            } else {
                0.0
            }
        };
        let mut pos = Vec2::new(-2.0, 0.0);
        let mut vel = Vec2::ZERO;
        let mut body = Body::new(pos, ground);
        let b = body.b;
        drive(&mut body, &mut pos, &mut vel, 0..420, |t| (if t < 300 { Vec2::X * 1.6 } else { Vec2::ZERO }, (200..260).contains(&t)), &ground, |t, body| {
            for s in 0..2 {
                let ankle = body.pose.head[b.foot[s]];
                let reach = ankle.distance(body.feet()[s]);
                assert!(reach < 0.02, "leg {s} misses its foot by {reach} at tick {t}");
                for p in body.soles()[s] {
                    let g = ground(Vec2::new(p.x, p.z));
                    assert!(p.y > g - 0.012, "sole below ground at tick {t}: {} < {g}", p.y);
                }
                for (i, j) in [(b.thigh[s], b.shin[s]), (b.shin[s], b.foot[s])] {
                    let len = body.pose.head[i].distance(body.pose.head[j]);
                    assert!((len - body.skel.len(i)).abs() < 1e-3, "bone {i} stretched to {len}");
                }
            }
        });
    }

    #[test]
    fn a_stop_mid_stride_settles_into_a_planted_stance() {
        for stop in [150u32, 163, 171, 180] {
            let mut pos = Vec2::ZERO;
            let mut vel = Vec2::ZERO;
            let mut body = Body::new(pos, flat);
            drive(&mut body, &mut pos, &mut vel, 0..stop + 120, |t| (if t < stop { Vec2::Y * 1.6 } else { Vec2::ZERO }, false), &flat, |_, _| {});
            assert_eq!(body.planted(), [true, true], "both feet planted after a stop at {stop}");
            let [l, r] = body.feet();
            let gap = Vec2::new(l.x - r.x, l.z - r.z).length();
            assert!((0.12..0.45).contains(&gap), "stance width {gap} after a stop at {stop}");
            assert!(body.moving < 0.01);
        }
    }

    #[test]
    fn the_same_inputs_give_the_same_body_bit_for_bit() {
        let run = || {
            let mut pos = Vec2::ZERO;
            let mut vel = Vec2::ZERO;
            let mut body = Body::new(pos, flat);
            drive(&mut body, &mut pos, &mut vel, 0..300, |t| (Vec2::new((t as f32 * 0.02).sin(), 1.0) * if t % 100 < 70 { 4.2 } else { 0.0 }, t > 200), &flat, |_, _| {});
            body.pose.head.iter().chain(&body.feet()).flat_map(|v| v.to_array()).map(f32::to_bits).collect::<Vec<_>>()
        };
        assert_eq!(run(), run());
    }

    #[test]
    fn walking_into_a_wall_settles_instead_of_stepping_in_place() {
        let flat = |_: Vec2| 0.0;
        let mut pos = Vec2::ZERO;
        let mut vel = Vec2::ZERO;
        let mut body = Body::new(pos, flat);
        let mut steps = 0;
        for t in 0..300u32 {
            let want = if (20..260).contains(&t) { Vec2::Y * 1.6 } else { Vec2::ZERO };
            let limit = if want.length_squared() > 0.0 { 18.0 } else { 34.0 } * DT;
            let change = want - vel;
            vel = if change.length() <= limit { want } else { vel + change.normalize() * limit };
            let mut next = pos + vel * DT;
            let mut contact = Vec2::ZERO;
            if next.y > 1.0 - WALL_GAP {
                next.y = 1.0 - WALL_GAP;
                vel.y = 0.0;
                contact = Vec2::Y;
            }
            pos = next;
            let before = body.feet();
            body.tick(&Input { position: pos, velocity: vel, intent: want.normalize_or_zero(), contact, crouching: false }, &flat);
            let moved = (0..2).any(|s| Vec2::new(body.feet()[s].x - before[s].x, body.feet()[s].z - before[s].z).length() > 1e-4);
            if t > 120 && moved {
                steps += 1;
            }
        }
        assert_eq!(steps, 0, "a body held against a wall must stand still, not shuffle");
    }

    #[test]
    fn pushing_into_a_wall_puts_both_palms_on_it_and_letting_go_takes_them_off() {
        let flat = |_: Vec2| 0.0;
        let mut body = Body::new(Vec2::ZERO, flat);
        let push = Input { position: Vec2::ZERO, velocity: Vec2::ZERO, intent: Vec2::Y, contact: Vec2::Y, crouching: false };
        for _ in 0..60 {
            body.tick(&push, &flat);
        }
        assert!(body.brace > 0.99);
        for s in 0..2 {
            let palm = body.pose.head[body.b.hand[s]];
            assert!((palm.z - (WALL_GAP - 0.03)).abs() < 0.03, "palm {s} off the wall: z = {}", palm.z);
            assert!(palm.y > 1.0, "palm {s} at shoulder height, not {}", palm.y);
        }
        for _ in 0..40 {
            body.tick(&Input { position: Vec2::ZERO, ..Input::default() }, &flat);
        }
        assert!(body.brace < 0.01);
    }

    #[test]
    fn crouching_lowers_the_body_and_standing_restores_it() {
        let mut pos = Vec2::ZERO;
        let mut vel = Vec2::ZERO;
        let mut body = Body::new(pos, flat);
        let head = |b: &Body| b.pose.head[b.b.head].y;
        drive(&mut body, &mut pos, &mut vel, 0..60, |_| (Vec2::ZERO, false), &flat, |_, _| {});
        let standing = head(&body);
        let mut prev = standing;
        drive(&mut body, &mut pos, &mut vel, 60..120, |_| (Vec2::ZERO, true), &flat, |t, b| {
            assert!((head(b) - prev).abs() < 0.04, "the crouch must not pop (tick {t})");
            prev = head(b);
        });
        assert!(standing - head(&body) > 0.25, "crouched head only {} lower", standing - head(&body));
        drive(&mut body, &mut pos, &mut vel, 120..200, |_| (Vec2::ZERO, false), &flat, |_, _| {});
        assert!((head(&body) - standing).abs() < 0.03);
    }
}
