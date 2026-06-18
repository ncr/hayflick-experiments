//! rt-probe — deterministic Rust+Vulkan hardware-RT renderer for the
//! pixel-perfect isometric game (the native successor of the web
//! pathtrace-probe experiment).
//!
//! Module map:
//! - [`config`] — every env knob, resolved once (`Config::from_env`), split
//!   into `RenderCfg` / `GameCfg` / `HarnessCfg` along look / game / harness
//!   lines (the shared `scene` identity stays on `Config`)
//! - [`gpu`]    — generic Vulkan plumbing (context, buffers, images)
//! - [`scene`]  — scene model + GLTF loader (world-space baked geometry)
//! - [`scenes`] — content: the house / lab / grid-walker scene builders
//! - [`render`] — `SceneGpu`: AS build, shade + probe pipelines, NEE lights,
//!   the typed FrameState/SceneHandles/Spotlight frame surface, the two-bank
//!   GI probe cache. Practical flicker is NOT here — `frame_lights_cpu` only
//!   applies the game-authored `FrameState.light_emission` (house-game owns
//!   the flicker curves; see step 10 in `native/ARCHITECTURE.md`)
//! - [`iso`]    — re-export shim over the `iso-core` crate (ISO_VIEW_CONTRACT
//!   camera + pixel-perfect view math + unprojection, tested there)
//!
//! The interactive window is the `rt-viewer` crate (`native/crates/rt-viewer`):
//! winit loop, the FixedLoop sim driver, the snapshot→FrameState adapter, and
//! the LevelSpec→Scene greybox builder. Game logic (collision, iso input, ECS
//! systems, flicker authoring) is the `house-game` crate. rt-probe and
//! house-game never see each other — only rt-viewer's adapter knows both.
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
/// Backend-agnostic, GPU-free scene-derived data (probe grid, instance/mask
/// table, bake-bank emission, dollhouse mask resolution) — the single source
/// both the Vulkan and Metal backends consume.
pub mod gpu_scene;
/// Compat shim — iso math lives in the `iso-core` crate now (pure-math leaf,
/// glam-only); consumers keep using `rt_probe::iso::*` / the lib re-exports.
pub mod iso {
    pub use iso_core::*;
}
/// Disk cache for baked GI probe banks — the interactive viewer skips re-baking
/// when the scene inputs are unchanged (headless capture paths bake fresh).
pub mod probe_cache;
pub mod render;
pub mod scene;
pub mod scenes;

// Re-export surface = exactly what crosses the rt-probe boundary (rt-viewer +
// its `use rt_probe::*`). The split sub-cfgs (RenderCfg/GameCfg/HarnessCfg) are
// the public shape of `Config`'s fields; items used only inside rt-probe
// (CamFrame, GpuTex, LightScan, frame_lights_cpu, mat_to_transform, the
// ISO_*_DEG angle consts, the iso_*_basis helpers) stay `pub` in their modules
// but are NOT re-exported here — nothing outside the crate names them.
pub use config::{Config, GameCfg, HarnessCfg, RenderCfg, StyleCfg};
pub use gpu::{barrier, dslb, make_storage_image, Buffer, Ctx};
pub use gpu_scene::{bake_bank_emission, yaw_instance_mask, InstanceTable, ProbeGrid, PROBE_CAP};
pub use iso::{clamp_pan, iso_basis, iso_camera_at, render_scale, screen_px_to_world, snap_ground_to_lattice, whole_pixel_step, zoom_anchor_pan, ISO_R};
pub use render::{make_pool, make_set, push_bytes, scan_lights, FrameState, InstanceKey, LightKey, SceneGpu, SceneHandles, ShadePush, Spotlight, N_RESERVED, TONE_SPV};
pub use scene::{hex_linear, Scene};
pub use scenes::build_scene;
