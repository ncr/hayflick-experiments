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
//!   FULL: the next paint dial goes to `_pad` lanes 2/3, and after those to
//!   the per-material aux buffer this codec's budget notes keep promising.
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
//! `both_shader_twins_decode_the_level_lane_exactly_as_the_host_packs_it` reads
//! both shader sources at compile time so neither can drift silently. Any future
//! lane the host reads too must follow the same discipline: quantize on the host,
//! never hand the shader a value the host did not round first.
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
    (run_hash(run_lo, run_hi, 0) & 255) as f32 * 0.618
}

/// FNV-1a over a RUN's quantized authoring rect. `salt` is here to separate
/// INDEPENDENT per-run draws so two of them can never alias into the same value;
/// only salt 0 (the story key) has a caller today — the field level's damaged
/// fraction was the second one, and solved thresholds retired it. Salt 0
/// reproduces the story key's original hash byte for byte
/// (`0 ^ basis == basis`), which is load-bearing: the key seeds every damage
/// pattern in the level, every break in it, and the probe cache hashes it.
fn run_hash(run_lo: Vec3, run_hi: Vec3, salt: u32) -> u32 {
    let mut h: u32 = 0x811c_9dc5 ^ salt;
    for v in [run_lo.x, run_lo.z, run_hi.x, run_hi.z] {
        h ^= (v * 10.0).round() as i32 as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
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

// ---- lane 1: the damage field's per-RUN LEVEL -------------------------------
//
// THE DEFECT this fixes (measured 2026-07-25, on the gym's own seven runs):
// the shade pass's `dmgN` is a raw fbm and every feature gate is an ABSOLUTE
// threshold on it (`dT = mix(0.74, 0.55, age)`, the craze zone at `dT + 0.02`,
// cracks at `dT - 0.10`). An fbm sampled over one facade is only ~2 cells of
// its dominant octave wide, so its LEVEL is a lottery per draw — and since the
// field went per-RUN ("one wall, one story") there is now ONE draw per facade
// instead of one per panel. Over the crack-lab gym the runs' 98th percentiles
// spread from 0.49 to 0.92: the x=8 facade was wrecked at age 0.3 while the
// z=8 run behind the doorway never cleared the zone gate AT ANY AGE — an
// un-ageable facade, and the owner dials to max first.
//
// The fix is a per-run LEVEL offset, generated host-side where the whole face
// can be sampled and carried here so the shade pass adds the same number.

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

    #[test]
    fn atmosphere_transport_matches_between_backends() {
        let bodies: Vec<String> = twin_sources().iter().map(|(_, source)| {
            let start = source.find("if (pc.env0.z > 0.0)").unwrap();
            let tail = &source[start..];
            let end = tail.find("\n\n").unwrap();
            code_lines(&tail[..end]).join("\n")
                .replace("float3", "vec3").replace("float2", "vec2")
                .replace(", accel", "").split_whitespace().collect::<String>()
        }).collect();
        assert_eq!(bodies[0], bodies[1], "Metal and GLSL must integrate the same air");
    }

    #[test]
    fn painted_stains_cannot_escape_the_authored_region() {
        for (name, src) in twin_sources() {
            let code = code_lines(src).join("\n");
            assert!(!code.contains("0.20 + 0.80 * stainW"),
                "{name}: a stain still has 20% coverage outside its mask");
            assert!(code.contains("skin * aStain * stainW *"),
                "{name}: every stain must be gated by the solved region");
        }
    }

    #[test]
    fn procedural_surface_math_matches_between_backends() {
        let twins = twin_sources();
        // Compare executable expressions, not merely the presence of a few
        // names: changing a frequency, mask or filter in just one twin fails.
        let normalized = |src: &str, start: &str, end: &str| {
            let block = src.split_once(start).expect(start).1.split_once(end).expect(end).0;
            block.lines().map(|l| l.split("//").next().unwrap_or("")).collect::<String>()
                .replace("float3", "vec3").replace("float2", "vec2")
                .split_whitespace().collect::<String>()
        };
        for (start, end) in [
            ("// SURFACE MATERIALS:", "bool greybox ="),
            ("float webHalf =", "// MUD SPLASH"),
            ("float soil =", "deposit = max(deposit, mudDensity);"),
        ] {
            assert_eq!(normalized(twins[0].1, start, end), normalized(twins[1].1, start, end), "surface twins diverged at {start}");
        }
        let body_flags = crate::flags::MATTE | crate::flags::CRAZE;
        for (name, src) in twins {
            assert!(src.contains(&format!("& {body_flags}u) == {body_flags}u")), "{name}: exposed-body classification drifted");
            assert!(src.contains("reff = mix(reff, max(reff, 0.82), deposit)"), "{name}: dry paint must affect roughness too");
            assert!(!src.contains("step(cellF, aWeb"), "{name}: cell lottery breaks fine-line continuity");
        }
    }

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

    /// LANE 1's whole reason to be signed: the empty word — every material
    /// nobody stamped, including any core a future generator mints — must decode
    /// to NO normalization. A unorm lane would hand it the range's low end and
    /// silently un-age it, which is the failure this lane exists to fix, applied
    /// to itself. Also pins the two-sided range and the host/shader mirror
    /// AN UNSTAMPED MATERIAL MUST DECODE TO NOTHING — the property the signed
    /// level lane existed to guarantee, now a property of the CODEC instead.
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
        assert_eq!(crate::wall::gate_code(crate::wall::GATE_EMPTY), 0);
        let e = Effect::default();
        assert_eq!(e.word(), 0.0, "the empty word must be exactly 0.0");
        assert_eq!(e.dials[STAIN_LANE], 0.0);
        assert_eq!(e.dials[WEB_LANE], 0.0);
        // …and the top of the range is reachable, which the signed lane's clamp
        // could not promise on a low-level run
        assert_eq!(crate::wall::gate_code(crate::wall::GATE_FULL), 63);
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

    /// THE MIRROR PIN. Lane 1's value is measured on the host and applied on
    /// BOTH sides — `CrazeCfg::dmg` cuts the plates with it, the shade pass
    /// paints with it — so the two `LEVEL_STEP`s drifting apart separates the
    /// geometry from the paint, which docs/AGENT_LEARNINGS.md records twice as
    /// the failure mode of this codebase. Host constants cannot be shared into
    /// GLSL/MSL, so the next best thing is to READ the twins and refuse to build
    /// if either stops spelling this exact decode. Both are read at compile time,
    /// so this also catches the classic "ported one twin only".
    #[test]
    fn both_shader_twins_decode_the_level_lane_exactly_as_the_host_packs_it() {
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
            assert!(has(&format!("{:.2} - float", crate::wall::GATE_HI)), "{name}: GATE_HI drifted from the host's {}", crate::wall::GATE_HI);
            assert!(has(&format!("* {:.3};", crate::wall::GATE_STEP)) || has(&format!("* {:.3};  //", crate::wall::GATE_STEP)), "{name}: GATE_STEP drifted from the host's {}", crate::wall::GATE_STEP);
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
    ];
    // `_pad` lanes 2/3 (`>> 20` / `>> 26`) left this table on 2026-07-27:
    // MUD claimed them (crack::pad_bits), and their decodes are REQUIRED now.

}
