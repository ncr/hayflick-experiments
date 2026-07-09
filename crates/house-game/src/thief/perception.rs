//! The observation atom & fuzzy appearance matching
//! (docs/spec/05a-perception.md, locked round 5).
//!
//! Everything the town will ever "know" begins as an [`Observation`] — a
//! structured record of what one observer perceived at one tick. The subject
//! is never an identity, only a partial [`Description`] of features
//! ("appearance IS identity", module 06): recognition anywhere in the game is
//! a fuzzy match between descriptions, never a flag.
//!
//! All scoring is integer (portable determinism). Sensing itself — cones,
//! LOS, the light field — lives with the NPC systems (M1); this module owns
//! the *currency* those senses emit.

use super::grid::CellPos;
use sim_core::Tick;

pub type NpcId = u16;

// ---------------------------------------------------------------------------
// Appearance — hard traits + worn layers + permanent marks (module 06)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Build {
    Slight,
    Average,
    Heavy,
}

/// Garment hue buckets — coarse on purpose: witnesses remember "a green
/// hood", not a pantone value.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Hue {
    Drab,
    Brown,
    Green,
    Blue,
    Red,
    Black,
    White,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Headwear {
    Bare,
    Hood,
    Hat,
    Helmet,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Gait {
    Normal,
    Limp,
    Swagger,
}

/// Permanent distinctive marks — what the punishment ladder writes (05c) and
/// clothes can never shed.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Mark {
    None,
    Brand,
    CroppedEar,
    Scar,
}

/// A feature as an observer recorded it: `Unknown` when they didn't get a
/// clear read (distance, darkness, concealment). Unknown fields make vague
/// descriptions that match many townsfolk — exactly the vagueness the player
/// works to cause.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Feature<T> {
    Unknown,
    Seen(T),
}

impl<T: Copy + Eq> Feature<T> {
    pub fn known(self) -> Option<T> {
        match self {
            Feature::Unknown => None,
            Feature::Seen(v) => Some(v),
        }
    }
}

/// A partial, per-observation appearance snapshot — 05a's
/// `AppearanceDescription`. Also the shape of a Case's merged suspect
/// profile (05b) and of a wanted notice (11).
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct Description {
    pub build: Feature<Build>,
    pub top: Feature<Hue>,      // coat/torso color
    pub bottom: Feature<Hue>,   // legs color
    pub headwear: Feature<Headwear>,
    pub masked: Feature<bool>,
    pub gait: Feature<Gait>,
    pub mark: Feature<Mark>,
}

impl Description {
    pub const UNKNOWN: Description = Description {
        build: Feature::Unknown,
        top: Feature::Unknown,
        bottom: Feature::Unknown,
        headwear: Feature::Unknown,
        masked: Feature::Unknown,
        gait: Feature::Unknown,
        mark: Feature::Unknown,
    };

    /// How many fields carry information.
    pub fn known_fields(&self) -> u32 {
        let mut n = 0;
        n += self.build.known().is_some() as u32;
        n += self.top.known().is_some() as u32;
        n += self.bottom.known().is_some() as u32;
        n += self.headwear.known().is_some() as u32;
        n += self.masked.known().is_some() as u32;
        n += self.gait.known().is_some() as u32;
        n += (self.mark.known().is_some() && self.mark != Feature::Seen(Mark::None)) as u32;
        n
    }

    /// Canonical byte stream for hashing (explicit codes, never `as u8`).
    pub fn eat_into(&self, eat: &mut impl FnMut(u8)) {
        fn tag<T: Copy + Eq>(f: Feature<T>, code: impl Fn(T) -> u8) -> u8 {
            match f {
                Feature::Unknown => 0xff,
                Feature::Seen(v) => code(v),
            }
        }
        eat(tag(self.build, |v| match v {
            Build::Slight => 0,
            Build::Average => 1,
            Build::Heavy => 2,
        }));
        eat(tag(self.top, hue_code));
        eat(tag(self.bottom, hue_code));
        eat(tag(self.headwear, |v| match v {
            Headwear::Bare => 0,
            Headwear::Hood => 1,
            Headwear::Hat => 2,
            Headwear::Helmet => 3,
        }));
        eat(tag(self.masked, |v| v as u8));
        eat(tag(self.gait, |v| match v {
            Gait::Normal => 0,
            Gait::Limp => 1,
            Gait::Swagger => 2,
        }));
        eat(tag(self.mark, |v| match v {
            Mark::None => 0,
            Mark::Brand => 1,
            Mark::CroppedEar => 2,
            Mark::Scar => 3,
        }));
    }
}

fn hue_code(v: Hue) -> u8 {
    match v {
        Hue::Drab => 0,
        Hue::Brown => 1,
        Hue::Green => 2,
        Hue::Blue => 3,
        Hue::Red => 4,
        Hue::Black => 5,
        Hue::White => 6,
    }
}

// ---------------------------------------------------------------------------
// Fuzzy matching — THE foundation mechanic (05a, locked)
// ---------------------------------------------------------------------------

/// Field weights for the fuzzy match. A mark is near-decisive (05c's
/// systemic hook: branding writes an unshakeable feature); clothing fields
/// are strong but shedable — that asymmetry IS the disguise loop.
const W_BUILD: i32 = 15;
const W_TOP: i32 = 20;
const W_BOTTOM: i32 = 10;
const W_HEADWEAR: i32 = 20;
const W_MASKED: i32 = 10;
const W_GAIT: i32 = 15;
const W_MARK: i32 = 40;

/// Best possible match score (every field known and agreeing).
pub const MATCH_MAX: i32 = W_BUILD + W_TOP + W_BOTTOM + W_HEADWEAR + W_MASKED + W_GAIT + W_MARK;

/// Fuzzy feature-vector match: many shared features + few conflicts ⇒ high;
/// a changed coat or added mask breaks fields into conflicts ⇒ low. Both-
/// unknown fields contribute nothing (vague descriptions match weakly, not
/// strongly). **Base-rate rule:** agreement on an unremarkable default —
/// no mask, no mark, a normal gait — is NOT evidence (most of the town
/// matches it); only the notable value earns the weight. Conflicts always
/// count in full. Symmetric; pure; integer.
pub fn match_score(a: &Description, b: &Description) -> i32 {
    fn field<T: Copy + Eq>(a: Feature<T>, b: Feature<T>, w: i32, dull: Option<T>) -> i32 {
        match (a.known(), b.known()) {
            (Some(x), Some(y)) if x == y => {
                if dull == Some(x) {
                    0
                } else {
                    w
                }
            }
            (Some(_), Some(_)) => -w,
            _ => 0,
        }
    }
    field(a.build, b.build, W_BUILD, None)
        + field(a.top, b.top, W_TOP, None)
        + field(a.bottom, b.bottom, W_BOTTOM, None)
        + field(a.headwear, b.headwear, W_HEADWEAR, None)
        + field(a.masked, b.masked, W_MASKED, Some(false))
        + field(a.gait, b.gait, W_GAIT, Some(Gait::Normal))
        + field(a.mark, b.mark, W_MARK, Some(Mark::None))
}

// ---------------------------------------------------------------------------
// The observation atom (05a, locked — rich & structured)
// ---------------------------------------------------------------------------

/// What the subject was DOING — the alarmingness driver.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum ActionKind {
    /// "A noise" / an unattributed stimulus.
    Noise,
    Loitering,
    Casing,
    Climbing,
    Fleeing,
    Carrying,
    Forcing,
    Stealing,
    Fighting,
    BearingBody,
    /// Forensic: a trace discovered after the fact (a forced lock, a broken
    /// window, prints). Backward-looking evidence ONLY — never a live trail
    /// (05a review-pass clarification).
    TraceFound,
}

impl ActionKind {
    pub fn code(self) -> u8 {
        match self {
            ActionKind::Noise => 0,
            ActionKind::Loitering => 1,
            ActionKind::Casing => 2,
            ActionKind::Climbing => 3,
            ActionKind::Fleeing => 4,
            ActionKind::Carrying => 5,
            ActionKind::Forcing => 6,
            ActionKind::Stealing => 7,
            ActionKind::Fighting => 8,
            ActionKind::BearingBody => 9,
            ActionKind::TraceFound => 10,
        }
    }

    /// Default alarmingness (0..=100) of witnessing this action; observations
    /// may override situationally.
    pub fn base_salience(self) -> u8 {
        match self {
            ActionKind::Noise => 10,
            ActionKind::Loitering => 15,
            ActionKind::Casing => 35,
            ActionKind::Climbing => 60,
            ActionKind::Fleeing => 65,
            ActionKind::Carrying => 40,
            ActionKind::Forcing => 75,
            ActionKind::Stealing => 85,
            ActionKind::Fighting => 90,
            ActionKind::BearingBody => 100,
            ActionKind::TraceFound => 70,
        }
    }
}

/// How the knowledge arrived (05b: secondhand knowledge carries its source
/// and reduced confidence).
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Source {
    Direct,
    Secondhand { from: NpcId },
}

/// One perception record — the ONLY currency the deduction engine reasons
/// over. Both live senses and forensic discovery emit these.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Observation {
    pub observer: NpcId,
    /// `Description::UNKNOWN` when the observer got no read on a subject
    /// (heard a noise, found a trace).
    pub subject: Description,
    pub action: ActionKind,
    pub at: CellPos,
    pub when: Tick,
    /// Read clarity 0..=100 — from distance, light, cover, which sense.
    pub confidence: u8,
    /// Alarmingness 0..=100 — a fleeing masked figure ≫ a passerby.
    pub salience: u8,
    pub source: Source,
}

impl Observation {
    pub fn eat_into(&self, eat: &mut impl FnMut(u8)) {
        let mut eat16 = |v: u16| {
            eat(v as u8);
            eat((v >> 8) as u8);
        };
        eat16(self.observer);
        eat16(self.at.x as u16);
        eat16(self.at.z as u16);
        self.subject.eat_into(eat);
        eat(self.at.floor as u8);
        eat(self.action.code());
        for byte in self.when.0.to_le_bytes() {
            eat(byte);
        }
        eat(self.confidence);
        eat(self.salience);
        match self.source {
            Source::Direct => eat(0),
            Source::Secondhand { from } => {
                eat(1);
                eat(from as u8);
                eat((from >> 8) as u8);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hooded_green() -> Description {
        Description {
            build: Feature::Seen(Build::Average),
            top: Feature::Seen(Hue::Green),
            bottom: Feature::Unknown,
            headwear: Feature::Seen(Headwear::Hood),
            masked: Feature::Seen(false),
            gait: Feature::Unknown,
            mark: Feature::Unknown,
        }
    }

    #[test]
    fn match_score_rewards_shared_and_punishes_conflicts() {
        let a = hooded_green();
        // Identical: known fields agree — but "unmasked" is a base-rate
        // default and earns nothing.
        assert_eq!(match_score(&a, &a), W_BUILD + W_TOP + W_HEADWEAR);
        // Changed coat + shed hood: two conflicts flip the sign hard —
        // the disguise payoff (05b layer 1).
        let changed = Description {
            top: Feature::Seen(Hue::Brown),
            headwear: Feature::Seen(Headwear::Bare),
            ..a
        };
        assert_eq!(match_score(&a, &changed), W_BUILD - W_TOP - W_HEADWEAR);
        assert!(match_score(&a, &changed) < match_score(&a, &a) / 2);
        // A vague description (everything unknown) matches nothing at all.
        assert_eq!(match_score(&a, &Description::UNKNOWN), 0);
        // Symmetry.
        assert_eq!(match_score(&a, &changed), match_score(&changed, &a));
        // A NOTABLE shared value does score: two masked reads reinforce.
        let m1 = Description { masked: Feature::Seen(true), ..a };
        assert_eq!(match_score(&m1, &m1), W_BUILD + W_TOP + W_HEADWEAR + W_MASKED);
        // Conflicts on defaultable fields still count in full.
        let unmasked = Description { masked: Feature::Seen(false), ..a };
        assert_eq!(match_score(&m1, &unmasked), W_BUILD + W_TOP + W_HEADWEAR - W_MASKED);
    }

    #[test]
    fn marks_dominate_the_match() {
        // The 05c hook: a brand outweighs a full change of clothes.
        let branded_green = Description { mark: Feature::Seen(Mark::Brand), ..hooded_green() };
        let branded_other = Description {
            build: Feature::Seen(Build::Average),
            top: Feature::Seen(Hue::Black),
            bottom: Feature::Unknown,
            headwear: Feature::Seen(Headwear::Hat),
            masked: Feature::Seen(false),
            gait: Feature::Unknown,
            mark: Feature::Seen(Mark::Brand),
        };
        let s = match_score(&branded_green, &branded_other);
        assert!(s > 0, "the brand must keep the match positive through a full re-dress: {s}");
    }

    #[test]
    fn known_fields_counts_information() {
        assert_eq!(Description::UNKNOWN.known_fields(), 0);
        assert_eq!(hooded_green().known_fields(), 4);
        // Mark::None is "no mark seen", not information.
        let m = Description { mark: Feature::Seen(Mark::None), ..Description::UNKNOWN };
        assert_eq!(m.known_fields(), 0);
    }
}
