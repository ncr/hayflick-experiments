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

fn bv(v: Vec3) -> BVec3 {
    BVec3 { x: v.x, y: v.y, z: v.z }
}

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

/// One brick of a wall-break layout: half-extents + world-space rest centre
/// (axis-aligned). A pure layout datum — the viewer authors the render run
/// from it at boot, and [`PhysWorld::wall_break`] builds the matching body at
/// smash time, so the two can never drift apart.
#[derive(Clone, Copy)]
pub struct BrickSpec {
    pub half: Vec3,
    pub pos: Vec3,
}

/// The wall-break slug's half-extent (a 0.44-wu charcoal cube).
pub const SLUG_HALF: f32 = 0.22;

/// A minimal Box3D world: a fixed ground, a brick wall, and one projectile.
pub struct PhysWorld {
    world: World,
    /// Body ids in mesh order — index i ⇒ the viewer's `phys/{i}` run.
    handles: Vec<BodyId>,
    boxes: Vec<PhysBox>,
    projectile: BodyId,
    /// The projectile's launch: velocity applied when `tick` reaches `.1`.
    launch: (BVec3, u64),
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

        PhysWorld { world, handles, boxes, projectile, launch: (BVec3 { x: -6.0, y: 0.0, z: 0.0 }, LAUNCH_TICK), tick: 0 }
    }

    /// The wall-smash world (phase 3 — physics × dynamic GI): the bricks of a
    /// REAL torn-off wall segment, standing in its exact pose, plus a heavy
    /// slug already in flight. `bricks` is the layout the render runs were
    /// authored from ([`wall_bricks`]); `statics` are invisible collision
    /// boxes for the surviving neighbour geometry (flanking wall segments,
    /// the room's far wall) so debris ricochets instead of ghosting through.
    /// The slug launches from `from` with velocity `vel` at `launch_tick`
    /// (bullet CCD on, gravity ON — it arcs and then rests in the rubble).
    pub fn wall_break(bricks: &[BrickSpec], statics: &[(Vec3, Vec3)], from: Vec3, vel: Vec3, launch_tick: u64) -> PhysWorld {
        let mut world_def = default_world_def();
        world_def.gravity = BVec3 { x: 0.0, y: -9.81, z: 0.0 };
        let mut world = World::new(&world_def);

        // Ground: a large static box whose TOP face sits at the gym floor,
        // centred under the wall so debris always lands on it.
        let gh = 5.0;
        let centre = bricks.iter().fold(Vec3::ZERO, |a, b| a + b.pos) / bricks.len().max(1) as f32;
        let mut ground_def = default_body_def();
        ground_def.type_ = BodyType::Static;
        ground_def.position = BVec3 { x: centre.x, y: FLOOR_Y - gh, z: centre.z };
        let ground = create_body(&mut world, &ground_def);
        let ground_hull = make_box_hull(40.0, gh, 40.0);
        create_hull_shape(&mut world, ground, &default_shape_def(), &ground_hull.base);

        // Neighbour geometry as static colliders (world AABBs).
        for (lo, hi) in statics {
            let half = (*hi - *lo) * 0.5;
            if half.min_element() <= 0.0 {
                continue;
            }
            let mut def = default_body_def();
            def.type_ = BodyType::Static;
            def.position = bv((*lo + *hi) * 0.5);
            let body = create_body(&mut world, &def);
            let hull = make_box_hull(half.x, half.y, half.z);
            create_hull_shape(&mut world, body, &default_shape_def(), &hull.base);
        }

        let mut handles = Vec::new();
        let mut boxes = Vec::new();
        for b in bricks {
            let mut def = default_body_def();
            def.type_ = BodyType::Dynamic;
            def.enable_sleep = false; // stay responsive to the slug's contact
            def.position = bv(b.pos);
            let body = create_body(&mut world, &def);
            let hull = make_box_hull(b.half.x, b.half.y, b.half.z);
            create_hull_shape(&mut world, body, &default_shape_def(), &hull.base);
            handles.push(body);
            boxes.push(PhysBox { half: b.half });
        }

        // The slug: heavy (2.5× water — plows through a ~17 kg brick), bullet
        // CCD (fast + thin targets), gravity ON so the flight is a shallow arc
        // and it comes to rest in the debris field instead of hovering.
        let mut proj_def = default_body_def();
        proj_def.type_ = BodyType::Dynamic;
        proj_def.position = bv(from);
        proj_def.enable_sleep = false;
        proj_def.is_bullet = true;
        let projectile = create_body(&mut world, &proj_def);
        let proj_hull = make_box_hull(SLUG_HALF, SLUG_HALF, SLUG_HALF);
        let mut proj_shape = default_shape_def();
        proj_shape.density = 2500.0;
        create_hull_shape(&mut world, projectile, &proj_shape, &proj_hull.base);
        handles.push(projectile);
        boxes.push(PhysBox { half: Vec3::splat(SLUG_HALF) });

        PhysWorld { world, handles, boxes, projectile, launch: (bv(vel), launch_tick), tick: 0 }
    }

    /// Box specs (half-extents) in mesh order.
    pub fn boxes(&self) -> &[PhysBox] {
        &self.boxes
    }

    /// Advance one fixed tick. The projectile launches at its launch tick.
    pub fn step(&mut self) {
        if self.tick == self.launch.1 {
            body_set_linear_velocity(&mut self.world, self.projectile, self.launch.0);
        }
        self.world.step(DT, SUB_STEPS);
        self.tick += 1;
    }

    /// Sim ticks stepped so far.
    pub fn tick(&self) -> u64 {
        self.tick
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

/// Decompose a wall-slab AABB into a running-bond brick layout that tiles it
/// EXACTLY (the render swap static-slab → bricks must be silhouette- and
/// shadow-invisible; only a hairline `GAP` is shaved off each brick face for
/// solver clearance). The slab's longer horizontal axis is the course
/// direction, the shorter one the wall thickness; courses are ~0.22 wu tall
/// and bricks ~0.4 wu long, odd courses starting on a half brick.
pub fn wall_bricks(lo: Vec3, hi: Vec3) -> Vec<BrickSpec> {
    /// Clearance shaved off each half-extent so no brick starts interpenetrating.
    const GAP: f32 = 0.002;
    let size = hi - lo;
    let along_x = size.x >= size.z;
    let len = if along_x { size.x } else { size.z };
    let rows = (size.y / 0.22).round().max(1.0) as u32;
    let rh = size.y / rows as f32;
    let n = (len / 0.4).round().max(1.0) as u32;
    let bl = len / n as f32;
    let mut out = Vec::new();
    for r in 0..rows {
        let y = lo.y + (r as f32 + 0.5) * rh;
        // course cuts along the run: odd courses lead with a half brick
        let mut cuts = vec![0.0f32];
        let mut c = if r % 2 == 1 { bl * 0.5 } else { bl };
        while c < len - bl * 0.25 {
            cuts.push(c);
            c += bl;
        }
        cuts.push(len);
        for w in cuts.windows(2) {
            let (a, b) = (w[0], w[1]);
            let (mid, hl) = ((a + b) * 0.5, (b - a) * 0.5);
            let (pos, half) = if along_x {
                (Vec3::new(lo.x + mid, y, (lo.z + hi.z) * 0.5), Vec3::new(hl, rh * 0.5, size.z * 0.5))
            } else {
                (Vec3::new((lo.x + hi.x) * 0.5, y, lo.z + mid), Vec3::new(size.x * 0.5, rh * 0.5, hl))
            };
            out.push(BrickSpec { half: half - Vec3::splat(GAP), pos });
        }
    }
    out
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

    /// The gym's east-facade middle pier, as the wall-smash demo tears it.
    const PIER_LO: Vec3 = Vec3::new(7.9, 0.0, 4.7);
    const PIER_HI: Vec3 = Vec3::new(8.1, 2.1875, 6.3);

    /// The running-bond layout tiles the slab exactly: every course spans the
    /// full run with no holes (extents sum to the slab, bricks stay inside),
    /// and odd courses bond (their cuts sit mid-brick over the course below).
    #[test]
    fn wall_bricks_tile_the_slab() {
        let bricks = wall_bricks(PIER_LO, PIER_HI);
        let size = PIER_HI - PIER_LO;
        let rows = (size.y / 0.22).round() as usize; // 10 courses
        let per_even = (size.z / 0.4).round() as usize; // 4 full bricks
        assert_eq!(bricks.len(), rows / 2 * (2 * per_even + 1), "10 courses alternating 4/5 bricks");
        let gap_area: f32 = bricks.iter().map(|b| (b.half.z + 0.002) * 2.0 * ((b.half.y + 0.002) * 2.0)).sum();
        assert!((gap_area - size.z * size.y).abs() < 1e-3, "brick faces tile the slab face");
        for b in &bricks {
            assert!(b.pos.y - b.half.y >= PIER_LO.y - 1e-4 && b.pos.y + b.half.y <= PIER_HI.y + 1e-4);
            assert!(b.pos.z - b.half.z >= PIER_LO.z - 1e-4 && b.pos.z + b.half.z <= PIER_HI.z + 1e-4);
            assert!((b.pos.x - (PIER_LO.x + PIER_HI.x) * 0.5).abs() < 1e-4, "one brick through the thickness");
        }
    }

    fn smash_world() -> PhysWorld {
        let bricks = wall_bricks(PIER_LO, PIER_HI);
        let statics = [(Vec3::new(7.9, 0.0, 2.9), Vec3::new(8.1, 2.1875, 4.7)), (Vec3::new(7.9, 0.0, 6.3), Vec3::new(8.1, 2.1875, 8.1))];
        PhysWorld::wall_break(&bricks, &statics, Vec3::new(12.6, 2.0, 5.5), Vec3::new(-14.0, 0.0, 0.0), 0)
    }

    /// Same-machine wall-break replay is bit-identical (the DEMO guarantee).
    #[test]
    fn wall_break_is_deterministic_across_builds() {
        let (mut a, mut b) = (smash_world(), smash_world());
        for _ in 0..240 {
            a.step();
            b.step();
        }
        assert_eq!(digest(&a), digest(&b), "same-machine wall-break replay must be bit-identical");
    }

    /// The slug actually breaches the pier: bricks scatter off the wall plane
    /// and the courses come down, while everything stays above the floor.
    #[test]
    fn slug_breaches_the_pier() {
        let mut w = smash_world();
        let n = w.boxes().len() - 1;
        for _ in 0..240 {
            w.step();
        }
        let ms = w.box_transforms();
        let mean_y = ms[..n].iter().map(|m| m.w_axis.y).sum::<f32>() / n as f32;
        assert!(mean_y < 2.1875 * 0.5 - 0.2, "courses must come down (mean brick height {mean_y})");
        let scatter = ms[..n].iter().map(|m| (m.w_axis.x - 8.0).abs()).fold(0.0f32, f32::max);
        assert!(scatter > 0.5, "debris must leave the wall plane (max |dx| {scatter})");
        for m in &ms[..n] {
            assert!(m.w_axis.y > -0.5, "no brick may fall through the ground");
        }
    }
}
