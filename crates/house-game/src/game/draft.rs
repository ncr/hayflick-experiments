//! The wave-lull mutation draft (M2 of the Warden Pit plan): clearing the
//! floor opens a hand of THREE cards for the quiet seconds before the next
//! squad lands; picking one (keys Z/X/C → `Command::PickCard`, trace op
//! `card <1-3>`) permanently mutates the run. Cards are pure DATA deltas —
//! `WeaponSpec` transforms and droid multipliers applied at read time — so
//! there is no upgrade subsystem, just a hashed `Vec<Card>` and three pure
//! functions.
//!
//! Determinism: the hand is `hash(level seed, wave index)` through the
//! shared Knuth stride — no shared-RNG draws, so the goo's own randomness
//! stream never shifts and replays stay bit-exact through drafts. Child
//! module of `game` (the goo.rs/weapon.rs pattern); everything is
//! arena-gated and hashed under the arsenal gate.

use super::goo::GOO_ID_MIX;
use super::*;
use sim_core::AudioSink;

/// One permanent run mutation. Names fit the HUD plates (≤11 chars);
/// effects are deliberately chunky — a card should be FELT next wave.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Card {
    HeavySlug,     // slug: +2 damage, +60% knockback
    LongRivet,     // slug: +50% muzzle speed
    DrumUzi,       // uzi: cooldown 5 -> 3 (20 rounds/s)
    SteadyAim,     // uzi: bloom quartered
    WideChoke,     // shotgun: +2 pellets
    TightChoke,    // shotgun: 40% tighter fan, +50% reach
    BigBoom,       // grenade: +0.5 wu blast, +2 damage
    Bouncy,        // grenade: restitution 0.5 -> 0.75
    BarbedHarpoon, // harpoon: +3 damage, x3 knockback
    ServoLegs,     // droid: +15% walk speed
    Plating,       // droid: goo contact drains 25% slower
    NanoRepair,    // droid: hull regrows while untouched
}

/// The draftable pool, in stable order (indexed by the offer hash).
pub const CARD_POOL: [Card; 12] = [
    Card::HeavySlug,
    Card::LongRivet,
    Card::DrumUzi,
    Card::SteadyAim,
    Card::WideChoke,
    Card::TightChoke,
    Card::BigBoom,
    Card::Bouncy,
    Card::BarbedHarpoon,
    Card::ServoLegs,
    Card::Plating,
    Card::NanoRepair,
];

impl Card {
    /// Stable hash tag (enum discriminants are not order-stable; pin them).
    pub(crate) fn tag(self) -> u64 {
        CARD_POOL.iter().position(|c| *c == self).unwrap() as u64
    }

    /// HUD plate title (≤11 chars at 8 px/char on a 96-px plate).
    pub fn name(self) -> &'static str {
        match self {
            Card::HeavySlug => "HEAVY SLUG",
            Card::LongRivet => "LONG RIVET",
            Card::DrumUzi => "DRUM UZI",
            Card::SteadyAim => "STEADY AIM",
            Card::WideChoke => "WIDE CHOKE",
            Card::TightChoke => "TIGHT CHOKE",
            Card::BigBoom => "BIG BOOM",
            Card::Bouncy => "BOUNCY",
            Card::BarbedHarpoon => "BARBED HARP",
            Card::ServoLegs => "SERVO LEGS",
            Card::Plating => "PLATING",
            Card::NanoRepair => "NANO REPAIR",
        }
    }

    /// HUD plate effect line (telegraphic, ≤11 chars).
    pub fn desc(self) -> &'static str {
        match self {
            Card::HeavySlug => "+DMG +PUNCH",
            Card::LongRivet => "+SPEED",
            Card::DrumUzi => "20 RPS",
            Card::SteadyAim => "-BLOOM",
            Card::WideChoke => "+2 PELLETS",
            Card::TightChoke => "+REACH",
            Card::BigBoom => "+BLAST",
            Card::Bouncy => "+BOUNCE",
            Card::BarbedHarpoon => "+DMG +YANK",
            Card::ServoLegs => "+15% SPEED",
            Card::Plating => "-25% DRAIN",
            Card::NanoRepair => "HULL REGROW",
        }
    }
}

/// The open hand between waves. `Some` only while the lull draft is live;
/// hashed under the arsenal gate (offers are re-derivable but the OPEN
/// latch is state).
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct DraftState {
    pub offers: [Card; 3],
    /// The wave index this hand was dealt for (its hash salt).
    pub wave: u16,
}

/// Deal the hand for `wave`: three DISTINCT pool indices from the shared
/// Knuth stride over (seed, wave, slot), linear-probed apart. Pure.
pub fn deal(seed: u64, wave: u16) -> [Card; 3] {
    let mut out = [CARD_POOL[0]; 3];
    let mut taken = [usize::MAX; 3];
    for k in 0..3u32 {
        let h = (seed as u32)
            .wrapping_mul(ID_HASH_STRIDE)
            .wrapping_add((wave as u32).wrapping_mul(GOO_ID_MIX))
            .wrapping_add(k.wrapping_mul(0x9e37_79b9));
        let mut idx = (h >> 8) as usize % CARD_POOL.len();
        while taken.contains(&idx) {
            idx = (idx + 1) % CARD_POOL.len();
        }
        taken[k as usize] = idx;
        out[k as usize] = CARD_POOL[idx];
    }
    out
}

/// Apply the run's picked cards to a base weapon spec at read time. Pure;
/// stacking the same card twice stacks its delta (drafts across waves may
/// re-offer a card — that's a build, not a bug).
pub fn apply_cards(mut w: WeaponSpec, picked: &[Card]) -> WeaponSpec {
    for c in picked {
        match (c, w.class) {
            (Card::HeavySlug, WeaponClass::Slug) => {
                w.damage += 2;
                w.knockback *= 1.6;
            }
            (Card::LongRivet, WeaponClass::Slug) => w.muzzle_speed *= 1.5,
            (Card::DrumUzi, WeaponClass::Uzi) => w.cooldown_ticks = w.cooldown_ticks.saturating_sub(2).max(1),
            (Card::SteadyAim, WeaponClass::Uzi) => w.bloom *= 0.25,
            (Card::WideChoke, WeaponClass::Shotgun) => w.pellets += 2,
            (Card::TightChoke, WeaponClass::Shotgun) => {
                w.spread *= 0.6;
                w.max_age = (w.max_age as f32 * 1.5) as u16;
            }
            (Card::BigBoom, WeaponClass::Grenade) => {
                w.aoe_radius += 0.5;
                w.damage += 2;
            }
            (Card::Bouncy, WeaponClass::Grenade) => w.restitution = 0.75,
            (Card::BarbedHarpoon, WeaponClass::Harpoon) => {
                w.damage += 3;
                w.knockback *= 3.0;
            }
            _ => {}
        }
    }
    w
}

/// Droid walk-speed multiplier from the picked cards (stacks).
pub fn speed_mult(picked: &[Card]) -> f32 {
    let mut m = 1.0;
    for c in picked {
        if *c == Card::ServoLegs {
            m *= 1.15;
        }
    }
    m
}

/// Integrity drain multiplier from the picked cards (stacks).
pub fn drain_mult(picked: &[Card]) -> f32 {
    let mut m = 1.0;
    for c in picked {
        if *c == Card::Plating {
            m *= 0.75;
        }
    }
    m
}

/// Hull regrowth per second while UNTOUCHED (0 without the card; stacks).
pub fn regen_rate(picked: &[Card]) -> f32 {
    picked.iter().filter(|c| **c == Card::NanoRepair).count() as f32 * 0.015
}

impl<S: AudioSink> HouseGame<S> {
    /// Open the lull hand (called by wave_system the tick a clear starts).
    pub(crate) fn open_draft(&mut self) {
        let Some(w) = self.res.wave else { return };
        if self.res.run.is_some_and(|r| r.dead) {
            return; // no drafting from the grave
        }
        self.res.draft = Some(DraftState { offers: deal(self.res.seed, w.idx), wave: w.idx });
    }

    /// `Command::PickCard` — take card `slot` (1-3) from the open hand.
    /// Swallowed when no hand is open (spam-safe, replay-stable).
    pub(crate) fn pick_card(&mut self, slot: u8) {
        let Some(d) = self.res.draft else { return };
        if !(1..=3).contains(&slot) {
            return;
        }
        let card = d.offers[(slot - 1) as usize];
        self.res.picked.push(card);
        self.res.draft = None;
        self.res.events.emit(GameEvent::CardPicked(card));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deal_is_deterministic_and_distinct() {
        let a = deal(42, 3);
        let b = deal(42, 3);
        assert_eq!(a, b, "same seed+wave, same hand");
        assert!(a[0] != a[1] && a[1] != a[2] && a[0] != a[2], "three distinct cards: {a:?}");
        assert_ne!(deal(42, 4), a, "a different wave deals a different hand (this seed)");
    }

    #[test]
    fn cards_mutate_only_their_weapon() {
        let uzi = apply_cards(UZI, &[Card::DrumUzi, Card::HeavySlug]);
        assert_eq!(uzi.cooldown_ticks, 3, "drum uzi fires at 20 rps");
        assert_eq!(uzi.damage, UZI.damage, "the slug card leaves the uzi alone");
        let slug = apply_cards(SLUG, &[Card::DrumUzi, Card::HeavySlug]);
        assert_eq!(slug.damage, SLUG.damage + 2);
        let stacked = apply_cards(SLUG, &[Card::HeavySlug, Card::HeavySlug]);
        assert_eq!(stacked.damage, SLUG.damage + 4, "cards stack");
    }
}
