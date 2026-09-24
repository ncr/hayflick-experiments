//! Interactive ISO_VIEW_CONTRACT viewer — a winit window over the
//! deterministic hardware-RT renderer (`rt_probe::render`). Every frame is a
//! pure function of (scene, camera): no accumulation, no denoiser, no
//! temporal state. Monte Carlo runs once at startup into the world-space GI
//! probe cache.
//!
//! Controls (player input becomes tick-stamped gym `Command`s — the sim runs
//! on a fixed 60 Hz loop; the viewer only presents):
//! - LMB / trackpad tap — click-to-move (unprojected to a ground cell; the
//!   shell plans a string-pulled route, `gym::route::Route`, and steers the
//!   one continuous mover along it)
//! - WASD / arrows — screen-relative continuous walk
//! - Shift — run; C — toggle crouch; Ctrl — hold crouch
//! - q / e — smooth eased quarter turn (presentation-only)
//! - scroll / +- — integer zoom steps 1-4, cursor-anchored; 0 = camera reset
//! - Tab — creative mode (build ↔ play): the toolbar, the free camera and
//!   the brushes (creative_host.rs); the world pauses while building
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
mod concrete;
mod terrain;
mod survivor;
mod demos;
mod flags;
mod gym_loop;
mod gym_scene;
mod hud;
mod creative_host;
mod play_script;
mod level_host;
mod input;
mod look;
mod menu;
mod painted;
mod foliage;
mod street_props;
mod phys_scene;
mod view;
mod viewer;
// the structural GLSL↔MSL twin diff (tests only)
#[cfg(test)]
mod twin;
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
use winit::keyboard::{Key, NamedKey, KeyCode, PhysicalKey};
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
                // Track physical releases BEFORE a menu can consume the event.
                let movement = if let PhysicalKey::Code(key) = event.physical_key {
                    let active = !r.menu_open();
                    let handled = r.keys.update(key, event.state.is_pressed(), event.repeat, active);
                    // building: the same held keys pan the camera
                    // (Viewer::creative_pan) instead of walking the player
                    if !r.creative.open {
                        r.gym.held = r.keys.movement();
                        r.gym.run_held = r.keys.run();
                        r.gym.crouch_held = r.keys.crouch();
                    }
                    handled
                } else { false };
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
                if movement { return; }
                if !event.state.is_pressed() {
                    return; // discrete actions fire on press only
                }
                // CREATIVE MODE owns its keys: tools 1-4, undo/redo, Esc
                // cancels the gesture in flight (or leaves), Tab plays
                if r.creative.open && !event.repeat {
                    if let PhysicalKey::Code(key) = event.physical_key {
                        let ctrl = r.keys.crouch(); // Ctrl is tracked as held
                        let tool = match key {
                            KeyCode::Digit1 => Some(0),
                            KeyCode::Digit2 => Some(1),
                            KeyCode::Digit3 => Some(2),
                            KeyCode::Digit4 => Some(3),
                            KeyCode::Digit5 => Some(4),
                            KeyCode::Digit6 => Some(5),
                            KeyCode::Digit7 => Some(6),
                            KeyCode::Digit8 => Some(7),
                            KeyCode::Digit9 => Some(8),
                            KeyCode::Digit0 => Some(9),
                            _ => None,
                        };
                        if let Some(i) = tool {
                            r.creative_set_tool(i);
                            return;
                        }
                        match key {
                            KeyCode::KeyZ if ctrl && r.keys.run() => return r.creative_redo(),
                            KeyCode::KeyZ if ctrl => return r.creative_undo(),
                            KeyCode::KeyY if ctrl => return r.creative_redo(),
                            KeyCode::Escape => return r.creative_cancel(),
                            KeyCode::F1 => return r.creative_set_group(0),
                            KeyCode::F2 => return r.creative_set_group(1),
                            KeyCode::F3 => return r.creative_set_group(2),
                            KeyCode::F4 => return r.creative_set_group(3),
                            KeyCode::F5 => return r.creative_set_group(4),
                            KeyCode::KeyR => return r.creative_turn(),
                            KeyCode::Tab => return r.creative_toggle(),
                            _ => {}
                        }
                    }
                }
                if let PhysicalKey::Code(key) = event.physical_key {
                    if let Some(delta) = input::camera_turn(key, event.repeat) {
                        r.start_rotate(delta);
                        return;
                    }
                    if key == KeyCode::KeyC && !event.repeat {
                        r.gym.crouch_toggle = !r.gym.crouch_toggle;
                        return;
                    }
                }
                match event.logical_key.as_ref() {
                    // same repeat guard as the modal branch: one physical
                    // press, one toggle
                    Key::Named(NamedKey::Escape) if !event.repeat => r.menu_toggle(),
                    // Tab: play ↔ build (creative mode, 2026-09-22)
                    Key::Named(NamedKey::Tab) if !event.repeat => r.creative_toggle(),
                    Key::Character("=") | Key::Character("+") => {
                        let c = r.view.cursor;
                        r.zoom_step(1, c);
                    }
                    Key::Character("-") | Key::Character("_") => {
                        let c = r.view.cursor;
                        r.zoom_step(-1, c);
                    }
                    Key::Character("0") => {
                        // camera reset: recentre on the player, canonical yaw
                        r.view.zoom = 1.0;
                        r.view.target = r.gym.cam_target();
                        r.view.move_accum = Vec2::ZERO;
                        r.recenter_pan();
                        r.rotate(-(r.view.yaw_q as i32));
                    }
                    // the first gameplay loop (2026-09-24): F searches what is
                    // in reach, I opens the bag
                    Key::Character("f") if !event.repeat => r.gym.search_now(),
                    Key::Character("i") if !event.repeat => r.gym.show_inventory = !r.gym.show_inventory,
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
                // stale drag keeps editing the menu
                if let Some(r) = self.renderer.as_mut() {
                    r.clear_live_input();
                    r.menu.drag = false;
                    r.menu.drag_pending = false;
                }
            }
            WindowEvent::CursorMoved { position, .. } => {
                if let Some(r) = self.renderer.as_mut() {
                    let np = Vec2::new(position.x as f32, position.y as f32);
                    r.view.cursor = np;
                    if r.creative.open {
                        r.creative_move(np);
                    }
                    // COALESCED: the drag applies once per frame (RedrawRequested),
                    // from the latest cursor — a 1000 Hz mouse applying a slider
                    // per EVENT builds a backlog the frame loop can never drain
                    // (see MenuState::drag_pending).
                    if r.menu.drag {
                        r.menu.drag_pending = true;
                    }
                }
            }
            // creative mode: right button removes (walls, buildings, lamps)
            WindowEvent::MouseInput { state, button: MouseButton::Right, .. } => {
                if let Some(r) = self.renderer.as_mut() {
                    if r.creative.open && !r.menu_open() {
                        let c = r.view.cursor;
                        if state == ElementState::Pressed {
                            r.creative_press(c, house_game::gym::creative::Button::Remove);
                        } else {
                            r.creative_release(house_game::gym::creative::Button::Remove);
                        }
                    }
                }
            }
            WindowEvent::MouseInput { state, button: MouseButton::Left, .. } if self.renderer.as_ref().is_some_and(|r| r.creative.open && !r.menu_open()) => {
                if let Some(r) = self.renderer.as_mut() {
                    let c = r.view.cursor;
                    if state == ElementState::Pressed {
                        r.creative_press(c, house_game::gym::creative::Button::Build);
                    } else {
                        r.creative_release(house_game::gym::creative::Button::Build);
                    }
                }
            }
            WindowEvent::MouseInput { state, button: MouseButton::Left, .. } => {
                if let Some(r) = self.renderer.as_mut() {
                    if state == ElementState::Pressed {
                        let c = r.view.cursor;
                        // outside a menu a world click is the game's
                        if !r.menu_click(c) {
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
