//! The game's chrome — creative mode's toolbar and the raster it draws with.
//! Headless and GPU-free: the adapter (`rt-viewer/src/creative_host.rs`)
//! hands in plain data (tool labels, the cursor in chrome px) and gets back
//! CPU-rasterized [`Panel`]s to composite as stamps plus which button was hit.
//!
//! This crate used to be the whole slider IDE ("pracownia": a hierarchy, an
//! inspector and the wear rows, 2026-07-27); creative mode superseded it and
//! it was deleted on 2026-09-22 — what is left is the part creative mode
//! draws with.
//!
//! Everything here is deterministic and headless-testable: same model + same
//! events = same pixels, no wall-clock, no RNG.

pub mod canvas;
pub mod theme;
pub mod toolbar;

pub use canvas::{Canvas, Panel};
