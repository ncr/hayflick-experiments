//! THE REPLAY ORACLE — `snapshot()` and `state_hash()` (split out of
//! `game.rs`, pure motion; the `Simulation` impl in game.rs delegates here).
//! Do not edit casually: the hash fold — its FIXED field-visit order, every
//! float op, and which components are folded — is the contract every replay
//! golden and determinism test asserts against (full doc on [`HouseGame::
//! hash_impl`]). A change here that moves any pinned hash is a BEHAVIOR
//! change and needs its oracles re-captured with a dated note saying why.
use super::*;

impl<S: AudioSink> HouseGame<S> {
    /// Pure read — never advances RNG or any other state (pinned by test).
    pub(super) fn snapshot_impl(&self) -> GameSnapshot {
        let yaw = 90.0 * self.res.yaw_q as f32;
        GameSnapshot {
            player_pos: snap_ground_to_lattice(self.player_pos(), yaw),
            facing: self.player_facing(),
            flashlight: self.world.get::<&Flashlight>(self.player).unwrap().on,
            muzzle_flash: self.res.muzzle_ticks > 0,
            doors: self.doors.iter().map(|&e| (self.world.get::<&Door>(e).unwrap().id, self.door_angle(e))).collect(),
            lights: self.res.light_rgb.clone(),
            room_lights: self.res.room_lights,
            yaw_q: self.res.yaw_q,
            score: self.res.score,
            // survival fields read the components when present; survival-off
            // games have none → full needs, empty inventory (HUD-neutral).
            hunger: self.world.get::<&Hunger>(self.player).map(|h| h.0).unwrap_or(1.0),
            battery: self.world.get::<&Battery>(self.player).map(|b| b.0).unwrap_or(1.0),
            inventory: self.world.get::<&Inventory>(self.player).map(|i| i.items.clone()).unwrap_or_default(),
            // arsenal HUD (arena levels): selected weapon + shared cooldown
            weapon: self.res.arena.arsenal.map(|a| {
                let cd = self.world.get::<&GunCooldown>(self.player).unwrap().cooldown_ticks;
                (a.current, cd, self.current_weapon().cooldown_ticks)
            }),
            boom: self.res.arena.boom.map(|(at, t)| (at, t as f32 / BOOM_FLASH_TICKS as f32)),
            wave: self.res.arena.wave.map(|w| w.idx),
            run: self.res.arena.run,
            draft: self.res.arena.draft,
            picked: self.res.arena.picked.len() as u32,
            breach: self.res.arena.drain.map(|_| (self.res.arena.breach, BREACH_CAP)),
            // goo blobs (MobId-sorted): ends + particle cloud lifted to body
            // height. Pure read of the hashed field — empty on mob-free levels.
            mobs: self
                .mobs
                .iter()
                .map(|&e| {
                    let g = self.world.get::<&Goo>(e).unwrap();
                    // render size follows the (smoothly ramped) spine length, so a
                    // just-merged blob grows into its new tier instead of popping.
                    // Identical to goo_tier_radius(tier) for a settled blob.
                    // tension (the birth push) shrinks the drawn size in lockstep
                    // with the fluid footprint, so she visibly balls up then swells
                    // back — identical factor to goo_system's g_scale shrink.
                    let tense = goo_tension(g.tier, g.spawn_timer, g.birth_glow);
                    let r = g.body_len / GOO_BODY_FRAC * (1.0 - GOO_TENSE_SHRINK * tense);
                    let pr = r * GOO_PART_RADIUS_FRAC;
                    // the render pose (jelly-wobble squash), the per-particle
                    // birth glow, and the vertical body scale are pure
                    // presentation reads of the hashed state.
                    let parts = goo_render_parts(&g, pr);
                    let glow = goo_render_glow(&g);
                    let vscale = goo_render_vscale(&g);
                    MobRender { id: g.id, tier: g.tier, kind: g.kind, cure: g.cure, weak: goo_is_weak(&g), parts, radius: r, part_radius: pr, glow, vscale, comm: comm_pulse(g.tac, g.strike, self.res.cur_tick), tac: g.tac, escaping: self.res.arena.drain.is_some_and(|z| g.kind != crate::spec::GooKind::Runner && g.centroid().y > z[1] - 2.5) }
                })
                .collect(),
            // projectiles in flight (ProjectileId-sorted) — empty when idle.
            projectiles: self
                .projectiles
                .iter()
                .map(|&e| {
                    let p = self.world.get::<&Projectile>(e).unwrap();
                    // tracer size follows the shot's physical radius so the five
                    // weapons READ differently in flight (fat slug, pinprick uzi);
                    // the pistol lands exactly on the historical 0.14.
                    ProjectileRender { id: p.id, pos: p.pos, radius: p.radius * (PROJ_RENDER_RADIUS / PISTOL.radius), vel: p.vel }
                })
                .collect(),
            chunks: self.res.chunks.clone(),
        }
    }

    /// FNV-1a over the canonical field order: player (pos, facing, flashlight,
    /// pistol cooldown, walk target), muzzle ticks, yaw_q, master switch,
    /// score, doors (id, state), lights (id, on), target hits, RNG probe.
    ///
    /// THE REPLAY ORACLE. This fold — its FIXED field-visit order, every float
    /// op, and which components are folded — is the contract the golden replays
    /// and the determinism tests assert against. Changing the order, switching a
    /// sim float to f64, or reordering an accumulation that feeds it breaks every
    /// golden. The mob and projectile blocks fold ONLY when non-empty, so
    /// mob-free / shot-free levels stay byte-identical to before those features.
    pub(super) fn hash_impl(&self) -> u64 {
        let mut h = Fnv::new();
        let p = self.player_pos();
        h.f32(p.x).f32(p.y).f32(p.z);
        let f = self.player_facing();
        h.f32(f.x).f32(f.y);
        h.u64(self.world.get::<&Flashlight>(self.player).unwrap().on as u64);
        h.u64(self.world.get::<&GunCooldown>(self.player).unwrap().cooldown_ticks as u64);
        match self.world.get::<&WalkTarget>(self.player) {
            Ok(wt) => {
                h.u64(1).f32(wt.ground.x).f32(wt.ground.y).u64(wt.blocked_ticks as u64);
            }
            Err(_) => {
                h.u64(0);
            }
        }
        h.u64(self.res.muzzle_ticks as u64).u64(self.res.yaw_q as u64).u64(self.res.master_lights as u64).u64(self.res.score as u64);
        for &e in &self.doors {
            let d = self.world.get::<&Door>(e).unwrap();
            h.u64(d.id.0 as u64);
            match d.state {
                DoorState::Closed => h.u64(0),
                DoorState::Opening(k) => h.u64(1).u64(k as u64),
                DoorState::Open => h.u64(2),
                DoorState::Closing(k) => h.u64(3).u64(k as u64),
            };
        }
        for &e in &self.lights {
            let l = self.world.get::<&Light>(e).unwrap();
            h.u64(l.id.0 as u64).u64(l.on as u64);
        }
        for &e in &self.targets {
            let t = self.world.get::<&Target>(e).unwrap();
            h.u64(t.id.0 as u64).u64(t.hits as u64);
        }
        // RNG state probe (fields are private; a clone-advance reads it purely)
        h.u64(self.res.rng.clone().next_u32() as u64);
        // Survival fields fold in ONLY when enabled, so a survival-OFF level
        // (game_level / fixture) hashes byte-identically to before this
        // feature: needs, inventory contents, and remaining world items. When
        // survival is None this whole block is skipped → no new bytes.
        if self.res.survival.is_some() {
            h.f32(self.world.get::<&Hunger>(self.player).unwrap().0);
            h.f32(self.world.get::<&Battery>(self.player).unwrap().0);
            let inv = self.world.get::<&Inventory>(self.player).unwrap();
            h.u64(inv.items.len() as u64);
            for k in &inv.items {
                h.u64(item_kind_tag(*k));
            }
            // remaining world items, id-sorted (self.items already is)
            for &e in &self.items {
                let wi = self.world.get::<&WorldItem>(e).unwrap();
                h.u64(wi.id.0 as u64).u64(item_kind_tag(wi.kind));
            }
        }
        // Arsenal folds in ONLY on arena levels (spec.arena), so every other
        // level hashes byte-identically to before the arena feature. The boom
        // flash rides inside the same gate (grenades exist only here).
        if let Some(a) = self.res.arena.arsenal {
            h.u64(a.current.tag());
            h.u64(self.res.arena.next_comm_tick);
            // walk momentum: persistent cross-tick state that steers positions
            h.f32(self.res.arena.walk_vel_px.x).f32(self.res.arena.walk_vel_px.y);
            if let Some(r) = self.res.arena.run {
                h.f32(r.integrity).u64(r.dead as u64).u64(r.won as u64).u64(r.death_tick);
            }
            match self.res.arena.draft {
                Some(d) => {
                    h.u64(1).u64(d.wave as u64);
                    for c in d.offers {
                        h.u64(c.tag());
                    }
                }
                None => {
                    h.u64(0);
                }
            }
            h.u64(self.res.arena.picked.len() as u64);
            for c in &self.res.arena.picked {
                h.u64(c.tag());
            }
            h.u64(self.res.arena.breach as u64);
            match self.res.arena.boom {
                Some((at, t)) => {
                    h.u64(1).f32(at.x).f32(at.y).f32(at.z).u64(t as u64);
                }
                None => {
                    h.u64(0);
                }
            }
            if let Some(w) = self.res.arena.wave {
                h.u64(w.idx as u64).u64(w.lull as u64);
            }
        }
        // Goo mobs fold in ONLY when present, so a mob-free level (fixture /
        // game_level) hashes byte-identically to before this feature. The
        // seeded child-id counter is included so split determinism is pinned.
        // self.mobs is MobId-sorted (rebuilt from a World query after splits).
        if !self.mobs.is_empty() {
            h.u64(self.res.next_mob_id as u64);
            for &e in &self.mobs {
                let g = self.world.get::<&Goo>(e).unwrap();
                h.u64(g.id.0 as u64).u64(g.tier as u64).u64(g.hp as u64).u64(g.state.tag()).u64(g.timer as u64);
                for k in 0..2 {
                    h.f32(g.ends[k].x).f32(g.ends[k].y).f32(g.ends_prev[k].x).f32(g.ends_prev[k].y);
                }
                for k in 0..GOO_PARTICLES {
                    h.f32(g.parts[k].x).f32(g.parts[k].y).f32(g.vel[k].x).f32(g.vel[k].y);
                }
                h.f32(g.heading.x).f32(g.heading.y).u64(g.gait_phase as u64).u64(g.merge_grace as u64).u64(g.fusing as u64).f32(g.fuse_pt.x).f32(g.fuse_pt.y);
                h.u64(g.spawn_timer as u64).f32(g.spawn_dir.x).f32(g.spawn_dir.y).u64(g.birth_glow as u64).u64(g.birth_immune as u64);
                h.u64(g.tether as u64).f32(g.tether_anchor.x).f32(g.tether_anchor.y).u64(g.tear_ticks as u64);
                h.f32(g.wobble_amp).f32(g.wobble_dir.x).f32(g.wobble_dir.y).u64(g.wobble_phase as u64);
                // arena-species block (2026-07-03): kind + cure + harpoon pin.
                // Appending these moved ALL FOUR goo oracles (hash bytes only —
                // Green multipliers are exact 1.0 identities, so oracle-level
                // BEHAVIOR is unchanged; see the dated recapture note there).
                h.u64(g.kind.tag()).u64(g.cure as u64).u64(g.pinned as u64).f32(g.pin_pt.x).f32(g.pin_pt.y);
                // tactics fold ONLY under the arena gate (they never mutate
                // elsewhere), so the four pre-arena goo oracles stand as-is.
                if self.res.arena.arsenal.is_some() {
                    h.u64(g.tac.tag()).u64(g.tac_timer as u64).f32(g.tac_point.x).f32(g.tac_point.y).u64(g.strike);
                }
            }
        }
        // Projectiles block — ProjectileId-sorted, folded ONLY while shots are in
        // flight (empty → skipped, like mobs, so idle/non-shooting frames hash
        // exactly as before this feature). The counter is folded inside the block.
        if !self.projectiles.is_empty() {
            h.u64(self.res.next_projectile_id as u64);
            for &e in &self.projectiles {
                let p = self.world.get::<&Projectile>(e).unwrap();
                h.u64(p.id.0 as u64).u64(p.age as u64);
                h.f32(p.pos.x).f32(p.pos.y).f32(p.pos.z);
                h.f32(p.vel.x).f32(p.vel.y).f32(p.vel.z);
            }
        }
        // Dead solid chunks fold in ONLY when one exists (they require a cured
        // arena kill), so every chunk-free level hashes exactly as before.
        if !self.res.chunks.is_empty() {
            h.u64(self.res.chunks.len() as u64);
            for c in &self.res.chunks {
                h.f32(c[0]).f32(c[1]).f32(c[2]).f32(c[3]);
            }
        }
        h.0
    }
}

/// Stable hash tag for an item kind (the enum discriminant is not guaranteed
/// stable across reorders, so we pin it here for the state_hash fold).
fn item_kind_tag(k: ItemKind) -> u64 {
    match k {
        ItemKind::Food => 0,
        ItemKind::Battery => 1,
    }
}

/// FNV-1a, canonical little-endian byte order.
struct Fnv(u64);

impl Fnv {
    fn new() -> Fnv {
        Fnv(0xcbf29ce484222325)
    }

    fn u64(&mut self, v: u64) -> &mut Fnv {
        for b in v.to_le_bytes() {
            self.0 = (self.0 ^ b as u64).wrapping_mul(0x100000001b3);
        }
        self
    }

    fn f32(&mut self, v: f32) -> &mut Fnv {
        self.u64(v.to_bits() as u64)
    }
}
