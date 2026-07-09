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
//! - [`perception`] — the Observation atom + fuzzy appearance matching
//!   (module 05a): the only currency deduction reasons over.
//! - [`deduction`] — the correlation engine: reported observations cluster
//!   into Cases (merged suspect profile, confidence, scrutiny) — module 05b.
//! - [`sim`] — the M1 spine + M2 playable slice: the `ThiefGame` Simulation
//!   (senses → memory → report → case → the 05c confrontation ladder over
//!   the alertness ladder; movement modes, encumbrance, the day clock),
//!   trace-replayable.
//! - [`log`] — module 11's event LOG: the pure prose projection of the
//!   tick-stamped sim-event stream (nothing invented, only real events).
//! - [`trace`] — the thief text-trace format (`<tick> <op> <args>`), the
//!   headless replay/clip input.

pub mod deduction;
pub mod fairness;
pub mod grid;
pub mod log;
pub mod perception;
pub mod sim;
pub mod towngen;
pub mod trace;
