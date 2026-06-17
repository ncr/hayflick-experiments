//! Backend-agnostic, GPU-free scene-derived data. The CPU computations both the
//! Vulkan and Metal backends need to build their GPU resources — extracted ONCE
//! here so there is a single source of truth and a GPU-free test surface (the
//! Apple-Silicon port had copy-pasted them into the Metal backend, and the two
//! probe-grid loops had already silently diverged). Plain functions returning
//! plain data; no trait, no generics — the GPU-struct construction (Vulkan's
//! `vk::…InstanceKHR` vs Metal's `MTL…InstanceDescriptor`, the buffer uploads,
//! the in-place patches) stays per-backend, where it belongs.

use crate::render::InstanceKey;
use crate::scene::{Material, Scene};
use glam::{Mat4, Vec3};
use std::collections::BTreeMap;

/// Probe count ceiling: spacing widens until `dims.x·y·z` fits under this.
pub const PROBE_CAP: u32 = 262_144;

/// World-space irradiance probe grid: the scene AABB padded by ONE spacing,
/// spacing widened (×1.25) until the count fits `PROBE_CAP`.
///
/// **Frozen pad (canonical Vulkan form):** the pad uses the INITIAL spacing and
/// is computed once; the widening loop grows only `spacing` for the dims math.
/// The Metal port had recomputed the pad with the widened spacing inside the
/// loop, so its grid origin diverged once any widening occurred (latent: every
/// shipping scene stays under the cap). This is the single source both backends
/// now use, so that divergence cannot recur — pinned by a test below.
pub struct ProbeGrid {
    pub origin: Vec3, // pmin = scene.min − splat(initial spacing)
    pub spacing: f32, // possibly widened
    pub dims: [u32; 3],
    pub count: u32,
    /// The full probe-cache float buffer both backends upload verbatim: a
    /// 16-float header (origin.xyz, spacing, dims.xyz, pad) followed by 2 banks
    /// × 20 floats/probe (zeroed; `bake_probes` fills them). Byte-identity
    /// across backends is therefore structural.
    pub header: Vec<f32>,
}

impl ProbeGrid {
    pub fn build(min: Vec3, max: Vec3, probe_spacing: f32) -> ProbeGrid {
        let mut spacing = probe_spacing;
        let pmin = min - Vec3::splat(spacing);
        let pmax = max + Vec3::splat(spacing);
        let ext = (pmax - pmin).max(Vec3::splat(0.1));
        let dims = loop {
            let d = [
                ((ext.x / spacing).ceil() as u32 + 1).max(2),
                ((ext.y / spacing).ceil() as u32 + 1).max(2),
                ((ext.z / spacing).ceil() as u32 + 1).max(2),
            ];
            if d[0] as u64 * d[1] as u64 * d[2] as u64 <= PROBE_CAP as u64 {
                break d;
            }
            spacing *= 1.25;
        };
        let count = dims[0] * dims[1] * dims[2];
        let mut header = vec![0.0f32; 16 + count as usize * 20 * 2];
        header[0] = pmin.x;
        header[1] = pmin.y;
        header[2] = pmin.z;
        header[3] = spacing;
        header[4] = dims[0] as f32;
        header[5] = dims[1] as f32;
        header[6] = dims[2] as f32;
        ProbeGrid { origin: pmin, spacing, dims, count, header }
    }
}

/// Per-instance TLAS data derived from a `Scene` — one entry per primitive,
/// 1:1. Most primitives bake to world space (identity instances); dynamic runs
/// (the movable player, named door leaves) carry their start transform and are
/// patched per frame. Backends consume these `Vec`s positionally and write
/// their own GPU instance structs.
pub struct InstanceTable {
    /// Per-instance transform (dynamics: the run's start transform; statics:
    /// `Mat4::IDENTITY`).
    pub transforms: Vec<Mat4>,
    /// Build-time visibility mask: `0x05` dynamic (0x01 primary | 0x04 dynamic),
    /// `0xff` static. The dollhouse `0x02` hide is applied later, event-driven.
    pub masks: Vec<u8>,
    /// Explicit dynamic flag. Do NOT infer dynamics from `masks[i] & 0x04` —
    /// `0xff & 0x04 != 0`, so statics would falsely test dynamic.
    pub is_dynamic: Vec<bool>,
    /// Per-instance dollhouse near-wall hide bits (from `Scene::prim_hide_mask`);
    /// dynamics are forced to 0 (doors sit inside, the player is the player).
    pub hide_masks: Vec<u8>,
    /// Per dynamic run: `(first instance, count)` in `dynamic_list` order.
    pub dyn_insts: Vec<(u32, u32)>,
    /// Per dynamic run: the start transform (the CPU shadow backends compare
    /// against so idle movers never rebuild the TLAS).
    pub dyn_shadow: Vec<Mat4>,
    /// Name → run handle. `InstanceKey(i)` indexes `dyn_insts`/`dyn_shadow`.
    pub instances: BTreeMap<String, InstanceKey>,
}

impl InstanceTable {
    pub fn build(scene: &Scene) -> Result<InstanceTable, String> {
        let dyn_list = scene.dynamic_list();
        let nprim = scene.primitives.len();
        let mut dyn_of_prim: Vec<Option<usize>> = vec![None; nprim];
        for (di, (_, first, count, _)) in dyn_list.iter().enumerate() {
            for slot in &mut dyn_of_prim[*first..first + count] {
                *slot = Some(di);
            }
        }
        let transforms: Vec<Mat4> = (0..nprim).map(|i| dyn_of_prim[i].map_or(Mat4::IDENTITY, |di| dyn_list[di].3)).collect();
        let masks: Vec<u8> = (0..nprim).map(|i| if dyn_of_prim[i].is_some() { 0x05 } else { 0xff }).collect();
        let is_dynamic: Vec<bool> = (0..nprim).map(|i| dyn_of_prim[i].is_some()).collect();
        let hide_masks: Vec<u8> = (0..nprim).map(|i| if dyn_of_prim[i].is_some() { 0 } else { scene.prim_hide_mask.get(i).copied().unwrap_or(0) }).collect();
        let mut instances: BTreeMap<String, InstanceKey> = BTreeMap::new();
        let mut dyn_insts: Vec<(u32, u32)> = Vec::new();
        let mut dyn_shadow: Vec<Mat4> = Vec::new();
        for (di, (name, first, count, start)) in dyn_list.iter().enumerate() {
            if instances.insert(name.clone(), InstanceKey::from_index(di as u32)).is_some() {
                return Err(format!("dynamic run {name:?}: duplicate name"));
            }
            dyn_insts.push((*first as u32, *count as u32));
            dyn_shadow.push(*start);
        }
        Ok(InstanceTable { transforms, masks, is_dynamic, hide_masks, dyn_insts, dyn_shadow, instances })
    }
}

/// The 2-bank probe-bake light/material emission rule, applied IN PLACE to the
/// CPU light/material shadows. Bank 0 = practicals off EXCEPT screens (their
/// bounce is a constant term in both banks so the room-lights lerp stays exact);
/// bank 1 = everything at its authored base. Materials follow so emissive
/// surfaces read right for the bake rays. `link[i] = (material id or -1, base
/// rgb, screen flag)`.
pub fn bake_bank_emission(bank: i32, link: &[(i32, [f32; 3], bool)], lights: &mut [[f32; 12]], mats: &mut [Material]) {
    for (li, &(mid, base, screen)) in link.iter().enumerate() {
        let c = if bank == 1 || screen { base } else { [0.0; 3] };
        lights[li][4] = c[0];
        lights[li][5] = c[1];
        lights[li][6] = c[2];
        if mid >= 0 {
            mats[mid as usize].emissive = [c[0], c[1], c[2], 1.0];
        }
    }
}

/// Resolve a tagged instance's dollhouse visibility mask for a camera whose
/// near-wall directions are `near` (from `near_hide_bits`): `0x02` (primary-ray
/// see-through, still lit + occluding) iff EVERY tagged side faces the camera,
/// else `0xff`. Single-bit walls hide as soon as their side is near; two-bit
/// corners survive while either adjacent wall run survives (the kept run ends in
/// a capped corner, not an open cross-section). Caller does the buffer patch.
pub fn yaw_instance_mask(bits: u8, near: u8) -> u8 {
    if bits & near == bits {
        0x02
    } else {
        0xff
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::iso::ISO_YAW_DEG;
    use crate::render::near_hide_bits;
    use crate::scene::Scene;

    // ---- ProbeGrid (pure; no Scene needed) -----------------------------------

    #[test]
    fn probe_grid_packs_origin_spacing_dims_header() {
        let (min, max, sp) = (Vec3::new(-2.0, 0.0, -3.0), Vec3::new(2.0, 1.0, 3.0), 0.5);
        let g = ProbeGrid::build(min, max, sp);
        assert_eq!(g.origin, min - Vec3::splat(sp)); // frozen pad at the initial spacing
        assert_eq!(g.spacing, sp); // small scene → no widening
        assert_eq!(g.header[0..3], [g.origin.x, g.origin.y, g.origin.z]);
        assert_eq!(g.header[3], g.spacing);
        assert_eq!(g.header[4..7], [g.dims[0] as f32, g.dims[1] as f32, g.dims[2] as f32]);
        assert_eq!(g.header[7], 0.0); // the pad float
        assert_eq!(g.count, g.dims[0] * g.dims[1] * g.dims[2]);
        assert_eq!(g.header.len(), 16 + g.count as usize * 20 * 2);
    }

    #[test]
    fn probe_grid_widens_spacing_until_under_cap() {
        // a deliberately huge extent + tiny spacing forces several widenings
        let g = ProbeGrid::build(Vec3::splat(-200.0), Vec3::splat(200.0), 0.1);
        assert!(g.count <= PROBE_CAP, "count {} exceeds cap", g.count);
        // spacing landed on initial × 1.25^k
        let k = (g.spacing / 0.1).log(1.25).round() as i32;
        assert!((g.spacing - 0.1 * 1.25f32.powi(k)).abs() < 1e-3);
        assert!(g.dims.iter().all(|&d| d >= 2));
    }

    #[test]
    fn probe_grid_pad_is_frozen_during_widening() {
        // THE divergence regression: even when widening grows `spacing`, the
        // origin must stay min − splat(INITIAL spacing) (the canonical Vulkan
        // form), NOT min − splat(widened spacing) (the old Metal form).
        let (min, init) = (Vec3::splat(-200.0), 0.1);
        let g = ProbeGrid::build(min, Vec3::splat(200.0), init);
        assert!(g.spacing > init, "test needs widening to have occurred");
        assert_eq!(g.origin, min - Vec3::splat(init));
        assert!((g.origin - (min - Vec3::splat(g.spacing))).length() > 1e-3, "origin must NOT use the widened spacing");
    }

    #[test]
    fn probe_grid_handles_zero_extent_via_the_pad() {
        // min == max: the one-spacing pad still gives a valid grid (ext = 2·sp),
        // and the `.max(0.1)` floor guards a sub-0.1 padded extent — no panic,
        // no zero dim.
        let p = Vec3::new(1.0, 2.0, 3.0);
        let g = ProbeGrid::build(p, p, 0.5); // ext = 1.0 → dims = ceil(1.0/0.5)+1 = 3
        assert_eq!(g.dims, [3, 3, 3]);
        assert_eq!(g.count, 27);
        assert!(ProbeGrid::build(p, p, 0.01).dims.iter().all(|&d| d >= 2)); // tiny spacing: floor holds
    }

    // ---- InstanceTable -------------------------------------------------------

    /// floor + static wall (prims 0,1) + two named dynamic runs (prims 2,3) with
    /// names that SORT opposite to registration order (to prove the join follows
    /// run order, not name order); the statics carry a hide bit.
    fn inst_fixture() -> Scene {
        let mut s = Scene::new();
        s.add_floor(-2.0, 2.0, -2.0, 2.0, 0.0, [0.5, 0.5, 0.5, 1.0]); // prim 0 static
        s.add_box_world(Vec3::new(-1.0, 0.0, -1.0), Vec3::new(1.0, 1.0, 1.0), [0.6; 4], [0.0; 4], 0.8, 0.0); // prim 1 static
        let a = s.add_box_local(0.2, 1.0, 0.2, [1.0; 4], [0.0; 4]); // prim 2 dynamic run "zzz"
        let b = s.add_box_local(0.2, 1.0, 0.2, [1.0; 4], [0.0; 4]); // prim 3 dynamic run "aaa"
        s.register_dynamic("zzz", a, 1, Mat4::from_translation(Vec3::X));
        s.register_dynamic("aaa", b, 1, Mat4::from_translation(Vec3::Z));
        s.tag_hide(0, 0x03); // every prim tagged; dynamics get forced back to 0
        s
    }

    #[test]
    fn instance_masks_are_05_dynamic_ff_static() {
        let t = InstanceTable::build(&inst_fixture()).unwrap();
        assert_eq!(t.masks, vec![0xff, 0xff, 0x05, 0x05]);
        assert_eq!(t.is_dynamic, vec![false, false, true, true]);
        // statics identity, dynamics carry their start transform
        assert_eq!(t.transforms[1], Mat4::IDENTITY);
        assert_eq!(t.transforms[2], Mat4::from_translation(Vec3::X));
    }

    #[test]
    fn hide_masks_exclude_dynamics() {
        let t = InstanceTable::build(&inst_fixture()).unwrap();
        assert_eq!(t.hide_masks, vec![0x03, 0x03, 0, 0]); // dynamics (2,3) forced 0
    }

    #[test]
    fn instance_join_is_run_order_not_name_order() {
        let t = InstanceTable::build(&inst_fixture()).unwrap();
        // BTreeMap sorts keys (aaa < zzz) but the KEY→index follows registration
        assert_eq!(t.instances["zzz"], InstanceKey::from_index(0));
        assert_eq!(t.instances["aaa"], InstanceKey::from_index(1));
        assert_eq!(t.dyn_insts, vec![(2, 1), (3, 1)]);
        assert_eq!(t.dyn_shadow[0], Mat4::from_translation(Vec3::X));
    }

    #[test]
    fn duplicate_dynamic_run_name_is_a_loud_error() {
        let mut s = Scene::new();
        let a = s.add_box_local(0.2, 1.0, 0.2, [1.0; 4], [0.0; 4]);
        let b = s.add_box_local(0.2, 1.0, 0.2, [1.0; 4], [0.0; 4]);
        s.register_dynamic("dup", a, 1, Mat4::IDENTITY);
        s.register_dynamic("dup", b, 1, Mat4::IDENTITY);
        assert!(InstanceTable::build(&s).is_err());
    }

    // ---- yaw_instance_mask (pure) --------------------------------------------

    #[test]
    fn yaw_instance_mask_hides_only_when_every_tagged_side_faces_camera() {
        // q=0: camera in +X+Z → near = east(+X,bit0) | south(+Z,bit1) = 0b0011
        let near = near_hide_bits(0);
        assert_eq!(near, 0b0011);
        assert_eq!(yaw_instance_mask(0x01, near), 0x02); // single +X wall: side is near → hide
        assert_eq!(yaw_instance_mask(0x04, near), 0xff); // single -X wall: not near → keep
        assert_eq!(yaw_instance_mask(0x03, near), 0x02); // corner: BOTH sides near → hide
        // a corner whose two sides span a near and a far side survives
        assert_eq!(yaw_instance_mask(0x09, near), 0xff); // +X(near) | -Z(far) → keep
        // consistency with the basis at every quarter
        for q in 0..4u32 {
            let _ = (ISO_YAW_DEG + 90.0 * q as f32).to_radians();
            assert_eq!(yaw_instance_mask(0, near_hide_bits(q)), 0x02); // empty set ⊆ anything
        }
    }

    // ---- bake_bank_emission (pure) -------------------------------------------

    fn mat(emis: [f32; 4]) -> Material {
        Material { base_color: [1.0; 4], emissive: emis, metallic: 0.0, roughness: 0.5, tex_index: -1, _pad: 0 }
    }

    #[test]
    fn bake_bank0_zeros_practicals_except_screens() {
        // link: a non-screen lamp (mid 0), a screen (mid 1), a point light (mid -1)
        let link = vec![(0i32, [8.0f32, 5.0, 2.0], false), (1, [3.0, 4.0, 5.0], true), (-1, [5.0, 4.0, 3.0], false)];
        let mut lights = vec![[0.0f32; 12]; 3];
        let mut mats = vec![mat([8.0, 5.0, 2.0, 1.0]), mat([3.0, 4.0, 5.0, 1.0])];
        bake_bank_emission(0, &link, &mut lights, &mut mats);
        assert_eq!(&lights[0][4..7], &[0.0, 0.0, 0.0]); // non-screen practical off
        assert_eq!(&lights[1][4..7], &[3.0, 4.0, 5.0]); // screen stays on
        assert_eq!(&lights[2][4..7], &[0.0, 0.0, 0.0]); // point light off
        assert_eq!(mats[0].emissive, [0.0, 0.0, 0.0, 1.0]); // material follows
        assert_eq!(mats[1].emissive, [3.0, 4.0, 5.0, 1.0]);
    }

    #[test]
    fn bake_bank1_is_full_base() {
        let link = vec![(0i32, [8.0f32, 5.0, 2.0], false), (1, [3.0, 4.0, 5.0], true)];
        let mut lights = vec![[0.0f32; 12]; 2];
        let mut mats = vec![mat([0.0; 4]), mat([0.0; 4])];
        bake_bank_emission(1, &link, &mut lights, &mut mats);
        assert_eq!(&lights[0][4..7], &[8.0, 5.0, 2.0]); // everything at base
        assert_eq!(&lights[1][4..7], &[3.0, 4.0, 5.0]);
        assert_eq!(mats[0].emissive, [8.0, 5.0, 2.0, 1.0]);
    }

    #[test]
    fn bake_bank_skips_material_for_conceptual_lights() {
        // a point light (mid -1) must touch no material slot (no panic, no index)
        let link = vec![(-1i32, [5.0f32, 4.0, 3.0], false)];
        let mut lights = vec![[0.0f32; 12]; 1];
        let mut mats: Vec<Material> = vec![]; // empty — would panic if mid<0 indexed
        bake_bank_emission(1, &link, &mut lights, &mut mats);
        assert_eq!(&lights[0][4..7], &[5.0, 4.0, 3.0]);
    }
}
