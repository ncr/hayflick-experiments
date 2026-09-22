//! flora — vegetation for creative mode (owner 2026-09-22: "now the same kind
//! of tools for foliage").
//!
//! Two halves, both baked on the CPU and both plain data out:
//!
//! - [`ground`]: the GRASS. The blades themselves stay analytic in the shade
//!   pass (`terrain.inc` — wind, the player bending them, one ray-triangle per
//!   blade), because thousands of moving ribbons are exactly what a shader
//!   does well. What changes is where they GROW: a density map at
//!   [`ground::TX`] texels per wu, baked from the level's natural growth plus
//!   the owner's brush strokes (grass, dry, mow), is the only thing the shader
//!   reads. A brush dab re-bakes a map the size of a thumbnail and the blades
//!   follow the same frame — no scene rebuild.
//! - [`plant`]: TREES and BUSHES, procedural and seeded, as triangle soups
//!   split by material (bark, green leaf, dry leaf). Blocky low-poly on
//!   purpose: at this pixel size a 20-sided trunk and a 6-sided one are the
//!   same few pixels, and faceted crowns read as the greybox family.

pub mod ground;
pub mod plant;

pub(crate) fn hash(x: i32, y: i32, seed: u32) -> f32 {
    let mut a = (x as u32).wrapping_mul(0x9e37_79b9) ^ (y as u32).wrapping_mul(0x85eb_ca6b) ^ seed.wrapping_mul(0xc2b2_ae35);
    a ^= a >> 16;
    a = a.wrapping_mul(0x7feb_352d);
    a ^= a >> 15;
    (a & 0xff_ffff) as f32 / 16_777_215.0
}

pub(crate) fn noise(x: f32, y: f32, seed: u32) -> f32 {
    let (ix, iy) = (x.floor(), y.floor());
    let (fx, fy) = (x - ix, y - iy);
    let (sx, sy) = (fx * fx * (3.0 - 2.0 * fx), fy * fy * (3.0 - 2.0 * fy));
    let (x0, y0) = (ix as i32, iy as i32);
    let a = hash(x0, y0, seed) * (1.0 - sx) + hash(x0 + 1, y0, seed) * sx;
    let b = hash(x0, y0 + 1, seed) * (1.0 - sx) + hash(x0 + 1, y0 + 1, seed) * sx;
    a * (1.0 - sy) + b * sy
}

pub(crate) fn smooth(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}
