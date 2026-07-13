//! `Viewer` — the backend-agnostic orchestrator: the fixed-tick gym sim, the
//! camera/pan/zoom presentation, the headless harness, and the per-frame
//! `FrameState` builder. It owns the `Scene` (greybox source of truth) and
//! drives the GPU exclusively through `backend: dyn RenderBackend`
//! (`VulkanBackend` on desktop, `MetalBackend` on Apple Silicon). No Vulkan or
//! Metal type ever appears here.
//!
//! The frame is DETERMINISTIC: SHOT mode feeds the fixed loop dt = 0 so the
//! wall clock never advances the sim, and the rendered frame is a pure
//! function of (scene, config, CMDS prefix).

use crate::backend::{new_backend, FramePresent, Overlay, RenderBackend};
use crate::capture::Harness;
use crate::gym_loop::GymLoop;
use crate::menu::MenuState;
use crate::view::ViewState;
use glam::{Mat4, Vec2, Vec3};
use iso_core::{clamp_pan, Projection};
use rt_probe::*;
use winit::window::Window;

/// The sim timestep `draw()` feeds the fixed loop. In SHOT (golden capture)
/// mode it is ALWAYS 0, so the wall clock never advances the sim and the
/// captured frame is a pure function of (scene, config, CMDS prefix).
pub fn shot_sim_dt(shot: bool, dt: f32) -> f32 {
    if shot {
        0.0
    } else {
        dt
    }
}

pub const ZOOM_MIN: f32 = 1.0;
pub const ZOOM_MAX: f32 = 4.0; // web game-studio: zoomMin 1, zoomMax 4, zoomStep 1

/// Resolve `PROJ` from the environment (shell-only read, like LOOK/AUDIO):
/// a preset name (`iso21`, `trimetric`) or its menu index — the ESC menu's
/// env string prints the index. Default: trimetric — THE game projection
/// (owner pick, 2026-07-12); iso21 stays in the menu as the A/B reference.
pub fn proj_from_env() -> Projection {
    let default = iso_core::by_name("trimetric").expect("trimetric preset");
    match std::env::var("PROJ") {
        Ok(v) => v
            .parse::<usize>()
            .ok()
            .and_then(|i| iso_core::presets().get(i).copied())
            .or_else(|| iso_core::by_name(&v))
            .unwrap_or_else(|| {
                let names: Vec<&str> = iso_core::presets().iter().map(|p| p.name).collect();
                eprintln!("PROJ={v}: unknown preset ({}) — using {}", names.join(" "), default.name);
                default
            }),
        Err(_) => default,
    }
}

pub struct Viewer {
    // ---- scene + GPU backend
    pub scene: Scene,
    pub backend: Box<dyn RenderBackend>,
    // ---- resolved config + live tunables (the ESC menu writes these)
    pub cfg: Config,
    /// The active look preset (look-as-data, Faza 1b): the whole aesthetic —
    /// palette, sun/sky, post stack, exposure. Since the polana lock there
    /// is one look; `apply_look` (LOOK_SWITCH) keeps the runtime-switch
    /// machinery alive and LOOK env still seeds/validates the boot look.
    pub look: &'static crate::look::Look,
    pub exposure: f32,
    pub style: StyleCfg,
    /// Surface response (look data + env overrides, Faza 1b): specular
    /// strength, gloss remap, bump strength/frequency, ambient GI scale.
    pub spec: f32,
    pub gloss: f32,
    pub bump: f32,
    pub bump_scale: f32,
    pub gi: f32,
    pub ao: f32,
    pub ao_r: f32,
    pub ao_n: i32,
    pub light_anim: bool,
    /// LIGHTS env: a presentation multiplier on the lamps (direct via the
    /// emission build, indirect via the probe-bank lerp).
    pub lights_dim: f32,
    pub debug: i32,
    /// The active projection preset (projection-as-data, Faza 1a): seeds the
    /// camera, the lattice snapping, picks and the tonemap projection rows.
    /// The ESC settings menu switches it live; PROJ env seeds it.
    pub proj: Projection,
    // ---- grouped state
    pub view: ViewState,
    /// The gym sim loop — THE game loop (docs/VISION.md Faza 0).
    pub gym: GymLoop,
    /// Lamp NEE slots in slot order, with their authored base rgb — the
    /// scene's named point lights joined onto the backend's handles.
    pub light_keys: Vec<(LightKey, [f32; 3])>,
    /// Synth-blip output (None = headless/no device/AUDIO=0 — fail-soft).
    pub audio: Option<crate::audio::AudioOut>,
    pub menu: MenuState,
    pub harness: Harness,
    pub rec: Option<crate::capture::Rec>,
    pub rec_jobs: Vec<std::thread::JoinHandle<()>>,
    pub movie: Option<crate::capture::Movie>,
    // ---- Stage-2 dynamic-GI tear-off spike (voxel-physics-spike branch):
    // GI_TEAR=<tick> hides the gym roof and refreshes the interior probes at
    // that sim tick (SHOT drains fully for a settled single frame; live/DEMO
    // amortizes over frames). `None` in the normal gym.
    gi_tear: Option<u64>,
    roof_prims: std::ops::Range<usize>,
    room_min: Vec3,
    room_max: Vec3,
    torn: bool,
    // ---- frame clock / lifecycle
    pub frame: u32,
    pub start_time: std::time::Instant,
    pub last_frame: Option<std::time::Instant>,
    pub frame_time_sum: f32,
    pub exit_requested: bool,
}

/// Join the scene's named lamp point lights onto the backend's NEE slots, in
/// slot order. Asserts the join is complete — a lamp the builder forgot to
/// name would silently keep its authored emission forever.
fn join_lamp_lights(scene: &Scene, handles: &SceneHandles, light_count: u32) -> Vec<(LightKey, [f32; 3])> {
    assert!(
        handles.lights.len() == light_count as usize,
        "light name-join incomplete: {} named lights over {} NEE slots — name every lamp in the scene builder",
        handles.lights.len(),
        light_count
    );
    let mut by_slot: Vec<(&String, LightKey)> = handles.lights.iter().map(|(n, &k)| (n, k)).collect();
    by_slot.sort_by_key(|&(_, k)| k);
    by_slot
        .into_iter()
        .map(|(name, key)| {
            let &(_, idx) = scene.named_point_lights.iter().find(|(n, _)| n == name).unwrap_or_else(|| panic!("SceneHandles light {name:?} missing from the scene's named point lights"));
            let p = scene.point_lights[idx];
            (key, [p[4], p[5], p[6]])
        })
        .collect()
}

impl Viewer {
    /// `window: None` runs fully headless (SHOT/DEMO captures). Builds the
    /// gym scene (single source of truth: the hand-authored level drives sim
    /// collision + greybox visuals), the GPU backend, the light join, then
    /// applies the seeded camera/pan/trace.
    pub unsafe fn new(window: Option<&Window>, cfg: Config) -> Result<Viewer, Box<dyn std::error::Error>> {
        let start_time = std::time::Instant::now();
        let mut spec = house_game::gym::sim::gym_level();
        // Dynamic-GI spike: GI_INDOORS spawns the player inside the building so
        // the WALLCUT dollhouse reveals the interior; NO_ROOF builds the gym
        // roofless (the "torn off" state) for the static A/B.
        if std::env::var("GI_INDOORS").is_ok() {
            spec.player_start = house_game::gym::grid::CellPos::new(5, 5);
        }
        let roof = std::env::var("NO_ROOF").is_err();
        // LOOK env picks the boot look (look.rs presets; the ESC menu
        // switches live from there)
        let look = crate::look::from_env();
        let (mut scene, gym_meta) = crate::gym_scene::build_gym(&spec, look, roof);
        // Destructibility spike (voxel-physics-spike branch): PHYS=1 builds a
        // Rapier brick wall + projectile and authors matching `phys/{i}`
        // dynamic runs into the scene BEFORE the backend consumes it. `None`
        // (and zero extra geometry) in the normal gym.
        let phys = std::env::var("PHYS").is_ok().then(phys_spike::PhysWorld::demo);
        if let Some(p) = &phys {
            crate::phys_scene::author(&mut scene, p);
        }
        // Dynamic-GI spike (Stage 1): GI_DEMO=1 authors a BAKED destructible
        // wall (in the probe bake); =2 boots already-destroyed for the static
        // A/B. The runtime destroy+re-bake path is `destroy_gi_wall`.
        let gi_demo = std::env::var("GI_DEMO").ok().and_then(|v| v.parse::<u32>().ok());
        if let Some(mode) = gi_demo {
            crate::gi_demo::author(&mut scene, look, mode == 1);
        }
        println!("scene: {} prims, {} tris (the gym, look {})", scene.primitives.len(), scene.indices.len() / 3, look.name);
        let player0 = scene.player_start;

        let backend = new_backend(window, &scene, &cfg);
        let light_keys = join_lamp_lights(&scene, backend.handles(), backend.light_count());

        // audio: windowed sessions only (SHOT/DEMO stay silent + headless);
        // AUDIO=<master> tunes volume, AUDIO=0 disables entirely
        let audio = if window.is_some() {
            let master: f32 = std::env::var("AUDIO").ok().and_then(|v| v.parse().ok()).unwrap_or(0.6);
            if master > 0.0 { crate::audio::AudioOut::new(master) } else { None }
        } else {
            None
        };
        let headless = cfg.harness.shot.is_some() || cfg.harness.demo.is_some() || cfg.harness.dump.is_some() || cfg.harness.movie.is_some();
        let mut r = Viewer {
            scene,
            backend,
            light_keys,
            audio,
            proj: proj_from_env(),
            look,
            // look-as-data (Faza 1b): the look authors exposure, the post
            // stack and the surface response; env vars override on top (the
            // agent/harness interface)
            exposure: cfg.render.exposure.unwrap_or(look.exposure),
            style: look.style.env_over(),
            spec: cfg.render.spec.unwrap_or(look.spec),
            gloss: cfg.render.gloss.unwrap_or(look.gloss),
            bump: cfg.render.bump.unwrap_or(look.bump),
            bump_scale: cfg.render.bump_scale.unwrap_or(look.bump_scale),
            gi: cfg.render.gi.unwrap_or(look.gi),
            ao: cfg.render.ao,
            ao_r: cfg.render.ao_r,
            ao_n: cfg.render.ao_n,
            light_anim: cfg.game.light_anim,
            lights_dim: cfg.game.lights,
            debug: cfg.render.debug,
            view: ViewState {
                zoom: cfg.game.zoom.round().clamp(ZOOM_MIN, ZOOM_MAX),
                yaw_q: cfg.game.yaw_q,
                rot: None,
                yaw_anim: 0.0,
                pan: Vec2::ZERO,
                target: player0,
                move_accum: Vec2::ZERO,
                cursor: Vec2::ZERO,
                wheel_accum: 0.0,
            },
            // live windowed sessions boot into the TITLE menu (a regular game
            // start screen); every harness mode must render the game instead.
            menu: MenuState {
                mode: if !headless { crate::menu::MenuMode::Title } else { crate::menu::MenuMode::Closed },
                back: crate::menu::MenuMode::Closed,
                sel: 0,
                drag: false,
            },
            gym: GymLoop::new(spec),
            harness: Harness::from_cfg(&cfg),
            rec: None,
            rec_jobs: Vec::new(),
            movie: cfg.harness.movie.clone().map(|dir| {
                std::fs::create_dir_all(&dir).ok();
                crate::capture::Movie::new(dir, &cfg)
            }),
            gi_tear: std::env::var("GI_TEAR").ok().map(|v| v.parse().unwrap_or(0)),
            roof_prims: gym_meta.roof_prims,
            room_min: gym_meta.room_min,
            room_max: gym_meta.room_max,
            torn: false,
            frame: 0,
            start_time,
            last_frame: None,
            frame_time_sum: 0.0,
            exit_requested: false,
            cfg,
        };
        r.gym.phys = phys; // hand the stepped physics world to the loop
        // backend.new already built the swapchain (and baked probes); centre the
        // visible crop now that the view exists.
        r.recenter_pan();
        // optional initial pan offset (low pixels), for headless capture tests
        if r.cfg.game.pan != (0.0, 0.0) {
            let d = Vec2::new(r.cfg.game.pan.0, r.cfg.game.pan.1);
            r.view.pan += d;
            r.clamp_pan_to_buffer();
        }
        // optional camera look-at override (world units), for framing captures
        if r.cfg.game.target.0.is_some() || r.cfg.game.target.1.is_some() {
            let t = Vec3::new(r.cfg.game.target.0.unwrap_or(r.view.target.x), 0.0, r.cfg.game.target.1.unwrap_or(r.view.target.z));
            r.view.target = r.proj.snap_ground_to_lattice(t, r.yaw_deg());
        }
        // LOOK_SWITCH harness knob: exercise the RUNTIME look-switch path
        // (backend rebuild_scene). With polana as the only look this is a
        // FORCE-REBUILD identity check — apply_look never early-outs, so
        // LOOK_SWITCH=polana rebuilds into the booted look and a SHOT after
        // it must match a direct boot at the Metal cross-run noise floor
        // (pins scene swap, probe rebake and light re-join for stale state).
        if let Some(name) = r.cfg.harness.look_switch.clone() {
            match crate::look::by_name(&name) {
                Some(l) => r.apply_look(l),
                None => eprintln!("LOOK_SWITCH={name}: unknown preset — ignored"),
            }
        }
        // CMDS replay prefix (deterministic) — runs LAST so the trace acts on
        // the fully seeded state.
        r.gym.run_cmds(&r.cfg);
        // DEMO=trace.txt: arm the headless per-tick gameplay dump.
        if r.cfg.harness.demo.is_some() {
            let dir = r.cfg.harness.demo_dir.clone().unwrap_or_else(|| "demo".into());
            std::fs::create_dir_all(&dir).unwrap_or_else(|e| panic!("DEMO_DIR {dir}: {e}"));
            let ticks = r.gym.demo_load(&r.cfg);
            r.harness.demo = Some(crate::capture::Demo { dir, ticks, done: 0 });
        }
        Ok(r)
    }

    /// PAUSE-menu RESTART: rebuild a fresh GymLoop from the stored spec
    /// (same level, zeroed sim). View state (camera/zoom) survives; the
    /// follow-cam recentres on the respawned player's first step.
    pub fn restart_gym(&mut self) {
        self.gym = GymLoop::new(self.gym.spec.clone());
        // spike: re-arm the physics wall so RESTART replays the smash
        self.gym.phys = std::env::var("PHYS").is_ok().then(phys_spike::PhysWorld::demo);
    }

    /// Runtime look switch (Faza 1b machinery): rebuild the greybox in the
    /// given look, swap the backend's scene resources (probe rebake,
    /// disk-cached per look — blocking, a few seconds on a cold cache),
    /// re-join the lamp lights, re-resolve exposure + the post stack (look
    /// base + env overrides). Sim state is untouched — the player stays
    /// exactly where they stood. Deliberately NO same-look early-out: since
    /// the polana lock the only caller is the LOOK_SWITCH harness knob,
    /// whose value IS the forced same-look rebuild (identity check); a
    /// future menu look row should guard on ptr::eq at its call site.
    pub fn apply_look(&mut self, look: &'static crate::look::Look) {
        let t0 = std::time::Instant::now();
        let (mut scene, _) = crate::gym_scene::build_gym(&self.gym.spec, look, true);
        // spike: keep the physics runs present across a look switch
        if let Some(p) = &self.gym.phys {
            crate::phys_scene::author(&mut scene, p);
        }
        unsafe { self.backend.rebuild_scene(&scene, &self.cfg) };
        self.light_keys = join_lamp_lights(&scene, self.backend.handles(), self.backend.light_count());
        self.scene = scene;
        self.look = look;
        self.exposure = self.cfg.render.exposure.unwrap_or(look.exposure);
        self.style = look.style.env_over();
        self.spec = self.cfg.render.spec.unwrap_or(look.spec);
        self.gloss = self.cfg.render.gloss.unwrap_or(look.gloss);
        self.bump = self.cfg.render.bump.unwrap_or(look.bump);
        self.bump_scale = self.cfg.render.bump_scale.unwrap_or(look.bump_scale);
        self.gi = self.cfg.render.gi.unwrap_or(look.gi);
        println!("look: {} ({:.0} ms)", look.name, t0.elapsed().as_secs_f32() * 1000.0);
    }

    /// Fire-and-forget UI sound (menu nav/pick) — presentation only.
    pub fn ui_blip(&self, id: &str) {
        if let Some(a) = &self.audio {
            a.play(id, 1.0);
        }
    }

    /// Whole-low-pixel render scale for the current zoom (#4).
    pub fn rs(&self) -> i32 {
        self.backend.rs(self.view.zoom)
    }

    /// (low buffer size, visible-region size) in low pixels, for pan clamping.
    pub fn low_and_vis(&self) -> (Vec2, Vec2) {
        self.backend.low_and_vis(self.view.zoom)
    }

    pub fn clamp_pan_to_buffer(&mut self) {
        if self.backend.has_target() {
            let (low, vis) = self.low_and_vis();
            self.view.pan = clamp_pan(self.view.pan, low, vis);
        }
    }

    /// Centre the visible crop in the low buffer.
    pub fn recenter_pan(&mut self) {
        if self.backend.has_target() {
            let (low, vis) = self.low_and_vis();
            self.view.pan = (low - vis) * 0.5;
        }
    }

    /// Rebuild the GPU target on resize/out-of-date, then re-centre the crop.
    pub unsafe fn recreate(&mut self, w: u32, h: u32) {
        self.backend.recreate(w, h);
        self.recenter_pan();
    }

    /// Drive + present one frame. Returns false if the swapchain needs rebuild.
    /// CPU half (sim, camera, FrameState build, capture/overlay decisions) here;
    /// the GPU half is `backend.render_present`.
    pub unsafe fn draw(&mut self) -> bool {
        if !self.backend.has_target() {
            return true;
        }
        let now = std::time::Instant::now();
        let dt = self.last_frame.map(|t| (now - t).as_secs_f32().min(0.1)).unwrap_or(0.0);
        self.last_frame = Some(now);
        self.harness_pre_frame(); // ROTATE_AT / DUMP_AT synthetic inputs
        self.advance_sim(dt); // DEMO tick / pause / live fixed-tick
        self.maybe_tear(); // Stage-2 dynamic-GI spike: roof tear-off at GI_TEAR
        self.follow_player_camera(); // follow the eased player body
        // smooth quarter-turn in flight: ease the yaw
        self.advance_rotation(dt);
        // clip recording: collect last frame's capture + decide if this frame
        // captures (returns the down-blit target size when it should)
        let capture_req = self.prepare_capture();

        // camera: the active projection preset at the movable look-at target
        let (low_w, low_h) = self.backend.low_dims();
        let cam = self.proj.camera_at(self.scene.min, self.scene.max, low_w, low_h, self.yaw_deg(), self.view.target);

        // This frame's scene state, typed — built from the gym SNAPSHOT:
        // nothing below reads sim internals, only what the snapshot publishes.
        let mut instances: Vec<(InstanceKey, Mat4)> = self.gym.instances(self.backend.handles());
        instances.extend(self.gym.phys_instances(self.backend.handles()));
        let dim = self.lights_dim;
        let emission: Vec<(LightKey, [f32; 3])> = self.light_keys.iter().map(|&(k, base)| (k, [base[0] * dim, base[1] * dim, base[2] * dim])).collect();
        let fs = FrameState {
            cam,
            room_lights: dim,
            time: self.gym.time(), // SIM time — replayable, no wall clock
            light_emission: &emission,
            spotlights: &[],
            instances: &instances,
        };

        // ESC menu overlay (panel/hamburger), copied onto the PRESENTED
        // image only — never `out`, so SHOT/MOVIE/DUMP/DEMO captures stay
        // UI-free (those modes pass no overlay).
        let menu_canvas = self.overlay_frame();
        let overlay = menu_canvas.as_ref().map(|(buf, w, h, center)| Overlay { menu: (buf, *w, *h), menu_center: *center });

        // capture target: ensure it's the right size this frame, if capturing
        let capture = match capture_req {
            Some((cw, ch)) => {
                self.backend.ensure_capture_target(cw, ch);
                true
            }
            None => false,
        };

        // burned-in stamps: the click-to-move destination marker. Game
        // picture, not shell UI — they ride into SHOT/DEMO captures.
        let stamps = self.gym.stamps(&self.pick_xform(), self.backend.extent(), self.rs() as u32);
        let fp = FramePresent {
            fs: &fs,
            pan: self.view.pan,
            target: self.view.target,
            yaw_deg: self.yaw_deg(),
            proj: self.proj,
            zoom: self.view.zoom,
            ao: self.ao,
            ao_r: self.ao_r,
            ao_n: self.ao_n,
            spec: self.spec,
            gloss: self.gloss,
            bump: self.bump,
            bump_scale: self.bump_scale,
            gi: self.gi,
            matq: self.cfg.render.matq,
            ao_dither: self.cfg.render.ao_dither,
            refl: self.cfg.render.refl,
            refl_px: self.cfg.render.refl_px,
            debug: self.debug,
            exposure: self.exposure,
            style: self.style,
            frame: self.frame,
            overlay,
            stamps: &stamps,
            // permanent sunny day (the joyful default); SKY env still scales
            // the authored env via lighting_env
            sky_dim: 1.0,
            roi: self.roi_info(),
            // FLOORCUT: env-only framing knob now (the gym is single-storey)
            cut_y: self.cfg.game.cut,
            // ... and the WALLCUT sill-height cutaway follows "is the player
            // indoors" — the dollhouse: the building opens when entered.
            wall_cut: self.cfg.game.wall_cut.or_else(|| self.gym.wall_cut()),
            capture,
        };
        let ok = self.backend.render_present(&fp);

        self.frame = self.frame.wrapping_add(1);

        // CPU frame-time (how long draw() blocks the main thread)
        let cpu_ms = now.elapsed().as_secs_f32() * 1000.0;
        if self.cfg.harness.timing {
            println!("TIME f={:04} total={:6.2}ms rot={}", self.frame, cpu_ms, self.view.rot.is_some());
        }
        self.frame_time_sum += cpu_ms;
        if let Some(limit) = self.cfg.harness.frames_limit {
            if self.frame >= limit {
                self.backend.wait_idle();
                println!("FRAMES={limit}: avg CPU frame {:.2}ms", self.frame_time_sum / limit as f32);
                self.exit_requested = true;
            }
        }

        // harness outputs: DUMP frame collection, the scripted movie, SHOT
        self.harness_post_frame();

        ok
    }

    /// Stage-2 dynamic-GI spike trigger: at sim tick ≥ `GI_TEAR`, hide the gym
    /// roof (mask 0 → gone from the image and the GI transport) and refresh the
    /// interior probes. Headless SHOT ignores the tick gate and drains the
    /// refresh fully, so the single captured frame is the settled result (the
    /// A/B ground truth); live/DEMO waits for the tick and amortizes, so the
    /// interior brightening plays out over the following frames with no stall.
    fn maybe_tear(&mut self) {
        let Some(at) = self.gi_tear else { return };
        if self.torn || self.roof_prims.is_empty() {
            return;
        }
        let is_shot = self.harness.shot.is_some();
        if !is_shot && self.gym.tick.0 < at {
            return;
        }
        let prims: Vec<usize> = self.roof_prims.clone().collect();
        // GI_TEAR_ALL: refresh EVERY probe on the same roof-masked scene (a full
        // rebake) — the verification ground truth the targeted room-region
        // refresh must match, bit-for-bit, inside the room.
        let (min, max) = if std::env::var("GI_TEAR_ALL").is_ok() { (Vec3::splat(-1e6), Vec3::splat(1e6)) } else { (self.room_min, self.room_max) };
        unsafe { self.backend.tear_off(&prims, min, max, !is_shot) };
        self.torn = true;
    }

    /// Sim-advance phase of `draw()`: DEMO drives ONE tick per rendered frame
    /// (deterministic capture); live play routes through pause (menu open) →
    /// the fixed-tick accumulator. SHOT feeds dt=0 so the wall clock never
    /// reaches the sim.
    fn advance_sim(&mut self, dt: f32) {
        self.gym.yaw_q = self.view.yaw_q;
        if self.harness.demo.is_some() {
            self.gym.demo_advance_tick();
            return;
        }
        // menu pause (live): the sim clock stops dead while any menu is up —
        // the accumulator isn't fed, so RESUME continues exactly where it
        // stopped. Harness modes never pause.
        if self.menu_open() && self.harness.shot.is_none() {
            return;
        }
        let sim_dt = shot_sim_dt(self.harness.shot.is_some(), dt);
        self.gym.run_due(sim_dt);
    }

    /// Overlay phase of `draw()`: the ESC/game-menu canvas + centering flag,
    /// owned so the borrow in `FramePresent` can outlive the builder. `None`
    /// in every harness capture mode (SHOT/MOVIE/DUMP/DEMO stay UI-free).
    fn overlay_frame(&mut self) -> Option<(Vec<u32>, i32, i32, bool)> {
        if self.harness.shot.is_none() && self.movie.is_none() && self.harness.dump_dir.is_none() && self.harness.demo.is_none() {
            let (buf, w, h) = self.menu_canvas();
            let center = matches!(self.menu.mode, crate::menu::MenuMode::Title | crate::menu::MenuMode::Pause);
            Some((buf, w, h, center))
        } else {
            None
        }
    }

    /// ROI phase of `draw()`: the reveal-disc parameters when ROI mode is on.
    fn roi_info(&self) -> Option<crate::backend::RoiInfo> {
        if !self.cfg.game.roi {
            return None;
        }
        // Anchor the reveal disc on the player's MID-HEIGHT, not its feet:
        // the body is ~1.4 wu tall, so projecting the feet (y≈0) puts the
        // disc centre low on screen. The anchor is the EASED body — a
        // spawn-pinned disc means no reveal once you walk behind the building.
        let center = self.gym.cam_target() + glam::Vec3::new(0.0, 0.65, 0.0);
        // ROI_XRAY=contour adds faint wall-silhouette lines ON TOP of the ghost
        // stipple. Encoded by NEGATING the ghost cap: the shader reads roi2.w<0
        // as hybrid mode and |roi2.w| as the coverage cap, so the stipple stays.
        let ghost = if self.cfg.game.roi_contour { -self.cfg.game.roi_ghost } else { self.cfg.game.roi_ghost };
        Some(crate::backend::RoiInfo { player: center, radius_px: self.cfg.game.roi_radius, falloff_px: self.cfg.game.roi_falloff, ghost })
    }
}
