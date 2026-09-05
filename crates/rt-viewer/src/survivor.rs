//! Blender-authored Vault 42 survivor, with fixed-tick stance and ground IK.
//! Asset source: blender/build_survivor.py; editable model: survivor.blend.
use glam::{Mat4, Quat, Vec2, Vec3};
use rt_probe::{InstanceKey, Scene, SceneHandles};

/// A compact export of Blender triangle corners and their split normals.
/// Compiled into the game so launching from a different cwd cannot lose the body.
/// No runtime dependency on Blender or a second mesh/normal generator.
pub fn build(s: &mut Scene) {
    let mut bytes: &[u8] = include_bytes!("../../../assets/characters/survivor.mesh");
    fn take<'a>(bytes: &mut &'a [u8], n: usize) -> &'a [u8] {
        let (a, b) = bytes.split_at(n);
        *bytes = b;
        a
    }
    fn u32le(bytes: &mut &[u8]) -> u32 {
        u32::from_le_bytes(take(bytes, 4).try_into().unwrap())
    }
    fn f32le(bytes: &mut &[u8]) -> f32 {
        f32::from_le_bytes(take(bytes, 4).try_into().unwrap())
    }
    assert_eq!(take(&mut bytes, 8), b"HFCHAR01");
    let nmat = u32le(&mut bytes);
    let npart = u32le(&mut bytes);
    let base = s.materials.len() as i32;
    for material_index in 0..nmat {
        let color = std::array::from_fn(|_| f32le(&mut bytes));
        let roughness = f32le(&mut bytes);
        let flags = u32le(&mut bytes) as i32;
        s.materials.push(rt_probe::scene::Material {
            base_color: color,
            emissive: [0.; 4],
            roughness,
            metallic: 0.,
            tex_index: -2 - material_index as i32,
            _pad: flags,
        });
    }
    for _ in 0..npart {
        let len = u32le(&mut bytes) as usize;
        let name = std::str::from_utf8(take(&mut bytes, len)).unwrap();
        let nmesh = u32le(&mut bytes);
        let start = s.primitives.len();
        for _ in 0..nmesh {
            let mat = u32le(&mut bytes);
            assert!(mat < nmat);
            let n = u32le(&mut bytes);
            let verts: Vec<_> = (0..n)
                .map(|_| {
                    let p = std::array::from_fn(|_| f32le(&mut bytes));
                    let normal = std::array::from_fn(|_| f32le(&mut bytes));
                    (p, normal)
                })
                .collect();
            let first = s.vertices.len();
            s.add_mesh_world(&verts, &(0..n).collect::<Vec<_>>(), base + mat as i32);
            let (length, height) = if name.contains("/leg") {
                (0.445, 0.91)
            } else if name.contains("/shin") {
                (0.425, 0.465)
            } else if name.contains("/arm") {
                (0.29, 1.405)
            } else if name.contains("/fore") {
                (0.265, 1.118)
            } else if name.contains("/foot") {
                (1., 0.065)
            } else if name.contains("/hand") {
                (1., 0.853)
            } else if name.ends_with("chest") {
                (1., 1.035)
            } else if name.ends_with("head") {
                (1., 1.625)
            } else {
                (1., 0.91)
            };
            for v in &mut s.vertices[first..] {
                v.uv = [v.pos[0] + 0.4 * v.pos[2], v.pos[1] * length + height];
            }
        }
        s.register_dynamic(
            name,
            start,
            s.primitives.len() - start,
            Mat4::from_scale(Vec3::ZERO),
        );
    }
    assert!(bytes.is_empty(), "unconsumed character export data");
}
/// Joint between links of length a,b with a pole vector giving bend direction.
pub fn joint(root: Vec3, end: Vec3, pole: Vec3, a: f32, b: f32) -> Vec3 {
    let delta = end - root;
    let dist = delta.length().clamp(0.025, a + b - 0.002);
    let axis = delta.try_normalize().unwrap_or(-Vec3::Y);
    let along = (a * a - b * b + dist * dist) / (2.0 * dist);
    let projected = pole - axis * pole.dot(axis);
    let fallback = if axis.x.abs() < 0.7 { Vec3::X } else { Vec3::Z };
    let perpendicular = projected
        .try_normalize()
        .unwrap_or_else(|| (fallback - axis * fallback.dot(axis)).normalize());
    root + axis * along + perpendicular * (a * a - along * along).max(0.0).sqrt()
}
fn bone(a: Vec3, b: Vec3, heading: Quat) -> Mat4 {
    let delta = b - a;
    Mat4::from_scale_rotation_translation(
        Vec3::new(1.0, delta.length().max(0.001), 1.0),
        heading * Quat::from_rotation_arc(-Vec3::Y, heading.inverse() * delta.normalize_or_zero()),
        a,
    )
}
#[derive(Clone, Copy)]
struct AdjustStep {
    from: Vec3,
    to: Vec3,
    t: f32,
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
    crouch: f32,
    adjust: [Option<AdjustStep>; 2],
}
impl Rig {
    pub fn new(p: Vec3) -> Self {
        let feet = [
            p + Vec3::new(-0.12, 0.065, 0.045),
            p + Vec3::new(0.12, 0.065, -0.045),
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
            crouch: 0.0,
            adjust: [None; 2],
        }
    }
    #[cfg(test)]
    fn update(&mut self, p: Vec3, velocity: Vec2, intent: Vec2, contact: Vec2) {
        self.update_grounded(p, velocity, intent, contact, false, |_| p.y);
    }
    pub fn update_grounded(
        &mut self,
        p: Vec3,
        velocity: Vec2,
        intent: Vec2,
        contact: Vec2,
        crouching: bool,
        ground: impl Fn(Vec2) -> f32,
    ) {
        // Controlled descent and recovery; stance height never snaps on a key.
        let wanted = if crouching { 1.0 } else { 0.0 };
        self.crouch += (wanted - self.crouch).clamp(-0.065, 0.065);
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
        let jog = ((self.speed - 2.2) / 2.0).clamp(0.0, 1.0) * (1.0 - self.crouch);
        let duty = 0.62 - 0.16 * jog + 0.10 * self.crouch;
        let stride = (1.50 + 0.85 * jog) * (1.0 - 0.40 * self.crouch);
        self.phase += distance / stride;
        let rot = Quat::from_rotation_y(self.heading);
        for i in 0..2 {
            let phase = (self.phase + i as f32 * 0.5).fract();
            let stance = phase < duty;
            let side = if i == 0 { -1.0 } else { 1.0 };
            let lateral = side * (0.12 - 0.017 * self.blend + 0.025 * self.crouch);
            let support = |mut foot: Vec3| {
                // A boot bridges a narrow joint; each leg still follows its own
                // slab/soil height instead of inheriting the body's centre.
                let toe = foot + rot * Vec3::new(0., 0., 0.11);
                let heel = foot - rot * Vec3::new(0., 0., 0.05);
                foot.y = ground(Vec2::new(foot.x, foot.z))
                    .max(ground(Vec2::new(toe.x, toe.z)))
                    .max(ground(Vec2::new(heel.x, heel.z)))
                    + 0.065;
                foot
            };
            let home = support(p + rot * Vec3::new(lateral, 0., -side * 0.045 * (1. - self.blend)));

            if self.blend < 0.15 {
                // Lift and replant on stopping/stance changes, one foot at a
                // time. Do not drag both soles to a new idle pose.
                if self.adjust[i].is_none()
                    && self.adjust[1 - i].is_none()
                    && self.feet[i].distance(home) > 0.035
                {
                    self.adjust[i] = Some(AdjustStep {
                        from: self.feet[i],
                        to: home,
                        t: 0.0,
                    });
                }
                if let Some(step) = &mut self.adjust[i] {
                    step.t = (step.t + 1.0 / 14.0).min(1.0);
                    let t = step.t;
                    let smooth = t * t * (3.0 - 2.0 * t);
                    self.feet[i] = step.from.lerp(step.to, smooth)
                        + Vec3::Y * (std::f32::consts::PI * t).sin() * 0.055;
                    self.stance[i] = t >= 1.0;
                    if t >= 1.0 {
                        self.adjust[i] = None;
                    }
                } else {
                    self.stance[i] = true;
                }
                continue;
            }
            self.adjust[i] = None;
            if !stance {
                if self.stance[i] {
                    self.from[i] = self.feet[i];
                }
                let t = ((phase - duty) / (1.0 - duty)).clamp(0.0, 1.0);
                let smooth = t * t * (3.0 - 2.0 * t);
                let target = support(
                    home + rot * Vec3::Z * ((0.32 + 0.20 * jog) * (1.0 - 0.48 * self.crouch)),
                );
                self.feet[i] = self.from[i].lerp(target, smooth)
                    + Vec3::Y
                        * (std::f32::consts::PI * t).sin()
                        * (0.105 + 0.12 * jog)
                        * (1.0 - 0.55 * self.crouch);
            }
            // Release an overextended planted foot during sharp turns, without ever
            // dragging the whole skeleton through the collision surface.
            let reach = 0.50 + 0.10 * jog - 0.14 * self.crouch;
            if (self.feet[i] - home).length() > reach {
                self.feet[i] = support(home + (self.feet[i] - home).normalize() * reach);
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
        let cycle = self.phase * std::f32::consts::TAU;
        let bob = (cycle * 2.0).cos() * 0.012 * self.blend;
        let sway = cycle.sin() * self.blend;
        let mut pelvis = world(Vec3::new(
            0.012 * sway + 0.012 * (1. - self.blend),
            0.91 + bob * (1.0 - 0.65 * self.crouch) - 0.40 * self.crouch,
            -0.025 * self.brace - 0.105 * self.crouch,
        ));
        // Both knees must stay reachable. Lower the pelvis at long strides
        // instead of stretching the exported anatomy or separating the knee.
        for (i, foot) in self.feet.iter().enumerate() {
            let hip = pelvis + rot * Vec3::new(if i == 0 { -0.103 } else { 0.103 }, 0., 0.);
            let horizontal = Vec2::new(hip.x - foot.x, hip.z - foot.z).length_squared();
            pelvis.y = pelvis
                .y
                .min(foot.y + (0.864_f32.powi(2) - horizontal).max(0.01).sqrt());
        }
        let base = Mat4::from_rotation_translation(rot, pelvis);
        push("player", base * Mat4::from_rotation_y(0.045 * sway));
        let chest =
            base * Mat4::from_translation(Vec3::new(
                0.0,
                0.125 + 0.002 * (self.time * 1.65).sin(),
                0.0,
            )) * Mat4::from_rotation_y(-0.065 * sway)
                * Mat4::from_rotation_z(-0.018 * sway)
                * Mat4::from_rotation_x(0.045 + self.lean - 0.10 * self.brace + 0.34 * self.crouch);
        push("player/chest", chest);
        push(
            "player/head",
            chest
                * Mat4::from_translation(Vec3::new(0.0, 0.59, 0.015))
                * Mat4::from_rotation_y(0.05 * sway)
                * Mat4::from_rotation_x(-0.06 - 0.28 * self.crouch),
        );
        for (i, side) in ["L", "R"].iter().enumerate() {
            let side_x = if i == 0 { -1.0 } else { 1.0 };
            let hip = pelvis + rot * Vec3::new(side_x * 0.103, 0.0, 0.0);
            let foot = self.feet[i];
            let knee = joint(
                hip,
                foot,
                rot * Vec3::new(side_x * 0.06, 0., 1.),
                0.445,
                0.425,
            );
            push(&format!("player/leg{side}"), bone(hip, knee, rot));
            push(&format!("player/shin{side}"), bone(knee, foot, rot));
            let local_foot = rot.inverse() * (foot - p);
            // Heel strike raises the toe; late stance peels the heel off the
            // ground. Rotation uses a sole pivot so boots don't pass through it.
            let roll = (if self.stance[i] {
                (-local_foot.z * 0.58).clamp(-0.19, 0.23) * self.blend
            } else {
                0.22 * (cycle + i as f32 * std::f32::consts::PI).sin() * self.blend
            }) * (1.0 - 0.8 * self.crouch);
            let pivot = Vec3::new(0., -0.064, if roll > 0. { 0.155 } else { -0.058 });
            let foot_pose = Mat4::from_rotation_translation(rot, foot)
                * Mat4::from_rotation_y(side_x * 0.08 * (1. - self.blend))
                * Mat4::from_translation(pivot)
                * Mat4::from_rotation_x(roll)
                * Mat4::from_translation(-pivot);
            push(&format!("player/foot{side}"), foot_pose);
            let shoulder = chest.transform_point3(Vec3::new(side_x * 0.225, 0.37, -0.005));
            let jog = ((self.speed - 2.2) / 2.0).clamp(0., 1.) * (1.0 - self.crouch);
            let rest = world(Vec3::new(
                side_x * 0.255,
                0.855 + 0.10 * jog - 0.27 * self.crouch,
                -0.015 + 0.16 * self.crouch - local_foot.z * (0.52 + 0.2 * jog) * self.blend,
            ));
            let brace = world(Vec3::new(side_x * 0.20, 1.30 - 0.40 * self.crouch, 0.17));
            let wanted_hand = rest.lerp(brace, self.brace);
            let arm_delta = wanted_hand - shoulder;
            let hand =
                shoulder + arm_delta.normalize_or_zero() * arm_delta.length().clamp(0.03, 0.553);
            let elbow = joint(
                shoulder,
                hand,
                rot * Vec3::new(side_x * 0.25, 0.0, -1.0),
                0.29,
                0.265,
            );
            push(&format!("player/arm{side}"), bone(shoulder, elbow, rot));
            push(&format!("player/fore{side}"), bone(elbow, hand, rot));
            push(
                &format!("player/hand{side}"),
                Mat4::from_rotation_translation(rot, hand)
                    * Mat4::from_rotation_x(-1.25 * self.brace)
                    * Mat4::from_rotation_z(side_x * 0.08 * (1. - self.brace)),
            );
        }
        out
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn model_handles(scene: &Scene) -> SceneHandles {
        SceneHandles {
            lights: Default::default(),
            instances: scene
                .dynamics
                .iter()
                .enumerate()
                .map(|(i, (name, _, _, _))| (name.clone(), InstanceKey::from_index(i as u32)))
                .collect(),
        }
    }

    #[test]
    fn crouch_and_recovery_keep_limbs_full_length_and_feet_on_separate_supports() {
        let mut scene = Scene::new();
        build(&mut scene);
        let handles = model_handles(&scene);
        let p = Vec3::new(0., 0.14, 0.);
        let ground = |xz: Vec2| if xz.x < 0. { 0.0 } else { 0.14 };
        let mut rig = Rig::new(p);
        let head = |r: &Rig| {
            r.instances(p, &handles)
                .into_iter()
                .find(|(k, _)| *k == handles.instances["player/head"])
                .unwrap()
                .1
                .w_axis
                .y
        };
        for _ in 0..60 {
            rig.update_grounded(p, Vec2::ZERO, Vec2::ZERO, Vec2::ZERO, false, ground);
        }
        let standing = head(&rig);
        for tick in 0..150 {
            let before = head(&rig);
            rig.update_grounded(p, Vec2::ZERO, Vec2::ZERO, Vec2::ZERO, tick < 75, ground);
            assert!(
                (head(&rig) - before).abs() < 0.05,
                "stance must transition without a pop"
            );
            if tick == 70 {
                // The lower left support already lowers the standing pelvis.
                assert!(standing - head(&rig) > 0.28);
                assert!((rig.feet[0].y - 0.065).abs() < 0.002);
                assert!((rig.feet[1].y - 0.205).abs() < 0.002);
            }
            for (key, m) in rig.instances(p, &handles) {
                let name = &scene.dynamics[key.index() as usize].0;
                let length = if name.contains("/leg") {
                    0.445
                } else if name.contains("/shin") {
                    0.425
                } else if name.contains("/arm") {
                    0.29
                } else if name.contains("/fore") {
                    0.265
                } else {
                    continue;
                };
                assert!(
                    (m.transform_vector3(Vec3::Y).length() - length).abs() < 0.0001,
                    "{name} stretched"
                );
            }
        }
        assert!((head(&rig) - standing).abs() < 0.01);
    }

    #[test]
    fn crouch_walk_run_and_wall_contact_keep_the_actual_mesh_above_ground() {
        let mut scene = Scene::new();
        build(&mut scene);
        let handles = model_handles(&scene);
        let mut rig = Rig::new(Vec3::ZERO);
        let mut p = Vec3::ZERO;
        for tick in 0..840 {
            let crouching = (100..390).contains(&tick);
            let speed = if tick < 100 || tick >= 690 {
                0.0
            } else if crouching {
                1.1
            } else {
                4.2
            };
            let angle = tick as f32 * 0.008;
            let velocity = Vec2::new(angle.sin(), angle.cos()) * speed;
            p += Vec3::new(velocity.x, 0., velocity.y) * house_game::TICK_DT;
            let contact = if tick >= 690 { Vec2::Y } else { Vec2::ZERO };
            rig.update_grounded(
                p,
                velocity,
                if tick >= 690 { contact } else { velocity },
                contact,
                crouching,
                |_| 0.0,
            );
            if tick % 6 != 0 {
                continue;
            }
            for (key, pose) in rig.instances(p, &handles) {
                let (name, first, count, _) = &scene.dynamics[key.index() as usize];
                for prim in &scene.primitives[*first..first + count] {
                    for v in &scene.vertices[prim.vertex_offset as usize
                        ..(prim.vertex_offset + prim.vertex_count) as usize]
                    {
                        let world = pose.transform_point3(Vec3::from(v.pos));
                        assert!(
                            world.is_finite()
                                && world.y > -0.025
                                && world.y < 1.9
                                && world.distance(p) < 2.,
                            "{name} invalid at {tick}: {world:?}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn walk_jog_turn_and_stop_keep_the_exported_body_finite_and_above_ground() {
        let mut scene = Scene::new();
        build(&mut scene);
        let handles = model_handles(&scene);
        let mut rig = Rig::new(Vec3::ZERO);
        let mut p = Vec3::ZERO;
        for tick in 0..600 {
            let yaw = (tick as f32 * 0.008).min(2.4);
            let speed = if tick < 180 {
                1.65
            } else if tick < 420 {
                3.2
            } else {
                0.
            };
            let velocity = Vec2::new(yaw.sin(), yaw.cos()) * speed;
            p += Vec3::new(velocity.x, 0., velocity.y) * house_game::TICK_DT;
            rig.update(p, velocity, velocity, Vec2::ZERO);
            if tick % 10 != 0 {
                continue;
            }
            for (key, pose) in rig.instances(p, &handles) {
                assert!(pose.is_finite());
                let (_, first, count, _) = &scene.dynamics[key.index() as usize];
                for prim in &scene.primitives[*first..first + count] {
                    for v in &scene.vertices[prim.vertex_offset as usize
                        ..(prim.vertex_offset + prim.vertex_count) as usize]
                    {
                        let world = pose.transform_point3(Vec3::from(v.pos));
                        assert!(
                            world.y > -0.025,
                            "body below ground at tick {tick}: {world:?}"
                        );
                        assert!(
                            world.y < 1.85 && world.distance(p) < 2.,
                            "unbounded pose at tick {tick}"
                        );
                    }
                }
            }
        }
    }

    /// Developer export: the .blend previews the SAME solved animation as the
    /// game. No second Blender approximation that silently drifts from play.
    #[test]
    #[ignore = "writes Blender animation review data; run explicitly when rebuilding the asset"]
    fn export_blender_motion() {
        use std::io::Write;
        let root =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../output/player-reference");
        std::fs::create_dir_all(&root).unwrap();
        let mut file = std::fs::File::create(root.join("motion.txt")).unwrap();
        let mut scene = Scene::new();
        build(&mut scene);
        let handles = model_handles(&scene);
        for clip in [
            "Idle",
            "Walk",
            "Jog",
            "Brace",
            "Turn",
            "Crouch",
            "CrouchWalk",
            "CrouchBrace",
            "Recover",
        ] {
            let mut rig = Rig::new(Vec3::ZERO);
            let mut p = Vec3::ZERO;
            for frame in 0..180 {
                let yaw = if clip == "Turn" {
                    frame as f32 * std::f32::consts::TAU / 180.
                } else {
                    0.
                };
                let speed = match clip {
                    "Walk" | "Turn" => house_game::gym::sim::SURVIVOR_WALK,
                    "Jog" => house_game::gym::sim::SURVIVOR_RUN,
                    "CrouchWalk" => house_game::gym::sim::SPEED_CROUCH,
                    _ => 0.,
                };
                let velocity = Vec2::new(yaw.sin(), yaw.cos()) * speed;
                p += Vec3::new(velocity.x, 0., velocity.y) * house_game::TICK_DT;
                let contact = if (clip == "Brace" || clip == "CrouchBrace") && frame < 100 {
                    Vec2::Y
                } else {
                    Vec2::ZERO
                };
                rig.update_grounded(
                    p,
                    velocity,
                    if contact != Vec2::ZERO {
                        contact
                    } else {
                        velocity
                    },
                    contact,
                    matches!(clip, "Crouch" | "CrouchWalk" | "CrouchBrace")
                        || (clip == "Recover" && frame < 75),
                    |_| 0.0,
                );
                for (key, pose) in rig.instances(p, &handles) {
                    write!(
                        file,
                        "{clip} {} {}",
                        frame + 1,
                        scene.dynamics[key.index() as usize].0
                    )
                    .unwrap();
                    for x in (Mat4::from_translation(-p) * pose).to_cols_array() {
                        write!(file, " {x:.7}").unwrap();
                    }
                    writeln!(file).unwrap();
                }
            }
        }
    }
    #[test]
    fn limb_roll_tracks_the_characters_heading() {
        // Vertical links previously kept a world-Z front while the body turned.
        // A circular placeholder hid the bug; a boot cuff/denim seam exposes it.
        let heading = Quat::from_rotation_y(1.3);
        let m = bone(Vec3::Y, Vec3::ZERO, heading);
        assert!(m.transform_vector3(Vec3::Z).distance(heading * Vec3::Z) < 1e-5);
    }

    #[test]
    fn blender_asset_is_complete_and_valid_for_metal() {
        let mut scene = Scene::new();
        build(&mut scene);
        scene.validate_acceleration_geometry().unwrap();
        assert_eq!(scene.dynamics.len(), 15);
        for v in &scene.vertices {
            assert!((Vec3::from(v.nrm).length() - 1.).abs() < 0.002);
        }
        for (_, first, count, _) in &scene.dynamics {
            assert!(*count > 0 && first + count <= scene.primitives.len());
        }
    }
    #[test]
    fn articulated_shading_uses_instance_space_transforms_on_both_backends() {
        // A stretched, rotated joint needs inverse-transpose normals and
        // world-space contour distances, not its bind-pose vertex data.
        let metal = include_str!("shaders_metal/shade.metal");
        let glsl = include_str!("../../rt-probe/src/shaders/shade.comp");
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
    fn ik_pole_parallel_to_the_limb_cannot_collapse_the_knee() {
        let root = Vec3::ZERO;
        let end = Vec3::Y * 0.6;
        let knee = joint(root, end, Vec3::Y, 0.4, 0.4);
        assert!((knee.distance(root) - 0.4).abs() < 1e-5);
        assert!((knee.distance(end) - 0.4).abs() < 1e-5);
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
