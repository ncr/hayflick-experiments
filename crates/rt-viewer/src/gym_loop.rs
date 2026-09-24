//! The gym sim side of the viewer: a fixed-tick `GymGame` loop + the
//! snapshot→renderer adapter (docs/VISION.md Faza 0).
//!
//! Presentation choices, all sim-blind:
//! - keyboard movement feeds the headless sim's fixed-tick continuous mover;
//!   click-to-move and old replay traces retain their cell-step commands, with
//!   the shell easing those legacy steps between centres,
//! - MOUSE-first controls: LMB picks a ground cell, the shell BFS-plans a
//!   route over the sim's own grid and feeds one Move per tick — the sim
//!   still owns the cadence, and a replay trace stays pure Move commands.
//!   WASD is SCREEN-relative continuous input through the active projection.
//!   Shift = run.

use crate::backend::Stamp;
use crate::gym_scene::{cell_world, WALL_CUT_H};
use crate::menu::{mrect, mtext};
use glam::{Mat4, Vec2, Vec3};
use house_game::gym::grid::CellKind;
use house_game::gym::route::Route;
use house_game::gym::sim::{Carry, Command, GymGame, GymLevel, GymSnapshot, MoveMode};
use house_game::gym::trace::{hold, parse_trace};
use house_game::TICK_DT;
use iso_core::{world_to_window_px, Projection, ViewXform};
use phys_spike::PhysWorld;
use rt_probe::{Config, InstanceKey, SceneHandles};
use sim_core::{FixedLoop, InputQueue, Simulation, Tick};

// Marker palette (the click-to-move destination tag).
const BG: u32 = 0x12151a;
const AMBER: u32 = 0xe8853c;
const INK: u32 = 0xd0d0c0;

/// The ground height the body stands on: the terrain on street levels, the
/// gym's floor slab elsewhere.
fn ground_at(spec: &GymLevel, xz: Vec2) -> f32 {
    if spec.neighborhood {
        crate::terrain::height_at(spec, xz)
    } else {
        crate::gym_scene::FLOOR_TOP
    }
}

pub struct GymLoop {
    pub fixed: FixedLoop,
    pub queue: InputQueue<Command>,
    pub sim: GymGame,
    pub tick: Tick,
    pub cmds_prefix: u64,
    pub snap: GymSnapshot,
    pub spec: GymLevel,
    /// Held movement keys [up, down, left, right] (screen-relative).
    pub held: [bool; 4],
    pub run_held: bool,
    pub crouch_held: bool,
    pub crouch_toggle: bool,
    /// Actual animated camera yaw, mirrored before each simulation advance so
    /// WASD stays screen-relative through (and during) q/e turns.
    pub yaw_deg: f32,
    /// The live click-to-move route (None = keyboard/standing). Shell state:
    /// the sim only ever sees the per-tick world-input commands it steers.
    plan: Option<Route>,
    /// A click on a prop (its index): walk the route to it, then search it
    /// the moment it is in reach.
    pending_search: Option<usize>,
    /// The inventory panel is open (I). Presentation only.
    pub show_inventory: bool,
    /// Projection used to interpret screen-relative movement.
    pub proj: Projection,
    /// The player's body (the `avatar` crate): ticked on the fixed clock
    /// from the fresh snapshot, skinned into the scene's "player" run.
    pub player: crate::player::Player,
    /// The crouch keys' state the DEMO path last turned into a command.
    demo_crouch_keys: bool,
    /// Camera target the follow-cam last consumed.
    pub last_cam: Vec3,
    /// Destructibility spike: a box3d rigid-body world stepped once per fixed
    /// tick, rendered as extra `phys/{i}` dynamic runs — the wall-smash demo's
    /// debris (armed at its beat). `None` in the normal gym. NOT part of
    /// `state_hash` — presentation-layer physics.
    pub phys: Option<PhysWorld>,
}

impl GymLoop {
    #[allow(dead_code)]
    pub fn new(spec: GymLevel) -> GymLoop {
        let proj = iso_core::by_name("trimetric").expect("trimetric preset");
        Self::with_projection(spec, proj)
    }

    pub fn with_projection(spec: GymLevel, proj: Projection) -> GymLoop {
        Self::with_carry(spec, proj, Carry::default())
    }

    /// A fresh loop on `spec` carrying in what the player brought from the
    /// last level (an exit's level switch).
    pub fn with_carry(spec: GymLevel, proj: Projection, carry: Carry) -> GymLoop {
        let sim = GymGame::with_carry(spec.clone(), carry);
        let snap = sim.snapshot();
        let mut p0 = cell_world(snap.player);
        if spec.neighborhood {p0.y=crate::terrain::height_at(&spec, snap.position);}
        let player = crate::player::Player::new(snap.position, |xz| ground_at(&spec, xz));
        GymLoop {
            fixed: FixedLoop::new(TICK_DT),
            queue: InputQueue::new(),
            sim,
            tick: Tick(0),
            cmds_prefix: 0,
            snap,
            spec,
            held: [false; 4],
            run_held: false,
            crouch_held: false,
            crouch_toggle: false,
            yaw_deg: 0.0,
            plan: None,
            pending_search: None,
            show_inventory: false,
            proj,
            player,
            demo_crouch_keys: false,
            last_cam: p0,
            phys: None,
        }
    }

    pub fn cancel_live_input(&mut self) {
        self.held = [false; 4];
        self.run_held = false;
        self.crouch_held = false;
        self.plan = None;
        self.pending_search = None;
    }

    /// Update the movement basis when the settings menu changes projection.
    pub fn set_projection(&mut self, proj: Projection) {
        self.proj = proj;
    }

    /// Step the physics spike one fixed tick (no-op unless the smash beat
    /// attached a world). Called from every tick-advancing path so physics
    /// stays locked to the sim clock — DEMO captures reproduce.
    fn phys_step(&mut self) {
        if let Some(p) = &mut self.phys {
            p.step();
        }
    }

    pub fn time(&self) -> f32 {
        self.tick.0 as f32 * TICK_DT
    }

    fn screen_input(&self) -> (i16, i16) {
        (
            self.held[3] as i16 - self.held[2] as i16,
            self.held[1] as i16 - self.held[0] as i16,
        )
    }

    /// Convert the held screen direction through the actual projection. This
    /// is the same inverse lattice used by clicks and the camera, so W/A/S/D
    /// keep their screen meaning for both iso21 and trimetric, at every yaw.
    fn world_input(&self) -> Vec3 {
        let (sx, sy) = self.screen_input();
        self.proj.screen_px_to_world(Vec2::new(sx as f32, sy as f32), self.yaw_deg)
    }

    /// Held keys → a normalized, fixed-point world input for the continuous
    /// headless mover. The projection inversion means a screen-cardinal key
    /// is a straight line on screen instead of an alternating grid path.
    fn held_command(&self) -> Option<Command> {
        let (sx, sy) = self.screen_input();
        if sx == 0 && sy == 0 {
            return None;
        }
        let w = self.world_input();
        let v = Vec2::new(w.x, w.z).normalize_or_zero() * house_game::gym::sim::WORLD_INPUT_SCALE;
        Some(Command::MoveWorld { dx: v.x.round() as i16, dz: v.y.round() as i16, mode: self.mode() })
    }

    fn mode(&self) -> MoveMode {
        if self.run_held {
            MoveMode::Run
        } else {
            MoveMode::Walk
        }
    }

    // ---- click-to-move (mouse-first controls) ---------------------------

    /// LMB on the ground: plan a route to the picked point and walk it.
    /// Clicking where the player already stands cancels the route.
    pub fn click_ground(&mut self, g: Vec3) {
        self.plan = Route::plan_in(self.sim.spec(), self.snap.position, Vec2::new(g.x, g.z));
        self.pending_search = None;
    }

    /// LMB on a searchable prop: search it now if it is in reach, else walk
    /// to a point beside it and search on arrival. An already searched prop
    /// is just walked to.
    pub fn click_prop(&mut self, i: usize) {
        if self.sim.search_target() == Some(i) {
            self.search_now();
            return;
        }
        let Some(stand) = self.sim.spec().approach(i, self.snap.position) else { return };
        self.plan = Route::plan_in(self.sim.spec(), self.snap.position, stand);
        let searched = self.sim.carry().searched.contains(&house_game::gym::sim::prop_key(&self.sim.spec().props[i]));
        self.pending_search = (self.plan.is_some() && !searched).then_some(i);
    }

    /// F: search what is in reach (the sim decides what that is).
    pub fn search_now(&mut self) {
        self.plan = None;
        self.pending_search = None;
        self.queue.push(self.tick, Command::Search);
    }

    /// After the route steered this tick: a clicked prop is searched the
    /// tick it comes into reach — usually as the route arrives, but also when
    /// the route stalls against a neighbour short of its goal (two barrels
    /// side by side) with the prop already within arm's length, or as the
    /// body coasts in after the route let go. A body that comes to rest out
    /// of reach drops the click.
    fn arrive_and_search(&mut self) {
        let Some(i) = self.pending_search else { return };
        if self.sim.search_target() == Some(i) {
            self.plan = None;
            self.pending_search = None;
            self.queue.push(self.tick, Command::Search);
        } else if self.plan.is_none() && self.sim.snapshot().velocity == Vec2::ZERO {
            // the route ended and the body has coasted to rest out of reach
            self.pending_search = None;
        }
    }

    /// How far the body would still travel if input stopped THIS tick —
    /// `v² / 2a` against the sim's braking rate. The route stops steering
    /// once the goal is inside it, so the body coasts to a halt ON the goal
    /// instead of arriving at full speed and oscillating around it.
    fn stop_distance(&self) -> f32 {
        let v = self.snap.velocity.length();
        v * v / (2.0 * house_game::gym::sim::BRAKE_WU_PER_S2)
    }

    /// Feed the live route one tick: steer at the next corner and push the
    /// resulting world input — the SAME command the keyboard produces.
    fn plan_step(&mut self) {
        if self.plan.is_none() {
            return;
        }
        let pos = self.sim.snapshot().position;
        let stop = self.stop_distance();
        let plan = self.plan.as_mut().expect("checked above");
        let Some(dir) = plan.steer(pos, stop) else {
            // Arrived: drop the route and feed nothing, so the sim's own
            // braking settles the body instead of a step landing it.
            self.plan = None;
            return;
        };
        let v = dir * house_game::gym::sim::WORLD_INPUT_SCALE;
        let mode = self.mode();
        self.queue.push(self.tick, Command::MoveWorld { dx: v.x.round() as i16, dz: v.y.round() as i16, mode });
    }

    /// Advance the accumulator and run the due ticks; held keys synthesize the
    /// world input (keyboard overrides any mouse route), else the route steers
    /// one. Both paths emit the same command, so there is one mover.
    pub fn run_due(&mut self, real_dt: f32) -> u32 {
        let n = self.fixed.advance(real_dt);
        for _ in 0..n {
            let crouching = self.crouch_toggle || self.crouch_held;
            if self.sim.snapshot().crouching != crouching {
                self.queue.push(self.tick, Command::Crouch(crouching));
            }
            if let Some(command) = self.held_command() {
                self.plan = None;
                self.pending_search = None;
                self.queue.push(self.tick, command);
            } else {
                // before steering: a search this tick must not share the
                // tick with a step (walking breaks a search off)
                self.arrive_and_search();
                self.plan_step();
            }
            let cmds = self.queue.drain_for(self.tick);
            self.sim.tick(self.tick, &cmds);
            self.tick.0 += 1;
            self.body_tick();
            self.phys_step();
        }
        if n > 0 {
            self.refresh();
        }
        n
    }

    /// DEMO: one tick per rendered frame (deterministic gameplay capture).
    pub fn demo_advance_tick(&mut self) {
        // A let's-play script holds keys through the same fields the window
        // does: a held direction is this tick's move (and cancels a route,
        // as live), and the crouch keys act on CHANGE only — a plain DEMO
        // trace owns the crouch state with its own `crouch` commands.
        let crouch_keys = self.crouch_toggle || self.crouch_held;
        if crouch_keys != self.demo_crouch_keys {
            self.demo_crouch_keys = crouch_keys;
            self.queue.push(self.tick, Command::Crouch(crouch_keys));
        }
        if let Some(command) = self.held_command() {
            self.plan = None;
            self.pending_search = None;
            self.queue.push(self.tick, command);
        }
        // A live route steers here too, so a `WALK_TO=` capture records the
        // mouse path frame by frame exactly as the interactive loop walks it.
        self.arrive_and_search();
        self.plan_step();
        let cmds = self.queue.drain_for(self.tick);
        self.sim.tick(self.tick, &cmds);
        self.tick.0 += 1;
        self.body_tick();
        self.phys_step();
        self.refresh();
    }

    /// DEMO=trace.txt (gym trace grammar): queue every command, return the
    /// tick count to play.
    pub fn demo_load(&mut self, cfg: &Config) -> u64 {
        let path = cfg.harness.demo.as_ref().expect("demo_load only on DEMO path");
        let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("DEMO {path}: {e}"));
        let trace = parse_trace(&text).unwrap_or_else(|e| panic!("DEMO: {e}"));
        let ticks = cfg.harness.demo_ticks.unwrap_or_else(|| trace.iter().map(|(t, _)| t.0 + 1).max().unwrap_or(0));
        let n = trace.len();
        // offset by the boot tick: a CMDS prefix already advanced the clock
        let at = self.tick.0;
        for (t, c) in hold(&trace, ticks) {
            let t = sim_core::Tick(t.0 + at);
            self.queue.push(t, c);
        }
        println!("DEMO(gym): {n} commands, playing {ticks} ticks from {path}");
        ticks
    }

    /// `WALK_TO=x,z`: replay ONE click-to-move at boot. A trace can express
    /// held keys because those ARE commands; a click is a shell gesture that
    /// only produces commands once a route exists, so it needs its own knob.
    /// Without it the mouse half of the mover has no headless form at all,
    /// which is how it kept a separate implementation for as long as it did.
    pub fn walk_to_from_env(&mut self, cfg: &Config) {
        if let Some((x, z)) = cfg.game.walk_to {
            self.click_ground(Vec3::new(x, 0.0, z));
            println!("WALK_TO: route to ({x}, {z}) — {} legs", self.plan.as_ref().map_or(0, |p| p.points().len()));
        }
    }

    /// CMDS=trace.txt: a deterministic startup replay prefix.
    pub fn run_cmds(&mut self, cfg: &Config) {
        let Some(path) = &cfg.game.cmds else { return };
        let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("CMDS {path}: {e}"));
        let trace = parse_trace(&text).unwrap_or_else(|e| panic!("CMDS: {e}"));
        let ticks = cfg.game.cmds_ticks.unwrap_or_else(|| trace.iter().map(|(t, _)| t.0 + 1).max().unwrap_or(0));
        let n = trace.len();
        for (t, c) in hold(&trace, ticks) {
            self.queue.push(t, c);
        }
        for _ in 0..ticks {
            let cmds = self.queue.drain_for(self.tick);
            self.sim.tick(self.tick, &cmds);
            self.tick.0 += 1;
            self.body_tick();
            self.phys_step();
        }
        self.cmds_prefix = self.tick.0;
        self.refresh();
        println!("CMDS(gym): {n} commands over {ticks} ticks — state {:016x}", self.sim.state_hash());
    }

    /// Advance the body one fixed tick from the FRESH snapshot — every
    /// tick-advancing path (live, DEMO, the CMDS prefix) calls this, so a
    /// replayed pose is the live pose. The body measures the distance the sim
    /// ACTUALLY covered itself, so it cannot walk in place against a wall.
    fn body_tick(&mut self) {
        let snap = self.sim.snapshot();
        let input = avatar::Input { position: snap.position, velocity: snap.velocity, intent: snap.intent, contact: snap.contact, crouching: snap.crouching };
        let spec = &self.spec;
        self.player.tick(&input, |xz| ground_at(spec, xz));
    }

    fn refresh(&mut self) {
        self.snap = self.sim.snapshot();
    }

    fn sim_position_world(&self) -> Vec3 {
        let y = if self.spec.neighborhood {crate::terrain::height_at(&self.spec, self.snap.position)}else{cell_world(self.snap.player).y};
        Vec3::new(self.snap.position.x, y, self.snap.position.y)
    }

    fn render_position(&self) -> Vec3 {
        self.sim_position_world()
    }

    /// The camera's follow anchor: the sim's own continuous position, for
    /// every input device.
    pub fn cam_target(&self) -> Vec3 {
        self.render_position()
    }

    /// Is the player inside the building? Drives the dollhouse cutaway.
    pub fn indoors(&self) -> bool {
        self.sim.grid().cell(self.snap.player) == CellKind::Room
    }

    /// The WALLCUT sill-height cutaway: on while the player is indoors —
    /// every occluder wall drops to sill height so the interior reads like a
    /// dollhouse. A pure function of the player's cell.
    pub fn wall_cut(&self) -> Option<f32> {
        self.indoors().then_some(WALL_CUT_H)
    }

    // ---- per-frame instance skinning ------------------------------------

    /// The player's instance transform (the translation its skinned
    /// vertices are relative to).
    pub fn instances(&self, handles: &SceneHandles) -> Vec<(InstanceKey, Mat4)> {
        self.player.instance(handles).into_iter().collect()
    }

    /// This tick's skinned body for the renderer (`FrameState::skin`).
    pub fn skin<'a>(&'a self, handles: &SceneHandles) -> Vec<(InstanceKey, &'a [rt_probe::scene::Vertex])> {
        self.player.skin(handles).into_iter().collect()
    }

    /// Physics-spike movers: each box3d box's world transform, joined onto
    /// its `phys/{i}` run. Appended to `instances` — same TLAS-refit path
    /// as the player limbs. Empty in the normal gym.
    pub fn phys_instances(&self, handles: &SceneHandles) -> Vec<(InstanceKey, Mat4)> {
        let mut out = Vec::new();
        if let Some(p) = &self.phys {
            for (i, m) in p.box_transforms().into_iter().enumerate() {
                if let Some(k) = handles.instances.get(&format!("phys/{i}")).copied() {
                    out.push((k, m));
                }
            }
        }
        out
    }

    // ---- burned-in stamps -------------------------------------------------

    /// The click-to-move destination marker: a pulsing ">" tag over the goal
    /// cell. Rides into SHOT/DEMO captures (part of the game picture).
    pub fn stamps(&self, xf: &ViewXform, ext: (u32, u32), rs: u32) -> Vec<Stamp> {
        let mut out = Vec::new();
        let (ext_w, ext_h) = (ext.0 as i64, ext.1 as i64);
        let s = rs.max(1) as i64;
        let now = self.tick.0;
        if let Some(plan) = &self.plan {
            // The marker sits on the CLICKED point now, not its cell centre —
            // the route walks to where the click landed.
            let g = plan.goal();
            let goal = Vec3::new(g.x, cell_world(self.snap.player).y, g.y);
            let accent = if (now / 8).is_multiple_of(2) { AMBER } else { INK };
            let (pix, w, h) = bubble(">", accent);
            let win = world_to_window_px(goal + Vec3::new(0.0, 0.55, 0.0), xf);
            if win.x > -60.0 && win.y > -60.0 && win.x < ext_w as f32 + 60.0 && win.y < ext_h as f32 + 60.0 {
                let x = (win.x as i64 - (w as i64 * s) / 2).clamp(2, ext_w - w as i64 * s - 2);
                let y = (win.y as i64 - h as i64 * s).clamp(2, ext_h - h as i64 * s - 2);
                out.push(Stamp { pix, w, h, x, y, scale: rs });
            }
        }
        out
    }
}

/// A bordered plate.
fn plate(w: i32, h: i32, bg: u32, border: u32) -> Vec<u32> {
    let mut c = vec![bg; (w * h) as usize];
    mrect(&mut c, w, 0, 0, w, 1, border);
    mrect(&mut c, w, 0, h - 1, w, 1, border);
    mrect(&mut c, w, 0, 0, 1, h, border);
    mrect(&mut c, w, w - 1, 0, 1, h, border);
    c
}

/// A speech bubble with a tail.
pub(crate) fn bubble(label: &str, accent: u32) -> (Vec<u32>, i32, i32) {
    let w = 8 + label.len() as i32 * 8;
    let h = 14 + 3;
    let c = {
        let mut c = plate(w, h - 3, BG, accent);
        mtext(&mut c, w, 4, 3, label, accent);
        c
    };
    let mut full = vec![0u32; (w * h) as usize];
    full[..(w * (h - 3)) as usize].copy_from_slice(&c);
    for (i, tw) in [3i32, 2, 1].iter().enumerate() {
        let y = h - 3 + i as i32;
        mrect(&mut full, w, w / 2 - tw, y, tw * 2, 1, accent);
    }
    (full, w, h)
}

#[cfg(test)]
mod tests {
    use super::*;
    use house_game::gym::grid::CellPos;
    use house_game::gym::sim::gym_level;

    #[test]
    fn wasd_uses_the_visible_camera_through_both_quarter_turns() {
        for proj in iso_core::presets() {
            let mut t = GymLoop::with_projection(gym_level(), *proj);
            t.held[0] = true;
            for degrees in [-179.0, -90.0, -45.0, -12.0, 12.0, 45.0, 90.0, 179.0] {
                t.yaw_deg = degrees;
                let world = t.world_input();
                let (_, right, up) = proj.basis(degrees);
                assert!(world.dot(right).abs() < 0.00001, "W drifts sideways at {degrees} degrees");
                assert!(world.dot(up) > 0., "W reverses at {degrees} degrees");
            }
        }
    }

    #[test]
    fn native_movement_uses_physical_keys_and_always_observes_releases() {
        let src = include_str!("main.rs");
        let keyboard = src.find("event.physical_key").expect("movement must use physical keys; shifted logical W must release w");
        let modal = src.find("if r.menu_open() && event.state.is_pressed()").unwrap();
        assert!(keyboard < modal, "release tracking must precede modal input routing");
    }

    #[test]
    fn replay_prefix_presents_the_same_crouch_as_live_fixed_ticks() {
        let mut live=GymLoop::new(gym_level()); live.crouch_toggle=true;
        for _ in 0..60 {live.run_due(TICK_DT);}
        let path=std::env::temp_dir().join(format!("hayflick-crouch-{}.trace",std::process::id()));
        std::fs::write(&path,"0 crouch on\n59 wait\n").unwrap();
        let mut cfg=Config::from_env();cfg.game.cmds=Some(path.to_string_lossy().into_owned());cfg.game.cmds_ticks=Some(60);
        let mut replay=GymLoop::new(gym_level());replay.run_cmds(&cfg);
        std::fs::remove_file(path).unwrap();
        assert!(live.player.body.crouch > 0.9, "sixty ticks is a full crouch");
        let bits = |t: &GymLoop| t.player.vertices().iter().flat_map(|v| v.pos).map(f32::to_bits).collect::<Vec<_>>();
        assert!(bits(&live) == bits(&replay), "replay snapshot crouches but its pose did not advance");
    }

    #[test]
    fn neighborhood_actor_stands_on_soil_not_the_old_gym_floor() {
        let mut spec=crate::demos::Level::Neighborhood.spec();spec.player_start=CellPos::new(24,20);
        let t=GymLoop::new(spec);
        assert!((t.render_position().y + 0.075).abs()<1e-5);
    }

    /// Codex's click regression (2026-09-05), re-aimed at the ONE mover: the
    /// click runs through `Route` like every other level's, so it must never
    /// teleport, and it arrives the way `Route::steer` defines arriving — the
    /// goal counts as reached inside half a body radius (`GOAL_R`, since the
    /// 1.6 walk of 2026-09-24), and braking coasts it closer. Asserted with
    /// one full body radius of slack.
    #[test]
    fn neighborhood_click_walks_continuously_to_the_goal() {
        let mut spec=crate::demos::Level::Neighborhood.spec();spec.player_start=CellPos::new(24,20);
        let mut t=GymLoop::new(spec);t.click_ground(Vec3::new(24.5,0.0,18.5));
        let mut last=t.snap.position;
        for _ in 0..160 {t.run_due(TICK_DT);assert!(t.snap.position.distance(last)<0.04,"click route teleported instead of walking");last=t.snap.position;}
        assert!(t.plan.is_none(), "the route must have finished");
        assert!(last.distance(Vec2::new(24.5,18.5)) < house_game::gym::sim::PLAYER_RADIUS, "stopped at {last:?}");
    }

    /// W means SCREEN up: the world-axis stairs must follow the active
    /// projection's inverse pixel basis. The old fixed alternation produced
    /// a visible sideways drift under the trimetric game projection.
    #[test]
    fn held_w_follows_the_projection_without_sideways_zigzag() {
        let mut t = GymLoop::new(house_game::gym::sim::GymLevel { props: Vec::new(), exits: Vec::new(), floors: Vec::new(), potholes: Vec::new(), windows: Vec::new(), roofs: Vec::new(), ground: Vec::new(), plants: Vec::new(), paint: Vec::new(),
            neighborhood: false,
            grid: house_game::gym::grid::Grid::new(64, 64),
            player_start: CellPos::new(32, 32),
            lights: Vec::new(),
        });
        t.held[0] = true;
        let start = t.snap.position;
        for _ in 0..64 {
            t.run_due(TICK_DT);
        }
        let delta = start - t.snap.position;
        assert!(delta.x + delta.y > 0.1, "held walk must move: {start:?} -> {:?}", t.snap.position);
        let screen_x = delta.x * t.proj.px_x[0] as f32 + delta.y * t.proj.px_z[0] as f32;
        let screen_y = delta.x * t.proj.px_x[1] as f32 + delta.y * t.proj.px_z[1] as f32;
        assert!(screen_y > 0.0, "screen-up must move upward from the start: ({screen_x}, {screen_y})");
        // a zigzag is whole pixels sideways; this bounds float drift relative
        // to the distance walked
        assert!(screen_x.abs() < 1.0e-4 * screen_y, "screen-up must be a straight line, not a zigzag: ({screen_x}, {screen_y})");
    }

    /// Continuous movement comes to rest without snapping the player back to
    /// the last cell centre or desynchronising presentation from sim truth.
    #[test]
    fn continuous_position_settles_without_a_cell_snap() {
        let mut t = GymLoop::new(gym_level());
        t.held[0] = true;
        for _ in 0..30 {
            t.run_due(TICK_DT);
        }
        t.held[0] = false;
        for _ in 0..30 {
            t.run_due(TICK_DT);
        }
        let eased = t.cam_target();
        let truth = Vec3::new(t.snap.position.x, cell_world(t.snap.player).y, t.snap.position.y);
        assert!((eased - truth).length() < 1e-5, "presentation must follow continuous sim position: {eased} vs {truth}");
        for _ in 0..30 {
            t.run_due(TICK_DT);
        }
        assert!((t.cam_target() - truth).length() < 1e-5, "a stopped player must remain at the continuous position");
    }

    /// The mouse loop end-to-end: click INSIDE the building — the route goes
    /// around the walls, through the doorway, and clears on arrival. Since
    /// 2026-08-09 it drives the CONTINUOUS mover, so this also pins that a
    /// click no longer produces cell snapping: the body arrives with the
    /// route's own goal underfoot and then brakes to rest ON it.
    #[test]
    fn click_routes_through_the_doorway_and_arrives() {
        let mut t = GymLoop::new(gym_level());
        let goal = CellPos::new(5, 5); // inside the one building
        let target = cell_world(goal);
        t.click_ground(target);
        assert!(t.plan.is_some(), "the interior must be reachable via the doorway");
        for _ in 0..900 {
            t.run_due(TICK_DT);
        }
        assert_eq!(t.snap.player, goal, "the route must arrive");
        assert!(t.plan.is_none(), "a finished route clears");
        assert!(t.indoors(), "the goal is indoors");
        assert_eq!(t.wall_cut(), Some(WALL_CUT_H), "indoors turns the dollhouse cutaway on");
        // Arrival means STOPPED on the clicked point, not parked a stopping
        // distance past it.
        assert_eq!(t.snap.velocity, Vec2::ZERO, "the body brakes to rest");
        let miss = (t.snap.position - Vec2::new(target.x, target.z)).length();
        assert!(miss < 0.3, "the body rests on the clicked point, off by {miss}");
    }

    /// The click-to-search loop end to end on the street: click a prop, the
    /// body walks to it, searches it on arrival, and the finds land in the
    /// bag — twice in a row.
    #[test]
    fn clicking_props_walks_to_them_and_searches_them() {
        let mut t = GymLoop::new(crate::demos::Level::Neighborhood.spec());
        let props = t.sim.spec().props.clone();
        let find = |k: house_game::gym::sim::PropKind| props.iter().position(|p| p.kind == k).unwrap();
        for i in [find(house_game::gym::sim::PropKind::Mailbox), find(house_game::gym::sim::PropKind::Car)] {
            t.click_prop(i);
            for _ in 0..600 {
                t.run_due(TICK_DT);
            }
            let key = house_game::gym::sim::prop_key(&props[i]);
            assert!(t.sim.carry().searched.contains(&key), "{:?} was not searched; log {:?}", props[i].kind, t.sim.log());
        }
        assert_eq!(t.sim.log().len(), 2, "{:?}", t.sim.log());
    }

    /// Every searchable prop on the street levels can be reached and
    /// searched from the level's spawn — loot sitting behind a wall or boxed
    /// in by another prop would read as broken.
    #[test]
    fn every_container_on_the_street_is_reachable() {
        for spec in [crate::demos::Level::Neighborhood.spec(), crate::demos::Level::Lot.spec()] {
        for (i, p) in spec.props.iter().enumerate() {
            if house_game::gym::loot::search_ticks(p.kind).is_none() {
                continue;
            }
            let mut t = GymLoop::new(spec.clone());
            t.click_prop(i);
            for _ in 0..1500 {
                t.run_due(TICK_DT);
            }
            let key = house_game::gym::sim::prop_key(p);
            assert!(t.sim.carry().searched.contains(&key), "{:?} at ({}, {}) not searched; body at {:?}, near {:?}, log {:?}", p.kind, p.x, p.z, t.snap.position, t.sim.near_prop(), t.sim.log());
        }
        }
    }

    /// Clicking off the map or the player's own cell leaves no plan.
    #[test]
    fn invalid_clicks_leave_no_plan() {
        let mut t = GymLoop::new(gym_level());
        t.click_ground(Vec3::new(-3.0, 0.0, 5000.0)); // off the map
        assert!(t.plan.is_none());
        t.click_ground(cell_world(t.snap.player)); // own cell: cancel, no plan
        assert!(t.plan.is_none());
    }

}
