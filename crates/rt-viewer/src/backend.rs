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
use iso_core::{render_scale, Projection};
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
    pub style5: [f32; 4], // saturation, contrast, luma quantize levels, contour soften
    pub style6: [f32; 4], // analog: luma noise, chroma noise, scanline tear; w = CRT mask strength
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
    /// The frame's projection preset (projection-as-data, Faza 1a) — the
    /// backend feeds it to `build_tone_push` so the tonemap's outline
    /// projection rows match the camera in `fs.cam`.
    pub proj: Projection,
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
    pub matq: f32,
    pub ao_dither: f32,
    pub refl: f32,
    pub refl_px: i32,
    /// CONTOUR COVERAGE AA weight (0 = off — no tap dispatch is issued and the
    /// image is byte-identical to the pre-AA renderer).
    pub aa: f32,
    /// Contour-AA scope: 0 = every surface, 1/2 = the per-material opt-in bit
    /// ([`crate::crack::AA_BIT`]) decides (cracked piers / the picked pier).
    pub aa_scope: i32,
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
    /// Per-frame multiplier on the env sun/sky fill (1.0 = authored — the
    /// permanent sunny day; a future day cycle would drive this).
    pub sky_dim: f32,
    /// Per-frame sun/sky override — the demo look-morph ([`crate::demos`])
    /// cross-fades this each frame so the DIRECT lighting (sun angle/tint, sky
    /// dome, fog) morphs smoothly with no rebake. `None` = use the scene's
    /// baked env (bit-identical to pre-morph frames). The frozen probe
    /// indirect stays at the boot bake — subtle, and the direct pass dominates.
    pub env: Option<rt_probe::EnvBlock>,
    /// Dollhouse see-through reveal (CAVE_ROI): player world pos + disc radius /
    /// falloff in low-res px. The backend projects the disc centre via the shared
    /// `rt_probe::roi_push` and packs it into the shade push. `None` → no reveal.
    pub roi: Option<RoiInfo>,
    /// FLOORCUT multi-floor reveal: world-Y plane above which every primary
    /// hit dissolves (storeys above the player's floor). Packed via
    /// `rt_probe::cut16`. `None` → no cut (bit-identical to pre-cut frames).
    pub cut_y: Option<f32>,
    /// WALLCUT indoor cutaway: world-Y plane above which OCCLUDER hits
    /// (walls/roofs/lintels) dissolve — the sill-height dollhouse while the
    /// player is indoors. Bodies/props keep full height. `None` → off.
    pub wall_cut: Option<f32>,
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
    pub menu: (&'a [u32], i32, i32), // canvas, w, h
    /// Center the menu canvas on the window (the arena TITLE / PAUSE game
    /// menus) instead of pinning it at the top-left margin (tune panel).
    pub menu_center: bool,
}

/// What a scene swap ([`RenderBackend::rebuild_scene`]) must do about the frozen
/// GI probe banks.
///
/// `Full` is the honest default: a look switch repaints every surface the bake
/// reads, a boot has nothing to carry, and a scene whose BOUNDS moved lands its
/// probes somewhere else entirely (the grid is derived from `scene.min/max`).
///
/// `Local` is the crack-lab knob release: one pier's boxes were regenerated
/// inside their own AABB and every other probe in the level is still exactly
/// right, so the banks are carried across the swap and only the probes near the
/// listed WORLD AABBs are re-baked (padded by
/// `rt_probe::gpu_scene::REFRESH_PAD_SPACINGS` — the backend owns the padding
/// because only it knows the resolved spacing). On the M2: the full grid is
/// ~6.6 s, one pier ~3.3 s (16 % of the probes — the refresh is latency-bound,
/// see `LOCAL_REFRESH_MAX_FRACTION`); on the RTX the whole bake is ~115 ms and
/// nobody notices either way.
///
/// `Roll` is the same carry with the re-bake DEFERRED: the dirty probes are not
/// touched here, the amortized DDGI roll (`roll_step`, the machinery the
/// wall-smash tear-off already runs) settles them over the next frames instead.
/// It exists for the age-ramp demo beat ([`crate::demos::Action::AgeWall`]),
/// which steps geometry ~8 times inside three seconds: a synchronous refresh is
/// LATENCY-bound at 3-5 s whatever its size (one thread per probe, 2048 rays
/// serial — see `rt_probe::gpu_scene::LOCAL_REFRESH_MAX_FRACTION`), so `Local`
/// would stall the beat for a minute, while the scene swap alone measures ~30 ms
/// on the M2. The price is honest and bounded: for ~64 frames the probes around
/// ONE wall carry the previous step's bounce, and they settle to a 256-ray
/// rolling estimate rather than the 2048-ray bake — so a capture that must be
/// comparable still comes from a boot, exactly as for `Local`.
///
/// The backend falls back to `Full` if the new scene's grid does not match the
/// carried one, if nothing has been baked yet, if a dirty region misses the
/// grid, or if the dirty set is large enough that refreshing costs more than
/// baking — a stale probe must never survive a rebuild, so every uncertain case
/// pays the bake.
#[derive(Clone, Copy)]
pub enum ProbeRefresh<'a> {
    Full,
    Local(&'a [(Vec3, Vec3)]),
    Roll(&'a [(Vec3, Vec3)]),
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

    /// The zoom=1 integer upscale factor (BASE_SCALE / the PIXEL env knob).
    fn base_scale(&self) -> u32;
    /// Whole-low-pixel render scale for `zoom` (#4).
    fn rs(&self, zoom: f32) -> i32 {
        render_scale(zoom, self.base_scale())
    }
    /// (low buffer size, visible-region size) in low pixels, for pan clamping.
    fn low_and_vis(&self, zoom: f32) -> (Vec2, Vec2) {
        let (low_w, low_h) = self.low_dims();
        let (ext_w, ext_h) = self.extent();
        let rs = self.rs(zoom) as f32;
        let low = Vec2::new(low_w as f32, low_h as f32);
        let vis = Vec2::new((ext_w as f32 / rs).ceil(), (ext_h as f32 / rs).ceil());
        (low, vis)
    }
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

    /// Runtime LOOK switch (Faza 1b): rebuild every scene-dependent GPU
    /// resource (geometry/material/light buffers, AS, env block, probe banks)
    /// from a freshly built `Scene`, keeping device/pipelines/window target.
    /// Blocking (probe rebake or disk-cache load). The Viewer must re-join
    /// its light keys against the new `handles()` afterwards.
    ///
    /// `refresh` decides what happens to the frozen GI — see [`ProbeRefresh`].
    /// A backend that cannot honour `Local` must fall back to the full bake:
    /// the result is identical, only slower.
    unsafe fn rebuild_scene(&mut self, scene: &Scene, cfg: &Config, refresh: ProbeRefresh);

    /// Dynamic-GI tear-off (Stage 2): hide the static primitive instances `prims`
    /// from the TLAS (mask 0 — culled by primary AND probe rays, so gone from the
    /// image and from the frozen GI transport) and refresh the probes whose cells
    /// overlap the world AABB `[min, max]` (padded ~1 spacing). Each refreshed
    /// probe re-bakes its full ray budget via a `first_probe` sub-range dispatch,
    /// bit-identical to a full rebake of that probe — so no whole-grid stall.
    /// `amortize` spreads the refresh over subsequent `render_present` calls at a
    /// fixed per-frame probe budget (the no-hitch live path); `false` drains it
    /// fully now (headless SHOT / A-B captures want the settled result in one
    /// frame). A default no-op keeps this an opt-in spike hook.
    unsafe fn tear_off(&mut self, _prims: &[usize], _min: Vec3, _max: Vec3, _amortize: bool) {}

    /// Live per-material `_pad` update (crack-lab knobs + selection bit):
    /// writes the CPU material shadow the per-frame practicals stream already
    /// re-uploads, so the change shows next frame — no scene rebuild, no
    /// probe rebake (the bake reads base colour only, and the disk cache is
    /// keyed at build time). Lost on `rebuild_scene` — the Viewer re-stamps
    /// the fresh `Scene` before rebuilding instead.
    fn set_material_pad(&mut self, _material_id: usize, _pad: i32) {}

    /// Live per-material EFFECT WORD update — [`set_material_pad`]'s sibling for
    /// the wear family's appearance dials, which ride `Material.emissive[3]`
    /// (see `crate::wear` for the codec and the 24-bit budget). Same mechanism:
    /// the per-frame practicals stream re-uploads the whole material array, so
    /// writing the CPU shadow is the entire job. Deliberately the ONLY write path
    /// for the word — the probe-cache content key hashes the material bytes, so a
    /// pre-build stamp would re-key the cache and rebake (~6.5 s on the M2) for a
    /// datum the bake cannot see. Lost on `rebuild_scene`; `Viewer::wear_stamp`
    /// re-stamps after every rebuild.
    fn set_material_effect(&mut self, _material_id: usize, _word: f32) {}

    /// Live per-material STORY KEY update — the third sibling: the VARIANT
    /// (scrub) dial slides the key every damage field seeds off, and the key
    /// rides `Material.base_color[3]` (`crate::wear::story_key` /
    /// `wall::scrub_key`). Unlike the effect word this datum IS visible to the
    /// probe bake — the key stamps PRE-build and the cache re-keys per scrub
    /// bucket; this live path exists so a scrub DRAG morphs the painted field
    /// per frame, with the geometry and its bake catching up on release like
    /// every other geometry dial.
    fn set_material_story(&mut self, _material_id: usize, _story: f32) {}

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
pub fn build_tone_push(low_w: u32, low_h: u32, ext_w: u32, ext_h: u32, rs: i32, pan: Vec2, target: Vec3, proj: &Projection, yaw_deg: f32, exposure: f32, style: &StyleCfg, frame: u32) -> TonePush {
    let pan = pan.round();
    let (_cd, cright, cup) = proj.basis(yaw_deg);
    let pa = cright * proj.s;
    let pb = -cup * proj.s;
    let off_x = -target.dot(cright) * proj.s + low_w as f32 * 0.5 - 0.5;
    let off_y = target.dot(cup) * proj.s + low_h as f32 * 0.5 - 0.5;
    // world-anchored dither/grain phase, quantised with round(x - 0.25): keeps
    // the pattern from slipping 1 px on odd/even window parities (see the long
    // comment in the old draw()).
    let dphase_x = (-target.dot(cright) * proj.s + low_w as f32 * 0.5 - 0.75).round();
    let dphase_y = (target.dot(cup) * proj.s + low_h as f32 * 0.5 - 0.75).round();
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
        style5: [style.sat, style.contrast, style.lumaq, style.aa_soft],
        style6: [style.analog, style.analog_chroma, style.analog_tear, style.crt_mask],
    }
}

// ---- shared target / overlay geometry ---------------------------------------
// One source for BOTH backends: the low-res buffer sizing, the UI scale rule,
// and the overlay placement/clipping must agree bit-for-bit or the two
// golden sets drift for non-GPU reasons.

/// Low-res overscan border (low px) so the pan crop never reveals edge bars.
pub const MARGIN: u32 = 32;

/// Low-res G-buffer dimensions for a window extent: window / base-scale at
/// zoom=1 (whole pixels, floored at 1) plus the overscan border on all sides.
pub fn low_dims_for(ext_w: u32, ext_h: u32, base_scale: u32) -> (u32, u32) {
    (ext_w.div_ceil(base_scale).max(1) + 2 * MARGIN, ext_h.div_ceil(base_scale).max(1) + 2 * MARGIN)
}

/// Integer UI scale for menus/HUD at a window height (chunky-plate rule).
pub fn menu_scale_for(ext_h: u32) -> u32 {
    (ext_h / 400).clamp(2, 6)
}

/// Window-px origin for the CPU menu overlay: game menus (TITLE/PAUSE) centre
/// on the window; the tune panel / hamburger pin at the top-left margin.
/// `pw`/`ph` are the expanded (logical × scale) canvas size.
pub fn overlay_origin(center: bool, ext_w: u32, ext_h: u32, pw: u64, ph: u64, margin: i64) -> (i64, i64) {
    if center {
        (((ext_w as i64 - pw as i64) / 2).max(0), ((ext_h as i64 - ph as i64) / 2).max(0))
    } else {
        (margin, margin)
    }
}

/// The shared overlay/stamp clip rule: a canvas that does not fit WHOLE inside
/// the target is skipped entirely (negative-origin or overhanging stamps never
/// draw — both backends must agree or HUD bytes diverge between golden sets).
pub fn stamp_in_bounds(dx: i64, dy: i64, pw: u64, ph: u64, ext_w: u32, ext_h: u32) -> bool {
    dx >= 0 && dy >= 0 && dx as u64 + pw <= ext_w as u64 && dy as u64 + ph <= ext_h as u64
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
