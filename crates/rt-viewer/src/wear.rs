//! The per-surface EFFECT WORD — the wear family's material budget.
//!
//! The aging catalogue (docs/CRACKS_PLAN_2026-07-25.md task 3, owner-approved
//! 2026-07-25) needs per-SURFACE appearance dials the shade pass can read per
//! pixel: how long ago this surface was exposed, how damp it is, which facade's
//! story it belongs to. `Material` is 48 B with every field consumed — except
//! the two ALPHA channels. Grepped exhaustively across all four kernels
//! (shade + probes × GLSL/MSL): `baseColor` and `emissive` appear only as
//! `.rgb`/`.xyz`, so both alphas are free real estate, and the whole material
//! array re-uploads every frame, so writing them is free at runtime too.
//!
//! This module is the ONE codec for one of them. The split, and the single
//! source of truth for the host and both shader twins:
//!
//! | channel | holds | written by |
//! |---|---|---|
//! | `Material.emissive[3]` | the EFFECT WORD — four 6-bit unorm dials | [`stamp_all`] |
//! | `Material.base_color[3]` | the facade STORY KEY (one f32, raw) | [`stamp_story`] |
//!
//! An f32 holds integers exactly only up to 2^24, so **24 bits is the honest
//! budget** for a bit-packed float — four 6-bit dials fill it EXACTLY and
//! nothing else fits. That is why the story key does not squat here: it takes
//! the other free alpha, where it needs no unpack in the shader at all (one
//! fewer host/shader mirror) and is inherited for free by every chalk core
//! (`crack_geom::chalk_material` copies `base_color` verbatim).
//!
//! Layout (the same discipline as [`crate::crack::pad_bits`] for `_pad`): dial
//! `i` is a 6-bit unorm at bit `6·i`.
//! - lane 0 — **EPOCH**: how long ago this surface was exposed (0 = fresh
//!   break … 1 = as weathered as the skin around it). Claimed by the
//!   catalogue's "fresh break vs weathered skin", whose first half landed
//!   2026-07-25 with the epoch still hard-wired: the shade pass's CRACK LAB
//!   block computes `float skin` (0 on a chalk core, 1 on the glaze) and gates
//!   the stains + the fine web with it. Wiring this lane in means replacing
//!   that select with the decoded epoch — one expression per twin, and the
//!   float shape is already there so old craters can stain again.
//! - lanes 1..3 — **UNCLAIMED**. The effect that takes one names it HERE, in
//!   this comment, so two effects can never quietly land on the same bits.
//!
//! The unpack both shader twins must copy verbatim (GLSL below; MSL is `.w`
//! for `.a`, `as_type`-free — plain `uint(m.emissive.w)`):
//!
//! ```glsl
//! uint  ew    = uint(m.emissive.a);            // the effect word
//! float epoch = float( ew        & 63u) * (1.0/63.0);
//! float lane1 = float((ew >>  6) & 63u) * (1.0/63.0);
//! float lane2 = float((ew >> 12) & 63u) * (1.0/63.0);
//! float lane3 = float((ew >> 18) & 63u) * (1.0/63.0);
//! ```
//!
//! Two invariants the codec is built around:
//!
//! - **The empty word is EXACTLY 0.0** — which is what `add_box_world` already
//!   leaves in a pier's emissive alpha, so an unaged scene stays bit-identical
//!   and a lane read on an untouched surface returns 0, not garbage.
//! - **The word never rides an EMITTING material.** `frame_lights_cpu`
//!   (rt-probe render.rs) rewrites `emissive` WHOLE — `[r, g, b, 1.0]` — every
//!   frame for every light-linked material, so a word parked on a lamp would be
//!   clobbered per frame; and conversely a lamp's 1.0 alpha decodes as
//!   epoch = 1/63, so a shader gate must key off a `_pad` FLAG bit (bit 4,
//!   value 16, is the last free one) and NEVER off `emissive.a != 0`.
//!   [`stamp`] asserts the material does not emit, so that can only be got
//!   wrong loudly.
//!
//! And one rule about WHERE it is written: the word streams POST-BUILD only
//! ([`Viewer::wear_stamp`]). The probe-cache content key hashes the whole
//! material array (metal_backend.rs `probe_key`), so stamping the word into the
//! `Scene` before the backend consumes it would re-key the cache and buy a
//! ~6.5 s rebake on the M2 for a datum the bake cannot even see. Streaming it
//! after the build is one buffer write and shows next frame.
//!
//! # The STORY KEY (`base_color[3]`)
//!
//! [`story_key`] hashes the pier's parent RUN — the authored wall slab it was
//! cut out of ([`Pier::run_lo`]/`run_hi`) — into one float, and [`stamp_story`]
//! writes it onto every pier's material. It is the seed of everything that
//! must be TRUE OF THE WHOLE FACADE rather than of one panel: the macro damage
//! field, the craze lattices, the age ramp. Before it, `crack_geom::seg_of` and
//! the shade pass both seeded those off `material_id & 255` — a per-PANEL seed —
//! which is exactly why 12 piers of one building read as a pile of independently
//! aged slabs (owner catalogue 2026-07-25, "one wall, one story").
//!
//! Three properties, all deliberate:
//!
//! - **Raw, not packed.** The shade pass reads `m.baseColor.a` and uses it as a
//!   seed directly — no unpack, and no host/shader float mirror to keep in sync
//!   for this term at all (one fewer mirror than the `seg` it replaces).
//! - **Written PRE-BUILD**, into the `Scene`, unlike the effect word: the HOST
//!   geometry pass (`crack_geom`) must read the same key the shader will, and it
//!   runs before the backend exists. That does re-key the probe cache, so the
//!   first boot of each cached crack-lab state re-bakes once — a one-time cost,
//!   the same one `fresh_body` already paid.
//! - **Inherited by chalk cores for free**: `crack_geom::chalk_material` copies
//!   `base_color` verbatim and `fresh_body` passes alpha through, so the surface
//!   a crack EXPOSED carries its facade's story without a second stamp.

use crate::gym_scene::Pier;
use crate::viewer::Viewer;
use glam::Vec3;
use rt_probe::Scene;

/// The STORY KEY of a wall RUN: one seed shared by every pier the run was cut
/// into. A pure function of the AUTHORED slab (`Pier::run_lo`/`run_hi`), so the
/// three panels of one facade agree while the facade round the corner — a
/// different `wall_slab` call, a different rect — does not.
///
/// Quantized to the 0.1-wu authoring grid (the game projection's lattice: see
/// the pixel-perfect contract) before hashing, so the key can never wobble on a
/// float-exact rebuild. `y` is not hashed: every authored run spans 0..WALL_TOP,
/// so it carries no identity.
///
/// The value is `(hash & 255) × 0.618` — DELIBERATELY the same distribution and
/// 0..157.5 range as the `(material_id & 255) × 0.618` per-panel seed it
/// replaces, so every field seeded off it (`story*7+3` for the damage fbm,
/// `story+5`/`story+9` for the craze lattices) lands in the numeric regime those
/// fields were tuned in. A low-byte collision would merely give two facades the
/// same story, which is harmless; the gym's runs are pinned distinct by a test.
pub fn story_key(run_lo: Vec3, run_hi: Vec3) -> f32 {
    let mut h: u32 = 0x811c_9dc5;
    for v in [run_lo.x, run_lo.z, run_hi.x, run_hi.z] {
        h ^= (v * 10.0).round() as i32 as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    (h & 255) as f32 * 0.618
}

/// Write every pier's run STORY KEY into its material's `base_color[3]`.
///
/// Runs on the CPU `Scene` BEFORE the geometry pass (`crack::resolve`), because
/// `crack_geom` seeds its damage field off the same key the shade pass reads —
/// host and shader must agree or the paint and the plates drift apart. Returns
/// how many materials it wrote, for the boot line.
pub fn stamp_story(scene: &mut Scene, piers: &[Pier]) -> usize {
    for pier in piers {
        let mid = scene.primitives[pier.prim].material_id as usize;
        scene.materials[mid].base_color[3] = story_key(pier.run_lo, pier.run_hi);
    }
    piers.len()
}

/// Dials in one effect word: 4 × 6 bits = the whole 24-bit budget.
pub const DIALS: usize = 4;

/// Bits per dial. 6 is the crack-lab knobs' grain (`pad_bits`) and it is
/// already finer than the tonemap's luma quantize can show at 704×464.
const DIAL_BITS: u32 = 6;
const DIAL_MAX: f32 = 63.0;

/// One surface's appearance dials, unpacked. Plain data — lanes are named in
/// the module doc's layout table, which is the single source of truth.
#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub struct Effect {
    pub dials: [f32; DIALS],
}

impl Effect {
    /// Pack to the float that rides `Material.emissive[3]`. Exact by
    /// construction: the packed integer is < 2^24.
    pub fn word(self) -> f32 {
        let mut b = 0u32;
        for (i, v) in self.dials.iter().enumerate() {
            b |= ((v.clamp(0.0, 1.0) * DIAL_MAX).round() as u32) << (DIAL_BITS * i as u32);
        }
        b as f32
    }

    /// The shader-side unpack, host-mirrored — the layout-pin test's other half
    /// (same role as `crack::unpack`).
    #[cfg(test)]
    pub fn decode(word: f32) -> Effect {
        let b = word as u32;
        let mut dials = [0.0; DIALS];
        for (i, d) in dials.iter_mut().enumerate() {
            *d = ((b >> (DIAL_BITS * i as u32)) & (DIAL_MAX as u32)) as f32 / DIAL_MAX;
        }
        Effect { dials }
    }
}

/// Write one material's effect word. Returns the encoded word only when it
/// CHANGED, so a live caller streams exactly what moved (and an empty word on a
/// fresh scene writes nothing at all).
pub fn stamp(scene: &mut Scene, material_id: usize, e: Effect) -> Option<f32> {
    let w = e.word();
    let m = &mut scene.materials[material_id];
    if m.emissive[3] == w {
        return None; // nothing to stream (and an empty word on a fresh scene never writes)
    }
    // Only a stamp that actually PARKS a word has to care: `frame_lights_cpu`
    // rewrites a light-linked material's emissive whole every frame, so the word
    // would be clobbered and the lamp would decode as a live dial. (The check
    // sits after the no-op return so the unconditional boot stamp of an empty
    // word cannot trip it — review finding, 2026-07-25.)
    assert_eq!(
        [m.emissive[0], m.emissive[1], m.emissive[2]],
        [0.0; 3],
        "material {material_id} EMITS: the effect word must not ride a light-linked material — frame_lights_cpu rewrites emissive whole every frame"
    );
    m.emissive[3] = w;
    Some(w)
}

/// Stamp one word onto every wall pier AND its chalk core, returning the
/// changed `(material, word)` pairs — the same shape as `crack::stamp_aa`, for
/// the same reason: the caller streams the difference and nothing else.
///
/// The core comes along because it IS the surface the damage exposed (groove
/// floors, recesses, spall basins), and every lane the catalogue claims so far
/// is a property of exposed material. `cores` is the crack lab's per-pier core
/// list (`-1` = the pier was left pristine), passed as plain ids so this module
/// does not depend on the lab.
pub fn stamp_all(scene: &mut Scene, piers: &[Pier], cores: &[i32], e: Effect) -> Vec<(usize, f32)> {
    let mut out = Vec::new();
    for (i, pier) in piers.iter().enumerate() {
        let core = cores.get(i).copied().filter(|c| *c >= 0);
        for mid in [Some(scene.primitives[pier.prim].material_id), core].into_iter().flatten() {
            if let Some(w) = stamp(scene, mid as usize, e) {
                out.push((mid as usize, w));
            }
        }
    }
    out
}

/// `WEAR=d0[,d1,d2,d3]` — the wear family's harness seed (a shell-only env
/// read, like LOOK/PROJ/CRACKS; see the config.rs exception list): stamp every
/// pier uniformly at boot, so a headless SHOT can drive a lane the moment a
/// shader twin reads one. Missing components read 0; unset = no word at all.
pub fn seed_from_env() -> Option<Effect> {
    std::env::var("WEAR").ok().map(|v| parse_seed(&v))
}

/// The pure half of [`seed_from_env`].
fn parse_seed(v: &str) -> Effect {
    let parts: Vec<&str> = v.split(',').map(str::trim).collect();
    let mut dials = [0.0; DIALS];
    for (i, d) in dials.iter_mut().enumerate() {
        *d = parts.get(i).and_then(|s| s.parse::<f32>().ok()).unwrap_or(0.0);
    }
    Effect { dials }
}

impl Viewer {
    /// Re-derive every pier's EFFECT WORD against the current scene and push
    /// what changed to the backend's live material stream (visible next frame,
    /// nothing rebuilds, nothing rebakes). Called at boot and after every
    /// `apply_look` rebuild — the rebuild mints fresh materials, so the word
    /// has to be re-stamped exactly like the AA scope bits are.
    pub fn wear_stamp(&mut self) {
        let changed = stamp_all(&mut self.scene, &self.piers, &self.crack.cores, self.wear);
        // silent for an empty word (nothing changed — the default gym boot); a
        // WEAR= run says so, because until a shader twin reads a lane the stamp
        // has no other observable effect and a harness knob you cannot see fire
        // is a harness knob you cannot trust.
        if let Some((_, w)) = changed.first() {
            println!("wear: effect word {w} (dials {:?}) streamed to {} materials", self.wear.dials, changed.len());
        }
        for (mid, w) in changed {
            self.backend.set_material_effect(mid, w);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use glam::Vec3;

    /// THE layout pin: the bit positions the shader twins unpack, the exact-zero
    /// empty word, and 6-bit round-trip grain.
    #[test]
    fn word_layout_matches_the_shader_unpack() {
        assert_eq!(Effect::default().word(), 0.0, "the empty word is EXACTLY 0.0 (an untouched scene stays bit-identical)");
        assert!(Effect::default().word().to_bits() == 0, "…and it is +0.0, not -0.0");
        let lane = |i: usize| {
            let mut e = Effect::default();
            e.dials[i] = 1.0;
            e.word()
        };
        assert_eq!(lane(0), 63.0);
        assert_eq!(lane(1), (63u32 << 6) as f32);
        assert_eq!(lane(2), (63u32 << 12) as f32);
        assert_eq!(lane(3), (63u32 << 18) as f32);
        // the full word stays inside the f32 exact-integer range (2^24)
        let full = Effect { dials: [1.0; DIALS] }.word();
        assert_eq!(full, ((1u32 << 24) - 1) as f32, "four 6-bit dials fill the 24-bit budget exactly");
        assert_eq!(full as u32 as f32, full, "…and every word is an exactly representable integer");
        // round trip at 6-bit grain
        let e = Effect { dials: [0.55, 0.30, 0.80, 0.15] };
        for (a, b) in Effect::decode(e.word()).dials.iter().zip(e.dials) {
            assert!((a - b).abs() <= 0.5 / DIAL_MAX, "{a} vs {b}");
        }
        // clamped, not wrapped: an out-of-range dial must never bleed into its neighbour
        let over = Effect { dials: [2.0, 0.0, 0.0, 0.0] }.word();
        assert_eq!(over, 63.0);
    }

    fn pier_scene() -> (Scene, Vec<Pier>) {
        let mut scene = Scene::default();
        let mut piers = Vec::new();
        for i in 0..2 {
            let (lo, hi) = (Vec3::new(i as f32 * 4.0, 0.0, 9.9), Vec3::new(i as f32 * 4.0 + 3.0, 2.2, 10.15));
            scene.add_box_world(lo, hi, [0.9, 0.9, 0.9, 1.0], [0.0; 4], 0.85, 0.0);
            piers.push(Pier { prim: scene.primitives.len() - 1, lo, hi, run_lo: lo, run_hi: hi });
        }
        (scene, piers)
    }

    /// The stamp writes piers AND their chalk cores, and reports only what
    /// changed — so an empty word on a fresh scene is zero GPU traffic.
    #[test]
    fn stamp_all_writes_piers_and_cores_and_reports_only_changes() {
        let (mut scene, piers) = pier_scene();
        // pier 0 has a chalk core (a clone of its material), pier 1 does not
        let body = scene.materials[scene.primitives[piers[0].prim].material_id as usize];
        scene.materials.push(body);
        let cores = vec![scene.materials.len() as i32 - 1, -1];
        assert!(stamp_all(&mut scene, &piers, &cores, Effect::default()).is_empty(), "the empty word is already there — nothing to stream");
        let e = Effect { dials: [0.5, 0.0, 0.0, 0.25] };
        let changed = stamp_all(&mut scene, &piers, &cores, e);
        assert_eq!(changed.len(), 3, "two piers + one core");
        for (mid, w) in &changed {
            assert_eq!(scene.materials[*mid].emissive[3], *w, "the CPU shadow and the streamed value agree");
            assert_eq!(*w, e.word());
        }
        assert!(stamp_all(&mut scene, &piers, &cores, e).is_empty(), "re-stamping the same word streams nothing");
    }

    /// The lamp trap, pinned: `frame_lights_cpu` owns an emitting material's
    /// whole emissive vector, so the word may never ride one.
    #[test]
    #[should_panic(expected = "EMITS")]
    fn the_word_refuses_an_emitting_material() {
        let (mut scene, piers) = pier_scene();
        let mid = scene.primitives[piers[0].prim].material_id as usize;
        scene.materials[mid].emissive = [2.0, 1.6, 1.0, 1.0]; // a lamp lantern
        stamp(&mut scene, mid, Effect { dials: [0.5; DIALS] });
    }

    /// THE STORY KEY over the REAL gym: every pier of one authored run shares a
    /// key (that sharing IS the effect — a damage patch crosses a panel joint
    /// because both panels seed their field off the same float), every run has
    /// its own (or two facades would age identically, which is the same "pile of
    /// passes" tell from the other side), and the doorway's two half-runs count
    /// as two facades. Built rather than synthetic because the thing under test
    /// is exactly how `wall_slab` groups piers.
    #[test]
    fn the_gyms_runs_each_get_their_own_story() {
        let spec = house_game::gym::sim::gym_level();
        let (mut scene, meta) = crate::gym_scene::build_gym(&spec, &crate::look::POLANA, true);
        assert_eq!(stamp_story(&mut scene, &meta.piers), meta.piers.len());
        // group the piers by their authored run rect, then by the stamped key
        let mut runs: Vec<([i32; 4], f32)> = Vec::new();
        for pier in &meta.piers {
            let q = |v: f32| (v * 10.0).round() as i32;
            let rect = [q(pier.run_lo.x), q(pier.run_lo.z), q(pier.run_hi.x), q(pier.run_hi.z)];
            let key = scene.materials[scene.primitives[pier.prim].material_id as usize].base_color[3];
            assert_eq!(key, story_key(pier.run_lo, pier.run_hi), "the stamp writes the key the readers recompute");
            match runs.iter().find(|(r, _)| *r == rect) {
                Some((_, k)) => assert_eq!(*k, key, "piers of one run share one story"),
                None => runs.push((rect, key)),
            }
        }
        assert!(runs.len() >= 6, "the gym has 5 building runs + 2 garden walls, got {}", runs.len());
        assert!(runs.iter().any(|(_, k)| *k != runs[0].1), "the runs cannot all share one story");
        let mut keys: Vec<u32> = runs.iter().map(|(_, k)| k.to_bits()).collect();
        keys.sort_unstable();
        keys.dedup();
        assert_eq!(keys.len(), runs.len(), "every run of the gym must get a DISTINCT key (a low-byte collision would merge two facades' stories)");
    }

    /// `WEAR=` parsing: leading components in lane order, missing tails read 0.
    #[test]
    fn parse_seed_reads_lanes_in_order() {
        assert_eq!(parse_seed("0.5"), Effect { dials: [0.5, 0.0, 0.0, 0.0] });
        assert_eq!(parse_seed("0.1, 0.2 ,0.3,0.4"), Effect { dials: [0.1, 0.2, 0.3, 0.4] });
        assert_eq!(parse_seed(""), Effect::default(), "a junk value is the empty word, never a panic");
    }
}
