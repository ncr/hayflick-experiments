//! phys-spike — a throwaway Box3D rigid-body world for the destructibility
//! exploration (the `voxel-physics-spike` branch).
//!
//! Physics engine: **`box3d-rust`** — a pure-Rust port of Erin Catto's Box3D
//! (owner pick over the FFI `boxddd` bindings: no C toolchain in the
//! Metal+Vulkan dual build, and the port keeps Box3D's hand-rolled
//! cross-platform-deterministic math bit-for-bit with the C reference —
//! scalar, no SIMD divergence, the safest bet for the M2/ARM ↔ spawner/x86
//! split). The 0.1 API is a direct C-mirror: build defs with the
//! `default_*` constructors (they carry an internal cookie — never
//! struct-literal them) and mutate fields.
//!
//! This is NOT part of the deterministic gameplay sim. It's a
//! presentation-layer physics demo, stepped exactly once per fixed 60 Hz tick
//! so DEMO captures reproduce. It owns no aesthetics: it hands out box
//! half-extents + world transforms, and the rt-viewer adapter authors the
//! meshes (mirrors how house-game stays render-blind).
//!
//! The demo scene: a small brick wall on the gym floor and a heavy projectile
//! box that launches into it after a one-second beat, so a playtester sees the
//! wall standing first, then watches it come down.

use box3d_rust::body::{body_get_transform, body_set_linear_velocity, create_body};
use box3d_rust::hull::make_box_hull;
use box3d_rust::math_functions::Vec3 as BVec3;
use box3d_rust::shape::create_hull_shape;
use box3d_rust::types::{default_body_def, default_shape_def, default_world_def, BodyType};
use box3d_rust::world::World;
use box3d_rust::BodyId;
use glam::{Mat4, Quat, Vec3};

/// Ground-plane top — matches the gym floor (`gym_scene::FLOOR_TOP` = 6/128).
const FLOOR_Y: f32 = 6.0 / 128.0;
/// Fixed timestep — the sim clock (`house_game::TICK_DT`, 60 Hz).
const DT: f32 = 1.0 / 60.0;
/// Solver sub-steps per tick (Box3D's stability knob).
const SUB_STEPS: i32 = 4;
/// Ticks the projectile waits before launching (1 s): the wall stands first.
const LAUNCH_TICK: u64 = 60;

/// One dynamic box: half-extents, so the viewer can build a matching mesh.
#[derive(Clone, Copy)]
pub struct PhysBox {
    pub half: Vec3,
}

/// A minimal Box3D world: a fixed ground, a brick wall, and one projectile.
pub struct PhysWorld {
    world: World,
    /// Body ids in mesh order — index i ⇒ the viewer's `phys/{i}` run.
    handles: Vec<BodyId>,
    boxes: Vec<PhysBox>,
    projectile: BodyId,
    tick: u64,
}

impl PhysWorld {
    /// Build the demo scene.
    pub fn demo() -> PhysWorld {
        let mut world_def = default_world_def();
        world_def.gravity = BVec3 { x: 0.0, y: -9.81, z: 0.0 };
        let mut world = World::new(&world_def);

        // Ground: a large static box whose TOP face sits at the gym floor.
        let gh = 5.0;
        let mut ground_def = default_body_def();
        ground_def.type_ = BodyType::Static;
        ground_def.position = BVec3 { x: 9.0, y: FLOOR_Y - gh, z: 7.0 };
        let ground = create_body(&mut world, &ground_def);
        let ground_hull = make_box_hull(40.0, gh, 40.0);
        create_hull_shape(&mut world, ground, &default_shape_def(), &ground_hull.base);

        let mut handles = Vec::new();
        let mut boxes = Vec::new();

        // The brick wall: 3 columns (along Z) × 5 rows (up Y), centred at
        // (cx, cz) in open outdoor ground a couple of cells from the player.
        let (hx, hy, hz) = (0.18f32, 0.12f32, 0.22f32);
        let (cx, cz) = (13.0f32, 11.5f32);
        let gap = 0.004f32; // hair of clearance so nothing starts interpenetrating
        let brick_hull = make_box_hull(hx, hy, hz);
        for r in 0..5u32 {
            for c in 0..3u32 {
                let mut def = default_body_def();
                def.type_ = BodyType::Dynamic;
                def.enable_sleep = false; // stay responsive to the bullet's contact
                def.position = BVec3 {
                    x: cx,
                    y: FLOOR_Y + hy + r as f32 * (2.0 * hy + gap),
                    z: cz + (c as f32 - 1.0) * (2.0 * hz + gap),
                };
                let body = create_body(&mut world, &def);
                create_hull_shape(&mut world, body, &default_shape_def(), &brick_hull.base);
                handles.push(body);
                boxes.push(PhysBox { half: Vec3::new(hx, hy, hz) });
            }
        }

        // The projectile: a heavy weightless cube (gravity off the whole time,
        // never-sleep) hovering at mid-wall height to the +X side, bullet CCD on
        // (fast mover — no tunnelling through the thin bricks). At LAUNCH_TICK it
        // fires as a flat horizontal bullet into the wall's upper-middle — no
        // gravity, so it arrives at full height and full momentum and the top
        // courses actually fly (with gravity on it fell to the floor mid-flight
        // and stopped short). It keeps going off-screen after; the bricks
        // themselves DO have gravity and fall/tumble normally.
        let ph = 0.22f32;
        let mut proj_def = default_body_def();
        proj_def.type_ = BodyType::Dynamic;
        proj_def.position = BVec3 { x: cx + 5.0, y: FLOOR_Y + 0.62, z: cz };
        proj_def.gravity_scale = 0.0;
        proj_def.enable_sleep = false;
        let projectile = create_body(&mut world, &proj_def);
        let proj_hull = make_box_hull(ph, ph, ph);
        let mut proj_shape = default_shape_def();
        // Box3D's default density is water (1000 kg/m³), so a brick is ~36 kg;
        // the projectile is ~2.5× water → clearly heavier than a brick, so it
        // plows through instead of bouncing off, but slow enough (see the launch
        // velocity) that the bricks tumble into a debris field rather than
        // rocketing off the yard.
        proj_shape.density = 2500.0;
        create_hull_shape(&mut world, projectile, &proj_shape, &proj_hull.base);
        handles.push(projectile);
        boxes.push(PhysBox { half: Vec3::splat(ph) });

        PhysWorld { world, handles, boxes, projectile, tick: 0 }
    }

    /// Box specs (half-extents) in mesh order.
    pub fn boxes(&self) -> &[PhysBox] {
        &self.boxes
    }

    /// Advance one fixed tick. The projectile launches at `LAUNCH_TICK`.
    pub fn step(&mut self) {
        if self.tick == LAUNCH_TICK {
            body_set_linear_velocity(&mut self.world, self.projectile, BVec3 { x: -6.0, y: 0.0, z: 0.0 });
        }
        self.world.step(DT, SUB_STEPS);
        self.tick += 1;
    }

    /// Per-box world transform (`translate · rotate`), mesh authored at origin.
    pub fn box_transforms(&self) -> Vec<Mat4> {
        self.handles
            .iter()
            .map(|&id| {
                let t = body_get_transform(&self.world, id);
                let (p, q) = (t.p, t.q);
                Mat4::from_rotation_translation(Quat::from_xyzw(q.v.x, q.v.y, q.v.z, q.s), Vec3::new(p.x, p.y, p.z))
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Bricks in the wall (3 columns × 5 rows); the projectile is index `BRICKS`.
    const BRICKS: usize = 15;

    /// FNV-1a over every box transform — a coarse state digest.
    fn digest(w: &PhysWorld) -> u64 {
        let mut h = 0xcbf3_00d0_0000_0000u64 ^ 0x0000_0000_0000_0001;
        for m in w.box_transforms() {
            for v in m.to_cols_array() {
                h ^= v.to_bits() as u64;
                h = h.wrapping_mul(0x0000_0100_0000_01b3);
            }
        }
        h
    }

    /// Same-machine replay is bit-identical: two independent builds stepped the
    /// same number of ticks must reach the same state (the DEMO-capture
    /// guarantee this spike relies on — and Box3D's headline property).
    #[test]
    fn demo_is_deterministic_across_builds() {
        let mut a = PhysWorld::demo();
        let mut b = PhysWorld::demo();
        for _ in 0..180 {
            a.step();
            b.step();
        }
        assert_eq!(digest(&a), digest(&b), "same-machine physics replay must be bit-identical");
    }

    /// The projectile actually brings the wall down: the bricks' mean height
    /// after the smash is well below their stacked starting height.
    #[test]
    fn projectile_topples_the_wall() {
        let mut w = PhysWorld::demo();
        let mean_y = |w: &PhysWorld| w.box_transforms()[..BRICKS].iter().map(|m| m.w_axis.y).sum::<f32>() / BRICKS as f32;
        let y0 = mean_y(&w);
        for _ in 0..180 {
            w.step();
        }
        let y1 = mean_y(&w);
        assert!(y1 < y0 - 0.05, "the wall must come down (mean brick height {y0} -> {y1})");
    }
}
