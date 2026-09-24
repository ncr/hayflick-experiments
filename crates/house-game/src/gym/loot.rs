//! What the street holds (2026-09-24, the first gameplay loop): the items a
//! survivor carries, and what each searchable prop gives up when searched.
//!
//! A prop's contents are a pure function of its kind and SEED — the same seed
//! that already grows its geometry (`props` crate) — so a level file fixes
//! the loot as well as the look, and a replay finds the same things. Nothing
//! here reads a clock or an unseeded RNG.

use super::sim::PropKind;

/// Something a survivor can carry. Counts stack per kind.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Item {
    Food,
    Water,
    Bandage,
    Scrap,
    Battery,
    Rounds,
    Fuel,
    Rags,
}

impl Item {
    pub const ALL: [Item; 8] = [Item::Food, Item::Water, Item::Bandage, Item::Scrap, Item::Battery, Item::Rounds, Item::Fuel, Item::Rags];

    /// Singular name, as the HUD prints it ("2 x canned food").
    pub fn name(self) -> &'static str {
        match self {
            Item::Food => "canned food",
            Item::Water => "water",
            Item::Bandage => "bandage",
            Item::Scrap => "scrap metal",
            Item::Battery => "battery",
            Item::Rounds => "rounds",
            Item::Fuel => "fuel",
            Item::Rags => "rags",
        }
    }
}

/// How long searching a prop takes, in sim ticks — `None` for a prop there is
/// nothing to search in (a pole, a sign, a bench). A car's boot and glovebox
/// take longer than a mailbox.
pub fn search_ticks(kind: PropKind) -> Option<u32> {
    match kind {
        PropKind::Car => Some(66),
        PropKind::Crate => Some(42),
        PropKind::Barrel => Some(30),
        PropKind::Mailbox => Some(18),
        _ => None,
    }
}

/// Deterministic draw `k` of a prop's seed, in [0, 1).
fn draw(seed: u32, k: u32) -> f32 {
    let mut x = (seed as u64) << 32 | k as u64;
    x = x.wrapping_add(0x9e37_79b9_7f4a_7c15);
    x = (x ^ (x >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    x ^= x >> 31;
    (x >> 40) as f32 / (1u64 << 24) as f32
}

/// What searching a prop of `kind` grown from `seed` turns up — possibly
/// nothing. Each table row is (item, chance, fewest, most).
pub fn contents(kind: PropKind, seed: u32) -> Vec<(Item, u16)> {
    let table: &[(Item, f32, u16, u16)] = match kind {
        PropKind::Car => &[(Item::Scrap, 0.8, 1, 3), (Item::Fuel, 0.35, 1, 1), (Item::Battery, 0.3, 1, 1), (Item::Rounds, 0.25, 3, 8), (Item::Rags, 0.4, 1, 2)],
        PropKind::Barrel => &[(Item::Fuel, 0.4, 1, 2), (Item::Water, 0.35, 1, 2)],
        PropKind::Crate => &[(Item::Food, 0.55, 1, 3), (Item::Bandage, 0.35, 1, 2), (Item::Rounds, 0.3, 2, 6), (Item::Scrap, 0.4, 1, 2), (Item::Water, 0.3, 1, 1)],
        PropKind::Mailbox => &[(Item::Rags, 0.3, 1, 1), (Item::Battery, 0.12, 1, 1)],
        _ => &[],
    };
    let mut out = Vec::new();
    for (k, &(item, chance, lo, hi)) in table.iter().enumerate() {
        if draw(seed, 2 * k as u32) < chance {
            let n = lo + (draw(seed, 2 * k as u32 + 1) * (hi - lo + 1) as f32) as u16;
            out.push((item, n.min(hi)));
        }
    }
    out
}

/// One line of the finds, as the HUD log prints it: "car: 2 scrap metal,
/// 1 battery" or "barrel: nothing".
pub fn describe(kind: PropKind, found: &[(Item, u16)]) -> String {
    if found.is_empty() {
        return format!("{}: nothing", kind.name());
    }
    let parts: Vec<String> = found.iter().map(|(i, n)| format!("{n} {}", i.name())).collect();
    format!("{}: {}", kind.name(), parts.join(", "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_seed_fixes_the_contents() {
        for kind in PropKind::ALL {
            for seed in 0..50 {
                assert_eq!(contents(kind, seed), contents(kind, seed));
            }
        }
    }

    #[test]
    fn only_containers_hold_anything() {
        for kind in PropKind::ALL {
            let any = (0..200).any(|s| !contents(kind, s).is_empty());
            assert_eq!(any, search_ticks(kind).is_some(), "{kind:?}");
        }
    }

    #[test]
    fn counts_stay_inside_their_rows_and_some_searches_come_up_empty() {
        let mut empty = 0;
        for seed in 0..400 {
            let c = contents(PropKind::Crate, seed);
            empty += c.is_empty() as u32;
            for (item, n) in c {
                assert!((1..=6).contains(&n), "{item:?} x {n}");
            }
        }
        assert!(empty > 0 && empty < 100, "a crate is sometimes empty, not usually: {empty} of 400");
    }

    #[test]
    fn different_seeds_find_different_things() {
        let distinct: std::collections::BTreeSet<Vec<(Item, u16)>> = (0..40).map(|s| contents(PropKind::Car, s)).collect();
        assert!(distinct.len() > 10, "{}", distinct.len());
    }
}
