//! gym — the one level: the movement/look testbed (docs/VISION.md, cut to
//! the bone 2026-07-12: a hand-authored field with a few walls, one building
//! and the player — no NPCs, no generators, no seed).
//!
//! Fully headless (ARCHITECTURE.md area C): no GPU, no window, no wall-clock.
//! Everything here runs under plain `cargo test -p house-game`.
//!
//! Module map:
//! - [`grid`] — the world model: cells hold ground kind, EDGES hold walls;
//!   single floor, pure integer math.
//! - [`sim`] — the player-only sim (walk/run cadence) + the hand-authored
//!   [`sim::gym_level`]. Trace-replayable, `state_hash`-pinned.
//! - [`trace`] — the text-trace format (`<tick> <op> <args>`), the headless
//!   replay/clip input.

pub mod grid;
pub mod sim;
pub mod trace;

pub mod neighborhood;
