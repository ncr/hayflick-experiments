//! Interactive ISO_VIEW_CONTRACT viewer — a winit window over the
//! deterministic hardware-RT renderer (`rt_probe::render`). Every frame is a
//! pure function of (scene, camera): no accumulation, no denoiser, no
//! temporal state. Monte Carlo runs once at startup into the world-space GI
//! probe cache.
//!
//! Controls (player input becomes tick-stamped town `Command`s — the sim runs
//! on a fixed 60 Hz loop; the viewer only presents):
//! - LMB / trackpad tap — click-to-move (unprojected to a ground cell; the
//!   shell BFS-plans the route, the sim owns the step cadence)
//! - WASD / arrows — screen-relative walk (staircase on the iso lattice)
//! - Shift — run, Ctrl — sneak
//! - q / e — smooth eased quarter turn (presentation-only)
//! - scroll / +- — integer zoom steps 1-4, cursor-anchored; 0 = camera reset
//! - l — lamp master on/off
//! - r — record a clip at exact game resolution: stop writes BOTH
//!   clips/clip_NNNN.mp4 (x264, NEAREST 4x) and .gif (palette, 1x, half rate)
//! - Esc — the game menu (Title at boot; Pause in play; Settings is a
//!   submenu with live sliders; Seeds picks a fresh town)
//!
//! The scene is the generated town testbed (SEED env varies it; the menu's
//! SEEDS picker relaunches with a new one — docs/VISION.md Faza 0).
//!
//! Headless harness (see config.rs): SHOT / SHOT_DELAY one-frame capture
//! (truly window-less — no surface/swapchain, extent taken from WINDOW;
//! the wall clock NEVER ticks the sim in SHOT mode), CMDS / CMDS_TICKS
//! deterministic command-trace replay prefix (town trace format),
//! DEMO / DEMO_DIR / DEMO_TICKS per-tick gameplay dump, ROTATE_AT synthetic
//! input, DUMP / DUMP_AT / DUMP_N frame dumps, MOVIE scripted tour,
//! FRAMES / TIMING perf, WINDOW=WxH exact size.

mod audio;
mod backend;
mod capture;
mod look;
mod menu;
mod town_loop;
mod town_scene;
mod view;
mod viewer;
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
}

impl ApplicationHandler for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }
        let cfg = self.cfg.take().expect("config consumed once");
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
                        Key::Named(NamedKey::Enter) | Key::Named(NamedKey::Space) => {
                            r.menu_activate();
                            return;
                        }
                        Key::Named(NamedKey::Escape) => {
                            r.menu_toggle();
                            return;
                        }
                        _ => return, // menus are modal: swallow the rest
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
                    r.town.held[i] = event.state.is_pressed();
                    return;
                }
                // movement modes (held)
                match event.logical_key.as_ref() {
                    Key::Named(NamedKey::Shift) => {
                        r.town.run_held = event.state.is_pressed();
                        return;
                    }
                    Key::Named(NamedKey::Control) => {
                        r.town.sneak_held = event.state.is_pressed();
                        return;
                    }
                    _ => {}
                }
                if !event.state.is_pressed() {
                    return; // discrete actions fire on press only
                }
                match event.logical_key.as_ref() {
                    Key::Named(NamedKey::Escape) => r.menu_toggle(),
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
                        r.view.target = r.town.cam_target();
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
                    _ => {}
                }
            }
            WindowEvent::CursorMoved { position, .. } => {
                if let Some(r) = self.renderer.as_mut() {
                    let np = Vec2::new(position.x as f32, position.y as f32);
                    if r.menu.drag {
                        r.menu_drag_to(np); // slider drag
                    }
                    r.view.cursor = np;
                }
            }
            WindowEvent::MouseInput { state, button: MouseButton::Left, .. } => {
                if let Some(r) = self.renderer.as_mut() {
                    if state == ElementState::Pressed {
                        let c = r.view.cursor;
                        if !r.menu_click(c) {
                            r.town_click(c); // click-to-move
                        }
                    } else {
                        r.menu.drag = false;
                    }
                }
            }
            WindowEvent::MouseWheel { delta, .. } => {
                if let Some(r) = self.renderer.as_mut() {
                    let dy = match delta {
                        MouseScrollDelta::LineDelta(_, y) => y,
                        MouseScrollDelta::PixelDelta(p) => p.y as f32 / 50.0,
                    };
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
            }
            WindowEvent::RedrawRequested => {
                if let (Some(r), Some(w)) = (&mut self.renderer, &self.window) {
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

    fn about_to_wait(&mut self, _event_loop: &ActiveEventLoop) {
        if let Some(w) = &self.window {
            w.request_redraw();
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
    let mut app = App { cfg: Some(cfg), window: None, renderer: None };
    event_loop.run_app(&mut app)?;
    // quitting mid-recording still delivers the clip: flush the buffered
    // frames into an encode, then wait for every encode worker to finish
    if let Some(r) = app.renderer.as_mut() {
        r.finish_recording();
        r.join_clip_jobs();
    }
    Ok(())
}
