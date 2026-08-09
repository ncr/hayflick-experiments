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
//! - lane 0 — **STAIN GATE**, lane 1 — **WEB GATE**: the two painted layers'
//!   ABSOLUTE damage-field thresholds, solved per RUN by
//!   `wall::RunField::threshold` and carried as 6-bit codes counting DOWN from
//!   `wall::GATE_HI`. See [`STAIN_LANE`] for why absolute and why downward.
//! - lane 2 — **BAND LO**, lane 3 — **BAND HI** (claimed 2026-07-27, the
//!   effect-system round C): the wall's band-mask edge codes
//!   (`wall::band_codes` — 0 = that edge off, upper edge counts DOWN from the
//!   top so the default authoring packs to zero). The twins subtract the mask
//!   from `dmgN` (`wall::banded`), which is what makes ONE authored region
//!   steer the painted gates and the host geometry together. The word is
//!   FULL, and so are `_pad`'s lanes 2/3 (mud took them in round D). The next
//!   per-material dial goes to `Material._rsv` — a whole free 32-bit word since
//!   the glTF deletion retired `tex_index` — and only after THAT to the
//!   per-material aux buffer this codec's budget notes keep promising.
//!
//! The unpack both shader twins must copy verbatim — one spelling, both
//! dialects: MSL takes `.a` exactly as GLSL does (rgba swizzles are legal on an
//! MSL float4), and the twin-pin test below matches that literal, so a port that
//! spells it `.w` fails the build with a message about the SHIFT:
//!
//! ```glsl
//! uint  ew     = uint(m.emissive.a);            // the effect word
//! float tStain = 1.20 - float( ew        & 63u) * 0.020;  // GATE_HI, GATE_STEP
//! float tWeb   = 1.20 - float((ew >> 6) & 63u) * 0.020;
//! float lane2  = float((ew >> 12) & 63u) * (1.0/63.0);
//! float lane3  = float((ew >> 18) & 63u) * (1.0/63.0);
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
//! # The two shapes of "host and shader agree"
//!
//! The story key is ONE WRITER, TWO READERS: it lands in the `Scene` and both
//! `crack_geom::story_of` and the shade pass read the same f32 bits, so there is
//! no mirror at all. A lane the HOST also consumes cannot do that — the word
//! streams after the build, the geometry pass runs before it — so the gate lanes
//! are ONE DATUM, TWO CALLERS instead: `wall::Sheet` carries thresholds
//! already passed through `wall::gate_quantize`, the geometry pass uses exactly
//! those, and the shader decodes exactly those from the lanes. The only mirrored
//! things left are the two codec constants and the shape of the decode, and
//! `both_shader_twins_spell_every_wear_decode_as_the_host_packs_it` reads
//! both shader sources at compile time so neither can drift silently. Any future
//! lane the host reads too must follow the same discipline: quantize on the host,
//! never hand the shader a value the host did not round first.
//!
//! # The STORY KEY (`base_color[3]`)
//!
//! [`wear_core::wall::story_key`] hashes the pier's parent RUN — the authored
//! wall slab it was cut out of ([`Pier::run_lo`]/`run_hi`) — into one float, and
//! [`stamp_story`] writes it onto every pier's material. (The hash itself lives
//! in `wear-core` beside the `RunRect` whose rect it takes; this module owns the
//! STAMP, which is the half that knows what a `Material` is.) It is the seed of
//! everything that
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
use rt_probe::Scene;

/// Write every pier's run STORY KEY into its material's `base_color[3]`.
///
/// Runs on the CPU `Scene` BEFORE the geometry pass (`crack::resolve`), because
/// `crack_geom` seeds its damage field off the same key the shade pass reads —
/// host and shader must agree or the paint and the plates drift apart. Returns
/// how many materials it wrote, for the boot line.
pub fn stamp_story(scene: &mut Scene, piers: &[Pier]) -> usize {
    for pier in piers {
        let mid = scene.primitives[pier.prim].material_id as usize;
        scene.materials[mid].base_color[3] = wear_core::wall::story_key(pier.run_lo, pier.run_hi);
    }
    piers.len()
}

// ---- the four lanes ---------------------------------------------------------

/// Lane indices of the two PAINTED layers' absolute gate codes.
///
/// # Why absolute, and why counting down
///
/// This replaces a SIGNED per-run level OFFSET. That lane existed because the
/// gates were absolute thresholds on an fbm while the *amount* of damage was
/// whatever a run's fbm draw happened to give it: over the gym's seven runs the
/// field's 98th percentile spread 0.49..0.92 and the run behind the doorway
/// never cleared the zone gate AT ANY AGE — an un-ageable facade, and the owner
/// dials to max first. The offset patched that by nudging every run's field
/// toward a canonical level.
///
/// Solving the threshold itself per run (`wall::RunField::threshold`) does the
/// same job at the root, so the offset has nothing left to do — and the lane now
/// carries the THRESHOLD, which is strictly better in one measurable way: the
/// signed offset was calibrated for run-to-run variation at one reference age
/// (±0.384 in units of 0.012), not for a dial's whole travel, so asking for a
/// large coverage on a low-level run needed an offset past its clamp. A dead
/// region at the top of the central dial is exactly what this round exists to
/// delete.
///
/// The code counts DOWN from `wall::GATE_HI`, which sits above the field's
/// maximum. So code 0 — the empty word, hence every material nobody stamped —
/// means provably NOTHING, by construction rather than by a signed trick.
pub const STAIN_LANE: usize = 0;
pub const WEB_LANE: usize = 1;
/// The band mask's two edge lanes (`wall::band_codes` order: lower, upper).
pub const BAND_LO_LANE: usize = 2;
pub const BAND_HI_LANE: usize = 3;

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

/// Stamp the effect word onto every wall pier AND its chalk core, returning
/// the changed `(material, word)` pairs — the same shape as `crack::stamp_aa`,
/// for the same reason: the caller streams the difference and nothing else.
///
/// The core comes along because it IS the surface the damage exposed (groove
/// floors, recesses, spall basins), and every lane the catalogue claims so far
/// is a property of exposed material. `cores` is the crack lab's per-pier core
/// list (`-1` = the pier was left pristine), passed as plain ids so this module
/// does not depend on the lab.
///
/// `gates[i]` is pier `i`'s four lane CODES — the two solved painted-layer
/// thresholds (`wall::gate_code`) and the two band edges (`wall::band_codes`)
/// — a per-RUN datum, landing on the pier and on its chalk core so a crack
/// floor stains (and is banded) with the wall around it. An all-zero set
/// stamps an empty word, which is why an unaged level writes nothing at all
/// and stays bit-identical to the plain greybox.
///
/// All four lanes are DERIVED now, so the `WEAR=` harness seed and the `base`
/// parameter it fed are gone (2026-07-27): a lane with a real owner is driven
/// through that owner's own dial (`STORY=`/`BAND=`), not around it.
pub fn stamp_all(scene: &mut Scene, piers: &[Pier], cores: &[i32], gates: &[[u32; 4]]) -> Vec<(usize, f32)> {
    let mut out = Vec::new();
    for (i, pier) in piers.iter().enumerate() {
        let mut e = Effect::default();
        let g = gates.get(i).copied().unwrap_or([0; 4]);
        e.dials[STAIN_LANE] = g[0] as f32 / DIAL_MAX;
        e.dials[WEB_LANE] = g[1] as f32 / DIAL_MAX;
        e.dials[BAND_LO_LANE] = g[2] as f32 / DIAL_MAX;
        e.dials[BAND_HI_LANE] = g[3] as f32 / DIAL_MAX;
        let core = cores.get(i).copied().filter(|c| *c >= 0);
        for mid in [Some(scene.primitives[pier.prim].material_id), core].into_iter().flatten() {
            if let Some(w) = stamp(scene, mid as usize, e) {
                out.push((mid as usize, w));
            }
        }
    }
    out
}

impl Viewer {
    /// Re-derive every pier's EFFECT WORD against the current scene and push
    /// what changed to the backend's live material stream (visible next frame,
    /// nothing rebuilds, nothing rebakes). Called at boot and after every
    /// `apply_look` rebuild — the rebuild mints fresh materials, so the word
    /// has to be re-stamped exactly like the AA scope bits are.
    pub fn wear_stamp(&mut self) {
        // The SAME solved thresholds the geometry pass used — read off the same
        // per-RUN `wall::Sheet`, not re-derived, so paint and plates cannot end
        // up in different patches. Deriving them twice is the drift this codec's
        // whole discipline exists to prevent.
        let wear = self.crack.wear();
        let gates: Vec<[u32; 4]> = (0..self.piers.len())
            .map(|i| match wear.of(i).or_else(|| self.crack.pier_run.get(i).and_then(|r| self.crack.sheets.get(*r))) {
                // A PAINT-ONLY wall is exactly the case that must still get its
                // word: the geometry pass skips it, and the painted layers it
                // exists to show are the ones this word gates.
                Some(sh) => [sh.paint.stain, sh.paint.web, sh.paint.band[0], sh.paint.band[1]],
                None => [0; 4], // unaged: an empty word, bit-identical to the plain greybox
            })
            .collect();
        let changed = stamp_all(&mut self.scene, &self.piers, &self.crack.cores, &gates);
        if !changed.is_empty() {
            let n = gates.iter().filter(|g| **g != [0; 4]).count();
            println!("wear: effect word streamed to {} materials (solved gates on {n} piers)", changed.len());
        }
        for (mid, w) in changed {
            self.backend.set_material_effect(mid, w);
        }
    }
}

/// The two shader twins' SOURCES, read at compile time. Shared by every
/// source-level guard (this module's lane check and `crate::flags`' value
/// check) so a new guard cannot quietly check only one backend.
#[cfg(test)]
pub fn twin_sources() -> [(&'static str, &'static str); 2] {
    [("shade.comp", include_str!("../../rt-probe/src/shaders/shade.comp")), ("shade.metal", include_str!("shaders_metal/shade.metal"))]
}

/// ALL THREE shader pairs' sources, read at compile time — the input to
/// [`twin::twins_are_structurally_identical`]. [`twin_sources`] is the shade
/// pair alone, kept because the fragment tables below (and `crate::flags`) are
/// about that one file's HOST MIRRORS, not about the twins agreeing.
#[cfg(test)]
pub fn twin_pairs() -> [(&'static str, &'static str, &'static str); 3] {
    [
        ("shade", include_str!("../../rt-probe/src/shaders/shade.comp"), include_str!("shaders_metal/shade.metal")),
        ("tonemap", include_str!("../../rt-probe/src/shaders/tonemap.comp"), include_str!("shaders_metal/tonemap.metal")),
        ("probes", include_str!("../../rt-probe/src/shaders/probes.comp"), include_str!("shaders_metal/probes.metal")),
    ]
}

/// A shader source's lines with COMMENTS DROPPED. "comment the blind twin out
/// while bisecting on the spawner, forget to restore" is the single likeliest
/// way one of these gates dies on Vulkan, and it was the one mutation the first
/// guard missed (review 2026-07-25 proved it by mutation).
#[cfg(test)]
pub fn code_lines(src: &str) -> Vec<&str> {
    src.lines().filter(|l| !l.trim_start().starts_with("//")).collect()
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
        let flat = [[0u32; 4]; 2]; // no solved gates, no band on these piers
        assert!(stamp_all(&mut scene, &piers, &cores, &flat).is_empty(), "the empty word is already there — nothing to stream");
        // solved codes on pier 0 only: stain gate 12, band-hi edge 9
        let gates = [[12u32, 0, 0, 9], [0; 4]];
        let changed = stamp_all(&mut scene, &piers, &cores, &gates);
        assert_eq!(changed.len(), 2, "the gated pier + its core; the flat pier stays empty");
        let want = Effect { dials: [12.0 / 63.0, 0.0, 0.0, 9.0 / 63.0] }.word();
        for (mid, w) in &changed {
            assert_eq!(scene.materials[*mid].emissive[3], *w, "the CPU shadow and the streamed value agree");
            assert_eq!(*w, want, "every lane must come from `gates` — all four are derived now");
        }
        assert!(stamp_all(&mut scene, &piers, &cores, &gates).is_empty(), "re-stamping the same word streams nothing");
    }

    /// AN UNSTAMPED MATERIAL MUST DECODE TO NOTHING — the property the deleted
    /// signed level lane existed to guarantee, now a property of the CODEC
    /// instead, and true of every core a future generator mints.
    ///
    /// Code 0 is what `add_box_world` leaves in a pier's emissive alpha, so it
    /// is what every surface nobody stamped reads. With the old unorm-style
    /// lanes that meant "the low end of the range", which would silently age
    /// the whole level; the signed two's-complement trick was the workaround.
    /// Counting the threshold DOWN from above the field's maximum makes it
    /// structural: code 0 is a gate no sample can clear. `wall`'s
    /// `zero_is_provably_empty` checks that against every run of both shipped
    /// levels; this checks the codec end of it.
    #[test]
    fn code_zero_is_a_gate_nothing_can_clear() {
        assert_eq!(wear_core::wall::gate_code(wear_core::wall::GATE_EMPTY), 0);
        let e = Effect::default();
        assert_eq!(e.word(), 0.0, "the empty word must be exactly 0.0");
        assert_eq!(e.dials[STAIN_LANE], 0.0);
        assert_eq!(e.dials[WEB_LANE], 0.0);
        // …and the top of the range is reachable, which the signed lane's clamp
        // could not promise on a low-level run
        assert_eq!(wear_core::wall::gate_code(wear_core::wall::GATE_FULL), 63);
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
        let (mut scene, meta) = crate::gym_scene::build_gym(&spec, &crate::look::POLANA);
        assert_eq!(stamp_story(&mut scene, &meta.piers), meta.piers.len());
        // group the piers by their authored run rect, then by the stamped key
        let mut runs: Vec<([i32; 4], f32)> = Vec::new();
        for pier in &meta.piers {
            let q = |v: f32| (v * 10.0).round() as i32;
            let rect = [q(pier.run_lo.x), q(pier.run_lo.z), q(pier.run_hi.x), q(pier.run_hi.z)];
            let key = scene.materials[scene.primitives[pier.prim].material_id as usize].base_color[3];
            assert_eq!(key, wear_core::wall::story_key(pier.run_lo, pier.run_hi), "the stamp writes the key the readers recompute");
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

    /// THE MIRROR PIN, over every wear datum the shade twins decode: the four
    /// effect-word lanes, the band mask's three constants, the codec's
    /// `GATE_HI`/`GATE_STEP`, each painted layer's own `_pad` strength lane and
    /// mud's two lanes. Every one of these is measured on the HOST and applied
    /// on BOTH sides — `CrazeCfg::dmg` cuts the plates with it, the shade pass
    /// paints with it — so a constant drifting apart separates the geometry from
    /// the paint, which docs/AGENT_LEARNINGS.md records twice as the failure mode
    /// of this codebase. Host constants cannot be shared into GLSL/MSL, so the
    /// next best thing is to READ the twins and refuse to build if either stops
    /// spelling these exact decodes. Both are read at compile time, so this also
    /// catches the classic "ported one twin only" — and the [`FORBIDDEN`] table
    /// below catches its mirror image, a deletion applied to one twin only.
    #[test]
    fn both_shader_twins_spell_every_wear_decode_as_the_host_packs_it() {
        for (name, src) in twin_sources() {
            let lines = code_lines(src);
            let has = |pat: &str| lines.iter().any(|l| l.contains(pat));
            // REQUIRED — the lane must still be decoded exactly as packed
            // all four lanes, at their bit positions
            assert!(has("ew        & 63u"), "{name}: the STAIN lane (bits 0..5) moved");
            assert!(has("(ew >> 6) & 63u"), "{name}: the WEB lane (bits 6..11) moved");
            assert!(has("(ew >> 12) & 63u"), "{name}: the BAND-LO lane (bits 12..17) moved");
            assert!(has("(ew >> 18) & 63u"), "{name}: the BAND-HI lane (bits 18..23) moved");
            // the band mask's three constants, as the host spells them: the
            // normalization height (wall::BAND_TOP), the feather, and the
            // subtraction that drops out-of-band below every gate
            assert!(has("/ 2.1875"), "{name}: the band height drifted from wall::BAND_TOP");
            assert!(has("0.06"), "{name}: the band feather drifted from wall::BAND_FEATHER");
            assert!(has("2.0 * (1.0 - band)"), "{name}: the band no longer drops the field below the gates");
            // the codec's two constants, spelled as the HOST spells them — a
            // shader counting from a different top or by a different step reads
            // every threshold wrong, and does it silently
            assert!(has(&format!("{:.2} - float", wear_core::wall::GATE_HI)), "{name}: GATE_HI drifted from the host's {}", wear_core::wall::GATE_HI);
            assert!(has(&format!("* {:.3};", wear_core::wall::GATE_STEP)) || has(&format!("* {:.3};  //", wear_core::wall::GATE_STEP)), "{name}: GATE_STEP drifted from the host's {}", wear_core::wall::GATE_STEP);
            // …and both thresholds actually gate something
            assert!(has("smoothstep(tStain"), "{name}: the stain gate does not use its threshold");
            assert!(has("smoothstep(tWeb"), "{name}: the web gate does not use its threshold");
            // …and each painted layer reads its OWN `_pad` strength lane. Both
            // used to read lane 0, so their areas were independent and their
            // intensities were not — a half-finished separation is exactly the
            // kind of thing a source guard is for.
            assert!(has("(kb >> 8) & 63u"), "{name}: the STAIN strength lane (bit 8) moved");
            assert!(has("(kb >> 14) & 63u"), "{name}: the WEB strength lane (bit 14) moved");
            assert!(has("aStain *") || has("skin * aStain"), "{name}: the stains do not read their own strength");
            assert!(has("aWeb *"), "{name}: the web does not read its own strength");
            // MUD (`_pad` lanes 2/3, claimed 2026-07-27): its two decodes, the
            // solved-threshold read (wall::mud_code's exact decode) and the
            // breakup seed the host solver samples (`wall::mud_noise`) — one
            // drifting apart from the other un-solves the amount silently
            assert!(has("(kb >> 20) & 63u"), "{name}: the MUD threshold lane (bit 20) moved");
            assert!(has("(kb >> 26) & 63u"), "{name}: the MUD band-top lane (bit 26) moved");
            assert!(has("float(mc) * (1.0 / 63.0)"), "{name}: mud's threshold decode drifted from wall::mud_code");
            assert!(has("story * 3.0 + 17.0"), "{name}: mud's breakup seed drifted from wall::mud_noise");
            // FORBIDDEN — nothing yet. This half of the guard is what catches a
            // HALF-DONE deletion: the Mac can only run the MSL twin, so a cull
            // applied to one source and forgotten in the other compiles, passes
            // every test, and ships a different image on the other backend. A
            // required-only guard is blind to that by construction; it can prove
            // a line is present, never that a line is gone.
            for gone in FORBIDDEN {
                assert!(!has(gone), "{name}: {gone:?} was supposed to be deleted from BOTH twins");
            }
        }
    }

    /// The IDE selection outline lives in the TONEMAP twins: the shade pass
    /// tags SEL hits `posImg.w == 3` and tonemap draws the amber line on the
    /// tag-region boundary. Same rationale as the shade guards — one backend
    /// is blind every session, so a fragment present in one twin and not the
    /// other compiles, passes every test, and ships a different image there.
    /// The shade side's tag write is covered by `flags::both_twins_spell_…`
    /// (it reads `pad & 8u`); this pins the tonemap side's decode and draw.
    #[test]
    fn both_tonemap_twins_draw_the_selection_outline() {
        for (name, src) in [
            ("tonemap.comp", include_str!("../../rt-probe/src/shaders/tonemap.comp")),
            ("tonemap.metal", include_str!("shaders_metal/tonemap.metal")),
        ] {
            let lines = code_lines(src);
            let has = |pat: &str| lines.iter().any(|l| l.contains(pat));
            assert!(has("P0.w > 1.5 && P0.w < 2.5"), "{name}: the contour decode no longer excludes the selection tag");
            assert!(has("P0.w > 2.5"), "{name}: the selection-tag decode is gone");
            assert!(has("Pn.w < 2.5"), "{name}: the selection boundary test is gone");
            assert!(has("1.0, 0.82, 0.40"), "{name}: the SEL amber drifted from the accent the host documents");
        }
    }

    /// Source fragments that must NOT appear in either twin.
    ///
    /// Every entry here is a painted layer deleted on 2026-07-26 because it
    /// could not draw where it mattered (see the WEATHERED SKIN block's own
    /// comment). The list exists because the Mac can only RUN the MSL twin: a
    /// deletion applied to one source and forgotten in the other compiles,
    /// passes every test, and ships a different image on the other backend.
    /// The two DEAD knob lanes are here too. `_pad` carries the two painted
    /// layers' strengths at bits 8 and 14 (`crack::pad_bits`) and nothing above
    /// them: lanes 2/3 are unclaimed, so a shader reading one is reading zero and
    /// meaning something by it. It is the same argument as the deletions above,
    /// one step earlier.
    ///
    /// The TEXTURE entries (2026-07-28) are the same argument again, and the
    /// deletion that earned them proves the point: the glTF importer was the
    /// only writer of a non-negative `tex_index`, so the sampling branches were
    /// dead — and `probes.comp` still sampled while `probes.metal` did not, the
    /// project's one real twin divergence, invisible for as long as it took to
    /// look. `h.uv` covers the interpolation the sampler fed on.
    ///
    /// `hasProbes` (2026-07-28) is the divergence itself, in its last form: an
    /// M1 bring-up gate that only ever existed in the MSL twin, and whose host
    /// only ever wrote the literal `1`. A gate hardwired to its pass-through
    /// value is not a feature, it is a difference between the two shaders
    /// waiting to be read as one — so it is forbidden in BOTH from here on.
    /// `dir.w == 2.0` is the deleted spotlight cone (`rt_probe::Spotlight`,
    /// same day): its only writer went with the pre-reset flashlight, so both
    /// twins branched on a value `scan_lights` cannot produce.
    const FORBIDDEN: &[&str] = &[
        "faultAt",           // the painted structural fault
        "crazeG",            // the CRAZE-bit escape hatch it needed
        "chipM",             // the painted chip patches
        "lineP",             // the painted craze cell network
        "cuvP",              // its view-parallax sample offset
        "lvlC",              // the signed per-run LEVEL offset the solved thresholds replace
        "float dT",          // the age-derived gate that slid five fixed windows together
        "mHalo",             // the fault's stain track
        "0.82, 0.40), 0.22", // the SEL albedo lift — selection is a tonemap outline now
        "texIndex",          // the dead base-colour texture index (glTF path, deleted)
        "h.uv",              // …and the barycentric UV that only ever fed it
        "hasProbes",         // the M1 probe gate — MSL-only, host-hardwired to 1
        "dir.w == 2.0",      // the spotlight cone — no writer since the flashlight died
    ];
    // `_pad` lanes 2/3 (`>> 20` / `>> 26`) left this table on 2026-07-27:
    // MUD claimed them (crack::pad_bits), and their decodes are REQUIRED now.

    /// HOST → SHADER CONSTANT MIRRORS — the fragment table's one remaining job.
    ///
    /// Since [`crate::wear::twin`] diffs the twins against EACH OTHER, "both
    /// twins say the same thing" no longer needs remembering fragment by
    /// fragment. What a twin diff CANNOT see is a host/shader disagreement: the
    /// Rust that generates geometry and the GLSL/MSL that paints it are two
    /// independent spellings of the same arithmetic, and when they drift the
    /// paint lands off the plates (docs/AGENT_LEARNINGS.md records that failure
    /// twice). So each entry names a fragment that must appear in BOTH shader
    /// twins AND in the host file(s) that mirror it.
    ///
    /// `(shader fragment, [(host file label, host source, host fragment)])`.
    #[allow(clippy::type_complexity)]
    const HOST_MIRRORS: &[(&str, &[(&str, &str, &str)])] = &[
        // THE DAMAGE FIELD's seed. `wall::RunField::at` solves the thresholds on
        // it, `CrazeCfg::new` cuts the plates with it and the shade pass paints
        // with it. It used to be spelled three times — once per host call site
        // plus the shader — and the two host copies pinned nothing about each
        // other; `wear_core::field::dmg_seed` is that one name now, so the
        // mirror this table holds is the last one that cannot be a function
        // call (a shader cannot call Rust).
        (
            "story * 7.0 + 3.0",
            &[("wear-core/src/field.rs", include_str!("../../wear-core/src/field.rs"), "story * 7.0 + 3.0")],
        ),
        // …and the field's SHAPE around that seed: the two ground-plane
        // frequencies, the rise term and the rise ramp. `field::dmg_field` is
        // the host's one definition (`wall::RunField::at` and `CrazeCfg::dmg`
        // both delegate to it).
        ("cuv * vec2(0.45, 0.7)", &[("wear-core/src/field.rs", include_str!("../../wear-core/src/field.rs"), "su * 0.45, sy * 0.7")]),
        ("+ 0.16 * rise", &[("wear-core/src/field.rs", include_str!("../../wear-core/src/field.rs"), "+ 0.16 * rise")]),
        ("1.0 - smoothstep(0.10, 1.0,", &[("wear-core/src/field.rs", include_str!("../../wear-core/src/field.rs"), "1.0 - smoothstep(0.10, 1.0,")]),
        // FBM — the noise both the field and the mud quantile are built on. Two
        // octaves, one gain pair, one lacunarity, one offset.
        (
            "0.65 * vnoise(p) + 0.35 * vnoise(p * 2.03 +",
            &[("wear-core/src/field.rs", include_str!("../../wear-core/src/field.rs"), "0.65 * vnoise(p) + 0.35 * vnoise(p * 2.03 +")],
        ),
        // MUD's breakup noise: seed and frequency. (The threshold DECODE is
        // pinned above; this is the field it decodes against.)
        ("story * 3.0 + 17.0", &[("wear-core/src/wall.rs", include_str!("../../wear-core/src/wall.rs"), "story * 3.0 + 17.0")]),
        ("fbm(vec3(cuv * 2.0", &[("wear-core/src/wall.rs", include_str!("../../wear-core/src/wall.rs"), "u * 2.0, y * 2.0")]),
    ];

    /// Every [`HOST_MIRRORS`] entry must be spelled in BOTH twins and in every
    /// host file it names. A constant that lives on one side only is a mirror
    /// nobody is holding: the twin diff proves the two shaders agree with each
    /// other and says nothing about whether they agree with the Rust.
    #[test]
    fn the_host_and_both_twins_spell_every_mirrored_constant() {
        for (frag, hosts) in HOST_MIRRORS {
            // the MSL twin spells the vector types its own way; compare the
            // dialect-translated fragment there
            let msl = frag.replace("vec2", "float2").replace("vec3", "float3");
            for (name, src) in twin_sources() {
                let lines = code_lines(src);
                assert!(
                    lines.iter().any(|l| l.contains(frag) || l.contains(msl.as_str())),
                    "{name}: the host mirror {frag:?} is gone from this twin"
                );
            }
            for (label, host, hfrag) in *hosts {
                assert!(host.contains(hfrag), "{label}: the host side of the mirror {frag:?} no longer spells {hfrag:?}");
            }
        }
    }
}

/// THE STRUCTURAL TWIN DIFF — "the two shaders ARE the same program".
///
/// # Why this exists
///
/// `crates/rt-probe/src/shaders/*.comp` (GLSL/Vulkan) and
/// `crates/rt-viewer/src/shaders_metal/*.metal` (MSL) are line-for-line twins,
/// and the project's whole workflow rests on that: one hardware session runs
/// one backend, so every round leaves the OTHER twin unverified. Until
/// 2026-07-28 the only guard was a fragment whitelist — a `contains()` scan of
/// ~23 remembered strings over ONE file at a time. It never compared the twins
/// to each other and it covered 2 of the 6 sources, so an edit to any line
/// nobody had thought to remember shipped a different image on the other
/// backend and passed every test. (Proven by mutation during the 2026-07-28
/// audit: four image-changing edits to `shade.metal` alone — the stain tint,
/// the glaze web's line width, the mud strength and the damage field's rise
/// term — each passed the full suite.)
///
/// # What it does
///
/// For each of the three pairs (shade, tonemap, probes) it reads both sources
/// at compile time, splits them into TOP-LEVEL ITEMS (functions, structs,
/// file-scope constants), normalizes each item's token stream through a fixed
/// GLSL↔MSL map, and asserts the two streams are EQUAL token for token. The
/// item set must match too, so a whole function appearing on one side only is
/// as loud as a changed constant.
///
/// # The normalization, and why each step is not drift
///
/// Every rule below erases a difference the two DIALECTS force; none of them
/// can erase a difference in the math or the control flow.
///
/// - **Comments** are stripped (a commented-out gate is a deletion).
/// - **Types**: `vec3`/`float3`/`packed_float3` → one token, likewise vec2/4,
///   ivec/int2-4, uvec/uint2-3.
/// - **Names**: MSL renames what MSL must (`sky`→`skyCol`, `hash`→`hashp`; the
///   entry point is `main` in GLSL and the kernel's own name in MSL).
/// - **Numbers** are canonicalized by VALUE (`0x0Au` and `10`, `0.` and `0.0`,
///   `1e9` and `1000000000` are one token), and integer/float suffixes drop.
/// - **Swizzles**: `.rgb`/`.a` and `.xyz`/`.w` are one spelling (only the pure
///   rgba alphabet maps — `.t`, `.pos`, `.mat` are struct fields and untouched).
/// - **Single-argument vector/scalar constructors** are dropped on BOTH sides.
///   MSL needs casts GLSL does not (`float3(v0.nrm)` off a `packed_float3`,
///   `int(gid.x)` off a `uint2` thread id) and a splat is spelled the same on
///   both sides, so dropping them is symmetric. THE ONE THING THIS COSTS: a
///   cast added on one side only is invisible. Multi-argument constructors are
///   compared normally.
/// - **Resource parameters**: MSL threads `accel`/`verts`/`indices`/`geoms`/
///   `mats`/`lights`/`pd`/`pc`/the G-buffers through every call site where GLSL
///   has globals. An argument (or parameter) whose last token names a resource
///   is dropped, at declarations and call sites alike — so what gets compared
///   is the arguments that carry MATH.
/// - **Storage access**: `imageLoad(colorImg, px)` and `outRadiance[idx]` both
///   become `RAD[IDX]`; `imageStore(...)` / `buf[..] = ..` / `outTex.write(..)`
///   become one assignment. The INDEX arithmetic differs by construction (a 2D
///   image coordinate vs a flat buffer offset) and is elided with it, together
///   with the integer temps that exist only to name it (`q`, `qa`, `qb`, `li`,
///   `idx`).
/// - **Push-constant fields** are aliased to SEMANTIC names per side, because
///   the two hosts pack them differently on purpose (shade.metal's `misc2` is
///   not the Vulkan `ShadePush`'s `misc2` — see that file's header). A wrong
///   alias would make the bodies mismatch, so the table cannot lie quietly.
/// - **Ray-cast setup** — `rayQueryEXT`/`rayQueryInitializeEXT`/the proceed
///   loop against `ray`+`intersector`+`intersect` — has no common spelling and
///   is elided. Its RESULT accessors are mapped to one spelling
///   (`HIT_T`/`HIT_INST`/`HIT_PRIM`/`HIT_BARY`/`HIT_TYPE`/`HIT_NONE`), so
///   everything the trace DOES with a hit is still compared. **What this
///   costs**: the ray range and the two hard-coded masks inside `occluded` /
///   `aoVis` (`0xFF`) and `probes` (`PROBE_MASK`) are not compared — every
///   other mask rides a `trace(…)` argument and IS compared.
/// - **Dialect-local aliases**: a declaration that only names a value the twin
///   spells inline (`ivec2 px = …` in GLSL where MSL takes `gid` as a kernel
///   parameter; `uint idx`, `int lowW/lowH`, `uint frame` in MSL) is dropped
///   and its uses expanded, so the two read the same.
///
/// # The allowlist
///
/// [`ALLOW`] is what is left: named, contiguous token rewrites for genuine
/// formatting divergence. Each states WHY it is not drift and MUST fire
/// exactly the stated number of times — an entry that stops matching fails the
/// test, so the list cannot rot into a whitelist that quietly waves things
/// through.
///
/// # What this test does NOT cover
///
/// The resource-declaration preamble: `#version`/`#include`, `layout(...)`
/// bindings, the `Push`/`ProbePush` structs. Those ARE the dialect (a Vulkan
/// descriptor set against Metal buffer indices) and there is nothing to
/// compare; the push blocks' field SEMANTICS are pinned by the alias table
/// above instead. Nor does it see a host/shader disagreement — that is the
/// fragment tables' job (`HOST_MIRRORS`, `crate::flags`).
#[cfg(test)]
pub mod twin {
    use std::collections::BTreeMap;

    // ---- lexing --------------------------------------------------------------

    fn strip_comments(src: &str) -> String {
        let mut out = String::with_capacity(src.len());
        let mut it = src.chars().peekable();
        while let Some(c) = it.next() {
            if c == '/' {
                match it.peek() {
                    Some('/') => {
                        for c in it.by_ref() {
                            if c == '\n' {
                                out.push('\n');
                                break;
                            }
                        }
                        continue;
                    }
                    Some('*') => {
                        it.next();
                        let mut prev = ' ';
                        for c in it.by_ref() {
                            if prev == '*' && c == '/' {
                                break;
                            }
                            prev = c;
                        }
                        out.push(' ');
                        continue;
                    }
                    _ => {}
                }
            }
            out.push(c);
        }
        out
    }

    const OPS: &[&str] = &[
        "<<=", ">>=", "::", "<<", ">>", "<=", ">=", "==", "!=", "&&", "||", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=",
    ];

    fn tokenize(src: &str) -> Vec<String> {
        let c: Vec<char> = src.chars().collect();
        let mut out = Vec::new();
        let mut i = 0;
        while i < c.len() {
            let ch = c[i];
            if ch.is_whitespace() {
                i += 1;
                continue;
            }
            if ch.is_ascii_digit() || (ch == '.' && c.get(i + 1).is_some_and(|d| d.is_ascii_digit())) {
                let s = i;
                if ch == '0' && matches!(c.get(i + 1), Some('x') | Some('X')) {
                    i += 2;
                    while c.get(i).is_some_and(|d| d.is_ascii_hexdigit()) {
                        i += 1;
                    }
                } else {
                    while c.get(i).is_some_and(|d| d.is_ascii_digit()) {
                        i += 1;
                    }
                    if c.get(i) == Some(&'.') {
                        i += 1;
                        while c.get(i).is_some_and(|d| d.is_ascii_digit()) {
                            i += 1;
                        }
                    }
                    if matches!(c.get(i), Some('e') | Some('E')) {
                        let mut j = i + 1;
                        if matches!(c.get(j), Some('+') | Some('-')) {
                            j += 1;
                        }
                        if c.get(j).is_some_and(|d| d.is_ascii_digit()) {
                            i = j;
                            while c.get(i).is_some_and(|d| d.is_ascii_digit()) {
                                i += 1;
                            }
                        }
                    }
                }
                while matches!(c.get(i), Some('u') | Some('U') | Some('f') | Some('F')) {
                    i += 1;
                }
                out.push(c[s..i].iter().collect());
                continue;
            }
            if ch.is_ascii_alphabetic() || ch == '_' {
                let s = i;
                while c.get(i).is_some_and(|d| d.is_ascii_alphanumeric() || *d == '_') {
                    i += 1;
                }
                out.push(c[s..i].iter().collect());
                continue;
            }
            let rest: String = c[i..(i + 3).min(c.len())].iter().collect();
            match OPS.iter().find(|op| rest.starts_with(**op)) {
                Some(op) => {
                    out.push((*op).to_string());
                    i += op.len();
                }
                None => {
                    out.push(ch.to_string());
                    i += 1;
                }
            }
        }
        out
    }

    /// Canonicalize a numeric literal BY VALUE, so `0x0Au` and `10`, or `0.`
    /// and `0.0`, are one token. Hex is decoded before the suffix strip — a
    /// trailing `f` in `0xFF` is a DIGIT, not a float suffix.
    fn numnorm(t: &str) -> String {
        let low = t.to_ascii_lowercase();
        if let Some(rest) = low.strip_prefix("0x") {
            if let Ok(v) = u64::from_str_radix(rest.trim_end_matches('u'), 16) {
                return v.to_string();
            }
        }
        let s = low.trim_end_matches(['u', 'f']);
        if let Ok(v) = s.parse::<f64>() {
            if v.fract() == 0.0 && v.abs() < 1e15 {
                return format!("{}", v as i64);
            }
            return format!("{v:?}");
        }
        t.to_string()
    }

    fn is_ident(t: &str) -> bool {
        t.as_bytes().first().is_some_and(|c| c.is_ascii_alphabetic() || *c == b'_')
    }
    fn is_num(t: &str) -> bool {
        t.as_bytes().first().is_some_and(|c| c.is_ascii_digit() || *c == b'.')
    }

    // ---- token-stream helpers -------------------------------------------------

    /// `t[lp]` is `(`. Returns the comma-separated argument groups (outer parens
    /// stripped) and the index just past the matching `)`.
    fn split_call(t: &[String], lp: usize) -> (Vec<Vec<String>>, usize) {
        let (mut args, mut cur, mut d, mut k) = (Vec::new(), Vec::new(), 0i32, lp);
        while k < t.len() {
            let x = t[k].as_str();
            if matches!(x, "(" | "[" | "{") {
                d += 1;
            } else if matches!(x, ")" | "]" | "}") {
                d -= 1;
                if d == 0 {
                    args.push(cur);
                    return (args, k + 1);
                }
            }
            if d == 1 && x == "," {
                args.push(std::mem::take(&mut cur));
            } else if !(d == 1 && x == "(" && k == lp) {
                cur.push(t[k].clone());
            }
            k += 1;
        }
        args.push(cur);
        (args, k)
    }

    fn seq_replace(t: &[String], from: &[&str], to: &[&str]) -> (Vec<String>, usize) {
        let (mut o, mut k, mut n) = (Vec::new(), 0usize, 0usize);
        while k < t.len() {
            if t[k..].len() >= from.len() && t[k..k + from.len()].iter().zip(from).all(|(a, b)| a == b) {
                o.extend(to.iter().map(|s| (*s).to_string()));
                k += from.len();
                n += 1;
            } else {
                o.push(t[k].clone());
                k += 1;
            }
        }
        (o, n)
    }

    /// Split a run into statements: each ends at a `;` or a `}` seen at depth 0.
    fn statements(t: &[String]) -> Vec<Vec<String>> {
        let (mut out, mut cur, mut d) = (Vec::new(), Vec::new(), 0i32);
        for x in t {
            cur.push(x.clone());
            match x.as_str() {
                "(" | "[" | "{" => d += 1,
                ")" | "]" | "}" => d -= 1,
                _ => {}
            }
            if (x == ";" || x == "}") && d == 0 {
                out.push(std::mem::take(&mut cur));
            }
        }
        if !cur.is_empty() {
            out.push(cur);
        }
        out
    }

    /// Walk the statement tree, dropping every statement `drop` accepts and
    /// recursing into the body of every one it does not.
    fn map_stmts(t: &[String], drop: &dyn Fn(&[String]) -> bool) -> Vec<String> {
        let mut o = Vec::new();
        for s in statements(t) {
            if drop(&s) {
                continue;
            }
            match s.iter().position(|x| x == "{") {
                Some(i) => {
                    let (mut d, mut j) = (0i32, i);
                    while j < s.len() {
                        match s[j].as_str() {
                            "{" => d += 1,
                            "}" => {
                                d -= 1;
                                if d == 0 {
                                    break;
                                }
                            }
                            _ => {}
                        }
                        j += 1;
                    }
                    o.extend_from_slice(&s[..=i]);
                    o.extend(map_stmts(&s[i + 1..j], drop));
                    o.extend_from_slice(&s[j..]);
                }
                None => o.extend_from_slice(&s),
            }
        }
        o
    }

    // ---- top-level items ------------------------------------------------------

    type Key = (&'static str, String);

    /// Split a source into top-level items keyed by kind + name. `layout(...)`
    /// blocks, `#`-lines and `using namespace` are the resource preamble and are
    /// not items (see the module doc).
    fn items(toks: &[String]) -> BTreeMap<Key, Vec<String>> {
        let mut out = BTreeMap::new();
        let (mut i, n) = (0usize, toks.len());
        while i < n {
            let start = i;
            while i < n {
                if toks[i] == "{" {
                    i += 1;
                    let mut d = 1;
                    while i < n && d > 0 {
                        match toks[i].as_str() {
                            "{" => d += 1,
                            "}" => d -= 1,
                            _ => {}
                        }
                        i += 1;
                    }
                    if toks.get(i).map(String::as_str) == Some(";") {
                        i += 1;
                    }
                    break;
                }
                if toks[i] == ";" {
                    i += 1;
                    break;
                }
                i += 1;
            }
            let stmt = &toks[start..i];
            if stmt.is_empty() {
                break;
            }
            let head: Vec<&str> = stmt.iter().map(String::as_str).filter(|x| !matches!(*x, "static" | "inline")).collect();
            match head.first().copied() {
                None | Some("layout") | Some("using") | Some("precision") => {}
                Some("struct") => {
                    out.insert(("struct", head[1].to_string()), stmt.to_vec());
                }
                Some("const") | Some("constant") => {
                    out.insert(("const", head[2].to_string()), stmt.to_vec());
                }
                _ => {
                    if let (Some(p), true) = (head.iter().position(|x| *x == "("), head.contains(&"{")) {
                        out.insert(("fn", head[p - 1].to_string()), stmt.to_vec());
                    }
                }
            }
        }
        out
    }

    // ---- normalization tables -------------------------------------------------

    const TYPES: &[(&str, &str)] = &[
        ("vec2", "f2"),
        ("float2", "f2"),
        ("vec3", "f3"),
        ("float3", "f3"),
        ("packed_float3", "f3"),
        ("vec4", "f4"),
        ("float4", "f4"),
        ("ivec2", "i2"),
        ("int2", "i2"),
        ("ivec3", "i3"),
        ("int3", "i3"),
        ("ivec4", "i4"),
        ("int4", "i4"),
        ("uvec2", "u2"),
        ("uint2", "u2"),
        ("uvec3", "u3"),
        ("uint3", "u3"),
    ];
    const NAMES: &[(&str, &str)] =
        &[("skyCol", "sky"), ("hashp", "hash"), ("shade", "main"), ("tonemap", "main"), ("bake_probes", "main"), ("constant", "const"), ("lerp_", "lp")];
    /// File-scope constants MSL hoists that GLSL spells as literals.
    const EXPAND_CONST: &[(&str, &[&str])] = &[("PI", &["3.14159265"]), ("TWOPI", &["6.2831853"]), ("TIE", &["1.0", "/", "64.0"])];
    const SWIZ: &[(&str, &str)] = &[("r", "x"), ("g", "y"), ("b", "z"), ("a", "w"), ("rg", "xy"), ("rgb", "xyz"), ("rgba", "xyzw")];
    const CASTS: &[&str] = &["f2", "f3", "f4", "i2", "i3", "i4", "u2", "u3", "float", "int", "uint"];
    const INT_TYPES: &[&str] = &["i2", "i3", "i4", "u2", "u3", "int", "uint"];
    /// Names whose only role is addressing a buffer or image.
    const INDEX_TEMPS: &[&str] = &["q", "qa", "qb", "li", "idx"];
    const KEYWORDS: &[&str] = &["if", "for", "while", "return", "switch", "do", "else"];
    const DROP_QUALIFIERS: &[&str] = &["static", "inline", "readonly", "device", "thread", "out", "inout", "kernel", "precise"];

    /// Statements that set a ray query up — no common spelling between
    /// `rayQueryEXT` and `intersector<>`, so they are elided (module doc).
    const SETUP_STARTERS: &[&str] = &["rayQueryEXT", "rayQueryInitializeEXT", "intersector", "intersection_result", "ray", "isect", "rayQueryProceedEXT"];
    /// …and the hit ACCESSORS, mapped to one spelling so everything the trace
    /// DOES with a hit is still compared.
    const ACCESSORS: &[(&[&str], &str)] = &[
        (&["rayQueryGetIntersectionTypeEXT", "(", "rq", ",", "true", ")"], "HIT_TYPE"),
        (&["it", ".", "type"], "HIT_TYPE"),
        (&["gl_RayQueryCommittedIntersectionNoneEXT"], "HIT_NONE"),
        (&["intersection_type", "::", "none"], "HIT_NONE"),
        (&["rayQueryGetIntersectionTEXT", "(", "rq", ",", "true", ")"], "HIT_T"),
        (&["it", ".", "distance"], "HIT_T"),
        (&["rayQueryGetIntersectionInstanceCustomIndexEXT", "(", "rq", ",", "true", ")"], "HIT_INST"),
        (&["it", ".", "instance_id"], "HIT_INST"),
        (&["rayQueryGetIntersectionPrimitiveIndexEXT", "(", "rq", ",", "true", ")"], "HIT_PRIM"),
        (&["it", ".", "primitive_id"], "HIT_PRIM"),
        (&["rayQueryGetIntersectionBarycentricsEXT", "(", "rq", ",", "true", ")"], "HIT_BARY"),
        (&["it", ".", "triangle_barycentric_coord"], "HIT_BARY"),
    ];

    /// Per-pair resource names: an argument or parameter whose last token is one
    /// of these is dropped (MSL threads them; GLSL has globals). `px`/`gid`/
    /// `idx` are here too — they are this thread's texel address, spelled as a
    /// 2D image coordinate on one side and a flat buffer offset on the other.
    fn resources(pair: &str) -> &'static [&'static str] {
        match pair {
            "shade" => &["accel", "verts", "indices", "geoms", "mats", "lights", "pd", "pc", "outRadiance", "outAlbedo", "outPos", "tlas", "px", "idx", "gid"],
            "tonemap" => &["pc", "colorBuf", "albedoBuf", "posBuf", "outTex", "frame", "colorImg", "albedoImg", "posImg", "outImg", "gid"],
            _ => &["accel", "verts", "indices", "geoms", "mats", "lights", "pd", "pc", "tlas", "gid"],
        }
    }
    /// Storage objects → the one channel name both dialects reduce to.
    fn storage(pair: &str) -> &'static [(&'static str, &'static str)] {
        match pair {
            "shade" => &[
                ("colorImg", "RAD"),
                ("albedoImg", "ALB"),
                ("posImg", "POS"),
                ("outRadiance", "RAD"),
                ("outAlbedo", "ALB"),
                ("outPos", "POS"),
            ],
            "tonemap" => &[
                ("colorImg", "RAD"),
                ("albedoImg", "ALB"),
                ("posImg", "POS"),
                ("outImg", "OUT"),
                ("colorBuf", "RAD"),
                ("albedoBuf", "ALB"),
                ("posBuf", "POS"),
                ("outTex", "OUT"),
            ],
            _ => &[],
        }
    }
    /// Push-constant fields → SEMANTIC names. The two hosts pack `misc2`/`misc3`
    /// differently on purpose (shade.metal's header says so), so without this
    /// every push read would read as drift — and a WRONG entry here makes the
    /// bodies mismatch, so the table cannot lie quietly.
    fn pc_alias(pair: &str, msl: bool) -> &'static [(&'static str, &'static str, &'static str)] {
        match (pair, msl) {
            ("shade", false) => &[
                ("misc2", "x", "roomLights"),
                ("misc2", "y", "lightCount"),
                ("misc2", "z", "reflBlock"),
                ("misc2", "w", "floorCutY"),
                ("misc3", "x", "wallCutY"),
                ("misc3", "z", "aaWeight"),
                ("misc3", "w", "aaSample"),
            ],
            ("shade", true) => &[
                ("misc2", "x", "lightCount"),
                ("misc2", "y", "roomLights"),
                ("misc2", "z", "reflBlock"),
                ("misc3", "x", "floorCutY"),
                ("misc3", "y", "wallCutY"),
                ("misc3", "z", "aaWeight"),
                ("misc3", "w", "aaSample"),
            ],
            _ => &[],
        }
    }
    /// Declarations that only give a dialect-local NAME to something the twin
    /// spells inline; dropped, and their uses expanded by [`alias_expand`].
    fn alias_decls(pair: &str, msl: bool) -> &'static [&'static str] {
        match (pair, msl) {
            ("shade", false) => &["px", "TIE"],
            ("shade", true) => &["idx"],
            ("tonemap", true) => &["lowW", "lowH", "frame", "li"],
            ("probes", false) => &["gid"],
            _ => &[],
        }
    }
    fn alias_expand(pair: &str, msl: bool) -> &'static [(&'static str, &'static [&'static str])] {
        match (pair, msl) {
            ("shade", true) => &[("gid", &["px"])],
            ("tonemap", true) => &[
                ("lowW", &["pc", ".", "dims", ".", "x"]),
                ("lowH", &["pc", ".", "dims", ".", "y"]),
                ("frame", &["pc", ".", "fcfg", ".", "z"]),
                ("gid", &["gl_GlobalInvocationID", ".", "xy"]),
            ],
            _ => &[],
        }
    }

    /// A NAMED formatting divergence. `count` is how many times it must fire —
    /// an entry that stops matching FAILS, so this list cannot rot into a
    /// whitelist that quietly waves new differences through.
    struct Allow {
        pair: &'static str,
        item: &'static str,
        msl: bool,
        from: &'static [&'static str],
        to: &'static [&'static str],
        count: usize,
        /// why this is dialect formatting and not a difference in behaviour —
        /// printed when the entry stops matching, because "this rule no longer
        /// applies" is only actionable next to the reason it was written
        why: &'static str,
    }

    const ALLOW: &[Allow] = &[
        Allow {
            pair: "*",
            item: "sky",
            msl: true,
            from: &["f3", "c", "=", "(", "d", ".", "y", ">", "0", ")"],
            to: &["return", "(", "d", ".", "y", ">", "0"],
            count: 1,
            why: "MSL binds the sky ternary to a temp; the GLSL twin returns it inline. Same expression, same operands.",
        },
        Allow {
            pair: "*",
            item: "sky",
            msl: true,
            from: &[";", "return", "c", "*"],
            to: &[")", "*"],
            count: 1,
            why: "…the close of that same inline return.",
        },
        Allow {
            pair: "shade",
            item: "rtAO",
            msl: true,
            from: &["rr"],
            to: &["r"],
            count: 3,
            why: "the cosine-hemisphere radius is `r` in GLSL and `rr` in MSL (where `r` is the ray). A local name.",
        },
        Allow {
            pair: "shade",
            item: "trace",
            msl: true,
            from: &[";", "f3", "E1", "="],
            to: &[",", "E1", "="],
            count: 1,
            why: "GLSL declares the triangle's three edge vectors in one statement, MSL in three.",
        },
        Allow {
            pair: "shade",
            item: "trace",
            msl: true,
            from: &[";", "f3", "E2", "="],
            to: &[",", "E2", "="],
            count: 1,
            why: "(the third of them)",
        },
        Allow {
            pair: "shade",
            item: "aaGate",
            msl: true,
            from: &["<", "4", ";", "k", "++", ")", "{"],
            to: &["<", "4", ";", "k", "++", ")"],
            count: 1,
            why: "MSL braces the 4-neighbour loop because it names the clamped index; GLSL passes the same clamp inline to imageLoad.",
        },
        Allow {
            pair: "shade",
            item: "aaGate",
            msl: true,
            from: &["ALB", "[", "IDX", "]", ".", "w", ")", ";", "}"],
            to: &["ALB", "[", "IDX", "]", ".", "w", ")", ";"],
            count: 1,
            why: "(the close of that same block)",
        },
        Allow {
            pair: "shade",
            item: "aaGate",
            msl: true,
            from: &["f4", "Pa", "=", "POS", "[", "IDX", "]", ",", "Pb"],
            to: &["f4", "Pa", "=", "POS", "[", "IDX", "]", ";", "f4", "Pb"],
            count: 1,
            why: "GLSL declares the two probe samples in two statements, MSL in one.",
        },
        Allow {
            pair: "shade",
            item: "main",
            msl: false,
            from: &["f3", "col", ";"],
            to: &[],
            count: 1,
            why: "`col` is declared before the fog block in GLSL and after it in MSL; neither side reads it before assigning it.",
        },
        Allow {
            pair: "shade",
            item: "main",
            msl: true,
            from: &["f3", "col", ";"],
            to: &[],
            count: 1,
            why: "(the same declaration, the other side of the fog block)",
        },
        Allow {
            pair: "shade",
            item: "probeE",
            msl: true,
            from: &["if", "(", "dims", ".", "x", "<", "1", "||", "dims", ".", "y", "<", "1", "||", "dims", ".", "z", "<", "1", ")", "return", "0", ";"],
            to: &[],
            count: 1,
            why: "MSL-ONLY M1 bring-up guard: a dummy probe header (dims 0) returns black. \
                   Inert on any real bank — every shipped path binds a baked grid — and the last \
                   sibling of the `hasProbes` gate deleted 2026-07-28. Reported, not deleted: this \
                   box cannot compile MSL, and the round's bar is a byte-identical image.",
        },
        Allow {
            pair: "tonemap",
            item: "main",
            msl: true,
            from: &["f4", "s4", "=", "RAD", "[", "IDX", "]", ";", "acc", "+=", "s4", ".", "w", ">", "1", "?", "s4", ".", "xyz", "/", "s4", ".", "w", ":", "s4", ".", "xyz", ";"],
            to: &["f4", "q", "=", "RAD", "[", "IDX", "]", ";", "acc", "+=", "q", ".", "w", ">", "1", "?", "q", ".", "xyz", "/", "q", ".", "w", ":", "q", ".", "xyz", ";"],
            count: 1,
            why: "the contour-soften tap's sample is named `q` in GLSL and `s4` in MSL (where `q` is the clamped index).",
        },
        Allow {
            pair: "tonemap",
            item: "main",
            msl: false,
            from: &["pc", ".", "dims", ".", "zw"],
            to: &["f2", "(", "pc", ".", "dims", ".", "z", ",", "pc", ".", "dims", ".", "w", ")"],
            count: 1,
            why: "the vignette's visible-crop size: GLSL takes the .zw swizzle, MSL's int4 has no two-component swizzle.",
        },
        Allow {
            pair: "tonemap",
            item: "main",
            msl: false,
            from: &["uint", "fr", "=", "pc", ".", "fcfg", ".", "z", ";"],
            to: &[],
            count: 1,
            why: "GLSL names the frame index `fr` inside the analog-noise block; MSL already has it as the kernel-wide `frame`.",
        },
        Allow {
            pair: "tonemap",
            item: "main",
            msl: false,
            from: &["fr", "*", "31337"],
            to: &["pc", ".", "fcfg", ".", "z", "*", "31337"],
            count: 1,
            why: "(that name's luma-noise use)",
        },
        Allow {
            pair: "tonemap",
            item: "main",
            msl: false,
            from: &["fr", "*", "48611"],
            to: &["pc", ".", "fcfg", ".", "z", "*", "48611"],
            count: 1,
            why: "(and its chroma-noise use)",
        },
    ];

    /// Top-level items that legitimately exist on ONE side. Everything here is
    /// the resource preamble or a constant the other dialect spells as a
    /// literal (see [`EXPAND_CONST`]).
    const EXPECT_ONLY_MSL: &[(&str, &str, &str)] = &[
        ("shade", "struct", "Push"),
        ("shade", "const", "PI"),
        ("shade", "const", "TWOPI"),
        ("shade", "const", "TIE"),
        ("tonemap", "struct", "Push"),
        ("probes", "struct", "ProbePush"),
        ("probes", "const", "PI"),
        ("probes", "const", "TWOPI"),
    ];

    // ---- the normalizer -------------------------------------------------------

    fn lookup<'a>(table: &'a [(&'a str, &'a str)], k: &str) -> Option<&'a str> {
        table.iter().find(|(a, _)| *a == k).map(|(_, b)| *b)
    }

    fn storage_norm(t: &[String], store: &[(&str, &str)], msl: bool) -> Vec<String> {
        let (mut o, mut k) = (Vec::new(), 0usize);
        fn push(o: &mut Vec<String>, s: &[&str]) {
            o.extend(s.iter().map(|x| (*x).to_string()));
        }
        while k < t.len() {
            let x = t[k].as_str();
            if !msl && matches!(x, "imageLoad" | "imageStore") && t.get(k + 1).map(String::as_str) == Some("(") {
                let (args, nk) = split_call(t, k + 1);
                let name = lookup(store, args[0][0].as_str()).unwrap_or(args[0][0].as_str()).to_string();
                o.push(name);
                push(&mut o, &["[", "IDX", "]"]);
                if x == "imageStore" {
                    o.push("=".to_string());
                    o.extend(args[2].iter().cloned());
                }
                k = nk;
                continue;
            }
            if msl && x == "outTex" && t.get(k + 1).map(String::as_str) == Some(".") && t.get(k + 2).map(String::as_str) == Some("write") {
                let (args, nk) = split_call(t, k + 3);
                push(&mut o, &["OUT", "[", "IDX", "]", "="]);
                o.extend(args[0].iter().cloned());
                k = nk;
                continue;
            }
            if let (Some(chan), Some("[")) = (lookup(store, x), t.get(k + 1).map(String::as_str)) {
                let (mut d, mut j) = (0i32, k + 1);
                while j < t.len() {
                    match t[j].as_str() {
                        "[" => d += 1,
                        "]" => {
                            d -= 1;
                            if d == 0 {
                                break;
                            }
                        }
                        _ => {}
                    }
                    j += 1;
                }
                o.push(chan.to_string());
                push(&mut o, &["[", "IDX", "]"]);
                k = j + 1;
                continue;
            }
            o.push(t[k].clone());
            k += 1;
        }
        o
    }

    fn drop_res_groups(t: &[String], res: &[&str]) -> Vec<String> {
        let (mut o, mut k) = (Vec::<String>::new(), 0usize);
        while k < t.len() {
            let is_call = t[k] == "(" && o.last().is_some_and(|p| is_ident(p) && !KEYWORDS.contains(&p.as_str()));
            if is_call {
                let (args, nk) = split_call(t, k);
                o.push("(".to_string());
                let mut first = true;
                for a in args.iter().filter(|a| !a.last().is_some_and(|l| res.contains(&l.as_str()))) {
                    if !first {
                        o.push(",".to_string());
                    }
                    first = false;
                    o.extend(drop_res_groups(a, res));
                }
                o.push(")".to_string());
                k = nk;
                continue;
            }
            o.push(t[k].clone());
            k += 1;
        }
        o
    }

    /// GLSL's `TYPE[N](a, b, …)` array constructor → MSL's `{a, b, …}` (whose
    /// trailing comma also goes).
    fn array_ctor(t: &[String]) -> Vec<String> {
        let (mut o, mut k) = (Vec::new(), 0usize);
        while k < t.len() {
            let ctor = CASTS.contains(&t[k].as_str())
                && t.get(k + 1).map(String::as_str) == Some("[")
                && t.get(k + 3).map(String::as_str) == Some("]")
                && t.get(k + 4).map(String::as_str) == Some("(");
            if ctor {
                let (args, nk) = split_call(t, k + 4);
                o.push("{".to_string());
                for (j, a) in args.iter().enumerate() {
                    if j > 0 {
                        o.push(",".to_string());
                    }
                    o.extend(a.iter().cloned());
                }
                o.push("}".to_string());
                k = nk;
                continue;
            }
            if t[k] == "," && t.get(k + 1).map(String::as_str) == Some("}") {
                k += 1;
                continue;
            }
            o.push(t[k].clone());
            k += 1;
        }
        o
    }

    /// A single-argument vector/scalar constructor is a CAST or a SPLAT; both
    /// sides lose them (module doc: MSL needs casts GLSL does not).
    fn drop_casts(t: &[String]) -> Vec<String> {
        let (mut o, mut k) = (Vec::new(), 0usize);
        while k < t.len() {
            if CASTS.contains(&t[k].as_str()) && t.get(k + 1).map(String::as_str) == Some("(") {
                let (args, nk) = split_call(t, k + 1);
                if args.len() == 1 {
                    o.extend(drop_casts(&args[0]));
                    k = nk;
                    continue;
                }
            }
            o.push(t[k].clone());
            k += 1;
        }
        o
    }

    fn normalize(stmt: &[String], msl: bool, pair: &str, item: &str, misfires: &mut Vec<String>) -> Vec<String> {
        let mut t = stmt.to_vec();

        // the ENTRY POINT's parameter list IS the resource binding — nothing to compare
        if item == "main" {
            if let Some(p) = t.iter().position(|x| x == "(") {
                let (_, nk) = split_call(&t, p);
                let mut n: Vec<String> = t[..p].to_vec();
                n.push("(".into());
                n.push(")".into());
                n.extend_from_slice(&t[nk..]);
                t = n;
            }
        }
        t.retain(|x| !DROP_QUALIFIERS.contains(&x.as_str()));
        t = t
            .iter()
            .map(|x| lookup(TYPES, x).or_else(|| lookup(NAMES, x)).unwrap_or(x.as_str()).to_string())
            .collect();

        // `[[attribute]]`
        let (mut o, mut k) = (Vec::new(), 0usize);
        while k < t.len() {
            if t[k] == "[" && t.get(k + 1).map(String::as_str) == Some("[") {
                let mut d = 0i32;
                while k < t.len() {
                    match t[k].as_str() {
                        "[" => d += 1,
                        "]" => d -= 1,
                        _ => {}
                    }
                    k += 1;
                    if d == 0 {
                        break;
                    }
                }
                continue;
            }
            o.push(t[k].clone());
            k += 1;
        }
        t = o;

        // MSL template argument lists
        let (mut o, mut k) = (Vec::new(), 0usize);
        while k < t.len() {
            if t[k] == "<" && k > 0 && matches!(t[k - 1].as_str(), "intersector" | "intersection_result") {
                while k < t.len() && t[k] != ">" {
                    k += 1;
                }
                k += 1;
                continue;
            }
            o.push(t[k].clone());
            k += 1;
        }
        t = o;

        // reference declarators: `Hit& h` reads as GLSL's `out Hit h`. (No
        // expression in these sources has `ident & ident`, so this cannot eat a
        // bitwise AND — every one of them has a literal or a `)` on a side.)
        let (mut o, mut k) = (Vec::new(), 0usize);
        while k < t.len() {
            if t[k] == "&" && k > 0 && is_ident(&t[k - 1]) && t.get(k + 1).is_some_and(|n| is_ident(n)) {
                k += 1;
                continue;
            }
            o.push(t[k].clone());
            k += 1;
        }
        t = o;

        // ray-cast plumbing: collapse the MSL intersect call, elide the setup,
        // then map the hit accessors to one spelling
        let (mut o, mut k) = (Vec::new(), 0usize);
        while k < t.len() {
            if t[k] == "isect" && t.get(k + 1).map(String::as_str) == Some(".") && t.get(k + 2).map(String::as_str) == Some("intersect") {
                let (_, nk) = split_call(&t, k + 3);
                o.push("it".to_string());
                k = nk;
                continue;
            }
            o.push(t[k].clone());
            k += 1;
        }
        t = map_stmts(&o, &|s: &[String]| {
            let head = s[0].as_str();
            SETUP_STARTERS.contains(&head)
                || (head == "r" && s.get(1).map(String::as_str) == Some("."))
                || (head == "while" && s.iter().any(|x| x == "rayQueryProceedEXT"))
        });
        for (from, to) in ACCESSORS {
            t = seq_replace(&t, from, &[to]).0;
        }

        // dialect-local alias declarations, then storage access + its index temps
        let names = alias_decls(pair, msl);
        t = map_stmts(&t, &|s: &[String]| {
            let toks: Vec<&str> = s.iter().map(String::as_str).filter(|x| !matches!(*x, "const" | "constant")).collect();
            toks.len() >= 3 && is_ident(toks[0]) && names.contains(&toks[1]) && toks[2] == "="
        });
        t = storage_norm(&t, storage(pair), msl);
        t = map_stmts(&t, &|s: &[String]| {
            s.len() >= 3 && INT_TYPES.contains(&s[0].as_str()) && INDEX_TEMPS.contains(&s[1].as_str()) && s[2] == "="
        });

        // numbers, swizzles, hoisted constants
        t = t.iter().map(|x| if is_num(x) { numnorm(x) } else { x.clone() }).collect();
        let swz: Vec<String> = t
            .iter()
            .enumerate()
            .map(|(i, x)| match (i > 0 && t[i - 1] == ".", lookup(SWIZ, x)) {
                (true, Some(s)) => s.to_string(),
                _ => x.clone(),
            })
            .collect();
        t = swz;
        let mut o = Vec::new();
        for x in &t {
            match EXPAND_CONST.iter().find(|(n, _)| n == x) {
                Some((_, e)) => o.extend(e.iter().map(|s| (*s).to_string())),
                None => o.push(x.clone()),
            }
        }
        t = o;

        // push-constant field semantics
        let pca = pc_alias(pair, msl);
        let (mut o, mut k) = (Vec::new(), 0usize);
        while k < t.len() {
            let sem = if t[k] == "pc" && t.get(k + 1).map(String::as_str) == Some(".") && t.get(k + 3).map(String::as_str) == Some(".") && t.len() > k + 4 {
                pca.iter().find(|(b, c, _)| *b == t[k + 2] && *c == t[k + 4]).map(|(_, _, s)| *s)
            } else {
                None
            };
            match sem {
                Some(s) => {
                    o.push(format!("PC_{s}"));
                    k += 5;
                }
                None => {
                    o.push(t[k].clone());
                    k += 1;
                }
            }
        }
        t = o;

        t = array_ctor(&t);
        t = drop_casts(&t);
        t = drop_res_groups(&t, resources(pair));

        // alias expansion runs LAST of the name passes, so a threaded resource
        // parameter is dropped above by its ORIGINAL name
        let exp = alias_expand(pair, msl);
        let mut o = Vec::new();
        for x in &t {
            match exp.iter().find(|(n, _)| n == x) {
                Some((_, e)) => o.extend(e.iter().map(|s| (*s).to_string())),
                None => o.push(x.clone()),
            }
        }
        t = o;

        for a in ALLOW.iter().filter(|a| (a.pair == pair || a.pair == "*") && a.item == item && a.msl == msl) {
            let (n, count) = seq_replace(&t, a.from, a.to);
            if count != a.count {
                let side = if msl { "msl" } else { "glsl" };
                misfires.push(format!(
                    "allowlist [{}/{}/{side}] {:?} fired {count}x, expected {}x — it was written because: {}",
                    a.pair,
                    a.item,
                    a.from.join(" "),
                    a.count,
                    a.why
                ));
            }
            t = n;
        }
        t
    }

    fn show(t: &[String]) -> String {
        t.join(" ")
    }

    /// Where two token streams first part company, with context — a diff
    /// message a reader can act on.
    fn first_divergence(a: &[String], b: &[String]) -> String {
        let i = a.iter().zip(b).position(|(x, y)| x != y).unwrap_or(a.len().min(b.len()));
        let lo = i.saturating_sub(12);
        format!("    …{}\n    GLSL: {}\n     MSL: {}", show(&a[lo..i]), show(&a[i..(i + 16).min(a.len())]), show(&b[i..(i + 16).min(b.len())]))
    }

    fn keyed(src: &str) -> BTreeMap<Key, Vec<String>> {
        items(&tokenize(&strip_comments(src)))
            .into_iter()
            .map(|(k, v)| ((k.0, lookup(NAMES, &k.1).unwrap_or(k.1.as_str()).to_string()), v))
            .collect()
    }

    /// THE GUARD. Both twins of all three pairs must normalize to the SAME
    /// token stream, item for item. See the module doc for the normalization
    /// and for what it deliberately does not cover.
    #[test]
    fn twins_are_structurally_identical() {
        let mut fails: Vec<String> = Vec::new();
        for (pair, glsl_src, msl_src) in super::twin_pairs() {
            let g = keyed(glsl_src);
            let m = keyed(msl_src);
            assert!(g.len() > 5 && m.len() > 5, "{pair}: the item scanner found almost nothing — it stopped parsing these sources");

            for k in g.keys().filter(|k| !m.contains_key(*k)) {
                fails.push(format!("{pair}: {} `{}` exists ONLY in the GLSL twin", k.0, k.1));
            }
            for k in m.keys().filter(|k| !g.contains_key(*k)) {
                if EXPECT_ONLY_MSL.contains(&(pair, k.0, k.1.as_str())) {
                    continue;
                }
                fails.push(format!("{pair}: {} `{}` exists ONLY in the MSL twin", k.0, k.1));
            }
            for (k, gv) in &g {
                let Some(mv) = m.get(k) else { continue };
                let mut misfires = Vec::new();
                let a = normalize(gv, false, pair, &k.1, &mut misfires);
                let b = normalize(mv, true, pair, &k.1, &mut misfires);
                for s in misfires {
                    fails.push(format!("{pair}: {s}"));
                }
                if a != b {
                    fails.push(format!("{pair}: {} `{}` DIFFERS between the twins\n{}", k.0, k.1, first_divergence(&a, &b)));
                }
            }
        }
        assert!(
            fails.is_empty(),
            "the GLSL and MSL twins are not the same program:\n{}\n\n\
             Port the change to BOTH sources. If the difference is genuine dialect formatting, \
             add a NAMED entry to wear::twin::ALLOW saying why.",
            fails.join("\n")
        );
    }

    /// The normalizer must not be a shredder: if it collapsed everything to
    /// nothing — or if the item scanner quietly stopped finding functions — the
    /// equality above would hold VACUOUSLY on both sides at once, which the
    /// "only in one twin" check cannot see. So pin how much is actually
    /// compared, per pair, that real constants survive it, and that a
    /// one-literal change to ONE twin parts the streams.
    #[test]
    fn the_normalizer_keeps_the_math_it_is_supposed_to_compare() {
        // (items, tokens) floors — the shipped sources are well above each;
        // a fall through one means the scanner or the normalizer regressed,
        // not that a shader shrank.
        for ((pair, glsl_src, _), (min_items, min_toks)) in super::twin_pairs().into_iter().zip([(20, 3500), (12, 1800), (10, 900)]) {
            let g = keyed(glsl_src);
            let mut misfires = Vec::new();
            let toks: usize = g.iter().map(|(k, v)| normalize(v, false, pair, &k.1, &mut misfires).len()).sum();
            assert!(misfires.is_empty(), "{pair}: {misfires:?}");
            assert!(g.len() >= min_items, "{pair}: only {} top-level items found (floor {min_items}) — the item scanner regressed", g.len());
            assert!(toks >= min_toks, "{pair}: only {toks} tokens compared (floor {min_toks}) — the normalizer is eating the program");
        }

        let (_, glsl_src, msl_src) = super::twin_pairs()[0];
        let key = ("fn", "main".to_string());
        let mut misfires = Vec::new();
        let a = normalize(&keyed(glsl_src)[&key], false, "shade", "main", &mut misfires);
        assert!(misfires.is_empty(), "{misfires:?}");
        assert!(a.len() > 1500, "the shade kernel normalizes to {} tokens — the normalizer is eating the program", a.len());
        let joined = show(&a);
        for frag in ["story * 7 + 3", "0.78 , 0.7 , 0.58", "0.16 * rise", "0.52 , 0.42 , 0.33", "smoothstep ( 0 , 0.07 , edF )"] {
            assert!(joined.contains(frag), "{frag:?} did not survive normalization — the guard would be blind to it");
        }
        // …and a single mutated literal in ONE twin must part the streams
        let mutated = msl_src.replace("float3(0.78, 0.70, 0.58)", "float3(0.70, 0.70, 0.58)");
        assert_ne!(mutated, msl_src, "the mutation probe no longer matches shade.metal — update it");
        let b = normalize(&keyed(&mutated)[&key], true, "shade", "main", &mut misfires);
        assert_ne!(a, b, "a changed stain tint in one twin normalized away — the guard is blind");
    }
}
