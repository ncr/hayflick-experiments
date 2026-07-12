//! Capture + headless-harness tooling: SHOT one-frame captures, DUMP frame
//! sequences, in-viewer clip recording (mp4 + gif), and the scripted MOVIE
//! camera tour. All capture paths read the GPU `out` image through the backend
//! (`capture_png` / `readback_out_subsampled` / the deferred clip target) —
//! the exact presented pixels (the UI overlay only ever touches the swapchain
//! image). PNG/mp4/gif encoding here is pure CPU and backend-agnostic.

use crate::viewer::Viewer;
use glam::{Vec2, Vec3};
use rt_probe::Config;

/// Mutable headless-harness state (seeded from `Config`, consumed as the
/// triggers fire): SHOT / ROTATE_AT / DUMP / DUMP_AT. Synthetic INPUT lives
/// in CMDS (a deterministic command-trace prefix, run before the first
/// frame — see `GameLoop::run_cmds`), not here.
pub struct Harness {
    pub shot: Option<String>,
    pub shot_delay: f32,
    pub rotate_at: Option<f32>,
    pub dump_dir: Option<String>,
    pub dump_at: Option<f32>,
    pub dump_n: i32,
    pub dump_left: i32,
    pub dump_idx: u32,
    pub dump_frames: Vec<(u32, u32, Vec<u8>)>,
    /// DEMO mode: a fully-headless trace-driven gameplay frame dump. `Some`
    /// while a DEMO is active; `dir` is the PNG output directory, `ticks` the
    /// total ticks to play, `done` how many have rendered so far.
    pub demo: Option<Demo>,
}

/// DEMO=trace.txt headless capture state. Each rendered frame advances exactly
/// one sim tick (the trace's commands drain per tick) and writes the readback
/// `out` image to dir/d_NNNNN.png — a per-tick dump of real gameplay under the
/// live follow-cam. Window-less like SHOT; the wall clock never ticks the sim.
pub struct Demo {
    pub dir: String,
    pub ticks: u64,
    pub done: u64,
}

impl Harness {
    pub fn from_cfg(cfg: &Config) -> Harness {
        Harness {
            shot: cfg.harness.shot.clone(),
            shot_delay: cfg.harness.shot_delay,
            rotate_at: cfg.harness.rotate_at,
            dump_dir: cfg.harness.dump.clone(),
            dump_at: cfg.harness.dump_at,
            dump_n: cfg.harness.dump_n,
            dump_left: 0,
            dump_idx: 0,
            dump_frames: Vec::new(),
            demo: None, // armed in Viewer::new once the GameLoop trace is loaded
        }
    }
}

/// In-viewer clip recording ('r' or the menu row): the presented frame is
/// grabbed subsampled to exact GAME pixels (same path as DUMP) at a fixed
/// wall-clock rate, buffered in RAM, and encoded on stop through ffmpeg into
/// BOTH deliverables at once — an MP4 (x264, NEAREST integer upscale) and a
/// palette GIF at half rate. Capturing at game resolution is what keeps the
/// files small: a typical 316x250 clip is ~20 KB/s as MP4.
pub struct Rec {
    pub w: u32,
    pub h: u32,
    pub fps: u32,
    pub next_due: f32,     // start_time-relative capture clock (secs)
    pub max_frames: usize, // auto-stop bound (CLIP_MAX_S) — RAM, not storage
    // wall-clock stamps of the first/last collected frame: the clip encodes
    // at the MEASURED rate, so playback duration matches reality even when
    // the render loop can't hold the target capture rate
    pub t_first: f32,
    pub t_last: f32,
    pub frames: Vec<Vec<u8>>,
}

/// Scripted camera move for MOVIE mode. Each command drives the SAME code
/// path the matching interactive input uses (rotate / zoom_step / pan_target),
/// so the movie shows real app behaviour, not a synthetic camera.
pub enum MovieCmd {
    /// Capture N frames at the current camera.
    Hold(u32),
    /// Fluid quarter-turn: sweep the yaw 90°·dq over N captured frames with
    /// smoothstep easing, then land through the real `rotate` path.
    Orbit(i32, u32),
    /// One integer zoom step anchored at the window centre.
    Zoom(i32),
    /// Glide the look-at target to world (x, z) over N captured frames.
    PanTo(f32, f32, u32),
}

/// MOVIE=dir: run the scripted tour headlessly, dumping every frame as
/// dir/m_NNNNN.png (the exact presented image), then exit. Assemble with
/// ffmpeg at ~12 fps.
pub struct Movie {
    pub dir: String,
    pub cmds: Vec<MovieCmd>,
    pub seg: usize,
    pub seg_done: u32, // frames captured (Hold) / pan steps taken (PanTo) in this segment
    pub out_idx: u32,
}

impl Movie {
    /// The showcase tour: establish the canonical view, a fluid full
    /// e-revolution with short holds at each iso yaw, then glide to a detail
    /// (cfg.detail, default the lab mainframe) and zoom in step by step.
    pub fn new(dir: String, cfg: &Config) -> Movie {
        use MovieCmd::*;
        let (dx, dz) = cfg.harness.detail;
        let cmds = vec![
            Hold(24),
            Orbit(1, 18),
            Hold(10),
            Orbit(1, 18),
            Hold(10),
            Orbit(1, 18),
            Hold(10),
            Orbit(1, 18),
            Hold(16),
            PanTo(dx, dz, 24),
            Hold(8),
            Zoom(1),
            Hold(10),
            Zoom(1),
            Hold(10),
            Zoom(1),
            Hold(36),
        ];
        Movie { dir, cmds, seg: 0, seg_done: 0, out_idx: 0 }
    }
}

/// Encode buffered RGBA game-pixel frames into clips/clip_NNNN.{mp4,gif}.
/// Runs on a worker thread (joined at exit) so stopping a recording never
/// hitches the render loop.
pub fn encode_clip(frames: Vec<Vec<u8>>, w: u32, h: u32, fps: f64, mp4_scale: u32, gif_scale: u32) {
    use std::io::Write;
    use std::process::{Command, Stdio};
    if frames.len() < 2 {
        println!("clip: too short, discarded");
        return;
    }
    if std::fs::create_dir_all("clips").is_err() {
        println!("clip: cannot create clips/ — discarded");
        return;
    }
    let mut idx = 1;
    let (mp4, gif) = loop {
        let m = format!("clips/clip_{idx:04}.mp4");
        let g = format!("clips/clip_{idx:04}.gif");
        if !std::path::Path::new(&m).exists() && !std::path::Path::new(&g).exists() {
            break (m, g);
        }
        idx += 1;
    };
    // gif defaults to 1x: it has no motion compensation, so a camera pan is a
    // full redraw per frame — size scales with raw area. 1x game pixels keeps
    // a worst-case panning clip ~0.4 MB/s; bump CLIP_GIF_SCALE for crisp 2x.
    let gif_fps = (fps / 2.0).max(1.0);
    // (filter, extra output args, path) per deliverable; both read the same
    // raw frames from stdin. The gif filter is the standard two-pass palette
    // in one graph (palettegen -> paletteuse); bayer dither keeps the lamp
    // glow from banding without speckling the flat pixel-art regions.
    let jobs = [
        (
            format!("scale=iw*{mp4_scale}:ih*{mp4_scale}:flags=neighbor,format=yuv420p"),
            vec!["-c:v", "libx264", "-crf", "16", "-preset", "slow", "-movflags", "+faststart"],
            &mp4,
        ),
        (
            format!("fps={gif_fps:.3},scale=iw*{gif_scale}:ih*{gif_scale}:flags=neighbor,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5"),
            vec!["-loop", "0"],
            &gif,
        ),
    ];
    for (filter, extra, path) in &jobs {
        let spawn = Command::new("ffmpeg")
            .args(["-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba"])
            .args(["-s", &format!("{w}x{h}"), "-framerate", &format!("{fps:.3}"), "-i", "-"])
            .args(["-vf", filter])
            .args(extra)
            .arg(path)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn();
        let mut child = match spawn {
            Ok(c) => c,
            Err(e) => {
                println!("clip: ffmpeg not runnable ({e}) — frames discarded");
                return;
            }
        };
        {
            let stdin = child.stdin.as_mut().unwrap();
            for f in &frames {
                if stdin.write_all(f).is_err() {
                    break; // ffmpeg died; wait() below reports it
                }
            }
        }
        match child.wait() {
            Ok(st) if st.success() => {
                let kb = std::fs::metadata(path).map(|m| m.len() / 1024).unwrap_or(0);
                println!("clip: wrote {path} ({w}x{h} game px, {} frames, {kb} KB)", frames.len());
            }
            _ => println!("clip: ffmpeg failed for {path}"),
        }
    }
}

pub(crate) fn write_png(path: &str, w: u32, h: u32, rgba: &[u8]) {
    let f = std::fs::File::create(path).unwrap();
    let mut enc = png::Encoder::new(std::io::BufWriter::new(f), w, h);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header().unwrap().write_image_data(rgba).unwrap();
}

/// Take every `rs`-th pixel of a full-extent RGBA readback — the exact
/// low-res game image (the upscale is integer NEAREST, so any sample of an
/// rs×rs block IS the game pixel). Shared by both backends' readback paths.
pub(crate) fn subsample_rgba(full: &[u8], w: u32, h: u32, rs: u32) -> (u32, u32, Vec<u8>) {
    let (sw, sh) = (w / rs, h / rs);
    let mut sub = vec![0u8; (sw * sh * 4) as usize];
    for y in 0..sh {
        for x in 0..sw {
            let src = (((y * rs) * w + x * rs) * 4) as usize;
            let dst = ((y * sw + x) * 4) as usize;
            sub[dst..dst + 4].copy_from_slice(&full[src..src + 4]);
        }
    }
    (sw, sh, sub)
}

impl Viewer {
    /// 'r' / the menu row: start a recording, or stop + encode the current one.
    pub fn toggle_recording(&mut self) {
        if self.rec.is_some() {
            self.finish_recording();
            return;
        }
        let fps = self.cfg.harness.clip_fps;
        // first capture on the very next presented frame
        self.rec = Some(Rec {
            w: 0,
            h: 0,
            fps,
            next_due: self.start_time.elapsed().as_secs_f32(),
            max_frames: (self.cfg.harness.clip_max_s * fps as f32).max(2.0) as usize,
            t_first: 0.0,
            t_last: 0.0,
            frames: Vec::new(),
        });
        println!("clip: recording at {fps} fps (game pixels) — 'r' to stop");
    }

    /// Stop recording and hand the frames to a background encode (no-op when
    /// idle, so it doubles as the at-exit flush).
    pub fn finish_recording(&mut self) {
        let Some(rec) = self.rec.take() else { return };
        let n = rec.frames.len();
        // encode at the rate the frames were ACTUALLY collected at, so the
        // clip's duration matches wall-clock even if capture fell behind
        let fps = if n >= 2 && rec.t_last - rec.t_first > 0.001 {
            (n - 1) as f64 / (rec.t_last - rec.t_first) as f64
        } else {
            rec.fps as f64
        };
        println!("clip: stopped ({n} frames, {:.1}s @ {fps:.1} fps) — encoding mp4 + gif...", (n.max(1) - 1) as f64 / fps);
        let (ms, gs) = (self.cfg.harness.clip_mp4_scale, self.cfg.harness.clip_gif_scale);
        self.rec_jobs.push(std::thread::spawn(move || encode_clip(rec.frames, rec.w, rec.h, fps, ms, gs)));
    }

    /// Per-frame recording bookkeeping, run BEFORE the frame's commands are
    /// recorded: collect the previous frame's deferred capture (the backend's
    /// in-flight fence guarantees its copy completed), then decide whether this
    /// frame captures and at what size. Returns `Some((cw, ch))` when the draw
    /// below should record the down-blit into this frame's command buffer (the
    /// caller sizes the capture target + sets `FramePresent.capture`).
    pub unsafe fn prepare_capture(&mut self) -> Option<(u32, u32)> {
        if let Some((w, h, pixels)) = self.backend.collect_pending_capture() {
            let t = self.start_time.elapsed().as_secs_f32();
            if let Some(rec) = &mut self.rec {
                if rec.frames.is_empty() {
                    (rec.w, rec.h) = (w, h);
                    rec.t_first = t;
                }
                rec.t_last = t;
                rec.frames.push(pixels);
            }
        }
        if self.rec.as_ref().is_some_and(|r| r.frames.len() >= r.max_frames) {
            println!("clip: length cap reached (CLIP_MAX_S)");
            self.finish_recording();
        }
        let t = self.start_time.elapsed().as_secs_f32();
        if !self.backend.has_target() || !self.rec.as_ref().is_some_and(|r| t >= r.next_due) {
            return None;
        }
        let rs = self.rs() as u32;
        let (ew, eh) = self.backend.extent();
        let (cw, ch) = (ew / rs, eh / rs);
        // view size changed mid-clip with frames already collected: finish at
        // the old size. (Nothing collected yet → the caller's
        // ensure_capture_target refits silently, safe because a previous draw's
        // fence retired the old target's last GPU use.)
        if self.backend.capture_target_size().is_some_and(|sz| sz != (cw, ch)) && !self.rec.as_ref().unwrap().frames.is_empty() {
            println!("clip: view size changed — finishing the clip at the old size");
            self.finish_recording();
            return None;
        }
        let rec = self.rec.as_mut().unwrap();
        rec.next_due += 1.0 / rec.fps as f32;
        if rec.next_due < t - 0.25 {
            rec.next_due = t; // a stall: drop the backlog, don't burst
        }
        Some((cw, ch))
    }

    /// Wait for in-flight clip encodes (called once on the way out).
    pub fn join_clip_jobs(&mut self) {
        for j in self.rec_jobs.drain(..) {
            let _ = j.join();
        }
    }

    /// Synthetic-input harness, run at the top of draw(): ROTATE_AT fires one
    /// smooth e-turn (and arms the DUMP counter); DUMP_AT arms the dump with
    /// no camera command. (Player input synthesis is CMDS — deterministic
    /// tick-stamped replay, not wall-clock.)
    pub fn harness_pre_frame(&mut self) {
        let elapsed = self.start_time.elapsed().as_secs_f32();
        if let Some(t) = self.harness.rotate_at {
            if elapsed >= t {
                self.harness.rotate_at = None;
                self.start_rotate(1);
                if self.harness.dump_dir.is_some() {
                    self.harness.dump_left = self.harness.dump_n;
                }
            }
        }
        if let Some(t) = self.harness.dump_at {
            if elapsed >= t {
                self.harness.dump_at = None;
                if self.harness.dump_dir.is_some() {
                    self.harness.dump_left = self.harness.dump_n;
                }
            }
        }
    }

    /// Harness outputs, run after present: collect DUMP frames (PNGs written
    /// in one batch at the end so the dump barely perturbs frame pacing),
    /// advance the scripted movie, fire the SHOT capture.
    pub unsafe fn harness_post_frame(&mut self) {
        if self.harness.dump_left > 0 && self.harness.dump_dir.is_some() {
            let (w, h, rgba) = self.backend.readback_out_subsampled(self.rs());
            self.harness.dump_frames.push((w, h, rgba));
            let (turns, settle) = match &self.view.rot {
                Some(r) => (r.turns, r.settle.is_some()),
                None => (self.view.yaw_q as f32, false),
            };
            println!("DUMP {:04} t={:.4} turns={:.6} settle={} rot={}", self.harness.dump_idx, self.start_time.elapsed().as_secs_f32(), turns, settle, self.view.rot.is_some());
            self.harness.dump_idx += 1;
            self.harness.dump_left -= 1;
            if self.harness.dump_left == 0 {
                let dir = self.harness.dump_dir.clone().unwrap();
                for (i, (w, h, data)) in self.harness.dump_frames.iter().enumerate() {
                    write_png(&format!("{dir}/d_{i:04}.png"), *w, *h, data);
                }
                println!("DUMP wrote {} frames to {dir}", self.harness.dump_frames.len());
                self.harness.dump_frames.clear();
                self.exit_requested = true;
            }
        }

        // DEMO: this frame already advanced one sim tick (draw()) under the live
        // follow-cam; capture the readback `out` to dir/d_NNNNN.png via the SAME
        // path SHOT uses (capture_png waits the device idle), then exit once
        // every tick has rendered.
        if let Some(demo) = self.harness.demo.as_ref() {
            let (dir, ticks, done) = (demo.dir.clone(), demo.ticks, demo.done);
            self.backend.capture_png(&format!("{dir}/d_{done:05}.png"));
            let demo = self.harness.demo.as_mut().unwrap();
            demo.done += 1;
            if demo.done >= ticks {
                println!("DEMO: wrote {} frames to {dir}/", demo.done);
                self.exit_requested = true;
            }
        }

        if self.movie.is_some() {
            self.movie_tick();
        }

        // headless capture: every det frame is final — capture once the delay
        // has passed and a couple of frames have presented (light upload +
        // TLAS rebuild land on frame 1).
        if let Some(path) = self.harness.shot.clone() {
            if self.frame >= 2 && self.start_time.elapsed().as_secs_f32() >= self.harness.shot_delay {
                // the capture is sim-independent BY CONSTRUCTION: draw() feeds
                // the fixed loop dt = 0 in SHOT mode, so the wall clock never
                // ran a tick — only the deterministic CMDS prefix did. Pin it.
                assert_eq!(self.town.tick.0, self.town.cmds_prefix, "SHOT capture ran wall-clock sim ticks — captures would depend on timing");
                self.backend.capture_png(&path);
                self.exit_requested = true;
            }
        }
    }

    /// Advance the scripted movie one tick. Runs at the end of draw(), when
    /// `out` holds the frame just presented. Every det frame is final, so
    /// each tick captures immediately; instantaneous commands (zoom, the
    /// orbit landing) apply between captures, exactly like a key press.
    pub unsafe fn movie_tick(&mut self) {
        let Some(mut mv) = self.movie.take() else { return };
        loop {
            let Some(cmd) = mv.cmds.get(mv.seg) else {
                self.backend.wait_idle();
                println!("movie: {} frames -> {}/", mv.out_idx, mv.dir);
                self.exit_requested = true;
                return;
            };
            match *cmd {
                MovieCmd::Hold(n) => {
                    self.backend.capture_png(&format!("{}/m_{:05}.png", mv.dir, mv.out_idx));
                    mv.out_idx += 1;
                    mv.seg_done += 1;
                    if mv.seg_done >= n {
                        mv.seg += 1;
                        mv.seg_done = 0;
                        continue; // an instantaneous command may follow right away
                    }
                    break;
                }
                MovieCmd::Orbit(dq, n) => {
                    self.backend.capture_png(&format!("{}/m_{:05}.png", mv.dir, mv.out_idx));
                    mv.out_idx += 1;
                    mv.seg_done += 1;
                    if mv.seg_done >= n {
                        // land exactly on the next quarter through the real
                        // interactive path (re-snaps)
                        self.view.yaw_anim = 0.0;
                        self.rotate(dq);
                        mv.seg += 1;
                        mv.seg_done = 0;
                    } else {
                        let t = mv.seg_done as f32 / n as f32;
                        self.view.yaw_anim = 90.0 * dq as f32 * (t * t * (3.0 - 2.0 * t));
                    }
                    break;
                }
                MovieCmd::Zoom(d) => {
                    let (ew, eh) = self.backend.extent();
                    self.zoom_step(d, Vec2::new(ew as f32 / 2.0, eh as f32 / 2.0));
                    mv.seg += 1;
                    break;
                }
                MovieCmd::PanTo(x, z, n) => {
                    self.backend.capture_png(&format!("{}/m_{:05}.png", mv.dir, mv.out_idx));
                    mv.out_idx += 1;
                    // step toward the goal by 1/remaining of what's left — lands
                    // exactly on (x, z) regardless of lattice re-snapping
                    let remaining = (n - mv.seg_done).max(1) as f32;
                    let step = Vec3::new((x - self.view.target.x) / remaining, 0.0, (z - self.view.target.z) / remaining);
                    self.pan_target(step);
                    mv.seg_done += 1;
                    if mv.seg_done >= n {
                        mv.seg += 1;
                        mv.seg_done = 0;
                    }
                    break;
                }
            }
        }
        self.movie = Some(mv);
    }
}
