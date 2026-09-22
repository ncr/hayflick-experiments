//! `Material._pad` — ONE HOME for every flag bit, named by VALUE.
//!
//! Every constant here is the VALUE (`_pad & VALUE`), never a bit index — the
//! prose once drifted into two readings of "bit 4" (value 4 vs index 4) and
//! pointed at two different bits depending on the file, so this module only
//! offers the unambiguous one.
//!
//! # The allocation
//!
//! | value | index | name | who writes it | who reads it |
//! |---|---|---|---|---|
//! | 1 | 0 | [`OCCLUDER`] | `gym_scene::mark_occluder`, painted walls, concrete | shade (WALLCUT / ROI) |
//! | 2 | 1 | [`GLASS`] | `gym_scene::mark_glass` | shade (transmission) |
//! | 4 | 2 | [`MATTE`] | `gym_scene::mark_matte`, the survivor's cloth | shade (kills spec + the gloss remap; the meadow) |
//! | 16 | 4 | [`CONCRETE`] | concrete + terrain builders | shade (the concrete/terrain samplers) |
//!
//! Values 8, 32, 64 and 128 are FREE since 2026-09-22: they were the wear
//! pipeline's selection tag, its two geometry marks and the contour-AA
//! opt-in, deleted with that pipeline (superseded by creative mode + painted
//! surfaces). Everything above the flag byte is free too — it carried the
//! wear pipeline's paint lanes.

/// See-through OCCLUDER: the WALLCUT cutaway and the ROI reveal dissolve it.
pub const OCCLUDER: i32 = 1;
/// A transmissive window pane.
pub const GLASS: i32 = 2;
/// MATTE by construction — the shade pass skips spec and the gloss remap here.
/// "trawa nie może się błyszczeć" (owner, 2026-07-12).
pub const MATTE: i32 = 4;
/// Dedicated reinforced-concrete material pipeline (`concrete.inc`,
/// `terrain.inc`).
pub const CONCRETE: i32 = 16;

/// Every flag, for the tests and for any exhaustive dump. Exhaustive on
/// purpose: `the_flags_are_distinct_bits` walks THIS list, so a new flag that
/// forgets to join it fails that test rather than colliding.
#[allow(dead_code)]
pub const ALL: [(&str, i32); 4] = [("OCCLUDER", OCCLUDER), ("GLASS", GLASS), ("MATTE", MATTE), ("CONCRETE", CONCRETE)];

#[cfg(test)]
mod tests {
    use super::*;

    /// The allocation is a partition: every flag a distinct single bit, all of
    /// them inside the flag byte, nothing overlapping.
    #[test]
    fn the_flags_are_distinct_bits() {
        const BYTE: i32 = 0xFF; // the flag byte — bits 0..7
        let mut seen = 0i32;
        for (name, v) in ALL {
            assert_eq!(v.count_ones(), 1, "{name} is not a single bit ({v})");
            assert_eq!(v & BYTE, v, "{name} sits outside the flag byte");
            assert_eq!(seen & v, 0, "{name} collides with a flag already claimed");
            seen |= v;
        }
    }

    /// BOTH SHADER TWINS must spell each flag the way the host does.
    ///
    /// The twins test `(m.pad & <literal>)`, so a flag whose value moved on the
    /// host and not in a shader is a silent, backend-specific wrong image —
    /// and one backend is blind every session, which is exactly when a
    /// compile-time source guard earns its keep.
    #[test]
    fn both_twins_spell_every_flag_value_as_the_host_does() {
        for (name, src) in crate::twin::twin_sources() {
            let lines = crate::twin::code_lines(src);
            let has = |pat: &str| lines.iter().any(|l| l.contains(pat));
            for (flag, v) in ALL {
                assert!(
                    has(&format!("pad & {v}u")) || has(&format!("pad & {v})")) || has(&format!("pad) & {v}u")),
                    "{name}: no read of {flag} at the host's value {v}"
                );
            }
        }
    }
}
