//! Poses: sampling a clip, blending, forward kinematics.
use crate::asset::{Clip, Skeleton};
use glam::{Quat, Vec3};

/// A pose in the clip's heading frame: `root` is the pelvis offset (see
/// [`crate::asset::Sample`]), `rot[0]` the pelvis rotation relative to the
/// heading, the rest parent-relative. `contact` is the feet's contact.
#[derive(Clone, Debug)]
pub struct Pose {
    pub root: Vec3,
    pub contact: [f32; 2],
    pub rot: Vec<Quat>,
}

impl Pose {
    pub fn rest(n: usize) -> Pose {
        Pose { root: Vec3::ZERO, contact: [1.0; 2], rot: vec![Quat::IDENTITY; n] }
    }
}

/// Keep `b` in `a`'s hemisphere so a blend takes the short way round.
fn near(a: Quat, b: Quat) -> Quat {
    if a.dot(b) < 0.0 {
        -b
    } else {
        b
    }
}

/// Normalized linear quaternion blend (the blends here are between close
/// poses, where nlerp and slerp differ by far less than a pixel).
pub fn nlerp(a: Quat, b: Quat, t: f32) -> Quat {
    let b = near(a, b);
    (a * (1.0 - t) + b * t).normalize()
}

/// Sample a clip at `u` in [0, 1) of its length (phase for a cycle, time /
/// duration for an idle loop), interpolating between neighbouring samples.
pub fn sample(clip: &Clip, u: f32) -> Pose {
    let n = clip.samples.len();
    let x = u.rem_euclid(1.0) * n as f32;
    let i0 = (x.floor() as usize).min(n - 1);
    let i1 = (i0 + 1) % n;
    let t = x - i0 as f32;
    let (a, b) = (&clip.samples[i0], &clip.samples[i1]);
    Pose {
        root: a.root.lerp(b.root, t),
        contact: [a.contact[0] + (b.contact[0] - a.contact[0]) * t, a.contact[1] + (b.contact[1] - a.contact[1]) * t],
        rot: a.rot.iter().zip(&b.rot).map(|(&qa, &qb)| nlerp(qa, qb, t)).collect(),
    }
}

/// Only the feet's contact at `u` (see [`sample`]) — cheap enough to scan a
/// cycle every tick.
pub fn sample_contact(clip: &Clip, u: f32) -> [f32; 2] {
    let n = clip.samples.len();
    let x = u.rem_euclid(1.0) * n as f32;
    let i0 = (x.floor() as usize).min(n - 1);
    let (a, b) = (&clip.samples[i0].contact, &clip.samples[(i0 + 1) % n].contact);
    let t = x - i0 as f32;
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

/// Blend `b` into `a` by `t` (0 = a).
pub fn blend(a: &Pose, b: &Pose, t: f32) -> Pose {
    if t <= 0.0 {
        return a.clone();
    }
    if t >= 1.0 {
        return b.clone();
    }
    Pose {
        root: a.root.lerp(b.root, t),
        contact: [a.contact[0] + (b.contact[0] - a.contact[0]) * t, a.contact[1] + (b.contact[1] - a.contact[1]) * t],
        rot: a.rot.iter().zip(&b.rot).map(|(&qa, &qb)| nlerp(qa, qb, t)).collect(),
    }
}

/// World-space bones: rotation and joint (head) position of every bone.
#[derive(Clone, Debug)]
pub struct Globals {
    pub rot: Vec<Quat>,
    pub head: Vec<Vec3>,
}

impl Globals {
    /// Forward kinematics from a world pelvis position/rotation and the
    /// pose's parent-relative rotations (`pose.rot[0]` is ignored).
    pub fn fk(skel: &Skeleton, pelvis: Vec3, pelvis_rot: Quat, rot: &[Quat]) -> Globals {
        let n = skel.bones.len();
        let mut g = Globals { rot: vec![Quat::IDENTITY; n], head: vec![Vec3::ZERO; n] };
        for (i, b) in skel.bones.iter().enumerate() {
            match b.parent {
                None => {
                    g.rot[i] = pelvis_rot;
                    g.head[i] = pelvis;
                }
                Some(p) => {
                    g.rot[i] = (g.rot[p] * rot[i]).normalize();
                    g.head[i] = g.head[p] + g.rot[p] * (b.head - skel.bones[p].head);
                }
            }
        }
        g
    }

    /// World end point of bone `i`.
    pub fn tail(&self, skel: &Skeleton, i: usize) -> Vec3 {
        let b = &skel.bones[i];
        self.head[i] + self.rot[i] * (b.tail - b.head)
    }

    /// World position of a point given in bone `i`'s rest frame relative to
    /// its joint.
    pub fn point(&self, i: usize, rest_offset: Vec3) -> Vec3 {
        self.head[i] + self.rot[i] * rest_offset
    }
}
