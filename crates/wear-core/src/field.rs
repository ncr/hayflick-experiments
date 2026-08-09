//! The NOISE, and the damage field made of it — float-exact mirrors of the
//! shader helpers in `shade.comp` / `shade.metal`.
//!
//! Everything downstream of a wall's story is built out of these six functions,
//! and the point of them living in ONE module is that the three readers cannot
//! sample different fields: the threshold solver ([`crate::wall::RunField`]),
//! the geometry generator (`crack_geom`, which cuts the plates and the craters)
//! and the two shader twins (which paint the stains and the glaze web). That
//! drift — paint landing off the plates — is the failure docs/AGENT_LEARNINGS.md
//! records twice, and one definition is the structural answer to it.
//!
//! The shaders cannot call Rust, so their copies stay literal; the `wear.rs`
//! source guard (`HOST_MIRRORS`) pins every constant in this file against both
//! twins by reading all three sources at compile time.

use glam::Vec3;

fn fr(x: f32) -> f32 {
    x - x.floor()
}
pub fn mixf(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}
pub fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}
/// Shared with [`crate::rebar`] — the corrosion mat's draws must be the same
/// arithmetic as the damage field's, not a second kind of noise.
pub fn hash13(p: Vec3) -> f32 {
    let mut p = Vec3::new(fr(p.x * 0.1031), fr(p.y * 0.1031), fr(p.z * 0.1031));
    p += Vec3::splat(p.dot(Vec3::new(p.y, p.z, p.x) + Vec3::splat(33.33)));
    fr((p.x + p.y) * p.z)
}
/// The smooth field the damage patches are made of — never a second kind of
/// noise, for the same reason [`hash13`] is shared.
pub fn vnoise(x: Vec3) -> f32 {
    let i = x.floor();
    let f = x - i;
    let f = f * f * (Vec3::splat(3.0) - 2.0 * f);
    let h = |ox: f32, oy: f32, oz: f32| hash13(i + Vec3::new(ox, oy, oz));
    let lerp = mixf;
    let n00 = lerp(h(0., 0., 0.), h(1., 0., 0.), f.x);
    let n10 = lerp(h(0., 1., 0.), h(1., 1., 0.), f.x);
    let n01 = lerp(h(0., 0., 1.), h(1., 0., 1.), f.x);
    let n11 = lerp(h(0., 1., 1.), h(1., 1., 1.), f.x);
    lerp(lerp(n00, n10, f.y), lerp(n01, n11, f.y), f.z)
}

/// The shader twins' `fbm` — the exact host mirror. Two solvers sample it: the
/// damage field below and [`crate::wall::mud_noise`]'s quantile.
pub fn fbm(p: Vec3) -> f32 {
    0.65 * vnoise(p) + 0.35 * vnoise(p * 2.03 + Vec3::splat(11.1))
}

/// A run's STORY KEY turned into the damage field's seed coordinate.
///
/// One name for what used to be three independent spellings of the same
/// expression: `wall::RunField::at`, `crack_geom::CrazeCfg::new` and both shade
/// twins. The shaders keep their literal — they cannot call Rust — and the
/// `wear.rs` source guard pins that mirror; what this removes is the two HOST
/// copies, which were reached through different call sites and so pinned
/// nothing about each other.
pub fn dmg_seed(story: f32) -> f32 {
    story * 7.0 + 3.0
}

/// THE damage field. One definition with three readers by construction — the
/// threshold solver, the geometry generator and both shader twins — so the
/// solved gates, the built plates and the painted layers can never sample
/// different fields.
pub fn dmg_field(dmg_seed: f32, su: f32, sy: f32) -> f32 {
    let rise = 1.0 - smoothstep(0.10, 1.0, sy);
    fbm(Vec3::new(su * 0.45, sy * 0.7, dmg_seed)) + 0.16 * rise
}
