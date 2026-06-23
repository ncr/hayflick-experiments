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

/// Wall-synthesis options for floor-plan scenes: `DOORS=1` keeps swinging door
/// leaves; otherwise openings are plain arches (the walkable default).
fn wall_opts() -> house_game::WallOpts {
    house_game::WallOpts { keep_door_leaves: std::env::var("DOORS").is_ok(), ..house_game::WallOpts::default() }
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
        // SCENE=game → the authored five-room house; SCENE=cave → a procedural
        // dungeon (seeded by CAVE_SEED). Both build the graybox Scene from a
        // LevelSpec; the three legacy scenes (grid/lab/house) stay in build_scene.
        let game_spec: Option<house_game::LevelSpec> = match cfg.scene.as_str() {
            "game" => Some(house_game::game_level()),
            // the goo-mob demo: the five-room house populated with crawling,
            // splittable fluorescent blobs (same geometry as `game`).
            "goo" => Some(house_game::goo_level()),
            // a clean open stage for goo authoring (far walls only).
            "playground" => Some(house_game::playground_level()),
            // a bare playerless floor — the simplest goo filming stage (no
            // pillar, no walls, fixed camera).
            "goofloor" => Some(house_game::goofloor_level()),
            "goonursery" => Some(house_game::goonursery_level()),
            // the physical-projectile shooting range (lane + discs + goo targets).
            "range" => Some(house_game::shooting_range_level()),
            "village" => Some(house_game::village_level(cfg.game.cave_seed)),
            // Floor-plan-derived levels: a believable PLAN (rooms + doors) run
            // through `floorplan::enclose` to synthesize walls + collision. Each
            // is fully playable; future plan generators slot in the same way.
            // DOORS=1 keeps swinging leaves (closed, interactive); default is
            // open arches (walkable end-to-end, what the headless capture wants).
            "home" => Some(house_game::enclose(house_game::house_floor(cfg.game.cave_seed), wall_opts())),
            "hospital" => Some(house_game::enclose(house_game::building_floor(cfg.game.cave_seed, house_game::BuildingParams::hospital()), wall_opts())),
            "office" => Some(house_game::enclose(house_game::building_floor(cfg.game.cave_seed, house_game::BuildingParams::office()), wall_opts())),
            "factory" => Some(house_game::enclose(house_game::factory_floor(cfg.game.cave_seed), wall_opts())),
            "cave" => Some(house_game::cave_level_with(
                cfg.game.cave_seed,
                house_game::CaveParams { thick_walls: cfg.game.cave_thick, ..house_game::CaveParams::for_rooms(cfg.game.cave_rooms, cfg.game.cave_loops) },
            )),
            _ => None,
        };
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
                if matches!(cfg.scene.as_str(), "cave" | "village" | "home" | "hospital" | "office" | "factory") {
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

        let mut r = Viewer {
            scene,
            backend,
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
            game,
            menu: MenuState { open: false, sel: 0, drag: false },
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
        // DEMO mode: the sim is driven ONE tick per rendered frame (the trace's
        // commands drain per tick), NOT by the wall clock — a deterministic,
        // fixed-tick gameplay capture. Live `run_due` is bypassed entirely.
        if self.harness.demo.is_some() {
            self.game.demo_advance_tick();
            // a DEMO trace may `rotate` the camera (yaw_q is sim state): catch
            // the viewer up to the sim's settled quarter WITHOUT re-queuing the
            // command. Hard snap per quarter (no eased tween).
            self.sync_view_yaw(self.game.snap.yaw_q);
        } else {
            // fixed-tick sim: run the due ticks, per-tick command drain. SHOT mode
            // keeps the wall clock OUT of the sim entirely.
            let sim_dt = shot_sim_dt(self.harness.shot.is_some(), dt);
            self.game.run_due(sim_dt);
        }
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
        // SCENE=goofloor hides the player marker: the sim still has a player (so
        // it can lure the goo via seek + drive the directed walk) but the marker
        // renders invisible — collapsed to a zero-scale point — for a clean bare
        // floor with no pillar. (Skipping the push entirely would leave the
        // dynamic prim at its identity transform = a box at the origin.)
        if self.game.has_player {
            if let Some(&k) = self.backend.handles().instances.get("player") {
                let m = if self.cfg.scene == "goofloor" || self.cfg.scene == "goonursery" {
                    Mat4::from_scale(glam::Vec3::ZERO)
                } else {
                    Mat4::from_translation(self.game.snap.player_pos)
                };
                instances.push((k, m));
            }
        }
        instances.extend(self.game.door_instances());
        instances.extend(self.game.goo_instances());
        instances.extend(self.game.projectile_instances());
        let (goo, goo_glow) = self.game.goo_balls();
        let emission = self.game.light_emission(self.light_anim, self.lights_dim);
        let room_lights = if self.game.light_keys.is_empty() { self.lights_dim } else { self.game.snap.room_lights * self.lights_dim };
        let fs = FrameState {
            cam,
            room_lights,
            time: self.game.time(), // SIM time — the light-anim clock is replayable now
            light_emission: &emission,
            spotlights: spot.as_slice(),
            instances: &instances,
            goo: &goo,
            goo_glow: &goo_glow,
        };

        // ESC tune-menu + score HUD overlay (panel/hamburger), copied onto the
        // PRESENTED image only — never `out`, so SHOT/MOVIE/DUMP/DEMO captures
        // stay UI-free (those modes pass no overlay).
        let menu_canvas;
        let score_canvas;
        let overlay = if self.harness.shot.is_none() && self.movie.is_none() && self.harness.dump_dir.is_none() && self.harness.demo.is_none() {
            menu_canvas = self.menu_canvas();
            score_canvas = if self.game.has_player { Some(self.score_canvas()) } else { None };
            Some(Overlay {
                menu: (&menu_canvas.0, menu_canvas.1, menu_canvas.2),
                score: score_canvas.as_ref().map(|(c, w, h)| (&c[..], *w, *h)),
            })
        } else {
            None
        };

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
        let mini_hold;
        let minimap = match &self.minimap {
            Some(mm) => {
                mini_hold = mm.frame(self.game.snap.player_pos, self.game.snap.facing);
                Some((mini_hold.0.as_slice(), mini_hold.1, mini_hold.2))
            }
            None => None,
        };

        let fp = FramePresent {
            fs: &fs,
            pan: self.view.pan,
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
            debug: self.debug,
            exposure: self.exposure,
            style: self.style,
            frame: self.frame,
            overlay,
            minimap,
            roi: if self.cfg.game.roi {
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
            } else {
                None
            },
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
