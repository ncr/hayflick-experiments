//! rt-probe — deterministic Rust+Vulkan hardware-RT renderer for the
//! pixel-perfect isometric game (the native successor of the web
//! pathtrace-probe experiment).
//!
//! Module map:
//! - [`config`] — every env knob, resolved once (`Config::from_env`)
//! - [`gpu`]    — generic Vulkan plumbing (context, buffers, images)
//! - [`scene`]  — scene model + GLTF loader (world-space baked geometry)
//! - [`scenes`] — content: the house / lab / grid-walker scene builders
//! - [`render`] — `SceneGpu`: AS build, shade + probe pipelines, NEE lights,
//!   animated practicals, the two-bank GI probe cache
//! - [`iso`]    — re-export shim over the `iso-core` crate (ISO_VIEW_CONTRACT
//!   camera + pixel-perfect view math, tested there)
//!
//! The interactive window is the `rt-viewer` crate (`native/crates/rt-viewer`);
//! game logic (collision, iso input, ECS systems) is the `house-game` crate.
//!
//! Rendering model: shade.comp runs every frame as a PURE FUNCTION of
//! (scene, camera) — primary ray per pixel centre, exact shadow rays, GI from
//! a world-space ambient-cube probe cache baked once at startup (probes.comp,
//! the only Monte Carlo left). A fixed camera gives bit-identical frames;
//! every frame of a camera move is exactly as converged as a settled one.

// Internal renderer crate: unsafe is pervasive Vulkan FFI. The safety story
// is "called from the renderer with live handles", not per-fn contracts.
#![allow(clippy::missing_safety_doc)]

pub mod config;
pub mod gpu;
/// Compat shim — iso math lives in the `iso-core` crate now (pure-math leaf,
/// glam-only); consumers keep using `rt_probe::iso::*` / the lib re-exports.
pub mod iso {
    pub use iso_core::*;
}
pub mod render;
pub mod scene;
pub mod scenes;

pub use config::{Config, StyleCfg};
pub use gpu::{barrier, dslb, make_storage_image, Buffer, Ctx, GpuTex};
pub use iso::{
    clamp_pan, iso_basis, iso_camera_at, iso_pixel_basis, iso_target, render_scale, screen_px_to_world, snap_ground_to_lattice, whole_pixel_step, zoom_anchor_pan, CamFrame, ISO_PITCH_DEG, ISO_R, ISO_YAW_DEG,
};
pub use render::{make_pool, make_set, mat_to_transform, push_bytes, SceneGpu, ShadePush, TONE_SPV};
pub use scene::Scene;
pub use scenes::build_scene;
