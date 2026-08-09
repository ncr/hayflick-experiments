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
//! - [`sim`] — the player-only sim (one continuous mover: acceleration,
//!   braking, collide-and-slide) + the hand-authored [`sim::gym_level`].
//!   Trace-replayable, `state_hash`-pinned.
//! - [`route`] — click-to-move: a string-pulled world path over the grid and
//!   the steering that walks it, feeding the SAME mover the keyboard does.
//! - [`trace`] — the text-trace format (`<tick> <op> <args>`), the headless
//!   replay/clip input.

pub mod grid;
pub mod route;
pub mod sim;
pub mod trace;
