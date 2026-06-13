//! All runtime configuration, resolved from the environment ONCE at startup.
//!
//! Nothing else in the crate reads `std::env` — every knob flows through this
//! struct, so the full inventory of tuning surface is visible here, and the
//! ESC menu / env-string round-trip (`viewer`) has a single source of truth.

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
}

impl StyleCfg {
    fn from_env() -> StyleCfg {
        // shadow dither ON by default (user-tuned 2026-06-10: strength 1, 16
        // luma bands, fade-in below luma 0.35) — the subtle retro texture in
        // shadow gradients is part of the base look. SDITHER=0 for fully clean.
        let mut st = StyleCfg { grade: 0.0, poster: 0.0, dither: 1.0, dither_amt: -1.0, palette: 0.0, pal_p: -1.0, vignette: 0.0, outline: 0.0, grain: 0.0, grain_sz: 1.0, grain_static: 0.0, bloom: 0.0, bloom_th: 1.0, sdither: 1.0, sdither_n: 16.0, sdither_th: 0.35 };
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

pub struct Config {
    // ---- scene ----
    pub scene: String,             // SCENE: house (default) | lab | grid
    pub emit: f32,                 // EMIT: master scale on authored practical emission
    pub sun: Option<f32>,          // SUN/SKY/FOG/FOG_H override the scene's lighting env
    pub sky: Option<f32>,
    pub fog: Option<f32>,
    pub fog_h: Option<f32>,
    pub pet_dump: bool,            // PET_DUMP: dump the PET prop's triangles as CSV

    // ---- renderer ----
    pub pixel: u32,                // PIXEL: integer render scale at zoom=1
    pub exposure: f32,             // EXPOSURE (default depends on scene)
    pub probe_spacing: f32,        // PROBE_SPACING: GI probe grid spacing (wu)
    pub probe_rays: i32,           // PROBE_RAYS: bake rays per probe per bank
    pub ao: f32,                   // AO: RT-AO strength
    pub ao_r: f32,                 // AO_R: RT-AO radius (wu)
    pub ao_n: i32,                 // AO_N: RT-AO ray count
    pub debug: i32,                // DEBUG_ALBEDO=1 | DEBUG_GI=2 | DEBUG_DIRECT=3 | DEBUG_AO=4
    pub style: StyleCfg,

    // ---- lights ----
    pub lights: f32,               // LIGHTS: room-lights master dim 0..1
    pub light_anim: bool,          // LIGHT_ANIM=0 freezes practical flicker
    pub flash: bool,               // FLASH: flashlight on at boot
    pub flash_power: f32,          // FLASH_POWER
    pub flash_cone: f32,           // FLASH_CONE: outer half-angle, degrees

    // ---- view / player seeding ----
    pub zoom: f32,                 // ZOOM (whole steps 1-4)
    pub yaw_q: u32,                // YAW_Q: start quarter-turn
    pub mask_q: Option<u32>,       // MASK_Q: decouple dollhouse masks (diagnostic)
    pub pan: (f32, f32),           // PAN_X/PAN_Y: initial crop offset (low px)
    pub target: (Option<f32>, Option<f32>), // TARGET_X/TARGET_Z: camera look-at override
    pub player_off: (f32, f32),    // PLAYER_X/PLAYER_Z: player offset from spawn
    pub player_speed: Option<f32>, // PLAYER_SPEED (px/s; default depends on scene)
    pub window: Option<(u32, u32)>, // WINDOW=WxH: requested inner size (goldens)

    // ---- capture / harness ----
    pub shot: Option<String>,      // SHOT=path.png: capture one frame, exit
    pub shot_delay: f32,           // SHOT_DELAY: seconds before the capture
    pub cmds: Option<String>,      // CMDS=trace.txt: deterministic command-replay prefix
    pub cmds_ticks: Option<u64>,   // CMDS_TICKS: prefix length (default: last stamp + 1)
    pub rotate_at: Option<f32>,    // ROTATE_AT=secs: fire one smooth e-turn
    pub dump: Option<String>,      // DUMP=dir: record presented frames as PNGs
    pub dump_at: Option<f32>,      // DUMP_AT=secs: start the dump on a timer
    pub dump_n: i32,               // DUMP_N: frames per dump
    pub movie: Option<String>,     // MOVIE=dir: run the scripted camera tour
    pub detail: (f32, f32),        // DETAIL_X/DETAIL_Z: movie's zoom-in target
    pub frames_limit: Option<u32>, // FRAMES=N: exit after N frames, log avg time
    pub timing: bool,              // TIMING=1: per-frame phase breakdown
    pub clip_fps: u32,             // CLIP_FPS
    pub clip_max_s: f32,           // CLIP_MAX_S
    pub clip_mp4_scale: u32,       // CLIP_MP4_SCALE
    pub clip_gif_scale: u32,       // CLIP_GIF_SCALE
}

impl Config {
    pub fn from_env() -> Config {
        let scene = s("SCENE").unwrap_or_else(|| "house".into());
        let scene = if scene == "grid-walker" { "grid".to_string() } else { scene };
        // house is lamp-lit (no sun) — it needs more exposure than the daylight
        // scenes. Retuned 0.35 -> 0.40 on 2026-06-12: base-colour textures now
        // sample as sRGB (hardware-linearized, darker albedo + darker bounce),
        // and the bump restores the previous overall brightness.
        let default_exposure = if scene == "house" || scene == "game" { 0.40 } else { 0.22 };
        // grid: the web knob default (80 px/s); elsewhere: player walk speed
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
        Config {
            emit: f("EMIT", 1.0),
            sun: fo("SUN"),
            sky: fo("SKY"),
            fog: fo("FOG"),
            fog_h: fo("FOG_H"),
            pet_dump: b("PET_DUMP", false),
            pixel: (i("PIXEL", 4) as u32).max(1),
            exposure: f("EXPOSURE", default_exposure),
            probe_spacing: f("PROBE_SPACING", 0.5).max(0.05),
            probe_rays: i("PROBE_RAYS", 2048),
            ao: f("AO", 1.0),
            ao_r: f("AO_R", 0.8),
            ao_n: i("AO_N", 8),
            debug,
            style: StyleCfg::from_env(),
            lights: f("LIGHTS", 1.0).clamp(0.0, 1.0),
            light_anim: b("LIGHT_ANIM", true),
            flash: b("FLASH", false),
            flash_power: f("FLASH_POWER", 1.0),
            flash_cone: f("FLASH_CONE", 22.0),
            zoom: f("ZOOM", 1.0),
            yaw_q: (i("YAW_Q", 0) as u32) & 3,
            mask_q: fo("MASK_Q").map(|v| (v as u32) & 3),
            pan: (f("PAN_X", 0.0), f("PAN_Y", 0.0)),
            target: (fo("TARGET_X"), fo("TARGET_Z")),
            player_off: (f("PLAYER_X", 0.0), f("PLAYER_Z", 0.0)),
            player_speed: fo("PLAYER_SPEED"),
            window,
            shot: s("SHOT"),
            shot_delay: f("SHOT_DELAY", 0.0),
            cmds: s("CMDS"),
            cmds_ticks: s("CMDS_TICKS").and_then(|v| v.parse().ok()),
            rotate_at: fo("ROTATE_AT"),
            dump: s("DUMP"),
            dump_at: fo("DUMP_AT"),
            dump_n: i("DUMP_N", 120),
            movie: s("MOVIE"),
            detail: (f("DETAIL_X", 11.5), f("DETAIL_Z", 2.0)),
            frames_limit: s("FRAMES").and_then(|v| v.parse().ok()),
            timing: b("TIMING", false),
            clip_fps: (i("CLIP_FPS", 50) as u32).clamp(2, 120),
            clip_max_s: f("CLIP_MAX_S", 60.0),
            clip_mp4_scale: (i("CLIP_MP4_SCALE", 4) as u32).clamp(1, 8),
            clip_gif_scale: (i("CLIP_GIF_SCALE", 1) as u32).clamp(1, 8),
            scene,
        }
    }

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

    pub fn default_player_speed(&self) -> f32 {
        if self.scene == "grid" { 80.0 } else { 140.0 }
    }
}
