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

use crate::backend::{new_backend, FramePresent, Overlay, ProbeRefresh, RenderBackend};
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
    /// CONTOUR COVERAGE AA weight (look-authored, `AA` env overrides, live from
    /// the ESC settings row — a push-constant change, no rebuild, no rebake).
    pub aa: f32,
    /// AA SCOPE: 0 = every surface, 1 = generator detail, 2 = the picked pier
    /// only (owner 2026-07-25 — the per-wall A/B). Drives
    /// [`crate::crack::AA_BIT`] via `aa_stamp`; the shader ignores the bit at
    /// scope 0.
    pub aa_scope: f32,
    /// Does CHUNKY generator detail (whole blocks — the wall-smash rubble) take
    /// the contour AA too? Off by default: a brick is 10-30 px across, so there
    /// is no sampling gap to fix and the AA only softens the block read, plus
    /// tumbling silhouettes pick up a per-frame shimmer (owner call after the
    /// A/B clips, 2026-07-25 — "leave it configurable, it IS a visual
    /// decision"). Thin detail (crack grooves, plates) is unaffected.
    pub aa_chunky: f32,
    /// Materials of the CHUNKY detail in the current build (rubble), refreshed
    /// with the scene — `aa_stamp` scopes them by [`Self::aa_chunky`].
    pub aa_chunky_mats: Vec<i32>,
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
    /// Every wall segment of the current build (GymMeta.piers) — the crack
    /// lab's pick targets; refreshed on every scene rebuild.
    pub piers: Vec<crate::gym_scene::Pier>,
    /// Crack-lab state (per-pier aging knobs + selection) — see crack.rs.
    pub crack: crate::crack::CrackLab,
    /// Lamp NEE slots in slot order, with their authored base rgb — the
    /// scene's named point lights joined onto the backend's handles.
    pub light_keys: Vec<(LightKey, [f32; 3])>,
    /// Synth-blip output (None = headless/no device/AUDIO=0 — fail-soft).
    pub audio: Option<crate::audio::AudioOut>,
    pub menu: MenuState,
    /// The personal IDE (Tab; `IDE=1` boots it open) — see ide_host.rs.
    pub ide: crate::ide_host::IdeState,
    pub harness: Harness,
    pub rec: Option<crate::capture::Rec>,
    pub rec_jobs: Vec<std::thread::JoinHandle<()>>,
    pub movie: Option<crate::capture::Movie>,
    // ---- roof tear-off (the DDGI flood): the "dusk flood" demo's beat and the
    // `x` key hide these prims and refresh the room's probes. One-shot per
    // build — `torn` re-arms on a scene rebuild.
    roof_prims: std::ops::Range<usize>,
    room_min: Vec3,
    room_max: Vec3,
    torn: bool,
    // ---- wall-smash rig (phase 3, physics × dynamic GI): armed at boot when
    // the active demo's script smashes a wall — the target pier resolved from
    // GymMeta, the brick layout the render runs were authored from. The beat
    // fires `smash_wall`. `None` when no demo smashes.
    smash: Option<SmashRig>,
    // ---- named-demo timeline (owner directive 2026-07-16). ALL demo logic
    // (tick-scheduled beats, the look cross-fade) is encapsulated in the
    // runner; the loop just applies its per-frame effects to generic knobs.
    demo: crate::demos::DemoRunner,
    /// The demo the runner is playing (LEVEL env or the LEVELS menu) — kept so
    /// `apply_look`'s scene rebuild can re-arm the smash rig + brick runs, and
    /// so a wear save (`wear_file`) knows which file the authoring came from.
    pub(crate) cur_demo: Option<&'static crate::demos::Demo>,
    // per-frame sun/sky override (generic — a demo morph or a future day cycle
    // drives it). `None` = the scene's baked env (bit-identical to before).
    env_override: Option<rt_probe::EnvBlock>,
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

/// The armed wall smash (phase 3): the target pier (prim to mask + AABBs)
/// and the brick layout shared by the render runs and the physics world.
struct SmashRig {
    prim: usize,
    lo: Vec3,
    hi: Vec3,
    run_lo: Vec3,
    run_hi: Vec3,
    bricks: Vec<phys_spike::BrickSpec>,
    fired: bool,
}

/// Resolve a demo's breach point against the freshly built gym meta. `None`
/// when the demo doesn't smash (or the point misses every pier — warned, so
/// a level edit that moves the wall shows up in the log, not as a dud beat).
fn arm_smash(demo: Option<&'static crate::demos::Demo>, meta: &crate::gym_scene::GymMeta) -> Option<SmashRig> {
    let (x, z) = demo?.smash_point()?;
    let Some(pier) = meta.pier_at(Vec3::new(x, 1.0, z)) else {
        println!("smash: breach point ({x}, {z}) misses every wall pier — beat disarmed");
        return None;
    };
    let bricks = phys_spike::wall_bricks(pier.lo, pier.hi);
    Some(SmashRig { prim: pier.prim, lo: pier.lo, hi: pier.hi, run_lo: pier.run_lo, run_hi: pier.run_hi, bricks, fired: false })
}

/// The wall run's surviving segment flanking the torn pier along the course
/// axis (`hi_side` picks the end), as a world AABB physics collider. A pier
/// at a run end yields a degenerate box `wall_break` skips.
fn rig_flank(rig: &SmashRig, normal_x: bool, hi_side: bool) -> (Vec3, Vec3) {
    match (normal_x, hi_side) {
        // wall normal on x → the run spans z, flanks split on z
        (true, false) => (rig.run_lo, Vec3::new(rig.run_hi.x, rig.run_hi.y, rig.lo.z)),
        (true, true) => (Vec3::new(rig.run_lo.x, rig.run_lo.y, rig.hi.z), rig.run_hi),
        (false, false) => (rig.run_lo, Vec3::new(rig.lo.x, rig.run_hi.y, rig.run_hi.z)),
        (false, true) => (Vec3::new(rig.hi.x, rig.run_lo.y, rig.run_lo.z), rig.run_hi),
    }
}

impl Viewer {
    /// `window: None` runs fully headless (SHOT/DEMO captures). Builds the
    /// gym scene (single source of truth: the hand-authored level drives sim
    /// collision + greybox visuals), the GPU backend, the light join, then
    /// applies the seeded camera/pan/trace.
    pub unsafe fn new(window: Option<&Window>, cfg: Config) -> Result<Viewer, Box<dyn std::error::Error>> {
        let start_time = std::time::Instant::now();
        // LEVEL=<name|index> boots a named demo headlessly (its tick-driven
        // script runs during DEMO playback — how the agent renders the exact
        // thing the owner picks from the menu). It sets the boot LAYOUT, look
        // and spawn; its script is stored below and fired per tick.
        let demo = crate::demos::from_env();
        let mut spec = demo.map_or(crate::demos::Level::Gym, |d| d.level).spec();
        if let Some(d) = demo {
            spec.player_start = house_game::gym::grid::CellPos::new(d.spawn.0, d.spawn.1);
        }
        let proj = proj_from_env();
        // Boot look: the LEVEL demo's, else LOOK env (the ESC menu switches
        // live from there).
        let look = match demo {
            Some(d) => crate::look::by_name(d.look).unwrap_or_else(crate::look::from_env),
            None => crate::look::from_env(),
        };
        let (mut scene, gym_meta) = crate::gym_scene::build_gym(&spec, look);
        // Wall-smash demo (phase 3): arm the rig + author the brick runs into
        // the scene BEFORE the backend consumes it. The rig owns the phys/{i}
        // namespace.
        let smash = arm_smash(demo, &gym_meta);
        let mut chunky_mats = Vec::new();
        if let Some(rig) = &smash {
            chunky_mats = crate::phys_scene::author_wall_bricks(&mut scene, &rig.bricks, look);
        }
        // Crack lab: stamp per-pier aging knobs into the materials BEFORE the
        // backend consumes the scene. CRACKS env (harness, uniform) overrides
        // the demo's authored seed; neither → pristine (bit-identical image).
        let mut crack = crate::crack::CrackLab::default();
        let level_wear = demo.and_then(|d| d.wear).map(|f| f.level_wear());
        crate::crack::resolve(level_wear, &mut crack, &gym_meta.piers, &mut scene, cfg.render.aa_scope);
        crack.active = level_wear.is_some();
        // A demo that ages a wall has to NAME one: report a miss once here
        // rather than let the beat silently no-op for its whole run.
        if let Some((x, z)) = demo.map(|d| d.script).and_then(crate::demos::DemoRunner::age_point) {
            if crate::crack::pier_index_at(&gym_meta.piers, x, z).is_none() {
                println!("age: ramp point ({x}, {z}) misses every wall pier — beat disarmed");
            }
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
            proj,
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
            aa: cfg.render.aa.unwrap_or(look.aa),
            aa_scope: cfg.render.aa_scope as f32,
            aa_chunky: if cfg.render.aa_chunky { 1.0 } else { 0.0 },
            aa_chunky_mats: chunky_mats,
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
                drag_pending: false,
            },
            gym: GymLoop::with_projection(spec, proj),
            piers: gym_meta.piers,
            crack,
            ide: crate::ide_host::IdeState::from_env(),
            harness: Harness::from_cfg(&cfg),
            rec: None,
            rec_jobs: Vec::new(),
            movie: cfg.harness.movie.clone().map(|dir| {
                std::fs::create_dir_all(&dir).ok();
                crate::capture::Movie::new(dir, &cfg)
            }),
            roof_prims: gym_meta.roof_prims,
            room_min: gym_meta.room_min,
            room_max: gym_meta.room_max,
            torn: false,
            smash,
            demo: crate::demos::DemoRunner::new(demo.map(|d| d.script).unwrap_or(&[])),
            cur_demo: demo,
            env_override: None,
            frame: 0,
            start_time,
            last_frame: None,
            frame_time_sum: 0.0,
            exit_requested: false,
            cfg,
        };
        // backend.new already built the swapchain (and baked probes); centre the
        // visible crop now that the view exists.
        r.recenter_pan();
        // optional initial pan offset (low pixels), for headless capture tests
        if r.cfg.game.pan != (0.0, 0.0) {
            let d = Vec2::new(r.cfg.game.pan.0, r.cfg.game.pan.1);
            r.view.pan += d;
            r.clamp_pan_to_buffer();
        }
        // CHUNKY detail (rubble) takes the AA only if the owner says so, and the
        // crack path stamps piers inside `resolve` — so one pass here settles
        // every AA opt-in bit against the freshly built scene.
        r.aa_stamp();
        // the wear family's per-surface effect word rides the same post-build
        // live stream (never the pre-build scene: the probe-cache key hashes the
        // material bytes — see crate::wear).
        r.wear_stamp();
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
        // CRACK_EDIT harness knob: replay a knob drag + release, so the headless
        // path can measure and diff the crack-lab REBUILD (the owner's expensive
        // interaction) instead of only a boot.
        r.crack_edit_from_env();
        // IDE_EDIT harness knob: replay IDE inspector edits through the real
        // apply path (spec mutation + rebuild), same discipline.
        r.ide_env_edits();
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
        self.gym = GymLoop::with_projection(self.gym.spec.clone(), self.proj);
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
        self.rebuild_in_look(look, ProbeRefresh::Full);
    }

    /// The rebuild body behind [`Self::apply_look`], with the GI half as a
    /// parameter. A look switch / demo boot must rebake everything ([`ProbeRefresh::Full`]);
    /// the crack-lab knob release passes the dirty pier AABBs
    /// ([`ProbeRefresh::Local`]) because it changed nothing else in the level —
    /// identical host work, half the wall clock (see `Viewer::crack_release`).
    pub(crate) fn rebuild_in_look(&mut self, look: &'static crate::look::Look, refresh: ProbeRefresh) {
        let t0 = std::time::Instant::now();
        let (mut scene, meta) = crate::gym_scene::build_gym(&self.gym.spec, look);
        // re-arm the wall-smash rig against the FRESH meta (prim indices may
        // shift with the look) + re-author its brick runs; a fired smash
        // resets to the standing wall — same one-shot rule as the roof tear
        self.smash = arm_smash(self.cur_demo, &meta);
        self.aa_chunky_mats.clear();
        if let Some(rig) = &self.smash {
            self.aa_chunky_mats = crate::phys_scene::author_wall_bricks(&mut scene, &rig.bricks, look);
            self.gym.phys = None; // bricks wait zero-scaled for the beat
        }
        // crack lab: refresh the pick targets and re-stamp the aging knobs
        // into the fresh materials (a rebuild mints them clean). Live-dialed
        // values survive a look switch (the pier count is look-stable);
        // entering/leaving the demo re-seeds or clears.
        self.piers = meta.piers;
        let level_wear = self.cur_demo.and_then(|d| d.wear).map(|f| f.level_wear());
        crate::crack::resolve(level_wear, &mut self.crack, &self.piers, &mut scene, self.aa_scope.round() as i32);
        self.crack.active = level_wear.is_some();
        unsafe { self.backend.rebuild_scene(&scene, &self.cfg, refresh) };
        self.light_keys = join_lamp_lights(&scene, self.backend.handles(), self.backend.light_count());
        self.scene = scene;
        self.aa_stamp(); // the rebuild minted clean materials: re-derive the AA scope
        self.wear_stamp(); // …and re-stream the effect word onto them (crate::wear)
        // a look switch supersedes any in-flight demo morph + its per-frame env
        self.demo.cancel_morph();
        self.env_override = None;
        // the roof/room meta is look-independent BUT a look that drops the
        // grass/window prims would shift the indices — refresh so the tear
        // stays correct after any look switch (and after boot_demo's respawn)
        self.roof_prims = meta.roof_prims;
        self.room_min = meta.room_min;
        self.room_max = meta.room_max;
        self.look = look;
        self.exposure = self.cfg.render.exposure.unwrap_or(look.exposure);
        self.style = look.style.env_over();
        self.spec = self.cfg.render.spec.unwrap_or(look.spec);
        self.gloss = self.cfg.render.gloss.unwrap_or(look.gloss);
        self.bump = self.cfg.render.bump.unwrap_or(look.bump);
        self.bump_scale = self.cfg.render.bump_scale.unwrap_or(look.bump_scale);
        self.gi = self.cfg.render.gi.unwrap_or(look.gi);
        self.aa = self.cfg.render.aa.unwrap_or(look.aa);
        println!("look: {} ({:.0} ms)", look.name, t0.elapsed().as_secs_f32() * 1000.0);
    }

    /// Boot a named demo from the LEVELS menu (owner directive 2026-07-16 —
    /// see `demos.rs`): respawn the player at the demo's cell, reset the sim,
    /// arm (or disarm) the roof tear, and rebuild the scene in the demo's look
    /// (`apply_look` also re-joins lights + refreshes the roof/room meta). The
    /// follow-cam is re-aimed at the new spawn for a clean first frame.
    pub fn boot_demo(&mut self, demo: &'static crate::demos::Demo) {
        self.gym.spec.player_start = house_game::gym::grid::CellPos::new(demo.spawn.0, demo.spawn.1);
        self.restart_gym();
        self.torn = false;
        self.cur_demo = Some(demo); // apply_look below re-arms the smash rig
        self.demo = crate::demos::DemoRunner::new(demo.script);
        self.env_override = None;
        let look = crate::look::by_name(demo.look).unwrap_or(&crate::look::POLANA);
        self.apply_look(look); // blocking scene + probe rebuild (disk-cached per look)
        self.retarget(self.gym.cam_target());
        self.recenter_pan();
        println!("demo: {} (look {}, spawn {:?}, {} beats)", demo.name, demo.look, demo.spawn, demo.script.len());
    }

    /// Advance the named-demo timeline one sim step and apply its per-frame
    /// effects to generic knobs — the timeline logic itself lives in
    /// `demos::DemoRunner`; the loop only routes its outputs. Deterministic
    /// (tick-driven), so it replays bit-identically in DEMO and settles live.
    fn drive_demo(&mut self) {
        let step = self.demo.step(self.gym.tick.0, self.look);
        if step.tear {
            self.tear_roof();
        }
        if step.smash {
            self.smash_wall();
        }
        if let Some(a) = step.age {
            self.age_wall_step(a.x, a.z, a.t, a.commit);
        }
        if let Some(lit) = step.lit {
            // apply the cross-fade's lightable half; the sun/sky go through the
            // per-frame env override (no rebake — palette + probe indirect stay)
            self.exposure = lit.exposure;
            self.style.sat = lit.sat;
            self.style.contrast = lit.contrast;
            self.spec = lit.spec;
            self.gloss = lit.gloss;
            self.bump = lit.bump;
            self.bump_scale = lit.bump_scale;
            self.gi = lit.gi;
            self.env_override = Some(rt_probe::EnvBlock::pack(self.cfg.lighting_env(lit.lighting), &lit.sun));
        }
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
        self.drive_demo(); // named-demo timeline: tick-scheduled beats + look morph
        self.follow_player_camera(); // follow the continuous/eased player body
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
            instances: &instances,
        };

        // ESC menu overlay (panel / wall panel / REC badge), copied onto the PRESENTED
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
        // picture, not shell UI — they ride into SHOT/DEMO captures. The IDE
        // panels ride the same path ON PURPOSE: a SHOT with IDE=1 is the
        // headless verification of the whole overlay.
        let mut stamps = self.gym.stamps(&self.pick_xform(), self.backend.extent(), self.rs() as u32);
        stamps.extend(self.ide_stamps());
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
            aa: self.aa,
            aa_scope: self.aa_scope.round() as i32,
            debug: self.debug,
            exposure: self.exposure,
            style: self.style,
            frame: self.frame,
            overlay,
            stamps: &stamps,
            // permanent sunny day (the joyful default); SKY env still scales
            // the authored env via lighting_env
            sky_dim: 1.0,
            env: self.env_override, // demo look-morph per-frame sun/sky (else None)
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

    /// The roof tear-off (the DDGI flood): hide the roof prims + queue the
    /// amortized interior probe refresh, so the dynamic GI floods in over the
    /// next frames while the player watches (WALLCUT already shows the interior
    /// when they're inside). Driven by the "dusk flood" demo's `TearRoof` beat
    /// and by the `x` key. One-shot; a scene rebuild re-arms it.
    pub fn tear_roof(&mut self) {
        if self.roof_prims.is_empty() {
            println!("roof: nothing to tear (roofless build)");
            return;
        }
        if self.torn {
            println!("roof: already torn — relaunch to re-arm");
            return;
        }
        let prims: Vec<usize> = self.roof_prims.clone().collect();
        let (min, max) = (self.room_min, self.room_max);
        unsafe { self.backend.tear_off(&prims, min, max, true) }; // amortized live settle
        self.torn = true;
        self.ui_blip("menu_move");
        println!("roof torn off — dynamic GI settling (step inside to watch)");
    }

    /// Phase 3 — the wall smash (physics × dynamic GI). One `tear_off` masks
    /// the pier and starts the rolling probe refresh over the room + a breach
    /// apron; the box3d world takes over the SAME volume the same frame —
    /// bricks in the pier's exact pose (the swap is silhouette-, shadow- and
    /// GI-continuous, since probe rays traverse the live TLAS and see the
    /// bricks standing) with a heavy slug inbound. Direct light reacts
    /// per-frame as the breach opens; the roll reconverges the bounce.
    pub fn smash_wall(&mut self) {
        let Some(rig) = &mut self.smash else {
            println!("smash: no armed wall rig (not a smash demo)");
            return;
        };
        if rig.fired {
            return;
        }
        rig.fired = true;
        let n_bricks = rig.bricks.len();
        // breach apron: extend the room's refresh region OUTWARD through the
        // wall, so the light spilling outside settles too. The pier's thin
        // axis is the wall normal; outward = away from the room centre.
        let (size, c) = (rig.hi - rig.lo, (rig.lo + rig.hi) * 0.5);
        let room_c = (self.room_min + self.room_max) * 0.5;
        let out_x = size.x < size.z; // thin axis = the wall normal
        let sign = if (if out_x { c.x - room_c.x } else { c.z - room_c.z }) >= 0.0 { 1.0 } else { -1.0 };
        let apron = if out_x { Vec3::new(2.5 * sign, 0.0, 0.0) } else { Vec3::new(0.0, 0.0, 2.5 * sign) };
        let (min, max) = (self.room_min.min(rig.lo + apron.min(Vec3::ZERO)), self.room_max.max(rig.hi + apron.max(Vec3::ZERO)));
        unsafe { self.backend.tear_off(&[rig.prim], min, max, true) }; // amortized rolling settle
        // physics: the surviving flanks of the run + the room's far wall stay
        // solid as invisible colliders; the slug flies in flat-ish from 4.5 wu
        // out and arcs into the pier's upper-middle so the top courses fly.
        let mut statics = vec![rig_flank(rig, out_x, false), rig_flank(rig, out_x, true)];
        let far = if out_x {
            // the wall opposite the breach, a 0.2-wu band on the room shell
            if sign > 0.0 { (Vec3::new(self.room_min.x - 0.1, 0.0, self.room_min.z), Vec3::new(self.room_min.x + 0.1, crate::gym_scene::WALL_TOP, self.room_max.z)) } else { (Vec3::new(self.room_max.x - 0.1, 0.0, self.room_min.z), Vec3::new(self.room_max.x + 0.1, crate::gym_scene::WALL_TOP, self.room_max.z)) }
        } else if sign > 0.0 {
            (Vec3::new(self.room_min.x, 0.0, self.room_min.z - 0.1), Vec3::new(self.room_max.x, crate::gym_scene::WALL_TOP, self.room_min.z + 0.1))
        } else {
            (Vec3::new(self.room_min.x, 0.0, self.room_max.z - 0.1), Vec3::new(self.room_max.x, crate::gym_scene::WALL_TOP, self.room_max.z + 0.1))
        };
        statics.push(far);
        let outward = apron.normalize_or_zero();
        let from = Vec3::new(c.x, 2.0, c.z) + outward * 5.5;
        self.gym.phys = Some(phys_spike::PhysWorld::wall_break(&rig.bricks, &statics, from, outward * -14.0, 0));
        self.ui_blip("menu_move");
        println!("wall smashed — {n_bricks} bricks live, dynamic GI settling through the breach");
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
        // stopped. The IDE pauses the same way (pause = edit, the 2026-07-23
        // anchor: authoring happens in a frozen world). Harness modes never
        // pause.
        if (self.menu_open() || self.ide.ui.open) && self.harness.shot.is_none() {
            return;
        }
        let sim_dt = shot_sim_dt(self.harness.shot.is_some(), dt);
        self.gym.run_due(sim_dt);
    }

    /// Overlay phase of `draw()`: the ESC/game-menu canvas + centering flag,
    /// owned so the borrow in `FramePresent` can outlive the builder. `None`
    /// in every harness capture mode (SHOT/MOVIE/DUMP/DEMO stay UI-free).
    fn overlay_frame(&mut self) -> Option<(Vec<u32>, i32, i32, bool)> {
        // the IDE's stamps ARE the shell while it is open — no wall panel on
        // top (a modal menu can't be open then: ESC closes the IDE first)
        if self.ide.ui.open && !self.menu_open() {
            return None;
        }
        if self.harness.shot.is_none() && self.movie.is_none() && self.harness.dump_dir.is_none() && self.harness.demo.is_none() {
            let (buf, w, h) = self.menu_canvas()?;
            let center = matches!(self.menu.mode, crate::menu::MenuMode::Title | crate::menu::MenuMode::Pause | crate::menu::MenuMode::Levels);
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
        // disc centre low on screen. The anchor is the rendered body — a
        // spawn-pinned disc means no reveal once you walk behind the building.
        let center = self.gym.cam_target() + glam::Vec3::new(0.0, 0.65, 0.0);
        // ROI_XRAY=contour adds faint wall-silhouette lines ON TOP of the ghost
        // stipple. Encoded by NEGATING the ghost cap: the shader reads roi2.w<0
        // as hybrid mode and |roi2.w| as the coverage cap, so the stipple stays.
        let ghost = if self.cfg.game.roi_contour { -self.cfg.game.roi_ghost } else { self.cfg.game.roi_ghost };
        Some(crate::backend::RoiInfo { player: center, radius_px: self.cfg.game.roi_radius, falloff_px: self.cfg.game.roi_falloff, ghost })
    }
}
