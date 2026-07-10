//! All runtime configuration, resolved from the environment ONCE at startup.
//!
//! Every tuning knob flows through this struct, so the inventory of tuning
//! surface is visible here and the ESC menu / env-string round-trip (`viewer`)
//! has a single source of truth. One deliberate exception reads `std::env`
//! directly: `probe_cache::dir` (PROBE_CACHE) — a dev-machine cache location,
//! not a look/sim knob, and never part of the round-trip. (rt-viewer keeps a
//! few shell-only reads of its own: DOORS, DUMP_ROOMS, AUDIO, LOOK.)
//!
//! `Config` is split along the three natural axes the knobs fall into:
//! - [`RenderCfg`] — renderer look + GI/probe bake knobs (no game, no window).
//! - [`GameCfg`]   — game / input / camera-seeding knobs (sim state at boot).
//! - [`HarnessCfg`] — window size + capture/movie/clip harness knobs.
//!
//! `Config::from_env` resolves all three; `scene` is the shared identity field
//! both the renderer's scene builders and the game adapter read, so it lives on
//! the top-level `Config` rather than in any one group. Env var names and the
//! ESC menu env-string round-trip are UNCHANGED by the split — saved tunings
//! keep working (pinned by `config::tests::env_string_round_trip`).

fn f(k: &str, d: f32) -> f32 {
    std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
}
fn fo(k: &str) -> Option<f32> {
    std::env::var(k).ok().and_then(|v| v.parse().ok())
}
fn i(k: &str, d: i32) -> i32 {
    std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
}
fn b(k: &str, d: bool) -> bool {
    std::env::var(k).map(|v| v != "0").unwrap_or(d)
}
fn s(k: &str) -> Option<String> {
    std::env::var(k).ok()
}

/// One row per scene: every per-scene RENDER default in one place. Adding a
/// scene = adding one row here (and one `SceneEntry` row in rt-viewer's
/// `scene_registry`, which owns the spec/camera/classifier side — rt-probe
/// cannot hold LevelSpec builders without seeing house-game). Scene names not
/// in the table fall back to [`LOOK_DEFAULT`] (the textured-legacy look),
/// exactly as the old scattered `matches!` lists did. Matching is EXACT; the
/// `grid-walker` alias is normalized to `grid` in `Config::from_env` before
/// any lookup.
struct SceneLook {
    name: &'static str,
    /// The flat-coloured "greybox" family (procedural floor plans, the cave
    /// dungeon, the village, the `game` content scene): punchy / shiny /
    /// bumped look defaults. The textured legacy scenes (house/lab/grid) stay
    /// out so their established look + goldens are untouched.
    greybox: bool,
    /// Luma below which the shadow dither fades in. Bright-pastel scenes sit
    /// HIGHER (0.75): their surfaces push AO crevices above the 0.35 cutoff,
    /// so the dither stopped triggering where AO darkens contact shadows.
    sdither_th: f32,
    /// Default EXPOSURE: lamp-lit scenes (no sun) need more than daylight
    /// ones. (Retuned 0.35 -> 0.40 on 2026-06-12 with sRGB albedo sampling.)
    exposure: f32,
    /// Default PIXEL (integer upscale). The 20×20 wu arena pits need the wide
    /// framing: at PIXEL=4 a 1280×800 window sees only ~7 wu across.
    pixel: u32,
    /// Default MINIMAP toggle (the schematic overlay).
    minimap: bool,
    /// Default CAVE_ROI (dithered player-anchored see-through reveal — the
    /// sole wall occlusion on player+wall scenes).
    roi: bool,
    /// Default player walk speed (px/s; grid mirrors the web knob default).
    player_speed: f32,
}

/// The fallback row (textured-legacy look) — also the base most rows override.
const LOOK_DEFAULT: SceneLook = SceneLook { name: "", greybox: false, sdither_th: 0.35, exposure: 0.22, pixel: 4, minimap: false, roi: false, player_speed: 140.0 };

static SCENE_LOOKS: &[SceneLook] = &[
    // textured legacy trio (golden-pinned — rows must stay LOOK_DEFAULT-flavoured)
    SceneLook { name: "house", exposure: 0.40, roi: true, ..LOOK_DEFAULT },
    SceneLook { name: "lab", ..LOOK_DEFAULT },
    SceneLook { name: "grid", player_speed: 80.0, ..LOOK_DEFAULT },
    // authored content scenes (game is golden-pinned)
    SceneLook { name: "game", greybox: true, sdither_th: 0.75, exposure: 0.40, roi: true, ..LOOK_DEFAULT },
    // thief M2 slice: wide framing (vision range 8 must fit the read),
    // greybox look, ROI near-wall reveal (FLOORCUT handles the roofs)
    SceneLook { name: "thief", greybox: true, sdither_th: 0.75, exposure: 0.40, pixel: 2, roi: true, ..LOOK_DEFAULT },
    SceneLook { name: "goo", roi: true, ..LOOK_DEFAULT },
    // procedural dungeon / floor plans / village
    SceneLook { name: "cave", greybox: true, sdither_th: 0.75, exposure: 0.40, roi: true, ..LOOK_DEFAULT },
    SceneLook { name: "village", greybox: true, exposure: 0.40, minimap: true, roi: true, ..LOOK_DEFAULT },
    SceneLook { name: "home", greybox: true, exposure: 0.40, minimap: true, roi: true, ..LOOK_DEFAULT },
    SceneLook { name: "hospital", greybox: true, exposure: 0.40, minimap: true, roi: true, ..LOOK_DEFAULT },
    SceneLook { name: "office", greybox: true, exposure: 0.40, minimap: true, roi: true, ..LOOK_DEFAULT },
    SceneLook { name: "factory", greybox: true, exposure: 0.40, minimap: true, roi: true, ..LOOK_DEFAULT },
    // arena-shooter pits (wide framing)
    SceneLook { name: "arena", pixel: 2, ..LOOK_DEFAULT },
    SceneLook { name: "squeeze", pixel: 2, ..LOOK_DEFAULT },
    SceneLook { name: "drain", pixel: 2, ..LOOK_DEFAULT },
    // goo film / demo stages (all-default rows, listed so the roster is complete)
    SceneLook { name: "playground", ..LOOK_DEFAULT },
    SceneLook { name: "range", ..LOOK_DEFAULT },
    SceneLook { name: "goofloor", ..LOOK_DEFAULT },
    SceneLook { name: "goonursery", ..LOOK_DEFAULT },
    SceneLook { name: "goopair", ..LOOK_DEFAULT },
];

fn scene_look(scene: &str) -> &'static SceneLook {
    SCENE_LOOKS.iter().find(|l| l.name == scene).unwrap_or(&LOOK_DEFAULT)
}

/// The flat-coloured "greybox" scene family — see [`SceneLook::greybox`].
fn is_clean_greybox(scene: &str) -> bool {
    scene_look(scene).greybox
}

/// Stylized post-stack knobs (tonemap.comp). `STYLE=<preset>` sets a bundle,
/// individual vars override on top.
#[derive(Clone, Copy)]
pub struct StyleCfg {
    pub grade: f32,        // 0 off, 1 fallout, 2 noir, 3 sepia, 4 neon, 5 bleach, 6 midnight
    pub poster: f32,       // cel bands on demodulated irradiance (0 off)
    pub dither: f32,       // 0 off, 1 bayer8, 2 bayer4, 3 bayer2, 4 IGN, 5 white(animated)
    pub dither_amt: f32,   // dither amplitude fed into the quantizer (<0 = pick per palette mode)
    pub palette: f32,      // 0 off, 1 pal32, 2 rgb posterize, 3 duotone, 4 gameboy
    pub pal_p: f32,        // posterize levels / duotone pair (<0 = default per mode)
    pub vignette: f32,     // 0..1 corner darkening
    pub outline: f32,      // 0..1 depth-edge silhouette darkening
    pub grain: f32,        // film grain strength (0 = off)
    pub grain_sz: f32,     // grain cell size in game px
    pub grain_static: f32, // 1 = frozen plate grain (no animation)
    pub bloom: f32,        // HDR bloom strength (0 = off)
    pub bloom_th: f32,     // bloom bright-pass threshold (exposed luma)
    pub sdither: f32,      // shadow dither strength 0..1 (0 = off)
    pub sdither_n: f32,    // shadow dither luma levels (band count)
    pub sdither_th: f32,   // luma below which the shadow dither fades in
    pub sat: f32,          // SAT: saturation multiplier post-grade (1 = neutral, >1 punchier)
    pub contrast: f32,     // CONTRAST: contrast around 0.5 post-grade (1 = neutral)
    pub lumaq: f32,        // LUMAQ: quantize luminance to N hard levels, hue kept (0 = off)
    pub analog: f32,       // ANALOG: analog-signal luma noise strength (0 = off)
    pub analog_chroma: f32, // ANALOG_CHROMA: chroma noise strength (defaults to ANALOG)
    pub analog_tear: f32,  // ANALOG_TEAR: horizontal scanline-tear strength (defaults to ANALOG)
    pub crt_mask: f32,     // CRT_MASK: RGB phosphor triad + scanline on the FINAL image (0 = off)
}

impl StyleCfg {
    fn from_env(scene: &str) -> StyleCfg {
        // shadow dither ON by default (user-tuned 2026-06-10: strength 1, 16
        // luma bands) — the subtle retro texture in shadow gradients is part of
        // the base look. SDITHER=0 for fully clean.
        //
        // sdither_th is the luma below which the dither fades in — per-scene
        // (bright pastel scenes sit higher; see SceneLook::sdither_th).
        let sdither_th = scene_look(scene).sdither_th;
        // The "Punchy & Moody" greybox look (chosen 2026-06-21): the flat-coloured
        // floor-plan / dungeon / content scenes get richer colour by default. The
        // textured legacy scenes (house/lab/grid) keep their established neutral grade.
        let clean = is_clean_greybox(scene);
        let mut st = StyleCfg { grade: 0.0, poster: 0.0, dither: 1.0, dither_amt: -1.0, palette: 0.0, pal_p: -1.0, vignette: 0.0, outline: 0.0, grain: 0.0, grain_sz: 1.0, grain_static: 0.0, bloom: 0.0, bloom_th: 1.0, sdither: 1.0, sdither_n: 16.0, sdither_th, sat: if clean { 1.4 } else { 1.0 }, contrast: if clean { 1.12 } else { 1.0 }, lumaq: 0.0, analog: 0.0, analog_chroma: -1.0, analog_tear: -1.0, crt_mask: 0.0 };
        if let Some(name) = s("STYLE") {
            match name.as_str() {
                "fallout" => { st.grade = 1.0; st.palette = 1.0; st.grain = 0.04; }
                "noir" => { st.grade = 2.0; st.grain = 0.07; st.vignette = 0.4; }
                "sepia" => { st.grade = 3.0; st.grain = 0.05; st.vignette = 0.25; }
                "neon" => { st.grade = 4.0; st.bloom = 0.7; st.bloom_th = 0.75; st.grain = 0.03; }
                "bleach" => { st.grade = 5.0; st.grain = 0.05; }
                "midnight" => { st.grade = 6.0; st.bloom = 0.5; st.bloom_th = 0.8; }
                "cel" => { st.poster = 4.0; st.outline = 0.85; }
                "comic" => { st.poster = 3.0; st.outline = 0.9; st.palette = 2.0; st.pal_p = 8.0; }
                "posterize" => { st.palette = 2.0; st.pal_p = 6.0; }
                "duotone" => { st.palette = 3.0; st.pal_p = 0.0; }
                "crt" => { st.palette = 3.0; st.pal_p = 2.0; st.dither = 4.0; st.grain = 0.04; }
                "gameboy" => { st.palette = 4.0; st.dither_amt = 0.16; }
                "clean" => {}
                other => eprintln!("STYLE={other}: unknown preset (fallout noir sepia neon bleach midnight cel comic posterize duotone crt gameboy clean)"),
            }
        }
        st.grade = f("GRADE", st.grade);
        st.poster = f("POSTER", st.poster);
        st.dither = f("DITHER", st.dither);
        st.dither_amt = f("DITHER_AMT", st.dither_amt);
        st.palette = f("PALETTE", st.palette);
        st.pal_p = f("PAL_N", st.pal_p);
        st.vignette = f("VIGNETTE", st.vignette);
        st.outline = f("OUTLINE", st.outline);
        st.grain = f("GRAIN", st.grain);
        st.grain_sz = f("GRAIN_SZ", st.grain_sz);
        st.grain_static = f("GRAIN_STATIC", st.grain_static);
        st.bloom = f("BLOOM", st.bloom);
        st.bloom_th = f("BLOOM_TH", st.bloom_th);
        st.sdither = f("SDITHER", st.sdither);
        st.sdither_n = f("SDITHER_N", st.sdither_n);
        st.sdither_th = f("SDITHER_TH", st.sdither_th);
        st.sat = f("SAT", st.sat);
        st.contrast = f("CONTRAST", st.contrast);
        st.lumaq = f("LUMAQ", st.lumaq);
        st.analog = f("ANALOG", st.analog);
        // chroma/tear ride the master ANALOG strength unless overridden
        st.analog_chroma = f("ANALOG_CHROMA", st.analog_chroma);
        st.analog_tear = f("ANALOG_TEAR", st.analog_tear);
        if st.analog_chroma < 0.0 {
            st.analog_chroma = st.analog;
        }
        if st.analog_tear < 0.0 {
            st.analog_tear = st.analog;
        }
        st.crt_mask = f("CRT_MASK", st.crt_mask);
        if st.pal_p < 0.0 {
            st.pal_p = if st.palette as i32 == 2 { 6.0 } else { 0.0 };
        }
        if st.dither_amt < 0.0 {
            // default amplitude scaled to the quantizer's step size
            st.dither_amt = match st.palette as i32 {
                1 => 0.07,
                2 => 1.0 / (st.pal_p.max(2.0) - 1.0),
                3 => 0.10,
                4 => 0.16,
                _ => 0.0,
            };
        }
        st
    }
}

/// Renderer look + GI/probe bake knobs. No game, no window — everything here
/// feeds the shade/probe pipelines and the post stack. `default_exposure`
/// depends on the scene, so EXPOSURE is resolved against the scene name at
/// `from_env` time.
pub struct RenderCfg {
    pub emit: f32,                 // EMIT: master scale on authored practical emission
    pub sun: Option<f32>,          // SUN/SKY/FOG/FOG_H override the scene's lighting env
    pub sky: Option<f32>,
    pub fog: Option<f32>,
    pub fog_h: Option<f32>,
    pub pet_dump: bool,            // PET_DUMP: dump the PET prop's triangles as CSV
    pub pixel: u32,                // PIXEL: integer render scale at zoom=1
    pub exposure: f32,             // EXPOSURE (default depends on scene)
    pub probe_spacing: f32,        // PROBE_SPACING: GI probe grid spacing (wu)
    pub probe_rays: i32,           // PROBE_RAYS: bake rays per probe per bank
    pub ao: f32,                   // AO: RT-AO strength
    pub ao_r: f32,                 // AO_R: RT-AO radius (wu)
    pub ao_n: i32,                 // AO_N: RT-AO ray count
    pub spec: f32,                 // SPEC: specular highlight strength (0 = off, matte)
    pub gloss: f32,                // GLOSS: 0..1 remap of effective roughness toward polished
    pub bump: f32,                 // BUMP: procedural surface-detail normal strength (0 = off)
    pub bump_scale: f32,           // BUMP_SCALE: surface-detail noise frequency (wu^-1)
    pub gi: f32,                   // GI: ambient probe-irradiance scale (1 = neutral, <1 = moodier)
    pub matq: f32,                 // MATQ: posterize materials — albedo/roughness snapped to N levels (0 = off)
    pub ao_dither: f32,            // AO_DITHER: RT-AO gradient → binary Bayer stipple (0 = off)
    pub refl: f32,                 // REFL: pixelated mirror-reflection composite strength (0 = off)
    pub refl_px: i32,              // REFL_PX: reflection block size in low-res px (the pixelation)
    pub debug: i32,                // DEBUG_ALBEDO=1 | DEBUG_GI=2 | DEBUG_DIRECT=3 | DEBUG_AO=4
    pub style: StyleCfg,
}

impl RenderCfg {
    /// The scene's lighting env with the SUN/SKY/FOG/FOG_H overrides applied.
    pub fn lighting_env(&self, scene_lighting: [f32; 4]) -> [f32; 4] {
        let mut e = scene_lighting;
        for (slot, ov) in e.iter_mut().zip([self.sun, self.sky, self.fog, self.fog_h]) {
            if let Some(v) = ov {
                *slot = v;
            }
        }
        e
    }
}

/// Game / input / camera-seeding knobs. These write SIM STATE at boot (flash,
/// room-lights master, player speed/offset, settled yaw quarter) plus the
/// camera presentation seeds (zoom, pan, look-at target) and the deterministic
/// command-replay prefix.
pub struct GameCfg {
    pub lights: f32,               // LIGHTS: room-lights master dim 0..1
    pub light_anim: bool,          // LIGHT_ANIM=0 freezes practical flicker
    pub flash: bool,               // FLASH: flashlight on at boot
    pub flash_power: f32,          // FLASH_POWER
    pub flash_cone: f32,           // FLASH_CONE: outer half-angle, degrees
    pub zoom: f32,                 // ZOOM (whole steps 1-4)
    pub yaw_q: u32,                // YAW_Q: start quarter-turn
    pub pan: (f32, f32),           // PAN_X/PAN_Y: initial crop offset (low px)
    pub target: (Option<f32>, Option<f32>), // TARGET_X/TARGET_Z: camera look-at override
    pub player_off: (f32, f32),    // PLAYER_X/PLAYER_Z: player offset from spawn
    pub player_speed: Option<f32>, // PLAYER_SPEED (px/s; default depends on scene)
    pub cmds: Option<String>,      // CMDS=trace.txt: deterministic command-replay prefix
    pub cmds_ticks: Option<u64>,   // CMDS_TICKS: prefix length (default: last stamp + 1)
    pub cave_seed: u64,            // SEED / CAVE_SEED: the run/level seed (cave layout, arena drafts)
    pub cave_rooms: u32,           // CAVE_ROOMS: target room count (grid scales to fit)
    pub cave_loops: u32,           // CAVE_LOOPS: extra corridors beyond the spanning tree
    pub cave_thick: bool,          // CAVE_WALLS=rock: thick 1×1 rock blocks vs thin walls + void
    pub minimap: bool,             // MINIMAP: draw the top-down minimap HUD (default on for SCENE=village)
    pub roi: bool,                 // CAVE_ROI: dithered player-anchored see-through reveal — the sole wall occlusion (default on for all player+wall scenes)
    pub roi_radius: f32,           // ROI_R: reveal-disc radius in low-res px
    pub roi_falloff: f32,          // ROI_FALLOFF: soft dither edge width in low-res px
    pub roi_ghost: f32,            // ROI_GHOST: max reveal coverage at disc centre (<1 leaves a faint stipple ghost of the wall)
    pub roi_contour: bool,         // ROI_XRAY: default on — adds faint wall-silhouette line-art over the ghost stipple; ROI_XRAY=ghost turns it off (plain stipple)
    pub cut: Option<f32>,          // CUT: FLOORCUT plane world-Y — everything at/above it dissolves on the primary ray (multi-floor dollhouse reveal); unset = off
    pub wall_cut: Option<f32>,     // WALLCUT: occluder-only cut plane world-Y — walls/roofs/lintels at/above it dissolve (indoor sill-height cutaway); unset = game-driven
}

/// Window size + capture / movie / clip harness knobs. None of these touch the
/// look or the game — they drive the headless SHOT path, the scripted MOVIE
/// tour, the DUMP/FRAMES diagnostics, and clip encoding.
pub struct HarnessCfg {
    pub window: Option<(u32, u32)>, // WINDOW=WxH: requested inner size (goldens)
    pub shot: Option<String>,      // SHOT=path.png: capture one frame, exit
    pub shot_delay: f32,           // SHOT_DELAY: seconds before the capture
    pub rotate_at: Option<f32>,    // ROTATE_AT=secs: fire one smooth e-turn
    pub dump: Option<String>,      // DUMP=dir: record presented frames as PNGs
    pub dump_at: Option<f32>,      // DUMP_AT=secs: start the dump on a timer
    pub dump_n: i32,               // DUMP_N: frames per dump
    pub movie: Option<String>,     // MOVIE=dir: run the scripted camera tour
    pub detail: (f32, f32),        // DETAIL_X/DETAIL_Z: movie's zoom-in target
    // DEMO=trace.txt: fully-headless trace-driven gameplay frame dump. Like
    // SHOT (present:None, no window) but instead of one frame it plays the
    // CMDS-format trace live — one tick per frame, draining that tick's
    // commands and ticking the sim — and writes DEMO_DIR/d_NNNNN.png per tick.
    pub demo: Option<String>,      // DEMO=trace.txt: the gameplay trace to play
    pub demo_dir: Option<String>,  // DEMO_DIR: where the per-tick PNGs land
    pub demo_ticks: Option<u64>,   // DEMO_TICKS: tick count (default: last stamp + 1)
    pub frames_limit: Option<u32>, // FRAMES=N: exit after N frames, log avg time
    pub timing: bool,              // TIMING=1: per-frame phase breakdown
    pub clip_fps: u32,             // CLIP_FPS
    pub clip_max_s: f32,           // CLIP_MAX_S
    pub clip_mp4_scale: u32,       // CLIP_MP4_SCALE
    pub clip_gif_scale: u32,       // CLIP_GIF_SCALE
}

pub struct Config {
    // SCENE: cave (bin/run default) | arena | game | goo | village | home | hospital |
    // office | factory | playground | range | goofloor | goonursery | goopair | house | lab | grid
    pub scene: String,
    pub render: RenderCfg,
    pub game: GameCfg,
    pub harness: HarnessCfg,
}

impl Config {
    pub fn from_env() -> Config {
        let scene = s("SCENE").unwrap_or_else(|| "house".into());
        let scene = if scene == "grid-walker" { "grid".to_string() } else { scene };
        // every per-scene default (exposure, pixel, minimap, roi, greybox
        // look) reads off the scene's SCENE_LOOKS row — one place per scene.
        let look = scene_look(&scene);
        let window = s("WINDOW").and_then(|v| {
            let (w, h) = v.split_once('x')?;
            Some((w.parse().ok()?, h.parse().ok()?))
        });
        let debug = if b("DEBUG_ALBEDO", false) {
            1
        } else if b("DEBUG_GI", false) {
            2
        } else if b("DEBUG_DIRECT", false) {
            3
        } else if b("DEBUG_AO", false) {
            4
        } else {
            0
        };
        // greybox scenes default to the "Punchy & Moody" look (chosen 2026-06-21):
        // ambient turned down + lamps up so light is directional (shadows read),
        // multi-scale procedural wear (grime patches + relief), and softer AO.
        // (Specular sheen was trialled then turned off — matte reads cleaner.)
        let clean = is_clean_greybox(&scene);
        Config {
            render: RenderCfg {
                emit: f("EMIT", if clean { 1.7 } else { 1.0 }),
                sun: fo("SUN"),
                sky: fo("SKY"),
                fog: fo("FOG"),
                fog_h: fo("FOG_H"),
                pet_dump: b("PET_DUMP", false),
                pixel: (i("PIXEL", look.pixel as i32) as u32).max(1),
                exposure: f("EXPOSURE", look.exposure),
                probe_spacing: f("PROBE_SPACING", 0.5).max(0.05),
                probe_rays: i("PROBE_RAYS", 2048),
                ao: f("AO", if clean { 0.55 } else { 1.0 }),
                ao_r: f("AO_R", 0.8),
                ao_n: i("AO_N", 8),
                spec: f("SPEC", 0.0), // matte floors/walls — specular sheen turned off (2026-06-21)
                gloss: f("GLOSS", if clean { 0.85 } else { 0.0 }).clamp(0.0, 1.0),
                bump: f("BUMP", if clean { 0.8 } else { 0.0 }),
                bump_scale: f("BUMP_SCALE", if clean { 7.0 } else { 6.0 }).max(0.01),
                gi: f("GI", if clean { 0.42 } else { 1.0 }),
                matq: f("MATQ", 0.0),
                ao_dither: f("AO_DITHER", 0.0),
                refl: f("REFL", 0.0),
                refl_px: i("REFL_PX", 3).max(1),
                debug,
                style: StyleCfg::from_env(&scene),
            },
            game: GameCfg {
                lights: f("LIGHTS", 1.0).clamp(0.0, 1.0),
                light_anim: b("LIGHT_ANIM", true),
                flash: b("FLASH", false),
                flash_power: f("FLASH_POWER", 1.0),
                flash_cone: f("FLASH_CONE", 22.0),
                zoom: f("ZOOM", 1.0),
                yaw_q: (i("YAW_Q", 0) as u32) & 3,
                pan: (f("PAN_X", 0.0), f("PAN_Y", 0.0)),
                target: (fo("TARGET_X"), fo("TARGET_Z")),
                player_off: (f("PLAYER_X", 0.0), f("PLAYER_Z", 0.0)),
                player_speed: fo("PLAYER_SPEED"),
                cmds: s("CMDS"),
                cmds_ticks: s("CMDS_TICKS").and_then(|v| v.parse().ok()),
                cave_seed: s("SEED").or_else(|| s("CAVE_SEED")).and_then(|v| v.parse().ok()).unwrap_or(1),
                cave_rooms: (i("CAVE_ROOMS", 10) as u32).clamp(1, 80),
                cave_loops: i("CAVE_LOOPS", 3).max(0) as u32,
                cave_thick: s("CAVE_WALLS").map(|v| v == "rock" || v == "thick").unwrap_or(false),
                minimap: b("MINIMAP", look.minimap),
                roi: b("CAVE_ROI", look.roi),
                roi_radius: fo("ROI_R").unwrap_or(79.0),
                roi_falloff: fo("ROI_FALLOFF").unwrap_or(33.0),
                roi_ghost: fo("ROI_GHOST").unwrap_or(0.85),
                roi_contour: s("ROI_XRAY").map(|v| v != "ghost").unwrap_or(true),
                cut: fo("CUT"),
                wall_cut: fo("WALLCUT"),
            },
            harness: HarnessCfg {
                window,
                shot: s("SHOT"),
                shot_delay: f("SHOT_DELAY", 0.0),
                rotate_at: fo("ROTATE_AT"),
                dump: s("DUMP"),
                dump_at: fo("DUMP_AT"),
                dump_n: i("DUMP_N", 120),
                movie: s("MOVIE"),
                detail: (f("DETAIL_X", 11.5), f("DETAIL_Z", 2.0)),
                demo: s("DEMO"),
                demo_dir: s("DEMO_DIR"),
                demo_ticks: s("DEMO_TICKS").and_then(|v| v.parse().ok()),
                frames_limit: s("FRAMES").and_then(|v| v.parse().ok()),
                timing: b("TIMING", false),
                clip_fps: (i("CLIP_FPS", 50) as u32).clamp(2, 120),
                clip_max_s: f("CLIP_MAX_S", 60.0),
                clip_mp4_scale: (i("CLIP_MP4_SCALE", 4) as u32).clamp(1, 8),
                clip_gif_scale: (i("CLIP_GIF_SCALE", 1) as u32).clamp(1, 8),
            },
            scene,
        }
    }

    /// The scene's lighting env with the SUN/SKY/FOG/FOG_H overrides applied.
    /// (Forwards to [`RenderCfg::lighting_env`].)
    pub fn lighting_env(&self, scene_lighting: [f32; 4]) -> [f32; 4] {
        self.render.lighting_env(scene_lighting)
    }

    /// Default player walk speed — depends on the scene (grid mirrors the web
    /// knob default; the rest walk faster), so it bridges `scene` + `game`.
    pub fn default_player_speed(&self) -> f32 {
        scene_look(&self.scene).player_speed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SCENE_LOOKS must answer exactly what the pre-registry scattered
    /// `matches!` lists answered (expectations below are transcribed FROM that
    /// deleted code, not from the table): greybox was home|hospital|office|
    /// factory|cave|village|game; sdither_th 0.75 for game|cave else 0.35;
    /// exposure 0.40 for house|game|cave|village|home|hospital|office|factory
    /// else 0.22; pixel 2 for arena|squeeze|drain else 4; minimap for village|
    /// home|hospital|office|factory; roi for game|goo|house|cave|village|home|
    /// hospital|office|factory; player speed 80 for grid else 140. Unknown
    /// scenes take every fallback.
    #[test]
    fn scene_looks_match_legacy_dispatch() {
        // (name, greybox, sdither_th, exposure, pixel, minimap, roi, speed)
        type LookRow = (&'static str, bool, f32, f32, u32, bool, bool, f32);
        let legacy: &[LookRow] = &[
            ("house", false, 0.35, 0.40, 4, false, true, 140.0),
            ("lab", false, 0.35, 0.22, 4, false, false, 140.0),
            ("grid", false, 0.35, 0.22, 4, false, false, 80.0),
            ("game", true, 0.75, 0.40, 4, false, true, 140.0),
            ("goo", false, 0.35, 0.22, 4, false, true, 140.0),
            ("cave", true, 0.75, 0.40, 4, false, true, 140.0),
            ("village", true, 0.35, 0.40, 4, true, true, 140.0),
            ("home", true, 0.35, 0.40, 4, true, true, 140.0),
            ("hospital", true, 0.35, 0.40, 4, true, true, 140.0),
            ("office", true, 0.35, 0.40, 4, true, true, 140.0),
            ("factory", true, 0.35, 0.40, 4, true, true, 140.0),
            ("arena", false, 0.35, 0.22, 2, false, false, 140.0),
            ("squeeze", false, 0.35, 0.22, 2, false, false, 140.0),
            ("drain", false, 0.35, 0.22, 2, false, false, 140.0),
            ("playground", false, 0.35, 0.22, 4, false, false, 140.0),
            ("range", false, 0.35, 0.22, 4, false, false, 140.0),
            ("goofloor", false, 0.35, 0.22, 4, false, false, 140.0),
            ("goonursery", false, 0.35, 0.22, 4, false, false, 140.0),
            ("goopair", false, 0.35, 0.22, 4, false, false, 140.0),
            // unknown names (incl. the pre-normalization "grid-walker" alias,
            // which from_env rewrites to "grid" before any lookup)
            ("nonesuch", false, 0.35, 0.22, 4, false, false, 140.0),
        ];
        for &(name, greybox, sdither_th, exposure, pixel, minimap, roi, speed) in legacy {
            let l = scene_look(name);
            assert_eq!(l.greybox, greybox, "{name} greybox");
            assert_eq!(l.sdither_th, sdither_th, "{name} sdither_th");
            assert_eq!(l.exposure, exposure, "{name} exposure");
            assert_eq!(l.pixel, pixel, "{name} pixel");
            assert_eq!(l.minimap, minimap, "{name} minimap");
            assert_eq!(l.roi, roi, "{name} roi");
            assert_eq!(l.player_speed, speed, "{name} player_speed");
        }
    }

    /// The ESC menu prints an env string of dialed-in looks; re-feeding it must
    /// reproduce the same resolved values. The menu reads Renderer fields (not
    /// Config), but every menu key is seeded by a Config field, so this pins
    /// that the env names the split exposes still parse 1:1 to the same slots.
    /// Env access is process-global, so this runs serially within one test.
    #[test]
    fn env_string_round_trip() {
        // A representative dialed-in look spanning all three groups.
        let pairs = [
            ("SCENE", "house"),
            ("EXPOSURE", "0.37"),
            ("AO", "0.65"),
            ("AO_R", "1.20"),
            ("AO_N", "12"),
            ("SDITHER", "0.80"),
            ("SDITHER_N", "20"),
            ("SDITHER_TH", "0.40"),
            ("DITHER", "4"),
            ("LIGHTS", "0"),
            ("LIGHT_ANIM", "0"),
            ("FLASH", "1"),
            ("FLASH_POWER", "1.50"),
            ("FLASH_CONE", "18"),
        ];
        for (k, v) in pairs {
            std::env::set_var(k, v);
        }
        let cfg = Config::from_env();
        assert_eq!(cfg.scene, "house");
        assert_eq!(cfg.render.exposure, 0.37);
        assert_eq!(cfg.render.ao, 0.65);
        assert_eq!(cfg.render.ao_r, 1.20);
        assert_eq!(cfg.render.ao_n, 12);
        assert_eq!(cfg.render.style.sdither, 0.80);
        assert_eq!(cfg.render.style.sdither_n, 20.0);
        assert_eq!(cfg.render.style.sdither_th, 0.40);
        assert_eq!(cfg.render.style.dither, 4.0);
        assert_eq!(cfg.game.lights, 0.0);
        assert!(!cfg.game.light_anim);
        assert!(cfg.game.flash);
        assert_eq!(cfg.game.flash_power, 1.50);
        assert_eq!(cfg.game.flash_cone, 18.0);
        for (k, _) in pairs {
            std::env::remove_var(k);
        }
    }
}
