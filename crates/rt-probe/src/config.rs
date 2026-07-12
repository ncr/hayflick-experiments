//! All runtime configuration, resolved from the environment ONCE at startup.
//!
//! Every tuning knob flows through this struct, so the inventory of tuning
//! surface is visible here and the ESC menu / env-string round-trip (`viewer`)
//! has a single source of truth. One deliberate exception reads `std::env`
//! directly: `probe_cache::dir` (PROBE_CACHE) — a dev-machine cache location,
//! not a look/sim knob, and never part of the round-trip. (rt-viewer keeps a
//! few shell-only reads of its own: AUDIO, LOOK.)
//!
//! `Config` is split along the three natural axes the knobs fall into:
//! - [`RenderCfg`] — renderer look + GI/probe bake knobs (no game, no window).
//! - [`GameCfg`]   — game / input / camera-seeding knobs (sim state at boot).
//! - [`HarnessCfg`] — window size + capture/movie/clip harness knobs.
//!
//! `Config::from_env` resolves all three; `scene` is the shared identity field
//! both the renderer's scene builders and the game adapter read, so it lives on
//! the top-level `Config` rather than in any one group.

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
    pub sat: f32,          // SAT: saturation multiplier post-grade (1 = neutral, >1 punchier)
    pub contrast: f32,     // CONTRAST: contrast around 0.5 post-grade (1 = neutral)
    pub lumaq: f32,        // LUMAQ: quantize luminance to N hard levels, hue kept (0 = off)
    pub analog: f32,       // ANALOG: analog-signal luma noise strength (0 = off)
    pub analog_chroma: f32, // ANALOG_CHROMA: chroma noise strength (defaults to ANALOG)
    pub analog_tear: f32,  // ANALOG_TEAR: horizontal scanline-tear strength (defaults to ANALOG)
    pub crt_mask: f32,     // CRT_MASK: RGB phosphor triad + scanline on the FINAL image (0 = off)
}

impl StyleCfg {
    fn from_env() -> StyleCfg {
        // Shadow dither ON by default was the old base look; the joyful reset
        // (docs/VISION.md) starts from CLEAN — dither/grain/vignette all off,
        // and the Faza-1 look presets opt into texture deliberately.
        let mut st = StyleCfg { grade: 0.0, poster: 0.0, dither: 1.0, dither_amt: -1.0, palette: 0.0, pal_p: -1.0, vignette: 0.0, outline: 0.0, grain: 0.0, grain_sz: 1.0, grain_static: 0.0, bloom: 0.0, bloom_th: 1.0, sdither: 0.0, sdither_n: 16.0, sdither_th: 0.75, sat: 1.4, contrast: 1.12, lumaq: 0.0, analog: 0.0, analog_chroma: -1.0, analog_tear: -1.0, crt_mask: 0.0 };
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
/// feeds the shade/probe pipelines and the post stack.
pub struct RenderCfg {
    pub emit: f32,                 // EMIT: master scale on authored practical emission
    pub sun: Option<f32>,          // SUN/SKY/FOG/FOG_H override the scene's lighting env
    pub sky: Option<f32>,
    pub fog: Option<f32>,
    pub fog_h: Option<f32>,
    pub pixel: u32,                // PIXEL: integer render scale at zoom=1
    pub exposure: f32,             // EXPOSURE
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

/// Game / input / camera-seeding knobs. These seed SIM/camera state at boot
/// (zoom, pan, look-at target, settled yaw quarter) plus the deterministic
/// command-replay prefix and the reveal knobs.
pub struct GameCfg {
    pub lights: f32,               // LIGHTS: lamp master dim 0..1
    pub light_anim: bool,          // LIGHT_ANIM=0 freezes light animation
    pub zoom: f32,                 // ZOOM (whole steps 1-4)
    pub yaw_q: u32,                // YAW_Q: start quarter-turn
    pub pan: (f32, f32),           // PAN_X/PAN_Y: initial crop offset (low px)
    pub target: (Option<f32>, Option<f32>), // TARGET_X/TARGET_Z: camera look-at override
    pub player_speed: Option<f32>, // PLAYER_SPEED (px/s)
    pub cmds: Option<String>,      // CMDS=trace.txt: deterministic command-replay prefix
    pub cmds_ticks: Option<u64>,   // CMDS_TICKS: prefix length (default: last stamp + 1)
    pub seed: u64,                 // SEED: the run/level seed (town layout, population)
    pub roi: bool,                 // ROI: dithered player-anchored see-through reveal — the sole wall occlusion on player+wall scenes
    pub roi_radius: f32,           // ROI_R: reveal-disc radius in low-res px
    pub roi_falloff: f32,          // ROI_FALLOFF: soft dither edge width in low-res px
    pub roi_ghost: f32,            // ROI_GHOST: max reveal coverage at disc centre (<1 leaves a faint stipple ghost of the wall)
    pub roi_contour: bool,         // ROI_XRAY: default on — adds faint wall-silhouette line-art over the ghost stipple; ROI_XRAY=ghost turns it off (plain stipple)
    pub cut: Option<f32>,          // CUT: FLOORCUT plane world-Y — everything at/above it dissolves on the primary ray (multi-floor dollhouse reveal); unset = game-driven
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
    /// SCENE: `town` is the only scene (the movement/look testbed —
    /// docs/VISION.md Faza 0). The field stays so future scenes (the Faza-2
    /// movement gym) slot back in without plumbing changes.
    pub scene: String,
    pub render: RenderCfg,
    pub game: GameCfg,
    pub harness: HarnessCfg,
}

impl Config {
    pub fn from_env() -> Config {
        let scene = s("SCENE").unwrap_or_else(|| "town".into());
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
            render: RenderCfg {
                emit: f("EMIT", 1.7),
                sun: fo("SUN"),
                sky: fo("SKY"),
                fog: fo("FOG"),
                fog_h: fo("FOG_H"),
                pixel: (i("PIXEL", 2) as u32).max(1),
                exposure: f("EXPOSURE", 0.40),
                probe_spacing: f("PROBE_SPACING", 0.5).max(0.05),
                probe_rays: i("PROBE_RAYS", 2048),
                ao: f("AO", 0.55),
                ao_r: f("AO_R", 0.8),
                ao_n: i("AO_N", 8),
                spec: f("SPEC", 0.0), // matte floors/walls — specular sheen turned off (2026-06-21)
                gloss: f("GLOSS", 0.85).clamp(0.0, 1.0),
                bump: f("BUMP", 0.8),
                bump_scale: f("BUMP_SCALE", 7.0).max(0.01),
                gi: f("GI", 0.42),
                matq: f("MATQ", 0.0),
                ao_dither: f("AO_DITHER", 0.0),
                refl: f("REFL", 0.0),
                refl_px: i("REFL_PX", 3).max(1),
                debug,
                style: StyleCfg::from_env(),
            },
            game: GameCfg {
                lights: f("LIGHTS", 1.0).clamp(0.0, 1.0),
                light_anim: b("LIGHT_ANIM", true),
                zoom: f("ZOOM", 1.0),
                yaw_q: (i("YAW_Q", 0) as u32) & 3,
                pan: (f("PAN_X", 0.0), f("PAN_Y", 0.0)),
                target: (fo("TARGET_X"), fo("TARGET_Z")),
                player_speed: fo("PLAYER_SPEED"),
                cmds: s("CMDS"),
                cmds_ticks: s("CMDS_TICKS").and_then(|v| v.parse().ok()),
                seed: s("SEED").and_then(|v| v.parse().ok()).unwrap_or(1),
                roi: b("ROI", true),
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

    /// Default player walk speed in px/s.
    pub fn default_player_speed(&self) -> f32 {
        140.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The ESC menu prints an env string of dialed-in looks; re-feeding it must
    /// reproduce the same resolved values. The menu reads Renderer fields (not
    /// Config), but every menu key is seeded by a Config field, so this pins
    /// that the env names still parse 1:1 to the same slots.
    /// Env access is process-global, so ALL env-reading assertions run
    /// serially within this ONE test (a second #[test] would race the
    /// set_var/remove_var below under the parallel test runner).
    #[test]
    fn env_string_round_trip() {
        // the joyful reset's clean base: dither texture OFF by default
        let cfg = Config::from_env();
        assert_eq!(cfg.scene, "town");
        assert_eq!(cfg.render.style.sdither, 0.0, "shadow dither starts OFF");
        assert_eq!(cfg.render.style.grain, 0.0);
        assert_eq!(cfg.render.style.vignette, 0.0);
        assert_eq!(cfg.render.pixel, 2);
        assert!(cfg.game.roi);
        let pairs = [
            ("SCENE", "town"),
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
        ];
        for (k, v) in pairs {
            std::env::set_var(k, v);
        }
        let cfg = Config::from_env();
        assert_eq!(cfg.scene, "town");
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
        for (k, _) in pairs {
            std::env::remove_var(k);
        }
    }
}
