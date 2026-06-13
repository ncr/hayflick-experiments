//! Interactive ISO_VIEW_CONTRACT viewer — a winit window over the
//! deterministic hardware-RT renderer (`rt_probe::render`). Every frame is a
//! pure function of (scene, camera): no accumulation, no denoiser, no
//! temporal state. Monte Carlo runs once at startup into the world-space GI
//! probe cache (two light banks: room lights off / full, lerped in-shader).
//!
//! Controls (player input becomes tick-stamped `house_game::Command`s — the
//! sim runs on a fixed 60 Hz loop; the viewer only presents):
//! - LMB — click-to-walk (unprojected to a world pick ray + ground point;
//!   the game resolves door-vs-walk); in scenes without a player, drag pans
//! - RMB — shoot (hitscan along the pick ray)
//! - WASD / arrows — walk the player (held = one Move command per tick,
//!   camera follows) or pan the camera in scenes without a player
//! - q / e — smooth eased quarter turn (presentation; the quarter itself is
//!   SIM state via Command::RotateCamera, so walks/replays are deterministic)
//! - scroll / +- — integer zoom steps 1-4, cursor-anchored; 0 = camera reset
//! - f — player flashlight (Command::ToggleFlashlight; power/cone in the
//!   menu; FLASH / FLASH_POWER / FLASH_CONE seed it)
//! - l — room lights on/off (LIGHTS dims; indirect follows in the same frame
//!   via the pre-baked probe banks)
//! - r — record a clip at exact game resolution: stop writes BOTH
//!   clips/clip_NNNN.mp4 (x264, NEAREST 4x) and .gif (palette, 1x, half rate)
//! - Esc — tune menu (sliders + toggles + quit; also the hamburger icon
//!   top-left). Closing the menu prints the env string that reproduces the
//!   dialed-in values.
//!
//! Scenes (SCENE=): house (default, dollhouse walls + player), lab (renderer
//! isolation), grid (the web grid-walker rematch: fixed camera, open level).
//!
//! Headless harness (see config.rs): SHOT / SHOT_DELAY one-frame capture
//! (truly window-less — no surface/swapchain, extent taken from WINDOW;
//! the wall clock NEVER ticks the sim in SHOT mode), CMDS / CMDS_TICKS
//! deterministic command-trace replay prefix (house-game trace format),
//! ROTATE_AT synthetic input, DUMP / DUMP_AT / DUMP_N frame dumps,
//! MOVIE scripted tour, FRAMES / TIMING perf, WINDOW=WxH exact size.

mod capture;
mod menu;
mod renderer;
mod sim;
mod view;

use glam::Vec2;
use house_game::Command;
use menu::MENU;
use renderer::Renderer;
use rt_probe::Config;
use std::sync::Arc;
use winit::application::ApplicationHandler;
use winit::event::{ElementState, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, EventLoop};
use winit::keyboard::{Key, NamedKey};
use winit::window::{Window, WindowId};

struct App {
    cfg: Option<Config>,
    window: Option<Arc<Window>>,
    renderer: Option<Renderer>,
}

impl ApplicationHandler for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }
        let cfg = self.cfg.take().expect("config consumed once");
        let (w, h) = cfg.window.unwrap_or((1280, 800));
        let attrs = Window::default_attributes().with_title("rt-probe — iso viewer").with_inner_size(winit::dpi::LogicalSize::new(w as f64, h as f64));
        let window = Arc::new(event_loop.create_window(attrs).unwrap());
        let renderer = unsafe { Renderer::new(Some(&window), cfg).expect("renderer init") };
        self.window = Some(window);
        self.renderer = Some(renderer);
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => event_loop.exit(),
            WindowEvent::KeyboardInput { event, .. } => {
                let Some(r) = self.renderer.as_mut() else { return };
                // open menu captures the arrows + enter (WASD still walks)
                if r.menu.open && event.state.is_pressed() {
                    match event.logical_key.as_ref() {
                        Key::Named(NamedKey::ArrowUp) => {
                            r.menu.sel = (r.menu.sel + MENU.len() - 1) % MENU.len();
                            return;
                        }
                        Key::Named(NamedKey::ArrowDown) => {
                            r.menu.sel = (r.menu.sel + 1) % MENU.len();
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
                        _ => {}
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
                    r.game.held[i] = event.state.is_pressed();
                    return;
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
                        // camera reset only — the player's position is SIM
                        // state now (no teleport command exists; recentre on
                        // the player instead of moving them home)
                        r.view.zoom = 1.0;
                        r.view.target = r.game.snap.player_pos;
                        r.view.move_accum = Vec2::ZERO;
                        r.recenter_pan();
                        // back to canonical: cancels any in-flight sweep,
                        // restores masks, snaps the target
                        r.rotate(-(r.view.yaw_q as i32));
                    }
                    // toggles ignore key repeat: holding the key must not strobe
                    Key::Character("r") if !event.repeat => r.toggle_recording(),
                    Key::Character("f") if !event.repeat => {
                        r.game.push(Command::ToggleFlashlight);
                        println!("flashlight: {}", if r.game.snap.flashlight { "off" } else { "on" });
                    }
                    Key::Character("l") if !event.repeat => {
                        let v = if r.room_lights > 0.0 { 0.0 } else { 1.0 };
                        r.tune_set("lights", v);
                        println!("room lights: {}", if v > 0.0 { "on" } else { "off" });
                    }
                    _ => {}
                }
            }
            WindowEvent::CursorMoved { position, .. } => {
                if let Some(r) = self.renderer.as_mut() {
                    let np = Vec2::new(position.x as f32, position.y as f32);
                    if r.menu.drag {
                        r.menu_drag_to(np); // slider drag
                    } else if r.view.dragging {
                        // playerless scenes only: the world follows the
                        // cursor, so the target moves opposite the drag
                        let rs = r.rs() as f32;
                        let d = np - r.view.cursor;
                        r.pan_camera_px(-(d / rs));
                    }
                    r.view.cursor = np;
                }
            }
            WindowEvent::MouseInput { state, button: MouseButton::Left, .. } => {
                if let Some(r) = self.renderer.as_mut() {
                    if state == ElementState::Pressed {
                        let c = r.view.cursor;
                        if !r.menu_click(c) {
                            if r.game.has_player {
                                r.click_command(c); // click-to-walk / use door
                            } else {
                                r.view.dragging = true; // lab: drag pans
                            }
                        }
                    } else {
                        r.view.dragging = false;
                        r.menu.drag = false;
                    }
                }
            }
            WindowEvent::MouseInput { state: ElementState::Pressed, button: MouseButton::Right, .. } => {
                if let Some(r) = self.renderer.as_mut() {
                    let c = r.view.cursor;
                    r.shoot_command(c);
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
                        unsafe { r.recreate_swapchain(size.width, size.height) };
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
                            unsafe { r.recreate_swapchain(s.width, s.height) };
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
    // SHOT runs FULLY headless: no winit loop, no window, no surface/swapchain
    // device extensions. The offscreen extent comes verbatim from WINDOW
    // (default 1280x800), so golden captures are byte-reproducible — the WM
    // never gets a say in the size. Same frame sequence as the windowed
    // capture: draw() until harness_post_frame fires the SHOT and exits.
    if cfg.shot.is_some() {
        let mut r = unsafe { Renderer::new(None, cfg)? };
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
