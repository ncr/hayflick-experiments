//! Interactive ISO_VIEW_CONTRACT viewer — a winit window over the
//! deterministic hardware-RT renderer (`rt_probe::render`). Every frame is a
//! pure function of (scene, camera): no accumulation, no denoiser, no
//! temporal state. Monte Carlo runs once at startup into the world-space GI
//! probe cache.
//!
//! Controls (player input becomes tick-stamped gym `Command`s — the sim runs
//! on a fixed 60 Hz loop; the viewer only presents):
//! - LMB / trackpad tap — click-to-move (unprojected to a ground cell; the
//!   shell BFS-plans the route, the sim owns the step cadence)
//! - WASD / arrows — screen-relative continuous walk
//! - Shift — run
//! - q / e — smooth eased quarter turn (presentation-only)
//! - scroll / +- — integer zoom steps 1-4, cursor-anchored; 0 = camera reset
//! - Tab — the personal IDE (pracownia): hierarchy + inspector at 2x the
//!   game's pixel density; click selects, sliders edit on release; the world
//!   pauses while it is open (ESC closes it too)
//! - l — lamp master on/off
//! - r — record a clip at exact game resolution: stop writes BOTH
//!   clips/clip_NNNN.mp4 (x264, NEAREST 4x) and .gif (palette, 1x, half rate)
//! - Esc — the game menu (Title at boot; Pause in play; Settings is a
//!   submenu with live sliders)
//!
//! The scene is the gym: one hand-authored level — a few walls, one
//! building, the player (docs/VISION.md, cut 2026-07-12).
//!
//! Headless harness (see config.rs): SHOT / SHOT_DELAY one-frame capture
//! (truly window-less — no surface/swapchain, extent taken from WINDOW;
//! the wall clock NEVER ticks the sim in SHOT mode), CMDS / CMDS_TICKS
//! deterministic command-trace replay prefix (gym trace format),
//! DEMO / DEMO_DIR / DEMO_TICKS per-tick gameplay dump, ROTATE_AT synthetic
//! input, DUMP / DUMP_AT / DUMP_N frame dumps, MOVIE scripted tour,
//! FRAMES / TIMING perf, WINDOW=WxH exact size.

mod audio;
mod backend;
mod capture;
mod crack;
mod crack_geom;
mod demos;
mod flags;
mod gym_loop;
mod gym_scene;
mod gi_demo;
mod ide_host;
mod look;
mod menu;
mod phys_scene;
mod rebar;
mod view;
mod viewer;
mod wall;
mod wear;
mod wear_file;
// Backend selected at compile time by target OS: Metal on Apple Silicon,
// Vulkan everywhere else. The Vulkan path runs on the RTX box; the Metal path
// runs on the M2 Pro.
#[cfg(target_os = "macos")]
mod metal_backend;
#[cfg(not(target_os = "macos"))]
mod vulkan_backend;

use glam::Vec2;
use rt_probe::Config;
use std::sync::Arc;
use viewer::Viewer;
use winit::application::ApplicationHandler;
use winit::event::{ElementState, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, EventLoop};
use winit::keyboard::{Key, NamedKey};
use winit::window::{Window, WindowId};

struct App {
    cfg: Option<Config>,
    window: Option<Arc<Window>>,
    renderer: Option<Viewer>,
    // FS_AT harness: (fire time, boot instant) — self-fullscreen without a
    // keyboard, so fullscreen-only symptoms are reproducible headlessly.
    fs_at: Option<(f32, std::time::Instant)>,
    // Self-paced frame clock (VSYNC=1, the default): present is MAILBOX —
    // it must never block, because on Hyprland + NVIDIA a blocking FIFO
    // present parks the whole event loop in a DRM syncobj wait whenever the
    // compositor stops rendering (fullscreen + VFR), and a dead event loop
    // reads as "the keyboard stopped working". So the GPU cap lives HERE:
    // redraws are requested at the monitor's refresh period. None = VSYNC=0,
    // uncapped for latency experiments.
    pace: Option<std::time::Duration>,
    next_frame: std::time::Instant,
}

/// One frame at the refresh rate of whatever monitor the window sits on.
/// 60 Hz fallback if the compositor won't say (Wayland always does).
fn refresh_period(w: &Window) -> std::time::Duration {
    let mhz = w.current_monitor().and_then(|m| m.refresh_rate_millihertz()).unwrap_or(60_000);
    std::time::Duration::from_secs_f64(1000.0 / mhz.max(1_000) as f64)
}

impl ApplicationHandler for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }
        let cfg = self.cfg.take().expect("config consumed once");
        self.fs_at = cfg.harness.fs_at.map(|t| (t, std::time::Instant::now()));
        let vsync = cfg.harness.vsync;
        let (w, h) = cfg.harness.window.unwrap_or((1280, 800));
        // Create the window HIDDEN: `Viewer::new` blocks the main thread for the
        // one-time GI probe bake, and a visible window with a stalled run loop
        // is exactly what makes macOS draw the beachball. No drawable is
        // acquired during init (the bake is pure compute), so revealing the
        // window only once it's ready is safe.
        let attrs = Window::default_attributes().with_title("Hayflick").with_visible(false).with_inner_size(winit::dpi::LogicalSize::new(w as f64, h as f64));
        let window = Arc::new(event_loop.create_window(attrs).unwrap());
        let renderer = unsafe { Viewer::new(Some(&window), cfg).expect("renderer init") };
        window.set_visible(true);
        self.pace = vsync.then(|| refresh_period(&window));
        self.next_frame = std::time::Instant::now();
        self.window = Some(window);
        self.renderer = Some(renderer);
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => event_loop.exit(),
            WindowEvent::KeyboardInput { event, .. } => {
                let Some(r) = self.renderer.as_mut() else { return };
                // an open menu captures the arrows + enter; WASD also
                // navigates (regular-game muscle memory)
                if r.menu_open() && event.state.is_pressed() {
                    let n = r.menu_len();
                    match event.logical_key.as_ref() {
                        Key::Named(NamedKey::ArrowUp) | Key::Character("w") => {
                            r.menu.sel = (r.menu.sel + n - 1) % n;
                            r.ui_blip("menu_move");
                            return;
                        }
                        Key::Named(NamedKey::ArrowDown) | Key::Character("s") => {
                            r.menu.sel = (r.menu.sel + 1) % n;
                            r.ui_blip("menu_move");
                            return;
                        }
                        Key::Named(NamedKey::ArrowLeft) => {
                            r.menu_adjust(-1.0);
                            return;
                        }
                        Key::Named(NamedKey::ArrowRight) => {
                            r.menu_adjust(1.0);
                            return;
                        }
                        // TOGGLES AND ACTIVATIONS IGNORE KEY REPEAT. Wayland
                        // key repeat is client-side (winit timer): when event
                        // processing is delayed past the repeat delay — the
                        // fullscreen swapchain recreate alone blocks ~400 ms —
                        // repeats inject between a press and its release, and
                        // an unguarded ESC then toggles the menu TWICE per
                        // physical press: open-close, "the menu won't close".
                        Key::Named(NamedKey::Enter) | Key::Named(NamedKey::Space) if !event.repeat => {
                            r.menu_activate();
                            return;
                        }
                        Key::Named(NamedKey::Escape) if !event.repeat => {
                            r.menu_toggle();
                            return;
                        }
                        _ => return, // menus are modal: swallow the rest (repeats included)
                    }
                }
                // movement keys are held-state (continuous walk); index = [up,down,left,right]
                let held_idx = match event.logical_key.as_ref() {
                    Key::Named(NamedKey::ArrowUp) | Key::Character("w") => Some(0),
                    Key::Named(NamedKey::ArrowDown) | Key::Character("s") => Some(1),
                    Key::Named(NamedKey::ArrowLeft) | Key::Character("a") => Some(2),
                    Key::Named(NamedKey::ArrowRight) | Key::Character("d") => Some(3),
                    _ => None,
                };
                if let Some(i) = held_idx {
                    // an open IDE freezes the world — walking starts on close
                    if !r.ide.ui.open {
                        r.gym.held[i] = event.state.is_pressed();
                    }
                    return;
                }
                // movement mode (held)
                if let Key::Named(NamedKey::Shift) = event.logical_key.as_ref() {
                    r.gym.run_held = event.state.is_pressed();
                    return;
                }
                if !event.state.is_pressed() {
                    return; // discrete actions fire on press only
                }
                match event.logical_key.as_ref() {
                    // same repeat guard as the modal branch: one physical
                    // press, one toggle. ESC closes the IDE first — the game
                    // menu stays one more ESC away.
                    Key::Named(NamedKey::Escape) if !event.repeat => {
                        if r.ide.ui.open {
                            r.ide_toggle();
                        } else {
                            r.menu_toggle();
                        }
                    }
                    // the personal IDE (pause = edit): Tab toggles it
                    Key::Named(NamedKey::Tab) if !event.repeat => r.ide_toggle(),
                    Key::Character("=") | Key::Character("+") => {
                        let c = r.view.cursor;
                        r.zoom_step(1, c);
                    }
                    Key::Character("-") | Key::Character("_") => {
                        let c = r.view.cursor;
                        r.zoom_step(-1, c);
                    }
                    Key::Character("q") => r.start_rotate(-1),
                    Key::Character("e") => r.start_rotate(1),
                    Key::Character("0") => {
                        // camera reset: recentre on the player, canonical yaw
                        r.view.zoom = 1.0;
                        r.view.target = r.gym.cam_target();
                        r.view.move_accum = Vec2::ZERO;
                        r.recenter_pan();
                        r.rotate(-(r.view.yaw_q as i32));
                    }
                    // toggles ignore key repeat: holding the key must not strobe
                    Key::Character("r") if !event.repeat => r.toggle_recording(),
                    Key::Character("l") if !event.repeat => {
                        r.lights_dim = if r.lights_dim > 0.0 { 0.0 } else { 1.0 };
                        println!("lamps: {}", if r.lights_dim > 0.0 { "on" } else { "off" });
                    }
                    // Stage-2 spike: 'x' tears the roof off live (dynamic GI
                    // floods the interior; step inside to watch it settle).
                    Key::Character("x") if !event.repeat => r.tear_roof(),
                    _ => {}
                }
            }
            WindowEvent::Focused(false) => {
                // focus can leave mid-hold (fullscreen toggles, alt-tab) and
                // the release then goes to another surface: clear every
                // held-state or the player walks into a wall forever and a
                // stale drag keeps editing the panel
                if let Some(r) = self.renderer.as_mut() {
                    r.gym.held = [false; 4];
                    r.gym.run_held = false;
                    r.menu.drag = false;
                    r.menu.drag_pending = false;
                    r.ide.ui.cancel_drag();
                    r.ide.drag_pending = false;
                }
            }
            WindowEvent::CursorMoved { position, .. } => {
                if let Some(r) = self.renderer.as_mut() {
                    let np = Vec2::new(position.x as f32, position.y as f32);
                    r.view.cursor = np;
                    // COALESCED: the drag applies once per frame (RedrawRequested),
                    // from the latest cursor — a wall-panel drag recompiles the
                    // level, and a 1000 Hz mouse applying that per EVENT builds a
                    // backlog the frame loop can never drain (see MenuState::drag_pending).
                    if r.menu.drag {
                        r.menu.drag_pending = true;
                    }
                    if r.ide.ui.dragging() {
                        r.ide.drag_pending = true;
                    }
                }
            }
            WindowEvent::MouseInput { state, button: MouseButton::Left, .. } => {
                if let Some(r) = self.renderer.as_mut() {
                    if state == ElementState::Pressed {
                        let c = r.view.cursor;
                        // the wall panel is gone (2026-07-27): outside the
                        // IDE a world click is the game's (click-to-move)
                        if !r.menu_click(c) && !r.ide_click(c) {
                            r.click_move(c); // click-to-move
                        }
                    } else {
                        // flush the coalesced tail first: the release must
                        // land on the value under the cursor, not one frame back
                        if r.menu.drag && r.menu.drag_pending {
                            r.menu.drag_pending = false;
                            let c = r.view.cursor;
                            r.menu_drag_to(c);
                        }
                        r.menu.drag = false;
                        if r.ide.ui.dragging() {
                            if r.ide.drag_pending {
                                r.ide.drag_pending = false;
                                r.ide_drag_step();
                            }
                            r.ide_release(); // slider released: the edit lands here
                        }
                        r.crack_release(); // knob drag ended: faults may need real geometry
                    }
                }
            }
            WindowEvent::MouseWheel { delta, .. } => {
                if let Some(r) = self.renderer.as_mut() {
                    let dy = match delta {
                        MouseScrollDelta::LineDelta(_, y) => y,
                        MouseScrollDelta::PixelDelta(p) => p.y as f32 / 50.0,
                    };
                    // an open IDE takes the wheel over its hierarchy (scroll);
                    // anywhere else it stays the zoom
                    if r.ide_wheel(r.view.cursor, dy) {
                        return;
                    }
                    // accumulate (trackpads send fractional deltas) and zoom in
                    // whole steps, cursor-anchored — web zoomStepAtClient.
                    r.view.wheel_accum += dy;
                    while r.view.wheel_accum >= 1.0 {
                        let c = r.view.cursor;
                        r.zoom_step(1, c);
                        r.view.wheel_accum -= 1.0;
                    }
                    while r.view.wheel_accum <= -1.0 {
                        let c = r.view.cursor;
                        r.zoom_step(-1, c);
                        r.view.wheel_accum += 1.0;
                    }
                }
            }
            WindowEvent::Resized(size) => {
                if let Some(r) = &mut self.renderer {
                    if size.width > 0 && size.height > 0 {
                        unsafe { r.recreate(size.width, size.height) };
                    }
                }
                // a resize is also how the window changes monitors
                // (fullscreen, drags): re-read the refresh period
                if let (Some(p), Some(w)) = (&mut self.pace, &self.window) {
                    *p = refresh_period(w);
                }
            }
            WindowEvent::RedrawRequested => {
                if let (Some((t, t0)), Some(w)) = (self.fs_at, &self.window) {
                    if t0.elapsed().as_secs_f32() >= t {
                        self.fs_at = None;
                        eprintln!("FS_AT: requesting compositor fullscreen");
                        w.set_fullscreen(Some(winit::window::Fullscreen::Borderless(None)));
                    }
                }
                if let Some(p) = self.pace {
                    // advance the frame clock; if we fell behind, snap to now
                    // (drop the debt) instead of spiralling
                    self.next_frame = std::cmp::max(self.next_frame + p, std::time::Instant::now());
                }
                if let (Some(r), Some(w)) = (&mut self.renderer, &self.window) {
                    // apply the frame's ONE coalesced drag step before drawing
                    if r.menu.drag && r.menu.drag_pending {
                        r.menu.drag_pending = false;
                        let c = r.view.cursor;
                        r.menu_drag_to(c);
                    }
                    if r.ide.ui.dragging() && r.ide.drag_pending {
                        r.ide.drag_pending = false;
                        r.ide_drag_step();
                    }
                    let ok = unsafe { r.draw() };
                    if r.exit_requested {
                        event_loop.exit();
                        return;
                    }
                    if !ok {
                        let s = w.inner_size();
                        if s.width > 0 && s.height > 0 {
                            unsafe { r.recreate(s.width, s.height) };
                        }
                    }
                }
            }
            _ => {}
        }
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        let Some(w) = &self.window else { return };
        match self.pace {
            // uncapped (VSYNC=0): poll-and-redraw as before
            None => w.request_redraw(),
            // paced: draw when the frame clock says so, otherwise sleep until
            // it does — input events still wake the loop instantly
            Some(_) => {
                if std::time::Instant::now() >= self.next_frame {
                    w.request_redraw();
                } else {
                    event_loop.set_control_flow(winit::event_loop::ControlFlow::WaitUntil(self.next_frame));
                }
            }
        }
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cfg = Config::from_env();
    // SHOT and DEMO run FULLY headless: no winit loop, no window, no surface/
    // swapchain device extensions. The offscreen extent comes verbatim from
    // WINDOW (default 1280x800), so captures are byte-reproducible — the WM
    // never gets a say in the size. SHOT keeps the windowed frame sequence:
    // draw() until harness_post_frame fires the SHOT and exits. DEMO plays a
    // gameplay trace one tick per draw(), dumping a PNG per tick.
    if cfg.harness.shot.is_some() || cfg.harness.demo.is_some() {
        let mut r = unsafe { Viewer::new(None, cfg)? };
        while !r.exit_requested {
            unsafe { r.draw() };
        }
        return Ok(());
    }
    let event_loop = EventLoop::new()?;
    event_loop.set_control_flow(winit::event_loop::ControlFlow::Poll);
    let mut app = App { cfg: Some(cfg), window: None, renderer: None, fs_at: None, pace: None, next_frame: std::time::Instant::now() };
    event_loop.run_app(&mut app)?;
    // quitting mid-recording still delivers the clip: flush the buffered
    // frames into an encode, then wait for every encode worker to finish
    if let Some(r) = app.renderer.as_mut() {
        r.finish_recording();
        r.join_clip_jobs();
    }
    Ok(())
}
