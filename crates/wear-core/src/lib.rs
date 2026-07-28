//! THE WEAR MODEL, with no renderer in it.
//!
//! What a level BUILDER says about a wall ([`wall`]), the reinforcement mat and
//! the craters that expose it ([`rebar`]), and the noise the two of them and
//! both shader twins are built out of ([`field`]).
//!
//! # Why this is a crate and not three modules
//!
//! [`wall`] has declared its own purity in prose since the day it was written —
//! *"No `Scene`, no `Material`, no bits, no GPU"* — and nothing enforced it. It
//! lived in `rt-viewer`, which is a BINARY with no lib target, so ~3 k lines of
//! arithmetic (and their tests) could only be built by a crate that also needs
//! `glslangValidator`, an `ash` context and a window. A `use rt_probe::Scene`
//! added on any afternoon would have compiled.
//!
//! The dependency list in `Cargo.toml` is the whole enforcement: **glam only**.
//! It is the same shape the workspace already uses four times over — `iso-core`,
//! `sim-core`, `house-game`, `ide` — applied to the largest subsystem that had
//! been claiming it in a comment.
//!
//! # The boundary, in both directions
//!
//! Out: [`wall::Sheet`] — an all-integer [`wall::Geom`] for the geometry pass
//! and a [`wall::Paint`] for the material streamer. In: [`wall::RunRect`], four
//! floats of a run's box. `rt-viewer`'s `crack_geom` / `crack` / `wear` convert;
//! nothing here knows they exist.
//!
//! What did NOT come along: every test that measures a property over the REAL
//! shipped levels. Those need `gym_scene::build_gym`, hence a `Scene`, hence the
//! GPU crate — so they stayed in `rt-viewer` and call in through
//! `wear_core::wall::…`. They are integration tests by nature and the split says
//! so out loud.
//!
//! Which leaves one seam worth naming: a leaf crate's `#[cfg(test)]` items do
//! not exist for its dependents, and the authoring helpers those tests use
//! (`wall::compile`, `WallAt::pristine`, `Sheet::label`, `Breaks::NONE`,
//! `RunField::extremes`) are exactly that. They are gated
//! `#[cfg(any(test, feature = "testing"))]`, and `rt-viewer` turns the feature on
//! from its `[dev-dependencies]` — so it is on for `cargo test` and off in every
//! `cargo build`.

pub mod field;
pub mod rebar;
pub mod wall;
