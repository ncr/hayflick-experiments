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
//! - [`render`] — `SceneGpu`: AS build, shade + probe pipelines, NEE lights,
//!   the typed FrameState/SceneHandles/Spotlight frame surface, the two-bank
//!   GI probe cache. Practical flicker is NOT here — `frame_lights_cpu` only
//!   applies the game-authored `FrameState.light_emission` (house-game owns
//!   the flicker curves; see step 10 in `ARCHITECTURE.md`)
//!
//! Iso camera / pixel-perfect view math lives in the `iso-core` crate (pure
//! math leaf, glam-only) — consumers import `iso_core::*` directly.
//!
//! The interactive window is the `rt-viewer` crate (`crates/rt-viewer`):
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
/// table, bake-bank emission) — the single source
/// both the Vulkan and Metal backends consume.
pub mod gpu_scene;
/// Disk cache for baked GI probe banks — the interactive viewer skips re-baking
/// when the scene inputs are unchanged (headless capture paths bake fresh).
pub mod probe_cache;
pub mod render;
pub mod scene;

// Re-export surface = exactly what crosses the rt-probe boundary (rt-viewer +
// its `use rt_probe::*`). Items NOT re-exported here stay `pub` in their
// modules: some are internal-only (GpuTex), others rt-viewer names by module
// path (rt_probe::render::{frame_lights_cpu, LightScan, mat_to_transform} —
// the Metal backend). Iso math is imported from
// `iso_core` directly, never through this crate.
pub use config::{Config, StyleCfg};
pub use gpu::{barrier, dslb, make_storage_image, Buffer, Ctx};
pub use gpu_scene::{bake_bank_emission, InstanceTable, ProbeGrid};
pub use render::{make_pool, make_set, push_bytes, roi_push, scan_lights, FrameState, InstanceKey, LightKey, SceneGpu, SceneHandles, ShadePush, Spotlight, N_RESERVED, ROI_OFF, SPOT_WARM, TONE_SPV};
pub use scene::{hex_linear, EnvBlock, Scene, SunSky};
