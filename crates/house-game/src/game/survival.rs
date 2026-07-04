//! Survival sim (split out of `game.rs` — the goo.rs/weapon.rs "pure
//! relocation" pattern): the opt-in hunger/battery needs, inventory pickups,
//! and item consumption. Everything here is gated on `spec.survival.is_some()`
//! (survival-off levels spawn none of these components and hash exactly as
//! before). Child module of `game`, so the methods reach `Res`'s private
//! fields directly. Pure relocation — behavior unchanged.
use super::*;
use sim_core::AudioSink;

// ---- survival components (spawned ONLY when spec.survival.is_some()) --------

/// The two needs are plain f32 in 0..=1 (full at 1.0), one component each so
/// the queries read cleanly. Present on the player iff survival is enabled.
pub struct Hunger(pub f32);
pub struct Battery(pub f32);
/// Carried items, push-ordered (FIFO is irrelevant — Use consumes by kind).
pub struct Inventory {
    pub items: Vec<ItemKind>,
    pub cap: u32,
}
/// A pickup entity: its StableId, its consume effect, and a `Pos` (separate
/// component, reusing the player's `Pos`) for the proximity test.
pub struct WorldItem {
    pub id: ItemId,
    pub kind: ItemKind,
}

/// Which need an edge-triggered survival event refers to.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum NeedKind {
    Hunger,
    Battery,
}

impl<S: AudioSink> HouseGame<S> {
    /// True when survival is on AND the battery is empty. Used to gate the
    /// flashlight toggle (and to force it off in needs_system). Survival-off
    /// games have no Battery component, so this is always false there.
    pub(crate) fn battery_dead(&self) -> bool {
        self.res.survival.is_some() && self.world.get::<&Battery>(self.player).map(|b| b.0 <= 0.0).unwrap_or(false)
    }

    /// 3b. Pickups: after the player has moved, any WorldItem within
    /// `pickup_radius` (world-XZ) is collected if the inventory has room —
    /// kind pushed to the inventory, item despawned via the command buffer,
    /// `PickedUp` emitted. Items iterate in ItemId-sorted order (self.items is
    /// id-sorted; despawns drop entries) so two items inside the radius on the
    /// same tick are picked in a deterministic, hash-stable order. No-op when
    /// survival is off (self.items is empty).
    pub(crate) fn pickup_system(&mut self) {
        let Some(sp) = self.res.survival else { return };
        if self.items.is_empty() {
            return;
        }
        let p = self.player_pos();
        let r2 = sp.pickup_radius * sp.pickup_radius;
        let mut picked: Vec<Entity> = Vec::new();
        for &e in &self.items {
            // room left this tick = cap − (carried so far including this tick's picks)
            let (count, cap) = {
                let inv = self.world.get::<&Inventory>(self.player).unwrap();
                (inv.items.len() as u32, inv.cap)
            };
            if count >= cap {
                break; // full; remaining items stay on the floor
            }
            let (id, kind, ipos) = {
                let wi = self.world.get::<&WorldItem>(e).unwrap();
                (wi.id, wi.kind, self.world.get::<&Pos>(e).unwrap().0)
            };
            let dx = ipos.x - p.x;
            let dz = ipos.z - p.z;
            if dx * dx + dz * dz <= r2 {
                self.world.get::<&mut Inventory>(self.player).unwrap().items.push(kind);
                self.res.buf.despawn(e); // the one structural-change point per tick
                self.res.events.emit(GameEvent::PickedUp(id, kind, ipos));
                picked.push(e);
            }
        }
        // drop the picked entities from the iteration list (the despawn lands
        // at the per-tick buffer flush; keep self.items consistent with it)
        if !picked.is_empty() {
            self.items.retain(|e| !picked.contains(e));
        }
    }

    /// Consume-item handling: each `Command::Use { kind }` this tick removes one
    /// carried item of that kind and restores the matching need (clamped 1.0),
    /// emitting `Consumed`. A Use with no matching item carried is a silent
    /// no-op (no event, no restore). No-op entirely when survival is off.
    pub(crate) fn use_system(&mut self) {
        let Some(sp) = self.res.survival else {
            return;
        };
        let intents = std::mem::take(&mut self.res.staging.use_items);
        for kind in intents {
            // remove one carried item of this kind (FIFO; order is irrelevant)
            let removed = {
                let mut inv = self.world.get::<&mut Inventory>(self.player).unwrap();
                if let Some(i) = inv.items.iter().position(|k| *k == kind) {
                    inv.items.remove(i);
                    true
                } else {
                    false
                }
            };
            if !removed {
                continue; // nothing carried → no-op
            }
            match kind {
                ItemKind::Food => {
                    let mut h = self.world.get::<&mut Hunger>(self.player).unwrap();
                    h.0 = (h.0 + sp.food_restore).min(1.0);
                }
                ItemKind::Battery => {
                    let mut b = self.world.get::<&mut Battery>(self.player).unwrap();
                    b.0 = (b.0 + sp.battery_restore).min(1.0);
                }
            }
            self.res.events.emit(GameEvent::Consumed(kind));
        }
    }

    /// Needs tick (run near the end of the tick, after movement/use): hunger
    /// always decays; battery drains ONLY while the flashlight is on. Pressure
    /// effects: a dead battery (0) forces the flashlight OFF (and the toggle is
    /// already gated off in resolve_commands). NeedCritical fires the FIRST tick
    /// a need crosses BELOW `critical`; NeedRecovered when it climbs back to/
    /// above. Edge state lives in `need_was_critical`. Hunger-zero slowdown is
    /// applied in walk_system (it reads hunger there). No-op when survival off.
    pub(crate) fn needs_system(&mut self) {
        let Some(sp) = self.res.survival else { return };
        let flashlight_on = self.world.get::<&Flashlight>(self.player).unwrap().on;
        let (hunger, battery) = {
            let mut h = self.world.get::<&mut Hunger>(self.player).unwrap();
            h.0 = (h.0 - sp.hunger_decay).max(0.0);
            let mut b = self.world.get::<&mut Battery>(self.player).unwrap();
            if flashlight_on {
                b.0 = (b.0 - sp.battery_drain).max(0.0);
            }
            (h.0, b.0)
        };
        // dead battery → torch off (a no-op if already off; no Switch cue: the
        // torch dying is not a player-driven switch)
        if battery <= 0.0 {
            self.world.get::<&mut Flashlight>(self.player).unwrap().on = false;
        }
        // edge-triggered critical/recovered, hunger then battery (stable order)
        for (i, (level, need)) in [(hunger, NeedKind::Hunger), (battery, NeedKind::Battery)].into_iter().enumerate() {
            let now = level < sp.critical;
            if now && !self.res.need_was_critical[i] {
                self.res.events.emit(GameEvent::NeedCritical(need));
            } else if !now && self.res.need_was_critical[i] {
                self.res.events.emit(GameEvent::NeedRecovered(need));
            }
            self.res.need_was_critical[i] = now;
        }
    }
}
