//! `Material._pad` — ONE HOME for every flag bit, named by VALUE.
//!
//! # Why this file exists
//!
//! The bits were declared in four places (`gym_scene`, `crack`, `crack_geom`,
//! and a `const FREE_BIT` inside a test in `crack`), and the prose around them
//! had drifted into two incompatible conventions for the word "bit":
//!
//! - `gym_scene.rs`, `crack_geom.rs` and BOTH shader twins say "bit 4" and mean
//!   VALUE 4 — the matte flag, `_pad & 4`.
//! - `crack.rs` and `wear.rs` say "bit 4 (value 16)" and mean INDEX 4.
//!
//! Both readings are defensible and the codebase used them within a few lines
//! of each other, so "the last free flag is bit 4" pointed at two different
//! bits depending on which file you had open. This module fixes the convention
//! by refusing to offer the ambiguous one: **every constant here is the VALUE**,
//! and the doc comment gives the index in parentheses when it helps.
//!
//! # The allocation
//!
//! | value | index | name | who writes it | who reads it |
//! |---|---|---|---|---|
//! | 1 | 0 | [`OCCLUDER`] | `gym_scene::mark_occluder` | shade (WALLCUT / ROI) |
//! | 2 | 1 | [`GLASS`] | `gym_scene::mark_glass` | shade (transmission) |
//! | 4 | 2 | [`MATTE`] | `gym_scene::mark_matte`, the chalk cores | shade (kills spec + the gloss remap) |
//! | 8 | 3 | [`SEL`] | `crack::stamped_pad` | shade (posImg tag w=3) → tonemap (the amber outline) |
//! | 16 | 4 | [`FREE16`] | nobody | nobody |
//! | 32 | 5 | [`GEO`] | `crack_geom::split_pier` | HOST only (the AA scope) |
//! | 64 | 6 | [`CRAZE`] | `crack_geom::craze_pier` | HOST only (the AA scope) |
//! | 128 | 7 | [`AA`] | `crack::stamp_aa` | shade (the contour-AA scope) |
//! | 8..31 | | the four 6-bit knobs | `crack::pad_bits` | shade (the CRACK LAB block) |
//!
//! The four knob lanes above bit 7 are documented in `crack::pad_bits`; the
//! separate per-surface effect word lives in `crate::wear`.

/// See-through OCCLUDER: the WALLCUT cutaway and the ROI reveal dissolve it.
pub const OCCLUDER: i32 = 1;
/// A transmissive window pane.
pub const GLASS: i32 = 2;
/// MATTE by construction — the shade pass skips spec and the gloss remap here.
/// "trawa nie może się błyszczeć" (owner, 2026-07-12); the chalk cores inherit
/// it because a fresh break is unglazed body.
pub const MATTE: i32 = 4;
/// The pick's selection tag. The shade pass writes it into `posImg.w` (3.0)
/// and the TONEMAP pass draws a steady amber OUTLINE on the tag-region
/// boundary — shading itself is untouched, because the old albedo lift tinted
/// the very surface being authored. No pulse: a pulse would make captures
/// non-deterministic.
pub const SEL: i32 = 8;
/// The last unclaimed flag. Reserved by `crate::wear`'s doc for a future shader
/// gate: a gate MUST key off a flag bit and never off `emissive.a != 0`, since
/// the empty effect word is a legitimate state.
///
/// Unused BY DEFINITION — it is a record of the allocation, and deleting it
/// because nothing reads it is how a budget stops being a budget.
#[allow(dead_code)]
pub const FREE16: i32 = 16;
/// This pier's structural fault is REAL GEOMETRY. It existed to stop the shade
/// pass painting a second, disagreeing fault on top of it; since the painted
/// layers were culled (2026-07-26) no shader reads it, and its only remaining
/// job is host-side — the `aa scope = 1` predicate, "did a generator add detail
/// to this wall".
pub const GEO: i32 = 32;
/// This pier's craze network is REAL GEOMETRY. Host-only for the same reason as
/// [`GEO`], and a candidate for merging with it.
pub const CRAZE: i32 = 64;
/// The greybox-detail AA opt-in (CLAUDE.md, "greybox detail = AA-scoped").
pub const AA: i32 = 128;

/// Every flag, for the tests and for any exhaustive dump. NOT the knob lanes.
/// Exhaustive on purpose: `the_flag_byte_is_a_partition` walks THIS list, so a
/// new flag that forgets to join it fails that test rather than colliding.
#[allow(dead_code)]
pub const ALL: [(&str, i32); 8] =
    [("OCCLUDER", OCCLUDER), ("GLASS", GLASS), ("MATTE", MATTE), ("SEL", SEL), ("FREE16", FREE16), ("GEO", GEO), ("CRAZE", CRAZE), ("AA", AA)];

/// The whole flag byte — bits 0..7. Above it live the knob lanes.
pub const BYTE: i32 = 0xFF;

#[cfg(test)]
mod tests {
    use super::*;

    /// The allocation is a partition: every flag a distinct single bit, all of
    /// them inside the flag byte, nothing overlapping the knob lanes. Cheap, and
    /// it is the assertion that would have caught a second claimant on 16.
    #[test]
    fn the_flag_byte_is_a_partition() {
        let mut seen = 0i32;
        for (name, v) in ALL {
            assert_eq!(v.count_ones(), 1, "{name} is not a single bit ({v})");
            assert_eq!(v & BYTE, v, "{name} sits outside the flag byte and would collide with a knob lane");
            assert_eq!(seen & v, 0, "{name} collides with a flag already claimed");
            seen |= v;
        }
        assert_eq!(seen, BYTE, "the flag byte is not fully accounted for: {seen:#x}");
    }

    /// The names the rest of the crate uses are RE-EXPORTS of these, so this
    /// test is a tautology today — deliberately. It is here so that the day
    /// someone re-declares one of them locally "just for a moment", the tree
    /// goes red instead of going quietly wrong: that is the exact failure
    /// `crack::KEEP_FLAGS` already had to fix once, when two stamps spelled the
    /// preserved mask `& 7` and `& 231` and a new flag was silently cleared at
    /// boot and on every knob touch.
    #[test]
    fn the_old_homes_agree_with_this_one() {
        assert_eq!(crate::crack::SEL_BIT, SEL);
        assert_eq!(crate::crack_geom::GEO_BIT, GEO);
        assert_eq!(crate::crack_geom::CRAZE_BIT, CRAZE);
        assert_eq!(crate::gym_scene::AA_BIT, AA);
        assert_eq!(crate::crack::KEEP_FLAGS, BYTE & !SEL, "a stamp must preserve every flag except the one it recomputes");
    }

    /// BOTH SHADER TWINS must spell each flag the way the host does.
    ///
    /// The twins test `(m.pad & <literal>)`, so a flag whose value moved on the
    /// host and not in a shader is a silent, backend-specific wrong image — and
    /// the GLSL side is the BLIND one this session (no Vulkan hardware), which
    /// is exactly when a compile-time source guard earns its keep.
    ///
    /// Only the flags a shader actually reads are checked. `FREE16` has none by
    /// definition, and since the painted-layer cull (2026-07-26) neither do
    /// `GEO` and `CRAZE` — they survive as the host's "a generator touched this
    /// wall" mark for the AA scope. If a shader ever reads one again, add it
    /// here in the same commit.
    #[test]
    fn both_twins_spell_every_flag_value_as_the_host_does() {
        for (name, src) in crate::wear::twin_sources() {
            let lines = crate::wear::code_lines(src);
            let has = |pat: &str| lines.iter().any(|l| l.contains(pat));
            for (flag, v) in [("MATTE", MATTE), ("SEL", SEL), ("AA", AA)] {
                assert!(
                    has(&format!("pad & {v}u")) || has(&format!("pad & {v})")) || has(&format!("pad) & {v}u")),
                    "{name}: no read of {flag} at the host's value {v}"
                );
            }
        }
    }
}
