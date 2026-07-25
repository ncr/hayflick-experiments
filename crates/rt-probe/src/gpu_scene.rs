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

    /// Dynamic-GI (Stage 2): the probe index runs whose lattice cells overlap the
    /// world AABB `[min, max]` grown by `pad` wu — the set a targeted refresh
    /// re-bakes when geometry near the box changes (a torn-off roof), instead of
    /// the whole grid.
    ///
    /// A probe index is `pi = x + y·nx + z·nx·ny` (X is the fastest axis — see
    /// the `probes.comp`/`probes.metal` `g = (pi%nx, …)` decode), so a box maps to
    /// ONE contiguous `[lo, hi)` run per (y, z) lattice row. Runs are returned in
    /// ascending index order; the result is empty when the padded box misses the
    /// grid entirely. Every returned index is in-bounds (`< count`), so a caller
    /// can dispatch `first_probe = lo` over `hi − lo` probes with no extra clamp.
    pub fn dirty_probe_runs(&self, min: Vec3, max: Vec3, pad: f32) -> Vec<(u32, u32)> {
        probe_runs(self.origin, self.spacing, self.dims, min, max, pad)
    }
}

/// The lattice bounding box (`lo` inclusive, `hi` exclusive, per axis) of the
/// probes whose cells overlap the world AABB `[min, max]` grown by `pad` — the
/// Stage-2 refresh region as a box, which the probe bake can cover in ONE 3D
/// dispatch (thread `(a,b,c)` → probe `(lo.x+a) + (lo.y+b)·nx + (lo.z+c)·nx·ny`)
/// instead of one dispatch per row. `None` when the padded box misses the grid.
/// Every index it spans is in-bounds.
pub fn probe_box(origin: Vec3, spacing: f32, dims: [u32; 3], min: Vec3, max: Vec3, pad: f32) -> Option<([u32; 3], [u32; 3])> {
    let (o, sp, d) = (origin, spacing, dims);
    // inclusive probe-index span overlapping [lo−pad, hi+pad] on one axis, or
    // None when that slab misses the grid (last probe coord = o + (n−1)·sp).
    let axis = |lo: f32, hi: f32, oc: f32, n: u32| -> Option<(u32, u32)> {
        let (lo, hi) = (lo - pad, hi + pad);
        let gmax = oc + (n as f32 - 1.0) * sp;
        if hi < oc || lo > gmax {
            return None;
        }
        let a = (((lo - oc) / sp).floor().max(0.0) as u32).min(n - 1);
        let b = (((hi - oc) / sp).ceil() as i64).clamp(0, n as i64 - 1) as u32;
        Some((a, b))
    };
    let (Some((ix0, ix1)), Some((iy0, iy1)), Some((iz0, iz1))) = (axis(min.x, max.x, o.x, d[0]), axis(min.y, max.y, o.y, d[1]), axis(min.z, max.z, o.z, d[2])) else {
        return None;
    };
    Some(([ix0, iy0, iz0], [ix1 + 1, iy1 + 1, iz1 + 1]))
}

/// How far, in probe SPACINGS, a LOCAL refresh grows each dirty world AABB
/// before mapping it onto the lattice. Shared by both backends so the twins
/// cannot drift.
///
/// The FIRST spacing is structural: the shade pass's `probeE` (shade.comp:132 /
/// shade.metal:164) trilerps the 8 probes around the shading point pushed
/// 0.3·spacing along its normal, so every probe that LIGHTS a surface inside the
/// dirty box lies within one spacing of it — refresh less and the new geometry is
/// lit by probes that never saw it. The rest is the BOUNCE halo: probes further
/// out still SEE the changed surface, and carrying their old value leaves a
/// residue that decays with distance. AO plays no part — the RT-AO radius is a
/// shade-pass ray budget, not a probe footprint.
///
/// Three because the halo is nearly FREE. Measured on the M2 Pro (crack lab,
/// pier 7 re-knobbed, diffed against a full rebake of the identical scene —
/// docs/CRACKS_PLAN_2026-07-25.md task 3 step 2):
///
/// | pad | probes | refresh | pixels differing from a full rebake |
/// |-----|--------|---------|------------------------------------|
/// | 1   | 680 (7 %)   | 3091 ms | 2.58 %, max delta 1/255 |
/// | 2   | 1064 (11 %) | 3452 ms | 1.68 %, max delta 1/255 |
/// | 3   | 1512 (16 %) | 3334 ms | 0.96 %, max delta 1/255 |
///
/// The cost barely moves because a refresh is LATENCY-bound (see
/// [`LOCAL_REFRESH_MAX_FRACTION`]) — each thread serially casts 2048 rays × 2
/// banks whatever the box size — while the residue keeps falling, so buy the
/// halo. The residue never reaches zero (a probe at any distance sees the wall)
/// and at every pad it is 1 LSB, on GRASS texels where the dither flips, never on
/// the rebuilt wall itself.
///
/// Do NOT raise this without re-checking [`LOCAL_REFRESH_MAX_FRACTION`]: one
/// 6-wu pier already covers 16 % of the gym grid at pad 3, and a pad that pushes
/// a single pier past the fraction cap silently disables the whole fast path.
pub const REFRESH_PAD_SPACINGS: f32 = 3.0;

// MEASURED RESIDUE (M2, review pass 2026-07-25 — the earlier "1 LSB, on grass
// texels only" claim was wrong and is corrected here): a locally refreshed frame
// differs from a fully re-baked one by 0.4-1.0% of pixels at 1 LSB, with a tail
// up to ~23/255 on CONTOUR texels, where the posterize/AA quantizers amplify a
// sub-LSB irradiance difference into a visible step. It varies run to run. So the
// local path is right for INTERACTIVE dialing, and any capture that has to be
// comparable — a golden, a clip, a before/after pair — must be taken from a boot
// or a full rebuild (PROBE_LOCAL=0), never across a knob release.

/// Lattice boxes for a LOCAL probe refresh over the dirty world AABBs `dirty`
/// (the geometry a rebuild actually changed), each grown by
/// [`REFRESH_PAD_SPACINGS`] spacings.
///
/// `None` = do a FULL bake instead, for either of the two reasons a local refresh
/// must not be attempted: a dirty region misses the grid (nothing would be
/// refreshed and the change would sit there stale), or the dirty set is too large
/// to be worth it ([`LOCAL_REFRESH_MAX_FRACTION`] — the bake is both faster and
/// exact everywhere past that point).
///
/// Overlapping boxes are merged into their bounding union, but ONLY when the
/// union costs no more probes than the pair did (two L-arranged piers overlap in
/// all three axes while their union covers the whole corner, so a blind merge
/// can cost far more than the double-bake it saves). A probe baked twice is
/// harmless — the refresh re-runs the SAME ray sequence, so sums and count both
/// double and the estimate `sums·4π/count` is unchanged — it is only paid twice.
pub fn refresh_boxes_for(origin: Vec3, spacing: f32, dims: [u32; 3], dirty: &[(Vec3, Vec3)]) -> Option<Vec<([u32; 3], [u32; 3])>> {
    // An EMPTY dirty set is NOT "nothing to refresh" — it is "we do not know
    // what moved", and carrying the old bank on that would adopt the previous
    // scene's whole frozen GI with zero probes rebuilt. Decline it here, once,
    // so neither backend has to remember (review finding, 2026-07-25).
    if dirty.is_empty() {
        return None;
    }
    let pad = spacing * REFRESH_PAD_SPACINGS;
    let mut out: Vec<([u32; 3], [u32; 3])> = Vec::with_capacity(dirty.len());
    for &(min, max) in dirty {
        out.push(probe_box(origin, spacing, dims, min, max, pad)?);
    }
    let n = |b: &([u32; 3], [u32; 3])| (b.1[0] - b.0[0]) * (b.1[1] - b.0[1]) * (b.1[2] - b.0[2]);
    // merge while a pair overlaps AND the union is not more expensive; each merge
    // drops one box, so this terminates.
    'merge: loop {
        for i in 0..out.len() {
            for j in i + 1..out.len() {
                let (a, b) = (out[i], out[j]);
                let overlap = (0..3).all(|k| a.0[k] < b.1[k] && b.0[k] < a.1[k]);
                let u = ([0, 1, 2].map(|k| a.0[k].min(b.0[k])), [0, 1, 2].map(|k| a.1[k].max(b.1[k])));
                if overlap && n(&u) <= n(&a) + n(&b) {
                    out[i] = u;
                    out.remove(j);
                    continue 'merge;
                }
            }
        }
        break;
    }
    (probes_in(&out) as f32 <= (dims[0] * dims[1] * dims[2]) as f32 * LOCAL_REFRESH_MAX_FRACTION).then_some(out)
}

/// Probes covered by a set of lattice boxes (the local refresh's cost, for the
/// backends' timing print). Overlaps count twice — that IS what gets baked.
pub fn probes_in(boxes: &[([u32; 3], [u32; 3])]) -> u32 {
    boxes.iter().map(|b| (b.1[0] - b.0[0]) * (b.1[1] - b.0[1]) * (b.1[2] - b.0[2])).sum()
}

/// Above this fraction of the grid, a local refresh costs MORE than a full bake,
/// so the backends decline it (and the bake is exact everywhere — strictly
/// better).
///
/// A refresh is not linear work: one thread per probe means a small dispatch
/// cannot fill the GPU, so its rays cost far more each. Measured on the M2 Pro
/// (9672 probes, 2048 rays × 2 banks, 2026-07-25), rays/s by dispatch width:
/// 281 threads 1.4 M, 680 → 0.9 M, 1064 → 1.3 M, 1512 → 1.9 M, 9672 → 6.7 M —
/// i.e. the whole grid as ONE box runs at 0.62 ms/probe, the same as the startup
/// bake's 0.66, while a one-pier box runs at ~3 ms/probe. Forcing the bake's
/// 20-rays-per-dispatch batch onto the small box changed nothing (3534 vs
/// 3451 ms), which is how the cause was pinned on occupancy rather than dispatch
/// count. So: below saturation a refreshed probe costs ~5× a baked one, and
/// 9672 × 0.66 ms of bake buys about 2000 refreshed probes ≈ 1/5 of the grid.
/// One re-knobbed crack-lab pier is 16 % (see [`REFRESH_PAD_SPACINGS`]); two
/// dirty piers already pay more than the bake.
pub const LOCAL_REFRESH_MAX_FRACTION: f32 = 0.2;

/// Free-function core of [`ProbeGrid::dirty_probe_runs`] (see it for the
/// contract) — the memory-layout view of [`probe_box`]: one contiguous `[lo,
/// hi)` probe-index run per (y, z) row of the box (X is the fastest axis). The
/// backends use the box for the DISPATCH and these runs for the reset memset.
pub fn probe_runs(origin: Vec3, spacing: f32, dims: [u32; 3], min: Vec3, max: Vec3, pad: f32) -> Vec<(u32, u32)> {
    let Some((lo, hi)) = probe_box(origin, spacing, dims, min, max, pad) else {
        return Vec::new();
    };
    let (nx, ny) = (dims[0], dims[1]);
    let mut runs = Vec::with_capacity(((hi[1] - lo[1]) * (hi[2] - lo[2])) as usize);
    for iz in lo[2]..hi[2] {
        for iy in lo[1]..hi[1] {
            let base = iy * nx + iz * nx * ny;
            runs.push((base + lo[0], base + hi[0])); // [lo, hi)
        }
    }
    runs
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
    /// `0xff` static. Walls are seen through per-pixel on the primary ray by the
    /// CAVE_ROI reveal in shade.comp — there is no per-yaw instance hiding.
    pub masks: Vec<u8>,
    /// Explicit dynamic flag. Do NOT infer dynamics from `masks[i] & 0x04` —
    /// `0xff & 0x04 != 0`, so statics would falsely test dynamic.
    pub is_dynamic: Vec<bool>,
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
        Ok(InstanceTable { transforms, masks, is_dynamic, dyn_insts, dyn_shadow, instances })
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


#[cfg(test)]
mod tests {
    use super::*;
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

    // ---- dirty_probe_runs (Stage-2 targeted refresh) -------------------------

    /// A grid with probe coords {−1,0,1,2,3} on each axis (5³ = 125), so index
    /// arithmetic is easy to check by hand: pi = x + 5y + 25z, x fastest.
    fn runs_grid() -> ProbeGrid {
        let g = ProbeGrid::build(Vec3::ZERO, Vec3::splat(2.0), 1.0);
        assert_eq!(g.dims, [5, 5, 5]);
        assert_eq!(g.origin, Vec3::splat(-1.0));
        g
    }

    #[test]
    fn dirty_runs_single_probe_is_one_run() {
        // a point box at world origin (probe coord 0 = lattice index 1 on each
        // axis) with no pad → exactly probe 1 + 5 + 25 = 31.
        let g = runs_grid();
        let runs = g.dirty_probe_runs(Vec3::ZERO, Vec3::ZERO, 0.0);
        assert_eq!(runs, vec![(31, 32)]);
    }

    #[test]
    fn dirty_runs_are_contiguous_x_runs_one_per_yz_row() {
        // span x∈[0,2] (lattice x 1..=3), y = z = 0 (lattice 1): one run of 3.
        let g = runs_grid();
        let runs = g.dirty_probe_runs(Vec3::new(0.0, 0.0, 0.0), Vec3::new(2.0, 0.0, 0.0), 0.0);
        let base = 5 + 25; // y=1 (·5) + z=1 (·25)
        assert_eq!(runs, vec![(base + 1, base + 4)]); // x 1..=3 → [31,34)
        // widen to a 3×2 (y,z) block → 6 runs, still 3-wide in x, ascending.
        let runs = g.dirty_probe_runs(Vec3::new(0.0, 0.0, 0.0), Vec3::new(2.0, 2.0, 1.0), 0.0);
        assert_eq!(runs.len(), 3 * 2); // y 1..=3, z 1..=2
        assert!(runs.windows(2).all(|w| w[0].0 < w[1].0), "runs ascending");
        assert!(runs.iter().all(|&(lo, hi)| hi - lo == 3));
        assert!(runs.iter().all(|&(_, hi)| hi <= g.count), "in bounds");
    }

    #[test]
    fn dirty_runs_pad_grows_the_span_and_clamps_to_grid() {
        let g = runs_grid();
        // point at origin, pad 1.0 → lattice x 0..=2 (coords −1,0,1) each axis.
        let runs = g.dirty_probe_runs(Vec3::ZERO, Vec3::ZERO, 1.0);
        assert_eq!(runs.len(), 3 * 3); // 3 in y × 3 in z
        assert_eq!(runs[0], (0, 3)); // z0,y0 row: x 0..=2 → [0,3)
        // a box past the +edge clamps, never exceeds count.
        let runs = g.dirty_probe_runs(Vec3::splat(3.0), Vec3::splat(9.0), 0.0);
        assert!(runs.iter().all(|&(lo, hi)| lo < g.count && hi <= g.count));
    }

    #[test]
    fn dirty_runs_empty_when_box_misses_the_grid() {
        let g = runs_grid();
        // entirely below the grid on X (grid X ∈ [−1,3]); even with pad it misses.
        assert!(g.dirty_probe_runs(Vec3::new(-10.0, 0.0, 0.0), Vec3::new(-5.0, 0.0, 0.0), 0.5).is_empty());
    }

    #[test]
    fn probe_box_matches_the_runs_it_expands_to() {
        let g = runs_grid();
        // point at origin, pad 1.0 → lattice 0..=2 on each axis → box [0,0,0]..[3,3,3]
        let (lo, hi) = probe_box(g.origin, g.spacing, g.dims, Vec3::ZERO, Vec3::ZERO, 1.0).unwrap();
        assert_eq!((lo, hi), ([0, 0, 0], [3, 3, 3]));
        // the box's dispatch footprint (Π widths) equals the probes the runs cover
        let box_probes: u32 = (hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2]);
        let run_probes: u32 = g.dirty_probe_runs(Vec3::ZERO, Vec3::ZERO, 1.0).iter().map(|&(a, b)| b - a).sum();
        assert_eq!(box_probes, run_probes);
        // a miss returns None (the runs version returns empty)
        assert!(probe_box(g.origin, g.spacing, g.dims, Vec3::splat(-10.0), Vec3::splat(-9.0), 0.0).is_none());
    }

    /// The LOCAL-refresh box set: every dirty AABB grown by the shared pad,
    /// overlaps merged only when the union is not more expensive, and both
    /// veto paths (a region off the grid, a dirty set too big to pay for)
    /// returning `None` so the caller rebakes instead of leaving probes stale.
    #[test]
    fn refresh_boxes_merge_only_when_the_union_is_cheaper() {
        // gym-sized grid (33³ = 35937 probes) so the padded boxes below stay a
        // small fraction of it — the fraction veto has its own case at the end.
        let g = ProbeGrid::build(Vec3::ZERO, Vec3::splat(30.0), 1.0);
        let pad = g.spacing * REFRESH_PAD_SPACINGS;
        let one_box = |min, max| probe_box(g.origin, g.spacing, g.dims, min, max, pad).unwrap();
        let boxes = |dirty: &[(Vec3, Vec3)]| refresh_boxes_for(g.origin, g.spacing, g.dims, dirty);
        // one region → exactly probe_box with the shared pad
        let one = boxes(&[(Vec3::ZERO, Vec3::ZERO)]).unwrap();
        assert_eq!(one, vec![one_box(Vec3::ZERO, Vec3::ZERO)]);
        // two coincident regions collapse to one box (the union IS either box)
        let two = boxes(&[(Vec3::ZERO, Vec3::ZERO), (Vec3::ZERO, Vec3::ZERO)]).unwrap();
        assert_eq!(two, one, "coincident dirty regions merge");
        // a contained region merges into its container
        let inner = boxes(&[(Vec3::ZERO, Vec3::splat(4.0)), (Vec3::ONE, Vec3::splat(2.0))]).unwrap();
        assert_eq!(inner, vec![one_box(Vec3::ZERO, Vec3::splat(4.0))]);
        // an L — two thin walls meeting at a corner. Their padded boxes overlap in
        // all three axes, but the union is the whole corner block, so they stay
        // apart: a double-baked probe is cheaper than filling the L's empty arm.
        let arm_x = (Vec3::ZERO, Vec3::new(10.0, 0.0, 0.0));
        let arm_y = (Vec3::new(10.0, 0.0, 0.0), Vec3::new(10.0, 10.0, 0.0));
        let l = boxes(&[arm_x, arm_y]).unwrap();
        assert_eq!(l.len(), 2, "an L must not merge into its bounding block");
        assert!(probes_in(&l) < probes_in(&[one_box(Vec3::ZERO, Vec3::new(10.0, 10.0, 0.0))]), "…because the union costs more");
        // a region off the grid vetoes the local path entirely
        assert!(boxes(&[(Vec3::ZERO, Vec3::ZERO), (Vec3::splat(-50.0), Vec3::splat(-49.0))]).is_none());
        // so does a dirty set past LOCAL_REFRESH_MAX_FRACTION (here: the whole grid)
        assert!(boxes(&[(Vec3::ZERO, Vec3::splat(30.0))]).is_none(), "a level-sized dirty set must rebake, not refresh");
        assert!(boxes(&[]).is_none(), "an empty dirty set means UNKNOWN, so it must decline to a full bake");
    }

    // ---- InstanceTable -------------------------------------------------------

    /// floor + static wall (prims 0,1) + two named dynamic runs (prims 2,3) with
    /// names that SORT opposite to registration order (to prove the join follows
    /// run order, not name order).
    fn inst_fixture() -> Scene {
        let mut s = Scene::new();
        s.add_floor(-2.0, 2.0, -2.0, 2.0, 0.0, [0.5, 0.5, 0.5, 1.0]); // prim 0 static
        s.add_box_world(Vec3::new(-1.0, 0.0, -1.0), Vec3::new(1.0, 1.0, 1.0), [0.6; 4], [0.0; 4], 0.8, 0.0); // prim 1 static
        let a = s.add_box_local(0.2, 1.0, 0.2, [1.0; 4], [0.0; 4]); // prim 2 dynamic run "zzz"
        let b = s.add_box_local(0.2, 1.0, 0.2, [1.0; 4], [0.0; 4]); // prim 3 dynamic run "aaa"
        s.register_dynamic("zzz", a, 1, Mat4::from_translation(Vec3::X));
        s.register_dynamic("aaa", b, 1, Mat4::from_translation(Vec3::Z));
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
