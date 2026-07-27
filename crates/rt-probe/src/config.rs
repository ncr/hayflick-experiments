//! All runtime configuration, resolved from the environment ONCE at startup.
//!
//! Every tuning knob flows through this struct, so the inventory of tuning
//! surface is visible here and the ESC menu / env-string round-trip (`viewer`)
//! has a single source of truth. One deliberate exception reads `std::env`
//! directly: `probe_cache::dir` (PROBE_CACHE) — a dev-machine cache location,
//! not a look/sim knob, and never part of the round-trip. (rt-viewer keeps a
//! few shell-only reads of its own: AUDIO, LOOK, and the WEAR family's harness
//! surface — STORY=weather,settlement,cover_loss (the three causes),
//! SHAPE=grain,relief[,pattern[,p1,p2,p3]], SPREAD=<0..1> (the per-run story
//! spread), SPALL=<0..1> (the cover-loss cause on its own, kept because every
//! A/B recipe on record uses it) with its SPALL_LAYER=1|2|3 bisect (1 = crater
//! only, 2 = steel only, 3 = both), SCRUB=<0..1> (the variant dial on every
//! run), BAND=lo,hi (the damage band's normalized edges on every run),
//! HOLE=u,y[,caliber] (ONE placed shell hit on every run — named HOLE because
//! SHELL is the login shell in every Unix environment),
//! CRACK_SEL= to preselect a wall,
//! WEAR_EDIT=weather,settlement,cover_loss[,run] to replay a panel drag +
//! release, and WEAR_FILE=<path> to override a level's wear file for load AND
//! save — see `crate::crack` / `crate::crack_geom` / `crate::wear` /
//! `crate::wear_file` on the viewer side. WEAR= is gone: all four effect-word
//! lanes are derived now, each driven through its own dial.)
//!
//! `Config` is split along the three natural axes the knobs fall into:
//! - [`RenderCfg`] — renderer look + GI/probe bake knobs (no game, no window).
//! - [`GameCfg`]   — game / input / camera-seeding knobs (sim state at boot).
//! - [`HarnessCfg`] — window size + capture/movie/clip harness knobs.
//!
//! `Config::from_env` resolves all three. There is ONE scene (the gym) and
//! no level seed — the level is hand-authored (docs/VISION.md, 2026-07-12).

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

/// Stylized post-stack knobs (tonemap.comp). Since Faza 1b the BASE values
/// are look data (`Look.style` in rt-viewer, starting from
/// [`StyleCfg::CLEAN`]); the individual env vars override on top
/// ([`StyleCfg::env_over`]) as the agent/harness interface. The old `STYLE=`
/// preset bundles (fallout/noir/crt/…) were the pre-reset dirt directions —
/// deleted with them (docs/VISION.md).
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
    /// AA_SOFT: CONTOUR SOFTEN — how far a CONTOUR texel's radiance is pulled
    /// toward its 4-neighbour mean (0 = off). Contour-gated by the same pass
    /// the coverage AA uses, so it takes the contrast off narrow cracks and
    /// silhouettes without touching a flat interior. Needs `aa`'s gate pass:
    /// the backends dispatch it when either knob is live.
    pub aa_soft: f32,
}

impl StyleCfg {
    /// The joyful-reset clean base (docs/VISION.md): no grade, no grain, no
    /// vignette, no palette quantization; bayer8 as the ROI/reveal dither;
    /// a gentle sat/contrast lift. Looks author their post stack from here
    /// (`StyleCfg { sat: 1.2, ..StyleCfg::CLEAN }`).
    pub const CLEAN: StyleCfg = StyleCfg {
        grade: 0.0,
        poster: 0.0,
        dither: 1.0,
        dither_amt: -1.0,
        palette: 0.0,
        pal_p: -1.0,
        vignette: 0.0,
        outline: 0.0,
        grain: 0.0,
        grain_sz: 1.0,
        grain_static: 0.0,
        bloom: 0.0,
        bloom_th: 1.0,
        sdither: 0.0,
        sdither_n: 16.0,
        sdither_th: 0.75,
        sat: 1.4,
        contrast: 1.12,
        lumaq: 0.0,
        analog: 0.0,
        analog_chroma: -1.0,
        analog_tear: -1.0,
        crt_mask: 0.0,
        aa_soft: 0.35,
    };

    /// Apply the individual env-var overrides on top of `self` (the look's
    /// authored post stack), then resolve the `<0 = auto` fields. Env stays
    /// the agent/harness interface; the owner picks looks in the ESC menu.
    /// Env is constant for the process, so re-running this on a runtime look
    /// switch is deterministic.
    pub fn env_over(mut self) -> StyleCfg {
        let st = &mut self;
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
        st.aa_soft = f("AA_SOFT", st.aa_soft);
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
        self
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
    pub exposure: Option<f32>,     // EXPOSURE: overrides the look's authored exposure (Faza 1b)
    pub probe_spacing: f32,        // PROBE_SPACING: GI probe grid spacing (wu)
    pub probe_rays: i32,           // PROBE_RAYS: bake rays per probe per bank
    /// `PROBE_LOCAL` — may a scene rebuild that changed only a few AABBs carry
    /// the baked probe banks over and refresh just their neighbourhoods
    /// (`ProbeRefresh::Local`, the crack-lab knob release)? On by default;
    /// `PROBE_LOCAL=0` forces the full rebake, which is the A/B that proves the
    /// local refresh leaves no stale probe behind.
    pub probe_local: bool,
    pub ao: f32,                   // AO: RT-AO strength
    pub ao_r: f32,                 // AO_R: RT-AO radius (wu)
    pub ao_n: i32,                 // AO_N: RT-AO ray count
    // surface-response knobs: look data since Faza 1b (Look.spec/…); the env
    // vars are Option overrides on top, like EXPOSURE
    pub spec: Option<f32>,         // SPEC: specular highlight strength (0 = off, matte)
    pub gloss: Option<f32>,        // GLOSS: 0..1 remap of effective roughness toward polished
    pub bump: Option<f32>,         // BUMP: procedural surface-detail normal strength (0 = off)
    pub bump_scale: Option<f32>,   // BUMP_SCALE: surface-detail noise frequency (wu^-1)
    pub gi: Option<f32>,           // GI: ambient probe-irradiance scale (1 = neutral, <1 = moodier)
    pub matq: f32,                 // MATQ: posterize materials — albedo/roughness snapped to N levels (0 = off)
    pub ao_dither: f32,            // AO_DITHER: RT-AO gradient → binary Bayer stipple (0 = off)
    pub refl: f32,                 // REFL: pixelated mirror-reflection composite strength (0 = off)
    pub refl_px: i32,
    /// `AA` — CONTOUR COVERAGE strength (owner 2026-07-25): the weight each of
    /// the four fixed sub-pixel coverage rays carries against the centre
    /// sample, on CONTOUR texels only (see shade.comp's aaGate). `None` = take
    /// the look's authored value; 0 = one sample per texel, byte-identical to
    /// the pre-AA image; 1 = the unbiased 5-sample box.
    pub aa: Option<f32>,
    /// `AA_SCOPE` — where the contour AA and the softening apply: 0 = every
    /// surface, 1 = CRACKED piers only (the default — the greybox keeps its
    /// hard pixel edges), 2 = the PICKED pier only (the owner's per-wall A/B).
    pub aa_scope: i32,
    /// `AA_CHUNKY` — does CHUNKY generator detail (whole blocks: the wall-smash
    /// rubble) take the contour AA as well? Off by default; thin detail (crack
    /// grooves, plates) is unaffected. See the AA policy in CLAUDE.md.
    pub aa_chunky: bool,              // REFL_PX: reflection block size in low-res px (the pixelation)
    pub debug: i32,                // DEBUG_ALBEDO=1 | DEBUG_GI=2 | DEBUG_DIRECT=3 | DEBUG_AO=4 | DEBUG_AA=5
    // The post stack (StyleCfg) is NOT here since Faza 1b: its base is look
    // data (rt-viewer look.rs); the Viewer resolves `look.style.env_over()`.
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
    pub cmds: Option<String>,      // CMDS=trace.txt: deterministic command-replay prefix
    pub cmds_ticks: Option<u64>,   // CMDS_TICKS: prefix length (default: last stamp + 1)
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
    /// VSYNC (default ON): present with FIFO, pacing the loop to the monitor.
    /// `VSYNC=0` restores MAILBOX (render-and-discard) for latency experiments.
    /// FIFO is the default because uncapped MAILBOX rendered ~600 fps of
    /// invisible frames — free in a small window, but a 5120x2160 fullscreen
    /// surface saturated the GPU and STARVED the compositor, whose SOFTWARE
    /// cursor (Hyprland + NVIDIA) then lagged system-wide (owner, 2026-07-27).
    pub vsync: bool,
    pub shot: Option<String>,      // SHOT=path.png: capture one frame, exit
    /// LOOK_SWITCH=<name>: after boot, apply this look through the RUNTIME
    /// switch path (backend rebuild_scene) before any capture — a SHOT then
    /// must be byte-identical to booting in that look directly. The harness
    /// verification for the ESC menu's look row (Faza 1b).
    pub look_switch: Option<String>,
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
    pub render: RenderCfg,
    pub game: GameCfg,
    pub harness: HarnessCfg,
}

impl Config {
    pub fn from_env() -> Config {
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
        } else if b("DEBUG_AA", false) {
            5
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
                exposure: fo("EXPOSURE"),
                probe_spacing: f("PROBE_SPACING", 0.5).max(0.05),
                probe_rays: i("PROBE_RAYS", 2048),
                probe_local: b("PROBE_LOCAL", true),
                ao: f("AO", 0.55),
                ao_r: f("AO_R", 0.8),
                ao_n: i("AO_N", 8),
                spec: fo("SPEC"),
                gloss: fo("GLOSS").map(|v| v.clamp(0.0, 1.0)),
                bump: fo("BUMP"),
                bump_scale: fo("BUMP_SCALE").map(|v| v.max(0.01)),
                gi: fo("GI"),
                matq: f("MATQ", 0.0),
                ao_dither: f("AO_DITHER", 0.0),
                refl: f("REFL", 0.0),
                aa: fo("AA"),
                aa_scope: i("AA_SCOPE", 1),
                aa_chunky: b("AA_CHUNKY", false),
                refl_px: i("REFL_PX", 3).max(1),
                debug,
            },
            game: GameCfg {
                lights: f("LIGHTS", 1.0).clamp(0.0, 1.0),
                light_anim: b("LIGHT_ANIM", true),
                zoom: f("ZOOM", 1.0),
                yaw_q: (i("YAW_Q", 0) as u32) & 3,
                pan: (f("PAN_X", 0.0), f("PAN_Y", 0.0)),
                target: (fo("TARGET_X"), fo("TARGET_Z")),
                cmds: s("CMDS"),
                cmds_ticks: s("CMDS_TICKS").and_then(|v| v.parse().ok()),
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
                vsync: b("VSYNC", true),
                shot: s("SHOT"),
                look_switch: s("LOOK_SWITCH"),
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
        }
    }

    /// The scene's lighting env with the SUN/SKY/FOG/FOG_H overrides applied.
    /// (Forwards to [`RenderCfg::lighting_env`].)
    pub fn lighting_env(&self, scene_lighting: [f32; 4]) -> [f32; 4] {
        self.render.lighting_env(scene_lighting)
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
        let st = StyleCfg::CLEAN.env_over();
        assert_eq!(st.sdither, 0.0, "shadow dither starts OFF");
        assert_eq!(st.grain, 0.0);
        assert_eq!(st.vignette, 0.0);
        assert_eq!(cfg.render.pixel, 2);
        assert_eq!(cfg.render.exposure, None, "EXPOSURE unset = the look's authored value");
        assert!(cfg.game.roi);
        let pairs = [
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
        assert_eq!(cfg.render.exposure, Some(0.37));
        assert_eq!(cfg.render.ao, 0.65);
        assert_eq!(cfg.render.ao_r, 1.20);
        assert_eq!(cfg.render.ao_n, 12);
        // env overrides land ON TOP of a look-authored style (Faza 1b)
        let st = StyleCfg { sdither_th: 0.6, ..StyleCfg::CLEAN }.env_over();
        assert_eq!(st.sdither, 0.80);
        assert_eq!(st.sdither_n, 20.0);
        assert_eq!(st.sdither_th, 0.40, "env wins over the look's authored value");
        assert_eq!(st.dither, 4.0);
        assert_eq!(cfg.game.lights, 0.0);
        assert!(!cfg.game.light_anim);
        for (k, _) in pairs {
            std::env::remove_var(k);
        }
        // ...and with env clear again, the look's authored value survives
        let st = StyleCfg { sdither_th: 0.6, ..StyleCfg::CLEAN }.env_over();
        assert_eq!(st.sdither_th, 0.6);
    }
}
