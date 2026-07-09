//! thief — the stealth/social-deduction game (docs/spec/, 2026-07-09 pivot).
//!
//! Fully headless (ARCHITECTURE.md area C): no GPU, no window, no wall-clock.
//! Everything here must run under plain `cargo test -p house-game`, and every
//! system is a deterministic, seeded function of sim state at a tick.
//!
//! Module map (grows with the milestone ladder, docs/spec/12):
//! - [`grid`] — module 03's world model: cells hold contents, EDGES hold
//!   barriers; stacked z-layer floors; edge-gated LOS, sound and light
//!   propagation. Integer-first math so the logical layer is portable.
//! - [`towngen`] — fully algorithmic district generation (streets, 10–20
//!   multi-floor buildings, targets, gates), seeded + re-roll-until-fair.
//! - [`fairness`] — the mandatory solvability/fairness invariants; the
//!   generation oracle family of docs/spec/12.

pub mod fairness;
pub mod grid;
pub mod towngen;
