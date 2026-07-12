//! town — the movement/look testbed world (docs/VISION.md).
//!
//! Fully headless (ARCHITECTURE.md area C): no GPU, no window, no wall-clock.
//! Everything here must run under plain `cargo test -p house-game`, and every
//! system is a deterministic, seeded function of sim state at a tick.
//!
//! Module map:
//! - [`grid`] — the world model: cells hold contents, EDGES hold barriers;
//!   stacked z-layer floors; edge-gated LOS, sound and light propagation.
//!   Integer-first math so the logical layer is portable.
//! - [`towngen`] — fully algorithmic district generation (streets, multi-floor
//!   buildings, gates), seeded + re-roll-until-fair.
//! - [`fairness`] — the mandatory solvability/fairness invariants over the
//!   generator (the generation oracle family).
//! - [`sim`] — the minimal town sim: player movement (three cadences),
//!   patrolling/wandering NPCs, the day clock. Trace-replayable.
//! - [`trace`] — the town text-trace format (`<tick> <op> <args>`), the
//!   headless replay/clip input.

pub mod fairness;
pub mod grid;
pub mod sim;
pub mod towngen;
pub mod trace;
