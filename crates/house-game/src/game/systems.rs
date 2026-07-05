//! The core per-tick systems (split out of `game.rs` — pure motion): command
//! resolution, doors, walking, flashlight, lights, audio, plus the shared
//! ray/handle helpers. `impl HouseGame` methods in a CHILD module of `game`
//! (the goo/weapon pattern), so they reach `Res`'s private fields with no
//! visibility widening. The ONE authoritative per-tick order stays in
//! `tick()` in game.rs (one commented call per step); more systems live in
//! game/goo/, game/weapon.rs and game/survival.rs.
use super::*;

impl<S: AudioSink> HouseGame<S> {
    /// True if ground point (x, z) is blocked for WALKING: level (floor rect +
    /// static solids) or any present door leaf solid.
    pub(super) fn walk_blocked(&self, x: f32, z: f32) -> bool {
        self.res.level.is_blocked(x, z)
            || self.res.dyn_solids.iter().any(|(_, s)| x >= s[0] && z >= s[1] && x <= s[2] && z <= s[3])
            || self.res.chunks.iter().any(|s| x >= s[0] && z >= s[1] && x <= s[2] && z <= s[3])
    }


    /// Nearest door whose interact volume (closed slab inflated 0.3 wu) the
    /// ray passes through, regardless of current state.
    fn door_under_ray(&self, ray: &PickRay) -> Option<DoorId> {
        let mut best: Option<(f32, DoorId)> = None;
        for &e in &self.doors {
            let door = self.world.get::<&Door>(e).unwrap();
            let body = self.world.get::<&DoorBody>(e).unwrap();
            let s = body.closed_solid;
            let lo = Vec3::new(s[0] - DOOR_INTERACT_INFLATE, -DOOR_INTERACT_INFLATE, s[1] - DOOR_INTERACT_INFLATE);
            let hi = Vec3::new(s[2] + DOOR_INTERACT_INFLATE, DOOR_H + DOOR_INTERACT_INFLATE, s[3] + DOOR_INTERACT_INFLATE);
            if let Some((tmin, _)) = ray_aabb(ray, lo, hi) {
                if tmin >= 0.0 && best.is_none_or(|(bt, _)| tmin < bt) {
                    best = Some((tmin, door.id));
                }
            }
        }
        best.map(|(_, id)| id)
    }
    /// Commands → semantic intents. Click: door interact beats ground walk;
    /// walks to blocked/off-floor points are no-ops (no clamp-to-edge in v1).
    pub(super) fn resolve_commands(&mut self, cmds: &[Command]) {
        self.res.staging.clear();
        // a downed run ignores the player verbs — walking, shooting, weapon
        // swaps. Camera rotation and light toggles stay live (corpse cam).
        let downed = self.res.run.is_some_and(|r| r.dead || r.won);
        for c in cmds {
            if downed && matches!(c, Command::Click { .. } | Command::Shoot { .. } | Command::Move { .. } | Command::SelectWeapon { .. } | Command::PickCard { .. } | Command::Aim { .. }) {
                continue;
            }
            match c {
                Command::Click { ray, ground } => {
                    if let Some(id) = self.door_under_ray(ray) {
                        self.res.staging.use_door.push(id);
                    } else if let Some(g) = ground {
                        if !self.walk_blocked(g.x, g.y) {
                            self.res.buf.insert_one(self.player, WalkTarget { ground: *g, blocked_ticks: 0 });
                        }
                    }
                }
                Command::Shoot { ray } => self.res.staging.shot_intents.push(*ray),
                Command::Move { dir } => self.res.staging.move_dir = *dir, // last press this tick wins
                Command::Aim { dir } => {
                    // arena turret: the mouse owns Facing (walk_system's write
                    // is arsenal-gated off). No-op elsewhere so cave traces /
                    // the flashlight's walk-aim semantics never change.
                    if self.res.arsenal.is_some() {
                        if let Some(d) = dir.try_normalize() {
                            self.world.get::<&mut Facing>(self.player).unwrap().0 = d;
                        }
                    }
                }
                Command::ToggleFlashlight => {
                    // A dead battery (battery == 0) makes turning the torch ON
                    // a no-op: you can't light a flashlight with no charge.
                    // Turning it off always works. (Survival-off games have no
                    // Battery component → the guard is vacuously true.)
                    let dead = self.battery_dead();
                    let mut fl = self.world.get::<&mut Flashlight>(self.player).unwrap();
                    let want_on = !fl.on;
                    if want_on && dead {
                        // swallowed: no state change, no Switch cue
                    } else {
                        fl.on = want_on;
                        drop(fl);
                        self.res.events.emit(GameEvent::Switch);
                    }
                }
                Command::ToggleRoomLights => {
                    self.res.master_lights = !self.res.master_lights;
                    self.res.events.emit(GameEvent::Switch);
                }
                Command::RotateCamera { dq } => self.res.yaw_q = (self.res.yaw_q as i32 + *dq as i32).rem_euclid(4) as u32,
                Command::Use { kind } => self.res.staging.use_items.push(*kind), // applied by use_system
                Command::SelectWeapon { slot } => {
                    // arsenal levels only; unknown slots are swallowed. Selection
                    // is instant and does NOT reset the shared cooldown timer.
                    if let (Some(a), Some(k)) = (self.res.arsenal.as_mut(), WeaponKind::from_slot(*slot)) {
                        a.current = k;
                    }
                }
                Command::PickCard { slot } => self.pick_card(*slot),
            }
        }
    }

    /// Door state machines on tick counters. The leaf collision solid is
    /// present iff the door is not fully Open; the anti-trap rule refuses to
    /// re-insert it (i.e. to start Closing) while the player AABB overlaps.
    pub(super) fn door_system(&mut self) {
        let p = self.player_pos();
        for &e in &self.doors {
            let (body_solid, hinge, anim) = {
                let body = self.world.get::<&DoorBody>(e).unwrap();
                (body.closed_solid, body.hinge, body.anim_ticks)
            };
            let mut door = self.world.get::<&mut Door>(e).unwrap();
            let used = self.res.staging.use_door.contains(&door.id);
            let id = door.id;
            door.state = match door.state {
                DoorState::Closed if used => DoorState::Opening(anim),
                DoorState::Open if used => {
                    let s = body_solid;
                    let overlap = p.x + PLAYER_HALF > s[0] && p.x - PLAYER_HALF < s[2] && p.z + PLAYER_HALF > s[1] && p.z - PLAYER_HALF < s[3];
                    if overlap {
                        DoorState::Open // refused: never trap the player
                    } else {
                        DoorState::Closing(anim)
                    }
                }
                DoorState::Opening(k) => {
                    let k = k - 1;
                    if k == 0 {
                        self.res.events.emit(GameEvent::DoorOpened(id, hinge));
                        DoorState::Open
                    } else {
                        DoorState::Opening(k)
                    }
                }
                DoorState::Closing(k) => {
                    let k = k - 1;
                    if k == 0 {
                        self.res.events.emit(GameEvent::DoorClosed(id, hinge));
                        DoorState::Closed
                    } else {
                        DoorState::Closing(k)
                    }
                }
                s => s,
            };
        }
        self.rebuild_dyn_solids();
    }

    pub(super) fn rebuild_dyn_solids(&mut self) {
        self.res.dyn_solids.clear();
        for &e in &self.doors {
            let door = self.world.get::<&Door>(e).unwrap();
            if door.state != DoorState::Open {
                let body = self.world.get::<&DoorBody>(e).unwrap();
                self.res.dyn_solids.push((door.id, body.closed_solid));
            }
        }
        // self.doors is id-sorted, so dyn_solids already is too
    }

    /// Movement: manual Move (iso 2:1 input dir) wins over a WalkTarget;
    /// both integrate at the floored speed on the screen-pixel basis at yaw_q
    /// and collide-and-slide. Arrive (< 1 px) or blocked-two-ticks clears the
    /// target. Facing tracks the ATTEMPTED direction (turning against a wall).
    pub(super) fn walk_system(&mut self) {
        let yaw = 90.0 * self.res.yaw_q as f32;
        let speed = {
            let pl = self.world.get::<&Player>(self.player).unwrap();
            // Starving (hunger == 0) scales the effective px/s by
            // hunger_zero_speed_mul. We scale BEFORE the smoothness floor so a
            // slow-walk can dip below recommendedMinPxPerSec by design (the
            // cornerstone trajectory + mesh stability still hold; the eye just
            // sees discrete ticks — see CLAUDE.md invariant 10).
            let mul = if let Some(sp) = self.res.survival {
                if self.world.get::<&Hunger>(self.player).map(|h| h.0 <= 0.0).unwrap_or(false) {
                    sp.hunger_zero_speed_mul
                } else {
                    1.0
                }
            } else {
                1.0
            };
            // draft SERVO LEGS stack multiplicatively on top (empty off arena)
            let mul = mul * speed_mult(&self.res.picked);
            (pl.speed_px * mul).max(recommended_min_px_per_sec(60.0) * mul)
        };
        let pos = self.player_pos();
        let manual = self.res.staging.move_dir != IVec2::ZERO;
        let dpx: Option<Vec2> = if manual {
            // WASD fallback: a held key overrides (and cancels) click-walk
            if self.world.get::<&WalkTarget>(self.player).is_ok() {
                self.res.buf.remove_one::<WalkTarget>(self.player);
            }
            iso_input_dir(self.res.staging.move_dir.x as f32, self.res.staging.move_dir.y as f32).map(|d| d * speed * TICK_DT)
        } else if let Ok(wt) = self.world.get::<&WalkTarget>(self.player) {
            // remaining screen-px vector to the target at the CURRENT yaw
            let (_d, right, up) = iso_basis(yaw);
            let tgt = Vec3::new(wt.ground.x, 0.0, wt.ground.y);
            let d = Vec2::new((tgt - pos).dot(right) * ISO_R, -(tgt - pos).dot(up) * ISO_R);
            if d.length() < WALK_ARRIVE_PX {
                drop(wt);
                self.res.buf.remove_one::<WalkTarget>(self.player);
                None
            } else {
                Some(d * (d.length().min(speed * TICK_DT) / d.length()))
            }
        } else {
            None
        };
        // Arena walk momentum: ramp the applied step toward the input step
        // (accel) and back to zero (a short skid) instead of binary
        // start/stop. GATED on the arsenal so every non-arena level keeps the
        // verbatim instant-walk float path (goo oracles + cave replay).
        let dpx = if self.res.arsenal.is_some() {
            let desired = dpx.unwrap_or(Vec2::ZERO);
            let v = &mut self.res.walk_vel_px;
            let k = if desired.length_squared() >= v.length_squared() { WALK_ACCEL } else { WALK_DECEL };
            *v += (desired - *v) * k;
            // parked: kill the sub-hundredth-px tail so idle is exactly zero
            if desired == Vec2::ZERO && v.length_squared() < 1e-4 {
                *v = Vec2::ZERO;
            }
            if *v == Vec2::ZERO { None } else { Some(*v) }
        } else {
            dpx
        };
        let Some(dpx) = dpx else { return };
        let world_d = screen_px_to_world(dpx, yaw);
        // Facing tracks the walk OFF arena only (torch aims where you walked).
        // On arena the mouse owns Facing (Command::Aim, tank-turret) — the
        // walk must not wrench the gun off the cursor every step.
        if self.res.arsenal.is_none() {
            if let Some(f) = Vec2::new(world_d.x, world_d.z).try_normalize() {
                self.world.get::<&mut Facing>(self.player).unwrap().0 = f;
            }
        }
        let (px, pz) = {
            let blocked = |x: f32, z: f32| self.walk_blocked(x, z);
            collide_and_slide(blocked, pos.x, pos.z, world_d.x, world_d.z)
        };
        if px != pos.x || pz != pos.z {
            let mut p = self.world.get::<&mut Pos>(self.player).unwrap();
            p.0.x = px;
            p.0.z = pz;
        }
        // blocked accounting needs an epsilon: the screen->world round trip of
        // an axis-aligned walk leaves ~1e-7 wu of f32 drift on the slide axis,
        // which must not read as progress (a hard-blocked walk would then
        // never clear). Real steps are >= ~1e-2 wu (the 1 px arrive floor).
        let advanced = (px - pos.x).abs() > 1e-5 || (pz - pos.z).abs() > 1e-5;
        if !manual {
            if let Ok(mut wt) = self.world.get::<&mut WalkTarget>(self.player) {
                if advanced {
                    wt.blocked_ticks = 0;
                } else {
                    wt.blocked_ticks += 1;
                    if wt.blocked_ticks >= WALK_BLOCKED_TICKS {
                        drop(wt);
                        self.res.buf.remove_one::<WalkTarget>(self.player);
                    }
                }
            }
        }
    }


    /// Flashlight pose from the lattice-snapped position + facing (the same
    /// pure function the viewer uses).
    pub(super) fn flashlight_system(&mut self) {
        let yaw = 90.0 * self.res.yaw_q as f32;
        let p = snap_ground_to_lattice(self.player_pos(), yaw);
        let (pos, dir) = flashlight_pose(p, self.player_facing());
        self.res.flash_pose = FlashPose { pos, dir };
    }

    /// Per-light emission at sim time `t`: room master AND per-light state
    /// gate each light (screens ignore the wall switch, matching the renderer:
    /// devices are not room lighting), flicker modulates the lit ones.
    /// `room_lights` = lit fraction of the switchable (non-screen) lights —
    /// the probe-bank lerp scalar (known v1 GI approximation, ARCHITECTURE.md).
    pub(super) fn light_system(&mut self, t: f32) {
        self.res.light_rgb.clear();
        let mut lit = 0u32;
        let mut switchable = 0u32;
        for &e in &self.lights {
            let l = self.world.get::<&Light>(e).unwrap();
            let screen = l.kind == LightKind::Screen;
            let on = l.on && (screen || self.res.master_lights);
            if !screen {
                switchable += 1;
                lit += on as u32;
            }
            let rgb = if on {
                let (f, tint) = flicker(l.kind.curve_kind(), l.li, t);
                let f = f.max(0.05); // renderer's anim floor
                [l.base_rgb[0] * f * tint[0], l.base_rgb[1] * f * tint[1], l.base_rgb[2] * f * tint[2]]
            } else {
                [0.0; 3]
            };
            self.res.light_rgb.push((l.id, rgb));
        }
        self.res.room_lights = if switchable == 0 { 0.0 } else { lit as f32 / switchable as f32 };
    }

    /// Domain events → audio cues into the injected sink, emission order.
    pub(super) fn audio_system(&mut self) {
        for ev in self.res.events.drain() {
            // Observation tap (lab only): record the STRUCTURED event before it
            // is flattened to a (lossy) AudioCue. Pure copy into an Option buffer
            // — touches nothing the hash reads.
            if let Some(tap) = self.res.event_tap.as_mut() {
                tap.push(ev);
            }
            let cue = match ev {
                GameEvent::DoorOpened(_, p) => AudioCue { id: CueId("door_open"), pos: Some(p), gain: 1.0 },
                GameEvent::DoorClosed(_, p) => AudioCue { id: CueId("door_close"), pos: Some(p), gain: 1.0 },
                GameEvent::ShotFired(p, class) => AudioCue {
                    id: CueId(match class {
                        WeaponClass::Standard => "pistol_fire",
                        WeaponClass::Slug => "fire_slug",
                        WeaponClass::Uzi => "fire_uzi",
                        WeaponClass::Shotgun => "fire_shotgun",
                        WeaponClass::Grenade => "fire_grenade",
                        WeaponClass::Harpoon => "fire_harpoon",
                    }),
                    pos: Some(p),
                    gain: 1.0,
                },
                GameEvent::Detonated(p) => AudioCue { id: CueId("boom"), pos: Some(p), gain: 1.0 },
                GameEvent::WaveLanded(_) => AudioCue { id: CueId("wave_land"), pos: None, gain: 1.0 },
                GameEvent::Impact(p, _) => AudioCue { id: CueId("impact"), pos: Some(p), gain: 0.6 },
                GameEvent::TargetHit(_, p) => AudioCue { id: CueId("target_hit"), pos: Some(p), gain: 1.0 },
                GameEvent::Switch => AudioCue { id: CueId("switch"), pos: None, gain: 0.6 },
                GameEvent::PickedUp(_, _, p) => AudioCue { id: CueId("pickup"), pos: Some(p), gain: 0.8 },
                GameEvent::Consumed(_) => AudioCue { id: CueId("eat"), pos: None, gain: 0.7 },
                GameEvent::MobHit(_, p) => AudioCue { id: CueId("goo_hit"), pos: Some(p), gain: 0.7 },
                GameEvent::MobSplit(_, p) => AudioCue { id: CueId("goo_split"), pos: Some(p), gain: 1.0 },
                GameEvent::MobKilled(_, p) => AudioCue { id: CueId("goo_die"), pos: Some(p), gain: 0.8 },
                GameEvent::MobMerged(_, p) => AudioCue { id: CueId("goo_merge"), pos: Some(p), gain: 0.9 },
                GameEvent::MobSolidified(_, p) => AudioCue { id: CueId("goo_solidify"), pos: Some(p), gain: 0.9 },
                // need-state crossings are HUD/feedback events, no audio cue yet;
                // bleed droplets are pure presentation (the hit cue already plays)
                GameEvent::NeedCritical(_) | GameEvent::NeedRecovered(_) | GameEvent::GooSplashed(..) => continue,
                GameEvent::CardPicked(_) => AudioCue { id: CueId("card_pick"), pos: None, gain: 0.8 },
                GameEvent::PlayerDown => AudioCue { id: CueId("player_down"), pos: None, gain: 1.0 },
                GameEvent::LightsOut => AudioCue { id: CueId("lights_out"), pos: None, gain: 1.0 },
                GameEvent::GooEscaped(_) => AudioCue { id: CueId("breach"), pos: None, gain: 1.0 },
                GameEvent::ShiftComplete => AudioCue { id: CueId("shift_done"), pos: None, gain: 1.0 },
            };
            self.sink.play(cue);
        }
    }

    /// Current swing angle of a door (radians; 0 closed .. open_angle open).
    pub(super) fn door_angle(&self, e: Entity) -> f32 {
        let door = self.world.get::<&Door>(e).unwrap();
        let body = self.world.get::<&DoorBody>(e).unwrap();
        let n = body.anim_ticks as f32;
        match door.state {
            DoorState::Closed => 0.0,
            DoorState::Open => body.open_angle,
            DoorState::Opening(k) => body.open_angle * (1.0 - k as f32 / n),
            DoorState::Closing(k) => body.open_angle * (k as f32 / n),
        }
    }
}

/// Rebuild a StableId-sorted entity handle list from a World query — the shared
/// runtime-spawn handle recovery used for both the goo (`Goo`/`MobId`) and the
/// projectile (`Projectile`/`ProjectileId`) lists. `CommandBuffer::spawn` does
/// not return the `Entity` it creates, so after a structural flush we re-find
/// every live `C` and sort by its stable id. The sort key — never archetype
/// order — becomes the iteration/hash order, so determinism holds (ids are
/// unique, so the unstable sort is fully ordered).
pub(crate) fn id_sorted_handles<C: Component, Id: Ord + Copy>(world: &World, id_of: impl Fn(&C) -> Id) -> Vec<Entity> {
    let mut pairs: Vec<(Id, Entity)> = world.query::<&C>().iter().map(|(e, c)| (id_of(c), e)).collect();
    pairs.sort_by_key(|(id, _)| *id);
    pairs.into_iter().map(|(_, e)| e).collect()
}

/// Ray vs AABB (slab method) → Some((t_entry, t_exit)) when the ray crosses
/// it (t_exit ≥ max(t_entry, 0)); t_entry may be negative when the origin is
/// inside. Zero direction components handled exactly (no 0/0 NaN).
pub(crate) fn ray_aabb(ray: &PickRay, lo: Vec3, hi: Vec3) -> Option<(f32, f32)> {
    let (mut tmin, mut tmax) = (f32::MIN, f32::MAX);
    for a in 0..3 {
        let (o, d, l, h) = (ray.origin[a], ray.dir[a], lo[a], hi[a]);
        if d.abs() < 1e-9 {
            if o < l || o > h {
                return None;
            }
            continue;
        }
        let (t1, t2) = ((l - o) / d, (h - o) / d);
        let (t1, t2) = if t1 <= t2 { (t1, t2) } else { (t2, t1) };
        tmin = tmin.max(t1);
        tmax = tmax.min(t2);
    }
    (tmax >= tmin.max(0.0)).then_some((tmin, tmax))
}
