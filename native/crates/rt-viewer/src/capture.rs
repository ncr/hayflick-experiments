//! Capture + headless-harness tooling: SHOT one-frame captures, DUMP frame
//! sequences, in-viewer clip recording (mp4 + gif), and the scripted MOVIE
//! camera tour. All capture paths read the GPU `out` image — the exact
//! presented pixels (the UI overlay only ever touches the swapchain image).

use crate::renderer::Renderer;
use ash::vk;
use glam::{Vec2, Vec3};
use rt_probe::*;

/// Mutable headless-harness state (seeded from `Config`, consumed as the
/// triggers fire): SHOT / WALK / ROTATE_AT / DUMP / DUMP_AT.
pub struct Harness {
    pub shot: Option<String>,
    pub shot_delay: f32,
    pub walk: Option<f32>,
    pub rotate_at: Option<f32>,
    pub dump_dir: Option<String>,
    pub dump_at: Option<f32>,
    pub dump_n: i32,
    pub dump_left: i32,
    pub dump_idx: u32,
    pub dump_frames: Vec<(u32, u32, Vec<u8>)>,
}

impl Harness {
    pub fn from_cfg(cfg: &Config) -> Harness {
        Harness {
            shot: cfg.shot.clone(),
            shot_delay: cfg.shot_delay,
            walk: cfg.walk,
            rotate_at: cfg.rotate_at,
            dump_dir: cfg.dump.clone(),
            dump_at: cfg.dump_at,
            dump_n: cfg.dump_n,
            dump_left: 0,
            dump_idx: 0,
            dump_frames: Vec::new(),
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

/// Persistent GPU-side capture target: `out` (already in TRANSFER_SRC for the
/// swapchain blit) is NEAREST-blitted down to exact game pixels into `img`,
/// then copied into the host-visible `buf` — all inside the frame's own
/// command buffer. The CPU reads `buf` on the NEXT draw, after the in-flight
/// fence, so recording never blocks the loop (a synchronous readback per
/// captured frame halved the framerate and made clips play fast).
pub struct Cap {
    pub img: (vk::Image, vk::DeviceMemory, vk::ImageView),
    pub buf: Buffer,
    pub w: u32,
    pub h: u32,
    pub pending: bool, // a capture was recorded this frame; collect after the fence
}

/// Scripted camera move for MOVIE mode. Each command drives the SAME code
/// path the matching interactive input uses (rotate / zoom_step / pan_target),
/// so the movie shows real app behaviour, not a synthetic camera.
pub enum MovieCmd {
    /// Capture N frames at the current camera.
    Hold(u32),
    /// Fluid quarter-turn: sweep the yaw 90°·dq over N captured frames with
    /// smoothstep easing, swapping the dollhouse masks side-on at 45°, then
    /// land through the real `rotate` path.
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
        let (dx, dz) = cfg.detail;
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

fn write_png(path: &str, w: u32, h: u32, rgba: &[u8]) {
    let f = std::fs::File::create(path).unwrap();
    let mut enc = png::Encoder::new(std::io::BufWriter::new(f), w, h);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header().unwrap().write_image_data(rgba).unwrap();
}

impl Renderer {
    /// 'r' / the menu row: start a recording, or stop + encode the current one.
    pub fn toggle_recording(&mut self) {
        if self.rec.is_some() {
            self.finish_recording();
            return;
        }
        let fps = self.cfg.clip_fps;
        // first capture on the very next presented frame
        self.rec = Some(Rec {
            w: 0,
            h: 0,
            fps,
            next_due: self.start_time.elapsed().as_secs_f32(),
            max_frames: (self.cfg.clip_max_s * fps as f32).max(2.0) as usize,
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
        let (ms, gs) = (self.cfg.clip_mp4_scale, self.cfg.clip_gif_scale);
        self.rec_jobs.push(std::thread::spawn(move || encode_clip(rec.frames, rec.w, rec.h, fps, ms, gs)));
    }

    /// Per-frame recording bookkeeping, run BEFORE the frame's commands are
    /// recorded: collect the previous frame's capture (the in-flight fence
    /// guarantees its copy completed), then decide whether this frame
    /// captures and (re)fit the capture target. Returns true when the draw
    /// below should record the capture blit+copy into its command buffer.
    pub unsafe fn prepare_capture(&mut self) -> bool {
        if self.cap.as_ref().is_some_and(|c| c.pending) {
            self.ctx.device.wait_for_fences(&[self.in_flight], true, u64::MAX).unwrap();
            let cap = self.cap.as_mut().unwrap();
            cap.pending = false;
            if let Some(rec) = &mut self.rec {
                let n = (cap.w * cap.h) as usize * 4;
                let ptr = self.ctx.device.map_memory(cap.buf.memory, 0, n as u64, vk::MemoryMapFlags::empty()).unwrap() as *const u8;
                let pixels = std::slice::from_raw_parts(ptr, n).to_vec();
                self.ctx.device.unmap_memory(cap.buf.memory);
                let t = self.start_time.elapsed().as_secs_f32();
                if rec.frames.is_empty() {
                    (rec.w, rec.h) = (cap.w, cap.h);
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
        if self.swap.is_none() || !self.rec.as_ref().is_some_and(|r| t >= r.next_due) {
            return false;
        }
        let rs = self.rs() as u32;
        let ext = self.swap.as_ref().unwrap().extent;
        let (cw, ch) = (ext.width / rs, ext.height / rs);
        if self.cap.as_ref().is_some_and(|c| (c.w, c.h) != (cw, ch)) {
            if !self.rec.as_ref().unwrap().frames.is_empty() {
                println!("clip: view size changed — finishing the clip at the old size");
                self.finish_recording();
                return false;
            }
            // nothing collected yet: refit silently (safe — the fence wait in
            // a previous draw retired the old target's last GPU use)
            let c = self.cap.take().unwrap();
            self.destroy_cap(c);
        }
        if self.cap.is_none() {
            let img = make_storage_image(&self.ctx, cw, ch, vk::Format::R8G8B8A8_UNORM);
            let buf = self.ctx.create_buffer(
                (cw * ch * 4) as u64,
                vk::BufferUsageFlags::TRANSFER_DST,
                vk::MemoryPropertyFlags::HOST_VISIBLE | vk::MemoryPropertyFlags::HOST_COHERENT,
            );
            self.cap = Some(Cap { img, buf, w: cw, h: ch, pending: false });
        }
        let rec = self.rec.as_mut().unwrap();
        rec.next_due += 1.0 / rec.fps as f32;
        if rec.next_due < t - 0.25 {
            rec.next_due = t; // a stall: drop the backlog, don't burst
        }
        self.cap.as_mut().unwrap().pending = true;
        true
    }

    pub unsafe fn destroy_cap(&self, c: Cap) {
        let d = &self.ctx.device;
        d.destroy_image_view(c.img.2, None);
        d.destroy_image(c.img.0, None);
        d.free_memory(c.img.1, None);
        self.ctx.destroy_buffer(&c.buf);
    }

    /// Wait for in-flight clip encodes (called once on the way out).
    pub fn join_clip_jobs(&mut self) {
        for j in self.rec_jobs.drain(..) {
            let _ = j.join();
        }
    }

    /// Read back `out` and take every render-scale-th pixel — the exact
    /// low-res game image (the upscale is integer NEAREST). RGBA bytes.
    pub unsafe fn readback_out_subsampled(&self) -> (u32, u32, Vec<u8>) {
        let swap = self.swap.as_ref().unwrap();
        let (w, h) = (swap.extent.width, swap.extent.height);
        let n = (w * h) as usize;
        let readback = self.ctx.create_buffer((n * 4) as u64, vk::BufferUsageFlags::TRANSFER_DST, vk::MemoryPropertyFlags::HOST_VISIBLE | vk::MemoryPropertyFlags::HOST_COHERENT);
        self.ctx.one_time(|cmd| {
            barrier(&self.ctx.device, cmd, swap.out.0, vk::ImageLayout::GENERAL, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, vk::AccessFlags::SHADER_WRITE, vk::AccessFlags::TRANSFER_READ, vk::PipelineStageFlags::COMPUTE_SHADER, vk::PipelineStageFlags::TRANSFER);
            let region = vk::BufferImageCopy::default().image_subresource(vk::ImageSubresourceLayers { aspect_mask: vk::ImageAspectFlags::COLOR, mip_level: 0, base_array_layer: 0, layer_count: 1 }).image_extent(vk::Extent3D { width: w, height: h, depth: 1 });
            self.ctx.device.cmd_copy_image_to_buffer(cmd, swap.out.0, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, readback.buffer, &[region]);
            barrier(&self.ctx.device, cmd, swap.out.0, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, vk::ImageLayout::GENERAL, vk::AccessFlags::TRANSFER_READ, vk::AccessFlags::SHADER_WRITE, vk::PipelineStageFlags::TRANSFER, vk::PipelineStageFlags::COMPUTE_SHADER);
        });
        let ptr = self.ctx.device.map_memory(readback.memory, 0, (n * 4) as u64, vk::MemoryMapFlags::empty()).unwrap() as *const u8;
        let full = std::slice::from_raw_parts(ptr, n * 4);
        let rs = self.rs() as u32;
        let (sw, sh) = (w / rs, h / rs);
        let mut sub = vec![0u8; (sw * sh * 4) as usize];
        for y in 0..sh {
            for x in 0..sw {
                let src = (((y * rs) * w + x * rs) * 4) as usize;
                let dst = ((y * sw + x) * 4) as usize;
                sub[dst..dst + 4].copy_from_slice(&full[src..src + 4]);
            }
        }
        self.ctx.device.unmap_memory(readback.memory);
        self.ctx.destroy_buffer(&readback);
        (sw, sh, sub)
    }

    /// Dump the `out` image (the exact thing blitted to the swapchain) to a PNG.
    pub unsafe fn capture(&self, path: &str) {
        let swap = self.swap.as_ref().unwrap();
        let (w, h) = (swap.extent.width, swap.extent.height);
        let n = (w * h) as usize;
        let readback = self.ctx.create_buffer((n * 4) as u64, vk::BufferUsageFlags::TRANSFER_DST, vk::MemoryPropertyFlags::HOST_VISIBLE | vk::MemoryPropertyFlags::HOST_COHERENT);
        self.ctx.one_time(|cmd| {
            barrier(&self.ctx.device, cmd, swap.out.0, vk::ImageLayout::GENERAL, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, vk::AccessFlags::SHADER_WRITE, vk::AccessFlags::TRANSFER_READ, vk::PipelineStageFlags::COMPUTE_SHADER, vk::PipelineStageFlags::TRANSFER);
            let region = vk::BufferImageCopy::default().image_subresource(vk::ImageSubresourceLayers { aspect_mask: vk::ImageAspectFlags::COLOR, mip_level: 0, base_array_layer: 0, layer_count: 1 }).image_extent(vk::Extent3D { width: w, height: h, depth: 1 });
            self.ctx.device.cmd_copy_image_to_buffer(cmd, swap.out.0, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, readback.buffer, &[region]);
            barrier(&self.ctx.device, cmd, swap.out.0, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, vk::ImageLayout::GENERAL, vk::AccessFlags::TRANSFER_READ, vk::AccessFlags::SHADER_WRITE, vk::PipelineStageFlags::TRANSFER, vk::PipelineStageFlags::COMPUTE_SHADER);
        });
        let ptr = self.ctx.device.map_memory(readback.memory, 0, (n * 4) as u64, vk::MemoryMapFlags::empty()).unwrap() as *const u8;
        let pixels = std::slice::from_raw_parts(ptr, n * 4).to_vec();
        self.ctx.device.unmap_memory(readback.memory);
        self.ctx.destroy_buffer(&readback);
        write_png(path, w, h, &pixels);
        println!("captured {path} ({w}x{h})");
    }

    /// Synthetic-input harness, run at the top of draw(): WALK holds up+right
    /// for its duration; ROTATE_AT fires one smooth e-turn (and arms the DUMP
    /// counter); DUMP_AT arms the dump with no camera command.
    pub fn harness_pre_frame(&mut self) {
        let elapsed = self.start_time.elapsed().as_secs_f32();
        if let Some(w) = self.harness.walk {
            self.player.held = if elapsed < w { [true, false, false, true] } else { [false; 4] };
        }
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
            let (w, h, rgba) = self.readback_out_subsampled();
            self.harness.dump_frames.push((w, h, rgba));
            let (turns, settle) = match &self.view.rot {
                Some(r) => (r.turns, r.settle.is_some()),
                None => (self.view.yaw_q as f32, false),
            };
            println!("DUMP {:04} t={:.4} turns={:.6} settle={} rot={} maskq={}", self.harness.dump_idx, self.start_time.elapsed().as_secs_f32(), turns, settle, self.view.rot.is_some(), self.view.mask_q);
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

        if self.movie.is_some() {
            self.movie_tick();
        }

        // headless capture: every det frame is final — capture once the delay
        // has passed and a couple of frames have presented (light upload +
        // TLAS rebuild land on frame 1).
        if let Some(path) = self.harness.shot.clone() {
            if self.frame >= 2 && self.start_time.elapsed().as_secs_f32() >= self.harness.shot_delay {
                self.ctx.device.device_wait_idle().unwrap();
                self.capture(&path);
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
                self.ctx.device.device_wait_idle().ok();
                println!("movie: {} frames -> {}/", mv.out_idx, mv.dir);
                self.exit_requested = true;
                return;
            };
            match *cmd {
                MovieCmd::Hold(n) => {
                    self.ctx.device.device_wait_idle().ok();
                    self.capture(&format!("{}/m_{:05}.png", mv.dir, mv.out_idx));
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
                    self.ctx.device.device_wait_idle().ok();
                    self.capture(&format!("{}/m_{:05}.png", mv.dir, mv.out_idx));
                    mv.out_idx += 1;
                    mv.seg_done += 1;
                    if mv.seg_done >= n {
                        // land exactly on the next quarter through the real
                        // interactive path (re-masks, re-snaps)
                        self.view.yaw_anim = 0.0;
                        self.rotate(dq);
                        mv.seg += 1;
                        mv.seg_done = 0;
                    } else {
                        let t = mv.seg_done as f32 / n as f32;
                        self.view.yaw_anim = 90.0 * dq as f32 * (t * t * (3.0 - 2.0 * t));
                        // swap the dollhouse masks side-on, halfway through the turn
                        if mv.seg_done == n / 2 && !self.scene.prim_hide_mask.is_empty() {
                            let next_q = (self.view.yaw_q as i32 + dq).rem_euclid(4) as u32;
                            // marks the TLAS dirty; record_frame applies them
                            self.gpu.set_yaw_masks(&self.ctx, next_q);
                        }
                    }
                    break;
                }
                MovieCmd::Zoom(d) => {
                    let e = self.swap.as_ref().unwrap().extent;
                    self.zoom_step(d, Vec2::new(e.width as f32 / 2.0, e.height as f32 / 2.0));
                    mv.seg += 1;
                    break;
                }
                MovieCmd::PanTo(x, z, n) => {
                    self.ctx.device.device_wait_idle().ok();
                    self.capture(&format!("{}/m_{:05}.png", mv.dir, mv.out_idx));
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
