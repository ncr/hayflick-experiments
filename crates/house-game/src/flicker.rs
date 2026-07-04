//! Stateless flicker curves — the VERBATIM port of rt-probe
//! `render.rs::compute_practicals`' per-kind animation formulas (hash noise,
//! not RNG: a pure function of (kind, light index, time), so `snapshot()`
//! never advances state and replay is exact). The renderer keeps its own copy
//! until migration step 10 deletes it in favor of game-authored emission;
//! until then `flicker_bit_equal_at_tick` pins this port bit-for-bit against
//! values computed from the original code (method in the test).
//!
//! Kinds: 1 = incandescent flicker (value noise + slow breathing + rare
//! deeper dips), 2 = screen pulse (throb + refresh shimmer + hue wobble),
//! 3 = gentle drift (conceptual ceiling lights); anything else = steady 1.

use std::f32::consts::TAU;

/// render.rs h01: a u32 hash to [0,1) — the only randomness source here.
fn h01(x: u32) -> f32 {
    let mut v = x.wrapping_mul(0x9E37_79B9);
    v ^= v >> 16;
    v = v.wrapping_mul(0x7feb_352d);
    v ^= v >> 15;
    (v & 0xFF_FFFF) as f32 / 16_777_216.0
}

/// The raw curve at sim time `t` (seconds) for the light at NEE-list index
/// `li` (the renderer enumerates `light_link`; seed = li + 1). Returns the
/// brightness factor + rgb tint BEFORE the renderer's `f.max(0.05)` clamp and
/// master-dim scale — callers apply those, mirroring compute_practicals.
pub fn flicker(kind: u32, li: usize, t: f32) -> (f32, [f32; 3]) {
    // smooth value noise in [0,1] at integer lattice `t`
    let vnoise = |t: f32, seed: u32| {
        let i = t.floor();
        let f = t - i;
        let s = f * f * (3.0 - 2.0 * f);
        let a = h01((i as i32 as u32).wrapping_add(seed.wrapping_mul(7919)));
        let b = h01((i as i32 as u32).wrapping_add(1).wrapping_add(seed.wrapping_mul(7919)));
        a + (b - a) * s
    };
    let seed = li as u32 + 1;
    let ph = h01(seed) * TAU;
    match kind {
        1 => {
            let n = vnoise(t * 9.0 + ph, seed);
            let dipn = vnoise(t * 1.7 + ph, seed.wrapping_mul(31));
            let dip = if dipn > 0.93 { (dipn - 0.93) * 6.0 } else { 0.0 };
            (1.0 + (n - 0.5) * 0.22 + (t * 0.7 + ph).sin() * 0.05 - dip, [1.0; 3])
        }
        2 => {
            // CRT screen: slow throb + mid value-noise + fast refresh
            // shimmer + rare horizontal-roll-style dips
            let p = 1.0
                + (t * 1.3 + ph).sin() * 0.20
                + (vnoise(t * 5.0 + ph, seed) - 0.5) * 0.18
                + (vnoise(t * 16.0 + ph, seed.wrapping_mul(13)) - 0.5) * 0.14;
            let rolln = vnoise(t * 2.3 + ph, seed.wrapping_mul(37));
            let roll = if rolln > 0.90 { (rolln - 0.90) * 4.0 } else { 0.0 };
            let hue = (t * 0.45 + ph).sin() * 0.5 + 0.5;
            (p - roll, [1.0 - 0.25 * hue, 1.0, 1.0 - 0.15 * (1.0 - hue)])
        }
        3 => (1.0 + (vnoise(t * 2.2 + ph, seed) - 0.5) * 0.08, [1.0; 3]),
        _ => (1.0, [1.0; 3]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::TICK_DT;

    /// Bit-compare against the ORIGINAL render.rs formulas, sampled before any
    /// renderer change. Method: compute_practicals needs a live SceneGpu (it
    /// writes lights_cpu through Vulkan-built light_link), so it is not
    /// callable CPU-side; instead the inner formula block (h01 + vnoise + the
    /// per-kind match, render.rs lines ~502-541) was copied VERBATIM into a
    /// standalone program, compiled with rustc -O, and evaluated at the
    /// (kind, li, tick) samples below with t = tick * 1/60. The f32 BIT
    /// patterns it printed are pinned here — the port must reproduce them
    /// exactly (same arithmetic, same libm, same machine).
    #[test]
    fn flicker_bit_equal_at_tick() {
        #[rustfmt::skip]
        let pinned: &[(u32, usize, u64, u32, [u32; 3])] = &[
            (1, 0, 0, 0x3f80018e, [0x3f800000, 0x3f800000, 0x3f800000]),
            (1, 0, 1, 0x3f7c1e61, [0x3f800000, 0x3f800000, 0x3f800000]),
            (1, 0, 7, 0x3f85e3a4, [0x3f800000, 0x3f800000, 0x3f800000]),
            (1, 0, 60, 0x3f803cbc, [0x3f800000, 0x3f800000, 0x3f800000]),
            (1, 0, 100, 0x3f828ae2, [0x3f800000, 0x3f800000, 0x3f800000]),
            (1, 0, 12345, 0x3f7bed4b, [0x3f800000, 0x3f800000, 0x3f800000]),
            (1, 1, 60, 0x3f7c4438, [0x3f800000, 0x3f800000, 0x3f800000]),
            (1, 3, 977, 0x3f62364d, [0x3f800000, 0x3f800000, 0x3f800000]),
            (2, 1, 0, 0x3f856e11, [0x3f5527fa, 0x3f800000, 0x3f734e6a]),
            (2, 1, 7, 0x3f85ef54, [0x3f53975a, 0x3f800000, 0x3f743eca]),
            (2, 1, 100, 0x3f88fb7c, [0x3f438b38, 0x3f800000, 0x3f7ddfac]),
            (2, 2, 12345, 0x3f9bfd07, [0x3f5b60ea, 0x3f800000, 0x3f6f92a7]),
            (2, 0, 333, 0x3fa2c650, [0x3f639648, 0x3f800000, 0x3f6aa5d4]),
            (3, 2, 0, 0x3f820c5d, [0x3f800000, 0x3f800000, 0x3f800000]),
            (3, 2, 100, 0x3f7c9ae3, [0x3f800000, 0x3f800000, 0x3f800000]),
            (3, 3, 12345, 0x3f8153a6, [0x3f800000, 0x3f800000, 0x3f800000]),
            (0, 0, 100, 0x3f800000, [0x3f800000, 0x3f800000, 0x3f800000]),
        ];
        for &(kind, li, tick, fbits, tbits) in pinned {
            let t = tick as f32 * TICK_DT;
            let (f, tint) = flicker(kind, li, t);
            assert_eq!(f.to_bits(), fbits, "factor bits (kind {kind}, li {li}, tick {tick}): got {:.6}", f);
            for c in 0..3 {
                assert_eq!(tint[c].to_bits(), tbits[c], "tint[{c}] bits (kind {kind}, li {li}, tick {tick})");
            }
        }
    }
}
