//! `Viewer` — the backend-agnostic orchestrator: the fixed-tick sim, the
//! camera/pan/zoom presentation, the headless harness, and the per-frame
//! `FrameState` builder. It owns the `Scene` (collision + greybox source of
//! truth) and drives the GPU exclusively through `backend: dyn RenderBackend`
//! (`VulkanBackend` on desktop, `MetalBackend` on Apple Silicon). No Vulkan or
//! Metal type ever appears here.
//!
//! The frame is DETERMINISTIC: SHOT mode feeds the fixed loop dt = 0 so the
//! wall clock never advances the sim, and the rendered frame is a pure
//! function of (scene, config, CMDS prefix).

use crate::backend::{new_backend, FramePresent, Overlay, RenderBackend};
use crate::capture::Harness;
use crate::menu::MenuState;
use crate::sim::GameLoop;
use crate::view::ViewState;
use glam::{Mat4, Vec2, Vec3};
use iso_core::{clamp_pan, iso_camera_at, snap_ground_to_lattice};
use rt_probe::*;
use winit::window::Window;

/// The sim timestep `draw()` feeds the fixed loop. In SHOT (golden capture)
/// mode it is ALWAYS 0, so the wall clock never advances the sim and the
/// captured frame is a pure function of (scene, config, CMDS prefix) — the
/// "provably sim-independent" guarantee (ARCHITECTURE step 9). Extracted from
/// the draw() ternary so the selection is unit-testable WITHOUT a GPU device.
pub fn shot_sim_dt(shot: bool, dt: f32) -> f32 {
    if shot {
        0.0
    } else {
        dt
    }
}

pub const ZOOM_MIN: f32 = 1.0;
pub const ZOOM_MAX: f32 = 4.0; // web game-studio: zoomMin 1, zoomMax 4, zoomStep 1

pub struct Viewer {
    // ---- scene + GPU backend
    pub scene: Scene,
    pub backend: Box<dyn RenderBackend>,
    // ---- resolved config + live tunables (the ESC menu writes these)
    pub cfg: Config,
    pub exposure: f32,
    pub style: StyleCfg,
    pub ao: f32,
    pub ao_r: f32,
    pub ao_n: i32,
    pub light_anim: bool,
    /// LIGHTS env: a presentation multiplier on the switchable lights (direct
    /// via the emission build, indirect via the probe-bank lerp). The on/off
    /// MASTER is sim state (Command::ToggleRoomLights) — this is just a dim.
    pub lights_dim: f32,
    pub flash_power: f32,
    pub flash_cone: f32,
    pub debug: i32,
    pub pan_speed: f32, // playerless camera pan speed (px/s; the lab's WASD)
    // ---- grouped state
    pub view: ViewState,
    pub game: GameLoop,
    /// The authored LevelSpec the sim was built from (game scenes) — a death
    /// restart rebuilds a FRESH GameLoop from it (a new run is a new sim,
    /// not a sim command; traces stay per-run).
    pub run_spec: Option<house_game::LevelSpec>,
    /// Synth-blip output (None = headless/no device/AUDIO=0 — fail-soft).
    pub audio: Option<crate::audio::AudioOut>,
    /// Blob ids whose comm pulse was lit last frame (blink edge detector
    /// for the pact tick sound; presentation-only).
    pub comm_lit: Vec<u32>,
    /// fx_frame of the last drain-gurgle retrigger (the L2 positional loop).
    pub gurgle_frame: u32,
    /// Death-reel latch: the run's death has been journaled to disk.
    pub reel_saved: Option<std::path::PathBuf>,
    pub menu: MenuState,
    pub harness: Harness,
    pub rec: Option<crate::capture::Rec>,
    pub rec_jobs: Vec<std::thread::JoinHandle<()>>,
    pub movie: Option<crate::capture::Movie>,
    /// Top-down minimap HUD (built from the spec when `cfg.game.minimap`), burned
    /// into the captured frame each draw. `None` when off or on a specless scene.
    pub minimap: Option<crate::minimap::Minimap>,
    // ---- frame clock / lifecycle
    pub frame: u32,
    pub start_time: std::time::Instant,
    pub last_frame: Option<std::time::Instant>,
    pub frame_time_sum: f32,
    pub exit_requested: bool,
}

impl Viewer {
    /// `window: None` runs fully headless (SHOT captures). Builds the scene
    /// (single source of truth: the authored spec drives collision + greybox
    /// visuals), the GPU backend, the sim adapter (joining game ids onto the
    /// backend's `SceneHandles`), then applies the seeded camera/pan/trace.
    pub unsafe fn new(window: Option<&Window>, cfg: Config) -> Result<Viewer, Box<dyn std::error::Error>> {
        // SCENE=game is built from the authored LevelSpec; the three legacy
        // scenes (grid/lab/house) stay in rt_probe::build_scene.
        // Start the wall clock BEFORE the (blocking, hundreds-of-ms) GPU build +
        // probe bake, so setup time counts toward `elapsed` — the original set
        // start_time just before recreate+bake, so harness pacing that compares
        // start_time.elapsed() to an absolute threshold (ROTATE_AT / DUMP_AT /
        // MOVIE / clip next_due) sees the same nonzero offset on the first frame.
        let start_time = std::time::Instant::now();
        // The scene's LevelSpec builder comes off its scene_registry row (one
        // row per scene: spec + wall/camera classifiers + collision inflate +
        // lighting mood). `None` = legacy textured scene → rt_probe::build_scene.
        let game_spec: Option<house_game::LevelSpec> = crate::scene_registry::entry(&cfg.scene).spec.map(|build| build(&cfg));
        let scene = match &game_spec {
            Some(spec) => crate::game_scene::build_game(spec, &cfg),
            None => build_scene(&cfg)?,
        };
        println!("scene: {} prims, {} tris, {} textures", scene.primitives.len(), scene.indices.len() / 3, scene.images.len());
        let player0 = scene.player_start;

        let backend = new_backend(window, &scene, &cfg);

        // the sim side: SCENE=game runs the AUTHORED spec; everything else runs
        // the interim mirror of the scene's collision fields + named lights.
        // GameLoop is the adapter knowing both, joining lights onto the
        // backend's handles, loudly.
        // DUMP_ROOMS=1: print the room rects + door slabs (for authoring walk
        // traces against a generated layout). Cheap, off by default.
        if std::env::var("DUMP_ROOMS").is_ok() {
            if let Some(s) = &game_spec {
                println!("START {} {}", s.player_start.x, s.player_start.z);
                for r in &s.rooms {
                    println!("ROOM {} {:?}", r.id.0, r.floor_rect);
                }
                for d in &s.doors {
                    println!("DOOR {} {:?}", d.id.0, d.closed_solid);
                }
            }
        }
        // Build the minimap schematic from the spec BEFORE it is moved into the
        // GameLoop (the layout is static, so this is a one-time bake).
        let minimap = if cfg.game.minimap { game_spec.as_ref().map(crate::minimap::Minimap::from_spec) } else { None };
        let run_spec = game_spec.clone(); // kept for death->restart (fresh sim, same level)
        let game = match game_spec {
            Some(mut spec) => {
                // AABB collision for the GENERATED thin-wall scenes: the sim collides
                // the player as a POINT (`Level::is_blocked`), so the rendered 0.375-wide
                // pillar would sink into the 0.25 wall slabs ("no colliders" + the player
                // centre reaching the wall, which made the CAVE_ROI reveal slice the wall
                // behind it). Inflate the COLLISION solids by the player half-extent so the
                // pillar stops flush against walls. The spec was already handed to
                // `build_game` (VISUALS use the un-inflated slabs); this only grows the
                // collision footprints. The authored game/house keep their own tuned
                // collision (and goldens) untouched.
                if crate::scene_registry::entry(&cfg.scene).inflate_collision {
                    let r = house_game::game::PLAYER_HALF;
                    for s in &mut spec.static_solids {
                        *s = [s[0] - r, s[1] - r, s[2] + r, s[3] + r];
                    }
                }
                GameLoop::from_spec(spec, &scene, backend.handles(), backend.light_count(), &cfg)
            }
            None => GameLoop::new(&scene, backend.handles(), backend.light_count(), &cfg),
        };
        println!("level: floor rect {:?}, {} solids, {} game lights", scene.floor_rect, scene.solids.len(), game.light_keys.len());

        // audio: windowed sessions only (SHOT/DEMO stay silent + headless);
        // AUDIO=<master> tunes volume, AUDIO=0 disables entirely
        let audio = if window.is_some() {
            let master: f32 = std::env::var("AUDIO").ok().and_then(|v| v.parse().ok()).unwrap_or(0.6);
            if master > 0.0 { crate::audio::AudioOut::new(master) } else { None }
        } else {
            None
        };
        let mut r = Viewer {
            scene,
            backend,
            run_spec,
            audio,
            comm_lit: Vec::new(),
            gurgle_frame: 0,
            reel_saved: None,
            exposure: cfg.render.exposure,
            style: cfg.render.style,
            ao: cfg.render.ao,
            ao_r: cfg.render.ao_r,
            ao_n: cfg.render.ao_n,
            light_anim: cfg.game.light_anim,
            lights_dim: cfg.game.lights,
            flash_power: cfg.game.flash_power,
            flash_cone: cfg.game.flash_cone,
            debug: cfg.render.debug,
            pan_speed: cfg.game.player_speed.unwrap_or(cfg.default_player_speed()),
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
                dragging: false,
            },
            // arena boots into the TITLE menu (a regular game start screen) —
            // but only live windowed sessions; every harness mode (SHOT /
            // DEMO / DUMP / MOVIE) must render the game, not a menu.
            menu: MenuState {
                mode: if game.lmb_shoots && cfg.harness.shot.is_none() && cfg.harness.demo.is_none() && cfg.harness.dump.is_none() && cfg.harness.movie.is_none() {
                    crate::menu::MenuMode::Title
                } else {
                    crate::menu::MenuMode::Closed
                },
                back: crate::menu::MenuMode::Closed,
                sel: 0,
                drag: false,
            },
            game,
            harness: Harness::from_cfg(&cfg),
            rec: None,
            rec_jobs: Vec::new(),
            movie: cfg.harness.movie.clone().map(|dir| {
                std::fs::create_dir_all(&dir).ok();
                crate::capture::Movie::new(dir, &cfg)
            }),
            minimap,
            frame: 0,
            start_time,
            last_frame: None,
            frame_time_sum: 0.0,
            exit_requested: false,
            cfg,
        };
        // backend.new already built the swapchain (and baked probes); centre the
        // visible crop now that the view exists (the old recreate did this).
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
            r.view.target = snap_ground_to_lattice(t, r.yaw_deg());
        }
        // optional player world offset (camera NOT moved) — proves the dynamic
        // TLAS rebuild displaces the marker in headless capture tests.
        if r.cfg.game.player_off != (0.0, 0.0) {
            r.game.offset_player(r.cfg.game.player_off.0, r.cfg.game.player_off.1);
        }
        // CMDS replay prefix (deterministic) — runs LAST so the trace acts on
        // the fully seeded state.
        r.game.run_cmds(&r.cfg);
        // DEMO=trace.txt: arm the headless per-tick gameplay dump.
        if r.cfg.harness.demo.is_some() {
            let dir = r.cfg.harness.demo_dir.clone().unwrap_or_else(|| "demo".into());
            std::fs::create_dir_all(&dir).unwrap_or_else(|e| panic!("DEMO_DIR {dir}: {e}"));
            let ticks = r.game.demo_load(&r.cfg);
            r.harness.demo = Some(crate::capture::Demo { dir, ticks, done: 0 });
        }
        if r.game.snap.yaw_q != r.view.yaw_q {
            r.view.yaw_q = r.game.snap.yaw_q;
            r.snap_target_to_lattice();
        }
        Ok(r)
    }

    /// V after a death: render the saved reel to clips/last_run.mp4 in a
    /// detached child (record.sh builds + replays + encodes; the game keeps
    /// running). Fire-and-forget by design — the print is the receipt.
    pub fn render_reel(&self) {
        let Some(trace) = &self.reel_saved else {
            println!("death reel: nothing saved yet (die first)");
            return;
        };
        let scene = self.cfg.scene.clone();
        let seed = self.game.sim.res.seed;
        let trace = trace.display().to_string();
        match std::process::Command::new(".claude/skills/record-gameplay/scripts/record.sh")
            .args([scene.as_str(), trace.as_str(), "clips/last_run.mp4"])
            .env("SEED", seed.to_string())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
        {
            Ok(_) => println!("death reel: rendering clips/last_run.mp4 in the background..."),
            Err(e) => println!("death reel: could not spawn record.sh: {e}"),
        }
    }

    /// Death -> new run: rebuild a FRESH GameLoop from the stored spec (same
    /// level, zeroed sim). View state (camera/zoom) survives; the follow-cam
    /// recentres on the respawned player's first step. No-op when the scene
    /// has no stored spec or the run isn't over.
    /// Rebuild a fresh run from the stored spec. `force` (the pause menu's
    /// RESTART) skips the run-over guard; the bare Space restart keeps it so
    /// a stray Space mid-fight can't wipe the run.
    pub fn restart_run(&mut self, force: bool) {
        let over = self.game.snap.run.is_some_and(|r| r.dead || r.won);
        let Some(spec) = self.run_spec.clone() else { return };
        if !over && !force {
            return;
        }
        self.game = crate::sim::GameLoop::from_spec(spec, &self.scene, self.backend.handles(), self.backend.light_count(), &self.cfg);
        // a restart is a fresh SIM, not a fresh viewpoint: seed the new sim's
        // yaw with the CURRENT camera quarter, or WASD (interpreted at the
        // sim's boot yaw) comes out turned relative to the rotated screen
        self.game.seed_yaw(self.view.yaw_q);
    }

    /// Fire-and-forget UI sound (menu nav/pick) — presentation only.
    pub fn ui_blip(&self, id: &str) {
        if let Some(a) = &self.audio {
            a.play(id, 1.0);
        }
    }

    /// LEVELS pick: relaunch this binary with `SCENE=<scene>` (everything
    /// else — WINDOW, SEED, tune env — inherits). A scene is baked at
    /// startup (geometry, BLAS/TLAS, probe cache), so a fresh process IS
    /// the clean level switch; `exec` keeps the pid, so a Dock-launched
    /// session keeps its bundle identity. Returns only on failure.
    pub fn switch_scene(&mut self, scene: &str) {
        use std::os::unix::process::CommandExt;
        let exe = match std::env::current_exe() {
            Ok(e) => e,
            Err(e) => {
                eprintln!("levels: current_exe failed: {e}");
                return;
            }
        };
        println!("levels: relaunching with SCENE={scene}");
        unsafe { self.backend.wait_idle() };
        let err = std::process::Command::new(exe).env("SCENE", scene).exec();
        eprintln!("levels: relaunch failed: {err}");
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

    /// Rebuild the GPU target on resize/out-of-date, then re-centre the crop
    /// (the old monolithic recreate_swapchain recentered at its tail).
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
        self.advance_sim(dt); // DEMO tick / pause / hitstop / live fixed-tick
        self.drain_audio(); // sim cues + comm-blink edges + servo steps
        self.save_death_reel(); // journal → clips/last_run.txt on the end tick
        // playerless scenes (lab): WASD pans the camera — presentation only
        if !self.game.has_player && self.game.held != [false; 4] {
            self.pan_camera_held(dt);
        }
        self.follow_camera(); // retarget at the player when the sim moved it
        // smooth quarter-turn in flight: ease the yaw, swap masks at crossings
        self.advance_rotation(dt);
        // clip recording: collect last frame's capture + decide if this frame
        // captures (returns the down-blit target size when it should)
        let capture_req = self.prepare_capture();

        // camera: ISO_VIEW_CONTRACT at the movable look-at target
        let (low_w, low_h) = self.backend.low_dims();
        let cam = iso_camera_at(self.scene.min, self.scene.max, low_w, low_h, self.yaw_deg(), self.view.target);

        // This frame's scene state, typed — built from the game SNAPSHOT (the
        // step-9 adapter): nothing below reads sim internals, only what the
        // snapshot publishes (flashlight/muzzle ride the reserved spot slots;
        // the player + door leaves render at their lattice-snapped transforms;
        // record_frame patches + rebuilds only on an actual change).
        let mut spot = self.frame_spotlights();
        // append one real RT light per goo blob (reserved NEE slots) → the goo
        // lights the scene and casts shadows. Capped to the reserved headroom.
        append_goo_lights(&mut spot, self.game.goo_lights());
        let mut instances: Vec<(InstanceKey, Mat4)> = Vec::new();
        self.player_rig_instances(&mut instances); // droid + gun ring + flare
        instances.extend(self.game.door_instances());
        instances.extend(self.game.goo_instances());
        instances.extend(self.game.projectile_instances());
        instances.extend(self.game.chunk_instances());
        instances.extend(self.game.droplet_instances());
        instances.extend(self.game.spark_instances());
        instances.extend(self.game.rail_instances());
        instances.extend(self.game.puff_instances());
        instances.extend(self.game.flow_instances());
        let goo = self.game.goo_balls();
        let emission = self.game.light_emission(self.light_anim, self.lights_dim);
        let room_lights = if self.game.light_keys.is_empty() { self.lights_dim } else { self.game.snap.room_lights * self.lights_dim };
        let fs = FrameState {
            cam,
            room_lights,
            time: self.game.time(), // SIM time — the light-anim clock is replayable now
            light_emission: &emission,
            spotlights: spot.as_slice(),
            instances: &instances,
            goo: goo.frame(),
        };

        // ESC tune-menu overlay (panel/hamburger), copied onto the PRESENTED
        // image only — never `out`, so SHOT/MOVIE/DUMP/DEMO captures stay
        // UI-free (those modes pass no overlay). Game HUD (score, weapon bar)
        // is burned in via stamps instead.
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

        // minimap HUD: stamp the player onto the prebaked schematic this frame.
        // Held in a local so the &[u32] slice in `fp` stays alive through present.
        let mini_hold = self.minimap_frame();
        let minimap = mini_hold.as_ref().map(|(buf, w, h)| (buf.as_slice(), *w, *h));

        // burned-in HUD stamps: tactic bubbles over thinking blobs + the
        // bottom weapon bar. Game picture, not shell UI — they ride into
        // SHOT/DEMO captures. Skipped on playerless film stages.
        let stamps = self.hud_stamps();
        // arena blackout: on open-studio stages the sky fill follows the sim's
        // room-lights master (floored so the goo glow still silhouettes the
        // walls); every other scene keeps its authored env verbatim.
        let sky_dim = if crate::scene_registry::is_open_studio_stage(&self.cfg.scene) { 0.06 + 0.94 * fs.room_lights } else { 1.0 };
        let fp = FramePresent {
            fs: &fs,
            // screenshake rides the PRESENTED pan only (never view.pan), so
            // picks/aim stay true and the offset dies with the trauma decay
            pan: self.view.pan + self.game.shake_px(),
            target: self.view.target,
            yaw_deg: self.yaw_deg(),
            zoom: self.view.zoom,
            ao: self.ao,
            ao_r: self.ao_r,
            ao_n: self.ao_n,
            spec: self.cfg.render.spec,
            gloss: self.cfg.render.gloss,
            bump: self.cfg.render.bump,
            bump_scale: self.cfg.render.bump_scale,
            gi: self.cfg.render.gi,
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
            sky_dim,
            minimap,
            roi: self.roi_info(),
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

    /// Sim-advance phase of `draw()`: DEMO drives ONE tick per rendered frame
    /// (deterministic capture); live play routes through pause (menu open) →
    /// hitstop (freeze frames) → the fixed-tick accumulator. SHOT feeds dt=0
    /// so the wall clock never reaches the sim.
    fn advance_sim(&mut self, dt: f32) {
        // DEMO mode: the sim is driven ONE tick per rendered frame (the trace's
        // commands drain per tick), NOT by the wall clock — a deterministic,
        // fixed-tick gameplay capture. Live `run_due` is bypassed entirely.
        if self.harness.demo.is_some() {
            self.game.demo_advance_tick();
            // a DEMO trace may `rotate` the camera (yaw_q is sim state): catch
            // the viewer up to the sim's settled quarter WITHOUT re-queuing the
            // command. Hard snap per quarter (no eased tween).
            self.sync_view_yaw(self.game.snap.yaw_q);
            self.game.tick_fx(1); // bleed/recoil/shake FX ride the tick clock
        } else {
            // game-menu pause (arena, live): the sim clock stops dead while
            // the TITLE / PAUSE / SETTINGS menu is up — the accumulator isn't
            // fed, so RESUME continues exactly where it stopped.
            if self.game.lmb_shoots && self.menu_open() && self.harness.shot.is_none() {
                // paused — nothing ticks
            }
            // hitstop: a terminal kill / detonation freezes the LIVE sim a
            // few frames for punch — the accumulator isn't fed, so there is
            // no tick burst afterward. SHOT stays wall-clock-free (its dt is
            // synthetic and must map 1:1 to ticks).
            else if self.game.fx.freeze > 0 && self.harness.shot.is_none() {
                self.game.fx.freeze -= 1;
            } else {
                // arena turret: keep the gun trained on the cursor (pushes
                // Command::Aim only when the direction actually moved)
                let c = self.view.cursor;
                self.aim_command(c);
                // arena autofire: while LMB is held, re-push Shoot at the live
                // cursor each frame BEFORE the due ticks run — the sim's cooldown
                // gates the real fire rate (same-tick spam is swallowed), and the
                // pushes land in the journal so the reel replays the burst.
                if self.game.lmb_shoots && self.game.lmb_held {
                    self.shoot_command(c);
                }
                // fixed-tick sim: run the due ticks, per-tick command drain. SHOT mode
                // keeps the wall clock OUT of the sim entirely.
                let sim_dt = shot_sim_dt(self.harness.shot.is_some(), dt);
                let n = self.game.run_due(sim_dt);
                self.game.tick_fx(n); // bleed/recoil/shake FX ride the tick clock
            }
        }
    }

    /// Audio phase of `draw()`: drain this frame's sim cues into the synth
    /// (fail-soft None just clears the queue), and tick the comm-pact blink
    /// sound on each blob whose pulse LIT this frame (rising edge; both pact
    /// members share a phase, so the double-tick reads as one synced beep).
    fn drain_audio(&mut self) {
        let cues: Vec<sim_core::AudioCue> = self.game.sim.sink.0.drain(..).collect();
        if let Some(a) = &self.audio {
            for c in &cues {
                a.play(c.id.0, c.gain);
            }
            let lit: Vec<u32> = self.game.snap.mobs.iter().filter(|m| m.comm > 0.0).map(|m| m.id.0).collect();
            for id in &lit {
                if !self.comm_lit.contains(id) {
                    a.play("comm_blink", 1.0);
                }
            }
            self.comm_lit = lit;
            // hover-servo steps: the walk cadence accumulated by tick_fx
            for _ in 0..self.game.take_steps() {
                a.play("step", 1.0);
            }
            // L2: the drain gurgle — a soft wet loop re-triggered on the
            // tick clock from the mouth, louder standing near it and as
            // LEAK climbs (containment scenes only)
            if let Some(z) = self.game.sim.res.arena.drain {
                let f = self.game.fx_frame();
                if f.wrapping_sub(self.gurgle_frame) >= 52 {
                    self.gurgle_frame = f;
                    let c = glam::Vec2::new((z[0] + z[2]) * 0.5, (z[1] + z[3]) * 0.5);
                    let p = self.game.snap.player_pos;
                    let d = (glam::Vec2::new(p.x, p.z) - c).length();
                    let leak = self.game.snap.breach.map(|(l, cap)| l as f32 / cap as f32).unwrap_or(0.0);
                    let gain = ((1.1 - d * 0.07) * (0.55 + 0.45 * leak)).clamp(0.12, 0.9);
                    a.play("drain_gurgle", gain);
                }
            }
        }
    }

    /// Death-reel phase of `draw()`: the tick the run dies, write the journal
    /// as a replayable trace (live windowed play only — DEMO/SHOT replays ARE
    /// traces already). V then renders it to MP4 via record.sh.
    fn save_death_reel(&mut self) {
        if self.harness.demo.is_none() && self.harness.shot.is_none() {
            let dead = self.game.snap.run.is_some_and(|r| r.dead || r.won);
            if dead && self.reel_saved.is_none() {
                let ticks = self.game.sim.res.cur_tick + 90; // a beat of aftermath
                let trace = self.game.journal_trace(&self.cfg.scene, self.game.sim.res.seed, ticks);
                let dir = std::path::Path::new("clips");
                let _ = std::fs::create_dir_all(dir);
                let path = dir.join("last_run.txt");
                if std::fs::write(&path, trace).is_ok() {
                    println!("death reel: journal saved to {} — press V to render the MP4", path.display());
                    self.reel_saved = Some(path);
                }
            } else if !dead && self.reel_saved.is_some() {
                self.reel_saved = None; // fresh run, fresh reel
            }
        }
    }

    /// Player-rig phase of `draw()`: the droid body (with the arena lean +
    /// hover bob), the selected gun with its recoil kick, and the muzzle
    /// flare — pushed into `instances`.
    /// SCENE=goofloor hides the player marker: the sim still has a player (so
    /// it can lure the goo via seek + drive the directed walk) but the marker
    /// renders invisible — collapsed to a zero-scale point — for a clean bare
    /// floor with no pillar. (Skipping the push entirely would leave the
    /// dynamic prim at its identity transform = a box at the origin.)
    fn player_rig_instances(&self, instances: &mut Vec<(InstanceKey, Mat4)>) {
        if !self.game.has_player {
            return;
        }
        let hidden = crate::scene_registry::is_goo_film_stage(&self.cfg.scene);
        if let Some(&k) = self.backend.handles().instances.get("player") {
            let m = if hidden {
                Mat4::from_scale(glam::Vec3::ZERO)
            } else if self.game.lmb_shoots {
                // arena walk feel: the droid leans INTO its motion (tilt
                // about the ground-level axis perpendicular to the smoothed
                // velocity) and hovers on a soft bob — faster and shallower
                // while moving. Presentation-only, tick-clocked (lean_vel +
                // fx frames advance with sim ticks), arena-gated so the
                // cave goldens/replays keep the still, axis-aligned body.
                let v = self.game.fx.lean_vel;
                let speed = v.length();
                let f = self.game.fx_frame() as f32;
                let sf = (speed / 2.0).min(1.0);
                let bob = 0.010 * (f * 0.11).sin() + 0.008 * sf * (f * 0.42).sin();
                let base = Mat4::from_translation(self.game.snap.player_pos + glam::Vec3::new(0.0, bob, 0.0));
                if speed > 0.15 {
                    let d = v / speed;
                    let angle = (speed * 0.055).min(0.10);
                    base * Mat4::from_axis_angle(glam::Vec3::new(d.y, 0.0, -d.x), angle)
                } else {
                    base
                }
            } else {
                Mat4::from_translation(self.game.snap.player_pos)
            };
            instances.push((k, m));
        }
        // weapon ring: the SELECTED arsenal gun renders at the player,
        // rotated to the facing (guns are authored aiming +Z) — the aim
        // tell the axis-aligned body deliberately doesn't give. Unequipped
        // slots stay collapsed. `snap.weapon` is None off arena levels, so
        // non-arena scenes never show a gun (their handles don't exist).
        let sel = self.game.snap.weapon.map(|(k, _, _)| k.slot());
        for slot in 1..=5u8 {
            if let Some(&k) = self.backend.handles().instances.get(format!("gun_{slot}").as_str()) {
                let m = if Some(slot) == sel && !hidden {
                    // recoil: the kick is the weapon's BODY (W1) — each class
                    // applies the decaying `recoil` transient its own way
                    // (deep kick+pitch / lateral jitter / ring shove / toss
                    // bob / rail slide). Presentation-only, tick-clocked.
                    use house_game::WeaponClass as W;
                    let f = self.game.snap.facing;
                    let kick = self.game.fx.recoil;
                    let mut base = Mat4::from_translation(self.game.snap.player_pos) * Mat4::from_rotation_y(f.x.atan2(f.y));
                    // W3 raise: a fresh swap lerps the NEW gun up from the
                    // holster (dropped + pitched down) over the same window
                    // the sim's raise cooldown blocks the trigger for
                    let raise = self.game.fx.raise;
                    if raise > 0.0 {
                        base = base * Mat4::from_translation(glam::Vec3::new(0.0, -0.16 * raise, -0.04 * raise)) * Mat4::from_rotation_x(0.55 * raise);
                    }
                    match self.game.fx.recoil_class {
                        // deep kick, slow recover — the gun REMEMBERS the shot
                        W::Slug => base * Mat4::from_translation(glam::Vec3::new(0.0, 0.0, -0.13 * kick)) * Mat4::from_rotation_x(-0.30 * kick),
                        // ~2px tremble, instant recover — chatter, not mass
                        W::Uzi => {
                            let h = self.game.fx_frame().wrapping_mul(2654435761);
                            let jx = (((h >> 8) & 0xff) as f32 / 127.5 - 1.0) * 0.020 * kick;
                            let jy = (((h >> 16) & 0xff) as f32 / 127.5 - 1.0) * 0.012 * kick;
                            base * Mat4::from_translation(glam::Vec3::new(jx, jy, -0.03 * kick))
                        }
                        // biggest kick + a 1-tick whole-gun shove on the shot tick
                        W::Shotgun => {
                            let shove = if self.game.fx.recoil_age == 0 { 0.05 } else { 0.0 };
                            base * Mat4::from_translation(glam::Vec3::new(0.0, 0.0, -(0.10 * kick + shove))) * Mat4::from_rotation_x(-0.22 * kick)
                        }
                        // vertical toss bob, no back-kick: the tube tips up
                        W::Grenade => base * Mat4::from_translation(glam::Vec3::new(0.0, 0.06 * kick, 0.0)) * Mat4::from_rotation_x(0.14 * kick),
                        // sharp slide straight back on the rail, zero pitch
                        W::Harpoon => base * Mat4::from_translation(glam::Vec3::new(0.0, 0.0, -0.12 * kick)),
                        W::Standard => base * Mat4::from_translation(glam::Vec3::new(0.0, 0.0, -0.085 * kick)) * Mat4::from_rotation_x(-0.22 * kick),
                    }
                } else {
                    Mat4::from_scale(glam::Vec3::ZERO)
                };
                instances.push((k, m));
            }
        }
        // muzzle flare: the VISIBLE flash at the barrel tip — per-class
        // shape (W4): slug big pop + a barrel glow that decays with its
        // slow recoil recover, uzi small strobing pop, shotgun a wide
        // short fan, harpoon/grenade NO amber flare (the cyan rail streak
        // / smoke mote are their signatures). Zero-scale between shots.
        if let Some(&k) = self.backend.handles().instances.get("flare_slot_0") {
            use house_game::WeaponClass as W;
            let flash = self.game.snap.muzzle_flash && !hidden;
            let kick = self.game.fx.recoil;
            let class = self.game.fx.recoil_class;
            // the slug's barrel keeps GLOWING after the pop, riding the
            // long recoil tail down
            let barrel_glow = class == W::Slug && kick > 0.22 && !hidden;
            let m = if flash || barrel_glow {
                let f = self.game.snap.facing;
                let fd = glam::Vec3::new(f.x, 0.0, f.y);
                let (mp, _) = house_game::flashlight_pose(self.game.snap.player_pos, f);
                let place = |scale: glam::Vec3| Mat4::from_translation(mp + fd * 0.55) * Mat4::from_quat(glam::Quat::from_rotation_arc(glam::Vec3::Z, fd)) * Mat4::from_scale(scale);
                match class {
                    W::Harpoon | W::Grenade => Mat4::from_scale(glam::Vec3::ZERO),
                    W::Slug => {
                        let s = if flash { 0.15 + 0.20 * kick } else { 0.055 + 0.09 * kick };
                        place(glam::Vec3::new(s, s, s * 1.6))
                    }
                    W::Uzi => {
                        let s = 0.075;
                        place(glam::Vec3::new(s, s, s * 1.5))
                    }
                    W::Shotgun => {
                        let s = 0.13 + 0.16 * kick;
                        place(glam::Vec3::new(s * 2.2, s * 0.7, s * 0.8))
                    }
                    W::Standard => {
                        let s = 0.12 + 0.16 * kick;
                        place(glam::Vec3::new(s, s, s * 1.7))
                    }
                }
            } else {
                Mat4::from_scale(glam::Vec3::ZERO)
            };
            instances.push((k, m));
        }
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

    /// Minimap phase of `draw()`: stamp the player onto the prebaked schematic.
    fn minimap_frame(&self) -> Option<(Vec<u32>, i32, i32)> {
        self.minimap.as_ref().map(|mm| mm.frame(self.game.snap.player_pos, self.game.snap.facing))
    }

    /// HUD-stamp phase of `draw()`: tactic bubbles over thinking blobs + the
    /// bottom weapon bar. Game picture, not shell UI — they ride into
    /// SHOT/DEMO captures. Skipped on playerless film stages.
    fn hud_stamps(&self) -> Vec<crate::backend::Stamp> {
        if self.game.has_player && !crate::scene_registry::is_goo_film_stage(&self.cfg.scene) {
            let xf = self.pick_xform();
            let ext = self.backend.extent();
            crate::hud::build_stamps(&self.game.snap, &xf, ext, self.rs() as u32)
        } else {
            Vec::new()
        }
    }

    /// ROI phase of `draw()`: the reveal-disc parameters when ROI mode is on.
    fn roi_info(&self) -> Option<crate::backend::RoiInfo> {
        if !self.cfg.game.roi {
            return None;
        }
        // Anchor the reveal disc on the player's MID-HEIGHT, not its feet:
        // the marker pillar is 1.3 wu tall, so projecting the feet (y≈0)
        // puts the disc centre low on screen. +0.65 wu = the pillar's
        // visual centre, so the cutout sits over the player, not under it.
        let center = self.game.snap.player_pos + glam::Vec3::new(0.0, 0.65, 0.0);
        // ROI_XRAY=contour adds faint wall-silhouette lines ON TOP of the ghost
        // stipple. Encoded by NEGATING the ghost cap: the shader reads roi2.w<0
        // as hybrid mode and |roi2.w| as the coverage cap, so the stipple stays.
        let ghost = if self.cfg.game.roi_contour { -self.cfg.game.roi_ghost } else { self.cfg.game.roi_ghost };
        Some(crate::backend::RoiInfo { player: center, radius_px: self.cfg.game.roi_radius, falloff_px: self.cfg.game.roi_falloff, ghost })
    }
}

/// Append goo lights into the reserved spotlight region, after the scene
/// spotlights and truncated to the remaining headroom (`N_RESERVED` slots
/// total). Order is load-bearing: the existing spotlights keep their slots and
/// the goo lights fill whatever is left, so the packed reserved region is
/// deterministic regardless of how many blobs are alive.
fn append_goo_lights(spot: &mut Vec<rt_probe::Spotlight>, goo_lights: Vec<rt_probe::Spotlight>) {
    let room = rt_probe::N_RESERVED.saturating_sub(spot.len());
    spot.extend(goo_lights.into_iter().take(room));
}
