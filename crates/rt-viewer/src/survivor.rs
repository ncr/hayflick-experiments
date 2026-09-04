//! An older survivor: proportioned faceted anatomy and a fixed-tick, jointed
//! rig. Feet stay planted during stance; two-bone IK supplies knees/elbows.
use crate::concrete::Mesh;
use glam::{Mat4, Quat, Vec2, Vec3};
use rt_probe::{InstanceKey, Scene, SceneHandles};
const COAT: [f32; 4] = [0.105, 0.119, 0.098, 1.0];
const TROUSER: [f32; 4] = [0.081, 0.070, 0.051, 1.0];
const SKIN: [f32; 4] = [0.36, 0.245, 0.172, 1.0];
const HAIR: [f32; 4] = [0.42, 0.42, 0.39, 1.0];
const BOOT: [f32; 4] = [0.035, 0.029, 0.023, 1.0];
fn material(s: &mut Scene, c: [f32; 4]) -> i32 {
    let i = s.materials.len() as i32;
    s.materials.push(rt_probe::scene::Material {
        base_color: c,
        emissive: [0.0; 4],
        roughness: 0.9,
        metallic: 0.0,
        tex_index: -1,
        _pad: crate::flags::AA,
    });
    i
}
fn rings(s: &mut Scene, rows: &[(f32, f32, f32, f32)], c: [f32; 4]) {
    let m = material(s, c);
    let mut mesh = Mesh::default();
    let n = 10;
    for rows in rows.windows(2) {
        for k in 0..n {
            let p = |r: (f32, f32, f32, f32), k: usize| {
                let a = k as f32 * std::f32::consts::TAU / n as f32;
                Vec3::new(r.1 * a.cos(), r.0, r.2 * a.sin() + r.3)
            };
            let [a, b, c, d] = [
                p(rows[0], k),
                p(rows[0], k + 1),
                p(rows[1], k),
                p(rows[1], k + 1),
            ];
            mesh.tri(a, b, c, [0.0; 3]);
            mesh.tri(b, d, c, [0.0; 3]);
        }
    }
    mesh.emit(s, m);
}
fn ellipsoid(s: &mut Scene, c: Vec3, r: Vec3, col: [f32; 4]) {
    let start = s.vertices.len();
    let rows: Vec<_> = (0..=7)
        .map(|j| {
            let a = j as f32 / 7.0 * std::f32::consts::PI;
            (-a.cos() * r.y, a.sin() * r.x, a.sin() * r.z, 0.0)
        })
        .collect();
    rings(s, &rows, col);
    for v in &mut s.vertices[start..] {
        v.pos = (Vec3::from(v.pos) + c).to_array();
    }
}
fn run(s: &mut Scene, name: &str, f: impl FnOnce(&mut Scene)) {
    let start = s.primitives.len();
    f(s);
    s.register_dynamic(
        name,
        start,
        s.primitives.len() - start,
        Mat4::from_scale(Vec3::ZERO),
    );
}
pub fn build(s: &mut Scene) {
    run(s, "player", |s| {
        rings(
            s,
            &[
                (-0.08, 0.13, 0.10, 0.0),
                (0.0, 0.155, 0.12, 0.0),
                (0.14, 0.145, 0.11, 0.0),
            ],
            TROUSER,
        );
    });
    run(s, "player/chest", |s| {
        rings(
            s,
            &[
                (-0.02, 0.17, 0.115, 0.0),
                (0.08, 0.175, 0.12, 0.0),
                (0.29, 0.205, 0.13, -0.015),
                (0.40, 0.19, 0.11, -0.02),
                (0.43, 0.09, 0.08, 0.0),
            ],
            COAT,
        );
        // Collar, shirt opening and pockets are physical cloth layers.
        ellipsoid(
            s,
            Vec3::new(0.0, 0.445, 0.01),
            Vec3::new(0.067, 0.08, 0.062),
            SKIN,
        );
        for x in [-0.10, 0.10] {
            s.add_box_world(
                Vec3::new(x - 0.045, 0.19, 0.116),
                Vec3::new(x + 0.045, 0.26, 0.133),
                [0.09, 0.101, 0.079, 1.0],
                [0.0; 4],
                0.97,
                0.0,
            );
        }
        s.add_box_world(
            Vec3::new(-0.011, 0.03, 0.121),
            Vec3::new(0.011, 0.39, 0.136),
            [0.047, 0.045, 0.034, 1.0],
            [0.0; 4],
            0.95,
            0.0,
        );
    });
    run(s, "player/head", |s| {
        rings(
            s,
            &[
                (-0.12, 0.050, 0.062, 0.027),
                (-0.08, 0.081, 0.080, 0.015),
                (0.015, 0.093, 0.083, 0.0),
                (0.09, 0.087, 0.082, -0.010),
                (0.14, 0.065, 0.055, -0.015),
                (0.155, 0.005, 0.005, -0.015),
            ],
            SKIN,
        );
        for x in [-0.091, 0.091] {
            ellipsoid(
                s,
                Vec3::new(x, -0.005, 0.0),
                Vec3::new(0.023, 0.043, 0.026),
                SKIN,
            );
            ellipsoid(
                s,
                Vec3::new(x * 0.87, 0.05, -0.037),
                Vec3::new(0.025, 0.065, 0.061),
                HAIR,
            );
        }
        ellipsoid(
            s,
            Vec3::new(0.0, 0.015, 0.089),
            Vec3::new(0.025, 0.045, 0.037),
            SKIN,
        );
        // Receding crown, heavy grey brows and a short grey beard, not a hood.
        ellipsoid(
            s,
            Vec3::new(0.0, 0.078, -0.065),
            Vec3::new(0.077, 0.063, 0.040),
            HAIR,
        );
        ellipsoid(
            s,
            Vec3::new(0.0, -0.081, 0.053),
            Vec3::new(0.065, 0.039, 0.041),
            [0.35, 0.35, 0.315, 1.0],
        );
        for x in [-0.039, 0.039] {
            ellipsoid(
                s,
                Vec3::new(x, 0.038, 0.076),
                Vec3::new(0.029, 0.009, 0.012),
                HAIR,
            );
            ellipsoid(
                s,
                Vec3::new(x, 0.017, 0.081),
                Vec3::new(0.014, 0.008, 0.008),
                [0.039, 0.032, 0.025, 1.0],
            );
        }
    });
    for side in ["L", "R"] {
        for (part, r0, r1, col) in [
            ("leg", 0.089, 0.064, TROUSER),
            ("shin", 0.065, 0.044, TROUSER),
            ("arm", 0.071, 0.052, COAT),
            ("fore", 0.054, 0.034, COAT),
        ] {
            run(s, &format!("player/{part}{side}"), |s| {
                rings(
                    s,
                    &[
                        (0.025, r0 * 0.8, r0 * 0.8, 0.0),
                        (0.0, r0, r0, 0.0),
                        (-0.4, (r0 + r1) * 0.5, (r0 + r1) * 0.5, 0.0),
                        (-0.98, r1, r1, 0.0),
                        (-1.02, r1 * 0.7, r1 * 0.7, 0.0),
                    ],
                    col,
                )
            });
        }
        run(s, &format!("player/foot{side}"), |s| {
            ellipsoid(
                s,
                Vec3::new(0.0, 0.015, 0.060),
                Vec3::new(0.057, 0.065, 0.139),
                BOOT,
            );
        });
        run(s, &format!("player/hand{side}"), |s| {
            ellipsoid(
                s,
                Vec3::new(0.0, -0.055, 0.0),
                Vec3::new(0.033, 0.05, 0.021),
                SKIN,
            );
        });
    }
}
/// Joint between links of length a,b with a pole vector giving bend direction.
pub fn joint(root: Vec3, end: Vec3, pole: Vec3, a: f32, b: f32) -> Vec3 {
    let delta = end - root;
    let dist = delta.length().clamp(0.025, a + b - 0.002);
    let axis = delta.normalize_or_zero();
    let along = (a * a - b * b + dist * dist) / (2.0 * dist);
    let perpendicular = (pole - axis * pole.dot(axis)).normalize_or_zero();
    root + axis * along + perpendicular * (a * a - along * along).max(0.0).sqrt()
}
fn bone(a: Vec3, b: Vec3) -> Mat4 {
    let delta = b - a;
    Mat4::from_scale_rotation_translation(
        Vec3::new(1.0, delta.length().max(0.001), 1.0),
        Quat::from_rotation_arc(-Vec3::Y, delta.normalize_or_zero()),
        a,
    )
}
#[derive(Clone)]
pub struct Rig {
    pub heading: f32,
    phase: f32,
    blend: f32,
    pub brace: f32,
    feet: [Vec3; 2],
    from: [Vec3; 2],
    stance: [bool; 2],
    last: Vec3,
    pub speed: f32,
    time: f32,
    lean: f32,
}
impl Rig {
    pub fn new(p: Vec3) -> Self {
        let feet = [
            p + Vec3::new(-0.11, 0.05, 0.0),
            p + Vec3::new(0.11, 0.05, 0.0),
        ];
        Self {
            heading: 0.0,
            phase: 0.0,
            blend: 0.0,
            brace: 0.0,
            feet,
            from: feet,
            stance: [true; 2],
            last: p,
            speed: 0.0,
            time: 0.0,
            lean: 0.0,
        }
    }
    pub fn update(&mut self, p: Vec3, velocity: Vec2, intent: Vec2, contact: Vec2) {
        let distance = Vec2::new(p.x - self.last.x, p.z - self.last.z).length();
        self.last = p;
        let acceleration = (velocity.length() - self.speed) * 60.0;
        self.lean += ((acceleration * 0.004).clamp(-0.10, 0.10) - self.lean) * 0.2;
        self.time += house_game::TICK_DT;
        self.speed = velocity.length();
        let direction = if contact.length_squared() > 0.1 {
            intent
        } else {
            velocity
        };
        if direction.length_squared() > 0.001 {
            let desired = direction.x.atan2(direction.y);
            let delta = (desired - self.heading + std::f32::consts::PI)
                .rem_euclid(std::f32::consts::TAU)
                - std::f32::consts::PI;
            self.heading += delta.clamp(-0.13, 0.13);
        }
        let moving = distance > 0.0001;
        self.blend += (if moving { 1.0 } else { 0.0 } - self.blend) * 0.19;
        self.brace += (if contact.length_squared() > 0.1 && intent.length_squared() > 0.1 {
            1.0
        } else {
            0.0
        } - self.brace)
            * 0.18;
        let jog = ((self.speed - 1.65) / 1.55).clamp(0.0, 1.0);
        let duty = 0.62 - 0.10 * jog;
        self.phase += distance / (1.15 + 0.37 * jog);
        let rot = Quat::from_rotation_y(self.heading);
        for i in 0..2 {
            let phase = (self.phase + i as f32 * 0.5).fract();
            let stance = phase < duty;
            let lateral = if i == 0 { -0.11 } else { 0.11 };
            let home = p + rot * Vec3::new(lateral, 0.05, 0.0);
            if self.blend < 0.15 {
                self.feet[i] = self.feet[i].lerp(home, 0.16);
                self.stance[i] = true;
                continue;
            }
            if !stance {
                if self.stance[i] {
                    self.from[i] = self.feet[i];
                }
                let t = ((phase - duty) / (1.0 - duty)).clamp(0.0, 1.0);
                let smooth = t * t * (3.0 - 2.0 * t);
                let target = home + rot * Vec3::Z * (0.35 + 0.05 * jog);
                self.feet[i] = self.from[i].lerp(target, smooth)
                    + Vec3::Y * (std::f32::consts::PI * t).sin() * (0.13 + 0.08 * jog);
            }
            // Release an overextended planted foot during sharp turns, without ever
            // dragging the whole skeleton through the collision surface.
            if (self.feet[i] - home).length() > 0.48 {
                self.feet[i] = home + (self.feet[i] - home).normalize() * 0.48;
            }
            self.stance[i] = stance;
        }
    }
    pub fn instances(&self, p: Vec3, handles: &SceneHandles) -> Vec<(InstanceKey, Mat4)> {
        let mut out = Vec::new();
        let mut push = |n: &str, m: Mat4| {
            if let Some(k) = handles.instances.get(n) {
                out.push((*k, m));
            }
        };
        let rot = Quat::from_rotation_y(self.heading);
        let world = |v: Vec3| p + rot * v;
        let bob = (self.phase * std::f32::consts::TAU * 2.0).cos() * 0.013 * self.blend;
        let pelvis = world(Vec3::new(0.0, 0.83 + bob, -0.025 * self.brace));
        let base = Mat4::from_rotation_translation(rot, pelvis);
        push("player", base);
        let chest = base
            * Mat4::from_translation(Vec3::new(0.0, 0.13 + 0.003 * (self.time * 1.65).sin(), 0.0))
            * Mat4::from_rotation_x(0.085 + self.lean - 0.13 * self.brace);
        push("player/chest", chest);
        push(
            "player/head",
            chest
                * Mat4::from_translation(Vec3::new(0.0, 0.57, 0.015))
                * Mat4::from_rotation_x(-0.10),
        );
        for (i, side) in ["L", "R"].iter().enumerate() {
            let side_x = if i == 0 { -1.0 } else { 1.0 };
            let hip = pelvis + rot * Vec3::new(side_x * 0.10, 0.0, 0.0);
            let foot = self.feet[i];
            let knee = joint(hip, foot, rot * Vec3::Z, 0.41, 0.41);
            push(&format!("player/leg{side}"), bone(hip, knee));
            push(&format!("player/shin{side}"), bone(knee, foot));
            push(
                &format!("player/foot{side}"),
                Mat4::from_rotation_translation(rot, foot),
            );
            let shoulder = chest.transform_point3(Vec3::new(side_x * 0.21, 0.36, -0.015));
            let swing = (self.phase * std::f32::consts::TAU + i as f32 * std::f32::consts::PI)
                .sin()
                * self.blend;
            let rest = world(Vec3::new(side_x * 0.245, 0.83, -0.015 + swing * 0.13));
            let brace = world(Vec3::new(side_x * 0.19, 1.26, 0.14));
            let hand = rest.lerp(brace, self.brace);
            let elbow = joint(
                shoulder,
                hand,
                rot * Vec3::new(side_x * 0.25, 0.0, -1.0),
                0.28,
                0.26,
            );
            push(&format!("player/arm{side}"), bone(shoulder, elbow));
            push(&format!("player/fore{side}"), bone(elbow, hand));
            push(
                &format!("player/hand{side}"),
                Mat4::from_rotation_translation(rot, hand),
            );
        }
        out
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn articulated_shading_uses_instance_space_transforms_on_both_backends() {
        // A stretched, rotated joint needs inverse-transpose normals and
        // world-space contour distances, not its bind-pose vertex data.
        let metal=include_str!("shaders_metal/shade.metal");
        let glsl=include_str!("../../rt-probe/src/shaders/shade.comp");
        assert!(metal.contains("it.world_to_object_transform"));
        assert!(metal.contains("it.object_to_world_transform"));
        assert!(glsl.contains("rayQueryGetIntersectionWorldToObjectEXT"));
        assert!(glsl.contains("rayQueryGetIntersectionObjectToWorldEXT"));
    }

    #[test]
    fn knee_preserves_bone_lengths() {
        let a = Vec3::new(0.0, 0.8, 0.0);
        let b = Vec3::new(0.0, 0.05, 0.15);
        let k = joint(a, b, Vec3::Z, 0.41, 0.41);
        assert!((k.distance(a) - 0.41).abs() < 1e-5);
        assert!((k.distance(b) - 0.41).abs() < 1e-5);
    }
    #[test]
    fn holding_a_wall_braces_and_stops_the_stride() {
        let mut r = Rig::new(Vec3::ZERO);
        for i in 1..25 {
            r.update(
                Vec3::new(0.0, 0.0, i as f32 * 0.02),
                Vec2::Y,
                Vec2::Y,
                Vec2::ZERO,
            );
        }
        let phase = r.phase;
        let p = r.last;
        for _ in 0..80 {
            r.update(p, Vec2::ZERO, Vec2::Y, Vec2::Y);
        }
        assert_eq!(r.phase, phase);
        assert!(r.brace > 0.99 && r.blend < 0.01);
        for _ in 0..80 {
            r.update(p, Vec2::ZERO, Vec2::ZERO, Vec2::ZERO);
        }
        assert!(r.brace < 0.01);
    }
    #[test]
    fn planted_foot_is_stationary_during_straight_stance() {
        let mut r = Rig::new(Vec3::ZERO);
        r.blend = 1.0;
        let foot = r.feet[0];
        for i in 1..12 {
            r.update(
                Vec3::new(0.0, 0.0, i as f32 * 0.02),
                Vec2::Y,
                Vec2::Y,
                Vec2::ZERO,
            );
        }
        assert_eq!(r.feet[0], foot);
    }
}
