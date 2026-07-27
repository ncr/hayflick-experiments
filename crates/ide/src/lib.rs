//! pracownia — the personal game IDE (owner directive 2026-07-27: "the ESC
//! menu has worked hard enough; make a personal IDE tailored to this game,
//! Unity-editor-shaped, minimal to start, cleanly separated from the game").
//!
//! This crate is the SEPARATION: it is the whole IDE — layout, widgets,
//! rasterization, interaction state — and it knows NOTHING about the game or
//! the GPU. The boundary is plain data, in the workspace's adapter tradition
//! (rt-probe and house-game never see each other; neither does this crate):
//!
//! - in: a [`SceneModel`] — named objects with transforms and declared,
//!   adapter-editable properties ([`scene`]),
//! - in: pointer/scroll events in IDE PIXELS (the viewer divides window px
//!   by the IDE scale — the overlay renders at 2x the game's pixel density,
//!   i.e. half the game texel, so tooling gets the fine grid while the world
//!   keeps the coarse one),
//! - out: CPU-rasterized [`Panel`]s the viewer composites as stamps, and
//!   [`Edit`]s the adapter applies to the real level.
//!
//! Everything here is deterministic and headless-testable: same model + same
//! events = same pixels, no wall-clock, no RNG.

pub mod canvas;
pub mod scene;
pub mod shell;
pub mod theme;

pub use canvas::Canvas;
pub use scene::{Edit, Obj, ObjId, Prop, PropKind, PropVal, SceneModel};
pub use shell::{Ide, Panel};
