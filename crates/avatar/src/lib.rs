//! The player's body (2026-09-24 rebuild): a skinned mesh driven by
//! retargeted motion capture.
//!
//! - [`asset`]: the embedded `player.skin` / `player.anim` (written by
//!   `tools/character/`: `build_mesh.py` and `bake.py`, CMU mocap).
//! - [`pose`]: clip sampling, blending, forward kinematics.
//! - [`body`]: the fixed-tick locomotion controller — phase from distance,
//!   speed blend, stride warping, foot locking, stepping at rest, ground,
//!   lean. Its module doc is the design.
//! - [`ik`]: two-bone IK.
//! - [`skin`]: CPU linear-blend skinning.
//!
//! Pure and headless (glam only): no Scene, no GPU, no game. `rt-viewer`
//! feeds it the sim snapshot every fixed tick and uploads the skinned
//! vertices; the determinism rule holds because every input is sim state
//! and every step is fixed-tick f32 arithmetic in a fixed order.
pub mod asset;
pub mod body;
pub mod ik;
pub mod pose;
pub mod skin;

pub use body::{Body, Input, DT};
