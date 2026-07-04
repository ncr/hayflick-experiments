//! The render-backend boundary. `Viewer` (sim loop, camera/pan presentation,
//! harness, FrameState builder) is backend-agnostic and drives the GPU half
//! exclusively through `RenderBackend`. Today that half is `VulkanBackend`
//! (hardware ray-query on NVIDIA/desktop); the Apple-Silicon `MetalBackend`
//! implements the same trait. The backend is selected at compile time by
//! target OS (`new_backend`).
//!
//! Everything crossing the boundary is plain data (`FrameState`, `Spotlight`,
//! handles — all Vulkan-free, in `rt_probe`) plus the small parameter bundles
//! below. No Vulkan/Metal type ever appears in `Viewer`.

use glam::{Vec2, Vec3};
use rt_probe::iso::{iso_basis, CamFrame, ISO_R};
use rt_probe::{Config, FrameState, Scene, SceneHandles, StyleCfg};
use winit::window::Window;

/// Push constants for tonemap.comp / tonemap.metal. Field names match the
/// shader's `pc` block. Identical bytes feed either backend's tonemap kernel.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct TonePush {
    pub dims: [i32; 4], // low_w, low_h, out_w, out_h
    pub cfg: [i32; 4],  // scale, pan_x, pan_y, _
    pub fcfg: [f32; 4], // exposure, grain, frame, dither world-phase x
    // current frame's screen projection rows (outline forward recovery):
    // buffer px of world P = (dot(P, proj_a.xyz) + proj_a.w, dot(P, proj_b.xyz) + proj_b.w)
    pub proj_a: [f32; 4],
    pub proj_b: [f32; 4],
    pub style1: [f32; 4], // grade preset, poster bands, dither mode, dither amount
    pub style2: [f32; 4], // palette mode, palette param, vignette, outline strength
    pub style3: [f32; 4], // grain size px, grain static flag, bloom strength, bloom threshold
    pub style4: [f32; 4], // shadow dither: strength, levels, luma threshold, dither world-phase y
    pub style5: [f32; 4], // saturation, contrast, _, _ (post-grade colour shaping)
}

/// The view/camera + look knobs the GPU half needs to build this frame's
/// shade + tonemap push constants and the integer crop. All plain data; the
/// camera itself rides in `fs.cam` (built by the Viewer from `backend.low_dims`).
pub struct FramePresent<'a> {
    pub fs: &'a FrameState<'a>,
    // crop / projection (TonePush + the GPU crop origin)
    pub pan: Vec2,
    pub target: Vec3,
    pub yaw_deg: f32,
    pub zoom: f32,
    // shade tunables (ShadePush) — built post-record_frame so light_count is final
    pub ao: f32,
    pub ao_r: f32,
    pub ao_n: i32,
    pub spec: f32,
    pub gloss: f32,
    pub bump: f32,
    pub bump_scale: f32,
    pub gi: f32,
    pub debug: i32,
    // tonemap tunables (TonePush)
    pub exposure: f32,
    pub style: StyleCfg,
    pub frame: u32,
    /// UI overlay copied onto the PRESENTED image only (never `out`, so SHOT/
    /// MOVIE/DUMP captures stay clean). `None` for headless modes.
    pub overlay: Option<Overlay<'a>>,
    /// World-anchored + HUD pixel-canvas stamps burned into `out_tex` (the
    /// present AND readback source) — unlike `overlay`, these land in
    /// SHOT/DUMP/DEMO captures: tactic bubbles and the bottom HUD bar are
    /// part of the game picture, not the shell UI. Window-px positions;
    /// each logical canvas pixel is scaled by `scale` (pass the render
    /// scale for game-pixel-consistent chunk).
    pub stamps: &'a [Stamp],
    /// Per-frame multiplier on the env sun/sky fill (1.0 = authored). The
    /// arena blackout drives it from sim room_lights so the open-studio sky
    /// fill dies WITH the lamps — gated by the viewer to open-studio scenes,
    /// so the textured goldens (game_replay ends lights-off!) never move.
    pub sky_dim: f32,
    /// Minimap HUD canvas (RGBA logical px, w, h). Unlike `overlay`, the backend
    /// burns this into `out_tex` (the present + readback source), so it lands in
    /// SHOT/DUMP/DEMO captures too. `None` when the minimap is off.
    pub minimap: Option<(&'a [u32], i32, i32)>,
    /// Dollhouse see-through reveal (CAVE_ROI): player world pos + disc radius /
    /// falloff in low-res px. The backend projects the disc centre via the shared
    /// `rt_probe::roi_push` and packs it into the shade push. `None` → no reveal.
    pub roi: Option<RoiInfo>,
    /// Record the clip down-blit (`out` → exact game px) into this frame's
    /// command buffer; the backend must hold a capture target this size.
    pub capture: bool,
}

/// Player-anchored see-through reveal request (CAVE_ROI), resolved per frame.
#[derive(Clone, Copy)]
pub struct RoiInfo {
    pub player: Vec3,
    pub radius_px: f32,
    pub falloff_px: f32,
    pub ghost: f32,
}

/// CPU-drawn overlay canvases (logical px, ARGB), expanded + copied onto the
/// swapchain image by the backend after the blit.
/// One pre-rasterized canvas stamped onto the output image at (x, y) window
/// px, each logical pixel expanded `scale`×. 0x00000000 pixels are DRAWN
/// (opaque black) — the chunky-plate aesthetic wants no alpha.
pub struct Stamp {
    pub pix: Vec<u32>,
    pub w: i32,
    pub h: i32,
    pub x: i64,
    pub y: i64,
    pub scale: u32,
}

pub struct Overlay<'a> {
    pub menu: (&'a [u32], i32, i32),         // canvas, w, h
    /// Center the menu canvas on the window (the arena TITLE / PAUSE game
    /// menus) instead of pinning it at the top-left margin (tune panel).
    pub menu_center: bool,
    pub score: Option<(&'a [u32], i32, i32)>, // player scenes: corner HUD
}

/// The GPU half of the renderer. Owns the device, scene GPU resources, the
/// shade/tonemap pipelines, the present surface, and the capture target.
/// `Viewer` never names a Vulkan/Metal type — only this trait.
pub trait RenderBackend {
    /// Game-facing name→handle maps (lights frozen at the emissive-scan order,
    /// instances at the dynamic-run order) — the sim adapter joins onto these.
    fn handles(&self) -> &SceneHandles;
    /// Real NEE light count (excludes the reserved spotlight slots).
    fn light_count(&self) -> u32;

    /// Whole-low-pixel render scale for `zoom` (#4).
    fn rs(&self, zoom: f32) -> i32;
    /// (low buffer size, visible-region size) in low pixels, for pan clamping.
    fn low_and_vis(&self, zoom: f32) -> (Vec2, Vec2);
    /// Low-res radiance-buffer dimensions (for the Viewer's camera build).
    fn low_dims(&self) -> (u32, u32);
    /// Presented/offscreen extent in window pixels.
    fn extent(&self) -> (u32, u32);
    /// Integer UI scale of the current target (menu/HUD physical px = logical·scale).
    fn menu_scale(&self) -> u32;
    /// A render target exists (always true after construction).
    fn has_target(&self) -> bool;

    /// (Re)build the swapchain + all window-size-dependent GPU resources. Pure
    /// GPU work — the Viewer re-centres pan afterwards.
    unsafe fn recreate(&mut self, w: u32, h: u32);

    /// Render + (windowed) present one frame. Returns false if the swapchain
    /// needs rebuild. Records the deterministic per-frame state (lights →
    /// instances → TLAS refit if dirty), shade dispatch, tonemap, blit,
    /// overlay, optional clip down-blit, present — exact intra-frame order.
    unsafe fn render_present(&mut self, p: &FramePresent) -> bool;

    /// Block until the device is idle (FRAMES limit teardown, capture sync).
    unsafe fn wait_idle(&self);

    // ---- capture / readback (PNG/mp4/gif encode stays CPU-shared in capture.rs)
    /// Read back `out` and subsample by `rs` to exact low-res game pixels (DUMP).
    unsafe fn readback_out_subsampled(&self, rs: i32) -> (u32, u32, Vec<u8>);
    /// Dump the exact presented image to a PNG (SHOT/MOVIE/DEMO). Waits idle.
    unsafe fn capture_png(&self, path: &str);
    /// Current clip-capture target size, if one is allocated.
    fn capture_target_size(&self) -> Option<(u32, u32)>;
    /// Ensure the clip-capture target is sized `w×h` (alloc/refit as needed).
    unsafe fn ensure_capture_target(&mut self, w: u32, h: u32);
    /// Collect the previous frame's deferred clip capture, if one is pending
    /// (waits the in-flight fence). Returns (w, h, rgba) game pixels.
    unsafe fn collect_pending_capture(&mut self) -> Option<(u32, u32, Vec<u8>)>;
}

/// Build this frame's tonemap push constants. Shared by both backends so the
/// projection-row / dither-world-phase math (and thus the pixel-perfect blit)
/// is identical regardless of GPU. Mirrors the old `Renderer::draw` block.
#[allow(clippy::too_many_arguments)]
pub fn build_tone_push(low_w: u32, low_h: u32, ext_w: u32, ext_h: u32, rs: i32, pan: Vec2, target: Vec3, yaw_deg: f32, exposure: f32, style: &StyleCfg, frame: u32) -> TonePush {
    let pan = pan.round();
    let (_cd, cright, cup) = iso_basis(yaw_deg);
    let pa = cright * ISO_R;
    let pb = -cup * ISO_R;
    let off_x = -target.dot(cright) * ISO_R + low_w as f32 * 0.5 - 0.5;
    let off_y = target.dot(cup) * ISO_R + low_h as f32 * 0.5 - 0.5;
    // world-anchored dither/grain phase, quantised with round(x - 0.25): keeps
    // the pattern from slipping 1 px on odd/even window parities (see the long
    // comment in the old draw()).
    let dphase_x = (-target.dot(cright) * ISO_R + low_w as f32 * 0.5 - 0.75).round();
    let dphase_y = (target.dot(cup) * ISO_R + low_h as f32 * 0.5 - 0.75).round();
    TonePush {
        dims: [low_w as i32, low_h as i32, ext_w as i32, ext_h as i32],
        cfg: [rs, pan.x as i32, pan.y as i32, 0],
        fcfg: [exposure, style.grain, frame as f32, dphase_x],
        proj_a: [pa.x, pa.y, pa.z, off_x],
        proj_b: [pb.x, pb.y, pb.z, off_y],
        style1: [style.grade, style.poster, style.dither, style.dither_amt],
        style2: [style.palette, style.pal_p, style.vignette, style.outline],
        style3: [style.grain_sz, style.grain_static, style.bloom, style.bloom_th],
        style4: [style.sdither, style.sdither_n, style.sdither_th, dphase_y],
        style5: [style.sat, style.contrast, 0.0, 0.0],
    }
}

// ---- goo SDF composite: shared push layout, look, and limits ----------------
// One source for BOTH backends (goo.metal on macOS, goo.comp via Vulkan
// everywhere else) so the two passes cannot drift apart. The resting-height
// constants (`GOO_SQUASH`, `GOO_FLOOR_Y`) stay owned by `crate::sim` (shared
// with the CPU ball placement).

/// Goo composite push constants — byte-identical to `GooPush` in goo.metal AND
/// the `PC` push_constant block in goo.comp (160 B; asserted at pipeline build).
#[repr(C)]
#[derive(Clone, Copy)]
pub struct GooPush {
    pub cam_right: [f32; 4], // xyz, w = ortho half-width
    pub cam_up: [f32; 4],    // xyz, w = ortho half-height
    pub cam_dir: [f32; 4],   // xyz forward, w = vertical squash (<1 = flatter puddle)
    pub cam_pos: [f32; 4],   // xyz eye, w = floor plane Y
    pub dims: [i32; 4],      // W, H, ballCount, blobCount (bounding spheres)
    pub emis: [f32; 4],      // emissive rgb, w = glow intensity
    pub absorb: [f32; 4],    // Beer-Lambert absorption rgb/wu, w = surface alpha
    pub params: [f32; 4],    // x = smin merge radius k, yzw spare
    pub birth_emis: [f32; 4],   // emissive rgb the goo lerps TO at a gestating bud
    pub birth_absorb: [f32; 4], // absorption rgb the goo lerps TO at a gestating bud
}

/// `smin` merge radius: the smoothness of the dumbbell waist + lump fusing.
pub const GOO_SMIN_K: f32 = 0.14;
/// Max goo metaballs the composite buffer holds (GOO_LIVE_CAP × GOO_PARTICLES,
/// with headroom). Excess balls in a frame are clamped (never reallocates).
pub const GOO_MAX: usize = 512;
/// Max per-blob bounding spheres (GOO_MAX / 40 balls per blob, with headroom)
/// for the composite's two-level culling.
pub const GOO_BOUNDS_MAX: usize = 16;
/// Goo body look (Beer–Lambert translucent composite): `GOO_EMIS` is emissive
/// rgb + w glow intensity; `GOO_ABSORB` is absorption rgb per wu + w alpha.
pub const GOO_EMIS: [f32; 4] = [0.55, 3.3, 1.15, 2.8];
pub const GOO_ABSORB: [f32; 4] = [3.4, 0.42, 2.9, 0.9];
/// A gestating bud lerps the look toward a vivid, molten AMBER-GOLD: a saturated
/// warm emissive cranked bright so the birth site glows hot, plus heavy green +
/// blue absorption (low R) so the body reads a radiant orange where it buds — an
/// unmistakable warm contrast against the fluorescent-green goo (never pink).
pub const GOO_BIRTH_EMIS: [f32; 4] = [9.5, 2.0, 0.08, 4.4];
pub const GOO_BIRTH_ABSORB: [f32; 4] = [0.10, 4.4, 6.0, 0.97];

/// Build this frame's goo-composite push constants. ONE site for both backends
/// so the camera packing and the look wiring (squash, floor plane, smin k,
/// emission/absorption) produce identical bytes regardless of GPU.
pub fn build_goo_push(cam: &CamFrame, low_w: u32, low_h: u32, goo_n: usize, goo_nb: usize) -> GooPush {
    use crate::sim::{GOO_FLOOR_Y, GOO_SQUASH};
    GooPush {
        cam_right: [cam.right.x, cam.right.y, cam.right.z, cam.half_w],
        cam_up: [cam.up.x, cam.up.y, cam.up.z, cam.half_h],
        cam_dir: [cam.dir.x, cam.dir.y, cam.dir.z, GOO_SQUASH],
        cam_pos: [cam.pos.x, cam.pos.y, cam.pos.z, GOO_FLOOR_Y],
        dims: [low_w as i32, low_h as i32, goo_n as i32, goo_nb as i32],
        emis: GOO_EMIS,
        absorb: GOO_ABSORB,
        params: [GOO_SMIN_K, 0.0, 0.0, 0.0], // x = smin k; rest unused
        birth_emis: GOO_BIRTH_EMIS,
        birth_absorb: GOO_BIRTH_ABSORB,
    }
}

/// Construct the GPU backend for this platform. Selected at compile time by
/// target OS: Apple Silicon gets the Metal backend (MoltenVK has no ray
/// tracing); everywhere else the hardware-ray-query Vulkan backend. Both
/// satisfy `RenderBackend`, so `Viewer` is identical across platforms.
#[cfg(target_os = "macos")]
pub fn new_backend(window: Option<&Window>, scene: &Scene, cfg: &Config) -> Box<dyn RenderBackend> {
    Box::new(unsafe { crate::metal_backend::MetalBackend::new(window, scene, cfg).expect("metal backend init") })
}

#[cfg(not(target_os = "macos"))]
pub fn new_backend(window: Option<&Window>, scene: &Scene, cfg: &Config) -> Box<dyn RenderBackend> {
    Box::new(unsafe { crate::vulkan_backend::VulkanBackend::new(window, scene, cfg).expect("vulkan backend init") })
}
