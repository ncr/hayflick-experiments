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
//! - lane 1 — **FIELD LEVEL**: the per-RUN offset that normalizes the macro
//!   damage field's LEVEL, read by the shade pass's `dmgN` and mirrored by
//!   `crack_geom::CrazeCfg::dmg`. Claimed 2026-07-25 to fix the un-ageable
//!   facade (see [`level_quantize`] for the whole argument). This lane is the
//!   one exception to "6-bit unorm": it carries a 6-bit **two's-complement**
//!   code in units of [`LEVEL_STEP`], because the empty word has to mean
//!   *no normalization* — a unorm lane would decode an unstamped material to
//!   the range's low end and silently un-age it.
//! - lanes 2..3 — **UNCLAIMED**. The effect that takes one names it HERE, in
//!   this comment, so two effects can never quietly land on the same bits.
//!
//! The unpack both shader twins must copy verbatim — one spelling, both
//! dialects: MSL takes `.a` exactly as GLSL does (rgba swizzles are legal on an
//! MSL float4), and the twin-pin test below matches that literal, so a port that
//! spells it `.w` fails the build with a message about the SHIFT:
//!
//! ```glsl
//! uint  ew    = uint(m.emissive.a);            // the effect word
//! float epoch = float( ew        & 63u) * (1.0/63.0);
//! int   lvlC  = int((ew >>  6) & 63u);         // lane 1 is SIGNED (see above)
//! float dOff  = float(lvlC >= 32 ? lvlC - 64 : lvlC) * 0.012; // LEVEL_STEP
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
//! # The two shapes of "host and shader agree"
//!
//! The story key is ONE WRITER, TWO READERS: it lands in the `Scene` and both
//! `crack_geom::story_of` and the shade pass read the same f32 bits, so there is
//! no mirror at all. A lane that the HOST also consumes cannot do that — the
//! word streams after the build, and the geometry pass runs before it — so lane
//! 1 is ONE FUNCTION, TWO CALLERS instead: `crack_geom::run_level` returns the
//! offset already passed through [`level_quantize`], the geometry pass adds
//! exactly that, and the shader decodes exactly that from the lane. The only
//! mirrored thing left is [`LEVEL_STEP`] and the shape of the decode, and
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

/// FNV-1a over a RUN's quantized authoring rect. `salt` separates the
/// independent per-run draws — the story key (salt 0) and the field level's
/// damaged FRACTION ([`LEVEL_SALT`]) — so two draws off one run can never
/// alias into the same value. Salt 0 reproduces the story key's original hash
/// byte for byte (`0 ^ basis == basis`), which is load-bearing: the key seeds
/// every damage pattern in the level and the probe cache hashes it.
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

/// Lane index of the field level in the effect word (see the module doc).
pub const LEVEL_LANE: usize = 1;

/// Quantization step of the level offset, in damage-field units. Six bits
/// signed span −0.384..+0.372, and the gym's seven runs need −0.132..+0.240, so
/// the range carries ~50 % headroom for other levels and looks (a needed offset
/// past the end clamps, which merely leaves that run partly normalized). The
/// step is 20 % of the craze zone's 0.06-wide gate window: the residual level
/// error is ≤0.006, i.e. ≤3 % of a face's damaged area — nothing next to the
/// 0.43 of field level it removes.
pub const LEVEL_STEP: f32 = 0.012;

/// The reference AGE the level is normalized at (see [`level_fraction`]). 0.6
/// is mid-slider and just above the crack-lab demo's own base age (0.55), so
/// the boot view reads as drawn and the knob still has somewhere to go in both
/// directions.
pub const LEVEL_AGE_REF: f32 = 0.6;

/// The damaged-area band a run's level is normalized INTO, at
/// [`LEVEL_AGE_REF`]. Calibrated, not chosen: over the crack-lab gym's seven
/// runs this band leaves the level's MEAN damaged area where the owner last saw
/// it (0.152 → 0.180 of a face at the reference age) while deleting both tails —
/// the min goes 0.000 → 0.118 (no un-ageable facade) and the max 0.423 → 0.247
/// (no facade wrecked at age 0.3). The 4× spread between the ends is what keeps
/// the runs from reading equally damaged: normalizing the LEVEL must flatten the
/// lottery, never the variety.
pub const LEVEL_FRACTION: (f32, f32) = (0.06, 0.24);

/// Salt of the fraction draw ([`run_hash`]) — any value the story key does not
/// use; this one is arbitrary and only has to stay put.
const LEVEL_SALT: u32 = 0x5bf0_3635;

/// How much of THIS run's face should be inside the craze zone at
/// [`LEVEL_AGE_REF`] — drawn per run inside [`LEVEL_FRACTION`].
///
/// Drawing the TARGET (rather than normalizing every run to one constant) is
/// what keeps a facade's story: one wall is a bad wall and the next is a tired
/// one, and inside each the age ramp (`crack::run_ramp`) still gives it a bad
/// end and a clean end. What the normalization deletes is only the part that
/// was never authored — the amplitude of one fbm draw.
pub fn level_fraction(run_lo: Vec3, run_hi: Vec3) -> f32 {
    let u = (run_hash(run_lo, run_hi, LEVEL_SALT) & 1023) as f32 / 1023.0;
    LEVEL_FRACTION.0 + (LEVEL_FRACTION.1 - LEVEL_FRACTION.0) * u
}

/// The 6-bit two's-complement code that carries `off`.
fn level_code(off: f32) -> i32 {
    (off / LEVEL_STEP).round().clamp(-32.0, 31.0) as i32
}

/// The offset the shader will actually add for `off` — the host MUST add this
/// and never `off` itself. The two are one datum measured on one side of the
/// bus and applied on both, and this is the function that makes them equal:
/// the geometry pass and the paint pass drifting apart is the exact failure
/// docs/AGENT_LEARNINGS.md records twice (the fault spine, the craze lattice).
pub fn level_quantize(off: f32) -> f32 {
    level_code(off) as f32 * LEVEL_STEP
}

/// The dial value that parks `off` in [`LEVEL_LANE`] of an [`Effect`].
/// Signed-code, not unorm: code 0 (the empty word, hence any material nobody
/// stamped) means *no normalization*, which is the only safe default.
pub fn level_dial(off: f32) -> f32 {
    (level_code(off) & 63) as f32 / DIAL_MAX
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
/// `levels[i]` is pier `i`'s FIELD LEVEL offset (`crack_geom::run_levels`), a
/// per-RUN datum: it lands in [`LEVEL_LANE`] on the pier and its core, so the
/// crack floors normalize with the wall around them. A missing or 0.0 entry
/// stamps no level, which is why an unknobbed level (the plain gym) writes
/// nothing at all.
pub fn stamp_all(scene: &mut Scene, piers: &[Pier], cores: &[i32], levels: &[f32], base: Effect) -> Vec<(usize, f32)> {
    let mut out = Vec::new();
    for (i, pier) in piers.iter().enumerate() {
        let mut e = base;
        e.dials[LEVEL_LANE] = level_dial(levels.get(i).copied().unwrap_or(0.0));
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
/// [`LEVEL_LANE`] is DERIVED per run, so its component here is ignored.
pub fn seed_from_env() -> Option<Effect> {
    std::env::var("WEAR").ok().map(|v| parse_seed(&v))
}

/// `WEAR_LEVEL=0` turns the per-run field-level normalization OFF (default on)
/// — the harness A/B for lane 1. It zeroes the offset at the ONE place both
/// readers get it from, so "off" is bit-identical to the code before the lane
/// existed; that is what makes the before/after SHOT pair meaningful instead of
/// a comparison against a stale build.
pub fn level_enabled() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("WEAR_LEVEL").map(|v| v.trim() != "0").unwrap_or(true))
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
        let levels = crate::crack_geom::run_levels(&self.scene, &self.piers, &self.crack.knobs);
        let changed = stamp_all(&mut self.scene, &self.piers, &self.crack.cores, &levels, self.wear);
        // silent when nothing changed (the plain gym boot: no knobs, so no field
        // level and an empty word); otherwise say it, because a harness knob you
        // cannot see fire is a harness knob you cannot trust
        if !changed.is_empty() {
            let n = levels.iter().filter(|l| **l != 0.0).count();
            println!("wear: effect word streamed to {} materials (base dials {:?}, field level on {n} piers)", changed.len(), self.wear.dials);
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
        let flat = [0.0; 2]; // no field-level normalization on these piers
        assert!(stamp_all(&mut scene, &piers, &cores, &flat, Effect::default()).is_empty(), "the empty word is already there — nothing to stream");
        let e = Effect { dials: [0.5, 0.0, 0.0, 0.25] };
        let changed = stamp_all(&mut scene, &piers, &cores, &flat, e);
        assert_eq!(changed.len(), 3, "two piers + one core");
        for (mid, w) in &changed {
            assert_eq!(scene.materials[*mid].emissive[3], *w, "the CPU shadow and the streamed value agree");
            assert_eq!(*w, e.word());
        }
        assert!(stamp_all(&mut scene, &piers, &cores, &flat, e).is_empty(), "re-stamping the same word streams nothing");
    }

    /// LANE 1's whole reason to be signed: the empty word — every material
    /// nobody stamped, including any core a future generator mints — must decode
    /// to NO normalization. A unorm lane would hand it the range's low end and
    /// silently un-age it, which is the failure this lane exists to fix, applied
    /// to itself. Also pins the two-sided range and the host/shader mirror
    /// (`level_quantize` IS what the decode of `level_dial` yields).
    #[test]
    fn the_level_lane_is_signed_so_an_unstamped_material_is_not_normalized() {
        let decode = |dial: f32| {
            let code = (Effect { dials: [0.0, dial, 0.0, 0.0] }.word() as u32 >> 6) & 63;
            (if code >= 32 { code as i32 - 64 } else { code as i32 }) as f32 * LEVEL_STEP
        };
        assert_eq!(decode(0.0), 0.0, "the empty word means NOT normalized");
        assert_eq!(level_dial(0.0), 0.0, "…and a zero offset stamps the empty lane");
        for off in [-0.5, -0.37, -0.24, -0.132, -0.012, 0.0, 0.012, 0.1, 0.24, 0.37, 0.9] {
            let q = level_quantize(off);
            assert_eq!(decode(level_dial(off)), q, "host and shader must decode ONE value for {off}");
            assert!((q - off).abs() <= 0.5 * LEVEL_STEP || off.abs() > 32.0 * LEVEL_STEP, "{off} quantized to {q}");
        }
        // the gym's measured need is −0.132..+0.240; both ends fit with margin
        assert!(level_quantize(-0.132) < -0.12 && level_quantize(0.240) > 0.23);
        // …and past the ends it CLAMPS (a partly normalized run, never a wrapped
        // sign — a wrap would age the dead facade backwards)
        assert_eq!(level_quantize(9.0), 31.0 * LEVEL_STEP);
        assert_eq!(level_quantize(-9.0), -32.0 * LEVEL_STEP);
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
            // the SHIFT (lane 1 = bits 6..11) and the 6-bit mask
            assert!(has("emissive.a) >> 6) & 63u"), "{name}: lane 1's bit position moved");
            // the SIGNED decode — a unorm read would un-age every unstamped surface
            assert!(has("lvlC >= 32 ? lvlC - 64 : lvlC"), "{name}: the two's-complement decode is gone");
            // the STEP, spelled as the host spells it
            assert!(has(&format!("lvlC) * {LEVEL_STEP};")), "{name}: LEVEL_STEP drifted from the host's {LEVEL_STEP}");
            // …and it actually reaches the field
            assert!(lines.iter().any(|l| l.contains("float dmgN") && l.contains("+ dOff")), "{name}: dmgN does not take the offset");
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

    /// Source fragments that must NOT appear in either twin. Empty until a cull
    /// lands; see the note in the guard above for why the empty list still has
    /// to exist rather than being added when it is first needed.
    const FORBIDDEN: &[&str] = &[];

    /// `WEAR=` parsing: leading components in lane order, missing tails read 0.
    #[test]
    fn parse_seed_reads_lanes_in_order() {
        assert_eq!(parse_seed("0.5"), Effect { dials: [0.5, 0.0, 0.0, 0.0] });
        assert_eq!(parse_seed("0.1, 0.2 ,0.3,0.4"), Effect { dials: [0.1, 0.2, 0.3, 0.4] });
        assert_eq!(parse_seed(""), Effect::default(), "a junk value is the empty word, never a panic");
    }
}
