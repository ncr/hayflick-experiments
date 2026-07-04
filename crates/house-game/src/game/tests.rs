//! The house-game test suite (moved verbatim out of game.rs — the file was
//! 2731 lines with the tests inline). `use super::*` resolves to `game`,
//! exactly as it did as an inline `mod tests`.
use super::*;
use crate::spec::{fixture, MobSpec};
use crate::trace::parse_trace;
use sim_core::{Runner, VecSink};

/// Test driver: a fixture game + a running tick counter, so scenarios read
/// as "command, run n, assert" without juggling Tick numbers.
struct Drv {
    g: HouseGame<VecSink>,
    t: u64,
}

impl Drv {
    fn new() -> Drv {
        Drv { g: HouseGame::new(&fixture(), VecSink::default()), t: 0 }
    }

    fn cmd(&mut self, c: Command) {
        self.g.tick(Tick(self.t), &[c]);
        self.t += 1;
    }

    fn cmds(&mut self, cs: &[Command]) {
        self.g.tick(Tick(self.t), cs);
        self.t += 1;
    }

    fn run(&mut self, n: u64) {
        for _ in 0..n {
            self.g.tick(Tick(self.t), &[]);
            self.t += 1;
        }
    }

    fn pos(&self) -> Vec3 {
        self.g.world.get::<&Pos>(self.g.player).unwrap().0
    }

    fn walking(&self) -> bool {
        self.g.world.get::<&WalkTarget>(self.g.player).is_ok()
    }

    fn cue_ids(&self) -> Vec<&'static str> {
        self.g.sink.0.iter().map(|c| c.id.0).collect()
    }
}

fn down_ray(x: f32, z: f32) -> PickRay {
    PickRay { origin: Vec3::new(x, 5.0, z), dir: Vec3::new(0.0, -1.0, 0.0) }
}

fn click_ground(x: f32, z: f32) -> Command {
    Command::Click { ray: down_ray(x, z), ground: Some(Vec2::new(x, z)) }
}

/// Straight down onto door_ab's slab centre — resolves as UseDoor even
/// though a ground point is supplied (door interact beats walk).
fn click_door_ab() -> Command {
    Command::Click { ray: down_ray(-1.625, 0.0), ground: Some(Vec2::new(-1.625, 0.0)) }
}

fn shoot(origin: Vec3, dir: Vec3) -> Command {
    Command::Shoot { ray: PickRay { origin, dir: dir.normalize() } }
}

const OPEN: f32 = 1.9198622; // 110 deg in radians (fixture open_angle)
/// Ticks to let a close-range slug fly to an in-room target before asserting
/// the (now travel-delayed) hit — generous: 24·(26/60) ≈ 10 wu of travel.
const PROJ_FLY: u64 = 24;

#[test]
fn walk_reaches_click_and_blocked_points_are_noops() {
    let mut d = Drv::new();
    // clicking inside the crate is a no-op (no clamp-to-edge in v1)
    let p0 = d.pos();
    d.cmd(click_ground(-3.5, 1.4));
    assert!(!d.walking());
    d.run(10);
    assert_eq!(d.pos(), p0, "blocked click must not move the player");
    // a clear point in room A is reached and the target clears
    d.cmd(click_ground(-2.5, -1.5));
    d.run(150);
    assert!((d.pos() - Vec3::new(-2.5, 0.0, -1.5)).length() < 0.06, "{:?}", d.pos());
    assert!(!d.walking());
    // snapshot's player_pos is the lattice-snapped continuous pos
    let snap = d.g.snapshot();
    assert!((snap.player_pos - d.pos()).length() < 3.0 / ISO_R);
}

#[test]
fn slide_along_wall() {
    let mut d = Drv::new();
    // hold screen-right: world (+x, -z) into wall A|B below the door gap;
    // x blocks at the wall face, z keeps sliding until the perimeter
    for _ in 0..150 {
        d.cmd(Command::Move { dir: IVec2::new(1, 0) });
    }
    let p = d.pos();
    assert!(p.x < -1.75 && p.x > -1.83, "x pinned at the wall: {p:?}");
    assert!(p.z < -2.4 && p.z >= -2.5, "z slid to the perimeter: {p:?}");
    assert!(!d.g.walk_blocked(p.x, p.z), "never ends inside a solid");
}

#[test]
fn closed_door_blocks_then_open_admits_after_anim_ticks() {
    let mut d = Drv::new();
    d.cmd(click_ground(0.0, 0.0)); // room B centre, straight through door_ab
    d.run(200);
    let p = d.pos();
    assert!(p.x < -1.74 && p.x > -1.9, "stopped at the closed leaf: {p:?}");
    assert!(!d.walking(), "blocked-two-ticks must clear the target");
    // open the door, wait out the sweep, walk again -> admitted
    d.cmd(click_door_ab());
    d.run(31);
    assert_eq!(d.g.snapshot().doors[0], (DoorId(0), OPEN));
    d.cmd(click_ground(0.0, 0.0));
    d.run(150);
    assert!((d.pos() - Vec3::ZERO).length() < 0.06, "{:?}", d.pos());
}

#[test]
fn door_state_machine_tick_exact() {
    let mut d = Drv::new();
    d.cmd(click_door_ab()); // tick T: Closed -> Opening(30), angle still 0
    assert_eq!(d.g.snapshot().doors[0].1, 0.0);
    d.run(15); // T+15: half-swept
    assert!((d.g.snapshot().doors[0].1 - OPEN * 0.5).abs() < 1e-5);
    d.run(14); // T+29: one tick short of open — no cue yet
    assert!(d.g.snapshot().doors[0].1 < OPEN);
    assert_eq!(d.cue_ids(), Vec::<&str>::new());
    d.run(1); // T+30: Open, DoorOpened fires EXACTLY here
    assert_eq!(d.g.snapshot().doors[0].1, OPEN);
    assert_eq!(d.cue_ids(), vec!["door_open"]);
    // close: same tick-exact sweep down
    d.cmd(click_door_ab());
    assert_eq!(d.g.snapshot().doors[0].1, OPEN); // Closing(30) starts full
    d.run(29);
    assert!(d.g.snapshot().doors[0].1 > 0.0);
    assert_eq!(d.cue_ids(), vec!["door_open"]);
    d.run(1);
    assert_eq!(d.g.snapshot().doors[0].1, 0.0);
    assert_eq!(d.cue_ids(), vec!["door_open", "door_close"]);
    // the other door never moved
    assert_eq!(d.g.snapshot().doors[1], (DoorId(1), 0.0));
}

#[test]
fn door_cant_close_on_player() {
    let mut d = Drv::new();
    d.cmd(click_door_ab());
    d.run(31); // open
    // stand in the doorway: ground point is the doorway centre, but the
    // pick ray must not cross the door's interact volume (door beats walk)
    d.cmd(Command::Click { ray: down_ray(-3.0, 0.0), ground: Some(Vec2::new(-1.625, 0.0)) });
    d.run(120);
    assert!((d.pos() - Vec3::new(-1.625, 0.0, 0.0)).length() < 0.06, "{:?}", d.pos());
    d.cmd(click_door_ab()); // try to close on the player -> refused
    d.run(40);
    assert_eq!(d.g.snapshot().doors[0].1, OPEN, "door must refuse to close");
    assert_eq!(d.cue_ids(), vec!["door_open"]); // no door_close cue
    // step clear, then it closes normally
    d.cmd(click_ground(-3.0, 0.0));
    d.run(120);
    d.cmd(click_door_ab());
    d.run(31);
    assert_eq!(d.g.snapshot().doors[0].1, 0.0);
    assert_eq!(d.cue_ids(), vec!["door_open", "door_close"]);
}

#[test]
fn shot_hits_scores_and_arms_muzzle_flash() {
    let mut d = Drv::new();
    // straight at target 0 on room A's north wall (disc ON the wall face:
    // the perimeter slab ties at the disc plane and must not block)
    d.cmd(shoot(Vec3::new(-3.5, 1.25, 0.0), Vec3::new(0.0, 0.0, -1.0)));
    let snap = d.g.snapshot();
    // the slug is now in flight: muzzle is armed, but the hit lands later.
    assert!(snap.muzzle_flash, "armed for 2 ticks");
    assert_eq!(snap.score, 0, "score waits for the slug to reach the disc");
    assert_eq!(d.cue_ids(), vec!["pistol_fire"]);
    d.run(1);
    assert!(d.g.snapshot().muzzle_flash);
    d.run(1);
    assert!(!d.g.snapshot().muzzle_flash, "exactly 2 ticks");
    // let the projectile travel to the wall and resolve the hit
    d.run(PROJ_FLY);
    assert_eq!(d.g.snapshot().score, 1, "the slug landed on the disc");
    assert_eq!(d.g.world.get::<&Target>(d.g.targets[0]).unwrap().hits, 1);
    assert_eq!(d.cue_ids(), vec!["pistol_fire", "target_hit"]);
}

#[test]
fn shot_misses_off_disc() {
    let mut d = Drv::new();
    d.cmd(shoot(Vec3::new(-4.5, 1.25, 0.0), Vec3::new(0.0, 0.0, -1.0)));
    d.run(PROJ_FLY);
    assert_eq!(d.g.snapshot().score, 0);
    assert_eq!(d.cue_ids(), vec!["pistol_fire"]); // fired, no hit
}

#[test]
fn projectile_flies_over_ticks_then_lands() {
    let mut d = Drv::new();
    d.cmd(shoot(Vec3::new(-3.5, 1.25, 0.0), Vec3::new(0.0, 0.0, -1.0)));
    // the slug is a live entity now, exposed to the renderer, NOT yet landed
    let s0 = d.g.snapshot();
    assert_eq!(s0.projectiles.len(), 1, "the shot is a physical projectile in flight");
    assert_eq!(s0.score, 0, "it has not reached the disc yet");
    // it travels a measurable distance each tick (not a hitscan)
    d.run(1);
    let a = d.g.snapshot().projectiles[0].pos;
    d.run(1);
    let b = d.g.snapshot().projectiles[0].pos;
    assert!((b - a).length() > 0.1, "the slug moved between ticks: {a:?} -> {b:?}");
    // and eventually lands, scores, and despawns (no leak)
    d.run(PROJ_FLY);
    assert_eq!(d.g.snapshot().score, 1, "the slug reached and scored the disc");
    assert!(d.g.snapshot().projectiles.is_empty(), "a landed slug is removed");
}

#[test]
fn projectile_flight_replays_bit_identically() {
    // a shot in mid-flight folds into the hash; two runs must agree exactly.
    let run = || {
        let mut d = Drv::new();
        d.cmd(shoot(Vec3::new(-3.5, 1.25, 0.0), Vec3::new(0.0, 0.0, -1.0)));
        d.run(3); // freeze the world mid-flight (slug still travelling)
        d
    };
    let a = run();
    let b = run();
    assert_eq!(a.g.snapshot().projectiles.len(), 1, "still in flight at the checkpoint");
    assert_eq!(a.g.state_hash(), b.g.state_hash(), "projectile flight must be deterministic");
    assert_eq!(a.g.snapshot().projectiles, b.g.snapshot().projectiles, "render poses must match");
}

#[test]
fn shot_blocked_by_closed_door_admitted_when_open() {
    // one ray, two worlds: through the A|B doorway at target 1 in room B
    let o = Vec3::new(-2.0, 1.25, 0.5);
    let dir = Vec3::new(2.0, 0.0, -3.0);
    let mut closed = Drv::new();
    closed.cmd(shoot(o, dir));
    closed.run(PROJ_FLY);
    assert_eq!(closed.g.snapshot().score, 0, "closed leaf occludes");
    assert_eq!(closed.cue_ids(), vec!["pistol_fire"]);
    let mut open = Drv::new();
    open.cmd(click_door_ab());
    open.run(31);
    open.cmd(shoot(o, dir));
    open.run(PROJ_FLY);
    assert_eq!(open.g.snapshot().score, 1, "open doorway admits the shot");
    assert_eq!(open.g.world.get::<&Target>(open.g.targets[1]).unwrap().hits, 1);
}

#[test]
fn cooldown_swallows_spam() {
    let mut d = Drv::new();
    let at_t0 = || shoot(Vec3::new(-3.5, 1.25, 0.0), Vec3::new(0.0, 0.0, -1.0));
    let fired = |d: &Drv| d.cue_ids().iter().filter(|c| **c == "pistol_fire").count();
    // two shots in ONE tick: the second is swallowed → one slug leaves
    d.cmds(&[at_t0(), at_t0()]);
    assert_eq!(fired(&d), 1);
    // spamming every tick inside the cooldown adds nothing
    for _ in 0..PISTOL_COOLDOWN_TICKS - 1 {
        d.cmd(at_t0());
    }
    assert_eq!(fired(&d), 1);
    // first tick past the cooldown fires again
    d.cmd(at_t0());
    assert_eq!(fired(&d), 2);
    // let both slugs land; both score (order of fire/hit cues can interleave
    // with travel time, so assert the counts, not the sequence)
    d.run(PROJ_FLY);
    assert_eq!(d.g.snapshot().score, 2, "both fired slugs hit the disc");
    let hits = d.cue_ids().iter().filter(|c| **c == "target_hit").count();
    assert_eq!(hits, 2);
}

#[test]
fn rotate_changes_walk_frame() {
    // yaw_q is SIM state: the same Move input walks a different world
    // direction after RotateCamera
    let mut d = Drv::new();
    let p0 = d.pos();
    d.cmd(Command::Move { dir: IVec2::new(1, 0) });
    let p1 = d.pos();
    assert!(p1.x > p0.x && p1.z < p0.z, "yaw 0: screen-right = +x -z");
    d.cmd(Command::RotateCamera { dq: 1 });
    assert_eq!(d.g.snapshot().yaw_q, 1);
    d.cmd(Command::Move { dir: IVec2::new(1, 0) });
    let p2 = d.pos();
    assert!(p2.x < p1.x && p2.z < p1.z, "yaw 1: screen-right = -x -z");
    d.cmd(Command::RotateCamera { dq: -2 });
    assert_eq!(d.g.snapshot().yaw_q, 3, "rem_euclid wrap");
}

#[test]
fn flashlight_pose_tracks_facing() {
    let mut d = Drv::new();
    d.cmd(Command::ToggleFlashlight);
    assert!(d.g.snapshot().flashlight);
    assert_eq!(d.cue_ids(), vec!["switch"]);
    d.cmd(Command::Move { dir: IVec2::new(1, 0) });
    let snap = d.g.snapshot();
    let f = snap.facing;
    assert!((f - Vec2::new(1.0, -1.0).normalize()).length() < 1e-4);
    // the resource holds exactly the shared pure-fn pose at the snapped pos
    let (want_pos, want_dir) = crate::flashlight_pose(snap.player_pos, f);
    assert_eq!(d.g.res.flash_pose, FlashPose { pos: want_pos, dir: want_dir });
    // walking against a wall still turns the beam (facing = attempt);
    // screen up-left is world -x exactly (the iso 2:1 diagonal)
    for _ in 0..200 {
        d.cmd(Command::Move { dir: IVec2::new(-1, 1) });
    }
    let f2 = d.g.snapshot().facing;
    assert!((f2 - Vec2::new(-1.0, 0.0)).length() < 1e-4, "{f2:?}");
}

#[test]
fn toggle_lights_zeroes_emission() {
    let mut d = Drv::new();
    d.run(1);
    let on = d.g.snapshot();
    assert_eq!(on.room_lights, 1.0);
    assert_eq!(on.lights.len(), 4);
    assert!(on.lights.iter().all(|(_, rgb)| rgb[0] > 0.0));
    d.cmd(Command::ToggleRoomLights);
    let off = d.g.snapshot();
    assert_eq!(off.room_lights, 0.0);
    for (id, rgb) in &off.lights {
        if *id == LightId(2) {
            assert!(rgb[0] > 0.0, "the screen ignores the wall switch");
        } else {
            assert_eq!(*rgb, [0.0; 3], "light {id:?} must go dark");
        }
    }
    d.cmd(Command::ToggleRoomLights);
    assert_eq!(d.g.snapshot().room_lights, 1.0);
    assert_eq!(d.cue_ids(), vec!["switch", "switch"]);
}

#[test]
fn audio_cues_exact() {
    let mut d = Drv::new();
    d.cmd(Command::ToggleFlashlight);
    d.cmd(Command::ToggleRoomLights);
    d.cmd(click_door_ab());
    d.run(30); // door_open lands on the last of these
    d.cmd(shoot(Vec3::new(-3.5, 1.25, 0.0), Vec3::new(0.0, 0.0, -1.0)));
    d.run(PROJ_FLY); // the slug flies to the disc, THEN the hit cue lands
    assert_eq!(d.cue_ids(), vec!["switch", "switch", "door_open", "pistol_fire", "target_hit"]);
    let cues = &d.g.sink.0;
    assert_eq!(cues[0].pos, None);
    assert_eq!(cues[0].gain, 0.6);
    assert_eq!(cues[2].pos, Some(Vec3::new(-1.625, 0.0, -0.75))); // the hinge
    assert_eq!(cues[2].gain, 1.0);
    assert!(cues[3].pos.is_some() && cues[4].pos.is_some());
    // the hit lands on the disc
    assert!((cues[4].pos.unwrap() - Vec3::new(-3.5, 1.25, -2.5)).length() < 0.31);
}

#[test]
fn snapshot_twice_is_side_effect_free() {
    let mut d = Drv::new();
    d.cmd(Command::ToggleFlashlight);
    d.cmd(click_ground(-2.5, -1.5));
    d.run(40);
    let h0 = d.g.state_hash();
    let s0 = d.g.snapshot();
    let s1 = d.g.snapshot();
    assert_eq!(s0, s1, "snapshot must be a pure read");
    assert_eq!(d.g.state_hash(), h0, "snapshot/state_hash must not advance state");
    // and the next tick is unaffected by how many snapshots were taken
    d.run(1);
    let ha = d.g.state_hash();
    let mut e = Drv::new();
    e.cmd(Command::ToggleFlashlight);
    e.cmd(click_ground(-2.5, -1.5));
    e.run(41);
    assert_eq!(e.g.state_hash(), ha);
}

fn scripted_trace() -> Vec<(Tick, Command)> {
    vec![
        (Tick(0), Command::ToggleFlashlight),
        (Tick(2), click_door_ab()),
        (Tick(40), click_ground(0.0, 0.0)),
        (Tick(120), shoot(Vec3::new(0.0, 1.25, 0.0), Vec3::new(0.0, 0.0, -1.0))),
        (Tick(130), Command::ToggleRoomLights),
        (Tick(150), Command::RotateCamera { dq: 1 }),
        (Tick(160), Command::Move { dir: IVec2::new(0, 1) }),
        (Tick(161), Command::Move { dir: IVec2::new(0, 1) }),
    ]
}

#[test]
fn determinism_two_runs_identical() {
    let mut a = Runner::new(HouseGame::new(&fixture(), VecSink::default()));
    a.feed(scripted_trace());
    let ha = a.run_ticks(200);
    let mut b = Runner::new(HouseGame::new(&fixture(), VecSink::default()));
    b.feed(scripted_trace());
    let hb = b.run_ticks(200);
    assert_eq!(ha, hb, "same trace, same world");
    assert_eq!(a.sim.snapshot(), b.sim.snapshot());
    assert_eq!(a.sim.sink.0, b.sim.sink.0, "cue streams must match exactly");
    // per-tick draining: batch boundaries cannot matter
    let mut c = Runner::new(HouseGame::new(&fixture(), VecSink::default()));
    c.feed(scripted_trace());
    c.run_ticks(67);
    c.run_ticks(133);
    assert_eq!(c.sim.state_hash(), ha);
    // the scripted run did real work (not vacuously equal empties)
    assert_eq!(a.sim.snapshot().score, 1);
    assert_eq!(a.sim.snapshot().yaw_q, 1);
}

/// The checked-in trace + pinned hash: any change to system order, math,
/// or command semantics shows up here. Machine-local artifact per
/// ARCHITECTURE.md (f32 + libm) — regenerate the pin via
/// `cargo run -p house-game --bin headless -- traces/replay_golden.txt 240`
/// ONLY when the behavior change is intended and reviewed.
#[test]
fn replay_golden() {
    let trace = parse_trace(include_str!("../../traces/replay_golden.txt")).unwrap();
    let mut r = Runner::new(HouseGame::new(&fixture(), VecSink::default()));
    r.feed(trace);
    let h = r.run_ticks(240);
    let snap = r.sim.snapshot();
    // semantic checkpoints first, so a drift diagnoses itself
    assert_eq!(snap.score, 1, "the doorway shot must land");
    assert_eq!(snap.yaw_q, 1);
    assert_eq!(snap.doors[0].1, OPEN);
    assert!(snap.flashlight);
    assert_eq!(snap.room_lights, 1.0);
    assert_eq!(h, REPLAY_GOLDEN_HASH, "got {h:#018x}");
}

const REPLAY_GOLDEN_HASH: u64 = 0x6efef65b2724fcda;

// ---- the real game level (spec::game_level) ------------------------------

/// Driver over the actual game level (the SCENE=game content), so the
/// content trace is exercised headless before the renderer ever sees it.
struct GameDrv {
    g: HouseGame<VecSink>,
    t: u64,
}
impl GameDrv {
    fn new() -> GameDrv {
        GameDrv { g: HouseGame::new(&crate::spec::game_level(), VecSink::default()), t: 0 }
    }
    fn cmd(&mut self, c: Command) {
        self.g.tick(Tick(self.t), &[c]);
        self.t += 1;
    }
    fn run(&mut self, n: u64) {
        for _ in 0..n {
            self.g.tick(Tick(self.t), &[]);
            self.t += 1;
        }
    }
    fn pos(&self) -> Vec3 {
        self.g.world.get::<&Pos>(self.g.player).unwrap().0
    }
}

#[test]
fn game_level_geometry_is_consistent() {
    let spec = crate::spec::game_level();
    // floor bounds = the full footprint, every dim a multiple of 0.0625
    assert_eq!(spec.floor_bounds(), [0.0, 0.0, 12.0, 8.0]);
    let on_lattice = |v: f32| (v / 0.0625).fract().abs() < 1e-4;
    for s in spec.static_solids.iter().chain(spec.doors.iter().map(|d| &d.closed_solid)) {
        for &c in s {
            assert!(on_lattice(c), "off-lattice coord {c} in {s:?}");
        }
    }
    // every door's closed_solid spans exactly one cell (1.0 wu) along its run
    for d in &spec.doors {
        let s = d.closed_solid;
        let run = (s[2] - s[0]).max(s[3] - s[1]);
        assert!((run - 1.0).abs() < 1e-4, "door {:?} run {run}", d.id);
    }
}

#[test]
fn game_level_walk_open_door_through_and_shoot_twice() {
    let mut d = GameDrv::new();
    // door_ce (DoorId(2)) is the SE room E -> room C door at x=8, z[6,7];
    // shut, it blocks the way west at z=6.5
    d.cmd(click_ground(6.0, 6.5));
    d.run(120);
    assert!(d.pos().x > 8.0, "closed door_ce blocks the way west: {:?}", d.pos());
    // open door_ce (straight down onto its slab centre)
    d.cmd(Command::Click { ray: down_ray(8.0, 6.5), ground: Some(Vec2::new(8.0, 6.5)) });
    d.run(26); // anim_ticks = 24 (+ the tick the click lands on)
    assert_eq!(d.g.snapshot().doors[2].0, DoorId(2));
    assert!(d.g.snapshot().doors[2].1 > 0.0, "door_ce must be opening/open");
    // now walk through into room C, under target 4 (C south wall)
    d.cmd(click_ground(6.0, 6.0));
    d.run(180);
    assert!(d.pos().x < 7.0 && d.pos().z > 4.0, "reached room C: {:?}", d.pos());
    // shoot target 4 (C south wall, faces -z) twice, spaced past the cooldown;
    // each slug now flies before it scores, so wait for it to land
    d.cmd(shoot(Vec3::new(6.0, 1.25, 6.0), Vec3::new(0.0, 0.0, 1.0)));
    d.run(20);
    assert_eq!(d.g.snapshot().score, 1);
    d.cmd(shoot(Vec3::new(6.0, 1.25, 6.0), Vec3::new(0.0, 0.0, 1.0)));
    d.run(20);
    assert_eq!(d.g.snapshot().score, 2, "two spaced shots score twice");
    assert_eq!(d.g.world.get::<&Target>(d.g.targets[4]).unwrap().hits, 2);
}

/// The SCENE=game CMDS replay golden: the SAME checked-in trace the viewer
/// plays as its startup prefix (traces/replay_game.txt), pinned end state.
/// Machine-local artifact (f32 + libm) — regenerate via
/// `cargo run -p house-game --bin headless -- traces/replay_game.txt 420 game`
/// ONLY when the content/behavior change is intended and reviewed.
#[test]
fn replay_game_golden() {
    let trace = parse_trace(include_str!("../../traces/replay_game.txt")).unwrap();
    let mut r = Runner::new(HouseGame::new(&crate::spec::game_level(), VecSink::default()));
    r.feed(trace);
    let h = r.run_ticks(420);
    let snap = r.sim.snapshot();
    // semantic checkpoints first, so a drift diagnoses itself
    assert_eq!(snap.score, 2, "both spaced shots must land on target 4");
    assert_eq!(snap.doors[2].0, DoorId(2));
    assert_eq!(snap.doors[2].1, GAME_OPEN, "door_ce fully open");
    assert!(snap.flashlight);
    assert_eq!(snap.room_lights, 0.0, "room lights toggled off");
    // the player walked west through door_ce into room C (x < the x=8 divider, z in C)
    assert!(snap.player_pos.x < 7.0 && snap.player_pos.z > 4.0, "{:?}", snap.player_pos);
    assert_eq!(h, REPLAY_GAME_HASH, "got {h:#018x}");
}

const GAME_OPEN: f32 = 1.7453293; // 100 deg in radians (game_level open_angle)
const REPLAY_GAME_HASH: u64 = 0xf3783d2d43fe4009;

// ---- survival systems (spec::survival_level, opt-in) ---------------------

use crate::spec::{game_level, survival_level, ItemKind, ItemSpec, LevelSpec, SurvivalParams};

/// Driver over a survival-enabled level. Defaults to `survival_level()` but
/// `with_spec` lets a test build a minimal one-item world for a tight assert.
struct SurvDrv {
    g: HouseGame<VecSink>,
    t: u64,
}
impl SurvDrv {
    fn new() -> SurvDrv {
        SurvDrv { g: HouseGame::new(&survival_level(), VecSink::default()), t: 0 }
    }
    fn with_spec(spec: LevelSpec) -> SurvDrv {
        SurvDrv { g: HouseGame::new(&spec, VecSink::default()), t: 0 }
    }
    fn cmd(&mut self, c: Command) {
        self.g.tick(Tick(self.t), &[c]);
        self.t += 1;
    }
    fn run(&mut self, n: u64) {
        for _ in 0..n {
            self.g.tick(Tick(self.t), &[]);
            self.t += 1;
        }
    }
    fn hunger(&self) -> f32 {
        self.g.world.get::<&Hunger>(self.g.player).unwrap().0
    }
    fn battery(&self) -> f32 {
        self.g.world.get::<&Battery>(self.g.player).unwrap().0
    }
    fn inv(&self) -> Vec<ItemKind> {
        self.g.world.get::<&Inventory>(self.g.player).unwrap().items.clone()
    }
    fn flashlight(&self) -> bool {
        self.g.world.get::<&Flashlight>(self.g.player).unwrap().on
    }
    fn cue_ids(&self) -> Vec<&'static str> {
        self.g.sink.0.iter().map(|c| c.id.0).collect()
    }
    fn set_hunger(&mut self, v: f32) {
        self.g.world.get::<&mut Hunger>(self.g.player).unwrap().0 = v;
    }
    fn set_battery(&mut self, v: f32) {
        self.g.world.get::<&mut Battery>(self.g.player).unwrap().0 = v;
    }
}

/// A 1-room survival level with a single food item at `food_pos` (player
/// spawns at the room's south, like game_level). Tight worlds for asserts.
fn one_item_level(kind: ItemKind, item_pos: Vec3, sp: SurvivalParams) -> LevelSpec {
    LevelSpec { items: vec![ItemSpec { id: ItemId(0), kind, pos: item_pos }], survival: Some(sp), ..game_level() }
}

#[test]
fn pickup_on_proximity() {
    // food sitting right where the player will arrive; walk onto it
    let item = Vec3::new(9.5, 0.0, 5.0); // room E, north of spawn (9.5, 6.5)
    let mut d = SurvDrv::with_spec(one_item_level(ItemKind::Food, item, SurvivalParams::default()));
    assert_eq!(d.inv(), vec![], "starts empty");
    assert_eq!(d.g.items.len(), 1, "one world item spawned");
    d.cmd(click_ground(9.5, 5.0));
    d.run(120);
    assert_eq!(d.inv(), vec![ItemKind::Food], "food entered the inventory");
    assert_eq!(d.g.items.len(), 0, "world item despawned");
    // PickedUp emitted → "pickup" cue
    assert!(d.cue_ids().contains(&"pickup"), "{:?}", d.cue_ids());
}

#[test]
fn use_restores_need() {
    let item = Vec3::new(9.5, 0.0, 5.0);
    let mut d = SurvDrv::with_spec(one_item_level(ItemKind::Food, item, SurvivalParams::default()));
    // Use with an empty inventory is a no-op
    d.cmd(Command::Use { kind: ItemKind::Food });
    assert!(!d.cue_ids().contains(&"eat"), "empty Use is a no-op");
    // grab the food, drop hunger, then consume to restore (clamped <= 1)
    d.cmd(click_ground(9.5, 5.0));
    d.run(120);
    assert_eq!(d.inv(), vec![ItemKind::Food]);
    d.set_hunger(0.3);
    d.cmd(Command::Use { kind: ItemKind::Food }); // use_system: +0.5 → 0.8, then needs_system decays one tick
    let expect = (0.8 - SurvivalParams::default().hunger_decay).max(0.0);
    assert!((d.hunger() - expect).abs() < 1e-5, "hunger restored (minus one tick decay): {}", d.hunger());
    assert_eq!(d.inv(), vec![], "the food was consumed");
    assert!(d.cue_ids().contains(&"eat"));
    // restore clamps at 1.0
    d.set_hunger(0.9);
    // give a fresh food directly into the inventory for the clamp check
    d.g.world.get::<&mut Inventory>(d.g.player).unwrap().items.push(ItemKind::Food);
    d.cmd(Command::Use { kind: ItemKind::Food }); // use_system: 0.9 + 0.5 clamps to 1.0, then one tick decay
    let clamped = (1.0 - SurvivalParams::default().hunger_decay).max(0.0);
    assert!((d.hunger() - clamped).abs() < 1e-5 && d.hunger() <= 1.0, "clamped to full (minus one tick): {}", d.hunger());
}

#[test]
fn battery_drains_only_with_flashlight() {
    let mut d = SurvDrv::new();
    let b0 = d.battery();
    d.run(60);
    assert_eq!(d.battery(), b0, "battery constant while torch off");
    d.cmd(Command::ToggleFlashlight);
    assert!(d.flashlight());
    let b1 = d.battery();
    d.run(60);
    assert!(d.battery() < b1, "battery drains while torch on: {} < {}", d.battery(), b1);
    // and hunger always decays regardless
    assert!(d.hunger() < 1.0, "hunger always decays");
}

#[test]
fn dead_battery_forces_torch_off() {
    let mut d = SurvDrv::new();
    d.cmd(Command::ToggleFlashlight);
    assert!(d.flashlight());
    d.set_battery(0.0001); // about to die
    d.run(2); // needs_system drains below 0 → clamps 0 → forces torch off
    assert_eq!(d.battery(), 0.0);
    assert!(!d.flashlight(), "dead battery forces the torch off");
    // toggle won't turn it back on with a dead battery (no Switch cue)
    let cues_before = d.cue_ids().len();
    d.cmd(Command::ToggleFlashlight);
    assert!(!d.flashlight(), "can't relight a dead torch");
    assert_eq!(d.cue_ids().len(), cues_before, "no Switch cue for the swallowed toggle");
}

#[test]
fn hunger_zero_slows() {
    // two identical worlds, same Move input; one starved, one fed
    let mk = || SurvDrv::with_spec(LevelSpec { items: vec![], survival: Some(SurvivalParams::default()), ..game_level() });
    let mut fed = mk();
    let mut starved = mk();
    starved.set_hunger(0.0);
    // hold screen-up for 30 ticks (away from spawn, into open room E)
    for _ in 0..30 {
        fed.cmd(Command::Move { dir: IVec2::new(0, 1) });
        starved.cmd(Command::Move { dir: IVec2::new(0, 1) });
    }
    let fed_pos = fed.g.world.get::<&Pos>(fed.g.player).unwrap().0;
    let starved_pos = starved.g.world.get::<&Pos>(starved.g.player).unwrap().0;
    let fed_d = (fed_pos - Vec3::new(9.5, 0.0, 6.5)).length();
    let starved_d = (starved_pos - Vec3::new(9.5, 0.0, 6.5)).length();
    assert!(starved_d < fed_d, "starving covers less ground: {starved_d} < {fed_d}");
    // hunger stays 0 (already empty); fed still has hunger
    assert_eq!(starved.hunger(), 0.0);
}

#[test]
fn need_critical_edge_triggered() {
    let mut d = SurvDrv::new();
    d.g.res.event_tap = Some(Vec::new());
    // sit just above critical, then cross below over two ticks
    let crit = SurvivalParams::default().critical;
    d.set_hunger(crit + SurvivalParams::default().hunger_decay * 0.5);
    d.run(1); // crosses below critical → ONE NeedCritical
    d.run(10); // stays below → must NOT re-fire
    let tap = d.g.res.event_tap.as_ref().unwrap();
    let crits = tap.iter().filter(|e| matches!(e, GameEvent::NeedCritical(NeedKind::Hunger))).count();
    assert_eq!(crits, 1, "NeedCritical fires once on crossing, not every tick");
    // recover above critical → NeedRecovered, then critical again re-arms
    d.set_hunger(crit + 0.3);
    d.run(1);
    let recs = d.g.res.event_tap.as_ref().unwrap().iter().filter(|e| matches!(e, GameEvent::NeedRecovered(NeedKind::Hunger))).count();
    assert_eq!(recs, 1, "NeedRecovered fires on the climb back");
}

#[test]
fn survival_determinism() {
    // same survival scenario twice → identical timeline + hash
    let trace = vec![
        (Tick(0), Command::ToggleFlashlight),
        (Tick(10), click_ground(9.5, 5.0)),
        (Tick(120), Command::Use { kind: ItemKind::Battery }),
    ];
    let run = || {
        let mut r = Runner::new(HouseGame::new(&survival_level(), VecSink::default()));
        r.feed(trace.clone());
        let h = r.run_ticks(200);
        (h, r.sim.sink.0.clone(), r.sim.snapshot())
    };
    let (ha, cues_a, snap_a) = run();
    let (hb, cues_b, snap_b) = run();
    assert_eq!(ha, hb, "same survival trace, same hash");
    assert_eq!(cues_a, cues_b, "cue streams identical");
    assert_eq!(snap_a, snap_b, "snapshots identical");
}

// ---- goo mobs (spec::goo_level) ------------------------------------------

use crate::spec::{goo_level, MobId};

struct GooDrv {
    g: HouseGame<VecSink>,
    t: u64,
}
impl GooDrv {
    fn new() -> GooDrv {
        GooDrv { g: HouseGame::new(&goo_level(), VecSink::default()), t: 0 }
    }
    fn run(&mut self, n: u64) {
        for _ in 0..n {
            self.g.tick(Tick(self.t), &[]);
            self.t += 1;
        }
    }
    fn cmd(&mut self, c: Command) {
        self.g.tick(Tick(self.t), &[c]);
        self.t += 1;
    }
    fn mob_count(&self) -> usize {
        self.g.mobs.len()
    }
    fn world_goo_count(&self) -> usize {
        self.g.world.query::<&Goo>().iter().count()
    }
    /// Centroid of the blob with the given MobId, if alive.
    fn centroid_of(&self, id: MobId) -> Option<Vec2> {
        self.g.mobs.iter().find_map(|&e| {
            let g = self.g.world.get::<&Goo>(e).unwrap();
            (g.id == id).then(|| g.centroid())
        })
    }
    /// Shoot from the player's real muzzle toward a world-XZ point at blob
    /// height (so `t_start` is zero and the shot reaches a line-of-sight
    /// blob exactly as a real click would).
    fn shoot_at(&mut self, target: Vec2) {
        let p = self.g.player_pos();
        let facing = self.g.player_facing();
        let (muzzle, _) = flashlight_pose(p, facing);
        let tgt = Vec3::new(target.x, GOO_BASE_RADIUS, target.y);
        let dir = (tgt - muzzle).normalize();
        self.cmd(Command::Shoot { ray: PickRay { origin: muzzle, dir } });
    }
}

/// Build a fresh game on `spec` and advance it `ticks` ticks with no input —
/// the bare deterministic-sim loop shared by the merge/nursery scenarios.
fn run_ticks(spec: &LevelSpec, ticks: u64) -> HouseGame<VecSink> {
    let mut g = HouseGame::new(spec, VecSink::default());
    for t in 0..ticks {
        g.tick(Tick(t), &[]);
    }
    g
}

#[test]
fn select_weapon_noop_without_arsenal() {
    // SelectWeapon spam on a non-arena level must be byte-invisible: the
    // arsenal doesn't exist there, so the command is swallowed with no
    // state change (the gated-block discipline, like survival).
    let spec = fixture();
    let mut a = HouseGame::new(&spec, VecSink::default());
    let mut b = HouseGame::new(&spec, VecSink::default());
    for t in 0..60 {
        a.tick(Tick(t), &[Command::SelectWeapon { slot: (t % 5 + 1) as u8 }]);
        b.tick(Tick(t), &[]);
    }
    assert_eq!(a.state_hash(), b.state_hash(), "SelectWeapon must be a no-op without an arsenal");
    assert_eq!(a.snapshot().weapon, None, "non-arena snapshots carry no weapon HUD");
}

#[test]
fn arena_select_weapon_is_hashed_and_selects() {
    // On the arena level the selection is real sim state: it lands in the
    // snapshot HUD tuple and moves state_hash (the arsenal-gated block).
    let spec = crate::spec::arena_level();
    let mut a = HouseGame::new(&spec, VecSink::default());
    let mut b = HouseGame::new(&spec, VecSink::default());
    a.tick(Tick(0), &[Command::SelectWeapon { slot: 3 }]);
    b.tick(Tick(0), &[]);
    assert_eq!(a.snapshot().weapon.map(|w| w.0), Some(WeaponKind::Shotgun));
    assert_eq!(b.snapshot().weapon.map(|w| w.0), Some(WeaponKind::Slug), "default slot is 1 (slug)");
    assert_ne!(a.state_hash(), b.state_hash(), "selection folds into the arena hash");
    // out-of-range slots are swallowed (selection unchanged)
    a.tick(Tick(1), &[Command::SelectWeapon { slot: 9 }]);
    assert_eq!(a.snapshot().weapon.map(|w| w.0), Some(WeaponKind::Shotgun));
}

/// Aim ray from the arena spawn's muzzle toward a floor point — shared by
/// the arsenal tests below.
fn arena_aim(gx: f32, gz: f32) -> Command {
    let muzzle = Vec3::new(0.0, 1.25, 6.0);
    let dir = (Vec3::new(gx, GOO_BASE_RADIUS, gz) - muzzle).normalize();
    Command::Shoot { ray: PickRay { origin: muzzle, dir } }
}

#[test]
fn arena_weapons_replay_deterministically() {
    // the whole arsenal path (selection, bloom jitter, pellet fan) must be
    // RNG-free: the same command trace twice → the same state hash.
    let spec = crate::spec::arena_level();
    let run = || {
        let mut g = HouseGame::new(&spec, VecSink::default());
        for t in 0..240u64 {
            let cmds: Vec<Command> = match t {
                10 => vec![Command::SelectWeapon { slot: 2 }],
                20 | 26 | 32 => vec![arena_aim(0.0, 2.0), Command::Move { dir: IVec2::new(1, 0) }],
                60 => vec![Command::SelectWeapon { slot: 3 }],
                70 | 110 => vec![arena_aim(4.0, 0.5)],
                150 => vec![Command::SelectWeapon { slot: 1 }],
                160 => vec![arena_aim(-4.0, 1.0)],
                _ => vec![],
            };
            g.tick(Tick(t), &cmds);
        }
        g.state_hash()
    };
    assert_eq!(run(), run(), "arsenal fire must be bit-reproducible");
}

#[test]
fn shotgun_fires_seven_pellets_and_uzi_blooms_wider_moving() {
    let spec = crate::spec::arena_level();
    // shotgun: one trigger pull births `pellets` projectiles
    let mut g = HouseGame::new(&spec, VecSink::default());
    g.tick(Tick(0), &[Command::SelectWeapon { slot: 3 }]);
    g.tick(Tick(1), &[arena_aim(0.0, 2.0)]);
    assert_eq!(g.snapshot().projectiles.len(), SHOTGUN.pellets as usize);

    // uzi bloom: the same trigger tick fired while HOLDING a move key must
    // leave the projectile on a different (wider-scattered) velocity than
    // the planted shot — same id, same aim ray, only the movement differs.
    let fire_at = |moving: bool| -> Vec3 {
        let mut g = HouseGame::new(&spec, VecSink::default());
        g.tick(Tick(0), &[Command::SelectWeapon { slot: 2 }]);
        let mut cmds = vec![arena_aim(0.0, 2.0)];
        if moving {
            cmds.push(Command::Move { dir: IVec2::new(1, 0) });
        }
        g.tick(Tick(1), &cmds);
        let e = g.projectiles[0];
        let vel = g.world.get::<&Projectile>(e).unwrap().vel;
        vel
    };
    let planted = fire_at(false);
    let running = fire_at(true);
    assert_ne!(planted, running, "moving must widen the bloom cone");
    // both still fly at muzzle speed (jitter only bends, never brakes)
    assert!((planted.length() - UZI.muzzle_speed).abs() < 1e-3);
    assert!((running.length() - UZI.muzzle_speed).abs() < 1e-3);
}

#[test]
fn grenade_bounces_off_the_wall_and_replays_bit_exact() {
    // fire a grenade at the arena's south wall (z = 10, 4 wu behind the
    // spawn): it must SURVIVE the wall hit with its z-velocity reflected,
    // then die by fuse — and the whole dance must replay to the same hash.
    let spec = crate::spec::arena_level();
    let run = || {
        let mut g = HouseGame::new(&spec, VecSink::default());
        g.tick(Tick(0), &[Command::SelectWeapon { slot: 4 }]);
        let ray = PickRay { origin: Vec3::new(0.0, 1.25, 6.0), dir: Vec3::new(0.0, -0.05, 1.0).normalize() };
        g.tick(Tick(1), &[Command::Shoot { ray }]);
        let mut bounced = false;
        let mut hashes = Vec::new();
        for t in 2..140u64 {
            g.tick(Tick(t), &[]);
            if let Some(&e) = g.projectiles.first() {
                let p = *g.world.get::<&Projectile>(e).unwrap();
                if p.vel.z < 0.0 {
                    bounced = true; // flying back off the south wall
                }
            }
            hashes.push(g.state_hash());
        }
        assert!(bounced, "the grenade must reflect off the wall, not despawn");
        assert!(g.projectiles.is_empty(), "the fuse (max_age 90) must have detonated it");
        hashes
    };
    assert_eq!(run(), run(), "grenade flight must be bit-reproducible");
}

#[test]
fn grenade_blast_damages_both_blobs_of_a_pair() {
    // two Mediums 1.2 wu apart on an open floor; one grenade lobbed at the
    // first must damage BOTH (contact/fuse detonation + 1.6 wu falloff).
    let spec = LevelSpec {
        mobs: vec![
            MobSpec { id: MobId(0), tier: 1, kind: crate::spec::GooKind::Green, pos: Vec3::new(0.0, 0.0, 0.0) },
            MobSpec { id: MobId(1), tier: 1, kind: crate::spec::GooKind::Green, pos: Vec3::new(1.2, 0.0, 0.0) },
        ],
        arena: Some(crate::spec::ArenaParams::default()),
        player_start: Vec3::new(0.0, 0.0, 4.0),
        ..crate::spec::goopair_level()
    };
    let mut g = HouseGame::new(&spec, VecSink::default());
    g.res.event_tap = Some(Vec::new());
    g.tick(Tick(0), &[Command::SelectWeapon { slot: 4 }]);
    let ray = PickRay { origin: Vec3::new(0.0, 1.25, 4.0), dir: Vec3::new(0.0, -0.9, -4.0).normalize() };
    g.tick(Tick(1), &[Command::Shoot { ray }]);
    for t in 2..220u64 {
        g.tick(Tick(t), &[]);
    }
    let tap = g.res.event_tap.take().unwrap();
    let touched = |id: MobId| tap.iter().any(|ev| matches!(ev, GameEvent::MobHit(i, _) | GameEvent::MobSplit(i, _) | GameEvent::MobKilled(i, _) if *i == id));
    assert!(touched(MobId(0)), "the contact blob must take blast damage: {tap:?}");
    assert!(touched(MobId(1)), "the neighbour inside the blast radius must take falloff damage: {tap:?}");
}

#[test]
fn tank_resists_small_arms_but_not_the_slug() {
    // arena MobId(0) is the tier-0 Tank (hp 12): uzi damage quarters
    // (2 -> 0 -> floored to 1), slug lands in full.
    let spec = crate::spec::arena_level();
    let mut g = HouseGame::new(&spec, VecSink::default());
    let e = g.mobs[0];
    assert_eq!(g.world.get::<&Goo>(e).unwrap().kind, crate::spec::GooKind::Tank);
    let hit = Vec3::new(-4.0, 0.3, 1.0);
    g.damage_goo(e, hit, Vec3::Z, UZI.damage, 0.0, WeaponClass::Uzi);
    assert_eq!(g.world.get::<&Goo>(e).unwrap().hp, 11, "uzi vs tank: 2/4 floored to 1");
    g.damage_goo(e, hit, Vec3::Z, PISTOL.damage, 0.0, WeaponClass::Standard);
    assert_eq!(g.world.get::<&Goo>(e).unwrap().hp, 5, "standard lands in full");
}

#[test]
fn harpoon_pins_a_blob_in_place() {
    // pin the arena's fast Runner (tier 1 at (4, 0.5)) and let the sim run:
    // its centroid must stay at the nail point instead of hunting off
    // (an unpinned Runner covers ~1.76 wu/s — 5+ wu over the window).
    let spec = crate::spec::arena_level();
    let mut g = HouseGame::new(&spec, VecSink::default());
    let e = g.mobs[1];
    assert_eq!(g.world.get::<&Goo>(e).unwrap().kind, crate::spec::GooKind::Runner);
    g.damage_goo(e, Vec3::new(4.0, 0.3, 0.5), Vec3::Z, HARPOON.damage, HARPOON.knockback, WeaponClass::Harpoon);
    let (pin_pt, pinned) = {
        let gg = g.world.get::<&Goo>(e).unwrap();
        (gg.pin_pt, gg.pinned)
    };
    assert_eq!(pinned, GOO_PIN_TICKS);
    for t in 0..180u64 {
        g.tick(Tick(t), &[]);
    }
    let gg = *g.world.get::<&Goo>(e).unwrap();
    let drift = (gg.centroid() - pin_pt).length();
    assert!(drift < 0.6, "pinned blob must stay nailed (drifted {drift:.2} wu)");
    assert_eq!(gg.pinned, GOO_PIN_TICKS - 180, "the pin ticks down");
}

#[test]
fn blobs_merge_only_within_a_species() {
    // two overlapping tier-1 blobs. Same kind -> they fuse into a tier-0;
    // different kinds -> contact repulsion pushes them apart and NO fusion
    // ever fires (the merge gate and the repulsion opt-out must agree).
    let pair = |kind_b: crate::spec::GooKind| -> (usize, bool) {
        let spec = LevelSpec {
            mobs: vec![
                MobSpec { id: MobId(0), tier: 1, kind: crate::spec::GooKind::Green, pos: Vec3::new(-0.1, 0.0, 0.0) },
                MobSpec { id: MobId(1), tier: 1, kind: kind_b, pos: Vec3::new(0.1, 0.0, 0.0) },
            ],
            // the goofloor trick: a central well holds the pair together
            // through the newborn grace (they repel until both merge-ready)
            traps: vec![crate::spec::TrapSpec { id: 0, pos: Vec3::ZERO, strength: 1.3, radius: 2.6, off_tick: 0 }],
            ..crate::spec::goopair_level()
        };
        let mut g = HouseGame::new(&spec, VecSink::default());
        for t in 0..400u64 {
            g.tick(Tick(t), &[]);
        }
        let any_large = g.mobs.iter().any(|&e| g.world.get::<&Goo>(e).unwrap().tier == 0);
        (g.mobs.len(), any_large)
    };
    let (n_same, large_same) = pair(crate::spec::GooKind::Green);
    // (a fused tier-0 is a MOTHER — by t400 it has budded a mini, so the
    // count is survivor + brood; the tier-0's existence is the fusion proof)
    assert!(large_same, "same-species overlap must fuse up: {n_same} mobs, large={large_same}");
    let (n_mixed, large_mixed) = pair(crate::spec::GooKind::Runner);
    assert!(!large_mixed && n_mixed == 2, "mixed species must never fuse: {n_mixed} mobs, large={large_mixed}");
}

/// One lone Large on an open floor (the chunk-mechanics fixture).
fn lone_large_spec() -> LevelSpec {
    LevelSpec {
        mobs: vec![MobSpec { id: MobId(0), tier: 0, kind: crate::spec::GooKind::Green, pos: Vec3::new(0.0, 0.0, 0.0) }],
        traps: vec![],
        ..crate::spec::goopair_level()
    }
}

#[test]
fn three_slugs_solidify_a_large_into_a_chunk() {
    // 4+4+4 slug damage kills the 12-hp Large AT the cure threshold: a
    // dead solid chunk forms (blocks walking, enters hash + snapshot) and
    // ONE small escapee squirms free instead of the usual two-way split.
    let spec = lone_large_spec();
    let mut g = HouseGame::new(&spec, VecSink::default());
    g.res.event_tap = Some(Vec::new());
    let e = g.mobs[0];
    let c = g.world.get::<&Goo>(e).unwrap().centroid();
    let hit = Vec3::new(c.x, 0.3, c.y);
    for _ in 0..3 {
        g.damage_goo(e, hit, Vec3::Z, SLUG.damage, 0.0, WeaponClass::Slug);
    }
    g.tick(Tick(0), &[]); // flush the queued despawn/spawn
    assert_eq!(g.res.chunks.len(), 1, "a chunk must stand");
    let ch = g.res.chunks[0];
    assert!(g.walk_blocked((ch[0] + ch[2]) * 0.5, (ch[1] + ch[3]) * 0.5), "the chunk blocks walking");
    assert_eq!(g.mobs.len(), 1, "one escapee, not a two-way split");
    assert_eq!(g.world.get::<&Goo>(g.mobs[0]).unwrap().tier, 1, "the escapee is a tier down");
    assert_eq!(g.snapshot().chunks.len(), 1, "the renderer sees it");
    let tap = g.res.event_tap.take().unwrap();
    assert!(tap.iter().any(|ev| matches!(ev, GameEvent::MobSolidified(MobId(0), _))), "{tap:?}");
}

#[test]
fn an_uncured_kill_still_splits_in_two() {
    // one slug (cure 1 < threshold 2) + pistol finish: the classic split.
    let spec = lone_large_spec();
    let mut g = HouseGame::new(&spec, VecSink::default());
    let e = g.mobs[0];
    let c = g.world.get::<&Goo>(e).unwrap().centroid();
    let hit = Vec3::new(c.x, 0.3, c.y);
    g.damage_goo(e, hit, Vec3::Z, SLUG.damage, 0.0, WeaponClass::Slug); // hp 8, cure 1
    g.damage_goo(e, hit, Vec3::Z, PISTOL.damage, 0.0, WeaponClass::Standard); // hp 2
    g.damage_goo(e, hit, Vec3::Z, PISTOL.damage, 0.0, WeaponClass::Standard); // dead, cure 1
    g.tick(Tick(0), &[]);
    assert!(g.res.chunks.is_empty(), "no chunk below the cure threshold");
    assert_eq!(g.mobs.len(), 2, "the classic two-way split");
}

#[test]
fn clearing_the_arena_summons_the_next_wave_deterministically() {
    // a one-Small arena: kill it (terminal, +2 score), wait out the lull,
    // and wave 1 lands — 4 mixed blobs on the north entrance ring. The
    // whole cycle must replay to identical hashes.
    let spec = LevelSpec {
        mobs: vec![MobSpec { id: MobId(0), tier: 2, kind: crate::spec::GooKind::Green, pos: Vec3::new(0.0, 0.0, 2.0) }],
        ..crate::spec::arena_level()
    };
    let lull = spec.arena.unwrap().wave_lull as u64;
    let run = || {
        let mut g = HouseGame::new(&spec, VecSink::default());
        let e = g.mobs[0];
        let c = g.world.get::<&Goo>(e).unwrap().centroid();
        g.damage_goo(e, Vec3::new(c.x, 0.3, c.y), Vec3::Z, 99, 0.0, WeaponClass::Standard);
        g.tick(Tick(0), &[]); // flush the kill
        assert!(g.mobs.is_empty(), "arena clear");
        assert_eq!(g.res.score, 1, "biomass: a terminal Small pays its mass (1)");
        assert_eq!(g.snapshot().wave, Some(0));
        for t in 1..=(lull + 2) {
            g.tick(Tick(t), &[]);
        }
        assert_eq!(g.snapshot().wave, Some(1), "wave 1 must have landed");
        assert_eq!(g.mobs.len(), 4, "wave 1 = 3 + idx blobs");
        // every entrant lands on the north half (z < 0), off the walls
        for &e in &g.mobs {
            let c = g.world.get::<&Goo>(e).unwrap().centroid();
            assert!(c.y < 0.5 && c.x.abs() < 9.0, "ring spawn out of bounds: {c:?}");
        }
        let mut h = Vec::new();
        for t in (lull + 3)..(lull + 120) {
            g.tick(Tick(t), &[]);
            h.push(g.state_hash());
        }
        h
    };
    assert_eq!(run(), run(), "wave landings must replay bit-exact");
}

#[test]
fn goo_hits_emit_splash_events() {
    let spec = lone_large_spec();
    let mut g = HouseGame::new(&spec, VecSink::default());
    g.res.event_tap = Some(Vec::new());
    let e = g.mobs[0];
    let c = g.world.get::<&Goo>(e).unwrap().centroid();
    g.damage_goo(e, Vec3::new(c.x, 0.3, c.y), Vec3::Z, UZI.damage, 0.6, WeaponClass::Uzi);
    g.tick(Tick(0), &[]);
    let tap = g.res.event_tap.take().unwrap();
    // every damaging hit splashes, carrying the impact dir + the fluid punch
    assert!(tap.iter().any(|ev| matches!(ev, GameEvent::GooSplashed(_, _, d, p) if *d == Vec3::Z && *p == 0.6)), "{tap:?}");
    assert!(tap.iter().any(|ev| matches!(ev, GameEvent::MobHit(..))), "the hit still lands: {tap:?}");
}

#[test]
fn weak_flag_trips_at_a_third_of_tier_hp() {
    // tier-0: 12 hp -> weak at hp <= 4 (the render shell's glitch gate)
    let spec = lone_large_spec();
    let mut g = HouseGame::new(&spec, VecSink::default());
    let e = g.mobs[0];
    let c = g.world.get::<&Goo>(e).unwrap().centroid();
    let hit = Vec3::new(c.x, 0.3, c.y);
    assert!(!g.snapshot().mobs[0].weak);
    g.damage_goo(e, hit, Vec3::Z, 7, 0.0, WeaponClass::Standard); // hp 5
    assert!(!g.snapshot().mobs[0].weak, "hp 5 of 12 is not weak yet");
    g.damage_goo(e, hit, Vec3::Z, 1, 0.0, WeaponClass::Standard); // hp 4
    assert!(g.snapshot().mobs[0].weak, "hp 4 of 12 is weak");
}

#[test]
fn kill_scoring_is_arena_only() {
    // the same terminal kill on a NON-arena level must not move score
    let spec = lone_large_spec(); // goopair base: no arena
    let mut g = HouseGame::new(&spec, VecSink::default());
    let e = g.mobs[0];
    let c = g.world.get::<&Goo>(e).unwrap().centroid();
    g.damage_goo(e, Vec3::new(c.x, 0.3, c.y), Vec3::Z, 99, 0.0, WeaponClass::Standard);
    g.tick(Tick(0), &[]);
    assert_eq!(g.res.score, 0, "score is gated on the arsenal");
}

#[test]
fn goo_spawns_and_crawls() {
    let mut d = GooDrv::new();
    // goo_level authors four blobs; the mob-free levels stay empty
    assert_eq!(d.mob_count(), 4, "four authored blobs");
    assert_eq!(d.world_goo_count(), 4);
    let c0 = d.centroid_of(MobId(0)).unwrap();
    d.run(120);
    let c1 = d.centroid_of(MobId(0)).unwrap();
    assert!((c1 - c0).length() > 0.05, "the blob crawled: {c0:?} -> {c1:?}");
    // the snapshot exposes a render pose per blob: the lifted particle cloud
    let snap = d.g.snapshot();
    assert_eq!(snap.mobs.len(), 4);
    assert!(snap.mobs.iter().all(|m| m.radius > 0.0 && m.part_radius > 0.0));
    assert!(snap.mobs.iter().all(|m| m.parts.iter().all(|p| p.y > 0.0)));
}

#[test]
fn goo_is_one_cohesive_blob_not_a_dumbbell() {
    // the capsule field pools the fluid into ONE cohesive blob: it stays
    // bounded around its centroid (no stringing/fission) and — unlike the
    // old dumbbell — its MIDDLE third along the body axis is well populated
    // (no thin neck).
    let mut d = GooDrv::new();
    d.run(150); // let the fluid settle
    let g = *d.g.world.get::<&Goo>(d.g.mobs[0]).unwrap();
    let r = goo_tier_radius(g.tier);
    let cen = g.centroid();
    // cohesive: every particle stays within a bounded radius of the centroid
    let max_d = g.parts.iter().map(|p| (*p - cen).length()).fold(0.0, f32::max);
    assert!(max_d < r * 2.0, "the blob must stay one cohesive mass (max dist {max_d:.2} vs {:.2})", r * 2.0);
    // not a dumbbell: bin along the body axis normalized by the cloud's OWN
    // extent (the spine is now shorter than the blob, so spine-relative bins
    // would mis-scale). A round/even blob fills the middle third; a dumbbell
    // starves it. The central band of a roundish mass is in fact the fullest.
    let axis = (g.ends[1] - g.ends[0]).normalize_or_zero();
    let extent = g.parts.iter().map(|p| (*p - cen).dot(axis).abs()).fold(0.0, f32::max).max(1e-3);
    let mut bins = [0u32; 3]; // [front, middle, back]
    for &p in &g.parts {
        let s = (p - cen).dot(axis) / extent; // ∈ [-1, 1]
        let b = if s < -0.33 { 0 } else if s > 0.33 { 2 } else { 1 };
        bins[b] += 1;
    }
    let lobe_avg = (bins[0] + bins[2]) as f32 / 2.0;
    assert!(bins[1] as f32 >= 0.6 * lobe_avg, "the middle must NOT be a thin neck (a single blob, not a dumbbell): front={} middle={} back={}", bins[0], bins[1], bins[2]);
}

#[test]
fn goo_trap_pulls_a_blob() {
    // goo_level authors a trap at (9.9, 4.1) in room E; the room-E Large
    // (MobId 3, spawns at 8.9,5.2) is within the 3.0 wu capture radius and
    // should get dragged toward the trap over time.
    let mut d = GooDrv::new();
    let trap = Vec2::new(9.2, 4.3);
    let d0 = (d.centroid_of(MobId(3)).unwrap() - trap).length();
    d.run(180);
    let d1 = (d.centroid_of(MobId(3)).unwrap() - trap).length();
    assert!(d1 < d0 - 0.2, "the trap pulled the blob in: {d0:.2} -> {d1:.2}");
}

#[test]
fn goo_splits_into_two_when_killed() {
    let mut d = GooDrv::new();
    // MobId(3) is a Large (tier 0, hp 12) in room E, in clear sight of the
    // player. Two pistol shots (6 dmg each, spaced past the 15-tick
    // cooldown) drop it → split into two Mediums (+1 net population).
    let before = d.mob_count();
    let c = d.centroid_of(MobId(3)).unwrap();
    d.shoot_at(c);
    d.run(10); // the first slug flies to the Large and wounds it
    assert_eq!(d.mob_count(), before, "first shot only wounds the Large");
    assert!(d.g.sink.0.iter().any(|q| q.id.0 == "goo_hit"), "first shot registered a hit");
    let c = d.centroid_of(MobId(3)).expect("still alive after one shot");
    d.run(8); // clear the 15-tick cooldown before the second shot
    d.shoot_at(c);
    d.run(12); // the second slug flies + the despawn/spawn flush + rebuild land
    assert!(d.centroid_of(MobId(3)).is_none(), "the Large is gone");
    assert_eq!(d.mob_count(), before + 1, "one Large became two Mediums (+1 net)");
    assert_eq!(d.world_goo_count(), d.mob_count(), "handle list matches the World");
    // children carry fresh seeded ids above every authored id (0..=3)
    let ids: Vec<u32> = d.g.mobs.iter().map(|&e| d.g.world.get::<&Goo>(e).unwrap().id.0).collect();
    assert_eq!(ids.iter().filter(|&&i| i >= 4).count(), 2, "two runtime children: {ids:?}");
    // self.mobs stays MobId-sorted after the rebuild
    let mut sorted = ids.clone();
    sorted.sort();
    assert_eq!(ids, sorted, "mob handle list must stay MobId-sorted");
    assert!(d.g.sink.0.iter().any(|q| q.id.0 == "goo_split"), "a split cue fired");
}

#[test]
fn second_projectile_on_a_dead_blob_same_tick_is_a_no_op() {
    // Two projectiles can strike the SAME blob in one tick — the despawn
    // only lands at the flush, so the corpse is still in `self.mobs` for
    // the second impact. The hp-0 dead-guard must make that second hit a
    // no-op; without it the blob died twice (a duplicate despawn, FOUR
    // children, doubled split events).
    let mut d = GooDrv::new();
    let before = d.mob_count();
    let e = *d.g.mobs.iter().find(|&&e| d.g.world.get::<&Goo>(e).unwrap().id == MobId(3)).unwrap();
    let c = d.centroid_of(MobId(3)).unwrap();
    let hit = Vec3::new(c.x, 0.3, c.y);
    // kill the Large outright, then hit the corpse again the SAME tick
    d.g.damage_goo(e, hit, Vec3::X, 12, 0.6, WeaponClass::Standard);
    d.g.damage_goo(e, hit, Vec3::X, 12, 0.6, WeaponClass::Standard);
    d.run(2); // flush + rebuild + audio drain
    assert!(d.centroid_of(MobId(3)).is_none(), "the Large is dead");
    assert_eq!(d.mob_count(), before + 1, "exactly one split: two children replace the parent");
    assert_eq!(d.world_goo_count(), d.mob_count(), "handle list matches the World");
    let splits = d.g.sink.0.iter().filter(|q| q.id.0 == "goo_split").count();
    assert_eq!(splits, 1, "one split cue, not two");
}

#[test]
fn goo_split_round_trip_is_deterministic() {
    // The novel mechanic — runtime CommandBuffer::spawn + handle recovery —
    // must replay bit-identically. Same shots, two worlds, equal hash. We
    // fire at a FIXED room-E point (deterministic regardless of where the
    // blobs crawled), so the split cascade is identical across runs.
    let script = |d: &mut GooDrv| {
        for _ in 0..6 {
            d.shoot_at(Vec2::new(9.5, 4.8));
            d.run(16);
        }
        d.run(40);
    };
    let mut a = GooDrv::new();
    script(&mut a);
    let mut b = GooDrv::new();
    script(&mut b);
    assert_eq!(a.g.state_hash(), b.g.state_hash(), "split replay must be bit-identical");
    assert_eq!(a.g.snapshot().mobs, b.g.snapshot().mobs, "render poses must match");
    // and real work happened: at least one split spawned runtime children
    // (the seeded id counter advanced past the authored ids). Robust to the
    // blobs later re-merging, which the population count is not.
    assert!(a.g.res.next_mob_id > 4, "the cascade spawned split children: next_mob_id={}", a.g.res.next_mob_id);
}

/// Two tier-1 blobs spawned overlapping, with a trap between them that holds
/// them together so they reliably fuse once their merge-grace expires.
fn merge_pair_level() -> LevelSpec {
    use crate::spec::{MobSpec, TrapSpec};
    let mut spec = goo_level();
    spec.mobs = vec![
        MobSpec { id: MobId(0), tier: 1, kind: crate::spec::GooKind::Green, pos: Vec3::new(4.0, 0.0, 3.0) },
        MobSpec { id: MobId(1), tier: 1, kind: crate::spec::GooKind::Green, pos: Vec3::new(4.4, 0.0, 3.0) },
    ];
    spec.traps = vec![TrapSpec { id: 0, pos: Vec3::new(4.2, 0.0, 3.0), strength: 2.0, radius: 3.0, off_tick: 0 }];
    spec
}

#[test]
fn goo_two_blobs_merge_on_contact() {
    // two Mediums (tier 1) held together by a trap fuse into one Large (tier
    // 0) once their merge-grace lapses — the inverse of the shot-split. The
    // lower id survives. (Runs past GOO_MERGE_GRACE = 45 ticks.)
    let mut g = HouseGame::new(&merge_pair_level(), VecSink::default());
    assert_eq!(g.mobs.len(), 2, "two blobs to start");
    for t in 0..90 {
        g.tick(Tick(t), &[]);
    }
    assert_eq!(g.mobs.len(), 1, "the two blobs fused into one");
    let surv = *g.world.get::<&Goo>(g.mobs[0]).unwrap();
    assert_eq!(surv.id, MobId(0), "the lower id survives the fusion");
    assert_eq!(surv.tier, 0, "the survivor grew one tier (Medium → Large)");
    assert_eq!(g.world.query::<&Goo>().iter().count(), 1, "handle list matches the World");
    assert!(g.sink.0.iter().any(|q| q.id.0 == "goo_merge"), "a merge cue fired");
}

#[test]
fn goo_overlapping_bodies_push_apart_not_through() {
    use crate::spec::MobSpec;
    // two Larges (tier 0 — NEVER merge-compatible) dropped superimposed in
    // the open centre of room E must separate: the blob–blob contact
    // repulsion pushes the bodies apart, where the old blind per-blob PBF
    // left them crawling through each other (and the render's global smin
    // union welded the pair into one lump). The player is parked across
    // the house (no seek, no pillar) and the run stays under the first
    // mitosis bud (~tick 100) so the scene is exactly the pair.
    let mut spec = goo_level();
    spec.mobs = vec![
        MobSpec { id: MobId(0), tier: 0, kind: crate::spec::GooKind::Green, pos: Vec3::new(9.5, 0.0, 5.5) },
        MobSpec { id: MobId(1), tier: 0, kind: crate::spec::GooKind::Green, pos: Vec3::new(9.8, 0.0, 5.5) },
    ];
    spec.traps = vec![];
    spec.player_start = Vec3::new(1.5, 0.0, 1.5);
    let g = run_ticks(&spec, 90);
    assert_eq!(g.mobs.len(), 2, "tier-0 pairs never merge");
    let a = g.world.get::<&Goo>(g.mobs[0]).unwrap().centroid();
    let b = g.world.get::<&Goo>(g.mobs[1]).unwrap().centroid();
    let d = (a - b).length();
    assert!(d > 0.8, "overlapping bodies failed to push apart: centroids {d:.3} wu apart");
}

#[test]
fn goo_merge_round_trip_is_deterministic() {
    // fusion draws RNG + despawns via the command buffer — it must replay
    // bit-identically across two worlds.
    let run = || run_ticks(&merge_pair_level(), 90);
    let a = run();
    let b = run();
    assert_eq!(a.state_hash(), b.state_hash(), "merge replay must be bit-identical");
    assert_eq!(a.snapshot().mobs, b.snapshot().mobs, "render poses must match");
    assert_eq!(a.mobs.len(), 1, "the pair actually fused");
}

#[test]
fn goo_drapes_around_player_pillar_not_through() {
    use crate::spec::{playground_level, MobSpec};
    // the goo treats the player's pillar as solid (the player does not):
    // a blob seeking the player crawls up and drapes AROUND it — no particle
    // ever ends inside the pillar footprint.
    let mut spec = playground_level();
    spec.player_start = Vec3::new(2.0, 0.0, 2.0);
    spec.mobs = vec![MobSpec { id: MobId(0), tier: 0, kind: crate::spec::GooKind::Green, pos: Vec3::new(0.8, 0.0, 2.0) }];
    spec.traps = vec![];
    let g = run_ticks(&spec, 150);
    let blob = *g.world.get::<&Goo>(g.mobs[0]).unwrap();
    let pp = Vec2::new(2.0, 2.0);
    for p in &blob.parts {
        assert!((p.x - pp.x).abs() >= PLAYER_HALF || (p.y - pp.y).abs() >= PLAYER_HALF, "a particle penetrated the player pillar: {p:?}");
    }
    // and it really came up to the player (so the assertion above is meaningful)
    assert!((blob.centroid() - pp).length() < 1.4, "the blob crawled up to the player: {:?}", blob.centroid());
}

#[test]
fn goo_level_leaves_mob_free_levels_untouched() {
    // sanity: constructing the mob-free levels spawns no Goo and the hash
    // excludes the mob block (the replay goldens above already pin this).
    let g = HouseGame::new(&game_level(), VecSink::default());
    assert_eq!(g.mobs.len(), 0);
    assert!(g.snapshot().mobs.is_empty());
}

#[test]
fn survival_off_is_hash_stable_and_hud_neutral() {
    // a survival-OFF level (game_level) carries NO survival components: the
    // snapshot reports full needs + empty inventory, and the hash is exactly
    // the survival-disabled hash (the replay goldens pin the real value).
    let g = HouseGame::new(&game_level(), VecSink::default());
    let snap = g.snapshot();
    assert_eq!(snap.hunger, 1.0);
    assert_eq!(snap.battery, 1.0);
    assert_eq!(snap.inventory, Vec::<ItemKind>::new());
    // Use is a no-op on a survival-off level (no panic, no state change)
    let mut d = GameDrv::new();
    let h0 = d.g.state_hash();
    d.cmd(Command::Use { kind: ItemKind::Food });
    assert_eq!(d.g.state_hash(), h0, "Use must not perturb a survival-off level");
}

// Goo-sim determinism oracle. // Golden anchor: must not change.
//
// The goo goldens (house/lab/grid/game/game_replay) are all MOB-FREE, so the
// goo sim's float results are NOT exercised by any image golden, and the
// round-trip tests above only compare new-vs-new (they catch non-determinism,
// not a float REORDER that is consistently wrong). These pinned hashes are
// the real guard: any change that perturbs the goo sim's float evaluation
// order moves a hash and fails here. Each scenario exercises a distinct slice
// of `goo_system`:
//   goo_level@300  — crawl/gait/AI/PBF + tier-0 mitosis (budding, mother
//                    gravity, tether, wobble) across a full spawn period.
//   goonursery@400 — the pure mitosis showcase (single tier-0 mother).
//   split@trace    — `damage_goo` shot-driven split cascade.
//   merge@90       — `merge_system` fusing-collapse + survivor promotion.
// If a hash changes from an INTENTIONAL behaviour change, re-capture and
// explain why in the commit; if it changes from a refactor, the refactor
// reordered floats and must be reverted.
// Re-captured 2026-07-02 (second pass): the gait `gather` envelope is now
// seam-free (the smoothstep release/rise replaces two per-cycle force
// steps — every blob every tick, so ALL FOUR moved), and blob–blob contact
// repulsion landed (goo_overlapping_bodies_push_apart_not_through pins the
// behaviour). The nursery hash is byte-identical under different repulsion
// tunings — the tether opt-out + the mini clearing the contact skin before
// the snap mean repulsion never fires there, so the birth choreography is
// pinned unperturbed; its movement is the gait smoothing alone.
// (First pass earlier today: tail-anchor collide_and_slide + damage_goo
// dead-guard/pending-cap — see the commit introducing them.)
// Re-captured 2026-07-03: the arena-species block (GooKind + cure +
// harpoon pin) appended five fields to the per-blob hash fold — HASH BYTES
// ONLY. Behavior on these all-Green levels is bit-identical by
// construction: Green multipliers are exact ×1.0 IEEE identities, cure/
// pinned default 0 (their branches never run), and the pin spring adds
// Vec2::ZERO through the mother-well channel. All new Goo fields were
// deliberately batched into this ONE recapture (see docs/goo-mob-handoff).
const ORACLE_GOO_LEVEL_300: u64 = 0x5644a8cc5c2f849c;
const ORACLE_GOONURSERY_400: u64 = 0x101f8d4981288431;
const ORACLE_SPLIT_TRACE: u64 = 0x0d970347abdd933b;
const ORACLE_MERGE_90: u64 = 0xb0f0b86bcd448008;

#[test]
fn goo_sim_hash_oracle_crawl_and_mitosis() {
    let mut a = GooDrv::new();
    a.run(300);
    assert_eq!(a.g.state_hash(), ORACLE_GOO_LEVEL_300, "got {:#018x}", a.g.state_hash());
}

#[test]
fn goo_sim_hash_oracle_nursery() {
    let n = run_ticks(&crate::spec::goonursery_level(), 400);
    assert_eq!(n.state_hash(), ORACLE_GOONURSERY_400, "got {:#018x}", n.state_hash());
}

#[test]
fn goo_sim_hash_oracle_split() {
    let mut s = GooDrv::new();
    for _ in 0..6 {
        s.shoot_at(Vec2::new(9.5, 4.8));
        s.run(16);
    }
    s.run(40);
    assert_eq!(s.g.state_hash(), ORACLE_SPLIT_TRACE, "got {:#018x}", s.g.state_hash());
}

#[test]
fn goo_sim_hash_oracle_merge() {
    let m = run_ticks(&merge_pair_level(), 90);
    assert_eq!(m.state_hash(), ORACLE_MERGE_90, "got {:#018x}", m.state_hash());
}

// ---- M1: the arena fail state + biomass economy ------------------------------

/// A blob parked ON the player drains integrity to zero and downs the run at
/// a deterministic tick; a re-run of the same setup dies at the SAME tick.
#[test]
fn engulf_drains_integrity_and_downs_the_run_deterministically() {
    let run_once = || {
        let mut spec = crate::spec::arena_level();
        spec.static_solids = vec![];
        // one Large dropped basically on the spawn point: it will engulf
        spec.mobs = vec![MobSpec { id: MobId(0), tier: 0, kind: crate::spec::GooKind::Green, pos: Vec3::new(0.0, 0.0, 5.5) }];
        let mut g = HouseGame::new(&spec, VecSink::default());
        assert_eq!(g.res.run.unwrap().integrity, 1.0);
        for t in 0..3600u64 {
            g.tick(Tick(t), &[]);
            let r = g.res.run.unwrap();
            if r.dead {
                assert_eq!(r.integrity, 0.0);
                return r.death_tick;
            }
        }
        panic!("the engulf never downed the run in 60 s");
    };
    let a = run_once();
    let b = run_once();
    assert_eq!(a, b, "death tick replays bit-exact");
    assert!(a > 30, "dying takes longer than half a second (tick {a})");
}

/// A downed run ignores the player verbs: Move/Shoot do nothing after death.
#[test]
fn downed_run_locks_out_player_verbs() {
    let mut spec = crate::spec::arena_level();
    spec.static_solids = vec![];
    spec.mobs = vec![MobSpec { id: MobId(0), tier: 0, kind: crate::spec::GooKind::Green, pos: Vec3::new(0.0, 0.0, 5.5) }];
    let mut g = HouseGame::new(&spec, VecSink::default());
    let mut t = 0u64;
    while !g.res.run.unwrap().dead {
        g.tick(Tick(t), &[]);
        t += 1;
        assert!(t < 3600, "must die within 60 s");
    }
    let p0 = g.player_pos();
    let shots0 = g.projectiles.len();
    for k in 0..30 {
        g.tick(Tick(t + k), &[Command::Move { dir: IVec2::new(1, 0) }, Command::Shoot { ray: PickRay { origin: Vec3::new(p0.x, 0.95, p0.z), dir: Vec3::new(0.0, -0.1, -1.0).normalize() } }]);
    }
    let p1 = g.player_pos();
    // the goo may still SHOVE the corpse, but walking must not engage: with
    // the blob parked on us the shove is inward-symmetric, so any drift stays
    // far below 30 ticks of walking (which would cover ~1.5 wu)
    assert!((p1 - p0).length() < 0.5, "no player-driven walking while down: {p0:?} -> {p1:?}");
    assert_eq!(g.projectiles.len(), shots0, "no shots fire while down");
}

/// Biomass pays only when mass leaves the board: a split pays 0, a terminal
/// Small pays 1, a Large solidify pays 2x its net mass (4).
#[test]
fn biomass_pays_for_removal_not_splits() {
    let mut spec = crate::spec::arena_level();
    spec.static_solids = vec![];
    spec.player_start = Vec3::new(0.0, 0.0, 9.0); // far corner: no engulf noise
    spec.mobs = vec![
        MobSpec { id: MobId(0), tier: 1, kind: crate::spec::GooKind::Green, pos: Vec3::new(-6.0, 0.0, -6.0) },
        MobSpec { id: MobId(1), tier: 2, kind: crate::spec::GooKind::Green, pos: Vec3::new(6.0, 0.0, -6.0) },
        MobSpec { id: MobId(2), tier: 0, kind: crate::spec::GooKind::Green, pos: Vec3::new(0.0, 0.0, 0.0) },
    ];
    let mut g = HouseGame::new(&spec, VecSink::default());
    g.tick(Tick(0), &[]);
    // split a Medium: two Smalls appear, NOTHING leaves the board -> +0
    let e0 = g.mobs[0];
    let c0 = g.world.get::<&Goo>(e0).unwrap().centroid();
    g.damage_goo(e0, Vec3::new(c0.x, 0.3, c0.y), Vec3::Z, 99, 0.0, WeaponClass::Standard);
    g.tick(Tick(1), &[]);
    assert_eq!(g.res.score, 0, "a split pays nothing");
    // terminal-kill the authored Small -> +1 (its mass)
    let small = g.mobs.iter().copied().find(|&e| g.world.get::<&Goo>(e).unwrap().id == MobId(1)).unwrap();
    let c1 = g.world.get::<&Goo>(small).unwrap().centroid();
    g.damage_goo(small, Vec3::new(c1.x, 0.3, c1.y), Vec3::Z, 99, 0.0, WeaponClass::Standard);
    g.tick(Tick(2), &[]);
    assert_eq!(g.res.score, 1, "terminal Small pays its mass");
    // cure a Large to the chunk threshold, then kill: solidify pays
    // 2 x (mass(L) - mass(escapee M)) = 2 x (4 - 2) = 4
    let large = g.mobs.iter().copied().find(|&e| g.world.get::<&Goo>(e).unwrap().id == MobId(2)).unwrap();
    let cl = g.world.get::<&Goo>(large).unwrap().centroid();
    g.damage_goo(large, Vec3::new(cl.x, 0.3, cl.y), Vec3::Z, 1, 0.0, WeaponClass::Slug);
    g.tick(Tick(3), &[]);
    let cl = g.world.get::<&Goo>(large).unwrap().centroid();
    g.damage_goo(large, Vec3::new(cl.x, 0.3, cl.y), Vec3::Z, 99, 0.0, WeaponClass::Slug);
    g.tick(Tick(4), &[]);
    assert_eq!(g.res.score, 1 + 4, "Large solidify pays 2x net mass");
    assert_eq!(g.res.chunks.len(), 1, "and leaves the chunk");
}
